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
  const fs = await import('node:fs');
  fs.mkdirSync(dir, { recursive: true });
  // One process per data folder. Two servers on the same folder (a dev restart racing a second start) corrupt the WAL;
  // this happened on 22 Oct and 9 Nov 2026. A live pid in the lock file stops the second one before it touches the data.
  const lock = `${dir}.lock`;
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const held = fs.existsSync(lock) ? Number(fs.readFileSync(lock, 'utf8')) : 0;
  if (held && held !== process.pid && alive(held)) { console.error(`Another server (pid ${held}) already has ${dir} open. Stop it first, or set PGLITE_DIR to another folder.`); process.exit(3); }
  fs.writeFileSync(lock, String(process.pid));
  for (const ev of ['exit', 'SIGINT', 'SIGTERM'] as const) process.on(ev, () => { try { if (Number(fs.readFileSync(lock, 'utf8')) === process.pid) fs.unlinkSync(lock); } catch { /* already gone */ } if (ev !== 'exit') process.exit(0); });
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
      `create policy tenant_isolation on "${t}" using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)`,
    ];
    for (const q of stmts) await db.execute(sql.raw(q));
  }
  // Login runs before a tenant is known: permit reads of app_user only when app.tenant_id is unset.
  await db.execute(sql.raw(`drop policy if exists login_lookup on "app_user"`));
  await db.execute(sql.raw(`create policy login_lookup on "app_user" for select using (coalesce(current_setting('app.tenant_id', true), '') = '')`));
}
