import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useNavigate, useOutletContext, useSearchParams } from 'react-router';
import { get, post, patch, qc, uuid, ApiError, today, errText, listOut, dialable } from '../api';
import { openPrint } from '../printPreview';
import { ScheduleModal } from './Worklist';
import { can } from '../App';
import { FlagChips } from '../flags';
import { CourseDialog } from '../courses';
import { Avatar, Chip, Floating, Icon, Modal, MoneyInput, MoreMenu, Num, Segmented, Skeleton, cleanMoney, money, toast, fmtDate, toPaise, ask, Empty } from '../ui';
import { useTemplates, norm } from '../templates';
import { chime, makeOnceWatcher } from '../chime';

type Ctx = { me: any; perms: string[]; cfg: any };
const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
const minsSince = (iso: string) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
const toHHMM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const shiftDay = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

type Tab = 'waiting' | 'scheduled' | 'doctor' | 'checkout' | 'reports' | 'completed' | 'all' | 'needs' | 'history';

/** Download rows as CSV (opens in Excel). Values are quoted; a BOM keeps Telugu/Hindi names intact. */
function downloadCsv(filename: string, rows: (string | number | null | undefined)[][]) {
  const csv = rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url);
}

/** The receptionist's home as one board: every patient is a row, the stage is a tab, Waiting is the default. */
export function FrontDesk() {
  const { perms, cfg, me } = useOutletContext<Ctx>();
  const canList = !!(me as any)?.privacy?.canExport; // lists of patients: roles the owner allows
  const nav = useNavigate();
  const day = today(); const isToday = true;
  const q = useQuery({ queryKey: ['frontdesk', day], queryFn: () => get(`/frontdesk?day=${day}`), refetchInterval: isToday ? 5000 : false });
  const [tab, setTab] = useState<Tab>('waiting');
  const [sel, setSel] = useState<Set<string> | null>(null); // bulk: the ticked rows on Waiting or Not yet arrived; null when not selecting
  useEffect(() => setSel(null), [tab]);
  const [docFilter, setDocFilter] = useState<string | null>(null); // one doctor's queue, or everyone
  const [arriveKey, setArriveKey] = useState(0);
  const [arrive, setArrive] = useState<null | { patientId?: string; appointmentId?: string; name?: string; reports?: { encounterId: string; tests: string; free: boolean; since: string } }>(null);
  const find = '';
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [sp, setSp] = useSearchParams();
  useEffect(() => { if (sp.get('arrive')) { setArrive({}); setSp({}, { replace: true }); } }, [sp]);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['frontdesk'] }); qc.invalidateQueries({ queryKey: ['queue'] }); };
  const upVisit = useMutation({ mutationFn: ({ id, ...b }: any) => patch(`/visits/${id}`, b), onSuccess: refresh });
  const upAppt = useMutation({ mutationFn: ({ id, ...b }: any) => patch(`/appointments/${id}`, b), onSuccess: () => { refresh(); toast('Updated', 'info'); } });
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
  const collect = useMutation({ mutationFn: ({ c, method }: any) => post('/payments', { patientId: c.patientId, chargeId: c.id, amountPaise: c.amountPaise, method, idempotencyKey: uuid() }), onSuccess: () => { refresh(); toast('Collected'); } });
  const openEncounter = useMutation({ mutationFn: (visitId: string) => post(`/visits/${visitId}/encounter`), onSuccess: (e: any) => nav(`/encounter/${e.id}`, { viewTransition: true }) });
  const d = q.data;
  const isClinical = can(perms, 'encounter.intake'); const canDesk = can(perms, 'visit.write');
  const landed = useRef(false);
  const f = find.trim().toLowerCase();
  const match = (p: any, extra = '') => !f || p.fullName.toLowerCase().includes(f) || (p.phone ?? '').includes(f) || p.patientNo.toLowerCase().includes(f) || extra.toLowerCase().includes(f);

  const visitsAll: any[] = d?.visits ?? [];
  const visits: any[] = docFilter ? visitsAll.filter((v) => v.practitionerId === docFilter) : visitsAll;
  const scheduled: any[] = (d?.appointments ?? []).filter((a: any) => ['booked', 'confirmed', 'requested'].includes(a.status) && match(a.patient));
  const noShows: any[] = (d?.appointments ?? []).filter((a: any) => a.status === 'no_show' && match(a.patient));
  const waiting = visits.filter((v) => ['waiting', 'intake', 'screened'].includes(v.status) && match(v.patient, v.opNumber));
  const screening: 'off' | 'first' | 'required' = cfg?.tenant?.settings?.screening ?? 'off';
  const isDoctorUser = can(perms, 'encounter.complete'); const isJunior = isClinical && !isDoctorUser;
  const reportsQ = useQuery({ queryKey: ['orders'], queryFn: () => get('/orders'), refetchInterval: 30000, enabled: can(perms, 'document.read') });
  const reportsOpen: any[] = ((reportsQ.data?.orders ?? []) as any[]).filter((o) => o.state !== 'closed');
  // the doctor pulled someone in: the desk hears it once
  const called = useRef(makeOnceWatcher<string>()); const [calling, setCalling] = useState<any[]>([]);
  useEffect(() => {
    const byDoc = visits.filter((v) => v.status === 'in_consult' && v.details?.calledBy === 'doctor' && v.details?.calledAt && Date.now() - new Date(v.details.calledAt).getTime() < 10 * 60_000);
    called.current(byDoc.map((v) => v.id), (fresh) => { if (!canDesk) return; chime('call'); setCalling(byDoc.filter((v) => fresh.includes(v.id))); setTimeout(() => setCalling([]), 45_000); });
  }, [visits]);
  const inConsult = visits.filter((v) => v.status === 'in_consult' && match(v.patient, v.opNumber));
  const completed = visits.filter((v) => ['done', 'left'].includes(v.status) && match(v.patient, v.opNumber)).sort((a, b) => (b.completedAt ?? b.arrivedAt).localeCompare(a.completedAt ?? a.arrivedAt));
  const late = scheduled.filter((a) => isToday && toMin(a.window.endTime) < nowMin());
  // finished with the doctor, but the plan still needs the desk: schedule the procedure, hand over the lab slip, book the review
  const checkout = visits.filter((v) => v.status === 'done' && !visitClosed(v) && (v.recommendations ?? []).some((r: any) => r.status !== 'cancelled') && match(v.patient, v.opNumber));
  const withDue = visits.filter((v) => v.due.length);
  const needsCount = late.length + withDue.length;
  const dueTotal = withDue.reduce((s, v) => s + v.due.reduce((x: number, c: any) => x + c.amountPaise, 0), 0);
  const collected = (d?.payments ?? []).reduce((s: number, p: any) => s + p.total, 0);
  useEffect(() => { if (d && !landed.current) { landed.current = true; if (!waiting.length && scheduled.length && canDesk) setTab('scheduled'); } }, [d]);
  const longest = waiting.length ? Math.max(...waiting.map((v) => minsSince(v.arrivedAt))) : 0;
  const dayLabel = new Date(day + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });
  const docName = (id: string | null) => cfg?.practitioners.find((p: any) => p.id === id)?.name ?? '—';
  const tabs: [Tab, string, number][] = [['waiting', 'Waiting', waiting.length], ['scheduled', 'Not yet arrived', scheduled.length], ['doctor', 'With doctor', inConsult.length], ['checkout', 'Checkout', checkout.length], ['reports', 'Reports pending', reportsOpen.length], ['completed', 'Completed', completed.length + noShows.length], ['all', 'All', visits.length + scheduled.length + noShows.length], ['needs', 'Needs you', needsCount], ['history', 'History', -1]];

  type Row = { type: 'waiting' | 'doctor' | 'appt' | 'noshow' | 'done'; v?: any; a?: any; i?: number };
  const W = { group: 'Waiting · in order', rows: waiting.map((v, i): Row => ({ type: 'waiting', v, i })) };
  const S = { group: 'Scheduled · not yet arrived', rows: scheduled.map((a): Row => ({ type: 'appt', a })) };
  const D = { group: 'With the doctor', rows: inConsult.map((v): Row => ({ type: 'doctor', v })) };
  const C = { group: 'Completed · newest first', rows: [...completed.map((v): Row => ({ type: 'done', v })), ...noShows.map((a): Row => ({ type: 'noshow', a }))] };
  const N = { group: 'Needs you', rows: [...late.map((a): Row => ({ type: 'appt', a })), ...withDue.map((v): Row => ({ type: 'done', v }))] };
  const groups = ({ waiting: [W], scheduled: [S], doctor: [D], completed: [C], needs: [N], checkout: [], reports: [], all: [W, D, S, C], history: [] } as Record<Tab, { group: string; rows: Row[] }[]>)[tab].filter((g) => g.rows.length);
  const emptyText: Record<Tab, string> = { waiting: 'Nobody waiting', scheduled: 'Everyone booked has arrived', doctor: 'Consultation room is free', completed: 'Nothing completed yet', checkout: 'Nothing pending after the doctor', reports: 'No reports are being waited for', all: 'Nothing on this day', needs: 'All clear', history: '' };

  const exportRows = () => {
    const out: (string | number | null | undefined)[][] = [['Date', 'Token / time', 'Patient', 'Age', 'Sex', 'Phone', 'Stage', 'Doctor', 'Note']];
    for (const g of groups) for (const r of g.rows) {
      const p = (r.v ?? r.a).patient;
      const stage = r.type === 'waiting' ? 'waiting' : r.type === 'doctor' ? 'with doctor' : r.type === 'appt' ? 'not yet arrived' : r.type === 'noshow' ? 'no-show' : r.v.status === 'left' ? 'left' : 'completed';
      const note = r.type === 'done' ? (r.v.recommendations ?? []).map((x: any) => x.kind === 'procedure' ? x.procedure : x.kind === 'investigation' ? `Test ${x.notes}` : `Review ${x.dueOn ?? ''}`).join('; ') : (r.v?.details?.complaint ?? r.a?.note ?? '');
      out.push([day, r.v ? r.v.opNumber : r.a.window.startTime, p.fullName, p.ageYears, p.sex, p.phone, stage, r.v ? r.v.doctor : docName(r.a.window.practitionerId), note]);
    }
    downloadCsv(`front-desk-${tab}-${day}.csv`, out);
  };

  const who = (p: any) => <><b className="text-[14px]">{p.fullName}</b><FlagChips flags={p.flags} /><span className="text-muted">{[p.ageYears, p.sex].filter(Boolean).join(' ')}</span></>;
  const meta = (xs: (string | null | undefined | false)[]) => xs.filter(Boolean).join(' · ');
  const Row = ({ token, tokenCls = '', top, sub, actions, cls = '' }: { token: React.ReactNode; tokenCls?: string; top: React.ReactNode; sub: React.ReactNode; actions: React.ReactNode; cls?: string }) => (
    <div className={`flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-line/70 px-5 py-3.5 first:border-t-0 hover:bg-surface-2 anim-fade-up ${cls}`}>
      <span className={`w-[76px] shrink-0 text-[16px] font-bold tracking-tight ${tokenCls}`}>{token}</span>
      <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-x-2 gap-y-1">{top}</div><div className="mt-0.5 text-[12px] text-muted">{sub}</div></div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">{actions}</div>
    </div>);
  const render = (r: Row) => {
    if (r.type === 'waiting') { const v = r.v; const i = r.i!; const withJr = v.status === 'intake'; const needsJr = screening === 'required' && v.status === 'waiting';
      const inside = visitsAll.filter((x) => x.status === 'in_consult' && (!v.practitionerId || !x.practitionerId || x.practitionerId === v.practitionerId)).length; const full = inside >= ROOM_MAX; return (
      <Row key={v.id} token={<span className="flex items-center gap-2">{pick(v.id)}{v.opNumber}</span>} tokenCls={`${i === 0 && !withJr ? 'text-clay' : ''} ${sel ? '!w-[108px]' : ''}`}
        top={<>{who(v.patient)}{withJr ? <Chip tone="sky">with junior</Chip> : v.details?.reportsEncounterId ? <Chip tone="amber">back with reports</Chip> : v.status === 'screened' ? <Chip tone="sage">screened</Chip> : v.priority > 0 ? <Chip tone="amber">priority</Chip> : i === 0 ? <Chip tone="clay">next</Chip> : null}{v.doctor ? <Chip>{v.doctor}</Chip> : <Chip tone="rose">no doctor</Chip>}</>}
        sub={meta([v.patient.patientNo, v.patient.phone, `arrived ${hhmm(v.arrivedAt)} · waited ${minsSince(v.arrivedAt)} min`, v.category, v.details?.complaint, v.details?.weight_kg && `${v.details.weight_kg} kg`, v.details?.bp && `BP ${v.details.bp}`])}
        actions={<>
          {isJunior && v.status === 'waiting' && <button className="btn btn-sm btn-primary" onClick={() => openEncounter.mutate(v.id)}>Intake</button>}
          {isDoctorUser && <button className="btn btn-sm" disabled={withJr} title={withJr ? 'With the junior doctor right now' : 'Open the consultation yourself; the desk is told'} onClick={() => openEncounter.mutate(v.id)}>Open</button>}
          {canDesk && <button className="btn btn-sm" onClick={() => nav(`/patients/${v.patient.id}`)}>Record</button>}
          {canDesk && <button className="btn btn-sm btn-primary" disabled={withJr || needsJr || full || upVisit.isPending} title={withJr ? 'With the junior doctor right now' : needsJr ? 'Screening first: the junior doctor sees them before the doctor' : full ? `${inside} already inside: the room takes ${ROOM_MAX}. Send the next one in when someone comes out.` : 'Send the patient in to the doctor'} onClick={() => upVisit.mutate({ id: v.id, status: 'in_consult' })}>{full ? 'Room full' : 'Send in'}</button>}
          {canDesk && <MoreMenu items={[{ label: 'Move up', hidden: i === 0, onClick: () => upVisit.mutate({ id: v.id, afterVisitId: i >= 2 ? waiting[i - 2].id : null }) }, { label: 'Change doctor', hidden: !(d?.doctors ?? []).length, onClick: () => { const next = (d?.doctors ?? []).find((x: any) => x.id !== v.practitionerId); if (next) upVisit.mutate({ id: v.id, practitionerId: next.id }); } }, { label: 'Call patient', href: `tel:${v.patient.phone ?? ''}`, hidden: !dialable(v.patient.phone) }, { label: 'Left without consultation', danger: true, onClick: () => upVisit.mutate({ id: v.id, status: 'left' }) }]} />}
        </>} />); }
    if (r.type === 'doctor') { const v = r.v; return (
      <Row key={v.id} token={v.opNumber}
        top={<>{who(v.patient)}<Chip tone={v.details?.doctorOpenedAt || v.details?.calledBy !== 'desk' ? 'sage' : 'amber'}><span className={`mr-1 inline-block h-1.5 w-1.5 rounded-full ${v.details?.doctorOpenedAt || v.details?.calledBy !== 'desk' ? 'bg-sage breathe' : 'bg-amber'}`} />{v.details?.doctorOpenedAt || v.details?.calledBy !== 'desk' ? 'with the doctor' : 'inside · waiting'}</Chip>{v.doctor && <Chip>{v.doctor}</Chip>}</>}
        sub={meta([v.patient.patientNo, v.details?.calledAt && `${v.details.calledBy === 'desk' ? 'sent in' : 'called by doctor'} ${hhmm(v.details.calledAt)}`, v.details?.complaint])}
        actions={<>{isClinical && <button className="btn btn-sm" onClick={() => openEncounter.mutate(v.id)}>Open</button>}{canDesk && <button className="btn btn-sm" onClick={() => nav(`/patients/${v.patient.id}`)}>Record</button>}</>} />); }
    if (r.type === 'appt') { const a = r.a; const isLate = isToday && toMin(a.window.endTime) < nowMin(); return (
      <Row key={a.id} token={<span className="flex items-center gap-2">{pick(a.id)}{a.window.startTime}</span>} tokenCls={`${isLate ? 'text-rose' : ''} ${sel ? '!w-[108px]' : ''}`} cls={isLate ? 'bg-rose-soft/30' : ''}
        top={<>{who(a.patient)}{isLate ? <Chip tone="rose">not arrived</Chip> : a.status === 'confirmed' ? <Chip tone="sage">confirmed</Chip> : a.status === 'requested' ? <Chip tone="clay">online request</Chip> : <Chip>booked</Chip>}<Chip>{docName(a.window.practitionerId)}</Chip></>}
        sub={meta([a.patient.patientNo, a.patient.phone, a.patient.locality, a.service, a.note])}
        actions={<>{canDesk && isToday && <button className="btn btn-sm btn-primary" onClick={() => setArrive({ patientId: a.patientId, appointmentId: a.id, name: a.patient.fullName })}>Check in</button>}{canDesk && <MoreMenu items={[{ label: 'Call patient', href: `tel:${a.patient.phone ?? ''}`, hidden: !dialable(a.patient.phone) }, { label: 'Mark no-show', danger: true, onClick: () => upAppt.mutate({ id: a.id, status: 'no_show' }) }]} />}</>} />); }
    if (r.type === 'noshow') { const a = r.a; return (
      <Row key={a.id} token={a.window.startTime} cls="opacity-70"
        top={<>{who(a.patient)}<Chip tone="rose">no-show</Chip><Chip>{docName(a.window.practitionerId)}</Chip></>}
        sub={meta([a.patient.phone, 'did not arrive'])}
        actions={canDesk && <button className="btn btn-sm" onClick={() => nav(`/calendar?book=1&patient=${a.patientId}&pname=${encodeURIComponent(a.patient.fullName)}`)}>Rebook</button>} />); }
    const v = r.v; const due = v.due.reduce((x: number, c: any) => x + c.amountPaise, 0); const handled = !!v.details?.explainedAt; const left = v.status === 'left';
    return (
      <Row key={v.id} token={v.opNumber} cls={due ? 'bg-rose-soft/30' : handled || left ? 'opacity-70' : ''}
        top={<>{who(v.patient)}{due ? <Chip tone="rose">{money(due)} due</Chip> : left ? <Chip>left</Chip> : v.encounterStatus === 'awaiting_reports' ? <Chip tone="amber">held for reports</Chip> : <Chip tone="sage">completed</Chip>}{v.doctor && <Chip>{v.doctor}</Chip>}
          {!left && v.recommendations.map((rc: any) => <Chip key={rc.id} tone={rc.kind === 'procedure' ? 'sky' : rc.kind === 'investigation' ? 'clay' : 'amber'}>{rc.kind === 'procedure' ? `${rc.procedure ?? 'Procedure'}${rc.sittings ? ` × ${rc.sittings}` : ''}` : rc.kind === 'investigation' ? `Test: ${rc.notes}` : `Review ${rc.dueOn ? fmtDate(rc.dueOn) : ''}`}</Chip>)}</>}
        sub={meta([v.patient.patientNo, v.patient.phone, left ? `left · arrived ${hhmm(v.arrivedAt)}` : v.completedAt ? `finished ${hhmm(v.completedAt)}` : null, left ? 'did not see the doctor' : v.rxCount ? `${v.rxCount} medicine${v.rxCount === 1 ? '' : 's'} · pharmacy has the Rx` : v.recommendations.length ? null : 'nothing to arrange'])}
        actions={<>
          {canDesk && v.due[0] && <button className="btn btn-sm btn-primary" onClick={() => collect.mutate({ c: v.due[0], method: 'cash' })}>Collect {money(v.due[0].amountPaise)}</button>}
          {canDesk && !left && !handled && !v.due.length && v.recommendations.length > 0 && <button className="btn btn-sm btn-primary" onClick={() => upVisit.mutate({ id: v.id, details: { explainedAt: new Date().toISOString() } })}><Icon name="check" className="h-3.5 w-3.5" />Explained</button>}
          {v.encounterId && !left && <button className="btn btn-sm" onClick={() => openPrint({ title: 'Prescription', rx: v.encounterId })}><Icon name="print" className="h-3.5 w-3.5" />Rx</button>}
          <MoreMenu items={[
            { label: 'Collect by UPI', hidden: !(canDesk && v.due[0]), onClick: () => collect.mutate({ c: v.due[0], method: 'upi' }) },
            { label: 'Open record', onClick: () => nav(`/patients/${v.patient.id}`) },
            { label: 'Mark as explained', hidden: !(canDesk && !left && !handled && v.recommendations.length > 0 && v.due.length > 0), onClick: () => upVisit.mutate({ id: v.id, details: { explainedAt: new Date().toISOString() } }) },
            { label: 'Call patient', href: `tel:${v.patient.phone ?? ''}`, hidden: !dialable(v.patient.phone) },
          ]} />
        </>} />);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="anim-fade-up flex flex-wrap items-center gap-3 mb-4">
        <div className="mr-auto"><h1 className="sr-only">Front desk</h1>
          <div className="text-sm text-muted">{dayLabel}{d && <> · <b className="text-ink"><Num value={waiting.length} /> waiting</b>{waiting.length ? <> · longest <Num value={longest} /> min</> : ''} · <Num value={inConsult.length} /> with the doctor{(can(perms, 'report.daily') || can(perms, 'finance.read')) ? <> · <Num value={collected} format={money} /> collected</> : ''}</>}{isToday && (d?.doctors ?? []).filter((x: any) => x.from).map((x: any) => ` · ${x.name} ${x.from <= toHHMM(nowMin()) ? `until ${x.until}` : `from ${x.from}`}`).join('')}</div></div>
        {tab === 'history'
          ? <div className="flex flex-wrap items-center gap-2 no-print"><button className="btn" onClick={() => setTab('waiting')}><Icon name="chevL" className="h-4 w-4" />Back to today</button><div ref={setSlot} className="flex flex-wrap items-center gap-2" /></div>
          : <div className="flex items-center gap-1.5 no-print">{canDesk && <button className="btn" onClick={() => setTab('history')}><Icon name="clock" className="h-4 w-4" />History</button>}{canList && <button className="btn btn-icon" title="Print" aria-label="Print" onClick={() => listOut(`Printed the front desk list (${tab})`, undefined, () => window.print())}><Icon name="print" /></button>}{canDesk && canList && <button className="btn btn-icon" title="Export to Excel" aria-label="Export to Excel" onClick={() => listOut(`Downloaded the front desk list (${tab})`, undefined, exportRows)}><Icon name="export" /></button>}</div>}
      </div>

      {calling.length > 0 && <div role="alert" className="mb-3 flex flex-wrap items-center gap-3 rounded-[12px] border border-line-2 bg-paper-2 px-4 py-3 text-[14px] anim-fade-up"><Icon name="bell" className="h-5 w-5 text-clay" />{calling.map((v) => <span key={v.id}><b>{v.doctor ?? 'The doctor'}</b> is calling <b>{v.patient.fullName}</b> · token {v.opNumber}</span>)}<button className="btn btn-sm ml-auto" onClick={() => setCalling([])}>Sent</button></div>}
      {!d ? <Skeleton rows={3} /> : (
        <div className={`grid items-start gap-4 ${canDesk && tab !== 'history' ? 'xl:grid-cols-[380px_minmax(0,1fr)]' : ''}`}>
          {canDesk && tab !== 'history' && <div className="xl:sticky xl:top-[84px] xl:max-h-[calc(100dvh-100px)] xl:self-start xl:overflow-y-auto xl:rounded-2xl"><ArrivalSheet key={`${arriveKey}:${arrive?.patientId ?? ''}:${arrive?.appointmentId ?? ''}:${arrive?.reports?.encounterId ?? ''}`} inline init={arrive ?? {}} cfg={cfg} perms={perms} todayAppts={scheduled} waitingByDoctor={Object.fromEntries((d?.doctors ?? []).map((x: any) => [x.id, visitsAll.filter((v) => ['waiting', 'intake', 'screened'].includes(v.status) && v.practitionerId === x.id).length]))} onClose={() => { setArrive(null); setArriveKey((k) => k + 1); refresh(); }} /></div>}
          <div className="min-w-0">
            {(d?.doctors ?? []).length > 1 && tab !== 'history' && <div className="mb-2 flex flex-wrap items-center gap-1.5">
              <button type="button" className={`toggle-opt ${!docFilter ? 'on' : ''}`} onClick={() => setDocFilter(null)}>All doctors<span className="ml-1.5 text-muted">{visitsAll.filter((v) => ['waiting', 'intake', 'screened', 'in_consult'].includes(v.status)).length}</span></button>
              {(d?.doctors ?? []).map((x: any) => <button key={x.id} type="button" className={`toggle-opt ${docFilter === x.id ? 'on' : ''}`} onClick={() => setDocFilter(docFilter === x.id ? null : x.id)}>{x.name}<span className="ml-1.5 text-muted">{visitsAll.filter((v) => v.practitionerId === x.id && ['waiting', 'intake', 'screened', 'in_consult'].includes(v.status)).length}</span></button>)}
              {visitsAll.some((v) => !v.practitionerId && ['waiting', 'intake', 'screened'].includes(v.status)) && <span className="text-xs text-rose">{visitsAll.filter((v) => !v.practitionerId && ['waiting', 'intake', 'screened'].includes(v.status)).length} with no doctor picked</span>}
            </div>}
            <div className="mb-3 flex gap-0.5 overflow-x-auto no-scrollbar border-b border-line" role="tablist">
              {([['waiting', 'Waiting', waiting.length, waiting.length > 0], ...(canDesk ? [['scheduled', 'Not yet arrived', scheduled.length, late.length > 0]] : []), ['doctor', 'With doctor', inConsult.length, false], ['checkout', 'Checkout', checkout.length, checkout.length > 0], ['reports', 'Reports pending', reportsOpen.length, reportsOpen.some((o) => o.state === 'ready' || o.state === 'partial')], ['completed', 'Completed', completed.length + noShows.length, false], ['all', 'All', visits.length + scheduled.length + noShows.length, false], ...(canDesk ? [['needs', 'Needs you', needsCount, needsCount > 0]] : [])] as [Tab, string, number, boolean][]).map(([k, l, n, hot]) => (
                <button key={k} role="tab" aria-selected={tab === k} className={`-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] whitespace-nowrap ${tab === k ? 'border-ink font-semibold text-ink' : 'border-transparent font-medium text-muted hover:text-ink'}`} onClick={() => setTab(k)}>{l}<span className={`tabular-nums ${hot && tab !== k ? 'text-clay font-semibold' : tab === k ? 'text-ink' : 'text-muted'}`}><Num value={n} /></span></button>))}
              {canDesk && (tab === 'waiting' || tab === 'scheduled') && (tab === 'waiting' ? waiting : scheduled).length > 0 && <button type="button" className="ml-auto shrink-0 self-center whitespace-nowrap px-3 py-1.5 text-[13px] font-semibold text-muted hover:text-ink" aria-pressed={!!sel} title={tab === 'scheduled' ? 'Tick several bookings and mark them no-show together; the late ones come pre-ticked' : 'Tick several waiting patients and mark them as left together'} onClick={() => setSel(sel ? null : new Set(tab === 'scheduled' ? late.map((a) => a.id) : []))}>{sel ? 'Done' : 'Select'}</button>}
            </div>
            {sel && <div className="mb-3 flex flex-wrap items-center gap-2 rounded-[12px] bg-ink px-3 py-2 text-[13px] text-paper anim-fade-up" role="toolbar" aria-label="Selected rows">
              <b>{sel.size} selected</b>
              <button type="button" className="rounded-[8px] px-2.5 py-1 font-semibold text-paper/80 hover:bg-paper/10" onClick={() => setSel(new Set((tab === 'waiting' ? waiting.map((v) => v.id) : scheduled.map((a) => a.id))))}>All</button>
              {tab === 'scheduled' && late.length > 0 && <button type="button" className="rounded-[8px] px-2.5 py-1 font-semibold text-paper/80 hover:bg-paper/10" onClick={() => setSel(new Set(late.map((a) => a.id)))}>Late only</button>}
              <button type="button" className="rounded-[8px] px-2.5 py-1 font-semibold text-paper/80 hover:bg-paper/10" onClick={() => setSel(new Set())}>None</button>
              <span className="ml-auto" />
              <button type="button" className="inline-flex h-8 items-center gap-1.5 rounded-[8px] bg-paper px-3 font-semibold text-ink hover:bg-paper-2 disabled:opacity-50" disabled={!sel.size || bulk.isPending} onClick={bulkAsk}>{tab === 'scheduled' ? 'Mark no-show' : 'Mark as left'}{sel.size ? ` · ${sel.size}` : ''}</button>
            </div>}
            {tab === 'checkout' ? <CheckoutList visits={checkout} canDesk={canDesk} canForce={can(perms, 'config.write')} /> : tab === 'reports' ? <ReportsQueue orders={reportsOpen} visits={visits} canDesk={canDesk} freeDays={cfg?.tenant?.settings?.reports?.freeDays ?? 30} onArrive={(x) => setArrive(x)} onSendIn={(id) => upVisit.mutate({ id, status: 'in_consult' })} /> : tab === 'history' ? <HistoryPanel canDesk={canDesk} find={find} slot={slot} onBook={(p?: any) => nav(p ? `/calendar?book=1&patient=${p.id}&pname=${encodeURIComponent(p.fullName)}` : '/calendar?book=1')} /> : (
              <div className="card-flat overflow-hidden anim-fade-up" style={{ animationDelay: '80ms' }}>
                {groups.length === 0 && <div className="py-10 text-center text-muted">{emptyText[tab]}</div>}
                {groups.map((g) => g.rows.map(render))}
              </div>)}
          </div>
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
function HistoryPanel({ find, onBook, slot }: { canDesk: boolean; find: string; onBook: (p?: any) => void; slot: HTMLElement | null }) {
  const { perms, me } = useOutletContext<Ctx>();
  const canList = !!(me as any)?.privacy?.canExport;
  const nav = useNavigate();
  const [period, setPeriod] = useState('7');
  const [custom, setCustom] = useState({ from: shiftDay(today(), -13), to: today() });
  const [filter, setFilter] = useState('all');
  const [term, setTerm] = useState(find); const [qd, setQd] = useState(find);
  const [open, setOpen] = useState(false); const fbtn = useRef<HTMLButtonElement>(null);
  const t0 = today();
  const { from, to } = period === 'today' ? { from: t0, to: t0 } : period === 'yesterday' ? { from: shiftDay(t0, -1), to: shiftDay(t0, -1) } : period === '7' ? { from: shiftDay(t0, -6), to: t0 } : period === '30' ? { from: shiftDay(t0, -29), to: t0 } : custom;
  useEffect(() => { const h = setTimeout(() => setQd(term), 300); return () => clearTimeout(h); }, [term]);
  const h = useQuery({ queryKey: ['fd-history', from, to, qd, filter], queryFn: () => get(`/frontdesk/history?from=${from}&to=${to}&q=${encodeURIComponent(qd)}&filter=${filter}`) });
  const refund = useMutation({ mutationFn: (c: any) => post(`/charges/${c.id}/adjust`, { kind: 'refunded', reason: 'left without consultation' }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['fd-history'] }); toast('Refund recorded'); } });
  const rows: any[] = h.data?.rows ?? []; const s = h.data?.summary;
  const outcomeChip = (r: any) => r.outcome === 'completed' ? <Chip tone="sage">completed</Chip> : r.outcome === 'left' ? <Chip>left</Chip> : r.outcome === 'noshow' ? <Chip tone="rose">no-show</Chip> : <Chip tone="amber">{r.outcome.replace('_', ' ')}</Chip>;
  const exportCsv = () => downloadCsv(`front-desk-history-${from}-to-${to}.csv`, [['Date', 'Token / time', 'Patient', 'Age', 'Sex', 'Phone', 'Outcome', 'Doctor', 'What happened'],
    ...rows.map((r) => [r.date, r.token, r.patient.fullName, r.patient.ageYears, r.patient.sex, r.patient.phone, r.outcome, r.doctor, r.kind === 'noshow' ? 'Did not arrive' : r.outcome === 'left' ? 'Left without seeing the doctor' : (r.recommendations ?? []).map((x: any) => x.kind === 'procedure' ? x.procedure : x.kind === 'investigation' ? `Test ${x.notes}` : `Review ${x.dueOn ?? ''}`).join('; ')])]);
  const periodLabel = period === 'custom' ? `${dayOf(custom.from)} – ${dayOf(custom.to)}` : PERIODS.find((p) => p[0] === period)![1];
  const showLabel = SHOWS.find((x) => x[0] === filter)![1];
  const Opt = ({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) => <button type="button" onClick={onClick} className={on ? '!font-semibold' : ''}><span className="flex-1">{children}</span>{on && <Icon name="check" className="h-4 w-4" />}</button>;
  const controls = (
    <>
      <div className="relative"><Icon name="search" className="h-4 w-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" /><input className="input !h-10 !py-0 !pl-10 !w-48 !rounded-full" placeholder="Search all days" value={term} onChange={(e) => setTerm(e.target.value)} /></div>
      <button ref={fbtn} type="button" className={`btn ${open ? '!bg-white' : ''}`} aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="filter" className="h-4 w-4" />{periodLabel}{filter !== 'all' && <span className="text-muted font-medium">· {showLabel}</span>}<Icon name="chevR" className={`h-3.5 w-3.5 transition-transform duration-300 ${open ? '-rotate-90' : 'rotate-90'}`} /></button>
      <Floating anchor={fbtn} open={open} onClose={() => setOpen(false)} width={300}>
        <div className="px-3 pt-2 pb-1 text-[11px] font-bold uppercase tracking-[0.09em] text-muted">Period</div>
        {PERIODS.map(([k, l]) => <Opt key={k} on={period === k} onClick={() => { setPeriod(k); if (k !== 'custom') setOpen(false); }}>{l}</Opt>)}
        {period === 'custom' && <div className="flex items-center gap-2 px-3 pb-2"><input type="date" className="input !py-1.5 !px-2.5 text-xs" value={custom.from} max={custom.to} onChange={(e) => setCustom({ ...custom, from: e.target.value })} /><span className="text-muted text-xs">to</span><input type="date" className="input !py-1.5 !px-2.5 text-xs" value={custom.to} min={custom.from} max={t0} onChange={(e) => setCustom({ ...custom, to: e.target.value })} /></div>}
        <div className="my-1.5 h-px bg-ink/8" />
        <div className="px-3 pt-1 pb-1 text-[11px] font-bold uppercase tracking-[0.09em] text-muted">Show</div>
        {SHOWS.map(([k, l]) => <Opt key={k} on={filter === k} onClick={() => { setFilter(k); setOpen(false); }}>{l}</Opt>)}
        {(period !== '7' || filter !== 'all') && <><div className="my-1.5 h-px bg-ink/8" /><button type="button" onClick={() => { setPeriod('7'); setFilter('all'); setOpen(false); }} className="!text-muted">Reset filters</button></>}
      </Floating>
      {canList && <button className="btn btn-icon" title="Print or save as PDF" aria-label="Print or save as PDF" onClick={() => listOut(`Printed front desk history ${from} to ${to}`, rows.length, () => window.print())}><Icon name="print" /></button>}
      {canList && <button className="btn btn-icon" title="Export to Excel" aria-label="Export to Excel" disabled={!rows.length} onClick={() => listOut(`Downloaded front desk history ${from} to ${to}`, rows.length, exportCsv)}><Icon name="export" /></button>}
    </>
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 anim-fade-up">
      {slot && createPortal(controls, slot)}
      <div className="text-sm text-muted">{s ? <span>{dayOf(from)}{from !== to ? ` – ${dayOf(to)}` : ''} · <b className="text-ink">{s.visits}</b> visits · <b className="text-ink">{s.left}</b> left without consult · <b className="text-ink">{s.noShows}</b> no-shows · <b className="text-ink">{money(s.collectedPaise)}</b> collected</span> : 'Loading…'}</div>
      <div className="card-flat flex min-h-0 flex-1 flex-col overflow-hidden"><div className="min-h-0 flex-1 overflow-auto"><table className="table sticky-head !text-sm min-w-[860px]">
        <thead><tr><th className="pl-4 w-28">Date</th><th className="w-24">Token</th><th>Patient</th><th className="w-36">Outcome</th><th className="w-36">Doctor</th><th>What happened</th><th className="text-right pr-4 w-60 no-print">Action</th></tr></thead>
        <tbody>
          {h.isLoading && <tr><td colSpan={7} className="!py-10 text-center text-muted">Loading…</td></tr>}
          {!h.isLoading && rows.length === 0 && <tr><td colSpan={7} className="!py-10 text-center text-muted">Nothing found for this period</td></tr>}
          {rows.map((r) => { const paid = r.charges.find((c: any) => c.status === 'paid' && c.amountPaise > 0); const adj = r.charges.find((c: any) => ['waived', 'refunded'].includes(c.status));
            return (
            <tr key={r.key}><td className="pl-4">{dayOf(r.date)}<div className="text-xs text-muted">{weekdayOf(r.date)}</div></td>
              <td className={r.kind === 'noshow' ? 'font-semibold' : 'serif text-lg'}>{r.token}</td>
              <td><b>{r.patient.fullName}</b> <span className="text-muted">{r.patient.ageYears ?? ''} {r.patient.sex ?? ''}</span><div className="text-xs text-muted">{r.patient.phone ?? ''}</div></td>
              <td>{outcomeChip(r)}</td><td>{r.doctor ?? '—'}</td>
              <td className="text-xs">{r.kind === 'noshow' ? <span className="text-muted">Did not arrive</span> : r.outcome === 'left' ? <span className="text-muted">Left without seeing the doctor{paid ? ` · ${money(paid.amountPaise)} paid` : ''}</span> : (
                <div className="flex flex-wrap gap-1">{r.recommendations.length ? r.recommendations.map((x: any) => <Chip key={x.id} tone={x.kind === 'procedure' ? 'sky' : x.kind === 'investigation' ? 'clay' : 'amber'}>{x.kind === 'procedure' ? x.procedure ?? 'Procedure' : x.kind === 'investigation' ? `Test: ${x.notes}` : `Review ${x.dueOn ? fmtDate(x.dueOn) : ''}`}</Chip>) : <span className="text-muted">Medicines only</span>}</div>)}
                {adj && <div className="mt-1"><Chip tone="amber">{adj.status}{adj.reason ? ` · ${adj.reason}` : ''}</Chip></div>}</td>
              <td className="text-right pr-4 whitespace-nowrap no-print">
                {r.kind === 'noshow' ? <button className="btn btn-sm btn-primary" onClick={() => onBook(r.patient)}>Rebook</button> : r.outcome === 'left' && paid && can(perms, 'payment.refund') ? <button className="btn btn-sm btn-primary" onClick={() => refund.mutate(paid)}>Refund</button> : <button className="btn btn-sm" onClick={() => nav(`/patients/${r.patient.id}`)}>Open record</button>}
                {(r.kind === 'noshow' || r.outcome === 'left') && <> <MoreMenu items={[{ label: 'Open record', onClick: () => nav(`/patients/${r.patient.id}`) }, { label: 'Call patient', href: `tel:${r.patient.phone ?? ''}` }]} /></>}</td></tr>); })}
        </tbody></table></div>
        {rows.length >= 500 && <div className="px-4 py-3 text-xs text-muted border-t border-ink/8">Showing the newest 500. Narrow the period or search to see older rows.</div>}
      </div>
    </div>
  );
}

/** Vitals every clinic checks by default; the owner switches fields on or off in Settings → Clinic. */
export const VITAL_FIELDS: { key: string; label: string; unit: string; ph: string; type: 'number' | 'text' }[] = [
  { key: 'weight_kg', label: 'Weight', unit: 'kg', ph: '', type: 'number' }, { key: 'height_cm', label: 'Height', unit: 'cm', ph: '', type: 'number' },
  { key: 'temp_f', label: 'Temp', unit: '°F', ph: '98.4', type: 'number' }, { key: 'bp', label: 'BP', unit: 'mmHg', ph: '120/80', type: 'text' },
  { key: 'spo2', label: 'SpO₂', unit: '%', ph: '98', type: 'number' }, { key: 'pulse', label: 'Pulse', unit: 'bpm', ph: '', type: 'number' },
];
export const DEFAULT_VITALS = ['weight_kg', 'height_cm', 'temp_f', 'bp', 'spo2'];

type Complaint = { text: string; duration: string };

/** Arrival: who they are, why this fee, vitals, complaints, which doctor. One screen, one button. */
function ArrivalSheet({ init, cfg, perms, todayAppts, waitingByDoctor, onClose, inline = false }: { inline?: boolean; init: { patientId?: string; appointmentId?: string; name?: string; reports?: { encounterId: string; tests: string; free: boolean; since: string } }; cfg: any; perms: string[]; todayAppts: any[]; waitingByDoctor: Record<string, number>; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [patientId, setPatientId] = useState(init.patientId);
  const [newP, setNewP] = useState<null | { fullName: string; phone: string; ageYears: string; sex: string }>(null);
  const [cat, setCat] = useState('');
  const enabled: string[] = cfg?.tenant.settings?.vitals ?? DEFAULT_VITALS;
  const [vit, setVit] = useState<Record<string, string>>({});
  const [locality, setLocality] = useState('');
  const [list, setList] = useState<Complaint[]>([]);
  const [draft, setDraft] = useState<Complaint>({ text: '', duration: '' });
  const comp = useTemplates('complaint');
  const [method, setMethod] = useState('cash'); const [amount, setAmount] = useState('');
  const [waive, setWaive] = useState(init.reports?.free ? `Back with reports · consultation of ${fmtDate(init.reports.since)}` : '');
  const [pickedDoc, setPractitionerId] = useState('');
  const search = useQuery({ queryKey: ['patients', q], queryFn: () => get(`/patients?q=${encodeURIComponent(q)}`), enabled: !patientId && q.length >= 2 });
  const sug = useQuery({ queryKey: ['suggest', patientId], queryFn: () => get(`/patients/${patientId}/suggest-category`), enabled: !!patientId });
  const tl = useQuery({ queryKey: ['timeline', patientId], queryFn: () => get(`/patients/${patientId}/timeline`), enabled: !!patientId });
  // Checking in from the top button: still link the patient's booking for today, and default to that booking's doctor (else the shortest queue). Tap another doctor to change.
  const appt = todayAppts.find((a) => a.id === init.appointmentId) ?? (patientId ? todayAppts.find((a) => a.patientId === patientId) : undefined);
  const practitionerId = pickedDoc || appt?.window?.practitionerId || [...(cfg?.practitioners ?? [])].sort((a: any, b: any) => (waitingByDoctor[a.id] ?? 0) - (waitingByDoctor[b.id] ?? 0))[0]?.id || '';
  const fallbackCat = cfg?.feeCategories.find((c: any) => c.code === 'GEN')?.code ?? cfg?.feeCategories[0]?.code ?? '';
  const chosen = cat || sug.data?.suggested?.code || (patientId && sug.isLoading ? '' : fallbackCat);
  const [dup, setDup] = useState<null | { id: string; patientNo: string }>(null); const [forceNew, setForceNew] = useState(false);
  const catRow = cfg?.feeCategories.find((c: any) => c.code === chosen);
  const fee = catRow?.amountPaise ?? 0;
  const p = sug.data?.patient;
  const openPlans = (tl.data?.recommendations ?? []).filter((r: any) => !['done', 'cancelled'].includes(r.status));
  const w = Number(vit.weight_kg), h = Number(vit.height_cm);
  const bmi = w > 0 && h > 0 ? Math.round((w / ((h / 100) ** 2)) * 10) / 10 : null;
  const commit = () => { if (draft.text.trim()) { setList([...list, { text: draft.text.trim(), duration: draft.duration.trim() }]); setDraft({ text: '', duration: '' }); } };
  const allowReview = useRef('');
  const submit = useMutation({
    mutationFn: async () => {
      let pid = patientId;
      if (!pid && newP) { const np = await post(forceNew ? '/patients?force=1' : '/patients', { fullName: newP.fullName.trim(), phone: newP.phone || null, ageYears: newP.ageYears ? Number(newP.ageYears) : null, sex: newP.sex || null, locality: locality || null }); pid = np.id; }
      if (!pid) throw new Error('Pick or register a patient');
      const complaints = [...list, ...(draft.text.trim() ? [{ text: draft.text.trim(), duration: draft.duration.trim() }] : [])];
      const vitals: Record<string, any> = {};
      for (const f of VITAL_FIELDS) if (enabled.includes(f.key) && vit[f.key]) vitals[f.key] = f.type === 'number' ? Number(vit[f.key]) : vit[f.key];
      return post('/visits', { patientId: pid, appointmentId: appt?.id ?? init.appointmentId, feeCategoryCode: chosen, practitionerId: practitionerId || null,
        details: { ...vitals, ...(bmi ? { bmi } : {}), locality: locality || p?.locality, complaints, complaint: init.reports ? `Back with reports: ${init.reports.tests}` : complaints.map((c) => c.text).join(', '), ...(init.reports ? { reportsEncounterId: init.reports.encounterId } : {}) },
        payment: !waive && fee > 0 ? { method, amountPaise: toPaise(amount || String(fee / 100)) } : undefined, waive: waive ? { reason: waive } : undefined, allowReview: allowReview.current ? { reason: allowReview.current } : undefined, idempotencyKey: uuid() });
    },
    onSuccess: (v: any) => { toast(`Checked in · token ${v.opNumber}`); onClose(); },
    onError: async (e: any) => {
      if (e instanceof ApiError && e.body.code === 'POSSIBLE_DUPLICATE') setDup(e.body.existing);
      else if (e instanceof ApiError && e.body.code === 'REVIEW_LIMIT') {
        if (!can(perms, 'payment.refund')) { toast(`This patient has already had ${e.body.used} free review since the last paid consultation (the limit is ${e.body.limit}). Choose the paid consultation, or ask the owner to allow one more.`, 'err'); return; }
        const a = await ask({ title: 'Allow one more free review?', body: `${e.body.used} used of ${e.body.limit} since the last paid consultation. The reason is kept in the log.`, confirmLabel: 'Allow and check in', field: { label: 'Why', required: true, maxLength: 200 } });
        if (a?.value) { allowReview.current = a.value; submit.mutate(); }
      } else toast(errText(e), 'err');
    },
  });
  useEffect(() => { if (forceNew) { submit.mutate(); setForceNew(false); } }, [forceNew]);
  const step = !patientId && !newP ? 1 : 2;
  const blocker = !chosen ? 'Pick a visit type' : newP && newP.fullName.trim().length < 2 ? 'Enter the patient\'s name (at least 2 letters)' : newP && newP.phone && newP.phone.length !== 10 ? 'Phone needs 10 digits' : fee > 0 && !waive && toPaise(amount === '' ? String(fee / 100) : amount) <= 0 ? 'Enter the amount collected' : '';
  const facts = sug.data?.facts;
  // a plain function, not a component: a component declared here is a new type on every render and remounts the whole sheet (focus lost, stale buttons)
  const frame = (children: React.ReactNode) => inline
    ? <section className="card-flat p-4 anim-fade-up" aria-label="Check in"><div className="mb-3 flex items-center gap-2"><b className="text-[14px]">{step === 1 ? 'Check in' : 'Arrival'}</b><span className="text-xs text-muted">{step === 1 ? 'phone, name or patient ID' : p?.fullName ?? newP?.fullName ?? ''}</span>{step === 2 && <button type="button" className="btn btn-ghost btn-sm ml-auto" onClick={onClose}>Clear</button>}</div>{children}</section>
    : <Modal title={step === 1 ? 'Who has arrived?' : 'Arrival'} subtitle={step === 1 ? 'Phone, name or patient ID' : undefined} onClose={onClose} width="max-w-2xl">{children}</Modal>;
  return frame(<>
      {step === 1 && (
        <div className="anim-fade-up">
          <div className="relative"><Icon name="search" className="h-4 w-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" /><input autoFocus className="input !pl-10 !py-3" value={q} onChange={(e) => setQ(e.target.value)} placeholder="98765…" /></div>
          <div className="mt-3 card-flat overflow-hidden max-h-64 overflow-y-auto">
            {q.length < 2 ? <div className="p-4 text-sm text-muted">Type at least 2 characters</div> : search.isLoading ? <Skeleton rows={2} /> : (search.data ?? []).length === 0 ? <div className="p-4 text-sm text-muted">No match. Register below.</div> :
              search.data.map((x: any) => <button key={x.id} className="row w-full text-left" onClick={() => setPatientId(x.id)}><Avatar name={x.fullName} /><div className="flex-1 min-w-0"><div className="text-sm font-medium">{x.fullName} <span className="text-muted font-normal text-xs">{x.ageYears ? `${x.ageYears}` : ''} {x.sex ?? ''}</span></div><div className="text-xs text-muted">{x.patientNo} · {x.phone ?? 'no phone'} · {x.locality ?? ''}</div></div><Icon name="chevR" className="text-muted" /></button>)}
          </div>
          <button className="btn mt-3" onClick={() => setNewP({ fullName: /^\d+$/.test(q) ? '' : q, phone: /^\d+$/.test(q) ? q : '', ageYears: '', sex: '' })}><Icon name="plus" />New patient</button>
        </div>
      )}
      {step === 2 && (
        <div className="space-y-4 anim-fade-up">
          {newP ? (
            <div className={inline ? 'grid grid-cols-[minmax(0,1fr)_88px] gap-2' : 'grid grid-cols-6 gap-2'}>
              <div className={inline ? 'col-span-2' : 'col-span-3'}><label className="label">Full name</label><input autoFocus className="input" maxLength={100} value={newP.fullName} onChange={(e) => { setDup(null); setNewP({ ...newP, fullName: e.target.value }); }} /></div>
              <div className={inline ? '' : 'col-span-2'}><label className="label">Phone</label><input className="input" inputMode="numeric" placeholder="10 digits" value={newP.phone} onChange={(e) => { setDup(null); setNewP({ ...newP, phone: e.target.value.replace(/\D/g, '').slice(0, 10) }); }} /></div>
              <div><label className="label">Age</label><input className="input" inputMode="numeric" placeholder="years" value={newP.ageYears} onChange={(e) => { const v = e.target.value.replace(/\D/g, '').slice(0, 3); setNewP({ ...newP, ageYears: v && Number(v) > 120 ? '120' : v }); }} /></div>
              <div className={`${inline ? 'col-span-2' : 'col-span-6'} flex flex-wrap items-center gap-1.5`}>{['M', 'F', 'O'].map((s) => <button key={s} type="button" className={`toggle-opt ${newP.sex === s ? 'on' : ''}`} onClick={() => setNewP({ ...newP, sex: s })}>{s === 'M' ? 'Male' : s === 'F' ? 'Female' : 'Other'}</button>)}<button className="btn btn-ghost btn-sm ml-auto" onClick={() => setNewP(null)}>Back to search</button></div>
            </div>
          ) : (
            <div className="flex items-start gap-3">
              <Avatar name={p?.fullName ?? init.name ?? '?'} size="h-12 w-12 text-sm" />
              <div className="flex-1 min-w-0"><div className="text-xl font-medium leading-tight">{p?.fullName ?? init.name} <span className="text-muted text-base font-normal">{p?.ageYears ?? ''} {p?.sex ?? ''}</span></div><div className="text-xs text-muted mt-0.5">{p ? `${p.patientNo} · ${p.phone ?? 'no phone'} · ${p.locality ?? ''}` : 'loading…'}</div></div>
              {tl.data && <Chip tone={tl.data.visits.length ? 'sage' : ''}>{tl.data.visits.length ? `returning · visit ${tl.data.visits.length + 1}` : 'first visit'}</Chip>}
              {!init.patientId && <button className="btn btn-ghost btn-sm" onClick={() => setPatientId(undefined)}>Change</button>}
            </div>
          )}
          {dup && <div className="flex flex-wrap items-center gap-2 text-sm rounded-xl bg-amber-soft px-3.5 py-2.5" role="alert"><Icon name="spark" className="h-4 w-4 text-amber" /><span>A patient with this name and phone already exists ({dup.patientNo}).</span><button className="btn btn-sm ml-auto" onClick={() => { setPatientId(dup.id); setNewP(null); setDup(null); }}>Use existing</button><button className="btn btn-sm" onClick={() => { setForceNew(true); setDup(null); }}>It is someone else</button></div>}
          {facts && <div className="flex gap-2 items-start text-sm bg-paper rounded-xl px-3.5 py-2.5"><Icon name="spark" className="h-4 w-4 text-clay shrink-0 mt-0.5" /><span>{facts.days_since_last_paid_consult < 9999 ? <>Last paid consult <b>{facts.days_since_last_paid_consult} days ago</b></> : 'No previous paid consult'} → suggested <b>{sug.data.suggested.name}</b>.{openPlans.length > 0 && <> Open plan: {openPlans.map((r: any) => r.kind === 'procedure' ? 'procedure' : r.kind === 'followup' ? `review ${r.dueOn ? fmtDate(r.dueOn) : ''}` : `test ${r.notes}`).join(', ')}.</>}</span></div>}

          <div>
            <div className="flex items-baseline gap-2 mb-1.5"><span className="label !mb-0">Vitals</span><span className="text-xs text-muted">all optional{bmi ? ` · BMI ${bmi}` : ' · BMI is calculated from weight and height'}</span></div>
            <div className="grid gap-2.5" style={{ gridTemplateColumns: inline ? 'repeat(auto-fill, minmax(100px, 1fr))' : `repeat(${Math.min(enabled.length, 5)}, minmax(0, 1fr))` }}>
              {VITAL_FIELDS.filter((f) => enabled.includes(f.key)).map((f) => (
                <div key={f.key}><label htmlFor={`v-${f.key}`} className="text-[10px] font-semibold uppercase tracking-wider text-muted block mb-1">{f.label}</label>
                  <div className="relative"><input id={`v-${f.key}`} className="input !px-3 !pr-11" inputMode={f.type === 'number' ? 'decimal' : 'text'} placeholder={f.ph} value={vit[f.key] ?? ''} maxLength={7} onChange={(e) => setVit({ ...vit, [f.key]: f.type === 'number' ? e.target.value.replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1') : e.target.value.replace(/[^\d/]/g, '') })} /><span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] text-muted pointer-events-none">{f.unit}</span></div></div>
              ))}
            </div>
          </div>

          <div>
            <span className="label">Complaints <span className="font-normal normal-case tracking-normal text-muted">· tap what brings them in; each opens its checklist for the doctors</span></span>
            {(comp.data ?? []).length > 0 && <div className="mb-2.5 flex flex-wrap gap-1.5" role="group" aria-label="Common complaints">{(comp.data ?? []).map((t) => { const on = list.some((c) => norm(c.text) === norm(t.name)); return <button key={t.id} type="button" aria-pressed={on} className={`toggle-opt !py-2 ${on ? 'on' : ''}`} onClick={() => setList(on ? list.filter((c) => norm(c.text) !== norm(t.name)) : [...list, { text: t.name, duration: '' }])}>{t.name}</button>; })}</div>}
            <div className="space-y-2">
              {list.map((c, i) => (
                <div key={i} className={`grid items-center gap-2 anim-scale-in ${inline ? 'grid-cols-[minmax(0,1fr)_92px_40px_40px]' : 'grid-cols-[1fr_150px_44px_44px]'}`}>
                  <div className="input flex items-center !bg-paper">{c.text}</div><div className="input flex items-center !bg-paper text-muted">{c.duration || '—'}</div>
                  <span className="grid place-items-center h-11 rounded-full bg-sage-soft text-sage border border-sage/40" title="Done"><Icon name="check" /></span>
                  <button type="button" className="btn btn-icon !h-11 !w-11" aria-label="Remove complaint" onClick={() => setList(list.filter((_, j) => j !== i))}><Icon name="x" className="h-4 w-4" /></button>
                </div>))}
              <div className={`grid items-center gap-2 ${inline ? 'grid-cols-[minmax(0,1fr)_92px_auto]' : 'grid-cols-[1fr_150px_92px]'}`}>
                <input className="input" aria-label="Complaint" placeholder={list.length ? 'Another complaint…' : 'Main complaint…'} value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }} />
                <input className="input" aria-label="Since when" placeholder={inline ? 'Since' : 'Since when'} value={draft.duration} onChange={(e) => setDraft({ ...draft, duration: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }} />
                <button type="button" className="btn btn-primary !h-10" disabled={!draft.text.trim()} onClick={commit}><Icon name="plus" className="h-4 w-4" />Add</button>
              </div>
            </div>
          </div>

          {init.reports && <div className="rounded-lg bg-amber-soft px-3 py-2 text-[12.5px] text-amber"><b>Back with reports:</b> {init.reports.tests}. No new complaint is needed; the doctor opens the same consultation.{init.reports.free ? ' Within the free-return days, so no fee unless the visit type says otherwise.' : ' Outside the free-return days: the usual fee applies.'}</div>}
          <div className={`grid gap-3 ${inline ? 'grid-cols-[1.5fr_1fr]' : 'grid-cols-2'}`}>
            <div><label htmlFor="visit-type" className="label">Visit type · fee</label>
              <select id="visit-type" className="input" value={chosen} onChange={(e) => setCat(e.target.value)}>{cfg?.feeCategories.map((c: any) => <option key={c.code} value={c.code}>{c.name} · {money(c.amountPaise)}{sug.data?.suggested?.code === c.code ? ' (suggested)' : ''}</option>)}</select></div>
            <div><label htmlFor="locality" className="label">Location</label><input id="locality" className="input" placeholder={p?.locality ?? ''} value={locality} onChange={(e) => setLocality(e.target.value)} /></div>
          </div>
          <div className={`grid gap-3 ${inline ? 'grid-cols-1' : 'grid-cols-2'}`}>
            <div><label className="label">Doctor <span className="font-normal text-muted">· tap to change</span></label><div className="flex flex-wrap gap-1.5">{cfg?.practitioners.map((x: any) => <button key={x.id} type="button" className={`toggle-opt !py-2 ${practitionerId === x.id ? 'on' : ''}`} onClick={() => setPractitionerId(x.id)}>{x.name}<span className={`ml-1.5 font-medium ${practitionerId === x.id ? 'text-paper/70' : 'text-muted'}`}>{waitingByDoctor[x.id] ?? 0} waiting</span></button>)}</div></div>
            <div><label className="label">Payment</label>
              {fee === 0 ? <div className="text-sm text-muted pt-2.5">Nothing to collect for {catRow?.name?.split(' (')[0] ?? 'this visit'}.</div> : waive ? <div className="text-sm text-amber pt-2.5">Waived · {waive}</div> : (
                <div className="flex gap-1.5 items-center flex-wrap">{['cash', 'upi', 'card'].map((m) => <button key={m} type="button" className={`toggle-opt !py-2 ${method === m ? 'on' : ''}`} onClick={() => setMethod(m)}>{m === 'upi' ? 'UPI' : m[0].toUpperCase() + m.slice(1)}</button>)}<MoneyInput className="!w-28" value={amount === '' ? String(fee / 100) : amount} onChange={setAmount} /></div>)}
              {fee > 0 && can(perms, 'payment.waive') && <input className="input mt-2 !py-1.5 text-xs" placeholder="Waive? type the reason (known person, doctor said…)" value={waive} onChange={(e) => setWaive(e.target.value)} />}
            </div>
          </div>
          <div className={inline ? 'flex flex-wrap items-center gap-2 pt-1' : 'modal-foot'}><span className="mr-auto text-xs text-muted" role="status">{blocker}</span><button className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" disabled={submit.isPending || !!blocker} onClick={() => submit.mutate()}><Icon name="check" />Check in{fee > 0 && !waive && !blocker ? ` · collect ${money(toPaise(amount === '' ? String(fee / 100) : amount))}` : ''}</button></div>
        </div>
      )}
  </>);
}

/** How many patients may be inside the consultation room at once (the server enforces the same number). */
const ROOM_MAX = 3;
const visitClosed = (v: any) => !!v.details?.checkoutClosedAt;
const testsOf = (v: any): any[] => (v.recommendations ?? []).filter((r: any) => r.kind === 'investigation' && r.status !== 'cancelled');
/** The lab slip is given for every test, but the doctor has not reviewed and the patient has not been told yet. */
const awaitingReports = (v: any) => { const t = testsOf(v); return v.status === 'done' && t.length > 0 && t.every((r) => r.status !== 'open') && t.some((r) => !r.informedAt); };

const plansRefresh = () => ['frontdesk', 'worklist', 'bookings', 'psessions', 'pcounts', 'calendar'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));

/** After the doctor: every open plan of a finished patient with the one action that settles it. A patient leaves this list when nothing is pending. */
function CheckoutList({ visits, canDesk, canForce }: { visits: any[]; canDesk: boolean; canForce: boolean }) {
  const nav = useNavigate();
  const [sched, setSched] = useState<{ rec: any; patient: any } | null>(null); const [course, setCourse] = useState<{ rec: any; patient: any } | null>(null);
  const upd = useMutation({ mutationFn: ({ id, ...b }: any) => patch(`/worklist/${id}`, b), onSuccess: plansRefresh, onError: (e) => toast(errText(e), 'err') });
  const act = (ids: string[], status: string, outcome: string, note?: string) => Promise.all(ids.map((id) => upd.mutateAsync({ id, status, contact: { outcome, note } })));
  const decline = async (ids: string[], what: string) => { const a = await ask({ title: `Patient declined ${what}?`, body: 'It leaves the pending list and stays in the patient record.', confirmLabel: 'Declined', cancelLabel: 'Keep', field: { label: 'Reason', maxLength: 200 } }); if (a) await act(ids, 'cancelled', 'Declined', a.value || undefined); };
  const later = (ids: string[]) => act(ids, 'contacted', 'Do later');
  const close = useMutation({ mutationFn: ({ id, reason }: { id: string; reason?: string }) => patch(`/visits/${id}`, { details: { checkoutClosedAt: new Date().toISOString(), ...(reason ? { checkoutCloseReason: reason } : {}) } }), onSuccess: () => { plansRefresh(); toast('Visit closed', 'info'); }, onError: (e) => toast(errText(e), 'err') });
  const closeWithReason = async (id: string) => { const a = await ask({ title: 'Close this visit with things still open?', body: 'The reason is written to the audit log.', confirmLabel: 'Close visit', cancelLabel: 'Keep open', field: { label: 'Reason (patient left, declined…)', required: true, maxLength: 200 } }); if (a?.value) close.mutate({ id, reason: a.value }); };
  if (visits.length === 0) return <div className="card"><Empty icon="check" title="Nothing pending after the doctor" hint="When the doctor advises a procedure, tests or a review, the patient shows here until each is arranged." /></div>;
  return (
    <div className="space-y-3 anim-fade-up">
      {visits.map((v) => {
        const recs: any[] = (v.recommendations ?? []); const open = recs.filter((r) => r.status === 'open'); const tst = testsOf(v); const got = tst.filter((r) => r.status === 'done').length; const waitingRep = awaitingReports(v);
        const procs = recs.filter((r) => r.kind === 'procedure'); const fus = recs.filter((r) => r.kind === 'followup'); const tests = recs.filter((r) => r.kind === 'investigation');
        const doneLabel = (r: any) => r.status === 'scheduled' ? (r.kind === 'procedure' ? 'Scheduled' : 'Booked') : r.status === 'cancelled' ? 'Declined' : r.status === 'done' ? 'Done' : (r.contactLog?.[r.contactLog.length - 1]?.outcome ?? 'Handled');
        const Item = ({ tag, tone, title, sub, rs, action, onAction, extra }: { tag: string; tone: 'sky' | 'clay' | 'amber'; title: string; sub?: string; rs: any[]; action: string; onAction: () => void; extra?: React.ReactNode }) => {
          const pending = rs.filter((r) => r.status === 'open'); const ids = pending.map((r) => r.id);
          return pending.length === 0
            ? <div className="flex items-center gap-2 rounded-2xl px-3 py-2 text-sm opacity-60"><Chip>done</Chip><span className="flex-1">{title} · {doneLabel(rs[0])}</span><Icon name="check" className="h-4 w-4" /></div>
            : <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-white/70 px-3 py-2.5 text-sm"><Chip tone={tone}>{tag}</Chip><span className="min-w-0 flex-1"><b>{title}</b>{sub && <span className="text-muted"> · {sub}</span>}</span>
              {canDesk && <>{extra}<button className="btn btn-sm btn-primary" disabled={upd.isPending} onClick={onAction}>{action}</button>
                <MoreMenu items={[{ label: 'Patient declined', danger: true, onClick: () => decline(ids, tag) }, { label: 'Do later', onClick: () => later(ids) }]} /></>}</div>;
        };
        return (
          <div key={v.id} className="card !p-4">
            <div className="flex flex-wrap items-center gap-2"><b className="text-[16px]">{v.patient.fullName}</b><FlagChips flags={v.patient.flags} /><span className="text-xs text-muted">{v.opNumber} · seen {v.completedAt ? hhmm(v.completedAt) : ''}{v.doctor ? ` by ${v.doctor}` : ''}{v.patient.phone ? ` · ${v.patient.phone}` : ''}</span><span className="ml-auto" />{open.length ? <Chip tone="amber">{open.length} open</Chip> : <Chip>ready to close</Chip>}</div>
            <div className="mt-2.5 space-y-1.5">
              {procs.map((r) => <Item key={r.id} tag="procedure" tone="sky" title={r.procedure ?? 'Procedure'} sub={r.sittings ? `${r.sittings} sittings planned` : undefined} rs={[r]} action={r.procedureId ? 'Plan' : 'Schedule'} onAction={() => r.procedureId ? setCourse({ rec: { ...r, patient: v.patient }, patient: v.patient }) : setSched({ rec: { ...r, patient: v.patient }, patient: v.patient })} />)}
              {tests.length > 0 && <Item tag="tests" tone="clay" title={tests.map((r) => r.notes).filter(Boolean).join(', ') || 'Tests'} sub="lab slip" rs={tests} action="Slip given" onAction={() => act(tests.filter((r) => r.status === 'open').map((r) => r.id), 'contacted', 'Lab slip given').then(() => toast('Marked: lab slip given', 'info'))} />}
              {fus.map((r) => <Item key={r.id} tag="follow-up" tone="amber" title={r.dueOn ? `Review around ${fmtDate(r.dueOn)}` : 'Review'} rs={[r]} action="Book visit" onAction={() => nav(`?book=1&patient=${v.patient.id}&pname=${encodeURIComponent(v.patient.fullName)}&rec=${r.id}`)} />)}
              {waitingRep && <div className="flex items-center gap-2 rounded-2xl bg-white/70 px-3 py-2.5 text-sm"><Chip tone="amber">reports</Chip><span className="min-w-0 flex-1"><b>{got} of {tst.length} received</b><span className="text-muted"> · carries on in Awaiting reports, it does not hold up closing</span></span></div>}
              <div className="flex items-start gap-2 px-3 py-1 text-xs text-muted"><Chip>hand-off</Chip><span>Consultation was paid at check-in.{v.rxCount > 0 ? ` Medicines (${v.rxCount}) are waiting at the pharmacy counter; the pharmacist collects.` : ''}{procs.length > 0 ? ' Procedures are paid on the procedure day.' : ''}</span></div>
            </div>
            {canDesk && <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line/60 pt-3"><span className="text-xs text-muted">{open.length ? 'Close visit unlocks when the plans above are arranged or marked not needed.' : 'Everything is arranged.'}</span><span className="ml-auto" />
              {v.encounterId && <button className="btn btn-sm" onClick={() => openPrint({ title: 'Prescription', rx: v.encounterId })}><Icon name="print" className="h-3.5 w-3.5" />Print Rx</button>}
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
              : <button className="btn btn-sm btn-primary" title={free ? `Within ${freeDays} days: no fee` : `More than ${freeDays} days: the usual fee applies`} onClick={() => onArrive({ patientId: o.patient.id, name: o.patient.fullName, reports: { encounterId: o.encounterId, tests: o.tests.map((t: any) => t.name).join(', '), free, since: o.orderedAt } })}>Patient is here{pending.length ? ' · partial' : ''}</button>)}
            <button className="btn btn-sm" onClick={() => nav('/tests')}>Reports</button>
          </div>);
      })}
    </div>
  );
}
