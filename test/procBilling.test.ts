// Procedure billing: a sitting with no course is billed at list price, a cancelled done sitting gives its charge back,
// sitting numbers never repeat when booked ahead, consent is kept per procedure and asked only when none is on file, and a partly used advance counts.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-procbilling';
process.env.COOKIE_SECRET = 'test-secret';
rmSync(process.env.PGLITE_DIR, { recursive: true, force: true });

const { migrate, applyRls, withTenant } = await import('../src/db/index.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { buildApp } = await import('../src/app.js');
const { domainEvent, patient: patientT } = await import('../src/db/schema.js');
const { eq } = await import('drizzle-orm');

let app: Awaited<ReturnType<typeof buildApp>>;
const as = async (email: string) => {
  const c = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenant: 'sahitya' } })).cookies.find((x) => x.name === 'cc_session')!.value;
  return (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) => app.inject({ method, url: '/api' + url, cookies: { cc_session: c }, payload: payload as any });
};
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
before(async () => { await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp(); });
after(async () => { await app.close(); });

async function plan(owner: any, reception: any, name: string, phone: string, sittings: number) {
  const peel = (await owner('GET', '/config')).json().procedures.find((x: any) => x.name === 'Chemical peel');
  const p = (await reception('POST', '/patients', { fullName: name, phone })).json();
  const v = (await owner('POST', '/visits', { patientId: p.id, feeCategoryCode: 'GEN', payment: { method: 'cash', amountPaise: 30000 } })).json();
  const e = (await owner('POST', `/visits/${v.id}/encounter`, {})).json();
  await owner('PATCH', `/encounters/${e.id}`, { data: { complaint: { chief_complaint: ['Acne'] }, assessment: { diagnosis: [{ name: 'Acne' }] } }, complete: true, recommendations: [{ kind: 'procedure', procedureId: peel.id, sittings }] });
  const rec = (await owner('GET', '/worklist?kind=procedure')).json().find((r: any) => r.patientId === p.id);
  return { peel, p, rec };
}
const book = async (reception: any, recId: string, at: string) => (await reception('POST', '/procedure-sessions', { recommendationId: recId, day: today(), startTime: at, minutes: 30, force: true })).json();
const sittingCharges = async (owner: any, pid: string) => (await owner('GET', `/patients/${pid}/timeline`)).json().charges.filter((c: any) => /Chemical peel session/.test(c.description));

test('a sitting with no agreed course is billed once at the list price; cancelling it cancels the charge; rebooking bills once', async () => {
  const owner = await as('owner@demo.clinic'); const reception = await as('reception@demo.clinic');
  const { peel, p, rec } = await plan(owner, reception, 'Billing NoCourse', '9848055601', 3);

  const ps = await book(reception, rec.id, '10:00');
  assert.equal((await reception('PATCH', `/procedure-sessions/${ps.id}`, { state: 'completed' })).statusCode, 200);
  assert.equal((await reception('PATCH', `/procedure-sessions/${ps.id}`, { state: 'completed' })).statusCode, 200, 'marking done twice bills once');
  let ch = await sittingCharges(owner, p.id);
  assert.equal(ch.length, 1);
  assert.equal(ch[0].amountPaise, peel.pricePaise); assert.equal(ch[0].status, 'due');

  // the schedule row and drawer show what is due
  const row = (await reception('GET', `/procedure-sessions?day=${today()}&detail=1`)).json().find((x: any) => x.id === ps.id);
  assert.deepEqual(row.money, { kind: 'due', amountPaise: peel.pricePaise });

  // cancelled after being done: the charge is reversed with a reason
  assert.equal((await reception('PATCH', `/procedure-sessions/${ps.id}`, { state: 'cancelled', reason: 'wrong patient' })).statusCode, 200);
  ch = await sittingCharges(owner, p.id);
  assert.equal(ch[0].status, 'cancelled'); assert.equal(ch[0].adjustmentReason, 'Session cancelled');

  // rebooked and done: one live charge, not two
  const again = await book(reception, rec.id, '11:00');
  assert.equal((await reception('PATCH', `/procedure-sessions/${again.id}`, { state: 'completed' })).statusCode, 200);
  ch = await sittingCharges(owner, p.id);
  assert.equal(ch.filter((c: any) => c.status !== 'cancelled').length, 1);
});

test('a prepaid sitting that is cancelled goes back to the advance', async () => {
  const owner = await as('owner@demo.clinic'); const reception = await as('reception@demo.clinic');
  const { peel, p, rec } = await plan(owner, reception, 'Billing Prepaid', '9848055602', 2);
  const c = (await owner('POST', '/courses', { recommendationId: rec.id })).json();
  assert.equal((await reception('POST', `/courses/${c.id}/advance`, { amountPaise: peel.pricePaise, method: 'upi', reference: '1', idempotencyKey: 'procbilling-adv-1' })).statusCode, 200);
  const ps = await book(reception, rec.id, '12:00');
  assert.equal((await reception('GET', `/procedure-sessions?day=${today()}&detail=1`)).json().find((x: any) => x.id === ps.id).money.kind, 'prepaid');
  await reception('PATCH', `/procedure-sessions/${ps.id}`, { state: 'completed' });
  assert.equal((await owner('GET', `/courses?patientId=${p.id}`)).json()[0].unusedPaise, 0);
  await reception('PATCH', `/procedure-sessions/${ps.id}`, { state: 'cancelled' });
  assert.equal((await owner('GET', `/courses?patientId=${p.id}`)).json()[0].unusedPaise, peel.pricePaise, 'the advance is unused again');
  const ps2 = await book(reception, rec.id, '13:00');
  await reception('PATCH', `/procedure-sessions/${ps2.id}`, { state: 'completed' });
  const live = (await sittingCharges(owner, p.id)).filter((x: any) => x.status !== 'cancelled');
  assert.equal(live.length, 1); assert.equal(live[0].prepaid, true);
});

test('sittings booked ahead get their own numbers', async () => {
  const owner = await as('owner@demo.clinic'); const reception = await as('reception@demo.clinic');
  const { rec } = await plan(owner, reception, 'Billing Numbers', '9848055603', 4);
  const a = await book(reception, rec.id, '14:00'); const b = await book(reception, rec.id, '15:00');
  assert.deepEqual([a.sittingNo, b.sittingNo], [1, 2]);
  await reception('PATCH', `/procedure-sessions/${b.id}`, { state: 'cancelled' });
  assert.equal((await book(reception, rec.id, '16:00')).sittingNo, 2, 'a cancelled number is reused');
});

test('Start needs consent on file: the first Start records it on the patient; later sittings do not ask', async () => {
  const owner = await as('owner@demo.clinic'); const reception = await as('reception@demo.clinic');
  const { p, peel, rec } = await plan(owner, reception, 'Billing Consent', '9848055604', 2);
  const ps = await book(reception, rec.id, '17:00');
  const s0 = (await reception('GET', `/procedure-sessions/${ps.id}`)).json();
  assert.equal(s0.consentNeeded, true); assert.equal(s0.consent, null);
  assert.equal((await reception('GET', `/procedure-sessions?day=${today()}&detail=1`)).json().find((x: any) => x.id === ps.id).consentNeeded, true, 'the coordinator schedule shows Consent needed');
  const refused = await reception('PATCH', `/procedure-sessions/${ps.id}`, { state: 'in_progress' });
  assert.equal(refused.statusCode, 409); assert.equal(refused.json().code, 'CONSENT_NEEDED');
  assert.equal((await reception('PATCH', `/procedure-sessions/${ps.id}`, { state: 'in_progress', consent: true })).statusCode, 200);
  const stored = await withTenant(p.tenantId, '00000000-0000-4000-8000-000000000000', (tx) => tx.select().from(patientT).where(eq(patientT.id, p.id)));
  const c = (stored[0].consents as any)[`procedure:${peel.id}`];
  assert.equal(c.how, 'signed paper form filed'); assert.ok(c.grantedAt); assert.ok(c.by, 'who recorded it');
  const ev = await withTenant(p.tenantId, '00000000-0000-4000-8000-000000000000', (tx) => tx.select().from(domainEvent).where(eq(domainEvent.aggregateId, ps.id)));
  const started = ev.find((x: any) => x.type === 'procedure_session.in_progress');
  assert.equal((started?.payload as any)?.consent, true);
  const ps2 = await book(reception, rec.id, '18:00');
  const s2 = (await reception('GET', `/procedure-sessions/${ps2.id}`)).json();
  assert.equal(s2.consentNeeded, false); assert.equal(s2.consent.how, 'signed paper form filed', 'Consent on file');
  assert.equal((await reception('PATCH', `/procedure-sessions/${ps2.id}`, { state: 'in_progress' })).statusCode, 200, 'no consent question the second time');
});

test('a partly used advance pays part of the next sitting; the rest is due', async () => {
  const owner = await as('owner@demo.clinic'); const reception = await as('reception@demo.clinic');
  const { peel, p, rec } = await plan(owner, reception, 'Billing Partial', '9848055605', 2);
  const c = (await owner('POST', '/courses', { recommendationId: rec.id })).json();
  const half = Math.round(peel.pricePaise / 2);
  assert.equal((await reception('POST', `/courses/${c.id}/advance`, { amountPaise: peel.pricePaise + half, method: 'cash', idempotencyKey: 'procbilling-partial-1' })).statusCode, 200);
  const a = await book(reception, rec.id, '19:00');
  await reception('PATCH', `/procedure-sessions/${a.id}`, { state: 'completed' });
  const b = await book(reception, rec.id, '19:30');
  const before = (await reception('GET', `/procedure-sessions/${b.id}`)).json().money;
  assert.deepEqual(before, { kind: 'due', amountPaise: c.perSittingPaise - half, prepaidPaise: half }, 'only the balance is due');
  await reception('PATCH', `/procedure-sessions/${b.id}`, { state: 'completed' });
  const after = (await reception('GET', `/procedure-sessions/${b.id}`)).json().money;
  assert.equal(after.kind, 'due'); assert.equal(after.amountPaise + after.prepaidPaise, c.totalPaise - c.perSittingPaise, 'the last sitting is the rest of the course');
  assert.equal(after.prepaidPaise, half);
  const course = (await owner('GET', `/courses?patientId=${p.id}`)).json()[0];
  assert.equal(course.unusedPaise, 0, 'the advance is used up'); assert.equal(course.drawnPaise, peel.pricePaise + half);
  const live = (await sittingCharges(owner, p.id)).filter((x: any) => x.status !== 'cancelled');
  assert.equal(live.reduce((s: number, x: any) => s + x.amountPaise, 0), c.totalPaise, 'charges add up to the course price');
});
