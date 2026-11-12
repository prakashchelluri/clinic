import { SeenBy } from './Privacy';
import { useEffect, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useNavigate, useParams, useOutletContext, useSearchParams } from 'react-router';
import { get, post, patch, api, qc, ApiError, errText } from '../api';
import { can } from '../App';
import { Avatar, Chip, Empty, Icon, Modal, MoreMenu, PageHeader, Section, Segmented, Skeleton, Tabs, fmtDate, money, toast, NumInput, usePageSearch, useAddFromNew } from '../ui';
import { BroadcastDialog, SentMessages, PatientMessages } from './Broadcast';
import { EncounterModal, UploadButton, joinList, rxState } from '../encounterDetail';
import { LabHistoryDrawer, ReportList } from '../labHistory';
import { PhotoTimeline } from '../photos';
import { SkinMapPanel } from '../skinmap';
import { TakePayment } from '../takePayment';
import { Invoices } from '../invoices';
import { CoursesCard } from '../courses';
import { FlagChips, CarefulBanner, FlagEditor, GuardianPick, FlagPick, NO_FLAGS, flagBody, flagDraftBad } from '../flags';
import { DataTable, filterValue, pageOf, type FilterDef } from '../table';

const SEEN: FilterDef<any> = { key: 'seen', label: 'Last visit', icon: 'clock', options: [{ value: '', label: 'Any time' }, { value: 'month', label: 'In the last 30 days' }, { value: 'quarter', label: 'In the last 90 days' }, { value: 'year_plus', label: 'Over a year ago' }, { value: 'never', label: 'Never visited' }] };
const FLAG: FilterDef<any> = { key: 'flag', label: 'Flag', icon: 'spark', options: [{ value: '', label: 'Any' }, { value: 'vip', label: 'VIP' }, { value: 'family', label: 'Family and friends' }, { value: 'careful', label: 'Handle carefully' }] };

export function Patients() {
  const { id } = useParams(); const nav = useNavigate(); const { perms } = useOutletContext<any>();
  const [q] = usePageSearch('Find a patient: name, phone or ID', !id);
  const [sp, setSp] = useSearchParams();
  const { page, size } = pageOf(sp);
  const sort = ({ name: sp.get('dir') === 'desc' ? 'name_desc' : 'name', registered: sp.get('dir') === 'desc' ? 'new' : 'old' } as Record<string, string>)[sp.get('sort') ?? ''] ?? 'new';
  const listQs = new URLSearchParams({ q, page: String(page), size: String(size), sort, seen: filterValue(sp, SEEN), flag: filterValue(sp, FLAG) });
  const list = useQuery({ queryKey: ['patients', 'table', listQs.toString()], queryFn: () => get(`/patients?${listQs}`), enabled: !id, placeholderData: (prev: any) => prev });
  const [showNew, setShowNew] = useState(false);
  const canMsg = can(perms, 'message.broadcast');
  const [view, setView] = useState<'patients' | 'sent'>('patients'); const [bulk, setBulk] = useState(false);
  useAddFromNew((w) => { if (w === 'message' && canMsg) setBulk(true); });
  useEffect(() => { if (sp.get('new')) { setShowNew(true); setSp({}, { replace: true }); } }, [sp]);
  return (
    <div>
      {/* One record is a full page; the list is a full-width search. Nobody flips between patients the way they flip between mails. */}
      {id ? null
        : <PageHeader title="Patients" subtitle="One record per person, even when a family shares a phone">
          {canMsg && <Segmented<'patients' | 'sent'> value={view} onChange={setView} options={[{ value: 'patients', label: 'Patients' }, { value: 'sent', label: 'Sent messages' }]} />}
        </PageHeader>}
      {id ? <Timeline key={id} id={id} /> : canMsg && view === 'sent' ? <SentMessages /> : <div className="space-y-3">
        <DataTable
          id="patients" exportName={`patients-${new Date().toISOString().slice(0, 10)}`} rows={list.data?.rows ?? []} rowKey={(p: any) => p.id}
          server={{ total: list.data?.total ?? 0 }} loading={list.isLoading} error={list.error} onRetry={() => list.refetch()} onRow={(p: any) => nav(`/patients/${p.id}`, { viewTransition: true })}
          search={{ placeholder: 'Find a patient: name, phone or ID' }} sort={{ key: 'registered', dir: -1 }} filters={[SEEN, FLAG]}
          empty={{ title: 'No patients found', hint: q ? 'Try part of the name, the phone number or the patient number.' : undefined }}
          columns={[
            { key: 'name', label: 'Patient', fixed: true, sort: (p: any) => p.fullName, csv: (p: any) => p.fullName, cell: (p: any) => (
              <div className="flex min-w-[200px] items-center gap-2.5"><Avatar name={p.fullName} size="h-[30px] w-[30px] text-[11px]" />
                <div className="min-w-0"><div className="flex flex-wrap items-center gap-1.5 font-bold">{p.fullName}<FlagChips flags={p.flags} /></div><div className="text-[12px] text-muted">{[p.patientNo, [p.ageYears, p.sex].filter(Boolean).join(' ')].filter(Boolean).join(' · ')}</div></div></div>) },
            { key: 'phone', label: 'Phone', csv: (p: any) => p.phone, cell: (p: any) => p.phone ? <span className="whitespace-nowrap font-semibold tabular-nums text-ink-2">{p.phone}</span> : <span className="text-muted">—</span> },
            { key: 'locality', label: 'Area', hideOnPhone: true, csv: (p: any) => p.locality, cell: (p: any) => p.locality ?? <span className="text-muted">—</span> },
            { key: 'last', label: 'Last visit', csv: (p: any) => p.lastVisitAt?.slice(0, 10), cell: (p: any) => p.lastVisitAt ? <div className="whitespace-nowrap"><div className="font-semibold">{fmtDate(p.lastVisitAt)}</div>{p.mainProblem && <div className="max-w-[260px] truncate text-[12px] text-muted" title={p.mainProblem}>{p.mainProblem}</div>}</div> : <span className="text-muted">No visit yet</span> },
            { key: 'registered', label: 'Registered', sort: (p: any) => p.createdAt, csv: (p: any) => p.createdAt?.slice(0, 10), cell: (p: any) => <span className="whitespace-nowrap text-muted">{fmtDate(p.createdAt)}</span> },
          ]}
        />
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
  const [forTest, setForTest] = useState(''); const [labHist, setLabHist] = useState(false);
  const [edit, setEdit] = useState<any>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [flagging, setFlagging] = useState(false); const [tab, setTab] = useState<'visits' | 'photos' | 'reports' | 'plans' | 'bills' | 'messages' | 'missed'>('visits');
  const [paying, setPaying] = useState(false);
  const { me } = useOutletContext<any>(); const isOwner = (me?.roles ?? []).includes('owner'); const [merging, setMerging] = useState(false);
  const save = useMutation({ mutationFn: (b: any) => patch(`/patients/${id}`, b), onSuccess: () => { setEdit(null); qc.invalidateQueries({ queryKey: ['timeline', id] }); qc.invalidateQueries({ queryKey: ['patients'] }); toast('Saved'); }, onError: (e: any) => toast(errText(e), 'err') });
  const del = useMutation({ mutationFn: (docId: string) => api('DELETE', `/documents/${docId}`), onSuccess: () => { qc.invalidateQueries({ queryKey: ['documents', id] }); toast('Removed', 'info'); } });
  if (!t.data) return <div className="card"><Skeleton rows={4} /></div>;
  const { patient: p, encounters, recommendations, charges, outstandingPaise, visits, guardian, sharingPhone } = t.data;
  const openPlans = recommendations.filter((r: any) => !['done', 'cancelled'].includes(r.status));
  const reports = (docs.data ?? []).filter((d: any) => d.kind !== 'photo');
  const missed: any[] = t.data.missed ?? []; const sessions: any[] = t.data.sessions ?? [];
  // At a glance: what a doctor needs in ten seconds, worked out from the visits already on file
  const hist = p.history ?? {};
  const allergies = p.allergies || (hist.drugAllergies ?? []).map((a: any) => a.name).join(', ');
  const conditions = (hist.conditions ?? []).map((c: any) => c.name).join(', ');
  const problems: { name: string; at: string }[] = [];
  for (const e of encounters) for (const name of joinList(e.data?.assessment?.diagnosis).split(', ').filter(Boolean)) if (!problems.some((x) => x.name === name)) problems.push({ name, at: e.createdAt });
  const onNow = new Map<string, Date>();
  for (const e of encounters) for (const i of e.prescription) { if (!i.durationDays) continue; const till = new Date(new Date(e.createdAt).getTime() + i.durationDays * 864e5); if (till >= new Date() && !(onNow.get(i.name)! > till)) onNow.set(i.name, till); }
  const planText = (r: any) => (r.kind === 'followup' ? 'Review' : r.kind === 'investigation' ? `Test: ${r.notes}` : `Procedure${r.notes ? `: ${r.notes}` : ''}${r.sittings ? ` · ${r.sittings} sittings` : ''}`);
  const Glance = ({ label, children }: { label: string; children: React.ReactNode }) => <div className="flex flex-col gap-1 border-t border-line/70 px-5 py-3"><span className="text-[11px] font-bold uppercase tracking-wider text-muted">{label}</span>{children}</div>;
  type Tab = typeof tab;
  return (
    <div className="space-y-4">
      {p.mergedInto && <div className="card flex flex-wrap items-center gap-3 !py-3 text-sm" role="status"><span className="flex-1">This record was merged into another one and is kept only for the record.</span><button className="btn btn-sm btn-primary" onClick={() => nav(`/patients/${p.mergedInto}`)}>Open the kept record</button></div>}

      {/* who, how to reach them, and only the action that fits now */}
      <div className="card anim-fade-up">
        <div className="flex flex-wrap items-center gap-4">
          <Avatar name={p.fullName} size="h-12 w-12 text-[15px]" />
          <div className="min-w-[240px] flex-1">
            <h2 className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[22px] font-extrabold leading-tight [overflow-wrap:anywhere]">{p.fullName} <span className="text-[15px] font-medium text-muted">{[p.ageYears ? `${p.ageYears}` : '', p.sex ?? ''].filter(Boolean).join(' ')}</span><FlagChips flags={p.flags} />{p.referralCard && <Chip tone="sky">Special card</Chip>}{p.language && p.language !== 'en' && <Chip>{p.language === 'te' ? 'Telugu' : 'Hindi'}</Chip>}{p.noWhatsapp && <Chip>No WhatsApp messages</Chip>}</h2>
            <div className="mt-1 text-sm text-muted">{[p.patientNo, p.phone ?? 'no phone', p.locality, visits.length ? `${visits.length} visit${visits.length === 1 ? '' : 's'}` : 'no visit yet'].filter(Boolean).join(' · ')}</div>
            {(guardian || p.contactLabel || sharingPhone > 0) && <div className="mt-1 text-sm text-ink-2">{guardian && <>Guardian: <button className="underline font-medium" onClick={() => nav(`/patients/${guardian.id}`)}>{guardian.fullName}</button> · </>}{p.contactLabel ? `contact is ${p.contactLabel}` : ''}{sharingPhone > 0 ? `${p.contactLabel ? ' · ' : ''}this phone is shared with ${sharingPhone} other${sharingPhone === 1 ? '' : 's'}` : ''}</div>}
          </div>
          {outstandingPaise > 0 && <div className="flex items-center gap-2"><span className="text-sm font-bold text-rose">Due {money(outstandingPaise)}</span>{can(perms, 'payment.record') && <button className="btn btn-sm btn-primary" onClick={() => setPaying(true)}>Take payment</button>}</div>}
          {can(perms, 'patient.write') && <button className="btn btn-sm" onClick={() => setFlagging(true)}><Icon name="spark" className="h-3.5 w-3.5" />{p.flags?.vip || p.flags?.family || p.flags?.careful ? 'Change flag' : 'Flag'}</button>}
          {can(perms, 'patient.write') && <button className="btn btn-sm" onClick={() => setEdit({ fullName: p.fullName, phone: p.phone ?? '', ageYears: p.ageYears ?? '', sex: p.sex ?? '', locality: p.locality ?? '', allergies: p.allergies ?? '', notes: p.notes ?? '', referralCard: p.referralCard, contactLabel: p.contactLabel ?? '', guardian, language: p.language ?? '', noWhatsapp: !!p.noWhatsapp })}><Icon name="edit" className="h-3.5 w-3.5" />Edit</button>}
          {isOwner && !p.mergedInto && <MoreMenu items={[{ label: 'Merge a duplicate into this record', onClick: () => setMerging(true) }]} />}
        </div>
        <CarefulBanner flags={p.flags} />
        {edit && (
          <div className="grid grid-cols-3 gap-3 mt-5 pt-4 border-t border-line anim-fade-up">
            {[['fullName', 'Full name'], ['phone', 'Phone'], ['locality', 'Area / town'], ['allergies', 'Allergies'], ['notes', 'Notes']].map(([k, l]) => <div key={k} className={k === 'notes' ? 'col-span-3' : ''}><label className="label">{l}</label><input className="input" value={edit[k]} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} /></div>)}
            <div><label className="label" htmlFor="np-age">Age</label><NumInput id="np-age" max={120} className="input" value={edit.ageYears} onChange={(e) => setEdit({ ...edit, ageYears: e.target.value })} /></div>
            <div><span className="label">Sex</span><div className="flex gap-1" role="group" aria-label="Sex">{['M', 'F', 'O'].map((s) => <button key={s} type="button" className={`toggle-opt ${edit.sex === s ? 'on' : ''}`} onClick={() => setEdit({ ...edit, sex: s })}>{s}</button>)}</div></div>
            <label className="flex items-center gap-2 text-sm self-end pb-2"><input type="checkbox" className="accent-clay" checked={edit.referralCard} onChange={(e) => setEdit({ ...edit, referralCard: e.target.checked })} /> RMP/PMP referral card</label>
            <div><label className="label">Who answers this phone</label><input className="input" placeholder="mother, father…" maxLength={40} value={edit.contactLabel} onChange={(e) => setEdit({ ...edit, contactLabel: e.target.value })} /></div>
            <div className="col-span-2"><label className="label">Guardian (for a minor)</label><GuardianPick selfId={id} value={edit.guardian} onChange={(g) => setEdit({ ...edit, guardian: g })} /></div>
            <div className="col-span-3"><MessagePrefs language={edit.language} noWhatsapp={edit.noWhatsapp} onChange={(v) => setEdit({ ...edit, ...v })} /></div>
            <div className="col-span-3 flex gap-2 justify-end"><button className="btn btn-ghost" onClick={() => setEdit(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={() => save.mutate({ ...edit, guardian: undefined, guardianId: edit.guardian?.id ?? null, language: edit.language || null, contactLabel: edit.contactLabel.trim() || null, phone: edit.phone || null, ageYears: edit.ageYears === '' ? null : Number(edit.ageYears), sex: edit.sex || null, locality: edit.locality || null, allergies: edit.allergies || null, notes: edit.notes || null })}>Save</button></div>
          </div>
        )}
      </div>

      {/* left: the chart in ten seconds; right: one part of the record at a time */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_minmax(0,1fr)] lg:items-start">
        <aside className="card-flat anim-fade-up overflow-hidden" aria-label="At a glance">
          <div className="px-5 pb-2 pt-3.5 text-[15px] font-bold">At a glance</div>
          <Glance label="Allergies">{allergies ? <span className="font-semibold text-rose">{allergies}</span> : <span className="text-sm text-muted">None recorded</span>}</Glance>
          {conditions && <Glance label="Conditions"><span className="font-semibold">{conditions}</span></Glance>}
          <Glance label="Problems">{problems.length ? problems.slice(0, 5).map((x) => <span key={x.name} className="font-semibold">{x.name} <span className="text-sm font-medium text-muted">· {fmtDate(x.at)}</span></span>) : <span className="text-sm text-muted">No diagnosis yet</span>}</Glance>
          <Glance label="On now">{onNow.size ? [...onNow].map(([name, till]) => <span key={name} className="font-semibold">{name} <span className="text-sm font-medium text-muted">· till {fmtDate(till.toISOString())}</span></span>) : <span className="text-sm text-muted">No running medicines</span>}</Glance>
          <Glance label="Next">{openPlans.length ? openPlans.slice(0, 3).map((r: any) => <span key={r.id} className="font-semibold">{planText(r)}{r.dueOn && <span className="text-sm font-medium text-muted"> · due {fmtDate(r.dueOn)}</span>}</span>) : <span className="text-sm text-muted">Nothing pending</span>}</Glance>
          {missed.length > 0 && <Glance label="Missed"><button className="text-left font-semibold text-rose underline-offset-2 hover:underline" onClick={() => setTab('missed')}>{missed.length} missed · last {fmtDate(missed[0].day)}{missed[0].calls.length ? '' : ', no call logged'}</button></Glance>}
          {p.notes && <Glance label="Notes"><span className="text-sm text-ink-2">{p.notes}</span></Glance>}
          {can(perms, 'user.write') && <div className="border-t border-line/70 px-5 py-3"><SeenBy patientId={id} /></div>}
        </aside>

        <div className="min-w-0 space-y-4">
          <Tabs<Tab> value={tab} onChange={setTab} options={[
            { value: 'visits', label: 'Visits', count: encounters.length || undefined },
            { value: 'photos', label: 'Photos & skin map' },
            { value: 'reports', label: 'Reports', count: reports.length || undefined },
            { value: 'plans', label: 'Plans & sittings', count: openPlans.length || undefined },
            ...(can(perms, 'fees.see') || can(perms, 'payment.record') ? [{ value: 'bills' as Tab, label: 'Bills', count: charges.length || undefined }] : []),
            ...(can(perms, 'appointment.read') ? [{ value: 'messages' as Tab, label: 'Messages' }] : []),
            ...(missed.length ? [{ value: 'missed' as Tab, label: 'Missed', count: missed.length }] : []),
          ]} />

          {tab === 'visits' && <section className="card-flat anim-fade-up overflow-hidden">
            {encounters.length === 0 ? <div className="p-5 text-sm text-muted">No consultations yet.</div> : encounters.map((e: any) => (
              <button key={e.id} className="row w-full !items-start text-left hover:bg-surface-2/60" onClick={() => setViewing(e.id)}>
                <div className="w-[88px] shrink-0 pt-0.5 text-sm font-bold">{fmtDate(e.createdAt)}</div>
                <div className="min-w-0 flex-1">
                  <div className="text-[15px] font-semibold">{joinList(e.data?.assessment?.diagnosis) || joinList(e.data?.complaint?.chief_complaint) || 'Consultation'}{e.data?.assessment?.severity ? <span className="font-medium text-muted"> ({e.data.assessment.severity})</span> : ''}{e.status !== 'completed' && <Chip tone="amber" className="ml-2">{e.status}</Chip>}</div>
                  {joinList(e.data?.assessment?.diagnosis) && joinList(e.data?.complaint?.chief_complaint) && <div className="text-[13px] text-muted">{joinList(e.data.complaint.chief_complaint)}</div>}
                  {e.prescription.length > 0 && <div className="mt-1.5 flex flex-wrap gap-1.5">{e.prescription.map((i: any) => { const s = rxState(i, e); return <Chip key={i.id} tone={s?.tone ?? ''}><Icon name="pill" className="h-3 w-3" />{i.name}{i.durationDays ? ` · ${i.durationDays}d` : ''}{s ? ` · ${s.text}` : ''}</Chip>; })}</div>}
                </div>
                <Icon name="chevR" className="mt-1 h-4 w-4 shrink-0 text-muted" />
              </button>
            ))}
          </section>}

          {tab === 'photos' && <>
            <PhotoTimeline patient={{ id, fullName: p.fullName }} canWrite={can(perms, 'document.write')} />
            <Section title="Skin map"><div className="p-4"><SkinMapPanel patientId={id} patientName={p.fullName} readOnly={!can(perms, 'encounter.intake')} /></div></Section>
          </>}

          {tab === 'reports' && <Section title={<>Reports and files <span className="text-muted font-normal">· {reports.length}</span></>}
            aside={<><button className="btn btn-sm" onClick={() => setLabHist(true)}><Icon name="chart" className="h-3.5 w-3.5" />Test history</button>{can(perms, 'document.write') && <>{pendingTests.length > 0 && <select aria-label="Which test is this for" className="input !w-auto !py-1.5 !text-xs" value={forTest} onChange={(e) => setForTest(e.target.value)}><option value="">Not for a waiting test</option>{pendingTests.map((t: any) => <option key={t.id} value={t.id}>For test: {t.notes}</option>)}{pendingTests.length > 1 && <option value="all">For all waiting tests</option>}</select>}<UploadButton patientId={id} recommendationIds={forTest === 'all' ? pendingTests.map((t: any) => t.id) : forTest ? [forTest] : undefined} onDone={() => { ['documents', 'worklist', 'results'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); setForTest(''); toast('Uploaded'); }} /></>}</>}>
            <div className="p-3">{reports.length === 0 ? <div className="text-sm text-muted p-1">Lab reports, scans and letters. Upload a PDF or a photo of the paper. Clinical photos live under Photos.</div> : <ReportList docs={reports} patientId={id} who={p.fullName} onDelete={can(perms, 'document.write') ? (d) => del.mutate(d) : undefined} />}</div>
            {labHist && <LabHistoryDrawer patientId={id} docs={reports} onClose={() => setLabHist(false)} />}
          </Section>}

          {tab === 'plans' && <>
            <Section title="Open plans">
              {openPlans.length === 0 ? <div className="p-4 text-sm text-muted">Nothing pending.</div> :
                openPlans.map((r: any) => <div key={r.id} className="row"><Icon name={r.kind === 'followup' ? 'clock' : r.kind === 'investigation' ? 'search' : 'stetho'} className="h-4 w-4 text-clay shrink-0" /><div className="flex-1 text-sm min-w-0 truncate">{planText(r)}</div>{r.dueOn && <Chip>due {fmtDate(r.dueOn)}</Chip>}<Chip tone={r.status === 'scheduled' ? 'sage' : ''}>{r.status}</Chip></div>)}
            </Section>
            {sessions.length > 0 && <Section title="Sittings">{sessions.map((s: any) => <div key={s.id} className="row"><div className="min-w-0 flex-1 text-sm"><b>{s.procedure ?? 'Procedure'}</b> · sitting {s.sittingNo}<div className="text-xs text-muted">{fmtDate(s.day)} {s.startTime}{s.doctor ? ` · ${s.doctor}` : ''}</div></div><Chip tone={s.state === 'completed' ? 'sage' : s.state === 'missed' ? 'rose' : ''}>{s.state}</Chip></div>)}</Section>}
            <CoursesCard patientId={id} patientName={p.fullName} />
          </>}

          {tab === 'bills' && <Invoices charges={charges} payments={t.data.payments} canRefund={can(perms, 'payment.refund')} canDiscount={can(perms, 'discount.give')} />}
          {tab === 'messages' && <PatientMessages id={id} />}
          {tab === 'missed' && <Section title={<>Missed <span className="text-muted font-normal">· {missed.length}</span></>}>{missed.map((m: any) => <div key={m.refId} className="row"><div className="min-w-0 flex-1 text-sm"><b>{m.what}</b> · {fmtDate(m.day)} {m.time}{m.calls.length ? <div className="text-xs text-muted">{m.calls.map((c: any) => `${fmtDate(c.createdAt)} ${c.byName}: ${c.outcome.replace('_', ' ')}${c.note ? ` (${c.note})` : ''}`).join(' · ')}</div> : <div className="text-xs text-muted">No call logged yet.</div>}</div><Chip tone="rose">missed</Chip></div>)}</Section>}
        </div>
      </div>

      {viewing && <EncounterModal id={viewing} onClose={() => setViewing(null)} />}
      {paying && <TakePayment patientId={id} patientName={p.fullName} charges={charges} payments={t.data.payments} onClose={() => setPaying(false)} />}
      {merging && <MergeDialog keep={p} onClose={() => setMerging(false)} />}
      {flagging && <FlagEditor patientId={id} flags={p.flags ?? {}} onClose={() => setFlagging(false)} />}
    </div>
  );
}

const LANGS: [string, string][] = [['', 'Not asked'], ['en', 'English'], ['te', 'Telugu'], ['hi', 'Hindi']];
/** Messages: preferred language and "no WhatsApp", the same two fields on the new-patient form and the edit form. */
function MessagePrefs({ language, noWhatsapp, onChange }: { language: string; noWhatsapp: boolean; onChange: (v: { language?: string; noWhatsapp?: boolean }) => void }) {
  return (
    <div className="flex flex-wrap items-end gap-4">
      <div><span className="label">Language for messages</span><div className="flex flex-wrap gap-1" role="group" aria-label="Language for messages">{LANGS.map(([v, l]) => <button key={v} type="button" aria-pressed={language === v} className={`toggle-opt ${language === v ? 'on' : ''}`} onClick={() => onChange({ language: v })}>{l}</button>)}</div></div>
      <label className="flex items-center gap-2 pb-2 text-sm"><input type="checkbox" className="accent-clay" checked={noWhatsapp} onChange={(e) => onChange({ noWhatsapp: e.target.checked })} /> No WhatsApp messages</label>
    </div>
  );
}

/** Two records for one person: what each one is, so the owner can pick which to keep. */
function MergeDialog({ keep, onClose }: { keep: any; onClose: (merged?: boolean) => void }) {
  const dups = useQuery({ queryKey: ['duplicates', keep.id], queryFn: () => get(`/patients/${keep.id}/duplicates`) });
  const [q, setQ] = useState(''); const found = useQuery({ queryKey: ['palette', q], queryFn: () => get(`/patients?q=${encodeURIComponent(q)}`), enabled: q.trim().length >= 2 });
  const [pick, setPick] = useState<any>(null);
  const merge = useMutation({ mutationFn: () => post(`/patients/${keep.id}/merge`, { dropId: pick.id }), onSuccess: () => { qc.invalidateQueries(); toast(`Merged ${pick.patientNo} into ${keep.patientNo}`); onClose(true); }, onError: (e: any) => toast(errText(e), 'err') });
  const list: any[] = (q.trim().length >= 2 ? found.data ?? [] : dups.data ?? []).filter((p: any) => p.id !== keep.id);
  const line = (p: any) => [p.patientNo, p.phone, [p.ageYears, p.sex].filter(Boolean).join(' '), p.why].filter(Boolean).join(' · ');
  return (
    <Modal title="Merge a duplicate record" subtitle={`Keep ${keep.fullName} (${keep.patientNo}). Visits, notes, bills, payments, bookings, sittings and photos of the other record move here.`} onClose={() => onClose()} width="max-w-lg">
      <div className="space-y-3">
        <input className="input" placeholder="Find the other record: name, phone or patient number" value={q} onChange={(e) => { setQ(e.target.value); setPick(null); }} />
        {q.trim().length < 2 && <div className="text-xs text-muted">{dups.isLoading ? 'Looking for likely duplicates…' : list.length ? 'Likely duplicates:' : 'No likely duplicates found. Search for the other record.'}</div>}
        <div className="max-h-64 space-y-1 overflow-y-auto">{list.map((p: any) => <button key={p.id} type="button" className={`row w-full rounded-xl text-left ${pick?.id === p.id ? 'bg-clay-soft' : ''}`} onClick={() => setPick(p)}><div className="min-w-0 flex-1"><div className="text-sm font-medium">{p.fullName}</div><div className="text-xs text-muted">{line(p)}</div></div>{pick?.id === p.id && <Icon name="check" className="h-4 w-4 text-clay" />}</button>)}</div>
        {pick && <div className="rounded-xl bg-rose-soft px-3 py-2 text-sm text-ink-2" role="alert"><b>{pick.fullName} ({pick.patientNo})</b> will be archived: it stops showing in lists and search, and everything on it moves to {keep.patientNo}. Missing details (phone, age, address) are filled in from it; both records' allergies are kept. This is recorded in the audit log and cannot be undone here.</div>}
        <div className="modal-foot"><button className="btn btn-ghost" onClick={() => onClose()}>Cancel</button><button className="btn !bg-rose-soft !text-rose" disabled={!pick || merge.isPending} onClick={() => merge.mutate()}>{pick ? `Merge ${pick.patientNo} into ${keep.patientNo}` : 'Pick the other record'}</button></div>
      </div>
    </Modal>
  );
}

function NewPatient({ onClose }: { onClose: (p?: any) => void }) {
  const [flags, setFlags] = useState(NO_FLAGS);
  const [f, setF] = useState({ fullName: '', phone: '', ageYears: '', sex: '', locality: '', referralCard: false, language: '', noWhatsapp: false });
  const [dup, setDup] = useState<any[] | null>(null);
  const nameBad = f.fullName !== '' && f.fullName.trim().length < 2;
  const create = useMutation({
    mutationFn: (force: boolean) => post(`/patients${force ? '?force=1' : ''}`, { ...f, phone: f.phone || null, ageYears: f.ageYears ? Number(f.ageYears) : null, sex: f.sex || null, locality: f.locality || null, language: f.language || null, ...flagBody(flags) }),
    onSuccess: (p) => { toast(`Registered ${p.patientNo}`); onClose(p); }, onError: (e: any) => { if (e instanceof ApiError && e.body.code === 'POSSIBLE_DUPLICATE') setDup(e.body.matches ?? [e.body.existing]); else toast(errText(e), 'err'); },
  });
  const edit = (p: Partial<typeof f>) => { setDup(null); setF({ ...f, ...p }); };
  return (
    <Modal title="Register patient" subtitle="Only the name is required now; the rest can be completed at arrival" onClose={() => onClose()} width="max-w-lg">
      <div className="space-y-3">
        <div><label className="label" htmlFor="np-name">Full name</label><input id="np-name" autoFocus maxLength={100} aria-invalid={nameBad} className={`input !py-3 ${nameBad ? '!border-rose' : ''}`} value={f.fullName} onChange={(e) => edit({ fullName: e.target.value })} />{nameBad && <div className="mt-1 text-xs text-rose">Enter the name (at least 2 letters).</div>}</div>
        <div className="grid grid-cols-3 gap-2">
          <div><label className="label" htmlFor="np-phone">Phone</label><input id="np-phone" className="input" inputMode="numeric" value={f.phone} onChange={(e) => edit({ phone: e.target.value.replace(/\D/g, '').slice(0, 10) })} /></div>
          <div><label className="label">Age</label><NumInput max={120} className="input" placeholder="years" value={f.ageYears} onChange={(e) => edit({ ageYears: e.target.value })} /></div>
          <div><label className="label">Sex</label><div className="flex gap-1">{['M', 'F', 'O'].map((s) => <button key={s} type="button" className={`toggle-opt ${f.sex === s ? 'on' : ''}`} onClick={() => setF({ ...f, sex: s })}>{s}</button>)}</div></div>
        </div>
        <div><label className="label" htmlFor="np-loc">Area / town</label><input id="np-loc" className="input" value={f.locality} onChange={(e) => setF({ ...f, locality: e.target.value })} /></div>
        <MessagePrefs language={f.language} noWhatsapp={f.noWhatsapp} onChange={(v) => setF({ ...f, ...v } as any)} />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-clay" checked={f.referralCard} onChange={(e) => setF({ ...f, referralCard: e.target.checked })} /> RMP/PMP referral card</label>
        <FlagPick value={flags} onChange={setFlags} />
        {dup && <div className="space-y-2 rounded-xl bg-amber-soft p-3 text-sm anim-fade-up" role="alert">
          <div>This may be a patient who is already registered:</div>
          {dup.map((d: any) => <div key={d.id} className="flex flex-wrap items-center gap-2"><span className="min-w-0 flex-1"><b>{d.fullName}</b> <span className="text-muted">{[d.patientNo, d.phone, d.ageYears != null ? `${d.ageYears}y` : null, d.why].filter(Boolean).join(' · ')}</span></span><button className="btn btn-sm" onClick={() => onClose({ id: d.id })}>Open this record</button></div>)}
          <button className="btn btn-sm" onClick={() => create.mutate(true)}>It is someone else, register</button>
        </div>}
        <div className="modal-foot"><button className="btn btn-ghost" onClick={() => onClose()}>Cancel</button><button className="btn btn-primary" disabled={f.fullName.trim().length < 2 || flagDraftBad(flags) || create.isPending} onClick={() => create.mutate(false)}><Icon name="check" />Register</button></div>
      </div>
    </Modal>
  );
}
