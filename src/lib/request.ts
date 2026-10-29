import { check, HttpError } from './errors.ts';

const MAX_BODY_BYTES = 1_000_000;

export function assertSameOrigin(req: Request) {
    if (req.method === 'GET' || req.method === 'HEAD') return;
    const origin = req.headers.get('origin');
    // Next's internal URL may use localhost or 127.0.0.1 behind a reverse proxy.
    const url = new URL(req.url);
    const configuredOrigins = (process.env.APP_ORIGIN ?? '').split(',').map(value => value.trim()).filter(Boolean).map(value => new URL(value).origin);
    const forwardedProto = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || url.protocol.replace(':', '');
    const forwardedHost = req.headers.get('x-forwarded-host')?.split(',')[0]?.trim() || req.headers.get('host') || url.host;
    const expectedOrigins = configuredOrigins.length ? configuredOrigins : [`${forwardedProto}://${forwardedHost}`];
    check(!origin || expectedOrigins.includes(origin), '请求来源无效', 403);
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
