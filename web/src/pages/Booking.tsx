import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { get, post, today, uuid, ApiError, errText, useConfig } from '../api';
import { Avatar, Chip, Empty, Icon, Modal, Skeleton, toast, NumInput } from '../ui';

const shift = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const dayLabel = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });

/**
 * "New booking" from anywhere (sidebar pages open it with ?book=1): pick doctor, day and window, then the patient.
 * It replaces the old Quick book page; clicking a window on the Calendar opens the same form directly.
 */
export function NewBooking({ cfg, me, initialPatient, onClose, onDone }: { cfg: any; me: any; initialPatient?: { id: string; name: string }; onClose: () => void; onDone: () => void }) {
  const docs: any[] = cfg?.practitioners ?? [];
  const [doc, setDoc] = useState<string>(me?.practitionerId ?? docs[0]?.id ?? '');
  const [day, setDay] = useState(today());
  const [win, setWin] = useState<any>(null);
  const ws = useQuery({ queryKey: ['sessions', day, doc], queryFn: () => get(`/sessions?day=${day}${doc ? `&practitionerId=${doc}` : ''}`), enabled: !!day });
  const now = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  const windows: any[] = (ws.data ?? []).filter((w: any) => day > today() || w.endTime > now);
  const pickDay = (d: string) => { if (d && d >= today()) { setDay(d); setWin(null); } };
  return (
    <Modal title="New booking" subtitle={initialPatient ? `For ${initialPatient.name}` : 'Doctor, day and window, then the patient'} onClose={onClose} width="max-w-xl">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          {docs.length > 1 && <select aria-label="Doctor" className="input !w-auto" value={doc} onChange={(e) => { setDoc(e.target.value); setWin(null); }}>{docs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}
          <div className="flex items-center gap-1 card !p-1 !rounded-full">
            <button className="btn btn-ghost btn-icon" aria-label="Previous day" disabled={day <= today()} onClick={() => pickDay(shift(day, -1))}><Icon name="chevL" /></button>
            <input type="date" aria-label="Day" min={today()} className="input !w-auto !border-0 !shadow-none !py-1.5 text-center" value={day} onChange={(e) => pickDay(e.target.value)} />
            <button className="btn btn-ghost btn-icon" aria-label="Next day" onClick={() => pickDay(shift(day, 1))}><Icon name="chevR" /></button>
          </div>
          <span className="text-sm text-muted">{dayLabel(day)}</span>
        </div>
        {ws.isLoading ? <Skeleton rows={2} /> : windows.length === 0 ? <Empty icon="calendar" title="No windows left this day" hint="Try the next day, or another doctor." /> : (
          <div role="radiogroup" aria-label="Window" className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {windows.map((w) => {
              const tone = w.free <= 0 ? 'rose' : w.free <= 2 ? 'amber' : 'sage';
              return (
                <button key={w.id} role="radio" aria-checked={win?.id === w.id} onClick={() => setWin(w)} className={`rounded-2xl border px-2 py-2.5 text-left transition-shadow ${win?.id === w.id ? 'border-ink bg-white ring-1 ring-ink' : 'border-white/90 bg-white/70 hover:bg-white'} ${w.effectiveCapacity === 0 ? 'opacity-50' : ''}`}>
                  <div className="font-semibold">{w.startTime}</div>
                  <Chip tone={tone as any} className="mt-1 !text-[10.5px]">{w.free > 0 ? `${w.free} free` : 'full'}</Chip>
                </button>
              );
            })}
          </div>
        )}
        {win && <BookForm key={win.id + (initialPatient?.id ?? '')} session={win} initialPatient={initialPatient} arriveEarly={cfg?.tenant.settings.scheduling?.arriveEarlyMinutes ?? 35} onDone={onDone} />}
      </div>
    </Modal>
  );
}

export function BookForm({ session, arriveEarly, onDone, initialPatient }: { session: any; arriveEarly: number; onDone: () => void; initialPatient?: { id: string; name: string } }) {
  const cfg = useConfig().data;
  const services: any[] = (cfg?.services ?? []).filter((s: any) => !s.practitionerIds?.length || !session.practitionerId || s.practitionerIds.includes(session.practitionerId));
  const [q, setQ] = useState(''); const [patientId, setPatientId] = useState<string | undefined>(initialPatient?.id); const [name, setName] = useState(initialPatient?.name ?? ''); const [phone, setPhone] = useState(''); const [note, setNote] = useState('');
  const [serviceId, setServiceId] = useState<string>(''); const svcId = serviceId || services[0]?.id || '';
  const [repeat, setRepeat] = useState(false); const [everyWeeks, setEveryWeeks] = useState(2); const [count, setCount] = useState<number | string>(4);
  const [notify, setNotify] = useState(true);
  const [err, setErr] = useState<any>(null);
  const search = useQuery({ queryKey: ['patients', q], queryFn: () => get(`/patients?q=${encodeURIComponent(q)}`), enabled: q.length >= 3 && !patientId });
  const typedPhone = /^\d{10}$/.test(q) ? q : '';
  const newPhone = typedPhone || phone;
  const countN = Number(count);
  const repeatBad = repeat && (!Number.isInteger(countN) || countN < 2 || countN > 26);
  const phoneBad = !patientId && phone !== '' && !/^\d{10}$/.test(phone);
  const book = useMutation({
    mutationFn: (overbook: boolean) => post('/appointments', { sessionId: session.id, patientId, newPatient: patientId ? undefined : { fullName: name.trim(), phone: newPhone || undefined }, serviceId: svcId || undefined, note: note.trim() || undefined,
      repeat: repeat ? { everyWeeks, count: countN } : undefined, notify, overbook, idempotencyKey: uuid() }),
    onSuccess: (r: any) => {
      const extra = r.series ? ` · ${r.series.created.length} repeat${r.series.created.length === 1 ? '' : 's'} booked${r.series.skipped.length ? `, ${r.series.skipped.length} skipped (${r.series.skipped.map((s: any) => s.day.slice(5)).join(', ')})` : ''}` : '';
      toast(`Booked ${r.window.startTime}–${r.window.endTime} · arrive by ${minus(r.window.startTime, r.arriveEarlyMinutes)}${extra}`);
      setErr(null); setQ(''); setName(''); setPhone(''); setNote(''); setPatientId(undefined); setRepeat(false); onDone();
    },
    onError: (e: any) => setErr(e instanceof ApiError ? e.body : { code: e.message }),
  });
  const arriveBy = minus(session.startTime, arriveEarly);
  return (
    <div className="card anim-slide-in space-y-3 !border-clay/30">
      <div className="flex items-baseline gap-2"><div className="serif text-xl">Book {session.startTime}–{session.endTime}</div><Chip tone="clay">{session.free} free</Chip></div>
      <div className="text-xs text-muted bg-paper rounded-xl p-3 flex gap-2"><Icon name="phone" className="h-4 w-4 shrink-0 text-clay" /><span>Tell the caller: <b className="text-ink">arrive by {arriveBy}</b>, the wait can be 30–45 minutes. No exact time is promised.</span></div>
      {services.length > 0 && (
        <div role="radiogroup" aria-label="Visit type" className="flex flex-wrap gap-1.5">
          {services.map((s) => <button key={s.id} type="button" role="radio" aria-checked={svcId === s.id} onClick={() => setServiceId(s.id)} className={`toggle-opt inline-flex items-center gap-1.5 ${svcId === s.id ? 'on' : ''}`}><i className="h-2.5 w-2.5 rounded-[3px]" style={{ background: s.color }} />{s.name}</button>)}
        </div>
      )}
      <div className="relative"><Icon name="search" className="h-4 w-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" /><input autoFocus aria-label="Phone number or name" className="input !pl-10" maxLength={60} placeholder="Phone number or name" value={q} onChange={(e) => { setQ(e.target.value); setPatientId(undefined); }} /></div>
      {!patientId && (search.data ?? []).length > 0 && <div className="card-flat overflow-hidden max-h-44 overflow-y-auto anim-fade-up">{search.data.map((p: any) => <button key={p.id} className="row w-full text-left" onClick={() => { setPatientId(p.id); setName(p.fullName); }}><Avatar name={p.fullName} size="h-7 w-7 text-[10px]" /><span className="flex-1 text-sm">{p.fullName} <span className="text-muted text-xs">{p.phone} · {p.patientNo}</span></span><Icon name="chevR" className="text-muted h-4 w-4" /></button>)}</div>}
      {patientId ? <div className="flex items-center gap-2 text-sm bg-sage-soft text-sage rounded-xl px-3 py-2 anim-fade-in"><Icon name="check" className="h-4 w-4" />Booking for <b>{name}</b><button className="btn btn-ghost btn-sm ml-auto" onClick={() => setPatientId(undefined)}>change</button></div>
        : <div className="grid gap-2 sm:grid-cols-[1fr_160px]">
            <input aria-label="New caller name" className="input" maxLength={100} placeholder="New caller: name" value={name} onChange={(e) => setName(e.target.value)} />
            {typedPhone ? <div className="input !bg-paper text-muted">{typedPhone}</div>
              : <input aria-label="New caller phone" inputMode="numeric" className={`input ${phoneBad ? '!border-rose' : ''}`} maxLength={10} placeholder="Mobile (10 digits)" value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))} />}
          </div>}
      {phoneBad && <div className="text-xs text-rose -mt-1">Mobile must be 10 digits.</div>}
      <input aria-label="Note" className="input" maxLength={500} placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} /><Icon name="repeat" className="h-3.5 w-3.5" />Repeat</label>
        {repeat && <span className="flex items-center gap-1.5 anim-fade-in">every<select aria-label="Repeat every" className="input !w-auto !py-1.5" value={everyWeeks} onChange={(e) => setEveryWeeks(Number(e.target.value))}>{[1, 2, 3, 4, 6, 8, 12].map((w) => <option key={w} value={w}>{w === 1 ? 'week' : `${w} weeks`}</option>)}</select>×<NumInput aria-label="Number of visits" max={26} className={`input !w-16 !py-1.5 ${repeatBad ? '!border-rose' : ''}`} value={count} onChange={(e) => setCount(e.target.value)} />visits</span>}
        <label className="flex items-center gap-2"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />Send confirmation</label>
      </div>
      {repeatBad && <div className="text-xs text-rose -mt-1">Repeat between 2 and 26 visits.</div>}
      <div className="flex gap-2 items-center"><button className="btn btn-primary" disabled={book.isPending || (!patientId && name.trim().length < 2) || phoneBad || repeatBad} onClick={() => book.mutate(false)}><Icon name="check" />Book</button>
        {err?.code === 'WINDOW_FULL' && <button className="btn anim-fade-in" onClick={() => book.mutate(true)}>Overbook anyway</button>}</div>
      {err && <div className="text-xs text-rose anim-fade-in">{err.code === 'WINDOW_FULL' ? <>This window is full. Free windows: {err.alternatives.map((a: any) => `${a.startTime} (${a.free})`).join(', ') || 'none today'}.</> : errText({ body: err })}</div>}
    </div>
  );
}


const minus = (hhmm: string, min: number) => { const [h, m] = hhmm.split(':').map(Number); const t = h * 60 + m - min; return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };
