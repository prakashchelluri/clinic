import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, withTenant, type Tx } from '../db/index.js';
import { tenant, appointment, patient, practitioner, service, session, OPEN_STATUSES, HOLDS_PLACE } from '../db/schema.js';
import { HttpError, type Ctx } from '../lib/auth.js';
import { emit, nextNumber, todayIn, addDays } from '../lib/core.js';
import { bookingSettings, hoursUntil, newToken, queueMessage, planReminders, dropReminders, originOf, appointmentView } from '../lib/booking.js';
import { windowsForDay } from './scheduling.js';

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

/** Windows a patient may pick: inside the booking horizon, after the minimum notice, room left for the visit type, under the daily online cap. */
async function openSlots(tx: Tx, t: any, from: string, days: number, svc: any, practitionerId?: string | null) {
  const cfg = bookingSettings(t.settings).online; const today = todayIn(t.timezone);
  const last = addDays(today, cfg.maxDaysAhead);
  const docs = await tx.select({ id: practitioner.id, name: practitioner.name }).from(practitioner).where(and(eq(practitioner.tenantId, t.id), eq(practitioner.active, true)));
  const docName = new Map(docs.map((d) => [d.id, d.name]));
  const out: { day: string; slots: { id: string; startTime: string; endTime: string; practitionerId: string | null; doctor: string | null }[] }[] = [];
  for (let i = 0; i < days; i++) {
    const day = addDays(from < today ? today : from, i);
    if (day > last) break;
    let slots: any[] = [];
    let capOk = true;
    if (cfg.dailyCap > 0) {
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(appointment).innerJoin(session, eq(session.id, appointment.sessionId))
        .where(and(eq(appointment.tenantId, t.id), eq(session.day, day), eq(appointment.source, 'online'), inArray(appointment.status, [...HOLDS_PLACE])));
      capOk = n < cfg.dailyCap;
    }
    if (capOk) {
      const ws = await windowsForDay(tx, t.id, day);
      slots = ws.filter((w) => (!practitionerId || w.practitionerId === practitionerId)
        && (!w.practitionerId || docName.has(w.practitionerId))
        && (!svc?.practitionerIds?.length || (w.practitionerId && svc.practitionerIds.includes(w.practitionerId)))
        && w.free >= (svc?.places ?? 1)
        && hoursUntil(day, w.startTime, t.timezone) >= cfg.minNoticeHours)
        .map((w) => ({ id: w.id, startTime: w.startTime, endTime: w.endTime, practitionerId: w.practitionerId, doctor: w.practitionerId ? docName.get(w.practitionerId) ?? null : null }));
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
    cancelWindowHours: cfg.booking.cancelWindowHours, policy: cfg.booking.cancellationPolicy,
  };
}

export function publicRoutes(app: FastifyInstance) {
  const ip = (req: FastifyRequest) => String(req.headers['x-forwarded-for'] ?? req.ip).split(',')[0].trim();

  app.get('/public/clinic/:slug', async (req) => {
    const t = await clinicBySlug((req.params as any).slug); const cfg = bookingSettings(t.settings);
    return inTenant(t, async (tx) => {
      const svcs = await tx.select().from(service).where(and(eq(service.tenantId, t.id), eq(service.active, true), eq(service.onlineBookable, true))).orderBy(service.sortOrder, service.name);
      const docs = await tx.select({ id: practitioner.id, name: practitioner.name, qualification: practitioner.qualification }).from(practitioner).where(and(eq(practitioner.tenantId, t.id), eq(practitioner.active, true)));
      return { name: t.name, slug: t.slug, phone: t.settings?.print?.phone ?? '', address: t.settings?.print?.address ?? '', enabled: cfg.online.enabled, requireApproval: cfg.online.requireApproval,
        intro: cfg.online.intro, maxDaysAhead: cfg.online.maxDaysAhead, arriveEarlyMinutes: cfg.arriveEarlyMinutes, cancelWindowHours: cfg.booking.cancelWindowHours, policy: cfg.booking.cancellationPolicy,
        today: todayIn(t.timezone), services: svcs.map((s) => ({ id: s.id, name: s.name, description: s.description, minutes: s.minutes, pricePaise: s.pricePaise, color: s.color, practitionerIds: s.practitionerIds })), doctors: docs };
    });
  });

  app.get('/public/clinic/:slug/slots', async (req) => {
    const t = await clinicBySlug((req.params as any).slug);
    if (!bookingSettings(t.settings).online.enabled) throw new HttpError(403, 'ONLINE_BOOKING_OFF');
    const q = z.object({ from: DAY, days: z.coerce.number().int().min(1).max(14).default(7), serviceId: z.string().uuid().optional(), practitionerId: z.string().uuid().optional() }).parse(req.query);
    limit('slots:' + ip(req), 120, 60_000);
    return inTenant(t, async (tx) => {
      const svc = q.serviceId ? await tx.select().from(service).where(and(eq(service.id, q.serviceId), eq(service.tenantId, t.id), eq(service.onlineBookable, true), eq(service.active, true))).then((r) => r[0]) : null;
      if (q.serviceId && !svc) throw new HttpError(404, 'SERVICE_NOT_FOUND');
      return openSlots(tx, t, q.from, q.days, svc, q.practitionerId ?? null);
    });
  });

  const BookIn = z.object({ sessionId: z.string().uuid(), serviceId: z.string().uuid(), name: z.string().trim().min(2).max(100), phone: z.string().trim().regex(/^\d{10}$/, 'PHONE_10_DIGITS'),
    note: z.string().trim().max(300).optional(), website: z.string().max(0).optional() }); // website: honeypot, must stay empty
  app.post('/public/clinic/:slug/book', async (req) => {
    const t = await clinicBySlug((req.params as any).slug); const cfg = bookingSettings(t.settings);
    if (!cfg.online.enabled) throw new HttpError(403, 'ONLINE_BOOKING_OFF');
    const body = BookIn.parse(req.body);
    limit('book:' + ip(req), 5, 10 * 60_000);
    return inTenant(t, async (tx) => {
      const svc = await tx.select().from(service).where(and(eq(service.id, body.serviceId), eq(service.tenantId, t.id), eq(service.onlineBookable, true), eq(service.active, true))).then((r) => r[0]);
      if (!svc) throw new HttpError(404, 'SERVICE_NOT_FOUND');
      const s = await tx.select().from(session).where(and(eq(session.id, body.sessionId), eq(session.tenantId, t.id))).for('update').then((r) => r[0]);
      if (!s) throw new HttpError(404, 'SESSION_NOT_FOUND');
      // Re-check every rule server-side: the page may be stale.
      const day = (await openSlots(tx, t, s.day, 1, svc, s.practitionerId)).find((d) => d.day === s.day);
      if (!day?.slots.some((x) => x.id === s.id)) throw new HttpError(409, 'SLOT_TAKEN');
      // Same phone + same name = same person (families share phones, so name must match too).
      let p = await tx.select().from(patient).where(and(eq(patient.tenantId, t.id), eq(patient.phone, body.phone), sql`lower(${patient.fullName}) = ${body.name.toLowerCase()}`)).then((r) => r[0]);
      if (p) {
        const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(appointment).innerJoin(session, eq(session.id, appointment.sessionId))
          .where(and(eq(appointment.tenantId, t.id), eq(appointment.patientId, p.id), inArray(appointment.status, [...OPEN_STATUSES]), sql`${session.day} >= ${todayIn(t.timezone)}`));
        if (n >= 2) throw new HttpError(409, 'TOO_MANY_OPEN_BOOKINGS');
      } else {
        const num = await nextNumber(tx, t.id, 'patient_no', 'tenant');
        [p] = await tx.insert(patient).values({ tenantId: t.id, patientNo: `P${String(num).padStart(5, '0')}`, fullName: body.name, phone: body.phone }).returning();
      }
      const status = cfg.online.requireApproval ? 'requested' : 'booked';
      const [row] = await tx.insert(appointment).values({ tenantId: t.id, patientId: p.id, sessionId: s.id, serviceId: svc.id, note: body.note || null, source: 'online', status, publicToken: newToken() }).returning();
      await emit(tx, ctxFor(t), 'appointment.booked', 'appointment', row.id, { patientId: p.id, sessionId: s.id, day: s.day, window: [s.startTime, s.endTime], online: true, status });
      await queueMessage(tx, t.id, row.id, status === 'requested' ? 'requested' : 'confirmation', originOf(req));
      if (status === 'booked') await planReminders(tx, t.id, row.id, originOf(req));
      return { token: row.publicToken, status, link: `/a/${t.slug}/${row.publicToken}` };
    });
  });

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
      return (await openSlots(tx, t, q.from, q.days, v.svc, null)).map((d) => ({ ...d, slots: d.slots.filter((x) => x.id !== v.a.sessionId) }));
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
      const day = (await openSlots(tx, t, s.day, 1, v.svc, s.practitionerId)).find((d) => d.day === s.day);
      if (!day?.slots.some((x) => x.id === s.id)) throw new HttpError(409, 'SLOT_TAKEN');
      await tx.update(appointment).set({ sessionId: s.id }).where(eq(appointment.id, v.a.id));
      await emit(tx, ctxFor(t), 'appointment.moved', 'appointment', v.a.id, { from: v.a.sessionId, to: s.id, by: 'patient' });
      await planReminders(tx, t.id, v.a.id, originOf(req));
      return patientView((await find(tx)));
    });
  });
}
