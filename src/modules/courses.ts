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
export async function standing(tx: Tx, t: string, c: Course) {
  const pays = await tx.select({ amount: payment.amountPaise, chargeId: payment.chargeId }).from(payment).where(and(eq(payment.tenantId, t), eq(payment.courseId, c.id)));
  const advancePaise = pays.filter((p) => p.amount > 0).reduce((s, p) => s + p.amount, 0);
  const refundedPaise = -pays.filter((p) => p.amount < 0).reduce((s, p) => s + p.amount, 0);
  const sittingCharges = await tx.select().from(charge).where(and(eq(charge.tenantId, t), eq(charge.courseId, c.id)));
  const drawnPaise = sittingCharges.filter((x) => x.prepaid && !VOID.includes(x.status)).reduce((s, x) => s + x.amountPaise, 0); // a cancelled sitting gives its share back to the advance
  const paidOnDayPaise = sum(await tx.select({ n: sql<number>`coalesce(sum(amount_paise),0)::int` }).from(payment).where(and(eq(payment.tenantId, t), inArray(payment.chargeId, sittingCharges.length ? sittingCharges.map((x) => x.id) : ['00000000-0000-4000-8000-000000000000']))));
  const done = sum(await tx.select({ n: sql<number>`count(*)::int` }).from(procedureSession).where(and(eq(procedureSession.tenantId, t), eq(procedureSession.recommendationId, c.recommendationId), eq(procedureSession.state, 'completed'))));
  const perSittingPaise = Math.round(c.totalPaise / c.sittings);
  const credit = c.creditPaise ?? 0; // an approved discount on sittings paid ahead pays for sittings like the advance
  const unusedPaise = Math.max(0, advancePaise + credit - refundedPaise - drawnPaise);
  return { ...c, perSittingPaise, advancePaise, refundedPaise, drawnPaise, unusedPaise, paidOnDayPaise, doneSittings: done, unusedSittings: perSittingPaise ? Math.floor(unusedPaise / perSittingPaise) : 0,
    refundablePaise: Math.max(0, unusedPaise - credit), // the discount is never handed back as money
    stillToPayPaise: Math.max(0, c.totalPaise - (advancePaise + credit - refundedPaise) - paidOnDayPaise) };
}

type Pkg = { id: string; name: string; procedureId: string; sittings: number; pricePaise: number };
/** The course for a procedure plan, made on first need: the doctor's own amount when they set one on the pad (the total for all sittings),
 *  otherwise the standard price (list price × sittings) or a clinic package. The desk never types a price; a reduction is a discount on a bill. */
export async function ensureCourse(tx: Tx, ctx: Ctx, recommendationId: string, packageId?: string) {
  const t = ctx.tenantId;
  const have = await tx.select().from(course).where(and(eq(course.tenantId, t), eq(course.recommendationId, recommendationId))).then((r) => r[0]);
  if (have) { if (packageId) throw new HttpError(409, 'COURSE_ALREADY_PRICED'); return have; }
  const rec = await tx.select().from(recommendation).where(and(eq(recommendation.id, recommendationId), eq(recommendation.tenantId, t), eq(recommendation.kind, 'procedure'))).then((r) => r[0]);
  if (!rec || !rec.procedureId) throw new HttpError(404, 'PLAN_NOT_FOUND');
  const proc = await tx.select().from(procedureCatalog).where(eq(procedureCatalog.id, rec.procedureId)).then((r) => r[0]);
  let sittings = rec.sittings ?? 1; let total = (proc?.pricePaise ?? 0) * sittings;
  const custom = rec.amountPaise != null && rec.amountPaise > 0; // the doctor's price beats the list and any package
  if (custom && packageId) throw new HttpError(409, 'DOCTOR_SET_THE_PRICE');
  if (custom) total = rec.amountPaise!;
  const ten = await tx.select().from(tenant).where(eq(tenant.id, t)).then((r) => r[0]);
  const pkgs = (((ten?.settings as any)?.packages ?? []) as Pkg[]).filter((x) => x.procedureId === rec.procedureId);
  if (!packageId && !custom) { // a quote still open for a package: the patient was told that price
    const told = await tx.select().from(quote).where(and(eq(quote.tenantId, t), eq(quote.recommendationId, rec.id), eq(quote.status, 'open'))).orderBy(desc(quote.createdAt)).limit(1).then((r) => r[0]);
    if (told && told.validUntil >= todayIn(ctx.timezone)) packageId = pkgs.find((x) => x.pricePaise === told.totalPaise && x.sittings === told.sittings)?.id;
  }
  if (packageId) {
    const k = pkgs.find((x) => x.id === packageId);
    if (!k) throw new HttpError(404, 'PACKAGE_NOT_FOUND');
    sittings = k.sittings; total = k.pricePaise;
    if (rec.sittings !== sittings) await tx.update(recommendation).set({ sittings }).where(eq(recommendation.id, rec.id)); // the package says how many sittings
  }
  if (!total) throw new HttpError(400, 'NO_PRICE_ON_THE_PRICE_LIST');
  const list = custom ? total : Math.max(total, (proc?.pricePaise ?? 0) * sittings);
  const [row] = await tx.insert(course).values({ tenantId: t, patientId: rec.patientId, recommendationId: rec.id, procedureId: rec.procedureId, sittings, listPaise: list, totalPaise: total, agreedBy: ctx.name }).returning();
  await tx.update(quote).set({ status: 'agreed' }).where(and(eq(quote.tenantId, t), eq(quote.recommendationId, rec.id), eq(quote.status, 'open')));
  await emit(tx, ctx, 'course.agreed', 'course', row.id, { totalPaise: total, listPaise: list, sittings, packageId: packageId ?? null });
  return row;
}

/** A sitting was done: invoice it, from the advance when there is enough, otherwise due on the day. One invoice per sitting.
 *  With no agreed course it is still billed, at the procedure's list price, so a done sitting never goes out unbilled. */
export async function drawSitting(tx: Tx, ctx: Ctx, ps: { id: string; recommendationId: string; patientId: string; procedureId?: string | null; sittingNo?: number }) {
  const t = ctx.tenantId;
  if (await tx.select({ id: charge.id }).from(charge).where(and(eq(charge.tenantId, t), eq(charge.sessionId, ps.id), notInArray(charge.status, VOID))).then((r) => r.length)) return;
  const c = await tx.select().from(course).where(and(eq(course.tenantId, t), eq(course.recommendationId, ps.recommendationId))).then((r) => r[0]);
  if (!c) { // no course agreed: billed per sitting at the doctor's amount (its share) or the standard price
    const proc = ps.procedureId ? await tx.select().from(procedureCatalog).where(eq(procedureCatalog.id, ps.procedureId)).then((r) => r[0]) : null;
    const rec = await tx.select({ amountPaise: recommendation.amountPaise, sittings: recommendation.sittings }).from(recommendation).where(eq(recommendation.id, ps.recommendationId)).then((r) => r[0]);
    const price = rec?.amountPaise ? Math.round(rec.amountPaise / Math.max(1, rec.sittings ?? 1)) : proc?.pricePaise;
    if (!price) return; // no price anywhere: nothing to bill
    const [row] = await tx.insert(charge).values({ tenantId: t, patientId: ps.patientId, description: `${proc?.name ?? 'Procedure'} sitting ${ps.sittingNo ?? 1}`, amountPaise: price, taxRateBp: proc?.taxRateBp ?? 0, sessionId: ps.id, prepaid: false, status: 'due' }).returning();
    await emit(tx, ctx, 'course.sitting_due', 'charge', row.id, { courseId: null, amountPaise: price, listPrice: !rec?.amountPaise });
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
  const fromAdvance = Math.min(amount, st.unusedPaise); let billId: string | undefined; // both parts of one sitting are one invoice
  if (fromAdvance > 0) {
    const [row] = await tx.insert(charge).values({ tenantId: t, patientId: ps.patientId, description: fromAdvance < amount ? `${what} (from advance)` : what, amountPaise: fromAdvance, courseId: c.id, sessionId: ps.id, prepaid: true, status: 'paid' }).returning();
    billId = row.billId ?? undefined;
    await emit(tx, ctx, 'course.sitting_drawn', 'charge', row.id, { courseId: c.id, amountPaise: fromAdvance });
  }
  if (amount > fromAdvance) {
    const [row] = await tx.insert(charge).values({ tenantId: t, patientId: ps.patientId, billId, description: fromAdvance ? `${what} (balance)` : what, amountPaise: amount - fromAdvance, courseId: c.id, sessionId: ps.id, prepaid: false, status: 'due' }).returning();
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
  /** Start the course at its fixed price: list price × sittings, or a clinic package. There is no price to type: a reduction is a discount on a bill. */
  route(app, 'post', '/courses', 'worklist.write', async (req, tx) => {
    const b = z.object({ recommendationId: z.string().uuid(), packageId: z.string().min(1).max(40).optional() }).strict().parse(req.body);
    if (await tx.select({ id: course.id }).from(course).where(and(eq(course.tenantId, req.ctx.tenantId), eq(course.recommendationId, b.recommendationId))).then((r) => r.length)) throw new HttpError(409, 'ALREADY_AGREED');
    return standing(tx, req.ctx.tenantId, await ensureCourse(tx, req.ctx, b.recommendationId, b.packageId));
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
    if (b.amountPaise > st.refundablePaise) throw new HttpError(400, 'MORE_THAN_UNUSED', { unusedPaise: st.refundablePaise });
    const [row] = await tx.insert(payment).values({ tenantId: t, patientId: c.patientId, courseId: c.id, amountPaise: -b.amountPaise, method: b.method, reference: `Refund: ${b.reason}`, receivedBy: req.ctx.userId }).returning();
    await emit(tx, req.ctx, 'course.refunded', 'payment', row.id, { courseId: c.id, amountPaise: b.amountPaise, reason: b.reason });
    return standing(tx, t, c);
  });
}
