import { SeenBy } from './Privacy';
import { useEffect, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useNavigate, useParams, useOutletContext, useSearchParams } from 'react-router';
import { get, post, patch, api, qc, ApiError, errText } from '../api';
import { can } from '../App';
import { Drawer, Avatar, Chip, Empty, Icon, Modal, MoreMenu, PageHeader, Section, Skeleton, Tabs, fmtDate, money, toast, NumInput, usePageSearch, useAddFromNew } from '../ui';
import { BroadcastDialog, SentMessages, PatientMessages } from './Broadcast';
import { EncounterDetail, UploadButton, joinList } from '../encounterDetail';
import { enabledVitals } from '../vitals';
import { LabHistoryDrawer, ReportList } from '../labHistory';
import { PhotoTimeline } from '../photos';
import { TakePayment } from '../takePayment';
import { BillingHistory } from '../billing';
import { CoursesCard } from '../courses';
import { FlagChips, FlagEditor, GuardianPick, FlagPick, NO_FLAGS, flagBody, flagDraftBad } from '../flags';
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
        : <><PageHeader title="Patients" />
          {canMsg && <Tabs<'patients' | 'sent'> className="mb-4" value={view} onChange={setView} options={[{ value: 'patients', label: 'Patients' }, { value: 'sent', label: 'Sent messages' }]} />}</>}
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

type Sec = 'visits' | 'reports' | 'photos' | 'plans' | 'bills' | 'messages' | 'missed';
const SEC_TITLE: Record<Sec, string> = { visits: 'Visit summary', reports: 'Test reports', photos: 'Photos & skin map', plans: 'Plans & sittings', bills: 'Bills & payments', messages: 'Messages', missed: 'Missed' };

/** One patient: who they are on top, the record's parts as tabs below; a part's own actions sit beside the tabs. Visit summary =
 *  vitals by date and the history beside one visit at a time. */
function Timeline({ id }: { id: string }) {
  const nav = useNavigate();
  const t = useQuery({ queryKey: ['timeline', id], queryFn: () => get(`/patients/${id}/timeline`) });
  const docs = useQuery({ queryKey: ['documents', id], queryFn: () => get(`/patients/${id}/documents`) });
  const { perms, me, cfg } = useOutletContext<any>();
  const waitingTests = useQuery({ queryKey: ['worklist', 'investigation'], queryFn: () => get('/worklist?kind=investigation'), enabled: can(perms, 'worklist.read') });
  const pendingTests: any[] = (waitingTests.data ?? []).filter((r: any) => r.patient.id === id);
  const [forTest, setForTest] = useState(''); const [labHist, setLabHist] = useState(false);
  const [edit, setEdit] = useState<any>(null);
  const [flagging, setFlagging] = useState(false); const [sec, setSec] = useState<Sec>('visits');
  const [vi, setVi] = useState(0); // the visit shown, newest first
  const [paying, setPaying] = useState(false);
  const isOwner = (me?.roles ?? []).includes('owner'); const [merging, setMerging] = useState(false);
  const save = useMutation({ mutationFn: (b: any) => patch(`/patients/${id}`, b), onSuccess: () => { setEdit(null); qc.invalidateQueries({ queryKey: ['timeline', id] }); qc.invalidateQueries({ queryKey: ['patients'] }); toast('Saved'); }, onError: (e: any) => toast(errText(e), 'err') });
  const del = useMutation({ mutationFn: (docId: string) => api('DELETE', `/documents/${docId}`), onSuccess: () => { qc.invalidateQueries({ queryKey: ['documents', id] }); toast('Removed', 'info'); } });
  if (!t.data) return <div className="card"><Skeleton rows={4} /></div>;
  const { patient: p, encounters, recommendations, charges, outstandingPaise, visits, guardian, sharingPhone } = t.data;
  const openPlans = recommendations.filter((r: any) => !['done', 'cancelled'].includes(r.status));
  const reports = (docs.data ?? []).filter((d: any) => d.kind !== 'photo');
  const photos = (docs.data ?? []).filter((d: any) => d.kind === 'photo');
  const missed: any[] = t.data.missed ?? []; const sessions: any[] = t.data.sessions ?? [];
  const hist = p.history ?? {};
  const onNow = new Map<string, Date>();
  for (const e of encounters) for (const i of e.prescription) { if (!i.durationDays) continue; const till = new Date(new Date(e.createdAt).getTime() + i.durationDays * 864e5); if (till >= new Date() && !(onNow.get(i.name)! > till)) onNow.set(i.name, till); }
  const planText = (r: any) => (r.kind === 'followup' ? 'Review' : r.kind === 'investigation' ? `Test: ${r.notes}` : `Procedure${r.notes ? `: ${r.notes}` : ''}${r.sittings ? ` · ${r.sittings} sittings` : ''}`);
  // vitals as the desk took them at check-in, one column per visit (the last three that have any)
  const vf = enabledVitals(cfg?.tenant?.settings);
  const vCols = (visits as any[]).filter((v) => vf.some((f) => v.details?.[f.key] !== undefined && v.details[f.key] !== null && v.details[f.key] !== '')).slice(0, 3);
  const showBills = can(perms, 'fees.see') || can(perms, 'payment.record');
  const SECS: [Sec, number | undefined][] = [
    ['visits', encounters.length || undefined], ['reports', reports.length || undefined], ['photos', photos.length || undefined], ['plans', openPlans.length || undefined],
    ...(showBills ? [['bills', charges.length || undefined] as [Sec, number | undefined]] : []),
    ...(can(perms, 'appointment.read') ? [['messages', undefined] as [Sec, number | undefined]] : []),
    ...(missed.length ? [['missed', missed.length] as [Sec, number | undefined]] : []),
  ];
  const e = encounters[Math.min(vi, Math.max(0, encounters.length - 1))];
  const startEdit = () => setEdit({ fullName: p.fullName, phone: p.phone ?? '', ageYears: p.ageYears ?? '', sex: p.sex ?? '', locality: p.locality ?? '', allergies: p.allergies ?? '', notes: p.notes ?? '', referralCard: p.referralCard, contactLabel: p.contactLabel ?? '', guardian, language: p.language ?? '', noWhatsapp: !!p.noWhatsapp });
  const Line = ({ label, children }: { label: string; children: React.ReactNode }) => <div><div className="text-[11px] font-bold uppercase tracking-wider text-muted">{label}</div><div className="text-[14px] font-semibold">{children}</div></div>;
  return (
    <div className="space-y-3">
      {/* one compact card: back, who, how to reach them and the few actions; the record's tabs in their own row below */}
      <div className="card !p-0 anim-fade-up">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-3 sm:px-4">
          <Avatar name={p.fullName} size="h-10 w-10 text-[13px]" />
          <div className="min-w-[240px] flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h2 className="text-[19px] font-extrabold leading-tight [overflow-wrap:anywhere]">{p.fullName}</h2>
              <span className="text-[14px] font-medium text-muted">{[p.ageYears ? `${p.ageYears}` : '', p.sex ?? ''].filter(Boolean).join(' ')}</span>
              <FlagChips flags={{ ...p.flags, careful: undefined }} />{p.referralCard && <Chip tone="sky">Special card</Chip>}{p.language && p.language !== 'en' && <Chip>{p.language === 'te' ? 'Telugu' : 'Hindi'}</Chip>}{p.noWhatsapp && <Chip>No WhatsApp messages</Chip>}
              {p.flags?.careful && <span role="note" className="rounded-md bg-amber-soft px-2 py-0.5 text-[12.5px] text-amber" title={`Set by ${p.flags.careful.by}, ${fmtDate(p.flags.careful.at)}`}><b>Handle carefully:</b> {p.flags.careful.note}</span>}
            </div>
            <div className="mt-0.5 text-[13px] text-muted">{[p.phone ?? 'no phone', p.patientNo, p.dob ? `born ${fmtDate(p.dob)}` : null, p.locality, visits.length ? `${visits.length} visit${visits.length === 1 ? '' : 's'}` : 'no visit yet'].filter(Boolean).join(' · ')}
              {guardian && <> · Guardian: <button className="font-medium text-ink-2 underline" onClick={() => nav(`/patients/${guardian.id}`)}>{guardian.fullName}</button></>}{p.contactLabel ? ` · contact is ${p.contactLabel}` : ''}{sharingPhone > 0 ? ` · phone shared with ${sharingPhone} other${sharingPhone === 1 ? '' : 's'}` : ''}{p.notes ? <span className="text-ink-2"> · {p.notes}</span> : null}</div>
          </div>
          {outstandingPaise > 0 && <button type="button" className="text-sm font-bold text-rose hover:underline" onClick={() => setSec('bills')}>Due {money(outstandingPaise)}</button>}
          {can(perms, 'payment.record') && <button className={`btn btn-sm ${outstandingPaise > 0 ? 'btn-primary' : ''}`} onClick={() => setPaying(true)}><Icon name="plus" className="h-3.5 w-3.5" />Add bill / payment</button>}
          {can(perms, 'patient.write') && <button className="btn btn-sm" onClick={() => setFlagging(true)}><Icon name="spark" className="h-3.5 w-3.5" />{p.flags?.vip || p.flags?.family || p.flags?.careful ? 'Change flag' : 'Flag'}</button>}
          {can(perms, 'patient.write') && <button className="btn btn-sm" onClick={startEdit}><Icon name="edit" className="h-3.5 w-3.5" />Edit</button>}
          {isOwner && !p.mergedInto && <MoreMenu items={[{ label: 'Merge a duplicate into this record', onClick: () => setMerging(true) }]} />}
        </div>
      </div>
        {/* the record's parts as the app's tabs; a part's own actions sit at the right of the row */}
      <div className="flex flex-wrap items-end gap-x-4 gap-y-1">
          <Tabs<Sec> className="min-w-0 flex-1" value={sec} onChange={setSec} options={SECS.map(([k, n]) => ({ value: k, label: SEC_TITLE[k], count: n }))} />
          {sec === 'reports' && <div className="flex flex-wrap items-center gap-2 pb-1.5"><button className="btn btn-sm" onClick={() => setLabHist(true)}><Icon name="chart" className="h-3.5 w-3.5" />Test history</button>
            {can(perms, 'document.write') && <>{pendingTests.length > 0 && <select aria-label="Which test is this for" className="input !w-auto !py-1.5 !text-xs" value={forTest} onChange={(ev) => setForTest(ev.target.value)}><option value="">Not for a waiting test</option>{pendingTests.map((x: any) => <option key={x.id} value={x.id}>For test: {x.notes}</option>)}{pendingTests.length > 1 && <option value="all">For all waiting tests</option>}</select>}<UploadButton patientId={id} recommendationIds={forTest === 'all' ? pendingTests.map((x: any) => x.id) : forTest ? [forTest] : undefined} onDone={() => { ['documents', 'worklist', 'results', 'orders'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); setForTest(''); toast('Uploaded'); }} /></>}</div>}
        </div>

        <div className="space-y-4">
          {p.mergedInto && <div className="card flex flex-wrap items-center gap-3 !py-3 text-sm" role="status"><span className="flex-1">This record was merged into another one and is kept only for the record.</span><button className="btn btn-sm btn-primary" onClick={() => nav(`/patients/${p.mergedInto}`)}>Open the kept record</button></div>}
          {edit && (
            <div className="card grid grid-cols-3 gap-3 anim-fade-up">
              <div className="col-span-3 text-[15px] font-bold">Edit profile</div>
              {[['fullName', 'Full name'], ['phone', 'Phone'], ['locality', 'Area / town'], ['allergies', 'Allergies'], ['notes', 'Notes']].map(([k, l]) => <div key={k} className={k === 'notes' ? 'col-span-3' : ''}><label className="label">{l}</label><input className="input" value={edit[k]} onChange={(ev) => setEdit({ ...edit, [k]: ev.target.value })} /></div>)}
              <div><label className="label" htmlFor="np-age">Age</label><NumInput id="np-age" max={120} className="input" value={edit.ageYears} onChange={(ev) => setEdit({ ...edit, ageYears: ev.target.value })} /></div>
              <div><span className="label">Sex</span><div className="flex gap-1" role="group" aria-label="Sex">{['M', 'F', 'O'].map((s) => <button key={s} type="button" className={`toggle-opt ${edit.sex === s ? 'on' : ''}`} onClick={() => setEdit({ ...edit, sex: s })}>{s}</button>)}</div></div>
              <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" className="accent-clay" checked={edit.referralCard} onChange={(ev) => setEdit({ ...edit, referralCard: ev.target.checked })} /> RMP/PMP referral card</label>
              <div><label className="label">Who answers this phone</label><input className="input" placeholder="mother, father…" maxLength={40} value={edit.contactLabel} onChange={(ev) => setEdit({ ...edit, contactLabel: ev.target.value })} /></div>
              <div className="col-span-2"><label className="label">Guardian (for a minor)</label><GuardianPick selfId={id} value={edit.guardian} onChange={(g) => setEdit({ ...edit, guardian: g })} /></div>
              <div className="col-span-3"><MessagePrefs language={edit.language} noWhatsapp={edit.noWhatsapp} onChange={(v) => setEdit({ ...edit, ...v })} /></div>
              <div className="col-span-3 flex justify-end gap-2"><button className="btn btn-ghost" onClick={() => setEdit(null)}>Cancel</button>
                <button className="btn btn-primary" onClick={() => save.mutate({ ...edit, guardian: undefined, guardianId: edit.guardian?.id ?? null, language: edit.language || null, contactLabel: edit.contactLabel.trim() || null, phone: edit.phone || null, ageYears: edit.ageYears === '' ? null : Number(edit.ageYears), sex: edit.sex || null, locality: edit.locality || null, allergies: edit.allergies || null, notes: edit.notes || null })}>Save</button></div>
            </div>
          )}

          {/* Visit summary: vitals by date and the history on the left, one visit at a time on the right */}
          {sec === 'visits' && <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,400px)_minmax(0,1fr)] xl:items-start">
            <div className="flex min-w-0 flex-col gap-4">
              <section className="card-flat overflow-hidden anim-fade-up">
                <div className="flex items-center gap-2 border-b border-line/70 px-5 py-3"><b className="flex-1 text-[15px]">Vitals</b>{vCols.length > 0 && <span className="text-xs text-muted">last {vCols.length} visit{vCols.length === 1 ? '' : 's'}</span>}</div>
                {vCols.length === 0 ? <div className="px-5 py-4 text-sm text-muted">No vitals taken yet.</div> : <div className="overflow-x-auto"><table className="table">
                  <thead><tr><th>Name</th>{vCols.map((v: any) => <th key={v.id}>{fmtDate(v.arrivedAt)}</th>)}</tr></thead>
                  <tbody>{vf.map((f) => <tr key={f.key}><td className="text-ink-2">{f.label}{f.unit ? ` (${f.unit})` : ''}</td>{vCols.map((v: any, k: number) => <td key={v.id} className={k === 0 ? 'font-bold' : ''}>{v.details?.[f.key] ?? '—'}</td>)}</tr>)}</tbody>
                </table></div>}
              </section>
              <section className="card-flat overflow-hidden anim-fade-up">
                <div className="border-b border-line/70 px-5 py-3"><b className="text-[15px]">Medical history</b></div>
                <div className="flex flex-col gap-3 px-5 py-4">
                  {(cfg?.historyCategories ?? []).map((c: any) => { const xs: any[] = hist[c.key] ?? []; const legacy = c.key === 'drugAllergies' && !xs.length && p.allergies; if (!xs.length && !legacy) return null;
                    return <Line key={c.key} label={c.label}><span className={c.key === 'drugAllergies' ? 'text-rose' : ''}>{legacy ? p.allergies : xs.map((x) => x.note ? `${x.name} (${x.note})` : x.name).join(', ')}</span></Line>; })}
                  {!(cfg?.historyCategories ?? []).some((c: any) => (hist[c.key] ?? []).length) && !p.allergies && <div className="text-sm text-muted">No medical history recorded. Allergies: none recorded.</div>}
                </div>
              </section>
              <section className="card-flat overflow-hidden anim-fade-up">
                <div className="border-b border-line/70 px-5 py-3"><b className="text-[15px]">Now and next</b></div>
                <div className="flex flex-col gap-3 px-5 py-4">
                  <Line label="On now">{onNow.size ? [...onNow].map(([name, till]) => <div key={name}>{name} <span className="text-[13px] font-medium text-muted">· till {fmtDate(till.toISOString())}</span></div>) : <span className="text-sm font-medium text-muted">No running medicines</span>}</Line>
                  <Line label="Next">{openPlans.length ? openPlans.slice(0, 3).map((r: any) => <div key={r.id}>{planText(r)}{r.dueOn && <span className="text-[13px] font-medium text-muted"> · due {fmtDate(r.dueOn)}</span>}</div>) : <span className="text-sm font-medium text-muted">Nothing pending</span>}</Line>
                </div>
              </section>
            </div>
            <section className="card-flat min-w-0 overflow-hidden anim-fade-up">
              {!e ? <div className="p-5 text-sm text-muted">No consultations yet.</div> : <>
                <div className="flex flex-wrap items-center gap-2 border-b border-line/70 px-5 py-3">
                  <div className="min-w-0 flex-1"><b className="text-[15px]">{joinList(e.data?.assessment?.diagnosis) || joinList(e.data?.complaint?.chief_complaint) || 'Consultation'}</b><div className="text-xs text-muted">{fmtDate(e.createdAt)}</div></div>
                  <button className="btn btn-sm !px-2" aria-label="Newer visit" disabled={vi === 0} onClick={() => setVi(vi - 1)}><Icon name="chevL" className="h-4 w-4" /></button>
                  <b className="min-w-[48px] text-center text-sm">{Math.min(vi, encounters.length - 1) + 1} / {encounters.length}</b>
                  <button className="btn btn-sm !px-2" aria-label="Older visit" disabled={vi >= encounters.length - 1} onClick={() => setVi(vi + 1)}><Icon name="chevR" className="h-4 w-4" /></button>
                </div>
                <div className="px-5 py-4"><EncounterDetail key={e.id} id={e.id} /></div>
              </>}
            </section>
          </div>}

          {sec === 'photos' && <>
            <PhotoTimeline patient={{ id, fullName: p.fullName }} canWrite={can(perms, 'document.write')} />
          </>}

          {sec === 'reports' && <section className="card-flat overflow-hidden anim-fade-up">
            <div className="p-3">{reports.length === 0 ? <div className="p-1 text-sm text-muted">Lab reports, scans and letters. Upload a PDF or a photo of the paper. Clinical photos live under Photos.</div> : <ReportList docs={reports} patientId={id} who={p.fullName} onDelete={can(perms, 'document.write') ? (d) => del.mutate(d) : undefined} />}</div>
            {labHist && <LabHistoryDrawer patientId={id} docs={reports} onClose={() => setLabHist(false)} />}
          </section>}

          {sec === 'plans' && <>
            <Section title="Open plans">
              {openPlans.length === 0 ? <div className="p-4 text-sm text-muted">Nothing pending.</div> :
                openPlans.map((r: any) => <div key={r.id} className="row"><Icon name={r.kind === 'followup' ? 'clock' : r.kind === 'investigation' ? 'search' : 'stetho'} className="h-4 w-4 shrink-0 text-clay" /><div className="min-w-0 flex-1 truncate text-sm">{planText(r)}</div>{r.dueOn && <Chip>due {fmtDate(r.dueOn)}</Chip>}<Chip tone={r.status === 'scheduled' ? 'sage' : ''}>{r.status}</Chip></div>)}
            </Section>
            {sessions.length > 0 && <Section title="Sittings">{sessions.map((s: any) => <div key={s.id} className="row"><div className="min-w-0 flex-1 text-sm"><b>{s.procedure ?? 'Procedure'}</b> · sitting {s.sittingNo}<div className="text-xs text-muted">{fmtDate(s.day)} {s.startTime}{s.doctor ? ` · ${s.doctor}` : ''}</div></div><Chip tone={s.state === 'completed' ? 'sage' : s.state === 'missed' ? 'rose' : ''}>{s.state}</Chip></div>)}</Section>}
            <CoursesCard patientId={id} patientName={p.fullName} />
          </>}

          {sec === 'bills' && <BillingHistory patientId={id} patientName={p.fullName} />}
          {sec === 'messages' && <PatientMessages id={id} />}
          {sec === 'missed' && <Section title={<>Missed <span className="font-normal text-muted">· {missed.length}</span></>}>{missed.map((m: any) => <div key={m.refId} className="row"><div className="min-w-0 flex-1 text-sm"><b>{m.what}</b> · {fmtDate(m.day)} {m.time}{m.calls.length ? <div className="text-xs text-muted">{m.calls.map((c: any) => `${fmtDate(c.createdAt)} ${c.byName}: ${c.outcome.replace('_', ' ')}${c.note ? ` (${c.note})` : ''}`).join(' · ')}</div> : <div className="text-xs text-muted">No call logged yet.</div>}</div><Chip tone="rose">missed</Chip></div>)}</Section>}
        </div>

      {can(perms, 'user.write') && <div className="px-1 text-xs text-muted"><SeenBy patientId={id} /></div>}
      {paying && <TakePayment patientId={id} patientName={p.fullName} onClose={() => setPaying(false)} />}
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
    <Drawer title="Register patient" subtitle="Only the name is required now; the rest can be completed at arrival" onClose={() => onClose()} width="max-w-lg">
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
    </Drawer>
  );
}
