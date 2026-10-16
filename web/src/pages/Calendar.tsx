import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useOutletContext } from 'react-router';
import { get, post, patch, api, qc, today } from '../api';
import { can } from '../App';
import { Chip, Empty, Icon, Modal, PageHeader, Section, Skeleton, toast } from '../ui';

const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const DAY_START = 8 * 60, DAY_END = 21 * 60, PX_PER_MIN = 1.1;
const top = (t: string) => (toMin(t) - DAY_START) * PX_PER_MIN;
const height = (s: string, e: string) => Math.max(18, (toMin(e) - toMin(s)) * PX_PER_MIN);
const shift = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

/** The doctor's day: OP windows with live capacity, breaks, leave and scheduled procedures on one timeline. */
export function Calendar() {
  const { cfg, perms, me } = useOutletContext<any>();
  const [day, setDay] = useState(today());
  const [doc, setDoc] = useState<string>(me.practitionerId ?? cfg?.practitioners?.[0]?.id ?? '');
  const cal = useQuery({ queryKey: ['calendar', day, doc], queryFn: () => get(`/calendar?day=${day}${doc ? `&practitionerId=${doc}` : ''}`), refetchInterval: 15000 });
  const [avail, setAvail] = useState(false); const [block, setBlock] = useState(false);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['calendar'] }); qc.invalidateQueries({ queryKey: ['sessions'] }); };
  const delBlock = useMutation({ mutationFn: (id: string) => api('DELETE', `/calendar/blocks/${id}`), onSuccess: () => { refresh(); toast('Removed', 'info'); } });
  const setState = useMutation({ mutationFn: ({ id, state, reason }: any) => patch(`/procedure-sessions/${id}`, { state, reason }), onSuccess: () => { refresh(); qc.invalidateQueries({ queryKey: ['worklist'] }); toast('Updated'); } });
  const writable = can(perms, 'appointment.write');
  const d = cal.data;
  const doctorName = cfg?.practitioners.find((p: any) => p.id === doc)?.name ?? 'All doctors';
  const dayLabel = new Date(day + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });
  const totals = d ? d.windows.reduce((s: any, w: any) => ({ a: s.a + w.allocated, c: s.c + w.effectiveCapacity }), { a: 0, c: 0 }) : null;
  const hours = Array.from({ length: (DAY_END - DAY_START) / 60 + 1 }, (_, i) => DAY_START + i * 60);

  return (
    <div>
      <PageHeader title={doctorName} subtitle={<>{dayLabel}{totals ? <> · <b className="text-ink">{totals.a}</b> of {totals.c} OP places taken · {d.procedures.length} procedure{d.procedures.length === 1 ? '' : 's'}</> : null}</>}>
        <div className="flex items-center gap-1 card !p-1 !rounded-full">
          <button className="btn btn-ghost btn-icon" onClick={() => setDay(shift(day, -1))}><Icon name="chevL" /></button>
          <input type="date" className="input !w-auto !border-0 !shadow-none !py-1.5 text-center" value={day} onChange={(e) => setDay(e.target.value)} />
          <button className="btn btn-ghost btn-icon" onClick={() => setDay(shift(day, 1))}><Icon name="chevR" /></button>
        </div>
        <select className="input !w-auto" value={doc} onChange={(e) => setDoc(e.target.value)}>{cfg?.practitioners.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        {writable && <button className="btn" onClick={() => setBlock(true)}><Icon name="clock" />Break / leave</button>}
        {writable && <button className="btn btn-primary" onClick={() => setAvail(true)}><Icon name="spark" />Set availability</button>}
      </PageHeader>

      <div className="grid lg:grid-cols-[1fr_360px] gap-5">
        <Section delay={40}>
          {cal.isLoading || !d ? <Skeleton rows={6} /> : (
            <div className="relative p-4 pl-14" style={{ height: (DAY_END - DAY_START) * PX_PER_MIN + 32 }}>
              {hours.map((h) => (
                <div key={h} className="absolute left-0 right-0 flex items-start" style={{ top: (h - DAY_START) * PX_PER_MIN + 16 }}>
                  <span className="w-12 -mt-2 text-[11px] text-muted text-right pr-2">{String(h / 60).padStart(2, '0')}:00</span>
                  <div className="flex-1 border-t border-line/70" />
                </div>
              ))}
              <div className="absolute left-14 right-4" style={{ top: 16 }}>
                {d.windows.length === 0 && d.blocks.length === 0 && d.procedures.length === 0 && <div className="pt-24"><Empty icon="calendar" title="No availability set for this day" hint={writable ? 'Use “Set availability” to create the OP windows and breaks in one go.' : undefined} /></div>}
                {d.windows.map((w: any) => {
                  const tone = w.free <= 0 ? 'rose' : w.free <= 2 ? 'amber' : 'sage';
                  return (
                    <div key={w.id} className="absolute left-0 right-[42%] rounded-xl border bg-surface px-3 py-2 anim-fade-up overflow-hidden" style={{ top: top(w.startTime), height: height(w.startTime, w.endTime), borderColor: 'var(--color-line)' }}>
                      <div className="flex items-center gap-2 text-sm"><span className="font-medium whitespace-nowrap">{w.startTime}–{w.endTime}</span><span className="text-xs text-muted whitespace-nowrap">OP window</span><Chip tone={tone as any} className="ml-auto">{w.allocated}/{w.effectiveCapacity}{w.effectiveCapacity !== w.capacity && <span className="line-through opacity-60 ml-1">{w.capacity}</span>}</Chip></div>
                      {w.reductions.length > 0 && <div className="text-[11px] text-amber mt-1">capacity reduced: {w.reductions.map((r: any) => `${r.note ?? r.kind} (${r.minutes} min)`).join(', ')}</div>}
                    </div>
                  );
                })}
                {d.blocks.map((b: any) => (
                  <div key={b.id} className="absolute left-0 right-[42%] rounded-xl px-3 py-1.5 text-xs anim-fade-up flex items-center gap-2" style={{ top: top(b.startTime), height: height(b.startTime, b.endTime), background: b.kind === 'leave' ? 'var(--color-rose-soft)' : 'repeating-linear-gradient(135deg, var(--color-paper-2) 0 6px, var(--color-paper) 6px 12px)', border: '1px dashed var(--color-line-2)' }}>
                    <Icon name={b.kind === 'leave' ? 'door' : 'clock'} className="h-3.5 w-3.5 text-muted" /><span className="font-medium">{b.note ?? b.kind}</span><span className="text-muted">{b.startTime}–{b.endTime}</span>
                    {writable && <button className="btn btn-ghost btn-icon ml-auto !h-6 !w-6" onClick={() => delBlock.mutate(b.id)}><Icon name="x" className="h-3 w-3" /></button>}
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
          <Section title={<>Procedures today <span className="text-muted font-normal">· {d?.procedures.length ?? 0}</span></>} delay={80}>
            {!d ? <Skeleton rows={2} /> : d.procedures.length === 0 ? <div className="p-4 text-sm text-muted">Nothing scheduled in the rooms. Schedule from Worklists → Procedures.</div> :
              d.procedures.map((p: any) => (
                <div key={p.id} className="px-4 py-3 border-t border-line first:border-t-0 text-sm">
                  <div className="flex items-center gap-2"><span className="font-mono text-xs text-muted">{p.startTime}</span><span className="font-medium flex-1 truncate">{p.patient}</span><Chip tone={p.state === 'completed' ? 'sage' : p.state === 'in_progress' ? 'amber' : 'sky'}>{p.state.replace('_', ' ')}</Chip></div>
                  <div className="text-xs text-muted mt-0.5">{p.procedure} · sitting {p.sittingNo} · {p.room ?? 'no room'}{p.doctor ? ` · ${p.doctor}` : ''}{p.phone ? ` · ${p.phone}` : ''}</div>
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
          <div className="card text-xs text-muted anim-fade-up" style={{ animationDelay: '120ms' }}>
            <div className="font-semibold text-ink-2 mb-1">How capacity works</div>
            Each OP window has a practical capacity. A break, leave or a procedure on this doctor removes a proportional share: a 30-minute procedure inside a 7-place hour leaves about 4 places. Booking uses the reduced number automatically and shows the reason.
          </div>
        </div>
      </div>
      {avail && <AvailabilityModal day={day} practitionerId={doc} cfg={cfg} onClose={() => { setAvail(false); refresh(); }} />}
      {block && <BlockModal day={day} practitionerId={doc} onClose={() => { setBlock(false); refresh(); }} />}
    </div>
  );
}

/** "I'm in from 10 to 1 and 4 to 8, lunch 1–2": produces the windows and the break in one save. */
function AvailabilityModal({ day, practitionerId, cfg, onClose }: { day: string; practitionerId: string; cfg: any; onClose: () => void }) {
  const [ranges, setRanges] = useState([{ startTime: '10:00', endTime: '13:00' }, { startTime: '16:00', endTime: '20:00' }]);
  const [breaks, setBreaks] = useState<{ startTime: string; endTime: string; note: string }[]>([]);
  const [capacity, setCapacity] = useState(cfg?.tenant.settings.scheduling?.defaultCapacity ?? 7);
  const [windowMinutes, setWindowMinutes] = useState(cfg?.tenant.settings.scheduling?.windowMinutes ?? 60);
  const [replace, setReplace] = useState(true);
  const save = useMutation({ mutationFn: () => post('/sessions/generate', { day, practitionerId, ranges, breaks: breaks.filter((b) => b.startTime && b.endTime), capacity: Number(capacity), windowMinutes: Number(windowMinutes), replace }),
    onSuccess: (r: any) => { toast(`${r.windows} windows set`); onClose(); }, onError: (e: any) => toast(e?.body?.code ?? 'Failed', 'err') });
  return (
    <Modal title="Set availability" subtitle={`${day} · creates OP windows of ${windowMinutes} minutes with ${capacity} places each`} onClose={onClose} width="max-w-lg">
      <div className="space-y-4">
        <div><label className="label">Consulting hours</label>
          {ranges.map((r, i) => <div key={i} className="flex items-center gap-2 mb-1.5"><input type="time" className="input !w-auto" value={r.startTime} onChange={(e) => setRanges(ranges.map((x, j) => j === i ? { ...x, startTime: e.target.value } : x))} /><span className="text-muted">to</span><input type="time" className="input !w-auto" value={r.endTime} onChange={(e) => setRanges(ranges.map((x, j) => j === i ? { ...x, endTime: e.target.value } : x))} /><button className="btn btn-ghost btn-icon" onClick={() => setRanges(ranges.filter((_, j) => j !== i))}><Icon name="x" className="h-3.5 w-3.5" /></button></div>)}
          <button className="btn btn-sm" onClick={() => setRanges([...ranges, { startTime: '14:00', endTime: '16:00' }])}><Icon name="plus" className="h-3.5 w-3.5" />Add hours</button></div>
        <div><label className="label">Breaks inside those hours</label>
          {breaks.map((b, i) => <div key={i} className="flex items-center gap-2 mb-1.5"><input type="time" className="input !w-auto" value={b.startTime} onChange={(e) => setBreaks(breaks.map((x, j) => j === i ? { ...x, startTime: e.target.value } : x))} /><span className="text-muted">to</span><input type="time" className="input !w-auto" value={b.endTime} onChange={(e) => setBreaks(breaks.map((x, j) => j === i ? { ...x, endTime: e.target.value } : x))} /><input className="input flex-1" placeholder="note" value={b.note} onChange={(e) => setBreaks(breaks.map((x, j) => j === i ? { ...x, note: e.target.value } : x))} /><button className="btn btn-ghost btn-icon" onClick={() => setBreaks(breaks.filter((_, j) => j !== i))}><Icon name="x" className="h-3.5 w-3.5" /></button></div>)}
          <button className="btn btn-sm" onClick={() => setBreaks([...breaks, { startTime: '13:00', endTime: '13:30', note: 'Break' }])}><Icon name="plus" className="h-3.5 w-3.5" />Add break</button></div>
        <div className="grid grid-cols-2 gap-3"><div><label className="label">Places per window</label><input type="number" className="input" value={capacity} onChange={(e) => setCapacity(e.target.value as any)} /></div><div><label className="label">Window length (minutes)</label><div className="flex gap-1">{[30, 60].map((m) => <button key={m} className={`toggle-opt ${Number(windowMinutes) === m ? 'on' : ''}`} onClick={() => setWindowMinutes(m)}>{m}</button>)}</div></div></div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-clay" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> Replace this doctor's existing empty windows and breaks for the day (windows with bookings are kept)</label>
        <div className="flex justify-end gap-2 pt-2 border-t border-line"><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={save.isPending || !ranges.length} onClick={() => save.mutate()}><Icon name="check" />Save availability</button></div>
      </div>
    </Modal>
  );
}

function BlockModal({ day, practitionerId, onClose }: { day: string; practitionerId: string; onClose: () => void }) {
  const [f, setF] = useState({ kind: 'break', startTime: '13:00', endTime: '13:30', note: '' });
  const save = useMutation({ mutationFn: () => post('/calendar/blocks', { practitionerId, day, ...f, note: f.note || (f.kind === 'leave' ? 'Leave' : f.kind === 'break' ? 'Break' : 'Not available') }), onSuccess: () => { toast('Added'); onClose(); }, onError: (e: any) => toast(e?.body?.code ?? 'Failed', 'err') });
  return (
    <Modal title="Break or leave" subtitle="OP capacity in the affected windows drops automatically" onClose={onClose} width="max-w-md">
      <div className="space-y-3">
        <div className="flex gap-1">{[['break', 'Break'], ['leave', 'Leave / away'], ['other', 'Other']].map(([v, l]) => <button key={v} className={`toggle-opt ${f.kind === v ? 'on' : ''}`} onClick={() => setF({ ...f, kind: v })}>{l}</button>)}</div>
        <div className="flex items-center gap-2"><input type="time" className="input !w-auto" value={f.startTime} onChange={(e) => setF({ ...f, startTime: e.target.value })} /><span className="text-muted">to</span><input type="time" className="input !w-auto" value={f.endTime} onChange={(e) => setF({ ...f, endTime: e.target.value })} /></div>
        <input className="input" placeholder="Note (optional)" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
        <div className="flex justify-end gap-2 pt-2"><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>Add</button></div>
      </div>
    </Modal>
  );
}
