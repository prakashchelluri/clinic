/** Days a lab normally takes. Tests that take this long or longer go into their own order, so one slow report never holds the others back. */
const DAYS: Record<string, number> = { 'skin biopsy': 7, 'patch test': 3, 'culture & sensitivity': 3, ana: 3, hiv: 1, vdrl: 1, 'vitamin d': 2, 'vitamin b12': 2, 'serum ferritin': 2 };
export const SLOW_DAYS = 3;
export const expectedDays = (name: string) => DAYS[name.trim().toLowerCase()] ?? 1;
