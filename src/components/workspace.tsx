'use client';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Armchair, LayoutGrid, CalendarDays, ClipboardList, ArrowUpRight, ArrowRight, ChevronLeft, ChevronRight, Check, Clock3, MapPin, Users, ShieldCheck, LogOut, Leaf, Bell, X, LoaderCircle, BookOpen, Settings2, PanelTop, CircleHelp } from 'lucide-react';
import { api, type User, type Session, type Seat, type Reservation, type Coverage } from '@/lib/types';
import { formatDate, formatTime, localParts } from '@/lib/rules';
import SeatMap from './seat-map';
import Admin from './admin';
import Modal from './modal';
const roleNames = { USER: '普通学员', ASSISTANT: '教学助教', ADMIN: '管理员' };
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
    const navigation = [{ href: '/', icon: LayoutGrid, title: '预约工位' }, { href: '/my-reservations', icon: ClipboardList, title: '我的预约' }, ...(user?.role === 'ASSISTANT' ? [{ href: '/assistant/sessions', icon: ShieldCheck, title: '助教保障' }] : [])];
    const adminNavigation = [{ href: '/admin', icon: LayoutGrid, title: '数据概览' }, { href: '/admin/users', icon: Users, title: '用户管理' }, { href: '/admin/groups', icon: ShieldCheck, title: '分组与权限' }, { href: '/admin/layouts', icon: PanelTop, title: '场地与布局' }, { href: '/admin/courses', icon: BookOpen, title: '课程管理' }, { href: '/admin/sessions', icon: CalendarDays, title: '场次管理' }, { href: '/admin/reservations', icon: ClipboardList, title: '预约记录' }, { href: '/admin/logs', icon: Settings2, title: '操作日志' }];
    const title = [...navigation, ...adminNavigation].find(n => n.href === path)?.title ?? '教学空间';
    return <div className="app-shell">
    <aside className="sidebar"><Link className="brand" href="/"><span className="brand-icon"><Armchair size={25} strokeWidth={1.7}/></span><div>工位<span>SPACE FOR LEARNING</span></div></Link>
      <div className="workspace-label"><span className="workspace-mark">教</span><div>教学实践中心<small>共享空间 · 一起创造</small></div><span className="online-dot"/></div>
      <p className="nav-caption">学习空间</p><nav>{navigation.map(n => <Link key={n.href} href={n.href} className={path === n.href ? 'active' : ''}><n.icon size={19}/>{n.title}{path === n.href && <span className="nav-dot"/>}</Link>)}</nav>
      {user?.role === 'ADMIN' && <><p className="nav-caption">空间管理</p><nav>{adminNavigation.map(n => <Link key={n.href} href={n.href} className={path === n.href ? 'active' : ''}><n.icon size={18}/>{n.title}</Link>)}</nav></>}
      <div className="sidebar-bottom"><div className="little-note"><Leaf size={21}/><p>好位置，好灵感。<small>让学习在这里自然发生。</small></p></div><div className="sidebar-help"><CircleHelp size={16}/>预约时间均为北京时间</div></div>
      <div className="profile">{user ? <><span className="avatar">{user.name.slice(0, 1)}</span><div>{user.name}<small>{roleNames[user.role]}</small></div><button className="icon-button" aria-label="退出登录" onClick={logout}><LogOut size={17}/></button></> : <Link href="/login" className="profile-login"><span className="avatar">访</span>登录你的学习空间 <ArrowRight size={17}/></Link>}</div>
    </aside>
    <div className="main-shell"><header className="topbar"><div className="breadcrumb">工作空间 <ChevronRight size={13}/><span>{title}</span></div><div className="topbar-right"><span className="campus"><span className="online-dot"/>空间已开放</span><button className="icon-button" aria-label="预约须知" onClick={() => notify('预约须在课程开始前取消。助教保障达标后开放选座，每人每场限一个座位。')}><Bell size={19}/></button><span className="topbar-avatar">{user?.name.slice(0, 1) ?? '访'}</span><div className="mobile-account">{user ? <button className="icon-button" aria-label="退出登录" onClick={logout}><LogOut size={17}/></button> : <Link className="button" href="/login">登录</Link>}</div></div></header>
      <main>{error ? <div className="error-state"><h2>暂时无法连接服务</h2><p>{error}</p><button onClick={() => window.location.reload()}>重新加载</button></div> : loading ? <div className="loading"><LoaderCircle className="spin"/>正在打开学习空间…</div> : path === '/login' || path === '/register' ? <AuthForm register={path === '/register'} onLogin={async () => { await refreshUser(); router.push('/'); }}/> : admin ? user?.role === 'ADMIN' ? <Admin path={path} user={user} notify={notify}/> : <Empty title="此页面需要管理员权限" description="请使用管理员账号登录。" action={<Link className="button primary" href="/login">前往登录</Link>}/> : path === '/my-reservations' ? user ? <MyReservations notify={notify}/> : <LoginRequired /> : path === '/assistant/sessions' ? user?.role === 'ASSISTANT' ? <AssistantSessions user={user} notify={notify}/> : <Empty title="此页面需要助教权限" description="请联系管理员设置助教角色。"/> : path === '/' ? <BookingHome user={user} notify={notify}/> : <Empty title="页面不存在" description="返回空间，找到你的下一个好位置。" action={<Link className="button primary" href="/">返回首页</Link>}/>}</main>
      <footer><span>工位 · 为专注与创造留一个位置</span><span>教学实践中心 <span className="footer-dot">·</span> Asia / Shanghai</span></footer>
    </div>{notice && <div role="status" className="toast"><Check size={18}/>{notice}<button aria-label="关闭提示" onClick={() => setNotice('')}><X size={16}/></button></div>}
  </div>;
}
export function Empty({ title, description, action }: {
    title: string;
    description: string;
    action?: ReactNode;
}) { return <div className="empty-state"><Armchair size={40} strokeWidth={1}/><h2>{title}</h2><p>{description}</p>{action}</div>; }
function LoginRequired() { return <Empty title="你的预约，从这里开始" description="登录后即可预约工位，查看和管理学习安排。" action={<Link className="button primary" href="/login">登录账号 <ArrowRight size={16}/></Link>}/>; }
function AuthForm({ register, onLogin }: {
    register: boolean;
    onLogin: () => Promise<void>;
}) {
    const [busy, setBusy] = useState(false), [error, setError] = useState('');
    return <div className="auth-wrap"><div className="eyebrow">YOUR SPACE, YOUR PACE</div><h1>{register ? '从一个好位置开始。' : '欢迎回到学习空间。'}</h1><p className="muted">{register ? '创建账号，开启你的下一次探索。' : '登录账号，让专注与灵感在这里相遇。'}</p><form className="auth-card" onSubmit={async (e) => { e.preventDefault(); setBusy(true); setError(''); const data = Object.fromEntries(new FormData(e.currentTarget)); try {
        await api(register ? 'auth/register' : 'auth/login', 'POST', data);
        await onLogin();
    }
    catch (e) {
        setError((e as Error).message);
    }
    finally {
        setBusy(false);
    } }}>
    {register && <label>姓名<input name="name" placeholder="你的姓名" required maxLength={60} autoComplete="name"/></label>}<label>邮箱<input type="email" name="email" placeholder="name@example.com" autoComplete="email" required/></label><label>密码<input type="password" name="password" placeholder={register ? '至少 10 位字符' : '输入密码'} minLength={register ? 10 : 1} maxLength={100} autoComplete={register ? 'new-password' : 'current-password'} required/></label>{error && <p role="alert" className="form-error">{error}</p>}<button className="primary wide" disabled={busy}>{busy ? '请稍候…' : register ? '创建账号' : '登录空间'}<ArrowRight size={17}/></button><p className="auth-switch">{register ? '已经有账号？' : '还没有账号？'}<Link href={register ? '/login' : '/register'}>{register ? '立即登录' : '注册账号'}</Link></p></form></div>;
}
function BookingHome({ user, notify }: {
    user: User | null;
    notify: (s: string) => void;
}) {
    const [sessions, setSessions] = useState<Session[]>([]), [selectedId, setSelectedId] = useState(''), [date, setDate] = useState(''), [seat, setSeat] = useState<Seat | null>(null), [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState('');
    const load = useCallback(async () => { const data = await api<{
        sessions: Session[];
    }>('sessions'); setSessions(data.sessions); setSelectedId(prev => prev || data.sessions[0]?.id || ''); setDate(prev => prev || (data.sessions[0] ? localParts(data.sessions[0].startsAt).date : localParts(new Date()).date)); }, []);
    useEffect(() => { load().catch(e => setError(e.message)).finally(() => setLoading(false)); }, [load, user]);
    useEffect(() => { const interval = setInterval(() => load().catch(() => { }), 20000); return () => clearInterval(interval); }, [load]);
    const dates = [...new Set(sessions.map(s => localParts(s.startsAt).date))];
    const dateSessions = sessions.filter(s => localParts(s.startsAt).date === date);
    const session = dateSessions.find(s => s.id === selectedId) ?? dateSessions[0];
    useEffect(() => { setSeat(null); setConfirm(false); }, [session?.id]);
    useEffect(() => {
        if (seat && (!session?.layout.seats.some(s => s.id === seat.id && s.enabled) || session.reservations.some(r => r.seatId === seat.id))) {
            setSeat(null);
            setConfirm(false);
        }
    }, [session, seat]);
    const coverageReady = !!session && session.coverage.length >= session.requiredAssistants;
    const mine = session?.reservations.find(r => r.mine);
    const ready = !!user && !!session && session.open && coverageReady && session.allowed && !mine && new Date(session.startsAt) > new Date();
    const available = session ? session.layout.seats.filter(s => s.enabled && !session.reservations.some(r => r.seatId === s.id)).length : 0;
    const reason = !user ? '登录后即可选择心仪的座位' : !session?.open ? '此场次暂未开放预约' : new Date(session.startsAt) <= new Date() ? '此场次已开始，无法预约' : !coverageReady ? '等待助教完成现场保障登记' : !session?.allowed ? '你的分组暂不允许预约此时段' : mine ? `已为你保留 ${session?.layout.seats.find(s => s.id === mine.seatId)?.code} 号座位` : '在平面图中选择一个心仪的位置';
    return <><div className="page-heading"><div><div className="eyebrow">A PLACE TO FOCUS</div><h1>{user ? `${user.name}，找到你的好位置。` : '给下一次灵感，留个位置。'}<span className="heading-spark">✳</span></h1><p>选择一堂课程，一个工位，开启一段专注的学习时光。</p></div><Link className="button secondary" href="/my-reservations"><ClipboardList size={16}/>我的预约<ArrowUpRight size={15}/></Link></div>
    <div className="intro-strip"><div className="intro-icon"><Leaf size={20}/></div><span>空间为学习而开放</span><p>先有助教保障，再安心入座。每人每场可预约一个工位。</p><span className="strip-tag">专注 · 共享 · 创造</span></div>
    <section className="date-section"><div className="section-top"><h2><CalendarDays size={19}/>选择日期<span>01 / DATE</span></h2><span className="muted small">{date ? `${date.slice(0, 4)} 年 ${Number(date.slice(5, 7))} 月` : ''}</span></div><div className="date-row"><button className="date-arrow" aria-label="前一个日期" disabled={dates.indexOf(date) <= 0} onClick={() => setDate(dates[dates.indexOf(date) - 1])}><ChevronLeft size={18}/></button><div className="date-scroll">{dates.length ? dates.map(d => <button key={d} aria-label={`选择日期 ${d}`} className={`date-item ${date === d ? 'selected' : ''}`} onClick={() => setDate(d)}><span>{d === localParts(new Date()).date ? '今天' : new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', weekday: 'short' }).format(new Date(`${d}T12:00:00+08:00`))}</span><strong>{Number(d.slice(8))}</strong><small>{sessions.filter(s => localParts(s.startsAt).date === d).length} 场课程</small></button>) : <p className="muted">暂无已安排的课程日期</p>}</div><button className="date-arrow" aria-label="后一个日期" disabled={dates.indexOf(date) >= dates.length - 1} onClick={() => setDate(dates[dates.indexOf(date) + 1])}><ChevronRight size={18}/></button></div></section>
    {loading ? <div className="loading"><LoaderCircle className="spin"/>正在加载课程…</div> : error ? <p className="form-error" role="alert">{error}<button onClick={() => load().then(() => setError('')).catch(e => setError(e.message))}>重试</button></p> : !session ? <Empty title="期待下一次相聚" description="管理员还未安排此日期的课程场次，请稍后再来。"/> : <div className="booking-grid"><div className="booking-main"><section><div className="section-top"><h2><BookOpen size={19}/>选择课程<span>02 / SESSION</span></h2><span className="muted small">共 {dateSessions.length} 场</span></div><div className="session-cards">{dateSessions.map(s => <button key={s.id} className={`session-card ${s.id === session.id ? 'selected' : ''}`} onClick={() => setSelectedId(s.id)}><div className="session-card-top"><span className={`badge ${s.open && s.coverage.length >= s.requiredAssistants ? 'green' : 'amber'}`}>{!s.open ? '暂未开放' : s.coverage.length >= s.requiredAssistants ? '开放预约' : '等待助教'}</span><span className="radio">{s.id === session.id && <Check size={12}/>}</span></div><h3>{s.course.name}</h3><p><Clock3 size={13}/>{formatTime(s.startsAt)} – {formatTime(s.endsAt)}</p><div className="session-card-bottom"><span>{s.course.instructor} · 指导教师</span><span>{s.layout.seats.filter(seat => seat.enabled).length - s.reservations.length} 席可约</span></div></button>)}</div></section>
      <section className="map-section"><div className="section-top"><h2><Armchair size={19}/>选择工位<span>03 / YOUR SEAT</span></h2><div className="map-legend"><span><i className="legend-available"/>可预约</span><span><i className="legend-booked"/>已预约</span><span><i className="legend-mine"/>本人 / 选中</span><span><i className="legend-disabled"/>停用</span></div></div><div className="map-card"><div className="map-caption"><span><MapPin size={14}/>{session.layout.venue.name}</span><span>{session.layout.venue.location} · {session.layout.name}</span></div><div className="map-stage"><SeatMap layout={session.layout} session={session} selected={seat?.id} disabled={!ready} onSelect={s => { setSeat(s); setConfirm(false); }}/></div><div className="map-bottom"><span className="online-dot"/><span>共 {session.layout.seats.filter(s => s.enabled).length} 个工位</span><span className="muted">·</span><strong>{available} 个可预约</strong><span className="map-auto">座位状态每 20 秒更新</span></div></div></section>
    </div><aside className="booking-aside"><div className="booking-summary"><div className="summary-title"><h2>这一次，坐这里</h2><Armchair size={21}/></div><p className="summary-subtitle">YOUR NEXT LEARNING MOMENT</p><div className="summary-course"><span className="course-icon"><BookOpen size={22}/></span><div><h3>{session.course.name}</h3><small>{session.course.instructor} · 指导教师</small></div></div><dl className="summary-details"><div><dt><CalendarDays size={15}/>日期</dt><dd>{formatDate(session.startsAt)}</dd></div><div><dt><Clock3 size={15}/>时间</dt><dd>{formatTime(session.startsAt)} – {formatTime(session.endsAt)}</dd></div><div><dt><MapPin size={15}/>场地</dt><dd>{session.layout.venue.name}</dd></div></dl><div className={`coverage-box ${coverageReady ? '' : 'waiting'}`}><ShieldCheck size={18}/><div><strong>{coverageReady ? '助教保障已就绪' : '助教保障待就绪'}</strong><small>{session.coverage.length} / {session.requiredAssistants} 位助教已登记 · {coverageReady ? '安心预约' : '暂未开放选座'}</small></div></div><div className={`chosen-seat ${seat || mine ? 'has-seat' : ''}`}><Armchair size={28} strokeWidth={1.4}/><div><small>{mine ? '你的预约座位' : seat ? '已选座位' : '尚未选择工位'}</small><strong>{mine ? session.layout.seats.find(s => s.id === mine.seatId)?.code : seat?.code ?? '等待你的选择'}</strong></div></div><p className="selection-hint">{reason}</p>{!user ? <Link className="button primary wide" href="/login">登录后预约<ArrowRight size={16}/></Link> : mine ? <Link className="button primary wide" href="/my-reservations">查看我的预约<ArrowRight size={16}/></Link> : <button className="primary wide" disabled={!ready || !seat} onClick={() => setConfirm(true)}>确认预约<ArrowRight size={16}/></button>}<p className="cancel-note">课程开始前可随时取消预约</p></div><div className="guidelines"><span className="eyebrow">A LITTLE REMINDER</span><h3>让好空间，被好好使用。</h3><p>按时到场，保持安静与整洁。<br />计划有变？记得把位置留给需要的人。</p><span className="guideline-flower">✳</span></div></aside></div>}
    {confirm && session && seat && <Modal title={`为你留住 ${seat.code} 号工位？`} close={() => !busy && setConfirm(false)}><span className="modal-icon"><Armchair size={28}/></span><h2 id="confirm-title">为你留住 {seat.code} 号工位？</h2><p>{session.course.name}</p><p className="muted">{formatDate(session.startsAt)} · {formatTime(session.startsAt)} – {formatTime(session.endsAt)}</p><div className="modal-actions"><button disabled={busy} onClick={() => setConfirm(false)}>再想一下</button><button className="primary" disabled={busy} onClick={async () => { setBusy(true); try {
        await api('reservations', 'POST', { sessionId: session.id, seatId: seat.id });
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
function MyReservations({ notify }: {
    notify: (s: string) => void;
}) {
    const [records, setRecords] = useState<Reservation[]>([]), [error, setError] = useState(''), [loading, setLoading] = useState(true), [busy, setBusy] = useState('');
    const load = useCallback(async () => { const data = await api<{
        reservations: Reservation[];
    }>('reservations'); setRecords(data.reservations); }, []);
    useEffect(() => { load().catch(e => setError(e.message)).finally(() => setLoading(false)); }, [load]);
    return <><PageHeading eyebrow="YOUR LEARNING JOURNEY" title="我的预约" description="把时间留给热爱，把位置留给专注。"/>{error && <p role="alert" className="form-error">{error}</p>}{loading ? <p>正在加载…</p> : records.length ? <div className="records-grid">{records.map(r => <div className="record-card" key={r.id}><div className="record-top"><span className={`badge ${r.cancelledAt ? '' : new Date(r.session.endsAt) < new Date() ? '' : 'green'}`}>{r.cancelledAt ? '已取消' : new Date(r.session.endsAt) < new Date() ? '已结束' : '预约成功'}</span><span className="seat-pill"><Armchair size={15}/>{r.seat.code}</span></div><h2>{r.session.course.name}</h2><p><CalendarDays size={16}/>{formatDate(r.session.startsAt)}</p><p><Clock3 size={16}/>{formatTime(r.session.startsAt)} – {formatTime(r.session.endsAt)}</p><p><MapPin size={16}/>{r.session.layout.venue.name}</p>{!r.cancelledAt && new Date(r.session.startsAt) > new Date() && <button disabled={busy === r.id} onClick={async () => { if (!window.confirm('确认取消此预约？座位将立即释放。'))
        return; setBusy(r.id); try {
        await api(`reservations/${r.id}`, 'DELETE');
        await load();
        notify('预约已取消，座位已释放');
    }
    catch (e) {
        notify((e as Error).message);
    }
    finally {
        setBusy('');
    } }}>取消预约</button>}</div>)}</div> : <Empty title="还没有预约记录" description="选一堂感兴趣的课程，为自己留一个好位置。" action={<Link className="button primary" href="/">去预约工位<ArrowRight size={16}/></Link>}/>}</>;
}
function AssistantSessions({ user, notify }: {
    user: User;
    notify: (s: string) => void;
}) {
    const [sessions, setSessions] = useState<Session[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState('');
    const load = useCallback(async () => { setSessions((await api<{
        sessions: Session[];
    }>('sessions')).sessions); }, []);
    useEffect(() => { load().catch(e => setError(e.message)); }, [load]);
    return <><PageHeading eyebrow="SUPPORT THE LEARNING" title="助教现场保障" description="先一步准备，让每一位学员安心入座。保障登记不占用工位。"/>{error && <p role="alert" className="form-error">{error}</p>}<div className="records-grid">{sessions.map(s => { const mine = s.coverage.find(c => c.assistantId === user.id); return <div className="record-card" key={s.id}><div className="record-top"><span className={`badge ${s.coverage.length >= s.requiredAssistants ? 'green' : 'amber'}`}>{s.coverage.length} / {s.requiredAssistants} 位助教</span><ShieldCheck size={22}/></div><h2>{s.course.name}</h2><p><CalendarDays size={16}/>{formatDate(s.startsAt)} {formatTime(s.startsAt)} – {formatTime(s.endsAt)}</p><p><MapPin size={16}/>{s.layout.venue.name}</p><p className="small muted">{s.coverage.map(c => c.assistant.name).join('、') || '尚无助教登记'} · 已预约 {s.reservations.length} 席</p><button className={mine ? '' : 'primary'} disabled={busy === s.id || new Date(s.startsAt) <= new Date() || (mine ? s.reservations.length > 0 : !s.open)} onClick={async () => { setBusy(s.id); try {
        await api(mine ? `reservations/coverage/${mine.id}` : 'reservations/coverage', mine ? 'DELETE' : 'POST', mine ? undefined : { sessionId: s.id });
        await load();
        notify(mine ? '保障登记已取消' : '现场保障登记成功');
    }
    catch (e) {
        notify((e as Error).message);
    }
    finally {
        setBusy('');
    } }}>{mine ? s.reservations.length ? '已登记 · 有学员预约，不可取消' : '取消保障登记' : '登记现场保障'}</button></div>; })}</div></>;
}
export function PageHeading({ eyebrow, title, description, action }: {
    eyebrow: string;
    title: string;
    description: string;
    action?: ReactNode;
}) { return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}<span className="heading-spark">✳</span></h1><p>{description}</p></div>{action}</div>; }
