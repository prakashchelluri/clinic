import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useNavigate, useOutletContext } from 'react-router';
import { get, patch, post, qc, today, errText } from '../api';
import { can } from '../App';
import { PhotoCapture } from '../photos';
import { Avatar, Chip, Empty, Icon, Modal, MoreMenu, PageHeader, Section, Segmented, Skeleton, fmtDate, toast } from '../ui';

const OUTCOMES = ['Will come', 'Wants another date', 'No answer', 'Wrong number', 'Declined', 'Done elsewhere'];
type Kind = 'procedure' | 'followup' | 'investigation';

/** Follow-up, procedure and test worklists: what used to be the procedure book and the follow-up book. */
export function Worklist() {
  const { perms } = useOutletContext<any>();
  const [kind, setKind] = useState<Kind>('procedure');
  const proc = useQuery({ queryKey: ['worklist', 'procedure'], queryFn: () => get('/worklist?kind=procedure'), refetchInterval: 15000 });
  const fu = useQuery({ queryKey: ['worklist', 'followup'], queryFn: () => get('/worklist?kind=followup'), refetchInterval: 15000 });
  const inv = useQuery({ queryKey: ['worklist', 'investigation'], queryFn: () => get('/worklist?kind=investigation'), refetchInterval: 15000 });
  const sessions = useQuery({ queryKey: ['psessions-upcoming'], queryFn: () => get(`/procedure-sessions?day=${today()}`), refetchInterval: 30000 });
  const nav = useNavigate();
  const upd = useMutation({ mutationFn: ({ id, ...b }: any) => patch(`/worklist/${id}`, b), onSuccess: () => { qc.invalidateQueries({ queryKey: ['worklist'] }); toast('Updated'); } });
  const [scheduling, setScheduling] = useState<any>(null);
  const [cap, setCap] = useState<any>(null);
  const t = today();
  const list = kind === 'procedure' ? proc : kind === 'followup' ? fu : inv;
  const rows: any[] = list.data ?? [];
  const overdue = rows.filter((r) => r.dueOn && r.dueOn < t && r.status !== 'scheduled');
  return (
    <div>
      <PageHeader title="Procedures" subtitle={overdue.length ? <span className="text-rose">{overdue.length} overdue</span> : 'Everything the doctor recommended, nothing re-typed'}>
        <Segmented value={kind} onChange={setKind} options={[{ value: 'procedure', label: 'Procedures', count: proc.data?.length }, { value: 'followup', label: 'Follow-ups', count: fu.data?.length }, { value: 'investigation', label: 'Tests', count: inv.data?.length }]} />
      </PageHeader>
      {kind === 'procedure' && (sessions.data ?? []).length > 0 && (
        <div className="card anim-fade-up mb-4 flex items-center gap-3 flex-wrap text-sm"><Icon name="stetho" className="h-4 w-4 text-sky" /><span className="font-medium">Today in the rooms:</span>
          {(sessions.data ?? []).map((s: any) => <span key={s.id} className="inline-flex items-center gap-1"><Chip tone="sky">{s.startTime} {s.patient.fullName} · {s.room ?? 'no room'}</Chip>{can(perms, 'document.write') && !['cancelled', 'postponed'].includes(s.state) && <button className="btn btn-ghost btn-icon !h-8 !w-8" aria-label={`Take photos for ${s.patient.fullName}`} data-tip="Photos" onClick={() => setCap(s)}><Icon name="spark" className="h-3.5 w-3.5" /></button>}</span>)}
          <a className="btn btn-sm ml-auto" href="/calendar">Open calendar<Icon name="chevR" className="h-3.5 w-3.5" /></a></div>
      )}
      <Section>
        {list.isLoading ? <Skeleton rows={4} /> : rows.length === 0 ? <Empty icon="check" title="Nothing pending" hint="New recommendations appear here the moment the doctor completes an encounter." /> :
          rows.map((r, i) => <Row key={r.id} r={r} i={i} today={t} canWrite={can(perms, 'worklist.write')} onUpdate={(b) => upd.mutate({ id: r.id, ...b })} onOpen={() => nav(`/patients/${r.patient.id}`, { viewTransition: true })} onSchedule={() => setScheduling(r)} />)}
      </Section>
      {cap && <PhotoCapture patient={{ id: cap.patient.id, fullName: cap.patient.fullName }} sitting={{ id: cap.id, label: `${cap.procedure ?? 'Procedure'} · sitting ${cap.sittingNo}` }} onClose={() => setCap(null)} />}
      {scheduling && <ScheduleModal rec={scheduling} onClose={() => { setScheduling(null); qc.invalidateQueries({ queryKey: ['worklist'] }); qc.invalidateQueries({ queryKey: ['psessions-upcoming'] }); qc.invalidateQueries({ queryKey: ['calendar'] }); }} />}
    </div>
  );
}

function Row({ r, i, today, canWrite, onUpdate, onOpen, onSchedule }: { r: any; i: number; today: string; canWrite: boolean; onUpdate: (b: any) => void; onOpen: () => void; onSchedule: () => void }) {
  const [outcome, setOutcome] = useState(OUTCOMES[0]); const [note, setNote] = useState(''); const [due, setDue] = useState(r.dueOn ?? ''); const [open, setOpen] = useState(false);
  const [result, setResult] = useState('');
  const late = r.dueOn && r.dueOn < today && r.status !== 'scheduled';
  const isTest = r.kind === 'investigation';
  return (
    <div className="border-t border-line first:border-t-0 anim-fade-up" style={{ animationDelay: `${Math.min(i, 10) * 30}ms` }}>
      <div className="flex items-center gap-3 px-4 py-3 flex-wrap">
        <Avatar name={r.patient.fullName} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap"><button className="font-medium hover:text-clay transition-colors py-2 -my-2" onClick={onOpen}>{r.patient.fullName}</button><span className="text-xs text-muted">{r.patient.phone ?? 'no phone'} · {r.patient.patientNo}</span></div>
          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
            {r.procedure && <Chip tone="sky">{r.procedure}{r.sittings ? ` · ${r.sittings} ${r.sittings === 1 ? 'sitting' : 'sittings'}` : ''}</Chip>}
            {isTest && <Chip tone="clay">{r.notes}</Chip>}
            {r.dueOn && <Chip tone={late ? 'rose' : ''}>{late ? 'overdue · ' : r.status === 'scheduled' ? 'on ' : 'due '}{fmtDate(r.dueOn)}</Chip>}
            <Chip tone={r.status === 'scheduled' ? 'sage' : r.status === 'contacted' ? 'amber' : ''}>{r.status}</Chip>
            {r.notes && !isTest && <span className="text-xs text-ink-2">{r.notes}</span>}
          </div>
          {r.contactLog.length > 0 && <div className="text-[11px] text-muted mt-1">{r.contactLog.slice(-2).map((c: any, k: number) => <span key={k} className="mr-3">{fmtDate(c.at)} · {c.by.split(' ')[0]}: {c.outcome}{c.note ? ` — ${c.note}` : ''}</span>)}</div>}
        </div>
        {canWrite && (
          <div className="flex items-center gap-1.5">
            {isTest ? <button className="btn btn-sm btn-primary" onClick={() => setOpen(!open)}><Icon name="check" className="h-3.5 w-3.5" />Result received</button>
              : r.kind === 'procedure' ? <button className="btn btn-sm btn-primary" onClick={onSchedule}><Icon name="calendar" className="h-3.5 w-3.5" />Schedule</button>
              : <button className="btn btn-sm btn-primary" onClick={() => onUpdate({ status: 'scheduled' })}>Booked</button>}
            <MoreMenu items={[{ label: 'Call patient', href: `tel:${r.patient.phone ?? ''}` }, { label: 'Log a call', hidden: isTest, onClick: () => setOpen(!open) }, { label: 'Mark done', hidden: isTest, onClick: () => onUpdate({ status: 'done' }) }]} />
          </div>
        )}
      </div>
      {open && isTest && (
        <div className="px-4 pb-3 pl-[64px] flex flex-wrap items-center gap-2 anim-fade-up">
          <input autoFocus className="input flex-1 min-w-60" placeholder="Result in brief, e.g. Hb 11.2, TSH normal (or 'report attached on patient page')" value={result} onChange={(e) => setResult(e.target.value)} />
          <button className="btn btn-sm btn-primary" disabled={!result} onClick={() => { onUpdate({ status: 'done', contact: { outcome: 'Result received', note: result } }); setOpen(false); }}>Save result</button>
          <button className="btn btn-sm btn-ghost" onClick={onOpen}>Upload report on patient page</button>
        </div>
      )}
      {open && !isTest && (
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

/** Pick a day; the server lists rooms with the right capability and the free slots; conflicts are explained, override is explicit. */
function ScheduleModal({ rec, onClose }: { rec: any; onClose: () => void }) {
  const { cfg } = useOutletContext<any>();
  const proc = cfg.procedures.find((p: any) => p.id === rec.procedureId);
  const [day, setDay] = useState(rec.dueOn && rec.dueOn >= today() ? rec.dueOn : today());
  const [minutes, setMinutes] = useState<number>(proc?.typicalMinutes ?? 30);
  const [doc, setDoc] = useState<string>(proc?.requiresMainDoctor ? cfg.practitioners[0]?.id ?? '' : '');
  const [pick, setPick] = useState<{ roomId: string; startTime: string } | null>(null);
  const [manual, setManual] = useState({ startTime: '', roomId: '' });
  const [conf, setConf] = useState<any[] | null>(null);
  const slots = useQuery({ queryKey: ['slots', rec.procedureId, day, doc, minutes], queryFn: () => get(`/procedure-sessions/slots?day=${day}&procedureId=${rec.procedureId}&minutes=${minutes}${doc ? `&practitionerId=${doc}` : ''}`), enabled: !!rec.procedureId });
  const save = useMutation({
    mutationFn: (force: boolean) => post('/procedure-sessions', { recommendationId: rec.id, day, startTime: pick?.startTime ?? manual.startTime, minutes, roomId: pick?.roomId ?? manual.roomId ?? null, practitionerId: doc || null, force }),
    onSuccess: (r: any) => { toast(`Scheduled ${day} ${r.startTime}`); onClose(); },
    onError: (e: any) => { if (e?.body?.code === 'CONFLICT') setConf(e.body.conflicts); else toast(errText(e), 'err'); },
  });
  const byRoom: Record<string, any[]> = {};
  for (const s of slots.data?.slots ?? []) (byRoom[s.room] ??= []).push(s);
  const existing = useQuery({ queryKey: ['psessions', rec.id], queryFn: () => get(`/procedure-sessions?recommendationId=${rec.id}`) });
  return (
    <Modal title={`Schedule · ${proc?.name ?? 'procedure'}`} subtitle={`${rec.patient.fullName} · ${rec.patient.phone ?? ''}${rec.sittings ? ` · ${rec.sittings} ${rec.sittings === 1 ? 'sitting' : 'sittings'} planned` : ''}${slots.data?.requiredCapability ? ` · needs a room with “${slots.data.requiredCapability}”` : ''}`} onClose={onClose} width="max-w-3xl">
      <div className="space-y-4">
        {(existing.data ?? []).length > 0 && <div className="text-xs text-muted flex flex-wrap gap-1.5 items-center">Previous sittings: {existing.data.map((s: any) => <Chip key={s.id} tone={s.state === 'completed' ? 'sage' : s.state === 'confirmed' ? 'sky' : ''}>{fmtDate(s.day)} · {s.state}</Chip>)}</div>}
        <div className="grid grid-cols-3 gap-3">
          <div><label className="label">Day</label><input type="date" className="input" value={day} onChange={(e) => { setDay(e.target.value); setPick(null); }} /></div>
          <div><label className="label">Duration (min)</label><div className="flex gap-1 flex-wrap">{[15, 30, 45, 60, 90, 120].map((m) => <button key={m} className={`toggle-opt ${minutes === m ? 'on' : ''}`} onClick={() => { setMinutes(m); setPick(null); }}>{m}</button>)}</div></div>
          <div><label className="label">Doctor {proc?.requiresMainDoctor && <span className="text-clay">required</span>}</label><select className="input" value={doc} onChange={(e) => { setDoc(e.target.value); setPick(null); }}><option value="">Other staff / none</option>{cfg.practitioners.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
            {doc && <div className="text-[11px] text-amber mt-1">Blocks this doctor's OP capacity for the slot.</div>}</div>
        </div>
        <div>
          <label className="label">Free slots by room</label>
          {slots.isLoading ? <Skeleton rows={2} /> : Object.keys(byRoom).length === 0 ? <div className="text-sm text-muted">No free slot in a suitable room on this day. Try another day or duration, or set a time manually below.</div> : (
            <div className="space-y-2">{Object.entries(byRoom).map(([room, list]) => (
              <div key={room} className="flex items-start gap-3"><div className="w-40 shrink-0 text-sm font-medium pt-1.5">{room}</div>
                <div className="flex flex-wrap gap-1">{list.map((s: any) => <button key={s.roomId + s.startTime} className={`toggle-opt ${pick?.roomId === s.roomId && pick?.startTime === s.startTime ? 'on' : ''}`} onClick={() => { setPick({ roomId: s.roomId, startTime: s.startTime }); setConf(null); }}>{s.startTime}</button>)}</div></div>))}</div>
          )}
        </div>
        <details className="text-sm"><summary className="cursor-pointer text-muted">Set time and room manually</summary>
          <div className="flex gap-2 mt-2 items-center"><input type="time" className="input !w-auto" value={manual.startTime} onChange={(e) => { setManual({ ...manual, startTime: e.target.value }); setPick(null); }} /><select className="input !w-auto" value={manual.roomId} onChange={(e) => setManual({ ...manual, roomId: e.target.value })}><option value="">No room</option>{cfg.rooms.map((r: any) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></div></details>
        {conf && <div className="rounded-xl bg-amber-soft text-amber text-sm p-3 anim-fade-up"><div className="font-medium mb-1">This slot clashes:</div>{conf.map((c, i) => <div key={i}>• {c.kind}: {c.who} ({c.startTime}–{c.endTime})</div>)}<button className="btn btn-sm mt-2" onClick={() => save.mutate(true)}>Schedule anyway</button></div>}
        <div className="modal-foot"><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={save.isPending || (!pick && !manual.startTime)} onClick={() => save.mutate(false)}><Icon name="check" />Confirm {pick?.startTime ?? manual.startTime}</button></div>
      </div>
    </Modal>
  );
}
