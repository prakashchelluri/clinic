import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, sql, asc, desc, ilike, gte, lte, lt, or, inArray, gt } from 'drizzle-orm';
import { encounter, prescriptionItem, patient, visit, charge, payment, medicine, pharmacySale, tenant, practitioner, stockBatch, message, type SaleLine } from '../db/schema.js';
import type { Tx } from '../db/index.js';
import { route } from '../lib/route.js';
import { auditView } from '../lib/audit.js';
import { emit, todayIn, nextNumber, addDays } from '../lib/core.js';
import { HttpError, can } from '../lib/auth.js';
import { allocate, moveStock, type Actor } from './stock.js';

/**
 * Packs the doctor's prescription works out to: tablets per day × days ÷ strip size, rounded up. Frequency is free
 * text ("1-0-1", "twice daily", "at night"). Creams, gels and bottles are one pack. The pharmacist can always change it.
 */
export function prescribedQty(it: { frequency: string | null; dose: string | null; durationDays: number | null }, med?: { form: string | null; packSize: number } | null) {
  if (!med || !['tab', 'cap'].includes(med.form ?? '')) return 1;
  const f = (it.frequency ?? '').toLowerCase();
  const grid = f.match(/(\d)\s*-\s*(\d)\s*-\s*(\d)/);
  let perDay = grid ? Number(grid[1]) + Number(grid[2]) + Number(grid[3])
    : /four times|qid/.test(f) ? 4 : /thrice|three times|tds|tid/.test(f) ? 3 : /twice|two times|\bbd\b|bid/.test(f) ? 2 : 1;
  if (/alternate|every other/.test(f)) perDay = 0.5;
  if (/weekly|once a week/.test(f)) perDay = 1 / 7;
  const dose = Number((it.dose ?? '').match(/\d+(\.\d+)?/)?.[0] ?? 1) || 1;
  return Math.max(1, Math.ceil((perDay * dose * (it.durationDays ?? 1)) / Math.max(1, med.packSize)));
}

const rxStatus = (items: { prescribed: number; issuedQty: number; notIssuedReason: string | null }[]) =>
  items.every((i) => i.issuedQty >= i.prescribed) ? 'issued' : items.some((i) => i.issuedQty > 0) ? 'part' : items.every((i) => i.notIssuedReason) ? 'nothing' : 'none';

/** Pharmacy counter: the doctor's prescriptions to pick from, issue what the patient buys, bills and returns. */
export function pharmacyRoutes(app: FastifyInstance) {
  /**
   * Today's prescriptions (nothing here is a task), balances still to collect from the last 30 days, or a search
   * by name, phone, OP or patient number across the last 30 days.
   */
  route(app, 'get', '/pharmacy/counter', 'pharmacy.read', async (req, tx) => {
    const t = req.ctx.tenantId; const day = todayIn(req.ctx.timezone);
    const q = z.object({ q: z.string().trim().max(80).optional() }).parse(req.query).q;
    const from = addDays(day, -30);
    const encs = await tx.select({ e: encounter, p: { id: patient.id, fullName: patient.fullName, patientNo: patient.patientNo, phone: patient.phone }, opNumber: visit.opNumber, day: visit.day, doctor: practitioner.name })
      .from(encounter).innerJoin(visit, eq(visit.id, encounter.visitId)).innerJoin(patient, eq(patient.id, encounter.patientId)).leftJoin(practitioner, eq(practitioner.id, encounter.practitionerId))
      .where(and(eq(encounter.tenantId, t), eq(encounter.status, 'completed'), gte(visit.day, from), lte(visit.day, day),
        q ? or(ilike(patient.fullName, `%${q}%`), ilike(patient.phone, `%${q}%`), ilike(visit.opNumber, `%${q}%`), ilike(patient.patientNo, `%${q}%`)) : undefined))
      .orderBy(desc(encounter.completedAt)).limit(300);
    if (!encs.length) return { today: [], balances: [], found: [] };
    const items = await tx.select({ i: prescriptionItem, form: medicine.form, packSize: medicine.packSize }).from(prescriptionItem).leftJoin(medicine, eq(medicine.id, prescriptionItem.medicineId))
      .where(and(eq(prescriptionItem.tenantId, t), inArray(prescriptionItem.encounterId, encs.map((x) => x.e.id))));
    const rows = encs.map((x) => {
      const its = items.filter((i) => i.i.encounterId === x.e.id).map((i) => ({ ...i.i, prescribed: prescribedQty(i.i, i.form ? { form: i.form, packSize: i.packSize ?? 1 } : null) }));
      const balance = its.filter((i) => i.issuedQty > 0 && i.issuedQty < i.prescribed).map((i) => ({ name: i.name, left: i.prescribed - i.issuedQty }));
      return { encounterId: x.e.id, completedAt: x.e.completedAt, day: x.day, opNumber: x.opNumber, doctor: x.doctor, patient: x.p, items: its.length, status: rxStatus(its), balance };
    }).filter((r) => r.items > 0);
    if (q) return { today: [], balances: [], found: rows };
    return { today: rows.filter((r) => r.day === day), balances: rows.filter((r) => r.day !== day && r.balance.length), found: [] };
  });

  /** One prescription at the counter: each line with the packs it works out to, what was issued, and the stock to issue from. */
  route(app, 'get', '/pharmacy/rx/:encounterId', 'pharmacy.read', async (req, tx) => {
    const t = req.ctx.tenantId; const day = todayIn(req.ctx.timezone);
    const [x] = await tx.select({ e: encounter, p: patient, opNumber: visit.opNumber, doctor: practitioner.name }).from(encounter).innerJoin(visit, eq(visit.id, encounter.visitId)).innerJoin(patient, eq(patient.id, encounter.patientId))
      .leftJoin(practitioner, eq(practitioner.id, encounter.practitionerId)).where(and(eq(encounter.id, (req.params as any).encounterId), eq(encounter.tenantId, t)));
    if (!x) throw new HttpError(404, 'NOT_FOUND');
    await auditView(tx, req, x.p.id, 'Opened the prescription at the pharmacy counter');
    const its = await tx.select({ i: prescriptionItem, m: medicine }).from(prescriptionItem).leftJoin(medicine, eq(medicine.id, prescriptionItem.medicineId))
      .where(and(eq(prescriptionItem.tenantId, t), eq(prescriptionItem.encounterId, x.e.id))).orderBy(asc(prescriptionItem.sortOrder));
    const medIds = its.map((i) => i.m?.id).filter(Boolean) as string[];
    const batches = medIds.length ? await tx.select().from(stockBatch).where(and(eq(stockBatch.tenantId, t), inArray(stockBatch.medicineId, medIds), gt(stockBatch.qty, 0), gte(stockBatch.expiry, day))).orderBy(asc(stockBatch.expiry), asc(stockBatch.createdAt)) : [];
    const bills = await tx.select({ id: pharmacySale.id, invoiceNo: pharmacySale.invoiceNo, totalPaise: pharmacySale.totalPaise, createdAt: pharmacySale.createdAt }).from(pharmacySale).where(and(eq(pharmacySale.tenantId, t), eq(pharmacySale.encounterId, x.e.id))).orderBy(asc(pharmacySale.createdAt));
    const dx = x.e.data?.diagnoses ?? x.e.data?.diagnosis ?? x.e.data?.assessment?.diagnosis ?? x.e.data?.assessment?.diagnoses;
    const items = its.map(({ i, m }) => {
      const prescribed = prescribedQty(i, m); const bs = m ? batches.filter((b) => b.medicineId === m.id) : [];
      return { ...i, prescribed, left: Math.max(0, prescribed - i.issuedQty), medicine: m ? { id: m.id, name: m.name, form: m.form, packSize: m.packSize, mrpPaise: m.mrpPaise, gstBp: m.gstBp, scheduleClass: m.scheduleClass } : null,
        onHand: bs.reduce((n, b) => n + b.qty, 0), batches: bs.map((b) => ({ id: b.id, batchNo: b.batchNo, expiry: b.expiry, qty: b.qty, mrpPaise: b.mrpPaise || m!.mrpPaise })) };
    });
    return { encounterId: x.e.id, completedAt: x.e.completedAt, opNumber: x.opNumber, doctor: x.doctor, diagnosis: Array.isArray(dx) ? dx.map((d: any) => d?.name ?? d?.label ?? d).join(', ') : dx ?? null,
      patient: { id: x.p.id, fullName: x.p.fullName, patientNo: x.p.patientNo, phone: x.p.phone, ageYears: x.p.ageYears, sex: x.p.sex, allergies: x.p.allergies }, items, bills, status: rxStatus(items) };
  });

  /** The medicine list for adding an item to a bill: price, stock on hand and the batches it can come from. */
  route(app, 'get', '/pharmacy/medicines', 'pharmacy.read', async (req, tx) => {
    const t = req.ctx.tenantId; const day = todayIn(req.ctx.timezone);
    const meds = await tx.select().from(medicine).where(eq(medicine.tenantId, t)).orderBy(asc(medicine.name));
    const bs = await tx.select().from(stockBatch).where(and(eq(stockBatch.tenantId, t), gt(stockBatch.qty, 0), gte(stockBatch.expiry, day))).orderBy(asc(stockBatch.expiry), asc(stockBatch.createdAt));
    return meds.map((m) => { const mine = bs.filter((b) => b.medicineId === m.id);
      return { id: m.id, name: m.name, form: m.form, packSize: m.packSize, mrpPaise: m.mrpPaise, gstBp: m.gstBp, scheduleClass: m.scheduleClass, onHand: mine.reduce((n, b) => n + b.qty, 0),
        batches: mine.map((b) => ({ id: b.id, batchNo: b.batchNo, expiry: b.expiry, qty: b.qty, mrpPaise: b.mrpPaise || m.mrpPaise })) }; });
  });

  /** The patient bought nothing: lines not issued get the reason, and the prescription leaves the counter's way. */
  route(app, 'post', '/pharmacy/rx/:encounterId/nothing', 'pharmacy.bill', async (req, tx) => {
    const reason = z.object({ reason: z.string().trim().max(80).optional() }).parse(req.body ?? {}).reason || 'Bought nothing';
    const r = await tx.update(prescriptionItem).set({ notIssuedReason: reason }).where(and(eq(prescriptionItem.tenantId, req.ctx.tenantId), eq(prescriptionItem.encounterId, (req.params as any).encounterId), eq(prescriptionItem.issuedQty, 0))).returning({ id: prescriptionItem.id });
    return { ok: true, lines: r.length };
  });

  route(app, 'post', '/pharmacy/sale', 'pharmacy.bill', async (req, tx) => {
    const body = SaleIn.parse(req.body);
    const [tn] = await tx.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, req.ctx.tenantId));
    return recordSale(tx, { tenantId: req.ctx.tenantId, userId: req.ctx.userId, name: req.ctx.name }, body, { ctx: req.ctx, maxDiscountBp: can(req.perms, 'stock.approve') ? 10000 : (tn?.settings as any)?.pharmacy?.maxDiscountBp ?? 1000 });
  });

  /** One sale with everything a receipt needs. */
  route(app, 'get', '/pharmacy/sale/:id', 'pharmacy.read', async (req, tx) => {
    const t = req.ctx.tenantId;
    const [r] = await tx.select({ sale: pharmacySale, patient: { fullName: patient.fullName, phone: patient.phone, patientNo: patient.patientNo, ageYears: patient.ageYears, sex: patient.sex } })
      .from(pharmacySale).innerJoin(patient, eq(patient.id, pharmacySale.patientId)).where(and(eq(pharmacySale.tenantId, t), eq(pharmacySale.id, (req.params as any).id)));
    if (!r) throw new HttpError(404, 'NOT_FOUND');
    const [tn] = await tx.select({ name: tenant.name, settings: tenant.settings }).from(tenant).where(eq(tenant.id, t));
    const doc = r.sale.encounterId ? (await tx.select({ name: practitioner.name }).from(encounter).leftJoin(practitioner, eq(practitioner.id, encounter.practitionerId)).where(eq(encounter.id, r.sale.encounterId)))[0]?.name ?? null : null;
    const notIssued = r.sale.encounterId ? await notIssuedOn(tx, t, r.sale.encounterId) : [];
    const s = (tn?.settings as any) ?? {};
    return { ...r.sale, patient: r.patient, doctor: doc, notIssued, clinic: { name: tn?.name, address: s.address ?? null, gstin: s.gstin ?? null, drugLicence: s.drugLicence ?? null } };
  });

  /**
   * Schedule H / H1 / X register, built from the bills: date, bill, patient, prescriber with registration number, medicine, batch, quantity.
   * Nobody types into it. A sale with no prescription behind it is marked, since these drugs need one.
   */
  route(app, 'get', '/pharmacy/schedule-register', 'pharmacy.read', async (req, tx) => {
    const t = req.ctx.tenantId; const today = todayIn(req.ctx.timezone); const tz = req.ctx.timezone;
    const q = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(addDays(today, -29)), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(today), cls: z.enum(['all', 'H', 'H1', 'X']).default('all') }).parse(req.query);
    if (q.from > q.to) throw new HttpError(400, 'BAD_RANGE');
    const meds = await tx.select({ id: medicine.id, cls: medicine.scheduleClass }).from(medicine).where(and(eq(medicine.tenantId, t), inArray(medicine.scheduleClass, ['H', 'H1', 'X'])));
    const cls = new Map(meds.map((m) => [m.id, m.cls as string]));
    const on = sql`(${pharmacySale.createdAt} at time zone ${tz})::date`;
    const rows = await tx.select({ s: pharmacySale, p: { fullName: patient.fullName, patientNo: patient.patientNo, ageYears: patient.ageYears, sex: patient.sex, locality: patient.locality }, doctor: practitioner.name, regNo: practitioner.regNo })
      .from(pharmacySale).innerJoin(patient, eq(patient.id, pharmacySale.patientId)).leftJoin(encounter, eq(encounter.id, pharmacySale.encounterId)).leftJoin(practitioner, eq(practitioner.id, encounter.practitionerId))
      .where(and(eq(pharmacySale.tenantId, t), gte(on, q.from), lte(on, q.to))).orderBy(asc(pharmacySale.createdAt)).limit(5000);
    const out: any[] = [];
    for (const { s, p, doctor, regNo } of rows) s.items.forEach((l, i) => {
      const c = cls.get(l.medicineId); if (!c || (q.cls !== 'all' && c !== q.cls)) return;
      const returned = s.returns.reduce((n, r) => n + (r.lines.find((x) => x.line === i)?.qty ?? 0), 0);
      out.push({ at: s.createdAt, invoiceNo: s.invoiceNo, patient: p.fullName, patientNo: p.patientNo, age: p.ageYears, sex: p.sex, address: p.locality, doctor: doctor ?? null, regNo: regNo ?? null,
        medicine: l.name, cls: c, batchNo: l.batchNo ?? null, expiry: l.expiry ?? null, qty: l.qty, returned, noRx: !s.encounterId });
    });
    return out;
  });
  /** Printing or downloading the register is a legal record, so every pharmacist may; it is written to the audit log. */
  route(app, 'post', '/pharmacy/schedule-register/export', 'pharmacy.read', async (req) => {
    z.object({ from: z.string(), to: z.string(), how: z.enum(['print', 'csv']) }).parse(req.body); return { ok: true };
  });

  /** Bills in a date range with refunds, and what the drawer should hold. */
  route(app, 'get', '/pharmacy/bills', 'pharmacy.read', async (req, tx) => {
    const t = req.ctx.tenantId; const today = todayIn(req.ctx.timezone);
    const q = z.object({ from: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/).default(today), to: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/).default(today), q: z.string().trim().max(80).optional() }).parse(req.query);
    if (q.from > q.to) throw new HttpError(400, 'BAD_RANGE');
    const tz = req.ctx.timezone; const on = sql`(${pharmacySale.createdAt} at time zone ${tz})::date`;
    const rows = await tx.select({ s: pharmacySale, p: { id: patient.id, fullName: patient.fullName, patientNo: patient.patientNo, phone: patient.phone }, doctor: practitioner.name })
      .from(pharmacySale).innerJoin(patient, eq(patient.id, pharmacySale.patientId)).leftJoin(encounter, eq(encounter.id, pharmacySale.encounterId)).leftJoin(practitioner, eq(practitioner.id, encounter.practitionerId))
      .where(and(eq(pharmacySale.tenantId, t), gte(on, q.from), lte(on, q.to), q.q ? or(ilike(patient.fullName, `%${q.q}%`), ilike(pharmacySale.invoiceNo, `%${q.q}%`), ilike(patient.phone, `%${q.q}%`)) : undefined))
      .orderBy(desc(pharmacySale.createdAt)).limit(500);
    const totals = { count: rows.length, total: 0, refunds: 0, gst: 0, cash: 0, upi: 0, card: 0, returns: 0 } as Record<string, number>;
    for (const { s } of rows) {
      totals.total += s.totalPaise; totals.gst += s.gstPaise;
      for (const p of s.payments) totals[p.method] = (totals[p.method] ?? 0) + p.amountPaise;
      for (const r of s.returns) { totals.refunds += r.refundPaise; totals[r.method] = (totals[r.method] ?? 0) - r.refundPaise; totals.returns++; }
    }
    const encIds = rows.map((r) => r.s.encounterId).filter(Boolean) as string[];
    const left = encIds.length ? await tx.select({ e: prescriptionItem.encounterId, i: prescriptionItem, form: medicine.form, packSize: medicine.packSize }).from(prescriptionItem).leftJoin(medicine, eq(medicine.id, prescriptionItem.medicineId)).where(and(eq(prescriptionItem.tenantId, t), inArray(prescriptionItem.encounterId, encIds))) : [];
    const rx = await tx.select({ id: encounter.id, issued: sql<number>`coalesce((select sum(pi.issued_qty) from prescription_item pi where pi.encounter_id = ${encounter.id}), 0)::int`, lines: sql<number>`(select count(*) from prescription_item pi where pi.encounter_id = ${encounter.id})::int` })
      .from(encounter).innerJoin(visit, eq(visit.id, encounter.visitId)).where(and(eq(encounter.tenantId, t), eq(encounter.status, 'completed'), gte(visit.day, q.from), lte(visit.day, q.to)));
    const withRx = rx.filter((r) => r.lines > 0);
    return {
      rows: rows.map(({ s, p, doctor }) => {
        const its = left.filter((x) => x.e === s.encounterId).map((x) => ({ ...x.i, prescribed: prescribedQty(x.i, x.form ? { form: x.form, packSize: x.packSize ?? 1 } : null) }));
        return { id: s.id, invoiceNo: s.invoiceNo, at: s.createdAt, patient: p, doctor, encounterId: s.encounterId, items: s.items.length, detail: s.items.map((i) => `${i.name} ×${i.qty}`).join(', '),
          totalPaise: s.totalPaise, method: s.method, payments: s.payments, refundPaise: s.returns.reduce((n, r) => n + r.refundPaise, 0), returns: s.returns.length,
          balance: its.filter((i) => i.issuedQty > 0 && i.issuedQty < i.prescribed).map((i) => ({ name: i.name, left: i.prescribed - i.issuedQty })),
          notIssued: its.filter((i) => i.issuedQty === 0).length };
      }),
      totals, rx: { total: withRx.length, notBought: withRx.filter((r) => r.issued === 0).length },
    };
  });

  /** Items back from a patient: into the same batch, refund in the chosen mode, credit note number. */
  route(app, 'post', '/pharmacy/sale/:id/return', 'pharmacy.return', async (req, tx) => {
    const b = ReturnIn.parse(req.body);
    return returnItems(tx, { tenantId: req.ctx.tenantId, userId: req.ctx.userId, name: req.ctx.name }, (req.params as any).id, b, req.ctx);
  });
  /** Cancel a whole bill: everything not yet returned comes back. Owner only. */
  route(app, 'post', '/pharmacy/sale/:id/cancel', 'stock.approve', async (req, tx) => {
    const b = z.object({ reason: z.string().trim().min(3).max(200), method: z.enum(['cash', 'upi', 'card']), reference: z.string().trim().max(40).optional() }).parse(req.body);
    const [s] = await tx.select().from(pharmacySale).where(and(eq(pharmacySale.id, (req.params as any).id), eq(pharmacySale.tenantId, req.ctx.tenantId)));
    if (!s) throw new HttpError(404, 'NOT_FOUND');
    const lines = s.items.map((l, i) => ({ line: i, qty: l.qty - returnedQty(s, i) })).filter((l) => l.qty > 0);
    if (!lines.length) throw new HttpError(409, 'NOTHING_TO_RETURN');
    return returnItems(tx, { tenantId: req.ctx.tenantId, userId: req.ctx.userId, name: req.ctx.name }, s.id, { ...b, lines }, req.ctx);
  });
}

async function notIssuedOn(tx: Tx, t: string, encounterId: string) {
  const its = await tx.select({ i: prescriptionItem, form: medicine.form, packSize: medicine.packSize }).from(prescriptionItem).leftJoin(medicine, eq(medicine.id, prescriptionItem.medicineId)).where(and(eq(prescriptionItem.tenantId, t), eq(prescriptionItem.encounterId, encounterId)));
  return its.map((x) => ({ name: x.i.name, left: prescribedQty(x.i, x.form ? { form: x.form, packSize: x.packSize ?? 1 } : null) - x.i.issuedQty, reason: x.i.notIssuedReason })).filter((x) => x.left > 0);
}

const returnedQty = (s: { returns: { lines: { line: number; qty: number }[] }[] }, line: number) => s.returns.reduce((n, r) => n + r.lines.filter((l) => l.line === line).reduce((k, l) => k + l.qty, 0), 0);

const Pay = z.object({ method: z.enum(['cash', 'upi', 'card']), amountPaise: z.number().int().min(1).max(100000000), reference: z.string().trim().max(40).optional().nullable() });
export const SaleIn = z.object({
  patientId: z.string().uuid().optional(),
  newPatient: z.object({ fullName: z.string().trim().min(2).max(100), phone: z.string().regex(/^[0-9]{10}$/), ageYears: z.number().int().min(0).max(120).optional(), sex: z.enum(['M', 'F', 'O']).optional() }).optional(),
  encounterId: z.string().uuid().optional(),
  items: z.array(z.object({ medicineId: z.string().uuid(), qty: z.number().int().min(1).max(999), batchId: z.string().uuid().optional().nullable(), prescriptionItemId: z.string().uuid().optional().nullable() })).min(1).max(40),
  notIssued: z.array(z.object({ prescriptionItemId: z.string().uuid(), reason: z.string().trim().max(80).optional().nullable() })).max(40).default([]),
  discountPaise: z.number().int().min(0).default(0),
  payments: z.array(Pay).min(1).max(3).optional(),
  method: z.enum(['cash', 'upi', 'card']).optional(),          // one payment, the older shape
  reference: z.string().trim().max(40).optional(),
  receivedPaise: z.number().int().min(0).optional(),           // cash handed over
  whatsapp: z.boolean().default(false),
  at: z.string().optional(), // test data only: back-dated sales
});
const ReturnIn = z.object({ lines: z.array(z.object({ line: z.number().int().min(0), qty: z.number().int().min(1).max(999) })).min(1).max(40), reason: z.string().trim().min(3).max(200), method: z.enum(['cash', 'upi', 'card']), reference: z.string().trim().max(40).optional() });

/**
 * One pharmacy bill. Stock is taken from the chosen batch or the one expiring first; prices are the batch MRP (GST
 * inside). Against a prescription, issued packs are added to each line and a short or skipped line keeps its reason.
 * Payment can be split across cash, UPI and card; UPI and card need a reference. Also used by the test-data loader.
 */
export async function recordSale(tx: Tx, a: Actor, body: z.infer<typeof SaleIn>, opt: { ctx?: { timezone: string } & Record<string, any>; maxDiscountBp?: number } = {}) {
  const t = a.tenantId; const day = todayIn(opt.ctx?.timezone ?? 'Asia/Kolkata');
  let pid = body.patientId;
  if (pid) { if (!(await tx.select({ id: patient.id }).from(patient).where(and(eq(patient.id, pid), eq(patient.tenantId, t))))[0]) throw new HttpError(404, 'NOT_FOUND'); }
  else if (body.newPatient) {
    const np = body.newPatient;
    pid = (await tx.select({ id: patient.id }).from(patient).where(and(eq(patient.tenantId, t), eq(patient.phone, np.phone), ilike(patient.fullName, np.fullName))).limit(1))[0]?.id;
    if (!pid) { const n = await nextNumber(tx, t, 'patient_no', 'tenant'); pid = (await tx.insert(patient).values({ tenantId: t, patientNo: `P${String(n).padStart(5, '0')}`, fullName: np.fullName, phone: np.phone, ageYears: np.ageYears ?? null, sex: np.sex ?? null }).returning({ id: patient.id }))[0].id; }
  } else throw new HttpError(400, 'PATIENT_REQUIRED');

  const rxItems = body.encounterId ? await tx.select().from(prescriptionItem).where(and(eq(prescriptionItem.tenantId, t), eq(prescriptionItem.encounterId, body.encounterId))) : [];
  if (body.encounterId) {
    const [e] = await tx.select({ patientId: encounter.patientId }).from(encounter).where(and(eq(encounter.id, body.encounterId), eq(encounter.tenantId, t)));
    if (!e) throw new HttpError(404, 'RX_NOT_FOUND');
    if (e.patientId !== pid) throw new HttpError(400, 'RX_NOT_FOR_PATIENT');
  }
  for (const id of [...body.items.map((i) => i.prescriptionItemId).filter(Boolean), ...body.notIssued.map((n) => n.prescriptionItemId)]) if (!rxItems.some((r) => r.id === id)) throw new HttpError(400, 'NOT_ON_THIS_RX');

  const meds = await tx.select().from(medicine).where(and(eq(medicine.tenantId, t), inArray(medicine.id, body.items.map((i) => i.medicineId))));
  const lines: SaleLine[] = []; const takes: { line: number; batchId: string; qty: number }[] = [];
  for (const i of body.items) {
    const m = meds.find((x) => x.id === i.medicineId); if (!m) throw new HttpError(400, 'UNKNOWN_MEDICINE');
    let parts;
    try { parts = await allocate(tx, t, m.id, i.qty, day, i.batchId); }
    catch (e: any) { if (e instanceof HttpError && e.message === 'NOT_ENOUGH_STOCK') throw new HttpError(409, 'NOT_ENOUGH_STOCK', { name: m.name, onHand: e.extra?.onHand }); throw e; }
    for (const p of parts) {
      const mrp = p.batch.mrpPaise || m.mrpPaise; if (mrp <= 0) throw new HttpError(400, 'NO_PRICE', { name: m.name });
      takes.push({ line: lines.length, batchId: p.batch.id, qty: p.qty });
      lines.push({ medicineId: m.id, name: m.name, hsn: m.hsn, qty: p.qty, mrpPaise: mrp, gstBp: m.gstBp, amountPaise: p.qty * mrp, batchId: p.batch.id, batchNo: p.batch.batchNo, expiry: p.batch.expiry, prescriptionItemId: i.prescriptionItemId ?? null });
    }
  }
  const gross = lines.reduce((n, l) => n + l.amountPaise, 0);
  if (body.discountPaise > gross) throw new HttpError(400, 'DISCOUNT_TOO_BIG');
  if (opt.maxDiscountBp !== undefined && body.discountPaise * 10000 > gross * opt.maxDiscountBp) throw new HttpError(403, 'DISCOUNT_NEEDS_OWNER', { maxPct: opt.maxDiscountBp / 100 });
  const total = gross - body.discountPaise;
  if (total <= 0) throw new HttpError(400, 'BAD_AMOUNT');
  const gstInGross = lines.reduce((n, l) => n + (l.amountPaise - Math.round((l.amountPaise * 10000) / (10000 + l.gstBp))), 0);
  const gst = Math.round((gstInGross * total) / gross); // the discount reduces the taxable value too

  const pays = body.payments ?? (body.method ? [{ method: body.method, amountPaise: total, reference: body.reference ?? null }] : null);
  if (!pays) throw new HttpError(400, 'PAYMENT_REQUIRED');
  if (new Set(pays.map((p) => p.method)).size !== pays.length) throw new HttpError(400, 'DUPLICATE_METHOD');
  for (const p of pays) if (p.method !== 'cash' && (p.reference ?? '').length < 4) throw new HttpError(400, 'REFERENCE_REQUIRED', { method: p.method });
  if (pays.reduce((n, p) => n + p.amountPaise, 0) !== total) throw new HttpError(400, 'PAYMENTS_DO_NOT_ADD_UP', { totalPaise: total });
  const cash = pays.find((p) => p.method === 'cash')?.amountPaise ?? 0;
  if (cash && body.receivedPaise !== undefined && body.receivedPaise < cash) throw new HttpError(400, 'RECEIVED_TOO_LOW');

  const when = body.at ?? new Date().toISOString();
  const n = await nextNumber(tx, t, 'pharmacy_invoice', 'tenant');
  const invoiceNo = `PH-${String(n).padStart(5, '0')}`;
  const [ch] = await tx.insert(charge).values({ tenantId: t, patientId: pid, description: `Pharmacy · ${body.encounterId ? 'Prescription' : 'Counter sale'} · ${invoiceNo}`, amountPaise: total, taxRateBp: 0, status: 'paid', createdAt: when }).returning();
  for (const p of pays) await tx.insert(payment).values({ tenantId: t, patientId: pid, chargeId: ch.id, amountPaise: p.amountPaise, method: p.method, reference: p.method === 'cash' ? null : p.reference, receivedBy: a.userId, receivedAt: when, createdAt: when });
  const method = pays.length > 1 ? 'split' : pays[0].method;
  const [sale] = await tx.insert(pharmacySale).values({ tenantId: t, invoiceNo, patientId: pid, chargeId: ch.id, encounterId: body.encounterId ?? null, items: lines, grossPaise: gross, discountPaise: body.discountPaise, gstPaise: gst, totalPaise: total,
    method, reference: pays.filter((p) => p.method !== 'cash').map((p) => p.reference).join(' · ') || null, payments: pays.map((p) => ({ method: p.method, amountPaise: p.amountPaise, reference: p.method === 'cash' ? null : p.reference ?? null })),
    receivedPaise: cash ? body.receivedPaise ?? cash : null, createdBy: a.userId, createdAt: when }).returning();
  for (const x of takes) await moveStock(tx, a, x.batchId, -x.qty, 'sale', { id: sale.id, no: invoiceNo, at: body.at });

  for (const it of rxItems) {
    const got = lines.filter((l) => l.prescriptionItemId === it.id).reduce((k, l) => k + l.qty, 0);
    const why = body.notIssued.find((x) => x.prescriptionItemId === it.id);
    if (!got && !why) continue;
    await tx.update(prescriptionItem).set({ issuedQty: it.issuedQty + got, dispensed: it.dispensed || got > 0, notIssuedReason: why ? why.reason || 'Not issued' : it.notIssuedReason }).where(eq(prescriptionItem.id, it.id));
  }
  if (body.whatsapp) {
    const [p] = await tx.select({ phone: patient.phone, fullName: patient.fullName }).from(patient).where(eq(patient.id, pid));
    if (p?.phone) await tx.insert(message).values({ tenantId: t, patientId: pid, kind: 'pharmacy_receipt', channel: 'whatsapp', toPhone: p.phone, params: { patient: p.fullName },
      body: [`Pharmacy bill ${invoiceNo}`, ...lines.map((l) => `${l.name} × ${l.qty} · ₹${(l.amountPaise / 100).toFixed(2)}`), `Total ₹${(total / 100).toFixed(2)} (GST included)`].join('\n'), status: 'pending' });
  }
  if (opt.ctx) await emit(tx, opt.ctx as any, 'pharmacy.sold', 'pharmacy_sale', sale.id, { invoiceNo, totalPaise: total, method });
  return sale;
}

async function returnItems(tx: Tx, a: Actor, saleId: string, b: z.infer<typeof ReturnIn>, ctx: any) {
  const t = a.tenantId;
  const [s] = await tx.select().from(pharmacySale).where(and(eq(pharmacySale.id, saleId), eq(pharmacySale.tenantId, t))).for('update');
  if (!s) throw new HttpError(404, 'NOT_FOUND');
  if (b.method !== 'cash' && (b.reference ?? '').length < 4) throw new HttpError(400, 'REFERENCE_REQUIRED');
  const lines = b.lines.map((r) => {
    const l = s.items[r.line]; if (!l) throw new HttpError(400, 'NO_SUCH_LINE');
    if (r.qty > l.qty - returnedQty(s, r.line)) throw new HttpError(400, 'MORE_THAN_SOLD', { name: l.name });
    return { ...r, amountPaise: Math.round((l.amountPaise * r.qty * s.totalPaise) / (l.qty * s.grossPaise)) }; // the bill's discount is shared out
  });
  const refund = lines.reduce((n, l) => n + l.amountPaise, 0);
  const n = await nextNumber(tx, t, 'pharmacy_cn', 'tenant'); const cn = `CN-${String(n).padStart(4, '0')}`;
  for (const r of lines) {
    const l = s.items[r.line];
    if (l.batchId) await moveStock(tx, a, l.batchId, r.qty, 'patient_return', { id: s.id, no: cn, note: b.reason });
    if (l.prescriptionItemId) await tx.update(prescriptionItem).set({ issuedQty: sql`greatest(0, ${prescriptionItem.issuedQty} - ${r.qty})` }).where(eq(prescriptionItem.id, l.prescriptionItemId));
  }
  if (s.chargeId) await tx.insert(payment).values({ tenantId: t, patientId: s.patientId, chargeId: s.chargeId, amountPaise: -refund, method: b.method, reference: b.method === 'cash' ? cn : `${cn} · ${b.reference}`, receivedBy: a.userId });
  const ret = { creditNoteNo: cn, at: new Date().toISOString(), by: a.name, reason: b.reason, method: b.method, reference: b.reference ?? null, refundPaise: refund, lines };
  await tx.update(pharmacySale).set({ returns: [...s.returns, ret] }).where(eq(pharmacySale.id, s.id));
  await emit(tx, ctx, 'pharmacy.returned', 'pharmacy_sale', s.id, { creditNoteNo: cn, refundPaise: refund });
  return ret;
}
