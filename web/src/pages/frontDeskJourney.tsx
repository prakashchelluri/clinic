import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useOutletContext } from 'react-router';
import { dialable } from '../api';
import { openPrint } from '../printPreview';
import { FlagChips } from '../flags';
import { Chip, Icon, Num, money } from '../ui';
import { vitalFields, vitalsText } from '../vitals';
import { ReportDialog } from './TestReports';
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

type Status = { label: string; tone: Tone };
/** One row of the desk's table: token, patient, visit, doctor, status, time, the one action. */
function Item({ token, tone = '', p, visit, doctor, status, time, selected, onSelect, action, wait, leaving }: { token: React.ReactNode; tone?: Tone; p: any; visit?: React.ReactNode; doctor?: string | null; status: Status; time?: React.ReactNode; selected?: boolean; onSelect?: () => void; action?: React.ReactNode; wait?: number; leaving?: boolean }) {
  const who = <><span className="flex flex-wrap items-center gap-1.5"><b className="text-[14px]">{p.fullName}</b><FlagChips flags={p.flags} /></span><span className="block truncate text-[12px] text-muted">{[[p.ageYears, p.sex].filter(Boolean).join(' '), p.patientNo, p.phone].filter(Boolean).join(' · ')}</span></>;
  return (
    <tr className={`fd-tr ${leaving ? 'fd-leaving' : ''} ${selected ? 'is-sel' : ''}`}>
      <td className="w-[76px]"><span className={`fd-tok grid h-9 place-items-center whitespace-nowrap rounded-[12px] px-1.5 text-[12.5px] font-extrabold tabular-nums ${TOK[tone]}`} title={wait !== undefined ? `Waiting ${wait} min · the target is ${WAIT_TARGET_MIN}` : undefined}>
        {wait !== undefined && <i aria-hidden="true" className={`fd-ring ${wait >= WAIT_TARGET_MIN ? 'over' : ''}`} style={{ '--p': `${Math.min(100, Math.round((wait / WAIT_TARGET_MIN) * 100))}%` } as React.CSSProperties} />}{token}</span></td>
      <td className="min-w-[200px]">{onSelect ? <button type="button" className="block min-w-0 text-left" aria-pressed={selected} title="Show the journey" onClick={onSelect}>{who}</button> : who}</td>
      <td className="max-w-[220px] truncate text-ink-2">{visit ?? '—'}</td>
      <td className="whitespace-nowrap text-ink-2">{doctor ?? '—'}</td>
      <td><span className={`chip ${status.tone ? `chip-${status.tone}` : ''} whitespace-nowrap`}>{status.label}</span></td>
      <td className="whitespace-nowrap tabular-nums text-muted">{time ?? '—'}</td>
      <td className="text-right"><div className="flex items-center justify-end gap-1.5">{action}</div></td>
    </tr>);
}

function Group({ title, n, tone, hint, children }: { title: string; n: number; tone: Tone; hint?: string; children: React.ReactNode }) {
  if (!n) return null;
  return (
    <tbody aria-label={title}>
      <tr className="fd-gh"><th colSpan={7}><span className="flex items-center gap-2.5"><b className="text-[14px] text-ink">{title}</b><span className={`inline-grid h-6 min-w-6 place-items-center rounded-full px-1.5 text-[12px] font-extrabold ${TOK[tone]}`}>{n}</span>{hint && <span className="ml-auto text-[12px] font-medium text-muted">{hint}</span>}</span></th></tr>
      {children}
    </tbody>);
}


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

/** Every token of the day in journey order. ← → step through them and the drawer follows; Enter sends the chosen patient in. */
export function Filmstrip({ visits, selectedId, onSelect, onEnter }: { visits: any[]; selectedId: string | null; onSelect: (id: string) => void; onEnter: (v: any) => void }) {
  const rank = (v: any) => ['done', 'left'].includes(v.status) ? (openRecs(v).length ? 1 : 0) : v.status === 'in_consult' ? 2 : v.status === 'intake' ? 3 : 4;
  const list = [...visits].sort((a, b) => rank(a) - rank(b) || a.arrivedAt.localeCompare(b.arrivedAt));
  const cls = (v: any) => ['', 'arr', 'doc', 'jr', ''][rank(v)] + (rank(v) === 0 ? ' done' : '');
  const cur = useRef({ list, selectedId, onSelect, onEnter }); cur.current = { list, selectedId, onSelect, onEnter };
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.altKey || e.ctrlKey || e.metaKey || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable || t.closest?.('[role=dialog],[role=alertdialog],dialog,.modal-back') || document.querySelector('.modal-back')) return;
      const { list, selectedId, onSelect, onEnter } = cur.current; if (!list.length) return;
      const i = list.findIndex((v) => v.id === selectedId);
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); const j = i < 0 ? (e.key === 'ArrowRight' ? list.findIndex((v) => rank(v) === 4) : list.length - 1) : Math.max(0, Math.min(list.length - 1, i + (e.key === 'ArrowRight' ? 1 : -1))); const id = list[j < 0 ? 0 : j].id; onSelect(id); requestAnimationFrame(() => strip.current?.querySelector<HTMLElement>(`[data-ft="${id}"]`)?.focus({ preventScroll: true })); }
      // Enter sends in only from the strip itself (focus on a token), never from wherever focus happened to land after a dialog closed
      else if (e.key === 'Enter' && i >= 0 && strip.current?.contains(t)) { e.preventDefault(); onEnter(list[i]); }
    };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, []);
  // keep the chosen token in view by scrolling the strip sideways only; scrollIntoView would also move the page
  const strip = useRef<HTMLElement>(null);
  useEffect(() => {
    const s = strip.current, b = s?.querySelector<HTMLElement>(`[data-ft="${selectedId}"]`); if (!s || !b) return;
    if (b.offsetLeft < s.scrollLeft + 60 || b.offsetLeft + b.offsetWidth > s.scrollLeft + s.clientWidth - 60) s.scrollTo({ left: b.offsetLeft - s.clientWidth / 2, behavior: 'smooth' });
  }, [selectedId]);
  if (!list.length) return null;
  return (
    <nav ref={strip} className={`fd-strip fd-sheet mt-4 no-print transition-[margin] duration-300 ${selectedId ? 'md:mr-[436px]' : ''}`} aria-label="Today's tokens: arrow keys step through them">
      <span className="mr-1 shrink-0 text-[11px] font-bold uppercase tracking-[.08em] text-muted">Today</span>
      {list.map((v, i) => <span key={v.id} className="contents">{i > 0 && rank(list[i - 1]) !== rank(v) && <i aria-hidden="true" className="mx-1 h-6 w-px shrink-0 bg-line" />}
        <button type="button" data-ft={v.id} className={`fd-ft ${cls(v)}`} aria-current={selectedId === v.id} title={`${v.patient.fullName} · ${['done', 'tests or procedures pending', 'with the doctor', 'with the junior doctor', 'waiting'][rank(v)]}`} onClick={() => onSelect(v.id)}>{v.opNumber}</button></span>)}
      <span className="ml-auto shrink-0 pl-3 text-[12px] text-muted">← → step · Enter sends in</span>
    </nav>);
}

/** Only what needs the desk, in the order to do it, as one table. Everyone else is a chip at the bottom. */
export function NextForYou({ sendable, arrange, reportsIn, reportsLate, late, withDue, idle, selectedId, onSelect, canSend, onSendIn, onReportsArrive, onCheckIn, onCollect, docName, catName, freeDays, doctorHead }: {
  sendable: any[]; arrange: any[]; reportsIn: any[]; reportsLate: any[]; late: any[]; withDue: any[]; idle: { v: any; label: string }[];
  selectedId: string | null; onSelect: (id: string) => void; canSend: (v: any) => { ok: boolean; why: string }; onSendIn: (id: string) => void;
  onReportsArrive: (o: any) => void; onCheckIn: (a: any) => void; onCollect: (v: any) => void; docName: (id: string | null) => string; catName: (code: string) => string; freeDays: number; doctorHead?: React.ReactNode;
}) {
  const nav = useNavigate();
  // Send in: the row lifts and leaves first, then the request goes; if it fails the row comes back
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const send = (id: string) => {
    setLeaving((s) => new Set(s).add(id));
    setTimeout(() => { onSendIn(id); setTimeout(() => setLeaving((s) => { const n = new Set(s); n.delete(id); return n; }), 2000); }, 420);
  };
  // a patient whose last task was just settled: one tick, then gone
  const prevArr = useRef<Map<string, string> | null>(null); const [ticks, setTicks] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    const now = new Map(arrange.map((v) => [v.id, v.patient.fullName as string]));
    const gone = prevArr.current ? [...prevArr.current].filter(([id]) => !now.has(id)).map(([id, name]) => ({ id, name })) : [];
    prevArr.current = now;
    if (gone.length) { setTicks((t) => [...t, ...gone]); setTimeout(() => setTicks((t) => t.filter((x) => !gone.some((g) => g.id === x.id))), 1800); }
  }, [arrange.map((v) => v.id).join()]);
  const total = sendable.length + arrange.length + reportsIn.length + reportsLate.length + late.length + withDue.length;
  const day = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  return (
    <div className="fd-sheet overflow-hidden pb-1 anim-fade-up">
      {total === 0 && <div className="px-5 py-10 text-center"><div className="text-[15px] font-bold">All clear</div><div className="mt-1 text-sm text-muted">Nothing needs the desk right now. New work shows here as it happens.</div></div>}
      {ticks.map((t) => <div key={t.id} className="fd-tick px-5 py-3 text-[14px]" role="status"><Icon name="check" className="h-5 w-5" />Nothing pending · {t.name} leaves this list</div>)}
      {total > 0 && <div className="overflow-x-auto"><table className="fd-table">
        <thead><tr><th>Token</th><th>Patient</th><th>Visit</th><th>{doctorHead ?? 'Doctor'}</th><th>Status</th><th>Time</th><th className="text-right">Action</th></tr></thead>
        <Group title="Send in now" n={sendable.length} tone="sage" hint="in queue order">
          {sendable.map((v) => { const s = canSend(v); const w = minsSince(v.arrivedAt); return (
            <Item key={v.id} token={v.opNumber} tone={v.details?.reportsEncounterId ? 'sage' : ''} p={v.patient} visit={catName(v.category)} doctor={v.doctor ?? 'no doctor picked'} selected={selectedId === v.id} onSelect={() => onSelect(v.id)} wait={w} leaving={leaving.has(v.id)}
              status={v.details?.reportsEncounterId ? { label: 'Back with reports', tone: 'sage' } : v.details?.screenedAt ? { label: 'Screening done', tone: 'sky' } : !s.ok && s.why.startsWith('Room') ? { label: 'Room full', tone: 'amber' } : { label: 'Ready', tone: 'sage' }}
              time={<span className={w >= WAIT_TARGET_MIN ? 'font-semibold text-amber' : ''}>waiting {w} min</span>}
              action={<SendIn ok={s.ok && !leaving.has(v.id)} why={s.why} onClick={() => send(v.id)} />} />); })}
        </Group>
        <Group title="Pending tests & procedures" n={arrange.length} tone="amber">
          {arrange.map((v) => { const rs = (v.recommendations ?? []).filter(live); const open = openRecs(v);
            const kinds = [['investigation', 'test'], ['procedure', 'procedure'], ['followup', 'review']].map(([k, w]) => { const n = rs.filter((r: any) => r.kind === k).length; return n ? plural(n, w) : ''; }).filter(Boolean).join(', ');
            return <Item key={v.id} token={v.opNumber} tone="amber" p={v.patient} visit={kinds} doctor={v.doctor} selected={selectedId === v.id} onSelect={() => onSelect(v.id)}
              status={{ label: `${open.length} pending`, tone: 'amber' }} time={v.completedAt ? `seen ${minsSince(v.completedAt)} min ago` : undefined}
              action={<button className="btn btn-sm btn-ink" onClick={() => onSelect(v.id)}>Open</button>} />; })}
        </Group>
        <Group title="Reports came in" n={reportsIn.length} tone="sky" hint="send in when the patient arrives">
          {reportsIn.map((o) => <Item key={o.key} token="—" p={o.patient} visit={o.tests.map((t: any) => t.name).join(', ')} doctor={o.doctor}
            status={{ label: `Reports in · ${o.got} of ${o.tests.length}`, tone: 'sky' }} time={`ordered ${day(o.orderedAt)}`}
            action={(() => { const free = Math.floor((Date.now() - new Date(o.orderedAt).getTime()) / 86400000) <= freeDays; return <button className="btn btn-sm btn-primary" title={free ? 'No form and no fee: straight to the doctor for the report review' : `Past the ${freeDays} free days: check in with the usual fee`} onClick={() => onReportsArrive(o)}>{free ? 'Send in' : 'Patient is here'}</button>; })()} />)}
        </Group>
        <Group title="Reports running late" n={reportsLate.length} tone="rose">
          {reportsLate.map((o) => <Item key={o.key} token="—" p={o.patient} visit={o.late.join(', ')} doctor={o.doctor}
            status={{ label: 'Lab is late', tone: 'rose' }} time={`ordered ${day(o.orderedAt)}`}
            action={<button className="btn btn-sm" onClick={() => nav('/tests')}>Reports</button>} />)}
        </Group>
        <Group title="Booked, not arrived" n={late.length} tone="rose">
          {late.map((a) => <Item key={a.id} token={a.window.startTime} tone="rose" p={a.patient} visit={a.service ?? 'Booking'} doctor={docName(a.window.practitionerId)}
            status={{ label: 'Not arrived', tone: 'rose' }} time={`slot ${a.window.startTime}–${a.window.endTime}`}
            action={<button className="btn btn-sm btn-primary" onClick={() => onCheckIn(a)}>Check in</button>} />)}
        </Group>
        <Group title="Money due" n={withDue.length} tone="rose">
          {withDue.map((v) => { const due = v.due.reduce((x: number, c: any) => x + c.amountPaise - (c.paidPaise ?? 0), 0); return (
            <Item key={v.id} token={v.opNumber} tone="rose" p={v.patient} visit={catName(v.category)} doctor={v.doctor} selected={selectedId === v.id} onSelect={() => onSelect(v.id)}
              status={{ label: `${money(due)} due`, tone: 'rose' }} action={<button className="btn btn-sm btn-primary" onClick={() => onCollect(v)}>Collect {money(due)}</button>} />); })}
        </Group>
      </table></div>}
      {idle.length > 0 && <div className={`flex flex-wrap items-center gap-1.5 px-5 pb-3 pt-3 ${total ? 'border-t border-line' : ''}`}>
        <span className="mr-1 text-[12.5px] text-muted">Nothing to do for</span>
        {idle.map(({ v, label }) => <button key={v.id} type="button" onClick={() => onSelect(v.id)} className={`inline-flex h-7 items-center rounded-full px-3 text-[12px] font-bold ${selectedId === v.id ? 'bg-ink text-paper' : 'bg-paper-2 text-ink-2 hover:text-ink'}`}>{v.patient.fullName.split(' ')[0]} · {label}</button>)}
      </div>}
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

      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3.5">
        <button className="btn btn-sm" onClick={() => nav(`/patients/${v.patient.id}`)}>Record</button>
        {v.encounterId && !left && <button className="btn btn-sm" onClick={() => openPrint({ title: 'Prescription', rx: v.encounterId })}><Icon name="print" className="h-3.5 w-3.5" />Rx</button>}
        {v.due?.length > 0 && <Chip tone="rose">{money(v.due.reduce((x: number, c: any) => x + c.amountPaise - (c.paidPaise ?? 0), 0))} due</Chip>}
      </div>
    </Drawer>);
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
