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

export type Ctx = { tenantId: string; userId: string; role: string; name: string; practitionerId: string | null; timezone: string };

// Permission bundles. Tenants can override via tenant.settings.roles[role] = string[].
export const DEFAULT_ROLES: Record<string, string[]> = {
  owner: ['*'],
  admin: ['config.*', 'user.*', 'report.*', 'patient.*', 'appointment.*', 'visit.*', 'payment.*', 'document.read'],
  doctor: ['patient.read', 'patient.write', 'appointment.read', 'visit.read', 'visit.queue', 'encounter.*', 'worklist.read', 'report.read', 'document.*'],
  assistant: ['patient.read', 'visit.read', 'visit.queue', 'encounter.intake', 'document.*'],
  receptionist: ['patient.*', 'appointment.*', 'visit.*', 'payment.record', 'payment.waive', 'worklist.*', 'report.daily', 'expense.write', 'document.*'],
  coordinator: ['patient.read', 'appointment.*', 'visit.read', 'worklist.*', 'payment.record', 'document.*'],
  pharmacist: ['patient.read', 'pharmacy.*', 'payment.record', 'document.read'],
};

export function can(perms: string[], needed: string) {
  return perms.some((p) => p === '*' || p === needed || (p.endsWith('.*') && needed.startsWith(p.slice(0, -1))));
}

export class HttpError extends Error {
  constructor(public status: number, message: string, public extra?: Record<string, unknown>) { super(message); }
}
