import { useRef, useState, type DragEvent } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useNavigate, useOutletContext } from 'react-router';
import { can } from '../App';
import { ProcedureDrawer } from '../procDrawer';
import { get, patch, qc, errText, ApiError } from '../api';
import { Floating, cap, Icon, Segmented, Skeleton, Tabs, ask, toast } from '../ui';
import { told } from '../apptDrawer';

export type Kind = 'booked' | 'late' | 'waiting' | 'intake' | 'doctor' | 'tests' | 'done' | 'noshow' | 'cancelled';
const LABEL: Record<Kind, string> = { booked: 'Booked, not here yet', late: 'Booked, did not come', waiting: 'Waiting', intake: 'With the junior doctor', doctor: 'With the doctor', tests: 'Completed · tests & procedures pending', done: 'Completed', noshow: "Didn't come", cancelled: 'Cancelled' };
const SITTING: Record<string, Kind> = { confirmed: 'booked', in_progress: 'doctor', completed: 'done', missed: 'noshow' };
/** The key doubles as a filter: each entry and the cards it stands for. Pick one or more; none picked shows everyone. */
const KEY: { id: string; label: string; sw?: string; match: (c: { k: Kind; proc?: boolean; warn?: boolean; next?: boolean }) => boolean }[] = [
  { id: 'here', label: 'Here', sw: 'fd-k-waiting', match: (c) => ['waiting', 'intake'].includes(c.k) || !!c.next },
  { id: 'doctor', label: 'With doctor', sw: 'fd-k-doctor', match: (c) => c.k === 'doctor' },
  { id: 'booked', label: 'Booked', sw: 'fd-k-booked', match: (c) => c.k === 'booked' },
  { id: 'done', label: 'Completed', sw: 'fd-k-done', match: (c) => c.k === 'done' || c.k === 'tests' },
  { id: 'missed', label: "Didn't come", sw: 'fd-k-noshow', match: (c) => c.k === 'late' || c.k === 'noshow' },
  { id: 'proc', label: 'Procedure', match: (c) => !!c.proc },
  { id: 'pending', label: 'Tests or procedures pending', match: (c) => !!c.warn },
];
const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const hhmm = (iso: string) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const shift = (day: string, n: number) => { const d = new Date(day + 'T00:00:00'); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const monday = (day: string) => shift(day, -((new Date(day + 'T00:00:00').getDay() + 6) % 7));
const dayName = (day: string) => new Date(day + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
/** "9–10 am", "12–1 pm": how the clinic says an hour */
const hourLabel = (a: string, b: string) => { const f = (m: number) => { const h = Math.floor(m / 60) % 12 || 12; const mm = m % 60; return mm ? `${h}:${String(mm).padStart(2, '0')}` : `${h}`; }; const s = toMin(a), e = toMin(b); return `${f(s)}–${f(e)} ${e > 12 * 60 ? 'pm' : 'am'}`; };

/** Which calendars this computer shows: picked once, kept. Rooms are off unless asked for. */
function useShown(): [Record<string, any>, (k: string, on: boolean | string) => void] {
  const [s, setS] = useState<Record<string, any>>(() => { try { return JSON.parse(localStorage.getItem('fd.cals') ?? '{}'); } catch { return {}; } });
  return [s, (k, on) => { const n = { ...s, [k]: on }; setS(n); try { localStorage.setItem('fd.cals', JSON.stringify(n)); } catch { /* storage blocked */ } }];
}

type ChipP = { id: string; k: Kind; next?: boolean; tok?: string; name: string; tag: string; who: string; warn?: boolean; sel?: boolean; proc?: boolean; /** the procedure's name, after the patient */ sub?: string; /** more for the tooltip: the service, the time and room */ info?: string; /** a procedure's part of the hour: where it starts and how much it takes, 0–1 */ at?: [number, number]; onClick: () => void; drag?: (e: DragEvent) => void };
type Col = { key: string; head: React.ReactNode; day: string; ws: any[]; /** null: that day's check-ins are not loaded, the bookings carry the status */ visits: any[] | null; sits: any[]; room?: boolean };

/** The one calendar on the Dashboard, for the desk and for doctors. Today is a column per doctor (and per room when asked for), Week is a column
 *  per day; both are the same grid, a row per booking hour, and `list` shows the same people as table rows under the same bar.
 *  Patients are booked into an hour, not a minute, and seen in the order they arrive. A name opens the side drawer, "+ Book" books that hour.
 *  Calm (v62): three colours only. Booked is white, here is light indigo, with the doctor is solid indigo; done, didn't come and cancelled are grey text.
 *  A procedure keeps its state's colour and adds a teal edge and a syringe. Hours already over fold into one line; later hours are one line each until opened. */
export function DaySchedule({ today, visitsToday, doctors, rooms, selectedId, kindOf, nextIds, onVisit, onOpenAppt, onBook, canOverbook = false, tools, procsInDoc = false, list = false }: {
  today: string; visitsToday: any[]; doctors: any[]; rooms: any[]; selectedId: string | null; kindOf: (v: any) => Kind; nextIds: Set<string>;
  onVisit: (id: string) => void; onOpenAppt: (id: string) => void; onBook?: (w: any) => void; canOverbook?: boolean; tools?: React.ReactNode;
  /** a doctor's own calendar: their sittings sit in their column when the room's column is not shown */ procsInDoc?: boolean;
  /** the same people as rows of a table instead of the grid */ list?: boolean;
}) {
  const nav = useNavigate(); const { perms } = useOutletContext<any>() ?? {};
  const [procId, setProcId] = useState<string | null>(null); // a sitting opened from the calendar, in the side drawer
  const [day, setDay] = useState(today);
  const [mode, setMode] = useState<'day' | 'week'>('day'); const week = mode === 'week'; const step = week ? 7 : 1;
  const [shown, setShown] = useShown();
  const kindF = (shown.kind as unknown as 'all' | 'consult' | 'proc') || 'all'; // All / Consults / Procedures, kept on this computer
  const [keyF, setKeyF] = useState<Set<string>>(new Set()); // the key as a filter (this screen only)
  const [showPast, setShowPast] = useState(false); const [opened, setOpened] = useState<Set<string>>(new Set());
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
  const [weekDoc, setWeekDoc] = useState<string | null>(null); // Week shows one doctor's week at a time; a tab per shown doctor picks whose
  const [pickOpen, setPickOpen] = useState(false); const pickBtn = useRef<HTMLButtonElement>(null);
  const onD = docList.filter((c) => c.on), onR = roomList.filter((c) => c.on);
  // what the closed button says: up to two names, else counts, so the bar stays one line
  const n = (k: number, one: string) => `${k} ${one}${k === 1 ? '' : 's'}`;
  const summary = onD.length + onR.length === 0 ? 'Nothing' : onD.length + onR.length === 1 ? [...onD, ...onR][0].label : onD.length === docList.length && !onR.length ? 'All doctors' : [onD.length && n(onD.length, 'doctor'), onR.length && n(onR.length, 'room')].filter(Boolean).join(' · ');
  const tick = (c: { key: string; label: string; on: boolean }) => <label key={c.key} className="flex cursor-pointer items-center gap-2.5 rounded-[8px] px-2.5 py-2 text-[13.5px] hover:bg-paper-2"><input type="checkbox" className="accent-ink h-4 w-4" checked={c.on} onChange={(e) => setShown(c.key, e.target.checked)} />{c.label}</label>;
  const bar = (
    <div className="fd-sch-bar">
      <button type="button" className="btn btn-icon !h-8 !w-8" aria-label={week ? 'Previous week' : 'Previous day'} onClick={() => setDay(shift(day, -step))}><Icon name="chevL" className="h-4 w-4" /></button>
      <label className="fd-sch-date"><span>{week ? `${dayName(from)} – ${dayName(shift(from, 6))}` : isToday ? `Today · ${dayName(day)}` : dayName(day)}</span><input type="date" aria-label="Pick a day" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} /></label>
      <button type="button" className="btn btn-icon !h-8 !w-8" aria-label={week ? 'Next week' : 'Next day'} onClick={() => setDay(shift(day, step))}><Icon name="chevR" className="h-4 w-4" /></button>
      <Segmented<'day' | 'week'> size="sm" value={mode} onChange={(m) => { setMode(m); if (m === 'day') setDay(today); }} options={[{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }]} />
      {!week && !isToday && <button type="button" className="btn btn-sm" onClick={() => setDay(today)}>Back to today</button>}
      <span className="ml-auto" />
      {/* one Filter (v63): which visits, whose calendars, free slots; the button says what is narrowed */}
      <button ref={pickBtn} type="button" className="btn btn-sm max-w-[280px]" aria-haspopup="true" aria-expanded={pickOpen} onClick={() => setPickOpen(!pickOpen)}>
        <Icon name="filter" className="h-3.5 w-3.5 shrink-0 text-muted" /><span className="min-w-0 truncate">{[kindF === 'consult' ? 'Consults' : kindF === 'proc' ? 'Procedures' : null, docList.length + roomList.length > 1 ? summary : null].filter(Boolean).join(' · ') || 'Filter'}</span>
        <Icon name="chevR" className="h-3.5 w-3.5 shrink-0 rotate-90 text-muted" /></button>
      <Floating anchor={pickBtn} open={pickOpen} onClose={() => setPickOpen(false)} width={260}>
        <div className="max-h-[60vh] overflow-y-auto p-1.5">
          <div className="px-2.5 pb-1 pt-1.5 text-[12px] font-medium text-muted">Visits</div>
          {([['all', 'All visits'], ['consult', 'Consults only'], ['proc', 'Procedures only']] as const).map(([v, l]) => <label key={v} className="flex cursor-pointer items-center gap-2.5 rounded-[6px] px-2.5 py-2 text-[13.5px] hover:bg-paper-2"><input type="radio" name="fd-kind" className="accent-ink h-4 w-4" checked={kindF === v} onChange={() => setShown('kind', v)} />{l}</label>)}
          {docList.length > 1 && <><div className="mt-1 border-t border-line px-2.5 pb-1 pt-2.5 text-[12px] font-medium text-muted">Doctors</div>{docList.map(tick)}</>}
          {roomList.length > 0 && <><div className="mt-1 border-t border-line px-2.5 pb-1 pt-2.5 text-[12px] font-medium text-muted">Rooms · procedures</div>{roomList.map(tick)}</>}
          {onBook && <><div className="mt-1 border-t border-line" />{tick({ key: 'free', label: 'Show free slots', on: showFree })}</>}
        </div>
      </Floating>
      {tools}
    </div>);
  const keyRow = (
    <div className="fd-hkey" role="group" aria-label="Show only">
      {KEY.map((x) => { const on = keyF.has(x.id); return <button key={x.id} type="button" aria-pressed={on} className={`fd-key ${on ? 'on' : keyF.size ? 'off' : ''}`} title={on ? 'Showing these · tap to stop' : 'Show only these'}
        onClick={() => { const n = new Set(keyF); if (on) n.delete(x.id); else n.add(x.id); setKeyF(n); }}>
        {x.sw ? <i className={x.sw} /> : x.id === 'proc' ? <Icon name="syringe" className="fd-proc-ic h-3.5 w-3.5" /> : <span className="fd-warn">!</span>}{x.label}</button>; })}
      {keyF.size > 0 && <button type="button" className="fd-key clear" onClick={() => setKeyF(new Set())}>Show all</button>}
    </div>);
  let docTabs: React.ReactNode = null; // set below once the week is loaded
  const sheet = (inner: React.ReactNode) => <div className="fd-sheet fd-sch overflow-hidden">{bar}{docTabs}{inner}{!list && keyRow}
    {procId && <ProcedureDrawer key={procId} id={procId} canAct={can(perms ?? [], 'worklist.write')} onClose={() => setProcId(null)} />}</div>;
  const days: any[] | undefined = week ? range.data : cal.data && [cal.data];
  if (!days || (!week && !isToday && other.isLoading)) return sheet(<div className="p-4"><Skeleton rows={4} /></div>);

  const now = new Date(); const nowM = now.getHours() * 60 + now.getMinutes();
  const gone = (d: string, end: string) => d < today || (d === today && toMin(end) <= nowM);
  const onDocs = doctors.filter((d) => docOn(d.id)); const docIds = new Set(onDocs.map((d) => d.id)); const onRooms = rooms.filter((r) => roomOn(r.id));
  const docNameOf = (id: string) => doctors.find((d) => d.id === id)?.name ?? '';
  let cols: Col[];
  if (week) {
    // one week at a time: a tab per shown doctor, then a tab per shown room
    const tabs = [...onDocs.map((d) => ({ id: d.id, name: d.name as string, room: false })), ...onRooms.map((r) => ({ id: r.id, name: r.name as string, room: true }))];
    const wt = tabs.find((t) => t.id === weekDoc) ?? tabs[0]; const wIds = new Set(wt && !wt.room ? [wt.id] : []);
    if (tabs.length > 1) docTabs = <Tabs className="fd-wtabs" value={wt.id} onChange={setWeekDoc}
      options={tabs.map((t) => ({ value: t.id, label: t.name, count: days.reduce((n: number, D: any) => n + (t.room ? D.procedures.filter((p: any) => p.roomId === t.id).length : D.windows.filter((w: any) => w.practitionerId === t.id).reduce((m: number, w: any) => m + w.allocated, 0)), 0) }))} />;
    cols = days.filter((D, i) => i < 6 || D.windows.length).map((D) => ({ key: D.day, day: D.day, room: !!wt?.room, // Sunday only when someone works it
      head: <button type="button" className="text-left" title="Open this day" onClick={() => { setDay(D.day); setMode('day'); }}><b className={D.day === today ? 'text-clay' : ''}>{new Date(D.day + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric' })}</b>{D.day === today && <span> Today</span>}</button>,
      ws: D.windows.filter((w: any) => wIds.has(w.practitionerId)), visits: D.day === today ? visitsToday.filter((v) => wIds.has(v.practitionerId)) : null,
      sits: D.procedures.filter((p: any) => wt?.room ? p.roomId === wt.id : procsInDoc && wIds.has(p.practitionerId)) }));
  } else {
    const D = days[0]; const procs: any[] = D.procedures ?? []; const visits: any[] = isToday ? visitsToday : other.data?.visits ?? [];
    const roomCols: Col[] = [...onRooms, ...(onRooms.length && procs.some((p) => !p.roomId) ? [{ id: '__none', name: 'No room' }] : [])]
      .map((r) => ({ key: r.id, room: true, day, head: <><b>{r.name}</b> <span>Procedures</span></>, ws: [], visits: [], sits: procs.filter((p) => (p.roomId ?? '__none') === r.id) }));
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
  if (!rows.length) return sheet(<div className="py-10 text-center text-muted">Nothing booked {week ? 'this week' : 'on this day'}.</div>);
  const rowOf = (t: string) => rows.find((r) => t >= r.start && t < r.end) ?? [...rows].reverse().find((r) => r.start <= t) ?? rows[0];

  // a checked-in patient sits in their booking's hour; a walk-in in the hour they arrived
  const homeOf = (v: any, ws: any[]) => ws.find((w) => w.appointments?.some((a: any) => a.id === v.appointmentId)) ?? ws.find((w) => w.startTime === rowOf(hhmm(v.arrivedAt))?.start);
  const visitChip = (v: any, d: string): ChipP => {
    const k = kindOf(v); const next = d === today && nextIds.has(v.id);
    const tag = k === 'intake' ? 'with junior' : v.details?.reportsEncounterId && !['done', 'noshow'].includes(k) ? 'reports' : ''; // the colour says the rest
    return { id: v.id, k, next, name: v.patient.fullName, tag, who: docNameOf(v.practitionerId), warn: k === 'tests', sel: selectedId === v.id, onClick: () => (d === today ? onVisit(v.id) : nav(`/patients/${v.patient.id}`)) };
  };
  const apptChip = (a: any, w: any, d: string): ChipP => {
    // 'arrived' only reaches here on days whose check-ins are not loaded: the booking's own visit status stands in
    const k: Kind = a.status === 'cancelled' ? 'cancelled' : a.status === 'no_show' || a.visitStatus === 'left' ? 'noshow' : a.status === 'arrived' ? (a.visitStatus === 'done' ? 'done' : a.visitStatus === 'in_consult' ? 'doctor' : 'waiting') : gone(d, w.endTime) ? 'late' : 'booked';
    const canDrag = !!onBook && k === 'booked' && ['booked', 'confirmed'].includes(a.status);
    return { id: a.id, k, name: a.name, tag: '', info: a.service ?? undefined, who: docNameOf(w.practitionerId), onClick: () => onOpenAppt(a.id),
      drag: canDrag ? (e) => { e.dataTransfer.setData('application/x-appt', JSON.stringify({ id: a.id, sessionId: w.id, name: a.name })); e.dataTransfer.effectAllowed = 'move'; } : undefined };
  };
  // a sitting whose hour has gone by without starting counts as didn't come
  // a sitting is drawn in every hour it runs into, as long as its share of that hour (45 min = three quarters, 2 hours = two full hours)
  const inRow = (p: any, r: { start: string; end: string }) => (list ? rowOf(p.startTime) === r : p.startTime < r.end && p.endTime > r.start);
  const share = (p: any, r: { start: string; end: string }): [number, number] => { const a = toMin(r.start), len = toMin(r.end) - a || 60; const s = Math.max(toMin(p.startTime), a), e = Math.min(toMin(p.endTime), toMin(r.end));
    return [(s - a) / len, Math.max(0.15, (e - s) / len)]; };
  const sitChip = (p: any, c: Col, r?: { start: string; end: string }): ChipP => { const base = SITTING[p.state] ?? 'booked'; const k: Kind = base === 'booked' && gone(c.day, rowOf(p.startTime)?.end ?? p.startTime) ? 'late' : base; return { id: p.id, k, proc: true, name: p.patient, sub: p.procedure ?? 'Procedure', tag: '', info: [`${p.startTime}–${p.endTime}`, p.room].filter(Boolean).join(' · '), who: p.doctor ?? '', at: r && !list ? share(p, r) : undefined, onClick: () => setProcId(p.id) }; };
  // the key as a filter: Procedure narrows to procedures; the statuses add up (Completed + Didn't come shows both)
  const keyOk = (x: ChipP) => { if (!keyF.size) return true; const st = KEY.filter((y) => y.id !== 'proc' && keyF.has(y.id)); return (!keyF.has('proc') || !!x.proc) && (!st.length || st.some((y) => y.match(x))); };
  /** who is in a column's hour: here first, then sittings, then booked */
  const cell = (c: Col, r: { start: string; end: string }) => {
    const wsAt = c.ws.filter((w) => w.startTime === r.start);
    const here = (c.visits ?? []).filter((v) => { const h = homeOf(v, c.ws.filter((w) => w.practitionerId === v.practitionerId)); return !!h && wsAt.includes(h); });
    const booked: ChipP[] = wsAt.flatMap((w) => (w.appointments ?? []).filter((a: any) => !c.visits || (a.status !== 'arrived' && !c.visits.some((v) => v.appointmentId === a.id))).map((a: any) => apptChip(a, w, c.day))).sort((x, y) => Number(x.k === 'cancelled') - Number(y.k === 'cancelled'));
    const chips = [...c.sits.filter((p) => inRow(p, r)).map((p) => sitChip(p, c, r)), ...here.map((v) => visitChip(v, c.day)), ...booked];
    const keyed = chips.filter(keyOk);
    return { wsAt, chips: kindF === 'all' ? keyed : keyed.filter((x) => (kindF === 'proc') === !!x.proc) };
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
            <td className={p.k === 'cancelled' ? 'text-muted' : ''}><i className={`sw fd-k-${p.next ? 'next' : p.k}`} />{p.warn && <span className="fd-warn mr-1.5">!</span>}{p.next ? 'Next' : LABEL[p.k]}</td>
          </tr>))}</tbody>
      </table></div>));
  }

  const nowRow = cols.some((c) => c.day === today) ? rows.findIndex((r) => toMin(r.start) <= nowM && nowM < toMin(r.end)) : -1;
  // Today only: an hour that is over and has nobody still here folds into one line; from two hours after now, an hour is one line until opened
  const calm = !week && isToday;
  const ACTIVE: Kind[] = ['waiting', 'intake', 'doctor', 'tests'];
  const chipsAt = (r: { start: string; end: string }) => cols.flatMap((c) => cell(c, r).chips);
  const folded = new Set(calm && !showPast ? rows.filter((r) => gone(day, r.end) && !chipsAt(r).some((x) => ACTIVE.includes(x.k))) : []);
  const pastSum = (() => { if (!calm) return ''; const all = rows.filter((r) => gone(day, r.end)).flatMap(chipsAt); const k = (...ks: Kind[]) => all.filter((x) => ks.includes(x.k)).length;
    return [k('done', 'tests') && `${k('done', 'tests')} completed`, k('late', 'noshow') && `${k('late', 'noshow')} didn't come`, k('cancelled') && `${k('cancelled')} cancelled`].filter(Boolean).join(' · ') || 'nobody'; })();
  const anchor = nowRow >= 0 ? nowRow : rows.findIndex((r) => toMin(r.start) > nowM);
  const compact = (i: number, r: { start: string }) => calm && anchor >= 0 && i > anchor + 2 && !opened.has(r.start);
  const freeAt = (r: { start: string }) => cols.reduce((n, c) => { const ws = c.ws.filter((w) => w.startTime === r.start); return n + (ws.length === 1 && !(ws[0].effectiveCapacity === 0 && ws[0].reductions?.length) ? Math.max(0, ws[0].free) : 0); }, 0);
  const lineOf = (r: { start: string; end: string }) => { const x = chipsAt(r).filter((y) => y.k !== 'cancelled'); const pr = x.filter((y) => y.proc).length; const b = x.length - pr; const f = kindF === 'proc' ? 0 : freeAt(r);
    return [b && `${b} booked`, pr && `${pr} procedure${pr === 1 ? '' : 's'}`, f && `${f} free`].filter(Boolean).join(' · ') || 'nothing booked'; };
  return sheet(<>
      <div>
        <div className="fd-hgrid" style={{ gridTemplateColumns: `88px repeat(${cols.length}, minmax(0, 1fr))` }}>
          {(week || cols.length > 1) && <><span className="fd-hh" />{cols.map((c) => <span key={c.key} className="fd-hh">{c.head}</span>)}</>}
          {calm && folded.size > 0 && <button type="button" className="fd-fold" style={{ gridColumn: '1 / -1' }} onClick={() => setShowPast(true)}><span>Earlier today · {pastSum}</span><span className="text-clay">Show <Icon name="chevR" className="inline h-3.5 w-3.5" /></span></button>}
          {calm && showPast && <button type="button" className="fd-fold" style={{ gridColumn: '1 / -1' }} onClick={() => setShowPast(false)}><span>Earlier today · {pastSum}</span><span className="text-clay">Hide</span></button>}
          {rows.map((r, i) => folded.has(r) ? null : compact(i, r) ? [
            <span key={`t${r.start}`} className="fd-ht">{hourLabel(r.start, r.end)}</span>,
            <button key={`c${r.start}`} type="button" className="fd-later" style={{ gridColumn: `2 / span ${cols.length}` }} title="Open this hour" onClick={() => setOpened(new Set(opened).add(r.start))}>{lineOf(r)}</button>,
          ] : [
            <span key={`t${r.start}`} className={`fd-ht ${i === nowRow ? 'now' : ''} ${!week && gone(day, r.end) ? 'past' : ''}`}>{hourLabel(r.start, r.end)}{i === nowRow && <small>now</small>}{showFree && onBook && kindF !== 'proc' && !gone(day, r.end) && freeAt(r) > 0 && <em className="fd-htfree">{freeAt(r)} free</em>}</span>,
            ...cols.map((c) => {
              const { wsAt, chips } = cell(c, r); const nowC = i === nowRow && c.day === today ? 'now' : ''; const key = c.key + r.start;
              const names = chips.length > 0 && <div className="fd-hchips">{chips.map((p) => <Chip key={p.id} {...p} />)}</div>;
              if (c.room) return <div key={key} className={`fd-hc ${nowC}`}>{!chips.length && <span className="fd-hcap">Free</span>}{names}</div>;
              if (!wsAt.length) return <div key={key} className={`fd-hc ${chips.length ? '' : 'off'} ${nowC}`}>{names || (c.ws.length ? '' : 'Not in')}</div>;
              const past = gone(c.day, r.end); const one = wsAt.length === 1 ? wsAt[0] : null; // "+ Book" and drop need one doctor's hour
              const shut = wsAt.every((w) => w.effectiveCapacity === 0 && w.reductions?.length);
              const canDrop = !!onBook && !!one && !past && !shut;
              // the doctor's own procedure in this hour sits in the grid like any booking
              const red = shut ? wsAt[0].reductions[0] : null;
              // the doctor's procedure hour: the sitting booked in it, with its patient and its own status (done, didn't come …); only a bare block when no sitting is found
              const sit = red?.kind === 'procedure' ? (days!.find((D: any) => D.day === c.day)?.procedures ?? []).find((p: any) => p.practitionerId === wsAt[0].practitionerId && inRow(p, r)) : null;
              const block: ChipP | null = red?.kind !== 'procedure' || kindF === 'consult' || (sit && chips.some((x) => x.id === sit.id)) ? null
                : sit ? sitChip(sit, c, r) : { id: `proc${key}`, k: 'booked', proc: true, name: red.note ?? 'Procedure', tag: '', who: docNameOf(wsAt[0].practitionerId), onClick: () => nav(`/worklist?day=${c.day}`) };
              const all: ChipP[] = block && keyOk(block) ? [block, ...chips] : chips;
              const free = showFree && kindF !== 'proc' && !shut && !past && one && onBook ? Math.max(0, one.free) : 0;
              return (
                <div key={key} className={`fd-hc ${nowC} ${one && over === one.id ? 'drop' : ''} ${past && !all.length ? 'off' : ''}`}
                  onDragOver={canDrop ? (e) => { if (e.dataTransfer.types.includes('application/x-appt')) { e.preventDefault(); setOver(one!.id); } } : undefined}
                  onDragLeave={() => setOver(null)} onDrop={canDrop ? (e) => drop(e, one) : undefined}>
                  {red && red.kind !== 'procedure' && <span className="fd-hcap">{red.note ?? 'Closed'}</span>}
                  {all.length + free > 0 && <div className="fd-hchips">
                    {all.map((p) => <Chip key={p.id} {...p} />)}
                    {Array.from({ length: free }, (_, j) => <button key={j} type="button" className="fd-pc fd-free" aria-label={`Book ${hourLabel(r.start, r.end)}`} onClick={() => onBook!({ ...one, day: c.day })}><span aria-hidden>+</span><span className="fd-bk">Book</span></button>)}
                  </div>}
                </div>);
            }),
          ])}
        </div>
      </div>
    </>);
}

function Chip({ k, next = false, tok, name, tag, who, warn = false, sel = false, onClick, drag, proc = false, sub, info, at }: ChipP) {
  return <button type="button" className={`fd-pc fd-k-${k} ${next ? 'fd-k-next' : ''} ${proc ? 'proc' : ''} ${sel ? 'sel' : ''}`} style={at ? { gridColumn: '1 / -1', marginLeft: `${at[0] * 100}%`, width: `${at[1] * 100}%` } : undefined} title={[name, sub, info, next ? 'Next' : LABEL[k], who, drag && 'drag to move'].filter(Boolean).join(' · ')} aria-pressed={sel} onClick={onClick} draggable={!!drag} onDragStart={drag}>
    {tok && <span className="tk">{tok}</span>}{proc && <Icon name="syringe" className="fd-proc-ic h-3.5 w-3.5 shrink-0" />}<span className="truncate">{name}{sub && <span className="fd-sub"> · {sub}</span>}</span>{warn && <span className="warn" aria-label="Pending">!</span>}{tag && <span className="tg">{cap(tag)}</span>}</button>;
}
