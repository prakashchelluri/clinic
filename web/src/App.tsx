import { NavLink, Outlet, useNavigate } from 'react-router';
import { useMe, useConfig, post, qc } from './api';

const NAV = [
  ['/queue', 'Queue', 'visit.read'],
  ['/booking', 'Booking', 'appointment.read'],
  ['/patients', 'Patients', 'patient.read'],
  ['/worklist', 'Worklists', 'worklist.read'],
  ['/reports', 'Reports', 'report.daily'],
] as const;

export function can(perms: string[] | undefined, needed: string) {
  return !!perms?.some((p) => p === '*' || p === needed || (p.endsWith('.*') && needed.startsWith(p.slice(0, -1))));
}

export function App() {
  const me = useMe(); const cfg = useConfig(); const nav = useNavigate();
  if (me.isLoading) return <div className="p-8 text-slate-500">Loading…</div>;
  if (me.isError) { location.href = '/login'; return null; }
  const perms: string[] = me.data.perms;
  return (
    <div className="min-h-screen flex flex-col">
      <header className="no-print bg-emerald-800 text-white px-4 py-2 flex items-center gap-4">
        <div className="font-semibold">{cfg.data?.tenant.name ?? 'CUBOTT Clinical'}</div>
        <nav className="flex gap-1 text-sm">
          {NAV.filter(([, , p]) => can(perms, p)).map(([to, label]) => (
            <NavLink key={to} to={to} className={({ isActive }) => `px-3 py-1 rounded ${isActive ? 'bg-white/20' : 'hover:bg-white/10'}`}>{label}</NavLink>
          ))}
        </nav>
        <div className="ml-auto text-sm flex items-center gap-3">
          <span>{me.data.name} <span className="opacity-70">· {me.data.role}</span></span>
          <button className="btn btn-sm !bg-transparent !text-white !border-white/40" onClick={async () => { await post('/auth/logout'); qc.clear(); nav('/login'); }}>Logout</button>
        </div>
      </header>
      <main className="flex-1 p-4 max-w-7xl w-full mx-auto"><Outlet context={{ me: me.data, perms, cfg: cfg.data }} /></main>
    </div>
  );
}
