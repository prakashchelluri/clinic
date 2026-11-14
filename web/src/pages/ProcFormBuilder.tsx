// Settings › Procedures & packages › a procedure › Form. The builder is the form itself: drag a field type onto a section,
// click a field to set its name, unit, width and rules on the right. Saving makes a new version; done sessions keep theirs.
import { useEffect, useMemo, useState } from 'react';
import { useOutletContext, useParams } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { get, post, qc, errText, useConfig } from '../api';
import { can } from '../App';
import { BackButton, Icon, NoAccess, Skeleton, ask, toast, fmtDate } from '../ui';
import { EMPTY_FORM, FIELD_TYPES, FieldInput, hasOptions, newField, spanOf, typeLabel, type FormField, type FormSchema } from '../procForm';

type Sel = { s: number; f: number } | null;
const DRAG = 'text/cubott-field';

export function ProcFormBuilder() {
  const { id = '' } = useParams();
  const { perms } = useOutletContext<any>(); const cfg = useConfig().data;
  const saved = useQuery({ queryKey: ['proc-form', id], queryFn: () => get(`/admin/procedures/${id}/form`), enabled: can(perms, 'config.write') });
  const [form, setForm] = useState<FormSchema | null>(null);
  const [sel, setSel] = useState<Sel>(null);
  const [trying, setTrying] = useState(false); const [tryVals, setTryVals] = useState<Record<string, unknown>>({});
  const [dirty, setDirty] = useState(false);
  const [over, setOver] = useState<string | null>(null); // the drop spot under the pointer: "s:f" or "s:end"
  useEffect(() => { if (saved.data && !form) setForm(saved.data.schema ?? structuredClone(EMPTY_FORM)); }, [saved.data]);
  useEffect(() => { if (!dirty) return; const w = (e: BeforeUnloadEvent) => e.preventDefault(); window.addEventListener('beforeunload', w); return () => window.removeEventListener('beforeunload', w); }, [dirty]);

  const proc = cfg?.procedures?.find((p: any) => p.id === id);
  const others: any[] = (cfg?.procedures ?? []).filter((p: any) => p.id !== id && p.active !== false);
  const meds: any[] = cfg?.medicines ?? [];
  const edit = (fn: (f: FormSchema) => void) => { setForm((cur) => { const next = structuredClone(cur!); fn(next); return next; }); setDirty(true); };
  const field: FormField | null = sel && form ? form.sections[sel.s]?.fields[sel.f] ?? null : null;
  const setField = (patch: Partial<FormField>) => sel && edit((f) => { Object.assign(f.sections[sel.s].fields[sel.f], patch); });

  const save = useMutation({ mutationFn: () => post(`/admin/forms/procedure:${id}`, clean(form!)),
    onSuccess: (r: any) => { setDirty(false); qc.invalidateQueries({ queryKey: ['proc-form', id] }); toast(`Form saved · version ${r.version}`); }, onError: (e) => toast(errText(e), 'err') });

  if (!can(perms, 'config.write')) return <NoAccess what="the procedure form" />;
  if (!form) return <Skeleton rows={6} />;

  // drop a new field type, or move a field, to a section at a position
  const drop = (e: React.DragEvent, s: number, at: number) => {
    e.preventDefault(); setOver(null);
    const d = e.dataTransfer.getData(DRAG); if (!d) return;
    const [kind, a, b] = d.split(':');
    if (kind === 'new') { edit((f) => { f.sections[s].fields.splice(at, 0, newField(a as FormField['type'])); }); setSel({ s, f: at }); return; }
    const fs = Number(a), ff = Number(b);
    edit((f) => { const [x] = f.sections[fs].fields.splice(ff, 1); const pos = fs === s && ff < at ? at - 1 : at; f.sections[s].fields.splice(pos, 0, x); });
    setSel({ s, f: fs === s && ff < at ? at - 1 : at });
  };
  const addTo = (type: FormField['type'], s = sel?.s ?? form.sections.length - 1) => { const at = form.sections[s].fields.length; edit((f) => { f.sections[s].fields.push(newField(type)); }); setSel({ s, f: at }); };
  const addSection = () => { edit((f) => { f.sections.push({ key: `section_${Math.random().toString(36).slice(2, 6)}`, title: 'New section', fields: [] }); }); };
  const removeSection = async (s: number) => {
    const n = form.sections[s].fields.length;
    if (n && !(await ask({ title: `Remove “${form.sections[s].title}” and its ${n} field${n === 1 ? '' : 's'}?`, body: 'Sessions already done keep what they recorded.', confirmLabel: 'Remove', tone: 'danger' }))) return;
    edit((f) => { f.sections.splice(s, 1); }); setSel(null);
  };
  const moveSection = (s: number, by: number) => edit((f) => { const [x] = f.sections.splice(s, 1); f.sections.splice(s + by, 0, x); });
  const copyFrom = async (pid: string) => {
    if (!pid) return;
    const r: any = await get(`/admin/procedures/${pid}/form`).catch((e) => { toast(errText(e), 'err'); return null; });
    if (!r?.schema) { toast('That procedure has no form yet', 'info'); return; }
    const name = others.find((p) => p.id === pid)?.name;
    if (form.sections.some((x) => x.fields.length) && !(await ask({ title: `Replace this form with ${name}'s?`, body: 'You can change anything before saving.', confirmLabel: 'Replace' }))) return;
    setForm(structuredClone(r.schema)); setSel(null); setDirty(true); toast(`Copied from ${name}. Save to keep it.`);
  };
  const products = form.products ?? [];

  return (
    <div className="-mx-4 -my-4 flex min-h-[calc(100vh-64px)] flex-col sm:-mx-6 lg:-mx-8">
      <header className="flex flex-wrap items-center gap-3 border-b border-line bg-surface px-4 py-3 sm:px-6">
        <BackButton to="/settings?tab=procedures" />
        <div className="min-w-0 flex-1">
          <h1 className="text-[17px] font-semibold">{proc?.name ?? 'Procedure'} · Form</h1>
          <p className="text-[12.5px] text-muted">What the doctor sees and fills at each session. {saved.data?.version ? `Version ${saved.data.version}, saved ${fmtDate(String(saved.data.savedAt).slice(0, 10))}. ` : ''}Changes apply to sessions started after you save; done sessions keep theirs.</p>
        </div>
        <select className="input !w-auto" aria-label="Copy from another procedure" value="" onChange={(e) => copyFrom(e.target.value)}>
          <option value="">Copy from another procedure…</option>{others.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <button type="button" className={`btn ${trying ? 'btn-ink' : ''}`} aria-pressed={trying} onClick={() => { setTrying(!trying); setSel(null); setTryVals({}); }}><Icon name="eye" className="h-4 w-4" />{trying ? 'Back to editing' : 'Try it'}</button>
        <button type="button" className="btn btn-primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}><Icon name="check" className="h-4 w-4" />Save form</button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {!trying && <aside aria-label="Add a field" className="flex shrink-0 flex-row flex-wrap gap-2 border-b border-line bg-surface p-3 lg:w-[210px] lg:flex-col lg:flex-nowrap lg:border-b-0 lg:border-r lg:p-4">
          <div className="w-full text-[12.5px] font-semibold text-ink-2">Drag onto the form</div>
          {FIELD_TYPES.map((t) => <button key={t.type} type="button" draggable onDragStart={(e) => { e.dataTransfer.setData(DRAG, `new:${t.type}`); e.dataTransfer.effectAllowed = 'copy'; }} onClick={() => addTo(t.type)}
            className="flex h-10 cursor-grab items-center gap-2.5 rounded-[8px] border border-line bg-surface px-2.5 text-left text-[13px] hover:bg-surface-2 active:cursor-grabbing">
            <span className="grid h-6 w-6 place-items-center rounded-[6px] bg-surface-2 text-[12px] text-ink-2" aria-hidden>{t.glyph}</span>{t.label}</button>)}
          <div className="my-1 hidden h-px bg-line lg:block" />
          <button type="button" className="flex h-10 items-center gap-2.5 rounded-[8px] border border-dashed border-line-2 px-2.5 text-[13px] hover:bg-surface-2" onClick={addSection}><span className="grid h-6 w-6 place-items-center rounded-[6px] bg-surface-2 text-[12px]" aria-hidden>▭</span>New section</button>
          <p className="mt-auto hidden text-[12px] leading-relaxed text-muted lg:block">Or click a type to add it to the section you are in. Drag a field to move it.</p>
        </aside>}

        <main className="min-w-0 flex-1 space-y-3 bg-surface-2 p-3 sm:p-5">
          {trying && <div className="rounded-[10px] bg-sky-soft px-4 py-2.5 text-[13px] text-ink-2">This is how the doctor sees it. Fill it in to try; nothing is saved.</div>}
          {form.sections.map((sec, s) => (
            <section key={sec.key} className="card-flat space-y-2 p-4" onDragOver={(e) => { e.preventDefault(); }} onDrop={(e) => drop(e, s, sec.fields.length)}>
              <div className="flex items-center gap-2">
                {trying ? <h2 className="text-[14px] font-semibold">{sec.title}</h2>
                  : <input aria-label="Section name" className="min-w-0 flex-1 rounded-[6px] bg-transparent px-1 py-0.5 text-[14px] font-semibold outline-none hover:bg-surface-2 focus:bg-surface-2" value={sec.title} onChange={(e) => edit((f) => { f.sections[s].title = e.target.value; })} />}
                {!trying && <span className="flex shrink-0 items-center gap-0.5">
                  <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Move section up" disabled={s === 0} onClick={() => moveSection(s, -1)}><Icon name="up" className="h-3.5 w-3.5" /></button>
                  <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Move section down" disabled={s === form.sections.length - 1} onClick={() => moveSection(s, 1)}><Icon name="up" className="h-3.5 w-3.5 rotate-180" /></button>
                  <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Remove section" disabled={form.sections.length === 1} onClick={() => removeSection(s)}><Icon name="x" className="h-3.5 w-3.5" /></button></span>}
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
                {sec.fields.map((f, i) => { const on = sel?.s === s && sel.f === i; const fid = `b-${sec.key}-${f.key}`;
                  return (
                    <div key={f.key} className={`${spanOf(f)} relative rounded-[8px] p-2 ${trying ? '' : on ? 'cursor-pointer bg-clay-soft/40 ring-2 ring-clay' : 'cursor-pointer ring-1 ring-transparent hover:ring-line-2'} ${over === `${s}:${i}` ? 'before:absolute before:-left-1 before:top-1 before:bottom-1 before:w-1 before:rounded before:bg-clay' : ''}`}
                      draggable={!trying} onDragStart={(e) => { e.dataTransfer.setData(DRAG, `move:${s}:${i}`); e.dataTransfer.effectAllowed = 'move'; }}
                      onDragOver={(e) => { if (trying) return; e.preventDefault(); e.stopPropagation(); setOver(`${s}:${i}`); }} onDragLeave={() => setOver(null)}
                      onDrop={(e) => { e.stopPropagation(); drop(e, s, i); }} onClick={() => !trying && setSel({ s, f: i })}>
                      <label id={`${fid}-l`} htmlFor={fid} className="label">{f.label}{f.required && <span className="text-rose" aria-label="required"> *</span>}</label>
                      <div className={trying ? '' : 'pointer-events-none'}><FieldInput f={f} id={fid} readOnly={!trying} value={trying ? tryVals[f.key] : undefined} onChange={(v) => setTryVals((x) => ({ ...x, [f.key]: v }))} /></div>
                      {f.help && <p className="mt-1 text-[12px] text-muted">{f.help}</p>}
                    </div>);
                })}
                {!trying && <button type="button" onClick={() => { setSel(null); addTo('number', s); }} onDragOver={(e) => { e.preventDefault(); setOver(`${s}:end`); }} onDragLeave={() => setOver(null)}
                  className={`min-h-[64px] rounded-[8px] border-2 border-dashed text-[12.5px] ${over === `${s}:end` ? 'border-clay bg-clay-soft text-clay-ink' : 'border-line-2 text-muted hover:bg-surface-2'}`}>
                  {over === `${s}:end` ? 'Drop here' : '＋ Add field'}</button>}
              </div>
              {!sec.fields.length && !trying && <p className="text-[12.5px] text-muted">Drag a field type here.</p>}
            </section>))}

          <section className="card-flat flex flex-wrap items-center gap-2 p-4">
            <div className="mr-auto"><h2 className="text-[14px] font-semibold">Products from pharmacy</h2><p className="text-[12.5px] text-muted">Asked for when a session starts. The pharmacy issues them with no bill.</p></div>
            {products.map((p, i) => <span key={p.medicineId} className="inline-flex items-center gap-1.5 rounded-[6px] bg-surface-2 px-2 py-1 text-[13px]">{p.name} ×
              <input aria-label={`${p.name} quantity`} className="w-12 rounded border border-line bg-surface px-1 text-center" inputMode="numeric" value={p.qty} disabled={trying}
                onChange={(e) => edit((f) => { f.products![i].qty = Math.max(1, Math.min(999, Number(e.target.value.replace(/\D/g, '')) || 1)); })} />
              {!trying && <button type="button" aria-label={`Remove ${p.name}`} className="text-muted hover:text-ink" onClick={() => edit((f) => { f.products!.splice(i, 1); })}><Icon name="x" className="h-3.5 w-3.5" /></button>}</span>)}
            {!trying && <select className="input !w-auto" aria-label="Add a product" value="" onChange={(e) => { const m = meds.find((x) => x.id === e.target.value); if (m && !products.some((p) => p.medicineId === m.id)) edit((f) => { (f.products ??= []).push({ medicineId: m.id, name: m.name, qty: 1 }); }); }}>
              <option value="">＋ Add a product…</option>{meds.filter((m) => m.active !== false && !products.some((p) => p.medicineId === m.id)).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>}
          </section>
        </main>

        {!trying && <aside aria-label="Field settings" className="shrink-0 border-t border-line bg-surface p-4 lg:w-[290px] lg:border-l lg:border-t-0">
          {field ? <FieldSettings f={field} set={setField} remove={() => { edit((f) => { f.sections[sel!.s].fields.splice(sel!.f, 1); }); setSel(null); }} />
            : <div className="space-y-2 text-[13px] text-muted"><b className="block text-ink">Click a field to change it</b>Its name, unit, choices, width and whether it must be filled before Mark done.</div>}
        </aside>}
      </div>
      {dirty && <div className="sticky bottom-0 flex items-center gap-3 border-t border-line bg-surface px-6 py-2.5 text-[13px]"><span className="flex-1 text-muted">Unsaved changes</span><button type="button" className="btn btn-ghost" onClick={() => { setForm(saved.data?.schema ?? structuredClone(EMPTY_FORM)); setDirty(false); setSel(null); }}>Discard</button><button type="button" className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>Save form</button></div>}
    </div>
  );
}

/** Drop empty choices; a unit only on a number; the server checks the rest. */
function clean(f: FormSchema): FormSchema {
  return { ...f, sections: f.sections.map((s) => ({ ...s, title: s.title.trim() || 'Section', fields: s.fields.map((x) => {
    const { unit, options, ...rest } = x;
    return { ...rest, label: x.label.trim() || typeLabel(x.type), ...(x.type === 'number' && unit?.trim() ? { unit: unit.trim() } : {}), ...(hasOptions(x.type) ? { options: (options ?? []).map((o) => o.trim()).filter(Boolean) } : {}) };
  }) })) };
}

const UNITS = ['mm', 'J/cm²', 'ml', 'units', 'ms', 'Hz', 'nm', '%'];
function FieldSettings({ f, set, remove }: { f: FormField; set: (p: Partial<FormField>) => void; remove: () => void }) {
  const [opts, setOpts] = useState((f.options ?? []).join('\n'));
  useEffect(() => setOpts((f.options ?? []).join('\n')), [f.key]);
  const width = f.width ?? (f.type === 'textarea' || f.type === 'multiselect' ? 2 : 1);
  const sw = (on: boolean, label: string, onChange: (v: boolean) => void) => (
    <label className="flex cursor-pointer items-center gap-2.5 text-[13.5px]"><input type="checkbox" className="peer sr-only" checked={on} onChange={(e) => onChange(e.target.checked)} />
      <span className={`relative h-[18px] w-8 shrink-0 rounded-full transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-clay ${on ? 'bg-ink' : 'bg-line-2'}`} aria-hidden><span className={`absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white transition-all ${on ? 'left-[16px]' : 'left-[2px]'}`} /></span>{label}</label>);
  const types = useMemo(() => FIELD_TYPES, []);
  return (
    <div className="space-y-4">
      <div><label className="label" htmlFor="fs-name">Name</label><input id="fs-name" className="input" value={f.label} maxLength={80} onChange={(e) => set({ label: e.target.value })} /></div>
      <div><label className="label" htmlFor="fs-type">Type</label><select id="fs-type" className="input" value={f.type} onChange={(e) => { const t = e.target.value as FormField['type']; set({ type: t, ...(hasOptions(t) && !f.options?.length ? { options: ['Option 1', 'Option 2'] } : {}) }); }}>{types.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}</select></div>
      {f.type === 'number' && <div><label className="label" htmlFor="fs-unit">Unit</label><input id="fs-unit" className="input" maxLength={20} placeholder="None" value={f.unit ?? ''} onChange={(e) => set({ unit: e.target.value })} />
        <div className="mt-1.5 flex flex-wrap gap-1">{UNITS.map((u) => <button key={u} type="button" className={`toggle-opt !min-h-[26px] !px-2 ${f.unit === u ? 'on' : ''}`} onClick={() => set({ unit: u })}>{u}</button>)}</div></div>}
      {hasOptions(f.type) && <div><label className="label" htmlFor="fs-opts">Choices, one per line</label><textarea id="fs-opts" className="input min-h-[96px]" value={opts}
        onChange={(e) => { setOpts(e.target.value); set({ options: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean) }); }} /></div>}
      <div><span className="label">Width</span><div className="flex gap-0.5 rounded-[7px] bg-surface-2 p-[3px]" role="group" aria-label="Width">
        {([1, 2, 3, 4] as const).map((w) => <button key={w} type="button" aria-pressed={width === w} className={`flex-1 rounded-[5px] py-1 text-[12.5px] ${width === w ? 'bg-surface font-semibold shadow-sm' : 'text-ink-2'}`} onClick={() => set({ width: w })}>{w === 4 ? 'Full' : ['¼', '½', '¾'][w - 1]}</button>)}</div></div>
      <div><label className="label" htmlFor="fs-help">Help text</label><input id="fs-help" className="input" maxLength={200} placeholder="Shown under the field" value={f.help ?? ''} onChange={(e) => set({ help: e.target.value || undefined })} /></div>
      <div className="space-y-3 pt-1">
        {sw(!!f.required, 'Must fill before Mark done', (v) => set({ required: v || undefined }))}
        {sw(!!f.carry, "Start with last session's value", (v) => set({ carry: v || undefined }))}
      </div>
      <button type="button" className="btn w-full justify-center text-rose" onClick={remove}><Icon name="x" className="h-4 w-4" />Remove field</button>
    </div>
  );
}
