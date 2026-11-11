import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useOutletContext, useSearchParams } from 'react-router';
import { get, patch, post, qc, today, errText, ApiError } from '../api';
import { can } from '../App';
import { Icon, Modal, Skeleton, ask, toast } from '../ui';
import { ScheduleModal } from './Worklist';
import { LoadError, clashLabel } from '../procBoard';
import { ProcedureDrawer } from '../procDrawer';
import '../frontdesk.css';

const add = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const long = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const refresh = () => ['psessions', 'pcounts', 'calendar', 'worklist', 'psessions-upcoming', 'procedure-session'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;
const hourLabel = (h: number) => `${h % 12 || 12}–${(h + 1) % 12 || 12} ${h + 1 > 12 ? 'pm' : 'am'}`;
const nowHHMM = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());

/** Which rooms this computer shows: picked once, kept. */
function useRoomsShown(): [Record<string, boolean>, (id: string, on: boolean) => void] {
  const [s, setS] = useState<Record<string, boolean>>(() => { try { return JSON.parse(localStorage.getItem('proc.rooms') ?? '{}'); } catch { return {}; } });
  return [s, (id, on) => { const n = { ...s, [id]: on }; setS(n); try { localStorage.setItem('proc.rooms', JSON.stringify(n)); } catch { /* storage blocked */ } }];
}

/**
 * Sittings for one day by the hour, one column per room: the same shape as the front desk.
 * A sitting opens the procedure drawer (Start asks about consent on the first sitting, Mark done says what happens to the money);
 * a free room-hour books a sitting from the plans waiting for a date. The side panel holds only what needs the coordinator.
 */
export function ProcSchedule({ onPlans }: { onPlans: () => void }) {
  const { perms, cfg } = useOutletContext<any>();
  const [sp, setSp] = useSearchParams();
  const t = today();
  const day = sp.get('day') ?? t;
  const setDay = (d: string) => setSp((p) => { p.set('tab', 'schedule'); p.set('day', d); return p; }, { replace: true });
  const [shown, setShown] = useRoomsShown();
  const [openId, setOpenId] = useState<string | null>(null);
  const [moving, setMoving] = useState<any>(null); const [assigning, setAssigning] = useState<any>(null);
  const [booking, setBooking] = useState<null | { roomId: string; startTime: string }>(null); const [bookRec, setBookRec] = useState<any>(null);
  const canWrite = can(perms, 'worklist.write');

  const q = useQuery({ queryKey: ['psessions', 'day', day], queryFn: () => get(`/procedure-sessions?day=${day}&active=1&detail=1`), refetchInterval: 15000 });
  const plans = useQuery({ queryKey: ['worklist', 'procedure'], queryFn: () => get('/worklist?kind=procedure'), enabled: can(perms, 'worklist.read') });
  const DONE: Record<string, string> = { in_progress: 'Sitting started', completed: 'Marked done', missed: 'Moved to missed', cancelled: 'Sitting cancelled' };
  const setState = useMutation({ mutationFn: ({ id, ...b }: any) => patch(`/procedure-sessions/${id}`, b), onSuccess: (_r, v: any) => { refresh(); toast(DONE[v.state] ?? 'Updated'); }, onError: (e) => toast(errText(e), 'err') });
  const confirm = useMutation({ mutationFn: ({ id, confirmed }: any) => post(`/procedure-sessions/${id}/confirm`, { confirmed }), onSuccess: (_r, v: any) => { refresh(); toast(v.confirmed ? 'Noted: the patient said yes' : 'Patient answer removed', 'info'); }, onError: (e) => toast(errText(e), 'err') });

  const all: any[] = q.data ?? [];
  const docs = (cfg?.practitioners ?? []).filter((p: any) => p.active !== false);
  const rooms = (cfg?.rooms ?? []).filter((r: any) => r.active !== false);
  const cols = [...rooms.filter((r: any) => shown[r.id] !== false), ...(all.some((s) => !s.roomId) ? [{ id: '', name: 'No room' }] : [])];
  const live = (s: any) => ['confirmed', 'in_progress'].includes(s.state);
  const toCall = all.filter((s) => s.state === 'confirmed' && !s.patientConfirmedAt && day >= t);
  const noDoc = all.filter((s) => live(s) && !s.practitionerId);
  const waitingPlans = (plans.data ?? []).filter((r: any) => !r.next && ['open', 'contacted'].includes(r.status));
  const nextId = day === t ? [...all].filter((s) => s.state === 'confirmed').sort((a, b) => a.startTime.localeCompare(b.startTime))[0]?.id : undefined;
  const now = nowHHMM();
  const startH = Math.min(9, ...all.map((s) => Number(s.startTime.slice(0, 2))));
  const endH = Math.max(19, ...all.map((s) => Number(s.startTime.slice(0, 2))));
  const hours = Array.from({ length: endH - startH + 1 }, (_, i) => startH + i);
  const past = (h: number) => day < t || (day === t && hh(h + 1) <= now);
  const nowH = day === t ? Number(now.slice(0, 2)) : -1;

  const chip = (s: any) => {
    const k = s.state === 'completed' ? 'fd-k-done' : s.state === 'in_progress' ? 'fd-k-doctor' : s.state === 'missed' ? 'fd-k-late' : s.id === nextId ? 'fd-k-booked fd-k-next' : 'fd-k-booked';
    const note = s.state === 'in_progress' ? 'in the room' : s.state === 'missed' ? 'missed' : [s.startTime, s.state === 'confirmed' && !s.patientConfirmedAt && day >= t ? 'not called' : null, !s.practitionerId && live(s) ? 'no doctor' : null].filter(Boolean).join(' · ');
    return <button key={s.id} type="button" className={`fd-pc fd-sit ${k} ${openId === s.id ? 'sel' : ''}`} onClick={() => setOpenId(s.id)}>
      <b>{s.state === 'completed' ? '✓ ' : ''}{s.patient.fullName}</b><span>{s.procedure ?? 'Procedure'} · {note}</span></button>;
  };
  const opened = all.find((s) => s.id === openId);
  const act = (label: string, run: () => void, primary = false) => <button className={`btn btn-sm ${primary ? 'btn-primary' : ''}`} onClick={run}>{label}</button>;
  const actions = (s: any) => canWrite && s.state === 'confirmed' ? <>
    {act(s.patientConfirmedAt ? 'Undo: patient said yes' : 'Patient said yes', () => confirm.mutate({ id: s.id, confirmed: !s.patientConfirmedAt }))}
    {act(s.practitionerId ? 'Change doctor' : 'Pick doctor', () => { setOpenId(null); setAssigning(s); })}
    {act('Reschedule', () => { setOpenId(null); setMoving(s); })}
    {act('Mark as missed', async () => { if (await ask({ title: 'Mark this sitting as missed?', body: `${s.patient.fullName} · ${s.procedure ?? 'procedure'} at ${s.startTime}. The room is freed.`, confirmLabel: 'Mark missed', cancelLabel: 'Keep it' })) { setOpenId(null); setState.mutate({ id: s.id, state: 'missed' }); } })}
    {act('Cancel sitting', async () => { const a = await ask({ title: 'Cancel this sitting?', body: `${s.patient.fullName} · ${s.procedure ?? 'procedure'} at ${s.startTime}. The room and doctor are freed and it goes back to Plans to schedule.`, confirmLabel: 'Cancel sitting', cancelLabel: 'Keep it', field: { label: 'Reason', maxLength: 200 } }); if (a) { setOpenId(null); setState.mutate({ id: s.id, state: 'cancelled', reason: a.value || undefined }); } })}
  </> : canWrite && s.state === 'missed' ? act('Reschedule', () => { setOpenId(null); setMoving(s); }, true) : null;

  return (
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_330px]">
      <div className="fd-sheet fd-sch overflow-hidden anim-fade-up">
        <div className="fd-sch-bar">
          <button type="button" className="btn btn-icon !h-8 !w-8" aria-label="Previous day" onClick={() => setDay(add(day, -1))}><Icon name="chevL" className="h-4 w-4" /></button>
          <label className="fd-sch-date"><span>{day === t ? `Today · ${long(day)}` : day === add(t, 1) ? `Tomorrow · ${long(day)}` : long(day)}</span><input type="date" aria-label="Pick a day" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} /></label>
          <button type="button" className="btn btn-icon !h-8 !w-8" aria-label="Next day" onClick={() => setDay(add(day, 1))}><Icon name="chevR" className="h-4 w-4" /></button>
          {day !== t && <button type="button" className="btn btn-sm" onClick={() => setDay(t)}>Today</button>}
          <span className="ml-auto" />
          {rooms.length > 1 && rooms.map((r: any) => { const on = shown[r.id] !== false; return <button key={r.id} type="button" className={`fd-cal ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => { if (on && rooms.filter((x: any) => shown[x.id] !== false).length === 1) return; setShown(r.id, !on); }}><span className="tick">{on ? '✓' : ''}</span>{r.name}</button>; })}
        </div>
        {q.isLoading ? <div className="p-4"><Skeleton rows={4} /></div> : q.isError && !q.data ? <div className="p-4"><LoadError onRetry={() => q.refetch()} /></div> : !cols.length ? <div className="py-10 text-center text-muted">No rooms are set up. Rooms are added in Settings.</div> : (
          <div className="overflow-x-auto">
            <div className="fd-hgrid" style={{ minWidth: 88 + cols.length * 230, gridTemplateColumns: `88px repeat(${cols.length}, minmax(0, 1fr))` }}>
              <span className="fd-hh" />
              {cols.map((r: any) => <span key={r.id} className="fd-hh"><b>{r.name}</b> <span>{(r.capabilities ?? []).slice(0, 3).join(', ')}</span></span>)}
              {hours.map((h) => [
                <span key={`t${h}`} className={`fd-ht ${h === nowH ? 'now' : ''} ${past(h) ? 'past' : ''}`}>{hourLabel(h)}{h === nowH && <small>now</small>}</span>,
                ...cols.map((r: any) => {
                  const mine = all.filter((s) => (s.roomId ?? '') === r.id && Number(s.startTime.slice(0, 2)) === h).sort((a, b) => a.startTime.localeCompare(b.startTime));
                  return (
                    <div key={r.id + h} className={`fd-hc ${h === nowH ? 'now' : ''}`}>
                      {mine.length > 0 && <div className="fd-hchips">{mine.map(chip)}</div>}
                      {!mine.length && canWrite && r.id && !past(h) && waitingPlans.length > 0 && <button type="button" className="fd-sch-free quiet" onClick={() => setBooking({ roomId: r.id, startTime: hh(h) })}>+ Book</button>}
                    </div>);
                }),
              ])}
            </div>
          </div>)}
        <div className="fd-hkey">
          <span><i className="fd-k-booked" />Booked</span><span><i className="fd-k-next" />Next</span><span><i className="fd-k-doctor" />In the room</span>
          <span className="text-muted">✓ Done</span><span className="text-rose">Missed</span>
          <span className="ml-auto">Tap a sitting for the drawer, “+ Book” to book that room and hour.</span>
        </div>
      </div>

      {/* only what needs the coordinator */}
      <aside className="flex flex-col gap-4">
        <section className="fd-sheet overflow-hidden">
          <div className="px-4 pb-2 pt-3.5"><b className="text-[15px]">Patient not called yet</b> <span className="text-[12.5px] text-muted">· say yes once they agree</span></div>
          {toCall.length === 0 ? <div className="px-4 pb-4 text-[13px] text-muted">Everyone has said yes.</div> : toCall.map((s) => (
            <div key={s.id} className="flex items-center gap-2 border-t border-line px-4 py-2.5">
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setOpenId(s.id)}><span className="block truncate text-[14px] font-semibold">{s.patient.fullName}</span><span className="block truncate text-[12px] text-muted">{s.procedure ?? 'Procedure'} · {s.startTime} · {s.room ?? 'no room'}{s.patient.phone ? ` · ${s.patient.phone}` : ''}</span></button>
              {canWrite && <button className="btn btn-sm shrink-0" disabled={confirm.isPending} onClick={() => confirm.mutate({ id: s.id, confirmed: true })}>Patient said yes</button>}
            </div>))}
        </section>
        <section className="fd-sheet overflow-hidden">
          <div className="px-4 pb-2 pt-3.5"><b className="text-[15px]">No doctor yet</b></div>
          {noDoc.length === 0 ? <div className="px-4 pb-4 text-[13px] text-muted">Every sitting has a doctor.</div> : noDoc.map((s) => (
            <div key={s.id} className="flex items-center gap-2 border-t border-line px-4 py-2.5">
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setOpenId(s.id)}><span className="block truncate text-[14px] font-semibold">{s.patient.fullName}</span><span className="block truncate text-[12px] text-muted">{s.procedure ?? 'Procedure'} · {s.startTime}–{s.endTime}</span></button>
              {canWrite && <button className="btn btn-sm shrink-0" onClick={() => setAssigning(s)}>Pick doctor</button>}
            </div>))}
        </section>
        <section className="fd-sheet flex items-center gap-3 p-4">
          <span className="min-w-0 flex-1"><b className="text-[15px]">Plans to schedule</b><span className="block text-[12.5px] text-muted">{waitingPlans.length ? `${waitingPlans.length} waiting for a date` : 'Nothing waiting'}</span></span>
          <button className="btn btn-sm" onClick={onPlans}>Open</button>
        </section>
      </aside>

      {opened && <ProcedureDrawer id={opened.id} canAct={canWrite} extra={actions(opened)} onClose={() => setOpenId(null)} />}
      {booking && !bookRec && <Modal title="Book a sitting" subtitle={`${rooms.find((r: any) => r.id === booking.roomId)?.name ?? ''} · ${long(day)} · ${booking.startTime}`} onClose={() => setBooking(null)} width="max-w-md">
        <div className="text-[13px] text-muted mb-2">Pick a plan that is waiting for a date.</div>
        <div className="flex flex-col gap-1.5">{waitingPlans.map((r: any) => (
          <button key={r.id} type="button" className="flex items-center justify-between gap-3 rounded-[12px] px-3 py-2.5 text-left ring-1 ring-line hover:bg-surface-2" onClick={() => setBookRec(r)}>
            <span className="min-w-0"><b className="block truncate text-[14px]">{r.patient.fullName}</b><span className="block truncate text-[12px] text-muted">{r.procedure ?? 'Procedure'}{r.sittings ? ` · ${r.sittings} sittings` : ''}{r.dueOn ? ` · due ${new Date(r.dueOn + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' })}` : ''}</span></span>
            <Icon name="chevR" className="h-4 w-4 shrink-0 text-muted" /></button>))}</div>
      </Modal>}
      {booking && bookRec && <ScheduleModal rec={bookRec} at={{ day, ...booking }} onClose={() => { setBooking(null); setBookRec(null); refresh(); }} />}
      {moving && <ScheduleModal rec={{ id: moving.recommendationId, procedureId: moving.procedureId, patient: { fullName: moving.patient.fullName, phone: moving.patient.phone }, sittings: moving.of }} sitting={moving} onClose={() => { setMoving(null); refresh(); }} />}
      {assigning && <AssignDoctor s={assigning} docs={docs} onClose={() => { setAssigning(null); refresh(); }} />}
    </div>
  );
}

/** Put a doctor on a sitting. A clash with the doctor's other work is explained and can be overridden. */
function AssignDoctor({ s, docs, onClose }: { s: any; docs: any[]; onClose: () => void }) {
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
          {doc && <div className="mt-1 text-[11px] text-amber">{docs.find((p: any) => p.id === doc)?.name ?? 'This doctor'} gets no OPD bookings {s.startTime}–{s.endTime}.</div>}</div>
        <div><label className="label" htmlFor="as-sup">Supervised by (optional)</label><select id="as-sup" className="input" value={sup} onChange={(e) => setSup(e.target.value)}><option value="">Nobody</option>{docs.filter((p: any) => p.id !== doc).map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
        {conf && <div className="rounded-xl bg-amber-soft p-3 text-sm text-amber anim-fade-up"><div className="mb-1 font-medium">This doctor is busy then:</div>{conf.map((c, i) => <div key={i}>• {clashLabel(c.kind)}: {c.who} ({c.startTime}–{c.endTime})</div>)}</div>}
        <div className="modal-foot"><button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          {conf ? <button className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate(true)}>Assign anyway</button> : <button className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate(false)}><Icon name="check" />Assign</button>}</div>
      </div>
    </Modal>
  );
}
