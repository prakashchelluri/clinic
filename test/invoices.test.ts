// Invoices: one number per bill, several lines, part paid, view, refund on the bill, advance history; every charge gets a number.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-invoices';
process.env.UPLOAD_DIR = './data/test-uploads-invoices';
process.env.COOKIE_SECRET = 'test-secret';
rmSync(process.env.PGLITE_DIR, { recursive: true, force: true });
rmSync(process.env.UPLOAD_DIR, { recursive: true, force: true });

const { migrate, applyRls } = await import('../src/db/index.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { buildApp } = await import('../src/app.js');

let app: Awaited<ReturnType<typeof buildApp>>;
type Call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => Promise<{ status: number; body: any }>;
async function as(email: string): Promise<Call> {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenant: 'sahitya' } });
  assert.equal(r.statusCode, 200, r.body);
  const cookie = r.cookies.find((c) => c.name === 'cc_session')!.value;
  return (method, url, payload) => app.inject({ method, url: '/api' + url, payload: payload as any, cookies: { cc_session: cookie } }).then((res) => ({ status: res.statusCode, body: res.body ? (res.headers['content-type']?.includes('json') ? res.json() : res.body) : null }));
}
let n = 0; const key = () => `inv-test-${String(++n).padStart(4, '0')}`;

before(async () => { await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp(); });
after(async () => { await app.close(); });

test('two items for ₹10,000 with ₹500 paid: one invoice, one number, part paid; view; refund on the invoice', async () => {
  const owner = await as('owner@demo.clinic'); const desk = await as('reception@demo.clinic');
  const cfg = (await owner('GET', '/config')).body;
  const a = cfg.procedures.find((x: any) => x.name === 'Fractional CO2 laser (acne scars)'); // ₹8,000
  const b = cfg.procedures.find((x: any) => x.name === 'Excision biopsy'); // ₹3,000 → with ₹1,000 off = ₹2,000
  const p = (await owner('POST', '/patients', { fullName: 'Invoice Patient', phone: '9848088811' })).body;

  // a consultation at check-in is an invoice of its own, with a number
  await owner('POST', '/visits', { patientId: p.id, feeCategoryCode: 'GEN', payment: { method: 'cash', amountPaise: 30000 } });
  const r = await owner('POST', '/bills', { patientId: p.id, idempotencyKey: key(), lines: [{ procedureId: a.id }, { procedureId: b.id, discountPaise: 100000 }], reason: 'regular patient', parts: [{ method: 'cash', amountPaise: 50000 }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const list = (await desk('GET', `/patients/${p.id}/bills`)).body;
  assert.equal(list.bills.length, 2);
  for (const x of list.bills) assert.match(x.invoiceNo, /^INV-\d{4,}$/, 'every invoice has a number');
  assert.notEqual(list.bills[0].invoiceNo, list.bills[1].invoiceNo);
  const inv = list.bills.find((x: any) => x.lines.length === 2);
  assert.ok(inv, 'both items are on one invoice');
  assert.equal(inv.billedPaise, 1000000); assert.equal(inv.paidPaise, 50000); assert.equal(inv.duePaise, 950000); assert.equal(inv.status, 'part');
  assert.equal(inv.discountPaise, 100000);
  assert.equal(list.bills.find((x: any) => x.id !== inv.id).status, 'paid');
  assert.equal(list.totals.duePaise, 950000);

  // the view: lines with discount and GST, the payment with its receipt
  const v = (await desk('GET', `/bills/${inv.id}`)).body;
  assert.equal(v.invoiceNo, inv.invoiceNo); assert.equal(v.rows.length, 2); assert.equal(v.subtotalPaise, 1100000);
  assert.equal(v.payments.length >= 1, true); assert.ok(v.payments[0].receiptNo); assert.equal(v.patient.fullName, 'Invoice Patient');

  // paying the rest later: the same invoice becomes paid
  const lineIds = inv.lines.map((c: any) => c.id);
  assert.equal((await desk('POST', '/bills', { patientId: p.id, idempotencyKey: key(), lines: lineIds.map((id: string) => ({ chargeId: id })), parts: [{ method: 'upi', amountPaise: 950000, reference: '5511' }] })).status, 200);
  let after = (await desk('GET', `/patients/${p.id}/bills`)).body.bills.find((x: any) => x.id === inv.id);
  assert.equal(after.status, 'paid'); assert.equal(after.duePaise, 0);

  // refund on the invoice: only someone who may refund, never more than was paid, with a reason; it is money out today
  const day = async () => (await owner('GET', '/dayclose')).body.money.total.total;
  const before = await day();
  assert.equal((await desk('POST', `/bills/${inv.id}/refund`, { parts: [{ method: 'cash', amountPaise: 1000 }], reason: 'not done' })).status, 403);
  assert.equal((await owner('POST', `/bills/${inv.id}/refund`, { parts: [{ method: 'cash', amountPaise: 1000001 }], reason: 'not done' })).body.code, 'MORE_THAN_PAID');
  assert.equal((await owner('POST', `/bills/${inv.id}/refund`, { parts: [{ method: 'cash', amountPaise: 1000 }], reason: ' ' })).status, 400);
  assert.equal((await owner('POST', `/bills/${inv.id}/refund`, { parts: [{ method: 'cash', amountPaise: 200000 }, { method: 'upi', amountPaise: 100000 }], reason: 'biopsy not done' })).status, 200);
  after = (await desk('GET', `/patients/${p.id}/bills`)).body.bills.find((x: any) => x.id === inv.id);
  assert.equal(after.refundedPaise, 300000); assert.equal(after.status, 'part_refunded'); assert.equal(after.duePaise, 0, 'a refund never makes a bill due again');
  assert.equal(await day(), before - 300000);
  // all the rest back: refunded
  assert.equal((await owner('POST', `/bills/${inv.id}/refund`, { parts: [{ method: 'upi', amountPaise: 700000 }], reason: 'laser not done either' })).status, 200);
  after = (await desk('GET', `/patients/${p.id}/bills`)).body.bills.find((x: any) => x.id === inv.id);
  assert.equal(after.status, 'refunded');

  // the clinic's list finds it by number
  const all = (await desk('GET', `/bills?q=${inv.invoiceNo}`)).body;
  assert.equal(all.bills.length, 1); assert.equal(all.bills[0].patient.fullName, 'Invoice Patient');
});

test('a done sitting is an invoice; the advance shows deposits, uses and refunds', async () => {
  const owner = await as('owner@demo.clinic');
  const p = (await owner('POST', '/patients', { fullName: 'Advance History', phone: '9848088822' })).body;
  const peel = (await owner('GET', '/config')).body.procedures.find((x: any) => x.name === 'Chemical peel');
  await owner('POST', '/bills', { patientId: p.id, idempotencyKey: key(), parts: [{ method: 'cash', amountPaise: 500000 }], keepExtraAsAdvance: true });
  await owner('POST', '/bills', { patientId: p.id, idempotencyKey: key(), lines: [{ procedureId: peel.id }], parts: [{ method: 'advance', amountPaise: peel.pricePaise }] });
  await owner('POST', `/patients/${p.id}/advance/refund`, { amountPaise: 100000, method: 'cash', reason: 'asked for some back' });
  const adv = (await owner('GET', `/patients/${p.id}/advance`)).body;
  assert.equal(adv.balancePaise, 500000 - peel.pricePaise - 100000);
  assert.deepEqual(adv.history.map((h: any) => h.kind).sort(), ['deposit', 'refund', 'used']);
  assert.ok(adv.history.find((h: any) => h.kind === 'deposit').receiptNo);
  const bills = (await owner('GET', `/patients/${p.id}/bills`)).body.bills;
  assert.equal(bills.length, 1); assert.equal(bills[0].status, 'paid');
});
