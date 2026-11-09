import { useEffect, useState } from 'react';
import { Link, Navigate, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useMe, useConfig, post, get, patch, qc, ApiError } from './api';
import { Avatar, Icon, NoAccess, ToastHost, useScrollLock } from './ui';
import { CommandPalette, createActions } from './palette';
import { NewBooking } from './pages/Booking';
import { settingsTopic } from './pages/Settings';
import { refreshBookings } from './apptDrawer';
import { PrintHost } from './printPreview';
import { ViewerHost } from './viewer';

export function can(perms: string[] | undefined, needed: string) {
  return !!perms?.some((p) => p === '*' || p === needed || (p.endsWith('.*') && needed.startsWith(p.slice(0, -1))));
}

export type NavItem = { to: string; label: string; icon: string; group?: 'clinic'; show: (c: (p: string) => boolean) => boolean };
export const NAV: NavItem[] = [
  // ponytail: Dashboard hidden for now (PM review, Oct 2026); bring back by restoring c('finance.read')
  { to: '/overview', label: 'Dashboard', icon: 'home', show: () => false },
  { to: '/dashboard', label: 'Dashboard', icon: 'chart', group: 'clinic', show: (c) => c('report.read') || c('finance.read') },
  { to: '/today', label: 'Today', icon: 'stetho', show: (c) => c('encounter.complete') },
  { to: '/queue', label: 'Front desk', icon: 'queue', show: (c) => c('visit.write') || (c('encounter.intake') && !c('encounter.complete')) },
  { to: '/calendar', label: 'Calendar', icon: 'calendar', show: (c) => c('appointment.read') },
  { to: '/bookings', label: 'Bookings', icon: 'inbox', show: (c) => c('appointment.read') },
  { to: '/patients', label: 'Patients', icon: 'users', show: (c) => c('patient.read') },
  { to: '/worklist', label: 'Procedures', icon: 'clock', show: (c) => c('worklist.read') },
  { to: '/followups', label: 'Follow-ups', icon: 'phone', show: (c) => c('worklist.read') },
  { to: '/tests', label: 'Test reports', icon: 'inbox', show: (c) => c('worklist.read') || c('encounter.complete') },
  { to: '/pharmacy', label: 'Pharmacy', icon: 'pill', group: 'clinic', show: (c) => c('pharmacy.read') },
  { to: '/inventory', label: 'Inventory', icon: 'inbox', group: 'clinic', show: (c) => c('stock.read') },
  { to: '/reports', label: 'Reports', icon: 'chart', group: 'clinic', show: (c) => c('report.daily') || c('finance.read') },
  { to: '/expenses', label: 'Expenses', icon: 'wallet', group: 'clinic', show: (c) => c('expense.read') },
  { to: '/settings', label: 'Settings', icon: 'gear', group: 'clinic', show: (c) => c('config.write') },
  { to: '/audit', label: 'Audit log', icon: 'lock', group: 'clinic', show: (c) => c('user.write') },
  { to: '/platform', label: 'Clinics', icon: 'home', show: (c) => c('platform.read') },
];

/** Where each role lands: the page that answers their first question of the day. */
export function homeFor(c: (p: string) => boolean, platform = false) {
  if (platform) return '/platform';
  if (c('encounter.complete')) return '/today';
  if (c('visit.write')) return '/queue';
  if (c('encounter.intake')) return '/queue';
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
function Rail({ items, active, clinic, me, requests, onSignOut, onExpand }: { items: NavItem[]; active: NavItem | null; clinic: string; me: any; requests: number; onSignOut: () => void; onExpand: () => void }) {
  return (
    <div className="flex h-full flex-col items-center px-3 pb-3.5 pt-4">
      <Link to="/" title={clinic} className="mb-2 grid h-[38px] w-[38px] place-items-center rounded-[12px] bg-brand text-[16px] font-bold" style={{ color: 'var(--color-paper)' }}>{clinic.slice(0, 1)}</Link>
      <button type="button" onClick={onExpand} aria-label="Show menu names" data-tip="Show menu names" className="tip rail-item mb-2 !h-8"><Icon name="chevR" className="h-4 w-4" /></button>
      <nav className="flex w-full flex-col items-center gap-1 overflow-y-auto no-scrollbar" aria-label="Sections">
        {items.map((n, i) => <span key={n.to} className="contents">
          {i > 0 && n.group === 'clinic' && items[i - 1].group !== 'clinic' && <span className="my-1.5 w-6 border-t border-line-2" />}
          <Link to={n.to} viewTransition aria-current={active?.to === n.to ? 'page' : undefined} aria-label={n.label} data-tip={n.label} className={`tip rail-item ${active?.to === n.to ? 'active' : ''}`}>
            <Icon name={n.icon} className="h-[18px] w-[18px]" />
            {n.to === '/bookings' && requests > 0 && <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-ink" aria-label={`${requests} online requests`} />}
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

/** The clock in the top bar: the clinic's time with a breathing dot, so the room knows the app is live. */
function Clock() {
  const fmt = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  const [t, setT] = useState(fmt);
  useEffect(() => { const i = setInterval(() => setT(fmt()), 10_000); return () => clearInterval(i); }, []);
  return <span className="toppill hidden !px-2.5 sm:inline-flex" aria-label={`Clinic time ${t}`}><span className="breathe h-2 w-2 rounded-full bg-sage" />{t}</span>;
}

function Sidebar({ items, active, clinic, me, roles, requests, onSignOut, onNavigate, onCollapse }: { items: NavItem[]; active: NavItem | null; clinic: string; me: any; roles: string[]; requests: number; onSignOut: () => void; onNavigate?: () => void; onCollapse?: () => void }) {
  const link = (n: NavItem) => (
    <Link key={n.to} to={n.to} viewTransition onClick={onNavigate} aria-current={active?.to === n.to ? 'page' : undefined} className={`nav-item ${active?.to === n.to ? 'active' : ''}`}>
      <Icon name={n.icon} className="h-4 w-4 shrink-0" /><span className="flex-1 truncate">{n.label}</span>
      {n.to === '/bookings' && requests > 0 && <span className="chip chip-clay" aria-label={`${requests} online requests`}>{requests}</span>}
    </Link>
  );
  const main = items.filter((n) => !n.group); const clinicItems = items.filter((n) => n.group === 'clinic');
  return (
    <div className="flex h-full flex-col px-2.5 py-3">
      <div className="flex items-center gap-1 pb-3 pt-1">
        <Link to="/" onClick={onNavigate} className="flex min-w-0 flex-1 items-center gap-2.5 px-2"><span className="grid h-7 w-7 shrink-0 place-items-center rounded-[7px] bg-brand text-[13px] font-bold text-white" style={{ fontFamily: 'Urbanist, Inter, sans-serif' }}>{clinic.slice(0, 1)}</span><span className="truncate text-[13px] font-semibold leading-tight">{clinic}</span></Link>
        {onCollapse && <button type="button" onClick={onCollapse} aria-label="Collapse menu to icons" title="Collapse menu" className="btn btn-ghost btn-icon !h-8 !w-8 shrink-0"><Icon name="chevL" className="h-4 w-4" /></button>}
      </div>
      <nav className="flex flex-col gap-px overflow-y-auto no-scrollbar" aria-label="Sections">
        {main.map(link)}
        {clinicItems.length > 0 && <div className="px-2.5 pb-1 pt-3.5 text-[11px] font-semibold uppercase tracking-[.06em] text-muted">Clinic</div>}
        {clinicItems.map(link)}
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

export function App() {
  const me = useMe(); const cfg = useConfig(); const nav = useNavigate(); const loc = useLocation();
  const [palette, setPalette] = useState(false);
  const [userMenu, setUserMenu] = useState(false);
  const [plus, setPlus] = useState(false);
  const [drawer, setDrawer] = useState(false);
  useScrollLock(drawer);
  const [params, setParams] = useSearchParams();
  const closeBook = () => { const p = new URLSearchParams(params); ['book', 'patient', 'pname', 'rec'].forEach((k) => p.delete(k)); setParams(p, { replace: true }); };
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
  const counts = useQuery({ queryKey: ['bookings', 'counts'], queryFn: () => get('/bookings/counts'), enabled: !!me.data && !platform && c('appointment.read'), refetchInterval: 30000 });
  const requests = counts.data?.requests ?? 0;
  const plansNew = c('worklist.read') ? counts.data?.plans ?? 0 : 0; // plans the doctor made today that nobody has acted on yet
  const [bell, setBell] = useState(false);
  const [theme, toggleTheme] = useTheme();
  const [navOpen, toggleNav] = useNav();

  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((o) => !o); } };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, []);
  useEffect(() => setDrawer(false), [loc.pathname]);
  // Sign out when idle (owner's setting) on shared computers. A doctor in a consultation is left alone; anything unsaved is saved first.
  const idleMin: number = me.data?.privacy?.idleMinutes ?? 0;
  const inConsult = loc.pathname.startsWith('/encounter') && c('encounter.complete');
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
      await post('/auth/logout').catch(() => {}); qc.clear(); location.href = `/login?idle=${idleMin}`;
    }, 15_000);
    return () => { clearInterval(t); evs.forEach((e) => window.removeEventListener(e, bump)); };
  }, [idleMin, inConsult]);

  if (me.isLoading) return <div className="min-h-dvh grid place-items-center text-muted text-sm anim-fade-in">Opening clinic…</div>;
  if (me.isError) { if (!(me.error instanceof ApiError && me.error.body?.code === 'IP_NOT_ALLOWED')) location.href = '/login'; return null; }
  const signOut = async () => { await post('/auth/logout'); qc.clear(); nav('/login'); };
  const clinic = cfg.data?.tenant.name ?? 'CUBOTT Clinical';
  const topic = loc.pathname === '/settings' ? settingsTopic(new URLSearchParams(loc.search).get('tab')) : null;
  // Back: the screen you came from; opened from a link or a fresh tab, the page above this one
  const seg = loc.pathname.split('/').filter(Boolean);
  const parent = topic ? '/settings' : seg[0] === 'patients' && seg[1] ? '/patients' : seg[0] === 'encounter' ? (perms.includes('encounter.complete') || perms.includes('*') ? '/today' : '/queue') : seg[0] === 'help' ? '/' : null;
  const goBack = () => (((window.history.state as any)?.idx ?? 0) > 0 ? nav(-1) : nav(parent ?? '/', { viewTransition: true }));
  const roles: string[] = me.data.roles ?? [me.data.role];
  const side = { items, active, clinic, me: me.data, roles, requests, onSignOut: signOut };

  return (
    <div className={fit ? 'min-h-dvh md:h-dvh md:overflow-hidden' : 'min-h-dvh'}>
      <aside className={`no-print fixed inset-y-0 left-0 z-20 hidden bg-sidebar md:block ${navOpen ? 'w-[232px]' : 'w-[76px]'}`} style={{ boxShadow: 'inset -1px 0 0 rgba(0,0,0,.15)', transition: 'width 0.2s var(--ease)' }} aria-label="Main">
        {navOpen ? <Sidebar {...side} onCollapse={toggleNav} /> : <Rail items={items} active={active} clinic={clinic} me={me.data} requests={requests} onSignOut={signOut} onExpand={toggleNav} />}
      </aside>
      {drawer && (
        <div className="no-print fixed inset-0 z-40 md:hidden anim-fade-in" style={{ background: 'rgba(21,24,27,.4)' }} onClick={() => setDrawer(false)}>
          <aside className="h-full w-[264px] max-w-[85vw] bg-sidebar anim-slide-in" style={{ boxShadow: 'var(--shadow-lift)' }} onClick={(e) => e.stopPropagation()} aria-label="Main"><Sidebar {...side} onNavigate={() => setDrawer(false)} /></aside>
        </div>
      )}

      <div className={`${navOpen ? 'md:pl-[232px]' : 'md:pl-[76px]'} ${fit ? 'md:flex md:h-full md:flex-col' : ''}`} style={{ transition: 'padding-left 0.2s var(--ease)' }}>
        <header className="no-print sticky top-0 z-30 flex h-[68px] shrink-0 items-center gap-2 bg-paper/90 px-3 backdrop-blur-xl md:px-7">
          <button className="btn btn-ghost btn-icon md:hidden" aria-label="Open menu" onClick={() => setDrawer(true)}><Icon name="menu" /></button>
          {parent && <button type="button" className="btn btn-ghost btn-icon !h-9 !w-9 -ml-2 shrink-0" aria-label="Back" title="Back" onClick={goBack}><Icon name="chevL" className="h-5 w-5" /></button>}
          <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-[22px] font-semibold tracking-tight text-muted">{topic ? <><button type="button" className="truncate hover:text-ink" onClick={() => nav('/settings')}>Settings</button><Icon name="chevR" className="h-5 w-5 shrink-0" /><span className="truncate text-ink">{topic}</span></> : <span className="truncate text-ink">{active?.label ?? (loc.pathname.startsWith('/encounter') ? 'Consultation' : loc.pathname.startsWith('/help') ? 'Help' : 'Home')}</span>}</nav>
          <span className="ml-auto" />
          {!platform && <button onClick={() => setPalette(true)} className="toppill mr-1 hidden w-[280px] !font-medium !text-muted lg:inline-flex" aria-label="Search patients (Ctrl K)"><Icon name="search" className="h-4 w-4" /><span className="flex-1 truncate text-left">Patients, phone or ID…</span><span className="kbd">Ctrl K</span></button>}
          {!platform && <button onClick={() => setPalette(true)} aria-label="Search patients" title="Search patients (Ctrl K)" className="btn btn-icon lg:hidden"><Icon name="search" /></button>}
          <Clock />
          <button type="button" onClick={toggleTheme} className="btn btn-icon hidden sm:inline-flex" aria-label={theme === 'dark' ? 'Switch to light' : 'Switch to dark'} title={theme === 'dark' ? 'Light' : 'Dark'}><Icon name={theme === 'dark' ? 'spark' : 'moon'} className="h-4 w-4" /></button>
          <Link to={`/help?from=${encodeURIComponent(loc.pathname.split('/')[1] ?? '')}`} aria-label="Help: how the clinic runs" title="Help: how the clinic runs" className="btn btn-icon hidden sm:inline-flex"><Icon name="help" className="h-4 w-4" /></Link>
            {!platform && c('appointment.read') && <div className="relative">
              <button onClick={() => setBell((o) => !o)} aria-label={requests + plansNew ? `${requests + plansNew} things need attention` : 'Notifications'} aria-expanded={bell} title="Notifications" className="relative btn btn-icon"><Icon name="bell" className="h-4 w-4" />{requests + plansNew > 0 && <span className="absolute -right-1 -top-1 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-ink px-1 text-[10.5px] font-bold text-paper anim-scale-in" style={{ boxShadow: '0 0 0 2px var(--color-paper)' }}>{requests + plansNew}</span>}</button>
              {bell && <><div className="fixed inset-0 z-30" onClick={() => setBell(false)} /><div className="menu anim-menu z-40 !w-[270px]" role="menu">
                {requests + plansNew === 0 && <div className="px-3 py-2.5 text-sm text-muted">Nothing new.</div>}
                {requests > 0 && <button role="menuitem" onClick={() => { setBell(false); nav('/bookings?tab=requests'); }}><Icon name="inbox" className="h-4 w-4" />{requests} online booking request{requests === 1 ? '' : 's'}</button>}
                {plansNew > 0 && <button role="menuitem" onClick={() => { setBell(false); nav('/worklist?tab=plans'); }}><Icon name="stetho" className="h-4 w-4" />{plansNew} new plan{plansNew === 1 ? '' : 's'} from the doctor</button>}
              </div></>}</div>}
            {!platform && (() => { const acts = createActions(c, loc.pathname); return acts.length > 0 && (
              <div className="relative shrink-0">
                <button onClick={() => setPlus((o) => !o)} aria-label="Create" aria-expanded={plus} className="btn btn-primary !min-h-10 !rounded-[11px] !px-3 sm:!px-4"><Icon name="plus" className="h-4 w-4" /><span className="hidden sm:inline">New</span></button>
                {plus && <><div className="fixed inset-0 z-30" onClick={() => setPlus(false)} />
                  <div className="menu anim-menu z-40 !w-[270px]" role="menu">{acts.map((x) => <button key={x.key} role="menuitem" onClick={() => { setPlus(false); nav(x.to, { viewTransition: true }); }}><Icon name={x.icon} className="h-4 w-4" />{x.label}</button>)}</div></>}
              </div>); })()}
            <div className="relative md:hidden">
              <button onClick={() => setUserMenu((o) => !o)} aria-label="Account"><Avatar name={me.data.name} size="h-8 w-8 text-xs" /></button>
              {userMenu && <div className="menu anim-menu" onMouseLeave={() => setUserMenu(false)}><div className="px-3 py-2"><div className="text-sm font-semibold">{me.data.name}</div><div className="text-xs text-muted">{roles.map(roleLabel).join(' · ')}</div></div><button onClick={signOut}><Icon name="logout" className="h-4 w-4" />Sign out</button></div>}
            </div>
        </header>

        <div className={`mx-auto w-full px-4 py-4 md:px-7 md:py-5 ${loc.pathname.startsWith('/encounter') || loc.pathname === '/queue' ? 'max-w-none' : 'max-w-[1520px]'} ${fit ? 'md:flex md:min-h-0 md:flex-1 md:flex-col' : 'pb-16'}`}>
          <main key={loc.pathname.split('/')[1]} className={`page ${fit ? 'md:flex-1 md:min-h-0 md:flex md:flex-col' : ''}`}>{blocked ? <NoAccess what={pageRule?.label} /> : <Outlet context={{ me: me.data, perms, cfg: cfg.data }} />}</main>
        </div>
      </div>
      <PrintHost />
      <ViewerHost />
      {params.get('book') === '1' && c('appointment.write') && cfg.data && <NewBooking cfg={cfg.data} me={me.data} initialPatient={params.get('patient') ? { id: params.get('patient')!, name: params.get('pname') ?? 'this patient' } : undefined} onClose={closeBook} onDone={() => { refreshBookings(); const rec = params.get('rec'); if (rec) patch(`/worklist/${rec}`, { status: 'scheduled' }).then(() => qc.invalidateQueries({ queryKey: ['worklist'] }), () => {}); closeBook(); }} />}
      <CommandPalette open={palette} onClose={() => setPalette(false)} can={c} />
      <ToastHost />
    </div>
  );
}
