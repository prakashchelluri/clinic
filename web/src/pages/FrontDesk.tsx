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

/** The receptionist's home: who is due, who is waiting, who is with the doctor, who just finished and needs what. */
export function FrontDesk() {
  const { perms, cfg, me } = useOutletContext<Ctx>();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['frontdesk'], queryFn: () => get('/frontdesk'), refetchInterval: 5000 });
  const [arrive, setArrive] = useState<null | { patientId?: string; appointmentId?: string; name?: string }>(null);
  const [find, setFind] = useState('');
  const refresh = () => { qc.invalidateQueries({ queryKey: ['frontdesk'] }); qc.invalidateQueries({ queryKey: ['queue'] }); };
  const upVisit = useMutation({ mutationFn: ({ id, ...b }: any) => patch(`/visits/${id}`, b), onSuccess: refresh });
  const upAppt = useMutation({ mutationFn: ({ id, ...b }: any) => patch(`/appointments/${id}`, b), onSuccess: () => { refresh(); toast('Marked no-show', 'info'); } });
  const collect = useMutation({ mutationFn: ({ c, method }: any) => post('/payments', { patientId: c.patientId, chargeId: c.id, amountPaise: c.amountPaise, method, idempotencyKey: uuid() }), onSuccess: () => { refresh(); toast('Collected'); } });
  const openEncounter = useMutation({ mutationFn: (visitId: string) => post(`/visits/${visitId}/encounter`), onSuccess: (e: any) => nav(`/encounter/${e.id}`, { viewTransition: true }) });
  const d = q.data;
  const isClinical = can(perms, 'encounter.intake'); const canDesk = can(perms, 'visit.write');
  const f = find.trim().toLowerCase();
  const match = (p: any, extra = '') => !f || p.fullName.toLowerCase().includes(f) || (p.phone ?? '').includes(f) || p.patientNo.toLowerCase().includes(f) || extra.toLowerCase().includes(f);

  const appts: any[] = (d?.appointments ?? []).filter((a: any) => a.status === 'booked' && match(a.patient));
  const visits: any[] = d?.visits ?? [];
  const waiting = visits.filter((v) => ['waiting', 'intake'].includes(v.status) && match(v.patient, v.opNumber));
  const inConsult = visits.filter((v) => v.status === 'in_consult' && match(v.patient, v.opNumber));
  const done = visits.filter((v) => ['done', 'left'].includes(v.status) && match(v.patient, v.opNumber)).sort((a, b) => (b.completedAt ?? b.arrivedAt).localeCompare(a.completedAt ?? a.arrivedAt));
  const finishedUnhandled = done.filter((v) => v.status === 'done' && !v.details?.explainedAt && (v.recommendations.length || v.due.length));
  const late = appts.filter((a) => toMin(a.window.endTime) < nowMin());
  const dueTotal = visits.reduce((s, v) => s + v.due.reduce((x: number, c: any) => x + c.amountPaise, 0), 0);
  const collected = (d?.payments ?? []).reduce((s: number, p: any) => s + p.total, 0);
  const longest = waiting.length ? Math.max(...waiting.map((v) => minsSince(v.arrivedAt))) : 0;
  const needs = late.length + visits.filter((v) => v.due.length).length;
  const dayLabel = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <div>
      <div className="anim-fade-up flex flex-wrap items-center gap-3 mb-5">
        <div className="mr-auto"><h1 className="text-[28px] leading-tight font-medium">Front desk</h1>
          <div className="text-sm text-muted mt-0.5">{dayLabel}{(d?.doctors ?? []).filter((x: any) => x.from).map((x: any) => ` · ${x.name.replace('Dr. ', 'Dr. ')} ${x.from <= toHHMM(nowMin()) ? 'until' : 'from'} ${x.from <= toHHMM(nowMin()) ? x.until : x.from}`).join('')}</div></div>
        <div className="relative"><Icon name="search" className="h-4 w-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" /><input className="input !pl-10 !w-72 !rounded-full" placeholder="Phone, name or token" value={find} onChange={(e) => setFind(e.target.value)} /></div>
        {canDesk && <button className="btn btn-primary !py-2.5" onClick={() => setArrive({})}><Icon name="plus" />Patient arrived</button>}
      </div>

      {!d ? <Skeleton rows={3} /> : (<>
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-5 stagger">
          <Tile i={0} label="Appointments" value={d.appointments.filter((a: any) => a.status !== 'cancelled').length} sub={`${appts.length} still to come`} />
          <Tile i={1} label="Waiting now" value={waiting.length} tone="clay" sub={waiting.length ? `longest ${longest} min` : 'nobody waiting'} />
          <Tile i={2} label="Completed" value={done.filter((v) => v.status === 'done').length} sub={inConsult.length ? `${inConsult.length} with the doctor` : ''} />
          <Tile i={3} label="Collected" value={money(collected)} tone="sage" sub={(d.payments ?? []).map((p: any) => `${p.method.toUpperCase()} ${money(p.total)}`).join(' · ') || 'nothing yet'} />
          <Tile i={4} label="Needs you" value={needs} tone={needs ? 'rose' : ''} sub={[late.length && `${late.length} not arrived`, dueTotal && `${money(dueTotal)} due`].filter(Boolean).join(' · ') || 'all clear'} />
        </div>

        <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-4 items-start">
          <Col title="Scheduled appointments" count={appts.length} empty="Everyone booked has arrived">
            {appts.map((a, i) => { const isLate = toMin(a.window.endTime) < nowMin(); return (
              <div key={a.id} className={`px-3.5 py-2.5 border-t border-line first:border-t-0 anim-fade-up ${isLate ? 'bg-rose-soft/50' : ''}`} style={{ animationDelay: `${Math.min(i, 8) * 25}ms` }}>
                <div className="flex justify-between text-sm"><span className="font-semibold">{a.patient.fullName}</span><span className={isLate ? 'text-rose font-semibold' : 'text-muted'}>{a.window.startTime}{isLate ? ' · late' : ''}</span></div>
                <div className="text-xs text-muted mt-0.5">{[a.patient.phone, a.patient.ageYears && `${a.patient.ageYears} ${a.patient.sex ?? ''}`, a.patient.locality, a.note].filter(Boolean).join(' · ')}</div>
                {canDesk && <div className="flex gap-1.5 mt-2"><button className="btn btn-sm !bg-ink !text-paper !border-ink" onClick={() => setArrive({ patientId: a.patientId, appointmentId: a.id, name: a.patient.fullName })}>Arrived</button>
                  {isLate && <><a className="btn btn-sm" href={`tel:${a.patient.phone ?? ''}`}>Call</a><button className="btn btn-sm btn-ghost" onClick={() => upAppt.mutate({ id: a.id, status: 'no_show' })}>No-show</button></>}</div>}
              </div>); })}
          </Col>

          <Col title="Waiting" hint="in order" count={waiting.length} empty="Nobody waiting" highlight>
            {waiting.map((v, i) => (
              <div key={v.id} className="px-3.5 py-2.5 border-t border-line first:border-t-0 flex items-center gap-2.5 anim-fade-up" style={{ animationDelay: `${Math.min(i, 8) * 25}ms` }}>
                <div className="serif text-lg w-14 shrink-0">{v.opNumber}</div>
                <div className="flex-1 min-w-0"><div className="text-sm font-semibold truncate">{v.patient.fullName}</div><div className="text-xs text-muted truncate">{minsSince(v.arrivedAt)} min{v.doctor ? ` · ${v.doctor.replace('Dr. ', 'Dr. ')}` : ''}{v.status === 'intake' ? ' · intake' : ''}</div></div>
                {i === 0 && v.priority === 0 && v.status !== 'intake' && <Chip tone="clay">next</Chip>}
                {v.priority > 0 && <Chip tone="amber">priority</Chip>}
                {v.status === 'intake' && <Chip tone="sky">intake</Chip>}
                {isClinical && <button className="btn btn-sm btn-ghost btn-icon" title={me.role === 'assistant' ? 'Intake' : 'Call in'} onClick={() => openEncounter.mutate(v.id)}><Icon name="chevR" /></button>}
                {canDesk && <div className="flex flex-col"><button className="btn btn-ghost btn-icon !h-6 !w-6" title="Move up" disabled={i === 0} onClick={() => upVisit.mutate({ id: v.id, afterVisitId: i >= 2 ? waiting[i - 2].id : null })}><Icon name="up" className="h-3 w-3" /></button><button className="btn btn-ghost btn-icon !h-6 !w-6" title="Left without consult" onClick={() => upVisit.mutate({ id: v.id, status: 'left' })}><Icon name="x" className="h-3 w-3" /></button></div>}
              </div>
            ))}
            {waiting.length > 0 && <div className="px-3.5 py-2 text-[11px] text-muted">The doctor calls the next patient from their screen.</div>}
          </Col>

          <Col title="With the doctor" count={inConsult.length} empty="Consultation room is free">
            {inConsult.map((v) => (
              <div key={v.id} className="px-3.5 py-3 border-t border-line first:border-t-0 anim-fade-up">
                <div className="flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-clay live-dot" /><span className="serif text-lg">{v.opNumber}</span><span className="text-sm font-semibold truncate">{v.patient.fullName}</span>{isClinical && <button className="btn btn-sm btn-ghost ml-auto" onClick={() => openEncounter.mutate(v.id)}>Open</button>}</div>
                <div className="text-xs text-muted mt-1">{v.doctor ?? 'Doctor'}</div>
              </div>
            ))}
          </Col>

          <Col title="Just finished" hint="what to tell them" count={finishedUnhandled.length} empty="Nothing to hand over">
            {done.slice(0, 12).map((v, i) => { const handled = !!v.details?.explainedAt || (!v.recommendations.length && !v.due.length); return (
              <div key={v.id} className={`px-3.5 py-2.5 border-t border-line first:border-t-0 anim-fade-up ${v.due.length ? 'bg-rose-soft/50' : handled ? 'opacity-60' : ''}`} style={{ animationDelay: `${Math.min(i, 8) * 25}ms` }}>
                <div className="flex justify-between text-sm"><span className="font-semibold">{v.patient.fullName}</span>{v.due.length ? <span className="text-rose font-semibold">{money(v.due.reduce((s: number, c: any) => s + c.amountPaise, 0))} due</span> : <span className="text-muted">{v.opNumber}</span>}</div>
                {v.status === 'left' ? <div className="text-xs text-muted mt-0.5">Left without consultation</div> : (
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {v.recommendations.map((r: any) => <Chip key={r.id} tone={r.kind === 'procedure' ? 'sky' : r.kind === 'investigation' ? 'clay' : 'amber'}>{r.kind === 'procedure' ? `${r.procedure ?? 'Procedure'}${r.sittings ? ` · ${r.sittings} sittings` : ''} → coordinator` : r.kind === 'investigation' ? `Test: ${r.notes}` : `Review ${r.dueOn ? fmtDate(r.dueOn) : ''}`}</Chip>)}
                    {!v.recommendations.length && !v.due.length && <span className="text-xs text-muted">Medicines only · pharmacy has the Rx</span>}
                  </div>)}
                {v.status === 'done' && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {v.due.map((c: any) => canDesk && <span key={c.id} className="flex gap-1"><button className="btn btn-sm btn-primary" onClick={() => collect.mutate({ c, method: 'cash' })}>Collect {money(c.amountPaise)} cash</button><button className="btn btn-sm" onClick={() => collect.mutate({ c, method: 'upi' })}>UPI</button></span>)}
                    {v.encounterId && <button className="btn btn-sm" onClick={() => window.open(`/print/${v.encounterId}?auto=0`, '_blank')}><Icon name="print" className="h-3.5 w-3.5" />Rx</button>}
                    {canDesk && !handled && v.recommendations.length > 0 && <button className="btn btn-sm !bg-ink !text-paper !border-ink" onClick={() => upVisit.mutate({ id: v.id, details: { explainedAt: new Date().toISOString() } })}><Icon name="check" className="h-3.5 w-3.5" />Explained</button>}
                  </div>)}
              </div>); })}
          </Col>
        </div>
      </>)}
      {arrive && <ArrivalSheet init={arrive} cfg={cfg} perms={perms} waitingByDoctor={Object.fromEntries((d?.doctors ?? []).map((x: any) => [x.id, visits.filter((v) => ['waiting', 'intake'].includes(v.status) && v.practitionerId === x.id).length]))} onClose={() => { setArrive(null); refresh(); }} />}
    </div>
  );
}

const toHHMM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

function Tile({ i, label, value, sub, tone = '' }: { i: number; label: string; value: any; sub?: string; tone?: '' | 'clay' | 'sage' | 'rose' }) {
  return (
    <div className={`card !p-3.5 ${tone === 'rose' ? '!bg-rose-soft !border-rose/30' : ''}`} style={{ ['--i' as any]: i }}>
      <div className={`text-[11px] font-semibold uppercase tracking-wider ${tone === 'rose' ? 'text-rose' : 'text-muted'}`}>{label}</div>
      <div className={`serif text-[28px] leading-none mt-1.5 ${tone === 'clay' ? 'text-clay' : tone === 'sage' ? 'text-sage' : tone === 'rose' ? 'text-rose' : ''}`}>{value}</div>
      {sub && <div className="text-xs text-muted mt-1.5 truncate">{sub}</div>}
    </div>
  );
}

function Col({ title, hint, count, empty, highlight, children }: { title: string; hint?: string; count: number; empty: string; highlight?: boolean; children: React.ReactNode }) {
  return (
    <section className={`card-flat overflow-hidden anim-fade-up ${highlight ? '!border-clay ring-4 ring-clay/10' : ''}`}>
      <div className="flex items-center gap-2 px-3.5 py-2.5 border-b border-line"><div className="text-sm font-semibold">{title}</div>{hint && <span className="text-[11px] text-muted">{hint}</span>}<span className="ml-auto text-xs text-muted">{count}</span></div>
      {count === 0 && !children ? null : null}
      {(Array.isArray(children) ? children.flat().filter(Boolean).length === 0 : !children) ? <div className="p-4 text-sm text-muted">{empty}</div> : children}
    </section>
  );
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
