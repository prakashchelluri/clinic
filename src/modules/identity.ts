import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db, withTenant } from '../db/index.js';
import { cleanIp, securityOf, ipExempt, ipAllowed, writeAudit, throttleOnce } from '../lib/audit.js';
import { tenant, appUser, practitioner, feeCategory, formDefinition, medicine, procedureCatalog, branch, specialty, room, service } from '../db/schema.js';
import { whatsappReady } from '../lib/messaging.js';
import { padConfig, printSettings } from '../lib/pad.js';
import { LAB_PARAMS } from '../lib/labs.js';
import { historyCategories } from '../lib/history.js';
import { verifyPassword, hashPassword, HttpError, can } from '../lib/auth.js';
import { testDataAllowed } from './sample.js';
import { route } from '../lib/route.js';

const Login = z.object({ tenant: z.string().optional(), email: z.string().email(), password: z.string() });

/** Too many wrong passwords from one address for one email: slow down for a while. In memory is enough for one server. */
const fails = new Map<string, { n: number; until: number; first: number }>();
const MAX_TRIES = 8, WINDOW_MS = 10 * 60_000;

export function identityRoutes(app: FastifyInstance) {
  // Clinic is resolved from the email. Only if the same email exists in several clinics is a clinic choice needed.
  app.post('/auth/login', async (req, reply) => {
    const body = Login.parse(req.body);
    const email = body.email.toLowerCase();
    const fk = `${req.ip}|${email}`; const f = fails.get(fk); const now = Date.now();
    if (f && f.until > now) throw new HttpError(429, 'TOO_MANY_ATTEMPTS', { retryAfterSeconds: Math.ceil((f.until - now) / 1000) });
    const fail = () => { const c = fails.get(fk); const cur = c && now - c.first < WINDOW_MS ? c : { n: 0, until: 0, first: now }; cur.n++; if (cur.n >= MAX_TRIES) cur.until = now + WINDOW_MS; fails.set(fk, cur); throw new HttpError(401, 'BAD_CREDENTIALS'); };
    let candidates = await db.select({ u: appUser, t: tenant }).from(appUser).innerJoin(tenant, eq(tenant.id, appUser.tenantId))
      .where(and(eq(appUser.email, email), eq(appUser.active, true)));
    if (body.tenant) candidates = candidates.filter((c) => c.t.slug === body.tenant);
    if (candidates.length > 1) throw new HttpError(409, 'CHOOSE_CLINIC', { clinics: candidates.map((c) => ({ slug: c.t.slug, name: c.t.name })) });
    const hit = candidates[0];
    if (!hit || !verifyPassword(body.password, hit.u.passwordHash)) return fail();
    fails.delete(fk);
    // Work only from the clinic: a right password from outside is stopped too, and the owner sees it.
    const roles = hit.u.roles?.length ? hit.u.roles : [hit.u.role];
    const who = { tenantId: hit.t.id, userId: hit.u.id, name: hit.u.name, role: hit.u.role, roles, ip: cleanIp(req.ip) };
    const sec = securityOf(hit.t.settings);
    if (sec.ipLock.enabled && !ipExempt(who, sec) && !ipAllowed(who.ip, sec.ipLock.allowed)) {
      if (throttleOnce(`stop|${who.userId}|${who.ip}`, 10 * 60_000)) await withTenant(hit.t.id, hit.u.id, (tx) => writeAudit(tx, who, { kind: 'signin', action: 'signin.stopped', summary: `Stopped: not on the clinic's internet (${who.ip})` }));
      throw new HttpError(403, 'IP_NOT_ALLOWED', { ip: who.ip });
    }
    await withTenant(hit.t.id, hit.u.id, (tx) => writeAudit(tx, who, { kind: 'signin', action: 'signin', summary: 'Signed in' }));
    reply.setCookie('cc_session', JSON.stringify({ u: hit.u.id, t: hit.t.id }), {
      path: '/', httpOnly: true, sameSite: 'lax', signed: true, secure: process.env.NODE_ENV === 'production', maxAge: 60 * 60 * 14,
    });
    return { id: hit.u.id, name: hit.u.name, role: hit.u.role, roles: hit.u.roles, mustChangePassword: hit.u.mustChangePassword, tenant: { id: hit.t.id, name: hit.t.name, slug: hit.t.slug } };
  });

  app.post('/auth/logout', async (_req, reply) => { reply.clearCookie('cc_session', { path: '/' }); return { ok: true }; });

  route(app, 'get', '/me', null, async (req) => ({ ...req.ctx, perms: req.perms, privacy: req.privacy }));

  /** Anyone signed in changes their own password: the current one first, then a new one of at least 8 characters. */
  route(app, 'patch', '/me/password', null, async (req, tx) => {
    const b = z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(8).max(200) }).parse(req.body);
    const u = await tx.select().from(appUser).where(and(eq(appUser.id, req.ctx.userId), eq(appUser.tenantId, req.ctx.tenantId))).then((r) => r[0]);
    if (!u || !verifyPassword(b.currentPassword, u.passwordHash)) throw new HttpError(400, 'WRONG_CURRENT_PASSWORD');
    if (b.newPassword === b.currentPassword) throw new HttpError(400, 'SAME_PASSWORD');
    await tx.update(appUser).set({ passwordHash: hashPassword(b.newPassword), mustChangePassword: false }).where(eq(appUser.id, u.id));
    return { ok: true };
  });

  // Everything the UI needs to render forms, pickers and prices, in one call.
  route(app, 'get', '/config', null, async (req, tx) => {
    const t = req.ctx.tenantId;
    const [ten, branches, practitioners, fees, forms, meds, procs, specs, rooms, services] = await Promise.all([
      tx.select().from(tenant).where(eq(tenant.id, t)).then((r) => r[0]),
      tx.select().from(branch).where(eq(branch.tenantId, t)),
      tx.select().from(practitioner).where(and(eq(practitioner.tenantId, t), eq(practitioner.active, true))),
      tx.select().from(feeCategory).where(and(eq(feeCategory.tenantId, t), eq(feeCategory.active, true))),
      tx.select().from(formDefinition).where(and(eq(formDefinition.tenantId, t), eq(formDefinition.active, true))),
      tx.select().from(medicine).where(eq(medicine.tenantId, t)),
      tx.select().from(procedureCatalog).where(and(eq(procedureCatalog.tenantId, t), eq(procedureCatalog.active, true))),
      tx.select().from(specialty).where(eq(specialty.tenantId, t)),
      tx.select().from(room).where(and(eq(room.tenantId, t), eq(room.active, true))),
      tx.select().from(service).where(and(eq(service.tenantId, t), eq(service.active, true))).orderBy(service.sortOrder, service.name),
    ]);
    // The clinic's allowed addresses and privacy rules are for the owner only; the waiting-room screen's secret only for who manages settings.
    const owner = req.ctx.roles.includes('owner'); const seeFees = can(req.perms, 'fees.see');
    let settings: any = owner ? ten.settings : { ...ten.settings, security: undefined };
    if (!can(req.perms, 'config.write')) settings = { ...settings, display: undefined };
    // Without 'See fees and payments' (the junior doctor) no prices travel: fee amounts (only "free" stays, the pad uses it to spot reviews), MRP, procedure and package prices.
    if (!seeFees && Array.isArray(settings.packages)) settings = { ...settings, packages: settings.packages.map(({ pricePaise, ...k }: any) => k) };
    const priced = seeFees ? { feeCategories: fees, medicines: meds, procedures: procs, services }
      : { feeCategories: fees.map((c) => ({ ...c, amountPaise: c.amountPaise === 0 ? 0 : null })), medicines: meds.map((m) => ({ ...m, mrpPaise: null })), procedures: procs.map((p) => ({ ...p, pricePaise: null })), services: services.map((x) => ({ ...x, pricePaise: null })) };
    return { tenant: { id: ten.id, name: ten.name, slug: ten.slug, timezone: ten.timezone, settings },
      testData: owner ? await testDataAllowed(tx, t, req.ctx.tenantKind) : false,
      branches, practitioners, ...priced, forms, specialties: specs, rooms, whatsappReady: whatsappReady(),
      pad: padConfig(ten.settings), printRx: printSettings(ten.settings), labParams: LAB_PARAMS, historyCategories: historyCategories(ten.settings) };
  });

  route(app, 'get', '/users', 'user.read', async (req, tx) =>
    tx.select({ id: appUser.id, name: appUser.name, email: appUser.email, role: appUser.role, roles: appUser.roles, practitionerId: appUser.practitionerId, active: appUser.active, mustChangePassword: appUser.mustChangePassword })
      .from(appUser).where(eq(appUser.tenantId, req.ctx.tenantId)));
}
