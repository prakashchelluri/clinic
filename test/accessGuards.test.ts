// Access guards from the owner/admin audit: the owner role, own password, test data only on a test clinic, prices and diagnoses kept from roles that should not see them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.ALLOW_TEST_RESET = '0'; // check the real "test clinic only" rule, not the test-suite bypass
process.env.PGLITE_DIR = './data/test-pglite-access';
process.env.UPLOAD_DIR = './data/test-uploads-access';
process.env.COOKIE_SECRET = 'test-secret';
rmSync(process.env.PGLITE_DIR, { recursive: true, force: true });
rmSync(process.env.UPLOAD_DIR, { recursive: true, force: true });

const { migrate, applyRls } = await import('../src/db/index.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { buildApp } = await import('../src/app.js');

let app: Awaited<ReturnType<typeof buildApp>>;
type Call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => Promise<{ status: number; body: any }>;
async function as(email: string, password = 'demo1234'): Promise<Call> {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password, tenant: 'sahitya' } });
  assert.equal(r.statusCode, 200, r.body);
  const cookie = r.cookies.find((c) => c.name === 'cc_session')!.value;
  return (method, url, payload) => app.inject({ method, url: '/api' + url, payload: payload as any, cookies: { cc_session: cookie } }).then((res) => ({ status: res.statusCode, body: res.body ? (res.headers['content-type']?.includes('json') ? res.json() : res.body) : null }));
}
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const addDays = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

before(async () => { await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp(); });
after(async () => { await app.close(); });

test('test data: owner only, and only while the clinic has no real patients', async () => {
  const owner = await as('owner@demo.clinic'); const reception = await as('reception@demo.clinic');
  assert.equal((await owner('POST', '/admin/users', { name: 'Admin One', email: 'admin1@demo.clinic', password: 'secret12', roles: ['admin'] })).status, 200);
  const admin = await as('admin1@demo.clinic', 'secret12');
  assert.equal((await owner('GET', '/config')).body.testData, true, 'a fresh clinic is a test clinic');
  assert.equal((await reception('GET', '/config')).body.testData, false);
  for (const url of ['/dev/sample-data', '/dev/sample-collections', '/dev/sample-bookings']) assert.equal((await admin('POST', url)).status, 403, `${url} is owner only`);
  assert.equal((await admin('POST', '/dev/reset-sample', { confirm: 'RESET' })).status, 403);

  assert.equal((await reception('POST', '/patients', { fullName: 'Real Person', phone: '9000011111' })).status, 200);
  assert.equal((await owner('GET', '/config')).body.testData, false, 'a real patient makes it a real clinic');
  const r = await owner('POST', '/dev/reset-sample', { confirm: 'RESET' });
  assert.equal(r.status, 403); assert.equal(r.body.code, 'NOT_A_TEST_CLINIC');
  assert.equal((await owner('POST', '/dev/sample-data')).body.code, 'NOT_A_TEST_CLINIC');
  assert.ok((await owner('GET', '/patients?q=Real Person')).body.length === 1, 'nothing was wiped');
});

test('owner role: only an owner grants or removes it, admins cannot touch an owner, and one active owner always remains', async () => {
  const owner = await as('owner@demo.clinic'); const admin = await as('admin1@demo.clinic', 'secret12');
  const users = (await owner('GET', '/users')).body; const me = users.find((u: any) => u.email === 'owner@demo.clinic'); const adm = users.find((u: any) => u.email === 'admin1@demo.clinic');

  let r = await admin('POST', '/admin/users', { name: 'Sneaky', email: 'sneaky@demo.clinic', password: 'secret12', roles: ['owner'] });
  assert.equal(r.status, 403); assert.equal(r.body.code, 'OWNER_ONLY_GRANT');
  r = await admin('PATCH', `/admin/users/${adm.id}`, { roles: ['admin', 'owner'] });
  assert.equal(r.body.code, 'OWNER_ONLY_GRANT', 'an admin cannot make themselves owner');
  assert.equal((await admin('PATCH', `/admin/users/${me.id}`, { password: 'hijacked1' })).body.code, 'OWNER_ONLY_EDIT');
  assert.equal((await admin('PATCH', `/admin/users/${me.id}`, { email: 'evil@demo.clinic' })).body.code, 'OWNER_ONLY_EDIT');
  assert.equal((await admin('PATCH', `/admin/users/${me.id}`, { active: false })).body.code, 'OWNER_ONLY_EDIT');
  assert.equal((await admin('PATCH', `/admin/users/${me.id}`, { roles: ['doctor'] })).body.code, 'OWNER_ONLY_GRANT');
  assert.equal((await admin('PATCH', `/admin/users/${me.id}`, { name: 'Dr. Main Doctor' })).status, 200, 'a harmless edit is fine');
  assert.equal((await admin('POST', '/admin/users', { name: 'Short', email: 'short@demo.clinic', password: 'abc123', roles: ['receptionist'] })).status, 400, 'passwords are at least 8 characters');

  r = await owner('PATCH', `/admin/users/${me.id}`, { roles: ['doctor'] });
  assert.equal(r.status, 409); assert.equal(r.body.code, 'LAST_OWNER', 'the only owner cannot drop the role');
  // a second owner, made by the owner; then either may step down, but not both
  assert.equal((await owner('PATCH', `/admin/users/${adm.id}`, { roles: ['admin', 'owner'] })).status, 200);
  assert.equal((await owner('PATCH', `/admin/users/${adm.id}`, { active: false })).status, 200, 'another owner remains');
  assert.equal((await owner('PATCH', `/admin/users/${me.id}`, { roles: ['owner', 'doctor'] })).status, 200);
  const owner2 = await as('owner@demo.clinic');
  assert.equal((await owner2('PATCH', `/admin/users/${me.id}`, { roles: ['doctor'] })).body.code, 'LAST_OWNER', 'the inactive owner does not count');
  assert.equal((await owner2('PATCH', `/admin/users/${adm.id}`, { active: true, roles: ['admin'] })).status, 200);
});

test('own password: the current one first, at least 8 characters', async () => {
  const pharmacy = await as('pharmacy@demo.clinic');
  assert.equal((await pharmacy('PATCH', '/me/password', { currentPassword: 'wrong-one', newPassword: 'newpass123' })).body.code, 'WRONG_CURRENT_PASSWORD');
  assert.equal((await pharmacy('PATCH', '/me/password', { currentPassword: 'demo1234', newPassword: 'short' })).status, 400);
  assert.equal((await pharmacy('PATCH', '/me/password', { currentPassword: 'demo1234', newPassword: 'newpass123' })).status, 200);
  const again = await as('pharmacy@demo.clinic', 'newpass123');
  assert.equal((await again('PATCH', '/me/password', { currentPassword: 'newpass123', newPassword: 'demo1234' })).status, 200);
  const audit = (await (await as('owner@demo.clinic'))('GET', '/audit?days=1')).body;
  const row = audit.find((x: any) => x.summary === 'Changed their own password');
  assert.ok(row, 'audited'); assert.ok(!JSON.stringify(row.after ?? {}).includes('newpass123'), 'the password is not in the audit log');
});

test('/config: no prices without "See fees", no waiting-room secret without settings', async () => {
  const owner = await as('owner@demo.clinic'); const junior = await as('assistant@demo.clinic'); const reception = await as('reception@demo.clinic');
  await owner('GET', '/admin/display'); // makes the screen link
  const o = (await owner('GET', '/config')).body; const j = (await junior('GET', '/config')).body; const r = (await reception('GET', '/config')).body;
  assert.ok(o.tenant.settings.display?.token, 'the owner sees the screen link');
  assert.equal(r.tenant.settings.display, undefined); assert.equal(j.tenant.settings.display, undefined);
  assert.ok(r.feeCategories.some((c: any) => c.amountPaise > 0), 'reception sees fees');
  assert.ok(j.feeCategories.every((c: any) => c.amountPaise === null || c.amountPaise === 0), 'junior: no fee amounts');
  assert.ok(j.medicines.every((m: any) => m.mrpPaise === null) && j.procedures.every((p: any) => p.pricePaise === null) && j.services.every((s: any) => s.pricePaise === null));
  assert.ok(o.procedures.some((p: any) => p.pricePaise != null));
});

test('diagnoses stay with clinical roles: patients list, record and follow-ups', async () => {
  const owner = await as('owner@demo.clinic'); const reception = await as('reception@demo.clinic'); const coord = await as('procedures@demo.clinic'); const junior = await as('assistant@demo.clinic');
  const p = (await reception('POST', '/patients', { fullName: 'Dx Private', phone: '9000033333' })).body;
  const v = (await reception('POST', '/visits', { patientId: p.id, feeCategoryCode: 'GEN', payment: { method: 'cash', amountPaise: 30000 } })).body;
  const e = (await owner('POST', `/visits/${v.id}/encounter`)).body;
  const done = await owner('PATCH', `/encounters/${e.id}`, { data: { complaint: { chief_complaint: ['Itching'] }, assessment: { diagnosis: [{ name: 'Secret Dx' }] } }, complete: true, recommendations: [{ kind: 'followup', dueOn: addDays(today(), 14) }] });
  assert.equal(done.status, 200, JSON.stringify(done.body));

  const row = async (c: Call) => (await c('GET', '/patients?q=Dx Private')).body[0];
  assert.equal((await row(owner)).mainProblem, 'Secret Dx');
  assert.equal((await row(junior)).mainProblem, 'Secret Dx', 'the junior doctor is clinical');
  assert.equal((await row(reception)).mainProblem, null);
  const tl = (await reception('GET', `/patients/${p.id}/timeline`)).body;
  assert.ok(!JSON.stringify(tl.encounters).includes('Secret Dx'), 'no diagnosis on the record for reception');
  assert.ok(JSON.stringify((await owner('GET', `/patients/${p.id}/timeline`)).body.encounters).includes('Secret Dx'));

  const fu = async (c: Call) => (await c('GET', '/followups?tab=reviews')).body.rows.find((r: any) => r.patient.id === p.id);
  assert.equal((await fu(coord)).what, 'Follow-up visit');
  assert.equal((await fu(reception)).what, 'Follow-up visit');
  assert.equal((await fu(owner)).what, 'Secret Dx');
});

test('fee change: the audit says which fee and old → new in rupees; inactive rows can be listed and switched back on', async () => {
  const owner = await as('owner@demo.clinic'); const reception = await as('reception@demo.clinic');
  const gen = (await owner('GET', '/config')).body.feeCategories.find((c: any) => c.code === 'GEN');
  assert.equal((await owner('PATCH', `/admin/fee-categories/${gen.id}`, { amountPaise: gen.amountPaise + 10000 })).status, 200);
  const audit = (await owner('GET', '/audit?days=1')).body;
  assert.ok(audit.some((x: any) => x.summary === `Changed the fee for ${gen.name}: ₹${(gen.amountPaise / 100).toLocaleString('en-IN')} → ₹${((gen.amountPaise + 10000) / 100).toLocaleString('en-IN')}`), JSON.stringify(audit.slice(0, 3).map((x: any) => x.summary)));

  const room = (await owner('GET', '/config')).body.rooms[0];
  assert.equal((await owner('PATCH', `/admin/rooms/${room.id}`, { active: false })).status, 200);
  assert.equal((await reception('GET', '/admin/inactive')).status, 403);
  const off = (await owner('GET', '/admin/inactive')).body;
  assert.ok(off.rooms.some((r: any) => r.id === room.id), 'the switched-off room is listed');
  assert.equal((await owner('PATCH', `/admin/rooms/${room.id}`, { active: true })).status, 200);
  assert.ok((await owner('GET', '/config')).body.rooms.some((r: any) => r.id === room.id), 'and back on');
});
