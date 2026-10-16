import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, desc } from 'drizzle-orm';
import { mkdirSync, writeFileSync, createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import { document, recommendation } from '../db/schema.js';
import { route } from '../lib/route.js';
import { emit } from '../lib/core.js';
import { HttpError } from '../lib/auth.js';

// ponytail: files on local disk under UPLOAD_DIR; swap for S3 with the same storageKey when hosting needs it.
const ROOT = process.env.UPLOAD_DIR ?? './data/uploads';
const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

const Upload = z.object({
  patientId: z.string().uuid(), encounterId: z.string().uuid().optional(), recommendationId: z.string().uuid().optional(),
  kind: z.enum(['report', 'photo', 'prescription', 'consent', 'other']).default('report'),
  title: z.string().min(1).max(200), note: z.string().max(500).optional(),
  mime: z.string(), dataBase64: z.string().min(1),
});

export function documentRoutes(app: FastifyInstance) {
  route(app, 'get', '/patients/:id/documents', 'document.read', async (req, tx) =>
    tx.select().from(document).where(and(eq(document.tenantId, req.ctx.tenantId), eq(document.patientId, (req.params as any).id))).orderBy(desc(document.createdAt)));

  /** Upload as JSON with base64 body (≤ ~10 MB). Keeps one code path for phone camera, scanner and file picker. */
  route(app, 'post', '/documents', 'document.write', async (req, tx) => {
    const body = Upload.parse(req.body); const t = req.ctx.tenantId;
    if (!ALLOWED.includes(body.mime)) throw new HttpError(400, 'UNSUPPORTED_TYPE', { allowed: ALLOWED });
    const bytes = Buffer.from(body.dataBase64.replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (bytes.length > 10 * 1024 * 1024) throw new HttpError(413, 'TOO_LARGE');
    const ext = body.mime === 'application/pdf' ? 'pdf' : body.mime.split('/')[1];
    const [row] = await tx.insert(document).values({ tenantId: t, patientId: body.patientId, encounterId: body.encounterId, recommendationId: body.recommendationId, kind: body.kind,
      title: body.title, mime: body.mime, sizeBytes: bytes.length, storageKey: 'pending', note: body.note, uploadedBy: req.ctx.userId }).returning();
    const key = path.posix.join(t, body.patientId, `${row.id}.${ext}`);
    mkdirSync(path.join(ROOT, t, body.patientId), { recursive: true });
    writeFileSync(path.join(ROOT, key), bytes);
    await tx.update(document).set({ storageKey: key }).where(eq(document.id, row.id));
    if (body.recommendationId) await tx.update(recommendation).set({ status: 'done' }).where(and(eq(recommendation.id, body.recommendationId), eq(recommendation.tenantId, t), eq(recommendation.kind, 'investigation')));
    await emit(tx, req.ctx, 'document.uploaded', 'document', row.id, { patientId: body.patientId, kind: body.kind, mime: body.mime, sizeBytes: bytes.length });
    return { ...row, storageKey: key };
  });

  app.get('/documents/:id/file', async (req, reply) => {
    const { withTenant } = await import('../db/index.js');
    const doc = await withTenant(req.ctx.tenantId, req.ctx.userId, (tx) =>
      tx.select().from(document).where(and(eq(document.id, (req.params as any).id), eq(document.tenantId, req.ctx.tenantId))).then((r) => r[0]));
    if (!doc || !req.perms.some((p) => p === '*' || p === 'document.*' || p === 'document.read')) throw new HttpError(404, 'NOT_FOUND');
    const file = path.join(ROOT, doc.storageKey);
    if (!existsSync(file)) throw new HttpError(404, 'FILE_MISSING');
    return reply.type(doc.mime).header('cache-control', 'private, max-age=3600').header('content-disposition', `inline; filename="${doc.title.replace(/[^\w. -]/g, '_')}"`).send(createReadStream(file));
  });

  route(app, 'delete', '/documents/:id', 'document.write', async (req, tx) => {
    const [row] = await tx.delete(document).where(and(eq(document.id, (req.params as any).id), eq(document.tenantId, req.ctx.tenantId))).returning();
    if (!row) throw new HttpError(404, 'NOT_FOUND');
    await emit(tx, req.ctx, 'document.deleted', 'document', row.id, { patientId: row.patientId });
    return { ok: true };
  });
}
