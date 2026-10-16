import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useNavigate, useParams, useOutletContext } from 'react-router';
import { get, post, patch, qc, rupees, ApiError } from '../api';
import { can } from '../App';

export function Patients() {
  const { id } = useParams(); const nav = useNavigate(); const { perms } = useOutletContext<any>();
  const [q, setQ] = useState('');
  const list = useQuery({ queryKey: ['patients', q], queryFn: () => get(`/patients?q=${encodeURIComponent(q)}`) });
  const [showNew, setShowNew] = useState(false);
  return (
    <div className="grid lg:grid-cols-3 gap-4">
      <div className="space-y-2">
        <div className="flex gap-2"><input autoFocus className="input" placeholder="Search phone, name, ID" value={q} onChange={(e) => setQ(e.target.value)} />
          {can(perms, 'patient.write') && <button className="btn btn-primary" onClick={() => setShowNew(true)}>+ New</button>}</div>
        <ul className="card divide-y divide-slate-100 text-sm !p-0">
          {(list.data ?? []).map((p: any) => (
            <li key={p.id} className={`px-3 py-2 cursor-pointer hover:bg-slate-50 ${p.id === id ? 'bg-emerald-50' : ''}`} onClick={() => nav(`/patients/${p.id}`)}>
              <div className="font-medium">{p.fullName} <span className="text-slate-400 font-normal">{p.ageYears ? `${p.ageYears}y` : ''} {p.sex ?? ''}</span></div>
              <div className="text-xs text-slate-500">{p.patientNo} · {p.phone ?? 'no phone'} · {p.locality ?? ''}</div>
            </li>
          ))}
        </ul>
      </div>
      <div className="lg:col-span-2">{id ? <Timeline id={id} /> : <div className="text-sm text-slate-500 p-4">Select a patient to see the timeline.</div>}</div>
      {showNew && <NewPatient onClose={(p) => { setShowNew(false); if (p) { qc.invalidateQueries({ queryKey: ['patients'] }); nav(`/patients/${p.id}`); } }} />}
    </div>
  );
}

function Timeline({ id }: { id: string }) {
  const t = useQuery({ queryKey: ['timeline', id], queryFn: () => get(`/patients/${id}/timeline`) });
  const { perms } = useOutletContext<any>();
  const [edit, setEdit] = useState<any>(null);
  const save = useMutation({ mutationFn: (b: any) => patch(`/patients/${id}`, b), onSuccess: () => { setEdit(null); qc.invalidateQueries({ queryKey: ['timeline', id] }); qc.invalidateQueries({ queryKey: ['patients'] }); } });
  if (!t.data) return <div className="p-4 text-slate-500 text-sm">Loading…</div>;
  const { patient: p, encounters, recommendations, charges, outstandingPaise, visits } = t.data;
  return (
    <div className="space-y-3">
      <div className="card">
        <div className="flex items-start gap-3">
          <div className="flex-1">
            <div className="text-lg font-semibold">{p.fullName} <span className="text-slate-400 text-base font-normal">{p.ageYears ? `${p.ageYears}y` : ''} {p.sex ?? ''}</span></div>
            <div className="text-sm text-slate-500">{p.patientNo} · {p.phone ?? 'no phone'} · {p.locality ?? ''} {p.referralCard && <span className="badge ml-1">Special card</span>}</div>
            {p.allergies && <div className="text-sm text-red-700 mt-1">Allergies: {p.allergies}</div>}
            {p.notes && <div className="text-sm text-slate-600 mt-1">{p.notes}</div>}
          </div>
          <div className="text-right text-sm"><div className="text-slate-500">Visits: {visits.length}</div>{outstandingPaise > 0 && <div className="text-red-700 font-semibold">Due {rupees(outstandingPaise)}</div>}</div>
          {can(perms, 'patient.write') && <button className="btn btn-sm" onClick={() => setEdit({ fullName: p.fullName, phone: p.phone ?? '', ageYears: p.ageYears ?? '', sex: p.sex ?? '', locality: p.locality ?? '', allergies: p.allergies ?? '', notes: p.notes ?? '', referralCard: p.referralCard })}>Edit</button>}
        </div>
        {edit && (
          <div className="grid grid-cols-3 gap-2 mt-3 text-sm">
            {['fullName', 'phone', 'locality', 'allergies', 'notes'].map((k) => <div key={k}><label className="label">{k}</label><input className="input" value={edit[k]} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} /></div>)}
            <div><label className="label">age</label><input className="input" value={edit.ageYears} onChange={(e) => setEdit({ ...edit, ageYears: e.target.value })} /></div>
            <div><label className="label">sex</label><select className="input" value={edit.sex} onChange={(e) => setEdit({ ...edit, sex: e.target.value })}><option value="">–</option><option>M</option><option>F</option><option>O</option></select></div>
            <label className="flex items-center gap-2 mt-5"><input type="checkbox" checked={edit.referralCard} onChange={(e) => setEdit({ ...edit, referralCard: e.target.checked })} /> RMP/PMP referral card</label>
            <div className="col-span-3 flex gap-2 justify-end"><button className="btn" onClick={() => setEdit(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={() => save.mutate({ ...edit, phone: edit.phone || null, ageYears: edit.ageYears === '' ? null : Number(edit.ageYears), sex: edit.sex || null, locality: edit.locality || null, allergies: edit.allergies || null, notes: edit.notes || null })}>Save</button></div>
          </div>
        )}
      </div>
      {recommendations.filter((r: any) => !['done', 'cancelled'].includes(r.status)).length > 0 && (
        <div className="card"><div className="text-sm font-semibold mb-1">Open plans</div>
          {recommendations.filter((r: any) => !['done', 'cancelled'].includes(r.status)).map((r: any) => <div key={r.id} className="text-sm">• {r.kind === 'followup' ? 'Follow-up' : 'Procedure'} {r.dueOn ? `due ${r.dueOn}` : ''} {r.sittings ? `· ${r.sittings} sittings` : ''} {r.notes ?? ''} <span className="badge ml-1">{r.status}</span></div>)}
        </div>
      )}
      {encounters.map((e: any) => (
        <div key={e.id} className="card">
          <div className="flex items-center gap-2 text-sm"><span className="font-semibold">{new Date(e.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</span><span className="badge">{e.status}</span>
            {e.status === 'completed' && <button className="btn btn-sm ml-auto" onClick={() => window.open(`/print/${e.id}`, '_blank')}>Print Rx</button>}</div>
          <div className="text-sm mt-1"><b>{e.data?.complaint?.chief_complaint}</b>{e.data?.assessment?.diagnosis && <> → {e.data.assessment.diagnosis} {e.data.assessment.severity ? `(${e.data.assessment.severity})` : ''}</>}</div>
          {e.prescription.length > 0 && <ul className="text-xs text-slate-600 mt-1 list-disc ml-4">{e.prescription.map((i: any) => <li key={i.id}>{i.name} {i.dose ?? ''} {i.frequency ?? ''} {i.durationDays ? `× ${i.durationDays}d` : ''}</li>)}</ul>}
        </div>
      ))}
      {charges.length > 0 && <div className="card text-sm"><div className="font-semibold mb-1">Charges</div>{charges.map((c: any) => <div key={c.id} className="flex gap-2"><span className="flex-1">{c.description}</span><span className="badge">{c.status}</span><span className="w-20 text-right">{rupees(c.amountPaise)}</span></div>)}</div>}
    </div>
  );
}

function NewPatient({ onClose }: { onClose: (p?: any) => void }) {
  const [f, setF] = useState({ fullName: '', phone: '', ageYears: '', sex: '', locality: '', referralCard: false });
  const [dup, setDup] = useState<any>(null);
  const create = useMutation({
    mutationFn: (force: boolean) => post(`/patients${force ? '?force=1' : ''}`, { ...f, phone: f.phone || null, ageYears: f.ageYears ? Number(f.ageYears) : null, sex: f.sex || null, locality: f.locality || null }),
    onSuccess: (p) => onClose(p), onError: (e: any) => { if (e instanceof ApiError && e.body.code === 'POSSIBLE_DUPLICATE') setDup(e.body.existing); },
  });
  return (
    <div className="fixed inset-0 bg-black/40 grid place-items-center p-4 z-20" onClick={() => onClose()}>
      <div className="card w-full max-w-lg space-y-2" onClick={(e) => e.stopPropagation()}>
        <div className="font-semibold">Register patient</div>
        <div><label className="label">Full name</label><input autoFocus className="input" value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} /></div>
        <div className="grid grid-cols-3 gap-2">
          <div><label className="label">Phone</label><input className="input" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value.replace(/\D/g, '').slice(0, 10) })} /></div>
          <div><label className="label">Age</label><input className="input" value={f.ageYears} onChange={(e) => setF({ ...f, ageYears: e.target.value })} /></div>
          <div><label className="label">Sex</label><select className="input" value={f.sex} onChange={(e) => setF({ ...f, sex: e.target.value })}><option value="">–</option><option>M</option><option>F</option><option>O</option></select></div>
        </div>
        <div><label className="label">Location</label><input className="input" value={f.locality} onChange={(e) => setF({ ...f, locality: e.target.value })} /></div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.referralCard} onChange={(e) => setF({ ...f, referralCard: e.target.checked })} /> RMP/PMP referral card</label>
        {dup && <div className="text-sm text-amber-800 bg-amber-50 rounded p-2">A patient with this name and phone exists ({dup.patientNo}). <button className="underline" onClick={() => create.mutate(true)}>Register anyway</button> (family member) or <button className="underline" onClick={() => onClose({ id: dup.id })}>open existing</button>.</div>}
        <div className="flex gap-2 justify-end"><button className="btn" onClick={() => onClose()}>Cancel</button><button className="btn btn-primary" disabled={!f.fullName} onClick={() => create.mutate(false)}>Register</button></div>
      </div>
    </div>
  );
}
