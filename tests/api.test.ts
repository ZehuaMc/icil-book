import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';

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

async function call(path: string, method: 'GET' | 'POST' = 'GET', raw?: string, headers?: HeadersInit) {
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
    for (const path of ['admin/users', 'admin/stats', 'admin/reservations', 'groups', 'layouts', 'reservations']) {
        const response = await call(path);
        assert.equal(response.status, 401, path);
    }
    const response = await call('reservations', 'POST', JSON.stringify({ sessionId: 'test', seatId: 'test' }));
    assert.equal(response.status, 401);
});
test('登录注册输入错误返回 400，不触及数据库', async () => {
    for (const [path, data] of [['auth/login', { email: 'bad', password: 'x' }], ['auth/register', { email: 'valid@example.test', name: '测试用户', password: 'short' }]] as const) {
        const response = await call(path, 'POST', JSON.stringify(data));
        assert.equal(response.status, 400);
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
test.after(() => db.$disconnect());
