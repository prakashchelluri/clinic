import { useState, type CSSProperties, type DragEvent, type ReactNode } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useNavigate, useOutletContext, useSearchParams } from 'react-router';
import { get, post, patch, api, qc, today, errText, ApiError, uuid } from '../api';
import { can } from '../App';
import { Chip, Empty, Icon, Modal, Segmented, Skeleton, ask, toast } from '../ui';
import { RoutineModal } from '../routine';
import { BookForm } from './Booking';
import { AppointmentDrawer } from '../apptDrawer';
import { ChangeMyDay } from '../dayChange';

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

type View = 'day' | 'week';
type Pick = { k: 'doc' | 'room' | 'all'; id?: string };
const store = { get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } } };
const PILL: Record<string, string> = {
  booked: 'bg-white border-line', confirmed: 'bg-white border-line', requested: 'bg-white border-dashed border-clay text-[#9A3412]',
  arrived: 'bg-amber-soft text-[#6E4D10] border-transparent', no_show: 'border-dashed border-rose/50 text-rose line-through',
};
const stripe = { background: 'repeating-linear-gradient(45deg,rgba(23,25,26,.05) 0 6px,transparent 6px 12px)' };

/** Calendar for the front desk: one doctor or room at a time (or all as cards), day or week, book on a phone call, what needs handling. */
export function Calendar() {
  const { cfg, perms, me } = useOutletContext<any>();
  const [params, setParams] = useSearchParams();
  const day = params.get('day') && /^\d{4}-\d{2}-\d{2}$/.test(params.get('day')!) ? params.get('day')! : today();
  const setDay = (d: string) => setParams((p) => { const n = new URLSearchParams(p); if (d === today()) n.delete('day'); else n.set('day', d); return n; }, { replace: true });
  const [view, setViewS] = useState<View>(() => (store.get('cal.view2') === 'week' ? 'week' : 'day'));
  const setView = (v: View) => { setViewS(v); store.set('cal.view2', v); };
  const docs: any[] = (cfg?.practitioners ?? []).filter((p: any) => p.active !== false);
  const rooms: any[] = (cfg?.rooms ?? []).filter((r: any) => r.active !== false);
  const [pickS, setPickS] = useState<Pick | null>(() => { try { return JSON.parse(store.get('cal.pick') ?? 'null'); } catch { return null; } });
  const pick: Pick = pickS && (pickS.k === 'all' || (pickS.k === 'doc' ? docs.some((d) => d.id === pickS.id) : rooms.some((r) => r.id === pickS.id))) ? pickS
    : { k: 'doc', id: me.practitionerId ?? docs[0]?.id };
  const setPick = (p: Pick) => { setPickS(p); store.set('cal.pick', JSON.stringify(p)); };
  const canBook = can(perms, 'appointment.write');
  const [booking, setBooking] = useState<any>(null); // a window clicked on the calendar
  const [panel, setPanel] = useState<{ patient?: any } | null>(null); // the "+ Book" panel
  const [openId, setOpenId] = useState<string | null>(null);
  const [change, setChange] = useState<string | null>(null); // doctor whose day is being changed
  const [routine, setRoutine] = useState<string | null>(null);
  const weekStart = monday(day); const step = view === 'week' ? 7 : 1;
  const all = useQuery({ queryKey: ['calendar', day, 'all'], queryFn: () => get(`/calendar?day=${day}`), refetchInterval: 30000 });
  const refresh = () => ['calendar', 'sessions', 'appointments', 'queue', 'calendar-attention'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  const move = useMutation({
    mutationFn: ({ appt, to, overbook }: any) => patch(`/appointments/${appt.id}`, { sessionId: to.id, overbook }),
    onSuccess: (_r, { appt, to }: any) => { refresh(); toast(`${appt.name} moved to ${to.startTime}. The patient is told.`); },
    onError: (e: any, vars: any) => {
      if (e instanceof ApiError && e.body?.code === 'WINDOW_FULL' && can(perms, 'appointment.overbook') && !vars.overbook) {
        ask({ title: `${vars.to.startTime} is full`, body: `Move ${vars.appt.name} into it anyway? It will go over the places set for that window.`, confirmLabel: 'Overbook', cancelLabel: 'Leave it' }).then((r) => { if (r) move.mutate({ ...vars, overbook: true }); });
        return;
      }
      toast(errText(e), 'err');
    },
  });
  const grid: Grid = { svc: '', setSvc: () => {}, status: '', setStatus: () => {}, services: cfg?.services ?? [], show: 'all', setShow: () => {}, canBook,
    onOpen: (id: string) => setOpenId(id), onBook: (w: any) => setBooking(w), onMove: (a: any, w: any) => a.sessionId !== w.id && move.mutate({ appt: a, to: w }) };
  const a = all.data;
  const countFor = (pid: string) => {
    if (!a) return '';
    if (a.blocks.some((b: any) => b.practitionerId === pid && b.kind === 'leave')) return 'away';
    const ws = a.windows.filter((w: any) => w.practitionerId === pid);
    if (!ws.length) return 'off';
    return `${ws.reduce((n: number, w: any) => n + Math.max(0, w.free), 0)} free`;
  };
  const roomCount = (rid: string) => (a ? String(a.procedures.filter((p: any) => p.roomId === rid).length) : '');
  const title = view === 'week' ? `${label(weekStart, { day: 'numeric', month: 'short' })} – ${label(shift(weekStart, 5), { day: 'numeric', month: 'short' })}` : fullDay(day);
  const canChangeDoc = (pid?: string) => !!pid && (canBook || me.practitionerId === pid);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2.5">
        <SearchBox onOpen={setOpenId} onBook={canBook ? (patient) => setPanel({ patient }) : undefined} />
        {canBook && <button className="btn btn-primary" onClick={() => setPanel({})}><Icon name="plus" />Book</button>}
        <span className="ml-auto flex flex-wrap items-center gap-2">
          <div className="card flex items-center gap-1 !rounded-full !p-1">
            <button className="btn btn-ghost btn-icon" aria-label={step === 7 ? 'Previous week' : 'Previous day'} onClick={() => setDay(shift(day, -step))}><Icon name="chevL" /></button>
            <label className="relative cursor-pointer px-1 text-[15px] font-semibold">{title}<input type="date" aria-label="Date" className="absolute inset-0 cursor-pointer opacity-0" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} /></label>
            <button className="btn btn-ghost btn-icon" aria-label={step === 7 ? 'Next week' : 'Next day'} onClick={() => setDay(shift(day, step))}><Icon name="chevR" /></button>
          </div>
          {(view === 'week' ? weekStart !== monday(today()) : day !== today()) && <button className="btn btn-sm" onClick={() => setDay(today())}>{view === 'week' ? 'This week' : 'Today'}</button>}
          <Segmented<View> value={view} onChange={setView} options={[{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }]} />
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Show">
        {docs.length > 0 && <span className="mr-1 text-[11px] font-bold uppercase tracking-wider text-muted">Doctor</span>}
        {docs.map((d) => <button key={d.id} role="radio" aria-checked={pick.k === 'doc' && pick.id === d.id} className={`toggle-opt ${pick.k === 'doc' && pick.id === d.id ? 'on' : ''}`} onClick={() => setPick({ k: 'doc', id: d.id })}>{d.name.replace(/^Dr\.?\s*/i, 'Dr. ').replace(/\s+Doctor$/, '')} <span className="ml-1 text-[11px] opacity-60">{countFor(d.id)}</span></button>)}
        {rooms.length > 0 && <span className="ml-3 mr-1 text-[11px] font-bold uppercase tracking-wider text-muted">Room</span>}
        {rooms.map((r) => <button key={r.id} role="radio" aria-checked={pick.k === 'room' && pick.id === r.id} className={`toggle-opt ${pick.k === 'room' && pick.id === r.id ? 'on' : ''}`} onClick={() => setPick({ k: 'room', id: r.id })}>{r.name} <span className="ml-1 text-[11px] opacity-60">{roomCount(r.id)}</span></button>)}
        <button role="radio" aria-checked={pick.k === 'all'} className={`toggle-opt ml-2 ${pick.k === 'all' ? 'on' : ''}`} onClick={() => setPick({ k: 'all' })}>All</button>
      </div>

      {canBook && <AttentionStrip onOpen={setOpenId} onBook={(patient) => setPanel({ patient })} />}

      {view === 'day' && pick.k === 'doc' && pick.id && <DayDoc day={day} doc={docs.find((d) => d.id === pick.id)} grid={grid} onChange={canChangeDoc(pick.id) ? () => setChange(pick.id!) : undefined} onRoutine={canChangeDoc(pick.id) ? () => setRoutine(pick.id!) : undefined} />}
      {view === 'day' && pick.k === 'room' && <RoomsDay day={day} cfg={{ ...cfg, rooms: rooms.filter((r) => r.id === pick.id) }} grid={grid} canEdit={canBook} />}
      {view === 'day' && pick.k === 'all' && <AllCards day={day} data={a} docs={docs} rooms={rooms} onPick={setPick} />}
      {view === 'week' && pick.k === 'room' && pick.id && <RoomWeek from={weekStart} roomId={pick.id} cfg={cfg} grid={grid} canEdit={canBook} onOpenDay={(d) => { setDay(d); setView('day'); }} />}
      {view === 'week' && pick.k !== 'room' && <WeekGrid from={weekStart} docs={pick.k === 'doc' ? docs.filter((d) => d.id === pick.id) : docs} onOpenDay={(d, pid) => { setDay(d); if (pid) setPick({ k: 'doc', id: pid }); setView('day'); }} />}

      {openId && <AppointmentDrawer id={openId} cfg={cfg} canWrite={canBook} onClose={() => setOpenId(null)} />}
      {booking && (
        <Modal title="Book" subtitle={`${label(booking.day, { weekday: 'short', day: 'numeric', month: 'short' })} · ${booking.startTime}–${booking.endTime}${docs.find((d) => d.id === booking.practitionerId) ? ` · ${docs.find((d) => d.id === booking.practitionerId).name}` : ''}`} onClose={() => setBooking(null)} width="max-w-md">
          <BookForm session={booking} arriveEarly={cfg?.tenant.settings.scheduling?.arriveEarlyMinutes ?? 30} onDone={() => { refresh(); setBooking(null); }} />
        </Modal>)}
      {panel && <BookPanel initialPatient={panel.patient} defaultDoc={pick.k === 'doc' ? pick.id : undefined} docs={docs} services={cfg?.services ?? []} onClose={() => setPanel(null)} onDone={() => { refresh(); setPanel(null); }} />}
      {change && <ChangeMyDay practitionerId={change} name={docs.find((d) => d.id === change)?.name ?? 'Doctor'} initialKind="away" initialDay={day < today() ? today() : day} onClose={() => setChange(null)} onRoutine={() => { setRoutine(change); setChange(null); }} />}
      {routine && <RoutineModal practitionerId={routine} name={docs.find((d) => d.id === routine)?.name ?? 'Doctor'} initial={docs.find((d) => d.id === routine)?.routine} onClose={() => setRoutine(null)} />}
    </div>
  );
}

/** One doctor's day: a row per booking window with names, free places to click, procedures in the same rows, the lunch gap and a now-line. Drag a name to another row to move it. */
function DayDoc({ day, doc, grid, onChange, onRoutine }: { day: string; doc: any; grid: Grid; onChange?: () => void; onRoutine?: () => void }) {
  const q = useQuery({ queryKey: ['calendar', day, doc?.id], queryFn: () => get(`/calendar?day=${day}&practitionerId=${doc.id}`), refetchInterval: 15000, enabled: !!doc });
  const [over, setOver] = useState<string | null>(null);
  if (!doc) return null;
  if (q.isLoading || !q.data) return <Skeleton rows={6} />;
  const d = q.data; const ws: any[] = d.windows; const past = day < today(); const isToday = day === today();
  const now = toHHMM(nowMin());
  const booked = ws.reduce((n, w) => n + w.allocated, 0); const free = ws.reduce((n, w) => n + Math.max(0, w.free), 0);
  const away = d.blocks.find((b: any) => b.kind === 'leave');
  const notes = d.blocks.filter((b: any) => b.kind !== 'procedure' && b.kind !== 'leave').map((b: any) => b.note ?? b.kind);
  type Row = { w?: any; time: string; end: string; procs: any[] };
  const rows: Row[] = ws.map((w) => ({ w, time: w.startTime, end: w.endTime, procs: [] }));
  for (const p of d.procedures) { const r = rows.find((x) => x.time <= p.startTime && p.startTime < x.end); if (r) r.procs.push(p); else rows.push({ time: p.startTime, end: p.endTime, procs: [p] }); }
  rows.sort((x, y) => x.time.localeCompare(y.time));
  const nowIdx = isToday ? rows.findIndex((r) => r.time > now) : -2;
  const drop = (e: DragEvent, w: any) => { e.preventDefault(); setOver(null); try { const ap = JSON.parse(e.dataTransfer.getData('application/x-appt')); grid.onMove(ap, { ...w, day }); } catch { /* not ours */ } };
  return (
    <section className="card-flat p-4 sm:p-5 anim-fade-up">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <b className="text-[16px]">{doc.name}</b>
        <span className="text-sm text-muted">{away ? away.note : ws.length ? `${booked} booked · ${free} free${d.procedures.length ? ` · ${d.procedures.length} procedure${d.procedures.length === 1 ? '' : 's'}` : ''} · ${hoursOf(ws)}` : 'not working this day'}{notes.length ? ` · ${notes.join(', ')}` : ''}</span>
        <span className="ml-auto flex gap-2">{onChange && !past && <button className="btn btn-sm" onClick={onChange}>Change this day</button>}{onRoutine && <button className="btn btn-ghost btn-sm" onClick={onRoutine}>Weekly hours</button>}</span>
      </div>
      {rows.length === 0 ? <Empty icon="calendar" title={away ? 'Away this day' : doc.routine ? 'Not a working day' : 'No weekly hours set for this doctor'} hint={onRoutine && !doc.routine ? 'Set the weekly hours once; the calendar fills itself.' : undefined} /> : rows.map((r, i) => {
        const w = r.w; const closed = w && w.effectiveCapacity === 0 && (w.reductions ?? []).length > 0;
        const gap = i > 0 && toMin(r.time) - toMin(rows[i - 1].end) >= 30 ? `${rows[i - 1].end}–${r.time} · not working` : null;
        return (
          <div key={r.time + i}>
            {i === nowIdx && <NowLine at={now} />}
            {gap && <div className="grid grid-cols-[56px_1fr] border-t border-line/60"><span /><div className="my-1.5 rounded-xl px-3 py-2 text-xs font-semibold text-muted" style={stripe}>{gap}</div></div>}
            <div className={`grid min-h-[52px] grid-cols-[56px_1fr_64px] items-start border-t border-line/60 ${over === w?.id ? 'bg-white' : ''}`}
              onDragOver={w && grid.canBook && !past ? (e) => { if (e.dataTransfer.types.includes('application/x-appt')) { e.preventDefault(); setOver(w.id); } } : undefined}
              onDragLeave={() => setOver(null)} onDrop={w && grid.canBook && !past ? (e) => drop(e, w) : undefined}>
              <b className="pt-2.5 text-xs text-muted">{r.time}</b>
              <div className="flex flex-wrap items-center gap-1.5 py-2">
                {closed && <span className="rounded-xl px-3 py-1.5 text-xs font-semibold text-muted" style={stripe}>{w.reductions.map((x: any) => x.note ?? x.kind).join(', ')}</span>}
                {(w?.appointments ?? []).map((ap: any) => (
                  <button key={ap.id} draggable={grid.canBook && OPEN.includes(ap.status) && !past} title={[ap.phone, ap.service, ap.note, ap.status.replace('_', '-')].filter(Boolean).join(' · ')}
                    onDragStart={(e) => { e.dataTransfer.setData('application/x-appt', JSON.stringify({ id: ap.id, sessionId: w.id, name: ap.name })); e.dataTransfer.effectAllowed = 'move'; }}
                    onClick={() => grid.onOpen(ap.id)} className={`inline-flex items-center gap-1.5 rounded-[10px] border px-2.5 py-1 text-[12.5px] font-semibold ${PILL[ap.status] ?? PILL.booked}`}>
                    {ap.color && <i className="h-2 w-2 rounded-[3px]" style={{ background: ap.color }} />}{ap.name}{ap.status === 'requested' ? ' · approve' : ap.status === 'arrived' ? ' · arrived' : ap.status === 'no_show' ? ' · no-show' : ap.status === 'confirmed' ? ' ✓' : ''}
                  </button>))}
                {r.procs.map((p) => <span key={p.id} title={p.room ?? ''} className="rounded-[10px] bg-sky-soft px-2.5 py-1 text-[12.5px] font-semibold text-sky">{p.startTime} {p.patient} · {p.procedure ?? 'Procedure'} {p.sittingNo}{p.of ? `/${p.of}` : ''}{p.room ? ` · ${p.room}` : ''}{p.state === 'completed' ? ' ✓' : ''}</span>)}
                {w && !closed && w.free > 0 && !past && (!isToday || w.endTime > now) && (grid.canBook
                  ? <button className="rounded-[10px] border-[1.5px] border-dashed border-[#A9CDB8] px-2.5 py-1 text-[12.5px] font-semibold text-sage hover:bg-sage-soft" onClick={() => grid.onBook({ ...w, day })}>{w.free} free</button>
                  : <span className="text-xs text-muted">{w.free} free</span>)}
              </div>
              <span className={`pt-2.5 text-right text-xs font-bold ${w && w.allocated >= w.effectiveCapacity ? 'text-rose' : 'text-muted'}`}>{w ? `${w.allocated} / ${w.effectiveCapacity}` : ''}</span>
            </div>
          </div>);
      })}
      {rows.length > 0 && <div className="mt-2 text-xs text-muted">Click a name to open the booking (move, call, cancel). Click a dashed “free” to book it. Drag a name to another hour to move it; the patient is told.</div>}
    </section>
  );
}

function NowLine({ at }: { at: string }) {
  return <div className="relative ml-[56px] h-0 border-t-2 border-clay"><span className="absolute -left-[56px] -top-2.5 rounded-full bg-clay px-1.5 py-0.5 text-[10.5px] font-bold text-white">{at}</span></div>;
}

/** "All": one card per doctor and room, with the next free place, so 10 doctors still fit on one screen. */
function AllCards({ day, data, docs, rooms, onPick }: { day: string; data: any; docs: any[]; rooms: any[]; onPick: (p: Pick) => void }) {
  if (!data) return <Skeleton rows={4} />;
  const now = day === today() ? toHHMM(nowMin()) : '00:00';
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">{docs.map((d) => {
        const ws = data.windows.filter((w: any) => w.practitionerId === d.id);
        const away = data.blocks.find((b: any) => b.practitionerId === d.id && b.kind === 'leave');
        const next = ws.find((w: any) => w.free > 0 && w.endTime > now);
        return (
          <button key={d.id} onClick={() => onPick({ k: 'doc', id: d.id })} className={`card card-hover !p-4 text-left ${away || !ws.length ? 'opacity-60' : ''}`}>
            <b className="text-[14px]">{d.name}</b>
            <div className="mt-1 text-xs text-muted">{away ? away.note : !ws.length ? 'not working' : `${ws.reduce((n: number, w: any) => n + w.allocated, 0)} booked · ${ws.reduce((n: number, w: any) => n + Math.max(0, w.free), 0)} free`}</div>
            {ws.length > 0 && !away && <div className="text-xs text-muted">{next ? `Next free: ${next.startTime}` : ws.some((w: any) => w.free > 0) ? 'No free place left today' : 'Full'}</div>}
          </button>);
      })}</div>
      {rooms.length > 0 && <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">{rooms.map((r) => {
        const ps = data.procedures.filter((p: any) => p.roomId === r.id);
        const cur = day === today() ? ps.find((p: any) => p.startTime <= now && now < p.endTime) : null;
        return (
          <button key={r.id} onClick={() => onPick({ k: 'room', id: r.id })} className="card card-hover !p-4 text-left" style={{ background: 'rgba(221,231,242,.35)' }}>
            <b className="text-[14px]">{r.name}</b>
            <div className="mt-1 text-xs text-muted">{ps.length} sitting{ps.length === 1 ? '' : 's'}</div>
            <div className="text-xs text-muted">{cur ? `busy until ${cur.endTime}` : day === today() ? 'free now' : ''}</div>
          </button>);
      })}</div>}
    </div>
  );
}

/** Week: how full each doctor's morning and evening is, day by day. One doctor gets three rows; "All" one row per doctor. */
function WeekGrid({ from, docs, onOpenDay }: { from: string; docs: any[]; onOpenDay: (d: string, pid?: string) => void }) {
  const q = useQuery({ queryKey: ['calendar', 'range', from, 'all'], queryFn: () => get(`/calendar/range?from=${from}&days=7`), refetchInterval: 30000 });
  if (q.isLoading || !q.data) return <Skeleton rows={6} />;
  const days: any[] = q.data.filter((d: any, i: number) => i < 6 || d.windows.length);
  const one = docs.length === 1;
  const box = (d: any, pid: string, part?: 'am' | 'pm') => {
    const ws = d.windows.filter((w: any) => w.practitionerId === pid && (!part || (part === 'am' ? w.startTime < '14:00' : w.startTime >= '14:00')));
    const away = d.blocks.find((b: any) => b.practitionerId === pid && b.kind === 'leave');
    if (away) return { text: 'Away', sub: away.note?.replace(/^Away · ?/, '') ?? '', cls: 'text-muted', style: stripe };
    if (!ws.length) return { text: '—', sub: part ? '' : 'not working', cls: 'text-muted', style: {} };
    const a = ws.reduce((n: number, w: any) => n + w.allocated, 0); const c = ws.reduce((n: number, w: any) => n + w.effectiveCapacity, 0);
    const r = c ? a / c : 1; const notes = d.blocks.filter((b: any) => b.practitionerId === pid && ['other', 'stop'].includes(b.kind) && ws.some((w: any) => w.startTime < b.endTime && w.endTime > b.startTime)).map((b: any) => b.note);
    return { text: `${a} / ${c}`, sub: notes[0] ?? (c - a > 0 ? `${c - a} free` : 'full'), cls: r >= 0.95 ? 'bg-[#F6DCCF] text-[#8A3A1C]' : r >= 0.6 ? 'bg-[#F4EBD3] text-[#6E4D10]' : 'bg-sage-soft text-sage', style: {}, r };
  };
  const rows: { key: string; head: ReactNode; cell: (d: any) => ReactNode }[] = [];
  for (const doc of docs) {
    const cell = (part?: 'am' | 'pm') => (d: any) => { const b = box(d, doc.id, part); return (
      <button onClick={() => onOpenDay(d.day, doc.id)} className={`w-full rounded-xl px-2.5 py-2 text-left text-[13px] font-bold ${b.cls}`} style={b.style} aria-label={`${doc.name} ${d.day}`}>
        {b.text}<span className="block text-[11px] font-medium">{b.sub}</span>
        {b.r !== undefined && <span className="mt-1 block h-1 overflow-hidden rounded bg-black/5"><i className="block h-full bg-current opacity-50" style={{ width: `${Math.min(100, b.r * 100)}%` }} /></span>}
      </button>); };
    if (one) {
      rows.push({ key: doc.id + 'am', head: <><b className="text-[13px]">Morning</b><span className="block text-[11px] text-muted">before 14:00</span></>, cell: cell('am') });
      rows.push({ key: doc.id + 'pm', head: <><b className="text-[13px]">Evening</b><span className="block text-[11px] text-muted">from 14:00</span></>, cell: cell('pm') });
      rows.push({ key: doc.id + 'pr', head: <><b className="text-[13px]">Procedures</b><span className="block text-[11px] text-muted">{doc.name}</span></>, cell: (d: any) => { const n = d.procedures.filter((p: any) => p.practitionerId === doc.id).length; return n ? <button onClick={() => onOpenDay(d.day, doc.id)} className="w-full rounded-xl bg-sky-soft px-2.5 py-2 text-left text-[13px] font-bold text-sky">{n} sitting{n === 1 ? '' : 's'}</button> : <span className="px-2.5 text-muted">—</span>; } });
    } else rows.push({ key: doc.id, head: <b className="text-[13px]">{doc.name}</b>, cell: cell() });
  }
  return (
    <div className="card-flat overflow-x-auto p-4 anim-fade-up">
      <div className="grid min-w-[760px] gap-x-1.5" style={{ gridTemplateColumns: `150px repeat(${days.length}, minmax(0,1fr))` }}>
        <span />{days.map((d) => { const n = docs.reduce((s, doc) => s + d.windows.filter((w: any) => w.practitionerId === doc.id).reduce((m: number, w: any) => m + w.allocated, 0), 0); return (
          <button key={d.day} onClick={() => onOpenDay(d.day, one ? docs[0].id : undefined)} className={`pb-2 text-left text-sm font-bold ${d.day === today() ? 'text-clay' : ''}`}>{label(d.day, { weekday: 'short', day: 'numeric' })}{d.day === today() ? ' · today' : ''}<span className="block text-[11px] font-medium text-muted">{n} booked</span></button>); })}
        {rows.map((r) => [<div key={r.key} className="border-t border-line/60 py-2.5 pr-2">{r.head}</div>, ...days.map((d) => <div key={r.key + d.day} className="border-t border-line/60 py-1.5">{r.cell(d)}</div>)])}
      </div>
      <div className="mt-3 text-xs text-muted">Green has room, sand is filling, peach is full. Click any box to open that day. Away days and early leaves come from the doctor's “Change my day”.</div>
    </div>
  );
}

/** One search for a name, phone or OP number: the patient's upcoming bookings, or book them. */
function SearchBox({ onOpen, onBook }: { onOpen: (id: string) => void; onBook?: (patient: any) => void }) {
  const [q, setQ] = useState(''); const [sel, setSel] = useState<any>(null); const [open, setOpen] = useState(false);
  const found = useQuery({ queryKey: ['patients', q], queryFn: () => get(`/patients?q=${encodeURIComponent(q)}`), enabled: q.trim().length >= 2 && !sel });
  const appts = useQuery({ queryKey: ['appointments', 'patient', sel?.id], queryFn: () => get(`/appointments?patientId=${sel.id}`), enabled: !!sel });
  return (
    <div className="relative w-full sm:w-[380px]" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false); }}>
      <Icon name="search" className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
      <input aria-label="Search patient" className="input !rounded-full !pl-10" maxLength={60} placeholder="Name, phone or OP no." value={sel ? sel.fullName : q} onFocus={() => setOpen(true)}
        onChange={(e) => { setSel(null); setQ(e.target.value); setOpen(true); }} />
      {open && (sel || q.trim().length >= 2) && <div className="menu anim-menu !left-0 !right-auto !top-full !mt-1 !w-full max-h-80 overflow-y-auto p-1.5">
        {!sel ? (found.isLoading ? <div className="p-3 text-sm text-muted">Searching…</div> : (found.data ?? []).length === 0 ? <div className="p-3 text-sm text-muted">No patient found.</div>
          : found.data.slice(0, 8).map((p: any) => <button key={p.id} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-paper" onClick={() => setSel(p)}><b>{p.fullName}</b><span className="text-xs text-muted">{[p.patientNo, p.phone].filter(Boolean).join(' · ')}</span></button>))
          : <div className="p-1.5">
            <div className="px-1 pb-1.5 text-xs text-muted">{[sel.patientNo, sel.phone].filter(Boolean).join(' · ')}</div>
            {appts.isLoading ? <div className="p-2 text-sm text-muted">…</div> : (appts.data ?? []).length === 0 ? <div className="px-1 py-2 text-sm text-muted">No upcoming bookings.</div>
              : appts.data.map((x: any) => <button key={x.id} className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-paper" onClick={() => { onOpen(x.id); setOpen(false); }}><b className="w-28 shrink-0">{label(x.window.day, { weekday: 'short', day: 'numeric', month: 'short' })}</b><span>{x.window.startTime}{x.status === 'requested' ? ' · request' : ''}{x.service ? ` · ${x.service.name}` : ''}</span></button>)}
            {onBook && <button className="btn btn-sm mt-1.5 w-full justify-center" onClick={() => { onBook(sel); setOpen(false); }}><Icon name="plus" className="h-3.5 w-3.5" />Book {sel.fullName.split(' ')[0]}</button>}
          </div>}
      </div>}
    </div>
  );
}

/** What the front desk must handle, empty most days: online requests, patients to call after a doctor's change, the waiting list. */
function AttentionStrip({ onOpen, onBook }: { onOpen: (id: string) => void; onBook: (patient: any) => void }) {
  const q = useQuery({ queryKey: ['calendar-attention'], queryFn: () => get('/calendar/attention'), refetchInterval: 30000 });
  const [show, setShow] = useState<null | 'call' | 'wait'>(null);
  const approve = useMutation({ mutationFn: async (ids: string[]) => { for (const id of ids) await post(`/appointments/${id}/approve`); }, onSuccess: (_r, ids) => { ['calendar', 'calendar-attention', 'bookings'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); toast(`${ids.length} approved. Patients are told.`); }, onError: (e) => toast(errText(e), 'err') });
  const d = q.data; if (!d) return null;
  const items: ReactNode[] = [];
  if (d.requests.length) items.push(<div key="r" className="flex flex-wrap items-center gap-2.5 rounded-2xl bg-white/75 px-3.5 py-2 text-sm"><i className="h-2 w-2 rounded-full bg-clay" /><b>{d.requests.length} online request{d.requests.length === 1 ? '' : 's'}</b>
    <span className="text-xs text-muted">{d.requests.slice(0, 2).map((r: any) => `${r.name} ${label(r.day, { weekday: 'short' })} ${r.startTime}`).join(' · ')}</span>
    <button className="btn btn-sm" onClick={() => onOpen(d.requests[0].id)}>Review</button>{d.requests.length > 1 && <button className="btn btn-sm" disabled={approve.isPending} onClick={() => approve.mutate(d.requests.map((r: any) => r.id))}>Approve all</button>}</div>);
  if (d.toCall.length) items.push(<div key="c" className="flex flex-wrap items-center gap-2.5 rounded-2xl bg-white/75 px-3.5 py-2 text-sm"><i className="h-2 w-2 rounded-full bg-amber" /><b>{d.toCall.length} to call</b><span className="text-xs text-muted">{[...new Set(d.toCall.map((x: any) => x.why))].slice(0, 2).join(' · ')}</span><button className="btn btn-sm" onClick={() => setShow('call')}>See</button></div>);
  if (d.waiting) items.push(<div key="w" className="flex flex-wrap items-center gap-2.5 rounded-2xl bg-white/75 px-3.5 py-2 text-sm"><i className="h-2 w-2 rounded-full bg-sage" /><b>Waiting list · {d.waiting}</b>{d.openToday > 0 && <span className="text-xs text-muted">{d.openToday} place{d.openToday === 1 ? '' : 's'} free today</span>}<button className="btn btn-sm" onClick={() => setShow('wait')}>See</button></div>);
  return (<>
    {items.length > 0 && <div className="flex flex-wrap gap-2">{items}</div>}
    {show === 'call' && <Modal title="Patients to call" subtitle="Their doctor is away or leaves early when they are booked" onClose={() => setShow(null)} width="max-w-xl">
      <div>{d.toCall.map((x: any) => <div key={x.id} className="flex flex-wrap items-center gap-2 border-t border-line/60 py-2.5 text-sm first:border-t-0"><b className="w-32 shrink-0">{label(x.day, { weekday: 'short', day: 'numeric', month: 'short' })} {x.startTime}</b><span className="min-w-0 flex-1">{x.name}<span className="block text-xs text-muted">{x.why}</span></span>{x.phone && <a className="btn btn-sm" href={`tel:${x.phone}`}><Icon name="phone" className="h-3.5 w-3.5" />{x.phone}</a>}<button className="btn btn-sm" onClick={() => { setShow(null); onOpen(x.id); }}>Move or cancel</button></div>)}</div>
    </Modal>}
    {show === 'wait' && <WaitlistModal onClose={() => setShow(null)} onBook={(p) => { setShow(null); onBook(p); }} />}
  </>);
}

function WaitlistModal({ onClose, onBook }: { onClose: () => void; onBook: (patient: any) => void }) {
  const q = useQuery({ queryKey: ['waitlist'], queryFn: () => get('/waitlist') });
  const rm = useMutation({ mutationFn: (id: string) => patch(`/waitlist/${id}`, { status: 'removed' }), onSuccess: () => { ['waitlist', 'calendar-attention'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); toast('Taken off the list', 'info'); }, onError: (e) => toast(errText(e), 'err') });
  return (
    <Modal title="Waiting list" subtitle="Patients who want an earlier place. Booking them takes them off the list." onClose={onClose} width="max-w-xl">
      {q.isLoading ? <Skeleton rows={3} /> : (q.data ?? []).length === 0 ? <Empty icon="users" title="Nobody waiting" /> : q.data.map((w: any) => (
        <div key={w.id} className="flex flex-wrap items-center gap-2 border-t border-line/60 py-2.5 text-sm first:border-t-0">
          <span className="min-w-0 flex-1"><b>{w.patient.fullName}</b><span className="block text-xs text-muted">{[w.doctor ?? 'any doctor', w.note, w.untilDay ? `before ${label(w.untilDay, { day: 'numeric', month: 'short' })}` : null, `since ${label(w.createdAt.slice(0, 10), { day: 'numeric', month: 'short' })}`].filter(Boolean).join(' · ')}</span></span>
          {w.patient.phone && <a className="btn btn-sm" href={`tel:${w.patient.phone}`}><Icon name="phone" className="h-3.5 w-3.5" />Call</a>}
          <button className="btn btn-sm btn-primary" onClick={() => onBook(w.patient)}>Book</button>
          <button className="btn btn-ghost btn-sm" disabled={rm.isPending} onClick={() => rm.mutate(w.id)}>Remove</button>
        </div>))}
    </Modal>
  );
}

/** Book on a phone call: who (phone finds the patient and the family on that number), when (free places as chips), for what. */
function BookPanel({ initialPatient, defaultDoc, docs, services, onClose, onDone }: { initialPatient?: any; defaultDoc?: string; docs: any[]; services: any[]; onClose: () => void; onDone: () => void }) {
  const [q, setQ] = useState(''); const [patient, setPatient] = useState<any>(initialPatient ?? null);
  const [newName, setNewName] = useState(''); const [newPhone, setNewPhone] = useState('');
  const [doc, setDoc] = useState<string>(defaultDoc ?? ''); const [part, setPart] = useState<'am' | 'pm' | 'any'>('any');
  const [from, setFrom] = useState(today());
  const [slot, setSlot] = useState<any>(null); const [svc, setSvc] = useState(''); const [note, setNote] = useState('');
  const typedPhone = /^\d{10}$/.test(q.trim()) ? q.trim() : '';
  const found = useQuery({ queryKey: ['patients', q], queryFn: () => get(`/patients?q=${encodeURIComponent(q.trim())}`), enabled: q.trim().length >= 3 && !patient });
  const free = useQuery({ queryKey: ['calendar-free', doc, from], queryFn: () => get(`/calendar/free?from=${from}&days=7${doc ? `&practitionerId=${doc}` : ''}`) });
  const slots: any[] = (free.data ?? []).filter((s: any) => part === 'any' || (part === 'am' ? s.startTime < '14:00' : s.startTime >= '14:00'));
  const byDay = slots.reduce((m: Record<string, any[]>, s: any) => { (m[s.day] ??= []).push(s); return m; }, {});
  const svcs = services.filter((s: any) => !s.practitionerIds?.length || !slot?.practitionerId || s.practitionerIds.includes(slot.practitionerId));
  const svcId = svc || svcs[0]?.id || '';
  const phoneBad = !patient && newPhone !== '' && !/^\d{10}$/.test(newPhone);
  const who = patient ? patient.fullName : newName.trim();
  const book = useMutation({
    mutationFn: () => post('/appointments', { sessionId: slot.sessionId, patientId: patient?.id, newPatient: patient ? undefined : { fullName: newName.trim(), phone: (typedPhone || newPhone) || undefined }, serviceId: svcId || undefined, note: note.trim() || undefined, idempotencyKey: uuid() }),
    onSuccess: (r: any) => { toast(`${who} booked ${label(r.window.day, { weekday: 'short', day: 'numeric', month: 'short' })} ${r.window.startTime}. Confirmation sent.`); onDone(); },
    onError: (e) => { toast(errText(e), 'err'); qc.invalidateQueries({ queryKey: ['calendar-free'] }); },
  });
  const wait = useMutation({ mutationFn: () => post('/waitlist', { patientId: patient.id, practitionerId: doc || null, note: note.trim() || (part !== 'any' ? (part === 'am' ? 'mornings' : 'evenings') : undefined) }),
    onSuccess: () => { ['waitlist', 'calendar-attention'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); toast(`${patient.fullName} is on the waiting list`); onClose(); }, onError: (e) => toast(errText(e), 'err') });
  const sameNumber = patient?.phone ? (found.data ?? []).filter((p: any) => p.phone === patient.phone && p.id !== patient.id) : [];
  return (
    <Modal title="Book" subtitle="Who, when, for what. The patient gets a WhatsApp." onClose={onClose} width="max-w-2xl">
      <div className="space-y-4">
        <div><div className="label">1 · Who</div>
          {patient ? <div className="flex items-center gap-2 rounded-xl bg-sage-soft px-3 py-2 text-sm text-sage"><Icon name="check" className="h-4 w-4" /><b>{patient.fullName}</b><span className="text-xs">{[patient.patientNo, patient.phone].filter(Boolean).join(' · ')}</span><button className="btn btn-ghost btn-sm ml-auto" onClick={() => { setPatient(null); }}>change</button></div>
            : <>
              <input autoFocus aria-label="Phone number or name" inputMode="search" className="input" maxLength={60} placeholder="Phone number or name" value={q} onChange={(e) => setQ(e.target.value)} />
              {(found.data ?? []).length > 0 && <div className="mt-1.5 max-h-40 overflow-y-auto rounded-xl border border-line">{found.data.slice(0, 6).map((p: any) => <button key={p.id} className="flex w-full items-center gap-2 border-t border-line/60 px-3 py-2 text-left text-sm first:border-t-0 hover:bg-paper" onClick={() => setPatient(p)}><b>{p.fullName}</b><span className="text-xs text-muted">{[p.patientNo, p.phone, p.ageYears ? `${p.ageYears} ${p.sex ?? ''}` : null].filter(Boolean).join(' · ')}</span></button>)}</div>}
              {q.trim().length >= 3 && !found.isLoading && <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_170px]">
                <input aria-label="New patient name" className="input" maxLength={100} placeholder="New patient: name" value={newName} onChange={(e) => setNewName(e.target.value)} />
                {typedPhone ? <div className="input !bg-paper text-muted">{typedPhone}</div> : <input aria-label="New patient mobile" inputMode="numeric" className={`input ${phoneBad ? '!border-rose' : ''}`} maxLength={10} placeholder="Mobile (10 digits)" value={newPhone} onChange={(e) => setNewPhone(e.target.value.replace(/\D/g, '').slice(0, 10))} />}
              </div>}
              {phoneBad && <div className="mt-1 text-xs text-rose">Mobile must be 10 digits.</div>}
            </>}
          {sameNumber.length > 0 && <div className="mt-1 text-xs text-muted">Same number: {sameNumber.map((p: any) => <button key={p.id} className="underline" onClick={() => setPatient(p)}>{p.fullName}</button>)}</div>}
        </div>

        <div><div className="label">2 · When</div>
          <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Doctor">
            {docs.map((d) => <button key={d.id} role="radio" aria-checked={doc === d.id} className={`toggle-opt !py-1 ${doc === d.id ? 'on' : ''}`} onClick={() => { setDoc(d.id); setSlot(null); }}>{d.name}</button>)}
            <button role="radio" aria-checked={doc === ''} className={`toggle-opt !py-1 ${doc === '' ? 'on' : ''}`} onClick={() => { setDoc(''); setSlot(null); }}>Any doctor</button>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Part of the day">
            {([['am', 'Morning'], ['pm', 'Evening'], ['any', 'Any time']] as const).map(([k, l]) => <button key={k} role="radio" aria-checked={part === k} className={`toggle-opt !py-1 ${part === k ? 'on' : ''}`} onClick={() => { setPart(k); setSlot(null); }}>{l}</button>)}
            <label className="ml-2 flex items-center gap-1.5 text-xs text-muted">from<input type="date" aria-label="From date" min={today()} className="input !w-auto !py-1" value={from} onChange={(e) => e.target.value >= today() && (setFrom(e.target.value), setSlot(null))} /></label>
          </div>
          <div className="mt-2 max-h-56 space-y-1.5 overflow-y-auto">
            {free.isLoading ? <Skeleton rows={2} /> : Object.keys(byDay).length === 0 ? <div className="text-sm text-muted">No free places in these 7 days. Try another date, another doctor, or the waiting list.</div>
              : Object.entries(byDay).map(([d, list]) => <div key={d} className="flex gap-2"><b className="w-24 shrink-0 pt-2 text-xs text-muted">{label(d, { weekday: 'short', day: 'numeric', month: 'short' })}</b>
                <div className="flex flex-wrap gap-1.5">{list.map((s) => { const on = slot?.sessionId === s.sessionId; return <button key={s.sessionId} role="radio" aria-checked={on} onClick={() => setSlot(s)} className={`rounded-xl border px-3 py-1.5 text-left text-sm font-bold ${on ? 'border-sage bg-sage-soft text-sage' : 'border-line bg-white hover:bg-paper'}`}>{s.startTime}<span className={`block text-[11px] font-medium ${s.free <= 1 ? 'text-clay' : 'text-muted'}`}>{s.free} left{!doc && s.doctor ? ` · ${s.doctor.replace(/^Dr\.?\s*/i, 'Dr. ')}` : ''}</span></button>; })}</div></div>)}
          </div>
          {patient && <button className="mt-1.5 text-xs font-semibold underline" disabled={wait.isPending} onClick={() => wait.mutate()}>Put {patient.fullName.split(' ')[0]} on the waiting list for an earlier place</button>}
        </div>

        <div><div className="label">3 · For</div>
          {svcs.length > 0 && <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Visit type">{svcs.map((s: any) => <button key={s.id} role="radio" aria-checked={svcId === s.id} className={`toggle-opt inline-flex items-center gap-1.5 !py-1 ${svcId === s.id ? 'on' : ''}`} onClick={() => setSvc(s.id)}><i className="h-2.5 w-2.5 rounded-[3px]" style={{ background: s.color }} />{s.name}</button>)}</div>}
          <input aria-label="Note" className="input mt-2" maxLength={500} placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>

        <div className="modal-foot">
          <span className="text-xs text-muted">{slot ? `WhatsApp confirmation now; reminder before the visit.` : 'Pick a free place.'}</span>
          <span className="ml-auto" /><button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!slot || book.isPending || (!patient && newName.trim().length < 2) || phoneBad} onClick={() => book.mutate()}><Icon name="check" />{slot ? `Book ${label(slot.day, { weekday: 'short' })} ${slot.startTime}` : 'Book'}</button>
        </div>
      </div>
    </Modal>
  );
}

type Show = 'all' | 'appts' | 'procs';
type Grid = { svc: string; setSvc: (s: string) => void; status: string; setStatus: (s: string) => void; services: any[]; show: Show; setShow: (s: Show) => void; canBook: boolean; onRemoveBlock?: (b: any) => void; onOpen: (id: string) => void; onBook: (w: any) => void; onMove: (a: any, w: any) => void };
type Col = { key: string; head: ReactNode; windows: any[]; blocks: any[]; procs: any[]; day: string; tint?: string };

/** Shared time grid: one column per day or per doctor/room. */
function TimeGrid({ cols: allCols, grid, px = 1.15, minCol = 140, wide = false, range }: { cols: Col[]; grid: Grid; px?: number; minCol?: number; wide?: boolean; range?: [number, number] }) {
  const cols = allCols.map((c) => grid.show === 'procs' ? { ...c, windows: [] } : grid.show === 'appts' ? { ...c, procs: [] } : c);
  const all = cols.flatMap((c) => [...c.windows, ...c.blocks.filter((b) => !isLongLeave(b)), ...c.procs]);
  const lo = all.length ? Math.floor(Math.min(...all.map((x) => toMin(x.startTime))) / 60) * 60 : 10 * 60;
  const hi = all.length ? Math.ceil(Math.max(...all.map((x) => toMin(x.endTime))) / 60) * 60 : 19 * 60;
  const start = range ? Math.min(range[0], lo) : lo;
  const end = range ? Math.max(range[1], hi) : hi;
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

/** "10:00–13:00, 16:00–20:00" from back-to-back windows. */
const hoursOf = (ws: any[]) => ws.reduce((out: [string, string][], w) => { const last = out[out.length - 1]; if (last && last[1] === w.startTime) last[1] = w.endTime; else out.push([w.startTime, w.endTime]); return out; }, []).map(([a, b]) => `${a}–${b}`).join(', ');

function RoomsDay({ day, cfg, grid, canEdit }: { day: string; cfg: any; grid: Grid; canEdit: boolean }) {
  const q = useQuery({ queryKey: ['calendar', day, 'all'], queryFn: () => get(`/calendar?day=${day}`), refetchInterval: 15000 });
  const rooms: any[] = (cfg?.rooms ?? []).filter((r: any) => r.active !== false);
  const caps = [...new Set<string>(rooms.flatMap((r) => r.capabilities ?? []))];
  const isToday = day === today();
  const roundUp = (m: number) => Math.ceil(m / 15) * 15;
  const [mins, setMins] = useState(45); const [cap, setCap] = useState('');
  const [at, setAt] = useState(() => toHHMM(isToday ? Math.min(roundUp(nowMin()), 19 * 60) : 10 * 60));
  const [blocking, setBlocking] = useState(false);
  if (q.isLoading || !q.data) return <Skeleton rows={6} />;
  const d = q.data;
  // everything occupying a room: procedures and blocks (cleaning, maintenance), as minute ranges
  const busy = (rid: string) => [
    ...d.procedures.filter((p: any) => p.roomId === rid).map((p: any) => ({ s: toMin(p.startTime), e: toMin(p.endTime), what: p.procedure ?? 'Procedure', who: p.patient })),
    ...d.blocks.filter((b: any) => b.roomId === rid && !b.practitionerId).map((b: any) => ({ s: toMin(b.startTime), e: toMin(b.endTime), what: b.note ?? 'Not available', who: '' })),
  ].sort((a, b) => a.s - b.s);
  const status = (r: any) => {
    const now = nowMin(); const list = busy(r.id);
    if (!isToday) return { free: true, text: list.length ? `${list.length} booked` : 'free all day' };
    const cur = list.find((x) => x.s <= now && now < x.e);
    if (cur) { let end = cur.e; for (const x of list) if (x.s <= end && x.e > end) end = x.e; return { free: false, text: `busy until ${toHHMM(end)} · ${cur.what}` }; }
    const next = list.find((x) => x.s > now);
    return { free: true, text: next ? `free until ${toHHMM(next.s)}` : 'free for the rest of the day' };
  };
  const wantS = toMin(at); const wantE = wantS + mins;
  const freeFor = rooms.filter((r) => (!cap || (r.capabilities ?? []).includes(cap)) && !busy(r.id).some((x) => x.s < wantE && x.e > wantS));
  const cols: Col[] = rooms.map((r: any) => ({ key: r.id, day, windows: [], blocks: d.blocks.filter((b: any) => b.roomId === r.id && !b.practitionerId), tint: 'rgba(221,231,242,.18)', procs: d.procedures.filter((p: any) => p.roomId === r.id),
    head: (<><span className="h-8 w-8 rounded-full grid place-items-center text-[11px] font-bold shrink-0 bg-sky-soft text-sky">R</span><div className="min-w-0"><div className="text-sm font-semibold truncate">{r.name}</div><div className="text-[11px] text-muted truncate">{(r.capabilities ?? []).join(' · ') || 'room'} · {busy(r.id).length} booked</div></div></>) }));
  if (rooms.length === 0) return <div className="card"><Empty icon="door" title="No rooms yet" hint="Add procedure rooms under Settings → Rooms." /></div>;
  return (
    <div className="space-y-3">
      <div className="glass p-4 space-y-3 anim-fade-up">
        <div className="flex items-center gap-2"><div className="text-[11px] uppercase tracking-wider text-muted">{isToday ? `Right now · ${toHHMM(nowMin())}` : 'Rooms on this day'}</div><span className="ml-auto" />{canEdit && <button className="btn btn-sm" onClick={() => setBlocking(true)}><Icon name="door" className="h-3.5 w-3.5" />Block a room</button>}</div>
        <div className="flex flex-wrap gap-2">{rooms.map((r) => { const st = status(r); return <span key={r.id} className={`chip !text-[13px] !px-3 !py-2 ${st.free ? 'chip-sage' : 'chip-rose'}`}><i className="h-2 w-2 rounded-full bg-current" />{r.name} · {st.text}</span>; })}</div>
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <b className="text-sm">Find a room</b>
          <select aria-label="How long" className="input !w-auto !py-1.5" value={mins} onChange={(e) => setMins(Number(e.target.value))}>{[15, 30, 45, 60, 90, 120].map((m) => <option key={m} value={m}>{m} min</option>)}</select>
          <span className="text-sm text-muted">from</span>
          <input aria-label="Start time" type="time" step={900} className="input !w-auto !py-1.5" value={at} onChange={(e) => e.target.value && setAt(e.target.value)} />
          {caps.length > 0 && <select aria-label="Room type" className="input !w-auto !py-1.5" value={cap} onChange={(e) => setCap(e.target.value)}><option value="">Any room type</option>{caps.map((c) => <option key={c} value={c}>{c}</option>)}</select>}
          <span className="text-sm">{freeFor.length ? <>Free: {freeFor.map((r, i) => <b key={r.id}>{i ? ', ' : ''}{r.name}</b>)}</> : <span className="text-rose">No room is free then. Try another time.</span>}</span>
        </div>
      </div>
      <TimeGrid grid={grid} px={1.25} minCol={190} cols={cols} range={[9 * 60, 20 * 60]} />
      <div className="text-xs text-muted">Empty means free. Striped means blocked. A blocked room is refused when a procedure is scheduled in it.</div>
      {blocking && <BlockRoomModal day={day} rooms={rooms} onClose={() => setBlocking(false)} />}
    </div>
  );
}

/** Take a room out for a while (cleaning, repair). Procedures cannot be scheduled into it; undo removes the block. */
function BlockRoomModal({ day: initialDay, rooms, onClose }: { day: string; rooms: any[]; onClose: () => void }) {
  const [day, setDay] = useState(initialDay);
  const [roomId, setRoomId] = useState(rooms[0]?.id ?? ''); const [from, setFrom] = useState(toHHMM(day === today() ? Math.min(Math.ceil(nowMin() / 15) * 15, 19 * 60) : 10 * 60)); const [to, setTo] = useState(''); const [why, setWhy] = useState('Cleaning'); const [tried, setTried] = useState(false);
  const end = to || toHHMM(Math.min(toMin(from) + 60, 23 * 60 + 59));
  const bad = !/^\d{2}:\d{2}$/.test(from) || !/^\d{2}:\d{2}$/.test(end) || toMin(end) <= toMin(from);
  const del = useMutation({ mutationFn: (id: string) => api('DELETE', `/calendar/blocks/${id}`), onSuccess: () => { qc.invalidateQueries({ queryKey: ['calendar'] }); toast('Block removed', 'info'); }, onError: (e) => toast(errText(e), 'err') });
  const add = useMutation({ mutationFn: () => post('/calendar/blocks', { roomId, day, startTime: from, endTime: end, kind: 'other', note: why.trim() || 'Not available' }),
    onSuccess: (r: any) => { qc.invalidateQueries({ queryKey: ['calendar'] }); toast(`${rooms.find((x) => x.id === roomId)?.name} blocked ${from}–${end}`, 'ok', { label: 'Undo', run: () => del.mutate(r.id) }); onClose(); }, onError: (e) => toast(errText(e), 'err') });
  return (
    <Modal title="Block a room" onClose={onClose} width="max-w-md" submitOnEnter>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3"><div><label className="label" htmlFor="br-date">Date</label><input id="br-date" type="date" min={today()} className="input" value={day} onChange={(e) => e.target.value >= today() && setDay(e.target.value)} /></div>
        <div><label className="label" htmlFor="br-room">Room</label><select id="br-room" className="input" value={roomId} onChange={(e) => setRoomId(e.target.value)}>{rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></div></div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label" htmlFor="br-from">From</label><input id="br-from" type="time" step={900} className={`input ${tried && bad ? '!border-rose' : ''}`} value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div><label className="label" htmlFor="br-to">To</label><input id="br-to" type="time" step={900} className={`input ${tried && bad ? '!border-rose' : ''}`} value={end} onChange={(e) => setTo(e.target.value)} /></div>
        </div>
        {tried && bad && <div className="text-xs text-rose">End must be after the start.</div>}
        <div><label className="label" htmlFor="br-why">Reason</label>
          <div className="mb-2 flex flex-wrap gap-1.5">{['Cleaning', 'Maintenance', 'Not available'].map((x) => <button key={x} type="button" className={`toggle-opt ${why === x ? 'on' : ''}`} onClick={() => setWhy(x)}>{x}</button>)}</div>
          <input id="br-why" className="input" maxLength={80} value={why} onChange={(e) => setWhy(e.target.value)} /></div>
        <div className="modal-foot"><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={add.isPending} onClick={() => { setTried(true); if (!bad && roomId) add.mutate(); }}><Icon name="check" />Block room</button></div>
      </div>
    </Modal>
  );
}

/** One room across the week: how busy each day is, when it is free, blocks for cleaning or repair. */
function RoomWeek({ from, roomId, cfg, grid, canEdit, onOpenDay }: { from: string; roomId: string; cfg: any; grid: Grid; canEdit: boolean; onOpenDay: (d: string) => void }) {
  const q = useQuery({ queryKey: ['calendar', 'range', from, 'rooms'], queryFn: () => get(`/calendar/range?from=${from}&days=7`), refetchInterval: 30000 });
  const [blocking, setBlocking] = useState(false);
  const room = (cfg?.rooms ?? []).find((r: any) => r.id === roomId);
  if (q.isLoading || !q.data || !room) return <Skeleton rows={8} />;
  const mine = (d: any) => ({ procs: d.procedures.filter((p: any) => p.roomId === roomId), blocks: d.blocks.filter((b: any) => b.roomId === roomId && !b.practitionerId) });
  // Sunday only shows when something is on it.
  const days = q.data.filter((d: any, i: number) => i < 6 || mine(d).procs.length || mine(d).blocks.length);
  const total = days.reduce((n: number, d: any) => n + mine(d).procs.length, 0);
  const mins = (d: any) => mine(d).procs.reduce((n: number, p: any) => n + toMin(p.endTime) - toMin(p.startTime), 0);
  const dur = (m: number) => m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`;
  return (
    <div className="space-y-3">
      <div className="glass p-4 flex flex-wrap items-center gap-3 anim-fade-up">
        <span className="h-9 w-9 rounded-full grid place-items-center text-xs font-bold shrink-0 bg-sky-soft text-sky">R</span>
        <div className="min-w-0 flex-1"><div className="font-semibold">{room.name}</div><div className="text-sm text-muted">{(room.capabilities ?? []).join(' · ') || 'room'} · {total} procedure{total === 1 ? '' : 's'} this week</div></div>
        {canEdit && <button className="btn btn-sm" onClick={() => setBlocking(true)}><Icon name="door" className="h-3.5 w-3.5" />Block this room</button>}
      </div>
      <TimeGrid grid={grid} px={1.25} minCol={140} range={[9 * 60, 20 * 60]} cols={days.map((d: any) => {
        const m = mine(d); const isToday = d.day === today();
        return { key: d.day, day: d.day, windows: [], blocks: m.blocks, procs: m.procs,
          head: <button type="button" className="text-left min-w-0" onClick={() => onOpenDay(d.day)} aria-label={`Open ${fullDay(d.day)} for all rooms`}>
            <div className={`text-[11px] font-bold uppercase tracking-wider ${isToday ? 'text-clay' : 'text-muted'}`}>{label(d.day, { weekday: 'short' })}</div>
            <div className="flex items-baseline gap-1.5"><span className="text-lg font-semibold">{label(d.day, { day: 'numeric' })}</span><span className="text-[11px] text-muted truncate">{m.procs.length ? `${m.procs.length} booked · ${dur(mins(d))}` : m.blocks.length ? 'blocked' : 'free'}</span></div>
          </button> };
      })} />
      <div className="text-xs text-muted">Empty means free. Striped means blocked. Click a day to see every room on that day.</div>
      {blocking && <BlockRoomModal day={from < today() ? today() : from} rooms={[room]} onClose={() => setBlocking(false)} />}
    </div>
  );
}
