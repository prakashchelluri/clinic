import { useEffect, useMemo, useState } from 'react';
import { openPrint } from '../printPreview';
import { useMutation, useQuery } from '@tanstack/react-query';
import { get, patch, post, api, errText } from '../api';
import { Chip, Icon, Section, Skeleton, Tabs, toast, NumInput } from '../ui';
import { RoutineEditor, DEFAULT_ROUTINE, routineSummary } from '../routine';
import { ChangeMyDay } from '../dayChange';

/* Scheduling settings: doctors' hours (for the desk), booking rules, patient messages, photo areas. All data, no deploy. */

const KINDS: [string, string, string][] = [
  ['confirmation', 'Booking confirmation', 'Sent when a booking is made'],
  ['reminder', 'Reminder', 'Sent the chosen hours before the window'],
  ['moved', 'Booking moved', 'Sent when reception moves a booking'],
  ['cancelled', 'Booking cancelled', 'Sent when reception cancels'],
  ['late', 'Doctor running late', 'Sent when the doctor taps Running late; {reason} is the delay, e.g. 30 minutes'],
  ['reschedule', 'Please pick another time', 'Sent when the doctor is not available and the patient is asked to choose a new time'],
];
const VARS = ['patient', 'clinic', 'visitType', 'date', 'time', 'arriveBy', 'doctor', 'link', 'reason'];
const SAMPLE: Record<string, string> = { patient: 'Lakshmi Devi', clinic: 'Your clinic', visitType: 'New consultation', date: 'Thu, 22 Oct', time: '11:00–12:00', arriveBy: '10:25', doctor: 'Dr. Main', link: 'https://…/a/…', reason: 'Doctor on leave.' };
const fill = (t: string) => t.replace(/\{(\w+)\}/g, (m, k) => SAMPLE[k] ?? m);
const save = (settings: any) => patch('/admin/clinic', { settings });

const Toggle = ({ on, onChange, label, hint, id }: { on: boolean; onChange: (v: boolean) => void; label: string; hint?: string; id: string }) => (
  <label htmlFor={id} className="tap flex cursor-pointer items-start gap-3">
    <input id={id} type="checkbox" className="sr-only peer" checked={on} onChange={(e) => onChange(e.target.checked)} />
    <span aria-hidden className={`mt-0.5 relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors duration-300 peer-focus-visible:ring-2 peer-focus-visible:ring-clay ${on ? 'bg-ink' : 'bg-line-2'}`}><i className="absolute top-[3px] h-4 w-4 rounded-full bg-surface shadow-sm transition-all duration-300" style={{ left: on ? 19 : 3 }} /></span>
    <span><span className="text-sm font-medium">{label}</span>{hint && <span className="block text-xs text-muted">{hint}</span>}</span>
  </label>
);
const intIn = (v: any, min: number, max: number) => { const n = Number(v); return v !== '' && Number.isInteger(n) && n >= min && n <= max; };

/* ---------------- Availability: each doctor's weekly routine ---------------- */
export function AvailabilityTab({ cfg, onSaved }: { cfg: any; onSaved: () => void }) {
  const [edit, setEdit] = useState<any>(null); const [change, setChange] = useState<any>(null); // the doctor whose one day is being changed
  const saveR = useMutation({ mutationFn: ({ id, routine }: any) => api('PUT', `/calendar/routine/${id}`, routine), onSuccess: () => { toast('Availability saved · future days follow it'); setEdit(null); onSaved(); }, onError: (e) => toast(errText(e), 'err') });
  return (
    <div className="space-y-4">
      <div className="text-sm text-muted">Set each doctor's week once. Every day's OP windows come from it. For one day only (late, away, a break) use Change a day.</div>
      {cfg.practitioners.map((p: any) => (
        <div key={p.id} className="card">
          <div className="flex items-center gap-3"><div className="flex-1"><div className="font-semibold">{p.name}</div><div className="text-sm text-muted">{routineSummary(p.routine)}{p.routine ? ` · ${p.routine.capacity} places per ${p.routine.windowMinutes} min` : ''}</div></div>
            {edit?.id !== p.id && <><button className="btn btn-sm" onClick={() => setChange(p)}><Icon name="calendar" className="h-3.5 w-3.5" />Change a day</button><button className="btn btn-sm" onClick={() => setEdit({ id: p.id, routine: p.routine ?? DEFAULT_ROUTINE })}><Icon name="edit" className="h-3.5 w-3.5" />Edit weekly hours</button></>}</div>
          {edit?.id === p.id && (
            <div className="mt-4 space-y-3 anim-fade-up">
              <RoutineEditor value={edit.routine} onChange={(routine) => setEdit({ ...edit, routine })} />
              <div className="flex gap-2"><button className="btn btn-primary" disabled={saveR.isPending} onClick={() => saveR.mutate(edit)}><Icon name="check" />Save</button><button className="btn btn-ghost" onClick={() => setEdit(null)}>Cancel</button></div>
            </div>
          )}
        </div>
      ))}
      {change && <ChangeMyDay practitionerId={change.id} name={change.name} initialKind="away" onClose={() => { setChange(null); onSaved(); }} />}
    </div>
  );
}

/* ---------------- Booking rules ---------------- */
export function BookingRulesTab({ cfg, onSaved }: { cfg: any; onSaved: () => void }) {
  const s = cfg.tenant.settings ?? {};
  const [f, setF] = useState({ arriveEarlyMinutes: s.scheduling?.arriveEarlyMinutes ?? 35, defaultCapacity: s.scheduling?.defaultCapacity ?? 7, windowMinutes: s.scheduling?.windowMinutes ?? 60 });
  const set = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }));
  const bad = { arrive: !intIn(f.arriveEarlyMinutes, 0, 240), cap: !intIn(f.defaultCapacity, 1, 99) };
  const m = useMutation({ mutationFn: () => save({ scheduling: { arriveEarlyMinutes: Number(f.arriveEarlyMinutes), defaultCapacity: Number(f.defaultCapacity), windowMinutes: Number(f.windowMinutes) } }),
    onSuccess: () => { toast('Booking rules saved'); onSaved(); }, onError: (e) => toast(errText(e), 'err') });
  return (
    <div className="space-y-4">
      <div className="card space-y-3">
        <div className="card-title">Windows</div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div><label className="label" htmlFor="br-arrive">Arrive early (minutes)</label><NumInput id="br-arrive" max={240} className={`input ${bad.arrive ? '!border-rose' : ''}`} value={f.arriveEarlyMinutes} onChange={(e) => set('arriveEarlyMinutes', e.target.value)} /></div>
          <div><label className="label" htmlFor="br-cap">Places per hour (new doctors)</label><NumInput id="br-cap" max={99} className={`input ${bad.cap ? '!border-rose' : ''}`} value={f.defaultCapacity} onChange={(e) => set('defaultCapacity', e.target.value)} /></div>
        </div>
        <div className="text-xs text-muted">Patients are told to arrive this many minutes before their window. Each doctor's own places per hour are set under Staff & doctors › Consulting hours.</div>
      </div>
      {Object.values(bad).some(Boolean) && <div className="text-sm text-rose">Check the boxes outlined in red: arrive early 0–240, places 1–99.</div>}
      <div className="settings-save"><button className="btn btn-primary" disabled={m.isPending || Object.values(bad).some(Boolean)} onClick={() => m.mutate()}><Icon name="check" />Save</button></div>
    </div>
  );
}

/* ---------------- Reminders and messages ---------------- */
export function MessagesTab({ cfg, onSaved }: { cfg: any; onSaved: () => void }) {
  const ms = cfg.tenant.settings?.messages ?? {};
  const [f, setF] = useState({ enabled: ms.enabled ?? true, sendConfirmation: ms.sendConfirmation ?? true, reminderHours: (ms.reminderHours ?? [24, 2]) as number[] });
  const [tpl, setTpl] = useState<Record<string, string>>({ ...(ms.templates ?? {}) });
  const [ptpl, setPtpl] = useState<Record<string, string>>({ ...(ms.providerTemplates ?? {}) });
  const [newH, setNewH] = useState('');
  const [kind, setKind] = useState('confirmation');
  const [view, setView] = useState<'settings' | 'log'>('settings');
  const outbox = useQuery({ queryKey: ['messages'], queryFn: () => get('/messages?limit=30'), enabled: view === 'log' });
  const defaults = useMemo(() => ({
    confirmation: 'Hello {patient}, your {visitType} at {clinic} is booked for {date}, {time} with {doctor}. Please arrive by {arriveBy}. Confirm, cancel or change: {link}',
    reminder: 'Reminder: {visitType} at {clinic} on {date}, {time}. Please arrive by {arriveBy}. Reply or tap to confirm or cancel: {link}',
    moved: 'Hello {patient}, your visit at {clinic} is now on {date}, {time} with {doctor}. Arrive by {arriveBy}. Details: {link}',
    cancelled: 'Hello {patient}, your visit at {clinic} on {date}, {time} has been cancelled. Call us to book again.',
    late: 'Hello {patient}, {doctor} at {clinic} is running about {reason} late today. Your {time} visit will start a little later. Sorry for the wait.',
    reschedule: 'Hello {patient}, {doctor} is not available for your visit on {date}, {time} at {clinic}. {reason} Please pick another time: {link}',
  } as Record<string, string>), []);
  const cur = tpl[kind] ?? defaults[kind] ?? '';
  const unknown = (cur.match(/\{(\w+)\}/g) ?? []).map((x) => x.slice(1, -1)).filter((v) => !VARS.includes(v));
  const hBad = newH !== '' && !intIn(newH, 1, 168);
  const addH = () => { if (!intIn(newH, 1, 168)) return; const n = Number(newH); if (!f.reminderHours.includes(n) && f.reminderHours.length < 3) setF({ ...f, reminderHours: [...f.reminderHours, n].sort((a, b) => b - a) }); setNewH(''); };
  const allUnknown = Object.entries({ ...defaults, ...tpl }).some(([, t]) => (t.match(/\{(\w+)\}/g) ?? []).some((x) => !VARS.includes(x.slice(1, -1))));
  const m = useMutation({ mutationFn: () => save({ messages: { ...f, templates: Object.fromEntries(Object.entries(tpl).filter(([k, v]) => v.trim() && v !== defaults[k])), providerTemplates: Object.fromEntries(Object.entries(ptpl).filter(([, v]) => v.trim()).map(([k, v]) => [k, v.trim()])) } }),
    onSuccess: () => { toast('Messages saved'); onSaved(); }, onError: (e) => toast(errText(e), 'err') });
  return (
    <div className="space-y-4">
      <Tabs<'settings' | 'log'> value={view} onChange={setView} options={[{ value: 'settings', label: 'Settings' }, { value: 'log', label: 'Message log' }]} />
      {view === 'settings' && <>
      <div className={`card flex items-start gap-3 ${cfg.whatsappReady ? '' : '!border-amber/40'}`}>
        <Icon name="message" className={`mt-0.5 h-5 w-5 ${cfg.whatsappReady ? 'text-sage' : 'text-amber'}`} />
        <div className="text-sm">{cfg.whatsappReady ? <><b>WhatsApp is connected.</b> Messages go out automatically.</> : <><b>WhatsApp is not connected yet.</b> Messages are still prepared on time and kept in the Message log, so nothing is lost. To send them, the clinic needs a WhatsApp Business account (Meta Cloud API); your administrator adds its token to the server. Meta also has to approve a template for each message type; enter those names below.</>}</div>
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
      </div>
      <div className="card space-y-3">
        <div className="card-title">Message text (English)</div>
        <div className="text-xs text-muted">Patients who read Telugu or Hindi get the standard text in their language.</div>
        <div className="flex flex-wrap gap-1.5">{KINDS.map(([k, l]) => <button key={k} type="button" className={`toggle-opt ${kind === k ? 'on' : ''}`} onClick={() => setKind(k)}>{l}{tpl[k] && tpl[k] !== defaults[k] ? ' •' : ''}</button>)}</div>
        <div className="text-xs text-muted">{KINDS.find((k) => k[0] === kind)?.[2]}</div>
        <textarea aria-label="Message text" className={`input min-h-[96px] ${unknown.length ? '!border-rose' : ''}`} maxLength={900} value={cur} onChange={(e) => setTpl({ ...tpl, [kind]: e.target.value })} />
        {unknown.length > 0 && <div className="text-xs text-rose">Unknown {unknown.length === 1 ? 'word' : 'words'} in braces: {unknown.map((u) => `{${u}}`).join(', ')}. {unknown.length === 1 ? 'It' : 'They'} would be sent as written.</div>}
        <div className="flex flex-wrap gap-1">{VARS.map((v) => <button key={v} type="button" className="chip hover:bg-surface" onClick={() => setTpl({ ...tpl, [kind]: `${cur} {${v}}` })}>{`{${v}}`}</button>)}</div>
        <div className="rounded-2xl bg-sage-soft/60 px-4 py-3 text-sm"><div className="mb-1 text-[11px] font-bold uppercase tracking-wider text-sage">Preview</div>{fill(cur)}</div>
        <div className="flex items-center gap-2"><label className="label !mb-0 shrink-0" htmlFor="ms-ptpl">Meta template name</label><input id="ms-ptpl" className="input" maxLength={100} placeholder="optional, e.g. appointment_confirmation" value={ptpl[kind] ?? ''} onChange={(e) => setPtpl({ ...ptpl, [kind]: e.target.value.replace(/[^a-z0-9_]/gi, '').toLowerCase() })} /></div>
        <div className="text-xs text-muted">With a template name, WhatsApp sends your approved template with these values in order: patient, date, time, doctor, link. Without one, the text above is sent (WhatsApp delivers that only if the patient wrote to you in the last 24 hours).</div>
        {tpl[kind] && tpl[kind] !== defaults[kind] && <button className="btn btn-ghost btn-sm" onClick={() => { const n = { ...tpl }; delete n[kind]; setTpl(n); }}>Reset to the standard text</button>}
      </div>
      {allUnknown && <div className="text-sm text-rose">One of the messages has an unknown word in braces. Fix it before saving.</div>}
      <div className="settings-save"><button className="btn btn-primary" disabled={m.isPending || allUnknown || hBad} onClick={() => m.mutate()}><Icon name="check" />Save</button></div>
      </>}
      {view === 'log' && <Section title="Last 30 messages">
        {outbox.isLoading ? <div className="p-4"><Skeleton rows={3} /></div> : (outbox.data ?? []).length === 0 ? <div className="p-4 text-sm text-muted">Nothing yet.</div> : (outbox.data ?? []).map((x: any) => (
          <div key={x.id} className="row text-sm">
            <Chip tone={x.status === 'sent' ? 'sage' : x.status === 'failed' ? 'rose' : x.status === 'pending' ? 'amber' : ''}>{x.status === 'logged' ? 'ready' : x.status === 'pending' ? 'due' : x.status}</Chip>
            <div className="min-w-0 flex-1"><div className="truncate"><b className="font-medium">{x.patient ?? '—'}</b> · {KINDS.find((k) => k[0] === x.kind)?.[1] ?? x.kind}</div><div className="truncate text-xs text-muted">{x.body}</div></div>
            <span className="whitespace-nowrap text-xs text-muted">{new Date(x.sentAt ?? x.sendAfter).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })}</span>
          </div>
        ))}
      </Section>}
    </div>
  );
}

/* ---------------- Photo areas ---------------- */
const STOCK_AREAS = ['Face', 'Forehead', 'Cheeks', 'Chin', 'Upper lip', 'Nose', 'Scalp', 'Neck', 'Chest', 'Back', 'Arms', 'Hands', 'Underarms', 'Legs', 'Feet', 'Nails', 'Other'];
export function PhotoAreasTab({ cfg, onSaved }: { cfg: any; onSaved: () => void }) {
  const [areas, setAreas] = useState<string[]>(cfg.tenant.settings?.photos?.areas ?? STOCK_AREAS);
  const [add, setAdd] = useState('');
  const clean = add.trim();
  const dup = !!clean && areas.some((a) => a.toLowerCase() === clean.toLowerCase());
  const doAdd = () => { if (!clean || dup || clean.length > 40 || areas.length >= 40) return; setAreas([...areas, clean]); setAdd(''); };
  const move = (i: number, d: number) => { const j = i + d; if (j < 0 || j >= areas.length) return; const n = [...areas]; [n[i], n[j]] = [n[j], n[i]]; setAreas(n); };
  const m = useMutation({ mutationFn: () => save({ photos: { areas } }), onSuccess: () => { toast('Photo areas saved'); onSaved(); }, onError: (e) => toast(errText(e), 'err') });
  return (
    <div className="space-y-4">
      <div className="text-sm text-muted">The body areas staff pick when taking clinical photos. Photos of the same area line up with each other and can be compared. Staff can still add a one-off area while taking photos.</div>
      <Section title={<>Areas <span className="font-normal text-muted">· {areas.length}</span></>}>
        {areas.length === 0 ? <div className="p-4 text-sm text-muted">No areas. Add at least one.</div> : areas.map((a, i) => (
          <div key={a} className="row">
            <span className="flex-1 text-sm font-medium">{a}</span>
            <button className="btn btn-ghost btn-icon" aria-label={`Move ${a} up`} disabled={i === 0} onClick={() => move(i, -1)}><Icon name="up" className="h-3.5 w-3.5" /></button>
            <button className="btn btn-ghost btn-icon" aria-label={`Move ${a} down`} disabled={i === areas.length - 1} onClick={() => move(i, 1)}><Icon name="up" className="h-3.5 w-3.5 rotate-180" /></button>
            <button className="btn btn-ghost btn-icon" aria-label={`Remove ${a}`} onClick={() => setAreas(areas.filter((x) => x !== a))}><Icon name="x" className="h-3.5 w-3.5" /></button>
          </div>
        ))}
        <div className="flex items-center gap-2 border-t border-line/60 p-3">
          <input aria-label="New area" className={`input ${dup ? '!border-rose' : ''}`} maxLength={40} placeholder="e.g. Left knee" value={add} onChange={(e) => setAdd(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && doAdd()} />
          <button className="btn" disabled={!clean || dup || areas.length >= 40} onClick={doAdd}><Icon name="plus" className="h-3.5 w-3.5" />Add</button>
        </div>
        {dup && <div className="px-4 pb-3 text-xs text-rose">“{clean}” is already in the list.</div>}
        {areas.length >= 40 && <div className="px-4 pb-3 text-xs text-muted">That is the most areas the list can hold (40).</div>}
      </Section>
      <div className="settings-save"><button className="btn btn-ghost" onClick={() => setAreas(STOCK_AREAS)}>Use the standard list</button><button className="btn btn-primary" disabled={m.isPending || areas.length === 0} onClick={() => m.mutate()}><Icon name="check" />Save</button></div>
    </div>
  );
}

