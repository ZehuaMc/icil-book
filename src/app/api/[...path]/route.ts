import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { compare, hash } from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { z, ZodError } from 'zod';
import { db, serial } from '@/lib/db';
import { currentUser, requireUser, createLogin, publicUser, hashToken, isOperator } from '@/lib/auth';
import { check, HttpError } from '@/lib/errors';
import { assertSameOrigin, readJson as body } from '@/lib/request';
import { reserveSeat, cancelReservation, checkInReservation, replaceAdminSeat, addCoverage, createAssistantSession, removeCoverage, expireUnconfirmedReservations, audit } from '@/lib/bookings';
import { groupAllows } from '@/lib/rules';
import { password, studentId, groupSchema, courseSchema, layoutSchema, sessionSchema, id } from '@/lib/validation';
export const runtime = 'nodejs';
const sessionInclude = { course: true, layout: { include: { venue: true, elements: true, seats: { orderBy: { code: 'asc' as const } } } }, coverage: { include: { assistant: { select: { id: true, name: true } } } }, adminBookings: { include: { admin: { select: { id: true, name: true } } } }, reservations: { where: { cancelledAt: null }, select: { id: true, userId: true, seatId: true, startsAt: true, endsAt: true, checkedInAt: true } } } as const;
const recordInclude = { session: { include: { course: true, layout: { include: { venue: true } } } }, seat: true, user: { select: { id: true, name: true, studentId: true, email: true, role: true } } } as const;
const ADMIN_REGISTRATION_KEY = process.env.ADMIN_REGISTRATION_KEY ?? 'icilxysyx';
type SessionView = Prisma.SessionGetPayload<{ include: typeof sessionInclude }>;
function sessionsOverlap(a: SessionView, b: SessionView) {
    return a.layout.venueId === b.layout.venueId && a.startsAt < b.endsAt && a.endsAt > b.startsAt;
}
function mergeOpenSessionViews(sessions: SessionView[], userId?: string) {
    const groups: SessionView[][] = [];
    for (const session of [...sessions].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())) {
        const matching = groups.filter(group => group.some(existing => sessionsOverlap(existing, session)));
        if (!matching.length) {
            groups.push([session]);
            continue;
        }
        const merged = matching[0];
        merged.push(session);
        for (const other of matching.slice(1)) {
            merged.push(...other);
            groups.splice(groups.indexOf(other), 1);
        }
    }
    return groups.map(group => {
        const canonical = [...group].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())[0];
        const seatIdsByCode = new Map(canonical.layout.seats.map(seat => [seat.code, seat.id]));
        const reservations = new Map<string, SessionView['reservations'][number]>();
        for (const source of group) {
            const sourceSeats = new Map(source.layout.seats.map(seat => [seat.id, seat.code]));
            for (const reservation of source.reservations) {
                const seatId = seatIdsByCode.get(sourceSeats.get(reservation.seatId) ?? '');
                if (!seatId)
                    continue;
                const existing = reservations.get(seatId);
                if (!existing || (!!userId && reservation.userId === userId && existing.userId !== userId))
                    reservations.set(seatId, { ...reservation, seatId });
            }
        }
        const adminBookings = [...new Map(group.flatMap(session => session.adminBookings).map(booking => [booking.adminId, booking])).values()];
        const coverage = [...new Map(group.flatMap(session => session.coverage).map(record => [record.assistantId, record])).values()];
        return {
            ...canonical,
            startsAt: new Date(Math.min(...group.map(session => session.startsAt.getTime()))),
            endsAt: new Date(Math.max(...group.map(session => session.endsAt.getTime()))),
            requiredAssistants: Math.max(...group.map(session => session.requiredAssistants)),
            reservations: [...reservations.values()],
            adminBookings,
            coverage,
        } satisfies SessionView;
    });
}
async function dispatch(req: NextRequest, path: string[]) {
    const method = req.method, key = path.join('/');
    assertSameOrigin(req);
    if (key === 'health' && method === 'GET') {
        await db.$queryRaw`SELECT 1`;
        return { ok: true };
    }
    if (key === 'auth/me' && method === 'GET')
        return { user: await currentUser() };
    if ((key === 'auth/login' || key === 'auth/register') && method === 'POST') {
        const input = z.object({ studentId, password: z.string().max(100).optional(), name: z.string().trim().min(1).max(60).optional(), role: z.enum(['USER', 'ADMIN']).optional(), adminKey: z.string().max(100).optional() }).parse(await body(req));
        // Shared database counter works across app processes; do not trust client-supplied IP headers.
        const limiterKey = `${key}:${input.role ?? 'USER'}:${hashToken(input.studentId)}`;
        const attempt = await db.loginAttempt.upsert({ where: { key: limiterKey }, create: { key: limiterKey, resetAt: new Date(Date.now() + 900000) }, update: { count: { increment: 1 } } });
        if (attempt.resetAt < new Date())
            await db.loginAttempt.update({ where: { key: limiterKey }, data: { count: 1, resetAt: new Date(Date.now() + 900000) } });
        else
            check(attempt.count <= 15, '尝试次数过多，请 15 分钟后重试', 429);
        let user;
        if (key === 'auth/register') {
            check(input.name, '请输入姓名');
            const wantsAdmin = input.role === 'ADMIN';
            if (wantsAdmin) {
                check(input.adminKey === ADMIN_REGISTRATION_KEY, '管理员密钥错误', 403);
            }
            else {
                check(input.password && password.safeParse(input.password).success, '密码至少需要 10 位字符');
            }
            const settings = await db.appSetting.findUnique({ where: { id: 'main' } });
            check(settings, '请先初始化数据库', 503);
            const generatedEmail = `${input.studentId}+${wantsAdmin ? 'admin' : 'user'}@student.local`;
            if (wantsAdmin) {
                const existingAdmin = await db.user.findUnique({ where: { studentId_role: { studentId: input.studentId, role: 'ADMIN' } } });
                if (existingAdmin) {
                    check(!!existingAdmin.deletedAt, '该学号已注册管理员账号，请直接登录', 409);
                    user = await db.user.update({ where: { id: existingAdmin.id }, data: { name: input.name, enabled: true, deletedAt: null, groupId: settings.defaultGroupId, passwordHash: await hash(randomBytes(32).toString('hex'), 12) }, select: publicUser });
                }
                else {
                    user = await db.user.create({ data: { name: input.name, studentId: input.studentId, email: generatedEmail, role: 'ADMIN', passwordHash: await hash(randomBytes(32).toString('hex'), 12), groupId: settings.defaultGroupId }, select: publicUser });
                }
            }
            else {
                const existingLearner = await db.user.findUnique({ where: { studentId_role: { studentId: input.studentId, role: 'USER' } } });
                if (existingLearner) {
                    if (existingLearner.deletedAt) {
                        user = await db.user.update({ where: { id: existingLearner.id }, data: { name: input.name, enabled: true, deletedAt: null, groupId: settings.defaultGroupId, passwordHash: await hash(input.password!, 12) }, select: publicUser });
                    }
                    else {
                        const migratedAccount = existingLearner.email === `${input.studentId}+user@student.local`
                            && !!(await db.user.findUnique({ where: { studentId_role: { studentId: input.studentId, role: 'ADMIN' } }, select: { id: true } }));
                        check(migratedAccount, '该学号已注册学员账号，请直接登录', 409);
                        user = await db.user.update({ where: { id: existingLearner.id }, data: { name: input.name, passwordHash: await hash(input.password!, 12) }, select: publicUser });
                    }
                }
                else {
                    user = await db.user.create({ data: { name: input.name, studentId: input.studentId, email: generatedEmail, role: 'USER', passwordHash: await hash(input.password!, 12), groupId: settings.defaultGroupId }, select: publicUser });
                }
            }
        }
        else {
            const adminLogin = input.role === 'ADMIN' || !!input.adminKey;
            const account = await db.user.findUnique({ where: { studentId_role: { studentId: input.studentId, role: adminLogin ? 'ADMIN' : 'USER' } } });
            if (adminLogin) {
                check(input.adminKey === ADMIN_REGISTRATION_KEY, '管理员密钥错误', 403);
                check(account && isOperator(account) && account.enabled, '管理员学号不存在或账号已停用', 401);
            }
            else {
                check(input.password, '请输入密码');
                const matched = await compare(input.password, account?.passwordHash ?? '$2b$12$YGMMy9YbCI1QLcQ8ZqWr6u2ml.VFu9y1y90MhQbcTmwUxNp.t3Izq');
                check(account && matched && account.enabled, '学号或密码错误，或账号已停用', 401);
            }
            user = await db.user.findUniqueOrThrow({ where: { id: account.id }, select: publicUser });
        }
        await createLogin(user.id);
        return { user };
    }
    if (key === 'auth/logout' && method === 'POST') {
        const jar = await cookies(), token = jar.get('station_session')?.value;
        if (token)
            await db.authSession.deleteMany({ where: { id: hashToken(token) } });
        jar.delete('station_session');
        return { ok: true };
    }
    if (key === 'sessions' && method === 'GET') {
        await expireUnconfirmedReservations();
        const user = await currentUser();
        // The home page is for making future reservations.  Do not leave an
        // already-started slot visible and then make every seat appear
        // disabled; active reservations remain available from the records page
        // for check-in and cancellation rules.
        const sessions = await db.session.findMany({ where: { endsAt: { gt: new Date() }, open: true, cancelledAt: null }, include: sessionInclude, orderBy: { startsAt: 'asc' }, take: 100 });
        const mergedSessions = mergeOpenSessionViews(sessions, user?.id);
        return { sessions: mergedSessions.map(s => ({ ...s, adminReady: true, allowed: !!user && (isOperator(user) || user.group.canReserve), reservations: s.reservations.map(r => ({ seatId: r.seatId, mine: !isOperator(user) && r.userId === user?.id, id: !isOperator(user) && r.userId === user?.id ? r.id : undefined, startsAt: r.startsAt, endsAt: r.endsAt, checkedInAt: !isOperator(user) && r.userId === user?.id ? r.checkedInAt : undefined })) })) };
    }
    const user = await requireUser();
    await expireUnconfirmedReservations();
    if (key === 'auth/change-password' && method === 'POST') {
        const data = z.object({ currentPassword: z.string().min(1).max(100), newPassword: password }).parse(await body(req));
        check(!isOperator(user), '管理员账号使用密钥登录，请联系其他管理员重置', 403);
        const account = await db.user.findUnique({ where: { id: user.id }, select: { passwordHash: true } });
        const matched = await compare(data.currentPassword, account?.passwordHash ?? '$2b$12$YGMMy9YbCI1QLcQ8ZqWr6u2ml.VFu9y1y90MhQbcTmwUxNp.t3Izq');
        check(matched, '当前密码错误', 401);
        const token = (await cookies()).get('station_session')?.value;
        await serial(async (tx) => {
            await tx.user.update({ where: { id: user.id }, data: { passwordHash: await hash(data.newPassword, 12) } });
            await tx.authSession.deleteMany({ where: { userId: user.id, ...(token ? { NOT: { id: hashToken(token) } } : {}) } });
            await audit(tx, user.id, 'PASSWORD_CHANGE', user.id);
        });
        return { ok: true };
    }
    if (key === 'notifications' && method === 'GET') {
        const [notifications, unreadCount] = await Promise.all([
            db.notification.findMany({ where: { recipientId: user.id }, orderBy: { createdAt: 'desc' }, take: 50 }),
            db.notification.count({ where: { recipientId: user.id, readAt: null } }),
        ]);
        return { notifications, unreadCount };
    }
    if (key === 'notifications/read-all' && method === 'POST') {
        await db.notification.updateMany({ where: { recipientId: user.id, readAt: null }, data: { readAt: new Date() } });
        return { ok: true };
    }
    if (path[0] === 'notifications' && path.length === 2 && method === 'PATCH') {
        const result = await db.notification.updateMany({ where: { id: path[1], recipientId: user.id, readAt: null }, data: { readAt: new Date() } });
        check(result.count > 0 || await db.notification.findFirst({ where: { id: path[1], recipientId: user.id } }), '通知不存在', 404);
        return { ok: true };
    }
    if (key === 'assistant/options' && method === 'GET') {
        check(isOperator(user), '需要管理员权限', 403);
        return { layouts: await db.layoutVersion.findMany({ where: { status: 'PUBLISHED' }, include: { venue: true, elements: true, seats: { orderBy: { code: 'asc' } } }, orderBy: { createdAt: 'desc' } }) };
    }
    if (key === 'reservations' && method === 'POST') {
        const data = z.object({ sessionId: id, seatId: id, startsAt: z.string().datetime({ offset: true }).optional(), endsAt: z.string().datetime({ offset: true }).optional() }).refine(v => (!!v.startsAt === !!v.endsAt), '预约时间必须同时填写开始和结束时间').parse(await body(req));
        return { reservation: await reserveSeat(user.id, data.sessionId, data.seatId, data.startsAt, data.endsAt) };
    }
    if (key === 'reservations' && method === 'GET')
        return { reservations: await db.reservation.findMany({ where: { userId: user.id }, include: recordInclude, orderBy: { createdAt: 'desc' }, take: 200 }), coverage: await db.assistantCoverage.findMany({ where: { assistantId: user.id }, include: { session: { include: { course: true, layout: { include: { venue: true } } } } }, orderBy: { createdAt: 'desc' } }) };
    if (path[0] === 'reservations' && path.length === 2 && method === 'DELETE')
        return cancelReservation(user.id, path[1]);
    if (path[0] === 'reservations' && path.length === 3 && path[2] === 'check-in' && method === 'POST')
        return { reservation: await checkInReservation(user.id, path[1]) };
    if (key === 'reservations/coverage' && method === 'POST') {
        const data = z.object({ sessionId: id.optional(), layoutId: id.optional(), startsAt: z.string().datetime({ offset: true }), endsAt: z.string().datetime({ offset: true }) }).refine(v => v.sessionId || v.layoutId, '请选择布局').parse(await body(req));
        if (data.sessionId)
            return { coverage: await addCoverage(user.id, data.sessionId, data.startsAt, data.endsAt) };
        return await createAssistantSession(user.id, data.layoutId!, data.startsAt, data.endsAt);
    }
    if (path[0] === 'reservations' && path[1] === 'coverage' && path.length === 3 && method === 'DELETE')
        return removeCoverage(user.id, path[2]);
    check(isOperator(user), '需要管理员权限', 403);
    if (path[0] === 'admin' && path[1] === 'sessions' && path.length === 4 && path[3] === 'admin-seat' && method === 'PUT') {
        const data = z.object({ seatId: id }).parse(await body(req));
        return { reservation: await replaceAdminSeat(user.id, path[2], data.seatId) };
    }
    if (path[0] === 'admin' && path[1] === 'sessions' && path.length === 4 && path[3] === 'ready' && (method === 'POST' || method === 'DELETE')) {
        return serial(async (tx) => {
            await tx.$queryRaw `SELECT id FROM "Session" WHERE id = ${path[2]} FOR UPDATE`;
            const session = await tx.session.findUnique({ where: { id: path[2] } });
            check(session, '场次不存在', 404);
            check(!session.cancelledAt, '此时段已取消，不能再次开放');
            check(session.startsAt > new Date(), '已开始场次不能修改');
            if (method === 'POST') {
                check(!session.open, '此时间已经开放');
                check(await tx.reservation.count({ where: { sessionId: session.id, cancelledAt: null, user: { role: { in: ['ADMIN', 'ASSISTANT'] } } } }) > 0, '请先选择至少一个管理员工位');
                const venueId = (await tx.layoutVersion.findUniqueOrThrow({ where: { id: session.layoutId } })).venueId;
                // Merge transitively overlapping windows (2–6 plus 4–9 becomes 2–9).
                let mergedStart = session.startsAt, mergedEnd = session.endsAt;
                const overlapById = new Map<string, Awaited<ReturnType<typeof tx.session.findMany<{ include: { reservations: { include: { seat: true } }; layout: { include: { seats: true } } } }>>>[number]>();
                for (;;) {
                    const found = await tx.session.findMany({
                        where: { id: { not: session.id, notIn: [...overlapById.keys()] }, open: true, cancelledAt: null, layout: { venueId }, startsAt: { lt: mergedEnd }, endsAt: { gt: mergedStart } },
                        include: { reservations: { include: { seat: true } }, layout: { include: { seats: true } } },
                        orderBy: { startsAt: 'asc' },
                    });
                    if (!found.length) break;
                    for (const other of found) {
                        overlapById.set(other.id, other);
                        mergedStart = new Date(Math.min(mergedStart.getTime(), other.startsAt.getTime()));
                        mergedEnd = new Date(Math.max(mergedEnd.getTime(), other.endsAt.getTime()));
                    }
                }
                const overlaps = [...overlapById.values()];
                check(mergedEnd.getTime() - mergedStart.getTime() <= 86400000, '合并后的开放时段不能超过 24 小时', 409);
                if (overlaps.length) {
                    const allReservations = await tx.reservation.findMany({
                        where: { sessionId: { in: [session.id, ...overlaps.map(other => other.id)] } },
                        include: { seat: { select: { code: true } } },
                    });
                    const targetSeats = new Set((await tx.seat.findMany({ where: { layoutId: session.layoutId }, select: { code: true } })).map(seat => seat.code));
                    for (const reservation of allReservations)
                        check(targetSeats.has(reservation.seat.code), `布局中缺少 ${reservation.seat.code} 号座位，无法合并展示时段`, 409);
                    for (let i = 0; i < allReservations.length; i++) for (let j = i + 1; j < allReservations.length; j++) {
                        const a = allReservations[i], b = allReservations[j];
                        if (!a.cancelledAt && !b.cancelledAt && a.seat.code === b.seat.code && a.userId !== b.userId)
                            check(a.startsAt >= b.endsAt || b.startsAt >= a.endsAt, `合并时段中 ${a.seat.code} 号工位存在不同用户的重叠预约`, 409);
                    }
                    await tx.session.update({ where: { id: session.id }, data: { startsAt: mergedStart, endsAt: mergedEnd } });
                    await audit(tx, user.id, 'SESSION_MERGED', session.id, { preservedSessions: overlaps.map(other => other.id), startsAt: mergedStart, endsAt: mergedEnd });
                }
                const booking = await tx.sessionAdminBooking.upsert({ where: { sessionId_adminId: { sessionId: session.id, adminId: user.id } }, create: { sessionId: session.id, adminId: user.id }, update: {} });
                await tx.session.update({ where: { id: session.id }, data: { open: true, startsAt: mergedStart, endsAt: mergedEnd } });
                await audit(tx, user.id, 'SESSION_ADMIN_READY', booking.id, { sessionId: session.id });
                return { booking };
            }
            check(session.open, '此时间尚未开放');
            await tx.sessionAdminBooking.deleteMany({ where: { sessionId: session.id, adminId: user.id } });
            await tx.session.update({ where: { id: session.id }, data: { open: false } });
            await audit(tx, user.id, 'SESSION_ADMIN_UNREADY', session.id, { sessionId: session.id, preservesLearnerReservations: true });
            return { ok: true };
        });
    }
    if (key === 'admin/stats' && method === 'GET') {
        const [users, sessions, reservations, layouts] = await Promise.all([db.user.count(), db.session.count({ where: { startsAt: { gte: new Date() } } }), db.reservation.count({ where: { cancelledAt: null } }), db.layoutVersion.count({ where: { status: 'PUBLISHED' } })]);
        return { users, sessions, reservations, layouts };
    }
    if (key === 'admin/users' && method === 'GET')
        return { users: await db.user.findMany({ select: publicUser, orderBy: { createdAt: 'desc' }, take: 500 }) };
    if (path[0] === 'admin' && path[1] === 'users' && path.length === 4 && path[3] === 'reset-password' && method === 'POST') {
        return serial(async (tx) => {
            const target = await tx.user.findUnique({ where: { id: path[2] } });
            check(target, '用户不存在', 404);
            check(target.role === 'USER', '只能重置学员密码', 403);
            check(!target.deletedAt, '已注销账号不能重置密码', 409);
            await tx.user.update({ where: { id: target.id }, data: { passwordHash: await hash('123456', 12) } });
            await tx.authSession.deleteMany({ where: { userId: target.id } });
            await audit(tx, user.id, 'USER_PASSWORD_RESET', target.id, { resetToDefault: true });
            return { ok: true };
        });
    }
    if (path[0] === 'admin' && path[1] === 'users' && path.length === 3 && method === 'PATCH') {
        const data = z.object({ name: z.string().trim().min(1).max(60), role: z.enum(['ADMIN', 'USER']), enabled: z.boolean(), groupId: id }).parse(await body(req));
        return serial(async (tx) => {
            const target = await tx.user.findUnique({ where: { id: path[2] } });
            check(target, '用户不存在', 404);
            check(!target.deletedAt, '已注销账号不能再编辑', 409);
            if (isOperator(target) && (!data.enabled || data.role !== 'ADMIN'))
                check(await tx.user.count({ where: { role: { in: ['ADMIN', 'ASSISTANT'] }, enabled: true, deletedAt: null } }) > 1, '必须保留至少一名启用的管理员');
            const result = await tx.user.update({ where: { id: target.id }, data, select: publicUser });
            if (!data.enabled)
                await tx.authSession.deleteMany({ where: { userId: target.id } });
            await audit(tx, user.id, 'USER_UPDATE', target.id, data);
            return { user: result };
        });
    }
    if (path[0] === 'admin' && path[1] === 'users' && path.length === 3 && method === 'DELETE') {
        check(path[2] !== user.id, '不能注销当前登录的管理员账号', 409);
        return serial(async (tx) => {
            const target = await tx.user.findUnique({ where: { id: path[2] } });
            check(target, '用户不存在', 404);
            check(!target.deletedAt, '该账号已经注销', 409);
            if (isOperator(target) && target.enabled)
                check(await tx.user.count({ where: { role: { in: ['ADMIN', 'ASSISTANT'] }, enabled: true, deletedAt: null } }) > 1, '必须保留至少一名启用的管理员');

            const now = new Date();
            const futureAdminBookings = isOperator(target) ? await tx.reservation.findMany({
                where: { userId: target.id, cancelledAt: null, session: { startsAt: { gt: now } } },
                select: { id: true, sessionId: true },
            }) : [];
            const affectedSessionIds = [...new Set(futureAdminBookings.map(booking => booking.sessionId))];
            for (const sessionId of affectedSessionIds)
                await tx.$queryRaw`SELECT id FROM "Session" WHERE id = ${sessionId} FOR UPDATE`;

            const cancelled = await tx.reservation.updateMany({
                where: { userId: target.id, cancelledAt: null, session: { startsAt: { gt: now } } },
                data: { cancelledAt: now },
            });
            await tx.authSession.deleteMany({ where: { userId: target.id } });
            await tx.user.update({ where: { id: target.id }, data: { enabled: false, deletedAt: now } });

            for (const sessionId of affectedSessionIds) {
                const remainingAdmins = await tx.reservation.count({ where: { sessionId, cancelledAt: null, user: { role: { in: ['ADMIN', 'ASSISTANT'] } } } });
                if (remainingAdmins > 0) continue;
                const session = await tx.session.findUniqueOrThrow({ where: { id: sessionId } });
                const learners = await tx.reservation.findMany({
                    where: { sessionId, cancelledAt: null, user: { role: 'USER' } },
                    select: { id: true, userId: true, seat: { select: { code: true } } },
                });
                if (learners.length) {
                    await tx.reservation.updateMany({ where: { id: { in: learners.map(learner => learner.id) } }, data: { cancelledAt: now } });
                    const starts = session.startsAt.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
                    const ends = session.endsAt.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit' });
                    await tx.notification.createMany({ data: learners.map(learner => ({
                        recipientId: learner.userId,
                        type: 'BOOKING_CANCELLED',
                        message: `${starts}至${ends}的预约时段因管理员账号注销、暂无其他管理员值守，已关闭。你的${learner.seat.code}号工位预约已自动取消。`,
                    })) });
                }
                await tx.session.update({ where: { id: sessionId }, data: { open: false, cancelledAt: now } });
                await audit(tx, user.id, 'SESSION_CANCELLED', sessionId, { reason: 'ADMIN_ACCOUNT_DELETED', cancelledLearners: learners.length });
            }
            await audit(tx, user.id, 'USER_DELETE', target.id, { role: target.role, cancelledReservations: cancelled.count });
            return { ok: true, cancelledReservations: cancelled.count };
        });
    }
    if (key === 'groups' && method === 'GET')
        return { groups: await db.group.findMany({ include: { weeklyRules: true, dateRules: true, _count: { select: { users: true } } }, orderBy: { name: 'asc' } }), settings: await db.appSetting.findUnique({ where: { id: 'main' } }) };
    if (path[0] === 'groups' && ((path.length === 1 && method === 'POST') || (path.length === 2 && method === 'PUT'))) {
        const data = groupSchema.parse(await body(req));
        return serial(async (tx) => {
            const values = { name: data.name, canReserve: data.canReserve };
            const group = path[1] ? await tx.group.update({ where: { id: path[1] }, data: values }) : await tx.group.create({ data: values });
            await tx.groupScheduleRule.deleteMany({ where: { groupId: group.id } });
            await tx.groupDateRule.deleteMany({ where: { groupId: group.id } });
            await tx.groupScheduleRule.createMany({ data: data.weeklyRules.map(r => ({ ...r, groupId: group.id })) });
            await tx.groupDateRule.createMany({ data: data.dateRules.map(r => ({ ...r, groupId: group.id })) });
            if (data.isDefault)
                await tx.appSetting.upsert({ where: { id: 'main' }, create: { id: 'main', defaultGroupId: group.id }, update: { defaultGroupId: group.id } });
            await audit(tx, user.id, 'GROUP_SAVE', group.id, data);
            return { group };
        });
    }
    if (key === 'layouts' && method === 'GET')
        return { venues: await db.venue.findMany(), layouts: await db.layoutVersion.findMany({ include: { venue: true, elements: true, seats: { orderBy: { code: 'asc' } }, _count: { select: { sessions: true } } }, orderBy: { createdAt: 'desc' } }) };
    if (key === 'layouts/venues' && method === 'POST') {
        const data = z.object({ name: z.string().trim().min(1).max(80), location: z.string().trim().max(200) }).parse(await body(req));
        return serial(async (tx) => { const venue = await tx.venue.create({ data }); await audit(tx, user.id, 'VENUE_CREATE', venue.id, data); return { venue }; });
    }
    if (key === 'layouts' && method === 'POST') {
        const data = z.object({ name: z.string().trim().min(1).max(100), venueId: id, cloneId: id.optional() }).parse(await body(req));
        return serial(async (tx) => {
            const source = data.cloneId ? await tx.layoutVersion.findUnique({ where: { id: data.cloneId }, include: { seats: true, elements: true } }) : null;
            check(!data.cloneId || source, '原布局不存在', 404);
            const layout = await tx.layoutVersion.create({ data: { name: data.name, venueId: data.venueId, sourceLayoutId: source?.status === 'PUBLISHED' ? source.id : null, width: source?.width, height: source?.height } });
            const elementMap = new Map<string, string>();
            if (source) {
                for (const e of source.elements) {
                    const { id: oldId, layoutId: _, ...value } = e;
                    const added = await tx.layoutElement.create({ data: { ...value, layoutId: layout.id } });
                    elementMap.set(oldId, added.id);
                }
                for (const s of source.seats) {
                    const { id: _, layoutId: __, elementId, ...value } = s;
                    await tx.seat.create({ data: { ...value, originId: source?.status === 'PUBLISHED' ? s.id : null, layoutId: layout.id, elementId: elementId ? elementMap.get(elementId) : null } });
                }
            }
            await audit(tx, user.id, 'LAYOUT_CREATE', layout.id, data);
            return { layout };
        });
    }
    if (path[0] === 'layouts' && path[2] === 'overwrite' && path.length === 3 && method === 'POST') {
        const data = z.object({ draftId: id }).parse(await body(req));
        return serial(async (tx) => {
            await tx.$queryRaw`SELECT id FROM "LayoutVersion" WHERE id IN (${path[1]}, ${data.draftId}) FOR UPDATE`;
            const [source, draft] = await Promise.all([
                tx.layoutVersion.findUnique({ where: { id: path[1] }, include: { seats: true } }),
                tx.layoutVersion.findUnique({ where: { id: data.draftId }, include: { seats: true, elements: true } }),
            ]);
            check(source?.status === 'PUBLISHED', '只能覆盖已发布的原布局', 409);
            check(draft?.status === 'DRAFT' && draft.venueId === source.venueId && draft.sourceLayoutId === source.id, '草稿不存在或不是从此布局复制', 409);
            check(draft.seats.some(seat => seat.enabled), '请至少保留一个启用座位');

            const sourceSeats = new Map(source.seats.map(seat => [seat.id, seat]));
            const incomingOrigins = draft.seats.flatMap(seat => seat.originId ? [seat.originId] : []);
            check(new Set(incomingOrigins).size === incomingOrigins.length, '草稿中的来源座位重复，请重新复制布局');
            check(incomingOrigins.every(originId => sourceSeats.has(originId)), '草稿包含不属于原布局的来源座位，请重新复制布局');
            const retainedOrigins = new Set(incomingOrigins);
            const removedSeatIds = source.seats.filter(seat => !retainedOrigins.has(seat.id)).map(seat => seat.id);
            if (removedSeatIds.length)
                check(!await tx.reservation.count({ where: { seatId: { in: removedSeatIds } } }), '原布局中被删除的座位有预约历史，不能覆盖删除');
            if (removedSeatIds.length)
                await tx.seat.deleteMany({ where: { id: { in: removedSeatIds } } });
            for (const originId of incomingOrigins)
                await tx.seat.update({ where: { id: originId }, data: { code: `__tmp_${originId}` } });

            // Remove the old furniture first.  New elements are created below and
            // must not be included in this cleanup query.
            await tx.layoutElement.deleteMany({ where: { layoutId: source.id } });
            const elementMap = new Map<string, string>();
            for (const element of draft.elements) {
                const { id: _, layoutId: __, ...value } = element;
                const created = await tx.layoutElement.create({ data: { ...value, layoutId: source.id } });
                elementMap.set(element.id, created.id);
            }
            for (const seat of draft.seats) {
                const values = {
                    code: seat.code,
                    x: seat.x,
                    y: seat.y,
                    rotation: seat.rotation,
                    enabled: seat.enabled,
                    fixedForAssistant: seat.fixedForAssistant,
                    elementId: seat.elementId ? elementMap.get(seat.elementId) ?? null : null,
                };
                if (seat.originId) {
                    await tx.seat.update({ where: { id: seat.originId }, data: values });
                }
                else {
                    await tx.seat.create({ data: { ...values, layoutId: source.id } });
                }
            }
            await tx.layoutVersion.update({ where: { id: source.id }, data: { name: source.name, width: draft.width, height: draft.height, publishedAt: new Date() } });
            await audit(tx, user.id, 'LAYOUT_OVERWRITE', source.id, { draftId: draft.id, seats: draft.seats.length });
            await tx.layoutVersion.delete({ where: { id: draft.id } });
            return { ok: true, layoutId: source.id };
        });
    }
    if (path[0] === 'layouts' && path.length === 2 && method === 'DELETE') {
        return serial(async (tx) => {
            const layout = await tx.layoutVersion.findUnique({ where: { id: path[1] } });
            check(layout, '布局不存在', 404);
            check(!await tx.session.count({ where: { layoutId: layout.id } }), '该布局已关联预约时段，不能删除');
            check(!await tx.reservation.count({ where: { seat: { layoutId: layout.id } } }), '该布局有预约历史，不能删除');
            await tx.layoutVersion.delete({ where: { id: layout.id } });
            await audit(tx, user.id, 'LAYOUT_DELETE', layout.id, { name: layout.name });
            return { ok: true };
        });
    }
    if (path[0] === 'layouts' && path.length === 2 && method === 'PUT') {
        const data = layoutSchema.parse(await body(req));
        return serial(async (tx) => {
            const layout = await tx.layoutVersion.findUnique({ where: { id: path[1] } });
            check(layout?.status === 'DRAFT', '已发布布局不可修改，请复制为新版本', 409);
            const currentSeats = await tx.seat.findMany({ where: { layoutId: layout.id }, select: { id: true } });
            const incomingSeatIds = new Set(data.seats.map(s => s.id));
            const removedSeatIds = currentSeats.map(s => s.id).filter(id => !incomingSeatIds.has(id));
            if (removedSeatIds.length)
                check(!await tx.reservation.count({ where: { seatId: { in: removedSeatIds } } }), '已有预约的座位不能删除', 409);
            await tx.seat.deleteMany({ where: { layoutId: layout.id } });
            await tx.layoutElement.deleteMany({ where: { layoutId: layout.id } });
            await tx.layoutVersion.update({ where: { id: layout.id }, data: { name: data.name, width: data.width, height: data.height } });
            await tx.layoutElement.createMany({ data: data.elements.map(e => ({ ...e, layoutId: layout.id })) });
            await tx.seat.createMany({ data: data.seats.map(s => ({ ...s, elementId: s.elementId ?? null, layoutId: layout.id })) });
            await audit(tx, user.id, 'LAYOUT_SAVE', layout.id, { name: data.name, seats: data.seats.length });
            return { ok: true };
        });
    }
    if (path[0] === 'layouts' && path[2] === 'publish' && path.length === 3 && method === 'POST')
        return serial(async (tx) => {
            const layout = await tx.layoutVersion.findUnique({ where: { id: path[1] }, include: { seats: true } });
            check(layout?.status === 'DRAFT' && layout.seats.some(s => s.enabled), '请先保存至少一个可用座位');
            const futureSessions = await tx.session.findMany({
                where: { layout: { venueId: layout.venueId }, layoutId: { not: layout.id }, startsAt: { gt: new Date() } },
                include: { reservations: { include: { seat: { select: { code: true } } } } }
            });
            const seatsByCode = new Map(layout.seats.map(seat => [seat.code, seat]));
            for (const session of futureSessions) {
                const missing = session.reservations.filter(reservation => !seatsByCode.has(reservation.seat.code));
                check(!missing.length, `时段 ${session.id} 有预约座位在新布局中不存在，请保留座位编号后再发布`);
                for (const reservation of session.reservations) {
                    await tx.reservation.update({ where: { id: reservation.id }, data: { seatId: seatsByCode.get(reservation.seat.code)!.id } });
                }
                await tx.session.update({ where: { id: session.id }, data: { layoutId: layout.id } });
            }
            await tx.layoutVersion.update({ where: { id: layout.id }, data: { status: 'PUBLISHED', publishedAt: new Date() } });
            await audit(tx, user.id, 'LAYOUT_PUBLISH', layout.id, { syncedSessions: futureSessions.length });
            return { ok: true, syncedSessions: futureSessions.length };
        });
    if (key === 'admin/courses' && method === 'GET')
        return { courses: await db.course.findMany({ orderBy: { name: 'asc' } }) };
    if ((key === 'admin/courses' && method === 'POST') || (path[0] === 'admin' && path[1] === 'courses' && path.length === 3 && method === 'PUT')) {
        const data = courseSchema.parse(await body(req));
        return serial(async (tx) => { const course = path[2] ? await tx.course.update({ where: { id: path[2] }, data }) : await tx.course.create({ data }); await audit(tx, user.id, 'COURSE_SAVE', course.id, data); return { course }; });
    }
    if (key === 'admin/sessions' && method === 'GET')
        return { sessions: (await db.session.findMany({ include: sessionInclude, orderBy: { startsAt: 'desc' }, take: 500 })).map(s => ({ ...s, adminReady: s.open })) };
    if ((key === 'sessions' && method === 'POST') || (path[0] === 'sessions' && path.length === 2 && method === 'PUT')) {
        const data = sessionSchema.parse(await body(req));
        return serial(async (tx) => {
            check(Date.parse(data.startsAt) > Date.now(), '场次必须在未来开始');
            const layout = await tx.layoutVersion.findUnique({ where: { id: data.layoutId } });
            check(layout?.status === 'PUBLISHED', '请选择已发布的布局');
            if (!path[1]) {
                const latestLayout = await tx.layoutVersion.findFirst({ where: { venueId: layout.venueId, status: 'PUBLISHED' }, orderBy: { publishedAt: 'desc' } });
                check(latestLayout?.id === layout.id, '新时段必须使用该场地最新发布的布局');
            }
            if (path[1]) {
                await tx.$queryRaw `SELECT id FROM "Session" WHERE id = ${path[1]} FOR UPDATE`;
                const existing = await tx.session.findUnique({ where: { id: path[1] }, include: { _count: { select: { reservations: true, coverage: true } } } });
                check(existing, '场次不存在', 404);
                check(!existing.cancelledAt, '已取消时段不可修改');
                check(existing.startsAt > new Date(), '已开始场次不可修改');
                if (existing._count.reservations || existing._count.coverage)
                    check(existing.layoutId === data.layoutId && existing.startsAt.getTime() === Date.parse(data.startsAt) && existing.endsAt.getTime() === Date.parse(data.endsAt), '已有预约，不能修改时间或布局');
                if (await tx.reservation.count({ where: { sessionId: existing.id, cancelledAt: null } }))
                    check(data.requiredAssistants <= existing._count.coverage, '助教要求不能超过现有保障人数');
            }
            // One venue cannot host overlapping open sessions. Serializable predicate checks prevent races.
            if (data.open)
                check(!await tx.session.findFirst({ where: { id: { not: path[1] ?? '' }, open: true, layout: { venueId: layout.venueId }, startsAt: { lt: new Date(data.endsAt) }, endsAt: { gt: new Date(data.startsAt) } } }), '此场地在该时段已有开放场次', 409);
            const course = data.courseId ? await tx.course.findUnique({ where: { id: data.courseId } }) : await tx.course.findFirst({ orderBy: { id: 'asc' } });
            check(course, '系统尚未初始化自习室配置', 503);
            const values = { courseId: course.id, layoutId: data.layoutId, requiredAssistants: data.requiredAssistants, open: data.open && !!path[1], startsAt: new Date(data.startsAt), endsAt: new Date(data.endsAt) };
            const session = path[1] ? await tx.session.update({ where: { id: path[1] }, data: values }) : await tx.session.create({ data: values });
            await audit(tx, user.id, 'SESSION_SAVE', session.id, data);
            return { session };
        });
    }
    if (key === 'admin/reservations' && method === 'GET') {
        const sessionId = req.nextUrl.searchParams.get('sessionId') || undefined;
        const reservations = await db.reservation.findMany({ where: { sessionId }, include: recordInclude, orderBy: { createdAt: 'desc' }, take: req.nextUrl.searchParams.get('export') === 'csv' ? undefined : 5000 });
        if (req.nextUrl.searchParams.get('export') === 'csv') {
            const safe = (value: string) => '"' + (/^[=+\-@\t\r]/.test(value) ? "'" : '') + value.replaceAll('"', '""') + '"';
            const csv = [['姓名', '学号', '开始时间（上海）', '座位', '状态'], ...reservations.map(r => [r.user.name, r.user.studentId, r.session.startsAt.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }), r.seat.code, r.cancelledAt ? '已取消' : '已预约'])].map(row => row.map(safe).join(',')).join('\r\n');
            return new NextResponse('\uFEFF' + csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="reservations.csv"', 'Cache-Control': 'no-store' } });
        }
        return { reservations, coverage: await db.assistantCoverage.findMany({ where: { sessionId }, include: { assistant: { select: { name: true, email: true } }, session: { include: { course: true } } }, orderBy: { createdAt: 'desc' }, take: 5000 }) };
    }
    if (key === 'admin/logs' && method === 'GET')
        return { logs: await db.auditLog.findMany({ include: { actor: { select: { name: true, email: true } } }, orderBy: { createdAt: 'desc' }, take: 200 }) };
    throw new HttpError(404, '接口不存在');
}
async function handler(req: NextRequest, context: {
    params: Promise<{
        path: string[];
    }>;
}) {
    try {
        const result = await dispatch(req, (await context.params).path);
        return result instanceof NextResponse ? result : NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
    }
    catch (error) {
        if (error instanceof HttpError)
            return NextResponse.json({ error: error.message }, { status: error.status });
        if (error instanceof ZodError)
            return NextResponse.json({ error: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('；') }, { status: 400 });
        if (error instanceof Prisma.PrismaClientKnownRequestError) {
            if (error.code === 'P2002')
                return NextResponse.json({ error: '记录已存在，请刷新后重试（邮箱、座位或预约重复）' }, { status: 409 });
            if (error.code === 'P2025')
                return NextResponse.json({ error: '记录不存在' }, { status: 404 });
            if (error.code === 'P2003')
                return NextResponse.json({ error: '关联记录无效，请刷新后重试' }, { status: 400 });
            if (error.code === 'P2034')
                return NextResponse.json({ error: '操作冲突，请重试' }, { status: 409 });
        }
        console.error(error);
        return NextResponse.json({ error: '服务暂时不可用，请稍后重试' }, { status: 500 });
    }
}
export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE };
