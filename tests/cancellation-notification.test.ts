import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/lib/db';
import { cancelReservation, reserveSeat } from '../src/lib/bookings';

assert.ok(process.env.DATABASE_URL, 'DATABASE_URL 未设置：需要迁移后的 PostgreSQL 测试库');

test('最后一名管理员取消工位时关闭时段、取消学员预约并创建通知', async () => {
    const prefix = `coverage-${randomUUID()}`;
    const group = await db.group.create({
        data: {
            name: prefix,
            canReserve: true,
            weeklyRules: { create: Array.from({ length: 7 }, (_, weekday) => ({ weekday, startMinute: 0, endMinute: 1440 })) },
        },
    });
    const users = await Promise.all([
        db.user.create({ data: { name: '管理员甲', studentId: `${prefix}a`, email: `${prefix}-a@test.local`, role: 'ADMIN', groupId: group.id, passwordHash: 'unused' } }),
        db.user.create({ data: { name: '管理员乙', studentId: `${prefix}b`, email: `${prefix}-b@test.local`, role: 'ADMIN', groupId: group.id, passwordHash: 'unused' } }),
        db.user.create({ data: { name: '预约学员', studentId: `${prefix}u`, email: `${prefix}-u@test.local`, role: 'USER', groupId: group.id, passwordHash: 'unused' } }),
    ]);
    const [adminA, adminB, learner] = users;
    const venue = await db.venue.create({ data: { name: prefix, location: 'test' } });
    const layout = await db.layoutVersion.create({
        data: { name: prefix, venueId: venue.id, status: 'PUBLISHED', seats: { create: ['A01', 'A02', 'A03', 'B01', 'B02', 'B03'].map((code, i) => ({ code, x: i * 50, y: 0 })) } },
        include: { seats: true },
    });
    const sessions = await Promise.all([1, 2].map(day => db.session.create({
        data: { layoutId: layout.id, startsAt: new Date(Date.now() + day * 86400000), endsAt: new Date(Date.now() + day * 86400000 + 3600000), open: true },
    })));
    const [first, second] = sessions;
    const [a01, a02, a03, b01, b02, b03] = layout.seats;
    const bookings = await Promise.all([
        reserveSeat(adminA.id, first.id, a01.id),
        reserveSeat(learner.id, first.id, a02.id),
        reserveSeat(adminA.id, second.id, b01.id),
        reserveSeat(adminB.id, second.id, b02.id),
        reserveSeat(learner.id, second.id, b03.id),
    ]);
    try {
        await cancelReservation(adminA.id, bookings[0].id);
        const firstAfter = await db.session.findUniqueOrThrow({ where: { id: first.id } });
        const firstLearnerBooking = await db.reservation.findUniqueOrThrow({ where: { id: bookings[1].id } });
        assert.equal(firstAfter.open, false);
        assert.ok(firstAfter.cancelledAt);
        assert.ok(firstLearnerBooking.cancelledAt);

        await cancelReservation(adminA.id, bookings[2].id);
        const stillCovered = await db.session.findUniqueOrThrow({ where: { id: second.id } });
        assert.equal(stillCovered.open, true);
        assert.equal(stillCovered.cancelledAt, null);
        assert.equal((await db.reservation.findUniqueOrThrow({ where: { id: bookings[4].id } })).cancelledAt, null);

        await cancelReservation(adminB.id, bookings[3].id);
        const secondAfter = await db.session.findUniqueOrThrow({ where: { id: second.id } });
        assert.equal(secondAfter.open, false);
        assert.ok(secondAfter.cancelledAt);
        assert.ok((await db.reservation.findUniqueOrThrow({ where: { id: bookings[4].id } })).cancelledAt);

        const notifications = await db.notification.findMany({ where: { recipientId: learner.id }, orderBy: { createdAt: 'asc' } });
        assert.equal(notifications.length, 2);
        assert.match(notifications[0].message, /A02号工位预约已自动取消/);
        assert.match(notifications[1].message, /B03号工位预约已自动取消/);
        assert.ok(notifications.every(item => item.readAt === null));
    } finally {
        await db.notification.deleteMany({ where: { recipientId: { in: users.map(user => user.id) } } });
        await db.auditLog.deleteMany({ where: { actorId: { in: users.map(user => user.id) } } });
        await db.reservation.deleteMany({ where: { sessionId: { in: sessions.map(session => session.id) } } });
        await db.session.deleteMany({ where: { id: { in: sessions.map(session => session.id) } } });
        await db.layoutVersion.delete({ where: { id: layout.id } });
        await db.venue.delete({ where: { id: venue.id } });
        await db.user.deleteMany({ where: { id: { in: users.map(user => user.id) } } });
        await db.group.delete({ where: { id: group.id } });
    }
});

test.after(() => db.$disconnect());
