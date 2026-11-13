import { useRef, useState, type DragEvent } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { get, patch, qc, errText, ApiError } from '../api';
import { Floating, Icon, Segmented, Skeleton, ask, toast } from '../ui';
import { told } from '../apptDrawer';

export type Kind = 'booked' | 'late' | 'waiting' | 'intake' | 'doctor' | 'tests' | 'done' | 'noshow';
const LABEL: Record<Kind, string> = { booked: 'Booked, not here yet', late: 'Booked, did not come', waiting: 'Waiting', intake: 'With the junior doctor', doctor: 'With the doctor', tests: 'Tests & procedures pending', done: 'Done', noshow: "Didn't come" };
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

type ChipP = { id: string; k: Kind; next?: boolean; tok?: string; name: string; tag: string; who: string; warn?: boolean; sel?: boolean; proc?: boolean; onClick: () => void; drag?: (e: DragEvent) => void };
type Col = { key: string; head: React.ReactNode; day: string; ws: any[]; /** null: that day's check-ins are not loaded, the bookings carry the status */ visits: any[] | null; sits: any[]; room?: boolean };

/** The one calendar on the Dashboard, for the desk and for doctors. Today is a column per doctor (and per room when asked for), Week is a column
 *  per day; both are the same grid, a row per booking hour, and `list` shows the same people as table rows under the same bar.
 *  Patients are booked into an hour, not a minute, and seen in the order they arrive. A name opens the side drawer, "+ Book" books that hour.
 *  Colours stay calm: booked is a thin outline, here is warm grey, next is light teal, with the doctor is slate, done is grey text. */
export function DaySchedule({ today, visitsToday, doctors, rooms, selectedId, kindOf, nextIds, onVisit, onOpenAppt, onBook, canOverbook = false, tools, procsInDoc = false, list = false }: {
  today: string; visitsToday: any[]; doctors: any[]; rooms: any[]; selectedId: string | null; kindOf: (v: any) => Kind; nextIds: Set<string>;
  onVisit: (id: string) => void; onOpenAppt: (id: string) => void; onBook?: (w: any) => void; canOverbook?: boolean; tools?: React.ReactNode;
  /** a doctor's own calendar: their sittings sit in their column when the room's column is not shown */ procsInDoc?: boolean;
  /** the same people as rows of a table instead of the grid */ list?: boolean;
}) {
  const nav = useNavigate();
  const [day, setDay] = useState(today);
  const [mode, setMode] = useState<'day' | 'week'>('day'); const week = mode === 'week'; const step = week ? 7 : 1;
  const [shown, setShown] = useShown();
  const isToday = day === today; const from = monday(day);
  const showFree = shown.free !== false; // empty places in each hour, on unless switched off below the calendar
  const cal = useQuery({ queryKey: ['calendar', day, 'all'], queryFn: () => get(`/calendar?day=${day}`), refetchInterval: isToday ? 15000 : false, enabled: !week });
  const range = useQuery({ queryKey: ['calendar', 'range', from, 'all'], queryFn: () => get(`/calendar/range?from=${from}&days=7`), refetchInterval: 30000, enabled: week });
  const other = useQuery({ queryKey: ['frontdesk', day], queryFn: () => get(`/frontdesk?day=${day}`), enabled: !isToday && !week }); // another day's checked-in patients
  const docOn = (id: string) => shown[`d:${id}`] !== false; // doctors on unless switched off
  const roomOn = (id: string) => shown[`r:${id}`] ?? shown.rooms === true; // rooms off unless switched on (one by one; 'rooms' was the old all-rooms switch)
  // drag a booked name to another hour to move it
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
      <label className="fd-sch-date"><span>{week ? `${dayName(from)} – ${dayName(shift(from, 6))}` : isToday ? `Today · ${dayName(day)}` : dayName(day)}</span><input type="date" aria-label="Pick a day" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} /></label>
      <button type="button" className="btn btn-icon !h-8 !w-8" aria-label={week ? 'Next week' : 'Next day'} onClick={() => setDay(shift(day, step))}><Icon name="chevR" className="h-4 w-4" /></button>
      <Segmented<'day' | 'week'> size="sm" value={mode} onChange={(m) => { setMode(m); if (m === 'day') setDay(today); }} options={[{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }]} />
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
  const keyRow = (
    <div className="fd-hkey">
      <span><i className="fd-k-booked" />Booked</span><span><i className="fd-k-waiting" />Here, waiting</span><span><i className="fd-k-next" />Next</span><span><i className="fd-k-doctor" />With doctor</span>
      <span><i className="fd-k-done" />Done</span><span><i className="fd-k-noshow" />Didn't come</span><span><span className="fd-warn">!</span> Tests or procedures pending</span>
    </div>);
  const sheet = (inner: React.ReactNode) => <div className="fd-sheet fd-sch overflow-hidden">{bar}{keyRow}{inner}</div>;
  const days: any[] | undefined = week ? range.data : cal.data && [cal.data];
  if (!days || (!week && !isToday && other.isLoading)) return sheet(<div className="p-4"><Skeleton rows={4} /></div>);

  const now = new Date(); const nowM = now.getHours() * 60 + now.getMinutes();
  const gone = (d: string, end: string) => d < today || (d === today && toMin(end) <= nowM);
  const onDocs = doctors.filter((d) => docOn(d.id)); const docIds = new Set(onDocs.map((d) => d.id)); const onRooms = rooms.filter((r) => roomOn(r.id));
  const docNameOf = (id: string) => doctors.find((d) => d.id === id)?.name ?? '';
  let cols: Col[];
  if (week) {
    const roomIds = new Set(onRooms.map((r) => r.id));
    cols = days.filter((D, i) => i < 6 || D.windows.length).map((D) => ({ key: D.day, day: D.day, // Sunday only when someone works it
      head: <button type="button" className="text-left" title="Open this day" onClick={() => { setDay(D.day); setMode('day'); }}><b className={D.day === today ? 'text-clay' : ''}>{new Date(D.day + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric' })}</b>{D.day === today && <span> today</span>}</button>,
      ws: D.windows.filter((w: any) => docIds.has(w.practitionerId)), visits: D.day === today ? visitsToday.filter((v) => docIds.has(v.practitionerId)) : null,
      sits: D.procedures.filter((p: any) => (procsInDoc && docIds.has(p.practitionerId)) || roomIds.has(p.roomId)) }));
  } else {
    const D = days[0]; const procs: any[] = D.procedures ?? []; const visits: any[] = isToday ? visitsToday : other.data?.visits ?? [];
    const roomCols: Col[] = [...onRooms, ...(onRooms.length && procs.some((p) => !p.roomId) ? [{ id: '__none', name: 'No room' }] : [])]
      .map((r) => ({ key: r.id, room: true, day, head: <><b>{r.name}</b> <span>procedures</span></>, ws: [], visits: [], sits: procs.filter((p) => (p.roomId ?? '__none') === r.id) }));
    const inRoomCol = new Set(roomCols.map((c) => c.key));
    cols = [...onDocs.map((d): Col => ({ key: d.id, day, head: <b>{d.name}</b>, ws: D.windows.filter((w: any) => w.practitionerId === d.id), visits: visits.filter((v) => v.practitionerId === d.id),
      sits: procsInDoc ? procs.filter((p) => p.practitionerId === d.id && !inRoomCol.has(p.roomId ?? '__none')) : [] })), ...roomCols];
  }
  if (!cols.length) return sheet(<div className="py-10 text-center text-muted">Pick a doctor or room in Show to see the {week ? 'week' : 'day'}.</div>);

  // one row per booking hour (windows that start together share a row); sittings sit in the row their start falls in
  const allWs = cols.flatMap((c) => c.ws);
  const rows = [...new Set(allWs.map((w) => w.startTime))].sort().map((s) => ({ start: s as string, end: allWs.find((w) => w.startTime === s)!.endTime as string }));
  for (const p of cols.flatMap((c) => c.sits)) if (!rows.some((r) => p.startTime >= r.start && p.startTime < r.end)) rows.push({ start: p.startTime, end: p.endTime });
  rows.sort((a, b) => a.start.localeCompare(b.start));
  const rowOf = (t: string) => rows.find((r) => t >= r.start && t < r.end) ?? [...rows].reverse().find((r) => r.start <= t) ?? rows[0];

  // a checked-in patient sits in their booking's hour; a walk-in in the hour they arrived
  const homeOf = (v: any, ws: any[]) => ws.find((w) => w.appointments?.some((a: any) => a.id === v.appointmentId)) ?? ws.find((w) => w.startTime === rowOf(hhmm(v.arrivedAt))?.start);
  const visitChip = (v: any, d: string): ChipP => {
    const k = kindOf(v); const next = d === today && nextIds.has(v.id);
    const tag = k === 'intake' ? 'with junior' : k === 'doctor' || k === 'tests' ? '' : next ? 'next' : v.details?.reportsEncounterId ? 'reports' : !v.appointmentId && k !== 'done' ? 'walk-in' : '';
    return { id: v.id, k, next, name: v.patient.fullName, tag, who: docNameOf(v.practitionerId), warn: k === 'tests', sel: selectedId === v.id, onClick: () => (d === today ? onVisit(v.id) : nav(`/patients/${v.patient.id}`)) };
  };
  const apptChip = (a: any, w: any, d: string): ChipP => {
    // 'arrived' only reaches here on days whose check-ins are not loaded: the booking's own visit status stands in
    const k: Kind = a.status === 'no_show' || a.visitStatus === 'left' ? 'noshow' : a.status === 'arrived' ? (a.visitStatus === 'done' ? 'done' : a.visitStatus === 'in_consult' ? 'doctor' : 'waiting') : gone(d, w.endTime) ? 'late' : 'booked';
    const canDrag = !!onBook && k === 'booked' && ['booked', 'confirmed'].includes(a.status);
    return { id: a.id, k, name: a.name, tag: k === 'late' || k === 'noshow' ? "didn't come" : a.service ?? '', who: docNameOf(w.practitionerId), onClick: () => onOpenAppt(a.id),
      drag: canDrag ? (e) => { e.dataTransfer.setData('application/x-appt', JSON.stringify({ id: a.id, sessionId: w.id, name: a.name })); e.dataTransfer.effectAllowed = 'move'; } : undefined };
  };
  const sitChip = (p: any, c: Col): ChipP => { const k = SITTING[p.state] ?? 'booked'; return { id: p.id, k, proc: true, name: `${p.procedure ?? 'Procedure'} · ${p.patient}`, tag: `${p.startTime}${p.room && !c.room && !week ? ` · ${p.room}` : ''}`, who: p.room ?? p.doctor ?? '', onClick: () => nav(`/worklist?day=${c.day}`) }; };
  /** who is in a column's hour: here first, then sittings, then booked */
  const cell = (c: Col, r: { start: string }) => {
    const wsAt = c.ws.filter((w) => w.startTime === r.start);
    const here = (c.visits ?? []).filter((v) => { const h = homeOf(v, c.ws.filter((w) => w.practitionerId === v.practitionerId)); return !!h && wsAt.includes(h); });
    const booked: ChipP[] = wsAt.flatMap((w) => (w.appointments ?? []).filter((a: any) => a.status !== 'cancelled' && (!c.visits || (a.status !== 'arrived' && !c.visits.some((v) => v.appointmentId === a.id)))).map((a: any) => apptChip(a, w, c.day)));
    return { wsAt, chips: [...here.map((v) => visitChip(v, c.day)), ...c.sits.filter((p) => rowOf(p.startTime) === r).map((p) => sitChip(p, c)), ...booked] };
  };

  if (list) {
    const items = cols.flatMap((c) => rows.flatMap((r) => cell(c, r).chips.map((p) => ({ ...p, day: c.day, r }))));
    if (!week) items.sort((a, b) => a.r.start.localeCompare(b.r.start)); // a day reads by the hour across doctors; a week reads day by day
    return sheet(!items.length ? <div className="py-10 text-center text-muted">Nobody booked {week ? 'this week' : isToday ? 'today' : 'on this day'}.</div> : (
      <div className="overflow-x-auto"><table className="fd-table">
        <thead><tr>{week && <th>Day</th>}<th>Time</th><th>Patient</th><th>With</th><th>Status</th></tr></thead>
        <tbody>{items.map((p) => (
          <tr key={p.day + p.id} className={`cursor-pointer ${selectedId === p.id ? 'bg-surface-2' : 'hover:bg-surface-2'}`} onClick={p.onClick}>
            {week && <td className="whitespace-nowrap">{dayName(p.day)}</td>}
            <td className="whitespace-nowrap text-muted">{hourLabel(p.r.start, p.r.end)}</td>
            <td><button type="button" className="text-left font-semibold hover:underline" >{p.name}</button>{p.tag && <span className="ml-2 text-[12px] text-muted">{p.tag}</span>}</td>
            <td>{p.who}</td>
            <td className={p.k === 'late' || p.k === 'noshow' ? 'text-rose' : p.k === 'done' ? 'text-muted' : ''}><i className={`sw fd-k-${p.next ? 'next' : p.k}`} />{p.warn && <span className="fd-warn mr-1.5">!</span>}{p.next ? 'Next' : LABEL[p.k]}</td>
          </tr>))}</tbody>
      </table></div>));
  }

  const nowRow = cols.some((c) => c.day === today) ? rows.findIndex((r) => toMin(r.start) <= nowM && nowM < toMin(r.end)) : -1;
  return sheet(<>
      <div>
        <div className="fd-hgrid" style={{ gridTemplateColumns: `88px repeat(${cols.length}, minmax(0, 1fr))` }}>
          {(week || cols.length > 1) && <><span className="fd-hh" />{cols.map((c) => <span key={c.key} className="fd-hh">{c.head}</span>)}</>}
          {rows.map((r, i) => [
            <span key={`t${r.start}`} className={`fd-ht ${i === nowRow ? 'now' : ''} ${!week && gone(day, r.end) ? 'past' : ''}`}>{hourLabel(r.start, r.end)}{i === nowRow && <small>now</small>}</span>,
            ...cols.map((c) => {
              const { wsAt, chips } = cell(c, r); const nowC = i === nowRow && c.day === today ? 'now' : ''; const key = c.key + r.start;
              const names = chips.length > 0 && <div className="fd-hchips">{chips.map((p) => <Chip key={p.id} {...p} />)}</div>;
              if (c.room) return <div key={key} className={`fd-hc ${nowC}`}>{!chips.length && <span className="fd-hcap">free</span>}{names}</div>;
              if (!wsAt.length) return <div key={key} className={`fd-hc ${chips.length ? '' : 'off'} ${nowC}`}>{names || (c.ws.length ? '' : 'not in')}</div>;
              const past = gone(c.day, r.end); const one = wsAt.length === 1 ? wsAt[0] : null; // "+ Book" and drop need one doctor's hour
              const shut = wsAt.every((w) => w.effectiveCapacity === 0 && w.reductions?.length);
              const canDrop = !!onBook && !!one && !past && !shut;
              return (
                <div key={key} className={`fd-hc ${nowC} ${one && over === one.id ? 'drop' : ''}`}
                  onDragOver={canDrop ? (e) => { if (e.dataTransfer.types.includes('application/x-appt')) { e.preventDefault(); setOver(one!.id); } } : undefined}
                  onDragLeave={() => setOver(null)} onDrop={canDrop ? (e) => drop(e, one) : undefined}>
                  {shut && (wsAt[0].reductions[0].kind === 'procedure'
                    ? <button type="button" className="fd-hcap text-left hover:underline" title="Open the day's procedures" onClick={() => nav(`/worklist?day=${c.day}`)}>Doctor in a procedure · no new bookings · {wsAt[0].reductions[0].note}</button>
                    : <span className="fd-hcap">{wsAt[0].reductions[0].note ?? 'Closed'}</span>)}
                  {(chips.length > 0 || (showFree && !shut && !past && one && one.free > 0 && onBook)) && <div className="fd-hchips">
                    {chips.map((p) => <Chip key={p.id} {...p} />)}
                    {showFree && !shut && !past && one && onBook && Array.from({ length: Math.max(0, one.free) }, (_, j) =>
                      <button key={j} type="button" className="fd-pc fd-free" onClick={() => onBook({ ...one, day: c.day })}>+ Book</button>)}
                  </div>}
                </div>);
            }),
          ])}
        </div>
      </div>
      {onBook && <label className="fd-hfoot"><input type="checkbox" className="accent-ink h-3.5 w-3.5" checked={showFree} onChange={(e) => setShown('free', e.target.checked)} />Show free slots</label>}
    </>);
}

function Chip({ k, next = false, tok, name, tag, who, warn = false, sel = false, onClick, drag, proc = false }: ChipP) {
  return <button type="button" className={`fd-pc fd-k-${proc && k === 'booked' ? 'proc' : k} ${next ? 'fd-k-next' : ''} ${sel ? 'sel' : ''}`} title={`${name} · ${next ? 'Next' : LABEL[k]}${who ? ` · ${who}` : ''}${drag ? ' · drag to move' : ''}`} aria-pressed={sel} onClick={onClick} draggable={!!drag} onDragStart={drag}>
    {tok && <span className="tk">{tok}</span>}<span className="truncate">{name}</span>{warn && <span className="warn" aria-label="Pending">!</span>}{tag && <span className="tg">{tag}</span>}</button>;
}
