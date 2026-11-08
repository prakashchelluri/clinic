import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, desc, sql } from 'drizzle-orm';
import { bodyPin, document, patient, encounter } from '../db/schema.js';
import { route } from '../lib/route.js';
import { HttpError } from '../lib/auth.js';
import { emit } from '../lib/core.js';

/** The skin map: pins on the body silhouette, kept across visits. A pin holds where, what was seen, what it was, and its photos. */
export function skinmapRoutes(app: FastifyInstance) {
  route(app, 'get', '/patients/:id/pins', 'patient.read', async (req, tx) => {
    const t = req.ctx.tenantId; const id = (req.params as any).id;
    const rows = await tx.select({ p: bodyPin, encounterAt: encounter.createdAt, photos: sql<number>`(select count(*)::int from document d where d.pin_id = ${bodyPin.id})`,
      lastPhotoAt: sql<string | null>`(select max(d.taken_at) from document d where d.pin_id = ${bodyPin.id})` })
      .from(bodyPin).leftJoin(encounter, eq(encounter.id, bodyPin.encounterId))
      .where(and(eq(bodyPin.tenantId, t), eq(bodyPin.patientId, id))).orderBy(desc(bodyPin.createdAt));
    return rows.map((r) => ({ ...r.p, encounterAt: r.encounterAt, photos: r.photos, lastPhotoAt: r.lastPhotoAt }));
  });

  const PinIn = z.object({ encounterId: z.string().uuid().nullish(), side: z.enum(['front', 'back']).default('front'), x: z.number().min(0).max(1), y: z.number().min(0).max(1),
    area: z.string().trim().min(1).max(40), finding: z.string().trim().max(200).nullish(), diagnosis: z.string().trim().max(120).nullish() });
  route(app, 'post', '/patients/:id/pins', 'encounter.intake', async (req, tx) => {
    const b = PinIn.parse(req.body); const t = req.ctx.tenantId; const id = (req.params as any).id;
    const p = await tx.select({ id: patient.id }).from(patient).where(and(eq(patient.id, id), eq(patient.tenantId, t))).then((r) => r[0]);
    if (!p) throw new HttpError(404, 'NOT_FOUND');
    const [row] = await tx.insert(bodyPin).values({ tenantId: t, patientId: id, encounterId: b.encounterId ?? null, side: b.side, x: b.x, y: b.y, area: b.area, finding: b.finding ?? null, diagnosis: b.diagnosis ?? null, createdBy: req.ctx.name }).returning();
    await emit(tx, req.ctx, 'pin.added', 'patient', id, { pinId: row.id, area: b.area, side: b.side });
    return { ...row, photos: 0, lastPhotoAt: null };
  });

  route(app, 'patch', '/pins/:id', 'encounter.intake', async (req, tx) => {
    const b = z.object({ x: z.number().min(0).max(1).optional(), y: z.number().min(0).max(1).optional(), area: z.string().trim().min(1).max(40).optional(), finding: z.string().trim().max(200).nullable().optional(), diagnosis: z.string().trim().max(120).nullable().optional(), resolved: z.boolean().optional(), encounterId: z.string().uuid().nullable().optional() }).parse(req.body);
    const cur = await tx.select().from(bodyPin).where(and(eq(bodyPin.id, (req.params as any).id), eq(bodyPin.tenantId, req.ctx.tenantId))).then((r) => r[0]);
    if (!cur) throw new HttpError(404, 'NOT_FOUND');
    const { resolved, ...rest } = b;
    const [row] = await tx.update(bodyPin).set({ ...rest, ...(resolved === undefined ? {} : { resolvedAt: resolved ? new Date().toISOString() : null }) }).where(eq(bodyPin.id, cur.id)).returning();
    return row;
  });

  /** A pin with photos is history: it can be resolved but not removed. */
  route(app, 'delete', '/pins/:id', 'encounter.intake', async (req, tx) => {
    const cur = await tx.select().from(bodyPin).where(and(eq(bodyPin.id, (req.params as any).id), eq(bodyPin.tenantId, req.ctx.tenantId))).then((r) => r[0]);
    if (!cur) throw new HttpError(404, 'NOT_FOUND');
    const n = await tx.select({ n: sql<number>`count(*)::int` }).from(document).where(eq(document.pinId, cur.id)).then((r) => r[0].n);
    if (n > 0) throw new HttpError(409, 'PIN_HAS_PHOTOS', { photos: n });
    await tx.delete(bodyPin).where(eq(bodyPin.id, cur.id));
    return { ok: true };
  });
}
