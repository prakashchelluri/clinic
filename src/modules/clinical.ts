import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, asc, desc, sql } from 'drizzle-orm';
import { encounter, visit, prescriptionItem, recommendation, formDefinition, patient, practitioner, procedureCatalog, tenant, type FormSchema } from '../db/schema.js';
import { route } from '../lib/route.js';
import { emit, addDays, todayIn } from '../lib/core.js';
import { HttpError } from '../lib/auth.js';

const RxItem = z.object({ medicineId: z.string().uuid().nullable().optional(), name: z.string().min(1), dose: z.string().optional(), route: z.string().optional(),
  frequency: z.string().optional(), durationDays: z.number().int().optional(), instructions: z.string().optional() });
const Rec = z.object({ kind: z.enum(['followup', 'procedure']), procedureId: z.string().uuid().nullable().optional(), dueOn: z.string().optional(),
  intervalDays: z.number().int().optional(), sittings: z.number().int().optional(), notes: z.string().optional() });
const Save = z.object({ data: z.record(z.string(), z.any()).default({}), prescription: z.array(RxItem).default([]), recommendations: z.array(Rec).default([]), complete: z.boolean().default(false) });

/** Validate submitted data against the form definition: required fields and option membership only. */
function validate(schema: FormSchema, data: Record<string, any>) {
  const errors: { path: string; message: string }[] = [];
  for (const s of schema.sections) for (const f of s.fields) {
    const v = data[s.key]?.[f.key];
    const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
    if (f.required && empty) errors.push({ path: `${s.key}.${f.key}`, message: 'required' });
    if (!empty && f.options && (f.type === 'select' ? !f.options.includes(v) : f.type === 'multiselect' && !(v as string[]).every((x) => f.options!.includes(x))))
      errors.push({ path: `${s.key}.${f.key}`, message: 'not an allowed option' });
  }
  return errors;
}

export function clinicalRoutes(app: FastifyInstance) {
  /** Open (or create) the encounter for a visit. Doctor opens from queue; assistant opens for intake. */
  route(app, 'post', '/visits/:visitId/encounter', 'encounter.intake', async (req, tx) => {
    const t = req.ctx.tenantId; const visitId = (req.params as any).visitId;
    const v = await tx.select().from(visit).where(and(eq(visit.id, visitId), eq(visit.tenantId, t))).then((r) => r[0]);
    if (!v) throw new HttpError(404, 'VISIT_NOT_FOUND');
    let enc = await tx.select().from(encounter).where(and(eq(encounter.visitId, visitId), eq(encounter.tenantId, t))).then((r) => r[0]);
    if (!enc) {
      const form = await tx.select().from(formDefinition).where(and(eq(formDefinition.tenantId, t), eq(formDefinition.key, 'encounter'), eq(formDefinition.active, true))).orderBy(desc(formDefinition.version)).then((r) => r[0]);
      if (!form) throw new HttpError(500, 'NO_ENCOUNTER_FORM');
      [enc] = await tx.insert(encounter).values({ tenantId: t, visitId, patientId: v.patientId, practitionerId: v.practitionerId ?? req.ctx.practitionerId, formDefinitionId: form.id,
        provenance: { source: req.ctx.role === 'assistant' ? 'intake' : 'typed', openedBy: req.ctx.userId } }).returning();
      const newStatus = req.ctx.role === 'assistant' ? 'intake' : 'in_consult';
      await tx.update(visit).set({ status: newStatus }).where(eq(visit.id, visitId));
      await emit(tx, req.ctx, 'encounter.opened', 'encounter', enc.id, { visitId, by: req.ctx.role });
    }
    return getEncounter(tx, t, enc.id);
  });

  route(app, 'get', '/encounters/:id', 'encounter.intake', async (req, tx) => getEncounter(tx, req.ctx.tenantId, (req.params as any).id));

  /** Save draft or complete. Completing validates the form, writes Rx items and recommendations (→ worklists), marks the visit done. */
  route(app, 'patch', '/encounters/:id', 'encounter.intake', async (req, tx) => {
    const body = Save.parse(req.body); const t = req.ctx.tenantId; const id = (req.params as any).id;
    const enc = await tx.select().from(encounter).where(and(eq(encounter.id, id), eq(encounter.tenantId, t))).then((r) => r[0]);
    if (!enc) throw new HttpError(404, 'NOT_FOUND');
    if (enc.status === 'completed') throw new HttpError(409, 'ALREADY_COMPLETED');
    if (body.complete && !req.perms.some((p) => p === '*' || p === 'encounter.*' || p === 'encounter.complete')) throw new HttpError(403, 'FORBIDDEN:encounter.complete');

    const form = await tx.select().from(formDefinition).where(eq(formDefinition.id, enc.formDefinitionId)).then((r) => r[0]);
    const data = { ...enc.data, ...body.data };
    if (body.complete) {
      const errors = validate(form.schema, data);
      if (errors.length) throw new HttpError(422, 'FORM_INVALID', { errors });
    }
    // Rx and recommendations are replaced wholesale on every save: simplest correct behaviour for a draft.
    await tx.delete(prescriptionItem).where(and(eq(prescriptionItem.encounterId, id), eq(prescriptionItem.tenantId, t)));
    if (body.prescription.length) await tx.insert(prescriptionItem).values(body.prescription.map((i, k) => ({ ...i, tenantId: t, encounterId: id, sortOrder: k })));
    await tx.delete(recommendation).where(and(eq(recommendation.encounterId, id), eq(recommendation.tenantId, t), eq(recommendation.status, 'open')));
    const today = todayIn(req.ctx.timezone);
    if (body.recommendations.length) {
      const rows = await tx.insert(recommendation).values(body.recommendations.map((r) => ({
        tenantId: t, encounterId: id, patientId: enc.patientId, kind: r.kind, procedureId: r.procedureId ?? null,
        dueOn: r.dueOn ?? (r.intervalDays ? addDays(today, r.intervalDays) : null), sittings: r.sittings, notes: r.notes,
      }))).returning();
      if (body.complete) for (const r of rows) await emit(tx, req.ctx, 'recommendation.created', 'recommendation', r.id, { kind: r.kind, patientId: r.patientId, dueOn: r.dueOn, procedureId: r.procedureId });
    }
    const set: any = { data, provenance: { ...enc.provenance, lastEditedBy: req.ctx.userId, lastEditedRole: req.ctx.role } };
    if (body.complete) { set.status = 'completed'; set.completedAt = new Date().toISOString(); if (req.ctx.practitionerId) set.practitionerId = req.ctx.practitionerId; }
    await tx.update(encounter).set(set).where(eq(encounter.id, id));
    if (body.complete) {
      await tx.update(visit).set({ status: 'done' }).where(eq(visit.id, enc.visitId));
      await emit(tx, req.ctx, 'encounter.completed', 'encounter', id, { visitId: enc.visitId, patientId: enc.patientId, rxItems: body.prescription.length, recommendations: body.recommendations.length });
    } else if (req.ctx.role === 'assistant') {
      await tx.update(visit).set({ status: 'waiting' }).where(eq(visit.id, enc.visitId)); // intake done, back to doctor's queue
    }
    return getEncounter(tx, t, id);
  });

  /** Everything needed to render the printed prescription. */
  route(app, 'get', '/encounters/:id/print', 'encounter.intake', async (req, tx) => {
    const t = req.ctx.tenantId;
    const e = await getEncounter(tx, t, (req.params as any).id);
    const ten = await tx.select().from(tenant).where(eq(tenant.id, t)).then((r) => r[0]);
    const v = await tx.select().from(visit).where(eq(visit.id, e.visitId)).then((r) => r[0]);
    return { ...e, clinic: { name: ten.name, ...(ten.settings.print ?? {}) }, visit: v };
  });

  /** Worklists: open follow-ups and procedure recommendations with contact log. */
  route(app, 'get', '/worklist', 'worklist.read', async (req, tx) => {
    const kind = String((req.query as any).kind ?? 'followup');
    return tx.select({ r: recommendation, p: { id: patient.id, fullName: patient.fullName, phone: patient.phone, patientNo: patient.patientNo }, procedure: procedureCatalog.name })
      .from(recommendation).innerJoin(patient, eq(patient.id, recommendation.patientId)).leftJoin(procedureCatalog, eq(procedureCatalog.id, recommendation.procedureId))
      .where(and(eq(recommendation.tenantId, req.ctx.tenantId), eq(recommendation.kind, kind), sql`${recommendation.status} not in ('done','cancelled')`))
      .orderBy(asc(recommendation.dueOn))
      .then((rows) => rows.map((x) => ({ ...x.r, patient: x.p, procedure: x.procedure })));
  });

  route(app, 'patch', '/worklist/:id', 'worklist.write', async (req, tx) => {
    const body = z.object({ status: z.enum(['open', 'contacted', 'scheduled', 'done', 'cancelled']).optional(), dueOn: z.string().nullable().optional(),
      contact: z.object({ outcome: z.string(), note: z.string().optional() }).optional() }).parse(req.body);
    const t = req.ctx.tenantId; const id = (req.params as any).id;
    const cur = await tx.select().from(recommendation).where(and(eq(recommendation.id, id), eq(recommendation.tenantId, t))).then((r) => r[0]);
    if (!cur) throw new HttpError(404, 'NOT_FOUND');
    const set: any = {};
    if (body.status) set.status = body.status;
    if (body.dueOn !== undefined) set.dueOn = body.dueOn;
    if (body.contact) set.contactLog = [...cur.contactLog, { at: new Date().toISOString(), by: req.ctx.name, ...body.contact }];
    const [row] = await tx.update(recommendation).set(set).where(eq(recommendation.id, id)).returning();
    await emit(tx, req.ctx, 'worklist.updated', 'recommendation', id, body);
    return row;
  });
}

async function getEncounter(tx: any, t: string, id: string) {
  const row = await tx.select({ e: encounter, form: formDefinition.schema, p: patient, doctor: practitioner })
    .from(encounter).innerJoin(formDefinition, eq(formDefinition.id, encounter.formDefinitionId)).innerJoin(patient, eq(patient.id, encounter.patientId))
    .leftJoin(practitioner, eq(practitioner.id, encounter.practitionerId))
    .where(and(eq(encounter.id, id), eq(encounter.tenantId, t))).then((r: any[]) => r[0]);
  if (!row) throw new HttpError(404, 'NOT_FOUND');
  const rx = await tx.select().from(prescriptionItem).where(eq(prescriptionItem.encounterId, id)).orderBy(asc(prescriptionItem.sortOrder));
  const recs = await tx.select().from(recommendation).where(eq(recommendation.encounterId, id));
  return { ...row.e, form: row.form, patient: row.p, doctor: row.doctor, prescription: rx, recommendations: recs };
}
