import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { get, today } from '../api';
import { Chip, PageHeader, Segmented, Skeleton, fmtDate, money } from '../ui';

type Range = 'today' | 'week' | 'month';
const addDays = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const span = (r: Range) => { const to = today(); return { from: r === 'today' ? to : r === 'week' ? addDays(to, -6) : addDays(to, -29), to }; };
const delta = (now: number | null, before: number | null, unit: string, lowerIsBetter = true) => {
  if (now === null || before === null) return <span className="text-muted">no earlier figure</span>;
  const d = Math.round((now - before) * 10) / 10; if (d === 0) return <span className="text-muted">same as before</span>;
  const good = lowerIsBetter ? d < 0 : d > 0;
  return <span className={good ? 'text-sage' : 'text-rose'}>{Math.abs(d)}{unit} {d < 0 ? 'less' : 'more'} than the period before</span>;
};

/** One tile per doctor, the daily trend with its average, and the times that matter, each against the period before. */
export function Dashboard() {
  const [range, setRange] = useState<Range>('month');
  const { from, to } = span(range);
  const q = useQuery({ queryKey: ['dashboard', from, to], queryFn: () => get(`/dashboard?from=${from}&to=${to}`) });
  const d = q.data;
  if (!d) return <div><PageHeader title="Dashboard" subtitle="Loading…" /><Skeleton rows={4} /></div>;
  const max = Math.max(1, ...d.trend.map((x: any) => x.patients));
  return (
    <div>
      <PageHeader title="Dashboard" subtitle={`${fmtDate(d.from)} to ${fmtDate(d.to)} · compared with the same length of time before`}>
        <Segmented<Range> value={range} onChange={setRange} options={[{ value: 'today', label: 'Today' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }]} />
      </PageHeader>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {d.tiles.map((t: any) => (
          <div key={t.id} className="card">
            <div className="text-sm font-medium">{t.name}</div>
            <div className="mt-1 flex items-end gap-4"><div>{!d.moneyHidden && <div className="serif text-3xl">{money(t.revenuePaise)}</div>}<div className="text-sm text-muted">{t.patients} patients</div></div></div>
            {!d.moneyHidden && t.revenuePaise > 0 && <div className="mt-3"><div className="flex h-2 overflow-hidden rounded-full bg-ink/10"><i className="block bg-sage" style={{ width: `${Math.round((t.paidPaise / t.revenuePaise) * 100)}%` }} /></div><div className="mt-1 text-xs text-muted">paid {Math.round((t.paidPaise / t.revenuePaise) * 100)}% · pending {money(t.pendingPaise)}</div></div>}
            {t.patients > 0 && <div className="mt-3"><div className="flex h-2 overflow-hidden rounded-full bg-ink/10"><i className="block bg-clay" style={{ width: `${Math.round((t.newPatients / t.patients) * 100)}%` }} /></div><div className="mt-1 text-xs text-muted">new {t.newPatients} · review {t.reviews}</div></div>}
          </div>))}
      </div>
      <div className="card mt-4">
        <div className="flex items-center gap-2"><b className="text-sm">Patients per day</b><span className="text-xs text-muted">average {d.averagePerDay}</span>{d.busiest && <Chip>busiest {fmtDate(d.busiest.day)}, {d.busiest.patients}</Chip>}{d.quietest && <Chip>quietest {fmtDate(d.quietest.day)}, {d.quietest.patients}</Chip>}</div>
        <div className="relative mt-3 flex h-32 items-end gap-[3px]" role="img" aria-label={`Patients per day, average ${d.averagePerDay}`}>
          <div className="pointer-events-none absolute inset-x-0 border-t border-dashed border-ink/40" style={{ bottom: `${(d.averagePerDay / max) * 100}%` }} />
          {d.trend.map((x: any) => <div key={x.day} title={`${fmtDate(x.day)}: ${x.patients}`} className="flex-1 rounded-t bg-clay/70" style={{ height: `${Math.max(2, (x.patients / max) * 100)}%` }} />)}
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          ['Wait before the doctor', d.times.now.waitMin, d.times.before.waitMin, ' min'], ['Time with the doctor', d.times.now.withDoctorMin, d.times.before.withDoctorMin, ' min'],
          ['Missed or no-show', d.missed.now, d.missed.before, ''], ['Cancelled', d.cancelled.now, d.cancelled.before, ''],
        ].map(([label, now, before, unit]: any) => (
          <div key={label} className="card"><div className="text-xs text-muted">{label}</div><div className="serif text-2xl">{now === null ? '–' : `${now}${unit}`}</div><div className="text-xs">{delta(now, before, unit)}</div></div>))}
      </div>
      <div className="card mt-4"><b className="text-sm">Visits by type</b><div className="mt-2 flex flex-wrap gap-2">{Object.entries(d.types).map(([k, v]) => <Chip key={k}>{k} {v as number}</Chip>)}</div></div>
    </div>
  );
}
