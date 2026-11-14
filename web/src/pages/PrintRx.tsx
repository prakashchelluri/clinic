import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { get } from '../api';
import { joinList } from '../encounterDetail';
import { ageText } from '../rxLine';

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
  const hist = p.history ?? {}; const histLine = ['conditions', 'drugAllergies', 'otherAllergies'].flatMap((k) => (hist[k] ?? []).map((x: any) => x.name)).join(', ');
  // English always prints. The second line is in the patient's language, and a part with no translation stays in English there,
  // so no instruction is ever dropped (a clinic still set to the old "Telugu only" gets English + Telugu).
  const teOr = (s: string | null | undefined) => tel(s) ?? s ?? null;
  const localLine = (xs: (string | null | undefined)[]) => (xs.some((x) => tel(x)) ? line(xs.map(teOr)) : '');
  // not finished yet: marked as a draft across the page and printed without a signature line
  const draft = e.status === 'draft';
  const age = ageText(p);
  return (
    <div className="relative mx-auto bg-white text-black p-8 print:p-6" style={{ width: '148mm', minHeight: '210mm', fontSize: '12px', fontFamily: 'Inter, sans-serif' }}>
      {draft && <div aria-label="Draft, not signed" className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden"><div className="whitespace-nowrap font-bold uppercase" style={{ transform: 'rotate(-35deg)', fontSize: '44px', color: 'rgba(200,0,0,0.18)', border: '4px solid rgba(200,0,0,0.18)', padding: '4px 16px' }}>Draft — not signed</div></div>}
      {!embed && <style>{`@page { size: A5; margin: 8mm } html, body { background: white !important; }`}</style>}
      <div className="flex justify-between border-b-2 border-black pb-2">
        <div className="flex items-start gap-3">{e.clinic.logoUrl && <img src={e.clinic.logoUrl} alt="" className="h-14 max-w-[120px] object-contain" />}<div><div className="text-xl font-bold" style={{ fontFamily: '"Source Serif 4", Georgia, serif' }}>{e.clinic.name}</div><div>{e.clinic.address}</div>{e.clinic.phone && <div>Ph: {e.clinic.phone}</div>}</div></div>
        <div className="text-right">{e.doctor && <><div className="font-semibold">{e.doctor.name}</div><div>{e.doctor.qualification}</div><div>Reg. No. {e.doctor.regNo}</div></>}</div>
      </div>
      <div className="flex justify-between py-2 border-b border-black">
        <div><b>{p.fullName}</b> {age ? `· ${age}` : ''} {p.sex ? `· ${p.sex}` : ''}<div>ID {p.patientNo} · {p.phone ?? ''} · {p.locality ?? ''}</div></div>
        <div className="text-right"><div>{date}</div><div>{results ? `Results review · Rx of ${new Date(e.completedAt ?? e.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}` : `OP ${e.visit?.opNumber}`}</div>{on('vitals') && vitals.length > 0 && <div>{vitals.map(([k, v]: [string, any]) => `${vLabel[k]?.[0] ?? k} ${v}${vLabel[k]?.[1] ?? ''}`).join(' · ')}</div>}</div>
      </div>
      <div className="grid grid-cols-2 gap-x-4 py-2">
        {on('symptoms') && syms.length > 0 && <div><b>C/o:</b> {syms.map((s) => line([s.name, s.since ? `since ${s.since}` : null, s.severity?.toLowerCase()])).join('; ')}{d.complaint?.site?.length ? ` · ${d.complaint.site.join(', ')}` : ''}</div>}
        {on('diagnosis') && dxs.length > 0 && <div><b>Dx:</b> {dxs.map((x) => line([x.name, x.since ? `since ${x.since}` : null, x.severity?.toLowerCase(), x.status?.toLowerCase(), x.note])).join('; ')}</div>}
        {on('exam') && (exam.length > 0 || d.exam?.findings || d.exam?.morphology?.length) && <div className="col-span-2"><b>O/e:</b> {line([exam.map((x: any) => line([x.name, x.note])).join('; '), (d.exam?.morphology ?? []).join(', '), d.exam?.distribution, d.exam?.findings])}</div>}
        {(p.allergies || (on('history') && histLine)) && <div className="col-span-2">{p.allergies && <><b>Allergies:</b> {p.allergies}</>}{on('history') && histLine && <> · <b>History:</b> {histLine}</>}</div>}
      </div>
      {on('medicines') && (!results || rxLines.length > 0) && <>
        <div className="text-2xl mt-2" style={{ fontFamily: '"Source Serif 4", Georgia, serif' }}>℞{results && <span className="ml-2 align-middle text-[11px] font-sans text-gray-600">Added after the reports</span>}</div>
        <table className="w-full mt-1"><tbody>
          {rxLines.map((i: any, k: number) => { const days = i.durationDays ? `${i.durationDays} days` : i.durationNote ?? null; const parts = [i.frequency, i.timing, days]; const teLine = localLine([...parts, i.instructions]); return (
            <tr key={i.id} className="align-top"><td className="pr-2 py-1">{k + 1}.</td>
              <td className="py-1"><b>{i.name}</b>{i.dose ? ` ${i.dose}` : ''}{i.qty ? <span className="float-right text-[11px] text-gray-600">× {i.qty}</span> : null}
                {<div className="text-[11px]">{line([...parts, i.route && i.route !== 'oral' ? i.route : null])}{i.instructions ? ` — ${i.instructions}` : ''}</div>}
                {teLine && <div className="text-[11px] text-gray-800">{teLine}</div>}</td></tr>); })}
        </tbody></table>
      </>}
      {on('tests') && investigations.length > 0 && <div className="mt-3"><b>Investigations:</b> {investigations.map((r: any) => line([r.notes, d.plan?.testNotes?.[r.notes]])).join(', ')}</div>}
      {on('results') && labs.length > 0 && <div className="mt-2"><b>Results{outOnly ? ' (out of range)' : ''}:</b> {labs.map((r: any) => `${r.test} ${r.value}${r.unit ? ` ${r.unit}` : ''}${r.flag && r.flag !== 'normal' ? ` (${r.flag})` : ''}`).join(' · ')}</div>}
      {on('advice') && advice.length > 0 && <div className="mt-2"><b>Advice:</b> {advice.join(' · ')}{localLine(advice) && <div className="text-gray-800">{localLine(advice)}</div>}</div>}
      {plans.filter((r: any) => on(r.kind === 'followup' ? 'followup' : 'procedures')).length > 0 && <div className="mt-2">{plans.filter((r: any) => on(r.kind === 'followup' ? 'followup' : 'procedures')).map((r: any) => <div key={r.id}>• {r.kind === 'followup' ? `Review on ${r.dueOn ?? 'as advised'}${d.plan?.followupNote ? ` — ${d.plan.followupNote}` : ''}` : `${r.procedure?.name ?? r.procedureName ?? 'Procedure'} advised${r.sittings ? ` (${r.sittings} sittings)` : ''}${r.notes ? ` — ${r.notes}` : ''}`}</div>)}</div>}
      {d.plan?.notes && <div className="mt-2 whitespace-pre-line"><b>Notes:</b> {d.plan.notes}</div>}
      {modules.map((m: any, k: number) => <div key={k} className="mt-2"><b>{m.name}:</b><table className="mt-0.5 w-full border-collapse text-[11.5px]"><thead><tr>{m.columns.map((c: string) => <th key={c} className="border-b border-gray-400 py-0.5 pr-2 text-left font-semibold">{c}</th>)}</tr></thead><tbody>{m.rows.map((r: string[], i: number) => <tr key={i}>{m.columns.map((c: string, j: number) => <td key={c} className="py-0.5 pr-2 align-top whitespace-pre-line">{r[j] ?? ''}</td>)}</tr>)}</tbody></table></div>)}
      {canvases.map((c: any) => <img key={c.id} src={`/api/documents/${c.docId}/file`} alt={c.name} className="mt-2 max-h-[70mm] max-w-full border border-gray-300" />)}
      {on('referral') && d.referral?.to && <div className="mt-2"><b>Referred to:</b> {line([d.referral.to, d.referral.speciality])}{d.referral.reason ? ` — ${d.referral.reason}` : ''}</div>}
      {(e.amendments ?? []).length > 0 && <div className="mt-3 border-t border-black pt-1 text-[11px]">{e.amendments.map((a: any, k: number) => <div key={k}><b>Amended on {new Date(a.at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}:</b> {a.reason}</div>)}</div>}
      <div className="mt-16 flex justify-between items-end"><div className="text-[10px] text-gray-600">{e.clinic.footer}</div>{draft ? <div className="text-[11px] font-semibold text-red-700">Draft — not signed</div> : <div className="w-48 text-center">{e.doctor?.signatureUrl && <img src={e.doctor.signatureUrl} alt="Doctor's signature" className="mx-auto mb-1 h-12 max-w-full object-contain" />}<div className="border-t border-black pt-1">Signature</div></div>}</div>
      {!embed && <button className="no-print btn mt-6" onClick={() => window.print()}>Print</button>}
    </div>
  );
}
