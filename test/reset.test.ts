// Load test data from Settings clears everything the clinic did and loads the sample fresh; the setup (people, doctors, prices) stays.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-reset';
process.env.UPLOAD_DIR = './data/test-uploads-reset';
process.env.COOKIE_SECRET = 'test-secret';
rmSync(process.env.PGLITE_DIR, { recursive: true, force: true });
rmSync(process.env.UPLOAD_DIR, { recursive: true, force: true });

const { migrate, applyRls } = await import('../src/db/index.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { buildApp } = await import('../src/app.js');

let app: Awaited<ReturnType<typeof buildApp>>;
type Call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => Promise<{ status: number; body: any }>;
async function as(email: string): Promise<Call> {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenant: 'sahitya' } });
  assert.equal(r.statusCode, 200, r.body);
  const cookie = r.cookies.find((c) => c.name === 'cc_session')!.value;
  return (method, url, payload) => app.inject({ method, url: '/api' + url, payload: payload as any, cookies: { cc_session: cookie } }).then((res) => ({ status: res.statusCode, body: res.body ? (res.headers['content-type']?.includes('json') ? res.json() : res.body) : null }));
}

before(async () => { await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp(); });
after(async () => { await app.close(); });

test('reset: only the owner, only by typing RESET; everything the clinic did is cleared and the sample is loaded fresh', async () => {
  const owner = await as('owner@demo.clinic'); const reception = await as('reception@demo.clinic');
  const mine = (await owner('POST', '/patients', { fullName: 'Will Vanish', phone: '9848099911' })).body;
  const v = (await owner('POST', '/visits', { patientId: mine.id, feeCategoryCode: 'GEN', payment: { method: 'cash', amountPaise: 30000 } })).body;
  assert.ok(v.id);
  const cfgBefore = (await owner('GET', '/config')).body;

  assert.equal((await reception('POST', '/dev/reset-sample', { confirm: 'RESET' })).status, 403, 'not the desk');
  assert.equal((await owner('POST', '/dev/reset-sample', {})).status, 400, 'typing RESET is required');
  const done = await owner('POST', '/dev/reset-sample', { confirm: 'RESET' });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.ok(done.body.cleared > 10);

  assert.equal((await owner('GET', '/patients?q=Will Vanish')).body.length, 0, 'what the clinic did is gone');
  const all = (await owner('GET', '/patients?q=a')).body;
  assert.ok(all.length > 5, 'the sample patients are there');
  const cfgAfter = (await owner('GET', '/config')).body;
  assert.equal(cfgAfter.procedures.length, cfgBefore.procedures.length, 'prices and doctors stay');
  assert.equal(cfgAfter.practitioners.length, cfgBefore.practitioners.length);
  assert.equal((await owner('GET', '/audit?days=1')).status, 200, 'the audit log is kept');
  // a second reset gives the same clinic again, not a doubled one
  const n1 = (await owner('GET', '/patients?q=')).body.length;
  assert.equal((await owner('POST', '/dev/reset-sample', { confirm: 'RESET' })).status, 200);
  assert.equal((await owner('GET', '/patients?q=')).body.length, n1);
});
