import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { get } from '../api';
import { joinList } from '../encounterDetail';
import { ageText } from '../rxLine';

const CELL = 'border border-gray-700 px-1.5 py-1 align-top';
/** "Label: value" on its own line. */
const Field = ({ label, children }: { label: string; children: React.ReactNode }) => <div className="mt-2"><b>{label}:</b> {children}</div>;
/** A numbered list under a label; a second line in the patient's language when there is one. */
const List = ({ label, items, local }: { label: string; items: string[]; local?: (s: string) => string | null }) => (
  <div className="mt-2"><b>{label}:</b><ol className="ml-5 list-decimal">{items.map((x, k) => <li key={k}>{x}{local?.(x) && <div className="text-gray-700">{local(x)}</div>}</li>)}</ol></div>);

/** A5 prescription. Fields follow the Telemedicine Practice Guidelines minimum: doctor, reg no, patient, date, items.
 *  What prints is the clinic's Print settings (sections on or off, language, out-of-range results only), not what shows on the pad. */
export function PrintRx({ id: idProp, embed = false, mode: modeProp }: { id?: string; embed?: boolean; mode?: 'results' } = {}) {
  const params = useParams(); const id = idProp ?? params.id;
  // results: the short sheet after the reports are in (results, diagnosis, anything added), not the whole prescription again
  const results = (modeProp ?? (new URLSearchParams(location.search).get('mode') as any)) === 'results';
  const q = useQuery({ queryKey: ['print', id], queryFn: () => get(`/encounters/${id}/print`) });
  useEffect(() => { if (!embed && q.data && new URLSearchParams(location.search).get('auto') !== '0') setTimeout(() => window.print(), 400); }, [q.data]);
  if (!q.data) return <div className="p-8">Loading…</div>;
  const e = q.data; const p = e.patient; const d = e.data ?? {};
  const pr = e.printRx ?? { lang: 'te+en', outOfRangeOnly: true, vitals: ['weight_kg', 'bp'] };
  const padOn = (k: string) => (e.pad ?? []).find((s: any) => s.key === k)?.print ?? true;
  const on = (k: string) => (results ? !['symptoms', 'exam', 'history', 'vitals', 'tests'].includes(k) : true) && padOn(k);
  const issuedAt = e.completedAt ? new Date(e.completedAt).getTime() : 0;
  const rxLines: any[] = results ? e.prescription.filter((i: any) => i.createdAt && new Date(i.createdAt).getTime() > issuedAt + 60_000) : e.prescription;
  // the patient's language (Telugu or Hindi, the clinic's print setting) under the English; null for a phrase with no translation
  const tel = (s: string | null | undefined) => (s && pr.lang !== 'en' ? (e.local ?? e.telugu)?.[s] ?? null : null);
  const line = (xs: (string | null | undefined)[]) => xs.filter(Boolean).join(' · ');
  const date = new Date(results ? e.provenance?.reportsClosedAt ?? Date.now() : e.completedAt ?? e.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  const investigations = e.recommendations.filter((r: any) => r.kind === 'investigation');
  const plans = e.recommendations.filter((r: any) => r.kind !== 'investigation');
  const syms: any[] = Array.isArray(d.complaint?.chief_complaint) ? d.complaint.chief_complaint.map((x: any) => (typeof x === 'string' ? { name: x } : x)) : d.complaint?.chief_complaint ? [{ name: String(d.complaint.chief_complaint) }] : [];
  const dxs: any[] = Array.isArray(d.assessment?.diagnosis) ? d.assessment.diagnosis.map((x: any) => (typeof x === 'string' ? { name: x } : x)) : d.assessment?.diagnosis ? [{ name: String(d.assessment.diagnosis) }] : [];
  const vit = e.visit?.details ?? {}; const vitals: [string, any][] = (pr.vitals ?? []).map((k: string) => [k, vit[k]] as [string, any]).filter(([, v]: [string, any]) => v !== undefined && v !== null && v !== '');
  const vLabel: Record<string, [string, string]> = { weight_kg: ['Wt', ' kg'], height_cm: ['Ht', ' cm'], bp: ['BP', ''], pulse: ['Pulse', ''], temp_f: ['Temp', '°F'], spo2: ['SpO₂', '%'],
    ...Object.fromEntries((e.vitalFields ?? []).map((v: any) => [v.key, [v.label, v.unit ? ` ${v.unit}` : '']])) }; // the clinic's own vitals (Settings) print by their name
  const outOnly = results ? false : d.labs?.printOutOfRangeOnly ?? pr.outOfRangeOnly;
  const labs: any[] = (e.labs ?? []).filter((r: any) => !outOnly || ['low', 'high', 'abnormal'].includes(r.flag));
  const exam: any[] = Array.isArray(d.exam?.items) ? d.exam.items : [];
  // custom modules (Tatva's): the lines written, under the module's name as it was on the pad
  const modules: any[] = results ? [] : Object.values(d.modules ?? {}).map((m: any) => ({ ...m, rows: (m?.rows ?? []).filter((r: any[]) => Array.isArray(r) && r.some((c) => String(c ?? '').trim())) })).filter((m: any) => m.rows.length && Array.isArray(m.columns));
  const canvases: any[] = results ? [] : (Array.isArray(d.canvases) ? d.canvases : []).filter((c: any) => c.showInRx && c.docId);
  const advice: string[] = String(d.plan?.advice ?? '').split('\n').map((x: string) => x.trim()).filter(Boolean);
  const hist = p.history ?? {};
  // English always prints. The second line is in the patient's language, and a part with no translation stays in English there,
  // so no instruction is ever dropped (a clinic still set to the old "Telugu only" gets English + Telugu).
  const teOr = (s: string | null | undefined) => tel(s) ?? s ?? null;
  const localLine = (xs: (string | null | undefined)[]) => (xs.some((x) => tel(x)) ? line(xs.map(teOr)) : '');
  // not finished yet: marked as a draft across the page and printed without a signature line
  const draft = e.status === 'draft';
  const age = ageText(p);
  const time = new Date(e.completedAt ?? e.createdAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
  const conditions: string[] = (hist.conditions ?? []).map((x: any) => x.name);
  // allergies always print (safety), from the history lists or the older free-text field
  const allergies: string[] = [...(hist.drugAllergies ?? []), ...(hist.otherAllergies ?? [])].map((x: any) => x.name).filter(Boolean);
  if (!allergies.length && p.allergies) allergies.push(p.allergies);
  const followups = plans.filter((r: any) => r.kind === 'followup' && on('followup'));
  const procs = plans.filter((r: any) => r.kind !== 'followup' && on('procedures'));
  return (
    <div className="relative mx-auto bg-white text-black p-8 print:p-6" style={{ width: '148mm', minHeight: '210mm', fontSize: '12px', fontFamily: 'Inter, sans-serif' }}>
      {draft && <div aria-label="Draft, not signed" className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden"><div className="whitespace-nowrap font-bold uppercase" style={{ transform: 'rotate(-35deg)', fontSize: '44px', color: 'rgba(200,0,0,0.18)', border: '4px solid rgba(200,0,0,0.18)', padding: '4px 16px' }}>Draft — not signed</div></div>}
      {!embed && <style>{`@page { size: A5; margin: 8mm } html, body { background: white !important; }`}</style>}
      <div className="flex justify-between border-b-2 border-black pb-2">
        <div className="flex items-start gap-3">{e.clinic.logoUrl && <img src={e.clinic.logoUrl} alt="" className="h-14 max-w-[120px] object-contain" />}<div><div className="text-xl font-bold" style={{ fontFamily: '"Source Serif 4", Georgia, serif' }}>{e.clinic.name}</div><div>{e.clinic.address}</div>{e.clinic.phone && <div>Ph: {e.clinic.phone}</div>}</div></div>
        <div className="text-right">{e.doctor && <><div className="font-semibold">{e.doctor.name}</div><div>{e.doctor.qualification}</div><div>Reg. No. {e.doctor.regNo}</div></>}</div>
      </div>
      {/* who and when: label and value, two columns, ruled above and below (Tatva's layout) */}
      <div className="grid grid-cols-2 gap-x-6 py-2.5 border-b border-black" style={{ lineHeight: 1.6 }}>
        <div><div><b>Patient name &amp; ID:</b> {p.fullName}, {p.patientNo}</div><div><b>Age / Gender:</b> {[age, p.sex].filter(Boolean).join(', ') || '—'}</div>{p.locality && <div><b>Address:</b> {p.locality}</div>}</div>
        <div><div><b>Date &amp; time:</b> {date}{!results && time ? ` ${time}` : ''}</div><div><b>Mobile no.:</b> {p.phone ?? '—'}</div><div>{results ? <><b>Results review</b> of the Rx dated {new Date(e.completedAt ?? e.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</> : <><b>OP no.:</b> {e.visit?.opNumber ?? '—'}</>}</div></div>
      </div>
      <div className="pt-1">
        {on('vitals') && vitals.length > 0 && <Field label="Vitals">{vitals.map(([k, v]: [string, any]) => `${vLabel[k]?.[0] ?? k} ${v}${vLabel[k]?.[1] ?? ''}`).join(' · ')}</Field>}
        {on('symptoms') && syms.length > 0 && <Field label="Symptoms">{syms.map((s) => s.name + (s.since || s.severity ? ` (${line([s.since ? `since ${s.since}` : null, s.severity?.toLowerCase()])})` : '')).join(', ')}{d.complaint?.site?.length ? ` · Site: ${d.complaint.site.join(', ')}` : ''}</Field>}
        {on('exam') && (exam.length > 0 || d.exam?.findings || d.exam?.morphology?.length) && <Field label="Examinations">{line([exam.map((x: any) => (x.note ? `${x.name} (${x.note})` : x.name)).join(', '), (d.exam?.morphology ?? []).join(', '), d.exam?.distribution, d.exam?.findings])}</Field>}
        {((on('history') && conditions.length > 0) || allergies.length > 0) && <div className="mt-2"><b>Medical history:</b>
          {on('history') && conditions.length > 0 && <div>Medical conditions: {conditions.join(', ')}</div>}
          {allergies.length > 0 && <div>Allergies: <b>{allergies.join(', ')}</b></div>}</div>}
        {on('diagnosis') && dxs.length > 0 && <Field label="Diagnosis">{dxs.map((x) => x.name + (x.since || x.severity || x.status || x.note ? ` (${line([x.since ? `since ${x.since}` : null, x.severity?.toLowerCase(), x.status?.toLowerCase(), x.note])})` : '')).join(', ')}</Field>}
      </div>
      {on('medicines') && (!results || rxLines.length > 0) && <div className="mt-3">
        <b>Medication (Rx):</b>{results && <span className="ml-2 text-[11px] text-gray-600">Added after the reports</span>}
        <table className="mt-1 w-full border-collapse text-[11.5px]" style={{ tableLayout: 'fixed' }}>
          <colgroup><col style={{ width: '7%' }} /><col style={{ width: '33%' }} /><col style={{ width: '13%' }} /><col style={{ width: '17%' }} /><col style={{ width: '12%' }} /><col style={{ width: '18%' }} /></colgroup>
          <thead><tr>{['No.', 'Medicines', 'Dose', 'Frequency', 'Duration', 'Notes'].map((h) => <th key={h} className={`${CELL} text-left font-semibold`}>{h}</th>)}</tr></thead>
          <tbody>{rxLines.map((i: any, k: number) => { const days = i.durationDays ? `${i.durationDays} days` : i.durationNote ?? null; const note = line([i.instructions, i.route && i.route !== 'oral' ? i.route : null]);
            return (
            <tr key={i.id}>
              <td className={CELL}>{k + 1}</td>
              <td className={CELL}><b>{i.name}</b>{i.generic && <div className="text-[10.5px] text-gray-600">{i.generic}</div>}</td>
              <td className={CELL}>{i.dose || '—'}{i.qty ? <div className="text-[10.5px] text-gray-600">Qty {i.qty}</div> : null}</td>
              <td className={CELL}>{i.frequency || '—'}{i.timing && <div>{i.timing}</div>}{localLine([i.frequency, i.timing]) && <div className="text-gray-700">{localLine([i.frequency, i.timing])}</div>}</td>
              <td className={CELL}>{days || '—'}{tel(days) && <div className="text-gray-700">{tel(days)}</div>}</td>
              <td className={CELL}>{note || '-'}{tel(i.instructions) && <div className="text-gray-700">{tel(i.instructions)}</div>}</td>
            </tr>); })}</tbody>
        </table></div>}
      {on('tests') && investigations.length > 0 && <List label="Investigation" items={investigations.map((r: any) => line([r.notes, d.plan?.testNotes?.[r.notes]]))} />}
      {on('results') && labs.length > 0 && <Field label={`Results${outOnly ? ' (out of range)' : ''}`}>{labs.map((r: any) => `${r.test} ${r.value}${r.unit ? ` ${r.unit}` : ''}${r.flag && r.flag !== 'normal' ? ` (${r.flag})` : ''}`).join(' · ')}</Field>}
      {on('advice') && advice.length > 0 && <List label="Advices" items={advice} local={tel} />}
      {procs.length > 0 && <List label="Procedures advised" items={procs.map((r: any) => `${r.procedure?.name ?? r.procedureName ?? 'Procedure'}${r.sittings ? ` (${r.sittings} sessions)` : ''}${r.notes ? ` — ${r.notes}` : ''}`)} />}
      {d.plan?.notes && <Field label="Notes"><span className="whitespace-pre-line">{d.plan.notes}</span></Field>}
      {modules.map((m: any, k: number) => <div key={k} className="mt-2"><b>{m.name}:</b><table className="mt-1 w-full border-collapse text-[11.5px]"><thead><tr>{m.columns.map((c: string) => <th key={c} className={`${CELL} text-left font-semibold`}>{c}</th>)}</tr></thead><tbody>{m.rows.map((r: string[], i: number) => <tr key={i}>{m.columns.map((c: string, j: number) => <td key={c} className={`${CELL} whitespace-pre-line`}>{r[j] ?? ''}</td>)}</tr>)}</tbody></table></div>)}
      {canvases.map((c: any) => <img key={c.id} src={`/api/documents/${c.docId}/file`} alt={c.name} className="mt-2 max-h-[70mm] max-w-full border border-gray-300" />)}
      {on('referral') && d.referral?.to && <Field label="Referred to">{line([d.referral.to, d.referral.speciality])}{d.referral.reason ? ` — ${d.referral.reason}` : ''}</Field>}
      {followups.length > 0 && <div className="mt-3 inline-block rounded border border-gray-500 px-3 py-1.5">{followups.map((r: any) => <div key={r.id}><b>Follow-up:</b> {r.dueOn ? new Date(`${r.dueOn}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : 'as advised'}{d.plan?.followupNote ? ` — ${d.plan.followupNote}` : ''}</div>)}</div>}
      {(e.amendments ?? []).length > 0 && <div className="mt-3 border-t border-black pt-1 text-[11px]">{e.amendments.map((a: any, k: number) => <div key={k}><b>Amended on {new Date(a.at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}:</b> {a.reason}</div>)}</div>}
      <div className="mt-16 flex justify-between items-end"><div className="text-[10px] text-gray-600">{e.clinic.footer}</div>{draft ? <div className="text-[11px] font-semibold text-red-700">Draft — not signed</div> : <div className="w-48 text-center">{e.doctor?.signatureUrl && <img src={e.doctor.signatureUrl} alt="Doctor's signature" className="mx-auto mb-1 h-12 max-w-full object-contain" />}<div className="border-t border-black pt-1">Signature</div></div>}</div>
      {!embed && <button className="no-print btn mt-6" onClick={() => window.print()}>Print</button>}
    </div>
  );
}
