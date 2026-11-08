import { db, serial, type Tx } from './db';
import { check } from './errors';
import { maxMemberBookingTime, intervalCovered } from './rules';
import { isOperator } from './auth';
export async function audit(tx: Tx, actorId: string, action: string, target: string, details: object = {}) {
    await tx.auditLog.create({ data: { actorId, action, target, details: JSON.parse(JSON.stringify(details)) } });
}
async function bookingContext(tx: Tx, actorId: string, sessionId: string) {
    // Serializable transactions protect bookings across daily containers and layout versions.
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${actorId} FOR UPDATE`;
    await tx.$queryRaw `SELECT id FROM "Session" WHERE id = ${sessionId} FOR UPDATE`;
    const [user, session] = await Promise.all([
        tx.user.findUnique({ where: { id: actorId } }),
        tx.session.findUnique({ where: { id: sessionId } }),
    ]);
    check(user?.enabled && !user.deletedAt, '账号不可用', 403);
    check(session, '场次不存在', 404);
    return { user, session };
}
async function activeBookingBlock(tx: Tx, startsAt: Date, endsAt: Date) {
    return tx.bookingBlock.findFirst({
        where: { active: true, startsAt: { lt: endsAt }, endsAt: { gt: startsAt } },
        orderBy: { startsAt: 'asc' },
    });
}
async function reserveSeatInTransaction(tx: Tx, actorId: string, sessionId: string, seatId: string, startsAt: Date, endsAt: Date) {
    const { user, session } = await bookingContext(tx, actorId, sessionId);
    const operator = isOperator(user);
    check(!session.cancelledAt, '此时段已取消，不能预约');
    check(Number.isFinite(startsAt.getTime()) && Number.isFinite(endsAt.getTime()) && endsAt > startsAt, '请选择有效的预约时间');
    if (!operator)
        check(endsAt.getTime() - startsAt.getTime() > 0 && (endsAt.getTime() - startsAt.getTime()) % (30 * 60000) === 0 && startsAt.getUTCMinutes() % 30 === 0 && endsAt.getUTCMinutes() % 30 === 0 && startsAt.getUTCSeconds() === 0 && endsAt.getUTCSeconds() === 0 && startsAt.getUTCMilliseconds() === 0 && endsAt.getUTCMilliseconds() === 0, '预约时间必须按 30 分钟为一段，从半点或整点开始');
    check(startsAt >= session.startsAt && endsAt <= session.endsAt, '预约时间必须在所选日期内');
    check(startsAt > new Date(), '预约开始时间必须在当前时间之后');
    const block = await activeBookingBlock(tx, startsAt, endsAt);
    check(!block, block?.kind === 'DAY' ? '该日期已禁用预约' : '该时段已禁用预约', 403);
    if (!operator) {
        check(endsAt <= maxMemberBookingTime(), '成员最多只能提前一天预约', 403);
        if (user.memberType === 'YSYX') {
            const layout = await tx.layoutVersion.findUniqueOrThrow({ where: { id: session.layoutId }, select: { venueId: true } });
            check(await assistantCovers(tx, layout.venueId, startsAt, endsAt), '所选完整时间须已有助教预约工位，暂不能预约', 403);
        }
    }
    const seat = await tx.seat.findUnique({ where: { id: seatId } });
    check(seat?.enabled && seat.layoutId === session.layoutId && (operator || !seat.fixedForAssistant), seat?.fixedForAssistant ? '该座位为管理员固定工位，学员不可预约' : '管理员或学员才可以预约此座位', 403);
    check(!await tx.reservation.findFirst({ where: { userId: actorId, cancelledAt: null, startsAt: { lt: endsAt }, endsAt: { gt: startsAt } } }), '你在该时间段已有预约', 409);
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
    check(!overlappingVenueReservations.length, '该座位在重叠开放时段已有其他用户预约，请选择其他座位或时间', 409);
    const result = await tx.reservation.create({ data: { sessionId, seatId, userId: actorId, startsAt, endsAt } });
    await audit(tx, actorId, 'RESERVATION_CREATE', result.id, { sessionId, seat: seat.code, startsAt, endsAt });
    return result;
}
export async function reserveSeat(actorId: string, sessionId: string, seatId: string, requestedStartsAt?: string, requestedEndsAt?: string) {
    return serial(async (tx) => {
        const { session } = await bookingContext(tx, actorId, sessionId);
        const startsAt = requestedStartsAt ? new Date(requestedStartsAt) : session.startsAt;
        const endsAt = requestedEndsAt ? new Date(requestedEndsAt) : session.endsAt;
        return reserveSeatInTransaction(tx, actorId, sessionId, seatId, startsAt, endsAt);
    });
}
export async function reserveSeatSlots(actorId: string, sessionId: string, seatId: string, slots: { startsAt: string; endsAt: string }[]) {
    return serial(async (tx) => {
        check(slots.length > 0 && slots.length <= 48, '请选择 1 至 48 个时间段');
        const ordered = [...slots].map(slot => ({ startsAt: new Date(slot.startsAt), endsAt: new Date(slot.endsAt) })).sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
        for (let i = 1; i < ordered.length; i++)
            check(ordered[i].startsAt >= ordered[i - 1].endsAt, '预约时段不能重叠');
        const reservations = [];
        for (const slot of ordered)
            reservations.push(await reserveSeatInTransaction(tx, actorId, sessionId, seatId, slot.startsAt, slot.endsAt));
        return { reservations };
    });
}
export async function cancelReservation(actorId: string, id: string) {
    const record = await db.reservation.findUnique({ where: { id } });
    check(record, '预约不存在', 404);
    return serial(async (tx) => {
        const { user, session } = await bookingContext(tx, actorId, record.sessionId);
        const fresh = await tx.reservation.findUniqueOrThrow({ where: { id }, include: { user: true, seat: true } });
        check(user.role === 'ADMIN' || fresh.userId === actorId, '无权取消此预约', 403);
        check(fresh.startsAt > new Date(), '预约开始后无法取消');
        check(!fresh.cancelledAt, '此预约已经取消', 409);
        const cancelledAt = new Date();
        const result = await tx.reservation.update({ where: { id }, data: { cancelledAt } });
        await audit(tx, actorId, 'RESERVATION_CANCEL', id, { sessionId: session.id });
        if (fresh.user.role === 'ASSISTANT') {
            const layout = await tx.layoutVersion.findUniqueOrThrow({ where: { id: session.layoutId } });
            await cancelUncoveredYsyxReservations(tx, actorId, layout.venueId);
        }
        return result;
    });
}

/** Only active seat reservations by enabled assistants provide member access. */
export async function assistantCovers(tx: Tx, venueId: string, startsAt: Date, endsAt: Date) {
    const windows = await tx.reservation.findMany({
        where: {
            cancelledAt: null, startsAt: { lt: endsAt }, endsAt: { gt: startsAt },
            user: { role: 'ASSISTANT', enabled: true, deletedAt: null },
            session: { cancelledAt: null, layout: { venueId } },
        },
        select: { startsAt: true, endsAt: true },
    });
    return intervalCovered(windows, startsAt, endsAt);
}

export async function cancelUncoveredYsyxReservations(tx: Tx, actorId: string, venueId?: string) {
    const candidates = await tx.reservation.findMany({
        where: {
            cancelledAt: null, endsAt: { gt: new Date() }, user: { role: 'USER', memberType: 'YSYX' },
            session: { cancelledAt: null, ...(venueId ? { layout: { venueId } } : {}) },
        },
        include: { seat: { select: { code: true } }, session: { include: { layout: { select: { venueId: true } } } } },
    });
    for (const record of candidates) {
        if (await assistantCovers(tx, record.session.layout.venueId, record.startsAt, record.endsAt)) continue;
        await tx.reservation.update({ where: { id: record.id }, data: { cancelledAt: new Date() } });
        await tx.notification.create({ data: {
            recipientId: record.userId, type: 'BOOKING_CANCELLED',
            message: `${record.startsAt.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}至${record.endsAt.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit' })}的预约因助教预约取消或账号变更，已失去完整时间保障。你的${record.seat.code}号工位预约已自动取消。`,
        } });
        await audit(tx, actorId, 'RESERVATION_CANCEL', record.id, { reason: 'NO_ASSISTANT_RESERVATION' });
    }
}
