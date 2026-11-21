// One Refund on the screen: an item comes off the bill; what was paid on it is given back or kept as advance; the unpaid rest stops being due.
// Each is one step with one GST record, and a repeat does not refund twice.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-simplerefund';
process.env.COOKIE_SECRET = 'test-secret';
rmSync(process.env.PGLITE_DIR, { recursive: true, force: true });

const { migrate, applyRls } = await import('../src/db/index.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { buildApp } = await import('../src/app.js');

let app: Awaited<ReturnType<typeof buildApp>>;
type Call = (method: 'GET' | 'POST', url: string, payload?: unknown) => Promise<{ status: number; body: any }>;
async function as(email: string): Promise<Call> {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenant: 'sahitya' } });
  const cookie = r.cookies.find((c) => c.name === 'cc_session')!.value;
  return (method, url, payload) => app.inject({ method, url: '/api' + url, payload: payload as any, cookies: { cc_session: cookie } }).then((res) => ({ status: res.statusCode, body: res.body ? res.json() : null }));
}
let n = 0; const key = () => `simple-refund-${String(++n).padStart(4, '0')}`;
before(async () => { await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp(); });
after(async () => { await app.close(); });

async function setup(O: Call, name: string, phone: string, paidPaise: number) {
  const peel = (await O('GET', '/config')).body.procedures.find((x: any) => x.name === 'Chemical peel'); // ₹2,500 a sitting
  const p = (await O('POST', '/patients', { fullName: name, phone })).body;
  const made = await O('POST', '/bills', { patientId: p.id, idempotencyKey: key(), lines: [{ procedureId: peel.id, qty: 3 }], parts: paidPaise ? [{ method: 'cash', amountPaise: paidPaise }] : undefined });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const id = (await O('GET', `/patients/${p.id}/bills`)).body.bills[0].id;
  const v = (await O('GET', `/bills/${id}`)).body;
  return { p, v, line: v.lines[0], total: peel.pricePaise * 3 };
}
const advance = async (O: Call, pid: string) => (await O('GET', `/patients/${pid}/advance`)).body.balancePaise;

test('take a part-paid item off and give back what was paid: bill and due both clear, one credit record', async () => {
  const O = await as('owner@demo.clinic');
  const { p, v, line, total } = await setup(O, 'Refund Partial', '9848011101', 250000); // ₹7,500 billed, ₹2,500 paid
  const r = await O('POST', `/bills/${v.id}/refund`, { idempotencyKey: key(), reason: 'Stopped the course', lower: true,
    lines: [{ chargeId: line.id, amountPaise: 250000, offPaise: total }], parts: [{ method: 'cash', amountPaise: 250000 }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.creditNo && r.body.receiptNo, 'one GST record and one refund receipt');
  const after = (await O('GET', `/bills/${v.id}`)).body;
  assert.equal(after.creditedPaise, total, 'the whole item is off the bill');
  assert.equal(after.paidPaise, 0); assert.equal(after.duePaise, 0, 'nothing is due any more');
  assert.equal(after.creditNotes.length, 1, 'one record, not two');
  assert.equal(await advance(O, p.id), 0, 'nothing is left sitting in the advance');
});

test('take a fully paid item off and keep the money as advance', async () => {
  const O = await as('owner@demo.clinic');
  const { p, v, line, total } = await setup(O, 'Refund Advance', '9848011102', 750000);
  const r = await O('POST', `/bills/${v.id}/credit`, { idempotencyKey: key(), reason: 'Will use it next visit', lines: [{ chargeId: line.id, amountPaise: total }] });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.toAdvancePaise, total);
  assert.equal(await advance(O, p.id), total, 'the whole payment is the patient\'s advance');
  const after = (await O('GET', `/bills/${v.id}`)).body; assert.equal(after.duePaise, 0); assert.equal(after.paidPaise, 0);
});

test('remove an unpaid item: it just stops being due; no money, no advance', async () => {
  const O = await as('owner@demo.clinic');
  const { p, v, line, total } = await setup(O, 'Refund Unpaid', '9848011103', 0);
  const r = await O('POST', `/bills/${v.id}/credit`, { idempotencyKey: key(), reason: 'Not given', lines: [{ chargeId: line.id, amountPaise: total }] });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.toAdvancePaise, 0);
  assert.equal((await O('GET', `/bills/${v.id}`)).body.duePaise, 0); assert.equal(await advance(O, p.id), 0);
});

test('guards: no more back than comes off, no more off than is left, a repeat refunds once', async () => {
  const O = await as('owner@demo.clinic');
  const { v, line, total } = await setup(O, 'Refund Guards', '9848011104', 250000);
  const send = (body: any) => O('POST', `/bills/${v.id}/refund`, { reason: 'Stopped the course', lower: true, parts: [{ method: 'cash', amountPaise: 250000 }], ...body });
  assert.equal((await send({ idempotencyKey: key(), lines: [{ chargeId: line.id, amountPaise: 250000, offPaise: 100000 }] })).body.code, 'MORE_GIVEN_BACK_THAN_TAKEN_OFF');
  assert.equal((await send({ idempotencyKey: key(), lines: [{ chargeId: line.id, amountPaise: 250000, offPaise: total + 1 }] })).body.code, 'MORE_THAN_THE_LINE');
  assert.equal((await send({ idempotencyKey: key(), lower: false, lines: [{ chargeId: line.id, amountPaise: 250000, offPaise: total }] })).body.code, 'NOTHING_COMES_OFF_THE_BILL');
  const k = key();
  const first = await send({ idempotencyKey: k, lines: [{ chargeId: line.id, amountPaise: 250000, offPaise: total }] });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const again = await send({ idempotencyKey: k, lines: [{ chargeId: line.id, amountPaise: 250000, offPaise: total }] });
  assert.equal(again.status, 200); assert.equal(again.body.receiptNo, first.body.receiptNo, 'the same refund comes back');
  assert.equal((await O('GET', `/bills/${v.id}`)).body.creditNotes.length, 1, 'still one record');
});

test('the old refund (nothing extra off the bill) still behaves the same', async () => {
  const O = await as('owner@demo.clinic');
  const { v, line } = await setup(O, 'Refund Old Way', '9848011105', 250000);
  const r = await O('POST', `/bills/${v.id}/refund`, { idempotencyKey: key(), reason: 'One sitting not given', lower: true, lines: [{ chargeId: line.id, amountPaise: 250000 }], parts: [{ method: 'cash', amountPaise: 250000 }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const after = (await O('GET', `/bills/${v.id}`)).body;
  assert.equal(after.creditedPaise, 250000); assert.equal(after.duePaise, 500000, 'what was due stays due');
});
