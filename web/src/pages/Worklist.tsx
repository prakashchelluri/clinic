import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { get, patch, qc, today } from '../api';

const OUTCOMES = ['Will come', 'Wants another date', 'No answer', 'Wrong number', 'Declined', 'Done elsewhere'];

/** Follow-up and procedure worklists: what used to be the procedure book and the follow-up book. */
export function Worklist() {
  const [kind, setKind] = useState<'followup' | 'procedure'>('procedure');
  const list = useQuery({ queryKey: ['worklist', kind], queryFn: () => get(`/worklist?kind=${kind}`), refetchInterval: 15000 });
  const nav = useNavigate();
  const upd = useMutation({ mutationFn: ({ id, ...b }: any) => patch(`/worklist/${id}`, b), onSuccess: () => qc.invalidateQueries({ queryKey: ['worklist'] }) });
  const t = today();
  const rows: any[] = list.data ?? [];
  const overdue = rows.filter((r) => r.dueOn && r.dueOn < t);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <h1 className="text-lg font-semibold">Worklists</h1>
        <div className="flex rounded-md border border-slate-300 overflow-hidden text-sm">
          {(['procedure', 'followup'] as const).map((k) => <button key={k} className={`px-3 py-1 ${kind === k ? 'bg-emerald-700 text-white' : 'bg-white'}`} onClick={() => setKind(k)}>{k === 'procedure' ? 'Procedures' : 'Follow-ups'}</button>)}
        </div>
        <span className="badge">{rows.length} open</span>{overdue.length > 0 && <span className="badge !bg-red-100 !text-red-700">{overdue.length} overdue</span>}
      </div>
      <div className="card !p-0 divide-y divide-slate-100">
        {rows.length === 0 && <div className="p-4 text-sm text-slate-400">Nothing pending</div>}
        {rows.map((r) => <Row key={r.id} r={r} today={t} onUpdate={(b) => upd.mutate({ id: r.id, ...b })} onOpen={() => nav(`/patients/${r.patient.id}`)} />)}
      </div>
    </div>
  );
}

function Row({ r, today, onUpdate, onOpen }: { r: any; today: string; onUpdate: (b: any) => void; onOpen: () => void }) {
  const [outcome, setOutcome] = useState(OUTCOMES[0]); const [note, setNote] = useState(''); const [due, setDue] = useState(r.dueOn ?? '');
  const late = r.dueOn && r.dueOn < today;
  return (
    <div className="p-3 text-sm grid md:grid-cols-[1fr_auto] gap-2">
      <div>
        <div className="flex items-center gap-2 flex-wrap">
          <button className="font-medium hover:underline" onClick={onOpen}>{r.patient.fullName}</button>
          <span className="text-slate-500">{r.patient.phone ?? 'no phone'} · {r.patient.patientNo}</span>
          <span className="badge">{r.status}</span>
          {r.procedure && <span className="badge !bg-violet-100 !text-violet-800">{r.procedure}{r.sittings ? ` · ${r.sittings} sittings` : ''}</span>}
          {r.dueOn && <span className={`badge ${late ? '!bg-red-100 !text-red-700' : ''}`}>due {r.dueOn}</span>}
        </div>
        {r.notes && <div className="text-slate-600 mt-0.5">{r.notes}</div>}
        {r.contactLog.length > 0 && <div className="text-xs text-slate-500 mt-1">{r.contactLog.slice(-3).map((c: any, i: number) => <div key={i}>{new Date(c.at).toLocaleDateString('en-IN')} {c.by}: {c.outcome}{c.note ? ` — ${c.note}` : ''}</div>)}</div>}
      </div>
      <div className="flex flex-wrap items-center gap-1 justify-end">
        <a className="btn btn-sm" href={`tel:${r.patient.phone ?? ''}`}>Call</a>
        <select className="input !w-auto !py-1 !text-xs" value={outcome} onChange={(e) => setOutcome(e.target.value)}>{OUTCOMES.map((o) => <option key={o}>{o}</option>)}</select>
        <input className="input !w-32 !py-1 !text-xs" placeholder="note" value={note} onChange={(e) => setNote(e.target.value)} />
        <button className="btn btn-sm" onClick={() => { onUpdate({ status: outcome === 'Done elsewhere' ? 'done' : outcome === 'Declined' ? 'cancelled' : 'contacted', contact: { outcome, note: note || undefined } }); setNote(''); }}>Log</button>
        <input type="date" className="input !w-auto !py-1 !text-xs" value={due} onChange={(e) => setDue(e.target.value)} onBlur={() => due !== (r.dueOn ?? '') && onUpdate({ dueOn: due || null })} />
        <button className="btn btn-sm btn-primary" onClick={() => onUpdate({ status: 'scheduled' })}>Scheduled</button>
        <button className="btn btn-sm" onClick={() => onUpdate({ status: 'done' })}>Done</button>
      </div>
    </div>
  );
}
