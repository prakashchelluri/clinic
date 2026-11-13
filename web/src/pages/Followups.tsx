import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useOutletContext, useSearchParams } from 'react-router';
import { get, post, patch, qc, today, errText } from '../api';
import { can } from '../App';
import { Drawer, Icon, MoreMenu, PageHeader, fmtDate, toast } from '../ui';
import { FlagChips } from '../flags';
import { DataTable, type Col, type FilterDef } from '../table';
import { ScheduleModal } from './Worklist';

type Tab = 'all' | 'confirm' | 'reviews' | 'missed' | 'procedures';
/** One list, four reasons to call. Each tab says who is in it and what ends the call. */
const TABS: [Tab, string, string][] = [['all', 'All calls', 'Everyone to call today, whatever the reason.'],
  ['reviews', 'Review visits', 'The doctor asked to see them again. They come up on the review date; book the visit and they leave the list.'],
  ['procedures', 'Procedures to book', 'A procedure was advised (the patient is still deciding) or a course is running and its next sitting is not booked. Book the sitting, or close it if the patient says no.'],
  ['confirm', 'Confirm sittings', 'A sitting is booked. Ring a week before and again the day before: Confirmed, or move it.'],
  ['missed', 'Missed', 'Booked a visit or a sitting and did not come. Book again, or close it.']];
type Out = 'booked' | 'call_later' | 'no_answer' | 'not_interested' | 'confirmed';
const OUT: Record<Out, string> = { booked: 'Booked', call_later: 'Call later', no_answer: 'No answer', not_interested: 'Not interested', confirmed: 'Confirmed' };
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
const KIND: Record<string, string> = { review: 'Review visit due', missed_visit: 'Missed a booked visit', missed_sitting: 'Missed a sitting', schedule: 'Course agreed · next sitting to book', advised: 'Procedure advised · patient deciding', confirm_week: 'Confirm · a week before', confirm_day: 'Confirm · the day before' };
const isConfirm = (r: any) => r.kind === 'confirm_week' || r.kind === 'confirm_day';
const refresh = () => ['followups', 'worklist', 'bookings', 'orders'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));

const days = (d: string) => Math.round((Date.parse(d) - Date.parse(today())) / 864e5);
/** The day a row is to be called: a call-back day that has come, else when it fell due. (A call-back still ahead is the Waiting switch's business, not the Due filter's.) */
const callOn = (r: any): string | null => { const cb = r.lastCall?.callbackOn; return cb && cb <= today() ? cb : r.dueOn; };
const bucket = (r: any) => { const d = callOn(r); if (!d) return 'nodate'; const n = days(d); return n < 0 ? 'over' : n === 0 ? 'today' : n <= 7 ? 'week' : 'later'; };
const DUE: FilterDef<any> = {
  key: 'due', label: 'Due', icon: 'clock', initial: 'now',
  options: [{ value: 'all', label: 'Any day' }, { value: 'now', label: 'Overdue & today' }, { value: 'over', label: 'Overdue' }, { value: 'today', label: 'Today' }, { value: 'week', label: 'Next 7 days' }],
  test: (r, v) => { const b = bucket(r); return v === 'all' || b === v || (v === 'now' && (b === 'over' || b === 'today' || b === 'nodate')); },
};
const LAST: FilterDef<any> = {
  key: 'last', label: 'Last call', icon: 'phone',
  options: [{ value: 'any', label: 'Any' }, { value: 'none', label: 'Not called yet' }, { value: 'no_answer', label: 'No answer' }, { value: 'call_later', label: 'Call later' }],
  test: (r, v) => v === 'any' || (v === 'none' ? !r.lastCall : r.lastCall?.outcome === v),
};
const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
const PROC = ['schedule', 'advised', 'missed_sitting'];

/** One Calls list: reviews due, missed visits and sittings, procedure plans. Each row: No answer · Call later · Book. */
export function Calls() {
  const { perms } = useOutletContext<any>(); const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const tab = (TABS.some((t) => t[0] === sp.get('tab')) ? sp.get('tab') : 'all') as Tab;
  const [calling, setCalling] = useState<{ row: any; out?: Out } | null>(null);
  const [sitting, setSitting] = useState<any>(null);
  const [moving, setMoving] = useState<any>(null); // a confirm row whose sitting the patient wants on another day
  const q = useQuery({ queryKey: ['followups', tab], queryFn: () => get(`/followups?tab=${tab}`), refetchInterval: 30000 });
  const rows: any[] = q.data?.rows ?? []; const counts = q.data?.counts ?? {};
  const canWrite = can(perms, 'worklist.write');
  const canBook = can(perms, 'appointment.write');

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
    { key: 'name', label: 'Patient', fixed: true, sort: (r) => r.patient.fullName.toLowerCase(), csv: (r) => r.patient.fullName, cell: (r) => (
      <div className="flex min-w-[200px] items-center gap-2.5">
        <span className="dt-av" aria-hidden="true">{initials(r.patient.fullName)}</span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5"><button type="button" className="truncate text-left font-semibold hover:text-clay hover:underline" onClick={() => nav(`/patients/${r.patient.id}`)}>{r.patient.fullName}</button><FlagChips flags={r.patient.flags} /></div>
          <div className="text-[12px] text-muted">{[r.patient.patientNo, [r.patient.ageYears, r.patient.sex].filter(Boolean).join(' ')].filter(Boolean).join(' · ')}</div>
        </div>
      </div>) },
    { key: 'phone', label: 'Phone', csv: (r) => r.patient.phone, cell: (r) => r.patient.phone ? <span className="inline-flex items-center gap-1.5 whitespace-nowrap font-semibold tabular-nums text-ink-2"><Icon name="phone" className="h-3.5 w-3.5 text-muted" />{r.patient.phone}</span> : <span className="text-muted">No phone</span> },
    { key: 'what', label: 'Why call', sort: (r) => KIND[r.kind] ?? '', csv: (r) => `${KIND[r.kind] ?? ''}: ${r.what}`, cell: (r) => (
      <div className="max-w-[320px]"><div className="font-semibold text-ink-2">{KIND[r.kind] ?? r.kind}</div><div className="truncate text-[12px] text-muted" title={r.what}>{r.what}</div></div>) },
    { key: 'due', label: 'Due', sort: (r) => callOn(r) ?? '', csv: (r) => r.dueOn, cell: (r) => {
      if (!r.dueOn) return <span className="text-muted">No date set</span>;
      const n = days(r.dueOn);
      return <div className="whitespace-nowrap"><div className="font-semibold">{fmtDate(r.dueOn)}</div><div className={`text-[12px] ${n < -4 ? 'text-rose' : 'text-muted'}`}>{n < 0 ? `${-n} day${n === -1 ? '' : 's'} overdue` : n === 0 ? 'Due today' : `In ${n} day${n === 1 ? '' : 's'}`}</div></div>;
    } },
    { key: 'last', label: 'Last call', sort: (r) => -(r.lastCall?.attempts ?? 0), csv: (r) => r.lastCall ? `${OUT[r.lastCall.outcome as Out]} (${r.lastCall.attempts})` : 'Not called yet', cell: (r) => {
      const c = r.lastCall;
      if (!c) return <span className="text-muted">Not called yet</span>;
      const cb = c.callbackOn ? (days(c.callbackOn) === 0 ? 'Call back today' : `Call back ${fmtDate(c.callbackOn)}`) : null;
      return <div title={`${c.attempts} call${c.attempts === 1 ? '' : 's'} · last by ${c.by}, ${fmtDate(c.at)}${c.note ? ` (${c.note})` : ''}`}>
        <span>{OUT[c.outcome as Out]}{c.note ? ` · ${c.note}` : ''}</span>
        <div className="mt-0.5 whitespace-nowrap text-[12px] text-muted">{cb ?? `${c.attempts} attempt${c.attempts === 1 ? '' : 's'} · ${String(c.by).split(' (')[0]}, ${fmtDate(c.at)}`}</div>
      </div>;
    } },
    { key: 'act', label: '', fixed: true, align: 'right', className: 'dt-act', cell: (r) => (
      // the usual good outcome is a button (Confirmed for a booked sitting, Book for everything else); the other outcomes are in the menu
      <span className="inline-flex items-center justify-end gap-1.5 whitespace-nowrap">
      {canWrite && isConfirm(r) ? <button type="button" className="btn btn-sm btn-primary" disabled={confirmed.isPending} onClick={() => confirmed.mutate(r)}>Confirmed</button>
        : bookable(r) ? <button type="button" className="btn btn-sm btn-primary" onClick={() => book(r)}>Book</button> : null}
      <MoreMenu text="Other" label={`Other outcomes of the call to ${r.patient.fullName}`} items={[
        { label: 'Wants another day…', hidden: !canWrite || !isConfirm(r), onClick: () => setMoving(r) },
        { label: 'No answer', hidden: !canWrite, onClick: () => many.mutate({ list: [r], send: false }) },
        { label: 'Call later…', hidden: !canWrite, onClick: () => setCalling({ row: r, out: 'call_later' }) },
        { label: isConfirm(r) ? 'Not coming…' : 'Close with a reason…', hidden: !canWrite, onClick: () => setCalling({ row: r, out: 'not_interested' }) },
        { label: 'Open patient', onClick: () => nav(`/patients/${r.patient.id}`) },
        { label: 'Copy phone number', hidden: !r.patient.phone, onClick: () => navigator.clipboard?.writeText(r.patient.phone).then(() => toast('Number copied'), () => toast('Could not copy', 'err')) },
      ]} /></span>) },
  ];

  return (
    <div>
      <PageHeader title="Calls" subtitle="Who to ring today and why. After the call, press the button or pick what happened; a booked or closed row leaves the list." />
      <div className="mb-3 text-[13px] text-muted">{TABS.find((t) => t[0] === tab)![2]}</div>
      <DataTable
        id="calls" exportName={`calls-${tab}-${today()}`} rows={rows} rowKey={(r) => r.key} columns={columns}
        loading={q.isLoading} error={q.error} onRetry={() => q.refetch()} empty={{ title: 'Nobody to call here', hint: TABS.find((t) => t[0] === tab)![2] }}
        tabs={TABS.map(([v, l]) => ({ value: v, label: l, count: counts[v] }))} tab={tab}
        onTab={(v) => setSp((p) => { const n = new URLSearchParams(p); v === 'all' ? n.delete('tab') : n.set('tab', v); return n; }, { replace: true })}
        search={{ placeholder: 'Find a call: name, phone or patient no.', text: (r) => [r.patient.fullName, r.patient.phone, r.patient.patientNo] }}
        sort={{ key: 'due' }} filters={[DUE, LAST]} toggles={[{ key: 'waiting', label: 'Show waiting for call-back', hides: (r) => !!r.waiting }]}
        bulk={canWrite ? (list, clear) => <>
          <button type="button" className="dt-ghost" disabled={many.isPending} onClick={() => many.mutate({ list, send: true }, { onSuccess: clear })}><Icon name="message" className="h-3.5 w-3.5" />No answer, send a message</button>
          <button type="button" className="dt-ghost" disabled={many.isPending} onClick={() => many.mutate({ list, send: false }, { onSuccess: clear })}>No answer</button>
        </> : undefined}
      />
      {calling && <CallDialog row={calling.row} initial={calling.out} onBook={bookable(calling.row) ? () => book(calling.row) : undefined} onMove={isConfirm(calling.row) && canWrite ? () => setMoving(calling.row) : undefined} onClose={() => setCalling(null)} />}
      {moving && <ScheduleModal rec={{ id: moving.recId, procedureId: moving.procedureId, sittings: moving.sittings, patient: moving.patient }} sitting={moving.sitting} onClose={() => { setMoving(null); refresh(); qc.invalidateQueries({ queryKey: ['calendar'] }); }} />}
      {sitting && <ScheduleModal rec={sitting} onClose={() => { setSitting(null); refresh(); qc.invalidateQueries({ queryKey: ['calendar'] }); }} />}
    </div>
  );
}

function CallDialog({ row, initial, onBook, onMove, onClose }: { row: any; initial?: Out; onBook?: () => void; onMove?: () => void; onClose: () => void }) {
  const list: { label: string; out: Out | 'book' | 'move'; note?: string }[] = isConfirm(row) ? CONFIRM_OUTCOMES : OUTCOMES;
  const [pick, setPick] = useState<number>(() => Math.max(0, list.findIndex((o) => o.out === (initial ?? (isConfirm(row) ? 'confirmed' : 'call_later')))));
  const o = list[pick]; const outcome = o.out;
  const [date, setDate] = useState(''); const [note, setNote] = useState(''); const [send, setSend] = useState(true);
  const go = useMutation({
    mutationFn: async (confirmClosedDay?: boolean) => {
      // not coming to a booked sitting: postpone it first (frees the room and the doctor), then log the call
      if (isConfirm(row) && outcome === 'not_interested') await patch(`/procedure-sessions/${row.sitting.id}`, { state: 'postponed', reason: `Not coming: ${[o.note, note.trim()].filter(Boolean).join(' · ')}` });
      return post('/followups/log', { kind: row.kind, refId: row.refId, patientId: row.patient.id, outcome, note: [o.note, note.trim()].filter(Boolean).join(' · ') || undefined, callbackOn: outcome === 'call_later' ? date : undefined, sendMessage: outcome === 'no_answer' && !o.note ? send : undefined, confirmClosedDay });
    },
    onSuccess: (r: any) => { refresh(); toast(r.messaged ? 'Logged. A short message is on its way' : 'Logged'); onClose(); },
    onError: (e: any) => { if (e?.body?.code === 'CLOSED_DAY' && confirm(`${fmtDate(date)} is a Sunday and the clinic may be closed. Use this date anyway?`)) go.mutate(true); else toast(errText(e), 'err'); },
  });
  const bad = outcome === 'book' || outcome === 'move' || (outcome === 'call_later' && (!date || date < today())) || (outcome === 'not_interested' && !o.note && note.trim().length < 3);
  return (
    <Drawer title={row.patient.fullName} subtitle={`${row.what}${row.patient.phone ? ` · ${row.patient.phone}` : ''}`} onClose={onClose} width="max-w-md">
      <div className="space-y-3">
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="How did the call go">{list.map((x, i) => (x.out !== 'book' || onBook) && (x.out !== 'move' || onMove) && <button key={x.label} type="button" role="radio" aria-checked={pick === i} className={`toggle-opt ${pick === i ? 'on' : ''}`} onClick={() => setPick(i)}>{x.label}</button>)}</div>
        {outcome === 'call_later' && <div><label className="label" htmlFor="cb">Call again on</label><input id="cb" type="date" min={today()} className="input" value={date} onChange={(e) => setDate(e.target.value)} /></div>}
        {outcome === 'no_answer' && !o.note && row.patient.phone && <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-clay" checked={send} onChange={(e) => setSend(e.target.checked)} />Send a short message with the clinic number</label>}
        {outcome === 'book' && <div className="text-sm text-muted">Book the visit or sitting; that takes the patient off the list.</div>}
        {outcome === 'move' && <div className="text-sm text-muted">Pick the new day and time; the patient is called again before it.</div>}
        {outcome !== 'book' && outcome !== 'move' && <div><label className="label" htmlFor="nt">{outcome === 'not_interested' && !o.note ? 'Why (required)' : 'Note (optional)'}</label><input id="nt" className="input" maxLength={180} value={note} onChange={(e) => setNote(e.target.value)} /></div>}
        <div className="modal-foot"><button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          {outcome === 'move' ? <button className="btn btn-primary" onClick={() => { onClose(); onMove?.(); }}><Icon name="calendar" />Move</button>
            : outcome === 'book' ? <button className="btn btn-primary" onClick={() => { onClose(); onBook?.(); }}><Icon name="calendar" />Book</button>
            : <button className="btn btn-primary" disabled={bad || go.isPending} onClick={() => go.mutate(undefined)}><Icon name="check" />Save</button>}</div>
      </div>
    </Drawer>
  );
}
