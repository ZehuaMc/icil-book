import { PrismaClient } from '@prisma/client';
import { hash } from 'bcryptjs';
const db = new PrismaClient();
async function main() {
    const password = process.env.SEED_PASSWORD;
    if (!password || password.length < 10)
        throw new Error('请设置至少 10 位的 SEED_PASSWORD 环境变量');
    const group = await db.group.upsert({ where: { name: '普通学员' }, update: {}, create: { id: 'seed-group', name: '普通学员', canReserve: true, weeklyRules: { create: Array.from({ length: 7 }, (_, weekday) => ({ weekday, startMinute: 0, endMinute: 1440 })) } } });
    await db.appSetting.upsert({ where: { id: 'main' }, update: {}, create: { id: 'main', defaultGroupId: group.id } });
    const passwordHash = await hash(password, 12);
    for (const u of [{ id: 'seed-admin', name: '空间管理员', studentId: 'admin001', email: 'admin@station.local', role: 'ADMIN' as const }, { id: 'seed-assistant', name: '陈助教', studentId: 'assistant001', email: 'assistant@station.local', role: 'ADMIN' as const }, { id: 'seed-learner', name: '林同学', studentId: 'student001', email: 'learner@station.local', role: 'USER' as const }]) {
        await db.user.upsert({ where: { email: u.email }, update: { role: u.role }, create: { ...u, groupId: group.id, passwordHash } });
    }
    await db.venue.upsert({ where: { id: 'seed-venue' }, update: { name: '人工智能与低空技术学院', location: '人工智能与低空技术学院' }, create: { id: 'seed-venue', name: '人工智能与低空技术学院', location: '人工智能与低空技术学院' } });
    // Never mutate an existing published layout or its bound sessions on repeated seeds.
    if (!await db.layoutVersion.findUnique({ where: { id: 'seed-layout' } }))
        await db.$transaction(async (tx) => {
            await tx.layoutVersion.create({ data: { id: 'seed-layout', venueId: 'seed-venue', name: '共享学习区 · V1', status: 'PUBLISHED', publishedAt: new Date() } });
            await tx.layoutElement.create({ data: { id: 'seed-podium', layoutId: 'seed-layout', kind: 'LABEL', label: '讲 台 / TEACHING AREA', x: 340, y: 55, width: 320, height: 45 } });
            for (let row = 0; row < 2; row++)
                for (let col = 0; col < 3; col++) {
                    const x = 110 + col * 290, y = 205 + row * 220, code = String.fromCharCode(65 + col);
                    const element = await tx.layoutElement.create({ data: { id: `seed-desk-${row}-${col}`, layoutId: 'seed-layout', kind: col === 2 ? 'BOOTH' : 'DESK', label: `${code} 区 · ${row + 1}`, x, y, width: 200, height: 76 } });
                    for (let n = 0; n < 4; n++)
                        await tx.seat.create({ data: { id: `seed-seat-${code}${row * 4 + n + 1}`, layoutId: 'seed-layout', elementId: element.id, code: `${code}${String(row * 4 + n + 1).padStart(2, '0')}`, x: x + 28 + (n % 2) * 100, y: y + (n < 2 ? -58 : 90), rotation: 0, enabled: !(col === 2 && row === 1 && n === 3) } });
                }
        });
    console.log('初始化完成：管理员和学员账号、23 个可预约工位。管理员创建并开放未来时段后，学员才能预约。账号密码来自 SEED_PASSWORD。');
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => db.$disconnect());
