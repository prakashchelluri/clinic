import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useOutletContext, useSearchParams } from 'react-router';
import { get, today, errText, listOut } from '../api';
import { can } from '../App';
import { EmiAwaiting } from '../takePayment';
import { Expenses } from './Expenses';
import { Drawer, Icon, NoAccess, PageHeader, Segmented, Skeleton, Stat, Tabs, money as inr } from '../ui';

type Period = 'today' | 'month' | 'last' | 'pick';
type Tab = 'sum' | 'days' | 'spend' | 'due';
const SOURCES = [['consultation', 'Consultations', 'fees taken at check-in'], ['procedure', 'Procedures', 'sittings and course advances'], ['pharmacy', 'Pharmacy', 'medicine sales, less returns'], ['other', 'Other', 'anything not tied to a visit or a sitting']] as const;
// one shade per source, told apart by lightness as well as colour; works in both themes
const SHADE: Record<string, string> = { consultation: 'bg-muted', procedure: 'bg-clay', pharmacy: 'bg-line-2', other: 'bg-paper-2' };
const MODES = [['cash', 'Cash'], ['upi', 'UPI'], ['card', 'Card'], ['other', 'EMI and other']] as const;

const addDays = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
/** The first day of the month `n` months from the one `d` is in. */
const firstOf = (d: string, n = 0) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1 + n, 1)).toISOString().slice(0, 10);
const okDay = (d: string | null): d is string => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d + 'T00:00:00Z'));
const fmt = (d: string, o: Intl.DateTimeFormatOptions) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { ...o, timeZone: 'UTC' });
const dayName = (d: string) => fmt(d, { weekday: 'short', day: 'numeric', month: 'short' });
const span = (a: string, b: string) => a === b ? fmt(a, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
  : a.slice(0, 7) === b.slice(0, 7) ? `${+a.slice(8)} to ${fmt(b, { day: 'numeric', month: 'short', year: 'numeric' })}` : `${fmt(a, { day: 'numeric', month: 'short' })} to ${fmt(b, { day: 'numeric', month: 'short', year: 'numeric' })}`;
const shortSpan = (a: string, b: string) => a === b ? fmt(a, { day: 'numeric', month: 'short' }) : a.slice(0, 7) === b.slice(0, 7) ? `${+a.slice(8)}–${fmt(b, { day: 'numeric', month: 'short' })}` : `${fmt(a, { day: 'numeric', month: 'short' })} – ${fmt(b, { day: 'numeric', month: 'short' })}`;
const k = (p: number) => (Math.abs(p) >= 100000 ? `${(p / 100000).toFixed(1)}k` : String(Math.round(p / 100)));
// past ten times either way a percentage stops meaning anything; "—" says there is nothing fair to compare with
const change = (now: number, before: number) => { const x = before > 0 ? ((now - before) / before) * 100 : NaN; return Number.isFinite(x) && Math.abs(x) < 1000 ? `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(1)}%` : '—'; };
const money = (p: number) => (p < 0 ? '−' + inr(-p) : inr(p)); // a loss reads −₹180, not ₹-180
const rupee = (p: number) => money(Math.round(p / 100) * 100); // a cost worked out from batch prices, to the rupee

/** The period and what it is compared with. This month runs against the same days of last month, so a part month is fair. */
function periodOf(p: Period, sp: URLSearchParams) {
  const t = today();
  if (p === 'today') return { from: t, to: t, prevFrom: addDays(t, -7), prevTo: addDays(t, -7), vs: 'same day last week' };
  if (p === 'last') { const from = firstOf(t, -1), to = addDays(firstOf(t), -1); return { from, to, prevFrom: firstOf(t, -2), prevTo: addDays(from, -1), vs: fmt(firstOf(t, -2), { month: 'long' }) }; }
  if (p === 'pick') {
    let from = okDay(sp.get('from')) ? sp.get('from')! : firstOf(t); let to = okDay(sp.get('to')) ? sp.get('to')! : t;
    if (to > t) to = t; if (from > to) from = to;
    const len = Math.round((Date.parse(to) - Date.parse(from)) / 86400000); const prevTo = addDays(from, -1); const prevFrom = addDays(prevTo, -len);
    return { from, to, prevFrom, prevTo, vs: shortSpan(prevFrom, prevTo) };
  }
  const from = firstOf(t); const prevFrom = firstOf(t, -1); const prevEnd = addDays(from, -1);
  const prevTo = prevFrom.slice(0, 8) + t.slice(8) < prevEnd ? prevFrom.slice(0, 8) + t.slice(8) : prevEnd;
  return { from, to: t, prevFrom, prevTo, vs: shortSpan(prevFrom, prevTo) };
}

/**
 * The owner's money in one place: what came in by source over any period, what went out, what was left, and what is not in yet.
 * Every figure is the same ledger as End of day, so a day here always equals that day's End of day.
 */
export function Accounts() {
  const { perms, me } = useOutletContext<any>();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const period = (['today', 'month', 'last', 'pick'].includes(sp.get('period') ?? '') ? sp.get('period') : 'month') as Period;
  const tab = (['sum', 'days', 'spend', 'due'].includes(sp.get('tab') ?? '') ? sp.get('tab') : 'sum') as Tab;
  const r = periodOf(period, sp);
  const q = useQuery({ queryKey: ['finance', r.from, r.to, r.prevFrom, r.prevTo], queryFn: () => get(`/finance?from=${r.from}&to=${r.to}&prevFrom=${r.prevFrom}&prevTo=${r.prevTo}`), enabled: can(perms, 'finance.read') });
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(null); }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, []);
  // one change to the address at a time: two in one tick lose the first
  const go = (o: Record<string, string | null>) => setSp((p) => { const n = new URLSearchParams(p); for (const [key, v] of Object.entries(o)) v === null ? n.delete(key) : n.set(key, v); return n; }, { replace: true });

  if (!can(perms, 'finance.read')) return <NoAccess what="Accounts" />;
  const d = q.data;
  const inT = d?.income.total.total ?? 0; const outT = d?.outPaise ?? 0;
  const notIn = d ? d.owed.totalPaise + d.emi.totalPaise : 0;

  const download = () => {
    if (!d) return;
    const head = ['Day', 'Consultations', 'Procedures', 'Pharmacy', 'Other', 'Came in', 'Cash', 'UPI', 'Card', 'EMI and other', 'Went out', 'Left over', 'Day closed'];
    const rupees = (p: number) => (p / 100).toFixed(2);
    const rows = d.days.map((x: any) => { const m = x.money; const v = (s: string) => rupees(m?.[s].total ?? 0); const mode = (s: string) => rupees(m?.total[s] ?? 0);
      return [x.day, v('consultation'), v('procedure'), v('pharmacy'), v('other'), v('total'), mode('cash'), mode('upi'), mode('card'), mode('other'), rupees(x.expensesPaise), rupees((m?.total.total ?? 0) - x.expensesPaise), x.closed ? `Closed by ${x.closed.by}` : x.today ? 'Today' : 'Not closed']; });
    const csv = [head, ...rows].map((l) => l.map((c: string) => /[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c).join(',')).join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = `accounts-${d.from}-to-${d.to}.csv`; a.click(); URL.revokeObjectURL(a.href);
  };

  const sel = d && open ? d.days.find((x: any) => x.day === open) : null;
  return (
    <div>
      <PageHeader title="Accounts" subtitle={`${span(r.from, r.to)}${period === 'month' ? ', so far' : ''} · compared with ${r.vs}`}>
        <Segmented<Period> value={period} onChange={(v) => go({ period: v === 'month' ? null : v })} options={[{ value: 'today', label: 'Today' }, { value: 'month', label: 'This month' }, { value: 'last', label: 'Last month' }, { value: 'pick', label: 'Pick dates' }]} />
        {period === 'pick' && <div className="flex items-center gap-1.5">
          <input type="date" aria-label="From" className="input !w-auto !py-1.5" max={today()} value={r.from} onChange={(e) => okDay(e.target.value) && go({ from: e.target.value })} />
          <span className="text-muted">to</span>
          <input type="date" aria-label="To" className="input !w-auto !py-1.5" max={today()} value={r.to} onChange={(e) => okDay(e.target.value) && go({ to: e.target.value })} />
        </div>}
        {me?.privacy?.canExport && <button className="btn" disabled={!d} onClick={() => listOut(`Downloaded accounts ${r.from} to ${r.to}`, d?.days.length, download)}><Icon name="download" />Download for the accountant</button>}
      </PageHeader>

      <Tabs<Tab> className="mb-4" value={tab} onChange={(v) => go({ tab: v === 'sum' ? null : v, cat: null })} options={[
        { value: 'sum', label: 'Summary' }, { value: 'days', label: 'Day by day', count: d?.days.length }, { value: 'spend', label: 'Spending', count: d?.expenses.n }, { value: 'due', label: 'Not in yet' }]} />

      {q.isError ? <div className="card flex flex-wrap items-center gap-3 text-[14px]"><span>Couldn't load the accounts. {errText(q.error)}</span><button className="btn btn-sm btn-primary" onClick={() => q.refetch()}>Retry</button></div>
        : tab === 'spend' ? <Expenses period={{ from: r.from, to: r.to }} />
        : !d ? <Skeleton rows={4} />
        : tab === 'sum' ? <Summary d={d} vs={r.vs} inT={inT} outT={outT} notIn={notIn} onDay={setOpen} onCat={(c) => go({ tab: 'spend', cat: c })} onDue={() => go({ tab: 'due' })} onSpend={() => go({ tab: 'spend', cat: null })} />
        : tab === 'days' ? <Days d={d} open={open} onDay={setOpen} />
        : <NotIn d={d} perms={perms} />}

      {sel && <Drawer title={fmt(sel.day, { weekday: 'long', day: 'numeric', month: 'long' })} subtitle={<Closed x={sel} long />} width="max-w-md" onClose={() => setOpen(null)}>
        <div className="flex flex-1 flex-col gap-4">
          {sel.money ? <ModeTable m={sel.money} /> : <div className="text-[14px] text-muted">No money came in.</div>}
          <div>
            <div className="mb-1 text-[11.5px] font-bold uppercase tracking-wider text-muted">Went out</div>
            {d.expenses.rows.filter((e: any) => e.day === sel.day).map((e: any) => <Row key={e.id} a={<>{e.description} <span className="text-muted">· {e.category}</span></>} b={money(e.amountPaise)} />)}
            {!sel.expensesPaise && <div className="text-[13.5px] text-muted">Nothing spent.</div>}
          </div>
          <Row a={<b className="text-ink">Left over</b>} b={money((sel.money?.total.total ?? 0) - sel.expensesPaise)} />
          <div className="mt-auto flex gap-2 border-t border-line pt-3.5">
            {can(perms, 'report.daily') && <button className="btn btn-primary" onClick={() => nav(`/reports?day=${sel.day}&view=eod`)}>Open End of day</button>}
            <button className="btn" onClick={() => setOpen(null)}>Close</button>
          </div>
        </div>
      </Drawer>}
    </div>
  );
}

function Summary({ d, vs, inT, outT, notIn, onDay, onCat, onDue, onSpend }: { d: any; vs: string; inT: number; outT: number; notIn: number; onDay: (day: string) => void; onCat: (c: string) => void; onDue: () => void; onSpend: () => void }) {
  const prevIn = d.prevIncome.total.total;
  const top = d.expenses.byCategory[0];
  // a long period draws one bar a month, so the bars stay readable
  const byMonth = d.days.length > 45;
  const bars: { key: string; label: string; day?: string; v: Record<string, number>; t: number }[] = [];
  for (const x of d.days) {
    const key = byMonth ? x.day.slice(0, 7) : x.day; let b = bars.find((y) => y.key === key);
    if (!b) { b = { key, label: byMonth ? fmt(x.day, { month: 'short' }) : fmt(x.day, { weekday: 'short', day: 'numeric' }), day: byMonth ? undefined : x.day, v: { consultation: 0, procedure: 0, pharmacy: 0, other: 0 }, t: 0 }; bars.push(b); }
    for (const [s] of SOURCES) b.v[s] += Math.max(0, x.money?.[s].total ?? 0);
    b.t += x.money?.total.total ?? 0;
  }
  const max = Math.max(1, ...bars.map((b) => SOURCES.reduce((n, [s]) => n + b.v[s], 0)));
  const ph = d.pharmacy; const margin = ph.soldPaise - ph.costPaise;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Came in" value={money(inT)} sub={<><b className={inT >= prevIn ? 'text-sage' : 'text-rose'}>{change(inT, prevIn)}</b> vs {vs} ({money(prevIn)})</>} />
        <Stat label="Went out" value={money(outT)} sub={top ? `${d.expenses.n} ${d.expenses.n === 1 ? 'entry' : 'entries'} · biggest ${top.category} ${money(top.totalPaise)}` : 'nothing entered'} delay={40} />
        <Stat label="Left over" value={money(inT - outT)} tone="clay" sub={inT ? `came in less went out · ${Math.round(((inT - outT) / inT) * 100)}% of income` : 'came in less went out'} delay={80} />
        <Stat label="Not in yet" value={money(notIn)} sub={<button className="text-left underline decoration-line-2 underline-offset-2 hover:text-ink" onClick={onDue}>{money(d.owed.totalPaise)} from {d.owed.patients.length} patient{d.owed.patients.length === 1 ? '' : 's'}{d.emi.n ? ` · ${money(d.emi.totalPaise)} EMI` : ''}</button>} delay={120} />
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        <section className="card !p-5">
          <div className="flex flex-wrap items-baseline gap-2"><b className="text-[15px]">Came in, {byMonth ? 'month by month' : 'day by day'}</b>{!byMonth && <span className="text-[12.5px] text-muted">tap a day for its cash, UPI and card</span>}</div>
          {bars.length === 0 ? <div className="py-10 text-center text-[14px] text-muted">Nothing came in during this period.</div> :
            <div className="mt-4 grid h-[200px] items-end gap-2" style={{ gridTemplateColumns: `repeat(${Math.max(bars.length, 7)}, minmax(0, 1fr))` }} role="img" aria-label={`Money in: ${bars.map((b) => `${b.label} ${money(b.t)}`).join(', ')}`}>
              {bars.map((b) => <button key={b.key} type="button" disabled={!b.day} onClick={() => b.day && onDay(b.day)} className="group flex h-full min-w-0 flex-col items-center justify-end gap-1.5" aria-label={`${b.label}: ${money(b.t)}`}>
                <b className="text-[11.5px] tabular-nums">{b.t ? k(b.t) : ''}</b>
                <span className="flex w-full max-w-[48px] flex-col-reverse overflow-hidden rounded-t-[7px] rounded-b-[3px] group-enabled:group-hover:outline group-enabled:group-hover:outline-2 group-enabled:group-hover:outline-offset-2 group-enabled:group-hover:outline-ink-2">
                  {SOURCES.map(([s]) => <i key={s} className={`block ${SHADE[s]}`} style={{ height: Math.round((b.v[s] / max) * 160) }} />)}
                </span>
                <span className="w-full truncate text-center text-[11.5px] text-muted">{b.label}</span></button>)}
            </div>}
          <div className="mt-3 flex flex-wrap gap-4 text-[12.5px] text-muted">{SOURCES.map(([s, l]) => <span key={s} className="inline-flex items-center gap-1.5"><i className={`inline-block h-2.5 w-2.5 rounded-[3px] ${SHADE[s]}`} />{l}</span>)}</div>
        </section>

        <div className="space-y-4">
          <section className="card !p-5">
            <b className="text-[15px]">How it was paid</b>
            <div className="mt-2">{MODES.filter(([m]) => m !== 'other' || d.income.total.other).map(([m, l]) => <Row key={m} a={l} b={<>{money(d.income.total[m])} <span className="font-medium text-muted">· {inT ? Math.round((d.income.total[m] / inT) * 100) : 0}%</span></>} />)}</div>
            <div className="mt-2 text-[12.5px] text-muted">Refunds come off in the mode they went back in.</div>
          </section>
          <section className="card !p-5">
            <div className="flex flex-wrap items-baseline gap-2"><b className="text-[15px]">Pharmacy</b><span className="text-[12.5px] text-muted">bills in this period, against what the medicines cost</span></div>
            <div className="mt-2">
              <Row a="Sold, less returns" b={money(ph.soldPaise)} />
              <Row a="Cost of those medicines" b={rupee(ph.costPaise)} />
              <Row a={<b className="text-ink">Margin</b>} b={<>{rupee(margin)} {ph.soldPaise > 0 && <span className="font-medium text-muted">· {Math.round((margin / ph.soldPaise) * 100)}%</span>}</>} />
            </div>
            <div className="mt-2 text-[12.5px] text-muted">{ph.uncostedPaise ? `${money(ph.uncostedPaise)} of sales had no batch to take a cost from, so the margin is higher than it really is.` : "Cost comes from each batch's price on the delivery bill."}</div>
          </section>
        </div>
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-2">
        <section className="card overflow-hidden !p-0">
          <div className="px-5 py-4"><b className="text-[15px]">Where it came from</b></div>
          <div className="overflow-x-auto"><table className="table min-w-[520px]">
            <thead><tr><th className="pl-5">Source</th><th className="text-right">Amount</th><th className="text-right">{vs}</th><th className="text-right">Change</th><th className="pr-5">Share</th></tr></thead>
            <tbody>{SOURCES.map(([s, l, sub]) => { const v = d.income[s].total, p = d.prevIncome[s].total; return (
              <tr key={s}><td className="pl-5"><span className="inline-flex items-center gap-2"><i className={`inline-block h-2.5 w-2.5 rounded-full ${SHADE[s]}`} /><b>{l}</b></span><div className="text-[12px] text-muted">{sub}</div></td>
                <td className="text-right font-semibold tabular-nums">{money(v)}</td><td className="text-right tabular-nums text-muted">{money(p)}</td>
                <td className={`text-right font-semibold tabular-nums ${v >= p ? 'text-sage' : 'text-rose'}`}>{change(v, p)}</td>
                <td className="pr-5"><span className="block h-2 rounded bg-ink-2" style={{ width: inT > 0 ? `${Math.max(3, Math.round((Math.max(0, v) / inT) * 100))}%` : 0 }} /></td></tr>); })}</tbody>
            <tfoot><tr className="font-bold"><td className="pl-5">Total</td><td className="text-right tabular-nums">{money(inT)}</td><td className="text-right tabular-nums">{money(d.prevIncome.total.total)}</td><td className="text-right tabular-nums">{change(inT, d.prevIncome.total.total)}</td><td /></tr></tfoot>
          </table></div>
        </section>
        <section className="card overflow-hidden !p-0">
          <div className="flex items-center gap-2 px-5 py-3"><b className="text-[15px]">Where it went</b><span className="flex-1" /><button className="btn btn-sm" onClick={onSpend}>All expenses</button></div>
          {d.expenses.byCategory.length === 0 ? <div className="px-5 pb-5 text-[14px] text-muted">No expenses entered in this period.</div> :
            <div className="overflow-x-auto"><table className="table min-w-[440px]">
              <thead><tr><th className="pl-5">Category</th><th className="text-right">Entries</th><th className="text-right">Amount</th><th className="pr-5">Share</th></tr></thead>
              <tbody>{d.expenses.byCategory.map((c: any) => <tr key={c.category} className="cursor-pointer hover:bg-surface-2" onClick={() => onCat(c.category)}>
                <td className="pl-5"><button type="button" className="font-semibold hover:underline" onClick={(e) => { e.stopPropagation(); onCat(c.category); }}>{c.category}</button></td>
                <td className="text-right tabular-nums text-muted">{c.n}</td><td className="text-right font-semibold tabular-nums">{money(c.totalPaise)}</td>
                <td className="pr-5"><span className="block h-2 rounded bg-line-2" style={{ width: `${Math.max(3, Math.round((c.totalPaise / Math.max(1, outT)) * 100))}%` }} /></td></tr>)}</tbody>
              <tfoot><tr className="font-bold"><td className="pl-5">Total</td><td className="text-right tabular-nums">{d.expenses.n}</td><td className="text-right tabular-nums">{money(outT)}</td><td /></tr></tfoot>
            </table></div>}
        </section>
      </div>
    </div>
  );
}

function Days({ d, open, onDay }: { d: any; open: string | null; onDay: (day: string) => void }) {
  const sum = (f: (x: any) => number) => d.days.reduce((n: number, x: any) => n + f(x), 0);
  const v = (x: any, s: string) => x.money?.[s].total ?? 0;
  return (
    <section className="card overflow-hidden !p-0">
      <div className="flex flex-wrap items-baseline gap-2 px-5 py-4"><b className="text-[15px]">Day by day</b><span className="text-[12.5px] text-muted">the same figures as each day's End of day · tap a day for its detail</span></div>
      {d.days.length === 0 ? <div className="px-5 pb-6 text-[14px] text-muted">Nothing came in or went out in this period.</div> :
        <div className="overflow-x-auto"><table className="table min-w-[980px]">
          <thead><tr><th className="pl-5">Day</th>{SOURCES.map(([s, l]) => <th key={s} className="text-right">{l}</th>)}<th className="text-right">Came in</th><th className="text-right">Went out</th><th className="text-right">Left over</th><th className="pr-5">Day closed</th></tr></thead>
          <tbody>{d.days.map((x: any) => { const t = v(x, 'total'); const net = t - x.expensesPaise; return (
            <tr key={x.day} className={`cursor-pointer hover:bg-surface-2 ${open === x.day ? 'bg-surface-2' : ''}`} onClick={() => onDay(x.day)}>
              <td className="pl-5"><button type="button" className="font-semibold hover:underline" onClick={(e) => { e.stopPropagation(); onDay(x.day); }}>{dayName(x.day)}</button></td>
              {SOURCES.map(([s]) => <td key={s} className={`text-right tabular-nums ${v(x, s) ? '' : 'text-muted'}`}>{v(x, s) ? money(v(x, s)) : '—'}</td>)}
              <td className="text-right font-semibold tabular-nums">{money(t)}</td>
              <td className={`text-right tabular-nums ${x.expensesPaise ? '' : 'text-muted'}`}>{x.expensesPaise ? money(x.expensesPaise) : '—'}</td>
              <td className={`text-right tabular-nums ${net < 0 ? 'text-rose' : ''}`}>{money(net)}</td>
              <td className="pr-5"><Closed x={x} /></td></tr>); })}</tbody>
          <tfoot><tr className="font-bold"><td className="pl-5">{d.days.length} day{d.days.length === 1 ? '' : 's'}</td>{SOURCES.map(([s]) => <td key={s} className="text-right tabular-nums">{money(sum((x) => v(x, s)))}</td>)}
            <td className="text-right tabular-nums">{money(sum((x) => v(x, 'total')))}</td><td className="text-right tabular-nums">{money(sum((x) => x.expensesPaise))}</td><td className="text-right tabular-nums">{money(sum((x) => v(x, 'total') - x.expensesPaise))}</td><td /></tr></tfoot>
        </table></div>}
      <div className="border-t border-line px-5 py-3 text-[12.5px] text-muted">A day with a big bill (salaries, rent, a stock delivery) can leave less over than it took in. Days with nothing in or out are left out.</div>
    </section>
  );
}

function NotIn({ d, perms }: { d: any; perms: string[] }) {
  const ago = (day: string) => Math.round((Date.parse(d.today) - Date.parse(day)) / 86400000);
  return (
    <div className="grid items-start gap-4 xl:grid-cols-2">
      <section className="card overflow-hidden !p-0">
        <div className="flex items-baseline gap-2 px-5 py-4"><b className="text-[15px]">Patients who still owe</b><span className="text-[12.5px] text-muted">Oldest first</span><span className="flex-1" /><b className="tabular-nums">{money(d.owed.totalPaise)}</b></div>
        {d.owed.patients.length === 0 ? <div className="px-5 pb-5 text-[14px] text-muted">Nobody owes the clinic anything.</div> :
          <div className="overflow-x-auto"><table className="table min-w-[520px]">
            <thead><tr><th className="pl-5">Patient</th><th>For</th><th>Since</th><th className="pr-5 text-right">Owes</th></tr></thead>
            <tbody>{d.owed.patients.map((o: any) => <tr key={o.patientId}>
              <td className="pl-5"><Link to={`/patients/${o.patientId}`} className="font-semibold hover:underline">{o.name}</Link><div className="text-[12px] tabular-nums text-muted">{o.phone ?? o.patientNo}</div></td>
              <td className="max-w-[220px] truncate text-muted" title={o.items.join(', ')}>{o.items.join(', ')}</td>
              <td className={ago(o.since) > 14 ? 'font-semibold text-rose' : 'text-muted'}>{fmt(o.since, { day: 'numeric', month: 'short' })}</td>
              <td className="pr-5 text-right font-semibold tabular-nums">{money(o.totalPaise)}</td></tr>)}</tbody>
          </table></div>}
        <div className="border-t border-line px-5 py-3 text-[12.5px] text-muted">The desk sees what is owed when the patient next checks in, and takes it there.</div>
      </section>
      <div className="space-y-4">
        {can(perms, 'payment.record') ? <div className="[&>section]:!mt-0"><EmiAwaiting /></div> : null}
        {(d.doctorPrices ?? []).length > 0 && <section className="card overflow-hidden !p-0 xl:col-span-2">
          <div className="px-5 py-4"><b className="text-[15px]">Doctor's prices · {d.doctorPrices.length}</b><span className="ml-2 text-[12.5px] text-muted">procedure courses the doctor priced instead of the standard price, each agreed by the patient</span></div>
          <div className="overflow-x-auto"><table className="table min-w-[760px]">
            <thead><tr><th className="pl-5">Agreed</th><th>Patient</th><th>Procedure</th><th>Doctor</th><th className="text-right">Standard</th><th className="text-right">Doctor's price</th><th className="pr-5 text-right">Difference</th></tr></thead>
            <tbody>{d.doctorPrices.map((x: any) => { const diff = x.standardPaise ? x.totalPaise - x.standardPaise : null; return (
              <tr key={x.id}><td className="pl-5 whitespace-nowrap">{new Date(x.day + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}<div className="text-[12px] text-muted">recorded by {x.recordedBy ?? '—'}</div></td>
                <td><b>{x.patient}</b><div className="text-[12px] text-muted">{x.patientNo}</div></td><td>{x.procedure ?? 'Procedure'}<div className="text-[12px] text-muted">{x.sittings} sittings</div></td><td>{x.doctor ?? '—'}</td>
                <td className="text-right tabular-nums text-muted">{x.standardPaise ? money(x.standardPaise) : '—'}</td><td className="text-right font-semibold tabular-nums">{money(x.totalPaise)}</td>
                <td className={`pr-5 text-right tabular-nums ${diff === null ? 'text-muted' : diff < 0 ? 'text-rose' : diff > 0 ? 'text-sage' : 'text-muted'}`}>{diff === null ? '—' : `${diff > 0 ? '+' : diff < 0 ? '−' : ''}${money(Math.abs(diff))}`}</td></tr>); })}</tbody>
          </table></div>
        </section>}
        {d.emi.n === 0 && <section className="card !p-5 text-[14px]"><b className="text-[15px]">EMI</b><div className="mt-1 text-muted">No EMI is waiting for the lender.</div></section>}
        <section className="card overflow-hidden !p-0">
          <div className="px-5 py-4"><b className="text-[15px]">Given back or let go in this period</b></div>
          {d.givenBack.length === 0 ? <div className="px-5 pb-5 text-[14px] text-muted">No refunds or waivers.</div> :
            <div className="overflow-x-auto"><table className="table"><tbody>{d.givenBack.map((g: any, i: number) => <tr key={i}>
              <td className="pl-5"><b>{g.kind === 'refund' ? 'Refund' : 'Waived'}</b> · {g.name}</td>
              <td className="text-muted">{g.what}{g.method ? ` · ${g.method}` : ''} · {fmt(g.day, { day: 'numeric', month: 'short' })}</td>
              <td className="pr-5 text-right tabular-nums">{money(g.amountPaise)}</td></tr>)}</tbody></table></div>}
        </section>
      </div>
    </div>
  );
}

function ModeTable({ m }: { m: any }) {
  const other = m.total.other !== 0;
  const cols = MODES.filter(([c]) => c !== 'other' || other);
  return (
    <div className="grid text-[13.5px] font-semibold tabular-nums" style={{ gridTemplateColumns: `minmax(0,1.3fr) repeat(${cols.length + 1}, minmax(0,1fr))` }}>
      {['', ...cols.map(([, l]) => (l === 'EMI and other' ? 'EMI' : l)), 'Total'].map((h, i) => <span key={i} className={`pb-1.5 text-[12px] text-muted ${h ? 'text-right' : ''}`}>{h}</span>)}
      {[...SOURCES.filter(([s]) => m[s].total !== 0), ['total', 'Total'] as const].map(([s, l]) => [
        <span key={s} className={`border-t border-line py-2 ${s === 'total' ? 'font-bold' : 'font-medium'}`}>{l}</span>,
        ...cols.map(([c]) => <span key={s + c} className={`border-t border-line py-2 text-right ${s === 'total' ? 'font-bold' : ''}`}>{money(m[s][c])}</span>),
        <span key={s + 't'} className="border-t border-line py-2 text-right font-bold">{money(m[s].total)}</span>])}
    </div>
  );
}

function Closed({ x, long = false }: { x: any; long?: boolean }) {
  const [dot, text, cls] = x.closed ? ['bg-muted', long ? `Closed by ${x.closed.by}` : 'Closed', ''] : x.today ? ['bg-clay', long ? 'Today, still open' : 'Today', ''] : ['bg-rose', long ? 'Never closed: the cash was not counted' : 'Not closed', 'font-semibold text-rose'];
  return <span className={`inline-flex items-center gap-2 whitespace-nowrap ${cls}`}><i className={`inline-block h-2 w-2 rounded-full ${dot}`} />{text}</span>;
}

function Row({ a, b }: { a: React.ReactNode; b: React.ReactNode }) {
  return <div className="flex justify-between gap-3 border-t border-line py-2 text-[14px] font-semibold tabular-nums"><span className="min-w-0 font-medium text-muted">{a}</span><span className="shrink-0 text-right">{b}</span></div>;
}
