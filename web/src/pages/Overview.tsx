import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { get } from '../api';
import { Avatar, Chip, Empty, Icon, Num, Segmented, Skeleton, money, fmtDate } from '../ui';

const minsSince = (iso: string) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
const ago = (iso: string) => { const m = minsSince(iso); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : fmtDate(iso); };

/** Owner / admin home. The only page with revenue on it. */
export function Overview() {
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['overview'], queryFn: () => get('/overview'), refetchInterval: 15000 });
  const counts = useQuery({ queryKey: ['bookings', 'counts'], queryFn: () => get('/bookings/counts'), refetchInterval: 30000 });
  const [range, setRange] = useState<'7' | '30'>('30');
  const [hover, setHover] = useState<number | null>(null);
  const d = q.data;
  if (!d) return <div className="space-y-4"><Skeleton rows={2} /><Skeleton rows={4} /></div>;

  const series: { day: string; totalPaise: number }[] = range === '7' ? d.series.slice(-7) : d.series;
  const total = series.reduce((s, x) => s + x.totalPaise, 0);
  const max = Math.max(1, ...series.map((x) => x.totalPaise));
  const W = 1100, H = 170, pad = 14;
  const pts = series.map((x, i) => [(i / Math.max(1, series.length - 1)) * W, H - pad - (x.totalPaise / max) * (H - pad * 2)]);
  const line = pts.reduce((p, [x, y], i) => i === 0 ? `M${x},${y}` : `${p} C${(pts[i - 1][0] + x) / 2},${pts[i - 1][1]} ${(pts[i - 1][0] + x) / 2},${y} ${x},${y}`, '');
  const area = `${line} L${W},${H} L0,${H}Z`;
  const diff = d.today.visits - d.today.sameDayLastWeek;
  const hov = hover !== null ? { s: series[hover], p: pts[hover] } : null;

  return (
    <div>
      <div className="anim-fade-up flex flex-wrap items-center gap-x-9 gap-y-4 mb-5">
        <h1 className="text-[30px] leading-[1.05] font-semibold">Clinic<br />Overview</h1>
        <Kpi icon="users" value={<Num value={d.today.visits} />} label="Patients today" badge={diff ? `${diff > 0 ? '+' : ''}${diff} vs last week` : undefined} />
        <Kpi icon="rupee" value={<Num value={d.today.collectedPaise} format={money} />} label={d.today.byMethod.length ? d.today.byMethod.map((m: any) => `${m.method} ${money(m.totalPaise)}`).join(' · ') : 'Collected today'} />
        <Kpi icon="clock" value={<><Num value={d.today.waiting} /> <span className="text-[15px] font-medium text-muted">waiting</span></>} label={d.today.waiting ? `Longest ${d.today.longestWaitMin} min` : 'Nobody waiting'} />
      </div>

      {(counts.data?.requests > 0 || counts.data?.unconfirmed > 0) && (
        <div className="mb-5 flex flex-wrap gap-3 anim-fade-up" style={{ animationDelay: '30ms' }}>
          {counts.data.requests > 0 && <button className="glass flex items-center gap-3 !rounded-[20px] px-4 py-3 text-left transition-shadow hover:shadow-md" onClick={() => nav('/bookings?tab=requests')}><Icon name="inbox" className="h-5 w-5 text-clay" /><span><b>{counts.data.requests} online request{counts.data.requests === 1 ? '' : 's'}</b><span className="block text-xs text-muted">waiting for approval</span></span><Icon name="chevR" className="ml-2 h-4 w-4 text-muted" /></button>}
          {counts.data.unconfirmed > 0 && <button className="glass flex items-center gap-3 !rounded-[20px] px-4 py-3 text-left transition-shadow hover:shadow-md" onClick={() => nav('/bookings?tab=unconfirmed')}><Icon name="message" className="h-5 w-5 text-muted" /><span><b>{counts.data.unconfirmed} not yet confirmed</b><span className="block text-xs text-muted">upcoming bookings</span></span><Icon name="chevR" className="ml-2 h-4 w-4 text-muted" /></button>}
        </div>
      )}

      <section className="glass p-5 mb-5 anim-fade-up" style={{ animationDelay: '60ms' }}>
        <div className="flex items-center gap-3">
          <div className="text-[15px] font-semibold">Collections</div>
          <span className="ml-auto"><Segmented value={range} onChange={setRange} options={[{ value: '7', label: '7D' }, { value: '30', label: '30D' }]} /></span>
          <button className="btn btn-icon" aria-label="Open reports" onClick={() => nav('/reports')}><Icon name="up" className="h-4 w-4 rotate-45" /></button>
        </div>
        <div className="mt-1.5 flex items-baseline gap-3"><span className="text-[34px] font-semibold tracking-tight"><Num value={total} format={money} /></span><span className="text-sm text-muted">in {range} days · average {money(Math.round(total / series.length))} a day</span></div>
        <div className="relative mt-2" onMouseLeave={() => setHover(null)}>
          <svg key={range} viewBox={`0 0 ${W} ${H}`} width="100%" height="170" role="img" aria-label={`Daily collections for ${range} days`} preserveAspectRatio="none"
            onMouseMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); setHover(Math.max(0, Math.min(series.length - 1, Math.round(((e.clientX - r.left) / r.width) * (series.length - 1))))); }}>
            <defs><linearGradient id="ga" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#D4421A" stopOpacity=".28" /><stop offset="1" stopColor="#D4421A" stopOpacity="0" /></linearGradient></defs>
            <g stroke="rgba(23,25,26,.12)" strokeDasharray="2 5"><line x1="0" y1="20" x2={W} y2="20" /><line x1="0" y1="85" x2={W} y2="85" /><line x1="0" y1="150" x2={W} y2="150" /></g>
            <path d={area} fill="url(#ga)" className="area-in" />
            <path d={line} fill="none" stroke="#D4421A" strokeWidth="2.4" strokeLinecap="round" pathLength={1} className="draw-line" style={{ ['--len' as any]: 1 }} vectorEffect="non-scaling-stroke" />
            {hov && <line x1={hov.p[0]} x2={hov.p[0]} y1="0" y2={H} stroke="rgba(23,25,26,.25)" />}
          </svg>
          {hov && <div className="pointer-events-none absolute -top-1 rounded-xl bg-ink px-3 py-1.5 text-xs font-semibold text-white anim-fade-in" style={{ left: `clamp(0px, calc(${(hov.p[0] / W) * 100}% - 40px), calc(100% - 120px))` }}>{fmtDate(hov.s.day)} · {money(hov.s.totalPaise)}</div>}
        </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-[1.1fr_minmax(0,1fr)] gap-5">
        <section className="glass p-5 anim-fade-up" style={{ animationDelay: '100ms' }}>
          <div className="flex items-center"><div className="text-[15px] font-semibold">Waiting now</div><span className="ml-auto text-xs text-muted">by arrival</span></div>
          {d.waiting.length === 0 ? <Empty icon="clock" title="Nobody waiting" /> : (
            <div className="mt-4 grid sm:grid-cols-3 gap-3 stagger">
              {d.waiting.map((w: any, i: number) => (
                <div key={w.id} style={{ ['--i' as any]: i }} className="dark-card p-4">
                  <div className={`text-xs ${w.priority > 0 ? 'text-[#f0b84a]' : w.status === 'intake' ? 'text-[#8fb7ff]' : 'text-[#a9a59c]'}`}>{w.priority > 0 ? 'Priority' : w.status === 'intake' ? 'Intake' : i === 0 ? 'Next' : 'Waiting'} · {minsSince(w.arrivedAt)} min</div>
                  <div className="mt-2 text-lg font-semibold truncate">{w.name}</div><div className="text-[12.5px] text-[#a9a59c]">{w.opNumber}{w.doctor ? ` · ${w.doctor}` : ''}</div>
                </div>))}
            </div>)}
        </section>
        <section className="glass p-5 anim-fade-up" style={{ animationDelay: '140ms' }}>
          <div className="flex items-center"><div className="text-[15px] font-semibold">Today in the rooms</div><span className="ml-auto text-xs text-muted">{d.rooms.filter((r: any) => r.state === 'completed').length} of {d.rooms.length} done</span></div>
          {d.rooms.length === 0 ? <Empty icon="stetho" title="Nothing scheduled" /> : <div className="mt-2">{d.rooms.map((r: any) => (
            <div key={r.id} className="flex items-center gap-3 py-2.5 border-t border-ink/7 first:border-t-0"><Chip>{r.startTime}</Chip><div className="flex-1 min-w-0"><div className="text-sm font-semibold truncate">{r.procedure ?? 'Procedure'} · {r.patient}</div><div className="text-xs text-muted">{r.room ?? 'no room'}{r.doctor ? ` · ${r.doctor}` : ''}</div></div><Chip tone={r.state === 'completed' ? 'sage' : r.state === 'in_progress' ? 'amber' : undefined}>{r.state.replace('_', ' ')}</Chip></div>))}</div>}
        </section>
      </div>

      <section className="glass p-5 mt-5 anim-fade-up" style={{ animationDelay: '180ms' }}>
        <div className="text-[15px] font-semibold">Recent activity</div>
        <div className="mt-2">{d.activity.length === 0 ? <div className="py-4 text-sm text-muted">Nothing yet today.</div> : d.activity.map((a: any, i: number) => (
          <div key={i} className="flex items-center gap-3 py-2.5 border-t border-ink/7 first:border-t-0"><Avatar name={a.who} size="h-9 w-9 text-xs" /><div className="flex-1 text-sm"><b>{a.who}</b> {a.text}</div><span className="text-xs text-muted">{ago(a.at)}</span></div>))}</div>
      </section>
    </div>
  );
}

function Kpi({ icon, value, label, badge }: { icon: string; value: React.ReactNode; label: string; badge?: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="grid h-11 w-11 place-items-center rounded-full bg-white shadow-sm"><Icon name={icon} className="h-[18px] w-[18px]" /></span>
      <div><div className="flex items-center gap-2"><span className="text-[26px] font-semibold leading-none tracking-tight">{value}</span>{badge && <span className="rounded-full bg-sage px-2.5 py-0.5 text-[11px] font-bold text-white">{badge}</span>}</div><div className="mt-1 text-[12.5px] text-muted">{label}</div></div>
    </div>
  );
}
