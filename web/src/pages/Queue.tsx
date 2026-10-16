import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useNavigate, useOutletContext } from 'react-router';
import { get, post, patch, qc, fmtTime, uuid, ApiError } from '../api';
import { can } from '../App';
import { Avatar, Chip, Empty, Icon, Modal, PageHeader, Section, Skeleton, money, toast } from '../ui';

type Ctx = { me: any; perms: string[]; cfg: any };

export function Queue() {
  const { perms, cfg, me } = useOutletContext<Ctx>();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['queue'], queryFn: () => get('/queue'), refetchInterval: 5000 });
  const [checkIn, setCheckIn] = useState<null | { patientId?: string; appointmentId?: string; name?: string }>(null);
  const update = useMutation({ mutationFn: ({ id, ...body }: any) => patch(`/visits/${id}`, body), onSuccess: () => qc.invalidateQueries({ queryKey: ['queue'] }) });
  const openEncounter = useMutation({ mutationFn: (visitId: string) => post(`/visits/${visitId}/encounter`), onSuccess: (e: any) => nav(`/encounter/${e.id}`, { viewTransition: true }) });

  const rows: any[] = q.data ?? [];
  const waiting = rows.filter((r) => ['waiting', 'intake'].includes(r.status));
  const inConsult = rows.filter((r) => r.status === 'in_consult');
  const done = rows.filter((r) => ['done', 'left'].includes(r.status));
  const isClinical = can(perms, 'encounter.intake');
  const nowServing = inConsult[0] ?? waiting[0];

  return (
    <div>
      <PageHeader title="Live queue" subtitle={`${waiting.length} waiting · ${inConsult.length} in consultation · ${done.length} seen today`}>
        {can(perms, 'visit.write') && <button className="btn btn-primary" onClick={() => setCheckIn({})}><Icon name="plus" />Walk-in / arrival</button>}
      </PageHeader>

      <div className="grid lg:grid-cols-[1fr_340px] gap-5">
        <div className="space-y-5">
          {nowServing && (
            <div className="card anim-fade-up flex items-center gap-4 !border-clay/30" style={{ background: 'linear-gradient(135deg, #fff 0%, #F6E7E0 100%)' }}>
              <div className="h-2.5 w-2.5 rounded-full bg-clay live-dot" />
              <div className="text-xs font-semibold uppercase tracking-wider text-clay">{inConsult.length ? 'Now in consultation' : 'Up next'}</div>
              <div className="serif text-2xl ml-2">{nowServing.opNumber}</div>
              <div className="text-sm text-ink-2">{nowServing.patient.fullName}</div>
              {nowServing.doctor && <Chip className="ml-auto">{nowServing.doctor}</Chip>}
            </div>
          )}
          {inConsult.length > 0 && <Section title="In consultation" delay={40}>{inConsult.map((r, i) => <Row key={r.id} r={r} i={i} actions={isClinical && <button className="btn btn-sm" onClick={() => openEncounter.mutate(r.id)}>Open<Icon name="chevR" className="h-3.5 w-3.5" /></button>} />)}</Section>}
          <Section title="Waiting" aside={<span className="text-xs text-muted">priority first, then arrival order</span>} delay={80}>
            {q.isLoading ? <Skeleton /> : waiting.length === 0 ? <Empty icon="clock" title="Nobody waiting" hint="Arrivals you check in appear here in order." /> :
              waiting.map((r, i) => (
                <Row key={r.id} r={r} i={i} actions={
                  <div className="flex gap-1">
                    {isClinical && <button className="btn btn-sm btn-primary" onClick={() => openEncounter.mutate(r.id)}>{me.role === 'assistant' ? 'Intake' : r.status === 'intake' ? 'Intake in progress' : 'Call in'}</button>}
                    {can(perms, 'visit.queue') && i > 0 && <button className="btn btn-sm btn-icon" title="Move up" onClick={() => update.mutate({ id: r.id, afterVisitId: i >= 2 ? waiting[i - 2].id : null, reason: 'reception' })}><Icon name="up" className="h-3.5 w-3.5" /></button>}
                    {can(perms, 'visit.queue') && <button className="btn btn-sm btn-ghost" onClick={() => update.mutate({ id: r.id, status: 'left' })}>Left</button>}
                  </div>} />
              ))}
          </Section>
          {done.length > 0 && <Section title="Seen today" delay={120} className="opacity-80">{done.map((r, i) => <Row key={r.id} r={r} i={i} muted actions={r.encounterId && <button className="btn btn-sm btn-ghost" onClick={() => window.open(`/print/${r.encounterId}`, '_blank')}><Icon name="print" className="h-3.5 w-3.5" />Rx</button>} />)}</Section>}
        </div>
        <Arrivals onCheckIn={(a) => setCheckIn({ patientId: a.patientId, appointmentId: a.id, name: a.patient.fullName })} />
      </div>
      {checkIn && <CheckInDialog init={checkIn} cfg={cfg} perms={perms} onClose={() => { setCheckIn(null); qc.invalidateQueries({ queryKey: ['queue'] }); qc.invalidateQueries({ queryKey: ['appointments'] }); }} />}
    </div>
  );
}

function Row({ r, i, actions, muted }: { r: any; i: number; actions: React.ReactNode; muted?: boolean }) {
  return (
    <div className="row anim-fade-up" style={{ animationDelay: `${Math.min(i, 8) * 30}ms` }}>
      <div className={`w-16 shrink-0 serif text-lg ${muted ? 'text-muted' : 'text-ink'}`}>{r.opNumber}</div>
      <Avatar name={r.patient.fullName} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap"><span className="font-medium truncate">{r.patient.fullName}</span><span className="text-xs text-muted">{r.patient.ageYears ? `${r.patient.ageYears}y` : ''} {r.patient.sex ?? ''}</span>
          {r.priority > 0 && <Chip tone="amber">priority</Chip>}{r.status === 'intake' && <Chip tone="sky">intake</Chip>}</div>
        <div className="text-xs text-muted mt-0.5 truncate">{[r.details?.complaint, r.details?.weight_kg && `${r.details.weight_kg} kg`, `arrived ${fmtTime(r.arrivedAt)}`, r.category, r.doctor].filter(Boolean).join(' · ')}</div>
      </div>
      {actions}
    </div>
  );
}

function Arrivals({ onCheckIn }: { onCheckIn: (a: any) => void }) {
  const a = useQuery({ queryKey: ['appointments'], queryFn: () => get('/appointments'), refetchInterval: 15000 });
  const pending = (a.data ?? []).filter((x: any) => x.status === 'booked');
  return (
    <Section title={<>Booked, not arrived <span className="text-muted font-normal">· {pending.length}</span></>} delay={160} className="self-start">
      {a.isLoading ? <Skeleton rows={4} /> : pending.length === 0 ? <Empty icon="calendar" title="Everyone booked has arrived" /> :
        <div className="max-h-[70vh] overflow-auto">{pending.map((x: any, i: number) => (
          <div key={x.id} className="row anim-fade-up" style={{ animationDelay: `${Math.min(i, 8) * 30}ms` }}>
            <span className="text-xs font-mono text-muted w-11">{x.window.startTime}</span>
            <div className="min-w-0 flex-1"><div className="text-sm font-medium truncate">{x.patient.fullName}</div><div className="text-xs text-muted">{x.patient.phone}</div></div>
            <button className="btn btn-sm" onClick={() => onCheckIn(x)}>Arrived</button>
          </div>))}</div>}
    </Section>
  );
}

/** One-screen arrival: find/confirm patient → category (suggested) → fee/payment → check in. */
function CheckInDialog({ init, cfg, perms, onClose }: { init: { patientId?: string; appointmentId?: string; name?: string }; cfg: any; perms: string[]; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [patientId, setPatientId] = useState(init.patientId);
  const [newP, setNewP] = useState<null | { fullName: string; phone: string; ageYears: string; sex: string }>(null);
  const [cat, setCat] = useState('');
  const [details, setDetails] = useState({ weight_kg: '', locality: '', complaint: '' });
  const [pay, setPay] = useState({ method: 'cash', amount: '' });
  const [waive, setWaive] = useState('');
  const [practitionerId, setPractitionerId] = useState('');
  const search = useQuery({ queryKey: ['patients', q], queryFn: () => get(`/patients?q=${encodeURIComponent(q)}`), enabled: !patientId && q.length >= 2 });
  const sug = useQuery({ queryKey: ['suggest', patientId], queryFn: () => get(`/patients/${patientId}/suggest-category`), enabled: !!patientId });
  const chosen = cat || sug.data?.suggested?.code || '';
  const catRow = cfg?.feeCategories.find((c: any) => c.code === chosen);
  const fee = catRow?.amountPaise ?? 0;
  const patientRow = sug.data?.patient;

  const submit = useMutation({
    mutationFn: async () => {
      let pid = patientId;
      if (!pid && newP) {
        const p = await post('/patients?force=1', { fullName: newP.fullName, phone: newP.phone || null, ageYears: newP.ageYears ? Number(newP.ageYears) : null, sex: newP.sex || null, locality: details.locality || null });
        pid = p.id;
      }
      if (!pid) throw new Error('Pick or register a patient');
      const amount = Math.round(Number(pay.amount || fee / 100) * 100);
      return post('/visits', { patientId: pid, appointmentId: init.appointmentId, feeCategoryCode: chosen, practitionerId: practitionerId || null,
        details: { ...details, weight_kg: details.weight_kg ? Number(details.weight_kg) : undefined },
        payment: !waive && fee > 0 ? { method: pay.method, amountPaise: amount } : undefined, waive: waive ? { reason: waive } : undefined, idempotencyKey: uuid() });
    },
    onSuccess: (v: any) => { toast(`Checked in · token ${v.opNumber}`); onClose(); },
    onError: (e: any) => toast(e instanceof ApiError ? (e.body.code ?? 'Failed') : e.message, 'err'),
  });

  const step = !patientId && !newP ? 1 : 2;
  return (
    <Modal title="Arrival" subtitle={step === 1 ? 'Find the patient or register a new one' : 'Confirm details, category and fee'} onClose={onClose}>
      {step === 1 && (
        <div className="anim-fade-up">
          <div className="relative"><Icon name="search" className="h-4 w-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" /><input autoFocus className="input !pl-10 !py-3" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Phone number, name or patient ID" /></div>
          <div className="mt-3 card-flat overflow-hidden max-h-64 overflow-y-auto">
            {q.length < 2 ? <div className="p-4 text-sm text-muted">Type at least 2 characters</div> : search.isLoading ? <Skeleton rows={2} /> : (search.data ?? []).length === 0 ? <Empty icon="user" title="No match" hint="Register them below" /> :
              search.data.map((p: any, i: number) => (
                <button key={p.id} className="row w-full text-left anim-fade-up" style={{ animationDelay: `${i * 30}ms` }} onClick={() => setPatientId(p.id)}>
                  <Avatar name={p.fullName} /><div className="flex-1 min-w-0"><div className="text-sm font-medium">{p.fullName} <span className="text-muted font-normal text-xs">{p.ageYears ? `${p.ageYears}y` : ''} {p.sex ?? ''}</span></div><div className="text-xs text-muted">{p.patientNo} · {p.phone ?? 'no phone'} · {p.locality ?? ''}</div></div><Icon name="chevR" className="text-muted" />
                </button>))}
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
            <div className="flex items-center gap-3 card-flat p-3">
              <Avatar name={patientRow?.fullName ?? init.name ?? '?'} />
              <div className="flex-1 min-w-0"><div className="font-medium">{patientRow?.fullName ?? init.name}</div><div className="text-xs text-muted">{patientRow ? `${patientRow.patientNo} · ${patientRow.phone ?? ''}` : 'loading…'}</div></div>
              {!init.patientId && <button className="btn btn-ghost btn-sm" onClick={() => setPatientId(undefined)}>Change</button>}
            </div>
          )}
          <div className="grid grid-cols-3 gap-2">
            <div><label className="label">Weight (kg)</label><input className="input" inputMode="decimal" value={details.weight_kg} onChange={(e) => setDetails({ ...details, weight_kg: e.target.value })} /></div>
            <div><label className="label">Location</label><input className="input" value={details.locality} onChange={(e) => setDetails({ ...details, locality: e.target.value })} /></div>
            <div><label className="label">Main complaint</label><input className="input" value={details.complaint} onChange={(e) => setDetails({ ...details, complaint: e.target.value })} /></div>
          </div>
          <div>
            <label className="label">Visit category</label>
            <div className="flex flex-wrap gap-1.5">
              {cfg?.feeCategories.map((c: any) => (
                <button key={c.code} type="button" className={`toggle-opt ${chosen === c.code ? 'on' : ''}`} onClick={() => setCat(c.code)}>
                  {c.name} <span className={chosen === c.code ? 'opacity-70' : 'text-muted'}>· {money(c.amountPaise)}</span>{sug.data?.suggested?.code === c.code && <Icon name="spark" className="h-3 w-3 text-clay ml-0.5" />}
                </button>))}
            </div>
            {sug.data?.facts && <div className="text-xs text-muted mt-2 flex items-center gap-1"><Icon name="spark" className="h-3 w-3 text-clay" />{sug.data.facts.days_since_last_paid_consult < 9999 ? `Last paid consult ${sug.data.facts.days_since_last_paid_consult} days ago.` : 'No previous paid consult.'} {sug.data.facts.has_open_procedure_course ? 'Has an open procedure course.' : ''} Suggested: <b>{sug.data.suggested.name}</b></div>}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label">Doctor</label><select className="input" value={practitionerId} onChange={(e) => setPractitionerId(e.target.value)}><option value="">Any / decide later</option>{cfg?.practitioners.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
            {fee > 0 && !waive && (<div><label className="label">Payment</label><div className="flex gap-1">{['cash', 'upi', 'card'].map((m) => <button key={m} type="button" className={`toggle-opt uppercase ${pay.method === m ? 'on' : ''}`} onClick={() => setPay({ ...pay, method: m })}>{m}</button>)}<input className="input !w-24 ml-auto" value={pay.amount || fee / 100} onChange={(e) => setPay({ ...pay, amount: e.target.value })} /></div></div>)}
          </div>
          {fee > 0 && can(perms, 'payment.waive') && <div><label className="label">Waive fee (reason)</label><input className="input" placeholder="known person · doctor's instruction · leave blank to collect" value={waive} onChange={(e) => setWaive(e.target.value)} /></div>}
          <div className="flex gap-2 justify-end pt-2 border-t border-line"><button className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" disabled={submit.isPending || !chosen || (!!newP && !newP.fullName)} onClick={() => submit.mutate()}><Icon name="check" />Check in{fee > 0 && !waive ? ` · collect ${money(fee)}` : waive ? ' · waived' : ' · no fee'}</button></div>
        </div>
      )}
    </Modal>
  );
}
