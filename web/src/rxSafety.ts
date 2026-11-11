// The fuller safety checks (generic and drug-group allergy match, same medicine twice, pregnancy, interactions) for the Simple pad.
// The Stacked, Focused and Review pads keep rxLine.ts exactly as it was: the user asked that the existing pads stay unchanged.
// Turning a typed line into a prescription row. Kept apart from the page so it can be tested.
export type RxItem = { medicineId?: string | null; name: string; dose?: string; route?: string; frequency?: string; durationDays?: number; instructions?: string };
const FREQ_WORDS = ['at night', 'once daily', 'twice daily', 'thrice daily', 'alternate days'];
/** "itra 100 1-0-1 7d after food" → the medicine whose name has those words, with frequency, days and how. */
export function parseRxLine(line: string, meds: any[]): RxItem | null {
  const freq = line.match(/\b([0-2]-[0-2]-[0-2](?:-[0-2])?)\b/)?.[1] ?? FREQ_WORDS.find((f) => line.toLowerCase().includes(f));
  const weeks = line.match(/\b(\d{1,2})\s*(?:w|wk|weeks?)\b/i)?.[1];
  const days = line.match(/\b(\d{1,3})\s*(?:d|days?)\b/i)?.[1] ?? (weeks ? String(Number(weeks) * 7) : undefined);
  const rest = line.replace(/\b[0-2]-[0-2]-[0-2](?:-[0-2])?\b/, '').replace(/\b\d{1,3}\s*(?:d|days?|w|wk|weeks?)\b/i, '').replace(new RegExp(FREQ_WORDS.join('|'), 'i'), '');
  const words = rest.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  // a number alone ("100") never picks a medicine: at least one word with letters must match, so "itra 100" does not become "Doxycycline 100 mg"
  const alpha = words.filter((w) => /[a-z]/.test(w));
  const score = (name: string) => { const n = name.toLowerCase(); const a = alpha.filter((w) => n.includes(w)).length; return a ? a + words.filter((w) => !/[a-z]/.test(w) && n.includes(w)).length + (n.startsWith(words[0]) ? 0.5 : 0) : 0; };
  const best = [...meds].sort((a, b) => score(b.name) - score(a.name))[0];
  const m = best && score(best.name) >= 1 ? best : null;
  const how = m ? words.filter((w) => !m.name.toLowerCase().includes(w)).join(' ') : '';
  return { name: m?.name ?? rest.trim(), medicineId: m?.id ?? null, dose: m?.defaults?.dose, route: m?.defaults?.route, frequency: freq ?? m?.defaults?.frequency, durationDays: days ? Number(days) : m?.defaults?.durationDays, instructions: how || m?.defaults?.instructions };
}

/** Doses a day from "1-0-1", "twice daily", "at night"…; null when it cannot be counted (SOS, "as directed"). */
export function dosesPerDay(freq: string | null | undefined): number | null {
  if (!freq) return null; const f = freq.toLowerCase().trim();
  const m = f.match(/^([0-2])-([0-2])-([0-2])(?:-([0-2]))?$/); if (m) return m.slice(1).filter(Boolean).reduce((n, x) => n + Number(x), 0);
  if (/once|at night|morning|at bedtime|daily$/.test(f) && !/twice|thrice/.test(f)) return 1;
  if (/twice/.test(f)) return 2; if (/thrice|three times/.test(f)) return 3;
  if (/alternate/.test(f)) return 0.5; if (/weekly/.test(f)) return 1 / 7;
  return null;
}
/** Units to dispense: units per dose × doses a day × days, rounded up; 1 for creams and lotions; null when it cannot be worked out. */
export function qtyFor(i: { dose?: string | null; frequency?: string | null; durationDays?: number | null; route?: string | null }): number | null {
  if (i.route && /topical|local|apply/i.test(i.route)) return 1;
  const per = dosesPerDay(i.frequency); if (per === null || !i.durationDays) return null;
  return Math.ceil(per * unitsPerDose(i.dose) * i.durationDays);
}
/** Units taken each time: "2 tab" → 2, "½" → 0.5. A strength ("500 mg", "0.1%", "5 ml") is not a count of units, so it is 1. */
export function unitsPerDose(dose: string | null | undefined): number {
  const d = (dose ?? '').trim().toLowerCase().replace('½', '0.5');
  const m = d.match(/^(\d+(?:\.\d+)?)\s*(?:tabs?|tablets?|caps?|capsules?|units?|drops?|puffs?|sachets?)?$/);
  return m ? Number(m[1]) || 1 : 1;
}

// --- safety checks on the prescription: allergy, same medicine twice, pregnancy, interactions ---
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
const medText = (m: Med) => `${m.name} ${m.generic ?? ''} ${m.allergyClass ?? ''}`;
/** What one line is, to spot the same medicine written twice: its generic, else the first word of its name. */
const molecule = (m: Med) => (m.generic?.trim().toLowerCase() || words(m.name).find((w) => w.length >= 4) || m.name.toLowerCase());
/** What Finish stops on, as sentences: allergy clashes, the same medicine twice, medicines unsafe in pregnancy or breastfeeding, interactions. */
export function rxWarnings(meds: Med[], p: { name: string; allergies?: string | null; pregnant?: string | null }): string[] {
  const out: string[] = [];
  for (const m of meds) { const a = allergyHit(p.allergies, medText(m)); if (a) out.push(`${p.name} is allergic to ${a}: ${m.name}.`); }
  meds.forEach((m, k) => { const twin = meds.slice(0, k).find((x) => molecule(x) === molecule(m)); if (twin) out.push(`${twin.name} and ${m.name} are the same medicine (${molecule(m)}).`); });
  if (p.pregnant) for (const m of meds) if (starts(medText(m), PREGNANCY_AVOID)) out.push(`${p.name} is ${p.pregnant.toLowerCase()}: ${m.name} can harm the baby.`);
  for (const [a, b, why] of INTERACTIONS) {
    const x = meds.find((m) => starts(medText(m), a)); const y = meds.find((m) => m !== x && starts(medText(m), b));
    if (x && y) out.push(`${x.name} with ${y.name}: ${why}.`);
  }
  return out;
}
/** "Pregnant" or "Breastfeeding" when the patient's history chips say so. */
export const pregnancyFlag = (history: any): string | null => (history?.conditions ?? []).map((x: any) => x?.name).find((n: any) => /pregnan|breastfeed|lactat/i.test(String(n))) ?? null;
/** "0 y"; "7 m" under two years when the date of birth is known; else the age in years; null when neither is known. */
export function ageText(p: { ageYears?: number | null; dob?: string | null }, now = new Date()): string | null {
  if (p.dob) { const b = new Date(p.dob); const m = (now.getFullYear() - b.getFullYear()) * 12 + now.getMonth() - b.getMonth() - (now.getDate() < b.getDate() ? 1 : 0); if (m >= 0) return m < 24 ? `${m} m` : `${Math.floor(m / 12)} y`; }
  return p.ageYears === null || p.ageYears === undefined ? null : `${p.ageYears} y`;
}
