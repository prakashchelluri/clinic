import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, desc } from 'drizzle-orm';
import { tenant, appUser, practitioner, feeCategory, medicine, procedureCatalog, room, formDefinition, branch, type FormSchema } from '../db/schema.js';
import { route } from '../lib/route.js';
import { emit } from '../lib/core.js';
import { hashPassword, HttpError, DEFAULT_ROLES } from '../lib/auth.js';

const ROLE_KEYS = Object.keys(DEFAULT_ROLES).filter((r) => r !== 'superadmin') as [string, ...string[]];

/** Clinic settings: everything the owner changes without a developer. */
export function adminRoutes(app: FastifyInstance) {
  route(app, 'patch', '/admin/clinic', 'config.write', async (req, tx) => {
    const body = z.object({ name: z.string().min(1).optional(), settings: z.record(z.string(), z.any()).optional() }).parse(req.body);
    const cur = await tx.select().from(tenant).where(eq(tenant.id, req.ctx.tenantId)).then((r) => r[0]);
    const [row] = await tx.update(tenant).set({ ...(body.name ? { name: body.name } : {}), ...(body.settings ? { settings: deepMerge(cur.settings, body.settings) } : {}) }).where(eq(tenant.id, req.ctx.tenantId)).returning();
    await emit(tx, req.ctx, 'clinic.updated', 'tenant', row.id, body);
    return { id: row.id, name: row.name, settings: row.settings };
  });

  // --- users: one person, several roles (owner + doctor is the common case) ---
  const UserIn = z.object({ name: z.string().min(1), email: z.string().email(), password: z.string().min(6).optional(), roles: z.array(z.enum(ROLE_KEYS)).min(1), practitionerId: z.string().uuid().nullable().optional(), active: z.boolean().optional() });
  route(app, 'post', '/admin/users', 'user.write', async (req, tx) => {
    const body = UserIn.parse(req.body);
    if (!body.password) throw new HttpError(400, 'PASSWORD_REQUIRED');
    const [row] = await tx.insert(appUser).values({ tenantId: req.ctx.tenantId, name: body.name, email: body.email.toLowerCase(), passwordHash: hashPassword(body.password), role: body.roles[0], roles: body.roles, practitionerId: body.practitionerId ?? null }).returning();
    await emit(tx, req.ctx, 'user.created', 'user', row.id, { roles: body.roles });
    return pub(row);
  });
  route(app, 'patch', '/admin/users/:id', 'user.write', async (req, tx) => {
    const body = UserIn.partial().parse(req.body); const id = (req.params as any).id;
    if (id === req.ctx.userId && body.active === false) throw new HttpError(400, 'CANNOT_DEACTIVATE_SELF');
    const set: any = { ...body }; delete set.password; if (body.password) set.passwordHash = hashPassword(body.password); if (body.email) set.email = body.email.toLowerCase(); if (body.roles) set.role = body.roles[0];
    const [row] = await tx.update(appUser).set(set).where(and(eq(appUser.id, id), eq(appUser.tenantId, req.ctx.tenantId))).returning();
    if (!row) throw new HttpError(404, 'NOT_FOUND');
    await emit(tx, req.ctx, 'user.updated', 'user', row.id, { ...body, password: body.password ? '***' : undefined });
    return pub(row);
  });

  // --- practitioners ---
  const PracIn = z.object({ name: z.string().min(1), regNo: z.string().optional().nullable(), qualification: z.string().optional().nullable(), specialtyId: z.string().uuid().optional().nullable(), active: z.boolean().optional() });
  route(app, 'post', '/admin/practitioners', 'config.write', async (req, tx) => (await tx.insert(practitioner).values({ ...PracIn.parse(req.body), tenantId: req.ctx.tenantId }).returning())[0]);
  route(app, 'patch', '/admin/practitioners/:id', 'config.write', async (req, tx) => upd(tx, practitioner, req, PracIn.partial().parse(req.body)));

  // --- rooms ---
  const RoomIn = z.object({ name: z.string().min(1), capabilities: z.array(z.string().min(1)).default([]), branchId: z.string().uuid().optional(), active: z.boolean().optional() });
  route(app, 'post', '/admin/rooms', 'config.write', async (req, tx) => {
    const body = RoomIn.parse(req.body);
    const branchId = body.branchId ?? (await tx.select().from(branch).where(eq(branch.tenantId, req.ctx.tenantId)))[0].id;
    return (await tx.insert(room).values({ ...body, branchId, tenantId: req.ctx.tenantId }).returning())[0];
  });
  route(app, 'patch', '/admin/rooms/:id', 'config.write', async (req, tx) => upd(tx, room, req, RoomIn.partial().parse(req.body)));

  // --- fee categories ---
  const FeeIn = z.object({ code: z.string().min(1).max(8).toUpperCase(), name: z.string().min(1), amountPaise: z.number().int().min(0), taxRateBp: z.number().int().min(0).optional(), priority: z.number().int().optional(), affectsCapacity: z.boolean().optional(), eligibility: z.any().optional().nullable(), eligibilityNote: z.string().optional().nullable(), active: z.boolean().optional() });
  route(app, 'post', '/admin/fee-categories', 'config.write', async (req, tx) => (await tx.insert(feeCategory).values({ ...FeeIn.parse(req.body), tenantId: req.ctx.tenantId }).returning())[0]);
  route(app, 'patch', '/admin/fee-categories/:id', 'config.write', async (req, tx) => upd(tx, feeCategory, req, FeeIn.partial().parse(req.body)));

  // --- medicines ---
  const MedIn = z.object({ name: z.string().min(1), form: z.string().optional().nullable(), strength: z.string().optional().nullable(), scheduleClass: z.string().optional().nullable(), defaults: z.object({ dose: z.string().optional(), route: z.string().optional(), frequency: z.string().optional(), durationDays: z.number().int().optional(), instructions: z.string().optional() }).optional().nullable() });
  route(app, 'post', '/admin/medicines', 'config.write', async (req, tx) => (await tx.insert(medicine).values({ ...MedIn.parse(req.body), tenantId: req.ctx.tenantId }).returning())[0]);
  route(app, 'patch', '/admin/medicines/:id', 'config.write', async (req, tx) => upd(tx, medicine, req, MedIn.partial().parse(req.body)));
  route(app, 'delete', '/admin/medicines/:id', 'config.write', async (req, tx) => { await tx.delete(medicine).where(and(eq(medicine.id, (req.params as any).id), eq(medicine.tenantId, req.ctx.tenantId))); return { ok: true }; });

  // --- procedures ---
  const ProcIn = z.object({ name: z.string().min(1), typicalMinutes: z.number().int().min(5).optional(), bufferMinutes: z.number().int().min(0).optional(), requiresMainDoctor: z.boolean().optional(), requiresReview: z.boolean().optional(), requiredCapability: z.string().optional().nullable(), pricePaise: z.number().int().min(0).optional().nullable(), taxRateBp: z.number().int().min(0).optional(), typicalSittings: z.number().int().min(1).optional(), specialtyId: z.string().uuid().optional().nullable(), active: z.boolean().optional() });
  route(app, 'post', '/admin/procedures', 'config.write', async (req, tx) => (await tx.insert(procedureCatalog).values({ ...ProcIn.parse(req.body), tenantId: req.ctx.tenantId }).returning())[0]);
  route(app, 'patch', '/admin/procedures/:id', 'config.write', async (req, tx) => upd(tx, procedureCatalog, req, ProcIn.partial().parse(req.body)));

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
