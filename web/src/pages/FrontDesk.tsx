import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useNavigate, useOutletContext, useSearchParams } from 'react-router';
import { get, post, patch, qc, uuid, ApiError, today, errText } from '../api';
import { can } from '../App';
import { Avatar, Chip, Floating, Icon, Modal, MoneyInput, MoreMenu, Num, Segmented, Skeleton, cleanMoney, money, toast, fmtDate, toPaise } from '../ui';

type Ctx = { me: any; perms: string[]; cfg: any };
const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
const minsSince = (iso: string) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
const toHHMM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const shiftDay = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

type Tab = 'waiting' | 'scheduled' | 'doctor' | 'completed' | 'all' | 'needs' | 'history';

/** Download rows as CSV (opens in Excel). Values are quoted; a BOM keeps Telugu/Hindi names intact. */
function downloadCsv(filename: string, rows: (string | number | null | undefined)[][]) {
  const csv = rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url);
}

/** The receptionist's home as one board: every patient is a row, the stage is a tab, Waiting is the default. */
export function FrontDesk() {
  const { perms, cfg, me } = useOutletContext<Ctx>();
  const nav = useNavigate();
  const day = today(); const isToday = true;
  const q = useQuery({ queryKey: ['frontdesk', day], queryFn: () => get(`/frontdesk?day=${day}`), refetchInterval: isToday ? 5000 : false });
  const [tab, setTab] = useState<Tab>('waiting');
  const [arrive, setArrive] = useState<null | { patientId?: string; appointmentId?: string; name?: string }>(null);
  const find = '';
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [sp, setSp] = useSearchParams();
  useEffect(() => { if (sp.get('arrive')) { setArrive({}); setSp({}, { replace: true }); } }, [sp]);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['frontdesk'] }); qc.invalidateQueries({ queryKey: ['queue'] }); };
  const upVisit = useMutation({ mutationFn: ({ id, ...b }: any) => patch(`/visits/${id}`, b), onSuccess: refresh });
  const upAppt = useMutation({ mutationFn: ({ id, ...b }: any) => patch(`/appointments/${id}`, b), onSuccess: () => { refresh(); toast('Updated', 'info'); } });
  const collect = useMutation({ mutationFn: ({ c, method }: any) => post('/payments', { patientId: c.patientId, chargeId: c.id, amountPaise: c.amountPaise, method, idempotencyKey: uuid() }), onSuccess: () => { refresh(); toast('Collected'); } });
  const openEncounter = useMutation({ mutationFn: (visitId: string) => post(`/visits/${visitId}/encounter`), onSuccess: (e: any) => nav(`/encounter/${e.id}`, { viewTransition: true }) });
  const d = q.data;
  const isClinical = can(perms, 'encounter.intake'); const canDesk = can(perms, 'visit.write');
  const landed = useRef(false);
  const f = find.trim().toLowerCase();
  const match = (p: any, extra = '') => !f || p.fullName.toLowerCase().includes(f) || (p.phone ?? '').includes(f) || p.patientNo.toLowerCase().includes(f) || extra.toLowerCase().includes(f);

  const visits: any[] = d?.visits ?? [];
  const scheduled: any[] = (d?.appointments ?? []).filter((a: any) => ['booked', 'confirmed', 'requested'].includes(a.status) && match(a.patient));
  const noShows: any[] = (d?.appointments ?? []).filter((a: any) => a.status === 'no_show' && match(a.patient));
  const waiting = visits.filter((v) => ['waiting', 'intake'].includes(v.status) && match(v.patient, v.opNumber));
  const inConsult = visits.filter((v) => v.status === 'in_consult' && match(v.patient, v.opNumber));
  const completed = visits.filter((v) => ['done', 'left'].includes(v.status) && match(v.patient, v.opNumber)).sort((a, b) => (b.completedAt ?? b.arrivedAt).localeCompare(a.completedAt ?? a.arrivedAt));
  const late = scheduled.filter((a) => isToday && toMin(a.window.endTime) < nowMin());
  const withDue = visits.filter((v) => v.due.length);
  const needsCount = late.length + withDue.length;
  const dueTotal = withDue.reduce((s, v) => s + v.due.reduce((x: number, c: any) => x + c.amountPaise, 0), 0);
  const collected = (d?.payments ?? []).reduce((s: number, p: any) => s + p.total, 0);
  useEffect(() => { if (d && !landed.current) { landed.current = true; if (!waiting.length && scheduled.length && canDesk) setTab('scheduled'); } }, [d]);
  const longest = waiting.length ? Math.max(...waiting.map((v) => minsSince(v.arrivedAt))) : 0;
  const dayLabel = new Date(day + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });
  const docName = (id: string | null) => cfg?.practitioners.find((p: any) => p.id === id)?.name ?? '—';
  const tabs: [Tab, string, number][] = [['waiting', 'Waiting', waiting.length], ['scheduled', 'Not yet arrived', scheduled.length], ['doctor', 'With doctor', inConsult.length], ['completed', 'Completed', completed.length + noShows.length], ['all', 'All', visits.length + scheduled.length + noShows.length], ['needs', 'Needs you', needsCount], ['history', 'History', -1]];

  type Row = { type: 'waiting' | 'doctor' | 'appt' | 'noshow' | 'done'; v?: any; a?: any; i?: number };
  const W = { group: 'Waiting · in order', rows: waiting.map((v, i): Row => ({ type: 'waiting', v, i })) };
  const S = { group: 'Scheduled · not yet arrived', rows: scheduled.map((a): Row => ({ type: 'appt', a })) };
  const D = { group: 'With the doctor', rows: inConsult.map((v): Row => ({ type: 'doctor', v })) };
  const C = { group: 'Completed · newest first', rows: [...completed.map((v): Row => ({ type: 'done', v })), ...noShows.map((a): Row => ({ type: 'noshow', a }))] };
  const N = { group: 'Needs you', rows: [...late.map((a): Row => ({ type: 'appt', a })), ...withDue.map((v): Row => ({ type: 'done', v }))] };
  const groups = ({ waiting: [W], scheduled: [S], doctor: [D], completed: [C], needs: [N], all: [W, D, S, C], history: [] } as Record<Tab, { group: string; rows: Row[] }[]>)[tab].filter((g) => g.rows.length);
  const emptyText: Record<Tab, string> = { waiting: 'Nobody waiting', scheduled: 'Everyone booked has arrived', doctor: 'Consultation room is free', completed: 'Nothing completed yet', all: 'Nothing on this day', needs: 'All clear', history: '' };

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

  const render = (r: Row) => {
    if (r.type === 'waiting') { const v = r.v; const i = r.i!; return (
      <tr key={v.id} className="anim-fade-up"><td className="pl-4 serif text-lg">{v.opNumber}</td>
        <td><b>{v.patient.fullName}</b> <span className="text-muted">{v.patient.ageYears ?? ''} {v.patient.sex ?? ''}</span><div className="text-xs text-muted">waited {minsSince(v.arrivedAt)} min</div></td>
        <td>{v.status === 'intake' ? <Chip tone="sky">intake</Chip> : v.priority > 0 ? <Chip tone="amber">priority</Chip> : i === 0 ? <Chip tone="clay">next</Chip> : <Chip>waiting</Chip>}</td>
        <td>{v.doctor ?? '—'}</td><td className="text-muted text-xs">{v.details?.complaint ?? ''}</td>
        <td className="text-right pr-4 whitespace-nowrap">{isClinical && <button className="btn btn-sm btn-primary" onClick={() => openEncounter.mutate(v.id)}>{me.role === 'assistant' ? 'Intake' : 'Call in'}</button>} {canDesk && <MoreMenu items={[{ label: 'Move up', hidden: i === 0, onClick: () => upVisit.mutate({ id: v.id, afterVisitId: i >= 2 ? waiting[i - 2].id : null }) }, { label: 'Call patient', href: `tel:${v.patient.phone ?? ''}` }, { label: 'Left without consultation', danger: true, onClick: () => upVisit.mutate({ id: v.id, status: 'left' }) }]} />}</td></tr>); }
    if (r.type === 'doctor') { const v = r.v; return (
      <tr key={v.id} className="anim-fade-up"><td className="pl-4 serif text-lg">{v.opNumber}</td>
        <td><b>{v.patient.fullName}</b> <span className="text-muted">{v.patient.ageYears ?? ''} {v.patient.sex ?? ''}</span></td>
        <td><Chip tone="clay"><span className="h-1.5 w-1.5 rounded-full bg-clay live-dot inline-block mr-1" />in consult</Chip></td>
        <td>{v.doctor ?? '—'}</td><td className="text-muted text-xs">{v.details?.complaint ?? ''}</td>
        <td className="text-right pr-4">{isClinical && <button className="btn btn-sm" onClick={() => openEncounter.mutate(v.id)}>Open</button>}</td></tr>); }
    if (r.type === 'appt') { const a = r.a; const isLate = isToday && toMin(a.window.endTime) < nowMin(); return (
      <tr key={a.id} className={`anim-fade-up ${isLate ? 'bg-rose-soft/40' : ''}`}><td className={`pl-4 font-semibold ${isLate ? 'text-rose' : ''}`}>{a.window.startTime}{isLate && <div className="text-[11px] font-normal">late</div>}</td>
        <td><b>{a.patient.fullName}</b> <span className="text-muted">{a.patient.ageYears ?? ''} {a.patient.sex ?? ''}</span><div className="text-xs text-muted">{[a.patient.phone, a.patient.locality].filter(Boolean).join(' · ')}</div></td>
        <td>{isLate ? <Chip tone="rose">not arrived</Chip> : a.status === 'confirmed' ? <Chip tone="sage">confirmed</Chip> : a.status === 'requested' ? <Chip tone="clay">requested</Chip> : <Chip>booked</Chip>}</td><td>{docName(a.window.practitionerId)}</td><td className="text-muted text-xs">{a.note ?? ''}</td>
        <td className="text-right pr-4 whitespace-nowrap">{canDesk && isToday && <button className="btn btn-sm btn-primary" onClick={() => setArrive({ patientId: a.patientId, appointmentId: a.id, name: a.patient.fullName })}>Check in</button>} {canDesk && <MoreMenu items={[{ label: 'Call patient', href: `tel:${a.patient.phone ?? ''}` }, { label: 'Mark no-show', danger: true, onClick: () => upAppt.mutate({ id: a.id, status: 'no_show' }) }]} />}</td></tr>); }
    if (r.type === 'noshow') { const a = r.a; return (
      <tr key={a.id} className="anim-fade-up opacity-70"><td className="pl-4 font-semibold">{a.window.startTime}</td>
        <td><b>{a.patient.fullName}</b><div className="text-xs text-muted">{a.patient.phone ?? ''}</div></td>
        <td><Chip tone="rose">no-show</Chip></td><td>{docName(a.window.practitionerId)}</td><td className="text-muted text-xs">Did not arrive</td>
        <td className="text-right pr-4">{canDesk && <button className="btn btn-sm" onClick={() => nav(`/calendar?book=1&patient=${a.patientId}&pname=${encodeURIComponent(a.patient.fullName)}`)}>Rebook</button>}</td></tr>); }
    const v = r.v; const due = v.due.reduce((s: number, c: any) => s + c.amountPaise, 0); const handled = !!v.details?.explainedAt; const left = v.status === 'left';
    return (
      <tr key={v.id} className={`anim-fade-up ${due ? 'bg-rose-soft/40' : handled || left ? 'opacity-70' : ''}`}><td className="pl-4 serif text-lg">{v.opNumber}</td>
        <td><b>{v.patient.fullName}</b> <span className="text-muted">{v.patient.ageYears ?? ''} {v.patient.sex ?? ''}</span><div className="text-xs text-muted">{left ? `left · arrived ${hhmm(v.arrivedAt)}` : v.completedAt ? `finished ${hhmm(v.completedAt)}` : ''}</div></td>
        <td>{due ? <Chip tone="rose">{money(due)} due</Chip> : left ? <Chip>left</Chip> : <Chip tone="sage">completed</Chip>}</td><td>{v.doctor ?? '—'}</td>
        <td className="text-xs">{left ? <span className="text-muted">Did not see the doctor</span> : v.recommendations.length ? <div className="flex flex-wrap gap-1">{v.recommendations.map((rc: any) => <Chip key={rc.id} tone={rc.kind === 'procedure' ? 'sky' : rc.kind === 'investigation' ? 'clay' : 'amber'}>{rc.kind === 'procedure' ? `${rc.procedure ?? 'Procedure'}${rc.sittings ? ` · ${rc.sittings} sittings` : ''} → coordinator` : rc.kind === 'investigation' ? `Test: ${rc.notes}` : `Review ${rc.dueOn ? fmtDate(rc.dueOn) : ''}`}</Chip>)}</div> : <span className="text-muted">Medicines only · pharmacy has the Rx</span>}</td>
        <td className="text-right pr-4 whitespace-nowrap">
          {canDesk && v.due[0] && <button className="btn btn-sm btn-primary" onClick={() => collect.mutate({ c: v.due[0], method: 'cash' })}>Collect {money(v.due[0].amountPaise)}</button>}
          {canDesk && !left && !handled && !v.due.length && v.recommendations.length > 0 && <button className="btn btn-sm btn-primary" onClick={() => upVisit.mutate({ id: v.id, details: { explainedAt: new Date().toISOString() } })}><Icon name="check" className="h-3.5 w-3.5" />Explained</button>}
          {' '}<MoreMenu items={[
            { label: 'Collect by UPI', hidden: !(canDesk && v.due[0]), onClick: () => collect.mutate({ c: v.due[0], method: 'upi' }) },
            { label: 'Print prescription', hidden: !(v.encounterId && !left), onClick: () => window.open(`/print/${v.encounterId}?auto=0`, '_blank') },
            { label: 'Mark as explained', hidden: !(canDesk && !left && !handled && v.recommendations.length > 0 && v.due.length > 0), onClick: () => upVisit.mutate({ id: v.id, details: { explainedAt: new Date().toISOString() } }) },
            { label: 'Call patient', href: `tel:${v.patient.phone ?? ''}` },
          ]} />
        </td></tr>);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="anim-fade-up flex flex-wrap items-center gap-3 mb-4">
        <div className="mr-auto"><h1 className="text-[30px] leading-tight font-semibold">Front desk</h1>
          <div className="text-sm text-muted mt-0.5">{dayLabel}{isToday && (d?.doctors ?? []).filter((x: any) => x.from).map((x: any) => ` · ${x.name} ${x.from <= toHHMM(nowMin()) ? `until ${x.until}` : `from ${x.from}`}`).join('')}</div></div>
        {tab === 'history'
          ? <div className="flex flex-wrap items-center gap-2 no-print"><button className="btn" onClick={() => setTab('waiting')}><Icon name="chevL" className="h-4 w-4" />Back to today</button><div ref={setSlot} className="flex flex-wrap items-center gap-2" /></div>
          : <div className="flex items-center gap-1.5 no-print">{canDesk && <button className="btn" onClick={() => setTab('history')}><Icon name="clock" className="h-4 w-4" />History</button>}<button className="btn btn-icon" title="Print" aria-label="Print" onClick={() => window.print()}><Icon name="print" /></button>{canDesk && <button className="btn btn-icon" title="Export to Excel" aria-label="Export to Excel" onClick={exportRows}><Icon name="export" /></button>}</div>}
      </div>

      {!d ? <Skeleton rows={3} /> : (<>
        <div className="flex gap-2.5 overflow-x-auto no-scrollbar pb-1 -mx-1 px-1 sm:mx-0 sm:px-0 sm:grid sm:grid-cols-4 sm:gap-3 xl:grid-cols-7 mb-4 stagger [&>*]:min-w-[132px] [&>*]:shrink-0 sm:[&>*]:min-w-0">
          <FilterCard i={0} label="Waiting" value={waiting.length} sub={waiting.length ? `longest ${longest} min` : 'nobody waiting'} tone="clay" on={tab === 'waiting'} onClick={() => setTab('waiting')} />
          {canDesk && <FilterCard i={1} label="Not yet arrived" value={scheduled.length} sub={late.length ? `${late.length} late` : 'booked'} on={tab === 'scheduled'} onClick={() => setTab('scheduled')} />}
          <FilterCard i={2} label="With doctor" value={inConsult.length} sub="in consultation" on={tab === 'doctor'} onClick={() => setTab('doctor')} />
          <FilterCard i={3} label="Completed" value={completed.length + noShows.length} sub={`${completed.filter((v) => v.status === 'done').length} seen`} on={tab === 'completed'} onClick={() => setTab('completed')} />
          <FilterCard i={4} label="All" value={visits.length + scheduled.length + noShows.length} sub="everyone today" on={tab === 'all'} onClick={() => setTab('all')} />
          {canDesk && <FilterCard i={5} label="Needs you" value={needsCount} sub={dueTotal ? `${money(dueTotal)} due` : needsCount ? 'late arrivals' : 'all clear'} tone="rose" on={tab === 'needs'} onClick={() => setTab('needs')} />}
          {(can(perms, 'report.daily') || can(perms, 'finance.read')) && <div style={{ ['--i' as any]: 6 }} className="rounded-[22px] border border-white/80 bg-white/35 px-4 py-3.5"><div className="text-[11px] font-bold uppercase tracking-[0.09em] text-muted">Collected</div><div className="mt-1 text-[28px] font-semibold leading-none tracking-tight text-sage"><Num value={collected} format={money} /></div><div className="mt-1.5 text-xs text-muted truncate">{(d.payments ?? []).length ? d.payments.map((p: any) => `${p.method} ${money(p.total)}`).join(' · ') : 'nothing yet'}</div></div>}
        </div>

        {tab === 'history' ? <HistoryPanel canDesk={canDesk} find={find} slot={slot} onBook={(p?: any) => nav(p ? `/calendar?book=1&patient=${p.id}&pname=${encodeURIComponent(p.fullName)}` : '/calendar?book=1')} /> : <div className="card-flat flex min-h-0 flex-1 flex-col overflow-hidden anim-fade-up" style={{ animationDelay: '80ms' }}>
          <div className="min-h-0 flex-1 overflow-auto"><table className="table sticky-head !text-sm md:min-w-[760px] stack-on-phone">
            <thead><tr><th className="pl-4 w-24">{tab === 'scheduled' ? 'Time' : 'Token'}</th><th>Patient</th><th className="w-36">{tab === 'completed' ? 'Outcome' : 'Stage'}</th><th className="w-36">Doctor</th><th>{tab === 'completed' || tab === 'needs' ? 'What to tell them' : 'Note'}</th><th className="text-right pr-4 w-72">Action</th></tr></thead>
            <tbody>
              {groups.length === 0 && <tr><td colSpan={6} className="!py-10 text-center text-muted">{emptyText[tab]}</td></tr>}
              {groups.map((g) => (<GroupRows key={g.group} showGroup={false} group={g.group}>{g.rows.map(render)}</GroupRows>))}
            </tbody>
          </table></div>
        </div>}
      </>)}
      {arrive && <ArrivalSheet init={arrive} cfg={cfg} perms={perms} waitingByDoctor={Object.fromEntries((d?.doctors ?? []).map((x: any) => [x.id, visits.filter((v) => ['waiting', 'intake'].includes(v.status) && v.practitionerId === x.id).length]))} onClose={() => { setArrive(null); refresh(); }} />}
    </div>
  );
}

/** A stat that is also a filter: click it to show exactly those patients. */
function FilterCard({ i, label, value, sub, tone, on, onClick }: { i: number; label: string; value: number; sub?: string; tone?: 'clay' | 'rose'; on: boolean; onClick: () => void }) {
  const alert = tone === 'rose' && value > 0;
  return (
    <button type="button" onClick={onClick} aria-pressed={on}
      className={`rounded-[22px] border px-4 py-3.5 text-left transition-[background-color,box-shadow,transform,border-color,color] duration-300 ease-[var(--ease)] hover:-translate-y-0.5 ${on ? 'border-ink bg-ink text-white' : alert ? 'border-rose/25 bg-rose-soft text-rose' : 'border-white/80 bg-white/55 hover:bg-white'}`}
      style={on ? { boxShadow: '0 22px 40px -22px rgba(23,25,26,.7)', ['--i' as any]: i } : { boxShadow: 'var(--shadow-soft)', ['--i' as any]: i }}>
      <div className={`text-[11px] font-bold uppercase tracking-[0.09em] ${on ? 'text-white/70' : alert ? 'text-rose' : 'text-muted'}`}>{label}</div>
      <div className={`mt-1 text-[28px] font-semibold leading-none tracking-tight ${!on && tone === 'clay' && value > 0 ? 'text-clay' : ''}`}><Num value={value} /></div>
      {sub && <div className={`mt-1.5 truncate text-xs ${on ? 'text-white/70' : alert ? 'text-rose/80' : 'text-muted'}`}>{sub}</div>}
    </button>
  );
}

const Sep = () => <span className="w-px h-9 bg-ink/10 hidden sm:block" />;
function Stat({ label, value, sub, tone = '' }: { label: string; value: any; sub?: string; tone?: '' | 'clay' | 'sage' }) {
  return <div><div className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</div><div className={`serif text-2xl leading-tight ${tone === 'clay' ? 'text-clay' : tone === 'sage' ? 'text-sage' : ''}`}>{typeof value === 'number' ? <Num value={value} /> : value} {sub && <span className="font-sans text-[13px] font-normal text-muted">{sub}</span>}</div></div>;
}
function GroupRows({ showGroup, group, children }: { showGroup: boolean; group: string; children: React.ReactNode }) {
  return <>{showGroup && <tr><td colSpan={6} className="!py-2 !bg-paper text-[11px] font-semibold uppercase tracking-wider text-muted">{group}</td></tr>}{children}</>;
}

const dayOf = (iso: string) => new Date(iso + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
const weekdayOf = (iso: string) => new Date(iso + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short' });

/** History across days. The controls sit on the tab row (search, one Filters dropdown, print, export); the date is a column. */
const PERIODS: [string, string][] = [['today', 'Today'], ['yesterday', 'Yesterday'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['custom', 'Pick dates']];
const SHOWS: [string, string][] = [['all', 'Everything'], ['left', 'Left without consult'], ['noshow', 'No-shows'], ['adjusted', 'Fees waived or refunded']];
function HistoryPanel({ find, onBook, slot }: { canDesk: boolean; find: string; onBook: (p?: any) => void; slot: HTMLElement | null }) {
  const { perms } = useOutletContext<Ctx>();
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
      <button className="btn btn-icon" title="Print or save as PDF" aria-label="Print or save as PDF" onClick={() => window.print()}><Icon name="print" /></button>
      <button className="btn btn-icon" title="Export to Excel" aria-label="Export to Excel" disabled={!rows.length} onClick={exportCsv}><Icon name="export" /></button>
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
                {r.kind === 'noshow' ? <button className="btn btn-sm btn-primary" onClick={() => onBook(r.patient)}>Rebook</button> : r.outcome === 'left' && paid && can(perms, 'payment.waive') ? <button className="btn btn-sm btn-primary" onClick={() => refund.mutate(paid)}>Refund</button> : <button className="btn btn-sm" onClick={() => nav(`/patients/${r.patient.id}`)}>Open record</button>}
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
function ArrivalSheet({ init, cfg, perms, waitingByDoctor, onClose }: { init: { patientId?: string; appointmentId?: string; name?: string }; cfg: any; perms: string[]; waitingByDoctor: Record<string, number>; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [patientId, setPatientId] = useState(init.patientId);
  const [newP, setNewP] = useState<null | { fullName: string; phone: string; ageYears: string; sex: string }>(null);
  const [cat, setCat] = useState('');
  const enabled: string[] = cfg?.tenant.settings?.vitals ?? DEFAULT_VITALS;
  const [vit, setVit] = useState<Record<string, string>>({});
  const [locality, setLocality] = useState('');
  const [list, setList] = useState<Complaint[]>([]);
  const [draft, setDraft] = useState<Complaint>({ text: '', duration: '' });
  const [method, setMethod] = useState('cash'); const [amount, setAmount] = useState('');
  const [waive, setWaive] = useState('');
  const [practitionerId, setPractitionerId] = useState('');
  const search = useQuery({ queryKey: ['patients', q], queryFn: () => get(`/patients?q=${encodeURIComponent(q)}`), enabled: !patientId && q.length >= 2 });
  const sug = useQuery({ queryKey: ['suggest', patientId], queryFn: () => get(`/patients/${patientId}/suggest-category`), enabled: !!patientId });
  const tl = useQuery({ queryKey: ['timeline', patientId], queryFn: () => get(`/patients/${patientId}/timeline`), enabled: !!patientId });
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
  const submit = useMutation({
    mutationFn: async () => {
      let pid = patientId;
      if (!pid && newP) { const np = await post(forceNew ? '/patients?force=1' : '/patients', { fullName: newP.fullName.trim(), phone: newP.phone || null, ageYears: newP.ageYears ? Number(newP.ageYears) : null, sex: newP.sex || null, locality: locality || null }); pid = np.id; }
      if (!pid) throw new Error('Pick or register a patient');
      const complaints = [...list, ...(draft.text.trim() ? [{ text: draft.text.trim(), duration: draft.duration.trim() }] : [])];
      const vitals: Record<string, any> = {};
      for (const f of VITAL_FIELDS) if (enabled.includes(f.key) && vit[f.key]) vitals[f.key] = f.type === 'number' ? Number(vit[f.key]) : vit[f.key];
      return post('/visits', { patientId: pid, appointmentId: init.appointmentId, feeCategoryCode: chosen, practitionerId: practitionerId || null,
        details: { ...vitals, ...(bmi ? { bmi } : {}), locality: locality || p?.locality, complaints, complaint: complaints.map((c) => c.text).join(', ') },
        payment: !waive && fee > 0 ? { method, amountPaise: toPaise(amount || String(fee / 100)) } : undefined, waive: waive ? { reason: waive } : undefined, idempotencyKey: uuid() });
    },
    onSuccess: (v: any) => { toast(`Checked in · token ${v.opNumber}`); onClose(); },
    onError: (e: any) => { if (e instanceof ApiError && e.body.code === 'POSSIBLE_DUPLICATE') setDup(e.body.existing); else toast(errText(e), 'err'); },
  });
  useEffect(() => { if (forceNew) { submit.mutate(); setForceNew(false); } }, [forceNew]);
  const step = !patientId && !newP ? 1 : 2;
  const blocker = !chosen ? 'Pick a visit type' : newP && newP.fullName.trim().length < 2 ? 'Enter the patient\'s name (at least 2 letters)' : newP && newP.phone && newP.phone.length !== 10 ? 'Phone needs 10 digits' : fee > 0 && !waive && toPaise(amount === '' ? String(fee / 100) : amount) <= 0 ? 'Enter the amount collected' : '';
  const facts = sug.data?.facts;
  return (
    <Modal title={step === 1 ? 'Who has arrived?' : 'Arrival'} subtitle={step === 1 ? 'Phone, name or patient ID' : undefined} onClose={onClose} width="max-w-2xl">
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
            <div className="grid grid-cols-6 gap-2">
              <div className="col-span-3"><label className="label">Full name</label><input autoFocus className="input" maxLength={100} value={newP.fullName} onChange={(e) => { setDup(null); setNewP({ ...newP, fullName: e.target.value }); }} /></div>
              <div className="col-span-2"><label className="label">Phone</label><input className="input" inputMode="numeric" placeholder="10 digits" value={newP.phone} onChange={(e) => { setDup(null); setNewP({ ...newP, phone: e.target.value.replace(/\D/g, '').slice(0, 10) }); }} /></div>
              <div><label className="label">Age</label><input className="input" inputMode="numeric" placeholder="years" value={newP.ageYears} onChange={(e) => { const v = e.target.value.replace(/\D/g, '').slice(0, 3); setNewP({ ...newP, ageYears: v && Number(v) > 120 ? '120' : v }); }} /></div>
              <div className="col-span-6 flex gap-1">{['M', 'F', 'O'].map((s) => <button key={s} type="button" className={`toggle-opt ${newP.sex === s ? 'on' : ''}`} onClick={() => setNewP({ ...newP, sex: s })}>{s === 'M' ? 'Male' : s === 'F' ? 'Female' : 'Other'}</button>)}<button className="btn btn-ghost btn-sm ml-auto" onClick={() => setNewP(null)}>Back to search</button></div>
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
            <div className="grid gap-2.5" style={{ gridTemplateColumns: `repeat(${Math.min(enabled.length, 5)}, minmax(0, 1fr))` }}>
              {VITAL_FIELDS.filter((f) => enabled.includes(f.key)).map((f) => (
                <div key={f.key}><label htmlFor={`v-${f.key}`} className="text-[10px] font-semibold uppercase tracking-wider text-muted block mb-1">{f.label}</label>
                  <div className="relative"><input id={`v-${f.key}`} className="input !pr-12" inputMode={f.type === 'number' ? 'decimal' : 'text'} placeholder={f.ph} value={vit[f.key] ?? ''} maxLength={7} onChange={(e) => setVit({ ...vit, [f.key]: f.type === 'number' ? e.target.value.replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1') : e.target.value.replace(/[^\d/]/g, '') })} /><span className="absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-muted pointer-events-none">{f.unit}</span></div></div>
              ))}
            </div>
          </div>

          <div>
            <span className="label">Complaints</span>
            <div className="space-y-2">
              {list.map((c, i) => (
                <div key={i} className="grid grid-cols-[1fr_150px_44px_44px] gap-2 items-center anim-scale-in">
                  <div className="input flex items-center !bg-paper">{c.text}</div><div className="input flex items-center !bg-paper text-muted">{c.duration || '—'}</div>
                  <span className="grid place-items-center h-11 rounded-full bg-sage-soft text-sage border border-sage/40" title="Done"><Icon name="check" /></span>
                  <button type="button" className="btn btn-icon !h-11 !w-11" aria-label="Remove complaint" onClick={() => setList(list.filter((_, j) => j !== i))}><Icon name="x" className="h-4 w-4" /></button>
                </div>))}
              <div className="grid grid-cols-[1fr_150px_92px] gap-2 items-center">
                <input className="input" aria-label="Complaint" placeholder={list.length ? 'Another complaint…' : 'Main complaint…'} value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }} />
                <input className="input" aria-label="Since when" placeholder="Since when" value={draft.duration} onChange={(e) => setDraft({ ...draft, duration: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }} />
                <button type="button" className="btn !bg-ink !text-paper !border-ink !h-11" disabled={!draft.text.trim()} onClick={commit}><Icon name="plus" className="h-4 w-4" />Add</button>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div><label htmlFor="visit-type" className="label">Visit type · fee</label>
              <select id="visit-type" className="input" value={chosen} onChange={(e) => setCat(e.target.value)}>{cfg?.feeCategories.map((c: any) => <option key={c.code} value={c.code}>{c.name} · {money(c.amountPaise)}{sug.data?.suggested?.code === c.code ? ' (suggested)' : ''}</option>)}</select></div>
            <div><label htmlFor="locality" className="label">Location</label><input id="locality" className="input" placeholder={p?.locality ?? ''} value={locality} onChange={(e) => setLocality(e.target.value)} /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label">Doctor</label><div className="flex flex-wrap gap-1.5">{cfg?.practitioners.map((x: any) => <button key={x.id} type="button" className={`toggle-opt !py-2.5 ${practitionerId === x.id ? 'on' : ''}`} onClick={() => setPractitionerId(practitionerId === x.id ? '' : x.id)}>{x.name} · {waitingByDoctor[x.id] ?? 0} waiting</button>)}</div></div>
            <div><label className="label">Payment</label>
              {fee === 0 ? <div className="text-sm text-muted pt-2.5">Nothing to collect for {catRow?.name?.split(' (')[0] ?? 'this visit'}.</div> : waive ? <div className="text-sm text-amber pt-2.5">Waived · {waive}</div> : (
                <div className="flex gap-1.5 items-center flex-wrap">{['cash', 'upi', 'card'].map((m) => <button key={m} type="button" className={`toggle-opt !py-2.5 uppercase ${method === m ? 'on' : ''}`} onClick={() => setMethod(m)}>{m}</button>)}<MoneyInput className="!w-28" value={amount === '' ? String(fee / 100) : amount} onChange={setAmount} /></div>)}
              {fee > 0 && can(perms, 'payment.waive') && <input className="input mt-2 !py-1.5 text-xs" placeholder="Waive? type the reason (known person, doctor said…)" value={waive} onChange={(e) => setWaive(e.target.value)} />}
            </div>
          </div>
          <div className="modal-foot"><span className="mr-auto text-xs text-muted" role="status">{blocker}</span><button className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" disabled={submit.isPending || !!blocker} onClick={() => submit.mutate()}><Icon name="check" />Check in{fee > 0 && !waive && !blocker ? ` · collect ${money(toPaise(amount === '' ? String(fee / 100) : amount))}` : ''}</button></div>
        </div>
      )}
    </Modal>
  );
}
