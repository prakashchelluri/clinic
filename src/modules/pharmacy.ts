import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, sql, asc, desc, ilike, gte, lte, or, inArray } from 'drizzle-orm';
import { encounter, prescriptionItem, patient, visit, charge, payment, medicine, pharmacySale, tenant } from '../db/schema.js';
import type { Tx } from '../db/index.js';
import { route } from '../lib/route.js';
import { emit, todayIn, nextNumber } from '../lib/core.js';
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
    const body = z.object({ visitId: z.string().uuid(), patientId: z.string().uuid(), amountPaise: z.number().int().positive(), method: z.enum(['cash', 'upi', 'card']), reference: z.string().trim().max(40).optional(), taxRateBp: z.number().int().default(0), note: z.string().optional() }).parse(req.body);
    if (body.method !== 'cash' && (body.reference ?? '').length < 4) throw new HttpError(400, 'REFERENCE_REQUIRED');
    const t = req.ctx.tenantId;
    const existing = await tx.select().from(charge).where(and(eq(charge.tenantId, t), eq(charge.visitId, body.visitId), sql`${charge.description} like 'Pharmacy%'`)).then((r) => r[0]);
    if (existing) throw new HttpError(409, 'ALREADY_BILLED');
    const [ch] = await tx.insert(charge).values({ tenantId: t, patientId: body.patientId, visitId: body.visitId, description: `Pharmacy${body.note ? ` · ${body.note}` : ''}`, amountPaise: body.amountPaise, taxRateBp: body.taxRateBp, status: 'paid' }).returning();
    await tx.insert(payment).values({ tenantId: t, patientId: body.patientId, chargeId: ch.id, amountPaise: body.amountPaise, method: body.method, reference: body.method === 'cash' ? null : body.reference, receivedBy: req.ctx.userId });
    await tx.update(prescriptionItem).set({ dispensed: true }).where(and(eq(prescriptionItem.tenantId, t), sql`${prescriptionItem.encounterId} in (select id from encounter where visit_id = ${body.visitId})`));
    await emit(tx, req.ctx, 'pharmacy.billed', 'charge', ch.id, { visitId: body.visitId, amountPaise: body.amountPaise, method: body.method });
    return ch;
  });
  route(app, 'post', '/pharmacy/sale', 'pharmacy.bill', async (req, tx) => {
    const body = SaleIn.parse(req.body);
    return recordSale(tx, req.ctx.tenantId, req.ctx.userId, body, req.ctx);
  });

  /** One sale with everything a receipt needs. */
  route(app, 'get', '/pharmacy/sale/:id', 'pharmacy.read', async (req, tx) => {
    const t = req.ctx.tenantId;
    const [r] = await tx.select({ sale: pharmacySale, patient: { fullName: patient.fullName, phone: patient.phone, patientNo: patient.patientNo, ageYears: patient.ageYears, sex: patient.sex } })
      .from(pharmacySale).innerJoin(patient, eq(patient.id, pharmacySale.patientId)).where(and(eq(pharmacySale.tenantId, t), eq(pharmacySale.id, (req.params as any).id)));
    if (!r) throw new HttpError(404, 'NOT_FOUND');
    const [tn] = await tx.select({ name: tenant.name, settings: tenant.settings }).from(tenant).where(eq(tenant.id, t));
    return { ...r.sale, patient: r.patient, clinic: { name: tn?.name, address: (tn?.settings as any)?.address ?? null, gstin: (tn?.settings as any)?.gstin ?? null } };
  });

  /** Everything the pharmacy billed in a date range, prescriptions and counter sales, newest first, with totals by payment method. */
  route(app, 'get', '/pharmacy/history', 'pharmacy.read', async (req, tx) => {
    const t = req.ctx.tenantId; const today = todayIn(req.ctx.timezone);
    const q = z.object({ from: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/).default(today), to: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/).default(today), q: z.string().max(80).optional() }).parse(req.query);
    const tz = req.ctx.timezone; const at = sql`(${payment.receivedAt} at time zone ${tz})::date`;
    const rows = await tx.select({ id: charge.id, at: payment.receivedAt, description: charge.description, visitId: charge.visitId, amountPaise: payment.amountPaise, method: payment.method, reference: payment.reference,
      saleId: pharmacySale.id, invoiceNo: pharmacySale.invoiceNo, gstPaise: pharmacySale.gstPaise, items: pharmacySale.items, patient: { id: patient.id, fullName: patient.fullName, patientNo: patient.patientNo } })
      .from(payment).innerJoin(charge, eq(charge.id, payment.chargeId)).innerJoin(patient, eq(patient.id, payment.patientId)).leftJoin(pharmacySale, eq(pharmacySale.chargeId, charge.id))
      .where(and(eq(payment.tenantId, t), sql`${charge.description} like 'Pharmacy%'`, gte(at, q.from), lte(at, q.to), q.q ? or(ilike(patient.fullName, `%${q.q}%`), ilike(pharmacySale.invoiceNo, `%${q.q}%`)) : undefined))
      .orderBy(desc(payment.receivedAt)).limit(500);
    const out = rows.map(({ items, ...r }) => ({ ...r, kind: r.visitId ? 'Prescription' : 'Counter sale',
      detail: items ? items.map((i) => `${i.name} ×${i.qty}`).join(', ') : r.description.replace(/^Pharmacy( · Counter sale)?( · )?/, '') }));
    const totals = { count: out.length, total: 0, cash: 0, upi: 0, card: 0, gst: 0 } as Record<string, number>;
    for (const r of out) { totals.total += r.amountPaise; totals[r.method] = (totals[r.method] ?? 0) + r.amountPaise; totals.gst += r.gstPaise ?? 0; }
    return { rows: out, totals };
  });
}

export const SaleIn = z.object({
  patientId: z.string().uuid().optional(),
  newPatient: z.object({ fullName: z.string().trim().min(2).max(100), phone: z.string().regex(/^[0-9]{10}$/), ageYears: z.number().int().min(0).max(120).optional(), sex: z.enum(['M', 'F', 'O']).optional() }).optional(),
  items: z.array(z.object({ medicineId: z.string().uuid(), qty: z.number().int().min(1).max(999) })).min(1).max(40),
  discountPaise: z.number().int().min(0).default(0),
  method: z.enum(['cash', 'upi', 'card']),
  reference: z.string().trim().max(40).optional(),
  receivedPaise: z.number().int().min(0).optional(),
  at: z.string().optional(), // test data only: back-dated sales
});

/**
 * One counter sale. Prices and GST come from the medicine catalogue (price includes GST), the patient is required,
 * UPI and card need a payment reference, and the sale gets the next invoice number. Also used by the test-data loader.
 */
export async function recordSale(tx: Tx, t: string, userId: string, body: z.infer<typeof SaleIn>, ctx?: { timezone: string }) {
  let pid = body.patientId;
  if (pid) { if (!(await tx.select({ id: patient.id }).from(patient).where(and(eq(patient.id, pid), eq(patient.tenantId, t))))[0]) throw new HttpError(404, 'NOT_FOUND'); }
  else if (body.newPatient) {
    const np = body.newPatient;
    pid = (await tx.select({ id: patient.id }).from(patient).where(and(eq(patient.tenantId, t), eq(patient.phone, np.phone), ilike(patient.fullName, np.fullName))).limit(1))[0]?.id;
    if (!pid) { const n = await nextNumber(tx, t, 'patient_no', 'tenant'); pid = (await tx.insert(patient).values({ tenantId: t, patientNo: `P${String(n).padStart(5, '0')}`, fullName: np.fullName, phone: np.phone, ageYears: np.ageYears ?? null, sex: np.sex ?? null }).returning({ id: patient.id }))[0].id; }
  } else throw new HttpError(400, 'PATIENT_REQUIRED');
  if (body.method !== 'cash' && (body.reference ?? '').length < 4) throw new HttpError(400, 'REFERENCE_REQUIRED');

  const meds = await tx.select().from(medicine).where(and(eq(medicine.tenantId, t), inArray(medicine.id, body.items.map((i) => i.medicineId))));
  const lines = body.items.map((i) => {
    const m = meds.find((x) => x.id === i.medicineId); if (!m) throw new HttpError(400, 'UNKNOWN_MEDICINE');
    if (m.mrpPaise <= 0) throw new HttpError(400, 'NO_PRICE', { name: m.name });
    return { medicineId: m.id, name: m.name, hsn: m.hsn, qty: i.qty, mrpPaise: m.mrpPaise, gstBp: m.gstBp, amountPaise: i.qty * m.mrpPaise };
  });
  const gross = lines.reduce((n, l) => n + l.amountPaise, 0);
  if (body.discountPaise > gross) throw new HttpError(400, 'DISCOUNT_TOO_BIG');
  const total = gross - body.discountPaise;
  if (total <= 0) throw new HttpError(400, 'BAD_AMOUNT');
  const gstInGross = lines.reduce((n, l) => n + (l.amountPaise - Math.round((l.amountPaise * 10000) / (10000 + l.gstBp))), 0);
  const gst = Math.round((gstInGross * total) / gross); // the discount reduces the taxable value too
  if (body.method === 'cash' && body.receivedPaise !== undefined && body.receivedPaise < total) throw new HttpError(400, 'RECEIVED_TOO_LOW');

  const when = body.at ?? new Date().toISOString();
  const n = await nextNumber(tx, t, 'pharmacy_invoice', 'tenant');
  const invoiceNo = `PH-${String(n).padStart(5, '0')}`;
  const [ch] = await tx.insert(charge).values({ tenantId: t, patientId: pid, description: `Pharmacy · Counter sale · ${invoiceNo}`, amountPaise: total, taxRateBp: 0, status: 'paid', createdAt: when }).returning();
  await tx.insert(payment).values({ tenantId: t, patientId: pid, chargeId: ch.id, amountPaise: total, method: body.method, reference: body.method === 'cash' ? null : body.reference, receivedBy: userId, receivedAt: when, createdAt: when });
  const [sale] = await tx.insert(pharmacySale).values({ tenantId: t, invoiceNo, patientId: pid, chargeId: ch.id, items: lines, grossPaise: gross, discountPaise: body.discountPaise, gstPaise: gst, totalPaise: total,
    method: body.method, reference: body.method === 'cash' ? null : body.reference, receivedPaise: body.method === 'cash' ? body.receivedPaise ?? total : null, createdBy: userId, createdAt: when }).returning();
  if (ctx) await emit(tx, ctx as any, 'pharmacy.sold', 'pharmacy_sale', sale.id, { invoiceNo, totalPaise: total, method: body.method });
  return sale;
}
