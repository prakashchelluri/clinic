import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { get, post, patch, del, qc, errText } from './api';
import { Drawer, Segmented, ask, toast } from './ui';
import { ScheduleProcedure } from './pages/Worklist';

export const PURPOSES = ['Consultation', 'Counselling', 'Meeting', 'Cleaning', 'Maintenance', 'Other'];
const dayName = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });

/** A room's hour on the calendar: book the room (a meeting, counselling, cleaning …) or a procedure sitting in it.
 *  An existing room booking opens here too, to change its time or details, or to cancel it. */
export function RoomBooking({ cfg, at, booking, onClose }: { cfg: any; at: { roomId: string; day: string; startTime: string; endTime: string }; booking?: any; onClose: () => void }) {
  const roomName = cfg.rooms.find((r: any) => r.id === at.roomId)?.name ?? 'Room';
  const [mode, setMode] = useState<'room' | 'proc'>('room');
  const [purpose, setPurpose] = useState<string>(booking?.purpose ?? '');
  const [note, setNote] = useState<string>(booking?.note ?? '');
  const [day, setDay] = useState(booking?.day ?? at.day);
  const [start, setStart] = useState(booking?.startTime ?? at.startTime); const [end, setEnd] = useState(booking?.endTime ?? at.endTime);
  const [who, setWho] = useState<{ id: string; fullName: string } | null>(booking?.patientId ? { id: booking.patientId, fullName: booking.patient ?? 'Patient' } : null);
  const [q, setQ] = useState('');
  const found = useQuery({ queryKey: ['patients', q], queryFn: () => get(`/patients?q=${encodeURIComponent(q)}`), enabled: !who && q.trim().length >= 2 });
  const done = () => { qc.invalidateQueries({ queryKey: ['calendar'] }); onClose(); };
  const save = useMutation({
    mutationFn: () => { const body = { day, startTime: start, endTime: end, purpose, note: note.trim() || undefined, patientId: who?.id ?? null };
      return booking ? patch(`/calendar/blocks/${booking.id}`, { ...body, note: note.trim() }) : post('/calendar/blocks', { ...body, roomId: at.roomId, kind: 'other' }); },
    onSuccess: () => { toast(`${roomName} ${booking ? 'booking updated' : 'booked'}: ${purpose}, ${dayName(day)} ${start}–${end}`); done(); },
    onError: (e) => toast(errText(e), 'err'),
  });
  const cancel = async () => { if (!(await ask({ title: 'Cancel this room booking?', body: `${roomName} · ${purpose} · ${dayName(day)} ${start}–${end}`, confirmLabel: 'Cancel booking', cancelLabel: 'Keep it' }))) return;
    try { await del(`/calendar/blocks/${booking.id}`); toast('Room booking cancelled'); done(); } catch (e) { toast(errText(e), 'err'); } };

  const sw = !booking && <Segmented<'room' | 'proc'> value={mode} onChange={setMode} options={[{ value: 'room', label: 'Room booking' }, { value: 'proc', label: 'Procedure session' }]} />;
  if (mode === 'proc') return <ScheduleProcedure cfg={cfg} at={{ day: at.day, roomId: at.roomId, startTime: at.startTime }} head={sw} onClose={done} />;
  return (
    <Drawer title={booking ? 'Room booking' : `Book ${roomName}`} subtitle={`${roomName} · ${dayName(day)}`} onClose={onClose} width="max-w-lg">
      <div className="space-y-4">
        {sw}
        <div><label className="label">Purpose</label>
          <div className="flex flex-wrap gap-1.5">{PURPOSES.map((x) => <button key={x} type="button" className={`toggle-opt ${purpose === x ? 'on' : ''}`} aria-pressed={purpose === x} onClick={() => setPurpose(x)}>{x}</button>)}</div></div>
        <div className="grid grid-cols-3 gap-3">
          <div><label className="label" htmlFor="rb-day">Date</label><input id="rb-day" type="date" className="input" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} /></div>
          <div><label className="label" htmlFor="rb-s">Start</label><input id="rb-s" type="time" step={900} className="input" value={start} onChange={(e) => setStart(e.target.value)} /></div>
          <div><label className="label" htmlFor="rb-e">End</label><input id="rb-e" type="time" step={900} className="input" value={end} onChange={(e) => setEnd(e.target.value)} /></div>
        </div>
        <div><label className="label" htmlFor="rb-note">Details (optional)</label><input id="rb-note" className="input" maxLength={200} placeholder="e.g. Pharma rep demo, AC service" value={note} onChange={(e) => setNote(e.target.value)} /></div>
        <div><label className="label" htmlFor="rb-pt">Patient (optional)</label>
          {who ? <div className="flex items-center gap-2 rounded-[10px] border border-line px-3 py-2"><b className="flex-1 truncate text-[14px] font-semibold">{who.fullName}</b><button type="button" className="btn btn-sm" onClick={() => { setWho(null); setQ(''); }}>Change</button></div>
            : <><input id="rb-pt" className="input" placeholder="Patient name, phone or P-number" value={q} onChange={(e) => setQ(e.target.value)} />
              {(found.data ?? []).length > 0 && <div className="mt-1 overflow-hidden rounded-[10px] border border-line">{found.data.slice(0, 6).map((p: any) => (
                <button key={p.id} type="button" className="flex w-full gap-2 border-t border-line px-3 py-2 text-left first:border-t-0 hover:bg-surface-2" onClick={() => setWho(p)}>
                  <b className="font-semibold">{p.fullName}</b><span className="text-[12.5px] text-muted">{[p.patientNo, p.phone].filter(Boolean).join(' · ')}</span></button>))}</div>}</>}</div>
        <div className="flex items-center gap-2 border-t border-line pt-4">
          {booking && <button type="button" className="btn text-rose" onClick={cancel}>Cancel booking</button>}
          <span className="flex-1" />
          <button type="button" className="btn" onClick={onClose}>Close</button>
          <button type="button" className="btn btn-primary" disabled={!purpose || !start || !end || save.isPending} onClick={() => save.mutate()}>{booking ? 'Save' : 'Book room'}</button>
        </div>
      </div>
    </Drawer>);
}
