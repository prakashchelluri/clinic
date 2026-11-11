import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, withTenant, type Tx } from '../db/index.js';
import { tenant, appointment, patient, practitioner, service, session, visit, OPEN_STATUSES, HOLDS_PLACE } from '../db/schema.js';
import { HttpError, type Ctx } from '../lib/auth.js';
import { emit, nextNumber, todayIn, addDays } from '../lib/core.js';
import { bookingSettings, hoursUntil, newToken, queueMessage, planReminders, dropReminders, originOf, appointmentView } from '../lib/booking.js';
import { windowsForDay } from './scheduling.js';
import { patientLang } from '../lib/patientText.js';

const SYSTEM_USER = '00000000-0000-0000-0000-000000000000';
const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => { const x = new Date(d + 'T00:00:00Z'); return !isNaN(+x) && x.toISOString().startsWith(d); }, 'BAD_DATE');

/** Small in-memory limiter for the unauthenticated endpoints: enough to stop a script from filling a clinic's day. */
const hits = new Map<string, number[]>();
function limit(key: string, max: number, windowMs: number) {
  const now = Date.now(); const arr = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= max) throw new HttpError(429, 'TOO_MANY_REQUESTS');
  arr.push(now); hits.set(key, arr);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
}

async function clinicBySlug(slug: string) {
  const t = await db.select().from(tenant).where(and(eq(tenant.slug, String(slug).toLowerCase()), eq(tenant.kind, 'clinic'))).then((r) => r[0]);
  if (!t) throw new HttpError(404, 'CLINIC_NOT_FOUND');
  return t;
}
const ctxFor = (t: any): Ctx => ({ tenantId: t.id, userId: SYSTEM_USER, role: 'patient', roles: ['patient'], name: 'Patient (online)', practitionerId: null, timezone: t.timezone, tenantKind: t.kind });
const inTenant = <T>(t: any, fn: (tx: Tx) => Promise<T>) => withTenant(t.id, SYSTEM_USER, fn);

/** Windows a patient may move their visit to: within 30 days, at least 2 hours ahead, room left for the visit type. */
async function openSlots(tx: Tx, t: any, from: string, days: number, svc: any, practitionerId?: string | null) {
  // ponytail: fixed rules (the old online-booking defaults); clinic settings again if online booking comes back
  const cfg = { maxDaysAhead: 30, minNoticeHours: 2 }; const today = todayIn(t.timezone);
  const last = addDays(today, cfg.maxDaysAhead);
  const docs = await tx.select({ id: practitioner.id, name: practitioner.name }).from(practitioner).where(and(eq(practitioner.tenantId, t.id), eq(practitioner.active, true)));
  const docName = new Map(docs.map((d) => [d.id, d.name]));
  const out: { day: string; slots: { id: string; startTime: string; endTime: string; practitionerId: string | null; doctor: string | null }[] }[] = [];
  for (let i = 0; i < days; i++) {
    const day = addDays(from < today ? today : from, i);
    if (day > last) break;
    let slots: any[] = [];
    {
      const ws = await windowsForDay(tx, t.id, day);
      slots = ws.filter((w) => (!practitionerId || w.practitionerId === practitionerId)
        && (!w.practitionerId || docName.has(w.practitionerId))
        && (!svc?.practitionerIds?.length || (w.practitionerId && svc.practitionerIds.includes(w.practitionerId)))
        && w.free >= (svc?.places ?? 1)
        && hoursUntil(day, w.startTime, t.timezone) >= cfg.minNoticeHours)
        .map((w) => ({ id: w.id, startTime: w.startTime, endTime: w.endTime, practitionerId: w.practitionerId, doctor: w.practitionerId ? docName.get(w.practitionerId) ?? null : null })).sort((a, b) => a.startTime.localeCompare(b.startTime));
    }
    out.push({ day, slots });
  }
  return out;
}

/** The patient's view of one booking, plus what they are allowed to do with it. */
function patientView(v: NonNullable<Awaited<ReturnType<typeof appointmentView>>>) {
  const cfg = bookingSettings(v.t.settings);
  const hours = hoursUntil(v.s.day, v.s.startTime, v.t.timezone);
  const open = (OPEN_STATUSES as readonly string[]).includes(v.a.status);
  const [h, m] = v.s.startTime.split(':').map(Number); const ab = h * 60 + m - cfg.arriveEarlyMinutes;
  return {
    clinic: { name: v.t.name, slug: v.t.slug, phone: v.t.settings?.print?.phone ?? '' }, status: v.a.status, day: v.s.day, startTime: v.s.startTime, endTime: v.s.endTime,
    arriveBy: `${String(Math.floor(ab / 60)).padStart(2, '0')}:${String(ab % 60).padStart(2, '0')}`, doctor: v.doc, visitType: v.svc?.name ?? null, patient: v.p.fullName.split(' ')[0],
    canConfirm: v.a.status === 'booked' && hours > 0,
    canCancel: open && hours >= cfg.booking.cancelWindowHours,
    canReschedule: open && cfg.booking.patientCanReschedule && hours >= cfg.booking.cancelWindowHours,
    cancelWindowHours: cfg.booking.cancelWindowHours, policy: cfg.booking.cancellationPolicy, lang: patientLang(v.p, v.t.settings),
  };
}

export function publicRoutes(app: FastifyInstance) {
  const ip = (req: FastifyRequest) => String(req.headers['x-forwarded-for'] ?? req.ip).split(',')[0].trim();

  // --- the patient's own link: confirm, cancel or move inside the clinic's rules ---
  async function byToken(slug: string, token: string) {
    const t = await clinicBySlug(slug);
    if (!/^[A-Za-z0-9_-]{20,40}$/.test(token)) throw new HttpError(404, 'NOT_FOUND');
    return { t, find: async (tx: Tx) => {
      const a = await tx.select().from(appointment).where(and(eq(appointment.tenantId, t.id), eq(appointment.publicToken, token))).then((r) => r[0]);
      if (!a) throw new HttpError(404, 'NOT_FOUND');
      return (await appointmentView(tx, t.id, a.id))!;
    } };
  }
  app.get('/public/a/:slug/:token', async (req) => {
    const { slug, token } = req.params as any; limit('link:' + ip(req), 60, 60_000);
    const { t, find } = await byToken(slug, token);
    return inTenant(t, async (tx) => patientView(await find(tx)));
  });
  app.post('/public/a/:slug/:token/confirm', async (req) => {
    const { slug, token } = req.params as any; limit('link:' + ip(req), 60, 60_000);
    const { t, find } = await byToken(slug, token);
    return inTenant(t, async (tx) => {
      const v = await find(tx);
      if (!patientView(v).canConfirm) throw new HttpError(409, 'CANNOT_CONFIRM', { status: v.a.status });
      await tx.update(appointment).set({ status: 'confirmed', confirmedAt: new Date().toISOString() }).where(eq(appointment.id, v.a.id));
      await emit(tx, ctxFor(t), 'appointment.updated', 'appointment', v.a.id, { status: 'confirmed', by: 'patient' });
      return patientView((await find(tx)));
    });
  });
  app.post('/public/a/:slug/:token/cancel', async (req) => {
    const { slug, token } = req.params as any; limit('link:' + ip(req), 60, 60_000);
    const { reason } = z.object({ reason: z.string().trim().max(300).optional() }).parse(req.body ?? {});
    const { t, find } = await byToken(slug, token);
    return inTenant(t, async (tx) => {
      const v = await find(tx);
      if (!(OPEN_STATUSES as readonly string[]).includes(v.a.status)) throw new HttpError(409, 'NOT_OPEN', { status: v.a.status });
      if (!patientView(v).canCancel) throw new HttpError(409, 'TOO_LATE_TO_CANCEL', { hours: bookingSettings(t.settings).booking.cancelWindowHours });
      await tx.update(appointment).set({ status: 'cancelled', cancelReason: reason ? `patient: ${reason}` : 'cancelled by patient' }).where(eq(appointment.id, v.a.id));
      await dropReminders(tx, t.id, [v.a.id]);
      await emit(tx, ctxFor(t), 'appointment.updated', 'appointment', v.a.id, { status: 'cancelled', by: 'patient', reason });
      return patientView((await find(tx)));
    });
  });
  app.get('/public/a/:slug/:token/slots', async (req) => {
    const { slug, token } = req.params as any; limit('slots:' + ip(req), 120, 60_000);
    const q = z.object({ from: DAY, days: z.coerce.number().int().min(1).max(14).default(7) }).parse(req.query);
    const { t, find } = await byToken(slug, token);
    return inTenant(t, async (tx) => {
      const v = await find(tx);
      if (!patientView(v).canReschedule) throw new HttpError(409, 'CANNOT_RESCHEDULE');
      return (await openSlots(tx, t, q.from, q.days, v.svc, v.s.practitionerId)).map((d) => ({ ...d, slots: d.slots.filter((x) => x.id !== v.a.sessionId) }));
    });
  });
  app.post('/public/a/:slug/:token/reschedule', async (req) => {
    const { slug, token } = req.params as any; limit('book:' + ip(req), 10, 10 * 60_000);
    const { sessionId } = z.object({ sessionId: z.string().uuid() }).parse(req.body);
    const { t, find } = await byToken(slug, token);
    return inTenant(t, async (tx) => {
      const v = await find(tx);
      if (!patientView(v).canReschedule) throw new HttpError(409, 'CANNOT_RESCHEDULE');
      const s = await tx.select().from(session).where(and(eq(session.id, sessionId), eq(session.tenantId, t.id))).for('update').then((r) => r[0]);
      if (!s) throw new HttpError(404, 'SESSION_NOT_FOUND');
      if (s.practitionerId !== v.s.practitionerId) throw new HttpError(409, 'SLOT_TAKEN'); // a patient keeps their doctor; reception can hand over
      const day = (await openSlots(tx, t, s.day, 1, v.svc, s.practitionerId)).find((d) => d.day === s.day);
      if (!day?.slots.some((x) => x.id === s.id)) throw new HttpError(409, 'SLOT_TAKEN');
      await tx.update(appointment).set({ sessionId: s.id }).where(eq(appointment.id, v.a.id));
      await emit(tx, ctxFor(t), 'appointment.moved', 'appointment', v.a.id, { from: v.a.sessionId, to: s.id, by: 'patient' });
      await planReminders(tx, t.id, v.a.id, originOf(req));
      return patientView((await find(tx)));
    });
  });

  /** The waiting-room screen: tokens only, no names. Who is in with each doctor and who is next. */
  app.get('/public/display/:slug/:token', async (req) => {
    const { slug, token } = req.params as any;
    limit(`display:${req.ip}`, 120, 60_000);
    const t = await clinicBySlug(slug);
    if (!token || t.settings?.display?.token !== token) throw new HttpError(404, 'NOT_FOUND');
    return inTenant(t, async (tx) => {
      const day = todayIn(t.timezone);
      const rows = await tx.select({ v: visit, doctor: practitioner.name, practitionerId: visit.practitionerId }).from(visit).leftJoin(practitioner, eq(practitioner.id, visit.practitionerId))
        .where(and(eq(visit.tenantId, t.id), eq(visit.day, day), inArray(visit.status, ['waiting', 'intake', 'screened', 'in_consult']))).orderBy(sql`${visit.priority} desc`, visit.queuePosition);
      const docs = await tx.select({ id: practitioner.id, name: practitioner.name }).from(practitioner).where(and(eq(practitioner.tenantId, t.id), eq(practitioner.active, true)));
      const lanes = docs.map((d) => {
        const mine = rows.filter((r) => r.practitionerId === d.id || (!r.practitionerId && docs.length === 1));
        return { doctor: d.name, now: mine.find((r) => r.v.status === 'in_consult')?.v.opNumber ?? null,
          next: mine.filter((r) => r.v.status === 'waiting' || r.v.status === 'screened').slice(0, 3).map((r) => r.v.opNumber), withJunior: mine.filter((r) => r.v.status === 'intake').map((r) => r.v.opNumber) };
      }).filter((l) => l.now || l.next.length || l.withJunior.length || docs.length === 1);
      const unassigned = docs.length > 1 ? rows.filter((r) => !r.practitionerId && r.v.status !== 'in_consult').slice(0, 5).map((r) => r.v.opNumber) : [];
      // someone is in with a doctor who was not named on the visit: still show them as Now
      const nowUnnamed = docs.length > 1 ? rows.filter((r) => !r.practitionerId && r.v.status === 'in_consult').map((r) => r.v.opNumber) : [];
      if (nowUnnamed.length) lanes.push({ doctor: 'Consultation', now: nowUnnamed[0], next: [], withJunior: [] });
      return { clinic: t.name, at: new Date().toISOString(), lanes, unassigned, lang: patientLang(null, t.settings) }; // a room of patients: the clinic's language
    });
  });
}
