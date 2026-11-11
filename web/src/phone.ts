/**
 * A mobile typed or pasted any way ("+91 98765 43210", "098765-43210", "919876543210") as the 10 digits we store.
 * Strip spaces, dashes and brackets; drop a +91 / 0091 / 91 country code or a leading 0; then keep at most 10 digits.
 * A plain "91…" is only treated as the country code when there are more than 10 digits, so 9123456789 stays as typed.
 * The server keeps the same rule (src/modules/scheduling.ts normPhone); test/scheduling-phone.test.ts checks both agree.
 */
export function normPhone(raw: string): string {
  const s = String(raw ?? '').trim();
  let d = s.replace(/\D/g, '');
  let intl = s.startsWith('+');
  if (d.startsWith('00')) { d = d.slice(2); intl = true; }
  if (d.startsWith('91') && (intl || d.length > 10)) d = d.slice(2);
  d = d.replace(/^0+/, ''); // trunk 0: Indian mobiles never start with 0
  return d.slice(0, 10);
}

/** Search text that is only digits, spaces, +, - or brackets is a phone number. */
export const looksLikePhone = (s: string) => /^[\d\s+\-().]+$/.test(s.trim()) && /\d/.test(s);

/** What to send to the patient search: a phone-looking text as its digits, a name as typed. */
export const searchText = (s: string) => (looksLikePhone(s) ? normPhone(s) : s.trim());
