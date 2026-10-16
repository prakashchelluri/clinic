import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useNavigate, useOutletContext } from 'react-router';
import { get, post, patch, qc, uuid, ApiError, today } from '../api';
import { can } from '../App';
import { Avatar, Chip, Icon, Modal, Skeleton, money, toast, fmtDate } from '../ui';

type Ctx = { me: any; perms: string[]; cfg: any };
const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
const minsSince = (iso: string) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
const toHHMM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const shiftDay = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

type Tab = 'waiting' | 'scheduled' | 'doctor' | 'completed' | 'all' | 'needs';

/** The receptionist's home as one board: every patient is a row, the stage is a tab, Waiting is the default. */
export function FrontDesk() {
  const { perms, cfg, me } = useOutletContext<Ctx>();
  const nav = useNavigate();
  const [day, setDay] = useState(today());
  const isToday = day === today();
  const q = useQuery({ queryKey: ['frontdesk', day], queryFn: () => get(`/frontdesk?day=${day}`), refetchInterval: isToday ? 5000 : false });
  const [tab, setTab] = useState<Tab>('waiting');
  const [arrive, setArrive] = useState<null | { patientId?: string; appointmentId?: string; name?: string }>(null);
  const [find, setFind] = useState('');
  const refresh = () => { qc.invalidateQueries({ queryKey: ['frontdesk'] }); qc.invalidateQueries({ queryKey: ['queue'] }); };
  const upVisit = useMutation({ mutationFn: ({ id, ...b }: any) => patch(`/visits/${id}`, b), onSuccess: refresh });
  const upAppt = useMutation({ mutationFn: ({ id, ...b }: any) => patch(`/appointments/${id}`, b), onSuccess: () => { refresh(); toast('Updated', 'info'); } });
  const collect = useMutation({ mutationFn: ({ c, method }: any) => post('/payments', { patientId: c.patientId, chargeId: c.id, amountPaise: c.amountPaise, method, idempotencyKey: uuid() }), onSuccess: () => { refresh(); toast('Collected'); } });
  const openEncounter = useMutation({ mutationFn: (visitId: string) => post(`/visits/${visitId}/encounter`), onSuccess: (e: any) => nav(`/encounter/${e.id}`, { viewTransition: true }) });
  const d = q.data;
  const isClinical = can(perms, 'encounter.intake'); const canDesk = can(perms, 'visit.write');
  const f = find.trim().toLowerCase();
  const match = (p: any, extra = '') => !f || p.fullName.toLowerCase().includes(f) || (p.phone ?? '').includes(f) || p.patientNo.toLowerCase().includes(f) || extra.toLowerCase().includes(f);

  const visits: any[] = d?.visits ?? [];
  const scheduled: any[] = (d?.appointments ?? []).filter((a: any) => a.status === 'booked' && match(a.patient));
  const noShows: any[] = (d?.appointments ?? []).filter((a: any) => a.status === 'no_show' && match(a.patient));
  const waiting = visits.filter((v) => ['waiting', 'intake'].includes(v.status) && match(v.patient, v.opNumber));
  const inConsult = visits.filter((v) => v.status === 'in_consult' && match(v.patient, v.opNumber));
  const completed = visits.filter((v) => ['done', 'left'].includes(v.status) && match(v.patient, v.opNumber)).sort((a, b) => (b.completedAt ?? b.arrivedAt).localeCompare(a.completedAt ?? a.arrivedAt));
  const late = scheduled.filter((a) => isToday && toMin(a.window.endTime) < nowMin());
  const withDue = visits.filter((v) => v.due.length);
  const needsCount = late.length + withDue.length;
  const dueTotal = withDue.reduce((s, v) => s + v.due.reduce((x: number, c: any) => x + c.amountPaise, 0), 0);
  const collected = (d?.payments ?? []).reduce((s: number, p: any) => s + p.total, 0);
  const longest = waiting.length ? Math.max(...waiting.map((v) => minsSince(v.arrivedAt))) : 0;
  const dayLabel = new Date(day + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });
  const docName = (id: string | null) => cfg?.practitioners.find((p: any) => p.id === id)?.name ?? '—';
  const tabs: [Tab, string, number][] = [['waiting', 'Waiting', waiting.length], ['scheduled', 'Not yet arrived', scheduled.length], ['doctor', 'With doctor', inConsult.length], ['completed', 'Completed', completed.length + noShows.length], ['all', 'All', visits.length + scheduled.length + noShows.length], ['needs', 'Needs you', needsCount]];

  type Row = { type: 'waiting' | 'doctor' | 'appt' | 'noshow' | 'done'; v?: any; a?: any; i?: number };
  const W = { group: 'Waiting · in order', rows: waiting.map((v, i): Row => ({ type: 'waiting', v, i })) };
  const S = { group: 'Scheduled · not yet arrived', rows: scheduled.map((a): Row => ({ type: 'appt', a })) };
  const D = { group: 'With the doctor', rows: inConsult.map((v): Row => ({ type: 'doctor', v })) };
  const C = { group: 'Completed · newest first', rows: [...completed.map((v): Row => ({ type: 'done', v })), ...noShows.map((a): Row => ({ type: 'noshow', a }))] };
  const N = { group: 'Needs you', rows: [...late.map((a): Row => ({ type: 'appt', a })), ...withDue.map((v): Row => ({ type: 'done', v }))] };
  const groups = ({ waiting: [W], scheduled: [S], doctor: [D], completed: [C], needs: [N], all: [W, D, S, C] } as Record<Tab, { group: string; rows: Row[] }[]>)[tab].filter((g) => g.rows.length);
  const emptyText: Record<Tab, string> = { waiting: 'Nobody waiting', scheduled: 'Everyone booked has arrived', doctor: 'Consultation room is free', completed: 'Nothing completed yet', all: 'Nothing on this day', needs: 'All clear' };

  const render = (r: Row) => {
    if (r.type === 'waiting') { const v = r.v; const i = r.i!; return (
      <tr key={v.id} className="anim-fade-up"><td className="pl-4 serif text-lg">{v.opNumber}</td>
        <td><b>{v.patient.fullName}</b> <span className="text-muted">{v.patient.ageYears ?? ''} {v.patient.sex ?? ''}</span><div className="text-xs text-muted">waited {minsSince(v.arrivedAt)} min</div></td>
        <td>{v.status === 'intake' ? <Chip tone="sky">intake</Chip> : v.priority > 0 ? <Chip tone="amber">priority</Chip> : i === 0 ? <Chip tone="clay">next</Chip> : <Chip>waiting</Chip>}</td>
        <td>{v.doctor ?? '—'}</td><td className="text-muted text-xs">{v.details?.complaint ?? ''}</td>
        <td className="text-right pr-4 whitespace-nowrap">{isClinical && <button className="btn btn-sm" onClick={() => openEncounter.mutate(v.id)}>{me.role === 'assistant' ? 'Intake' : 'Call in'}</button>} {canDesk && <><button className="btn btn-sm btn-ghost" disabled={i === 0} title="Move up" onClick={() => upVisit.mutate({ id: v.id, afterVisitId: i >= 2 ? waiting[i - 2].id : null })}><Icon name="up" className="h-3.5 w-3.5" /></button><button className="btn btn-sm btn-ghost" onClick={() => upVisit.mutate({ id: v.id, status: 'left' })}>Left</button></>}</td></tr>); }
    if (r.type === 'doctor') { const v = r.v; return (
      <tr key={v.id} className="anim-fade-up"><td className="pl-4 serif text-lg">{v.opNumber}</td>
        <td><b>{v.patient.fullName}</b> <span className="text-muted">{v.patient.ageYears ?? ''} {v.patient.sex ?? ''}</span></td>
        <td><Chip tone="clay"><span className="h-1.5 w-1.5 rounded-full bg-clay live-dot inline-block mr-1" />in consult</Chip></td>
        <td>{v.doctor ?? '—'}</td><td className="text-muted text-xs">{v.details?.complaint ?? ''}</td>
        <td className="text-right pr-4">{isClinical && <button className="btn btn-sm" onClick={() => openEncounter.mutate(v.id)}>Open</button>}</td></tr>); }
    if (r.type === 'appt') { const a = r.a; const isLate = isToday && toMin(a.window.endTime) < nowMin(); return (
      <tr key={a.id} className={`anim-fade-up ${isLate ? 'bg-rose-soft/40' : ''}`}><td className={`pl-4 font-semibold ${isLate ? 'text-rose' : ''}`}>{a.window.startTime}{isLate && <div className="text-[11px] font-normal">late</div>}</td>
        <td><b>{a.patient.fullName}</b> <span className="text-muted">{a.patient.ageYears ?? ''} {a.patient.sex ?? ''}</span><div className="text-xs text-muted">{[a.patient.phone, a.patient.locality].filter(Boolean).join(' · ')}</div></td>
        <td>{isLate ? <Chip tone="rose">not arrived</Chip> : <Chip>booked</Chip>}</td><td>{docName(a.window.practitionerId)}</td><td className="text-muted text-xs">{a.note ?? ''}</td>
        <td className="text-right pr-4 whitespace-nowrap">{canDesk && isToday && <button className="btn btn-sm !bg-ink !text-paper !border-ink" onClick={() => setArrive({ patientId: a.patientId, appointmentId: a.id, name: a.patient.fullName })}>Arrived</button>} {isLate && canDesk && <><a className="btn btn-sm" href={`tel:${a.patient.phone ?? ''}`}>Call</a> <button className="btn btn-sm btn-ghost" onClick={() => upAppt.mutate({ id: a.id, status: 'no_show' })}>No-show</button></>}</td></tr>); }
    if (r.type === 'noshow') { const a = r.a; return (
      <tr key={a.id} className="anim-fade-up opacity-70"><td className="pl-4 font-semibold">{a.window.startTime}</td>
        <td><b>{a.patient.fullName}</b><div className="text-xs text-muted">{a.patient.phone ?? ''}</div></td>
        <td><Chip tone="rose">no-show</Chip></td><td>{docName(a.window.practitionerId)}</td><td className="text-muted text-xs">Did not arrive</td>
        <td className="text-right pr-4">{canDesk && <button className="btn btn-sm" onClick={() => nav('/booking')}>Rebook</button>}</td></tr>); }
    const v = r.v; const due = v.due.reduce((s: number, c: any) => s + c.amountPaise, 0); const handled = !!v.details?.explainedAt; const left = v.status === 'left';
    return (
      <tr key={v.id} className={`anim-fade-up ${due ? 'bg-rose-soft/40' : handled || left ? 'opacity-70' : ''}`}><td className="pl-4 serif text-lg">{v.opNumber}</td>
        <td><b>{v.patient.fullName}</b> <span className="text-muted">{v.patient.ageYears ?? ''} {v.patient.sex ?? ''}</span><div className="text-xs text-muted">{left ? `left · arrived ${hhmm(v.arrivedAt)}` : v.completedAt ? `finished ${hhmm(v.completedAt)}` : ''}</div></td>
        <td>{due ? <Chip tone="rose">{money(due)} due</Chip> : left ? <Chip>left</Chip> : <Chip tone="sage">completed</Chip>}</td><td>{v.doctor ?? '—'}</td>
        <td className="text-xs">{left ? <span className="text-muted">Did not see the doctor</span> : v.recommendations.length ? <div className="flex flex-wrap gap-1">{v.recommendations.map((rc: any) => <Chip key={rc.id} tone={rc.kind === 'procedure' ? 'sky' : rc.kind === 'investigation' ? 'clay' : 'amber'}>{rc.kind === 'procedure' ? `${rc.procedure ?? 'Procedure'}${rc.sittings ? ` · ${rc.sittings} sittings` : ''} → coordinator` : rc.kind === 'investigation' ? `Test: ${rc.notes}` : `Review ${rc.dueOn ? fmtDate(rc.dueOn) : ''}`}</Chip>)}</div> : <span className="text-muted">Medicines only · pharmacy has the Rx</span>}</td>
        <td className="text-right pr-4 whitespace-nowrap">
          {canDesk && v.due.map((c: any) => <span key={c.id}><button className="btn btn-sm btn-primary" onClick={() => collect.mutate({ c, method: 'cash' })}>Collect {money(c.amountPaise)}</button> <button className="btn btn-sm" onClick={() => collect.mutate({ c, method: 'upi' })}>UPI</button> </span>)}
          {v.encounterId && !left && <button className="btn btn-sm" onClick={() => window.open(`/print/${v.encounterId}?auto=0`, '_blank')}><Icon name="print" className="h-3.5 w-3.5" />Rx</button>}
          {canDesk && !left && !handled && v.recommendations.length > 0 && <> <button className="btn btn-sm !bg-ink !text-paper !border-ink" onClick={() => upVisit.mutate({ id: v.id, details: { explainedAt: new Date().toISOString() } })}><Icon name="check" className="h-3.5 w-3.5" />Explained</button></>}
          {left && canDesk && <a className="btn btn-sm" href={`tel:${v.patient.phone ?? ''}`}>Call</a>}
        </td></tr>);
  };

  return (
    <div>
      <div className="anim-fade-up flex flex-wrap items-center gap-3 mb-4">
        <div className="mr-auto"><h1 className="text-[28px] leading-tight font-medium">Front desk</h1>
          <div className="text-sm text-muted mt-0.5">{dayLabel}{isToday && (d?.doctors ?? []).filter((x: any) => x.from).map((x: any) => ` · ${x.name} ${x.from <= toHHMM(nowMin()) ? `until ${x.until}` : `from ${x.from}`}`).join('')}</div></div>
        <div className="relative"><Icon name="search" className="h-4 w-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" /><input className="input !pl-10 !w-72 !rounded-full" placeholder="Phone, name or token" value={find} onChange={(e) => setFind(e.target.value)} /></div>
        {canDesk && isToday && <button className="btn btn-primary !py-2.5" onClick={() => setArrive({})}><Icon name="plus" />Patient arrived</button>}
      </div>

      {!d ? <Skeleton rows={3} /> : (<>
        <div className="card anim-fade-up !py-3.5 flex flex-wrap items-center gap-x-7 gap-y-3 mb-4">
          <Stat label="Appointments" value={d.appointments.filter((a: any) => a.status !== 'cancelled').length} sub={scheduled.length ? `· ${scheduled.length} to come` : ''} />
          <Sep /><Stat label="Waiting" value={waiting.length} tone="clay" sub={waiting.length ? `· longest ${longest} min` : ''} />
          <Sep /><Stat label="With doctor" value={inConsult.length} />
          <Sep /><Stat label="Completed" value={completed.filter((v) => v.status === 'done').length} />
          <Sep /><Stat label="Collected" value={money(collected)} tone="sage" sub={(d.payments ?? []).length ? '· ' + d.payments.map((p: any) => `${p.method} ${money(p.total)}`).join(' · ') : ''} />
          {needsCount > 0 && <button className="ml-auto chip chip-rose !py-2 !px-3.5 !text-xs" onClick={() => setTab('needs')}>{needsCount} need you{dueTotal ? ` · ${money(dueTotal)} due` : ''}</button>}
        </div>

        <div className="anim-fade-up flex flex-wrap items-center gap-1.5 mb-3" style={{ animationDelay: '40ms' }}>
          {tabs.map(([k, label, n]) => <button key={k} className={`toggle-opt !py-2 ${tab === k ? 'on' : ''} ${k === 'needs' && tab !== k && n > 0 ? '!text-rose !border-rose/30' : ''}`} onClick={() => setTab(k)}>{label} <span className={tab === k ? 'opacity-70' : 'text-muted'}>· {n}</span></button>)}
          <div className="ml-auto flex items-center gap-0.5 card !p-0.5 !rounded-full"><button className="btn btn-ghost btn-icon !h-8 !w-8" onClick={() => setDay(shiftDay(day, -1))}><Icon name="chevL" /></button><span className="text-xs px-1.5 min-w-14 text-center">{isToday ? 'Today' : fmtDate(day)}</span><button className="btn btn-ghost btn-icon !h-8 !w-8" disabled={isToday} onClick={() => setDay(shiftDay(day, 1))}><Icon name="chevR" /></button></div>
        </div>

        <div className="card-flat overflow-hidden anim-fade-up" style={{ animationDelay: '80ms' }}>
          <div className="overflow-x-auto"><table className="table !text-sm min-w-[880px]">
            <thead><tr><th className="pl-4 w-24">{tab === 'scheduled' ? 'Time' : 'Token'}</th><th>Patient</th><th className="w-36">{tab === 'completed' ? 'Outcome' : 'Stage'}</th><th className="w-36">Doctor</th><th>{tab === 'completed' || tab === 'needs' ? 'What to tell them' : 'Note'}</th><th className="text-right pr-4 w-72">Action</th></tr></thead>
            <tbody>
              {groups.length === 0 && <tr><td colSpan={6} className="!py-10 text-center text-muted">{emptyText[tab]}</td></tr>}
              {groups.map((g) => (<GroupRows key={g.group} showGroup={tab === 'all'} group={g.group}>{g.rows.map(render)}</GroupRows>))}
            </tbody>
          </table></div>
        </div>
      </>)}
      {arrive && <ArrivalSheet init={arrive} cfg={cfg} perms={perms} waitingByDoctor={Object.fromEntries((d?.doctors ?? []).map((x: any) => [x.id, visits.filter((v) => ['waiting', 'intake'].includes(v.status) && v.practitionerId === x.id).length]))} onClose={() => { setArrive(null); refresh(); }} />}
    </div>
  );
}

const Sep = () => <span className="w-px h-9 bg-line hidden sm:block" />;
function Stat({ label, value, sub, tone = '' }: { label: string; value: any; sub?: string; tone?: '' | 'clay' | 'sage' }) {
  return <div><div className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</div><div className={`serif text-2xl leading-tight ${tone === 'clay' ? 'text-clay' : tone === 'sage' ? 'text-sage' : ''}`}>{value} {sub && <span className="font-sans text-[13px] text-muted">{sub}</span>}</div></div>;
}
function GroupRows({ showGroup, group, children }: { showGroup: boolean; group: string; children: React.ReactNode }) {
  return <>{showGroup && <tr><td colSpan={6} className="!py-2 !bg-paper text-[11px] font-semibold uppercase tracking-wider text-muted">{group}</td></tr>}{children}</>;
}

/** Arrival: who they are, why this fee, what to collect, which doctor. One screen, one button. */
function ArrivalSheet({ init, cfg, perms, waitingByDoctor, onClose }: { init: { patientId?: string; appointmentId?: string; name?: string }; cfg: any; perms: string[]; waitingByDoctor: Record<string, number>; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [patientId, setPatientId] = useState(init.patientId);
  const [newP, setNewP] = useState<null | { fullName: string; phone: string; ageYears: string; sex: string }>(null);
  const [cat, setCat] = useState('');
  const [details, setDetails] = useState({ weight_kg: '', locality: '', complaint: '' });
  const [method, setMethod] = useState('cash'); const [amount, setAmount] = useState('');
  const [waive, setWaive] = useState('');
  const [practitionerId, setPractitionerId] = useState('');
  const search = useQuery({ queryKey: ['patients', q], queryFn: () => get(`/patients?q=${encodeURIComponent(q)}`), enabled: !patientId && q.length >= 2 });
  const sug = useQuery({ queryKey: ['suggest', patientId], queryFn: () => get(`/patients/${patientId}/suggest-category`), enabled: !!patientId });
  const tl = useQuery({ queryKey: ['timeline', patientId], queryFn: () => get(`/patients/${patientId}/timeline`), enabled: !!patientId });
  const chosen = cat || sug.data?.suggested?.code || '';
  const catRow = cfg?.feeCategories.find((c: any) => c.code === chosen);
  const fee = catRow?.amountPaise ?? 0;
  const p = sug.data?.patient;
  const openPlans = (tl.data?.recommendations ?? []).filter((r: any) => !['done', 'cancelled'].includes(r.status));
  const submit = useMutation({
    mutationFn: async () => {
      let pid = patientId;
      if (!pid && newP) { const np = await post('/patients?force=1', { fullName: newP.fullName, phone: newP.phone || null, ageYears: newP.ageYears ? Number(newP.ageYears) : null, sex: newP.sex || null, locality: details.locality || null }); pid = np.id; }
      if (!pid) throw new Error('Pick or register a patient');
      return post('/visits', { patientId: pid, appointmentId: init.appointmentId, feeCategoryCode: chosen, practitionerId: practitionerId || null,
        details: { ...details, weight_kg: details.weight_kg ? Number(details.weight_kg) : undefined, locality: details.locality || p?.locality },
        payment: !waive && fee > 0 ? { method, amountPaise: Math.round(Number(amount || fee / 100) * 100) } : undefined, waive: waive ? { reason: waive } : undefined, idempotencyKey: uuid() });
    },
    onSuccess: (v: any) => { toast(`Checked in · token ${v.opNumber}`); onClose(); },
    onError: (e: any) => toast(e instanceof ApiError ? (e.body.code ?? 'Failed') : e.message, 'err'),
  });
  const step = !patientId && !newP ? 1 : 2;
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
              <div className="col-span-3"><label className="label">Full name</label><input autoFocus className="input" value={newP.fullName} onChange={(e) => setNewP({ ...newP, fullName: e.target.value })} /></div>
              <div className="col-span-2"><label className="label">Phone</label><input className="input" value={newP.phone} onChange={(e) => setNewP({ ...newP, phone: e.target.value.replace(/\D/g, '').slice(0, 10) })} /></div>
              <div><label className="label">Age</label><input className="input" value={newP.ageYears} onChange={(e) => setNewP({ ...newP, ageYears: e.target.value })} /></div>
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
          {facts && <div className="flex gap-2 items-start text-sm bg-paper rounded-xl px-3.5 py-2.5"><Icon name="spark" className="h-4 w-4 text-clay shrink-0 mt-0.5" /><span>{facts.days_since_last_paid_consult < 9999 ? <>Last paid consult <b>{facts.days_since_last_paid_consult} days ago</b></> : 'No previous paid consult'} → suggested <b>{sug.data.suggested.name}</b>.{openPlans.length > 0 && <> Open plan: {openPlans.map((r: any) => r.kind === 'procedure' ? 'procedure' : r.kind === 'followup' ? `review ${r.dueOn ? fmtDate(r.dueOn) : ''}` : `test ${r.notes}`).join(', ')}.</>}</span></div>}
          <div className="grid grid-cols-3 gap-2">
            <div><label className="label">Weight (kg)</label><input className="input" inputMode="decimal" value={details.weight_kg} onChange={(e) => setDetails({ ...details, weight_kg: e.target.value })} /></div>
            <div><label className="label">Location</label><input className="input" placeholder={p?.locality ?? ''} value={details.locality} onChange={(e) => setDetails({ ...details, locality: e.target.value })} /></div>
            <div><label className="label">Complaint</label><input className="input" placeholder="acne, review…" value={details.complaint} onChange={(e) => setDetails({ ...details, complaint: e.target.value })} /></div>
          </div>
          <div><label className="label">Visit · fee</label>
            <div className="flex flex-wrap gap-1.5">{cfg?.feeCategories.map((c: any) => <button key={c.code} type="button" className={`toggle-opt !py-2.5 ${chosen === c.code ? 'on' : ''}`} onClick={() => setCat(c.code)}>{c.name.replace(/ \(.*\)/, '')} · {money(c.amountPaise)}{sug.data?.suggested?.code === c.code && <Icon name="spark" className="h-3 w-3 ml-1 inline -mt-0.5" />}</button>)}</div></div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label">Doctor</label><div className="flex flex-wrap gap-1.5">{cfg?.practitioners.map((x: any) => <button key={x.id} type="button" className={`toggle-opt !py-2.5 ${practitionerId === x.id ? 'on' : ''}`} onClick={() => setPractitionerId(practitionerId === x.id ? '' : x.id)}>{x.name} · {waitingByDoctor[x.id] ?? 0} waiting</button>)}</div></div>
            <div><label className="label">Payment</label>
              {fee === 0 ? <div className="text-sm text-muted pt-2.5">Nothing to collect for {catRow?.name?.split(' (')[0] ?? 'this visit'}.</div> : waive ? <div className="text-sm text-amber pt-2.5">Waived · {waive}</div> : (
                <div className="flex gap-1.5 items-center flex-wrap">{['cash', 'upi', 'card'].map((m) => <button key={m} type="button" className={`toggle-opt !py-2.5 uppercase ${method === m ? 'on' : ''}`} onClick={() => setMethod(m)}>{m}</button>)}<input className="input !w-24" value={amount || fee / 100} onChange={(e) => setAmount(e.target.value)} /></div>)}
              {fee > 0 && can(perms, 'payment.waive') && <input className="input mt-2 !py-1.5 text-xs" placeholder="Waive? type the reason (known person, doctor said…)" value={waive} onChange={(e) => setWaive(e.target.value)} />}
            </div>
          </div>
          <div className="flex gap-2 justify-end pt-3 border-t border-line"><button className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" disabled={submit.isPending || !chosen || (!!newP && !newP.fullName)} onClick={() => submit.mutate()}><Icon name="check" />Check in{fee > 0 && !waive ? ` · collect ${money(Math.round(Number(amount || fee / 100) * 100))}` : ''}</button></div>
        </div>
      )}
    </Modal>
  );
}
