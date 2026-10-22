import { useState, type CSSProperties, type DragEvent, type ReactNode } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useNavigate, useOutletContext } from 'react-router';
import { get, post, patch, api, qc, today, errText, ApiError } from '../api';
import { can } from '../App';
import { Chip, Empty, Icon, Modal, PageHeader, Section, Segmented, Skeleton, toast, NumInput } from '../ui';
import { RoutineModal, routineSummary } from '../routine';
import { BookForm } from './Booking';
import { AppointmentDrawer } from '../apptDrawer';

const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const toHHMM = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const shift = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const monday = (d: string) => shift(d, -((new Date(d + 'T00:00:00Z').getUTCDay() + 6) % 7));
const nowMin = () => toMin(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()));
const label = (d: string, o: Intl.DateTimeFormatOptions) => new Date(d + 'T00:00:00').toLocaleDateString('en-IN', o);
const fullDay = (d: string) => label(d, { weekday: 'long', day: 'numeric', month: 'long' });
const isLongLeave = (b: any) => b.kind === 'leave' && toMin(b.endTime) - toMin(b.startTime) >= 600;
const DOT: Record<string, string> = { requested: 'var(--color-clay)', booked: 'var(--color-ink)', confirmed: 'var(--color-sky)', arrived: 'var(--color-sage)', no_show: 'var(--color-rose)' };
const OPEN = ['requested', 'booked', 'confirmed'];

type View = 'day' | 'week' | 'team' | 'list';
const VIEW_KEY = 'cal.view';
const savedView = (): View => {
  try { const v = localStorage.getItem(VIEW_KEY) as View | null; if (v && ['day', 'week', 'team', 'list'].includes(v)) return v; } catch { /* storage blocked */ }
  return typeof window !== 'undefined' && window.innerWidth < 768 ? 'list' : 'day';
};

/** Calendar: day / week / all doctors / list. Windows come from the weekly routine; click a window to book, drag a name to move it. */
export function Calendar() {
  const { cfg, perms, me } = useOutletContext<any>();
  const navTo = useNavigate();
  const [day, setDay] = useState(today());
  const [picked, setDoc] = useState<string>('');
  // Config can arrive after the first render, so the default doctor is derived, not frozen into state.
  const doc: string = picked || me.practitionerId || cfg?.practitioners?.[0]?.id || '';
  const [view, setViewState] = useState<View>(savedView);
  const setView = (v: View) => { setViewState(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* storage blocked */ } };
  const [booking, setBooking] = useState<any>(null);
  const canBook = can(perms, 'appointment.write');
  const step = view === 'week' ? 7 : 1;
  const practitioner = cfg?.practitioners.find((p: any) => p.id === doc);
  const weekStart = monday(day);

  const refresh = () => { ['calendar', 'sessions', 'appointments', 'queue'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); };
  const move = useMutation({
    mutationFn: ({ appt, to, overbook }: any) => patch(`/appointments/${appt.id}`, { sessionId: to.id, overbook }),
    onSuccess: (_r, { appt, to }: any) => { refresh(); toast(`${appt.name} moved to ${label(to.day, { weekday: 'short' })} ${to.startTime}${to.doctor ? ` · ${to.doctor}` : ''}`); },
    onError: (e: any, vars: any) => {
      if (e instanceof ApiError && e.body?.code === 'WINDOW_FULL' && can(perms, 'appointment.overbook') && !vars.overbook) {
        if (confirm(`${vars.to.startTime} is full. Overbook ${vars.appt.name} into it anyway?`)) move.mutate({ ...vars, overbook: true });
        return;
      }
      toast(e?.body?.code === 'WINDOW_FULL' ? 'That window is full' : errText(e), 'err');
    },
  });
  const onMove = (appt: any, to: any) => { if (appt.sessionId !== to.id) move.mutate({ appt, to }); };
  const docName = (id: string) => cfg?.practitioners.find((p: any) => p.id === id)?.name;
  const [openId, setOpenId] = useState<string | null>(null);
  const grid = { canBook, onOpen: (id: string) => setOpenId(id), onBook: (w: any) => setBooking(w), onMove: (a: any, w: any) => onMove(a, { ...w, doctor: view === 'team' ? docName(w.practitionerId) : undefined }) };

  const title = view === 'week' ? `${label(weekStart, { day: 'numeric', month: 'short' })} – ${label(shift(weekStart, 6), { day: 'numeric', month: 'short' })}`
    : view === 'team' ? fullDay(day) : practitioner ? `${practitioner.name} · ${fullDay(day)}` : fullDay(day);

  return (
    <div>
      <PageHeader title={title} subtitle={view === 'week' && practitioner ? practitioner.name : view === 'team' ? 'All doctors and procedure rooms' : undefined}>
        <Segmented<View> value={view} onChange={setView} options={[{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }, { value: 'team', label: 'All doctors' }, { value: 'list', label: 'List' }]} />
        <div className="flex items-center gap-1 card !p-1 !rounded-full">
          <button className="btn btn-ghost btn-icon" aria-label={view === 'week' ? 'Previous week' : 'Previous day'} onClick={() => setDay(shift(day, -step))}><Icon name="chevL" /></button>
          <input type="date" aria-label="Date" className="input !w-auto !border-0 !shadow-none !py-1.5 text-center" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} />
          <button className="btn btn-ghost btn-icon" aria-label={view === 'week' ? 'Next week' : 'Next day'} onClick={() => setDay(shift(day, step))}><Icon name="chevR" /></button>
        </div>
        {day !== today() && <button className="btn btn-sm" onClick={() => setDay(today())}>Today</button>}
        {canBook && <button className="btn btn-accent" onClick={() => navTo("?book=1")}><Icon name="plus" />New booking</button>}
        {view !== 'team' && (cfg?.practitioners ?? []).length > 1 && <select aria-label="Doctor" className="input !w-auto" value={doc} onChange={(e) => setDoc(e.target.value)}>{cfg.practitioners.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}
      </PageHeader>

      {view === 'day' && <DayView day={day} doc={doc} practitioner={practitioner} cfg={cfg} perms={perms} me={me} grid={grid} />}
      {view === 'week' && <WeekView from={weekStart} doc={doc} grid={grid} onPickDay={(d) => { setDay(d); setView('day'); }} />}
      {view === 'team' && <TeamView day={day} cfg={cfg} grid={grid} />}
      {view === 'list' && <ListView day={day} doc={doc} grid={grid} />}

      {openId && <AppointmentDrawer id={openId} cfg={cfg} canWrite={canBook} onClose={() => setOpenId(null)} />}
      {booking && (
        <Modal title="Book" subtitle={`${label(booking.day, { weekday: 'short', day: 'numeric', month: 'short' })} · ${booking.startTime}–${booking.endTime}${docName(booking.practitionerId) ? ` · ${docName(booking.practitionerId)}` : ''}`} onClose={() => setBooking(null)} width="max-w-md">
          <BookForm session={booking} arriveEarly={cfg?.tenant.settings.scheduling?.arriveEarlyMinutes ?? 30} onDone={() => { refresh(); setBooking(null); }} />
        </Modal>
      )}
    </div>
  );
}

const Legend = ({ hint }: { hint?: string }) => (
  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted mb-3">
    {[['Requested', DOT.requested], ['Booked', DOT.booked], ['Confirmed', DOT.confirmed], ['Arrived', DOT.arrived], ['No-show', DOT.no_show], ['Procedure', '#9DB5CC']].map(([l, c]) => <span key={l} className="inline-flex items-center gap-1.5"><i className="h-2 w-2 rounded-full" style={{ background: c }} />{l}</span>)}
    {hint && <span className="ml-auto">{hint}</span>}
  </div>
);

type Grid = { canBook: boolean; onOpen: (id: string) => void; onBook: (w: any) => void; onMove: (a: any, w: any) => void };
type Col = { key: string; head: ReactNode; windows: any[]; blocks: any[]; procs: any[]; day: string; tint?: string };

/** Shared time grid: one column per day or per doctor/room. */
function TimeGrid({ cols, grid, px = 1.15, minCol = 140, wide = false }: { cols: Col[]; grid: Grid; px?: number; minCol?: number; wide?: boolean }) {
  const all = cols.flatMap((c) => [...c.windows, ...c.blocks.filter((b) => !isLongLeave(b)), ...c.procs]);
  const start = all.length ? Math.floor(Math.min(...all.map((x) => toMin(x.startTime))) / 60) * 60 : 10 * 60;
  const end = all.length ? Math.ceil(Math.max(...all.map((x) => toMin(x.endTime))) / 60) * 60 : 19 * 60;
  const y = (t: string) => (toMin(t) - start) * px;
  const h = (s: string, e: string) => Math.max(20, (toMin(e) - toMin(s)) * px);
  const height = (end - start) * px + 8;
  const hours = Array.from({ length: (end - start) / 60 + 1 }, (_, i) => start + i * 60);
  const now = nowMin();
  return (
    <div className="glass overflow-x-auto overflow-y-hidden anim-fade-up">
      <div className="grid" style={{ gridTemplateColumns: `52px repeat(${cols.length}, minmax(${minCol}px, 1fr))`, minWidth: 52 + cols.length * minCol }}>
        <div><div className="h-16 border-b border-line/70" /><div className="relative" style={{ height }}>{hours.map((m) => <span key={m} className="absolute right-2 text-[11px] text-muted" style={{ top: (m - start) * px - 7 }}>{toHHMM(m)}</span>)}</div></div>
        {cols.map((c) => {
          const longLeave = c.blocks.find(isLongLeave);
          return (
            <div key={c.key} className="border-l border-line/60 min-w-0" style={{ background: c.tint }}>
              <div className="h-16 border-b border-line/70 px-3 flex items-center gap-2 min-w-0">{c.head}</div>
              <div className="relative" style={{ height }}>
                {hours.map((m) => <div key={m} className="absolute inset-x-0 border-t border-dashed border-line/70" style={{ top: (m - start) * px }} />)}
                {longLeave && <div className="absolute inset-1 rounded-xl px-2 py-1.5 text-xs text-muted" style={{ background: 'repeating-linear-gradient(135deg, var(--color-paper-2) 0 6px, var(--color-paper) 6px 12px)', border: '1px dashed var(--color-line-2)' }}><b className="text-ink-2">Away</b> {longLeave.note && longLeave.note !== 'Away' ? `· ${longLeave.note}` : ''}{c.windows.reduce((n, w) => n + w.allocated, 0) > 0 && <div className="mt-0.5 text-rose">{c.windows.reduce((n, w) => n + w.allocated, 0)} booked to call</div>}</div>}
                {!longLeave && c.windows.map((w) => {
                  const narrow = c.procs.some((p) => toMin(p.startTime) < toMin(w.endTime) && toMin(p.endTime) > toMin(w.startTime));
                  return <WindowBox key={w.id} w={{ ...w, day: c.day }} grid={grid} wide={wide} style={{ top: y(w.startTime) + 2, height: h(w.startTime, w.endTime) - 4, right: narrow ? '42%' : 4 }} />;
                })}
                {c.blocks.filter((b) => !isLongLeave(b)).map((b) => (
                  <div key={b.id} className="absolute left-1 right-1 rounded-lg px-2 py-0.5 text-[11px] text-muted overflow-hidden pointer-events-none" style={{ top: y(b.startTime) + 1, height: h(b.startTime, b.endTime) - 2, background: 'repeating-linear-gradient(135deg, rgba(23,25,26,.06) 0 6px, rgba(23,25,26,.015) 6px 12px)', border: '1px dashed var(--color-line-2)', zIndex: 1 }}><b className="text-ink-2">{b.note ?? b.kind}</b> {b.startTime}–{b.endTime}</div>
                ))}
                {c.procs.map((p) => (
                  <div key={p.id} title={`${p.procedure ?? 'Procedure'} · ${p.patient} · ${p.startTime}–${p.endTime}${p.room ? ` · ${p.room}` : ''}`} className="absolute rounded-lg px-2 py-1 text-[11px] overflow-hidden" style={{ top: y(p.startTime) + 2, height: h(p.startTime, p.endTime) - 4, left: c.windows.length && !c.tint ? '60%' : 4, right: 4, background: 'var(--color-sky-soft)', border: '1px solid #c7d4e0', color: 'var(--color-sky)' }}>
                    <div className="font-semibold truncate">{p.procedure ?? 'Procedure'}</div><div className="truncate">{p.patient}{c.tint ? (p.doctor ? ` · ${p.doctor}` : '') : (p.room ? ` · ${p.room}` : '')}</div>
                  </div>
                ))}
                {c.day === today() && now >= start && now <= end && <div className="absolute inset-x-0 border-t-2 border-clay pointer-events-none" style={{ top: (now - start) * px, zIndex: 2 }} />}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** One OP window: names inside, click to book, drop a name to move it here. */
function WindowBox({ w, grid, style, wide }: { w: any; grid: Grid; style: CSSProperties; wide: boolean }) {
  const nav = useNavigate();
  const [over, setOver] = useState(false);
  if (w.day < today()) grid = { ...grid, canBook: false }; // the past is read-only
  const tone = w.effectiveCapacity === 0 || w.free <= 0 ? 'rose' : w.free <= 2 ? 'amber' : 'sage';
  const appts: any[] = w.appointments ?? [];
  const rows = Math.max(0, Math.floor(((style.height as number) - 20) / 16));
  const fit = wide ? rows * 3 : rows;
  const shown = appts.length > fit ? appts.slice(0, Math.max(0, fit - 1)) : appts;
  const more = appts.length - shown.length;
  const drop = (e: DragEvent) => { e.preventDefault(); setOver(false); try { const a = JSON.parse(e.dataTransfer.getData('application/x-appt')); grid.onMove(a, w); } catch { /* not ours */ } };
  return (
    <div className={`absolute left-1 rounded-xl border px-2 py-1 overflow-hidden transition-shadow ${grid.canBook ? 'cursor-pointer hover:shadow-md' : ''}`}
      style={{ ...style, background: over ? '#fff' : 'rgba(255,255,255,.88)', borderColor: over ? 'var(--color-ink)' : 'var(--color-line)', boxShadow: over ? '0 0 0 2px var(--color-ink)' : undefined, opacity: w.effectiveCapacity === 0 ? 0.6 : 1 }}
      onClick={() => grid.canBook && grid.onBook(w)}
      onDragOver={grid.canBook ? (e) => { if (e.dataTransfer.types.includes('application/x-appt')) { e.preventDefault(); setOver(true); } } : undefined}
      onDragLeave={() => setOver(false)} onDrop={grid.canBook ? drop : undefined}>
      <div className="flex items-center gap-1.5 text-xs">
        {grid.canBook ? <button type="button" className="font-semibold hover:underline" aria-label={`Book into ${w.startTime}–${w.endTime}`} onClick={(e) => { e.stopPropagation(); grid.onBook(w); }}>{w.startTime}</button> : <b>{w.startTime}</b>}
        {w.reductions?.length > 0 && <span className="text-[10.5px] text-amber truncate">{w.reductions.map((r: any) => r.note ?? r.kind).join(', ')}</span>}
        <Chip tone={tone as any} className="ml-auto !py-0 !px-2 !text-[10.5px]">{w.allocated}/{w.effectiveCapacity}</Chip>
      </div>
      <div className={wide ? 'grid grid-cols-3 gap-x-3' : ''}>
        {shown.map((a) => (
          <div key={a.id} draggable={grid.canBook && OPEN.includes(a.status)} title={`${a.name}${a.phone ? ` · ${a.phone}` : ''} · ${a.status.replace('_', '-')}${a.note ? ` · ${a.note}` : ''}`}
            onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.setData('application/x-appt', JSON.stringify({ id: a.id, sessionId: w.id, name: a.name })); e.dataTransfer.effectAllowed = 'move'; }}
            onClick={(e) => { e.stopPropagation(); grid.onOpen(a.id); }}
            className={`flex items-center gap-1.5 text-[11.5px] leading-4 truncate hover:underline ${OPEN.includes(a.status) && grid.canBook ? 'cursor-grab' : 'cursor-pointer'} ${a.status === 'requested' ? 'italic' : ''} ${a.status === 'no_show' ? 'line-through text-rose' : ''}`}>
            {a.color && <i className="h-3 w-[3px] rounded-full shrink-0" style={{ background: a.color }} />}<i className="h-1.5 w-1.5 rounded-full shrink-0" style={{ background: DOT[a.status] }} /><span className="truncate">{a.name}</span>
          </div>
        ))}
      </div>
      {more > 0 && <div className="text-[11px] text-muted">+{more} more</div>}
    </div>
  );
}

function DayView({ day, doc, practitioner, cfg, perms, me, grid }: { day: string; doc: string; practitioner: any; cfg: any; perms: string[]; me: any; grid: Grid }) {
  const cal = useQuery({ queryKey: ['calendar', day, doc], queryFn: () => get(`/calendar?day=${day}${doc ? `&practitionerId=${doc}` : ''}`), refetchInterval: 15000, enabled: !!doc });
  const [modal, setModal] = useState<null | 'routine' | 'break' | 'early' | 'editday'>(null);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['calendar'] }); qc.invalidateQueries({ queryKey: ['sessions'] }); };
  const addBlock = useMutation({ mutationFn: (b: any) => post('/calendar/blocks', { practitionerId: doc, day, ...b }), onSuccess: (_r, b: any) => { refresh(); toast(b.kind === 'leave' ? 'Marked away · reception sees it now' : 'Added · capacity adjusted'); }, onError: (e: any) => toast(errText(e), 'err') });
  const delBlock = useMutation({ mutationFn: (id: string) => api('DELETE', `/calendar/blocks/${id}`), onSuccess: () => { refresh(); toast('Removed', 'info'); } });
  const setState = useMutation({ mutationFn: ({ id, state, reason }: any) => patch(`/procedure-sessions/${id}`, { state, reason }), onSuccess: () => { refresh(); qc.invalidateQueries({ queryKey: ['worklist'] }); toast('Updated'); } });
  const writable = can(perms, 'appointment.write') || me.practitionerId === doc;
  const d = cal.data;
  const totals = d ? d.windows.reduce((s: any, w: any) => ({ a: s.a + w.allocated, c: s.c + w.effectiveCapacity }), { a: 0, c: 0 }) : null;
  const firstStart = d?.windows[0]?.startTime; const lastEnd = d?.windows[d.windows.length - 1]?.endTime;
  const awayToday = d?.blocks.some(isLongLeave);
  const dayLabel = fullDay(day);
  const exceptions = d ? [...d.blocks.map((b: any) => ({ ...b, type: 'block' })), ...d.procedures.filter((p: any) => p.practitionerId === doc).map((p: any) => ({ ...p, type: 'procedure' }))].sort((a, b) => toMin(a.startTime) - toMin(b.startTime)) : [];

  return (
    <>
      <div className="text-sm text-muted -mt-3 mb-4">{practitioner?.routine ? <>Routine: {routineSummary(practitioner.routine)}</> : <span className="text-amber">No weekly routine yet</span>}{totals ? <> · <b className="text-ink">{totals.a}</b> of {totals.c} OP places taken{d.procedures.length ? ` · ${d.procedures.length} procedure${d.procedures.length === 1 ? '' : 's'}` : ''}</> : null}</div>
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
        <div className="min-w-0">
          <Legend hint={grid.canBook ? 'Click a window to book · drag a name to move it' : undefined} />
          {cal.isLoading || !d ? <Skeleton rows={6} /> : d.windows.length === 0 && d.blocks.length === 0 && d.procedures.length === 0 ? (
            <div className="card"><Empty icon="calendar" title={practitioner?.routine ? 'Not a working day in the routine' : 'No routine set for this doctor'} hint={writable ? (practitioner?.routine ? 'Use “Edit this day’s windows” for a one-off day.' : 'Set the weekly routine once; every day fills itself.') : undefined} />
              {writable && !practitioner?.routine && <div className="flex justify-center pb-6"><button className="btn btn-primary" onClick={() => setModal('routine')}><Icon name="spark" />Set weekly routine</button></div>}</div>
          ) : <TimeGrid wide px={1.3} minCol={320} grid={grid} cols={[{ key: day, day, head: <span className="text-sm font-semibold">{practitioner?.name ?? 'OP windows'}</span>, windows: d.windows, blocks: d.blocks, procs: d.procedures.filter((p: any) => p.practitionerId === doc) }]} />}
        </div>

        <div className="space-y-4">
          <div className="card anim-fade-up" style={{ animationDelay: '60ms' }}>
            <div className="text-[11px] uppercase tracking-wider text-muted">Your routine</div>
            <div className="serif text-xl mt-1.5">{routineSummary(practitioner?.routine)}</div>
            {practitioner?.routine && <div className="text-sm text-muted mt-1">{practitioner.routine.capacity} places per {practitioner.routine.windowMinutes === 30 ? 'half hour' : 'hour'}. Windows for every day come from this automatically.</div>}
            {writable && <button className="btn btn-sm mt-3" onClick={() => setModal('routine')}><Icon name="edit" className="h-3.5 w-3.5" />{practitioner?.routine ? 'Change routine' : 'Set routine'}</button>}
          </div>
          <Section title="Today's exceptions" delay={90}>
            {!d ? <Skeleton rows={2} /> : awayToday ? <div className="p-4 text-sm flex items-center gap-2"><Chip tone="rose">away</Chip>Whole day. {writable && <button className="btn btn-sm btn-ghost ml-auto" onClick={() => delBlock.mutate(d.blocks.find(isLongLeave).id)}>Undo</button>}</div>
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
    </>
  );
}

function WeekView({ from, doc, grid, onPickDay }: { from: string; doc: string; grid: Grid; onPickDay: (d: string) => void }) {
  const q = useQuery({ queryKey: ['calendar', 'range', from, doc], queryFn: () => get(`/calendar/range?from=${from}&days=7${doc ? `&practitionerId=${doc}` : ''}`), refetchInterval: 30000, enabled: !!doc });
  if (q.isLoading || !q.data) return <Skeleton rows={8} />;
  // Sunday only shows when something is on it.
  const days = q.data.filter((d: any, i: number) => i < 6 || d.windows.length || d.procedures.length);
  const tot = days.reduce((s: any, d: any) => ({ a: s.a + d.windows.reduce((n: number, w: any) => n + w.allocated, 0), c: s.c + d.windows.reduce((n: number, w: any) => n + w.effectiveCapacity, 0), p: s.p + d.procedures.length }), { a: 0, c: 0, p: 0 });
  return (
    <>
      <div className="text-sm text-muted -mt-3 mb-4"><b className="text-ink">{tot.a}</b> of {tot.c} OP places booked{tot.p ? ` · ${tot.p} procedure${tot.p === 1 ? '' : 's'}` : ''}</div>
      <Legend hint={grid.canBook ? 'Click a window to book · drag a name to move it' : undefined} />
      <TimeGrid grid={grid} px={1.4} minCol={150} cols={days.map((d: any) => {
        const a = d.windows.reduce((n: number, w: any) => n + w.allocated, 0), c = d.windows.reduce((n: number, w: any) => n + w.effectiveCapacity, 0);
        const isToday = d.day === today();
        return { key: d.day, day: d.day, windows: d.windows, blocks: d.blocks, procs: d.procedures, tint: undefined,
          head: <button type="button" className="text-left min-w-0" onClick={() => onPickDay(d.day)} aria-label={`Open ${fullDay(d.day)}`}>
            <div className={`text-[11px] font-bold uppercase tracking-wider ${isToday ? 'text-clay' : 'text-muted'}`}>{label(d.day, { weekday: 'short' })}</div>
            <div className="flex items-baseline gap-1.5"><span className="text-lg font-semibold">{label(d.day, { day: 'numeric' })}</span><span className="text-[11px] text-muted truncate">{d.blocks.some(isLongLeave) ? 'away' : c ? `${a}/${c}` : 'off'}</span></div>
          </button> };
      })} />
    </>
  );
}

function TeamView({ day, cfg, grid }: { day: string; cfg: any; grid: Grid }) {
  const q = useQuery({ queryKey: ['calendar', day, 'all'], queryFn: () => get(`/calendar?day=${day}`), refetchInterval: 15000 });
  if (q.isLoading || !q.data) return <Skeleton rows={8} />;
  const d = q.data;
  const docs = (cfg?.practitioners ?? []).filter((p: any) => p.active !== false);
  const rooms = (cfg?.rooms ?? []).filter((r: any) => r.active !== false);
  const tot = d.windows.reduce((s: any, w: any) => ({ a: s.a + w.allocated, c: s.c + w.effectiveCapacity }), { a: 0, c: 0 });
  const head = (name: string, sub: string, room = false) => (<>
    <span className={`h-8 w-8 rounded-full grid place-items-center text-[11px] font-bold shrink-0 ${room ? 'bg-sky-soft text-sky' : 'bg-ink text-white'}`}>{room ? 'R' : name.replace(/^Dr\.?\s*/i, '').split(/\s+/).map((x) => x[0]).slice(0, 2).join('').toUpperCase()}</span>
    <div className="min-w-0"><div className="text-sm font-semibold truncate">{name}</div><div className="text-[11px] text-muted truncate">{sub}</div></div></>);
  const cols: Col[] = [
    ...docs.map((p: any) => {
      const ws = d.windows.filter((w: any) => w.practitionerId === p.id);
      return { key: p.id, day, windows: ws, blocks: d.blocks.filter((b: any) => b.practitionerId === p.id), procs: [], head: head(p.name, ws.length ? `${ws.reduce((n: number, w: any) => n + w.allocated, 0)} of ${ws.reduce((n: number, w: any) => n + w.effectiveCapacity, 0)} booked` : 'not working') };
    }),
    ...rooms.map((r: any) => ({ key: r.id, day, windows: [], blocks: [], tint: 'rgba(221,231,242,.18)', procs: d.procedures.filter((p: any) => p.roomId === r.id), head: head(r.name, (r.capabilities ?? []).join(' · ') || 'room', true) })),
  ];
  const unassigned = d.windows.filter((w: any) => !w.practitionerId);
  if (unassigned.length) cols.splice(docs.length, 0, { key: 'any', day, windows: unassigned, blocks: [], procs: [], head: head('Any doctor', 'pooled OP') });
  return (
    <>
      <div className="text-sm text-muted -mt-3 mb-4"><b className="text-ink">{tot.a}</b> of {tot.c} OP places booked · {d.procedures.length} procedure{d.procedures.length === 1 ? '' : 's'} in rooms</div>
      <Legend hint={grid.canBook ? 'Drag a name to another doctor to hand the patient over' : undefined} />
      <TimeGrid grid={grid} px={1.25} minCol={170} cols={cols} />
    </>
  );
}

function ListView({ day, doc, grid }: { day: string; doc: string; grid: Grid }) {
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['calendar', day, doc], queryFn: () => get(`/calendar?day=${day}${doc ? `&practitionerId=${doc}` : ''}`), refetchInterval: 15000, enabled: !!doc });
  if (q.isLoading || !q.data) return <Skeleton rows={6} />;
  const d = q.data;
  const items = [...d.windows.map((w: any) => ({ ...w, type: 'w', day })), ...d.procedures.map((p: any) => ({ ...p, type: 'p' }))].sort((a, b) => toMin(a.startTime) - toMin(b.startTime));
  if (d.blocks.some(isLongLeave)) return <div className="card"><Empty icon="door" title="Away this day" hint={`${d.windows.reduce((n: number, w: any) => n + w.allocated, 0)} booked patients may need a call.`} /></div>;
  if (!items.length) return <div className="card"><Empty icon="calendar" title="Nothing on this day" /></div>;
  const tone = (w: any) => (w.free <= 0 ? 'rose' : w.free <= 2 ? 'amber' : 'sage');
  return (
    <div className="space-y-3 max-w-2xl">
      {items.map((x: any) => x.type === 'p' ? (
        <div key={x.id} className="rounded-2xl px-4 py-3 anim-fade-up" style={{ background: 'var(--color-sky-soft)', border: '1px solid #c7d4e0', color: 'var(--color-sky)' }}>
          <div className="flex items-center gap-2 font-semibold"><span>{x.startTime} {x.procedure ?? 'Procedure'}</span><span className="ml-auto text-xs font-normal">{x.room ?? ''}</span></div>
          <div className="text-sm">{x.patient} · sitting {x.sittingNo}</div>
        </div>
      ) : (
        <div key={x.id} className="card !py-3 anim-fade-up">
          <div className="flex items-center gap-2"><b>{x.startTime}–{x.endTime}</b>{x.reductions?.length > 0 && <span className="text-xs text-amber truncate">{x.reductions.map((r: any) => r.note ?? r.kind).join(', ')}</span>}<Chip tone={tone(x) as any} className="ml-auto">{x.allocated}/{x.effectiveCapacity}</Chip></div>
          {(x.appointments ?? []).map((a: any) => (
            <button key={a.id} type="button" onClick={() => grid.onOpen(a.id)} className={`flex w-full items-center gap-2.5 min-h-11 border-t border-line/60 text-left text-sm ${a.status === 'no_show' ? 'line-through text-rose' : ''}`}>
              {a.color && <i className="h-4 w-[3px] rounded-full shrink-0" style={{ background: a.color }} />}<i className="h-2 w-2 rounded-full shrink-0" style={{ background: DOT[a.status] }} /><span className="flex-1 truncate">{a.name}{a.service ? <span className="text-xs text-muted"> · {a.service}</span> : null}</span><span className="text-xs text-muted">{a.status.replace('_', '-')}</span>
            </button>
          ))}
          {grid.canBook && x.free > 0 && x.day >= today() && <button type="button" className="flex w-full items-center min-h-11 border-t border-line/60 text-sm text-muted hover:text-ink" onClick={() => grid.onBook(x)}>+ Book into a free place</button>}
        </div>
      ))}
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
