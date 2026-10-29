import { PrismaClient } from '@prisma/client';
import { hash } from 'bcryptjs';
const db = new PrismaClient();
async function main() {
    const adminStudentId = process.env.ADMIN_STUDENT_ID?.trim().toLowerCase();
    const adminPassword = process.env.ADMIN_PASSWORD;
    const adminName = process.env.ADMIN_NAME?.trim() || '空间管理员';
    const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase() || `${adminStudentId}@admin.local`;
    if (!adminStudentId || !/^[a-z0-9]{3,30}$/.test(adminStudentId))
        throw new Error('请设置 3-30 位字母数字组成的 ADMIN_STUDENT_ID');
    if (!adminPassword || adminPassword.length < 10)
        throw new Error('请设置至少 10 位的 ADMIN_PASSWORD 环境变量');
    const ysyxGroup = await db.group.upsert({ where: { name: '一生一芯成员' }, update: { canReserve: true }, create: { id: 'seed-group', name: '一生一芯成员', canReserve: true, weeklyRules: { create: Array.from({ length: 7 }, (_, weekday) => ({ weekday, startMinute: 0, endMinute: 1440 })) } } });
    await db.group.upsert({ where: { name: 'ICIL成员' }, update: { canReserve: true }, create: { id: 'seed-icil-group', name: 'ICIL成员', canReserve: true, weeklyRules: { create: Array.from({ length: 7 }, (_, weekday) => ({ weekday, startMinute: 0, endMinute: 1440 })) } } });
    await db.appSetting.upsert({ where: { id: 'main' }, update: {}, create: { id: 'main', defaultGroupId: ysyxGroup.id } });
    const passwordHash = await hash(adminPassword, 12);
    const adminData = { name: adminName, studentId: adminStudentId, email: adminEmail, role: 'ADMIN' as const, memberType: 'YSYX' as const, groupId: ysyxGroup.id, passwordHash, enabled: true, deletedAt: null };
    const existingAdmin = await db.user.findUnique({ where: { studentId_role: { studentId: adminStudentId, role: 'ADMIN' } } });
    if (existingAdmin)
        await db.user.update({ where: { id: existingAdmin.id }, data: adminData });
    else {
        const legacySeedAdmin = await db.user.findUnique({ where: { id: 'seed-admin' } });
        if (legacySeedAdmin?.role === 'ADMIN')
            await db.user.update({ where: { id: legacySeedAdmin.id }, data: adminData });
        else
            await db.user.create({ data: { id: 'seed-admin', ...adminData } });
    }
    await db.user.updateMany({ where: { id: { in: ['seed-assistant', 'seed-learner'] }, deletedAt: null }, data: { enabled: false, deletedAt: new Date() } });
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
    console.log(`初始化完成：管理员 ${adminStudentId}、23 个可预约工位。一生一芯成员必须等待助教保障后才能预约。`);
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => db.$disconnect());
