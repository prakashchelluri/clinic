import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useOutletContext } from 'react-router';
import { get, qc, today } from './api';
import { can } from './App';
import { Drawer, Empty, Icon, PageSearchBox, Skeleton, fmtDate, fmtTime, money, usePageSearch } from './ui';
import { FlagChips } from './flags';
import { ScheduleModal } from './pages/Worklist';
import { CourseDialog } from './courses';

/** A failed request is not an empty day: say so, with Retry. */
export const LoadError = ({ onRetry }: { onRetry: () => void }) => (
  <div className="card flex flex-wrap items-center gap-3 text-sm" role="alert"><span className="text-rose font-medium">Couldn't load. Check the internet connection.</span><button className="btn btn-sm ml-auto" onClick={onRetry}>Retry</button></div>
);
/** Clash kinds from the server, in plain words. */
const CLASH: Record<string, string> = { room: 'Room in use', doctor: 'Doctor busy', room_blocked: 'Room closed', break: 'Doctor on break', leave: 'Doctor on leave', other: 'Doctor not available' };
export const clashLabel = (k: string) => CLASH[k] ?? k;

type Stage = 'behind' | 'due' | 'booked' | 'advised' | 'finished';
const FILTERS: [Stage | 'all', string][] = [['all', 'All'], ['behind', 'Behind'], ['due', 'Due, not booked'], ['booked', 'Booked'], ['advised', 'Not started'], ['finished', 'Finished']];
const ORDER: Stage[] = ['behind', 'due', 'booked', 'advised', 'finished'];
const day = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const daysLate = (d: string) => Math.round((Date.parse(today()) - Date.parse(d)) / 864e5);
const refresh = () => ['procedure-plans', 'worklist', 'psessions', 'courses'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));

/** Where the course stands, in two lines: what, then why. */
function standing(p: any): { t: string; sub: string; tone: string } {
  const n = p.next?.sittingNo ?? p.doneSittings + 1;
  if (p.stage === 'finished') return { t: p.finishedOn ? `Finished ${fmtDate(p.finishedOn)}` : 'Finished', sub: `all ${p.sittings} sessions done`, tone: 'text-muted' };
  if (p.stage === 'booked') return { t: `${day(p.next.day)}, ${fmtTime(p.next.startTime)}`, sub: `session ${n} · ${p.next.approval !== 'approved' ? 'with the doctor to approve' : p.next.confirmed ? 'patient confirmed' : 'approved, to call'}`, tone: 'text-sage' };
  if (p.stage === 'advised') {
    const q = p.quote; const cold = q?.state === 'expired';
    return { t: cold ? 'Went quiet' : 'Not started', sub: `advised ${fmtDate(p.advisedOn.slice(0, 10))}${q ? ` · quote ${cold ? 'expired' : 'valid to'} ${fmtDate(q.validUntil)}` : ' · no quote yet'}`, tone: cold ? 'text-rose' : 'text-amber' };
  }
  if (p.stage === 'behind') return p.missed ? { t: `Missed ${day(p.missed.day)}`, sub: `session ${p.missed.sittingNo ?? n} · not rebooked`, tone: 'text-rose' } : { t: `${daysLate(p.dueOn)} days late`, sub: `was due ${fmtDate(p.dueOn)} · not booked`, tone: 'text-rose' };
  return { t: p.dueOn ? `Due ${day(p.dueOn)}` : 'Not booked', sub: `session ${n} · not booked yet`, tone: 'text-amber' };
}
/** The money on one line: balance first, or Paid, or the list price before anything is paid. Null when the user cannot see fees. */
function moneyLine(p: any): [string, string] | null {
  if (p.listPaise == null) return null;
  if (p.totalPaise == null) { const k = p.package ? 'Package price' : p.amountPaise ? 'Custom price' : 'Standard price'; return p.stage === 'advised' ? [money(p.listPaise), k] : [money(p.listPaise), k + ', paid per session']; }
  return p.stillToPayPaise ? [`${money(p.stillToPayPaise)} balance`, `${money(p.paidPaise ?? 0)} of ${money(p.totalPaise)} paid`] : ['Paid', `${money(p.totalPaise)} package`];
}
const Dots = ({ p }: { p: any }) => (
  <span className="inline-flex flex-wrap items-center gap-1" aria-label={`${p.doneSittings} of ${p.sittings} done`}>
    {Array.from({ length: p.sittings }, (_, i) => <i key={i} className={`inline-block h-2.5 w-2.5 rounded-full ${i < p.doneSittings ? 'bg-sage' : i === p.doneSittings && p.next ? 'ring-2 ring-inset ring-sage' : 'ring-[1.5px] ring-inset ring-line'}`} />)}
  </span>
);
const SIT: Record<string, [string, string]> = { done: ['Done', 'bg-sage text-white'], confirmed: ['Booked', 'ring-2 ring-inset ring-sage text-sage'], in_progress: ['In the room', 'ring-2 ring-inset ring-sage text-sage'], missed: ['No show', 'ring-2 ring-inset ring-rose text-rose'], planned: ['Not booked', 'ring-[1.5px] ring-inset ring-line text-muted'], cancelled: ['Not booked', 'ring-[1.5px] ring-inset ring-line text-muted'], postponed: ['Postponed', 'ring-[1.5px] ring-inset ring-line text-muted'] };

/** Every procedure course in one list: filter by where it stands, a row opens the course on the right. */
export function CourseList() {
  const nav = useNavigate(); const { perms } = useOutletContext<any>();
  const [f, setF] = useState<Stage | 'all'>('all'); const [sel, setSel] = useState<string | null>(null);
  const [act, setAct] = useState<'schedule' | 'course' | null>(null);
  const [q] = usePageSearch('Find a course: patient or procedure');
  const r = useQuery({ queryKey: ['procedure-plans'], queryFn: () => get('/procedure-plans'), refetchInterval: 30000 });
  if (r.isError && !r.data) return <LoadError onRetry={() => r.refetch()} />;
  if (!r.data) return <Skeleton rows={6} />;
  const all: any[] = [...r.data.plans].sort((a, b) => ORDER.indexOf(a.stage) - ORDER.indexOf(b.stage) || String(a.next?.day ?? a.dueOn ?? '').localeCompare(String(b.next?.day ?? b.dueOn ?? '')));
  const needle = q.trim().toLowerCase();
  const found = needle ? all.filter((p) => `${p.patient.fullName} ${p.patient.phone ?? ''} ${p.procedure}`.toLowerCase().includes(needle)) : all;
  const rows = found.filter((p) => f === 'all' || p.stage === f);
  const showMoney = all.some((p) => p.listPaise != null);
  const d = all.find((p) => p.id === sel);
  if (!all.length) return <div className="card"><Empty icon="check" title="No procedure courses yet" hint="They appear here when the doctor advises a procedure." /></div>;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Show courses">
        <PageSearchBox placeholder="Find a course: patient or procedure" className="order-last ml-auto !h-9 w-full sm:w-[300px]" />
        {FILTERS.map(([k, t]) => { const n = k === 'all' ? found.length : found.filter((p) => p.stage === k).length;
          return <button key={k} className={`toggle-opt ${f === k ? 'on' : ''}`} aria-pressed={f === k} onClick={() => { setF(k); setSel(null); }}>{t} <b className="ml-1">{n}</b></button>; })}
      </div>
      <div className="card !p-0 overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="bg-surface-2 text-left text-[11px] font-bold uppercase tracking-wider text-muted"><th className="px-4 py-2.5">Patient</th><th className="px-4">Procedure</th><th className="px-4">Progress</th><th className="px-4">Next session</th>{showMoney && <th className="px-4">Money</th>}<th className="px-4">Doctor</th></tr></thead>
          <tbody>
            {rows.map((p) => { const s = standing(p); const m = moneyLine(p);
              return (
                <tr key={p.id} className={`cursor-pointer border-t border-line/60 hover:bg-surface-2 ${sel === p.id ? '!bg-sage-soft' : ''}`} onClick={() => setSel(p.id)}>
                  <td className="px-4 py-3"><button className="text-left font-bold" onClick={(e) => { e.stopPropagation(); setSel(p.id); }}>{p.patient.fullName}</button> <FlagChips flags={p.patient.flags} /><div className="text-xs text-muted">{p.patient.phone ?? p.patient.patientNo}</div></td>
                  <td className="px-4">{p.procedure}<div className="text-xs text-muted">{p.gapDays ? `every ${p.gapDays} days` : `${p.sittings} sessions`}</div></td>
                  <td className="px-4"><Dots p={p} /><div className="text-xs text-muted">{p.doneSittings} of {p.sittings} done</div></td>
                  <td className="px-4"><b className={s.tone}>{s.t}</b><div className="text-xs text-muted">{s.sub}</div></td>
                  {showMoney && <td className="px-4">{m?.[0]}<div className="text-xs text-muted">{m?.[1]}</div></td>}
                  <td className="px-4">{p.doctor ?? '—'}</td>
                </tr>); })}
            {!rows.length && <tr><td colSpan={6} className="px-4 py-10 text-center text-sm text-muted">No courses here{needle ? ` for “${q.trim()}”` : ''}.</td></tr>}
          </tbody>
        </table>
      </div>
      {d && !act && <CourseSide p={d} canBook={can(perms, 'worklist.write')} onClose={() => setSel(null)} onSchedule={() => setAct('schedule')} onCourse={() => setAct('course')} onRecord={() => nav(`/patients/${d.patient.id}`)} />}
      {d && act === 'schedule' && <ScheduleModal rec={{ id: d.id, procedureId: d.procedureId, sittings: d.sittings, dueOn: d.dueOn, patient: d.patient }} sitting={d.next ?? undefined} onClose={() => { setAct(null); refresh(); }} />}
      {d && act === 'course' && <CourseDialog rec={{ id: d.id, procedureId: d.procedureId, procedure: d.procedure, sittings: d.sittings, amountPaise: d.amountPaise, package: d.package, patient: d.patient }} patientId={d.patient.id} patientName={d.patient.fullName} onClose={() => { setAct(null); refresh(); }} />}
    </div>
  );
}

/** One course on the right: where it stands, each sitting, the money, and the one or two things to do next. */
function CourseSide({ p, canBook, onClose, onSchedule, onCourse, onRecord }: { p: any; canBook: boolean; onClose: () => void; onSchedule: () => void; onCourse: () => void; onRecord: () => void }) {
  const s = standing(p); const open = p.stage !== 'finished';
  return (
    <Drawer title={p.patient.fullName} subtitle={`${p.procedure} · ${p.sittings} sessions${p.gapDays ? `, every ${p.gapDays} days` : ''}${p.doctor ? ` · ${p.doctor}` : ''}`} width="max-w-md" onClose={onClose}>
    <div className="flex flex-1 flex-col gap-4">
      <div className="rounded-xl bg-surface-2 px-4 py-3"><b className={s.tone}>{s.t}</b><div className="text-xs text-muted">{s.sub}</div></div>
      <div>
        <b className="text-sm">Sessions</b>
        {p.ledger.map((l: any) => { const [label, cls] = SIT[l.state] ?? [l.state, '']; const isNext = p.next && l.n === (p.next.sittingNo ?? p.doneSittings + 1) && l.state !== 'done';
          const what = isNext ? `Booked ${day(p.next.day)}, ${fmtTime(p.next.startTime)}` : l.day && l.state !== 'planned' && l.state !== 'cancelled' ? `${label} ${fmtDate(l.day)}` : l.n === p.doneSittings + 1 && open && p.stage !== 'advised' ? 'Due, not booked' : 'Not booked';
          return <div key={l.n} className="grid grid-cols-[26px_minmax(0,1fr)_auto] items-center gap-2.5 border-t border-line/60 py-2 text-sm">
            <span className={`grid h-[22px] w-[22px] place-items-center rounded-full text-[11px] font-bold ${isNext ? SIT.confirmed[1] : cls}`}>{l.n}</span>
            <span>{what}{l.did ? <span className="block text-xs text-muted">{l.did}</span> : null}</span>
            <span className="text-xs text-muted">{l.paid ? (l.prepaid ? 'prepaid' : 'paid') : l.state === 'done' && l.amountPaise ? `${money(l.amountPaise)} due` : ''}</span>
          </div>; })}
      </div>
      {p.totalPaise != null && <div className="grid grid-cols-3 gap-2 text-xs text-muted">
        {[['Package', p.totalPaise], ['Paid', p.paidPaise ?? 0], ['Balance', p.stillToPayPaise ?? 0]].map(([k, v]) => <div key={k} className="rounded-xl bg-surface-2 px-3 py-2.5">{k}<b className="block text-base text-ink">{money(v)}</b></div>)}
      </div>}
      {p.stage === 'advised' && p.quote && <div className="text-xs text-muted">Quote {p.quote.number}, {p.quote.state === 'expired' ? 'expired' : 'valid to'} {fmtDate(p.quote.validUntil)}</div>}
      <div className="flex flex-wrap gap-2 border-t border-line/60 pt-4">
        {p.stage === 'advised' ? <button className="btn btn-sm btn-primary" onClick={onCourse}>Quote and payment</button>
          : open && canBook ? <button className="btn btn-sm btn-primary" onClick={onSchedule}>{p.next ? 'Move session' : `Schedule session ${p.doneSittings + 1}`}</button> : null}
        {p.stage !== 'advised' && (p.totalPaise == null ? open && p.listPaise != null : p.stillToPayPaise > 0) && <button className="btn btn-sm" onClick={onCourse}>{p.totalPaise == null ? 'Pay for sessions' : 'Take payment'}</button>}
        <button className="btn btn-sm" onClick={onRecord}><Icon name="eye" />View profile</button>
      </div>
    </div>
    </Drawer>
  );
}
