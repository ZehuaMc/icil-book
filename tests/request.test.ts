import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSameOrigin, readJson } from '../src/lib/request.ts';

const request = (body: BodyInit, headers?: HeadersInit) => new Request('https://station.example/api/reservations', { method: 'POST', body, headers });
const status = (code: number) => (error: unknown) => error instanceof Error && 'status' in error && error.status === code;
const previousOrigin = process.env.APP_ORIGIN;
test.before(() => { delete process.env.APP_ORIGIN; });
test.after(() => {
    if (previousOrigin === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = previousOrigin;
});

test('JSON 请求支持分块输入与中文多字节内容', async () => {
    const bytes = new TextEncoder().encode('{"name":"教学工位"}');
    const stream = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } });
    const req = new Request('https://station.example/api/admin/booking-blocks', { method: 'POST', body: stream, duplex: 'half' } as RequestInit);
    assert.deepEqual(await readJson(req), { name: '教学工位' });
});
test('缺少 Content-Length 时也拒绝超过 1 MB 的请求', async () => {
    await assert.rejects(readJson(request('"' + 'x'.repeat(1_000_001) + '"')), status(413));
});
test('伪造较小 Content-Length 无法绕过大小限制', async () => {
    await assert.rejects(readJson(request('"' + 'x'.repeat(1_000_001) + '"', { 'content-length': '10' })), status(413));
});
test('Content-Length 过大时在读取前拒绝', async () => {
    await assert.rejects(readJson(request('{}', { 'content-length': '1000001' })), status(413));
});
test('请求大小按字节限制，恰好 1 MB 允许，超限时取消剩余流', async () => {
    const value = 'x'.repeat(999998);
    assert.equal(await readJson(request(JSON.stringify(value))), value);
    await assert.rejects(readJson(request(JSON.stringify('中'.repeat(333333)))), status(413));
    let cancelled = false;
    const stream = new ReadableStream({
        pull(controller) { controller.enqueue(new Uint8Array(500001)); },
        cancel() { cancelled = true; },
    });
    const req = new Request('https://station.example', { method: 'POST', body: stream, duplex: 'half' } as RequestInit);
    await assert.rejects(readJson(req), status(413));
    assert.equal(cancelled, true);
});
test('非 JSON、空请求与非法 UTF-8 返回 400', async () => {
    await assert.rejects(readJson(request('not json')), status(400));
    await assert.rejects(readJson(new Request('https://station.example', { method: 'POST' })), status(400));
    await assert.rejects(readJson(request(new Uint8Array([0xff, 0xfe]))), status(400));
});
test('同源写请求和无 Origin 的客户端请求可通过，跨站写请求被拒绝', () => {
    assert.doesNotThrow(() => assertSameOrigin(request('{}', { origin: 'https://station.example' })));
    assert.doesNotThrow(() => assertSameOrigin(request('{}')));
    assert.throws(() => assertSameOrigin(request('{}', { origin: 'https://other.example' })), status(403));
    assert.throws(() => assertSameOrigin(request('{}', { 'sec-fetch-site': 'cross-site' })), status(403));
    assert.doesNotThrow(() => assertSameOrigin(new Request('https://station.example/api/sessions', { headers: { origin: 'https://other.example' } })));
});

test('生产服务使用浏览器 Host 校验来源，兼容 Next 内部地址并拒绝跨站和不同端口', () => {
    assert.doesNotThrow(() => assertSameOrigin(new Request('http://localhost:3000/api/auth/login', {
        method: 'POST', headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' },
    })));
    for (const origin of ['http://evil.test', 'http://127.0.0.1:3001']) {
        assert.throws(() => assertSameOrigin(new Request('http://localhost:3000/api/auth/login', {
            method: 'POST', headers: { host: '127.0.0.1:3000', origin },
        })), /请求来源无效/);
    }
    const previous = process.env.APP_ORIGIN;
    try {
        process.env.APP_ORIGIN = 'https://station.example.test';
        assert.doesNotThrow(() => assertSameOrigin(new Request('http://localhost:3000/api/auth/login', {
            method: 'POST', headers: { host: 'app:3000', origin: 'https://station.example.test' },
        })));
        assert.throws(() => assertSameOrigin(new Request('http://localhost:3000/api/auth/login', {
            method: 'POST', headers: { host: 'app:3000', origin: 'https://evil.test', 'x-forwarded-host': 'evil.test' },
        })), /请求来源无效/);
        process.env.APP_ORIGIN = 'https://station.example.test, https://admin.example.test';
        assert.doesNotThrow(() => assertSameOrigin(request('{}', { origin: 'https://admin.example.test' })));
        assert.throws(() => assertSameOrigin(request('{}', { origin: 'https://station.example' })), status(403));
    } finally {
        if (previous === undefined) delete process.env.APP_ORIGIN;
        else process.env.APP_ORIGIN = previous;
    }
});
