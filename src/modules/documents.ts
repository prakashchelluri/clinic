import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, desc, gte, inArray, isNotNull, isNull } from 'drizzle-orm';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { document, domainEvent, recommendation, patient, procedureSession, procedureCatalog, practitioner, tenant } from '../db/schema.js';
import { route } from '../lib/route.js';
import { emit, sent } from '../lib/core.js';
import { HttpError, can } from '../lib/auth.js';
import { putFile, getFile, deleteFile } from '../lib/storage.js';

const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
export const PHOTO_VIEWS = ['front', 'left', 'right', 'back', 'closeup'] as const;
export const DEFAULT_PHOTO_AREAS = ['Face', 'Forehead', 'Cheeks', 'Chin', 'Upper lip', 'Nose', 'Scalp', 'Neck', 'Chest', 'Back', 'Arms', 'Hands', 'Underarms', 'Legs', 'Feet', 'Nails', 'Other'];
const Area = z.string().trim().min(1).max(40);

const Upload = z.object({
  patientId: z.string().uuid(), encounterId: z.string().uuid().optional(), recommendationId: z.string().uuid().optional(), recommendationIds: z.array(z.string().uuid()).max(20).optional(),
  kind: z.enum(['report', 'photo', 'prescription', 'consent', 'canvas', 'other']).default('report'), // canvas: a drawing from the pad
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
    // granting takes proof: the signed page saved as the patient's document, or paper: true when the paper form is filed
    const body = z.object({ key: z.enum(['photos']), granted: z.boolean(), documentId: z.string().uuid().optional(), paper: z.literal(true).optional(), wording: z.string().trim().max(8000).optional() }).parse(req.body); const t = req.ctx.tenantId; const id = (req.params as any).id;
    const p = await tx.select().from(patient).where(and(eq(patient.id, id), eq(patient.tenantId, t))).then((r) => r[0]);
    if (!p) throw new HttpError(404, 'NOT_FOUND');
    if (body.granted && !body.documentId && !body.paper) throw new HttpError(400, 'CONSENT_PROOF_REQUIRED');
    let doc: { id: string; sha256: string | null } | undefined;
    if (body.documentId) {
      doc = await tx.select({ id: document.id, sha256: document.sha256 }).from(document).where(and(eq(document.id, body.documentId), eq(document.tenantId, t), eq(document.patientId, id), eq(document.kind, 'consent'))).then((r) => r[0]);
      if (!doc) throw new HttpError(400, 'CONSENT_NOT_FOR_PATIENT');
    }
    const consents = { ...(p.consents ?? {}) };
    if (body.granted) consents[body.key] = { grantedAt: new Date().toISOString(), by: req.ctx.name, ...(doc ? signedRecord(doc, body.wording) : { how: 'signed paper form filed' }) }; else delete consents[body.key];
    await tx.update(patient).set({ consents }).where(eq(patient.id, id));
    await emit(tx, req.ctx, body.granted ? 'consent.granted' : 'consent.withdrawn', 'patient', id, { key: body.key, ...(doc ? { documentId: doc.id, sha256: doc.sha256, wordingSha256: body.wording ? sha256(body.wording) : null } : {}) });
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
    // a photo pinned on the skin map takes the pin's area unless one was given
    // a result can belong to several tests at once (one report for CBC, TSH and LFT)
    const recIds = [...new Set([...(body.recommendationIds ?? []), ...(body.recommendationId ? [body.recommendationId] : [])])];
    const recs = recIds.length ? await tx.select().from(recommendation).where(and(eq(recommendation.tenantId, t), inArray(recommendation.id, recIds), eq(recommendation.patientId, body.patientId), eq(recommendation.kind, 'investigation'))) : [];
    if (recs.length !== recIds.length) throw new HttpError(400, 'TEST_NOT_FOR_PATIENT');
    const bytes = Buffer.from(body.dataBase64.replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (bytes.length > 10 * 1024 * 1024) throw new HttpError(413, 'TOO_LARGE');
    const hash = sha256(bytes);
    const ext = body.mime === 'application/pdf' ? 'pdf' : body.mime.split('/')[1];
    const [row] = await tx.insert(document).values({ tenantId: t, patientId: body.patientId, encounterId: body.encounterId, recommendationId: recIds[0], recommendationIds: recIds, kind: body.kind,
      title: body.title, mime: body.mime, sizeBytes: bytes.length, storageKey: 'pending', sha256: hash, note: body.note, uploadedBy: req.ctx.userId,
      area: body.kind === 'photo' ? body.area ?? null : null, view: body.kind === 'photo' ? body.view ?? null : null, procedureSessionId: body.procedureSessionId ?? null }).returning();
    const key = path.posix.join(t, body.patientId, `${row.id}.${ext}`);
    await putFile(key, bytes, body.mime); // inside the transaction: if storage fails, no record is left pointing at nothing
    await tx.update(document).set({ storageKey: key }).where(eq(document.id, row.id));
    for (const r of recs) if (r.status !== 'done') await tx.update(recommendation).set({ status: 'done', receivedAt: new Date().toISOString(), contactLog: [...r.contactLog, { at: new Date().toISOString(), by: req.ctx.name, outcome: 'Result received', note: body.note || body.title }] }).where(eq(recommendation.id, r.id));
    await emit(tx, req.ctx, 'document.uploaded', 'document', row.id, { patientId: body.patientId, kind: body.kind, mime: body.mime, sizeBytes: bytes.length, sha256: hash, area: body.area, procedureSessionId: body.procedureSessionId });
    return { ...row, storageKey: key };
  });

  /** Test results from the last days: each test with its files, newest first, so the Tests tab and the doctor can open them. */
  route(app, 'get', '/results', 'document.read', async (req, tx) => {
    const t = req.ctx.tenantId; const days = Math.min(60, Math.max(1, Number((req.query as any).days) || 7));
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const docs = await tx.select({ d: document, p: { id: patient.id, fullName: patient.fullName, patientNo: patient.patientNo } }).from(document).innerJoin(patient, eq(patient.id, document.patientId))
      .where(and(eq(document.tenantId, t), eq(document.kind, 'report'), isNotNull(document.recommendationId), gte(document.createdAt, since))).orderBy(desc(document.createdAt));
    const ids = [...new Set(docs.flatMap((x) => x.d.recommendationIds.length ? x.d.recommendationIds : x.d.recommendationId ? [x.d.recommendationId] : []))];
    const recs = ids.length ? await tx.select().from(recommendation).where(and(eq(recommendation.tenantId, t), inArray(recommendation.id, ids))) : [];
    return recs.map((r) => {
      const mine = docs.filter((x) => x.d.recommendationId === r.id || x.d.recommendationIds.includes(r.id));
      return { id: r.id, test: r.notes, status: r.status, patient: mine[0]?.p, at: mine[0]?.d.createdAt, documents: mine.map((x) => ({ id: x.d.id, title: x.d.title, mime: x.d.mime, kind: x.d.kind, sizeBytes: x.d.sizeBytes, createdAt: x.d.createdAt, note: x.d.note, reviewedAt: x.d.reviewedAt })) };
    }).filter((r) => r.patient).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  });

  /** The doctor opened these results. */
  route(app, 'post', '/documents/review', 'document.read', async (req, tx) => {
    const { ids } = z.object({ ids: z.array(z.string().uuid()).min(1).max(50) }).parse(req.body);
    await tx.update(document).set({ reviewedAt: new Date().toISOString() }).where(and(eq(document.tenantId, req.ctx.tenantId), inArray(document.id, ids), isNull(document.reviewedAt)));
    return { ok: true };
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

  /** Is the stored file still the one that was saved? Compares it with the fingerprint taken on upload, also kept in the audit log, which nobody can edit.
   *  unchanged | changed | unknown (saved before fingerprints began) | missing (file gone). */
  route(app, 'get', '/documents/:id/check', 'document.read', async (req, tx) => {
    const id = (req.params as any).id;
    const doc = await tx.select().from(document).where(and(eq(document.id, id), eq(document.tenantId, req.ctx.tenantId))).then((r) => r[0]);
    if (!doc) throw new HttpError(404, 'NOT_FOUND');
    const ev = await tx.select({ payload: domainEvent.payload }).from(domainEvent).where(and(eq(domainEvent.tenantId, req.ctx.tenantId), eq(domainEvent.aggregateId, id), eq(domainEvent.type, 'document.uploaded'))).then((r) => r[0]);
    const logged = (ev?.payload as any)?.sha256 as string | undefined;
    if (!logged && !doc.sha256) return { state: 'unknown' };
    const file = await getFile(doc.storageKey);
    if (!file) return { state: 'missing' };
    const h = createHash('sha256'); for await (const c of file) h.update(c as Buffer);
    const now = h.digest('hex');
    return { state: now === doc.sha256 && (!logged || now === logged) ? 'unchanged' : 'changed' };
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
    const k = await tx.select({ kind: document.kind }).from(document).where(and(eq(document.id, (req.params as any).id), eq(document.tenantId, req.ctx.tenantId))).then((r) => r[0]);
    if (k?.kind === 'consent') throw new HttpError(409, 'CONSENT_DOCUMENT_KEPT'); // a signed consent is the record of what was agreed
    const [row] = await tx.delete(document).where(and(eq(document.id, (req.params as any).id), eq(document.tenantId, req.ctx.tenantId))).returning();
    if (!row) throw new HttpError(404, 'NOT_FOUND');
    await emit(tx, req.ctx, 'document.deleted', 'document', row.id, { patientId: row.patientId });
    try { await deleteFile(row.storageKey); } catch (e) { req.log.warn({ err: e, key: row.storageKey }, 'stored file not deleted'); } // the record is gone either way
    return { ok: true };
  });
}

const sha256 = (x: Buffer | string) => createHash('sha256').update(x).digest('hex');
/** A consent signed on the tablet: the signed page, its fingerprint, and the exact wording the patient read. */
export const signedRecord = (doc: { id: string; sha256: string | null }, wording?: string) =>
  ({ how: 'signed', documentId: doc.id, ...(doc.sha256 ? { sha256: doc.sha256 } : {}), ...(wording ? { wording } : {}) });
