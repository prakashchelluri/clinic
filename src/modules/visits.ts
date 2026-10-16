import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, sql, asc, desc } from 'drizzle-orm';
import jsonLogic from 'json-logic-js';
import { visit, appointment, patient, feeCategory, charge, payment, recommendation, practitioner, encounter } from '../db/schema.js';
import type { Tx } from '../db/index.js';
import { route } from '../lib/route.js';
import { emit, nextNumber, todayIn, daysBetween } from '../lib/core.js';
import { HttpError, can, type Ctx } from '../lib/auth.js';

/** Facts the fee-category eligibility rules can look at. */
async function eligibilityContext(tx: Tx, ctx: Ctx, patientId: string) {
  const t = ctx.tenantId; const today = todayIn(ctx.timezone);
  const p = await tx.select().from(patient).where(and(eq(patient.id, patientId), eq(patient.tenantId, t))).then((r) => r[0]);
  if (!p) throw new HttpError(404, 'PATIENT_NOT_FOUND');
  const lastPaid = await tx.select({ at: payment.receivedAt }).from(payment).innerJoin(charge, eq(charge.id, payment.chargeId))
    .where(and(eq(payment.tenantId, t), eq(payment.patientId, patientId), sql`${charge.description} like 'Consultation%'`)).orderBy(desc(payment.receivedAt)).limit(1).then((r) => r[0]);
  const openCourse = await tx.select({ id: recommendation.id }).from(recommendation)
    .where(and(eq(recommendation.tenantId, t), eq(recommendation.patientId, patientId), eq(recommendation.kind, 'procedure'), sql`${recommendation.status} in ('open','contacted','scheduled')`)).limit(1);
  const visits = await tx.select({ n: sql<number>`count(*)::int` }).from(visit).where(and(eq(visit.tenantId, t), eq(visit.patientId, patientId)));
  return {
    patient: { referralCard: p.referralCard, ageYears: p.ageYears },
    days_since_last_paid_consult: lastPaid ? daysBetween(todayIn(ctx.timezone, new Date(lastPaid.at)), today) : 99999, // never paid: rules like "<= 14" must not match null
    has_open_procedure_course: openCourse.length > 0,
    is_new_patient: visits[0].n === 0,
  };
}

export async function suggestCategory(tx: Tx, ctx: Ctx, patientId: string) {
  const facts = await eligibilityContext(tx, ctx, patientId);
  const cats = await tx.select().from(feeCategory).where(and(eq(feeCategory.tenantId, ctx.tenantId), eq(feeCategory.active, true)));
  const eligible = cats.filter((c) => c.eligibility && jsonLogic.apply(c.eligibility as any, facts));
  // most specific rule wins: lowest fee among eligible; fall back to the default (no rule, code GEN or first)
  const pick = eligible.sort((a, b) => a.amountPaise - b.amountPaise)[0] ?? cats.find((c) => c.code === 'GEN') ?? cats[0];
  const p = await tx.select().from(patient).where(and(eq(patient.id, patientId), eq(patient.tenantId, ctx.tenantId))).then((r) => r[0]);
  return { suggested: pick, facts, categories: cats, patient: p };
}

const CheckIn = z.object({
  patientId: z.string().uuid(), appointmentId: z.string().uuid().optional(), branchId: z.string().uuid().optional(),
  feeCategoryCode: z.string(), practitionerId: z.string().uuid().nullable().optional(),
  details: z.record(z.string(), z.any()).default({}),
  payment: z.object({ method: z.enum(['cash', 'upi', 'card', 'bank']), amountPaise: z.number().int().min(0), reference: z.string().optional() }).optional(),
  waive: z.object({ reason: z.string().min(1) }).optional(),
  idempotencyKey: z.string().optional(),
});

export function visitRoutes(app: FastifyInstance) {
  route(app, 'get', '/patients/:id/suggest-category', 'visit.write', async (req, tx) => suggestCategory(tx, req.ctx, (req.params as any).id));

  /** Arrival: register visit details, fee, payment and queue entry in one call. */
  route(app, 'post', '/visits', 'visit.write', async (req, tx) => {
    const body = CheckIn.parse(req.body); const t = req.ctx.tenantId; const day = todayIn(req.ctx.timezone);
    if (body.idempotencyKey) {
      const dup = await tx.select().from(visit).where(and(eq(visit.tenantId, t), eq(visit.idempotencyKey, body.idempotencyKey))).then((r) => r[0]);
      if (dup) return dup;
    }
    const cat = await tx.select().from(feeCategory).where(and(eq(feeCategory.tenantId, t), eq(feeCategory.code, body.feeCategoryCode))).then((r) => r[0]);
    if (!cat) throw new HttpError(400, 'BAD_CATEGORY');
    const branchId = body.branchId ?? (await tx.query.branch.findFirst({ where: (b, { eq }) => eq(b.tenantId, t) }))!.id;
    const settings = (await tx.query.tenant.findFirst({ where: (tn, { eq }) => eq(tn.id, t) }))?.settings ?? {};
    const scope = settings.numbering?.opNumberScope === 'day' ? `${branchId}:${day}` : `${branchId}:${day}:${cat.code}`;
    const n = await nextNumber(tx, t, 'op_number', scope);
    const opNumber = settings.numbering?.opNumberScope === 'day' ? String(n) : `${cat.code}-${n}`;
    const [{ maxPos }] = await tx.select({ maxPos: sql<string>`coalesce(max(${visit.queuePosition}), 0)` }).from(visit).where(and(eq(visit.tenantId, t), eq(visit.day, day)));
    const [v] = await tx.insert(visit).values({
      tenantId: t, branchId, patientId: body.patientId, appointmentId: body.appointmentId, practitionerId: body.practitionerId ?? null,
      feeCategoryId: cat.id, day, opNumber, details: body.details, queuePosition: String(Number(maxPos) + 1), priority: cat.priority, idempotencyKey: body.idempotencyKey,
    }).returning();
    if (body.appointmentId) await tx.update(appointment).set({ status: 'arrived' }).where(eq(appointment.id, body.appointmentId));

    // Fee: a charge row even when ₹0, so reports reconcile by category
    const amount = cat.amountPaise;
    let status = amount === 0 ? 'paid' : 'due';
    if (body.waive) {
      if (!can(req.perms, 'payment.waive')) throw new HttpError(403, 'FORBIDDEN:payment.waive');
      status = 'waived';
    }
    const [ch] = await tx.insert(charge).values({ tenantId: t, patientId: body.patientId, visitId: v.id, description: `Consultation (${cat.name})`, amountPaise: amount, taxRateBp: cat.taxRateBp,
      status, adjustmentReason: body.waive?.reason, adjustedBy: body.waive ? req.ctx.userId : null }).returning();
    if (body.payment && body.payment.amountPaise > 0) {
      if (!can(req.perms, 'payment.record')) throw new HttpError(403, 'FORBIDDEN:payment.record');
      await tx.insert(payment).values({ tenantId: t, patientId: body.patientId, chargeId: ch.id, amountPaise: body.payment.amountPaise, method: body.payment.method, reference: body.payment.reference, receivedBy: req.ctx.userId });
      if (body.payment.amountPaise >= amount) { await tx.update(charge).set({ status: 'paid' }).where(eq(charge.id, ch.id)); ch.status = 'paid'; }
    }
    await emit(tx, req.ctx, 'visit.checked_in', 'visit', v.id, { patientId: body.patientId, opNumber, category: cat.code, amountPaise: amount, status });
    return { ...v, charge: ch };
  });

  /** Live queue for a day: waiting first by priority then position, then in-consult, then done. */
  route(app, 'get', '/queue', 'visit.read', async (req, tx) => {
    const day = String((req.query as any).day ?? todayIn(req.ctx.timezone));
    const rows = await tx.select({ v: visit, p: { id: patient.id, fullName: patient.fullName, patientNo: patient.patientNo, phone: patient.phone, ageYears: patient.ageYears, sex: patient.sex },
      cat: feeCategory.code, doctor: practitioner.name, encounterId: encounter.id, encounterStatus: encounter.status })
      .from(visit).innerJoin(patient, eq(patient.id, visit.patientId)).innerJoin(feeCategory, eq(feeCategory.id, visit.feeCategoryId))
      .leftJoin(practitioner, eq(practitioner.id, visit.practitionerId)).leftJoin(encounter, eq(encounter.visitId, visit.id))
      .where(and(eq(visit.tenantId, req.ctx.tenantId), eq(visit.day, day)))
      .orderBy(desc(visit.priority), asc(visit.queuePosition));
    return rows.map((r) => ({ ...r.v, patient: r.p, category: r.cat, doctor: r.doctor, encounterId: r.encounterId, encounterStatus: r.encounterStatus }));
  });

  /** Reorder/skip/call/done. Position is fractional: moving between 3 and 4 gives 3.5, nothing else is rewritten. */
  route(app, 'patch', '/visits/:id', 'visit.queue', async (req, tx) => {
    const body = z.object({ status: z.enum(['waiting', 'intake', 'in_consult', 'done', 'left']).optional(), afterVisitId: z.string().uuid().nullable().optional(),
      practitionerId: z.string().uuid().nullable().optional(), details: z.record(z.string(), z.any()).optional(), priority: z.number().int().optional(), reason: z.string().optional() }).parse(req.body);
    const t = req.ctx.tenantId; const id = (req.params as any).id;
    const cur = await tx.select().from(visit).where(and(eq(visit.id, id), eq(visit.tenantId, t))).then((r) => r[0]);
    if (!cur) throw new HttpError(404, 'NOT_FOUND');
    const set: any = {};
    if (body.status) set.status = body.status;
    if (body.practitionerId !== undefined) set.practitionerId = body.practitionerId;
    if (body.priority !== undefined) set.priority = body.priority;
    if (body.details) set.details = { ...cur.details, ...body.details };
    if (body.afterVisitId !== undefined) {
      const others = await tx.select({ id: visit.id, pos: visit.queuePosition }).from(visit)
        .where(and(eq(visit.tenantId, t), eq(visit.day, cur.day), sql`${visit.id} <> ${id}`)).orderBy(asc(visit.queuePosition));
      const idx = body.afterVisitId ? others.findIndex((o) => o.id === body.afterVisitId) : -1;
      const prev = idx >= 0 ? Number(others[idx].pos) : 0;
      const next = others[idx + 1] ? Number(others[idx + 1].pos) : prev + 2;
      set.queuePosition = String((prev + next) / 2);
    }
    const [row] = await tx.update(visit).set(set).where(eq(visit.id, id)).returning();
    await emit(tx, req.ctx, 'visit.updated', 'visit', id, { ...body });
    return row;
  });
}
