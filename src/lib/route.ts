import type { FastifyInstance, FastifyRequest } from 'fastify';
import { withTenant, type Tx } from '../db/index.js';
import { HttpError, can } from './auth.js';
import { describe, writeAudit } from './audit.js';

export type Handler<T = unknown> = (req: FastifyRequest, tx: Tx) => Promise<T>;

/** Route helper: checks permission, opens a tenant transaction, runs handler. Every change is written to the audit log in the same transaction. */
export function route(app: FastifyInstance, method: 'get' | 'post' | 'patch' | 'put' | 'delete', url: string, perm: string | null, handler: Handler) {
  app[method](url, async (req, reply) => {
    if (perm && !can(req.perms, perm)) throw new HttpError(403, `FORBIDDEN:${perm}`);
    const out = await withTenant(req.ctx.tenantId, req.ctx.userId, async (tx) => {
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
