import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useNavigate, useOutletContext, useSearchParams } from 'react-router';
import { get, post, patch, qc, uuid, ApiError, today, errText, listOut, dialable } from '../api';
import { openPrint } from '../printPreview';
import { ScheduleModal } from './Worklist';
import { can } from '../App';
import { FlagChips, FlagPick, NO_FLAGS, flagBody, flagDraftBad } from '../flags';
import { CourseDialog } from '../courses';
import { Drawer, PageSearchBox, Avatar, Chip, Floating, Icon, Modal, Segmented, MoneyInput, MoreMenu, Num, Skeleton, cleanMoney, money, toast, fmtDate, toPaise, ask, Empty, Filter, usePageSearch } from '../ui';
import { useTemplates, norm } from '../templates';
import { chime, makeOnceWatcher } from '../chime';
import { JourneyPanel, StageStrip } from './frontDeskJourney';
import { DaySchedule } from './frontDeskSchedule';
import { ProcedureDrawer } from '../procDrawer';
import { DataTable, filterValue, type Col, type FilterDef } from '../table';
import { BookForm } from './Booking';
import { AppointmentDrawer } from '../apptDrawer';
import { enabledVitals, vitalProblem } from '../vitals';
import { TakePayment, moneyErr } from '../takePayment';
import { printReceipt, RefundDialog } from '../invoices';
import { ReportDialog, type Order } from './TestReports';



type Ctx = { me: any; perms: string[]; cfg: any };
const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
const minsSince = (iso: string) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
const shiftDay = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

type Tab = 'now' | 'intake' | 'waiting' |'scheduled' | 'doctor' | 'checkout' | 'reports' | 'completed' | 'all' | 'needs' | 'history';

/** Download rows as CSV (opens in Excel). Values are quoted; a BOM keeps Telugu/Hindi names intact. */
function downloadCsv(filename: string, rows: (string | number | null | undefined)[][]) {
  const csv = rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url);
}

/** The desk's dashboard: the same day as a Calendar (by the hour, with who is waiting beside it) or as a List (by stage).
 *  One toolbar on top, the same in both views: the view, the search, History. */
export function FrontDesk() {
  const { perms, cfg, me } = useOutletContext<Ctx>();
  const nav = useNavigate();
  const day = today(); const isToday = true;
  const q = useQuery({ queryKey: ['frontdesk', day], queryFn: () => get(`/frontdesk?day=${day}`), refetchInterval: isToday ? 5000 : false });
  const calq = useQuery({ queryKey: ['calendar', day, 'all'], queryFn: () => get(`/calendar?day=${day}`), refetchInterval: 15000 }); // the same as the calendar's: this hour's procedures for the Action panel
  const [procOpen, setProcOpen] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(can(perms, 'visit.write') ? 'now' : 'waiting');
  const [pickV, setPickV] = useState<string | null>(null); // the patient whose journey is open; null = the first that needs the desk, '' = closed
  const [sel, setSel] = useState<Set<string> | null>(null); // bulk: the ticked rows on Waiting or Not here yet; null when not selecting
  useEffect(() => setSel(null), [tab]);
  const [docFilter, setDocFilter] = useState<string | null>(null); // one doctor's queue, or everyone
  // Table or Schedule: the same day two ways; the desk's last choice is kept on this computer
  const [view, setViewS] = useState<'table' | 'schedule'>(() => { try { return localStorage.getItem('fd.view') === 'table' ? 'table' : 'schedule'; } catch { return 'schedule'; } });
  const setView = (v: 'table' | 'schedule') => { setViewS(v); try { localStorage.setItem('fd.view', v); } catch { /* storage blocked */ } };
  const [booking, setBooking] = useState<any>(null); // a free window clicked on the schedule
  const [apptId, setApptId] = useState<string | null>(null); // a no-show opened from the schedule
  const [arriveKey, setArriveKey] = useState(0);
  const [arrive, setArrive] = useState<null | { patientId?: string; appointmentId?: string; name?: string; reports?: { encounterId: string; tests: string; free: boolean; since: string } }>(null);
  const [find] = usePageSearch('Find a patient: name, phone, token or P-number', tab !== 'history'); // filters every tab
  const [collecting, setCollecting] = useState<any>(null); // the visit whose dues are being taken
  const [moving, setMoving] = useState<any>(null); // the waiting visit whose doctor is being changed
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [sp, setSp] = useSearchParams();
  useEffect(() => { if (sp.get('arrive')) { setArrive({}); setSp({}, { replace: true }); } }, [sp]);
  const refresh = () => { ['frontdesk', 'queue', 'calendar'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); };
  const upVisit = useMutation({ mutationFn: ({ id, ...b }: any) => patch(`/visits/${id}`, b), onSuccess: refresh });
  const upAppt = useMutation({ mutationFn: ({ id, ...b }: any) => patch(`/appointments/${id}`, b), onSuccess: refresh, onError: (e) => toast(errText(e), 'err') });
  // one tap, then a few seconds to take it back: the status simply goes back to what it was
  const markLeft = (v: any) => upVisit.mutate({ id: v.id, status: 'left' }, { onSuccess: () => toast(`${v.patient.fullName} (${v.opNumber}) marked as left`, 'info', { label: 'Undo', run: () => upVisit.mutate({ id: v.id, status: v.status }, { onError: (e) => toast(errText(e), 'err') }) }), onError: (e) => toast(errText(e), 'err') });
  const markNoShow = (a: any) => upAppt.mutate({ id: a.id, status: 'no_show' }, { onSuccess: () => toast(`${a.patient.fullName} marked no-show`, 'info', { label: 'Undo', run: () => upAppt.mutate({ id: a.id, status: a.status }) }) });
  // end of the day: everyone who did not turn up, or walked out, in one go; each one can still be undone on its own
  const bulk = useMutation({
    mutationFn: async ({ ids, kind }: { ids: string[]; kind: 'noshow' | 'left' }) => { for (const id of ids) await (kind === 'noshow' ? patch(`/appointments/${id}`, { status: 'no_show' }) : patch(`/visits/${id}`, { status: 'left' })); return ids.length; },
    onSuccess: (n, { kind }) => { refresh(); setSel(null); toast(kind === 'noshow' ? `${n} marked no-show` : `${n} marked as left`); },
    onError: (e) => { refresh(); toast(errText(e), 'err'); },
  });
  const toggleSel = (id: string) => setSel((cur) => { const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const pick = (id: string) => sel && <input type="checkbox" className="h-4 w-4 accent-ink" aria-label="Select" checked={sel.has(id)} onChange={() => toggleSel(id)} />;
  const bulkAsk = async () => {
    if (!sel?.size) return; const n = sel.size; const kind = tab === 'scheduled' ? 'noshow' : 'left';
    const r = await ask({ title: kind === 'noshow' ? `Mark ${n} as no-show?` : `Mark ${n} as left?`, body: kind === 'noshow' ? 'They did not arrive for the booking today. Each one can be undone from the booking, and rebooked from Completed.' : 'They left before seeing the doctor. Any fee paid shows under Completed for a refund.', confirmLabel: kind === 'noshow' ? 'Mark no-show' : 'Mark as left', tone: 'danger' });
    if (r) bulk.mutate({ ids: [...sel], kind });
  };
  // Back with reports within the clinic's free days: no form, no fee. Check in and send straight in; the doctor sees "back with reports" and opens the same consultation.
  // Past the free days the usual check-in (with the fee) opens instead.
  const freeDays = Number(cfg?.tenant?.settings?.reports?.freeDays ?? 30);
  const backIn = useMutation({
    mutationFn: async (x: any) => {
      const code = (cfg?.feeCategories ?? []).find((c: any) => c.code === 'REN')?.code ?? cfg?.feeCategories?.[0]?.code;
      const v: any = await post('/visits', { patientId: x.patientId, feeCategoryCode: code, details: { reportsEncounterId: x.reports.encounterId, complaint: `Back with reports: ${x.reports.tests}` }, idempotencyKey: uuid() });
      try { await patch(`/visits/${v.id}`, { status: 'in_consult' }); return { v, sent: true, e: null as any }; } catch (e) { return { v, sent: false, e: e as any }; }
    },
    onSuccess: (r, x: any) => { refresh(); toast(r.sent ? `${x.name} sent in for the report review · token ${r.v.opNumber}` : `${x.name} checked in · token ${r.v.opNumber}. ${r.e?.body?.code === 'ROOM_FULL' ? 'The room is full: send in when someone comes out.' : errText(r.e)}`, r.sent ? 'ok' : 'info'); },
    onError: (e: any) => toast(e?.body?.code === 'ALREADY_CHECKED_IN' ? `Already checked in today as token ${e.body.opNumber}` : errText(e), 'err'),
  });
  const reportsBack = (x: any) => { if (x.reports?.free) backIn.mutate(x); else setArrive(x); };
  const openEncounter = useMutation({ mutationFn: (visitId: string) => post(`/visits/${visitId}/encounter`), onSuccess: (e: any) => nav(`/encounter/${e.id}`, { viewTransition: true }) });
  const d = q.data;
  const isClinical = can(perms, 'encounter.intake'); const canDesk = can(perms, 'visit.write');
  const landed = useRef(false);
  const f = find.trim().toLowerCase(); const fDigits = /^[\d\s]+$/.test(f) ? f.replace(/\s/g, '') : '';
  const match = (p: any, extra = '') => !f || (p?.fullName ?? '').toLowerCase().includes(f) || (!!fDigits && (p?.phone ?? '').includes(fDigits)) || (p?.patientNo ?? '').toLowerCase().includes(f) || (extra ?? '').toLowerCase().includes(f);

  const visitsAll: any[] = d?.visits ?? [];
  const forDoc = (id: string | null | undefined) => !docFilter || (docFilter === '__none' ? !id : id === docFilter); // the Doctor column's filter, on every list
  const visits: any[] = visitsAll.filter((v) => forDoc(v.practitionerId));
  const scheduled: any[] = (d?.appointments ?? []).filter((a: any) => ['booked', 'confirmed'].includes(a.status) && forDoc(a.window?.practitionerId) && match(a.patient));
  const noShows: any[] = (d?.appointments ?? []).filter((a: any) => a.status === 'no_show' && forDoc(a.window?.practitionerId) && match(a.patient));
  const waiting = visits.filter((v) => ['waiting', 'intake', 'screened'].includes(v.status) && match(v.patient, v.opNumber));
  const screening: 'off' | 'first' | 'required' = cfg?.tenant?.settings?.screening ?? 'off';
  const isDoctorUser = can(perms, 'encounter.complete'); const isJunior = isClinical && !isDoctorUser;
  const reportsQ = useQuery({ queryKey: ['orders'], queryFn: () => get('/orders'), refetchInterval: 30000, enabled: can(perms, 'document.read') });
  const reportsOpen: any[] = ((reportsQ.data?.orders ?? []) as any[]).filter((o) => o.state !== 'closed' && match(o.patient) && (!docFilter || o.doctor === (d?.doctors ?? []).find((x: any) => x.id === docFilter)?.name));
  // the doctor pulled someone in: the desk hears it once
  const called = useRef(makeOnceWatcher<string>()); const [calling, setCalling] = useState<any[]>([]);
  useEffect(() => {
    const byDoc = visits.filter((v) => v.status === 'in_consult' && v.details?.calledBy === 'doctor' && v.details?.calledAt && Date.now() - new Date(v.details.calledAt).getTime() < 10 * 60_000);
    called.current(byDoc.map((v) => v.id), (fresh) => { if (!canDesk) return; chime('call'); setCalling(byDoc.filter((v) => fresh.includes(v.id))); setTimeout(() => setCalling([]), 45_000); });
  }, [visits]);
  const inConsult = visits.filter((v) => v.status === 'in_consult' && match(v.patient, v.opNumber));
  const completed = visits.filter((v) => ['done', 'left'].includes(v.status) && match(v.patient, v.opNumber)).sort((a, b) => (b.completedAt ?? b.arrivedAt).localeCompare(a.completedAt ?? a.arrivedAt));
  const late = scheduled.filter((a) => isToday && toMin(a.window.endTime) < nowMin());
  // finished with the doctor, but the plan still needs the desk: schedule the procedure, hand over the lab slip, book the review. Leaves the moment nothing is open.
  const checkout = visits.filter((v) => v.status === 'done' && !visitClosed(v) && (v.recommendations ?? []).some((r: any) => r.status === 'open') && match(v.patient, v.opNumber));
  const withDue = visits.filter((v) => v.due.length && match(v.patient, v.opNumber));
  const needsCount = late.length + withDue.length;
  useEffect(() => { if (d && !landed.current) { landed.current = true; if (!canDesk && !waiting.length && scheduled.length) setTab('scheduled'); } }, [d]);
  // Next for you: only what needs the desk, in the order to do it
  const roomFull = (v: any) => visitsAll.filter((x) => x.status === 'in_consult' && (!v.practitionerId || !x.practitionerId || x.practitionerId === v.practitionerId)).length >= ROOM_MAX;
  const canSend = (v: any) => v.status === 'intake' ? { ok: false, why: 'With the junior doctor right now' } : screening === 'required' && v.status === 'waiting' ? { ok: false, why: 'Screening first: the junior doctor sees them before the doctor' } : roomFull(v) ? { ok: false, why: `Room full: it takes ${ROOM_MAX}. Send the next one in when someone comes out.` } : { ok: !upVisit.isPending, why: 'Send the patient in to the doctor' };
  const intake = waiting.filter((v) => v.status === 'intake');
  const sendable = waiting.filter((v) => v.status !== 'intake' && !(screening === 'required' && v.status === 'waiting'));
  const reportsIn = reportsOpen.filter((o) => ['ready', 'partial', 'reviewed', 'doctor_call'].includes(o.state) && !visitsAll.some((v) => v.details?.reportsEncounterId === o.encounterId && ['waiting', 'intake', 'screened', 'in_consult'].includes(v.status)));
  const reportsLate = reportsOpen.filter((o) => o.state === 'pending' && o.late?.length);
  const idle = [...intake.map((v) => ({ v, label: 'With junior' })), ...waiting.filter((v) => v.status === 'waiting' && screening === 'required').map((v) => ({ v, label: 'For screening' })), ...inConsult.map((v) => ({ v, label: `With doctor${v.details?.calledAt ? ` ${minsSince(v.details.calledAt)} min` : ''}` }))];
  /** 8 min, 1 h 20 m: how long someone has waited */
  const waitText = (m: number) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} m`);
  const nowCount =sendable.length + checkout.length + reportsIn.length + reportsLate.length + late.length + withDue.length;
  const selV = canDesk && tab !== 'history' ? visitsAll.find((v) => v.id === pickV) ?? null : null; // the journey drawer opens on a tap, never by itself
  const longest = waiting.length ? Math.max(...waiting.map((v) => minsSince(v.arrivedAt))) : 0;
  const dayLabel = new Date(day + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
  const active = (v: any) => ['waiting', 'intake', 'screened', 'in_consult'].includes(v.status);
  const unpicked = visitsAll.filter((v) => !v.practitionerId && ['waiting', 'intake', 'screened'].includes(v.status)).length;
  // the count is who is still to be seen: here and not done, or booked and not yet arrived
  const toSee = (id: string) => visitsAll.filter((v) => v.practitionerId === id && active(v)).length + (d?.appointments ?? []).filter((a: any) => ['booked', 'confirmed'].includes(a.status) && a.window?.practitionerId === id).length;
  const docOptions: { value: string; label: string; count?: number }[] = (d?.doctors ?? []).length > 1 ? [{ value: 'all', label: 'Doctor' },
    ...(d?.doctors ?? []).map((x: any) => ({ value: x.id as string, label: x.name as string, count: toSee(x.id) })),
    ...(unpicked || docFilter === '__none' ? [{ value: '__none', label: 'No doctor picked', count: unpicked }] : [])] : [];
  const docName = (id: string | null) => cfg?.practitioners.find((p: any) => p.id === id)?.name ?? '—';
  const tabs: [Tab, string, number][] = [['waiting', 'Waiting', waiting.length], ['scheduled', 'Not here yet', scheduled.length], ['doctor', 'With doctor', inConsult.length], ['checkout', 'Checkout', checkout.length], ['reports', 'Reports pending', reportsOpen.length], ['completed', 'Completed', completed.length + noShows.length], ['all', 'All', visits.length + scheduled.length + noShows.length], ['needs', 'Needs you', needsCount], ['history', 'History', -1]];

  type Row = { type: 'waiting' | 'doctor' | 'appt' | 'noshow' | 'done'; v?: any; a?: any; i?: number };
  // the junior's list: who still needs screening first, the screened ones at the bottom (still editable until the doctor finishes)
  const W = { group: 'Waiting · in order', rows: (isJunior ? [...waiting.filter((v) => v.status !== 'screened'), ...waiting.filter((v) => v.status === 'screened')] : waiting).map((v, i): Row => ({ type: 'waiting', v, i })) };
  const S = { group: 'Scheduled · not yet arrived', rows: scheduled.map((a): Row => ({ type: 'appt', a })) };
  const D = { group: 'With the doctor', rows: inConsult.map((v): Row => ({ type: 'doctor', v })) };
  const C = { group: 'Completed · newest first', rows: [...completed.map((v): Row => ({ type: 'done', v })), ...noShows.map((a): Row => ({ type: 'noshow', a }))] };
  const N = { group: 'To do', rows: [...late.map((a): Row => ({ type: 'appt', a })), ...withDue.map((v): Row => ({ type: 'done', v }))] };
  const I = { group: 'With the junior doctor', rows: W.rows.filter((r) => r.v.status === 'intake') };
  const groups = ({ now: [], intake: [I], waiting: [W], scheduled: [S], doctor: [D], completed: [C], needs: [N], checkout: [], reports: [], all: [W, D, S, C], history: [] } as Record<Tab, { group: string; rows: Row[] }[]>)[tab].filter((g) => g.rows.length);
  const emptyText: Record<Tab, string> = { now: '', intake: 'Nobody with the junior doctor', waiting: 'Nobody waiting', scheduled: 'Everyone booked has arrived', doctor: 'Consultation room is free', completed: 'Nothing completed yet', checkout: 'Nothing pending after the doctor', reports: 'No reports are being waited for', all: 'Nothing on this day', needs: 'All clear', history: '' };

  const who = (p: any, vid?: string) => <>{vid && canDesk ? <button type="button" className="text-[14px] font-bold hover:underline" title="Show the journey" onClick={() => setPickV(vid)}>{p.fullName}</button> : <b className="text-[14px]">{p.fullName}</b>}<FlagChips flags={p.flags} /><span className="text-muted">{[p.ageYears, p.sex].filter(Boolean).join(' ')}</span></>;
  const meta = (xs: (string | null | undefined | false)[]) => xs.filter(Boolean).join(' · ');
  const Row = ({ token, tokenCls = '', top, sub, actions, cls = '' }: { token: React.ReactNode; tokenCls?: string; top: React.ReactNode; sub: React.ReactNode; actions: React.ReactNode; cls?: string }) => (
    <div className={`flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-line/70 px-5 py-3.5 first:border-t-0 hover:bg-surface-2 anim-fade-up ${cls}`}>
      <span className={`w-[76px] shrink-0 text-[16px] font-bold tracking-tight ${tokenCls}`}>{token}</span>
      <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-x-2 gap-y-1">{top}</div><div className="mt-0.5 text-[12px] text-muted">{sub}</div></div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">{actions}</div>
    </div>);
  // Next for each doctor: the first in the line who can go in now
  const nextIds = new Set<string>(); { const seen = new Set<string>(); for (const v of visitsAll) if (['waiting', 'screened'].includes(v.status) && !(screening === 'required' && v.status === 'waiting') && !seen.has(v.practitionerId ?? '')) { seen.add(v.practitionerId ?? ''); nextIds.add(v.id); } }
  const sendIn = (v: any) => upVisit.mutate({ id: v.id, status: 'in_consult' }, { onSuccess: () => toast(`${v.patient.fullName} (${v.opNumber}) sent in`, 'info', { label: 'Undo', run: () => upVisit.mutate({ id: v.id, status: v.status }) }), onError: (e) => toast(errText(e), 'err') });
  const toJunior = (v: any) => upVisit.mutate({ id: v.id, status: 'intake' }, { onSuccess: () => toast(`${v.patient.fullName} (${v.opNumber}) sent to the junior doctor`, 'info', { label: 'Undo', run: () => upVisit.mutate({ id: v.id, status: v.status }) }), onError: (e) => toast(errText(e), 'err') });
  const onSchedule = canDesk && tab !== 'history'; // the desk always has the calendar and the rail; List only swaps the grid for rows
  // One Action panel (v62): what the desk does next, in one card. Send in (one filled button: the first who can go in),
  // this hour's procedures, patients back with reports, tests and procedures advised, money to collect.
  const many = (d?.doctors ?? []).length > 1;
  const firstNext = waiting.find((v) => nextIds.has(v.id))?.id;
  const procsNow = ((calq.data?.procedures ?? []) as any[]).filter((p) => p.state === 'in_progress' || (p.state === 'confirmed' && Math.abs(toMin(p.startTime) - nowMin()) <= 60))
    .filter((p) => !f || norm(p.patient ?? '').includes(norm(f))).sort((x, y) => x.startTime.localeCompare(y.startTime));
  const head = (t: string, n?: number) => <div className="border-t border-line px-4 pb-1.5 pt-3 text-[12.5px] font-semibold text-muted first:border-t-0">{t}{n ? ` · ${n}` : ''}</div>;
  const waitingPanel = (
    <aside className="flex flex-col gap-4">
      <section className="fd-sheet overflow-hidden">
        <div className="px-4 pb-1 pt-3.5"><b className="text-[15px]">Action</b></div>
        {head('Send in', waiting.length)}
        {waiting.length === 0 && <div className="px-4 pb-3 text-[13px] text-muted">{f ? 'Nobody waiting matches the search.' : 'Nobody waiting.'}</div>}
        {waiting.map((v) => { const s = canSend(v); const jr = v.status === 'intake'; const screened = v.status === 'screened'; const due = dueOf(v); return (
          <div key={v.id} className={`flex items-center gap-2 border-t border-line px-3 py-2.5 ${selV?.id === v.id ? 'bg-surface-2' : ''}`}>
            <button type="button" className="flex min-w-0 flex-1 items-center gap-2.5 text-left" title="Show the journey" onClick={() => setPickV(v.id)}>
              <span className="grid h-7 min-w-7 shrink-0 place-items-center rounded-[6px] bg-paper-2 px-1.5 text-[12.5px] font-semibold">{v.opNumber}</span>
              <span className="min-w-0"><span className="block truncate text-[14px] font-medium">{v.patient.fullName}</span><span className="block truncate text-[12px] text-muted">{meta([many ? v.doctor ?? 'no doctor' : null, jr ? 'with the junior doctor' : screened ? 'screened' : waitText(minsSince(v.arrivedAt)), due ? `${money(due)} due` : null])}</span></span>
            </button>
            {!jr && <button className={`btn btn-sm shrink-0 ${v.id === firstNext ? 'btn-primary' : ''}`} disabled={!s.ok} title={s.why} onClick={() => sendIn(v)}>Send in</button>}
            {!jr && !screened && <MoreMenu items={[{ label: 'Send to the junior doctor', onClick: () => toJunior(v) }]} />}
          </div>); })}
        {procsNow.length > 0 && <>{head('Procedures this hour', procsNow.length)}
          {procsNow.map((p) => (
            <div key={p.id} className="flex items-center gap-2 border-t border-line px-3 py-2.5" style={{ boxShadow: 'inset 3px 0 0 var(--fd-proc)' }}>
              <Icon name="syringe" className="fd-proc-ic h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1"><span className="block truncate text-[14px] font-medium">{p.patient}</span><span className="block truncate text-[12px] text-muted">{[p.procedure, p.startTime, p.room].filter(Boolean).join(' · ')}</span></span>
              {p.state === 'in_progress' ? <Chip>in progress</Chip> : <button type="button" className="btn btn-sm shrink-0" title="Open the session: consent, then start" onClick={() => setProcOpen(p.id)}>Start</button>}
            </div>))}</>}
        {reportsIn.length > 0 && <>{head('Check in · back with reports', reportsIn.length)}
          {reportsIn.map((o) => (
            <div key={o.encounterId} className="flex items-center gap-2 border-t border-line px-3 py-2.5"><span className="min-w-0 flex-1"><span className="block truncate text-[14px] font-medium">{o.patient.fullName}</span><span className="block truncate text-[12px] text-muted">{o.tests.map((t: any) => t.name).join(', ')}</span></span>
              <button type="button" className="btn btn-sm shrink-0" disabled={backIn.isPending} title="The patient is back with the reports" onClick={() => reportsBack({ patientId: o.patient.id, name: o.patient.fullName, reports: { encounterId: o.encounterId, tests: o.tests.map((t: any) => t.name).join(', '), free: Math.floor((Date.now() - new Date(o.orderedAt).getTime()) / 86400000) <= freeDays, since: o.orderedAt } })}>Check in</button></div>))}</>}
        {checkout.length > 0 && <>{head('Tests & procedures advised', checkout.length)}
          {checkout.map((v) => { const open = (v.recommendations ?? []).filter((r: any) => r.status === 'open'); const t = open.filter((r: any) => r.kind === 'investigation'); const pr = open.filter((r: any) => r.kind === 'procedure'); return (
            <button key={v.id} type="button" className={`flex w-full items-center gap-2 border-t border-line px-3 py-2.5 text-left hover:bg-surface-2 ${selV?.id === v.id ? 'bg-surface-2' : ''}`} onClick={() => setPickV(v.id)}>
              <span className="fd-warn">!</span><span className="min-w-0"><span className="block truncate text-[14px] font-medium">{v.patient.fullName}</span>
                <span className="block truncate text-[12px] text-muted">{[t.length && `Tests: ${t.map((r: any) => r.notes).filter(Boolean).join(', ') || t.length}`, pr.length && `Procedure: ${pr.map((r: any) => r.procedure ?? 'procedure').join(', ')}`, open.some((r: any) => r.kind === 'followup') && 'Review to book'].filter(Boolean).join(' · ')}</span></span></button>); })}</>}
        {withDue.length > 0 && <>{head('To collect', withDue.length)}
          {withDue.map((v) => (
            <div key={v.id} className="flex items-center gap-2 border-t border-line px-3 py-2.5"><span className="min-w-0 flex-1 truncate text-[14px] font-medium">{v.patient.fullName}</span>
              <button type="button" className="btn btn-sm shrink-0" onClick={() => setCollecting(v)}>Collect {money(dueOf(v))}</button></div>))}</>}
      </section>
      {procOpen && <ProcedureDrawer key={procOpen} id={procOpen} canAct={can(perms, 'worklist.write')} onClose={() => { setProcOpen(null); refresh(); }} />}
    </aside>);
  const render = (r: Row) => {
    if (r.type === 'waiting') { const v = r.v; const i = r.i!; const withJr = v.status === 'intake'; const needsJr = screening === 'required' && v.status === 'waiting';
      const inside = visitsAll.filter((x) => x.status === 'in_consult' && (!v.practitionerId || !x.practitionerId || x.practitionerId === v.practitionerId)).length; const full = inside >= ROOM_MAX; return (
      <Row key={v.id} token={<span className="flex items-center gap-2">{pick(v.id)}{v.opNumber}</span>} tokenCls={`${i === 0 && !withJr ? 'text-clay' : ''} ${sel ? '!w-[108px]' : ''}`}
        top={<>{who(v.patient, v.id)}{withJr ? <Chip tone="sky">with junior</Chip> : v.details?.reportsEncounterId ? <Chip tone="amber">back with reports</Chip> : v.status === 'screened' ? <Chip tone="sage">screened</Chip> : v.priority > 0 ? <Chip tone="amber">priority</Chip> : i === 0 ? <Chip tone="clay">next</Chip> : null}{v.doctor ? <Chip>{v.doctor}</Chip> : <Chip tone="rose">no doctor</Chip>}</>}
        sub={meta([v.patient.patientNo, v.patient.phone, `arrived ${hhmm(v.arrivedAt)} · waited ${minsSince(v.arrivedAt)} min`, v.category, v.details?.complaint, v.details?.weight_kg && `${v.details.weight_kg} kg`, v.details?.bp && `BP ${v.details.bp}`])}
        actions={<>
          {isJunior && ['waiting', 'intake', 'screened'].includes(v.status) && <button className={`btn btn-sm ${v.status === 'screened' ? '' : 'btn-primary'}`} onClick={() => openEncounter.mutate(v.id)}>{v.status === 'intake' ? 'Open' : v.status === 'screened' ? 'Edit' : 'Intake'}</button>}
          {isDoctorUser && <button className="btn btn-sm" disabled={withJr} title={withJr ? 'With the junior doctor right now' : 'Open the consultation yourself; the desk is told'} onClick={() => openEncounter.mutate(v.id)}>Open</button>}
          {canDesk && <button className="btn btn-sm btn-primary" disabled={withJr || needsJr || full || upVisit.isPending} title={withJr ? 'With the junior doctor right now' : needsJr ? 'Screening first: the junior doctor sees them before the doctor' : full ? `${inside} already inside: the room takes ${ROOM_MAX}. Send the next one in when someone comes out.` : 'Send the patient in to the doctor'} onClick={() => upVisit.mutate({ id: v.id, status: 'in_consult' })}>{full ? 'Room full' : 'Send in'}</button>}
          {canDesk && <MoreMenu items={[{ label: 'Profile', onClick: () => nav(`/patients/${v.patient.id}`) }, { label: 'Move up', hidden: i === 0, onClick: () => upVisit.mutate({ id: v.id, afterVisitId: i >= 2 ? waiting[i - 2].id : null }) }, { label: 'Change doctor', hidden: !(d?.doctors ?? []).length, onClick: () => setMoving(v) }, { label: 'Left without consultation', danger: true, onClick: () => markLeft(v) }]} />}
        </>} />); }
    if (r.type === 'doctor') { const v = r.v; return (
      <Row key={v.id} token={v.opNumber}
        top={<>{who(v.patient, v.id)}<Chip tone={v.details?.doctorOpenedAt || v.details?.calledBy !== 'desk' ? 'sage' : 'amber'}><span className={`mr-1 inline-block h-1.5 w-1.5 rounded-full ${v.details?.doctorOpenedAt || v.details?.calledBy !== 'desk' ? 'bg-sage breathe' : 'bg-amber'}`} />{v.details?.doctorOpenedAt || v.details?.calledBy !== 'desk' ? 'with the doctor' : 'inside · waiting'}</Chip>{v.doctor && <Chip>{v.doctor}</Chip>}</>}
        sub={meta([v.patient.patientNo, v.details?.calledAt && `${v.details.calledBy === 'desk' ? 'sent in' : 'called by doctor'} ${hhmm(v.details.calledAt)}`, v.details?.complaint])}
        actions={<>{isClinical && <button className="btn btn-sm" onClick={() => openEncounter.mutate(v.id)}>Open</button>}{canDesk && <MoreMenu items={[{ label: 'Profile', onClick: () => nav(`/patients/${v.patient.id}`) }]} />}</>} />); }
    if (r.type === 'appt') { const a = r.a; const isLate = isToday && toMin(a.window.endTime) < nowMin(); return (
      <Row key={a.id} token={<span className="flex items-center gap-2">{pick(a.id)}{a.window.startTime}</span>} tokenCls={`${isLate ? 'text-rose' : ''} ${sel ? '!w-[108px]' : ''}`} cls={isLate ? 'bg-rose-soft/30' : ''}
        top={<>{who(a.patient)}{isLate ? <Chip tone="rose">not arrived</Chip> : a.status === 'confirmed' ? <Chip tone="sage">confirmed</Chip> : <Chip>booked</Chip>}<Chip>{docName(a.window.practitionerId)}</Chip></>}
        sub={meta([a.patient.patientNo, a.patient.phone, a.patient.locality, a.service, a.note])}
        actions={<>{canDesk && isToday && <button className="btn btn-sm btn-primary" onClick={() => setArrive({ patientId: a.patientId, appointmentId: a.id, name: a.patient.fullName })}>Check in</button>}{canDesk && <MoreMenu items={[{ label: 'Mark no-show', danger: true, onClick: () => markNoShow(a) }]} />}</>} />); }
    if (r.type === 'noshow') { const a = r.a; return (
      <Row key={a.id} token={a.window.startTime} cls="opacity-70"
        top={<>{who(a.patient)}<Chip tone="rose">no-show</Chip><Chip>{docName(a.window.practitionerId)}</Chip></>}
        sub={meta([a.patient.phone, 'did not arrive'])}
        actions={canDesk && <button className="btn btn-sm" onClick={() => nav(`/dashboard?book=1&patient=${a.patientId}&pname=${encodeURIComponent(a.patient.fullName)}`)}>Rebook</button>} />); }
    const v = r.v; const due = dueOf(v); const handled = !!v.details?.explainedAt; const left = v.status === 'left';
    return (
      <Row key={v.id} token={v.opNumber} cls={due ? 'bg-rose-soft/30' : handled || left ? 'opacity-70' : ''}
        top={<>{who(v.patient, v.id)}{due ? <Chip tone="rose">{money(due)} due</Chip> : left ? <Chip>left</Chip> : v.encounterStatus === 'awaiting_reports' ? <Chip tone="amber">held for reports</Chip> : <Chip tone="sage">completed</Chip>}{v.doctor && <Chip>{v.doctor}</Chip>}
          {!left && (v.recommendations ?? []).some((rc: any) => rc.status === 'open') && <span className="fd-warn" title="Tests or procedures pending">!</span>}</>}
        sub={meta([v.patient.patientNo, v.patient.phone, left ? `left · arrived ${hhmm(v.arrivedAt)}` : v.completedAt ? `finished ${hhmm(v.completedAt)}` : null, left ? 'did not see the doctor' : v.rxCount ? `${v.rxCount} medicine${v.rxCount === 1 ? '' : 's'} · pharmacy has the Rx` : v.recommendations.length ? null : 'no tests or procedures'])}
        actions={<>
          {canDesk && v.due[0] && <button className="btn btn-sm btn-primary" disabled={!!collecting} onClick={() => setCollecting(v)}>Collect {money(due)}</button>}
          {canDesk && !left && !handled && !v.due.length && v.recommendations.length > 0 && <button className="btn btn-sm btn-primary" onClick={() => upVisit.mutate({ id: v.id, details: { explainedAt: new Date().toISOString() } })}><Icon name="check" className="h-3.5 w-3.5" />Explained</button>}
          {v.encounterId && !left && <button className="btn btn-sm" onClick={() => openPrint({ title: 'Prescription', rx: v.encounterId })}><Icon name="print" className="h-3.5 w-3.5" />Rx</button>}
          <MoreMenu items={[
            { label: 'View profile', onClick: () => nav(`/patients/${v.patient.id}`) },
            { label: 'Mark as explained', hidden: !(canDesk && !left && !handled && v.recommendations.length > 0 && v.due.length > 0), onClick: () => upVisit.mutate({ id: v.id, details: { explainedAt: new Date().toISOString() } }) },
            
          ]} />
        </>} />);
  };

  return (
    <div className="fd flex min-h-0 flex-1 flex-col">
      <h1 className="sr-only">Calendar</h1>
      {tab !== 'history' && !onSchedule && <div className="mb-3 flex flex-wrap items-center gap-2.5 no-print">
        {canDesk && <Segmented<'schedule' | 'table'> size="sm" value={view} onChange={setView} options={[{ value: 'schedule', label: 'Calendar' }, { value: 'table', label: 'List' }]} />}
        <span className="ml-auto" />
        <PageSearchBox placeholder="Find a patient: name, phone, token or P-number" className="!h-9 w-[280px] max-w-full" />
        {canDesk && <button type="button" className="btn btn-sm" title="Past days: who came, who left, who did not come" onClick={() => setTab('history')}><Icon name="clock" className="h-3.5 w-3.5" />History</button>}
      </div>}
      {tab === 'history' && <div className="anim-fade-up mb-4 flex flex-wrap items-center gap-2 no-print"><button className="btn" onClick={() => setTab(canDesk ? 'now' : 'waiting')}><Icon name="chevL" className="h-4 w-4" />Back to today</button><div ref={setSlot} className="flex flex-wrap items-center gap-2" /></div>}
      {canDesk && arrive && <ArrivalSheet key={`${arriveKey}:${arrive.patientId ?? ''}:${arrive.appointmentId ?? ''}:${arrive.reports?.encounterId ?? ''}`} init={arrive} cfg={cfg} perms={perms} todayAppts={scheduled} waitingByDoctor={Object.fromEntries((d?.doctors ?? []).map((x: any) => [x.id, visitsAll.filter((v) => ['waiting', 'intake', 'screened'].includes(v.status) && v.practitionerId === x.id).length]))} onClose={() => { setArrive(null); setArriveKey((k) => k + 1); refresh(); }} />}

      {calling.length > 0 && <div role="alert" className="mb-3 flex flex-wrap items-center gap-3 rounded-[12px] border border-line-2 bg-paper-2 px-4 py-3 text-[14px] anim-fade-up"><Icon name="bell" className="h-5 w-5 text-clay" />{calling.map((v) => <span key={v.id}><b>{v.doctor ?? 'The doctor'}</b> is calling <b>{v.patient.fullName}</b> · token {v.opNumber}</span>)}<button className="btn btn-sm ml-auto" onClick={() => setCalling([])}>Sent</button></div>}
      {!d ? (q.isError ? <div role="alert" className="fd-sheet flex flex-wrap items-center justify-center gap-3 py-10 text-[14px]"><span>Couldn't load the queue. {errText(q.error)}</span><button className="btn btn-sm btn-primary" disabled={q.isFetching} onClick={() => q.refetch()}>Retry</button></div> : <Skeleton rows={3} />) : (
        <div>
          <div className="min-w-0">
            {tab !== 'history' && !onSchedule && <StageStrip tab={tab} onTab={setTab}
              items={(canDesk
                // the desk's three: what to do, who is waiting, who has not come; the rest is on the Schedule board
                ? [['now', 'To do', nowCount, nowCount > 0], ['waiting', 'Waiting', waiting.length, false, d && waiting.length > 0 && <span className={longest >= 30 ? 'text-amber' : ''} title="The patient who has waited longest since arriving">longest {waitText(longest)}</span>], ['scheduled', 'Not here yet', scheduled.length, false]]
                : [['waiting', 'Waiting', waiting.length, false, d && waiting.length > 0 && <span className={longest >= 30 ? 'text-amber' : ''} title="The patient who has waited longest since arriving">longest {waitText(longest)}</span>], ...(screening !== 'off' || intake.length ? [['intake', 'Initial screening', intake.length, false]] : []), ['doctor', 'With doctor', inConsult.length, false], ['checkout', 'Pending tests', checkout.length, false], ['reports', 'Reports awaited', reportsOpen.length, false], ['completed', 'Done', completed.length + noShows.length, false], ['all', 'All', visits.length + scheduled.length + noShows.length, false]]) as [Tab, string, number, boolean, React.ReactNode?][]}
              extra={<>{docFilter && tab !== 'now' && view !== 'schedule' && <span className="fd-chip">{docOptions.find((o) => o.value === docFilter)?.label}<button type="button" aria-label="Show all doctors" onClick={() => setDocFilter(null)}>×</button></span>}
              <span className="fd-day">{dayLabel}</span>
              {canDesk && (tab === 'waiting' || tab === 'scheduled') && (tab === 'waiting' ? waiting : scheduled).length > 0 && <button type="button" className="shrink-0 self-center whitespace-nowrap px-3 py-1.5 text-[13px] font-semibold text-muted hover:text-ink" aria-pressed={!!sel} title={tab === 'scheduled' ? 'Tick several bookings and mark them no-show together; the late ones come pre-ticked' : 'Tick several waiting patients and mark them as left together'} onClick={() => setSel(sel ? null : new Set(tab === 'scheduled' ? late.map((a) => a.id) : []))}>{sel ? 'Done' : 'Select'}</button>}</>} />}
            {sel && <div className="mb-3 flex flex-wrap items-center gap-2 rounded-[12px] bg-ink px-3 py-2 text-[13px] text-paper anim-fade-up" role="toolbar" aria-label="Selected rows">
              <b>{sel.size} selected</b>
              <button type="button" className="rounded-[8px] px-2.5 py-1 font-semibold text-paper/80 hover:bg-paper/10" onClick={() => setSel(new Set((tab === 'waiting' ? waiting.map((v) => v.id) : scheduled.map((a) => a.id))))}>All</button>
              {tab === 'scheduled' && late.length > 0 && <button type="button" className="rounded-[8px] px-2.5 py-1 font-semibold text-paper/80 hover:bg-paper/10" onClick={() => setSel(new Set(late.map((a) => a.id)))}>Late only</button>}
              <button type="button" className="rounded-[8px] px-2.5 py-1 font-semibold text-paper/80 hover:bg-paper/10" onClick={() => setSel(new Set())}>None</button>
              <span className="ml-auto" />
              <button type="button" className="inline-flex h-8 items-center gap-1.5 rounded-[8px] bg-paper px-3 font-semibold text-ink hover:bg-paper-2 disabled:opacity-50" disabled={!sel.size || bulk.isPending} onClick={bulkAsk}>{tab === 'scheduled' ? 'Mark no-show' : 'Mark as left'}{sel.size ? ` · ${sel.size}` : ''}</button>
            </div>}
            {onSchedule ? <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
              <DaySchedule today={day} visitsToday={visitsAll} doctors={d?.doctors ?? []} rooms={(cfg?.rooms ?? []).filter((r: any) => r.active !== false)} selectedId={selV?.id ?? null} nextIds={nextIds}
                kindOf={(v) => v.status === 'left' ? 'noshow' : v.status === 'in_consult' ? 'doctor' : v.status === 'intake' ? 'intake' : v.status === 'done' ? (!visitClosed(v) && (v.recommendations ?? []).some((r: any) => r.status === 'open') ? 'tests' : 'done') : 'waiting'}
                list={view === 'table'} onVisit={setPickV} onOpenAppt={setApptId} onBook={can(perms, 'appointment.write') ? setBooking : undefined} canOverbook={can(perms, 'appointment.overbook')}
                tools={<>{/* Calendar | List swaps only this section; the Action panel beside it stays */}
                  <PageSearchBox placeholder="Find a patient" className="!h-8 w-[180px] max-w-full" />
                  <button type="button" className="btn btn-sm btn-icon !h-8 !w-8" aria-label="History: past days" title="History: past days, who came, who left, who did not come" onClick={() => setTab('history')}><Icon name="clock" className="h-4 w-4" /></button>
                  <span className="inline-flex overflow-hidden rounded-[6px] border border-line-2" role="group" aria-label="Show as">
                    {([['schedule', 'calendar', 'Calendar'], ['table', 'list', 'List']] as const).map(([v, ic, l], i) => <button key={v} type="button" aria-pressed={view === v} aria-label={l} title={l} onClick={() => setView(v)} className={`grid h-8 w-8 place-items-center ${i ? 'border-l border-line-2' : ''} ${view === v ? 'bg-paper-2 text-ink' : 'text-muted hover:text-ink'}`}><Icon name={ic} className="h-4 w-4" /></button>)}
                  </span></>} />
              {waitingPanel}</div>
            : tab === 'checkout' ? <CheckoutList visits={checkout} canDesk={canDesk} canForce={can(perms, 'config.write')} /> : tab === 'reports' ? <ReportsQueue orders={reportsOpen} visits={visits} canDesk={canDesk} freeDays={cfg?.tenant?.settings?.reports?.freeDays ?? 30} onArrive={reportsBack} onSendIn={(id) => upVisit.mutate({ id, status: 'in_consult' })} /> : tab === 'history' ? <HistoryPanel canDesk={canDesk} find={find} slot={slot} onBook={(p?: any) => nav(p ? `/dashboard?book=1&patient=${p.id}&pname=${encodeURIComponent(p.fullName)}` : '/dashboard?book=1')} /> : (
              <div className="fd-sheet overflow-hidden anim-fade-up" style={{ animationDelay: '80ms' }}>
                {groups.length === 0 && <div className="py-10 text-center text-muted">{emptyText[tab]}</div>}
                {groups.map((g) => g.rows.map(render))}
              </div>)}
          </div>
          {collecting && <TakePayment patientId={collecting.patientId} patientName={collecting.patient.fullName} onClose={() => { setCollecting(null); refresh(); }} />}
          {moving && <Modal title="Change doctor" subtitle={`${moving.patient.fullName} · token ${moving.opNumber}`} onClose={() => setMoving(null)} width="max-w-sm">
            <div role="radiogroup" aria-label="Doctor" className="flex flex-col gap-1.5">
              {(d?.doctors ?? []).map((x: any) => { const n = visitsAll.filter((w) => w.practitionerId === x.id && ['waiting', 'intake', 'screened'].includes(w.status)).length; const on = moving.practitionerId === x.id; return (
                <button key={x.id} type="button" role="radio" aria-checked={on} disabled={on || upVisit.isPending} className="flex items-center justify-between rounded-[12px] px-3 py-2.5 text-left text-[14px] font-semibold ring-1 ring-line hover:bg-surface-2 disabled:opacity-60"
                  onClick={() => { const v = moving; upVisit.mutate({ id: v.id, practitionerId: x.id }, { onSuccess: () => { setMoving(null); toast(`${v.patient.fullName} moved to ${x.name}'s queue`, 'info', { label: 'Undo', run: () => upVisit.mutate({ id: v.id, practitionerId: v.practitionerId ?? null }) }); }, onError: (e) => toast(errText(e), 'err') }); }}>
                  <span>{x.name}{on ? ' (now)' : ''}</span><span className="text-[12.5px] font-medium text-muted">{n} waiting</span></button>); })}
            </div></Modal>}
          {booking && <Drawer title="Book" subtitle={`${booking.day === day ? 'Today' : new Date(booking.day + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })} · ${booking.startTime}–${booking.endTime}${(d?.doctors ?? []).find((x: any) => x.id === booking.practitionerId) ? ` · ${(d?.doctors ?? []).find((x: any) => x.id === booking.practitionerId).name}` : ''}`} onClose={() => setBooking(null)} width="max-w-md">
            <BookForm session={booking} arriveEarly={cfg?.tenant?.settings?.scheduling?.arriveEarlyMinutes ?? 30} onDone={() => { qc.invalidateQueries({ queryKey: ['calendar'] }); refresh(); setBooking(null); }} /></Drawer>}
          {apptId && <AppointmentDrawer id={apptId} cfg={cfg} canWrite={can(perms, 'appointment.write')} onArrive={canDesk ? (a) => { setApptId(null); setArrive({ patientId: a.patient.id ?? a.patientId, appointmentId: a.id, name: a.patient.fullName }); } : undefined} onClose={() => { setApptId(null); qc.invalidateQueries({ queryKey: ['calendar'] }); refresh(); }} />}
          {selV && <JourneyPanel key={selV.id} v={selV} order={reportsOpen.find((o) => o.encounterId === selV.encounterId)} screening={screening} inLine={waiting.findIndex((x) => x.id === selV.id) + 1} canDesk={canDesk}
              canSend={canSend} onSendIn={(id) => upVisit.mutate({ id, status: 'in_consult' }, { onError: (e) => toast(errText(e), 'err') })} onToJunior={(id) => { const v = visitsAll.find((x) => x.id === id); if (v) toJunior(v); }} onClose={() => setPickV('')}
              arrangeSlot={<CheckoutList bare visits={[selV]} canDesk={canDesk} canForce={can(perms, 'config.write')} />} />}
        </div>)}
    </div>
  );
}

/** A stat that is also a filter: click it to show exactly those patients. */

const Sep = () => <span className="w-px h-9 bg-ink/10 hidden sm:block" />;
function Stat({ label, value, sub, tone = '' }: { label: string; value: any; sub?: string; tone?: '' | 'clay' | 'sage' }) {
  return <div><div className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</div><div className={`serif text-2xl leading-tight ${tone === 'clay' ? 'text-clay' : tone === 'sage' ? 'text-sage' : ''}`}>{typeof value === 'number' ? <Num value={value} /> : value} {sub && <span className="font-sans text-[13px] font-normal text-muted">{sub}</span>}</div></div>;
}

const dayOf = (iso: string) => new Date(iso + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
const weekdayOf = (iso: string) => new Date(iso + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short' });

/** History across days. The controls sit on the tab row (search, one Filters dropdown, print, export); the date is a column. */
const PERIODS: [string, string][] = [['today', 'Today'], ['yesterday', 'Yesterday'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['custom', 'Pick dates']];
const SHOWS: [string, string][] = [['all', 'Everything'], ['left', 'Left without consult'], ['noshow', 'No-shows'], ['adjusted', 'Fees waived or refunded']];
function HistoryPanel({ find, onBook }: { canDesk: boolean; find: string; onBook: (p?: any) => void; slot: HTMLElement | null }) {
  const { perms, cfg } = useOutletContext<Ctx & { cfg: any }>();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  // the shared table: Period and Show go to the server, Doctor filters what came back; "Pick dates" opens two date boxes
  const PERIOD: FilterDef<any> = { key: 'period', label: 'Period', icon: 'calendar', options: [PERIODS[2], ...PERIODS.filter((x) => x[0] !== '7')].map(([value, label]) => ({ value, label })) };
  const SHOW: FilterDef<any> = { key: 'show', label: 'Show', icon: 'filter', options: SHOWS.map(([value, label]) => ({ value, label })) };
  const docs: any[] = cfg?.practitioners ?? [];
  const DOC: FilterDef<any> = { key: 'doctor', label: 'Doctor', icon: 'stetho', options: [{ value: '', label: 'All doctors' }, ...docs.map((d) => ({ value: d.name as string, label: d.name as string }))], test: (r, v) => !v || r.doctor === v };
  const period = filterValue(sp, PERIOD), filter = filterValue(sp, SHOW);
  const t0 = today();
  const custom = { from: sp.get('from') ?? shiftDay(t0, -13), to: sp.get('to') ?? t0 };
  const { from, to } = period === 'today' ? { from: t0, to: t0 } : period === 'yesterday' ? { from: shiftDay(t0, -1), to: shiftDay(t0, -1) } : period === '30' ? { from: shiftDay(t0, -29), to: t0 } : period === 'custom' ? custom : { from: shiftDay(t0, -6), to: t0 };
  const badDates = from > to;
  const setDate = (k: 'from' | 'to', v: string) => v && setSp((p) => { const n = new URLSearchParams(p); n.set(k, v); n.delete('p'); return n; }, { replace: true });
  const [term, setTerm] = usePageSearch('Search all days: name, phone or token'); const [qd, setQd] = useState(term || find);
  useEffect(() => { if (find && !term) setTerm(find); }, []);
  useEffect(() => { const h = setTimeout(() => setQd(term), 300); return () => clearTimeout(h); }, [term]);
  const h = useQuery({ queryKey: ['fd-history', from, to, qd, filter], queryFn: () => get(`/frontdesk/history?from=${from}&to=${to}&q=${encodeURIComponent(qd)}&filter=${filter}`), enabled: !badDates });
  const refund = useMutation({ mutationFn: ({ c, reason }: any) => post(`/charges/${c.id}/adjust`, { kind: 'refunded', reason }), onSuccess: (_r, { c, name }: any) => { ['fd-history', 'frontdesk', 'daily', 'dayclose'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); toast(`Refunded ${money(c.amountPaise)} to ${name}`); }, onError: (e) => toast(moneyErr(e), 'err') });
  // the same reason picker as every other refund
  const [refunding, setRefunding] = useState<null | { c: any; name: string }>(null);
  const rows: any[] = h.data?.rows ?? []; const s = h.data?.summary;
  const outcomeChip = (r: any) => r.outcome === 'completed' ? <Chip tone="sage">completed</Chip> : r.outcome === 'left' ? <Chip>left</Chip> : r.outcome === 'noshow' ? <Chip tone="rose">no-show</Chip> : <Chip tone="amber">{r.outcome.replace('_', ' ')}</Chip>;
  const happened = (r: any) => r.kind === 'noshow' ? 'Did not arrive' : r.outcome === 'left' ? 'Left without seeing the doctor' : (r.recommendations ?? []).map((x: any) => x.kind === 'procedure' ? x.procedure : x.kind === 'investigation' ? `Test ${x.notes}` : `Review ${x.dueOn ?? ''}`).join('; ') || 'Medicines only';
  const paidOf = (r: any) => r.charges.find((c: any) => c.status === 'paid' && c.amountPaise > 0);
  const columns: Col<any>[] = [
    { key: 'date', label: 'Date', fixed: true, sort: (r) => `${r.date} ${r.token}`, csv: (r) => r.date, cell: (r) => <div className="whitespace-nowrap"><div className="font-semibold">{dayOf(r.date)}</div><div className="text-[12px] text-muted">{weekdayOf(r.date)}</div></div> },
    { key: 'token', label: 'Token', sort: (r) => r.token, csv: (r) => r.token, cell: (r) => <b className="tabular-nums">{r.token}</b> },
    { key: 'patient', label: 'Patient', sort: (r) => r.patient.fullName.toLowerCase(), csv: (r) => r.patient.fullName, cell: (r) => <div><div className="font-bold">{r.patient.fullName} <span className="font-medium text-muted">{[r.patient.ageYears, r.patient.sex].filter(Boolean).join(' ')}</span></div><div className="text-[12px] text-muted">{r.patient.phone ?? ''}</div></div> },
    { key: 'outcome', label: 'Outcome', sort: (r) => r.outcome, csv: (r) => r.outcome, cell: outcomeChip },
    { key: 'doctor', label: 'Doctor', sort: (r) => r.doctor ?? '', csv: (r) => r.doctor ?? '', cell: (r) => <span className="whitespace-nowrap">{r.doctor ?? '—'}</span> },
    { key: 'what', label: 'What happened', hideOnPhone: true, csv: happened, cell: (r) => { const paid = paidOf(r); const adj = r.charges.find((c: any) => ['waived', 'refunded'].includes(c.status));
      return <div className="text-[12.5px]">{r.kind === 'noshow' ? <span className="text-muted">Did not arrive</span> : r.outcome === 'left' ? <span className="text-muted">Left without seeing the doctor{paid ? ` · ${money(paid.amountPaise)} paid` : ''}</span> : (
        <div className="flex flex-wrap gap-1">{r.recommendations.length ? r.recommendations.map((x: any) => <Chip key={x.id} tone={x.kind === 'procedure' ? 'sky' : x.kind === 'investigation' ? 'clay' : 'amber'}>{x.kind === 'procedure' ? x.procedure ?? 'Procedure' : x.kind === 'investigation' ? `Test: ${x.notes}` : `Review ${x.dueOn ? fmtDate(x.dueOn) : ''}`}</Chip>) : <span className="text-muted">Medicines only</span>}</div>)}
        {adj && <div className="mt-1"><Chip tone="amber">{adj.status}{adj.reason ? ` · ${adj.reason}` : ''}</Chip></div>}</div>; } },
    { key: 'action', label: '', fixed: true, align: 'right', cell: (r) => { const paid = paidOf(r);
      return <span className="inline-flex items-center gap-1 whitespace-nowrap">
        {r.kind === 'noshow' ? <button className="btn btn-sm btn-primary" onClick={() => onBook(r.patient)}>Rebook</button> : r.outcome === 'left' && paid && can(perms, 'payment.refund') ? <button className="btn btn-sm btn-primary" disabled={refund.isPending} onClick={() => setRefunding({ c: paid, name: r.patient.fullName })}>Refund</button> : null}
        <button className="btn btn-sm" onClick={() => nav(`/patients/${r.patient.id}`)}><Icon name="eye" />View profile</button></span>; } },
  ];
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 anim-fade-up">
      <div className="text-sm text-muted">{s ? <span>{dayOf(from)}{from !== to ? ` – ${dayOf(to)}` : ''} · <b className="text-ink">{s.visits}</b> visits · <b className="text-ink">{s.left}</b> left without consult · <b className="text-ink">{s.noShows}</b> no-shows · <b className="text-ink">{money(s.collectedPaise)}</b> collected</span> : badDates ? 'Check the dates' : 'Loading…'}</div>
      <DataTable id="fd-history" exportName={`front-desk-history-${from}-to-${to}`} rows={rows} rowKey={(r) => r.key} columns={columns}
        loading={h.isLoading && !badDates} error={h.error} onRetry={() => h.refetch()} onRow={(r) => nav(`/patients/${r.patient.id}`)}
        search={{ placeholder: 'Search all days: name, phone or token' }} sort={{ key: 'date', dir: -1 }}
        filters={[PERIOD, SHOW, ...(docs.length > 1 ? [DOC] : [])]}
        toolbar={period === 'custom' && <span className="inline-flex items-center gap-1.5 text-[12.5px] text-muted">
          <input type="date" aria-label="From date" className={`dt-select ${badDates ? '!border-rose' : ''}`} value={custom.from} max={t0} onChange={(e) => setDate('from', e.target.value)} />to
          <input type="date" aria-label="To date" className={`dt-select ${badDates ? '!border-rose' : ''}`} value={custom.to} max={t0} onChange={(e) => setDate('to', e.target.value)} /></span>}
        empty={{ title: badDates ? 'Check the dates' : 'Nothing found for this period', hint: badDates ? 'The “from” date is after the “to” date.' : 'Try a longer period, or Everything under Show.' }} />
      {rows.length >= 500 && <div className="text-xs text-muted">Showing the newest 500. Narrow the period or search to see older rows.</div>}
      {refunding && <RefundDialog title={`Refund ${money(refunding.c.amountPaise)} to ${refunding.name}?`} body="The money must be handed back, the same way it was paid. It comes off today's takings." confirmLabel={`Refund ${money(refunding.c.amountPaise)}`}
        onClose={(reason) => { const x = refunding; setRefunding(null); if (reason) refund.mutate({ c: x.c, reason, name: x.name }); }} />}
    </div>
  );
}


type Complaint = { text: string; duration: string };

type First = { dob: string; ageYears: string; sex: string; conditions: string[]; allergies: string[] };
const NO_FIRST: First = { dob: '', ageYears: '', sex: '', conditions: [], allergies: [] };
const names = (xs: any) => (Array.isArray(xs) ? xs.map((x: any) => x?.name).filter(Boolean) : []);
const firstOf = (p: any): First => ({ dob: p.dob ?? '', ageYears: p.ageYears != null ? String(p.ageYears) : '', sex: p.sex ?? '', conditions: names(p.history?.conditions), allergies: names(p.history?.drugAllergies) });
/** Whole years from a date of birth, today. */
export const ageFrom = (dob: string, now = new Date()) => { const [y, m, d] = dob.split('-').map(Number); return now.getFullYear() - y - (now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < d) ? 1 : 0); };

/** One numbered part of check-in: the number, a title that reads first, one line of help, then the fields. */
function Sec({ n, title, hint, aside, compact = false, children }: { n: number; title: string; hint?: string; aside?: React.ReactNode; compact?: boolean; children: React.ReactNode }) {
  return (
    <section aria-label={title} className={`flex flex-col rounded-[18px] bg-surface ring-1 ring-line ${compact ? 'gap-2.5 px-5 py-3.5' : 'gap-4 p-5'}`}>
      <div className="flex items-start gap-3">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-[9px] bg-ink text-[13px] font-extrabold text-paper">{n}</span>
        <div className="min-w-0 flex-1"><h3 className="text-[16px] font-extrabold leading-tight text-ink">{title}</h3>{hint && <p className="mt-0.5 text-[13px] text-muted">{hint}</p>}</div>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** Joined buttons for one choice out of a few (sex, payment method). */
function Seg({ label, value, options, onChange, full = false }: { label: string; value: string; options: [string, string][]; onChange: (v: string) => void; full?: boolean }) {
  return (
    <div role="radiogroup" aria-label={label} className={`${full ? 'flex w-full' : 'inline-flex'} gap-0.5 rounded-[11px] bg-surface-2 p-[3px]`}>
      {options.map(([v, l]) => <button key={v} type="button" role="radio" aria-checked={value === v} onClick={() => onChange(v)}
        className={`h-9 flex-1 rounded-[8px] px-4 text-[13px] font-bold transition-colors ${value === v ? 'bg-surface text-ink shadow-[0_1px_2px_rgba(16,32,24,.14),0_0_0_1px_rgba(16,32,24,.06)]' : 'text-ink-2 hover:text-ink'}`}>{l}</button>)}
    </div>
  );
}

/** Tick boxes from the clinic's list (the same list as the pad's Medical history); Other, Enter adds one. */
function Checks({ label, options, value, onChange }: { label: string; options: string[]; value: string[]; onChange: (v: string[]) => void }) {
  const [other, setOther] = useState('');
  const add = () => { const t = other.trim(); if (t && !value.includes(t)) onChange([...value, t]); setOther(''); };
  return (
    <fieldset className="min-w-0"><legend className="label">{label}</legend>
      <div className="grid grid-cols-2 gap-x-3 sm:grid-cols-3">
        {[...new Set([...options, ...value])].map((o) => <label key={o} className="flex cursor-pointer items-center gap-2.5 py-1.5 text-[13.5px] font-semibold text-ink-2">
          <input type="checkbox" className="h-[18px] w-[18px] shrink-0 accent-clay" checked={value.includes(o)} onChange={() => onChange(value.includes(o) ? value.filter((x) => x !== o) : [...value, o])} />{o}</label>)}
      </div>
      <input aria-label={`${label}: other`} className="input mt-2 !min-h-0 !w-60 !py-1.5 text-[13px]" maxLength={80} placeholder="Other, press Enter" value={other} onChange={(e) => setOther(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
    </fieldset>
  );
}

/** Typed entries as red tags (allergies stand out); the clinic's common ones one click away. */
function Tags({ id, label, options, value, onChange }: { id: string; label: string; options: string[]; value: string[]; onChange: (v: string[]) => void }) {
  const [t, setT] = useState('');
  const add = (x: string) => { const v = x.trim(); if (v && !value.includes(v)) onChange([...value, v]); setT(''); };
  const rest = options.filter((o) => !value.includes(o));
  return (
    <div className="min-w-0"><label htmlFor={id} className="label">{label}</label>
      <div className="flex min-h-[42px] flex-wrap items-center gap-1.5 rounded-[12px] bg-surface p-1.5 shadow-[var(--ring)]">
        {value.map((x) => <span key={x} className="inline-flex h-7 items-center gap-1 rounded-[8px] bg-rose-soft pl-2.5 pr-1 text-[12.5px] font-bold text-rose">{x}
          <button type="button" aria-label={`Remove ${x}`} className="grid h-5 w-5 place-items-center rounded-[5px] hover:bg-rose/10" onClick={() => onChange(value.filter((y) => y !== x))}><Icon name="x" className="h-3 w-3" /></button></span>)}
        <input id={id} className="min-w-[110px] flex-1 border-0 bg-transparent px-1.5 text-[13.5px] text-ink outline-none placeholder:text-muted/70" maxLength={80} placeholder={value.length ? 'Add another…' : 'None known · type to add'} value={t}
          onChange={(e) => setT(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(t); } else if (e.key === 'Backspace' && !t && value.length) onChange(value.slice(0, -1)); }} />
      </div>
      {rest.length > 0 && <div className="mt-1.5 text-[12.5px] text-muted">Common: {rest.slice(0, 6).map((o, i) => <span key={o}>{i ? ' · ' : ''}<button type="button" className="font-semibold text-clay hover:underline" onClick={() => add(o)}>{o}</button></span>)}</div>}
    </div>
  );
}

/** Arrival: who they are, what the doctor should know, vitals and complaints on the left; doctor, fee and the one button on the right. */
export function ArrivalSheet({ init, cfg, perms, todayAppts, waitingByDoctor, onClose }: { init: { patientId?: string; appointmentId?: string; name?: string; reports?: { encounterId: string; tests: string; free: boolean; since: string } }; cfg: any; perms: string[]; todayAppts: any[]; waitingByDoctor: Record<string, number>; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [patientId, setPatientId] = useState(init.patientId);
  const [newP, setNewP] = useState<null | { fullName: string; phone: string }>(null);
  const [newFlags, setNewFlags] = useState(NO_FLAGS); // asked only when registering here
  const [first, setFirst] = useState<First>(NO_FIRST); // first-visit details: asked once, kept on the patient
  const [cat, setCat] = useState('');
  const vitalList = enabledVitals(cfg?.tenant.settings); // the clinic's vitals (Settings › Vitals)
  const [vit, setVit] = useState<Record<string, string>>({});
  const [locality, setLocality] = useState('');
  const [list, setList] = useState<Complaint[]>([]);
  const [draft, setDraft] = useState<Complaint>({ text: '', duration: '' });
  const comp = useTemplates('complaint');
  // the fee can be split across modes (₹100 cash + ₹100 card); a blank amount on the first line means "the rest of the fee"
  const [pays, setPays] = useState<{ method: string; amount: string; ref: string }[]>([{ method: 'cash', amount: '', ref: '' }]);
  const setPay = (i: number, x: Partial<{ method: string; amount: string; ref: string }>) => setPays(pays.map((p, j) => (j === i ? { ...p, ...x } : p)));
  const [partOk, setPartOk] = useState(false); // ticked: taking less than the fee on purpose, the rest stays due
  const [visitKey] = useState(uuid); // one check-in, one key: a retry after a timeout cannot check in twice
  // A consultation still open for this patient's tests: ask "back with reports?" so the doctor reopens it instead of starting afresh
  const ordersQ = useQuery({ queryKey: ['orders'], queryFn: () => get('/orders'), enabled: !!patientId && !init.reports && can(perms, 'document.read') });
  const heldOrders: Order[] = ((ordersQ.data?.orders ?? []) as Order[]).filter((o) => o.patient.id === patientId && o.held);
  const heldEnc = heldOrders[0]?.encounterId; const heldTests = heldOrders.filter((o) => o.encounterId === heldEnc);
  const [back, setBack] = useState<boolean | null>(null);
  const [addRep, setAddRep] = useState<{ o: Order; testId: string } | null>(null);
  const sinceOrder = heldTests[0] ? Math.floor((Date.now() - new Date((heldTests[0] as any).orderedAt).getTime()) / 86400000) : 0;
  const reports = init.reports ?? (back && heldEnc ? { encounterId: heldEnc, tests: heldTests.flatMap((o) => o.tests.map((t) => t.name)).join(', '), free: sinceOrder <= Number(cfg?.tenant?.settings?.reports?.freeDays ?? 30), since: (heldTests[0] as any).orderedAt } : undefined);
  const waive = !!reports?.free; // back with reports within the free days: the server waives it by the clinic's rule
  const [pickedDoc, setPractitionerId] = useState('');
  const search = useQuery({ queryKey: ['patients', q], queryFn: () => get(`/patients?q=${encodeURIComponent(q)}`), enabled: !patientId && q.length >= 2 });
  const sug = useQuery({ queryKey: ['suggest', patientId], queryFn: () => get(`/patients/${patientId}/suggest-category`), enabled: !!patientId });
  const tl = useQuery({ queryKey: ['timeline', patientId], queryFn: () => get(`/patients/${patientId}/timeline`), enabled: !!patientId });
  // Checking in from the top button: still link the patient's booking for today, and default to that booking's doctor (else the shortest queue). Tap another doctor to change.
  const appt = todayAppts.find((a) => a.id === init.appointmentId) ?? (patientId ? todayAppts.find((a) => a.patientId === patientId) : undefined);
  // Only doctors who still have hours today: their day not over, not on leave or a day off (lunch is fine, they come back).
  const dayWs = useQuery({ queryKey: ['sessions', today()], queryFn: () => get(`/sessions?day=${today()}`) });
  const nowHM = new Intl.DateTimeFormat('en-GB', { timeZone: cfg?.tenant?.timezone ?? 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  const working = (id: string) => !dayWs.data || dayWs.data.some((w: any) => w.practitionerId === id && w.endTime > nowHM && w.effectiveCapacity > 0);
  const bookedDoc = appt?.window?.practitionerId && working(appt.window.practitionerId) ? appt.window.practitionerId : '';
  const practitionerId = pickedDoc || bookedDoc || [...(cfg?.practitioners ?? [])].filter((x: any) => working(x.id)).sort((a: any, b: any) => (waitingByDoctor[a.id] ?? 0) - (waitingByDoctor[b.id] ?? 0))[0]?.id || '';
  const fallbackCat = cfg?.feeCategories.find((c: any) => c.code === 'GEN')?.code ?? cfg?.feeCategories[0]?.code ?? '';
  const chosen = cat || sug.data?.suggested?.code || (patientId && sug.isLoading ? '' : fallbackCat);
  const [dup, setDup] = useState<null | { id: string; patientNo: string; fullName?: string; phone?: string; ageYears?: number }>(null); const [forceNew, setForceNew] = useState(false);
  const catRow = cfg?.feeCategories.find((c: any) => c.code === chosen);
  const fee = catRow?.amountPaise ?? 0;
  const p = sug.data?.patient;
  const isFirst = !!newP || (!!patientId && !reports && tl.data?.visits.length === 0); // new, or registered at booking and never seen
  useEffect(() => { if (p) setFirst(firstOf(p)); }, [p?.id]);
  const hadHistory = !!(p?.history?.conditions?.length || p?.history?.drugAllergies?.length);
  const firstBody = () => ({ ageYears: first.ageYears ? Number(first.ageYears) : null, sex: first.sex || null, dob: first.dob || null,
    ...(first.conditions.length || first.allergies.length || hadHistory ? { history: { conditions: first.conditions.map((name) => ({ name })), drugAllergies: first.allergies.map((name) => ({ name })) } } : {}) });
  const openPlans = (tl.data?.recommendations ?? []).filter((r: any) => !['done', 'cancelled'].includes(r.status));
  const w = Number(vit.weight_kg), h = Number(vit.height_cm);
  const bmi = w > 0 && h > 0 ? Math.round((w / ((h / 100) ** 2)) * 10) / 10 : null;
  const commit = () => { if (draft.text.trim()) { setList([...list, { text: draft.text.trim(), duration: draft.duration.trim() }]); setDraft({ text: '', duration: '' }); } };
  const allowReview = useRef('');
  const submit = useMutation({
    mutationFn: async () => {
      let pid = patientId;
      if (!pid && newP) { const np = await post(forceNew ? '/patients?force=1' : '/patients', { fullName: newP.fullName.trim(), phone: newP.phone || null, locality: locality.trim() || null, ...firstBody(), ...flagBody(newFlags) }); pid = np.id; }
      else if (pid && isFirst) await patch(`/patients/${pid}`, { ...firstBody(), ...(locality.trim() ? { locality: locality.trim() } : {}) });
      if (!pid) throw new Error('Pick or register a patient');
      const complaints = [...list, ...(draft.text.trim() ? [{ text: draft.text.trim(), duration: draft.duration.trim() }] : [])];
      const vitals: Record<string, any> = {};
      for (const f of vitalList) if (vit[f.key]) vitals[f.key] = f.type === 'number' ? Number(vit[f.key]) : vit[f.key];
      return post('/visits', { patientId: pid, appointmentId: appt?.id ?? init.appointmentId, feeCategoryCode: chosen, practitionerId: practitionerId || null,
        details: { ...vitals, ...(bmi ? { bmi } : {}), locality: locality || p?.locality, complaints, complaint: reports ? `Back with reports: ${reports.tests}` : complaints.map((c) => c.text).join(', '), ...(reports ? { reportsEncounterId: reports.encounterId } : {}) },
        payments: taking ? pays.map((x, i) => ({ method: x.method, amountPaise: amtOf(i), reference: x.method !== 'cash' && x.ref.trim() ? x.ref.trim() : undefined })).filter((x) => x.amountPaise > 0) : undefined, allowReview: allowReview.current ? { reason: allowReview.current } : undefined, idempotencyKey: visitKey });
    },
    onSuccess: (v: any) => { toast(`Checked in · token ${v.opNumber}${v.receiptNo ? ` · receipt ${v.receiptNo}` : ''}`, 'ok', v.receiptNo ? { label: 'Print receipt', run: () => printReceipt(v.receiptNo) } : undefined); onClose(); },
    onError: async (e: any) => {
      if (e instanceof ApiError && e.body.code === 'POSSIBLE_DUPLICATE') setDup(e.body.existing);
      else if (e instanceof ApiError && e.body.code === 'REVIEW_LIMIT') {
        if (!can(perms, 'payment.refund')) { toast(`This patient has already had ${e.body.used} free review since the last paid consultation (the limit is ${e.body.limit}). Choose the paid consultation, or ask the owner to allow one more.`, 'err'); return; }
        const a = await ask({ title: 'Allow one more free review?', body: `${e.body.used} used of ${e.body.limit} since the last paid consultation. The reason is kept in the log.`, confirmLabel: 'Allow and check in', field: { label: 'Why', required: true, maxLength: 200 } });
        if (a?.value) { allowReview.current = a.value; submit.mutate(); }
      } else toast(moneyErr(e), 'err');
    },
  });
  useEffect(() => { if (forceNew) { submit.mutate(); setForceNew(false); } }, [forceNew]);
  const step = !patientId && !newP ? 1 : 2;
  const badVital = vitalList.map((f) => vitalProblem(f, vit[f.key] ?? '')).find(Boolean);
  const typed = (i: number) => (pays[i].amount === '' ? 0 : toPaise(pays[i].amount));
  const amtOf = (i: number) => (i === 0 && pays[0].amount === '' ? Math.max(0, fee - pays.slice(1).reduce((s, _, j) => s + typed(j + 1), 0)) : typed(i));
  const collect = pays.reduce((s, _, i) => s + amtOf(i), 0);
  const taking = fee > 0 && !waive; const short = taking && collect > 0 && collect < fee;
  useEffect(() => setPartOk(false), [collect, fee]);
  const MODE: Record<string, string> = { cash: 'cash', upi: 'UPI', card: 'card', bank: 'bank' };
  const modes = [...new Set(pays.filter((_, i) => amtOf(i) > 0).map((x) => MODE[x.method]))].join(' + ');
  const blocker = !practitionerId && dayWs.data ? 'No doctor is working now' : practitionerId && !working(practitionerId) ? 'Pick a doctor who is working now' : !chosen ? 'Pick a visit type' : newP && flagDraftBad(newFlags) ? 'Say why the patient is to be handled carefully' : badVital ? badVital : isFirst && !first.sex ? 'Pick male, female or other' : isFirst && !first.ageYears && !first.dob ? 'Enter age or date of birth' : newP && newP.fullName.trim().length < 2 ? 'Enter the patient\'s name (at least 2 letters)' : newP && newP.phone && newP.phone.length !== 10 ? 'Phone needs 10 digits' : taking && collect <= 0 ? 'Enter the amount collected' : taking && collect > fee ? `That is more than the ${money(fee)} fee` : short && !partOk ? 'Tick to take less than the fee' : '';
  const facts = sug.data?.facts;
  const doctorName = (id?: string) => cfg?.practitioners.find((x: any) => x.id === id)?.name;
  const cats: any[] = cfg?.historyCategories ?? [];
  const opts = (k: string) => cats.find((c) => c.key === k)?.options ?? [];
  const suggestions = (comp.data ?? []).filter((t) => !list.some((c) => norm(c.text) === norm(t.name)));
  let n = 2; // 1 is the patient; the rest follow what is shown
  const badge = 'inline-flex h-6 items-center whitespace-nowrap rounded-[7px] px-2 text-[11.5px] font-bold';

  if (step === 1) return (
    <Modal title="Who has arrived?" subtitle="Phone, name or patient ID" onClose={onClose} width="max-w-2xl">
      <div className="anim-fade-up">
        <div className="relative"><Icon name="search" className="h-4 w-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" /><input autoFocus aria-label="Phone, name or patient ID" className="input !pl-10 !py-3" value={q} onChange={(e) => setQ(e.target.value)} placeholder="98765…" /></div>
        <div className="mt-3 card-flat overflow-hidden max-h-64 overflow-y-auto">
          {q.length < 2 ? <div className="p-4 text-sm text-muted">Type at least 2 characters</div> : search.isLoading ? <Skeleton rows={2} /> : (search.data ?? []).length === 0 ? <div className="p-4 text-sm text-muted">No match. Register below.</div> :
            search.data.map((x: any) => <button key={x.id} className="row w-full text-left" onClick={() => setPatientId(x.id)}><Avatar name={x.fullName} /><div className="flex-1 min-w-0"><div className="flex flex-wrap items-center gap-1.5 text-sm font-medium">{x.fullName} <span className="text-muted font-normal text-xs">{x.ageYears ? `${x.ageYears}` : ''} {x.sex ?? ''}</span><FlagChips flags={x.flags} /></div><div className="text-xs text-muted">{x.patientNo} · {x.phone ?? 'no phone'} · {x.locality ?? ''}</div></div><Icon name="chevR" className="text-muted" /></button>)}
        </div>
        <button className="btn mt-3" onClick={() => { setFirst(NO_FIRST); setNewFlags(NO_FLAGS); setNewP({ fullName: /^\d+$/.test(q) ? '' : q, phone: /^\d+$/.test(q) ? q : '' }); }}><Icon name="plus" />New patient</button>
      </div>
    </Modal>
  );

  return (
    <Modal title="Check in" subtitle={newP ? 'New patient' : undefined} onClose={onClose} width="max-w-6xl">
      <div className="-mx-6 -mb-6 bg-surface-2 px-6 pb-6 pt-4 anim-fade-up max-sm:-mx-5 max-sm:px-4">
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="flex min-w-0 flex-col gap-3.5">

            {/* 1 · who */}
            {newP ? (
              <Sec n={1} title="New patient" hint="Name and mobile; the rest is asked below.">
                <div className="grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_190px_auto]">
                  <div><label htmlFor="np-name" className="label">Full name</label><input id="np-name" autoFocus className="input" maxLength={100} value={newP.fullName} onChange={(e) => { setDup(null); setNewP({ ...newP, fullName: e.target.value }); }} /></div>
                  <div><label htmlFor="np-phone" className="label">Mobile</label><input id="np-phone" className="input" inputMode="numeric" placeholder="10 digits" value={newP.phone} onChange={(e) => { setDup(null); setNewP({ ...newP, phone: e.target.value.replace(/\D/g, '').slice(0, 10) }); }} /></div>
                  <button className="btn btn-ghost" onClick={() => setNewP(null)}>Back to search</button>
                </div>
                <FlagPick value={newFlags} onChange={setNewFlags} />
              </Sec>
            ) : (
              <section aria-label="Patient" className="flex flex-col gap-3 rounded-[18px] bg-surface px-5 py-4 ring-1 ring-line">
               <div className="flex items-center gap-4">
                <Avatar name={p?.fullName ?? init.name ?? '?'} size="h-12 w-12 text-sm" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2"><b className="text-[19px] font-extrabold leading-tight">{p?.fullName ?? init.name}</b><FlagChips flags={p?.flags} />
                    {tl.data && (tl.data.visits.length ? <span className={`${badge} bg-sage-soft text-sage`}>Returning · visit {tl.data.visits.length + 1}</span> : <span className={`${badge} bg-amber-soft text-amber`}>First visit</span>)}
                    {appt && <span className={`${badge} bg-sky-soft text-sky`}>Booked {appt.window?.startTime}{doctorName(appt.window?.practitionerId) ? ` · ${doctorName(appt.window?.practitionerId)}` : ''}</span>}</div>
                  <div className="mt-0.5 text-[13px] text-muted">{p ? [p.patientNo, p.phone ?? 'no phone', !isFirst && p.ageYears ? `${p.ageYears} ${p.sex ?? ''}` : null, p.locality].filter(Boolean).join(' · ') : 'loading…'}</div>
                  {openPlans.length > 0 && <div className="mt-1 text-[12.5px] text-ink-2">Open plan: {openPlans.map((r: any) => r.kind === 'procedure' ? 'procedure' : r.kind === 'followup' ? `review ${r.dueOn ? fmtDate(r.dueOn) : ''}` : `test ${r.notes}`).join(', ')}</div>}
                </div>
                {!init.patientId && <button className="btn btn-ghost shrink-0" onClick={() => { setPatientId(undefined); setBack(null); }}>Change</button>}
               </div>
               {heldEnc && !init.reports && <div className="rounded-[12px] bg-amber-soft px-3.5 py-2.5 text-[13px]" role="status">
                 {back === null ? <div className="flex flex-wrap items-center gap-2"><span className="min-w-0 flex-1"><b>Back with reports?</b> Tests ordered {fmtDate((heldTests[0] as any).orderedAt)}: {heldTests.flatMap((o) => o.tests.map((t) => t.name)).join(', ')}.</span>
                   <button type="button" className="btn btn-sm btn-primary" onClick={() => setBack(true)}>Yes, back with reports</button><button type="button" className="btn btn-sm" onClick={() => setBack(false)}>No, something new</button></div>
                 : back ? <div className="flex flex-col gap-1.5">
                   <div className="flex flex-wrap items-center gap-2"><b className="flex-1">Back with reports: the doctor opens the same consultation.</b><button type="button" className="btn btn-ghost btn-sm" onClick={() => setBack(null)}>Undo</button></div>
                   {heldTests.flatMap((o) => o.tests.map((t) => (
                     <div key={t.id} className="flex flex-wrap items-center gap-2">{t.receivedAt ? <Chip tone="sage">in</Chip> : <Chip tone="amber">not added</Chip>}<span className="flex-1">{t.name}</span>
                       {!t.receivedAt && can(perms, 'document.write') && <button type="button" className="btn btn-sm" onClick={() => setAddRep({ o, testId: t.id })}><Icon name="plus" className="h-3.5 w-3.5" />Add report</button>}</div>)))}
                 </div> : <div className="flex items-center gap-2"><span className="flex-1 text-muted">A new consultation: the reports stay with the doctor's list.</span><button type="button" className="btn btn-ghost btn-sm" onClick={() => setBack(null)}>Undo</button></div>}
               </div>}
               {addRep && <ReportDialog order={addRep.o} testId={addRep.testId} inVisit onClose={() => { setAddRep(null); qc.invalidateQueries({ queryKey: ['orders'] }); }} />}
              </section>
            )}
            {dup && <div className="flex flex-wrap items-center gap-2 text-sm rounded-xl bg-amber-soft px-3.5 py-2.5" role="alert"><Icon name="spark" className="h-4 w-4 text-amber" /><span>This looks like a patient already registered: {dup.fullName ?? ''} ({dup.patientNo}){dup.phone ? ` · ${dup.phone}` : ''}{dup.ageYears ? ` · ${dup.ageYears} yrs` : ''}.</span><button className="btn btn-sm ml-auto" onClick={() => { setPatientId(dup.id); setNewP(null); setDup(null); }}>Use existing</button><button className="btn btn-sm" onClick={() => { setForceNew(true); setDup(null); }}>It is someone else</button></div>}

            {/* complaints */}
            <Sec n={n++} title="Complaints">
              {reports && <div className="rounded-[12px] bg-amber-soft px-3.5 py-2.5 text-[13px] text-amber"><b>Back with reports:</b> {reports.tests}. No new complaint is needed; the doctor opens the same consultation.{reports.free ? ' Within the free-return days, so no fee unless the visit type says otherwise.' : ' Outside the free-return days: the usual fee applies.'}</div>}
              <div className="flex flex-col gap-2">
                {list.map((c, i) => (
                  <div key={i} className="grid grid-cols-[minmax(0,1fr)_150px_40px] items-center gap-2.5 anim-scale-in">
                    <div className="input flex items-center !bg-surface-2 !shadow-none font-semibold">{c.text}</div>
                    <input className="input" aria-label={`${c.text}: since when`} placeholder="Since when" maxLength={30} value={c.duration} onChange={(e) => setList(list.map((x, j) => (j === i ? { ...x, duration: e.target.value } : x)))} />
                    <button type="button" className="btn btn-ghost btn-icon" aria-label={`Remove ${c.text}`} onClick={() => setList(list.filter((_, j) => j !== i))}><Icon name="x" className="h-4 w-4" /></button>
                  </div>))}
                <div className="grid grid-cols-[minmax(0,1fr)_150px_auto] items-center gap-2.5">
                  <input className="input" aria-label="Complaint" placeholder={list.length ? 'Another complaint…' : 'Main complaint…'} value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }} />
                  <input className="input" aria-label="Since when" placeholder="Since when" value={draft.duration} onChange={(e) => setDraft({ ...draft, duration: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }} />
                  <button type="button" className="btn" disabled={!draft.text.trim()} onClick={commit}><Icon name="plus" className="h-4 w-4" />Add</button>
                </div>
                {suggestions.length > 0 && <div className="flex flex-wrap items-center gap-1"><span className="quick-label">Quick add</span>{suggestions.map((t) => <button key={t.id} type="button" className="opt-add" onClick={() => setList([...list, { text: t.name, duration: '' }])}>{t.name}</button>)}</div>}
              </div>
            </Sec>

            {/* 2 · first visit: asked once */}
            {isFirst && (
              <Sec n={n++} title="About the patient" hint="Asked once, on the first visit; the doctor sees it on every visit.">
                <div className="grid items-end gap-3.5 sm:grid-cols-[170px_96px_minmax(0,1fr)]">
                  <div><label htmlFor="fv-dob" className="label">Date of birth</label><input id="fv-dob" type="date" className="input" min="1900-01-01" max={today()} value={first.dob} onChange={(e) => { const d = e.target.value; setFirst((x) => ({ ...x, dob: d, ageYears: d && d <= today() ? String(ageFrom(d)) : x.ageYears })); }} /></div>
                  <div><label htmlFor="fv-age" className="label">Age</label><input id="fv-age" className="input" inputMode="numeric" placeholder="years" disabled={!!first.dob} value={first.ageYears} onChange={(e) => { const v = e.target.value.replace(/\D/g, '').slice(0, 3); setFirst((x) => ({ ...x, ageYears: v && Number(v) > 120 ? '120' : v })); }} /></div>
                  <div><span className="label">Sex</span><Seg label="Sex" value={first.sex} options={[['M', 'Male'], ['F', 'Female'], ['O', 'Other']]} onChange={(s) => setFirst((x) => ({ ...x, sex: s }))} /></div>
                </div>
                <div><label htmlFor="fv-addr" className="label">Address</label><input id="fv-addr" className="input" maxLength={200} placeholder={p?.locality || 'House, street, area, town'} value={locality} onChange={(e) => setLocality(e.target.value)} /></div>
                <div className="h-px bg-line" />
                <div className="grid gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
                  <Checks label="Existing conditions" options={opts('conditions')} value={first.conditions} onChange={(v) => setFirst((x) => ({ ...x, conditions: v }))} />
                  <Tags id="fv-allergy" label="Drug allergies" options={opts('drugAllergies')} value={first.allergies} onChange={(v) => setFirst((x) => ({ ...x, allergies: v }))} />
                </div>
              </Sec>
            )}

            {/* vitals */}
            <Sec n={n++} title="Vitals" compact
              aside={bmi ? <span className="rounded-[8px] bg-clay-soft px-2.5 py-1 text-[12px] font-bold text-clay-ink">BMI {bmi}</span> : undefined}>
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
                {vitalList.map((f) => {
                  const bad = vitalProblem(f, vit[f.key] ?? '');
                  return (
                    <div key={f.key} className="min-w-0"><label htmlFor={`v-${f.key}`} className="label">{f.label}</label>
                      <div className="relative"><input id={`v-${f.key}`} aria-invalid={!!bad} style={{ paddingRight: (f.unit?.length ?? 0) > 2 ? 58 : 40 }} className={`input ${bad ?'!shadow-[inset_0_0_0_1.5px_var(--color-rose)]' : ''}`} inputMode={f.type === 'number' ? 'decimal' : 'text'} placeholder={f.ph ?? ''} value={vit[f.key] ?? ''} maxLength={f.type === 'number' || f.key === 'bp' ? 7 : 20}
                        onChange={(e) => setVit({ ...vit, [f.key]: f.type === 'number' ? e.target.value.replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1') : f.key === 'bp' ? e.target.value.replace(/[^\d/]/g, '') : e.target.value })} />
                        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[12px] font-semibold text-muted">{f.unit}</span></div></div>
                  );
                })}
              </div>
              {badVital && <p className="-mt-1 text-[12.5px] font-semibold text-rose">{badVital}</p>}
            </Sec>

          </div>

          {/* the rail: doctor, fee and the one button, always in view */}
          <aside aria-label="Visit and fee" className="flex flex-col gap-4 rounded-[18px] bg-surface p-5 ring-1 ring-line shadow-[0_24px_50px_-30px_rgba(16,32,24,.35)] lg:sticky lg:top-0">
            <div className="flex items-baseline justify-between"><h3 className="text-[18px] font-extrabold">Visit</h3><span className="text-[12.5px] text-muted">token on check-in</span></div>
            <div><span className="label">Doctor</span>
              <div role="radiogroup" aria-label="Doctor" className="flex flex-col gap-1.5">
                {cfg?.practitioners.map((x: any) => { const on = practitionerId === x.id; return (
                  <button key={x.id} type="button" role="radio" aria-checked={on} disabled={!working(x.id)} onClick={() => setPractitionerId(x.id)} className={`grid w-full grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-[12px] px-3 py-2.5 text-left text-[13.5px] font-semibold text-ink disabled:cursor-not-allowed disabled:opacity-50 ${on ? 'bg-clay-soft/50 ring-[1.5px] ring-clay' : 'ring-1 ring-line hover:bg-surface-2'}`}>
                    <i className={`h-4 w-4 rounded-full ${on ? 'shadow-[inset_0_0_0_5px_var(--color-clay)]' : 'shadow-[inset_0_0_0_1.5px_var(--color-line-2)]'}`} /><span className="truncate">{x.name}</span><span className="text-[12.5px] font-medium text-muted">{working(x.id) ? `${waitingByDoctor[x.id] ?? 0} waiting` : 'not working now'}</span></button>); })}
              </div></div>
            <div><label htmlFor="visit-type" className="label">Visit type</label>
              <select id="visit-type" className="input" value={chosen} onChange={(e) => setCat(e.target.value)}>{cfg?.feeCategories.map((c: any) => <option key={c.code} value={c.code}>{c.name} · {money(c.amountPaise)}{sug.data?.suggested?.code === c.code ? ' (suggested)' : ''}</option>)}</select>
              {facts && <p className="mt-1.5 text-[12.5px] text-muted">{facts.days_since_last_paid_consult < 9999 ? `Last paid consultation ${facts.days_since_last_paid_consult} days ago` : 'No paid consultation before'} → {sug.data.suggested.name}.</p>}</div>
            {taking && <div className="flex flex-col gap-2.5"><span className="label !mb-0">Paid by</span>
              {pays.map((x, i) => (
                <div key={i} className={`flex flex-col gap-1.5 ${i ? 'border-t border-line pt-2.5' : ''}`}>
                  <div className="flex items-center gap-1.5"><Seg full label={`Payment ${i + 1} method`} value={x.method} options={[['cash', 'Cash'], ['upi', 'UPI'], ['card', 'Card'], ['bank', 'Bank']]} onChange={(m) => setPay(i, { method: m })} />
                    {pays.length > 1 && <button type="button" className="btn btn-ghost btn-icon shrink-0" aria-label={`Remove payment ${i + 1}`} onClick={() => setPays(pays.filter((_, j) => j !== i))}><Icon name="x" className="h-4 w-4" /></button>}</div>
                  <div className="flex gap-1.5">
                    {x.method !== 'cash' && <input className="input min-w-0 flex-1 !py-1.5 text-[13px]" aria-label={`Payment ${i + 1} reference`} maxLength={60} placeholder={x.method === 'upi' ? 'UPI ref no.' : x.method === 'card' ? 'Card / approval no.' : 'Bank ref no.'} value={x.ref} onChange={(e) => setPay(i, { ref: e.target.value })} />}
                    <MoneyInput label={`Payment ${i + 1} amount`} className={x.method === 'cash' ? 'flex-1' : 'w-28'} placeholder={String(amtOf(i) / 100)} value={x.amount} onChange={(v) => setPay(i, { amount: v })} />
                  </div>
                </div>))}
              {pays.length < 4 && <button type="button" className="self-start text-[13px] font-semibold text-clay hover:underline" onClick={() => setPays([...pays, { method: pays.some((x) => x.method === 'cash') ? 'card' : 'cash', amount: '', ref: '' }])}>+ Split across another mode</button>}
            </div>}
            <div className="flex items-center justify-between gap-3 border-t border-dashed border-line-2 pt-3.5">
              <span className="text-[12.5px] font-semibold text-ink-2">{fee === 0 ? `Nothing to collect for ${catRow?.name?.split(' (')[0] ?? 'this visit'}` : waive ? 'No fee · back with reports' : 'Collect now'}</span>
              <b className="text-[24px] font-extrabold">{money(taking ? collect : 0)}</b>
            </div>
            {short && <label className="-mt-2 flex cursor-pointer items-start gap-2 rounded-[10px] bg-amber-soft px-3 py-2 text-[12.5px] font-semibold text-amber"><input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-clay" checked={partOk} onChange={(e) => setPartOk(e.target.checked)} />Fee is {money(fee)}. Taking {money(collect)} leaves {money(fee - collect)} due.</label>}
            <p role="status" className="min-h-[18px] text-[12.5px] font-semibold text-amber">{blocker}</p>
            <button className="btn btn-primary !h-12 w-full justify-center text-[15px]" disabled={submit.isPending || !!blocker} onClick={() => submit.mutate()}><Icon name="check" />Check in{taking && !blocker ? ` · collect ${money(collect)} ${modes}` : ''}</button>
            <div className="flex items-center justify-end">
              <button type="button" className="text-[13px] font-semibold text-muted hover:underline" onClick={onClose}>Cancel</button>
            </div>
          </aside>
        </div>
      </div>
    </Modal>
  );
}

/** How many patients may be inside the consultation room at once (the server enforces the same number). */
const ROOM_MAX = 3;
const visitClosed = (v: any) => !!v.details?.checkoutClosedAt;
/** What is still owed on a visit: each due charge less any part already paid at check-in. */
export const dueOf = (v: any): number => (v.due ?? []).reduce((x: number, c: any) => x + c.amountPaise - (c.paidPaise ?? 0), 0);
const testsOf = (v: any): any[] => (v.recommendations ?? []).filter((r: any) => r.kind === 'investigation' && r.status !== 'cancelled');
/** The lab slip is given for every test, but the doctor has not reviewed and the patient has not been told yet. */
const awaitingReports = (v: any) => { const t = testsOf(v); return v.status === 'done' && t.length > 0 && t.every((r) => r.status !== 'open') && t.some((r) => !r.informedAt); };

const plansRefresh = () => ['frontdesk', 'worklist', 'bookings', 'psessions', 'pcounts', 'calendar'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));

/** After the doctor: every open plan of a finished patient with the one action that settles it. A patient leaves this list when nothing is pending. */
function CheckoutList({ visits, canDesk, canForce, bare = false }: { visits: any[]; canDesk: boolean; canForce: boolean; bare?: boolean }) {
  const nav = useNavigate();
  const [sched, setSched] = useState<{ rec: any; patient: any } | null>(null); const [course, setCourse] = useState<{ rec: any; patient: any } | null>(null);
  const upd = useMutation({ mutationFn: ({ id, ...b }: any) => patch(`/worklist/${id}`, b), onSuccess: plansRefresh, onError: (e) => toast(errText(e), 'err') });
  const act = (ids: string[], status: string, outcome: string, note?: string) => Promise.all(ids.map((id) => upd.mutateAsync({ id, status, contact: { outcome, note } })));
  const decline = async (ids: string[], what: string) => { const a = await ask({ title: `Patient declined ${what}?`, body: 'It leaves the pending list and stays in the patient record.', confirmLabel: 'Declined', cancelLabel: 'Keep', field: { label: 'Reason', maxLength: 200 } }); if (a) await act(ids, 'cancelled', 'Declined', a.value || undefined); };
  // "Not today": the patient wants to think about it. It leaves the desk's pending list and comes up on Calls on the day picked,
  // so "later" always has a date and somebody rings. (Tests are not called about: they are just set aside.)
  const later = async (rs: any[], patientId: string, days: number) => {
    const on = new Date(Date.now() + days * 864e5); if (on.getDay() === 0) on.setDate(on.getDate() + 1); // not a Sunday
    const day = `${on.getFullYear()}-${String(on.getMonth() + 1).padStart(2, '0')}-${String(on.getDate()).padStart(2, '0')}`;
    await act(rs.map((r) => r.id), 'contacted', 'Not today', `call on ${day}`);
    const call = rs.filter((r) => r.kind !== 'investigation');
    await Promise.all(call.map((r) => post('/followups/log', { kind: r.kind === 'followup' ? 'review' : 'advised', refId: r.id, patientId, outcome: 'call_later', callbackOn: day }))).catch((e) => toast(errText(e), 'err'));
    qc.invalidateQueries({ queryKey: ['followups'] });
    toast(call.length ? `Set aside. On the Calls list from ${fmtDate(day)}.` : 'Set aside for now.', 'info');
  };
  const close = useMutation({ mutationFn: ({ id, reason }: { id: string; reason?: string }) => patch(`/visits/${id}`, { details: { checkoutClosedAt: new Date().toISOString(), ...(reason ? { checkoutCloseReason: reason } : {}) } }), onSuccess: () => { plansRefresh(); toast('Visit closed', 'info'); }, onError: (e) => toast(errText(e), 'err') });
  const closeWithReason = async (id: string) => { const a = await ask({ title: 'Close this visit with things still open?', body: 'The reason is written to the audit log.', confirmLabel: 'Close visit', cancelLabel: 'Keep open', field: { label: 'Reason (patient left, declined…)', required: true, maxLength: 200 } }); if (a?.value) close.mutate({ id, reason: a.value }); };
  if (visits.length === 0) return <div className="card"><Empty icon="check" title="Nothing pending after the doctor" hint="When the doctor advises a procedure, tests or a review, the patient shows here until each is done or marked not needed." /></div>;
  return (
    <div className="space-y-3 anim-fade-up">
      {visits.map((v) => {
        const recs: any[] = (v.recommendations ?? []); const open = recs.filter((r) => r.status === 'open'); const tst = testsOf(v); const got = tst.filter((r) => r.status === 'done').length; const waitingRep = awaitingReports(v);
        const procs = recs.filter((r) => r.kind === 'procedure'); const fus = recs.filter((r) => r.kind === 'followup'); const tests = recs.filter((r) => r.kind === 'investigation');
        const doneLabel = (r: any) => r.status === 'scheduled' ? (r.kind === 'procedure' ? 'Scheduled' : 'Booked') : r.status === 'cancelled' ? 'Declined' : r.status === 'done' ? 'Done' : (r.contactLog?.[r.contactLog.length - 1]?.outcome ?? 'Handled');
        const Item = ({ tag, tone, title, sub, rs, action, onAction, extra }: { tag: string; tone: 'sky' | 'clay' | 'amber'; title: string; sub?: string; rs: any[]; action: string; onAction: () => void; extra?: React.ReactNode }) => {
          const pending = rs.filter((r) => r.status === 'open'); const ids = pending.map((r) => r.id); const call = tag !== 'tests';
          return pending.length === 0
            ? <div className="flex items-center gap-2 rounded-2xl px-3 py-2 text-sm opacity-60"><Chip>done</Chip><span className="flex-1">{title} · {doneLabel(rs[0])}</span><Icon name="check" className="h-4 w-4" /></div>
            : <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-surface/70 px-3 py-2.5 text-sm"><Chip tone={tone}>{tag}</Chip><span className="min-w-0 flex-1"><b>{title}</b>{sub && <span className="text-muted"> · {sub}</span>}</span>
              {canDesk && <>{extra}<button className="btn btn-sm btn-primary" disabled={upd.isPending} onClick={onAction}>{action}</button>
                <MoreMenu items={[...(call ? [{ label: 'Not today · call in 3 days', onClick: () => later(pending, v.patient.id, 3) }, { label: 'Not today · call in a week', onClick: () => later(pending, v.patient.id, 7) }, { label: 'Not today · call in a month', onClick: () => later(pending, v.patient.id, 30) }] : [{ label: 'Explain later', onClick: () => later(pending, v.patient.id, 0) }]),
                  { label: 'Patient declined', danger: true, onClick: () => decline(ids, tag) }]} /></>}</div>;
        };
        return (
          <div key={v.id} className={bare ? '' : 'card !p-4'}>
            <div className={`flex flex-wrap items-center gap-2 ${bare ? 'hidden' : ''}`}><b className="text-[16px]">{v.patient.fullName}</b><FlagChips flags={v.patient.flags} /><span className="text-xs text-muted">{v.opNumber} · seen {v.completedAt ? hhmm(v.completedAt) : ''}{v.doctor ? ` by ${v.doctor}` : ''}{v.patient.phone ? ` · ${v.patient.phone}` : ''}</span><span className="ml-auto" />{open.length ? <Chip tone="amber">{open.length} open</Chip> : <Chip>ready to close</Chip>}</div>
            <div className="mt-2.5 space-y-1.5">
              {procs.map((r) => <Item key={r.id} tag="procedure" tone="sky" title={r.procedure ?? 'Procedure'} sub={[r.sittings ? `${r.sittings} sessions planned` : null, r.amountPaise ? `${money(r.amountPaise)} custom price` : null].filter(Boolean).join(' · ') || undefined} rs={[r]} action={r.procedureId ? 'Plan' : 'Schedule'} onAction={() => r.procedureId ? setCourse({ rec: { ...r, patient: v.patient }, patient: v.patient }) : setSched({ rec: { ...r, patient: v.patient }, patient: v.patient })} />)}
              {tests.length > 0 && <Item tag="tests" tone="clay" title={tests.map((r) => r.notes).filter(Boolean).join(', ') || 'Tests'} sub="Explain to the patient" rs={tests} action="Explained" onAction={() => act(tests.filter((r) => r.status === 'open').map((r) => r.id), 'contacted', 'Explained').then(() => toast('Marked: tests explained', 'info'))} />}
              {fus.map((r) => <Item key={r.id} tag="follow-up" tone="amber" title={r.dueOn ? `Review around ${fmtDate(r.dueOn)}` : 'Review'} rs={[r]} action="Book visit" onAction={() => nav(`?book=1&patient=${v.patient.id}&pname=${encodeURIComponent(v.patient.fullName)}&rec=${r.id}${r.dueOn ? `&day=${r.dueOn}` : ''}${v.practitionerId ? `&doc=${v.practitionerId}` : ''}`)} />)}
              {waitingRep && <div className="flex items-center gap-2 rounded-2xl bg-surface/70 px-3 py-2.5 text-sm"><Chip tone="amber">reports</Chip><span className="min-w-0 flex-1"><b>{got} of {tst.length} received</b><span className="text-muted"> · carries on in Awaiting reports, it does not hold up closing</span></span></div>}
            </div>
            {canDesk && <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line/60 pt-3"><span className="text-xs text-muted">{open.length ? 'Close visit unlocks when nothing above is pending.' : 'Nothing pending.'}</span><span className="ml-auto" />
              {v.encounterId && !bare && <button className="btn btn-sm" onClick={() => openPrint({ title: 'Prescription', rx: v.encounterId })}><Icon name="print" className="h-3.5 w-3.5" />Print Rx</button>}
              {canForce && open.length > 0 && <button className="btn btn-sm" disabled={close.isPending} onClick={() => closeWithReason(v.id)}>Close with a reason</button>}
              <button className="btn btn-sm btn-primary" disabled={close.isPending || open.length > 0} onClick={() => close.mutate({ id: v.id })}><Icon name="check" className="h-3.5 w-3.5" />Close visit</button></div>}
          </div>);
      })}
      {course && <CourseDialog rec={course.rec} patientId={course.patient.id} patientName={course.patient.fullName} onClose={() => setCourse(null)} />}
      {sched && <ScheduleModal rec={sched.rec} onClose={() => { setSched(null); plansRefresh(); }} />}
    </div>
  );
}

/** Every consultation held open for reports, across days: what is in, what is pending, how late, and Send in when the patient is here with full or partial results. */
function ReportsQueue({ orders, visits, canDesk, freeDays, onArrive, onSendIn }: { orders: any[]; visits: any[]; canDesk: boolean; freeDays: number; onArrive: (x: any) => void; onSendIn: (visitId: string) => void }) {
  const nav = useNavigate();
  if (orders.length === 0) return <div className="card"><Empty icon="check" title="No reports are being waited for" hint="When the doctor orders tests, the consultation stays here until the reports are in and the doctor has completed it." /></div>;
  const dayMs = 86400000;
  return (
    <div className="space-y-2 anim-fade-up">
      {orders.map((o) => {
        const today = visits.find((v) => v.details?.reportsEncounterId === o.encounterId && ['waiting', 'screened', 'in_consult'].includes(v.status));
        const daysSince = Math.floor((Date.now() - new Date(o.orderedAt).getTime()) / dayMs); const free = daysSince <= freeDays;
        const pending = o.tests.filter((t: any) => !t.receivedAt);
        return (
          <div key={o.key} className="card flex flex-wrap items-center gap-x-4 gap-y-2 !py-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2"><b className="text-[14px]">{o.patient.fullName}</b><span className="text-xs text-muted">{o.patient.patientNo}{o.doctor ? ` · ${o.doctor}` : ''} · ordered {fmtDate(o.orderedAt)}</span>
                {o.late.length > 0 && <Chip tone="rose">late: {o.late.join(', ')}</Chip>}{o.state === 'ready' && <Chip tone="sage">all results in</Chip>}{o.state === 'partial' && <Chip tone="amber">{o.got} of {o.tests.length} in</Chip>}{o.state === 'pending' && <Chip>waiting for the lab</Chip>}{['reviewed', 'doctor_call'].includes(o.state) && <Chip tone="sky">reviewed · patient to be told</Chip>}</div>
              <div className="mt-0.5 text-xs text-muted">{o.tests.map((t: any) => `${t.name} (${t.receivedAt ? 'in' : t.expectedOn ? `expected ${fmtDate(t.expectedOn)}` : 'pending'})`).join(' · ')}</div>
            </div>
            {canDesk && (today ? (today.status === 'in_consult' ? <Chip tone="clay">with the doctor</Chip> : <button className="btn btn-sm btn-primary" onClick={() => onSendIn(today.id)}>Send in</button>)
              : <button className="btn btn-sm btn-primary" title={free ? `Within ${freeDays} days: no form and no fee, straight to the doctor for the report review` : `More than ${freeDays} days: check in with the usual fee`} onClick={() => onArrive({ patientId: o.patient.id, name: o.patient.fullName, reports: { encounterId: o.encounterId, tests: o.tests.map((t: any) => t.name).join(', '), free, since: o.orderedAt } })}>{free ? 'Send in' : 'Patient is here'}{pending.length ? ' · partial' : ''}</button>)}
            <button className="btn btn-sm" onClick={() => nav('/tests')}>Reports</button>
          </div>);
      })}
    </div>
  );
}
