import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { get, patch, post, qc, errText, ApiError, today } from './api';
import { Chip, Icon, Skeleton, toast } from './ui';

export const STATUS: Record<string, { label: string; tone: '' | 'clay' | 'sage' | 'amber' | 'rose' | 'sky' }> = {
  requested: { label: 'requested', tone: 'clay' }, booked: { label: 'booked', tone: '' }, confirmed: { label: 'confirmed', tone: 'sage' },
  arrived: { label: 'arrived', tone: 'sky' }, cancelled: { label: 'cancelled', tone: 'rose' }, no_show: { label: 'no-show', tone: 'rose' },
};
export const StatusChip = ({ s }: { s: string }) => <Chip tone={STATUS[s]?.tone ?? ''}>{STATUS[s]?.label ?? s}</Chip>;
const MSG: Record<string, string> = { confirmation: 'Confirmation', requested: 'Request received', reminder: 'Reminder', moved: 'Moved', cancelled: 'Cancelled', declined: 'Declined' };
const MSG_STATUS: Record<string, string> = { pending: 'due', sent: 'sent', logged: 'ready (WhatsApp not connected)', failed: 'failed', skipped: 'not sent' };
const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
const dayLabel = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
const minus = (hhmm: string, min: number) => { const [h, m] = hhmm.split(':').map(Number); const t = h * 60 + m - min; return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };
export const refreshBookings = () => ['calendar', 'sessions', 'appointments', 'queue', 'bookings', 'appointment'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));

/** One booking, opened from anywhere (calendar, bookings list). Every action on a booking lives here. */
export function AppointmentDrawer({ id, cfg, canWrite, onClose }: { id: string; cfg: any; canWrite: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['appointment', id], queryFn: () => get(`/appointments/${id}`) });
  const [mode, setMode] = useState<null | 'cancel' | 'move' | 'decline'>(null);
  const [reason, setReason] = useState('');
  const [seriesToo, setSeriesToo] = useState(false);
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  const done = (msg: string) => { refreshBookings(); toast(msg); setMode(null); setReason(''); };
  const fail = (e: any) => toast(errText(e), 'err');
  const update = useMutation({ mutationFn: (b: any) => patch(`/appointments/${id}`, b), onSuccess: (r: any, b: any) => done(b.status === 'cancelled' ? `Cancelled${r.alsoCancelled ? ` with ${r.alsoCancelled} later visit${r.alsoCancelled === 1 ? '' : 's'}` : ''}` : b.status === 'confirmed' ? 'Marked confirmed' : b.status === 'no_show' ? 'Marked no-show' : 'Updated'), onError: fail });
  const approve = useMutation({ mutationFn: () => post(`/appointments/${id}/approve`), onSuccess: () => done('Approved · confirmation queued'), onError: fail });
  const decline = useMutation({ mutationFn: () => post(`/appointments/${id}/decline`, { reason }), onSuccess: () => done('Declined · patient told'), onError: fail });
  const remind = useMutation({ mutationFn: () => post(`/appointments/${id}/remind`), onSuccess: () => done('Reminder queued'), onError: fail });
  const a = q.data;
  const open = a && ['requested', 'booked', 'confirmed'].includes(a.status);
  const arriveEarly = cfg?.tenant.settings.scheduling?.arriveEarlyMinutes ?? 35;
  const warnAt = cfg?.tenant.settings.booking?.noShowWarnAt ?? 2;

  return (
    <div className="fixed inset-0 z-40 anim-fade-in" style={{ background: 'rgba(28,27,25,.28)', backdropFilter: 'blur(3px)' }} onClick={onClose}>
      <aside role="dialog" aria-label="Booking details" className="absolute inset-y-0 right-0 flex w-full max-w-[420px] flex-col gap-4 overflow-y-auto bg-[#FBFAF7] p-5 anim-slide-in sm:p-6" style={{ boxShadow: '-30px 0 60px -30px rgba(40,30,20,.45)' }} onClick={(e) => e.stopPropagation()}>
        {!a ? <Skeleton rows={6} /> : (<>
          <div className="flex items-center gap-2">
            <StatusChip s={a.status} />
            <span className="truncate text-xs text-muted">{a.source === 'online' ? 'Booked online' : a.source === 'repeat' ? 'Repeat booking' : a.source === 'walk_in' ? 'Walk-in' : 'Booked by phone'} · {when(a.createdAt)}</span>
            <button className="btn btn-ghost btn-icon ml-auto" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
          </div>
          <div>
            <div className="text-2xl font-semibold">{a.patient.fullName}</div>
            <div className="text-sm text-muted">{a.patient.patientNo}{a.patient.phone ? ` · ${a.patient.phone}` : ' · no phone'}{a.patient.ageYears ? ` · ${a.patient.ageYears}${a.patient.sex ?? ''}` : ''}</div>
            <div className="mt-1.5 flex flex-wrap gap-1.5 text-xs">
              <Chip>{a.history.total} booking{a.history.total === 1 ? '' : 's'}</Chip>
              {a.history.noShows > 0 && <Chip tone={a.history.noShows >= warnAt ? 'rose' : 'amber'}>{a.history.noShows} no-show{a.history.noShows === 1 ? '' : 's'}</Chip>}
            </div>
          </div>
          <div className="glass !rounded-[20px] p-4">
            <div className="flex items-baseline justify-between gap-2"><b>{dayLabel(a.window.day)} · {a.window.startTime}–{a.window.endTime}</b><span className="text-xs text-muted">arrive by {minus(a.window.startTime, arriveEarly)}</span></div>
            <div className="mt-1 flex items-center gap-2 text-sm text-muted">{a.service && <i className="h-2.5 w-2.5 rounded-[3px]" style={{ background: a.service.color }} />}{a.service?.name ?? 'No visit type'} · {a.window.doctor ?? 'Any doctor'}</div>
            {a.series && <div className="mt-1 flex items-center gap-1.5 text-sm text-muted"><Icon name="repeat" className="h-3.5 w-3.5" />Repeat visit {a.series.index} of {a.series.total}</div>}
            {a.note && <div className="mt-2 rounded-xl bg-paper px-3 py-2 text-sm">“{a.note}”</div>}
            {a.cancelReason && a.status === 'cancelled' && <div className="mt-2 text-sm text-rose">Reason: {a.cancelReason}</div>}
          </div>

          {canWrite && open && mode === null && (
            <div className="grid grid-cols-2 gap-2">
              {a.status === 'requested' ? <>
                <button className="btn btn-primary justify-center" disabled={approve.isPending} onClick={() => approve.mutate()}><Icon name="check" />Approve</button>
                <button className="btn justify-center" onClick={() => setMode('decline')}>Decline</button>
              </> : <>
                {a.status === 'booked' ? <button className="btn btn-primary justify-center" onClick={() => update.mutate({ status: 'confirmed' })}><Icon name="check" />Mark confirmed</button> : <button className="btn justify-center" onClick={() => remind.mutate()}><Icon name="message" />Send reminder</button>}
                <button className="btn justify-center" onClick={() => setMode('move')}><Icon name="calendar" />Move</button>
                {a.window.day <= today() && <button className="btn justify-center" onClick={() => update.mutate({ status: 'no_show' })}>No-show</button>}
                {a.status === 'booked' && <button className="btn justify-center" onClick={() => remind.mutate()}><Icon name="message" />Send reminder</button>}
                <button className="btn justify-center !text-rose" onClick={() => setMode('cancel')}>Cancel</button>
              </>}
            </div>
          )}
          {canWrite && a.status === 'no_show' && mode === null && <button className="btn justify-center" onClick={() => update.mutate({ status: 'booked' })}>Undo no-show</button>}

          {mode === 'cancel' && (
            <div className="card space-y-3 anim-fade-up">
              <label className="label" htmlFor="cx-reason">Why is it cancelled? (optional)</label>
              <input id="cx-reason" className="input" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. patient travelling" />
              {a.series && a.series.index < a.series.total && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={seriesToo} onChange={(e) => setSeriesToo(e.target.checked)} />Also cancel the later repeat visits</label>}
              <div className="flex gap-2"><button className="btn btn-primary !bg-rose !border-rose" disabled={update.isPending} onClick={() => update.mutate({ status: 'cancelled', cancelReason: reason || undefined, series: seriesToo ? 'future' : 'one' })}>Cancel booking</button><button className="btn btn-ghost" onClick={() => setMode(null)}>Keep it</button></div>
              <div className="text-xs text-muted">The patient gets a cancellation message.</div>
            </div>
          )}
          {mode === 'decline' && (
            <div className="card space-y-3 anim-fade-up">
              <label className="label" htmlFor="dc-reason">Message to the patient (optional)</label>
              <input id="dc-reason" className="input" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Doctor is on leave that day." />
              <div className="flex gap-2"><button className="btn btn-primary" disabled={decline.isPending} onClick={() => decline.mutate()}>Decline request</button><button className="btn btn-ghost" onClick={() => setMode(null)}>Back</button></div>
            </div>
          )}
          {mode === 'move' && <MovePicker appt={a} onPick={(sessionId) => update.mutate({ sessionId })} onClose={() => setMode(null)} busy={update.isPending} />}

          <div>
            <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-muted">Messages</div>
            {a.messages.length === 0 ? <div className="text-sm text-muted">None yet.</div> : a.messages.map((m: any) => (
              <div key={m.id} className="flex items-start gap-2 border-t border-line/60 py-2 text-sm first:border-t-0">
                <Icon name={m.status === 'sent' ? 'check' : m.status === 'failed' ? 'x' : 'clock'} className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${m.status === 'sent' ? 'text-sage' : m.status === 'failed' ? 'text-rose' : 'text-muted'}`} />
                <div className="min-w-0 flex-1"><div><b className="font-semibold">{MSG[m.kind] ?? m.kind}</b> <span className="text-muted">· {MSG_STATUS[m.status] ?? m.status} · {when(m.sentAt ?? m.sendAfter)}</span></div>{m.error && m.status !== 'pending' && <div className="text-xs text-muted">{m.error}</div>}</div>
              </div>
            ))}
            {a.link && <button className="btn btn-ghost btn-sm mt-1" onClick={() => { navigator.clipboard?.writeText(a.link).then(() => toast('Patient link copied'), () => toast(a.link, 'info')); }}><Icon name="link" />Copy patient link</button>}
          </div>

          <div className="mt-auto flex flex-wrap gap-2 border-t border-line pt-4">
            <button className="btn btn-sm" onClick={() => { onClose(); nav(`/patients/${a.patient.id}`); }}><Icon name="user" />Open record</button>
            {a.patient.phone && <a className="btn btn-sm" href={`tel:${a.patient.phone}`}><Icon name="phone" />Call</a>}
          </div>
        </>)}
        {q.isError && <div className="text-sm text-rose">{errText(q.error)}</div>}
      </aside>
    </div>
  );
}

/** Pick a new window: a date, then that doctor's windows with room. */
function MovePicker({ appt, onPick, onClose, busy }: { appt: any; onPick: (sessionId: string) => void; onClose: () => void; busy: boolean }) {
  const [day, setDay] = useState(appt.window.day >= today() ? appt.window.day : today());
  const ws = useQuery({ queryKey: ['sessions', day, appt.window.practitionerId ?? ''], queryFn: () => get(`/sessions?day=${day}${appt.window.practitionerId ? `&practitionerId=${appt.window.practitionerId}` : ''}`) });
  const places = appt.service?.places ?? 1;
  const opts = (ws.data ?? []).filter((w: any) => w.id !== appt.sessionId);
  return (
    <div className="card space-y-3 anim-fade-up">
      <div className="flex items-center gap-2"><label className="label !mb-0" htmlFor="mv-day">Move to</label><input id="mv-day" type="date" className="input !w-auto" min={today()} value={day} onChange={(e) => e.target.value && setDay(e.target.value)} /></div>
      {ws.isLoading ? <Skeleton rows={2} /> : opts.length === 0 ? <div className="text-sm text-muted">No windows for this doctor on that day.</div> : (
        <div className="grid grid-cols-3 gap-2">{opts.map((w: any) => (
          <button key={w.id} disabled={busy || w.free < places} onClick={() => onPick(w.id)} className={`rounded-xl border px-2 py-2 text-sm font-semibold ${w.free < places ? 'border-transparent text-muted line-through' : 'border-line bg-white hover:border-ink'}`}>{w.startTime}<div className="text-[11px] font-normal text-muted">{w.free} free</div></button>
        ))}</div>
      )}
      <button className="btn btn-ghost btn-sm" onClick={onClose}>Back</button>
    </div>
  );
}

/** Bookings error text with the server's code mapped to words people use. */
export const bookingError = (e: any) => (e instanceof ApiError && e.body?.code === 'WINDOW_FULL' ? 'That window is full' : errText(e));
