import { check, HttpError } from './errors.ts';

const MAX_BODY_BYTES = 1_000_000;

export function assertSameOrigin(req: Request) {
    if (req.method === 'GET' || req.method === 'HEAD') return;
    const origin = req.headers.get('origin');
    // Next's internal URL may use localhost even when the browser uses 127.0.0.1.
    // HTTPS proxies must configure the public origin; do not trust forwarded headers.
    const url = new URL(req.url);
    const expectedOrigin = process.env.APP_ORIGIN ?? `${url.protocol}//${req.headers.get('host') ?? url.host}`;
    check(!origin || origin === expectedOrigin, '请求来源无效', 403);
    check(req.headers.get('sec-fetch-site') !== 'cross-site', '请求来源无效', 403);
}

export async function readJson(req: Request): Promise<unknown> {
    check(Number(req.headers.get('content-length') ?? 0) <= MAX_BODY_BYTES, '请求过大', 413);
    check(req.body, '请求内容不是有效 JSON');
    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > MAX_BODY_BYTES) {
                await reader.cancel();
                throw new HttpError(413, '请求过大');
            }
            chunks.push(value);
        }
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(400, '请求内容不是有效 JSON');
    } finally {
        reader.releaseLock();
    }
}
