// Medical history as six categories, kept on the patient and confirmed at each visit (the pad's quick-access chips).
export const HISTORY_KEYS = ['conditions', 'family', 'lifestyle', 'drugAllergies', 'surgeries', 'otherAllergies'] as const;
export type HistoryKey = (typeof HISTORY_KEYS)[number];
export type HistoryItem = { name: string; note?: string };
export type History = Partial<Record<HistoryKey, HistoryItem[]>> & { none?: HistoryKey[]; heightCm?: number; confirmedAt?: string; confirmedBy?: string };

export const HISTORY_CATEGORIES: { key: HistoryKey; label: string; short: string; options: string[]; notePlaceholder: string }[] = [
  { key: 'conditions', label: 'Existing conditions', short: 'Existing', notePlaceholder: 'Which medicine, since when', options: ['BP', 'Diabetes', 'Thyroid', 'PCOS', 'Asthma', 'Epilepsy', 'Heart disease', 'Kidney disease', 'Liver disease', 'Pregnant', 'Breastfeeding', 'Depression or anxiety', 'Tuberculosis'] },
  { key: 'family', label: 'Family history', short: 'Family', notePlaceholder: 'Who in the family', options: ['Psoriasis', 'Vitiligo', 'Atopy or asthma', 'Diabetes', 'Early hair loss', 'Skin cancer', 'Thyroid'] },
  { key: 'lifestyle', label: 'Lifestyle habits', short: 'Lifestyle', notePlaceholder: 'How much, how often', options: ['Smokes', 'Alcohol', 'Chews tobacco', 'Sun exposure at work', 'Gym supplements', 'Poor sleep', 'Hair dye use'] },
  { key: 'drugAllergies', label: 'Drug allergies', short: 'Drug allergy', notePlaceholder: 'What happened', options: ['Sulfa', 'Penicillin', 'NSAIDs', 'Local anaesthetic', 'Cephalosporins', 'Tetracyclines'] },
  { key: 'surgeries', label: 'Past surgical procedures', short: 'Surgeries', notePlaceholder: 'Year and where', options: ['Caesarean', 'Appendix', 'Thyroid surgery', 'Cosmetic procedure elsewhere', 'Laser elsewhere', 'Skin biopsy'] },
  { key: 'otherAllergies', label: 'Food and other allergies', short: 'Other allergy', notePlaceholder: 'What happened', options: ['Hair dye (PPD)', 'Nickel', 'Latex', 'Cosmetics or fragrance', 'Seafood', 'Nuts', 'Eggs', 'Milk', 'Dust', 'Pollen'] },
];

// The earlier shape was yes/no per key: diabetes, thyroid, bp, allergy, other. Each becomes an item in a category.
const OLD: Record<string, [HistoryKey, string]> = { diabetes: ['conditions', 'Diabetes'], thyroid: ['conditions', 'Thyroid'], bp: ['conditions', 'BP'] };
export function normHistory(raw: any): History {
  if (!raw || typeof raw !== 'object') return {};
  if (HISTORY_KEYS.some((k) => Array.isArray(raw[k])) || Array.isArray(raw.none)) return raw as History;
  const h: History = {};
  const add = (k: HistoryKey, item: HistoryItem) => { (h[k] ??= []).push(item); };
  for (const [k, v] of Object.entries(raw as Record<string, { yes?: boolean; note?: string }>)) {
    if (!v?.yes) continue;
    if (OLD[k]) add(OLD[k][0], { name: OLD[k][1], ...(v.note ? { note: v.note } : {}) });
    else if (k === 'allergy') add('drugAllergies', { name: v.note?.trim() || 'Allergy' });
    else if (v.note?.trim()) add('conditions', { name: v.note.trim() });
  }
  return h;
}

/** One line for the allergy check and the printed prescription: "sulfa, penicillin". */
export const allergyText = (h: History) => [...(h.drugAllergies ?? []), ...(h.otherAllergies ?? [])].map((x) => x.name).join(', ') || null;

/** Cleans what a client sent: known keys only, short strings, at most 20 items each. */
export function cleanHistory(input: any): History {
  const h: History = {};
  for (const k of HISTORY_KEYS) {
    const xs = Array.isArray(input?.[k]) ? input[k] : [];
    const items = xs.filter((x: any) => x && typeof x.name === 'string' && x.name.trim()).slice(0, 20)
      .map((x: any) => ({ name: String(x.name).trim().slice(0, 80), ...(typeof x.note === 'string' && x.note.trim() ? { note: x.note.trim().slice(0, 160) } : {}) }));
    if (items.length) h[k] = items;
  }
  const none = Array.isArray(input?.none) ? input.none.filter((k: any) => HISTORY_KEYS.includes(k) && !h[k as HistoryKey]) : [];
  if (none.length) h.none = none;
  if (typeof input?.heightCm === 'number' && input.heightCm > 30 && input.heightCm < 250) h.heightCm = input.heightCm;
  return h;
}
