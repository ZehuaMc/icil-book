import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

// Next initializes this global before loading its request storage when running a server.
Object.assign(globalThis, { AsyncLocalStorage });
const { NextRequest } = await import('next/server');
const require = createRequire(import.meta.url);
const { createRequestStoreForAPI } = require('next/dist/server/async-storage/request-store.js') as typeof import('next/dist/server/async-storage/request-store.js');
const { workUnitAsyncStorage } = require('next/dist/server/app-render/work-unit-async-storage.external.js') as typeof import('next/dist/server/app-render/work-unit-async-storage.external.js');
const { workAsyncStorage } = require('next/dist/server/app-render/work-async-storage.external.js') as typeof import('next/dist/server/app-render/work-async-storage.external.js');
const { createWorkStore } = require('next/dist/server/async-storage/work-store.js') as typeof import('next/dist/server/async-storage/work-store.js');
const route = await import('../src/app/api/[...path]/route');
const { db } = await import('../src/lib/db');

async function call(path: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' = 'GET', raw?: string, headers?: HeadersInit) {
    const request = new NextRequest(`http://localhost:3000/api/${path}`, { method, body: raw, headers });
    const store = createRequestStoreForAPI(request, request.nextUrl, { tags: [], expirationsByCacheKind: new Map() }, undefined, undefined);
    const work = createWorkStore({ page: '/api/[...path]/route', buildId: 'test', previouslyRevalidatedTags: [], renderOpts: { waitUntil: undefined, onClose: () => {}, onAfterTaskError: undefined, supportsDynamicResponse: true, experimental: { cacheComponents: false, authInterrupts: false } } });
    return workAsyncStorage.run(work, () => workUnitAsyncStorage.run(store, () => route[method](request, { params: Promise.resolve({ path: path.split('/') }) })));
}

test('当前用户接口在没有登录 Cookie 时返回 null', async () => {
    const response = await call('auth/me');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { user: null });
    assert.equal(response.headers.get('cache-control'), 'no-store');
});
test('后台、个人记录和写接口拒绝未登录请求', async () => {
    for (const path of ['admin/users', 'admin/stats', 'admin/reservations', 'admin/users/example/reset-password', 'admin/sessions/example/admin-seat', 'auth/change-password', 'groups', 'layouts', 'reservations']) {
        const response = await call(path);
        assert.equal(response.status, 401, path);
    }
    const response = await call('reservations', 'POST', JSON.stringify({ sessionId: 'test', seatId: 'test' }));
    assert.equal(response.status, 401);
});
test('登录注册输入错误返回 400，不触及数据库', async () => {
    for (const [path, data, expected] of [['auth/login', { studentId: 'ab', password: 'x' }, 400], ['auth/register', { studentId: 'valid001', name: '测试用户', password: 'short' }, 400], ['auth/register', { studentId: 'valid001', name: '测试用户', password: 'long-enough-password', role: 'ADMIN' }, 403]] as const) {
        const response = await call(path, 'POST', JSON.stringify(data));
        assert.equal(response.status, expected);
        assert.equal(typeof (await response.json()).error, 'string');
    }
});
test('路由层对非法 JSON、跨站写入与过大流式请求返回对应错误', async () => {
    assert.equal((await call('auth/login', 'POST', '{bad')).status, 400);
    assert.equal((await call('auth/logout', 'POST', '{}', { origin: 'https://other.example' })).status, 403);
    assert.equal((await call('auth/login', 'POST', '"' + 'x'.repeat(1_000_001) + '"')).status, 413);
});
test('没有会话的退出请求可安全重复执行', async () => {
    const response = await call('auth/logout', 'POST');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
});
test('管理员开放重叠时段时合并时间并保留两边预约', async () => {
    const { hashToken } = await import('../src/lib/auth');
    const suffix = randomUUID().replaceAll('-', '').slice(0, 18);
    const group = await db.group.create({ data: { name: `merge-test-${suffix}` } });
    const admin = await db.user.create({ data: { name: '合并测试管理员', studentId: `ma${suffix}`, email: `ma${suffix}@test.local`, passwordHash: 'unused', role: 'ADMIN', groupId: group.id } });
    const otherAdmin = await db.user.create({ data: { name: '另一个管理员', studentId: `mb${suffix}`, email: `mb${suffix}@test.local`, passwordHash: 'unused', role: 'ADMIN', groupId: group.id } });
    const venue = await db.venue.create({ data: { name: `merge-venue-${suffix}`, location: 'test' } });
    const layout = await db.layoutVersion.create({ data: { name: `merge-layout-${suffix}`, venueId: venue.id, status: 'PUBLISHED', seats: { create: [{ code: 'A01', x: 10, y: 10 }, { code: 'A02', x: 20, y: 10 }] } }, include: { seats: true } });
    const course = await db.course.findFirstOrThrow();
    const day = new Date(Date.now() + 3 * 86400000);
    day.setUTCHours(0, 0, 0, 0);
    const startsAt = new Date(day.getTime() + 2 * 3600000), overlapStart = new Date(day.getTime() + 4 * 3600000), firstEnd = new Date(day.getTime() + 6 * 3600000), endsAt = new Date(day.getTime() + 9 * 3600000);
    const target = await db.session.create({ data: { courseId: course.id, layoutId: layout.id, startsAt, endsAt: firstEnd, open: false } });
    const existing = await db.session.create({ data: { courseId: course.id, layoutId: layout.id, startsAt: overlapStart, endsAt, open: true } });
    const reservationStart = new Date(day.getTime() + 4 * 3600000), reservationEnd = new Date(day.getTime() + 5 * 3600000);
    await db.reservation.create({ data: { sessionId: target.id, seatId: layout.seats[0].id, userId: admin.id, startsAt, endsAt: firstEnd } });
    await db.reservation.create({ data: { sessionId: existing.id, seatId: layout.seats[0].id, userId: admin.id, startsAt: reservationStart, endsAt: reservationEnd } });
    await db.reservation.create({ data: { sessionId: existing.id, seatId: layout.seats[1].id, userId: otherAdmin.id, startsAt: reservationStart, endsAt: reservationEnd } });
    const token = randomUUID();
    await db.authSession.create({ data: { id: hashToken(token), userId: admin.id, expiresAt: new Date(Date.now() + 60000) } });
    try {
        const response = await call(`admin/sessions/${target.id}/ready`, 'POST', '{}', { cookie: `station_session=${token}` });
        assert.equal(response.status, 200, await response.clone().text());
        const merged = await db.session.findUniqueOrThrow({ where: { id: target.id } });
        assert.equal(merged.startsAt.getTime(), startsAt.getTime());
        assert.equal(merged.endsAt.getTime(), endsAt.getTime());
        assert.equal(merged.open, true);
        assert.equal(await db.session.count({ where: { id: existing.id, open: true } }), 1);
        assert.equal(await db.reservation.count({ where: { sessionId: target.id, cancelledAt: null } }), 1);
        assert.equal(await db.reservation.count({ where: { sessionId: existing.id, cancelledAt: null } }), 2);
        assert.equal(await db.reservation.count({ where: { sessionId: existing.id, userId: admin.id, cancelledAt: null } }), 1);
    }
    finally {
        await db.authSession.deleteMany({ where: { userId: { in: [admin.id, otherAdmin.id] } } });
        await db.reservation.deleteMany({ where: { sessionId: { in: [target.id, existing.id] } } });
        await db.session.deleteMany({ where: { id: { in: [target.id, existing.id] } } });
        await db.auditLog.deleteMany({ where: { actorId: { in: [admin.id, otherAdmin.id] } } });
        await db.user.deleteMany({ where: { id: { in: [admin.id, otherAdmin.id] } } });
        await db.layoutVersion.delete({ where: { id: layout.id } });
        await db.venue.delete({ where: { id: venue.id } });
        await db.group.delete({ where: { id: group.id } });
    }
});
test('管理员暂停时释放YSYX预约，随后可以更换工位', async () => {
    const { hashToken } = await import('../src/lib/auth');
    const suffix = randomUUID().replaceAll('-', '').slice(0, 18);
    const group = await db.group.create({ data: { name: `seat-change-${suffix}`, canReserve: true, weeklyRules: { create: Array.from({ length: 7 }, (_, weekday) => ({ weekday, startMinute: 0, endMinute: 1440 })) } } });
    const admin = await db.user.create({ data: { name: '换座管理员', studentId: `sa${suffix}`, email: `sa${suffix}@test.local`, passwordHash: 'unused', role: 'ADMIN', groupId: group.id } });
    const learner = await db.user.create({ data: { name: '换座学员', studentId: `su${suffix}`, email: `su${suffix}@test.local`, passwordHash: 'unused', role: 'USER', groupId: group.id } });
    const venue = await db.venue.create({ data: { name: `seat-change-venue-${suffix}`, location: 'test' } });
    const layout = await db.layoutVersion.create({ data: { name: `seat-change-layout-${suffix}`, venueId: venue.id, status: 'PUBLISHED', seats: { create: [{ code: 'A01', x: 10, y: 10 }, { code: 'A02', x: 20, y: 10 }, { code: 'A03', x: 30, y: 10 }] } }, include: { seats: true } });
    const course = await db.course.findFirstOrThrow();
    const startsAt = new Date(Date.now() + 86400000), endsAt = new Date(Date.now() + 86400000 + 2 * 3600000);
    const session = await db.session.create({ data: { courseId: course.id, layoutId: layout.id, startsAt, endsAt, open: false } });
    const adminToken = randomUUID(), learnerToken = randomUUID();
    try {
        const expiresAt = new Date(Date.now() + 60000);
        await db.authSession.createMany({ data: [{ id: hashToken(adminToken), userId: admin.id, expiresAt }, { id: hashToken(learnerToken), userId: learner.id, expiresAt }] });
        const firstSeat = await call(`admin/sessions/${session.id}/admin-seat`, 'PUT', JSON.stringify({ seatId: layout.seats[0].id }), { cookie: `station_session=${adminToken}` });
        assert.equal(firstSeat.status, 200, await firstSeat.clone().text());
        const secondSeat = await call(`admin/sessions/${session.id}/admin-seat`, 'PUT', JSON.stringify({ seatId: layout.seats[1].id }), { cookie: `station_session=${adminToken}` });
        assert.equal(secondSeat.status, 200, await secondSeat.clone().text());
        assert.equal(await db.reservation.count({ where: { sessionId: session.id, userId: admin.id, cancelledAt: null } }), 1);
        assert.equal(await db.reservation.count({ where: { sessionId: session.id, userId: admin.id, cancelledAt: { not: null } } }), 1);

        const opened = await call(`admin/sessions/${session.id}/ready`, 'POST', '{}', { cookie: `station_session=${adminToken}` });
        assert.equal(opened.status, 200, await opened.clone().text());
        const learnerBooking = await call('reservations', 'POST', JSON.stringify({ sessionId: session.id, seatId: layout.seats[0].id, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() }), { cookie: `station_session=${learnerToken}` });
        assert.equal(learnerBooking.status, 200, await learnerBooking.clone().text());
        const blockedChange = await call(`admin/sessions/${session.id}/admin-seat`, 'PUT', JSON.stringify({ seatId: layout.seats[0].id }), { cookie: `station_session=${adminToken}` });
        assert.equal(blockedChange.status, 409);

        const paused = await call(`admin/sessions/${session.id}/ready`, 'DELETE', '{}', { cookie: `station_session=${adminToken}` });
        assert.equal(paused.status, 200, await paused.clone().text());
        const changed = await call(`admin/sessions/${session.id}/admin-seat`, 'PUT', JSON.stringify({ seatId: layout.seats[2].id }), { cookie: `station_session=${adminToken}` });
        assert.equal(changed.status, 200, await changed.clone().text());
        assert.equal(await db.reservation.count({ where: { sessionId: session.id, userId: learner.id, cancelledAt: null } }), 0);
        assert.equal(await db.reservation.count({ where: { sessionId: session.id, userId: learner.id, cancelledAt: { not: null } } }), 1);
        assert.equal(await db.notification.count({ where: { recipientId: learner.id, message: { contains: '管理员暂停' } } }), 1);
        assert.equal((await db.session.findUniqueOrThrow({ where: { id: session.id } })).open, false);
    }
    finally {
        await db.authSession.deleteMany({ where: { userId: { in: [admin.id, learner.id] } } });
        await db.reservation.deleteMany({ where: { sessionId: session.id } });
        await db.session.delete({ where: { id: session.id } });
        await db.auditLog.deleteMany({ where: { actorId: { in: [admin.id, learner.id] } } });
        await db.user.deleteMany({ where: { id: { in: [admin.id, learner.id] } } });
        await db.layoutVersion.delete({ where: { id: layout.id } });
        await db.venue.delete({ where: { id: venue.id } });
        await db.group.delete({ where: { id: group.id } });
    }
});
test('覆盖布局时只改座位权限不会删除原有家具', async () => {
    const { hashToken } = await import('../src/lib/auth');
    const suffix = randomUUID().replaceAll('-', '').slice(0, 18);
    const group = await db.group.create({ data: { name: `layout-overwrite-${suffix}` } });
    const admin = await db.user.create({ data: { name: '布局管理员', studentId: `la${suffix}`, email: `la${suffix}@test.local`, passwordHash: 'unused', role: 'ADMIN', groupId: group.id } });
    const venue = await db.venue.create({ data: { name: `layout-venue-${suffix}`, location: 'test' } });
    const elementId = `source-element-${suffix}`, sourceSeatId = `source-seat-${suffix}`;
    const source = await db.layoutVersion.create({ data: {
        name: `source-layout-${suffix}`, venueId: venue.id, status: 'PUBLISHED', width: 1000, height: 660,
        elements: { create: { id: elementId, kind: 'DESK', label: '原有长桌', x: 100, y: 100, width: 300, height: 100 } },
        seats: { create: { id: sourceSeatId, code: 'A01', x: 150, y: 220, elementId, enabled: true, fixedForAssistant: false } },
    }, include: { elements: true, seats: true } });
    const draftElementId = `draft-element-${suffix}`, draftSeatId = `draft-seat-${suffix}`;
    const draft = await db.layoutVersion.create({ data: {
        name: source.name, venueId: venue.id, sourceLayoutId: source.id, status: 'DRAFT', width: source.width, height: source.height,
        elements: { create: { id: draftElementId, kind: 'DESK', label: '原有长桌', x: 100, y: 100, width: 300, height: 100 } },
        seats: { create: { id: draftSeatId, originId: sourceSeatId, code: 'A01', x: 150, y: 220, elementId: draftElementId, enabled: true, fixedForAssistant: true } },
    } });
    const token = randomUUID();
    await db.authSession.create({ data: { id: hashToken(token), userId: admin.id, expiresAt: new Date(Date.now() + 60000) } });
    try {
        const response = await call(`layouts/${source.id}/overwrite`, 'POST', JSON.stringify({ draftId: draft.id }), { cookie: `station_session=${token}` });
        assert.equal(response.status, 200, await response.clone().text());
        const updated = await db.layoutVersion.findUniqueOrThrow({ where: { id: source.id }, include: { elements: true, seats: true } });
        assert.equal(updated.elements.length, 1);
        assert.equal(updated.elements[0].label, '原有长桌');
        assert.equal(updated.seats[0].fixedForAssistant, true);
        assert.equal(updated.seats[0].elementId, updated.elements[0].id);
    }
    finally {
        await db.authSession.deleteMany({ where: { userId: admin.id } });
        await db.auditLog.deleteMany({ where: { actorId: admin.id } });
        await db.layoutVersion.deleteMany({ where: { id: { in: [source.id, draft.id] } } });
        await db.user.delete({ where: { id: admin.id } });
        await db.venue.delete({ where: { id: venue.id } });
        await db.group.delete({ where: { id: group.id } });
    }
});
test('ICIL全天预约不受管理员开放时段限制，但管理员禁用的区间不可预约', async () => {
    const { hashToken } = await import('../src/lib/auth');
    const suffix = randomUUID().replaceAll('-', '').slice(0, 18);
    const group = await db.group.create({ data: { name: `member-rule-${suffix}`, canReserve: false } });
    const admin = await db.user.create({ data: { name: '时段管理员', studentId: `ad${suffix}`, email: `ad${suffix}@test.local`, passwordHash: 'unused', role: 'ADMIN', groupId: group.id } });
    const icil = await db.user.create({ data: { name: 'ICIL成员', studentId: `ic${suffix}`, email: `ic${suffix}@test.local`, passwordHash: 'unused', role: 'USER', memberType: 'ICIL', groupId: group.id } });
    const ysyx = await db.user.create({ data: { name: 'YSYX成员', studentId: `ys${suffix}`, email: `ys${suffix}@test.local`, passwordHash: 'unused', role: 'USER', groupId: group.id } });
    const venue = await db.venue.create({ data: { name: `member-venue-${suffix}`, location: 'test' } });
    const layout = await db.layoutVersion.create({ data: { name: `member-layout-${suffix}`, venueId: venue.id, status: 'PUBLISHED', seats: { create: [{ code: 'A01', x: 10, y: 10 }] } }, include: { seats: true } });
    const course = await db.course.findFirstOrThrow();
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(tomorrow);
    const adminSlotStart = new Date(`${date}T10:00:00+08:00`), adminSlotEnd = new Date(`${date}T11:00:00+08:00`);
    const adminSession = await db.session.create({ data: { courseId: course.id, layoutId: layout.id, startsAt: adminSlotStart, endsAt: adminSlotEnd, open: false } });
    await db.reservation.create({ data: { sessionId: adminSession.id, seatId: layout.seats[0].id, userId: admin.id, startsAt: adminSlotStart, endsAt: adminSlotEnd } });
    const icilToken = randomUUID(), ysyxToken = randomUUID(), adminToken = randomUUID();
    let icilSessionId = '';
    try {
        const expiresAt = new Date(Date.now() + 60_000);
        await db.authSession.createMany({ data: [{ id: hashToken(icilToken), userId: icil.id, expiresAt }, { id: hashToken(ysyxToken), userId: ysyx.id, expiresAt }, { id: hashToken(adminToken), userId: admin.id, expiresAt }] });
        const icilSessions = await call('sessions', 'GET', undefined, { cookie: `station_session=${icilToken}` });
        assert.equal(icilSessions.status, 200);
        const icilData = await icilSessions.json();
        const icilSession = icilData.sessions.find((item: { icilOnly: boolean; layoutId: string; startsAt: string }) => item.icilOnly && item.layoutId === layout.id && new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(item.startsAt)) === date);
        assert.ok(icilSession);
        assert.ok(icilSession.staffPresenceWindows.some((window: { startsAt: string; endsAt: string }) => new Date(window.startsAt).getTime() === adminSlotStart.getTime() && new Date(window.endsAt).getTime() === adminSlotEnd.getTime()));
        icilSessionId = icilSession.id;
        assert.ok(!icilData.sessions.some((item: { id: string }) => item.id === adminSession.id));
        const ysyxSessions = await call('sessions', 'GET', undefined, { cookie: `station_session=${ysyxToken}` });
        assert.equal(ysyxSessions.status, 200);
        assert.ok(!(await ysyxSessions.json()).sessions.some((item: { id: string }) => item.id === icilSessionId || item.id === adminSession.id));
        const startsAt = new Date(`${date}T13:17:00+08:00`), endsAt = new Date(`${date}T13:43:00+08:00`);
        const icilBooking = await call('reservations', 'POST', JSON.stringify({ sessionId: icilSessionId, seatId: layout.seats[0].id, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() }), { cookie: `station_session=${icilToken}` });
        assert.equal(icilBooking.status, 200, await icilBooking.clone().text());
        const ysyxStart = new Date(`${date}T10:17:00+08:00`), ysyxEnd = new Date(`${date}T10:43:00+08:00`);
        const ysyxBooking = await call('reservations', 'POST', JSON.stringify({ sessionId: adminSession.id, seatId: layout.seats[0].id, startsAt: ysyxStart.toISOString(), endsAt: ysyxEnd.toISOString() }), { cookie: `station_session=${ysyxToken}` });
        assert.equal(ysyxBooking.status, 403, await ysyxBooking.clone().text());
        const blockedStart = new Date(`${date}T11:17:00+08:00`), blockedEnd = new Date(`${date}T11:43:00+08:00`);
        await db.bookingBlock.create({ data: { kind: 'SESSION', startsAt: blockedStart, endsAt: blockedEnd, sessionId: adminSession.id, reason: '管理员禁用', createdById: admin.id } });
        const blockedBooking = await call('reservations', 'POST', JSON.stringify({ sessionId: icilSessionId, seatId: layout.seats[0].id, startsAt: blockedStart.toISOString(), endsAt: blockedEnd.toISOString() }), { cookie: `station_session=${icilToken}` });
        assert.equal(blockedBooking.status, 403, await blockedBooking.clone().text());
    }
    finally {
        await db.authSession.deleteMany({ where: { userId: { in: [admin.id, icil.id, ysyx.id] } } });
        await db.reservation.deleteMany({ where: { sessionId: { in: [icilSessionId, adminSession.id] } } });
        await db.bookingBlock.deleteMany({ where: { sessionId: adminSession.id } });
        if (icilSessionId) await db.session.delete({ where: { id: icilSessionId } });
        await db.session.delete({ where: { id: adminSession.id } });
        await db.session.deleteMany({ where: { layoutId: layout.id, icilOnly: true } });
        await db.auditLog.deleteMany({ where: { actorId: { in: [admin.id, icil.id, ysyx.id] } } });
        await db.user.deleteMany({ where: { id: { in: [admin.id, icil.id, ysyx.id] } } });
        await db.layoutVersion.delete({ where: { id: layout.id } });
        await db.venue.delete({ where: { id: venue.id } });
        await db.group.delete({ where: { id: group.id } });
    }
});
test('发布布局同步最近的未来空时段，已有预约的时段保留原布局', async () => {
    const { hashToken } = await import('../src/lib/auth');
    const suffix = randomUUID().replaceAll('-', '').slice(0, 18);
    const group = await db.group.create({ data: { name: `layout-sync-${suffix}` } });
    const admin = await db.user.create({ data: { name: '布局同步管理员', studentId: `ls${suffix}`, email: `ls${suffix}@test.local`, passwordHash: 'unused', role: 'ADMIN', groupId: group.id } });
    const learner = await db.user.create({ data: { name: '布局同步学员', studentId: `lu${suffix}`, email: `lu${suffix}@test.local`, passwordHash: 'unused', role: 'USER', groupId: group.id } });
    const venue = await db.venue.create({ data: { name: `layout-sync-venue-${suffix}`, location: 'test' } });
    const source = await db.layoutVersion.create({ data: { name: `old-${suffix}`, venueId: venue.id, status: 'PUBLISHED', seats: { create: { code: 'A01', x: 10, y: 10 } } }, include: { seats: true } });
    const draft = await db.layoutVersion.create({ data: { name: `new-${suffix}`, venueId: venue.id, sourceLayoutId: source.id, status: 'DRAFT', seats: { create: { code: 'A01', x: 80, y: 80 } } }, include: { seats: true } });
    const course = await db.course.findFirstOrThrow();
    const nearest = new Date(Date.now() + 3 * 3600000), later = new Date(Date.now() + 6 * 3600000);
    const nearestSession = await db.session.create({ data: { courseId: course.id, layoutId: source.id, startsAt: nearest, endsAt: new Date(nearest.getTime() + 3600000) } });
    const bookedSession = await db.session.create({ data: { courseId: course.id, layoutId: source.id, startsAt: later, endsAt: new Date(later.getTime() + 3600000) } });
    const booking = await db.reservation.create({ data: { sessionId: bookedSession.id, seatId: source.seats[0].id, userId: learner.id, startsAt: later, endsAt: new Date(later.getTime() + 3600000) } });
    const token = randomUUID();
    try {
        await db.authSession.create({ data: { id: hashToken(token), userId: admin.id, expiresAt: new Date(Date.now() + 60_000) } });
        const response = await call(`layouts/${draft.id}/publish`, 'POST', '{}', { cookie: `station_session=${token}` });
        assert.equal(response.status, 200, await response.clone().text());
        assert.equal((await db.session.findUniqueOrThrow({ where: { id: nearestSession.id } })).layoutId, draft.id);
        assert.equal((await db.session.findUniqueOrThrow({ where: { id: bookedSession.id } })).layoutId, source.id);
        assert.equal((await db.reservation.findUniqueOrThrow({ where: { id: booking.id } })).seatId, source.seats[0].id);
    }
    finally {
        await db.authSession.deleteMany({ where: { userId: admin.id } });
        await db.reservation.deleteMany({ where: { sessionId: { in: [nearestSession.id, bookedSession.id] } } });
        await db.session.deleteMany({ where: { id: { in: [nearestSession.id, bookedSession.id] } } });
        await db.auditLog.deleteMany({ where: { actorId: admin.id } });
        await db.user.deleteMany({ where: { id: { in: [admin.id, learner.id] } } });
        await db.layoutVersion.deleteMany({ where: { id: { in: [source.id, draft.id] } } });
        await db.venue.delete({ where: { id: venue.id } });
        await db.group.delete({ where: { id: group.id } });
    }
});
test('暂停时段且没有有效预约后可以删除关联布局', async () => {
    const { hashToken } = await import('../src/lib/auth');
    const suffix = randomUUID().replaceAll('-', '').slice(0, 18);
    const group = await db.group.create({ data: { name: `layout-delete-${suffix}` } });
    const admin = await db.user.create({ data: { name: '布局删除管理员', studentId: `ld${suffix}`, email: `ld${suffix}@test.local`, passwordHash: 'unused', role: 'ADMIN', groupId: group.id } });
    const learner = await db.user.create({ data: { name: '布局删除学员', studentId: `le${suffix}`, email: `le${suffix}@test.local`, passwordHash: 'unused', role: 'USER', groupId: group.id } });
    const venue = await db.venue.create({ data: { name: `layout-delete-venue-${suffix}`, location: 'test' } });
    const layout = await db.layoutVersion.create({ data: { name: `layout-delete-${suffix}`, venueId: venue.id, status: 'PUBLISHED', seats: { create: [{ code: 'A01', x: 10, y: 10 }, { code: 'A02', x: 20, y: 10 }] } }, include: { seats: true } });
    const course = await db.course.findFirstOrThrow();
    const startsAt = new Date(Date.now() + 86400000), endsAt = new Date(Date.now() + 90000000);
    const session = await db.session.create({ data: { courseId: course.id, layoutId: layout.id, startsAt, endsAt, open: false } });
    const token = randomUUID();
    try {
        await db.reservation.create({ data: { sessionId: session.id, seatId: layout.seats[0].id, userId: learner.id, startsAt, endsAt, cancelledAt: new Date() } });
        await db.reservation.create({ data: { sessionId: session.id, seatId: layout.seats[0].id, userId: admin.id, startsAt, endsAt } });
        const activeLearnerReservation = await db.reservation.create({ data: { sessionId: session.id, seatId: layout.seats[1].id, userId: learner.id, startsAt, endsAt } });
        await db.authSession.create({ data: { id: hashToken(token), userId: admin.id, expiresAt: new Date(Date.now() + 60000) } });
        const blocked = await call(`layouts/${layout.id}`, 'DELETE', undefined, { cookie: `station_session=${token}` });
        assert.equal(blocked.status, 409);
        await db.reservation.update({ where: { id: activeLearnerReservation.id }, data: { cancelledAt: new Date() } });
        const response = await call(`layouts/${layout.id}`, 'DELETE', undefined, { cookie: `station_session=${token}` });
        assert.equal(response.status, 200, await response.clone().text());
        assert.equal(await db.layoutVersion.count({ where: { id: layout.id } }), 0);
        assert.equal(await db.session.count({ where: { id: session.id } }), 0);
        assert.equal(await db.auditLog.count({ where: { actorId: admin.id, action: 'LAYOUT_DELETE', target: layout.id } }), 1);
    }
    finally {
        await db.authSession.deleteMany({ where: { userId: admin.id } });
        await db.reservation.deleteMany({ where: { sessionId: session.id } });
        await db.session.deleteMany({ where: { id: session.id } });
        await db.auditLog.deleteMany({ where: { actorId: admin.id } });
        await db.user.deleteMany({ where: { id: { in: [admin.id, learner.id] } } });
        await db.layoutVersion.deleteMany({ where: { id: layout.id } });
        await db.venue.delete({ where: { id: venue.id } });
        await db.group.delete({ where: { id: group.id } });
    }
});
test('ICIL成员改回YSYX后没有管理员值守的预约会自动释放', async () => {
    const { hashToken } = await import('../src/lib/auth');
    const suffix = randomUUID().replaceAll('-', '').slice(0, 18);
    const group = await db.group.create({ data: { name: `downgrade-${suffix}`, canReserve: true, weeklyRules: { create: Array.from({ length: 7 }, (_, weekday) => ({ weekday, startMinute: 0, endMinute: 1440 })) } } });
    const admin = await db.user.create({ data: { name: '降级管理员', studentId: `da${suffix}`, email: `da${suffix}@test.local`, passwordHash: 'unused', role: 'ADMIN', groupId: group.id } });
    const member = await db.user.create({ data: { name: '降级成员', studentId: `dm${suffix}`, email: `dm${suffix}@test.local`, passwordHash: 'unused', role: 'USER', memberType: 'ICIL', groupId: group.id } });
    const venue = await db.venue.create({ data: { name: `downgrade-venue-${suffix}`, location: 'test' } });
    const layout = await db.layoutVersion.create({ data: { name: `downgrade-layout-${suffix}`, venueId: venue.id, status: 'PUBLISHED', seats: { create: [{ code: 'A01', x: 10, y: 10 }, { code: 'A02', x: 20, y: 10 }] } }, include: { seats: true } });
    const course = await db.course.findFirstOrThrow();
    const start = new Date(Date.now() + 4 * 3600000), end = new Date(Date.now() + 5 * 3600000);
    const staffed = await db.session.create({ data: { courseId: course.id, layoutId: layout.id, startsAt: start, endsAt: end, open: true } });
    const unstaffed = await db.session.create({ data: { courseId: course.id, layoutId: layout.id, startsAt: new Date(start.getTime() + 2 * 3600000), endsAt: new Date(end.getTime() + 2 * 3600000), open: true } });
    await db.reservation.createMany({ data: [
        { sessionId: staffed.id, seatId: layout.seats[0].id, userId: member.id, startsAt: start, endsAt: end },
        { sessionId: unstaffed.id, seatId: layout.seats[1].id, userId: member.id, startsAt: new Date(start.getTime() + 2 * 3600000), endsAt: new Date(end.getTime() + 2 * 3600000) },
        { sessionId: staffed.id, seatId: layout.seats[1].id, userId: admin.id, startsAt: start, endsAt: end },
    ] });
    const token = randomUUID();
    try {
        await db.authSession.create({ data: { id: hashToken(token), userId: admin.id, expiresAt: new Date(Date.now() + 60000) } });
        const response = await call(`admin/users/${member.id}`, 'PATCH', JSON.stringify({ name: member.name, role: 'USER', memberType: 'YSYX', enabled: true, groupId: group.id }), { cookie: `station_session=${token}` });
        assert.equal(response.status, 200, await response.clone().text());
        assert.equal(await db.reservation.count({ where: { sessionId: staffed.id, userId: member.id, cancelledAt: null } }), 1);
        assert.equal(await db.reservation.count({ where: { sessionId: unstaffed.id, userId: member.id, cancelledAt: null } }), 0);
        assert.equal(await db.reservation.count({ where: { sessionId: unstaffed.id, userId: member.id, cancelledAt: { not: null } } }), 1);
        assert.equal(await db.notification.count({ where: { recipientId: member.id, type: 'BOOKING_CANCELLED' } }), 1);
    }
    finally {
        await db.authSession.deleteMany({ where: { userId: { in: [admin.id, member.id] } } });
        await db.notification.deleteMany({ where: { recipientId: member.id } });
        await db.reservation.deleteMany({ where: { sessionId: { in: [staffed.id, unstaffed.id] } } });
        await db.session.deleteMany({ where: { id: { in: [staffed.id, unstaffed.id] } } });
        await db.auditLog.deleteMany({ where: { actorId: { in: [admin.id, member.id] } } });
        await db.user.deleteMany({ where: { id: { in: [admin.id, member.id] } } });
        await db.layoutVersion.delete({ where: { id: layout.id } });
        await db.venue.delete({ where: { id: venue.id } });
        await db.group.delete({ where: { id: group.id } });
    }
});
test('管理员只能重置学员密码，学员可改密且只保留当前会话', async () => {
    const { hash, compare } = await import('bcryptjs');
    const { hashToken } = await import('../src/lib/auth');
    const suffix = randomUUID().replaceAll('-', '').slice(0, 18);
    const group = await db.group.create({ data: { name: `password-test-${suffix}` } });
    const admin = await db.user.create({ data: { name: '密码测试管理员', studentId: `pa${suffix}`, email: `pa${suffix}@test.local`, passwordHash: 'unused', role: 'ADMIN', groupId: group.id } });
    const learner = await db.user.create({ data: { name: '密码测试学员', studentId: `pu${suffix}`, email: `pu${suffix}@test.local`, passwordHash: await hash('initial-password-123', 12), role: 'USER', groupId: group.id } });
    const adminToken = randomUUID(), learnerToken = randomUUID(), otherLearnerToken = randomUUID();
    try {
        const expiresAt = new Date(Date.now() + 60_000);
        await db.authSession.createMany({ data: [
            { id: hashToken(adminToken), userId: admin.id, expiresAt },
            { id: hashToken(learnerToken), userId: learner.id, expiresAt },
            { id: hashToken(otherLearnerToken), userId: learner.id, expiresAt },
        ] });
        const reset = await call(`admin/users/${learner.id}/reset-password`, 'POST', '{}', { cookie: `station_session=${adminToken}` });
        assert.equal(reset.status, 200);
        assert.deepEqual(await reset.json(), { ok: true });
        const resetAccount = await db.user.findUniqueOrThrow({ where: { id: learner.id } });
        assert.equal(await compare('123456', resetAccount.passwordHash), true);
        assert.notEqual(resetAccount.passwordHash, '123456');
        assert.deepEqual(await db.authSession.findMany({ where: { userId: learner.id } }), []);
        const denied = await call(`admin/users/${admin.id}/reset-password`, 'POST', '{}', { cookie: `station_session=${adminToken}` });
        assert.equal(denied.status, 403);

        await db.authSession.createMany({ data: [
            { id: hashToken(learnerToken), userId: learner.id, expiresAt },
            { id: hashToken(otherLearnerToken), userId: learner.id, expiresAt },
        ] });
        const changed = await call('auth/change-password', 'POST', JSON.stringify({ currentPassword: '123456', newPassword: 'updated-password-123' }), { cookie: `station_session=${learnerToken}` });
        assert.equal(changed.status, 200);
        const changedAccount = await db.user.findUniqueOrThrow({ where: { id: learner.id } });
        assert.equal(await compare('updated-password-123', changedAccount.passwordHash), true);
        assert.deepEqual((await db.authSession.findMany({ where: { userId: learner.id } })).map(session => session.id), [hashToken(learnerToken)]);
    }
    finally {
        await db.authSession.deleteMany({ where: { userId: { in: [admin.id, learner.id] } } });
        await db.auditLog.deleteMany({ where: { actorId: { in: [admin.id, learner.id] } } });
        await db.user.deleteMany({ where: { id: { in: [admin.id, learner.id] } } });
        await db.group.delete({ where: { id: group.id } });
    }
});
test('已注销的学员和管理员可用相同学号重新注册并登录', async () => {
    const prefix = randomUUID().replaceAll('-', '').slice(0, 12);
    const { db } = await import('../src/lib/db');
    const { hashToken } = await import('../src/lib/auth');
    const previousSettings = await db.appSetting.findUnique({ where: { id: 'main' } });
    const group = await db.group.create({ data: { name: `reregister-${prefix}` } });
    const roles = ['USER', 'ADMIN'] as const;
    const accounts: { id: string; studentId: string; role: typeof roles[number] }[] = [];
    try {
        await db.appSetting.upsert({ where: { id: 'main' }, create: { id: 'main', defaultGroupId: group.id }, update: { defaultGroupId: group.id } });
        for (const role of roles) {
            const studentId = `rr${prefix}${role === 'ADMIN' ? 'a' : 'u'}`;
            const firstPassword = 'before-delete-password';
            const nextPassword = 'after-delete-password';
            const adminKey = process.env.ADMIN_REGISTRATION_KEY ?? 'icilxysyx';
            const payload = (name: string, password: string) => role === 'ADMIN'
                ? { studentId, name, role, adminKey }
                : { studentId, name, role, password };

            const first = await call('auth/register', 'POST', JSON.stringify(payload('注销前账号', firstPassword)));
            assert.equal(first.status, 200, role);
            const original = (await first.json()).user;
            accounts.push({ id: original.id, studentId, role });
            await db.authSession.deleteMany({ where: { userId: original.id } });
            await db.user.update({ where: { id: original.id }, data: { enabled: false, deletedAt: new Date() } });

            const renewed = await call('auth/register', 'POST', JSON.stringify(payload('重新注册账号', nextPassword)));
            assert.equal(renewed.status, 200, role);
            const renewedUser = (await renewed.json()).user;
            assert.equal(renewedUser.id, original.id);
            assert.equal(renewedUser.enabled, true);
            assert.equal(renewedUser.deletedAt, null);
            assert.equal(renewedUser.name, '重新注册账号');

            const login = await call('auth/login', 'POST', JSON.stringify(role === 'ADMIN' ? { studentId, role, adminKey } : { studentId, role, password: nextPassword }));
            assert.equal(login.status, 200, role);
            assert.equal((await login.json()).user.id, original.id);
            await db.authSession.deleteMany({ where: { userId: original.id } });
        }
    }
    finally {
        await db.authSession.deleteMany({ where: { userId: { in: accounts.map(a => a.id) } } });
        for (const account of accounts) {
            const roleName = account.role;
            const limiterKeys = ['auth/register', 'auth/login'].map(key => `${key}:${roleName}:${hashToken(account.studentId)}`);
            await db.loginAttempt.deleteMany({ where: { key: { in: limiterKeys } } });
        }
        await db.user.deleteMany({ where: { id: { in: accounts.map(a => a.id) } } });
        if (previousSettings)
            await db.appSetting.update({ where: { id: 'main' }, data: { defaultGroupId: previousSettings.defaultGroupId } });
        else
            await db.appSetting.deleteMany({ where: { id: 'main' } });
        await db.group.delete({ where: { id: group.id } });
        await db.$disconnect();
    }
});
test.after(() => db.$disconnect());
