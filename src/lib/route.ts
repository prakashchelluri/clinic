import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql } from 'drizzle-orm';
import { withTenant, type Tx } from '../db/index.js';
import { HttpError, can } from './auth.js';
import { describe, writeAudit } from './audit.js';

export type Handler<T = unknown> = (req: FastifyRequest, tx: Tx) => Promise<T>;

/** Writes that move money (or decide it), taken one at a time per clinic: a double tap, two tabs or two desks cannot both pass the same
 *  "is it still due / is the advance enough / is it already refunded" check, and End of day cannot close while a payment is half written.
 *  ponytail: one lock per clinic; lock per patient instead if a clinic ever takes several payments a second. */
const MONEY = new Set([
  '/payments', '/payments/take', '/payments/:id/settle', '/charges/:id/adjust', '/charges/:id/cancel',
  '/bills', '/bills/:id/credit', '/bills/:id/refund', '/patients/:id/payments', '/patients/:id/advance/refund', '/discount-asks/:id/decide',
  '/visits', '/courses', '/procedure-sessions/:id', '/procedure-plans/edit', '/procedure-plans/cancel',
  '/pharmacy/sale', '/pharmacy/sale/:id/return', '/pharmacy/sale/:id/void', '/pharmacy/sale/:id/cancel',
  '/expenses', '/expenses/:id', '/dayclose',
]);
export const lockMoney = (tx: Tx, tenantId: string) => tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'money:' + tenantId}))`);

/** Route helper: checks permission, opens a tenant transaction, runs handler. Every change is written to the audit log in the same transaction. */
export function route(app: FastifyInstance, method: 'get' | 'post' | 'patch' | 'put' | 'delete', url: string, perm: string | null, handler: Handler) {
  const money = method !== 'get' && MONEY.has(url);
  app[method](url, async (req, reply) => {
    if (perm && !can(req.perms, perm)) throw new HttpError(403, `FORBIDDEN:${perm}`);
    const out = await withTenant(req.ctx.tenantId, req.ctx.userId, async (tx) => {
      if (money) await lockMoney(tx, req.ctx.tenantId);
      const res = await handler(req, tx);
      if (method !== 'get' && !req.audited) {
        const d = describe(req.method, req.url, req.body);
        if (d) {
          const body: any = req.body ?? {}; const r: any = res ?? {}; const params: any = req.params ?? {};
          const patientId = body.patientId ?? r.patientId ?? (/^\/api\/patients\/[^/]+/.test(req.url) ? params.id : undefined);
          await writeAudit(tx, req.ctx, { kind: d.kind, action: `${req.method} ${url}`, summary: d.summary, entity: url.split('/')[1] ?? null,
            entityId: params.id ?? r.id ?? null, patientId, before: req.auditBefore, after: body });
        }
      }
      return res;
    });
    return out ?? reply.code(204).send();
  });
}
