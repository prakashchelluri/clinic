import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, sql, inArray, notInArray } from 'drizzle-orm';
import { course, charge, payment, procedureCatalog, procedureSession, quote, recommendation, tenant } from '../db/schema.js';
import type { Tx } from '../db/index.js';
import { route } from '../lib/route.js';
import { emit, nextNumber, todayIn } from '../lib/core.js';
import { HttpError, can, type Ctx } from '../lib/auth.js';
import { assertDayOpen } from './dayclose.js';
import { nextReceiptNo } from './billing.js';

type Course = typeof course.$inferSelect;
const sum = (rows: { n: number }[]) => rows[0]?.n ?? 0;
const VOID = ['cancelled', 'waived']; // charges that no longer count

/** Where the course stands in money: what was paid ahead, what sittings used, what is left to give back. */
async function standing(tx: Tx, t: string, c: Course) {
  const pays = await tx.select({ amount: payment.amountPaise, chargeId: payment.chargeId }).from(payment).where(and(eq(payment.tenantId, t), eq(payment.courseId, c.id)));
  const advancePaise = pays.filter((p) => p.amount > 0).reduce((s, p) => s + p.amount, 0);
  const refundedPaise = -pays.filter((p) => p.amount < 0).reduce((s, p) => s + p.amount, 0);
  const sittingCharges = await tx.select().from(charge).where(and(eq(charge.tenantId, t), eq(charge.courseId, c.id)));
  const drawnPaise = sittingCharges.filter((x) => x.prepaid && !VOID.includes(x.status)).reduce((s, x) => s + x.amountPaise, 0); // a cancelled sitting gives its share back to the advance
  const paidOnDayPaise = sum(await tx.select({ n: sql<number>`coalesce(sum(amount_paise),0)::int` }).from(payment).where(and(eq(payment.tenantId, t), inArray(payment.chargeId, sittingCharges.length ? sittingCharges.map((x) => x.id) : ['00000000-0000-4000-8000-000000000000']))));
  const done = sum(await tx.select({ n: sql<number>`count(*)::int` }).from(procedureSession).where(and(eq(procedureSession.tenantId, t), eq(procedureSession.recommendationId, c.recommendationId), eq(procedureSession.state, 'completed'))));
  const perSittingPaise = Math.round(c.totalPaise / c.sittings);
  const unusedPaise = Math.max(0, advancePaise - refundedPaise - drawnPaise);
  return { ...c, perSittingPaise, advancePaise, refundedPaise, drawnPaise, unusedPaise, paidOnDayPaise, doneSittings: done, unusedSittings: perSittingPaise ? Math.floor(unusedPaise / perSittingPaise) : 0,
    stillToPayPaise: Math.max(0, c.totalPaise - (advancePaise - refundedPaise) - paidOnDayPaise) };
}

/** A sitting was done: invoice it, from the advance when there is enough, otherwise due on the day. One invoice per sitting.
 *  With no agreed course it is still billed, at the procedure's list price, so a done sitting never goes out unbilled. */
export async function drawSitting(tx: Tx, ctx: Ctx, ps: { id: string; recommendationId: string; patientId: string; procedureId?: string | null; sittingNo?: number }) {
  const t = ctx.tenantId;
  if (await tx.select({ id: charge.id }).from(charge).where(and(eq(charge.tenantId, t), eq(charge.sessionId, ps.id), notInArray(charge.status, VOID))).then((r) => r.length)) return;
  const c = await tx.select().from(course).where(and(eq(course.tenantId, t), eq(course.recommendationId, ps.recommendationId))).then((r) => r[0]);
  if (!c) {
    const proc = ps.procedureId ? await tx.select().from(procedureCatalog).where(eq(procedureCatalog.id, ps.procedureId)).then((r) => r[0]) : null;
    if (!proc?.pricePaise) return; // no price anywhere: nothing to bill
    const [row] = await tx.insert(charge).values({ tenantId: t, patientId: ps.patientId, description: `${proc.name} sitting ${ps.sittingNo ?? 1}`, amountPaise: proc.pricePaise, taxRateBp: proc.taxRateBp, sessionId: ps.id, prepaid: false, status: 'due' }).returning();
    await emit(tx, ctx, 'course.sitting_due', 'charge', row.id, { courseId: null, amountPaise: proc.pricePaise, listPrice: true });
    return;
  }
  const st = await standing(tx, t, c);
  const n = st.doneSittings; const isLast = n >= c.sittings;
  const before = await tx.select({ s: sql<number>`coalesce(sum(amount_paise),0)::int` }).from(charge).where(and(eq(charge.tenantId, t), eq(charge.courseId, c.id), notInArray(charge.status, VOID)));
  const amount = isLast ? Math.max(0, c.totalPaise - (before[0]?.s ?? 0)) : st.perSittingPaise; // the last sitting takes the rounding
  if (amount <= 0) return;
  const proc = c.procedureId ? await tx.select({ name: procedureCatalog.name }).from(procedureCatalog).where(eq(procedureCatalog.id, c.procedureId)).then((r) => r[0]?.name) : null;
  const what = `${proc ?? 'Procedure'} sitting ${n} of ${c.sittings}`;
  // the advance pays what it can; a partly covered sitting gets two charges: the part from the advance (paid) and the balance (due)
  const fromAdvance = Math.min(amount, st.unusedPaise);
  if (fromAdvance > 0) {
    const [row] = await tx.insert(charge).values({ tenantId: t, patientId: ps.patientId, description: fromAdvance < amount ? `${what} (from advance)` : what, amountPaise: fromAdvance, courseId: c.id, sessionId: ps.id, prepaid: true, status: 'paid' }).returning();
    await emit(tx, ctx, 'course.sitting_drawn', 'charge', row.id, { courseId: c.id, amountPaise: fromAdvance });
  }
  if (amount > fromAdvance) {
    const [row] = await tx.insert(charge).values({ tenantId: t, patientId: ps.patientId, description: fromAdvance ? `${what} (balance)` : what, amountPaise: amount - fromAdvance, courseId: c.id, sessionId: ps.id, prepaid: false, status: 'due' }).returning();
    await emit(tx, ctx, 'course.sitting_due', 'charge', row.id, { courseId: c.id, amountPaise: amount - fromAdvance });
  }
}

/** A done sitting was undone (cancelled, or moved back): its charge is cancelled so a rebooked sitting is not billed twice. A prepaid one goes back to the advance.
 *  A charge the patient already paid at the desk is left alone: that needs a refund from the invoice menu. */
export async function reverseSitting(tx: Tx, ctx: Ctx, sessionId: string, reason: string) {
  const rows = await tx.select().from(charge).where(and(eq(charge.tenantId, ctx.tenantId), eq(charge.sessionId, sessionId), notInArray(charge.status, VOID)));
  for (const ch of rows) {
    const paid = sum(await tx.select({ n: sql<number>`coalesce(sum(amount_paise),0)::int` }).from(payment).where(eq(payment.chargeId, ch.id)));
    if (paid > 0) continue;
    await tx.update(charge).set({ status: 'cancelled', adjustmentReason: reason, adjustedBy: ctx.userId }).where(eq(charge.id, ch.id));
    await emit(tx, ctx, 'charge.cancelled', 'charge', ch.id, { reason, amountPaise: ch.amountPaise, sessionId });
  }
}

/** What a sitting means for the patient's money on the day: prepaid from the course, due, already paid, or no price at all. */
// A partly used advance pays part of the sitting: then it is 'due' for the balance, with prepaidPaise saying how much the advance covers.
export async function sittingMoney(tx: Tx, t: string, ps: { id: string; recommendationId: string; procedureId: string | null }): Promise<{ kind: 'prepaid' | 'due' | 'paid' | 'none'; amountPaise: number; prepaidPaise?: number }> {
  const chs = await tx.select().from(charge).where(and(eq(charge.tenantId, t), eq(charge.sessionId, ps.id), notInArray(charge.status, VOID)));
  if (chs.length) {
    const prepaid = chs.filter((x) => x.prepaid).reduce((s, x) => s + x.amountPaise, 0);
    const due = chs.filter((x) => !x.prepaid && x.status !== 'paid').reduce((s, x) => s + x.amountPaise, 0);
    const total = chs.reduce((s, x) => s + x.amountPaise, 0);
    if (due) return prepaid ? { kind: 'due', amountPaise: due, prepaidPaise: prepaid } : { kind: 'due', amountPaise: due };
    return { kind: prepaid === total ? 'prepaid' : 'paid', amountPaise: total };
  }
  const c = await tx.select().from(course).where(and(eq(course.tenantId, t), eq(course.recommendationId, ps.recommendationId))).then((r) => r[0]);
  if (c) {
    const st = await standing(tx, t, c); const per = st.perSittingPaise;
    if (st.unusedPaise >= per) return { kind: 'prepaid', amountPaise: per };
    return st.unusedPaise > 0 ? { kind: 'due', amountPaise: per - st.unusedPaise, prepaidPaise: st.unusedPaise } : { kind: 'due', amountPaise: per };
  }
  const price = ps.procedureId ? await tx.select({ p: procedureCatalog.pricePaise }).from(procedureCatalog).where(eq(procedureCatalog.id, ps.procedureId)).then((r) => r[0]?.p ?? null) : null;
  return price ? { kind: 'due', amountPaise: price } : { kind: 'none', amountPaise: 0 };
}

export function courseRoutes(app: FastifyInstance) {
  /** The patient agreed to a procedure plan at a price. Below the list price needs the discount permission; above the clinic cap, the owner. */
  route(app, 'post', '/courses', 'worklist.write', async (req, tx) => {
    const b = z.object({ recommendationId: z.string().uuid(), totalPaise: z.number().int().positive().optional() }).parse(req.body);
    const t = req.ctx.tenantId;
    const rec = await tx.select().from(recommendation).where(and(eq(recommendation.id, b.recommendationId), eq(recommendation.tenantId, t), eq(recommendation.kind, 'procedure'))).then((r) => r[0]);
    if (!rec || !rec.procedureId) throw new HttpError(404, 'PLAN_NOT_FOUND');
    if (await tx.select({ id: course.id }).from(course).where(and(eq(course.tenantId, t), eq(course.recommendationId, rec.id))).then((r) => r.length)) throw new HttpError(409, 'ALREADY_AGREED');
    const proc = await tx.select().from(procedureCatalog).where(eq(procedureCatalog.id, rec.procedureId)).then((r) => r[0]);
    const sittings = rec.sittings ?? 1; const per = proc?.pricePaise;
    if (!per && !b.totalPaise) throw new HttpError(400, 'PRICE_NEEDED');
    const list = (per ?? 0) * sittings || b.totalPaise!;
    // a quote already told the patient a price: that is the default when the patient agrees
    const told = await tx.select().from(quote).where(and(eq(quote.tenantId, t), eq(quote.recommendationId, rec.id), eq(quote.status, 'open'))).orderBy(desc(quote.createdAt)).limit(1).then((r) => r[0]);
    const total = b.totalPaise ?? (told && told.validUntil >= todayIn(req.ctx.timezone) ? told.totalPaise : list);
    if (total > list) throw new HttpError(400, 'ABOVE_LIST_PRICE', { listPaise: list });
    const quoted = b.totalPaise === undefined && !!told && told.validUntil >= todayIn(req.ctx.timezone); // the discount was approved when the quote was made
    if (total < list && !quoted) {
      if (!can(req.perms, 'discount.give')) throw new HttpError(403, 'FORBIDDEN:discount.give');
      const ten = await tx.select().from(tenant).where(eq(tenant.id, t)).then((r) => r[0]);
      const cap = Number((ten?.settings as any)?.discountCapPct ?? 10); const pct = Math.round(((list - total) / list) * 1000) / 10;
      if (pct > cap && !req.ctx.roles.includes('owner')) throw new HttpError(403, 'DISCOUNT_ABOVE_CAP_NEEDS_OWNER', { capPct: cap, pct });
    }
    const [row] = await tx.insert(course).values({ tenantId: t, patientId: rec.patientId, recommendationId: rec.id, procedureId: rec.procedureId, sittings, listPaise: list, totalPaise: total, agreedBy: req.ctx.name }).returning();
    await tx.update(quote).set({ status: 'agreed' }).where(and(eq(quote.tenantId, t), eq(quote.recommendationId, rec.id), eq(quote.status, 'open')));
    await emit(tx, req.ctx, 'course.agreed', 'course', row.id, { totalPaise: total, listPaise: list, sittings });
    return standing(tx, t, row);
  });

  route(app, 'get', '/courses', 'worklist.read', async (req, tx) => {
    if (!can(req.perms, 'fees.see')) return [];
    const pid = String((req.query as any).patientId ?? ''); const t = req.ctx.tenantId;
    const rows = await tx.select().from(course).where(pid ? and(eq(course.tenantId, t), eq(course.patientId, pid)) : eq(course.tenantId, t)).orderBy(course.createdAt).limit(50);
    return Promise.all(rows.map((c) => standing(tx, t, c)));
  });

  /** Pay for some sittings now. The price is locked from the first payment; EMI needs the lender and approval code. */
  route(app, 'post', '/courses/:id/advance', 'payment.record', async (req, tx) => {
    const b = z.object({ amountPaise: z.number().int().positive(), method: z.enum(['cash', 'upi', 'card', 'bank', 'emi']), reference: z.string().trim().max(60).optional(), lender: z.string().trim().max(60).optional(), idempotencyKey: z.string().min(8) }).parse(req.body);
    const t = req.ctx.tenantId; const id = (req.params as any).id;
    await assertDayOpen(tx, req.ctx);
    const dup = await tx.select().from(payment).where(and(eq(payment.tenantId, t), eq(payment.idempotencyKey, `${b.idempotencyKey}#c`))).then((r) => r[0]);
    if (dup) return { repeated: true, receiptNo: dup.receiptNo };
    const c = await tx.select().from(course).where(and(eq(course.id, id), eq(course.tenantId, t))).then((r) => r[0]);
    if (!c) throw new HttpError(404, 'NOT_FOUND');
    if (b.method === 'emi' && (!b.lender || !b.reference)) throw new HttpError(400, 'EMI_NEEDS_LENDER_AND_APPROVAL_CODE');
    const st = await standing(tx, t, c);
    if (b.amountPaise > st.stillToPayPaise) throw new HttpError(400, 'MORE_THAN_THE_COURSE_NEEDS', { stillToPayPaise: st.stillToPayPaise });
    const receiptNo = await nextReceiptNo(tx, t, req.ctx.timezone);
    const [row] = await tx.insert(payment).values({ tenantId: t, patientId: c.patientId, courseId: c.id, amountPaise: b.amountPaise, method: b.method, reference: b.reference ?? null, lender: b.lender ?? null, receiptNo, receivedBy: req.ctx.userId, idempotencyKey: `${b.idempotencyKey}#c` }).returning();
    if (!c.lockedAt) await tx.update(course).set({ lockedAt: new Date().toISOString() }).where(eq(course.id, c.id));
    await emit(tx, req.ctx, 'course.advance_taken', 'payment', row.id, { courseId: c.id, amountPaise: b.amountPaise, method: b.method });
    return { repeated: false, receiptNo, course: await standing(tx, t, { ...c, lockedAt: c.lockedAt ?? new Date().toISOString() }) };
  });

  /** Unused prepaid sittings go back. Rare, so it needs its own permission and a reason; only whole unused amounts, never more than is unused. */
  route(app, 'post', '/courses/:id/refund', 'refund.course', async (req, tx) => {
    const b = z.object({ amountPaise: z.number().int().positive(), method: z.enum(['cash', 'upi', 'card', 'bank']), reason: z.string().trim().min(3, 'Say why').max(200) }).parse(req.body);
    const t = req.ctx.tenantId;
    const c = await tx.select().from(course).where(and(eq(course.id, (req.params as any).id), eq(course.tenantId, t))).then((r) => r[0]);
    if (!c) throw new HttpError(404, 'NOT_FOUND');
    const st = await standing(tx, t, c);
    if (b.amountPaise > st.unusedPaise) throw new HttpError(400, 'MORE_THAN_UNUSED', { unusedPaise: st.unusedPaise });
    const [row] = await tx.insert(payment).values({ tenantId: t, patientId: c.patientId, courseId: c.id, amountPaise: -b.amountPaise, method: b.method, reference: `Refund: ${b.reason}`, receivedBy: req.ctx.userId }).returning();
    await emit(tx, req.ctx, 'course.refunded', 'payment', row.id, { courseId: c.id, amountPaise: b.amountPaise, reason: b.reason });
    return standing(tx, t, c);
  });
}
