import { Component, useEffect, useState, type ReactNode } from 'react';
import { Link, Navigate, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useMe, useConfig, post, get, patch, qc, ApiError, clearOfflineCache } from './api';
import { useOffline } from './offline';
import { Avatar, Icon, NoAccess, ToastHost, useScrollLock, useOnline, PageSearchCtx, PageSearchBox, revealTheme } from './ui';
import { CommandPalette, createActions } from './palette';
import { NewBooking } from './pages/Booking';
import { settingsTopic } from './pages/Settings';
import { refreshBookings } from './apptDrawer';
import { PrintHost } from './printPreview';
import { FirstPassword } from './firstPassword';
import { ViewerHost } from './viewer';

export function can(perms: string[] | undefined, needed: string) {
  return !!perms?.some((p) => p === '*' || p === needed || (p.endsWith('.*') && needed.startsWith(p.slice(0, -1))));
}

export type NavItem = { to: string; label: string; icon: string; show: (c: (p: string) => boolean) => boolean };
export const NAV: NavItem[] = [
  { to: '/clinic', label: 'Clinic', icon: 'home', show: (c) => c('finance.read') },
  { to: '/accounts', label: 'Accounts', icon: 'wallet', show: (c) => c('finance.read') },
  { to: '/dashboard', label: 'Dashboard', icon: 'chart', show: (c) => c('report.read') || c('finance.read') },
  { to: '/today', label: 'Today', icon: 'stetho', show: (c) => c('encounter.complete') },
  { to: '/queue', label: 'Front desk', icon: 'queue', show: (c) => c('visit.write') || (c('encounter.intake') && !c('encounter.complete')) },
  { to: '/appointments', label: 'Appointments', icon: 'calendar', show: (c) => c('appointment.read') },
  { to: '/patients', label: 'Patients', icon: 'users', show: (c) => c('patient.read') },
  { to: '/worklist', label: 'Procedures', icon: 'clock', show: (c) => c('worklist.read') },
  { to: '/calls', label: 'Calls', icon: 'phone', show: (c) => c('worklist.read') },
  { to: '/tests', label: 'Test reports', icon: 'inbox', show: (c) => c('worklist.read') || c('encounter.complete') },
  { to: '/pharmacy', label: 'Pharmacy', icon: 'pill', show: (c) => c('pharmacy.read') },
  { to: '/inventory', label: 'Inventory', icon: 'inbox', show: (c) => c('stock.read') },
  { to: '/reports', label: 'Reports', icon: 'chart', show: (c) => c('report.daily') || c('finance.read') },
  { to: '/expenses', label: 'Expenses', icon: 'wallet', show: (c) => c('expense.read') && !c('finance.read') }, // the owner has them in Accounts › Spending
  { to: '/settings', label: 'Settings', icon: 'gear', show: (c) => c('config.write') },
  { to: '/audit', label: 'Audit log', icon: 'lock', show: (c) => c('user.write') },
  { to: '/platform', label: 'Clinics', icon: 'home', show: (c) => c('platform.read') },
];

/** How someone is working right now. Each way has at most five menu items (audit 5.4) and its own home page; the rest of what they may open sits under More. */
export type Mode = 'owner' | 'doctor' | 'desk' | 'junior' | 'coordinator' | 'pharmacy';
const MODE_LABEL: Record<Mode, string> = { owner: 'Owner', doctor: 'Doctor', desk: 'Desk', junior: 'Junior doctor', coordinator: 'Procedures', pharmacy: 'Pharmacy' };
const MENU: Record<Mode, string[]> = {
  owner: ['/clinic', '/accounts', '/dashboard', '/settings', '/audit'],
  doctor: ['/today', '/appointments', '/patients', '/tests', '/worklist'],
  desk: ['/queue', '/appointments', '/patients', '/calls', '/reports'],
  junior: ['/queue', '/patients'],
  coordinator: ['/worklist', '/calls', '/appointments', '/patients', '/tests'],
  pharmacy: ['/pharmacy', '/inventory', '/patients'],
};
const MODE_HOME: Record<Mode, string> = { owner: '/clinic', doctor: '/today', desk: '/queue', junior: '/queue', coordinator: '/worklist', pharmacy: '/pharmacy' };
const ROLE_MODE: Record<string, Mode> = { owner: 'owner', admin: 'owner', doctor: 'doctor', receptionist: 'desk', assistant: 'junior', coordinator: 'coordinator', pharmacist: 'pharmacy' };

/** The ways this person can work: one per role. An owner or admin can also work the desk, and as a doctor when they see patients. */
export function modesOf(me: any): Mode[] {
  const roles: string[] = me?.roles?.length ? me.roles : me?.role ? [me.role] : [];
  const ms = new Set<Mode>(roles.map((r) => ROLE_MODE[r]).filter(Boolean));
  if (ms.has('owner')) { if (me.practitionerId) ms.add('doctor'); ms.add('desk'); }
  return (Object.keys(MODE_LABEL) as Mode[]).filter((m) => ms.has(m));
}
const wkKey = (me: any) => `workingAs:${me?.userId ?? ''}`;
/** "Working as", kept per computer. An owner who sees patients starts as Doctor; one who does not, as Owner. */
export function useWorkingAs(me: any) {
  const [, bump] = useState(0);
  const modes = modesOf(me);
  let stored: string | null = null; try { stored = localStorage.getItem(wkKey(me)); } catch { /* private mode */ }
  const mode: Mode | null = modes.includes(stored as Mode) ? (stored as Mode) : modes.includes('doctor') ? 'doctor' : modes[0] ?? null;
  const set = (m: Mode) => { try { localStorage.setItem(wkKey(me), m); } catch { /* private mode */ } bump((n) => n + 1); };
  return { mode, modes, set, owner: modes.includes('owner'), switchable: modes.includes('owner') && modes.length > 1 };
}
/** This mode's menu first (five at most); everything else this person may open goes under More. */
export function splitNav(items: NavItem[], modes: Mode[], mode: Mode | null) {
  const want = mode && modes.includes('owner') ? MENU[mode] : [...new Set(modes.flatMap((m) => MENU[m]))];
  const main = (want.length ? want.map((to) => items.find((n) => n.to === to)).filter((n): n is NavItem => !!n) : items).slice(0, 5);
  return { main, more: items.filter((n) => !main.includes(n)) };
}

/** Where each role lands: the page that answers their first question of the day. An owner or admin lands on the home of the way they are working. */
export function homeFor(c: (p: string) => boolean, platform = false, ownerMode: Mode | null = null) {
  if (platform) return '/platform';
  if (ownerMode) return MODE_HOME[ownerMode];
  if (c('encounter.complete')) return '/today';
  if (c('visit.write')) return '/queue';
  if (c('encounter.intake')) return '/queue';
  if (c('worklist.write')) return '/worklist';
  if (c('expense.read')) return '/expenses';
  if (c('pharmacy.read')) return '/pharmacy';
  return '/patients';
}

export function Home() {
  const me = useMe(); const wk = useWorkingAs(me.data);
  if (me.isLoading) return null;
  const c = (p: string) => can(me.data?.perms, p);
  return <Navigate to={homeFor(c, me.data?.tenantKind === 'platform', wk.owner ? wk.mode : null)} replace />;
}

/** Left navigation: a quiet rail with counts; the active item is one filled row. */
/** Light or dark for this person, kept on this device. The print sheet and the waiting-room TV ignore it. */
export function useTheme() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => { try { return (localStorage.getItem('theme') as 'light' | 'dark') || 'light'; } catch { return 'light'; } });
  useEffect(() => { document.documentElement.dataset.theme = theme; try { localStorage.setItem('theme', theme); } catch { /* private mode */ } }, [theme]);
  return [theme, () => setTheme((t) => (t === 'light' ? 'dark' : 'light'))] as const;
}

/** Open (icons with names, the default) or collapsed to an icon rail, kept on this device. */
/** Role names as people say them; a custom role shows its own name from Settings. */
const ROLE_LABEL: Record<string, string> = { owner: 'Owner', admin: 'Admin', doctor: 'Doctor', assistant: 'Junior doctor', receptionist: 'Reception', coordinator: 'Coordinator', pharmacist: 'Pharmacy' };
const roleLabel = (r: string) => ROLE_LABEL[r] ?? r.replace(/_/g, ' ');

export function useNav() {
  const [open, setOpen] = useState(() => { try { return localStorage.getItem('nav') !== 'rail'; } catch { return true; } });
  useEffect(() => { try { localStorage.setItem('nav', open ? 'open' : 'rail'); } catch { /* private mode */ } }, [open]);
  return [open, () => setOpen((o) => !o)] as const;
}

/** The collapsed rail: one icon per section with its name in a tooltip, for people who know the icons and want the width. */
function Rail({ items, more, active, clinic, me, onSignOut, onExpand }: { items: NavItem[]; more: NavItem[]; active: NavItem | null; clinic: string; me: any; onSignOut: () => void; onExpand: () => void }) {
  return (
    <div className="flex h-full flex-col items-center px-3 pb-3.5 pt-4">
      <Link to="/" title={clinic} className="mb-2 grid h-[38px] w-[38px] place-items-center rounded-[12px] bg-brand text-[16px] font-bold" style={{ color: 'var(--color-paper)' }}>{clinic.slice(0, 1)}</Link>
      <button type="button" onClick={onExpand} aria-label="Show menu names" data-tip="Show menu names" className="tip rail-item mb-2 !h-8"><Icon name="chevR" className="h-4 w-4" /></button>
      <nav className="flex w-full flex-col items-center gap-1 overflow-y-auto no-scrollbar" aria-label="Sections">
        {[...items, ...more].map((n, i) => <span key={n.to} className="contents">
          {i === items.length && i > 0 && <span className="my-1.5 w-6 border-t border-line-2" aria-label="More" />}
          <Link to={n.to} viewTransition aria-current={active?.to === n.to ? 'page' : undefined} aria-label={n.label} data-tip={n.label} className={`tip rail-item ${active?.to === n.to ? 'active' : ''}`}>
            <Icon name={n.icon} className="h-[18px] w-[18px]" />
          </Link></span>)}
      </nav>
      <Link to="/help" aria-label="Help" data-tip="Help" className="tip rail-item mt-auto"><Icon name="help" className="h-[18px] w-[18px]" /></Link>
      <div className="relative mt-2 flex flex-col items-center gap-2 pt-1">
        <span className="relative"><Avatar name={me.name} size="h-9 w-9 text-[12px]" /><span className="absolute -bottom-px -right-px h-2.5 w-2.5 rounded-full bg-sage" style={{ boxShadow: '0 0 0 2px var(--color-paper)' }} /></span>
        <button onClick={onSignOut} aria-label="Sign out" data-tip="Sign out" className="tip rail-item !h-9"><Icon name="logout" className="h-4 w-4" /></button>
      </div>
    </div>
  );
}

function Sidebar({ items, more, active, clinic, me, roles, wk, onWork, onSignOut, onNavigate, onCollapse }: { items: NavItem[]; more: NavItem[]; active: NavItem | null; clinic: string; me: any; roles: string[]; wk: ReturnType<typeof useWorkingAs>; onWork: (m: Mode) => void; onSignOut: () => void; onNavigate?: () => void; onCollapse?: () => void }) {
  const link = (n: NavItem) => (
    <Link key={n.to} to={n.to} viewTransition onClick={onNavigate} aria-current={active?.to === n.to ? 'page' : undefined} className={`nav-item ${active?.to === n.to ? 'active' : ''}`}>
      <Icon name={n.icon} className="h-4 w-4 shrink-0" /><span className="flex-1 truncate">{n.label}</span>
    </Link>
  );
  const moreActive = more.some((n) => n === active);
  const [showMore, setShowMore] = useState(moreActive);
  return (
    <div className="flex h-full flex-col px-2.5 py-3">
      <div className="flex items-center gap-1 pb-3 pt-1">
        <Link to="/" onClick={onNavigate} className="flex min-w-0 flex-1 items-center gap-2.5 px-2"><span className="grid h-7 w-7 shrink-0 place-items-center rounded-[7px] bg-brand text-[13px] font-bold text-white" style={{ fontFamily: 'Urbanist, Inter, sans-serif' }}>{clinic.slice(0, 1)}</span><span className="truncate text-[13px] font-semibold leading-tight">{clinic}</span></Link>
        {onCollapse && <button type="button" onClick={onCollapse} aria-label="Collapse menu to icons" title="Collapse menu" className="btn btn-ghost btn-icon !h-8 !w-8 shrink-0"><Icon name="chevL" className="h-4 w-4" /></button>}
      </div>
      {wk.switchable && wk.mode && <div className="mb-3 px-1" role="radiogroup" aria-label="Working as">
        <div className="px-1.5 pb-1.5 text-[11px] font-semibold text-muted">Working as</div>
        <div className="flex flex-wrap gap-1">{wk.modes.map((m) => <button key={m} type="button" role="radio" aria-checked={wk.mode === m} className={`toggle-opt ${wk.mode === m ? 'on' : ''}`} onClick={() => onWork(m)}>{MODE_LABEL[m]}</button>)}</div>
      </div>}
      <nav className="flex flex-col gap-px overflow-y-auto no-scrollbar" aria-label="Sections">
        {items.map(link)}
        {more.length > 0 && <button type="button" className="nav-item mt-2 text-muted" aria-expanded={showMore || moreActive} onClick={() => setShowMore((o) => !o)}><Icon name="dots" className="h-4 w-4 shrink-0" /><span className="flex-1 text-left">More</span><Icon name="chevR" className={`h-3.5 w-3.5 transition-transform ${showMore || moreActive ? 'rotate-90' : ''}`} /></button>}
        {(showMore || moreActive) && more.map(link)}
      </nav>
      <Link to="/help" onClick={onNavigate} className="nav-item mt-auto"><Icon name="help" className="h-4 w-4" /><span>Help</span></Link>
      <div className="mt-1.5 flex items-center gap-2.5 border-t border-line px-2 pt-3">
        <Avatar name={me.name} size="h-7 w-7 text-[11px]" />
        <div className="min-w-0 flex-1"><div className="truncate text-[12.5px] font-semibold">{me.name}</div><div className="truncate text-[11px] text-muted">{roles.map(roleLabel).join(' · ')}</div></div>
        <button onClick={onSignOut} aria-label="Sign out" data-tip="Sign out" className="tip btn btn-ghost btn-icon !h-8 !w-8"><Icon name="logout" /></button>
      </div>
    </div>
  );
}

/** One broken page shows a message and keeps the menu, instead of blanking the whole app. Moving to another page clears it. */
class PageError extends Component<{ children: ReactNode }, { err: boolean }> {
  state = { err: false };
  static getDerivedStateFromError() { return { err: true }; }
  componentDidCatch(e: unknown) { console.error(e); }
  render() {
    if (!this.state.err) return this.props.children;
    return <div className="card mx-auto mt-10 max-w-md space-y-3 text-center" role="alert"><div className="font-semibold">Something went wrong on this page.</div><div className="text-sm text-muted">Nothing you saved is lost. Reload, or open another page from the menu.</div><button className="btn btn-primary" onClick={() => location.reload()}>Reload</button></div>;
  }
}

export function App() {
  const me = useMe(); const cfg = useConfig(); const nav = useNavigate(); const loc = useLocation();
  const [palette, setPalette] = useState(false);
  const [userMenu, setUserMenu] = useState(false);
  const [plus, setPlus] = useState(false);
  const [drawer, setDrawer] = useState(false);
  useScrollLock(drawer);
  const [params, setParams] = useSearchParams();
  const closeBook = () => { const p = new URLSearchParams(params); if (p.get('rec')) p.delete('day'); /* a follow-up's date, not the Calendar's own day */ ['book', 'patient', 'pname', 'rec', 'doc'].forEach((k) => p.delete(k)); setParams(p, { replace: true }); };
  const perms: string[] = me.data?.perms ?? [];
  const c = (p: string) => can(perms, p);
  const platform = me.data?.tenantKind === 'platform';
  const items = NAV.filter((n) => (n.to === '/platform' ? platform : !platform) && n.show(c));
  const wk = useWorkingAs(me.data);
  const { main, more } = platform ? { main: items, more: [] } : splitNav(items, wk.modes, wk.mode);
  const onWork = (m: Mode) => { wk.set(m); nav(MODE_HOME[m], { viewTransition: true }); };
  const fit = false; // every page scrolls; the desk's check-in panel sticks on its own
  // A page you cannot use is not shown, and typing its address gets a clear "no access" instead of an empty screen.
  const sub = loc.pathname.split('/')[1] ?? '';
  const pageRule = NAV.find((n) => n.to === '/' + sub) ?? (sub === 'encounter' ? { to: '', label: 'The consultation page', icon: '', show: (x: (p: string) => boolean) => x('encounter.intake') } : null);
  const blocked = !!pageRule && (platform ? pageRule.to !== '/platform' : pageRule.to === '/platform' || !pageRule.show(c));
  const active = items.find((n) => loc.pathname === n.to || loc.pathname.startsWith(n.to + '/')) ?? null;
  const [padNav, setPadNav] = useState(false); // on a consultation the sidebar starts as icons, to give the pad the room; this opens it for now
  const [pageSearch, setPageSearch] = useState<string | null>(null); // a hook: before the early returns below. What this page's list is searched by, when it has one
  const [theme, toggleTheme] = useTheme();
  const [navOpen, toggleNav] = useNav();
  const online = useOnline(); const offlineAt = useOffline();

  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((o) => !o); } };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, []);
  useEffect(() => setDrawer(false), [loc.pathname]);
  // Sign out when idle (owner's setting) on shared computers. A doctor in a consultation is left alone; anything unsaved is saved first.
  const idleMin: number = me.data?.privacy?.idleMinutes ?? 0;
  const inConsult = loc.pathname.startsWith('/encounter') && c('encounter.complete');
  const onPad = loc.pathname.startsWith('/encounter'); // the pad: the patient sits in the top bar; clock, search, help and + step aside
  const wide = onPad ? padNav : navOpen;
  const toggleWide = onPad ? () => setPadNav((o) => !o) : toggleNav;
  useEffect(() => {
    if (!idleMin || inConsult) return;
    let last = Date.now();
    const bump = () => { last = Date.now(); };
    const evs = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    evs.forEach((e) => window.addEventListener(e, bump, { passive: true }));
    const t = setInterval(async () => {
      if (Date.now() - last < idleMin * 60_000) return;
      clearInterval(t); window.dispatchEvent(new Event('app:save-now'));
      await new Promise((r) => setTimeout(r, 800));
      await post('/auth/logout').catch(() => {}); qc.clear(); clearOfflineCache(); location.href = `/login?idle=${idleMin}`;
    }, 15_000);
    return () => { clearInterval(t); evs.forEach((e) => window.removeEventListener(e, bump)); };
  }, [idleMin, inConsult]);

  if (me.isLoading) return <div className="min-h-dvh grid place-items-center text-muted text-sm anim-fade-in">Opening clinic…</div>;
  if (!me.data) {
    // Signed out (401) goes to sign-in; outside the clinic's internet the api already moved to the sign-in notice.
    // Anything else is a dropped connection: say so and keep trying, never throw the person out.
    const e = me.error;
    if (e instanceof ApiError && (e.status === 401 || e.body?.code === 'IP_NOT_ALLOWED')) { if (e.status === 401 && location.pathname !== '/login') location.href = '/login'; return null; }
    return (
      <div className="min-h-dvh grid place-items-center p-6 text-center anim-fade-in" role="alert">
        <div className="space-y-3"><div className="text-[15px] font-semibold">Can't reach the clinic server. Retrying…</div><div className="text-sm text-muted">{online ? 'The app tries again every few seconds.' : 'No internet on this computer. Check the Wi-Fi or cable.'}</div>
          <button className="btn btn-primary" disabled={me.isFetching} onClick={() => me.refetch()}>{me.isFetching ? 'Trying…' : 'Retry'}</button></div>
      </div>
    );
  }
  if (me.data.mustChangePassword) return <FirstPassword name={me.data.name} />;
  const signOut = async () => { window.dispatchEvent(new Event('app:save-now')); await new Promise((r) => setTimeout(r, 300)); await post('/auth/logout').catch(() => {}); qc.clear(); clearOfflineCache(); nav('/login'); };
  const clinic = cfg.data?.tenant.name ?? 'CUBOTT Clinical';
  const topic = loc.pathname === '/settings' ? settingsTopic(new URLSearchParams(loc.search).get('tab')) : null;
  // Back: the screen you came from; opened from a link or a fresh tab, the page above this one
  const seg = loc.pathname.split('/').filter(Boolean);
  const parent = topic ? '/settings' : seg[0] === 'patients' && seg[1] ? '/patients' : seg[0] === 'encounter' ? (perms.includes('encounter.complete') || perms.includes('*') ? '/today' : '/queue') : seg[0] === 'help' ? '/' : null;
  const goBack = () => (((window.history.state as any)?.idx ?? 0) > 0 ? nav(-1) : nav(parent ?? '/', { viewTransition: true }));
  const roles: string[] = me.data.roles ?? [me.data.role];
  const side = { items: main, more, active, clinic, me: me.data, roles, wk, onWork, onSignOut: signOut };

  return (
    <div className={fit ? 'min-h-dvh md:h-dvh md:overflow-hidden' : 'min-h-dvh'}>
      <div className="app-orbs no-print" aria-hidden="true"><i /><i /><i /></div>
      <aside className={`no-print fixed inset-y-0 left-0 z-20 hidden bg-sidebar md:block ${wide ? 'w-[232px]' : 'w-[76px]'}`} style={{ boxShadow: 'inset -1px 0 0 rgba(0,0,0,.15)', transition: 'width 0.2s var(--ease)' }} aria-label="Main">
        {wide ? <Sidebar {...side} onCollapse={toggleWide} /> : <Rail items={main} more={more} active={active} clinic={clinic} me={me.data} onSignOut={signOut} onExpand={toggleWide} />}
      </aside>
      {drawer && (
        <div className="no-print fixed inset-0 z-40 md:hidden anim-fade-in" style={{ background: 'rgba(21,24,27,.4)' }} onClick={() => setDrawer(false)}>
          <aside className="h-full w-[264px] max-w-[85vw] bg-sidebar anim-slide-in" style={{ boxShadow: 'var(--shadow-lift)' }} onClick={(e) => e.stopPropagation()} aria-label="Main"><Sidebar {...side} onNavigate={() => setDrawer(false)} /></aside>
        </div>
      )}

      <div className={`${wide ? 'md:pl-[232px]' : 'md:pl-[76px]'} ${fit ? 'md:flex md:h-full md:flex-col' : ''}`} style={{ transition: 'padding-left 0.2s var(--ease)' }}>
        <header className="app-top no-print sticky top-0 z-30 flex h-[68px] shrink-0 items-center gap-2 bg-paper/90 px-3 backdrop-blur-xl md:px-7">
          <button className="btn btn-ghost btn-icon md:hidden" aria-label="Open menu" onClick={() => setDrawer(true)}><Icon name="menu" /></button>
          {parent && <button type="button" className="btn btn-ghost btn-icon !h-9 !w-9 -ml-2 shrink-0" aria-label="Back" title="Back" onClick={goBack}><Icon name="chevL" className="h-5 w-5" /></button>}
          {onPad ? <div id="topbar-slot" className="flex min-w-0 flex-1 items-center" /> : <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-[22px] font-semibold tracking-tight text-muted">{topic ? <><button type="button" className="truncate hover:text-ink" onClick={() => nav('/settings')}>Settings</button><Icon name="chevR" className="h-5 w-5 shrink-0" /><span className="truncate text-ink">{topic}</span></> : <span className="truncate text-ink">{active?.label ?? (loc.pathname.startsWith('/encounter') ? 'Consultation' : loc.pathname.startsWith('/help') ? 'Help' : 'Home')}</span>}</nav>}
          {!onPad && <span className="ml-auto" />}
          {!onPad && pageSearch && <PageSearchBox key={pageSearch} placeholder={pageSearch} className="mr-1 hidden w-[300px] md:inline-flex" />}
          {!platform && !onPad && !pageSearch && <button onClick={() => setPalette(true)} className="toppill mr-1 hidden w-[280px] !font-medium !text-muted lg:inline-flex" aria-label="Search patients (Ctrl K)"><Icon name="search" className="h-4 w-4" /><span className="flex-1 truncate text-left">Patients, phone or ID…</span><span className="kbd">Ctrl K</span></button>}
          {!platform && !onPad && !pageSearch && <button onClick={() => setPalette(true)} aria-label="Search patients" title="Search patients (Ctrl K)" className="btn btn-icon lg:hidden"><Icon name="search" /></button>}
          <button type="button" onClick={(e) => revealTheme(e, theme === 'dark' ? 'light' : 'dark', toggleTheme)} className="btn btn-icon hidden sm:inline-flex" aria-label={theme === 'dark' ? 'Switch to light' : 'Switch to dark'} title={theme === 'dark' ? 'Light' : 'Dark'}><Icon name={theme === 'dark' ? 'spark' : 'moon'} className="h-4 w-4" /></button>
          {!onPad && <Link to={`/help?from=${encodeURIComponent(loc.pathname.split('/')[1] ?? '')}`} aria-label="Help: how the clinic runs" title="Help: how the clinic runs" className="btn btn-icon hidden sm:inline-flex"><Icon name="help" className="h-4 w-4" /></Link>}
            {!platform && !onPad && (() => { const acts = createActions(c, loc.pathname + loc.search); return acts.length > 0 && (
              <div className="relative shrink-0">
                <button onClick={() => setPlus((o) => !o)} aria-label="New" title="New: check in, book, register…" aria-expanded={plus} className="btn btn-primary !h-10 !min-h-10 !w-10 !rounded-[11px] !p-0 justify-center"><Icon name="plus" className="h-5 w-5" /></button>
                {plus && <><div className="fixed inset-0 z-30" onClick={() => setPlus(false)} />
                  <div className="menu anim-menu z-40 !w-[270px]" role="menu">{acts.map((x) => <button key={x.key} role="menuitem" onClick={() => { setPlus(false); nav(x.to, { viewTransition: true }); }}><Icon name={x.icon} className="h-4 w-4" />{x.label}</button>)}</div></>}
              </div>); })()}
            <div className="relative md:hidden">
              <button onClick={() => setUserMenu((o) => !o)} aria-label="Account"><Avatar name={me.data.name} size="h-8 w-8 text-xs" /></button>
              {userMenu && <div className="menu anim-menu" onMouseLeave={() => setUserMenu(false)}><div className="px-3 py-2"><div className="text-sm font-semibold">{me.data.name}</div><div className="text-xs text-muted">{roles.map(roleLabel).join(' · ')}</div></div><button onClick={signOut}><Icon name="logout" className="h-4 w-4" />Sign out</button></div>}
            </div>
        </header>
        {offlineAt !== null && <div role="status" className="no-print sticky top-[68px] z-30 bg-amber-soft px-4 py-1.5 text-center text-[13px] font-semibold text-amber md:px-7">Offline{offlineAt ? ` · showing what was loaded at ${offlineAt}` : ''}. Nothing you change is saved until the internet is back.</div>}

        <div className={`mx-auto w-full px-4 py-4 md:px-7 md:py-5 ${loc.pathname.startsWith('/encounter') || loc.pathname === '/queue' ? 'max-w-none' : 'max-w-[1520px]'} ${fit ? 'md:flex md:min-h-0 md:flex-1 md:flex-col' : 'pb-16'}`}>
          <main key={loc.pathname.split('/')[1]} className={`page ${fit ? 'md:flex-1 md:min-h-0 md:flex md:flex-col' : ''}`}>{blocked ? <NoAccess what={pageRule?.label} /> : <PageSearchCtx.Provider value={setPageSearch}>{pageSearch && <PageSearchBox placeholder={pageSearch} className="mb-3 flex w-full md:hidden" />}<PageError key={loc.pathname}><Outlet context={{ me: me.data, perms, cfg: cfg.data }} /></PageError></PageSearchCtx.Provider>}</main>
        </div>
      </div>
      <PrintHost />
      <ViewerHost />
      {params.get('book') === '1' && c('appointment.write') && cfg.data && <NewBooking cfg={cfg.data} me={me.data} initialPatient={params.get('patient') ? { id: params.get('patient')!, name: params.get('pname') ?? 'this patient' } : undefined} initialDay={params.get('day') ?? undefined} initialDoc={params.get('doc') ?? undefined} onClose={closeBook} onDone={() => { refreshBookings(); const rec = params.get('rec'); if (rec) patch(`/worklist/${rec}`, { status: 'scheduled' }).then(() => qc.invalidateQueries({ queryKey: ['worklist'] }), () => {}); closeBook(); }} />}
      <CommandPalette open={palette} onClose={() => setPalette(false)} can={c} />
      <ToastHost />
    </div>
  );
}
