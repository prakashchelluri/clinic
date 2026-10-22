import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, desc } from 'drizzle-orm';
import path from 'node:path';
import { document, recommendation, patient, procedureSession, procedureCatalog, practitioner, tenant } from '../db/schema.js';
import { route } from '../lib/route.js';
import { emit, sent } from '../lib/core.js';
import { HttpError, can } from '../lib/auth.js';
import { putFile, getFile, deleteFile } from '../lib/storage.js';

const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
export const PHOTO_VIEWS = ['front', 'left', 'right', 'back', 'closeup'] as const;
export const DEFAULT_PHOTO_AREAS = ['Face', 'Forehead', 'Cheeks', 'Chin', 'Upper lip', 'Nose', 'Scalp', 'Neck', 'Chest', 'Back', 'Arms', 'Hands', 'Underarms', 'Legs', 'Feet', 'Nails', 'Other'];
const Area = z.string().trim().min(1).max(40);

const Upload = z.object({
  patientId: z.string().uuid(), encounterId: z.string().uuid().optional(), recommendationId: z.string().uuid().optional(),
  kind: z.enum(['report', 'photo', 'prescription', 'consent', 'other']).default('report'),
  title: z.string().min(1).max(200), note: z.string().max(500).optional(),
  area: Area.optional(), view: z.enum(PHOTO_VIEWS).optional(), procedureSessionId: z.string().uuid().optional(),
  mime: z.string(), dataBase64: z.string().min(1),
});

/** Clinical photos need the patient's photo consent on record (taken once, by staff). */
const hasPhotoConsent = (p: { consents: Record<string, any> } | undefined) => !!p?.consents?.photos?.grantedAt;

export function documentRoutes(app: FastifyInstance) {
  route(app, 'get', '/patients/:id/documents', 'document.read', async (req, tx) =>
    tx.select().from(document).where(and(eq(document.tenantId, req.ctx.tenantId), eq(document.patientId, (req.params as any).id))).orderBy(desc(document.createdAt)));

  /** Photos with the procedure sitting they belong to, newest first: the patient's photo timeline. */
  route(app, 'get', '/patients/:id/photos', 'document.read', async (req, tx) => {
    const t = req.ctx.tenantId; const id = (req.params as any).id;
    const p = await tx.select({ consents: patient.consents }).from(patient).where(and(eq(patient.id, id), eq(patient.tenantId, t))).then((r) => r[0]);
    if (!p) throw new HttpError(404, 'NOT_FOUND');
    const rows = await tx.select({ d: document, ps: { id: procedureSession.id, sittingNo: procedureSession.sittingNo, day: procedureSession.day, state: procedureSession.state, recommendationId: procedureSession.recommendationId },
      procedure: procedureCatalog.name, sittings: recommendation.sittings, doctor: practitioner.name })
      .from(document).leftJoin(procedureSession, eq(procedureSession.id, document.procedureSessionId)).leftJoin(procedureCatalog, eq(procedureCatalog.id, procedureSession.procedureId))
      .leftJoin(recommendation, eq(recommendation.id, procedureSession.recommendationId)).leftJoin(practitioner, eq(practitioner.id, procedureSession.practitionerId))
      .where(and(eq(document.tenantId, t), eq(document.patientId, id), eq(document.kind, 'photo'))).orderBy(desc(document.takenAt));
    const ten = await tx.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, t)).then((r) => r[0]);
    return { consent: p.consents?.photos ?? null, areas: ten?.settings?.photos?.areas ?? DEFAULT_PHOTO_AREAS,
      photos: rows.map((r) => ({ ...r.d, sitting: r.ps?.id ? { ...r.ps, procedure: r.procedure, of: r.sittings, doctor: r.doctor } : null })) };
  });

  /** Record or withdraw a consent (photos today; the key list can grow). Withdrawing keeps old photos but blocks new ones. */
  route(app, 'post', '/patients/:id/consents', null, async (req, tx) => {
    if (!can(req.perms, 'patient.write') && !can(req.perms, 'document.write')) throw new HttpError(403, 'FORBIDDEN:document.write');
    const body = z.object({ key: z.enum(['photos']), granted: z.boolean() }).parse(req.body); const t = req.ctx.tenantId; const id = (req.params as any).id;
    const p = await tx.select().from(patient).where(and(eq(patient.id, id), eq(patient.tenantId, t))).then((r) => r[0]);
    if (!p) throw new HttpError(404, 'NOT_FOUND');
    const consents = { ...(p.consents ?? {}) };
    if (body.granted) consents[body.key] = { grantedAt: new Date().toISOString(), by: req.ctx.name }; else delete consents[body.key];
    await tx.update(patient).set({ consents }).where(eq(patient.id, id));
    await emit(tx, req.ctx, body.granted ? 'consent.granted' : 'consent.withdrawn', 'patient', id, { key: body.key });
    return { consents };
  });

  /** Upload as JSON with base64 body (≤ ~10 MB). Keeps one code path for phone camera, scanner and file picker. */
  route(app, 'post', '/documents', 'document.write', async (req, tx) => {
    const body = Upload.parse(req.body); const t = req.ctx.tenantId;
    if (!ALLOWED.includes(body.mime)) throw new HttpError(400, 'UNSUPPORTED_TYPE', { allowed: ALLOWED });
    const p = await tx.select().from(patient).where(and(eq(patient.id, body.patientId), eq(patient.tenantId, t))).then((r) => r[0]);
    if (!p) throw new HttpError(404, 'NOT_FOUND');
    if (body.kind === 'photo') {
      if (!body.mime.startsWith('image/')) throw new HttpError(400, 'UNSUPPORTED_TYPE', { allowed: ALLOWED.filter((m) => m.startsWith('image/')) });
      if (!hasPhotoConsent(p)) throw new HttpError(409, 'PHOTO_CONSENT_REQUIRED');
    }
    if (body.procedureSessionId) {
      const ps = await tx.select().from(procedureSession).where(and(eq(procedureSession.id, body.procedureSessionId), eq(procedureSession.tenantId, t))).then((r) => r[0]);
      if (!ps || ps.patientId !== body.patientId) throw new HttpError(400, 'SITTING_NOT_FOR_PATIENT');
    }
    const bytes = Buffer.from(body.dataBase64.replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (bytes.length > 10 * 1024 * 1024) throw new HttpError(413, 'TOO_LARGE');
    const ext = body.mime === 'application/pdf' ? 'pdf' : body.mime.split('/')[1];
    const [row] = await tx.insert(document).values({ tenantId: t, patientId: body.patientId, encounterId: body.encounterId, recommendationId: body.recommendationId, kind: body.kind,
      title: body.title, mime: body.mime, sizeBytes: bytes.length, storageKey: 'pending', note: body.note, uploadedBy: req.ctx.userId,
      area: body.kind === 'photo' ? body.area ?? null : null, view: body.kind === 'photo' ? body.view ?? null : null, procedureSessionId: body.procedureSessionId ?? null }).returning();
    const key = path.posix.join(t, body.patientId, `${row.id}.${ext}`);
    await putFile(key, bytes, body.mime); // inside the transaction: if storage fails, no record is left pointing at nothing
    await tx.update(document).set({ storageKey: key }).where(eq(document.id, row.id));
    if (body.recommendationId) await tx.update(recommendation).set({ status: 'done' }).where(and(eq(recommendation.id, body.recommendationId), eq(recommendation.tenantId, t), eq(recommendation.kind, 'investigation')));
    await emit(tx, req.ctx, 'document.uploaded', 'document', row.id, { patientId: body.patientId, kind: body.kind, mime: body.mime, sizeBytes: bytes.length, area: body.area, procedureSessionId: body.procedureSessionId });
    return { ...row, storageKey: key };
  });

  /** Re-tag a photo (wrong area, view or sitting) or edit its note. */
  route(app, 'patch', '/documents/:id', 'document.write', async (req, tx) => {
    const In = z.object({ area: Area.nullable().optional(), view: z.enum(PHOTO_VIEWS).nullable().optional(), note: z.string().max(500).nullable().optional(), procedureSessionId: z.string().uuid().nullable().optional() });
    const body = sent(In.parse(req.body), req.body); const t = req.ctx.tenantId;
    const cur = await tx.select().from(document).where(and(eq(document.id, (req.params as any).id), eq(document.tenantId, t))).then((r) => r[0]);
    if (!cur) throw new HttpError(404, 'NOT_FOUND');
    if (body.procedureSessionId) {
      const ps = await tx.select().from(procedureSession).where(and(eq(procedureSession.id, body.procedureSessionId), eq(procedureSession.tenantId, t))).then((r) => r[0]);
      if (!ps || ps.patientId !== cur.patientId) throw new HttpError(400, 'SITTING_NOT_FOR_PATIENT');
    }
    const [row] = await tx.update(document).set(body).where(eq(document.id, cur.id)).returning();
    await emit(tx, req.ctx, 'document.updated', 'document', row.id, body);
    return row;
  });

  app.get('/documents/:id/file', async (req, reply) => {
    const { withTenant } = await import('../db/index.js');
    const doc = await withTenant(req.ctx.tenantId, req.ctx.userId, (tx) =>
      tx.select().from(document).where(and(eq(document.id, (req.params as any).id), eq(document.tenantId, req.ctx.tenantId))).then((r) => r[0]));
    if (!doc || !req.perms.some((p) => p === '*' || p === 'document.*' || p === 'document.read')) throw new HttpError(404, 'NOT_FOUND');
    const file = await getFile(doc.storageKey);
    if (!file) throw new HttpError(404, 'FILE_MISSING');
    return reply.type(doc.mime).header('cache-control', 'private, max-age=3600').header('content-disposition', `inline; filename="${doc.title.replace(/[^\w. -]/g, '_')}"`).send(file);
  });

  route(app, 'delete', '/documents/:id', 'document.write', async (req, tx) => {
    const [row] = await tx.delete(document).where(and(eq(document.id, (req.params as any).id), eq(document.tenantId, req.ctx.tenantId))).returning();
    if (!row) throw new HttpError(404, 'NOT_FOUND');
    await emit(tx, req.ctx, 'document.deleted', 'document', row.id, { patientId: row.patientId });
    try { await deleteFile(row.storageKey); } catch (e) { req.log.warn({ err: e, key: row.storageKey }, 'stored file not deleted'); } // the record is gone either way
    return { ok: true };
  });
}
