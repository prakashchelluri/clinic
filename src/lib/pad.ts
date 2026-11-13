// The Rx pad's sections, their clinic configuration, what prints, and the Telugu line under standard phrases.
export type PadSection = { key: string; show: boolean; required: boolean; print: boolean };
export const PAD_SECTIONS: { key: string; label: string; canRequire?: boolean; canPrint?: boolean }[] = [
  { key: 'vitals', label: 'Vitals', canPrint: true },
  { key: 'history', label: 'Medical history', canPrint: true },
  { key: 'symptoms', label: 'Symptoms', canRequire: true, canPrint: true },
  { key: 'diagnosis', label: 'Diagnosis', canRequire: true, canPrint: true },
  { key: 'exam', label: 'Examination', canRequire: true, canPrint: true },
  { key: 'medicines', label: 'Medicines', canRequire: true, canPrint: true },
  { key: 'advice', label: 'Advice', canRequire: true, canPrint: true },
  { key: 'tests', label: 'Tests', canRequire: true, canPrint: true },
  { key: 'results', label: 'Lab results', canPrint: true },
  { key: 'followup', label: 'Follow-up', canRequire: true, canPrint: true },
  { key: 'procedures', label: 'Procedures', canRequire: true, canPrint: true },
  { key: 'notes', label: 'Private note' },
  { key: 'referral', label: 'Refer to', canRequire: true, canPrint: true },
  { key: 'photos', label: 'Photos on the pad' },
];
const DEFAULT_OFF = new Set(['photos']);
const DEFAULT_NOPRINT = new Set(['history', 'exam', 'notes', 'photos']);

/** The clinic's pad: every known section in its saved order, unknown or missing ones filled with defaults. */
export function padConfig(settings: any): PadSection[] {
  // "next" (follow-up and procedures in one) was split in two: a clinic's saved choice for it carries to both, in its place
  const saved: PadSection[] = (Array.isArray(settings?.pad?.sections) ? settings.pad.sections : []).flatMap((s: PadSection) => (s.key === 'next' ? [{ ...s, key: 'followup' }, { ...s, key: 'procedures' }] : [s]));
  const known = new Set(PAD_SECTIONS.map((s) => s.key));
  const out: PadSection[] = saved.filter((s) => known.has(s.key)).map((s) => ({ key: s.key, show: s.key === 'diagnosis' ? true : !!s.show, required: !!s.required, print: s.key === 'notes' ? false : !!s.print }));
  for (const s of PAD_SECTIONS) if (!out.some((o) => o.key === s.key)) out.push({ key: s.key, show: !DEFAULT_OFF.has(s.key), required: false, print: !DEFAULT_NOPRINT.has(s.key) });
  return out;
}

export type PrintSettings = { lang: 'te+en' | 'hi+en' | 'en' | 'te'; outOfRangeOnly: boolean; vitals: string[] };
export const printSettings = (settings: any): PrintSettings => ({ lang: 'te+en', outOfRangeOnly: true, vitals: ['weight_kg', 'bp'], ...(settings?.print?.rx ?? {}) });

// Standard phrases in Telugu. Free text prints as typed. The owner edits this table in Settings later; for now it ships with the app.
export const TE: Record<string, string> = {
  '1-0-0': 'ఉదయం 1', '0-1-0': 'మధ్యాహ్నం 1', '0-0-1': 'రాత్రి 1', '1-0-1': 'ఉదయం 1, రాత్రి 1', '1-1-1': 'ఉదయం, మధ్యాహ్నం, రాత్రి 1', '1-1-0': 'ఉదయం 1, మధ్యాహ్నం 1', '0-1-1': 'మధ్యాహ్నం 1, రాత్రి 1',
  'once daily': 'రోజుకు ఒకసారి', 'twice daily': 'రోజుకు రెండుసార్లు', 'thrice daily': 'రోజుకు మూడుసార్లు', 'at night': 'రాత్రి పూట', 'morning': 'ఉదయం', 'alternate days': 'రోజు విడిచి రోజు', 'weekly': 'వారానికి ఒకసారి', 'sos': 'అవసరమైనప్పుడు', 'once': 'ఒకసారి',
  'after food': 'భోజనం తర్వాత', 'before food': 'భోజనానికి ముందు', 'empty stomach': 'ఖాళీ కడుపుతో', 'at bedtime': 'పడుకునే ముందు', 'with food': 'భోజనంతో పాటు',
  'thin layer on affected area': 'సమస్య ఉన్న చోట పలుచగా రాయండి', 'apply thin layer': 'పలుచగా రాయండి', 'days': 'రోజులు', 'day': 'రోజు',
  'keep the area dry': 'ఆ భాగాన్ని పొడిగా ఉంచండి', "don't share towels": 'టవల్స్ పంచుకోవద్దు', 'wash clothes in hot water': 'బట్టలు వేడి నీటిలో ఉతకండి', 'no steroid creams': 'స్టెరాయిడ్ క్రీములు వాడవద్దు',
  'loose cotton clothes': 'వదులుగా ఉండే కాటన్ బట్టలు ధరించండి', 'sunscreen every 3 hours': 'ప్రతి 3 గంటలకు సన్‌స్క్రీన్ రాయండి', 'moisturise twice daily': 'రోజుకు రెండుసార్లు మాయిశ్చరైజర్ రాయండి', 'avoid scrubbing': 'గట్టిగా రుద్దవద్దు',
  'avoid oily food': 'నూనె పదార్థాలు తగ్గించండి', 'mild soap only': 'మైల్డ్ సబ్బు మాత్రమే వాడండి', 'treat everyone at home, same night': 'ఇంట్లో అందరికీ అదే రాత్రి చికిత్స చేయండి', 'hot-wash clothes and bedding': 'బట్టలు, పరుపులు వేడి నీటిలో ఉతకండి',
  'stop the steroid cream': 'స్టెరాయిడ్ క్రీమ్ ఆపండి', "don't scratch": 'గోకవద్దు', 'cut nails short': 'గోళ్లు చిన్నగా కత్తిరించండి', 'review': 'మళ్లీ రావాల్సిన తేదీ',
};
/** The clinic's phrase table: the built-in one with the owner's edits and additions on top (Settings → Rx pad). An empty edit removes the Telugu line. */
export function teluguTable(settings: any): Record<string, string> {
  const own = settings?.pad?.telugu;
  return own && typeof own === 'object' ? { ...TE, ...own } : TE;
}
/** The Telugu for a phrase, or null when it is free text. Numbers in "x days" are kept. */
export function te(phrase: string | null | undefined, settings?: any): string | null {
  if (!phrase) return null; const k = phrase.trim().toLowerCase();
  const table = teluguTable(settings);
  if (k in table) return table[k] || null;
  const d = k.match(/^(\d+)\s*days?$/); if (d) return `${d[1]} రోజులు`;
  return null;
}

// Standard phrases in Hindi, for a clinic that prints Hindi under the English. Not editable yet (the Telugu table is); free text stays in English.
export const HI: Record<string, string> = {
  '1-0-0': 'सुबह 1', '0-1-0': 'दोपहर 1', '0-0-1': 'रात 1', '1-0-1': 'सुबह 1, रात 1', '1-1-1': 'सुबह, दोपहर, रात 1', '1-1-0': 'सुबह 1, दोपहर 1', '0-1-1': 'दोपहर 1, रात 1',
  'once daily': 'दिन में एक बार', 'twice daily': 'दिन में दो बार', 'thrice daily': 'दिन में तीन बार', 'at night': 'रात में', 'morning': 'सुबह', 'alternate days': 'एक दिन छोड़कर', 'weekly': 'हफ़्ते में एक बार', 'sos': 'ज़रूरत पड़ने पर', 'once': 'एक बार',
  'after food': 'खाने के बाद', 'before food': 'खाने से पहले', 'empty stomach': 'खाली पेट', 'at bedtime': 'सोने से पहले', 'with food': 'खाने के साथ',
  'thin layer on affected area': 'प्रभावित जगह पर पतली परत लगाएँ', 'apply thin layer': 'पतली परत लगाएँ', 'days': 'दिन', 'day': 'दिन',
  'keep the area dry': 'उस जगह को सूखा रखें', "don't share towels": 'तौलिया किसी के साथ न बाँटें', 'wash clothes in hot water': 'कपड़े गरम पानी में धोएँ', 'no steroid creams': 'स्टेरॉयड क्रीम न लगाएँ',
  'loose cotton clothes': 'ढीले सूती कपड़े पहनें', 'sunscreen every 3 hours': 'हर 3 घंटे में सनस्क्रीन लगाएँ', 'moisturise twice daily': 'दिन में दो बार मॉइस्चराइज़र लगाएँ', 'avoid scrubbing': 'रगड़ें नहीं',
  'avoid oily food': 'तली-भुनी चीज़ें कम खाएँ', 'mild soap only': 'केवल हल्का साबुन', "don't scratch": 'खुजलाएँ नहीं', 'cut nails short': 'नाखून छोटे रखें', 'stop the steroid cream': 'स्टेरॉयड क्रीम बंद करें',
};
/** The patient-language line for a phrase: Telugu or Hindi by the clinic's print setting; null for English only, or free text with no translation. */
export function localPhrase(lang: PrintSettings['lang'], phrase: string | null | undefined, settings?: any): string | null {
  if (!phrase || lang === 'en') return null;
  if (lang !== 'hi+en') return te(phrase, settings);
  const k = phrase.trim().toLowerCase(); if (k in HI) return HI[k];
  const d = k.match(/^(\d+)\s*days?$/); return d ? `${d[1]} दिन` : null;
}

/** Validate submitted data against the form definition: required fields and option membership only. */
export function validate(schema: { sections: { key: string; title?: string; fields: { key: string; label: string; type: string; required?: boolean; options?: string[] }[] }[] }, data: Record<string, any>, pad: { key: string; required: boolean }[] = []) {
  const padReq = (k: string) => !!pad.find((s) => s.key === k)?.required;
  const errors: { path: string; message: string }[] = [];
  for (const s of schema.sections) for (const f of s.fields) {
    const v = data[s.key]?.[f.key];
    const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
    // symptoms and diagnosis are required only when the clinic ticked them on its pad; other form fields keep their own flag
    const required = s.key === 'complaint' && f.key === 'chief_complaint' ? padReq('symptoms') : f.type === 'diagnoses' ? padReq('diagnosis') : s.key === 'exam' ? false : f.required;
    if (required && empty) errors.push({ path: `${s.key}.${f.key}`, message: 'required' });
    if (!empty && f.options && f.type !== 'tags') {
      // name the field and the value, so the pad can say what to fix ("Site: Chest is not one of the choices")
      const bad = f.type === 'select' ? (f.options.includes(v) ? [] : [String(v)]) : f.type === 'multiselect' ? (v as string[]).filter((x) => !f.options!.includes(x)) : [];
      if (bad.length) errors.push({ path: `${s.key}.${f.key}`, message: `${f.label}: ${bad.join(', ')} ${bad.length === 1 ? 'is' : 'are'} not one of the choices` });
    }
  }
  return errors;
}
