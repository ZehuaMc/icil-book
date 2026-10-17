import { test, expect, type Page } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
const db = new PrismaClient();
const password = process.env.SEED_PASSWORD ?? '';
test.beforeAll(async () => {
    const keys = ['admin', 'assistant', 'learner'].map(name => `auth/login:${createHash('sha256').update(`${name}@station.local`).digest('hex')}`);
    await db.loginAttempt.deleteMany({ where: { key: { in: keys } } });
});
async function login(page: Page, email: string) {
    await page.goto('/login');
    await page.getByLabel('邮箱').fill(email);
    await page.getByLabel('密码').fill(password);
    await page.getByRole('button', { name: '登录空间' }).click();
    await expect(page.getByRole('heading', { name: /找到你的好位置/ })).toBeVisible();
}
test('注册 → 登录 → 助教保障 → 学员选座 → 管理员查看与导出', async ({ browser, baseURL }) => {
    const suffix = Date.now().toString(), email = `e2e-${suffix}@example.test`, courseId = `e2e-course-${suffix}`, sessionId = `e2e-session-${suffix}`;
    const layout = await db.layoutVersion.findUniqueOrThrow({ where: { id: 'seed-layout' } });
    const day = new Date(Date.now() + 30 * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    await db.course.create({ data: { id: courseId, name: `端到端实践 ${suffix}`, instructor: '测试教师' } });
    await db.session.create({ data: { id: sessionId, courseId, layoutId: layout.id, startsAt: new Date(`${day}T09:00:00+08:00`), endsAt: new Date(`${day}T11:00:00+08:00`) } });
    const learnerContext = await browser.newContext({ baseURL }), assistantContext = await browser.newContext({ baseURL }), adminContext = await browser.newContext({ baseURL });
    const learner = await learnerContext.newPage(), assistant = await assistantContext.newPage(), admin = await adminContext.newPage();
    try {
        await learner.goto('/register');
        await learner.getByLabel('姓名').fill(`测试学员${suffix}`);
        await learner.getByLabel('邮箱').fill(email);
        await learner.getByLabel('密码').fill(password);
        await learner.getByRole('button', { name: '创建账号' }).click();
        await expect(learner.getByRole('heading', { name: /找到你的好位置/ })).toBeVisible();
        await learner.getByRole('button', { name: '退出登录' }).click();
        await login(learner, email);
        await learner.getByRole('button', { name: `选择日期 ${day}`, exact: true }).click();
        await expect(learner.getByText('等待助教完成现场保障登记')).toBeVisible();
        await expect(learner.getByRole('button', { name: '确认预约', exact: true })).toBeDisabled();
        await login(assistant, 'assistant@station.local');
        await assistant.getByRole('link', { name: '助教保障', exact: true }).click();
        await assistant.locator('.record-card').filter({ hasText: `端到端实践 ${suffix}` }).getByRole('button', { name: '登记现场保障' }).click();
        await expect(assistant.getByRole('status')).toContainText('登记成功');
        await learner.reload();
        await learner.getByRole('button', { name: `选择日期 ${day}`, exact: true }).click();
        await learner.getByRole('button', { name: '座位 A01，可预约', exact: true }).click();
        await learner.getByRole('button', { name: '确认预约', exact: true }).click();
        await learner.getByRole('button', { name: '确认，预约这个工位' }).click();
        await expect(learner.getByRole('status')).toContainText('预约成功');
        await learner.getByRole('link', { name: '查看我的预约' }).click();
        await expect(learner.locator('.record-card').filter({ hasText: `端到端实践 ${suffix}` })).toContainText('A01');
        await login(admin, 'admin@station.local');
        await admin.getByRole('link', { name: '预约记录', exact: true }).click();
        await admin.getByLabel('筛选场次').selectOption(sessionId);
        await expect(admin.locator('table').first()).toContainText(email);
        const download = admin.waitForEvent('download');
        await admin.getByRole('link', { name: '导出 CSV' }).click();
        expect((await download).suggestedFilename()).toBe('reservations.csv');
        const forbidden = await learner.request.get('/api/admin/users');
        expect(forbidden.status()).toBe(403);
        await assistant.reload();
        await expect(assistant.locator('.record-card').filter({ hasText: `端到端实践 ${suffix}` }).getByRole('button')).toBeDisabled();
    }
    finally {
        await Promise.all([learnerContext.close(), assistantContext.close(), adminContext.close()]);
        const user = await db.user.findUnique({ where: { email } });
        const reservations = await db.reservation.findMany({ where: { sessionId } });
        const coverages = await db.assistantCoverage.findMany({ where: { sessionId } });
        await db.auditLog.deleteMany({ where: { OR: [{ actorId: user?.id ?? '' }, { target: { in: [sessionId, ...reservations.map(r => r.id), ...coverages.map(c => c.id)] } }] } });
        await db.reservation.deleteMany({ where: { sessionId } });
        await db.assistantCoverage.deleteMany({ where: { sessionId } });
        await db.session.delete({ where: { id: sessionId } });
        await db.course.delete({ where: { id: courseId } });
        if (user)
            await db.user.delete({ where: { id: user.id } });
    }
});
test('管理员编辑布局、发布与场次绑定，已发布版本不可修改', async ({ page }) => {
    const suffix = Date.now().toString();
    let id = '', courseId = '', sessionId = '';
    await login(page, 'admin@station.local');
    try {
        await page.getByRole('link', { name: '场地与布局' }).click();
        await page.getByRole('button', { name: '新布局', exact: true }).click();
        await page.getByLabel('布局名称').fill(`测试布局 ${suffix}`);
        await page.getByRole('button', { name: '创建', exact: true }).click();
        await expect(page.getByRole('status')).toContainText('创建成功');
        id = (await db.layoutVersion.findFirstOrThrow({ where: { name: `测试布局 ${suffix}` } })).id;
        await page.getByRole('button', { name: '桌子', exact: true }).click();
        await page.getByRole('button', { name: '座位', exact: true }).click();
        await page.getByLabel('座位编号', { exact: true }).fill('T01');
        await page.getByRole('button', { name: /^保存(?: \*)?$/, exact: true }).click();
        await expect(page.getByRole('status')).toContainText('草稿已保存');
        page.once('dialog', d => d.accept());
        await page.getByRole('button', { name: '保存并发布' }).click();
        await expect(page.getByRole('status')).toContainText('布局已发布');
        const locked = await page.request.put(`/api/layouts/${id}`, { data: { name: 'illegal', width: 1000, height: 660, elements: [], seats: [] } });
        expect(locked.status()).toBe(409);
        const course = await db.course.create({ data: { name: `布局绑定 ${suffix}`, instructor: '测试教师' } });
        courseId = course.id;
        const date = new Date(Date.now() + 40 * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
        const result = await page.request.post('/api/sessions', { data: { courseId, layoutId: id, startsAt: `${date}T09:00:00+08:00`, endsAt: `${date}T11:00:00+08:00`, requiredAssistants: 1, open: true } });
        expect(result.ok()).toBeTruthy();
        sessionId = (await result.json()).session.id;
        expect((await db.session.findUniqueOrThrow({ where: { id: sessionId } })).layoutId).toBe(id);
    }
    finally {
        if (sessionId)
            await db.session.delete({ where: { id: sessionId } });
        if (courseId)
            await db.course.delete({ where: { id: courseId } });
        if (id)
            await db.layoutVersion.delete({ where: { id } });
        await db.auditLog.deleteMany({ where: { target: { in: [id, sessionId] } } });
    }
});
test.afterAll(() => db.$disconnect());

test('接口权限、默认分组、日期覆盖、账号停用及退出会话', async ({ playwright, baseURL }) => {
    const admin = await playwright.request.newContext({ baseURL });
    const learner = await playwright.request.newContext({ baseURL });
    const assistant = await playwright.request.newContext({ baseURL });
    const suffix = Date.now().toString(), email = `api-${suffix}@example.test`;
    let groupId = '', userId = '', courseId = '', sessionId = '';
    let previousDefault = '';
    try {
        expect((await learner.get('/api/admin/users')).status()).toBe(401);
        expect((await admin.post('/api/auth/login', { data: { email: 'admin@station.local', password: 'definitely-wrong' } })).status()).toBe(401);
        expect((await admin.post('/api/auth/login', { data: { email: 'admin@station.local', password } })).ok()).toBeTruthy();
        const groups = await (await admin.get('/api/groups')).json();
        previousDefault = groups.settings.defaultGroupId;
        const day = new Date(Date.now() + 50 * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
        const rule = { name: `接口测试分组 ${suffix}`, canReserve: true, isDefault: true, weeklyRules: Array.from({ length: 7 }, (_, weekday) => ({ weekday, startMinute: 0, endMinute: 1440 })), dateRules: [{ date: day, allowed: false, startMinute: 0, endMinute: 1440 }] };
        const createdGroup = await admin.post('/api/groups', { data: rule });
        expect(createdGroup.ok()).toBeTruthy(); groupId = (await createdGroup.json()).group.id;
        expect((await learner.post('/api/auth/register', { data: { name: '接口测试学员', email, password: 'short' } })).status()).toBe(400);
        const registration = await learner.post('/api/auth/register', { data: { name: '接口测试学员', email, password, role: 'ADMIN', enabled: true } });
        expect(registration.ok()).toBeTruthy();
        const registered = (await registration.json()).user; userId = registered.id;
        expect(registered.groupId).toBe(groupId); expect(registered.role).toBe('USER'); expect(registered.passwordHash).toBeUndefined();
        expect((await learner.get('/api/admin/users')).status()).toBe(403);
        expect((await learner.post('/api/groups', { data: rule })).status()).toBe(403);
        const course = await admin.post('/api/admin/courses', { data: { name: `接口规则测试 ${suffix}`, instructor: '测试教师' } });
        expect(course.ok()).toBeTruthy(); courseId = (await course.json()).course.id;
        const input = { courseId, layoutId: 'seed-layout', startsAt: `${day}T09:00:00+08:00`, endsAt: `${day}T11:00:00+08:00`, requiredAssistants: 1, open: true };
        const createdSession = await admin.post('/api/sessions', { data: input });
        expect(createdSession.ok()).toBeTruthy(); sessionId = (await createdSession.json()).session.id;
        expect((await admin.put(`/api/sessions/${sessionId}`, { data: { ...input, startsAt: '2020-01-01T09:00:00+08:00', endsAt: '2020-01-01T11:00:00+08:00' } })).status()).toBe(400);
        expect((await admin.post('/api/sessions', { data: input })).status()).toBe(409);
        expect((await admin.post('/api/reservations/coverage', { data: { sessionId } })).status()).toBe(403);
        const seats = await db.seat.findMany({ where: { layoutId: 'seed-layout', enabled: true }, orderBy: { code: 'asc' } });
        expect((await learner.post('/api/reservations', { data: { sessionId, seatId: seats[0].id } })).status()).toBe(400);
        expect((await assistant.post('/api/auth/login', { data: { email: 'assistant@station.local', password } })).ok()).toBeTruthy();
        expect((await assistant.post('/api/reservations/coverage', { data: { sessionId } })).ok()).toBeTruthy();
        // Date closure wins even with staff and all seven weekly permission windows.
        expect((await learner.post('/api/reservations', { data: { sessionId, seatId: seats[0].id } })).status()).toBe(403);
        expect((await admin.put(`/api/groups/${groupId}`, { data: { ...rule, dateRules: [{ date: day, allowed: true, startMinute: 540, endMinute: 660 }] } })).ok()).toBeTruthy();
        const booking = await learner.post('/api/reservations', { data: { sessionId, seatId: seats[0].id } });
        expect(booking.ok()).toBeTruthy(); const reservationId = (await booking.json()).reservation.id;
        expect((await learner.post('/api/reservations', { data: { sessionId, seatId: seats[1].id } })).status()).toBe(409);
        expect((await admin.put(`/api/sessions/${sessionId}`, { data: { ...input, requiredAssistants: 2 } })).status()).toBe(400);
        expect((await learner.delete(`/api/reservations/${reservationId}`)).ok()).toBeTruthy();
        expect((await admin.patch(`/api/admin/users/${userId}`, { data: { name: registered.name, role: 'USER', groupId, enabled: false } })).ok()).toBeTruthy();
        expect((await learner.get('/api/auth/me')).status()).toBe(200);
        expect((await (await learner.get('/api/auth/me')).json()).user).toBeNull();
        expect((await learner.post('/api/auth/login', { data: { email, password } })).status()).toBe(401);
        expect((await admin.patch(`/api/admin/users/${userId}`, { data: { name: registered.name, role: 'USER', groupId, enabled: true } })).ok()).toBeTruthy();
        expect((await learner.post('/api/auth/login', { data: { email, password } })).ok()).toBeTruthy();
        expect((await learner.post('/api/auth/logout')).ok()).toBeTruthy();
        expect((await learner.get('/api/reservations')).status()).toBe(401);
    } finally {
        if (previousDefault) await db.appSetting.update({ where: { id: 'main' }, data: { defaultGroupId: previousDefault } });
        const reservations = sessionId ? await db.reservation.findMany({ where: { sessionId } }) : [];
        const coverages = sessionId ? await db.assistantCoverage.findMany({ where: { sessionId } }) : [];
        await db.auditLog.deleteMany({ where: { OR: [{ actorId: userId || 'none' }, { target: { in: [groupId, sessionId, courseId, userId, ...reservations.map(r => r.id), ...coverages.map(c => c.id)].filter(Boolean) } }] } });
        if (sessionId) {
            await db.reservation.deleteMany({ where: { sessionId } });
            await db.assistantCoverage.deleteMany({ where: { sessionId } });
            await db.session.delete({ where: { id: sessionId } });
        }
        if (courseId) await db.course.delete({ where: { id: courseId } });
        if (userId) await db.user.delete({ where: { id: userId } });
        if (groupId) await db.group.delete({ where: { id: groupId } });
        await Promise.all([admin.dispose(), learner.dispose(), assistant.dispose()]);
    }
});
