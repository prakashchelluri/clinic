// Send in is the desk's, whoever presses it: an owner who is also a doctor pressing it does not make the desk hear "the doctor is calling".
// Only the doctor's Open (pulling a waiting patient in) marks the call as the doctor's.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-sendin';
process.env.COOKIE_SECRET = 'test-secret';
rmSync(process.env.PGLITE_DIR, { recursive: true, force: true });

const { migrate, applyRls } = await import('../src/db/index.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { buildApp } = await import('../src/app.js');

let app: Awaited<ReturnType<typeof buildApp>>;
const login = async (email: string) => (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenant: 'sahitya' } })).cookies.find((c) => c.name === 'cc_session')!.value;
before(async () => { await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp(); });
after(async () => { await app.close(); });
const as = (c: string) => (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) => app.inject({ method, url: '/api' + url, cookies: { cc_session: c }, payload: payload as any });

test('send in by the owner-doctor counts as the desk; Open by the doctor counts as the doctor', async () => {
  const D = as(await login('owner@demo.clinic')); // owner and doctor in one person
  const cfg = (await D('GET', '/config')).json();
  const doc = cfg.practitioners.find((p: any) => p.name.includes('Main'));
  await D('POST', '/sessions', { branchId: cfg.branches[0].id, practitionerId: doc.id, day: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }), startTime: '00:00', endTime: '23:59', capacity: 50 }); // the doctor works all day today, so check-ins hold at any hour
  const cat = cfg.feeCategories.find((c: any) => c.amountPaise === 0) ?? cfg.feeCategories[0];
  const checkIn = async (n: number) => {
    const p = (await D('POST', '/patients', { fullName: `Send In ${n}`, phone: `98111111${n}${n}` })).json();
    const r = await D('POST', '/visits', { patientId: p.id, feeCategoryCode: cat.code, practitionerId: doc.id, details: {}, idempotencyKey: `si-${n}-${Date.now()}`, payment: cat.amountPaise > 0 ? { method: 'cash', amountPaise: cat.amountPaise } : undefined });
    assert.equal(r.statusCode, 200, r.body); return r.json();
  };

  const a = await checkIn(1);
  const sent = await D('PATCH', `/visits/${a.id}`, { status: 'in_consult' });
  assert.equal(sent.statusCode, 200, sent.body);
  assert.equal(sent.json().details.calledBy, 'desk', 'the Send in button is the desk, even pressed by the owner-doctor');

  const b = await checkIn(2);
  const opened = await D('POST', `/visits/${b.id}/encounter`);
  assert.equal(opened.statusCode, 200, opened.body);
  const fd = (await D('GET', '/frontdesk')).json();
  assert.equal(fd.visits.find((v: any) => v.id === b.id).details.calledBy, 'doctor', 'the doctor opening a waiting patient is the doctor calling');
});
