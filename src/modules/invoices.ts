import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, gte, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import { bill, charge, course, dayClose, discountAsk, patient, payment, tenant, appUser } from '../db/schema.js';
import type { Tx } from '../db/index.js';
import { route } from '../lib/route.js';
import { emit, todayIn } from '../lib/core.js';
import { HttpError } from '../lib/auth.js';
import { assertDayOpen } from './dayclose.js';
import { dayBounds, gstSummary, nextReceiptNo } from './billing.js';
import { advanceBalance } from './bills.js';

const NONE = '00000000-0000-4000-8000-000000000000';
/** Today has been closed at the desk: no money can be taken or given back until tomorrow. */
export async function dayIsClosed(tx: Tx, t: string, tz: string) {
  return (await tx.select({ id: dayClose.id }).from(dayClose).where(and(eq(dayClose.tenantId, t), eq(dayClose.day, todayIn(tz)))).limit(1)).length > 0;
}
export type BillStatus = 'paid' | 'part' | 'unpaid' | 'waiting' | 'refunded' | 'part_refunded' | 'cancelled';

/** Invoices with their lines and money: billed, discount, paid, due, refunded, and a status, the same everywhere they are shown. */
export async function billViews(tx: Tx, t: string, where: SQL, limit = 200) {
  const bills = await tx.select({ b: bill, name: patient.fullName, phone: patient.phone, no: patient.patientNo }).from(bill).innerJoin(patient, eq(patient.id, bill.patientId))
    .where(and(eq(bill.tenantId, t), where)).orderBy(desc(bill.createdAt)).limit(limit);
  const ids = bills.map((x) => x.b.id);
  const lines = await tx.select().from(charge).where(and(eq(charge.tenantId, t), inArray(charge.billId, ids.length ? ids : [NONE]))).orderBy(charge.createdAt, charge.id);
  const cids = lines.map((c) => c.id);
  const pays = await tx.select().from(payment).where(and(eq(payment.tenantId, t), or(inArray(payment.chargeId, cids.length ? cids : [NONE]), inArray(payment.billId, ids.length ? ids : [NONE]))));
  const asks = await tx.select().from(discountAsk).where(and(eq(discountAsk.tenantId, t), eq(discountAsk.status, 'pending')));
  const waiting = new Map<string, number>(); for (const a of asks) for (const l of a.lines) if (l.chargeId) waiting.set(l.chargeId, (waiting.get(l.chargeId) ?? 0) + l.offPaise);
  return bills.map(({ b, name, phone, no }) => {
    const ls = lines.filter((c) => c.billId === b.id);
    const live = ls.filter((c) => !['cancelled', 'waived'].includes(c.status));
    const onLine = (id: string) => pays.filter((p) => p.chargeId === id);
    // a credit (the line lowered, its extra moved to the patient's advance, method 'advance') takes back what was paid; it is not a refund
    const paid = ls.reduce((s, c) => s + onLine(c.id).filter((p) => p.amountPaise > 0 || p.method === 'advance').reduce((n, p) => n + p.amountPaise, 0), 0);
    const refunded = -ls.reduce((s, c) => s + onLine(c.id).filter((p) => p.amountPaise < 0 && p.method !== 'advance').reduce((n, p) => n + p.amountPaise, 0), 0) // older refunds, on the line
      - pays.filter((p) => p.billId === b.id && !p.chargeId).reduce((n, p) => n + p.amountPaise, 0);
    // due: the amount less every payment on the line. A discount waiting for approval stays owed until it is approved; it is shown beside it.
    const due = live.filter((c) => c.status === 'due').reduce((s, c) => s + Math.max(0, c.amountPaise - onLine(c.id).reduce((n, p) => n + p.amountPaise, 0)), 0);
    const waitingOff = live.reduce((s, c) => s + (waiting.get(c.id) ?? 0), 0);
    const billed = live.reduce((s, c) => s + c.amountPaise, 0); const discount = live.reduce((s, c) => s + c.discountPaise, 0);
    // what is still due comes first: an invoice with money owed is never "Refunded"
    const status: BillStatus = !live.length ? 'cancelled' : due > 0 ? (waitingOff > 0 && due <= waitingOff ? 'waiting' : paid - refunded > 0 ? 'part' : 'unpaid') : refunded > 0 && refunded >= paid ? 'refunded' : refunded > 0 ? 'part_refunded' : 'paid';
    return {
      id: b.id, invoiceNo: b.invoiceNo, createdAt: b.createdAt, patient: { id: b.patientId, fullName: name, phone, patientNo: no },
      items: ls.map((c) => c.description), lines: ls, billedPaise: billed, discountPaise: discount, paidPaise: paid, fromAdvancePaise: ls.reduce((s, c) => s + onLine(c.id).filter((p) => p.method === 'advance' && p.amountPaise > 0).reduce((n, p) => n + p.amountPaise, 0), 0), duePaise: due, refundedPaise: refunded, waitingOffPaise: waitingOff, status,
      pharmacy: ls.some((c) => c.description.startsWith('Pharmacy')), excluded: ls.length > 0 && ls.every((c) => !!c.excludedAt),
      receipts: [...new Set(pays.map((p) => p.receiptNo).filter(Boolean))] as string[],
    };
  });
}

const totals = (bs: Awaited<ReturnType<typeof billViews>>) => ({
  n: bs.filter((b) => b.status !== 'cancelled').length, billedPaise: bs.reduce((s, b) => s + b.billedPaise, 0), paidPaise: bs.reduce((s, b) => s + b.paidPaise, 0), fromAdvancePaise: bs.reduce((s, b) => s + b.fromAdvancePaise, 0), duePaise: bs.reduce((s, b) => s + b.duePaise, 0), refundedPaise: bs.reduce((s, b) => s + b.refundedPaise, 0),
  paidFully: bs.filter((b) => b.status === 'paid').length, withDue: bs.filter((b) => b.duePaise > 0).length, withRefund: bs.filter((b) => b.refundedPaise > 0).length,
});

export function invoiceRoutes(app: FastifyInstance) {
  /** One patient's invoices, newest first, with the totals for the top of the Bills tab. */
  route(app, 'get', '/patients/:id/bills', 'fees.see', async (req, tx) => {
    const bs = await billViews(tx, req.ctx.tenantId, eq(bill.patientId, (req.params as any).id));
    return { bills: bs, totals: totals(bs) };
  });

  /** The patient's account: billed, received, refunded, and what is due or held as advance; then one list of invoices, payments, refunds and credits.
   *  Money moved inside the account (the advance used on an invoice, a credit) has method 'advance' and is never counted as received. */
  route(app, 'get', '/patients/:id/account', 'fees.see', async (req, tx) => {
    const t = req.ctx.tenantId; const pid = (req.params as any).id;
    const bs = await billViews(tx, t, eq(bill.patientId, pid), 500);
    const pays = await tx.select().from(payment).where(and(eq(payment.tenantId, t), eq(payment.patientId, pid))).orderBy(desc(payment.receivedAt)).limit(1000);
    const billOf = new Map<string, string>(); for (const b of bs) for (const c of b.lines) billOf.set(c.id, b.invoiceNo);
    const noOf = new Map(bs.map((b) => [b.id, b.invoiceNo]));
    const real = pays.filter((p) => p.method !== 'advance' && (p.chargeId || p.advance || p.billId)); // money on an invoice or in the advance (sample history rows tied to nothing stay out)
    const fromAdv = new Map<string, number>(); const credit = new Map<string, number>(); // per invoice: what the advance paid, and what went back to the advance (a credit, not money out)
    for (const p of pays) if (p.method === 'advance' && !p.advance && p.chargeId) { const no = billOf.get(p.chargeId); if (!no) continue; const m = p.amountPaise > 0 ? fromAdv : credit; m.set(no, (m.get(no) ?? 0) + Math.abs(p.amountPaise)); }
    const groups = new Map<string, typeof pays>();
    for (const p of real.filter((x) => x.amountPaise > 0)) { const k = p.receiptNo ?? p.id; groups.set(k, [...(groups.get(k) ?? []), p]); }
    const activity = [
      ...bs.map((b) => ({ type: 'invoice' as const, at: b.createdAt, id: b.id, invoiceNo: b.invoiceNo, items: b.items, amountPaise: b.billedPaise, paidPaise: b.paidPaise, duePaise: b.duePaise, refundedPaise: b.refundedPaise, creditPaise: credit.get(b.invoiceNo) ?? 0,
        status: credit.get(b.invoiceNo) && !b.billedPaise ? 'credited' : b.status, fromAdvancePaise: fromAdv.get(b.invoiceNo) ?? 0, waitingOffPaise: b.waitingOffPaise })),
      ...[...groups.values()].map((g) => ({ type: 'payment' as const, at: g[0].receivedAt, id: g[0].id, receiptNo: g[0].receiptNo, methods: [...new Set(g.map((p) => p.method))], reference: g.find((p) => p.reference)?.reference ?? null,
        amountPaise: g.reduce((s, p) => s + p.amountPaise, 0), invoices: [...new Set(g.map((p) => (p.chargeId ? billOf.get(p.chargeId) : undefined)).filter(Boolean))] as string[],
        toAdvancePaise: g.filter((p) => p.advance).reduce((s, p) => s + p.amountPaise, 0) })),
      ...real.filter((p) => p.amountPaise < 0).map((p) => ({ type: 'refund' as const, at: p.receivedAt, id: p.id, methods: [p.method], amountPaise: -p.amountPaise, note: p.reference, receiptNo: p.receiptNo, invoiceNo: p.billId ? noOf.get(p.billId) ?? null : p.chargeId ? billOf.get(p.chargeId) ?? null : null, fromAdvance: p.advance })),
      ...pays.filter((p) => p.method === 'advance' && p.advance && p.amountPaise > 0).map((p) => ({ type: 'credit' as const, at: p.receivedAt, id: p.id, amountPaise: p.amountPaise, note: p.reference })),
    ].sort((a, b) => String(b.at).localeCompare(String(a.at)));
    const received = real.filter((p) => p.amountPaise > 0).reduce((s, p) => s + p.amountPaise, 0);
    const refunded = -real.filter((p) => p.amountPaise < 0).reduce((s, p) => s + p.amountPaise, 0);
    return { totals: { billedPaise: bs.reduce((s, b) => s + b.billedPaise, 0), receivedPaise: received, refundedPaise: refunded, duePaise: bs.reduce((s, b) => s + b.duePaise, 0), waitingOffPaise: bs.reduce((s, b) => s + b.waitingOffPaise, 0), advancePaise: await advanceBalance(tx, t, pid) },
      activity, dayClosed: await dayIsClosed(tx, t, req.ctx.timezone) };
  });

  /** Every invoice in a period (the clinic's billing list), searchable by patient, phone or invoice number. */
  route(app, 'get', '/bills', 'fees.see', async (req, tx) => {
    const q = req.query as any; const tz = req.ctx.timezone; const today = todayIn(tz);
    const from = /^\d{4}-\d{2}-\d{2}$/.test(q.from ?? '') ? q.from : today; const to = /^\d{4}-\d{2}-\d{2}$/.test(q.to ?? '') ? q.to : from;
    const term = String(q.q ?? '').trim().slice(0, 60);
    const like = `%${term.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
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
    const less = (id: string) => -pays.filter(({ p }) => p.chargeId === id && p.amountPaise < 0).reduce((s, { p }) => s + p.amountPaise, 0); // credited or refunded off the line
    // one entry per payment as the patient made it (a payment spread over several lines is one), credits and refunds apart
    const groups = new Map<string, any>();
    for (const { p, by } of pays) {
      const kind = p.amountPaise > 0 ? (p.method === 'advance' ? 'advance' : 'paid') : p.method === 'advance' ? 'credit' : 'refund';
      const k = `${kind}|${p.receiptNo ?? p.receivedAt}|${p.method}`;
      const g = groups.get(k) ?? { at: p.receivedAt, amountPaise: 0, method: p.method, reference: p.reference, lender: p.lender, receiptNo: p.receiptNo, by, refund: kind === 'refund', kind };
      g.amountPaise += p.amountPaise; groups.set(k, g);
    }
    return { ...v, clinic: { name: ten?.name, print: (ten?.settings as any)?.print ?? {}, gstin: (ten?.settings as any)?.gstin ?? null },
      patient: { ...v.patient, ageYears: p?.ageYears, sex: p?.sex },
      rows: v.lines.map((c) => ({ id: c.id, description: c.description, listPaise: c.amountPaise + c.discountPaise + less(c.id), discountPaise: c.discountPaise, lessPaise: less(c.id), discountReason: c.discountReason, taxRateBp: c.taxRateBp, amountPaise: c.amountPaise, status: c.status, reason: c.adjustmentReason, visitId: c.visitId, excludedAt: c.excludedAt })),
      subtotalPaise: live.reduce((s, c) => s + c.amountPaise + c.discountPaise + less(c.id), 0), lessPaise: live.reduce((s, c) => s + less(c.id), 0),
      creditPaise: -pays.filter(({ p }) => p.method === 'advance' && p.amountPaise < 0 && p.chargeId).reduce((s, { p }) => s + p.amountPaise, 0),
      gst: gstSummary((ten?.settings as any)?.gstin, live.map((c) => ({ amountPaise: c.amountPaise, taxRateBp: c.taxRateBp }))),
      gstPaise: live.reduce((s, c) => s + (c.taxRateBp ? c.amountPaise - Math.round((c.amountPaise * 10000) / (10000 + c.taxRateBp)) : 0), 0),
      payments: [...groups.values()] };
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
    // money back for something not given: the refund comes off what was paid on the lines (newest first) and the lines go down by the same,
    // so what is still due stays as it was and billed − received + refunded keeps adding up to the patient's balance
    const receiptNo = await nextReceiptNo(tx, t, req.ctx.timezone);
    const net = new Map<string, number>(); for (const c of v.lines) net.set(c.id, (await tx.select({ n: sql<number>`coalesce(sum(amount_paise),0)::int` }).from(payment).where(eq(payment.chargeId, c.id)))[0]?.n ?? 0);
    const lines = [...v.lines].filter((c) => !['cancelled', 'waived'].includes(c.status)).reverse();
    for (const p of b.parts) {
      let rest = p.amountPaise;
      for (const c of lines) {
        const take = Math.min(rest, net.get(c.id) ?? 0, c.amountPaise); if (take <= 0) continue;
        rest -= take; net.set(c.id, (net.get(c.id) ?? 0) - take); c.amountPaise -= take;
        await tx.insert(payment).values({ tenantId: t, patientId: v.patient.id, chargeId: c.id, amountPaise: -take, method: p.method, reference: `Refund ${v.invoiceNo} · ${b.reason}`.slice(0, 200), receiptNo, receivedBy: req.ctx.userId });
        await tx.update(charge).set({ amountPaise: c.amountPaise, adjustmentReason: `Refunded: ${b.reason}`.slice(0, 200), adjustedBy: req.ctx.userId }).where(eq(charge.id, c.id));
        if (c.courseId) await tx.update(course).set({ totalPaise: sql`greatest(${course.totalPaise} - ${take}, 0)` }).where(eq(course.id, c.courseId)); // not billed again as "the rest"
        if (!rest) break;
      }
      if (rest > 0) await tx.insert(payment).values({ tenantId: t, patientId: v.patient.id, billId: v.id, amountPaise: -rest, method: p.method, reference: `Refund ${v.invoiceNo} · ${b.reason}`.slice(0, 200), receiptNo, receivedBy: req.ctx.userId });
    }
    await emit(tx, req.ctx, 'bill.refunded', 'bill', v.id, { amountPaise: total, reason: b.reason, invoiceNo: v.invoiceNo });
    return { refundedPaise: total, invoiceNo: v.invoiceNo, receiptNo };
  });

  /** The patient's advance: what is left, and every deposit, use and refund. */
  route(app, 'get', '/patients/:id/advance', 'fees.see', async (req, tx) => {
    const t = req.ctx.tenantId; const pid = (req.params as any).id;
    const rows = await tx.select().from(payment).where(and(eq(payment.tenantId, t), eq(payment.patientId, pid), eq(payment.advance, true))).orderBy(desc(payment.receivedAt)).limit(200);
    return { balancePaise: await advanceBalance(tx, t, pid), dayClosed: await dayIsClosed(tx, t, req.ctx.timezone),
      history: rows.map((p) => ({ id: p.id, at: p.receivedAt, amountPaise: p.amountPaise, method: p.method, receiptNo: p.receiptNo, kind: p.amountPaise > 0 ? 'deposit' : p.method === 'advance' ? 'used' : 'refund', note: p.reference })) };
  });
}
