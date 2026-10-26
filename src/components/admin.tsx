'use client';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Users, CalendarDays, Armchair, PanelTop, Plus, Download, ArrowUpRight, ShieldCheck, Check, Pencil, UserX, KeyRound } from 'lucide-react';
import { api, subscribeToLayoutUpdates, type User, type Group, type Layout, type Session, type Reservation, type Coverage } from '@/lib/types';
import { formatDate, formatTime, localParts } from '@/lib/rules';
import LayoutEditor from './layout-editor';
import Modal from './modal';
import SeatMap from './seat-map';
const titles: Record<string, [
    string,
    string
]> = { '/admin': ['空间管理概览', '从一张工位，到一段专注时光。这里是空间运行的全貌。'], '/admin/users': ['用户管理', '连接每一位学习者，管理角色、分组与账号状态。'], '/admin/groups': ['分组与预约权限', '用清晰的时间规则，让空间有序共享。指定日期规则优先于每周规则。'], '/admin/layouts': ['场地与布局', '自由组合桌面与工位，打造适合学习的空间。'], '/admin/sessions': ['预约时段', '自由设置日期和分钟级时间，先选择管理员工位再开放给学员。'], '/admin/reservations': ['预约记录', '查看管理员和学员的座位预约，取消未开始的学员预约。'], '/admin/logs': ['操作日志', '记录每一次重要变更，让空间管理有迹可循。'] };
type Props = {
    notify: (s: string) => void;
};
export default function Admin({ path, user, notify }: Props & {
    path: string;
    user: User;
}) {
    const info = titles[path];
    if (!info)
        return <p>页面不存在</p>;
    return <><div className="page-heading"><div><div className="eyebrow">SPACE MANAGEMENT</div><h1>{info[0]}</h1><p>{info[1]}</p></div><span className="badge green"><ShieldCheck size={13}/>管理员工作台 · {user.name}</span></div>{path === '/admin' ? <Overview /> : path === '/admin/users' ? <UserAdmin notify={notify}/> : path === '/admin/groups' ? <GroupAdmin notify={notify}/> : path === '/admin/layouts' ? <LayoutEditor notify={notify}/> : path === '/admin/sessions' ? <SessionAdmin user={user} notify={notify}/> : path === '/admin/reservations' ? <ReservationAdmin notify={notify}/> : <Logs />}</>;
}
function useResource<T>(url: string, initial: T) {
    const [data, setData] = useState<T>(initial), [error, setError] = useState(''), [loading, setLoading] = useState(true);
    const reload = useCallback(async () => { const value = await api<T>(url); setData(value); setError(''); }, [url]);
    useEffect(() => { setLoading(true); reload().catch(e => setError(e.message)).finally(() => setLoading(false)); }, [reload]);
    return { data, reload, error, loading };
}
function ErrorMessage({ message }: {
    message: string;
}) { return message ? <p role="alert" className="form-error">{message}</p> : null; }
function Overview() {
    const { data, error } = useResource('admin/stats', { users: 0, sessions: 0, reservations: 0, layouts: 0 });
    return <><ErrorMessage message={error}/><div className="stats-grid">{[{ label: '空间成员', value: data.users, icon: Users, unit: '位' }, { label: '未来预约时段', value: data.sessions, icon: CalendarDays, unit: '个' }, { label: '有效座位预约', value: data.reservations, icon: Armchair, unit: '次' }, { label: '已发布布局', value: data.layouts, icon: PanelTop, unit: '版' }].map(s => <div className="stat-card" key={s.label}><div><span>{s.label}</span><s.icon size={19}/></div><strong>{s.value}<small>{s.unit}</small></strong><p>自习室预约</p></div>)}</div><div className="admin-panel"><h2>让空间准备就绪</h2><p className="muted">发布布局、设置时间，选择管理员工位后开放给学员。</p><div className="workflow-grid">{[['01', '发布场地布局', '/admin/layouts', '组合桌面与可预约座位'], ['02', '设置分组权限', '/admin/groups', '配置学员可预约的时段'], ['03', '发布预约时段', '/admin/sessions', '选择时间和管理员工位后开放'], ['04', '查看预约情况', '/admin/reservations', '取消未开始的学员预约']].map(([num, title, href, text]) => <Link href={href} className="workflow-card" key={num}><span>{num}</span><h3>{title}<ArrowUpRight size={17}/></h3><p>{text}</p></Link>)}</div></div></>;
}
function UserAdmin({ notify }: Props) {
    const { data, reload, error } = useResource<{
        users: User[];
    }>('admin/users', { users: [] });
    const groups = useResource<{
        groups: Group[];
    }>('groups', { groups: [] });
    const [search, setSearch] = useState(''), [edit, setEdit] = useState<User | null>(null), [busy, setBusy] = useState(false);
    const resetPassword = async (u: User) => {
        if (!confirm(`将学员“${u.name}”（学号 ${u.studentId}）的密码重置为 123456？原密码不会显示，重置后其他登录会话将退出。`)) return;
        setBusy(true);
        try {
            await api(`admin/users/${u.id}/reset-password`, 'POST');
            notify(`已将 ${u.name} 的密码重置为 123456`);
        } catch (e) { notify((e as Error).message); }
        finally { setBusy(false); }
    };
    const unregister = async (u: User) => {
        if (!confirm(`确定注销${u.role === 'USER' ? '学员' : '管理员'}账号“${u.name}”（学号 ${u.studentId}）？注销后无法登录，历史预约仍会保留。`)) return;
        setBusy(true);
        try {
            await api(`admin/users/${u.id}`, 'DELETE');
            await reload();
            notify('账号已注销');
        } catch (e) {
            notify((e as Error).message);
        } finally {
            setBusy(false);
        }
    };
    return <><div className="toolbar"><span>{data.users.length} 位成员</span><input placeholder="搜索姓名或学号" aria-label="搜索用户" value={search} onChange={e => setSearch(e.target.value)}/></div><ErrorMessage message={error || groups.error}/><div className="table-wrap"><table><thead><tr><th>成员</th><th>用户角色</th><th>成员类型</th><th>所属分组</th><th>账号状态</th><th>操作</th></tr></thead><tbody>{data.users.filter(u => `${u.name} ${u.studentId} ${u.email}`.includes(search)).map(u => <tr key={u.id}><td><div className="user-cell"><span className="avatar">{u.name.slice(0, 1)}</span><div>{u.name}<small>学号 {u.studentId}</small></div></div></td><td>{u.role === 'USER' ? '学员' : '管理员'}</td><td>{u.role === 'USER' ? u.memberType === 'ICIL' ? 'ICIL成员' : 'YSYX成员' : '管理员'}</td><td>{u.group.name}</td><td><span className={`badge ${u.deletedAt ? '' : u.enabled ? 'green' : ''}`}>{u.deletedAt ? '已注销' : u.enabled ? '已启用' : '已停用'}</span></td><td>{!u.deletedAt && <>{u.role === 'USER' && <button className="text-button" disabled={busy || !u.enabled} title="重置学员密码为 123456" onClick={() => resetPassword(u)}><KeyRound size={14}/>重置密码</button>}<button className="text-button" disabled={busy} onClick={() => setEdit({ ...u })}><Pencil size={14}/>编辑</button><button className="text-button danger" disabled={busy} onClick={() => unregister(u)}><UserX size={14}/>注销</button></>}</td></tr>)}</tbody></table></div>{edit && <Dialog title="编辑用户" close={() => setEdit(null)}><form className="form-grid" onSubmit={async (e) => { e.preventDefault(); setBusy(true); try {
        await api(`admin/users/${edit.id}`, 'PATCH', { name: edit.name, role: edit.role, memberType: edit.memberType, groupId: edit.groupId, enabled: edit.enabled });
        await reload();
        setEdit(null);
        notify('用户已更新');
    }
    catch (e) {
        notify((e as Error).message);
    }
    finally {
        setBusy(false);
    } }}><label>姓名<input required value={edit.name} onChange={e => setEdit({ ...edit, name: e.target.value })}/></label><label>角色<select value={edit.role === 'USER' ? 'USER' : 'ADMIN'} onChange={e => setEdit({ ...edit, role: e.target.value as User['role'] })}><option value="USER">学员</option><option value="ADMIN">管理员</option></select></label>{edit.role === 'USER' && <label>成员类型<select value={edit.memberType} onChange={e => setEdit({ ...edit, memberType: e.target.value as User['memberType'] })}><option value="YSYX">YSYX成员</option><option value="ICIL">ICIL成员</option></select></label>}<label>分组<select value={edit.groupId} onChange={e => setEdit({ ...edit, groupId: e.target.value })}>{groups.data.groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select></label><label className="check-label"><input type="checkbox" checked={edit.enabled} onChange={e => setEdit({ ...edit, enabled: e.target.checked })}/>启用账号</label><button className="primary" disabled={busy}>保存用户</button></form></Dialog>}</>;
}
const blankGroup: Group = { id: '', name: '', canReserve: true, weeklyRules: [], dateRules: [] };
const minuteText = (n: number) => `${Math.floor(n / 60).toString().padStart(2, '0')}:${(n % 60).toString().padStart(2, '0')}`;
const parseMinute = (s: string) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
function TimeWindow({ start, end, change }: {
    start: number;
    end: number;
    change: (start: number, end: number) => void;
}) {
    return <><input aria-label="规则开始时间" type="time" value={minuteText(start)} onChange={e => change(parseMinute(e.target.value), end)} required/><span>至</span><select aria-label="规则结束时间" value={end} onChange={e => change(start, Number(e.target.value))}>{Array.from(new Set([...Array.from({ length: 48 }, (_, i) => (i + 1) * 30), end])).sort((a, b) => a - b).map(n => <option key={n} value={n}>{minuteText(n)}</option>)}</select></>;
}
function GroupAdmin({ notify }: Props) {
    const { data, reload, error } = useResource<{
        groups: Group[];
        settings?: {
            defaultGroupId: string;
        };
    }>('groups', { groups: [] });
    const [edit, setEdit] = useState<Group | null>(null), [isDefault, setIsDefault] = useState(false), [busy, setBusy] = useState(false);
    return <><div className="toolbar"><span>未匹配任何时间规则时，禁止预约。时间窗需覆盖完整预约时段。</span><button className="primary" onClick={() => { setEdit(structuredClone(blankGroup)); setIsDefault(false); }}><Plus size={16}/>创建分组</button></div><ErrorMessage message={error}/><div className="records-grid">{data.groups.map(g => <div className="record-card" key={g.id}><div className="record-top"><span className={`badge ${g.canReserve ? 'green' : ''}`}>{g.canReserve ? '允许预约' : '禁止预约'}</span>{data.settings?.defaultGroupId === g.id && <span className="badge">注册默认分组</span>}</div><h2>{g.name}</h2><p>{g._count?.users ?? 0} 位成员 · {g.weeklyRules.length} 条每周规则 · {g.dateRules.length} 条日期规则</p><button onClick={() => { setEdit(structuredClone(g)); setIsDefault(data.settings?.defaultGroupId === g.id); }}>编辑权限</button></div>)}</div>{edit && <Dialog title={edit.id ? '编辑分组权限' : '创建分组'} close={() => setEdit(null)} wide><form className="form-grid" onSubmit={async (e) => { e.preventDefault(); setBusy(true); try {
        await api(edit.id ? `groups/${edit.id}` : 'groups', edit.id ? 'PUT' : 'POST', { ...edit, isDefault });
        await reload();
        setEdit(null);
        notify('分组权限已保存');
    }
    catch (e) {
        notify((e as Error).message);
    }
    finally {
        setBusy(false);
    } }}><label>分组名称<input required value={edit.name} onChange={e => setEdit({ ...edit, name: e.target.value })}/></label><div className="inline-fields"><label className="check-label"><input type="checkbox" checked={edit.canReserve} onChange={e => setEdit({ ...edit, canReserve: e.target.checked })}/>允许预约</label><label className="check-label"><input type="checkbox" disabled={data.settings?.defaultGroupId === edit.id} checked={isDefault} onChange={e => setIsDefault(e.target.checked)}/>新注册用户默认分组</label></div><h3>每周重复时间窗</h3>{edit.weeklyRules.map((r, i) => <div className="rule-row" key={i}><select aria-label="星期" value={r.weekday} onChange={e => setEdit({ ...edit, weeklyRules: edit.weeklyRules.map((v, j) => j === i ? { ...v, weekday: Number(e.target.value) } : v) })}>{['周日', '周一', '周二', '周三', '周四', '周五', '周六'].map((s, n) => <option value={n} key={n}>{s}</option>)}</select><TimeWindow start={r.startMinute} end={r.endMinute} change={(startMinute, endMinute) => setEdit({ ...edit, weeklyRules: edit.weeklyRules.map((v, j) => i === j ? { ...v, startMinute, endMinute } : v) })}/><button type="button" onClick={() => setEdit({ ...edit, weeklyRules: edit.weeklyRules.filter((_, j) => i !== j) })}>删除</button></div>)}<button type="button" onClick={() => setEdit({ ...edit, weeklyRules: [...edit.weeklyRules, { weekday: 1, startMinute: 480, endMinute: 1080 }] })}><Plus size={14}/>添加每周规则</button><h3>指定日期覆盖</h3><p className="muted small">该日期存在规则时，仅使用该日期的规则。全天禁止可用于节假日关闭。</p>{edit.dateRules.map((r, i) => <div className="rule-row" key={i}><input aria-label="指定日期" type="date" required value={r.date} onChange={e => setEdit({ ...edit, dateRules: edit.dateRules.map((v, j) => i === j ? { ...v, date: e.target.value } : v) })}/><select aria-label="日期允许状态" value={String(r.allowed)} onChange={e => setEdit({ ...edit, dateRules: edit.dateRules.map((v, j) => i === j ? { ...v, allowed: e.target.value === 'true' } : v) })}><option value="true">允许此时间窗</option><option value="false">禁止</option></select><TimeWindow start={r.startMinute} end={r.endMinute} change={(startMinute, endMinute) => setEdit({ ...edit, dateRules: edit.dateRules.map((v, j) => i === j ? { ...v, startMinute, endMinute } : v) })}/><button type="button" onClick={() => setEdit({ ...edit, dateRules: edit.dateRules.filter((_, j) => i !== j) })}>删除</button></div>)}<button type="button" onClick={() => setEdit({ ...edit, dateRules: [...edit.dateRules, { date: localParts(new Date()).date, allowed: false, startMinute: 0, endMinute: 1440 }] })}><Plus size={14}/>添加日期规则</button><button className="primary" disabled={busy}>保存分组权限</button></form></Dialog>}</>;
}
type SessionForm = {
    id: string;
    layoutId: string;
    startDate: string;
    startTime: string;
    endDate: string;
    endTime: string;
    open: boolean;
};
function sessionFormValues(startsAt: string, endsAt: string) {
    return { startDate: localParts(startsAt).date, startTime: formatTime(startsAt), endDate: localParts(endsAt).date, endTime: formatTime(endsAt) };
}
function currentShanghaiDateTime() { const now = new Date(); return { date: localParts(now).date, time: formatTime(now) }; }
const minuteOptions = Array.from({ length: 1440 }, (_, i) => `${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`);
function SessionAdmin({ notify, user }: Props & { user: User }) {
    const { data, reload, error } = useResource<{ sessions: Session[] }>('admin/sessions', { sessions: [] });
    const layouts = useResource<{ layouts: Layout[] }>('layouts', { layouts: [] });
    const [edit, setEdit] = useState<SessionForm | null>(null), [busy, setBusy] = useState(false), [seatSession, setSeatSession] = useState<Session | null>(null), [selectedSeat, setSelectedSeat] = useState<string>();
    useEffect(() => {
        const interval = setInterval(() => reload().catch(() => { }), 5000);
        const unsubscribe = subscribeToLayoutUpdates(() => reload().catch(() => { }));
        return () => { clearInterval(interval); unsubscribe(); };
    }, [reload]);
    const nowForInput = currentShanghaiDateTime();
    const publishedLayouts = layouts.data.layouts.filter(l => l.status === 'PUBLISHED').slice(0, 1);
    const refreshSeatSession = (id: string) => setSeatSession(data.sessions.find(s => s.id === id) ?? null);
    async function toggleAdminReady(session: Session) {
        setBusy(true);
        try {
            await api(`admin/sessions/${session.id}/ready`, session.adminReady ? 'DELETE' : 'POST');
            await reload();
            setSeatSession(null);
            notify(session.adminReady ? '已暂停开放，可更换管理员工位；已有学员预约保留' : '已开放此时间，学员现在可以选座');
        } catch (e) { notify((e as Error).message); }
        finally { setBusy(false); }
    }
    async function reserveAdminSeat() {
        if (!seatSession || !selectedSeat) return;
        setBusy(true);
        try {
            await api(`admin/sessions/${seatSession.id}/admin-seat`, 'PUT', { seatId: selectedSeat });
            await reload();
            setSeatSession(null);
            setSelectedSeat(undefined);
            notify('管理员工位已更新');
        } catch (e) { notify((e as Error).message); }
        finally { setBusy(false); }
    }
    async function toggleSessionBlock(session: Session) {
        setBusy(true);
        try {
            const dayOnly = session.dayBlocked && !session.sessionBlocked;
            const path = dayOnly ? `admin/dates/${localParts(session.startsAt).date}/disable` : `admin/sessions/${session.id}/disable`;
            const removing = session.sessionBlocked || dayOnly;
            await api(path, removing ? 'DELETE' : 'POST', removing ? undefined : { reason: '管理员手动禁用' });
            await reload();
            notify(removing ? '已恢复预约（仍需重新开放）' : '已禁用该时段，范围内预约已取消');
        } catch (e) { notify((e as Error).message); } finally { setBusy(false); }
    }
    async function toggleDayBlock(session: Session) {
        const date = localParts(session.startsAt).date;
        setBusy(true);
        try {
            const blocked = session.dayBlocked;
            await api(`admin/dates/${date}/disable`, blocked ? 'DELETE' : 'POST', blocked ? undefined : { reason: '管理员手动禁用当天' });
            await reload();
            notify(blocked ? '已恢复当天预约（时段仍需重新开放）' : '已禁用当天预约，范围内预约已取消');
        } catch (e) { notify((e as Error).message); } finally { setBusy(false); }
    }
    return <><div className="toolbar"><span>{data.sessions.length} 个预约时段 · 北京时间</span><button className="primary" onClick={() => { const now = currentShanghaiDateTime(); setEdit({ id: '', layoutId: publishedLayouts[0]?.id ?? '', startDate: now.date, startTime: now.time, endDate: now.date, endTime: now.time, open: false }); }}><Plus size={16}/>新增预约时段</button></div><ErrorMessage message={error || layouts.error}/><div className="table-wrap"><table><thead><tr><th>预约时间</th><th>场地与布局</th><th>管理员工位</th><th>开放状态</th><th>学员预约</th><th>操作</th></tr></thead><tbody>{data.sessions.map(s => { const adminSeats = s.reservations.filter(r => r.userId === user.id).map(r => s.layout.seats.find(seat => seat.id === r.seatId)?.code).filter(Boolean); return <tr key={s.id}><td><strong>{formatDate(s.startsAt)}</strong><small>{formatTime(s.startsAt)} – {formatTime(s.endsAt)}</small></td><td>{s.layout.venue.name}<small>{s.layout.name}</small></td><td>{adminSeats.length ? adminSeats.join('、') : '未选择'}<button className="text-button" disabled={!!s.cancelledAt || new Date(s.startsAt) <= new Date()} onClick={() => { if (s.open) { notify('请先暂停开放此时间，再更换管理员工位'); return; } setSelectedSeat(undefined); refreshSeatSession(s.id); }}>{adminSeats.length ? '更换工位' : '选择工位'}</button></td><td><span className={`badge ${s.bookingBlocked ? '' : s.cancelledAt ? '' : s.open ? 'green' : 'amber'}`}>{s.bookingBlocked ? '已禁用预约' : s.cancelledAt ? '已取消' : s.open ? '已开放' : '已暂停/未开放'}</span>{!s.bookingBlocked && !s.cancelledAt && <button className="text-button" disabled={busy || new Date(s.startsAt) <= new Date()} onClick={() => toggleAdminReady(s)}>{s.open ? '暂停开放' : '开放此时间'}</button>}<button className="text-button danger" disabled={busy || new Date(s.startsAt) <= new Date()} onClick={() => toggleSessionBlock(s)}>{s.bookingBlocked ? '恢复预约' : '禁用时段'}</button><button className="text-button" disabled={busy || new Date(s.startsAt) <= new Date()} onClick={() => toggleDayBlock(s)}>禁用当天</button></td><td>{s.reservations.filter(r => !s.layout.seats.find(seat => seat.id === r.seatId)?.fixedForAssistant && r.userId !== user.id).length}</td><td><button className="text-button" disabled={!!s.cancelledAt || new Date(s.startsAt) <= new Date()} onClick={() => setEdit({ id: s.id, layoutId: s.layoutId, ...sessionFormValues(s.startsAt, s.endsAt), open: s.open })}>编辑时间</button></td></tr>; })}</tbody></table>{!data.sessions.length && <p className="table-empty">暂无预约时段，请先新增时间。</p>}</div>{edit && <Dialog title={edit.id ? '编辑预约时段' : '新增预约时段'} close={() => setEdit(null)}><form className="form-grid" onSubmit={async (e) => { e.preventDefault(); setBusy(true); try {
        const startsAt = `${edit.startDate}T${edit.startTime}:00+08:00`, endsAt = `${edit.endDate}T${edit.endTime}:00+08:00`;
        await api(edit.id ? `sessions/${edit.id}` : 'sessions', edit.id ? 'PUT' : 'POST', { layoutId: edit.layoutId, startsAt, endsAt, open: edit.open, requiredAssistants: 1 });
        await reload(); setEdit(null); notify(edit.id ? '预约时段已更新' : '预约时段已创建，请先选择管理员工位再开放');
    } catch (e) { notify((e as Error).message); } finally { setBusy(false); } }}><label>已发布布局<select required value={edit.layoutId} onChange={e => setEdit({ ...edit, layoutId: e.target.value })}><option value="">请选择布局</option>{publishedLayouts.map(l => <option key={l.id} value={l.id}>{l.venue.name} · {l.name}</option>)}</select></label><label>日期<input type="date" required min={nowForInput.date} value={edit.startDate} onChange={e => setEdit({ ...edit, startDate: e.target.value, endDate: edit.endDate < e.target.value ? e.target.value : edit.endDate })}/></label><label>开始时间<select required value={edit.startTime} onChange={e => setEdit({ ...edit, startTime: e.target.value })}>{minuteOptions.map(t => <option key={t} value={t}>{t}</option>)}</select></label><label>结束日期<input type="date" required min={edit.startDate || nowForInput.date} value={edit.endDate} onChange={e => setEdit({ ...edit, endDate: e.target.value })}/></label><label>结束时间<select required value={edit.endTime} onChange={e => setEdit({ ...edit, endTime: e.target.value })}>{minuteOptions.map(t => <option key={t} value={t}>{t}</option>)}</select></label><p className="muted small">先保存未来时间，再在列表中选择管理员固定或普通工位，最后点击开放。</p><button className="primary" disabled={busy}>保存预约时段</button></form></Dialog>}{seatSession && <Dialog title="选择管理员工位" close={() => setSeatSession(null)} wide><p className="muted small">固定工位和普通工位都可以由管理员预约；学员不可选择固定工位。</p><div className="assistant-seat-map"><SeatMap layout={seatSession.layout} session={seatSession} canSelectFixed selected={selectedSeat} onSelect={seat => setSelectedSeat(seat.id)}/></div><div className="modal-actions"><button onClick={() => setSeatSession(null)}>取消</button><button className="primary" disabled={!selectedSeat || busy} onClick={reserveAdminSeat}>预约选中工位</button></div></Dialog>}</>;
}
function ReservationAdmin({ notify }: Props) {
    const [filter, setFilter] = useState(''), [busy, setBusy] = useState('');
    const { data, error, reload } = useResource<{
        reservations: Reservation[];
        coverage: Coverage[];
    }>(`admin/reservations${filter ? `?sessionId=${filter}` : ''}`, { reservations: [], coverage: [] });
    const sessions = useResource<{
        sessions: Session[];
    }>('admin/sessions', { sessions: [] });
    return <><div className="toolbar"><select aria-label="筛选预约时段" value={filter} onChange={e => setFilter(e.target.value)}><option value="">全部时段</option>{sessions.data.sessions.map(s => <option value={s.id} key={s.id}>{formatDate(s.startsAt)} {formatTime(s.startsAt)} – {formatTime(s.endsAt)}</option>)}</select><a className="button secondary" href={`/api/admin/reservations?export=csv${filter ? `&sessionId=${filter}` : ''}`}><Download size={16}/>导出 CSV</a></div><ErrorMessage message={error || sessions.error}/><div className="table-wrap"><table><thead><tr><th>预约人</th><th>预约时间</th><th>座位</th><th>状态</th><th>操作</th></tr></thead><tbody>{data.reservations.map(r => <tr key={r.id}><td>{r.user.name}<small>学号 {r.user.studentId} · {r.user.role === 'USER' ? '学员' : '管理员'}</small></td><td>{formatDate(r.startsAt)}<small>{formatTime(r.startsAt)} – {formatTime(r.endsAt)}</small></td><td><span className="seat-pill">{r.seat.code}</span></td><td><span className={`badge ${r.cancelledAt ? '' : 'green'}`}>{r.cancelledAt ? '已取消' : '已预约'}</span></td><td>{!r.cancelledAt && new Date(r.startsAt) > new Date() && <button disabled={busy === r.id} className="text-button" onClick={async () => { if (!confirm('确认取消此预约？'))
        return; setBusy(r.id); try {
        await api(`reservations/${r.id}`, 'DELETE');
        await reload();
        notify('预约已取消');
    }
    catch (e) {
        notify((e as Error).message);
    }
    finally {
        setBusy('');
    } }}>取消预约</button>}</td></tr>)}</tbody></table>{!data.reservations.length && <p className="table-empty">暂无座位预约</p>}</div></>;
}
const actionNames: Record<string, string> = { USER_UPDATE: '修改用户', GROUP_SAVE: '保存分组权限', VENUE_CREATE: '创建场地', LAYOUT_CREATE: '创建布局版本', LAYOUT_SAVE: '保存布局', LAYOUT_PUBLISH: '发布布局', COURSE_SAVE: '保存课程', SESSION_SAVE: '保存场次', RESERVATION_CREATE: '预约座位', RESERVATION_CANCEL: '取消预约', COVERAGE_CREATE: '登记助教保障', COVERAGE_CANCEL: '取消助教保障', BOOKING_BLOCK_CREATE: '禁用预约', BOOKING_BLOCK_REMOVE: '恢复预约', BOOKING_BLOCK_APPLY: '处理禁用范围预约', SESSION_ADMIN_UNREADY: '管理员工位取消' };
function Logs() {
    const { data, error } = useResource<{
        logs: {
            id: string;
            actor: {
                name: string;
                email: string;
            };
            action: string;
            target: string;
            details: object;
            createdAt: string;
        }[];
    }>('admin/logs', { logs: [] });
    return <><ErrorMessage message={error}/><div className="table-wrap"><table><thead><tr><th>操作时间</th><th>操作者</th><th>行为</th><th>详情</th></tr></thead><tbody>{data.logs.map(l => <tr key={l.id}><td>{formatDate(l.createdAt)}<small>{formatTime(l.createdAt)}</small></td><td>{l.actor.name}<small>{l.actor.email}</small></td><td>{actionNames[l.action] ?? l.action}</td><td><details><summary>查看详情</summary><pre>{JSON.stringify({ target: l.target, ...l.details }, null, 2)}</pre></details></td></tr>)}</tbody></table></div></>;
}
export function Dialog({ title, children, close, wide }: {
    title: string;
    children: ReactNode;
    close: () => void;
    wide?: boolean;
}) { return <Modal title={title} close={close} wide={wide}><div className="dialog-heading"><h2>{title}</h2><button aria-label="关闭" onClick={close}>×</button></div>{children}</Modal>; }
