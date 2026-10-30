import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { tmpl } from '../db/schema.js';
import { route } from '../lib/route.js';
import { emit } from '../lib/core.js';
import { HttpError, can } from '../lib/auth.js';

const RxItem = z.object({ medicineId: z.string().uuid().nullable().optional(), name: z.string().min(1).max(120), dose: z.string().nullish(), route: z.string().nullish(),
  frequency: z.string().nullish(), durationDays: z.number().int().min(1).max(365).nullish(), instructions: z.string().max(200).nullish() });
const Str = z.string().trim().min(1).max(120);
/** What each kind of set holds. Anything else is refused, so a set can never carry stray data into a note. */
const Payload = {
  medicine: z.object({ items: z.array(RxItem).min(1).max(20) }),
  complaint: z.object({ questions: z.array(z.object({ q: Str, detail: z.string().trim().max(80).optional() })).max(30) }),
  finding: z.object({ chips: z.array(Str).min(1).max(30) }),
  advice: z.object({ lines: z.array(Str).min(1).max(20) }),
  tests: z.object({ tests: z.array(z.object({ name: Str, days: z.number().int().min(0).max(60).optional() })).min(1).max(20) }),
  procedure: z.object({ procedureId: z.string().uuid(), sittings: z.number().int().min(1).max(60).optional(), intervalDays: z.number().int().min(1).max(365).optional(), pricePaise: z.number().int().min(0).optional() }),
} as const;
const Kind = z.enum(['medicine', 'complaint', 'finding', 'advice', 'tests', 'procedure']);
const Linked = z.object({ complaints: z.array(Str).max(20).optional(), diagnoses: z.array(Str).max(20).optional() }).default({});
const Body = z.object({ kind: Kind, name: z.string().trim().min(2).max(80), linked: Linked, mode: z.enum(['chip', 'auto']).default('chip'), payload: z.record(z.string(), z.any()) });
const checkPayload = (kind: keyof typeof Payload, payload: unknown) => { const r = Payload[kind].safeParse(payload); if (!r.success) throw new HttpError(400, 'BAD_TEMPLATE', { errors: r.error.issues }); return r.data as Record<string, any>; };

export function templateRoutes(app: FastifyInstance) {
  /** Sets for the note, the check-in and the settings page. Drafts and retired sets are listed only on the settings page (all=1, owners). */
  route(app, 'get', '/templates', null, async (req, tx) => {
    if (!can(req.perms, 'encounter.intake') && !can(req.perms, 'visit.write') && !can(req.perms, 'config.write')) throw new HttpError(403, 'FORBIDDEN:encounter.intake');
    const kind = (req.query as any).kind as string | undefined; const all = (req.query as any).all === '1' && can(req.perms, 'config.write');
    return tx.select().from(tmpl).where(and(eq(tmpl.tenantId, req.ctx.tenantId), kind ? eq(tmpl.kind, kind) : sql`true`, all ? sql`true` : and(eq(tmpl.active, true), eq(tmpl.draft, false))))
      .orderBy(asc(tmpl.sortOrder), desc(tmpl.uses), asc(tmpl.name));
  });

  /** The owner creates sets directly. A doctor's "Save as template" lands as a draft for the owner to approve. */
  route(app, 'post', '/templates', null, async (req, tx) => {
    const direct = can(req.perms, 'config.write');
    if (!direct && !can(req.perms, 'encounter.complete')) throw new HttpError(403, 'FORBIDDEN:encounter.complete');
    const b = Body.parse(req.body); const payload = checkPayload(b.kind, b.payload);
    const dup = await tx.select().from(tmpl).where(and(eq(tmpl.tenantId, req.ctx.tenantId), eq(tmpl.kind, b.kind), sql`lower(${tmpl.name}) = lower(${b.name})`)).then((r) => r[0]);
    if (dup) throw new HttpError(409, 'DUPLICATE');
    const [row] = await tx.insert(tmpl).values({ tenantId: req.ctx.tenantId, kind: b.kind, name: b.name, linked: b.linked, mode: b.mode, payload, draft: !direct }).returning();
    await emit(tx, req.ctx, 'template.created', 'tmpl', row.id, { kind: b.kind, name: b.name, draft: !direct });
    return row;
  });

  route(app, 'patch', '/templates/:id', 'config.write', async (req, tx) => {
    const id = (req.params as any).id;
    const b = z.object({ name: z.string().trim().min(2).max(80).optional(), linked: Linked.optional(), mode: z.enum(['chip', 'auto']).optional(), payload: z.record(z.string(), z.any()).optional(),
      active: z.boolean().optional(), draft: z.boolean().optional(), sortOrder: z.number().int().min(0).max(9999).optional() }).parse(req.body);
    const cur = await tx.select().from(tmpl).where(and(eq(tmpl.id, id), eq(tmpl.tenantId, req.ctx.tenantId))).then((r) => r[0]);
    if (!cur) throw new HttpError(404, 'NOT_FOUND');
    const set: any = { ...b }; if (b.payload) set.payload = checkPayload(cur.kind as keyof typeof Payload, b.payload);
    if (b.name && b.name.toLowerCase() !== cur.name.toLowerCase()) {
      const dup = await tx.select({ id: tmpl.id }).from(tmpl).where(and(eq(tmpl.tenantId, req.ctx.tenantId), eq(tmpl.kind, cur.kind), sql`lower(${tmpl.name}) = lower(${b.name})`)).then((r) => r[0]);
      if (dup) throw new HttpError(409, 'DUPLICATE');
    }
    const [row] = await tx.update(tmpl).set(set).where(eq(tmpl.id, id)).returning();
    await emit(tx, req.ctx, 'template.updated', 'tmpl', id, { name: row.name });
    return row;
  });

  route(app, 'post', '/templates/:id/use', 'encounter.intake', async (req, tx) => {
    const [row] = await tx.update(tmpl).set({ uses: sql`${tmpl.uses} + 1` }).where(and(eq(tmpl.id, (req.params as any).id), eq(tmpl.tenantId, req.ctx.tenantId))).returning({ id: tmpl.id });
    if (!row) throw new HttpError(404, 'NOT_FOUND'); return { ok: true };
  });

  route(app, 'delete', '/templates/:id', 'config.write', async (req, tx) => {
    const [row] = await tx.delete(tmpl).where(and(eq(tmpl.id, (req.params as any).id), eq(tmpl.tenantId, req.ctx.tenantId))).returning();
    if (!row) throw new HttpError(404, 'NOT_FOUND'); return { ok: true };
  });
}
