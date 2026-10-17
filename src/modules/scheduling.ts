import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, sql, asc } from 'drizzle-orm';
import { session, appointment, patient, calendarBlock, procedureSession, procedureCatalog, room, practitioner, branch, type Routine } from '../db/schema.js';
import type { Tx } from '../db/index.js';
import { route } from '../lib/route.js';
import { emit, sent, todayIn, nextNumber } from '../lib/core.js';
import { HttpError, can } from '../lib/auth.js';

export const toMin = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
export const toHHMM = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const overlapMin = (aS: number, aE: number, bS: number, bE: number) => Math.max(0, Math.min(aE, bE) - Math.max(aS, bS));
const HHMM = z.string().regex(/^\d{2}:\d{2}$/); const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** 0=Sunday … 6=Saturday for a YYYY-MM-DD day. */
const weekday = (day: string) => new Date(day + 'T00:00:00Z').getUTCDay();

/**
 * Lazy materialisation: the first time a day is looked at, every doctor with a weekly routine gets their OP windows
 * for that day created from it. Doctors never fill a calendar; they only record exceptions.
 */
export async function ensureDaySessions(tx: Tx, t: string, day: string) {
  const docs = await tx.select().from(practitioner).where(and(eq(practitioner.tenantId, t), eq(practitioner.active, true)));
  const withRoutine = docs.filter((d) => d.routine?.days?.[String(weekday(day))]?.length);
  if (!withRoutine.length) return;
  const existing = await tx.select({ p: session.practitionerId }).from(session).where(and(eq(session.tenantId, t), eq(session.day, day)));
  const have = new Set(existing.map((e) => e.p));
  const todo = withRoutine.filter((d) => !have.has(d.id));
  if (!todo.length) return;
  const br = (await tx.select().from(branch).where(eq(branch.tenantId, t)))[0];
  const values: any[] = [];
  for (const d of todo) {
    const r = d.routine as Routine; const len = r.windowMinutes || 60;
    for (const [start, end] of r.days[String(weekday(day))]) for (let m = toMin(start); m + len <= toMin(end); m += len)
      values.push({ tenantId: t, branchId: br.id, practitionerId: d.id, day, startTime: toHHMM(m), endTime: toHHMM(m + len), capacity: r.capacity || 7, source: 'routine' });
  }
  if (values.length) await tx.insert(session).values(values);
}

/**
 * Windows for a day with allocated counts and *effective* capacity.
 * A block (break, leave, procedure) on the window's doctor removes a proportional share of places:
 * 7 places/hour with a 30-minute procedure → 4 (rounded). This is the rule reception described.
 */
export async function windowsForDay(tx: Tx, t: string, day: string, practitionerId?: string | null) {
  await ensureDaySessions(tx, t, day);
  const rows = await tx.select({
    s: session,
    // explicit "session"."id": an embedded column renders unqualified here and would match a.id instead
    allocated: sql<number>`(select count(*)::int from appointment a where a.session_id = "session"."id" and a.status in ('booked','arrived'))`,
  }).from(session).where(and(eq(session.tenantId, t), eq(session.day, day), ...(practitionerId ? [eq(session.practitionerId, practitionerId)] : []))).orderBy(asc(session.startTime));
  const blocks = await tx.select().from(calendarBlock).where(and(eq(calendarBlock.tenantId, t), eq(calendarBlock.day, day)));
  return rows.map((r) => {
    const s = r.s; const sS = toMin(s.startTime), sE = toMin(s.endTime); const len = Math.max(1, sE - sS);
    const hits = blocks.filter((b) => b.practitionerId && b.practitionerId === s.practitionerId).map((b) => ({ ...b, minutes: overlapMin(sS, sE, toMin(b.startTime), toMin(b.endTime)) })).filter((b) => b.minutes > 0);
    const blocked = Math.min(len, hits.reduce((m, b) => m + b.minutes, 0));
    const effective = Math.max(0, Math.round(s.capacity * (1 - blocked / len)));
    return { ...s, allocated: r.allocated, effectiveCapacity: effective, free: effective - r.allocated,
      reductions: hits.map((b) => ({ kind: b.kind, note: b.note, startTime: b.startTime, endTime: b.endTime, minutes: b.minutes })) };
  });
}

export function schedulingRoutes(app: FastifyInstance) {
  route(app, 'get', '/sessions', 'appointment.read', async (req, tx) => {
    const q = req.query as any;
    return windowsForDay(tx, req.ctx.tenantId, String(q.day ?? todayIn(req.ctx.timezone)), q.practitionerId || null);
  });

  const SessionIn = z.object({ branchId: z.string().uuid(), practitionerId: z.string().uuid().nullable().optional(), day: DAY, startTime: HHMM, endTime: HHMM, capacity: z.number().int().min(0).max(100), note: z.string().optional() });
  route(app, 'post', '/sessions', 'appointment.write', async (req, tx) => (await tx.insert(session).values({ ...SessionIn.parse(req.body), tenantId: req.ctx.tenantId }).returning())[0]);
  route(app, 'patch', '/sessions/:id', 'appointment.write', async (req, tx) => {
    const [row] = await tx.update(session).set(sent(SessionIn.partial().parse(req.body), req.body)).where(and(eq(session.id, (req.params as any).id), eq(session.tenantId, req.ctx.tenantId))).returning();
    if (!row) throw new HttpError(404, 'NOT_FOUND'); return row;
  });
  route(app, 'delete', '/sessions/:id', 'appointment.write', async (req, tx) => {
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(appointment).where(and(eq(appointment.sessionId, (req.params as any).id), sql`${appointment.status} in ('booked','arrived')`));
    if (n > 0) throw new HttpError(409, 'HAS_BOOKINGS', { bookings: n });
    await tx.delete(session).where(and(eq(session.id, (req.params as any).id), eq(session.tenantId, req.ctx.tenantId))); return { ok: true };
  });

  /** The doctor's "I'm available 10 to 1 and 4 to 8, lunch at 1": generates hourly windows, skipping breaks, and records the breaks as blocks. */
  route(app, 'post', '/sessions/generate', 'appointment.write', async (req, tx) => {
    const body = z.object({ day: DAY, practitionerId: z.string().uuid(), branchId: z.string().uuid().optional(),
      ranges: z.array(z.object({ startTime: HHMM, endTime: HHMM })).min(1), windowMinutes: z.number().int().min(15).max(240).default(60), capacity: z.number().int().min(1).max(50),
      breaks: z.array(z.object({ startTime: HHMM, endTime: HHMM, note: z.string().optional() })).default([]), replace: z.boolean().default(false) }).parse(req.body);
    const t = req.ctx.tenantId;
    const branchId = body.branchId ?? (await tx.query.branch.findFirst({ where: (b, { eq }) => eq(b.tenantId, t) }))!.id;
    if (body.replace) {
      const existing = await tx.select({ id: session.id }).from(session).where(and(eq(session.tenantId, t), eq(session.day, body.day), eq(session.practitionerId, body.practitionerId)));
      for (const s of existing) {
        const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(appointment).where(and(eq(appointment.sessionId, s.id), sql`${appointment.status} in ('booked','arrived')`));
        if (n === 0) await tx.delete(session).where(eq(session.id, s.id));
      }
      await tx.delete(calendarBlock).where(and(eq(calendarBlock.tenantId, t), eq(calendarBlock.day, body.day), eq(calendarBlock.practitionerId, body.practitionerId), eq(calendarBlock.kind, 'break')));
    }
    const values: any[] = [];
    for (const r of body.ranges) for (let m = toMin(r.startTime); m + body.windowMinutes <= toMin(r.endTime); m += body.windowMinutes) {
      const s = m, e = m + body.windowMinutes;
      if (body.breaks.some((b) => toMin(b.startTime) <= s && toMin(b.endTime) >= e)) continue; // fully inside a break
      values.push({ tenantId: t, branchId, practitionerId: body.practitionerId, day: body.day, startTime: toHHMM(s), endTime: toHHMM(e), capacity: body.capacity });
    }
    const created = values.length ? await tx.insert(session).values(values).returning() : [];
    if (body.breaks.length) await tx.insert(calendarBlock).values(body.breaks.map((b) => ({ tenantId: t, practitionerId: body.practitionerId, day: body.day, startTime: b.startTime, endTime: b.endTime, kind: 'break', note: b.note ?? 'Break' })));
    await emit(tx, req.ctx, 'availability.set', 'practitioner', body.practitionerId, { day: body.day, windows: created.length, breaks: body.breaks.length });
    return { windows: created.length, breaks: body.breaks.length };
  });

  route(app, 'post', '/sessions/copy', 'appointment.write', async (req, tx) => {
    const { fromDay, toDay } = z.object({ fromDay: DAY, toDay: DAY }).parse(req.body); const t = req.ctx.tenantId;
    const src = await tx.select().from(session).where(and(eq(session.tenantId, t), eq(session.day, fromDay)));
    const blocks = await tx.select().from(calendarBlock).where(and(eq(calendarBlock.tenantId, t), eq(calendarBlock.day, fromDay), eq(calendarBlock.kind, 'break')));
    if (blocks.length) await tx.insert(calendarBlock).values(blocks.map(({ id, createdAt, procedureSessionId, ...b }) => ({ ...b, day: toDay })));
    if (!src.length) return [];
    return tx.insert(session).values(src.map(({ id, createdAt, ...s }) => ({ ...s, day: toDay }))).returning();
  });

  // --- weekly routine: set once by the doctor (own) or the owner ---
  const RoutineIn = z.object({ days: z.record(z.string().regex(/^[0-6]$/), z.array(z.tuple([HHMM, HHMM]))), capacity: z.number().int().min(1).max(50), windowMinutes: z.number().int().min(15).max(240) });
  route(app, 'put', '/calendar/routine/:practitionerId', null, async (req, tx) => {
    const pid = (req.params as any).practitionerId; const t = req.ctx.tenantId;
    if (!(can(req.perms, 'config.write') || req.ctx.practitionerId === pid)) throw new HttpError(403, 'FORBIDDEN:routine');
    const routine = RoutineIn.parse(req.body);
    const [row] = await tx.update(practitioner).set({ routine }).where(and(eq(practitioner.id, pid), eq(practitioner.tenantId, t))).returning();
    if (!row) throw new HttpError(404, 'NOT_FOUND');
    // Future routine-generated windows without bookings are dropped so they regenerate from the new routine.
    const today = todayIn(req.ctx.timezone);
    await tx.execute(sql`delete from session s where s.tenant_id = ${t} and s.practitioner_id = ${pid} and s.source = 'routine' and s.day >= ${today}
      and not exists (select 1 from appointment a where a.session_id = s.id and a.status in ('booked','arrived'))`);
    await emit(tx, req.ctx, 'routine.updated', 'practitioner', pid, routine);
    return row;
  });

  // --- calendar: one view of a day for a doctor, rooms and the clinic ---
  route(app, 'get', '/calendar', 'appointment.read', async (req, tx) => {
    const q = req.query as any; const t = req.ctx.tenantId; const day = String(q.day ?? todayIn(req.ctx.timezone));
    const windows = await windowsForDay(tx, t, day, q.practitionerId || null);
    const blocks = await tx.select().from(calendarBlock).where(and(eq(calendarBlock.tenantId, t), eq(calendarBlock.day, day), ...(q.practitionerId ? [eq(calendarBlock.practitionerId, q.practitionerId)] : [])));
    const procs = await tx.select({ ps: procedureSession, patient: patient.fullName, phone: patient.phone, procedure: procedureCatalog.name, room: room.name, doctor: practitioner.name })
      .from(procedureSession).innerJoin(patient, eq(patient.id, procedureSession.patientId)).leftJoin(procedureCatalog, eq(procedureCatalog.id, procedureSession.procedureId))
      .leftJoin(room, eq(room.id, procedureSession.roomId)).leftJoin(practitioner, eq(practitioner.id, procedureSession.practitionerId))
      .where(and(eq(procedureSession.tenantId, t), eq(procedureSession.day, day), sql`${procedureSession.state} not in ('cancelled','postponed')`, ...(q.practitionerId ? [eq(procedureSession.practitionerId, q.practitionerId)] : []))).orderBy(asc(procedureSession.startTime));
    return { day, windows, blocks: blocks.filter((b) => b.kind !== 'procedure'), procedures: procs.map((p) => ({ ...p.ps, patient: p.patient, phone: p.phone, procedure: p.procedure, room: p.room, doctor: p.doctor })) };
  });
  route(app, 'post', '/calendar/blocks', 'appointment.write', async (req, tx) => {
    const body = z.object({ practitionerId: z.string().uuid().nullable().optional(), roomId: z.string().uuid().nullable().optional(), day: DAY, startTime: HHMM, endTime: HHMM, kind: z.enum(['break', 'leave', 'other']), note: z.string().optional() }).parse(req.body);
    if (toMin(body.endTime) <= toMin(body.startTime)) throw new HttpError(400, 'BAD_RANGE');
    const [row] = await tx.insert(calendarBlock).values({ ...body, tenantId: req.ctx.tenantId }).returning();
    await emit(tx, req.ctx, 'calendar.blocked', 'calendar_block', row.id, body);
    return row;
  });
  route(app, 'delete', '/calendar/blocks/:id', 'appointment.write', async (req, tx) => {
    const [row] = await tx.delete(calendarBlock).where(and(eq(calendarBlock.id, (req.params as any).id), eq(calendarBlock.tenantId, req.ctx.tenantId), sql`${calendarBlock.kind} <> 'procedure'`)).returning();
    if (!row) throw new HttpError(404, 'NOT_FOUND'); return { ok: true };
  });

  // --- appointments ---
  route(app, 'get', '/appointments', 'appointment.read', async (req, tx) => {
    const day = String((req.query as any).day ?? todayIn(req.ctx.timezone));
    return tx.select({ a: appointment, p: { id: patient.id, fullName: patient.fullName, phone: patient.phone, patientNo: patient.patientNo }, s: { startTime: session.startTime, endTime: session.endTime, practitionerId: session.practitionerId } })
      .from(appointment).innerJoin(patient, eq(patient.id, appointment.patientId)).innerJoin(session, eq(session.id, appointment.sessionId))
      .where(and(eq(appointment.tenantId, req.ctx.tenantId), eq(session.day, day))).orderBy(asc(session.startTime), asc(appointment.createdAt))
      .then((rows) => rows.map((r) => ({ ...r.a, patient: r.p, window: r.s })));
  });

  const ApptIn = z.object({ sessionId: z.string().uuid(), patientId: z.string().uuid().optional(), newPatient: z.object({ fullName: z.string().trim().min(2).max(100), phone: z.string().regex(/^\d{10}$/).optional() }).optional(),
    note: z.string().optional(), source: z.string().default('phone'), overbook: z.boolean().default(false), idempotencyKey: z.string().optional() });
  /** Book: checked against *effective* capacity, idempotent, creates a minimal patient for a new caller. */
  route(app, 'post', '/appointments', 'appointment.write', async (req, tx) => {
    const body = ApptIn.parse(req.body); const t = req.ctx.tenantId;
    if (body.idempotencyKey) {
      const dup = await tx.select().from(appointment).where(and(eq(appointment.tenantId, t), eq(appointment.idempotencyKey, body.idempotencyKey))).then((r) => r[0]);
      if (dup) return dup;
    }
    const s = await tx.select().from(session).where(and(eq(session.id, body.sessionId), eq(session.tenantId, t))).for('update').then((r) => r[0]);
    if (!s) throw new HttpError(404, 'SESSION_NOT_FOUND');
    const w = (await windowsForDay(tx, t, s.day)).find((x) => x.id === s.id)!;
    const full = w.allocated >= w.effectiveCapacity;
    if (full && !(body.overbook && can(req.perms, 'appointment.overbook'))) {
      const alts = (await windowsForDay(tx, t, s.day)).filter((x) => x.free > 0).map((x) => ({ id: x.id, startTime: x.startTime, endTime: x.endTime, free: x.free, practitionerId: x.practitionerId }));
      throw new HttpError(409, 'WINDOW_FULL', { alternatives: alts, overrideRequires: 'appointment.overbook', reductions: w.reductions });
    }
    if (body.patientId) {
      const twice = await tx.select({ id: appointment.id }).from(appointment).where(and(eq(appointment.tenantId, t), eq(appointment.patientId, body.patientId), eq(appointment.sessionId, s.id), eq(appointment.status, 'booked'))).limit(1);
      if (twice.length) throw new HttpError(409, 'ALREADY_BOOKED');
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
    return { ...row, window: { day: s.day, startTime: s.startTime, endTime: s.endTime }, arriveEarlyMinutes: settings.scheduling?.arriveEarlyMinutes ?? 30, capacity: { allocated: w.allocated + 1, limit: w.effectiveCapacity } };
  });

  route(app, 'patch', '/appointments/:id', 'appointment.write', async (req, tx) => {
    const body = z.object({ status: z.enum(['booked', 'cancelled', 'no_show']).optional(), sessionId: z.string().uuid().optional(), note: z.string().optional() }).parse(req.body);
    const [row] = await tx.update(appointment).set(body).where(and(eq(appointment.id, (req.params as any).id), eq(appointment.tenantId, req.ctx.tenantId))).returning();
    if (!row) throw new HttpError(404, 'NOT_FOUND');
    await emit(tx, req.ctx, 'appointment.updated', 'appointment', row.id, body);
    return row;
  });
}
