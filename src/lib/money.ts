// The patient's money in one place. Every page that shows "due", "paid", "credited" or "advance" gets it from here.
//
// The rules:
// - An issued invoice line never changes. What comes off it is a credit note (credit_line rows).
// - A payment on a line is money applied to it: positive = paid (by a mode, or from the advance, method 'advance');
//   negative with method 'advance' = taken off the line and put back in the patient's advance (never money out).
// - Money only leaves the clinic from the advance (a refund, a negative advance row with a real mode, with a voucher number).
// - A line's balance = its amount − credited − applied. The patient's balance = Σ balances − advance.
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { charge, creditLine, creditNote, payment } from '../db/schema.js';
import type { Tx } from '../db/index.js';
import type { Ctx } from './auth.js';
import { HttpError } from './auth.js';
import { emit, nextNumber, todayIn } from './core.js';

const NONE = '00000000-0000-4000-8000-000000000000';
const fyOf = (day: string) => { const y = +day.slice(0, 4) - (+day.slice(5, 7) < 4 ? 1 : 0); return `${y}-${String(y + 1).slice(2)}`; };

// The table is named in full: in a select over charge alone drizzle writes bare column names, and inside these subqueries a bare "id" would be the payment's.
/** Credited off a line (SQL, for a select over charge). */
export const chargeCredited = sql<number>`coalesce((select sum(cl.amount_paise) from credit_line cl where cl.charge_id = "charge"."id"), 0)::int`;
/** What is still owed on a charge: its amount less credit notes and every payment on it. The one rule for "due" on every page. */
export const chargeBalance = sql<number>`greatest("charge"."amount_paise" - coalesce((select sum(cl.amount_paise) from credit_line cl where cl.charge_id = "charge"."id"), 0) - coalesce((select sum(p.amount_paise) from payment p where p.charge_id = "charge"."id"), 0), 0)::int`;

/** Per line: credited, and money applied (net). */
export async function lineMoney(tx: Tx, t: string, chargeIds: string[]) {
  const ids = chargeIds.length ? chargeIds : [NONE];
  const cr = await tx.select({ id: creditLine.chargeId, n: sql<number>`sum(${creditLine.amountPaise})::int` }).from(creditLine).where(and(eq(creditLine.tenantId, t), inArray(creditLine.chargeId, ids))).groupBy(creditLine.chargeId);
  const pd = await tx.select({ id: payment.chargeId, n: sql<number>`sum(${payment.amountPaise})::int` }).from(payment).where(and(eq(payment.tenantId, t), inArray(payment.chargeId, ids))).groupBy(payment.chargeId);
  const credited = new Map(cr.map((r) => [r.id, r.n])); const applied = new Map(pd.map((r) => [r.id!, r.n]));
  return { credited: (id: string) => credited.get(id) ?? 0, applied: (id: string) => applied.get(id) ?? 0 };
}

/** What can still be collected on each charge (a discount waiting for approval is not collected). */
export async function balancesOf(tx: Tx, t: string, charges: { id: string; amountPaise: number }[]) {
  const m = await lineMoney(tx, t, charges.map((c) => c.id));
  return new Map(charges.map((c) => [c.id, Math.max(0, c.amountPaise - m.credited(c.id) - m.applied(c.id))]));
}

/** The patient's advance: money in, less what bills used and what was given back. */
export async function advanceBalance(tx: Tx, t: string, patientId: string) {
  const [r] = await tx.select({ n: sql<number>`coalesce(sum(amount_paise),0)::int` }).from(payment).where(and(eq(payment.tenantId, t), eq(payment.patientId, patientId), eq(payment.advance, true)));
  return r?.n ?? 0;
}

/** A charge is paid when nothing is left on it, due otherwise (a cancelled or waived one stays as it is). */
export async function settle(tx: Tx, t: string, chargeIds: string[]) {
  if (!chargeIds.length) return;
  const rows = await tx.select({ id: charge.id, amount: charge.amountPaise, status: charge.status }).from(charge).where(and(eq(charge.tenantId, t), inArray(charge.id, chargeIds)));
  const m = await lineMoney(tx, t, chargeIds);
  for (const r of rows) if (['due', 'paid'].includes(r.status)) {
    const next = r.amount - m.credited(r.id) - m.applied(r.id) > 0 ? 'due' : 'paid';
    if (next !== r.status) await tx.update(charge).set({ status: next }).where(eq(charge.id, r.id));
  }
}

/** Take money applied on a line off it and put it in the patient's advance (no money moves: method 'advance'). */
export async function unapply(tx: Tx, ctx: Ctx, c: { id: string; patientId: string; description: string }, amountPaise: number, note: string) {
  if (amountPaise <= 0) return;
  const base = { tenantId: ctx.tenantId, patientId: c.patientId, method: 'advance', receivedBy: ctx.userId };
  await tx.insert(payment).values({ ...base, chargeId: c.id, amountPaise: -amountPaise, reference: note.slice(0, 200) });
  await tx.insert(payment).values({ ...base, advance: true, amountPaise, reference: `From ${c.description}`.slice(0, 200) });
}

/**
 * A credit note against one invoice: the lines it comes off and how much from each. The invoice itself is not touched.
 * Money already applied above what each line now owes moves to the patient's advance. Returns the note's number and what moved.
 */
type CreditIn = { chargeId: string; amountPaise: number; what: string; sessions?: number; listPaise?: number };
export async function issueCredit(tx: Tx, ctx: Ctx, b: { billId: string; patientId: string; reason: string; lines: CreditIn[] }) {
  const t = ctx.tenantId; const lines = b.lines.filter((l) => l.amountPaise > 0);
  if (!lines.length) return { creditNo: null as string | null, creditId: null as string | null, toAdvancePaise: 0, totalPaise: 0 };
  const charges = await tx.select().from(charge).where(and(eq(charge.tenantId, t), inArray(charge.id, lines.map((l) => l.chargeId))));
  const m = await lineMoney(tx, t, charges.map((c) => c.id));
  for (const l of lines) { // never more than is left of the line
    const c = charges.find((x) => x.id === l.chargeId); if (!c || c.billId !== b.billId) throw new HttpError(400, 'NOT_ON_THIS_INVOICE');
    if (l.amountPaise > c.amountPaise - m.credited(c.id)) throw new HttpError(400, 'MORE_THAN_THE_LINE', { what: c.description });
  }
  const fy = fyOf(todayIn(ctx.timezone));
  const creditNo = `CN-${fy}-${String(await nextNumber(tx, t, 'credit_no', `fy:${fy}`)).padStart(4, '0')}`;
  const totalPaise = lines.reduce((s, l) => s + l.amountPaise, 0);
  const [cn] = await tx.insert(creditNote).values({ tenantId: t, patientId: b.patientId, billId: b.billId, creditNo, reason: b.reason.slice(0, 200), totalPaise, createdBy: ctx.userId }).returning();
  await tx.insert(creditLine).values(lines.map((l) => ({ tenantId: t, creditNoteId: cn.id, chargeId: l.chargeId, amountPaise: l.amountPaise, what: l.what.slice(0, 200), sessions: l.sessions ?? 0, listPaise: l.listPaise ?? 0 })));
  let toAdvancePaise = 0;
  for (const l of lines) {
    const c = charges.find((x) => x.id === l.chargeId)!;
    const over = m.applied(c.id) - (c.amountPaise - m.credited(c.id) - l.amountPaise); // paid above what the line now owes
    if (over > 0) { await unapply(tx, ctx, c, over, `${creditNo}: ${b.reason}`); toAdvancePaise += over; }
  }
  await settle(tx, t, lines.map((l) => l.chargeId));
  await emit(tx, ctx, 'credit.issued', 'credit_note', cn.id, { creditNo, billId: b.billId, totalPaise, toAdvancePaise, reason: b.reason });
  return { creditNo, creditId: cn.id, toAdvancePaise, totalPaise };
}

type Part = { method: string; amountPaise: number; reference?: string | null };

/** Unsettled EMI that has moved off its invoice line into the patient's advance (a credit note or a refund on that line). */
export async function emiInAdvance(tx: Tx, t: string, patientId: string) {
  const rows = await tx.select({ emi: sql<number>`coalesce(sum(case when ${payment.method} = 'emi' and ${payment.settledAt} is null and ${payment.amountPaise} > 0 then ${payment.amountPaise} else 0 end),0)::int`,
    net: sql<number>`coalesce(sum(${payment.amountPaise}),0)::int` }).from(payment)
    .where(and(eq(payment.tenantId, t), eq(payment.patientId, patientId), sql`${payment.chargeId} is not null`)).groupBy(payment.chargeId);
  return rows.reduce((s, r) => s + Math.max(0, r.emi - Math.max(0, r.net)), 0);
}

/** A refund already made with this request key (a retry, a slow network, a second tab): its voucher, so it is not paid twice. */
export async function refundDone(tx: Tx, t: string, key?: string | null) {
  if (!key) return null;
  const [r] = await tx.select({ receiptNo: payment.receiptNo }).from(payment).where(and(eq(payment.tenantId, t), eq(payment.idempotencyKey, `${key}#rf0`)));
  return r ? { receiptNo: r.receiptNo, repeated: true as const } : null;
}

/** Money back to the patient, always from the advance: one refund voucher (its own number series), in one or more modes, with a reason.
 *  With a request key each row carries it, and the unique index on it means the same refund can never be written twice. */
export async function refundFromAdvance(tx: Tx, ctx: Ctx, b: { patientId: string; parts: Part[]; reason: string; billId?: string | null; key?: string | null; creditId?: string | null }) {
  const t = ctx.tenantId; const bal = await advanceBalance(tx, t, b.patientId);
  const amountPaise = b.parts.reduce((s, p) => s + p.amountPaise, 0);
  if (amountPaise > bal) throw new HttpError(400, 'MORE_THAN_THE_ADVANCE', { balancePaise: bal });
  // EMI the lender has not paid yet is not money the clinic holds. On each line paid by such EMI, whatever has left the line (to the advance)
  // beyond the other money on it is that EMI: that much of the advance cannot go back until the lender pays.
  const held = await emiInAdvance(tx, t, b.patientId);
  const free = Math.max(0, bal - held);
  if (amountPaise > free) throw new HttpError(400, 'EMI_NOT_SETTLED', { refundablePaise: free, emiPaise: held });
  const fy = fyOf(todayIn(ctx.timezone));
  const voucherNo = `RF-${fy}-${String(await nextNumber(tx, t, 'refund_no', `fy:${fy}`)).padStart(4, '0')}`;
  const rows = await tx.insert(payment).values(b.parts.map((p) => ({ tenantId: t, patientId: b.patientId, billId: b.billId ?? null, advance: true, amountPaise: -p.amountPaise, method: p.method,
    reference: [p.method === 'cash' ? null : p.reference?.trim(), `Refund: ${b.reason}`].filter(Boolean).join(' · ').slice(0, 200), receiptNo: voucherNo, receivedBy: ctx.userId,
    idempotencyKey: b.key ? `${b.key}#rf${b.parts.indexOf(p)}` : null }))).returning();
  if (b.creditId) await tx.update(creditNote).set({ refundNo: voucherNo }).where(eq(creditNote.id, b.creditId));
  await emit(tx, ctx, 'advance.refunded', 'payment', rows[0].id, { amountPaise, reason: b.reason, patientId: b.patientId, voucherNo, methods: b.parts.map((p) => p.method) });
  return { voucherNo, balancePaise: bal - amountPaise };
}
