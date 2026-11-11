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

// The safety checks (allergy, same medicine twice, pregnancy, interactions) live in rxSafety.ts; re-exported for older imports.
export { ALLERGY_CLASSES, allergyHit, rxWarnings, pregnancyFlag } from './rxSafety.js';
/** "0 y"; "7 m" under two years when the date of birth is known; else the age in years; null when neither is known. */
export function ageText(p: { ageYears?: number | null; dob?: string | null }, now = new Date()): string | null {
  if (p.dob) { const b = new Date(p.dob); const m = (now.getFullYear() - b.getFullYear()) * 12 + now.getMonth() - b.getMonth() - (now.getDate() < b.getDate() ? 1 : 0); if (m >= 0) return m < 24 ? `${m} m` : `${Math.floor(m / 12)} y`; }
  return p.ageYears === null || p.ageYears === undefined ? null : `${p.ageYears} y`;
}
