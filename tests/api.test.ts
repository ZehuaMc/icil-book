import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

assert.ok(process.env.DATABASE_URL, 'DATABASE_URL 未设置：请配置并初始化专用测试数据库');

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
const { localParts } = await import('../src/lib/rules');

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
    for (const path of ['admin/users', 'admin/stats', 'admin/reservations', 'admin/booking-blocks', 'admin/logs', 'layouts', 'reservations', 'notifications']) {
        const response = await call(path);
        assert.equal(response.status, 401, path);
    }
    const response = await call('reservations', 'POST', JSON.stringify({ sessionId: 'test', seatId: 'test' }));
    assert.equal(response.status, 401);
});
test('登录注册拒绝非法学号、短密码和管理员注册', async () => {
    const studentId = `invalid${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const { hashToken } = await import('../src/lib/auth');
    try {
        for (const [path, data, expected] of [['auth/login', { studentId: 'ab', password: 'x' }, 400], ['auth/register', { studentId, name: '测试用户', password: 'short' }, 400], ['auth/register', { studentId, name: '测试用户', password: 'long-enough-password', role: 'ADMIN' }, 403]] as const) {
            const response = await call(path, 'POST', JSON.stringify(data));
            assert.equal(response.status, expected);
            assert.equal(typeof (await response.json()).error, 'string');
        }
    } finally {
        await db.loginAttempt.deleteMany({ where: { key: `auth/register:${hashToken(studentId)}` } });
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
test('自动日期入口执行助教完整覆盖检查，ICIL可直接预约并受禁止时间限制', async () => {
    const { hashToken } = await import('../src/lib/auth');
    const suffix = randomUUID().replaceAll('-', '').slice(0, 18);
    const group = await db.group.create({ data: { name: `member-rule-${suffix}` } });
    const admin = await db.user.create({ data: { name: '时段管理员', studentId: `ad${suffix}`, email: `ad${suffix}@test.local`, passwordHash: 'unused', role: 'ADMIN', groupId: group.id } });
    const assistant = await db.user.create({ data: { name: '时段助教', studentId: `at${suffix}`, email: `at${suffix}@test.local`, passwordHash: 'unused', role: 'ASSISTANT', groupId: group.id } });
    const icil = await db.user.create({ data: { name: 'ICIL成员', studentId: `ic${suffix}`, email: `ic${suffix}@test.local`, passwordHash: 'unused', role: 'USER', memberType: 'ICIL', groupId: group.id } });
    const ysyx = await db.user.create({ data: { name: 'YSYX成员', studentId: `ys${suffix}`, email: `ys${suffix}@test.local`, passwordHash: 'unused', role: 'USER', groupId: group.id } });
    const venue = await db.venue.create({ data: { name: `member-venue-${suffix}`, location: 'test' } });
    const layout = await db.layoutVersion.create({ data: { name: `member-layout-${suffix}`, venueId: venue.id, status: 'PUBLISHED', seats: { create: [{ code: 'A01', x: 10, y: 10 }, { code: 'A02', x: 40, y: 10 }] } }, include: { seats: true } });
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(tomorrow);
    const adminSlotStart = new Date(`${date}T10:00:00+08:00`), adminSlotEnd = new Date(`${date}T11:00:00+08:00`);
    const adminSession = await db.session.create({ data: { layoutId: layout.id, startsAt: adminSlotStart, endsAt: adminSlotEnd, open: false } });
    await db.reservation.create({ data: { sessionId: adminSession.id, seatId: layout.seats[0].id, userId: assistant.id, startsAt: adminSlotStart, endsAt: adminSlotEnd } });
    const icilToken = randomUUID(), ysyxToken = randomUUID(), adminToken = randomUUID();
    let icilSessionId = '', ysyxSessionId = '';
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
        const ysyxData = await ysyxSessions.json();
        const ysyxDaySession = ysyxData.sessions.find((item: { icilOnly: boolean; layoutId: string; startsAt: string }) => item.icilOnly && item.layoutId === layout.id && new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(item.startsAt)) === date);
        assert.ok(ysyxDaySession);
        ysyxSessionId = ysyxDaySession.id;
        assert.ok(!ysyxData.sessions.some((item: { id: string }) => item.id === adminSession.id));
        const offGridStart = new Date(`${date}T13:17:00+08:00`), offGridEnd = new Date(`${date}T13:47:00+08:00`);
        const offGridBooking = await call('reservations', 'POST', JSON.stringify({ sessionId: icilSessionId, seatId: layout.seats[0].id, startsAt: offGridStart.toISOString(), endsAt: offGridEnd.toISOString() }), { cookie: `station_session=${icilToken}` });
        assert.equal(offGridBooking.status, 400);
        const startsAt = new Date(`${date}T13:30:00+08:00`), endsAt = new Date(`${date}T14:30:00+08:00`);
        const icilBooking = await call('reservations', 'POST', JSON.stringify({ sessionId: icilSessionId, seatId: layout.seats[0].id, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() }), { cookie: `station_session=${icilToken}` });
        assert.equal(icilBooking.status, 200, await icilBooking.clone().text());
        const secondBooking = await call('reservations/batch', 'POST', JSON.stringify({ sessionId: icilSessionId, seatId: layout.seats[1].id, slots: [
            { startsAt: new Date(`${date}T15:00:00+08:00`).toISOString(), endsAt: new Date(`${date}T15:30:00+08:00`).toISOString() },
            { startsAt: new Date(`${date}T16:00:00+08:00`).toISOString(), endsAt: new Date(`${date}T16:30:00+08:00`).toISOString() },
        ] }), { cookie: `station_session=${icilToken}` });
        assert.equal(secondBooking.status, 200, await secondBooking.clone().text());
        const ysyxStart = new Date(`${date}T11:30:00+08:00`), ysyxEnd = new Date(`${date}T12:00:00+08:00`);
        const ysyxBooking = await call('reservations', 'POST', JSON.stringify({ sessionId: ysyxDaySession.id, seatId: layout.seats[1].id, startsAt: ysyxStart.toISOString(), endsAt: ysyxEnd.toISOString() }), { cookie: `station_session=${ysyxToken}` });
        assert.equal(ysyxBooking.status, 403, await ysyxBooking.clone().text());
        const coveredBooking = await call('reservations', 'POST', JSON.stringify({ sessionId: ysyxDaySession.id, seatId: layout.seats[1].id, startsAt: adminSlotStart.toISOString(), endsAt: adminSlotEnd.toISOString() }), { cookie: `station_session=${ysyxToken}` });
        assert.equal(coveredBooking.status, 200, await coveredBooking.clone().text());
        const blockedStart = new Date(`${date}T11:30:00+08:00`), blockedEnd = new Date(`${date}T12:00:00+08:00`);
        await db.bookingBlock.create({ data: { kind: 'SESSION', startsAt: blockedStart, endsAt: blockedEnd, sessionId: adminSession.id, reason: '管理员禁用', createdById: admin.id } });
        const blockedBooking = await call('reservations', 'POST', JSON.stringify({ sessionId: icilSessionId, seatId: layout.seats[0].id, startsAt: blockedStart.toISOString(), endsAt: blockedEnd.toISOString() }), { cookie: `station_session=${icilToken}` });
        assert.equal(blockedBooking.status, 403, await blockedBooking.clone().text());
    }
    finally {
        await db.authSession.deleteMany({ where: { userId: { in: [admin.id, assistant.id, icil.id, ysyx.id] } } });
        await db.reservation.deleteMany({ where: { sessionId: { in: [icilSessionId, ysyxSessionId, adminSession.id] } } });
        await db.bookingBlock.deleteMany({ where: { sessionId: adminSession.id } });
        if (icilSessionId) await db.session.delete({ where: { id: icilSessionId } });
        if (ysyxSessionId && ysyxSessionId !== icilSessionId) await db.session.delete({ where: { id: ysyxSessionId } });
        await db.session.delete({ where: { id: adminSession.id } });
        await db.session.deleteMany({ where: { layoutId: layout.id, icilOnly: true } });
        await db.auditLog.deleteMany({ where: { actorId: { in: [admin.id, icil.id, ysyx.id] } } });
        await db.user.deleteMany({ where: { id: { in: [admin.id, assistant.id, icil.id, ysyx.id] } } });
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
    const nearest = new Date(Date.now() + 3 * 3600000), later = new Date(Date.now() + 6 * 3600000);
    const nearestSession = await db.session.create({ data: { layoutId: source.id, startsAt: nearest, endsAt: new Date(nearest.getTime() + 3600000) } });
    const bookedSession = await db.session.create({ data: { layoutId: source.id, startsAt: later, endsAt: new Date(later.getTime() + 3600000) } });
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
    const startsAt = new Date(Date.now() + 86400000), endsAt = new Date(Date.now() + 90000000);
    const session = await db.session.create({ data: { layoutId: layout.id, startsAt, endsAt, open: false } });
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
test('ICIL改回YSYX后，仅保留有助教完整预约覆盖的记录', async () => {
    const { hashToken } = await import('../src/lib/auth');
    const suffix = randomUUID().replaceAll('-', '').slice(0, 18);
    const group = await db.group.create({ data: { name: `downgrade-${suffix}` } });
    const admin = await db.user.create({ data: { name: '降级管理员', studentId: `da${suffix}`, email: `da${suffix}@test.local`, passwordHash: 'unused', role: 'ADMIN', groupId: group.id } });
    const assistant = await db.user.create({ data: { name: '降级测试助教', studentId: `dt${suffix}`, email: `dt${suffix}@test.local`, passwordHash: 'unused', role: 'ASSISTANT', groupId: group.id } });
    const member = await db.user.create({ data: { name: '降级成员', studentId: `dm${suffix}`, email: `dm${suffix}@test.local`, passwordHash: 'unused', role: 'USER', memberType: 'ICIL', groupId: group.id } });
    const venue = await db.venue.create({ data: { name: `downgrade-venue-${suffix}`, location: 'test' } });
    const layout = await db.layoutVersion.create({ data: { name: `downgrade-layout-${suffix}`, venueId: venue.id, status: 'PUBLISHED', seats: { create: [{ code: 'A01', x: 10, y: 10 }, { code: 'A02', x: 20, y: 10 }] } }, include: { seats: true } });
    const start = new Date(Date.now() + 4 * 3600000), end = new Date(Date.now() + 5 * 3600000);
    const staffed = await db.session.create({ data: { layoutId: layout.id, startsAt: start, endsAt: end, open: true } });
    const unstaffed = await db.session.create({ data: { layoutId: layout.id, startsAt: new Date(start.getTime() + 2 * 3600000), endsAt: new Date(end.getTime() + 2 * 3600000), open: true } });
    await db.reservation.createMany({ data: [
        { sessionId: staffed.id, seatId: layout.seats[0].id, userId: member.id, startsAt: start, endsAt: end },
        { sessionId: unstaffed.id, seatId: layout.seats[1].id, userId: member.id, startsAt: new Date(start.getTime() + 2 * 3600000), endsAt: new Date(end.getTime() + 2 * 3600000) },
        { sessionId: staffed.id, seatId: layout.seats[1].id, userId: assistant.id, startsAt: start, endsAt: end },
    ] });
    const token = randomUUID();
    try {
        await db.authSession.create({ data: { id: hashToken(token), userId: admin.id, expiresAt: new Date(Date.now() + 60000) } });
        const response = await call(`admin/users/${member.id}`, 'PATCH', JSON.stringify({ name: member.name, role: 'USER', memberType: 'YSYX', enabled: true }), { cookie: `station_session=${token}` });
        assert.equal(response.status, 200, await response.clone().text());
        assert.equal(await db.reservation.count({ where: { sessionId: staffed.id, userId: member.id, cancelledAt: null } }), 1);
        assert.equal(await db.reservation.count({ where: { sessionId: unstaffed.id, userId: member.id, cancelledAt: null } }), 0);
        assert.equal(await db.reservation.count({ where: { sessionId: unstaffed.id, userId: member.id, cancelledAt: { not: null } } }), 1);
        assert.equal(await db.notification.count({ where: { recipientId: member.id, type: 'BOOKING_CANCELLED' } }), 1);
    }
    finally {
        await db.authSession.deleteMany({ where: { userId: { in: [admin.id, assistant.id, member.id] } } });
        await db.notification.deleteMany({ where: { recipientId: member.id } });
        await db.reservation.deleteMany({ where: { sessionId: { in: [staffed.id, unstaffed.id] } } });
        await db.session.deleteMany({ where: { id: { in: [staffed.id, unstaffed.id] } } });
        await db.auditLog.deleteMany({ where: { actorId: { in: [admin.id, assistant.id, member.id] } } });
        await db.user.deleteMany({ where: { id: { in: [admin.id, assistant.id, member.id] } } });
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
test('已注销的学员可用相同学号重新注册并登录，管理员不可注册', async () => {
    const prefix = randomUUID().replaceAll('-', '').slice(0, 12);
    const { db } = await import('../src/lib/db');
    const { hashToken } = await import('../src/lib/auth');
    const roles = ['USER'] as const;
    const accounts: { id: string; studentId: string; role: typeof roles[number] }[] = [];
    try {
        for (const role of roles) {
            const studentId = `rr${prefix}u`;
            const firstPassword = 'before-delete-password';
            const nextPassword = 'after-delete-password';
            const payload = (name: string, password: string) => ({ studentId, name, role, password });

            const first = await call('auth/register', 'POST', JSON.stringify(payload('注销前账号', firstPassword)));
            assert.equal(first.status, 200, role);
            const original = (await first.json()).user;
            assert.equal('group' in original, false);
            assert.equal((await db.user.findUniqueOrThrow({ where: { id: original.id } })).groupId, null);
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

            const login = await call('auth/login', 'POST', JSON.stringify({ studentId, password: nextPassword }));
            assert.equal(login.status, 200, role);
            assert.equal((await login.json()).user.id, original.id);
            await db.authSession.deleteMany({ where: { userId: original.id } });
        }
    }
    finally {
        await db.authSession.deleteMany({ where: { userId: { in: accounts.map(a => a.id) } } });
        for (const account of accounts) {
            const limiterKeys = ['auth/register', 'auth/login'].map(key => `${key}:${hashToken(account.studentId)}`);
            await db.loginAttempt.deleteMany({ where: { key: { in: limiterKeys } } });
        }
        await db.user.deleteMany({ where: { id: { in: accounts.map(a => a.id) } } });
    }
});
test('管理员注册入口始终关闭', async () => {
    const { hashToken } = await import('../src/lib/auth');
    const studentId = `newadmin${randomUUID().slice(0, 8)}`;
    try {
        const response = await call('auth/register', 'POST', JSON.stringify({ studentId, name: '非法管理员', role: 'ADMIN', password: 'long-enough-password' }));
        assert.equal(response.status, 403);
        assert.equal(await db.user.count({ where: { studentId } }), 0);
    } finally {
        await db.loginAttempt.deleteMany({ where: { key: `auth/register:${hashToken(studentId)}` } });
    }
});
test('所有角色统一登录且不依赖客户端身份，旧同学号账号按密码识别', async () => {
    const { hash } = await import('bcryptjs');
    const { hashToken } = await import('../src/lib/auth');
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const group = await db.group.create({ data: { name: `unified-login-${suffix}` } });
    const accounts = [];
    try {
        for (const [i, role] of (['USER', 'ASSISTANT', 'ADMIN'] as const).entries()) {
            const password = `unified-password-${i}`;
            const account = await db.user.create({ data: { name: role, studentId: `un${suffix}`, email: `${suffix}${i}@test.local`, role, groupId: group.id, passwordHash: await hash(password, 4) } });
            accounts.push(account);
            const response = await call('auth/login', 'POST', JSON.stringify({ studentId: account.studentId, password }));
            assert.equal(response.status, 200, await response.clone().text());
            assert.equal((await response.json()).user.role, role);
        }
        const wrong = await call('auth/login', 'POST', JSON.stringify({ studentId: accounts[0].studentId, password: 'wrong' }));
        assert.equal(wrong.status, 401);
        const blockedRegistration = await call('auth/register', 'POST', JSON.stringify({ studentId: accounts[0].studentId, name: 'duplicate', password: 'password-duplicate-123' }));
        assert.equal(blockedRegistration.status, 409);
    } finally {
        await db.authSession.deleteMany({ where: { userId: { in: accounts.map(account => account.id) } } });
        await db.loginAttempt.deleteMany({ where: { key: { in: ['auth/login', 'auth/register'].map(key => `${key}:${hashToken(`un${suffix}`)}`) } } });
        await db.user.deleteMany({ where: { groupId: group.id } });
        await db.group.delete({ where: { id: group.id } });
    }
});

test('通知仅对接收者可见，单条和全部已读不能修改其他用户的通知', async () => {
    const { hashToken } = await import('../src/lib/auth');
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const users = await Promise.all([0, 1].map(i => db.user.create({ data: { name: `通知成员${i}`, studentId: `nt${suffix}${i}`, email: `nt${suffix}${i}@test.local`, passwordHash: 'unused' } })));
    const tokens = [randomUUID(), randomUUID()];
    const headers = { cookie: `station_session=${tokens[0]}` };
    try {
        await db.authSession.createMany({ data: users.map((user, i) => ({ id: hashToken(tokens[i]), userId: user.id, expiresAt: new Date(Date.now() + 3600000) })) });
        const first = await db.notification.create({ data: { recipientId: users[0].id, message: '工位预约已取消' } });
        const second = await db.notification.create({ data: { recipientId: users[0].id, message: '另一工位预约已取消' } });
        const other = await db.notification.create({ data: { recipientId: users[1].id, message: '其他成员的通知' } });
        const response = await call('notifications', 'GET', undefined, headers);
        assert.equal(response.status, 200);
        const result = await response.json();
        assert.equal(result.unreadCount, 2);
        assert.deepEqual(result.notifications.map((item: { id: string }) => item.id).sort(), [first.id, second.id].sort());
        assert.equal((await call(`notifications/${other.id}`, 'PATCH', '{}', headers)).status, 404);
        assert.equal((await call(`notifications/${first.id}`, 'PATCH', '{}', headers)).status, 200);
        assert.equal((await call(`notifications/${first.id}`, 'PATCH', '{}', headers)).status, 200);
        assert.equal((await (await call('notifications', 'GET', undefined, headers)).json()).unreadCount, 1);
        assert.equal((await call('notifications/read-all', 'POST', '{}', headers)).status, 200);
        assert.equal((await (await call('notifications', 'GET', undefined, headers)).json()).unreadCount, 0);
        assert.equal((await db.notification.findUniqueOrThrow({ where: { id: other.id } })).readAt, null);
    } finally {
        await db.user.deleteMany({ where: { id: { in: users.map(user => user.id) } } });
    }
});

test('助教降级、停用或注销后取消失去覆盖的一生一芯预约，保留ICIL', async t => {
    const { hashToken } = await import('../src/lib/auth');
    const { reserveSeat } = await import('../src/lib/bookings');
    for (const action of ['降级', '停用', '注销'] as const) await t.test(action, async () => {
        const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
        const users = await Promise.all((['ADMIN', 'ASSISTANT', 'USER', 'USER'] as const).map((role, i) => db.user.create({ data: { name: `${action}${role}`, studentId: `lc${suffix}${i}`, email: `lc${suffix}${i}@test.local`, role, memberType: i === 3 ? 'ICIL' : 'YSYX', passwordHash: 'unused' } })));
        const [admin, assistant, learner, icil] = users;
        const userIds = users.map(user => user.id);
        const venue = await db.venue.create({ data: { name: suffix, location: 'test' } });
        const layout = await db.layoutVersion.create({ data: { name: suffix, venueId: venue.id, status: 'PUBLISHED', seats: { create: ['STAFF', 'YSYX', 'ICIL'].map((code, i) => ({ code, x: i * 50, y: 100, fixedForAssistant: i === 0 })) } }, include: { seats: true } });
        const tomorrow = localParts(new Date(Date.now() + 86400000)).date;
        const session = await db.session.create({ data: { layoutId: layout.id, startsAt: new Date(`${tomorrow}T09:00:00+08:00`), endsAt: new Date(`${tomorrow}T10:00:00+08:00`) } });
        const token = randomUUID();
        const seat = (code: string) => layout.seats.find(item => item.code === code)!.id;
        try {
            await db.authSession.create({ data: { id: hashToken(token), userId: admin.id, expiresAt: new Date(Date.now() + 3600000) } });
            await reserveSeat(assistant.id, session.id, seat('STAFF'));
            const affected = await reserveSeat(learner.id, session.id, seat('YSYX'));
            const preserved = await reserveSeat(icil.id, session.id, seat('ICIL'));
            const method = action === '注销' ? 'DELETE' : 'PATCH';
            const payload = action === '注销' ? undefined : JSON.stringify({ name: assistant.name, role: action === '降级' ? 'USER' : 'ASSISTANT', enabled: action !== '停用' });
            const response = await call(`admin/users/${assistant.id}`, method, payload, { cookie: `station_session=${token}` });
            assert.equal(response.status, 200, await response.clone().text());
            assert.ok((await db.reservation.findUniqueOrThrow({ where: { id: affected.id } })).cancelledAt);
            assert.equal((await db.reservation.findUniqueOrThrow({ where: { id: preserved.id } })).cancelledAt, null);
            assert.equal(await db.notification.count({ where: { recipientId: learner.id } }), 1);
            assert.equal(await db.notification.count({ where: { recipientId: icil.id } }), 0);
            assert.equal((await db.session.findUniqueOrThrow({ where: { id: session.id } })).cancelledAt, null);
        } finally {
            await db.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
            await db.reservation.deleteMany({ where: { sessionId: session.id } });
            await db.session.delete({ where: { id: session.id } });
            await db.layoutVersion.delete({ where: { id: layout.id } });
            await db.venue.delete({ where: { id: venue.id } });
            await db.user.deleteMany({ where: { id: { in: userIds } } });
        }
    });
});

test.after(() => db.$disconnect());

test('禁止预约可独立于场次设置和解除，取消重叠预约并通知；读取记录不再触发未打卡过期', async () => {
    const { hashToken } = await import('../src/lib/auth');
    const { reserveSeat } = await import('../src/lib/bookings');
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const group = await db.group.create({ data: { name: `blocks-${suffix}` } });
    const admin = await db.user.create({ data: { name: '禁止预约管理员', studentId: `ba${suffix}`, email: `ba${suffix}@test.local`, role: 'ADMIN', groupId: group.id, passwordHash: 'unused' } });
    const member = await db.user.create({ data: { name: '禁止预约成员', studentId: `bu${suffix}`, email: `bu${suffix}@test.local`, memberType: 'ICIL', groupId: group.id, passwordHash: 'unused' } });
    const venue = await db.venue.create({ data: { name: suffix, location: 'test' } });
    const layout = await db.layoutVersion.create({ data: { name: suffix, venueId: venue.id, status: 'PUBLISHED', seats: { create: { code: 'A01', x: 100, y: 100 } } }, include: { seats: true } });
    const midnight = new Date(`${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())}T00:00:00+08:00`);
    const session = await db.session.create({ data: { layoutId: layout.id, startsAt: midnight, endsAt: new Date(midnight.getTime() + 2 * 86400000), icilOnly: true } });
    const adminToken = randomUUID(), memberToken = randomUUID();
    const headers = { cookie: `station_session=${adminToken}` }, memberHeaders = { cookie: `station_session=${memberToken}` };
    await db.authSession.createMany({ data: [{ id: hashToken(adminToken), userId: admin.id, expiresAt: new Date(Date.now() + 3600000) }, { id: hashToken(memberToken), userId: member.id, expiresAt: new Date(Date.now() + 3600000) }] });
    try {
        const startsAt = new Date(Math.ceil((Date.now() + 3600000) / 1800000) * 1800000), endsAt = new Date(startsAt.getTime() + 3600000);
        const past = await db.reservation.create({ data: { sessionId: session.id, userId: member.id, seatId: layout.seats[0].id, startsAt: new Date(Date.now() - 30 * 60000), endsAt: new Date(Date.now() + 15 * 60000) } });
        const records = await call('reservations', 'GET', undefined, memberHeaders);
        assert.equal(records.status, 200);
        assert.equal((await records.json()).reservations.find((r: { id: string }) => r.id === past.id).cancelledAt, null);
        assert.equal((await db.reservation.findUniqueOrThrow({ where: { id: past.id } })).cancelledAt, null);
        assert.equal((await call(`reservations/${past.id}/check-in`, 'POST', '{}', headers)).status, 404);
        const future = await reserveSeat(member.id, session.id, layout.seats[0].id, startsAt.toISOString(), endsAt.toISOString());
        const payload = { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), reason: '设备维护' };
        assert.equal((await call('admin/booking-blocks', 'POST', JSON.stringify(payload), memberHeaders)).status, 403);
        const created = await call('admin/booking-blocks', 'POST', JSON.stringify(payload), headers);
        assert.equal(created.status, 200, await created.clone().text());
        const result = await created.json();
        assert.ok(result.reservations >= 1);
        assert.ok((await db.reservation.findUniqueOrThrow({ where: { id: future.id } })).cancelledAt);
        assert.equal(await db.notification.count({ where: { recipientId: member.id } }), 1);
        assert.equal((await call('admin/booking-blocks', 'GET', undefined, headers)).status, 200);
        await assert.rejects(reserveSeat(member.id, session.id, layout.seats[0].id, startsAt.toISOString(), endsAt.toISOString()), /禁用预约/);
        assert.equal((await call(`admin/booking-blocks/${result.block.id}`, 'DELETE', undefined, headers)).status, 200);
        assert.ok((await db.reservation.findUniqueOrThrow({ where: { id: future.id } })).cancelledAt, '解除禁止不能自动恢复旧预约');
        await reserveSeat(member.id, session.id, layout.seats[0].id, startsAt.toISOString(), endsAt.toISOString());
        for (const [path, method] of [['groups', 'GET'], ['groups', 'POST'], ['groups/legacy', 'PUT'], ['sessions', 'POST'], [`sessions/${session.id}`, 'PUT'], [`admin/sessions/${session.id}/ready`, 'POST'], ['admin/sessions', 'GET']] as const) {
            assert.equal((await call(path, method, method === 'GET' ? undefined : '{}', headers)).status, 404, path);
        }
        const emptyBlock = await call('admin/booking-blocks', 'POST', JSON.stringify({ startsAt: new Date(endsAt.getTime() + 86400000).toISOString(), endsAt: new Date(endsAt.getTime() + 90000000).toISOString() }), headers);
        assert.equal(emptyBlock.status, 200, '没有场次的日期也应可以禁止预约');
        assert.equal((await emptyBlock.json()).reservations, 0);
        assert.equal((await call('admin/booking-blocks', 'POST', JSON.stringify({ startsAt: endsAt.toISOString(), endsAt: startsAt.toISOString() }), headers)).status, 400);
    } finally {
        const ids = [admin.id, member.id];
        await db.notification.deleteMany({ where: { recipientId: { in: ids } } });
        await db.auditLog.deleteMany({ where: { actorId: { in: ids } } });
        await db.authSession.deleteMany({ where: { userId: { in: ids } } });
        await db.bookingBlock.deleteMany({ where: { createdById: admin.id } });
        await db.reservation.deleteMany({ where: { sessionId: session.id } });
        await db.session.delete({ where: { id: session.id } });
        await db.layoutVersion.delete({ where: { id: layout.id } });
        await db.venue.delete({ where: { id: venue.id } });
        await db.user.deleteMany({ where: { id: { in: ids } } });
        await db.group.delete({ where: { id: group.id } });
    }
});
