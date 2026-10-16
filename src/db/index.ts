import { sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import * as schema from './schema.js';

export type Db = PgDatabase<any, typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const url = process.env.DATABASE_URL;
let db: Db;
let migrate: () => Promise<void>;

if (url) {
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const { migrate: m } = await import('drizzle-orm/postgres-js/migrator');
  const postgres = (await import('postgres')).default;
  const client = postgres(url, { max: 10, prepare: false });
  db = drizzle(client, { schema });
  migrate = () => m(db as any, { migrationsFolder: 'drizzle' });
} else {
  // ponytail: embedded Postgres for local dev/tests; superuser bypasses RLS, so app-level tenant filters still apply
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const { migrate: m } = await import('drizzle-orm/pglite/migrator');
  const dir = process.env.PGLITE_DIR ?? './data/pglite';
  (await import('node:fs')).mkdirSync(dir, { recursive: true });
  const client = new PGlite(dir);
  db = drizzle(client, { schema });
  migrate = () => m(db as any, { migrationsFolder: 'drizzle' });
}

export { db, migrate };

/** Run fn inside a transaction with the tenant set for RLS. */
export async function withTenant<T>(tenantId: string, userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true), set_config('app.user_id', ${userId}, true)`);
    return fn(tx);
  });
}

/** Enable + force RLS on every tenant table. Idempotent; run after migrations. */
export async function applyRls() {
  for (const t of schema.TENANT_TABLES) {
    const stmts = [
      `alter table "${t}" enable row level security`,
      `alter table "${t}" force row level security`,
      `drop policy if exists tenant_isolation on "${t}"`,
      `create policy tenant_isolation on "${t}" using (tenant_id = current_setting('app.tenant_id', true)::uuid) with check (tenant_id = current_setting('app.tenant_id', true)::uuid)`,
    ];
    for (const q of stmts) await db.execute(sql.raw(q));
  }
}
