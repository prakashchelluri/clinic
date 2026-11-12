import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { post, ApiError, errText } from './api';
import { Icon, Modal, toast } from './ui';
import { clashLabel } from './procBoard';
import type { DragItem } from './procDrag';
import './procweek.css';

export const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
/** "10:30" in the 12-hour clock, no am/pm: the hour rows already say which. */
export const t12 = (t: string) => `${Number(t.slice(0, 2)) % 12 || 12}:${t.slice(3, 5)}`;
export const lenText = (m: number) => (m < 60 ? `${m} min` : m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`);
/** "10–11 am", "12–1 pm" for an hour row. */
export const hourLabel = (h: number) => `${h % 12 || 12}–${(h + 1) % 12 || 12} ${h + 1 >= 12 && h + 1 < 24 ? 'pm' : 'am'}`;
export const addDay = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
export const longDay = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
export const nowHHMM = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
/** The clinic's procedure hours, widened to fit anything booked outside them. */
export const procHours = (sittings: { startTime: string }[]) => {
  const a = Math.min(9, ...sittings.map((s) => Number(s.startTime.slice(0, 2)))), b = Math.max(19, ...sittings.map((s) => Number(s.startTime.slice(0, 2))));
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
};

/** Where a sitting stands, in one word or two. Week view says Approved where Today says whether the patient said yes. */
export function sitStatus(s: any, week = false, doctor = false): { word: string; cls: string } {
  if (s.state === 'completed') return { word: 'Done', cls: 'done' };
  if (s.state === 'in_progress') return { word: 'In the room', cls: 'room' };
  if (s.state === 'missed') return { word: 'Missed', cls: 'done warn' };
  if (s.approval === 'draft') return { word: 'Not sent', cls: 'draft' };
  if (s.approval === 'sent') return { word: doctor ? (s.changed ? 'Changed · to approve' : 'To approve') : s.changed ? 'Changed · with doctor' : 'With doctor', cls: 'sent amber' };
  if (s.approval === 'change') return { word: 'Change asked', cls: 'change' };
  if (s.patientConfirmedAt) return { word: 'Confirmed', cls: '' };
  return week ? { word: 'Approved', cls: '' } : { word: 'Not confirmed', cls: 'warn' };
}
/** A sitting that can still be moved by drag: booked and not over. */
export const movable = (s: any, today: string) => s.state === 'confirmed' && s.day >= today;
export const dragItem = (s: any): DragItem => ({ id: s.id, title: s.patient.fullName, sub: `${s.procedure ?? 'Procedure'} · ${lenText(toMin(s.endTime) - toMin(s.startTime))}`, where: `${s.doctor ?? 'No doctor'} · ${s.room ?? 'no room'}` });

/** One sitting as a block: time and status, patient, procedure and sitting number, doctor and room. */
export function Block({ s, week = false, doctor = false, cls = '', onDown, onClick }: { s: any; week?: boolean; doctor?: boolean; cls?: string; onDown?: (e: React.PointerEvent) => void; onClick: () => void }) {
  const st = sitStatus(s, week, doctor); const len = toMin(s.endTime) - toMin(s.startTime);
  return (
    <button type="button" className={`pw-blk ${st.cls} ${onDown ? '' : 'fixed'} ${cls}`} onPointerDown={onDown} onClick={onClick} title={s.approvalNote ? `Doctor's note: ${s.approvalNote}` : undefined}>
      <span className="top"><span>{t12(s.startTime)}–{t12(s.endTime)}{week ? '' : ` · ${lenText(len)}`}</span>{!week && <span className="st">{st.word}</span>}</span>
      <b>{s.state === 'completed' ? '✓ ' : ''}{s.patient.fullName}</b>
      <span>{s.procedure ?? 'Procedure'} · {s.of ? `${s.sittingNo} of ${s.of}` : `sitting ${s.sittingNo}`}</span>
      <span>{s.doctor ?? 'No doctor'} · {s.room ?? 'no room'}</span>
      {week && <span className="st">{st.word}</span>}
      {s.approval === 'change' && s.approvalNote && <span className="st">“{s.approvalNote}”</span>}
    </button>
  );
}
/** The thin strip a long sitting leaves in the hours it still fills. */
export const Stub = ({ s }: { s: any }) => <span className="pw-stub" title={`${s.patient.fullName} · ${s.procedure ?? 'Procedure'} till ${t12(s.endTime)}`}>↳ {s.patient.fullName} · till {t12(s.endTime)}</span>;
/** Sittings starting in this hour, and the ones that started earlier and still fill it. */
export const inHour = (list: any[], h: number) => list.filter((s) => Number(s.startTime.slice(0, 2)) === h).sort((a, b) => a.startTime.localeCompare(b.startTime));
export const fillsHour = (list: any[], h: number) => list.filter((s) => Number(s.startTime.slice(0, 2)) < h && toMin(s.endTime) > h * 60);

/** Put a doctor on a sitting. A clash with the doctor's other work is explained and can be overridden. */
export function AssignDoctor({ s, docs, onClose }: { s: any; docs: any[]; onClose: () => void }) {
  const [doc, setDoc] = useState<string>(s.practitionerId ?? docs[0]?.id ?? '');
  const [conf, setConf] = useState<any[] | null>(null); const [sup, setSup] = useState<string>(s.supervisorId ?? '');
  const save = useMutation({ mutationFn: (force: boolean) => post(`/procedure-sessions/${s.id}/assign`, { practitionerId: doc || null, supervisorId: sup || null, force }),
    onSuccess: () => { toast('Doctor assigned'); onClose(); },
    onError: (e: any) => { if (e instanceof ApiError && e.body?.code === 'CONFLICT') setConf(e.body.conflicts); else toast(errText(e), 'err'); } });
  return (
    <Modal title={s.practitionerId ? 'Change doctor' : 'Assign doctor'} subtitle={`${s.patient.fullName} · ${s.procedure ?? 'procedure'} · ${s.startTime}–${s.endTime}`} onClose={onClose} width="max-w-md">
      <div className="space-y-4">
        <div><label className="label" htmlFor="as-doc">Doctor</label>
          <select id="as-doc" className="input" value={doc} onChange={(e) => { setDoc(e.target.value); setConf(null); }}>{!s.requiresMainDoctor && <option value="">No doctor needed</option>}{docs.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          {doc && <div className="mt-1 text-[11px] text-amber">{docs.find((p: any) => p.id === doc)?.name ?? 'This doctor'} gets no OPD bookings {s.startTime}–{s.endTime}.</div>}
          {doc && doc !== s.practitionerId && <div className="mt-1 text-[11px] text-muted">It goes to {docs.find((p: any) => p.id === doc)?.name ?? 'the doctor'} to approve.</div>}</div>
        <div><label className="label" htmlFor="as-sup">Supervised by (optional)</label><select id="as-sup" className="input" value={sup} onChange={(e) => setSup(e.target.value)}><option value="">Nobody</option>{docs.filter((p: any) => p.id !== doc).map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
        {conf && <div className="rounded-xl bg-amber-soft p-3 text-sm text-amber anim-fade-up"><div className="mb-1 font-medium">This doctor is busy then:</div>{conf.map((c, i) => <div key={i}>• {clashLabel(c.kind)}: {c.who} ({c.startTime}–{c.endTime})</div>)}</div>}
        <div className="modal-foot"><button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          {conf ? <button className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate(true)}>Assign anyway</button> : <button className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate(false)}><Icon name="check" />Assign</button>}</div>
      </div>
    </Modal>
  );
}

/** Move a sitting (or book a course's next one) onto an hour; the server picks the minute and the room, or says why not. */
export async function placeOn(body: { sittingId?: string; recommendationId?: string; day: string; hour: number }) {
  try { return await post('/procedure-sessions/place', body); }
  catch (e: any) { toast(e instanceof ApiError && e.body?.why ? `Can't go there: ${e.body.why}` : errText(e), 'err'); return null; }
}
