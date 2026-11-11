import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { get } from '../api';
import { Filter, Icon, Skeleton } from '../ui';

/** The front desk's day as a schedule: a column per doctor (booking windows) and per room (procedure sittings), every patient a chip
 *  coloured by where they are. Any day can be looked at; a chip opens what the table opens, a dashed "free" books that window. */
export type Kind = 'booked' | 'late' | 'waiting' | 'intake' | 'doctor' | 'tests' | 'done' | 'noshow';
const LABEL: Record<Kind, string> = { booked: 'Booked, not here yet', late: 'Booked, did not come', waiting: 'Waiting', intake: 'Initial screening', doctor: 'With the doctor', tests: 'Pending tests & procedures', done: 'Done', noshow: 'No-show' };
// which chips each stage card keeps lit (today only); the rest dim
const LIT: Record<string, Kind[] | null> = { now: null, all: null, waiting: ['waiting'], intake: ['intake'], doctor: ['doctor'], checkout: ['tests'], reports: ['tests'], completed: ['done', 'noshow'], scheduled: ['booked', 'late'] };
const SITTING: Record<string, Kind> = { confirmed: 'booked', in_progress: 'doctor', completed: 'done', missed: 'noshow' };
const PX = 124; // one hour: room for two rows of chips and the Book
const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const hhmm = (iso: string) => { const d = new Date(iso); return hm(d.getHours() * 60 + d.getMinutes()); };
const minsSince = (iso: string) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
const shift = (day: string, n: number) => { const d = new Date(day + 'T00:00:00'); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const dayName = (day: string) => new Date(day + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });

export function DaySchedule({ today, visitsToday, doctors, rooms, docFilter, setDocFilter, tab, selectedId, kindOf, onVisit, onCheckIn, onOpenAppt, onBook }: {
  today: string; visitsToday: any[]; doctors: any[]; rooms: any[]; docFilter: string | null; setDocFilter: (v: string | null) => void;
  tab: string; selectedId: string | null; kindOf: (v: any) => Kind; onVisit: (id: string) => void; onCheckIn: (a: any) => void; onOpenAppt: (id: string) => void; onBook?: (w: any) => void;
}) {
  const nav = useNavigate();
  const [day, setDay] = useState(today);
  const [docsOff, setDocsOff] = useState(false); // rooms only
  const [roomPick, setRoomPick] = useState('used'); // used = rooms with sittings that day; all; none; or one room's id
  const isToday = day === today; const isPast = day < today;
  const cal = useQuery({ queryKey: ['calendar', day, 'all'], queryFn: () => get(`/calendar?day=${day}`), refetchInterval: isToday ? 15000 : false });
  const other = useQuery({ queryKey: ['frontdesk', day], queryFn: () => get(`/frontdesk?day=${day}`), enabled: !isToday }); // another day's checked-in patients
  const visitsAll: any[] = isToday ? visitsToday : other.data?.visits ?? [];
  const visits = visitsAll.filter((v) => !docFilter || (docFilter === '__none' ? !v.practitionerId : v.practitionerId === docFilter));

  const bar = (
    <div className="fd-sch-bar">
      <div className="flex items-center gap-1">
        <button type="button" className="btn btn-icon !h-9 !w-9" aria-label="Previous day" onClick={() => setDay(shift(day, -1))}><Icon name="chevL" className="h-4 w-4" /></button>
        <label className="fd-sch-date"><span>{dayName(day)}</span><input type="date" aria-label="Pick a day" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} /></label>
        <button type="button" className="btn btn-icon !h-9 !w-9" aria-label="Next day" onClick={() => setDay(shift(day, 1))}><Icon name="chevR" className="h-4 w-4" /></button>
        {!isToday && <button type="button" className="btn btn-sm ml-1" onClick={() => setDay(today)}>Today</button>}
      </div>
      <span className="ml-auto" />
      {doctors.length > 0 && <Filter icon="stetho" value={docsOff ? '__off' : docFilter ?? 'all'} onChange={(v) => { setDocsOff(v === '__off'); setDocFilter(v === 'all' || v === '__off' ? null : v); }}
        options={[{ value: 'all', label: 'All doctors' }, ...doctors.map((d: any) => ({ value: d.id as string, label: d.name as string })), { value: '__off', label: 'No doctors' }]} />}
      {rooms.length > 0 && <Filter icon="door" value={roomPick} onChange={setRoomPick}
        options={[{ value: 'used', label: 'Rooms in use' }, { value: 'all', label: 'All rooms' }, ...rooms.map((r: any) => ({ value: r.id as string, label: r.name as string })), { value: 'none', label: 'No rooms' }]} />}
    </div>);
  if (!cal.data || (!isToday && other.isLoading)) return <div className="fd-sheet fd-sch overflow-hidden">{bar}<div className="p-4"><Skeleton rows={4} /></div></div>;

  const now = new Date(); const nowM = now.getHours() * 60 + now.getMinutes();
  const windows: any[] = cal.data.windows ?? []; const procs: any[] = cal.data.procedures ?? [];
  const lit = isToday ? LIT[tab] ?? null : null;
  const gone = (end: string) => isPast || (isToday && toMin(end) <= nowM);
  const docCols = docsOff ? [] : doctors.filter((d) => !docFilter || d.id === docFilter)
    .map((d) => ({ d, ws: windows.filter((w) => w.practitionerId === d.id) })).filter((c) => c.ws.length || visits.some((v) => v.practitionerId === c.d.id) || docFilter === c.d.id);
  const roomCols = rooms.filter((r) => roomPick === 'all' || roomPick === r.id || (roomPick === 'used' && procs.some((p) => p.roomId === r.id)))
    .map((r) => ({ r, ps: procs.filter((p) => p.roomId === r.id) }));
  // a sitting booked without a room still shows, in a column of its own, unless rooms are hidden or one room is picked
  const roomless = procs.filter((p) => !p.roomId);
  if (roomless.length && (roomPick === 'used' || roomPick === 'all')) roomCols.push({ r: { id: '__none', name: 'No room' }, ps: roomless });
  const unpicked = docsOff || (docFilter && docFilter !== '__none') ? [] : visits.filter((v) => !v.practitionerId);
  const nCols = docCols.length + roomCols.length + (unpicked.length ? 1 : 0);
  if (!nCols) return <div className="fd-sheet fd-sch overflow-hidden">{bar}<div className="py-10 text-center text-muted">{windows.length || procs.length ? 'Nothing for these filters.' : `No doctor has hours on ${dayName(day)}. Hours are set in Calendar.`}</div></div>;

  const times = [...docCols.flatMap((c) => c.ws.flatMap((w) => [toMin(w.startTime), toMin(w.endTime)])), ...roomCols.flatMap((c) => c.ps.flatMap((p) => [toMin(p.startTime), toMin(p.endTime)])), ...visits.map((v) => toMin(hhmm(v.arrivedAt))), ...(isToday ? [nowM] : [])];
  const from = Math.floor(Math.min(...times, 9 * 60) / 60) * 60;
  const to = Math.ceil(Math.max(...times, from + 60) / 60) * 60;
  const y = (m: number) => ((m - from) / 60) * PX;
  const hours = Array.from({ length: (to - from) / 60 + 1 }, (_, i) => from + i * 60);
  const off = (wins: [number, number][]) => { const g: [number, number][] = []; let cur = from; for (const [a, b] of [...wins].sort((p, q) => p[0] - q[0])) { if (a > cur) g.push([cur, a]); cur = Math.max(cur, b); } if (cur < to) g.push([cur, to]); return g; };

  // a checked-in patient sits in their booking's window, a walk-in in the window they arrived in (or the nearest one)
  const homeOf = (v: any, ws: any[]) => ws.find((w) => w.appointments?.some((a: any) => a.id === v.appointmentId))
    ?? ws.find((w) => { const t = toMin(hhmm(v.arrivedAt)); return t >= toMin(w.startTime) && t < toMin(w.endTime); })
    ?? [...ws].sort((a, b) => Math.abs(toMin(a.startTime) - toMin(hhmm(v.arrivedAt))) - Math.abs(toMin(b.startTime) - toMin(hhmm(v.arrivedAt))))[0];
  const visitChip = (v: any) => {
    const k = kindOf(v); const w = isToday && ['waiting', 'intake'].includes(k) ? minsSince(v.arrivedAt) : 0;
    const tag = v.details?.reportsEncounterId ? 'reports' : !v.appointmentId ? 'walk-in' : w >= 5 ? `${w}m` : '';
    return <Chip key={v.id} k={k} tok={v.opNumber} name={v.patient.fullName} tag={tag} dim={!!lit && !lit.includes(k)} sel={selectedId === v.id}
      onClick={() => (isToday ? onVisit(v.id) : nav(`/patients/${v.patient.id}`))} />;
  };
  const apptChip = (a: any, w: any) => {
    const k: Kind = a.status === 'no_show' ? 'noshow' : gone(w.endTime) ? 'late' : 'booked';
    return <Chip key={a.id} k={k} tok="·" name={a.name} tag={a.service ?? ''} dim={!!lit && !lit.includes(k)} sel={false}
      onClick={() => (isToday && k !== 'noshow' ? onCheckIn({ id: a.id, patientId: a.patientId, patient: { fullName: a.name } }) : onOpenAppt(a.id))} />;
  };

  return (
    <div className={`fd-sheet fd-sch anim-fade-up overflow-hidden ${selectedId && isToday ? 'md:mr-[436px]' : ''}`}>
      {bar}
      <div className="overflow-x-auto">
        <div style={{ minWidth: 64 + nCols * 240 }}>
          <div className="fd-sch-heads">
            <div className="w-16 shrink-0" />
            {docCols.map(({ d, ws }) => {
              const free = ws.filter((w) => !gone(w.endTime)).reduce((n, w) => n + Math.max(0, w.free), 0);
              const toSee = visits.filter((v) => v.practitionerId === d.id && ['waiting', 'intake', 'doctor'].includes(kindOf(v))).length + (isPast ? 0 : ws.reduce((n, w) => n + (w.appointments ?? []).filter((a: any) => ['booked', 'confirmed'].includes(a.status)).length, 0));
              return <div key={d.id} className="fd-sch-dh"><b>{d.name}</b><span>{ws.length ? `${ws[0].startTime}–${ws[ws.length - 1].endTime}` : 'no hours'} · {toSee} to see · {free} free</span></div>;
            })}
            {roomCols.map(({ r, ps }) => <div key={r.id} className="fd-sch-dh fd-sch-room"><b>{r.name}</b><span>Procedures · {ps.length} sitting{ps.length === 1 ? '' : 's'}</span></div>)}
            {unpicked.length > 0 && <div className="fd-sch-dh"><b className="text-rose">No doctor picked</b><span>{unpicked.length} checked in</span></div>}
          </div>
          <div className="relative flex" style={{ height: y(to) + 8 }}>
            <div className="relative w-16 shrink-0">{hours.map((m) => <span key={m} className="fd-sch-hr" style={{ top: y(m) }}>{hm(m)}</span>)}</div>
            {docCols.map(({ d, ws }) => {
              const placed = new Map<string, any[]>(); const loose: any[] = [];
              for (const v of visits.filter((x) => x.practitionerId === d.id)) { const w = homeOf(v, ws); if (w) placed.set(w.id, [...(placed.get(w.id) ?? []), v]); else loose.push(v); }
              return (
                <div key={d.id} className="fd-sch-col">
                  {hours.map((m) => <i key={m} className="fd-sch-line" style={{ top: y(m) }} />)}
                  {off(ws.map((w) => [toMin(w.startTime), toMin(w.endTime)])).map(([a, b]) => <div key={a} className="fd-sch-off" style={{ top: y(a), height: y(b) - y(a) }}>{!ws.length ? 'Not in' : a === from ? '' : b === to ? `Off after ${hm(a)}` : 'Not in'}</div>)}
                  {ws.map((w) => {
                    const here = placed.get(w.id) ?? [];
                    const booked = (w.appointments ?? []).filter((a: any) => a.status !== 'arrived' && !visits.some((v) => v.appointmentId === a.id));
                    const shut = w.effectiveCapacity === 0 && w.reductions?.length;
                    return (
                      <div key={w.id} className={`fd-sch-cell ${shut ? 'shut' : ''}`} style={{ top: y(toMin(w.startTime)) + 3, height: y(toMin(w.endTime)) - y(toMin(w.startTime)) - 6 }}>
                        {here.map(visitChip)}
                        {booked.map((a: any) => apptChip(a, w))}
                        {shut ? <span className="fd-sch-full">{w.reductions[0].note ?? 'Blocked'}</span>
                          : !gone(w.endTime) && (w.free > 0 ? (onBook ? <button type="button" className="fd-sch-free" onClick={() => onBook({ ...w, day })}>+ Book · {w.free} free</button> : <span className="fd-sch-full">{w.free} free</span>)
                            : <span className="fd-sch-full">Full</span>)}
                        <span className="fd-sch-cap">{w.allocated} of {w.effectiveCapacity}</span>
                      </div>);
                  })}
                  {loose.length > 0 && <div className="fd-sch-cell" style={{ top: 3, height: PX - 6 }}>{loose.map(visitChip)}</div>}
                </div>);
            })}
            {roomCols.map(({ r, ps }) => (
              <div key={r.id} className="fd-sch-col">
                {hours.map((m) => <i key={m} className="fd-sch-line" style={{ top: y(m) }} />)}
                {ps.length === 0 && <div className="fd-sch-off" style={{ top: 0, height: y(to) }}>No sittings</div>}
                {ps.map((p) => { const k = SITTING[p.state] ?? 'booked'; return (
                  <button key={p.id} type="button" className={`fd-sch-sit fd-k-${k}`} style={{ top: y(toMin(p.startTime)) + 2, height: Math.max(30, y(toMin(p.endTime)) - y(toMin(p.startTime)) - 4) }}
                    title={`${p.patient} · ${p.procedure ?? 'Procedure'} · ${LABEL[k]}`} onClick={() => nav(`/worklist?day=${day}`)}>
                    <b className="truncate">{p.patient}</b><span className="truncate">{p.startTime}–{p.endTime} · {p.procedure ?? 'Procedure'}{p.doctor ? ` · ${p.doctor}` : ''}</span></button>); })}
              </div>))}
            {unpicked.length > 0 && <div className="fd-sch-col"><div className="fd-sch-cell" style={{ top: 3, bottom: 3 }}>{unpicked.map(visitChip)}</div></div>}
            {isToday && nowM >= from && nowM <= to && <div className="fd-sch-now" style={{ top: y(nowM) }}><span>{hm(nowM)}</span><i /></div>}
          </div>
        </div>
      </div>
    </div>);
}

function Chip({ k, tok, name, tag, dim, sel, onClick }: { k: Kind; tok: string; name: string; tag: string; dim: boolean; sel: boolean; onClick: () => void }) {
  return <button type="button" className={`fd-pc fd-k-${k} ${dim ? 'dim' : ''} ${sel ? 'sel' : ''}`} title={`${name} · ${LABEL[k]}`} aria-pressed={sel} onClick={onClick}>
    <span className="tk">{tok}</span><span className="truncate">{name}</span>{tag && <span className="tg">{tag}</span>}</button>;
}
