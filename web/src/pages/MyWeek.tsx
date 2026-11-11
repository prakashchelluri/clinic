import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { Link, useOutletContext } from 'react-router';
import { get, today } from '../api';
import { Empty, Icon, Skeleton } from '../ui';
import { hourLabel, hoursOf } from './Today';
import '../frontdesk.css';

const addDay = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const dayName = (d: string, i: number) => i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday: 'long', timeZone: 'UTC' });
const dateOf = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const sum = (ws: any[], k: string) => ws.reduce((n, w) => n + Math.max(0, w[k] ?? 0), 0);

/** The doctor's coming seven days, read-only: one row per day with the hours, OP patients booked of the places, and procedures.
 *  A day opens the side drawer with that day hour by hour. Not a grid with dots: the doctor reads it top to bottom. */
export function MyWeek() {
  const { me } = useOutletContext<any>();
  const doc: string | null = me.practitionerId ?? null;
  const from = today();
  const q = useQuery({ queryKey: ['calendar', 'range', from, 'mine', doc], queryFn: () => get(`/calendar/range?from=${from}&days=7&practitionerId=${doc}`), enabled: !!doc, refetchInterval: 60000 });
  const [open, setOpen] = useState<{ d: any; i: number } | null>(null);
  return (
    <div className="fd-doc space-y-4">
      <header className="flex items-center gap-2.5 anim-fade-up">
        <Link to="/today" className="btn btn-ghost btn-sm"><Icon name="chevL" className="h-3.5 w-3.5" />Today</Link>
        <h1 className="text-[18px]">My week</h1>
        <span className="text-[13px] text-muted">{dateOf(from)} – {dateOf(addDay(from, 6))}</span>
      </header>
      {!doc ? <div className="card"><Empty icon="calendar" title="My week is for doctors" hint="Your account is not linked to a doctor." /></div>
        : !q.data ? <Skeleton rows={7} /> : (
          <section className="fd-sheet overflow-hidden anim-fade-up">
            {q.data.map((d: any, i: number) => {
              const ws: any[] = d.windows; const away = d.blocks.find((b: any) => b.kind === 'leave');
              const booked = sum(ws, 'allocated'); const cap = sum(ws, 'effectiveCapacity'); const procs = d.procedures.length;
              const off = !ws.length || (away && cap === 0);
              return (
                <button key={d.day} type="button" onClick={() => setOpen({ d, i })} className={`tap flex w-full flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-line px-4 py-3.5 text-left first:border-t-0 hover:bg-ink/[.035] sm:px-5 ${open?.d.day === d.day ? 'bg-clay-soft/40' : ''}`}>
                  <span className="w-36 shrink-0"><b className="text-[15px]">{dayName(d.day, i)}</b> <span className="text-[13px] text-muted">{dateOf(d.day)}</span></span>
                  {off ? <span className="text-[14px] text-muted">{away ? away.note ?? 'Away' : 'Not working'}{procs ? ` · ${procs} procedure${procs === 1 ? '' : 's'}` : ''}</span> : <>
                    <span className="min-w-[9rem] text-[14px] text-ink-2">{hoursOf(ws)}</span>
                    <span className="text-[14px]"><b>{booked}</b> <span className="text-muted">of {cap} booked</span></span>
                    <span className="text-[14px] text-muted">{procs ? `${procs} procedure${procs === 1 ? '' : 's'}` : 'No procedures'}</span>
                  </>}
                  <Icon name="chevR" className="ml-auto h-4 w-4 self-center text-muted" />
                </button>);
            })}
          </section>)}
      {open && <WeekDayDrawer d={open.d} title={`${dayName(open.d.day, open.i)} · ${dateOf(open.d.day)}`} onClose={() => setOpen(null)} />}
    </div>
  );
}

/** One day hour by hour: each booking hour with its count and names, procedures in the hour they start, with the room. */
function WeekDayDrawer({ d, title, onClose }: { d: any; title: string; onClose: () => void }) {
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  type Row = { start: string; end: string; w?: any; procs: any[] };
  const rows: Row[] = d.windows.map((w: any) => ({ start: w.startTime, end: w.endTime, w, procs: [] }));
  for (const p of d.procedures) { const r = rows.find((x) => x.start <= p.startTime && p.startTime < x.end); if (r) r.procs.push(p); else rows.push({ start: p.startTime, end: p.endTime, procs: [p] }); }
  rows.sort((a, b) => a.start.localeCompare(b.start));
  const away = d.blocks.find((b: any) => b.kind === 'leave');
  return createPortal(
    <aside aria-label={title} className="side-drawer">
      <div className="flex items-center gap-3">
        <b className="min-w-0 flex-1 truncate text-[18px]">{title}</b>
        <button className="btn btn-icon" aria-label="Close" onClick={onClose}><Icon name="x" className="h-4 w-4" /></button>
      </div>
      {away && <div className="rounded-[14px] bg-paper-2 px-3.5 py-3 text-[14px] font-semibold">{away.note ?? 'Away'}</div>}
      {rows.length === 0 ? <div className="text-[14px] text-muted">Not working.</div> : rows.map((r) => {
        const appts: any[] = r.w?.appointments ?? [];
        const shut = r.w && r.w.effectiveCapacity === 0 && (r.w.reductions ?? []).length > 0;
        return (
          <div key={r.start} className="border-t border-line pt-3 first:border-t-0">
            <div className="flex items-baseline gap-2"><b className="text-[15px]">{hourLabel(r.start, r.end)}</b>
              <span className="text-[13px] text-muted">{shut ? r.w.reductions[0].note ?? 'Closed' : r.w ? `${r.w.allocated} of ${r.w.effectiveCapacity} booked` : 'procedures'}</span></div>
            {(appts.length > 0 || r.procs.length > 0) && <div className="mt-2 flex flex-wrap gap-1.5">
              {appts.map((a) => <span key={a.id} className={`fd-pc ${a.status === 'no_show' ? 'fd-k-noshow' : a.status === 'arrived' ? 'fd-k-waiting' : 'fd-k-booked'}`}><span className="truncate">{a.name}</span>{a.status === 'no_show' ? <span className="tg">didn't come</span> : a.service && <span className="tg">{a.service}</span>}</span>)}
              {r.procs.map((p) => <span key={p.id} className={`fd-pc fd-sit ${p.state === 'completed' ? 'fd-k-done' : 'fd-k-proc'}`}><b>{p.patient}</b><span>{p.procedure ?? 'Procedure'} · {p.startTime}{p.room ? ` · ${p.room}` : ''}</span></span>)}
            </div>}
          </div>);
      })}
    </aside>, document.body);
}
