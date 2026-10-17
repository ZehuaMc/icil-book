import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/lib/db';
import { reserveSeat, addCoverage, removeCoverage, cancelReservation } from '../src/lib/bookings';
assert.ok(process.env.DATABASE_URL, 'DATABASE_URL 未设置：请配置专用测试数据库，不能跳过集成验证');
// Run against a migrated PostgreSQL database. All fixtures use an isolated ID prefix and are removed.
test('PostgreSQL: coverage gates, authorization, cancellation, and concurrent uniqueness', async (t) => {
    const prefix = `test-${randomUUID()}`;
    await db.$connect();
    let sessionId = '', groupId = '', layoutId = '', courseId = '', venueId = '';
    const ids = [0, 1, 2, 3, 4, 5].map(i => `${prefix}-user-${i}`);
    try {
        const group = await db.group.create({ data: { name: prefix, canReserve: true, weeklyRules: { create: Array.from({ length: 7 }, (_, weekday) => ({ weekday, startMinute: 0, endMinute: 1440 })) } } });
        groupId = group.id;
        for (let i = 0; i < ids.length; i++)
            await db.user.create({ data: { id: ids[i], name: `Test ${i}`, email: `${ids[i]}@example.test`, passwordHash: 'unused', role: i === 0 || i === 5 ? 'ASSISTANT' : 'USER', groupId } });
        const venue = await db.venue.create({ data: { name: prefix, location: 'test' } });
        venueId = venue.id;
        const layout = await db.layoutVersion.create({ data: { venueId, name: prefix, status: 'PUBLISHED', seats: { create: [{ code: 'A01', x: 100, y: 100 }, { code: 'A02', x: 200, y: 100 }, { code: 'X01', x: 300, y: 100, enabled: false }] } }, include: { seats: true } });
        layoutId = layout.id;
        const course = await db.course.create({ data: { name: prefix, instructor: 'Test' } });
        courseId = course.id;
        const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
        const session = await db.session.create({ data: { courseId, layoutId, startsAt: new Date(`${tomorrow}T09:00:00+08:00`), endsAt: new Date(`${tomorrow}T11:00:00+08:00`) } });
        sessionId = session.id;
        const a = layout.seats.find(s => s.code === 'A01')!, b = layout.seats.find(s => s.code === 'A02')!, disabled = layout.seats.find(s => s.code === 'X01')!;
        await t.test('no assistant means no booking; learner cannot register coverage', async () => {
            await assert.rejects(reserveSeat(ids[1], sessionId, a.id), /助教保障/);
            await assert.rejects(addCoverage(ids[1], sessionId), /仅助教/);
        });
        const coverage = await addCoverage(ids[0], sessionId);
        await t.test('coverage does not consume seats and cannot be duplicated', async () => {
            assert.equal(await db.reservation.count({ where: { sessionId } }), 0);
            await assert.rejects(addCoverage(ids[0], sessionId), /已经登记/);
            await assert.rejects(reserveSeat(ids[1], sessionId, disabled.id), /座位不可用/);
        });
        await t.test('a two-assistant threshold opens seats only after both register', async () => {
            await db.session.update({ where: { id: sessionId }, data: { requiredAssistants: 2 } });
            await assert.rejects(reserveSeat(ids[1], sessionId, a.id), /助教保障/);
            const second = await addCoverage(ids[5], sessionId);
            const record = await reserveSeat(ids[1], sessionId, a.id);
            await assert.rejects(removeCoverage(ids[5], second.id), /已有学员/);
            await cancelReservation(ids[1], record.id);
            await removeCoverage(ids[5], second.id);
            await db.session.update({ where: { id: sessionId }, data: { requiredAssistants: 1 } });
        });
        await t.test('a seat from a different published layout cannot be booked', async () => {
            const other = await db.layoutVersion.create({ data: { name: `${prefix}-other`, venueId, status: 'PUBLISHED', seats: { create: { code: 'Z01', x: 50, y: 50 } } }, include: { seats: true } });
            try { await assert.rejects(reserveSeat(ids[1], sessionId, other.seats[0].id), /座位不可用/); }
            finally { await db.layoutVersion.delete({ where: { id: other.id } }); }
        });
        let winner = '';
        await t.test('same seat, different users: exactly one concurrent booking succeeds', async () => {
            const results = await Promise.allSettled([reserveSeat(ids[1], sessionId, a.id), reserveSeat(ids[2], sessionId, a.id)]);
            assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
            winner = (results.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<{
                userId: string;
            }>).value.userId;
            assert.equal(await db.reservation.count({ where: { sessionId, seatId: a.id, cancelledAt: null } }), 1);
        });
        await t.test('one user cannot reserve a second seat; someone else cannot cancel', async () => {
            await assert.rejects(reserveSeat(winner, sessionId, b.id), /每人每场/);
            const r = await db.reservation.findFirstOrThrow({ where: { sessionId, userId: winner, cancelledAt: null } });
            await assert.rejects(cancelReservation(ids[3], r.id), /无权/);
        });
        await t.test('coverage cannot be removed once learners have booked', async () => { await assert.rejects(removeCoverage(ids[0], coverage.id), /已有学员/); });
        await t.test('cancellation retains history and releases seat', async () => {
            const r = await db.reservation.findFirstOrThrow({ where: { sessionId, userId: winner, cancelledAt: null } });
            await cancelReservation(winner, r.id);
            assert.ok((await db.reservation.findUniqueOrThrow({ where: { id: r.id } })).cancelledAt);
            const again = await reserveSeat(ids[3], sessionId, a.id);
            await cancelReservation(ids[3], again.id);
            await removeCoverage(ids[0], coverage.id);
        });
        await addCoverage(ids[0], sessionId);
        await t.test('same user, different seats: exactly one concurrent booking succeeds', async () => {
            const results = await Promise.allSettled([reserveSeat(ids[4], sessionId, a.id), reserveSeat(ids[4], sessionId, b.id)]);
            assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
            const record = await db.reservation.findFirstOrThrow({ where: { sessionId, userId: ids[4], cancelledAt: null } });
            await cancelReservation(ids[4], record.id);
        });
        await t.test('racing coverage removal and booking never leaves an unstaffed reservation', async () => {
            const current = await db.assistantCoverage.findFirstOrThrow({ where: { sessionId } });
            await Promise.allSettled([reserveSeat(ids[3], sessionId, a.id), removeCoverage(ids[0], current.id)]);
            const active = await db.reservation.findMany({ where: { sessionId, cancelledAt: null } });
            const staff = await db.assistantCoverage.count({ where: { sessionId } });
            assert.ok(active.length === 0 || staff >= 1);
            for (const r of active)
                await cancelReservation(r.userId, r.id);
            if (!staff)
                await addCoverage(ids[0], sessionId);
        });
        await t.test('disabled users and forbidden groups are rejected by service', async () => {
            await db.user.update({ where: { id: ids[1] }, data: { enabled: false } });
            await assert.rejects(reserveSeat(ids[1], sessionId, a.id), /账号不可用/);
            await db.group.update({ where: { id: groupId }, data: { canReserve: false } });
            await assert.rejects(reserveSeat(ids[2], sessionId, a.id), /所属分组/);
            await db.group.update({ where: { id: groupId }, data: { canReserve: true } });
        });
        await t.test('database itself rejects duplicate active seat and user keys', async () => {
            const r = await reserveSeat(ids[2], sessionId, a.id);
            await assert.rejects(db.reservation.create({ data: { sessionId, seatId: a.id, userId: ids[3] } }));
            await assert.rejects(db.reservation.create({ data: { sessionId, seatId: b.id, userId: ids[2] } }));
            await cancelReservation(ids[2], r.id);
        });
        await t.test('ended sessions reject booking and cancellation', async () => {
            const r = await reserveSeat(ids[2], sessionId, a.id);
            await db.session.update({ where: { id: sessionId }, data: { startsAt: new Date(Date.now() - 7200000), endsAt: new Date(Date.now() - 3600000) } });
            await assert.rejects(reserveSeat(ids[3], sessionId, b.id), /已经开始/);
            await assert.rejects(cancelReservation(ids[2], r.id), /开始后/);
        });
    }
    finally {
        await db.auditLog.deleteMany({ where: { actorId: { in: ids } } });
        await db.reservation.deleteMany({ where: { userId: { in: ids } } });
        await db.assistantCoverage.deleteMany({ where: { assistantId: { in: ids } } });
        if (sessionId)
            await db.session.delete({ where: { id: sessionId } });
        if (courseId)
            await db.course.delete({ where: { id: courseId } });
        if (layoutId)
            await db.layoutVersion.delete({ where: { id: layoutId } });
        if (venueId)
            await db.venue.delete({ where: { id: venueId } });
        await db.user.deleteMany({ where: { id: { in: ids } } });
        if (groupId)
            await db.group.delete({ where: { id: groupId } });
        await db.$disconnect();
    }
});
