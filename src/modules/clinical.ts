import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, asc, desc, sql, inArray } from 'drizzle-orm';
import { encounter, visit, prescriptionItem, recommendation, formDefinition, patient, practitioner, procedureCatalog, procedureSession, room, tenant, rxTemplate, stockBatch, labResult, feeCategory, type FormSchema } from '../db/schema.js';
import { queueRxMessage } from './rxpad.js';
import { padConfig, printSettings, te } from '../lib/pad.js';
import { normHistory } from '../lib/history.js';
import { route } from '../lib/route.js';
import { auditView } from '../lib/audit.js';
import { emit, addDays, todayIn } from '../lib/core.js';
import { HttpError } from '../lib/auth.js';
import { expectedDays } from '../lib/tests.js';

const RxItem = z.object({ id: z.string().uuid().optional(), medicineId: z.string().uuid().nullable().optional(), name: z.string().min(1), dose: z.string().nullish(), route: z.string().nullish(),
  frequency: z.string().nullish(), durationDays: z.number().int().nullish(), instructions: z.string().nullish(), timing: z.string().max(40).nullish(), qty: z.number().int().min(0).max(10000).nullish() }); // blank fields come back from the database as null
const Rec = z.object({ id: z.string().uuid().optional(), kind: z.enum(['followup', 'procedure', 'investigation']), procedureId: z.string().uuid().nullable().optional(), dueOn: z.string().nullish(),
  intervalDays: z.number().int().nullish(), sittings: z.number().int().nullish(), notes: z.string().nullish(), orderNo: z.number().int().min(1).max(20).nullish() });
const Save = z.object({ data: z.record(z.string(), z.any()).default({}), prescription: z.array(RxItem).default([]), recommendations: z.array(Rec).default([]), complete: z.boolean().default(false) });

/** Validate submitted data against the form definition: required fields and option membership only. */
/** Assistant-only users save intake and hand back to the doctor; a doctor who also holds assistant stays in consult. */
function isIntakeOnly(req: any) { return req.ctx.roles.includes('assistant') && !req.perms.some((p: string) => p === '*' || p === 'encounter.*' || p === 'encounter.complete'); }

function validate(schema: FormSchema, data: Record<string, any>) {
  const errors: { path: string; message: string }[] = [];
  for (const s of schema.sections) for (const f of s.fields) {
    const v = data[s.key]?.[f.key];
    const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
    if (f.required && empty) errors.push({ path: `${s.key}.${f.key}`, message: 'required' });
    if (!empty && f.options && f.type !== 'tags' && (f.type === 'select' ? !f.options.includes(v) : f.type === 'multiselect' && !(v as string[]).every((x) => f.options!.includes(x))))
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
    const intakeOnly = isIntakeOnly(req);
    // Someone is with the junior doctor right now: the doctor's screen waits for the screening to finish.
    if (!intakeOnly && v.status === 'intake') throw new HttpError(409, 'WITH_JUNIOR');
    // Brings the patient in. Reception may already have sent them (details.calledBy = desk); otherwise the doctor is pulling them in and the desk is told.
    const bringIn = async (status: 'intake' | 'in_consult') => {
      if (v.status === status) return;
      const details = status === 'in_consult' ? { ...(v.details ?? {}), calledBy: (v.details as any)?.calledBy === 'desk' && v.status === 'in_consult' ? 'desk' : 'doctor', calledAt: new Date().toISOString() } : v.details;
      await tx.update(visit).set({ status, details }).where(eq(visit.id, visitId));
    };
    // Back with reports: the same consultation opens again, nothing new is created.
    // The doctor has the pad open: the 'coming in now' note on the doctor's screen can go.
    const markOpened = async () => { if (intakeOnly) return; const cur = await tx.select({ details: visit.details, practitionerId: visit.practitionerId }).from(visit).where(eq(visit.id, visitId)).then((r) => r[0]); const set: any = {}; if (!(cur?.details as any)?.doctorOpenedAt) set.details = { ...(cur?.details ?? {}), doctorOpenedAt: new Date().toISOString() }; if (!cur?.practitionerId && req.ctx.practitionerId) set.practitionerId = req.ctx.practitionerId; /* the doctor who opened the pad is the patient's doctor for the day */ if (Object.keys(set).length) await tx.update(visit).set(set).where(eq(visit.id, visitId)); };
    const heldId = (v.details as any)?.reportsEncounterId as string | undefined;
    if (heldId && !intakeOnly) {
      const held = await tx.select({ id: encounter.id, status: encounter.status }).from(encounter).where(and(eq(encounter.id, heldId), eq(encounter.tenantId, t))).then((r) => r[0]);
      if (held) { await bringIn('in_consult'); await markOpened(); return getEncounter(tx, t, held.id); }
    }
    let enc = await tx.select().from(encounter).where(and(eq(encounter.visitId, visitId), eq(encounter.tenantId, t))).then((r) => r[0]);
    if (enc && !intakeOnly && v.status !== 'in_consult' && enc.status === 'draft') await bringIn('in_consult');
    if (enc && enc.status === 'draft') {
      // Drafts follow the latest form version; completed encounters stay pinned to the version they were written with.
      const latest = await tx.select({ id: formDefinition.id }).from(formDefinition).where(and(eq(formDefinition.tenantId, t), eq(formDefinition.key, 'encounter'), eq(formDefinition.active, true))).orderBy(desc(formDefinition.version)).then((r) => r[0]);
      if (latest && latest.id !== enc.formDefinitionId) await tx.update(encounter).set({ formDefinitionId: latest.id }).where(eq(encounter.id, enc.id));
    }
    if (!enc) {
      const form = await tx.select().from(formDefinition).where(and(eq(formDefinition.tenantId, t), eq(formDefinition.key, 'encounter'), eq(formDefinition.active, true))).orderBy(desc(formDefinition.version)).then((r) => r[0]);
      if (!form) throw new HttpError(500, 'NO_ENCOUNTER_FORM');
      [enc] = await tx.insert(encounter).values({ tenantId: t, visitId, patientId: v.patientId, practitionerId: v.practitionerId ?? req.ctx.practitionerId, formDefinitionId: form.id,
        provenance: { source: intakeOnly ? 'intake' : 'typed', openedBy: req.ctx.userId } }).returning();
      await bringIn(intakeOnly ? 'intake' : 'in_consult');
      await emit(tx, req.ctx, 'encounter.opened', 'encounter', enc.id, { visitId, by: req.ctx.role });
    } else if (intakeOnly && v.status !== 'intake' && enc.status === 'draft') {
      await bringIn('intake');
    }
    await markOpened();
    return getEncounter(tx, t, enc.id);
  });

  route(app, 'get', '/encounters/:id', 'encounter.intake', async (req, tx) => {
    const e = await getEncounter(tx, req.ctx.tenantId, (req.params as any).id);
    await auditView(tx, req, e.patientId, e.status === 'completed' ? 'Read a past consultation' : e.status === 'awaiting_reports' ? 'Opened a consultation held for reports' : 'Opened the consultation');
    return e;
  });

  /** Save draft or complete. Completing validates the form, writes Rx items and recommendations (→ worklists), marks the visit done. */
  route(app, 'patch', '/encounters/:id', 'encounter.intake', async (req, tx) => {
    const body = Save.parse(req.body); const t = req.ctx.tenantId; const id = (req.params as any).id;
    const enc = await tx.select().from(encounter).where(and(eq(encounter.id, id), eq(encounter.tenantId, t))).then((r) => r[0]);
    if (!enc) throw new HttpError(404, 'NOT_FOUND');
    if (enc.status === 'completed') throw new HttpError(409, 'ALREADY_COMPLETED');
    const isDoctor = req.perms.some((p) => p === '*' || p === 'encounter.*' || p === 'encounter.complete');
    if (body.complete && !isDoctor) throw new HttpError(403, 'FORBIDDEN:encounter.complete');
    // Held open for reports: the prescription has gone out, the pad is still the doctor's to finish.
    const held = enc.status === 'awaiting_reports';
    if (held && !isDoctor) throw new HttpError(409, 'AWAITING_REPORTS');

    const form = await tx.select().from(formDefinition).where(eq(formDefinition.id, enc.formDefinitionId)).then((r) => r[0]);
    const data = { ...enc.data, ...body.data };
    if (body.complete) {
      const errors = validate(form.schema, data);
      if (errors.length) throw new HttpError(422, 'FORM_INVALID', { errors });
    }
    const today = todayIn(req.ctx.timezone);
    let newRx = 0;
    if (held) {
      // Items already issued at the counter stay; the doctor can add medicines after the reports, correct unissued ones, or drop unissued ones.
      const cur = await tx.select().from(prescriptionItem).where(and(eq(prescriptionItem.encounterId, id), eq(prescriptionItem.tenantId, t)));
      const keep = new Set(body.prescription.map((i) => i.id).filter(Boolean));
      for (const c of cur) if (!keep.has(c.id) && !c.dispensed && c.issuedQty === 0) await tx.delete(prescriptionItem).where(eq(prescriptionItem.id, c.id));
      for (const [k, i] of body.prescription.entries()) {
        const { id: iid, ...fields } = i;
        if (iid && cur.some((c) => c.id === iid)) { const c = cur.find((x) => x.id === iid)!; await tx.update(prescriptionItem).set(c.dispensed || c.issuedQty > 0 ? { sortOrder: k } : { ...fields, sortOrder: k }).where(eq(prescriptionItem.id, iid)); }
        else { await tx.insert(prescriptionItem).values({ ...fields, tenantId: t, encounterId: id, sortOrder: k }); newRx++; }
      }
      const fresh = body.recommendations.filter((r) => !r.id);
      if (fresh.length) {
        const rows = await tx.insert(recommendation).values(fresh.map((r) => ({
          tenantId: t, encounterId: id, patientId: enc.patientId, kind: r.kind, procedureId: r.procedureId ?? null,
          dueOn: r.dueOn ?? (r.intervalDays ? addDays(today, r.intervalDays) : null), sittings: r.sittings, notes: r.notes,
          ...(r.kind === 'investigation' ? { orderNo: r.orderNo ?? 1, expectedOn: addDays(today, expectedDays(r.notes ?? '')) } : {}),
        }))).returning();
        for (const r of rows) await emit(tx, req.ctx, 'recommendation.created', 'recommendation', r.id, { kind: r.kind, patientId: r.patientId, dueOn: r.dueOn, procedureId: r.procedureId });
      }
    } else {
      // Rx and recommendations are replaced wholesale on every save: simplest correct behaviour for a draft.
      await tx.delete(prescriptionItem).where(and(eq(prescriptionItem.encounterId, id), eq(prescriptionItem.tenantId, t)));
      if (body.prescription.length) await tx.insert(prescriptionItem).values(body.prescription.map(({ id: _i, ...i }, k) => ({ ...i, tenantId: t, encounterId: id, sortOrder: k })));
      await tx.delete(recommendation).where(and(eq(recommendation.encounterId, id), eq(recommendation.tenantId, t), eq(recommendation.status, 'open')));
      if (body.recommendations.length) {
        const rows = await tx.insert(recommendation).values(body.recommendations.map((r) => ({
          tenantId: t, encounterId: id, patientId: enc.patientId, kind: r.kind, procedureId: r.procedureId ?? null,
          dueOn: r.dueOn ?? (r.intervalDays ? addDays(today, r.intervalDays) : null), sittings: r.sittings, notes: r.notes,
          ...(r.kind === 'investigation' ? { orderNo: r.orderNo ?? 1, expectedOn: addDays(today, expectedDays(r.notes ?? '')) } : {}),
        }))).returning();
        if (body.complete) for (const r of rows) await emit(tx, req.ctx, 'recommendation.created', 'recommendation', r.id, { kind: r.kind, patientId: r.patientId, dueOn: r.dueOn, procedureId: r.procedureId });
      }
    }
    // Medical history lives on the patient as six categories (PUT /patients/:id/history); nothing here writes it any more.
    const set: any = { data, provenance: { ...enc.provenance, lastEditedBy: req.ctx.userId, lastEditedRole: req.ctx.role } };
    // Tests ordered keep the consultation open: the patient leaves with the prescription, the doctor finishes when the reports are in.
    const testsPending = !held && body.complete && (await tx.select({ n: sql<number>`count(*)::int` }).from(recommendation).where(and(eq(recommendation.encounterId, id), eq(recommendation.kind, 'investigation'), sql`${recommendation.status} not in ('done','cancelled')`)))[0].n > 0;
    if (body.complete) {
      set.status = testsPending ? 'awaiting_reports' : 'completed';
      if (!held) set.completedAt = new Date().toISOString(); else set.provenance.reportsClosedAt = new Date().toISOString();
      if (req.ctx.practitionerId) set.practitionerId = req.ctx.practitionerId;
    }
    await tx.update(encounter).set(set).where(eq(encounter.id, id));
    if (held) {
      // The return visit for the reports is over for today whether the pad was closed or kept open for the rest.
      const back = await tx.select({ id: visit.id, details: visit.details }).from(visit).where(and(eq(visit.tenantId, t), eq(visit.status, 'in_consult'), sql`${visit.details}->>'reportsEncounterId' = ${id}`));
      for (const b of back) await tx.update(visit).set({ status: 'done', details: { ...(b.details ?? {}), returnDoneAt: new Date().toISOString() } }).where(eq(visit.id, b.id));
      if (body.complete) await emit(tx, req.ctx, 'encounter.completed', 'encounter', id, { visitId: enc.visitId, patientId: enc.patientId, afterReports: true, newRx });
      else await emit(tx, req.ctx, 'encounter.kept_open', 'encounter', id, { visitId: enc.visitId, patientId: enc.patientId, newRx });
      if (newRx > 0) await queueRxMessage(tx, req.ctx, id); // medicines added after the reports go out the same way
    } else if (body.complete) {
      await tx.update(visit).set({ status: 'done' }).where(eq(visit.id, enc.visitId));
      await emit(tx, req.ctx, testsPending ? 'encounter.awaiting_reports' : 'encounter.completed', 'encounter', id, { visitId: enc.visitId, patientId: enc.patientId, rxItems: body.prescription.length, recommendations: body.recommendations.length });
      await queueRxMessage(tx, req.ctx, id); // the prescription and any "how to apply" leaflets go out on WhatsApp
    } else if (isIntakeOnly(req)) {
      const cur = await tx.select({ details: visit.details }).from(visit).where(eq(visit.id, enc.visitId)).then((r) => r[0]);
      await tx.update(visit).set({ status: 'screened', details: { ...(cur?.details ?? {}), screenedAt: new Date().toISOString(), screenedBy: req.ctx.name } }).where(eq(visit.id, enc.visitId)); // screening done, the doctor's line
    }
    return getEncounter(tx, t, id);
  });

  // --- templates: a doctor's saved starting points (Tinea, Acne moderate...), most used first ---
  route(app, 'get', '/rx-templates', 'encounter.intake', async (req, tx) => {
    const t = req.ctx.tenantId; const pid = req.ctx.practitionerId;
    return tx.select().from(rxTemplate).where(and(eq(rxTemplate.tenantId, t), pid ? sql`(${rxTemplate.practitionerId} = ${pid} or ${rxTemplate.practitionerId} is null)` : sql`true`))
      .orderBy(desc(rxTemplate.uses), asc(rxTemplate.name));
  });
  route(app, 'post', '/rx-templates', 'encounter.complete', async (req, tx) => {
    const b = z.object({ name: z.string().trim().min(2).max(80), data: z.record(z.string(), z.any()).default({}), prescription: z.array(RxItem).default([]), recommendations: z.array(Rec).default([]) }).parse(req.body);
    const t = req.ctx.tenantId; const pid = req.ctx.practitionerId ?? null;
    // Same name for the same doctor replaces the old one: "Save as template" twice updates it.
    const old = await tx.select().from(rxTemplate).where(and(eq(rxTemplate.tenantId, t), sql`lower(${rxTemplate.name}) = lower(${b.name})`, pid ? eq(rxTemplate.practitionerId, pid) : sql`${rxTemplate.practitionerId} is null`)).then((r) => r[0]);
    // Keep only what describes the problem, not this patient's review answers.
    const { review: _r, ...data } = b.data;
    const recs = b.recommendations.map(({ dueOn: _d, ...r }) => r);
    const [row] = old ? await tx.update(rxTemplate).set({ data, prescription: b.prescription, recommendations: recs }).where(eq(rxTemplate.id, old.id)).returning()
      : await tx.insert(rxTemplate).values({ tenantId: t, practitionerId: pid, name: b.name, data, prescription: b.prescription, recommendations: recs }).returning();
    await emit(tx, req.ctx, 'rx_template.saved', 'rx_template', row.id, { name: b.name });
    return row;
  });
  /** Which complaints and diagnoses a protocol is suggested for; also renames it. */
  route(app, 'patch', '/rx-templates/:id', 'encounter.complete', async (req, tx) => {
    const b = z.object({ name: z.string().trim().min(2).max(80).optional(), linked: z.object({ complaints: z.array(z.string().trim().min(1).max(120)).max(20).optional(), diagnoses: z.array(z.string().trim().min(1).max(120)).max(20).optional() }).optional() }).parse(req.body);
    const [row] = await tx.update(rxTemplate).set(b).where(and(eq(rxTemplate.id, (req.params as any).id), eq(rxTemplate.tenantId, req.ctx.tenantId))).returning();
    if (!row) throw new HttpError(404, 'NOT_FOUND'); return row;
  });
  route(app, 'post', '/rx-templates/:id/use', 'encounter.intake', async (req, tx) => {
    const [row] = await tx.update(rxTemplate).set({ uses: sql`${rxTemplate.uses} + 1` }).where(and(eq(rxTemplate.id, (req.params as any).id), eq(rxTemplate.tenantId, req.ctx.tenantId))).returning();
    if (!row) throw new HttpError(404, 'NOT_FOUND'); return row;
  });
  route(app, 'delete', '/rx-templates/:id', 'encounter.complete', async (req, tx) => {
    const [row] = await tx.delete(rxTemplate).where(and(eq(rxTemplate.id, (req.params as any).id), eq(rxTemplate.tenantId, req.ctx.tenantId))).returning();
    if (!row) throw new HttpError(404, 'NOT_FOUND'); return { ok: true };
  });

  /** Units on the shelf per medicine (unexpired), so the doctor sees what the pharmacy can give. No prices. */
  route(app, 'get', '/encounters-stock', 'encounter.intake', async (req, tx) => {
    const rows = await tx.select({ m: stockBatch.medicineId, n: sql<number>`sum(${stockBatch.qty})::int` }).from(stockBatch)
      .where(and(eq(stockBatch.tenantId, req.ctx.tenantId), sql`${stockBatch.qty} > 0`, sql`${stockBatch.expiry} >= ${todayIn(req.ctx.timezone)}`)).groupBy(stockBatch.medicineId);
    return Object.fromEntries(rows.map((r) => [r.m, r.n]));
  });

  /** Everything needed to render the printed prescription. */
  route(app, 'get', '/encounters/:id/print', 'visit.read', async (req, tx) => { // the desk reprints when the doctor did not
    const t = req.ctx.tenantId;
    const e = await getEncounter(tx, t, (req.params as any).id);
    const ten = await tx.select().from(tenant).where(eq(tenant.id, t)).then((r) => r[0]);
    const v = await tx.select().from(visit).where(eq(visit.id, e.visitId)).then((r) => r[0]);
    // results typed for this consultation's tests (or linked to it), the clinic's print choices, and the Telugu for every standard phrase on the page
    const recIds = e.recommendations.map((r: any) => r.id);
    const labs = await tx.select().from(labResult).where(and(eq(labResult.tenantId, t), eq(labResult.patientId, e.patientId), recIds.length ? sql`(${labResult.encounterId} = ${e.id} or ${labResult.recommendationId} in ${recIds})` : eq(labResult.encounterId, e.id))).orderBy(labResult.test);
    const phrases = [...e.prescription.flatMap((i: any) => [i.frequency, i.timing, i.instructions, i.durationDays ? `${i.durationDays} days` : null]), ...String(e.data?.plan?.advice ?? '').split('\n')].filter(Boolean) as string[];
    const telugu = Object.fromEntries(phrases.map((p) => [p, te(p, ten.settings)]).filter(([, v]) => v));
    return { ...e, clinic: { name: ten.name, ...(ten.settings.print ?? {}) }, visit: v, labs, printRx: printSettings(ten.settings), pad: padConfig(ten.settings), telugu, vitalFields: Array.isArray(ten.settings?.vitalFields) ? ten.settings.vitalFields : [] };
  });

  /** Worklists: open follow-ups and procedure recommendations with contact log. */
  route(app, 'get', '/worklist', 'worklist.read', async (req, tx) => {
    const kind = String((req.query as any).kind ?? 'followup');
    return tx.select({ r: recommendation, p: { id: patient.id, fullName: patient.fullName, phone: patient.phone, patientNo: patient.patientNo }, procedure: procedureCatalog.name })
      .from(recommendation).innerJoin(patient, eq(patient.id, recommendation.patientId)).leftJoin(procedureCatalog, eq(procedureCatalog.id, recommendation.procedureId))
      .where(and(eq(recommendation.tenantId, req.ctx.tenantId), eq(recommendation.kind, kind), sql`${recommendation.status} not in ('done','cancelled')`))
      .orderBy(asc(recommendation.dueOn))
      .then(async (rows) => {
        // the next sitting still to happen, so the list can offer Reschedule instead of Schedule
        const next = new Map<string, any>();
        if (kind === 'procedure' && rows.length) {
          const upcoming = await tx.select({ ps: procedureSession, room: room.name, doctor: practitioner.name }).from(procedureSession).leftJoin(room, eq(room.id, procedureSession.roomId)).leftJoin(practitioner, eq(practitioner.id, procedureSession.practitionerId))
            .where(and(eq(procedureSession.tenantId, req.ctx.tenantId), inArray(procedureSession.recommendationId, rows.map((x) => x.r.id)), eq(procedureSession.state, 'confirmed'))).orderBy(asc(procedureSession.day), asc(procedureSession.startTime));
          for (const u of upcoming) if (!next.has(u.ps.recommendationId)) next.set(u.ps.recommendationId, { ...u.ps, room: u.room, doctor: u.doctor });
        }
        return rows.map((x) => ({ ...x.r, patient: x.p, procedure: x.procedure, next: next.get(x.r.id) ?? null }));
      });
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
  const v = await tx.select({ details: visit.details, opNumber: visit.opNumber, status: visit.status, day: visit.day, category: feeCategory.code }).from(visit).leftJoin(feeCategory, eq(feeCategory.id, visit.feeCategoryId)).where(eq(visit.id, row.e.visitId)).then((r: any[]) => r[0]);
  return { ...row.e, form: row.form, patient: { ...row.p, history: normHistory(row.p.history) }, doctor: row.doctor, prescription: rx, recommendations: recs, visit: v };
}
