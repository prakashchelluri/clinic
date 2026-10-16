import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { get, patch, qc, today } from '../api';
import { Avatar, Chip, Empty, Icon, PageHeader, Section, Segmented, Skeleton, fmtDate, toast } from '../ui';

const OUTCOMES = ['Will come', 'Wants another date', 'No answer', 'Wrong number', 'Declined', 'Done elsewhere'];

/** Follow-up and procedure worklists: what used to be the procedure book and the follow-up book. */
export function Worklist() {
  const [kind, setKind] = useState<'followup' | 'procedure' | 'investigation'>('procedure');
  const proc = useQuery({ queryKey: ['worklist', 'procedure'], queryFn: () => get('/worklist?kind=procedure'), refetchInterval: 15000 });
  const fu = useQuery({ queryKey: ['worklist', 'followup'], queryFn: () => get('/worklist?kind=followup'), refetchInterval: 15000 });
  const inv = useQuery({ queryKey: ['worklist', 'investigation'], queryFn: () => get('/worklist?kind=investigation'), refetchInterval: 15000 });
  const nav = useNavigate();
  const upd = useMutation({ mutationFn: ({ id, ...b }: any) => patch(`/worklist/${id}`, b), onSuccess: () => { qc.invalidateQueries({ queryKey: ['worklist'] }); toast('Updated'); } });
  const t = today();
  const list = kind === 'procedure' ? proc : kind === 'followup' ? fu : inv;
  const rows: any[] = list.data ?? [];
  const overdue = rows.filter((r) => r.dueOn && r.dueOn < t);
  return (
    <div>
      <PageHeader title="Worklists" subtitle={overdue.length ? <span className="text-rose">{overdue.length} overdue</span> : 'Everything the doctor recommended, nothing re-typed'}>
        <Segmented value={kind} onChange={setKind} options={[{ value: 'procedure', label: 'Procedures', count: proc.data?.length }, { value: 'followup', label: 'Follow-ups', count: fu.data?.length }, { value: 'investigation', label: 'Tests', count: inv.data?.length }]} />
      </PageHeader>
      <Section>
        {list.isLoading ? <Skeleton rows={4} /> : rows.length === 0 ? <Empty icon="check" title="Nothing pending" hint="New recommendations appear here the moment the doctor completes an encounter." /> :
          rows.map((r, i) => <Row key={r.id} r={r} i={i} today={t} onUpdate={(b) => upd.mutate({ id: r.id, ...b })} onOpen={() => nav(`/patients/${r.patient.id}`, { viewTransition: true })} />)}
      </Section>
    </div>
  );
}

function Row({ r, i, today, onUpdate, onOpen }: { r: any; i: number; today: string; onUpdate: (b: any) => void; onOpen: () => void }) {
  const [outcome, setOutcome] = useState(OUTCOMES[0]); const [note, setNote] = useState(''); const [due, setDue] = useState(r.dueOn ?? ''); const [open, setOpen] = useState(false);
  const late = r.dueOn && r.dueOn < today;
  return (
    <div className="border-t border-line first:border-t-0 anim-fade-up" style={{ animationDelay: `${Math.min(i, 10) * 30}ms` }}>
      <div className="flex items-center gap-3 px-4 py-3 flex-wrap">
        <Avatar name={r.patient.fullName} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap"><button className="font-medium hover:text-clay transition-colors" onClick={onOpen}>{r.patient.fullName}</button><span className="text-xs text-muted">{r.patient.phone ?? 'no phone'} · {r.patient.patientNo}</span></div>
          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
            {r.procedure && <Chip tone="sky">{r.procedure}{r.sittings ? ` · ${r.sittings} sittings` : ''}</Chip>}{r.kind === 'investigation' && <Chip tone="clay">{r.notes}</Chip>}
            {r.dueOn && <Chip tone={late ? 'rose' : ''}>{late ? 'overdue · ' : 'due '}{fmtDate(r.dueOn)}</Chip>}
            <Chip tone={r.status === 'scheduled' ? 'sage' : r.status === 'contacted' ? 'amber' : ''}>{r.status}</Chip>
            {r.notes && r.kind !== 'investigation' && <span className="text-xs text-ink-2">{r.notes}</span>}
          </div>
          {r.contactLog.length > 0 && <div className="text-[11px] text-muted mt-1">{r.contactLog.slice(-2).map((c: any, k: number) => <span key={k} className="mr-3">{fmtDate(c.at)} · {c.by.split(' ')[0]}: {c.outcome}{c.note ? ` — ${c.note}` : ''}</span>)}</div>}
        </div>
        <div className="flex items-center gap-1">
          <a className="btn btn-sm" href={`tel:${r.patient.phone ?? ''}`}><Icon name="phone" className="h-3.5 w-3.5" />Call</a>
          <button className={`btn btn-sm ${open ? 'bg-paper' : ''}`} onClick={() => setOpen(!open)}>Log outcome</button>
          <button className="btn btn-sm btn-primary" onClick={() => onUpdate({ status: 'scheduled' })}>Scheduled</button>
          <button className="btn btn-ghost btn-icon" title="Mark done" onClick={() => onUpdate({ status: 'done' })}><Icon name="check" /></button>
        </div>
      </div>
      {open && (
        <div className="px-4 pb-3 pl-[64px] flex flex-wrap items-center gap-2 anim-fade-up">
          <div className="flex flex-wrap gap-1">{OUTCOMES.map((o) => <button key={o} className={`toggle-opt ${outcome === o ? 'on' : ''}`} onClick={() => setOutcome(o)}>{o}</button>)}</div>
          <input className="input !w-44 !py-1.5" placeholder="note" value={note} onChange={(e) => setNote(e.target.value)} />
          <input type="date" className="input !w-auto !py-1.5" value={due} onChange={(e) => setDue(e.target.value)} />
          <button className="btn btn-sm btn-primary" onClick={() => { onUpdate({ status: outcome === 'Done elsewhere' ? 'done' : outcome === 'Declined' ? 'cancelled' : 'contacted', contact: { outcome, note: note || undefined }, ...(due !== (r.dueOn ?? '') ? { dueOn: due || null } : {}) }); setNote(''); setOpen(false); }}>Save</button>
        </div>
      )}
    </div>
  );
}
