import { randomBytes, createHash } from 'node:crypto';
import { cookies } from 'next/headers';
import { db } from './db';
import { check } from './errors';
export const publicUser = { id: true, name: true, studentId: true, email: true, role: true, enabled: true, deletedAt: true, groupId: true, group: { include: { weeklyRules: true, dateRules: true } } } as const;
export function isOperator(user: { role: string } | null | undefined) { return user?.role === 'ADMIN' || user?.role === 'ASSISTANT'; }
export function hashToken(token: string) { return createHash('sha256').update(token).digest('hex'); }
export async function currentUser() {
    const token = (await cookies()).get('station_session')?.value;
    if (!token)
        return null;
    const session = await db.authSession.findUnique({ where: { id: hashToken(token) }, include: { user: { select: publicUser } } });
    return session && session.expiresAt > new Date() && session.user.enabled && !session.user.deletedAt ? session.user : null;
}
export async function requireUser(admin = false) {
    const user = await currentUser();
    check(user, '请先登录', 401);
    check(!admin || isOperator(user), '需要管理员权限', 403);
    return user;
}
export async function createLogin(userId: string) {
    const token = randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 7 * 86400000);
    await db.authSession.create({ data: { id: hashToken(token), userId, expiresAt: expires } });
    (await cookies()).set('station_session', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE !== 'false', sameSite: 'lax', path: '/', expires });
}
