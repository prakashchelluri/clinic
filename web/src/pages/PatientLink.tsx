import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useParams, useSearchParams } from 'react-router';
import { get, post, qc, errText } from '../api';
import { Chip, Icon, Skeleton } from '../ui';
import { PublicShell } from './PublicBook';

const nice = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const addDays = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const STATUS: Record<string, [string, 'clay' | 'sage' | 'amber' | 'rose' | 'sky' | '']> = {
  requested: ['waiting for the clinic to approve', 'amber'], booked: ['booked', ''], confirmed: ['confirmed', 'sage'], arrived: ['checked in', 'sky'], cancelled: ['cancelled', 'rose'], no_show: ['missed', 'rose'],
};

/** The patient's own link from WhatsApp: see the visit, confirm, cancel or pick another time. */
export function PatientLink() {
  const { slug = '', token = '' } = useParams(); const [params] = useSearchParams();
  const base = `/public/a/${slug}/${token}`;
  const q = useQuery({ queryKey: ['patient-link', token], queryFn: () => get(base), retry: false });
  const [mode, setMode] = useState<null | 'cancel' | 'move'>(null);
  const [reason, setReason] = useState('');
  const set = (r: any) => { qc.setQueryData(['patient-link', token], r); setMode(null); };
  const confirm = useMutation({ mutationFn: () => post(`${base}/confirm`), onSuccess: set });
  const cancel = useMutation({ mutationFn: () => post(`${base}/cancel`, { reason: reason.trim() || undefined }), onSuccess: set });
  const move = useMutation({ mutationFn: (sessionId: string) => post(`${base}/reschedule`, { sessionId }), onSuccess: set });
  const v = q.data;
  const err = confirm.error ?? cancel.error ?? move.error;

  if (q.isLoading) return <PublicShell><div className="card"><Skeleton rows={5} /></div></PublicShell>;
  if (q.isError) return <PublicShell><div className="card text-center"><div className="text-lg font-semibold">This link is not valid</div><div className="mt-1 text-sm text-muted">It may be old or mistyped. Please call the clinic.</div></div></PublicShell>;
  const [label, tone] = STATUS[v.status] ?? [v.status, ''];
  return (
    <PublicShell name={v.clinic.name}>
      {params.get('new') && v.status !== 'cancelled' && <div className="rounded-2xl bg-sage-soft px-4 py-3 text-sm text-sage anim-fade-up"><b>{v.status === 'requested' ? 'Request sent.' : 'You are booked.'}</b> Keep this page: you can come back to it any time.</div>}
      <div className="card">
        <div className="text-sm text-muted">Hello {v.patient}, your visit</div>
        <div className="mt-1 text-[26px] font-semibold leading-tight">{nice(v.day)} · {v.startTime}</div>
        <div className="mt-1 text-[15px]">{v.visitType ?? 'Visit'}{v.doctor ? ` with ${v.doctor}` : ''}</div>
        {!['cancelled', 'no_show'].includes(v.status) && <div className="mt-3 rounded-xl bg-paper px-3 py-2.5 text-sm">Please arrive by <b>{v.arriveBy}</b>. The wait can be 30–45 minutes.</div>}
        <div className="mt-3"><Chip tone={tone}>{label}</Chip></div>
      </div>
      {err && <div className="rounded-2xl bg-rose-soft px-4 py-3 text-sm text-rose">{errText(err)}</div>}
      {mode === null && <div className="space-y-2">
        {v.canConfirm && <button className="btn btn-primary w-full justify-center !py-3.5" disabled={confirm.isPending} onClick={() => confirm.mutate()}><Icon name="check" />Yes, I will come</button>}
        {v.canReschedule && <button className="btn w-full justify-center !py-3.5" onClick={() => setMode('move')}><Icon name="calendar" />Change day or time</button>}
        {v.canCancel && <button className="btn btn-ghost w-full justify-center !py-3.5 !text-rose" onClick={() => setMode('cancel')}>Cancel this visit</button>}
      </div>}
      {mode === 'cancel' && <div className="card space-y-3 anim-fade-up">
        <label className="label" htmlFor="pl-reason">Reason (optional)</label>
        <input id="pl-reason" className="input" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. feeling better" />
        <div className="flex gap-2"><button className="btn btn-primary !bg-rose !border-rose" disabled={cancel.isPending} onClick={() => cancel.mutate()}>Cancel visit</button><button className="btn btn-ghost" onClick={() => setMode(null)}>Keep it</button></div>
      </div>}
      {mode === 'move' && <MoveSlots base={base} day={v.day} busy={move.isPending} onPick={(id) => move.mutate(id)} onBack={() => setMode(null)} />}
      {!v.canCancel && ['requested', 'booked', 'confirmed'].includes(v.status) && <div className="text-center text-sm text-muted">It is less than {v.cancelWindowHours} hours to your visit. To change it, please call {v.clinic.phone ? <a className="underline" href={`tel:${v.clinic.phone}`}>{v.clinic.phone}</a> : 'the clinic'}.</div>}
      {v.status === 'cancelled' && <a className="btn btn-accent w-full justify-center !py-3.5" href={`/book/${v.clinic.slug}`}>Book another time</a>}
      {v.policy && <div className="text-center text-xs text-muted">{v.policy}</div>}
    </PublicShell>
  );
}

function MoveSlots({ base, day, busy, onPick, onBack }: { base: string; day: string; busy: boolean; onPick: (id: string) => void; onBack: () => void }) {
  const todayIst = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const [from, setFrom] = useState(day > todayIst ? todayIst : todayIst);
  const q = useQuery({ queryKey: ['patient-link-slots', base, from], queryFn: () => get(`${base}/slots?from=${from}&days=7`) });
  const days: any[] = (q.data ?? []).filter((d: any) => d.slots.length);
  return (
    <div className="card space-y-3 anim-fade-up">
      <div className="flex items-center"><b>Pick a new time</b><span className="ml-auto flex gap-1"><button className="btn btn-ghost btn-icon" aria-label="Earlier" disabled={from <= todayIst} onClick={() => setFrom(addDays(from, -7) < todayIst ? todayIst : addDays(from, -7))}><Icon name="chevL" /></button><button className="btn btn-ghost btn-icon" aria-label="Later" onClick={() => setFrom(addDays(from, 7))}><Icon name="chevR" /></button></span></div>
      {q.isLoading ? <Skeleton rows={3} /> : q.isError ? <div className="text-sm text-rose">{errText(q.error)}</div> : days.length === 0 ? <div className="text-sm text-muted">No free times in these days. Try later days.</div> : days.map((d) => (
        <div key={d.day}><div className="mb-1 text-xs font-semibold text-muted">{nice(d.day)}</div><div className="grid grid-cols-3 gap-2">{d.slots.map((s: any) => <button key={s.id} disabled={busy} onClick={() => onPick(s.id)} className="rounded-xl bg-white py-2.5 text-sm font-semibold hover:ring-1 hover:ring-ink">{s.startTime}</button>)}</div></div>
      ))}
      <button className="btn btn-ghost btn-sm" onClick={onBack}>Back</button>
    </div>
  );
}
