export const TIME_ZONE = 'Asia/Shanghai';
export function shanghaiMidnight(date = new Date()) {
    const day = localParts(date).date;
    return new Date(`${day}T00:00:00+08:00`);
}
export function maxMemberBookingTime(date = new Date()) {
    return new Date(shanghaiMidnight(date).getTime() + 2 * 86400000);
}
export function maxMemberBookingInput(date = new Date()) {
    const value = maxMemberBookingTime(date);
    const lastAllowed = new Date(value.getTime() - 60000);
    return `${localParts(lastAllowed).date}T23:59`;
}
export function localParts(value: Date | string) {
    const date = new Date(value);
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
    const get = (key: string) => parts.find(p => p.type === key)!.value;
    const day = `${get('year')}-${get('month')}-${get('day')}`;
    return { date: day, minute: Number(get('hour')) * 60 + Number(get('minute')), weekday: new Date(`${day}T12:00:00+08:00`).getUTCDay() };
}
export function formatTime(value: Date | string) { return new Intl.DateTimeFormat('zh-CN', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value)); }
export function formatDate(value: Date | string) { return new Intl.DateTimeFormat('zh-CN', { timeZone: TIME_ZONE, month: 'long', day: 'numeric', weekday: 'long' }).format(new Date(value)); }

/** Adjacent windows may jointly cover an interval; any gap makes it unavailable. */
export function intervalCovered(windows: { startsAt: Date | string; endsAt: Date | string }[], startsAt: Date | string, endsAt: Date | string) {
    let cursor = new Date(startsAt).getTime();
    const end = new Date(endsAt).getTime();
    if (!Number.isFinite(cursor) || !Number.isFinite(end) || end <= cursor) return false;
    const ordered = windows.map(window => ({ start: new Date(window.startsAt).getTime(), end: new Date(window.endsAt).getTime() }))
        .filter(window => Number.isFinite(window.start) && Number.isFinite(window.end) && window.end > window.start)
        .sort((a, b) => a.start - b.start);
    for (const window of ordered) {
        if (window.start > cursor) break;
        cursor = Math.max(cursor, window.end);
        if (cursor >= end) return true;
    }
    return false;
}
