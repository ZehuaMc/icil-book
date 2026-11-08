import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/lib/db';
import { reserveSeat, reserveSeatSlots, cancelReservation } from '../src/lib/bookings';
import { localParts } from '../src/lib/rules';

assert.ok(process.env.DATABASE_URL, 'DATABASE_URL 未设置：请配置专用测试数据库');

test('PostgreSQL: 助教实际预约覆盖、成员权限、禁止时间与并发', async t => {
    const prefix = `test-${randomUUID()}`;
    const group = await db.group.create({ data: { name: prefix } });
    const users = await Promise.all((['ASSISTANT', 'ASSISTANT', 'USER', 'USER', 'USER', 'ADMIN'] as const).map((role, i) => db.user.create({ data: { name: `Test ${i}`, studentId: `${prefix}${i}`, email: `${prefix}${i}@test.local`, role, memberType: i === 4 ? 'ICIL' : 'YSYX', groupId: i === 2 ? group.id : null, passwordHash: 'unused' } })));
    const [assistant, secondAssistant, learner, otherLearner, icil, admin] = users;
    const userIds = users.map(user => user.id);
    const venue = await db.venue.create({ data: { name: prefix, location: 'test' } });
    const layout = await db.layoutVersion.create({ data: { venueId: venue.id, name: prefix, status: 'PUBLISHED', seats: { create: [{ code: 'A01', x: 100, y: 100 }, { code: 'A02', x: 200, y: 100 }, { code: 'A03', x: 300, y: 100 }, { code: 'STAFF', x: 400, y: 100, fixedForAssistant: true }, { code: 'DISABLED', x: 500, y: 100, enabled: false }] } }, include: { seats: true } });
    const tomorrow = localParts(new Date(Date.now() + 86400000)).date;
    const midnight = new Date(`${tomorrow}T00:00:00+08:00`);
    const session = await db.session.create({ data: { layoutId: layout.id, startsAt: midnight, endsAt: new Date(midnight.getTime() + 86400000), open: false, icilOnly: true } });
    const time = (hour: number) => new Date(midnight.getTime() + hour * 3600000).toISOString();
    const seat = (code: string) => layout.seats.find(seat => seat.code === code)!.id;
    const book = (userId: string, code = 'A01', start = 9, end = 10, sessionId = session.id) => reserveSeat(userId, sessionId, seat(code), time(start), time(end));
    const reset = async () => {
        await db.reservation.deleteMany({ where: { userId: { in: userIds } } });
        await db.notification.deleteMany({ where: { recipientId: { in: userIds } } });
        await db.bookingBlock.deleteMany({ where: { createdById: admin.id } });
    };
    try {
        await t.test('自动日期容器不能绕过助教要求；管理员预约和旧保障登记不能充当助教预约', async () => {
            await assert.rejects(book(learner.id), /已有助教预约/);
            await book(admin.id, 'A02');
            const legacyCoverage = await db.assistantCoverage.create({ data: { sessionId: session.id, assistantId: assistant.id } });
            await assert.rejects(book(learner.id), /已有助教预约/);
            await db.assistantCoverage.delete({ where: { id: legacyCoverage.id } });
            await reset();
        });
        await t.test('旧预约规则已停用；一生一芯仅需助教预约覆盖，ICIL可直接预约', async () => {
            const ruleId = randomUUID();
            await db.$executeRaw`INSERT INTO "GroupDateRule" (id, "groupId", date, allowed, "startMinute", "endMinute") VALUES (${ruleId}, ${group.id}, ${tomorrow}, false, 0, 1440)`;
            await book(icil.id);
            await assert.rejects(book(learner.id, 'A02'), /已有助教预约/);
            await book(assistant.id, 'STAFF');
            await book(learner.id, 'A02');
            await assert.rejects(book(otherLearner.id, 'A03', 9, 10.5), /完整时间/);
            await reset();
        });
        await t.test('多个助教相邻预约可覆盖完整时间，存在空隙则拒绝', async () => {
            await book(assistant.id, 'STAFF', 9, 9.5);
            await book(secondAssistant.id, 'A02', 9.5, 10);
            await book(learner.id);
            await assert.rejects(book(otherLearner.id, 'A03', 9, 10.5), /完整时间/);
            await reset();
            await book(assistant.id, 'STAFF', 9, 9.5);
            await book(secondAssistant.id, 'A02', 10, 10.5);
            await assert.rejects(book(learner.id, 'A03', 9, 10.5), /完整时间/);
            await reset();
        });
        await t.test('不同日期容器内的助教预约按同一场地完整时间检查', async () => {
            const legacy = await db.session.create({ data: { layoutId: layout.id, startsAt: new Date(time(9)), endsAt: new Date(time(10)), open: false } });
            try {
                await book(assistant.id, 'STAFF', 9, 10, legacy.id);
                await book(learner.id);
                await assert.rejects(book(icil.id, 'STAFF'), /固定工位/);
            } finally {
                await reset();
                await db.session.delete({ where: { id: legacy.id } });
            }
        });
        await t.test('停用或注销的助教不提供预约资格', async () => {
            await book(assistant.id, 'STAFF');
            await db.user.update({ where: { id: assistant.id }, data: { enabled: false } });
            await assert.rejects(book(learner.id), /已有助教预约/);
            await db.user.update({ where: { id: assistant.id }, data: { enabled: true, deletedAt: new Date() } });
            await assert.rejects(book(learner.id), /已有助教预约/);
            await db.user.update({ where: { id: assistant.id }, data: { deletedAt: null } });
            await reset();
        });
        await t.test('批量预约全有或全无；缺少一个时间的助教预约不会部分成功', async () => {
            await book(assistant.id, 'STAFF', 9, 9.5);
            const logCount = await db.auditLog.count({ where: { actorId: learner.id } });
            await assert.rejects(reserveSeatSlots(learner.id, session.id, seat('A01'), [{ startsAt: time(9), endsAt: time(9.5) }, { startsAt: time(10), endsAt: time(10.5) }]), /完整时间/);
            assert.equal(await db.reservation.count({ where: { userId: learner.id } }), 0);
            assert.equal(await db.auditLog.count({ where: { actorId: learner.id } }), logCount, '失败批量预约不能写入成功日志');
            await reset();
        });
        await t.test('批量预约支持乱序不连续时间，冲突时连同成功日志一起回滚', async () => {
            const slots = [{ startsAt: time(11), endsAt: time(11.5) }, { startsAt: time(9), endsAt: time(9.5) }];
            const result = await reserveSeatSlots(icil.id, session.id, seat('A01'), slots);
            assert.deepEqual(result.reservations.map(record => record.startsAt.toISOString()), [time(9), time(11)]);
            const logCount = await db.auditLog.count({ where: { actorId: icil.id } });
            await assert.rejects(reserveSeatSlots(icil.id, session.id, seat('A02'), [{ startsAt: time(10), endsAt: time(10.5) }, slots[0]]), /已有预约/);
            assert.equal(await db.reservation.count({ where: { userId: icil.id } }), 2);
            assert.equal(await db.auditLog.count({ where: { actorId: icil.id } }), logCount);
            for (const invalid of [[], Array(49).fill(slots[0]), [slots[0], slots[0]]])
                await assert.rejects(reserveSeatSlots(icil.id, session.id, seat('A02'), invalid), /1 至 48|不能重叠/);
            await reset();
        });
        await t.test('成员可预约到明天午夜，后天仅助教和管理员可约', async () => {
            await book(icil.id, 'A01', 23.5, 24);
            const future = await db.session.create({ data: { layoutId: layout.id, startsAt: new Date(time(24)), endsAt: new Date(time(48)), open: false } });
            try {
                for (const user of [learner, icil]) await assert.rejects(book(user.id, 'A01', 33, 34, future.id), /提前一天/);
                await book(assistant.id, 'STAFF', 33, 34, future.id);
                await book(admin.id, 'A02', 33, 34, future.id);
            } finally {
                await reset();
                await db.session.delete({ where: { id: future.id } });
            }
        });
        await t.test('不同日期容器并发仍限制同人和同场地同编号工位的重叠预约', async () => {
            const overlapping = await db.session.create({ data: { layoutId: layout.id, startsAt: new Date(time(9)), endsAt: new Date(time(12)) } });
            try {
                const sameSeat = await Promise.allSettled([book(icil.id), book(admin.id, 'A01', 9, 10, overlapping.id)]);
                assert.equal(sameSeat.filter(result => result.status === 'fulfilled').length, 1);
                assert.equal(await db.reservation.count({ where: { seatId: seat('A01'), cancelledAt: null } }), 1);
                await reset();
                const sameUser = await Promise.allSettled([book(icil.id), book(icil.id, 'A02', 9, 10, overlapping.id)]);
                assert.equal(sameUser.filter(result => result.status === 'fulfilled').length, 1);
                assert.equal(await db.reservation.count({ where: { userId: icil.id, cancelledAt: null } }), 1);
            } finally {
                await reset();
                await db.session.delete({ where: { id: overlapping.id } });
            }
        });
        await t.test('禁止时间对一生一芯、ICIL、助教和管理员均生效，边界相邻可约', async () => {
            await book(assistant.id, 'STAFF', 9, 12);
            await db.bookingBlock.create({ data: { kind: 'SESSION', startsAt: new Date(time(10)), endsAt: new Date(time(11)), createdById: admin.id } });
            for (const user of [learner, icil, secondAssistant, admin]) await assert.rejects(book(user.id, 'A01', 10, 10.5), /禁用预约/);
            await book(learner.id, 'A01', 9, 10);
            await book(learner.id, 'A01', 11, 12);
            await reset();
        });
        await t.test('同座并发只允许一个成功；取消释放且保留历史', async () => {
            await book(assistant.id, 'STAFF');
            const results = await Promise.allSettled([book(learner.id), book(otherLearner.id)]);
            assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
            const record = (results.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<{ id: string; userId: string }>).value;
            await assert.rejects(cancelReservation(secondAssistant.id, record.id), /无权/);
            await cancelReservation(record.userId, record.id);
            assert.ok((await db.reservation.findUniqueOrThrow({ where: { id: record.id } })).cancelledAt);
            await book(icil.id);
            await reset();
        });
        await t.test('同人并发只能预约一个座位；半小时不对齐、停用及固定座位拒绝成员', async () => {
            await book(assistant.id, 'STAFF');
            const results = await Promise.allSettled([book(learner.id), book(learner.id, 'A02')]);
            assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
            await assert.rejects(book(icil.id, 'DISABLED'), /座位/);
            await assert.rejects(book(icil.id, 'STAFF'), /固定工位/);
            await assert.rejects(book(icil.id, 'A03', 9.1, 9.6), /30 分钟/);
            await reset();
        });
        await t.test('助教取消只取消失去覆盖的一生一芯预约，保留ICIL及其他完整覆盖的预约', async () => {
            const first = await book(assistant.id, 'STAFF', 9, 10);
            await book(secondAssistant.id, 'STAFF', 10, 11);
            const affected = await book(learner.id, 'A01', 9, 10);
            const preserved = await book(learner.id, 'A01', 10, 11);
            const icilRecord = await book(icil.id, 'A02', 9, 10);
            await cancelReservation(assistant.id, first.id);
            assert.ok((await db.reservation.findUniqueOrThrow({ where: { id: affected.id } })).cancelledAt);
            assert.equal((await db.reservation.findUniqueOrThrow({ where: { id: preserved.id } })).cancelledAt, null);
            assert.equal((await db.reservation.findUniqueOrThrow({ where: { id: icilRecord.id } })).cancelledAt, null);
            assert.equal((await db.session.findUniqueOrThrow({ where: { id: session.id } })).cancelledAt, null);
            assert.equal(await db.notification.count({ where: { recipientId: learner.id } }), 1);
            await reset();
        });
        await t.test('助教取消和成员提交竞争，最终不会留下无助教覆盖的有效预约', async () => {
            const first = await book(assistant.id, 'STAFF');
            await Promise.allSettled([book(learner.id), cancelReservation(assistant.id, first.id)]);
            assert.equal(await db.reservation.count({ where: { userId: learner.id, cancelledAt: null } }), 0);
            await reset();
        });
        await t.test('数据库约束拒绝重叠活动预约，已开始预约不能取消', async () => {
            const record = await book(icil.id);
            await assert.rejects(db.reservation.create({ data: { sessionId: session.id, userId: learner.id, seatId: record.seatId, startsAt: record.startsAt, endsAt: record.endsAt } }));
            await assert.rejects(db.reservation.create({ data: { sessionId: session.id, userId: icil.id, seatId: seat('A02'), startsAt: record.startsAt, endsAt: record.endsAt } }));
            await db.reservation.update({ where: { id: record.id }, data: { startsAt: new Date(Date.now() - 3600000), endsAt: new Date(Date.now() + 3600000) } });
            await assert.rejects(cancelReservation(icil.id, record.id), /开始后/);
            await reset();
        });
    } finally {
        await reset();
        await db.assistantCoverage.deleteMany({ where: { sessionId: session.id } });
        await db.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
        await db.session.delete({ where: { id: session.id } });
        await db.layoutVersion.delete({ where: { id: layout.id } });
        await db.venue.delete({ where: { id: venue.id } });
        await db.user.deleteMany({ where: { id: { in: userIds } } });
        await db.group.delete({ where: { id: group.id } });
    }
});
test.after(() => db.$disconnect());
