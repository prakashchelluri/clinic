import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, desc, sql } from 'drizzle-orm';
import { tenant, patient, visit, encounter, prescriptionItem, medicine, labResult, message, recommendation } from '../db/schema.js';
import { route } from '../lib/route.js';
import { HttpError } from '../lib/auth.js';
import { emit } from '../lib/core.js';
import { bookingSettings } from '../lib/booking.js';
import { LAB_PARAMS, findParam, flagOf, numOf } from '../lib/labs.js';
import { normHistory, cleanHistory, allergyText, historyCategories, HISTORY_CATEGORIES, HISTORY_KEYS } from '../lib/history.js';
import { padConfig, printSettings, PAD_SECTIONS, TE, teluguTable } from '../lib/pad.js';

/** What the pad reads and writes besides the note itself: history chips, vitals, lab values, often-prescribed medicines, and the clinic's pad configuration. */
export const VITAL_KEYS = ['weight_kg', 'height_cm', 'bp', 'pulse', 'temp_f', 'spo2'] as const;
const Vitals = z.object({ weight_kg: z.number().min(1).max(400).nullable().optional(), height_cm: z.number().min(30).max(250).nullable().optional(), bp: z.string().trim().max(12).nullable().optional(),
  pulse: z.number().int().min(20).max(250).nullable().optional(), temp_f: z.number().min(90).max(110).nullable().optional(), spo2: z.number().int().min(50).max(100).nullable().optional() });

export function rxpadRoutes(app: FastifyInstance) {
  // --- medical history: six categories on the patient, confirmed at each visit ---
  route(app, 'get', '/patients/:id/history', 'patient.read', async (req, tx) => {
    const p = await tx.select({ history: patient.history }).from(patient).where(and(eq(patient.id, (req.params as any).id), eq(patient.tenantId, req.ctx.tenantId))).then((r) => r[0]);
    if (!p) throw new HttpError(404, 'NOT_FOUND');
    return normHistory(p.history);
  });
  route(app, 'put', '/patients/:id/history', 'encounter.intake', async (req, tx) => {
    const id = (req.params as any).id; const t = req.ctx.tenantId;
    const h = { ...cleanHistory(req.body), confirmedAt: new Date().toISOString(), confirmedBy: req.ctx.name };
    const [row] = await tx.update(patient).set({ history: h as any, allergies: allergyText(h) }).where(and(eq(patient.id, id), eq(patient.tenantId, t))).returning({ id: patient.id });
    if (!row) throw new HttpError(404, 'NOT_FOUND');
    await emit(tx, req.ctx, 'patient.history_updated', 'patient', id, { keys: Object.keys(h).filter((k) => Array.isArray((h as any)[k])) });
    return h;
  });

  // --- vitals: measured at check-in, editable on the pad, past values per visit ---
  route(app, 'get', '/patients/:id/vitals', 'patient.read', async (req, tx) => {
    const rows = await tx.select({ day: visit.day, details: visit.details }).from(visit)
      .where(and(eq(visit.tenantId, req.ctx.tenantId), eq(visit.patientId, (req.params as any).id))).orderBy(desc(visit.day), desc(visit.createdAt)).limit(12);
    return rows.map((r) => ({ day: r.day, ...Object.fromEntries(VITAL_KEYS.map((k) => [k, (r.details as any)?.[k] ?? null])) })).filter((r) => VITAL_KEYS.some((k) => (r as any)[k] !== null && (r as any)[k] !== ''));
  });
  route(app, 'patch', '/encounters/:id/vitals', 'encounter.intake', async (req, tx) => {
    const b = Vitals.parse(req.body); const t = req.ctx.tenantId;
    const enc = await tx.select({ visitId: encounter.visitId, patientId: encounter.patientId }).from(encounter).where(and(eq(encounter.id, (req.params as any).id), eq(encounter.tenantId, t))).then((r) => r[0]);
    if (!enc) throw new HttpError(404, 'NOT_FOUND');
    const v = await tx.select({ details: visit.details }).from(visit).where(eq(visit.id, enc.visitId)).then((r) => r[0]);
    const details = { ...(v?.details ?? {}) } as Record<string, any>;
    for (const [k, val] of Object.entries(b)) { if (val === null || val === undefined || val === '') delete details[k]; else details[k] = val; }
    await tx.update(visit).set({ details }).where(eq(visit.id, enc.visitId));
    // height is asked once: keep it on the patient so the next visit starts from it
    if (b.height_cm) { const p = await tx.select({ history: patient.history }).from(patient).where(eq(patient.id, enc.patientId)).then((r) => r[0]); await tx.update(patient).set({ history: { ...normHistory(p?.history), heightCm: b.height_cm } as any }).where(eq(patient.id, enc.patientId)); }
    return details;
  });

  // --- lab results: values typed from a report, flagged against the clinic's list ---
  route(app, 'get', '/patients/:id/lab-results', 'patient.read', async (req, tx) =>
    tx.select().from(labResult).where(and(eq(labResult.tenantId, req.ctx.tenantId), eq(labResult.patientId, (req.params as any).id))).orderBy(desc(labResult.takenOn), labResult.test));
  const Item = z.object({ test: z.string().trim().min(1).max(80), value: z.string().trim().min(1).max(40), unit: z.string().trim().max(20).nullish(), note: z.string().trim().max(160).nullish() });
  route(app, 'post', '/lab-results', 'document.write', async (req, tx) => {
    const b = z.object({ patientId: z.string().uuid(), encounterId: z.string().uuid().nullish(), recommendationId: z.string().uuid().nullish(), documentId: z.string().uuid().nullish(), takenOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), items: z.array(Item).min(1).max(40) }).parse(req.body);
    const t = req.ctx.tenantId;
    const p = await tx.select({ id: patient.id }).from(patient).where(and(eq(patient.id, b.patientId), eq(patient.tenantId, t))).then((r) => r[0]);
    if (!p) throw new HttpError(404, 'PATIENT_NOT_FOUND');
    const rows = await tx.insert(labResult).values(b.items.map((i) => { const prm = findParam(i.test); return {
      tenantId: t, patientId: b.patientId, encounterId: b.encounterId ?? null, recommendationId: b.recommendationId ?? null, documentId: b.documentId ?? null,
      test: prm?.name ?? i.test, value: i.value, num: numOf(i.value), unit: i.unit ?? prm?.unit ?? null, low: prm?.low ?? null, high: prm?.high ?? null, flag: flagOf(i.value, prm), takenOn: b.takenOn, note: i.note ?? null, createdBy: req.ctx.name }; })).returning();
    await emit(tx, req.ctx, 'lab_result.added', 'patient', b.patientId, { n: rows.length, tests: rows.map((r) => r.test) });
    return rows;
  });
  route(app, 'patch', '/lab-results/:id', 'document.write', async (req, tx) => {
    const b = z.object({ value: z.string().trim().min(1).max(40).optional(), note: z.string().trim().max(160).nullable().optional(), takenOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(req.body);
    const cur = await tx.select().from(labResult).where(and(eq(labResult.id, (req.params as any).id), eq(labResult.tenantId, req.ctx.tenantId))).then((r) => r[0]);
    if (!cur) throw new HttpError(404, 'NOT_FOUND');
    const prm = findParam(cur.test) ?? (cur.low !== null || cur.high !== null ? { name: cur.test, low: cur.low ?? undefined, high: cur.high ?? undefined } : undefined);
    const set: any = { ...b };
    if (b.value !== undefined) { set.num = numOf(b.value); set.flag = flagOf(b.value, prm); }
    const [row] = await tx.update(labResult).set(set).where(eq(labResult.id, cur.id)).returning();
    return row;
  });
  route(app, 'delete', '/lab-results/:id', 'document.write', async (req, tx) => {
    const [row] = await tx.delete(labResult).where(and(eq(labResult.id, (req.params as any).id), eq(labResult.tenantId, req.ctx.tenantId))).returning({ id: labResult.id });
    if (!row) throw new HttpError(404, 'NOT_FOUND'); return { ok: true };
  });

  /** The medicines this doctor writes most (last six months), for the "Often prescribed" row. */
  route(app, 'get', '/encounters-frequent', 'encounter.intake', async (req, tx) => {
    const t = req.ctx.tenantId; const pid = req.ctx.practitionerId;
    return tx.select({ name: prescriptionItem.name, medicineId: prescriptionItem.medicineId, n: sql<number>`count(*)::int` }).from(prescriptionItem)
      .innerJoin(encounter, eq(encounter.id, prescriptionItem.encounterId))
      .where(and(eq(prescriptionItem.tenantId, t), eq(encounter.status, 'completed'), pid ? eq(encounter.practitionerId, pid) : sql`true`, sql`${encounter.createdAt} > now() - interval '180 days'`))
      .groupBy(prescriptionItem.name, prescriptionItem.medicineId).orderBy(desc(sql`count(*)`), prescriptionItem.name).limit(12);
  });

  // --- the clinic's pad: which sections show, are required, print; and how the prescription prints ---
  route(app, 'get', '/admin/pad', 'config.write', async (req, tx) => {
    const ten = await tx.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, req.ctx.tenantId)).then((r) => r[0]);
    return padView(ten.settings);
  });
  const padView = (s: any) => ({ sections: padConfig(s), print: printSettings(s), known: PAD_SECTIONS, telugu: teluguTable(s), teluguDefaults: TE, history: historyCategories(s), historyDefaults: HISTORY_CATEGORIES });
  route(app, 'put', '/admin/pad', 'config.write', async (req, tx) => {
    const b = z.object({ sections: z.array(z.object({ key: z.string(), show: z.boolean(), required: z.boolean(), print: z.boolean() })).max(40).optional(),
      print: z.object({ lang: z.enum(['te+en', 'en', 'te']).optional(), outOfRangeOnly: z.boolean().optional(), vitals: z.array(z.string()).max(8).optional() }).optional(),
      telugu: z.record(z.string().trim().min(1).max(80), z.string().trim().max(160)).refine((o) => Object.keys(o).length <= 400, 'TOO_MANY').optional(),
      historyOptions: z.record(z.enum(HISTORY_KEYS), z.array(z.string().trim().min(1).max(60)).max(40)).optional() }).parse(req.body);
    const t = req.ctx.tenantId;
    const ten = await tx.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, t)).then((r) => r[0]);
    const s = { ...(ten.settings ?? {}) } as any;
    if (b.sections) s.pad = { ...(s.pad ?? {}), sections: padConfig({ pad: { sections: b.sections } }) };
    if (b.print) s.print = { ...(s.print ?? {}), rx: { ...printSettings(s).valueOf(), ...b.print } };
    // the whole table comes in; only what differs from the built-in one is kept, so a later app update to the defaults still reaches the clinic
    if (b.telugu) s.pad = { ...(s.pad ?? {}), telugu: Object.fromEntries(Object.entries(b.telugu).map(([k, v]) => [k.toLowerCase(), v]).filter(([k, v]) => (TE[k] ?? '') !== v)) };
    if (b.historyOptions) {
      const own: Record<string, string[]> = {};
      for (const c of HISTORY_CATEGORIES) { const xs = b.historyOptions[c.key]; if (xs && JSON.stringify(xs) !== JSON.stringify(c.options)) own[c.key] = [...new Set(xs)]; }
      s.pad = { ...(s.pad ?? {}), historyOptions: own };
    }
    await tx.update(tenant).set({ settings: s }).where(eq(tenant.id, t));
    await emit(tx, req.ctx, 'pad.configured', 'tenant', t, { sections: !!b.sections, print: !!b.print, telugu: !!b.telugu, history: !!b.historyOptions });
    return padView(s);
  });

  route(app, 'get', '/lab-params', 'encounter.intake', async () => LAB_PARAMS);
}

/** On Finish: one WhatsApp message with the medicines and the "how to apply" leaflets, through the same outbox as booking messages. */
export async function queueRxMessage(tx: any, ctx: any, encounterId: string) {
  const t = ctx.tenantId;
  const row = await tx.select({ e: encounter, p: patient, ten: tenant }).from(encounter).innerJoin(patient, eq(patient.id, encounter.patientId)).innerJoin(tenant, eq(tenant.id, encounter.tenantId))
    .where(and(eq(encounter.id, encounterId), eq(encounter.tenantId, t))).then((r: any[]) => r[0]);
  if (!row) return null;
  const cfg = bookingSettings(row.ten.settings).messages;
  const items = await tx.select({ name: prescriptionItem.name, leaflet: medicine.leafletUrl }).from(prescriptionItem).leftJoin(medicine, eq(medicine.id, prescriptionItem.medicineId))
    .where(eq(prescriptionItem.encounterId, encounterId)).orderBy(prescriptionItem.sortOrder);
  const review = await tx.select({ dueOn: recommendation.dueOn }).from(recommendation).where(and(eq(recommendation.encounterId, encounterId), eq(recommendation.kind, 'followup'))).then((r: any[]) => r[0]);
  if (!items.length) return null;
  const leaflets = items.filter((i: any) => i.leaflet).map((i: any) => `${i.name}: ${i.leaflet}`);
  const body = [`${row.ten.name}: prescription for ${row.p.fullName}.`, `Medicines: ${items.map((i: any) => i.name).join(', ')}.`,
    leaflets.length ? `How to use:\n${leaflets.join('\n')}` : null, review?.dueOn ? `Review on ${review.dueOn}.` : null, row.ten.settings?.print?.phone ? `Questions? Call ${row.ten.settings.print.phone}.` : null].filter(Boolean).join('\n');
  const noPhone = !row.p.phone || !/^\d{10}$/.test(row.p.phone);
  const status = !cfg.enabled || cfg.channel === 'none' || noPhone ? 'skipped' : 'pending';
  const [m] = await tx.insert(message).values({ tenantId: t, patientId: row.p.id, appointmentId: null, kind: 'rx', channel: cfg.channel, toPhone: row.p.phone, body, params: { encounterId, leaflets: String(leaflets.length) },
    status, sendAfter: new Date().toISOString(), error: status === 'skipped' ? (noPhone ? 'no mobile number' : 'messages are switched off') : null }).returning();
  return m;
}
