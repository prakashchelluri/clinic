import { useRef, useState, type DragEvent } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { get, patch, qc, errText, ApiError } from '../api';
import { Floating, Icon, Segmented, Skeleton, ask, toast } from '../ui';
import { told } from '../apptDrawer';

/** The calendar on the Dashboard, for the desk and for doctors, as Today (by the hour) or Week (how full each day is).
 *  The day by the hour: a row per booking hour, a column per doctor (and per room when asked for).
 *  Patients are booked into an hour, not a minute, and seen in the order they arrive. A name opens the side drawer, "+ Book" books that hour.
 *  Colours stay calm: booked is a thin outline, here is warm grey, next is light teal, with the doctor is slate, done is grey text. */
export type Kind = 'booked' | 'late' | 'waiting' | 'intake' | 'doctor' | 'tests' | 'done' | 'noshow';
const LABEL: Record<Kind, string> = { booked: 'Booked, not here yet', late: 'Booked, did not come', waiting: 'Waiting', intake: 'With the junior doctor', doctor: 'With the doctor', tests: 'Tests & procedures to arrange', done: 'Done', noshow: "Didn't come" };
const SITTING: Record<string, Kind> = { confirmed: 'booked', in_progress: 'doctor', completed: 'done', missed: 'noshow' };
const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const hhmm = (iso: string) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const shift = (day: string, n: number) => { const d = new Date(day + 'T00:00:00'); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const monday = (day: string) => shift(day, -((new Date(day + 'T00:00:00').getDay() + 6) % 7));
const dayName = (day: string) => new Date(day + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
/** "9–10 am", "12–1 pm": how the clinic says an hour */
const hourLabel = (a: string, b: string) => { const f = (m: number) => { const h = Math.floor(m / 60) % 12 || 12; const mm = m % 60; return mm ? `${h}:${String(mm).padStart(2, '0')}` : `${h}`; }; const s = toMin(a), e = toMin(b); return `${f(s)}–${f(e)} ${e > 12 * 60 ? 'pm' : 'am'}`; };

/** Which calendars this computer shows: picked once, kept. Rooms are off unless asked for. */
function useShown(): [Record<string, boolean>, (k: string, on: boolean) => void] {
  const [s, setS] = useState<Record<string, boolean>>(() => { try { return JSON.parse(localStorage.getItem('fd.cals') ?? '{}'); } catch { return {}; } });
  return [s, (k, on) => { const n = { ...s, [k]: on }; setS(n); try { localStorage.setItem('fd.cals', JSON.stringify(n)); } catch { /* storage blocked */ } }];
}

export function DaySchedule({ today, visitsToday, doctors, rooms, selectedId, kindOf, nextIds, onVisit, onOpenAppt, onBook, canOverbook = false, tools, procsInDoc = false }: {
  today: string; visitsToday: any[]; doctors: any[]; rooms: any[]; selectedId: string | null; kindOf: (v: any) => Kind; nextIds: Set<string>;
  onVisit: (id: string) => void; onOpenAppt: (id: string) => void; onBook?: (w: any) => void; canOverbook?: boolean; tools?: React.ReactNode;
  /** a doctor's own calendar: their sittings sit in their column when the room's column is not shown */ procsInDoc?: boolean;
}) {
  const nav = useNavigate();
  const [day, setDay] = useState(today);
  const [mode, setMode] = useState<'day' | 'week'>('day'); const week = mode === 'week'; const step = week ? 7 : 1;
  const [shown, setShown] = useShown();
  const isToday = day === today; const isPast = day < today;
  const cal = useQuery({ queryKey: ['calendar', day, 'all'], queryFn: () => get(`/calendar?day=${day}`), refetchInterval: isToday ? 15000 : false });
  const other = useQuery({ queryKey: ['frontdesk', day], queryFn: () => get(`/frontdesk?day=${day}`), enabled: !isToday }); // another day's checked-in patients
  const visits: any[] = isToday ? visitsToday : other.data?.visits ?? [];
  const docOn = (id: string) => shown[`d:${id}`] !== false; // doctors on unless switched off
  const roomOn = (id: string) => shown[`r:${id}`] ?? shown.rooms === true; // rooms off unless switched on (one by one; 'rooms' was the old all-rooms switch)
  // drag a booked name to another hour to move it, as on the Appointments calendar
  const [over, setOver] = useState<string | null>(null);
  const move = useMutation({
    mutationFn: ({ appt, to, overbook }: any) => patch(`/appointments/${appt.id}`, { sessionId: to.id, overbook }),
    onSuccess: (r: any, { appt, to }: any) => { ['calendar', 'frontdesk', 'queue'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); toast(`${appt.name} moved to ${to.startTime}. ${told(r?.whatsapp)}`); },
    onError: (e: any, vars: any) => {
      if (e instanceof ApiError && e.body?.code === 'WINDOW_FULL' && canOverbook && !vars.overbook) {
        ask({ title: `${vars.to.startTime} is full`, body: `Move ${vars.appt.name} into it anyway? It will go over the places set for that hour.`, confirmLabel: 'Add anyway (over the limit)', cancelLabel: 'Leave it' }).then((r) => { if (r) move.mutate({ ...vars, overbook: true }); });
        return;
      }
      toast(errText(e), 'err');
    },
  });
  const drop = (e: DragEvent, w: any) => { e.preventDefault(); setOver(null); try { const a = JSON.parse(e.dataTransfer.getData('application/x-appt')); if (a.sessionId !== w.id) move.mutate({ appt: a, to: w }); } catch { /* not ours */ } };

  const docList = doctors.map((d) => ({ key: `d:${d.id}`, label: d.name as string, on: docOn(d.id) }));
  const roomList = rooms.map((r) => ({ key: `r:${r.id}`, label: r.name as string, on: roomOn(r.id) }));
  const [pickOpen, setPickOpen] = useState(false); const pickBtn = useRef<HTMLButtonElement>(null);
  const onD = docList.filter((c) => c.on), onR = roomList.filter((c) => c.on);
  // what the closed button says: up to two names, else counts, so the bar stays one line
  const n = (k: number, one: string) => `${k} ${one}${k === 1 ? '' : 's'}`;
  const summary = onD.length + onR.length === 0 ? 'Nothing' : onD.length + onR.length <= 2 ? [...onD, ...onR].map((c) => c.label).join(', ') : onD.length === docList.length && !onR.length ? 'All doctors' : [onD.length && n(onD.length, 'doctor'), onR.length && n(onR.length, 'room')].filter(Boolean).join(' · ');
  const tick = (c: { key: string; label: string; on: boolean }) => <label key={c.key} className="flex cursor-pointer items-center gap-2.5 rounded-[8px] px-2.5 py-2 text-[13.5px] hover:bg-paper-2"><input type="checkbox" className="accent-ink h-4 w-4" checked={c.on} onChange={(e) => setShown(c.key, e.target.checked)} />{c.label}</label>;
  const bar = (
    <div className="fd-sch-bar">
      <button type="button" className="btn btn-icon !h-8 !w-8" aria-label={week ? 'Previous week' : 'Previous day'} onClick={() => setDay(shift(day, -step))}><Icon name="chevL" className="h-4 w-4" /></button>
      <label className="fd-sch-date"><span>{week ? `${dayName(monday(day))} – ${dayName(shift(monday(day), 6))}` : isToday ? `Today · ${dayName(day)}` : dayName(day)}</span><input type="date" aria-label="Pick a day" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} /></label>
      <button type="button" className="btn btn-icon !h-8 !w-8" aria-label={week ? 'Next week' : 'Next day'} onClick={() => setDay(shift(day, step))}><Icon name="chevR" className="h-4 w-4" /></button>
      <Segmented<'day' | 'week'> size="sm" value={mode} onChange={(m) => { setMode(m); if (m === 'day') setDay(today); }} options={[{ value: 'day', label: 'Today' }, { value: 'week', label: 'Week' }]} />
      {!week && !isToday && <button type="button" className="btn btn-sm" onClick={() => setDay(today)}>Back to today</button>}
      <span className="ml-auto" />
      {docList.length + roomList.length > 1 && <><button ref={pickBtn} type="button" className="fd-cal on max-w-[300px]" aria-haspopup="true" aria-expanded={pickOpen} onClick={() => setPickOpen(!pickOpen)}><Icon name="filter" className="h-3.5 w-3.5 shrink-0 text-muted" /><span className="text-muted">Show</span><span className="min-w-0 truncate">{summary}</span></button>
        <Floating anchor={pickBtn} open={pickOpen} onClose={() => setPickOpen(false)} width={260}>
          <div className="max-h-[60vh] overflow-y-auto p-1.5">
            <div className="px-2.5 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">Doctors</div>{docList.map(tick)}
            {roomList.length > 0 && <><div className="mt-1 border-t border-line/60 px-2.5 pb-1 pt-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted">Rooms · procedures</div>{roomList.map(tick)}</>}
          </div>
        </Floating></>}
      {tools}
    </div>);
  if (week) return <div className="fd-sheet fd-sch anim-fade-up overflow-hidden">{bar}<WeekGrid from={monday(day)} today={today} docs={doctors.filter((d) => docOn(d.id))} onOpenDay={(d) => { setDay(d); setMode('day'); }} /></div>;
  if (!cal.data || (!isToday && other.isLoading)) return <div className="fd-sheet fd-sch overflow-hidden">{bar}<div className="p-4"><Skeleton rows={4} /></div></div>;

  const now = new Date(); const nowM = now.getHours() * 60 + now.getMinutes();
  const windows: any[] = cal.data.windows ?? []; const procs: any[] = cal.data.procedures ?? [];
  const gone = (end: string) => isPast || (isToday && toMin(end) <= nowM);
  const docCols = doctors.filter((d) => docOn(d.id)).map((d) => ({ d, ws: windows.filter((w) => w.practitionerId === d.id) }));
  const roomCols = [...rooms.filter((r) => roomOn(r.id)).map((r) => ({ r, ps: procs.filter((p) => p.roomId === r.id) })), ...(onR.length && procs.some((p) => !p.roomId) ? [{ r: { id: '__none', name: 'No room' }, ps: procs.filter((p) => !p.roomId) }] : [])];
  const nCols = docCols.length + roomCols.length;
  if (!nCols) return <div className="fd-sheet fd-sch overflow-hidden">{bar}<div className="py-10 text-center text-muted">Pick a doctor or room in Show to see the day.</div></div>;

  // one row per booking hour (windows that start together share a row); sittings sit in the row their start falls in
  const starts = [...new Set(docCols.flatMap((c) => c.ws.map((w) => w.startTime)))].sort();
  const rows = starts.map((s) => { const any = docCols.flatMap((c) => c.ws).find((w) => w.startTime === s)!; return { start: s, end: any.endTime }; });
  const shownRooms = new Set(roomCols.map((c) => c.r.id));
  const docProcs = (id: string) => (procsInDoc ? procs.filter((p) => p.practitionerId === id && !shownRooms.has(p.roomId ?? '__none')) : []);
  for (const ps of [...roomCols.map((c) => c.ps), ...docCols.map((c) => docProcs(c.d.id))]) for (const p of ps) if (!rows.some((r) => p.startTime >= r.start && p.startTime < r.end)) rows.push({ start: p.startTime, end: p.endTime });
  rows.sort((a, b) => a.start.localeCompare(b.start));
  const rowOf = (t: string) => rows.find((r) => t >= r.start && t < r.end) ?? [...rows].reverse().find((r) => r.start <= t) ?? rows[0];

  // a checked-in patient sits in their booking's hour; a walk-in in the hour they arrived
  const homeOf = (v: any, ws: any[]) => ws.find((w) => w.appointments?.some((a: any) => a.id === v.appointmentId)) ?? ws.find((w) => w.startTime === rowOf(hhmm(v.arrivedAt))?.start);
  const visitChip = (v: any) => {
    const k = kindOf(v); const next = isToday && nextIds.has(v.id);
    const tag = k === 'intake' ? 'with junior' : k === 'doctor' || k === 'tests' ? '' : next ? 'next' : v.details?.reportsEncounterId ? 'reports' : !v.appointmentId && k !== 'done' ? 'walk-in' : '';
    return <Chip key={v.id} k={k} next={next} tok={k === 'done' ? '✓' : ''} name={v.patient.fullName} tag={tag} warn={k === 'tests'} sel={selectedId === v.id}
      onClick={() => (isToday ? onVisit(v.id) : nav(`/patients/${v.patient.id}`))} />;
  };
  const apptChip = (a: any, w: any) => {
    const k: Kind = a.status === 'no_show' ? 'noshow' : gone(w.endTime) ? 'late' : 'booked';
    const canDrag = !!onBook && k === 'booked' && ['booked', 'confirmed'].includes(a.status);
    return <Chip key={a.id} k={k} next={false} tok="" name={a.name} tag={k === 'late' || k === 'noshow' ? "didn't come" : a.service ?? ''} sel={false} onClick={() => onOpenAppt(a.id)}
      drag={canDrag ? (e) => { e.dataTransfer.setData('application/x-appt', JSON.stringify({ id: a.id, sessionId: w.id, name: a.name })); e.dataTransfer.effectAllowed = 'move'; } : undefined} />;
  };
  const sitChip = (p: any) => { const k = SITTING[p.state] ?? 'booked'; return <Chip key={p.id} k={k} proc next={false} tok={k === 'done' ? '✓' : ''} name={`${p.procedure ?? 'Procedure'} · ${p.patient}`} tag={`${p.startTime}${p.room && procsInDoc ? ` · ${p.room}` : ''}`} sel={false} onClick={() => nav(`/worklist?day=${day}`)} />; };
  const nowRow = isToday ? rows.findIndex((r) => toMin(r.start) <= nowM && nowM < toMin(r.end)) : -1;

  return (
    <div className="fd-sheet fd-sch anim-fade-up overflow-hidden">
      {bar}
      <div className="overflow-x-auto">
        <div className="fd-hgrid" style={{ minWidth: 88 + nCols * 230, gridTemplateColumns: `88px repeat(${nCols}, minmax(0, 1fr))` }}>
          <span className="fd-hh" />
          {docCols.map(({ d }) => <span key={d.id} className="fd-hh"><b>{d.name}</b></span>)}
          {roomCols.map(({ r }) => <span key={r.id} className="fd-hh"><b>{r.name}</b> <span>procedures</span></span>)}
          {rows.map((r, i) => {
            const past = gone(r.end);
            return [
              <span key={`t${r.start}`} className={`fd-ht ${i === nowRow ? 'now' : ''} ${past ? 'past' : ''}`}>{hourLabel(r.start, r.end)}{i === nowRow && <small>now</small>}</span>,
              ...docCols.map(({ d, ws }) => {
                const w = ws.find((x) => x.startTime === r.start);
                const sits = docProcs(d.id).filter((p) => rowOf(p.startTime) === r);
                if (!w) return <div key={d.id + r.start} className={`fd-hc ${sits.length ? '' : 'off'} ${i === nowRow ? 'now' : ''}`}>{sits.length ? <div className="fd-hchips">{sits.map(sitChip)}</div> : ws.length ? '' : 'not in'}</div>;
                const here = visits.filter((v) => v.practitionerId === d.id && homeOf(v, ws)?.id === w.id);
                const booked = (w.appointments ?? []).filter((a: any) => a.status !== 'arrived' && a.status !== 'cancelled' && !visits.some((v) => v.appointmentId === a.id));
                const shut = w.effectiveCapacity === 0 && w.reductions?.length;
                const canDrop = !!onBook && !past && !shut;
                return (
                  <div key={d.id + r.start} className={`fd-hc ${i === nowRow ? 'now' : ''} ${over === w.id ? 'drop' : ''}`}
                    onDragOver={canDrop ? (e) => { if (e.dataTransfer.types.includes('application/x-appt')) { e.preventDefault(); setOver(w.id); } } : undefined}
                    onDragLeave={() => setOver(null)} onDrop={canDrop ? (e) => drop(e, w) : undefined}>
                    <span className="fd-hcap">{shut ? w.reductions[0].note ?? 'Closed' : `${w.allocated} of ${w.effectiveCapacity} booked`}</span>
                    <div className="fd-hchips">{here.map(visitChip)}{sits.map(sitChip)}{booked.map((a: any) => apptChip(a, w))}</div>
                    {!shut && !past && w.free > 0 && onBook && <button type="button" className="fd-sch-free" onClick={() => onBook({ ...w, day })}>+ Book · {w.free} free</button>}
                  </div>);
              }),
              ...roomCols.map(({ r: room, ps }) => {
                const mine = ps.filter((p) => rowOf(p.startTime) === r);
                return (
                  <div key={room.id + r.start} className={`fd-hc ${i === nowRow ? 'now' : ''}`}>
                    {!mine.length && <span className="fd-hcap">free</span>}
                    <div className="fd-hchips">{mine.map(sitChip)}</div>
                  </div>);
              }),
            ];
          })}
        </div>
      </div>
      <div className="fd-hkey">
        <span><i className="fd-k-booked" />Booked</span><span><i className="fd-k-waiting" />Here, waiting</span><span><i className="fd-k-next" />Next</span><span><i className="fd-k-doctor" />With doctor</span>
        <span className="text-muted">✓ Done</span><span className="text-rose">Didn't come</span><span><span className="fd-warn">!</span> Tests or procedures pending</span>
        <span className="ml-auto">{onBook ? 'Tap a name for details, “+ Book” to book that hour, drag a booking to move it.' : 'Tap a name for details.'}</span>
      </div>
    </div>);
}

function Chip({ k, next, tok, name, tag, warn = false, sel, onClick, drag, proc = false }: { proc?: boolean; k: Kind; next: boolean; tok: string; name: string; tag: string; warn?: boolean; sel: boolean; onClick: () => void; drag?: (e: DragEvent) => void }) {
  return <button type="button" className={`fd-pc fd-k-${proc && k === 'booked' ? 'proc' : k} ${next ? 'fd-k-next' : ''} ${sel ? 'sel' : ''}`} title={`${name} · ${next ? 'Next' : LABEL[k]}${drag ? ' · drag to move' : ''}`} aria-pressed={sel} onClick={onClick} draggable={!!drag} onDragStart={drag}>
    {tok && <span className="tk">{tok}</span>}<span className="truncate">{name}</span>{warn && <span className="warn" aria-label="Pending">!</span>}{tag && <span className="tg">{tag}</span>}</button>;
}

const stripe = { background: 'repeating-linear-gradient(45deg,rgba(0,0,0,.05) 0 6px,transparent 6px 12px)' };
/** Week: how full each doctor's days are. One doctor gets morning, evening and procedures; several get a row each. A box opens that day. */
function WeekGrid({ from, today, docs, onOpenDay }: { from: string; today: string; docs: any[]; onOpenDay: (d: string) => void }) {
  const q = useQuery({ queryKey: ['calendar', 'range', from, 'all'], queryFn: () => get(`/calendar/range?from=${from}&days=7`), refetchInterval: 30000 });
  if (!docs.length) return <div className="py-10 text-center text-muted">Pick a doctor in Show to see the week.</div>;
  if (!q.data) return <div className="p-4"><Skeleton rows={5} /></div>;
  const days: any[] = q.data.filter((d: any, i: number) => i < 6 || d.windows.length); // Sunday only when someone works it
  const one = docs.length === 1;
  const box = (d: any, pid: string, part?: 'am' | 'pm') => {
    const ws = d.windows.filter((w: any) => w.practitionerId === pid && (!part || (part === 'am' ? w.startTime < '14:00' : w.startTime >= '14:00')));
    const away = d.blocks.find((b: any) => b.practitionerId === pid && b.kind === 'leave');
    if (away) return { text: 'Away', sub: away.note?.replace(/^Away · ?/, '') ?? '', cls: 'text-muted', style: stripe };
    if (!ws.length) return { text: '—', sub: part ? '' : 'not working', cls: 'text-muted', style: {} };
    const a = ws.reduce((n: number, w: any) => n + w.allocated, 0); const c = ws.reduce((n: number, w: any) => n + w.effectiveCapacity, 0);
    return { text: `${a} of ${c}`, sub: c - a > 0 ? `${c - a} free` : 'full', cls: `fd-k-booked ${c && a / c >= 0.95 ? '!text-rose' : ''}`, style: {}, r: c ? a / c : 1 };
  };
  const cell = (doc: any, part?: 'am' | 'pm') => (d: any) => { const b = box(d, doc.id, part); return (
    <button type="button" onClick={() => onOpenDay(d.day)} className={`w-full rounded-[8px] px-2.5 py-2 text-left text-[13px] font-bold ${b.cls}`} style={b.style} aria-label={`${doc.name} ${d.day}`}>
      {b.text}<span className="block text-[11px] font-medium">{b.sub}</span>
      {b.r !== undefined && <span className="mt-1 block h-1 overflow-hidden rounded bg-black/5"><i className="block h-full bg-clay" style={{ width: `${Math.min(100, b.r * 100)}%` }} /></span>}
    </button>); };
  const rows: { key: string; head: React.ReactNode; cell: (d: any) => React.ReactNode }[] = docs.flatMap((doc) => !one ? [{ key: doc.id, head: <b className="text-[13px]">{doc.name}</b>, cell: cell(doc) }] : [
    { key: 'am', head: <><b className="text-[13px]">Morning</b><span className="block text-[11px] text-muted">before 2 pm</span></>, cell: cell(doc, 'am') },
    { key: 'pm', head: <><b className="text-[13px]">Evening</b><span className="block text-[11px] text-muted">from 2 pm</span></>, cell: cell(doc, 'pm') },
    { key: 'pr', head: <b className="text-[13px]">Procedures</b>, cell: (d: any) => { const n = d.procedures.filter((p: any) => p.practitionerId === doc.id).length; return n ? <button type="button" onClick={() => onOpenDay(d.day)} className="fd-k-proc w-full rounded-[8px] px-2.5 py-2 text-left text-[13px] font-bold">{n} sitting{n === 1 ? '' : 's'}</button> : <span className="px-2.5 text-muted">—</span>; } }]);
  return (
    <div className="overflow-x-auto p-4">
      <div className="grid min-w-[720px] gap-x-1.5" style={{ gridTemplateColumns: `130px repeat(${days.length}, minmax(0,1fr))` }}>
        <span />{days.map((d) => { const n = docs.reduce((s, doc) => s + d.windows.filter((w: any) => w.practitionerId === doc.id).reduce((m: number, w: any) => m + w.allocated, 0), 0); return (
          <button type="button" key={d.day} onClick={() => onOpenDay(d.day)} className={`pb-2 text-left text-sm font-bold ${d.day === today ? 'text-clay' : ''}`}>{new Date(d.day + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric' })}{d.day === today ? ' · today' : ''}<span className="block text-[11px] font-medium text-muted">{n} booked</span></button>); })}
        {rows.map((r) => [<div key={r.key} className="border-t border-line/60 py-2.5 pr-2">{r.head}</div>, ...days.map((d) => <div key={r.key + d.day} className="border-t border-line/60 py-1.5">{r.cell(d)}</div>)])}
      </div>
      <div className="mt-3 text-xs text-muted">Booked of the places; red means full. Click a day to open it by the hour.</div>
    </div>
  );
}
