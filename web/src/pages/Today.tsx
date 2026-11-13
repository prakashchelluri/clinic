import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useOutletContext } from 'react-router';
import { get, post, qc, today, errText } from '../api';
import { chime, makeOnceWatcher } from '../chime';
import { can } from '../App';
import { Avatar, Chip, Icon, Skeleton, toast, fmtDate } from '../ui';
import { ChangeMyDay, type ChangeKind } from '../dayChange';
import { joinList } from '../encounterDetail';
import { ageText } from '../rxLine';
import { ProcReview, useApprovals } from '../procReview';
import { DiscountAsks, useDiscountAsks } from '../takePayment';
import { DaySchedule } from './frontDeskSchedule';
import { AppointmentDrawer } from '../apptDrawer';
import { ArrivalSheet } from './FrontDesk';
import '../frontdesk.css';

const minsSince = (iso: string) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
/** a wait as people say it: 12m, 3h 51m */
const dur = (m: number) => (m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`);
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
const nowHHMM = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
const addDay = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
/** "10:00–13:00, 16:00–20:00" from back-to-back windows. */
/** Allergies first, then the conditions recorded once on the patient (diabetes, BP, thyroid…). */
const medical = (p: any, cfg: any): string => [p?.allergies ? `Allergic to ${p.allergies}` : null,
  ...(cfg?.historyCategories ?? []).flatMap((c: any) => (Array.isArray(p?.history?.[c.key]) ? p.history[c.key].map((x: any) => x.name) : []))].filter(Boolean).join(' · ');
const complaintOf = (v: any) => v?.details?.reportsEncounterId ? 'Back with reports' : v?.details?.complaints?.map((c: any) => c.text).filter(Boolean).join(', ') || v?.details?.complaint || '';
const lastVisitOf = (tl: any) => { const e = (tl?.encounters ?? []).find((x: any) => x.status === 'completed'); if (!e) return ''; const dx = joinList(e.data?.assessment?.diagnosis) || joinList(e.data?.complaint?.chief_complaint); const rx = (e.prescription ?? []).map((i: any) => i.name).slice(0, 3).join(', '); return [fmtDate(e.createdAt), dx, rx].filter(Boolean).join(' · '); };

/** Someone picked on the calendar: a patient who is here (visit), for the side drawer. */
type Item = { key: string; label: string; patientId?: string; visit?: any; proc?: any; hour: string };

/** The doctor's dashboard: the calendar on the left (their own; every doctor's for the owner), and on the right the next patient,
 *  the results to review, what else needs them, and tomorrow. No money. */
export function Today() {
  const { me, perms, cfg } = useOutletContext<any>();
  const nav = useNavigate();
  const doc: string | null = me.practitionerId ?? null;
  const docName = cfg?.practitioners?.find((p: any) => p.id === doc)?.name ?? me.name;
  const tmr = addDay(today(), 1);
  const fd = useQuery({ queryKey: ['frontdesk', 'today-doc'], queryFn: () => get('/frontdesk'), refetchInterval: 5000 });
  const cal = useQuery({ queryKey: ['calendar', today(), doc ?? 'all'], queryFn: () => get(`/calendar?day=${today()}${doc ? `&practitionerId=${doc}` : ''}`), refetchInterval: 30000 });
  // the owner's check on the desk: the same review rows the Calls page lists, so both numbers agree; other doctors don't see it
  const fus = useQuery({ queryKey: ['followups', 'reviews'], queryFn: () => get('/followups?tab=reviews'), enabled: can(perms, 'finance.read') && can(perms, 'worklist.read') });
  const allProcs = useQuery({ queryKey: ['psessions', 'day', today()], queryFn: () => get(`/procedure-sessions?day=${today()}&active=1`), refetchInterval: 30000, enabled: can(perms, 'worklist.read') });
  const ordq = useQuery({ queryKey: ['orders'], queryFn: () => get('/orders'), refetchInterval: 30000, enabled: !!doc && can(perms, 'document.read') });
  const secq = useQuery({ queryKey: ['security'], queryFn: () => get('/security'), enabled: (me.roles ?? []).includes('owner'), refetchInterval: 60000 });
  const open = useMutation({ mutationFn: (visitId: string) => post(`/visits/${visitId}/encounter`), onSuccess: (e: any) => nav(`/encounter/${e.id}`, { viewTransition: true }), onError: (e) => toast(errText(e), 'err') });
  const take = useMutation({ mutationFn: (id: string) => post(`/procedure-sessions/${id}/assign`, { practitionerId: doc }), onSuccess: () => { ['calendar', 'psessions'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); toast('The sitting is yours'); }, onError: (e) => toast(errText(e), 'err') });
  const [change, setChange] = useState<{ kind: ChangeKind; day?: string } | null>(null);
  const [dayMenu, setDayMenu] = useState(false); // My day: running late, change my day, not coming tomorrow
  // sittings the coordinator sent for this doctor's approval
  const approvals = useApprovals(!!doc); const [reviewing, setReviewing] = useState(false);
  const toApprove: number = approvals.data?.pending ?? 0;
  const discountAsks = useDiscountAsks(can(perms, 'discount.approve')); const asksN: number = discountAsks.data?.length ?? 0; // discounts above the limit wait for whoever approves them
  const [picked, setPicked] = useState<Item | null>(null);
  const [apptId, setApptId] = useState<string | null>(null); // a booking opened from the calendar
  const [arrive, setArrive] = useState<null | { patientId?: string; appointmentId?: string; name?: string }>(null); // the doctor checks a booked patient in themself
  const seeAll = (me.roles ?? []).includes('owner') || !doc; // a doctor sees their own calendar; the owner sees everyone's

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

  const now = nowHHMM();
  const blocks: any[] = c.blocks ?? [];
  const late = blocks.find((b) => b.kind === 'late');
  const breakNow = blocks.find((b) => b.kind === 'break' && b.startTime <= now && now < b.endTime);
  const away = blocks.find((b) => b.kind === 'leave');

  // --- counts for the header ---
  // test orders whose every report is in: the doctor reviews each once (names of the tests only, values open in the review)
  // the patient is here with these reports: the doctor goes over them in the consultation, not from this list
  const hereWith = new Set(((d?.visits ?? []) as any[]).filter((v) => v.details?.reportsEncounterId && v.status !== 'done' && v.status !== 'left').map((v) => v.details.reportsEncounterId));
  const readyOrders = ((ordq.data?.orders ?? []) as any[]).filter((o) => o.state === 'ready' && !hereWith.has(o.encounterId));
  // out-of-range results: a count and the test names only, never the values
  const OUT = ['low', 'high', 'abnormal'];
  const outTests = (o: any): string[] => (o.tests ?? []).filter((t: any) => (t.values ?? []).some((v: any) => OUT.includes(v.flag ?? ''))).map((t: any) => t.name);
  const abnormalCount = readyOrders.reduce((n, o) => n + outTests(o).length, 0);
  // --- also waiting on the doctor ---
  const drafts = visits.filter((v) => v.encounterStatus === 'draft' && v.status !== 'in_consult');
  const overdue = (fus.data?.rows ?? []).filter((r: any) => r.dueOn && r.dueOn < today() && !r.waiting);
  const noDoc = (allProcs.data ?? []).filter((p: any) => ['confirmed', 'in_progress'].includes(p.state) && !p.practitionerId);
  const stopped: any[] = secq.data?.security?.ipLock?.enabled ? secq.data.stopped : [];
  const otherCount = stopped.length + drafts.length + noDoc.length + (overdue.length ? 1 : 0) + (toApprove ? 1 : 0) + asksN;

  const canChange = !!doc;
  const nextMed = medical(nextTl.data?.patient, cfg);

  return (
    <div className="fd-doc space-y-4">
      <h1 className="sr-only">Dashboard</h1>

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_400px]">
        {/* the calendar: my own, or every doctor's for the owner; Today by the hour or the Week */}
        <div className="order-2 min-w-0 xl:order-1">
          <DaySchedule today={today()} visitsToday={seeAll ? d.visits ?? [] : visits} doctors={(d.doctors ?? []).filter((x: any) => seeAll || x.id === doc)} rooms={seeAll ? (cfg?.rooms ?? []).filter((r: any) => r.active !== false) : []}
            selectedId={picked?.visit?.id ?? null} nextIds={new Set(next ? [next.id] : [])} procsInDoc
            kindOf={(v) => v.status === 'left' ? 'noshow' : v.status === 'in_consult' ? 'doctor' : v.status === 'intake' ? 'intake' : v.status === 'done' ? 'done' : 'waiting'}
            onVisit={(id) => { const v = (d.visits ?? []).find((x: any) => x.id === id); if (v) setPicked({ key: v.id, label: v.patient.fullName, patientId: v.patient.id, visit: v, hour: '' }); }} onOpenAppt={setApptId}
            tools={canChange && <>{[late, breakNow, away].filter(Boolean).map((b: any) => <Chip key={b.id} tone="amber">{b.note}</Chip>)}
              <span className="relative"><button type="button" className="btn btn-sm" aria-haspopup="menu" aria-expanded={dayMenu} onClick={() => setDayMenu(!dayMenu)}><Icon name="clock" className="h-3.5 w-3.5" />My day<Icon name="chevR" className="h-3.5 w-3.5 rotate-90 text-muted" /></button>
                {dayMenu && <><div className="fixed inset-0 z-30" onClick={() => setDayMenu(false)} />
                  <div className="menu anim-menu z-40" role="menu">
                    <button role="menuitem" onClick={() => { setDayMenu(false); setChange({ kind: 'late' }); }}>Running late</button>
                    <button role="menuitem" onClick={() => { setDayMenu(false); setChange({ kind: 'early' }); }}>Change my day</button>
                    <button role="menuitem" onClick={() => { setDayMenu(false); setChange({ kind: 'away', day: tmr }); }}>I'm not coming tomorrow</button>
                  </div></>}</span></>} />
        </div>

        <div className="order-1 flex min-w-0 flex-col gap-4 xl:order-2">
          {/* the room and the line (option B): who is with you on a tinted band, then everyone waiting as numbered rows,
              the first with its last visit and the one Start button; a long wait turns amber */}
          <section className="card !p-0 overflow-hidden anim-fade-up" aria-label="Action">
            {inRoom.map((v, i) => { const fresh = notOpened(v); const since = v.details?.calledAt ?? v.arrivedAt; return (
              <div key={v.id} className={`flex items-center gap-3 px-4 py-3 ${i === 0 ? 'bg-clay-soft' : 'border-t border-line'}`} role={fresh ? 'alert' : undefined}>
                <Avatar name={v.patient.fullName} size={`h-9 w-9 text-[12px] ${i === 0 ? '!bg-clay !text-white' : ''}`} />
                <div className="min-w-0 flex-1">
                  <div className={`text-[12px] font-medium ${i === 0 ? 'text-clay-ink' : 'text-muted'}`}>{i === 0 ? 'With you' : 'Inside'}{since ? ` · ${dur(minsSince(since))}` : ''}</div>
                  <div className="flex items-center gap-2 truncate text-[15px] font-semibold">{v.patient.fullName}{fresh && <Chip tone="amber">sent in {dur(minsSince(v.details.calledAt))} ago</Chip>}</div>
                </div>
                {can(perms, 'encounter.intake') && <button className={`btn btn-sm ${fresh || i === 0 ? 'btn-primary' : ''}`} disabled={open.isPending} onClick={() => open.mutate(v.id)}>{fresh ? 'Open' : 'Continue'}</button>}
              </div>); })}
            <div className="flex items-center gap-2 px-4 pb-1.5 pt-3 text-[12.5px] font-semibold text-muted">Waiting{waiting.length ? ` · ${waiting.length}` : ''}
              {withJunior.length > 0 && <span className="ml-auto font-normal">{withJunior.length} with the junior doctor</span>}</div>
            {waiting.length === 0 && <div className="px-4 pb-4 text-sm text-muted">{screening === 'required' && unscreened.length ? `${unscreened.length} waiting for screening.` : 'Nobody waiting for you.'}</div>}
            {waiting.slice(0, 6).map((v, i) => { const m = minsSince(v.arrivedAt); const first = i === 0;
              const sub = [v.opNumber, complaintOf(v) || (first ? (nextTl.isLoading ? '…' : lastVisitOf(nextTl.data) ? `Last: ${lastVisitOf(nextTl.data)}` : 'First visit') : v.category)].filter(Boolean).join(' · ');
              return (
              <div key={v.id} className="flex items-center gap-3 border-t border-line px-4 py-2.5">
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-[5px] bg-paper-2 text-[12px] font-semibold text-ink-2">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-semibold">{v.patient.fullName} <span className="font-normal text-muted">{ageText(v.patient) ? `${ageText(v.patient)} ${v.patient.sex ?? ''}`.trim() : ''}</span></div>
                  <div className="truncate text-[12.5px] text-muted" title={sub}>{sub}</div>
                  {first && nextMed && <div className="truncate text-[12.5px] font-medium text-rose">{nextMed}</div>}
                </div>
                <Chip tone={m >= 30 ? 'amber' : ''}>{dur(m)}</Chip>
                {first && can(perms, 'encounter.intake') && <button className={`btn btn-sm ${inRoom.length ? '' : 'btn-primary'}`} disabled={open.isPending} onClick={() => open.mutate(v.id)}>Start</button>}
              </div>); })}
            {waiting.length > 6 && <div className="border-t border-line px-4 py-2 text-[12.5px] text-muted">+{waiting.length - 6} more waiting</div>}
            {readyOrders.length > 0 && <>
              <div className="flex items-center gap-2 border-t border-line px-4 pb-1.5 pt-3 text-[12.5px] font-semibold text-muted">Results to review · {readyOrders.length}{abnormalCount > 0 && <span className="ml-auto font-normal text-rose">{abnormalCount} out of range</span>}</div>
              {readyOrders.map((o: any) => { const out = outTests(o); return <div key={o.key} className="flex items-center gap-3 border-t border-line px-4 py-2.5"><div className="min-w-0 flex-1"><div className="truncate text-[14px] font-semibold">{o.patient.fullName}</div><div className="truncate text-[12.5px] text-muted">{o.tests.map((t: any) => t.name).join(', ')}</div>{out.length > 0 && <div className="truncate text-[12.5px] text-rose">out of range: {out.join(', ')}</div>}</div><button className="btn btn-sm" onClick={() => nav(o.held ? `/encounter/${o.encounterId}?review=1` : `/tests?open=${encodeURIComponent(o.key)}`)}>Review</button></div>; })}</>}
            {otherCount > 0 && <>
              <div className="border-t border-line px-4 pb-1.5 pt-3 text-[12.5px] font-semibold text-muted">Needs your attention · {otherCount}</div>
              {asksN > 0 && <DiscountAsks />}
              {toApprove > 0 && <Attn title={`${toApprove} procedure sitting${toApprove === 1 ? '' : 's'} to approve`} sub={`from the coordinator${approvals.data?.weeks?.length ? ` · week of ${new Date(approvals.data.weeks[0] + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' })}` : ''}`} action="Review" onClick={() => setReviewing(true)} />}
              {drafts.map((v: any) => <Attn key={v.id} title={v.patient.fullName} sub={`arrived ${hhmm(v.arrivedAt)} · note not finished`} action="Finish" onClick={() => open.mutate(v.id)} />)}
              {noDoc.map((p: any) => <Attn key={p.id} title={p.patient.fullName} sub={`${p.procedure ?? 'Procedure'} ${p.startTime} has no doctor`} action={doc ? 'Take it' : 'Open'} onClick={() => doc ? take.mutate(p.id) : nav(`/worklist?tab=today&day=${today()}`)} />)}
              {overdue.length > 0 && <Attn title={`${overdue.length} follow-up${overdue.length === 1 ? '' : 's'} overdue`} sub="On the desk's Calls list" action="See" onClick={() => nav('/calls?tab=reviews')} />}
              {stopped.map((x: any) => <Attn key={x.id} title={`${x.name} was stopped`} sub={`new internet address ${x.ip}: at the clinic? allow it`} action="Open" onClick={() => nav('/settings?tab=privacy')} />)}</>}
          </section>
        </div>
      </div>
      {picked && <DayDrawer item={picked} cfg={cfg} canOpen={can(perms, 'encounter.intake')} busy={open.isPending} onStart={(id) => open.mutate(id)} onClose={() => setPicked(null)} />}
      {apptId && <AppointmentDrawer id={apptId} cfg={cfg} canWrite={can(perms, 'appointment.write')} onClose={() => setApptId(null)}
        onArrive={can(perms, 'visit.write') ? (a) => { setApptId(null); setArrive({ patientId: a.patient.id ?? a.patientId, appointmentId: a.id, name: a.patient.fullName }); } : undefined} />}
      {arrive && <ArrivalSheet init={arrive} cfg={cfg} perms={perms} todayAppts={(d.appointments ?? []).filter((a: any) => ['booked', 'confirmed'].includes(a.status))}
        waitingByDoctor={Object.fromEntries((d.doctors ?? []).map((x: any) => [x.id, (d.visits ?? []).filter((v: any) => ['waiting', 'intake', 'screened'].includes(v.status) && v.practitionerId === x.id).length]))}
        onClose={() => { setArrive(null); ['frontdesk', 'calendar'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); }} />}
      {reviewing && <ProcReview onClose={() => setReviewing(false)} />}
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
    : !v ? 'Booked'
    : v.status === 'in_consult' ? 'With the doctor' : v.status === 'intake' ? 'With the junior doctor' : ['waiting', 'screened'].includes(v.status) ? `Waiting · token ${v.opNumber} · ${minsSince(v.arrivedAt)} min${v.status === 'screened' ? ' · screened' : ''}`
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
        {item.proc && <button className="btn" onClick={() => nav(`/worklist?tab=today&day=${today()}`)}>Open procedures</button>}
        {item.patientId && <button className="btn" onClick={() => nav(`/patients/${item.patientId}`)}>Open record</button>}
      </div>
    </aside>, document.body);
}

function Attn({ title, sub, action, onClick }: { title: string; sub: string; action: string; onClick: () => void }) {
  return (
    <div className="flex items-center gap-3 border-t border-line px-4 py-2.5">
      <div className="min-w-0 flex-1"><div className="truncate text-[14px] font-semibold">{title}</div><div className="truncate text-[12.5px] text-muted">{sub}</div></div>
      <button className="btn btn-sm" onClick={onClick}>{action}</button>
    </div>
  );
}
