import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, eq, gte, desc, sql, inArray } from 'drizzle-orm';
import { tenant, appUser, auditLog, patient } from '../db/schema.js';
import { route } from '../lib/route.js';
import { HttpError } from '../lib/auth.js';
import { securityOf, validIp, ipAllowed, writeAudit, cleanIp } from '../lib/audit.js';

const isOwner = (req: FastifyRequest) => req.ctx.roles.some((r) => r === 'owner' || r === 'superadmin');
const canAudit = (req: FastifyRequest) => req.ctx.roles.some((r) => r === 'owner' || r === 'admin' || r === 'superadmin');
const ROLES = ['owner', 'admin', 'doctor', 'receptionist', 'assistant', 'coordinator', 'pharmacist'];

const Addr = z.object({ label: z.string().trim().min(1).max(60), from: z.string().trim().refine(validIp, 'BAD_IP'), to: z.string().trim().refine(validIp, 'BAD_IP').nullish() });
const SecurityIn = z.object({
  ipLock: z.object({ enabled: z.boolean(), allowed: z.array(Addr).max(50), anywhere: z.array(z.string().uuid()).max(200), ignored: z.array(z.string().max(45)).max(500).default([]) }),
  idleMinutes: z.union([z.literal(0), z.literal(10), z.literal(30), z.literal(60)]),
  phoneRoles: z.array(z.string().max(40)).max(40), listRoles: z.array(z.string().max(40)).max(40),
});

export function securityRoutes(app: FastifyInstance) {
  /** Privacy & access: settings, this computer's address, team members, and staff who were stopped from new addresses. Owner only. */
  route(app, 'get', '/security', null, async (req, tx) => {
    if (!isOwner(req)) throw new HttpError(403, 'FORBIDDEN:owner');
    const t = req.ctx.tenantId;
    const ten = await tx.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, t)).then((r) => r[0]);
    const sec = securityOf(ten.settings);
    const users = await tx.select({ id: appUser.id, name: appUser.name, roles: appUser.roles, role: appUser.role }).from(appUser).where(and(eq(appUser.tenantId, t), eq(appUser.active, true)));
    // Latest stop per person and address in the last 14 days, unless that address is now allowed or the owner ignored it.
    const stops = await tx.select().from(auditLog).where(and(eq(auditLog.tenantId, t), eq(auditLog.action, 'signin.stopped'), gte(auditLog.at, sql`now() - interval '14 days'`))).orderBy(desc(auditLog.at)).limit(300);
    const seen = new Set<string>(); const stopped: any[] = [];
    for (const s of stops) {
      const key = `${s.userId}|${s.ip}`; if (seen.has(key) || !s.ip) continue; seen.add(key);
      if (ipAllowed(s.ip, sec.ipLock.allowed) || sec.ipLock.ignored.includes(s.ip)) continue;
      stopped.push({ id: s.id, at: s.at, userId: s.userId, name: s.userName, role: s.role, ip: s.ip });
    }
    return { security: sec, myIp: req.ctx.ip, myIpAllowed: ipAllowed(req.ctx.ip!, sec.ipLock.allowed), users: users.map((u) => ({ id: u.id, name: u.name, roles: u.roles?.length ? u.roles : [u.role] })), stopped, roles: ROLES };
  });

  route(app, 'put', '/security', null, async (req, tx) => {
    if (!isOwner(req)) throw new HttpError(403, 'FORBIDDEN:owner');
    const b = SecurityIn.parse(req.body); const t = req.ctx.tenantId;
    // Turning the lock on with no address would stop every member of staff at once.
    if (b.ipLock.enabled && !b.ipLock.allowed.length) throw new HttpError(409, 'ADD_AN_ADDRESS');
    for (const a of b.ipLock.allowed) if (a.to && (!/^\d+\.\d+\.\d+\.\d+$/.test(a.from) || !/^\d+\.\d+\.\d+\.\d+$/.test(a.to))) throw new HttpError(400, 'RANGE_IPV4_ONLY');
    const cur = await tx.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, t)).then((r) => r[0]);
    req.auditBefore = securityOf(cur.settings);
    const next = { ...b, ipLock: { ...b.ipLock, allowed: b.ipLock.allowed.map((a) => ({ label: a.label, from: cleanIp(a.from), to: a.to ? cleanIp(a.to) : null })) },
      phoneRoles: b.phoneRoles.filter((r) => r !== 'owner'), listRoles: [...new Set(['owner', ...b.listRoles])] };
    await tx.update(tenant).set({ settings: sql`${tenant.settings} || ${JSON.stringify({ security: next })}::jsonb` }).where(eq(tenant.id, t));
    return next;
  });

  /** The audit log, newest first. Owner and admin. */
  route(app, 'get', '/audit', null, async (req, tx) => {
    if (!canAudit(req)) throw new HttpError(403, 'FORBIDDEN:audit');
    const q = z.object({ days: z.coerce.number().int().min(1).max(366).default(1), userId: z.string().uuid().optional(), kind: z.enum(['money', 'change', 'cancel', 'view', 'print', 'signin', 'settings']).optional(),
      patientId: z.string().uuid().optional(), unusual: z.coerce.boolean().optional(), before: z.coerce.number().int().optional() }).parse(req.query);
    const t = req.ctx.tenantId;
    const rows = await tx.select({ a: auditLog, patient: patient.fullName, patientNo: patient.patientNo }).from(auditLog).leftJoin(patient, eq(patient.id, auditLog.patientId))
      .where(and(eq(auditLog.tenantId, t), gte(auditLog.at, sql`now() - make_interval(days => ${q.days})`),
        ...(q.userId ? [eq(auditLog.userId, q.userId)] : []), ...(q.kind ? [eq(auditLog.kind, q.kind)] : []), ...(q.patientId ? [eq(auditLog.patientId, q.patientId)] : []),
        ...(q.unusual ? [eq(auditLog.unusual, true)] : []), ...(q.before ? [sql`${auditLog.id} < ${q.before}`] : [])))
      .orderBy(desc(auditLog.id)).limit(200);
    return rows.map((r) => ({ ...r.a, patient: r.patient, patientNo: r.patientNo }));
  });

  /** Things only the browser knows about: a list printed or downloaded. Recorded for everyone; lists are refused for roles the owner has not allowed. */
  route(app, 'post', '/audit/event', null, async (req, tx) => {
    const b = z.object({ kind: z.literal('print'), what: z.string().trim().min(2).max(120), count: z.number().int().min(0).max(100000).optional() }).parse(req.body);
    if (!req.privacy?.canExport) throw new HttpError(403, 'LISTS_OWNER_ONLY');
    req.audited = true;
    await writeAudit(tx, req.ctx, { kind: 'print', action: 'list.exported', summary: `${b.what}${b.count !== undefined ? ` · ${b.count} patients` : ''}`, unusual: true });
    return { ok: true };
  });

  /** "Seen by" on a patient's record: who touched it, most recent first. Owner and admin. */
  route(app, 'get', '/patients/:id/seen-by', null, async (req, tx) => {
    if (!canAudit(req)) throw new HttpError(403, 'FORBIDDEN:audit');
    const id = z.string().uuid().parse((req.params as any).id);
    const rows = await tx.select({ userId: auditLog.userId, name: auditLog.userName, role: auditLog.role, at: sql<string>`max(${auditLog.at})`, unusual: sql<boolean>`bool_or(${auditLog.unusual})`, what: sql<string>`(array_agg(${auditLog.summary} order by ${auditLog.at} desc))[1]` })
      .from(auditLog).where(and(eq(auditLog.tenantId, req.ctx.tenantId), eq(auditLog.patientId, id), inArray(auditLog.kind, ['view', 'change', 'money', 'cancel', 'print'])))
      .groupBy(auditLog.userId, auditLog.userName, auditLog.role).orderBy(sql`max(${auditLog.at}) desc`).limit(20);
    return rows;
  });
}
