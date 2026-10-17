// Regression tests for the QA round: expenses, configurable roles, validation, duplicate guards, error hygiene.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-qa';
process.env.COOKIE_SECRET = 'test-secret';
rmSync(process.env.PGLITE_DIR, { recursive: true, force: true });

const { migrate, applyRls } = await import('../src/db/index.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { buildApp } = await import('../src/app.js');

let app: Awaited<ReturnType<typeof buildApp>>;
async function as(email: string, password = 'demo1234') {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password, tenant: 'sahitya' } });
  assert.equal(r.statusCode, 200, r.body);
  const cookie = r.cookies.find((c) => c.name === 'cc_session')!.value;
  return (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({ method, url: '/api' + url, payload: payload as any, cookies: { cc_session: cookie } }).then((res) => ({ status: res.statusCode, body: res.json(), headers: res.headers }));
}
before(async () => { await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp(); });
after(async () => { await app.close(); });

test('expenses: validated, categorised, voided not deleted', async () => {
  const owner = await as('owner@demo.clinic'); const reception = await as('reception@demo.clinic'); const assistant = await as('assistant@demo.clinic');
  const ok = await reception('POST', '/expenses', { description: 'Gloves and syringes', amountPaise: 45050, method: 'cash', category: 'Medicines and supplies' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  // a normal past date is accepted (this once failed for every valid date), a future one is refused for the right reason
  const yesterday = new Date(Date.now() - 36 * 3600_000).toISOString().slice(0, 10);
  const past = await reception('POST', '/expenses', { description: 'Yesterday tea', amountPaise: 100, day: yesterday });
  assert.equal(past.status, 200, JSON.stringify(past.body)); assert.equal(past.body.day, yesterday);
  assert.equal((await reception('POST', '/expenses', { description: 'Future', amountPaise: 100, day: '2999-01-01' })).body.code, 'FUTURE_DATE');
  assert.equal((await reception('POST', '/expenses', { description: 'Junk', amountPaise: 100, day: 'not-a-date' })).body.code, 'VALIDATION');
  assert.equal((await reception('POST', '/expenses', { description: 'Cat', amountPaise: 100, category: 'Made up' })).body.code, 'BAD_CATEGORY');
  // letters, zero, negative, fractions, huge, empty description, bad category, future date
  for (const bad of [{ amountPaise: 'abc' }, { amountPaise: 0 }, { amountPaise: -5 }, { amountPaise: 10.5 }, { amountPaise: 1e12 }, { description: ' ' }, { category: 'Made up' }, { day: '2999-01-01' }, { day: 'not-a-date' }, { method: 'crypto' }]) {
    const r = await reception('POST', '/expenses', { description: 'x ok', amountPaise: 100, category: 'Other', ...bad });
    assert.ok([400].includes(r.status), `${JSON.stringify(bad)} should be 400, got ${r.status}`);
  }
  const edited = await reception('PATCH', `/expenses/${ok.body.id}`, { amountPaise: 50000 });
  assert.equal(edited.body.amountPaise, 50000); assert.equal(edited.body.category, 'Medicines and supplies'); assert.equal(edited.body.method, 'cash'); // a partial edit must not reset other fields
  const list = await reception('GET', '/expenses');
  assert.equal(list.body.totalPaise, 50100); assert.equal(list.body.byCategory[0].category, 'Medicines and supplies');
  assert.equal((await assistant('GET', '/expenses')).status, 403);
  assert.equal((await assistant('POST', '/expenses', { description: 'nope', amountPaise: 100 })).status, 403);
  const rep = await owner('GET', '/reports/daily'); assert.equal(rep.body.totals.expensesPaise, 50000); // yesterday's entry is not in today's report
  assert.equal((await reception('DELETE', `/expenses/${ok.body.id}?reason=entered%20twice`)).status, 200);
  assert.equal((await reception('DELETE', `/expenses/${ok.body.id}`)).status, 404); // already voided
  const after = await owner('GET', '/expenses'); assert.equal(after.body.totalPaise, 100); assert.equal(after.body.rows.length, 2); assert.ok(after.body.rows.some((r: any) => r.voidedReason === 'entered twice'));
  assert.equal((await owner('GET', '/reports/daily')).body.totals.expensesPaise, 0);
});

test('roles: clinic-defined roles and permissions', async () => {
  const owner = await as('owner@demo.clinic'); const reception = await as('reception@demo.clinic');
  const roles = await owner('GET', '/admin/roles'); assert.ok(roles.body.find((r: any) => r.key === 'owner').locked);
  assert.equal((await owner('PATCH', '/admin/roles/owner', { perms: [] })).status, 400);
  assert.equal((await owner('POST', '/admin/roles', { name: 'Bad', perms: ['patient.read', 'made.up'] })).status, 400);
  const made = await owner('POST', '/admin/roles', { name: 'Lab technician', perms: ['patient.read', 'document.read', 'document.write'] });
  assert.equal(made.status, 200); assert.equal(made.body.key, 'lab_technician');
  const u = await owner('POST', '/admin/users', { name: 'Lab Tech', email: 'lab@demo.clinic', password: 'secret12', roles: ['lab_technician'] });
  assert.equal(u.status, 200, JSON.stringify(u.body));
  const lab = await as('lab@demo.clinic', 'secret12');
  assert.equal((await lab('GET', '/patients')).status, 200);
  assert.equal((await lab('GET', '/expenses')).status, 403);
  assert.equal((await lab('GET', '/admin/roles')).status, 403);
  // widen the role: takes effect immediately
  assert.equal((await owner('PATCH', '/admin/roles/lab_technician', { perms: ['patient.read', 'expense.read'] })).status, 200);
  assert.equal((await lab('GET', '/expenses')).status, 200);
  assert.equal((await lab('GET', '/patients/' + '00000000-0000-0000-0000-000000000000/documents')).status, 403);
  // unknown role cannot be assigned; role in use cannot be deleted; unused custom role can
  assert.equal((await owner('POST', '/admin/users', { name: 'X Y', email: 'x@demo.clinic', password: 'secret12', roles: ['nonsense'] })).body.code, 'UNKNOWN_ROLE');
  assert.equal((await owner('DELETE', '/admin/roles/lab_technician')).status, 409);
  // built-in roles can be re-tuned and reset
  assert.equal((await owner('PATCH', '/admin/roles/receptionist', { perms: ['patient.read', 'visit.read'] })).status, 200);
  assert.equal((await reception('POST', '/visits', {})).status, 403);
  assert.equal((await owner('DELETE', '/admin/roles/receptionist')).status, 200);
  assert.notEqual((await reception('POST', '/visits', {})).status, 403);
  // editing one field of a room keeps the rest
  const room = await owner('POST', '/admin/rooms', { name: 'QA Room', capabilities: ['laser'] });
  const off = await owner('PATCH', `/admin/rooms/${room.body.id}`, { active: false });
  assert.deepEqual(off.body.capabilities, ['laser']); assert.equal(off.body.active, false);
  // an admin cannot hand out permissions they do not hold
  await owner('POST', '/admin/users', { name: 'Adm', email: 'adm@demo.clinic', password: 'secret12', roles: ['admin'] });
  const adm = await as('adm@demo.clinic', 'secret12');
  assert.equal((await adm('PATCH', '/admin/roles/lab_technician', { perms: ['patient.read', 'pharmacy.bill'] })).status, 403);
});

test('input rules, duplicates and error hygiene', async () => {
  const owner = await as('owner@demo.clinic'); const reception = await as('reception@demo.clinic');
  assert.equal((await reception('POST', '/patients', { fullName: '   ' })).status, 400);
  assert.equal((await reception('POST', '/patients', { fullName: 'A'.repeat(3000) })).status, 400);
  assert.equal((await reception('POST', '/patients', { fullName: 'QA Age', ageYears: 999 })).status, 400);
  const p = await reception('POST', '/patients', { fullName: '  QA Person  ', phone: '9111111111' });
  assert.equal(p.body.fullName, 'QA Person');
  // same patient: one open check-in per day, one booking per window
  const v1 = await reception('POST', '/visits', { patientId: p.body.id, feeCategoryCode: 'GEN', idempotencyKey: 'a1' }); assert.equal(v1.status, 200);
  const v2 = await reception('POST', '/visits', { patientId: p.body.id, feeCategoryCode: 'GEN', idempotencyKey: 'a2' }); assert.equal(v2.status, 409); assert.equal(v2.body.code, 'ALREADY_CHECKED_IN');
  const win = (await reception('GET', '/sessions')).body[0];
  const b1 = await reception('POST', '/appointments', { sessionId: win.id, patientId: p.body.id }); assert.equal(b1.status, 200);
  assert.equal((await reception('POST', '/appointments', { sessionId: win.id, patientId: p.body.id })).body.code, 'ALREADY_BOOKED');
  // a broken fee rule is refused on save, and a bad stored rule can never break suggestions
  assert.equal((await owner('POST', '/admin/fee-categories', { code: 'ZZ', name: 'Bad rule', amountPaise: 100, eligibility: { zzz: [1] } })).body.code, 'BAD_RULE');
  assert.equal((await owner('POST', '/admin/fee-categories', { code: 'OK1', name: 'Good rule', amountPaise: 100, eligibility: { '==': [1, 1] } })).status, 200);
  // duplicates and internal details
  const dupFee = await owner('POST', '/admin/fee-categories', { code: 'GEN', name: 'Again', amountPaise: 100 }); assert.equal(dupFee.status, 409); assert.doesNotMatch(JSON.stringify(dupFee.body), /select|insert|params/i);
  assert.equal((await owner('POST', '/admin/medicines', { name: 'Moisturiser (ceramide)' })).status, 409);
  const badId = await reception('GET', '/patients/not-a-uuid/timeline'); assert.equal(badId.status, 400); assert.doesNotMatch(JSON.stringify(badId.body), /select|params/i);
  const dupUser = await owner('POST', '/admin/users', { name: 'Dup', email: 'reception@demo.clinic', password: 'secret12', roles: ['receptionist'] }); assert.equal(dupUser.status, 409);
});

test('security: headers and login throttling', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(r.headers['x-frame-options'], 'DENY'); assert.equal(r.headers['x-content-type-options'], 'nosniff'); assert.ok(r.headers['content-security-policy']);
  let last = 0;
  for (let i = 0; i < 9; i++) last = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'pharmacy@demo.clinic', password: 'wrong', tenant: 'sahitya' } })).statusCode;
  assert.equal(last, 429);
  // and the right password is held off too until the window passes
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'pharmacy@demo.clinic', password: 'demo1234', tenant: 'sahitya' } })).statusCode, 429);
  // other accounts are unaffected
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@demo.clinic', password: 'demo1234', tenant: 'sahitya' } })).statusCode, 200);
});
