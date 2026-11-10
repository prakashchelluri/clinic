// The clinic's test list: unit and normal range per parameter, so a typed value is flagged without anyone looking it up.
// ponytail: one adult range per parameter; sex- and age-specific ranges are the upgrade path (add `sex` to the row and pick in flagOf).
export type LabParam = { name: string; unit?: string; low?: number; high?: number; expect?: string; aliases?: string[] };

export const LAB_PARAMS: LabParam[] = [
  { name: 'Haemoglobin', unit: 'g/dL', low: 12, high: 17, aliases: ['Hb'] },
  { name: 'Total WBC', unit: '/µL', low: 4000, high: 11000, aliases: ['TLC', 'WBC'] },
  { name: 'Platelets', unit: '/µL', low: 150000, high: 450000 },
  { name: 'Eosinophils', unit: '%', low: 1, high: 6 },
  { name: 'ESR', unit: 'mm/hr', low: 0, high: 20 },
  { name: 'Fasting blood sugar', unit: 'mg/dL', low: 70, high: 100, aliases: ['FBS'] },
  { name: 'Post-prandial blood sugar', unit: 'mg/dL', low: 70, high: 140, aliases: ['PPBS'] },
  { name: 'Random blood sugar', unit: 'mg/dL', low: 70, high: 140, aliases: ['RBS'] },
  { name: 'HbA1c', unit: '%', low: 4, high: 5.7 },
  { name: 'Total cholesterol', unit: 'mg/dL', low: 0, high: 200 },
  { name: 'Triglycerides', unit: 'mg/dL', low: 0, high: 150 },
  { name: 'LDL', unit: 'mg/dL', low: 0, high: 100 },
  { name: 'HDL', unit: 'mg/dL', low: 40, high: 100 },
  { name: 'SGOT (AST)', unit: 'U/L', low: 0, high: 40, aliases: ['AST', 'SGOT'] },
  { name: 'SGPT (ALT)', unit: 'U/L', low: 0, high: 41, aliases: ['ALT', 'SGPT'] },
  { name: 'Alkaline phosphatase', unit: 'U/L', low: 40, high: 130, aliases: ['ALP'] },
  { name: 'Total bilirubin', unit: 'mg/dL', low: 0.1, high: 1.2 },
  { name: 'Serum creatinine', unit: 'mg/dL', low: 0.6, high: 1.3, aliases: ['Creatinine'] },
  { name: 'Blood urea', unit: 'mg/dL', low: 15, high: 40 },
  { name: 'Uric acid', unit: 'mg/dL', low: 3.5, high: 7.2 },
  { name: 'TSH', unit: 'µIU/mL', low: 0.4, high: 4.5 },
  { name: 'Free T4', unit: 'ng/dL', low: 0.8, high: 1.8, aliases: ['T4'] },
  { name: 'Free T3', unit: 'pg/mL', low: 2.3, high: 4.2, aliases: ['T3'] },
  { name: 'Vitamin D', unit: 'ng/mL', low: 30, high: 100, aliases: ['25-OH vitamin D'] },
  { name: 'Vitamin B12', unit: 'pg/mL', low: 200, high: 900 },
  { name: 'Serum ferritin', unit: 'ng/mL', low: 20, high: 250, aliases: ['Ferritin'] },
  { name: 'Serum iron', unit: 'µg/dL', low: 60, high: 170 },
  { name: 'Zinc', unit: 'µg/dL', low: 70, high: 120 },
  { name: 'Testosterone (total)', unit: 'ng/dL', low: 15, high: 70, aliases: ['Testosterone'] },
  { name: 'DHEA-S', unit: 'µg/dL', low: 35, high: 430 },
  { name: 'Prolactin', unit: 'ng/mL', low: 4, high: 23 },
  { name: 'LH', unit: 'mIU/mL', low: 2, high: 12 },
  { name: 'FSH', unit: 'mIU/mL', low: 3, high: 10 },
  { name: 'Total IgE', unit: 'IU/mL', low: 0, high: 100, aliases: ['IgE'] },
  { name: 'CRP', unit: 'mg/L', low: 0, high: 5 },
  { name: 'ANA', expect: 'Negative' },
  { name: 'KOH mount', expect: 'Negative' },
  { name: 'Woods lamp', expect: 'No fluorescence' },
  { name: 'VDRL', expect: 'Non-reactive', aliases: ['RPR'] },
  { name: 'HIV', expect: 'Non-reactive' },
  { name: 'HBsAg', expect: 'Negative' },
  { name: 'Anti-HCV', expect: 'Negative', aliases: ['HCV'] },
  { name: 'Urine routine', expect: 'Normal' },
  { name: 'Culture & sensitivity', expect: 'No growth' },
  { name: 'Skin biopsy', },
  { name: 'Patch test', },
  { name: 'Beta hCG', expect: 'Negative', aliases: ['UPT', 'Pregnancy test'] },
];

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
/** The parameter a typed name refers to, by name or alias; undefined for a test the clinic has not listed. */
export function findParam(name: string, params: LabParam[] = LAB_PARAMS) {
  const n = norm(name);
  return params.find((p) => norm(p.name) === n || (p.aliases ?? []).some((a) => norm(a) === n));
}

/** The values one ordered test reports, so the desk types numbers under named boxes instead of knowing that CBC means Hb, WBC, platelets…
 *  ponytail: a fixed list in code for the common panels; a Settings screen to edit it when a clinic asks. */
export const LAB_PANELS: { name: string; aliases?: string[]; params: string[] }[] = [
  { name: 'CBC', aliases: ['Complete blood count', 'CBP', 'Complete blood picture', 'Hemogram', 'Haemogram'], params: ['Haemoglobin', 'Total WBC', 'Platelets', 'Eosinophils', 'ESR'] },
  { name: 'Thyroid profile', aliases: ['TFT', 'Thyroid function test', 'Thyroid', 'T3 T4 TSH'], params: ['TSH', 'Free T3', 'Free T4'] },
  { name: 'LFT', aliases: ['Liver function test', 'Liver function tests'], params: ['SGOT (AST)', 'SGPT (ALT)', 'Alkaline phosphatase', 'Total bilirubin'] },
  { name: 'KFT', aliases: ['RFT', 'Kidney function test', 'Renal function test'], params: ['Serum creatinine', 'Blood urea', 'Uric acid'] },
  { name: 'Lipid profile', aliases: ['Lipids', 'Lipid panel'], params: ['Total cholesterol', 'Triglycerides', 'LDL', 'HDL'] },
  { name: 'Iron studies', aliases: ['Iron profile'], params: ['Serum iron', 'Serum ferritin'] },
  { name: 'Hormone profile', aliases: ['PCOS profile', 'PCOS panel', 'Hormonal profile'], params: ['Testosterone (total)', 'DHEA-S', 'Prolactin', 'LH', 'FSH'] },
  { name: 'Blood sugar', aliases: ['Sugar', 'FBS PPBS', 'FBS & PPBS'], params: ['Fasting blood sugar', 'Post-prandial blood sugar'] },
];

/** The value names to ask for under an ordered test: a panel's values, the test itself when it is one value (TSH, KOH mount), else none (the desk adds its own). */
export function paramsForTest(test: string): string[] {
  const n = norm(test);
  const panel = LAB_PANELS.find((p) => [p.name, ...(p.aliases ?? [])].some((a) => { const x = norm(a); return n === x || n.startsWith(`${x} `) || n.startsWith(`${x}(`); }));
  if (panel) return panel.params;
  const one = findParam(test);
  return one ? [one.name] : [];
}

/** Self-check (npx tsx src/lib/labs.ts): the panels resolve, single tests resolve to themselves, unknown tests ask for nothing. */
if (/labs\.ts$/.test(process.argv[1] ?? '')) {
  const eq = (a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };
  eq(paramsForTest('CBC'), LAB_PANELS[0].params);
  eq(paramsForTest('complete  blood count'), LAB_PANELS[0].params);
  eq(paramsForTest('Thyroid profile (T3, T4, TSH)'), ['TSH', 'Free T3', 'Free T4']);
  eq(paramsForTest('TSH'), ['TSH']);
  eq(paramsForTest('hb'), ['Haemoglobin']);
  eq(paramsForTest('KOH mount'), ['KOH mount']);
  eq(paramsForTest('Skin biopsy'), ['Skin biopsy']);
  eq(paramsForTest('Something new'), []);
  eq(paramsForTest('Free T4'), ['Free T4']); // a single value is not swallowed by a panel whose alias it starts like
  for (const p of LAB_PANELS) for (const name of p.params) if (!findParam(name)) throw new Error(`${p.name} lists ${name}, which is not a known value`);
  console.log('labs: ok');
}

/** 'low' | 'normal' | 'high' for a number against the range, 'normal' | 'abnormal' for text against the expected word, null when nothing can be said. */
export function flagOf(value: string, p?: LabParam): 'low' | 'normal' | 'high' | 'abnormal' | null {
  const v = value.trim(); if (!v) return null;
  const n = Number(v.replace(/,/g, ''));
  if (!Number.isNaN(n) && p && (p.low !== undefined || p.high !== undefined)) {
    if (p.low !== undefined && n < p.low) return 'low';
    if (p.high !== undefined && n > p.high) return 'high';
    return 'normal';
  }
  if (p?.expect) return norm(v) === norm(p.expect) || (norm(p.expect).startsWith('neg') && /^neg/i.test(v)) || (norm(p.expect).startsWith('non') && /^non/i.test(v)) ? 'normal' : 'abnormal';
  return null;
}

/** The number in a value, when it is one. */
export const numOf = (value: string) => { const n = Number(value.trim().replace(/,/g, '')); return Number.isNaN(n) ? null : n; };
