import { useState, type CSSProperties, type DragEvent, type ReactNode } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useNavigate, useOutletContext } from 'react-router';
import { get, post, patch, api, qc, today, errText, ApiError } from '../api';
import { can } from '../App';
import { Chip, Empty, Icon, Modal, PageHeader, Section, Segmented, Skeleton, ask, toast, NumInput } from '../ui';
import { RoutineModal, routineSummary } from '../routine';
import { BookForm } from './Booking';
import { AppointmentDrawer } from '../apptDrawer';
import { PhotoCapture } from '../photos';

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
const savedView = (isDoctor: boolean): View => {
  try { const v = localStorage.getItem(VIEW_KEY) as View | null; if (v && ['day', 'week', 'team', 'list'].includes(v)) return v; } catch { /* storage blocked */ }
  return typeof window !== 'undefined' && window.innerWidth < 768 ? 'list' : isDoctor ? 'week' : 'team';
};

/** Calendar: day / week / all doctors / list. Windows come from the weekly routine; click a window to book, drag a name to move it. */
export function Calendar() {
  const { cfg, perms, me } = useOutletContext<any>();
  const navTo = useNavigate();
  const [day, setDay] = useState(today());
  const [picked, setDoc] = useState<string>('');
  // Config can arrive after the first render, so the default doctor is derived, not frozen into state.
  const doc: string = picked || me.practitionerId || cfg?.practitioners?.[0]?.id || '';
  const [view, setViewState] = useState<View>(() => savedView(!!me.practitionerId));
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
        ask({ title: `${vars.to.startTime} is full`, body: `Move ${vars.appt.name} into it anyway? It will go over the places set for that window.`, confirmLabel: 'Overbook', cancelLabel: 'Leave it' }).then((r) => { if (r) move.mutate({ ...vars, overbook: true }); });
        return;
      }
      toast(e?.body?.code === 'WINDOW_FULL' ? 'That window is full' : errText(e), 'err');
    },
  });
  const onMove = (appt: any, to: any) => { if (appt.sessionId !== to.id) move.mutate({ appt, to }); };
  const docName = (id: string) => cfg?.practitioners.find((p: any) => p.id === id)?.name;
  const [openId, setOpenId] = useState<string | null>(null);
  const [show, setShow] = useState<Show>('all');
  const [svc, setSvc] = useState(''); const [status, setStatus] = useState('');
  const [avail, setAvail] = useState<string | null>(null); // day being changed in the availability dialog
  const [routine, setRoutine] = useState(false);
  const [editDay, setEditDay] = useState<string | null>(null);
  const canEditDays = canBook || !!me.practitionerId;
  /** Remove a day change (break, late start, away). Undo puts it back exactly as it was. */
  const removeBlock = async (b: any) => {
    try { await api('DELETE', `/calendar/blocks/${b.id}`); } catch (e) { toast(errText(e), 'err'); return; }
    refresh(); toast(`Removed: ${b.note ?? b.kind}`, 'info', { label: 'Undo', run: () => post('/calendar/blocks', { practitionerId: b.practitionerId, roomId: b.roomId, day: b.day, startTime: b.startTime, endTime: b.endTime, kind: b.kind, note: b.note ?? undefined }).then(refresh, (e) => toast(errText(e), 'err')) });
  };
  const grid = { svc, setSvc, status, setStatus, services: cfg?.services ?? [], show, setShow, canBook, onRemoveBlock: canEditDays ? removeBlock : undefined, onOpen: (id: string) => setOpenId(id), onBook: (w: any) => setBooking(w), onMove: (a: any, w: any) => onMove(a, { ...w, doctor: view === 'team' ? docName(w.practitionerId) : undefined }) };

  const title = view === 'week' ? `${label(weekStart, { day: 'numeric', month: 'short' })} – ${label(shift(weekStart, 6), { day: 'numeric', month: 'short' })}`
    : fullDay(day);

  return (
    <div>
      <PageHeader title={title}>
        <Segmented<View> value={view} onChange={setView} options={[{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }, { value: 'team', label: 'All doctors' }, { value: 'list', label: 'List' }]} />
        <div className="flex items-center gap-1 card !p-1 !rounded-full">
          <button className="btn btn-ghost btn-icon" aria-label={view === 'week' ? 'Previous week' : 'Previous day'} onClick={() => setDay(shift(day, -step))}><Icon name="chevL" /></button>
          <input type="date" aria-label="Date" className="input !w-auto !border-0 !shadow-none !py-1.5 text-center" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} />
          <button className="btn btn-ghost btn-icon" aria-label={view === 'week' ? 'Next week' : 'Next day'} onClick={() => setDay(shift(day, step))}><Icon name="chevR" /></button>
        </div>
        {day !== today() && <button className="btn btn-sm" onClick={() => setDay(today())}>Today</button>}
        {view !== 'team' && (cfg?.practitioners ?? []).length > 1 && <select aria-label="Doctor" className="input !w-auto" value={doc} onChange={(e) => setDoc(e.target.value)}>{cfg.practitioners.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}
      </PageHeader>

      {view === 'day' && <DayView day={day} doc={doc} practitioner={practitioner} cfg={cfg} perms={perms} me={me} grid={grid} onAvailability={canEditDays && doc ? (d) => setAvail(d < today() ? today() : d) : undefined} />}
      {view === 'week' && <WeekView from={weekStart} doc={doc} docName={practitioner?.name} grid={grid} onOpenDay={(d) => { setDay(d); setView('day'); }} onAvailability={(d) => setAvail(d)} />}
      {avail && doc && <AvailabilityModal day={avail} doc={doc} docName={practitioner?.name ?? 'Doctor'} onRoutine={() => { setAvail(null); setRoutine(true); }} onEditDay={(d) => { setAvail(null); setEditDay(d); }} onClose={() => setAvail(null)} />}
      {editDay && doc && <EditDayModal day={editDay} practitionerId={doc} cfg={cfg} onClose={() => { setEditDay(null); refresh(); }} />}
      {routine && practitioner && <RoutineModal practitionerId={doc} name={practitioner.name} initial={practitioner.routine} onClose={() => setRoutine(false)} />}
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

type Show = 'all' | 'appts' | 'procs';
/** Counts for what is on screen, a filter to see only appointments or only procedures, and the colour key. */
const Legend = ({ hint, days, grid }: { hint?: string; days?: any[]; grid?: Grid }) => {
  const appts = (days ?? []).reduce((n, d) => n + d.windows.reduce((m: number, w: any) => m + (w.appointments?.length ?? 0), 0), 0);
  const procs = (days ?? []).reduce((n, d) => n + d.procedures.length, 0);
  return (<>
  {grid && days && <div className="mb-3 flex flex-wrap items-center gap-3">
    <Segmented<Show> value={grid.show} onChange={grid.setShow} options={[{ value: 'all', label: 'All', count: appts + procs }, { value: 'appts', label: 'Appointments', count: appts }, { value: 'procs', label: 'Procedures', count: procs }]} />
    {grid.services.length > 0 && grid.show !== 'procs' && <select aria-label="Visit type" className="input !w-auto !py-2" value={grid.svc} onChange={(e) => grid.setSvc(e.target.value)}><option value="">All visit types</option>{grid.services.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}
    {grid.show !== 'procs' && <select aria-label="Status" className="input !w-auto !py-2" value={grid.status} onChange={(e) => grid.setStatus(e.target.value)}><option value="">All statuses</option>{[['requested', 'Requested'], ['booked', 'Booked'], ['confirmed', 'Confirmed'], ['arrived', 'Arrived'], ['no_show', 'No-show']].map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>}
    {(grid.svc || grid.status || grid.show !== 'all') && <button className="btn btn-ghost btn-sm" onClick={() => { grid.setSvc(''); grid.setStatus(''); grid.setShow('all'); }}>Clear filters</button>}
    <details className="relative"><summary className="btn btn-ghost btn-sm list-none cursor-pointer">Key</summary>
      <div className="menu anim-menu !left-0 !right-auto !w-56 p-3 space-y-1.5 text-xs">{[['Requested', DOT.requested], ['Booked', DOT.booked], ['Confirmed', DOT.confirmed], ['Arrived', DOT.arrived], ['No-show', DOT.no_show], ['Procedure', '#9DB5CC']].map(([l, c]) => <div key={l} className="flex items-center gap-2"><i className="h-2 w-2 rounded-full" style={{ background: c }} />{l}</div>)}{hint && <div className="pt-1.5 border-t border-line text-muted">{hint}</div>}</div></details>
  </div>}
  </>);
};

type Grid = { svc: string; setSvc: (s: string) => void; status: string; setStatus: (s: string) => void; services: any[]; show: Show; setShow: (s: Show) => void; canBook: boolean; onRemoveBlock?: (b: any) => void; onOpen: (id: string) => void; onBook: (w: any) => void; onMove: (a: any, w: any) => void };
type Col = { key: string; head: ReactNode; windows: any[]; blocks: any[]; procs: any[]; day: string; tint?: string };

/** Shared time grid: one column per day or per doctor/room. */
function TimeGrid({ cols: allCols, grid, px = 1.15, minCol = 140, wide = false }: { cols: Col[]; grid: Grid; px?: number; minCol?: number; wide?: boolean }) {
  const cols = allCols.map((c) => grid.show === 'procs' ? { ...c, windows: [] } : grid.show === 'appts' ? { ...c, procs: [] } : c);
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
        <div><div className={`${cols.some((c) => c.head) ? 'h-16' : 'h-2'} border-b border-line/70`} /><div className="relative" style={{ height }}>{hours.map((m) => <span key={m} className="absolute right-2 text-[11px] text-muted" style={{ top: (m - start) * px - 7 }}>{toHHMM(m)}</span>)}</div></div>
        {cols.map((c) => {
          const longLeave = c.blocks.find(isLongLeave);
          return (
            <div key={c.key} className="border-l border-line/60 min-w-0" style={{ background: c.tint }}>
              <div className={`${cols.some((x) => x.head) ? 'h-16' : 'h-2'} border-b border-line/70 px-3 flex items-center gap-2 min-w-0`}>{c.head}</div>
              <div className="relative" style={{ height }}>
                {hours.map((m) => <div key={m} className="absolute inset-x-0 border-t border-dashed border-line/70" style={{ top: (m - start) * px }} />)}
                {longLeave && <div className="absolute inset-1 rounded-xl px-2 py-1.5 text-xs text-muted" style={{ background: 'repeating-linear-gradient(135deg, var(--color-paper-2) 0 6px, var(--color-paper) 6px 12px)', border: '1px dashed var(--color-line-2)' }}><b className="text-ink-2">Away</b> {longLeave.note && longLeave.note !== 'Away' ? `· ${longLeave.note}` : ''}{c.windows.reduce((n, w) => n + w.allocated, 0) > 0 && <div className="mt-0.5 text-rose">{c.windows.reduce((n, w) => n + w.allocated, 0)} booked to call</div>}{grid.onRemoveBlock && <button className="btn btn-sm mt-2" onClick={() => grid.onRemoveBlock!(longLeave)}>Not away after all</button>}</div>}
                {!longLeave && [...c.windows].sort((a, b) => toMin(a.startTime) - toMin(b.startTime)).map((w, i, ws) => i > 0 && toMin(w.startTime) > toMin(ws[i - 1].endTime) && (
                  <div key={'gap' + w.id} className="pointer-events-none absolute left-1 right-1 rounded-lg px-2 py-1 text-[11px] text-muted/80" style={{ top: y(ws[i - 1].endTime) + 2, height: h(ws[i - 1].endTime, w.startTime) - 4, background: 'repeating-linear-gradient(135deg, rgba(23,25,26,.035) 0 6px, transparent 6px 12px)' }}>Not working {ws[i - 1].endTime}–{w.startTime}</div>
                ))}
                {!longLeave && c.windows.map((w) => {
                  const narrow = c.procs.some((p) => toMin(p.startTime) < toMin(w.endTime) && toMin(p.endTime) > toMin(w.startTime));
                  return <WindowBox key={w.id} w={{ ...w, day: c.day }} grid={grid} wide={wide} style={{ top: y(w.startTime) + 2, height: h(w.startTime, w.endTime) - 4, right: narrow ? '42%' : 4 }} />;
                })}
                {c.blocks.filter((b) => !isLongLeave(b)).map((b) => (
                  <div key={b.id} className="absolute left-1 right-1 flex items-start gap-1 rounded-lg px-2 py-0.5 text-[11px] text-muted overflow-hidden" style={{ top: y(b.startTime) + 1, height: h(b.startTime, b.endTime) - 2, background: 'repeating-linear-gradient(135deg, rgba(23,25,26,.06) 0 6px, rgba(23,25,26,.015) 6px 12px)', border: '1px dashed var(--color-line-2)', zIndex: 1 }}><span className="min-w-0 flex-1 truncate"><b className="text-ink-2">{b.note ?? b.kind}</b> {b.startTime}–{b.endTime}</span>{grid.onRemoveBlock && <button className="grid h-5 w-5 shrink-0 place-items-center rounded-full hover:bg-ink/10" aria-label={`Remove ${b.note ?? b.kind}`} data-tip="Remove" onClick={() => grid.onRemoveBlock!(b)}><Icon name="x" className="h-3 w-3" /></button>}</div>
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
  const appts: any[] = (w.appointments ?? []).filter((a: any) => (!grid.svc || a.serviceId === grid.svc) && (!grid.status || a.status === grid.status));
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
            style={{ background: a.color ? a.color + '1f' : 'rgba(23,25,26,.04)', borderLeft: `3px solid ${a.color ?? 'var(--color-line-2)'}` }}
            className={`mb-px flex items-center gap-1.5 rounded-[5px] px-1 text-[11.5px] leading-[15px] truncate hover:underline ${OPEN.includes(a.status) && grid.canBook ? 'cursor-grab' : 'cursor-pointer'} ${a.status === 'requested' ? 'italic' : ''} ${a.status === 'no_show' ? 'line-through text-rose' : ''}`}>
            <i className="h-1.5 w-1.5 rounded-full shrink-0" style={{ background: DOT[a.status] }} /><span className="truncate">{a.name}</span>
          </div>
        ))}
      </div>
      {more > 0 && <div className="text-[11px] text-muted">+{more} more</div>}
    </div>
  );
}

function DayView({ day, doc, practitioner, cfg, perms, me, grid, onAvailability }: { day: string; doc: string; practitioner: any; cfg: any; perms: string[]; me: any; grid: Grid; onAvailability?: (day: string) => void }) {
  const cal = useQuery({ queryKey: ['calendar', day, doc], queryFn: () => get(`/calendar?day=${day}${doc ? `&practitionerId=${doc}` : ''}`), refetchInterval: 15000, enabled: !!doc });
  const [routine, setRoutine] = useState(false);
  const writable = can(perms, 'appointment.write') || me.practitionerId === doc;
  const d = cal.data;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] gap-5">
      <div className="min-w-0">
        <Legend days={d ? [d] : []} grid={grid} hint={grid.canBook ? 'Click a window to book · drag a name to move it' : undefined} />
        {cal.isLoading || !d ? <Skeleton rows={6} /> : d.windows.length === 0 && d.blocks.length === 0 && d.procedures.length === 0 ? (
          <div className="card"><Empty icon="calendar" title={practitioner?.routine ? 'Not a working day in the routine' : 'No routine set for this doctor'} hint={writable ? (practitioner?.routine ? 'Use Change availability for a one-off day.' : 'Set the weekly routine once; every day fills itself.') : undefined} />
            {writable && !practitioner?.routine && <div className="flex justify-center pb-6"><button className="btn btn-primary" onClick={() => setRoutine(true)}><Icon name="spark" />Set weekly routine</button></div>}</div>
        ) : <TimeGrid wide px={1.3} minCol={320} grid={grid} cols={[{ key: day, day, head: null, windows: d.windows, blocks: d.blocks, procs: d.procedures.filter((p: any) => p.practitionerId === doc) }]} />}
      </div>
      {d && <DayPanel d={d} grid={grid} onAvailability={onAvailability} />}
      {routine && practitioner && <RoutineModal practitionerId={doc} name={practitioner.name} initial={practitioner.routine} onClose={() => setRoutine(false)} />}
    </div>
  );
}

/** "10:00–13:00, 16:00–20:00" from back-to-back windows. */
const hoursOf = (ws: any[]) => ws.reduce((out: [string, string][], w) => { const last = out[out.length - 1]; if (last && last[1] === w.startTime) last[1] = w.endTime; else out.push([w.startTime, w.endTime]); return out; }, []).map(([a, b]) => `${a}–${b}`).join(', ');

function WeekView({ from, doc, docName, grid, onOpenDay, onAvailability }: { from: string; doc: string; docName?: string; grid: Grid; onOpenDay: (d: string) => void; onAvailability: (d: string) => void }) {
  const q = useQuery({ queryKey: ['calendar', 'range', from, doc], queryFn: () => get(`/calendar/range?from=${from}&days=7${doc ? `&practitionerId=${doc}` : ''}`), refetchInterval: 30000, enabled: !!doc });
  const [sel, setSel] = useState<string | null>(null);
  if (q.isLoading || !q.data) return <Skeleton rows={8} />;
  // Sunday only shows when something is on it.
  const days = q.data.filter((d: any, i: number) => i < 6 || d.windows.length || d.procedures.length);
  const tot = days.reduce((s: any, d: any) => ({ a: s.a + d.windows.reduce((n: number, w: any) => n + w.allocated, 0), c: s.c + d.windows.reduce((n: number, w: any) => n + w.effectiveCapacity, 0) }), { a: 0, c: 0 });
  const pick = sel && days.some((d: any) => d.day === sel) ? sel : (days.find((d: any) => d.day === today()) ?? days[0])?.day;
  const pd = days.find((d: any) => d.day === pick);
  return (
    <>
      <div className="text-sm text-muted -mt-3 mb-4">{docName ? `${docName} · ` : ''}<b className="text-ink">{tot.a}</b> of {tot.c} OP places booked</div>
      <Legend days={days} grid={grid} hint={grid.canBook ? 'Click a window to book · drag a name to move it · click a day for its panel' : undefined} />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
        <TimeGrid grid={grid} px={1.4} minCol={140} cols={days.map((d: any) => {
          const a = d.windows.reduce((n: number, w: any) => n + w.allocated, 0), c = d.windows.reduce((n: number, w: any) => n + w.effectiveCapacity, 0);
          const isToday = d.day === today();
          return { key: d.day, day: d.day, windows: d.windows, blocks: d.blocks, procs: d.procedures, tint: d.day === pick ? 'rgba(255,255,255,.45)' : undefined,
            head: <button type="button" className="text-left min-w-0" onClick={() => setSel(d.day)} aria-pressed={d.day === pick} aria-label={`Show ${fullDay(d.day)} in the side panel`}>
              <div className={`text-[11px] font-bold uppercase tracking-wider ${isToday ? 'text-clay' : 'text-muted'}`}>{label(d.day, { weekday: 'short' })}</div>
              <div className="flex items-baseline gap-1.5"><span className="text-lg font-semibold">{label(d.day, { day: 'numeric' })}</span><span className="text-[11px] text-muted truncate">{d.blocks.some(isLongLeave) ? 'away' : c ? `${a}/${c}` : 'off'}</span></div>
            </button> };
        })} />
        {pd && <DayPanel d={pd} grid={grid} onOpenDay={onOpenDay} onAvailability={onAvailability} />}
      </div>
      {grid.onRemoveBlock && <div className="glass mt-4 flex flex-wrap items-center gap-3 px-5 py-4 anim-fade-up">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-sky-soft text-sky"><Icon name="clock" className="h-5 w-5" /></span>
        <div className="min-w-0 flex-1"><div className="font-semibold">Need to change your hours?</div><div className="text-sm text-muted">Start late, leave early, add a break or mark the day away. Reception sees it straight away, and every change can be undone.</div></div>
        <button className="btn btn-primary" onClick={() => onAvailability(pick && pick >= today() ? pick : today())}>Change availability</button>
      </div>}
    </>
  );
}

/** The picked day: hours (routine or changed, with undo), then everything booked, in time order. */
function DayPanel({ d, grid, onOpenDay, onAvailability }: { d: any; grid: Grid; onOpenDay?: (day: string) => void; onAvailability?: (day: string) => void }) {
  const items = [
    ...d.windows.flatMap((w: any) => (w.appointments ?? []).map((a: any) => ({ t: w.startTime, key: a.id, name: a.name, sub: [a.service, a.status.replace('_', '-')].filter(Boolean).join(' · '), color: a.color, open: () => grid.onOpen(a.id), muted: a.status === 'no_show' }))),
    ...d.procedures.map((p: any) => ({ t: p.startTime, key: p.id, name: p.patient, sub: `${p.procedure ?? 'Procedure'} · sitting ${p.sittingNo}${p.of ? ` of ${p.of}` : ''}`, color: '#6D5E86', open: null, muted: false })),
    ...d.blocks.filter((b: any) => !isLongLeave(b)).map((b: any) => ({ t: b.startTime, key: b.id, name: b.note ?? b.kind, sub: `${b.startTime}–${b.endTime}`, color: null, open: null, muted: true })),
  ].sort((a, b) => toMin(a.t) - toMin(b.t));
  const away = d.blocks.find(isLongLeave);
  const hours = hoursOf(d.windows);
  const n = d.windows.reduce((m: number, w: any) => m + (w.appointments?.length ?? 0), 0);
  return (
    <aside className="card-flat self-start p-4 anim-fade-up" aria-label={`${fullDay(d.day)} summary`}>
      <div className="flex items-baseline gap-2"><b className="text-[16px]">{label(d.day, { weekday: 'short', day: 'numeric', month: 'short' })}</b>{d.day === today() && <span className="text-xs font-semibold text-clay">today</span>}{onAvailability && grid.onRemoveBlock && d.day >= today() && <button className="btn btn-sm ml-auto" onClick={() => onAvailability(d.day)}><Icon name="clock" className="h-3.5 w-3.5" />Change availability</button>}</div>
      <div className="mt-3 rounded-2xl bg-paper px-3 py-2.5 text-sm">
        <div className="font-semibold">{away ? 'Away all day' : hours || 'Not working'}</div>
        <div className="text-xs text-muted">{d.blocks.length ? 'Changed for this day' : 'From the weekly routine'}</div>
        {d.blocks.map((b: any) => <div key={b.id} className="mt-1 flex items-center gap-2 text-xs"><span className="flex-1 truncate">{b.note ?? b.kind} · {b.startTime}–{b.endTime}</span>{grid.onRemoveBlock && <button className="font-semibold underline" onClick={() => grid.onRemoveBlock!(b)}>Undo</button>}</div>)}
      </div>
      <div className="mt-3 text-xs text-muted">{n} appointment{n === 1 ? '' : 's'} · {d.procedures.length} procedure{d.procedures.length === 1 ? '' : 's'}</div>
      <div className="mt-1 max-h-[420px] overflow-y-auto">
        {items.length === 0 ? <div className="py-4 text-sm text-muted">Nothing booked.</div> : items.map((x) => (
          <button key={x.key} disabled={!x.open} onClick={() => x.open?.()} className={`flex w-full items-start gap-2.5 border-t border-line/60 py-2 text-left first:border-t-0 ${x.muted ? 'opacity-60' : ''} ${x.open ? 'hover:bg-white/50' : 'cursor-default'}`}>
            <b className="w-11 shrink-0 text-[13px]">{x.t}</b>
            <i className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: x.color ?? 'transparent' }} />
            <span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-medium">{x.name}</span><span className="block truncate text-xs text-muted">{x.sub}</span></span>
          </button>
        ))}
      </div>
      {onOpenDay && <button className="btn btn-sm mt-3 w-full justify-center" onClick={() => onOpenDay(d.day)}>Open this day</button>}
    </aside>
  );
}

/** One place to change a doctor's hours for a date: start late, leave early, a break, or away. Each change can be undone. */
function AvailabilityModal({ day: initial, doc, docName, onRoutine, onEditDay, onClose }: { day: string; doc: string; docName: string; onRoutine: () => void; onEditDay: (day: string) => void; onClose: () => void }) {
  const [day, setDay] = useState(initial);
  const [kind, setKind] = useState<'late' | 'early' | 'break' | 'away'>('late');
  const q = useQuery({ queryKey: ['calendar', day, doc], queryFn: () => get(`/calendar?day=${day}&practitionerId=${doc}`) });
  const d = q.data;
  const first = d?.windows[0]?.startTime as string | undefined; const last = d?.windows[d.windows.length - 1]?.endTime as string | undefined;
  const [time, setTime] = useState(''); const [mins, setMins] = useState(30);
  const refresh = () => ['calendar', 'sessions', 'appointments', 'queue'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  const del = useMutation({ mutationFn: (id: string) => api('DELETE', `/calendar/blocks/${id}`), onSuccess: () => { refresh(); toast('Undone', 'info'); }, onError: (e) => toast(errText(e), 'err') });
  const add = useMutation({ mutationFn: (b: any) => post('/calendar/blocks', { practitionerId: doc, day, ...b }),
    onSuccess: (r: any, b: any) => { refresh(); toast(`${docName}: ${b.note} on ${label(day, { weekday: 'short', day: 'numeric', month: 'short' })}`, 'ok', { label: 'Undo', run: () => del.mutate(r.id) }); onClose(); }, onError: (e) => toast(errText(e), 'err') });
  const t = time || (kind === 'late' && first ? toHHMM(toMin(first) + 30) : kind === 'early' && last ? toHHMM(toMin(last) - 60) : first ? toHHMM(Math.max(toMin(first), 13 * 60)) : '13:00');
  const valid = /^\d{2}:\d{2}$/.test(t) && !!first && !!last && (kind === 'break' ? toMin(t) >= toMin(first) : toMin(t) > toMin(first)) && toMin(t) < toMin(last);
  const away = !!d?.blocks.some(isLongLeave);
  const working = (d?.windows.length ?? 0) > 0;
  const save = () => {
    if (kind === 'away') return add.mutate({ kind: 'leave', startTime: '00:00', endTime: '23:59', note: 'Away' });
    if (!valid || !first || !last) return;
    if (kind === 'late') add.mutate({ kind: 'other', startTime: first, endTime: t, note: `Starts at ${t}` });
    if (kind === 'early') add.mutate({ kind: 'other', startTime: t, endTime: last, note: `Leaves at ${t}` });
    if (kind === 'break') add.mutate({ kind: 'break', startTime: t, endTime: toHHMM(Math.min(toMin(t) + mins, toMin(last))), note: 'Break' });
  };
  return (
    <Modal title="Change availability" subtitle={docName} onClose={onClose} width="max-w-lg">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2"><label className="label !mb-0" htmlFor="av-day">Date</label><input id="av-day" type="date" min={today()} className="input !w-auto" value={day} onChange={(e) => e.target.value >= today() && setDay(e.target.value)} />
          <span className="text-sm text-muted">{q.isLoading ? '…' : away ? 'Away all day' : working ? `Hours ${hoursOf(d.windows)}` : 'Not a working day'}</span></div>
        {d?.blocks.length > 0 && <div className="rounded-2xl bg-paper px-3 py-2 text-sm"><div className="text-xs font-bold uppercase tracking-wider text-muted">Already changed</div>
          {d.blocks.map((b: any) => <div key={b.id} className="mt-1 flex items-center gap-2"><span className="flex-1">{b.note ?? b.kind} · {b.startTime}–{b.endTime}</span><button className="text-sm font-semibold underline" onClick={() => del.mutate(b.id)}>Undo</button></div>)}</div>}
        {!q.isLoading && !away && !working && <div className="text-sm text-muted">{docName} does not work on this date in the routine. Use “Different hours for this date” to add some.</div>}
        {!away && working && <>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="What changes">
            {([['late', 'Starts late'], ['early', 'Leaves early'], ['break', 'Break'], ['away', 'Away all day']] as const).map(([k, l]) => <button key={k} role="radio" aria-checked={kind === k} className={`toggle-opt ${kind === k ? 'on' : ''}`} onClick={() => { setKind(k); setTime(''); }}>{l}</button>)}
          </div>
          {kind !== 'away' && <div className="flex flex-wrap items-center gap-2">
            <label className="label !mb-0" htmlFor="av-time">{kind === 'late' ? 'Starts at' : kind === 'early' ? 'Leaves at' : 'Break from'}</label>
            <input id="av-time" type="time" step={300} className={`input !w-auto ${valid ? '' : '!border-rose'}`} value={t} onChange={(e) => setTime(e.target.value)} />
            {kind === 'break' && <div className="flex gap-1">{[15, 30, 45, 60].map((m) => <button key={m} className={`toggle-opt ${mins === m ? 'on' : ''}`} onClick={() => setMins(m)}>{m} min</button>)}</div>}
          </div>}
          {kind !== 'away' && !valid && <div className="text-xs text-rose">Pick a time inside {first}–{last}.</div>}
          {kind === 'away' && <div className="text-sm text-muted">Every window that day drops to zero places. Booked patients stay booked so reception can call them.</div>}
        </>}
        <div className="modal-foot">
          <button className="btn btn-ghost btn-sm" onClick={() => onEditDay(day)}>Different hours for this date</button><button className="btn btn-ghost btn-sm" onClick={onRoutine}>Weekly routine</button>
          <span className="ml-auto" /><button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={add.isPending || away || !working || (kind !== 'away' && !valid)} onClick={save}><Icon name="check" />Save</button>
        </div>
      </div>
    </Modal>
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
      <Legend days={[d]} grid={grid} hint={grid.canBook ? 'Drag a name to another doctor to hand the patient over' : undefined} />
      <TimeGrid grid={grid} px={1.25} minCol={170} cols={cols} />
    </>
  );
}

function ListView({ day, doc, grid }: { day: string; doc: string; grid: Grid }) {
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['calendar', day, doc], queryFn: () => get(`/calendar?day=${day}${doc ? `&practitionerId=${doc}` : ''}`), refetchInterval: 15000, enabled: !!doc });
  if (q.isLoading || !q.data) return <Skeleton rows={6} />;
  const d = q.data;
  const items = [...(grid.show === 'procs' ? [] : d.windows.map((w: any) => ({ ...w, type: 'w', day }))), ...(grid.show === 'appts' ? [] : d.procedures.map((p: any) => ({ ...p, type: 'p' })))].sort((a, b) => toMin(a.startTime) - toMin(b.startTime));
  if (d.blocks.some(isLongLeave)) return <div className="card"><Empty icon="door" title="Away this day" hint={`${d.windows.reduce((n: number, w: any) => n + w.allocated, 0)} booked patients may need a call.`} /></div>;
  if (!items.length) return <><Legend days={[d]} grid={grid} /><div className="card"><Empty icon="calendar" title={grid.show === 'procs' ? 'No procedures on this day' : grid.show === 'appts' ? 'No appointments on this day' : 'Nothing on this day'} /></div></>;
  const tone = (w: any) => (w.free <= 0 ? 'rose' : w.free <= 2 ? 'amber' : 'sage');
  return (
    <div className="space-y-3 max-w-2xl"><Legend days={[d]} grid={grid} />
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

/** Doctor starts later than the routine: pick the new start (presets every 15 minutes, or any time). */
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
        <div className="modal-foot"><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={save.isPending || !ranges.length} onClick={() => save.mutate()}><Icon name="check" />Save for this day</button></div>
      </div>
    </Modal>
  );
}
