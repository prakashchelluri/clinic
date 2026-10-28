import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, desc, inArray, sql } from 'drizzle-orm';
import { broadcast, message, patient, tenant, appUser } from '../db/schema.js';
import type { Tx } from '../db/index.js';
import { route } from '../lib/route.js';
import { emit, todayIn, addDays } from '../lib/core.js';
import { HttpError } from '../lib/auth.js';

const AUDIENCES = { all: 'Everyone', recent: 'Seen recently', lapsed: 'Not seen for a while', followup: 'Follow-up overdue', course: 'In a procedure course', pick: 'Picked patients' } as const;
type Audience = keyof typeof AUDIENCES;
const Aud = z.object({ audience: z.enum(['all', 'recent', 'lapsed', 'followup', 'course', 'pick']), days: z.number().int().min(1).max(730).optional(), ids: z.array(z.string().uuid()).max(2000).optional() });

const validPhone = (p: string | null) => !!p && /^[0-9]{10}$/.test(p);
const label = (a: Audience, days?: number) => a === 'recent' ? `Seen in the last ${days ?? 30} days` : a === 'lapsed' ? `Not seen for ${days ?? 180} days` : AUDIENCES[a];
const fill = (body: string, vars: Record<string, string>) => body.replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m);

/** Patients matching a group. Plain SQL conditions so a clinic of any size answers at once. */
async function audience(tx: Tx, t: string, tz: string, a: z.infer<typeof Aud>) {
  const today = todayIn(tz);
  const cond = {
    all: sql`true`,
    recent: sql`exists (select 1 from visit v where v.patient_id = ${patient.id} and v.day >= ${addDays(today, -(a.days ?? 30))})`,
    lapsed: sql`exists (select 1 from visit v where v.patient_id = ${patient.id}) and not exists (select 1 from visit v where v.patient_id = ${patient.id} and v.day >= ${addDays(today, -(a.days ?? 180))})`,
    followup: sql`exists (select 1 from recommendation r where r.patient_id = ${patient.id} and r.kind = 'followup' and r.status in ('open','contacted') and r.due_on < ${today})`,
    course: sql`exists (select 1 from recommendation r where r.patient_id = ${patient.id} and r.kind = 'procedure' and r.status in ('open','contacted','scheduled'))`,
    pick: a.ids?.length ? inArray(patient.id, a.ids) : sql`false`,
  }[a.audience];
  return tx.select({ id: patient.id, fullName: patient.fullName, patientNo: patient.patientNo, phone: patient.phone }).from(patient).where(and(eq(patient.tenantId, t), cond)).orderBy(patient.fullName);
}

/** Bulk messages to patients. Demo for now: each message is recorded in the outbox as logged, nothing leaves the building. */
export function broadcastRoutes(app: FastifyInstance) {
  route(app, 'post', '/broadcasts/preview', 'message.broadcast', async (req, tx) => {
    const a = Aud.parse(req.body);
    const rows = await audience(tx, req.ctx.tenantId, req.ctx.timezone, a);
    const ok = rows.filter((r) => validPhone(r.phone));
    return { total: ok.length, skipped: rows.length - ok.length, recipients: ok.slice(0, 1000) };
  });

  const Send = Aud.extend({ title: z.string().trim().max(80).optional(), body: z.string().trim().min(1).max(1000), ids: z.array(z.string().uuid()).min(1).max(2000) });
  route(app, 'post', '/broadcasts', 'message.broadcast', async (req, tx) => {
    const b = Send.parse(req.body); const t = req.ctx.tenantId;
    const rows = (await tx.select({ id: patient.id, fullName: patient.fullName, phone: patient.phone }).from(patient).where(and(eq(patient.tenantId, t), inArray(patient.id, b.ids)))).filter((r) => validPhone(r.phone));
    if (!rows.length) throw new HttpError(400, 'NO_RECIPIENTS');
    const clinic = (await tx.select({ name: tenant.name }).from(tenant).where(eq(tenant.id, t)))[0]?.name ?? '';
    const [bc] = await tx.insert(broadcast).values({ tenantId: t, title: b.title || b.body.slice(0, 40), body: b.body, audience: b.audience, audienceLabel: label(b.audience, b.days), recipients: rows.length, skipped: Math.max(0, b.ids.length - rows.length), createdBy: req.ctx.userId }).returning();
    for (let i = 0; i < rows.length; i += 200) {
      await tx.insert(message).values(rows.slice(i, i + 200).map((r) => ({ tenantId: t, patientId: r.id, kind: 'broadcast', channel: 'whatsapp', toPhone: r.phone, body: fill(b.body, { name: r.fullName, clinic }), params: { name: r.fullName }, status: 'logged', broadcastId: bc.id })));
    }
    await emit(tx, req.ctx, 'broadcast.sent', 'broadcast', bc.id, { recipients: rows.length, audience: b.audience, mode: 'demo' });
    return bc;
  });

  /** A test to the sender's own number: recorded like any message, not tied to a patient. */
  route(app, 'post', '/broadcasts/test', 'message.broadcast', async (req, tx) => {
    const b = z.object({ body: z.string().trim().min(1).max(1000), phone: z.string().regex(/^[0-9]{10}$/) }).parse(req.body);
    const clinic = (await tx.select({ name: tenant.name }).from(tenant).where(eq(tenant.id, req.ctx.tenantId)))[0]?.name ?? '';
    const [m] = await tx.insert(message).values({ tenantId: req.ctx.tenantId, kind: 'broadcast', channel: 'whatsapp', toPhone: b.phone, body: fill(b.body, { name: 'Test', clinic }), params: { test: '1' }, status: 'logged' }).returning();
    return m;
  });

  route(app, 'get', '/broadcasts', 'message.broadcast', async (req, tx) =>
    tx.select({ b: broadcast, by: appUser.name }).from(broadcast).leftJoin(appUser, eq(appUser.id, broadcast.createdBy)).where(eq(broadcast.tenantId, req.ctx.tenantId)).orderBy(desc(broadcast.createdAt)).limit(100)
      .then((r) => r.map((x) => ({ ...x.b, by: x.by }))));

  route(app, 'get', '/broadcasts/:id', 'message.broadcast', async (req, tx) => {
    const t = req.ctx.tenantId; const id = (req.params as any).id;
    const bc = (await tx.select().from(broadcast).where(and(eq(broadcast.id, id), eq(broadcast.tenantId, t))))[0];
    if (!bc) throw new HttpError(404, 'NOT_FOUND');
    const to = await tx.select({ patientId: message.patientId, name: patient.fullName, phone: message.toPhone, status: message.status }).from(message).leftJoin(patient, eq(patient.id, message.patientId)).where(and(eq(message.tenantId, t), eq(message.broadcastId, id))).orderBy(patient.fullName);
    return { ...bc, to };
  });
}
