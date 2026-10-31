import { SeenBy } from './Privacy';
import { useEffect, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useNavigate, useParams, useOutletContext, useSearchParams } from 'react-router';
import { get, post, patch, api, qc, ApiError, errText } from '../api';
import { can } from '../App';
import { Avatar, Chip, Empty, Icon, Modal, PageHeader, Section, Segmented, Skeleton, fmtDate, money, toast, NumInput } from '../ui';
import { BroadcastDialog, SentMessages, PatientMessages } from './Broadcast';
import { EncounterModal, DocList, UploadButton, joinList, rxState } from '../encounterDetail';
import { PhotoTimeline } from '../photos';
import { TakePayment } from '../takePayment';
import { Invoices } from '../invoices';
import { FlagChips, CarefulBanner, FlagEditor, GuardianPick } from '../flags';

export function Patients() {
  const { id } = useParams(); const nav = useNavigate(); const { perms } = useOutletContext<any>();
  const [q, setQ] = useState('');
  const list = useQuery({ queryKey: ['patients', q], queryFn: () => get(`/patients?q=${encodeURIComponent(q)}`) });
  const [showNew, setShowNew] = useState(false);
  const canMsg = can(perms, 'message.broadcast');
  const [view, setView] = useState<'patients' | 'sent'>('patients'); const [bulk, setBulk] = useState(false);
  const [sp, setSp] = useSearchParams();
  useEffect(() => { if (sp.get('new')) { setShowNew(true); setSp({}, { replace: true }); } }, [sp]);
  return (
    <div>
      <PageHeader title="Patients" subtitle="One record per person, even when a family shares a phone">
        {canMsg && <Segmented<'patients' | 'sent'> value={view} onChange={setView} options={[{ value: 'patients', label: 'Patients' }, { value: 'sent', label: 'Sent messages' }]} />}
        {canMsg && <button className="btn" onClick={() => setBulk(true)}><Icon name="message" className="h-4 w-4" />Message patients</button>}
      </PageHeader>
      {canMsg && view === 'sent' ? <SentMessages /> : <div className="grid grid-cols-1 lg:grid-cols-[360px_minmax(0,1fr)] gap-5">
        <div className="space-y-3">
          <div className="relative anim-fade-up"><Icon name="search" className="h-4 w-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" /><input autoFocus className="input !pl-10 !py-3" placeholder="Phone, name or patient ID" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <Section delay={60}>
            {list.isLoading ? <Skeleton rows={5} /> : (list.data ?? []).length === 0 ? <Empty icon="user" title="No patients found" /> :
              (list.data ?? []).map((p: any, i: number) => (
                <button key={p.id} className={`row w-full text-left anim-fade-up ${p.id === id ? '!bg-clay-soft/60' : ''}`} style={{ animationDelay: `${Math.min(i, 10) * 25}ms` }} onClick={() => nav(`/patients/${p.id}`, { viewTransition: true })}>
                  <Avatar name={p.fullName} />
                  <div className="min-w-0 flex-1"><div className="text-sm font-medium truncate">{p.fullName} <span className="text-xs text-muted font-normal">{p.ageYears ? `${p.ageYears}y` : ''} {p.sex ?? ''}</span> <FlagChips flags={p.flags} /></div><div className="text-xs text-muted truncate">{p.patientNo} · {p.phone ?? 'no phone'}{p.locality ? ` · ${p.locality}` : ''}</div>
                    <div className="text-xs text-muted truncate">{p.lastVisitAt ? `last visit ${fmtDate(p.lastVisitAt)}` : 'no visit yet'}{p.mainProblem ? ` · ${p.mainProblem}` : ''}</div></div>
                  <Icon name="chevR" className={`h-4 w-4 ${p.id === id ? 'text-clay' : 'text-muted/50'}`} />
                </button>))}
          </Section>
        </div>
        <div>{id ? <Timeline key={id} id={id} /> : <div className="card border-dashed anim-fade-in"><Empty icon="users" title="Select a patient" hint="Their visits, prescriptions, plans, reports and payments appear here as one timeline." /></div>}</div>
      </div>}
      {bulk && <BroadcastDialog onClose={() => setBulk(false)} onSent={() => setView('sent')} />}
      {showNew && <NewPatient onClose={(p) => { setShowNew(false); if (p) { qc.invalidateQueries({ queryKey: ['patients'] }); nav(`/patients/${p.id}`); } }} />}
    </div>
  );
}

function Timeline({ id }: { id: string }) {
  const nav = useNavigate();
  const t = useQuery({ queryKey: ['timeline', id], queryFn: () => get(`/patients/${id}/timeline`) });
  const docs = useQuery({ queryKey: ['documents', id], queryFn: () => get(`/patients/${id}/documents`) });
  const { perms } = useOutletContext<any>();
  const waitingTests = useQuery({ queryKey: ['worklist', 'investigation'], queryFn: () => get('/worklist?kind=investigation'), enabled: can(perms, 'worklist.read') });
  const pendingTests: any[] = (waitingTests.data ?? []).filter((r: any) => r.patient.id === id);
  const [forTest, setForTest] = useState('');
  const [edit, setEdit] = useState<any>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [flagging, setFlagging] = useState(false); const [paying, setPaying] = useState(false);
  const save = useMutation({ mutationFn: (b: any) => patch(`/patients/${id}`, b), onSuccess: () => { setEdit(null); qc.invalidateQueries({ queryKey: ['timeline', id] }); qc.invalidateQueries({ queryKey: ['patients'] }); toast('Saved'); } });
  const del = useMutation({ mutationFn: (docId: string) => api('DELETE', `/documents/${docId}`), onSuccess: () => { qc.invalidateQueries({ queryKey: ['documents', id] }); toast('Removed', 'info'); } });
  if (!t.data) return <div className="card"><Skeleton rows={4} /></div>;
  const { patient: p, encounters, recommendations, charges, outstandingPaise, visits, guardian, sharingPhone } = t.data;
  const openPlans = recommendations.filter((r: any) => !['done', 'cancelled'].includes(r.status));
  const reports = (docs.data ?? []).filter((d: any) => d.kind !== 'photo');
  return (
    <div className="space-y-4">
      <div className="card anim-fade-up">
        <div className="flex items-start gap-4">
          <Avatar name={p.fullName} size="h-14 w-14 text-lg" />
          <div className="flex-1 min-w-0">
            <h2 className="text-2xl font-medium leading-tight [overflow-wrap:anywhere]">{p.fullName} <span className="text-muted text-lg font-normal">{p.ageYears ? `${p.ageYears}y` : ''} {p.sex ?? ''}</span> <span className="inline-flex flex-wrap gap-1.5 align-middle"><FlagChips flags={p.flags} /></span></h2>
            <CarefulBanner flags={p.flags} />
            {(guardian || p.contactLabel || sharingPhone > 0) && <div className="mt-1.5 text-sm text-ink-2">{guardian && <>Guardian: <button className="underline font-medium" onClick={() => nav(`/patients/${guardian.id}`)}>{guardian.fullName}</button> · </>}{p.contactLabel ? `contact is ${p.contactLabel}` : ''}{sharingPhone > 0 ? `${p.contactLabel ? ' · ' : ''}this phone is shared with ${sharingPhone} other${sharingPhone === 1 ? '' : 's'}` : ''}</div>}
            <div className="text-sm text-muted mt-1 flex items-center gap-2 flex-wrap"><span>{p.patientNo}</span><span>·</span><span>{p.phone ?? 'no phone'}</span>{p.locality && <><span>·</span><span>{p.locality}</span></>}{p.referralCard && <Chip tone="sky">Special card</Chip>}</div>
            {p.allergies && <div className="mt-2 inline-flex items-center gap-1.5 text-sm text-rose bg-rose-soft rounded-full px-3 py-1"><Icon name="spark" className="h-3.5 w-3.5" />Allergies: {p.allergies}</div>}
            {p.notes && <div className="text-sm text-ink-2 mt-2">{p.notes}</div>}
            {can(perms, 'user.write') && <div className="mt-2"><SeenBy patientId={id} /></div>}
          </div>
          <div className="text-right"><div className="text-[11px] uppercase tracking-wider text-muted">Visits</div><div className="serif text-2xl">{visits.length}</div>{outstandingPaise > 0 && <div className="text-sm text-rose font-medium mt-1">Due {money(outstandingPaise)}</div>}{outstandingPaise > 0 && can(perms, 'payment.record') && <button className="btn btn-sm btn-primary mt-1.5" onClick={() => setPaying(true)}>Take payment</button>}</div>
          {can(perms, 'encounter.complete') && <button className="btn btn-sm" onClick={() => setFlagging(true)}>Flags</button>}
          {can(perms, 'patient.write') && <button className="btn btn-ghost btn-icon" title="Edit" onClick={() => setEdit({ fullName: p.fullName, phone: p.phone ?? '', ageYears: p.ageYears ?? '', sex: p.sex ?? '', locality: p.locality ?? '', allergies: p.allergies ?? '', notes: p.notes ?? '', referralCard: p.referralCard, contactLabel: p.contactLabel ?? '', guardian })}><Icon name="edit" /></button>}
        </div>
        {edit && (
          <div className="grid grid-cols-3 gap-3 mt-5 pt-4 border-t border-line anim-fade-up">
            {[['fullName', 'Full name'], ['phone', 'Phone'], ['locality', 'Location'], ['allergies', 'Allergies'], ['notes', 'Notes']].map(([k, l]) => <div key={k} className={k === 'notes' ? 'col-span-3' : ''}><label className="label">{l}</label><input className="input" value={edit[k]} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} /></div>)}
            <div><label className="label">Age</label><NumInput max={120} className="input" value={edit.ageYears} onChange={(e) => setEdit({ ...edit, ageYears: e.target.value })} /></div>
            <div><label className="label">Sex</label><div className="flex gap-1">{['M', 'F', 'O'].map((s) => <button key={s} type="button" className={`toggle-opt ${edit.sex === s ? 'on' : ''}`} onClick={() => setEdit({ ...edit, sex: s })}>{s}</button>)}</div></div>
            <label className="flex items-center gap-2 text-sm self-end pb-2"><input type="checkbox" className="accent-clay" checked={edit.referralCard} onChange={(e) => setEdit({ ...edit, referralCard: e.target.checked })} /> RMP/PMP referral card</label>
            <div><label className="label">Who answers this phone</label><input className="input" placeholder="mother, father…" maxLength={40} value={edit.contactLabel} onChange={(e) => setEdit({ ...edit, contactLabel: e.target.value })} /></div>
            <div className="col-span-2"><label className="label">Guardian (for a minor)</label><GuardianPick selfId={id} value={edit.guardian} onChange={(g) => setEdit({ ...edit, guardian: g })} /></div>
            <div className="col-span-3 flex gap-2 justify-end"><button className="btn btn-ghost" onClick={() => setEdit(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={() => save.mutate({ ...edit, guardian: undefined, guardianId: edit.guardian?.id ?? null, contactLabel: edit.contactLabel.trim() || null, phone: edit.phone || null, ageYears: edit.ageYears === '' ? null : Number(edit.ageYears), sex: edit.sex || null, locality: edit.locality || null, allergies: edit.allergies || null, notes: edit.notes || null })}>Save</button></div>
          </div>
        )}
      </div>

      <PhotoTimeline patient={{ id, fullName: p.fullName }} canWrite={can(perms, 'document.write')} />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Section title="Open plans" delay={60}>
          {openPlans.length === 0 ? <div className="p-4 text-sm text-muted">Nothing pending.</div> :
            openPlans.map((r: any) => <div key={r.id} className="row"><Icon name={r.kind === 'followup' ? 'clock' : r.kind === 'investigation' ? 'search' : 'stetho'} className="h-4 w-4 text-clay shrink-0" /><div className="flex-1 text-sm min-w-0 truncate">{r.kind === 'followup' ? 'Follow-up review' : r.kind === 'investigation' ? `Test: ${r.notes}` : 'Procedure'}{r.sittings ? ` · ${r.sittings} sittings` : ''}{r.notes && r.kind === 'procedure' ? ` · ${r.notes}` : ''}</div>{r.dueOn && <Chip>due {fmtDate(r.dueOn)}</Chip>}<Chip tone={r.status === 'scheduled' ? 'sage' : ''}>{r.status}</Chip></div>)}
        </Section>
        <Section title={<>Reports and files <span className="text-muted font-normal">· {reports.length}</span></>} delay={90}
          aside={can(perms, 'document.write') && <>{pendingTests.length > 0 && <select aria-label="Which test is this for" className="input !w-auto !py-1.5 !text-xs" value={forTest} onChange={(e) => setForTest(e.target.value)}><option value="">Not for a waiting test</option>{pendingTests.map((t: any) => <option key={t.id} value={t.id}>For test: {t.notes}</option>)}{pendingTests.length > 1 && <option value="all">For all waiting tests</option>}</select>}<UploadButton patientId={id} recommendationIds={forTest === 'all' ? pendingTests.map((t: any) => t.id) : forTest ? [forTest] : undefined} onDone={() => { ['documents', 'worklist', 'results'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); setForTest(''); toast('Uploaded'); }} /></>}>
          <div className="p-3">{reports.length === 0 ? <div className="text-sm text-muted p-1">Lab reports, scans and letters. Upload a PDF or a photo of the paper. Clinical photos live under Photos above.</div> : <DocList docs={reports} onDelete={can(perms, 'document.write') ? (d) => del.mutate(d) : undefined} />}</div>
        </Section>
        {can(perms, 'appointment.read') && <PatientMessages id={id} />}
      </div>

      <div className="relative pl-6">
        <div className="absolute left-[9px] top-2 bottom-2 w-px bg-line" />
        {encounters.length === 0 && <div className="text-sm text-muted py-2">No consultations yet.</div>}
        {encounters.map((e: any, i: number) => (
          <div key={e.id} className="relative mb-3 anim-fade-up" style={{ animationDelay: `${100 + i * 50}ms` }}>
            <div className={`absolute -left-6 top-5 h-[11px] w-[11px] rounded-full border-2 border-paper ${e.status === 'completed' ? 'bg-clay' : 'bg-line-2'}`} />
            <button className="card card-hover w-full text-left" onClick={() => setViewing(e.id)}>
              <div className="flex items-center gap-2 text-sm"><span className="font-semibold">{new Date(e.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</span><Chip tone={e.status === 'completed' ? 'sage' : 'amber'}>{e.status}</Chip>
                <span className="ml-auto text-xs text-muted flex items-center gap-1">Open details <Icon name="chevR" className="h-3 w-3" /></span></div>
              <div className="mt-2 text-[15px]"><span className="font-medium">{joinList(e.data?.complaint?.chief_complaint) || 'Consultation'}</span>{joinList(e.data?.assessment?.diagnosis) && <span className="text-ink-2"> → {joinList(e.data.assessment.diagnosis)}{e.data.assessment?.severity ? ` (${e.data.assessment.severity})` : ''}</span>}</div>
              {e.prescription.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{e.prescription.map((i: any) => { const s = rxState(i, e); return <Chip key={i.id} tone={s?.tone ?? ''}><Icon name="pill" className="h-3 w-3" />{i.name}{i.durationDays ? ` · ${i.durationDays}d` : ''}{s ? ` · ${s.text}` : ''}</Chip>; })}</div>}
            </button>
          </div>
        ))}
      </div>
      <Invoices charges={charges} payments={t.data.payments} canRefund={can(perms, 'payment.refund')} canDiscount={can(perms, 'discount.give')} />
      {viewing && <EncounterModal id={viewing} onClose={() => setViewing(null)} />}
      {paying && <TakePayment patientId={id} patientName={p.fullName} charges={charges} payments={t.data.payments} onClose={() => setPaying(false)} />}
      {flagging && <FlagEditor patientId={id} flags={p.flags ?? {}} onClose={() => setFlagging(false)} />}
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
        <div><label className="label">Full name</label><input autoFocus maxLength={100} className="input !py-3" value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} /></div>
        <div className="grid grid-cols-3 gap-2">
          <div><label className="label">Phone</label><input className="input" inputMode="numeric" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value.replace(/\D/g, '').slice(0, 10) })} /></div>
          <div><label className="label">Age</label><NumInput max={120} className="input" placeholder="years" value={f.ageYears} onChange={(e) => setF({ ...f, ageYears: e.target.value })} /></div>
          <div><label className="label">Sex</label><div className="flex gap-1">{['M', 'F', 'O'].map((s) => <button key={s} type="button" className={`toggle-opt ${f.sex === s ? 'on' : ''}`} onClick={() => setF({ ...f, sex: s })}>{s}</button>)}</div></div>
        </div>
        <div><label className="label">Location</label><input className="input" value={f.locality} onChange={(e) => setF({ ...f, locality: e.target.value })} /></div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-clay" checked={f.referralCard} onChange={(e) => setF({ ...f, referralCard: e.target.checked })} /> RMP/PMP referral card</label>
        {dup && <div className="text-sm text-amber bg-amber-soft rounded-xl p-3 anim-fade-up">A patient with this name and phone exists ({dup.patientNo}). <button className="underline font-medium" onClick={() => create.mutate(true)}>Register anyway</button> (family member) or <button className="underline font-medium" onClick={() => onClose({ id: dup.id })}>open the existing record</button>.</div>}
        <div className="modal-foot"><button className="btn btn-ghost" onClick={() => onClose()}>Cancel</button><button className="btn btn-primary" disabled={!f.fullName || create.isPending} onClick={() => create.mutate(false)}><Icon name="check" />Register</button></div>
      </div>
    </Modal>
  );
}
