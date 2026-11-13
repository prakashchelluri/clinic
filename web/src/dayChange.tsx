import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { del, errText, get, post, qc, today } from './api';
import { Icon, Modal, Skeleton, toast } from './ui';

export type ChangeKind = 'late' | 'break' | 'early' | 'extra' | 'away' | 'stop';
const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const toHHMM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const nowHHMM = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
const dayLabel = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

export const DAY_CHANGES: { k: ChangeKind; icon: string; title: string; hint: string }[] = [
  { k: 'late', icon: 'clock', title: 'Running late', hint: 'nothing moves, patients are told' },
  { k: 'break', icon: 'moon', title: 'Short break', hint: 'from now, nobody is messaged' },
  { k: 'early', icon: 'door', title: 'Leave early', hint: 'later bookings are moved or told' },
  { k: 'extra', icon: 'plus', title: 'Extra hours', hint: 'the front desk can fill it' },
  { k: 'away', icon: 'x', title: 'Not coming', hint: 'bookings that day are moved or told' },
  { k: 'stop', icon: 'lock', title: 'Stop new bookings', hint: 'who is booked stays' },
];
const HANDLING = [['move', 'Move to the next free time and tell them'], ['ask', 'Ask them to pick a time'], ['call', 'Front desk will call']] as const;

/** One exception to the weekly hours, as a small popup that asks one question (v64). The kind is picked in the My day menu;
 *  who is affected and the WhatsApp text are one click away, shown before anything is saved. */
export function ChangeMyDay({ practitionerId, name, initialKind = 'late', initialDay, onClose, onRoutine }: { practitionerId: string; name: string; initialKind?: ChangeKind; initialDay?: string; onClose: () => void; onRoutine?: () => void }) {
  const kind = initialKind;
  const [details, setDetails] = useState(false); // who is affected and the message, behind one line
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
      const what = kind === 'late' ? `Running ${mins} min late · ${r.affected.length} told` : kind === 'extra' ? `Open ${t}–${toHHMM(toMin(t) + mins)}` : `${DAY_CHANGES.find((o) => o.k === kind)!.title} saved${r.moved ? ` · ${r.moved} moved` : ''}`;
      toast(what, 'ok', r.block ? { label: 'Undo', run: () => undo.mutate(r.block.id) } : undefined); onClose();
    },
    onError: (e) => toast(errText(e), 'err'),
  });
  const existing = (cal.data?.blocks ?? []).filter((b: any) => b.kind !== 'procedure');
  const action = kind === 'late' ? (affected.length ? `Tell ${affected.length} patient${affected.length === 1 ? '' : 's'}` : 'Save') : kind === 'break' ? `Break until ${toHHMM(Math.min(toMin(isToday && nowHHMM() > (first ?? '') ? nowHHMM() : first ?? '00:00') + mins, toMin(last ?? '23:59')))}`
    : kind === 'early' ? `Leave at ${t}${affected.length && handling === 'move' ? ` · move ${affected.filter((a) => a.to).length}` : ''}` : kind === 'extra' ? `Open ${t}–${toHHMM(toMin(t) + mins)}` : kind === 'away' ? `Not coming ${isToday ? 'today' : dayLabel(day)}` : 'Stop new bookings';
  const sample = affected[0];

  const opt = DAY_CHANGES.find((o) => o.k === kind)!;
  const todayOnly = kind === 'late' || kind === 'break';
  const tells = kind === 'late' || kind === 'early' || kind === 'away';
  const ask = kind === 'late' ? 'How late?' : kind === 'break' ? 'For how long?' : kind === 'extra' ? 'For how long?' : '';
  return (
    <Modal title={opt.title} subtitle={`${name} · ${opt.hint}`} onClose={onClose} width="max-w-md">
      <div className="space-y-4">
        {/* the day: plain text when it can only be today, else a date */}
        {todayOnly ? <div className="text-[13.5px]"><span className="text-muted">Today</span> · {dayLabel(day)}{ws.length ? <span className="text-muted"> · hours {first}–{last}</span> : null}</div>
          : <div className="flex flex-wrap items-center gap-2 text-[13.5px]">
            <label className="text-muted" htmlFor="dc-day">{kind === 'away' ? 'Which day?' : 'Day'}</label>
            <input id="dc-day" type="date" min={today()} className="input !w-auto !py-1.5" value={day} onChange={(e) => e.target.value >= today() && setDay(e.target.value)} />
            <span className="text-muted">{cal.isLoading ? '…' : ws.length ? `hours ${first}–${last}` : 'not working'}</span>
          </div>}

        {ask && <div><div className="mb-1.5 text-[13.5px] text-muted">{ask}</div>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={ask}>
            {(kind === 'extra' ? [60, 90, 120] : [15, 30, 45, 60]).map((m) => <button key={m} role="radio" aria-checked={mins === m} className={`toggle-opt ${mins === m ? 'on' : ''}`} onClick={() => setMinutes(m)}>{m >= 60 && m % 60 === 0 ? `${m / 60} hour${m > 60 ? 's' : ''}` : m > 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} min`}</button>)}
          </div></div>}
        {needsTime && <div className="flex flex-wrap items-center gap-2 text-[13.5px]">
          <label className="text-muted" htmlFor="dc-time">{kind === 'early' ? 'Leaving at what time?' : 'From'}</label>
          <input id="dc-time" type="time" step={300} className={`input !w-auto !py-1.5 ${timeBad ? '!border-rose' : ''}`} value={t} onChange={(e) => setTime(e.target.value)} />
          {kind === 'early' && last && <span className="text-muted">instead of {last}</span>}
        </div>}
        {needsTime && timeBad && t && <div className="text-xs text-rose">{kind === 'early' ? `Pick a time inside ${first ?? ''}–${last ?? ''}${isToday ? ', not in the past' : ''}.` : 'Pick a time that ends before midnight.'}</div>}
        {(kind === 'early' || kind === 'away') && <input aria-label="Reason (optional)" className="input" maxLength={200} placeholder="Reason (optional), e.g. hospital call" value={reason} onChange={(e) => setReason(e.target.value)} />}
        {notWorking && <div className="text-[13.5px] text-muted">Not working on {dayLabel(day)}. Nothing to change.</div>}

        {ready && tells && (pv.isLoading ? <Skeleton rows={1} /> : pv.error ? <div className="text-sm text-rose">{errText(pv.error)}</div> : affected.length === 0
          ? <div className="text-[13.5px] text-muted">Nobody is booked{kind === 'early' ? ` after ${t}` : ''}, so nobody is told.</div>
          : <div className="space-y-3">
            {kind !== 'late' && <div><div className="mb-1.5 text-[13.5px] text-muted">What happens to the {affected.length} booked?</div>
              <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="What happens to them">{HANDLING.map(([k, l]) => <button key={k} role="radio" aria-checked={handling === k} className={`toggle-opt ${handling === k ? 'on' : ''}`} onClick={() => setHandling(k)}>{l}</button>)}</div></div>}
            <div className="text-[13px] text-muted">{handling === 'call' && kind !== 'late' ? `The front desk calls ${affected.length} patient${affected.length === 1 ? '' : 's'}` : `${affected.length} patient${affected.length === 1 ? '' : 's'} get${affected.length === 1 ? 's' : ''} a WhatsApp`} · <button type="button" className="font-medium text-clay hover:underline" aria-expanded={details} onClick={() => setDetails(!details)}>{details ? 'Hide' : 'See who and the message'}</button></div>
            {details && <>
              <div className="max-h-48 overflow-y-auto rounded-[8px] border border-line">{affected.map((a) => (
                <div key={a.id} className="flex items-center gap-3 border-t border-line px-3 py-1.5 text-[13px] first:border-t-0">
                  <b className="w-11 shrink-0 font-medium">{a.time}</b><span className="min-w-0 flex-1 truncate">{a.name}{a.status === 'arrived' ? <span className="text-muted"> · waiting</span> : ''}</span>
                  {kind !== 'late' && handling === 'move' ? <span className="shrink-0 text-xs text-muted">{a.to ? `→ ${dayLabel(a.to.day)} ${a.to.startTime}` : 'asked to pick'}</span> : a.phone && <span className="shrink-0 text-xs text-muted">{a.phone}</span>}
                </div>))}</div>
              {sample && handling !== 'call' && <div className="rounded-[8px] bg-[#F0FDF4] px-3 py-2 text-[13px] leading-snug text-[#14532D]">
                <div className="mb-0.5 font-medium">Message to {sample.name}</div>
                {kind === 'late' ? `${name} is running about ${mins} minutes late today. Your ${sample.time} visit will start a little later. Sorry for the wait.`
                  : handling === 'move' && sample.to ? `Your ${sample.time} visit is moved to ${dayLabel(sample.to.day)}, ${sample.to.startTime} with ${name}. Details and change: link.`
                  : `${name} is not available for your visit on ${dayLabel(day)}, ${sample.time}.${reason ? ` ${reason}.` : ''} Please pick another time: link.`}
              </div>}
            </>}
          </div>)}
        {kind === 'stop' && ready && <div className="text-[13.5px] text-muted">Nobody is messaged. Everyone already booked stays booked.</div>}

        {existing.length > 0 && <div className="text-[13px]"><div className="text-muted">Already changed on {dayLabel(day)}</div>
          {existing.map((b: any) => <div key={b.id} className="mt-1 flex items-center gap-2"><span className="flex-1">{b.note ?? b.kind}{b.startTime !== b.endTime && b.kind !== 'leave' ? ` · ${b.startTime}–${b.endTime}` : ''}</span><button className="font-medium text-clay hover:underline" disabled={undo.isPending} onClick={() => undo.mutate(b.id)}>Undo</button></div>)}</div>}

        <div className="modal-foot">
          {onRoutine && <button className="btn btn-ghost btn-sm" onClick={onRoutine}>Weekly hours</button>}
          <span className="ml-auto" /><button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!ready || save.isPending || (todayOnly && !isToday) || (tells && pv.isLoading)} onClick={() => save.mutate()}>{action}</button>
        </div>
      </div>
    </Modal>
  );
}
