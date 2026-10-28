import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useNavigate, useOutletContext, useSearchParams } from 'react-router';
import { get, patch, post, qc, today, errText } from '../api';
import { can } from '../App';
import { PhotoCapture } from '../photos';
import { ProcSchedule } from './ProcSchedule';
import { openViewer } from '../viewer';
import { Avatar, Chip, Empty, Icon, Modal, MoreMenu, PageHeader, Section, Segmented, Skeleton, fmtDate, toast, ask } from '../ui';

const OUTCOMES = ['Will come', 'Wants another date', 'No answer', 'Wrong number', 'Declined', 'Done elsewhere'];
type Kind = 'procedure' | 'followup' | 'investigation';

/** Follow-up, procedure and test worklists: what used to be the procedure book and the follow-up book. */
export function Worklist() {
  const { perms } = useOutletContext<any>();
  const [kind, setKind] = useState<Kind>('procedure');
  const [sp, setSp] = useSearchParams();
  const view: 'schedule' | 'plans' = sp.get('tab') === 'plans' ? 'plans' : 'schedule'; // the schedule by date is the first thing you see
  const setView = (v: 'schedule' | 'plans') => setSp((p) => { p.set('tab', v); return p; }, { replace: true });
  const proc = useQuery({ queryKey: ['worklist', 'procedure'], queryFn: () => get('/worklist?kind=procedure'), refetchInterval: 15000 });
  const fu = useQuery({ queryKey: ['worklist', 'followup'], queryFn: () => get('/worklist?kind=followup'), refetchInterval: 15000 });
  const inv = useQuery({ queryKey: ['worklist', 'investigation'], queryFn: () => get('/worklist?kind=investigation'), refetchInterval: 15000 });
  const sessions = useQuery({ queryKey: ['psessions-upcoming'], queryFn: () => get(`/procedure-sessions?day=${today()}`), refetchInterval: 30000 });
  const nav = useNavigate();
  const upd = useMutation({ mutationFn: ({ id, ...b }: any) => patch(`/worklist/${id}`, b), onSuccess: () => { qc.invalidateQueries({ queryKey: ['worklist'] }); toast('Updated'); } });
  const [scheduling, setScheduling] = useState<any>(null);
  const [rescheduling, setRescheduling] = useState<any>(null);
  const [resulting, setResulting] = useState<any>(null);
  const results = useQuery({ queryKey: ['results'], queryFn: () => get('/results?days=7'), enabled: kind === 'investigation' });
  const [cap, setCap] = useState<any>(null);
  const t = today();
  // plans the doctor made today that nobody has acted on yet
  const isNew = (r: any) => r.status === 'open' && new Date(r.createdAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) === t;
  const newPlans = [...(proc.data ?? []), ...(fu.data ?? []), ...(inv.data ?? [])].filter(isNew).length;
  const list = kind === 'procedure' ? proc : kind === 'followup' ? fu : inv;
  const rows: any[] = list.data ?? [];
  const overdue = rows.filter((r) => r.dueOn && r.dueOn < t && r.status !== 'scheduled');
  return (
    <div>
      <PageHeader title="Procedures" subtitle={view === 'schedule' ? 'What is planned, any date' : overdue.length ? <span className="text-rose">{overdue.length} overdue</span> : 'Everything the doctor recommended, nothing re-typed'}>
        <Segmented<'schedule' | 'plans'> value={view} onChange={setView} options={[{ value: 'schedule', label: 'Schedule' }, { value: 'plans', label: newPlans ? `Plans to schedule · ${newPlans} new` : 'Plans to schedule', count: (proc.data ?? []).filter((r: any) => !r.next && r.status !== 'scheduled').length || undefined }]} />
        {view === 'plans' && <Segmented value={kind} onChange={setKind} options={[{ value: 'procedure', label: 'Procedures', count: proc.data?.length }, { value: 'followup', label: 'Follow-ups', count: fu.data?.length }, { value: 'investigation', label: 'Tests', count: inv.data?.length }]} />}
      </PageHeader>
      {view === 'schedule' ? <ProcSchedule onPlans={() => setView('plans')} /> : (<>
      {kind === 'procedure' && (sessions.data ?? []).length > 0 && (
        <div className="card anim-fade-up mb-4 flex items-center gap-3 flex-wrap text-sm"><Icon name="stetho" className="h-4 w-4 text-sky" /><span className="font-medium">Today in the rooms:</span>
          {(sessions.data ?? []).map((s: any) => <span key={s.id} className="inline-flex items-center gap-1"><Chip tone="sky">{s.startTime} {s.patient.fullName} · {s.room ?? 'no room'}</Chip>{can(perms, 'document.write') && !['cancelled', 'postponed'].includes(s.state) && <button className="btn btn-ghost btn-icon !h-8 !w-8" aria-label={`Take photos for ${s.patient.fullName}`} data-tip="Photos" onClick={() => setCap(s)}><Icon name="spark" className="h-3.5 w-3.5" /></button>}</span>)}
          <a className="btn btn-sm ml-auto" href="/calendar">Open calendar<Icon name="chevR" className="h-3.5 w-3.5" /></a></div>
      )}
      <Section>
        {list.isLoading ? <Skeleton rows={4} /> : rows.length === 0 ? <Empty icon="check" title="Nothing pending" hint="New recommendations appear here the moment the doctor completes an encounter." /> :
          rows.map((r, i) => <Row key={r.id} r={r} i={i} today={t} canWrite={can(perms, 'worklist.write')} onUpdate={(b) => upd.mutate({ id: r.id, ...b })} onOpen={() => nav(`/patients/${r.patient.id}`, { viewTransition: true })} onBook={() => nav(`?book=1&patient=${r.patient.id}&pname=${encodeURIComponent(r.patient.fullName)}&rec=${r.id}`)} onResult={() => setResulting(r)} onSchedule={() => setScheduling(r)} onReschedule={() => setRescheduling(r)} onCancelSitting={async () => { const a = await ask({ title: 'Cancel the booked sitting?', body: `${r.patient.fullName} · ${r.procedure ?? 'procedure'} on ${fmtDate(r.next.day)} ${r.next.startTime}. The room and doctor are freed and the plan goes back to open.`, confirmLabel: 'Cancel sitting', cancelLabel: 'Keep it', field: { label: 'Reason', maxLength: 200 } }); if (a) { try { await patch(`/procedure-sessions/${r.next.id}`, { state: 'cancelled', reason: a.value || undefined }); qc.invalidateQueries({ queryKey: ['worklist'] }); qc.invalidateQueries({ queryKey: ['calendar'] }); toast('Sitting cancelled', 'info'); } catch (e: any) { toast(errText(e), 'err'); } } }} />)}
      </Section>
      {kind === 'investigation' && (results.data ?? []).length > 0 && (
        <Section title={<>Recent results <span className="font-normal text-muted">· last 7 days</span></>} className="mt-4">
          {(results.data ?? []).map((x: any) => (
            <div key={x.id} className="flex flex-wrap items-center gap-2 border-t border-line/70 px-5 py-3 first:border-t-0 text-sm">
              <button className="font-medium hover:underline" onClick={() => nav(`/patients/${x.patient.id}`)}>{x.patient.fullName}</button><Chip tone="clay">{x.test}</Chip>
              <span className="text-xs text-muted">{fmtDate(x.at)}{x.documents[0]?.note ? ` · ${x.documents[0].note}` : ''}</span>
              <span className="ml-auto flex flex-wrap gap-1.5">{x.documents.map((d: any, j: number) => <button key={d.id} className="btn btn-sm" onClick={() => openViewer({ docs: x.documents, index: j, who: x.patient.fullName, canDelete: can(perms, 'document.write') })}><Icon name="spark" className="h-3.5 w-3.5" />{d.mime === 'application/pdf' ? 'PDF' : 'Photo'} {x.documents.length > 1 ? j + 1 : ''}</button>)}</span>
            </div>))}
        </Section>)}
      {resulting && <ResultDialog rec={resulting} tests={(inv.data ?? []).filter((x: any) => x.patient.id === resulting.patient.id)} onClose={() => setResulting(null)} />}
      {cap && <PhotoCapture patient={{ id: cap.patient.id, fullName: cap.patient.fullName }} sitting={{ id: cap.id, label: `${cap.procedure ?? 'Procedure'} · sitting ${cap.sittingNo}` }} onClose={() => setCap(null)} />}
      {rescheduling && <ScheduleModal rec={rescheduling} sitting={rescheduling.next} onClose={() => { setRescheduling(null); qc.invalidateQueries({ queryKey: ['worklist'] }); qc.invalidateQueries({ queryKey: ['calendar'] }); }} />}
      {scheduling && <ScheduleModal rec={scheduling} onClose={() => { setScheduling(null); qc.invalidateQueries({ queryKey: ['worklist'] }); qc.invalidateQueries({ queryKey: ['psessions-upcoming'] }); qc.invalidateQueries({ queryKey: ['calendar'] }); }} />}
      </>)}
    </div>
  );
}

function Row({ r, i, today, canWrite, onUpdate, onOpen, onSchedule, onReschedule, onCancelSitting, onBook, onResult }: { r: any; i: number; today: string; canWrite: boolean; onUpdate: (b: any) => void; onOpen: () => void; onSchedule: () => void; onReschedule: () => void; onCancelSitting: () => void; onBook: () => void; onResult: () => void }) {
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
            {r.next && <Chip tone="sage"><Icon name="calendar" className="h-3 w-3 inline -mt-0.5 mr-1" />Next: {fmtDate(r.next.day)} {r.next.startTime}{r.next.room ? ` · ${r.next.room}` : ''}</Chip>}
            {r.notes && !isTest && <span className="text-xs text-ink-2">{r.notes}</span>}
          </div>
          {r.contactLog.length > 0 && <div className="text-[11px] text-muted mt-1">{r.contactLog.slice(-2).map((c: any, k: number) => <span key={k} className="mr-3">{fmtDate(c.at)} · {c.by.split(' ')[0]}: {c.outcome}{c.note ? ` — ${c.note}` : ''}</span>)}</div>}
        </div>
        {canWrite && (
          <div className="flex items-center gap-1.5">
            {isTest ? <button className="btn btn-sm btn-primary" onClick={onResult}><Icon name="check" className="h-3.5 w-3.5" />Result received</button>
              : r.kind === 'procedure' ? (r.next ? <button className="btn btn-sm btn-primary" onClick={onReschedule}><Icon name="calendar" className="h-3.5 w-3.5" />Reschedule</button> : <button className="btn btn-sm btn-primary" onClick={onSchedule}><Icon name="calendar" className="h-3.5 w-3.5" />{r.status === 'scheduled' ? 'Schedule next' : 'Schedule'}</button>)
              : r.status === 'scheduled' ? <Chip tone="sage">booked</Chip> : <button className="btn btn-sm btn-primary" onClick={onBook}><Icon name="calendar" className="h-3.5 w-3.5" />Book visit</button>}
            <MoreMenu items={[{ label: 'Call patient', href: `tel:${r.patient.phone ?? ''}` }, { label: 'Schedule another sitting', hidden: !(r.kind === 'procedure' && r.next), onClick: onSchedule }, { label: 'Cancel the booked sitting', danger: true, hidden: !(r.kind === 'procedure' && r.next), onClick: onCancelSitting }, { label: 'Log a call', hidden: isTest, onClick: () => setOpen(!open) }, { label: 'Mark as booked (already done elsewhere)', hidden: isTest || r.kind === 'procedure' || r.status === 'scheduled', onClick: () => onUpdate({ status: 'scheduled' }) }, { label: 'Mark done', hidden: isTest, onClick: () => onUpdate({ status: 'done' }) }]} />
          </div>
        )}
      </div>
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
export function ScheduleModal({ rec, sitting, onClose }: { rec: any; sitting?: any; onClose: () => void }) {
  const { cfg } = useOutletContext<any>();
  const proc = cfg.procedures.find((p: any) => p.id === rec.procedureId);
  const [day, setDay] = useState(sitting ? (sitting.day >= today() ? sitting.day : today()) : rec.dueOn && rec.dueOn >= today() ? rec.dueOn : today());
  const [reason, setReason] = useState('');
  const toM = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const [minutes, setMinutes] = useState<number>(sitting ? Math.max(5, toM(sitting.endTime) - toM(sitting.startTime) - (proc?.bufferMinutes ?? 0)) : proc?.typicalMinutes ?? 30);
  const [doc, setDoc] = useState<string>(sitting ? sitting.practitionerId ?? '' : proc?.requiresMainDoctor ? cfg.practitioners[0]?.id ?? '' : '');
  const [pick, setPick] = useState<{ roomId: string; startTime: string } | null>(null);
  const [manual, setManual] = useState({ startTime: '', roomId: '' });
  const [conf, setConf] = useState<any[] | null>(null);
  const slots = useQuery({ queryKey: ['slots', rec.procedureId, day, doc, minutes], queryFn: () => get(`/procedure-sessions/slots?day=${day}&procedureId=${rec.procedureId}&minutes=${minutes}${doc ? `&practitionerId=${doc}` : ''}`), enabled: !!rec.procedureId });
  const save = useMutation({
    mutationFn: (force: boolean) => post(sitting ? `/procedure-sessions/${sitting.id}/reschedule` : '/procedure-sessions', { ...(sitting ? { reason: reason.trim() || undefined } : { recommendationId: rec.id }), day, startTime: pick?.startTime ?? manual.startTime, minutes, roomId: pick?.roomId ?? manual.roomId ?? null, practitionerId: doc || null, force }),
    onSuccess: (r: any) => { toast(`${sitting ? 'Moved to' : 'Scheduled'} ${day} ${r.startTime}`); onClose(); },
    onError: (e: any) => { if (e?.body?.code === 'CONFLICT') setConf(e.body.conflicts); else toast(errText(e), 'err'); },
  });
  const byRoom: Record<string, any[]> = {};
  for (const s of slots.data?.slots ?? []) (byRoom[s.room] ??= []).push(s);
  const existing = useQuery({ queryKey: ['psessions', rec.id], queryFn: () => get(`/procedure-sessions?recommendationId=${rec.id}`) });
  return (
    <Modal title={`${sitting ? 'Reschedule' : 'Schedule'} · ${proc?.name ?? 'procedure'}`} subtitle={`${rec.patient.fullName} · ${rec.patient.phone ?? ''}${rec.sittings ? ` · ${rec.sittings} ${rec.sittings === 1 ? 'sitting' : 'sittings'} planned` : ''}${slots.data?.requiredCapability ? ` · needs a room with “${slots.data.requiredCapability}”` : ''}`} onClose={onClose} width="max-w-3xl">
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
        {sitting && <div><label className="label" htmlFor="rs-why">Reason (optional)</label><input id="rs-why" className="input" maxLength={200} placeholder="e.g. patient asked for another day" value={reason} onChange={(e) => setReason(e.target.value)} /></div>}
        <details className="text-sm"><summary className="cursor-pointer text-muted">Set time and room manually</summary>
          <div className="flex gap-2 mt-2 items-center"><input type="time" className="input !w-auto" value={manual.startTime} onChange={(e) => { setManual({ ...manual, startTime: e.target.value }); setPick(null); }} /><select className="input !w-auto" value={manual.roomId} onChange={(e) => setManual({ ...manual, roomId: e.target.value })}><option value="">No room</option>{cfg.rooms.map((r: any) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></div></details>
        {conf && <div className="rounded-xl bg-amber-soft text-amber text-sm p-3 anim-fade-up"><div className="font-medium mb-1">This slot clashes:</div>{conf.map((c, i) => <div key={i}>• {c.kind}: {c.who} ({c.startTime}–{c.endTime})</div>)}<button className="btn btn-sm mt-2" onClick={() => save.mutate(true)}>Schedule anyway</button></div>}
        <div className="modal-foot"><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={save.isPending || (!pick && !manual.startTime)} onClick={() => save.mutate(false)}><Icon name="check" />Confirm {pick?.startTime ?? manual.startTime}</button></div>
      </div>
    </Modal>
  );
}

const RESULT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const kb = (n: number) => n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

/** A test result: one or several files (PDF or photo), the tests it answers, an optional note. Saving closes those tests and tells the doctor. */
function ResultDialog({ rec, tests, onClose }: { rec: any; tests: any[]; onClose: () => void }) {
  const [files, setFiles] = useState<File[]>([]); const [picked, setPicked] = useState<string[]>([rec.id]); const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false); const [over, setOver] = useState(false); const [tried, setTried] = useState(false);
  const add = (list: FileList | File[] | null) => {
    const next = [...files];
    for (const f of Array.from(list ?? [])) {
      if (!RESULT_TYPES.includes(f.type)) { toast(`${f.name}: only JPG, PNG, WebP and PDF files can be added`, 'err'); continue; }
      if (f.size > 10 * 1024 * 1024) { toast(`${f.name} is over 10 MB`, 'err'); continue; }
      if (!next.some((x) => x.name === f.name && x.size === f.size)) next.push(f);
    }
    setFiles(next);
  };
  const bad = picked.length === 0 || (files.length === 0 && !note.trim());
  const save = async () => {
    setTried(true); if (bad) return; setBusy(true);
    try {
      if (files.length) {
        for (const f of files) {
          const dataBase64 = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(f); });
          await post('/documents', { patientId: rec.patient.id, encounterId: rec.encounterId, recommendationIds: picked, kind: 'report', title: f.name, mime: f.type, dataBase64, note: note.trim() || undefined });
        }
      } else await Promise.all(picked.map((id) => patch(`/worklist/${id}`, { status: 'done', contact: { outcome: 'Result received', note: note.trim() } })));
      ['worklist', 'results', 'documents'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      toast(`Result saved for ${picked.length} test${picked.length === 1 ? '' : 's'}`); onClose();
    } catch (e: any) { toast(e?.body?.code === 'TOO_LARGE' ? 'A file is too large (10 MB at most).' : errText(e), 'err'); } finally { setBusy(false); }
  };
  return (
    <Modal title="Result received" subtitle={`${rec.patient.fullName} · ${tests.map((t) => t.notes).filter(Boolean).join(', ') || rec.notes}`} onClose={onClose} width="max-w-lg">
      <div className="space-y-4">
        <label onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={(e) => { e.preventDefault(); setOver(false); add(e.dataTransfer.files); }}
          className={`block cursor-pointer rounded-2xl border-2 border-dashed px-4 py-6 text-center text-sm ${over ? 'border-clay bg-clay-soft' : 'border-ink/20 bg-white/50'}`}>
          <b className="text-ink">Drop files here</b><div className="text-muted">or <u>choose files</u> · on a phone you can take a photo</div><div className="mt-1 text-xs text-muted">PDF, JPG, PNG or WebP · up to 10 MB each</div>
          <input type="file" multiple accept="image/*,application/pdf" className="hidden" onChange={(e) => { add(e.target.files); e.target.value = ''; }} />
        </label>
        {files.length > 0 && <div className="space-y-1.5">{files.map((f, k) => (
          <div key={f.name + k} className="flex items-center gap-2.5 rounded-2xl bg-white px-3 py-2 text-sm"><span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[10px] font-bold ${f.type === 'application/pdf' ? 'bg-clay-soft text-clay' : 'bg-sky-soft text-sky'}`}>{f.type === 'application/pdf' ? 'PDF' : 'IMG'}</span>
            <span className="min-w-0 flex-1 truncate">{f.name} <span className="text-xs text-muted">· {kb(f.size)}</span></span>
            <button className="btn btn-ghost btn-icon" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((_, j) => j !== k))}><Icon name="x" className="h-3.5 w-3.5" /></button></div>))}</div>}
        {tests.length > 1 && <div><div className="label">Which tests is this for</div><div className="flex flex-wrap gap-1.5">{tests.map((t) => <button key={t.id} type="button" aria-pressed={picked.includes(t.id)} className={`toggle-opt ${picked.includes(t.id) ? 'on' : ''}`} onClick={() => setPicked(picked.includes(t.id) ? picked.filter((x) => x !== t.id) : [...picked, t.id])}>{t.notes}</button>)}</div></div>}
        <div><label className="label" htmlFor="res-note">Note (optional)</label><input id="res-note" className="input" maxLength={300} placeholder="Hb 11.2, TSH normal…" value={note} onChange={(e) => setNote(e.target.value)} /></div>
        {tried && bad && <div className="text-xs text-rose">{picked.length === 0 ? 'Choose at least one test.' : 'Add a file or write the result in the note.'}</div>}
        <div className="modal-foot"><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy} onClick={save}><Icon name="check" />{busy ? 'Saving…' : 'Save result'}</button></div>
      </div>
    </Modal>
  );
}
