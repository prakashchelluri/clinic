import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, sql, asc, gte, lte, inArray, desc } from 'drizzle-orm';
import { procedureSession, procedureWeek, course, calendarBlock, recommendation, procedureCatalog, room, practitioner, patient, encounter, document, message, tenant, formDefinition, medicine, type FormSchema, type SupplyAsk } from '../db/schema.js';
import { randomUUID, createHash } from 'node:crypto';
import { missingRequired, cleanValues } from '../lib/procForm.js';
import { bookingSettings, localToUtc } from '../lib/booking.js';
import { MSG, patientLang } from '../lib/patientText.js';
import { auditView } from '../lib/audit.js';
import { normHistory } from '../lib/history.js';
import type { Tx } from '../db/index.js';
import { route } from '../lib/route.js';
import { emit, todayIn, addDays } from '../lib/core.js';
import { HttpError, can, type Ctx } from '../lib/auth.js';
import { toMin, toHHMM, nowHHMM } from './scheduling.js';
import { drawSitting, reverseSitting, sittingMoney, standing } from './courses.js';
import { sessionDef } from '../lib/procPrice.js';
import { signedRecord } from './documents.js';

type Consent = { grantedAt: string; by: string; how?: string; documentId?: string; sha256?: string; wording?: string };
const consentKey = (procedureId: string) => `procedure:${procedureId}`;
/** The patient's consent for this procedure, kept on the patient (one per procedure type, recorded at the first Start).
 *  It lasts the procedure's consentMonths (empty = for good); after that Start asks for it again (consentExpired).
 *  A sitting started before consent was stored, within that time, counts as consent given: the old Start asked for the signed form on the first sitting.
 *  consentText: the procedure's own wording, when it has one. */
export async function procedureConsent(tx: Tx, t: string, ps: { id: string; patientId: string; procedureId: string | null }): Promise<{ consentNeeded: boolean; consent: Consent | null; consentExpired?: boolean; consentText?: string | null }> {
  if (!ps.procedureId) return { consentNeeded: false, consent: null };
  const pr = await tx.select({ text: procedureCatalog.consentText, months: procedureCatalog.consentMonths }).from(procedureCatalog).where(eq(procedureCatalog.id, ps.procedureId)).then((r) => r[0]);
  const since = pr?.months ? new Date(Date.now() - pr.months * 30.44 * 864e5) : null; // consent given before this has run out
  const x = { consentText: pr?.text ?? null };
  const p = await tx.select({ consents: patient.consents }).from(patient).where(and(eq(patient.id, ps.patientId), eq(patient.tenantId, t))).then((r) => r[0]);
  const on = p?.consents?.[consentKey(ps.procedureId)];
  if (on && (!since || new Date(on.grantedAt) >= since)) return { consentNeeded: false, consent: on, ...x };
  if (on) return { consentNeeded: true, consent: null, consentExpired: true, ...x };
  const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(procedureSession).where(and(eq(procedureSession.tenantId, t), eq(procedureSession.patientId, ps.patientId), eq(procedureSession.procedureId, ps.procedureId),
    sql`${procedureSession.state} in ('in_progress','completed')`, sql`${procedureSession.id} <> ${ps.id}`, ...(since ? [gte(procedureSession.day, since.toISOString().slice(0, 10))] : [])));
  return n ? { consentNeeded: false, consent: { grantedAt: '', by: '', how: 'given at an earlier session' }, ...x } : { consentNeeded: true, consent: null, ...x };
}

/** A procedure's form: the version this session was filled with, else the procedure's latest. */
export async function procForm(tx: Tx, t: string, procedureId: string | null, formId?: string | null): Promise<{ id: string; version: number; schema: FormSchema } | null> {
  const pick = (r: any) => (r ? { id: r.id as string, version: r.version as number, schema: r.schema as FormSchema } : null);
  if (formId) { const r = await tx.select().from(formDefinition).where(and(eq(formDefinition.id, formId), eq(formDefinition.tenantId, t))).then((x) => x[0]); if (r) return pick(r); }
  if (!procedureId) return null;
  return pick(await tx.select().from(formDefinition).where(and(eq(formDefinition.tenantId, t), eq(formDefinition.key, `procedure:${procedureId}`), eq(formDefinition.active, true))).orderBy(desc(formDefinition.version)).then((x) => x[0]));
}
/** The doctor or the desk: who may fill a session's form and ask the pharmacy. */
const canFill = (perms: string[]) => { if (!can(perms, 'worklist.write') && !can(perms, 'encounter.complete')) throw new HttpError(403, 'FORBIDDEN:worklist.write'); };

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

/** The doctor of a course: the one named on it (added from the patient record), else the consultation's doctor. */
export async function courseDoctor(tx: Tx, rec: { practitionerId: string | null; encounterId: string }) {
  return rec.practitionerId ?? await tx.select({ d: encounter.practitionerId }).from(encounter).where(eq(encounter.id, rec.encounterId)).then((r) => r[0]?.d ?? null);
}

/** The Monday of the week a day falls in. */
export const weekOf = (day: string) => addDays(day, -((new Date(day + 'T00:00:00Z').getUTCDay() + 6) % 7));

/**
 * The doctor's say on a sitting someone books or moves. Its own doctor booking or moving it approves it. Anyone else's goes to
 * that doctor: a new booking always waits as a draft until it is sent from Week plan; a move or doctor change goes straight away when its week was already sent, otherwise it waits as a draft until
 * the coordinator sends the week. Every sitting has a doctor (required since 15 Nov 2026; older ones were given their course's).
 */
export async function approvalFor(tx: Tx, ctx: Ctx, practitionerId: string | null | undefined, day: string, isNew = false) {
  const now = new Date().toISOString();
  const set = (approval: 'approved' | 'sent' | 'draft', changed: boolean) => ({ approval, approvalNote: null, approvedBy: approval === 'approved' ? ctx.name : null, approvedAt: approval === 'approved' ? now : null, changed, bookedBy: ctx.userId });
  if (!practitionerId) return set('draft', false);
  if (practitionerId === ctx.practitionerId) return set('approved', false);
  if (isNew) return set('draft', false); // a new booking waits to be sent from Week plan, even in a week already sent
  const wk = weekOf(day);
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

/**
 * The next sitting, booked by the plan when one is done: the gap after the day it was done, the same time, room and doctor.
 * If that is taken (or the doctor is away) it takes the nearest free time that day, else the next day; a Sunday is skipped unless the doctor works Sundays, and it looks
 * a week ahead at most. Tentative (the coordinator confirms it with the patient in the week before); nothing is booked when nothing fits.
 */
async function bookNextByPlan(tx: Tx, ctx: Ctx, done: typeof procedureSession.$inferSelect, gapDays: number) {
  const t = ctx.tenantId; const want = toMin(done.startTime);
  const rec = await tx.select({ practitionerId: recommendation.practitionerId, encounterId: recommendation.encounterId }).from(recommendation).where(eq(recommendation.id, done.recommendationId)).then((r) => r[0]);
  const doctor = done.practitionerId ?? (rec ? await courseDoctor(tx, rec) : null); // every session has a doctor; an old one without takes the course's
  const worksSunday = doctor ? !!(await tx.select({ r: practitioner.routine }).from(practitioner).where(eq(practitioner.id, doctor)).then((r) => r[0]?.r?.days?.['0']?.length)) : false;
  const proc = done.procedureId ? await tx.select().from(procedureCatalog).where(eq(procedureCatalog.id, done.procedureId)).then((r) => r[0]) : null;
  const def = sessionDef(proc, done.sittingNo + 1); // the next session as set up in Settings: its own length
  const span = def ? def.minutes + (proc?.bufferMinutes ?? 0) : toMin(done.endTime) - toMin(done.startTime);
  const first = addDays(done.day, gapDays);
  for (let k = 0; k < 7; k++) {
    const day = addDays(first, k);
    if (new Date(day + 'T00:00:00Z').getUTCDay() === 0 && !worksSunday) continue; // Sunday, when the doctor does not work it
    // the same start first, then the nearest half hour either side, inside the day
    const starts = [want, ...Array.from({ length: 22 }, (_, i) => want + (i % 2 ? -1 : 1) * 30 * (Math.floor(i / 2) + 1))].filter((m) => m >= 9 * 60 && m + span <= DAY_END);
    for (const m of starts) {
      const startTime = toHHMM(m); const endTime = toHHMM(m + span);
      if ((await conflicts(tx, t, day, startTime, endTime, done.roomId, doctor)).length) continue;
      const [{ n }] = await tx.select({ n: sql<number>`coalesce(max(${procedureSession.sittingNo}), 0)::int` }).from(procedureSession).where(and(eq(procedureSession.recommendationId, done.recommendationId), sql`${procedureSession.state} <> 'cancelled'`));
      const [ps] = await tx.insert(procedureSession).values({ tenantId: t, recommendationId: done.recommendationId, patientId: done.patientId, procedureId: done.procedureId, practitionerId: doctor, roomId: done.roomId,
        sittingNo: n + 1, day, startTime, endTime, autoBooked: true, ...(await approvalFor(tx, { ...ctx, practitionerId: null } as Ctx, doctor, day, true)), bookedBy: ctx.userId }).returning(); // never approved just because a doctor marked theirs done
      await planSittingReminder(tx, t, ps.id);
      if (doctor) await tx.insert(calendarBlock).values({ tenantId: t, practitionerId: doctor, roomId: done.roomId, day, startTime, endTime, kind: 'procedure', note: `${proc?.name ?? 'Procedure'} · session ${n + 1}`, procedureSessionId: ps.id });
      await emit(tx, ctx, 'procedure_session.scheduled', 'procedure_session', ps.id, { day, startTime, endTime, roomId: done.roomId, practitionerId: doctor, byPlan: true });
      return ps;
    }
  }
  return null;
}

export function procedureRoutes(app: FastifyInstance) {
  /** Feasible slots for a procedure on a day: rooms with the needed capability, free of conflicts. */
  route(app, 'get', '/procedure-sessions/slots', 'worklist.read', async (req, tx) => {
    const q = z.object({ day: DAY, procedureId: z.string().uuid(), practitionerId: z.string().uuid().optional(), minutes: z.coerce.number().int().min(5).optional(), recommendationId: z.string().uuid().optional() }).parse(req.query);
    const t = req.ctx.tenantId;
    const proc = await tx.select().from(procedureCatalog).where(and(eq(procedureCatalog.id, q.procedureId), eq(procedureCatalog.tenantId, t))).then((r) => r[0]);
    if (!proc) throw new HttpError(404, 'PROCEDURE_NOT_FOUND');
    const minutes = q.minutes ?? proc.typicalMinutes;
    const rooms = (await tx.select().from(room).where(and(eq(room.tenantId, t), eq(room.active, true)))).filter((r) => !proc.requiredCapability || r.capabilities.includes(proc.requiredCapability));
    const slots: any[] = [];
    // no slot that has already started: none on a past day, and today only from now on
    const today = todayIn(req.ctx.timezone);
    const from = q.day < today ? Infinity : q.day === today ? toMin(nowHHMM(req.ctx.timezone)) : 0;
    for (const r of rooms) for (let m = 9 * 60; m + minutes <= 20 * 60; m += 30) {
      if (m < from) continue;
      const c = await conflicts(tx, t, q.day, toHHMM(m), toHHMM(m + minutes), r.id, q.practitionerId ?? null);
      if (!c.length) slots.push({ roomId: r.id, room: r.name, startTime: toHHMM(m), endTime: toHHMM(m + minutes) });
    }
    // the course's doctor, so the booking drawer starts with them picked
    const rec = q.recommendationId ? await tx.select().from(recommendation).where(and(eq(recommendation.id, q.recommendationId), eq(recommendation.tenantId, t))).then((r) => r[0]) : null;
    return { minutes, rooms: rooms.map((r) => ({ id: r.id, name: r.name })), requiredCapability: proc.requiredCapability, slots, courseDoctorId: rec ? await courseDoctor(tx, rec) : null };
  });

  const ScheduleIn = z.object({ recommendationId: z.string().uuid(), day: DAY, startTime: HHMM, minutes: z.number().int().min(5).max(480), autoMinutes: z.boolean().optional(), roomId: z.string().uuid().nullable().optional(), practitionerId: z.string().uuid().nullable().optional(), notes: z.string().optional(), force: z.boolean().default(false),
    // planned: placed on the coordinator's week, not booked with the patient, so it does not count as the patient's yes
    planned: z.boolean().default(false) });
  /** A session cannot be booked or moved into a time that has already started (the manual time too). */
  const notPast = (ctx: Ctx, day: string, startTime: string) => {
    const today = todayIn(ctx.timezone);
    if (day < today || (day === today && startTime < nowHHMM(ctx.timezone))) throw new HttpError(409, 'PAST_TIME');
  };
  /** Schedule a sitting. Blocks the doctor's OP time when a doctor is assigned, so booking capacity drops automatically. */
  const book = async (req: { ctx: Ctx; body: unknown }, tx: Tx) => {
    const body = ScheduleIn.parse(req.body); const t = req.ctx.tenantId;
    if (!body.force) notPast(req.ctx, body.day, body.startTime); // force (API only; the drawer sends it just after a clash) may record one already done
    const rec = await tx.select().from(recommendation).where(and(eq(recommendation.id, body.recommendationId), eq(recommendation.tenantId, t))).then((r) => r[0]);
    if (!rec || rec.kind !== 'procedure') throw new HttpError(404, 'RECOMMENDATION_NOT_FOUND');
    const proc = rec.procedureId ? await tx.select().from(procedureCatalog).where(eq(procedureCatalog.id, rec.procedureId)).then((r) => r[0]) : null;
    if (!body.practitionerId) throw new HttpError(400, 'DOCTOR_REQUIRED'); // every session has a doctor, who approves it
    if (proc?.requiredCapability && body.roomId) {
      const rm = await tx.select().from(room).where(eq(room.id, body.roomId)).then((r) => r[0]);
      if (!rm?.capabilities.includes(proc.requiredCapability)) throw new HttpError(409, 'ROOM_LACKS_CAPABILITY', { required: proc.requiredCapability, room: rm?.name });
    }
    // the next number after every sitting still on the plan (done or booked ahead), so two booked ahead never share a number
    const [{ n }] = await tx.select({ n: sql<number>`coalesce(max(${procedureSession.sittingNo}), 0)::int` }).from(procedureSession).where(and(eq(procedureSession.recommendationId, rec.id), sql`${procedureSession.state} <> 'cancelled'`));
    const minutes = body.autoMinutes ? sessionDef(proc, n + 1)?.minutes ?? body.minutes : body.minutes; // that session's length from Settings, unless the desk picked one
    const endTime = toHHMM(toMin(body.startTime) + minutes + (proc?.bufferMinutes ?? 0));
    const c = await conflicts(tx, t, body.day, body.startTime, endTime, body.roomId, body.practitionerId);
    if (c.length && !body.force) throw new HttpError(409, 'CONFLICT', { conflicts: c });
    // booked with the patient (at the desk or on the phone): that confirms the date for the calls already inside the time left
    const ahead = daysFrom(todayIn(req.ctx.timezone), body.day); const now = new Date().toISOString();
    const [ps] = await tx.insert(procedureSession).values({ tenantId: t, recommendationId: rec.id, patientId: rec.patientId, procedureId: rec.procedureId, practitionerId: body.practitionerId ?? null, roomId: body.roomId ?? null,
      sittingNo: n + 1, day: body.day, startTime: body.startTime, endTime, notes: body.notes, weekConfirmedAt: ahead <= 7 && !body.planned ? now : null, patientConfirmedAt: ahead <= 1 && !body.planned ? now : null, ...(await approvalFor(tx, req.ctx, body.practitionerId, body.day, true)) }).returning();
    await planSittingReminder(tx, t, ps.id);
    if (body.practitionerId) await tx.insert(calendarBlock).values({ tenantId: t, practitionerId: body.practitionerId, roomId: body.roomId ?? null, day: body.day, startTime: body.startTime, endTime, kind: 'procedure', note: `${proc?.name ?? 'Procedure'} · session ${n + 1}`, procedureSessionId: ps.id });
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
    if (!body.practitionerId) throw new HttpError(400, 'DOCTOR_REQUIRED'); // every session has a doctor, who approves it
    if (body.practitionerId) {
      const c = (await conflicts(tx, t, ps.day, ps.startTime, ps.endTime, null, body.practitionerId, id));
      if (c.length && !body.force) throw new HttpError(409, 'CONFLICT', { conflicts: c });
    }
    if (body.supervisorId && body.supervisorId === body.practitionerId) throw new HttpError(400, 'SUPERVISOR_IS_THE_DOCTOR');
    const who = body.practitionerId !== ps.practitionerId ? await approvalFor(tx, req.ctx, body.practitionerId, ps.day) : {};
    const [row] = await tx.update(procedureSession).set({ practitionerId: body.practitionerId, ...who, ...(body.supervisorId !== undefined ? { supervisorId: body.supervisorId } : {}) }).where(eq(procedureSession.id, id)).returning();
    await planSittingReminder(tx, t, id);
    await tx.delete(calendarBlock).where(eq(calendarBlock.procedureSessionId, id));
    if (body.practitionerId) await tx.insert(calendarBlock).values({ tenantId: t, practitionerId: body.practitionerId, roomId: ps.roomId, day: ps.day, startTime: ps.startTime, endTime: ps.endTime, kind: 'procedure', note: `${proc?.name ?? 'Procedure'} · session ${ps.sittingNo}`, procedureSessionId: id });
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
    await auditView(tx, req, r.p.id, 'Opened a procedure session');
    const enc = r.rec ? await tx.select({ at: encounter.createdAt, data: encounter.data }).from(encounter).where(eq(encounter.id, r.rec.encounterId)).then((x) => x[0]) : null;
    const names = (x: any) => (Array.isArray(x) ? x.map((d) => (typeof d === 'string' ? d : d?.name)).filter(Boolean) : []);
    const sittings = await tx.select({ id: procedureSession.id, sittingNo: procedureSession.sittingNo, day: procedureSession.day, startTime: procedureSession.startTime, endTime: procedureSession.endTime, practitionerId: procedureSession.practitionerId, roomId: procedureSession.roomId, autoBooked: procedureSession.autoBooked, approval: procedureSession.approval, state: procedureSession.state, notes: procedureSession.notes, outcome: procedureSession.outcome, stateReason: procedureSession.stateReason })
      .from(procedureSession).where(and(eq(procedureSession.tenantId, t), eq(procedureSession.recommendationId, r.ps.recommendationId))).orderBy(asc(procedureSession.day), asc(procedureSession.startTime));
    const supervisor = r.ps.supervisorId ? await tx.select({ name: practitioner.name }).from(practitioner).where(eq(practitioner.id, r.ps.supervisorId)).then((x) => x[0]?.name ?? null) : null;
    const money = can(req.perms, 'fees.see') && !['cancelled', 'postponed'].includes(r.ps.state) ? await sittingMoney(tx, t, r.ps) : null;
    const form = await procForm(tx, t, r.ps.procedureId, r.ps.formDefinitionId);
    // the same procedure's earlier sessions for this patient, newest first: "Last time" beside each field
    const earlier = r.ps.procedureId ? await tx.select({ id: procedureSession.id, day: procedureSession.day, sittingNo: procedureSession.sittingNo, outcome: procedureSession.outcome }).from(procedureSession)
      .where(and(eq(procedureSession.tenantId, t), eq(procedureSession.patientId, r.p.id), eq(procedureSession.procedureId, r.ps.procedureId), eq(procedureSession.state, 'completed'), sql`${procedureSession.id} <> ${id}`, lte(procedureSession.day, r.ps.day)))
      .orderBy(desc(procedureSession.day), desc(procedureSession.startTime)).limit(6) : [];
    return { ...r.ps, form, earlier, missing: form ? missingRequired(form.schema, r.ps.outcome) : [], patient: { ...r.p, history: normHistory(r.p.history) }, procedure: r.procedure, minutes: r.minutes, room: r.room, doctor: r.doctor, supervisor, money, ...(await procedureConsent(tx, t, r.ps)),
      plan: r.rec ? { notes: r.rec.notes, sittings: r.rec.sittings, plannedOn: enc?.at ?? null, diagnosis: names((enc?.data as any)?.assessment?.diagnosis) } : null, sittings };
  });

  /** Move an upcoming sitting (or one postponed or missed) to another day, time, room or doctor. The doctor's blocked time moves with it; the reason goes in the contact log. */
  const move = async (req: { ctx: Ctx; body: unknown; params: unknown }, tx: Tx) => {
    const body = ScheduleIn.omit({ recommendationId: true }).extend({ reason: z.string().trim().max(200).optional() }).parse(req.body);
    if (!body.force) notPast(req.ctx, body.day, body.startTime); // force (API only; the drawer sends it just after a clash) may record one already done
    const t = req.ctx.tenantId; const id = (req.params as any).id;
    const ps = await tx.select().from(procedureSession).where(and(eq(procedureSession.id, id), eq(procedureSession.tenantId, t))).then((r) => r[0]);
    if (!ps) throw new HttpError(404, 'NOT_FOUND');
    if (!['confirmed', 'postponed', 'missed'].includes(ps.state)) throw new HttpError(409, 'NOT_RESCHEDULABLE', { state: ps.state });
    const proc = ps.procedureId ? await tx.select().from(procedureCatalog).where(eq(procedureCatalog.id, ps.procedureId)).then((r) => r[0]) : null;
    if (!body.practitionerId) throw new HttpError(400, 'DOCTOR_REQUIRED'); // every session has a doctor, who approves it
    if (proc?.requiredCapability && body.roomId) {
      const rm = await tx.select().from(room).where(eq(room.id, body.roomId)).then((r) => r[0]);
      if (!rm?.capabilities.includes(proc.requiredCapability)) throw new HttpError(409, 'ROOM_LACKS_CAPABILITY', { required: proc.requiredCapability, room: rm?.name });
    }
    const endTime = toHHMM(toMin(body.startTime) + body.minutes + (proc?.bufferMinutes ?? 0));
    const c = await conflicts(tx, t, body.day, body.startTime, endTime, body.roomId, body.practitionerId, id);
    if (c.length && !body.force) throw new HttpError(409, 'CONFLICT', { conflicts: c });
    // a move inside the week counts as the week's confirmation; the day-before call is still made (the clinic may have moved it)
    const ahead = daysFrom(todayIn(req.ctx.timezone), body.day);
    const [moved] = await tx.update(procedureSession).set({ autoBooked: false, day: body.day, startTime: body.startTime, endTime, roomId: body.roomId ?? null, practitionerId: body.practitionerId ?? null, state: 'confirmed', stateReason: null, patientConfirmedAt: null, weekConfirmedAt: ahead <= 7 && !body.planned ? new Date().toISOString() : null, notes: body.notes ?? ps.notes, ...(await approvalFor(tx, req.ctx, body.practitionerId, body.day)) }).where(eq(procedureSession.id, id)).returning();
    await planSittingReminder(tx, t, id);
    await tx.delete(calendarBlock).where(eq(calendarBlock.procedureSessionId, id));
    if (body.practitionerId) await tx.insert(calendarBlock).values({ tenantId: t, practitionerId: body.practitionerId, roomId: body.roomId ?? null, day: body.day, startTime: body.startTime, endTime, kind: 'procedure', note: `${proc?.name ?? 'Procedure'} · session ${ps.sittingNo}`, procedureSessionId: id });
    const rec = await tx.select().from(recommendation).where(eq(recommendation.id, ps.recommendationId)).then((r) => r[0]);
    if (rec) await tx.update(recommendation).set({ status: 'scheduled', dueOn: body.day, contactLog: [...rec.contactLog, { at: new Date().toISOString(), by: req.ctx.name, outcome: 'Session rescheduled', note: `${ps.day} ${ps.startTime} → ${body.day} ${body.startTime}${body.reason ? ` · ${body.reason}` : ''}` }] }).where(eq(recommendation.id, rec.id));
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
    const doctor = ps ? ps.practitionerId ?? await courseDoctor(tx, rec) : await courseDoctor(tx, rec);
    if (!doctor) throw new HttpError(409, 'NO_FIT', { why: 'pick a doctor for this session first' });
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
    return { start, sent: !!sent, sentAt: sent?.createdAt ?? null, sentBy: sent?.sentBy ?? null, away };
  });

  /** Send a week to the doctors: each draft in it goes to its own doctor. From then on, a change in that week reaches the doctor straight away. */
  route(app, 'post', '/procedure-weeks/:start/send', 'worklist.write', async (req, tx) => {
    const start = weekOf(DAY.parse((req.params as any).start)); const t = req.ctx.tenantId;
    await tx.insert(procedureWeek).values({ tenantId: t, weekStart: start, sentBy: req.ctx.name }).onConflictDoNothing();
    const wk = await tx.select().from(procedureWeek).where(and(eq(procedureWeek.tenantId, t), eq(procedureWeek.weekStart, start))).then((r) => r[0]);
    const rows = await tx.update(procedureSession).set({ approval: 'sent' })
      .where(and(eq(procedureSession.tenantId, t), gte(procedureSession.day, start), lte(procedureSession.day, addDays(start, 6)), eq(procedureSession.approval, 'draft'), eq(procedureSession.state, 'confirmed'), sql`${procedureSession.practitionerId} is not null`)).returning({ id: procedureSession.id });
    await emit(tx, req.ctx, 'procedure_week.sent', 'procedure_week', wk.id, { start, sittings: rows.length });
    return { start, sent: rows.length };
  });

  /** Send chosen drafts to their doctors now (from Today's sessions), without sending the rest of the week. */
  route(app, 'post', '/procedure-sessions/send', 'worklist.write', async (req, tx) => {
    const { ids } = z.object({ ids: z.array(z.string().uuid()).min(1).max(200) }).parse(req.body); const t = req.ctx.tenantId;
    const rows = await tx.update(procedureSession).set({ approval: 'sent' })
      .where(and(eq(procedureSession.tenantId, t), inArray(procedureSession.id, ids), eq(procedureSession.approval, 'draft'), eq(procedureSession.state, 'confirmed'), sql`${procedureSession.practitionerId} is not null`)).returning({ id: procedureSession.id });
    for (const r of rows) await emit(tx, req.ctx, 'procedure_session.sent', 'procedure_session', r.id, {});
    return { sent: rows.length };
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
    const body = z.object({ state: z.enum(['confirmed', 'in_progress', 'completed', 'missed', 'cancelled', 'postponed']), reason: z.string().optional(), outcome: z.record(z.string(), z.any()).optional(), consent: z.boolean().optional(), consentDocumentId: z.string().uuid().optional(), consentWording: z.string().trim().max(8000).optional() }).parse(req.body);
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
      const pr = await tx.select({ pricing: procedureCatalog.pricing }).from(procedureCatalog).where(eq(procedureCatalog.id, cur.procedureId)).then((r) => r[0]);
      if (pr?.pricing === 'upfront') { // paid in full before it starts
        const c = await tx.select().from(course).where(and(eq(course.tenantId, t), eq(course.recommendationId, cur.recommendationId))).then((r) => r[0]);
        const left = c ? (await standing(tx, t, c)).stillToPayPaise : null;
        if (left === null || left > 0) throw new HttpError(409, 'PAY_UPFRONT_FIRST', { stillToPayPaise: left });
      }
      if ((await procedureConsent(tx, t, cur)).consentNeeded) {
        if (body.consent !== true) throw new HttpError(409, 'CONSENT_NEEDED');
        // a signature from the tablet must be a document of this same patient, in this clinic
        let doc: { id: string; sha256: string | null } | undefined;
        if (body.consentDocumentId) {
          doc = await tx.select({ id: document.id, sha256: document.sha256 }).from(document).where(and(eq(document.id, body.consentDocumentId), eq(document.tenantId, t), eq(document.patientId, cur.patientId), eq(document.kind, 'consent'))).then((r) => r[0]);
          if (!doc) throw new HttpError(400, 'CONSENT_NOT_FOR_PATIENT');
        }
        const p = await tx.select({ consents: patient.consents }).from(patient).where(eq(patient.id, cur.patientId)).then((r) => r[0]);
        const key = consentKey(cur.procedureId); const at = new Date().toISOString();
        const rec: Consent = { grantedAt: at, by: req.ctx.name, ...(doc ? signedRecord(doc, body.consentWording) : { how: 'signed paper form filed' }) };
        await tx.update(patient).set({ consents: { ...(p?.consents ?? {}), [key]: rec } }).where(eq(patient.id, cur.patientId));
        await emit(tx, req.ctx, 'consent.granted', 'patient', cur.patientId, { key, procedureSessionId: id, ...(doc ? { documentId: doc.id, sha256: doc.sha256, wordingSha256: body.consentWording ? createHash('sha256').update(body.consentWording).digest('hex') : null } : {}) });
      }
    }
    const form = ['in_progress', 'completed'].includes(body.state) ? await procForm(tx, t, cur.procedureId, cur.formDefinitionId) : null;
    if (body.state === 'completed' && cur.state !== 'completed' && form) {
      const missing = missingRequired(form.schema, body.outcome ?? cur.outcome);
      if (missing.length) throw new HttpError(409, 'FORM_INCOMPLETE', { missing });
    }
    // starting: the session keeps this form version, and the usual products go to the pharmacy once
    const ask: SupplyAsk[] | undefined = body.state === 'in_progress' && form?.schema.products?.length && !cur.supplies.length
      ? [{ id: randomUUID(), at: new Date().toISOString(), by: req.ctx.name, lines: form.schema.products, status: 'asked' }] : undefined;
    const [ps] = await tx.update(procedureSession).set({ state: body.state, stateReason: body.reason, ...(body.outcome ? { outcome: body.outcome } : {}), ...(form && !cur.formDefinitionId ? { formDefinitionId: form.id } : {}), ...(ask ? { supplies: ask } : {}) }).where(and(eq(procedureSession.id, id), eq(procedureSession.tenantId, t))).returning();
    if (!ps) throw new HttpError(404, 'NOT_FOUND');
    if (['cancelled', 'postponed', 'missed'].includes(body.state)) await tx.delete(calendarBlock).where(eq(calendarBlock.procedureSessionId, id));
    const rec = await tx.select().from(recommendation).where(eq(recommendation.id, ps.recommendationId)).then((r) => r[0]);
    if (rec) {
      const done = await tx.select({ n: sql<number>`count(*)::int` }).from(procedureSession).where(and(eq(procedureSession.recommendationId, rec.id), eq(procedureSession.state, 'completed')));
      const newStatus = body.state === 'completed' && rec.sittings && done[0].n >= rec.sittings ? 'done' : body.state === 'cancelled' ? 'open' : ['postponed', 'missed'].includes(body.state) ? 'contacted' : rec.status;
      const log = ['postponed', 'missed', 'cancelled'].includes(body.state) ? [...rec.contactLog, { at: new Date().toISOString(), by: req.ctx.name, outcome: `Session ${body.state}`, note: body.reason }] : rec.contactLog;
      // a sitting done with more to come: the next falls due one gap after it (not after the original plan), unless one is booked already
      let nextDue: string | undefined;
      const nextDef = cur.procedureId ? sessionDef(await tx.select().from(procedureCatalog).where(eq(procedureCatalog.id, cur.procedureId)).then((r) => r[0]), ps.sittingNo + 1) : undefined;
      const gap = nextDef?.gapDays || rec.gapDays;
      if (body.state === 'completed' && newStatus !== 'done' && gap) {
        const [{ ahead }] = await tx.select({ ahead: sql<number>`count(*)::int` }).from(procedureSession).where(and(eq(procedureSession.recommendationId, rec.id), eq(procedureSession.state, 'confirmed'), sql`${procedureSession.id} <> ${id}`));
        if (!ahead) nextDue = addDays(ps.day, gap);
      }
      await tx.update(recommendation).set({ status: newStatus, contactLog: log, ...(nextDue ? { dueOn: nextDue } : {}) }).where(eq(recommendation.id, rec.id));
      // with no sitting booked ahead, the plan books the next one itself (the first is always booked with the patient)
      if (nextDue && gap) { const nb = await bookNextByPlan(tx, req.ctx, ps, gap); if (nb) await tx.update(recommendation).set({ status: 'scheduled', dueOn: nb.day }).where(eq(recommendation.id, rec.id)); }
    }
    await planSittingReminder(tx, t, id); // only a sitting still booked keeps its reminder
    if (body.state === 'completed') await drawSitting(tx, req.ctx, ps);
    else if (cur.state === 'completed') await reverseSitting(tx, req.ctx, id, body.state === 'cancelled' ? 'Session cancelled' : `Session moved back to ${body.state.replace('_', ' ')}`);
    await emit(tx, req.ctx, `procedure_session.${body.state}`, 'procedure_session', id, { reason: body.reason, ...(body.state === 'in_progress' && body.consent !== undefined ? { consent: body.consent } : {}) });
    return ps;
  });

  /** Save the session form. Allowed from booking until done (Before can be filled early) and after, to correct a value. */
  route(app, 'put', '/procedure-sessions/:id/form', null, async (req, tx) => {
    canFill(req.perms);
    const body = z.object({ values: z.record(z.string(), z.any()) }).parse(req.body);
    const t = req.ctx.tenantId; const id = (req.params as any).id;
    const cur = await tx.select().from(procedureSession).where(and(eq(procedureSession.id, id), eq(procedureSession.tenantId, t))).then((r) => r[0]);
    if (!cur) throw new HttpError(404, 'NOT_FOUND');
    if (['cancelled', 'postponed', 'missed'].includes(cur.state)) throw new HttpError(409, 'NOT_CHANGEABLE', { state: cur.state });
    const form = await procForm(tx, t, cur.procedureId, cur.formDefinitionId);
    if (!form) throw new HttpError(409, 'NO_FORM');
    const values = cleanValues(form.schema, body.values);
    await tx.update(procedureSession).set({ outcome: values, formDefinitionId: form.id }).where(eq(procedureSession.id, id));
    await emit(tx, req.ctx, 'procedure_session.form_saved', 'procedure_session', id, { version: form.version, fields: Object.keys(values).length });
    return { outcome: values, missing: missingRequired(form.schema, values) };
  });

  /** Ask the pharmacy for more products for this session (the usual ones are asked for on Start). */
  route(app, 'post', '/procedure-sessions/:id/supplies', null, async (req, tx) => {
    canFill(req.perms);
    const body = z.object({ lines: z.array(z.object({ medicineId: z.string().uuid(), qty: z.number().int().min(1).max(999) })).min(1).max(20) }).parse(req.body);
    const t = req.ctx.tenantId; const id = (req.params as any).id;
    const cur = await tx.select().from(procedureSession).where(and(eq(procedureSession.id, id), eq(procedureSession.tenantId, t))).then((r) => r[0]);
    if (!cur) throw new HttpError(404, 'NOT_FOUND');
    if (['cancelled', 'postponed', 'missed'].includes(cur.state)) throw new HttpError(409, 'NOT_CHANGEABLE', { state: cur.state });
    const meds = await tx.select({ id: medicine.id, name: medicine.name }).from(medicine).where(and(eq(medicine.tenantId, t), inArray(medicine.id, body.lines.map((l) => l.medicineId))));
    const name = new Map(meds.map((m) => [m.id, m.name]));
    if (body.lines.some((l) => !name.has(l.medicineId))) throw new HttpError(404, 'NOT_FOUND');
    const ask: SupplyAsk = { id: randomUUID(), at: new Date().toISOString(), by: req.ctx.name, lines: body.lines.map((l) => ({ ...l, name: name.get(l.medicineId)! })), status: 'asked' };
    await tx.update(procedureSession).set({ supplies: [...cur.supplies, ask] }).where(eq(procedureSession.id, id));
    await emit(tx, req.ctx, 'procedure_session.supplies_asked', 'procedure_session', id, { items: ask.lines.length });
    return ask;
  });

  /** A plan's sessions with what each recorded, and the fields to show them by: the latest form first, then any field only older versions had. */
  route(app, 'get', '/procedure-plans/:id/form-history', 'worklist.read', async (req, tx) => {
    const t = req.ctx.tenantId; const id = (req.params as any).id;
    if (!z.string().uuid().safeParse(id).success) throw new HttpError(404, 'NOT_FOUND');
    const rec = await tx.select({ id: recommendation.id, procedureId: recommendation.procedureId }).from(recommendation).where(and(eq(recommendation.id, id), eq(recommendation.tenantId, t))).then((r) => r[0]);
    if (!rec) throw new HttpError(404, 'NOT_FOUND');
    const sessions = await tx.select({ id: procedureSession.id, sittingNo: procedureSession.sittingNo, day: procedureSession.day, state: procedureSession.state, outcome: procedureSession.outcome, formDefinitionId: procedureSession.formDefinitionId, supplies: procedureSession.supplies })
      .from(procedureSession).where(and(eq(procedureSession.tenantId, t), eq(procedureSession.recommendationId, id), sql`${procedureSession.state} not in ('cancelled','postponed')`)).orderBy(asc(procedureSession.day), asc(procedureSession.startTime));
    const latest = await procForm(tx, t, rec.procedureId);
    const olderIds = [...new Set(sessions.map((s) => s.formDefinitionId).filter((x): x is string => !!x && x !== latest?.id))];
    const older = olderIds.length ? await tx.select({ schema: formDefinition.schema }).from(formDefinition).where(and(eq(formDefinition.tenantId, t), inArray(formDefinition.id, olderIds))) : [];
    const fields: any[] = []; const seen = new Set<string>();
    for (const s of [latest?.schema, ...older.map((o) => o.schema)]) for (const sec of s?.sections ?? []) for (const f of sec.fields) if (sec.key !== 'consult' && !seen.has(f.key)) { seen.add(f.key); fields.push(f); }
    return { hasForm: !!latest, fields, sessions: sessions.map((s) => ({ ...s, products: s.supplies.flatMap((a) => a.issued ?? []).map((x) => `${x.name} × ${x.qty}`) })) };
  });
}
