import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { compare, hash } from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { z, ZodError } from 'zod';
import { db, serial, lockInvariant } from '@/lib/db';
import { currentUser, requireUser, createLogin, publicUser, hashToken, isOperator } from '@/lib/auth';
import { check, HttpError } from '@/lib/errors';
import { assertSameOrigin, readJson as body } from '@/lib/request';
import { reserveSeat, reserveSeatSlots, cancelReservation, assistantCovers, cancelUncoveredYsyxReservations, audit } from '@/lib/bookings';
import { maxMemberBookingTime, localParts } from '@/lib/rules';
import { password, studentId, layoutSchema, id } from '@/lib/validation';
export const runtime = 'nodejs';
const sessionInclude = { layout: { include: { venue: true, elements: true, seats: { orderBy: { code: 'asc' as const } } } }, reservations: { where: { cancelledAt: null }, select: { id: true, userId: true, seatId: true, startsAt: true, endsAt: true, user: { select: { role: true, enabled: true, deletedAt: true } } } } } as const;
const recordInclude = { session: { include: { layout: { include: { venue: true } } } }, seat: true, user: { select: { id: true, name: true, studentId: true, email: true, role: true } } } as const;
type SessionView = Prisma.SessionGetPayload<{ include: typeof sessionInclude }>;
function shanghaiDayRange(dateKey: string) {
    const start = new Date(`${dateKey}T00:00:00+08:00`);
    const end = new Date(start.getTime() + 86400000);
    check(!Number.isNaN(start.getTime()) && localParts(start).date === dateKey, '日期无效', 400);
    return { start, end };
}
function bookingDateKeys(now = new Date()) {
    return [localParts(now).date, localParts(new Date(now.getTime() + 86400000)).date];
}
function icilDayId(venueId: string, dateKey: string) {
    return `icil-${venueId}-${dateKey}`;
}
/**
 * Member bookings do not depend on an administrator-created session. We keep
 * them attached to a real Session row so the existing
 * reservation, cancellation and audit flows remain transactional.
 * One hidden all-day container is kept per venue and calendar day.
 */
async function ensureDailySessions() {
    const dateKeys = bookingDateKeys();
    const layouts = await db.layoutVersion.findMany({
        where: { status: 'PUBLISHED' },
        select: { id: true, venueId: true, publishedAt: true, createdAt: true },
        orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
    });
    const latestByVenue = new Map<string, (typeof layouts)[number]>();
    for (const layout of layouts)
        if (!latestByVenue.has(layout.venueId)) latestByVenue.set(layout.venueId, layout);
    return serial(async (tx) => {
        const ids: string[] = [];
        for (const layout of latestByVenue.values()) for (const dateKey of dateKeys) {
            const { start, end } = shanghaiDayRange(dateKey);
            const sessionId = icilDayId(layout.venueId, dateKey);
            const existing = await tx.session.upsert({
                where: { id: sessionId },
                create: { id: sessionId, layoutId: layout.id, startsAt: start, endsAt: end, requiredAssistants: 1, open: true, icilOnly: true },
                update: {},
                select: { id: true, layoutId: true, icilOnly: true },
            });
            check(existing.icilOnly, '全天预约记录标识冲突', 409);
            {
                // A published layout can change while some seats are
                // reserved. Keep those reservations by seat code when the new
                // layout contains them, then move the all-day container over.
                if (existing.layoutId !== layout.id) {
                    const activeReservations = await tx.reservation.findMany({ where: { sessionId, cancelledAt: null }, include: { seat: { select: { code: true } } } });
                    const targetSeats = await tx.seat.findMany({ where: { layoutId: layout.id }, select: { id: true, code: true } });
                    const targetSeatByCode = new Map(targetSeats.map(seat => [seat.code, seat.id]));
                    if (activeReservations.every(reservation => targetSeatByCode.has(reservation.seat.code))) {
                        for (const reservation of activeReservations)
                            await tx.reservation.update({ where: { id: reservation.id }, data: { seatId: targetSeatByCode.get(reservation.seat.code)! } });
                        await tx.session.update({ where: { id: sessionId }, data: { layoutId: layout.id, startsAt: start, endsAt: end, open: true, cancelledAt: null } });
                    }
                }
            }
            ids.push(sessionId);
        }
        return ids;
    });
}
async function cancelReservationsInRange(tx: Prisma.TransactionClient, actorId: string, startsAt: Date, endsAt: Date, reason: string) {
    const records = await tx.reservation.findMany({
        where: { cancelledAt: null, startsAt: { lt: endsAt }, endsAt: { gt: new Date(Math.max(startsAt.getTime(), Date.now())) } },
        select: { id: true, userId: true, seat: { select: { code: true } } },
    });
    if (records.length) {
        await tx.reservation.updateMany({ where: { id: { in: records.map(record => record.id) } }, data: { cancelledAt: new Date() } });
        await tx.notification.createMany({ data: records.map(record => ({ recipientId: record.userId, type: 'BOOKING_CANCELLED', message: `预约时间因管理员禁止预约${reason ? `（${reason}）` : ''}已取消，你的${record.seat.code}号工位已释放。` })) });
    }
    // Blocking an assistant can also leave a longer member booking without coverage.
    await cancelUncoveredYsyxReservations(tx, actorId);
    return { reservations: records.length };
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
        const input = z.object({ studentId, password: z.string().max(100).optional(), name: z.string().trim().min(1).max(60).optional(), role: z.enum(['USER', 'ADMIN']).optional() }).parse(await body(req));
        // Shared database counter works across app processes; do not trust client-supplied IP headers.
        const limiterKey = `${key}:${hashToken(input.studentId)}`;
        const attempt = await db.loginAttempt.upsert({ where: { key: limiterKey }, create: { key: limiterKey, resetAt: new Date(Date.now() + 900000) }, update: { count: { increment: 1 } } });
        if (attempt.resetAt < new Date())
            await db.loginAttempt.update({ where: { key: limiterKey }, data: { count: 1, resetAt: new Date(Date.now() + 900000) } });
        else
            check(attempt.count <= 15, '尝试次数过多，请 15 分钟后重试', 429);
        let user;
        if (key === 'auth/register') {
            check(input.role !== 'ADMIN', '管理员账号不能注册，请使用部署配置初始化', 403);
            check(input.name, '请输入姓名');
            check(input.password && password.safeParse(input.password).success, '密码至少需要 10 位字符');
            const generatedEmail = `${input.studentId}+user@student.local`;
            check(!await db.user.findFirst({ where: { studentId: input.studentId, deletedAt: null, role: { not: 'USER' } } }), '该学号已注册，请直接登录', 409);
            const existingLearner = await db.user.findUnique({ where: { studentId_role: { studentId: input.studentId, role: 'USER' } } });
            if (existingLearner) {
                if (existingLearner.deletedAt) {
                    user = await db.user.update({ where: { id: existingLearner.id }, data: { name: input.name, memberType: 'YSYX', enabled: true, deletedAt: null, passwordHash: await hash(input.password!, 12) }, select: publicUser });
                }
                else {
                    check(false, '该学号已注册学员账号，请直接登录', 409);
                }
            }
            else {
                user = await db.user.create({ data: { name: input.name, studentId: input.studentId, email: generatedEmail, role: 'USER', passwordHash: await hash(input.password!, 12) }, select: publicUser });
            }
        }
        else {
            check(input.password, '请输入密码');
            // Legacy databases may contain multiple roles for one student ID.
            // Match credentials at the single login endpoint; prefer the management role
            // only when more than one account shares the same password.
            const accounts = await db.user.findMany({ where: { studentId: input.studentId, enabled: true, deletedAt: null }, orderBy: { role: 'desc' } });
            let account: typeof accounts[number] | undefined;
            for (const candidate of accounts) {
                if (await compare(input.password, candidate.passwordHash)) { account = candidate; break; }
            }
            if (!accounts.length) await compare(input.password, '$2b$12$YGMMy9YbCI1QLcQ8ZqWr6u2ml.VFu9y1y90MhQbcTmwUxNp.t3Izq');
            check(account, '学号或密码错误，或账号已停用', 401);
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
        const user = await currentUser();
        const memberMax = !isOperator(user) ? maxMemberBookingTime() : undefined;
        let mergedSessions: (SessionView & { staffPresenceWindows?: { startsAt: Date; endsAt: Date }[] })[];
        {
            const virtualIds = await ensureDailySessions();
            const virtualSessions = await db.session.findMany({ where: { id: { in: virtualIds }, endsAt: { gt: new Date() }, cancelledAt: null }, include: sessionInclude, orderBy: { startsAt: 'asc' } });
            const dayStart = virtualSessions.reduce((min, s) => Math.min(min, s.startsAt.getTime()), Date.now());
            const dayEnd = virtualSessions.reduce((max, s) => Math.max(max, s.endsAt.getTime()), memberMax?.getTime() ?? Date.now());
            const actualSessions = await db.session.findMany({ where: { icilOnly: false, cancelledAt: null, endsAt: { gt: new Date(dayStart) }, startsAt: { lt: new Date(dayEnd) } }, include: sessionInclude });
            mergedSessions = virtualSessions.map(virtual => {
                const related = actualSessions.filter(actual => actual.layout.venueId === virtual.layout.venueId && actual.startsAt < virtual.endsAt && actual.endsAt > virtual.startsAt);
                const targetSeats = new Map(virtual.layout.seats.map(seat => [seat.code, seat.id]));
                const reservations = [...virtual.reservations];
                for (const actual of related) {
                    const sourceSeats = new Map(actual.layout.seats.map(seat => [seat.id, seat.code]));
                    for (const reservation of actual.reservations) {
                        const seatId = targetSeats.get(sourceSeats.get(reservation.seatId) ?? '');
                        if (seatId && !reservations.some(existing => existing.id === reservation.id))
                            reservations.push({ ...reservation, seatId });
                    }
                }
                const staffPresenceWindows = [
                    ...virtual.reservations.filter(r => r.user.role === 'ASSISTANT' && r.user.enabled && !r.user.deletedAt).map(r => ({ startsAt: r.startsAt, endsAt: r.endsAt })),
                    ...related.flatMap(actual => [
                    ...actual.reservations.filter(r => r.user.role === 'ASSISTANT' && r.user.enabled && !r.user.deletedAt).map(r => ({ startsAt: r.startsAt, endsAt: r.endsAt })),
                ])];
                return { ...virtual, reservations, staffPresenceWindows };
            });
        }
        const blocks = await db.bookingBlock.findMany({ where: { active: true, startsAt: { lt: new Date(Math.max(...mergedSessions.map(s => s.endsAt.getTime()), Date.now())) }, endsAt: { gt: new Date() } }, orderBy: { startsAt: 'asc' } });
        return { sessions: mergedSessions.map(s => {
            const matchingBlocks = blocks.filter(block => block.startsAt < s.endsAt && block.endsAt > s.startsAt);
            const fullSessionBlock = matchingBlocks.some(block => block.kind === 'DAY' || (block.startsAt <= s.startsAt && block.endsAt >= s.endsAt));
            return {
                ...s, bookingBlocks: matchingBlocks, bookingBlocked: fullSessionBlock,
                reservations: s.reservations.map(r => ({ seatId: r.seatId, mine: r.userId === user?.id, id: r.userId === user?.id ? r.id : undefined, startsAt: r.startsAt, endsAt: r.endsAt })),
                staffPresenceWindows: s.staffPresenceWindows ?? [],
            };
        }) };
    }
    const user = await requireUser();
    if (key === 'auth/change-password' && method === 'POST') {
        const data = z.object({ currentPassword: z.string().min(1).max(100), newPassword: password }).parse(await body(req));
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
    if (key === 'reservations' && method === 'POST') {
        const data = z.object({ sessionId: id, seatId: id, startsAt: z.string().datetime({ offset: true }).optional(), endsAt: z.string().datetime({ offset: true }).optional() }).refine(v => (!!v.startsAt === !!v.endsAt), '预约时间必须同时填写开始和结束时间').parse(await body(req));
        return { reservation: await reserveSeat(user.id, data.sessionId, data.seatId, data.startsAt, data.endsAt) };
    }
    if (key === 'reservations/batch' && method === 'POST') {
        const data = z.object({ sessionId: id, seatId: id, slots: z.array(z.object({ startsAt: z.string().datetime({ offset: true }), endsAt: z.string().datetime({ offset: true }) })).min(1).max(48) }).parse(await body(req));
        return reserveSeatSlots(user.id, data.sessionId, data.seatId, data.slots);
    }
    if (key === 'reservations' && method === 'GET')
        return { reservations: await db.reservation.findMany({ where: { userId: user.id }, include: recordInclude, orderBy: { createdAt: 'desc' }, take: 200 }) };
    if (path[0] === 'reservations' && path.length === 2 && method === 'DELETE')
        return cancelReservation(user.id, path[1]);
    check(user.role === 'ADMIN', '需要管理员权限', 403);
    if (key === 'admin/booking-blocks' && method === 'GET')
        return { blocks: await db.bookingBlock.findMany({ where: { active: true }, orderBy: { startsAt: 'desc' }, take: 500 }) };
    if (key === 'admin/booking-blocks' && method === 'POST') {
        const data = z.object({ startsAt: z.string().datetime({ offset: true }), endsAt: z.string().datetime({ offset: true }), reason: z.string().trim().max(200).default('') }).parse(await body(req));
        const startsAt = new Date(data.startsAt), endsAt = new Date(data.endsAt);
        check(endsAt > startsAt, '结束时间必须晚于开始时间');
        check(endsAt > new Date(), '禁止预约时间必须包含未来时间');
        return serial(async (tx) => {
            const block = await tx.bookingBlock.create({ data: { kind: 'SESSION', startsAt, endsAt, reason: data.reason, createdById: user.id } });
            const result = await cancelReservationsInRange(tx, user.id, startsAt, endsAt, data.reason);
            await audit(tx, user.id, 'BOOKING_BLOCK_CREATE', block.id, { startsAt, endsAt, reason: data.reason, ...result });
            return { block, ...result };
        });
    }
    if (path[0] === 'admin' && path[1] === 'booking-blocks' && path.length === 3 && method === 'DELETE') {
        return serial(async (tx) => {
            const block = await tx.bookingBlock.findUnique({ where: { id: path[2] } });
            check(block?.active, '禁止预约记录不存在', 404);
            await tx.bookingBlock.update({ where: { id: block.id }, data: { active: false } });
            await audit(tx, user.id, 'BOOKING_BLOCK_REMOVE', block.id);
            return { ok: true };
        });
    }
    if (key === 'admin/stats' && method === 'GET') {
        const [users, blocks, reservations, layouts] = await Promise.all([db.user.count(), db.bookingBlock.count({ where: { active: true, endsAt: { gt: new Date() } } }), db.reservation.count({ where: { cancelledAt: null } }), db.layoutVersion.count({ where: { status: 'PUBLISHED' } })]);
        return { users, blocks, reservations, layouts };
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
        const data = z.object({ name: z.string().trim().min(1).max(60), role: z.enum(['ADMIN', 'ASSISTANT', 'USER']), memberType: z.enum(['YSYX', 'ICIL']).default('YSYX'), enabled: z.boolean() }).parse(await body(req));
        return serial(async (tx) => {
            await lockInvariant(tx, 'admin-role-protection');
            await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${path[2]} FOR UPDATE`;
            const target = await tx.user.findUnique({ where: { id: path[2] } });
            check(target, '用户不存在', 404);
            check(!target.deletedAt, '已注销账号不能再编辑', 409);
            if (target.role === 'ADMIN' && (!data.enabled || data.role !== 'ADMIN'))
                check(await tx.user.count({ where: { role: 'ADMIN', enabled: true, deletedAt: null } }) > 1, '必须保留至少一名启用的管理员');
            const result = await tx.user.update({ where: { id: target.id }, data: { ...data, memberType: data.role === 'USER' ? data.memberType : 'YSYX' }, select: publicUser });
            const downgradedFromIcil = target.role === 'USER' && target.memberType === 'ICIL' && data.role === 'USER' && data.memberType === 'YSYX';
            let cancelledIcilReservations = 0;
            if (downgradedFromIcil) {
                const now = new Date();
                const candidates = await tx.reservation.findMany({
                    where: { userId: target.id, cancelledAt: null, startsAt: { gt: now }, session: { cancelledAt: null } },
                    include: { seat: { select: { code: true } }, session: { include: { layout: { select: { venueId: true } } } } },
                });
                const sessionIds = [...new Set(candidates.map(record => record.sessionId))];
                for (const sessionId of sessionIds)
                    await tx.$queryRaw`SELECT id FROM "Session" WHERE id = ${sessionId} FOR UPDATE`;
                const cancelled: typeof candidates = [];
                for (const record of candidates) {
                    const session = await tx.session.findUniqueOrThrow({ where: { id: record.sessionId }, select: { open: true, cancelledAt: true, startsAt: true, endsAt: true, icilOnly: true, layout: { select: { venueId: true } } } });
                    const block = await tx.bookingBlock.findFirst({ where: { active: true, startsAt: { lt: record.endsAt }, endsAt: { gt: record.startsAt } } });
                    const validForYsyx = !session.cancelledAt && !block && record.endsAt <= maxMemberBookingTime(now) && await assistantCovers(tx, session.layout.venueId, record.startsAt, record.endsAt);
                    if (!validForYsyx)
                        cancelled.push(record);
                }
                if (cancelled.length) {
                    const cancelledAt = new Date();
                    await tx.reservation.updateMany({ where: { id: { in: cancelled.map(record => record.id) } }, data: { cancelledAt } });
                    await tx.notification.createMany({ data: cancelled.map(record => ({ recipientId: target.id, type: 'BOOKING_CANCELLED', message: `${record.startsAt.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}至${record.endsAt.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit' })}的预约不符合YSYX成员规则，已自动取消，你的${record.seat.code}号工位已释放。` })) });
                    cancelledIcilReservations = cancelled.length;
                }
            }
            if (target.role !== 'USER' && (data.role === 'USER' || !data.enabled))
                await tx.assistantCoverage.deleteMany({ where: { assistantId: target.id } });
            if (target.role === 'ASSISTANT' && (data.role !== 'ASSISTANT' || !data.enabled))
                await cancelUncoveredYsyxReservations(tx, user.id);
            if (!data.enabled)
                await tx.authSession.deleteMany({ where: { userId: target.id } });
            await audit(tx, user.id, 'USER_UPDATE', target.id, { ...data, cancelledIcilReservations });
            return { user: result };
        });
    }
    if (path[0] === 'admin' && path[1] === 'users' && path.length === 3 && method === 'DELETE') {
        check(path[2] !== user.id, '不能注销当前登录的管理员账号', 409);
        return serial(async (tx) => {
            await lockInvariant(tx, 'admin-role-protection');
            await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${path[2]} FOR UPDATE`;
            const target = await tx.user.findUnique({ where: { id: path[2] } });
            check(target, '用户不存在', 404);
            check(!target.deletedAt, '该账号已经注销', 409);
            if (target.role === 'ADMIN' && target.enabled)
                check(await tx.user.count({ where: { role: 'ADMIN', enabled: true, deletedAt: null } }) > 1, '必须保留至少一名启用的管理员');

            const now = new Date();
            const cancelled = await tx.reservation.updateMany({
                where: { userId: target.id, cancelledAt: null, endsAt: { gt: now } },
                data: { cancelledAt: now },
            });
            await tx.authSession.deleteMany({ where: { userId: target.id } });
            await tx.user.update({ where: { id: target.id }, data: { enabled: false, deletedAt: now } });

            if (target.role === 'ASSISTANT') await cancelUncoveredYsyxReservations(tx, user.id);
            await audit(tx, user.id, 'USER_DELETE', target.id, { role: target.role, cancelledReservations: cancelled.count });
            return { ok: true, cancelledReservations: cancelled.count };
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
            const linkedSessions = await tx.session.findMany({
                where: { layoutId: layout.id },
                select: { id: true, open: true, cancelledAt: true, icilOnly: true },
            });
            const ordinarySessions = linkedSessions.filter(session => !session.icilOnly);
            check(ordinarySessions.every(session => !session.open || session.cancelledAt), '请先暂停或取消所有关联时段，再删除布局', 409);
            const sessionIds = linkedSessions.map(session => session.id);
            const activeMemberReservations = await tx.reservation.count({ where: { OR: [{ sessionId: { in: sessionIds } }, { seat: { layoutId: layout.id } }], cancelledAt: null, user: { role: 'USER' } } });
            check(activeMemberReservations === 0, '该布局仍有学员有效预约，不能删除', 409);
            const activeExternalAdminReservations = await tx.reservation.count({ where: { sessionId: { notIn: sessionIds }, seat: { layoutId: layout.id }, cancelledAt: null, user: { role: { in: ['ADMIN', 'ASSISTANT'] } } } });
            check(activeExternalAdminReservations === 0, '该布局座位仍被其他时段的管理员预约使用，不能删除', 409);
            const activeReservations = await tx.reservation.count({ where: { OR: [{ sessionId: { in: sessionIds } }, { seat: { layoutId: layout.id } }], cancelledAt: null } });
            const historicalReservations = await tx.reservation.count({ where: { OR: [{ sessionId: { in: sessionIds } }, { seat: { layoutId: layout.id } }] } });
            await tx.reservation.deleteMany({ where: { OR: [{ sessionId: { in: sessionIds } }, { seat: { layoutId: layout.id } }] } });
            await tx.assistantCoverage.deleteMany({ where: { sessionId: { in: sessionIds } } });
            await tx.bookingBlock.deleteMany({ where: { sessionId: { in: sessionIds } } });
            await tx.session.deleteMany({ where: { id: { in: sessionIds } } });
            await tx.layoutVersion.delete({ where: { id: layout.id } });
            await audit(tx, user.id, 'LAYOUT_DELETE', layout.id, { name: layout.name, deletedSessions: linkedSessions.length, removedActiveReservations: activeReservations, removedHistoricalReservations: historicalReservations });
            return { ok: true };
        });
    }
    if (path[0] === 'layouts' && path.length === 2 && method === 'PUT') {
        const data = layoutSchema.parse(await body(req));
        return serial(async (tx) => {
            await tx.$queryRaw`SELECT id FROM "LayoutVersion" WHERE id = ${path[1]} FOR UPDATE`;
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
            await tx.$queryRaw`SELECT id FROM "LayoutVersion" WHERE id = ${path[1]} FOR UPDATE`;
            const layout = await tx.layoutVersion.findUnique({ where: { id: path[1] }, include: { seats: true } });
            check(layout?.status === 'DRAFT' && layout.seats.some(s => s.enabled), '请先保存至少一个可用座位');
            const futureSessions = await tx.session.findMany({
                where: { layout: { venueId: layout.venueId }, layoutId: layout.sourceLayoutId ?? '__no_source__', startsAt: { gt: new Date() }, cancelledAt: null, icilOnly: false, reservations: { none: { cancelledAt: null } } },
                orderBy: { startsAt: 'asc' },
                take: 1,
                include: { reservations: { where: { cancelledAt: null }, include: { seat: { select: { code: true } } } } }
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
    if (key === 'admin/reservations' && method === 'GET') {
        const sessionId = req.nextUrl.searchParams.get('sessionId') || undefined;
        const reservations = await db.reservation.findMany({ where: { sessionId }, include: recordInclude, orderBy: { createdAt: 'desc' }, take: req.nextUrl.searchParams.get('export') === 'csv' ? undefined : 5000 });
        if (req.nextUrl.searchParams.get('export') === 'csv') {
            const safe = (value: string) => '"' + (/^[=+\-@\t\r]/.test(value) ? "'" : '') + value.replaceAll('"', '""') + '"';
            const csv = [['姓名', '学号', '开始时间（上海）', '结束时间（上海）', '座位', '状态'], ...reservations.map(r => [r.user.name, r.user.studentId, r.startsAt.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }), r.endsAt.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }), r.seat.code, r.cancelledAt ? '已取消' : '已预约'])].map(row => row.map(safe).join(',')).join('\r\n');
            return new NextResponse('\uFEFF' + csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="reservations.csv"', 'Cache-Control': 'no-store' } });
        }
        return { reservations };
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
