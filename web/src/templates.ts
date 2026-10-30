import { useQuery } from '@tanstack/react-query';
import { get } from './api';

/** Small reusable sets for one section of the note. They are suggested by the complaint or diagnosis they are linked to, and they stack. */
export type TmplKind = 'medicine' | 'complaint' | 'finding' | 'advice' | 'tests' | 'procedure';
export type Tmpl = { id: string; kind: TmplKind; name: string; linked: { complaints?: string[]; diagnoses?: string[] }; mode: 'chip' | 'auto'; payload: any; uses: number; active: boolean; draft: boolean };
export type Linked = { complaints?: string[]; diagnoses?: string[] };

export const KINDS: { kind: TmplKind; label: string; one: string; hint: string }[] = [
  { kind: 'medicine', label: 'Medicine sets', one: 'medicine set', hint: 'Medicines with dose, timing and days' },
  { kind: 'complaint', label: 'Complaints', one: 'complaint', hint: 'The check-in chip and the junior doctor’s checklist' },
  { kind: 'finding', label: 'Findings', one: 'findings set', hint: 'Examination findings to tick' },
  { kind: 'advice', label: 'Advice', one: 'advice set', hint: 'Advice lines for the patient' },
  { kind: 'tests', label: 'Test panels', one: 'test panel', hint: 'Tests that are ordered together' },
  { kind: 'procedure', label: 'Procedures', one: 'procedure package', hint: 'Procedure, sittings and interval' },
];

/** "Itching (3 weeks)" and "itching" are the same complaint. */
export const norm = (s: string) => s.toLowerCase().replace(/\s*\([^)]*\)\s*$/, '').trim();
export const uniq = <T,>(xs: T[]) => [...new Set(xs)];

/** Does this set (or protocol) belong to what the doctor has in front of her? Either a matching complaint or a matching diagnosis is enough. */
export const suggests = (t: { linked?: Linked }, complaints: string[], diagnoses: string[]) =>
  (t.linked?.complaints ?? []).some((c) => complaints.includes(norm(c))) || (t.linked?.diagnoses ?? []).some((d) => diagnoses.includes(norm(d)));

/** Tests that take this long or longer go into an order of their own, so one slow report never holds the others back. Same list as the server. */
const SLOW = ['skin biopsy', 'patch test', 'culture & sensitivity', 'ana'];
export const isSlow = (test: string) => SLOW.includes(test.trim().toLowerCase());

export const useTemplates = (kind?: TmplKind, enabled = true) => useQuery<Tmpl[]>({ queryKey: ['templates', kind ?? 'all'], queryFn: () => get(`/templates${kind ? `?kind=${kind}` : ''}`), enabled, staleTime: 60_000 });
