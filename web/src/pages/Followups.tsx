import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useOutletContext, useSearchParams } from 'react-router';
import { get, post, qc, today, errText } from '../api';
import { can } from '../App';
import { Icon, Modal, MoreMenu, PageHeader, fmtDate, toast } from '../ui';
import { FlagChips } from '../flags';
import { DataTable, type Col, type FilterDef } from '../table';

type Tab = 'reviews' | 'missed' | 'schedule' | 'advised';
const TABS: [Tab, string, string][] = [['reviews', 'Reviews due', 'Patients the doctor asked to see again'], ['missed', 'Missed visits', 'Booked and did not come, visits and sittings'], ['schedule', 'Procedures to schedule', 'Price agreed, no sitting booked yet'], ['advised', 'Advised, not agreed', 'The doctor advised; the patient has not said yes']];
const OUT: Record<string, string> = { booked: 'Booked', call_later: 'Call later', no_answer: 'No answer', not_interested: 'Not interested' };
const KIND: Record<string, string> = { review: 'Review', missed_visit: 'Missed visit', missed_sitting: 'Missed sitting', schedule: 'Price agreed', advised: 'Advised, not agreed' };
const refresh = () => ['followups', 'worklist', 'bookings'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));

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

/** Who to call today, in four lists, as one table: the most overdue first, filters for when it fell due and how the last call went. */
export function Followups() {
  const { perms } = useOutletContext<any>(); const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const tab = (TABS.some((t) => t[0] === sp.get('tab')) ? sp.get('tab') : 'reviews') as Tab;
  const [calling, setCalling] = useState<any>(null);
  const q = useQuery({ queryKey: ['followups', tab], queryFn: () => get(`/followups?tab=${tab}`), refetchInterval: 30000 });
  const rows: any[] = q.data?.rows ?? []; const counts = q.data?.counts ?? {};
  const canWrite = can(perms, 'worklist.write');

  // several rows at once: each gets its own No answer, as if logged one by one
  const many = useMutation({
    mutationFn: async ({ list, send }: { list: any[]; send: boolean }) => { let n = 0, sent = 0; for (const r of list) { const x: any = await post('/followups/log', { kind: r.kind, refId: r.refId, patientId: r.patient.id, outcome: 'no_answer', sendMessage: send }); n++; if (x.messaged) sent++; } return { n, sent }; },
    onSuccess: ({ n, sent }) => { refresh(); toast(`Logged ${n} call${n === 1 ? '' : 's'} as no answer${sent ? `; ${sent} message${sent === 1 ? '' : 's'} on the way` : ''}`); },
    onError: (e) => { refresh(); toast(errText(e), 'err'); },
  });

  const columns: Col<any>[] = [
    { key: 'name', label: 'Patient', fixed: true, sort: (r) => r.patient.fullName.toLowerCase(), csv: (r) => r.patient.fullName, cell: (r) => (
      <div className="flex min-w-[200px] items-center gap-2.5">
        <span className="dt-av" aria-hidden="true">{initials(r.patient.fullName)}</span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5"><button type="button" className="truncate text-left font-bold hover:text-clay hover:underline" onClick={() => nav(`/patients/${r.patient.id}`)}>{r.patient.fullName}</button><FlagChips flags={r.patient.flags} /></div>
          <div className="text-[12px] text-muted">{[r.patient.patientNo, [r.patient.ageYears, r.patient.sex].filter(Boolean).join(' ')].filter(Boolean).join(' · ')}</div>
        </div>
      </div>) },
    { key: 'what', label: 'Reason', csv: (r) => r.what, cell: (r) => (
      <div className="max-w-[300px]"><div className="truncate text-ink-2" title={r.what}>{r.what}</div>{KIND[r.kind] && r.what !== KIND[r.kind] && <div className="text-[12px] text-muted">{KIND[r.kind]}</div>}</div>) },
    { key: 'due', label: 'Due', sort: (r) => callOn(r) ?? '', csv: (r) => r.dueOn, cell: (r) => {
      if (!r.dueOn) return <span className="text-muted">No date set</span>;
      const n = days(r.dueOn);
      return <div className="whitespace-nowrap"><div className="font-semibold">{fmtDate(r.dueOn)}</div><div className={`text-[12px] font-semibold ${n < -4 ? 'text-rose' : n < 0 ? 'text-amber' : n === 0 ? 'text-clay' : 'text-muted'}`}>{n < 0 ? `${-n} day${n === -1 ? '' : 's'} overdue` : n === 0 ? 'Due today' : `In ${n} day${n === 1 ? '' : 's'}`}</div></div>;
    } },
    { key: 'last', label: 'Last call', sort: (r) => -(r.lastCall?.attempts ?? 0), csv: (r) => r.lastCall ? `${OUT[r.lastCall.outcome]} (${r.lastCall.attempts})` : 'Not called yet', cell: (r) => {
      const c = r.lastCall;
      if (!c) return <span className="dt-st text-muted"><span className="dt-dot" />Not called yet</span>;
      const cb = c.callbackOn ? (days(c.callbackOn) === 0 ? 'Call back today' : `Call back ${fmtDate(c.callbackOn)}`) : null;
      return <div title={`${c.attempts} call${c.attempts === 1 ? '' : 's'} · last by ${c.by}, ${fmtDate(c.at)}${c.note ? ` (${c.note})` : ''}`}>
        <span className="dt-st"><span className={`dt-dot ${c.outcome === 'no_answer' ? 'amber' : c.outcome === 'call_later' ? 'sky' : ''}`} />{OUT[c.outcome]}</span>
        <div className="mt-0.5 whitespace-nowrap text-[12px] text-muted">{cb ?? `${c.attempts} attempt${c.attempts === 1 ? '' : 's'} · ${String(c.by).split(' (')[0]}, ${fmtDate(c.at)}`}</div>
      </div>;
    } },
    { key: 'phone', label: 'Phone', csv: (r) => r.patient.phone, cell: (r) => r.patient.phone ? <span className="whitespace-nowrap font-semibold tabular-nums text-ink-2">{r.patient.phone}</span> : <span className="text-muted">—</span> },
    { key: 'act', label: '', fixed: true, align: 'right', className: 'dt-act', cell: (r) => (
      <div className="flex items-center justify-end gap-1">
        {canWrite && <button type="button" className="dt-ghost" onClick={() => setCalling(r)}>Log call</button>}
        <MoreMenu label={`More for ${r.patient.fullName}`} items={[
          { label: 'Open patient', onClick: () => nav(`/patients/${r.patient.id}`) },
          { label: 'Copy phone number', hidden: !r.patient.phone, onClick: () => navigator.clipboard?.writeText(r.patient.phone).then(() => toast('Number copied'), () => toast('Could not copy', 'err')) },
        ]} />
      </div>) },
  ];

  return (
    <div>
      <PageHeader title="Follow-ups" subtitle="Everyone who needs a call, and what happened the last time" />
      <DataTable
        id="followups" exportName={`follow-ups-${tab}-${today()}`} rows={rows} rowKey={(r) => r.key} columns={columns}
        loading={q.isLoading} empty={{ title: 'Nobody to call here', hint: TABS.find((t) => t[0] === tab)![2] }}
        tabs={TABS.map(([v, l]) => ({ value: v, label: l, count: counts[v] }))} tab={tab}
        onTab={(v) => setSp((p) => { const n = new URLSearchParams(p); v === 'reviews' ? n.delete('tab') : n.set('tab', v); return n; }, { replace: true })}
        search={{ placeholder: 'Find a follow-up: name, phone or patient no.', text: (r) => [r.patient.fullName, r.patient.phone, r.patient.patientNo] }}
        sort={{ key: 'due' }} filters={[DUE, LAST]} toggles={[{ key: 'waiting', label: 'Show waiting for call-back', hides: (r) => !!r.waiting }]}
        bulk={canWrite ? (list, clear) => <>
          <button type="button" className="dt-ghost" disabled={many.isPending} onClick={() => many.mutate({ list, send: true }, { onSuccess: clear })}><Icon name="message" className="h-3.5 w-3.5" />No answer, send a message</button>
          <button type="button" className="dt-ghost" disabled={many.isPending} onClick={() => many.mutate({ list, send: false }, { onSuccess: clear })}>No answer</button>
        </> : undefined}
      />
      {calling && <CallDialog row={calling} onClose={() => setCalling(null)} />}
    </div>
  );
}

function CallDialog({ row, onClose }: { row: any; onClose: () => void }) {
  const [outcome, setOutcome] = useState<'booked' | 'call_later' | 'no_answer' | 'not_interested'>('call_later');
  const [date, setDate] = useState(''); const [note, setNote] = useState(''); const [send, setSend] = useState(true);
  const go = useMutation({
    mutationFn: (confirmClosedDay?: boolean) => post('/followups/log', { kind: row.kind, refId: row.refId, patientId: row.patient.id, outcome, note: note.trim() || undefined, callbackOn: outcome === 'call_later' ? date : undefined, sendMessage: outcome === 'no_answer' ? send : undefined, confirmClosedDay }),
    onSuccess: (r: any) => { refresh(); toast(r.messaged ? 'Logged. A short message is on its way' : 'Logged'); onClose(); },
    onError: (e: any) => { if (e?.body?.code === 'CLOSED_DAY' && confirm(`${fmtDate(date)} is a Sunday and the clinic may be closed. Use this date anyway?`)) go.mutate(true); else toast(errText(e), 'err'); },
  });
  const bad = (outcome === 'call_later' && (!date || date < today())) || (outcome === 'not_interested' && note.trim().length < 3);
  return (
    <Modal title={row.patient.fullName} subtitle={`${row.what}${row.patient.phone ? ` · ${row.patient.phone}` : ''}`} onClose={onClose} width="max-w-md">
      <div className="space-y-3">
        <div className="flex flex-wrap gap-1.5">{(['booked', 'call_later', 'no_answer', 'not_interested'] as const).map((o) => <button key={o} type="button" className={`toggle-opt ${outcome === o ? 'on' : ''}`} onClick={() => setOutcome(o)}>{OUT[o]}</button>)}</div>
        {outcome === 'call_later' && <div><label className="label" htmlFor="cb">Call again on</label><input id="cb" type="date" min={today()} className="input" value={date} onChange={(e) => setDate(e.target.value)} /></div>}
        {outcome === 'no_answer' && row.patient.phone && <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-clay" checked={send} onChange={(e) => setSend(e.target.checked)} />Send a short message with the clinic number</label>}
        {outcome === 'booked' && <div className="text-sm text-muted">Book the visit or sitting as usual; this takes the patient off the list.</div>}
        <div><label className="label" htmlFor="nt">{outcome === 'not_interested' ? 'Why (required)' : 'Note (optional)'}</label><input id="nt" className="input" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} /></div>
        <div className="modal-foot"><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={bad || go.isPending} onClick={() => go.mutate(undefined)}><Icon name="check" />Save</button></div>
      </div>
    </Modal>
  );
}
