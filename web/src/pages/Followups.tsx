import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useOutletContext, useSearchParams } from 'react-router';
import { get, post, patch, qc, today, errText } from '../api';
import { can } from '../App';
import { Chip, Drawer, Icon, MoreMenu, PageHeader, Segmented, fmtDate, fmtTime, money, toast } from '../ui';
import { DataTable, type Col } from '../table';
import { ScheduleModal } from './Worklist';

type Out = 'booked' | 'call_later' | 'no_answer' | 'not_interested' | 'confirmed';
const OUT: Record<Out, string> = { booked: 'Booked', call_later: 'Call later', no_answer: 'No answer', not_interested: 'Closed', confirmed: 'Confirmed' };
/** The outcomes the procedure plans always used, each saved as one of the four call results. "Will come" books. */
const OUTCOMES: { label: string; out: Out | 'book'; note?: string }[] = [
  { label: 'Will come', out: 'book' }, { label: 'Call later', out: 'call_later' }, { label: 'No answer', out: 'no_answer' },
  // the closing ones take the patient off the list, each with its reason
  { label: 'Declined', out: 'not_interested' }, { label: 'Done elsewhere', out: 'not_interested', note: 'Done elsewhere' }, { label: 'Moved away', out: 'not_interested', note: 'Moved away' }, { label: 'Wrong number', out: 'not_interested', note: 'Wrong number' },
];
/** A booked sitting's confirm call: the patient says yes, does not pick up, wants another day (Move), or is not coming (the sitting is postponed). */
const CONFIRM_OUTCOMES: { label: string; out: Out | 'move'; note?: string }[] = [
  { label: 'Confirmed', out: 'confirmed' }, { label: 'No answer', out: 'no_answer' }, { label: 'Call later', out: 'call_later' }, { label: 'Wants another day', out: 'move' }, { label: 'Not coming', out: 'not_interested' },
];
const isConfirm = (r: any) => r.kind === 'confirm_week' || r.kind === 'confirm_day';
const PROC = ['schedule', 'advised', 'missed_sitting'];
/** Consultation or procedure: what the call is about */
const isProc = (r: any) => PROC.includes(r.kind) || isConfirm(r);
/** The reason, short: the table's one line */
const reason = (r: any): string => ({ review: 'Review visit', missed_visit: 'No show', missed_sitting: 'No show', advised: 'Advised · patient deciding', confirm_week: 'Confirm session · a week before', confirm_day: 'Confirm session · the day before' } as Record<string, string>)[r.kind]
  ?? (/to book/.test(r.what) ? 'Book next session' : 'Book first session');
const refresh = () => ['followups', 'worklist', 'bookings', 'orders'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));

const days = (d: string) => Math.round((Date.parse(d) - Date.parse(today())) / 864e5);
const shift = (d: string, n: number) => { const x = new Date(d + 'T00:00:00'); x.setDate(x.getDate() + n); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
const monday = (d: string) => shift(d, -((new Date(d + 'T00:00:00').getDay() + 6) % 7));
const dayName = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
/** The day a row is to be called: the call-back day the patient asked for, else when it fell due; no date = now. */
const callOn = (r: any): string => r.lastCall?.callbackOn ?? r.dueOn ?? today();
/** Late by more than this and the row leaves the list, behind a link: nobody rings about August in November. */
const STALE = 30;
/** "10 Nov, 11:42 am": when a call was made */
const when = (at: string) => `${fmtDate(at.slice(0, 10))}, ${fmtTime(at.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'))}`;
const status = (r: any) => {
  const c = r.lastCall; if (!c) return 'Not called';
  if (c.outcome === 'call_later' && c.callbackOn) return days(c.callbackOn) === 0 ? 'Call back today' : `Call back ${fmtDate(c.callbackOn)}`;
  return `${OUT[c.outcome as Out] ?? c.outcome}${c.attempts > 1 ? ` · ${c.attempts} tries` : ''}`;
};

/** Calls: who to ring on a day (or across a week), in one table by due date. A row opens the call in the side drawer. */
export function Calls() {
  const { perms } = useOutletContext<any>(); const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const [day, setDay] = useState(today()); const [mode, setMode] = useState<'day' | 'week'>('day');
  const [type, setType] = useState<'all' | 'consult' | 'proc'>('all'); const [old, setOld] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [sitting, setSitting] = useState<any>(null);
  const [moving, setMoving] = useState<any>(null); // a confirm row whose sitting the patient wants on another day
  const q = useQuery({ queryKey: ['followups', 'all'], queryFn: () => get('/followups?tab=all'), refetchInterval: 30000 });
  const all: any[] = q.data?.rows ?? [];
  const canWrite = can(perms, 'worklist.write');
  const canBook = can(perms, 'appointment.write');

  // the dates on show: one day, or Monday to Sunday; the days before today come along only while today is on show
  const week = mode === 'week'; const from = week ? monday(day) : day; const to = week ? shift(from, 6) : day;
  const now = today(); const withLate = from <= now && now <= to;
  const stale = all.filter((r) => days(callOn(r)) < -STALE);
  const dated = old ? stale : all.filter((r) => { const d = callOn(r); return (d >= from && d <= to) || (withLate && d < now && days(d) >= -STALE); });
  const ofType = (t: typeof type) => dated.filter((r) => t === 'all' || (t === 'proc') === isProc(r));
  const rows = ofType(type);
  const late = rows.filter((r) => callOn(r) < now).length;

  const log = (r: any, outcome: Out, extra: object = {}) => post('/followups/log', { kind: r.kind, refId: r.refId, patientId: r.patient.id, outcome, ...extra });
  // several rows at once: each gets its own No answer, as if logged one by one
  const many = useMutation({
    mutationFn: async ({ list, send }: { list: any[]; send: boolean }) => { let n = 0, sent = 0; for (const r of list) { const x: any = await log(r, 'no_answer', { sendMessage: send }); n++; if (x.messaged) sent++; } return { n, sent }; },
    onSuccess: ({ n, sent }) => { refresh(); toast(`Logged ${n} call${n === 1 ? '' : 's'} as no answer${sent ? `; ${sent} message${sent === 1 ? '' : 's'} on the way` : ''}`); },
    onError: (e) => { refresh(); toast(errText(e), 'err'); },
  });
  const confirmed = useMutation({ mutationFn: (r: any) => log(r, 'confirmed'), onSuccess: () => { refresh(); toast('Confirmed'); }, onError: (e) => { refresh(); toast(errText(e), 'err'); } });

  /** Book: a sitting for a procedure plan, a visit (pre-filled) for everything else. Booking takes the row off the list. */
  const bookable = (r: any) => isConfirm(r) ? false : (PROC.includes(r.kind) ? canWrite && !!r.recId && !!r.procedureId : canBook);
  const book = (r: any) => {
    if (PROC.includes(r.kind)) { setSitting({ id: r.recId, procedureId: r.procedureId, sittings: r.sittings, dueOn: r.dueOn, patient: r.patient }); return; }
    const p = new URLSearchParams(sp); p.set('book', '1'); p.set('patient', r.patient.id); p.set('pname', r.patient.fullName);
    if (r.kind === 'review') p.set('rec', r.refId);
    if (r.dueOn && r.dueOn >= today()) p.set('day', r.dueOn);
    setSp(p);
  };

  const columns: Col<any>[] = [
    { key: 'due', label: 'Due date', fixed: true, sort: (r) => callOn(r), csv: (r) => callOn(r), cell: (r) => {
      const d = callOn(r); const n = days(d);
      return <span className="whitespace-nowrap"><b className="font-semibold">{n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : fmtDate(d)}</b>{n < 0 && <span className="text-[12.5px] font-medium text-rose"> · {-n} day{n === -1 ? '' : 's'} late</span>}</span>;
    } },
    { key: 'name', label: 'Patient', fixed: true, sort: (r) => r.patient.fullName.toLowerCase(), csv: (r) => r.patient.fullName, cell: (r) => <span className="font-semibold">{r.patient.fullName}</span> },
    { key: 'phone', label: 'Phone', csv: (r) => r.patient.phone, cell: (r) => r.patient.phone ? <span className="whitespace-nowrap tabular-nums">{r.patient.phone}</span> : <span className="text-muted">No phone</span> },
    { key: 'type', label: 'Type', sort: (r) => Number(isProc(r)), csv: (r) => isProc(r) ? 'Procedure' : 'Consultation', cell: (r) => <Chip tone={isProc(r) ? 'sage' : 'clay'}>{isProc(r) ? 'Procedure' : 'Consultation'}</Chip> },
    { key: 'reason', label: 'Reason', sort: (r) => reason(r), csv: (r) => `${reason(r)}: ${r.what}`, cell: (r) => <span className="whitespace-nowrap">{reason(r)}</span> },
    { key: 'status', label: 'Call status', sort: (r) => -(r.lastCall?.attempts ?? 0), csv: (r) => status(r), cell: (r) => <span className={`whitespace-nowrap ${r.lastCall ? '' : 'text-muted'}`}>{status(r)}</span> },
    { key: 'act', label: '', fixed: true, align: 'right', className: 'dt-act', cell: (r) => (
      // the two everyday outcomes are buttons (No answer, and Book or Confirmed); the rest are in the menu and the drawer
      <span className="inline-flex items-center justify-end gap-1.5 whitespace-nowrap">
      {canWrite && <button type="button" className="btn btn-sm" disabled={many.isPending} onClick={() => many.mutate({ list: [r], send: false })}>No answer</button>}
      {canWrite && isConfirm(r) ? <button type="button" className="btn btn-sm btn-primary" disabled={confirmed.isPending} onClick={() => confirmed.mutate(r)}>Confirmed</button>
        : bookable(r) ? <button type="button" className="btn btn-sm btn-primary" onClick={() => book(r)}>Book</button> : null}
      <MoreMenu label={`Other outcomes of the call to ${r.patient.fullName}`} items={[
        { label: 'Wants another day…', hidden: !canWrite || !isConfirm(r), onClick: () => setMoving(r) },
        { label: 'Call later…', hidden: !canWrite, onClick: () => setOpen(r.key) },
        { label: isConfirm(r) ? 'Not coming…' : 'Close with a reason…', hidden: !canWrite, onClick: () => setOpen(r.key) },
        { label: 'View profile', onClick: () => nav(`/patients/${r.patient.id}`) },
        { label: 'Copy phone number', hidden: !r.patient.phone, onClick: () => navigator.clipboard?.writeText(r.patient.phone).then(() => toast('Number copied'), () => toast('Could not copy', 'err')) },
      ]} /></span>) },
  ];

  const isToday = !week && day === now;
  const n = (t: typeof type) => ofType(t).length;
  const bar = <>
    <button type="button" className="btn btn-icon !h-8 !w-8" aria-label={week ? 'Previous week' : 'Previous day'} onClick={() => { setOld(false); setDay(shift(day, week ? -7 : -1)); }}><Icon name="chevL" className="h-4 w-4" /></button>
    <label className="fd-sch-date"><span>{old ? `More than ${STALE} days late` : week ? `${dayName(from)} – ${dayName(to)}` : isToday ? `Today · ${dayName(day)}` : dayName(day)}</span><input type="date" aria-label="Pick a day" value={day} onChange={(e) => { if (e.target.value) { setOld(false); setDay(e.target.value); } }} /></label>
    <button type="button" className="btn btn-icon !h-8 !w-8" aria-label={week ? 'Next week' : 'Next day'} onClick={() => { setOld(false); setDay(shift(day, week ? 7 : 1)); }}><Icon name="chevR" className="h-4 w-4" /></button>
    <Segmented<'day' | 'week'> size="sm" value={mode} onChange={(m) => { setMode(m); setOld(false); if (m === 'day') setDay(now); }} options={[{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }]} />
    {(old || (!isToday && !(week && withLate))) && <button type="button" className="btn btn-sm" onClick={() => { setOld(false); setDay(now); }}>Back to today</button>}
    <span className="mx-1 h-5 w-px bg-line" aria-hidden="true" />
    {([['all', 'All'], ['consult', 'Consultations'], ['proc', 'Procedures']] as const).map(([k, l]) => <button key={k} type="button" className={`toggle-opt ${type === k ? 'on' : ''}`} aria-pressed={type === k} onClick={() => setType(k)}>{l} <b className="ml-1">{n(k)}</b></button>)}
  </>;
  const row = all.find((r) => r.key === open) ?? null;

  return (
    <div>
      <PageHeader title="Calls" />
      <DataTable
        id="calls2" exportName={`calls-${from}${week ? `-${to}` : ''}`} rows={rows} rowKey={(r) => r.key} columns={columns}
        loading={q.isLoading} error={q.error} onRetry={() => q.refetch()} empty={{ title: old ? 'No old calls' : 'Nobody to call', hint: week ? 'Nothing is due this week.' : 'Nothing is due on this day.' }}
        toolbar={bar} onRow={(r) => setOpen(r.key)} selected={open}
        search={{ placeholder: 'Name, phone or patient no.', text: (r) => [r.patient.fullName, r.patient.phone, r.patient.patientNo] }}
        sort={{ key: 'due' }}
        bulk={canWrite ? (list, clear) => <>
          <button type="button" className="dt-ghost" disabled={many.isPending} onClick={() => many.mutate({ list, send: true }, { onSuccess: clear })}><Icon name="message" className="h-3.5 w-3.5" />No answer, send a message</button>
          <button type="button" className="dt-ghost" disabled={many.isPending} onClick={() => many.mutate({ list, send: false }, { onSuccess: clear })}>No answer</button>
        </> : undefined}
      />
      <div className="mt-2 flex items-center gap-3 px-1 text-[12.5px] text-muted">
        <span>{rows.length} call{rows.length === 1 ? '' : 's'}{late ? ` · ${late} late` : ''}</span>
        {stale.length > 0 && <button type="button" className="ml-auto font-medium text-clay hover:underline" onClick={() => setOld(!old)}>{old ? 'Back to the list' : `${stale.length} more than ${STALE} days late · show`}</button>}
      </div>
      {row && <CallDrawer key={row.key} row={row} fees={can(perms, 'fees.see')} canWrite={canWrite} onBook={bookable(row) ? () => book(row) : undefined} onMove={isConfirm(row) && canWrite ? () => setMoving(row) : undefined} onProfile={() => nav(`/patients/${row.patient.id}`)} onClose={() => setOpen(null)} />}
      {moving && <ScheduleModal rec={{ id: moving.recId, procedureId: moving.procedureId, sittings: moving.sittings, patient: moving.patient }} sitting={moving.sitting} onClose={() => { setMoving(null); refresh(); qc.invalidateQueries({ queryKey: ['calendar'] }); }} />}
      {sitting && <ScheduleModal rec={sitting} onClose={() => { setSitting(null); refresh(); qc.invalidateQueries({ queryKey: ['calendar'] }); }} />}
    </div>
  );
}

/** One call in the side drawer: the reason in full, every call so far (date, time, who), and what happened on this one. */
function CallDrawer({ row, fees, canWrite, onBook, onMove, onProfile, onClose }: { row: any; fees: boolean; canWrite: boolean; onBook?: () => void; onMove?: () => void; onProfile: () => void; onClose: () => void }) {
  const list: { label: string; out: Out | 'book' | 'move'; note?: string }[] = isConfirm(row) ? CONFIRM_OUTCOMES : OUTCOMES;
  const [pick, setPick] = useState<number>(() => Math.max(0, list.findIndex((o) => o.out === (isConfirm(row) ? 'confirmed' : 'call_later'))));
  const o = list[pick]; const outcome = o.out;
  const [date, setDate] = useState(''); const [note, setNote] = useState(''); const [send, setSend] = useState(true);
  const go = useMutation({
    mutationFn: async (confirmClosedDay?: boolean) => {
      // not coming to a booked sitting: postpone it first (frees the room and the doctor), then log the call
      if (isConfirm(row) && outcome === 'not_interested') await patch(`/procedure-sessions/${row.sitting.id}`, { state: 'postponed', reason: `Not coming: ${[o.note, note.trim()].filter(Boolean).join(' · ')}` });
      return post('/followups/log', { kind: row.kind, refId: row.refId, patientId: row.patient.id, outcome, note: [o.note, note.trim()].filter(Boolean).join(' · ') || undefined, callbackOn: outcome === 'call_later' ? date : undefined, sendMessage: outcome === 'no_answer' && !o.note ? send : undefined, confirmClosedDay });
    },
    onSuccess: (r: any) => { refresh(); toast(r.messaged ? 'Saved. A short message is on its way' : 'Saved'); onClose(); },
    onError: (e: any) => { if (e?.body?.code === 'CLOSED_DAY' && confirm(`${fmtDate(date)} is a Sunday and the clinic may be closed. Use this date anyway?`)) go.mutate(true); else toast(errText(e), 'err'); },
  });
  const bad = outcome === 'book' || outcome === 'move' || (outcome === 'call_later' && (!date || date < today())) || (outcome === 'not_interested' && !o.note && note.trim().length < 3);
  const d = callOn(row); const n = days(d); const x = row.detail ?? {};
  const facts: [string, string][] = [
    [isProc(row) ? 'Procedure' : 'For', row.what],
    ...(x.by || x.advisedOn ? [['Advised by', [x.by, x.advisedOn && fmtDate(String(x.advisedOn).slice(0, 10))].filter(Boolean).join(' · ')] as [string, string]] : []),
    ...(x.gapDays ? [['Gap', `Every ${x.gapDays} days`] as [string, string]] : []),
    ...(fees && x.amountPaise ? [['Price', money(x.amountPaise)] as [string, string]] : []),
  ];
  const history: any[] = row.history ?? [];
  return (
    <Drawer title={row.patient.fullName} subtitle={row.patient.phone ?? 'No phone'} onClose={onClose} width="max-w-md">
      <div className="space-y-5">
        <section className="space-y-2">
          <div className="flex items-center gap-2"><Chip tone={isProc(row) ? 'sage' : 'clay'}>{isProc(row) ? 'Procedure' : 'Consultation'}</Chip>
            <span className={`ml-auto text-[12.5px] font-medium ${n < 0 ? 'text-rose' : 'text-muted'}`}>Due {n === 0 ? 'today' : n === 1 ? 'tomorrow' : fmtDate(d)}{n < 0 ? ` · ${-n} day${n === -1 ? '' : 's'} late` : ''}</span></div>
          <div className="text-[15px] font-semibold">{reason(row)}</div>
          <dl className="grid grid-cols-[100px_1fr] gap-x-3 gap-y-1.5 text-[13px]">{facts.flatMap(([k, v]) => [<dt key={`t${k}`} className="text-muted">{k}</dt>, <dd key={`d${k}`}>{v}</dd>])}</dl>
        </section>
        <section className="space-y-2">
          <div className="text-[13px] font-semibold text-ink-2">Call history · {history.length}</div>
          {history.length === 0 ? <div className="text-[13px] text-muted">Not called yet.</div>
            : <div className="divide-y divide-line rounded-[8px] border border-line">{history.map((c, i) => <div key={i} className="flex gap-3 px-3 py-2 text-[13px]">
              <span className="w-[118px] shrink-0 whitespace-nowrap text-muted">{when(c.at)}</span>
              <span className="min-w-0 flex-1">{OUT[c.outcome as Out] ?? c.outcome}{c.callbackOn ? ` · call back ${fmtDate(c.callbackOn)}` : ''}{c.note ? ` · ${c.note}` : ''}</span>
              <span className="shrink-0 text-muted">{String(c.by).split(' (')[0]}</span></div>)}</div>}
        </section>
        {canWrite && <section className="space-y-3">
          <div className="text-[13px] font-semibold text-ink-2">What happened on this call</div>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="How did the call go">{list.map((y, i) => (y.out !== 'book' || onBook) && (y.out !== 'move' || onMove) && <button key={y.label} type="button" role="radio" aria-checked={pick === i} className={`toggle-opt ${pick === i ? 'on' : ''}`} onClick={() => setPick(i)}>{y.label}</button>)}</div>
          {outcome === 'call_later' && <div><label className="label" htmlFor="cb">Call back on</label><input id="cb" type="date" min={today()} className="input" value={date} onChange={(e) => setDate(e.target.value)} /></div>}
          {outcome === 'no_answer' && !o.note && row.patient.phone && <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-clay" checked={send} onChange={(e) => setSend(e.target.checked)} />Send a short message with the clinic number</label>}
          {outcome === 'book' && <div className="text-sm text-muted">Book the visit or session; that takes the patient off the list.</div>}
          {outcome === 'move' && <div className="text-sm text-muted">Pick the new day and time; the patient is called again before it.</div>}
          {outcome !== 'book' && outcome !== 'move' && <div><label className="label" htmlFor="nt">{outcome === 'not_interested' && !o.note ? 'Why (required)' : 'Note (optional)'}</label><input id="nt" className="input" maxLength={180} value={note} onChange={(e) => setNote(e.target.value)} /></div>}
        </section>}
        <button type="button" className="inline-flex items-center gap-1.5 text-[13px] font-medium text-clay hover:underline" onClick={onProfile}><Icon name="eye" className="h-4 w-4" />View profile</button>
        {canWrite && <div className="modal-foot"><button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          {outcome === 'move' ? <button className="btn btn-primary" onClick={() => { onClose(); onMove?.(); }}><Icon name="calendar" />Move</button>
            : outcome === 'book' ? <button className="btn btn-primary" onClick={() => { onClose(); onBook?.(); }}><Icon name="calendar" />Book</button>
            : <button className="btn btn-primary" disabled={bad || go.isPending} onClick={() => go.mutate(undefined)}><Icon name="check" />Save call</button>}</div>}
      </div>
    </Drawer>
  );
}
