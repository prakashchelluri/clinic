import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useOutletContext } from 'react-router';
import { get, post, patch, qc, today, uuid, ApiError } from '../api';
import { can } from '../App';
import { Avatar, Chip, Empty, Icon, PageHeader, Section, Skeleton, toast } from '../ui';

/** Phone booking: pick a day, see windows with allocated/capacity, book with name + phone. */
export function Booking() {
  const { cfg, perms } = useOutletContext<any>();
  const [day, setDay] = useState(today());
  const [doc, setDoc] = useState('');
  const sessions = useQuery({ queryKey: ['sessions', day, doc], queryFn: () => get(`/sessions?day=${day}${doc ? `&practitionerId=${doc}` : ''}`), refetchInterval: 10000 });
  const appts = useQuery({ queryKey: ['appointments', day], queryFn: () => get(`/appointments?day=${day}`) });
  const [sel, setSel] = useState<any>(null);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['sessions'] }); qc.invalidateQueries({ queryKey: ['appointments'] }); };
  const copy = useMutation({ mutationFn: () => post('/sessions/copy', { fromDay: shift(day, -1), toDay: day }), onSuccess: () => { refresh(); toast('Windows copied'); } });
  const addWin = useMutation({ mutationFn: (w: any) => post('/sessions', { ...w, day, branchId: cfg.branches[0].id }), onSuccess: refresh });
  const setCap = useMutation({ mutationFn: ({ id, capacity }: any) => patch(`/sessions/${id}`, { capacity }), onSuccess: refresh });
  const cancel = useMutation({ mutationFn: (id: string) => patch(`/appointments/${id}`, { status: 'cancelled' }), onSuccess: () => { refresh(); toast('Appointment cancelled', 'info'); } });
  const writable = can(perms, 'appointment.write');
  const total = (sessions.data ?? []).reduce((s: any, x: any) => ({ a: s.a + x.allocated, c: s.c + x.effectiveCapacity }), { a: 0, c: 0 });
  const dayLabel = new Date(day + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <div>
      <PageHeader title="Booking" subtitle={<>{dayLabel} · <b className="text-ink">{total.a}</b> of {total.c} places allocated</>}>
        <div className="flex items-center gap-1 card !p-1 !rounded-full">
          <button className="btn btn-ghost btn-icon" onClick={() => setDay(shift(day, -1))}><Icon name="chevL" /></button>
          <input type="date" className="input !w-auto !border-0 !shadow-none !py-1.5 text-center" value={day} onChange={(e) => setDay(e.target.value)} />
          <button className="btn btn-ghost btn-icon" onClick={() => setDay(shift(day, 1))}><Icon name="chevR" /></button>
        </div>
        {(cfg?.practitioners ?? []).length > 1 && <select className="input !w-auto" value={doc} onChange={(e) => setDoc(e.target.value)}><option value="">All doctors</option>{cfg.practitioners.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}
        <a className="btn" href="/calendar"><Icon name="clock" />Doctor's day</a>
        {writable && <AddWindow onAdd={(w) => addWin.mutate(w)} practitioners={cfg?.practitioners ?? []} />}
      </PageHeader>

      {sessions.isLoading ? <Skeleton rows={2} /> : sessions.data?.length === 0 ? (
        <div className="card anim-fade-up"><Empty icon="calendar" title="No OP windows for this day" hint="Copy the previous day's plan or add windows one by one." />{writable && <div className="flex justify-center pb-4"><button className="btn" onClick={() => copy.mutate()}>Copy previous day's windows</button></div>}</div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 stagger">
          {(sessions.data ?? []).map((s: any, i: number) => {
            const cap = s.effectiveCapacity; const pct = cap ? Math.min(100, Math.round((s.allocated / cap) * 100)) : 100;
            const tone = s.free <= 0 ? 'rose' : s.free <= 2 ? 'amber' : 'sage';
            return (
              <button key={s.id} style={{ ['--i' as any]: i }} onClick={() => setSel(s)} className={`card card-hover text-left ${sel?.id === s.id ? '!border-clay ring-4 ring-clay/15' : ''}`}>
                <div className="flex items-start justify-between"><div className="serif text-lg whitespace-nowrap">{s.startTime}<span className="text-muted text-sm"> – {s.endTime}</span></div><Chip tone={tone as any}>{s.allocated}/{cap}{cap !== s.capacity && <span className="opacity-60 line-through ml-1">{s.capacity}</span>}</Chip></div>
                {s.reductions?.length > 0 && <div className="text-[11px] text-amber mt-1 flex items-center gap-1"><Icon name="clock" className="h-3 w-3" />{s.reductions.map((r: any) => `${r.note ?? r.kind} ${r.startTime}–${r.endTime}`).join(', ')}</div>}
                <div className="h-1.5 bg-paper-2 rounded-full mt-3 overflow-hidden"><div className={`h-full rounded-full transition-all duration-500 ${tone === 'rose' ? 'bg-rose' : tone === 'amber' ? 'bg-amber' : 'bg-sage'}`} style={{ width: pct + '%' }} /></div>
                <div className="text-xs text-muted mt-2 flex items-center gap-2"><span className="truncate">{cfg?.practitioners.find((p: any) => p.id === s.practitionerId)?.name ?? 'Any doctor'}</span>
                  {writable && <span className="ml-auto flex gap-0.5"><span role="button" className="btn btn-ghost btn-sm !px-2" onClick={(e) => { e.stopPropagation(); setCap.mutate({ id: s.id, capacity: Math.max(0, s.capacity - 1) }); }}>−</span><span role="button" className="btn btn-ghost btn-sm !px-2" onClick={(e) => { e.stopPropagation(); setCap.mutate({ id: s.id, capacity: s.capacity + 1 }); }}>+</span></span>}</div>
              </button>
            );
          })}
        </div>
      )}

      <div className="grid lg:grid-cols-2 gap-5 mt-5">
        {sel && writable ? <BookForm key={sel.id} session={sel} arriveEarly={cfg?.tenant.settings.scheduling?.arriveEarlyMinutes ?? 30} onDone={refresh} /> : <div className="card anim-fade-in border-dashed text-sm">
          <div className="serif text-lg mb-2">How booking works here</div>
          <ol className="space-y-2 text-ink-2">
            <li className="flex gap-3"><span className="chip chip-clay shrink-0">1</span><span>Each card is an <b>OP window</b>: one hour of the doctor's time with a practical capacity (for example 7 patients). It is not an exact appointment time.</span></li>
            <li className="flex gap-3"><span className="chip chip-clay shrink-0">2</span><span>When a patient calls, <b>click a window with free places</b>, type their phone or name, and press Book. Only name and phone are needed on the call.</span></li>
            <li className="flex gap-3"><span className="chip chip-clay shrink-0">3</span><span>Tell them the <b>arrive-by time</b> shown (35 minutes before the window) and that the wait can be 30–45 minutes.</span></li>
            <li className="flex gap-3"><span className="chip chip-clay shrink-0">4</span><span>When they walk in, they appear on the <b>Queue page</b> under “Booked, not arrived”. Press Arrived there to register, take the fee and add them to the live queue.</span></li>
          </ol>
          <div className="text-xs text-muted mt-3">Use − / + on a card to change today's capacity when the doctor has a procedure or a break. “+ Window” adds a block; on an empty day “Copy previous day” reuses yesterday's plan.</div>
        </div>}
        <Section title={<>Appointments <span className="text-muted font-normal">· {(appts.data ?? []).filter((a: any) => a.status !== 'cancelled').length}</span></>} delay={120}>
          {appts.isLoading ? <Skeleton /> : (appts.data ?? []).length === 0 ? <Empty icon="calendar" title="No bookings yet" /> : (appts.data ?? []).map((a: any, i: number) => (
            <div key={a.id} className={`row anim-fade-up ${a.status === 'cancelled' ? 'opacity-50' : ''}`} style={{ animationDelay: `${Math.min(i, 10) * 25}ms` }}>
              <span className="text-xs font-mono text-muted w-11">{a.window.startTime}</span>
              <Avatar name={a.patient.fullName} size="h-8 w-8 text-[10px]" />
              <div className="min-w-0 flex-1"><div className={`text-sm font-medium truncate ${a.status === 'cancelled' ? 'line-through' : ''}`}>{a.patient.fullName}</div><div className="text-xs text-muted">{a.patient.phone ?? ''}{a.note ? ` · ${a.note}` : ''}</div></div>
              {a.overbooked && <Chip tone="amber">overbooked</Chip>}
              <Chip tone={a.status === 'arrived' ? 'sage' : a.status === 'cancelled' ? 'rose' : ''}>{a.status}</Chip>
              {a.status === 'booked' && writable && <button className="btn btn-ghost btn-icon" title="Cancel" onClick={() => cancel.mutate(a.id)}><Icon name="x" className="h-3.5 w-3.5" /></button>}
            </div>))}
        </Section>
      </div>
    </div>
  );
}

function BookForm({ session, arriveEarly, onDone }: { session: any; arriveEarly: number; onDone: () => void }) {
  const [q, setQ] = useState(''); const [patientId, setPatientId] = useState<string | undefined>(); const [name, setName] = useState(''); const [note, setNote] = useState('');
  const [err, setErr] = useState<any>(null);
  const search = useQuery({ queryKey: ['patients', q], queryFn: () => get(`/patients?q=${encodeURIComponent(q)}`), enabled: q.length >= 3 && !patientId });
  const book = useMutation({
    mutationFn: (overbook: boolean) => post('/appointments', { sessionId: session.id, patientId, newPatient: patientId ? undefined : { fullName: name, phone: /^\d{10}$/.test(q) ? q : undefined }, note, overbook, idempotencyKey: uuid() }),
    onSuccess: (r: any) => { toast(`Booked ${r.window.startTime}–${r.window.endTime} · arrive by ${minus(r.window.startTime, r.arriveEarlyMinutes)}`); setErr(null); setQ(''); setName(''); setNote(''); setPatientId(undefined); onDone(); },
    onError: (e: any) => setErr(e instanceof ApiError ? e.body : { code: e.message }),
  });
  const arriveBy = minus(session.startTime, arriveEarly);
  return (
    <div className="card anim-slide-in space-y-3 !border-clay/30">
      <div className="flex items-baseline gap-2"><div className="serif text-xl">Book {session.startTime}–{session.endTime}</div><Chip tone="clay">{session.free} free</Chip></div>
      <div className="text-xs text-muted bg-paper rounded-xl p-3 flex gap-2"><Icon name="phone" className="h-4 w-4 shrink-0 text-clay" /><span>Tell the caller: <b className="text-ink">arrive by {arriveBy}</b>, the wait can be 30–45 minutes. No exact time is promised.</span></div>
      <div className="relative"><Icon name="search" className="h-4 w-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" /><input autoFocus className="input !pl-10" placeholder="Phone number or name" value={q} onChange={(e) => { setQ(e.target.value); setPatientId(undefined); }} /></div>
      {!patientId && (search.data ?? []).length > 0 && <div className="card-flat overflow-hidden max-h-44 overflow-y-auto anim-fade-up">{search.data.map((p: any) => <button key={p.id} className="row w-full text-left" onClick={() => { setPatientId(p.id); setName(p.fullName); }}><Avatar name={p.fullName} size="h-7 w-7 text-[10px]" /><span className="flex-1 text-sm">{p.fullName} <span className="text-muted text-xs">{p.phone} · {p.patientNo}</span></span><Icon name="chevR" className="text-muted h-4 w-4" /></button>)}</div>}
      {patientId ? <div className="flex items-center gap-2 text-sm bg-sage-soft text-sage rounded-xl px-3 py-2 anim-fade-in"><Icon name="check" className="h-4 w-4" />Booking for <b>{name}</b><button className="btn btn-ghost btn-sm ml-auto" onClick={() => setPatientId(undefined)}>change</button></div>
        : <input className="input" placeholder="New caller: name (we only need name and phone on the call)" value={name} onChange={(e) => setName(e.target.value)} />}
      <input className="input" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="flex gap-2 items-center"><button className="btn btn-primary" disabled={book.isPending || (!patientId && !name)} onClick={() => book.mutate(false)}><Icon name="check" />Book</button>
        {err?.code === 'WINDOW_FULL' && <button className="btn anim-fade-in" onClick={() => book.mutate(true)}>Overbook anyway</button>}</div>
      {err && <div className="text-xs text-rose anim-fade-in">{err.code === 'WINDOW_FULL' ? <>This window is full. Free windows: {err.alternatives.map((a: any) => `${a.startTime} (${a.capacity - a.allocated})`).join(', ') || 'none today'}.</> : JSON.stringify(err)}</div>}
    </div>
  );
}

function AddWindow({ onAdd, practitioners }: { onAdd: (w: any) => void; practitioners: any[] }) {
  const [open, setOpen] = useState(false); const [w, setW] = useState({ startTime: '10:00', endTime: '11:00', capacity: 7, practitionerId: practitioners[0]?.id ?? null });
  if (!open) return <button className="btn" onClick={() => setOpen(true)}><Icon name="plus" />Window</button>;
  return (
    <div className="card !p-2 !rounded-full flex items-center gap-1 text-sm anim-scale-in">
      <input type="time" className="input !w-auto !py-1.5" value={w.startTime} onChange={(e) => setW({ ...w, startTime: e.target.value })} /><span className="text-muted">–</span>
      <input type="time" className="input !w-auto !py-1.5" value={w.endTime} onChange={(e) => setW({ ...w, endTime: e.target.value })} />
      <input type="number" className="input !w-16 !py-1.5" value={w.capacity} onChange={(e) => setW({ ...w, capacity: Number(e.target.value) })} />
      <select className="input !w-auto !py-1.5" value={w.practitionerId ?? ''} onChange={(e) => setW({ ...w, practitionerId: e.target.value || null })}><option value="">Any</option>{practitioners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
      <button className="btn btn-sm btn-primary" onClick={() => { onAdd(w); setOpen(false); }}>Add</button><button className="btn btn-ghost btn-icon" onClick={() => setOpen(false)}><Icon name="x" /></button>
    </div>
  );
}

const shift = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const minus = (hhmm: string, min: number) => { const [h, m] = hhmm.split(':').map(Number); const t = h * 60 + m - min; return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };
