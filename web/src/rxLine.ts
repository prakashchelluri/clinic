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
  const score = (name: string) => { const n = name.toLowerCase(); return words.filter((w) => n.includes(w)).length + (n.startsWith(words[0]) ? 0.5 : 0); };
  const best = [...meds].sort((a, b) => score(b.name) - score(a.name))[0];
  const m = best && score(best.name) >= 1 ? best : null;
  const how = m ? words.filter((w) => !m.name.toLowerCase().includes(w)).join(' ') : '';
  return { name: m?.name ?? rest.trim(), medicineId: m?.id ?? null, dose: m?.defaults?.dose, route: m?.defaults?.route, frequency: freq ?? m?.defaults?.frequency, durationDays: days ? Number(days) : m?.defaults?.durationDays, instructions: how || m?.defaults?.instructions };
}
