'use client';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Users, CalendarDays, Armchair, PanelTop, Plus, Download, ArrowUpRight, ShieldCheck, Check, Pencil, UserX, KeyRound } from 'lucide-react';
import { api, subscribeToLayoutUpdates, type User, type Reservation } from '@/lib/types';
import { formatDate, formatTime, localParts } from '@/lib/rules';
import LayoutEditor from './layout-editor';
import Modal from './modal';
const titles: Record<string, [
    string,
    string
]> = { '/admin': ['空间管理概览', '从一张工位，到一段专注时光。这里是空间运行的全貌。'], '/admin/users': ['用户管理', '连接每一位学习者，统一管理身份和账号状态。'], '/admin/layouts': ['场地与布局', '自由组合桌面与工位，打造适合学习的空间。'], '/admin/booking-blocks': ['禁止预约时间', '设置任意时间范围或整天禁止预约，对所有身份生效。范围内已有预约会取消并发送通知。'], '/admin/reservations': ['预约记录', '查看管理员和学员的座位预约，取消未开始的学员预约。'], '/admin/logs': ['操作日志', '记录每一次重要变更，让空间管理有迹可循。'] };
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
    return <><div className="page-heading"><div><div className="eyebrow">SPACE MANAGEMENT</div><h1>{info[0]}</h1><p>{info[1]}</p></div><span className="badge green"><ShieldCheck size={13}/>管理员工作台 · {user.name}</span></div>{path === '/admin' ? <Overview /> : path === '/admin/users' ? <UserAdmin notify={notify}/> : path === '/admin/layouts' ? <LayoutEditor notify={notify}/> : path === '/admin/booking-blocks' ? <BookingBlockAdmin notify={notify}/> : path === '/admin/reservations' ? <ReservationAdmin notify={notify}/> : <Logs />}</>;
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
    const { data, error } = useResource('admin/stats', { users: 0, blocks: 0, reservations: 0, layouts: 0 });
    return <><ErrorMessage message={error}/><div className="stats-grid">{[{ label: '空间成员', value: data.users, icon: Users, unit: '位' }, { label: '禁止预约时间', value: data.blocks, icon: CalendarDays, unit: '个' }, { label: '有效座位预约', value: data.reservations, icon: Armchair, unit: '次' }, { label: '已发布布局', value: data.layouts, icon: PanelTop, unit: '版' }].map(s => <div className="stat-card" key={s.label}><div><span>{s.label}</span><s.icon size={19}/></div><strong>{s.value}<small>{s.unit}</small></strong><p>自习室预约</p></div>)}</div><div className="admin-panel"><h2>让空间准备就绪</h2><p className="muted">发布布局后即可预约；一生一芯成员需已有助教预约对应时间，ICIL 成员可直接预约。</p><div className="workflow-grid">{[['01', '发布场地布局', '/admin/layouts', '组合桌面与可预约座位'], ['02', '设置禁止预约时间', '/admin/booking-blocks', '按时间范围或整天暂停预约'], ['03', '查看预约情况', '/admin/reservations', '取消未开始的学员预约']].map(([num, title, href, text]) => <Link href={href} className="workflow-card" key={num}><span>{num}</span><h3>{title}<ArrowUpRight size={17}/></h3><p>{text}</p></Link>)}</div></div></>;
}
function UserAdmin({ notify }: Props) {
    const { data, reload, error } = useResource<{
        users: User[];
    }>('admin/users', { users: [] });
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
    const identityLabel = (u: User) => u.role === 'ADMIN' ? '管理员' : u.role === 'ASSISTANT' ? '助教' : u.memberType === 'ICIL' ? 'ICIL成员' : '一生一芯成员';
    const identityValue = (u: User) => u.role === 'USER' ? u.memberType : u.role;
    return <><div className="toolbar"><span>{data.users.length} 位成员</span><input placeholder="搜索姓名或学号" aria-label="搜索用户" value={search} onChange={e => setSearch(e.target.value)}/></div><ErrorMessage message={error}/><div className="table-wrap"><table><thead><tr><th>成员</th><th>身份</th><th>账号状态</th><th>操作</th></tr></thead><tbody>{data.users.filter(u => `${u.name} ${u.studentId} ${u.email}`.includes(search)).map(u => <tr key={u.id}><td><div className="user-cell"><span className="avatar">{u.name.slice(0, 1)}</span><div>{u.name}<small>学号 {u.studentId}</small></div></div></td><td>{identityLabel(u)}</td><td><span className={`badge ${u.deletedAt ? '' : u.enabled ? 'green' : ''}`}>{u.deletedAt ? '已注销' : u.enabled ? '已启用' : '已停用'}</span></td><td>{!u.deletedAt && <>{u.role === 'USER' && <button className="text-button" disabled={busy || !u.enabled} title="重置成员密码为 123456" onClick={() => resetPassword(u)}><KeyRound size={14}/>重置密码</button>}<button className="text-button" disabled={busy} onClick={() => setEdit({ ...u })}><Pencil size={14}/>编辑</button><button className="text-button danger" disabled={busy} onClick={() => unregister(u)}><UserX size={14}/>注销</button></>}</td></tr>)}</tbody></table></div>{edit && <Dialog title="编辑用户" close={() => setEdit(null)}><form className="form-grid" onSubmit={async (e) => { e.preventDefault(); setBusy(true); try {
        await api(`admin/users/${edit.id}`, 'PATCH', { name: edit.name, role: edit.role, memberType: edit.memberType, enabled: edit.enabled });
        await reload();
        setEdit(null);
        notify('用户已更新');
    }
    catch (e) {
        notify((e as Error).message);
    }
    finally {
        setBusy(false);
    } }}><label>姓名<input required value={edit.name} onChange={e => setEdit({ ...edit, name: e.target.value })}/></label><label>身份<select value={identityValue(edit)} onChange={e => { const identity = e.target.value as User['role'] | User['memberType']; setEdit({ ...edit, role: identity === 'ADMIN' || identity === 'ASSISTANT' ? identity : 'USER', memberType: identity === 'ICIL' ? 'ICIL' : 'YSYX' }); }}><option value="YSYX">一生一芯成员</option><option value="ICIL">ICIL成员</option><option value="ASSISTANT">助教</option><option value="ADMIN">管理员</option></select></label><label className="check-label"><input type="checkbox" checked={edit.enabled} onChange={e => setEdit({ ...edit, enabled: e.target.checked })}/>启用账号</label><button className="primary" disabled={busy}>保存用户</button></form></Dialog>}</>;
}
type BookingBlock = { id: string; startsAt: string; endsAt: string; reason: string };
function BookingBlockAdmin({ notify }: Props) {
    const { data, reload, error } = useResource<{ blocks: BookingBlock[] }>('admin/booking-blocks', { blocks: [] });
    const [edit, setEdit] = useState<{ startsAt: string; endsAt: string; date: string; allDay: boolean; reason: string } | null>(null);
    const [busy, setBusy] = useState(false);
    const dateTimeInput = (date: Date) => `${localParts(date).date}T${formatTime(date)}`;
    const add = () => {
        const now = new Date();
        setEdit({ startsAt: dateTimeInput(now), endsAt: dateTimeInput(new Date(now.getTime() + 3600000)), date: localParts(now).date, allDay: false, reason: '' });
    };
    return <><div className="toolbar"><span>北京时间 · 禁止范围内所有身份均不可预约</span><button className="primary" onClick={add}><Plus size={16}/>新增禁止预约时间</button></div><ErrorMessage message={error}/><div className="table-wrap"><table><thead><tr><th>开始时间</th><th>结束时间</th><th>原因</th><th>状态</th><th>操作</th></tr></thead><tbody>{data.blocks.map(block => <tr key={block.id}><td>{formatDate(block.startsAt)}<small>{formatTime(block.startsAt)}</small></td><td>{formatDate(block.endsAt)}<small>{formatTime(block.endsAt)}</small></td><td>{block.reason || '未填写'}</td><td><span className="badge">{new Date(block.endsAt) > new Date() ? '禁止预约' : '已结束'}</span></td><td><button className="text-button" disabled={busy} onClick={async () => {
        if (!confirm('确认解除此禁止预约时间？已取消的预约不会自动恢复。')) return;
        setBusy(true);
        try { await api(`admin/booking-blocks/${block.id}`, 'DELETE'); await reload(); notify('已解除禁止预约时间，成员可重新预约'); }
        catch (e) { notify((e as Error).message); } finally { setBusy(false); }
    }}>解除禁止</button></td></tr>)}</tbody></table>{!data.blocks.length && <p className="table-empty">暂无禁止预约时间</p>}</div>{edit && <Dialog title="新增禁止预约时间" close={() => !busy && setEdit(null)}><form className="form-grid" onSubmit={async e => {
        e.preventDefault(); setBusy(true);
        try {
            const startsAt = edit.allDay ? `${edit.date}T00:00:00+08:00` : `${edit.startsAt}:00+08:00`;
            const endsAt = edit.allDay ? new Date(new Date(startsAt).getTime() + 86400000).toISOString() : `${edit.endsAt}:00+08:00`;
            if (new Date(endsAt) <= new Date(startsAt)) throw new Error('结束时间必须晚于开始时间');
            const result = await api<{ reservations: number }>('admin/booking-blocks', 'POST', { startsAt, endsAt, reason: edit.reason });
            await reload(); setEdit(null); notify(`已设置禁止预约时间，取消了 ${result.reservations} 条范围内预约`);
        } catch (e) { notify((e as Error).message); } finally { setBusy(false); }
    }}><label className="check-label"><input type="checkbox" checked={edit.allDay} onChange={e => setEdit({ ...edit, allDay: e.target.checked })}/>全天禁止预约</label>{edit.allDay ? <label>禁止日期<input type="date" required min={localParts(new Date()).date} value={edit.date} onChange={e => setEdit({ ...edit, date: e.target.value })}/></label> : <><label>开始时间<input type="datetime-local" required value={edit.startsAt} onChange={e => setEdit({ ...edit, startsAt: e.target.value })}/></label><label>结束时间<input type="datetime-local" required min={edit.startsAt} value={edit.endsAt} onChange={e => setEdit({ ...edit, endsAt: e.target.value })}/></label></>}<label>原因（选填）<input maxLength={200} value={edit.reason} onChange={e => setEdit({ ...edit, reason: e.target.value })}/></label><p className="muted small">与禁止时间重叠的已有预约会取消并通知预约人。解除禁止后可重新预约。</p><button className="primary" disabled={busy}>保存禁止预约时间</button></form></Dialog>}</>;
}
function ReservationAdmin({ notify }: Props) {
    const [filter, setFilter] = useState(''), [busy, setBusy] = useState('');
    const { data, error, reload } = useResource<{
        reservations: Reservation[];
    }>('admin/reservations', { reservations: [] });
    const sessions = [...new Map(data.reservations.map(record => [record.sessionId, record.session])).values()];
    const reservations = data.reservations.filter(record => !filter || record.sessionId === filter);
    return <><div className="toolbar"><select aria-label="筛选预约日期" value={filter} onChange={e => setFilter(e.target.value)}><option value="">全部日期</option>{sessions.map(s => <option value={s.id} key={s.id}>{formatDate(s.startsAt)} {formatTime(s.startsAt)} – {formatTime(s.endsAt)}</option>)}</select><a className="button secondary" href={`/api/admin/reservations?export=csv${filter ? `&sessionId=${filter}` : ''}`}><Download size={16}/>导出 CSV</a></div><ErrorMessage message={error}/><div className="table-wrap"><table><thead><tr><th>预约人</th><th>预约时间</th><th>座位</th><th>状态</th><th>操作</th></tr></thead><tbody>{reservations.map(r => <tr key={r.id}><td>{r.user.name}<small>学号 {r.user.studentId} · {r.user.role === 'USER' ? '成员' : r.user.role === 'ASSISTANT' ? '助教' : '管理员'}</small></td><td>{formatDate(r.startsAt)}<small>{formatTime(r.startsAt)} – {formatTime(r.endsAt)}</small></td><td><span className="seat-pill">{r.seat.code}</span></td><td><span className={`badge ${r.cancelledAt ? '' : 'green'}`}>{r.cancelledAt ? '已取消' : '已预约'}</span></td><td>{!r.cancelledAt && new Date(r.startsAt) > new Date() && <button disabled={busy === r.id} className="text-button" onClick={async () => { if (!confirm('确认取消此预约？'))
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
    } }}>取消预约</button>}</td></tr>)}</tbody></table>{!reservations.length && <p className="table-empty">暂无座位预约</p>}</div></>;
}
const actionNames: Record<string, string> = { USER_UPDATE: '修改用户', VENUE_CREATE: '创建场地', LAYOUT_CREATE: '创建布局版本', LAYOUT_SAVE: '保存布局', LAYOUT_PUBLISH: '发布布局', SESSION_SAVE: '保存预约时段', RESERVATION_CREATE: '预约座位', RESERVATION_CANCEL: '取消预约', COVERAGE_CREATE: '登记现场保障', COVERAGE_CANCEL: '取消现场保障', BOOKING_BLOCK_CREATE: '禁用预约', BOOKING_BLOCK_REMOVE: '恢复预约', BOOKING_BLOCK_APPLY: '处理禁用范围预约', SESSION_ADMIN_UNREADY: '管理员工位取消' };
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
