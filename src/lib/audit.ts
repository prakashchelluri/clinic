import type { FastifyRequest } from 'fastify';
import { and, eq, gte, sql } from 'drizzle-orm';
import { auditLog, visit, appointment, session, pharmacySale, procedureSession } from '../db/schema.js';
import type { Tx } from '../db/index.js';
import type { Ctx } from './auth.js';

/* ---------- privacy settings (tenant.settings.security) ---------- */
export type Allowed = { label: string; from: string; to?: string | null };
export type Security = { ipLock: { enabled: boolean; allowed: Allowed[]; anywhere: string[]; ignored: string[] }; idleMinutes: number; phoneRoles: string[]; listRoles: string[] };
export const DEFAULT_SECURITY: Security = {
  ipLock: { enabled: false, allowed: [], anywhere: [], ignored: [] }, idleMinutes: 30,
  phoneRoles: ['owner', 'admin', 'receptionist', 'doctor', 'coordinator'], listRoles: ['owner'],
};
export function securityOf(settings: any): Security {
  const s = settings?.security ?? {};
  return { ...DEFAULT_SECURITY, ...s, ipLock: { ...DEFAULT_SECURITY.ipLock, ...(s.ipLock ?? {}) } };
}
const ALWAYS = ['owner', 'admin', 'superadmin'];
/** What this person may see and do, sent to the app with /me. */
export const privacyFor = (ctx: Pick<Ctx, 'roles'>, sec: Security) => ({
  seePhones: ctx.roles.some((r) => ALWAYS.includes(r) || sec.phoneRoles.includes(r)),
  canExport: ctx.roles.some((r) => r === 'superadmin' || sec.listRoles.includes(r)),
  idleMinutes: sec.idleMinutes,
});

/* ---------- internet addresses ---------- */
export const cleanIp = (ip: string) => ip.replace(/^::ffff:/, '').trim();
const v4 = (ip: string) => { const p = ip.split('.').map(Number); return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? ((p[0] * 256 + p[1]) * 256 + p[2]) * 256 + p[3] : null; };
export const validIp = (ip: string) => v4(ip) !== null || /^[0-9a-f:]{2,39}$/i.test(ip);
/** An address matches a single allowed address, or an IPv4 range from–to. */
export function ipAllowed(ip: string, allowed: Allowed[]) {
  const a = cleanIp(ip); const n = v4(a);
  return allowed.some((x) => {
    if (!x.to) return cleanIp(x.from) === a;
    const lo = v4(x.from), hi = v4(x.to);
    return n !== null && lo !== null && hi !== null && n >= Math.min(lo, hi) && n <= Math.max(lo, hi);
  });
}
/** Exempt: owner, admin, and the people the owner lets work from anywhere. */
export const ipExempt = (ctx: Pick<Ctx, 'roles' | 'userId'>, sec: Security) => ctx.roles.some((r) => ALWAYS.includes(r)) || sec.ipLock.anywhere.includes(ctx.userId);

/* ---------- writing ---------- */
type Row = { kind: string; action: string; summary: string; entity?: string | null; entityId?: string | null; patientId?: string | null; before?: unknown; after?: unknown; unusual?: boolean };
export async function writeAudit(tx: Tx, ctx: Partial<Ctx> & { tenantId: string; ip?: string }, row: Row) {
  await tx.insert(auditLog).values({ tenantId: ctx.tenantId, userId: ctx.userId ?? null, userName: ctx.name ?? null, role: ctx.role ?? null, ip: ctx.ip ?? null,
    kind: row.kind, action: row.action, summary: row.summary.slice(0, 300), entity: row.entity ?? null, entityId: row.entityId ?? null,
    patientId: row.patientId && /^[0-9a-f-]{36}$/i.test(row.patientId) ? row.patientId : null,
    before: row.before === undefined ? null : clean(row.before), after: row.after === undefined ? null : clean(row.after), unusual: !!row.unusual });
}

/** Strip secrets and file contents, shorten long text. */
function clean(v: any, depth = 0): any {
  if (v === null || v === undefined) return v;
  if (typeof v === 'string') return v.length > 300 ? v.slice(0, 300) + '…' : v;
  if (typeof v !== 'object') return v;
  if (depth > 3) return '…';
  if (Array.isArray(v)) return v.slice(0, 30).map((x) => clean(x, depth + 1));
  const out: any = {};
  for (const [k, x] of Object.entries(v)) {
    if (/password|secret|token|database64|dataurl|photo$|image|file$/i.test(k)) { out[k] = '***'; continue; }
    out[k] = clean(x, depth + 1);
  }
  return out;
}

// ponytail: in-memory throttles, fine for one server; move to the database when there are several.
const seen = new Map<string, number>();
const once = (key: string, ms: number) => { const now = Date.now(); const last = seen.get(key); if (last && now - last < ms) return false; seen.set(key, now); if (seen.size > 20000) seen.clear(); return true; };

const localHour = (tz: string) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(new Date()));
const outsideHours = (tz: string) => { const h = localHour(tz); return h < 7 || h >= 22; };

/** Opening a patient's record. Unusual when nothing brought this patient to the clinic today, or out of hours. Repeat opens within 10 minutes count once. */
export async function auditView(tx: Tx, req: FastifyRequest, patientId: string, what: string) {
  const c = req.ctx; if (!c?.userId || !once(`v|${c.userId}|${patientId}|${what}`, 10 * 60_000)) return;
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: c.timezone }).format(new Date());
  const t = c.tenantId;
  const any = async (q: Promise<any[]>) => (await q).length > 0;
  const reason = await any(tx.select({ id: visit.id }).from(visit).where(and(eq(visit.tenantId, t), eq(visit.patientId, patientId), eq(visit.day, day))).limit(1))
    || await any(tx.select({ id: appointment.id }).from(appointment).innerJoin(session, eq(session.id, appointment.sessionId)).where(and(eq(appointment.tenantId, t), eq(appointment.patientId, patientId), eq(session.day, day))).limit(1))
    || await any(tx.select({ id: pharmacySale.id }).from(pharmacySale).where(and(eq(pharmacySale.tenantId, t), eq(pharmacySale.patientId, patientId), gte(pharmacySale.createdAt, sql`now() - interval '1 day'`))).limit(1))
    || await any(tx.select({ id: procedureSession.id }).from(procedureSession).where(and(eq(procedureSession.tenantId, t), eq(procedureSession.patientId, patientId), eq(procedureSession.day, day))).limit(1));
  await writeAudit(tx, c, { kind: 'view', action: 'patient.viewed', summary: what, entity: 'patient', entityId: patientId, patientId, unusual: !reason || outsideHours(c.timezone) });
}
export const throttleOnce = once;

/* ---------- plain words for every change made through the app ---------- */
const MONEY = /payments|charges|pharmacy\/sale|\/return|\/refund|expenses|\/receipts|\/decide/;
type Rule = [method: string, path: RegExp, kind: string, say: (b: any) => string];
const RULES: Rule[] = [
  ['POST', /^\/appointments$/, 'change', () => 'Booked an appointment'],
  ['PATCH', /^\/appointments\/[^/]+$/, 'change', (b) => b.status === 'cancelled' ? `Cancelled a booking${b.cancelReason ? ` · ${b.cancelReason}` : ''}` : b.status === 'no_show' ? 'Marked a booking as no-show' : b.sessionId ? 'Moved a booking' : b.status === 'confirmed' ? 'Confirmed a booking' : 'Changed a booking'],
  ['POST', /^\/appointments\/[^/]+\/approve$/, 'change', () => 'Approved an online request'],
  ['POST', /^\/appointments\/[^/]+\/decline$/, 'cancel', (b) => `Declined an online request${b.reason ? ` · ${b.reason}` : ''}`],
  ['POST', /^\/appointments\/[^/]+\/remind$/, 'change', () => 'Sent a reminder'],
  ['POST', /^\/patients$/, 'change', (b) => `Registered a patient${b.fullName ? ` · ${b.fullName}` : ''}`],
  ['PATCH', /^\/patients\/[^/]+$/, 'change', () => 'Edited patient details'],
  ['POST', /^\/visits$/, 'change', () => 'Checked in a patient'],
  ['PATCH', /^\/visits\/[^/]+$/, 'change', (b) => b.status ? `Visit marked ${String(b.status).replace('_', ' ')}` : 'Changed a visit'],
  ['POST', /^\/visits\/[^/]+\/encounter$/, 'view', () => 'Opened a consultation'],
  ['PATCH', /^\/encounters\/[^/]+$/, 'change', (b) => b.complete ? 'Completed a consultation' : 'Saved a consultation'],
  ['POST', /^\/payments$/, 'money', (b) => `Recorded a payment${b.amountPaise ? ` · ₹${b.amountPaise / 100}` : ''}${b.method ? ` by ${b.method}` : ''}`],
  ['POST', /^\/charges/, 'money', (b) => `${b.kind === 'waive' ? 'Waived' : 'Changed'} a charge${b.reason ? ` · ${b.reason}` : ''}`],
  ['POST', /^\/pharmacy\/sale$/, 'money', (b) => `Pharmacy bill${b.discountPaise ? ` with ₹${b.discountPaise / 100} discount` : ''}`],
  ['POST', /^\/pharmacy\/sale\/[^/]+\/return$/, 'money', () => 'Pharmacy return and refund'],
  ['POST', /^\/pharmacy\/sale\/[^/]+\/cancel$/, 'cancel', (b) => `Cancelled a pharmacy bill${b.reason ? ` · ${b.reason}` : ''}`],
  ['POST', /^\/pharmacy\/rx\/[^/]+\/nothing$/, 'change', () => 'Recorded patient bought nothing'],
  ['POST', /^\/expenses$/, 'money', (b) => `Added an expense${b.amountPaise ? ` · ₹${b.amountPaise / 100}` : ''}`],
  ['PATCH', /^\/expenses\/[^/]+$/, 'money', () => 'Edited an expense'],
  ['DELETE', /^\/expenses\/[^/]+$/, 'cancel', () => 'Voided an expense'],
  ['POST', /^\/stock\/receipts$/, 'money', () => 'Received stock'],
  ['POST', /^\/stock\/receipts\/[^/]+\/decide$/, 'money', (b) => `Decided a delivery difference${b.decision ? ` · ${b.decision}` : ''}`],
  ['POST', /^\/stock\/orders$/, 'change', () => 'Made a purchase order'],
  ['POST', /^\/stock\/returns$/, 'money', () => 'Returned stock to a vendor'],
  ['POST', /^\/stock\/batches\/[^/]+\/adjust$/, 'change', (b) => `Adjusted stock${b.reason ? ` · ${b.reason}` : ''}`],
  ['POST', /^\/stock\/counts/, 'change', () => 'Stock count'],
  ['POST', /^\/calendar\/day-change$/, 'change', (b) => `Changed a doctor's day · ${b.kind}${b.time ? ` ${b.time}` : ''}${b.minutes ? ` ${b.minutes} min` : ''}`],
  ['POST', /^\/calendar\/blocks$/, 'change', (b) => `Blocked time${b.note ? ` · ${b.note}` : ''}`],
  ['DELETE', /^\/calendar\/blocks\//, 'cancel', () => 'Removed a calendar change'],
  ['POST', /^\/documents$/, 'change', (b) => `Uploaded ${b.kind === 'photo' ? 'a photo' : 'a document'}`],
  ['DELETE', /^\/documents\//, 'cancel', () => 'Deleted a document'],
  ['POST', /^\/broadcasts/, 'print', () => 'Sent a message to a list of patients'],
  ['POST', /^\/waitlist$/, 'change', () => 'Added to the waiting list'],
  ['POST', /^\/rx-templates$/, 'change', (b) => `Saved a consultation template${b.name ? ` · ${b.name}` : ''}`],
  ['POST', /^\/procedure-sessions/, 'change', () => 'Changed a procedure sitting'],
  ['PATCH', /^\/procedure-sessions/, 'change', (b) => b.state ? `Procedure sitting ${b.state}` : 'Changed a procedure sitting'],
  ['PUT', /^\/security$/, 'settings', () => 'Changed privacy and access settings'],
  ['PATCH', /^\/admin\/clinic$/, 'settings', () => 'Changed clinic settings'],
  [' ', /^\/(?:admin\/)?(users|roles|practitioners|medicines|fee-categories|services|forms|procedures|rooms|vendors|calendar\/routine)/, 'settings', () => ''],
];
const NOUN: Record<string, string> = { practitioners: 'a doctor', users: 'a team member', roles: 'a role', medicines: 'a medicine', fees: 'a fee', 'fee-categories': 'a fee', services: 'a visit type', forms: 'the consultation form', procedures: 'a procedure', rooms: 'a room', vendors: 'a vendor', 'calendar/routine': 'weekly hours' };
const VERB: Record<string, string> = { POST: 'Added', PATCH: 'Changed', PUT: 'Changed', DELETE: 'Removed' };

/** One audit row for a change made through the app. Skips consultation autosaves (the completed note is what counts). */
export function describe(method: string, url: string, body: any): { kind: string; summary: string } | null {
  const path = url.replace(/^\/api/, '').split('?')[0];
  if (method === 'PATCH' && /^\/encounters\/[^/]+$/.test(path) && !body?.complete) return null;
  if (/^\/rx-templates\/[^/]+\/use$|^\/documents\/review$|^\/auth\/|^\/broadcasts\/(preview|test)$|^\/audit\//.test(path)) return null;
  for (const [m, re, kind, say] of RULES) {
    if ((m === ' ' || m === method) && re.test(path)) {
      if (m === ' ') { const k = path.match(re)![1]; return { kind, summary: `${VERB[method] ?? 'Changed'} ${NOUN[k] ?? k}` }; }
      return { kind, summary: say(body ?? {}) };
    }
  }
  return { kind: MONEY.test(path) ? 'money' : method === 'DELETE' ? 'cancel' : 'change', summary: `${VERB[method] ?? 'Changed'} ${path.split('/').filter((x) => x && !/^[0-9a-f-]{36}$/i.test(x)).join(' ')}` };
}
