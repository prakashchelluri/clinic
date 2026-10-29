import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useOutletContext } from 'react-router';
import { get, post, qc, today, errText } from '../api';
import { can } from '../App';
import { Chip, Icon, Skeleton, toast, fmtDate } from '../ui';
import { openViewer } from '../viewer';
import { ChangeMyDay, type ChangeKind } from '../dayChange';
import { joinList } from '../encounterDetail';

const minsSince = (iso: string) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const nowHHMM = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
const addDay = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
/** "10:00–13:00, 16:00–20:00" from back-to-back windows. */
const hoursOf = (ws: any[]) => ws.reduce((out: [string, string][], w) => { const last = out[out.length - 1]; if (last && last[1] === w.startTime) last[1] = w.endTime; else out.push([w.startTime, w.endTime]); return out; }, []).map(([a, b]) => `${a}–${b}`).join(', ');

type Pill = { key: string; label: string; cls: string; sort: number; patientId?: string; title?: string };
const PILL: Record<string, string> = {
  done: 'bg-sage-soft text-sage border-transparent', with: 'bg-ink text-white border-transparent', wait: 'bg-amber-soft text-[#6E4D10] border-transparent',
  booked: 'bg-white border-line', req: 'bg-white border-dashed border-clay text-[#9A3412]', gone: 'border-dashed border-rose/50 text-rose line-through', proc: 'bg-sky-soft text-sky border-transparent',
};

/** The doctor's day: who is with me and who is next, the day as a calendar, what is left before I go, tomorrow in one line. No money. */
export function Today() {
  const { me, perms, cfg } = useOutletContext<any>();
  const nav = useNavigate();
  const doc: string | null = me.practitionerId ?? null;
  const docName = cfg?.practitioners?.find((p: any) => p.id === doc)?.name ?? me.name;
  const tmr = addDay(today(), 1);
  const fd = useQuery({ queryKey: ['frontdesk', 'today-doc'], queryFn: () => get('/frontdesk'), refetchInterval: 5000 });
  const cal = useQuery({ queryKey: ['calendar', today(), doc ?? 'all'], queryFn: () => get(`/calendar?day=${today()}${doc ? `&practitionerId=${doc}` : ''}`), refetchInterval: 30000 });
  const tom = useQuery({ queryKey: ['calendar', tmr, doc ?? 'all'], queryFn: () => get(`/calendar?day=${tmr}${doc ? `&practitionerId=${doc}` : ''}`) });
  const plans = useQuery({ queryKey: ['worklist', 'procedure'], queryFn: () => get('/worklist?kind=procedure'), enabled: can(perms, 'worklist.read') });
  const fus = useQuery({ queryKey: ['worklist', 'followup'], queryFn: () => get('/worklist?kind=followup'), enabled: can(perms, 'worklist.read') });
  const allProcs = useQuery({ queryKey: ['psessions', 'day', today()], queryFn: () => get(`/procedure-sessions?day=${today()}&active=1`), refetchInterval: 30000, enabled: can(perms, 'worklist.read') });
  const resq = useQuery({ queryKey: ['results'], queryFn: () => get('/results?days=7'), refetchInterval: 30000, enabled: !!doc && can(perms, 'document.read') });
  const secq = useQuery({ queryKey: ['security'], queryFn: () => get('/security'), enabled: (me.roles ?? []).includes('owner'), refetchInterval: 60000 });
  const open = useMutation({ mutationFn: (visitId: string) => post(`/visits/${visitId}/encounter`), onSuccess: (e: any) => nav(`/encounter/${e.id}`, { viewTransition: true }), onError: (e) => toast(errText(e), 'err') });
  const take = useMutation({ mutationFn: (id: string) => post(`/procedure-sessions/${id}/assign`, { practitionerId: doc }), onSuccess: () => { ['calendar', 'psessions'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); toast('The sitting is yours'); }, onError: (e) => toast(errText(e), 'err') });
  const [change, setChange] = useState<{ kind: ChangeKind; day?: string } | null>(null);

  const d = fd.data; const c = cal.data;
  const visits: any[] = (d?.visits ?? []).filter((v: any) => !doc || !v.practitionerId || v.practitionerId === doc);
  const withYou = visits.find((v) => v.status === 'in_consult');
  const waiting = visits.filter((v) => v.status === 'waiting' || v.status === 'intake');
  const next = waiting[0];
  const nextTl = useQuery({ queryKey: ['timeline', next?.patient?.id], queryFn: () => get(`/patients/${next.patient.id}/timeline`), enabled: !!next });
  if (!d || !c) return <div className="space-y-4"><Skeleton rows={2} /><Skeleton rows={8} /></div>;

  // --- the day as rows: one per booking window, gaps between windows shown as not working ---
  const now = nowHHMM();
  const byAppt = new Map(visits.filter((v) => v.appointmentId).map((v) => [v.appointmentId, v]));
  const visitPill = (v: any, key: string): Pill => {
    const st = v.status; const name = v.patient.fullName;
    if (st === 'in_consult') return { key, label: `${name} · with you`, cls: PILL.with, sort: 0, patientId: v.patient.id };
    if (st === 'waiting' || st === 'intake') return { key, label: `${name} · ${minsSince(v.arrivedAt)} min`, cls: PILL.wait, sort: 1, patientId: v.patient.id };
    if (st === 'left') return { key, label: `${name} · left`, cls: PILL.gone, sort: 4, patientId: v.patient.id };
    return { key, label: v.encounterStatus === 'draft' ? `${name} · note unfinished` : name, cls: PILL.done, sort: 3, patientId: v.patient.id };
  };
  const windows: any[] = c.windows;
  const rows: { time: string; end: string; pills: Pill[]; free: number; off?: string }[] = windows.map((w) => {
    const pills: Pill[] = (w.appointments ?? []).map((a: any) => {
      const v = byAppt.get(a.id);
      if (v) return visitPill(v, a.id);
      const notCome = w.endTime < now;
      return { key: a.id, label: a.status === 'no_show' ? `${a.name} · no-show` : notCome ? `${a.name} · not arrived` : a.status === 'requested' ? `${a.name} · online request` : a.name,
        cls: a.status === 'no_show' || notCome ? PILL.gone : a.status === 'requested' ? PILL.req : PILL.booked, sort: 2, patientId: a.patientId, title: [a.service, a.note].filter(Boolean).join(' · ') };
    });
    const blk = (w.reductions ?? []).find((r: any) => r.kind === 'leave' || r.kind === 'other' || r.kind === 'stop');
    return { time: w.startTime, end: w.endTime, pills, free: Math.max(0, w.free), off: blk && w.effectiveCapacity === 0 && !pills.length ? blk.note ?? 'Closed' : undefined };
  });
  // walk-ins go into the window they arrived in (or the nearest earlier one)
  for (const v of visits.filter((x) => !x.appointmentId)) {
    const at = hhmm(v.arrivedAt); let r = [...rows].reverse().find((x) => x.time <= at) ?? rows[0];
    if (!r) { r = { time: at, end: at, pills: [], free: 0 }; rows.push(r); }
    r.pills.push({ ...visitPill(v, v.id), label: `${visitPill(v, v.id).label}${v.category === 'NGT' ? ' · emergency' : ' · walk-in'}` });
  }
  for (const p of c.procedures ?? []) {
    let r = rows.find((x) => x.time <= p.startTime && p.startTime < x.end);
    if (!r) { r = { time: p.startTime, end: p.endTime, pills: [], free: 0 }; rows.push(r); }
    r.pills.push({ key: p.id, label: `${p.startTime} ${p.patient} · ${p.procedure ?? 'Procedure'} ${p.sittingNo}${p.of ? `/${p.of}` : ''}${p.room ? ` · ${p.room}` : ''}${p.state === 'completed' ? ' ✓' : ''}`, cls: PILL.proc, sort: 1.5, patientId: p.patientId });
  }
  rows.sort((a, b) => a.time.localeCompare(b.time));
  rows.forEach((r) => r.pills.sort((a, b) => a.sort - b.sort));
  const gaps: { at: string; label: string }[] = [];
  for (let i = 1; i < rows.length; i++) if (toMin(rows[i].time) - toMin(rows[i - 1].end) >= 30) gaps.push({ at: rows[i - 1].end, label: `${rows[i - 1].end}–${rows[i].time} · not working` });
  const blocks: any[] = c.blocks ?? [];
  const late = blocks.find((b) => b.kind === 'late');
  const breakNow = blocks.find((b) => b.kind === 'break' && b.startTime <= now && now < b.endTime);
  const away = blocks.find((b) => b.kind === 'leave');

  // --- counts for the header ---
  const allPills = rows.flatMap((r) => r.pills);
  const seen = visits.filter((v) => v.status === 'done').length;
  const toCome = windows.reduce((n, w) => n + (w.appointments ?? []).filter((a: any) => !byAppt.has(a.id) && ['booked', 'confirmed', 'requested'].includes(a.status) && w.endTime >= now).length, 0);
  const apptCount = windows.reduce((n, w) => n + (w.appointments ?? []).filter((a: any) => a.status !== 'no_show').length, 0) + visits.filter((v) => !v.appointmentId).length;
  const lastEnd = windows.length ? windows[windows.length - 1].endTime : null;

  // --- before you leave ---
  const drafts = visits.filter((v) => v.encounterStatus === 'draft' && v.status !== 'in_consult');
  const review = (plans.data ?? []).filter((r: any) => r.status === 'open' && cfg?.procedures.find((p: any) => p.id === r.procedureId)?.requiresReview);
  const overdue = (fus.data ?? []).filter((r: any) => r.dueOn && r.dueOn < today() && ['open', 'contacted'].includes(r.status));
  const noDoc = (allProcs.data ?? []).filter((p: any) => ['confirmed', 'in_progress'].includes(p.state) && !p.practitionerId);
  const resultGroups = (() => { const m = new Map<string, any>(); for (const r of (resq.data ?? []).filter((x: any) => x.documents.some((dd: any) => !dd.reviewedAt))) { const g = m.get(r.patient.id) ?? { patient: r.patient, tests: [] as string[], docs: new Map<string, any>() }; g.tests.push(r.test); for (const dd of r.documents) g.docs.set(dd.id, dd); m.set(r.patient.id, g); } return [...m.values()]; })();
  const openResults = (g: any) => { const docs = [...g.docs.values()]; openViewer({ docs, who: g.patient.fullName, canDelete: can(perms, 'document.write') }); post('/documents/review', { ids: docs.map((x: any) => x.id) }).then(() => qc.invalidateQueries({ queryKey: ['results'] }), () => {}); };
  const stopped: any[] = secq.data?.security?.ipLock?.enabled ? secq.data.stopped : [];
  const leaveCount = stopped.length + resultGroups.length + drafts.length + review.length + noDoc.length + (overdue.length ? 1 : 0);

  // --- next patient's story ---
  const lastEnc = (nextTl.data?.encounters ?? []).find((e: any) => e.status === 'completed');
  const tw: any[] = tom.data?.windows ?? [];
  const tBooked = tw.reduce((n, w) => n + (w.appointments ?? []).length, 0);
  const firstTomorrow = (() => { for (const w of tw) if (w.appointments?.length) return `${w.startTime} (${w.appointments[0].name})`; return tom.data?.procedures?.[0] ? `${tom.data.procedures[0].startTime} (${tom.data.procedures[0].patient})` : null; })();
  const dateLabel = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Kolkata' });
  const canChange = !!doc;
  const quick = (k: ChangeKind) => setChange({ kind: k });
  const nowIdx = rows.findIndex((r) => r.time > now);
  const gap = (i: number) => (i > 0 ? gaps.find((g) => g.at === rows[i - 1].end) : undefined);

  const nextCard = (
    <section className="card-flat order-1 p-4 sm:p-5 anim-fade-up" style={{ background: 'rgba(255,255,255,.75)' }}>
      {withYou ? <>
        <div className="text-[11px] font-bold uppercase tracking-wider text-muted">With you now</div>
        <div className="mt-1.5 flex items-center gap-3"><div className="min-w-0 flex-1"><div className="truncate text-lg font-semibold">{withYou.patient.fullName}</div>
          <div className="text-xs text-muted">{[withYou.patient.ageYears ? `${withYou.patient.ageYears} ${withYou.patient.sex ?? ''}` : null, withYou.details?.complaints?.[0]?.text ?? withYou.details?.complaint, withYou.details?.bp && `BP ${withYou.details.bp}`].filter(Boolean).join(' · ')}</div></div>
          {can(perms, 'encounter.intake') && <button className="btn btn-accent" disabled={open.isPending} onClick={() => open.mutate(withYou.id)}>Continue</button>}</div>
        {next && <div className="my-3 border-t border-line" />}
      </> : null}
      {next ? <>
        <div className="text-[11px] font-bold uppercase tracking-wider text-muted">Next</div>
        <div className="mt-1.5 flex items-center gap-3"><div className="min-w-0 flex-1"><div className="truncate text-lg font-semibold">{next.patient.fullName}</div>
          <div className="text-xs text-muted">{[next.patient.ageYears ? `${next.patient.ageYears} ${next.patient.sex ?? ''}` : null, next.details?.complaints?.[0]?.text ?? next.details?.complaint, `waiting ${minsSince(next.arrivedAt)} min`].filter(Boolean).join(' · ')}</div>
          {lastEnc && <div className="mt-1 text-xs text-muted">Last visit {fmtDate(lastEnc.createdAt)}: {joinList(lastEnc.data?.assessment?.diagnosis) || joinList(lastEnc.data?.complaint?.chief_complaint) || 'consultation'}{lastEnc.prescription?.length ? ` · ${lastEnc.prescription.map((i: any) => i.name).slice(0, 2).join(', ')}` : ''}</div>}</div>
          {can(perms, 'encounter.intake') && <button className={`btn ${withYou ? '' : 'btn-primary'}`} disabled={open.isPending} onClick={() => open.mutate(next.id)}>Call in</button>}</div>
        <div className="mt-2.5 text-xs text-muted">{waiting[1] ? `Then ${waiting[1].patient.fullName} (${minsSince(waiting[1].arrivedAt)} min). ` : ''}{toCome ? `${toCome} more booked after them.` : 'No more bookings to come.'}</div>
      </> : !withYou && <div className="py-2 text-sm text-muted">{toCome ? `Nobody waiting. ${toCome} booked still to come.` : 'Nobody waiting, nobody else booked today.'}</div>}
    </section>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 anim-fade-up">
        <div className="min-w-0"><h1 className="text-[26px] font-semibold leading-tight">{dateLabel}</h1>
          <div className="text-sm text-muted"><b className="text-ink">{apptCount} patient{apptCount === 1 ? '' : 's'}{c.procedures?.length ? ` · ${c.procedures.length} procedure${c.procedures.length === 1 ? '' : 's'}` : ''}</b> · {seen} seen · {waiting.length} waiting · {toCome} still to come{lastEnd ? ` · you finish at ${lastEnd}` : doc ? ' · not working today' : ''}</div>
          {(late || breakNow || away) && <div className="mt-1 flex flex-wrap gap-1.5">{[late, breakNow, away].filter(Boolean).map((b: any) => <Chip key={b.id} tone="amber">{b.note}</Chip>)}</div>}</div>
        {canChange && <div className="ml-auto hidden flex-wrap gap-2 sm:flex">
          <button className="btn btn-sm" onClick={() => quick('late')}><Icon name="clock" className="h-3.5 w-3.5" />Running late</button>
          <button className="btn btn-sm" onClick={() => quick('break')}><Icon name="moon" className="h-3.5 w-3.5" />Break</button>
          <button className="btn btn-sm" onClick={() => quick('early')}><Icon name="door" className="h-3.5 w-3.5" />Leave early</button>
          <button className="btn btn-sm btn-primary" onClick={() => quick('early')}>Change my day</button>
        </div>}
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        {/* on a phone: next first, then the change buttons, then the day */}
        <div className="flex flex-col gap-4 xl:order-2">
          {nextCard}
          {canChange && <div className="order-2 grid grid-cols-4 gap-2 sm:hidden">{([['late', 'clock', 'Late'], ['break', 'moon', 'Break'], ['early', 'door', 'Leave early'], ['away', 'x', 'Not coming']] as const).map(([k, i, l]) =>
            <button key={k} className="card !rounded-2xl !p-2.5 text-center text-xs font-semibold" onClick={() => quick(k)}><Icon name={i} className="mx-auto mb-1 h-4 w-4" />{l}</button>)}</div>}
          <section className="card-flat order-3 p-4 sm:p-5 anim-fade-up">
            <div className="flex items-center gap-2"><b className="text-[15px]">Before you leave</b>{leaveCount > 0 && <Chip tone="amber">{leaveCount}</Chip>}</div>
            {leaveCount === 0 ? <div className="py-2 text-sm text-muted">Nothing waiting on you.</div> : <div className="mt-1">
              {resultGroups.map((g: any) => <Attn key={g.patient.id} tag="result" title={g.patient.fullName} sub={`${[...new Set(g.tests)].join(', ')} · ${g.docs.size} file${g.docs.size === 1 ? '' : 's'}`} action="Open" onClick={() => openResults(g)} />)}
              {drafts.map((v: any) => <Attn key={v.id} tag="note" title={v.patient.fullName} sub={`arrived ${hhmm(v.arrivedAt)} · note not finished`} action="Finish" onClick={() => open.mutate(v.id)} />)}
              {review.slice(0, 4).map((r: any) => <Attn key={r.id} tag="plan" title={`${r.procedure} for ${r.patient.fullName}`} sub={r.sittings ? `approve ${r.sittings} sittings` : 'approve the plan'} action="Open" onClick={() => nav(`/patients/${r.patient.id}`)} />)}
              {noDoc.map((p: any) => <Attn key={p.id} tag="no doctor" title={p.patient.fullName} sub={`${p.procedure ?? 'Procedure'} ${p.startTime} has no doctor`} action={doc ? 'Take it' : 'Open'} onClick={() => doc ? take.mutate(p.id) : nav(`/worklist?tab=schedule&day=${today()}`)} />)}
              {overdue.length > 0 && <Attn tag="follow-up" title={`${overdue.length} follow-up${overdue.length === 1 ? '' : 's'} overdue`} sub="Reception or the coordinator can call them" action="See" onClick={() => nav('/worklist?tab=plans')} />}
              {stopped.map((x: any) => <Attn key={x.id} tag="sign-in" title={`${x.name} was stopped`} sub={`new internet address ${x.ip}: at the clinic? allow it`} action="Open" onClick={() => nav('/settings?tab=privacy')} />)}
            </div>}
          </section>
          <section className="card-flat order-4 p-4 sm:p-5 anim-fade-up">
            <div className="flex items-baseline"><b className="text-[15px]">Tomorrow</b><span className="ml-auto text-xs text-muted">{new Date(tmr + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })}</span></div>
            <div className="mt-1 text-sm text-muted">{tom.isLoading ? '…' : tw.length ? <>{hoursOf(tw)} · <b className="text-ink">{tBooked} booked{tom.data?.procedures?.length ? ` · ${tom.data.procedures.length} procedure${tom.data.procedures.length === 1 ? '' : 's'}` : ''}</b>{firstTomorrow ? ` · first ${firstTomorrow}` : ''}</> : (tom.data?.blocks ?? []).some((b: any) => b.kind === 'leave') ? 'Away' : 'Not working'}</div>
            <div className="mt-3 flex flex-wrap gap-2"><button className="btn btn-sm" onClick={() => nav(`/calendar?day=${tmr}`)}>See the day</button>{canChange && tw.length > 0 && <button className="btn btn-sm" onClick={() => setChange({ kind: 'away', day: tmr })}>I'm not coming</button>}</div>
          </section>
        </div>

        <section className="card-flat order-last min-w-0 p-4 sm:p-5 xl:order-1 anim-fade-up">
          <div className="mb-2 flex flex-wrap items-center gap-2"><b className="text-[15px]">{doc ? 'Your day' : 'The clinic today'}</b>
            <span className="ml-auto flex flex-wrap gap-1.5 text-[11px]">{([['done', 'seen'], ['with', 'with you'], ['wait', 'waiting'], ['booked', 'booked'], ['proc', 'procedure']] as const).map(([k, l]) => <span key={k} className={`rounded-md border px-1.5 py-0.5 font-semibold ${PILL[k]}`}>{l}</span>)}</span></div>
          {away && !rows.length ? <div className="py-6 text-center text-sm text-muted">{away.note}</div> : rows.length === 0 ? <div className="py-6 text-center text-sm text-muted">{doc ? 'Not working today.' : 'Nothing booked today.'}</div> : (
            <div>{rows.map((r, i) => (
              <div key={r.time + i}>
                {i === nowIdx && (!gap(i) || now < gap(i)!.at) && <NowLine at={now} />}
                {gap(i) && <div className="grid grid-cols-[52px_1fr] border-t border-line/60"><span /><div className="my-1.5 rounded-xl px-3 py-2 text-xs font-semibold text-muted" style={{ background: 'repeating-linear-gradient(45deg,rgba(23,25,26,.05) 0 6px,transparent 6px 12px)' }}>{gap(i)!.label}</div></div>}
                {i === nowIdx && gap(i) && now >= gap(i)!.at && <NowLine at={now} />}
                <div className="grid min-h-[52px] grid-cols-[52px_1fr] items-start border-t border-line/60">
                  <b className="pt-2.5 text-xs text-muted">{r.time}</b>
                  <div className="flex flex-wrap items-center gap-1.5 py-2">
                    {r.off ? <span className="flex-1 rounded-xl px-3 py-1.5 text-xs font-semibold text-muted" style={{ background: 'repeating-linear-gradient(45deg,rgba(23,25,26,.05) 0 6px,transparent 6px 12px)' }}>{r.off}</span> : null}
                    {r.pills.map((p) => <button key={p.key} title={p.title} onClick={() => p.patientId && nav(`/patients/${p.patientId}`)} className={`rounded-[10px] border px-2.5 py-1 text-[12.5px] font-semibold ${p.cls}`}>{p.label}</button>)}
                    {!r.off && r.free > 0 && r.end > now && <span className="text-xs text-muted">· {r.free} free</span>}
                  </div>
                </div>
              </div>))}
              {nowIdx === -1 && rows.length > 0 && rows[rows.length - 1].end > now && <NowLine at={now} />}
              <div className="grid grid-cols-[52px_1fr] border-t border-line/60 pt-2 text-xs text-muted"><b>{lastEnd ?? ''}</b><span>{allPills.length ? 'day ends' : ''}</span></div>
            </div>)}
          <div className="mt-2 text-xs text-muted">Click a name to open the patient. Times are booking windows, not exact minutes.</div>
        </section>
      </div>
      {change && doc && <ChangeMyDay practitionerId={doc} name={docName} initialKind={change.kind} initialDay={change.day} onClose={() => setChange(null)} />}
    </div>
  );
}


function NowLine({ at }: { at: string }) {
  return <div className="relative ml-[52px] h-0 border-t-2 border-clay"><span className="absolute -left-[52px] -top-2.5 rounded-full bg-clay px-1.5 py-0.5 text-[10.5px] font-bold text-white">{at}</span></div>;
}

function Attn({ tag, title, sub, action, onClick }: { tag: string; title: string; sub: string; action: string; onClick: () => void }) {
  return (
    <div className="flex items-center gap-3 border-t border-line/60 py-2.5 first:border-t-0">
      <span className="shrink-0 rounded-full bg-ink/7 px-2 py-0.5 text-[10.5px] font-bold text-ink-2">{tag}</span>
      <div className="min-w-0 flex-1"><div className="truncate text-sm font-semibold">{title}</div><div className="truncate text-xs text-muted">{sub}</div></div>
      <button className="btn btn-sm" onClick={onClick}>{action}</button>
    </div>
  );
}

