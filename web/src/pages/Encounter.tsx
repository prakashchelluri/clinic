import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useNavigate, useParams, useOutletContext } from 'react-router';
import { get, patch, qc, ApiError } from '../api';
import { can } from '../App';
import { Avatar, Chip, Icon, Skeleton, fmtDate, toast } from '../ui';
import { EncounterModal, DocList, UploadButton, asList, joinList } from '../encounterDetail';

type Field = { key: string; label: string; type: string; required?: boolean; options?: string[]; unit?: string; placeholder?: string };
type RxItem = { medicineId?: string | null; name: string; dose?: string; route?: string; frequency?: string; durationDays?: number; instructions?: string };
type Rec = { kind: 'followup' | 'procedure' | 'investigation'; procedureId?: string | null; intervalDays?: number; dueOn?: string; sittings?: number; notes?: string };

const FREQ = ['once daily', 'twice daily', 'thrice daily', 'at night', 'morning', 'alternate days', 'weekly', 'SOS'];
const TESTS = ['CBC', 'FBS / PPBS', 'HbA1c', 'LFT', 'RFT', 'Lipid profile', 'TSH', 'Vitamin D', 'Vitamin B12', 'Serum ferritin', 'KOH mount', 'Skin biopsy', 'Patch test', 'VDRL', 'HIV', 'HBsAg', 'ANA', 'Urine routine', 'Culture & sensitivity', 'Woods lamp'];

/** Doctor's screen: patient context on the left, form engine + Rx + plan on the right. Drafts autosave. */
export function Encounter() {
  const { id } = useParams(); const nav = useNavigate(); const { cfg, perms, me } = useOutletContext<any>();
  const enc = useQuery({ queryKey: ['encounter', id], queryFn: () => get(`/encounters/${id}`) });
  const timeline = useQuery({ queryKey: ['timeline', enc.data?.patientId], queryFn: () => get(`/patients/${enc.data.patientId}/timeline`), enabled: !!enc.data });
  const docs = useQuery({ queryKey: ['documents', enc.data?.patientId], queryFn: () => get(`/patients/${enc.data.patientId}/documents`), enabled: !!enc.data });
  const [data, setData] = useState<Record<string, any>>({});
  const [rx, setRx] = useState<RxItem[]>([]);
  const [recs, setRecs] = useState<Rec[]>([]);
  const [errors, setErrors] = useState<{ path: string; message: string }[]>([]);
  const [savedAt, setSavedAt] = useState<string>('');
  const [viewing, setViewing] = useState<string | null>(null);
  const loaded = useRef(false); const dirty = useRef(false);
  useEffect(() => {
    if (enc.data && !loaded.current) {
      loaded.current = true; setData(enc.data.data ?? {}); setRx(enc.data.prescription.map((i: any) => ({ ...i })));
      setRecs(enc.data.recommendations.map((r: any) => ({ kind: r.kind, procedureId: r.procedureId, dueOn: r.dueOn, sittings: r.sittings, notes: r.notes })));
    }
  }, [enc.data]);
  const save = useMutation({
    mutationFn: (complete: boolean) => patch(`/encounters/${id}`, { data, prescription: rx.filter((i) => i.name), recommendations: recs.filter((r) => r.kind !== 'investigation' || r.notes), complete }),
    onSuccess: (_e, complete) => { setErrors([]); dirty.current = false; setSavedAt(new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })); qc.invalidateQueries({ queryKey: ['queue'] }); if (complete) { toast('Encounter completed'); window.open(`/print/${id}`, '_blank'); nav('/queue', { viewTransition: true }); } },
    onError: (e: any) => { if (e instanceof ApiError && e.body.code === 'FORM_INVALID') { setErrors(e.body.errors); toast('Some required fields are empty', 'err'); } else toast(e.message, 'err'); },
  });
  useEffect(() => { if (loaded.current) dirty.current = true; }, [data, rx, recs]);
  useEffect(() => { const t = setInterval(() => { if (loaded.current && dirty.current && enc.data?.status !== 'completed' && !save.isPending) save.mutate(false); }, 15000); return () => clearInterval(t); }, [enc.data?.status, save.isPending]);

  if (!enc.data) return <div className="card"><Skeleton rows={5} /></div>;
  const e = enc.data; const p = e.patient; const readOnly = e.status === 'completed';
  const isDoctor = can(perms, 'encounter.complete') || can(perms, 'encounter.*');
  const set = (s: string, k: string, v: any) => setData((d) => ({ ...d, [s]: { ...(d[s] ?? {}), [k]: v } }));
  const err = (s: string, k: string) => errors.find((x) => x.path === `${s}.${k}`)?.message;
  const previous = (timeline.data?.encounters ?? []).filter((x: any) => x.id !== id);
  // Medicines this patient has had before: name → most recent date
  const priorMeds = new Map<string, string>();
  for (const x of [...previous].reverse()) for (const i of x.prescription ?? []) priorMeds.set(i.name, x.createdAt);
  const lastRx = previous.find((x: any) => x.prescription?.length)?.prescription;
  const myDocs = (docs.data ?? []);
  const addRx = (name: string) => { const m = cfg?.medicines.find((x: any) => x.name === name); setRx((cur) => [...cur.filter((r) => r.name), { name, medicineId: m?.id ?? null, dose: m?.defaults?.dose, route: m?.defaults?.route, frequency: m?.defaults?.frequency, durationDays: m?.defaults?.durationDays, instructions: m?.defaults?.instructions }]); };

  return (
    <div className="grid lg:grid-cols-[300px_1fr] gap-5">
      <aside className="space-y-4 lg:sticky lg:top-6 self-start">
        <div className="card anim-fade-up">
          <div className="flex items-center gap-3"><Avatar name={p.fullName} size="h-12 w-12 text-base" /><div className="min-w-0"><div className="text-lg font-medium leading-tight truncate">{p.fullName}</div><div className="text-xs text-muted">{p.ageYears ? `${p.ageYears}y` : ''} {p.sex ?? ''} · {p.patientNo}</div></div></div>
          <div className="text-xs text-muted mt-3 flex flex-wrap gap-x-3 gap-y-1"><span>{p.phone ?? 'no phone'}</span>{p.locality && <span>{p.locality}</span>}</div>
          {p.allergies && <div className="mt-3 text-sm text-rose bg-rose-soft rounded-xl px-3 py-2 flex gap-2"><Icon name="spark" className="h-4 w-4 shrink-0" />Allergies: {p.allergies}</div>}
          {me.role === 'assistant' && <div className="mt-3"><Chip tone="sky">Intake mode · doctor reviews next</Chip></div>}
        </div>
        <div className="card anim-fade-up" style={{ animationDelay: '60ms' }}>
          <div className="text-[11px] uppercase tracking-wider text-muted mb-2">Previous visits <span className="normal-case tracking-normal">· click to open</span></div>
          {previous.length === 0 && <div className="text-sm text-muted">First visit</div>}
          {previous.slice(0, 6).map((x: any) => (
            <button key={x.id} onClick={() => setViewing(x.id)} className="w-full text-left border-t border-line first:border-t-0 py-2.5 text-sm hover:bg-paper rounded-lg px-1 -mx-1 transition-colors">
              <div className="flex items-center gap-2 text-xs text-muted"><span>{fmtDate(x.createdAt)}</span><Icon name="chevR" className="h-3 w-3 ml-auto" /></div>
              <div className="mt-0.5"><b>{joinList(x.data?.complaint?.chief_complaint) || 'Consultation'}</b>{joinList(x.data?.assessment?.diagnosis) && <span className="text-ink-2"> → {joinList(x.data.assessment.diagnosis)}</span>}</div>
              {x.prescription?.length > 0 && <div className="text-xs text-muted mt-0.5 truncate">{x.prescription.map((i: any) => i.name).join(', ')}</div>}
            </button>
          ))}
        </div>
        <div className="card anim-fade-up" style={{ animationDelay: '100ms' }}>
          <div className="flex items-center gap-2 mb-2"><div className="text-[11px] uppercase tracking-wider text-muted">Reports & photos</div><span className="ml-auto" />{can(perms, 'document.write') && <UploadButton patientId={p.id} encounterId={id} label="Upload" onDone={() => { qc.invalidateQueries({ queryKey: ['documents', p.id] }); toast('Uploaded'); }} />}</div>
          {myDocs.length === 0 ? <div className="text-xs text-muted">No reports yet. Lab PDFs and clinical photos go here.</div> : <DocList docs={myDocs.slice(0, 6)} />}
        </div>
      </aside>

      <section className="space-y-4 min-w-0">
        <div className="anim-fade-up flex items-center gap-3 flex-wrap"><h1 className="text-[28px] font-medium">Consultation</h1><Chip tone={readOnly ? 'sage' : 'amber'}>{e.status}</Chip>{e.doctor && <span className="text-sm text-muted">{e.doctor.name}</span>}<span className="ml-auto text-xs text-muted">{savedAt ? `Draft saved ${savedAt}` : readOnly ? '' : 'Autosaves every 15 s'}</span></div>

        {e.form.sections.map((s: any, si: number) => (
          <div key={s.key} className="card anim-fade-up" style={{ animationDelay: `${60 + si * 50}ms` }}>
            <div className="serif text-lg mb-3">{s.title}</div>
            <div className="grid md:grid-cols-2 gap-4">
              {s.fields.map((f: Field) => (
                <div key={f.key} className={['textarea', 'multiselect', 'tags'].includes(f.type) ? 'md:col-span-2' : ''}>
                  <label className="label">{f.label}{f.required && <span className="text-clay"> *</span>} {f.unit && <span className="normal-case tracking-normal">({f.unit})</span>}</label>
                  <FieldInput f={f} value={data[s.key]?.[f.key]} onChange={(v) => set(s.key, f.key, v)} disabled={readOnly} invalid={!!err(s.key, f.key)} />
                  {err(s.key, f.key) && <div className="text-xs text-rose mt-1 anim-fade-in">{err(s.key, f.key)}</div>}
                </div>
              ))}
            </div>
          </div>
        ))}

        {isDoctor && (<>
          <div className="card anim-fade-up" style={{ animationDelay: '260ms' }}>
            <div className="flex items-center gap-2 mb-3"><div className="serif text-lg">Prescription</div>
              {lastRx && !readOnly && <button className="btn btn-sm" onClick={() => setRx(lastRx.map(({ id, encounterId, tenantId, sortOrder, dispensed, ...i }: any) => i))}><Icon name="spark" className="h-3.5 w-3.5 text-clay" />Repeat last Rx</button>}
              {!readOnly && <button className="btn btn-sm btn-primary ml-auto" onClick={() => setRx([...rx, { name: '' }])}><Icon name="plus" className="h-3.5 w-3.5" />Medicine</button>}</div>
            {priorMeds.size > 0 && (
              <div className="mb-3 rounded-xl bg-paper p-3">
                <div className="text-[11px] uppercase tracking-wider text-muted mb-1.5">Given before · click to add again</div>
                <div className="flex flex-wrap gap-1.5">{[...priorMeds.entries()].map(([name, at]) => { const inRx = rx.some((r) => r.name === name); return (
                  <button key={name} type="button" disabled={readOnly || inRx} onClick={() => addRx(name)} className={`toggle-opt ${inRx ? 'on' : ''}`} title={inRx ? 'already in this prescription' : 'add'}>{name} <span className={inRx ? 'opacity-70' : 'text-muted'}>· {fmtDate(at)}</span></button>); })}</div>
              </div>
            )}
            <datalist id="meds">{cfg?.medicines.map((m: any) => <option key={m.id} value={m.name} />)}</datalist>
            <datalist id="freq">{FREQ.map((x) => <option key={x} value={x} />)}</datalist>
            {rx.length === 0 ? <div className="text-sm text-muted border border-dashed border-line rounded-xl p-4 text-center">No medicines yet. Start typing a name; defaults fill in from the catalogue.</div> : (
              <div className="space-y-2">
                <div className="grid grid-cols-[1fr_90px_150px_64px_1fr_32px] gap-2 text-[11px] uppercase tracking-wider text-muted px-1"><span>Medicine</span><span>Dose</span><span>Frequency</span><span>Days</span><span>Instructions</span><span /></div>
                {rx.map((i, k) => { const before = priorMeds.get(i.name); return (
                  <div key={k} className="anim-fade-up">
                    <div className="grid grid-cols-[1fr_90px_150px_64px_1fr_32px] gap-2">
                      <input list="meds" className="input" placeholder="Medicine" value={i.name} disabled={readOnly} onChange={(ev) => {
                        const m = cfg?.medicines.find((x: any) => x.name === ev.target.value);
                        setRx(rx.map((r, j) => j === k ? { ...r, name: ev.target.value, medicineId: m?.id ?? null, ...(m ? { dose: m.defaults?.dose, route: m.defaults?.route, frequency: m.defaults?.frequency, durationDays: m.defaults?.durationDays, instructions: m.defaults?.instructions } : {}) } : r));
                      }} />
                      <input className="input" value={i.dose ?? ''} disabled={readOnly} onChange={(ev) => setRx(rx.map((r, j) => j === k ? { ...r, dose: ev.target.value } : r))} />
                      <input list="freq" className="input" value={i.frequency ?? ''} disabled={readOnly} onChange={(ev) => setRx(rx.map((r, j) => j === k ? { ...r, frequency: ev.target.value } : r))} />
                      <input type="number" className="input" value={i.durationDays ?? ''} disabled={readOnly} onChange={(ev) => setRx(rx.map((r, j) => j === k ? { ...r, durationDays: ev.target.value ? Number(ev.target.value) : undefined } : r))} />
                      <input className="input" value={i.instructions ?? ''} disabled={readOnly} onChange={(ev) => setRx(rx.map((r, j) => j === k ? { ...r, instructions: ev.target.value } : r))} />
                      {!readOnly ? <button className="btn btn-ghost btn-icon" onClick={() => setRx(rx.filter((_, j) => j !== k))}><Icon name="x" className="h-3.5 w-3.5" /></button> : <span />}
                    </div>
                    {before && <div className="text-[11px] text-amber mt-1 px-1 flex items-center gap-1"><Icon name="clock" className="h-3 w-3" />Prescribed before on {fmtDate(before)}</div>}
                  </div>); })}
              </div>
            )}
          </div>

          <div className="card anim-fade-up" style={{ animationDelay: '320ms' }}>
            <div className="flex items-center gap-2 mb-3 flex-wrap"><div className="serif text-lg">Plan</div>
              {!readOnly && <div className="ml-auto flex gap-1 flex-wrap">
                {[7, 14, 30].map((d) => <button key={d} className={`toggle-opt ${recs.some((r) => r.kind === 'followup' && r.intervalDays === d) ? 'on' : ''}`} onClick={() => setRecs([...recs.filter((r) => r.kind !== 'followup'), { kind: 'followup', intervalDays: d }])}>Review in {d}d</button>)}
                <button className="toggle-opt" onClick={() => setRecs([...recs, { kind: 'procedure', procedureId: cfg?.procedures[0]?.id, sittings: cfg?.procedures[0]?.typicalSittings }])}><Icon name="plus" className="h-3 w-3 inline -mt-0.5" /> Procedure</button>
                <button className="toggle-opt" onClick={() => setRecs([...recs, { kind: 'investigation', notes: '' }])}><Icon name="plus" className="h-3 w-3 inline -mt-0.5" /> Test</button></div>}</div>
            <datalist id="tests">{TESTS.map((x) => <option key={x} value={x} />)}</datalist>
            {recs.length === 0 ? <div className="text-sm text-muted">No follow-up, procedure or test. Reception, the coordinator and the lab desk see exactly what you add here.</div> :
              recs.map((r, k) => (
                <div key={k} className="flex items-center gap-2 text-sm py-2 border-t border-line first:border-t-0 flex-wrap anim-fade-up">
                  <Chip tone={r.kind === 'followup' ? 'amber' : r.kind === 'procedure' ? 'sky' : 'clay'}>{r.kind === 'followup' ? 'follow-up' : r.kind === 'procedure' ? 'procedure' : 'test'}</Chip>
                  {r.kind === 'followup' && <span className="flex items-center gap-1">Review in <input type="number" className="input !w-16 !py-1" value={r.intervalDays ?? ''} disabled={readOnly} onChange={(ev) => setRecs(recs.map((x, j) => j === k ? { ...x, intervalDays: Number(ev.target.value), dueOn: undefined } : x))} /> days{r.dueOn && <span className="text-muted">(due {fmtDate(r.dueOn)})</span>}</span>}
                  {r.kind === 'procedure' && <><select className="input !w-auto !py-1" value={r.procedureId ?? ''} disabled={readOnly} onChange={(ev) => { const pr = cfg.procedures.find((x: any) => x.id === ev.target.value); setRecs(recs.map((x, j) => j === k ? { ...x, procedureId: ev.target.value, sittings: pr?.typicalSittings } : x)); }}>{cfg?.procedures.map((pr: any) => <option key={pr.id} value={pr.id}>{pr.name}</option>)}</select>
                    <input type="number" className="input !w-16 !py-1" value={r.sittings ?? ''} disabled={readOnly} onChange={(ev) => setRecs(recs.map((x, j) => j === k ? { ...x, sittings: Number(ev.target.value) } : x))} /><span className="text-muted">sittings</span></>}
                  {r.kind === 'investigation' ? <input list="tests" className="input flex-1 min-w-40 !py-1" placeholder="Test name, e.g. CBC" value={r.notes ?? ''} disabled={readOnly} onChange={(ev) => setRecs(recs.map((x, j) => j === k ? { ...x, notes: ev.target.value } : x))} />
                    : <input className="input flex-1 min-w-40 !py-1" placeholder="notes for the coordinator" value={r.notes ?? ''} disabled={readOnly} onChange={(ev) => setRecs(recs.map((x, j) => j === k ? { ...x, notes: ev.target.value } : x))} />}
                  {!readOnly && <button className="btn btn-ghost btn-icon" onClick={() => setRecs(recs.filter((_, j) => j !== k))}><Icon name="x" className="h-3.5 w-3.5" /></button>}
                </div>
              ))}
          </div>
        </>)}

        <div className="sticky bottom-20 md:bottom-4 z-10 anim-fade-up" style={{ animationDelay: '380ms' }}>
          <div className="card !py-3 flex items-center gap-2 flex-wrap" style={{ boxShadow: 'var(--shadow-lift)' }}>
            <button className="btn btn-ghost" onClick={() => nav('/queue', { viewTransition: true })}><Icon name="chevL" />Queue</button>
            {errors.length > 0 && <span className="text-xs text-rose">{errors.length} required field{errors.length > 1 ? 's' : ''} missing</span>}
            <span className="ml-auto" />
            {!readOnly && <button className="btn" disabled={save.isPending} onClick={() => save.mutate(false)}>{me.role === 'assistant' ? 'Save intake & return to queue' : 'Save draft'}</button>}
            {!readOnly && isDoctor && <button className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate(true)}><Icon name="print" />Complete & print Rx</button>}
            {readOnly && <button className="btn btn-primary" onClick={() => window.open(`/print/${id}`, '_blank')}><Icon name="print" />Print Rx</button>}
          </div>
        </div>
      </section>
      {viewing && <EncounterModal id={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

/** Tags: several free-text values, Enter or comma adds; suggestions from options. */
function TagsInput({ value, onChange, options, placeholder, disabled, invalid }: { value: string[]; onChange: (v: string[]) => void; options?: string[]; placeholder?: string; disabled: boolean; invalid?: boolean }) {
  const [draft, setDraft] = useState('');
  const listId = 'tags-' + (placeholder ?? '').replace(/\W/g, '').slice(0, 12);
  const add = (s: string) => { const v = s.trim(); if (v && !value.includes(v)) onChange([...value, v]); setDraft(''); };
  return (
    <div className={`input flex flex-wrap items-center gap-1.5 !py-1.5 ${invalid ? '!border-rose' : ''} ${disabled ? 'bg-paper' : ''}`} onClick={(e) => (e.currentTarget.querySelector('input') as HTMLInputElement)?.focus()}>
      {value.map((t) => <span key={t} className="chip chip-clay !text-xs !py-1 anim-scale-in">{t}{!disabled && <button type="button" className="ml-0.5 hover:text-ink" onClick={() => onChange(value.filter((x) => x !== t))}><Icon name="x" className="h-3 w-3" /></button>}</span>)}
      {!disabled && <input list={listId} className="flex-1 min-w-32 bg-transparent outline-none text-sm py-0.5" placeholder={value.length ? 'Add another…' : placeholder} value={draft}
        onChange={(e) => { if (options?.includes(e.target.value)) add(e.target.value); else setDraft(e.target.value); }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(draft); } else if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1)); }}
        onBlur={() => draft && add(draft)} />}
      {options && <datalist id={listId}>{options.filter((o) => !value.includes(o)).map((o) => <option key={o} value={o} />)}</datalist>}
    </div>
  );
}

function FieldInput({ f, value, onChange, disabled, invalid }: { f: Field; value: any; onChange: (v: any) => void; disabled: boolean; invalid?: boolean }) {
  const cls = `input ${invalid ? '!border-rose' : ''}`;
  if (f.type === 'tags') return <TagsInput value={asList(value)} onChange={onChange} options={f.options} placeholder={f.placeholder} disabled={disabled} invalid={invalid} />;
  if (f.type === 'textarea') return <textarea className={`${cls} min-h-20`} value={value ?? ''} placeholder={f.placeholder} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
  if (f.type === 'select') return <div className="flex flex-wrap gap-1.5">{f.options!.map((o) => <button type="button" key={o} disabled={disabled} className={`toggle-opt ${value === o ? 'on' : ''}`} onClick={() => onChange(value === o ? undefined : o)}>{o}</button>)}</div>;
  if (f.type === 'multiselect') { const v: string[] = value ?? []; return <div className="flex flex-wrap gap-1.5">{f.options!.map((o) => <button type="button" key={o} disabled={disabled} className={`toggle-opt ${v.includes(o) ? 'on' : ''}`} onClick={() => onChange(v.includes(o) ? v.filter((x) => x !== o) : [...v, o])}>{o}</button>)}</div>; }
  if (f.type === 'number') return <input type="number" className={cls} value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} />;
  if (f.type === 'date') return <input type="date" className={cls} value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
  return <input className={cls} value={value ?? ''} placeholder={f.placeholder} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
}
