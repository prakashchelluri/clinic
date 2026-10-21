import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, sql, asc, desc, gte, lte, inArray, or, ilike } from 'drizzle-orm';
import { session, appointment, service, message, OPEN_STATUSES, patient, calendarBlock, procedureSession, procedureCatalog, room, practitioner, branch, type Routine } from '../db/schema.js';
import type { Tx } from '../db/index.js';
import { route } from '../lib/route.js';
import { emit, sent, todayIn, nextNumber } from '../lib/core.js';
import { HttpError, can } from '../lib/auth.js';
import { newToken, queueMessage, planReminders, dropReminders, originOf, bookingSettings } from '../lib/booking.js';

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
    allocated: sql<number>`(select coalesce(sum(coalesce(sv.places, 1)), 0)::int from appointment a left join service sv on sv.id = a.service_id where a.session_id = "session"."id" and a.status in ('requested','booked','confirmed','arrived'))`,
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
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(appointment).where(and(eq(appointment.sessionId, (req.params as any).id), sql`${appointment.status} in ('requested','booked','confirmed','arrived')`));
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
        const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(appointment).where(and(eq(appointment.sessionId, s.id), sql`${appointment.status} in ('requested','booked','confirmed','arrived')`));
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
      and not exists (select 1 from appointment a where a.session_id = s.id and a.status in ('requested','booked','confirmed','arrived'))`);
    await emit(tx, req.ctx, 'routine.updated', 'practitioner', pid, routine);
    return row;
  });

  // --- calendar: one view of a day for a doctor, rooms and the clinic ---
  /** A day with each window's patients (booked, arrived, no-show) so the calendar can show names, not just counts. */
  async function calendarDay(tx: Tx, t: string, day: string, pid: string | null) {
    const windows = await windowsForDay(tx, t, day, pid);
    const appts = windows.length ? await tx.select({ id: appointment.id, sessionId: appointment.sessionId, status: appointment.status, note: appointment.note, source: appointment.source, seriesId: appointment.seriesId, patientId: patient.id, name: patient.fullName, phone: patient.phone, serviceId: appointment.serviceId, service: service.name, color: service.color })
      .from(appointment).innerJoin(patient, eq(patient.id, appointment.patientId)).innerJoin(session, eq(session.id, appointment.sessionId)).leftJoin(service, eq(service.id, appointment.serviceId))
      .where(and(eq(appointment.tenantId, t), eq(session.day, day), sql`${appointment.status} in ('requested','booked','confirmed','arrived','no_show')`)).orderBy(asc(appointment.createdAt)) : [];
    const blocks = await tx.select().from(calendarBlock).where(and(eq(calendarBlock.tenantId, t), eq(calendarBlock.day, day), ...(pid ? [eq(calendarBlock.practitionerId, pid)] : [])));
    const procs = await tx.select({ ps: procedureSession, patient: patient.fullName, phone: patient.phone, procedure: procedureCatalog.name, room: room.name, doctor: practitioner.name })
      .from(procedureSession).innerJoin(patient, eq(patient.id, procedureSession.patientId)).leftJoin(procedureCatalog, eq(procedureCatalog.id, procedureSession.procedureId))
      .leftJoin(room, eq(room.id, procedureSession.roomId)).leftJoin(practitioner, eq(practitioner.id, procedureSession.practitionerId))
      .where(and(eq(procedureSession.tenantId, t), eq(procedureSession.day, day), sql`${procedureSession.state} not in ('cancelled','postponed')`, ...(pid ? [eq(procedureSession.practitionerId, pid)] : []))).orderBy(asc(procedureSession.startTime));
    return { day, windows: windows.map((w) => ({ ...w, appointments: appts.filter((a) => a.sessionId === w.id) })), blocks: blocks.filter((b) => b.kind !== 'procedure'),
      procedures: procs.map((p) => ({ ...p.ps, patient: p.patient, phone: p.phone, procedure: p.procedure, room: p.room, doctor: p.doctor })) };
  }
  route(app, 'get', '/calendar', 'appointment.read', async (req, tx) => {
    const q = req.query as any;
    return calendarDay(tx, req.ctx.tenantId, String(q.day ?? todayIn(req.ctx.timezone)), q.practitionerId || null);
  });
  /** Several days at once for the week view (at most 14). */
  route(app, 'get', '/calendar/range', 'appointment.read', async (req, tx) => {
    const q = z.object({ from: DAY.refine((d) => { const x = new Date(d + 'T00:00:00Z'); return !isNaN(+x) && x.toISOString().startsWith(d); }, 'BAD_DATE'), days: z.coerce.number().int().min(1).max(14).default(7), practitionerId: z.string().uuid().optional() }).parse(req.query);
    const out = [];
    for (let i = 0; i < q.days; i++) {
      const d = new Date(q.from + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + i);
      out.push(await calendarDay(tx, req.ctx.tenantId, d.toISOString().slice(0, 10), q.practitionerId ?? null));
    }
    return out;
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
    return tx.select({ a: appointment, p: { id: patient.id, fullName: patient.fullName, phone: patient.phone, patientNo: patient.patientNo }, s: { startTime: session.startTime, endTime: session.endTime, practitionerId: session.practitionerId }, svc: { name: service.name, color: service.color } })
      .from(appointment).innerJoin(patient, eq(patient.id, appointment.patientId)).innerJoin(session, eq(session.id, appointment.sessionId)).leftJoin(service, eq(service.id, appointment.serviceId))
      .where(and(eq(appointment.tenantId, req.ctx.tenantId), eq(session.day, day))).orderBy(asc(session.startTime), asc(appointment.createdAt))
      .then((rows) => rows.map((r) => ({ ...r.a, patient: r.p, window: r.s, service: r.svc?.name ? r.svc : null })));
  });

  const ApptIn = z.object({ sessionId: z.string().uuid(), patientId: z.string().uuid().optional(), newPatient: z.object({ fullName: z.string().trim().min(2).max(100), phone: z.string().regex(/^\d{10}$/).optional() }).optional(),
    serviceId: z.string().uuid().nullable().optional(), note: z.string().trim().max(500).optional(), source: z.enum(['phone', 'walk_in', 'online', 'repeat']).default('phone'), overbook: z.boolean().default(false), idempotencyKey: z.string().max(100).optional(),
    repeat: z.object({ everyWeeks: z.number().int().min(1).max(12), count: z.number().int().min(2).max(26) }).optional(), notify: z.boolean().default(true) });

  /** Check a window has room for one more booking of this visit type; throws WINDOW_FULL (with free alternatives) unless overbooking is allowed. */
  async function takePlace(tx: Tx, req: any, s: any, places: number, overbook: boolean) {
    const t = req.ctx.tenantId;
    const all = await windowsForDay(tx, t, s.day);
    const w = all.find((x) => x.id === s.id)!;
    const full = w.allocated + places > w.effectiveCapacity;
    if (full && !(overbook && can(req.perms, 'appointment.overbook'))) {
      throw new HttpError(409, 'WINDOW_FULL', { alternatives: all.filter((x) => x.free >= places).map((x) => ({ id: x.id, startTime: x.startTime, endTime: x.endTime, free: x.free, practitionerId: x.practitionerId })), overrideRequires: 'appointment.overbook', reductions: w.reductions });
    }
    return { w, full };
  }
  async function serviceFor(tx: Tx, t: string, id?: string | null, practitionerId?: string | null) {
    if (!id) return null;
    const svc = await tx.select().from(service).where(and(eq(service.id, id), eq(service.tenantId, t))).then((r) => r[0]);
    if (!svc || !svc.active) throw new HttpError(404, 'SERVICE_NOT_FOUND');
    if (practitionerId && svc.practitionerIds.length && !svc.practitionerIds.includes(practitionerId)) throw new HttpError(409, 'SERVICE_NOT_OFFERED');
    return svc;
  }

  /** Book: checked against *effective* capacity, idempotent, creates a minimal patient for a new caller; optional weekly repeat. */
  route(app, 'post', '/appointments', 'appointment.write', async (req, tx) => {
    const body = ApptIn.parse(req.body); const t = req.ctx.tenantId; const origin = originOf(req);
    if (body.idempotencyKey) {
      const dup = await tx.select().from(appointment).where(and(eq(appointment.tenantId, t), eq(appointment.idempotencyKey, body.idempotencyKey))).then((r) => r[0]);
      if (dup) return dup;
    }
    const s = await tx.select().from(session).where(and(eq(session.id, body.sessionId), eq(session.tenantId, t))).for('update').then((r) => r[0]);
    if (!s) throw new HttpError(404, 'SESSION_NOT_FOUND');
    const svc = await serviceFor(tx, t, body.serviceId, s.practitionerId);
    const { w, full } = await takePlace(tx, req, s, svc?.places ?? 1, body.overbook);
    if (body.patientId) {
      const twice = await tx.select({ id: appointment.id }).from(appointment).where(and(eq(appointment.tenantId, t), eq(appointment.patientId, body.patientId), eq(appointment.sessionId, s.id), inArray(appointment.status, [...OPEN_STATUSES]))).limit(1);
      if (twice.length) throw new HttpError(409, 'ALREADY_BOOKED');
    }
    let patientId = body.patientId;
    if (!patientId) {
      if (!body.newPatient) throw new HttpError(400, 'PATIENT_REQUIRED');
      const num = await nextNumber(tx, t, 'patient_no', 'tenant');
      const [p] = await tx.insert(patient).values({ tenantId: t, patientNo: `P${String(num).padStart(5, '0')}`, fullName: body.newPatient.fullName, phone: body.newPatient.phone ?? null }).returning();
      patientId = p.id;
    }
    const [row] = await tx.insert(appointment).values({ tenantId: t, patientId, sessionId: s.id, serviceId: svc?.id ?? null, note: body.note, source: body.source, overbooked: full, idempotencyKey: body.idempotencyKey, publicToken: newToken() }).returning();
    await emit(tx, req.ctx, 'appointment.booked', 'appointment', row.id, { patientId, sessionId: s.id, day: s.day, window: [s.startTime, s.endTime], overbooked: full, serviceId: svc?.id ?? null });

    // Repeat: same doctor, same window time, every N weeks. Dates without that window or with no room are reported, not forced.
    const series = { created: [] as string[], skipped: [] as { day: string; reason: string }[] };
    if (body.repeat) {
      await tx.update(appointment).set({ seriesId: row.id }).where(eq(appointment.id, row.id));
      for (let i = 1; i < body.repeat.count; i++) {
        const d = new Date(s.day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 7 * body.repeat.everyWeeks * i); const day = d.toISOString().slice(0, 10);
        const ws = await windowsForDay(tx, t, day, s.practitionerId);
        const target = ws.find((x) => x.startTime === s.startTime);
        if (!target) { series.skipped.push({ day, reason: 'no window at this time' }); continue; }
        if (target.allocated + (svc?.places ?? 1) > target.effectiveCapacity) { series.skipped.push({ day, reason: 'full' }); continue; }
        const [r2] = await tx.insert(appointment).values({ tenantId: t, patientId: patientId!, sessionId: target.id, serviceId: svc?.id ?? null, note: body.note, source: 'repeat', seriesId: row.id, publicToken: newToken() }).returning();
        series.created.push(day);
        await planReminders(tx, t, r2.id, origin);
      }
    }
    const cfg = bookingSettings((await tx.query.tenant.findFirst({ where: (tn, { eq }) => eq(tn.id, t) }))?.settings);
    if (body.notify && cfg.messages.sendConfirmation) await queueMessage(tx, t, row.id, 'confirmation', origin);
    await planReminders(tx, t, row.id, origin);
    return { ...row, seriesId: body.repeat ? row.id : null, series: body.repeat ? series : undefined, window: { day: s.day, startTime: s.startTime, endTime: s.endTime }, arriveEarlyMinutes: cfg.arriveEarlyMinutes, capacity: { allocated: w.allocated + (svc?.places ?? 1), limit: w.effectiveCapacity } };
  });

  /** Change status, move to another window (drag), or edit the note. Cancelling can take the rest of a repeat series with it. */
  route(app, 'patch', '/appointments/:id', 'appointment.write', async (req, tx) => {
    const body = z.object({ status: z.enum(['booked', 'confirmed', 'cancelled', 'no_show']).optional(), sessionId: z.string().uuid().optional(), note: z.string().trim().max(500).optional(), serviceId: z.string().uuid().nullable().optional(),
      cancelReason: z.string().trim().max(300).optional(), overbook: z.boolean().default(false), series: z.enum(['one', 'future']).default('one'), notify: z.boolean().default(true) }).parse(req.body);
    const t = req.ctx.tenantId; const id = (req.params as any).id; const origin = originOf(req);
    const cur = await tx.select().from(appointment).where(and(eq(appointment.id, id), eq(appointment.tenantId, t))).then((r) => r[0]);
    if (!cur) throw new HttpError(404, 'NOT_FOUND');
    const changes: Record<string, any> = {};
    if (body.note !== undefined) changes.note = body.note;
    let moved = false;
    if (body.serviceId !== undefined) changes.serviceId = (await serviceFor(tx, t, body.serviceId))?.id ?? null;
    if (body.sessionId && body.sessionId !== cur.sessionId) {
      // Moving (drag on the calendar): same capacity rule as booking; an arrived patient is already in the queue.
      if (!(OPEN_STATUSES as readonly string[]).includes(cur.status)) throw new HttpError(409, 'NOT_MOVABLE', { status: cur.status });
      const s = await tx.select().from(session).where(and(eq(session.id, body.sessionId), eq(session.tenantId, t))).for('update').then((r) => r[0]);
      if (!s) throw new HttpError(404, 'SESSION_NOT_FOUND');
      if (s.day < todayIn(req.ctx.timezone)) throw new HttpError(409, 'PAST_WINDOW');
      const svc = cur.serviceId ? await tx.select().from(service).where(eq(service.id, cur.serviceId)).then((r) => r[0]) : null;
      const { full } = await takePlace(tx, req, s, svc?.places ?? 1, body.overbook);
      changes.sessionId = s.id; changes.overbooked = full; moved = true;
    } else if (body.sessionId && !(OPEN_STATUSES as readonly string[]).includes(cur.status)) throw new HttpError(409, 'NOT_MOVABLE', { status: cur.status });
    if (body.status) {
      if (cur.status === 'arrived') throw new HttpError(409, 'ALREADY_ARRIVED');
      changes.status = body.status;
      if (body.status === 'confirmed') changes.confirmedAt = new Date().toISOString();
      if (body.status === 'cancelled') changes.cancelReason = body.cancelReason ?? null;
    }
    const [row] = await tx.update(appointment).set(changes).where(and(eq(appointment.id, id), eq(appointment.tenantId, t))).returning();
    await emit(tx, req.ctx, moved ? 'appointment.moved' : 'appointment.updated', 'appointment', row.id, { ...body, from: moved ? cur.sessionId : undefined });

    const closed = ['cancelled', 'no_show'].includes(row.status);
    let alsoCancelled = 0;
    if (closed) {
      await dropReminders(tx, t, [row.id]);
      if (row.status === 'cancelled' && body.series === 'future' && cur.seriesId) {
        const s0 = await tx.select().from(session).where(eq(session.id, row.sessionId)).then((r) => r[0]);
        const rest = await tx.select({ id: appointment.id }).from(appointment).innerJoin(session, eq(session.id, appointment.sessionId))
          .where(and(eq(appointment.tenantId, t), eq(appointment.seriesId, cur.seriesId), inArray(appointment.status, [...OPEN_STATUSES]), gte(session.day, s0.day)));
        const ids = rest.map((r) => r.id).filter((x) => x !== row.id);
        if (ids.length) { await tx.update(appointment).set({ status: 'cancelled', cancelReason: body.cancelReason ?? 'series cancelled' }).where(inArray(appointment.id, ids)); await dropReminders(tx, t, ids); }
        alsoCancelled = ids.length;
      }
      if (row.status === 'cancelled' && body.notify && (OPEN_STATUSES as readonly string[]).includes(cur.status)) await queueMessage(tx, t, row.id, 'cancelled', origin);
    } else if (moved || body.status === 'booked' || body.status === 'confirmed') {
      await planReminders(tx, t, row.id, origin);
      if (moved && body.notify) await queueMessage(tx, t, row.id, 'moved', origin);
    }
    return { ...row, alsoCancelled };
  });

  /** Online requests: reception approves (books the place for good and tells the patient) or declines with a reason. */
  route(app, 'post', '/appointments/:id/approve', 'appointment.write', async (req, tx) => {
    const t = req.ctx.tenantId; const id = (req.params as any).id;
    const [row] = await tx.update(appointment).set({ status: 'booked' }).where(and(eq(appointment.id, id), eq(appointment.tenantId, t), eq(appointment.status, 'requested'))).returning();
    if (!row) throw new HttpError(409, 'NOT_A_REQUEST');
    await emit(tx, req.ctx, 'appointment.approved', 'appointment', row.id, {});
    await queueMessage(tx, t, row.id, 'confirmation', originOf(req));
    await planReminders(tx, t, row.id, originOf(req));
    return row;
  });
  route(app, 'post', '/appointments/:id/decline', 'appointment.write', async (req, tx) => {
    const { reason } = z.object({ reason: z.string().trim().max(300).default('') }).parse(req.body ?? {}); const t = req.ctx.tenantId; const id = (req.params as any).id;
    const [row] = await tx.update(appointment).set({ status: 'cancelled', cancelReason: reason || 'declined' }).where(and(eq(appointment.id, id), eq(appointment.tenantId, t), eq(appointment.status, 'requested'))).returning();
    if (!row) throw new HttpError(409, 'NOT_A_REQUEST');
    await emit(tx, req.ctx, 'appointment.declined', 'appointment', row.id, { reason });
    await queueMessage(tx, t, row.id, 'declined', originOf(req), { extra: { reason } });
    return row;
  });
  /** Send a reminder now (reception's "nudge"). */
  route(app, 'post', '/appointments/:id/remind', 'appointment.write', async (req, tx) => {
    const t = req.ctx.tenantId; const id = (req.params as any).id;
    const cur = await tx.select().from(appointment).where(and(eq(appointment.id, id), eq(appointment.tenantId, t))).then((r) => r[0]);
    if (!cur) throw new HttpError(404, 'NOT_FOUND');
    if (!(OPEN_STATUSES as readonly string[]).includes(cur.status)) throw new HttpError(409, 'NOT_OPEN');
    return queueMessage(tx, t, id, 'reminder', originOf(req));
  });

  /** One booking with everything the drawer shows: patient history, visit type, series position, messages. */
  route(app, 'get', '/appointments/:id', 'appointment.read', async (req, tx) => {
    const t = req.ctx.tenantId; const id = (req.params as any).id;
    const r = await tx.select({ a: appointment, s: session, p: patient, svc: service, doctor: practitioner.name }).from(appointment)
      .innerJoin(session, eq(session.id, appointment.sessionId)).innerJoin(patient, eq(patient.id, appointment.patientId))
      .leftJoin(service, eq(service.id, appointment.serviceId)).leftJoin(practitioner, eq(practitioner.id, session.practitionerId))
      .where(and(eq(appointment.id, id), eq(appointment.tenantId, t))).then((x) => x[0]);
    if (!r) throw new HttpError(404, 'NOT_FOUND');
    const [hist] = await tx.select({ total: sql<number>`count(*)::int`, noShows: sql<number>`count(*) filter (where ${appointment.status} = 'no_show')::int`, arrived: sql<number>`count(*) filter (where ${appointment.status} = 'arrived')::int` })
      .from(appointment).where(and(eq(appointment.tenantId, t), eq(appointment.patientId, r.p.id)));
    let series = null;
    if (r.a.seriesId) {
      const all = await tx.select({ id: appointment.id, day: session.day, status: appointment.status }).from(appointment).innerJoin(session, eq(session.id, appointment.sessionId))
        .where(and(eq(appointment.tenantId, t), eq(appointment.seriesId, r.a.seriesId))).orderBy(asc(session.day));
      series = { index: all.findIndex((x) => x.id === r.a.id) + 1, total: all.length, items: all };
    }
    const msgs = await tx.select().from(message).where(and(eq(message.tenantId, t), eq(message.appointmentId, id))).orderBy(desc(message.sendAfter));
    const ten = await tx.query.tenant.findFirst({ where: (tn, { eq }) => eq(tn.id, t) });
    return { ...r.a, window: { day: r.s.day, startTime: r.s.startTime, endTime: r.s.endTime, practitionerId: r.s.practitionerId, doctor: r.doctor },
      patient: { id: r.p.id, fullName: r.p.fullName, phone: r.p.phone, patientNo: r.p.patientNo, ageYears: r.p.ageYears, sex: r.p.sex }, history: hist,
      service: r.svc, series, messages: msgs, link: r.a.publicToken && ten ? `${originOf(req)}/a/${ten.slug}/${r.a.publicToken}` : null };
  });

  /** The Bookings list: requests, upcoming, unconfirmed, past, no-shows, cancelled; filterable. */
  route(app, 'get', '/bookings', 'appointment.read', async (req, tx) => {
    const q = z.object({ tab: z.enum(['requests', 'upcoming', 'unconfirmed', 'past', 'no_show', 'cancelled']).default('upcoming'), practitionerId: z.string().uuid().optional(), serviceId: z.string().uuid().optional(),
      from: DAY.optional(), to: DAY.optional(), q: z.string().trim().max(60).optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }).parse(req.query);
    const t = req.ctx.tenantId; const today = todayIn(req.ctx.timezone);
    const conds: any[] = [eq(appointment.tenantId, t)];
    if (q.tab === 'requests') conds.push(eq(appointment.status, 'requested'));
    if (q.tab === 'upcoming') conds.push(inArray(appointment.status, ['booked', 'confirmed']), gte(session.day, today));
    if (q.tab === 'unconfirmed') conds.push(eq(appointment.status, 'booked'), gte(session.day, today));
    if (q.tab === 'past') conds.push(sql`${session.day} < ${today}`);
    if (q.tab === 'no_show') conds.push(eq(appointment.status, 'no_show'));
    if (q.tab === 'cancelled') conds.push(eq(appointment.status, 'cancelled'));
    if (q.practitionerId) conds.push(eq(session.practitionerId, q.practitionerId));
    if (q.serviceId) conds.push(eq(appointment.serviceId, q.serviceId));
    if (q.from) conds.push(gte(session.day, q.from));
    if (q.to) conds.push(lte(session.day, q.to));
    if (q.q) { const like = `%${q.q}%`; conds.push(or(ilike(patient.fullName, like), ilike(patient.phone, like), ilike(patient.patientNo, like))); }
    const pastFirst = ['past', 'no_show', 'cancelled'].includes(q.tab);
    const rows = await tx.select({ a: appointment, day: session.day, startTime: session.startTime, endTime: session.endTime, practitionerId: session.practitionerId, doctor: practitioner.name,
      p: { id: patient.id, fullName: patient.fullName, phone: patient.phone, patientNo: patient.patientNo }, svc: { id: service.id, name: service.name, color: service.color },
      noShows: sql<number>`(select count(*)::int from appointment x where x.patient_id = ${appointment.patientId} and x.status = 'no_show')`,
      lastMsg: sql<any>`(select json_build_object('kind', m.kind, 'status', m.status, 'at', coalesce(m.sent_at, m.send_after)) from message m where m.appointment_id = ${appointment.id} and m.status <> 'skipped' order by coalesce(m.sent_at, m.send_after) desc limit 1)` })
      .from(appointment).innerJoin(session, eq(session.id, appointment.sessionId)).innerJoin(patient, eq(patient.id, appointment.patientId))
      .leftJoin(service, eq(service.id, appointment.serviceId)).leftJoin(practitioner, eq(practitioner.id, session.practitionerId))
      .where(and(...conds)).orderBy(pastFirst ? desc(session.day) : asc(session.day), pastFirst ? desc(session.startTime) : asc(session.startTime), asc(appointment.createdAt)).limit(q.limit);
    return rows.map((r) => ({ ...r.a, window: { day: r.day, startTime: r.startTime, endTime: r.endTime, practitionerId: r.practitionerId, doctor: r.doctor }, patient: r.p, service: r.svc?.id ? r.svc : null, noShows: r.noShows, lastMessage: r.lastMsg }));
  });
  route(app, 'get', '/bookings/counts', 'appointment.read', async (req, tx) => {
    const today = todayIn(req.ctx.timezone);
    const [c] = await tx.select({ requests: sql<number>`count(*) filter (where ${appointment.status} = 'requested')::int`, unconfirmed: sql<number>`count(*) filter (where ${appointment.status} = 'booked' and ${session.day} >= ${today})::int` })
      .from(appointment).innerJoin(session, eq(session.id, appointment.sessionId)).where(eq(appointment.tenantId, req.ctx.tenantId));
    return c;
  });

  /** Message outbox, newest first: what went out, what is waiting, what failed. */
  route(app, 'get', '/messages', 'appointment.read', async (req, tx) => {
    const q = z.object({ status: z.enum(['pending', 'sent', 'logged', 'failed', 'skipped']).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    return tx.select({ m: message, patient: patient.fullName }).from(message).leftJoin(patient, eq(patient.id, message.patientId))
      .where(and(eq(message.tenantId, req.ctx.tenantId), ...(q.status ? [eq(message.status, q.status)] : []))).orderBy(desc(message.sendAfter)).limit(q.limit)
      .then((r) => r.map((x) => ({ ...x.m, patient: x.patient })));
  });
}
