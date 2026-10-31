import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { type PatientFlags, patient, visit, encounter, prescriptionItem, recommendation, charge, payment } from '../db/schema.js';
import { route } from '../lib/route.js';
import { auditView } from '../lib/audit.js';
import { nextNumber, emit, sent } from '../lib/core.js';
import { HttpError } from '../lib/auth.js';

const PatientIn = z.object({
  fullName: z.string().trim().min(2).max(100),
  phone: z.string().regex(/^\d{10}$/).optional().nullable(),
  sex: z.enum(['M', 'F', 'O']).optional().nullable(),
  ageYears: z.number().int().min(0).max(120).optional().nullable(),
  locality: z.string().trim().max(100).optional().nullable(),
  referralCard: z.boolean().optional(),
  allergies: z.string().max(500).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  guardianId: z.string().uuid().optional().nullable(),
  contactLabel: z.string().trim().max(40).optional().nullable(),
});

export function patientRoutes(app: FastifyInstance) {
  // Search by phone digits, name prefix or patient number. Family members sharing a phone come back as separate rows.
  route(app, 'get', '/patients', 'patient.read', async (req, tx) => {
    const q = String((req.query as any).q ?? '').trim();
    const where = q
      ? and(eq(patient.tenantId, req.ctx.tenantId), or(ilike(patient.fullName, `%${q}%`), ilike(patient.phone, `${q}%`), ilike(patient.patientNo, `%${q}%`)))
      : eq(patient.tenantId, req.ctx.tenantId);
    const rows = await tx.select().from(patient).where(where).orderBy(desc(patient.createdAt)).limit(25);
    // Two people with one name are told apart by age, last visit and main problem.
    const encs = rows.length ? await tx.select({ patientId: encounter.patientId, at: encounter.createdAt, data: encounter.data }).from(encounter)
      .where(and(eq(encounter.tenantId, req.ctx.tenantId), inArray(encounter.patientId, rows.map((r) => r.id)))).orderBy(desc(encounter.createdAt)) : [];
    const names = (x: any) => (Array.isArray(x) ? x.map((d) => (typeof d === 'string' ? d : d?.name)).filter(Boolean).join(', ') : '');
    return rows.map((p) => { const e = encs.find((x) => x.patientId === p.id); const d: any = e?.data ?? {};
      return { ...p, lastVisitAt: e?.at ?? null, mainProblem: names(d.assessment?.diagnosis) || names(d.complaint?.chief_complaint) || null }; });
  });

  // Flags: VIP, Family and friends, Handle carefully. The last one cannot be set without a reason; the doctor or owner sets and clears it.
  route(app, 'patch', '/patients/:id/flags', 'encounter.complete', async (req, tx) => {
    const id = (req.params as any).id; const t = req.ctx.tenantId;
    const b = z.object({ vip: z.boolean().optional(), family: z.boolean().optional(), careful: z.object({ note: z.string().trim().min(3, 'Say why').max(300) }).nullable().optional() }).parse(req.body);
    const cur = await tx.select().from(patient).where(and(eq(patient.id, id), eq(patient.tenantId, t))).then((r) => r[0]);
    if (!cur) throw new HttpError(404, 'NOT_FOUND');
    const flags: PatientFlags = { ...cur.flags };
    if (b.vip !== undefined) { if (b.vip) flags.vip = true; else delete flags.vip; }
    if (b.family !== undefined) { if (b.family) flags.family = true; else delete flags.family; }
    if (b.careful !== undefined) { if (b.careful) flags.careful = { note: b.careful.note, by: req.ctx.name, at: new Date().toISOString() }; else delete flags.careful; }
    req.auditBefore = { flags: cur.flags };
    const [row] = await tx.update(patient).set({ flags }).where(and(eq(patient.id, id), eq(patient.tenantId, t))).returning();
    return row;
  });

  route(app, 'post', '/patients', 'patient.write', async (req, tx) => {
    const body = PatientIn.parse(req.body);
    const t = req.ctx.tenantId;
    // Duplicate warning (not a block): same phone and same name
    if (body.phone) {
      const dup = await tx.select({ id: patient.id, patientNo: patient.patientNo }).from(patient)
        .where(and(eq(patient.tenantId, t), eq(patient.phone, body.phone), ilike(patient.fullName, body.fullName))).limit(1);
      if (dup.length && !(req.query as any).force) throw new HttpError(409, 'POSSIBLE_DUPLICATE', { existing: dup[0] });
    }
    const n = await nextNumber(tx, t, 'patient_no', 'tenant');
    const [row] = await tx.insert(patient).values({ ...body, tenantId: t, patientNo: `P${String(n).padStart(5, '0')}` }).returning();
    await emit(tx, req.ctx, 'patient.registered', 'patient', row.id, { patientNo: row.patientNo });
    return row;
  });

  route(app, 'patch', '/patients/:id', 'patient.write', async (req, tx) => {
    // A hidden number (98••• ••345) comes back unchanged from roles that cannot see phones: keep the stored one.
    const raw: any = { ...(req.body as any) }; if (typeof raw.phone === 'string' && raw.phone.includes('•')) delete raw.phone;
    const body = sent(PatientIn.partial().parse(raw), raw);
    const cur = await tx.select().from(patient).where(and(eq(patient.id, (req.params as any).id), eq(patient.tenantId, req.ctx.tenantId))).then((r) => r[0]);
    if (body.guardianId) {
      if (body.guardianId === (req.params as any).id) throw new HttpError(400, 'GUARDIAN_IS_SELF');
      const g = await tx.select({ id: patient.id }).from(patient).where(and(eq(patient.id, body.guardianId), eq(patient.tenantId, req.ctx.tenantId))).then((r) => r[0]);
      if (!g) throw new HttpError(400, 'GUARDIAN_NOT_FOUND');
    }
    if (cur) req.auditBefore = Object.fromEntries(Object.keys(body).map((k) => [k, (cur as any)[k]]));
    const [row] = await tx.update(patient).set(body).where(and(eq(patient.id, (req.params as any).id), eq(patient.tenantId, req.ctx.tenantId))).returning();
    if (!row) throw new HttpError(404, 'NOT_FOUND');
    return row;
  });

  // Timeline: what the doctor sees when opening a patient.
  route(app, 'get', '/patients/:id/timeline', 'patient.read', async (req, tx) => {
    const id = (req.params as any).id; const t = req.ctx.tenantId;
    const p = await tx.select().from(patient).where(and(eq(patient.id, id), eq(patient.tenantId, t))).then((r) => r[0]);
    if (!p) throw new HttpError(404, 'NOT_FOUND');
    await auditView(tx, req, id, 'Opened the patient record');
    const visits = await tx.select().from(visit).where(and(eq(visit.patientId, id), eq(visit.tenantId, t))).orderBy(desc(visit.arrivedAt)).limit(20);
    const encounters = await tx.select().from(encounter).where(and(eq(encounter.patientId, id), eq(encounter.tenantId, t))).orderBy(desc(encounter.createdAt)).limit(10);
    const rx = encounters.length
      ? await tx.select().from(prescriptionItem).where(and(eq(prescriptionItem.tenantId, t), sql`${prescriptionItem.encounterId} in ${encounters.map((e) => e.id)}`))
      : [];
    const recs = await tx.select().from(recommendation).where(and(eq(recommendation.patientId, id), eq(recommendation.tenantId, t))).orderBy(desc(recommendation.createdAt));
    const charges = await tx.select().from(charge).where(and(eq(charge.patientId, id), eq(charge.tenantId, t))).orderBy(desc(charge.createdAt));
    const payments = await tx.select().from(payment).where(and(eq(payment.patientId, id), eq(payment.tenantId, t))).orderBy(desc(payment.receivedAt));
    const due = charges.filter((c) => c.status === 'due').reduce((s, c) => s + c.amountPaise, 0);
    const guardian = p.guardianId ? await tx.select({ id: patient.id, fullName: patient.fullName, patientNo: patient.patientNo, phone: patient.phone }).from(patient).where(and(eq(patient.id, p.guardianId), eq(patient.tenantId, t))).then((r) => r[0] ?? null) : null;
    const sharing = p.phone ? await tx.select({ n: sql<number>`count(*)::int` }).from(patient).where(and(eq(patient.tenantId, t), eq(patient.phone, p.phone), sql`${patient.id} <> ${id}`)).then((r) => r[0]?.n ?? 0) : 0;
    return { patient: p, guardian, sharingPhone: sharing, visits, encounters: encounters.map((e) => ({ ...e, prescription: rx.filter((i) => i.encounterId === e.id) })), recommendations: recs, charges, payments, outstandingPaise: due };
  });
}
