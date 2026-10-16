import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useNavigate, useParams, useOutletContext } from 'react-router';
import { get, patch, qc, ApiError } from '../api';
import { can } from '../App';

type Field = { key: string; label: string; type: string; required?: boolean; options?: string[]; unit?: string; placeholder?: string };
type RxItem = { medicineId?: string | null; name: string; dose?: string; route?: string; frequency?: string; durationDays?: number; instructions?: string };
type Rec = { kind: 'followup' | 'procedure'; procedureId?: string | null; intervalDays?: number; dueOn?: string; sittings?: number; notes?: string };

const FREQ = ['once daily', 'twice daily', 'thrice daily', 'at night', 'morning', 'alternate days', 'weekly', 'SOS'];

/** Doctor's screen: timeline on the left, form engine + Rx + plan on the right. Auto-saves drafts. */
export function Encounter() {
  const { id } = useParams(); const nav = useNavigate(); const { cfg, perms, me } = useOutletContext<any>();
  const enc = useQuery({ queryKey: ['encounter', id], queryFn: () => get(`/encounters/${id}`) });
  const timeline = useQuery({ queryKey: ['timeline', enc.data?.patientId], queryFn: () => get(`/patients/${enc.data.patientId}/timeline`), enabled: !!enc.data });
  const [data, setData] = useState<Record<string, any>>({});
  const [rx, setRx] = useState<RxItem[]>([]);
  const [recs, setRecs] = useState<Rec[]>([]);
  const [errors, setErrors] = useState<{ path: string; message: string }[]>([]);
  const loaded = useRef(false);
  useEffect(() => {
    if (enc.data && !loaded.current) {
      loaded.current = true; setData(enc.data.data ?? {}); setRx(enc.data.prescription.map((i: any) => ({ ...i })));
      setRecs(enc.data.recommendations.map((r: any) => ({ kind: r.kind, procedureId: r.procedureId, dueOn: r.dueOn, sittings: r.sittings, notes: r.notes })));
    }
  }, [enc.data]);
  const save = useMutation({
    mutationFn: (complete: boolean) => patch(`/encounters/${id}`, { data, prescription: rx.filter((i) => i.name), recommendations: recs, complete }),
    onSuccess: (e, complete) => { setErrors([]); qc.invalidateQueries({ queryKey: ['queue'] }); if (complete) { window.open(`/print/${id}`, '_blank'); nav('/queue'); } },
    onError: (e: any) => { if (e instanceof ApiError && e.body.code === 'FORM_INVALID') setErrors(e.body.errors); else alert(e.message); },
  });
  // Draft autosave every 20 s while editing
  useEffect(() => { const t = setInterval(() => { if (loaded.current && enc.data?.status !== 'completed') save.mutate(false); }, 20000); return () => clearInterval(t); }, [data, rx, recs, enc.data?.status]);

  if (!enc.data) return <div className="p-4 text-sm text-slate-500">Loading…</div>;
  const e = enc.data; const p = e.patient; const readOnly = e.status === 'completed';
  const isDoctor = can(perms, 'encounter.complete') || can(perms, 'encounter.*');
  const set = (s: string, k: string, v: any) => setData((d) => ({ ...d, [s]: { ...(d[s] ?? {}), [k]: v } }));
  const err = (s: string, k: string) => errors.find((x) => x.path === `${s}.${k}`)?.message;
  const lastRx = timeline.data?.encounters?.find((x: any) => x.id !== id && x.prescription?.length)?.prescription;

  return (
    <div className="grid lg:grid-cols-3 gap-4">
      <aside className="space-y-3 text-sm">
        <div className="card">
          <div className="text-lg font-semibold">{p.fullName} <span className="text-slate-400 text-base font-normal">{p.ageYears ? `${p.ageYears}y` : ''} {p.sex ?? ''}</span></div>
          <div className="text-slate-500">{p.patientNo} · {p.phone ?? ''} · {p.locality ?? ''}</div>
          {p.allergies && <div className="text-red-700 mt-1">Allergies: {p.allergies}</div>}
          {me.role === 'assistant' && <div className="badge mt-2">Intake mode: doctor will review</div>}
        </div>
        <div className="card">
          <div className="font-semibold mb-1">Previous visits</div>
          {(timeline.data?.encounters ?? []).filter((x: any) => x.id !== id).slice(0, 5).map((x: any) => (
            <div key={x.id} className="border-t border-slate-100 py-1.5">
              <div className="text-xs text-slate-500">{new Date(x.createdAt).toLocaleDateString('en-IN')}</div>
              <div><b>{x.data?.complaint?.chief_complaint}</b> {x.data?.assessment?.diagnosis && `→ ${x.data.assessment.diagnosis}`}</div>
              {x.prescription?.length > 0 && <div className="text-xs text-slate-600">{x.prescription.map((i: any) => i.name).join(', ')}</div>}
            </div>
          ))}
          {(timeline.data?.encounters ?? []).length <= 1 && <div className="text-slate-400">First visit</div>}
        </div>
      </aside>

      <section className="lg:col-span-2 space-y-3">
        {e.form.sections.map((s: any) => (
          <div key={s.key} className="card">
            <div className="text-sm font-semibold mb-2">{s.title}</div>
            <div className="grid md:grid-cols-2 gap-3">
              {s.fields.map((f: Field) => (
                <div key={f.key} className={f.type === 'textarea' || f.type === 'multiselect' ? 'md:col-span-2' : ''}>
                  <label className="label">{f.label}{f.required && <span className="text-red-600"> *</span>} {f.unit && <span className="text-slate-400">({f.unit})</span>}</label>
                  <FieldInput f={f} value={data[s.key]?.[f.key]} onChange={(v) => set(s.key, f.key, v)} disabled={readOnly} />
                  {err(s.key, f.key) && <div className="text-xs text-red-600 mt-0.5">{err(s.key, f.key)}</div>}
                </div>
              ))}
            </div>
          </div>
        ))}

        {isDoctor && (<>
          <div className="card">
            <div className="flex items-center gap-2 mb-2"><span className="text-sm font-semibold">Prescription</span>
              {lastRx && !readOnly && <button className="btn btn-sm" onClick={() => setRx(lastRx.map(({ id, encounterId, tenantId, sortOrder, dispensed, ...i }: any) => i))}>Repeat last Rx</button>}
              {!readOnly && <button className="btn btn-sm ml-auto" onClick={() => setRx([...rx, { name: '' }])}>+ Add</button>}</div>
            <datalist id="meds">{cfg?.medicines.map((m: any) => <option key={m.id} value={m.name} />)}</datalist>
            <datalist id="freq">{FREQ.map((x) => <option key={x} value={x} />)}</datalist>
            <table className="w-full text-sm"><thead className="text-xs text-slate-500 text-left"><tr><th className="w-1/3">Medicine</th><th>Dose</th><th>Frequency</th><th className="w-16">Days</th><th>Instructions</th><th /></tr></thead>
              <tbody>{rx.map((i, k) => (
                <tr key={k}>
                  <td className="pr-1 py-0.5"><input list="meds" className="input" value={i.name} disabled={readOnly} onChange={(ev) => {
                    const m = cfg?.medicines.find((x: any) => x.name === ev.target.value);
                    setRx(rx.map((r, j) => j === k ? { ...r, name: ev.target.value, medicineId: m?.id ?? null, ...(m ? { dose: m.defaults?.dose, route: m.defaults?.route, frequency: m.defaults?.frequency, durationDays: m.defaults?.durationDays, instructions: m.defaults?.instructions } : {}) } : r));
                  }} /></td>
                  <td className="pr-1"><input className="input" value={i.dose ?? ''} disabled={readOnly} onChange={(ev) => setRx(rx.map((r, j) => j === k ? { ...r, dose: ev.target.value } : r))} /></td>
                  <td className="pr-1"><input list="freq" className="input" value={i.frequency ?? ''} disabled={readOnly} onChange={(ev) => setRx(rx.map((r, j) => j === k ? { ...r, frequency: ev.target.value } : r))} /></td>
                  <td className="pr-1"><input type="number" className="input" value={i.durationDays ?? ''} disabled={readOnly} onChange={(ev) => setRx(rx.map((r, j) => j === k ? { ...r, durationDays: ev.target.value ? Number(ev.target.value) : undefined } : r))} /></td>
                  <td className="pr-1"><input className="input" value={i.instructions ?? ''} disabled={readOnly} onChange={(ev) => setRx(rx.map((r, j) => j === k ? { ...r, instructions: ev.target.value } : r))} /></td>
                  <td>{!readOnly && <button className="btn btn-sm" onClick={() => setRx(rx.filter((_, j) => j !== k))}>×</button>}</td>
                </tr>
              ))}</tbody></table>
            {rx.length === 0 && <div className="text-sm text-slate-400">No medicines</div>}
          </div>

          <div className="card">
            <div className="flex items-center gap-2 mb-2"><span className="text-sm font-semibold">Plan: follow-up & procedures</span>
              {!readOnly && <span className="ml-auto flex gap-1">
                {[7, 14, 30].map((d) => <button key={d} className="btn btn-sm" onClick={() => setRecs([...recs.filter((r) => r.kind !== 'followup'), { kind: 'followup', intervalDays: d }])}>Review in {d}d</button>)}
                <button className="btn btn-sm" onClick={() => setRecs([...recs, { kind: 'procedure', procedureId: cfg?.procedures[0]?.id, sittings: cfg?.procedures[0]?.typicalSittings }])}>+ Procedure</button></span>}</div>
            {recs.map((r, k) => (
              <div key={k} className="flex items-center gap-2 text-sm py-1 border-t border-slate-100">
                <span className="badge">{r.kind}</span>
                {r.kind === 'followup' ? <span>Review in <input type="number" className="input !w-16 inline" value={r.intervalDays ?? ''} disabled={readOnly} onChange={(ev) => setRecs(recs.map((x, j) => j === k ? { ...x, intervalDays: Number(ev.target.value), dueOn: undefined } : x))} /> days {r.dueOn && `(due ${r.dueOn})`}</span>
                  : <><select className="input !w-auto" value={r.procedureId ?? ''} disabled={readOnly} onChange={(ev) => { const pr = cfg.procedures.find((x: any) => x.id === ev.target.value); setRecs(recs.map((x, j) => j === k ? { ...x, procedureId: ev.target.value, sittings: pr?.typicalSittings } : x)); }}>{cfg?.procedures.map((pr: any) => <option key={pr.id} value={pr.id}>{pr.name}</option>)}</select>
                    <input type="number" className="input !w-16" value={r.sittings ?? ''} disabled={readOnly} onChange={(ev) => setRecs(recs.map((x, j) => j === k ? { ...x, sittings: Number(ev.target.value) } : x))} /> sittings</>}
                <input className="input flex-1" placeholder="notes" value={r.notes ?? ''} disabled={readOnly} onChange={(ev) => setRecs(recs.map((x, j) => j === k ? { ...x, notes: ev.target.value } : x))} />
                {!readOnly && <button className="btn btn-sm" onClick={() => setRecs(recs.filter((_, j) => j !== k))}>×</button>}
              </div>
            ))}
            {recs.length === 0 && <div className="text-sm text-slate-400">No follow-up or procedure</div>}
          </div>
        </>)}

        <div className="flex gap-2 items-center sticky bottom-0 bg-slate-50 py-2">
          <button className="btn" onClick={() => nav('/queue')}>Back to queue</button>
          {!readOnly && <button className="btn" disabled={save.isPending} onClick={() => save.mutate(false)}>{me.role === 'assistant' ? 'Save intake' : 'Save draft'}</button>}
          {!readOnly && isDoctor && <button className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate(true)}>Complete & print Rx</button>}
          {readOnly && <button className="btn btn-primary" onClick={() => window.open(`/print/${id}`, '_blank')}>Print Rx</button>}
          {errors.length > 0 && <span className="text-xs text-red-600">Fix {errors.length} required field(s)</span>}
          {save.isSuccess && !save.variables && <span className="text-xs text-slate-400">Draft saved</span>}
        </div>
      </section>
    </div>
  );
}

function FieldInput({ f, value, onChange, disabled }: { f: Field; value: any; onChange: (v: any) => void; disabled: boolean }) {
  if (f.type === 'textarea') return <textarea className="input min-h-16" value={value ?? ''} placeholder={f.placeholder} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
  if (f.type === 'select') return <select className="input" value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value || undefined)}><option value="">–</option>{f.options!.map((o) => <option key={o}>{o}</option>)}</select>;
  if (f.type === 'multiselect') { const v: string[] = value ?? []; return <div className="flex flex-wrap gap-1">{f.options!.map((o) => <button type="button" key={o} disabled={disabled} className={`btn btn-sm ${v.includes(o) ? '!bg-emerald-700 !text-white !border-emerald-700' : ''}`} onClick={() => onChange(v.includes(o) ? v.filter((x) => x !== o) : [...v, o])}>{o}</button>)}</div>; }
  if (f.type === 'number') return <input type="number" className="input" value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} />;
  if (f.type === 'date') return <input type="date" className="input" value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
  return <input className="input" value={value ?? ''} placeholder={f.placeholder} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
}
