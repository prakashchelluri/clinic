import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { get } from '../api';

/** A5 prescription. Fields follow the Telemedicine Practice Guidelines minimum: doctor, reg no, patient, date, items. */
export function PrintRx() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['print', id], queryFn: () => get(`/encounters/${id}/print`) });
  useEffect(() => { if (q.data && new URLSearchParams(location.search).get('auto') !== '0') setTimeout(() => window.print(), 300); }, [q.data]);
  if (!q.data) return <div className="p-8">Loading…</div>;
  const e = q.data; const p = e.patient; const d = e.data ?? {};
  const date = new Date(e.completedAt ?? e.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  return (
    <div className="mx-auto bg-white text-black p-8 print:p-6" style={{ width: '148mm', minHeight: '210mm', fontSize: '12px' }}>
      <style>{`@page { size: A5; margin: 8mm }`}</style>
      <div className="flex justify-between border-b-2 border-black pb-2">
        <div><div className="text-xl font-bold">{e.clinic.name}</div><div>{e.clinic.address}</div>{e.clinic.phone && <div>Ph: {e.clinic.phone}</div>}</div>
        <div className="text-right">{e.doctor && <><div className="font-semibold">{e.doctor.name}</div><div>{e.doctor.qualification}</div><div>Reg. No. {e.doctor.regNo}</div></>}</div>
      </div>
      <div className="flex justify-between py-2 border-b border-black">
        <div><b>{p.fullName}</b> {p.ageYears ? `· ${p.ageYears} y` : ''} {p.sex ? `· ${p.sex}` : ''}<div>ID {p.patientNo} · {p.phone ?? ''} · {p.locality ?? ''}</div></div>
        <div className="text-right"><div>{date}</div><div>OP {e.visit?.opNumber}</div>{e.visit?.details?.weight_kg && <div>Wt {e.visit.details.weight_kg} kg</div>}</div>
      </div>
      <div className="grid grid-cols-2 gap-x-4 py-2">
        {d.complaint?.chief_complaint && <div><b>C/o:</b> {d.complaint.chief_complaint} {d.complaint.duration ? `· ${d.complaint.duration}` : ''} {d.complaint.site?.length ? `· ${d.complaint.site.join(', ')}` : ''}</div>}
        {d.assessment?.diagnosis && <div><b>Dx:</b> {d.assessment.diagnosis} {d.assessment.severity ? `(${d.assessment.severity})` : ''}</div>}
        {d.exam?.findings && <div className="col-span-2"><b>O/e:</b> {d.exam.findings}</div>}
        {p.allergies && <div className="col-span-2"><b>Allergies:</b> {p.allergies}</div>}
      </div>
      <div className="text-2xl font-serif mt-2">℞</div>
      <table className="w-full mt-1"><tbody>
        {e.prescription.map((i: any, k: number) => (
          <tr key={i.id} className="align-top"><td className="pr-2 py-1">{k + 1}.</td>
            <td className="py-1"><b>{i.name}</b>{i.dose ? ` ${i.dose}` : ''}<div className="text-[11px]">{[i.frequency, i.route, i.durationDays ? `${i.durationDays} days` : null].filter(Boolean).join(' · ')}{i.instructions ? ` — ${i.instructions}` : ''}</div></td></tr>
        ))}
      </tbody></table>
      {d.plan?.advice && <div className="mt-3"><b>Advice:</b> {d.plan.advice}</div>}
      {e.recommendations.length > 0 && <div className="mt-2">{e.recommendations.map((r: any) => <div key={r.id}>• {r.kind === 'followup' ? `Review on ${r.dueOn ?? 'as advised'}` : `Procedure advised${r.sittings ? ` (${r.sittings} sittings)` : ''}${r.notes ? ` — ${r.notes}` : ''}`}</div>)}</div>}
      <div className="mt-16 flex justify-between items-end"><div className="text-[10px] text-gray-600">{e.clinic.footer}</div><div className="border-t border-black pt-1 w-48 text-center">Signature</div></div>
      <button className="no-print btn mt-6" onClick={() => window.print()}>Print</button>
    </div>
  );
}
