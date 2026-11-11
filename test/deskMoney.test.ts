// Front desk money rules: no more than is due, no more than the fee at check-in, refunds come off the day, a closed day takes no money.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-deskmoney';
process.env.COOKIE_SECRET = 'test-secret';
rmSync(process.env.PGLITE_DIR, { recursive: true, force: true });

const { migrate, applyRls } = await import('../src/db/index.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { buildApp } = await import('../src/app.js');

let app: Awaited<ReturnType<typeof buildApp>>;
const login = async (email: string) => (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenant: 'sahitya' } })).cookies.find((c) => c.name === 'cc_session')!.value;
before(async () => { await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp(); });
after(async () => { await app.close(); });
const as = (c: string) => async (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) => { const r = await app.inject({ method, url: '/api' + url, cookies: { cc_session: c }, payload: payload as any }); return { status: r.statusCode, body: r.body ? r.json() : null }; };
let n = 0; const phone = () => `98480${String(55000 + n++).padStart(5, '0')}`;

test('check-in: more than the fee is refused; less leaves the rest due; waive needs 3 letters', async () => {
  const R = as(await login('reception@demo.clinic'));
  const p = (await R('POST', '/patients', { fullName: 'Desk Money One', phone: phone() })).body;
  const over = await R('POST', '/visits', { patientId: p.id, feeCategoryCode: 'GEN', payment: { method: 'cash', amountPaise: 500000 } });
  assert.equal(over.status, 400); assert.equal(over.body.code, 'MORE_THAN_FEE'); assert.equal(over.body.feePaise, 30000);
  const w = await R('POST', '/visits', { patientId: p.id, feeCategoryCode: 'GEN', waive: { reason: 'x' } });
  assert.equal(w.status, 400, 'a one-letter waive reason is refused');
  const v = await R('POST', '/visits', { patientId: p.id, feeCategoryCode: 'GEN', payment: { method: 'upi', amountPaise: 10000 }, idempotencyKey: 'dm-part-1' });
  assert.equal(v.status, 200, JSON.stringify(v.body)); assert.equal(v.body.charge.status, 'due');
  const fd = (await R('GET', '/frontdesk')).body; const due = fd.visits.find((x: any) => x.id === v.body.id).due[0];
  assert.equal(due.paidPaise, 10000, 'the desk sees what was already paid');

  // collecting the rest: more than what is still due is refused, the exact rest is taken, a repeat key does not take it twice
  const tooMuch = await R('POST', '/payments', { patientId: p.id, chargeId: due.id, amountPaise: 30000, method: 'cash', idempotencyKey: 'dm-col-0' });
  assert.equal(tooMuch.status, 400); assert.equal(tooMuch.body.code, 'MORE_THAN_DUE'); assert.equal(tooMuch.body.duePaise, 20000);
  assert.equal((await R('POST', '/payments', { patientId: p.id, chargeId: due.id, amountPaise: 20000, method: 'cash', idempotencyKey: 'dm-col-1' })).status, 200);
  assert.equal((await R('POST', '/payments', { patientId: p.id, chargeId: due.id, amountPaise: 20000, method: 'cash', idempotencyKey: 'dm-col-1' })).status, 200, 'same key: the first payment comes back');
  const again = await R('POST', '/payments', { patientId: p.id, chargeId: due.id, amountPaise: 20000, method: 'cash', idempotencyKey: 'dm-col-2' });
  assert.equal(again.status, 400, 'a paid charge takes nothing more'); assert.equal(again.body.code, 'MORE_THAN_DUE');
  const tl = (await R('GET', `/patients/${p.id}/timeline`)).body;
  assert.equal(tl.payments.filter((x: any) => x.chargeId === due.id).reduce((s: number, x: any) => s + x.amountPaise, 0), 30000);
});

test('a refund comes off the day it is given, in the mode it was paid; receipt names who took the money', async () => {
  const R = as(await login('reception@demo.clinic')); const O = as(await login('owner@demo.clinic'));
  const before = (await O('GET', '/dayclose')).body;
  const daily0 = (await O('GET', '/reports/daily')).body;
  assert.equal(daily0.totals.collectedPaise, before.money.total.total, 'one Collected: daily report = end of day');

  const p = (await R('POST', '/patients', { fullName: 'Desk Money Two', phone: phone() })).body;
  const v = (await R('POST', '/visits', { patientId: p.id, feeCategoryCode: 'GEN', payment: { method: 'upi', amountPaise: 30000 } })).body;
  const mid = (await O('GET', '/dayclose')).body;
  assert.equal(mid.money.total.upi - before.money.total.upi, 30000);

  assert.equal((await O('POST', `/charges/${v.charge.id}/adjust`, { kind: 'refunded', reason: 'x' })).status, 400, 'a reason of 3+ letters');
  assert.equal((await O('POST', `/charges/${v.charge.id}/adjust`, { kind: 'refunded', reason: 'Left without consultation' })).status, 200);
  assert.equal((await O('POST', `/charges/${v.charge.id}/adjust`, { kind: 'refunded', reason: 'Left without consultation' })).body.code, 'ALREADY_REFUNDED', 'not twice');
  const aft = (await O('GET', '/dayclose')).body;
  assert.equal(aft.money.total.upi, before.money.total.upi, 'the UPI refund takes the UPI figure back');
  assert.equal(aft.money.total.total, before.money.total.total);
  const daily = (await O('GET', '/reports/daily')).body;
  assert.equal(daily.totals.collectedPaise, aft.money.total.total, 'daily report agrees after the refund');
  assert.equal(daily.byMode.upi, aft.money.total.upi);

  // receipt: taken by the desk, printed by the owner
  const c = (await R('POST', '/charges', { patientId: p.id, description: 'Peel', amountPaise: 50000 })).body;
  const take = (await R('POST', '/payments/take', { patientId: p.id, chargeIds: [c.id], idempotencyKey: 'dm-receipt-01', parts: [{ method: 'cash', amountPaise: 50000 }] })).body;
  const desk = (await R('GET', '/me')).body;
  const rc = (await O('GET', `/receipts/${take.receiptNo}`)).body;
  const ownerName = (await O('GET', '/me')).body;
  const name = (x: any) => x?.name ?? x?.user?.name;
  assert.equal(rc.receivedBy, name(desk), 'the person who took the money');
  assert.notEqual(rc.receivedBy, name(ownerName));
});

test('check-in fee split across modes: one receipt, references kept, never more than the fee; junior autosave does not mark screened', async () => {
  const R = as(await login('reception@demo.clinic'));
  const p = (await R('POST', '/patients', { fullName: 'Desk Money Split', phone: phone() })).body;
  const over = await R('POST', '/visits', { patientId: p.id, feeCategoryCode: 'GEN', payments: [{ method: 'cash', amountPaise: 20000 }, { method: 'card', amountPaise: 20000 }] });
  assert.equal(over.status, 400); assert.equal(over.body.code, 'MORE_THAN_FEE');
  const v = await R('POST', '/visits', { patientId: p.id, feeCategoryCode: 'GEN', payments: [{ method: 'cash', amountPaise: 10000 }, { method: 'upi', amountPaise: 20000, reference: 'UPI123' }], idempotencyKey: 'dm-split-1' });
  assert.equal(v.status, 200, JSON.stringify(v.body)); assert.equal(v.body.charge.status, 'paid'); assert.ok(v.body.receiptNo);
  // the junior saves (autosave or leaving the pad): still with the junior; only "Save & return" hands the patient on
  const J = as(await login('assistant@demo.clinic'));
  const e = (await J('POST', `/visits/${v.body.id}/encounter`)).body;
  assert.equal((await J('PATCH', `/encounters/${e.id}`, { data: {} })).status, 200);
  const st = async () => (await R('GET', '/frontdesk')).body.visits.find((x: any) => x.id === v.body.id).status;
  assert.equal(await st(), 'intake');
  assert.equal((await J('PATCH', `/encounters/${e.id}`, { data: {}, screened: true })).status, 200);
  assert.equal(await st(), 'screened');
  assert.equal((await J('POST', `/visits/${v.body.id}/encounter`)).status, 200, 'the junior can reopen a screened patient');
  assert.equal(await st(), 'intake');
});

test('a closed day takes no check-in money and no refund', async () => {
  const R = as(await login('reception@demo.clinic')); const O = as(await login('owner@demo.clinic'));
  const p = (await R('POST', '/patients', { fullName: 'Desk Money Three', phone: phone() })).body;
  const v = (await R('POST', '/visits', { patientId: p.id, feeCategoryCode: 'GEN', payment: { method: 'cash', amountPaise: 30000 } })).body;
  const f = (await O('GET', '/dayclose')).body;
  const closed = await O('POST', '/dayclose', { day: f.day, cashCountedPaise: f.drawer.expectedCashPaise, diary: f.counts });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  const p2 = (await R('POST', '/patients', { fullName: 'Desk Money Four', phone: phone() })).body;
  const late = await R('POST', '/visits', { patientId: p2.id, feeCategoryCode: 'GEN', payment: { method: 'cash', amountPaise: 30000 } });
  assert.equal(late.status, 409); assert.equal(late.body.code, 'DAY_CLOSED');
  assert.equal((await R('POST', '/visits', { patientId: p2.id, feeCategoryCode: 'GEN' })).status, 200, 'checking in without money still works; the fee stays due');
  const ref = await O('POST', `/charges/${v.charge.id}/adjust`, { kind: 'refunded', reason: 'Left without consultation' });
  assert.equal(ref.status, 409); assert.equal(ref.body.code, 'DAY_CLOSED');
});
