import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/lib/db';
import { reserveSeat, addCoverage, cancelReservation, replaceAdminSeat } from '../src/lib/bookings';

assert.ok(process.env.DATABASE_URL, 'DATABASE_URL 未设置：请配置专用测试数据库，不能跳过集成验证');

test('PostgreSQL: 管理员开放、换座、暂停、授权和并发预约', async (t) => {
    const prefix = `test-${randomUUID()}`;
    await db.$connect();
    let sessionId = '', groupId = '', layoutId = '', venueId = '';
    const ids = [0, 1, 2, 3, 4, 5].map(i => `${prefix}-user-${i}`);
    try {
        const group = await db.group.create({ data: { name: prefix, canReserve: true, weeklyRules: { create: Array.from({ length: 7 }, (_, weekday) => ({ weekday, startMinute: 0, endMinute: 1440 })) } } });
        groupId = group.id;
        for (let i = 0; i < ids.length; i++)
            await db.user.create({ data: { id: ids[i], name: `Test ${i}`, studentId: ids[i].replace(/[^a-zA-Z0-9]/g, ''), email: `${ids[i]}@example.test`, passwordHash: 'unused', role: i === 0 || i === 5 ? 'ASSISTANT' : 'USER', groupId } });
        const venue = await db.venue.create({ data: { name: prefix, location: 'test' } });
        venueId = venue.id;
        const layout = await db.layoutVersion.create({ data: { venueId, name: prefix, status: 'PUBLISHED', seats: { create: [{ code: 'A01', x: 100, y: 100 }, { code: 'A02', x: 200, y: 100 }, { code: 'A03', x: 300, y: 100 }, { code: 'X01', x: 400, y: 100, enabled: false }] } }, include: { seats: true } });
        layoutId = layout.id;
        const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
        const startsAt = new Date(`${tomorrow}T09:00:00+08:00`), endsAt = new Date(`${tomorrow}T11:00:00+08:00`);
        const session = await db.session.create({ data: { layoutId, startsAt, endsAt, open: false } });
        sessionId = session.id;
        const a = layout.seats.find(s => s.code === 'A01')!, b = layout.seats.find(s => s.code === 'A02')!, c = layout.seats.find(s => s.code === 'A03')!, disabled = layout.seats.find(s => s.code === 'X01')!;

        await t.test('未开放时学员不能预约，助教保障不替代开放状态', async () => {
            await assert.rejects(reserveSeat(ids[1], sessionId, a.id), /管理员尚未开放/);
            await assert.rejects(addCoverage(ids[1], sessionId), /助教/);
        });
        const adminBooking = await reserveSeat(ids[0], sessionId, b.id);
        await db.session.update({ where: { id: sessionId }, data: { open: true } });
        const coverage = await addCoverage(ids[0], sessionId);
        await t.test('管理员座位占用真实工位，保障记录不占座', async () => {
            assert.equal(adminBooking.seatId, b.id);
            assert.equal(await db.reservation.count({ where: { sessionId } }), 1);
            assert.equal((await addCoverage(ids[0], sessionId)).id, coverage.id);
            await assert.rejects(reserveSeat(ids[1], sessionId, disabled.id), /座位/);
        });

        await t.test('暂停后可以换管理员工位且不取消学员预约', async () => {
            const learner = await reserveSeat(ids[1], sessionId, a.id, startsAt.toISOString(), new Date(startsAt.getTime() + 3600000).toISOString());
            await assert.rejects(replaceAdminSeat(ids[0], sessionId, c.id), /暂停开放/);
            await db.session.update({ where: { id: sessionId }, data: { open: false } });
            const changed = await replaceAdminSeat(ids[0], sessionId, c.id);
            assert.equal(changed.seatId, c.id);
            assert.ok(await db.reservation.findUniqueOrThrow({ where: { id: learner.id } }));
            assert.equal(await db.reservation.count({ where: { sessionId, userId: ids[0], cancelledAt: null } }), 1);
            await db.session.update({ where: { id: sessionId }, data: { open: true } });
            await cancelReservation(ids[1], learner.id);
        });

        let winner = '';
        await t.test('同一座位并发预约只允许一个成功', async () => {
            const results = await Promise.allSettled([reserveSeat(ids[1], sessionId, a.id), reserveSeat(ids[2], sessionId, a.id)]);
            assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
            winner = (results.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<{ userId: string }>).value.userId;
            assert.equal(await db.reservation.count({ where: { sessionId, seatId: a.id, cancelledAt: null } }), 1);
        });
        await t.test('每人每场只能预约一个座位且他人不能取消', async () => {
            await assert.rejects(reserveSeat(winner, sessionId, c.id), /每人每场/);
            const record = await db.reservation.findFirstOrThrow({ where: { sessionId, userId: winner, cancelledAt: null } });
            await assert.rejects(cancelReservation(ids[3], record.id), /无权/);
            await cancelReservation(winner, record.id);
        });
        await t.test('取消保留历史并立即释放座位', async () => {
            const record = await reserveSeat(ids[3], sessionId, a.id);
            await cancelReservation(ids[3], record.id);
            assert.ok((await db.reservation.findUniqueOrThrow({ where: { id: record.id } })).cancelledAt);
            const again = await reserveSeat(ids[4], sessionId, a.id);
            await cancelReservation(ids[4], again.id);
        });
        await t.test('布局外、停用座位、禁用账号和禁用分组均被拒绝', async () => {
            const other = await db.layoutVersion.create({ data: { name: `${prefix}-other`, venueId, status: 'PUBLISHED', seats: { create: { code: 'Z01', x: 50, y: 50 } } }, include: { seats: true } });
            try { await assert.rejects(reserveSeat(ids[1], sessionId, other.seats[0].id)); }
            finally { await db.layoutVersion.delete({ where: { id: other.id } }); }
            await db.user.update({ where: { id: ids[1] }, data: { enabled: false } });
            await assert.rejects(reserveSeat(ids[1], sessionId, a.id), /账号不可用/);
            await db.user.update({ where: { id: ids[1] }, data: { enabled: true } });
            await db.group.update({ where: { id: groupId }, data: { canReserve: false } });
            await assert.rejects(reserveSeat(ids[2], sessionId, a.id), /所属分组/);
            await db.group.update({ where: { id: groupId }, data: { canReserve: true } });
        });
        await t.test('数据库约束拒绝活动座位和用户重复记录', async () => {
            const record = await reserveSeat(ids[2], sessionId, a.id);
            await assert.rejects(db.reservation.create({ data: { sessionId, seatId: a.id, userId: ids[3], startsAt: record.startsAt, endsAt: record.endsAt } }));
            await assert.rejects(db.reservation.create({ data: { sessionId, seatId: c.id, userId: ids[2], startsAt: record.startsAt, endsAt: record.endsAt } }));
            await cancelReservation(ids[2], record.id);
        });
        await t.test('已开始预约不能继续操作', async () => {
            const record = await reserveSeat(ids[2], sessionId, a.id);
            const pastStart = new Date(Date.now() - 7200000), pastEnd = new Date(Date.now() - 3600000);
            await db.session.update({ where: { id: sessionId }, data: { startsAt: pastStart, endsAt: pastEnd } });
            await db.reservation.update({ where: { id: record.id }, data: { startsAt: pastStart, endsAt: pastEnd } });
            await assert.rejects(reserveSeat(ids[3], sessionId, b.id), /当前时间之后/);
            await assert.rejects(cancelReservation(ids[2], record.id), /开始后/);
        });
    }
    finally {
        await db.auditLog.deleteMany({ where: { actorId: { in: ids } } });
        await db.reservation.deleteMany({ where: { userId: { in: ids } } });
        await db.assistantCoverage.deleteMany({ where: { assistantId: { in: ids } } });
        if (sessionId)
            await db.session.delete({ where: { id: sessionId } });
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
