import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { get, patch, post, qc, errText, ApiError, today, dialable } from './api';
import { PatientActions } from './pages/frontDeskJourney';
import { Chip, Drawer, Icon, Skeleton, toast } from './ui';

export const STATUS: Record<string, { label: string; tone: '' | 'clay' | 'sage' | 'amber' | 'rose' | 'sky' }> = {
  booked: { label: 'Booked', tone: '' }, confirmed: { label: 'Confirmed', tone: 'sage' },
  arrived: { label: 'Arrived', tone: 'sky' }, cancelled: { label: 'Cancelled', tone: 'rose' }, no_show: { label: 'No show', tone: 'rose' },
};
export const StatusChip = ({ s }: { s: string }) => <Chip tone={STATUS[s]?.tone ?? ''}>{STATUS[s]?.label ?? s}</Chip>;
const MSG: Record<string, string> = { confirmation: 'Confirmation', reminder: 'Reminder', moved: 'Moved', cancelled: 'Cancelled', late: 'Doctor running late', reschedule: 'Asked to pick a new time' };
const MSG_STATUS: Record<string, string> = { pending: 'due', sent: 'sent', logged: 'Not sent: WhatsApp not connected', failed: 'failed', skipped: 'not sent' };

/**
 * What the server says happened to the patient's WhatsApp (`whatsapp` on booking, move, cancel and remind responses).
 * Screens say "the patient is told" only when a message really went in the queue.
 */
export const told = (w?: string) => w === 'queued' ? 'WhatsApp sent.'
  : w === 'no_phone' ? 'No WhatsApp sent (no phone).' : w === 'opted_out' ? 'Not sent: the patient asked for no WhatsApp. Tell the patient yourself.' : w === 'not_connected' ? 'No WhatsApp sent (WhatsApp not connected).'
  : w === 'off' ? 'No WhatsApp sent (messages are switched off).' : 'No WhatsApp sent.';
const pron = (sex?: string | null) => (sex === 'F' ? 'her' : sex === 'M' ? 'him' : 'them');
const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
const dayLabel = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
const minus = (hhmm: string, min: number) => { const [h, m] = hhmm.split(':').map(Number); const t = h * 60 + m - min; return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };
export const refreshBookings = () => ['calendar', 'sessions', 'appointments', 'queue', 'bookings', 'appointment', 'followups'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));

/** One booking, opened from anywhere (calendar, bookings list). Every action on a booking lives here. */
export function AppointmentDrawer({ id, cfg, canWrite, onClose, onArrive }: { id: string; cfg: any; canWrite: boolean; onClose: () => void; onArrive?: (a: any) => void }) {
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['appointment', id], queryFn: () => get(`/appointments/${id}`) });
  const [mode, setMode] = useState<null | 'cancel' | 'move'>(null);
  const [reason, setReason] = useState('');
  const [seriesToo, setSeriesToo] = useState(false);
  const done = (msg: string) => { refreshBookings(); toast(msg); setMode(null); setReason(''); };
  const fail = (e: any) => toast(errText(e), 'err');
  const update = useMutation({ mutationFn: (b: any) => patch(`/appointments/${id}`, b), onSuccess: (r: any, b: any) => done(b.status === 'cancelled' ? `Cancelled${r.alsoCancelled ? ` with ${r.alsoCancelled} later visit${r.alsoCancelled === 1 ? '' : 's'}` : ''}. ${told(r.whatsapp)}` : b.status === 'confirmed' ? 'Marked confirmed' : b.status === 'no_show' ? 'Marked as no show' : b.sessionId ? `Moved. ${told(r.whatsapp)}` : 'Updated'), onError: fail });
  const remind = useMutation({ mutationFn: () => post(`/appointments/${id}/remind`), onSuccess: (r: any) => done(r?.whatsapp === 'queued' ? 'Reminder will go on WhatsApp' : r?.whatsapp === 'opted_out' ? 'Reminder not sent: the patient asked for no WhatsApp. Tell the patient yourself.' : `Reminder not sent. ${told(r?.whatsapp)}`), onError: fail });
  const a = q.data;
  const open = a && ['booked', 'confirmed'].includes(a.status);
  const arriveEarly = cfg?.tenant.settings.scheduling?.arriveEarlyMinutes ?? 35;
  const warnAt = cfg?.tenant.settings.booking?.noShowWarnAt ?? 2;

  return (
    <Drawer title={a?.patient.fullName ?? 'Booking'} subtitle={a ? `${a.patient.patientNo}${a.patient.phone ? ` · ${a.patient.phone}` : ' · no phone'}${a.patient.ageYears ? ` · ${a.patient.ageYears}${a.patient.sex ?? ''}` : ''}` : undefined} width="max-w-md" onClose={onClose}>
      <div className="flex flex-1 flex-col gap-4">
        {!a ? <Skeleton rows={6} /> : (<>
          <div className="flex items-center gap-2">
            <StatusChip s={a.status} />
            <span className="truncate text-xs text-muted">{a.source === 'repeat' ? 'Repeat booking' : a.source === 'walk_in' ? 'Walk-in' : 'Booked by phone'} · {when(a.createdAt)}</span>
          </div>
          <div>
            <div className="flex flex-wrap gap-1.5 text-xs">
              <Chip>{a.history.total} booking{a.history.total === 1 ? '' : 's'}</Chip>
              {a.history.noShows > 0 && <Chip tone={a.history.noShows >= warnAt ? 'rose' : 'amber'}>No show {a.history.noShows} time{a.history.noShows === 1 ? '' : 's'}</Chip>}
            </div>
          </div>
          <div className="glass !rounded-[10px] p-4">
            <div className="flex items-baseline justify-between gap-2"><b>{dayLabel(a.window.day)} · {a.window.startTime}–{a.window.endTime}</b><span className="text-xs text-muted">arrive by {minus(a.window.startTime, arriveEarly)}</span></div>
            <div className="mt-1 flex items-center gap-2 text-sm text-muted">{a.service && <i className="h-2.5 w-2.5 rounded-[3px]" style={{ background: a.service.color }} />}{a.service?.name ?? 'No visit type'} · {a.window.doctor ?? 'Any doctor'}</div>
            {a.series && <div className="mt-1 flex items-center gap-1.5 text-sm text-muted"><Icon name="repeat" className="h-3.5 w-3.5" />Repeat visit {a.series.index} of {a.series.total}</div>}
            {a.note && <div className="mt-2 rounded-xl bg-paper px-3 py-2 text-sm">“{a.note}”</div>}
            {a.cancelReason && a.status === 'cancelled' && <div className="mt-2 text-sm text-rose">Reason: {a.cancelReason}</div>}
          </div>

          {onArrive && open && mode === null && a.window.day === today() && <button className="btn btn-primary justify-center" onClick={() => onArrive(a)}>Arrived · check in</button>}
          {mode === null && <PatientActions patientId={a.patient.id} name={a.patient.fullName} more={!canWrite ? [] : open ? [
            { label: 'Send reminder', icon: 'message', onClick: () => remind.mutate() },
            { label: 'Move to another time', icon: 'calendar', onClick: () => setMode('move') },
            ...(a.window.day <= today() ? [{ label: 'Mark no show', icon: 'user', gapBefore: true, onClick: () => update.mutate({ status: 'no_show' }) }] : []),
            { label: 'Cancel booking', icon: 'x', danger: true, gapBefore: a.window.day > today(), onClick: () => setMode('cancel') },
          ] : a.status === 'no_show' ? [{ label: 'Undo no show', icon: 'undo', onClick: () => update.mutate({ status: 'booked' }) }] : []} />}

          {mode === 'cancel' && (
            <div className="card space-y-3 anim-fade-up">
              <label className="label" htmlFor="cx-reason">Why is it cancelled? (optional)</label>
              <input id="cx-reason" className="input" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. patient travelling" />
              {a.series && a.series.index < a.series.total && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={seriesToo} onChange={(e) => setSeriesToo(e.target.checked)} />Also cancel the later repeat visits</label>}
              <div className="flex gap-2"><button className="btn btn-primary !bg-rose !border-rose" disabled={update.isPending} onClick={() => update.mutate({ status: 'cancelled', cancelReason: reason || undefined, series: seriesToo ? 'future' : 'one' })}>Cancel booking</button><button className="btn btn-ghost" onClick={() => setMode(null)}>Keep it</button></div>
              <div className="text-xs text-muted">{a.patient.noWhatsapp ? 'The patient asked for no WhatsApp, so none goes. Tell the patient yourself.' : a.patient.phone ? 'The patient gets a cancellation WhatsApp.' : 'No phone: no WhatsApp goes. Tell the patient yourself.'}</div>
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
          </div>

          <div className="mt-auto flex flex-wrap gap-2 border-t border-line pt-4">
            <button className="btn btn-sm" onClick={() => { onClose(); nav(`/patients/${a.patient.id}`); }}><Icon name="eye" />View profile</button>
          </div>
        </>)}
        {q.isError && <div className="text-sm text-rose">{errText(q.error)}</div>}
      </div>
    </Drawer>
  );
}

/** Pick a new time: a date, then that doctor's times with room (not the ones already over today). Tapping a time asks first; nothing moves until "Move". */
function MovePicker({ appt, onPick, onClose, busy }: { appt: any; onPick: (sessionId: string) => void; onClose: () => void; busy: boolean }) {
  const [day, setDay] = useState(appt.window.day >= today() ? appt.window.day : today());
  const [sel, setSel] = useState<any>(null);
  const ws = useQuery({ queryKey: ['sessions', day, appt.window.practitionerId ?? ''], queryFn: () => get(`/sessions?day=${day}${appt.window.practitionerId ? `&practitionerId=${appt.window.practitionerId}` : ''}`) });
  const places = appt.service?.places ?? 1;
  const now = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  const opts = (ws.data ?? []).filter((w: any) => w.id !== appt.sessionId && (day > today() || w.endTime > now));
  const first = appt.patient.fullName.split(' ')[0];
  return (
    <div className="card space-y-3 anim-fade-up">
      <div className="flex items-center gap-2"><label className="label !mb-0" htmlFor="mv-day">Move to</label><input id="mv-day" type="date" className="input !w-auto" min={today()} value={day} onChange={(e) => { if (e.target.value) { setDay(e.target.value); setSel(null); } }} /></div>
      {ws.isLoading ? <Skeleton rows={2} /> : ws.isError ? <div className="text-sm text-rose">{errText(ws.error)}</div> : opts.length === 0 ? <div className="text-sm text-muted">No time free for this doctor on that day.</div> : (
        <div className="grid grid-cols-3 gap-2">{opts.map((w: any) => (
          <button key={w.id} disabled={busy || w.free < places} aria-pressed={sel?.id === w.id} onClick={() => setSel(w)} className={`tap rounded-xl border px-2 py-2 text-sm font-semibold ${w.free < places ? 'border-transparent text-muted line-through' : sel?.id === w.id ? 'border-ink bg-surface ring-1 ring-ink' : 'border-line bg-surface hover:border-ink'}`}>{w.startTime}<div className="text-[11px] font-normal text-muted">{w.free} free</div></button>
        ))}</div>
      )}
      {sel && <div className="rounded-xl bg-paper px-3 py-2.5 text-sm anim-fade-in" role="status">
        Move {first} to <b>{dayLabel(day)}, {sel.startTime}</b>{appt.patient.noWhatsapp ? '? The patient asked for no WhatsApp, so tell the patient yourself.' : appt.patient.phone ? ` and send ${pron(appt.patient.sex)} a WhatsApp?` : '? No phone: no WhatsApp goes, so tell the patient yourself.'}
        <div className="mt-2 flex gap-2"><button className="btn btn-primary btn-sm" disabled={busy} onClick={() => onPick(sel.id)}>Move</button><button className="btn btn-ghost btn-sm" onClick={() => setSel(null)}>Cancel</button></div>
      </div>}
      {!sel && <button className="btn btn-ghost btn-sm" onClick={onClose}>Back</button>}
    </div>
  );
}

/** Bookings error text with the server's code mapped to words people use. */
export const bookingError = (e: any) => (e instanceof ApiError && e.body?.code === 'WINDOW_FULL' ? 'That time is full' : errText(e));
