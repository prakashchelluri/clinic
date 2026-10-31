import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useOutletContext } from 'react-router';
import { get, post, qc, today, errText, dialable } from '../api';
import { can } from '../App';
import { Chip, Empty, Icon, Modal, PageHeader, Section, Segmented, Skeleton, fmtDate, toast } from '../ui';
import { FlagChips } from '../flags';

type Tab = 'reviews' | 'missed' | 'schedule' | 'advised';
const TABS: [Tab, string, string][] = [['reviews', 'Reviews due', 'Patients the doctor asked to see again'], ['missed', 'Missed visits', 'Booked and did not come, visits and sittings'], ['schedule', 'Procedures to schedule', 'Price agreed, no sitting booked yet'], ['advised', 'Advised, not agreed', 'The doctor advised; the patient has not said yes']];
const OUT: Record<string, string> = { booked: 'Booked', call_later: 'Call later', no_answer: 'No answer', not_interested: 'Not interested' };
const refresh = () => ['followups', 'worklist', 'bookings'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));

/** Who to call today, in four lists. Each call is one tap with an outcome; a call back date puts the row to the bottom until that day. */
export function Followups() {
  const { perms } = useOutletContext<any>(); const nav = useNavigate();
  const [tab, setTab] = useState<Tab>('reviews'); const [calling, setCalling] = useState<any>(null);
  const q = useQuery({ queryKey: ['followups', tab], queryFn: () => get(`/followups?tab=${tab}`), refetchInterval: 30000 });
  const rows: any[] = q.data?.rows ?? []; const counts = q.data?.counts ?? {};
  const canWrite = can(perms, 'worklist.write');
  return (
    <div>
      <PageHeader title="Follow-ups" subtitle="Everyone who needs a call, and what happened the last time" />
      <div className="mb-4"><Segmented<Tab> value={tab} onChange={setTab} options={TABS.map(([v, l]) => ({ value: v, label: l, count: counts[v] || undefined }))} /></div>
      <Section>
        {q.isLoading ? <Skeleton rows={4} /> : rows.length === 0 ? <Empty icon="check" title="Nobody to call here" hint={TABS.find((t) => t[0] === tab)![2]} /> :
          rows.map((r) => (
            <div key={r.key} className={`row flex-wrap ${r.waiting ? 'opacity-60' : ''}`}>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5 text-sm"><button className="font-medium hover:underline" onClick={() => nav(`/patients/${r.patient.id}`)}>{r.patient.fullName}</button><FlagChips flags={r.patient.flags} /><span className="text-xs text-muted">{r.patient.patientNo}{r.patient.ageYears ? ` · ${r.patient.ageYears}y` : ''}</span></div>
                <div className="text-sm text-ink-2">{r.what}{r.dueOn ? <span className="text-muted"> · {r.kind === 'review' ? 'due' : ''} {fmtDate(r.dueOn)}</span> : ''}</div>
                {r.lastCall && <div className="text-xs text-muted">{r.lastCall.attempts} call{r.lastCall.attempts === 1 ? '' : 's'} · last: {OUT[r.lastCall.outcome]}{r.lastCall.note ? ` (${r.lastCall.note})` : ''} by {r.lastCall.by}, {fmtDate(r.lastCall.at)}</div>}
              </div>
              {r.lastCall?.callbackOn && <Chip tone={r.waiting ? '' : 'amber'}>call on {fmtDate(r.lastCall.callbackOn)}</Chip>}
              {r.patient.phone && dialable(r.patient.phone) && <a className="btn btn-sm" href={`tel:${r.patient.phone}`}><Icon name="phone" className="h-3.5 w-3.5" />Call</a>}
              {canWrite && <button className="btn btn-sm btn-primary" onClick={() => setCalling(r)}>Log the call</button>}
            </div>))}
      </Section>
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
    <Modal title={row.patient.fullName} subtitle={row.what} onClose={onClose} width="max-w-md">
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
