import { test as base, expect, type APIRequestContext } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { hash } from 'bcryptjs';

const db = new PrismaClient();
type Fixture = {
    admin: APIRequestContext; assistant: APIRequestContext; learner: APIRequestContext;
    users: { id: string; studentId: string; email: string; name: string; role: string; groupId: string; enabled: boolean }[];
    groupId: string; venueId: string; layoutId: string; courseId: string; sessionId: string;
    seats: { id: string; code: string }[]; tokens: string[];
    input: { courseId: string; layoutId: string; startsAt: string; endsAt: string; requiredAssistants: number; open: boolean };
};
const test = base.extend<{ data: Fixture }>({
    data: async ({ playwright, baseURL }, use) => {
        const prefix = `accept-${randomUUID()}`;
        const group = await db.group.create({ data: { name: prefix, canReserve: true, weeklyRules: { create: Array.from({ length: 7 }, (_, weekday) => ({ weekday, startMinute: 0, endMinute: 1440 })) } } });
        const venue = await db.venue.create({ data: { name: prefix, location: '验收场地' } });
        const layout = await db.layoutVersion.create({ data: { name: prefix, venueId: venue.id, status: 'PUBLISHED', seats: { create: [{ code: 'T01', x: 100, y: 100 }, { code: 'T02', x: 200, y: 100 }, { code: 'STAFF', x: 300, y: 100, fixedForAssistant: true }] } }, include: { seats: true } });
        const course = await db.course.create({ data: { name: `${prefix}课程`, instructor: '验收教师' } });
        const startsAt = new Date(Math.ceil(Date.now() / 60000) * 60000 + 3600000).toISOString();
        const endsAt = new Date(Date.parse(startsAt) + 3600000).toISOString();
        const input = { courseId: course.id, layoutId: layout.id, startsAt, endsAt, requiredAssistants: 1, open: true };
        const session = await db.session.create({ data: input });
        const users = [], contexts: APIRequestContext[] = [], tokens: string[] = [];
        for (const [i, role] of (['ADMIN', 'ADMIN', 'USER'] as const).entries()) {
            const user = await db.user.create({ data: { name: `验收用户${i}`, studentId: `${prefix.replace(/[^a-zA-Z0-9]/g, '').slice(0, 24)}${i}`, email: `${prefix}-${i}@example.test`, role, groupId: group.id, passwordHash: 'unused' } });
            users.push(user);
            const token = randomBytes(32).toString('hex'); tokens.push(token);
            await db.authSession.create({ data: { id: createHash('sha256').update(token).digest('hex'), userId: user.id, expiresAt: new Date(Date.now() + 3600000) } });
            contexts.push(await playwright.request.newContext({ baseURL, extraHTTPHeaders: { Cookie: `station_session=${token}` } }));
        }
        try {
            await use({ admin: contexts[0], assistant: contexts[1], learner: contexts[2], users, groupId: group.id, venueId: venue.id, layoutId: layout.id, courseId: course.id, sessionId: session.id, seats: layout.seats, input, tokens });
        } finally {
            await Promise.all(contexts.map(c => c.dispose()));
            const userIds = (await db.user.findMany({ where: { groupId: group.id } })).map(u => u.id);
            const layoutIds = (await db.layoutVersion.findMany({ where: { venueId: venue.id } })).map(l => l.id);
            const sessionIds = (await db.session.findMany({ where: { layoutId: { in: layoutIds } } })).map(s => s.id);
            await db.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
            await db.reservation.deleteMany({ where: { sessionId: { in: sessionIds } } });
            await db.assistantCoverage.deleteMany({ where: { sessionId: { in: sessionIds } } });
            await db.session.deleteMany({ where: { id: { in: sessionIds } } });
            await db.course.delete({ where: { id: course.id } });
            await db.layoutVersion.deleteMany({ where: { id: { in: layoutIds } } });
            await db.venue.delete({ where: { id: venue.id } });
            await db.user.deleteMany({ where: { id: { in: userIds } } });
            await db.group.delete({ where: { id: group.id } });
        }
    },
});
const userInput = (u: Fixture['users'][number], patch: object = {}) => ({ name: u.name, role: u.role, groupId: u.groupId, enabled: u.enabled, ...patch });
async function cover(data: Fixture) {
    const staff = await data.admin.post('/api/reservations', { data: { sessionId: data.sessionId, seatId: data.seats.find(s => s.code === 'STAFF')!.id } });
    expect(staff.ok(), await staff.text()).toBeTruthy();
    const response = await data.assistant.post('/api/reservations/coverage', { data: { sessionId: data.sessionId } });
    expect(response.ok(), await response.text()).toBeTruthy();
    return (await response.json()).coverage.id as string;
}
async function book(data: Fixture) {
    const response = await data.learner.post('/api/reservations', { data: { sessionId: data.sessionId, seatId: data.seats[0].id } });
    expect(response.ok(), await response.text()).toBeTruthy();
    return (await response.json()).reservation.id as string;
}

test('并发创建重叠场次只成功一个，相邻时段允许', async ({ data }) => {
    const input = { ...data.input, startsAt: data.input.endsAt, endsAt: new Date(Date.parse(data.input.endsAt) + 3600000).toISOString() };
    const results = await Promise.all([data.admin.post('/api/sessions', { data: input }), data.admin.post('/api/sessions', { data: input })]);
    expect(results.map(r => r.status()).sort()).toEqual([200, 409]);
    expect(await db.session.count({ where: { layoutId: data.layoutId } })).toBe(2);
});

test('最后管理员保护：两名管理员同时降级或禁用仍保留一名', async ({ data, playwright, baseURL }) => {
    const otherId = randomUUID();
    const other = await db.user.create({ data: { name: '第二管理员', studentId: otherId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 24), email: `admin-${otherId}@example.test`, groupId: data.groupId, role: 'ADMIN', passwordHash: 'unused' } });
    const token = randomBytes(32).toString('hex');
    await db.authSession.create({ data: { id: createHash('sha256').update(token).digest('hex'), userId: other.id, expiresAt: new Date(Date.now() + 3600000) } });
    const context = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { Cookie: `station_session=${token}` } });
    const existing = await db.user.findMany({ where: { role: 'ADMIN', enabled: true, id: { notIn: [data.users[0].id, other.id] } } });
    try {
        await db.user.updateMany({ where: { id: { in: existing.map(u => u.id) } }, data: { enabled: false } });
        const responses = await Promise.all([
            data.admin.patch(`/api/admin/users/${data.users[0].id}`, { data: userInput(data.users[0], { role: 'USER' }) }),
            context.patch(`/api/admin/users/${other.id}`, { data: userInput(other, { enabled: false }) }),
        ]);
        expect(responses.filter(r => r.ok())).toHaveLength(1);
        expect(responses.filter(r => !r.ok()).map(r => r.status())).toEqual([400]);
        expect(await db.user.count({ where: { role: 'ADMIN', enabled: true } })).toBe(1);
        const remaining = await db.user.findFirstOrThrow({ where: { role: 'ADMIN', enabled: true } });
        const remainingContext = remaining.id === other.id ? context : data.admin;
        expect((await remainingContext.patch(`/api/admin/users/${remaining.id}`, { data: userInput(remaining, { enabled: false }) })).status()).toBe(400);
    } finally {
        await db.user.updateMany({ where: { id: { in: existing.map(u => u.id) } }, data: { enabled: true } });
        await context.dispose();
    }
});

test('助教登记与降级/停用竞争不产生无效保障', async ({ data, playwright, baseURL }) => {
    for (const patch of [{ enabled: false }, { role: 'USER' }]) {
        await db.assistantCoverage.deleteMany({ where: { sessionId: data.sessionId } });
        await db.user.update({ where: { id: data.users[1].id }, data: { role: 'ADMIN', enabled: true } });
        const token = randomBytes(32).toString('hex');
        await db.authSession.create({ data: { id: createHash('sha256').update(token).digest('hex'), userId: data.users[1].id, expiresAt: new Date(Date.now() + 3600000) } });
        const assistant = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { Cookie: `station_session=${token}` } });
        const results = await Promise.all([
            assistant.post('/api/reservations/coverage', { data: { sessionId: data.sessionId } }),
            data.admin.patch(`/api/admin/users/${data.users[1].id}`, { data: userInput(data.users[1], patch) }),
        ]);
        await assistant.dispose();
        expect(results.some(r => r.ok())).toBeTruthy();
        expect(results.every(r => r.status() < 500)).toBeTruthy();
        const user = await db.user.findUniqueOrThrow({ where: { id: data.users[1].id } });
        const count = await db.assistantCoverage.count({ where: { assistantId: user.id } });
        expect(count === 0 || (user.enabled && user.role === 'ADMIN')).toBeTruthy();
    }
});

test('保存与发布竞争、复制版本后编辑保持旧场次布局稳定', async ({ data }) => {
    const draft = await db.layoutVersion.create({ data: { name: '竞争草稿', venueId: data.venueId, seats: { create: { code: 'V01', x: 100, y: 100 } } }, include: { seats: true } });
    const input = { name: '保存竞争版本', width: draft.width, height: draft.height, elements: [], seats: draft.seats.map(s => ({ ...s, code: 'V02' })) };
    const results = await Promise.all([
        data.admin.put(`/api/layouts/${draft.id}`, { data: input }),
        data.admin.post(`/api/layouts/${draft.id}/publish`),
    ]);
    expect(results.every(r => [200, 409].includes(r.status()))).toBeTruthy();
    const published = await db.layoutVersion.findUniqueOrThrow({ where: { id: draft.id }, include: { seats: true } });
    expect(published.status).toBe('PUBLISHED');
    expect(published.seats).toHaveLength(1);
    expect((await data.admin.put(`/api/layouts/${draft.id}`, { data: input })).status()).toBe(409);
    const clone = await data.admin.post('/api/layouts', { data: { name: '复制草稿', venueId: data.venueId, cloneId: data.layoutId } });
    expect(clone.ok()).toBeTruthy();
    const cloneId = (await clone.json()).layout.id;
    const seats = await db.seat.findMany({ where: { layoutId: cloneId } });
    expect(seats.every(s => data.seats.every(old => old.id !== s.id))).toBeTruthy();
    expect((await data.admin.put(`/api/layouts/${cloneId}`, { data: { name: '新版本已编辑', width: 1000, height: 660, elements: [], seats: seats.map(s => ({ ...s, code: `NEW-${s.code}` })) } })).ok()).toBeTruthy();
    expect((await db.session.findUniqueOrThrow({ where: { id: data.sessionId } })).layoutId).toBe(data.layoutId);
    expect((await db.seat.findMany({ where: { layoutId: data.layoutId }, orderBy: { code: 'asc' } })).map(s => s.code)).toEqual(['STAFF', 'T01', 'T02']);
});

test('有预约场次锁定、关闭重开、管理员取消与失败事务日志', async ({ data }) => {
    const coverageId = await cover(data);
    const reservationId = await book(data);
    const before = await db.auditLog.count({ where: { actorId: data.users[0].id } });
    const otherLayout = await db.layoutVersion.create({ data: { name: '另一个布局', venueId: data.venueId, status: 'PUBLISHED' } });
    for (const patch of [
        { startsAt: new Date(Date.parse(data.input.startsAt) + 60000).toISOString() },
        { courseId: 'seed-course-1' },
        { layoutId: otherLayout.id },
        { requiredAssistants: 2 },
    ]) expect((await data.admin.put(`/api/sessions/${data.sessionId}`, { data: { ...data.input, ...patch } })).status()).toBe(400);
    expect((await data.admin.delete(`/api/reservations/coverage/${coverageId}`)).status()).toBe(409);
    expect(await db.auditLog.count({ where: { actorId: data.users[0].id } })).toBe(before);
    expect((await data.admin.put(`/api/sessions/${data.sessionId}`, { data: { ...data.input, open: false } })).ok()).toBeTruthy();
    expect((await data.admin.delete(`/api/reservations/${reservationId}`)).ok()).toBeTruthy();
    expect((await db.reservation.findUniqueOrThrow({ where: { id: reservationId } })).cancelledAt).toBeTruthy();
    expect((await data.learner.post('/api/reservations', { data: { sessionId: data.sessionId, seatId: data.seats[0].id } })).status()).toBe(403);
    expect((await data.admin.put(`/api/sessions/${data.sessionId}`, { data: data.input })).ok()).toBeTruthy();
    expect((await data.admin.delete(`/api/reservations/coverage/${coverageId}`)).ok()).toBeTruthy();
    expect((await data.admin.put(`/api/sessions/${data.sessionId}`, { data: { ...data.input, startsAt: new Date(Date.parse(data.input.startsAt) + 60000).toISOString() } })).status()).toBe(400);
    const logs = await db.auditLog.findMany({ where: { actorId: data.users[0].id } });
    expect(logs.some(l => l.action === 'RESERVATION_CANCEL' && l.target === reservationId)).toBeTruthy();
    expect(logs.some(l => l.action === 'COVERAGE_CANCEL' && l.target === coverageId)).toBeTruthy();
});

test('已登录分组/角色立即生效，禁止分组仍可取消自己的旧预约', async ({ data }) => {
    await cover(data);
    const reservationId = await book(data);
    await db.group.update({ where: { id: data.groupId }, data: { canReserve: false } });
    const current = (await (await data.learner.get('/api/auth/me')).json()).user;
    expect(current.group.canReserve).toBe(false);
    expect((await data.learner.delete(`/api/reservations/${reservationId}`)).ok()).toBeTruthy();
    expect((await data.learner.post('/api/reservations', { data: { sessionId: data.sessionId, seatId: data.seats[0].id } })).status()).toBe(403);
    expect((await data.admin.patch(`/api/admin/users/${data.users[2].id}`, { data: userInput(data.users[2], { role: 'ADMIN' }) })).ok()).toBeTruthy();
    expect((await data.learner.get('/api/admin/users')).ok()).toBeTruthy();
});

test('CSV 筛选、BOM、中文、引号换行及公式前缀转义', async ({ data }) => {
    await cover(data);
    await db.user.update({ where: { id: data.users[2].id }, data: { name: '=SUM(1,2)"\n中文' } });
    const reservationId = await book(data);
    const response = await data.admin.get(`/api/admin/reservations?sessionId=${data.sessionId}&export=csv`);
    expect(response.ok()).toBeTruthy();
    const buffer = await response.body();
    expect([...buffer.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const csv = buffer.toString('utf8');
    expect(csv).toContain('"\'=SUM(1,2)""\n中文"');
    expect(csv).toContain(data.users[2].studentId);
    expect(csv).toContain('"T01","已预约"');
    await expect((await data.admin.get('/api/admin/reservations?sessionId=missing&export=csv')).body().then(b => b.toString().trim().split('\r\n').length)).resolves.toBe(1);
    await data.admin.delete(`/api/reservations/${reservationId}`);
    expect(await (await data.admin.get(`/api/admin/reservations?sessionId=${data.sessionId}&export=csv`)).text()).toContain('"T01","已取消"');
});

test('真实 Cookie、会话过期/撤销、15 次限流与窗口重置', async ({ data, playwright, baseURL }) => {
    test.setTimeout(90000);
    const user = data.users[2];
    const password = 'Acceptance-Password-2026!';
    await db.user.update({ where: { id: user.id }, data: { passwordHash: await hash(password, 4) } });
    const client = await playwright.request.newContext({ baseURL });
    const key = `auth/login:USER:${createHash('sha256').update(user.studentId).digest('hex')}`;
    try {
        const login = await client.post('/api/auth/login', { data: { studentId: user.studentId, password } });
        expect(login.ok()).toBeTruthy();
        const cookie = (await client.storageState()).cookies.find(c => c.name === 'station_session')!;
        expect(cookie.httpOnly).toBe(true); expect(cookie.sameSite).toBe('Lax'); expect(cookie.secure).toBe(false);
        expect(cookie.expires).toBeGreaterThan(Date.now() / 1000 + 6.9 * 86400);
        const tokenId = createHash('sha256').update(cookie.value).digest('hex');
        expect(await db.authSession.findUnique({ where: { id: cookie.value } })).toBeNull();
        await db.authSession.update({ where: { id: tokenId }, data: { expiresAt: new Date(Date.now() - 1000) } });
        expect((await client.get('/api/reservations')).status()).toBe(401);
        expect((await client.post('/api/auth/login', { data: { studentId: user.studentId, password } })).ok()).toBeTruthy();
        expect((await client.post('/api/auth/logout')).ok()).toBeTruthy();
        expect((await client.get('/api/reservations')).status()).toBe(401);
        await db.loginAttempt.delete({ where: { key } });
        for (let i = 0; i < 15; i++) expect((await client.post('/api/auth/login', { data: { studentId: user.studentId, password: 'wrong' } })).status()).toBe(401);
        expect((await client.post('/api/auth/login', { data: { studentId: user.studentId, password } })).status()).toBe(429);
        await db.loginAttempt.update({ where: { key }, data: { resetAt: new Date(Date.now() - 1000) } });
        expect((await client.post('/api/auth/login', { data: { studentId: user.studentId, password } })).ok()).toBeTruthy();
        expect((await db.loginAttempt.findUniqueOrThrow({ where: { key } })).count).toBe(1);
        expect((await data.admin.patch(`/api/admin/users/${user.id}`, { data: userInput(user, { enabled: false }) })).ok()).toBeTruthy();
        expect(await db.authSession.count({ where: { userId: user.id } })).toBe(0);
        expect((await client.get('/api/reservations')).status()).toBe(401);
    } finally {
        await db.loginAttempt.deleteMany({ where: { key } });
        await client.dispose();
    }
});

test.afterAll(() => db.$disconnect());

test('布局输入拒绝重复编号、非法关联、尺寸和旋转越界', async ({ data }) => {
    const draft = await db.layoutVersion.create({ data: { name: '输入校验草稿', venueId: data.venueId } });
    const seat = { id: randomUUID(), code: 'A01', x: 100, y: 100, rotation: 0, enabled: true };
    const element = { id: randomUUID(), kind: 'DESK', label: '桌面', x: 100, y: 100, width: 100, height: 100, rotation: 0 };
    const input = { name: draft.name, width: 400, height: 300, elements: [element], seats: [seat] };
    for (const patch of [
        { seats: [seat, { ...seat, id: randomUUID() }] },
        { seats: [{ ...seat, elementId: 'missing' }] },
        { seats: [{ ...seat, elementId: element.id }], elements: [{ ...element, kind: 'LABEL' }] },
        { seats: [{ ...seat, x: 361 }] },
        { elements: [{ ...element, x: 301 }] },
        { elements: [{ ...element, x: 0, y: 0, rotation: 45 }] },
    ]) expect((await data.admin.put(`/api/layouts/${draft.id}`, { data: { ...input, ...patch } })).status()).toBe(400);
    expect((await data.admin.put(`/api/layouts/${draft.id}`, { data: input })).ok()).toBeTruthy();
    const invalid = { name: '非法日期', canReserve: true, weeklyRules: [], dateRules: [{ date: '2026-02-30', allowed: true, startMinute: 0, endMinute: 1440 }] };
    expect((await data.admin.put(`/api/groups/${data.groupId}`, { data: invalid })).status()).toBe(400);
});

test('后台表单：用户、分组规则、课程、场次、预约取消和日志', async ({ data, page, baseURL }, testInfo) => {
    await page.context().addCookies([{ name: 'station_session', value: data.tokens[0], url: baseURL! }]);
    await page.goto('/admin/users');
    await page.getByLabel('搜索用户').fill(data.users[2].email);
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    await page.getByLabel('姓名', { exact: true }).fill('表单更新学员');
    await page.getByRole('button', { name: '保存用户' }).click();
    await expect(page.getByRole('status')).toContainText('用户已更新');
    await expect(page.locator('table')).toContainText('表单更新学员');
    await page.goto('/admin/groups');
    const group = await db.group.findUniqueOrThrow({ where: { id: data.groupId } });
    await page.locator('.record-card').filter({ hasText: group.name }).getByRole('button', { name: '编辑权限' }).click();
    await page.getByRole('button', { name: '添加日期规则' }).click();
    await page.getByLabel('指定日期').fill('2027-01-01');
    await page.getByRole('button', { name: '保存分组权限' }).click();
    await expect(page.getByRole('status')).toContainText('分组权限已保存');
    expect(await db.groupDateRule.count({ where: { groupId: data.groupId, date: '2027-01-01' } })).toBe(1);
    await page.goto('/admin/courses');
    const course = await db.course.findUniqueOrThrow({ where: { id: data.courseId } });
    await page.locator('.record-card').filter({ hasText: course.name }).getByRole('button', { name: '编辑课程' }).click();
    await page.getByLabel('指导教师').fill('表单验收老师');
    await page.getByRole('button', { name: '保存课程' }).click();
    await expect(page.getByRole('status')).toContainText('课程已保存');
    await page.goto('/admin/sessions');
    await page.getByRole('button', { name: '新增预约时段', exact: true }).click();
    await page.getByRole('combobox', { name: /^已发布布局/ }).selectOption(data.layoutId);
    const localParts = (value: number) => {
        const d = new Date(value + 8 * 3600000);
        return { date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16) };
    };
    const start = localParts(Date.parse(data.input.endsAt) + 3600000);
    const end = localParts(Date.parse(data.input.endsAt) + 7200000);
    await page.getByLabel('日期', { exact: true }).fill(start.date);
    await page.getByRole('combobox', { name: /^开始时间/ }).selectOption(start.time);
    await page.getByLabel('结束日期', { exact: true }).fill(end.date);
    await page.getByRole('combobox', { name: /^结束时间/ }).selectOption(end.time);
    await page.getByRole('button', { name: '保存预约时段' }).click();
    await expect(page.getByRole('status')).toContainText('预约时段已创建');
    expect(await db.session.count({ where: { layoutId: data.layoutId } })).toBe(2);
    await cover(data); await book(data);
    await page.goto('/admin/reservations');
    await page.getByLabel('筛选预约时段').selectOption(data.sessionId);
    await expect(page.locator('table').first()).toContainText(data.users[2].studentId);
    page.once('dialog', d => d.accept());
    await page.getByRole('row', { name: new RegExp(data.users[2].studentId) }).getByRole('button', { name: '取消预约', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('预约已取消');
    expect((await page.request.delete(`/api/reservations/coverage/${(await db.assistantCoverage.findFirstOrThrow({ where: { sessionId: data.sessionId } })).id}`)).ok()).toBeTruthy();
    await page.goto('/admin/logs');
    await expect(page.locator('table')).toContainText('取消助教保障');
    await page.screenshot({ path: testInfo.outputPath('admin-logs.png'), fullPage: true });
        await testInfo.attach('admin-logs', { path: testInfo.outputPath('admin-logs.png'), contentType: 'image/png' });
});

test('平板触屏和窄屏登录退出、座位键盘操作与确认框焦点', async ({ data, browser, baseURL }, testInfo) => {
    await cover(data);
    const context = await browser.newContext({ baseURL, viewport: { width: 768, height: 1024 }, hasTouch: true });
    await context.addCookies([{ name: 'station_session', value: data.tokens[2], url: baseURL! }]);
    const page = await context.newPage();
    try {
        await page.goto('/');
        const day = new Date(data.input.startsAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
        await page.getByRole('button', { name: `选择日期 ${day}`, exact: true }).tap();
        const seat = page.getByRole('button', { name: '座位 T01，可预约', exact: true });
        await seat.focus(); await page.keyboard.press('Enter');
        await page.getByRole('button', { name: '确认预约', exact: true }).tap();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole('button', { name: '再想一下' })).toBeFocused();
        await page.keyboard.press('Shift+Tab');
        await expect(dialog.getByRole('button', { name: '确认，预约这个工位' })).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(dialog.getByRole('button', { name: '再想一下' })).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(dialog).not.toBeVisible();
        await expect(page.getByRole('button', { name: '确认预约', exact: true })).toBeFocused();
        await page.screenshot({ path: testInfo.outputPath('tablet-booking.png'), fullPage: true });
        await testInfo.attach('tablet-booking', { path: testInfo.outputPath('tablet-booking.png'), contentType: 'image/png' });
        await page.setViewportSize({ width: 390, height: 844 });
        await expect(page.getByRole('button', { name: '退出登录', exact: true })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: testInfo.outputPath('mobile-booking.png'), fullPage: true });
        await testInfo.attach('mobile-booking', { path: testInfo.outputPath('mobile-booking.png'), contentType: 'image/png' });
        await page.getByRole('button', { name: '退出登录', exact: true }).tap();
        await expect(page.getByRole('heading', { name: '先选择你的入口。' })).toBeVisible();
    } finally { await context.close(); }
});

test('两个浏览器抢座刷新，失败可重试，取消后座位释放', async ({ data, browser, baseURL }) => {
    await cover(data);
    const otherId = randomUUID();
    const other = await db.user.create({ data: { name: '另一学员', studentId: otherId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 24), email: `${otherId}@example.test`, passwordHash: 'unused', groupId: data.groupId } });
    const token = randomBytes(32).toString('hex');
    await db.authSession.create({ data: { id: createHash('sha256').update(token).digest('hex'), userId: other.id, expiresAt: new Date(Date.now() + 3600000) } });
    const a = await browser.newContext({ baseURL }), b = await browser.newContext({ baseURL });
    await a.addCookies([{ name: 'station_session', value: data.tokens[2], url: baseURL! }]);
    await b.addCookies([{ name: 'station_session', value: token, url: baseURL! }]);
    const first = await a.newPage(), second = await b.newPage();
    const day = new Date(data.input.startsAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    try {
        for (const page of [first, second]) {
            await page.goto('/');
            await page.getByRole('button', { name: `选择日期 ${day}`, exact: true }).click();
            await page.getByRole('button', { name: '座位 T01，可预约', exact: true }).click();
            await page.getByRole('button', { name: '确认预约', exact: true }).click();
        }
        await first.getByRole('button', { name: '确认，预约这个工位' }).click();
        await expect(first.getByRole('status')).toContainText('预约成功');
        await second.getByRole('button', { name: '确认，预约这个工位' }).click();
        await expect(second.getByRole('status')).toContainText('刚被预约');
        await expect(second.getByRole('button', { name: '座位 T01，已预约', exact: true })).toBeVisible();
        await first.getByRole('main').getByRole('link', { name: '我的预约', exact: true }).click();
        first.once('dialog', d => d.accept());
        await first.locator('.record-card').filter({ hasText: 'T01' }).getByRole('button', { name: '取消预约' }).click();
        await expect(first.getByRole('status')).toContainText('预约已取消');
        await second.reload();
        await second.getByRole('button', { name: `选择日期 ${day}`, exact: true }).click();
        await expect(second.getByRole('button', { name: '座位 T01，可预约', exact: true })).toBeVisible();
        await second.route('**/api/sessions', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"测试网络失败"}' }));
        await second.reload();
        await expect(second.locator('main [role=alert]')).toContainText('测试网络失败');
        await second.unroute('**/api/sessions');
        await second.getByRole('button', { name: '重试', exact: true }).click();
        await expect(second.locator('main [role=alert]')).not.toBeVisible();
    } finally { await Promise.all([a.close(), b.close()]); }
});

test('布局画布拖动、缩放、尺寸旋转、多选编号与发布只读', async ({ data, page, baseURL }, testInfo) => {
    await page.context().addCookies([{ name: 'station_session', value: data.tokens[0], url: baseURL! }]);
    const draft = await db.layoutVersion.create({ data: { name: '画布交互验收', venueId: data.venueId } });
    await page.goto('/admin/layouts');
    await page.getByLabel('选择布局版本').selectOption(draft.id);
    await page.getByRole('button', { name: '桌子', exact: true }).click();
    await page.getByLabel('宽度', { exact: true }).fill('180');
    await page.getByLabel('高度', { exact: true }).fill('80');
    await page.getByRole('button', { name: '旋转', exact: true }).click();
    await expect(page.getByLabel('旋转角度')).toHaveValue('90');
    await page.getByRole('button', { name: '座位', exact: true }).click();
    await expect(page.getByLabel('所属桌面')).not.toHaveValue('');
    await page.getByRole('button', { name: '放大画布', exact: true }).click();
    await expect(page.locator('.zoom-tools')).toContainText('110%');
    const desk = page.getByRole('button', { name: '编辑元素 共享长桌', exact: true });
    const box = (await desk.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 35, box.y + box.height / 2 + 30, { steps: 5 }); await page.mouse.up();
    const deskX = Number(await page.getByLabel('X', { exact: true }).inputValue());
    expect(deskX).toBeGreaterThan(160);
    await page.getByRole('button', { name: '编辑座位 A01', exact: true }).click();
    expect(Number(await page.getByLabel('X', { exact: true }).inputValue())).toBeCloseTo(deskX, 5);
    await page.keyboard.press('ArrowRight');
    expect(Number(await page.getByLabel('X', { exact: true }).inputValue())).toBeCloseTo(deskX + 5, 5);
    await page.getByRole('button', { name: '座位', exact: true }).click();
    await page.getByRole('button', { name: '编辑座位 A01', exact: true }).click();
    await page.getByRole('button', { name: '编辑座位 A02', exact: true }).click({ modifiers: ['Shift'] });
    await page.getByLabel('前缀', { exact: true }).fill('Z');
    await page.getByRole('button', { name: '批量编号 2 个座位', exact: true }).click();
    await page.getByRole('button', { name: /^保存(?: \*)?$/, exact: true }).click();
    await expect(page.getByRole('status')).toContainText('草稿已保存');
    const saved = await db.layoutVersion.findUniqueOrThrow({ where: { id: draft.id }, include: { seats: true, elements: true } });
    expect(saved.elements[0].rotation).toBe(90);
    expect(saved.elements[0].width).toBe(180);
    expect(saved.seats.map(s => s.code).sort()).toEqual(['Z01', 'Z02']);
    page.once('dialog', d => d.accept());
    await page.getByRole('button', { name: '保存并发布' }).click();
    await expect(page.getByRole('status')).toContainText('布局已发布');
    await expect(page.getByLabel('版本名称')).toBeDisabled();
    await expect(page.getByRole('button', { name: '桌子', exact: true })).not.toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('published-layout.png'), fullPage: true });
    await testInfo.attach('布局发布', { path: testInfo.outputPath('published-layout.png'), contentType: 'image/png' });
});
