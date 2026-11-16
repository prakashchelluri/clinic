import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, sql, inArray, notInArray } from 'drizzle-orm';
import { course, charge, creditLine, encounter, payment, practitioner, procedureCatalog, procedureSession, quote, recommendation } from '../db/schema.js';
import { advanceBalance, issueCredit, lineMoney, settle } from '../lib/money.js';
import type { Tx } from '../db/index.js';
import { route } from '../lib/route.js';
import { emit, nextNumber, todayIn, addMonths } from '../lib/core.js';
import { HttpError, can, type Ctx } from '../lib/auth.js';
import { stdTotal, validTill } from '../lib/procPrice.js';

type Course = typeof course.$inferSelect;
const sum = (rows: { n: number }[]) => rows[0]?.n ?? 0;
const VOID = ['cancelled', 'waived']; // charges that no longer count

/** The charges that bill a course: its own lines, and lines of its sessions billed before the course existed (older builds). */
async function courseCharges(tx: Tx, t: string, c: Course) {
  return tx.select().from(charge).where(and(eq(charge.tenantId, t), notInArray(charge.status, VOID),
    sql`(${charge.courseId} = ${c.id} or ${charge.sessionId} in (select id from procedure_session where recommendation_id = ${c.recommendationId}))`)).orderBy(charge.createdAt, charge.lineNo);
}

/**
 * Where the course stands, counted in sessions as well as rupees. A treatment is billed once for the sessions planned (at Generate invoice,
 * or when its first session is done); sessions never bill one by one. Sessions taken off come back as a credit note that records how many
 * sessions and how much of the list price it took back, so sessions added again later are always billable (never "Fully paid" for free).
 * "Per session" is what a session really costs the patient: after discount and credits. The old "paid ahead" fields stay, at zero.
 */
export async function standing(tx: Tx, t: string, c: Course) {
  const chs = await courseCharges(tx, t, c);
  const ids = chs.map((x) => x.id);
  const m = await lineMoney(tx, t, ids);
  const cls = ids.length ? await tx.select({ chargeId: creditLine.chargeId, sessions: creditLine.sessions, listPaise: creditLine.listPaise }).from(creditLine).where(and(eq(creditLine.tenantId, t), inArray(creditLine.chargeId, ids))) : [];
  const invoicedPaise = chs.reduce((s, x) => s + x.amountPaise + x.discountPaise, 0); // as issued, at the course price
  const discountPaise = chs.reduce((s, x) => s + x.discountPaise, 0);
  const creditedPaise = chs.reduce((s, x) => s + m.credited(x.id), 0);
  const paidPaise = chs.reduce((s, x) => s + m.applied(x.id), 0);
  const invoicedSessions = Math.max(0, chs.reduce((s, x) => s + (x.sessions ?? 0), 0) - cls.reduce((s, x) => s + x.sessions, 0));
  const listBilledPaise = invoicedPaise - cls.reduce((s, x) => s + x.listPaise, 0); // the list price of the sessions still on invoices
  const uninvoicedSessions = Math.max(0, c.sittings - invoicedSessions);
  const uninvoicedPaise = uninvoicedSessions ? Math.max(0, c.totalPaise - listBilledPaise) : 0;
  const netPaise = chs.reduce((s, x) => s + x.amountPaise, 0) - creditedPaise; // billed after discount and credits
  const duePaise = chs.reduce((s, x) => s + Math.max(0, x.amountPaise - m.credited(x.id) - m.applied(x.id)), 0);
  const done = sum(await tx.select({ n: sql<number>`count(*)::int` }).from(procedureSession).where(and(eq(procedureSession.tenantId, t), eq(procedureSession.recommendationId, c.recommendationId), eq(procedureSession.state, 'completed'))));
  const perSittingPaise = Math.round((netPaise + uninvoicedPaise) / Math.max(1, c.sittings));
  const treatment = chs.find((x) => !x.sessionId) ?? chs[0] ?? null;
  // the invoice lines that bill sessions, newest first, with the sessions still on each and their amount: what taking sessions off would credit
  const sessionLines = chs.filter((x) => (x.sessions ?? 0) > 0).map((x) => ({ sessions: (x.sessions ?? 0) - cls.filter((l) => l.chargeId === x.id).reduce((s, l) => s + l.sessions, 0), netPaise: x.amountPaise - m.credited(x.id) })).filter((x) => x.sessions > 0).reverse();
  return { ...c, sessionLines, perSittingPaise, invoicedPaise, uninvoicedPaise, invoicedSessions, uninvoicedSessions, listBilledPaise, netPaise, creditedPaise, invoiceId: treatment?.billId ?? null, invoiced: chs.length > 0,
    advancePaise: paidPaise, paidPaise, refundedPaise: 0, drawnPaise: 0, unusedPaise: 0, paidOnDayPaise: 0, doneSittings: done, unusedSittings: 0, refundablePaise: 0,
    discountPaise, duePaise, stillToPayPaise: duePaise + uninvoicedPaise };
}

/**
 * The treatment is cut to `keep` sessions (fewer sessions, or cancelled after some were done). Invoiced sessions taken off come back as one
 * credit note: at what a session was really charged (after discount and earlier credits), with the number of sessions and their share of the
 * list price, so they can be billed again if added back. The course price follows. Money paid above what is then owed moves to the advance.
 * Returns what moved to the advance.
 */
export async function creditSessions(tx: Tx, ctx: Ctx, c: Course, keep: number, reason: string) {
  const t = ctx.tenantId;
  const st = await standing(tx, t, c);
  const removed = Math.max(0, st.invoicedSessions - keep); const uninvKeep = keep - Math.min(st.invoicedSessions, keep);
  const uninvPer = st.uninvoicedSessions ? st.uninvoicedPaise / st.uninvoicedSessions : 0;
  // each invoice line at its own price per session, the newest first: sessions added later (at the standard price) come off before the
  // ones invoiced with the treatment, and a session already done keeps the price it was invoiced at
  const chs = (await courseCharges(tx, t, c)).filter((x) => (x.sessions ?? 0) > 0).reverse();
  const m = await lineMoney(tx, t, chs.map((x) => x.id));
  const cls = chs.length ? await tx.select({ chargeId: creditLine.chargeId, sessions: creditLine.sessions, listPaise: creditLine.listPaise }).from(creditLine).where(and(eq(creditLine.tenantId, t), inArray(creditLine.chargeId, chs.map((x) => x.id)))) : [];
  const byBill = new Map<string, { chargeId: string; amountPaise: number; what: string; sessions: number; listPaise: number }[]>();
  let left = removed; let listRemoved = 0;
  for (const x of chs) {
    if (!left) break;
    const mine = cls.filter((l) => l.chargeId === x.id);
    const sessions = (x.sessions ?? 0) - mine.reduce((s, l) => s + l.sessions, 0); if (sessions <= 0) continue;
    const net = x.amountPaise - m.credited(x.id); const list = x.amountPaise + x.discountPaise - mine.reduce((s, l) => s + l.listPaise, 0);
    const k = Math.min(left, sessions);
    const amount = k === sessions ? net : Math.round((net * k) / sessions); const listShare = k === sessions ? list : Math.round((list * k) / sessions);
    left -= k; listRemoved += listShare;
    if (amount > 0) byBill.set(x.billId!, [...(byBill.get(x.billId!) ?? []), { chargeId: x.id, amountPaise: amount, what: `${x.description}: ${k} session${k === 1 ? '' : 's'} not given`, sessions: k, listPaise: listShare }]);
  }
  await tx.update(course).set({ sittings: keep, totalPaise: Math.max(0, st.listBilledPaise - listRemoved + Math.round(uninvPer * uninvKeep)) }).where(eq(course.id, c.id)); // the sessions kept, at their price
  let moved = 0;
  for (const [billId, lines] of byBill) moved += (await issueCredit(tx, ctx, { billId, patientId: c.patientId, reason, lines })).toAdvancePaise;
  return moved;
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

/** A new invoice line is paid from the patient's advance first, as far as it goes (no money moves, so method 'advance'). */
async function payFromAdvance(tx: Tx, ctx: Ctx, ch: { id: string; patientId: string; amountPaise: number; description: string }) {
  const t = ctx.tenantId;
  const take = Math.min(await advanceBalance(tx, t, ch.patientId), ch.amountPaise); if (take <= 0) return;
  const base = { tenantId: t, patientId: ch.patientId, method: 'advance', receivedBy: ctx.userId };
  await tx.insert(payment).values({ ...base, chargeId: ch.id, amountPaise: take });
  await tx.insert(payment).values({ ...base, advance: true, amountPaise: -take, reference: ch.description.slice(0, 60) });
  await settle(tx, t, [ch.id]);
}

/** A session was done. A treatment not on an invoice yet is invoiced now, whole (a package: all its procedures, on one invoice), so a
 *  done session never goes out unbilled and is never billed twice. Sessions themselves bill nothing. */
export async function drawSitting(tx: Tx, ctx: Ctx, ps: { id: string; recommendationId: string; patientId: string; procedureId?: string | null; sittingNo?: number }) {
  const t = ctx.tenantId;
  let c: Course;
  try { c = await ensureCourse(tx, ctx, ps.recommendationId); } catch (e) { if (e instanceof HttpError) return; throw e; } // no price anywhere: nothing to bill
  const group = c.packageGroup ? await tx.select().from(course).where(and(eq(course.tenantId, t), eq(course.patientId, c.patientId), eq(course.packageGroup, c.packageGroup))) : [c];
  let billId: string | null = null;
  for (const k of group) {
    const st = await standing(tx, t, k); if (st.uninvoicedPaise <= 0) continue;
    const proc = k.procedureId ? await tx.select({ name: procedureCatalog.name, tax: procedureCatalog.taxRateBp }).from(procedureCatalog).where(eq(procedureCatalog.id, k.procedureId)).then((r) => r[0]) : null;
    const n = st.uninvoicedSessions;
    const [row]: (typeof charge.$inferSelect)[] = await tx.insert(charge).values({ tenantId: t, patientId: k.patientId, billId, description: `${proc?.name ?? 'Procedure'}${k.packageName ? ` (${k.packageName})` : ''} · ${n} session${n === 1 ? '' : 's'}${st.invoiced ? ' added' : ''}`,
      amountPaise: st.uninvoicedPaise, taxRateBp: proc?.tax ?? 0, courseId: k.id, procedureId: k.procedureId, sessions: n, status: 'due' }).returning();
    billId = row.billId;
    await emit(tx, ctx, 'course.invoiced', 'charge', row.id, { courseId: k.id, amountPaise: row.amountPaise, onSessionDone: ps.id });
    await payFromAdvance(tx, ctx, row);
  }
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

/** What a session means for the patient's money: on the treatment's invoice (with what is still owed), paid, billed on its own (older builds),
 *  invoiced when it is done (the treatment is not on an invoice yet: the whole of it), or no price at all. */
export async function sittingMoney(tx: Tx, t: string, ps: { id: string; recommendationId: string; procedureId: string | null }): Promise<{ kind: 'invoiced' | 'on_done' | 'due' | 'paid' | 'none'; amountPaise: number }> {
  const c = await tx.select().from(course).where(and(eq(course.tenantId, t), eq(course.recommendationId, ps.recommendationId))).then((r) => r[0]);
  if (c) {
    const st = await standing(tx, t, c);
    if (st.invoiced && st.uninvoicedSessions > 0) return { kind: 'on_done', amountPaise: st.uninvoicedPaise }; // sessions added since: marking one done invoices them
    if (st.invoiced) return st.stillToPayPaise > 0 ? { kind: 'invoiced', amountPaise: st.stillToPayPaise } : { kind: 'paid', amountPaise: 0 };
    return { kind: 'on_done', amountPaise: st.uninvoicedPaise };
  }
  const rec = await tx.select({ amountPaise: recommendation.amountPaise, sittings: recommendation.sittings }).from(recommendation).where(eq(recommendation.id, ps.recommendationId)).then((r) => r[0]);
  const proc = ps.procedureId ? await tx.select().from(procedureCatalog).where(eq(procedureCatalog.id, ps.procedureId)).then((r) => r[0]) : null;
  const total = rec?.amountPaise && rec.amountPaise > 0 ? rec.amountPaise : (proc?.pricePaise ?? 0) * (rec?.sittings ?? 1);
  return total ? { kind: 'on_done', amountPaise: total } : { kind: 'none', amountPaise: 0 };
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
