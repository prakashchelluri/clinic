import type { FormSchema, FormField } from '../db/schema.js';

/** Section keys of a procedure form. 'consult' is filled on the Rx pad, never on the session page. */
export const SESSION_SECTIONS = (s: FormSchema) => s.sections.filter((x) => x.key !== 'consult');

const empty = (f: FormField, v: unknown) =>
  f.type === 'checkbox' ? v !== true : v === undefined || v === null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length);

/** Labels of required session fields that are still empty. A required Yes / No must be ticked. */
export function missingRequired(s: FormSchema | null | undefined, values: Record<string, unknown> | null | undefined): string[] {
  if (!s) return [];
  const v = values ?? {};
  return SESSION_SECTIONS(s).flatMap((x) => x.fields.filter((f) => f.required && empty(f, v[f.key])).map((f) => f.label));
}

/** Only the form's own fields, each in its own shape; anything else is dropped. */
export function cleanValues(s: FormSchema, values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of SESSION_SECTIONS(s).flatMap((x) => x.fields)) {
    const v = values[f.key];
    if (v === undefined || v === null || v === '') continue;
    if (f.type === 'checkbox') out[f.key] = v === true;
    else if (f.type === 'number') { const n = Number(v); if (Number.isFinite(n)) out[f.key] = n; }
    else if (f.type === 'multiselect' || f.type === 'tags') { if (Array.isArray(v)) out[f.key] = v.map(String).filter(Boolean).slice(0, 40); }
    else out[f.key] = String(v).slice(0, 2000);
  }
  return out;
}

/** "Fluence 18 J/cm² · Spot size 12 mm" for a session row: the first few filled fields, in form order. */
export function valuesLine(s: FormSchema | null | undefined, values: Record<string, unknown> | null | undefined, max = 5): string {
  if (!s || !values) return '';
  const parts: string[] = [];
  for (const f of SESSION_SECTIONS(s).flatMap((x) => x.fields)) {
    const v = values[f.key];
    if (v === undefined || v === null || v === '' || v === false || (Array.isArray(v) && !v.length)) continue;
    parts.push(`${f.label} ${v === true ? 'yes' : Array.isArray(v) ? v.join(', ') : v}${f.unit && f.type === 'number' ? ` ${f.unit}` : ''}`);
    if (parts.length >= max) break;
  }
  return parts.join(' · ');
}
