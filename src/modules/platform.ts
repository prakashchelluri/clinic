import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenant } from '../db/schema.js';
import { HttpError, can } from '../lib/auth.js';
import { createClinic } from '../db/seed.js';

/** CUBOTT staff only: list and onboard clinics. Runs outside any tenant transaction; tenant table is not RLS-protected. */
export function platformRoutes(app: FastifyInstance) {
  const guard = (req: any) => { if (req.ctx.tenantKind !== 'platform' || !can(req.perms, 'platform.read')) throw new HttpError(403, 'FORBIDDEN:platform'); };

  app.get('/platform/tenants', async (req) => {
    guard(req);
    const rows: any = await db.execute(sql`
      select t.id, t.slug, t.name, t.timezone, t.created_at,
        (select count(*)::int from app_user u where u.tenant_id = t.id and u.active) as users,
        (select count(*)::int from patient p where p.tenant_id = t.id) as patients,
        (select count(*)::int from visit v where v.tenant_id = t.id and v.day >= current_date - 30) as visits_30d,
        (select max(e.occurred_at) from domain_event e where e.tenant_id = t.id) as last_activity
      from tenant t where t.kind = 'clinic' order by t.created_at desc`);
    return rows.rows ?? rows;
  });

  app.post('/platform/tenants', async (req) => {
    guard(req);
    if (!can(req.perms, 'platform.write')) throw new HttpError(403, 'FORBIDDEN:platform.write');
    const body = z.object({ name: z.string().min(2), slug: z.string().min(2).max(40), address: z.string().optional(), phone: z.string().optional(), timezone: z.string().optional(),
      owner: z.object({ name: z.string().min(1), email: z.string().email(), password: z.string().min(6), regNo: z.string().optional(), qualification: z.string().optional(), isDoctor: z.boolean().default(true) }) }).parse(req.body);
    try { return await createClinic(body); }
    catch (e: any) { if (e.message === 'SLUG_TAKEN') throw new HttpError(409, 'SLUG_TAKEN'); throw e; }
  });

  app.patch('/platform/tenants/:id', async (req) => {
    guard(req);
    if (!can(req.perms, 'platform.write')) throw new HttpError(403, 'FORBIDDEN:platform.write');
    const body = z.object({ name: z.string().min(2).optional(), timezone: z.string().optional() }).parse(req.body);
    const [row] = await db.update(tenant).set(body).where(eq(tenant.id, (req.params as any).id)).returning();
    if (!row) throw new HttpError(404, 'NOT_FOUND');
    return { id: row.id, name: row.name, slug: row.slug };
  });
}
