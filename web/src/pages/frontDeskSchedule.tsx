import { useQuery } from '@tanstack/react-query';
import { get } from '../api';
import { Skeleton } from '../ui';

/** The front desk's day as a schedule: a column per doctor, a row per booking window, every patient a chip coloured by where they are.
 *  A chip opens what the table opens; a dashed "free" books that window. The windows come from the Calendar's own day. */
type Kind = 'booked' | 'late' | 'waiting' | 'intake' | 'doctor' | 'tests' | 'done' | 'noshow';
const LABEL: Record<Kind, string> = { booked: 'Booked, not here yet', late: 'Booked, late', waiting: 'Waiting', intake: 'Initial screening', doctor: 'With the doctor', tests: 'Pending tests & procedures', done: 'Done', noshow: 'No-show' };
// which chips each stage card keeps lit; the rest dim
const LIT: Record<string, Kind[] | null> = { now: null, all: null, waiting: ['waiting'], intake: ['intake'], doctor: ['doctor'], checkout: ['tests'], reports: ['tests'], completed: ['done', 'noshow'], scheduled: ['booked', 'late'] };
const PX = 124; // one hour: room for two rows of chips and the Book
const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const hhmm = (iso: string) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const minsSince = (iso: string) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));

export function DaySchedule({ day, isToday, visits, doctors, tab, selectedId, kindOf, onVisit, onCheckIn, onOpenAppt, onBook }: {
  day: string; isToday: boolean; visits: any[]; doctors: any[]; tab: string; selectedId: string | null;
  kindOf: (v: any) => Kind; onVisit: (id: string) => void; onCheckIn: (a: any) => void; onOpenAppt: (id: string) => void; onBook?: (w: any) => void;
}) {
  const cal = useQuery({ queryKey: ['calendar', day, 'all'], queryFn: () => get(`/calendar?day=${day}`), refetchInterval: 15000 });
  if (!cal.data) return <Skeleton rows={4} />;
  const now = new Date(); const nowM = now.getHours() * 60 + now.getMinutes();
  const windows: any[] = cal.data.windows ?? [];
  const lit = LIT[tab] ?? null;
  const cols = doctors.map((d) => ({ d, ws: windows.filter((w) => w.practitionerId === d.id) })).filter((c) => c.ws.length || visits.some((v) => v.practitionerId === c.d.id));
  const unpicked = visits.filter((v) => !v.practitionerId);
  if (!cols.length && !unpicked.length) return <div className="fd-sheet py-10 text-center text-muted">No doctor has hours today. Hours are set in Calendar.</div>;

  const all = cols.flatMap((c) => c.ws);
  const from = Math.floor(Math.min(...all.map((w) => toMin(w.startTime)), ...visits.map((v) => toMin(hhmm(v.arrivedAt))), isToday ? nowM : 24 * 60) / 60) * 60;
  const to = Math.ceil(Math.max(...all.map((w) => toMin(w.endTime)), from + 60) / 60) * 60;
  const y = (m: number) => ((m - from) / 60) * PX;
  const hours = Array.from({ length: (to - from) / 60 + 1 }, (_, i) => from + i * 60);

  // a checked-in patient sits in their booking's window, a walk-in in the window they arrived in (or the nearest one)
  const homeOf = (v: any, ws: any[]) => ws.find((w) => w.appointments?.some((a: any) => a.id === v.appointmentId))
    ?? ws.find((w) => { const t = toMin(hhmm(v.arrivedAt)); return t >= toMin(w.startTime) && t < toMin(w.endTime); })
    ?? [...ws].sort((a, b) => Math.abs(toMin(a.startTime) - toMin(hhmm(v.arrivedAt))) - Math.abs(toMin(b.startTime) - toMin(hhmm(v.arrivedAt))))[0];
  const visitChip = (v: any) => {
    const k = kindOf(v); const w = ['waiting', 'intake'].includes(k) ? minsSince(v.arrivedAt) : 0;
    const tag = v.details?.reportsEncounterId ? 'reports' : !v.appointmentId ? 'walk-in' : w >= 5 ? `${w}m` : '';
    return <Chip key={v.id} k={k} tok={v.opNumber} name={v.patient.fullName} tag={tag} dim={!!lit && !lit.includes(k)} sel={selectedId === v.id} onClick={() => onVisit(v.id)} />;
  };
  const apptChip = (a: any, w: any) => {
    const k: Kind = a.status === 'no_show' ? 'noshow' : isToday && toMin(w.endTime) < nowM ? 'late' : 'booked';
    return <Chip key={a.id} k={k} tok="·" name={a.name} tag={a.service ?? ''} dim={!!lit && !lit.includes(k)} sel={false}
      onClick={() => k === 'noshow' ? onOpenAppt(a.id) : onCheckIn({ id: a.id, patientId: a.patientId, patient: { fullName: a.name } })} />;
  };

  return (
    <div className={`fd-sheet fd-sch anim-fade-up overflow-hidden ${selectedId ? 'md:mr-[436px]' : ''}`}>
      <div className="fd-sch-legend" aria-label="Colours">
        {(['booked', 'late', 'waiting', 'intake', 'doctor', 'tests', 'done', 'noshow'] as Kind[]).map((k) => <span key={k}><i className={`fd-sw fd-k-${k}`} />{LABEL[k]}</span>)}
        {onBook && <span className="ml-auto"><i className="fd-sw fd-sw-free" />Free: click to book</span>}
      </div>
      <div className="overflow-x-auto">
        <div style={{ minWidth: 64 + (cols.length + (unpicked.length ? 1 : 0)) * 240 }}>
          <div className="fd-sch-heads">
            <div className="w-16 shrink-0" />
            {cols.map(({ d, ws }) => {
              const free = ws.filter((w) => !(isToday && toMin(w.endTime) <= nowM)).reduce((n, w) => n + Math.max(0, w.free), 0);
              const toSee = visits.filter((v) => v.practitionerId === d.id && ['waiting', 'intake', 'doctor'].includes(kindOf(v))).length + ws.reduce((n, w) => n + (w.appointments ?? []).filter((a: any) => ['booked', 'confirmed'].includes(a.status)).length, 0);
              return <div key={d.id} className="fd-sch-dh"><b>{d.name}</b><span>{ws.length ? `${ws[0].startTime}–${ws[ws.length - 1].endTime}` : 'no hours today'} · {toSee} to see · {free} free</span></div>;
            })}
            {unpicked.length > 0 && <div className="fd-sch-dh"><b className="text-rose">No doctor picked</b><span>{unpicked.length} checked in</span></div>}
          </div>
          <div className="relative flex" style={{ height: y(to) + 8 }}>
            <div className="relative w-16 shrink-0">{hours.map((m) => <span key={m} className="fd-sch-hr" style={{ top: y(m) }}>{String(m / 60).padStart(2, '0')}:00</span>)}</div>
            {cols.map(({ d, ws }) => {
              const mine = visits.filter((v) => v.practitionerId === d.id);
              const placed = new Map<string, any[]>(); const loose: any[] = [];
              for (const v of mine) { const w = homeOf(v, ws); if (w) placed.set(w.id, [...(placed.get(w.id) ?? []), v]); else loose.push(v); }
              // the gaps between windows are hours the doctor is not in
              const gaps: [number, number][] = []; let cur = from;
              for (const w of ws) { if (toMin(w.startTime) > cur) gaps.push([cur, toMin(w.startTime)]); cur = Math.max(cur, toMin(w.endTime)); }
              if (cur < to) gaps.push([cur, to]);
              return (
                <div key={d.id} className="fd-sch-col">
                  {hours.map((m) => <i key={m} className="fd-sch-line" style={{ top: y(m) }} />)}
                  {gaps.map(([a, b]) => <div key={a} className="fd-sch-off" style={{ top: y(a), height: y(b) - y(a) }}>{!ws.length ? 'Not in today' : a === from ? '' : b === to ? `Off after ${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}` : 'Not in'}</div>)}
                  {ws.map((w) => {
                    const here = placed.get(w.id) ?? [];
                    const waiting = (w.appointments ?? []).filter((a: any) => a.status !== 'arrived' && !visits.some((v) => v.appointmentId === a.id));
                    const past = isToday && toMin(w.endTime) <= nowM;
                    const shut = w.effectiveCapacity === 0 && w.reductions?.length;
                    return (
                      <div key={w.id} className={`fd-sch-cell ${shut ? 'shut' : ''}`} style={{ top: y(toMin(w.startTime)) + 3, height: y(toMin(w.endTime)) - y(toMin(w.startTime)) - 6 }}>
                        {here.map(visitChip)}
                        {waiting.map((a: any) => apptChip(a, w))}
                        {shut ? <span className="fd-sch-full">{w.reductions[0].note ?? 'Blocked'}</span>
                          : !past && (w.free > 0 ? (onBook ? <button type="button" className="fd-sch-free" onClick={() => onBook({ ...w, day })}>+ Book · {w.free} free</button> : <span className="fd-sch-full">{w.free} free</span>)
                            : <span className="fd-sch-full">Full</span>)}
                        <span className="fd-sch-cap">{w.allocated} of {w.effectiveCapacity}</span>
                      </div>);
                  })}
                  {loose.length > 0 && <div className="fd-sch-cell" style={{ top: 3, height: PX - 6 }}>{loose.map(visitChip)}</div>}
                </div>);
            })}
            {unpicked.length > 0 && <div className="fd-sch-col"><div className="fd-sch-cell" style={{ top: 3, bottom: 3 }}>{unpicked.map(visitChip)}</div></div>}
            {isToday && nowM >= from && nowM <= to && <div className="fd-sch-now" style={{ top: y(nowM) }}><span>{hhmm(now.toISOString())}</span><i /></div>}
          </div>
        </div>
      </div>
    </div>);
}

function Chip({ k, tok, name, tag, dim, sel, onClick }: { k: Kind; tok: string; name: string; tag: string; dim: boolean; sel: boolean; onClick: () => void }) {
  return <button type="button" className={`fd-pc fd-k-${k} ${dim ? 'dim' : ''} ${sel ? 'sel' : ''}`} title={`${name} · ${LABEL[k]}`} aria-pressed={sel} onClick={onClick}>
    <span className="tk">{tok}</span><span className="truncate">{name}</span>{tag && <span className="tg">{tag}</span>}</button>;
}
