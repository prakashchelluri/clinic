import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, gte, inArray, ne, sql, desc } from 'drizzle-orm';
import { recommendation, document, patient, encounter, practitioner, labResult, appointment, session, visit, OPEN_STATUSES } from '../db/schema.js';
import { route } from '../lib/route.js';
import { emit, todayIn } from '../lib/core.js';
import { HttpError, can } from '../lib/auth.js';
import { paramsForTest } from '../lib/labs.js';

/** Tests ordered together form one order: each test has its own report, the doctor reviews the order once, when every report is in. */
export type OrderState = 'pending' | 'partial' | 'ready' | 'reviewed' | 'doctor_call' | 'closed';
const OUTCOMES = ['normal', 'change_medicines', 'needs_visit', 'will_call'] as const;
const HOW = ['in_person', 'phone', 'whatsapp'] as const;

function stateOf(tests: { receivedAt: string | null; reviewedAt: string | null; reviewOutcome: string | null; informedAt: string | null }[]): OrderState {
  if (tests.every((t) => t.informedAt)) return 'closed';
  if (tests.every((t) => t.reviewedAt)) return tests.some((t) => t.reviewOutcome === 'will_call') ? 'doctor_call' : 'reviewed';
  const got = tests.filter((t) => t.receivedAt).length;
  return got === tests.length ? 'ready' : got ? 'partial' : 'pending';
}

export function orderRoutes(app: FastifyInstance) {
  /** Every order that is not closed, plus what was closed today. tab filters; counts always cover all tabs. */
  route(app, 'get', '/orders', 'document.read', async (req, tx) => {
    const t = req.ctx.tenantId; const tab = String((req.query as any).tab ?? '');
    const today = todayIn(req.ctx.timezone);
    const rows = await tx.select({ r: recommendation, p: { id: patient.id, fullName: patient.fullName, patientNo: patient.patientNo, phone: patient.phone }, doctor: practitioner.name, encStatus: encounter.status })
      .from(recommendation).innerJoin(patient, eq(patient.id, recommendation.patientId)).innerJoin(encounter, eq(encounter.id, recommendation.encounterId)).leftJoin(practitioner, eq(practitioner.id, encounter.practitionerId))
      .where(and(eq(recommendation.tenantId, t), eq(recommendation.kind, 'investigation'), ne(recommendation.status, 'cancelled'),
        sql`(${recommendation.informedAt} is null or (${recommendation.informedAt} at time zone ${req.ctx.timezone})::date = ${today}::date)`));
    const ids = rows.map((x) => x.r.id);
    const docs = ids.length ? await tx.select().from(document).where(and(eq(document.tenantId, t), eq(document.kind, 'report'), sql`${document.recommendationIds} && ${sql.raw(`ARRAY['${ids.join("','")}']::uuid[]`)}`)).orderBy(desc(document.createdAt)) : [];
    // the values typed from each report, so the doctor reviews numbers, not only thumbnails
    const vals = ids.length ? await tx.select().from(labResult).where(and(eq(labResult.tenantId, t), inArray(labResult.recommendationId, ids))) : [];
    const OUT = ['low', 'high', 'abnormal'];
    const byKey = new Map<string, typeof rows>();
    for (const x of rows) { const k = `${x.r.encounterId}:${x.r.orderNo}`; byKey.set(k, [...(byKey.get(k) ?? []), x]); }
    const orders = [...byKey.entries()].map(([key, xs]) => {
      const first = xs[0]; const tests = xs.map((x) => ({ id: x.r.id, name: x.r.notes ?? 'Test', params: paramsForTest(x.r.notes ?? ''), expectedOn: x.r.expectedOn, receivedAt: x.r.receivedAt, reviewedAt: x.r.reviewedAt, reviewOutcome: x.r.reviewOutcome, informedAt: x.r.informedAt,
        late: !x.r.receivedAt && !!x.r.expectedOn && x.r.expectedOn < today, called: [...x.r.contactLog].reverse().find((c) => c.outcome === 'Called the lab')?.at ?? null,
        docs: docs.filter((d) => d.recommendationIds.includes(x.r.id)).map((d) => ({ id: d.id, title: d.title, mime: d.mime, kind: d.kind, sizeBytes: d.sizeBytes, createdAt: d.createdAt, note: d.note, reviewedAt: d.reviewedAt })),
        values: vals.filter((v) => v.recommendationId === x.r.id).map((v) => ({ id: v.id, test: v.test, value: v.value, unit: v.unit, low: v.low, high: v.high, flag: v.flag })).sort((a, b) => Number(OUT.includes(b.flag ?? '')) - Number(OUT.includes(a.flag ?? '')) || a.test.localeCompare(b.test)) })).sort((a, b) => a.name.localeCompare(b.name));
      const state = stateOf(tests);
      const abnormal = tests.reduce((n, x) => n + x.values.filter((v) => OUT.includes(v.flag ?? '')).length, 0);
      const o = tests.find((x) => x.reviewOutcome);
      // held: the consultation is still open for these reports, so a visit with them reopens it
      return { key, encounterId: first.r.encounterId, orderNo: first.r.orderNo, patient: first.p, doctor: first.doctor, orderedAt: first.r.createdAt, held: first.encStatus === 'awaiting_reports', tests, state, abnormal, got: tests.filter((x) => x.receivedAt).length,
        outcome: o?.reviewOutcome ?? null, note: xs.find((x) => x.r.reviewNote)?.r.reviewNote ?? null, reviewedBy: xs.find((x) => x.r.reviewedBy)?.r.reviewedBy ?? null,
        informedHow: xs.find((x) => x.r.informedHow)?.r.informedHow ?? null, receivedLast: tests.map((x) => x.receivedAt).filter(Boolean).sort().pop() ?? null,
        late: tests.filter((x) => x.late).map((x) => x.name), nextDue: tests.filter((x) => !x.receivedAt && x.expectedOn).map((x) => x.expectedOn as string).sort()[0] ?? null };
    });
    const tabOf = (o: { state: OrderState }) => o.state === 'pending' || o.state === 'partial' ? 'collect' : o.state === 'ready' ? 'review' : o.state === 'closed' ? 'done' : 'explain';
    const counts = { collect: 0, review: 0, explain: 0, done: 0 };
    for (const o of orders) counts[tabOf(o)]++;
    // out-of-range values first, then late, then by date
    const list = orders.filter((o) => !tab || tabOf(o) === tab).sort((a, b) => (a.abnormal ? 0 : 1) - (b.abnormal ? 0 : 1) || (a.late.length ? 0 : 1) - (b.late.length ? 0 : 1) ||String(a.nextDue ?? a.orderedAt).localeCompare(String(b.nextDue ?? b.orderedAt)));
    return { counts, orders: list };
  });

  const Key = z.object({ encounterId: z.string().uuid(), orderNo: z.number().int().min(1) });
  const find = async (tx: any, t: string, k: z.infer<typeof Key>) => {
    const recs = await tx.select().from(recommendation).where(and(eq(recommendation.tenantId, t), eq(recommendation.encounterId, k.encounterId), eq(recommendation.orderNo, k.orderNo), eq(recommendation.kind, 'investigation'), ne(recommendation.status, 'cancelled')));
    if (!recs.length) throw new HttpError(404, 'NOT_FOUND'); return recs as (typeof recommendation.$inferSelect)[];
  };

  /** The doctor looks at the whole order once and says what happens next. */
  route(app, 'post', '/orders/review', 'encounter.complete', async (req, tx) => {
    const b = Key.extend({ outcome: z.enum(OUTCOMES), note: z.string().trim().max(300).optional() }).parse(req.body); const t = req.ctx.tenantId;
    const recs = await find(tx, t, b);
    if (recs.some((r) => !r.receivedAt)) throw new HttpError(409, 'NOT_ALL_RECEIVED');
    if (recs.every((r) => r.reviewedAt)) throw new HttpError(409, 'ALREADY_REVIEWED');
    const now = new Date().toISOString();
    await tx.update(recommendation).set({ reviewedAt: now, reviewOutcome: b.outcome, reviewNote: b.note || null, reviewedBy: req.ctx.name }).where(inArray(recommendation.id, recs.map((r) => r.id)));
    await tx.update(document).set({ reviewedAt: now }).where(and(eq(document.tenantId, t), sql`${document.recommendationIds} && ${sql.raw(`ARRAY['${recs.map((r) => r.id).join("','")}']::uuid[]`)}`, sql`${document.reviewedAt} is null`));
    await emit(tx, req.ctx, 'order.reviewed', 'encounter', b.encounterId, { orderNo: b.orderNo, outcome: b.outcome, patientId: recs[0].patientId });
    // Nothing more to do in the consultation: it closes once every test in it is reviewed. Changing medicines keeps it open
    // for the doctor to edit; "needs a visit" keeps it open so the visit reopens the same consultation.
    let closed = false;
    if (b.outcome === 'normal' || b.outcome === 'will_call') {
      const enc = await tx.select({ status: encounter.status, provenance: encounter.provenance }).from(encounter).where(and(eq(encounter.id, b.encounterId), eq(encounter.tenantId, t))).then((r: any[]) => r[0]);
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(recommendation).where(and(eq(recommendation.encounterId, b.encounterId), eq(recommendation.kind, 'investigation'), ne(recommendation.status, 'cancelled'), sql`${recommendation.reviewedAt} is null`));
      if (enc?.status === 'awaiting_reports' && n === 0) {
        await tx.update(encounter).set({ status: 'completed', provenance: { ...(enc.provenance ?? {}), reportsClosedAt: now } }).where(eq(encounter.id, b.encounterId));
        closed = true;
      }
    }
    return { ok: true, patientId: recs[0].patientId, closed };
  });

  /** Front desk (or the doctor, if she phoned) tells the patient. Not before the doctor has reviewed. */
  route(app, 'post', '/orders/inform', null, async (req, tx) => {
    if (!can(req.perms, 'worklist.write') && !can(req.perms, 'encounter.complete')) throw new HttpError(403, 'FORBIDDEN:worklist.write');
    const b = Key.extend({ how: z.enum(HOW) }).parse(req.body); const t = req.ctx.tenantId;
    const recs = await find(tx, t, b);
    if (recs.some((r) => !r.reviewedAt)) throw new HttpError(409, 'NOT_REVIEWED');
    if (recs.some((r) => r.reviewOutcome === 'will_call') && !can(req.perms, 'encounter.complete')) throw new HttpError(409, 'DOCTOR_WILL_CALL');
    if (recs.every((r) => r.informedAt)) throw new HttpError(409, 'ALREADY_INFORMED');
    // The doctor wants to see them: the order closes only once that visit is booked (or they are here today), so nobody is lost.
    if (recs.some((r) => r.reviewOutcome === 'needs_visit')) {
      const today = todayIn(req.ctx.timezone); const pid = recs[0].patientId;
      const booked = await tx.select({ id: appointment.id }).from(appointment).innerJoin(session, eq(session.id, appointment.sessionId))
        .where(and(eq(appointment.tenantId, t), eq(appointment.patientId, pid), inArray(appointment.status, [...OPEN_STATUSES]), gte(session.day, today))).limit(1);
      // or they came in after the review (not the visit the tests were ordered at)
      const reviewed = recs.map((r) => r.reviewedAt).filter(Boolean).sort()[0]!;
      const here = booked.length ? booked : await tx.select({ id: visit.id }).from(visit).where(and(eq(visit.tenantId, t), eq(visit.patientId, pid), eq(visit.day, today), gte(visit.arrivedAt, reviewed))).limit(1);
      if (!here.length) throw new HttpError(409, 'BOOK_FIRST');
    }
    await tx.update(recommendation).set({ informedAt: new Date().toISOString(), informedHow: b.how, informedBy: req.ctx.name }).where(inArray(recommendation.id, recs.map((r) => r.id)));
    await emit(tx, req.ctx, 'order.informed', 'encounter', b.encounterId, { orderNo: b.orderNo, how: b.how, patientId: recs[0].patientId });
    return { ok: true, patientId: recs[0].patientId };
  });

  /** Move tests into an order of their own (the biopsy that takes a week, or whatever has not arrived yet). Already-received tests stay put. */
  route(app, 'post', '/orders/split', null, async (req, tx) => {
    if (!can(req.perms, 'worklist.write') && !can(req.perms, 'encounter.complete')) throw new HttpError(403, 'FORBIDDEN:worklist.write');
    const b = z.object({ ids: z.array(z.string().uuid()).min(1).max(20) }).parse(req.body); const t = req.ctx.tenantId;
    const recs = await tx.select().from(recommendation).where(and(eq(recommendation.tenantId, t), inArray(recommendation.id, b.ids), eq(recommendation.kind, 'investigation')));
    if (recs.length !== b.ids.length || new Set(recs.map((r) => r.encounterId)).size !== 1) throw new HttpError(400, 'TESTS_NOT_TOGETHER');
    if (recs.some((r) => r.receivedAt || r.reviewedAt)) throw new HttpError(409, 'ALREADY_RECEIVED');
    const encId = recs[0].encounterId;
    const max = await tx.select({ m: sql<number>`coalesce(max(${recommendation.orderNo}), 1)::int` }).from(recommendation).where(and(eq(recommendation.tenantId, t), eq(recommendation.encounterId, encId))).then((r) => r[0].m);
    await tx.update(recommendation).set({ orderNo: max + 1 }).where(inArray(recommendation.id, b.ids));
    await emit(tx, req.ctx, 'order.split', 'encounter', encId, { ids: b.ids, orderNo: max + 1, patientId: recs[0].patientId });
    return { ok: true, orderNo: max + 1 };
  });

  /** Values with no file (read out on the phone, or a WhatsApp text): the tests count as received once their values are saved. */
  route(app, 'post', '/orders/received', 'document.write', async (req, tx) => {
    const b = z.object({ ids: z.array(z.string().uuid()).min(1).max(20), note: z.string().trim().max(200).optional() }).parse(req.body); const t = req.ctx.tenantId;
    const recs = await tx.select().from(recommendation).where(and(eq(recommendation.tenantId, t), inArray(recommendation.id, b.ids), eq(recommendation.kind, 'investigation')));
    if (recs.length !== b.ids.length) throw new HttpError(404, 'NOT_FOUND');
    const has = new Set((await tx.select({ id: labResult.recommendationId }).from(labResult).where(and(eq(labResult.tenantId, t), inArray(labResult.recommendationId, b.ids)))).map((x) => x.id));
    if (recs.some((r) => !has.has(r.id))) throw new HttpError(400, 'NO_VALUES');
    const now = new Date().toISOString();
    for (const r of recs) if (!r.receivedAt) await tx.update(recommendation).set({ status: 'done', receivedAt: now, contactLog: [...r.contactLog, { at: now, by: req.ctx.name, outcome: 'Result received', note: b.note || 'Values typed, no file' }] }).where(eq(recommendation.id, r.id));
    await emit(tx, req.ctx, 'order.values_received', 'recommendation', recs[0].id, { ids: b.ids, patientId: recs[0].patientId });
    return { ok: true };
  });

  /** Reception chased the lab: logged, and shown so nobody rings twice in a row. */
  route(app, 'post', '/orders/called', 'worklist.write', async (req, tx) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.body); const t = req.ctx.tenantId;
    const r = await tx.select().from(recommendation).where(and(eq(recommendation.id, id), eq(recommendation.tenantId, t), eq(recommendation.kind, 'investigation'))).then((x) => x[0]);
    if (!r) throw new HttpError(404, 'NOT_FOUND');
    await tx.update(recommendation).set({ contactLog: [...r.contactLog, { at: new Date().toISOString(), by: req.ctx.name, outcome: 'Called the lab' }] }).where(eq(recommendation.id, id));
    return { ok: true };
  });
}
