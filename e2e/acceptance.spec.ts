import { test as base, expect, type APIRequestContext } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { hash } from 'bcryptjs';
import { localParts } from '../src/lib/rules';

const db = new PrismaClient();
type Fixture = {
    admin: APIRequestContext; assistant: APIRequestContext; learner: APIRequestContext;
    users: { id: string; studentId: string; email: string; name: string; role: string; groupId: string | null; enabled: boolean }[];
    groupId: string; venueId: string; layoutId: string; sessionId: string;
    seats: { id: string; code: string }[]; tokens: string[];
    input: { layoutId: string; startsAt: string; endsAt: string; requiredAssistants: number; open: boolean };
};
const test = base.extend<{ data: Fixture }>({
    data: async ({ playwright, baseURL }, use) => {
        const prefix = `accept-${randomUUID()}`;
        const group = await db.group.create({ data: { name: prefix } });
        const venue = await db.venue.create({ data: { name: prefix, location: '验收场地' } });
        const layout = await db.layoutVersion.create({ data: { name: prefix, venueId: venue.id, status: 'PUBLISHED', seats: { create: [{ code: 'T01', x: 100, y: 100 }, { code: 'T02', x: 200, y: 100 }, { code: 'STAFF', x: 300, y: 100, fixedForAssistant: true }] } }, include: { seats: true } });
        const tomorrow = localParts(new Date(Date.now() + 86400000)).date;
        const startsAt = new Date(`${tomorrow}T09:00:00+08:00`).toISOString();
        const endsAt = new Date(Date.parse(startsAt) + 3600000).toISOString();
        const input = { layoutId: layout.id, startsAt, endsAt, requiredAssistants: 1, open: true };
        const session = await db.session.create({ data: input });
        const users = [], contexts: APIRequestContext[] = [], tokens: string[] = [];
        for (const [i, role] of (['ADMIN', 'ASSISTANT', 'USER'] as const).entries()) {
            const user = await db.user.create({ data: { name: `验收用户${i}`, studentId: `${prefix.replace(/[^a-zA-Z0-9]/g, '').slice(0, 24)}${i}`, email: `${prefix}-${i}@example.test`, role, groupId: group.id, passwordHash: 'unused' } });
            users.push(user);
            const token = randomBytes(32).toString('hex'); tokens.push(token);
            await db.authSession.create({ data: { id: createHash('sha256').update(token).digest('hex'), userId: user.id, expiresAt: new Date(Date.now() + 3600000) } });
            contexts.push(await playwright.request.newContext({ baseURL, extraHTTPHeaders: { Cookie: `station_session=${token}` } }));
        }
        try {
            await use({ admin: contexts[0], assistant: contexts[1], learner: contexts[2], users, groupId: group.id, venueId: venue.id, layoutId: layout.id, sessionId: session.id, seats: layout.seats, input, tokens });
        } finally {
            await Promise.all(contexts.map(c => c.dispose()));
            const userIds = (await db.user.findMany({ where: { groupId: group.id } })).map(u => u.id);
            const layoutIds = (await db.layoutVersion.findMany({ where: { venueId: venue.id } })).map(l => l.id);
            const sessionIds = (await db.session.findMany({ where: { layoutId: { in: layoutIds } } })).map(s => s.id);
            await db.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
            await db.bookingBlock.deleteMany({ where: { createdById: { in: userIds } } });
            await db.reservation.deleteMany({ where: { sessionId: { in: sessionIds } } });
            await db.assistantCoverage.deleteMany({ where: { sessionId: { in: sessionIds } } });
            await db.session.deleteMany({ where: { id: { in: sessionIds } } });
            await db.layoutVersion.deleteMany({ where: { id: { in: layoutIds } } });
            await db.venue.delete({ where: { id: venue.id } });
            await db.user.deleteMany({ where: { id: { in: userIds } } });
            await db.group.delete({ where: { id: group.id } });
        }
    },
});
const userInput = (u: Fixture['users'][number], patch: object = {}) => ({ name: u.name, role: u.role, enabled: u.enabled, ...patch });
async function cover(data: Fixture) {
    const response = await data.assistant.post('/api/reservations', { data: { sessionId: data.sessionId, seatId: data.seats.find(s => s.code === 'STAFF')!.id } });
    expect(response.ok(), await response.text()).toBeTruthy();
    return (await response.json()).reservation.id as string;
}
async function book(data: Fixture) {
    const response = await data.learner.post('/api/reservations', { data: { sessionId: data.sessionId, seatId: data.seats[0].id } });
    expect(response.ok(), await response.text()).toBeTruthy();
    return (await response.json()).reservation.id as string;
}

test('后台创建和开放时段接口已移除，助教直接预约工位', async ({ data }) => {
    expect((await data.admin.post('/api/sessions', { data: data.input })).status()).toBe(404);
    expect((await data.admin.post(`/api/admin/sessions/${data.sessionId}/ready`)).status()).toBe(404);
    await cover(data);
    await book(data);
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

test('助教预约与停用竞争后，成员不能用停用助教的预约取得资格', async ({ data }) => {
    const results = await Promise.all([
        data.assistant.post('/api/reservations', { data: { sessionId: data.sessionId, seatId: data.seats.find(s => s.code === 'STAFF')!.id } }),
        data.admin.patch(`/api/admin/users/${data.users[1].id}`, { data: userInput(data.users[1], { enabled: false }) }),
    ]);
    expect(results[1].ok()).toBeTruthy();
    expect((await data.learner.post('/api/reservations', { data: { sessionId: data.sessionId, seatId: data.seats[0].id } })).status()).toBe(403);
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

test('禁止预约时间取消范围内预约，解除后可以重新预约并保留取消历史', async ({ data }) => {
    await cover(data);
    const reservationId = await book(data);
    const response = await data.admin.post('/api/admin/booking-blocks', { data: { startsAt: data.input.startsAt, endsAt: data.input.endsAt, reason: '设备维护' } });
    expect(response.ok()).toBeTruthy();
    const blockId = (await response.json()).block.id;
    expect((await db.reservation.findUniqueOrThrow({ where: { id: reservationId } })).cancelledAt).toBeTruthy();
    expect((await data.learner.post('/api/reservations', { data: { sessionId: data.sessionId, seatId: data.seats[0].id } })).status()).toBe(403);
    expect((await data.admin.delete(`/api/admin/booking-blocks/${blockId}`)).ok()).toBeTruthy();
    await cover(data);
    await book(data);
});

test('预约规则接口已移除，已有助教预约即可选座；角色变更立即生效', async ({ data }) => {
    expect((await data.admin.get('/api/groups')).status()).toBe(404);
    expect((await data.admin.put(`/api/groups/${data.groupId}`, { data: {} })).status()).toBe(404);
    await cover(data);
    const reservationId = await book(data);
    const current = (await (await data.learner.get('/api/auth/me')).json()).user;
    expect(current).not.toHaveProperty('group');
    expect((await data.learner.delete(`/api/reservations/${reservationId}`)).ok()).toBeTruthy();
    await book(data);
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
    const key = `auth/login:${createHash('sha256').update(user.studentId).digest('hex')}`;
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
});

test('后台禁止预约表单支持整天禁止和解除，导航中没有预约时段', async ({ data, page, baseURL }) => {
    await page.context().addCookies([{ name: 'station_session', value: data.tokens[0], url: baseURL! }]);
    await page.goto('/admin');
    await expect(page.getByRole('link', { name: '预约时段', exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /预约规则/ })).toHaveCount(0);
    await page.goto('/admin/groups');
    await expect(page.getByText('页面不存在', { exact: true })).toBeVisible();
    await page.goto('/admin');
    await page.getByRole('link', { name: '禁止预约时间', exact: true }).click();
    await page.getByRole('button', { name: '新增禁止预约时间', exact: true }).click();
    await page.getByLabel('全天禁止预约').check();
    const date = new Date(Date.now() + 5 * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    await page.getByLabel('禁止日期').fill(date);
    await page.getByLabel('原因（选填）').fill('整天设备维护');
    await page.getByRole('button', { name: '保存禁止预约时间' }).click();
    await expect(page.getByRole('status')).toContainText('已设置禁止预约时间');
    const row = page.getByRole('row').filter({ hasText: '整天设备维护' });
    await expect(row).toBeVisible();
    const block = await db.bookingBlock.findFirstOrThrow({ where: { createdById: data.users[0].id, reason: '整天设备维护', active: true } });
    expect(block.endsAt.getTime() - block.startsAt.getTime()).toBe(86400000);
    expect(block.startsAt.toISOString()).toBe(new Date(`${date}T00:00:00+08:00`).toISOString());
    page.once('dialog', dialog => dialog.accept());
    await row.getByRole('button', { name: '解除禁止' }).click();
    await expect(row).toHaveCount(0);
    expect((await db.bookingBlock.findUniqueOrThrow({ where: { id: block.id } })).active).toBe(false);
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
        await page.getByLabel('场地', { exact: true }).selectOption(`icil-${data.venueId}-${day}`);
        const slotStart = new Date(data.input.startsAt);
        const slotEnd = new Date(slotStart.getTime() + 1800000);
        const slotLabel = `${slotStart.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })} 至 ${slotEnd.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}，可预约`;
        await page.getByRole('button', { name: slotLabel, exact: true }).tap();
        const seat = page.getByRole('button', { name: '座位 T01，可预约', exact: true });
        await seat.focus(); await page.keyboard.press('Enter');
        await page.getByRole('button', { name: '预约所选时间', exact: true }).tap();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole('button', { name: '再想一下' })).toBeFocused();
        await page.keyboard.press('Shift+Tab');
        await expect(dialog.getByRole('button', { name: '确认，预约这个工位' })).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(dialog.getByRole('button', { name: '再想一下' })).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(dialog).not.toBeVisible();
        await expect(page.getByRole('button', { name: '预约所选时间', exact: true })).toBeFocused();
        await page.screenshot({ path: testInfo.outputPath('tablet-booking.png'), fullPage: true });
        await testInfo.attach('tablet-booking', { path: testInfo.outputPath('tablet-booking.png'), contentType: 'image/png' });
        await page.setViewportSize({ width: 390, height: 844 });
        await expect(page.getByRole('button', { name: '退出登录', exact: true })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: testInfo.outputPath('mobile-booking.png'), fullPage: true });
        await testInfo.attach('mobile-booking', { path: testInfo.outputPath('mobile-booking.png'), contentType: 'image/png' });
        await page.getByRole('button', { name: '退出登录', exact: true }).tap();
        await expect(page.getByRole('heading', { name: '登录预约空间。' })).toBeVisible();
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
    const slotStart = new Date(data.input.startsAt);
    const slotEnd = new Date(slotStart.getTime() + 1800000);
    const slotLabel = `${slotStart.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })} 至 ${slotEnd.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}，可预约`;
    try {
        for (const page of [first, second]) {
            await page.goto('/');
            await page.getByRole('button', { name: `选择日期 ${day}`, exact: true }).click();
            await page.getByLabel('场地', { exact: true }).selectOption(`icil-${data.venueId}-${day}`);
            await page.getByRole('button', { name: slotLabel, exact: true }).click();
            await page.getByRole('button', { name: '座位 T01，可预约', exact: true }).click();
            await page.getByRole('button', { name: '预约所选时间', exact: true }).click();
        }
        await first.getByRole('button', { name: '确认，预约这个工位' }).click();
        await expect(first.getByRole('status')).toContainText('已预约 1 个半小时段');
        await second.getByRole('button', { name: '确认，预约这个工位' }).click();
        await expect(second.getByRole('status')).toContainText(/刚被预约|已有其他用户预约/);
        await expect(second.getByRole('button', { name: '座位 T01，已预约', exact: true })).toBeVisible();
        await first.getByRole('main').getByRole('link', { name: '我的预约', exact: true }).click();
        first.once('dialog', d => d.accept());
        await first.locator('.record-card').filter({ hasText: 'T01' }).getByRole('button', { name: '取消预约' }).click();
        await expect(first.getByRole('status')).toContainText('预约已取消');
        await second.reload();
        await second.getByRole('button', { name: `选择日期 ${day}`, exact: true }).click();
        await second.getByLabel('场地', { exact: true }).selectOption(`icil-${data.venueId}-${day}`);
        await second.getByRole('button', { name: slotLabel, exact: true }).click();
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

test('助教通过相同选座界面预约后，一生一芯对应时间才可预约', async ({ data, browser, baseURL }) => {
    const staff = await browser.newContext({ baseURL }), member = await browser.newContext({ baseURL });
    await staff.addCookies([{ name: 'station_session', value: data.tokens[1], url: baseURL! }]);
    await member.addCookies([{ name: 'station_session', value: data.tokens[2], url: baseURL! }]);
    const assistant = await staff.newPage(), learner = await member.newPage();
    const start = new Date(data.input.startsAt), end = new Date(start.getTime() + 1800000);
    const time = (date: Date) => date.toLocaleTimeString('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit' });
    const day = start.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    const label = `${time(start)} 至 ${time(end)}`;
    const open = async (page: typeof assistant) => {
        await page.goto('/');
        await page.getByRole('button', { name: `选择日期 ${day}`, exact: true }).click();
        await page.getByLabel('场地', { exact: true }).selectOption(`icil-${data.venueId}-${day}`);
    };
    try {
        await open(learner);
        await expect(learner.getByRole('button', { name: `${label}，不可预约`, exact: true })).toBeDisabled();
        await open(assistant);
        await expect(assistant.getByRole('link', { name: '禁止预约时间', exact: true })).toHaveCount(0);
        await assistant.getByRole('button', { name: `${label}，可预约`, exact: true }).click();
        await assistant.getByRole('button', { name: '座位 STAFF，助教专用工位，可预约', exact: true }).click();
        await assistant.getByRole('button', { name: '预约所选时间', exact: true }).click();
        await assistant.getByRole('button', { name: '确认，预约这个工位', exact: true }).click();
        await expect(assistant.getByRole('status')).toContainText('已预约 1 个半小时段');
        await open(learner);
        await learner.getByRole('button', { name: `${label}，可预约`, exact: true }).click();
        await learner.getByRole('button', { name: '座位 T01，可预约', exact: true }).click();
        await learner.getByRole('button', { name: '预约所选时间', exact: true }).click();
        await learner.getByRole('button', { name: '确认，预约这个工位', exact: true }).click();
        await expect(learner.getByRole('status')).toContainText('已预约 1 个半小时段');
        await learner.goto('/my-reservations');
        await expect(learner.locator('.record-card')).toContainText('T01');
        await expect(learner.getByText(/打卡/)).toHaveCount(0);
    } finally { await Promise.all([staff.close(), member.close()]); }
});
