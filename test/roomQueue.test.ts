// The consultation room holds three: the desk cannot send a fourth patient in; the doctor sees everyone inside; the desk can print the prescription.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-roomqueue';
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

test('room queue: three inside at most, a fourth is refused; the desk prints the prescription', async () => {
  const R = as(await login('reception@demo.clinic')); const D = as(await login('owner@demo.clinic'));
  const cfg = (await R('GET', '/config')).json();
  const doc = cfg.practitioners.find((p: any) => p.name.includes('Main'));
  const cat = cfg.feeCategories.find((c: any) => c.amountPaise === 0) ?? cfg.feeCategories[0];
  const checkIn = async (n: number) => {
    const p = (await R('POST', '/patients', { fullName: `Room Test ${n}`, phone: `98000000${String(n).padStart(2, '0')}` })).json();
    const r = await R('POST', '/visits', { patientId: p.id, feeCategoryCode: cat.code, practitionerId: doc.id, details: {}, idempotencyKey: `room-${n}-${Date.now()}`,
      payment: cat.amountPaise > 0 ? { method: 'cash', amountPaise: cat.amountPaise } : undefined });
    assert.equal(r.statusCode, 200, r.body);
    return r.json();
  };
  const vs = [];
  for (let i = 1; i <= 4; i++) vs.push(await checkIn(i));
  // whoever is already inside from the seed counts too: empty the room first so the test is exact
  const fd = (await R('GET', '/frontdesk')).json();
  for (const v of fd.visits.filter((x: any) => x.status === 'in_consult' && x.practitionerId === doc.id)) assert.equal((await R('PATCH', `/visits/${v.id}`, { status: 'done' })).statusCode, 200);

  for (let i = 0; i < 3; i++) assert.equal((await R('PATCH', `/visits/${vs[i].id}`, { status: 'in_consult' })).statusCode, 200, `patient ${i + 1} goes in`);
  const fourth = await R('PATCH', `/visits/${vs[3].id}`, { status: 'in_consult' });
  assert.equal(fourth.statusCode, 409);
  assert.equal(fourth.json().code, 'ROOM_FULL');
  assert.equal(fourth.json().inside, 3);

  // the doctor's list shows all three inside, in the order they were sent
  const inside = (await D('GET', '/frontdesk')).json().visits.filter((x: any) => x.status === 'in_consult' && x.practitionerId === doc.id);
  assert.equal(inside.length, 3);

  // one comes out: the fourth can go in
  assert.equal((await R('PATCH', `/visits/${vs[0].id}`, { status: 'done' })).statusCode, 200);
  assert.equal((await R('PATCH', `/visits/${vs[3].id}`, { status: 'in_consult' })).statusCode, 200);

  // the doctor opens a pad; reception can fetch the print page without a doctor's permission
  const enc = await D('POST', `/visits/${vs[1].id}/encounter`);
  assert.equal(enc.statusCode, 200, enc.body);
  const print = await R('GET', `/encounters/${enc.json().id}/print`);
  assert.equal(print.statusCode, 200, print.body);
});
