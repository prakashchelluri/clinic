import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenant, appUser, practitioner, feeCategory, formDefinition, medicine, procedureCatalog, branch, specialty } from '../db/schema.js';
import { verifyPassword, HttpError } from '../lib/auth.js';
import { route } from '../lib/route.js';

const Login = z.object({ tenant: z.string().optional(), email: z.string().email(), password: z.string() });

export function identityRoutes(app: FastifyInstance) {
  // Clinic is resolved from the email. Only if the same email exists in several clinics is a clinic choice needed.
  app.post('/auth/login', async (req, reply) => {
    const body = Login.parse(req.body);
    const email = body.email.toLowerCase();
    let candidates = await db.select({ u: appUser, t: tenant }).from(appUser).innerJoin(tenant, eq(tenant.id, appUser.tenantId))
      .where(and(eq(appUser.email, email), eq(appUser.active, true)));
    if (body.tenant) candidates = candidates.filter((c) => c.t.slug === body.tenant);
    if (candidates.length > 1) throw new HttpError(409, 'CHOOSE_CLINIC', { clinics: candidates.map((c) => ({ slug: c.t.slug, name: c.t.name })) });
    const hit = candidates[0];
    if (!hit || !verifyPassword(body.password, hit.u.passwordHash)) throw new HttpError(401, 'BAD_CREDENTIALS');
    reply.setCookie('cc_session', JSON.stringify({ u: hit.u.id, t: hit.t.id }), {
      path: '/', httpOnly: true, sameSite: 'lax', signed: true, secure: process.env.NODE_ENV === 'production', maxAge: 60 * 60 * 14,
    });
    return { id: hit.u.id, name: hit.u.name, role: hit.u.role, tenant: { id: hit.t.id, name: hit.t.name, slug: hit.t.slug } };
  });

  app.post('/auth/logout', async (_req, reply) => { reply.clearCookie('cc_session', { path: '/' }); return { ok: true }; });

  route(app, 'get', '/me', null, async (req) => ({ ...req.ctx, perms: req.perms }));

  // Everything the UI needs to render forms, pickers and prices, in one call.
  route(app, 'get', '/config', null, async (req, tx) => {
    const t = req.ctx.tenantId;
    const [ten, branches, practitioners, fees, forms, meds, procs, specs] = await Promise.all([
      tx.select().from(tenant).where(eq(tenant.id, t)).then((r) => r[0]),
      tx.select().from(branch).where(eq(branch.tenantId, t)),
      tx.select().from(practitioner).where(and(eq(practitioner.tenantId, t), eq(practitioner.active, true))),
      tx.select().from(feeCategory).where(and(eq(feeCategory.tenantId, t), eq(feeCategory.active, true))),
      tx.select().from(formDefinition).where(and(eq(formDefinition.tenantId, t), eq(formDefinition.active, true))),
      tx.select().from(medicine).where(eq(medicine.tenantId, t)),
      tx.select().from(procedureCatalog).where(and(eq(procedureCatalog.tenantId, t), eq(procedureCatalog.active, true))),
      tx.select().from(specialty).where(eq(specialty.tenantId, t)),
    ]);
    return { tenant: { id: ten.id, name: ten.name, slug: ten.slug, timezone: ten.timezone, settings: ten.settings },
      branches, practitioners, feeCategories: fees, forms, medicines: meds, procedures: procs, specialties: specs };
  });

  route(app, 'get', '/users', 'user.read', async (req, tx) =>
    tx.select({ id: appUser.id, name: appUser.name, email: appUser.email, role: appUser.role, active: appUser.active })
      .from(appUser).where(eq(appUser.tenantId, req.ctx.tenantId)));
}
