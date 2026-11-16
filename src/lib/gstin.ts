// A GSTIN: state code, PAN, entity number, Z, and a check character over the first 14 (the GST network's mod-36 rule).
const C = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export function validGstin(g: string) {
  if (!/^(0[1-9]|[1-3][0-9]|97|99)[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g)) return false;
  let sum = 0;
  for (let i = 0; i < 14; i++) { const v = C.indexOf(g[i]) * (i % 2 ? 2 : 1); sum += Math.floor(v / 36) + (v % 36); }
  return C[(36 - (sum % 36)) % 36] === g[14];
}
// check: a real GSTIN passes, one changed character fails
if (process.env.NODE_ENV === 'test') { if (!validGstin('27AAPFU0939F1ZV') || validGstin('27AAPFU0939F1ZW') || validGstin('ABCDEFGHIJKLMNO')) throw new Error('validGstin'); }
