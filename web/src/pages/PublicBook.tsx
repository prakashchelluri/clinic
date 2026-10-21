import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router';
import { get, post, errText } from '../api';
import { Icon, Skeleton, money } from '../ui';

const addDays = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const dow = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', timeZone: 'UTC' });
const dnum = (d: string) => new Date(d + 'T00:00:00Z').getUTCDate();
const nice = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const minus = (t: string, m: number) => { const [h, mm] = t.split(':').map(Number); const x = h * 60 + mm - m; return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };

export function PublicShell({ name, children }: { name?: string; children: React.ReactNode }) {
  return (
    <div className="min-h-dvh px-4 py-6 sm:py-10">
      <div className="mx-auto max-w-[480px] space-y-4">
        <div className="flex items-center gap-3"><span className="grid h-11 w-11 place-items-center rounded-xl bg-ink text-lg font-bold text-white">{(name ?? '·').slice(0, 1)}</span><div className="text-lg font-semibold leading-tight">{name ?? ' '}</div></div>
        {children}
        <div className="pt-4 text-center text-[11px] text-muted">Powered by CUBOTT Clinical</div>
      </div>
    </div>
  );
}

/** Patient-facing booking page: visit type → doctor → day and window → name and phone. No sign-in. */
export function PublicBook() {
  const { slug = '' } = useParams(); const nav = useNavigate();
  const clinic = useQuery({ queryKey: ['public', slug], queryFn: () => get(`/public/clinic/${slug}`), retry: false });
  const c = clinic.data;
  const [svc, setSvc] = useState(''); const [doc, setDoc] = useState(''); const [from, setFrom] = useState(''); const [day, setDay] = useState(''); const [slot, setSlot] = useState<any>(null);
  const [name, setName] = useState(''); const [phone, setPhone] = useState(''); const [note, setNote] = useState(''); const [website, setWebsite] = useState(''); const [touched, setTouched] = useState(false);
  useEffect(() => { if (c && !svc && c.services[0]) setSvc(c.services[0].id); if (c && !from) setFrom(c.today); }, [c]);
  const service = c?.services.find((s: any) => s.id === svc);
  const doctors = (c?.doctors ?? []).filter((d: any) => !service?.practitionerIds?.length || service.practitionerIds.includes(d.id));
  const slots = useQuery({ queryKey: ['public', slug, 'slots', svc, doc, from], queryFn: () => get(`/public/clinic/${slug}/slots?from=${from}&days=7&serviceId=${svc}${doc ? `&practitionerId=${doc}` : ''}`), enabled: !!c?.enabled && !!svc && !!from });
  const days: any[] = slots.data ?? [];
  useEffect(() => { if (days.length && !days.some((d) => d.day === day)) { setDay(days.find((d) => d.slots.length)?.day ?? days[0].day); setSlot(null); } }, [slots.data]);
  const daySlots: any[] = days.find((d) => d.day === day)?.slots ?? [];
  const nameBad = name.trim().length < 2; const phoneBad = !/^\d{10}$/.test(phone);
  const book = useMutation({ mutationFn: () => post(`/public/clinic/${slug}/book`, { sessionId: slot.id, serviceId: svc, name: name.trim(), phone, note: note.trim() || undefined, website: website || undefined }),
    onSuccess: (r: any) => nav(r.link + '?new=1') });

  if (clinic.isLoading) return <PublicShell><div className="card"><Skeleton rows={6} /></div></PublicShell>;
  if (clinic.isError) return <PublicShell><div className="card text-center"><div className="text-lg font-semibold">Clinic not found</div><div className="mt-1 text-sm text-muted">Please check the link you were sent.</div></div></PublicShell>;
  if (!c.enabled) return <PublicShell name={c.name}><div className="card text-center"><div className="text-lg font-semibold">Online booking is closed</div><div className="mt-1 text-sm text-muted">Please call the clinic{c.phone ? ` on ${c.phone}` : ''} to book.</div>{c.phone && <a className="btn btn-primary mt-4" href={`tel:${c.phone}`}><Icon name="phone" />Call</a>}</div></PublicShell>;
  if (!c.services.length) return <PublicShell name={c.name}><div className="card text-center text-sm text-muted">No visits can be booked online right now. Please call the clinic.</div></PublicShell>;
  const maxFrom = addDays(c.today, Math.max(0, c.maxDaysAhead - 6));

  return (
    <PublicShell name={c.name}>
      {c.address && <div className="-mt-2 text-sm text-muted">{c.address}</div>}
      {c.intro && <div className="card !py-3 text-sm">{c.intro}</div>}
      <section className="space-y-2">
        <div className="label">1 · What for</div>
        <div role="radiogroup" aria-label="Visit type" className="space-y-1.5">{c.services.map((s: any) => (
          <button key={s.id} role="radio" aria-checked={svc === s.id} onClick={() => { setSvc(s.id); setDoc(''); setSlot(null); }} className={`flex w-full items-center gap-3 rounded-2xl border px-4 py-3 text-left transition-shadow ${svc === s.id ? 'border-ink bg-white ring-1 ring-ink' : 'border-white/90 bg-white/70'}`}>
            <i className="h-3 w-3 shrink-0 rounded" style={{ background: s.color }} /><span className="flex-1"><span className="font-medium">{s.name}</span>{s.description && <span className="block text-xs text-muted">{s.description}</span>}</span>{s.pricePaise != null && <b className="text-sm">{s.pricePaise === 0 ? 'Free' : money(s.pricePaise)}</b>}
          </button>))}</div>
      </section>
      {doctors.length > 1 && <section className="space-y-2">
        <div className="label">2 · Doctor</div>
        <div role="radiogroup" aria-label="Doctor" className="flex flex-wrap gap-1.5"><button role="radio" aria-checked={doc === ''} className={`toggle-opt ${doc === '' ? 'on' : ''}`} onClick={() => { setDoc(''); setSlot(null); }}>Any doctor</button>{doctors.map((d: any) => <button key={d.id} role="radio" aria-checked={doc === d.id} className={`toggle-opt ${doc === d.id ? 'on' : ''}`} onClick={() => { setDoc(d.id); setSlot(null); }}>{d.name}</button>)}</div>
      </section>}
      <section className="space-y-2">
        <div className="flex items-center"><div className="label !mb-0">{doctors.length > 1 ? 3 : 2} · Day and time</div>
          <span className="ml-auto flex gap-1"><button className="btn btn-ghost btn-icon" aria-label="Earlier days" disabled={from <= c.today} onClick={() => setFrom(addDays(from, -7) < c.today ? c.today : addDays(from, -7))}><Icon name="chevL" /></button><button className="btn btn-ghost btn-icon" aria-label="Later days" disabled={from >= maxFrom} onClick={() => setFrom(addDays(from, 7) > maxFrom ? maxFrom : addDays(from, 7))}><Icon name="chevR" /></button></span></div>
        {slots.isLoading ? <Skeleton rows={2} /> : slots.isError ? <div className="text-sm text-rose">{errText(slots.error)}</div> : (<>
          <div className="grid grid-cols-7 gap-1">{days.map((d) => <button key={d.day} disabled={!d.slots.length} onClick={() => { setDay(d.day); setSlot(null); }} className={`rounded-2xl py-2 text-center text-xs font-semibold ${d.day === day ? 'bg-ink text-white' : d.slots.length ? 'bg-white/70 text-ink-2' : 'text-muted/50'}`}>{dow(d.day)}<b className="block text-base">{dnum(d.day)}</b></button>)}</div>
          {daySlots.length === 0 ? <div className="text-sm text-muted">No free times this day. Try another day.</div> : (
            <div role="radiogroup" aria-label="Time" className="grid grid-cols-3 gap-2">{daySlots.map((s) => <button key={s.id} role="radio" aria-checked={slot?.id === s.id} onClick={() => setSlot(s)} className={`rounded-xl py-2.5 text-sm font-semibold ${slot?.id === s.id ? 'bg-clay text-white' : 'bg-white'}`}>{s.startTime}{!doc && s.doctor && doctors.length > 1 && <span className={`block text-[10.5px] font-normal ${slot?.id === s.id ? 'text-white/85' : 'text-muted'}`}>{s.doctor.replace(/ Doctor$/, '')}</span>}</button>)}</div>
          )}
          <div className="text-xs text-muted">Times are windows: please arrive {c.arriveEarlyMinutes} minutes early. The wait can be 30–45 minutes.</div>
        </>)}
      </section>
      <section className="space-y-2">
        <div className="label">{doctors.length > 1 ? 4 : 3} · Your details</div>
        <input aria-label="Full name" className={`input ${touched && nameBad ? '!border-rose' : ''}`} autoComplete="name" maxLength={100} placeholder="Full name" value={name} onChange={(e) => setName(e.target.value)} />
        <input aria-label="Mobile number" className={`input ${touched && phoneBad ? '!border-rose' : ''}`} inputMode="numeric" autoComplete="tel-national" maxLength={10} placeholder="Mobile number (10 digits)" value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))} />
        <input aria-label="Reason for visit" className="input" maxLength={300} placeholder="Reason for visit (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
        <input tabIndex={-1} aria-hidden autoComplete="off" className="absolute -left-[9999px] h-0 w-0 opacity-0" value={website} onChange={(e) => setWebsite(e.target.value)} name="website" />
        {touched && (nameBad || phoneBad) && <div className="text-xs text-rose">{nameBad ? 'Please enter your full name. ' : ''}{phoneBad ? 'Mobile number must be 10 digits.' : ''}</div>}
      </section>
      {book.isError && <div className="rounded-2xl bg-rose-soft px-4 py-3 text-sm text-rose">{errText(book.error)}</div>}
      <button className="btn btn-accent w-full justify-center !py-3.5 text-[15px]" disabled={!slot || book.isPending} onClick={() => { setTouched(true); if (!nameBad && !phoneBad) book.mutate(); }}>
        {slot ? `${c.requireApproval ? 'Request' : 'Book'} ${nice(day)}, ${slot.startTime}` : 'Pick a time'}
      </button>
      <div className="text-center text-xs text-muted">{c.requireApproval ? 'The clinic confirms your request on WhatsApp. ' : ''}{slot ? `Arrive by ${minus(slot.startTime, c.arriveEarlyMinutes)}. ` : ''}{c.cancelWindowHours ? `Cancel free until ${c.cancelWindowHours} hours before.` : ''}</div>
      {c.policy && <div className="text-center text-xs text-muted">{c.policy}</div>}
    </PublicShell>
  );
}
