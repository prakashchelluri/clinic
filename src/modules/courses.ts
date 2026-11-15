import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, sql, inArray, notInArray } from 'drizzle-orm';
import { course, charge, encounter, payment, practitioner, procedureCatalog, procedureSession, quote, recommendation, tenant } from '../db/schema.js';
import type { Tx } from '../db/index.js';
import { route } from '../lib/route.js';
import { emit, nextNumber, todayIn, addMonths } from '../lib/core.js';
import { HttpError, can, type Ctx } from '../lib/auth.js';
import { stdTotal, validTill } from '../lib/procPrice.js';

type Course = typeof course.$inferSelect;
const sum = (rows: { n: number }[]) => rows[0]?.n ?? 0;
const VOID = ['cancelled', 'waived']; // charges that no longer count

/** Where the course stands in money. Money belongs to the patient: the treatment is invoiced (once, as a whole, or session by session
 *  when it never was) and paid like any invoice. The old "paid ahead" fields stay in the shape, at zero, so every screen reads the same object. */
export async function standing(tx: Tx, t: string, c: Course) {
  const chs = await tx.select().from(charge).where(and(eq(charge.tenantId, t), eq(charge.courseId, c.id), notInArray(charge.status, VOID)));
  const paidPaise = sum(await tx.select({ n: sql<number>`coalesce(sum(amount_paise),0)::int` }).from(payment).where(and(eq(payment.tenantId, t), inArray(payment.chargeId, chs.length ? chs.map((x) => x.id) : ['00000000-0000-4000-8000-000000000000']))));
  const invoicedPaise = chs.reduce((s, x) => s + x.amountPaise + x.discountPaise, 0); // at the course price: a discount given on the invoice is billed, not left to bill again
  const offPaise = chs.reduce((s, x) => s + x.discountPaise, 0);
  const done = sum(await tx.select({ n: sql<number>`count(*)::int` }).from(procedureSession).where(and(eq(procedureSession.tenantId, t), eq(procedureSession.recommendationId, c.recommendationId), eq(procedureSession.state, 'completed'))));
  const perSittingPaise = Math.round(c.totalPaise / c.sittings);
  const treatment = chs.find((x) => !x.sessionId) ?? null; // the whole treatment on one invoice
  return { ...c, perSittingPaise, invoicedPaise, uninvoicedPaise: Math.max(0, c.totalPaise - invoicedPaise), invoiceId: treatment?.billId ?? null, invoiced: !!treatment,
    advancePaise: paidPaise, refundedPaise: 0, drawnPaise: 0, unusedPaise: 0, paidOnDayPaise: 0, doneSittings: done, unusedSittings: 0, refundablePaise: 0,
    discountPaise: offPaise, stillToPayPaise: Math.max(0, c.totalPaise - offPaise - paidPaise) };
}

/** The treatment's invoice line follows the course price down: fewer sessions (an edit, or cancelling what is not done) lower it.
 *  Money already paid above the new amount moves to the patient's advance, to use on the next bill or give back with Refund. */
export async function syncTreatment(tx: Tx, ctx: Ctx, courseId: string, reason: string) {
  const t = ctx.tenantId;
  const c = await tx.select().from(course).where(and(eq(course.tenantId, t), eq(course.id, courseId))).then((r) => r[0]); if (!c) return;
  const chs = await tx.select().from(charge).where(and(eq(charge.tenantId, t), eq(charge.courseId, c.id), notInArray(charge.status, VOID)));
  const tr = chs.find((x) => !x.sessionId); if (!tr) return;
  // the line at the new course price, less the other lines (at their price) and the discount it was given
  const want = Math.max(0, c.totalPaise - chs.filter((x) => x.id !== tr.id).reduce((s, x) => s + x.amountPaise + x.discountPaise, 0) - tr.discountPaise);
  if (want >= tr.amountPaise) return; // an issued invoice only ever goes down; sessions added later are billed on the next invoice ("the rest")
  const got = sum(await tx.select({ n: sql<number>`coalesce(sum(amount_paise),0)::int` }).from(payment).where(eq(payment.chargeId, tr.id)));
  await tx.update(charge).set({ amountPaise: want, adjustmentReason: reason, adjustedBy: ctx.userId, status: got >= want ? 'paid' : 'due' }).where(eq(charge.id, tr.id));
  if (got > want) { // a credit: the extra leaves the invoice and becomes the patient's advance (no money moves, so method 'advance')
    const back = got - want; const base = { tenantId: t, patientId: c.patientId, method: 'advance', receivedBy: ctx.userId };
    await tx.insert(payment).values({ ...base, chargeId: tr.id, amountPaise: -back, reference: `Credit: ${reason}`.slice(0, 200) });
    await tx.insert(payment).values({ ...base, advance: true, amountPaise: back, reference: `Credit on ${tr.description}`.slice(0, 200) });
  }
  await emit(tx, ctx, 'charge.adjusted', 'charge', tr.id, { from: tr.amountPaise, to: want, reason, toAdvancePaise: Math.max(0, got - want) });
}

/** The course for a procedure plan, made on first need: the doctor's own amount when they set one on the pad (the total for all sittings),
 *  the plan's share of a package the doctor added, or the standard price (list price × sittings). The desk never types a price; a reduction is a discount on a bill.
 *  A package is agreed as a whole: the other procedures of the same package on that pad get their course at the same time, with the same end date. */
export async function ensureCourse(tx: Tx, ctx: Ctx, recommendationId: string, siblings = true): Promise<Course> {
  const t = ctx.tenantId;
  const have = await tx.select().from(course).where(and(eq(course.tenantId, t), eq(course.recommendationId, recommendationId))).then((r) => r[0]);
  if (have) return have;
  const rec = await tx.select().from(recommendation).where(and(eq(recommendation.id, recommendationId), eq(recommendation.tenantId, t), eq(recommendation.kind, 'procedure'))).then((r) => r[0]);
  if (!rec || !rec.procedureId) throw new HttpError(404, 'PLAN_NOT_FOUND');
  const proc = await tx.select().from(procedureCatalog).where(eq(procedureCatalog.id, rec.procedureId)).then((r) => r[0]);
  const sittings = rec.sittings ?? 1; const pkg = rec.package;
  const custom = rec.amountPaise != null && rec.amountPaise > 0; // the doctor's price (or the package share) beats the list
  const total = custom ? rec.amountPaise! : stdTotal(proc, sittings);
  if (!total) throw new HttpError(400, 'NO_PRICE_ON_THE_PRICE_LIST');
  const list = custom ? total : Math.max(total, stdTotal(proc, sittings));
  // for the accounts: where the price came from, the standard price for the same sittings, and the doctor who set their own
  const standardPaise = stdTotal(proc, sittings) || null;
  const priceBy = custom && !pkg ? await tx.select({ n: practitioner.name }).from(encounter).leftJoin(practitioner, eq(practitioner.id, encounter.practitionerId)).where(eq(encounter.id, rec.encounterId)).then((x) => x[0]?.n ?? null) : null;
  // valid till: the date set on the plan, or none when it has no expiry, or a package's months from today
  const validUntil = rec.noExpiry ? null : rec.validUntil ?? (pkg ? addMonths(todayIn(ctx.timezone), pkg.validMonths) : validTill(proc, todayIn(ctx.timezone)));
  const [row] = await tx.insert(course).values({ tenantId: t, patientId: rec.patientId, recommendationId: rec.id, procedureId: rec.procedureId, sittings, listPaise: list, totalPaise: total, agreedBy: ctx.name,
    priceSource: pkg ? 'package' : custom ? 'doctor' : 'standard', standardPaise, priceBy, packageName: pkg?.name ?? null, packageGroup: pkg?.group ?? null, validUntil }).returning();
  await tx.update(quote).set({ status: 'agreed' }).where(and(eq(quote.tenantId, t), eq(quote.recommendationId, rec.id), eq(quote.status, 'open')));
  await emit(tx, ctx, 'course.agreed', 'course', row.id, { totalPaise: total, listPaise: list, sittings, packageId: pkg?.id ?? null, priceSource: row.priceSource, standardPaise, priceBy });
  if (pkg && siblings) {
    const rest = await tx.select({ id: recommendation.id }).from(recommendation).where(and(eq(recommendation.tenantId, t), eq(recommendation.encounterId, rec.encounterId), eq(recommendation.kind, 'procedure'), sql`${recommendation.package}->>'group' = ${pkg.group}`, sql`${recommendation.id} <> ${rec.id}`));
    for (const r of rest) await ensureCourse(tx, ctx, r.id, false);
  }
  return row;
}

/** A session billed on the day is paid from the patient's advance first, as far as it goes (no money moves, so method 'advance'). */
async function payFromAdvance(tx: Tx, ctx: Ctx, ch: { id: string; patientId: string; amountPaise: number; description: string }) {
  const t = ctx.tenantId;
  const bal = sum(await tx.select({ n: sql<number>`coalesce(sum(amount_paise),0)::int` }).from(payment).where(and(eq(payment.tenantId, t), eq(payment.patientId, ch.patientId), eq(payment.advance, true))));
  const take = Math.min(bal, ch.amountPaise); if (take <= 0) return;
  const base = { tenantId: t, patientId: ch.patientId, method: 'advance', receivedBy: ctx.userId };
  await tx.insert(payment).values({ ...base, chargeId: ch.id, amountPaise: take });
  await tx.insert(payment).values({ ...base, advance: true, amountPaise: -take, reference: ch.description.slice(0, 60) });
  if (take >= ch.amountPaise) await tx.update(charge).set({ status: 'paid' }).where(eq(charge.id, ch.id));
}

/** A session was done. When the treatment is on an invoice, nothing more is billed: the session only uses it up.
 *  Otherwise the session is invoiced on the day (due), at the course's price per session, or the doctor's or list price with no course,
 *  so a done session never goes out unbilled. Generating the treatment's invoice later bills only what is left. */
export async function drawSitting(tx: Tx, ctx: Ctx, ps: { id: string; recommendationId: string; patientId: string; procedureId?: string | null; sittingNo?: number }) {
  const t = ctx.tenantId;
  if (await tx.select({ id: charge.id }).from(charge).where(and(eq(charge.tenantId, t), eq(charge.sessionId, ps.id), notInArray(charge.status, VOID))).then((r) => r.length)) return;
  const c = await tx.select().from(course).where(and(eq(course.tenantId, t), eq(course.recommendationId, ps.recommendationId))).then((r) => r[0]);
  if (!c) { // no course agreed: billed per sitting at the doctor's amount (its share) or the standard price
    const proc = ps.procedureId ? await tx.select().from(procedureCatalog).where(eq(procedureCatalog.id, ps.procedureId)).then((r) => r[0]) : null;
    const rec = await tx.select({ amountPaise: recommendation.amountPaise, sittings: recommendation.sittings }).from(recommendation).where(eq(recommendation.id, ps.recommendationId)).then((r) => r[0]);
    const price = rec?.amountPaise ? Math.round(rec.amountPaise / Math.max(1, rec.sittings ?? 1)) : proc?.pricePaise;
    if (!price) return; // no price anywhere: nothing to bill
    const [row] = await tx.insert(charge).values({ tenantId: t, patientId: ps.patientId, description: `${proc?.name ?? 'Procedure'} session ${ps.sittingNo ?? 1}${rec?.amountPaise ? ' · custom price' : ''}`, amountPaise: price, taxRateBp: proc?.taxRateBp ?? 0, sessionId: ps.id, status: 'due' }).returning();
    await emit(tx, ctx, 'course.sitting_due', 'charge', row.id, { courseId: null, amountPaise: price, listPrice: !rec?.amountPaise });
    await payFromAdvance(tx, ctx, row);
    return;
  }
  const st = await standing(tx, t, c);
  // the treatment is on an invoice: its sessions bill nothing. Sessions added after it (not on any invoice) are billed when done.
  if (st.invoiced && (st.uninvoicedPaise <= 0 || st.doneSittings <= Math.round(st.invoicedPaise / Math.max(1, st.perSittingPaise)))) return;
  const isLast = st.doneSittings >= c.sittings;
  const amount = isLast ? st.uninvoicedPaise : Math.min(st.perSittingPaise, st.uninvoicedPaise); // the last session takes the rounding
  if (amount <= 0) return;
  const proc = c.procedureId ? await tx.select({ name: procedureCatalog.name, tax: procedureCatalog.taxRateBp }).from(procedureCatalog).where(eq(procedureCatalog.id, c.procedureId)).then((r) => r[0]) : null;
  const [row] = await tx.insert(charge).values({ tenantId: t, patientId: ps.patientId, description: `${proc?.name ?? 'Procedure'} session ${st.doneSittings} of ${c.sittings}${c.priceSource === 'doctor' ? ' · custom price' : ''}`, amountPaise: amount, taxRateBp: proc?.tax ?? 0, courseId: c.id, sessionId: ps.id, status: 'due' }).returning();
  await emit(tx, ctx, 'course.sitting_due', 'charge', row.id, { courseId: c.id, amountPaise: amount });
  await payFromAdvance(tx, ctx, row);
}

/** A done session was undone (cancelled, or moved back): its charge is cancelled so a rebooked session is not billed twice; what the advance paid on it goes back to the advance.
 *  A charge the patient already paid at the desk is left alone: that needs a refund from the invoice menu. */
export async function reverseSitting(tx: Tx, ctx: Ctx, sessionId: string, reason: string) {
  const rows = await tx.select().from(charge).where(and(eq(charge.tenantId, ctx.tenantId), eq(charge.sessionId, sessionId), notInArray(charge.status, VOID)));
  for (const ch of rows) {
    const pays = await tx.select().from(payment).where(eq(payment.chargeId, ch.id));
    if (pays.some((p) => p.method !== 'advance' && p.amountPaise > 0)) continue; // paid at the desk: a refund from the invoice menu
    const fromAdv = pays.reduce((s, p) => s + p.amountPaise, 0);
    if (fromAdv > 0) { const base = { tenantId: ctx.tenantId, patientId: ch.patientId, method: 'advance', receivedBy: ctx.userId };
      await tx.insert(payment).values({ ...base, chargeId: ch.id, amountPaise: -fromAdv, reference: `Credit: ${reason}` });
      await tx.insert(payment).values({ ...base, advance: true, amountPaise: fromAdv, reference: `Back from ${ch.description}`.slice(0, 200) }); }
    await tx.update(charge).set({ status: 'cancelled', adjustmentReason: reason, adjustedBy: ctx.userId }).where(eq(charge.id, ch.id));
    await emit(tx, ctx, 'charge.cancelled', 'charge', ch.id, { reason, amountPaise: ch.amountPaise, sessionId });
  }
}

/** What a session means for the patient's money on the day: on the treatment's invoice (with what is still owed on it), due, already paid, or no price at all. */
export async function sittingMoney(tx: Tx, t: string, ps: { id: string; recommendationId: string; procedureId: string | null }): Promise<{ kind: 'invoiced' | 'due' | 'paid' | 'none'; amountPaise: number }> {
  const chs = await tx.select().from(charge).where(and(eq(charge.tenantId, t), eq(charge.sessionId, ps.id), notInArray(charge.status, VOID)));
  if (chs.length) {
    const due = chs.filter((x) => x.status !== 'paid').reduce((s, x) => s + x.amountPaise, 0);
    return due ? { kind: 'due', amountPaise: due } : { kind: 'paid', amountPaise: chs.reduce((s, x) => s + x.amountPaise, 0) };
  }
  const c = await tx.select().from(course).where(and(eq(course.tenantId, t), eq(course.recommendationId, ps.recommendationId))).then((r) => r[0]);
  if (c) {
    const st = await standing(tx, t, c);
    const covered = Math.round(st.invoicedPaise / Math.max(1, st.perSittingPaise)); // sessions the invoices pay for
    if (st.invoiced && (st.uninvoicedPaise <= 0 || st.doneSittings < covered)) return st.stillToPayPaise > 0 ? { kind: 'invoiced', amountPaise: st.stillToPayPaise } : { kind: 'paid', amountPaise: 0 }; // the treatment's invoice carries the money
    return { kind: 'due', amountPaise: Math.min(st.perSittingPaise, st.uninvoicedPaise) };
  }
  const price = ps.procedureId ? await tx.select({ p: procedureCatalog.pricePaise }).from(procedureCatalog).where(eq(procedureCatalog.id, ps.procedureId)).then((r) => r[0]?.p ?? null) : null;
  return price ? { kind: 'due', amountPaise: price } : { kind: 'none', amountPaise: 0 };
}

export function courseRoutes(app: FastifyInstance) {
  /** Start the course at its fixed price: list price × sittings, or a clinic package. There is no price to type: a reduction is a discount on a bill. */
  route(app, 'post', '/courses', 'worklist.write', async (req, tx) => {
    const b = z.object({ recommendationId: z.string().uuid() }).strict().parse(req.body);
    if (await tx.select({ id: course.id }).from(course).where(and(eq(course.tenantId, req.ctx.tenantId), eq(course.recommendationId, b.recommendationId))).then((r) => r.length)) throw new HttpError(409, 'ALREADY_AGREED');
    return standing(tx, req.ctx.tenantId, await ensureCourse(tx, req.ctx, b.recommendationId));
  });

  route(app, 'get', '/courses', 'worklist.read', async (req, tx) => {
    if (!can(req.perms, 'fees.see')) return [];
    const pid = String((req.query as any).patientId ?? ''); const t = req.ctx.tenantId;
    const rows = await tx.select().from(course).where(pid ? and(eq(course.tenantId, t), eq(course.patientId, pid)) : eq(course.tenantId, t)).orderBy(course.createdAt).limit(50);
    // each course with its next booked sitting, so the course popup and the patient's Procedures tab say the same thing
    const today = todayIn(req.ctx.timezone);
    return Promise.all(rows.map(async (c) => ({ ...(await standing(tx, t, c)), expired: !!c.validUntil && c.validUntil < today, // a package past its end date: sittings not done are expired, still refundable
      nextSitting: (await tx.select().from(procedureSession)
        .where(and(eq(procedureSession.tenantId, t), eq(procedureSession.recommendationId, c.recommendationId), eq(procedureSession.state, 'confirmed'))).orderBy(procedureSession.day, procedureSession.startTime).limit(1))[0] ?? null })));
  });

}
