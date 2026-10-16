import { sql } from 'drizzle-orm';
import type { Tx } from '../db/index.js';
import { domainEvent } from '../db/schema.js';
import type { Ctx } from './auth.js';

/** Allocate the next number for key+scope atomically (row-locked upsert). */
export async function nextNumber(tx: Tx, tenantId: string, key: string, scope: string): Promise<number> {
  const r: any = await tx.execute(sql`
    insert into numbering_sequence (tenant_id, key, scope, next_value) values (${tenantId}, ${key}, ${scope}, 2)
    on conflict (tenant_id, key, scope) do update set next_value = numbering_sequence.next_value + 1
    returning next_value - 1 as n`);
  const rows = r.rows ?? r;
  return Number(rows[0].n);
}

export async function emit(tx: Tx, ctx: Ctx, type: string, aggregate: string, aggregateId: string, payload: Record<string, unknown>) {
  await tx.insert(domainEvent).values({
    tenantId: ctx.tenantId, type, aggregate, aggregateId, payload,
    actor: { userId: ctx.userId, roles: ctx.roles, via: 'ui' },
  });
}

/** Today's date (YYYY-MM-DD) in the tenant's timezone. */
export function todayIn(tz: string, d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
export function addDays(day: string, n: number) {
  const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}
export function daysBetween(a: string, b: string) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}
