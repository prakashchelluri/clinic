import { useEffect, useState, type ReactNode } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useOutletContext, useSearchParams } from 'react-router';
import { get, today, fmtTime, listOut } from '../api';
import { can } from '../App';
import { EmiAwaiting } from '../takePayment';
import { EndOfDay } from '../endOfDay';
import { downloadCsv } from '../table';
import { LoadError } from '../procBoard';
import { Chip, Empty, Filter, Icon, PageHeader, Section, Segmented, Skeleton, Stat, Tabs, fmtDate, money } from '../ui';

type Tab = 'overview' | 'visits' | 'patients' | 'clinical' | 'day';
type Range = 'today' | 'yesterday' | '7d' | '30d' | 'month' | 'last' | 'pick';
type Row = { name: string; n: number };
const addDays = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const RANGES: { value: Range; label: string }[] = [{ value: 'today', label: 'Today' }, { value: 'yesterday', label: 'Yesterday' }, { value: '7d', label: 'Last 7 days' }, { value: '30d', label: 'Last 30 days' }, { value: 'month', label: 'This month' }, { value: 'last', label: 'Last month' }, { value: 'pick', label: 'Pick dates' }];
function spanOf(r: Range, sp: URLSearchParams) {
  const t = today(); const m1 = t.slice(0, 8) + '01';
  if (r === 'today') return { from: t, to: t };
  if (r === 'yesterday') return { from: addDays(t, -1), to: addDays(t, -1) };
  if (r === '7d') return { from: addDays(t, -6), to: t };
  if (r === 'month') return { from: m1, to: t };
  if (r === 'last') { const end = addDays(m1, -1); return { from: end.slice(0, 8) + '01', to: end }; }
  if (r === 'pick') { const ok = (s: string | null) => (/^\d{4}-\d{2}-\d{2}$/.test(s ?? '') ? s! : null); return { from: ok(sp.get('from')) ?? addDays(t, -29), to: ok(sp.get('to')) ?? t }; }
  return { from: addDays(t, -29), to: t };
}

/** Change against the period before, in words: green when it went the good way. */
function Change({ now, before, lowerIsBetter = false }: { now: number | null; before: number | null; lowerIsBetter?: boolean }) {
  if (now === null || before === null) return <span className="text-muted">no earlier figure</span>;
  if (now === before) return <span className="text-muted">same as the period before</span>;
  const good = lowerIsBetter ? now < before : now > before;
  const pct = before ? `${Math.round((Math.abs(now - before) / before) * 100)}%` : 'up from 0';
  return <span className={good ? 'text-sage' : 'text-rose'}>{now > before ? '↑' : '↓'} {before ? pct : ''}{before ? ' vs the period before' : pct}</span>;
}

/** A ranked list as plain horizontal bars: name, bar, count. */
function Bars({ rows, empty = 'Nothing in this period' }: { rows: Row[]; empty?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  if (!rows.length) return <div className="px-4 py-3 text-sm text-muted">{empty}</div>;
  return (
    <div className="space-y-1.5 px-4 py-3">{rows.map((r) => (
      <div key={r.name} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_40px] items-center gap-3 text-[13.5px]">
        <span className="truncate" title={r.name}>{r.name}</span>
        <span className="h-2.5 rounded-full bg-paper-2"><i className="block h-full rounded-full bg-clay" style={{ width: `${(r.n / max) * 100}%` }} /></span>
        <b className="text-right tabular-nums">{r.n}</b>
      </div>))}</div>
  );
}

/** Upright bars under labels: days of the week, hours, days of the period. */
function Columns({ rows, label, average }: { rows: { key: string; label: string; n: number; title?: string }[]; label: string; average?: number }) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  return (
    <div className="px-4 py-3">
      <div className="relative flex h-32 items-end gap-[3px]" role="img" aria-label={`${label}: ${rows.map((r) => `${r.title ?? r.label} ${r.n}`).join(', ')}`}>
        {average !== undefined && average > 0 && <div className="pointer-events-none absolute inset-x-0 border-t border-dashed border-ink-2" style={{ bottom: `${(average / max) * 100}%` }} title={`average ${average}`} />}
        {rows.map((r) => <div key={r.key} title={`${r.title ?? r.label}: ${r.n}`} className="flex-1 rounded-t bg-clay" style={{ height: `${Math.max(r.n ? 4 : 1, (r.n / max) * 100)}%`, opacity: r.n ? 1 : 0.25 }} />)}
      </div>
      {rows.length <= 24 && <div className="mt-1 flex gap-[3px] text-center text-[11px] text-muted">{rows.map((r) => <span key={r.key} className="flex-1 truncate">{r.label}</span>)}</div>}
    </div>
  );
}

const WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const hourLabel = (h: number) => (h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`);

/** Reports: the clinic's basic figures for a period, each against the period before; and the Day tab (daily report, End of day) the front desk closes with. */
export function Reports() {
  const { perms, me } = useOutletContext<any>();
  const [sp, setSp] = useSearchParams();
  const analytics = can(perms, 'report.read'); const daily = can(perms, 'report.daily') || can(perms, 'finance.read');
  const clinical = can(perms, 'encounter.complete') || can(perms, 'encounter.intake');
  const tabs: { value: Tab; label: string }[] = [...(analytics ? [{ value: 'overview' as Tab, label: 'Overview' }, { value: 'visits' as Tab, label: 'Visits' }, { value: 'patients' as Tab, label: 'Patients' }, ...(clinical ? [{ value: 'clinical' as Tab, label: 'Clinical' }] : [])] : []), ...(daily ? [{ value: 'day' as Tab, label: 'Day' }] : [])];
  // ?view=eod&day=… (from Accounts and the Clinic page) still opens that day's End of day
  const asked = (sp.get('view') === 'eod' || sp.get('day') ? 'day' : sp.get('tab')) as Tab;
  const tab: Tab = tabs.some((x) => x.value === asked) ? asked : tabs[0]?.value ?? 'day';
  const range: Range = RANGES.some((r) => r.value === sp.get('r')) ? (sp.get('r') as Range) : '30d';
  const { from, to } = spanOf(range, sp);
  const doctor = sp.get('doctor') ?? '';
  const set = (p: Record<string, string | null>) => { const n = new URLSearchParams(sp); for (const [k, v] of Object.entries(p)) v === null || v === '' ? n.delete(k) : n.set(k, v); setSp(n, { replace: true }); };
  const q = useQuery({ queryKey: ['analytics', from, to, doctor], queryFn: () => get(`/reports/analytics?from=${from}&to=${to}${doctor ? `&doctor=${doctor}` : ''}`), enabled: analytics && tab !== 'day', placeholderData: keepPreviousData });
  const d = q.data;
  const csv = (name: string, rows: unknown[][]) => listOut(`Downloaded the ${name} report ${from} to ${to}`, rows.length - 1, () => downloadCsv(`${name}-${from}-to-${to}`, rows));
  const csvFor: Record<string, () => void> = !d ? {} : {
    overview: () => csv('overview', [['Figure', 'This period', 'Period before'], ...FIGS.filter(([k]) => d.now[k] !== null).map(([k, l, isMoney]) => [l, isMoney ? d.now[k] / 100 : d.now[k], isMoney ? d.before[k] / 100 : d.before[k]]), ...(d.overview.perDoctor ?? []).map((x: any) => [`${x.name}: visits · patients · new`, `${x.visits} · ${x.patients} · ${x.newPatients}`, '']), [], ['Day', 'Visits'], ...d.overview.trend.map((x: any) => [x.day, x.visits])]),
    visits: () => csv('visits', [['Visit type', 'Visits'], ...Object.entries(d.visits.types), [], ['Day of week', 'Visits'], ...WEEK.map((w, i) => [w, d.visits.weekday[i]]), [], ['Hour', 'Visits'], ...Object.entries(d.visits.byHour).map(([h, n]) => [hourLabel(Number(h)), n]), [], ['Booked', d.visits.booked], ['Walk-in', d.visits.walkIn]]),
    patients: () => csv('patients', [...(['sex', 'ages', 'frequency', 'localities'] as const).flatMap((k) => [[{ sex: 'Men and women', ages: 'Age', frequency: 'Visits in the period', localities: 'Area' }[k], 'Patients'], ...d.patients[k].map((r: Row) => [r.name, r.n]), []]), ['Referral card', d.patients.referralCard]]),
    clinical: () => d.clinical && csv('clinical', (['diagnoses', 'medicines', 'tests', 'procedures'] as const).flatMap((k) => [[{ diagnoses: 'Diagnosis', medicines: 'Medicine', tests: 'Test', procedures: 'Procedure (sittings done)' }[k], 'Count'], ...d.clinical[k].map((r: Row) => [r.name, r.n]), []])),
  };
  const subtitle = tab === 'day' ? undefined : `${fmtDate(from)}${from !== to ? ` to ${fmtDate(to)}` : ''} · compared with the ${d ? `${fmtDate(d.previous.from)}${d.previous.from !== d.previous.to ? `–${fmtDate(d.previous.to)}` : ''}` : 'period before'}`;
  return (
    <div>
      {tabs.length > 1 && <Tabs<Tab> className="mb-4" value={tab} onChange={(t) => set({ tab: t, view: null, day: null })} options={tabs} />}
      {tab === 'day' ? <DailyReport /> : (<>
        <PageHeader title="Reports" subtitle={subtitle}>
          {d?.doctors && d.doctors.length > 1 && <Filter<string> icon="users" value={doctor} onChange={(v) => set({ doctor: v })} options={[{ value: '', label: 'All doctors' }, ...d.doctors.map((x: any) => ({ value: x.id, label: x.name }))]} />}
          <Filter<Range> icon="calendar" value={range} onChange={(v) => set({ r: v === '30d' ? null : v, ...(v === 'pick' ? { from, to } : { from: null, to: null }) })} options={RANGES} />
          {range === 'pick' && <span className="flex items-center gap-1.5"><input type="date" aria-label="From" className="input !w-auto !py-1.5" value={from} max={to} onChange={(e) => e.target.value && set({ from: e.target.value })} /><span className="text-muted">to</span><input type="date" aria-label="To" className="input !w-auto !py-1.5" value={to} min={from} max={today()} onChange={(e) => e.target.value && set({ to: e.target.value })} /></span>}
          {me?.privacy?.canExport && d && <button className="btn" onClick={() => csvFor[tab]?.()}><Icon name="download" className="h-4 w-4" />Download</button>}
        </PageHeader>
        {q.isError ? <LoadError onRetry={() => q.refetch()} /> : !d ? <Skeleton rows={4} /> : (
          <div className={`anim-fade-up space-y-4 transition-opacity ${q.isPlaceholderData ? 'opacity-60' : ''}`} aria-busy={q.isPlaceholderData}>
            {!d.doctors && d.doctor && <div className="text-sm text-muted">Your patients and your collections only.</div>}
            {tab === 'overview' && <Overview d={d} />}
            {tab === 'visits' && <Visits d={d} />}
            {tab === 'patients' && <Patients d={d} />}
            {tab === 'clinical' && d.clinical && <Clinical c={d.clinical} />}
          </div>)}
      </>)}
    </div>
  );
}

// [key, label, money?, lower is better?]
const FIGS: [string, string, boolean, boolean][] = [['patients', 'Patients seen', false, false], ['newPatients', 'New patients', false, false], ['returning', 'Returning patients', false, false], ['collectedPaise', 'Collected', true, false],
  ['duePaise', 'Still due', true, true], ['sittings', 'Procedure sittings done', false, false], ['waitMin', 'Wait before the doctor (min)', false, true], ['noShows', 'Booked, did not come', false, true]];

function Overview({ d }: { d: any }) {
  const span = d.overview.trend.length;
  return (<>
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {FIGS.filter(([k]) => d.now[k] !== null || k === 'waitMin').map(([k, l, isMoney, low], i) => (
        <Stat key={k} label={l} delay={i * 30} tone={k === 'collectedPaise' ? 'sage' : ''} value={d.now[k] === null ? '–' : isMoney ? money(d.now[k]) : k === 'waitMin' ? `${d.now[k]} min` : d.now[k]}
          sub={<span className="text-xs"><Change now={d.now[k]} before={d.before[k]} lowerIsBetter={low} /></span>} />))}
    </div>
    {d.now.collectedPaise !== null && <div className="text-xs text-muted">{d.doctor ? "Collected is what was paid for this doctor's consultations and sittings in these dates, less refunds. Pharmacy and course advances are not split by doctor." : <>Collected is the End of day figure: payments received in these dates, less refunds, pharmacy included. <Link className="underline" to="/accounts">Accounts</Link> has the full picture.</>}</div>}
    <Section title={<>Visits per day <span className="font-normal text-muted">· average {d.overview.averagePerDay}</span></>}>
      <Columns label="Visits per day" average={d.overview.averagePerDay} rows={d.overview.trend.map((x: any) => ({ key: x.day, label: span <= 14 ? fmtDate(x.day).split(' ')[0] : '', title: fmtDate(x.day), n: x.visits }))} />
    </Section>
    {d.overview.perDoctor?.length > 0 && <Section title="By doctor">
      <div className="overflow-x-auto"><table className="table min-w-[480px]"><thead><tr><th className="pl-4">Doctor</th><th className="text-right">Visits</th><th className="text-right">Patients</th><th className="text-right">New patients</th>{d.now.collectedPaise !== null && <th className="pr-4 text-right">Collected</th>}</tr></thead>
        <tbody>{d.overview.perDoctor.map((x: any) => <tr key={x.id}><td className="pl-4 font-medium">{x.name}</td><td className="text-right">{x.visits}</td><td className="text-right">{x.patients}</td><td className="text-right">{x.newPatients}</td>{x.collectedPaise !== null && <td className="pr-4 text-right">{money(x.collectedPaise)}</td>}</tr>)}</tbody></table></div>
    </Section>}
  </>);
}

function Visits({ d }: { d: any }) {
  const hours = Object.keys(d.visits.byHour).map(Number); const lo = Math.min(9, ...hours), hi = Math.max(20, ...hours);
  const busiest = WEEK[d.visits.weekday.indexOf(Math.max(...d.visits.weekday))];
  const tile = (label: string, value: ReactNode, sub?: ReactNode) => <Stat label={label} value={value} sub={sub} />;
  return (<>
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {tile('Visits', d.now.visits, <span className="text-xs"><Change now={d.now.visits} before={d.before.visits} /></span>)}
      {tile('Booked · walk-in', `${d.visits.booked} · ${d.visits.walkIn}`, d.now.visits ? <span className="text-xs text-muted">{Math.round((d.visits.walkIn / d.now.visits) * 100)}% walked in</span> : undefined)}
      {tile('Booked, did not come', d.now.noShows, <span className="text-xs">{d.now.cancelled} cancelled · <Change now={d.now.noShows} before={d.before.noShows} lowerIsBetter /></span>)}
      {tile('Time with the doctor', d.now.withDoctorMin === null ? '–' : `${d.now.withDoctorMin} min`, <span className="text-xs">wait before {d.now.waitMin ?? '–'} min</span>)}
    </div>
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Section title="Visit type"><Bars rows={Object.entries(d.visits.types).map(([name, n]) => ({ name, n: n as number })).filter((r) => r.n)} /></Section>
      <Section title={<>Day of the week{d.now.visits > 0 && <span className="font-normal text-muted"> · busiest {busiest}</span>}</>}><Columns label="Visits by day of the week" rows={WEEK.map((w, i) => ({ key: w, label: w, n: d.visits.weekday[i] }))} /></Section>
    </div>
    <Section title="Arrivals by hour"><Columns label="Arrivals by hour" rows={Array.from({ length: hi - lo + 1 }, (_, i) => lo + i).map((h) => ({ key: String(h), label: hourLabel(h), title: `${hourLabel(h)}m`, n: d.visits.byHour[h] ?? 0 }))} /></Section>
  </>);
}

function Patients({ d }: { d: any }) {
  const p = d.patients;
  return (<>
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Stat label="Patients" value={d.now.patients} sub={<span className="text-xs"><Change now={d.now.patients} before={d.before.patients} /></span>} />
      <Stat label="New" value={d.now.newPatients} sub={<span className="text-xs text-muted">first visit in these dates</span>} />
      <Stat label="Returning" value={d.now.returning} sub={<span className="text-xs text-muted">came before</span>} />
      <Stat label="Referral card" value={p.referralCard} sub={<span className="text-xs text-muted">RMP/PMP card holders</span>} />
    </div>
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Section title="Men and women"><Bars rows={p.sex} /></Section>
      <Section title="Age"><Bars rows={['Under 18', '18–30', '31–45', '46–60', 'Over 60', 'Not recorded'].map((k) => p.ages.find((r: Row) => r.name === k)).filter(Boolean)} /></Section>
      <Section title="Where they come from"><Bars rows={p.localities} empty="No area recorded" /></Section>
      <Section title="Visits in these dates"><Bars rows={['1 visit', '2 visits', '3 visits', '4 or more visits'].map((k) => p.frequency.find((r: Row) => r.name === k)).filter(Boolean)} /></Section>
    </div>
  </>);
}

function Clinical({ c }: { c: any }) {
  return (<>
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Stat label="Consultations finished" value={c.consultations} />
      <Stat label="Top diagnosis" value={<span className="text-[18px]">{c.diagnoses[0]?.name ?? '–'}</span>} />
      <Stat label="Top medicine" value={<span className="text-[18px]">{c.medicines[0]?.name ?? '–'}</span>} />
      <Stat label="Procedure courses started" value={c.coursesStarted} />
    </div>
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Section title="Diagnoses"><Bars rows={c.diagnoses} /></Section>
      <Section title="Medicines prescribed"><Bars rows={c.medicines} /></Section>
      <Section title="Tests ordered"><Bars rows={c.tests} /></Section>
      <Section title="Procedure sittings done"><Bars rows={c.procedures} /></Section>
    </div>
  </>);
}

/** Daily collections + expenses: replaces the two-page printout and the handwritten ledger. End of day is the evening close. */
function DailyReport() {
  const { perms, me } = useOutletContext<any>();
  const [sp, setSp] = useSearchParams(); // ?day=…&view=eod opens a given day's End of day (from Accounts and the Clinic page)
  const [day, setDay] = useState(() => /^\d{4}-\d{2}-\d{2}$/.test(sp.get('day') ?? '') ? sp.get('day')! : today());
  const [view, setView] = useState<'daily' | 'eod'>(() => (sp.get('view') === 'eod' && can(perms, 'fees.see') ? 'eod' : 'daily'));
  const r = useQuery({ queryKey: ['daily', day], queryFn: () => get(`/reports/daily?day=${day}`) });
  const d = r.data;
  useEffect(() => { if (d && sp.get('print')) { setSp({ tab: 'day' }, { replace: true }); if (me?.privacy?.canExport) listOut(`Printed the daily report ${day}`, undefined, () => setTimeout(() => window.print(), 400)); } }, [d, sp]);
  const dayLabel = new Date(day + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return (
    <div>
      <PageHeader title="Daily report" subtitle={dayLabel}>
        <div className="flex items-center gap-1 card !p-1 no-print">
          <button className="btn btn-ghost btn-icon" aria-label="Previous day" onClick={() => d && setDay(d.prevDay)}><Icon name="chevL" /></button>
          <input type="date" className="input !w-auto !border-0 !shadow-none !py-1.5 text-center" value={day} onChange={(e) => setDay(e.target.value)} />
          <button className="btn btn-ghost btn-icon" aria-label="Next day" onClick={() => d && setDay(d.nextDay)}><Icon name="chevR" /></button>
        </div>
        {can(perms, 'fees.see') && can(perms, 'report.daily') && <Segmented<'daily' | 'eod'> value={view} onChange={setView} options={[{ value: 'daily', label: 'Daily report' }, { value: 'eod', label: 'End of day' }]} />}
        {me?.privacy?.canExport && <button className="btn no-print" onClick={() => listOut(`Printed the daily report ${day}`, undefined, () => window.print())}><Icon name="print" />Print</button>}
      </PageHeader>
      {view === 'eod' ? <EndOfDay day={day} /> : !d ? <Skeleton rows={3} /> : (<>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <Stat label="Visits" value={d.totals.visits} delay={0} />
          <Stat label="Collected" value={money(d.totals.collectedPaise)} tone="sage" sub={d.pharmacyPaise ? `includes pharmacy ${money(d.pharmacyPaise)} · less refunds` : 'less refunds · same as End of day'} delay={40} />
          <Stat label="Expenses" value={money(d.totals.expensesPaise)} sub={`${d.expenses.length} entries`} delay={80} />
          <Stat label="Net for the day" value={money(d.totals.netPaise)} tone="clay" sub={`Outstanding overall ${money(d.outstanding.total)} across ${d.outstanding.n}`} delay={120} />
        </div>
        {d.byMode && <div aria-label="Collected by mode" className="card mt-3 flex flex-wrap items-baseline gap-x-6 gap-y-1 !py-3 text-[15px]">
          {([['cash', 'Cash'], ['upi', 'UPI'], ['card', 'Card'], ['other', 'EMI / other']] as const).filter(([k]) => k !== 'other' || d.byMode.other).map(([k, l]) => <span key={k}><span className="text-muted">{l}</span> <b className="text-ink">{money(d.byMode[k])}</b></span>)}
        </div>}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mt-5">
          <Section title="By visit category" delay={160}>
            {d.byCategory.length === 0 ? <Empty icon="users" title="No visits recorded" /> : (
              <div className="overflow-x-auto"><table className="table min-w-[540px]"><thead><tr><th className="pl-4">Category</th><th className="text-right">Visits</th><th className="text-right">Billed</th><th className="text-right">Waived</th><th className="text-right pr-4">Refunded</th></tr></thead>
                <tbody>{d.byCategory.map((c: any) => <tr key={c.code}><td className="pl-4">{c.name}</td><td className="text-right">{c.visits}</td><td className="text-right">{money(c.billed)}</td><td className="text-right text-muted">{money(c.waived)}</td><td className="text-right pr-4 text-muted">{money(c.refunded)}</td></tr>)}</tbody></table></div>)}
          </Section>
          <Section title="Expenses" delay={200}>
            {d.expenses.length === 0 ? <div className="px-4 pt-4 text-sm text-muted">No expenses entered.</div> :
              <div className="overflow-x-auto"><table className="table min-w-[540px]"><tbody>{d.expenses.map((e: any) => <tr key={e.id}><td className="pl-4">{e.description}<div className="text-xs text-muted">{e.category}</div></td><td><Chip>{e.method}</Chip></td><td className="text-right pr-4">{money(e.amountPaise)}</td></tr>)}</tbody></table></div>}
            {can(perms, 'expense.read') && <div className="p-4 no-print border-t border-line"><Link to="/expenses" className="btn btn-sm"><Icon name="rupee" className="h-3.5 w-3.5" />Add or manage expenses</Link></div>}
          </Section>
        </div>
        {can(perms, 'payment.record') && <EmiAwaiting />}
        <Section title={<>Payments <span className="text-muted font-normal">· {d.payments.length}</span></>} delay={240} className="mt-5">
          {d.payments.length === 0 ? <Empty icon="wallet" title="No payments yet today" /> :
            <div className="overflow-x-auto"><table className="table min-w-[540px]"><thead><tr><th className="pl-4">Time</th><th>Receipt</th><th>Patient</th><th>For</th><th>Method</th><th className="text-right pr-4">Amount</th></tr></thead>
              <tbody>{d.payments.map((p: any) => <tr key={p.id}><td className="pl-4 text-muted">{fmtTime(p.receivedAt)}</td><td className="text-muted">{p.receiptNo ?? '—'}</td><td className="font-medium">{p.patient}</td><td className="text-muted">{p.description ?? ''}</td><td><Chip tone={p.amountPaise < 0 ? 'amber' : undefined}>{p.amountPaise < 0 ? `${p.method} refund` : p.method}</Chip></td><td className="text-right pr-4">{money(p.amountPaise)}</td></tr>)}</tbody></table></div>}
        </Section>
      </>)}
    </div>
  );
}
