import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useNavigate, useOutletContext } from 'react-router';
import { get, post, patch, qc, rupees, fmtTime, uuid, ApiError } from '../api';
import { can } from '../App';

type Ctx = { me: any; perms: string[]; cfg: any };

export function Queue() {
  const { perms, cfg, me } = useOutletContext<Ctx>();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['queue'], queryFn: () => get('/queue'), refetchInterval: 5000 });
  const [checkIn, setCheckIn] = useState<null | { patientId?: string; appointmentId?: string }>(null);
  const update = useMutation({ mutationFn: ({ id, ...body }: any) => patch(`/visits/${id}`, body), onSuccess: () => qc.invalidateQueries({ queryKey: ['queue'] }) });
  const openEncounter = useMutation({ mutationFn: (visitId: string) => post(`/visits/${visitId}/encounter`), onSuccess: (e: any) => nav(`/encounter/${e.id}`) });

  const rows: any[] = q.data ?? [];
  const waiting = rows.filter((r) => ['waiting', 'intake'].includes(r.status));
  const inConsult = rows.filter((r) => r.status === 'in_consult');
  const done = rows.filter((r) => ['done', 'left'].includes(r.status));
  const isClinical = can(perms, 'encounter.intake');

  return (
    <div className="grid lg:grid-cols-3 gap-4">
      <div className="lg:col-span-2 space-y-4">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">Live queue</h1>
          <span className="badge">{waiting.length} waiting</span><span className="badge">{inConsult.length} in consult</span><span className="badge">{done.length} done</span>
          {can(perms, 'visit.write') && <button className="btn btn-primary ml-auto" onClick={() => setCheckIn({})}>+ Walk-in / arrival</button>}
        </div>
        {inConsult.length > 0 && <Section title="In consultation" rows={inConsult} render={(r) => isClinical && <button className="btn btn-sm" onClick={() => openEncounter.mutate(r.id)}>Open</button>} />}
        <Section title="Waiting" rows={waiting} render={(r, i) => (
          <div className="flex gap-1">
            {isClinical && <button className="btn btn-sm btn-primary" onClick={() => openEncounter.mutate(r.id)}>{r.status === 'intake' ? 'Intake…' : me.role === 'assistant' ? 'Intake' : 'Call in'}</button>}
            {can(perms, 'visit.queue') && i > 0 && <button className="btn btn-sm" title="Move up" onClick={() => update.mutate({ id: r.id, afterVisitId: i >= 2 ? waiting[i - 2].id : null, reason: 'reception' })}>↑</button>}
            {can(perms, 'visit.queue') && <button className="btn btn-sm" onClick={() => update.mutate({ id: r.id, status: 'left' })}>Left</button>}
          </div>
        )} />
        <Section title="Seen today" rows={done} muted render={(r) => r.encounterId && <button className="btn btn-sm" onClick={() => window.open(`/print/${r.encounterId}`, '_blank')}>Print Rx</button>} />
      </div>
      <div className="space-y-4">
        <Arrivals onCheckIn={(a) => setCheckIn({ patientId: a.patientId, appointmentId: a.id })} />
      </div>
      {checkIn && <CheckInDialog init={checkIn} cfg={cfg} perms={perms} onClose={() => { setCheckIn(null); qc.invalidateQueries({ queryKey: ['queue'] }); qc.invalidateQueries({ queryKey: ['appointments'] }); }} />}
    </div>
  );
}

function Section({ title, rows, render, muted }: { title: string; rows: any[]; render: (r: any, i: number) => React.ReactNode; muted?: boolean }) {
  return (
    <div className={`card ${muted ? 'opacity-70' : ''}`}>
      <div className="text-sm font-semibold mb-2">{title}</div>
      {rows.length === 0 && <div className="text-sm text-slate-400">Nobody here</div>}
      <ul className="divide-y divide-slate-100">
        {rows.map((r, i) => (
          <li key={r.id} className="py-2 flex items-center gap-3 text-sm">
            <span className="w-16 font-mono font-semibold">{r.opNumber}</span>
            <div className="flex-1">
              <div className="font-medium">{r.patient.fullName} <span className="text-slate-400">{r.patient.ageYears ? `${r.patient.ageYears}y` : ''} {r.patient.sex ?? ''}</span>
                {r.priority > 0 && <span className="badge !bg-amber-100 !text-amber-800 ml-2">priority</span>}
                {r.status === 'intake' && <span className="badge !bg-sky-100 !text-sky-800 ml-2">intake</span>}</div>
              <div className="text-xs text-slate-500">{r.details?.complaint ?? ''} {r.details?.weight_kg ? `· ${r.details.weight_kg} kg` : ''} · arrived {fmtTime(r.arrivedAt)} · {r.category}{r.doctor ? ` · ${r.doctor}` : ''}</div>
            </div>
            {render(r, i)}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Arrivals({ onCheckIn }: { onCheckIn: (a: any) => void }) {
  const a = useQuery({ queryKey: ['appointments'], queryFn: () => get('/appointments'), refetchInterval: 15000 });
  const pending = (a.data ?? []).filter((x: any) => x.status === 'booked');
  return (
    <div className="card">
      <div className="text-sm font-semibold mb-2">Booked, not yet arrived ({pending.length})</div>
      <ul className="divide-y divide-slate-100 text-sm max-h-[70vh] overflow-auto">
        {pending.map((x: any) => (
          <li key={x.id} className="py-2 flex items-center gap-2">
            <span className="font-mono text-xs text-slate-500 w-12">{x.window.startTime}</span>
            <div className="flex-1"><div className="font-medium">{x.patient.fullName}</div><div className="text-xs text-slate-500">{x.patient.phone}</div></div>
            <button className="btn btn-sm btn-primary" onClick={() => onCheckIn(x)}>Arrived</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One-screen arrival: find/confirm patient → category (suggested) → fee/payment → check in. */
function CheckInDialog({ init, cfg, perms, onClose }: { init: { patientId?: string; appointmentId?: string }; cfg: any; perms: string[]; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [patientId, setPatientId] = useState(init.patientId);
  const [newP, setNewP] = useState<null | { fullName: string; phone: string; ageYears: string; sex: string }>(null);
  const [cat, setCat] = useState<string>('');
  const [details, setDetails] = useState({ weight_kg: '', locality: '', complaint: '' });
  const [pay, setPay] = useState<{ method: string; amount: string }>({ method: 'cash', amount: '' });
  const [waive, setWaive] = useState('');
  const [practitionerId, setPractitionerId] = useState('');
  const [err, setErr] = useState('');
  const search = useQuery({ queryKey: ['patients', q], queryFn: () => get(`/patients?q=${encodeURIComponent(q)}`), enabled: !patientId && q.length >= 2 });
  const sug = useQuery({ queryKey: ['suggest', patientId], queryFn: () => get(`/patients/${patientId}/suggest-category`), enabled: !!patientId });
  const chosen = cat || sug.data?.suggested?.code || '';
  const catRow = cfg?.feeCategories.find((c: any) => c.code === chosen);
  const fee = catRow?.amountPaise ?? 0;
  const patientRow = search.data?.find((p: any) => p.id === patientId) ?? sug.data?.patient;

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
    onSuccess: onClose, onError: (e: any) => setErr(e instanceof ApiError ? JSON.stringify(e.body) : e.message),
  });

  return (
    <div className="fixed inset-0 bg-black/40 grid place-items-center p-4 z-20" onClick={onClose}>
      <div className="card w-full max-w-2xl space-y-3 max-h-[95vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="font-semibold">Arrival & check-in</div>
        {!patientId && !newP && (
          <div>
            <label className="label">Find patient (phone, name or ID)</label>
            <input autoFocus className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="98765…" />
            <ul className="mt-2 divide-y divide-slate-100 text-sm max-h-48 overflow-auto">
              {(search.data ?? []).map((p: any) => <li key={p.id} className="py-1.5 flex gap-2 items-center"><span className="font-mono text-xs text-slate-500">{p.patientNo}</span><span className="flex-1">{p.fullName} <span className="text-slate-400">{p.phone} {p.ageYears ? `${p.ageYears}y` : ''}</span></span><button className="btn btn-sm" onClick={() => setPatientId(p.id)}>Select</button></li>)}
            </ul>
            <button className="btn btn-sm mt-2" onClick={() => setNewP({ fullName: /^\d+$/.test(q) ? '' : q, phone: /^\d+$/.test(q) ? q : '', ageYears: '', sex: '' })}>+ New patient</button>
          </div>
        )}
        {newP && (
          <div className="grid grid-cols-4 gap-2">
            <div className="col-span-2"><label className="label">Full name</label><input autoFocus className="input" value={newP.fullName} onChange={(e) => setNewP({ ...newP, fullName: e.target.value })} /></div>
            <div><label className="label">Phone</label><input className="input" value={newP.phone} onChange={(e) => setNewP({ ...newP, phone: e.target.value.replace(/\D/g, '').slice(0, 10) })} /></div>
            <div className="flex gap-1"><div><label className="label">Age</label><input className="input" value={newP.ageYears} onChange={(e) => setNewP({ ...newP, ageYears: e.target.value })} /></div>
              <div><label className="label">Sex</label><select className="input" value={newP.sex} onChange={(e) => setNewP({ ...newP, sex: e.target.value })}><option value="">–</option><option>M</option><option>F</option><option>O</option></select></div></div>
          </div>
        )}
        {patientId && patientRow && <div className="text-sm bg-slate-50 rounded p-2 flex items-center gap-2"><span className="font-mono text-xs text-slate-500">{patientRow.patientNo}</span><b>{patientRow.fullName}</b> <span className="text-slate-500">{patientRow.phone}</span>{!init.patientId && <button className="btn btn-sm ml-auto" onClick={() => setPatientId(undefined)}>change</button>}</div>}
        {(patientId || newP) && (<>
          <div className="grid grid-cols-3 gap-2">
            <div><label className="label">Weight (kg)</label><input className="input" value={details.weight_kg} onChange={(e) => setDetails({ ...details, weight_kg: e.target.value })} /></div>
            <div><label className="label">Location</label><input className="input" value={details.locality} onChange={(e) => setDetails({ ...details, locality: e.target.value })} /></div>
            <div><label className="label">Main complaint</label><input className="input" value={details.complaint} onChange={(e) => setDetails({ ...details, complaint: e.target.value })} /></div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="label">Visit category {sug.data?.suggested && !cat && <span className="text-emerald-700">· suggested: {sug.data.suggested.name}</span>}</label>
              <select className="input" value={chosen} onChange={(e) => setCat(e.target.value)}>
                {cfg?.feeCategories.map((c: any) => <option key={c.code} value={c.code}>{c.name} — {rupees(c.amountPaise)}</option>)}
              </select>
              {sug.data?.facts && <div className="text-xs text-slate-500 mt-1">{sug.data.facts.days_since_last_paid_consult < 9999 ? `Last paid consult ${sug.data.facts.days_since_last_paid_consult} days ago. ` : 'No previous paid consult. '}{sug.data.facts.has_open_procedure_course ? 'Open procedure course.' : ''}</div>}
            </div>
            <div><label className="label">Doctor</label><select className="input" value={practitionerId} onChange={(e) => setPractitionerId(e.target.value)}><option value="">Any / decide later</option>{cfg?.practitioners.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
          </div>
          {fee > 0 && (
            <div className="grid grid-cols-3 gap-2 items-end">
              <div><label className="label">Payment method</label><select className="input" value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })} disabled={!!waive}><option value="cash">Cash</option><option value="upi">UPI</option><option value="card">Card</option></select></div>
              <div><label className="label">Amount (₹)</label><input className="input" value={pay.amount || fee / 100} onChange={(e) => setPay({ ...pay, amount: e.target.value })} disabled={!!waive} /></div>
              {can(perms, 'payment.waive') && <div><label className="label">Waive (reason)</label><input className="input" placeholder="known person / doctor said" value={waive} onChange={(e) => setWaive(e.target.value)} /></div>}
            </div>
          )}
          {err && <div className="text-xs text-red-600 break-all">{err}</div>}
          <div className="flex gap-2 justify-end"><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={submit.isPending || !chosen} onClick={() => submit.mutate()}>Check in {fee > 0 && !waive ? `· collect ${rupees(fee)}` : ''}</button></div>
        </>)}
      </div>
    </div>
  );
}
