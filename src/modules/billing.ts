import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, sql, gte, lt, lte, desc, isNull, inArray } from 'drizzle-orm';
import { charge, payment, expense, visit, feeCategory, patient, tenant, appUser } from '../db/schema.js';
import { route } from '../lib/route.js';
import { emit, sent, todayIn, addDays, nextNumber } from '../lib/core.js';
import { HttpError, can } from '../lib/auth.js';
import { assertDayOpen, dayFigures } from './dayclose.js';

/** [start,end) in UTC for a local day in the tenant timezone. */
export function dayBounds(day: string, tz: string) {
  const probe = new Date(day + 'T12:00:00Z');
  // the clock in tz at the probe, read as parts (parsing a locale string would use the server's own time zone and shift the day)
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(probe).map((x) => [x.type, x.value]));
  const offsetMs = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - probe.getTime();
  const start = new Date(Date.parse(day + 'T00:00:00Z') - offsetMs);
  return { start: start.toISOString(), end: new Date(start.getTime() + 86400000).toISOString() };
}

/** Indian financial year of a local day: April to March, e.g. 2026-11-11 → "2026-27". */
export const fyOf = (day: string) => { const y = +day.slice(0, 4) - (+day.slice(5, 7) < 4 ? 1 : 0); return `${y}-${String(y + 1).slice(2)}`; };
/** Next receipt number: one unbroken series per clinic per financial year, R-2026-27-0001. */
export async function nextReceiptNo(tx: any, tenantId: string, tz: string) {
  const fy = fyOf(todayIn(tz));
  return `R-${fy}-${String(await nextNumber(tx, tenantId, 'receipt_no', `fy:${fy}`)).padStart(4, '0')}`;
}

/** GST on what a receipt covers (prices include tax). With a GSTIN: a Tax Invoice with CGST/SGST per rate. Without: a Bill of Supply and no tax lines. */
export function gstSummary(gstin: string | null | undefined, lines: { amountPaise: number; taxRateBp: number }[]) {
  if (!gstin) return { gstin: null, title: 'Bill of Supply', rates: [] as { rateBp: number; taxablePaise: number; cgstPaise: number; sgstPaise: number }[] };
  const by = new Map<number, number>();
  for (const l of lines) by.set(l.taxRateBp, (by.get(l.taxRateBp) ?? 0) + l.amountPaise);
  const rates = [...by].sort((a, b) => a[0] - b[0]).map(([rateBp, gross]) => {
    const taxablePaise = Math.round((gross * 10000) / (10000 + rateBp)); const tax = gross - taxablePaise; const cgstPaise = Math.floor(tax / 2);
    return { rateBp, taxablePaise, cgstPaise, sgstPaise: tax - cgstPaise };
  });
  return { gstin, title: 'Tax Invoice', rates };
}

export function billingRoutes(app: FastifyInstance) {
  route(app, 'post', '/payments', 'payment.record', async (req, tx) => {
    const body = z.object({ patientId: z.string().uuid(), chargeId: z.string().uuid().optional(), amountPaise: z.number().int().positive(),
      method: z.enum(['cash', 'upi', 'card', 'bank', 'emi']), reference: z.string().optional(), lender: z.string().trim().max(60).optional(), idempotencyKey: z.string().optional() }).parse(req.body);
    const t = req.ctx.tenantId; await assertDayOpen(tx, req.ctx);
    if (body.method === 'emi' && (!body.lender || !body.reference)) throw new HttpError(400, 'EMI_NEEDS_LENDER_AND_APPROVAL_CODE');
    if (body.idempotencyKey) {
      const dup = await tx.select().from(payment).where(and(eq(payment.tenantId, t), eq(payment.idempotencyKey, body.idempotencyKey))).then((r) => r[0]);
      if (dup) return dup;
    }
    // Against a charge: never more than is still due on it (a double tap or a typo must not take the money twice).
    const ch = body.chargeId ? await tx.select().from(charge).where(and(eq(charge.id, body.chargeId), eq(charge.tenantId, t))).then((r) => r[0]) : undefined;
    if (body.chargeId && !ch) throw new HttpError(404, 'CHARGE_NOT_FOUND');
    if (ch) {
      const [{ paid }] = await tx.select({ paid: sql<number>`coalesce(sum(amount_paise),0)::int` }).from(payment).where(eq(payment.chargeId, ch.id));
      const duePaise = ch.status === 'due' ? Math.max(0, ch.amountPaise - paid) : 0;
      if (body.amountPaise > duePaise) throw new HttpError(400, 'MORE_THAN_DUE', { duePaise });
    }
    const [row] = await tx.insert(payment).values({ ...body, tenantId: t, receiptNo: await nextReceiptNo(tx, t, req.ctx.timezone), receivedBy: req.ctx.userId }).returning();
    if (ch) {
      const [{ paid }] = await tx.select({ paid: sql<number>`coalesce(sum(amount_paise),0)::int` }).from(payment).where(eq(payment.chargeId, ch.id));
      if (paid >= ch.amountPaise) await tx.update(charge).set({ status: 'paid' }).where(eq(charge.id, ch.id));
    }
    await emit(tx, req.ctx, 'payment.recorded', 'payment', row.id, { amountPaise: body.amountPaise, method: body.method, chargeId: body.chargeId });
    return row;
  });

  /** Waive or refund a charge; the row is kept, status + reason change, event recorded. */
  route(app, 'post', '/charges/:id/adjust', 'payment.waive', async (req, tx) => {
    const body = z.object({ kind: z.enum(['waived', 'refunded']), reason: z.string().trim().min(3, 'Say why').max(200) }).parse(req.body);
    if (body.kind === 'refunded' && !can(req.perms, 'payment.refund')) throw new HttpError(403, 'FORBIDDEN:payment.refund');
    const t = req.ctx.tenantId; const id = (req.params as any).id;
    const cur = await tx.select().from(charge).where(and(eq(charge.id, id), eq(charge.tenantId, t))).then((r) => r[0]);
    if (!cur) throw new HttpError(404, 'NOT_FOUND');
    if (cur.status === 'refunded') throw new HttpError(409, 'ALREADY_REFUNDED');
    if (body.kind === 'refunded') {
      // ponytail: a refund is money going out today, so it is written as negative payment rows (one per original payment, same mode),
      // the way course refunds already are. End of day, the daily report and the history totals then net it out with no extra rule.
      // A schema-level refund table is the upgrade if partial refunds or a different refund mode are ever needed.
      const pays = await tx.select().from(payment).where(and(eq(payment.tenantId, t), eq(payment.chargeId, id)));
      const net = pays.reduce((s, p) => s + p.amountPaise, 0);
      if (net > 0) {
        await assertDayOpen(tx, req.ctx); // the money leaves today, so today must still be open
        let seq = 0;
        for (const p of pays.filter((x) => x.amountPaise > 0)) await tx.insert(payment).values({ tenantId: t, patientId: p.patientId, chargeId: id, amountPaise: -p.amountPaise, method: p.method, reference: `Refund · ${body.reason}`.slice(0, 200), receivedBy: req.ctx.userId, idempotencyKey: `refund:${id}#${seq++}` });
      }
    }
    const [row] = await tx.update(charge).set({ status: body.kind, adjustmentReason: body.reason, adjustedBy: req.ctx.userId }).where(eq(charge.id, id)).returning();
    await emit(tx, req.ctx, `charge.${body.kind}`, 'charge', row.id, { reason: body.reason, amountPaise: row.amountPaise });
    return row;
  });

  /** One payment, several invoices, several modes. The parts are laid against the oldest unpaid charges first; EMI counts as paid on the lender's approval and then waits for settlement. */
  route(app, 'post', '/payments/take', 'payment.record', async (req, tx) => {
    const body = z.object({ patientId: z.string().uuid(), chargeIds: z.array(z.string().uuid()).min(1).max(20), idempotencyKey: z.string().min(8),
      parts: z.array(z.object({ method: z.enum(['cash', 'upi', 'card', 'bank', 'emi']), amountPaise: z.number().int().positive(), reference: z.string().trim().max(60).optional(), lender: z.string().trim().max(60).optional() })).min(1).max(6) }).parse(req.body);
    const t = req.ctx.tenantId; await assertDayOpen(tx, req.ctx);
    const done = await tx.select().from(payment).where(and(eq(payment.tenantId, t), sql`${payment.idempotencyKey} like ${body.idempotencyKey + '#%'}`));
    if (done.length) return { payments: done, repeated: true };
    for (const p of body.parts) if (p.method === 'emi' && (!p.lender || !p.reference)) throw new HttpError(400, 'EMI_NEEDS_LENDER_AND_APPROVAL_CODE');
    const charges = (await tx.select().from(charge).where(and(eq(charge.tenantId, t), eq(charge.patientId, body.patientId), inArray(charge.id, body.chargeIds), eq(charge.status, 'due'))).orderBy(charge.createdAt));
    if (charges.length !== new Set(body.chargeIds).size) throw new HttpError(404, 'CHARGE_NOT_FOUND');
    const paid = await tx.select({ id: payment.chargeId, n: sql<number>`coalesce(sum(amount_paise),0)::int` }).from(payment).where(and(eq(payment.tenantId, t), inArray(payment.chargeId, charges.map((c) => c.id)))).groupBy(payment.chargeId);
    const left = new Map(charges.map((c) => [c.id, c.amountPaise - (paid.find((p) => p.id === c.id)?.n ?? 0)]));
    const total = body.parts.reduce((s, p) => s + p.amountPaise, 0); const owed = [...left.values()].reduce((s, n) => s + n, 0);
    if (total > owed) throw new HttpError(400, 'MORE_THAN_DUE', { duePaise: owed });
    const receiptNo = await nextReceiptNo(tx, t, req.ctx.timezone);
    const rows: any[] = []; let seq = 0;
    for (const part of body.parts) {
      let rest = part.amountPaise;
      for (const c of charges) {
        const room = left.get(c.id) ?? 0; if (!rest) break; if (!room) continue;
        const take = Math.min(rest, room); rest -= take; left.set(c.id, room - take);
        const [row] = await tx.insert(payment).values({ tenantId: t, patientId: body.patientId, chargeId: c.id, amountPaise: take, method: part.method, reference: part.reference ?? null, lender: part.lender ?? null, receiptNo, receivedBy: req.ctx.userId, idempotencyKey: `${body.idempotencyKey}#${seq++}` }).returning();
        rows.push(row);
      }
    }
    for (const c of charges) if ((left.get(c.id) ?? 1) === 0) await tx.update(charge).set({ status: 'paid' }).where(eq(charge.id, c.id));
    await emit(tx, req.ctx, 'payment.recorded', 'payment', rows[0].id, { amountPaise: total, methods: body.parts.map((p) => p.method), charges: charges.length });
    return { payments: rows, repeated: false, receiptNo, balancePaise: owed - total };
  });

  /** The lender's money reached the bank: record when, and what they kept (that fee is booked as an expense). */
  route(app, 'post', '/payments/:id/settle', 'payment.record', async (req, tx) => {
    const b = z.object({ feePaise: z.number().int().min(0).max(10_000_000).default(0), reference: z.string().trim().max(60).optional() }).parse(req.body);
    const t = req.ctx.tenantId; const id = (req.params as any).id;
    const p = await tx.select().from(payment).where(and(eq(payment.id, id), eq(payment.tenantId, t))).then((r) => r[0]);
    if (!p) throw new HttpError(404, 'NOT_FOUND');
    if (p.method !== 'emi') throw new HttpError(409, 'NOT_EMI');
    if (p.settledAt) throw new HttpError(409, 'ALREADY_SETTLED');
    // one approval can be laid against several invoices: settle them together
    const group = await tx.select().from(payment).where(and(eq(payment.tenantId, t), eq(payment.patientId, p.patientId), eq(payment.method, 'emi'), eq(payment.reference, p.reference ?? ''), isNull(payment.settledAt)));
    const total = group.reduce((s, x) => s + x.amountPaise, 0);
    if (b.feePaise > total) throw new HttpError(400, 'FEE_MORE_THAN_PAYMENT');
    const now = new Date().toISOString();
    const [row] = await tx.update(payment).set({ settledAt: now, feePaise: b.feePaise, reference: b.reference ? `${p.reference} · bank ${b.reference}` : p.reference }).where(eq(payment.id, id)).returning();
    await tx.update(payment).set({ settledAt: now, feePaise: 0 }).where(inArray(payment.id, group.filter((x) => x.id !== id).map((x) => x.id).concat('00000000-0000-4000-8000-000000000000')));
    if (b.feePaise > 0) await tx.insert(expense).values({ tenantId: t, day: todayIn(req.ctx.timezone), description: `EMI fee · ${p.lender ?? 'lender'} · ${p.reference ?? ''}`.trim(), amountPaise: b.feePaise, method: 'bank', category: 'Taxes and fees', enteredBy: req.ctx.userId });
    await emit(tx, req.ctx, 'payment.settled', 'payment', id, { feePaise: b.feePaise });
    return row;
  });

  route(app, 'get', '/payments/awaiting', 'payment.record', async (req, tx) => {
    const rows = await tx.select({ pay: payment, patient: patient.fullName }).from(payment).innerJoin(patient, eq(patient.id, payment.patientId))
      .where(and(eq(payment.tenantId, req.ctx.tenantId), eq(payment.method, 'emi'), isNull(payment.settledAt))).orderBy(payment.receivedAt);
    // one line per approval, even when it paid two invoices
    const byCode = new Map<string, any>();
    for (const r of rows) { const k = r.pay.patientId + '|' + r.pay.reference; const cur = byCode.get(k); if (cur) cur.amountPaise += r.pay.amountPaise; else byCode.set(k, { ...r.pay, patient: r.patient }); }
    return [...byCode.values()];
  });

  // --- the invoice menu: each asks for a reason, needs its permission and is audited. Rows are never deleted. ---
  const Reason = z.object({ reason: z.string().trim().min(3, 'Say why').max(200) });
  const chargeOf = async (req: any, tx: any) => { const c = await tx.select().from(charge).where(and(eq(charge.id, req.params.id), eq(charge.tenantId, req.ctx.tenantId))).then((r: any) => r[0]); if (!c) throw new HttpError(404, 'NOT_FOUND'); return c; };
  const paidOn = async (tx: any, id: string) => (await tx.select({ n: sql<number>`coalesce(sum(amount_paise),0)::int` }).from(payment).where(eq(payment.chargeId, id)))[0].n as number;
  route(app, 'post', '/charges/:id/cancel', 'payment.refund', async (req, tx) => {
    const b = Reason.parse(req.body); const c = await chargeOf(req, tx);
    if (c.status !== 'due' || (await paidOn(tx, c.id)) > 0) throw new HttpError(409, 'HAS_PAYMENTS_USE_REFUND');
    const [row] = await tx.update(charge).set({ status: 'cancelled', adjustmentReason: b.reason, adjustedBy: req.ctx.userId }).where(eq(charge.id, c.id)).returning();
    await emit(tx, req.ctx, 'charge.cancelled', 'charge', c.id, { reason: b.reason, amountPaise: c.amountPaise });
    return row;
  });
  route(app, 'post', '/charges/:id/exclude', 'payment.refund', async (req, tx) => {
    const b = Reason.parse(req.body); const c = await chargeOf(req, tx);
    if (c.excludedAt) throw new HttpError(409, 'ALREADY_EXCLUDED');
    const [row] = await tx.update(charge).set({ excludedAt: new Date().toISOString(), excludedReason: b.reason }).where(eq(charge.id, c.id)).returning();
    await emit(tx, req.ctx, 'charge.excluded', 'charge', c.id, { reason: b.reason, amountPaise: c.amountPaise });
    return row;
  });
  // Discounts are given on the bill (POST /bills), where above the clinic limit they wait for an approver.
  /** Everything taken in one go, for printing. */
  route(app, 'get', '/receipts/:no', 'payment.record', async (req, tx) => {
    if (!can(req.perms, 'fees.see')) throw new HttpError(403, 'FORBIDDEN:fees.see');
    const rows = await tx.select({ p: payment, c: charge, pt: patient, by: appUser.name }).from(payment).innerJoin(patient, eq(patient.id, payment.patientId)).leftJoin(charge, eq(charge.id, payment.chargeId)).leftJoin(appUser, eq(appUser.id, payment.receivedBy))
      .where(and(eq(payment.tenantId, req.ctx.tenantId), eq(payment.receiptNo, (req.params as any).no))).orderBy(payment.receivedAt);
    if (!rows.length) throw new HttpError(404, 'NOT_FOUND');
    const ten = await tx.select().from(tenant).where(eq(tenant.id, req.ctx.tenantId)).then((r: any) => r[0]);
    return { receiptNo: (req.params as any).no, at: rows[0].p.receivedAt, patient: { fullName: rows[0].pt.fullName, patientNo: rows[0].pt.patientNo }, clinic: { name: ten?.name, print: ten?.settings?.print ?? {} }, receivedBy: [...new Set(rows.map((r) => r.by).filter(Boolean))].join(', ') || '—', // who took the money, not who is printing
      lines: rows.map((r) => ({ description: r.c?.description ?? (r.p.advance ? 'Advance' : r.p.courseId ? 'Sittings paid ahead' : 'Payment'), amountPaise: r.p.amountPaise, taxRateBp: r.c?.taxRateBp ?? 0, method: r.p.method, reference: r.p.reference, lender: r.p.lender })), totalPaise: rows.reduce((s, r) => s + r.p.amountPaise, 0),
      tax: gstSummary(ten?.settings?.gstin, rows.map((r) => ({ amountPaise: r.p.amountPaise, taxRateBp: r.c?.taxRateBp ?? 0 }))) };
  });

  route(app, 'post', '/charges', 'payment.record', async (req, tx) => {
    const body = z.object({ patientId: z.string().uuid(), visitId: z.string().uuid().optional(), description: z.string().min(1), amountPaise: z.number().int().min(0), taxRateBp: z.number().int().default(0) }).parse(req.body);
    const [row] = await tx.insert(charge).values({ ...body, tenantId: req.ctx.tenantId }).returning();
    return row;
  });

  // --- expenses: money going out. Same care as money coming in: validated, categorised, never silently deleted ---
  const DEFAULT_EXPENSE_CATEGORIES = ['Staff salary', 'Rent', 'Electricity and water', 'Medicines and supplies', 'Consumables', 'Equipment and repairs', 'Lab and outsourced work', 'Marketing', 'Travel and fuel', 'Tea and snacks', 'Cleaning', 'Taxes and fees', 'Other'];
  const categoriesOf = (settings: any): string[] => (Array.isArray(settings?.expenseCategories) && settings.expenseCategories.length ? settings.expenseCategories : DEFAULT_EXPENSE_CATEGORIES);
  const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => !Number.isNaN(Date.parse(d + 'T00:00:00Z')), 'BAD_DATE');
  const ExpenseIn = z.object({
    day: DAY.optional(), description: z.string().trim().min(2, 'Say what it was for').max(200),
    amountPaise: z.number().int().positive('Amount must be more than zero').max(1_000_000_00, 'Amount is too large'),
    method: z.enum(['cash', 'upi', 'bank']).default('cash'), category: z.string().trim().min(1).max(40).default('Other'), note: z.string().trim().max(500).nullable().optional(),
  });
  const checkExpense = async (req: any, tx: any, b: { day?: string; category?: string }) => {
    const today = todayIn(req.ctx.timezone);
    if (b.day && b.day > today) throw new HttpError(400, 'FUTURE_DATE');
    if (b.day && b.day < addDays(today, -366)) throw new HttpError(400, 'TOO_OLD');
    if (b.category) { const ten = await tx.select().from(tenant).where(eq(tenant.id, req.ctx.tenantId)).then((r: any) => r[0]); if (!categoriesOf(ten?.settings).includes(b.category)) throw new HttpError(400, 'BAD_CATEGORY'); }
  };
  route(app, 'get', '/expenses', 'expense.read', async (req, tx) => {
    const q = req.query as any; const tz = req.ctx.timezone; const to = DAY.safeParse(q.to).success ? q.to : todayIn(tz); const from = DAY.safeParse(q.from).success ? q.from : addDays(to, -29);
    const rows = await tx.select({ e: expense, by: appUser.name }).from(expense).leftJoin(appUser, eq(appUser.id, expense.enteredBy))
      .where(and(eq(expense.tenantId, req.ctx.tenantId), gte(expense.day, from), lte(expense.day, to))).orderBy(desc(expense.day), desc(expense.createdAt)).limit(1000);
    const live = rows.filter((r) => !r.e.voidedAt);
    const sum = (key: 'category' | 'method') => Object.entries(live.reduce((m: Record<string, number>, r) => ({ ...m, [r.e[key]]: (m[r.e[key]] ?? 0) + r.e.amountPaise }), {})).map(([k, total]) => ({ [key]: k, total })).sort((a: any, b: any) => b.total - a.total);
    const ten = await tx.select().from(tenant).where(eq(tenant.id, req.ctx.tenantId)).then((r) => r[0]);
    return { from, to, categories: categoriesOf(ten?.settings), rows: rows.map((r) => ({ ...r.e, enteredByName: r.by })), totalPaise: live.reduce((s, r) => s + r.e.amountPaise, 0), byCategory: sum('category'), byMethod: sum('method') };
  });
  route(app, 'post', '/expenses', 'expense.write', async (req, tx) => {
    const body = ExpenseIn.parse(req.body); await checkExpense(req, tx, body);
    const [row] = await tx.insert(expense).values({ ...body, day: body.day ?? todayIn(req.ctx.timezone), tenantId: req.ctx.tenantId, enteredBy: req.ctx.userId }).returning();
    await emit(tx, req.ctx, 'expense.added', 'expense', row.id, { amountPaise: row.amountPaise, category: row.category });
    return row;
  });
  route(app, 'patch', '/expenses/:id', 'expense.write', async (req, tx) => {
    const body = sent(ExpenseIn.partial().parse(req.body), req.body); await checkExpense(req, tx, body);
    const [row] = await tx.update(expense).set(body).where(and(eq(expense.id, (req.params as any).id), eq(expense.tenantId, req.ctx.tenantId), isNull(expense.voidedAt))).returning();
    if (!row) throw new HttpError(404, 'NOT_FOUND');
    await emit(tx, req.ctx, 'expense.edited', 'expense', row.id, body);
    return row;
  });
  /** "Delete" keeps the row (voided, with who and why) so the books can always be explained. */
  route(app, 'delete', '/expenses/:id', 'expense.write', async (req, tx) => {
    const reason = String((req.query as any).reason ?? '').trim().slice(0, 200);
    const [row] = await tx.update(expense).set({ voidedAt: new Date().toISOString(), voidedReason: reason || null }).where(and(eq(expense.id, (req.params as any).id), eq(expense.tenantId, req.ctx.tenantId), isNull(expense.voidedAt))).returning();
    if (!row) throw new HttpError(404, 'NOT_FOUND');
    await emit(tx, req.ctx, 'expense.voided', 'expense', row.id, { reason });
    return { ok: true };
  });

  /** Daily report: replaces the two-page printout and the handwritten ledger. */
  route(app, 'get', '/reports/daily', 'report.daily', async (req, tx) => {
    const t = req.ctx.tenantId; const day = String((req.query as any).day ?? todayIn(req.ctx.timezone));
    const { start, end } = dayBounds(day, req.ctx.timezone);
    const byMethod = await tx.select({ method: payment.method, total: sql<number>`sum(${payment.amountPaise})::int`, n: sql<number>`count(*)::int` })
      .from(payment).where(and(eq(payment.tenantId, t), gte(payment.receivedAt, start), lt(payment.receivedAt, end), sql`${payment.method} <> 'advance'`)).groupBy(payment.method);
    const byCategory = await tx.select({ code: feeCategory.code, name: feeCategory.name, visits: sql<number>`count(*)::int`,
      billed: sql<number>`coalesce(sum(case when ${charge.status} in ('paid','due') and ${charge.excludedAt} is null then ${charge.amountPaise} end),0)::int`,
      waived: sql<number>`coalesce(sum(case when ${charge.status}='waived' then ${charge.amountPaise} end),0)::int`,
      refunded: sql<number>`coalesce(sum(case when ${charge.status}='refunded' then ${charge.amountPaise} end),0)::int` })
      .from(visit).innerJoin(feeCategory, eq(feeCategory.id, visit.feeCategoryId)).leftJoin(charge, eq(charge.visitId, visit.id))
      .where(and(eq(visit.tenantId, t), eq(visit.day, day))).groupBy(feeCategory.code, feeCategory.name);
    const expenses = await tx.select().from(expense).where(and(eq(expense.tenantId, t), eq(expense.day, day), isNull(expense.voidedAt)));
    const outstanding = await tx.select({ total: sql<number>`coalesce(sum(${charge.amountPaise}),0)::int`, n: sql<number>`count(*)::int` }).from(charge).where(and(eq(charge.tenantId, t), eq(charge.status, 'due')));
    const payments = await tx.select({ pay: payment, patient: patient.fullName, desc: charge.description }).from(payment).innerJoin(patient, eq(patient.id, payment.patientId)).leftJoin(charge, eq(charge.id, payment.chargeId))
      .where(and(eq(payment.tenantId, t), gte(payment.receivedAt, start), lt(payment.receivedAt, end))).orderBy(desc(payment.receivedAt));
    // One "Collected" for the whole app: the same figure as End of day (payments net of refunds, plus pharmacy sales less returns).
    const f = await dayFigures(tx, t, req.ctx.timezone, day); const m = f.money.total;
    const collected = m.total;
    const spent = expenses.reduce((s, e) => s + e.amountPaise, 0);
    return { day, byMethod, byCategory, expenses, outstanding: outstanding[0], payments: payments.map((p) => ({ ...p.pay, patient: p.patient, description: p.desc })),
      byMode: { cash: m.cash, upi: m.upi, card: m.card, other: m.other }, pharmacyPaise: f.money.pharmacy.total,
      totals: { collectedPaise: collected, expensesPaise: spent, netPaise: collected - spent, visits: byCategory.reduce((s, c) => s + c.visits, 0) }, prevDay: addDays(day, -1), nextDay: addDays(day, 1) };
  });
}
