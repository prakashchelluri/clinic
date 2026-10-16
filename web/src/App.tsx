import { NavLink, Outlet, useNavigate } from 'react-router';
import { useMe, useConfig, post, qc } from './api';
import { Avatar, Icon, ToastHost } from './ui';

const NAV = [
  ['/queue', 'Queue', 'queue', 'visit.read'],
  ['/booking', 'Booking', 'calendar', 'appointment.read'],
  ['/patients', 'Patients', 'users', 'patient.read'],
  ['/worklist', 'Worklists', 'list', 'worklist.read'],
  ['/reports', 'Reports', 'chart', 'report.daily'],
] as const;

export function can(perms: string[] | undefined, needed: string) {
  return !!perms?.some((p) => p === '*' || p === needed || (p.endsWith('.*') && needed.startsWith(p.slice(0, -1))));
}

const greeting = () => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; };

export function App() {
  const me = useMe(); const cfg = useConfig(); const nav = useNavigate();
  if (me.isLoading) return <div className="min-h-dvh grid place-items-center text-muted text-sm anim-fade-in">Opening clinic…</div>;
  if (me.isError) { location.href = '/login'; return null; }
  const perms: string[] = me.data.perms;
  const items = NAV.filter(([, , , p]) => can(perms, p));
  return (
    <div className="min-h-dvh md:grid md:grid-cols-[232px_1fr]">
      <aside className="no-print hidden md:flex flex-col gap-1 p-4 sticky top-0 h-dvh border-r border-line/70">
        <div className="px-3 pt-2 pb-5">
          <div className="serif text-[22px] leading-none text-ink">{cfg.data?.tenant.name ?? 'CUBOTT'}</div>
          <div className="text-[11px] uppercase tracking-wider text-muted mt-1.5">CUBOTT Clinical</div>
        </div>
        {items.map(([to, label, icon]) => (
          <NavLink key={to} to={to} viewTransition className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
            {({ isActive }) => (<><span className={`transition-colors ${isActive ? 'text-clay' : 'text-muted'}`}><Icon name={icon} className="h-[18px] w-[18px]" /></span>{label}</>)}
          </NavLink>
        ))}
        <div className="mt-auto card !p-3 flex items-center gap-3">
          <Avatar name={me.data.name} />
          <div className="min-w-0 flex-1"><div className="text-sm font-medium truncate">{me.data.name}</div><div className="text-[11px] text-muted capitalize">{me.data.role}</div></div>
          <button className="btn btn-ghost btn-icon" title="Sign out" onClick={async () => { await post('/auth/logout'); qc.clear(); nav('/login'); }}><Icon name="logout" /></button>
        </div>
      </aside>
      <div className="min-w-0">
        <header className="no-print md:hidden flex items-center gap-3 px-4 py-3 border-b border-line/70 bg-paper/80 backdrop-blur sticky top-0 z-10">
          <div className="serif text-lg">{cfg.data?.tenant.name}</div>
          <button className="btn btn-ghost btn-icon ml-auto" onClick={async () => { await post('/auth/logout'); qc.clear(); nav('/login'); }}><Icon name="logout" /></button>
        </header>
        <main className="p-4 md:p-8 max-w-[1280px] mx-auto pb-24 md:pb-8">
          <div className="hidden md:block text-sm text-muted mb-1 anim-fade-in">{greeting()}, {me.data.name.split(' ')[0]}</div>
          <Outlet context={{ me: me.data, perms, cfg: cfg.data }} />
        </main>
        <nav className="no-print md:hidden fixed bottom-0 inset-x-0 z-20 flex justify-around border-t border-line bg-surface/90 backdrop-blur px-2 py-2">
          {items.map(([to, label, icon]) => (
            <NavLink key={to} to={to} viewTransition className={({ isActive }) => `flex flex-col items-center gap-0.5 px-3 py-1 rounded-xl text-[10px] font-medium ${isActive ? 'text-clay' : 'text-muted'}`}><Icon name={icon} className="h-5 w-5" />{label}</NavLink>
          ))}
        </nav>
      </div>
      <ToastHost />
    </div>
  );
}
