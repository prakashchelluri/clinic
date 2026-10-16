import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ZodError } from 'zod';
import { eq, and } from 'drizzle-orm';
import { db, withTenant } from './db/index.js';
import { tenant, appUser } from './db/schema.js';
import { type Ctx, DEFAULT_ROLES, HttpError } from './lib/auth.js';
import { route } from './lib/route.js';
import { identityRoutes } from './modules/identity.js';
import { patientRoutes } from './modules/patients.js';
import { schedulingRoutes } from './modules/scheduling.js';
import { visitRoutes } from './modules/visits.js';
import { clinicalRoutes } from './modules/clinical.js';
import { billingRoutes } from './modules/billing.js';

declare module 'fastify' {
  interface FastifyRequest { ctx: Ctx; perms: string[] }
}

export async function buildApp() {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });
  await app.register(cookie, { secret: process.env.COOKIE_SECRET ?? 'dev-secret-change-me' });

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ code: 'VALIDATION', errors: err.issues });
    if (err instanceof HttpError) return reply.code(err.status).send({ code: err.message, ...err.extra });
    app.log.error(err);
    return reply.code(err.statusCode ?? 500).send({ code: 'INTERNAL', message: err.message });
  });

  app.get('/api/health', async () => ({ ok: true }));

  // Auth: signed cookie carries {u: userId, t: tenantId}; user row is re-read per request so deactivation is immediate.
  app.addHook('preHandler', async (req) => {
    if (!req.url.startsWith('/api/') || req.url.startsWith('/api/auth/login') || req.url === '/api/health') return;
    const raw = req.cookies.cc_session ? req.unsignCookie(req.cookies.cc_session) : null;
    if (!raw?.valid) throw new HttpError(401, 'UNAUTHENTICATED');
    const { u, t } = JSON.parse(raw.value);
    const ten = await db.select().from(tenant).where(eq(tenant.id, t)).then((r) => r[0]);
    const user = await withTenant(t, u, (tx) => tx.select().from(appUser).where(and(eq(appUser.id, u), eq(appUser.tenantId, t))).then((r) => r[0]));
    if (!ten || !user?.active) throw new HttpError(401, 'UNAUTHENTICATED');
    req.ctx = { tenantId: t, userId: u, role: user.role, name: user.name, practitionerId: user.practitionerId, timezone: ten.timezone };
    req.perms = ten.settings?.roles?.[user.role] ?? DEFAULT_ROLES[user.role] ?? [];
  });

  await app.register(async (api) => {
    identityRoutes(api); patientRoutes(api); schedulingRoutes(api); visitRoutes(api); clinicalRoutes(api); billingRoutes(api);
  }, { prefix: '/api' });

  // Serve the built PWA (web/dist) with SPA fallback.
  const dist = path.resolve('web/dist');
  if (existsSync(dist)) {
    await app.register(fastifyStatic, { root: dist, wildcard: false });
    app.setNotFoundHandler((req, reply) => req.url.startsWith('/api/') ? reply.code(404).send({ code: 'NOT_FOUND' }) : reply.sendFile('index.html'));
  }
  return app;
}
