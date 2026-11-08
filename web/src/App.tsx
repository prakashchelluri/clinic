import { useEffect, useState } from 'react';
import { Link, Navigate, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useMe, useConfig, post, get, patch, qc, ApiError } from './api';
import { Avatar, Icon, NoAccess, ToastHost, useScrollLock } from './ui';
import { CommandPalette, createActions } from './palette';
import { NewBooking } from './pages/Booking';
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
function Sidebar({ items, active, clinic, me, roles, requests, onSignOut, onNavigate }: { items: NavItem[]; active: NavItem | null; clinic: string; me: any; roles: string[]; requests: number; onSignOut: () => void; onNavigate?: () => void }) {
  const link = (n: NavItem) => (
    <Link key={n.to} to={n.to} viewTransition onClick={onNavigate} aria-current={active?.to === n.to ? 'page' : undefined} className={`nav-item ${active?.to === n.to ? 'active' : ''}`}>
      <Icon name={n.icon} className="h-4 w-4 shrink-0" /><span className="flex-1 truncate">{n.label}</span>
      {n.to === '/bookings' && requests > 0 && <span className="chip chip-clay" aria-label={`${requests} online requests`}>{requests}</span>}
    </Link>
  );
  const main = items.filter((n) => !n.group); const clinicItems = items.filter((n) => n.group === 'clinic');
  return (
    <div className="flex h-full flex-col px-2.5 py-3">
      <Link to="/" onClick={onNavigate} className="flex items-center gap-2.5 px-2 pb-3 pt-1"><span className="grid h-7 w-7 shrink-0 place-items-center rounded-[7px] bg-brand text-[13px] font-bold text-white" style={{ fontFamily: 'Urbanist, Inter, sans-serif' }}>{clinic.slice(0, 1)}</span><span className="truncate text-[13px] font-semibold leading-tight">{clinic}</span></Link>
      <nav className="flex flex-col gap-px overflow-y-auto no-scrollbar" aria-label="Sections">
        {main.map(link)}
        {clinicItems.length > 0 && <div className="px-2.5 pb-1 pt-3.5 text-[11px] font-semibold uppercase tracking-[.06em] text-muted">Clinic</div>}
        {clinicItems.map(link)}
      </nav>
      <Link to="/help" onClick={onNavigate} className="nav-item mt-auto"><Icon name="help" className="h-4 w-4" /><span>Help</span></Link>
      <div className="mt-1.5 flex items-center gap-2.5 border-t border-line px-2 pt-3">
        <Avatar name={me.name} size="h-7 w-7 text-[11px]" />
        <div className="min-w-0 flex-1"><div className="truncate text-[12.5px] font-semibold">{me.name}</div><div className="truncate text-[11px] capitalize text-muted">{roles.join(' · ')}</div></div>
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
  const roles: string[] = me.data.roles ?? [me.data.role];
  const side = { items, active, clinic, me: me.data, roles, requests, onSignOut: signOut };

  return (
    <div className={fit ? 'min-h-dvh md:h-dvh md:overflow-hidden' : 'min-h-dvh'}>
      <aside className="no-print fixed inset-y-0 left-0 z-20 hidden w-[224px] border-r border-line bg-[#FAFAFB] md:block" aria-label="Main">
        <Sidebar {...side} />
      </aside>
      {drawer && (
        <div className="no-print fixed inset-0 z-40 md:hidden anim-fade-in" style={{ background: 'rgba(21,24,27,.4)' }} onClick={() => setDrawer(false)}>
          <aside className="h-full w-[264px] max-w-[85vw] bg-[#FAFAFB] anim-slide-in" style={{ boxShadow: 'var(--shadow-lift)' }} onClick={(e) => e.stopPropagation()} aria-label="Main"><Sidebar {...side} onNavigate={() => setDrawer(false)} /></aside>
        </div>
      )}

      <div className={`md:pl-[224px] ${fit ? 'md:flex md:h-full md:flex-col' : ''}`}>
        <header className="no-print sticky top-0 z-30 flex h-12 shrink-0 items-center gap-1.5 border-b border-line bg-surface px-3 md:px-5">
          <button className="btn btn-ghost btn-icon md:hidden" aria-label="Open menu" onClick={() => setDrawer(true)}><Icon name="menu" /></button>
          <span className="truncate text-[14px] font-semibold">{active?.label ?? (loc.pathname.startsWith('/encounter') ? 'Consultation' : loc.pathname.startsWith('/help') ? 'Help' : clinic)}</span>
          <span className="ml-auto" />
          {!platform && <button onClick={() => setPalette(true)} className="mr-1.5 hidden h-8 w-[260px] items-center gap-2 rounded-lg border border-line-2 bg-surface-2 px-2.5 text-[12.5px] text-muted hover:border-muted lg:flex" aria-label="Search patients (Ctrl K)"><Icon name="search" className="h-3.5 w-3.5" /><span className="flex-1 text-left">Patient, phone or ID</span><span className="kbd">Ctrl K</span></button>}
          {!platform && <button onClick={() => setPalette(true)} aria-label="Search patients" title="Search patients (Ctrl K)" className="btn btn-ghost btn-icon lg:hidden"><Icon name="search" /></button>}
          <Link to={`/help?from=${encodeURIComponent(loc.pathname.split('/')[1] ?? '')}`} aria-label="Help: how the clinic runs" title="Help: how the clinic runs" className="btn btn-ghost btn-icon"><Icon name="help" /></Link>
            {!platform && c('appointment.read') && <div className="relative">
              <button onClick={() => setBell((o) => !o)} aria-label={requests + plansNew ? `${requests + plansNew} things need attention` : 'Notifications'} aria-expanded={bell} title="Notifications" className="relative btn btn-ghost btn-icon"><Icon name="bell" />{requests + plansNew > 0 && <span className="absolute right-0.5 top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-clay px-1 text-[10px] font-bold text-white anim-scale-in">{requests + plansNew}</span>}</button>
              {bell && <><div className="fixed inset-0 z-30" onClick={() => setBell(false)} /><div className="menu anim-menu z-40 !w-[270px]" role="menu">
                {requests + plansNew === 0 && <div className="px-3 py-2.5 text-sm text-muted">Nothing new.</div>}
                {requests > 0 && <button role="menuitem" onClick={() => { setBell(false); nav('/bookings?tab=requests'); }}><Icon name="inbox" className="h-4 w-4" />{requests} online booking request{requests === 1 ? '' : 's'}</button>}
                {plansNew > 0 && <button role="menuitem" onClick={() => { setBell(false); nav('/worklist?tab=plans'); }}><Icon name="stetho" className="h-4 w-4" />{plansNew} new plan{plansNew === 1 ? '' : 's'} from the doctor</button>}
              </div></>}</div>}
            {!platform && (() => { const acts = createActions(c, loc.pathname); return acts.length > 0 && (
              <div className="relative shrink-0">
                <button onClick={() => setPlus((o) => !o)} aria-label="Create" aria-expanded={plus} className="btn btn-primary !min-h-8 !px-2.5 sm:!px-3"><Icon name="plus" className="h-4 w-4" /><span className="hidden sm:inline">New</span></button>
                {plus && <><div className="fixed inset-0 z-30" onClick={() => setPlus(false)} />
                  <div className="menu anim-menu z-40 !w-[270px]" role="menu">{acts.map((x) => <button key={x.key} role="menuitem" onClick={() => { setPlus(false); nav(x.to, { viewTransition: true }); }}><Icon name={x.icon} className="h-4 w-4" />{x.label}</button>)}</div></>}
              </div>); })()}
            <div className="relative md:hidden">
              <button onClick={() => setUserMenu((o) => !o)} aria-label="Account"><Avatar name={me.data.name} size="h-8 w-8 text-xs" /></button>
              {userMenu && <div className="menu anim-menu" onMouseLeave={() => setUserMenu(false)}><div className="px-3 py-2"><div className="text-sm font-semibold">{me.data.name}</div><div className="text-xs text-muted capitalize">{roles.join(' · ')}</div></div><button onClick={signOut}><Icon name="logout" className="h-4 w-4" />Sign out</button></div>}
            </div>
        </header>

        <div className={`mx-auto w-full max-w-[1440px] px-4 py-4 md:px-5 ${fit ? 'md:flex md:min-h-0 md:flex-1 md:flex-col' : 'pb-16'}`}>
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
