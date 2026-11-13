// The doctor's own price for a procedure (the total for all sittings) beats the standard price: the course is made at it, and a sitting
// done before any course is billed its share. A doctor moves their own sitting from the approval list (approved as it lands), not another's.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-procprice';
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
const plusDays = (n: number) => { const d = new Date(today() + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
before(async () => { await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp(); });
after(async () => { await app.close(); });

async function plan(owner: any, reception: any, name: string, phone: string, amountPaise: number | null) {
  const peel = (await owner('GET', '/config')).json().procedures.find((x: any) => x.name === 'Chemical peel');
  const p = (await reception('POST', '/patients', { fullName: name, phone })).json();
  const v = (await owner('POST', '/visits', { patientId: p.id, feeCategoryCode: 'GEN', payment: { method: 'cash', amountPaise: 30000 } })).json();
  const e = (await owner('POST', `/visits/${v.id}/encounter`, {})).json();
  const r = await owner('PATCH', `/encounters/${e.id}`, { data: { complaint: { chief_complaint: ['Acne'] }, assessment: { diagnosis: [{ name: 'Acne' }] } }, complete: true, recommendations: [{ kind: 'procedure', procedureId: peel.id, sittings: 4, gapDays: 30, amountPaise }] });
  assert.equal(r.statusCode, 200, r.body);
  const rec = (await owner('GET', '/worklist?kind=procedure')).json().find((x: any) => x.patientId === p.id);
  return { peel, p, rec };
}

test("the doctor's amount is the course price; a sitting done before a course is billed its share; empty means standard", async () => {
  const owner = await as('owner@demo.clinic'); const reception = await as('reception@demo.clinic');

  // custom: ₹24,000 for 4 sittings
  const a = await plan(owner, reception, 'Price Custom', '9848066601', 2400000);
  assert.equal(a.rec.amountPaise, 2400000, 'kept on the plan');
  const c = (await reception('POST', '/courses', { recommendationId: a.rec.id })).json();
  assert.equal(c.totalPaise, 2400000); assert.equal(c.listPaise, 2400000); assert.equal(c.perSittingPaise, 600000);

  // custom, no course agreed: the done sitting is billed a quarter
  const b = await plan(owner, reception, 'Price Share', '9848066602', 2400000);
  const ps = (await reception('POST', '/procedure-sessions', { recommendationId: b.rec.id, day: today(), startTime: '10:00', minutes: 30, force: true })).json();
  assert.equal((await reception('PATCH', `/procedure-sessions/${ps.id}`, { state: 'completed' })).statusCode, 200);
  const ch = (await owner('GET', `/patients/${b.p.id}/timeline`)).json().charges.filter((x: any) => /Chemical peel sitting/.test(x.description));
  assert.equal(ch.length, 1); assert.equal(ch[0].amountPaise, 600000);

  // empty: the standard price
  const s = await plan(owner, reception, 'Price Standard', '9848066603', null);
  const cs = (await reception('POST', '/courses', { recommendationId: s.rec.id })).json();
  assert.equal(cs.totalPaise, s.peel.pricePaise * 4);
});

test('a doctor moves their own sitting (approved as it lands), never another doctor’s', async () => {
  const owner = await as('owner@demo.clinic'); const reception = await as('reception@demo.clinic'); const doc2 = await as('doctor2@demo.clinic');
  const cfg = (await owner('GET', '/config')).json();
  const drB = cfg.practitioners.find((x: any) => x.name === 'Dr. Second Doctor'); const drA = cfg.practitioners.find((x: any) => x.name !== 'Dr. Second Doctor');
  const { rec } = await plan(owner, reception, 'Move Own', '9848066604', null);
  const mine = (await reception('POST', '/procedure-sessions', { recommendationId: rec.id, day: plusDays(8), startTime: '11:00', minutes: 30, practitionerId: drB.id, force: true })).json();
  const moved = await doc2('POST', `/procedure-sessions/${mine.id}/reschedule`, { day: plusDays(9), startTime: '12:00', minutes: 30, practitionerId: drB.id, force: true });
  assert.equal(moved.statusCode, 200, moved.body);
  assert.equal(moved.json().approval, 'approved');
  const theirs = (await reception('POST', '/procedure-sessions', { recommendationId: rec.id, day: plusDays(10), startTime: '11:00', minutes: 30, practitionerId: drA.id, force: true })).json();
  assert.equal((await doc2('POST', `/procedure-sessions/${theirs.id}/reschedule`, { day: plusDays(11), startTime: '12:00', minutes: 30, practitionerId: drA.id, force: true })).statusCode, 403);
});
