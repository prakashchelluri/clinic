import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export function hashPassword(pw: string) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(pw, salt, 32).toString('hex')}`;
}
export function verifyPassword(pw: string, stored: string) {
  const [salt, hash] = stored.split(':');
  const a = scryptSync(pw, salt, 32);
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export type Ctx = { tenantId: string; userId: string; role: string; roles: string[]; name: string; practitionerId: string | null; timezone: string; tenantKind: string };

// Permission bundles. Tenants can override via tenant.settings.roles[role] = string[].
export const DEFAULT_ROLES: Record<string, string[]> = {
  owner: ['*'],
  admin: ['config.*', 'user.*', 'message.broadcast', 'report.*', 'finance.*', 'expense.*', 'patient.*', 'appointment.*', 'visit.*', 'payment.*', 'document.read'],
  doctor: ['patient.read', 'patient.write', 'appointment.read', 'visit.read', 'visit.queue', 'encounter.*', 'worklist.read', 'report.read', 'document.*'],
  assistant: ['patient.read', 'visit.read', 'visit.queue', 'encounter.intake', 'document.*'],
  receptionist: ['patient.*', 'appointment.*', 'visit.*', 'payment.record', 'payment.waive', 'worklist.*', 'report.daily', 'expense.read', 'expense.write', 'document.*'],
  coordinator: ['patient.read', 'appointment.*', 'visit.read', 'worklist.*', 'payment.record', 'document.*'],
  pharmacist: ['patient.read', 'pharmacy.*', 'payment.record', 'document.read'],
  superadmin: ['platform.*'],
};

/** Union of permissions across all of a user's roles, honouring tenant overrides. */
export function permsFor(roles: string[], overrides?: Record<string, string[]>) {
  return [...new Set(roles.flatMap((r) => (r === 'owner' ? ['*'] : overrides?.[r] ?? DEFAULT_ROLES[r] ?? [])))];
}

export function can(perms: string[], needed: string) {
  return perms.some((p) => p === '*' || p === needed || (p.endsWith('.*') && needed.startsWith(p.slice(0, -1))));
}

export class HttpError extends Error {
  constructor(public status: number, message: string, public extra?: Record<string, unknown>) { super(message); }
}

/** Every permission a clinic can hand to a role, in plain words. Roles are just named sets of these. */
export const PERMISSIONS: { key: string; group: string; label: string; hint: string }[] = [
  { key: 'patient.read', group: 'Patients', label: 'See patients', hint: 'Patients page, search, records' },
  { key: 'patient.write', group: 'Patients', label: 'Register and edit patients', hint: '' },
  { key: 'document.read', group: 'Patients', label: 'See uploaded reports and photos', hint: '' },
  { key: 'document.write', group: 'Patients', label: 'Upload and remove reports and photos', hint: '' },
  { key: 'appointment.read', group: 'Booking', label: 'See the calendar and bookings', hint: 'Calendar page' },
  { key: 'appointment.write', group: 'Booking', label: 'Book and change appointments, edit doctor days', hint: 'Booking page' },
  { key: 'visit.read', group: 'Front desk', label: 'See today\'s queue', hint: '' },
  { key: 'visit.write', group: 'Front desk', label: 'Check patients in', hint: 'Front desk page, Check in button' },
  { key: 'visit.queue', group: 'Front desk', label: 'Move patients through the queue', hint: '' },
  { key: 'encounter.intake', group: 'Clinical', label: 'Take intake and vitals', hint: '' },
  { key: 'encounter.complete', group: 'Clinical', label: 'Consult and write prescriptions', hint: 'Today page for doctors' },
  { key: 'worklist.read', group: 'Procedures', label: 'See procedure and follow-up lists', hint: 'Procedures page' },
  { key: 'worklist.write', group: 'Procedures', label: 'Schedule procedures and log calls', hint: '' },
  { key: 'payment.record', group: 'Money', label: 'Collect payments', hint: '' },
  { key: 'payment.waive', group: 'Money', label: 'Waive or adjust charges', hint: '' },
  { key: 'report.daily', group: 'Money', label: 'See the daily report', hint: 'Reports page' },
  { key: 'expense.read', group: 'Money', label: 'See expenses', hint: 'Expenses page' },
  { key: 'expense.write', group: 'Money', label: 'Add, edit and remove expenses', hint: '' },
  { key: 'finance.read', group: 'Money', label: 'See clinic overview and finance', hint: 'Overview page' },
  { key: 'message.broadcast', group: 'Patients', label: 'Send messages to many patients', hint: 'Patients page' },
  { key: 'pharmacy.read', group: 'Pharmacy', label: 'See the pharmacy queue', hint: 'Pharmacy page' },
  { key: 'pharmacy.dispense', group: 'Pharmacy', label: 'Dispense medicines', hint: '' },
  { key: 'pharmacy.bill', group: 'Pharmacy', label: 'Bill pharmacy sales', hint: '' },
  { key: 'user.read', group: 'Administration', label: 'See staff list', hint: '' },
  { key: 'user.write', group: 'Administration', label: 'Manage staff accounts and roles', hint: '' },
  { key: 'config.write', group: 'Administration', label: 'Change clinic settings', hint: 'Settings page' },
];
const PERM_KEYS = new Set(PERMISSIONS.map((p) => p.key));

/** 'patient.*' / '*' → the concrete permissions from the catalogue they stand for. */
export function expandPerms(perms: string[]): string[] {
  return PERMISSIONS.map((p) => p.key).filter((k) => can(perms, k));
}
export const isKnownPerm = (k: string) => PERM_KEYS.has(k);

export type RoleDef = { key: string; name: string; perms: string[]; builtin: boolean; locked: boolean };
export const BUILTIN_NAMES: Record<string, string> = { owner: 'Owner', admin: 'Admin', doctor: 'Doctor', assistant: 'Assistant', receptionist: 'Reception', coordinator: 'Coordinator', pharmacist: 'Pharmacy' };

/** All roles a clinic has: built-in ones (optionally re-tuned) plus its own. settings.roles = perms, settings.roleNames = display names of custom roles. */
export function rolesFor(settings: any): RoleDef[] {
  const ov: Record<string, string[]> = settings?.roles ?? {}; const names: Record<string, string> = settings?.roleNames ?? {};
  const out: RoleDef[] = Object.keys(BUILTIN_NAMES).map((k) => ({ key: k, name: BUILTIN_NAMES[k], builtin: true, locked: k === 'owner', perms: expandPerms(k === 'owner' ? ['*'] : ov[k] ?? DEFAULT_ROLES[k]) }));
  for (const k of Object.keys(ov)) if (!BUILTIN_NAMES[k]) out.push({ key: k, name: names[k] ?? k, builtin: false, locked: false, perms: expandPerms(ov[k]) });
  return out;
}
