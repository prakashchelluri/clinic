// Procedures and packages managed from the patient record: add one at the desk, edit its sessions and validity, cancel it.
// A package is procedures, each with its sessions; a procedure on its own is just its sessions. Prices stay fixed:
// a package's share or the standard price; an added session costs the standard price, a removed one takes its share off.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { course, encounter, procedureCatalog, procedureSession, recommendation, tenant } from '../db/schema.js';
import { route } from '../lib/route.js';
import { syncTreatment } from './courses.js';
import { advanceBalance } from './bills.js';
import { emit, todayIn } from '../lib/core.js';
import { HttpError, can } from '../lib/auth.js';
import { packagesOf, shares } from '../lib/packages.js';

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const LIVE = ['confirmed', 'in_progress', 'completed'];
const feesOnly = (req: any) => { if (!can(req.perms, 'fees.see')) throw new HttpError(403, 'FORBIDDEN:fees.see'); };

export function planAdminRoutes(app: FastifyInstance) {
  /** Add a procedure (N sessions, a gap) or a package (its procedures, each with its sessions) to a patient. It hangs off their latest consultation. */
  route(app, 'post', '/procedure-plans/add', 'worklist.write', async (req, tx) => {
    feesOnly(req);
    const b = z.object({ patientId: z.string().uuid(), packageId: z.string().min(1).max(40).optional(), procedureId: z.string().uuid().optional(),
      sittings: z.number().int().min(1).max(60).optional(), gapDays: z.number().int().min(0).max(365).optional(), practitionerId: z.string().uuid().nullish(),
      validUntil: Day.nullish(), noExpiry: z.boolean().default(false) }).strict()
      .refine((x) => !!x.packageId !== !!x.procedureId, 'A package or a procedure').parse(req.body);
    const t = req.ctx.tenantId; const today = todayIn(req.ctx.timezone);
    if (b.validUntil && b.validUntil < today) throw new HttpError(400, 'VALID_TILL_IN_THE_PAST');
    const enc = await tx.select().from(encounter).where(and(eq(encounter.tenantId, t), eq(encounter.patientId, b.patientId))).orderBy(desc(encounter.createdAt)).limit(1).then((r) => r[0]);
    if (!enc) throw new HttpError(409, 'NEEDS_A_CONSULTATION');
    const procs = await tx.select().from(procedureCatalog).where(eq(procedureCatalog.tenantId, t));
    const common = { tenantId: t, encounterId: enc.id, patientId: b.patientId, kind: 'procedure', dueOn: today, status: 'open', practitionerId: b.practitionerId ?? enc.practitionerId ?? null, validUntil: b.noExpiry ? null : b.validUntil ?? null, noExpiry: b.noExpiry };
    let rows: any[];
    if (b.packageId) {
      const ten = await tx.select().from(tenant).where(eq(tenant.id, t)).then((r) => r[0]);
      const k = packagesOf(ten?.settings).find((x) => x.id === b.packageId && x.active !== false);
      if (!k) throw new HttpError(404, 'PACKAGE_NOT_FOUND');
      const lists = k.items.map((it) => (procs.find((p) => p.id === it.procedureId)?.pricePaise ?? 0) * it.sittings);
      const parts = shares(k.pricePaise, lists); const group = crypto.randomUUID().slice(0, 8);
      const snap = { id: k.id, name: k.name, group, pricePaise: k.pricePaise, listPaise: lists.reduce((a, x) => a + x, 0), validMonths: k.validMonths };
      rows = await tx.insert(recommendation).values(k.items.map((it, i) => ({ ...common, procedureId: it.procedureId, sittings: it.sittings, gapDays: it.intervalDays || null, amountPaise: parts[i], package: snap }))).returning();
    } else {
      const p = procs.find((x) => x.id === b.procedureId && x.active !== false);
      if (!p) throw new HttpError(404, 'PROCEDURE_NOT_FOUND');
      if (!p.pricePaise) throw new HttpError(400, 'NO_PRICE_ON_THE_PRICE_LIST');
      rows = await tx.insert(recommendation).values({ ...common, procedureId: p.id, sittings: b.sittings ?? p.typicalSittings ?? 1, gapDays: b.gapDays || null }).returning();
    }
    for (const r of rows) await emit(tx, req.ctx, 'recommendation.created', 'recommendation', r.id, { kind: r.kind, patientId: r.patientId, dueOn: r.dueOn, procedureId: r.procedureId, from: 'patient record' });
    return rows;
  });

  /** Edit: the number of sessions and the gap of each procedure, and how long it (or the whole package) is valid.
   *  Sessions done or booked stay; an added session costs the standard price, a removed one takes its share off. */
  route(app, 'patch', '/procedure-plans/edit', 'worklist.write', async (req, tx) => {
    feesOnly(req);
    const b = z.object({ plans: z.array(z.object({ id: z.string().uuid(), sittings: z.number().int().min(1).max(60).optional(), gapDays: z.number().int().min(0).max(365).optional() })).min(1).max(10),
      validUntil: Day.nullish(), noExpiry: z.boolean().optional() }).strict().parse(req.body);
    const t = req.ctx.tenantId;
    if (b.validUntil && b.validUntil < todayIn(req.ctx.timezone)) throw new HttpError(400, 'VALID_TILL_IN_THE_PAST');
    const out = [];
    for (const x of b.plans) {
      const r = await tx.select().from(recommendation).where(and(eq(recommendation.id, x.id), eq(recommendation.tenantId, t), eq(recommendation.kind, 'procedure'))).then((y) => y[0]);
      if (!r) throw new HttpError(404, 'PLAN_NOT_FOUND');
      if (r.status === 'cancelled') throw new HttpError(409, 'PLAN_CANCELLED');
      const set: any = {};
      if (x.gapDays !== undefined) set.gapDays = x.gapDays || null;
      if (b.noExpiry !== undefined || b.validUntil !== undefined) { set.noExpiry = !!b.noExpiry; set.validUntil = b.noExpiry ? null : b.validUntil ?? null; }
      const c = await tx.select().from(course).where(and(eq(course.tenantId, t), eq(course.recommendationId, r.id))).then((y) => y[0]);
      let delta = 0;
      if (x.sittings !== undefined && x.sittings !== (r.sittings ?? 1)) {
        const oldN = c?.sittings ?? r.sittings ?? 1; const newN = x.sittings;
        const [{ used }] = await tx.select({ used: sql<number>`coalesce(max(${procedureSession.sittingNo}), 0)::int` }).from(procedureSession)
          .where(and(eq(procedureSession.recommendationId, r.id), inArray(procedureSession.state, LIVE)));
        if (newN < used) throw new HttpError(409, 'SESSIONS_ALREADY_DONE_OR_BOOKED', { min: used });
        const std = await tx.select({ p: procedureCatalog.pricePaise }).from(procedureCatalog).where(eq(procedureCatalog.id, r.procedureId!)).then((y) => y[0]?.p ?? 0);
        const total = c?.totalPaise ?? (r.amountPaise && r.amountPaise > 0 ? r.amountPaise : null);
        const share = total != null ? Math.round(total / oldN) : std;
        delta = newN > oldN ? (newN - oldN) * std : -(oldN - newN) * share;
        if (newN < oldN && total != null && newN === 0) delta = -total;
        set.sittings = newN;
        if (r.amountPaise != null && r.amountPaise > 0) set.amountPaise = Math.max(0, r.amountPaise + delta);
        if (c) await tx.update(course).set({ sittings: newN, totalPaise: Math.max(0, c.totalPaise + delta), listPaise: Math.max(c.totalPaise + delta, std * newN), standardPaise: std * newN || null }).where(eq(course.id, c.id));
        if (c) await syncTreatment(tx, req.ctx, c.id, `Sessions changed to ${newN}`); // its invoice follows; anything paid above it goes to the advance
        const [{ doneN }] = await tx.select({ doneN: sql<number>`count(*)::int` }).from(procedureSession).where(and(eq(procedureSession.recommendationId, r.id), eq(procedureSession.state, 'completed')));
        if (newN <= doneN) set.status = 'done'; // the sessions left were taken off: it is finished
        else if (r.status === 'done') set.status = 'open'; // more sessions on a finished procedure: it runs again
      }
      if (c && set.noExpiry !== undefined) await tx.update(course).set({ validUntil: set.noExpiry ? null : set.validUntil ?? c.validUntil }).where(eq(course.id, c.id));
      const [row] = Object.keys(set).length ? await tx.update(recommendation).set(set).where(eq(recommendation.id, r.id)).returning() : [r];
      await emit(tx, req.ctx, 'recommendation.edited', 'recommendation', r.id, { sittings: x.sittings, gapDays: x.gapDays, validUntil: set.validUntil, noExpiry: set.noExpiry, priceChangePaise: delta });
      out.push({ ...row, priceChangePaise: delta });
    }
    return out;
  });

  /** Cancel a procedure or a whole package: what is not done stops, booked sessions are cancelled. The treatment's invoice drops to the sessions done; what was paid above that goes to the patient's advance (Refund gives it back). */
  route(app, 'post', '/procedure-plans/cancel', 'worklist.write', async (req, tx) => {
    const b = z.object({ ids: z.array(z.string().uuid()).min(1).max(10), reason: z.string().trim().min(3, 'Say why').max(200) }).strict().parse(req.body);
    const t = req.ctx.tenantId;
    const rs = await tx.select().from(recommendation).where(and(eq(recommendation.tenantId, t), inArray(recommendation.id, b.ids), eq(recommendation.kind, 'procedure')));
    if (rs.length !== b.ids.length) throw new HttpError(404, 'PLAN_NOT_FOUND');
    if (new Set(rs.map((r) => r.patientId)).size !== 1) throw new HttpError(400, 'ONE_PATIENT_AT_A_TIME');
    if (rs.some((r) => r.status === 'cancelled')) throw new HttpError(409, 'ALREADY_CANCELLED');
    if (rs.some((r) => r.package) && rs.some((r) => !r.package || r.package.group !== rs[0].package?.group)) throw new HttpError(400, 'A_PACKAGE_IS_CANCELLED_WHOLE');
    if (rs[0].package) { // every procedure of the package goes together
      const all = await tx.select({ id: recommendation.id }).from(recommendation).where(and(eq(recommendation.tenantId, t), eq(recommendation.patientId, rs[0].patientId), sql`${recommendation.package}->>'group' = ${rs[0].package.group}`, sql`${recommendation.status} <> 'cancelled'`));
      if (all.length !== rs.length) throw new HttpError(400, 'A_PACKAGE_IS_CANCELLED_WHOLE');
    }
    const booked = await tx.update(procedureSession).set({ state: 'cancelled', stateReason: b.reason })
      .where(and(eq(procedureSession.tenantId, t), inArray(procedureSession.recommendationId, b.ids), eq(procedureSession.state, 'confirmed'))).returning({ id: procedureSession.id });
    await tx.update(recommendation).set({ status: 'cancelled', contactLog: sql`${recommendation.contactLog} || ${JSON.stringify([{ at: new Date().toISOString(), by: req.ctx.name, outcome: 'Cancelled', note: b.reason }])}::jsonb` }).where(inArray(recommendation.id, b.ids));
    let toAdvance = 0;
    for (const r of rs) { // the price becomes what was done; the invoice follows
      const c = await tx.select().from(course).where(and(eq(course.tenantId, t), eq(course.recommendationId, r.id))).then((y) => y[0]); if (!c) continue;
      const [{ doneN }] = await tx.select({ doneN: sql<number>`count(*)::int` }).from(procedureSession).where(and(eq(procedureSession.recommendationId, r.id), eq(procedureSession.state, 'completed')));
      if (doneN >= c.sittings) continue;
      await tx.update(course).set({ totalPaise: Math.round((c.totalPaise / c.sittings) * doneN) }).where(eq(course.id, c.id));
      const before = await advanceBalance(tx, t, r.patientId); await syncTreatment(tx, req.ctx, c.id, `Cancelled: ${b.reason}`); toAdvance += (await advanceBalance(tx, t, r.patientId)) - before;
    }
    for (const r of rs) await emit(tx, req.ctx, 'recommendation.cancelled', 'recommendation', r.id, { reason: b.reason, bookingsCancelled: booked.length });
    return { cancelled: rs.length, bookingsCancelled: booked.length, toAdvancePaise: toAdvance };
  });
}
