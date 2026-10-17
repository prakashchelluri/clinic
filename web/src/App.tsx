import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, Navigate, Outlet, useLocation, useNavigate } from 'react-router';
import { useMe, useConfig, post, qc } from './api';
import { Avatar, Icon, NoAccess, ToastHost } from './ui';
import { CommandPalette } from './palette';

export function can(perms: string[] | undefined, needed: string) {
  return !!perms?.some((p) => p === '*' || p === needed || (p.endsWith('.*') && needed.startsWith(p.slice(0, -1))));
}

export type NavItem = { to: string; label: string; show: (c: (p: string) => boolean) => boolean };
export const NAV: NavItem[] = [
  { to: '/overview', label: 'Overview', show: (c) => c('finance.read') },
  { to: '/today', label: 'Today', show: (c) => c('encounter.complete') },
  { to: '/queue', label: 'Front desk', show: (c) => c('visit.write') || (c('encounter.intake') && !c('encounter.complete')) },
  { to: '/booking', label: 'Booking', show: (c) => c('visit.write') && c('appointment.read') },
  { to: '/calendar', label: 'Calendar', show: (c) => c('appointment.read') },
  { to: '/patients', label: 'Patients', show: (c) => c('patient.read') },
  { to: '/worklist', label: 'Procedures', show: (c) => c('worklist.read') },
  { to: '/pharmacy', label: 'Pharmacy', show: (c) => c('pharmacy.read') },
  { to: '/expenses', label: 'Expenses', show: (c) => c('expense.read') },
  { to: '/reports', label: 'Reports', show: (c) => c('report.daily') || c('finance.read') },
  { to: '/settings', label: 'Settings', show: (c) => c('config.write') },
  { to: '/platform', label: 'Clinics', show: (c) => c('platform.read') },
];

/** Where each role lands: the page that answers their first question of the day. */
export function homeFor(c: (p: string) => boolean, platform = false) {
  if (platform) return '/platform';
  if (c('finance.read')) return '/overview';
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

export function App() {
  const me = useMe(); const cfg = useConfig(); const nav = useNavigate(); const loc = useLocation();
  const [palette, setPalette] = useState(false);
  const [userMenu, setUserMenu] = useState(false);
  const pills = useRef<HTMLDivElement>(null);
  const navBox = useRef<HTMLElement>(null);
  const [more, setMore] = useState(false);
  const checkMore = () => { const n = navBox.current; setMore(!!n && n.scrollWidth - n.clientWidth - n.scrollLeft > 8); };
  const [pill, setPill] = useState<{ left: number; width: number } | null>(null);
  const perms: string[] = me.data?.perms ?? [];
  const c = (p: string) => can(perms, p);
  const platform = me.data?.tenantKind === 'platform';
  const items = NAV.filter((n) => (n.to === '/platform' ? platform : !platform) && n.show(c));
  const fit = loc.pathname === '/queue'; // table pages: the page stays put, only the table scrolls
  // A page you cannot use is not shown, and typing its address gets a clear "no access" instead of an empty screen.
  const sub = loc.pathname.split('/')[1] ?? '';
  const pageRule = NAV.find((n) => n.to === '/' + sub) ?? (sub === 'encounter' ? { to: '', label: 'The consultation page', show: (x: (p: string) => boolean) => x('encounter.intake') } : null);
  const blocked = !!pageRule && (platform ? pageRule.to !== '/platform' : pageRule.to === '/platform' || !pageRule.show(c));
  const active = items.find((n) => loc.pathname === n.to || loc.pathname.startsWith(n.to + '/')) ?? null;

  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((o) => !o); } };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, []);
  useLayoutEffect(() => { checkMore(); window.addEventListener('resize', checkMore); return () => window.removeEventListener('resize', checkMore); }, [items.length, me.data?.id]);
  useLayoutEffect(() => {
    const measure = () => { const el = pills.current?.querySelector<HTMLElement>('a.on'); setPill(el ? { left: el.offsetLeft, width: el.offsetWidth } : null); };
    measure(); window.addEventListener('resize', measure); document.fonts?.ready.then(measure);
    return () => window.removeEventListener('resize', measure);
  }, [active?.to, items.length, me.data?.id]);

  if (me.isLoading) return <div className="min-h-dvh grid place-items-center text-muted text-sm anim-fade-in">Opening clinic…</div>;
  if (me.isError) { location.href = '/login'; return null; }
  const signOut = async () => { await post('/auth/logout'); qc.clear(); nav('/login'); };
  const clinic = cfg.data?.tenant.name ?? 'CUBOTT Clinical';
  const roles: string[] = me.data.roles ?? [me.data.role];

  const rail: { icon: string; tip: string; on?: () => void; to?: string; show: boolean }[] = [
    { icon: 'search', tip: 'Search  ⌘K', on: () => setPalette(true), show: !platform },
    { icon: 'plus', tip: 'Create', on: () => setPalette(true), show: !platform },
    { icon: 'calendar', tip: 'Calendar', to: '/calendar', show: c('appointment.read') && !platform },
    { icon: 'print', tip: 'Print this page', on: () => window.print(), show: true },
    { icon: 'edit', tip: 'Settings', to: '/settings', show: c('config.write') },
  ];

  return (
    <div className={fit ? 'min-h-dvh md:h-dvh md:overflow-hidden' : 'min-h-dvh'}>
      <aside className="no-print fixed left-6 top-40 z-20 hidden md:flex w-12 flex-col items-center gap-1.5 rounded-full bg-ink py-3.5 text-[#cfcac0]" style={{ boxShadow: '0 24px 40px -18px rgba(23,25,26,.6)' }} aria-label="Quick actions">
        {rail.filter((r) => r.show).map((r) => r.to
          ? <Link key={r.tip} to={r.to} viewTransition aria-label={r.tip} data-tip={r.tip} className="tip grid h-9 w-9 place-items-center rounded-full transition-colors duration-200 hover:bg-white/10 hover:text-white"><Icon name={r.icon} /></Link>
          : <button key={r.tip} onClick={r.on} aria-label={r.tip} data-tip={r.tip} className="tip grid h-9 w-9 place-items-center rounded-full transition-colors duration-200 hover:bg-white/10 hover:text-white"><Icon name={r.icon} /></button>)}
        <i className="my-1 h-px w-5 bg-white/15" />
        <button onClick={signOut} aria-label="Sign out" data-tip="Sign out" className="tip grid h-9 w-9 place-items-center rounded-full transition-colors duration-200 hover:bg-white/10 hover:text-white"><Icon name="logout" /></button>
      </aside>

      <div className={`mx-auto max-w-[1440px] px-4 pt-5 md:pl-[108px] md:pr-10 md:pt-7 ${fit ? 'pb-16 md:h-full md:flex md:flex-col md:pb-5' : 'pb-16'}`}>
        <header className="no-print flex items-center gap-3 md:gap-5">
          <Link to="/" className="flex items-center gap-3 min-w-0"><span className="grid h-[42px] w-[42px] shrink-0 place-items-center rounded-xl bg-ink text-xl font-bold text-white">{clinic.slice(0, 1)}</span><span className="truncate text-[19px] font-semibold">{clinic}</span></Link>
          <span className="ml-auto" />
          {!platform && <button onClick={() => setPalette(true)} className="hidden lg:flex h-10 min-w-[260px] items-center gap-2.5 rounded-full border border-white/80 bg-white/65 px-4 text-sm text-muted transition-colors duration-200 hover:bg-white">
            <Icon name="search" className="h-4 w-4" />Search patients<span className="kbd ml-auto">⌘K</span></button>}
          {!platform && (c('visit.write')
            ? <button onClick={() => nav('/queue?arrive=1')} aria-label="Check in" className="btn btn-accent !py-2.5 shrink-0"><Icon name="plus" className="h-4 w-4" /><span className="hidden sm:inline">Check in</span></button>
            : <button onClick={() => setPalette(true)} aria-label="Create" className="btn btn-accent !py-2.5 shrink-0"><Icon name="plus" className="h-4 w-4" /><span className="hidden sm:inline">Create</span></button>)}
          <div className="relative">
            <button onClick={() => setUserMenu((o) => !o)} aria-label="Account"><Avatar name={me.data.name} size="h-[42px] w-[42px] text-sm" /></button>
            {userMenu && <div className="menu anim-menu" onMouseLeave={() => setUserMenu(false)}><div className="px-3 py-2"><div className="text-sm font-semibold">{me.data.name}</div><div className="text-xs text-muted capitalize">{roles.join(' · ')}</div></div><button onClick={signOut}><Icon name="logout" className="h-4 w-4" />Sign out</button></div>}
          </div>
        </header>

        <nav ref={navBox} onScroll={checkMore} className="no-print no-scrollbar mt-5 mb-6 -mx-1 overflow-x-auto px-1 pb-1" style={more ? { WebkitMaskImage: 'linear-gradient(to right, #000 calc(100% - 36px), transparent)', maskImage: 'linear-gradient(to right, #000 calc(100% - 36px), transparent)' } : undefined} aria-label="Sections">
          <div ref={pills} className="relative inline-flex gap-1 rounded-full border border-white/75 bg-white/50 p-1">
            {pill && <span className="absolute top-1 bottom-1 rounded-full bg-ink" style={{ left: pill.left, width: pill.width, transition: 'left .45s var(--ease), width .45s var(--ease)' }} />}
            {items.map((n) => (
              <Link key={n.to} to={n.to} viewTransition className={`relative z-[1] whitespace-nowrap rounded-full px-[18px] py-2.5 text-sm font-medium transition-colors duration-300 ${active?.to === n.to ? 'on text-white' : 'text-ink-2 hover:text-ink'}`}>{n.label}</Link>
            ))}
          </div>
        </nav>

        <main key={loc.pathname.split('/')[1]} className={`page ${fit ? 'md:flex-1 md:min-h-0 md:flex md:flex-col' : ''}`}>{blocked ? <NoAccess what={pageRule?.label} /> : <Outlet context={{ me: me.data, perms, cfg: cfg.data }} />}</main>
      </div>
      <CommandPalette open={palette} onClose={() => setPalette(false)} can={c} />
      <ToastHost />
    </div>
  );
}
