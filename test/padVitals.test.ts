// The Rxpad's sections and the clinic's own vitals: follow-up and procedures are two sections (an old saved "next" carries to both);
// a vital added in Settings is validated, saved on the pad, and comes back in past values; unknown keys are dropped.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-padvitals';
process.env.COOKIE_SECRET = 'test-secret';
rmSync(process.env.PGLITE_DIR, { recursive: true, force: true });

const { migrate, applyRls } = await import('../src/db/index.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { buildApp } = await import('../src/app.js');
const { padConfig } = await import('../src/lib/pad.js');

let app: Awaited<ReturnType<typeof buildApp>>;
const login = async (email: string) => (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenant: 'sahitya' } })).cookies.find((c) => c.name === 'cc_session')!.value;
const as = (c: string) => (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown) => app.inject({ method, url: '/api' + url, cookies: { cc_session: c }, payload: payload as any });
before(async () => { await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp(); });
after(async () => { await app.close(); });

test('pad sections: follow-up and procedures are separate; a saved "next" carries its choices to both, in its place', () => {
  const def = padConfig({}).map((s) => s.key);
  assert.ok(def.includes('followup') && def.includes('procedures') && !def.includes('next'));
  const old = padConfig({ pad: { sections: [{ key: 'diagnosis', show: true, required: true, print: true }, { key: 'next', show: false, required: false, print: false }, { key: 'advice', show: true, required: false, print: true }] } });
  const keys = old.map((s) => s.key);
  assert.deepEqual(keys.slice(0, 4), ['diagnosis', 'followup', 'procedures', 'advice'], 'in the old place, in order');
  for (const k of ['followup', 'procedures']) { const s = old.find((x) => x.key === k)!; assert.equal(s.show, false); assert.equal(s.print, false); }
});

test("the clinic's own vitals: validated in Settings, saved on the pad, back in past values; unknown keys dropped", async () => {
  const O = as(await login('owner@demo.clinic'));
  // Settings refuses a bad key or type, accepts a good one
  assert.equal((await O('PATCH', '/admin/clinic', { settings: { vitalFields: [{ key: 'Waist!', label: 'Waist', unit: 'cm', type: 'number' }] } })).statusCode, 400);
  assert.equal((await O('PATCH', '/admin/clinic', { settings: { vitalFields: [{ key: 'v_waist', label: 'Waist', unit: 'cm', type: 'weight' }] } })).statusCode, 400);
  const ok = await O('PATCH', '/admin/clinic', { settings: { vitalFields: [{ key: 'v_waist', label: 'Waist', unit: 'cm', type: 'number' }, { key: 'v_urine_sugar', label: 'Urine sugar', unit: '', type: 'text' }], vitals: ['weight_kg', 'bp', 'v_waist', 'v_urine_sugar'] } });
  assert.equal(ok.statusCode, 200, ok.body);

  const cfg = (await O('GET', '/config')).json();
  const doc = cfg.practitioners.find((p: any) => p.name.includes('Main'));
  const cat = cfg.feeCategories.find((c: any) => c.amountPaise === 0) ?? cfg.feeCategories[0];
  const p = (await O('POST', '/patients', { fullName: 'Vitals Patient', phone: '9811100001' })).json();
  const v = await O('POST', '/visits', { patientId: p.id, feeCategoryCode: cat.code, practitionerId: doc.id, details: { weight_kg: 70 }, idempotencyKey: `vit-${Date.now()}`,
    payment: cat.amountPaise > 0 ? { method: 'cash', amountPaise: cat.amountPaise } : undefined });
  assert.equal(v.statusCode, 200, v.body);
  const e = (await O('POST', `/visits/${v.json().id}/encounter`)).json();

  // the pad saves the clinic's own vitals; a wrong type is refused; a key nobody defined is dropped
  assert.equal((await O('PATCH', `/encounters/${e.id}/vitals`, { v_waist: 'wide' })).statusCode, 400, 'a number vital takes a number');
  const saved = await O('PATCH', `/encounters/${e.id}/vitals`, { v_waist: 88, v_urine_sugar: '2+', v_nobody: 5 });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().v_waist, 88); assert.equal(saved.json().v_urine_sugar, '2+'); assert.equal(saved.json().v_nobody, undefined);

  const past = (await O('GET', `/patients/${p.id}/vitals`)).json();
  assert.equal(past[0].v_waist, 88, 'past values show the clinic vital'); assert.equal(past[0].weight_kg, 70);
});
