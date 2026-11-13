// Custom modules on the Rx pad, as Tatva has them: a clinic-wide list of small tables (a name and 1–4 columns).
// A doctor adds an existing one to their own pad or creates a new one. Once a module has been used on a pad it is locked
// (no edit, no delete), so past prescriptions read as they were written; to change it, create a new module.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { padModule, appUser } from '../db/schema.js';
import { route } from '../lib/route.js';
import { emit } from '../lib/core.js';
import { HttpError, can } from '../lib/auth.js';
import { usedModuleIds } from '../lib/pad.js';

const Name = z.string().trim().min(2).max(30);
const Columns = z.array(z.string().trim().min(1).max(15)).min(1).max(4);

export async function lockUsedModules(tx: any, tenantId: string, data: Record<string, any>) {
  const ids = usedModuleIds(data);
  if (ids.length) await tx.update(padModule).set({ used: true }).where(and(eq(padModule.tenantId, tenantId), inArray(padModule.id, ids), eq(padModule.used, false)));
}

export function padModuleRoutes(app: FastifyInstance) {
  const mine = async (tx: any, req: any) => {
    const id = (req.params as any).id;
    const m = await tx.select().from(padModule).where(and(eq(padModule.id, id), eq(padModule.tenantId, req.ctx.tenantId))).then((r: any[]) => r[0]);
    if (!m) throw new HttpError(404, 'NOT_FOUND');
    return m;
  };
  // the one who made it (or the owner) may change it, and only while no pad has used it
  const manage = (req: any) => (m: any) => m.createdBy === req.ctx.userId || can(req.perms, 'config.write');
  const unlocked = (req: any, m: any) => { if (m.used) throw new HttpError(409, 'MODULE_LOCKED'); if (!manage(req)(m)) throw new HttpError(403, 'FORBIDDEN:pad_module'); };

  /** Every module of the clinic, who made it, and whether it is on my pad. */
  route(app, 'get', '/pad-modules', 'encounter.intake', async (req, tx) => {
    const rows = await tx.select({ m: padModule, by: appUser.name }).from(padModule).leftJoin(appUser, eq(appUser.id, padModule.createdBy))
      .where(eq(padModule.tenantId, req.ctx.tenantId)).orderBy(asc(padModule.name));
    return rows.map(({ m, by }) => ({ id: m.id, name: m.name, columns: m.columns, used: m.used, createdBy: m.createdBy, createdByName: by ?? null, onPad: m.onPad.includes(req.ctx.userId), canEdit: !m.used && manage(req)(m) }));
  });

  /** Create a module and put it on my pad. */
  route(app, 'post', '/pad-modules', 'encounter.complete', async (req, tx) => {
    const b = z.object({ name: Name, columns: Columns }).parse(req.body);
    const dup = await tx.select({ id: padModule.id }).from(padModule).where(and(eq(padModule.tenantId, req.ctx.tenantId), sql`lower(${padModule.name}) = lower(${b.name})`)).then((r) => r[0]);
    if (dup) throw new HttpError(409, 'DUPLICATE');
    const [row] = await tx.insert(padModule).values({ tenantId: req.ctx.tenantId, name: b.name, columns: b.columns, createdBy: req.ctx.userId, onPad: [req.ctx.userId] }).returning();
    await emit(tx, req.ctx, 'pad_module.created', 'pad_module', row.id, { name: b.name });
    return row;
  });

  /** Add to my pad, or take it off (the module itself stays for everyone). */
  route(app, 'post', '/pad-modules/:id/pad', 'encounter.complete', async (req, tx) => {
    const on = z.object({ on: z.boolean() }).parse(req.body).on; const m = await mine(tx, req);
    const onPad = on ? [...new Set([...m.onPad, req.ctx.userId])] : m.onPad.filter((u: string) => u !== req.ctx.userId);
    await tx.update(padModule).set({ onPad }).where(eq(padModule.id, m.id));
    return { ok: true };
  });

  /** Rename or change the columns: only until it has been used on a pad. */
  route(app, 'patch', '/pad-modules/:id', 'encounter.complete', async (req, tx) => {
    const b = z.object({ name: Name.optional(), columns: Columns.optional() }).parse(req.body); const m = await mine(tx, req); unlocked(req, m);
    if (b.name) {
      const dup = await tx.select({ id: padModule.id }).from(padModule).where(and(eq(padModule.tenantId, req.ctx.tenantId), sql`lower(${padModule.name}) = lower(${b.name})`, sql`${padModule.id} <> ${m.id}`)).then((r) => r[0]);
      if (dup) throw new HttpError(409, 'DUPLICATE');
    }
    const [row] = await tx.update(padModule).set(b).where(eq(padModule.id, m.id)).returning();
    return row;
  });

  route(app, 'delete', '/pad-modules/:id', 'encounter.complete', async (req, tx) => {
    const m = await mine(tx, req); unlocked(req, m);
    await tx.delete(padModule).where(eq(padModule.id, m.id));
    await emit(tx, req.ctx, 'pad_module.deleted', 'pad_module', m.id, { name: m.name });
    return { ok: true };
  });
}
