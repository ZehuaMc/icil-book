import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { compare, hash } from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { z, ZodError } from 'zod';
import { db, serial } from '@/lib/db';
import { currentUser, requireUser, createLogin, publicUser, hashToken } from '@/lib/auth';
import { check, HttpError } from '@/lib/errors';
import { assertSameOrigin, readJson as body } from '@/lib/request';
import { reserveSeat, cancelReservation, addCoverage, removeCoverage, audit } from '@/lib/bookings';
import { groupAllows } from '@/lib/rules';
import { email, password, groupSchema, courseSchema, layoutSchema, sessionSchema, id } from '@/lib/validation';
export const runtime = 'nodejs';
const sessionInclude = { course: true, layout: { include: { venue: true, elements: true, seats: { orderBy: { code: 'asc' as const } } } }, coverage: { include: { assistant: { select: { id: true, name: true } } } }, reservations: { where: { cancelledAt: null }, select: { id: true, userId: true, seatId: true } } } as const;
const recordInclude = { session: { include: { course: true, layout: { include: { venue: true } } } }, seat: true, user: { select: { id: true, name: true, email: true } } } as const;
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
        const input = z.object({ email, password: key.endsWith('register') ? password : z.string().min(1).max(100), name: z.string().trim().min(1).max(60).optional() }).parse(await body(req));
        // Shared database counter works across app processes; do not trust client-supplied IP headers.
        const limiterKey = `${key}:${hashToken(input.email)}`;
        const attempt = await db.loginAttempt.upsert({ where: { key: limiterKey }, create: { key: limiterKey, resetAt: new Date(Date.now() + 900000) }, update: { count: { increment: 1 } } });
        if (attempt.resetAt < new Date())
            await db.loginAttempt.update({ where: { key: limiterKey }, data: { count: 1, resetAt: new Date(Date.now() + 900000) } });
        else
            check(attempt.count <= 15, '尝试次数过多，请 15 分钟后重试', 429);
        let user;
        if (key === 'auth/register') {
            check(input.name, '请输入姓名');
            const settings = await db.appSetting.findUnique({ where: { id: 'main' } });
            check(settings, '请先初始化数据库', 503);
            user = await db.user.create({ data: { name: input.name, email: input.email, passwordHash: await hash(input.password, 12), groupId: settings.defaultGroupId }, select: publicUser });
        }
        else {
            const account = await db.user.findUnique({ where: { email: input.email } });
            const matched = await compare(input.password, account?.passwordHash ?? '$2b$12$YGMMy9YbCI1QLcQ8ZqWr6u2ml.VFu9y1y90MhQbcTmwUxNp.t3Izq');
            check(account && matched && account.enabled, '邮箱或密码错误，或账号已停用', 401);
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
        const sessions = await db.session.findMany({ where: { endsAt: { gte: new Date() } }, include: sessionInclude, orderBy: { startsAt: 'asc' }, take: 100 });
        return { sessions: sessions.map(s => ({ ...s, allowed: !!user && groupAllows(user.group, s.startsAt, s.endsAt), reservations: s.reservations.map(r => ({ seatId: r.seatId, mine: r.userId === user?.id, id: r.userId === user?.id ? r.id : undefined })) })) };
    }
    const user = await requireUser();
    if (key === 'reservations' && method === 'POST') {
        const data = z.object({ sessionId: id, seatId: id }).parse(await body(req));
        return { reservation: await reserveSeat(user.id, data.sessionId, data.seatId) };
    }
    if (key === 'reservations' && method === 'GET')
        return { reservations: await db.reservation.findMany({ where: { userId: user.id }, include: recordInclude, orderBy: { createdAt: 'desc' }, take: 200 }), coverage: await db.assistantCoverage.findMany({ where: { assistantId: user.id }, include: { session: { include: { course: true, layout: { include: { venue: true } } } } }, orderBy: { createdAt: 'desc' } }) };
    if (path[0] === 'reservations' && path.length === 2 && method === 'DELETE')
        return cancelReservation(user.id, path[1]);
    if (key === 'reservations/coverage' && method === 'POST')
        return { coverage: await addCoverage(user.id, z.object({ sessionId: id }).parse(await body(req)).sessionId) };
    if (path[0] === 'reservations' && path[1] === 'coverage' && path.length === 3 && method === 'DELETE')
        return removeCoverage(user.id, path[2]);
    check(user.role === 'ADMIN', '需要管理员权限', 403);
    if (key === 'admin/stats' && method === 'GET') {
        const [users, sessions, reservations, layouts] = await Promise.all([db.user.count(), db.session.count({ where: { startsAt: { gte: new Date() } } }), db.reservation.count({ where: { cancelledAt: null } }), db.layoutVersion.count({ where: { status: 'PUBLISHED' } })]);
        return { users, sessions, reservations, layouts };
    }
    if (key === 'admin/users' && method === 'GET')
        return { users: await db.user.findMany({ select: publicUser, orderBy: { createdAt: 'desc' }, take: 500 }) };
    if (path[0] === 'admin' && path[1] === 'users' && path.length === 3 && method === 'PATCH') {
        const data = z.object({ name: z.string().trim().min(1).max(60), role: z.enum(['ADMIN', 'ASSISTANT', 'USER']), enabled: z.boolean(), groupId: id }).parse(await body(req));
        return serial(async (tx) => {
            const target = await tx.user.findUnique({ where: { id: path[2] } });
            check(target, '用户不存在', 404);
            if (target.role === 'ADMIN' && (!data.enabled || data.role !== 'ADMIN'))
                check(await tx.user.count({ where: { role: 'ADMIN', enabled: true } }) > 1, '必须保留至少一名启用的管理员');
            if (!data.enabled || data.role !== 'ASSISTANT')
                check(!await tx.assistantCoverage.count({ where: { assistantId: target.id, session: { startsAt: { gt: new Date() } } } }), '请先处理此用户未来场次的助教保障预约');
            const result = await tx.user.update({ where: { id: target.id }, data, select: publicUser });
            if (!data.enabled)
                await tx.authSession.deleteMany({ where: { userId: target.id } });
            await audit(tx, user.id, 'USER_UPDATE', target.id, data);
            return { user: result };
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
            const layout = await tx.layoutVersion.create({ data: { name: data.name, venueId: data.venueId, width: source?.width, height: source?.height } });
            const elementMap = new Map<string, string>();
            if (source) {
                for (const e of source.elements) {
                    const { id: oldId, layoutId: _, ...value } = e;
                    const added = await tx.layoutElement.create({ data: { ...value, layoutId: layout.id } });
                    elementMap.set(oldId, added.id);
                }
                for (const s of source.seats) {
                    const { id: _, layoutId: __, elementId, ...value } = s;
                    await tx.seat.create({ data: { ...value, layoutId: layout.id, elementId: elementId ? elementMap.get(elementId) : null } });
                }
            }
            await audit(tx, user.id, 'LAYOUT_CREATE', layout.id, data);
            return { layout };
        });
    }
    if (path[0] === 'layouts' && path.length === 2 && method === 'PUT') {
        const data = layoutSchema.parse(await body(req));
        return serial(async (tx) => {
            const layout = await tx.layoutVersion.findUnique({ where: { id: path[1] } });
            check(layout?.status === 'DRAFT', '已发布布局不可修改，请复制为新版本', 409);
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
            await tx.layoutVersion.update({ where: { id: layout.id }, data: { status: 'PUBLISHED', publishedAt: new Date() } });
            await audit(tx, user.id, 'LAYOUT_PUBLISH', layout.id);
            return { ok: true };
        });
    if (key === 'admin/courses' && method === 'GET')
        return { courses: await db.course.findMany({ orderBy: { name: 'asc' } }) };
    if ((key === 'admin/courses' && method === 'POST') || (path[0] === 'admin' && path[1] === 'courses' && path.length === 3 && method === 'PUT')) {
        const data = courseSchema.parse(await body(req));
        return serial(async (tx) => { const course = path[2] ? await tx.course.update({ where: { id: path[2] }, data }) : await tx.course.create({ data }); await audit(tx, user.id, 'COURSE_SAVE', course.id, data); return { course }; });
    }
    if (key === 'admin/sessions' && method === 'GET')
        return { sessions: await db.session.findMany({ include: sessionInclude, orderBy: { startsAt: 'desc' }, take: 500 }) };
    if ((key === 'sessions' && method === 'POST') || (path[0] === 'sessions' && path.length === 2 && method === 'PUT')) {
        const data = sessionSchema.parse(await body(req));
        return serial(async (tx) => {
            check(Date.parse(data.startsAt) > Date.now(), '场次必须在未来开始');
            const layout = await tx.layoutVersion.findUnique({ where: { id: data.layoutId } });
            check(layout?.status === 'PUBLISHED', '请选择已发布的布局');
            if (path[1]) {
                await tx.$queryRaw `SELECT id FROM "Session" WHERE id = ${path[1]} FOR UPDATE`;
                const existing = await tx.session.findUnique({ where: { id: path[1] }, include: { _count: { select: { reservations: true, coverage: true } } } });
                check(existing, '场次不存在', 404);
                check(existing.startsAt > new Date(), '已开始场次不可修改');
                if (existing._count.reservations || existing._count.coverage)
                    check(existing.layoutId === data.layoutId && existing.startsAt.getTime() === Date.parse(data.startsAt) && existing.endsAt.getTime() === Date.parse(data.endsAt) && existing.courseId === data.courseId, '已有预约，不能修改课程、时间或布局');
                if (await tx.reservation.count({ where: { sessionId: existing.id, cancelledAt: null } }))
                    check(data.requiredAssistants <= existing._count.coverage, '助教要求不能超过现有保障人数');
            }
            // One venue cannot host overlapping open sessions. Serializable predicate checks prevent races.
            if (data.open)
                check(!await tx.session.findFirst({ where: { id: { not: path[1] ?? '' }, open: true, layout: { venueId: layout.venueId }, startsAt: { lt: new Date(data.endsAt) }, endsAt: { gt: new Date(data.startsAt) } } }), '此场地在该时段已有开放场次', 409);
            const values = { ...data, startsAt: new Date(data.startsAt), endsAt: new Date(data.endsAt) };
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
            const csv = [['姓名', '邮箱', '课程', '开始时间（上海）', '座位', '状态'], ...reservations.map(r => [r.user.name, r.user.email, r.session.course.name, r.session.startsAt.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }), r.seat.code, r.cancelledAt ? '已取消' : '已预约'])].map(row => row.map(safe).join(',')).join('\r\n');
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
