'use client';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Armchair, LayoutGrid, CalendarDays, ClipboardList, ArrowUpRight, ArrowRight, ChevronLeft, ChevronRight, Check, Clock3, MapPin, Users, ShieldCheck, LogOut, Leaf, Bell, X, LoaderCircle, Settings2, PanelTop, CircleHelp, UserRound, Eye, EyeOff, KeyRound } from 'lucide-react';
import { api, subscribeToLayoutUpdates, type User, type Session, type Seat, type Reservation, type Coverage, type Layout, type UserNotification } from '@/lib/types';
import { formatDate, formatTime, localParts, groupAllows, maxMemberBookingInput } from '@/lib/rules';
import SeatMap from './seat-map';
import Admin from './admin';
import Modal from './modal';
const roleNames = { USER: '学员', ASSISTANT: '管理员', ADMIN: '管理员' };
const isOperator = (user: User | null) => user?.role === 'ADMIN' || user?.role === 'ASSISTANT';
function shanghaiDateTimeInput(value: Date | string) {
    const { date, minute } = localParts(value);
    return `${date}T${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}
function shanghaiDateTimeValue(value: string) { return new Date(`${value}:00+08:00`); }
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
    const navigation = isOperator(user) ? [] : [{ href: '/', icon: LayoutGrid, title: '预约工位' }, { href: '/my-reservations', icon: ClipboardList, title: '我的预约' }, { href: '/profile', icon: UserRound, title: '个人中心' }];
    const adminNavigation = [{ href: '/admin', icon: LayoutGrid, title: '数据概览' }, { href: '/admin/users', icon: Users, title: '用户管理' }, { href: '/admin/groups', icon: ShieldCheck, title: '分组与权限' }, { href: '/admin/layouts', icon: PanelTop, title: '场地与布局' }, { href: '/admin/sessions', icon: Clock3, title: '预约时段' }, { href: '/admin/reservations', icon: ClipboardList, title: '预约记录' }, { href: '/admin/logs', icon: Settings2, title: '操作日志' }];
    const title = [...navigation, ...adminNavigation].find(n => n.href === path)?.title ?? '自习室预约';
    return <div className="app-shell">
    <aside className="sidebar"><Link className="brand" href="/"><img className="workspace-logo-combined" src="/logo/icilxysyx.png" alt="ICIL × YSYX" /><div>工位预约<span>SPACE FOR LEARNING</span></div></Link>
      <nav>{navigation.map(n => <Link key={n.href} href={n.href} className={path === n.href ? 'active' : ''}><n.icon size={19}/>{n.title}{path === n.href && <span className="nav-dot"/>}</Link>)}</nav>
      {isOperator(user) && <><p className="nav-caption">空间管理</p><nav>{adminNavigation.map(n => <Link key={n.href} href={n.href} className={path === n.href ? 'active' : ''}><n.icon size={18}/>{n.title}</Link>)}</nav></>}
      <div className="sidebar-bottom"><div className="little-note"><Leaf size={21}/><p>好位置，好灵感。<small>让学习在这里自然发生。</small></p></div><div className="sidebar-help"><CircleHelp size={16}/>预约时间均为北京时间</div></div>
      <div className="profile">{user ? <><span className="avatar">{user.name.slice(0, 1)}</span><div>{user.name}<small>{roleNames[user.role]}</small></div><button className="text-button logout-control" title="退出登录并返回入口" aria-label="退出登录并返回入口" onClick={logout}><LogOut size={15}/>退出</button></> : <div className="profile-login"><span className="avatar">访</span><span><Link href="/login?mode=student">学员登录</Link><small><Link href="/login?mode=admin">管理员登录</Link></small></span></div>}</div>
    </aside>
    <div className="main-shell"><header className="topbar"><div className="breadcrumb">工作空间 <ChevronRight size={13}/><span>{title}</span></div><div className="topbar-right"><span className="campus"><span className="online-dot"/>空间已开放</span>{user && <NotificationBell user={user}/>}<span className="topbar-avatar">{user?.name.slice(0, 1) ?? '访'}</span><div className="mobile-account">{user ? <button className="icon-button" aria-label="退出登录" onClick={logout}><LogOut size={17}/></button> : <><Link className="button" href="/login?mode=student">学员登录</Link><Link className="button" href="/login?mode=admin">管理员登录</Link></>}</div></div></header>
      <main>{error ? <div className="error-state"><h2>暂时无法连接服务</h2><p>{error}</p><button onClick={() => window.location.reload()}>重新加载</button></div> : loading ? <div className="loading"><LoaderCircle className="spin"/>正在打开学习空间…</div> : path === '/login' || path === '/register' ? <AuthForm register={path === '/register'} onLogin={async (destination) => { await refreshUser(); router.push(destination); }}/> : admin ? isOperator(user) ? <Admin path={path} user={user!} notify={notify}/> : <Empty title="此页面需要管理员权限" description="请使用管理员账号登录。" action={<Link className="button primary" href="/login?mode=admin">管理员登录</Link>}/> : path === '/profile' ? user && !isOperator(user) ? <PersonalCenter user={user} notify={notify}/> : isOperator(user) ? <Empty title="管理员账号没有学员个人中心" description="管理员预约记录可在后台预约记录中查看。" action={<Link className="button primary" href="/admin/reservations">查看预约记录</Link>}/> : <LoginRequired/> : path === '/my-reservations' ? user && !isOperator(user) ? <MyReservations notify={notify}/> : isOperator(user) ? <Admin path="/admin/reservations" user={user!} notify={notify}/> : <LoginRequired/> : path === '/assistant/sessions' ? isOperator(user) ? <Admin path="/admin/sessions" user={user!} notify={notify}/> : <Empty title="此页面需要管理员权限" description="请使用管理员账号登录。" action={<Link className="button primary" href="/login?mode=admin">管理员登录</Link>}/> : path === '/' ? isOperator(user) ? <Admin path="/admin" user={user!} notify={notify}/> : user ? <BookingHome user={user} notify={notify}/> : <LoginChoice/> : <Empty title="页面不存在" description="返回入口，选择你的使用身份。" action={<Link className="button primary" href="/">返回入口</Link>}/>}</main>
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
function LoginRequired() { return <Empty title="你的预约，从这里开始" description="登录后即可预约工位，查看和管理学习安排。" action={<Link className="button primary" href="/login?mode=student">学员登录 <ArrowRight size={16}/></Link>}/>; }
function LoginChoice() {
    return <div className="auth-wrap login-choice"><div className="eyebrow">ICIL × YSYX · SPACE BOOKING</div><h1>先选择你的入口。</h1><p className="muted">学员预约学习工位，助教或管理员管理开放时段、布局和预约记录。</p><div className="auth-card"><Link className="button primary wide" href="/login?mode=student">学员登录 <ArrowRight size={17}/></Link><Link className="auth-switch" href="/register?mode=student">学员注册</Link><Link className="button wide" href="/login?mode=admin">助教 / 管理员登录 <ShieldCheck size={17}/></Link><Link className="auth-switch" href="/register?mode=admin">管理员注册</Link></div></div>;
}
function AuthForm({ register, onLogin }: {
    register: boolean;
    onLogin: (destination: '/' | '/admin') => Promise<void>;
}) {
    const searchParams = useSearchParams();
    const [busy, setBusy] = useState(false), [error, setError] = useState('');
    const mode = searchParams.get('mode') === 'admin' ? 'admin' : 'student';
    return <div className="auth-wrap"><div className="eyebrow">{mode === 'admin' ? 'SPACE MANAGEMENT' : 'YOUR SPACE, YOUR PACE'}</div><h1>{register ? '从一个好位置开始。' : mode === 'admin' ? '管理员登录。' : '学员登录。'}</h1><p className="muted">{register ? mode === 'admin' ? '管理员账号使用学号和管理员密钥，学员账号可以使用同一个学号。' : '学员账号使用学号和密码，管理员账号可以使用同一个学号。' : mode === 'admin' ? '使用学号和管理员密钥进入管理后台，不需要学员密码。' : '使用学号和学员密码进入预约页面；管理员请返回入口选择管理员登录。'}</p><form className="auth-card" onSubmit={async (e) => { e.preventDefault(); setBusy(true); setError(''); const data = Object.fromEntries(new FormData(e.currentTarget)); try {
        const result = await api<{ user: User }>(register ? 'auth/register' : 'auth/login', 'POST', { ...data, role: mode === 'admin' ? 'ADMIN' : 'USER' });
        if (mode === 'admin' && !isOperator(result.user)) throw new Error('该账号不是管理员账号，请使用管理员登录入口');
        await onLogin(mode === 'admin' ? '/admin' : '/');
    }
    catch (e) {
        setError((e as Error).message);
    }
    finally {
        setBusy(false);
    } }}>
    {register && <label>昵称<input name="name" placeholder="输入昵称" required maxLength={60} autoComplete="nickname"/></label>}<label>学号<input name="studentId" placeholder="输入学号" minLength={3} maxLength={30} pattern="[A-Za-z0-9]+" autoComplete="username" required/></label>{mode === 'student' && <label>密码<input type="password" name="password" placeholder={register ? '至少 10 位字符' : '输入密码'} minLength={register ? 10 : 1} maxLength={100} autoComplete={register ? 'new-password' : 'current-password'} required/></label>}{mode === 'admin' && <label>管理员密钥<input type="password" name="adminKey" placeholder="输入管理员密钥" autoComplete="off" required/></label>}{error && <p role="alert" className="form-error">{error}</p>}<button className="primary wide" disabled={busy}>{busy ? '请稍候…' : register ? mode === 'admin' ? '注册管理员账号' : '注册学员账号' : mode === 'admin' ? '进入管理员后台' : '进入学员预约'}<ArrowRight size={17}/></button><p className="auth-switch">{register ? '已经有账号？' : '还没有账号？'}<Link href={register ? `/login?mode=${mode}` : `/register?mode=${mode}`}>{register ? '立即登录' : mode === 'admin' ? '注册管理员' : '注册学员'}</Link></p></form></div>;
}
function BookingHome({ user, notify }: {
    user: User | null;
    notify: (s: string) => void;
}) {
    const [sessions, setSessions] = useState<Session[]>([]), [selectedId, setSelectedId] = useState(''), [date, setDate] = useState(''), [seat, setSeat] = useState<Seat | null>(null), [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState(''), [bookingStart, setBookingStart] = useState(''), [bookingEnd, setBookingEnd] = useState('');
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
    useEffect(() => { setSeat(null); setConfirm(false); }, [session?.id]);
    useEffect(() => {
        if (seat && !session?.layout.seats.some(s => s.id === seat.id && s.enabled)) {
            setSeat(null);
            setConfirm(false);
        }
    }, [session, seat]);
    const adminReady = !!session && (icilMember || !!session.open);
    const timeOpened = adminReady;
    const mine = session?.reservations.find(r => r.mine);
    const bookingStartsAt = mine?.startsAt ?? session?.startsAt;
    const bookingEndsAt = mine?.endsAt ?? session?.endsAt;
    const displayStartsAt = mine?.startsAt ?? (bookingStart ? shanghaiDateTimeValue(bookingStart) : session?.startsAt);
    const displayEndsAt = mine?.endsAt ?? (bookingEnd ? shanghaiDateTimeValue(bookingEnd) : session?.endsAt);
    const canCheckIn = !!mine && !!bookingStartsAt && !mine.checkedInAt && Date.now() >= new Date(bookingStartsAt).getTime() - 10 * 60_000 && Date.now() <= new Date(bookingStartsAt).getTime() + 10 * 60_000;
    const checkIn = async () => {
        if (!mine?.id || busy) return;
        setBusy(true);
        try { await api(`reservations/${mine.id}/check-in`, 'POST'); notify('打卡成功，工位已保留'); await load(); }
        catch (e) { notify((e as Error).message); }
        finally { setBusy(false); }
    };
    const chosenStart = bookingStart ? shanghaiDateTimeValue(bookingStart) : null;
    const chosenEnd = bookingEnd ? shanghaiDateTimeValue(bookingEnd) : null;
    const sessionStartField = session ? shanghaiDateTimeInput(session.startsAt) : '';
    const sessionEndField = session ? shanghaiDateTimeInput(session.endsAt) : '';
    const icilEarliestField = session ? shanghaiDateTimeInput(new Date(Math.max(new Date(session.startsAt).getTime(), Math.ceil(Date.now() / 60000) * 60000))) : '';
    const icilLatestField = session ? [sessionEndField, maxMemberBookingInput()].sort()[0] : '';
    const timeFieldMin = icilMember ? icilEarliestField : sessionStartField;
    const timeFieldMax = isOperator(user) ? sessionEndField : icilMember ? icilLatestField : maxMemberBookingInput();
    const selectedBookingBlock = !!session && !!chosenStart && !!chosenEnd && !!session.bookingBlocks?.some(block => new Date(block.startsAt) < chosenEnd && new Date(block.endsAt) > chosenStart);
    const selectedSeatOccupied = !!seat && !!chosenStart && !!chosenEnd && !!session?.reservations.some(r => r.seatId === seat.id && r.startsAt && r.endsAt && new Date(r.startsAt) < chosenEnd && new Date(r.endsAt) > chosenStart);
    useEffect(() => {
        if (selectedSeatOccupied) {
            setSeat(null);
            setConfirm(false);
        }
    }, [selectedSeatOccupied]);
    const intervalInsideSession = !!session && !!chosenStart && !!chosenEnd && chosenStart >= new Date(session.startsAt) && chosenEnd <= new Date(session.endsAt);
    const intervalValid = intervalInsideSession && !!chosenStart && !!chosenEnd && chosenStart > new Date() && chosenEnd > chosenStart;
    const intervalAllowed = !!user && !!session && (isOperator(user) || user.memberType === 'ICIL' || (!!chosenStart && !!chosenEnd && groupAllows(user.group, chosenStart, chosenEnd)));
    const ready = !!user && !!session && !session.bookingBlocked && !selectedBookingBlock && (isOperator(user) || user.memberType === 'ICIL' || (session.open && timeOpened && session.hasAdminSeat !== false)) && intervalValid && intervalAllowed && !mine;
    const canUseAssistantSeats = isOperator(user);
    const available = session ? session.layout.seats.filter(s => s.enabled && (canUseAssistantSeats || !s.fixedForAssistant) && !session.reservations.some(r => r.seatId === s.id && r.startsAt && r.endsAt && chosenStart && chosenEnd && new Date(r.startsAt) < chosenEnd && new Date(r.endsAt) > chosenStart)).length : 0;
    const assistantPresent = session?.staffPresenceWindows?.some(window => !!chosenStart && !!chosenEnd && new Date(window.startsAt) < chosenEnd && new Date(window.endsAt) > chosenStart) ?? !!session?.assistantPresent;
    const assistantStatus = assistantPresent ? '所选时间有助教在场。' : '所选时间暂无助教在场。';
    const reason = `${assistantStatus} ${!user ? '登录后即可选择心仪的座位' : selectedBookingBlock ? '管理员已禁用所选时间，无法预约' : session?.bookingBlocked ? '该日期已禁用预约' : user.memberType === 'YSYX' && !session?.open ? '此时段暂未开放预约' : user.memberType === 'YSYX' && session?.hasAdminSeat === false ? '当前时段暂无管理员工位，暂不能预约' : !timeOpened && user.memberType !== 'ICIL' ? '等待管理员或助教选定此时段' : mine ? `已为你保留 ${session?.layout.seats.find(s => s.id === mine.seatId)?.code} 号座位` : !intervalInsideSession ? (icilMember ? '预约时间必须在所选日期内' : '请选择管理员开放时间内的预约区间') : !chosenStart || chosenStart <= new Date() ? '预约开始时间必须晚于当前时间' : !chosenEnd || chosenEnd <= chosenStart ? '预约结束时间必须晚于开始时间' : !intervalAllowed ? '你的分组不允许预约此时间段' : '在平面图中选择一个心仪的位置'}`;
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
    const roleHeading = isOperator(user) ? '管理员' : user?.role === 'USER' ? '学员' : '';
    useEffect(() => { if (session) {
        if (icilMember) {
            const now = new Date();
            const rounded = new Date(Math.ceil(now.getTime() / 60000) * 60000);
            const startsAt = rounded > new Date(session.startsAt) ? rounded : new Date(session.startsAt);
            const endsAt = new Date(Math.min(startsAt.getTime() + 60 * 60000, new Date(session.endsAt).getTime()));
            setBookingStart(shanghaiDateTimeInput(startsAt));
            setBookingEnd(shanghaiDateTimeInput(endsAt));
        }
        else {
            setBookingStart(shanghaiDateTimeInput(session.startsAt));
            setBookingEnd(shanghaiDateTimeInput(session.endsAt));
        }
    } }, [session?.id, icilMember]);
    useEffect(() => { if (mine?.startsAt && mine.endsAt) { setBookingStart(shanghaiDateTimeInput(mine.startsAt)); setBookingEnd(shanghaiDateTimeInput(mine.endsAt)); } }, [mine?.id]);
    return <><div className="page-heading"><div><div className="eyebrow">A PLACE TO FOCUS</div><h1>{user ? `${roleHeading}，找到你的好位置。` : '给下一次灵感，留个位置。'}</h1><p>{icilMember ? '选择日期和任意时间，查看工位并完成预约。' : '选择日期和时间段，开启一段专注的学习时光。'}</p></div><Link className="button secondary" href="/my-reservations"><ClipboardList size={16}/>我的预约<ArrowUpRight size={15}/></Link></div>
    <div className="intro-strip"><div className="intro-icon"><Leaf size={20}/></div><span>空间为学习而开放</span><p>{icilMember ? 'ICIL成员可在今天和明天自由选择预约时间；管理员禁用的时段除外。' : '管理员先选择时段和工位，开放后学员即可预约。每人每场可预约一个工位。'}</p><span className="strip-tag">专注 · 共享 · 创造</span></div>
    <section className="date-section"><div className="section-top"><h2><CalendarDays size={19}/>选择日期<span>01 / DATE</span></h2><span className="muted small">{date ? `${date.slice(0, 4)} 年 ${Number(date.slice(5, 7))} 月` : ''}</span></div><div className="date-row"><button className="date-arrow" aria-label="前一个日期" disabled={dates.indexOf(date) <= 0} onClick={() => setDate(dates[dates.indexOf(date) - 1])}><ChevronLeft size={18}/></button><div className="date-scroll">{dates.length ? dates.map(d => <button key={d} aria-label={`选择日期 ${d}`} className={`date-item ${date === d ? 'selected' : ''}`} onClick={() => setDate(d)}><span>{new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', weekday: 'short' }).format(new Date(`${d}T12:00:00+08:00`))}</span><strong>{Number(d.slice(8))}</strong></button>) : <p className="muted">暂无开放预约日期</p>}</div><button className="date-arrow" aria-label="后一个日期" disabled={dates.indexOf(date) >= dates.length - 1} onClick={() => setDate(dates[dates.indexOf(date) + 1])}><ChevronRight size={18}/></button></div></section>
    {loading ? <div className="loading"><LoaderCircle className="spin"/>正在加载预约信息…</div> : error ? <p className="form-error" role="alert">{error}<button onClick={() => load().then(() => setError('')).catch(e => setError(e.message))}>重试</button></p> : !session ? <Empty title={icilMember ? '暂时没有可用布局' : '暂时没有开放时段'} description={icilMember ? '管理员尚未发布可预约布局，请稍后再来。' : '管理员还未开放未来预约时段，请稍后再来。'}/> : <div className="booking-grid"><div className="booking-main">{!icilMember && <section><div className="section-top"><h2><Clock3 size={19}/>选择时间段<span>02 / TIME</span></h2><span className="muted small">共 {dateSessions.length} 个时段</span></div><div className="session-cards">{dateSessions.map(s => <button key={s.id} aria-label={`选择时间段 ${formatTime(s.startsAt)} 至 ${formatTime(s.endsAt)}`} className={`session-card ${s.id === session.id ? 'selected' : ''}`} onClick={() => setSelectedId(s.id)}><p className="session-time"><Clock3 size={15}/>{formatTime(s.startsAt)} – {formatTime(s.endsAt)}</p></button>)}</div></section>}
      <section className="booking-time-select"><div className="section-top"><h2><Clock3 size={19}/>{icilMember ? '选择预约时间' : '我的预约时间'}<span>{icilMember ? '02 / TIME RANGE' : '03 / TIME RANGE'}</span></h2><span className="muted small">{icilMember ? `所选日期：${date}` : `开放范围：${formatTime(session.startsAt)} – ${formatTime(session.endsAt)}`}</span></div><div className="booking-time-fields"><label>开始<input type="datetime-local" required min={timeFieldMin} max={timeFieldMax} value={bookingStart} onChange={e => setBookingStart(e.target.value)}/></label><label>结束<input type="datetime-local" required min={bookingStart || timeFieldMin} max={timeFieldMax} value={bookingEnd} onChange={e => setBookingEnd(e.target.value)}/></label><p className="muted small">{icilMember ? 'ICIL成员可在所选日期内自由选择任意分钟的时间，不受管理员开放时段限制；管理员禁用的时段不可预约。' : '座位状态会按所选时间段检查冲突。'}</p></div></section>
      <section className="map-section"><div className="section-top"><h2><Armchair size={19}/>选择工位<span>04 / YOUR SEAT</span></h2><div className="map-legend"><span><i className="legend-available"/>可预约</span><span><i className="legend-booked"/>已预约</span><span><i className="legend-mine"/>本人 / 选中</span><span><i className="legend-disabled"/>停用 / {canUseAssistantSeats ? '助教固定工位可选' : '助教固定工位'}</span></div></div><div className="map-card"><div className="map-caption"><span><MapPin size={14}/>{venueDisplayName}</span><span>{venueDisplayName} · {session.layout.name}</span></div><div className="map-stage"><SeatMap layout={session.layout} session={session} canSelectFixed={canUseAssistantSeats} intervalStart={chosenStart ?? undefined} intervalEnd={chosenEnd ?? undefined} selected={seat?.id} disabled={!ready} onSelect={s => { setSeat(s); setConfirm(false); }}/></div><div className="map-bottom"><span className="online-dot"/><span>共 {session.layout.seats.filter(s => s.enabled && (canUseAssistantSeats || !s.fixedForAssistant)).length} 个可预约工位</span><span className="muted">·</span><strong>{available} 个可预约</strong><span className="map-auto">座位状态每 20 秒更新</span></div></div></section>
    </div><aside className="booking-aside"><div className="booking-summary"><div className="summary-title"><h2>这一次，坐这里</h2><Armchair size={21}/></div><p className="summary-subtitle">YOUR NEXT LEARNING MOMENT</p><dl className="summary-details"><div><dt><CalendarDays size={15}/>日期</dt><dd>{formatDate(displayStartsAt ?? session.startsAt)}</dd></div><div><dt><Clock3 size={15}/>时间</dt><dd>{formatTime(displayStartsAt ?? session.startsAt)} – {formatTime(displayEndsAt ?? session.endsAt)}</dd></div><div><dt><MapPin size={15}/>场地</dt><dd>{venueDisplayName}</dd></div></dl><div className={`coverage-box ${timeOpened ? '' : 'waiting'}`}><ShieldCheck size={18}/><div><strong>{icilMember ? selectedBookingBlock ? '该时段已禁用' : '全天均可预约' : timeOpened ? '时间已开放预约' : '等待选定时间'}</strong><small>{icilMember ? assistantPresent ? '所选时间有助教在场' : '可在今天和明天自由选择时间' : `${session.coverage.length} / ${session.requiredAssistants} 位助教已登记 · ${adminReady ? '管理员已选定此时间' : timeOpened ? '助教保障已就绪' : '暂未开放选座'}`}</small></div></div><div className={`chosen-seat ${seat || mine ? 'has-seat' : ''}`}><Armchair size={28} strokeWidth={1.4}/><div><small>{mine ? '你的预约座位' : seat ? '已选座位' : '尚未选择工位'}</small><strong>{mine ? session.layout.seats.find(s => s.id === mine.seatId)?.code : seat?.code ?? '等待你的选择'}</strong></div></div><p className="selection-hint">{reason}</p>{!user ? <Link className="button primary wide" href="/login">登录后预约<ArrowRight size={16}/></Link> : mine ? <div className="booking-actions"><button className="primary wide" disabled={busy || !!mine.checkedInAt || !canCheckIn} onClick={checkIn}>{mine.checkedInAt ? '已完成打卡' : canCheckIn ? '现在打卡' : '开始前后 10 分钟可打卡'}</button><button className="wide" disabled={busy || !bookingStartsAt || new Date(bookingStartsAt) <= new Date()} onClick={cancelMine}>{busy ? '正在取消…' : '取消预约'}</button></div> : <button className="primary wide" disabled={!ready || !seat} onClick={() => setConfirm(true)}>确认预约<ArrowRight size={16}/></button>}<p className="cancel-note">预约开始前可在本页取消；开始前后 10 分钟可打卡</p></div><div className="guidelines"><span className="eyebrow">A LITTLE REMINDER</span><h3>让好空间，被好好使用。</h3><p>按时到场，保持安静与整洁。<br />计划有变？记得把位置留给需要的人。</p></div></aside></div>}
    {confirm && session && seat && <Modal title={`为你留住 ${seat.code} 号工位？`} close={() => !busy && setConfirm(false)}><span className="modal-icon"><Armchair size={28}/></span><h2 id="confirm-title">为你留住 {seat.code} 号工位？</h2><p className="muted">{formatDate(bookingStart)} · {formatTime(bookingStart)} – {formatTime(bookingEnd)}</p><div className="modal-actions"><button disabled={busy} onClick={() => setConfirm(false)}>再想一下</button><button className="primary" disabled={busy || !intervalValid || selectedSeatOccupied} onClick={async () => { setBusy(true); try {
        await api('reservations', 'POST', { sessionId: session.id, seatId: seat.id, startsAt: `${bookingStart}:00+08:00`, endsAt: `${bookingEnd}:00+08:00` });
        notify(`预约成功，${seat.code} 号工位等你来`);
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
    return <><PageHeading eyebrow="YOUR ACCOUNT" title="个人中心" description="管理账号安全，查看当前与历史工位预约。"/><section className="account-identity"><span className="avatar">{user.name.slice(0, 1)}</span><div><strong>{user.name}</strong><span>学号 {user.studentId} · {user.group.name}</span></div></section><PasswordSettings notify={notify}/><MyReservations notify={notify} embedded/></>;
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
        const status = r.cancelledAt ? '已取消' : endsAt.getTime() < Date.now() ? '已结束' : startsAt.getTime() > Date.now() ? '预约成功' : r.checkedInAt ? '已打卡' : '进行中';
        return <div className="record-card" key={r.id}><div className="record-top"><span className={`badge ${isCurrent ? 'green' : ''}`}>{status}</span><span className="seat-pill"><Armchair size={15}/>{r.seat.code}</span></div><h3>自习室预约</h3><p><CalendarDays size={16}/>{formatDate(startsAt)}</p><p><Clock3 size={16}/>{formatTime(startsAt)} – {formatTime(endsAt)}</p><p><MapPin size={16}/>{r.session.layout.venue.name} · {r.session.layout.name} · {r.seat.code} 号工位</p>{r.checkedInAt && <p className="small muted">已于 {formatTime(r.checkedInAt)} 打卡</p>}{active && !r.cancelledAt && !r.checkedInAt && Date.now() >= startsAt.getTime() - 10 * 60_000 && Date.now() <= startsAt.getTime() + 10 * 60_000 && <button className="primary" disabled={busy === r.id} onClick={async () => { setBusy(r.id); try { await api(`reservations/${r.id}/check-in`, 'POST'); await load(); notify('打卡成功，工位已保留'); } catch (e) { notify((e as Error).message); } finally { setBusy(''); } }}>现在打卡</button>}{active && !r.cancelledAt && !r.checkedInAt && Date.now() < startsAt.getTime() - 10 * 60_000 && <p className="small muted">预约开始前后 10 分钟可打卡</p>}{active && !r.cancelledAt && startsAt.getTime() > Date.now() && <button disabled={busy === r.id} onClick={async () => { if (!window.confirm('确认取消此预约？座位将立即释放。')) return; setBusy(r.id); try { await api(`reservations/${r.id}`, 'DELETE'); await load(); notify('预约已取消，座位已释放'); } catch (e) { notify((e as Error).message); } finally { setBusy(''); } }}>取消预约</button>}</div>;
    })}</div> : <p className="reservation-empty">{active ? '当前没有有效预约。' : '暂无历史预约记录。'}</p>}</section>;
    return <>{heading}{error && <p role="alert" className="form-error">{error}</p>}{loading ? <p>正在加载预约记录…</p> : <div className="reservation-history">{section('当前预约', current, true)}{section('历史预约', history, false)}</div>}</>;
}
function AssistantSessions({ user, notify }: {
    user: User;
    notify: (s: string) => void;
}) {
    const minuteOptions = Array.from({ length: 1440 }, (_, i) => `${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`);
    const [sessions, setSessions] = useState<Session[]>([]), [layouts, setLayouts] = useState<Layout[]>([]), [selectedSeats, setSelectedSeats] = useState<Record<string, Seat | undefined>>({}), [error, setError] = useState(''), [busy, setBusy] = useState(''), [pick, setPick] = useState<Session | null>(null), [custom, setCustom] = useState(false), [layoutId, setLayoutId] = useState(''), [startDate, setStartDate] = useState(''), [startTime, setStartTime] = useState(''), [endDate, setEndDate] = useState(''), [endTime, setEndTime] = useState('');
    const load = useCallback(async () => { setSessions((await api<{
        sessions: Session[];
    }>('sessions')).sessions); }, []);
    useEffect(() => { load().catch(e => setError(e.message)); api<{ layouts: Layout[] }>('assistant/options').then(v => { setLayouts(v.layouts); setLayoutId(v.layouts[0]?.id ?? ''); }).catch(e => setError(e.message)); }, [load]);
    const openPicker = (s: Session) => { const a = localParts(s.startsAt), b = localParts(s.endsAt); setCustom(false); setPick(s); setStartDate(a.date); setStartTime(formatTime(s.startsAt)); setEndDate(b.date); setEndTime(formatTime(s.endsAt)); };
    const submitCoverage = async () => { setBusy(pick?.id ?? 'new'); try { await api('reservations/coverage', 'POST', custom ? { layoutId, startsAt: `${startDate}T${startTime}:00+08:00`, endsAt: `${endDate}T${endTime}:00+08:00` } : { sessionId: pick!.id, startsAt: `${startDate}T${startTime}:00+08:00`, endsAt: `${endDate}T${endTime}:00+08:00` }); await load(); setPick(null); setCustom(false); notify('自习室时段已创建，学员可以在此时间预约工位'); } catch (e) { notify((e as Error).message); } finally { setBusy(''); } };
    const reserveAssistantSeat = async (s: Session) => { const selected = selectedSeats[s.id]; if (!selected) return; setBusy(`seat-${s.id}`); try { await api('reservations', 'POST', { sessionId: s.id, seatId: selected.id }); await load(); setSelectedSeats(v => ({ ...v, [s.id]: undefined })); notify(`已预约 ${selected.code} 工位`); } catch (e) { notify((e as Error).message); } finally { setBusy(''); } };
    const cancelCoverage = async (s: Session, mine: Session['coverage'][number]) => { setBusy(s.id); try { await api(`reservations/coverage/${mine.id}`, 'DELETE'); await load(); notify('保障登记已取消'); } catch (e) { notify((e as Error).message); } finally { setBusy(''); } };
    const today = localParts(new Date()).date;
    return <><PageHeading eyebrow="SUPPORT THE LEARNING" title="助教现场保障" description="助教可滚动选择未来任意日期和分钟级时间，登记后学员按该时段预约。" action={<button className="primary" onClick={() => { const now = new Date(); const local = localParts(now); setCustom(true); setPick(null); setStartDate(local.date); setEndDate(local.date); setStartTime(formatTime(now)); setEndTime(formatTime(new Date(now.getTime() + 3600000))); }}>自由选择新时段</button>}/>{error && <p role="alert" className="form-error">{error}</p>}<div className="records-grid">{sessions.map(s => { const mine = s.coverage.find(c => c.assistantId === user.id); return <div className="record-card" key={s.id}><div className="record-top"><span className={`badge ${s.coverage.length >= s.requiredAssistants ? 'green' : 'amber'}`}>{s.coverage.length} / {s.requiredAssistants} 位助教</span><ShieldCheck size={22}/></div><h2>自习室自由时段</h2><p><CalendarDays size={16}/>{formatDate(s.startsAt)} {formatTime(s.startsAt)} – {formatTime(s.endsAt)}</p><p><MapPin size={16}/>{s.layout.venue.name}</p><div className="assistant-seat-map"><SeatMap layout={s.layout} session={s} canSelectFixed selected={selectedSeats[s.id]?.id} onSelect={seat => setSelectedSeats(v => ({ ...v, [s.id]: seat }))}/></div><p className="small muted">{s.coverage.map(c => c.assistant.name).join('、') || '尚无助教登记'} · 已预约 {s.reservations.length} 席</p><button className={mine ? '' : 'primary'} disabled={busy === s.id || (mine ? s.reservations.length > 0 : !s.open)} onClick={() => mine ? (s.reservations.length ? undefined : openPicker(s)) : openPicker(s)}>{mine ? s.reservations.length ? '已登记 · 有学员预约，不可调整' : '调整保障时间' : '选择时间并登记保障'}</button><button className="primary" disabled={!selectedSeats[s.id] || busy === `seat-${s.id}`} onClick={() => reserveAssistantSeat(s)}>预约选中工位</button>{mine && !s.reservations.length && <button disabled={busy === s.id} onClick={() => cancelCoverage(s, mine)}>取消保障登记</button>}</div>; })}</div>{(pick || custom) && <Modal title="选择现场保障时间" close={() => { setPick(null); setCustom(false); }}><form className="form-grid" onSubmit={e => { e.preventDefault(); submitCoverage(); }}><p className="muted small">可选择当前时间之后的任意分钟，登记后学员将看到并预约这个时段。</p>{custom && <><label>场地与布局<select required value={layoutId} onChange={e => setLayoutId(e.target.value)}>{layouts.map(l => <option key={l.id} value={l.id}>{l.venue.name} · {l.name}</option>)}</select></label></>}<label>日期<input type="date" required min={today} value={startDate} onChange={e => { setStartDate(e.target.value); if (endDate < e.target.value) setEndDate(e.target.value); }}/></label><label>开始时间<select required size={1} value={startTime} onChange={e => setStartTime(e.target.value)}>{minuteOptions.map(t => <option key={t} value={t}>{t}</option>)}</select></label><label>结束日期<input type="date" required min={startDate || today} value={endDate} onChange={e => setEndDate(e.target.value)}/></label><label>结束时间<select required size={1} value={endTime} onChange={e => setEndTime(e.target.value)}>{minuteOptions.map(t => <option key={t} value={t}>{t}</option>)}</select></label><div className="modal-actions"><button type="button" onClick={() => { setPick(null); setCustom(false); }}>取消</button><button className="primary" disabled={busy === (pick?.id ?? "new")}>确认登记</button></div></form></Modal>}</>;
}
export function PageHeading({ eyebrow, title, description, action }: {
    eyebrow: string;
    title: string;
    description: string;
    action?: ReactNode;
}) { return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div>{action}</div>; }
