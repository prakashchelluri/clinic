import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, desc, sql } from 'drizzle-orm';
import { tenant, appUser, practitioner, service, feeCategory, medicine, procedureCatalog, room, formDefinition, branch, type FormSchema } from '../db/schema.js';
import { route } from '../lib/route.js';
import { emit, sent } from '../lib/core.js';
import jsonLogic from 'json-logic-js';
import { DEFAULT_ROLES, PERMISSIONS, hashPassword, HttpError, can, rolesFor, isKnownPerm, expandPerms, BUILTIN_NAMES } from '../lib/auth.js';

const DEFAULT_ROLES_FOR = (k: string) => DEFAULT_ROLES[k] ?? [];
const Name = z.string().trim().min(1).max(100);
const clinicRoles = async (tx: any, tenantId: string) => rolesFor((await tx.select().from(tenant).where(eq(tenant.id, tenantId)).then((r: any) => r[0]))?.settings);

/** Clinic settings: everything the owner changes without a developer. */
export function adminRoutes(app: FastifyInstance) {
  route(app, 'patch', '/admin/clinic', 'config.write', async (req, tx) => {
    const body = z.object({ name: Name.optional(), settings: z.record(z.string(), z.any()).optional() }).parse(req.body);
    if (body.settings?.photos?.areas !== undefined) body.settings.photos.areas = z.array(z.string().trim().min(1).max(40)).min(1).max(40).parse(body.settings.photos.areas);
    const cur = await tx.select().from(tenant).where(eq(tenant.id, req.ctx.tenantId)).then((r) => r[0]);
    const [row] = await tx.update(tenant).set({ ...(body.name ? { name: body.name } : {}), ...(body.settings ? { settings: deepMerge(cur.settings, body.settings) } : {}) }).where(eq(tenant.id, req.ctx.tenantId)).returning();
    await emit(tx, req.ctx, 'clinic.updated', 'tenant', row.id, body);
    return { id: row.id, name: row.name, settings: row.settings };
  });

  // --- users: one person, several roles (owner + doctor is the common case) ---
  const UserIn = z.object({ name: Name, email: z.string().trim().email().max(200), password: z.string().min(6).max(200).optional(), roles: z.array(z.string().min(1)).min(1), practitionerId: z.string().uuid().nullable().optional(), active: z.boolean().optional() });
  route(app, 'post', '/admin/users', 'user.write', async (req, tx) => {
    const body = UserIn.parse(req.body); await checkRoles(tx, req.ctx.tenantId, body.roles);
    if (!body.password) throw new HttpError(400, 'PASSWORD_REQUIRED');
    const [row] = await tx.insert(appUser).values({ tenantId: req.ctx.tenantId, name: body.name, email: body.email.toLowerCase(), passwordHash: hashPassword(body.password), role: body.roles[0], roles: body.roles, practitionerId: body.practitionerId ?? null }).returning();
    await emit(tx, req.ctx, 'user.created', 'user', row.id, { roles: body.roles });
    return pub(row);
  });
  route(app, 'patch', '/admin/users/:id', 'user.write', async (req, tx) => {
    const body = sent(UserIn.partial().parse(req.body), req.body); const id = (req.params as any).id; if (body.roles) await checkRoles(tx, req.ctx.tenantId, body.roles);
    if (id === req.ctx.userId && body.active === false) throw new HttpError(400, 'CANNOT_DEACTIVATE_SELF');
    const set: any = { ...body }; delete set.password; if (body.password) set.passwordHash = hashPassword(body.password); if (body.email) set.email = body.email.toLowerCase(); if (body.roles) set.role = body.roles[0];
    const [row] = await tx.update(appUser).set(set).where(and(eq(appUser.id, id), eq(appUser.tenantId, req.ctx.tenantId))).returning();
    if (!row) throw new HttpError(404, 'NOT_FOUND');
    await emit(tx, req.ctx, 'user.updated', 'user', row.id, { ...body, password: body.password ? '***' : undefined });
    return pub(row);
  });

  // --- roles: each clinic decides what every role can do, and can add its own ---
  async function checkRoles(tx: any, tenantId: string, keys: string[]) {
    const known = new Set((await clinicRoles(tx, tenantId)).map((r) => r.key));
    for (const k of keys) if (!known.has(k)) throw new HttpError(400, 'UNKNOWN_ROLE', { role: k });
  }
  route(app, 'get', '/admin/permissions', 'user.read', async () => PERMISSIONS);
  route(app, 'get', '/admin/roles', 'user.read', async (req, tx) => {
    const users = await tx.select({ roles: appUser.roles }).from(appUser).where(and(eq(appUser.tenantId, req.ctx.tenantId), eq(appUser.active, true)));
    return (await clinicRoles(tx, req.ctx.tenantId)).map((r) => ({ ...r, users: users.filter((u) => u.roles?.includes(r.key)).length, defaultPerms: r.builtin ? expandPerms(r.key === 'owner' ? ['*'] : DEFAULT_ROLES_FOR(r.key)) : null }));
  });
  const RolePerms = z.array(z.string()).max(100).refine((a) => a.every(isKnownPerm), 'UNKNOWN_PERMISSION');
  /** You can only hand out what you hold yourself, so an admin cannot promote a role (or themselves) beyond their own reach. */
  const mayGrant = (req: any, perms: string[]) => { for (const p of perms) if (!can(req.perms, p)) throw new HttpError(403, 'CANNOT_GRANT', { permission: p }); };
  route(app, 'post', '/admin/roles', 'config.write', async (req, tx) => {
    const body = z.object({ name: Name, perms: RolePerms }).parse(req.body); mayGrant(req, body.perms);
    const cur = await tx.select().from(tenant).where(eq(tenant.id, req.ctx.tenantId)).then((r) => r[0]);
    const base = body.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'role'; let key = base; let i = 2;
    while (BUILTIN_NAMES[key] || key === 'superadmin' || cur.settings?.roles?.[key]) key = base + '_' + i++;
    await tx.update(tenant).set({ settings: { ...cur.settings, roles: { ...(cur.settings?.roles ?? {}), [key]: body.perms }, roleNames: { ...(cur.settings?.roleNames ?? {}), [key]: body.name } } }).where(eq(tenant.id, cur.id));
    await emit(tx, req.ctx, 'role.created', 'tenant', cur.id, { key, perms: body.perms });
    return { key };
  });
  route(app, 'patch', '/admin/roles/:key', 'config.write', async (req, tx) => {
    const key = (req.params as any).key as string; const body = z.object({ name: Name.optional(), perms: RolePerms.optional() }).parse(req.body);
    if (key === 'owner') throw new HttpError(400, 'OWNER_IS_FIXED');
    const cur = await tx.select().from(tenant).where(eq(tenant.id, req.ctx.tenantId)).then((r) => r[0]);
    if (!(await clinicRoles(tx, cur.id)).some((r) => r.key === key)) throw new HttpError(404, 'NOT_FOUND');
    const roles = { ...(cur.settings?.roles ?? {}) }; const roleNames = { ...(cur.settings?.roleNames ?? {}) };
    if (body.perms) {
      const before = new Set(expandPerms(roles[key] ?? DEFAULT_ROLES_FOR(key))); mayGrant(req, body.perms.filter((p) => !before.has(p)));
      roles[key] = body.perms;
    }
    if (body.name && !BUILTIN_NAMES[key]) roleNames[key] = body.name;
    await tx.update(tenant).set({ settings: { ...cur.settings, roles, roleNames } }).where(eq(tenant.id, cur.id));
    await emit(tx, req.ctx, 'role.updated', 'tenant', cur.id, { key, ...body });
    return { ok: true };
  });
  /** Custom role: delete (only if nobody holds it). Built-in role: reset to the standard permissions. */
  route(app, 'delete', '/admin/roles/:key', 'config.write', async (req, tx) => {
    const key = (req.params as any).key as string; if (key === 'owner') throw new HttpError(400, 'OWNER_IS_FIXED');
    const cur = await tx.select().from(tenant).where(eq(tenant.id, req.ctx.tenantId)).then((r) => r[0]);
    const roles = { ...(cur.settings?.roles ?? {}) }; const roleNames = { ...(cur.settings?.roleNames ?? {}) };
    if (!BUILTIN_NAMES[key]) {
      const held = await tx.select({ roles: appUser.roles }).from(appUser).where(and(eq(appUser.tenantId, cur.id), eq(appUser.active, true)));
      if (held.some((u) => u.roles?.includes(key))) throw new HttpError(409, 'ROLE_IN_USE');
      delete roleNames[key];
    }
    delete roles[key];
    await tx.update(tenant).set({ settings: { ...cur.settings, roles, roleNames } }).where(eq(tenant.id, cur.id));
    await emit(tx, req.ctx, 'role.removed', 'tenant', cur.id, { key });
    return { ok: true };
  });

  // --- practitioners ---
  const PracIn = z.object({ name: Name, regNo: z.string().optional().nullable(), qualification: z.string().optional().nullable(), specialtyId: z.string().uuid().optional().nullable(), active: z.boolean().optional() });
  route(app, 'post', '/admin/practitioners', 'config.write', async (req, tx) => (await tx.insert(practitioner).values({ ...PracIn.parse(req.body), tenantId: req.ctx.tenantId }).returning())[0]);
  route(app, 'patch', '/admin/practitioners/:id', 'config.write', async (req, tx) => upd(tx, practitioner, req, sent(PracIn.partial().parse(req.body), req.body)));

  // --- rooms ---
  const RoomIn = z.object({ name: Name, capabilities: z.array(z.string().min(1)).default([]), branchId: z.string().uuid().optional(), active: z.boolean().optional() });
  route(app, 'post', '/admin/rooms', 'config.write', async (req, tx) => {
    const body = RoomIn.parse(req.body);
    const branchId = body.branchId ?? (await tx.select().from(branch).where(eq(branch.tenantId, req.ctx.tenantId)))[0].id;
    return (await tx.insert(room).values({ ...body, branchId, tenantId: req.ctx.tenantId }).returning())[0];
  });
  route(app, 'patch', '/admin/rooms/:id', 'config.write', async (req, tx) => upd(tx, room, req, sent(RoomIn.partial().parse(req.body), req.body)));

  // --- fee categories ---
  const FeeIn = z.object({ code: z.string().min(1).max(8).toUpperCase(), name: Name, amountPaise: z.number().int().min(0).max(100000000), taxRateBp: z.number().int().min(0).optional(), priority: z.number().int().optional(), affectsCapacity: z.boolean().optional(), eligibility: z.any().optional().nullable(), eligibilityNote: z.string().optional().nullable(), active: z.boolean().optional() });
  route(app, 'post', '/admin/fee-categories', 'config.write', async (req, tx) => { const b = FeeIn.parse(req.body); checkRule(b.eligibility); return (await tx.insert(feeCategory).values({ ...b, tenantId: req.ctx.tenantId }).returning())[0]; });
  route(app, 'patch', '/admin/fee-categories/:id', 'config.write', async (req, tx) => { const b = sent(FeeIn.partial().parse(req.body), req.body); checkRule(b.eligibility); return upd(tx, feeCategory, req, b); });

  // --- medicines ---
  const MedIn = z.object({ name: Name, form: z.string().optional().nullable(), strength: z.string().optional().nullable(), scheduleClass: z.string().optional().nullable(), defaults: z.object({ dose: z.string().optional(), route: z.string().optional(), frequency: z.string().optional(), durationDays: z.number().int().optional(), instructions: z.string().optional() }).optional().nullable() });
  route(app, 'post', '/admin/medicines', 'config.write', async (req, tx) => {
    const b = MedIn.parse(req.body);
    const dup = await tx.select({ id: medicine.id }).from(medicine).where(and(eq(medicine.tenantId, req.ctx.tenantId), sql`lower(${medicine.name}) = ${b.name.toLowerCase()}`, sql`coalesce(${medicine.strength},'') = ${b.strength ?? ''}`)).limit(1);
    if (dup.length) throw new HttpError(409, 'DUPLICATE', { what: 'medicine' });
    return (await tx.insert(medicine).values({ ...b, tenantId: req.ctx.tenantId }).returning())[0];
  });
  route(app, 'patch', '/admin/medicines/:id', 'config.write', async (req, tx) => upd(tx, medicine, req, sent(MedIn.partial().parse(req.body), req.body)));
  route(app, 'delete', '/admin/medicines/:id', 'config.write', async (req, tx) => { await tx.delete(medicine).where(and(eq(medicine.id, (req.params as any).id), eq(medicine.tenantId, req.ctx.tenantId))); return { ok: true }; });

  // --- procedures ---
  const ProcIn = z.object({ name: Name, typicalMinutes: z.number().int().min(5).optional(), bufferMinutes: z.number().int().min(0).optional(), requiresMainDoctor: z.boolean().optional(), requiresReview: z.boolean().optional(), requiredCapability: z.string().optional().nullable(), pricePaise: z.number().int().min(0).optional().nullable(), taxRateBp: z.number().int().min(0).optional(), typicalSittings: z.number().int().min(1).optional(), specialtyId: z.string().uuid().optional().nullable(), active: z.boolean().optional() });
  route(app, 'post', '/admin/procedures', 'config.write', async (req, tx) => (await tx.insert(procedureCatalog).values({ ...ProcIn.parse(req.body), tenantId: req.ctx.tenantId }).returning())[0]);
  route(app, 'patch', '/admin/procedures/:id', 'config.write', async (req, tx) => upd(tx, procedureCatalog, req, sent(ProcIn.partial().parse(req.body), req.body)));

  // --- visit types (services): what patients book ---
  const ServiceIn = z.object({ name: Name, description: z.string().trim().max(300).optional().nullable(), minutes: z.number().int().min(5).max(480).optional(),
    pricePaise: z.number().int().min(0).max(100000000).optional().nullable(), feeCategoryId: z.string().uuid().optional().nullable(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    bufferMinutes: z.number().int().min(0).max(240).optional(), places: z.number().int().min(1).max(10).optional(), practitionerIds: z.array(z.string().uuid()).max(50).optional(),
    onlineBookable: z.boolean().optional(), sortOrder: z.number().int().min(0).max(1000).optional(), active: z.boolean().optional() });
  route(app, 'get', '/admin/services', 'config.write', async (req, tx) => tx.select().from(service).where(eq(service.tenantId, req.ctx.tenantId)).orderBy(service.sortOrder, service.name));
  route(app, 'post', '/admin/services', 'config.write', async (req, tx) => {
    const b = ServiceIn.parse(req.body);
    const [row] = await tx.insert(service).values({ ...b, tenantId: req.ctx.tenantId }).returning();
    await emit(tx, req.ctx, 'service.created', 'service', row.id, b); return row;
  });
  route(app, 'patch', '/admin/services/:id', 'config.write', async (req, tx) => {
    const b = sent(ServiceIn.partial().parse(req.body), req.body); const row = await upd(tx, service, req, b);
    await emit(tx, req.ctx, 'service.updated', 'service', row.id, b); return row;
  });

  // --- forms: saving creates a new version; completed encounters keep theirs ---
  const Field = z.object({ key: z.string().regex(/^[a-z0-9_]+$/), label: z.string().min(1), type: z.enum(['text', 'textarea', 'number', 'select', 'multiselect', 'tags', 'diagnoses', 'duration', 'date']), required: z.boolean().optional(), options: z.array(z.string()).optional(), unit: z.string().optional(), placeholder: z.string().optional() });
  const Schema = z.object({ sections: z.array(z.object({ key: z.string().regex(/^[a-z0-9_]+$/), title: z.string().min(1), fields: z.array(Field) })).min(1) });
  route(app, 'post', '/admin/forms/:key', 'config.write', async (req, tx) => {
    const key = (req.params as any).key as string; const schema = Schema.parse(req.body) as FormSchema; const t = req.ctx.tenantId;
    const cur = await tx.select().from(formDefinition).where(and(eq(formDefinition.tenantId, t), eq(formDefinition.key, key))).orderBy(desc(formDefinition.version)).then((r) => r[0]);
    if (cur) await tx.update(formDefinition).set({ active: false }).where(and(eq(formDefinition.tenantId, t), eq(formDefinition.key, key)));
    const [row] = await tx.insert(formDefinition).values({ tenantId: t, key, specialtyId: cur?.specialtyId ?? null, version: (cur?.version ?? 0) + 1, schema }).returning();
    await emit(tx, req.ctx, 'form.published', 'form_definition', row.id, { key, version: row.version });
    return row;
  });
}

async function upd(tx: any, table: any, req: any, set: any) {
  const [row] = await tx.update(table).set(set).where(and(eq(table.id, req.params.id), eq(table.tenantId, req.ctx.tenantId))).returning();
  if (!row) throw new HttpError(404, 'NOT_FOUND');
  return row;
}
const pub = (u: any) => ({ id: u.id, name: u.name, email: u.email, role: u.role, roles: u.roles, practitionerId: u.practitionerId, active: u.active });
function deepMerge(a: any, b: any): any {
  if (!a || typeof a !== 'object' || Array.isArray(b) || typeof b !== 'object') return b;
  const out = { ...a }; for (const k of Object.keys(b)) out[k] = deepMerge(a[k], b[k]); return out;
}

/** A fee rule must be valid JSONLogic that evaluates, so one typo can never break check-in for everyone. */
function checkRule(rule: unknown) {
  if (rule == null) return;
  try { jsonLogic.apply(rule as any, { days_since_last_paid_consult: 0, has_open_procedure_course: false, patient: { referralCard: false } }); }
  catch (e: any) { throw new HttpError(400, 'BAD_RULE', { message: String(e?.message ?? e) }); }
}
