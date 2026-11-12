import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, gte, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import { bill, charge, discountAsk, patient, payment, tenant, appUser } from '../db/schema.js';
import type { Tx } from '../db/index.js';
import { route } from '../lib/route.js';
import { emit, todayIn } from '../lib/core.js';
import { HttpError } from '../lib/auth.js';
import { assertDayOpen } from './dayclose.js';
import { dayBounds, gstSummary } from './billing.js';
import { advanceBalance } from './bills.js';

const NONE = '00000000-0000-4000-8000-000000000000';
export type BillStatus = 'paid' | 'part' | 'unpaid' | 'refunded' | 'part_refunded' | 'cancelled';

/** Invoices with their lines and money: billed, discount, paid, due, refunded, and a status, the same everywhere they are shown. */
export async function billViews(tx: Tx, t: string, where: SQL, limit = 200) {
  const bills = await tx.select({ b: bill, name: patient.fullName, phone: patient.phone, no: patient.patientNo }).from(bill).innerJoin(patient, eq(patient.id, bill.patientId))
    .where(and(eq(bill.tenantId, t), where)).orderBy(desc(bill.createdAt)).limit(limit);
  const ids = bills.map((x) => x.b.id);
  const lines = await tx.select().from(charge).where(and(eq(charge.tenantId, t), inArray(charge.billId, ids.length ? ids : [NONE]))).orderBy(charge.createdAt);
  const cids = lines.map((c) => c.id);
  const pays = await tx.select().from(payment).where(and(eq(payment.tenantId, t), or(inArray(payment.chargeId, cids.length ? cids : [NONE]), inArray(payment.billId, ids.length ? ids : [NONE]))));
  const asks = await tx.select().from(discountAsk).where(and(eq(discountAsk.tenantId, t), eq(discountAsk.status, 'pending')));
  const waiting = new Map<string, number>(); for (const a of asks) for (const l of a.lines) if (l.chargeId) waiting.set(l.chargeId, (waiting.get(l.chargeId) ?? 0) + l.offPaise);
  return bills.map(({ b, name, phone, no }) => {
    const ls = lines.filter((c) => c.billId === b.id);
    const live = ls.filter((c) => !['cancelled', 'waived'].includes(c.status));
    const onLine = (id: string) => pays.filter((p) => p.chargeId === id);
    const paid = ls.reduce((s, c) => s + onLine(c.id).filter((p) => p.amountPaise > 0).reduce((n, p) => n + p.amountPaise, 0), 0);
    const refunded = -ls.reduce((s, c) => s + onLine(c.id).filter((p) => p.amountPaise < 0).reduce((n, p) => n + p.amountPaise, 0), 0) // older refunds, on the line
      - pays.filter((p) => p.billId === b.id && !p.chargeId).reduce((n, p) => n + p.amountPaise, 0);
    const due = live.filter((c) => c.status === 'due').reduce((s, c) => s + Math.max(0, c.amountPaise - onLine(c.id).reduce((n, p) => n + p.amountPaise, 0) - (waiting.get(c.id) ?? 0)), 0);
    const waitingOff = live.reduce((s, c) => s + (waiting.get(c.id) ?? 0), 0);
    const billed = live.reduce((s, c) => s + c.amountPaise, 0); const discount = live.reduce((s, c) => s + c.discountPaise, 0);
    const status: BillStatus = !live.length ? 'cancelled' : refunded > 0 && refunded >= paid ? 'refunded' : due > 0 ? (paid > 0 ? 'part' : 'unpaid') : refunded > 0 ? 'part_refunded' : 'paid';
    return {
      id: b.id, invoiceNo: b.invoiceNo, createdAt: b.createdAt, patient: { id: b.patientId, fullName: name, phone, patientNo: no },
      items: ls.map((c) => c.description), lines: ls, billedPaise: billed, discountPaise: discount, paidPaise: paid, duePaise: due, refundedPaise: refunded, waitingOffPaise: waitingOff, status,
      pharmacy: ls.some((c) => c.description.startsWith('Pharmacy')), excluded: ls.length > 0 && ls.every((c) => !!c.excludedAt),
      receipts: [...new Set(pays.map((p) => p.receiptNo).filter(Boolean))] as string[],
    };
  });
}

const totals = (bs: Awaited<ReturnType<typeof billViews>>) => ({
  n: bs.length, billedPaise: bs.reduce((s, b) => s + b.billedPaise, 0), paidPaise: bs.reduce((s, b) => s + b.paidPaise, 0), duePaise: bs.reduce((s, b) => s + b.duePaise, 0), refundedPaise: bs.reduce((s, b) => s + b.refundedPaise, 0),
  paidFully: bs.filter((b) => b.status === 'paid').length, withDue: bs.filter((b) => b.duePaise > 0).length, withRefund: bs.filter((b) => b.refundedPaise > 0).length,
});

export function invoiceRoutes(app: FastifyInstance) {
  /** One patient's invoices, newest first, with the totals for the top of the Bills tab. */
  route(app, 'get', '/patients/:id/bills', 'fees.see', async (req, tx) => {
    const bs = await billViews(tx, req.ctx.tenantId, eq(bill.patientId, (req.params as any).id));
    return { bills: bs, totals: totals(bs) };
  });

  /** Every invoice in a period (the clinic's billing list), searchable by patient, phone or invoice number. */
  route(app, 'get', '/bills', 'fees.see', async (req, tx) => {
    const q = req.query as any; const tz = req.ctx.timezone; const today = todayIn(tz);
    const from = /^\d{4}-\d{2}-\d{2}$/.test(q.from ?? '') ? q.from : today; const to = /^\d{4}-\d{2}-\d{2}$/.test(q.to ?? '') ? q.to : from;
    const term = String(q.q ?? '').trim().slice(0, 60);
    const like = `%${term}%`;
    const where = and(gte(bill.createdAt, dayBounds(from, tz).start), lt(bill.createdAt, dayBounds(to, tz).end),
      term ? or(sql`${bill.invoiceNo} ilike ${like}`, sql`${patient.fullName} ilike ${like}`, sql`${patient.phone} ilike ${like}`) : undefined)!;
    const bs = await billViews(tx, req.ctx.tenantId, where, 500);
    return { from, to, bills: bs, totals: totals(bs) };
  });

  /** One invoice as it prints: the clinic, the patient, each line with its discount and GST, the payments and refunds. */
  route(app, 'get', '/bills/:id', 'fees.see', async (req, tx) => {
    const t = req.ctx.tenantId;
    const [v] = await billViews(tx, t, eq(bill.id, (req.params as any).id), 1);
    if (!v) throw new HttpError(404, 'NOT_FOUND');
    const p = await tx.select().from(patient).where(eq(patient.id, v.patient.id)).then((r) => r[0]);
    const ten = await tx.select().from(tenant).where(eq(tenant.id, t)).then((r) => r[0]);
    const cids = v.lines.map((c) => c.id);
    const pays = await tx.select({ p: payment, by: appUser.name }).from(payment).leftJoin(appUser, eq(appUser.id, payment.receivedBy))
      .where(and(eq(payment.tenantId, t), or(inArray(payment.chargeId, cids.length ? cids : [NONE]), eq(payment.billId, v.id)))).orderBy(payment.receivedAt);
    const live = v.lines.filter((c) => !['cancelled', 'waived'].includes(c.status));
    return { ...v, clinic: { name: ten?.name, print: (ten?.settings as any)?.print ?? {}, gstin: (ten?.settings as any)?.gstin ?? null },
      patient: { ...v.patient, ageYears: p?.ageYears, sex: p?.sex },
      rows: v.lines.map((c) => ({ id: c.id, description: c.description, listPaise: c.amountPaise + c.discountPaise, discountPaise: c.discountPaise, discountReason: c.discountReason, taxRateBp: c.taxRateBp, amountPaise: c.amountPaise, status: c.status, reason: c.adjustmentReason, visitId: c.visitId, excludedAt: c.excludedAt })),
      subtotalPaise: live.reduce((s, c) => s + c.amountPaise + c.discountPaise, 0),
      gst: gstSummary((ten?.settings as any)?.gstin, live.map((c) => ({ amountPaise: c.amountPaise, taxRateBp: c.taxRateBp }))),
      gstPaise: live.reduce((s, c) => s + (c.taxRateBp ? c.amountPaise - Math.round((c.amountPaise * 10000) / (10000 + c.taxRateBp)) : 0), 0),
      payments: pays.map(({ p, by }) => ({ at: p.receivedAt, amountPaise: p.amountPaise, method: p.method, reference: p.reference, lender: p.lender, receiptNo: p.receiptNo, by, refund: p.amountPaise < 0 })) };
  });

  /** Give money back on an invoice: any part of what was paid, in one or more modes, with a reason. What was due stays as it was. */
  route(app, 'post', '/bills/:id/refund', 'payment.refund', async (req, tx) => {
    const b = z.object({ parts: z.array(z.object({ method: z.enum(['cash', 'upi', 'card', 'bank']), amountPaise: z.number().int().positive().max(100_000_000), reference: z.string().trim().max(60).optional() })).min(1).max(4),
      reason: z.string().trim().min(3, 'Say why').max(200) }).parse(req.body);
    const t = req.ctx.tenantId;
    const [v] = await billViews(tx, t, eq(bill.id, (req.params as any).id), 1);
    if (!v) throw new HttpError(404, 'NOT_FOUND');
    await assertDayOpen(tx, req.ctx); // the money leaves today
    const left = v.paidPaise - v.refundedPaise; const total = b.parts.reduce((s, p) => s + p.amountPaise, 0);
    if (total > left) throw new HttpError(400, 'MORE_THAN_PAID', { refundablePaise: left });
    for (const p of b.parts) await tx.insert(payment).values({ tenantId: t, patientId: v.patient.id, billId: v.id, amountPaise: -p.amountPaise, method: p.method, reference: `Refund ${v.invoiceNo} · ${b.reason}`.slice(0, 200), receivedBy: req.ctx.userId });
    if (total === left && v.duePaise === 0) // all of it back: the invoice no longer counts as billed
      await tx.update(charge).set({ status: 'refunded', adjustmentReason: b.reason, adjustedBy: req.ctx.userId }).where(and(eq(charge.billId, v.id), inArray(charge.status, ['paid'])));
    await emit(tx, req.ctx, 'bill.refunded', 'bill', v.id, { amountPaise: total, reason: b.reason, invoiceNo: v.invoiceNo });
    return { refundedPaise: total, invoiceNo: v.invoiceNo };
  });

  /** The patient's advance: what is left, and every deposit, use and refund. */
  route(app, 'get', '/patients/:id/advance', 'fees.see', async (req, tx) => {
    const t = req.ctx.tenantId; const pid = (req.params as any).id;
    const rows = await tx.select().from(payment).where(and(eq(payment.tenantId, t), eq(payment.patientId, pid), eq(payment.advance, true))).orderBy(desc(payment.receivedAt)).limit(200);
    return { balancePaise: await advanceBalance(tx, t, pid),
      history: rows.map((p) => ({ id: p.id, at: p.receivedAt, amountPaise: p.amountPaise, method: p.method, receiptNo: p.receiptNo, kind: p.amountPaise > 0 ? 'deposit' : p.method === 'advance' ? 'used' : 'refund', note: p.reference })) };
  });
}
