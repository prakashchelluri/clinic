import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, sql, asc } from 'drizzle-orm';
import { encounter, prescriptionItem, patient, visit, charge, payment } from '../db/schema.js';
import { route } from '../lib/route.js';
import { emit, todayIn } from '../lib/core.js';
import { HttpError } from '../lib/auth.js';

/** Pharmacy counter: completed prescriptions for the day, dispense per item, bill linked to the visit. */
export function pharmacyRoutes(app: FastifyInstance) {
  route(app, 'get', '/pharmacy/queue', 'pharmacy.read', async (req, tx) => {
    const t = req.ctx.tenantId; const day = String((req.query as any).day ?? todayIn(req.ctx.timezone));
    const encs = await tx.select({ e: encounter, p: { id: patient.id, fullName: patient.fullName, patientNo: patient.patientNo, phone: patient.phone, ageYears: patient.ageYears, sex: patient.sex, allergies: patient.allergies }, opNumber: visit.opNumber })
      .from(encounter).innerJoin(visit, eq(visit.id, encounter.visitId)).innerJoin(patient, eq(patient.id, encounter.patientId))
      .where(and(eq(encounter.tenantId, t), eq(visit.day, day), eq(encounter.status, 'completed'))).orderBy(asc(encounter.completedAt));
    if (!encs.length) return [];
    const items = await tx.select().from(prescriptionItem).where(and(eq(prescriptionItem.tenantId, t), sql`${prescriptionItem.encounterId} in ${encs.map((x) => x.e.id)}`)).orderBy(asc(prescriptionItem.sortOrder));
    const bills = await tx.select().from(charge).where(and(eq(charge.tenantId, t), sql`${charge.visitId} in ${encs.map((x) => x.e.visitId)}`, sql`${charge.description} like 'Pharmacy%'`));
    return encs.map((x) => ({ encounterId: x.e.id, visitId: x.e.visitId, completedAt: x.e.completedAt, opNumber: x.opNumber, patient: x.p,
      items: items.filter((i) => i.encounterId === x.e.id), bill: bills.find((b) => b.visitId === x.e.visitId) ?? null }))
      .filter((x) => x.items.length > 0);
  });

  route(app, 'patch', '/prescription-items/:id', 'pharmacy.dispense', async (req, tx) => {
    const body = z.object({ dispensed: z.boolean() }).parse(req.body);
    const [row] = await tx.update(prescriptionItem).set({ dispensed: body.dispensed }).where(and(eq(prescriptionItem.id, (req.params as any).id), eq(prescriptionItem.tenantId, req.ctx.tenantId))).returning();
    if (!row) throw new HttpError(404, 'NOT_FOUND');
    return row;
  });

  /** One pharmacy bill per visit: amount typed by the pharmacist (no inventory yet), paid immediately. */
  route(app, 'post', '/pharmacy/bill', 'pharmacy.bill', async (req, tx) => {
    const body = z.object({ visitId: z.string().uuid(), patientId: z.string().uuid(), amountPaise: z.number().int().positive(), method: z.enum(['cash', 'upi', 'card']), taxRateBp: z.number().int().default(0), note: z.string().optional() }).parse(req.body);
    const t = req.ctx.tenantId;
    const existing = await tx.select().from(charge).where(and(eq(charge.tenantId, t), eq(charge.visitId, body.visitId), sql`${charge.description} like 'Pharmacy%'`)).then((r) => r[0]);
    if (existing) throw new HttpError(409, 'ALREADY_BILLED');
    const [ch] = await tx.insert(charge).values({ tenantId: t, patientId: body.patientId, visitId: body.visitId, description: `Pharmacy${body.note ? ` · ${body.note}` : ''}`, amountPaise: body.amountPaise, taxRateBp: body.taxRateBp, status: 'paid' }).returning();
    await tx.insert(payment).values({ tenantId: t, patientId: body.patientId, chargeId: ch.id, amountPaise: body.amountPaise, method: body.method, receivedBy: req.ctx.userId });
    await tx.update(prescriptionItem).set({ dispensed: true }).where(and(eq(prescriptionItem.tenantId, t), sql`${prescriptionItem.encounterId} in (select id from encounter where visit_id = ${body.visitId})`));
    await emit(tx, req.ctx, 'pharmacy.billed', 'charge', ch.id, { visitId: body.visitId, amountPaise: body.amountPaise, method: body.method });
    return ch;
  });
}
