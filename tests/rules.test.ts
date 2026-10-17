import test from 'node:test';
import assert from 'node:assert/strict';
import { groupAllows, localParts, formatTime, type RuleGroup } from '../src/lib/rules.ts';
const group: RuleGroup = { canReserve: true, weeklyRules: [{ weekday: 1, startMinute: 540, endMinute: 720 }], dateRules: [] };
const start = '2026-10-19T01:00:00Z', end = '2026-10-19T04:00:00Z';
test('上海日期、分钟与星期，不依赖服务器时区', () => {
    assert.deepEqual(localParts('2026-10-18T17:30:00Z'), { date: '2026-10-19', minute: 90, weekday: 1 });
    assert.equal(localParts('2026-10-17T17:30:00Z').weekday, 0);
    assert.equal(formatTime(start), '09:00');
});
test('每周规则必须覆盖课程完整时段，边界可重合', () => {
    assert.equal(groupAllows(group, start, end), true);
    assert.equal(groupAllows(group, '2026-10-19T00:59:00Z', end), false);
    assert.equal(groupAllows(group, start, '2026-10-19T04:01:00Z'), false);
});
test('无规则、规则不匹配或分组关闭时禁止预约', () => {
    assert.equal(groupAllows({ ...group, canReserve: false }, start, end), false);
    assert.equal(groupAllows({ ...group, weeklyRules: [] }, start, end), false);
    assert.equal(groupAllows(group, '2026-10-20T01:00:00Z', '2026-10-20T04:00:00Z'), false);
});
test('日期关闭规则覆盖每周允许规则', () => {
    assert.equal(groupAllows({ ...group, dateRules: [{ date: '2026-10-19', allowed: false, startMinute: 0, endMinute: 1440 }] }, start, end), false);
});
test('日期开放规则覆盖每周禁止，并严格限制窗口', () => {
    const special = { ...group, weeklyRules: [], dateRules: [{ date: '2026-10-19', allowed: true, startMinute: 540, endMinute: 660 }] };
    assert.equal(groupAllows(special, start, '2026-10-19T03:00:00Z'), true);
    assert.equal(groupAllows(special, start, end), false);
});
test('存在日期规则时，不回退到每周规则', () => {
    const special = { ...group, dateRules: [{ date: '2026-10-19', allowed: true, startMinute: 840, endMinute: 1020 }] };
    assert.equal(groupAllows(special, start, end), false);
});
test('日期禁止窗口与课程相交时优先拒绝', () => {
    const special = { ...group, dateRules: [{ date: '2026-10-19', allowed: true, startMinute: 0, endMinute: 1440 }, { date: '2026-10-19', allowed: false, startMinute: 660, endMinute: 720 }] };
    assert.equal(groupAllows(special, start, end), false);
    assert.equal(groupAllows(special, start, '2026-10-19T03:00:00Z'), true);
});
test('允许课程在次日零点结束，跨日课程不误用单日规则', () => {
    const allDay = { ...group, weeklyRules: [{ weekday: 1, startMinute: 0, endMinute: 1440 }] };
    assert.equal(groupAllows(allDay, '2026-10-19T14:00:00Z', '2026-10-19T16:00:00Z'), true);
    assert.equal(groupAllows(allDay, '2026-10-19T14:00:00Z', '2026-10-19T17:00:00Z'), false);
});
test('秒与毫秒不能越过权限窗口边界', () => {
    assert.equal(groupAllows(group, start, '2026-10-19T04:00:00.001Z'), false);
    assert.equal(groupAllows(group, '2026-10-19T00:59:59.999Z', end), false);
    const allDay = { ...group, weeklyRules: [{ weekday: 1, startMinute: 0, endMinute: 1440 }] };
    assert.equal(groupAllows(allDay, '2026-10-19T14:00:00Z', '2026-10-19T16:00:00.001Z'), false);
});
test('跨日课程必须分别满足两天规则，日期覆盖规则不能被绕过', () => {
    const overnight = { ...group, weeklyRules: [{ weekday: 1, startMinute: 1320, endMinute: 1440 }, { weekday: 2, startMinute: 0, endMinute: 60 }] };
    assert.equal(groupAllows(overnight, '2026-10-19T14:00:00Z', '2026-10-19T17:00:00Z'), true);
    assert.equal(groupAllows({ ...overnight, dateRules: [{ date: '2026-10-20', allowed: false, startMinute: 0, endMinute: 1440 }] }, '2026-10-19T14:00:00Z', '2026-10-19T17:00:00Z'), false);
});
test('非法、反向、零长度及超过 24 小时的时段拒绝预约', () => {
    assert.equal(groupAllows(group, 'invalid', end), false);
    assert.equal(groupAllows(group, end, start), false);
    assert.equal(groupAllows(group, start, start), false);
    assert.equal(groupAllows(group, start, '2026-10-20T04:00:00Z'), false);
});
