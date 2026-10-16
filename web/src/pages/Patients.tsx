import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useNavigate, useParams, useOutletContext } from 'react-router';
import { get, post, patch, qc, ApiError } from '../api';
import { can } from '../App';
import { Avatar, Chip, Empty, Icon, Modal, PageHeader, Section, Skeleton, fmtDate, money, toast } from '../ui';

export function Patients() {
  const { id } = useParams(); const nav = useNavigate(); const { perms } = useOutletContext<any>();
  const [q, setQ] = useState('');
  const list = useQuery({ queryKey: ['patients', q], queryFn: () => get(`/patients?q=${encodeURIComponent(q)}`) });
  const [showNew, setShowNew] = useState(false);
  return (
    <div>
      <PageHeader title="Patients" subtitle="One record per person, even when a family shares a phone">
        {can(perms, 'patient.write') && <button className="btn btn-primary" onClick={() => setShowNew(true)}><Icon name="plus" />Register</button>}
      </PageHeader>
      <div className="grid lg:grid-cols-[360px_1fr] gap-5">
        <div className="space-y-3">
          <div className="relative anim-fade-up"><Icon name="search" className="h-4 w-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" /><input autoFocus className="input !pl-10 !py-3" placeholder="Phone, name or patient ID" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <Section delay={60}>
            {list.isLoading ? <Skeleton rows={5} /> : (list.data ?? []).length === 0 ? <Empty icon="user" title="No patients found" /> :
              (list.data ?? []).map((p: any, i: number) => (
                <button key={p.id} className={`row w-full text-left anim-fade-up ${p.id === id ? '!bg-clay-soft/60' : ''}`} style={{ animationDelay: `${Math.min(i, 10) * 25}ms` }} onClick={() => nav(`/patients/${p.id}`, { viewTransition: true })}>
                  <Avatar name={p.fullName} />
                  <div className="min-w-0 flex-1"><div className="text-sm font-medium truncate">{p.fullName} <span className="text-xs text-muted font-normal">{p.ageYears ? `${p.ageYears}y` : ''} {p.sex ?? ''}</span></div><div className="text-xs text-muted truncate">{p.patientNo} · {p.phone ?? 'no phone'}{p.locality ? ` · ${p.locality}` : ''}</div></div>
                  <Icon name="chevR" className={`h-4 w-4 ${p.id === id ? 'text-clay' : 'text-muted/50'}`} />
                </button>))}
          </Section>
        </div>
        <div>{id ? <Timeline key={id} id={id} /> : <div className="card border-dashed anim-fade-in"><Empty icon="users" title="Select a patient" hint="Their visits, prescriptions, plans and payments appear here as one timeline." /></div>}</div>
      </div>
      {showNew && <NewPatient onClose={(p) => { setShowNew(false); if (p) { qc.invalidateQueries({ queryKey: ['patients'] }); nav(`/patients/${p.id}`); } }} />}
    </div>
  );
}

function Timeline({ id }: { id: string }) {
  const t = useQuery({ queryKey: ['timeline', id], queryFn: () => get(`/patients/${id}/timeline`) });
  const { perms } = useOutletContext<any>();
  const [edit, setEdit] = useState<any>(null);
  const save = useMutation({ mutationFn: (b: any) => patch(`/patients/${id}`, b), onSuccess: () => { setEdit(null); qc.invalidateQueries({ queryKey: ['timeline', id] }); qc.invalidateQueries({ queryKey: ['patients'] }); toast('Saved'); } });
  if (!t.data) return <div className="card"><Skeleton rows={4} /></div>;
  const { patient: p, encounters, recommendations, charges, outstandingPaise, visits } = t.data;
  const openPlans = recommendations.filter((r: any) => !['done', 'cancelled'].includes(r.status));
  return (
    <div className="space-y-4">
      <div className="card anim-fade-up">
        <div className="flex items-start gap-4">
          <Avatar name={p.fullName} size="h-14 w-14 text-lg" />
          <div className="flex-1 min-w-0">
            <h2 className="text-2xl font-medium leading-tight">{p.fullName} <span className="text-muted text-lg font-normal">{p.ageYears ? `${p.ageYears}y` : ''} {p.sex ?? ''}</span></h2>
            <div className="text-sm text-muted mt-1 flex items-center gap-2 flex-wrap"><span>{p.patientNo}</span><span>·</span><span>{p.phone ?? 'no phone'}</span>{p.locality && <><span>·</span><span>{p.locality}</span></>}{p.referralCard && <Chip tone="sky">Special card</Chip>}</div>
            {p.allergies && <div className="mt-2 inline-flex items-center gap-1.5 text-sm text-rose bg-rose-soft rounded-full px-3 py-1"><Icon name="spark" className="h-3.5 w-3.5" />Allergies: {p.allergies}</div>}
            {p.notes && <div className="text-sm text-ink-2 mt-2">{p.notes}</div>}
          </div>
          <div className="text-right"><div className="text-[11px] uppercase tracking-wider text-muted">Visits</div><div className="serif text-2xl">{visits.length}</div>{outstandingPaise > 0 && <div className="text-sm text-rose font-medium mt-1">Due {money(outstandingPaise)}</div>}</div>
          {can(perms, 'patient.write') && <button className="btn btn-ghost btn-icon" title="Edit" onClick={() => setEdit({ fullName: p.fullName, phone: p.phone ?? '', ageYears: p.ageYears ?? '', sex: p.sex ?? '', locality: p.locality ?? '', allergies: p.allergies ?? '', notes: p.notes ?? '', referralCard: p.referralCard })}><Icon name="edit" /></button>}
        </div>
        {edit && (
          <div className="grid grid-cols-3 gap-3 mt-5 pt-4 border-t border-line anim-fade-up">
            {[['fullName', 'Full name'], ['phone', 'Phone'], ['locality', 'Location'], ['allergies', 'Allergies'], ['notes', 'Notes']].map(([k, l]) => <div key={k} className={k === 'notes' ? 'col-span-3' : ''}><label className="label">{l}</label><input className="input" value={edit[k]} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} /></div>)}
            <div><label className="label">Age</label><input className="input" value={edit.ageYears} onChange={(e) => setEdit({ ...edit, ageYears: e.target.value })} /></div>
            <div><label className="label">Sex</label><div className="flex gap-1">{['M', 'F', 'O'].map((s) => <button key={s} type="button" className={`toggle-opt ${edit.sex === s ? 'on' : ''}`} onClick={() => setEdit({ ...edit, sex: s })}>{s}</button>)}</div></div>
            <label className="flex items-center gap-2 text-sm self-end pb-2"><input type="checkbox" className="accent-clay" checked={edit.referralCard} onChange={(e) => setEdit({ ...edit, referralCard: e.target.checked })} /> RMP/PMP referral card</label>
            <div className="col-span-3 flex gap-2 justify-end"><button className="btn btn-ghost" onClick={() => setEdit(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={() => save.mutate({ ...edit, phone: edit.phone || null, ageYears: edit.ageYears === '' ? null : Number(edit.ageYears), sex: edit.sex || null, locality: edit.locality || null, allergies: edit.allergies || null, notes: edit.notes || null })}>Save</button></div>
          </div>
        )}
      </div>
      {openPlans.length > 0 && (
        <Section title="Open plans" delay={60}>
          {openPlans.map((r: any) => <div key={r.id} className="row"><Icon name={r.kind === 'followup' ? 'clock' : 'stetho'} className="h-4 w-4 text-clay" /><div className="flex-1 text-sm">{r.kind === 'followup' ? 'Follow-up review' : 'Procedure'}{r.sittings ? ` · ${r.sittings} sittings` : ''}{r.notes ? ` · ${r.notes}` : ''}</div>{r.dueOn && <Chip>due {fmtDate(r.dueOn)}</Chip>}<Chip tone={r.status === 'scheduled' ? 'sage' : ''}>{r.status}</Chip></div>)}
        </Section>
      )}
      <div className="relative pl-6">
        <div className="absolute left-[9px] top-2 bottom-2 w-px bg-line" />
        {encounters.length === 0 && <div className="text-sm text-muted py-2">No consultations yet.</div>}
        {encounters.map((e: any, i: number) => (
          <div key={e.id} className="relative mb-3 anim-fade-up" style={{ animationDelay: `${100 + i * 50}ms` }}>
            <div className={`absolute -left-6 top-5 h-[11px] w-[11px] rounded-full border-2 border-paper ${e.status === 'completed' ? 'bg-clay' : 'bg-line-2'}`} />
            <div className="card card-hover">
              <div className="flex items-center gap-2 text-sm"><span className="font-semibold">{new Date(e.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</span><Chip tone={e.status === 'completed' ? 'sage' : 'amber'}>{e.status}</Chip>
                {e.status === 'completed' && <button className="btn btn-sm btn-ghost ml-auto" onClick={() => window.open(`/print/${e.id}`, '_blank')}><Icon name="print" className="h-3.5 w-3.5" />Rx</button>}</div>
              <div className="mt-2 text-[15px]"><span className="font-medium">{e.data?.complaint?.chief_complaint ?? 'Consultation'}</span>{e.data?.assessment?.diagnosis && <span className="text-ink-2"> → {e.data.assessment.diagnosis}{e.data.assessment.severity ? ` (${e.data.assessment.severity})` : ''}</span>}</div>
              {e.prescription.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{e.prescription.map((i: any) => <Chip key={i.id}><Icon name="pill" className="h-3 w-3" />{i.name}{i.durationDays ? ` · ${i.durationDays}d` : ''}</Chip>)}</div>}
            </div>
          </div>
        ))}
      </div>
      {charges.length > 0 && <Section title="Charges" delay={200}><table className="table"><tbody>{charges.map((c: any) => <tr key={c.id}><td className="pl-4">{c.description}</td><td><Chip tone={c.status === 'paid' ? 'sage' : c.status === 'due' ? 'rose' : ''}>{c.status}</Chip></td><td className="text-right pr-4">{money(c.amountPaise)}</td></tr>)}</tbody></table></Section>}
    </div>
  );
}

function NewPatient({ onClose }: { onClose: (p?: any) => void }) {
  const [f, setF] = useState({ fullName: '', phone: '', ageYears: '', sex: '', locality: '', referralCard: false });
  const [dup, setDup] = useState<any>(null);
  const create = useMutation({
    mutationFn: (force: boolean) => post(`/patients${force ? '?force=1' : ''}`, { ...f, phone: f.phone || null, ageYears: f.ageYears ? Number(f.ageYears) : null, sex: f.sex || null, locality: f.locality || null }),
    onSuccess: (p) => { toast(`Registered ${p.patientNo}`); onClose(p); }, onError: (e: any) => { if (e instanceof ApiError && e.body.code === 'POSSIBLE_DUPLICATE') setDup(e.body.existing); else toast('Could not register', 'err'); },
  });
  return (
    <Modal title="Register patient" subtitle="Only the name is required now; the rest can be completed at arrival" onClose={() => onClose()} width="max-w-lg">
      <div className="space-y-3">
        <div><label className="label">Full name</label><input autoFocus className="input !py-3" value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} /></div>
        <div className="grid grid-cols-3 gap-2">
          <div><label className="label">Phone</label><input className="input" inputMode="numeric" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value.replace(/\D/g, '').slice(0, 10) })} /></div>
          <div><label className="label">Age</label><input className="input" inputMode="numeric" value={f.ageYears} onChange={(e) => setF({ ...f, ageYears: e.target.value })} /></div>
          <div><label className="label">Sex</label><div className="flex gap-1">{['M', 'F', 'O'].map((s) => <button key={s} type="button" className={`toggle-opt ${f.sex === s ? 'on' : ''}`} onClick={() => setF({ ...f, sex: s })}>{s}</button>)}</div></div>
        </div>
        <div><label className="label">Location</label><input className="input" value={f.locality} onChange={(e) => setF({ ...f, locality: e.target.value })} /></div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-clay" checked={f.referralCard} onChange={(e) => setF({ ...f, referralCard: e.target.checked })} /> RMP/PMP referral card</label>
        {dup && <div className="text-sm text-amber bg-amber-soft rounded-xl p-3 anim-fade-up">A patient with this name and phone exists ({dup.patientNo}). <button className="underline font-medium" onClick={() => create.mutate(true)}>Register anyway</button> (family member) or <button className="underline font-medium" onClick={() => onClose({ id: dup.id })}>open the existing record</button>.</div>}
        <div className="flex gap-2 justify-end pt-2"><button className="btn btn-ghost" onClick={() => onClose()}>Cancel</button><button className="btn btn-primary" disabled={!f.fullName || create.isPending} onClick={() => create.mutate(false)}><Icon name="check" />Register</button></div>
      </div>
    </Modal>
  );
}
