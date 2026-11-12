import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useOutletContext, useSearchParams } from 'react-router';
import { get, post, today, errText } from '../api';
import { ProcToday } from './ProcToday';
import { ProcWeek } from './ProcWeek';
import { CourseList, clashLabel } from '../procBoard';
import { Drawer, Chip, Icon, PageHeader, Skeleton, Tabs, fmtDate, toast } from '../ui';

type View = 'today' | 'week' | 'courses';
/** Procedures: today's sittings by the hour, the week the coordinator plans and sends to the doctors, and every course on one board. */
export function Worklist() {
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab');
  // older links: schedule = today, plans = week (Pending schedules), board = courses
  const view: View = tab === 'week' || tab === 'plans' ? 'week' : tab === 'courses' || tab === 'board' ? 'courses' : 'today';
  const setView = (v: View) => setSp((p) => { p.set('tab', v); return p; }, { replace: true });
  return (
    <div>
      <PageHeader title="Procedures" />
      <Tabs<View> className="mb-4" value={view} onChange={setView} options={[{ value: 'today', label: "Today's sittings" }, { value: 'week', label: 'Week plan' }, { value: 'courses', label: 'All courses' }]} />
      {view === 'today' ? <ProcToday /> : view === 'week' ? <ProcWeek /> : <CourseList />}
    </div>
  );
}
/** Pick a day; the server lists rooms with the right capability and the free slots; conflicts are explained, override is explicit. */
export function ScheduleModal({ rec, sitting, at, onClose }: { rec: any; sitting?: any; at?: { day: string; roomId: string; startTime: string }; onClose: () => void }) {
  const { cfg } = useOutletContext<any>();
  const proc = cfg.procedures.find((p: any) => p.id === rec.procedureId);
  const [day, setDay] = useState(at ? at.day : sitting ? (sitting.day >= today() ? sitting.day : today()) : rec.dueOn && rec.dueOn >= today() ? rec.dueOn : today());
  const [reason, setReason] = useState('');
  const toM = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const [minutes, setMinutes] = useState<number>(sitting ? Math.max(5, toM(sitting.endTime) - toM(sitting.startTime) - (proc?.bufferMinutes ?? 0)) : proc?.typicalMinutes ?? 30);
  const [doc, setDoc] = useState<string>(sitting ? sitting.practitionerId ?? '' : proc?.requiresMainDoctor ? cfg.practitioners[0]?.id ?? '' : '');
  const [pick, setPick] = useState<{ roomId: string; startTime: string } | null>(at ? { roomId: at.roomId, startTime: at.startTime } : null); // a free room-hour tapped on the schedule
  const [manual, setManual] = useState({ startTime: '', roomId: '' });
  const [conf, setConf] = useState<any[] | null>(null);
  const endOf = (start: string) => { const m = toM(start) + minutes + (proc?.bufferMinutes ?? 0); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
  const slots =useQuery({ queryKey: ['slots', rec.procedureId, day, doc, minutes], queryFn: () => get(`/procedure-sessions/slots?day=${day}&procedureId=${rec.procedureId}&minutes=${minutes}${doc ? `&practitionerId=${doc}` : ''}`), enabled: !!rec.procedureId });
  const save = useMutation({
    mutationFn: (force: boolean) => post(sitting ? `/procedure-sessions/${sitting.id}/reschedule` : '/procedure-sessions', { ...(sitting ? { reason: reason.trim() || undefined } : { recommendationId: rec.id }), day, startTime: pick?.startTime ?? manual.startTime, minutes, roomId: pick?.roomId ?? manual.roomId ?? null, practitionerId: doc || null, force }),
    onSuccess: (r: any) => { toast(`${sitting ? 'Moved to' : 'Scheduled'} ${day} ${r.startTime}`); onClose(); },
    onError: (e: any) => { if (e?.body?.code === 'CONFLICT') setConf(e.body.conflicts); else toast(errText(e), 'err'); },
  });
  const byRoom: Record<string, any[]> = {};
  for (const s of slots.data?.slots ?? []) (byRoom[s.room] ??= []).push(s);
  const existing = useQuery({ queryKey: ['psessions', rec.id], queryFn: () => get(`/procedure-sessions?recommendationId=${rec.id}`) });
  return (
    <Drawer title={`${sitting ? 'Reschedule' : 'Schedule'} · ${proc?.name ?? 'procedure'}`} subtitle={`${rec.patient.fullName} · ${rec.patient.phone ?? ''}${rec.sittings ? ` · ${rec.sittings} ${rec.sittings === 1 ? 'sitting' : 'sittings'} planned` : ''}${slots.data?.requiredCapability ? ` · needs a room with “${slots.data.requiredCapability}”` : ''}`} onClose={onClose} width="max-w-3xl">
      <div className="space-y-4">
        {(existing.data ?? []).length > 0 && <div className="text-xs text-muted flex flex-wrap gap-1.5 items-center">Previous sittings: {existing.data.map((s: any) => <Chip key={s.id} tone={s.state === 'completed' ? 'sage' : s.state === 'confirmed' ? 'sky' : ''}>{fmtDate(s.day)} · {({ confirmed: 'Booked', in_progress: 'In room', completed: 'Done', missed: 'Missed', cancelled: 'Cancelled', postponed: 'Postponed' } as Record<string, string>)[s.state] ?? s.state}</Chip>)}</div>}
        <div className="grid grid-cols-3 gap-3">
          <div><label className="label">Day</label><input type="date" className="input" value={day} onChange={(e) => { setDay(e.target.value); setPick(null); }} /></div>
          <div><label className="label">Duration (min)</label><div className="flex gap-1 flex-wrap">{[15, 30, 45, 60, 90, 120].map((m) => <button key={m} className={`toggle-opt ${minutes === m ? 'on' : ''}`} onClick={() => { setMinutes(m); setPick(null); }}>{m}</button>)}</div></div>
          <div><label className="label">Doctor {proc?.requiresMainDoctor && <span className="text-clay">required</span>}</label><select className="input" value={doc} onChange={(e) => { setDoc(e.target.value); setPick(null); }}><option value="">Other staff / none</option>{cfg.practitioners.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
            {doc && <div className="text-[11px] text-amber mt-1">{cfg.practitioners.find((p: any) => p.id === doc)?.name ?? 'This doctor'} gets no OPD bookings {(pick?.startTime ?? manual.startTime) ? `${pick?.startTime ?? manual.startTime}–${endOf(pick?.startTime ?? manual.startTime)}` : 'for the sitting'}.</div>}</div>
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
        {conf && <div className="rounded-xl bg-amber-soft text-amber text-sm p-3 anim-fade-up"><div className="font-medium mb-1">This slot clashes:</div>{conf.map((c, i) => <div key={i}>• {clashLabel(c.kind)}: {c.who} ({c.startTime}–{c.endTime})</div>)}<button className="btn btn-sm mt-2" onClick={() => save.mutate(true)}>Schedule anyway</button></div>}
        <div className="modal-foot"><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={save.isPending || (!pick && !manual.startTime)} onClick={() => save.mutate(false)}><Icon name="check" />Book {new Date(day + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })}{(pick?.startTime ?? manual.startTime) ? `, ${pick?.startTime ?? manual.startTime}` : ''}</button></div>
      </div>
    </Drawer>
  );
}
