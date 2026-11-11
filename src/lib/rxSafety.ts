// Prescribing safety: allergy (by name, generic and drug group), the same medicine twice, pregnancy, interactions.
// Shared by the pad (web/src/rxSafety.ts re-exports it) and the server, which will not finish a pad with a serious warning and no reason.
// No imports: it runs in the browser and in Node.
// ponytail: hand-kept word lists matched at the start of each word of the medicine name, its generic and its allergy class (both from
// the medicine list in Settings); a proper drug database is the upgrade path. Stems are long enough not to catch minoxidil, doxylamine
// or levocetirizine. A cream is matched like a tablet (ketoconazole cream counts as an azole): the doctor gives a reason and goes on.
export const ALLERGY_CLASSES: Record<string, string[]> = {
  sulfa: ['sulfa', 'sulpha', 'cotrimoxazole', 'trimox', 'septran', 'bactrim', 'dapsone', 'sulfasalazine'],
  penicillin: ['penicillin', 'amox', 'augmentin', 'moxclav', 'clavam', 'ampi', 'cloxa', 'flucloxa'],
  cephalosporin: ['cephalosporin', 'ceph', 'cef'],
  tetracycline: ['tetracycl', 'doxycyc', 'minocyc', 'lymecyc'],
  retinoid: ['retinoid', 'isotret', 'isotroin', 'acitret', 'alitret', 'tretin', 'adapal', 'tazarot'],
  'local anaesthetic': ['anaesthe', 'anesthe', 'lidocaine', 'lignocaine', 'prilocaine', 'benzocaine', 'emla'],
  macrolide: ['macrolide', 'azithro', 'clarithro', 'erythro', 'roxithro'],
  quinolone: ['quinolone', 'fluoroquin', 'cipro', 'levoflox', 'oflox', 'moxiflox', 'norflox'],
  nsaid: ['nsaid', 'ibuprofen', 'diclofenac', 'aceclofenac', 'aspirin', 'naproxen', 'mefenamic', 'nimesulide', 'etoricoxib', 'ketorolac'],
  azole: ['azole', 'itracon', 'ketocon', 'flucon', 'voricon'],
};
const words = (s: string) => s.toLowerCase().split(/[^a-z]+/).filter(Boolean);
const starts = (text: string, stems: string[]) => words(text).some((w) => stems.some((x) => w.startsWith(x)));
const FILLER = new Set(['drug', 'drugs', 'allergy', 'allergic', 'local', 'tablets', 'medicine', 'medicines', 'hair', 'food', 'other']);
/** The allergy a medicine clashes with ("penicillin" for Amoxyclav), or null. med is the name, plus the generic and class when known. */
export function allergyHit(allergies: string | null | undefined, med: string): string | null {
  if (!allergies || !med) return null;
  for (const word of words(allergies).filter((w) => w.length >= 4 && !FILLER.has(w))) {
    const cls = Object.entries(ALLERGY_CLASSES).find(([, v]) => v.some((x) => word.startsWith(x) || (x.length >= 5 && x.startsWith(word))));
    if (cls ? starts(med, cls[1]) : starts(med, [word])) return cls ? cls[0] : word;
  }
  return null;
}
const ORAL_RETINOID = ['isotret', 'isotroin', 'acitret', 'alitret'];
const MTX = ['methotrex'];
const TRIMETHOPRIM = ['trimetho', 'cotrimox', 'trimox', 'septran', 'bactrim'];
const CICLOSPORIN = ['ciclospor', 'cyclospor'];
/** Unsafe in pregnancy or breastfeeding. */
export const PREGNANCY_AVOID = [...ALLERGY_CLASSES.retinoid, ...MTX, 'finaster', 'dutaster', 'spironol', 'thalidom', 'leflunom', 'mycophen', 'warfar', 'valpro', 'ribavir', ...ALLERGY_CLASSES.tetracycline];
/** Pairs that must not go together on one prescription, and why, in words the doctor reads in a second. */
export const INTERACTIONS: [string[], string[], string][] = [
  [ORAL_RETINOID, ALLERGY_CLASSES.tetracycline, 'both raise the pressure inside the head; do not give together'],
  [MTX, ALLERGY_CLASSES.nsaid, 'the painkiller raises methotrexate to toxic levels'],
  [MTX, TRIMETHOPRIM, 'together they can stop the bone marrow'],
  [MTX, ORAL_RETINOID, 'together they can damage the liver'],
  [MTX, ['dapsone'], 'together they can stop the bone marrow'],
  [CICLOSPORIN, ALLERGY_CLASSES.nsaid, 'together they can damage the kidneys'],
  [CICLOSPORIN, ALLERGY_CLASSES.azole, 'the azole raises ciclosporin levels'],
  [ALLERGY_CLASSES.azole, ['atorvast', 'simvast', 'lovast'], 'the azole raises the statin: risk of muscle damage'],
  [['azathiop'], ['allopur', 'febuxo'], 'together they can stop the bone marrow'],
  [['dapsone'], TRIMETHOPRIM, 'raises dapsone: risk of blue lips (methaemoglobin)'],
  [['warfar'], [...ALLERGY_CLASSES.azole, 'metronid', ...TRIMETHOPRIM], 'raises warfarin: risk of bleeding'],
];
export type Med = { name: string; generic?: string | null; allergyClass?: string | null };
export type Patient = { name: string; allergies?: string | null; pregnant?: string | null };
/** One warning: serious ones (allergy, pregnancy, interaction) stop Finish until the doctor gives a reason. */
export type Problem = { text: string; serious: boolean };
const medText = (m: Med) => `${m.name} ${m.generic ?? ''} ${m.allergyClass ?? ''}`;
/** What one line is, to spot the same medicine written twice: its generic, else the first word of its name. */
const molecule = (m: Med) => (m.generic?.trim().toLowerCase() || words(m.name).find((w) => w.length >= 4) || m.name.toLowerCase());
/** Every warning on the prescription, as sentences: allergy clashes, the same medicine twice, unsafe in pregnancy or breastfeeding, interactions. */
export function rxProblems(meds: Med[], p: Patient): Problem[] {
  const out: Problem[] = [];
  for (const m of meds) { const a = allergyHit(p.allergies, medText(m)); if (a) out.push({ text: `${p.name} is allergic to ${a}: ${m.name}.`, serious: true }); }
  meds.forEach((m, k) => { const twin = meds.slice(0, k).find((x) => molecule(x) === molecule(m)); if (twin) out.push({ text: `${twin.name} and ${m.name} are the same medicine (${molecule(m)}).`, serious: false }); });
  if (p.pregnant) for (const m of meds) if (starts(medText(m), PREGNANCY_AVOID)) out.push({ text: `${p.name} is ${p.pregnant.toLowerCase()}: ${m.name} can harm the baby.`, serious: true });
  for (const [a, b, why] of INTERACTIONS) {
    const x = meds.find((m) => starts(medText(m), a)); const y = meds.find((m) => m !== x && starts(medText(m), b));
    if (x && y) out.push({ text: `${x.name} with ${y.name}: ${why}.`, serious: true });
  }
  return out;
}
export const rxWarnings = (meds: Med[], p: Patient): string[] => rxProblems(meds, p).map((x) => x.text);
/** A reason the doctor gave to prescribe despite warnings; kept in the consultation's data.overrides, never printed. */
export type Override = { at: string; warnings: string[]; reason: string };
/** The serious warnings that still have no reason given. */
export const needsReason = (problems: Problem[], overrides: unknown): string[] => {
  const given = (Array.isArray(overrides) ? overrides : []).filter((o: any) => Array.isArray(o?.warnings) && String(o?.reason ?? '').trim());
  return problems.filter((x) => x.serious && !given.some((o: any) => o.warnings.includes(x.text))).map((x) => x.text);
};
/** "Pregnant" or "Breastfeeding" when the patient's history chips say so. */
export const pregnancyFlag = (history: any): string | null => (history?.conditions ?? []).map((x: any) => x?.name).find((n: any) => /pregnan|breastfeed|lactat/i.test(String(n))) ?? null;
/** The name the warnings use: the patient's first name. */
export const firstName = (fullName: unknown) => String(fullName ?? '').split(' ')[0];
