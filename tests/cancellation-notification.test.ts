import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/lib/db';
import { cancelReservation, reserveSeat } from '../src/lib/bookings';
import { localParts } from '../src/lib/rules';

assert.ok(process.env.DATABASE_URL, 'DATABASE_URL 未设置：需要初始化后的 PostgreSQL 测试库');

test('最后一名助教取消工位时只释放失去覆盖的学员预约并通知', async () => {
    const prefix = `coverage-${randomUUID()}`;
    const users = await Promise.all([
        db.user.create({ data: { name: '助教甲', studentId: `${prefix}a`, email: `${prefix}-a@test.local`, role: 'ASSISTANT', passwordHash: 'unused' } }),
        db.user.create({ data: { name: '助教乙', studentId: `${prefix}b`, email: `${prefix}-b@test.local`, role: 'ASSISTANT', passwordHash: 'unused' } }),
        db.user.create({ data: { name: '预约学员', studentId: `${prefix}u`, email: `${prefix}-u@test.local`, role: 'USER', passwordHash: 'unused' } }),
    ]);
    const [assistantA, assistantB, learner] = users;
    const venue = await db.venue.create({ data: { name: prefix, location: 'test' } });
    const layout = await db.layoutVersion.create({
        data: { name: prefix, venueId: venue.id, status: 'PUBLISHED', seats: { create: ['A01', 'A02', 'A03', 'B01', 'B02', 'B03'].map((code, i) => ({ code, x: i * 50, y: 0 })) } },
        include: { seats: true },
    });
    const tomorrow = localParts(new Date(Date.now() + 86400000)).date;
    const start = new Date(`${tomorrow}T09:00:00+08:00`).getTime();
    const sessions = await Promise.all([0, 2].map(hour => db.session.create({
        data: { layoutId: layout.id, startsAt: new Date(start + hour * 3600000), endsAt: new Date(start + (hour + 1) * 3600000), open: true },
    })));
    const [first, second] = sessions;
    const seat = (code: string) => layout.seats.find(item => item.code === code)!.id;
    try {
        const bookings = [
            await reserveSeat(assistantA.id, first.id, seat('A01')),
            await reserveSeat(learner.id, first.id, seat('A02')),
            await reserveSeat(assistantA.id, second.id, seat('B01')),
            await reserveSeat(assistantB.id, second.id, seat('B02')),
            await reserveSeat(learner.id, second.id, seat('B03')),
        ];
        await cancelReservation(assistantA.id, bookings[0].id);
        const firstAfter = await db.session.findUniqueOrThrow({ where: { id: first.id } });
        const firstLearnerBooking = await db.reservation.findUniqueOrThrow({ where: { id: bookings[1].id } });
        assert.equal(firstAfter.open, true);
        assert.equal(firstAfter.cancelledAt, null);
        assert.ok(firstLearnerBooking.cancelledAt);

        await cancelReservation(assistantA.id, bookings[2].id);
        const stillCovered = await db.session.findUniqueOrThrow({ where: { id: second.id } });
        assert.equal(stillCovered.open, true);
        assert.equal(stillCovered.cancelledAt, null);
        assert.equal((await db.reservation.findUniqueOrThrow({ where: { id: bookings[4].id } })).cancelledAt, null);
        assert.equal(await db.notification.count({ where: { recipientId: learner.id } }), 1, '仍有助教覆盖时不能重复通知');

        await cancelReservation(assistantB.id, bookings[3].id);
        const secondAfter = await db.session.findUniqueOrThrow({ where: { id: second.id } });
        assert.equal(secondAfter.open, true);
        assert.equal(secondAfter.cancelledAt, null);
        assert.ok((await db.reservation.findUniqueOrThrow({ where: { id: bookings[4].id } })).cancelledAt);

        const notifications = await db.notification.findMany({ where: { recipientId: learner.id }, orderBy: { createdAt: 'asc' } });
        assert.equal(notifications.length, 2);
        assert.match(notifications[0].message, /A02号工位预约已自动取消/);
        assert.match(notifications[1].message, /B03号工位预约已自动取消/);
        assert.ok(notifications.every(item => item.readAt === null));
        assert.ok(notifications.every(item => item.type === 'BOOKING_CANCELLED'));
        await assert.rejects(cancelReservation(assistantB.id, bookings[3].id), /已经取消/);
        assert.equal(await db.notification.count({ where: { recipientId: learner.id } }), 2);
    } finally {
        await db.notification.deleteMany({ where: { recipientId: { in: users.map(user => user.id) } } });
        await db.auditLog.deleteMany({ where: { actorId: { in: users.map(user => user.id) } } });
        await db.reservation.deleteMany({ where: { sessionId: { in: sessions.map(session => session.id) } } });
        await db.session.deleteMany({ where: { id: { in: sessions.map(session => session.id) } } });
        await db.layoutVersion.delete({ where: { id: layout.id } });
        await db.venue.delete({ where: { id: venue.id } });
        await db.user.deleteMany({ where: { id: { in: users.map(user => user.id) } } });
    }
});

test.after(() => db.$disconnect());
