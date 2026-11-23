// The production blockers from the 20 Nov 2026 audit, one check each: they fail on the code before the fixes.
// (The money lock itself needs two connections to show a race; PGlite has one, so here it is only seen not to get in the way.)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-blockers';
process.env.COOKIE_SECRET = 'test-secret';
rmSync(process.env.PGLITE_DIR, { recursive: true, force: true });

const { db, migrate, applyRls, withTenant } = await import('../src/db/index.js');
const { seedIfEmpty, ensurePlatform, ensureFormsCurrent, createClinic } = await import('../src/db/seed.js');
const { buildApp } = await import('../src/app.js');
const { sql } = await import('drizzle-orm');

let app: Awaited<ReturnType<typeof buildApp>>;
const login = (email: string, password = 'demo1234', tenant?: string) => app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password, tenant } });
const as = async (email: string, password = 'demo1234', tenant = 'sahitya') => {
  const r = await login(email, password, tenant); assert.equal(r.statusCode, 200, r.body);
  const c = r.cookies.find((x) => x.name === 'cc_session')!.value;
  return (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => app.inject({ method, url: '/api' + url, cookies: { cc_session: c }, payload: payload as any });
};
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
before(async () => { await migrate(); await applyRls(); await ensurePlatform(); await seedIfEmpty(); await ensureFormsCurrent(); app = await buildApp(); });
after(async () => { await app.close(); });

test('invoice numbers go past 9999 instead of clashing with INV-1000', async () => {
  const O = await as('owner@demo.clinic');
  const t = (await O('GET', '/me')).json().tenantId;
  await withTenant(t, 'x', (tx) => tx.execute(sql`insert into numbering_sequence (tenant_id, key, scope, next_value) values (${t}, 'invoice_no', 'tenant', 1000) on conflict (tenant_id, key, scope) do update set next_value = 1000`));
  const p = (await O('POST', '/patients', { fullName: 'Ten Thousand', phone: '9848099901' })).json();
  const a = (await O('POST', '/charges', { patientId: p.id, description: 'Peel', amountPaise: 100000 })).json(); // INV-1000
  await withTenant(t, 'x', (tx) => tx.execute(sql`update numbering_sequence set next_value = 10000 where tenant_id = ${t} and key = 'invoice_no'`));
  const b = await O('POST', '/charges', { patientId: p.id, description: 'Peel', amountPaise: 100000 });
  const c = await O('POST', '/charges', { patientId: p.id, description: 'Peel', amountPaise: 100000 });
  assert.equal(b.statusCode, 200, b.body); assert.equal(c.statusCode, 200, c.body);
  const no = async (billId: string) => ((await withTenant(t, 'x', (tx) => tx.execute(sql`select invoice_no from bill where id = ${billId}`))) as any).rows?.[0]?.invoice_no;
  assert.equal(await no(a.billId), 'INV-1000');
  assert.equal(await no(b.json().billId), 'INV-10000');
  assert.equal(await no(c.json().billId), 'INV-10001');
  // an invoice is dated with its first line, so a line entered with an earlier time does not make it today's invoice
  const at = await withTenant(t, 'x', async (tx) => {
    const r: any = await tx.execute(sql`insert into charge (tenant_id, patient_id, description, amount_paise, created_at) values (${t}, ${p.id}, 'Old', 1000, '2026-01-05T10:00:00+05:30') returning bill_id`);
    const id = (r.rows ?? r)[0].bill_id; const b: any = await tx.execute(sql`select created_at from bill where id = ${id}`);
    return new Date((b.rows ?? b)[0].created_at).toISOString();
  });
  assert.equal(at, '2026-01-05T04:30:00.000Z');
});

test('an admin cannot give a role more than they hold, nor change roles through clinic settings', async () => {
  const O = await as('owner@demo.clinic');
  const made = await O('POST', '/admin/users', { name: 'Audit Admin', email: 'admin@audit.test', password: 'admin-pass-123', roles: ['admin'] });
  assert.equal(made.statusCode, 200, made.body);
  const A = await as('admin@audit.test', 'admin-pass-123');
  assert.equal((await A('PATCH', '/admin/clinic', { settings: { roles: { admin: ['*'] } } })).statusCode, 400, 'roles only through Roles');
  assert.equal((await A('PATCH', '/admin/clinic', { settings: { roleNames: { superadmin: 'x' } } })).statusCode, 400);
  assert.ok(!(await A('GET', '/me')).json().perms.includes('*'), 'still an admin');
  // the pharmacy role carries pharmacy.* and stock.*, which the admin does not hold
  const r = await A('POST', '/admin/users', { name: 'Promoted', email: 'promoted@audit.test', password: 'promoted-pass-1', roles: ['pharmacist'] });
  assert.equal(r.statusCode, 403, r.body); assert.equal(r.json().code, 'CANNOT_GRANT');
  const me = (await A('GET', '/me')).json().userId;
  assert.equal((await A('PATCH', `/admin/users/${me}`, { roles: ['admin', 'pharmacist'] })).statusCode, 403, 'not to themselves either');
  assert.equal((await A('PATCH', `/admin/users/${me}`, { name: 'Audit Admin 2' })).statusCode, 200, 'their own roles kept as they are');
  // the owner may
  assert.equal((await O('POST', '/admin/users', { name: 'Pharma 2', email: 'pharma2@audit.test', password: 'pharma2-pass-1', roles: ['pharmacist'] })).statusCode, 200);
});

test('a closed day takes no pharmacy sale, return or expense', async () => {
  const O = await as('owner@demo.clinic'); const P = await as('pharmacy@demo.clinic'); const R = await as('reception@demo.clinic');
  const med = (await P('GET', '/stock')).json().items.find((m: any) => m.onHand > 2 && ['Aloe vera cooling gel', 'Calamine lotion', 'Biotin 10 mg'].includes(m.name)); // sold without a prescription
  const sell = (key: string) => P('POST', '/pharmacy/sale', { walkIn: { fullName: 'Walk In', phone: '9000000001' }, items: [{ medicineId: med.id, qty: 1 }], method: 'cash', idempotencyKey: key });
  const sold = await sell('blk-sale-1'); assert.equal(sold.statusCode, 200, sold.body);
  const exp = await R('POST', '/expenses', { description: 'Tea', amountPaise: 5000, method: 'cash', category: 'Other' }); assert.equal(exp.statusCode, 200, exp.body);
  const f = (await O('GET', '/dayclose')).json();
  const closed = await O('POST', '/dayclose', { day: today(), cashCountedPaise: f.drawer.expectedCashPaise, diary: f.counts, notes: {} });
  assert.equal(closed.statusCode, 200, closed.body);
  const sale2 = await sell('blk-sale-2'); assert.equal(sale2.statusCode, 409, sale2.body); assert.equal(sale2.json().code, 'DAY_CLOSED');
  const ret = await O('POST', `/pharmacy/sale/${sold.json().id}/return`, { lines: [{ line: 0, qty: 1, restock: true }], method: 'cash', reason: 'Unopened' });
  assert.equal(ret.statusCode, 409, ret.body);
  assert.equal((await R('POST', '/expenses', { description: 'Tea again', amountPaise: 5000, method: 'cash', category: 'Other' })).json().code, 'DAY_CLOSED');
  assert.equal((await R('POST', '/expenses', { day: today(), description: 'Tea dated', amountPaise: 5000, method: 'cash', category: 'Other' })).json().code, 'DAY_CLOSED');
  assert.equal((await R('PATCH', `/expenses/${exp.json().id}`, { amountPaise: 1 })).json().code, 'DAY_CLOSED', 'counted with the drawer: not changed');
  assert.equal((await R('DELETE', `/expenses/${exp.json().id}?reason=oops`)).json().code, 'DAY_CLOSED');
  const after = (await O('GET', '/dayclose')).json();
  assert.equal(after.money.total.total, f.money.total.total, 'nothing new on the closed day');
  assert.equal(after.drawer.expectedCashPaise, closed.json().totals.drawer.expectedCashPaise, 'the drawer the day was closed with still holds');
});

test('production: the platform admin needs SUPERADMIN_PASSWORD, and a real clinic gets no demo stock', async () => {
  const env = { ...process.env };
  try {
    process.env.NODE_ENV = 'production'; delete process.env.SUPERADMIN_PASSWORD;
    await ensurePlatform();
    assert.equal((await login('superadmin@cubott.in', 'demo1234')).statusCode, 401, 'switched off without its password');
    process.env.SUPERADMIN_PASSWORD = 'a-long-platform-password';
    await ensurePlatform();
    assert.equal((await login('superadmin@cubott.in', 'demo1234')).statusCode, 401);
    assert.equal((await login('superadmin@cubott.in', 'a-long-platform-password')).statusCode, 200);
    delete process.env.COOKIE_SECRET;
    await assert.rejects(buildApp(), /COOKIE_SECRET/);
  } finally { Object.assign(process.env, env); for (const k of ['SUPERADMIN_PASSWORD']) if (!(k in env)) delete process.env[k]; }
  // a real clinic: medicines from its pack, but no stock until it receives some, even after a restart
  await createClinic({ name: 'Real Clinic', slug: 'real-clinic', owner: { name: 'Dr. Real', email: 'owner@real.test', password: 'real-pass-123' } });
  await ensureFormsCurrent();
  const RO = await as('owner@real.test', 'real-pass-123', 'real-clinic');
  const items = (await RO('GET', '/stock')).json().items as any[];
  assert.ok(items.length > 0, 'its medicines are there');
  assert.equal(items.reduce((s, m) => s + m.onHand, 0), 0, 'no invented opening stock');
});
