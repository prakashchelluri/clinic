import type { FastifyInstance, FastifyRequest } from 'fastify';
import { withTenant, type Tx } from '../db/index.js';
import { HttpError, can } from './auth.js';

export type Handler<T = unknown> = (req: FastifyRequest, tx: Tx) => Promise<T>;

/** Route helper: checks permission, opens a tenant transaction, runs handler. */
export function route(app: FastifyInstance, method: 'get' | 'post' | 'patch' | 'delete', url: string, perm: string | null, handler: Handler) {
  app[method](url, async (req, reply) => {
    if (perm && !can(req.perms, perm)) throw new HttpError(403, `FORBIDDEN:${perm}`);
    const out = await withTenant(req.ctx.tenantId, req.ctx.userId, (tx) => handler(req, tx));
    return out ?? reply.code(204).send();
  });
}
