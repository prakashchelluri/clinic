import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useOutletContext } from 'react-router';
import { get, post, patch, qc, today, uuid, ApiError } from '../api';
import { can } from '../App';

/** Phone booking: pick a day, see windows with allocated/capacity, book with name + phone. */
export function Booking() {
  const { cfg, perms } = useOutletContext<any>();
  const [day, setDay] = useState(today());
  const sessions = useQuery({ queryKey: ['sessions', day], queryFn: () => get(`/sessions?day=${day}`), refetchInterval: 10000 });
  const appts = useQuery({ queryKey: ['appointments', day], queryFn: () => get(`/appointments?day=${day}`) });
  const [sel, setSel] = useState<any>(null);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['sessions'] }); qc.invalidateQueries({ queryKey: ['appointments'] }); };
  const copy = useMutation({ mutationFn: () => post('/sessions/copy', { fromDay: shift(day, -1), toDay: day }), onSuccess: refresh });
  const addWin = useMutation({ mutationFn: (w: any) => post('/sessions', { ...w, day, branchId: cfg.branches[0].id }), onSuccess: refresh });
  const setCap = useMutation({ mutationFn: ({ id, capacity }: any) => patch(`/sessions/${id}`, { capacity }), onSuccess: refresh });
  const cancel = useMutation({ mutationFn: (id: string) => patch(`/appointments/${id}`, { status: 'cancelled' }), onSuccess: refresh });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h1 className="text-lg font-semibold">Booking</h1>
        <button className="btn btn-sm" onClick={() => setDay(shift(day, -1))}>‹</button>
        <input type="date" className="input !w-auto" value={day} onChange={(e) => setDay(e.target.value)} />
        <button className="btn btn-sm" onClick={() => setDay(shift(day, 1))}>›</button>
        {can(perms, 'appointment.write') && sessions.data?.length === 0 && <button className="btn btn-sm ml-2" onClick={() => copy.mutate()}>Copy yesterday's windows</button>}
        {can(perms, 'appointment.write') && <AddWindow onAdd={(w) => addWin.mutate(w)} practitioners={cfg?.practitioners ?? []} />}
      </div>
      <div className="grid md:grid-cols-4 gap-3">
        {(sessions.data ?? []).map((s: any) => {
          const pct = s.capacity ? Math.min(100, Math.round((s.allocated / s.capacity) * 100)) : 100;
          return (
            <button key={s.id} onClick={() => setSel(s)} className={`card text-left hover:border-emerald-600 ${sel?.id === s.id ? 'border-emerald-700 ring-2 ring-emerald-200' : ''}`}>
              <div className="flex justify-between"><span className="font-semibold">{s.startTime}–{s.endTime}</span><span className={`badge ${s.free <= 0 ? '!bg-red-100 !text-red-700' : s.free <= 2 ? '!bg-amber-100 !text-amber-800' : '!bg-emerald-100 !text-emerald-800'}`}>{s.allocated}/{s.capacity}</span></div>
              <div className="h-1.5 bg-slate-100 rounded mt-2"><div className="h-1.5 bg-emerald-600 rounded" style={{ width: pct + '%' }} /></div>
              <div className="text-xs text-slate-500 mt-1 flex items-center gap-2">{cfg?.practitioners.find((p: any) => p.id === s.practitionerId)?.name ?? 'Any doctor'}
                {can(perms, 'appointment.write') && <span className="ml-auto flex gap-1"><span className="cursor-pointer px-1 hover:bg-slate-100 rounded" onClick={(e) => { e.stopPropagation(); setCap.mutate({ id: s.id, capacity: Math.max(0, s.capacity - 1) }); }}>−</span><span className="cursor-pointer px-1 hover:bg-slate-100 rounded" onClick={(e) => { e.stopPropagation(); setCap.mutate({ id: s.id, capacity: s.capacity + 1 }); }}>+</span></span>}</div>
            </button>
          );
        })}
        {sessions.data?.length === 0 && <div className="text-sm text-slate-500 col-span-4">No OP windows set for this day.</div>}
      </div>
      <div className="grid lg:grid-cols-2 gap-4">
        {sel && can(perms, 'appointment.write') && <BookForm session={sel} arriveEarly={cfg?.tenant.settings.scheduling?.arriveEarlyMinutes ?? 30} onDone={refresh} />}
        <div className="card">
          <div className="text-sm font-semibold mb-2">Appointments on {day} ({(appts.data ?? []).filter((a: any) => a.status !== 'cancelled').length})</div>
          <ul className="divide-y divide-slate-100 text-sm">
            {(appts.data ?? []).map((a: any) => (
              <li key={a.id} className={`py-1.5 flex items-center gap-2 ${a.status === 'cancelled' ? 'line-through text-slate-400' : ''}`}>
                <span className="font-mono text-xs text-slate-500 w-12">{a.window.startTime}</span>
                <span className="flex-1">{a.patient.fullName} <span className="text-slate-400">{a.patient.phone}</span>{a.overbooked && <span className="badge !bg-amber-100 !text-amber-800 ml-1">overbooked</span>}</span>
                <span className="badge">{a.status}</span>
                {a.status === 'booked' && can(perms, 'appointment.write') && <button className="btn btn-sm" onClick={() => cancel.mutate(a.id)}>Cancel</button>}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function BookForm({ session, arriveEarly, onDone }: { session: any; arriveEarly: number; onDone: () => void }) {
  const [q, setQ] = useState(''); const [patientId, setPatientId] = useState<string | undefined>(); const [name, setName] = useState(''); const [note, setNote] = useState('');
  const [result, setResult] = useState<any>(null); const [err, setErr] = useState<any>(null);
  const search = useQuery({ queryKey: ['patients', q], queryFn: () => get(`/patients?q=${encodeURIComponent(q)}`), enabled: q.length >= 3 });
  const book = useMutation({
    mutationFn: (overbook: boolean) => post('/appointments', { sessionId: session.id, patientId, newPatient: patientId ? undefined : { fullName: name, phone: /^\d{10}$/.test(q) ? q : undefined }, note, overbook, idempotencyKey: uuid() }),
    onSuccess: (r) => { setResult(r); setErr(null); setQ(''); setName(''); setPatientId(undefined); onDone(); },
    onError: (e: any) => setErr(e instanceof ApiError ? e.body : { code: e.message }),
  });
  const arriveBy = minus(session.startTime, arriveEarly);
  return (
    <div className="card space-y-2">
      <div className="text-sm font-semibold">Book into {session.startTime}–{session.endTime} <span className="text-slate-400 font-normal">· tell patient: arrive by {arriveBy}, wait may be 30–45 min</span></div>
      <input autoFocus className="input" placeholder="Phone number or name" value={q} onChange={(e) => { setQ(e.target.value); setPatientId(undefined); }} />
      {!patientId && (search.data ?? []).length > 0 && <ul className="text-sm divide-y divide-slate-100 max-h-40 overflow-auto">{search.data.map((p: any) => <li key={p.id} className="py-1 flex gap-2"><span className="flex-1">{p.fullName} <span className="text-slate-400">{p.phone} · {p.patientNo}</span></span><button className="btn btn-sm" onClick={() => { setPatientId(p.id); setName(p.fullName); }}>Select</button></li>)}</ul>}
      {!patientId && <input className="input" placeholder="New caller: name" value={name} onChange={(e) => setName(e.target.value)} />}
      {patientId && <div className="text-sm bg-slate-50 rounded p-2">Booking for <b>{name}</b></div>}
      <input className="input" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="flex gap-2"><button className="btn btn-primary" disabled={!patientId && !name} onClick={() => book.mutate(false)}>Book</button>
        {err?.code === 'WINDOW_FULL' && <button className="btn" onClick={() => book.mutate(true)}>Overbook anyway</button>}</div>
      {err && <div className="text-xs text-red-600">{err.code === 'WINDOW_FULL' ? <>Window full. Free: {err.alternatives.map((a: any) => `${a.startTime} (${a.capacity - a.allocated})`).join(', ') || 'none today'}</> : JSON.stringify(err)}</div>}
      {result && <div className="text-xs text-emerald-700">Booked {result.window.startTime}–{result.window.endTime}. Arrive by {minus(result.window.startTime, result.arriveEarlyMinutes)}. ({result.capacity.allocated}/{result.capacity.limit})</div>}
    </div>
  );
}

function AddWindow({ onAdd, practitioners }: { onAdd: (w: any) => void; practitioners: any[] }) {
  const [open, setOpen] = useState(false); const [w, setW] = useState({ startTime: '10:00', endTime: '11:00', capacity: 7, practitionerId: practitioners[0]?.id ?? null });
  if (!open) return <button className="btn btn-sm" onClick={() => setOpen(true)}>+ Window</button>;
  return (
    <span className="flex items-center gap-1 text-sm">
      <input type="time" className="input !w-auto" value={w.startTime} onChange={(e) => setW({ ...w, startTime: e.target.value })} />–
      <input type="time" className="input !w-auto" value={w.endTime} onChange={(e) => setW({ ...w, endTime: e.target.value })} />
      <input type="number" className="input !w-16" value={w.capacity} onChange={(e) => setW({ ...w, capacity: Number(e.target.value) })} />
      <select className="input !w-auto" value={w.practitionerId ?? ''} onChange={(e) => setW({ ...w, practitionerId: e.target.value || null })}><option value="">Any</option>{practitioners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
      <button className="btn btn-sm btn-primary" onClick={() => { onAdd(w); setOpen(false); }}>Add</button><button className="btn btn-sm" onClick={() => setOpen(false)}>×</button>
    </span>
  );
}

const shift = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const minus = (hhmm: string, min: number) => { const [h, m] = hhmm.split(':').map(Number); const t = h * 60 + m - min; return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };
