import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

assert.ok(process.env.DATABASE_URL, '需要专用 PostgreSQL 测试库');

test('空 schema 迁移、实际索引、模型一致性与重复初始化保留人工修改', async () => {
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
    const prisma = ['node_modules/prisma/build/index.js'];
    const seed = ['--import', 'tsx', 'prisma/seed.ts'];
    try {
        run(process.execPath, [...prisma, 'migrate', 'deploy']);
        const indexes = await db.$queryRaw<{ indexname: string; indexdef: string }[]>`
            SELECT indexname, indexdef FROM pg_indexes
            WHERE schemaname = ${schema} AND indexname IN ('Reservation_active_seat_time_excl', 'Reservation_active_user_key')`;
        assert.equal(indexes.length, 2);
        const userIndex = indexes.find(index => index.indexname === 'Reservation_active_user_key');
        const seatIndex = indexes.find(index => index.indexname === 'Reservation_active_seat_time_excl');
        assert.ok(userIndex);
        assert.match(userIndex.indexdef, /UNIQUE.*WHERE \("cancelledAt" IS NULL\)/);
        assert.ok(seatIndex);
        assert.match(seatIndex.indexdef, /gist|tstzrange|cancelledAt/);
        run(process.execPath, [...prisma, 'migrate', 'diff', '--from-url', databaseUrl, '--to-schema-datamodel', 'prisma/schema.prisma', '--exit-code']);
        run(process.execPath, seed);
        assert.equal(await db.user.count(), 1);
        assert.equal(await db.seat.count(), 24);
        assert.equal(await db.session.count(), 0);
        assert.equal(await db.assistantCoverage.count(), 0);
        const admin = await db.user.update({ where: { id: 'seed-admin' }, data: { name: '保留的管理员姓名', passwordHash: 'preserved-password-hash' } });
        const group = await db.group.create({ data: { name: '保留的默认分组' } });
        await db.appSetting.update({ where: { id: 'main' }, data: { defaultGroupId: group.id } });
        await db.layoutVersion.update({ where: { id: 'seed-layout' }, data: { name: '保留的布局' } });
        const session = await db.session.create({ data: { id: 'preserved-session', layoutId: 'seed-layout', startsAt: new Date('2030-01-01T10:00:00+08:00'), endsAt: new Date('2030-01-01T11:00:00+08:00') } });
        await db.session.update({ where: { id: session.id }, data: { open: false } });
        await db.assistantCoverage.deleteMany({});
        run(process.execPath, [...prisma, 'migrate', 'deploy']);
        run(process.execPath, seed);
        const reseededAdmin = await db.user.findUniqueOrThrow({ where: { id: admin.id } });
        assert.equal(reseededAdmin.name, process.env.ADMIN_NAME ?? '空间管理员');
        assert.equal(reseededAdmin.role, 'ADMIN');
        assert.notEqual(reseededAdmin.passwordHash, admin.passwordHash);
        assert.equal((await db.appSetting.findUniqueOrThrow({ where: { id: 'main' } })).defaultGroupId, group.id);
        assert.equal((await db.layoutVersion.findUniqueOrThrow({ where: { id: 'seed-layout' } })).name, '保留的布局');
        assert.equal((await db.session.findUniqueOrThrow({ where: { id: session.id } })).open, false);
        assert.equal(await db.session.count(), 1);
        assert.equal(await db.assistantCoverage.count(), 0, '不能补回已取消保障或替停用/降级助教登记');
        assert.equal(await db.user.count(), 1);
        assert.equal(await db.seat.count(), 24);
        const learnerIdentity = { studentId: 'dual-role-001', name: '双身份学员', groupId: group.id, passwordHash: 'test-hash' };
        await db.user.create({ data: { ...learnerIdentity, id: 'dual-role-learner', email: 'dual-role-001+user@student.local', role: 'USER' } });
        await db.user.create({ data: { ...learnerIdentity, id: 'dual-role-admin', email: 'dual-role-001+admin@student.local', role: 'ADMIN' } });
        assert.deepEqual(await db.user.findMany({ where: { studentId: learnerIdentity.studentId }, select: { role: true }, orderBy: { role: 'asc' } }), [{ role: 'USER' }, { role: 'ADMIN' }]);
        await assert.rejects(db.user.create({ data: { ...learnerIdentity, id: 'duplicate-learner', email: 'duplicate+user@student.local', role: 'USER' } }), { code: 'P2002' });
        assert.ok(await db.$queryRaw<{ count: bigint }[]>`SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`.then(r => Number(r[0].count)) >= 7);
    } finally {
        await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await db.$disconnect();
    }
});
