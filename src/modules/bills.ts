import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { charge, course, discountAsk, domainEvent, patient, payment, procedureCatalog, service, tenant } from '../db/schema.js';
import type { Tx } from '../db/index.js';
import { route } from '../lib/route.js';
import { emit, todayIn } from '../lib/core.js';
import { HttpError, can } from '../lib/auth.js';
import { assertDayOpen } from './dayclose.js';
import { nextReceiptNo } from './billing.js';
import { ensureCourse, standing } from './courses.js';

const Line = z.object({
  chargeId: z.string().uuid().optional(),         // an invoice already due
  procedureId: z.string().uuid().optional(),      // a procedure from the price list, billed now
  serviceId: z.string().uuid().optional(),        // a clinic service from the price list, billed now
  qty: z.number().int().min(1).max(20).default(1),
  recommendationId: z.string().uuid().optional(), // sittings paid ahead on a procedure course
  sittings: z.number().int().min(1).max(60).default(1),
  discountPaise: z.number().int().min(0).max(100_000_000).default(0),
}).refine((l) => [l.chargeId, l.procedureId, l.serviceId, l.recommendationId].filter(Boolean).length === 1, 'One of chargeId, procedureId, serviceId or recommendationId');

const Bill = z.object({
  patientId: z.string().uuid(),
  lines: z.array(Line).max(20).default([]),       // none: the money is all advance
  extraDiscountPaise: z.number().int().min(0).max(100_000_000).default(0), // off the whole bill, shared across the lines that can take a discount
  reason: z.string().trim().max(200).default(''),
  // 'advance' = paid from the patient's advance balance
  parts: z.array(z.object({ method: z.enum(['cash', 'upi', 'card', 'bank', 'emi', 'advance']), amountPaise: z.number().int().positive().max(100_000_000), reference: z.string().trim().max(60).optional(), lender: z.string().trim().max(60).optional() })).max(5).default([]),
  keepExtraAsAdvance: z.boolean().default(false), // more than the bill: the rest goes to the patient's advance
  idempotencyKey: z.string().min(8).max(80),
});

/** What is left of the patient's advance: money in, less what bills used and what was given back. */
export async function advanceBalance(tx: Tx, t: string, patientId: string) {
  const [r] = await tx.select({ n: sql<number>`coalesce(sum(amount_paise),0)::int` }).from(payment).where(and(eq(payment.tenantId, t), eq(payment.patientId, patientId), eq(payment.advance, true)));
  return r?.n ?? 0;
}

type Item = { what: string; gross: number; prior: number; disc: number; canDiscount: boolean; why?: string; chargeId?: string; courseId?: string; ahead?: boolean; at: string; tax?: number; isNew?: boolean };

const paidOn = async (tx: Tx, ids: string[]) => {
  if (!ids.length) return new Map<string, number>();
  const rows = await tx.select({ id: payment.chargeId, n: sql<number>`coalesce(sum(amount_paise),0)::int` }).from(payment).where(inArray(payment.chargeId, ids)).groupBy(payment.chargeId);
  return new Map(rows.map((r) => [r.id!, r.n]));
};

/** Discounts waiting for approval, by invoice and by course: what the desk must not collect until someone decides. */
export async function waitingOff(tx: Tx, t: string, patientId: string) {
  const asks = await tx.select().from(discountAsk).where(and(eq(discountAsk.tenantId, t), eq(discountAsk.patientId, patientId), eq(discountAsk.status, 'pending')));
  const m = new Map<string, number>();
  for (const a of asks) for (const l of a.lines) { const k = l.chargeId ?? l.courseId!; m.set(k, (m.get(k) ?? 0) + l.offPaise); }
  return m;
}

export function billRoutes(app: FastifyInstance) {
  /**
   * One bill: invoices already due, items from the price list and sittings paid ahead, with a discount per line and one off the whole bill,
   * paid now in up to four modes, or partly, or not at all (the rest stays due). Prices are never typed: they come from the price list.
   * A discount within the clinic limit, from someone allowed to give one, applies at once. Anything else waits for an approver;
   * meanwhile only the discounted amount can be taken, and the rest stays open until they decide.
   */
  route(app, 'post', '/bills', 'payment.record', async (req, tx) => {
    const b = Bill.parse(req.body);
    const t = req.ctx.tenantId; const ctx = req.ctx;
    const dup = await tx.select({ p: domainEvent.payload }).from(domainEvent).where(and(eq(domainEvent.tenantId, t), eq(domainEvent.type, 'bill.created'), sql`${domainEvent.payload}->>'key' = ${b.idempotencyKey}`)).limit(1);
    if (dup.length) return { ...(dup[0].p as any), repeated: true };
    if (b.parts.length) await assertDayOpen(tx, ctx);
    for (const p of b.parts) if (p.method === 'emi' && (!p.lender || !p.reference)) throw new HttpError(400, 'EMI_NEEDS_LENDER_AND_APPROVAL_CODE');
    const pt = await tx.select({ id: patient.id }).from(patient).where(and(eq(patient.id, b.patientId), eq(patient.tenantId, t))).then((r) => r[0]);
    if (!pt) throw new HttpError(404, 'PATIENT_NOT_FOUND');
    const waiting = await waitingOff(tx, t, b.patientId);

    // what each line is and what is owed on it now
    const items: Item[] = [];
    const chargeIds = b.lines.map((l) => l.chargeId).filter(Boolean) as string[];
    if (new Set(chargeIds).size !== chargeIds.length) throw new HttpError(400, 'SAME_INVOICE_TWICE');
    const paid = await paidOn(tx, chargeIds);
    for (const l of b.lines) {
      if (l.chargeId) {
        const c = await tx.select().from(charge).where(and(eq(charge.id, l.chargeId), eq(charge.tenantId, t), eq(charge.patientId, b.patientId))).then((r) => r[0]);
        if (!c) throw new HttpError(404, 'CHARGE_NOT_FOUND');
        const owing = c.amountPaise - (paid.get(c.id) ?? 0) - (waiting.get(c.id) ?? 0);
        if (c.status !== 'due' || owing <= 0) throw new HttpError(409, 'NOTHING_DUE', { chargeId: c.id });
        const why = c.visitId ? 'NO_DISCOUNT_ON_CONSULTATION' : c.description.startsWith('Pharmacy') ? 'NO_DISCOUNT_ON_PHARMACY' : (paid.get(c.id) ?? 0) > 0 ? 'DISCOUNT_ONLY_BEFORE_PAYMENT' : waiting.has(c.id) ? 'DISCOUNT_ALREADY_WAITING' : undefined;
        items.push({ what: c.description, gross: owing, prior: c.discountPaise, disc: l.discountPaise, canDiscount: !why, why, chargeId: c.id, at: c.createdAt });
      } else if (l.procedureId) {
        const p = await tx.select().from(procedureCatalog).where(and(eq(procedureCatalog.id, l.procedureId), eq(procedureCatalog.tenantId, t))).then((r) => r[0]);
        if (!p) throw new HttpError(404, 'PROCEDURE_NOT_FOUND');
        if (!p.pricePaise) throw new HttpError(400, 'NO_PRICE_ON_THE_PRICE_LIST');
        items.push({ what: l.qty > 1 ? `${p.name} × ${l.qty}` : p.name, gross: p.pricePaise * l.qty, prior: 0, disc: l.discountPaise, canDiscount: true, isNew: true, tax: p.taxRateBp, at: new Date().toISOString() });
      } else if (l.serviceId) {
        const s = await tx.select().from(service).where(and(eq(service.id, l.serviceId), eq(service.tenantId, t))).then((r) => r[0]);
        if (!s) throw new HttpError(404, 'SERVICE_NOT_FOUND');
        if (!s.pricePaise) throw new HttpError(400, 'NO_PRICE_ON_THE_PRICE_LIST');
        items.push({ what: l.qty > 1 ? `${s.name} × ${l.qty}` : s.name, gross: s.pricePaise * l.qty, prior: 0, disc: l.discountPaise, canDiscount: true, isNew: true, tax: 0, at: new Date().toISOString() });
      } else {
        const c = await ensureCourse(tx, ctx, l.recommendationId!);
        if (c.patientId !== b.patientId) throw new HttpError(404, 'PLAN_NOT_FOUND');
        const st = await standing(tx, t, c);
        const left = st.stillToPayPaise - (waiting.get(c.id) ?? 0); const sittingsLeft = c.sittings - st.doneSittings - st.unusedSittings;
        const gross = l.sittings >= sittingsLeft ? left : Math.min(l.sittings * st.perSittingPaise, left); // every sitting left = exactly what is left (the rounding too)
        if (gross <= 0) throw new HttpError(409, 'NOTHING_LEFT_TO_PAY_AHEAD');
        if (c.validUntil && c.validUntil < todayIn(ctx.timezone)) throw new HttpError(409, 'PACKAGE_EXPIRED', { validUntil: c.validUntil });
        const name = c.procedureId ? await tx.select({ n: procedureCatalog.name }).from(procedureCatalog).where(eq(procedureCatalog.id, c.procedureId)).then((r) => r[0]?.n) : null;
        items.push({ what: `${name ?? 'Procedure'}${c.packageName ? ` (${c.packageName})` : ''} · ${l.sittings} session${l.sittings === 1 ? '' : 's'} paid ahead`, gross, prior: 0, disc: l.discountPaise, canDiscount: !waiting.has(c.id), why: waiting.has(c.id) ? 'DISCOUNT_ALREADY_WAITING' : undefined, courseId: c.id, ahead: true, at: '' });
      }
    }

    // the discount: per line, then the extra shared across the lines that can take one, in proportion
    const bad = items.find((i) => i.disc > 0 && !i.canDiscount); if (bad) throw new HttpError(400, bad.why!);
    if (b.extraDiscountPaise > 0) {
      const room = items.filter((i) => i.canDiscount); const base = room.reduce((s, i) => s + i.gross - i.disc, 0);
      if (!base) throw new HttpError(400, 'NOTHING_TO_DISCOUNT');
      let left = b.extraDiscountPaise;
      room.forEach((i, k) => { const share = k === room.length - 1 ? left : Math.round((b.extraDiscountPaise * (i.gross - i.disc)) / base); i.disc += share; left -= share; });
    }
    for (const i of items) if (i.disc >= i.gross && i.disc > 0) throw new HttpError(400, 'DISCOUNT_MORE_THAN_THE_ITEM', { what: i.what });
    const off = items.reduce((s, i) => s + i.disc, 0);
    if (off > 0 && b.reason.length < 3) throw new HttpError(400, 'REASON_REQUIRED');
    const ten = await tx.select().from(tenant).where(eq(tenant.id, t)).then((r) => r[0]);
    const cap = Number((ten?.settings as any)?.discountCapPct ?? 10);
    const off_ = items.filter((i) => i.disc > 0); const listSum = off_.reduce((s, i) => s + i.gross + i.prior, 0);
    const pct = listSum ? Math.round(((off + off_.reduce((s, i) => s + i.prior, 0)) / listSum) * 1000) / 10 : 0; // what was already taken off these lines counts too
    const ask = off > 0 && (!can(req.perms, 'discount.give') || (pct > cap && !can(req.perms, 'discount.approve')));

    // new items become invoices; a discount that may be given now comes off at once
    let newBill: string | undefined; // everything added on this screen is one invoice
    for (const i of items) if (i.isNew) {
      const [row] = await tx.insert(charge).values({ billId: newBill, tenantId: t, patientId: b.patientId, description: i.what, amountPaise: i.gross, taxRateBp: i.tax ?? 0, status: 'due' }).returning();
      i.chargeId = row.id; i.at = row.createdAt; newBill = row.billId ?? undefined;
    }
    let askId: string | null = null;
    if (off > 0 && !ask) {
      for (const i of off_) {
        if (i.courseId) await tx.update(course).set({ creditPaise: sql`${course.creditPaise} + ${i.disc}` }).where(eq(course.id, i.courseId));
        else await tx.update(charge).set({ amountPaise: sql`${charge.amountPaise} - ${i.disc}`, discountPaise: sql`${charge.discountPaise} + ${i.disc}`, discountReason: b.reason }).where(eq(charge.id, i.chargeId!));
        await emit(tx, ctx, 'charge.discounted', i.courseId ? 'course' : 'charge', (i.courseId ?? i.chargeId)!, { reason: b.reason, discountPaise: i.disc, pct });
      }
    } else if (ask) {
      const [row] = await tx.insert(discountAsk).values({ tenantId: t, patientId: b.patientId, reason: b.reason, askedBy: ctx.name, listPaise: listSum, offPaise: off,
        lines: off_.map((i) => ({ ...(i.courseId ? { courseId: i.courseId } : { chargeId: i.chargeId! }), what: i.what, listPaise: i.gross + i.prior, offPaise: i.disc })) }).returning();
      askId = row.id;
      await emit(tx, ctx, 'discount.asked', 'discount_ask', row.id, { offPaise: off, pct, capPct: cap, reason: b.reason });
    }

    // the money: sittings paid ahead first (in full), then the invoices, oldest first; anything beyond the bill goes to the advance
    const payable = items.reduce((s, i) => s + i.gross - i.disc, 0);
    const total = b.parts.reduce((s, p) => s + p.amountPaise, 0);
    const fromAdvance = b.parts.filter((p) => p.method === 'advance').reduce((s, p) => s + p.amountPaise, 0);
    if (fromAdvance) { const bal = await advanceBalance(tx, t, b.patientId); if (fromAdvance > bal) throw new HttpError(400, 'MORE_THAN_THE_ADVANCE', { balancePaise: bal }); }
    const extra = total - payable;
    if (extra > 0 && (!b.keepExtraAsAdvance || extra > total - fromAdvance)) throw new HttpError(400, 'MORE_THAN_DUE', { duePaise: payable }); // the advance never pays into itself
    if (!items.length && total <= 0) throw new HttpError(400, 'NOTHING_TO_BILL');
    const aheadNeed = items.filter((i) => i.ahead).reduce((s, i) => s + i.gross - i.disc, 0);
    if (aheadNeed > total) throw new HttpError(400, 'PAY_AHEAD_IN_FULL', { needPaise: aheadNeed });
    const targets = [...items.filter((i) => i.ahead), ...items.filter((i) => !i.ahead).sort((x, y) => x.at.localeCompare(y.at))].map((i) => ({ i, room: i.gross - i.disc }));
    const receiptNo = total - fromAdvance ? await nextReceiptNo(tx, t, ctx.timezone) : null; // a receipt is for money handed over
    let seq = 0;
    const put = (v: Partial<typeof payment.$inferInsert> & { amountPaise: number; method: string }) => tx.insert(payment).values({ tenantId: t, patientId: b.patientId, receiptNo: v.method === 'advance' ? null : receiptNo, receivedBy: ctx.userId, idempotencyKey: `${b.idempotencyKey}#${seq++}`, ...v });
    // the advance is used first, so new money is what is left for the rest (and for any extra)
    for (const part of [...b.parts].sort((x, y) => Number(y.method === 'advance') - Number(x.method === 'advance'))) {
      let rest = part.amountPaise;
      for (const g of targets) {
        if (!rest) break; if (!g.room) continue;
        const take = Math.min(rest, g.room); rest -= take; g.room -= take;
        await put({ ...(g.i.ahead ? { courseId: g.i.courseId } : { chargeId: g.i.chargeId }), amountPaise: take, method: part.method, reference: part.reference ?? null, lender: part.lender ?? null });
        if (part.method === 'advance') await put({ advance: true, amountPaise: -take, method: 'advance', reference: g.i.what.slice(0, 60) });
      }
      if (rest > 0) await put({ advance: true, amountPaise: rest, method: part.method, reference: part.reference ?? null, lender: part.lender ?? null }); // kept as advance
    }
    for (const i of items) if (i.ahead && aheadNeed) await tx.update(course).set({ lockedAt: sql`coalesce(${course.lockedAt}, now())` }).where(eq(course.id, i.courseId!));
    const ids = items.filter((i) => !i.ahead).map((i) => i.chargeId!);
    const nowPaid = await paidOn(tx, ids);
    for (const c of ids.length ? await tx.select().from(charge).where(inArray(charge.id, ids)) : []) if ((nowPaid.get(c.id) ?? 0) >= c.amountPaise) await tx.update(charge).set({ status: 'paid' }).where(eq(charge.id, c.id));
    if (askId) await tx.update(discountAsk).set({ paidPaise: total }).where(eq(discountAsk.id, askId));
    const out = { key: b.idempotencyKey, receiptNo, paidPaise: total, payablePaise: payable, balancePaise: Math.max(0, payable - total), keptAsAdvancePaise: Math.max(0, total - payable), advancePaise: await advanceBalance(tx, t, b.patientId), offPaise: off, pct, capPct: cap, askId, waitingForApproval: ask };
    await emit(tx, ctx, 'bill.created', 'patient', b.patientId, out);
    if (total) await emit(tx, ctx, 'payment.recorded', 'patient', b.patientId, { amountPaise: total, methods: b.parts.map((p) => p.method), receiptNo });
    return { ...out, repeated: false };
  });

  /** Give back what is left of the advance: money out today, with a reason, by someone who may refund. */
  route(app, 'post', '/patients/:id/advance/refund', 'payment.refund', async (req, tx) => {
    const b = z.object({ amountPaise: z.number().int().positive().max(100_000_000), method: z.enum(['cash', 'upi', 'card', 'bank']), reason: z.string().trim().min(3, 'Say why').max(200) }).parse(req.body);
    const t = req.ctx.tenantId; const pid = (req.params as any).id;
    await assertDayOpen(tx, req.ctx);
    const bal = await advanceBalance(tx, t, pid);
    if (b.amountPaise > bal) throw new HttpError(400, 'MORE_THAN_THE_ADVANCE', { balancePaise: bal });
    const [row] = await tx.insert(payment).values({ tenantId: t, patientId: pid, advance: true, amountPaise: -b.amountPaise, method: b.method, reference: `Refund: ${b.reason}`.slice(0, 200), receivedBy: req.ctx.userId }).returning();
    await emit(tx, req.ctx, 'advance.refunded', 'payment', row.id, { amountPaise: b.amountPaise, reason: b.reason, patientId: pid });
    return { balancePaise: bal - b.amountPaise };
  });

  /** Discounts waiting for a decision (or one patient's, any state). Anyone who sees fees sees them; only an approver decides. */
  route(app, 'get', '/discount-asks', 'fees.see', async (req, tx) => {
    const q = req.query as any; const t = req.ctx.tenantId;
    const where = q.patientId ? and(eq(discountAsk.tenantId, t), eq(discountAsk.patientId, String(q.patientId))) : and(eq(discountAsk.tenantId, t), eq(discountAsk.status, 'pending'));
    const rows = await tx.select({ a: discountAsk, name: patient.fullName, phone: patient.phone, no: patient.patientNo }).from(discountAsk).innerJoin(patient, eq(patient.id, discountAsk.patientId)).where(where).orderBy(discountAsk.createdAt).limit(100);
    return rows.map((r) => ({ ...r.a, patient: { id: r.a.patientId, fullName: r.name, phone: r.phone, patientNo: r.no }, pct: Math.round((r.a.offPaise / Math.max(1, r.a.listPaise)) * 1000) / 10 }));
  });

  /** Approve: the discount comes off the invoices (and the course). Say no: the amount stays due, as billed. */
  route(app, 'post', '/discount-asks/:id/decide', 'discount.approve', async (req, tx) => {
    const b = z.object({ action: z.enum(['approve', 'reject']) }).parse(req.body);
    const t = req.ctx.tenantId;
    const a = await tx.select().from(discountAsk).where(and(eq(discountAsk.id, (req.params as any).id), eq(discountAsk.tenantId, t))).then((r) => r[0]);
    if (!a) throw new HttpError(404, 'NOT_FOUND');
    if (a.status !== 'pending') throw new HttpError(409, 'ALREADY_DECIDED', { status: a.status });
    if (b.action === 'approve') {
      for (const l of a.lines) {
        if (l.courseId) { await tx.update(course).set({ creditPaise: sql`${course.creditPaise} + ${l.offPaise}` }).where(eq(course.id, l.courseId)); continue; }
        const c = await tx.select().from(charge).where(eq(charge.id, l.chargeId!)).then((r) => r[0]);
        if (!c || c.status !== 'due') continue; // cancelled or waived meanwhile: nothing to take it off
        const amount = c.amountPaise - l.offPaise; const got = (await paidOn(tx, [c.id])).get(c.id) ?? 0;
        if (got > amount) throw new HttpError(409, 'ALREADY_PAID_MORE', { chargeId: c.id });
        await tx.update(charge).set({ amountPaise: amount, discountPaise: c.discountPaise + l.offPaise, discountReason: a.reason, ...(got >= amount ? { status: 'paid' } : {}) }).where(eq(charge.id, c.id));
      }
    }
    const [row] = await tx.update(discountAsk).set({ status: b.action === 'approve' ? 'approved' : 'rejected', decidedBy: req.ctx.name, decidedAt: new Date().toISOString() }).where(eq(discountAsk.id, a.id)).returning();
    await emit(tx, req.ctx, b.action === 'approve' ? 'discount.approved' : 'discount.rejected', 'discount_ask', a.id, { offPaise: a.offPaise, patientId: a.patientId });
    return row;
  });
}
