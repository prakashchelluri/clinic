import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useOutletContext } from 'react-router';
import { get, post, qc, today, errText } from '../api';
import { chime, makeOnceWatcher } from '../chime';
import { can } from '../App';
import { Chip, Icon, Skeleton, toast, fmtDate } from '../ui';
import { ChangeMyDay, type ChangeKind } from '../dayChange';
import { joinList } from '../encounterDetail';
import { ageText } from '../rxLine';
import '../frontdesk.css';

const minsSince = (iso: string) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const nowHHMM = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
const addDay = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
/** "9–10 am", "12–1 pm": how the clinic says an hour */
const hourLabel = (a: string, b: string) => { const f = (m: number) => { const h = Math.floor(m / 60) % 12 || 12; const mm = m % 60; return mm ? `${h}:${String(mm).padStart(2, '0')}` : `${h}`; }; const s = toMin(a), e = toMin(b); return `${f(s)}–${f(e)} ${e > 12 * 60 ? 'pm' : 'am'}`; };
/** "10:00–13:00, 16:00–20:00" from back-to-back windows. */
const hoursOf = (ws: any[]) => ws.reduce((out: [string, string][], w) => { const last = out[out.length - 1]; if (last && last[1] === w.startTime) last[1] = w.endTime; else out.push([w.startTime, w.endTime]); return out; }, []).map(([a, b]) => `${a}–${b}`).join(', ');
/** Allergies first, then the conditions recorded once on the patient (diabetes, BP, thyroid…). */
const medical = (p: any, cfg: any): string => [p?.allergies ? `Allergic to ${p.allergies}` : null,
  ...(cfg?.historyCategories ?? []).flatMap((c: any) => (Array.isArray(p?.history?.[c.key]) ? p.history[c.key].map((x: any) => x.name) : []))].filter(Boolean).join(' · ');
const complaintOf = (v: any) => v?.details?.reportsEncounterId ? 'Back with reports' : v?.details?.complaints?.map((c: any) => c.text).filter(Boolean).join(', ') || v?.details?.complaint || '';
const lastVisitOf = (tl: any) => { const e = (tl?.encounters ?? []).find((x: any) => x.status === 'completed'); if (!e) return ''; const dx = joinList(e.data?.assessment?.diagnosis) || joinList(e.data?.complaint?.chief_complaint); const rx = (e.prescription ?? []).map((i: any) => i.name).slice(0, 3).join(', '); return [fmtDate(e.createdAt), dx, rx].filter(Boolean).join(' · '); };

/** One thing in the day: a patient (checked in or booked) or a procedure sitting. */
type Item = { key: string; label: string; tok?: string; tag?: string; cls: string; sort: number; patientId?: string; visit?: any; appt?: any; proc?: any; hour: string };

/** The doctor's day by the hour: every patient and procedure in the hour they are booked into, the next patient beside it,
 *  the results to review and tomorrow. Booked patients are dull (least of the doctor's worries); procedures stand out. No money. */
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
  const ordq = useQuery({ queryKey: ['orders'], queryFn: () => get('/orders'), refetchInterval: 30000, enabled: !!doc && can(perms, 'document.read') });
  const secq = useQuery({ queryKey: ['security'], queryFn: () => get('/security'), enabled: (me.roles ?? []).includes('owner'), refetchInterval: 60000 });
  const open = useMutation({ mutationFn: (visitId: string) => post(`/visits/${visitId}/encounter`), onSuccess: (e: any) => nav(`/encounter/${e.id}`, { viewTransition: true }), onError: (e) => toast(errText(e), 'err') });
  const take = useMutation({ mutationFn: (id: string) => post(`/procedure-sessions/${id}/assign`, { practitionerId: doc }), onSuccess: () => { ['calendar', 'psessions'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); toast('The sitting is yours'); }, onError: (e) => toast(errText(e), 'err') });
  const [change, setChange] = useState<{ kind: ChangeKind; day?: string } | null>(null);
  const [picked, setPicked] = useState<Item | null>(null);

  const d = fd.data; const c = cal.data;
  const visits: any[] = (d?.visits ?? []).filter((v: any) => !doc || !v.practitionerId || v.practitionerId === doc);
  // Everyone inside the room, in the order they were sent in: the first is with you, the rest sit inside and wait.
  const inRoom = visits.filter((v) => v.status === 'in_consult').sort((a, b) => String(a.details?.calledAt ?? a.arrivedAt).localeCompare(String(b.details?.calledAt ?? b.arrivedAt)));
  // The line: screened patients first, then the rest; never someone who is with the junior right now. With screening required, only screened patients.
  const screening: 'off' | 'first' | 'required' = cfg?.tenant?.settings?.screening ?? 'off';
  const withJunior = visits.filter((v) => v.status === 'intake');
  const unscreened = visits.filter((v) => v.status === 'waiting');
  const waiting = [...visits.filter((v) => v.status === 'screened'), ...(screening === 'required' ? [] : unscreened)];
  const next = waiting[0];
  // Reception sent someone in: the pad is not open yet, so say so once, with a chime.
  const notOpened = (v: any) => v.details?.calledBy === 'desk' && !v.details?.doctorOpenedAt;
  const sentIn = inRoom.filter(notOpened);
  const heard = useRef(makeOnceWatcher<string>());
  useEffect(() => { heard.current(sentIn.map((v) => v.id), () => chime('call')); }, [sentIn.map((v) => v.id).join(',')]);
  const nextTl = useQuery({ queryKey: ['timeline', next?.patient?.id], queryFn: () => get(`/patients/${next.patient.id}/timeline`), enabled: !!next });
  if (!d || !c) return <div className="space-y-4"><Skeleton rows={2} /><Skeleton rows={8} /></div>;

  // --- the day by the hour: one block per booking window; walk-ins in the hour they came; sittings in the hour they start ---
  const now = nowHHMM();
  const byAppt = new Map(visits.filter((v) => v.appointmentId).map((v) => [v.appointmentId, v]));
  const visitItem = (v: any, key: string, hour: string): Item => {
    const st = v.status; const base = { key, tok: v.opNumber, patientId: v.patient.id, visit: v, hour };
    if (st === 'in_consult') return { ...base, label: v.patient.fullName, tag: 'with you', cls: 'fd-k-doctor', sort: 0 };
    if (st === 'intake') return { ...base, label: v.patient.fullName, tag: 'with junior', cls: 'fd-k-intake', sort: 1 };
    if (st === 'waiting' || st === 'screened') return { ...base, label: v.patient.fullName, tag: v.id === next?.id ? 'next' : `${minsSince(v.arrivedAt)} min`, cls: `fd-k-waiting ${v.id === next?.id ? 'fd-k-next' : ''}`, sort: v.id === next?.id ? 0.5 : 1 };
    if (st === 'left') return { ...base, tok: '', label: v.patient.fullName, tag: 'left', cls: 'fd-k-late', sort: 4 };
    return { ...base, tok: '✓', label: v.patient.fullName, tag: v.encounterStatus === 'draft' ? 'note unfinished' : '', cls: 'fd-k-done', sort: 3 };
  };
  const windows: any[] = c.windows;
  const rows: { start: string; end: string; items: Item[]; free: number; cap: number; off?: string }[] = windows.map((w) => {
    const hour = hourLabel(w.startTime, w.endTime);
    const items: Item[] = (w.appointments ?? []).filter((a: any) => a.status !== 'cancelled').map((a: any) => {
      const v = byAppt.get(a.id);
      if (v) return visitItem(v, a.id, hour);
      const notCome = a.status === 'no_show' || w.endTime < now;
      return { key: a.id, label: a.name, tag: notCome ? "didn't come" : a.service ?? '', cls: notCome ? 'fd-k-late' : 'fd-k-booked', sort: 2, patientId: a.patientId, appt: a, hour };
    });
    const blk = (w.reductions ?? []).find((r: any) => r.kind === 'leave' || r.kind === 'other' || r.kind === 'stop');
    return { start: w.startTime, end: w.endTime, items, free: Math.max(0, w.free), cap: w.effectiveCapacity, off: blk && w.effectiveCapacity === 0 && !items.length ? blk.note ?? 'Closed' : undefined };
  });
  const rowAt = (t: string) => [...rows].reverse().find((r) => r.start <= t) ?? rows[0];
  for (const v of visits.filter((x) => !x.appointmentId)) {
    let r = rowAt(hhmm(v.arrivedAt));
    if (!r) { r = { start: hhmm(v.arrivedAt), end: hhmm(v.arrivedAt), items: [], free: 0, cap: 0 }; rows.push(r); }
    const it = visitItem(v, v.id, hourLabel(r.start, r.end)); r.items.push({ ...it, tag: [it.tag, v.category === 'NGT' ? 'emergency' : 'walk-in'].filter(Boolean).join(' · ') });
  }
  for (const p of c.procedures ?? []) {
    let r = rows.find((x) => x.start <= p.startTime && p.startTime < x.end);
    if (!r) { r = { start: p.startTime, end: p.endTime, items: [], free: 0, cap: 0 }; rows.push(r); }
    r.items.push({ key: p.id, label: `${p.procedure ?? 'Procedure'} · ${p.patient}`, tok: p.state === 'completed' ? '✓' : '', tag: `${p.startTime}${p.room ? ` · ${p.room}` : ''}`, cls: p.state === 'completed' ? 'fd-k-done' : 'fd-k-proc', sort: 1.5, patientId: p.patientId, proc: p, hour: hourLabel(r.start, r.end) });
  }
  rows.sort((a, b) => a.start.localeCompare(b.start));
  rows.forEach((r) => r.items.sort((a, b) => a.sort - b.sort));
  const blocks: any[] = c.blocks ?? [];
  const late = blocks.find((b) => b.kind === 'late');
  const breakNow = blocks.find((b) => b.kind === 'break' && b.startTime <= now && now < b.endTime);
  const away = blocks.find((b) => b.kind === 'leave');

  // --- counts for the header ---
  const seen = visits.filter((v) => v.status === 'done').length;
  // test orders whose every report is in: the doctor reviews each once (names of the tests only, values open in the review)
  const readyOrders = ((ordq.data?.orders ?? []) as any[]).filter((o) => o.state === 'ready');
  // out-of-range results: a count and the test names only, never the values
  const OUT = ['low', 'high', 'abnormal'];
  const outTests = (o: any): string[] => (o.tests ?? []).filter((t: any) => (t.values ?? []).some((v: any) => OUT.includes(v.flag ?? ''))).map((t: any) => t.name);
  const abnormalCount = readyOrders.reduce((n, o) => n + outTests(o).length, 0);
  // --- also waiting on the doctor ---
  const drafts = visits.filter((v) => v.encounterStatus === 'draft' && v.status !== 'in_consult');
  const review = (plans.data ?? []).filter((r: any) => r.status === 'open' && cfg?.procedures.find((p: any) => p.id === r.procedureId)?.requiresReview);
  const overdue = (fus.data ?? []).filter((r: any) => r.dueOn && r.dueOn < today() && ['open', 'contacted'].includes(r.status));
  const noDoc = (allProcs.data ?? []).filter((p: any) => ['confirmed', 'in_progress'].includes(p.state) && !p.practitionerId);
  const stopped: any[] = secq.data?.security?.ipLock?.enabled ? secq.data.stopped : [];
  const otherCount = stopped.length + drafts.length + review.length + noDoc.length + (overdue.length ? 1 : 0);

  const tw: any[] = tom.data?.windows ?? [];
  const tBooked = tw.reduce((n, w) => n + (w.appointments ?? []).length, 0);
  const dateLabel = new Date().toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
  const canChange = !!doc;
  const nowIdx = rows.findIndex((r) => r.start <= now && now < r.end);
  const nextMed = medical(nextTl.data?.patient, cfg);

  return (
    <div className="fd-doc space-y-4">
      <header className="flex flex-wrap items-center gap-2.5 anim-fade-up">
        <h1 className="sr-only">Today</h1><span className="text-[14px] font-semibold text-muted">{dateLabel}{docName && doc ? ` · ${docName}` : ''}</span>
        {[late, breakNow, away].filter(Boolean).map((b: any) => <Chip key={b.id}>{b.note}</Chip>)}
        <span className="ml-auto" />
        <Chip>{waiting.length} waiting</Chip><Chip>{seen} seen</Chip>{readyOrders.length > 0 && <Chip>{readyOrders.length} result{readyOrders.length === 1 ? '' : 's'} to review</Chip>}
        {canChange && <><button className="btn btn-sm" onClick={() => setChange({ kind: 'late' })}><Icon name="clock" className="h-3.5 w-3.5" />Running late</button>
          <button className="btn btn-sm" onClick={() => setChange({ kind: 'early' })}>Change my day</button></>}
      </header>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        {/* my whole day by the hour: patients and procedures together, the same list is my queue */}
        <section className="fd-sheet order-2 min-w-0 p-4 sm:p-5 xl:order-1 anim-fade-up">
          <b className="text-[15px]">{doc ? 'My day' : 'The clinic today'}</b>
          {away && !rows.length ? <div className="py-6 text-center text-sm text-muted">{away.note}</div> : rows.length === 0 ? <div className="py-6 text-center text-sm text-muted">{doc ? 'Not working today.' : 'Nothing booked today.'}</div> : (
            <div className="mt-3 flex flex-col gap-2">{rows.map((r, i) => {
              const past = r.end <= now; const people = r.items.filter((x) => !x.proc).length;
              return (
                <div key={r.start + i} className={`rounded-[14px] px-3.5 py-3 ${i === nowIdx ? 'bg-clay-soft/40 ring-2 ring-clay' : past ? 'bg-paper-2/50' : 'ring-1 ring-line'}`}>
                  <div className="flex items-baseline gap-2"><b className={`text-[14px] ${past ? 'text-muted' : ''}`}>{hourLabel(r.start, r.end)}</b>
                    <span className="flex-1 text-[12px] font-semibold text-muted">{r.off ?? (past ? `${r.items.filter((x) => x.cls === 'fd-k-done').length} seen` : r.cap ? `${people} of ${r.cap} booked` : '')}</span>
                    {i === nowIdx && <b className="text-[12px] text-clay">now</b>}</div>
                  {r.items.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{r.items.map((p) => (
                    <button key={p.key} type="button" className={`fd-pc ${p.cls} ${picked?.key === p.key ? 'sel' : ''}`} onClick={() => setPicked(p)}>
                      {p.tok && <span className="tk">{p.tok}</span>}<span className="truncate">{p.label}</span>{p.tag && <span className="tg">{p.tag}</span>}</button>))}</div>}
                </div>); })}</div>)}
          <div className="mt-3 flex flex-wrap gap-3 text-[12px] text-muted">
            <span className="inline-flex items-center gap-1.5"><i className="fd-pc fd-k-booked !h-3 !w-4 !p-0" />booked</span>
            <span className="inline-flex items-center gap-1.5"><i className="fd-pc fd-k-waiting !h-3 !w-4 !p-0" />waiting</span>
            <span className="inline-flex items-center gap-1.5"><i className="fd-pc fd-k-next !h-3 !w-4 !p-0" />next</span>
            <span className="inline-flex items-center gap-1.5"><i className="fd-pc fd-k-doctor !h-3 !w-4 !p-0" />with you</span>
            <span className="inline-flex items-center gap-1.5"><i className="fd-pc fd-k-proc !h-3 !w-4 !p-0" />procedure</span>
            <span>Tap anyone for their card. Hours are booking windows, not exact minutes.</span>
          </div>
        </section>

        <div className="order-1 flex min-w-0 flex-col gap-4 xl:order-2">
          {/* who is in the room, then the one who is next: complaint, last visit, allergies and conditions; nothing else */}
          <section className="fd-sheet p-4 sm:p-5 anim-fade-up">
            {inRoom.map((v, i) => { const fresh = notOpened(v); return (
              <div key={v.id} className={`flex items-center gap-3 ${i ? 'mt-2 border-t border-line pt-2' : ''}`} role={fresh ? 'alert' : undefined}>
                <div className="min-w-0 flex-1"><div className="text-[11px] font-bold uppercase tracking-wider text-muted">{i === 0 ? 'With you' : 'Inside'}</div>
                  <div className="truncate text-[16px] font-semibold">{v.patient.fullName} {fresh && <Chip tone="amber">sent in {minsSince(v.details.calledAt)} min ago</Chip>}</div></div>
                {can(perms, 'encounter.intake') && <button className={`btn btn-sm ${fresh || i === 0 ? 'btn-primary' : ''}`} disabled={open.isPending} onClick={() => open.mutate(v.id)}>{fresh ? 'Open' : 'Continue'}</button>}
              </div>); })}
            {inRoom.length > 0 && <div className="my-3 border-t border-line" />}
            {next ? <>
              <div className="flex items-center gap-2"><span className="text-[11px] font-bold uppercase tracking-wider text-muted">Next</span><Chip>token {next.opNumber} · waiting {minsSince(next.arrivedAt)} min</Chip></div>
              <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3"><span className="text-[22px] font-bold">{next.patient.fullName}</span><span className="text-[14px] text-muted">{[ageText(next.patient) ? `${ageText(next.patient)} ${next.patient.sex ?? ''}`.trim() : null, next.category].filter(Boolean).join(' · ')}</span></div>
              {nextMed && <div className="mt-1.5 font-semibold text-rose">{nextMed}</div>}
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div><div className="text-[11px] font-bold uppercase tracking-wider text-muted">Complaint</div><div className="mt-1 font-semibold">{complaintOf(next) || '—'}</div></div>
                <div><div className="text-[11px] font-bold uppercase tracking-wider text-muted">Last visit</div><div className="mt-1 font-semibold">{nextTl.isLoading ? '…' : lastVisitOf(nextTl.data) || 'First visit'}</div></div>
              </div>
              {can(perms, 'encounter.intake') && <button className="btn btn-primary mt-4" disabled={open.isPending} onClick={() => open.mutate(next.id)}>Start consultation</button>}
              <div className="mt-3 text-[12.5px] text-muted">{waiting[1] ? `Then ${waiting[1].patient.fullName}. ` : ''}{withJunior.length ? `${withJunior.length} with the junior doctor.` : ''}</div>
            </> : !inRoom.length && <div className="py-2 text-sm text-muted">{withJunior.length ? `${withJunior.length} with the junior doctor. ` : ''}{screening === 'required' && unscreened.length ? `${unscreened.length} waiting for screening.` : 'Nobody waiting for you.'}</div>}
          </section>

          <section className="fd-sheet overflow-hidden anim-fade-up">
            <div className="px-4 pb-1 pt-3.5 sm:px-5"><b className="text-[15px]">Results to review</b>{abnormalCount > 0 && <span className="ml-2 text-sm font-semibold text-rose">{abnormalCount} out of range</span>}</div>
            {readyOrders.length === 0 ? <div className="px-4 pb-4 text-sm text-muted sm:px-5">Nothing to review.</div>
              : readyOrders.map((o: any) => { const out = outTests(o); return <div key={o.key} className="flex items-center gap-3 border-t border-line px-4 py-2.5 sm:px-5"><div className="min-w-0 flex-1"><div className="truncate text-sm font-semibold">{o.patient.fullName}</div><div className="truncate text-xs text-muted">{o.tests.map((t: any) => t.name).join(', ')}</div>{out.length > 0 && <div className="truncate text-xs text-rose">out of range: {out.join(', ')}</div>}</div><button className="btn btn-sm" onClick={() => nav('/tests?tab=review')}>Review</button></div>; })}
          </section>

          {otherCount > 0 && <section className="fd-sheet p-4 sm:p-5 anim-fade-up">
            <b className="text-[15px]">Also waiting on you</b>
            <div className="mt-1">
              {drafts.map((v: any) => <Attn key={v.id} title={v.patient.fullName} sub={`arrived ${hhmm(v.arrivedAt)} · note not finished`} action="Finish" onClick={() => open.mutate(v.id)} />)}
              {review.slice(0, 4).map((r: any) => <Attn key={r.id} title={`${r.procedure} for ${r.patient.fullName}`} sub={r.sittings ? `approve ${r.sittings} sittings` : 'approve the plan'} action="Open" onClick={() => nav(`/patients/${r.patient.id}`)} />)}
              {noDoc.map((p: any) => <Attn key={p.id} title={p.patient.fullName} sub={`${p.procedure ?? 'Procedure'} ${p.startTime} has no doctor`} action={doc ? 'Take it' : 'Open'} onClick={() => doc ? take.mutate(p.id) : nav(`/worklist?tab=schedule&day=${today()}`)} />)}
              {overdue.length > 0 && <Attn title={`${overdue.length} follow-up${overdue.length === 1 ? '' : 's'} overdue`} sub="Reception or the coordinator can call them" action="See" onClick={() => nav('/calls?tab=reviews')} />}
              {stopped.map((x: any) => <Attn key={x.id} title={`${x.name} was stopped`} sub={`new internet address ${x.ip}: at the clinic? allow it`} action="Open" onClick={() => nav('/settings?tab=privacy')} />)}
            </div>
          </section>}

          <section className="fd-sheet p-4 sm:p-5 anim-fade-up">
            <div className="flex items-baseline gap-2"><b className="text-[15px]">Tomorrow</b><span className="text-xs text-muted">{new Date(tmr + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })}</span></div>
            <div className="mt-1 text-sm text-muted">{tom.isLoading ? '…' : tw.length ? <>{hoursOf(tw)} · <b className="text-ink">{tBooked} booked{tom.data?.procedures?.length ? ` · ${tom.data.procedures.length} procedure${tom.data.procedures.length === 1 ? '' : 's'}` : ''}</b></> : (tom.data?.blocks ?? []).some((b: any) => b.kind === 'leave') ? 'Away' : 'Not working'}</div>
            {canChange && tw.length > 0 && <button className="btn btn-sm mt-3" onClick={() => setChange({ kind: 'away', day: tmr })}>I'm not coming</button>}
          </section>
        </div>
      </div>
      {picked && <DayDrawer item={picked} cfg={cfg} canOpen={can(perms, 'encounter.intake')} busy={open.isPending} onStart={(id) => open.mutate(id)} onClose={() => setPicked(null)} />}
      {change && doc && <ChangeMyDay practitionerId={doc} name={docName} initialKind={change.kind} initialDay={change.day} onClose={() => setChange(null)} />}
    </div>
  );
}

/** The side drawer for anyone in the day: allergies and conditions, the complaint, the last visit, and the one action. The day stays where it is. */
function DayDrawer({ item, cfg, canOpen, busy, onStart, onClose }: { item: Item; cfg: any; canOpen: boolean; busy: boolean; onStart: (visitId: string) => void; onClose: () => void }) {
  const nav = useNavigate();
  const tl = useQuery({ queryKey: ['timeline', item.patientId], queryFn: () => get(`/patients/${item.patientId}/timeline`), enabled: !!item.patientId });
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  const p = tl.data?.patient; const v = item.visit; const med = medical(p, cfg);
  const status = item.proc ? `${item.proc.procedure ?? 'Procedure'} · sitting ${item.proc.sittingNo}${item.proc.of ? ` of ${item.proc.of}` : ''}${item.proc.room ? ` · ${item.proc.room}` : ''} · ${item.proc.startTime}`
    : !v ? `Booked ${item.hour} · ${item.cls.includes('late') ? "didn't come" : 'not here yet'}`
    : v.status === 'in_consult' ? 'With you' : v.status === 'intake' ? 'With the junior doctor' : ['waiting', 'screened'].includes(v.status) ? `Waiting · token ${v.opNumber} · ${minsSince(v.arrivedAt)} min${v.status === 'screened' ? ' · screened' : ''}`
    : v.status === 'left' ? 'Left without seeing you' : `Seen${v.completedAt ? ` ${hhmm(v.completedAt)}` : ''}`;
  return createPortal(
    <aside aria-label={`About ${item.label}`} className="fixed inset-y-0 right-0 z-30 flex w-[min(440px,100vw)] flex-col gap-4 overflow-y-auto border-l border-line bg-surface p-5 anim-slide-in" style={{ boxShadow: '-24px 0 48px -32px rgba(16,32,24,.45)' }}>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1"><b className="block truncate text-[18px]">{p?.fullName ?? item.label}</b><div className="text-[12.5px] text-muted">{p ? [ageText(p) ? `${ageText(p)} ${p.sex ?? ''}`.trim() : null, p.patientNo].filter(Boolean).join(' · ') : ' '}</div></div>
        <button className="btn btn-icon" aria-label="Close" onClick={onClose}><Icon name="x" className="h-4 w-4" /></button>
      </div>
      {med && <div className="font-semibold text-rose">{med}</div>}
      <div className="rounded-[14px] bg-paper-2 px-3.5 py-3 text-[14px] font-semibold">{status}</div>
      {tl.isLoading ? <Skeleton rows={2} /> : <>
        {v && <div><div className="text-[11px] font-bold uppercase tracking-wider text-muted">Complaint</div><div className="mt-1 font-semibold">{complaintOf(v) || '—'}</div></div>}
        <div><div className="text-[11px] font-bold uppercase tracking-wider text-muted">Last visit</div><div className="mt-1 font-semibold">{lastVisitOf(tl.data) || 'First visit'}</div></div>
      </>}
      <div className="flex flex-wrap gap-2 border-t border-line pt-3.5">
        {canOpen && v && ['waiting', 'screened'].includes(v.status) && <button className="btn btn-primary" disabled={busy} onClick={() => onStart(v.id)}>Start consultation</button>}
        {canOpen && v && v.status === 'in_consult' && <button className="btn btn-primary" disabled={busy} onClick={() => onStart(v.id)}>Back to the prescription</button>}
        {canOpen && v && v.status === 'done' && v.encounterStatus === 'draft' && <button className="btn btn-primary" disabled={busy} onClick={() => onStart(v.id)}>Finish the note</button>}
        {item.proc && <button className="btn" onClick={() => nav(`/worklist?tab=schedule&day=${today()}`)}>Open procedures</button>}
        {item.patientId && <button className="btn" onClick={() => nav(`/patients/${item.patientId}`)}>Open record</button>}
      </div>
    </aside>, document.body);
}

function Attn({ title, sub, action, onClick }: { title: string; sub: string; action: string; onClick: () => void }) {
  return (
    <div className="flex items-center gap-3 border-t border-line/60 py-2.5 first:border-t-0">
      <div className="min-w-0 flex-1"><div className="truncate text-sm font-semibold">{title}</div><div className="truncate text-xs text-muted">{sub}</div></div>
      <button className="btn btn-sm" onClick={onClick}>{action}</button>
    </div>
  );
}
