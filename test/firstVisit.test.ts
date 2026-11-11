// First visit at check-in: the desk saves date of birth, sex, address, existing conditions and drug allergies on the patient.
// A patient booked by phone (name and number only) gets them at their first check-in; categories sent replace, others stay.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-firstvisit';
process.env.COOKIE_SECRET = 'test-secret';
rmSync(process.env.PGLITE_DIR, { recursive: true, force: true });

const { migrate, applyRls } = await import('../src/db/index.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { buildApp } = await import('../src/app.js');

let app: Awaited<ReturnType<typeof buildApp>>;
const login = async (email: string) => (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenant: 'sahitya' } })).cookies.find((c) => c.name === 'cc_session')!.value;
before(async () => { await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp(); });
after(async () => { await app.close(); });
const as = (c: string) => (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown) => app.inject({ method, url: '/api' + url, cookies: { cc_session: c }, payload: payload as any });

test('reception saves first-visit details; unticking clears that category only', async () => {
  const R = as(await login('reception@demo.clinic'));
  const p = (await R('POST', '/patients', { fullName: 'First Visit Test', phone: '9811100001' })).json(); // booked by phone: name and number
  const r = await R('PATCH', `/patients/${p.id}`, { dob: '1990-05-20', ageYears: 36, sex: 'F', locality: '12-4 Main Road, Rajahmundry',
    history: { conditions: [{ name: 'BP' }, { name: 'Thyroid' }], drugAllergies: [{ name: 'Sulfa' }] } });
  assert.equal(r.statusCode, 200, r.body);
  const row = r.json();
  assert.equal(row.dob, '1990-05-20'); assert.equal(row.sex, 'F'); assert.equal(row.locality, '12-4 Main Road, Rajahmundry');
  assert.deepEqual(row.history.conditions.map((x: any) => x.name), ['BP', 'Thyroid']);
  assert.equal(row.allergies, 'Sulfa', 'the allergy line the Rx check and print use');

  // the doctor adds family history on the pad; the desk then unticks every drug allergy
  await as(await login('owner@demo.clinic'))('PUT', `/patients/${p.id}/history`, { ...row.history, family: [{ name: 'Psoriasis' }] });
  const again = (await R('PATCH', `/patients/${p.id}`, { history: { conditions: [{ name: 'BP' }], drugAllergies: [] } })).json();
  assert.deepEqual(again.history.conditions.map((x: any) => x.name), ['BP']);
  assert.equal(again.history.drugAllergies, undefined, 'sent empty: cleared');
  assert.deepEqual(again.history.family.map((x: any) => x.name), ['Psoriasis'], 'not sent: kept');
  assert.equal(again.allergies, null);

  assert.equal((await R('PATCH', `/patients/${p.id}`, { dob: '2999-01-01' })).statusCode, 400, 'no birth date in the future');
});
