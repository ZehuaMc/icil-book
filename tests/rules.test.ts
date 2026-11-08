import test from 'node:test';
import assert from 'node:assert/strict';
import { localParts, formatTime, shanghaiMidnight, maxMemberBookingTime, maxMemberBookingInput, intervalCovered } from '../src/lib/rules.ts';

test('上海日期、分钟与星期，不依赖服务器时区', () => {
    assert.deepEqual(localParts('2026-10-18T17:30:00Z'), { date: '2026-10-19', minute: 90, weekday: 1 });
    assert.equal(localParts('2026-10-17T17:30:00Z').weekday, 0);
    assert.equal(formatTime('2026-10-19T01:00:00Z'), '09:00');
});
test('成员预约范围按北京时间跨日，包含今天与明天', () => {
    const beforeMidnight = new Date('2026-10-19T23:59:00+08:00');
    assert.equal(shanghaiMidnight(beforeMidnight).toISOString(), '2026-10-18T16:00:00.000Z');
    assert.equal(maxMemberBookingTime(beforeMidnight).toISOString(), '2026-10-20T16:00:00.000Z');
    assert.equal(maxMemberBookingTime(new Date('2026-10-20T00:00:00+08:00')).toISOString(), '2026-10-21T16:00:00.000Z');
    assert.equal(maxMemberBookingInput(beforeMidnight), '2026-10-20T23:59');
    assert.equal(maxMemberBookingInput(new Date('2026-12-31T20:00:00Z')), '2027-01-02T23:59');
});

test('助教预约须覆盖完整时间，允许相邻接续而拒绝部分相交或空隙', () => {
    const t = (hour: number) => new Date(Date.UTC(2030, 0, 1, hour));
    assert.equal(intervalCovered([], t(9), t(10)), false);
    assert.equal(intervalCovered([{ startsAt: t(9), endsAt: t(10) }], t(9), t(10)), true);
    assert.equal(intervalCovered([{ startsAt: t(9), endsAt: t(10) }], t(9), t(11)), false);
    assert.equal(intervalCovered([{ startsAt: t(10), endsAt: t(11) }, { startsAt: t(9), endsAt: t(10) }], t(9), t(11)), true);
    assert.equal(intervalCovered([{ startsAt: t(9), endsAt: t(10) }, { startsAt: t(11), endsAt: t(12) }], t(9), t(12)), false);
    assert.equal(intervalCovered([{ startsAt: t(8), endsAt: t(12) }], t(9), t(10)), true);
    assert.equal(intervalCovered([{ startsAt: t(9), endsAt: t(12) }], t(10), t(9)), false);
});

test('助教覆盖忽略过期、无效和嵌套区间，不能跳过一分钟空隙', () => {
    const windows = [
        { startsAt: '2030-01-01T08:00:00Z', endsAt: '2030-01-01T09:00:00Z' },
        { startsAt: '2030-01-01T09:00:00Z', endsAt: '2030-01-01T10:00:00Z' },
        { startsAt: '2030-01-01T09:10:00Z', endsAt: '2030-01-01T09:30:00Z' },
        { startsAt: '2030-01-01T10:00:00Z', endsAt: '2030-01-01T11:00:00Z' },
        { startsAt: 'invalid', endsAt: '2030-01-01T12:00:00Z' },
        { startsAt: '2030-01-01T10:00:00Z', endsAt: '2030-01-01T09:00:00Z' },
    ];
    assert.equal(intervalCovered(windows, '2030-01-01T09:00:00Z', '2030-01-01T11:00:00Z'), true);
    assert.equal(intervalCovered(windows, '2030-01-01T09:00:00Z', '2030-01-01T11:01:00Z'), false);
    assert.equal(intervalCovered(windows, 'invalid', '2030-01-01T11:00:00Z'), false);
    assert.equal(intervalCovered(windows, '2030-01-01T09:00:00Z', 'invalid'), false);
    assert.equal(intervalCovered(windows, '2030-01-01T09:00:00Z', '2030-01-01T09:00:00Z'), false);
});
