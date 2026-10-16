import { useQuery } from '@tanstack/react-query';
import { get, post } from './api';
import { Chip, Icon, Modal, Skeleton, fmtDate } from './ui';

/** Form values may be a string (old encounters) or an array (tags fields). */
export const asList = (v: any): string[] => (Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [String(v)]);
export const joinList = (v: any) => asList(v).join(', ');

/** Full read-only view of one encounter, rendered from the form version it was written with. */
export function EncounterDetail({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['encounter', id], queryFn: () => get(`/encounters/${id}`) });
  const docs = useQuery({ queryKey: ['documents', q.data?.patientId], queryFn: () => get(`/patients/${q.data.patientId}/documents`), enabled: !!q.data });
  if (!q.data) return <Skeleton rows={4} />;
  const e = q.data; const d = e.data ?? {};
  const encDocs = (docs.data ?? []).filter((x: any) => x.encounterId === id);
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm text-muted flex-wrap"><span>{fmtDate(e.completedAt ?? e.createdAt)}</span>{e.doctor && <><span>·</span><span>{e.doctor.name}</span></>}<Chip tone={e.status === 'completed' ? 'sage' : 'amber'}>{e.status}</Chip></div>
      {e.form.sections.map((s: any) => {
        const filled = s.fields.filter((f: any) => asList(d[s.key]?.[f.key]).length || (typeof d[s.key]?.[f.key] === 'number'));
        if (!filled.length) return null;
        return (
          <div key={s.key}>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted mb-1.5">{s.title}</div>
            <div className="grid sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
              {filled.map((f: any) => { const v = d[s.key][f.key]; return (
                <div key={f.key} className={f.type === 'textarea' ? 'sm:col-span-2' : ''}><div className="text-xs text-muted">{f.label}</div>
                  {Array.isArray(v) ? <div className="flex flex-wrap gap-1 mt-0.5">{v.map((x: string) => <Chip key={x}>{x}</Chip>)}</div> : <div className="text-ink">{String(v)}{f.unit ? ` ${f.unit}` : ''}</div>}</div>); })}
            </div>
          </div>
        );
      })}
      {e.prescription.length > 0 && (
        <div><div className="text-[11px] font-semibold uppercase tracking-wider text-muted mb-1.5">Prescription</div>
          <table className="table"><tbody>{e.prescription.map((i: any, k: number) => <tr key={i.id}><td className="w-6 text-muted">{k + 1}</td><td className="font-medium">{i.name} <span className="font-normal text-muted">{i.dose ?? ''}</span></td><td className="text-muted">{[i.frequency, i.route, i.durationDays ? `${i.durationDays} days` : null].filter(Boolean).join(' · ')}</td><td className="text-muted">{i.instructions ?? ''}</td><td>{i.dispensed && <Chip tone="sage">dispensed</Chip>}</td></tr>)}</tbody></table></div>
      )}
      {e.recommendations.length > 0 && (
        <div><div className="text-[11px] font-semibold uppercase tracking-wider text-muted mb-1.5">Plan</div>
          <div className="space-y-1 text-sm">{e.recommendations.map((r: any) => <div key={r.id} className="flex items-center gap-2 flex-wrap"><Chip tone={r.kind === 'followup' ? 'amber' : r.kind === 'procedure' ? 'sky' : 'clay'}>{r.kind}</Chip><span>{r.kind === 'followup' ? `Review ${r.dueOn ? fmtDate(r.dueOn) : ''}` : r.kind === 'investigation' ? r.notes : `${r.sittings ? `${r.sittings} sittings` : ''} ${r.notes ?? ''}`}</span><Chip>{r.status}</Chip></div>)}</div></div>
      )}
      {encDocs.length > 0 && (
        <div><div className="text-[11px] font-semibold uppercase tracking-wider text-muted mb-1.5">Documents</div><DocList docs={encDocs} /></div>
      )}
      <div className="flex gap-2"><button className="btn btn-sm" onClick={() => window.open(`/print/${id}?auto=0`, '_blank')}><Icon name="print" className="h-3.5 w-3.5" />Open prescription</button></div>
    </div>
  );
}

export function EncounterModal({ id, onClose }: { id: string; onClose: () => void }) {
  return <Modal title="Previous consultation" onClose={onClose} width="max-w-3xl"><EncounterDetail id={id} /></Modal>;
}

export function DocList({ docs, onDelete }: { docs: any[]; onDelete?: (id: string) => void }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
      {docs.map((d) => (
        <a key={d.id} href={`/api/documents/${d.id}/file`} target="_blank" rel="noreferrer" className="card card-hover !p-2 flex gap-2 items-center group">
          {d.mime.startsWith('image/') ? <img src={`/api/documents/${d.id}/file`} alt="" className="h-12 w-12 rounded-lg object-cover bg-paper-2" loading="lazy" /> : <div className="h-12 w-12 rounded-lg bg-clay-soft text-clay grid place-items-center text-[10px] font-bold">PDF</div>}
          <div className="min-w-0 flex-1"><div className="text-xs font-medium truncate">{d.title}</div><div className="text-[10px] text-muted">{d.kind} · {fmtDate(d.createdAt)}</div></div>
          {onDelete && <button className="btn btn-ghost btn-icon opacity-0 group-hover:opacity-100" onClick={(e) => { e.preventDefault(); onDelete(d.id); }}><Icon name="x" className="h-3.5 w-3.5" /></button>}
        </a>
      ))}
    </div>
  );
}

/** Upload button: reads the file, posts base64. Works with phone camera (accept image) and PDFs. */
export function UploadButton({ patientId, encounterId, recommendationId, kind = 'report', onDone, label = 'Upload report / photo' }: { patientId: string; encounterId?: string; recommendationId?: string; kind?: string; onDone: () => void; label?: string }) {
  return (
    <label className="btn btn-sm cursor-pointer"><Icon name="plus" className="h-3.5 w-3.5" />{label}
      <input type="file" accept="image/*,application/pdf" className="hidden" onChange={async (ev) => {
        const f = ev.target.files?.[0]; if (!f) return;
        const dataBase64 = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(f); });
        try { await post('/documents', { patientId, encounterId, recommendationId, kind: f.type.startsWith('image/') && kind === 'report' ? 'photo' : kind, title: f.name, mime: f.type, dataBase64 }); onDone(); }
        catch (e: any) { alert(e?.body?.code === 'UNSUPPORTED_TYPE' ? 'Only JPG, PNG, WebP and PDF are accepted' : 'Upload failed'); }
        ev.target.value = '';
      }} />
    </label>
  );
}
