// One procedure session as a full page: the clinic's form for this procedure (Before / During / After), "Last time" beside
// each field, products from the pharmacy, consent and photos. Values save as they are typed; Mark done checks the required ones.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useOutletContext, useParams } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { get, patch, post, put, qc, today, errText, useConfig } from '../api';
import { can } from '../App';
import { BackButton, Chip, Icon, Skeleton, ask, toast, fmtDate } from '../ui';
import { ConsentDialog, ConsentChip, ConsentNote, confirmDone } from '../procDrawer';
import { PhotoCapture, usePhotos } from '../photos';
import { FieldInput, missingRequired, showValue, spanOf, type FormField, type FormSchema } from '../procForm';

const STATE: Record<string, [string, '' | 'sage' | 'amber' | 'rose' | 'sky']> = { confirmed: ['Booked', 'sky'], in_progress: ['In progress', 'amber'], completed: ['Completed', 'sage'], missed: ['No show', 'rose'], cancelled: ['Cancelled', 'rose'], postponed: ['Postponed', 'amber'] };
const filled = (f: FormField, v: unknown) => (f.type === 'checkbox' ? v === true : v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length));

export function ProcSessionPage() {
  const { id = '' } = useParams(); const nav = useNavigate();
  const { perms } = useOutletContext<any>(); const cfg = useConfig().data;
  const canAct = can(perms, 'worklist.write') || can(perms, 'encounter.complete');
  const q = useQuery({ queryKey: ['procedure-session', id], queryFn: () => get(`/procedure-sessions/${id}`) });
  const s = q.data; const schema: FormSchema | null = s?.form?.schema ?? null;
  const sections = (schema?.sections ?? []).filter((x) => x.key !== 'consult');
  const last: Record<string, unknown> = s?.earlier?.[0]?.outcome ?? {};

  // the values on screen: what is saved, plus "start with last session's value" fields still empty on a session not yet done
  const [vals, setVals] = useState<Record<string, unknown> | null>(null);
  const [state, setSaveState] = useState<'saved' | 'saving' | 'dirty'>('saved');
  useEffect(() => {
    if (!s || vals) return;
    const v: Record<string, unknown> = { ...(s.outcome ?? {}) };
    if (s.state !== 'completed') for (const f of sections.flatMap((x) => x.fields)) if (f.carry && !filled(f, v[f.key]) && filled(f, last[f.key])) v[f.key] = last[f.key];
    setVals(v); if (JSON.stringify(v) !== JSON.stringify(s.outcome ?? {})) setSaveState('dirty');
  }, [s]);
  const editable = canAct && !!s && !['cancelled', 'postponed', 'missed'].includes(s.state);
  const save = async (v = vals) => {
    if (!v || !schema || !editable) return true;
    setSaveState('saving');
    try { await put(`/procedure-sessions/${id}/form`, { values: v }); setSaveState('saved'); qc.invalidateQueries({ queryKey: ['plan-form'] }); return true; }
    catch (e) { setSaveState('dirty'); toast(errText(e), 'err'); return false; }
  };
  // save a moment after typing stops
  const timer = useRef<number | undefined>(undefined);
  const set = (k: string, v: unknown) => { setVals((x) => { const n = { ...x, [k]: v }; window.clearTimeout(timer.current); timer.current = window.setTimeout(() => save(n), 900); return n; }); setSaveState('dirty'); };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => { if (state === 'saved') return; const w = (e: BeforeUnloadEvent) => e.preventDefault(); window.addEventListener('beforeunload', w); return () => window.removeEventListener('beforeunload', w); }, [state]);

  const refresh = () => ['procedure-session', 'calendar', 'psessions', 'pcounts', 'worklist', 'pharmacy', 'plan-form'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  const [signing, setSigning] = useState(false);
  const setStateM = useMutation({ mutationFn: (b: any) => patch(`/procedure-sessions/${id}`, b),
    onSuccess: (_r, b: any) => { setSigning(false); refresh(); toast(b.state === 'completed' ? 'Session marked done' : 'Session started'); }, onError: (e) => toast(errText(e), 'err') });
  const missing = schema && vals ? missingRequired(schema, vals) : [];
  const waiting = (s?.supplies ?? []).filter((a: any) => a.status === 'asked');
  const markDone = async () => {
    window.clearTimeout(timer.current);
    if (!(await save())) return;
    if (missing.length) { toast(`Fill these first: ${missing.join(', ')}.`, 'err'); document.getElementById(`f-${sections.flatMap((x) => x.fields).find((f) => missing.includes(f.label))?.key}`)?.focus(); return; }
    if (waiting.length && !(await ask({ title: 'The pharmacy has not issued everything yet', body: `${waiting.flatMap((a: any) => a.lines.map((l: any) => `${l.name} × ${l.qty}`)).join(', ')} is still asked for. Mark done anyway?`, confirmLabel: 'Mark done anyway', cancelLabel: 'Wait' }))) return;
    if (await confirmDone({ ...s, of: s.plan?.sittings })) setStateM.mutate({ state: 'completed' });
  };

  // asking the pharmacy for more
  const [adding, setAdding] = useState(false); const [addMed, setAddMed] = useState(''); const [addQty, setAddQty] = useState('1');
  const askMore = useMutation({ mutationFn: () => post(`/procedure-sessions/${id}/supplies`, { lines: [{ medicineId: addMed, qty: Math.max(1, Number(addQty) || 1) }] }),
    onSuccess: () => { setAdding(false); setAddMed(''); setAddQty('1'); refresh(); toast('Sent to the pharmacy'); }, onError: (e) => toast(errText(e), 'err') });

  const photos = usePhotos(s?.patient?.id ?? '');
  const mine: any[] = (photos.data?.photos ?? []).filter((x: any) => (x.sitting?.id ?? x.procedureSessionId) === id);
  const [shoot, setShoot] = useState<'before' | 'after' | null>(null);
  const history = useMemo(() => (s?.earlier ?? []).slice().reverse(), [s]); // oldest first, for "was 16, 16, 18"

  if (q.isError) return <div className="p-6 text-sm text-rose">Couldn't load. {errText(q.error)} <button className="btn btn-sm ml-1" onClick={() => q.refetch()}>Retry</button></div>;
  if (!s || !vals) return <Skeleton rows={8} />;
  const p = s.patient; const [stLabel, stTone] = STATE[s.state] ?? [s.state, ''];
  const label = `${s.procedure ?? 'Procedure'} · session ${s.sittingNo}${s.plan?.sittings ? ` of ${s.plan.sittings}` : ''}`;
  const secTag = (fields: FormField[]) => {
    const req = fields.filter((f) => f.required); const left = req.filter((f) => !filled(f, vals[f.key])).length; const any = fields.some((f) => filled(f, vals[f.key]));
    return left ? <Chip tone="amber">{left} required left</Chip> : any ? <Chip tone="sage">Done</Chip> : <Chip>Not started</Chip>;
  };

  return (
    <div className="-mx-4 -my-4 flex min-h-[calc(100vh-64px)] flex-col sm:-mx-6 lg:-mx-8">
      <header className="flex flex-wrap items-center gap-3 border-b border-line bg-surface px-4 py-3 sm:px-6">
        <BackButton to={`/patients/${p.id}?sec=plans`} />
        <div className="min-w-0 flex-1">
          <h1 className="text-[17px] font-semibold"><Link to={`/patients/${p.id}`} className="hover:underline">{p.fullName}</Link> <span className="text-[13px] font-normal text-muted">· {[p.patientNo, [p.ageYears, p.sex].filter(Boolean).join(' ')].filter(Boolean).join(' · ')}</span></h1>
          <p className="text-[12.5px] text-muted">{label}{s.room ? ` · ${s.room}` : ''}{s.doctor ? ` · ${s.doctor}` : ''} · {s.day === today() ? 'Today' : fmtDate(s.day)} {s.startTime}</p>
        </div>
        {p.allergies && <Chip tone="rose">Allergy: {p.allergies}</Chip>}
        <Chip tone={stTone}>{stLabel}</Chip>
        {schema && editable && <span className="text-[12px] text-muted" aria-live="polite">{state === 'saving' ? 'Saving…' : state === 'dirty' ? 'Not saved yet' : 'Saved'}</span>}
        {canAct && s.state === 'confirmed' && s.day === today() && <button className="btn btn-primary" disabled={setStateM.isPending} onClick={() => (s.consentNeeded ? setSigning(true) : setStateM.mutate({ state: 'in_progress' }))}><Icon name="check" className="h-4 w-4" />Start session</button>}
        {canAct && s.state === 'in_progress' && <button className="btn btn-primary" disabled={setStateM.isPending} onClick={markDone}><Icon name="check" className="h-4 w-4" />Mark done</button>}
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-4 p-3 sm:p-5 lg:flex-row">
        <main className="min-w-0 flex-1 space-y-3">
          {!schema ? <div className="card-flat p-5 text-[14px]"><b>No form for {s.procedure ?? 'this procedure'} yet.</b>
            <p className="mt-1 text-muted">The clinic sets up what to record (settings, products used, the patient's response) once, and it shows here for every session.</p>
            {can(perms, 'config.write') && s.procedureId && <button type="button" className="btn btn-primary mt-3" onClick={() => nav(`/settings/procedures/${s.procedureId}/form`)}>Set up the form</button>}</div>
            : sections.map((sec) => (
              <section key={sec.key} className="card-flat space-y-2 p-4">
                <div className="flex items-center gap-2"><h2 className="text-[14px] font-semibold">{sec.title}</h2>{secTag(sec.fields)}</div>
                <div className="grid grid-cols-1 gap-x-3 gap-y-2 sm:grid-cols-4">
                  {sec.fields.map((f) => { const was = history.map((h: any) => h.outcome?.[f.key]).filter((v: unknown) => filled(f, v));
                    return (
                      <div key={f.key} className={`${spanOf(f)} p-1`}>
                        <label id={`f-${f.key}-l`} htmlFor={`f-${f.key}`} className="label">{f.label}{f.required && <span className="text-rose" aria-label="required"> *</span>}</label>
                        <FieldInput f={f} id={`f-${f.key}`} readOnly={!editable} value={vals[f.key]} onChange={(v) => set(f.key, v)} />
                        {f.help && <p className="mt-1 text-[12px] text-muted">{f.help}</p>}
                        {filled(f, last[f.key]) && <p className="mt-1 text-[11.5px] text-ink-2">Last time: {showValue(f, last[f.key])}{f.type === 'number' && was.length > 1 ? ` · was ${was.slice(0, -1).slice(-3).join(', ')}` : ''}</p>}
                      </div>);
                  })}
                </div>
              </section>))}
        </main>

        <aside className="shrink-0 space-y-3 lg:w-[330px]">
          <section className="card-flat space-y-2.5 p-4">
            <div className="flex items-center gap-2"><h2 className="flex-1 text-[14px] font-semibold">Products from pharmacy</h2>
              {s.supplies.length > 0 && (waiting.length ? <Chip tone="amber">Waiting for pharmacy</Chip> : <Chip tone="sage">Issued</Chip>)}</div>
            {s.supplies.length === 0 && <p className="text-[13px] text-muted">Nothing asked for yet.{schema?.products?.length && s.state === 'confirmed' ? ' The usual products are asked for when the session starts.' : ''}</p>}
            {s.supplies.map((a: any) => <div key={a.id} className="space-y-1.5 border-t border-line/60 pt-2 text-[13px] first:border-t-0 first:pt-0">
              {a.status === 'issued' ? a.issued.map((x: any, i: number) => <div key={i} className="flex gap-2"><div className="min-w-0 flex-1"><b className="font-semibold">{x.name}</b><div className="text-[12px] text-muted">Batch {x.batchNo} · exp {new Date(x.expiry + 'T00:00:00').toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })}</div></div><span>× {x.qty}</span></div>)
                : a.lines.map((l: any) => <div key={l.medicineId} className="flex gap-2"><span className="min-w-0 flex-1 font-semibold">{l.name}</span><span>× {l.qty}</span></div>)}
              <div className="text-[12px] text-muted">{a.status === 'issued' ? `Issued by ${a.doneBy}` : a.status === 'none' ? <span className="text-rose">Not given: {a.note}</span> : `Asked by ${a.by} · waiting for the pharmacy`}</div>
            </div>)}
            {editable && (adding ? <div className="flex flex-wrap gap-2">
              <select className="input min-w-0 flex-1" aria-label="Product" value={addMed} onChange={(e) => setAddMed(e.target.value)}><option value="">Choose a product</option>{(cfg?.medicines ?? []).filter((m: any) => m.active !== false).map((m: any) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
              <input className="input !w-16" aria-label="Quantity" inputMode="numeric" value={addQty} onChange={(e) => setAddQty(e.target.value.replace(/\D/g, ''))} />
              <button type="button" className="btn btn-primary btn-sm" disabled={!addMed || askMore.isPending} onClick={() => askMore.mutate()}>Ask</button><button type="button" className="btn btn-ghost btn-sm" onClick={() => setAdding(false)}>Cancel</button></div>
              : <button type="button" className="btn btn-sm w-full justify-start border-dashed" onClick={() => setAdding(true)}><Icon name="plus" className="h-3.5 w-3.5" />Ask pharmacy for more</button>)}
            <p className="text-[12px] text-muted">No bill: covered by the procedure price.</p>
          </section>

          <section className="card-flat space-y-1.5 p-4"><div className="flex items-center gap-2"><h2 className="flex-1 text-[14px] font-semibold">Consent</h2>{s.consentNeeded || s.consent ? <ConsentChip s={s} /> : <span className="text-[12.5px] text-muted">Not needed</span>}</div>
            {s.consent && <ConsentNote c={s.consent} />}{s.consentNeeded && <p className="text-[12.5px] text-muted">Asked when the session starts.</p>}</section>

          <section className="card-flat space-y-2 p-4"><div className="flex items-center gap-2"><h2 className="flex-1 text-[14px] font-semibold">Photos</h2><Link className="text-[12.5px] text-clay underline" to={`/patients/${p.id}?sec=photos`}>Compare</Link></div>
            <p className="text-[12.5px] text-muted">{mine.length ? `${mine.length} photo${mine.length === 1 ? '' : 's'} of this session` : 'None of this session yet'}</p>
            {canAct && ['confirmed', 'in_progress', 'completed'].includes(s.state) && <div className="flex gap-2"><button type="button" className="btn btn-sm" onClick={() => setShoot('before')}><Icon name="spark" className="h-3.5 w-3.5" />Before</button>{s.state !== 'confirmed' && <button type="button" className="btn btn-sm" onClick={() => setShoot('after')}><Icon name="spark" className="h-3.5 w-3.5" />After</button>}</div>}</section>

          {s.plan && <section className="card-flat space-y-1 p-4"><h2 className="text-[14px] font-semibold">The plan</h2>
            <p className="text-[13px] text-ink-2">{[s.plan.diagnosis?.length ? `For ${s.plan.diagnosis.join(', ')}` : null, s.plan.sittings ? `${s.plan.sittings} sessions` : null, s.plan.plannedOn ? `advised ${fmtDate(String(s.plan.plannedOn).slice(0, 10))}` : null].filter(Boolean).join(' · ')}</p>
            {s.plan.notes && <p className="rounded-[8px] bg-surface-2 px-3 py-2 text-[13px]">{s.plan.notes}</p>}</section>}
        </aside>
      </div>
      {signing && <ConsentDialog s={s} onClose={() => setSigning(false)} onStart={(b) => setStateM.mutate(b)} />}
      {shoot && <PhotoCapture patient={{ id: p.id, fullName: p.fullName }} sitting={{ id, label: `${label} · ${shoot}` }} phase={shoot} onClose={() => { setShoot(null); qc.invalidateQueries({ queryKey: ['photos', p.id] }); }} />}
    </div>
  );
}
