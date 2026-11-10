// Back with reports: within the clinic's free days the desk checks the patient in with no fee and no form,
// the visit goes to the doctor who ordered the tests, and a made-up consultation id is refused.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-reportsback';
process.env.COOKIE_SECRET = 'test-secret';
rmSync(process.env.PGLITE_DIR, { recursive: true, force: true });

const { migrate, applyRls } = await import('../src/db/index.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { buildApp } = await import('../src/app.js');

let app: Awaited<ReturnType<typeof buildApp>>;
const login = async (email: string) => (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenant: 'sahitya' } })).cookies.find((c) => c.name === 'cc_session')!.value;
before(async () => { await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp(); });
after(async () => { await app.close(); });
const as = (c: string) => (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => app.inject({ method, url: '/api' + url, cookies: { cc_session: c }, payload: payload as any });

test('back with reports: free, no review allowance, to the ordering doctor; a bad consultation id is refused', async () => {
  const R = as(await login('reception@demo.clinic')); const D = as(await login('owner@demo.clinic'));
  const cfg = (await R('GET', '/config')).json();
  const doc = cfg.practitioners.find((p: any) => p.name.includes('Main'));
  const paid = cfg.feeCategories.find((c: any) => c.amountPaise > 0 && c.code !== 'REN');
  const ren = cfg.feeCategories.find((c: any) => c.code === 'REN');
  assert.ok(paid && ren && ren.amountPaise > 0, 'needs a paid category and a paid review category');

  // first visit: paid consultation, the doctor opens it (tests would be ordered here), then the visit ends
  const p = (await R('POST', '/patients', { fullName: 'Reports Back', phone: '9800001234' })).json();
  const v1 = (await R('POST', '/visits', { patientId: p.id, feeCategoryCode: paid.code, practitionerId: doc.id, details: {}, idempotencyKey: `rb-1-${Date.now()}`, payment: { method: 'cash', amountPaise: paid.amountPaise } })).json();
  const enc = (await D('POST', `/visits/${v1.id}/encounter`)).json();
  assert.ok(enc.id, JSON.stringify(enc));
  assert.equal((await D('PATCH', `/visits/${v1.id}`, { status: 'done' })).statusCode, 200);

  // a made-up consultation id is refused, not silently free
  const bad = await R('POST', '/visits', { patientId: p.id, feeCategoryCode: ren.code, details: { reportsEncounterId: '00000000-0000-0000-0000-000000000000' }, idempotencyKey: `rb-bad-${Date.now()}` });
  assert.equal(bad.statusCode, 400, bad.body);

  // back with reports, as the desk's one-click Send in does it: no payment, no waive, no doctor picked
  const r = await R('POST', '/visits', { patientId: p.id, feeCategoryCode: ren.code, details: { reportsEncounterId: enc.id, complaint: 'Back with reports: CBC' }, idempotencyKey: `rb-2-${Date.now()}` });
  assert.equal(r.statusCode, 200, r.body);
  const v2 = r.json();
  assert.equal(v2.practitionerId, doc.id, 'goes to the doctor who ordered the tests');
  const fd = (await R('GET', '/frontdesk')).json();
  const row = fd.visits.find((x: any) => x.id === v2.id);
  assert.ok(row, 'on the front desk');
  assert.equal(row.due.length, 0, 'nothing to collect');
  assert.equal(row.details.reportsEncounterId, enc.id, 'the doctor is told it is a report review');
});
