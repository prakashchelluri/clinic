// First-run seeding must work on a real Postgres, where the app's role is NOT a superuser and row-level security is enforced.
// PGlite is superuser-only, so we create a restricted role and SET ROLE to it before seeding.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-rls';
process.env.COOKIE_SECRET = 'test-secret';
rmSync(process.env.PGLITE_DIR, { recursive: true, force: true });

const { db, migrate, applyRls } = await import('../src/db/index.js');
const { sql } = await import('drizzle-orm');
const { ensurePlatform, seedIfEmpty, ensureFormsCurrent, healEmptyTenants } = await import('../src/db/seed.js');
const { buildApp } = await import('../src/app.js');

let app: Awaited<ReturnType<typeof buildApp>>;
after(async () => { await app?.close(); });

test('seed, upgrades and login work under enforced row-level security', async () => {
  await migrate(); await applyRls();
  await db.execute(sql.raw(`create role app_rls nosuperuser nobypassrls`));
  await db.execute(sql.raw(`grant all on all tables in schema public to app_rls`));
  await db.execute(sql.raw(`grant all on all sequences in schema public to app_rls`));
  await db.execute(sql.raw(`set role app_rls`));
  // sanity: the role really is restricted (an unscoped insert must be refused)
  await assert.rejects(db.execute(sql.raw(`insert into branch (tenant_id, name) values ('${'00000000-0000-0000-0000-000000000001'}', 'x')`)));
  // a tenant left empty by an interrupted first run is cleaned up, and seeding then proceeds
  await db.execute(sql.raw(`insert into tenant (slug, name, kind, settings) values ('broken', 'Half made', 'clinic', '{}')`));
  await healEmptyTenants();
  assert.equal(((await db.execute(sql.raw(`select count(*)::int as n from tenant where slug = 'broken'`))) as any).rows[0].n, 0);
  await ensurePlatform(); await seedIfEmpty(); await ensureFormsCurrent();
  app = await buildApp();
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@demo.clinic', password: 'demo1234' } });
  assert.equal(r.statusCode, 200, r.body);
  const cookie = r.cookies.find((c) => c.name === 'cc_session')!.value;
  const me = await app.inject({ method: 'GET', url: '/api/me', cookies: { cc_session: cookie } });
  assert.equal(me.statusCode, 200); assert.equal(me.json().role, 'owner');
  const patients = await app.inject({ method: 'GET', url: '/api/patients', cookies: { cc_session: cookie } });
  assert.equal(patients.statusCode, 200);
  const admin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'superadmin@cubott.in', password: 'demo1234' } });
  assert.equal(admin.statusCode, 200, admin.body);

  // everyday actions as reception, still under the restricted role
  const rc = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'reception@demo.clinic', password: 'demo1234' } })).cookies.find((c) => c.name === 'cc_session')!.value;
  const call = (method: any, url: string, payload?: any, ck = rc) => app.inject({ method, url: '/api' + url, payload, cookies: { cc_session: ck } });
  const p = await call('POST', '/patients', { fullName: 'RLS Patient', phone: '9222222222' }); assert.equal(p.statusCode, 200, p.body);
  const v = await call('POST', '/visits', { patientId: p.json().id, feeCategoryCode: 'GEN', payment: { method: 'cash', amountPaise: 30000 }, idempotencyKey: 'rls1' }); assert.equal(v.statusCode, 200, v.body);
  const e = await call('POST', '/expenses', { description: 'Tea', amountPaise: 1000 }); assert.equal(e.statusCode, 200, e.body);
  assert.equal((await call('GET', '/reports/daily')).json().totals.collectedPaise, 30000);

  // onboarding a second clinic through the platform admin, then isolation between the two
  const ac = admin.cookies.find((c) => c.name === 'cc_session')!.value;
  const made = await call('POST', '/platform/tenants', { name: 'Second Clinic', slug: 'second', owner: { name: 'Owner Two', email: 'owner2@second.clinic', password: 'secret12' } }, ac);
  assert.equal(made.statusCode, 200, made.body);
  const o2 = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner2@second.clinic', password: 'secret12' } }));
  assert.equal(o2.statusCode, 200, o2.body);
  const other = await call('GET', '/patients', undefined, o2.cookies.find((c) => c.name === 'cc_session')!.value);
  assert.equal(other.json().length, 0);
});
