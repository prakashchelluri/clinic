import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useOutletContext } from 'react-router';
import { get, today, errText } from '../api';
import { can } from '../App';
import { Icon, Skeleton, money } from '../ui';
import { DiscountAsks, useDiscountAsks } from '../takePayment';
import '../frontdesk.css';

const dayLabel = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const k = (p: number) => (Math.abs(p) >= 100000 ? `${(p / 100000).toFixed(1)}k` : String(Math.round(p / 100)));
const SECTIONS: [string, string][] = [['consultation', 'Consultations'], ['procedure', 'Procedures'], ['pharmacy', 'Pharmacy'], ['other', 'Other']];
type Need = { key: string; red?: boolean; title: string; where: string; body: React.ReactNode; act: string; to: string };

/**
 * The owner's page: yesterday and today without a click, and the few things only the owner should look at.
 * Today stays the doctor's landing page; this is one tap away. Same figures as End of day and Reports.
 */
export function Clinic() {
  const { perms } = useOutletContext<any>();
  const nav = useNavigate();
  const t = today();
  const sum = useQuery({ queryKey: ['owner-summary'], queryFn: () => get('/owner/summary'), refetchInterval: 60000 });
  const fd = useQuery({ queryKey: ['frontdesk', t], queryFn: () => get(`/frontdesk?day=${t}`), refetchInterval: 30000 });
  const procs = useQuery({ queryKey: ['psessions', 'day', t, 'owner'], queryFn: () => get(`/procedure-sessions?day=${t}&active=1`), refetchInterval: 60000, enabled: can(perms, 'worklist.read') });
  const stock = useQuery({ queryKey: ['stock'], queryFn: () => get('/stock'), refetchInterval: 60000, enabled: can(perms, 'stock.read') });
  const dash = useQuery({ queryKey: ['analytics', t, t, ''], queryFn: () => get(`/reports/analytics?from=${t}&to=${t}`), refetchInterval: 60000 });
  const asks = useDiscountAsks(can(perms, 'discount.approve')); const askN: number = asks.data?.length ?? 0;
  const [open, setOpen] = useState<Need | null>(null);
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(null); }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, []);

  if (sum.isError) return <div className="fd-sheet flex flex-wrap items-center justify-center gap-3 py-10 text-[14px]"><span>Couldn't load the clinic figures. {errText(sum.error)}</span><button className="btn btn-sm btn-primary" onClick={() => sum.refetch()}>Retry</button></div>;
  const s = sum.data;
  if (!s) return <div className="space-y-4"><Skeleton rows={3} /><Skeleton rows={4} /></div>;

  const visits: any[] = fd.data?.visits ?? [];
  const waiting = visits.filter((v) => ['waiting', 'intake', 'screened'].includes(v.status));
  const longest = waiting.length ? Math.max(...waiting.map((v) => Math.round((Date.now() - new Date(v.arrivedAt).getTime()) / 60000))) : 0;
  const ps: any[] = procs.data ?? [];
  const reviews: any[] = stock.data?.reviews ?? [];
  const expired: number = stock.data?.tiles?.expired ?? 0;
  const mode = (m: any) => `${k(m.cash)} · ${k(m.upi)} · ${k(m.card)}`;
  const table = (m: any) => (
    <div className="grid grid-cols-[minmax(0,1.3fr)_repeat(3,minmax(0,1fr))] text-[13.5px] font-semibold tabular-nums">
      {['', 'Cash', 'UPI', 'Card'].map((h) => <span key={h} className={`pb-1.5 text-[12px] text-muted ${h ? 'text-right' : ''}`}>{h}</span>)}
      {[...SECTIONS.filter(([key]) => m[key].total !== 0), ['total', 'Total'] as [string, string]].map(([key, label]) => [
        <span key={key} className={`border-t border-line py-2 ${key === 'total' ? 'font-bold' : 'font-medium'}`}>{label}</span>,
        ...['cash', 'upi', 'card'].map((x) => <span key={key + x} className={`border-t border-line py-2 text-right ${key === 'total' ? 'font-bold' : ''}`}>{money(m[key][x])}</span>)])}
    </div>);

  // only what needs the owner, each with the one place to deal with it
  const needs: Need[] = [
    ...(askN ? [{ key: 'disc', red: true, title: `${askN} discount${askN === 1 ? '' : 's'} above the limit to approve`, where: 'Today', act: 'Open Today', to: '/', body: <div className="-mx-1"><DiscountAsks /></div> }] : []),
    // one day: its money table; several: one row, each day listed in the drawer
    ...(s.unclosed.length === 1 ? s.unclosed.map((u: any): Need => ({ key: `day${u.day}`, red: true, title: `${dayLabel(u.day)} was never closed`, where: 'End of day', act: 'Open End of day', to: `/reports?day=${u.day}&view=eod`,
      body: <>{table(u.money)}<p className="text-[13px] text-muted">Payments for this day stay open until it is closed. Counting the cash and the diary is on the End of day screen.</p></> }))
      : s.unclosed.length > 1 ? [{ key: 'days', red: true, title: `${s.unclosed.length} days were never closed`, where: 'End of day', act: 'Open End of day', to: '/reports',
        body: <><div>{s.unclosed.map((u: any) => <div key={u.day} className="flex justify-between gap-3 border-t border-line py-2.5 text-[14px] font-semibold tabular-nums"><span>{dayLabel(u.day)}</span><span className="font-medium text-muted">{money(u.money.total.total)} taken</span></div>)}</div>
          <p className="text-[13px] text-muted">Payments for these days stay open until each is closed. Counting the cash and the diary is on the End of day screen.</p></> }] : []),
    ...(reviews.length ? [{ key: 'stock', title: `${reviews.length} deliver${reviews.length === 1 ? 'y differs' : 'ies differ'} from the bill`, where: 'Inventory', act: 'Check deliveries', to: '/inventory',
      body: <div>{reviews.map((r: any) => <div key={r.id} className="flex justify-between gap-3 border-t border-line py-2.5 text-[14px] font-semibold"><span>{r.vendor ?? 'Vendor'}{r.billNo ? ` · bill ${r.billNo}` : ''}</span><span className="text-[13px] font-medium text-muted">{r.lines?.length ?? 0} line{r.lines?.length === 1 ? '' : 's'} to check</span></div>)}</div> }] : []),
    ...(expired > 0 ? [{ key: 'exp', title: `${expired} expired still on the shelf`, where: 'Inventory', act: 'Take them off', to: '/inventory?tab=batches', body: <p className="text-[14px]">They can no longer be sold. Taking them off writes them off the stock.</p> }] : []),
    ...(s.emi.n ? [{ key: 'emi', title: `${money(s.emi.totalPaise)} EMI not yet paid by the lender`, where: 'Accounts', act: 'Open Accounts', to: '/accounts?tab=due', body: <p className="text-[14px]">{s.emi.n} EMI payment{s.emi.n === 1 ? '' : 's'} counted as received, waiting for the lender to settle.</p> }] : []),
    ...(s.dues.totalPaise ? [{ key: 'due', title: `${money(s.dues.totalPaise)} still due from ${s.dues.patients} patient${s.dues.patients === 1 ? '' : 's'}`, where: 'Accounts', act: 'Open Accounts', to: '/accounts?tab=due', body: <p className="text-[14px]">Consultations, sittings or other charges billed and not yet paid.</p> }] : []),
  ];
  const yc = s.yesterday.closed;
  const max = Math.max(1, ...s.week.map((w: any) => w.totalPaise));
  const tiles: any[] = dash.data?.overview?.perDoctor ?? [];

  return (
    <div className="space-y-4">
      <h1 className="sr-only">Clinic</h1>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.15fr)]">
        <section className="fd-sheet p-5 anim-fade-up">
          <div className="text-[11.5px] font-bold uppercase tracking-wider text-muted">Yesterday · {dayLabel(s.yesterday.day)}</div>
          <div className="my-2 text-[30px] font-bold tabular-nums">{money(s.yesterday.money.total.total)}</div>
          {SECTIONS.filter(([key]) => s.yesterday.money[key].total !== 0).map(([key, label]) => <Row key={key} a={label} b={money(s.yesterday.money[key].total)} />)}
          <Row a="Cash · UPI · Card" b={mode(s.yesterday.money.total)} />
          <div className="mt-2 text-[13px] text-muted">{yc ? `Closed by ${yc.by}${yc.cashDiffPaise ? ` · cash ${money(Math.abs(yc.cashDiffPaise))} ${yc.cashDiffPaise < 0 ? 'short' : 'over'}${yc.notes?.cash ? `: “${yc.notes.cash}”` : ''}` : ' · cash matched'}` : <span className="font-semibold text-rose">Not closed yet</span>}</div>
        </section>
        <section className="fd-sheet p-5 anim-fade-up">
          <div className="text-[11.5px] font-bold uppercase tracking-wider text-muted">Today so far</div>
          <div className="my-2 text-[30px] font-bold tabular-nums">{money(s.todayMoney.total.total)}</div>
          <Row a="Patients" b={`${visits.length} · ${waiting.length} waiting`} />
          {can(perms, 'worklist.read') && <Row a="Procedures" b={`${ps.filter((p) => p.state === 'completed').length} of ${ps.length} done`} />}
          <Row a="Pharmacy" b={money(s.todayMoney.pharmacy.total)} />
          <Row a="Longest wait now" b={waiting.length ? `${longest} min` : '—'} />
        </section>
        <section className="fd-sheet overflow-hidden anim-fade-up">
          <div className="flex items-baseline gap-2 px-5 pb-2 pt-4"><b className="text-[15px]">Needs you</b>{needs.length > 0 && <span className="text-[13px] text-muted">{needs.length}</span>}</div>
          {needs.length === 0 ? <div className="px-5 pb-5 text-[13.5px] text-muted">All clear.</div> : needs.map((n) => (
            <button key={n.key} type="button" className={`flex w-full items-center gap-3 border-t border-line px-5 py-3 text-left hover:bg-surface-2 ${open?.key === n.key ? 'bg-surface-2' : ''}`} onClick={() => setOpen(n)}>
              <b className={`text-[14px] ${n.red ? 'text-rose' : ''}`}>{n.title}</b><span className="ml-auto shrink-0 text-[12.5px] text-muted">{n.where}</span></button>))}
        </section>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="fd-sheet p-5 anim-fade-up">
          <div className="flex items-baseline gap-2"><b className="text-[15px]">This week, collected</b><span className="text-[12.5px] text-muted">the same figure as End of day</span></div>
          <div className="mt-4 grid h-[140px] items-end gap-3" style={{ gridTemplateColumns: `repeat(${Math.max(6, s.week.length)}, minmax(0, 1fr))` }} role="img" aria-label={`Collected this week: ${s.week.map((w: any) => `${dayLabel(w.day)} ${money(w.totalPaise)}`).join(', ')}`}>
            {s.week.map((w: any) => <span key={w.day} className="flex h-full flex-col items-center justify-end gap-1.5">
              <b className="text-[12px] tabular-nums">{w.totalPaise ? k(w.totalPaise) : ''}</b>
              <i className={`block w-full max-w-[52px] rounded-t-[7px] rounded-b-[3px] ${w.day === t ? 'bg-clay' : 'bg-line-2'}`} style={{ height: `${Math.round((w.totalPaise / max) * 100)}%` }} />
              <span className="text-[12px] text-muted">{new Date(w.day + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', timeZone: 'UTC' })}</span></span>)}
          </div>
        </section>
        <section className="fd-sheet p-5 anim-fade-up">
          <b className="text-[15px]">Doctors today</b>
          <div className="mt-2 grid grid-cols-[minmax(0,1fr)_64px_72px_110px] gap-x-3 text-[13.5px] tabular-nums">
            {['Doctor', 'Completed', 'Waiting', 'Collected'].map((h, i) => <span key={h} className={`pb-1.5 text-[11.5px] font-bold uppercase tracking-wider text-muted ${i === 3 ? 'text-right' : ''}`}>{h}</span>)}
            {tiles.map((d) => [
              <b key={d.id} className="truncate border-t border-line py-2.5">{d.name}</b>,
              <span key={d.id + 's'} className="border-t border-line py-2.5">{visits.filter((v) => v.practitionerId === d.id && v.status === 'done').length}</span>,
              <span key={d.id + 'w'} className="border-t border-line py-2.5">{waiting.filter((v) => v.practitionerId === d.id).length}</span>,
              <span key={d.id + 'b'} className="border-t border-line py-2.5 text-right">{d.collectedPaise !== null ? money(d.collectedPaise) : '—'}</span>])}
          </div>
          <div className="mt-2 text-[12.5px] text-muted">Collected is money received for each doctor's consultations and sittings, less refunds, from the same figures as End of day. Pharmacy and course advances are not split by doctor.</div>
        </section>
      </div>

      {open && createPortal(
        <aside aria-label={open.title} className="fixed inset-y-0 right-0 z-30 flex w-[min(440px,100vw)] flex-col gap-4 overflow-y-auto border-l border-line bg-surface p-5 anim-slide-in" style={{ boxShadow: '-24px 0 48px -32px rgba(16,32,24,.45)' }}>
          <div className="flex items-center gap-3"><b className="min-w-0 flex-1 text-[18px]">{open.title}</b><button className="btn btn-icon" aria-label="Close" onClick={() => setOpen(null)}><Icon name="x" className="h-4 w-4" /></button></div>
          {open.body}
          <div className="mt-auto flex gap-2 border-t border-line pt-3.5"><button className="btn btn-primary" onClick={() => nav(open.to)}>{open.act}</button><button className="btn" onClick={() => setOpen(null)}>Later</button></div>
        </aside>, document.body)}
    </div>
  );
}

function Row({ a, b }: { a: string; b: string }) {
  return <div className="flex justify-between gap-3 border-t border-line py-1.5 text-[14px] font-semibold tabular-nums"><span className="font-medium text-muted">{a}</span><span>{b}</span></div>;
}
