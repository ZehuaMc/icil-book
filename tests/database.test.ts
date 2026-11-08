import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { compare } from 'bcryptjs';

assert.ok(process.env.DATABASE_URL, '需要专用 PostgreSQL 测试库');
assert.ok(process.env.ADMIN_STUDENT_ID && process.env.ADMIN_PASSWORD, '需要 ADMIN_STUDENT_ID 和 ADMIN_PASSWORD 以验证初始化后的管理员登录');

test('空 schema 建库、预约冲突约束与重复初始化保留人工修改', async () => {
    const schema = `verify_${randomUUID().replaceAll('-', '')}`;
    const url = new URL(process.env.DATABASE_URL!);
    url.searchParams.set('schema', schema);
    const databaseUrl = url.toString();
    const db = new PrismaClient({ datasourceUrl: databaseUrl });
    function run(command: string, args: string[]) {
        const result = spawnSync(command, args, {
            env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: 'utf8', timeout: 60000,
        });
        assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
        return result.stdout;
    }
    const init = ['scripts/init-db.mjs'];
    const seed = ['--import', 'tsx', 'prisma/seed.ts'];
    try {
        run(process.execPath, init);
        const indexes = await db.$queryRaw<{ indexname: string; indexdef: string }[]>`
            SELECT indexname, indexdef FROM pg_indexes
            WHERE schemaname = ${schema} AND indexname IN ('Reservation_active_seat_time_excl', 'Reservation_active_user_time_excl')`;
        assert.equal(indexes.length, 2);
        const userIndex = indexes.find(index => index.indexname === 'Reservation_active_user_time_excl');
        const seatIndex = indexes.find(index => index.indexname === 'Reservation_active_seat_time_excl');
        assert.ok(userIndex);
        assert.match(userIndex.indexdef, /gist.*tstzrange.*WHERE \("cancelledAt" IS NULL\)/);
        assert.ok(seatIndex);
        assert.match(seatIndex.indexdef, /gist.*tstzrange.*WHERE \("cancelledAt" IS NULL\)/);
        run(process.execPath, seed);
        assert.equal(await db.user.count(), 1);
        assert.equal(await db.seat.count(), 24);
        assert.equal(await db.session.count(), 0);
        assert.equal(await db.assistantCoverage.count(), 0);
        assert.equal(await db.group.count(), 0, '初始化不再创建预约分组或规则');
        assert.equal(await db.appSetting.count(), 0);
        const admin = await db.user.update({ where: { id: 'seed-admin' }, data: { name: '保留的管理员姓名', passwordHash: 'preserved-password-hash' } });
        const group = await db.group.create({ data: { name: '保留的默认分组' } });
        await db.appSetting.create({ data: { id: 'main', defaultGroupId: group.id } });
        await db.layoutVersion.update({ where: { id: 'seed-layout' }, data: { name: '保留的布局' } });
        const session = await db.session.create({ data: { id: 'preserved-session', layoutId: 'seed-layout', startsAt: new Date('2030-01-01T10:00:00+08:00'), endsAt: new Date('2030-01-01T11:00:00+08:00') } });
        await db.session.update({ where: { id: session.id }, data: { open: false } });
        await db.assistantCoverage.deleteMany({});
        run(process.execPath, init);
        run(process.execPath, seed);
        const reseededAdmin = await db.user.findUniqueOrThrow({ where: { id: admin.id } });
        assert.equal(reseededAdmin.name, process.env.ADMIN_NAME ?? '空间管理员');
        assert.equal(reseededAdmin.role, 'ADMIN');
        assert.notEqual(reseededAdmin.passwordHash, admin.passwordHash);
        assert.equal(await compare(process.env.ADMIN_PASSWORD!, reseededAdmin.passwordHash), true);
        assert.equal(reseededAdmin.studentId, process.env.ADMIN_STUDENT_ID!.trim().toLowerCase());
        assert.equal(reseededAdmin.enabled, true);
        assert.equal(reseededAdmin.deletedAt, null);
        assert.equal((await db.appSetting.findUniqueOrThrow({ where: { id: 'main' } })).defaultGroupId, group.id);
        assert.equal((await db.layoutVersion.findUniqueOrThrow({ where: { id: 'seed-layout' } })).name, '保留的布局');
        assert.equal((await db.session.findUniqueOrThrow({ where: { id: session.id } })).open, false);
        assert.equal(await db.session.count(), 1);
        assert.equal(await db.assistantCoverage.count(), 0, '不能补回已取消保障或替停用/降级助教登记');
        assert.equal(await db.user.count(), 1);
        assert.equal(await db.seat.count(), 24);
        const learnerIdentity = { studentId: 'dualrole001', name: '双身份学员', passwordHash: 'test-hash' };
        await db.user.create({ data: { ...learnerIdentity, id: 'dual-role-learner', email: 'dual-role-001+user@student.local', role: 'USER' } });
        await db.user.create({ data: { ...learnerIdentity, id: 'dual-role-admin', email: 'dual-role-001+admin@student.local', role: 'ADMIN' } });
        assert.deepEqual(await db.user.findMany({ where: { studentId: learnerIdentity.studentId }, select: { role: true }, orderBy: { role: 'asc' } }), [{ role: 'USER' }, { role: 'ADMIN' }]);
        await assert.rejects(db.user.create({ data: { ...learnerIdentity, id: 'duplicate-learner', email: 'duplicate+user@student.local', role: 'USER' } }), { code: 'P2002' });
        const booking = { sessionId: session.id, userId: admin.id, seatId: 'unused', startsAt: session.startsAt, endsAt: new Date(session.startsAt.getTime() + 1800000) };
        const seats = await db.seat.findMany({ where: { layoutId: 'seed-layout', enabled: true }, take: 2 });
        booking.seatId = seats[0].id;
        await db.reservation.create({ data: booking });
        await db.reservation.create({ data: { ...booking, startsAt: booking.endsAt, endsAt: session.endsAt } });
        assert.equal(await db.reservation.count({ where: { userId: admin.id } }), 2, '同一用户和工位允许相邻时段');
        await assert.rejects(db.reservation.create({ data: { ...booking, seatId: seats[1].id } }), /Reservation_active_user_time_excl/);
        await assert.rejects(db.reservation.create({ data: { ...booking, userId: 'dual-role-learner' } }), /Reservation_active_seat_time_excl/);
        const overlap = { ...booking, startsAt: new Date(booking.startsAt.getTime() + 15 * 60000), endsAt: new Date(booking.endsAt.getTime() + 15 * 60000) };
        await assert.rejects(db.reservation.create({ data: { ...overlap, seatId: seats[1].id } }), /Reservation_active_user_time_excl/);
        await assert.rejects(db.reservation.create({ data: { ...overlap, userId: 'dual-role-learner' } }), /Reservation_active_seat_time_excl/);
        await assert.rejects(db.reservation.create({ data: { ...booking, startsAt: booking.endsAt, endsAt: booking.startsAt } }), /Reservation_time_window_check/);
        await assert.rejects(db.reservation.create({ data: { ...booking, endsAt: booking.startsAt } }), /Reservation_time_window_check/);
        await db.reservation.updateMany({ where: { userId: admin.id }, data: { cancelledAt: new Date() } });
        await db.reservation.create({ data: booking });
        assert.equal(await db.reservation.count({ where: { userId: admin.id, cancelledAt: null } }), 1, '取消后排斥约束应允许重新预约');
    } finally {
        await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await db.$disconnect();
    }
});
