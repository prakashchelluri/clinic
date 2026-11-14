import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { get, post, today } from './api';
import { Drawer, Chip, Icon, Segmented, Skeleton, fmtDate, toast } from './ui';
import { openPrint } from './printPreview';
import { PrintRx } from './pages/PrintRx';
import { openViewer } from './viewer';
import { useOutletContext } from 'react-router';
import { vitalFields, vitalsText } from './vitals';
import { filledRows } from './padModules';

/** Form values may be a string (old encounters) or an array (tags fields). */
const label = (x: any) => (x && typeof x === 'object' ? `${x.name}${x.severity ? ` (${x.severity})` : ''}` : String(x));
export const asList = (v: any): string[] => (Array.isArray(v) ? v.map(label) : v === undefined || v === null || v === '' ? [] : [label(v)]);
export const joinList = (v: any) => asList(v).join(', ');

/** What happened to one prescribed medicine at the pharmacy. Quiet: nothing is shown until the day has passed, and only for medicines the pharmacy stocks. */
export function rxState(i: any, encounter: { status?: string; createdAt: string }): { text: string; tone: 'sage' | 'amber' | '' } | null {
  if (i.issuedQty > 0 || i.dispensed) return { text: i.notIssuedReason ? 'bought some' : 'bought', tone: i.notIssuedReason ? 'amber' : 'sage' };
  if (!i.medicineId || encounter.status !== 'completed') return null;
  const day = new Date(encounter.createdAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  return day < today() ? { text: i.notIssuedReason ? `not bought · ${i.notIssuedReason.toLowerCase()}` : 'not bought', tone: '' } : null;
}

const CORE = new Set(['complaint.chief_complaint', 'plan.advice', 'plan.notes', 'plan.testNotes', 'plan.followupNote', 'exam.items']);
const has = (v: any) => (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && typeof v !== 'object' && String(v).trim() !== '');
const symText = (x: any) => (typeof x === 'string' ? x : [x?.name, x?.since ? `since ${x.since}` : null, x?.severity?.toLowerCase(), x?.status?.toLowerCase(), x?.note].filter(Boolean).join(' · '));

/** One row of the full notes: what it is on the left, what was written on the right. Only drawn when something is in it. */
function Row({ label, children, tone }: { label: string; children: any; tone?: 'private' }) {
  return (
    <div className={`grid grid-cols-1 gap-x-4 gap-y-0.5 py-2.5 sm:grid-cols-[150px_minmax(0,1fr)] ${tone === 'private' ? 'rounded-lg bg-amber-soft px-3' : 'border-b border-line/60 last:border-0'}`}>
      <div className="flex items-center gap-1.5 text-[12px] font-semibold text-muted">{tone === 'private' && <Icon name="lock" className="h-3 w-3" />}{label}</div>
      <div className="min-w-0 text-[14px] leading-relaxed text-ink">{children}</div>
    </div>
  );
}

/** Everything written for one visit, read-only, in the pad's order: what was printed and what never prints (screening, the private note,
 *  warnings overridden, drawings, results in range, what the pharmacy gave). Loaded only when asked for, one visit at a time. */
export function EncounterDetail({ id }: { id: string }) {
  const { cfg } = (useOutletContext<any>() ?? {}) as any;
  const q = useQuery({ queryKey: ['encounter', id], queryFn: () => get(`/encounters/${id}`) });
  const pr = useQuery({ queryKey: ['print', id], queryFn: () => get(`/encounters/${id}/print`) }); // results and procedure names; already loaded when the prescription was shown
  const docs = useQuery({ queryKey: ['documents', q.data?.patientId], queryFn: () => get(`/patients/${q.data.patientId}/documents`), enabled: !!q.data, retry: false });
  if (q.isError) return <div className="py-6 text-sm text-muted">This visit could not be loaded. <button className="btn btn-sm ml-2" onClick={() => q.refetch()}>Try again</button></div>;
  if (!q.data) return <Skeleton rows={6} />;
  const e = q.data; const d = e.data ?? {}; const det = e.visit?.details ?? {};
  const arrival = ((det.complaints ?? []) as { text: string; duration?: string }[]).map((c) => (c.duration ? `${c.text} · ${c.duration}` : c.text)).join(', ');
  const vit = vitalsText(det, vitalFields(cfg?.tenant?.settings));
  const answers = Object.entries((d.screen?.answers ?? {}) as Record<string, { a: string; detail?: string }>);
  const yes = answers.filter(([, a]) => a?.a === 'yes'); const no = answers.filter(([, a]) => a?.a === 'no');
  const syms: any[] = Array.isArray(d.complaint?.chief_complaint) ? d.complaint.chief_complaint : has(d.complaint?.chief_complaint) ? [d.complaint.chief_complaint] : [];
  const exams: any[] = Array.isArray(d.exam?.items) ? d.exam.items.filter((x: any) => x?.name) : [];
  // the clinic's own fields (Settings → form) and an older visit's exam lists, under the label they were written with
  const extra = (e.form?.sections ?? []).flatMap((s: any) => (s.fields ?? []).filter((f: any) => !CORE.has(`${s.key}.${f.key}`) && has(d[s.key]?.[f.key]))
    .map((f: any) => ({ key: `${s.key}.${f.key}`, label: f.type === 'diagnoses' ? 'Diagnosis' : ['complaint', 'exam', 'assessment', 'plan'].includes(s.key) ? f.label : `${s.title} › ${f.label}`, v: d[s.key][f.key], unit: f.unit, dx: f.type === 'diagnoses' })));
  const dxRows = extra.filter((x: any) => x.dx); const others = extra.filter((x: any) => !x.dx);
  const modules = Object.values(d.modules ?? {}).map((m: any) => ({ ...m, rows: filledRows(m) })).filter((m: any) => m.rows.length && Array.isArray(m.columns));
  const canvases: any[] = (Array.isArray(d.canvases) ? d.canvases : []).filter((c: any) => c.docId);
  const recs: any[] = pr.data?.recommendations ?? e.recommendations ?? [];
  const tests = recs.filter((r) => r.kind === 'investigation'); const followup = recs.filter((r) => r.kind === 'followup'); const procs = recs.filter((r) => r.kind === 'procedure');
  const labs: any[] = pr.data?.labs ?? [];
  const advice = String(d.plan?.advice ?? '').split('\n').map((x) => x.trim()).filter(Boolean);
  const notes = String(d.plan?.notes ?? '').trim();
  const priv = typeof d.notes?.private === 'string' ? d.notes.private.trim() : '';
  const overrides: any[] = Array.isArray(d.overrides) ? d.overrides : [];
  const encDocs = (docs.data ?? []).filter((x: any) => x.encounterId === id && !canvases.some((c) => c.docId === x.id)); // a drawing shows once, under Drawings
  const recStatus = (r: any) => <Chip tone={r.status === 'done' ? 'sage' : r.status === 'cancelled' ? '' : 'amber'}>{({ done: 'Done', cancelled: 'Cancelled', open: 'Pending' } as Record<string, string>)[r.status] ?? r.status}</Chip>;
  const empty = !d.review?.response && !arrival && !vit && !answers.length && !syms.length && !exams.length && !extra.length && !modules.length && !e.prescription.length && !recs.length && !advice.length && !notes && !d.referral?.to && !canvases.length && !encDocs.length && !priv && !overrides.length;
  return (
    <div>
      <div className="mb-1 flex flex-wrap items-center gap-2 text-[13px] text-muted"><span>{fmtDate(e.completedAt ?? e.createdAt)}</span>{e.doctor && <><span>·</span><span>{e.doctor.name}</span></>}{e.visit?.opNumber && <><span>·</span><span>OP {e.visit.opNumber}</span></>}
        <Chip tone={e.status === 'completed' ? 'sage' : 'amber'}>{({ completed: 'Completed', draft: 'In progress', awaiting_reports: 'Results pending' } as Record<string, string>)[e.status] ?? e.status}</Chip></div>
      {empty && <div className="py-4 text-sm text-muted">Nothing was written for this visit.</div>}
      {d.review?.response && <Row label="Since last visit">{d.review.response}{d.review.note ? ` · ${d.review.note}` : ''}</Row>}
      {arrival && <Row label="At arrival">{arrival}</Row>}
      {vit && <Row label="Vitals">{vit}</Row>}
      {answers.length > 0 && <Row label="Screening">{yes.map(([q, a]) => <div key={q}><b className="font-semibold">{q.replace(/\?$/, '')}</b>{a.detail ? <span className="text-ink-2"> · {a.detail}</span> : null}</div>)}{no.length > 0 && <div className="text-[13px] text-muted">Answered No: {no.map(([q]) => q.replace(/\?$/, '')).join(' · ')}</div>}</Row>}
      {syms.length > 0 && <Row label="Symptoms">{syms.map(symText).join('; ')}</Row>}
      {exams.length > 0 && <Row label="Examination">{exams.map((x) => [x.name, x.note].filter(Boolean).join(' · ')).join('; ')}</Row>}
      {dxRows.map((x: any) => <Row key={x.key} label={x.label}>{(Array.isArray(x.v) ? x.v : [x.v]).map(symText).join('; ')}</Row>)}
      {others.map((x: any) => <Row key={x.key} label={x.label}>{Array.isArray(x.v) ? asList(x.v).join(', ') : `${x.v}${x.unit ? ` ${x.unit}` : ''}`}</Row>)}
      {modules.map((m: any, k: number) => <Row key={`m${k}`} label={m.name}><table className="w-full text-[13px]"><thead><tr>{m.columns.map((c: string) => <th key={c} className="py-0.5 pr-3 text-left font-semibold text-muted">{c}</th>)}</tr></thead><tbody>{m.rows.map((r: string[], i: number) => <tr key={i}>{m.columns.map((c: string, j: number) => <td key={c} className="py-0.5 pr-3">{r[j] ?? ''}</td>)}</tr>)}</tbody></table></Row>)}
      {e.prescription.length > 0 && <Row label="Medicines">{e.prescription.map((i: any) => { const s = rxState(i, e); return (
        <div key={i.id} className="flex flex-wrap items-baseline gap-x-2"><b className="font-semibold">{i.name}</b>{i.dose && <span>{i.dose}</span>}<span className="text-ink-2">{[i.frequency, i.timing, i.durationDays ? `${i.durationDays} days` : i.durationNote, i.route && i.route !== 'oral' ? i.route : null].filter(Boolean).join(' · ')}{i.instructions ? ` — ${i.instructions}` : ''}</span>{s && <Chip tone={s.tone}>{s.text}</Chip>}</div>); })}</Row>}
      {tests.length > 0 && <Row label="Tests">{tests.map((r) => <div key={r.id} className="flex flex-wrap items-center gap-2"><span>{r.notes}{d.plan?.testNotes?.[r.notes] ? <span className="text-ink-2"> · {d.plan.testNotes[r.notes]}</span> : null}</span>{recStatus(r)}</div>)}</Row>}
      {labs.length > 0 && <Row label="Results">{labs.map((r: any, k: number) => <span key={r.id ?? k} className={`mr-3 inline-block ${['low', 'high', 'abnormal'].includes(r.flag) ? 'font-semibold text-rose' : ''}`}>{r.test} {r.value}{r.unit ? ` ${r.unit}` : ''}{r.flag && r.flag !== 'normal' ? ` (${r.flag})` : ''}</span>)}</Row>}
      {advice.length > 0 && <Row label="Advice">{advice.join(' · ')}</Row>}
      {followup.map((r) => <Row key={r.id} label="Follow-up"><span className="mr-2">{r.dueOn ? `Review on ${fmtDate(r.dueOn)}` : 'Review as advised'}{d.plan?.followupNote ? ` — ${d.plan.followupNote}` : ''}</span>{recStatus(r)}</Row>)}
      {procs.length > 0 && <Row label="Procedures">{procs.map((r) => <div key={r.id} className="flex flex-wrap items-center gap-2"><span>{r.procedureName ?? r.notes ?? 'Procedure'}{r.sittings ? ` · ${r.sittings} sittings` : ''}{r.gapDays ? ` · every ${r.gapDays} days` : ''}</span>{recStatus(r)}</div>)}</Row>}
      {d.referral?.to && <Row label="Referred to">{[d.referral.to, d.referral.speciality].filter(Boolean).join(' · ')}{d.referral.reason ? ` — ${d.referral.reason}` : ''}</Row>}
      {notes && <Row label="Notes"><span className="whitespace-pre-line">{notes}</span></Row>}
      {canvases.length > 0 && <Row label="Drawings"><div className="flex flex-wrap gap-2">{canvases.map((c: any, k: number) => <button key={c.id ?? k} type="button" title={c.name} aria-label={`Open ${c.name}`} onClick={() => openViewer({ docs: canvases.map((x: any) => ({ id: x.docId, title: x.name, mime: 'image/png', kind: 'canvas', createdAt: e.createdAt })), index: k })}><img src={`/api/documents/${c.docId}/file`} alt={c.name} className="h-24 rounded-md border border-line bg-white object-contain" loading="lazy" /></button>)}</div></Row>}
      {encDocs.length > 0 && <Row label="Photos & files"><DocList docs={encDocs} /></Row>}
      {(e.amendments ?? []).length > 0 && <Row label="Amended">{e.amendments.map((a: any, k: number) => <div key={k}>{fmtDate(a.at)}: {a.reason}</div>)}</Row>}
      {priv && <div className="mt-3"><Row label="Private note" tone="private"><span className="whitespace-pre-line">{priv}</span><div className="text-[12px] text-muted">Never printed or sent</div></Row></div>}
      {overrides.length > 0 && <div className="mt-2"><Row label="Warnings overridden" tone="private">{overrides.map((o: any, k: number) => <div key={k}><b className="font-semibold">{(o.warnings ?? []).join('; ')}</b><span className="text-ink-2"> — {o.reason}</span>{o.at && <span className="text-[12px] text-muted"> · {fmtDate(o.at)}</span>}</div>)}</Row></div>}
    </div>
  );
}

/** Prescription (as printed) or Full notes (everything written): the reader's last choice is kept for the next visit they open. */
export type VisitView = 'rx' | 'full';
export function useVisitView(): [VisitView, (v: VisitView) => void] {
  const [v, setV] = useState<VisitView>(() => { try { return localStorage.getItem('visit.view') === 'full' ? 'full' : 'rx'; } catch { return 'rx'; } });
  return [v, (n) => { setV(n); try { localStorage.setItem('visit.view', n); } catch { /* private mode */ } }];
}
export const VisitSwitch = ({ value, onChange }: { value: VisitView; onChange: (v: VisitView) => void }) =>
  <Segmented<VisitView> size="sm" value={value} onChange={onChange} options={[{ value: 'rx', label: 'Prescription' }, { value: 'full', label: 'Full notes' }]} />;

export function EncounterModal({ id, onClose }: { id: string; onClose: () => void }) {
  const [view, setView] = useVisitView();
  return (
    <Drawer title="Previous consultation" onClose={onClose} width="max-w-3xl">
      <div className="mb-3 flex items-center gap-2"><VisitSwitch value={view} onChange={setView} /><button className="btn btn-sm ml-auto" onClick={() => openPrint({ title: 'Prescription', rx: id })}><Icon name="print" className="h-3.5 w-3.5" />Print</button></div>
      {view === 'full' ? <EncounterDetail id={id} /> : <div className="overflow-x-auto rounded-lg bg-paper-2 p-4"><div className="mx-auto w-fit bg-white shadow-md"><PrintRx key={id} id={id} embed /></div></div>}
    </Drawer>
  );
}

export function DocList({ docs, onDelete, who }: { docs: any[]; onDelete?: (id: string) => void; who?: string }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
      {docs.map((d, i) => (
        <div key={d.id} role="button" tabIndex={0} aria-label={`Open ${d.title}`} onClick={() => openViewer({ docs, index: i, who, canDelete: !!onDelete })} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openViewer({ docs, index: i, who, canDelete: !!onDelete }); } }} className="card card-hover !p-2 flex cursor-pointer gap-2 items-center group">
          {d.mime.startsWith('image/') ? <img src={`/api/documents/${d.id}/file`} alt="" className="h-12 w-12 rounded-lg object-cover bg-paper-2" loading="lazy" /> : <div className="h-12 w-12 rounded-lg bg-clay-soft text-clay grid place-items-center text-[10px] font-bold">PDF</div>}
          <div className="min-w-0 flex-1"><div className="text-xs font-medium truncate">{d.title}</div><div className="text-[10px] text-muted">{d.kind} · {fmtDate(d.createdAt)}</div></div>
          {onDelete && <button aria-label="Remove" className="btn btn-ghost btn-icon opacity-0 group-hover:opacity-100" onClick={(e) => { e.stopPropagation(); onDelete(d.id); }}><Icon name="x" className="h-3.5 w-3.5" /></button>}
        </div>
      ))}
    </div>
  );
}

/** Upload button: reads the file, posts base64. Works with phone camera (accept image) and PDFs. */
export function UploadButton({ patientId, encounterId, recommendationId, recommendationIds, kind = 'report', onDone, label = 'Upload' }: { patientId: string; encounterId?: string; recommendationId?: string; recommendationIds?: string[]; kind?: string; onDone: () => void; label?: string }) {
  return (
    <label className="btn btn-sm cursor-pointer whitespace-nowrap"><Icon name="plus" className="h-3.5 w-3.5" />{label}
      <input type="file" accept="image/*,application/pdf" className="hidden" onChange={async (ev) => {
        const f = ev.target.files?.[0]; if (!f) return;
        const dataBase64 = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(f); });
        try { await post('/documents', { patientId, encounterId, recommendationId, recommendationIds, kind, title: f.name, mime: f.type, dataBase64 }); onDone(); }
        catch (e: any) { toast(e?.body?.code === 'UNSUPPORTED_TYPE' ? 'Only JPG, PNG, WebP and PDF files can be added.' : e?.body?.code === 'TOO_LARGE' ? 'That file is too large (10 MB at most).' : 'Upload failed. Please try again.', 'err'); }
        ev.target.value = '';
      }} />
    </label>
  );
}
