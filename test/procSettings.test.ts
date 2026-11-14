// A procedure set up in Settings with all its sessions: names, minutes, gaps, notes; upfront or per-session price; who conducts it; how long it is valid.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-procsettings';
process.env.COOKIE_SECRET = 'test-secret';
rmSync(process.env.PGLITE_DIR, { recursive: true, force: true });

const { migrate, applyRls } = await import('../src/db/index.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { buildApp } = await import('../src/app.js');

let app: Awaited<ReturnType<typeof buildApp>>;
async function as(email: string) {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenant: 'sahitya' } });
  const cookie = r.cookies.find((c) => c.name === 'cc_session')!.value;
  return (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url: '/api' + url, payload: payload as any, cookies: { cc_session: cookie } }).then((res) => ({ status: res.statusCode, body: res.body ? res.json() : null }));
}
before(async () => { await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp(); });
after(async () => { await app.close(); });
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

test('a procedure with its sessions: upfront total, each session its own length and gap, paid before it starts, valid for months', async () => {
  const owner = await as('owner@demo.clinic');
  const doc = (await owner('GET', '/config')).body.practitioners[0].id;
  const sessions = [{ name: 'Patch test', minutes: 15, gapDays: 0, note: 'Small area first' }, { name: 'Session 2', minutes: 45, gapDays: 10 }, { name: 'Session 3', minutes: 45, gapDays: 21 }];
  assert.equal((await owner('POST', '/admin/procedures', { name: 'Tattoo removal', pricing: 'upfront', sessions })).body.code, 'UPFRONT_NEEDS_A_TOTAL');
  const add = await owner('POST', '/admin/procedures', { name: 'Tattoo removal', pricing: 'upfront', totalPaise: 1000000, sessions, practitionerId: doc, validFor: 6, validUnit: 'months' });
  assert.equal(add.status, 200, JSON.stringify(add.body));
  const p = add.body; assert.equal(p.typicalSittings, 3); assert.equal(p.typicalMinutes, 15); assert.equal(p.pricePaise, 333333); assert.equal(p.totalPaise, 1000000);
  // editing the sessions keeps the count, first length and price in step
  const ed = await owner('PATCH', `/admin/procedures/${p.id}`, { pricing: 'upfront', totalPaise: 900000, sessions: [...sessions, { name: 'Session 4', minutes: 45, gapDays: 21 }] });
  assert.equal(ed.status, 200, JSON.stringify(ed.body)); assert.equal(ed.body.typicalSittings, 4); assert.equal(ed.body.pricePaise, 225000); assert.equal(ed.body.name, 'Tattoo removal');

  // the doctor prescribes it with its 4 sessions: the course is the upfront total, valid 6 months
  const pt = (await owner('POST', '/patients', { fullName: 'Tattoo Patient', phone: '9848022233' })).body;
  const v = (await owner('POST', '/visits', { patientId: pt.id, feeCategoryCode: 'GEN', payment: { method: 'cash', amountPaise: 30000 } })).body;
  const e = (await owner('POST', `/visits/${v.id}/encounter`, {})).body;
  assert.equal((await owner('PATCH', `/encounters/${e.id}`, { data: { complaint: { chief_complaint: ['Tattoo'] }, assessment: { diagnosis: [{ name: 'Tattoo' }] } }, complete: true, recommendations: [{ kind: 'procedure', procedureId: p.id, sittings: 4, gapDays: 10 }] })).status, 200);
  const rec = (await owner('GET', `/patients/${pt.id}/timeline`)).body.recommendations.find((r: any) => r.procedureId === p.id);
  const c = (await owner('POST', '/courses', { recommendationId: rec.id })).body;
  assert.equal(c.totalPaise, 900000); assert.ok(c.validUntil > today());

  // booked with the session's own length (15 min for the patch test) unless the desk picks one
  const ps = (await owner('POST', '/procedure-sessions', { recommendationId: rec.id, day: today(), startTime: '17:00', minutes: 30, autoMinutes: true, practitionerId: doc, force: true })).body;
  assert.equal(ps.endTime, '17:15');
  // upfront: it does not start until the whole total is paid
  assert.equal((await owner('PATCH', `/procedure-sessions/${ps.id}`, { state: 'in_progress', consent: true })).body.code, 'PAY_UPFRONT_FIRST');
  assert.equal((await owner('POST', `/courses/${c.id}/advance`, { amountPaise: 900000, method: 'cash', idempotencyKey: 'tattoo-upfront-1' })).status, 200);
  assert.equal((await owner('PATCH', `/procedure-sessions/${ps.id}`, { state: 'in_progress', consent: true })).status, 200);
  assert.equal((await owner('PATCH', `/procedure-sessions/${ps.id}`, { state: 'completed' })).status, 200);
  // the plan books session 2 ten days later (its own gap), 45 minutes long
  const next = (await owner('GET', `/patients/${pt.id}/timeline`)).body.sessions.find((s: any) => s.recommendationId === rec.id && s.sittingNo === 2);
  assert.ok(next, 'session 2 booked by the plan');
  const d = Math.round((Date.parse(next.day) - Date.parse(today())) / 864e5); assert.ok(d >= 10 && d <= 17, `about ten days later, got ${d}`);
  const mins = (Number(next.endTime.slice(0, 2)) * 60 + Number(next.endTime.slice(3))) - (Number(next.startTime.slice(0, 2)) * 60 + Number(next.startTime.slice(3)));
  assert.equal(mins, 45);
});
