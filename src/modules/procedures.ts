import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, sql, asc } from 'drizzle-orm';
import { procedureSession, calendarBlock, recommendation, procedureCatalog, room, practitioner, patient } from '../db/schema.js';
import type { Tx } from '../db/index.js';
import { route } from '../lib/route.js';
import { emit, todayIn } from '../lib/core.js';
import { HttpError } from '../lib/auth.js';
import { toMin, toHHMM } from './scheduling.js';

const HHMM = z.string().regex(/^\d{2}:\d{2}$/); const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Room and doctor conflicts for a proposed slot. App-level check inside the transaction; rooms are row-locked. */
async function conflicts(tx: Tx, t: string, day: string, start: string, end: string, roomId?: string | null, practitionerId?: string | null, ignoreId?: string) {
  const s = toMin(start), e = toMin(end);
  const out: { kind: string; who: string; startTime: string; endTime: string }[] = [];
  if (roomId) await tx.execute(sql`select id from room where id = ${roomId} for update`);
  const rows = await tx.select({ ps: procedureSession, roomName: room.name, patient: patient.fullName }).from(procedureSession).leftJoin(room, eq(room.id, procedureSession.roomId)).innerJoin(patient, eq(patient.id, procedureSession.patientId))
    .where(and(eq(procedureSession.tenantId, t), eq(procedureSession.day, day), sql`${procedureSession.state} not in ('cancelled','postponed','completed','missed')`));
  for (const r of rows) {
    if (ignoreId && r.ps.id === ignoreId) continue;
    const overlaps = toMin(r.ps.startTime) < e && toMin(r.ps.endTime) > s;
    if (!overlaps) continue;
    if (roomId && r.ps.roomId === roomId) out.push({ kind: 'room', who: `${r.roomName} · ${r.patient}`, startTime: r.ps.startTime, endTime: r.ps.endTime });
    if (practitionerId && r.ps.practitionerId === practitionerId) out.push({ kind: 'doctor', who: r.patient, startTime: r.ps.startTime, endTime: r.ps.endTime });
  }
  if (practitionerId) {
    const blocks = await tx.select().from(calendarBlock).where(and(eq(calendarBlock.tenantId, t), eq(calendarBlock.day, day), eq(calendarBlock.practitionerId, practitionerId), sql`${calendarBlock.kind} in ('break','leave','other')`));
    for (const b of blocks) if (toMin(b.startTime) < e && toMin(b.endTime) > s) out.push({ kind: b.kind, who: b.note ?? b.kind, startTime: b.startTime, endTime: b.endTime });
  }
  return out;
}

export function procedureRoutes(app: FastifyInstance) {
  /** Feasible slots for a procedure on a day: rooms with the needed capability, free of conflicts. */
  route(app, 'get', '/procedure-sessions/slots', 'worklist.read', async (req, tx) => {
    const q = z.object({ day: DAY, procedureId: z.string().uuid(), practitionerId: z.string().uuid().optional(), minutes: z.coerce.number().int().min(5).optional() }).parse(req.query);
    const t = req.ctx.tenantId;
    const proc = await tx.select().from(procedureCatalog).where(and(eq(procedureCatalog.id, q.procedureId), eq(procedureCatalog.tenantId, t))).then((r) => r[0]);
    if (!proc) throw new HttpError(404, 'PROCEDURE_NOT_FOUND');
    const minutes = q.minutes ?? proc.typicalMinutes;
    const rooms = (await tx.select().from(room).where(and(eq(room.tenantId, t), eq(room.active, true)))).filter((r) => !proc.requiredCapability || r.capabilities.includes(proc.requiredCapability));
    const slots: any[] = [];
    for (const r of rooms) for (let m = 9 * 60; m + minutes <= 20 * 60; m += 30) {
      const c = await conflicts(tx, t, q.day, toHHMM(m), toHHMM(m + minutes), r.id, q.practitionerId ?? null);
      if (!c.length) slots.push({ roomId: r.id, room: r.name, startTime: toHHMM(m), endTime: toHHMM(m + minutes) });
    }
    return { minutes, rooms: rooms.map((r) => ({ id: r.id, name: r.name })), requiredCapability: proc.requiredCapability, slots };
  });

  const ScheduleIn = z.object({ recommendationId: z.string().uuid(), day: DAY, startTime: HHMM, minutes: z.number().int().min(5).max(480), roomId: z.string().uuid().nullable().optional(), practitionerId: z.string().uuid().nullable().optional(), notes: z.string().optional(), force: z.boolean().default(false) });
  /** Schedule a sitting. Blocks the doctor's OP time when a doctor is assigned, so booking capacity drops automatically. */
  route(app, 'post', '/procedure-sessions', 'worklist.write', async (req, tx) => {
    const body = ScheduleIn.parse(req.body); const t = req.ctx.tenantId;
    const rec = await tx.select().from(recommendation).where(and(eq(recommendation.id, body.recommendationId), eq(recommendation.tenantId, t))).then((r) => r[0]);
    if (!rec || rec.kind !== 'procedure') throw new HttpError(404, 'RECOMMENDATION_NOT_FOUND');
    const proc = rec.procedureId ? await tx.select().from(procedureCatalog).where(eq(procedureCatalog.id, rec.procedureId)).then((r) => r[0]) : null;
    if (proc?.requiresMainDoctor && !body.practitionerId) throw new HttpError(400, 'DOCTOR_REQUIRED');
    if (proc?.requiredCapability && body.roomId) {
      const rm = await tx.select().from(room).where(eq(room.id, body.roomId)).then((r) => r[0]);
      if (!rm?.capabilities.includes(proc.requiredCapability)) throw new HttpError(409, 'ROOM_LACKS_CAPABILITY', { required: proc.requiredCapability, room: rm?.name });
    }
    const endTime = toHHMM(toMin(body.startTime) + body.minutes + (proc?.bufferMinutes ?? 0));
    const c = await conflicts(tx, t, body.day, body.startTime, endTime, body.roomId, body.practitionerId);
    if (c.length && !body.force) throw new HttpError(409, 'CONFLICT', { conflicts: c });
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(procedureSession).where(and(eq(procedureSession.recommendationId, rec.id), sql`${procedureSession.state} in ('completed')`));
    const [ps] = await tx.insert(procedureSession).values({ tenantId: t, recommendationId: rec.id, patientId: rec.patientId, procedureId: rec.procedureId, practitionerId: body.practitionerId ?? null, roomId: body.roomId ?? null,
      sittingNo: n + 1, day: body.day, startTime: body.startTime, endTime, notes: body.notes }).returning();
    if (body.practitionerId) await tx.insert(calendarBlock).values({ tenantId: t, practitionerId: body.practitionerId, roomId: body.roomId ?? null, day: body.day, startTime: body.startTime, endTime, kind: 'procedure', note: `${proc?.name ?? 'Procedure'} · sitting ${n + 1}`, procedureSessionId: ps.id });
    await tx.update(recommendation).set({ status: 'scheduled', dueOn: body.day }).where(eq(recommendation.id, rec.id));
    await emit(tx, req.ctx, 'procedure_session.scheduled', 'procedure_session', ps.id, { day: body.day, startTime: body.startTime, endTime, roomId: body.roomId, practitionerId: body.practitionerId, forced: c.length > 0 });
    return { ...ps, warnings: c };
  });

  route(app, 'get', '/procedure-sessions', 'worklist.read', async (req, tx) => {
    const q = req.query as any; const t = req.ctx.tenantId;
    const where = [eq(procedureSession.tenantId, t)];
    if (q.day) where.push(eq(procedureSession.day, String(q.day)));
    if (q.recommendationId) where.push(eq(procedureSession.recommendationId, String(q.recommendationId)));
    if (!q.day && !q.recommendationId) where.push(eq(procedureSession.day, todayIn(req.ctx.timezone)));
    return tx.select({ ps: procedureSession, patient: { id: patient.id, fullName: patient.fullName, phone: patient.phone, patientNo: patient.patientNo }, procedure: procedureCatalog.name, room: room.name, doctor: practitioner.name })
      .from(procedureSession).innerJoin(patient, eq(patient.id, procedureSession.patientId)).leftJoin(procedureCatalog, eq(procedureCatalog.id, procedureSession.procedureId)).leftJoin(room, eq(room.id, procedureSession.roomId)).leftJoin(practitioner, eq(practitioner.id, procedureSession.practitionerId))
      .where(and(...where)).orderBy(asc(procedureSession.day), asc(procedureSession.startTime))
      .then((rows) => rows.map((r) => ({ ...r.ps, patient: r.patient, procedure: r.procedure, room: r.room, doctor: r.doctor })));
  });

  /** State changes keep history: postponing records the reason and frees the doctor's time; the course stays open. */
  route(app, 'patch', '/procedure-sessions/:id', 'worklist.write', async (req, tx) => {
    const body = z.object({ state: z.enum(['confirmed', 'in_progress', 'completed', 'missed', 'cancelled', 'postponed']), reason: z.string().optional(), outcome: z.record(z.string(), z.any()).optional() }).parse(req.body);
    const t = req.ctx.tenantId; const id = (req.params as any).id;
    const [ps] = await tx.update(procedureSession).set({ state: body.state, stateReason: body.reason, ...(body.outcome ? { outcome: body.outcome } : {}) }).where(and(eq(procedureSession.id, id), eq(procedureSession.tenantId, t))).returning();
    if (!ps) throw new HttpError(404, 'NOT_FOUND');
    if (['cancelled', 'postponed', 'missed'].includes(body.state)) await tx.delete(calendarBlock).where(eq(calendarBlock.procedureSessionId, id));
    const rec = await tx.select().from(recommendation).where(eq(recommendation.id, ps.recommendationId)).then((r) => r[0]);
    if (rec) {
      const done = await tx.select({ n: sql<number>`count(*)::int` }).from(procedureSession).where(and(eq(procedureSession.recommendationId, rec.id), eq(procedureSession.state, 'completed')));
      const newStatus = body.state === 'completed' && rec.sittings && done[0].n >= rec.sittings ? 'done' : body.state === 'cancelled' ? 'open' : ['postponed', 'missed'].includes(body.state) ? 'contacted' : rec.status;
      const log = ['postponed', 'missed', 'cancelled'].includes(body.state) ? [...rec.contactLog, { at: new Date().toISOString(), by: req.ctx.name, outcome: `Session ${body.state}`, note: body.reason }] : rec.contactLog;
      await tx.update(recommendation).set({ status: newStatus, contactLog: log }).where(eq(recommendation.id, rec.id));
    }
    await emit(tx, req.ctx, `procedure_session.${body.state}`, 'procedure_session', id, { reason: body.reason });
    return ps;
  });
}
