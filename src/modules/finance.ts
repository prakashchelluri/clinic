import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, sql } from 'drizzle-orm';
import { appUser, charge, course, dayClose, expense, patient, payment, pharmacySale, procedureCatalog, stockBatch } from '../db/schema.js';
import { route } from '../lib/route.js';
import { addDays, daysBetween, todayIn } from '../lib/core.js';
import { HttpError } from '../lib/auth.js';
import { dayBounds } from './billing.js';
import { moneyByDay } from './dayclose.js';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const okDay = (d: unknown): d is string => typeof d === 'string' && DAY.test(d) && !Number.isNaN(Date.parse(d + 'T00:00:00Z'));

/**
 * The owner's Accounts page in one call: what came in by source over any period (the same ledger as End of day),
 * what went out, the comparison period, the pharmacy margin, and what is not in yet.
 */
export function financeRoutes(app: FastifyInstance) {
  route(app, 'get', '/finance', 'finance.read', async (req, tx) => {
    const t = req.ctx.tenantId; const tz = req.ctx.timezone; const q = req.query as any; const today = todayIn(tz);
    const to = okDay(q.to) ? q.to : today; const from = okDay(q.from) ? q.from : to.slice(0, 8) + '01';
    if (from > to) throw new HttpError(400, 'BAD_RANGE');
    if (daysBetween(from, to) > 366) throw new HttpError(400, 'RANGE_TOO_LONG');
    const len = daysBetween(from, to);
    const prevTo = okDay(q.prevTo) ? q.prevTo : addDays(from, -1); const prevFrom = okDay(q.prevFrom) ? q.prevFrom : addDays(prevTo, -len);

    const cur = await moneyByDay(tx, t, tz, from, to);
    const prev = await moneyByDay(tx, t, tz, prevFrom, prevTo);

    const exRows = await tx.select({ e: expense, by: appUser.name }).from(expense).leftJoin(appUser, eq(appUser.id, expense.enteredBy))
      .where(and(eq(expense.tenantId, t), gte(expense.day, from), lte(expense.day, to), isNull(expense.voidedAt))).orderBy(desc(expense.day), desc(expense.createdAt));
    const prevOut = (await tx.select({ n: sql<number>`coalesce(sum(amount_paise),0)::int` }).from(expense)
      .where(and(eq(expense.tenantId, t), gte(expense.day, prevFrom), lte(expense.day, prevTo), isNull(expense.voidedAt))))[0]?.n ?? 0;
    const exByDay: Record<string, number> = {}; const cats: Record<string, { totalPaise: number; n: number }> = {};
    for (const { e } of exRows) { exByDay[e.day] = (exByDay[e.day] ?? 0) + e.amountPaise; (cats[e.category] ??= { totalPaise: 0, n: 0 }); cats[e.category].totalPaise += e.amountPaise; cats[e.category].n++; }

    const closes = await tx.select().from(dayClose).where(and(eq(dayClose.tenantId, t), gte(dayClose.day, from), lte(dayClose.day, to)));
    const closedOn = new Map(closes.map((c) => [c.day, { by: c.closedBy, at: c.createdAt }]));
    // every day with money or spending, and today while it is in the range
    const days = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const m = cur.days[d]; const ex = exByDay[d] ?? 0;
      if (!m && !ex && d !== today) continue;
      days.push({ day: d, money: m ?? null, expensesPaise: ex, closed: closedOn.get(d) ?? null, today: d === today });
    }

    // pharmacy margin: bills made in the range, against the purchase price of the batch each line came from
    const { start, end } = { start: dayBounds(from, tz).start, end: dayBounds(to, tz).end };
    const sales = await tx.select().from(pharmacySale).where(and(eq(pharmacySale.tenantId, t), gte(pharmacySale.createdAt, start), lt(pharmacySale.createdAt, end)));
    const batchIds = [...new Set(sales.flatMap((s) => s.items.map((l) => l.batchId).filter((x): x is string => !!x)))];
    const cost = new Map((batchIds.length ? await tx.select({ id: stockBatch.id, c: stockBatch.costPaise }).from(stockBatch).where(and(eq(stockBatch.tenantId, t), inArray(stockBatch.id, batchIds))) : []).map((b) => [b.id, b.c]));
    let soldPaise = 0, costPaise = 0, uncostedPaise = 0;
    for (const s of sales) {
      const back: Record<number, number> = {};
      for (const r of s.returns ?? []) { soldPaise -= r.refundPaise; for (const l of r.lines) back[l.line] = (back[l.line] ?? 0) + l.qty; }
      soldPaise += s.totalPaise;
      s.items.forEach((l, i) => { const qty = l.qty - (back[i] ?? 0); const c = l.batchId ? cost.get(l.batchId) : undefined; if (c) costPaise += qty * c; else if (qty > 0) uncostedPaise += Math.round(l.amountPaise * qty / Math.max(1, l.qty)); });
    }

    // not in yet: owed by patients (any date), EMI the lender has not paid, and what went back or was let go in the range
    const dueRows = await tx.select({ c: charge, name: patient.fullName, phone: patient.phone, no: patient.patientNo }).from(charge).innerJoin(patient, eq(patient.id, charge.patientId))
      .where(and(eq(charge.tenantId, t), eq(charge.status, 'due'))).orderBy(asc(charge.createdAt));
    const owed = new Map<string, { patientId: string; name: string; phone: string | null; patientNo: string; totalPaise: number; since: string; items: string[] }>();
    for (const r of dueRows) {
      const o = owed.get(r.c.patientId) ?? { patientId: r.c.patientId, name: r.name, phone: r.phone, patientNo: r.no, totalPaise: 0, since: todayIn(tz, new Date(r.c.createdAt)), items: [] };
      o.totalPaise += r.c.amountPaise; o.items.push(r.c.description); owed.set(r.c.patientId, o);
    }
    const emi = (await tx.select({ n: sql<number>`count(*)::int`, total: sql<number>`coalesce(sum(${payment.amountPaise}),0)::int` }).from(payment)
      .where(and(eq(payment.tenantId, t), eq(payment.method, 'emi'), isNull(payment.settledAt))))[0];
    const refunds = (await tx.select({ p: payment, name: patient.fullName, what: charge.description }).from(payment).innerJoin(patient, eq(patient.id, payment.patientId)).leftJoin(charge, eq(charge.id, payment.chargeId))
      .where(and(eq(payment.tenantId, t), lt(payment.amountPaise, 0), gte(payment.receivedAt, start), lt(payment.receivedAt, end))).orderBy(asc(payment.receivedAt)))
      .map((r) => ({ kind: 'refund', name: r.name, what: r.what ?? (r.p.courseId ? 'Course advance' : 'Payment'), method: r.p.method, day: todayIn(tz, new Date(r.p.receivedAt)), amountPaise: -r.p.amountPaise }));
    const pharmacyBack = (await tx.select({ s: pharmacySale, name: patient.fullName }).from(pharmacySale).innerJoin(patient, eq(patient.id, pharmacySale.patientId))
      .where(and(eq(pharmacySale.tenantId, t), gte(pharmacySale.createdAt, addDays(from, -90)), lt(pharmacySale.createdAt, end))))
      .flatMap(({ s, name }) => (s.returns ?? []).filter((r) => r.at >= start && r.at < end).map((r) => ({ kind: 'refund', name: s.buyerName ?? name, what: `Pharmacy return, bill ${s.invoiceNo}`, method: r.method, day: todayIn(tz, new Date(r.at)), amountPaise: r.refundPaise })));
    const waived = (await tx.select({ c: charge, name: patient.fullName }).from(charge).innerJoin(patient, eq(patient.id, charge.patientId))
      .where(and(eq(charge.tenantId, t), eq(charge.status, 'waived'), gte(charge.createdAt, start), lt(charge.createdAt, end))).orderBy(asc(charge.createdAt)))
      .map((r) => ({ kind: 'waived', name: r.name, what: r.c.description + (r.c.adjustmentReason ? ` · ${r.c.adjustmentReason}` : ''), method: null, day: todayIn(tz, new Date(r.c.createdAt)), amountPaise: r.c.amountPaise }));

    const outPaise = exRows.reduce((s, r) => s + r.e.amountPaise, 0);
    // courses priced by the doctor in the period: so the accounts see a price above or below the standard came from the doctor, agreed by the patient
    const dp = await tx.select({ c: course, patient: patient.fullName, patientNo: patient.patientNo, procedure: procedureCatalog.name }).from(course).innerJoin(patient, eq(patient.id, course.patientId)).leftJoin(procedureCatalog, eq(procedureCatalog.id, course.procedureId))
      .where(and(eq(course.tenantId, t), eq(course.priceSource, 'doctor'), gte(course.createdAt, dayBounds(from, tz).start), lt(course.createdAt, dayBounds(to, tz).end))).orderBy(desc(course.createdAt));
    const doctorPrices = dp.map((x) => ({ id: x.c.id, day: new Date(x.c.createdAt).toLocaleDateString('en-CA', { timeZone: tz }), patient: x.patient, patientNo: x.patientNo, procedure: x.procedure, sittings: x.c.sittings,
      totalPaise: x.c.totalPaise, standardPaise: x.c.standardPaise, doctor: x.c.priceBy, recordedBy: x.c.agreedBy }));
    return {
      from, to, prevFrom, prevTo, today,
      income: cur.total, prevIncome: prev.total, outPaise, prevOutPaise: prevOut,
      days,
      expenses: { n: exRows.length, byCategory: Object.entries(cats).map(([category, v]) => ({ category, ...v })).sort((a, b) => b.totalPaise - a.totalPaise),
        rows: exRows.map((r) => ({ id: r.e.id, day: r.e.day, description: r.e.description, category: r.e.category, method: r.e.method, amountPaise: r.e.amountPaise, enteredByName: r.by })) },
      pharmacy: { soldPaise, costPaise, uncostedPaise },
      owed: { totalPaise: [...owed.values()].reduce((s, o) => s + o.totalPaise, 0), patients: [...owed.values()] },
      emi: { n: emi?.n ?? 0, totalPaise: emi?.total ?? 0 },
      givenBack: [...refunds, ...pharmacyBack, ...waived].sort((a, b) => a.day.localeCompare(b.day)),
      doctorPrices,
    };
  });
}
