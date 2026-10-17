import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useOutletContext } from 'react-router';
import { get, post, patch, api, qc, today, errText } from '../api';
import { can } from '../App';
import { Chip, Empty, Icon, Modal, PageHeader, Section, Skeleton, toast, NumInput } from '../ui';
import { RoutineModal, routineSummary } from '../routine';

const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const toHHMM = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const DAY_START = 8 * 60, DAY_END = 21 * 60, PX = 1.05;
const top = (t: string) => (toMin(t) - DAY_START) * PX;
const height = (s: string, e: string) => Math.max(18, (toMin(e) - toMin(s)) * PX);
const shift = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

/** The doctor's day. Windows come from the weekly routine; the doctor only records exceptions, one tap each. */
export function Calendar() {
  const { cfg, perms, me } = useOutletContext<any>();
  const [day, setDay] = useState(today());
  const [doc, setDoc] = useState<string>(me.practitionerId ?? cfg?.practitioners?.[0]?.id ?? '');
  const cal = useQuery({ queryKey: ['calendar', day, doc], queryFn: () => get(`/calendar?day=${day}${doc ? `&practitionerId=${doc}` : ''}`), refetchInterval: 15000, enabled: !!doc });
  const [modal, setModal] = useState<null | 'routine' | 'break' | 'early' | 'editday'>(null);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['calendar'] }); qc.invalidateQueries({ queryKey: ['sessions'] }); };
  const addBlock = useMutation({ mutationFn: (b: any) => post('/calendar/blocks', { practitionerId: doc, day, ...b }), onSuccess: (_r, b: any) => { refresh(); toast(b.kind === 'leave' ? 'Marked away · reception sees it now' : 'Added · capacity adjusted'); }, onError: (e: any) => toast(errText(e), 'err') });
  const delBlock = useMutation({ mutationFn: (id: string) => api('DELETE', `/calendar/blocks/${id}`), onSuccess: () => { refresh(); toast('Removed', 'info'); } });
  const setState = useMutation({ mutationFn: ({ id, state, reason }: any) => patch(`/procedure-sessions/${id}`, { state, reason }), onSuccess: () => { refresh(); qc.invalidateQueries({ queryKey: ['worklist'] }); toast('Updated'); } });
  const writable = can(perms, 'appointment.write') || me.practitionerId === doc;
  const d = cal.data;
  const practitioner = cfg?.practitioners.find((p: any) => p.id === doc);
  const dayLabel = new Date(day + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });
  const totals = d ? d.windows.reduce((s: any, w: any) => ({ a: s.a + w.allocated, c: s.c + w.effectiveCapacity }), { a: 0, c: 0 }) : null;
  const firstStart = d?.windows[0]?.startTime; const lastEnd = d?.windows[d.windows.length - 1]?.endTime;
  const awayToday = d?.blocks.some((b: any) => b.kind === 'leave' && toMin(b.endTime) - toMin(b.startTime) >= 600);
  const hours = Array.from({ length: (DAY_END - DAY_START) / 60 + 1 }, (_, i) => DAY_START + i * 60);
  const exceptions = d ? [...d.blocks.map((b: any) => ({ ...b, type: 'block' })), ...d.procedures.filter((p: any) => p.practitionerId === doc).map((p: any) => ({ ...p, type: 'procedure' }))].sort((a, b) => toMin(a.startTime) - toMin(b.startTime)) : [];

  return (
    <div>
      <PageHeader title={practitioner ? `${practitioner.name} · ${dayLabel}` : dayLabel}
        subtitle={<>{practitioner?.routine ? <>Routine: {routineSummary(practitioner.routine)}</> : <span className="text-amber">No weekly routine yet</span>}{totals ? <> · <b className="text-ink">{totals.a}</b> of {totals.c} OP places taken{d.procedures.length ? ` · ${d.procedures.length} procedure${d.procedures.length === 1 ? '' : 's'}` : ''}</> : null}</>}>
        <div className="flex items-center gap-1 card !p-1 !rounded-full">
          <button className="btn btn-ghost btn-icon" aria-label="Previous day" onClick={() => setDay(shift(day, -1))}><Icon name="chevL" /></button>
          <input type="date" className="input !w-auto !border-0 !shadow-none !py-1.5 text-center" value={day} onChange={(e) => setDay(e.target.value)} />
          <button className="btn btn-ghost btn-icon" aria-label="Next day" onClick={() => setDay(shift(day, 1))}><Icon name="chevR" /></button>
        </div>
        {(cfg?.practitioners ?? []).length > 1 && <select className="input !w-auto" value={doc} onChange={(e) => setDoc(e.target.value)}>{cfg.practitioners.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}
      </PageHeader>

      {writable && d && (
        <div className="anim-fade-up flex flex-wrap items-center gap-2 mb-5">
          <span className="text-xs uppercase tracking-wider text-muted mr-1">Today is different?</span>
          {!awayToday && <button className="btn" onClick={() => { if (confirm(`Mark ${practitioner?.name} away for the whole of ${dayLabel}? Reception will see every window at zero and can call the ${totals?.a ?? 0} booked patients.`)) addBlock.mutate({ kind: 'leave', startTime: '00:00', endTime: '23:59', note: 'Away' }); }}><Icon name="door" />Away today</button>}
          {firstStart && !awayToday && <button className="btn" onClick={() => addBlock.mutate({ kind: 'other', startTime: firstStart, endTime: toHHMM(toMin(firstStart) + 30), note: 'Late by 30 min' })}><Icon name="clock" />Late by 30 min</button>}
          {lastEnd && !awayToday && <button className="btn" onClick={() => setModal('early')}><Icon name="chevR" />Leaving early</button>}
          {!awayToday && <button className="btn btn-primary" onClick={() => setModal('break')}><Icon name="plus" />Add a break</button>}
          <span className="ml-auto" />
          <button className="btn btn-ghost btn-sm" onClick={() => setModal('editday')}>Edit this day's windows</button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px] gap-5">
        <Section delay={40}>
          {cal.isLoading || !d ? <Skeleton rows={6} /> : (
            <div className="relative p-4 pl-14" style={{ height: (DAY_END - DAY_START) * PX + 32 }}>
              {hours.map((h) => (
                <div key={h} className="absolute left-0 right-0 flex items-start" style={{ top: (h - DAY_START) * PX + 16 }}>
                  <span className="w-12 -mt-2 text-[11px] text-muted text-right pr-2">{String(h / 60).padStart(2, '0')}:00</span>
                  <div className="flex-1 border-t border-line/70" />
                </div>
              ))}
              <div className="absolute left-14 right-4" style={{ top: 16 }}>
                {d.windows.length === 0 && d.blocks.length === 0 && d.procedures.length === 0 && (
                  <div className="pt-24"><Empty icon="calendar" title={practitioner?.routine ? 'Not a working day in the routine' : 'No routine set for this doctor'} hint={writable ? (practitioner?.routine ? 'Use “Edit this day’s windows” for a one-off day.' : 'Set the weekly routine once; every day fills itself.') : undefined} />
                    {writable && !practitioner?.routine && <div className="flex justify-center pb-6"><button className="btn btn-primary" onClick={() => setModal('routine')}><Icon name="spark" />Set weekly routine</button></div>}</div>
                )}
                {d.windows.map((w: any) => {
                  const tone = w.effectiveCapacity === 0 ? 'rose' : w.free <= 0 ? 'rose' : w.free <= 2 ? 'amber' : 'sage';
                  return (
                    <div key={w.id} className="absolute left-0 right-[42%] rounded-xl border bg-surface px-3 py-2 anim-fade-up overflow-hidden" style={{ top: top(w.startTime), height: height(w.startTime, w.endTime), borderColor: 'var(--color-line)', opacity: w.effectiveCapacity === 0 ? 0.55 : 1 }}>
                      <div className="flex items-center gap-2 text-sm"><span className="font-medium whitespace-nowrap">{w.startTime}–{w.endTime}</span><span className="text-xs text-muted whitespace-nowrap">OP</span><Chip tone={tone as any} className="ml-auto">{w.allocated}/{w.effectiveCapacity}{w.effectiveCapacity !== w.capacity && <span className="line-through opacity-60 ml-1">{w.capacity}</span>}</Chip></div>
                      {w.reductions.length > 0 && <div className="text-[11px] text-amber mt-1 truncate">{w.reductions.map((r: any) => `${r.note ?? r.kind} (${r.minutes} min)`).join(', ')}</div>}
                    </div>
                  );
                })}
                {d.blocks.filter((b: any) => !(b.kind === 'leave' && toMin(b.endTime) - toMin(b.startTime) >= 600)).map((b: any) => (
                  <div key={b.id} className="absolute left-0 right-[42%] rounded-xl px-3 py-1.5 text-xs anim-fade-up flex items-center gap-2" style={{ top: top(b.startTime), height: height(b.startTime, b.endTime), background: b.kind === 'leave' ? 'var(--color-rose-soft)' : 'repeating-linear-gradient(135deg, var(--color-paper-2) 0 6px, var(--color-paper) 6px 12px)', border: '1px dashed var(--color-line-2)' }}>
                    <Icon name={b.kind === 'leave' ? 'door' : 'clock'} className="h-3.5 w-3.5 text-muted" /><span className="font-medium">{b.note ?? b.kind}</span><span className="text-muted">{b.startTime}–{b.endTime}</span>
                    {writable && <button className="btn btn-ghost btn-icon ml-auto !h-6 !w-6" aria-label="Remove this" onClick={() => delBlock.mutate(b.id)}><Icon name="x" className="h-3 w-3" /></button>}
                  </div>
                ))}
                {d.procedures.map((p: any) => (
                  <div key={p.id} className="absolute left-[60%] right-0 rounded-xl px-3 py-2 text-xs anim-slide-in overflow-hidden" style={{ top: top(p.startTime), height: height(p.startTime, p.endTime), background: 'var(--color-sky-soft)', border: '1px solid #c7d4e0' }}>
                    <div className="font-medium text-sky truncate">{p.procedure ?? 'Procedure'} · {p.patient}</div>
                    <div className="text-muted truncate">{p.startTime}–{p.endTime} · {p.room ?? 'no room'}{p.doctor ? ` · ${p.doctor}` : ''}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Section>

        <div className="space-y-4">
          <div className="card anim-fade-up" style={{ animationDelay: '60ms' }}>
            <div className="text-[11px] uppercase tracking-wider text-muted">Your routine</div>
            <div className="serif text-xl mt-1.5">{routineSummary(practitioner?.routine)}</div>
            {practitioner?.routine && <div className="text-sm text-muted mt-1">{practitioner.routine.capacity} places per {practitioner.routine.windowMinutes === 30 ? 'half hour' : 'hour'}. Windows for every day come from this automatically.</div>}
            {writable && <button className="btn btn-sm mt-3" onClick={() => setModal('routine')}><Icon name="edit" className="h-3.5 w-3.5" />{practitioner?.routine ? 'Change routine' : 'Set routine'}</button>}
          </div>
          <Section title="Today's exceptions" delay={90}>
            {!d ? <Skeleton rows={2} /> : awayToday ? <div className="p-4 text-sm flex items-center gap-2"><Chip tone="rose">away</Chip>Whole day. {writable && <button className="btn btn-sm btn-ghost ml-auto" onClick={() => delBlock.mutate(d.blocks.find((b: any) => b.kind === 'leave').id)}>Undo</button>}</div>
              : exceptions.length === 0 ? <div className="p-4 text-sm text-muted">None. Nothing to do today.</div>
              : exceptions.map((x: any) => (
                <div key={x.id} className="row text-sm">
                  <Chip tone={x.type === 'procedure' ? 'sky' : x.kind === 'leave' ? 'rose' : 'amber'}>{x.type === 'procedure' ? 'procedure' : x.kind}</Chip>
                  <div className="flex-1 min-w-0 truncate">{x.type === 'procedure' ? `${x.procedure ?? 'Procedure'} · ${x.patient}` : (x.note ?? x.kind)} <span className="text-muted">{x.startTime}–{x.endTime}</span></div>
                  {x.type === 'block' && writable && <button className="btn btn-ghost btn-icon" aria-label="Remove this" onClick={() => delBlock.mutate(x.id)}><Icon name="x" className="h-3.5 w-3.5" /></button>}
                </div>
              ))}
          </Section>
          <Section title={<>Procedures today <span className="text-muted font-normal">· {d?.procedures.length ?? 0}</span></>} delay={120}>
            {!d ? <Skeleton rows={2} /> : d.procedures.length === 0 ? <div className="p-4 text-sm text-muted">Nothing in the rooms today.</div> :
              d.procedures.map((p: any) => (
                <div key={p.id} className="px-4 py-3 border-t border-line first:border-t-0 text-sm">
                  <div className="flex items-center gap-2"><span className="font-mono text-xs text-muted">{p.startTime}</span><span className="font-medium flex-1 truncate">{p.patient}</span><Chip tone={p.state === 'completed' ? 'sage' : p.state === 'in_progress' ? 'amber' : 'sky'}>{p.state.replace('_', ' ')}</Chip></div>
                  <div className="text-xs text-muted mt-0.5">{p.procedure} · sitting {p.sittingNo} · {p.room ?? 'no room'}{p.doctor ? ` · ${p.doctor}` : ''}</div>
                  {can(perms, 'worklist.write') && !['completed', 'cancelled'].includes(p.state) && (
                    <div className="flex gap-1 mt-2 flex-wrap">
                      {p.state === 'confirmed' && <button className="btn btn-sm" onClick={() => setState.mutate({ id: p.id, state: 'in_progress' })}>Start</button>}
                      <button className="btn btn-sm btn-primary" onClick={() => setState.mutate({ id: p.id, state: 'completed' })}>Completed</button>
                      <button className="btn btn-sm" onClick={() => setState.mutate({ id: p.id, state: 'missed', reason: 'did not attend' })}>Missed</button>
                      <button className="btn btn-sm btn-ghost" onClick={() => { const r = prompt('Reason for postponing?'); if (r !== null) setState.mutate({ id: p.id, state: 'postponed', reason: r }); }}>Postpone</button>
                    </div>
                  )}
                </div>
              ))}
          </Section>
        </div>
      </div>

      {modal === 'routine' && practitioner && <RoutineModal practitionerId={doc} name={practitioner.name} initial={practitioner.routine} onClose={() => setModal(null)} />}
      {modal === 'break' && <QuickBlock title="Add a break" defaultStart={firstStart ? toHHMM(Math.max(toMin(firstStart), 13 * 60)) : '13:00'} minutes={30} onSave={(s, e, note) => { addBlock.mutate({ kind: 'break', startTime: s, endTime: e, note: note || 'Break' }); setModal(null); }} onClose={() => setModal(null)} />}
      {modal === 'early' && lastEnd && <QuickBlock title="Leaving early" subtitle="From what time are you not available?" defaultStart={toHHMM(toMin(lastEnd) - 60)} fixedEnd={lastEnd} onSave={(s, e) => { addBlock.mutate({ kind: 'other', startTime: s, endTime: e, note: 'Leaving early' }); setModal(null); }} onClose={() => setModal(null)} />}
      {modal === 'editday' && <EditDayModal day={day} practitionerId={doc} cfg={cfg} onClose={() => { setModal(null); refresh(); }} />}
    </div>
  );
}

function QuickBlock({ title, subtitle, defaultStart, minutes = 30, fixedEnd, onSave, onClose }: { title: string; subtitle?: string; defaultStart: string; minutes?: number; fixedEnd?: string; onSave: (s: string, e: string, note?: string) => void; onClose: () => void }) {
  const [start, setStart] = useState(defaultStart); const [len, setLen] = useState(minutes); const [note, setNote] = useState('');
  const end = fixedEnd ?? toHHMM(toMin(start) + len);
  return (
    <Modal title={title} subtitle={subtitle ?? 'OP places in the affected window drop automatically; reception sees why.'} onClose={onClose} width="max-w-md">
      <div className="space-y-3">
        <div className="flex items-center gap-2 flex-wrap"><label className="label !mb-0">From</label><input type="time" className="input !w-auto" value={start} onChange={(e) => setStart(e.target.value)} />
          {!fixedEnd && <><span className="text-muted text-sm">for</span><div className="flex gap-1">{[15, 30, 45, 60].map((m) => <button key={m} className={`toggle-opt ${len === m ? 'on' : ''}`} onClick={() => setLen(m)}>{m} min</button>)}</div></>}
          <span className="text-sm text-muted">→ until {end}</span></div>
        {!fixedEnd && <input className="input" placeholder="Note (optional), e.g. Lunch" value={note} onChange={(e) => setNote(e.target.value)} />}
        <div className="flex justify-end gap-2 pt-2"><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={() => onSave(start, end, note)}><Icon name="check" />Save</button></div>
      </div>
    </Modal>
  );
}

/** Rare one-off override of a single day (the routine stays as it is). */
function EditDayModal({ day, practitionerId, cfg, onClose }: { day: string; practitionerId: string; cfg: any; onClose: () => void }) {
  const [ranges, setRanges] = useState([{ startTime: '10:00', endTime: '13:00' }]);
  const [capacity, setCapacity] = useState(cfg?.tenant.settings.scheduling?.defaultCapacity ?? 7);
  const save = useMutation({ mutationFn: () => post('/sessions/generate', { day, practitionerId, ranges, breaks: [], capacity: Number(capacity), windowMinutes: cfg?.tenant.settings.scheduling?.windowMinutes ?? 60, replace: true }),
    onSuccess: (r: any) => { toast(`${r.windows} windows set for this day only`); onClose(); }, onError: (e: any) => toast(errText(e), 'err') });
  return (
    <Modal title="Edit this day's windows" subtitle={`${day} only. Windows with bookings are kept. The weekly routine is unchanged.`} onClose={onClose} width="max-w-lg">
      <div className="space-y-3">
        {ranges.map((r, i) => <div key={i} className="flex items-center gap-2"><input type="time" className="input !w-auto" value={r.startTime} onChange={(e) => setRanges(ranges.map((x, j) => j === i ? { ...x, startTime: e.target.value } : x))} /><span className="text-muted">to</span><input type="time" className="input !w-auto" value={r.endTime} onChange={(e) => setRanges(ranges.map((x, j) => j === i ? { ...x, endTime: e.target.value } : x))} /><button className="btn btn-ghost btn-icon" onClick={() => setRanges(ranges.filter((_, j) => j !== i))}><Icon name="x" className="h-3.5 w-3.5" /></button></div>)}
        <div className="flex gap-2 items-center"><button className="btn btn-sm" onClick={() => setRanges([...ranges, { startTime: '16:00', endTime: '20:00' }])}><Icon name="plus" className="h-3.5 w-3.5" />Add hours</button><span className="ml-auto text-sm text-muted">Places per window</span><NumInput max={99} className="input !w-20" value={capacity} onChange={(e) => setCapacity(e.target.value as any)} /></div>
        <div className="flex justify-end gap-2 pt-2 border-t border-line"><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={save.isPending || !ranges.length} onClick={() => save.mutate()}><Icon name="check" />Save for this day</button></div>
      </div>
    </Modal>
  );
}
