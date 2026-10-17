import { db, serial, type Tx } from './db';
import { check } from './errors';
import { groupAllows } from './rules';
export async function audit(tx: Tx, actorId: string, action: string, target: string, details: object = {}) {
    await tx.auditLog.create({ data: { actorId, action, target, details: JSON.parse(JSON.stringify(details)) } });
}
async function bookingContext(tx: Tx, actorId: string, sessionId: string) {
    // All seat, coverage, and session mutations take the same row lock.
    await tx.$queryRaw `SELECT id FROM "Session" WHERE id = ${sessionId} FOR UPDATE`;
    const [user, session] = await Promise.all([
        tx.user.findUnique({ where: { id: actorId }, include: { group: { include: { weeklyRules: true, dateRules: true } } } }),
        tx.session.findUnique({ where: { id: sessionId }, include: { coverage: true } }),
    ]);
    check(user?.enabled, '账号不可用', 403);
    check(session, '场次不存在', 404);
    return { user, session };
}
export async function reserveSeat(actorId: string, sessionId: string, seatId: string) {
    return serial(async (tx) => {
        const { user, session } = await bookingContext(tx, actorId, sessionId);
        check(session.open && session.startsAt > new Date(), '场次已关闭或已经开始');
        check(session.coverage.length >= session.requiredAssistants, '助教保障人数不足，暂未开放选座');
        check(groupAllows(user.group, session.startsAt, session.endsAt), '所属分组不允许预约此时段', 403);
        const seat = await tx.seat.findUnique({ where: { id: seatId } });
        check(seat?.enabled && seat.layoutId === session.layoutId, '座位不可用');
        check(!await tx.reservation.findFirst({ where: { sessionId, userId: actorId, cancelledAt: null } }), '每人每场只能预约一个座位', 409);
        check(!await tx.reservation.findFirst({ where: { sessionId, seatId, cancelledAt: null } }), '该座位刚刚被预约，请选择其他座位', 409);
        const result = await tx.reservation.create({ data: { sessionId, seatId, userId: actorId } });
        await audit(tx, actorId, 'RESERVATION_CREATE', result.id, { sessionId, seat: seat.code });
        return result;
    });
}
export async function cancelReservation(actorId: string, id: string) {
    const record = await db.reservation.findUnique({ where: { id } });
    check(record, '预约不存在', 404);
    return serial(async (tx) => {
        const { user, session } = await bookingContext(tx, actorId, record.sessionId);
        const fresh = await tx.reservation.findUniqueOrThrow({ where: { id } });
        check(user.role === 'ADMIN' || fresh.userId === actorId, '无权取消此预约', 403);
        check(session.startsAt > new Date(), '场次开始后无法取消');
        check(!fresh.cancelledAt, '此预约已经取消', 409);
        const result = await tx.reservation.update({ where: { id }, data: { cancelledAt: new Date() } });
        await audit(tx, actorId, 'RESERVATION_CANCEL', id, { sessionId: session.id });
        return result;
    });
}
export async function addCoverage(actorId: string, sessionId: string) {
    return serial(async (tx) => {
        const { user, session } = await bookingContext(tx, actorId, sessionId);
        check(user.role === 'ASSISTANT', '仅助教可以登记现场保障', 403);
        check(session.open && session.startsAt > new Date(), '场次已关闭或已经开始');
        check(!await tx.assistantCoverage.findUnique({ where: { sessionId_assistantId: { sessionId, assistantId: actorId } } }), '已经登记过此场次', 409);
        const result = await tx.assistantCoverage.create({ data: { sessionId, assistantId: actorId } });
        await audit(tx, actorId, 'COVERAGE_CREATE', result.id, { sessionId });
        return result;
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
