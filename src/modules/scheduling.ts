import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, sql, asc } from 'drizzle-orm';
import { session, appointment, patient } from '../db/schema.js';
import { route } from '../lib/route.js';
import { emit, todayIn, nextNumber } from '../lib/core.js';
import { HttpError, can } from '../lib/auth.js';

const SessionIn = z.object({
  branchId: z.string().uuid(), practitionerId: z.string().uuid().nullable().optional(),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), startTime: z.string().regex(/^\d{2}:\d{2}$/), endTime: z.string().regex(/^\d{2}:\d{2}$/),
  capacity: z.number().int().min(0).max(100), note: z.string().optional(),
});
const ApptIn = z.object({
  sessionId: z.string().uuid(),
  patientId: z.string().uuid().optional(),
  newPatient: z.object({ fullName: z.string().min(1), phone: z.string().regex(/^\d{10}$/).optional() }).optional(),
  note: z.string().optional(), source: z.string().default('phone'), overbook: z.boolean().default(false),
  idempotencyKey: z.string().optional(),
});

export function schedulingRoutes(app: FastifyInstance) {
  /** Windows for a day with allocated counts: what reception sees on the phone. */
  route(app, 'get', '/sessions', 'appointment.read', async (req, tx) => {
    const day = String((req.query as any).day ?? todayIn(req.ctx.timezone));
    const rows = await tx.select({
      s: session,
      allocated: sql<number>`(select count(*)::int from appointment a where a.session_id = ${session.id} and a.status in ('booked','arrived'))`,
    }).from(session).where(and(eq(session.tenantId, req.ctx.tenantId), eq(session.day, day))).orderBy(asc(session.startTime));
    return rows.map((r) => ({ ...r.s, allocated: r.allocated, free: r.s.capacity - r.allocated }));
  });

  route(app, 'post', '/sessions', 'appointment.write', async (req, tx) => {
    const body = SessionIn.parse(req.body);
    const [row] = await tx.insert(session).values({ ...body, tenantId: req.ctx.tenantId }).returning();
    return row;
  });
  route(app, 'patch', '/sessions/:id', 'appointment.write', async (req, tx) => {
    const body = SessionIn.partial().parse(req.body);
    const [row] = await tx.update(session).set(body).where(and(eq(session.id, (req.params as any).id), eq(session.tenantId, req.ctx.tenantId))).returning();
    if (!row) throw new HttpError(404, 'NOT_FOUND');
    return row;
  });
  /** Copy yesterday's (or a template day's) sessions to a new day: the doctor "tells the team availability" in one click. */
  route(app, 'post', '/sessions/copy', 'appointment.write', async (req, tx) => {
    const { fromDay, toDay } = z.object({ fromDay: z.string(), toDay: z.string() }).parse(req.body);
    const src = await tx.select().from(session).where(and(eq(session.tenantId, req.ctx.tenantId), eq(session.day, fromDay)));
    if (!src.length) return [];
    return tx.insert(session).values(src.map(({ id, createdAt, ...s }) => ({ ...s, day: toDay }))).returning();
  });

  route(app, 'get', '/appointments', 'appointment.read', async (req, tx) => {
    const day = String((req.query as any).day ?? todayIn(req.ctx.timezone));
    return tx.select({ a: appointment, p: { id: patient.id, fullName: patient.fullName, phone: patient.phone, patientNo: patient.patientNo }, s: { startTime: session.startTime, endTime: session.endTime } })
      .from(appointment).innerJoin(patient, eq(patient.id, appointment.patientId)).innerJoin(session, eq(session.id, appointment.sessionId))
      .where(and(eq(appointment.tenantId, req.ctx.tenantId), eq(session.day, day))).orderBy(asc(session.startTime), asc(appointment.createdAt))
      .then((rows) => rows.map((r) => ({ ...r.a, patient: r.p, window: r.s })));
  });

  /** Book: capacity-checked, idempotent, creates a minimal patient when the caller is new (name + phone only). */
  route(app, 'post', '/appointments', 'appointment.write', async (req, tx) => {
    const body = ApptIn.parse(req.body); const t = req.ctx.tenantId;
    if (body.idempotencyKey) {
      const dup = await tx.select().from(appointment).where(and(eq(appointment.tenantId, t), eq(appointment.idempotencyKey, body.idempotencyKey))).then((r) => r[0]);
      if (dup) return dup;
    }
    const s = await tx.select().from(session).where(and(eq(session.id, body.sessionId), eq(session.tenantId, t))).for('update').then((r) => r[0]);
    if (!s) throw new HttpError(404, 'SESSION_NOT_FOUND');
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(appointment).where(and(eq(appointment.sessionId, s.id), sql`${appointment.status} in ('booked','arrived')`));
    const full = n >= s.capacity;
    if (full && !(body.overbook && can(req.perms, 'appointment.overbook'))) {
      const alts = await tx.select({ id: session.id, startTime: session.startTime, endTime: session.endTime, capacity: session.capacity,
        allocated: sql<number>`(select count(*)::int from appointment a where a.session_id = ${session.id} and a.status in ('booked','arrived'))` })
        .from(session).where(and(eq(session.tenantId, t), eq(session.day, s.day))).orderBy(asc(session.startTime));
      throw new HttpError(409, 'WINDOW_FULL', { alternatives: alts.filter((a) => a.allocated < a.capacity), overrideRequires: 'appointment.overbook' });
    }
    let patientId = body.patientId;
    if (!patientId) {
      if (!body.newPatient) throw new HttpError(400, 'PATIENT_REQUIRED');
      const num = await nextNumber(tx, t, 'patient_no', 'tenant');
      const [p] = await tx.insert(patient).values({ tenantId: t, patientNo: `P${String(num).padStart(5, '0')}`, fullName: body.newPatient.fullName, phone: body.newPatient.phone ?? null }).returning();
      patientId = p.id;
    }
    const [row] = await tx.insert(appointment).values({ tenantId: t, patientId, sessionId: s.id, note: body.note, source: body.source, overbooked: full, idempotencyKey: body.idempotencyKey }).returning();
    await emit(tx, req.ctx, 'appointment.booked', 'appointment', row.id, { patientId, sessionId: s.id, day: s.day, window: [s.startTime, s.endTime], overbooked: full });
    const settings = (await tx.query.tenant.findFirst({ where: (tn, { eq }) => eq(tn.id, t) }))?.settings ?? {};
    const early = settings.scheduling?.arriveEarlyMinutes ?? 30;
    return { ...row, window: { day: s.day, startTime: s.startTime, endTime: s.endTime }, arriveEarlyMinutes: early, capacity: { allocated: n + 1, limit: s.capacity } };
  });

  route(app, 'patch', '/appointments/:id', 'appointment.write', async (req, tx) => {
    const body = z.object({ status: z.enum(['booked', 'cancelled', 'no_show']).optional(), sessionId: z.string().uuid().optional(), note: z.string().optional() }).parse(req.body);
    const [row] = await tx.update(appointment).set(body).where(and(eq(appointment.id, (req.params as any).id), eq(appointment.tenantId, req.ctx.tenantId))).returning();
    if (!row) throw new HttpError(404, 'NOT_FOUND');
    await emit(tx, req.ctx, 'appointment.updated', 'appointment', row.id, body);
    return row;
  });
}
