// Procedure forms on the web: one field renderer for the builder (as the doctor will see it) and the session page.
import type { FormField, FormSchema } from '../../src/db/schema.js';
export { missingRequired, valuesLine } from '../../src/lib/procForm.js';
export type { FormField, FormSchema };

/** The field types the admin can drag in, in the words they see. */
export const FIELD_TYPES: { type: FormField['type']; label: string; glyph: string }[] = [
  { type: 'number', label: 'Number', glyph: '#' },
  { type: 'select', label: 'Pick one (list)', glyph: '▾' },
  { type: 'chips', label: 'Pick one (buttons)', glyph: '◉' },
  { type: 'multiselect', label: 'Pick several', glyph: '☷' },
  { type: 'checkbox', label: 'Yes / No', glyph: '☑' },
  { type: 'text', label: 'Short text', glyph: 'Aa' },
  { type: 'textarea', label: 'Long text', glyph: '¶' },
  { type: 'date', label: 'Date', glyph: '▤' },
];
export const typeLabel = (t: string) => FIELD_TYPES.find((x) => x.type === t)?.label ?? t;
export const hasOptions = (t: string) => t === 'select' || t === 'chips' || t === 'multiselect';
/** Quarters of the row on a wide screen; full width on a phone. */
export const SPAN: Record<number, string> = { 1: 'sm:col-span-1', 2: 'sm:col-span-2', 3: 'sm:col-span-3', 4: 'sm:col-span-4' };
export const spanOf = (f: FormField) => SPAN[f.width ?? (f.type === 'textarea' || f.type === 'multiselect' ? 2 : 1)];

/** A new field of a type, with a stable key (renaming it later keeps old values readable). */
export function newField(type: FormField['type'], label?: string): FormField {
  const name = label ?? typeLabel(type);
  const key = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24) || 'field'}_${Math.random().toString(36).slice(2, 6)}`;
  return { key, label: name, type, ...(hasOptions(type) ? { options: ['Option 1', 'Option 2'] } : {}), ...(type === 'textarea' || type === 'multiselect' ? { width: 2 as const } : {}) };
}

/** A starting form: the three sections every procedure has. */
export const EMPTY_FORM: FormSchema = { sections: [{ key: 'before', title: 'Before', fields: [] }, { key: 'during', title: 'During', fields: [] }, { key: 'after', title: 'After', fields: [] }], products: [] };

/** "18 J/cm²", "Upper lip, Chin", "Yes" */
export const showValue = (f: FormField, v: unknown) => v === undefined || v === null || v === '' ? '' : v === true ? 'Yes' : v === false ? 'No' : Array.isArray(v) ? v.join(', ') : `${v}${f.type === 'number' && f.unit ? ` ${f.unit}` : ''}`;

/** One field, as the doctor fills it. In the builder it is shown with readOnly. */
export function FieldInput({ f, value, onChange, readOnly, id }: { f: FormField; value: unknown; onChange: (v: unknown) => void; readOnly?: boolean; id: string }) {
  const opts = f.options ?? [];
  if (f.type === 'chips' || f.type === 'multiselect') {
    const many = f.type === 'multiselect'; const on = (o: string) => (many ? Array.isArray(value) && value.includes(o) : value === o);
    return <div className="flex flex-wrap gap-1" role="group" aria-labelledby={`${id}-l`}>
      {opts.map((o) => <button key={o} type="button" disabled={readOnly} aria-pressed={on(o)} className={`toggle-opt ${on(o) ? 'on' : ''}`}
        onClick={() => onChange(many ? (on(o) ? (value as string[]).filter((x) => x !== o) : [...(Array.isArray(value) ? value : []), o]) : on(o) ? '' : o)}>{o}</button>)}
    </div>;
  }
  if (f.type === 'checkbox') return <label className="flex h-9 items-center gap-2 text-[14px]"><input id={id} type="checkbox" className="h-4 w-4 accent-clay" disabled={readOnly} checked={value === true} onChange={(e) => onChange(e.target.checked)} />Yes</label>;
  if (f.type === 'select') return <select id={id} className="input" disabled={readOnly} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}><option value="">Choose</option>{opts.map((o) => <option key={o}>{o}</option>)}</select>;
  if (f.type === 'textarea') return <textarea id={id} className="input min-h-[64px]" readOnly={readOnly} value={String(value ?? '')} placeholder={f.placeholder} onChange={(e) => onChange(e.target.value)} />;
  if (f.type === 'number') return <div className="relative"><input id={id} className={`input ${f.unit ? 'pr-16' : ''}`} inputMode="decimal" readOnly={readOnly} value={value === undefined || value === null ? '' : String(value)}
    onChange={(e) => { const t = e.target.value.replace(/[^0-9.\-]/g, ''); onChange(t); }} />{f.unit && <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[12.5px] text-muted">{f.unit}</span>}</div>;
  return <input id={id} className="input" type={f.type === 'date' ? 'date' : 'text'} readOnly={readOnly} value={String(value ?? '')} placeholder={f.placeholder} onChange={(e) => onChange(e.target.value)} />;
}
