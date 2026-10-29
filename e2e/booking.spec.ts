import { test, expect, type Page } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { randomUUID, createHash } from 'node:crypto';

const db = new PrismaClient();
const adminStudentId = process.env.ADMIN_STUDENT_ID ?? 'admin001';
const adminPassword = process.env.ADMIN_PASSWORD ?? '';
test.beforeAll(async () => {
    await db.loginAttempt.deleteMany({ where: { key: `auth/login:ADMIN:${createHash('sha256').update(adminStudentId).digest('hex')}` } });
});

async function loginStudent(page: Page, studentId: string, studentPassword: string) {
    await page.goto('/login?mode=student');
    await page.getByLabel('学号').fill(studentId);
    await page.getByLabel('密码').fill(studentPassword);
    await page.getByRole('button', { name: '进入学员预约' }).click();
    await expect(page.getByRole('heading', { name: /找到你的好位置/ })).toBeVisible();
}

async function loginAdmin(page: Page, studentId = adminStudentId) {
    await page.goto('/login?mode=admin');
    await page.getByLabel('学号').fill(studentId);
    await page.getByLabel('密码').fill(adminPassword);
    await page.getByRole('button', { name: '进入管理员后台' }).click();
    await expect(page.getByRole('heading', { name: /空间管理概览/ })).toBeVisible();
}

test('学号注册、登录、管理员开放场次、学员预约与后台 CSV 导出', async ({ browser, baseURL }) => {
    const suffix = randomUUID().slice(0, 8);
    const studentId = `e2e${suffix}`;
    const studentPassword = 'Booking-Password-2026!';
    let learnerId = '';
    const venue = await db.venue.create({ data: { name: `浏览器验收 ${suffix}`, location: '测试场地' } });
    const layout = await db.layoutVersion.create({ data: { name: `浏览器布局 ${suffix}`, venueId: venue.id, status: 'PUBLISHED', publishedAt: new Date(), seats: { create: [{ code: 'A01', x: 100, y: 100 }, { code: 'A02', x: 200, y: 100 }, { code: 'STAFF', x: 300, y: 100, fixedForAssistant: true }] } }, include: { seats: true } });
    const startsAt = new Date(Math.ceil(Date.now() / 60000) * 60000 + 67 * 60000);
    const endsAt = new Date(startsAt.getTime() + 37 * 60000);
    const session = await db.session.create({ data: { layoutId: layout.id, startsAt, endsAt, requiredAssistants: 1, open: false } });
    const adminContext = await browser.newContext({ baseURL });
    const learnerContext = await browser.newContext({ baseURL });
    const admin = await adminContext.newPage();
    const learner = await learnerContext.newPage();
    try {
        await loginAdmin(admin);
        const staff = layout.seats.find(s => s.fixedForAssistant) ?? layout.seats[0];
        const learnerSeat = layout.seats.find(s => s.enabled && !s.fixedForAssistant && s.id !== staff.id)!;
        await admin.goto('/admin/sessions');
        const sessionRow = admin.getByRole('row').filter({ hasText: layout.name });
        await sessionRow.getByRole('button', { name: '选择工位', exact: true }).click();
        await admin.getByRole('dialog').getByRole('button', { name: `座位 ${staff.code}，助教专用工位，可预约`, exact: true }).click();
        await admin.getByRole('button', { name: '预约选中工位', exact: true }).click();
        await expect(admin.getByRole('status')).toContainText('管理员工位已更新');
        await sessionRow.getByRole('button', { name: '开放此时间', exact: true }).click();
        await expect(admin.getByRole('status')).toContainText('已开放此时间');
        await learner.goto('/register?mode=student');
        await learner.getByLabel('昵称').fill('端到端学员');
        await learner.getByLabel('学号').fill(studentId);
        await learner.getByLabel('密码').fill(studentPassword);
        await learner.getByRole('button', { name: '注册成员账号' }).click();
        await expect(learner.getByRole('heading', { name: /找到你的好位置/ })).toBeVisible();
        learnerId = (await db.user.findUniqueOrThrow({ where: { studentId_role: { studentId, role: 'USER' } } })).id;
        await learner.getByRole('button', { name: '退出登录并返回入口', exact: true }).click();
        await expect(learner.getByRole('heading', { name: '先选择你的入口。' })).toBeVisible();
        await loginStudent(learner, studentId, studentPassword);
        const date = startsAt.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
        const time = (value: Date) => value.toLocaleTimeString('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit' });
        await learner.getByRole('button', { name: `选择日期 ${date}`, exact: true }).click();
        await learner.getByRole('button', { name: `选择时间段 ${time(startsAt)} 至 ${time(endsAt)}`, exact: true }).click();
        await learner.getByRole('button', { name: `座位 ${learnerSeat.code}，可预约`, exact: true }).click();
        await learner.getByRole('button', { name: '确认预约', exact: true }).click();
        await learner.getByRole('button', { name: '确认，预约这个工位', exact: true }).click();
        await expect(learner.getByRole('status')).toContainText('预约成功');
        await learner.goto('/my-reservations');
        await expect(learner.locator('.record-card')).toContainText(learnerSeat.code);
        await admin.goto('/admin/reservations');
        await admin.getByLabel('筛选预约时段').selectOption(session.id);
        await expect(admin.locator('table')).toContainText(studentId);
        const download = admin.waitForEvent('download');
        await admin.getByRole('link', { name: '导出 CSV' }).click();
        expect((await download).suggestedFilename()).toBe('reservations.csv');
    } finally {
        await Promise.allSettled([adminContext.close(), learnerContext.close()]);
        const records = await db.reservation.findMany({ where: { sessionId: session.id }, select: { id: true } });
        await db.auditLog.deleteMany({ where: { target: { in: [session.id, ...records.map(r => r.id)] } } });
        await db.reservation.deleteMany({ where: { sessionId: session.id } });
        await db.sessionAdminBooking.deleteMany({ where: { sessionId: session.id } });
        await db.assistantCoverage.deleteMany({ where: { sessionId: session.id } });
        await db.session.delete({ where: { id: session.id } });
        await db.layoutVersion.delete({ where: { id: layout.id } });
        await db.venue.delete({ where: { id: venue.id } });
        if (learnerId) {
            await db.auditLog.deleteMany({ where: { actorId: learnerId } });
            await db.user.delete({ where: { id: learnerId } });
        }
    }
});

test('管理员创建布局、添加座位、发布后锁定编辑', async ({ page }) => {
    const suffix = randomUUID().slice(0, 8);
    let id = '';
    await loginAdmin(page);
    try {
        await page.goto('/admin/layouts');
        await page.getByRole('button', { name: '新布局', exact: true }).click();
        await page.getByLabel('布局名称').fill(`测试布局 ${suffix}`);
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
        if (id) {
            await db.auditLog.deleteMany({ where: { target: id } });
            await db.layoutVersion.delete({ where: { id } });
        }
    }
});

test('学员无权访问后台，管理员登录可创建场次', async ({ playwright, baseURL }) => {
    const learner = await playwright.request.newContext({ baseURL });
    const admin = await playwright.request.newContext({ baseURL });
    const suffix = randomUUID().slice(0, 8);
    let sessionId = '';
    try {
        expect((await learner.get('/api/admin/users')).status()).toBe(401);
        expect((await admin.post('/api/auth/login', { data: { studentId: adminStudentId, role: 'ADMIN', password: 'wrong' } })).status()).toBe(401);
        expect((await admin.post('/api/auth/login', { data: { studentId: adminStudentId, role: 'ADMIN', password: adminPassword } })).ok()).toBeTruthy();
        const startsAt = new Date(Date.now() + 3 * 3600000);
        const endsAt = new Date(startsAt.getTime() + 3600000);
        const created = await admin.post('/api/sessions', { data: { layoutId: 'seed-layout', startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), requiredAssistants: 1, open: false } });
        expect(created.ok()).toBeTruthy(); sessionId = (await created.json()).session.id;
        expect((await learner.post('/api/reservations/coverage', { data: { sessionId } })).status()).toBe(401);
    } finally {
        if (sessionId) await db.session.delete({ where: { id: sessionId } });
        await Promise.all([learner.dispose(), admin.dispose()]);
    }
});

test.afterAll(() => db.$disconnect());
