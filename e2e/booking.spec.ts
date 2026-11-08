import { test, expect, type Page } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { randomUUID, createHash } from 'node:crypto';
import { localParts } from '../src/lib/rules';

const db = new PrismaClient();
const adminStudentId = process.env.ADMIN_STUDENT_ID!.trim().toLowerCase();
const adminPassword = process.env.ADMIN_PASSWORD!;
test.beforeAll(async () => {
    await db.loginAttempt.deleteMany({ where: { key: `auth/login:${createHash('sha256').update(adminStudentId).digest('hex')}` } });
});

async function loginStudent(page: Page, studentId: string, studentPassword: string) {
    await page.goto('/login');
    await page.getByLabel('学号').fill(studentId);
    await page.getByLabel('密码').fill(studentPassword);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: /找到你的好位置/ })).toBeVisible();
}

async function loginAdmin(page: Page, studentId = adminStudentId) {
    await page.goto('/login');
    await page.getByLabel('学号').fill(studentId);
    await page.getByLabel('密码').fill(adminPassword);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: /空间管理概览/ })).toBeVisible();
}

test('ICIL无需预建时段即可预约；所有角色共用登录页且没有打卡', async ({ browser, baseURL }) => {
    const suffix = randomUUID().slice(0, 8);
    const studentId = `e2e${suffix}`;
    const studentPassword = 'Booking-Password-2026!';
    let learnerId = '';
    const venue = await db.venue.create({ data: { name: `浏览器验收 ${suffix}`, location: '测试场地' } });
    const layout = await db.layoutVersion.create({ data: { name: `浏览器布局 ${suffix}`, venueId: venue.id, status: 'PUBLISHED', publishedAt: new Date(), seats: { create: [{ code: 'A01', x: 100, y: 100 }, { code: 'A02', x: 200, y: 100 }, { code: 'STAFF', x: 300, y: 100, fixedForAssistant: true }] } }, include: { seats: true } });
    const tomorrow = localParts(new Date(Date.now() + 86400000)).date;
    const slotStart = new Date(`${tomorrow}T09:00:00+08:00`);
    const slotEnd = new Date(slotStart.getTime() + 1800000);
    const nextSlotEnd = new Date(slotEnd.getTime() + 1800000);
    const date = slotStart.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    const adminContext = await browser.newContext({ baseURL });
    const learnerContext = await browser.newContext({ baseURL });
    const admin = await adminContext.newPage();
    const learner = await learnerContext.newPage();
    try {
        await loginAdmin(admin);
        const learnerSeat = layout.seats.find(s => s.enabled && !s.fixedForAssistant)!;
        await learner.goto('/register');
        await learner.getByLabel('昵称').fill('端到端学员');
        await learner.getByLabel('学号').fill(studentId);
        await learner.getByLabel('密码').fill(studentPassword);
        await learner.getByRole('button', { name: '注册成员账号' }).click();
        await expect(learner.getByRole('heading', { name: /找到你的好位置/ })).toBeVisible();
        learnerId = (await db.user.findUniqueOrThrow({ where: { studentId_role: { studentId, role: 'USER' } } })).id;
        await db.user.update({ where: { id: learnerId }, data: { memberType: 'ICIL' } });
        await learner.getByRole('button', { name: '退出登录并返回入口', exact: true }).click();
        await expect(learner.getByRole('heading', { name: '登录预约空间。' })).toBeVisible();
        await loginStudent(learner, studentId, studentPassword);
        const time = (value: Date) => value.toLocaleTimeString('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit' });
        await learner.getByRole('button', { name: `选择日期 ${date}`, exact: true }).click();
        await learner.getByLabel('场地', { exact: true }).selectOption(`icil-${venue.id}-${date}`);
        await learner.getByRole('button', { name: `${time(slotStart)} 至 ${time(slotEnd)}，可预约`, exact: true }).click();
        await learner.getByRole('button', { name: `${time(slotEnd)} 至 ${time(nextSlotEnd)}，可预约`, exact: true }).click();
        await learner.getByRole('button', { name: `座位 ${learnerSeat.code}，可预约`, exact: true }).click();
        await learner.getByRole('button', { name: '预约所选时间', exact: true }).click();
        await learner.getByRole('button', { name: '确认，预约这个工位', exact: true }).click();
        await expect(learner.getByRole('status')).toContainText('已预约 2 个半小时段');
        await learner.goto('/my-reservations');
        await expect(learner.locator('.record-card')).toContainText(learnerSeat.code);
        await expect(learner.getByText(/打卡/)).toHaveCount(0);
        await admin.goto('/admin/reservations');
        await expect(admin.locator('table')).toContainText(studentId);
        const download = admin.waitForEvent('download');
        await admin.getByRole('link', { name: '导出 CSV' }).click();
        expect((await download).suggestedFilename()).toBe('reservations.csv');
    } finally {
        await Promise.allSettled([admin.request.post('/api/auth/logout'), learner.request.post('/api/auth/logout')]);
        await Promise.allSettled([adminContext.close(), learnerContext.close()]);
        const records = await db.reservation.findMany({ where: { session: { layoutId: layout.id } }, select: { id: true } });
        await db.auditLog.deleteMany({ where: { target: { in: records.map(r => r.id) } } });
        await db.reservation.deleteMany({ where: { session: { layoutId: layout.id } } });
        await db.session.deleteMany({ where: { layoutId: layout.id } });
        await db.layoutVersion.delete({ where: { id: layout.id } });
        await db.venue.delete({ where: { id: venue.id } });
        if (learnerId) {
            await db.auditLog.deleteMany({ where: { actorId: learnerId } });
            await db.reservation.deleteMany({ where: { userId: learnerId } });
            await db.user.delete({ where: { id: learnerId } });
        }
        await db.loginAttempt.deleteMany({ where: { key: { in: ['auth/login', 'auth/register'].map(key => `${key}:${createHash('sha256').update(studentId).digest('hex')}`) } } });
    }
});

test('管理员创建布局、添加座位、发布后锁定编辑', async ({ page }) => {
    const suffix = randomUUID().slice(0, 8);
    const venue = await db.venue.create({ data: { name: `布局验收 ${suffix}`, location: '测试场地' } });
    let id = '';
    try {
        await loginAdmin(page);
        await page.goto('/admin/layouts');
        await page.getByRole('button', { name: '新布局', exact: true }).click();
        await page.getByLabel('布局名称').fill(`测试布局 ${suffix}`);
        await page.getByRole('dialog').getByRole('combobox').selectOption(venue.id);
        await page.getByRole('button', { name: '创建', exact: true }).click();
        await expect(page.getByRole('status')).toContainText('创建成功');
        id = (await db.layoutVersion.findFirstOrThrow({ where: { name: `测试布局 ${suffix}` } })).id;
        await page.getByRole('button', { name: '桌子', exact: true }).click();
        await page.getByRole('button', { name: '座位', exact: true }).click();
        await page.getByLabel(/座位编号/).fill('T01');
        await page.getByRole('button', { name: /^保存(?: \*)?$/, exact: true }).click();
        await expect(page.getByRole('status')).toContainText('草稿已保存');
        page.once('dialog', d => d.accept());
        await page.getByRole('button', { name: '保存并发布' }).click();
        await expect(page.getByRole('status')).toContainText('布局已发布');
        expect((await page.request.put(`/api/layouts/${id}`, { data: { name: 'locked', width: 1000, height: 660, elements: [], seats: [] } })).status()).toBe(409);
    } finally {
        await page.request.post('/api/auth/logout').catch(() => {});
        if (id) {
            await db.auditLog.deleteMany({ where: { target: id } });
            await db.session.deleteMany({ where: { layoutId: id } });
            await db.layoutVersion.delete({ where: { id } });
        }
        await db.venue.delete({ where: { id: venue.id } });
    }
});

test('统一登录后管理员可设置禁止预约时间，旧的创建时段接口已移除', async ({ playwright, baseURL }) => {
    const guest = await playwright.request.newContext({ baseURL });
    const admin = await playwright.request.newContext({ baseURL });
    let blockId = '';
    try {
        expect((await guest.get('/api/admin/booking-blocks')).status()).toBe(401);
        expect((await admin.post('/api/auth/login', { data: { studentId: adminStudentId, password: 'wrong' } })).status()).toBe(401);
        expect((await admin.post('/api/auth/login', { data: { studentId: adminStudentId, password: adminPassword } })).ok()).toBeTruthy();
        const startsAt = new Date(Date.now() + 3 * 86400000), endsAt = new Date(startsAt.getTime() + 3600000);
        const created = await admin.post('/api/admin/booking-blocks', { data: { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), reason: '浏览器测试维护' } });
        expect(created.ok()).toBeTruthy(); blockId = (await created.json()).block.id;
        expect((await admin.post('/api/sessions', { data: {} })).status()).toBe(404);
    } finally {
        if (blockId) {
            await db.auditLog.deleteMany({ where: { target: blockId } });
            await db.bookingBlock.delete({ where: { id: blockId } });
        }
        await admin.post('/api/auth/logout');
        await Promise.all([guest.dispose(), admin.dispose()]);
    }
});

test.afterAll(async () => {
    await db.loginAttempt.deleteMany({ where: { key: `auth/login:${createHash('sha256').update(adminStudentId).digest('hex')}` } });
    await db.$disconnect();
});
