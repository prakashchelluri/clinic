import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { get } from '../api';
import { Avatar, Chip, Empty, Icon, Num, PageHeader, Section, Skeleton, Stat, money, fmtDate, Filter } from '../ui';

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
  if (!d) return <div><PageHeader title="Overview" /><Skeleton rows={4} /></div>;

  const series: { day: string; totalPaise: number }[] = range === '7' ? d.series.slice(-7) : d.series;
  const total = series.reduce((s, x) => s + x.totalPaise, 0);
  const max = Math.max(1, ...series.map((x) => x.totalPaise));
  const W = 1100, H = 150, pad = 12;
  const pts = series.map((x, i) => [(i / Math.max(1, series.length - 1)) * W, H - pad - (x.totalPaise / max) * (H - pad * 2)]);
  const line = pts.reduce((p, [x, y], i) => i === 0 ? `M${x},${y}` : `${p} C${(pts[i - 1][0] + x) / 2},${pts[i - 1][1]} ${(pts[i - 1][0] + x) / 2},${y} ${x},${y}`, '');
  const area = `${line} L${W},${H} L0,${H}Z`;
  const diff = d.today.visits - d.today.sameDayLastWeek;
  const hov = hover !== null ? { s: series[hover], p: pts[hover] } : null;
  const unconfirmed = counts.data?.unconfirmed ?? 0;

  return (
    <div>
      <PageHeader title="Overview" subtitle={new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}>
        {unconfirmed > 0 && <button className="btn" onClick={() => nav('/bookings?tab=unconfirmed')}><Icon name="message" className="h-4 w-4" />{unconfirmed} not yet confirmed</button>}
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Patients today" value={<Num value={d.today.visits} />} sub={diff ? <span className={diff > 0 ? 'text-sage' : 'text-muted'}>{diff > 0 ? '+' : ''}{diff} vs the same day last week</span> : 'same as last week'} />
        <Stat label="Collected today" value={<Num value={d.today.collectedPaise} format={money} />} sub={d.today.byMethod.length ? d.today.byMethod.map((m: any) => `${m.method} ${money(m.totalPaise)}`).join(' · ') : 'no payments yet'} delay={40} />
        <Stat label="Waiting now" value={<Num value={d.today.waiting} />} tone={d.today.longestWaitMin > 30 ? 'clay' : ''} sub={d.today.waiting ? `Longest ${d.today.longestWaitMin} min` : 'Nobody waiting'} delay={80} />
        <Stat label="Procedures today" value={<><Num value={d.rooms.filter((r: any) => r.state === 'completed').length} /><span className="text-[15px] text-muted"> / {d.rooms.length}</span></>} sub={d.rooms.length ? 'done so far' : 'nothing scheduled'} delay={120} />
      </div>

      <Section title="Collections" className="mt-4" delay={160} aside={<><Filter icon="calendar" value={range} onChange={setRange} options={[{ value: '7', label: 'Last 7 days' }, { value: '30', label: 'Last 30 days' }]} /><button className="btn btn-sm" onClick={() => nav('/reports')}>Daily report</button></>}>
        <div className="px-4 pt-3">
          <div className="flex items-baseline gap-3"><span className="text-[24px] font-semibold tracking-tight"><Num value={total} format={money} /></span><span className="text-xs text-muted">in {range} days · {money(Math.round(total / Math.max(1, series.length)))} a day</span></div>
          <div className="relative mt-1" onMouseLeave={() => setHover(null)}>
            <svg key={range} viewBox={`0 0 ${W} ${H}`} width="100%" height="150" role="img" aria-label={`Daily collections for ${range} days`} preserveAspectRatio="none"
              onMouseMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); setHover(Math.max(0, Math.min(series.length - 1, Math.round(((e.clientX - r.left) / r.width) * (series.length - 1))))); }}>
              <defs><linearGradient id="ga" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#C53B14" stopOpacity=".16" /><stop offset="1" stopColor="#C53B14" stopOpacity="0" /></linearGradient></defs>
              <g stroke="#E4E6EA"><line x1="0" y1={pad} x2={W} y2={pad} /><line x1="0" y1={H / 2} x2={W} y2={H / 2} /><line x1="0" y1={H - pad} x2={W} y2={H - pad} /></g>
              <path d={area} fill="url(#ga)" className="area-in" />
              <path d={line} fill="none" stroke="#C53B14" strokeWidth="2" strokeLinecap="round" pathLength={1} className="draw-line" style={{ ['--len' as any]: 1 }} vectorEffect="non-scaling-stroke" />
              {hov && <line x1={hov.p[0]} x2={hov.p[0]} y1="0" y2={H} stroke="#CDD1D6" />}
            </svg>
            {hov && <div className="pointer-events-none absolute -top-1 rounded-md bg-ink px-2.5 py-1 text-xs font-medium text-white anim-fade-in" style={{ left: `clamp(0px, calc(${(hov.p[0] / W) * 100}% - 40px), calc(100% - 120px))` }}>{fmtDate(hov.s.day)} · {money(hov.s.totalPaise)}</div>}
          </div>
        </div>
      </Section>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Section title="Waiting now" aside={<span className="text-xs text-muted">by arrival</span>} delay={200}>
          {d.waiting.length === 0 ? <Empty icon="clock" title="Nobody waiting" /> : d.waiting.map((w: any, i: number) => (
            <div key={w.id} className="flex h-10 items-center gap-3 border-t border-line px-4 text-[13px] first:border-t-0">
              <Avatar name={w.name} size="h-7 w-7 text-[10px]" />
              <span className="min-w-0 flex-1 truncate font-medium">{w.name}<span className="ml-2 font-normal text-muted">{w.opNumber}{w.doctor ? ` · ${w.doctor}` : ''}</span></span>
              <Chip tone={w.priority > 0 ? 'amber' : w.status === 'intake' ? 'sky' : i === 0 ? 'sage' : ''}>{w.priority > 0 ? 'Priority' : w.status === 'intake' ? 'Intake' : i === 0 ? 'Next' : 'Waiting'}</Chip>
              <span className={`w-14 text-right tabular-nums ${minsSince(w.arrivedAt) > 30 ? 'text-clay' : 'text-muted'}`}>{minsSince(w.arrivedAt)} min</span>
            </div>))}
        </Section>
        <Section title="Today in the rooms" aside={<span className="text-xs text-muted">{d.rooms.filter((r: any) => r.state === 'completed').length} of {d.rooms.length} done</span>} delay={240}>
          {d.rooms.length === 0 ? <Empty icon="stetho" title="Nothing scheduled" /> : d.rooms.map((r: any) => (
            <div key={r.id} className="flex h-10 items-center gap-3 border-t border-line px-4 text-[13px] first:border-t-0">
              <span className="w-12 tabular-nums text-muted">{r.startTime}</span>
              <span className="min-w-0 flex-1 truncate font-medium">{r.procedure ?? 'Procedure'} · {r.patient}<span className="ml-2 font-normal text-muted">{r.room ?? 'no room'}{r.doctor ? ` · ${r.doctor}` : ''}</span></span>
              <Chip tone={r.state === 'completed' ? 'sage' : r.state === 'in_progress' ? 'amber' : ''}>{r.state.replace('_', ' ')}</Chip>
            </div>))}
        </Section>
      </div>

      <Section title="Recent activity" className="mt-4" delay={280}>
        {d.activity.length === 0 ? <div className="px-4 py-4 text-sm text-muted">Nothing yet today.</div> : d.activity.map((a: any, i: number) => (
          <div key={i} className="flex h-10 items-center gap-3 border-t border-line px-4 text-[13px] first:border-t-0"><Avatar name={a.who} size="h-7 w-7 text-[10px]" /><span className="min-w-0 flex-1 truncate"><b>{a.who}</b> {a.text}</span><span className="text-xs text-muted">{ago(a.at)}</span></div>))}
      </Section>
    </div>
  );
}
