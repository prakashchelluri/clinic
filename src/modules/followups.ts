import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { appointment, callback, course, message, patient, procedureCatalog, procedureSession, recommendation, session, tenant } from '../db/schema.js';
import type { Tx } from '../db/index.js';
import { route } from '../lib/route.js';
import { emit, todayIn, addDays } from '../lib/core.js';
import { HttpError } from '../lib/auth.js';

type Kind = 'review' | 'missed_visit' | 'missed_sitting' | 'schedule' | 'advised';
const TABS = { reviews: ['review'], missed: ['missed_visit', 'missed_sitting'], schedule: ['schedule'], advised: ['advised'] } as const;
type Tab = keyof typeof TABS;
const P = { id: patient.id, fullName: patient.fullName, phone: patient.phone, patientNo: patient.patientNo, ageYears: patient.ageYears, sex: patient.sex, flags: patient.flags };
type Row = { key: string; kind: Kind; refId: string; patient: any; what: string; dueOn: string | null; lastCall?: { outcome: string; note: string | null; at: string; by: string; callbackOn: string | null; attempts: number } | null; waiting?: boolean };

/** Every patient the desk should call, in four lists. A call outcome of Booked or Not interested takes the row off the list. */
async function build(tx: Tx, t: string, tz: string) {
  const today = todayIn(tz);
  const open = sql`${recommendation.status} in ('open','contacted')`;
  const recs = (kind: string) => tx.select({ r: recommendation, p: P, proc: procedureCatalog.name }).from(recommendation).innerJoin(patient, eq(patient.id, recommendation.patientId))
    .leftJoin(procedureCatalog, eq(procedureCatalog.id, recommendation.procedureId)).where(and(eq(recommendation.tenantId, t), eq(recommendation.kind, kind), open));
  const followups = await recs('followup'); const procs = await recs('procedure');
  const agreed = new Set((await tx.select({ id: course.recommendationId }).from(course).where(eq(course.tenantId, t))).map((c) => c.id));
  const booked = procs.length ? new Set((await tx.select({ id: procedureSession.recommendationId }).from(procedureSession).where(and(eq(procedureSession.tenantId, t), inArray(procedureSession.recommendationId, procs.map((x) => x.r.id)), eq(procedureSession.state, 'confirmed')))).map((x) => x.id)) : new Set<string>();
  const rows: Row[] = [];
  for (const x of followups) rows.push({ key: x.r.id, kind: 'review', refId: x.r.id, patient: x.p, what: 'Review', dueOn: x.r.dueOn });
  for (const x of procs) {
    if (booked.has(x.r.id)) continue;
    const what = `${x.proc ?? 'Procedure'}${x.r.sittings ? ` · ${x.r.sittings} sittings` : ''}`;
    rows.push({ key: x.r.id, kind: agreed.has(x.r.id) ? 'schedule' : 'advised', refId: x.r.id, patient: x.p, what, dueOn: x.r.dueOn });
  }
  const from = addDays(today, -30);
  const noShows = await tx.select({ a: appointment, p: P, day: session.day, start: session.startTime }).from(appointment).innerJoin(session, eq(session.id, appointment.sessionId)).innerJoin(patient, eq(patient.id, appointment.patientId))
    .where(and(eq(appointment.tenantId, t), eq(appointment.status, 'no_show'), gte(session.day, from)));
  for (const x of noShows) rows.push({ key: x.a.id, kind: 'missed_visit', refId: x.a.id, patient: x.p, what: `Missed visit on ${x.day} ${x.start}`, dueOn: x.day });
  const missed = await tx.select({ ps: procedureSession, p: P, proc: procedureCatalog.name }).from(procedureSession).innerJoin(patient, eq(patient.id, procedureSession.patientId)).leftJoin(procedureCatalog, eq(procedureCatalog.id, procedureSession.procedureId))
    .where(and(eq(procedureSession.tenantId, t), eq(procedureSession.state, 'missed'), gte(procedureSession.day, addDays(today, -60))));
  for (const x of missed) rows.push({ key: x.ps.id, kind: 'missed_sitting', refId: x.ps.id, patient: x.p, what: `Missed ${x.proc ?? 'procedure'} sitting ${x.ps.sittingNo} on ${x.ps.day}`, dueOn: x.ps.day });
  // last call and number of attempts per row
  const calls = rows.length ? await tx.select().from(callback).where(and(eq(callback.tenantId, t), inArray(callback.refId, rows.map((r) => r.refId)))).orderBy(desc(callback.createdAt)) : [];
  const out: Row[] = [];
  for (const r of rows) {
    const mine = calls.filter((c) => c.refId === r.refId && c.kind === r.kind || (c.refId === r.refId && ['schedule', 'advised'].includes(c.kind) && ['schedule', 'advised'].includes(r.kind)));
    const last = mine[0];
    if (last && ['booked', 'not_interested'].includes(last.outcome)) continue;
    r.lastCall = last ? { outcome: last.outcome, note: last.note, at: last.createdAt, by: last.byName, callbackOn: last.callbackOn, attempts: mine.length } : null;
    r.waiting = !!last?.callbackOn && last.callbackOn > today;
    out.push(r);
  }
  out.sort((a, b) => Number(!!a.waiting) - Number(!!b.waiting) || (a.lastCall?.callbackOn ?? a.dueOn ?? '9999').localeCompare(b.lastCall?.callbackOn ?? b.dueOn ?? '9999'));
  return out;
}

export function followupRoutes(app: FastifyInstance) {
  route(app, 'get', '/followups', 'worklist.read', async (req, tx) => {
    const all = await build(tx, req.ctx.tenantId, req.ctx.timezone);
    const tab = (String((req.query as any).tab ?? 'reviews') as Tab); if (!TABS[tab]) throw new HttpError(400, 'BAD_TAB');
    const counts = Object.fromEntries((Object.keys(TABS) as Tab[]).map((k) => [k, all.filter((r) => (TABS[k] as readonly string[]).includes(r.kind) && !r.waiting).length]));
    return { counts, rows: all.filter((r) => (TABS[tab] as readonly string[]).includes(r.kind)) };
  });

  /** One call attempt. Call later needs a date (a Sunday asks to be confirmed); Not interested needs a reason; No answer can send a short message. */
  route(app, 'post', '/followups/log', 'worklist.write', async (req, tx) => {
    const b = z.object({ kind: z.enum(['review', 'missed_visit', 'missed_sitting', 'schedule', 'advised']), refId: z.string().uuid(), patientId: z.string().uuid(),
      outcome: z.enum(['booked', 'call_later', 'no_answer', 'not_interested']), note: z.string().trim().max(200).optional(), callbackOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      sendMessage: z.boolean().optional(), confirmClosedDay: z.boolean().optional() }).parse(req.body);
    const t = req.ctx.tenantId; const today = todayIn(req.ctx.timezone);
    if (b.outcome === 'call_later') {
      if (!b.callbackOn) throw new HttpError(400, 'DATE_NEEDED');
      if (b.callbackOn < today) throw new HttpError(400, 'DATE_IN_THE_PAST');
      if (new Date(b.callbackOn + 'T00:00:00Z').getUTCDay() === 0 && !b.confirmClosedDay) throw new HttpError(409, 'CLOSED_DAY', { day: b.callbackOn });
    }
    if (b.outcome === 'not_interested' && (b.note ?? '').length < 3) throw new HttpError(400, 'REASON_NEEDED');
    const p = await tx.select().from(patient).where(and(eq(patient.id, b.patientId), eq(patient.tenantId, t))).then((r) => r[0]);
    if (!p) throw new HttpError(404, 'NOT_FOUND');
    const [row] = await tx.insert(callback).values({ tenantId: t, patientId: b.patientId, kind: b.kind, refId: b.refId, outcome: b.outcome, note: b.note ?? null, callbackOn: b.outcome === 'call_later' ? b.callbackOn! : null, byName: req.ctx.name }).returning();
    if (['review', 'schedule', 'advised'].includes(b.kind)) {
      const rec = await tx.select().from(recommendation).where(and(eq(recommendation.id, b.refId), eq(recommendation.tenantId, t))).then((r) => r[0]);
      if (rec) await tx.update(recommendation).set({ status: b.outcome === 'not_interested' ? 'cancelled' : rec.status === 'open' ? 'contacted' : rec.status, contactLog: [...rec.contactLog, { at: new Date().toISOString(), by: req.ctx.name, outcome: b.outcome, note: b.note }] }).where(eq(recommendation.id, rec.id));
    }
    let messaged = false;
    if (b.outcome === 'no_answer' && b.sendMessage && p.phone && /^\d{10}$/.test(p.phone)) {
      const ten = await tx.select().from(tenant).where(eq(tenant.id, t)).then((r) => r[0]);
      const phone = (ten?.settings as any)?.print?.phone;
      await tx.insert(message).values({ tenantId: t, patientId: p.id, kind: 'followup_call', channel: 'whatsapp', toPhone: p.phone, params: { name: p.fullName },
        body: `Hello ${p.fullName.split(' ')[0]}, we tried to reach you from ${ten?.name ?? 'the clinic'}. ${phone ? `Please call ${phone} or ` : 'Please '}reply to this message and we will help you.` });
      messaged = true;
    }
    await emit(tx, req.ctx, 'followup.logged', 'callback', row.id, { kind: b.kind, outcome: b.outcome, callbackOn: b.callbackOn });
    return { ...row, messaged };
  });
}
