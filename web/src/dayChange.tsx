import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { del, errText, get, post, qc, today } from './api';
import { Icon, Modal, Skeleton, toast } from './ui';

export type ChangeKind = 'late' | 'break' | 'early' | 'extra' | 'away' | 'stop';
const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const toHHMM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const nowHHMM = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
const dayLabel = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

const OPTIONS: { k: ChangeKind; icon: string; title: string; hint: string }[] = [
  { k: 'late', icon: 'clock', title: 'Running late', hint: 'Patients booked and waiting get a WhatsApp. Nothing moves.' },
  { k: 'break', icon: 'moon', title: 'Short break', hint: 'From now. Nobody is messaged; the front desk sees it.' },
  { k: 'early', icon: 'door', title: 'Leave early', hint: 'Patients booked after that time are moved or told.' },
  { k: 'extra', icon: 'plus', title: 'Extra hours', hint: 'Open more time today. Front desk and online booking can fill it.' },
  { k: 'away', icon: 'x', title: 'Not coming', hint: 'Today or any day. Bookings that day are moved or told.' },
  { k: 'stop', icon: 'lock', title: 'Stop new bookings', hint: 'Keep who is booked, take no more for the rest of the day.' },
];
const HANDLING = [['move', 'Move to the next free time and tell them'], ['ask', 'Ask them to pick a time'], ['call', 'Front desk will call']] as const;

/** The doctor's one-tap exceptions to the weekly hours, with who is affected shown before anything is saved. */
export function ChangeMyDay({ practitionerId, name, initialKind = 'late', initialDay, onClose, onRoutine }: { practitionerId: string; name: string; initialKind?: ChangeKind; initialDay?: string; onClose: () => void; onRoutine?: () => void }) {
  const [kind, setKind] = useState<ChangeKind>(initialKind);
  const [day, setDay] = useState(initialDay ?? today());
  const isToday = day === today();
  const cal = useQuery({ queryKey: ['calendar', day, practitionerId], queryFn: () => get(`/calendar?day=${day}&practitionerId=${practitionerId}`) });
  const ws: any[] = cal.data?.windows ?? [];
  const first = ws[0]?.startTime as string | undefined; const last = ws[ws.length - 1]?.endTime as string | undefined;
  const [minutes, setMinutes] = useState<number | null>(null);
  const [time, setTime] = useState('');
  const [reason, setReason] = useState('');
  const [handling, setHandling] = useState<'move' | 'ask' | 'call'>('move');
  const mins = minutes ?? (kind === 'late' ? 30 : kind === 'break' ? 15 : 60);
  const t = time || (kind === 'early' && last ? toHHMM(Math.max(toMin(last) - 120, toMin(first ?? last) + 60)) : kind === 'extra' && last ? last : '');
  const needsTime = kind === 'early' || kind === 'extra';
  const timeBad = needsTime && (!/^\d{2}:\d{2}$/.test(t) || (kind === 'early' && (!first || !last || toMin(t) <= toMin(first) || toMin(t) >= toMin(last)))
    || (kind === 'extra' && toMin(t) + mins > 23 * 60 + 59) || (isToday && kind === 'early' && t < nowHHMM()));
  const notWorking = kind !== 'extra' && !cal.isLoading && !ws.length;
  const body = { practitionerId, day, kind, minutes: ['late', 'break', 'extra'].includes(kind) ? mins : undefined, time: needsTime ? t : undefined, reason: reason.trim() || undefined, handling };
  const ready = !cal.isLoading && !notWorking && !timeBad;
  const pv = useQuery({ queryKey: ['day-change', body], queryFn: () => post('/calendar/day-change', { ...body, preview: true }), enabled: ready, retry: false });
  const affected: any[] = pv.data?.affected ?? [];
  const refresh = () => ['calendar', 'frontdesk', 'calendar-attention', 'appointments', 'queue'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  const undo = useMutation({ mutationFn: (id: string) => del(`/calendar/blocks/${id}`), onSuccess: () => { refresh(); toast('Undone', 'info'); }, onError: (e) => toast(errText(e), 'err') });
  const save = useMutation({
    mutationFn: () => post('/calendar/day-change', body),
    onSuccess: (r: any) => {
      refresh();
      const what = kind === 'late' ? `Running ${mins} min late · ${r.affected.length} told` : kind === 'extra' ? `Open ${t}–${toHHMM(toMin(t) + mins)}` : `${OPTIONS.find((o) => o.k === kind)!.title} saved${r.moved ? ` · ${r.moved} moved` : ''}`;
      toast(what, 'ok', r.block ? { label: 'Undo', run: () => undo.mutate(r.block.id) } : undefined); onClose();
    },
    onError: (e) => toast(errText(e), 'err'),
  });
  const existing = (cal.data?.blocks ?? []).filter((b: any) => b.kind !== 'procedure');
  const action = kind === 'late' ? `Tell ${affected.length || 'them'}` : kind === 'break' ? `Break until ${toHHMM(Math.min(toMin(isToday && nowHHMM() > (first ?? '') ? nowHHMM() : first ?? '00:00') + mins, toMin(last ?? '23:59')))}`
    : kind === 'early' ? `Leave at ${t}${affected.length && handling === 'move' ? ` · move ${affected.filter((a) => a.to).length}` : ''}` : kind === 'extra' ? `Open ${t}–${toHHMM(toMin(t) + mins)}` : kind === 'away' ? `Not coming ${isToday ? 'today' : dayLabel(day)}` : 'Stop new bookings';
  const sample = affected[0];

  return (
    <Modal title="Change my day" subtitle={`${name} · only for exceptions; weekly hours stay in Settings`} onClose={onClose} width="max-w-4xl">
      <div className="grid gap-4 md:grid-cols-[260px_minmax(0,1fr)]">
        <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="What changes">
          {OPTIONS.map((o) => (
            <button key={o.k} type="button" role="radio" aria-checked={kind === o.k} onClick={() => { setKind(o.k); setTime(''); setMinutes(null); }}
              className={`flex items-start gap-3 rounded-2xl border p-3 text-left transition-colors ${kind === o.k ? 'border-sage bg-sage-soft' : 'border-line bg-white/60 hover:bg-white'}`}>
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-paper"><Icon name={o.icon} className="h-4 w-4" /></span>
              <span><b className="text-sm">{o.title}</b><span className="block text-xs text-muted">{o.hint}</span></span>
            </button>))}
        </div>

        <div className="min-w-0 space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <label className="label !mb-0" htmlFor="dc-day">Day</label>
            <input id="dc-day" type="date" min={today()} className="input !w-auto !py-1.5" value={day} disabled={kind === 'late' || kind === 'break'} onChange={(e) => e.target.value >= today() && setDay(e.target.value)} />
            {(kind === 'late' || kind === 'break') && !isToday && <button className="text-sm underline" onClick={() => setDay(today())}>today</button>}
            <span className="text-muted">{cal.isLoading ? '…' : ws.length ? `Hours ${first}–${last}` : 'Not working this day'}</span>
          </div>
          {(kind === 'late' || kind === 'break') && !isToday && <div className="text-xs text-amber">{kind === 'late' ? 'Running late' : 'A short break'} is for today. Set the day back to today.</div>}

          {(kind === 'late' || kind === 'break' || kind === 'extra') && <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="How long">
            <span className="label !mb-0 mr-1">{kind === 'late' ? 'About' : kind === 'break' ? 'For' : 'For'}</span>
            {(kind === 'extra' ? [60, 90, 120] : kind === 'break' ? [15, 30, 45, 60] : [15, 30, 45, 60]).map((m) => <button key={m} role="radio" aria-checked={mins === m} className={`toggle-opt ${mins === m ? 'on' : ''}`} onClick={() => setMinutes(m)}>{m >= 60 && m % 60 === 0 ? `${m / 60} hour${m > 60 ? 's' : ''}` : `${m} min`}</button>)}
          </div>}
          {needsTime && <div className="flex flex-wrap items-center gap-2">
            <label className="label !mb-0" htmlFor="dc-time">{kind === 'early' ? "I'll leave at" : 'From'}</label>
            <input id="dc-time" type="time" step={300} className={`input !w-auto !py-1.5 ${timeBad ? '!border-rose' : ''}`} value={t} onChange={(e) => setTime(e.target.value)} />
            {kind === 'early' && last && <span className="text-sm text-muted">instead of {last}</span>}
          </div>}
          {needsTime && timeBad && t && <div className="text-xs text-rose">{kind === 'early' ? `Pick a time inside ${first ?? ''}–${last ?? ''}${isToday ? ', not in the past' : ''}.` : 'Pick a time that ends before midnight.'}</div>}
          {(kind === 'early' || kind === 'away') && <input aria-label="Reason (optional)" className="input" maxLength={200} placeholder="Reason (optional), e.g. hospital call" value={reason} onChange={(e) => setReason(e.target.value)} />}
          {notWorking && <div className="rounded-2xl bg-paper p-3 text-sm text-muted">Not working on {dayLabel(day)}. Nothing to change.</div>}

          {ready && kind !== 'break' && kind !== 'extra' && kind !== 'stop' && <div>
            {pv.isLoading ? <Skeleton rows={2} /> : pv.error ? <div className="text-sm text-rose">{errText(pv.error)}</div> : affected.length === 0
              ? <div className="rounded-2xl bg-sage-soft px-3 py-2 text-sm text-sage">Nobody is affected.</div>
              : <>
                <b className="text-[15px]">{affected.length} patient{affected.length === 1 ? '' : 's'} {kind === 'late' ? 'to tell' : `booked ${kind === 'early' ? `after ${t}` : 'that day'}`}</b>
                <div className="mt-1 max-h-48 overflow-y-auto">{affected.map((a) => (
                  <div key={a.id} className="flex items-center gap-3 border-t border-line/60 py-2 text-sm first:border-t-0">
                    <b className="w-12 shrink-0">{a.time}</b><span className="min-w-0 flex-1 truncate">{a.name}{a.phone ? <span className="text-muted"> · {a.phone}</span> : ''}{a.status === 'arrived' ? <span className="text-muted"> · waiting</span> : ''}</span>
                    {kind !== 'late' && handling === 'move' && <span className="shrink-0 text-xs text-muted">{a.to ? `→ ${dayLabel(a.to.day)} ${a.to.startTime}` : 'no free place in 2 weeks: asked to pick'}</span>}
                  </div>))}</div>
                {kind !== 'late' && <div className="mt-3"><div className="label">What happens to them</div>
                  <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="What happens to them">{HANDLING.map(([k, l]) => <button key={k} role="radio" aria-checked={handling === k} className={`toggle-opt ${handling === k ? 'on' : ''}`} onClick={() => setHandling(k)}>{l}</button>)}</div></div>}
                {sample && handling !== 'call' && <div className="mt-3 rounded-2xl bg-[#E7F5E9] px-3.5 py-2.5 text-[13px] leading-snug">
                  <b>WhatsApp to {sample.name}</b><br />
                  {kind === 'late' ? `${name} is running about ${mins} minutes late today. Your ${sample.time} visit will start a little later. Sorry for the wait.`
                    : handling === 'move' && sample.to ? `Your ${sample.time} visit is moved to ${dayLabel(sample.to.day)}, ${sample.to.startTime} with ${name}. Details and change: link.`
                    : `${name} is not available for your visit on ${dayLabel(day)}, ${sample.time}.${reason ? ` ${reason}.` : ''} Please pick another time: link.`}
                </div>}
              </>}
          </div>}
          {kind === 'stop' && ready && <div className="rounded-2xl bg-paper px-3 py-2 text-sm text-muted">Nobody is messaged. Everyone already booked stays booked.</div>}

          {existing.length > 0 && <div className="rounded-2xl bg-paper px-3 py-2 text-sm"><div className="text-[11px] font-bold uppercase tracking-wider text-muted">Already changed on {dayLabel(day)}</div>
            {existing.map((b: any) => <div key={b.id} className="mt-1 flex items-center gap-2"><span className="flex-1">{b.note ?? b.kind}{b.startTime !== b.endTime && b.kind !== 'leave' ? ` · ${b.startTime}–${b.endTime}` : ''}</span><button className="text-sm font-semibold underline" disabled={undo.isPending} onClick={() => undo.mutate(b.id)}>Undo</button></div>)}</div>}

          <div className="modal-foot">
            {onRoutine && <button className="btn btn-ghost btn-sm" onClick={onRoutine}>Weekly hours</button>}
            <span className="ml-auto" /><button className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" disabled={!ready || save.isPending || ((kind === 'late' || kind === 'break') && !isToday) || (kind !== 'break' && kind !== 'extra' && kind !== 'stop' && pv.isLoading)} onClick={() => save.mutate()}><Icon name="check" />{action}</button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
