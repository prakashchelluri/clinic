import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { get, patch, post, api, errText } from '../api';
import { Chip, Empty, Icon, Section, Skeleton, money, toast, NumInput, MoneyInput, toPaise } from '../ui';
import { RoutineEditor, DEFAULT_ROUTINE, routineSummary } from '../routine';

/* Scheduling settings: availability, visit types, booking rules, online booking, reminders. All data, no deploy. */

const COLORS = ['#D4421A', '#3A5A78', '#2F5D4B', '#8A6218', '#A3322A', '#6D5E86', '#17191A', '#B8340F'];
const KINDS: [string, string, string][] = [
  ['confirmation', 'Booking confirmation', 'Sent when a booking is made or a request approved'],
  ['requested', 'Online request received', 'Sent when a patient asks online and reception must approve'],
  ['reminder', 'Reminder', 'Sent the chosen hours before the window'],
  ['moved', 'Booking moved', 'Sent when reception moves a booking'],
  ['cancelled', 'Booking cancelled', 'Sent when reception cancels'],
  ['declined', 'Request declined', 'Sent when reception declines an online request'],
];
const VARS = ['patient', 'clinic', 'visitType', 'date', 'time', 'arriveBy', 'doctor', 'link', 'bookLink', 'reason'];
const SAMPLE: Record<string, string> = { patient: 'Lakshmi Devi', clinic: 'Your clinic', visitType: 'New consultation', date: 'Thu, 22 Oct', time: '11:00–12:00', arriveBy: '10:25', doctor: 'Dr. Main', link: 'https://…/a/…', bookLink: 'https://…/book/…', reason: 'Doctor on leave.' };
const fill = (t: string) => t.replace(/\{(\w+)\}/g, (m, k) => SAMPLE[k] ?? m);
const save = (settings: any) => patch('/admin/clinic', { settings });

const Toggle = ({ on, onChange, label, hint, id }: { on: boolean; onChange: (v: boolean) => void; label: string; hint?: string; id: string }) => (
  <label htmlFor={id} className="flex cursor-pointer items-start gap-3">
    <input id={id} type="checkbox" className="sr-only peer" checked={on} onChange={(e) => onChange(e.target.checked)} />
    <span aria-hidden className={`mt-0.5 relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors duration-300 peer-focus-visible:ring-2 peer-focus-visible:ring-clay ${on ? 'bg-ink' : 'bg-line-2'}`}><i className="absolute top-[3px] h-4 w-4 rounded-full bg-white transition-all duration-300" style={{ left: on ? 19 : 3 }} /></span>
    <span><span className="text-sm font-medium">{label}</span>{hint && <span className="block text-xs text-muted">{hint}</span>}</span>
  </label>
);
const intIn = (v: any, min: number, max: number) => { const n = Number(v); return v !== '' && Number.isInteger(n) && n >= min && n <= max; };

/* ---------------- Availability: each doctor's weekly routine ---------------- */
export function AvailabilityTab({ cfg, onSaved }: { cfg: any; onSaved: () => void }) {
  const [edit, setEdit] = useState<any>(null);
  const saveR = useMutation({ mutationFn: ({ id, routine }: any) => api('PUT', `/calendar/routine/${id}`, routine), onSuccess: () => { toast('Availability saved · future days follow it'); setEdit(null); onSaved(); }, onError: (e) => toast(errText(e), 'err') });
  return (
    <div className="space-y-4">
      <div className="text-sm text-muted">Set each doctor's week once. Every day's OP windows come from it. One-off changes (late, away, a break) are made on the Calendar.</div>
      {cfg.practitioners.map((p: any) => (
        <div key={p.id} className="card">
          <div className="flex items-center gap-3"><div className="flex-1"><div className="font-semibold">{p.name}</div><div className="text-sm text-muted">{routineSummary(p.routine)}{p.routine ? ` · ${p.routine.capacity} places per ${p.routine.windowMinutes} min` : ''}</div></div>
            {edit?.id !== p.id && <button className="btn btn-sm" onClick={() => setEdit({ id: p.id, routine: p.routine ?? DEFAULT_ROUTINE })}><Icon name="edit" className="h-3.5 w-3.5" />Edit</button>}</div>
          {edit?.id === p.id && (
            <div className="mt-4 space-y-3 anim-fade-up">
              <RoutineEditor value={edit.routine} onChange={(routine) => setEdit({ ...edit, routine })} />
              <div className="flex gap-2"><button className="btn btn-primary" disabled={saveR.isPending} onClick={() => saveR.mutate(edit)}><Icon name="check" />Save</button><button className="btn btn-ghost" onClick={() => setEdit(null)}>Cancel</button></div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/* ---------------- Visit types ---------------- */
export function ServicesTab({ cfg, onSaved }: { cfg: any; onSaved: () => void }) {
  const list = useQuery({ queryKey: ['admin-services'], queryFn: () => get('/admin/services') });
  const [edit, setEdit] = useState<any>(null);
  const refresh = () => { list.refetch(); onSaved(); };
  const items: any[] = list.data ?? [];
  const blank = { name: '', description: '', minutes: 60, price: '', feeCategoryId: '', color: COLORS[items.length % COLORS.length], bufferMinutes: 0, places: 1, practitionerIds: [], onlineBookable: false, sortOrder: items.length, active: true };
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
      <Section title={<>Visit types <span className="font-normal text-muted">· what patients book</span></>} aside={<button className="btn btn-sm btn-accent" onClick={() => setEdit(blank)}><Icon name="plus" className="h-3.5 w-3.5" />Visit type</button>}>
        {list.isLoading ? <div className="p-4"><Skeleton rows={3} /></div> : items.length === 0 ? <Empty icon="calendar" title="No visit types yet" hint="Add what patients come for: new consultation, review, procedure follow-up." /> : items.map((s) => (
          <button key={s.id} className={`row w-full text-left ${s.active ? '' : 'opacity-50'} ${edit?.id === s.id ? 'bg-white' : ''}`} onClick={() => setEdit({ ...s, price: s.pricePaise == null ? '' : String(s.pricePaise / 100), feeCategoryId: s.feeCategoryId ?? '', description: s.description ?? '' })}>
            <i className="h-3.5 w-3.5 shrink-0 rounded" style={{ background: s.color }} />
            <div className="min-w-0 flex-1"><div className="font-medium">{s.name}</div><div className="truncate text-xs text-muted">{s.minutes} min{s.pricePaise != null ? ` · ${money(s.pricePaise)}` : ''}{s.places > 1 ? ` · uses ${s.places} places` : ''} · {s.practitionerIds.length ? s.practitionerIds.map((id: string) => cfg.practitioners.find((p: any) => p.id === id)?.name ?? '?').join(', ') : 'all doctors'}</div></div>
            {!s.active ? <Chip tone="rose">archived</Chip> : s.onlineBookable ? <Chip tone="sage">online</Chip> : <Chip>staff only</Chip>}
          </button>
        ))}
      </Section>
      {edit ? <ServiceEditor key={edit.id ?? 'new'} value={edit} cfg={cfg} onDone={() => { setEdit(null); refresh(); }} onCancel={() => setEdit(null)} />
        : <div className="card border-dashed text-sm text-muted">Pick a visit type to edit it. Its colour marks bookings on the calendar; “online” ones appear on your booking page.</div>}
    </div>
  );
}
function ServiceEditor({ value, cfg, onDone, onCancel }: { value: any; cfg: any; onDone: () => void; onCancel: () => void }) {
  const [f, setF] = useState(value);
  const set = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }));
  const nameBad = f.name.trim().length < 1 || f.name.length > 100;
  const minBad = !intIn(f.minutes, 5, 480); const bufBad = !intIn(f.bufferMinutes, 0, 240); const placesBad = !intIn(f.places, 1, 10);
  const priceBad = f.price !== '' && !(Number(f.price) >= 0 && Number(f.price) <= 1000000);
  const bad = nameBad || minBad || bufBad || placesBad || priceBad;
  const m = useMutation({
    mutationFn: () => { const body = { name: f.name.trim(), description: f.description.trim() || null, minutes: Number(f.minutes), pricePaise: f.price === '' ? null : toPaise(f.price), feeCategoryId: f.feeCategoryId || null, color: f.color, bufferMinutes: Number(f.bufferMinutes), places: Number(f.places), practitionerIds: f.practitionerIds, onlineBookable: f.onlineBookable, sortOrder: Number(f.sortOrder) || 0, active: f.active };
      return f.id ? patch(`/admin/services/${f.id}`, body) : post('/admin/services', body); },
    onSuccess: () => { toast(f.id ? 'Visit type saved' : 'Visit type added'); onDone(); }, onError: (e) => toast(errText(e), 'err'),
  });
  const toggleDoc = (id: string) => setF((p: any) => ({ ...p, practitionerIds: p.practitionerIds.includes(id) ? p.practitionerIds.filter((x: string) => x !== id) : [...p.practitionerIds, id] }));
  return (
    <div className="card space-y-3 anim-slide-in">
      <div className="flex items-center gap-2"><i className="h-4 w-4 rounded" style={{ background: f.color }} /><b className="text-lg">{f.id ? f.name || 'Visit type' : 'New visit type'}</b></div>
      <div><label className="label" htmlFor="sv-name">Name</label><input id="sv-name" className={`input ${nameBad && f.name !== '' ? '!border-rose' : ''}`} maxLength={100} value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Hair consultation" /></div>
      <div className="grid grid-cols-3 gap-2">
        <div><label className="label" htmlFor="sv-min">Minutes</label><NumInput id="sv-min" max={480} className={`input ${minBad ? '!border-rose' : ''}`} value={f.minutes} onChange={(e) => set('minutes', e.target.value)} /></div>
        <div><label className="label" htmlFor="sv-price">Fee (₹)</label><MoneyInput id="sv-price" value={f.price} onChange={(v) => set('price', v)} placeholder="—" /></div>
        <div><label className="label" htmlFor="sv-places">Places used</label><NumInput id="sv-places" max={10} className={`input ${placesBad ? '!border-rose' : ''}`} value={f.places} onChange={(e) => set('places', e.target.value)} /></div>
      </div>
      {(minBad || placesBad || priceBad || bufBad) && <div className="text-xs text-rose">{minBad ? 'Minutes: 5 to 480. ' : ''}{placesBad ? 'Places: 1 to 10. ' : ''}{priceBad ? 'Fee looks wrong. ' : ''}{bufBad ? 'Buffer: 0 to 240 minutes.' : ''}</div>}
      <div className="grid grid-cols-2 gap-2">
        <div><label className="label" htmlFor="sv-buf">Buffer after (min)</label><NumInput id="sv-buf" max={240} className={`input ${bufBad ? '!border-rose' : ''}`} value={f.bufferMinutes} onChange={(e) => set('bufferMinutes', e.target.value)} /></div>
        <div><label className="label" htmlFor="sv-fee">Fee at check-in</label><select id="sv-fee" className="input" value={f.feeCategoryId} onChange={(e) => set('feeCategoryId', e.target.value)}><option value="">Decide at check-in</option>{cfg.feeCategories.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
      </div>
      <div><span className="label">Colour</span><div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Colour">{COLORS.map((c) => <button key={c} type="button" role="radio" aria-checked={f.color === c} aria-label={c} onClick={() => set('color', c)} className="h-7 w-7 rounded-full transition-shadow" style={{ background: c, boxShadow: f.color === c ? '0 0 0 2px #fff, 0 0 0 4px var(--color-ink)' : undefined }} />)}</div></div>
      <div><span className="label">Doctors</span><div className="flex flex-wrap gap-1.5"><button type="button" className={`toggle-opt ${f.practitionerIds.length === 0 ? 'on' : ''}`} onClick={() => set('practitionerIds', [])}>All doctors</button>{cfg.practitioners.map((p: any) => <button key={p.id} type="button" className={`toggle-opt ${f.practitionerIds.includes(p.id) ? 'on' : ''}`} onClick={() => toggleDoc(p.id)}>{p.name}</button>)}</div></div>
      <Toggle id="sv-online" on={f.onlineBookable} onChange={(v) => set('onlineBookable', v)} label="Patients can book this online" hint="Shown on your booking page when online booking is on" />
      <div><label className="label" htmlFor="sv-desc">Shown to patients (optional)</label><textarea id="sv-desc" className="input min-h-[64px]" maxLength={300} value={f.description} onChange={(e) => set('description', e.target.value)} placeholder="e.g. Follow-up within 15 days of your first visit" /></div>
      <div className="flex flex-wrap gap-2 pt-1">
        <button className="btn btn-primary" disabled={bad || m.isPending} onClick={() => m.mutate()}><Icon name="check" />Save</button>
        {f.id && <button className="btn" onClick={() => { setF({ ...f, active: !f.active }); }}>{f.active ? 'Archive' : 'Restore'}</button>}
        <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
      {f.id && !f.active && <div className="text-xs text-muted">Archived visit types stay on old bookings but cannot be picked. Press Save to apply.</div>}
    </div>
  );
}

/* ---------------- Booking rules ---------------- */
export function BookingRulesTab({ cfg, onSaved }: { cfg: any; onSaved: () => void }) {
  const s = cfg.tenant.settings ?? {};
  const [f, setF] = useState({ arriveEarlyMinutes: s.scheduling?.arriveEarlyMinutes ?? 35, defaultCapacity: s.scheduling?.defaultCapacity ?? 7, windowMinutes: s.scheduling?.windowMinutes ?? 60,
    cancelWindowHours: s.booking?.cancelWindowHours ?? 4, patientCanReschedule: s.booking?.patientCanReschedule ?? true, cancellationPolicy: s.booking?.cancellationPolicy ?? '', noShowWarnAt: s.booking?.noShowWarnAt ?? 2 });
  const set = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }));
  const bad = { arrive: !intIn(f.arriveEarlyMinutes, 0, 240), cap: !intIn(f.defaultCapacity, 1, 99), cancel: !intIn(f.cancelWindowHours, 0, 168), warn: !intIn(f.noShowWarnAt, 1, 20) };
  const m = useMutation({ mutationFn: () => save({ scheduling: { arriveEarlyMinutes: Number(f.arriveEarlyMinutes), defaultCapacity: Number(f.defaultCapacity), windowMinutes: Number(f.windowMinutes) },
    booking: { cancelWindowHours: Number(f.cancelWindowHours), patientCanReschedule: f.patientCanReschedule, cancellationPolicy: f.cancellationPolicy.trim(), noShowWarnAt: Number(f.noShowWarnAt) } }),
    onSuccess: () => { toast('Booking rules saved'); onSaved(); }, onError: (e) => toast(errText(e), 'err') });
  return (
    <div className="space-y-4">
      <div className="card space-y-3">
        <div className="text-[11px] uppercase tracking-wider text-muted">Windows</div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div><label className="label" htmlFor="br-arrive">Arrive early (minutes)</label><NumInput id="br-arrive" max={240} className={`input ${bad.arrive ? '!border-rose' : ''}`} value={f.arriveEarlyMinutes} onChange={(e) => set('arriveEarlyMinutes', e.target.value)} /></div>
          <div><label className="label" htmlFor="br-cap">Places per window (new doctors)</label><NumInput id="br-cap" max={99} className={`input ${bad.cap ? '!border-rose' : ''}`} value={f.defaultCapacity} onChange={(e) => set('defaultCapacity', e.target.value)} /></div>
          <div><span className="label">Window length</span><div className="flex gap-1">{[30, 60].map((mm) => <button key={mm} type="button" className={`toggle-opt ${Number(f.windowMinutes) === mm ? 'on' : ''}`} onClick={() => set('windowMinutes', mm)}>{mm} min</button>)}</div></div>
        </div>
        <div className="text-xs text-muted">Patients are told to arrive this many minutes before their window. Each doctor's own places per window are set under Availability.</div>
      </div>
      <div className="card space-y-3">
        <div className="text-[11px] uppercase tracking-wider text-muted">Cancelling and changing</div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div><label className="label" htmlFor="br-cancel">Patients can cancel or move until (hours before)</label><NumInput id="br-cancel" max={168} className={`input ${bad.cancel ? '!border-rose' : ''}`} value={f.cancelWindowHours} onChange={(e) => set('cancelWindowHours', e.target.value)} /></div>
          <div><label className="label" htmlFor="br-warn">Warn after this many no-shows</label><NumInput id="br-warn" max={20} className={`input ${bad.warn ? '!border-rose' : ''}`} value={f.noShowWarnAt} onChange={(e) => set('noShowWarnAt', e.target.value)} /></div>
        </div>
        <Toggle id="br-resched" on={f.patientCanReschedule} onChange={(v) => set('patientCanReschedule', v)} label="Patients can pick a new time from their link" hint="Otherwise they can only confirm or cancel" />
        <div><label className="label" htmlFor="br-policy">Cancellation policy shown to patients</label><textarea id="br-policy" className="input min-h-[72px]" maxLength={500} value={f.cancellationPolicy} onChange={(e) => set('cancellationPolicy', e.target.value)} placeholder="e.g. Please cancel at least 4 hours before so another patient can use your place." /><div className="mt-1 text-right text-[11px] text-muted">{f.cancellationPolicy.length}/500</div></div>
      </div>
      {Object.values(bad).some(Boolean) && <div className="text-sm text-rose">Check the boxes outlined in red: arrive early 0–240, places 1–99, cancel window 0–168 hours, no-show warning 1–20.</div>}
      <div className="flex justify-end"><button className="btn btn-primary" disabled={m.isPending || Object.values(bad).some(Boolean)} onClick={() => m.mutate()}><Icon name="check" />Save</button></div>
    </div>
  );
}

/* ---------------- Online booking ---------------- */
export function OnlineBookingTab({ cfg, onSaved }: { cfg: any; onSaved: () => void }) {
  const o = cfg.tenant.settings?.online ?? {};
  const [f, setF] = useState({ enabled: o.enabled ?? false, requireApproval: o.requireApproval ?? true, minNoticeHours: o.minNoticeHours ?? 2, maxDaysAhead: o.maxDaysAhead ?? 30, dailyCap: o.dailyCap ?? 0, intro: o.intro ?? '' });
  const set = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }));
  const link = `${location.origin}/book/${cfg.tenant.slug}`;
  const online = (cfg.services ?? []).filter((s: any) => s.onlineBookable);
  const bad = { notice: !intIn(f.minNoticeHours, 0, 336), ahead: !intIn(f.maxDaysAhead, 1, 180), cap: !intIn(f.dailyCap, 0, 500) };
  const m = useMutation({ mutationFn: () => save({ online: { enabled: f.enabled, requireApproval: f.requireApproval, minNoticeHours: Number(f.minNoticeHours), maxDaysAhead: Number(f.maxDaysAhead), dailyCap: Number(f.dailyCap), intro: f.intro.trim() } }),
    onSuccess: () => { toast(f.enabled ? 'Online booking is on' : 'Online booking saved (off)'); onSaved(); }, onError: (e) => toast(errText(e), 'err') });
  return (
    <div className="space-y-4">
      <div className="card space-y-3">
        <Toggle id="ob-on" on={f.enabled} onChange={(v) => set('enabled', v)} label="Let patients book online" hint="Patients pick a visit type, a doctor and a free window from your booking page" />
        <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-paper px-3 py-2.5 text-sm"><Icon name="globe" className="h-4 w-4 text-muted" /><span className="min-w-0 flex-1 truncate font-mono text-xs">{link}</span>
          <button className="btn btn-sm" onClick={() => navigator.clipboard?.writeText(link).then(() => toast('Link copied'), () => toast(link, 'info'))}><Icon name="copy" className="h-3.5 w-3.5" />Copy</button>
          <a className="btn btn-sm" href={link} target="_blank" rel="noreferrer">Open</a></div>
        <div className="text-xs text-muted">Share it on WhatsApp, Google Maps and your clinic board. {online.length ? `${online.length} visit type${online.length === 1 ? ' is' : 's are'} offered online.` : <span className="text-amber">No visit type is marked “online” yet: set one under Visit types.</span>}</div>
      </div>
      <div className="card space-y-3">
        <div className="text-[11px] uppercase tracking-wider text-muted">Rules</div>
        <Toggle id="ob-approve" on={f.requireApproval} onChange={(v) => set('requireApproval', v)} label="Reception approves each request" hint="Requests hold the place and wait in Bookings → Requests. Off: bookings are confirmed straight away" />
        <div className="grid gap-3 sm:grid-cols-3">
          <div><label className="label" htmlFor="ob-notice">Minimum notice (hours)</label><NumInput id="ob-notice" max={336} className={`input ${bad.notice ? '!border-rose' : ''}`} value={f.minNoticeHours} onChange={(e) => set('minNoticeHours', e.target.value)} /></div>
          <div><label className="label" htmlFor="ob-ahead">Book up to (days ahead)</label><NumInput id="ob-ahead" max={180} className={`input ${bad.ahead ? '!border-rose' : ''}`} value={f.maxDaysAhead} onChange={(e) => set('maxDaysAhead', e.target.value)} /></div>
          <div><label className="label" htmlFor="ob-cap">Online bookings per day (0 = no limit)</label><NumInput id="ob-cap" max={500} className={`input ${bad.cap ? '!border-rose' : ''}`} value={f.dailyCap} onChange={(e) => set('dailyCap', e.target.value)} /></div>
        </div>
        {Object.values(bad).some(Boolean) && <div className="text-xs text-rose">Notice 0–336 hours, days ahead 1–180, daily limit 0–500.</div>}
        <div><label className="label" htmlFor="ob-intro">Welcome note on the booking page (optional)</label><textarea id="ob-intro" className="input min-h-[64px]" maxLength={400} value={f.intro} onChange={(e) => set('intro', e.target.value)} placeholder="e.g. For emergencies please call 0883 244 1234." /></div>
      </div>
      <div className="flex justify-end"><button className="btn btn-primary" disabled={m.isPending || Object.values(bad).some(Boolean)} onClick={() => m.mutate()}><Icon name="check" />Save</button></div>
    </div>
  );
}

/* ---------------- Reminders and messages ---------------- */
export function MessagesTab({ cfg, onSaved }: { cfg: any; onSaved: () => void }) {
  const ms = cfg.tenant.settings?.messages ?? {};
  const [f, setF] = useState({ enabled: ms.enabled ?? true, sendConfirmation: ms.sendConfirmation ?? true, reminderHours: (ms.reminderHours ?? [24, 2]) as number[], language: ms.language ?? 'en' });
  const [tpl, setTpl] = useState<Record<string, string>>({ ...(ms.templates ?? {}) });
  const [ptpl, setPtpl] = useState<Record<string, string>>({ ...(ms.providerTemplates ?? {}) });
  const [newH, setNewH] = useState('');
  const [kind, setKind] = useState('confirmation');
  const outbox = useQuery({ queryKey: ['messages'], queryFn: () => get('/messages?limit=30') });
  const defaults = useMemo(() => ({
    confirmation: 'Hello {patient}, your {visitType} at {clinic} is booked for {date}, {time} with {doctor}. Please arrive by {arriveBy}. Confirm, cancel or change: {link}',
    requested: 'Hello {patient}, we received your request for {date}, {time} at {clinic}. We will confirm shortly. Details: {link}',
    reminder: 'Reminder: {visitType} at {clinic} on {date}, {time}. Please arrive by {arriveBy}. Reply or tap to confirm or cancel: {link}',
    moved: 'Hello {patient}, your visit at {clinic} is now on {date}, {time} with {doctor}. Arrive by {arriveBy}. Details: {link}',
    cancelled: 'Hello {patient}, your visit at {clinic} on {date}, {time} has been cancelled. Call us to book again.',
    declined: 'Hello {patient}, sorry, {clinic} could not take the {date}, {time} request. {reason} Please pick another time: {bookLink}',
  } as Record<string, string>), []);
  const cur = tpl[kind] ?? defaults[kind];
  const unknown = (cur.match(/\{(\w+)\}/g) ?? []).map((x) => x.slice(1, -1)).filter((v) => !VARS.includes(v));
  const hBad = newH !== '' && !intIn(newH, 1, 168);
  const addH = () => { if (!intIn(newH, 1, 168)) return; const n = Number(newH); if (!f.reminderHours.includes(n) && f.reminderHours.length < 3) setF({ ...f, reminderHours: [...f.reminderHours, n].sort((a, b) => b - a) }); setNewH(''); };
  const allUnknown = Object.entries({ ...defaults, ...tpl }).some(([, t]) => (t.match(/\{(\w+)\}/g) ?? []).some((x) => !VARS.includes(x.slice(1, -1))));
  const m = useMutation({ mutationFn: () => save({ messages: { ...f, templates: Object.fromEntries(Object.entries(tpl).filter(([k, v]) => v.trim() && v !== defaults[k])), providerTemplates: Object.fromEntries(Object.entries(ptpl).filter(([, v]) => v.trim()).map(([k, v]) => [k, v.trim()])) } }),
    onSuccess: () => { toast('Messages saved'); onSaved(); }, onError: (e) => toast(errText(e), 'err') });
  return (
    <div className="space-y-4">
      <div className={`card flex items-start gap-3 ${cfg.whatsappReady ? '' : '!border-amber/40'}`}>
        <Icon name="message" className={`mt-0.5 h-5 w-5 ${cfg.whatsappReady ? 'text-sage' : 'text-amber'}`} />
        <div className="text-sm">{cfg.whatsappReady ? <><b>WhatsApp is connected.</b> Messages go out automatically.</> : <><b>WhatsApp is not connected yet.</b> Messages are still prepared on time and kept below, so nothing is lost. To send them, the clinic needs a WhatsApp Business account (Meta Cloud API); your administrator adds its token to the server. Meta also has to approve a template for each message type; enter those names below.</>}</div>
      </div>
      <div className="card space-y-3">
        <Toggle id="ms-on" on={f.enabled} onChange={(v) => setF({ ...f, enabled: v })} label="Send messages to patients" hint="Off: nothing is prepared or sent" />
        <Toggle id="ms-conf" on={f.sendConfirmation} onChange={(v) => setF({ ...f, sendConfirmation: v })} label="Confirmation when a booking is made" hint="Reception can still switch it off for one booking" />
        <div>
          <span className="label">Reminders (hours before the window)</span>
          <div className="flex flex-wrap items-center gap-1.5">
            {f.reminderHours.map((h) => <span key={h} className="chip inline-flex items-center gap-1">{h >= 24 && h % 24 === 0 ? `${h / 24} day${h === 24 ? '' : 's'}` : `${h} h`}<button aria-label={`Remove ${h} hour reminder`} onClick={() => setF({ ...f, reminderHours: f.reminderHours.filter((x) => x !== h) })}><Icon name="x" className="h-3 w-3" /></button></span>)}
            {f.reminderHours.length < 3 && <><NumInput aria-label="Hours before" max={168} className={`input !w-20 !py-1.5 ${hBad ? '!border-rose' : ''}`} placeholder="hours" value={newH} onChange={(e) => setNewH(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addH()} /><button className="btn btn-sm" disabled={!newH || hBad} onClick={addH}>Add</button></>}
            {f.reminderHours.length === 0 && <span className="text-xs text-muted">No reminders</span>}
          </div>
          {hBad && <div className="mt-1 text-xs text-rose">Between 1 and 168 hours.</div>}
        </div>
        <div><span className="label">Language</span><div className="flex gap-1">{[['en', 'English'], ['te', 'Telugu']].map(([k, l]) => <button key={k} type="button" className={`toggle-opt ${f.language === k ? 'on' : ''}`} onClick={() => setF({ ...f, language: k })}>{l}</button>)}</div></div>
      </div>
      <div className="card space-y-3">
        <div className="text-[11px] uppercase tracking-wider text-muted">Message text</div>
        <div className="flex flex-wrap gap-1.5">{KINDS.map(([k, l]) => <button key={k} type="button" className={`toggle-opt ${kind === k ? 'on' : ''}`} onClick={() => setKind(k)}>{l}{tpl[k] && tpl[k] !== defaults[k] ? ' •' : ''}</button>)}</div>
        <div className="text-xs text-muted">{KINDS.find((k) => k[0] === kind)?.[2]}</div>
        <textarea aria-label="Message text" className={`input min-h-[96px] ${unknown.length ? '!border-rose' : ''}`} maxLength={900} value={cur} onChange={(e) => setTpl({ ...tpl, [kind]: e.target.value })} />
        {unknown.length > 0 && <div className="text-xs text-rose">Unknown {unknown.length === 1 ? 'word' : 'words'} in braces: {unknown.map((u) => `{${u}}`).join(', ')}. {unknown.length === 1 ? 'It' : 'They'} would be sent as written.</div>}
        <div className="flex flex-wrap gap-1">{VARS.map((v) => <button key={v} type="button" className="chip hover:bg-white" onClick={() => setTpl({ ...tpl, [kind]: `${cur} {${v}}` })}>{`{${v}}`}</button>)}</div>
        <div className="rounded-2xl bg-sage-soft/60 px-4 py-3 text-sm"><div className="mb-1 text-[11px] font-bold uppercase tracking-wider text-sage">Preview</div>{fill(cur)}</div>
        <div className="flex items-center gap-2"><label className="label !mb-0 shrink-0" htmlFor="ms-ptpl">Meta template name</label><input id="ms-ptpl" className="input" maxLength={100} placeholder="optional, e.g. appointment_confirmation" value={ptpl[kind] ?? ''} onChange={(e) => setPtpl({ ...ptpl, [kind]: e.target.value.replace(/[^a-z0-9_]/gi, '').toLowerCase() })} /></div>
        <div className="text-xs text-muted">With a template name, WhatsApp sends your approved template with these values in order: patient, date, time, doctor, link. Without one, the text above is sent (WhatsApp delivers that only if the patient wrote to you in the last 24 hours).</div>
        {tpl[kind] && tpl[kind] !== defaults[kind] && <button className="btn btn-ghost btn-sm" onClick={() => { const n = { ...tpl }; delete n[kind]; setTpl(n); }}>Reset to the standard text</button>}
      </div>
      {allUnknown && <div className="text-sm text-rose">One of the messages has an unknown word in braces. Fix it before saving.</div>}
      <div className="flex justify-end"><button className="btn btn-primary" disabled={m.isPending || allUnknown || hBad} onClick={() => m.mutate()}><Icon name="check" />Save</button></div>

      <Section title="Recent messages">
        {outbox.isLoading ? <div className="p-4"><Skeleton rows={3} /></div> : (outbox.data ?? []).length === 0 ? <div className="p-4 text-sm text-muted">Nothing yet.</div> : (outbox.data ?? []).map((x: any) => (
          <div key={x.id} className="row text-sm">
            <Chip tone={x.status === 'sent' ? 'sage' : x.status === 'failed' ? 'rose' : x.status === 'pending' ? 'amber' : ''}>{x.status === 'logged' ? 'ready' : x.status === 'pending' ? 'due' : x.status}</Chip>
            <div className="min-w-0 flex-1"><div className="truncate"><b className="font-medium">{x.patient ?? '—'}</b> · {KINDS.find((k) => k[0] === x.kind)?.[1] ?? x.kind}</div><div className="truncate text-xs text-muted">{x.body}</div></div>
            <span className="whitespace-nowrap text-xs text-muted">{new Date(x.sentAt ?? x.sendAfter).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })}</span>
          </div>
        ))}
      </Section>
    </div>
  );
}
