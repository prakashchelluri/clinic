import { Component, useEffect, useState, type ReactNode } from 'react';
import { Link, Navigate, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useMe, useConfig, post, get, patch, qc, ApiError, clearOfflineCache } from './api';
import { useOffline } from './offline';
import { Avatar, Icon, NoAccess, ToastHost, useScrollLock, useOnline, PageSearchCtx, revealTheme } from './ui';
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
/** A count beside a menu item; warn = something there still needs doing today (amber). */
type Badge = { n: number; warn?: boolean; hint: string };
type Badges = Record<string, Badge | undefined>;
export const NAV: NavItem[] = [
  // one home for doctors, the junior doctor and the desk: the calendar and what needs you (it replaced Today, Front desk and Appointments)
  { to: '/dashboard', label: 'Calendar', icon: 'calendar', show: (c) => c('encounter.complete') || c('visit.write') || c('encounter.intake') },
  { to: '/patients', label: 'Patients', icon: 'users', show: (c) => c('patient.read') },
  { to: '/worklist', label: 'Procedures', icon: 'syringe', show: (c) => c('worklist.read') },
  { to: '/calls', label: 'Calls', icon: 'phone', show: (c) => c('worklist.read') },
  { to: '/tests', label: 'Test reports', icon: 'tubes', show: (c) => c('worklist.read') || c('encounter.complete') },
  { to: '/pharmacy', label: 'Pharmacy', icon: 'pill', show: (c) => c('pharmacy.read') },
  { to: '/inventory', label: 'Inventory', icon: 'box', show: (c) => c('stock.read') },
  { to: '/clinic', label: 'Clinic', icon: 'home', show: (c) => c('finance.read') },
  { to: '/billing', label: 'Billing', icon: 'rupee', show: (c) => c('fees.see') && (c('payment.record') || c('finance.read')) },
  { to: '/accounts', label: 'Accounts', icon: 'wallet', show: (c) => c('finance.read') },
  { to: '/reports', label: 'Reports', icon: 'chart', show: (c) => c('report.read') || c('report.daily') || c('finance.read') },
  { to: '/expenses', label: 'Expenses', icon: 'wallet', show: (c) => c('expense.read') && !c('finance.read') }, // the owner has them in Accounts › Spending
  { to: '/settings', label: 'Settings', icon: 'gear', show: (c) => c('config.write') || c('appointment.write') }, // the desk gets Doctors' hours only
  { to: '/audit', label: 'Audit log', icon: 'lock', show: (c) => c('user.write') },
  { to: '/platform', label: 'Clinics', icon: 'home', show: (c) => c('platform.read') },
];

/** Where each role lands: the page that answers their first question of the day. An owner who sees patients lands on Today. */
export function homeFor(c: (p: string) => boolean, platform = false) {
  if (platform) return '/platform';
  if (c('encounter.complete') || c('visit.write') || c('encounter.intake')) return '/dashboard';
  if (c('worklist.write')) return '/worklist';
  if (c('expense.read')) return '/expenses';
  if (c('pharmacy.read')) return '/pharmacy';
  return '/patients';
}

export function Home() {
  const me = useMe();
  if (me.isLoading) return null;
  const c = (p: string) => can(me.data?.perms, p);
  return <Navigate to={homeFor(c, me.data?.tenantKind === 'platform')} replace />;
}

/** Light or dark for this person, kept on this device. The print sheet and the waiting-room TV ignore it. */
export function useTheme() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => { try { return (localStorage.getItem('theme') as 'light' | 'dark') || 'light'; } catch { return 'light'; } });
  useEffect(() => { document.documentElement.dataset.theme = theme; try { localStorage.setItem('theme', theme); } catch { /* private mode */ } }, [theme]);
  return [theme, () => setTheme((t) => (t === 'light' ? 'dark' : 'light'))] as const;
}

/** Role names as people say them; a custom role shows its own name from Settings. */
const ROLE_LABEL: Record<string, string> = { owner: 'Owner', admin: 'Admin', doctor: 'Doctor', assistant: 'Junior doctor', receptionist: 'Reception', coordinator: 'Coordinator', pharmacist: 'Pharmacy' };
const roleLabel = (r: string) => ROLE_LABEL[r] ?? r.replace(/_/g, ' ');

/** Group headings in the side menu, before the first page of each group. */
const GROUP: Record<string, string> = { '/worklist': 'Care', '/pharmacy': 'Stock', '/clinic': 'Business', '/settings': 'Admin' };

/** The side menu (v61 · Pro): dark, every allowed page by name, counts as small badges, quiet group headings.
 *  The same menu on desktop (fixed) and on phones (the drawer). */
function Sidebar({ items, active, clinic, me, roles, badges = {}, onSignOut, onNavigate, slim = false, theme, onTheme }: { items: NavItem[]; active: NavItem | null; clinic: string; me: any; roles: string[]; badges?: Badges; onSignOut: () => void; onNavigate?: () => void; slim?: boolean; theme?: string; onTheme?: (e: React.MouseEvent) => void }) {
  const link = (n: NavItem) => (
    <Link key={n.to} to={n.to} viewTransition onClick={onNavigate} aria-current={active?.to === n.to ? 'page' : undefined} title={slim ? n.label : undefined} className={`nav-item ${active?.to === n.to ? 'active' : ''}`}>
      <Icon name={n.icon} className="h-4 w-4 shrink-0" /><span className="flex-1 truncate">{n.label}</span>
      {badges[n.to] && <span className={`nav-badge ${badges[n.to]!.warn ? 'warn' : ''}`} title={badges[n.to]!.hint}><span className="sr-only">{badges[n.to]!.hint}: </span>{badges[n.to]!.n > 99 ? '99+' : badges[n.to]!.n}</span>}
    </Link>
  );
  return (
    <div className={`side-dark flex h-full flex-col px-3 pb-3 ${slim ? 'side-slim' : ''}`}>
      <Link to="/" onClick={onNavigate} className="flex h-[64px] shrink-0 items-center gap-2.5 px-1.5" title={clinic}>
        <img src="/cubott.png" alt="" className="h-7 w-7 shrink-0 object-contain" />
        <span className="side-text min-w-0 leading-tight"><span className="block truncate text-[14px] font-semibold text-ink">Cubott OPD</span><span className="block truncate text-[11.5px] text-muted">{clinic}</span></span>
      </Link>
      <nav className="-mx-1 flex flex-1 flex-col gap-px overflow-y-auto px-1 no-scrollbar" aria-label="Sections">
        {items.map((n, i) => <span key={n.to} className="contents">{i > 0 && GROUP[n.to] && <span className="side-group" aria-hidden="true">{GROUP[n.to]}</span>}{link(n)}</span>)}
      </nav>
      <Link to="/help" onClick={onNavigate} title={slim ? 'Help' : undefined} className={`nav-item mt-2 ${active === null && location.pathname.startsWith('/help') ? 'active' : ''}`}><Icon name="help" className="h-4 w-4" /><span className="flex-1">Help</span></Link>
      {/* on a record the top bar steps aside, so its light / dark switch comes here */}
      {slim && onTheme && <button type="button" onClick={onTheme} className="nav-item" aria-label={theme === 'dark' ? 'Switch to light' : 'Switch to dark'} title={theme === 'dark' ? 'Light' : 'Dark'}><Icon name={theme === 'dark' ? 'spark' : 'moon'} className="h-4 w-4" /></button>}
      <div className="side-foot mt-2 flex items-center gap-2.5 border-t border-line px-1 pt-3">
        <span className="relative shrink-0"><Avatar name={me.name} size="h-8 w-8 text-[11px]" /><span className="absolute -bottom-px -right-px h-2.5 w-2.5 rounded-full bg-sage" style={{ boxShadow: '0 0 0 2px var(--color-sidebar)' }} /></span>
        <div className="side-text min-w-0 flex-1"><div className="truncate text-[13px] font-medium text-ink">{me.name}</div><div className="truncate text-[11.5px] text-muted">{roles.map(roleLabel).join(' · ')}</div></div>
        <button onClick={onSignOut} aria-label="Sign out" title="Sign out" className="btn btn-ghost btn-icon text-muted hover:!bg-paper-2 hover:text-ink"><Icon name="logout" className="h-4 w-4" /></button>
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
  const fit = false; // every page scrolls; the desk's check-in panel sticks on its own
  // A page you cannot use is not shown, and typing its address gets a clear "no access" instead of an empty screen.
  const sub = loc.pathname.split('/')[1] ?? '';
  const pageRule = NAV.find((n) => n.to === '/' + sub) ?? (sub === 'encounter' ? { to: '', label: 'The consultation page', icon: '', show: (x: (p: string) => boolean) => x('encounter.intake') } : null);
  const blocked = !!pageRule && (platform ? pageRule.to !== '/platform' : pageRule.to === '/platform' || !pageRule.show(c));
  const active = items.find((n) => loc.pathname === n.to || loc.pathname.startsWith(n.to + '/')) ?? null;
  const [, setPageSearch] = useState<string | null>(null); // a hook: before the early returns below. What this page's list is searched by, when it has one
  const [theme, toggleTheme] = useTheme();
  const online = useOnline(); const offlineAt = useOffline();
  // menu badges (a hook: above the early returns), under the Calls list's own key so logging a call refreshes them too
  const counts = useQuery({ queryKey: ['followups', 'menu'], queryFn: () => get('/followups/menu-counts'), enabled: c('worklist.read') && !platform, refetchInterval: 30000 });

  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((o) => !o); } };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, []);
  useEffect(() => setDrawer(false), [loc.pathname]);
  // Sign out when idle (owner's setting) on shared computers. A doctor in a consultation is left alone; anything unsaved is saved first.
  const idleMin: number = me.data?.privacy?.idleMinutes ?? 0;
  const inConsult = loc.pathname.startsWith('/encounter') && c('encounter.complete');
  const onPad = loc.pathname.startsWith('/encounter');
  // an open record (a patient, a consultation): its own bar is the header, so the top bar steps aside and the menu slims to icons
  const record = /^\/(patients|encounter)\/[^/]+/.test(loc.pathname);
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
  const parent = topic ? '/settings' : seg[0] === 'patients' && seg[1] ? '/patients' : seg[0] === 'encounter' ? '/dashboard' : seg[0] === 'help' ? '/' : null;
  const goBack = () => (((window.history.state as any)?.idx ?? 0) > 0 ? nav(-1) : nav(parent ?? '/', { viewTransition: true }));
  const roles: string[] = me.data.roles ?? [me.data.role];
  const mc = counts.data;
  const badges: Badges = mc ? {
    '/calls': mc.calls ? { n: mc.calls, hint: `${mc.calls} to call today` } : undefined,
    '/worklist': mc.sittings ? { n: mc.sittings, warn: mc.unconfirmed > 0, hint: mc.unconfirmed ? `${mc.sittings} sitting${mc.sittings === 1 ? '' : 's'} today, ${mc.unconfirmed} not confirmed` : `${mc.sittings} sitting${mc.sittings === 1 ? '' : 's'} today` } : undefined,
  } : {};
  const side = { items, active, clinic, me: me.data, roles, badges, onSignOut: signOut };

  return (
    <div className={fit ? 'min-h-dvh md:h-dvh md:overflow-hidden' : 'min-h-dvh'}>
      <div className="app-orbs no-print" aria-hidden="true"><i /><i /><i /></div>
      {/* one top row across the whole screen: the Cubott logo over the menu, the clinic, where you are, and the few app actions.
          A page's search lives with its own table, not up here. */}
      <aside className={`no-print fixed inset-y-0 left-0 z-30 hidden transition-[width] duration-200 md:block ${record ? 'w-[64px]' : 'w-[232px]'}`} aria-label="Main">
        <Sidebar {...side} slim={record} theme={theme} onTheme={(e) => revealTheme(e, theme === 'dark' ? 'light' : 'dark', toggleTheme)} />
      </aside>
      {drawer && (
        <div className="no-print fixed inset-0 z-40 md:hidden anim-fade-in" style={{ background: 'rgba(21,24,27,.4)' }} onClick={() => setDrawer(false)}>
          <aside className="h-full w-[264px] max-w-[85vw] anim-slide-in" style={{ boxShadow: 'var(--shadow-lift)' }} onClick={(e) => e.stopPropagation()} aria-label="Main"><Sidebar {...side} onNavigate={() => setDrawer(false)} /></aside>
        </div>
      )}

      <div className={`transition-[padding] duration-200 ${record ? 'md:pl-[64px]' : 'md:pl-[232px]'} ${fit ? 'md:flex md:h-full md:flex-col' : ''}`}>
      <header className={`app-top no-print sticky top-0 z-30 flex h-[64px] items-center ${record ? 'md:hidden' : ''}`} style={{ boxShadow: 'inset 0 -1px 0 var(--color-line)' }}>
        <button className="btn btn-ghost btn-icon ml-2 md:hidden" aria-label="Open menu" onClick={() => setDrawer(true)}><Icon name="menu" /></button>
        <Link to="/" aria-label="Cubott OPD · home" title="Cubott OPD" className="flex h-full shrink-0 items-center justify-center px-2 md:hidden"><img src="/cubott.png" alt="Cubott" className="h-8 w-8 object-contain" /></Link>
        <div className="flex min-w-0 flex-1 items-center gap-2 pr-3 md:px-7">
          {parent && !record && <button type="button" className="btn btn-ghost btn-icon !h-9 !w-9 shrink-0" aria-label="Back" title="Back" onClick={goBack}><Icon name="chevL" className="h-5 w-5" /></button>}
          {<nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-[17px] font-semibold tracking-tight text-muted">{topic ? <><button type="button" className="truncate hover:text-ink" onClick={() => nav('/settings')}>Settings</button><Icon name="chevR" className="h-4 w-4 shrink-0" /><span className="truncate text-ink">{topic}</span></> : <span className="truncate text-ink">{active?.label ?? (loc.pathname.startsWith('/encounter') ? 'Consultation' : loc.pathname.startsWith('/help') ? 'Help' : 'Home')}</span>}</nav>}
          <span className="ml-auto" />
          {/* theme and help as one grouped control */}
          <span className="hidden overflow-hidden rounded-[6px] border border-line-2 bg-field sm:flex">
          <button type="button" onClick={(e) => revealTheme(e, theme === 'dark' ? 'light' : 'dark', toggleTheme)} className="grid h-[36px] w-[36px] place-items-center text-muted hover:bg-paper-2 hover:text-ink" aria-label={theme === 'dark' ? 'Switch to light' : 'Switch to dark'} title={theme === 'dark' ? 'Light' : 'Dark'}><Icon name={theme === 'dark' ? 'spark' : 'moon'} className="h-4 w-4" /></button>
          {!onPad && <Link to={`/help?from=${encodeURIComponent(loc.pathname.split('/')[1] ?? '')}`} aria-label="Help: how the clinic runs" title="Help: how the clinic runs" className="grid h-[36px] w-[36px] place-items-center border-l border-line-2 text-muted hover:bg-paper-2 hover:text-ink"><Icon name="help" className="h-4 w-4" /></Link>}
          </span>
          {!platform && !onPad && (() => { const acts = createActions(c, loc.pathname + loc.search); return acts.length > 0 && (
            <div className="relative shrink-0">
              <button onClick={() => setPlus((o) => !o)} aria-label="New" title="New: check in, book, register…" aria-expanded={plus} className="btn btn-primary !h-[36px] !min-h-[36px] !rounded-[6px] !px-3 justify-center"><Icon name="plus" className="h-4 w-4" /><span className="hidden sm:inline">New</span></button>
              {plus && <><div className="fixed inset-0 z-30" onClick={() => setPlus(false)} />
                <div className="menu anim-menu z-40 !w-[270px]" role="menu">{acts.map((x) => <button key={x.key} role="menuitem" onClick={() => { setPlus(false); nav(x.to, { viewTransition: true }); }}><Icon name={x.icon} className="h-4 w-4" />{x.label}</button>)}</div></>}
            </div>); })()}
          <div className="relative md:hidden">
            <button onClick={() => setUserMenu((o) => !o)} aria-label="Account"><Avatar name={me.data.name} size="h-8 w-8 text-xs" /></button>
            {userMenu && <div className="menu anim-menu" onMouseLeave={() => setUserMenu(false)}><div className="px-3 py-2"><div className="text-sm font-semibold">{me.data.name}</div><div className="text-xs text-muted">{roles.map(roleLabel).join(' · ')}</div></div><button onClick={signOut}><Icon name="logout" className="h-4 w-4" />Sign out</button></div>}
          </div>
        </div>
      </header>

        {offlineAt !== null && <div role="status" className="no-print sticky top-[64px] z-30 bg-amber-soft px-4 py-1.5 text-center text-[13px] font-semibold text-amber md:px-7">Offline{offlineAt ? ` · showing what was loaded at ${offlineAt}` : ''}. Nothing you change is saved until the internet is back.</div>}

        <div className={`mx-auto w-full px-4 py-4 md:px-7 md:py-5 ${loc.pathname.startsWith('/encounter') || loc.pathname === '/dashboard' ? 'max-w-none' : 'max-w-[1520px]'} ${fit ? 'md:flex md:min-h-0 md:flex-1 md:flex-col' : 'pb-16'}`}>
          <main key={loc.pathname.split('/')[1]} className={`page ${fit ? 'md:flex-1 md:min-h-0 md:flex md:flex-col' : ''}`}>{blocked ? <NoAccess what={pageRule?.label} /> : <PageSearchCtx.Provider value={setPageSearch}><PageError key={loc.pathname}><Outlet context={{ me: me.data, perms, cfg: cfg.data }} /></PageError></PageSearchCtx.Provider>}</main>
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
