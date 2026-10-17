import { PrismaClient } from '@prisma/client';
import { hash } from 'bcryptjs';
import { localParts } from '../src/lib/rules';
const db = new PrismaClient();
async function main() {
    const password = process.env.SEED_PASSWORD;
    if (!password || password.length < 10)
        throw new Error('请设置至少 10 位的 SEED_PASSWORD 环境变量');
    const group = await db.group.upsert({ where: { name: '普通学员' }, update: {}, create: { id: 'seed-group', name: '普通学员', canReserve: true, weeklyRules: { create: Array.from({ length: 7 }, (_, weekday) => ({ weekday, startMinute: 480, endMinute: 1320 })) } } });
    await db.appSetting.upsert({ where: { id: 'main' }, update: {}, create: { id: 'main', defaultGroupId: group.id } });
    const passwordHash = await hash(password, 12);
    for (const u of [{ id: 'seed-admin', name: '空间管理员', email: 'admin@station.local', role: 'ADMIN' as const }, { id: 'seed-assistant', name: '陈助教', email: 'assistant@station.local', role: 'ASSISTANT' as const }, { id: 'seed-learner', name: '林同学', email: 'learner@station.local', role: 'USER' as const }]) {
        await db.user.upsert({ where: { email: u.email }, update: {}, create: { ...u, groupId: group.id, passwordHash } });
    }
    await db.venue.upsert({ where: { id: 'seed-venue' }, update: {}, create: { id: 'seed-venue', name: '创客教学空间', location: '实践楼 3F · 301 室' } });
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
    const courses = [{ id: 'seed-course-1', name: '嵌入式系统实践', instructor: '张老师', description: '从基础电路到系统设计，在实践中发现硬件的无限可能。' }, { id: 'seed-course-2', name: '数字逻辑与 FPGA 设计', instructor: '李老师', description: '用逻辑搭建创意，用硬件实现想象。' }, { id: 'seed-course-3', name: '开放实验 · 自主探索', instructor: '王老师', description: '为你的项目留一段专注探索的时间。' }];
    for (const c of courses)
        await db.course.upsert({ where: { id: c.id }, update: {}, create: c });
    const assistant = await db.user.findUniqueOrThrow({ where: { email: 'assistant@station.local' } });
    for (let day = 1; day <= 7; day++) {
        const base = new Date(Date.now() + day * 86400000), date = localParts(base).date;
        for (let n = 0; n < 3; n++) {
            const time = [['09:00', '11:00'], ['14:00', '16:00'], ['18:30', '20:30']][n];
            const sessionId = `seed-session-${date}-${n}`;
            // Existing sessions and manually removed coverage must survive a repeated seed.
            if (await db.session.findUnique({ where: { id: sessionId } }))
                continue;
            const session = await db.session.create({ data: { id: sessionId, courseId: courses[n].id, layoutId: 'seed-layout', startsAt: new Date(`${date}T${time[0]}:00+08:00`), endsAt: new Date(`${date}T${time[1]}:00+08:00`), requiredAssistants: 1 } });
            if (n === 0 && assistant.enabled && assistant.role === 'ASSISTANT')
                await db.assistantCoverage.upsert({ where: { sessionId_assistantId: { sessionId: session.id, assistantId: assistant.id } }, update: {}, create: { sessionId: session.id, assistantId: assistant.id } });
        }
    }
    console.log('初始化完成：3 个角色账号、23 个可预约工位、未来 7 天课程。账号密码来自 SEED_PASSWORD。');
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => db.$disconnect());
