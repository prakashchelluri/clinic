import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useOutletContext } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { dialable, get } from '../api';
import { can } from '../App';
import { TakePayment } from '../takePayment';
import { openPrint } from '../printPreview';
import { FlagChips } from '../flags';
import { Chip, Icon, Num, money } from '../ui';
import { vitalFields, vitalsText } from '../vitals';
import { ReportDialog, type Order } from './TestReports';
import '../frontdesk.css';

/** The front desk as each patient's journey: Check-in → Initial screening → Doctor → Tests & procedures → Reports → Done. */

const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
const minsSince = (iso: string) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
const live = (r: any) => r.status !== 'cancelled';
const openRecs = (v: any) => (v.recommendations ?? []).filter((r: any) => r.status === 'open');
const recName = (r: any) => r.kind === 'procedure' ? `${r.procedure ?? 'Procedure'}${r.sittings ? ` × ${r.sittings}` : ''}` : r.kind === 'investigation' ? (r.notes || 'Test') : 'Review visit';
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

type Tone = 'sage' | 'amber' | 'sky' | 'rose' | '';
const TOK: Record<Tone, string> = { sage: 'bg-sage-soft text-sage', amber: 'bg-amber-soft text-amber', sky: 'bg-sky-soft text-sky', rose: 'bg-rose-soft text-rose', '': 'bg-paper-2 text-ink' };

/** How long a wait is fine; the ring on a token fills toward it and turns amber once it is passed. ponytail: one number for every clinic, a setting when a clinic asks. */
const WAIT_TARGET_MIN = 30;

/** Send in, with an arrow that walks through the door. */
export function SendIn({ ok, why, onClick, small = true }: { ok: boolean; why: string; onClick: () => void; small?: boolean }) {
  return <button className={`fd-send btn ${small ? 'btn-sm' : ''} btn-primary`} disabled={!ok} title={why} onClick={onClick}>
    <span className="fd-door"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 12h12M11 6l6 6-6 6" /></svg></span>
    {!ok && why.startsWith('Room') ? 'Room full' : 'Send in'}</button>;
}

/** The stage tiles: one ink drop slides and stretches to the chosen stage; a count that goes up pulses once. */
export function StageStrip({ items, tab, onTab, extra }: { items: [string, string, number, boolean, React.ReactNode?][]; tab: string; onTab: (k: any) => void; extra?: React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null); const [drop, setDrop] = useState<{ x: number; w: number } | null>(null);
  useLayoutEffect(() => {
    const el = box.current?.querySelector<HTMLElement>(`[data-k="${tab}"]`);
    setDrop(el ? { x: el.offsetLeft, w: el.offsetWidth } : null);
  }, [tab, items.length]);
  const prev = useRef<Record<string, number>>({}); const [pulse, setPulse] = useState<Record<string, number>>({});
  const born = useRef(Date.now()); // counts that arrive while the page loads are not news
  useEffect(() => {
    const up: Record<string, number> = {}; const settled = Date.now() - born.current > 4000;
    for (const [k, , n] of items) { if (settled && prev.current[k] !== undefined && n > prev.current[k]) up[k] = Date.now(); prev.current[k] = n; }
    if (Object.keys(up).length) setPulse((p) => ({ ...p, ...up }));
  }, [items.map((i) => i[2]).join()]);
  return (
    <div ref={box} className="fd-tiles mb-3 no-print" role="tablist" aria-label="Stage">
      {drop && <i aria-hidden="true" className="fd-drop" style={{ width: drop.w, transform: `translateX(${drop.x}px)` }} />}
      {items.map(([k, l, n, hot, sub]) => (
        <button key={`${k}:${pulse[k] ?? 0}`} data-k={k} role="tab" aria-selected={tab === k} className={`fd-tile shrink-0 ${pulse[k] ? 'fd-pulse' : ''}`} onClick={() => onTab(k)}>
          <span className="fd-lbl">{l}</span>
          <span className={`text-[22px] font-extrabold leading-none tabular-nums ${hot && tab !== k ? 'text-clay' : ''}`}><Num value={n} /></span>{sub && <span className="fd-sub">{sub}</span>}</button>))}
      {extra}
    </div>);
}

type StepState = 'done' | 'now' | 'next' | 'skip';
function Step({ i = 0, state, title, meta, last, children }: { i?: number; state: StepState; title: string; meta?: string; last?: boolean; children?: React.ReactNode }) {
  const dot = state === 'done' ? 'bg-clay' : state === 'now' ? 'bg-surface shadow-[inset_0_0_0_4px_var(--color-amber)]' : 'bg-surface shadow-[inset_0_0_0_2px_var(--color-line-2)]';
  return (
    <li className="grid grid-cols-[22px_minmax(0,1fr)] gap-x-3.5">
      <div className="flex flex-col items-center" style={{ '--i': i } as React.CSSProperties}><i className={`fd-dot mt-[3px] h-3.5 w-3.5 shrink-0 rounded-full ${dot} ${state === 'skip' ? 'opacity-50' : ''}`} />{!last && <i className={`fd-rail min-h-[18px] w-0.5 flex-1 ${state === 'done' ? 'bg-clay' : 'bg-line'}`} />}</div>
      <div className={`min-w-0 ${last ? '' : 'pb-4'}`}>
        <div className={`flex flex-wrap items-baseline gap-x-2 text-[14px] font-bold ${state === 'next' || state === 'skip' ? 'text-muted' : ''}`}>{title}{meta && <span className="text-[12.5px] font-medium text-muted">{meta}</span>}</div>
        {children}
      </div>
    </li>);
}

/** One patient's day, top to bottom; the open tasks sit inside the step they belong to. */
export function JourneyPanel({ v, order, screening, inLine, arrangeSlot, canDesk, onSendIn, onToJunior, canSend, onClose }: {
  v: any; order?: any; screening: 'off' | 'first' | 'required'; inLine: number; arrangeSlot: React.ReactNode; canDesk: boolean;
  onSendIn: (id: string) => void; onToJunior?: (id: string) => void; canSend: (v: any) => { ok: boolean; why: string }; onClose: () => void;
}) {
  const nav = useNavigate(); const { cfg } = useOutletContext<any>() ?? {};
  const [upload, setUpload] = useState<string | null>(null); // the test whose report is being added, right here in the drawer
  const d = v.details ?? {}; const left = v.status === 'left';
  const waiting = ['waiting', 'screened'].includes(v.status);
  const recs = (v.recommendations ?? []).filter(live); const open = openRecs(v);
  const tests = recs.filter((r: any) => r.kind === 'investigation');
  const vitals = vitalsText(d, vitalFields(cfg?.tenant?.settings)); // every vital taken, the clinic's own too
  const seen = v.status === 'done' || !!v.completedAt;
  const held = v.encounterStatus === 'awaiting_reports';
  const closed = !!d.checkoutClosedAt || (seen && open.length === 0);
  const finished = left || (seen && closed && !held);

  const vit: [StepState, string] = canDesk && onToJunior && v.status === 'waiting' && !d.screenedAt ? ['next', 'not yet'] : v.status === 'intake' ? ['now', 'with the junior doctor now'] : d.screenedAt ? ['done', `${hhmm(d.screenedAt)} · junior doctor`]
    : v.status === 'waiting' && screening === 'required' ? ['next', 'junior doctor sees them first'] : seen || v.status === 'in_consult' || screening === 'off' ? ['skip', 'not needed for this visit'] : ['next', 'if the junior doctor picks them'];
  const doc: [StepState, string] = left ? ['skip', 'left without seeing the doctor'] : seen ? ['done', `${v.completedAt ? hhmm(v.completedAt) : ''}${v.doctor ? ` · ${v.doctor}` : ''}`]
    : v.status === 'in_consult' ? ['now', `in the room${d.calledAt ? ` since ${hhmm(d.calledAt)} · ${minsSince(d.calledAt)} min` : ''}`] : ['next', `${v.doctor ?? 'no doctor picked'}${inLine ? ` · ${inLine === 1 ? 'next' : `${inLine}th in line`}` : ''}`];
  const arr: [StepState, string] = !seen ? ['next', 'if the doctor orders any'] : recs.length === 0 ? ['skip', 'none ordered'] : open.length ? ['now', `${open.length} pending`] : ['done', 'none pending'];
  const rep: [StepState, string] = tests.length === 0 ? (seen ? ['skip', 'no tests'] : ['next', '']) : held ? ['now', order ? `${order.got} of ${order.tests.length} in` : 'awaited'] : seen ? ['done', 'seen by the doctor'] : ['next', ''];

  return (
    <Drawer onClose={onClose} label={`Journey of ${v.patient.fullName}`}>
      <div className="flex items-center gap-3">
        <span className="grid h-12 min-w-12 shrink-0 place-items-center whitespace-nowrap rounded-[16px] bg-paper-2 px-2.5 text-[15px] font-extrabold tabular-nums">{v.opNumber}</span>
        <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-1.5"><b className="text-[18px] leading-tight">{v.patient.fullName}</b><FlagChips flags={v.patient.flags} /></div>
          <div className="truncate text-[12.5px] text-muted">{[[v.patient.ageYears, v.patient.sex].filter(Boolean).join(' '), v.patient.patientNo, v.patient.phone].filter(Boolean).join(' · ')}</div></div>
        <button className="btn btn-icon" aria-label="Close" title="Close" onClick={onClose}><Icon name="x" className="h-4 w-4" /></button>
      </div>

      <ol className="m-0 list-none p-0">
        <Step i={0} state="done" title="Checked in" meta={`${hhmm(v.arrivedAt)} · ${v.category}`}>{d.complaint && <div className="mt-0.5 text-[12.5px] text-muted">{d.complaint}</div>}</Step>
        <Step i={1} state={vit[0]} title="Junior doctor" meta={vit[1]}>{vitals && <div className="mt-0.5 text-[12.5px] text-muted">{vitals}</div>}{canDesk && onToJunior && v.status === 'waiting' && <div className="mt-2"><button className="btn btn-sm" onClick={() => onToJunior(v.id)}>Send to junior doctor</button></div>}</Step>
        <Step i={2} state={doc[0]} title="Doctor" meta={doc[1]}>
          {seen && v.rxCount > 0 && <div className="mt-0.5 text-[12.5px] text-muted">{plural(v.rxCount, 'medicine')} · the pharmacy has the Rx</div>}
          {canDesk && waiting && (() => { const s = canSend(v); return <div className="mt-2"><SendIn ok={s.ok} why={s.why} onClick={() => onSendIn(v.id)} /></div>; })()}
        </Step>
        <Step i={3} state={arr[0]} title="Tests & procedures" meta={arr[1]}>
          {seen && recs.length > 0 && (open.length ? <div className="mt-2">{arrangeSlot}</div>
            : <ul className="mt-1 space-y-0.5 text-[12.5px] text-muted">{recs.map((r: any) => <li key={r.id} className="flex items-center gap-1.5"><Icon name="check" className="h-3.5 w-3.5 text-clay" />{recName(r)}</li>)}</ul>)}
        </Step>
        <Step i={4} state={rep[0]} title="Reports" meta={rep[1]}>
          {order && held && <div className="mt-1.5 space-y-1.5 text-[12.5px] text-muted">{order.tests.map((t: any) => (
            <div key={t.id ?? t.name} className="flex items-center gap-2"><span className="min-w-0 flex-1"><b className="text-ink">{t.name}</b> · {t.receivedAt ? <b className="text-sage">in</b> : t.expectedOn ? `expected ${new Date(t.expectedOn).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}` : 'pending'}</span>
              {canDesk && !t.receivedAt && <button type="button" className="btn btn-sm shrink-0" onClick={() => setUpload(t.id)}><Icon name="plus" className="h-3.5 w-3.5" />Upload report</button>}</div>))}
            <div>The consultation stays open until the doctor sees them.</div></div>}
          {upload && order && <ReportDialog order={order} testId={upload} onClose={() => setUpload(null)} />}
        </Step>
        <Step i={5} last state={finished ? 'done' : 'next'} title={left ? 'Left' : 'Done'} meta={finished ? (left ? 'did not see the doctor' : 'nothing left open') : held ? 'when the doctor has seen the reports' : ''} />
      </ol>

      <PatientActions patientId={v.patient.id} name={v.patient.fullName} />
      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3.5">
        <button className="btn btn-sm" onClick={() => nav(`/patients/${v.patient.id}`)}>Record</button>
        {v.encounterId && !left && <button className="btn btn-sm" onClick={() => openPrint({ title: 'Prescription', rx: v.encounterId })}><Icon name="print" className="h-3.5 w-3.5" />Rx</button>}
        {v.due?.length > 0 && <Chip tone="rose">{money(v.due.reduce((x: number, c: any) => x + c.amountPaise - (c.paidPaise ?? 0), 0))} due</Chip>}
      </div>
    </Drawer>);
}

/** The two things the desk does for any patient on the calendar without leaving the Dashboard: bill them, and type in a lab result that came in. */
export function PatientActions({ patientId, name }: { patientId: string; name: string }) {
  const { perms } = useOutletContext<any>() ?? {};
  const canBill = can(perms ?? [], 'payment.record'); const canLab = can(perms ?? [], 'document.write');
  const orders = useQuery<{ orders: Order[] }>({ queryKey: ['orders'], queryFn: () => get('/orders'), enabled: canLab });
  const [billing, setBilling] = useState(false); const [picking, setPicking] = useState(false); const [lab, setLab] = useState<{ o: Order; t: string } | null>(null);
  // the patient's tests still waiting for a result
  const waiting = (orders.data?.orders ?? []).filter((o) => o.patient.id === patientId).flatMap((o) => o.tests.filter((t) => !t.receivedAt && !t.reviewedAt).map((t) => ({ o, t })));
  if (!canBill && !canLab) return null;
  const addLab = () => waiting.length === 1 ? setLab({ o: waiting[0].o, t: waiting[0].t.id }) : setPicking(!picking);
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        {canBill && <button type="button" className="btn justify-center" onClick={() => setBilling(true)}><Icon name="plus" className="h-3.5 w-3.5" />Create bill</button>}
        {canLab && <button type="button" className="btn justify-center" disabled={!waiting.length} title={waiting.length ? '' : 'No tests waiting for a result'} aria-expanded={waiting.length > 1 ? picking : undefined} onClick={addLab}><Icon name="plus" className="h-3.5 w-3.5" />Add lab results</button>}
      </div>
      {picking && waiting.length > 1 && <div className="rounded-[10px] border border-line p-1">{waiting.map(({ o, t }) =>
        <button key={t.id} type="button" className="flex w-full items-center justify-between rounded-[8px] px-3 py-2 text-left text-[13.5px] hover:bg-surface-2" onClick={() => { setPicking(false); setLab({ o, t: t.id }); }}>
          <b className="font-semibold">{t.name}</b><span className="text-[12px] text-muted">{t.expectedOn ? `expected ${new Date(t.expectedOn).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}` : 'pending'}</span></button>)}</div>}
      {billing && <TakePayment patientId={patientId} patientName={name} onClose={() => setBilling(false)} />}
      {lab && <ReportDialog order={lab.o} testId={lab.t} onClose={() => setLab(null)} />}
    </div>);
}

/** A side drawer on the right edge: the page stays as it is and stays usable; tapping another patient switches the drawer. ✕ or Escape closes it. */
function Drawer({ onClose, label, children }: { onClose: () => void; label: string; children: React.ReactNode }) {
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.modal-back')) close.current(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, []);
  return createPortal(
    <aside aria-label={label} className="fixed inset-y-0 right-0 z-30 flex w-[min(440px,100vw)] flex-col gap-4 overflow-y-auto border-l border-line bg-surface p-5 anim-slide-in" style={{ boxShadow: '-24px 0 48px -32px rgba(16,32,24,.45)' }}>
      {children}
    </aside>, document.body);
}
