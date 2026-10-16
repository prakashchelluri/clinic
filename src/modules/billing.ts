import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, sql, gte, lt, desc } from 'drizzle-orm';
import { charge, payment, expense, visit, feeCategory, patient } from '../db/schema.js';
import { route } from '../lib/route.js';
import { emit, todayIn, addDays } from '../lib/core.js';
import { HttpError } from '../lib/auth.js';

/** [start,end) in UTC for a local day in the tenant timezone. */
function dayBounds(day: string, tz: string) {
  const probe = new Date(day + 'T12:00:00Z');
  const local = new Date(probe.toLocaleString('en-US', { timeZone: tz }));
  const offsetMs = local.getTime() - probe.getTime();
  const start = new Date(Date.parse(day + 'T00:00:00Z') - offsetMs);
  return { start: start.toISOString(), end: new Date(start.getTime() + 86400000).toISOString() };
}

export function billingRoutes(app: FastifyInstance) {
  route(app, 'post', '/payments', 'payment.record', async (req, tx) => {
    const body = z.object({ patientId: z.string().uuid(), chargeId: z.string().uuid().optional(), amountPaise: z.number().int().positive(),
      method: z.enum(['cash', 'upi', 'card', 'bank']), reference: z.string().optional(), idempotencyKey: z.string().optional() }).parse(req.body);
    const t = req.ctx.tenantId;
    if (body.idempotencyKey) {
      const dup = await tx.select().from(payment).where(and(eq(payment.tenantId, t), eq(payment.idempotencyKey, body.idempotencyKey))).then((r) => r[0]);
      if (dup) return dup;
    }
    const [row] = await tx.insert(payment).values({ ...body, tenantId: t, receivedBy: req.ctx.userId }).returning();
    if (body.chargeId) {
      const ch = await tx.select().from(charge).where(and(eq(charge.id, body.chargeId), eq(charge.tenantId, t))).then((r) => r[0]);
      if (!ch) throw new HttpError(404, 'CHARGE_NOT_FOUND');
      const [{ paid }] = await tx.select({ paid: sql<number>`coalesce(sum(amount_paise),0)::int` }).from(payment).where(eq(payment.chargeId, ch.id));
      if (paid >= ch.amountPaise) await tx.update(charge).set({ status: 'paid' }).where(eq(charge.id, ch.id));
    }
    await emit(tx, req.ctx, 'payment.recorded', 'payment', row.id, { amountPaise: body.amountPaise, method: body.method, chargeId: body.chargeId });
    return row;
  });

  /** Waive or refund a charge; the row is kept, status + reason change, event recorded. */
  route(app, 'post', '/charges/:id/adjust', 'payment.waive', async (req, tx) => {
    const body = z.object({ kind: z.enum(['waived', 'refunded']), reason: z.string().min(1) }).parse(req.body);
    const [row] = await tx.update(charge).set({ status: body.kind, adjustmentReason: body.reason, adjustedBy: req.ctx.userId })
      .where(and(eq(charge.id, (req.params as any).id), eq(charge.tenantId, req.ctx.tenantId))).returning();
    if (!row) throw new HttpError(404, 'NOT_FOUND');
    await emit(tx, req.ctx, `charge.${body.kind}`, 'charge', row.id, { reason: body.reason, amountPaise: row.amountPaise });
    return row;
  });

  route(app, 'post', '/charges', 'payment.record', async (req, tx) => {
    const body = z.object({ patientId: z.string().uuid(), visitId: z.string().uuid().optional(), description: z.string().min(1), amountPaise: z.number().int().min(0), taxRateBp: z.number().int().default(0) }).parse(req.body);
    const [row] = await tx.insert(charge).values({ ...body, tenantId: req.ctx.tenantId }).returning();
    return row;
  });

  route(app, 'post', '/expenses', 'expense.write', async (req, tx) => {
    const body = z.object({ day: z.string().optional(), description: z.string().min(1), amountPaise: z.number().int().positive(), method: z.enum(['cash', 'upi', 'bank']).default('cash') }).parse(req.body);
    const [row] = await tx.insert(expense).values({ ...body, day: body.day ?? todayIn(req.ctx.timezone), tenantId: req.ctx.tenantId, enteredBy: req.ctx.userId }).returning();
    return row;
  });

  /** Daily report: replaces the two-page printout and the handwritten ledger. */
  route(app, 'get', '/reports/daily', 'report.daily', async (req, tx) => {
    const t = req.ctx.tenantId; const day = String((req.query as any).day ?? todayIn(req.ctx.timezone));
    const { start, end } = dayBounds(day, req.ctx.timezone);
    const byMethod = await tx.select({ method: payment.method, total: sql<number>`sum(${payment.amountPaise})::int`, n: sql<number>`count(*)::int` })
      .from(payment).where(and(eq(payment.tenantId, t), gte(payment.receivedAt, start), lt(payment.receivedAt, end))).groupBy(payment.method);
    const byCategory = await tx.select({ code: feeCategory.code, name: feeCategory.name, visits: sql<number>`count(*)::int`,
      billed: sql<number>`coalesce(sum(case when ${charge.status} in ('paid','due') then ${charge.amountPaise} end),0)::int`,
      waived: sql<number>`coalesce(sum(case when ${charge.status}='waived' then ${charge.amountPaise} end),0)::int`,
      refunded: sql<number>`coalesce(sum(case when ${charge.status}='refunded' then ${charge.amountPaise} end),0)::int` })
      .from(visit).innerJoin(feeCategory, eq(feeCategory.id, visit.feeCategoryId)).leftJoin(charge, eq(charge.visitId, visit.id))
      .where(and(eq(visit.tenantId, t), eq(visit.day, day))).groupBy(feeCategory.code, feeCategory.name);
    const expenses = await tx.select().from(expense).where(and(eq(expense.tenantId, t), eq(expense.day, day)));
    const outstanding = await tx.select({ total: sql<number>`coalesce(sum(${charge.amountPaise}),0)::int`, n: sql<number>`count(*)::int` }).from(charge).where(and(eq(charge.tenantId, t), eq(charge.status, 'due')));
    const payments = await tx.select({ pay: payment, patient: patient.fullName, desc: charge.description }).from(payment).innerJoin(patient, eq(patient.id, payment.patientId)).leftJoin(charge, eq(charge.id, payment.chargeId))
      .where(and(eq(payment.tenantId, t), gte(payment.receivedAt, start), lt(payment.receivedAt, end))).orderBy(desc(payment.receivedAt));
    const collected = byMethod.reduce((s, m) => s + m.total, 0);
    const spent = expenses.reduce((s, e) => s + e.amountPaise, 0);
    return { day, byMethod, byCategory, expenses, outstanding: outstanding[0], payments: payments.map((p) => ({ ...p.pay, patient: p.patient, description: p.desc })),
      totals: { collectedPaise: collected, expensesPaise: spent, netPaise: collected - spent, visits: byCategory.reduce((s, c) => s + c.visits, 0) }, prevDay: addDays(day, -1), nextDay: addDays(day, 1) };
  });
}
