// The Calendar's sitting drawer: a doctor sees one sitting's details and may start it and mark it done, nothing else; the desk keeps every state change.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-procdrawer';
process.env.COOKIE_SECRET = 'test-secret';
rmSync(process.env.PGLITE_DIR, { recursive: true, force: true });

const { migrate, applyRls } = await import('../src/db/index.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { buildApp } = await import('../src/app.js');

let app: Awaited<ReturnType<typeof buildApp>>;
const as = async (email: string) => {
  const c = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenant: 'sahitya' } })).cookies.find((x) => x.name === 'cc_session')!.value;
  return (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) => app.inject({ method, url: '/api' + url, cookies: { cc_session: c }, payload: payload as any });
};
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
before(async () => { await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp(); });
after(async () => { await app.close(); });

test('doctor: sitting details, start and mark done only; desk: any state', async () => {
  const owner = await as('owner@demo.clinic'); const reception = await as('reception@demo.clinic'); const doctor = await as('doctor2@demo.clinic');
  const peel = (await owner('GET', '/config')).json().procedures.find((x: any) => x.name === 'Chemical peel');
  const p = (await reception('POST', '/patients', { fullName: 'Drawer Test', phone: '9848055522', history: { conditions: [{ name: 'BP' }], drugAllergies: [{ name: 'Sulfa' }] } })).json();
  const v = (await owner('POST', '/visits', { patientId: p.id, feeCategoryCode: 'GEN', payment: { method: 'cash', amountPaise: 30000 } })).json();
  const e = (await owner('POST', `/visits/${v.id}/encounter`, {})).json();
  await owner('PATCH', `/encounters/${e.id}`, { data: { complaint: { chief_complaint: ['Pigmentation'] }, assessment: { diagnosis: [{ name: 'Melasma' }] } }, complete: true, recommendations: [{ kind: 'procedure', procedureId: peel.id, sittings: 3, notes: 'Glycolic 35%' }] });
  const rec = (await owner('GET', '/worklist?kind=procedure')).json().find((r: any) => r.patientId === p.id);
  const ps = (await reception('POST', '/procedure-sessions', { recommendationId: rec.id, day: today(), startTime: '15:00', minutes: 30, force: true })).json();

  const d = await doctor('GET', `/procedure-sessions/${ps.id}`);
  assert.equal(d.statusCode, 200, d.body);
  const s = d.json();
  assert.equal(s.procedure, 'Chemical peel'); assert.equal(s.plan.sittings, 3); assert.equal(s.plan.notes, 'Glycolic 35%'); assert.deepEqual(s.plan.diagnosis, ['Melasma']);
  assert.equal(s.patient.allergies, 'Sulfa'); assert.deepEqual(s.patient.history.conditions.map((x: any) => x.name), ['BP']);
  assert.equal(s.sittings.length, 1);

  assert.equal((await doctor('PATCH', `/procedure-sessions/${ps.id}`, { state: 'completed' })).statusCode, 409, 'not started yet');
  assert.equal((await doctor('PATCH', `/procedure-sessions/${ps.id}`, { state: 'cancelled' })).statusCode, 403, 'a doctor does not cancel');
  assert.equal((await doctor('PATCH', `/procedure-sessions/${ps.id}`, { state: 'in_progress', consent: true })).statusCode, 200);
  assert.equal((await doctor('PATCH', `/procedure-sessions/${ps.id}`, { state: 'completed' })).statusCode, 200);
  assert.equal((await doctor('GET', `/procedure-sessions/${ps.id}`)).json().state, 'completed');

  const ps2 = (await reception('POST', '/procedure-sessions', { recommendationId: rec.id, day: today(), startTime: '16:00', minutes: 30, force: true })).json();
  assert.equal((await reception('PATCH', `/procedure-sessions/${ps2.id}`, { state: 'postponed', reason: 'patient travelling' })).statusCode, 200, 'the desk still changes any state');
  assert.equal((await (await as('pharmacy@demo.clinic'))('PATCH', `/procedure-sessions/${ps2.id}`, { state: 'in_progress' })).statusCode, 403);
});
