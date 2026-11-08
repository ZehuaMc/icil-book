'use client';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Armchair, LayoutGrid, CalendarDays, ClipboardList, ArrowUpRight, ArrowRight, ChevronLeft, ChevronRight, Check, Clock3, MapPin, Users, ShieldCheck, LogOut, Leaf, Bell, X, LoaderCircle, Settings2, PanelTop, CircleHelp, UserRound, Eye, EyeOff, KeyRound } from 'lucide-react';
import { api, subscribeToLayoutUpdates, type User, type Session, type Seat, type Reservation, type UserNotification } from '@/lib/types';
import { formatDate, formatTime, localParts, maxMemberBookingTime, intervalCovered } from '@/lib/rules';
import SeatMap from './seat-map';
import Admin from './admin';
import Modal from './modal';
const roleNames = { USER: '成员', ASSISTANT: '助教', ADMIN: '管理员' };
const isOperator = (user: User | null) => user?.role === 'ADMIN' || user?.role === 'ASSISTANT';
export default function Workspace() {
    const path = usePathname(), router = useRouter();
    const [user, setUser] = useState<User | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState('');
    const refreshUser = useCallback(async () => { const result = await api<{
        user: User | null;
    }>('auth/me'); setUser(result.user); setError(''); }, []);
    useEffect(() => { refreshUser().catch(e => setError(e.message)).finally(() => setLoading(false)); }, [refreshUser, path]);
    useEffect(() => {
        const refresh = () => { if (document.visibilityState === 'visible') refreshUser().catch(() => {}); };
        const timer = setInterval(refresh, 20000);
        window.addEventListener('focus', refresh);
        document.addEventListener('visibilitychange', refresh);
        return () => { clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
    }, [refreshUser]);
    async function logout() {
        try { await api('auth/logout', 'POST'); setUser(null); router.push('/'); }
        catch (e) { setNotice((e as Error).message); }
    }
    const notify = useCallback((message: string) => { setNotice(message); }, []);
    useEffect(() => { if (notice) {
        const timer = setTimeout(() => setNotice(''), 5000);
        return () => clearTimeout(timer);
    } }, [notice]);
    const admin = path.startsWith('/admin');
    const navigation = user?.role === 'ADMIN' ? [] : [{ href: '/', icon: LayoutGrid, title: '预约工位' }, { href: '/my-reservations', icon: ClipboardList, title: '我的预约' }, { href: '/profile', icon: UserRound, title: '个人中心' }];
    const adminNavigation = [{ href: '/admin', icon: LayoutGrid, title: '数据概览' }, { href: '/admin/users', icon: Users, title: '用户管理' }, { href: '/admin/layouts', icon: PanelTop, title: '场地与布局' }, { href: '/admin/booking-blocks', icon: Clock3, title: '禁止预约时间' }, { href: '/admin/reservations', icon: ClipboardList, title: '预约记录' }, { href: '/admin/logs', icon: Settings2, title: '操作日志' }];
    const title = [...navigation, ...adminNavigation].find(n => n.href === path)?.title ?? '自习室预约';
    return <div className="app-shell">
    <aside className="sidebar"><Link className="brand" href="/"><img className="workspace-logo-combined" src="/logo/icilxysyx.png" alt="ICIL × YSYX" /><div>工位预约<span>SPACE FOR LEARNING</span></div></Link>
      <nav>{navigation.map(n => <Link key={n.href} href={n.href} className={path === n.href ? 'active' : ''}><n.icon size={19}/>{n.title}{path === n.href && <span className="nav-dot"/>}</Link>)}</nav>
      {user?.role === 'ADMIN' && <><p className="nav-caption">空间管理</p><nav>{adminNavigation.map(n => <Link key={n.href} href={n.href} className={path === n.href ? 'active' : ''}><n.icon size={18}/>{n.title}</Link>)}</nav></>}
      <div className="sidebar-bottom"><div className="little-note"><Leaf size={21}/><p>好位置，好灵感。<small>让学习在这里自然发生。</small></p></div><div className="sidebar-help"><CircleHelp size={16}/>预约时间均为北京时间</div></div>
      <div className="profile">{user ? <><span className="avatar">{user.name.slice(0, 1)}</span><div>{user.name}<small>{roleNames[user.role]}</small></div><button className="text-button logout-control" title="退出登录并返回入口" aria-label="退出登录并返回入口" onClick={logout}><LogOut size={15}/>退出</button></> : <div className="profile-login"><span className="avatar">访</span><span><Link href="/login">登录</Link><small><Link href="/register">注册</Link></small></span></div>}</div>
    </aside>
      <div className="main-shell"><header className="topbar"><div className="breadcrumb">工作空间 <ChevronRight size={13}/><span>{title}</span></div><div className="topbar-right"><span className="campus"><span className="online-dot"/>空间已开放</span>{user && <NotificationBell user={user}/>}<span className="topbar-avatar">{user?.name.slice(0, 1) ?? '访'}</span><div className="mobile-account">{user ? <button className="icon-button" aria-label="退出登录" onClick={logout}><LogOut size={17}/></button> : <Link className="button" href="/login">登录</Link>}</div></div></header>
      <main>{error ? <div className="error-state"><h2>暂时无法连接服务</h2><p>{error}</p><button onClick={() => window.location.reload()}>重新加载</button></div> : loading ? <div className="loading"><LoaderCircle className="spin"/>正在打开学习空间…</div> : path === '/login' || path === '/register' ? <AuthForm register={path === '/register'} onLogin={async (destination) => { await refreshUser(); router.push(destination); }}/> : admin ? user?.role === 'ADMIN' ? <Admin path={path} user={user!} notify={notify}/> : <Empty title="需要管理员权限" description="请使用管理员账号登录，或返回预约工位。" action={<Link className="button primary" href={user?.role === 'ASSISTANT' ? '/' : '/login'}>{user?.role === 'ASSISTANT' ? '预约工位' : '登录'}</Link>}/> : path === '/profile' ? user && user.role !== 'ADMIN' ? <PersonalCenter user={user} notify={notify}/> : isOperator(user) ? <Empty title="管理员账号" description="管理账号可在后台预约记录中查看工位安排。" action={<Link className="button primary" href={user!.role === 'ASSISTANT' ? '/assistant/sessions' : '/admin/reservations'}>{user!.role === 'ASSISTANT' ? '预约工位' : '查看预约记录'}</Link>}/> : <LoginRequired/> : path === '/my-reservations' ? user && user.role !== 'ADMIN' ? <MyReservations notify={notify}/> : user?.role === 'ADMIN' ? <Admin path="/admin/reservations" user={user!} notify={notify}/> : <LoginRequired/> : path === '/assistant/sessions' ? user?.role === 'ASSISTANT' ? <BookingHome user={user} notify={notify}/> : <LoginRequired/> : path === '/' ? user?.role === 'ADMIN' ? <Admin path="/admin" user={user!} notify={notify}/> : user ? <BookingHome user={user} notify={notify}/> : <LoginChoice/> : <Empty title="页面不存在" description="返回预约空间。" action={<Link className="button primary" href="/">返回入口</Link>}/>}</main>
      <footer><span>工位 · 为专注与创造留一个位置</span><span>教学实践中心 <span className="footer-dot">·</span> Asia / Shanghai</span></footer>
    </div>{notice && <div role="status" className="toast"><Check size={18}/>{notice}<button aria-label="关闭提示" onClick={() => setNotice('')}><X size={16}/></button></div>}
  </div>;
}
function NotificationBell({ user }: { user: User }) {
    const [items, setItems] = useState<UserNotification[]>([]), [unreadCount, setUnreadCount] = useState(0), [open, setOpen] = useState(false), [error, setError] = useState('');
    const load = useCallback(async () => {
        const data = await api<{ notifications: UserNotification[]; unreadCount: number }>('notifications');
        setItems(data.notifications);
        setUnreadCount(data.unreadCount);
        setError('');
    }, [user.id]);
    useEffect(() => { load().catch(e => setError((e as Error).message)); const timer = setInterval(() => load().catch(() => {}), 15000); return () => clearInterval(timer); }, [load]);
    async function markRead(id?: string) {
        try {
            await api(id ? `notifications/${id}` : 'notifications/read-all', id ? 'PATCH' : 'POST');
            await load();
        } catch (e) { setError((e as Error).message); }
    }
    return <div className="notification-menu">
      <button className="icon-button notification-trigger" aria-label={`信息提醒${unreadCount ? `，${unreadCount} 条未读` : ''}`} aria-expanded={open} onClick={() => setOpen(value => !value)}><Bell size={19}/>{unreadCount > 0 && <span className="notification-count">{unreadCount > 99 ? '99+' : unreadCount}</span>}</button>
      {open && <div className="notification-panel" role="dialog" aria-label="信息提醒"><div className="notification-heading"><strong>信息提醒</strong>{unreadCount > 0 && <button className="text-button" onClick={() => markRead()}>全部已读</button>}</div>{error ? <p className="notification-empty">{error}</p> : items.length ? <div className="notification-list">{items.map(item => <button key={item.id} className={`notification-item ${item.readAt ? '' : 'unread'}`} onClick={() => !item.readAt && markRead(item.id)}><span className="notification-item-icon"><Bell size={15}/></span><span><span className="notification-message">{item.message}</span><small>{new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(item.createdAt))}</small></span>{!item.readAt && <i/>}</button>)}</div> : <p className="notification-empty">暂无信息提醒</p>}</div>}
    </div>;
}
export function Empty({ title, description, action }: {
    title: string;
    description: string;
    action?: ReactNode;
}) { return <div className="empty-state"><Armchair size={40} strokeWidth={1}/><h2>{title}</h2><p>{description}</p>{action}</div>; }
function LoginRequired() { return <Empty title="你的预约，从这里开始" description="登录后即可预约工位，查看和管理学习安排。" action={<Link className="button primary" href="/login">登录 <ArrowRight size={16}/></Link>}/>; }
function LoginChoice() {
    return <div className="auth-wrap login-choice"><div className="eyebrow">ICIL × YSYX · SPACE BOOKING</div><h1>登录预约空间。</h1><p className="muted">成员、助教与管理员使用同一个登录入口。</p><div className="auth-card"><Link className="button primary wide" href="/login">登录 <ArrowRight size={17}/></Link><Link className="auth-switch" href="/register">注册成员账号</Link></div></div>;
}
function AuthForm({ register, onLogin }: {
    register: boolean;
    onLogin: (destination: '/' | '/admin' | '/assistant/sessions') => Promise<void>;
}) {
    const [busy, setBusy] = useState(false), [error, setError] = useState('');
    return <div className="auth-wrap"><div className="eyebrow">YOUR SPACE, YOUR PACE</div><h1>{register ? '从一个好位置开始。' : '登录预约空间。'}</h1><p className="muted">{register ? '注册后默认为一生一芯成员，管理员可调整成员身份。' : '使用学号和密码登录，系统将根据账号身份进入对应页面。'}</p><form className="auth-card" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setError('');
        const data = Object.fromEntries(new FormData(e.currentTarget));
        try {
            const result = await api<{ user: User }>(register ? 'auth/register' : 'auth/login', 'POST', data);
            await onLogin(result.user.role === 'ADMIN' ? '/admin' : '/');
        } catch (e) { setError((e as Error).message); }
        finally { setBusy(false); }
    }}>
    {register && <label>昵称<input name="name" placeholder="输入昵称" required maxLength={60} autoComplete="nickname"/></label>}<label>学号<input name="studentId" placeholder="输入学号" minLength={3} maxLength={30} pattern="[A-Za-z0-9]+" autoComplete="username" required/></label><label>密码<input type="password" name="password" placeholder={register ? '至少 10 位字符' : '输入密码'} minLength={register ? 10 : 1} maxLength={100} autoComplete={register ? 'new-password' : 'current-password'} required/></label>{error && <p role="alert" className="form-error">{error}</p>}<button className="primary wide" disabled={busy}>{busy ? '请稍候…' : register ? '注册成员账号' : '登录'}<ArrowRight size={17}/></button><p className="auth-switch">{register ? '已经有账号？' : '还没有账号？'}<Link href={register ? '/login' : '/register'}>{register ? '立即登录' : '注册成员'}</Link></p></form></div>;
}
function BookingHome({ user, notify }: {
    user: User | null;
    notify: (s: string) => void;
}) {
    const [sessions, setSessions] = useState<Session[]>([]), [selectedId, setSelectedId] = useState(''), [date, setDate] = useState(''), [selectedSlots, setSelectedSlots] = useState<number[]>([]), [seat, setSeat] = useState<Seat | null>(null), [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState('');
    const load = useCallback(async () => { const data = await api<{
        sessions: Session[];
    }>('sessions'); setSessions(data.sessions); const mineSession = data.sessions.find(s => s.reservations.some(r => r.mine)); setSelectedId(prev => data.sessions.some(s => s.id === prev) ? prev : mineSession?.id ?? data.sessions[0]?.id ?? ''); setDate(prev => data.sessions.some(s => localParts(s.startsAt).date === prev) ? prev : localParts(mineSession?.startsAt ?? data.sessions[0]?.startsAt ?? new Date()).date); }, []);
    useEffect(() => { load().catch(e => setError(e.message)).finally(() => setLoading(false)); }, [load, user]);
    useEffect(() => { const interval = setInterval(() => load().catch(() => { }), 5000); return () => clearInterval(interval); }, [load]);
    useEffect(() => subscribeToLayoutUpdates(() => load().catch(() => { })), [load]);
    const dates = [...new Set(sessions.map(s => localParts(s.startsAt).date))];
    const dateSessions = sessions.filter(s => localParts(s.startsAt).date === date);
    const session = dateSessions.find(s => s.id === selectedId) ?? dateSessions[0];
    const venueDisplayName = '人工智能与低空技术学院';
    const icilMember = user?.role === 'USER' && user.memberType === 'ICIL';
    useEffect(() => {
        if (dateSessions.length && !dateSessions.some(s => s.id === selectedId)) setSelectedId(dateSessions[0].id);
    }, [date, selectedId, sessions]);
    useEffect(() => {
        setSeat(null);
        setConfirm(false);
        const mine = session?.reservations.filter(record => record.mine && record.startsAt && record.endsAt) ?? [];
        setSelectedSlots(mine.flatMap(record => {
            const start = new Date(record.startsAt!).getTime(), end = new Date(record.endsAt!).getTime();
            return start % (30 * 60000) === 0 && end % (30 * 60000) === 0
                ? Array.from({ length: (end - start) / (30 * 60000) }, (_, index) => start + index * 30 * 60000)
                : [];
        }));
    }, [session?.id]);
    useEffect(() => {
        if (seat && !session?.layout.seats.some(s => s.id === seat.id && s.enabled)) {
            setSeat(null);
            setConfirm(false);
        }
    }, [session, seat]);
    const selectedIntervals: { startsAt: Date; endsAt: Date }[] = [];
    for (const timestamp of [...selectedSlots].sort((a, b) => a - b)) {
        const last = selectedIntervals.at(-1);
        if (last && last.endsAt.getTime() === timestamp) last.endsAt = new Date(timestamp + 30 * 60000);
        else selectedIntervals.push({ startsAt: new Date(timestamp), endsAt: new Date(timestamp + 30 * 60000) });
    }
    const bookingStart = selectedIntervals[0]?.startsAt;
    const selectedTimeText = selectedIntervals.map(interval => `${formatTime(interval.startsAt)}–${formatTime(interval.endsAt)}`).join('、');
    const intervalsOverlap = (startsAt: Date, endsAt: Date) => selectedIntervals.some(interval => startsAt < interval.endsAt && endsAt > interval.startsAt);
    const mine = session?.reservations.find(r => r.mine && r.startsAt && r.endsAt && intervalsOverlap(new Date(r.startsAt), new Date(r.endsAt)));
    const bookingStartsAt = mine?.startsAt ?? session?.startsAt;
    const displayStartsAt = mine?.startsAt ?? bookingStart ?? session?.startsAt;
    const selectedBookingBlock = !!session && selectedIntervals.some(interval => session.bookingBlocks?.some(block => new Date(block.startsAt) < interval.endsAt && new Date(block.endsAt) > interval.startsAt));
    const selectedSeatOccupied = !!seat && !!session?.reservations.some(r => r.seatId === seat.id && r.startsAt && r.endsAt && intervalsOverlap(new Date(r.startsAt), new Date(r.endsAt)));
    useEffect(() => {
        if (selectedSeatOccupied) {
            setSeat(null);
            setConfirm(false);
        }
    }, [selectedSeatOccupied]);
    const intervalInsideSession = !!session && selectedIntervals.length > 0 && selectedIntervals.every(interval => interval.startsAt >= new Date(session.startsAt) && interval.endsAt <= new Date(session.endsAt));
    const intervalValid = intervalInsideSession && selectedSlots.length > 0 && selectedSlots.every(slot => slot > Date.now() && slot % (30 * 60000) === 0 && slot + 30 * 60000 <= maxMemberBookingTime().getTime());
    const assistantPresent = !!session && selectedIntervals.length > 0 && selectedIntervals.every(interval => intervalCovered(session.staffPresenceWindows ?? [], interval.startsAt, interval.endsAt));
    const ready = !!user && !!session && !session.bookingBlocked && !selectedBookingBlock && (isOperator(user) || icilMember || assistantPresent) && intervalValid && !mine;
    const canUseAssistantSeats = isOperator(user);
    const available = session ? session.layout.seats.filter(s => s.enabled && (canUseAssistantSeats || !s.fixedForAssistant) && !session.reservations.some(r => r.seatId === s.id && r.startsAt && r.endsAt && intervalsOverlap(new Date(r.startsAt), new Date(r.endsAt)))).length : 0;
    const slotOptions = session ? Array.from({ length: 48 }, (_, index) => {
        const startsAt = new Date(new Date(session.startsAt).getTime() + index * 30 * 60000);
        const endsAt = new Date(startsAt.getTime() + 30 * 60000);
        const blocked = session.bookingBlocks?.some(block => new Date(block.startsAt) < endsAt && new Date(block.endsAt) > startsAt) ?? false;
        const coveredByAssistant = isOperator(user) || icilMember || intervalCovered(session.staffPresenceWindows ?? [], startsAt, endsAt);
        const seatAvailable = session.layout.seats.some(s => s.enabled && (canUseAssistantSeats || !s.fixedForAssistant) && !session.reservations.some(r => r.seatId === s.id && r.startsAt && r.endsAt && new Date(r.startsAt) < endsAt && new Date(r.endsAt) > startsAt));
        return { startsAt, endsAt, selectable: endsAt <= new Date(session.endsAt) && startsAt > new Date() && endsAt <= maxMemberBookingTime() && !blocked && coveredByAssistant && seatAvailable };
    }).filter(slot => slot.endsAt <= new Date(session.endsAt)) : [];
    const toggleSlot = (timestamp: number) => {
        setSelectedSlots(current => current.includes(timestamp) ? current.filter(slot => slot !== timestamp) : [...current, timestamp]);
        setSeat(null);
        setConfirm(false);
    };
    const assistantStatus = isOperator(user) ? '助教预约工位后，一生一芯成员可预约对应时间。' : icilMember ? 'ICIL 成员无需等待助教预约。' : assistantPresent ? '所选完整时间已有助教预约。' : '一生一芯成员仅可选择已有助教预约的时间。';
    const reason = `${!user ? '登录后即可选择心仪的座位' : !selectedSlots.length ? '先选择一个或多个时间段' : selectedBookingBlock ? '管理员已禁用所选时间，无法预约' : session?.bookingBlocked ? '该日期已禁用预约' : mine ? `所选时间已有你的 ${session?.layout.seats.find(s => s.id === mine.seatId)?.code} 号工位预约` : !intervalInsideSession ? '预约时间必须在所选日期内' : !intervalValid ? '请选择未来且可用的半小时段' : !isOperator(user) && !icilMember && !assistantPresent ? '所选完整时间须已有助教预约工位' : selectedSeatOccupied ? '所选工位在部分时间段已被预约' : '在平面图中选择一个心仪的位置'}`;
    const cancelMine = async () => {
        if (!mine || !mine.id || busy) return;
        if (!window.confirm('确认取消此预约？座位将立即释放。')) return;
        setBusy(true);
        try {
            await api(`reservations/${mine.id}`, 'DELETE');
            setSeat(null);
            notify('预约已取消，座位已释放');
            await load();
        }
        catch (e) {
            notify((e as Error).message);
        }
        finally {
            setBusy(false);
        }
    };
    const roleHeading = user?.role === 'ASSISTANT' ? '助教' : user?.memberType === 'ICIL' ? 'ICIL 成员' : '一生一芯成员';
    return <><div className="page-heading"><div><div className="eyebrow">A PLACE TO FOCUS</div><h1>{user ? `${roleHeading}，找到你的好位置。` : '给下一次灵感，留个位置。'}</h1><p>选择日期和 30 分钟时段，查看工位并完成预约。</p></div><Link className="button secondary" href="/my-reservations"><ClipboardList size={16}/>我的预约<ArrowUpRight size={15}/></Link></div>
    <div className="intro-strip"><div className="intro-icon"><Leaf size={20}/></div><span>空间为学习而开放</span><p>一生一芯成员需有助教预约对应时间；ICIL 成员可直接预约。管理员禁止预约的时间对所有人有效。</p><span className="strip-tag">专注 · 共享 · 创造</span></div>
    <section className="date-section"><div className="section-top"><h2><CalendarDays size={19}/>选择日期<span>01 / DATE</span></h2><span className="muted small">{date ? `${date.slice(0, 4)} 年 ${Number(date.slice(5, 7))} 月` : ''}</span></div><div className="date-row"><button className="date-arrow" aria-label="前一个日期" disabled={dates.indexOf(date) <= 0} onClick={() => setDate(dates[dates.indexOf(date) - 1])}><ChevronLeft size={18}/></button><div className="date-scroll">{dates.length ? dates.map(d => <button key={d} aria-label={`选择日期 ${d}`} className={`date-item ${date === d ? 'selected' : ''}`} onClick={() => setDate(d)}><span>{new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', weekday: 'short' }).format(new Date(`${d}T12:00:00+08:00`))}</span><strong>{Number(d.slice(8))}</strong></button>) : <p className="muted">暂无开放预约日期</p>}</div><button className="date-arrow" aria-label="后一个日期" disabled={dates.indexOf(date) >= dates.length - 1} onClick={() => setDate(dates[dates.indexOf(date) + 1])}><ChevronRight size={18}/></button></div></section>
    {loading ? <div className="loading"><LoaderCircle className="spin"/>正在加载预约信息…</div> : error ? <p className="form-error" role="alert">{error}<button onClick={() => load().then(() => setError('')).catch(e => setError(e.message))}>重试</button></p> : !session ? <Empty title="暂时没有可用布局" description="管理员尚未发布可预约布局，请稍后再来。"/> : <div className="booking-grid"><div className="booking-main">
      <section className="booking-time-select">{dateSessions.length > 1 && <label>场地<select aria-label="场地" value={session.id} onChange={e => setSelectedId(e.target.value)}>{dateSessions.map(item => <option key={item.id} value={item.id}>{item.layout.venue.name} · {item.layout.name}</option>)}</select></label>}<div className="section-top"><h2><Clock3 size={19}/>选择预约时间<span>02 / TIME</span></h2><span className="muted small">所选日期：{date} · 已选 {selectedSlots.length} 段</span></div><div className="time-slot-grid">{slotOptions.map(slot => { const timestamp = slot.startsAt.getTime(), selected = selectedSlots.includes(timestamp); return <button type="button" key={timestamp} aria-pressed={selected} aria-label={`${formatTime(slot.startsAt)} 至 ${formatTime(slot.endsAt)}${selected ? '，已选择' : slot.selectable ? '，可预约' : '，不可预约'}`} disabled={!slot.selectable && !selected} className={`time-slot ${selected ? 'selected' : ''}`} onClick={() => toggleSlot(timestamp)}>{formatTime(slot.startsAt)}</button>; })}</div><p className="muted small">每格 30 分钟，可同时选择多个时段；同一天可多次预约。{assistantStatus}</p></section>
      <section className="map-section"><div className="section-top"><h2><Armchair size={19}/>选择工位<span>03 / YOUR SEAT</span></h2><div className="map-legend"><span><i className="legend-available"/>可预约</span><span><i className="legend-booked"/>已预约</span><span><i className="legend-mine"/>本人 / 选中</span><span><i className="legend-disabled"/>停用 / {canUseAssistantSeats ? '助教固定工位可选' : '助教固定工位'}</span></div></div><div className="map-card"><div className="map-caption"><span><MapPin size={14}/>{venueDisplayName}</span><span>{venueDisplayName} · {session.layout.name}</span></div><div className="map-stage"><SeatMap layout={session.layout} session={session} canSelectFixed={canUseAssistantSeats} intervals={selectedIntervals} selected={seat?.id} disabled={!ready} onSelect={s => { setSeat(s); setConfirm(false); }}/></div><div className="map-bottom"><span className="online-dot"/><span>共 {session.layout.seats.filter(s => s.enabled && (canUseAssistantSeats || !s.fixedForAssistant)).length} 个可预约工位</span><span className="muted">·</span><strong>{available} 个可预约</strong><span className="map-auto">座位状态每 20 秒更新</span></div></div></section>
    </div><aside className="booking-aside"><div className="booking-summary"><div className="summary-title"><h2>这一次，坐这里</h2><Armchair size={21}/></div><p className="summary-subtitle">YOUR NEXT LEARNING MOMENT</p><dl className="summary-details"><div><dt><CalendarDays size={15}/>日期</dt><dd>{formatDate(displayStartsAt ?? session.startsAt)}</dd></div><div><dt><Clock3 size={15}/>时间</dt><dd>{selectedTimeText || '选择一个或多个时段'}</dd></div><div><dt><MapPin size={15}/>场地</dt><dd>{venueDisplayName}</dd></div></dl><div className={`coverage-box ${selectedBookingBlock ? 'waiting' : ''}`}><ShieldCheck size={18}/><div><strong>{selectedBookingBlock ? '该时间禁止预约' : !isOperator(user) && !icilMember && !assistantPresent ? '等待助教预约' : '可选择预约时间'}</strong><small>{assistantStatus}</small></div></div><div className={`chosen-seat ${seat || mine ? 'has-seat' : ''}`}><Armchair size={28} strokeWidth={1.4}/><div><small>{mine ? '你的预约座位' : seat ? '已选座位' : '尚未选择工位'}</small><strong>{mine ? session.layout.seats.find(s => s.id === mine.seatId)?.code : seat?.code ?? '等待你的选择'}</strong></div></div><p className="selection-hint">{reason}</p>{!user ? <Link className="button primary wide" href="/login">登录后预约<ArrowRight size={16}/></Link> : mine ? <div className="booking-actions"><button className="wide" disabled={busy || !bookingStartsAt || new Date(bookingStartsAt) <= new Date()} onClick={cancelMine}>{busy ? '正在取消…' : '取消预约'}</button></div> : <button className="primary wide" disabled={!ready || !seat} onClick={() => setConfirm(true)}>预约所选时间<ArrowRight size={16}/></button>}<p className="cancel-note">预约开始前可取消，取消后立即释放工位。</p></div><div className="guidelines"><span className="eyebrow">A LITTLE REMINDER</span><h3>让好空间，被好好使用。</h3><p>按时到场，保持安静与整洁。<br />计划有变？记得把位置留给需要的人。</p></div></aside></div>}
    {confirm && session && seat && <Modal title={`为你留住 ${seat.code} 号工位？`} close={() => !busy && setConfirm(false)}><span className="modal-icon"><Armchair size={28}/></span><h2 id="confirm-title">为你留住 {seat.code} 号工位？</h2><p className="muted">{selectedTimeText}</p><div className="modal-actions"><button disabled={busy} onClick={() => setConfirm(false)}>再想一下</button><button className="primary" disabled={busy || !ready || selectedSeatOccupied} onClick={async () => { setBusy(true); try {
        await api('reservations/batch', 'POST', { sessionId: session.id, seatId: seat.id, slots: selectedIntervals.map(interval => ({ startsAt: interval.startsAt.toISOString(), endsAt: interval.endsAt.toISOString() })) });
        notify(`已预约 ${selectedSlots.length} 个半小时段，${seat.code} 号工位等你来`);
        setConfirm(false);
        setSeat(null);
    }
    catch (e) {
        notify((e as Error).message);
        setConfirm(false);
    }
    finally {
        await load().catch(() => { });
        setBusy(false);
    } }}>{busy ? '正在预约…' : '确认，预约这个工位'}</button></div></Modal>}
  </>;
}
function PersonalCenter({ user, notify }: { user: User; notify: (s: string) => void }) {
    return <><PageHeading eyebrow="YOUR ACCOUNT" title="个人中心" description="管理账号安全，查看当前与历史工位预约。"/><section className="account-identity"><span className="avatar">{user.name.slice(0, 1)}</span><div><strong>{user.name}</strong><span>学号 {user.studentId}</span></div></section><PasswordSettings notify={notify}/><MyReservations notify={notify} embedded/></>;
}
function PasswordSettings({ notify }: { notify: (s: string) => void }) {
    const [currentPassword, setCurrentPassword] = useState(''), [newPassword, setNewPassword] = useState(''), [showCurrent, setShowCurrent] = useState(false), [showNew, setShowNew] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
    async function submit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault(); setBusy(true); setError('');
        try {
            await api('auth/change-password', 'POST', { currentPassword, newPassword });
            setCurrentPassword(''); setNewPassword('');
            notify('密码已修改，其他设备已退出登录');
        } catch (e) { setError((e as Error).message); }
        finally { setBusy(false); }
    }
    return <section className="account-section"><div className="account-section-heading"><div><h2><KeyRound size={18}/>修改密码</h2><p>新密码至少 10 位。系统只保存加密结果，无法查看已保存的明文密码。</p></div></div><form className="password-form" onSubmit={submit}><label>当前密码<div className="password-input-row"><input required autoComplete="current-password" type={showCurrent ? 'text' : 'password'} value={currentPassword} onChange={e => setCurrentPassword(e.target.value)}/><button type="button" className="password-visibility" title={showCurrent ? '隐藏输入内容' : '显示输入内容'} aria-label={showCurrent ? '隐藏当前密码输入内容' : '显示当前密码输入内容'} onClick={() => setShowCurrent(v => !v)}>{showCurrent ? <EyeOff size={17}/> : <Eye size={17}/>}</button></div></label><label>新密码<div className="password-input-row"><input required minLength={10} maxLength={100} autoComplete="new-password" type={showNew ? 'text' : 'password'} value={newPassword} onChange={e => setNewPassword(e.target.value)}/><button type="button" className="password-visibility" title={showNew ? '隐藏输入内容' : '显示输入内容'} aria-label={showNew ? '隐藏新密码输入内容' : '显示新密码输入内容'} onClick={() => setShowNew(v => !v)}>{showNew ? <EyeOff size={17}/> : <Eye size={17}/>}</button></div></label>{error && <p role="alert" className="form-error">{error}</p>}<button className="primary" disabled={busy || !currentPassword || newPassword.length < 10}>{busy ? '正在保存…' : '保存新密码'}</button></form></section>;
}
function MyReservations({ notify, embedded = false }: { notify: (s: string) => void; embedded?: boolean }) {
    const [records, setRecords] = useState<Reservation[]>([]), [error, setError] = useState(''), [loading, setLoading] = useState(true), [busy, setBusy] = useState('');
    const load = useCallback(async () => { const data = await api<{ reservations: Reservation[] }>('reservations'); setRecords(data.reservations); }, []);
    useEffect(() => { load().catch(e => setError(e.message)).finally(() => setLoading(false)); }, [load]);
    const now = Date.now();
    const current = records.filter(r => !r.cancelledAt && new Date(r.endsAt).getTime() >= now);
    const history = records.filter(r => r.cancelledAt || new Date(r.endsAt).getTime() < now);
    const heading = !embedded && <PageHeading eyebrow="YOUR LEARNING JOURNEY" title="我的预约" description="查看预约时段、工位位置和预约状态。"/>;
    const section = (title: string, items: Reservation[], active: boolean) => <section className="reservation-section"><div className="section-top"><h2>{title}</h2><span className="muted small">{items.length} 项</span></div>{items.length ? <div className="records-grid">{items.map(r => {
        const startsAt = new Date(r.startsAt), endsAt = new Date(r.endsAt), isCurrent = !r.cancelledAt && endsAt.getTime() >= Date.now();
        const status = r.cancelledAt ? '已取消' : endsAt.getTime() < Date.now() ? '已结束' : startsAt.getTime() > Date.now() ? '预约成功' : '进行中';
        return <div className="record-card" key={r.id}><div className="record-top"><span className={`badge ${isCurrent ? 'green' : ''}`}>{status}</span><span className="seat-pill"><Armchair size={15}/>{r.seat.code}</span></div><h3>自习室预约</h3><p><CalendarDays size={16}/>{formatDate(startsAt)}</p><p><Clock3 size={16}/>{formatTime(startsAt)} – {formatTime(endsAt)}</p><p><MapPin size={16}/>{r.session.layout.venue.name} · {r.session.layout.name} · {r.seat.code} 号工位</p>{active && !r.cancelledAt && startsAt.getTime() > Date.now() && <button disabled={busy === r.id} onClick={async () => { if (!window.confirm('确认取消此预约？座位将立即释放。')) return; setBusy(r.id); try { await api(`reservations/${r.id}`, 'DELETE'); await load(); notify('预约已取消，座位已释放'); } catch (e) { notify((e as Error).message); } finally { setBusy(''); } }}>取消预约</button>}</div>;
    })}</div> : <p className="reservation-empty">{active ? '当前没有有效预约。' : '暂无历史预约记录。'}</p>}</section>;
    return <>{heading}{error && <p role="alert" className="form-error">{error}</p>}{loading ? <p>正在加载预约记录…</p> : <div className="reservation-history">{section('当前预约', current, true)}{section('历史预约', history, false)}</div>}</>;
}
export function PageHeading({ eyebrow, title, description, action }: {
    eyebrow: string;
    title: string;
    description: string;
    action?: ReactNode;
}) { return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div>{action}</div>; }
