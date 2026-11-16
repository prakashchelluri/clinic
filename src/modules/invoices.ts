import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, gte, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import { bill, charge, creditLine, creditNote, dayClose, discountAsk, domainEvent, patient, payment, tenant, appUser } from '../db/schema.js';
import type { Tx } from '../db/index.js';
import { route } from '../lib/route.js';
import { emit, todayIn } from '../lib/core.js';
import { HttpError } from '../lib/auth.js';
import { assertDayOpen } from './dayclose.js';
import { dayBounds, gstSummary } from './billing.js';
import { advanceBalance, emiInAdvance, issueCredit, refundDone, refundFromAdvance, settle, unapply } from '../lib/money.js';

const NONE = '00000000-0000-4000-8000-000000000000';
/** Today has been closed at the desk: no money can be taken or given back until tomorrow. */
export async function dayIsClosed(tx: Tx, t: string, tz: string) {
  return (await tx.select({ id: dayClose.id }).from(dayClose).where(and(eq(dayClose.tenantId, t), eq(dayClose.day, todayIn(tz)))).limit(1)).length > 0;
}
export type BillStatus = 'paid' | 'part' | 'unpaid' | 'waiting' | 'credited' | 'cancelled';

/**
 * Invoices with their money, the same everywhere they are shown. An invoice is as it was issued (its lines never change);
 * credit notes come off it; "paid" is the money applied to it (by a mode or from the advance, less what was moved back to the advance);
 * due = what is left. Money given back is not on the invoice: it leaves from the patient's advance.
 */
export async function billViews(tx: Tx, t: string, where: SQL, limit = 200) {
  const bills = await tx.select({ b: bill, name: patient.fullName, phone: patient.phone, no: patient.patientNo }).from(bill).innerJoin(patient, eq(patient.id, bill.patientId))
    .where(and(eq(bill.tenantId, t), where)).orderBy(desc(bill.createdAt)).limit(limit);
  const ids = bills.map((x) => x.b.id);
  const lines = await tx.select().from(charge).where(and(eq(charge.tenantId, t), inArray(charge.billId, ids.length ? ids : [NONE]))).orderBy(charge.lineNo, charge.createdAt); // in the order entered
  const cids = lines.map((c) => c.id);
  const pays = await tx.select().from(payment).where(and(eq(payment.tenantId, t), inArray(payment.chargeId, cids.length ? cids : [NONE])));
  const credits = await tx.select({ l: creditLine, n: creditNote }).from(creditLine).innerJoin(creditNote, eq(creditNote.id, creditLine.creditNoteId)).where(and(eq(creditLine.tenantId, t), inArray(creditLine.chargeId, cids.length ? cids : [NONE])));
  const asks = await tx.select().from(discountAsk).where(and(eq(discountAsk.tenantId, t), eq(discountAsk.status, 'pending')));
  const waiting = new Map<string, number>(); for (const a of asks) for (const l of a.lines) if (l.chargeId) waiting.set(l.chargeId, (waiting.get(l.chargeId) ?? 0) + l.offPaise);
  return bills.map(({ b, name, phone, no }) => {
    const ls = lines.filter((c) => c.billId === b.id);
    const live = ls.filter((c) => !['cancelled', 'waived'].includes(c.status));
    const on = (id: string) => pays.filter((p) => p.chargeId === id);
    const creditedOn = (id: string) => credits.filter((x) => x.l.chargeId === id).reduce((s, x) => s + x.l.amountPaise, 0);
    const applied = (id: string) => on(id).reduce((s, p) => s + p.amountPaise, 0);
    const billed = live.reduce((s, c) => s + c.amountPaise, 0); const discount = live.reduce((s, c) => s + c.discountPaise, 0);
    const credited = live.reduce((s, c) => s + creditedOn(c.id), 0);
    const paid = live.reduce((s, c) => s + applied(c.id), 0); // the one "paid" figure: net money applied to this invoice
    const movedToAdvance = -live.reduce((s, c) => s + on(c.id).filter((p) => p.amountPaise < 0).reduce((n, p) => n + p.amountPaise, 0), 0);
    const due = live.reduce((s, c) => s + Math.max(0, c.amountPaise - creditedOn(c.id) - applied(c.id)), 0);
    const waitingOff = live.reduce((s, c) => s + (waiting.get(c.id) ?? 0), 0);
    const status: BillStatus = !live.length ? 'cancelled' : due > 0 ? (waitingOff > 0 && due <= waitingOff ? 'waiting' : paid > 0 ? 'part' : 'unpaid') : billed > 0 && credited >= billed ? 'credited' : 'paid';
    const notes = [...new Map(credits.filter((x) => ls.some((c) => c.id === x.l.chargeId)).map((x) => [x.n.id, x.n])).values()].sort((a, z) => a.createdAt.localeCompare(z.createdAt));
    return {
      id: b.id, invoiceNo: b.invoiceNo, createdAt: b.createdAt, taxGstin: b.taxGstin, patient: { id: b.patientId, fullName: name, phone, patientNo: no },
      items: ls.map((c) => c.description), lines: ls, billedPaise: billed, discountPaise: discount, creditedPaise: credited, netPaise: billed - credited, paidPaise: paid,
      fromAdvancePaise: live.reduce((s, c) => s + on(c.id).filter((p) => p.method === 'advance' && p.amountPaise > 0).reduce((n, p) => n + p.amountPaise, 0), 0), movedToAdvancePaise: movedToAdvance,
      duePaise: due, waitingOffPaise: waitingOff, collectablePaise: Math.max(0, due - waitingOff), status,
      creditNotes: notes.map((n) => ({ id: n.id, creditNo: n.creditNo, at: n.createdAt, reason: n.reason, totalPaise: n.totalPaise })),
      creditedOn: Object.fromEntries(ls.map((c) => [c.id, creditedOn(c.id)])),
      paidOn: Object.fromEntries(ls.map((c) => [c.id, applied(c.id)])), // money applied to each line: the most a refund can give back off it
      pharmacy: ls.some((c) => c.description.startsWith('Pharmacy')), excluded: ls.length > 0 && ls.every((c) => !!c.excludedAt),
      receipts: [...new Set(pays.filter((p) => p.amountPaise > 0 && p.method !== 'advance').map((p) => p.receiptNo).filter(Boolean))] as string[],
    };
  });
}

const totals = (bs: Awaited<ReturnType<typeof billViews>>) => ({
  n: bs.filter((b) => b.status !== 'cancelled').length, billedPaise: bs.reduce((s, b) => s + b.billedPaise, 0), creditedPaise: bs.reduce((s, b) => s + b.creditedPaise, 0), paidPaise: bs.reduce((s, b) => s + b.paidPaise, 0),
  fromAdvancePaise: bs.reduce((s, b) => s + b.fromAdvancePaise, 0), duePaise: bs.reduce((s, b) => s + b.duePaise, 0), waitingOffPaise: bs.reduce((s, b) => s + b.waitingOffPaise, 0),
  paidFully: bs.filter((b) => b.status === 'paid').length, withDue: bs.filter((b) => b.duePaise > 0).length, withCredit: bs.filter((b) => b.creditedPaise > 0).length,
});

export function invoiceRoutes(app: FastifyInstance) {
  /** One patient's invoices, newest first, with the totals for the top of the Bills tab. */
  route(app, 'get', '/patients/:id/bills', 'fees.invoices', async (req, tx) => {
    const bs = await billViews(tx, req.ctx.tenantId, eq(bill.patientId, (req.params as any).id), 5000);
    return { bills: bs, totals: totals(bs) };
  });

  /** The patient's account. Billed (invoices less credit notes), received and refunded (real money only), what is due and what is held as advance;
   *  then one list: invoices, payments (one per receipt), credit notes, refunds (vouchers). It always adds up: billed − received + refunded = due − advance. */
  route(app, 'get', '/patients/:id/account', 'fees.invoices', async (req, tx) => {
    const t = req.ctx.tenantId; const pid = (req.params as any).id;
    const bs = await billViews(tx, t, eq(bill.patientId, pid), 5000);
    const pays = await tx.select().from(payment).where(and(eq(payment.tenantId, t), eq(payment.patientId, pid))).orderBy(desc(payment.receivedAt)).limit(1000);
    const billOf = new Map<string, string>(); for (const b of bs) for (const c of b.lines) billOf.set(c.id, b.invoiceNo);
    const noOf = new Map(bs.map((b) => [b.id, b.invoiceNo]));
    const real = pays.filter((p) => p.method !== 'advance' && (p.chargeId || p.advance)); // money handed over or given back (sample history rows tied to nothing stay out)
    const groups = new Map<string, typeof pays>();
    for (const p of real.filter((x) => x.amountPaise > 0)) { const k = p.receiptNo ?? p.id; groups.set(k, [...(groups.get(k) ?? []), p]); }
    const notes = await tx.select().from(creditNote).where(and(eq(creditNote.tenantId, t), eq(creditNote.patientId, pid)));
    const activity = [
      ...bs.map((b) => ({ type: 'invoice' as const, at: b.createdAt, id: b.id, invoiceNo: b.invoiceNo, items: b.items, amountPaise: b.billedPaise, creditedPaise: b.creditedPaise, paidPaise: b.paidPaise,
        duePaise: b.duePaise, collectablePaise: b.collectablePaise, status: b.status, fromAdvancePaise: b.fromAdvancePaise, waitingOffPaise: b.waitingOffPaise, lineCount: b.lines.length, issuedPaise: b.lines.reduce((s, c) => s + c.amountPaise, 0) })),
      ...[...groups.values()].map((g) => ({ type: 'payment' as const, at: g[0].receivedAt, id: g[0].id, receiptNo: g[0].receiptNo,
        modes: [...new Map(g.map((p) => [p.method, { method: p.method, reference: p.reference ?? null }])).values()], methods: [...new Set(g.map((p) => p.method))],
        amountPaise: g.reduce((s, p) => s + p.amountPaise, 0), invoices: [...new Set(g.map((p) => (p.chargeId ? billOf.get(p.chargeId) : undefined)).filter(Boolean))] as string[],
        toAdvancePaise: g.filter((p) => p.advance).reduce((s, p) => s + p.amountPaise, 0) })),
      ...real.filter((p) => p.amountPaise < 0).map((p) => ({ type: 'refund' as const, at: p.receivedAt, id: p.id, methods: [p.method], amountPaise: -p.amountPaise, note: p.reference, receiptNo: p.receiptNo, invoiceNo: p.billId ? noOf.get(p.billId) ?? null : null })),
      // a discount asked for and not given (said no, or its invoice cancelled): kept on the record
      ...(await tx.select().from(discountAsk).where(and(eq(discountAsk.tenantId, t), eq(discountAsk.patientId, pid), inArray(discountAsk.status, ['rejected', 'withdrawn'])))).map((a) => ({ type: 'discount' as const,
        at: a.decidedAt ?? a.createdAt, id: a.id, amountPaise: a.offPaise, note: `${a.status === 'rejected' ? `Not approved by ${a.decidedBy ?? 'the owner'}` : 'Withdrawn: its invoice was cancelled'} · ${a.reason} · asked by ${a.askedBy}`, invoiceNo: null as string | null })),
      ...notes.map((n) => ({ type: 'credit' as const, at: n.createdAt, id: n.id, creditNo: n.creditNo, amountPaise: n.totalPaise, note: n.reason, invoiceNo: noOf.get(n.billId) ?? null })),
    ].sort((a, b) => String(b.at).localeCompare(String(a.at)));
    const received = real.filter((p) => p.amountPaise > 0).reduce((s, p) => s + p.amountPaise, 0);
    const refunded = -real.filter((p) => p.amountPaise < 0).reduce((s, p) => s + p.amountPaise, 0);
    const live = bs.filter((b) => b.status !== 'cancelled');
    return { totals: { billedPaise: live.reduce((s, b) => s + b.netPaise, 0), creditedPaise: live.reduce((s, b) => s + b.creditedPaise, 0), receivedPaise: received, refundedPaise: refunded,
      duePaise: bs.reduce((s, b) => s + b.duePaise, 0), waitingOffPaise: bs.reduce((s, b) => s + b.waitingOffPaise, 0), collectablePaise: bs.reduce((s, b) => s + b.collectablePaise, 0),
      advancePaise: await advanceBalance(tx, t, pid), emiHeldPaise: await emiInAdvance(tx, t, pid), invoices: live.length },
      activity, dayClosed: await dayIsClosed(tx, t, req.ctx.timezone) };
  });

  /** Every invoice in a period (the clinic's billing list), searchable by patient, phone or invoice number. */
  route(app, 'get', '/bills', 'fees.invoices', async (req, tx) => {
    const q = req.query as any; const tz = req.ctx.timezone; const today = todayIn(tz);
    const from = /^\d{4}-\d{2}-\d{2}$/.test(q.from ?? '') ? q.from : today; const to = /^\d{4}-\d{2}-\d{2}$/.test(q.to ?? '') ? q.to : from;
    const term = String(q.q ?? '').trim().slice(0, 60);
    const like = `%${term.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    const where = and(gte(bill.createdAt, dayBounds(from, tz).start), lt(bill.createdAt, dayBounds(to, tz).end),
      term ? or(sql`${bill.invoiceNo} ilike ${like}`, sql`${patient.fullName} ilike ${like}`, sql`${patient.phone} ilike ${like}`) : undefined)!;
    const bs = await billViews(tx, req.ctx.tenantId, where, 20000); // the totals are for every invoice in the dates; the list shows the newest 500
    return { from, to, bills: bs.slice(0, 500), count: bs.length, totals: totals(bs) };
  });

  /** One invoice as it prints: as it was issued (lines, discount, GST at the GSTIN of that day), then its credit notes and the money applied to it. */
  route(app, 'get', '/bills/:id', 'fees.invoices', async (req, tx) => {
    const t = req.ctx.tenantId;
    const [v] = await billViews(tx, t, eq(bill.id, (req.params as any).id), 1);
    if (!v) throw new HttpError(404, 'NOT_FOUND');
    const p = await tx.select().from(patient).where(eq(patient.id, v.patient.id)).then((r) => r[0]);
    const ten = await tx.select().from(tenant).where(eq(tenant.id, t)).then((r) => r[0]);
    const cids = v.lines.map((c) => c.id);
    const pays = await tx.select({ p: payment, by: appUser.name }).from(payment).leftJoin(appUser, eq(appUser.id, payment.receivedBy))
      .where(and(eq(payment.tenantId, t), inArray(payment.chargeId, cids.length ? cids : [NONE]))).orderBy(payment.receivedAt);
    const live = v.lines.filter((c) => !['cancelled', 'waived'].includes(c.status));
    // one entry per payment as the patient made it (spread over several lines, it is still one); a move to the advance on its own line
    const groups = new Map<string, any>();
    for (const { p, by } of pays) {
      const kind = p.amountPaise > 0 ? (p.method === 'advance' ? 'advance' : 'paid') : 'moved';
      const k = `${kind}|${p.receiptNo ?? p.receivedAt.slice(0, 16)}|${p.method}|${kind === "moved" ? p.reference : ""}`; // each move to the advance on its own line, with why
      const g = groups.get(k) ?? { at: p.receivedAt, amountPaise: 0, method: p.method, reference: p.reference, lender: p.lender, receiptNo: p.receiptNo, by, kind };
      g.amountPaise += p.amountPaise; groups.set(k, g);
    }
    const gstin = v.taxGstin; // as issued: a later change to the clinic's GSTIN does not change this invoice
    return { ...v, clinic: { name: ten?.name, print: (ten?.settings as any)?.print ?? {}, gstin },
      patient: { ...v.patient, ageYears: p?.ageYears, sex: p?.sex },
      rows: v.lines.map((c) => ({ id: c.id, description: c.description, listPaise: c.amountPaise + c.discountPaise, discountPaise: c.discountPaise, creditedPaise: v.creditedOn[c.id] ?? 0, discountReason: c.discountReason, taxRateBp: c.taxRateBp, amountPaise: c.amountPaise, status: c.status, reason: c.adjustmentReason, visitId: c.visitId, excludedAt: c.excludedAt, sessions: c.sessions, courseId: c.courseId, lineNo: c.lineNo })),
      subtotalPaise: live.reduce((s, c) => s + c.amountPaise + c.discountPaise, 0),
      gst: gstSummary(gstin, live.map((c) => ({ amountPaise: c.amountPaise, taxRateBp: c.taxRateBp }))),
      gstPaise: gstin ? live.reduce((s, c) => s + (c.taxRateBp ? c.amountPaise - Math.round((c.amountPaise * 10000) / (10000 + c.taxRateBp)) : 0), 0) : 0,
      payments: [...groups.values()],
      // money given back on this invoice: the refund vouchers (it left from the advance, so it is not a payment on the invoice)
      refunds: Object.values((await tx.select().from(payment).where(and(eq(payment.tenantId, t), eq(payment.billId, v.id), eq(payment.advance, true), sql`${payment.amountPaise} < 0`, sql`${payment.method} <> 'advance'`)))
        .reduce((m: Record<string, any>, p) => { const k = p.receiptNo ?? p.id; const g = m[k] ?? { voucherNo: p.receiptNo, at: p.receivedAt, amountPaise: 0, methods: [] as string[] }; g.amountPaise -= p.amountPaise; if (!g.methods.includes(p.method)) g.methods.push(p.method); m[k] = g; return m; }, {})) };
  });

  /** A credit note as it prints: what it comes off, how much, why, and where the money went. */
  route(app, 'get', '/credit-notes/:id', 'fees.invoices', async (req, tx) => {
    const t = req.ctx.tenantId;
    const n = await tx.select().from(creditNote).where(and(eq(creditNote.id, (req.params as any).id), eq(creditNote.tenantId, t))).then((r) => r[0]);
    if (!n) throw new HttpError(404, 'NOT_FOUND');
    const ls = await tx.select({ l: creditLine, rate: charge.taxRateBp }).from(creditLine).innerJoin(charge, eq(charge.id, creditLine.chargeId)).where(eq(creditLine.creditNoteId, n.id)).orderBy(charge.lineNo);
    const b = await tx.select().from(bill).where(eq(bill.id, n.billId)).then((r) => r[0]);
    const p = await tx.select().from(patient).where(eq(patient.id, n.patientId)).then((r) => r[0]);
    const ten = await tx.select().from(tenant).where(eq(tenant.id, t)).then((r) => r[0]);
    const moved = await tx.select({ n: sql<number>`coalesce(sum(${payment.amountPaise}),0)::int` }).from(payment).where(and(eq(payment.tenantId, t), sql`${payment.reference} like ${n.creditNo + ':%'}`, eq(payment.advance, false)));
    const refunded = n.refundNo ? await tx.select({ n: sql<number>`coalesce(-sum(${payment.amountPaise}),0)::int` }).from(payment).where(and(eq(payment.tenantId, t), eq(payment.receiptNo, n.refundNo))).then((r) => r[0]?.n ?? 0) : 0;
    const gstin = b?.taxGstin ?? null; // the GST of the invoice it comes off: reversed at the same rates
    return { ...n, invoiceNo: b?.invoiceNo, invoiceAt: b?.createdAt, lines: ls.map(({ l, rate }) => ({ chargeId: l.chargeId, what: l.what, amountPaise: l.amountPaise, taxRateBp: rate, sessions: l.sessions })),
      gst: gstSummary(gstin, ls.map(({ l, rate }) => ({ amountPaise: l.amountPaise, taxRateBp: rate }))), toAdvancePaise: -(moved[0]?.n ?? 0), refundedPaise: refunded,
      patient: { fullName: p?.fullName, patientNo: p?.patientNo, phone: p?.phone }, clinic: { name: ten?.name, print: (ten?.settings as any)?.print ?? {}, gstin } };
  });

  /**
   * Take items off an invoice, for something not given: a credit note and no money handed over. What was already paid on those items
   * moves to the patient's advance (to use on the next bill, or give back with Refund). The day need not be open: no money moves.
   */
  route(app, 'post', '/bills/:id/credit', 'payment.refund', async (req, tx) => {
    const b = z.object({ reason: z.string().trim().min(3, 'Say why').max(200), idempotencyKey: z.string().min(8).max(80).optional(),
      lines: z.array(z.object({ chargeId: z.string().uuid(), amountPaise: z.number().int().positive().max(100_000_000) })).min(1).max(20) }).parse(req.body);
    const t = req.ctx.tenantId;
    if (b.idempotencyKey) { const [d] = await tx.select({ p: domainEvent.payload }).from(domainEvent).where(and(eq(domainEvent.tenantId, t), eq(domainEvent.type, 'bill.credited'), sql`${domainEvent.payload}->>'key' = ${b.idempotencyKey}`)).limit(1);
      if (d) return { ...(d.p as any), repeated: true }; }
    const [v] = await billViews(tx, t, eq(bill.id, (req.params as any).id), 1);
    if (!v) throw new HttpError(404, 'NOT_FOUND');
    const live = v.lines.filter((c) => !['cancelled', 'waived'].includes(c.status));
    const lines = b.lines.map((l) => { const c = live.find((x) => x.id === l.chargeId); if (!c) throw new HttpError(400, 'NOT_ON_THIS_INVOICE');
      const left = c.amountPaise - (v.creditedOn[c.id] ?? 0); if (l.amountPaise > left) throw new HttpError(400, 'MORE_THAN_THE_LINE', { what: c.description, leftPaise: left });
      return { chargeId: c.id, amountPaise: l.amountPaise, what: c.description }; });
    const r = await issueCredit(tx, req.ctx, { billId: v.id, patientId: v.patient.id, reason: `Not given: ${b.reason}`, lines });
    const out = { key: b.idempotencyKey ?? null, creditNo: r.creditNo, creditId: r.creditId, creditedPaise: r.totalPaise, toAdvancePaise: r.toAdvancePaise, invoiceNo: v.invoiceNo };
    await emit(tx, req.ctx, 'bill.credited', 'bill', v.id, out);
    return { ...out, repeated: false };
  });

  /**
   * Money back on an invoice. It always leaves from the patient's advance, with a voucher, and only money that was paid on the items named:
   * a refund never takes a payment off one item to give back for another. With "take it off the invoice" (the usual case) a credit note takes
   * the same amount off those items, so what is still due stays as it was; without, the invoice is unchanged and that much is due again.
   * A request key makes a retry return the first refund.
   */
  route(app, 'post', '/bills/:id/refund', 'payment.refund', async (req, tx) => {
    const b0 = z.object({ parts: z.array(z.object({ method: z.enum(['cash', 'upi', 'card', 'bank']), amountPaise: z.number().int().positive().max(100_000_000), reference: z.string().trim().max(60).optional() })).min(1).max(4),
      reason: z.string().trim().min(3, 'Say why').max(200), lower: z.boolean().default(true), idempotencyKey: z.string().min(8).max(80).optional(),
      lines: z.array(z.object({ chargeId: z.string().uuid(), amountPaise: z.number().int().positive().max(100_000_000) })).max(20).optional() }).parse(req.body);
    const b = { ...b0, amountPaise: b0.parts.reduce((s, p) => s + p.amountPaise, 0) };
    const t = req.ctx.tenantId;
    const done = await refundDone(tx, t, b.idempotencyKey); if (done) return { ...done, refundedPaise: b.amountPaise };
    const [v] = await billViews(tx, t, eq(bill.id, (req.params as any).id), 1);
    if (!v) throw new HttpError(404, 'NOT_FOUND');
    await assertDayOpen(tx, req.ctx); // the money leaves today
    if (b.amountPaise > v.paidPaise) throw new HttpError(400, 'MORE_THAN_PAID', { refundablePaise: v.paidPaise });
    const live = v.lines.filter((c) => !['cancelled', 'waived'].includes(c.status));
    // the items it comes off (an invoice of one item needs no naming); each gives back at most what was paid on it
    const named = b.lines ?? (live.length === 1 ? [{ chargeId: live[0].id, amountPaise: b.amountPaise }] : null);
    if (!named) throw new HttpError(400, 'SAY_WHICH_ITEM');
    if (named.reduce((s, l) => s + l.amountPaise, 0) !== b.amountPaise) throw new HttpError(400, 'ITEMS_DO_NOT_ADD_UP', { amountPaise: b.amountPaise });
    const items = named.map((l) => { const c = live.find((x) => x.id === l.chargeId); if (!c) throw new HttpError(400, 'NOT_ON_THIS_INVOICE');
      const paid = v.paidOn[c.id] ?? 0; if (l.amountPaise > paid) throw new HttpError(400, 'MORE_THAN_PAID_ON_THE_ITEM', { what: c.description, paidPaise: paid });
      const left = c.amountPaise - (v.creditedOn[c.id] ?? 0); if (b.lower && l.amountPaise > left) throw new HttpError(400, 'MORE_THAN_THE_LINE', { what: c.description, leftPaise: left });
      return { c, amountPaise: l.amountPaise }; });
    let creditNo: string | null = null; let creditId: string | null = null;
    const movedBefore = new Map<string, number>();
    if (b.lower) {
      const r = await issueCredit(tx, req.ctx, { billId: v.id, patientId: v.patient.id, reason: `Refunded: ${b.reason}`, lines: items.map((i) => ({ chargeId: i.c.id, amountPaise: i.amountPaise, what: i.c.description })) });
      creditNo = r.creditNo; creditId = r.creditId;
    }
    // each item's money into the advance, as much as is being given back off it (the credit note may already have moved some)
    const nowPaid = await tx.select({ id: payment.chargeId, n: sql<number>`sum(${payment.amountPaise})::int` }).from(payment).where(and(eq(payment.tenantId, t), inArray(payment.chargeId, items.map((i) => i.c.id)))).groupBy(payment.chargeId);
    for (const i of items) {
      const already = (v.paidOn[i.c.id] ?? 0) - (nowPaid.find((x) => x.id === i.c.id)?.n ?? 0); // moved by the credit note
      const take = Math.max(0, i.amountPaise - already); movedBefore.set(i.c.id, already);
      if (take > 0) await unapply(tx, req.ctx, i.c, take, `Refund on ${v.invoiceNo}: ${b.reason}`);
    }
    const out = await refundFromAdvance(tx, req.ctx, { patientId: v.patient.id, billId: v.id, parts: b.parts, reason: `${v.invoiceNo} · ${b.reason}`, key: b.idempotencyKey, creditId });
    await settle(tx, t, live.map((c) => c.id));
    await emit(tx, req.ctx, 'bill.refunded', 'bill', v.id, { amountPaise: b.amountPaise, reason: b.reason, invoiceNo: v.invoiceNo, creditNo, voucherNo: out.voucherNo });
    return { refundedPaise: b.amountPaise, invoiceNo: v.invoiceNo, creditNo, receiptNo: out.voucherNo };
  });

  /**
   * GST for a period, for the accountant (GSTR-1 style): every Tax Invoice issued, by rate (taxable value, CGST, SGST), less the credit notes
   * issued against Tax Invoices in the period, at the same rates; exempt (0%) supplies; Bills of Supply (issued with no GSTIN); and the invoices
   * the owner left out, with why. Each document counts at the GSTIN and rates it was issued with.
   */
  route(app, 'get', '/reports/gst', 'finance.read', async (req, tx) => {
    const q = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(req.query);
    const t = req.ctx.tenantId; const tz = req.ctx.timezone; const start = dayBounds(q.from, tz).start; const end = dayBounds(q.to, tz).end;
    const bs = await billViews(tx, t, and(gte(bill.createdAt, start), lt(bill.createdAt, end))!, 20000);
    const live = (b: any) => b.lines.filter((c: any) => !['cancelled', 'waived'].includes(c.status));
    const taxed = bs.filter((b) => b.taxGstin && b.status !== 'cancelled'); const supply = bs.filter((b) => !b.taxGstin && b.status !== 'cancelled');
    const included = taxed.filter((b) => !b.excluded); const left = taxed.filter((b) => b.excluded);
    const notes = await tx.select({ n: creditNote, l: creditLine, rate: charge.taxRateBp, gstin: bill.taxGstin, invoiceNo: bill.invoiceNo, excludedAt: charge.excludedAt }).from(creditNote)
      .innerJoin(creditLine, eq(creditLine.creditNoteId, creditNote.id)).innerJoin(charge, eq(charge.id, creditLine.chargeId)).innerJoin(bill, eq(bill.id, creditNote.billId))
      .where(and(eq(creditNote.tenantId, t), gte(creditNote.createdAt, start), lt(creditNote.createdAt, end)));
    const taxedNotes = notes.filter((x) => x.gstin && !x.excludedAt);
    const rows = (lines: { amountPaise: number; taxRateBp: number }[]) => gstSummary('x', lines).rates;
    const add = (into: Map<number, any>, rs: any[], sign: number) => { for (const r of rs) { const m = into.get(r.rateBp) ?? { rateBp: r.rateBp, taxablePaise: 0, cgstPaise: 0, sgstPaise: 0 }; m.taxablePaise += sign * r.taxablePaise; m.cgstPaise += sign * r.cgstPaise; m.sgstPaise += sign * r.sgstPaise; into.set(r.rateBp, m); } };
    const net = new Map<number, any>();
    const invoices = included.map((b) => { const rs = rows(live(b).map((c: any) => ({ amountPaise: c.amountPaise, taxRateBp: c.taxRateBp }))); add(net, rs, 1);
      return { id: b.id, invoiceNo: b.invoiceNo, at: b.createdAt, patient: b.patient.fullName, gstin: b.taxGstin, totalPaise: b.billedPaise, rates: rs }; });
    const byNote = new Map<string, any>();
    for (const x of taxedNotes) { const k = x.n.id; const e = byNote.get(k) ?? { id: k, creditNo: x.n.creditNo, at: x.n.createdAt, invoiceNo: x.invoiceNo, reason: x.n.reason, totalPaise: 0, lines: [] as any[] }; e.totalPaise += x.l.amountPaise; e.lines.push({ amountPaise: x.l.amountPaise, taxRateBp: x.rate }); byNote.set(k, e); }
    const credits = [...byNote.values()].map((e) => { const rs = rows(e.lines); add(net, rs, -1); const { lines, ...rest } = e; return { ...rest, rates: rs }; });
    const summary = [...net.values()].sort((a, b) => a.rateBp - b.rateBp);
    return { from: q.from, to: q.to, summary, totals: { taxablePaise: summary.filter((r) => r.rateBp).reduce((s, r) => s + r.taxablePaise, 0), exemptPaise: summary.filter((r) => !r.rateBp).reduce((s, r) => s + r.taxablePaise, 0),
        cgstPaise: summary.reduce((s, r) => s + r.cgstPaise, 0), sgstPaise: summary.reduce((s, r) => s + r.sgstPaise, 0) },
      invoices, credits, billsOfSupply: { count: supply.length, totalPaise: supply.reduce((s, b) => s + b.netPaise, 0), creditedPaise: supply.reduce((s, b) => s + b.creditedPaise, 0) },
      leftOut: left.map((b) => ({ id: b.id, invoiceNo: b.invoiceNo, at: b.createdAt, patient: b.patient.fullName, totalPaise: b.billedPaise, reason: b.lines.find((c: any) => c.excludedReason)?.excludedReason ?? null })) };
  });

  /** The patient's advance: what is left, and every deposit, use and refund. */
  route(app, 'get', '/patients/:id/advance', 'fees.invoices', async (req, tx) => {
    const t = req.ctx.tenantId; const pid = (req.params as any).id;
    const rows = await tx.select().from(payment).where(and(eq(payment.tenantId, t), eq(payment.patientId, pid), eq(payment.advance, true))).orderBy(desc(payment.receivedAt)).limit(200);
    return { balancePaise: await advanceBalance(tx, t, pid), dayClosed: await dayIsClosed(tx, t, req.ctx.timezone),
      history: rows.map((p) => ({ id: p.id, at: p.receivedAt, amountPaise: p.amountPaise, method: p.method, receiptNo: p.receiptNo, kind: p.amountPaise > 0 ? 'deposit' : p.method === 'advance' ? 'used' : 'refund', note: p.reference })) };
  });
}
