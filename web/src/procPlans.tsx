import { useState } from 'react';
import { useOutletContext } from 'react-router';
import { can } from './App';
import { Chip, Icon, fmtDate, money } from './ui';
import { ProcedureDrawer } from './procDrawer';

type Stage = 'ongoing' | 'completed' | 'expired' | 'cancelled';
const LIVE = (s: any) => !['cancelled', 'postponed'].includes(s.state);
const STATE: Record<string, [string, string]> = { completed: ['Completed', 'sage'], in_progress: ['In progress', 'sky'], confirmed: ['Booked', 'sky'], missed: ['Missed', 'rose'] };

/** The patient's procedures, as the clinic follows them: one card per procedure (or per package, its procedures together),
 *  every session listed 1…N with its date and state, and the next one to book. Filter chips split ongoing, completed, expired and cancelled. */
export function ProcedurePlans({ plans, sessions, courses, procName, onOpen }: { plans: any[]; sessions: any[]; courses: any[]; procName: (r: any) => string; onOpen: (r: any) => void }) {
  const { perms } = useOutletContext<any>();
  const [open, setOpen] = useState<string | null>(null); // a session's drawer
  const sitsOf = (r: any) => sessions.filter((x) => x.recommendationId === r.id && LIVE(x));
  const doneOf = (r: any) => sitsOf(r).filter((x) => x.state === 'completed').length;
  const courseOf = (r: any) => courses.find((c) => c.recommendationId === r.id);
  const stageOf = (r: any): Stage => {
    if (r.status === 'cancelled') return 'cancelled';
    if ((r.sittings && doneOf(r) >= r.sittings) || r.status === 'done') return 'completed';
    if (courseOf(r)?.expired) return 'expired';
    return 'ongoing';
  };
  // a package's procedures are one card; anything else is a card of its own
  const groups = [...new Map(plans.map((r) => [r.package?.group ?? r.id, plans.filter((x) => (x.package?.group ?? x.id) === (r.package?.group ?? r.id))])).values()];
  const stageOfGroup = (rs: any[]): Stage => { const st = rs.map(stageOf); return st.every((s) => s === 'cancelled') ? 'cancelled' : st.includes('expired') ? 'expired' : st.every((s) => s === 'completed' || s === 'cancelled') ? 'completed' : 'ongoing'; };
  const count = (s: Stage) => groups.filter((g) => stageOfGroup(g) === s).length;
  const [tab, setTab] = useState<Stage>(() => (['ongoing', 'completed', 'expired', 'cancelled'] as Stage[]).find((s) => count(s) > 0) ?? 'ongoing');
  const shown = groups.filter((g) => stageOfGroup(g) === tab);

  const timeline = (r: any) => {
    const live = sitsOf(r); const n = Math.max(r.sittings ?? 1, ...live.map((x) => x.sittingNo));
    // Book only when nothing is booked: the first session is booked by hand, each next one by the plan when the one before is done
    const pending = live.some((x) => ['confirmed', 'in_progress'].includes(x.state));
    const firstFree = pending ? undefined : Array.from({ length: n }, (_, i) => i + 1).find((k) => !live.some((x) => x.sittingNo === k));
    return (
      <ol className="relative ml-1 space-y-2 py-1">
        <span className="absolute bottom-6 left-[15px] top-6 w-px bg-line" aria-hidden />
        {Array.from({ length: n }, (_, i) => i + 1).map((k) => {
          const s = live.filter((x) => x.sittingNo === k).sort((a, b) => String(b.day).localeCompare(String(a.day)))[0];
          const done = s?.state === 'completed'; const [label, tone] = s ? STATE[s.state] ?? [s.state, ''] : ['', ''];
          return (
            <li key={k} className="relative flex items-center gap-3">
              <span className={`relative z-[1] grid h-8 w-8 shrink-0 place-items-center rounded-full text-[13px] font-semibold ${done ? 'bg-sage text-white' : 'border-2 border-sage/60 bg-surface text-sage'}`}>{k}</span>
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 rounded-[10px] border border-line bg-surface px-4 py-2.5">
                <div className="min-w-0 flex-1"><div className="text-[14px] font-medium">Session {k}</div>
                  <div className="text-xs text-muted">{s ? `${fmtDate(s.day)}${s.startTime ? `, ${s.startTime}` : ''}${s.doctor ? ` · ${s.doctor}` : ''}${s.autoBooked && s.state === 'confirmed' && !s.patientConfirmedAt ? ' · booked by the plan, not confirmed yet' : ''}` : r.status === 'cancelled' ? 'Not done' : 'Not booked yet'}</div></div>
                {s && <Chip tone={tone as any}>{label}</Chip>}
                {s ? <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOpen(s.id)}>Go to appointment</button>
                  : k === firstFree && stageOf(r) === 'ongoing' && can(perms, 'worklist.write') ? <button type="button" className="btn btn-sm" onClick={() => onOpen(r)}><Icon name="plus" className="h-3.5 w-3.5" />Book</button> : null}
              </div>
            </li>);
        })}
      </ol>);
  };
  const money1 = (r: any) => { const c = courseOf(r); return c ? `${c.unusedSittings > 0 ? `${c.unusedSittings} paid ahead · ` : ''}${c.stillToPayPaise > 0 ? `${money(c.stillToPayPaise)} still to pay` : 'Fully paid'}` : 'Price not agreed yet'; };
  const head = (r: any, sub?: boolean) => (
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 ${sub ? 'pt-2' : ''}`}>
      <span className={`h-2 w-2 rounded-full ${({ ongoing: 'bg-sage', completed: 'bg-sky', expired: 'bg-amber', cancelled: 'bg-rose' } as const)[stageOf(r)]}`} aria-hidden />
      <b className={sub ? 'text-[14px]' : 'text-[15px]'}>{procName(r)}</b>
      <span className="text-[13px] text-muted">{doneOf(r)}/{r.sittings ?? '?'} sessions completed · {money1(r)}{courseOf(r)?.validUntil ? ` · ${courseOf(r).expired ? 'expired' : 'valid till'} ${fmtDate(courseOf(r).validUntil)}` : ''}</span>
      <button type="button" className="btn btn-sm btn-ghost ml-auto" onClick={() => onOpen(r)}>Price & payments</button>
    </div>);

  return (
    <section className="card-flat overflow-hidden anim-fade-up">
      <div className="flex flex-wrap gap-1.5 border-b border-line/70 px-5 py-3" role="group" aria-label="Show">
        {([['ongoing', 'Ongoing'], ['completed', 'Completed'], ['expired', 'Expired'], ['cancelled', 'Cancelled']] as const).map(([k, l]) => <button key={k} type="button" aria-pressed={tab === k} className={`toggle-opt ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>{l} · {count(k)}</button>)}
      </div>
      {shown.length === 0 ? <div className="px-5 py-6 text-sm text-muted">{plans.length ? `Nothing ${tab}.` : 'No procedures prescribed.'}</div>
        : shown.map((g) => { const pk = g[0].package;
          if (!pk) return <div key={g[0].id} className="space-y-2 border-b border-line/70 px-5 py-4 last:border-b-0">{head(g[0])}{timeline(g[0])}</div>;
          const done = g.reduce((s, r) => s + doneOf(r), 0); const total = g.reduce((s, r) => s + (r.sittings ?? 0), 0);
          return (
            <div key={pk.group} className="space-y-2 border-b border-line/70 px-5 py-4 last:border-b-0">
              <div className="flex flex-wrap items-center gap-2"><Icon name="box" className="h-4 w-4 text-clay-ink" /><b className="text-[15px]">{pk.name}</b><span className="rounded bg-clay-soft px-1.5 text-[11px] font-semibold text-clay-ink">Package</span><span className="text-[13px] text-muted">{done}/{total} sessions completed{pk.pricePaise ? ` · ${money(pk.pricePaise)}` : ''}</span></div>
              {g.map((r) => <div key={r.id} className="ml-2 border-l-2 border-clay-line pl-4">{head(r, true)}{timeline(r)}</div>)}
            </div>);
        })}
      {open && <ProcedureDrawer key={open} id={open} canAct={can(perms, 'worklist.write')} onClose={() => setOpen(null)} />}
    </section>
  );
}
