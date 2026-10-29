import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ZodError } from 'zod';
import { eq, and } from 'drizzle-orm';
import { db, withTenant } from './db/index.js';
import { tenant, appUser } from './db/schema.js';
import { type Ctx, permsFor, HttpError } from './lib/auth.js';
import { route } from './lib/route.js';
import { identityRoutes } from './modules/identity.js';
import { patientRoutes } from './modules/patients.js';
import { schedulingRoutes } from './modules/scheduling.js';
import { visitRoutes } from './modules/visits.js';
import { clinicalRoutes } from './modules/clinical.js';
import { billingRoutes } from './modules/billing.js';
import { sampleRoutes } from './modules/sample.js';
import { documentRoutes } from './modules/documents.js';
import { pharmacyRoutes } from './modules/pharmacy.js';
import { stockRoutes } from './modules/stock.js';
import { broadcastRoutes } from './modules/broadcasts.js';
import { adminRoutes } from './modules/admin.js';
import { procedureRoutes } from './modules/procedures.js';
import { platformRoutes } from './modules/platform.js';
import { overviewRoutes } from './modules/overview.js';
import { publicRoutes } from './modules/public.js';

declare module 'fastify' {
  interface FastifyRequest { ctx: Ctx; perms: string[] }
}

export async function buildApp() {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test', bodyLimit: 15 * 1024 * 1024 });
  await app.register(cookie, { secret: process.env.COOKIE_SECRET ?? 'dev-secret-change-me' });

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ code: 'VALIDATION', errors: err.issues });
    if (err instanceof HttpError) return reply.code(err.status).send({ code: err.message, ...err.extra });
    // Database details never reach the browser: map the common cases, log the rest.
    const pg = err.cause?.code ?? err.code;
    if (pg === '23505') return reply.code(409).send({ code: 'DUPLICATE' });
    if (pg === '22P02') return reply.code(400).send({ code: 'BAD_ID' });
    if (pg === '23503') return reply.code(409).send({ code: 'IN_USE' });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ code: 'BAD_REQUEST', message: err.message });
    app.log.error(err);
    return reply.code(500).send({ code: 'INTERNAL', message: 'Something went wrong on our side. Please try again.' });
  });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff'); reply.header('x-frame-options', 'DENY'); reply.header('referrer-policy', 'same-origin');
    reply.header('permissions-policy', 'camera=(self), microphone=(), geolocation=()');
    reply.header('content-security-policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; script-src 'self'; connect-src 'self'; frame-src blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    if (process.env.NODE_ENV === 'production') reply.header('strict-transport-security', 'max-age=15552000');
  });

  app.get('/api/health', async () => ({ ok: true }));

  // Auth: signed cookie carries {u: userId, t: tenantId}; user row is re-read per request so deactivation is immediate.
  app.addHook('preHandler', async (req) => {
    if (!req.url.startsWith('/api/') || req.url.startsWith('/api/auth/login') || req.url.startsWith('/api/public/') || req.url === '/api/health') return;
    const raw = req.cookies.cc_session ? req.unsignCookie(req.cookies.cc_session) : null;
    if (!raw?.valid) throw new HttpError(401, 'UNAUTHENTICATED');
    const { u, t } = JSON.parse(raw.value);
    const ten = await db.select().from(tenant).where(eq(tenant.id, t)).then((r) => r[0]);
    const user = await withTenant(t, u, (tx) => tx.select().from(appUser).where(and(eq(appUser.id, u), eq(appUser.tenantId, t))).then((r) => r[0]));
    if (!ten || !user?.active) throw new HttpError(401, 'UNAUTHENTICATED');
    const roles = user.roles?.length ? user.roles : [user.role];
    req.ctx = { tenantId: t, userId: u, role: user.role, roles, name: user.name, practitionerId: user.practitionerId, timezone: ten.timezone, tenantKind: ten.kind };
    req.perms = permsFor(roles, ten.settings?.roles);
  });

  await app.register(async (api) => {
    identityRoutes(api); patientRoutes(api); schedulingRoutes(api); visitRoutes(api); clinicalRoutes(api); billingRoutes(api); sampleRoutes(api); documentRoutes(api); pharmacyRoutes(api); stockRoutes(api); broadcastRoutes(api); adminRoutes(api); procedureRoutes(api); platformRoutes(api); overviewRoutes(api); publicRoutes(api);
  }, { prefix: '/api' });

  // Serve the built PWA (web/dist) with SPA fallback.
  const dist = path.resolve('web/dist');
  if (existsSync(dist)) {
    await app.register(fastifyStatic, { root: dist, setHeaders: (res: any, p: string) => { const v = p.endsWith('.html') ? 'no-cache' : 'public, max-age=31536000, immutable'; if (typeof res.setHeader === 'function') res.setHeader('cache-control', v); else res.header('cache-control', v); } });
    app.setNotFoundHandler((req, reply) => req.url.startsWith('/api/') ? reply.code(404).send({ code: 'NOT_FOUND' }) : reply.header('cache-control', 'no-cache').sendFile('index.html'));
  }
  return app;
}
