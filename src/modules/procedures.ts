import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, sql, asc, gte, lte, inArray } from 'drizzle-orm';
import { procedureSession, procedureWeek, calendarBlock, recommendation, procedureCatalog, room, practitioner, patient, encounter, document, message, tenant } from '../db/schema.js';
import { bookingSettings, localToUtc } from '../lib/booking.js';
import { MSG, patientLang } from '../lib/patientText.js';
import { auditView } from '../lib/audit.js';
import { normHistory } from '../lib/history.js';
import type { Tx } from '../db/index.js';
import { route } from '../lib/route.js';
import { emit, todayIn, addDays } from '../lib/core.js';
import { HttpError, can, type Ctx } from '../lib/auth.js';
import { toMin, toHHMM } from './scheduling.js';
import { drawSitting, reverseSitting, sittingMoney } from './courses.js';

type Consent = { grantedAt: string; by: string; how?: string; documentId?: string };
const consentKey = (procedureId: string) => `procedure:${procedureId}`;
/** The patient's consent for this procedure, kept on the patient (one per procedure type, recorded at the first Start).
 *  A sitting started before consent was stored counts as consent given: the old Start asked for the signed form on the first sitting. */
export async function procedureConsent(tx: Tx, t: string, ps: { id: string; patientId: string; procedureId: string | null }): Promise<{ consentNeeded: boolean; consent: Consent | null }> {
  if (!ps.procedureId) return { consentNeeded: false, consent: null };
  const p = await tx.select({ consents: patient.consents }).from(patient).where(and(eq(patient.id, ps.patientId), eq(patient.tenantId, t))).then((r) => r[0]);
  const on = p?.consents?.[consentKey(ps.procedureId)];
  if (on) return { consentNeeded: false, consent: on };
  const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(procedureSession).where(and(eq(procedureSession.tenantId, t), eq(procedureSession.patientId, ps.patientId), eq(procedureSession.procedureId, ps.procedureId),
    sql`${procedureSession.state} in ('in_progress','completed')`, sql`${procedureSession.id} <> ${ps.id}`));
  return n ? { consentNeeded: false, consent: { grantedAt: '', by: '', how: 'given at an earlier sitting' } } : { consentNeeded: true, consent: null };
}

const HHMM = z.string().regex(/^\d{2}:\d{2}$/); const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Whole days from one date to another (YYYY-MM-DD). */
export const daysFrom = (from: string, to: string) => Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 864e5);
/** The day-before WhatsApp goes out at this clinic-local time, inside sending hours, so the desk can call those who did not answer the same afternoon. */
export const REMINDER_AT = '10:00';
/** No sitting runs past this (minutes after midnight); the same limit the free-slot list uses. */
const DAY_END = 20 * 60;

/**
 * The WhatsApp reminder the day before a sitting. Any reminder not yet sent is dropped first, so booking, moving,
 * cancelling or calling this twice never leaves two: only a sitting still booked gets a fresh one.
 */
export async function planSittingReminder(tx: Tx, t: string, sittingId: string) {
  await tx.update(message).set({ status: 'skipped', error: 'replaced' }).where(and(eq(message.tenantId, t), eq(message.procedureSessionId, sittingId), eq(message.status, 'pending')));
  const r = await tx.select({ ps: procedureSession, p: patient, proc: procedureCatalog.name, of: recommendation.sittings, ten: tenant }).from(procedureSession)
    .innerJoin(patient, eq(patient.id, procedureSession.patientId)).innerJoin(tenant, eq(tenant.id, procedureSession.tenantId))
    .leftJoin(procedureCatalog, eq(procedureCatalog.id, procedureSession.procedureId)).leftJoin(recommendation, eq(recommendation.id, procedureSession.recommendationId))
    .where(and(eq(procedureSession.id, sittingId), eq(procedureSession.tenantId, t))).then((x) => x[0]);
  if (!r || r.ps.state !== 'confirmed' || r.ps.approval !== 'approved') return null; // the patient hears of it once the doctor has approved it
  const at = localToUtc(addDays(r.ps.day, -1), REMINDER_AT, r.ten.timezone);
  if (at.getTime() <= Date.now()) return null; // booked for tomorrow after the hour: the booking itself was the confirmation
  const cfg = bookingSettings(r.ten.settings).messages;
  const lang = patientLang(r.p, r.ten.settings);
  const date = new Date(r.ps.day + 'T00:00:00Z').toLocaleDateString(`${lang}-IN`, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  const part = r.of ? `${r.ps.sittingNo}/${r.of}` : '';
  const body = MSG[lang].sittingReminder(r.p.fullName.split(' ')[0], r.proc ?? 'procedure', part, date, r.ps.startTime, r.ten.name, (r.ten.settings as any)?.print?.phone);
  const noPhone = !r.p.phone || !/^\d{10}$/.test(r.p.phone);
  const status = !cfg.enabled || cfg.channel === 'none' || noPhone || r.p.noWhatsapp ? 'skipped' : 'pending';
  const [row] = await tx.insert(message).values({ tenantId: t, patientId: r.p.id, procedureSessionId: sittingId, kind: 'sitting_reminder', channel: cfg.channel, toPhone: r.p.phone, body,
    params: { patient: r.p.fullName, date, time: r.ps.startTime, doctor: '', link: '', lang }, status, sendAfter: at.toISOString(),
    error: status === 'skipped' ? (noPhone ? 'no mobile number' : r.p.noWhatsapp ? 'patient asked for no WhatsApp messages' : 'messages are switched off') : null }).returning();
  return row;
}

/** The Monday of the week a day falls in. */
export const weekOf = (day: string) => addDays(day, -((new Date(day + 'T00:00:00Z').getUTCDay() + 6) % 7));

/**
 * The doctor's say on a sitting someone books or moves. Its own doctor booking or moving it approves it. Anyone else's goes to
 * that doctor: straight away when its week was already sent (or is this week or earlier), otherwise it waits as a draft until
 * the coordinator sends the week. A sitting with no doctor has nobody to approve it.
 */
export async function approvalFor(tx: Tx, ctx: Ctx, practitionerId: string | null | undefined, day: string) {
  const now = new Date().toISOString();
  const set = (approval: 'approved' | 'sent' | 'draft', changed: boolean) => ({ approval, approvalNote: null, approvedBy: approval === 'approved' ? ctx.name : null, approvedAt: approval === 'approved' ? now : null, changed, bookedBy: ctx.userId });
  if (!practitionerId || practitionerId === ctx.practitionerId) return set('approved', false);
  const wk = weekOf(day);
  if (wk <= weekOf(todayIn(ctx.timezone))) return set('sent', false);
  const sent = await tx.select({ id: procedureWeek.id }).from(procedureWeek).where(and(eq(procedureWeek.tenantId, ctx.tenantId), eq(procedureWeek.weekStart, wk))).then((r) => r[0]);
  return sent ? set('sent', true) : set('draft', false);
}

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
  if (roomId) {
    const rb = await tx.select().from(calendarBlock).where(and(eq(calendarBlock.tenantId, t), eq(calendarBlock.day, day), eq(calendarBlock.roomId, roomId), sql`${calendarBlock.kind} in ('break','leave','other')`, sql`${calendarBlock.practitionerId} is null`));
    for (const b of rb) if (toMin(b.startTime) < e && toMin(b.endTime) > s) out.push({ kind: 'room_blocked', who: b.note ?? 'room not available', startTime: b.startTime, endTime: b.endTime });
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

  const ScheduleIn = z.object({ recommendationId: z.string().uuid(), day: DAY, startTime: HHMM, minutes: z.number().int().min(5).max(480), roomId: z.string().uuid().nullable().optional(), practitionerId: z.string().uuid().nullable().optional(), notes: z.string().optional(), force: z.boolean().default(false),
    // planned: placed on the coordinator's week, not booked with the patient, so it does not count as the patient's yes
    planned: z.boolean().default(false) });
  /** Schedule a sitting. Blocks the doctor's OP time when a doctor is assigned, so booking capacity drops automatically. */
  const book = async (req: { ctx: Ctx; body: unknown }, tx: Tx) => {
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
    // the next number after every sitting still on the plan (done or booked ahead), so two booked ahead never share a number
    const [{ n }] = await tx.select({ n: sql<number>`coalesce(max(${procedureSession.sittingNo}), 0)::int` }).from(procedureSession).where(and(eq(procedureSession.recommendationId, rec.id), sql`${procedureSession.state} <> 'cancelled'`));
    // booked with the patient (at the desk or on the phone): that confirms the date for the calls already inside the time left
    const ahead = daysFrom(todayIn(req.ctx.timezone), body.day); const now = new Date().toISOString();
    const [ps] = await tx.insert(procedureSession).values({ tenantId: t, recommendationId: rec.id, patientId: rec.patientId, procedureId: rec.procedureId, practitionerId: body.practitionerId ?? null, roomId: body.roomId ?? null,
      sittingNo: n + 1, day: body.day, startTime: body.startTime, endTime, notes: body.notes, weekConfirmedAt: ahead <= 7 && !body.planned ? now : null, patientConfirmedAt: ahead <= 1 && !body.planned ? now : null, ...(await approvalFor(tx, req.ctx, body.practitionerId, body.day)) }).returning();
    await planSittingReminder(tx, t, ps.id);
    if (body.practitionerId) await tx.insert(calendarBlock).values({ tenantId: t, practitionerId: body.practitionerId, roomId: body.roomId ?? null, day: body.day, startTime: body.startTime, endTime, kind: 'procedure', note: `${proc?.name ?? 'Procedure'} · sitting ${n + 1}`, procedureSessionId: ps.id });
    await tx.update(recommendation).set({ status: 'scheduled', dueOn: body.day }).where(eq(recommendation.id, rec.id));
    await emit(tx, req.ctx, 'procedure_session.scheduled', 'procedure_session', ps.id, { day: body.day, startTime: body.startTime, endTime, roomId: body.roomId, practitionerId: body.practitionerId, forced: c.length > 0 });
    return { ...ps, warnings: c };
  };
  route(app, 'post', '/procedure-sessions', 'worklist.write', book);

  /** Sittings per day for the date strip. Cancelled and postponed ones are not counted. */
  route(app, 'get', '/procedure-sessions/counts', 'worklist.read', async (req, tx) => {
    const q = z.object({ from: DAY, days: z.coerce.number().int().min(1).max(31).default(7) }).parse(req.query);
    const to = addDays(q.from, q.days - 1);
    const rows = await tx.select({ day: procedureSession.day, n: sql<number>`count(*)::int` }).from(procedureSession)
      .where(and(eq(procedureSession.tenantId, req.ctx.tenantId), gte(procedureSession.day, q.from), lte(procedureSession.day, to), sql`${procedureSession.state} not in ('cancelled','postponed')`)).groupBy(procedureSession.day);
    return Object.fromEntries(rows.map((r) => [r.day, r.n]));
  });

  /** The coordinator spoke to the patient (or undoes that). */
  route(app, 'post', '/procedure-sessions/:id/confirm', 'worklist.write', async (req, tx) => {
    const body = z.object({ confirmed: z.boolean() }).parse(req.body);
    const [ps] = await tx.update(procedureSession).set({ patientConfirmedAt: body.confirmed ? new Date().toISOString() : null }).where(and(eq(procedureSession.id, (req.params as any).id), eq(procedureSession.tenantId, req.ctx.tenantId))).returning();
    if (!ps) throw new HttpError(404, 'NOT_FOUND');
    await emit(tx, req.ctx, body.confirmed ? 'procedure_session.patient_confirmed' : 'procedure_session.patient_unconfirmed', 'procedure_session', ps.id, {});
    return ps;
  });

  /** Put a doctor on a sitting that has none (or change the doctor). The doctor's OP time is blocked like when scheduling. */
  // The coordinator assigns anyone; a doctor may take a sitting that has no doctor ("Take it" on Today).
  route(app, 'post', '/procedure-sessions/:id/assign', null, async (req, tx) => {
    const body = z.object({ practitionerId: z.string().uuid().nullable(), supervisorId: z.string().uuid().nullable().optional(), force: z.boolean().default(false) }).parse(req.body);
    const t = req.ctx.tenantId; const id = (req.params as any).id;
    const ps = await tx.select().from(procedureSession).where(and(eq(procedureSession.id, id), eq(procedureSession.tenantId, t))).then((r) => r[0]);
    if (!ps) throw new HttpError(404, 'NOT_FOUND');
    if (!(can(req.perms, 'worklist.write') || (!ps.practitionerId && !!body.practitionerId && body.practitionerId === req.ctx.practitionerId))) throw new HttpError(403, 'FORBIDDEN:worklist.write');
    if (ps.state !== 'confirmed') throw new HttpError(409, 'NOT_CHANGEABLE', { state: ps.state });
    const proc = ps.procedureId ? await tx.select().from(procedureCatalog).where(eq(procedureCatalog.id, ps.procedureId)).then((r) => r[0]) : null;
    if (proc?.requiresMainDoctor && !body.practitionerId) throw new HttpError(400, 'DOCTOR_REQUIRED');
    if (body.practitionerId) {
      const c = (await conflicts(tx, t, ps.day, ps.startTime, ps.endTime, null, body.practitionerId, id));
      if (c.length && !body.force) throw new HttpError(409, 'CONFLICT', { conflicts: c });
    }
    if (body.supervisorId && body.supervisorId === body.practitionerId) throw new HttpError(400, 'SUPERVISOR_IS_THE_DOCTOR');
    const who = body.practitionerId !== ps.practitionerId ? await approvalFor(tx, req.ctx, body.practitionerId, ps.day) : {};
    const [row] = await tx.update(procedureSession).set({ practitionerId: body.practitionerId, ...who, ...(body.supervisorId !== undefined ? { supervisorId: body.supervisorId } : {}) }).where(eq(procedureSession.id, id)).returning();
    await planSittingReminder(tx, t, id);
    await tx.delete(calendarBlock).where(eq(calendarBlock.procedureSessionId, id));
    if (body.practitionerId) await tx.insert(calendarBlock).values({ tenantId: t, practitionerId: body.practitionerId, roomId: ps.roomId, day: ps.day, startTime: ps.startTime, endTime: ps.endTime, kind: 'procedure', note: `${proc?.name ?? 'Procedure'} · sitting ${ps.sittingNo}`, procedureSessionId: id });
    await emit(tx, req.ctx, 'procedure_session.doctor_assigned', 'procedure_session', id, { practitionerId: body.practitionerId });
    return row;
  });

  route(app, 'get', '/procedure-sessions', 'worklist.read', async (req, tx) => {
    const q = req.query as any; const t = req.ctx.tenantId;
    const where = [eq(procedureSession.tenantId, t)];
    if (q.day) where.push(eq(procedureSession.day, String(q.day)));
    if (q.from) where.push(gte(procedureSession.day, String(q.from)));
    if (q.to) where.push(lte(procedureSession.day, String(q.to)));
    if (q.practitionerId) where.push(eq(procedureSession.practitionerId, String(q.practitionerId)));
    if (q.active) where.push(sql`${procedureSession.state} not in ('cancelled','postponed')`);
    if (q.recommendationId) where.push(eq(procedureSession.recommendationId, String(q.recommendationId)));
    if (!q.day && !q.from && !q.recommendationId) where.push(eq(procedureSession.day, todayIn(req.ctx.timezone)));
    return tx.select({ ps: procedureSession, patient: { id: patient.id, fullName: patient.fullName, phone: patient.phone, patientNo: patient.patientNo, ageYears: patient.ageYears, sex: patient.sex }, procedure: procedureCatalog.name, room: room.name, doctor: practitioner.name, of: recommendation.sittings, mainDoctor: procedureCatalog.requiresMainDoctor, review: procedureCatalog.requiresReview })
      .from(procedureSession).leftJoin(recommendation, eq(recommendation.id, procedureSession.recommendationId)).innerJoin(patient, eq(patient.id, procedureSession.patientId)).leftJoin(procedureCatalog, eq(procedureCatalog.id, procedureSession.procedureId)).leftJoin(room, eq(room.id, procedureSession.roomId)).leftJoin(practitioner, eq(practitioner.id, procedureSession.practitionerId))
      .where(and(...where)).orderBy(asc(procedureSession.day), asc(procedureSession.startTime))
      .then(async (rows) => {
        const ids = [...new Set(rows.map((r) => r.ps.supervisorId).filter(Boolean))] as string[];
        const names = new Map((ids.length ? await tx.select({ id: practitioner.id, name: practitioner.name }).from(practitioner).where(inArray(practitioner.id, ids)) : []).map((x) => [x.id, x.name]));
        // detail=1 (the Schedule tab): what the patient pays on the day and whether the procedure consent is on file, per row
        const fees = can(req.perms, 'fees.see'); const detail = !!q.detail;
        return Promise.all(rows.map(async (r) => ({ ...r.ps, patient: r.patient, procedure: r.procedure, room: r.room, doctor: r.doctor, supervisor: r.ps.supervisorId ? names.get(r.ps.supervisorId) ?? null : null, of: r.of, requiresMainDoctor: r.mainDoctor, requiresReview: r.review,
          ...(detail ? { money: fees && !['cancelled', 'postponed'].includes(r.ps.state) ? await sittingMoney(tx, t, r.ps) : null, ...(await procedureConsent(tx, t, r.ps)) } : {}) })));
      });
  });

  /** One sitting, as the doctor needs it before starting: who, what and where, the plan behind it, earlier sittings, conditions and allergies. */
  route(app, 'get', '/procedure-sessions/:id', 'worklist.read', async (req, tx) => {
    const t = req.ctx.tenantId; const id = (req.params as any).id;
    const r = await tx.select({ ps: procedureSession, p: { id: patient.id, fullName: patient.fullName, patientNo: patient.patientNo, phone: patient.phone, ageYears: patient.ageYears, sex: patient.sex, allergies: patient.allergies, history: patient.history, flags: patient.flags },
      procedure: procedureCatalog.name, minutes: procedureCatalog.typicalMinutes, room: room.name, doctor: practitioner.name, rec: recommendation })
      .from(procedureSession).innerJoin(patient, eq(patient.id, procedureSession.patientId)).leftJoin(recommendation, eq(recommendation.id, procedureSession.recommendationId))
      .leftJoin(procedureCatalog, eq(procedureCatalog.id, procedureSession.procedureId)).leftJoin(room, eq(room.id, procedureSession.roomId)).leftJoin(practitioner, eq(practitioner.id, procedureSession.practitionerId))
      .where(and(eq(procedureSession.id, id), eq(procedureSession.tenantId, t))).then((x) => x[0]);
    if (!r) throw new HttpError(404, 'NOT_FOUND');
    await auditView(tx, req, r.p.id, 'Opened a procedure sitting');
    const enc = r.rec ? await tx.select({ at: encounter.createdAt, data: encounter.data }).from(encounter).where(eq(encounter.id, r.rec.encounterId)).then((x) => x[0]) : null;
    const names = (x: any) => (Array.isArray(x) ? x.map((d) => (typeof d === 'string' ? d : d?.name)).filter(Boolean) : []);
    const sittings = await tx.select({ id: procedureSession.id, sittingNo: procedureSession.sittingNo, day: procedureSession.day, startTime: procedureSession.startTime, state: procedureSession.state, notes: procedureSession.notes, outcome: procedureSession.outcome, stateReason: procedureSession.stateReason })
      .from(procedureSession).where(and(eq(procedureSession.tenantId, t), eq(procedureSession.recommendationId, r.ps.recommendationId))).orderBy(asc(procedureSession.day), asc(procedureSession.startTime));
    const supervisor = r.ps.supervisorId ? await tx.select({ name: practitioner.name }).from(practitioner).where(eq(practitioner.id, r.ps.supervisorId)).then((x) => x[0]?.name ?? null) : null;
    const money = can(req.perms, 'fees.see') && !['cancelled', 'postponed'].includes(r.ps.state) ? await sittingMoney(tx, t, r.ps) : null;
    return { ...r.ps, patient: { ...r.p, history: normHistory(r.p.history) }, procedure: r.procedure, minutes: r.minutes, room: r.room, doctor: r.doctor, supervisor, money, ...(await procedureConsent(tx, t, r.ps)),
      plan: r.rec ? { notes: r.rec.notes, sittings: r.rec.sittings, plannedOn: enc?.at ?? null, diagnosis: names((enc?.data as any)?.assessment?.diagnosis) } : null, sittings };
  });

  /** Move an upcoming sitting (or one postponed or missed) to another day, time, room or doctor. The doctor's blocked time moves with it; the reason goes in the contact log. */
  const move = async (req: { ctx: Ctx; body: unknown; params: unknown }, tx: Tx) => {
    const body = ScheduleIn.omit({ recommendationId: true }).extend({ reason: z.string().trim().max(200).optional() }).parse(req.body);
    const t = req.ctx.tenantId; const id = (req.params as any).id;
    const ps = await tx.select().from(procedureSession).where(and(eq(procedureSession.id, id), eq(procedureSession.tenantId, t))).then((r) => r[0]);
    if (!ps) throw new HttpError(404, 'NOT_FOUND');
    if (!['confirmed', 'postponed', 'missed'].includes(ps.state)) throw new HttpError(409, 'NOT_RESCHEDULABLE', { state: ps.state });
    const proc = ps.procedureId ? await tx.select().from(procedureCatalog).where(eq(procedureCatalog.id, ps.procedureId)).then((r) => r[0]) : null;
    if (proc?.requiresMainDoctor && !body.practitionerId) throw new HttpError(400, 'DOCTOR_REQUIRED');
    if (proc?.requiredCapability && body.roomId) {
      const rm = await tx.select().from(room).where(eq(room.id, body.roomId)).then((r) => r[0]);
      if (!rm?.capabilities.includes(proc.requiredCapability)) throw new HttpError(409, 'ROOM_LACKS_CAPABILITY', { required: proc.requiredCapability, room: rm?.name });
    }
    const endTime = toHHMM(toMin(body.startTime) + body.minutes + (proc?.bufferMinutes ?? 0));
    const c = await conflicts(tx, t, body.day, body.startTime, endTime, body.roomId, body.practitionerId, id);
    if (c.length && !body.force) throw new HttpError(409, 'CONFLICT', { conflicts: c });
    // a move inside the week counts as the week's confirmation; the day-before call is still made (the clinic may have moved it)
    const ahead = daysFrom(todayIn(req.ctx.timezone), body.day);
    const [moved] = await tx.update(procedureSession).set({ day: body.day, startTime: body.startTime, endTime, roomId: body.roomId ?? null, practitionerId: body.practitionerId ?? null, state: 'confirmed', stateReason: null, patientConfirmedAt: null, weekConfirmedAt: ahead <= 7 && !body.planned ? new Date().toISOString() : null, notes: body.notes ?? ps.notes, ...(await approvalFor(tx, req.ctx, body.practitionerId, body.day)) }).where(eq(procedureSession.id, id)).returning();
    await planSittingReminder(tx, t, id);
    await tx.delete(calendarBlock).where(eq(calendarBlock.procedureSessionId, id));
    if (body.practitionerId) await tx.insert(calendarBlock).values({ tenantId: t, practitionerId: body.practitionerId, roomId: body.roomId ?? null, day: body.day, startTime: body.startTime, endTime, kind: 'procedure', note: `${proc?.name ?? 'Procedure'} · sitting ${ps.sittingNo}`, procedureSessionId: id });
    const rec = await tx.select().from(recommendation).where(eq(recommendation.id, ps.recommendationId)).then((r) => r[0]);
    if (rec) await tx.update(recommendation).set({ status: 'scheduled', dueOn: body.day, contactLog: [...rec.contactLog, { at: new Date().toISOString(), by: req.ctx.name, outcome: 'Sitting rescheduled', note: `${ps.day} ${ps.startTime} → ${body.day} ${body.startTime}${body.reason ? ` · ${body.reason}` : ''}` }] }).where(eq(recommendation.id, rec.id));
    await emit(tx, req.ctx, 'procedure_session.rescheduled', 'procedure_session', id, { from: { day: ps.day, startTime: ps.startTime, roomId: ps.roomId }, to: { day: body.day, startTime: body.startTime, roomId: body.roomId }, reason: body.reason, forced: c.length > 0 });
    return { ...moved, warnings: c };
  };
  // the desk moves any sitting; a doctor moves their own (from the approval list), and that move counts as approved
  route(app, 'post', '/procedure-sessions/:id/reschedule', null, async (req, tx) => {
    if (!can(req.perms, 'worklist.write')) {
      const ps = await tx.select({ d: procedureSession.practitionerId }).from(procedureSession).where(and(eq(procedureSession.id, (req.params as any).id), eq(procedureSession.tenantId, req.ctx.tenantId))).then((r) => r[0]);
      if (!ps || !req.ctx.practitionerId || ps.d !== req.ctx.practitionerId || !can(req.perms, 'encounter.complete')) throw new HttpError(403, 'FORBIDDEN:worklist.write');
    }
    return move(req, tx);
  });

  /**
   * Drop a sitting on an hour: the coordinator's week (a course's next sitting, or one already booked), or a doctor moving their own.
   * The server takes the first start in that hour, in 15-minute steps, where the whole sitting fits a suitable room and the doctor,
   * and says why when nothing does. A new sitting goes to the doctor who prescribed the course; a moved one keeps its doctor and tries its room first.
   */
  route(app, 'post', '/procedure-sessions/place', null, async (req, tx) => {
    const body = z.object({ recommendationId: z.string().uuid().optional(), sittingId: z.string().uuid().optional(), day: DAY, hour: z.number().int().min(0).max(23) })
      .refine((b) => !!b.recommendationId !== !!b.sittingId, 'one of recommendationId or sittingId').parse(req.body);
    const t = req.ctx.tenantId;
    const ps = body.sittingId ? await tx.select().from(procedureSession).where(and(eq(procedureSession.id, body.sittingId), eq(procedureSession.tenantId, t))).then((r) => r[0]) : null;
    if (body.sittingId && !ps) throw new HttpError(404, 'NOT_FOUND');
    const ownMove = !!ps && !!req.ctx.practitionerId && ps.practitionerId === req.ctx.practitionerId && can(req.perms, 'encounter.complete');
    if (!can(req.perms, 'worklist.write') && !ownMove) throw new HttpError(403, 'FORBIDDEN:worklist.write');
    const rec = await tx.select().from(recommendation).where(and(eq(recommendation.id, ps?.recommendationId ?? body.recommendationId!), eq(recommendation.tenantId, t))).then((r) => r[0]);
    if (!rec || rec.kind !== 'procedure') throw new HttpError(404, 'RECOMMENDATION_NOT_FOUND');
    const proc = rec.procedureId ? await tx.select().from(procedureCatalog).where(eq(procedureCatalog.id, rec.procedureId)).then((r) => r[0]) : null;
    const buffer = proc?.bufferMinutes ?? 0;
    const minutes = ps ? Math.max(5, toMin(ps.endTime) - toMin(ps.startTime) - buffer) : proc?.typicalMinutes ?? 30;
    const doctor = ps ? ps.practitionerId : await tx.select({ d: encounter.practitionerId }).from(encounter).where(eq(encounter.id, rec.encounterId)).then((r) => r[0]?.d ?? null);
    const rooms = (await tx.select().from(room).where(and(eq(room.tenantId, t), eq(room.active, true)))).filter((r) => !proc?.requiredCapability || r.capabilities.includes(proc.requiredCapability))
      .sort((a, b) => Number(b.id === ps?.roomId) - Number(a.id === ps?.roomId));
    const today = todayIn(req.ctx.timezone);
    const nowMin = toMin(new Intl.DateTimeFormat('en-GB', { timeZone: req.ctx.timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()));
    let why = body.day < today ? 'that day is past' : !rooms.length ? (proc?.requiredCapability ? `No room has ${proc.requiredCapability}` : 'No rooms are set up') : '';
    let at: { startTime: string; roomId: string } | null = null;
    if (!why) for (let m = body.hour * 60; m < body.hour * 60 + 60 && !at; m += 15) {
      if (body.day === today && m < nowMin) { why = 'that time is past'; continue; }
      if (m + minutes + buffer > DAY_END) { why = `${minutes} min runs past ${toHHMM(DAY_END)}, closing time`; break; }
      for (const r of rooms) {
        const c = await conflicts(tx, t, body.day, toHHMM(m), toHHMM(m + minutes + buffer), r.id, doctor, ps?.id);
        if (!c.length) { at = { startTime: toHHMM(m), roomId: r.id }; break; }
        why = c[0].kind === 'room' ? `${c[0].who.replace(' · ', ' has ')} till ${c[0].endTime}` : c[0].kind === 'doctor' ? `the doctor has ${c[0].who} till ${c[0].endTime}` : c[0].kind === 'leave' ? 'the doctor is away' : c[0].who;
      }
    }
    if (!at) throw new HttpError(409, 'NO_FIT', { why: why || 'no free time in that hour' });
    const args = { day: body.day, startTime: at.startTime, minutes, roomId: at.roomId, practitionerId: doctor, force: false, planned: true };
    return ps ? move({ ctx: req.ctx, body: args, params: { id: ps.id } }, tx) : book({ ctx: req.ctx, body: { ...args, recommendationId: rec.id } }, tx);
  });

  /** A week of sittings, for the coordinator: whether it went to the doctors, and the doctors' leave in it. This week and earlier count as sent. */
  route(app, 'get', '/procedure-weeks/:start', 'worklist.read', async (req, tx) => {
    const start = weekOf(DAY.parse((req.params as any).start)); const t = req.ctx.tenantId;
    const sent = await tx.select().from(procedureWeek).where(and(eq(procedureWeek.tenantId, t), eq(procedureWeek.weekStart, start))).then((r) => r[0] ?? null);
    const away = await tx.select({ practitionerId: calendarBlock.practitionerId, day: calendarBlock.day, startTime: calendarBlock.startTime, endTime: calendarBlock.endTime }).from(calendarBlock)
      .where(and(eq(calendarBlock.tenantId, t), gte(calendarBlock.day, start), lte(calendarBlock.day, addDays(start, 6)), eq(calendarBlock.kind, 'leave')));
    return { start, sent: !!sent || start <= weekOf(todayIn(req.ctx.timezone)), sentAt: sent?.createdAt ?? null, sentBy: sent?.sentBy ?? null, away };
  });

  /** Send a week to the doctors: each draft in it goes to its own doctor. From then on, a change in that week reaches the doctor straight away. */
  route(app, 'post', '/procedure-weeks/:start/send', 'worklist.write', async (req, tx) => {
    const start = weekOf(DAY.parse((req.params as any).start)); const t = req.ctx.tenantId;
    await tx.insert(procedureWeek).values({ tenantId: t, weekStart: start, sentBy: req.ctx.name }).onConflictDoNothing();
    const wk = await tx.select().from(procedureWeek).where(and(eq(procedureWeek.tenantId, t), eq(procedureWeek.weekStart, start))).then((r) => r[0]);
    const rows = await tx.update(procedureSession).set({ approval: 'sent' })
      .where(and(eq(procedureSession.tenantId, t), gte(procedureSession.day, start), lte(procedureSession.day, addDays(start, 6)), eq(procedureSession.approval, 'draft'))).returning({ id: procedureSession.id });
    await emit(tx, req.ctx, 'procedure_week.sent', 'procedure_week', wk.id, { start, sittings: rows.length });
    return { start, sent: rows.length };
  });

  /** The doctor's sittings waiting for their approval, with the rest of those weeks around them, the course behind each, and their leave. */
  route(app, 'get', '/procedure-approvals', 'encounter.complete', async (req, tx) => {
    const me = req.ctx.practitionerId; const t = req.ctx.tenantId;
    if (!me) return { pending: 0, weeks: [], sittings: [], away: [] };
    const waiting = await tx.select({ day: procedureSession.day }).from(procedureSession)
      .where(and(eq(procedureSession.tenantId, t), eq(procedureSession.practitionerId, me), eq(procedureSession.approval, 'sent'), eq(procedureSession.state, 'confirmed'), gte(procedureSession.day, todayIn(req.ctx.timezone))));
    if (!waiting.length) return { pending: 0, weeks: [], sittings: [], away: [] };
    const weeks = [...new Set(waiting.map((w) => weekOf(w.day)))].sort();
    const from = weeks[0], to = addDays(weeks[weeks.length - 1], 6);
    const rows = await tx.select({ ps: procedureSession, patient: patient.fullName, procedure: procedureCatalog.name, room: room.name, of: recommendation.sittings, gapDays: recommendation.gapDays })
      .from(procedureSession).innerJoin(patient, eq(patient.id, procedureSession.patientId)).leftJoin(procedureCatalog, eq(procedureCatalog.id, procedureSession.procedureId))
      .leftJoin(room, eq(room.id, procedureSession.roomId)).leftJoin(recommendation, eq(recommendation.id, procedureSession.recommendationId))
      .where(and(eq(procedureSession.tenantId, t), eq(procedureSession.practitionerId, me), gte(procedureSession.day, from), lte(procedureSession.day, to), sql`${procedureSession.state} not in ('cancelled','postponed')`))
      .orderBy(asc(procedureSession.day), asc(procedureSession.startTime));
    // the last sitting done on each course, so the review can say when it was and flag one booked too soon
    const recIds = [...new Set(rows.map((r) => r.ps.recommendationId))];
    const last = new Map((await tx.select({ rec: procedureSession.recommendationId, day: sql<string>`max(${procedureSession.day})` }).from(procedureSession)
      .where(and(eq(procedureSession.tenantId, t), inArray(procedureSession.recommendationId, recIds), eq(procedureSession.state, 'completed'))).groupBy(procedureSession.recommendationId)).map((x) => [x.rec, x.day]));
    const away = await tx.select({ day: calendarBlock.day, startTime: calendarBlock.startTime, endTime: calendarBlock.endTime }).from(calendarBlock)
      .where(and(eq(calendarBlock.tenantId, t), eq(calendarBlock.practitionerId, me), eq(calendarBlock.kind, 'leave'), gte(calendarBlock.day, from), lte(calendarBlock.day, to)));
    return { pending: waiting.length, weeks, away,
      sittings: rows.map((r) => ({ ...r.ps, patient: r.patient, procedure: r.procedure, room: r.room, of: r.of, gapDays: r.gapDays, lastDone: last.get(r.ps.recommendationId) ?? null })) };
  });

  /** The doctor approves their sittings (one, or all at once), or sends some back to the coordinator with a note. Only sittings waiting for them. */
  route(app, 'post', '/procedure-approvals', 'encounter.complete', async (req, tx) => {
    const body = z.object({ ids: z.array(z.string().uuid()).min(1).max(300), action: z.enum(['approve', 'change']), note: z.string().trim().max(200).optional() }).parse(req.body);
    const me = req.ctx.practitionerId; const t = req.ctx.tenantId;
    if (!me) throw new HttpError(403, 'NOT_A_DOCTOR');
    const set = body.action === 'approve' ? { approval: 'approved', approvedBy: req.ctx.name, approvedAt: new Date().toISOString(), approvalNote: null, changed: false } : { approval: 'change', approvalNote: body.note || 'Change asked' };
    const rows = await tx.update(procedureSession).set(set)
      .where(and(eq(procedureSession.tenantId, t), inArray(procedureSession.id, body.ids), eq(procedureSession.practitionerId, me), eq(procedureSession.approval, 'sent'))).returning({ id: procedureSession.id });
    for (const r of rows) {
      if (body.action === 'approve') await planSittingReminder(tx, t, r.id);
      await emit(tx, req.ctx, body.action === 'approve' ? 'procedure_session.approved' : 'procedure_session.change_asked', 'procedure_session', r.id, body.action === 'change' ? { note: set.approvalNote } : {});
    }
    return { updated: rows.length };
  });

  /** State changes keep history: postponing records the reason and frees the doctor's time; the course stays open. */
  // The desk changes any state; a doctor (from the Calendar's sitting drawer) only starts a scheduled sitting and finishes one in progress.
  route(app, 'patch', '/procedure-sessions/:id', null, async (req, tx) => {
    // consent: on starting, true when the patient signed the procedure consent form (sent only when none is on file for this procedure)
    // consentDocumentId: the patient signed on the tablet; the signature was first saved as one of this patient's documents
    const body = z.object({ state: z.enum(['confirmed', 'in_progress', 'completed', 'missed', 'cancelled', 'postponed']), reason: z.string().optional(), outcome: z.record(z.string(), z.any()).optional(), consent: z.boolean().optional(), consentDocumentId: z.string().uuid().optional() }).parse(req.body);
    const t = req.ctx.tenantId; const id = (req.params as any).id;
    const cur = await tx.select().from(procedureSession).where(and(eq(procedureSession.id, id), eq(procedureSession.tenantId, t))).then((r) => r[0]);
    if (!cur) throw new HttpError(404, 'NOT_FOUND');
    if (!can(req.perms, 'worklist.write')) {
      if (!can(req.perms, 'encounter.complete')) throw new HttpError(403, 'FORBIDDEN:worklist.write');
      const from = { in_progress: 'confirmed', completed: 'in_progress' }[body.state as string];
      if (!from) throw new HttpError(403, 'FORBIDDEN:worklist.write');
      if (cur.state !== from) throw new HttpError(409, 'NOT_CHANGEABLE', { state: cur.state });
    }
    // Start needs the procedure consent on file; the first Start records it on the patient (paper form filed), so later sittings don't ask
    if (body.state === 'in_progress' && cur.state !== 'in_progress' && cur.procedureId) {
      if ((await procedureConsent(tx, t, cur)).consentNeeded) {
        if (body.consent !== true) throw new HttpError(409, 'CONSENT_NEEDED');
        // a signature from the tablet must be a document of this same patient, in this clinic
        if (body.consentDocumentId) {
          const doc = await tx.select({ id: document.id }).from(document).where(and(eq(document.id, body.consentDocumentId), eq(document.tenantId, t), eq(document.patientId, cur.patientId))).then((r) => r[0]);
          if (!doc) throw new HttpError(400, 'CONSENT_NOT_FOR_PATIENT');
        }
        const p = await tx.select({ consents: patient.consents }).from(patient).where(eq(patient.id, cur.patientId)).then((r) => r[0]);
        const key = consentKey(cur.procedureId); const at = new Date().toISOString();
        const rec: Consent = body.consentDocumentId ? { grantedAt: at, by: req.ctx.name, how: 'signed', documentId: body.consentDocumentId } : { grantedAt: at, by: req.ctx.name, how: 'signed paper form filed' };
        await tx.update(patient).set({ consents: { ...(p?.consents ?? {}), [key]: rec } }).where(eq(patient.id, cur.patientId));
        await emit(tx, req.ctx, 'consent.granted', 'patient', cur.patientId, { key, procedureSessionId: id, ...(body.consentDocumentId ? { documentId: body.consentDocumentId } : {}) });
      }
    }
    const [ps] = await tx.update(procedureSession).set({ state: body.state, stateReason: body.reason, ...(body.outcome ? { outcome: body.outcome } : {}) }).where(and(eq(procedureSession.id, id), eq(procedureSession.tenantId, t))).returning();
    if (!ps) throw new HttpError(404, 'NOT_FOUND');
    if (['cancelled', 'postponed', 'missed'].includes(body.state)) await tx.delete(calendarBlock).where(eq(calendarBlock.procedureSessionId, id));
    const rec = await tx.select().from(recommendation).where(eq(recommendation.id, ps.recommendationId)).then((r) => r[0]);
    if (rec) {
      const done = await tx.select({ n: sql<number>`count(*)::int` }).from(procedureSession).where(and(eq(procedureSession.recommendationId, rec.id), eq(procedureSession.state, 'completed')));
      const newStatus = body.state === 'completed' && rec.sittings && done[0].n >= rec.sittings ? 'done' : body.state === 'cancelled' ? 'open' : ['postponed', 'missed'].includes(body.state) ? 'contacted' : rec.status;
      const log = ['postponed', 'missed', 'cancelled'].includes(body.state) ? [...rec.contactLog, { at: new Date().toISOString(), by: req.ctx.name, outcome: `Session ${body.state}`, note: body.reason }] : rec.contactLog;
      // a sitting done with more to come: the next falls due one gap after it (not after the original plan), unless one is booked already
      let nextDue: string | undefined;
      if (body.state === 'completed' && newStatus !== 'done' && rec.gapDays) {
        const [{ ahead }] = await tx.select({ ahead: sql<number>`count(*)::int` }).from(procedureSession).where(and(eq(procedureSession.recommendationId, rec.id), eq(procedureSession.state, 'confirmed'), sql`${procedureSession.id} <> ${id}`));
        if (!ahead) nextDue = addDays(ps.day, rec.gapDays);
      }
      await tx.update(recommendation).set({ status: newStatus, contactLog: log, ...(nextDue ? { dueOn: nextDue } : {}) }).where(eq(recommendation.id, rec.id));
    }
    await planSittingReminder(tx, t, id); // only a sitting still booked keeps its reminder
    if (body.state === 'completed') await drawSitting(tx, req.ctx, ps);
    else if (cur.state === 'completed') await reverseSitting(tx, req.ctx, id, body.state === 'cancelled' ? 'Sitting cancelled' : `Sitting moved back to ${body.state.replace('_', ' ')}`);
    await emit(tx, req.ctx, `procedure_session.${body.state}`, 'procedure_session', id, { reason: body.reason, ...(body.state === 'in_progress' && body.consent !== undefined ? { consent: body.consent } : {}) });
    return ps;
  });
}
