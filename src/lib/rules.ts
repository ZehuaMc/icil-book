export const TIME_ZONE = 'Asia/Shanghai';
export function localParts(value: Date | string) {
    const date = new Date(value);
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
    const get = (key: string) => parts.find(p => p.type === key)!.value;
    const day = `${get('year')}-${get('month')}-${get('day')}`;
    return { date: day, minute: Number(get('hour')) * 60 + Number(get('minute')), weekday: new Date(`${day}T12:00:00+08:00`).getUTCDay() };
}
export type RuleGroup = {
    canReserve: boolean;
    weeklyRules: {
        weekday: number;
        startMinute: number;
        endMinute: number;
    }[];
    dateRules: {
        date: string;
        allowed: boolean;
        startMinute: number;
        endMinute: number;
    }[];
};
function dayAllows(group: RuleGroup, date: string, weekday: number, startMinute: number, endMinute: number) {
    const overrides = group.dateRules.filter(r => r.date === date);
    if (overrides.length) {
        if (overrides.some(r => !r.allowed && r.startMinute < endMinute && r.endMinute > startMinute))
            return false;
        return overrides.some(r => r.allowed && r.startMinute <= startMinute && r.endMinute >= endMinute);
    }
    return group.weeklyRules.some(r => r.weekday === weekday && r.startMinute <= startMinute && r.endMinute >= endMinute);
}
// Check every Shanghai calendar day touched by the session, including sub-minute boundaries.
export function groupAllows(group: RuleGroup, startsAt: Date | string, endsAt: Date | string): boolean {
    const start = new Date(startsAt), end = new Date(endsAt);
    if (!group.canReserve || !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start || end.getTime() - start.getTime() > 86400000) return false;
    let cursor = start;
    while (cursor < end) {
        const local = localParts(cursor);
        const midnight = new Date(`${local.date}T00:00:00+08:00`).getTime();
        const segmentEnd = Math.min(end.getTime(), midnight + 86400000);
        if (!dayAllows(group, local.date, local.weekday, (cursor.getTime() - midnight) / 60000, (segmentEnd - midnight) / 60000)) return false;
        cursor = new Date(segmentEnd);
    }
    return true;
}
export function formatTime(value: Date | string) { return new Intl.DateTimeFormat('zh-CN', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value)); }
export function formatDate(value: Date | string) { return new Intl.DateTimeFormat('zh-CN', { timeZone: TIME_ZONE, month: 'long', day: 'numeric', weekday: 'long' }).format(new Date(value)); }
