import { db, serial, type Tx } from './db';
import { check } from './errors';
import { groupAllows, maxMemberBookingTime } from './rules';
import { isOperator } from './auth';
function formatShanghai(date: Date) {
    return date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}
export async function expireUnconfirmedReservations() {
    const cutoff = new Date(Date.now() - 15 * 60 * 1000);
    await db.reservation.updateMany({ where: { cancelledAt: null, checkedInAt: null, startsAt: { lt: cutoff } }, data: { cancelledAt: new Date() } });
}
export async function audit(tx: Tx, actorId: string, action: string, target: string, details: object = {}) {
    await tx.auditLog.create({ data: { actorId, action, target, details: JSON.parse(JSON.stringify(details)) } });
}
async function bookingContext(tx: Tx, actorId: string, sessionId: string) {
    // All seat, coverage, and session mutations take the same row lock.
    await tx.$queryRaw `SELECT id FROM "Session" WHERE id = ${sessionId} FOR UPDATE`;
    const [user, session] = await Promise.all([
        tx.user.findUnique({ where: { id: actorId }, include: { group: { include: { weeklyRules: true, dateRules: true } } } }),
        tx.session.findUnique({ where: { id: sessionId }, include: { coverage: true, adminBookings: true } }),
    ]);
    check(user?.enabled, '账号不可用', 403);
    check(session, '场次不存在', 404);
    return { user, session };
}
async function activeBookingBlock(tx: Tx, startsAt: Date, endsAt: Date) {
    return tx.bookingBlock.findFirst({
        where: { active: true, startsAt: { lt: endsAt }, endsAt: { gt: startsAt } },
        orderBy: { startsAt: 'asc' },
    });
}
export async function reserveSeat(actorId: string, sessionId: string, seatId: string, requestedStartsAt?: string, requestedEndsAt?: string) {
    return serial(async (tx) => {
        const { user, session } = await bookingContext(tx, actorId, sessionId);
        const operator = isOperator(user);
        const startsAt = requestedStartsAt ? new Date(requestedStartsAt) : session.startsAt;
        const endsAt = requestedEndsAt ? new Date(requestedEndsAt) : session.endsAt;
        check(!session.cancelledAt, '此时段已取消，不能预约');
        check(Number.isFinite(startsAt.getTime()) && Number.isFinite(endsAt.getTime()) && endsAt > startsAt, '请选择有效的预约时间');
        if (!operator && user.memberType === 'ICIL')
            check(session.icilOnly, 'ICIL成员请从全天预约入口选择日期和工位', 403);
        check(startsAt >= session.startsAt && endsAt <= session.endsAt, !operator && user.memberType === 'ICIL' ? 'ICIL预约时间必须在所选日期内' : '学员预约时间必须在管理员开放时段内');
        check(startsAt > new Date(), '预约开始时间必须在当前时间之后');
        const block = await activeBookingBlock(tx, startsAt, endsAt);
        check(!block, block?.kind === 'DAY' ? '该日期已禁用预约' : '该时段已禁用预约', 403);
        if (!operator) {
            check(endsAt <= maxMemberBookingTime(), '成员最多只能提前一天预约', 403);
            if (user.memberType === 'YSYX') {
                check(session.open, '管理员尚未开放此时间，暂未开放选座', 403);
                check(await tx.reservation.count({ where: { sessionId, cancelledAt: null, user: { role: { in: ['ADMIN', 'ASSISTANT'] } } } }) > 0, '当前时段暂无管理员工位，暂不能预约', 403);
                check(groupAllows(user.group, startsAt, endsAt), '所属分组不允许预约此时段', 403);
            }
        }
        const seat = await tx.seat.findUnique({ where: { id: seatId } });
        check(seat?.enabled && seat.layoutId === session.layoutId && (operator || !seat.fixedForAssistant), seat?.fixedForAssistant ? '该座位为管理员固定工位，学员不可预约' : '管理员或学员才可以预约此座位', 403);
        check(!await tx.reservation.findFirst({ where: { sessionId, userId: actorId, cancelledAt: null } }), '每人每场只能预约一个座位', 409);
        check(!await tx.reservation.findFirst({ where: { sessionId, seatId, cancelledAt: null, startsAt: { lt: endsAt }, endsAt: { gt: startsAt } } }), '该座位在此时间段刚被预约，请选择其他座位或时间', 409);
        const layout = await tx.layoutVersion.findUnique({ where: { id: session.layoutId }, select: { venueId: true } });
        check(layout, '场地布局不存在', 409);
        const overlappingVenueReservations = await tx.reservation.findMany({
            where: {
                sessionId: { not: sessionId },
                cancelledAt: null,
                seat: { code: seat.code },
                startsAt: { lt: endsAt },
                endsAt: { gt: startsAt },
                session: { cancelledAt: null, layout: { venueId: layout.venueId }, startsAt: { lt: endsAt }, endsAt: { gt: startsAt } },
            },
            select: { userId: true },
        });
        check(!overlappingVenueReservations.some(reservation => reservation.userId !== actorId), '该座位在重叠开放时段已有其他用户预约，请选择其他座位或时间', 409);
        const result = await tx.reservation.create({ data: { sessionId, seatId, userId: actorId, startsAt, endsAt } });
        await audit(tx, actorId, 'RESERVATION_CREATE', result.id, { sessionId, seat: seat.code, startsAt, endsAt });
        return result;
    });
}
export async function cancelReservation(actorId: string, id: string) {
    const record = await db.reservation.findUnique({ where: { id } });
    check(record, '预约不存在', 404);
    return serial(async (tx) => {
        const { user, session } = await bookingContext(tx, actorId, record.sessionId);
        const fresh = await tx.reservation.findUniqueOrThrow({ where: { id }, include: { user: true, seat: true } });
        check(isOperator(user) || fresh.userId === actorId, '无权取消此预约', 403);
        check(fresh.startsAt > new Date(), '预约开始后无法取消');
        check(!fresh.cancelledAt, '此预约已经取消', 409);
        const cancelledAt = new Date();
        const result = await tx.reservation.update({ where: { id }, data: { cancelledAt } });
        await audit(tx, actorId, 'RESERVATION_CANCEL', id, { sessionId: session.id });
        // An administrator reservation is the seat that keeps the time open.
        // Removing the last one closes the time and cancels learner bookings
        // in the same transaction, so no learner can book a slot without staff.
        if (isOperator(fresh.user)) {
            const remainingAdmins = await tx.reservation.count({
                where: { sessionId: session.id, cancelledAt: null, user: { role: { in: ['ADMIN', 'ASSISTANT'] } } },
            });
            if (remainingAdmins === 0) {
                const learners = await tx.reservation.findMany({
                    where: { sessionId: session.id, cancelledAt: null, user: { role: 'USER', memberType: 'YSYX' } },
                    select: { id: true, userId: true, seat: { select: { code: true } } },
                });
                if (learners.length) {
                    await tx.reservation.updateMany({ where: { id: { in: learners.map(learner => learner.id) } }, data: { cancelledAt } });
                    const starts = session.startsAt.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
                    const ends = session.endsAt.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit' });
                    await tx.notification.createMany({
                        data: learners.map(learner => ({
                            recipientId: learner.userId,
                            type: 'BOOKING_CANCELLED',
                            message: `${starts}至${ends}的预约时段因管理员取消坐镇预约、暂无其他管理员值守，已关闭。你的${learner.seat.code}号工位预约已自动取消。`,
                        })),
                    });
                }
                await audit(tx, actorId, 'SESSION_ADMIN_UNREADY', session.id, { reason: 'NO_ADMIN_BOOKING', cancelledLearners: learners.length });
            }
        }
        return result;
    });
}
export async function checkInReservation(actorId: string, id: string) {
    return serial(async (tx) => {
        const record = await tx.reservation.findUnique({ where: { id }, include: { session: true } });
        check(record, '预约不存在', 404);
        check(record.userId === actorId, '只能为自己的预约打卡', 403);
        check(!record.cancelledAt, '此预约已失效', 409);
        check(!record.checkedInAt, '此预约已经打卡', 409);
        const now = new Date();
        const checkInStart = new Date(record.startsAt.getTime() - 10 * 60 * 1000);
        const checkInEnd = new Date(record.startsAt.getTime() + 10 * 60 * 1000);
        check(checkInStart <= now && now <= checkInEnd, '请在预约开始前后 10 分钟内打卡');
        const result = await tx.reservation.update({ where: { id }, data: { checkedInAt: new Date() } });
        await audit(tx, actorId, 'RESERVATION_CHECK_IN', id, { sessionId: record.sessionId });
        return result;
    });
}

export async function replaceAdminSeat(actorId: string, sessionId: string, seatId: string) {
    return serial(async (tx) => {
        await tx.$queryRaw `SELECT id FROM "Session" WHERE id = ${sessionId} FOR UPDATE`;
        const [user, session] = await Promise.all([
            tx.user.findUnique({ where: { id: actorId } }),
            tx.session.findUnique({ where: { id: sessionId } }),
        ]);
        check(user?.enabled && isOperator(user), '需要管理员权限', 403);
        check(session, '场次不存在', 404);
        check(!session.icilOnly, 'ICIL全天预约不能选择管理员工位', 409);
        check(!session.cancelledAt, '此时段已取消，不能更换工位');
        check(session.startsAt > new Date(), '已开始场次不能更换工位');
        check(!session.open, '请先暂停开放此时间，再更换管理员工位', 409);

        const seat = await tx.seat.findUnique({ where: { id: seatId } });
        check(seat?.enabled && seat.layoutId === session.layoutId, '所选工位不属于此时段布局', 400);
        const current = await tx.reservation.findMany({
            where: { sessionId, userId: actorId, cancelledAt: null },
            include: { seat: true },
            orderBy: { createdAt: 'asc' },
        });
        if (current.length === 1 && current[0].seatId === seatId)
            return current[0];

        const occupied = await tx.reservation.findFirst({
            where: {
                sessionId,
                seatId,
                cancelledAt: null,
                userId: { not: actorId },
                startsAt: { lt: session.endsAt },
                endsAt: { gt: session.startsAt },
            },
        });
        check(!occupied, '该工位在此时间段已有预约，请选择其他工位', 409);

        const now = new Date();
        if (current.length)
            await tx.reservation.updateMany({ where: { id: { in: current.map(record => record.id) } }, data: { cancelledAt: now } });
        const result = await tx.reservation.create({ data: { sessionId, seatId, userId: actorId, startsAt: session.startsAt, endsAt: session.endsAt } });
        await audit(tx, actorId, 'ADMIN_SEAT_REPLACE', result.id, {
            sessionId,
            oldSeats: current.map(record => record.seat.code),
            seat: seat.code,
        });
        return result;
    });
}
export async function addCoverage(actorId: string, sessionId: string, requestedStartsAt?: string, requestedEndsAt?: string) {
    return serial(async (tx) => {
        const { user, session } = await bookingContext(tx, actorId, sessionId);
        check(user.role === 'ASSISTANT', '仅助教可以登记现场保障', 403);
        const startsAt = requestedStartsAt ? new Date(requestedStartsAt) : session.startsAt;
        const endsAt = requestedEndsAt ? new Date(requestedEndsAt) : session.endsAt;
        check(Number.isFinite(startsAt.getTime()) && Number.isFinite(endsAt.getTime()) && endsAt > startsAt, '请选择有效的开始和结束时间');
        check(endsAt.getTime() - startsAt.getTime() <= 86400000, '保障时段不能超过 24 小时');
        check(session.open && startsAt > new Date(), '只能选择当前时间之后的保障时段');
        const mine = await tx.assistantCoverage.findUnique({ where: { sessionId_assistantId: { sessionId, assistantId: actorId } } });
        const activeReservations = await tx.reservation.count({ where: { sessionId, cancelledAt: null } });
        if (startsAt.getTime() !== session.startsAt.getTime() || endsAt.getTime() !== session.endsAt.getTime()) {
            check(!activeReservations, '已有学员预约后不能调整保障时段');
            await tx.session.update({ where: { id: sessionId }, data: { startsAt, endsAt } });
        }
        if (mine) {
            await audit(tx, actorId, 'COVERAGE_TIME_UPDATE', mine.id, { sessionId, startsAt, endsAt });
            return mine;
        }
        const result = await tx.assistantCoverage.create({ data: { sessionId, assistantId: actorId } });
        await audit(tx, actorId, 'COVERAGE_CREATE', result.id, { sessionId, startsAt, endsAt });
        return result;
    });
}
export async function createAssistantSession(actorId: string, layoutId: string, startsAtValue: string, endsAtValue: string) {
    return serial(async (tx) => {
        const user = await tx.user.findUnique({ where: { id: actorId } });
        check(user?.enabled && user.role === 'ASSISTANT', '仅助教可以创建保障时段', 403);
        const startsAt = new Date(startsAtValue), endsAt = new Date(endsAtValue);
        check(Number.isFinite(startsAt.getTime()) && Number.isFinite(endsAt.getTime()) && endsAt > startsAt, '请选择有效的开始和结束时间');
        const now = new Date();
        check(endsAt > now, '只能选择当前时间之后的时段');
        check(endsAt.getTime() - startsAt.getTime() <= 86400000, '保障时段不能超过 24 小时');
        const layout = await tx.layoutVersion.findUnique({ where: { id: layoutId } });
        check(layout?.status === 'PUBLISHED', '请选择已发布的布局');
        const course = await tx.course.findFirst({ orderBy: { name: 'asc' } });
        check(course, '系统尚未初始化自习室课程配置', 503);
        // Touching windows (2-6 then 6-9) are allowed; true overlaps merge into one wider window.
        const overlaps = await tx.session.findMany({
            where: { open: true, cancelledAt: null, icilOnly: false, layout: { venueId: layout.venueId }, startsAt: { lt: endsAt }, endsAt: { gt: startsAt } },
            orderBy: { startsAt: 'asc' },
        });
        check(overlaps.every(s => s.endsAt.getTime() - s.startsAt.getTime() <= 86400000), '该场地已有开放时段过长', 409);
        let mergedStart = startsAt, mergedEnd = endsAt;
        for (let changed = true; changed;) {
            changed = false;
            for (const s of overlaps)
                if (s.startsAt < mergedEnd && s.endsAt > mergedStart) {
                    mergedStart = new Date(Math.min(mergedStart.getTime(), s.startsAt.getTime()));
                    mergedEnd = new Date(Math.max(mergedEnd.getTime(), s.endsAt.getTime()));
                    changed = true;
                }
        }
        const stillOverlapping = await tx.session.count({ where: { open: true, cancelledAt: null, icilOnly: false, layout: { venueId: layout.venueId }, startsAt: { lt: mergedEnd }, endsAt: { gt: mergedStart } } });
        check(stillOverlapping === overlaps.length, '该场地在此时间段刚有新的场次，请重试', 409);
        if (overlaps.length) {
            const keep = overlaps[0];
            // Move live records to the surviving window before deleting duplicates.
            await tx.reservation.updateMany({ where: { sessionId: { in: overlaps.map(s => s.id) }, cancelledAt: null }, data: { sessionId: keep.id } });
            await tx.assistantCoverage.updateMany({ where: { sessionId: { in: overlaps.map(s => s.id) } }, data: { sessionId: keep.id } });
            for (const s of overlaps)
                if (s.id !== keep.id)
                    await tx.sessionAdminBooking.updateMany({ where: { sessionId: s.id }, data: { sessionId: keep.id } });
            await tx.notification.createMany({ data: [{
                recipientId: actorId,
                type: 'SESSION_MERGED',
                message: `${formatShanghai(keep.startsAt)}至${formatShanghai(keep.endsAt)}的学习时段已合并开放，你的预约保留在合并后的时段内。`,
            }] });
            await tx.session.update({ where: { id: keep.id }, data: { startsAt: mergedStart, endsAt: mergedEnd, layoutId, requiredAssistants: Math.max(keep.requiredAssistants, 1) } });
            for (const s of overlaps)
                if (s.id !== keep.id)
                    await tx.session.delete({ where: { id: s.id } });
            await audit(tx, actorId, 'SESSION_MERGED', keep.id, { layoutId, startsAt: mergedStart, endsAt: mergedEnd, merged: overlaps.map(s => s.id) });
            return { session: await tx.session.findUniqueOrThrow({ where: { id: keep.id }, include: { coverage: true, adminBookings: true } }), coverage: await tx.assistantCoverage.findFirstOrThrow({ where: { sessionId: keep.id, assistantId: actorId } }) };
        }
        const session = await tx.session.create({ data: { courseId: course.id, layoutId, startsAt, endsAt, requiredAssistants: 1, open: true } });
        const coverage = await tx.assistantCoverage.create({ data: { sessionId: session.id, assistantId: actorId } });
        await audit(tx, actorId, 'ASSISTANT_SESSION_CREATE', session.id, { layoutId, startsAt, endsAt });
        return { session, coverage };
    });
}
export async function removeCoverage(actorId: string, id: string) {
    const record = await db.assistantCoverage.findUnique({ where: { id } });
    check(record, '保障预约不存在', 404);
    return serial(async (tx) => {
        const { user, session } = await bookingContext(tx, actorId, record.sessionId);
        check(user.role === 'ADMIN' || record.assistantId === actorId, '无权取消此保障预约', 403);
        check(session.startsAt > new Date(), '场次开始后无法取消');
        check(!await tx.reservation.count({ where: { sessionId: session.id, cancelledAt: null } }), '已有学员预约，不能取消助教保障', 409);
        await tx.assistantCoverage.delete({ where: { id } });
        await audit(tx, actorId, 'COVERAGE_CANCEL', id, { sessionId: session.id });
        return { ok: true };
    });
}
