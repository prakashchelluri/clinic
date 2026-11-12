// One payment screen: fixed prices, discount per line and on the bill, part payment, and approval above the clinic limit.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-bills';
process.env.UPLOAD_DIR = './data/test-uploads-bills';
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
let n = 0; const key = () => `bills-test-${String(++n).padStart(4, '0')}`;

before(async () => { await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp(); });
after(async () => { await app.close(); });

test('a bill: price-list items, % and ₹ discounts, split modes, part payment; above the limit it waits for the owner', async () => {
  const owner = await as('owner@demo.clinic'); const reception = await as('reception@demo.clinic');
  const cfg = (await owner('GET', '/config')).body;
  const peel = cfg.procedures.find((x: any) => x.name === 'Chemical peel'); // ₹2,500
  // the desk may give discounts up to the clinic limit (10%)
  const perms = ['fees.see', 'patient.read', 'patient.write', 'appointment.read', 'appointment.write', 'visit.read', 'visit.write', 'visit.queue', 'payment.record', 'payment.waive', 'discount.give', 'worklist.read', 'worklist.write', 'document.read', 'document.write'];
  assert.equal((await owner('PATCH', '/admin/roles/receptionist', { perms })).status, 200);
  const desk = await as('reception@demo.clinic');
  const p = (await reception('POST', '/patients', { fullName: 'Bill Patient', phone: '9848077711' })).body;
  const bill = (who: Call, b: any) => who('POST', '/bills', { patientId: p.id, idempotencyKey: key(), ...b });

  // nobody types a price: an unknown item is refused, a price-list item is billed at its price
  assert.equal((await bill(desk, { lines: [{ procedureId: '00000000-0000-4000-8000-000000000000' }] })).status, 404);
  assert.equal((await bill(desk, { lines: [{ procedureId: peel.id, pricePaise: 1 }] })).status, 200, 'a price in the body is ignored');
  let tl = (await owner('GET', `/patients/${p.id}/timeline`)).body;
  const first = tl.charges.find((c: any) => c.description === 'Chemical peel');
  assert.equal(first.amountPaise, peel.pricePaise); assert.equal(first.status, 'due', 'a bill with nothing paid stays due');

  // within the limit: 2 peels, 5% on the line + ₹250 off the bill = 10%, paid in two modes, part left due
  const two = peel.pricePaise * 2; const lineOff = two * 0.05; const extra = 25000;
  assert.equal((await bill(desk, { lines: [{ procedureId: peel.id, qty: 2, discountPaise: lineOff }], extraDiscountPaise: extra })).status, 400, 'a discount needs a reason');
  const r1 = await bill(desk, { lines: [{ procedureId: peel.id, qty: 2, discountPaise: lineOff }], extraDiscountPaise: extra, reason: 'family of staff',
    parts: [{ method: 'upi', amountPaise: 200000, reference: '4411' }, { method: 'cash', amountPaise: 100000 }] });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.equal(r1.body.waitingForApproval, false); assert.equal(r1.body.pct, 10);
  assert.equal(r1.body.payablePaise, two - lineOff - extra); assert.equal(r1.body.balancePaise, two - lineOff - extra - 300000);
  assert.match(r1.body.receiptNo, /^R-\d{4}-\d{2}-\d{4}$/);
  tl = (await owner('GET', `/patients/${p.id}/timeline`)).body;
  const c2 = tl.charges.find((c: any) => c.description === 'Chemical peel × 2');
  assert.equal(c2.amountPaise, two - lineOff - extra); assert.equal(c2.discountPaise, lineOff + extra); assert.equal(c2.discountReason, 'family of staff');

  // more than payable, EMI without its code: refused
  assert.equal((await bill(desk, { lines: [{ chargeId: first.id }], parts: [{ method: 'cash', amountPaise: first.amountPaise + 1 }] })).status, 400);
  assert.equal((await bill(desk, { lines: [{ chargeId: first.id }], parts: [{ method: 'emi', amountPaise: 1000 }] })).status, 400);

  // above the limit: 20% goes to the owner; only the discounted amount can be taken meanwhile
  const ask = await bill(desk, { lines: [{ chargeId: first.id, discountPaise: 50000 }], reason: 'missed sitting on our side', parts: [{ method: 'cash', amountPaise: 200000 }] });
  assert.equal(ask.status, 200, JSON.stringify(ask.body)); assert.equal(ask.body.waitingForApproval, true); assert.equal(ask.body.balancePaise, 0);
  tl = (await owner('GET', `/patients/${p.id}/timeline`)).body;
  assert.equal(tl.charges.find((c: any) => c.id === first.id).status, 'due', 'stays open until the owner decides');
  assert.equal((await bill(desk, { lines: [{ chargeId: first.id }], parts: [{ method: 'cash', amountPaise: 1 }] })).status, 409, 'the waiting part cannot be collected');
  assert.equal((await bill(desk, { lines: [{ chargeId: c2.id, discountPaise: 100 }], reason: 'again' })).status, 400, 'no discount once money is taken');
  const asks = (await owner('GET', '/discount-asks')).body;
  const a = asks.find((x: any) => x.patientId === p.id);
  assert.equal(a.offPaise, 50000); assert.equal(a.pct, 20); assert.equal(a.paidPaise, 200000); assert.equal(a.patient.fullName, 'Bill Patient');
  assert.equal((await desk('POST', `/discount-asks/${a.id}/decide`, { action: 'approve' })).status, 403, 'the desk cannot approve');
  assert.equal((await owner('POST', `/discount-asks/${a.id}/decide`, { action: 'approve' })).status, 200);
  assert.equal((await owner('POST', `/discount-asks/${a.id}/decide`, { action: 'reject' })).status, 409, 'decided once');
  tl = (await owner('GET', `/patients/${p.id}/timeline`)).body;
  const done = tl.charges.find((c: any) => c.id === first.id);
  assert.equal(done.status, 'paid'); assert.equal(done.amountPaise, 200000); assert.equal(done.discountPaise, 50000);

  // said no: the full price stays due
  const r3 = await bill(desk, { lines: [{ procedureId: peel.id, discountPaise: 125000 }], reason: 'asked for half' });
  assert.equal(r3.body.waitingForApproval, true);
  const a2 = (await owner('GET', '/discount-asks')).body.find((x: any) => x.patientId === p.id);
  assert.equal((await owner('POST', `/discount-asks/${a2.id}/decide`, { action: 'reject' })).status, 200);
  tl = (await owner('GET', `/patients/${p.id}/timeline`)).body;
  const half = tl.charges.filter((c: any) => c.description === 'Chemical peel').find((c: any) => c.id !== first.id);
  assert.equal(half.amountPaise, peel.pricePaise); assert.equal(half.discountPaise, 0);

  // the owner's own big discount needs nobody; the same click twice bills once
  const k = key();
  const own = await owner('POST', '/bills', { patientId: p.id, idempotencyKey: k, lines: [{ chargeId: half.id, discountPaise: 125000 }], reason: 'owner decided' });
  assert.equal(own.body.waitingForApproval, false);
  assert.equal((await owner('POST', '/bills', { patientId: p.id, idempotencyKey: k, lines: [{ chargeId: half.id, discountPaise: 125000 }], reason: 'owner decided' })).body.repeated, true);
});

test('consultation fees take no discount; sittings paid ahead start the course at its fixed price and must be paid in full', async () => {
  const owner = await as('owner@demo.clinic');
  const cfg = (await owner('GET', '/config')).body;
  const peel = cfg.procedures.find((x: any) => x.name === 'Chemical peel');
  const p = (await owner('POST', '/patients', { fullName: 'Ahead Patient', phone: '9848077722' })).body;
  const v = (await owner('POST', '/visits', { patientId: p.id, feeCategoryCode: 'GEN' })).body;
  const consult = (await owner('GET', `/patients/${p.id}/timeline`)).body.charges.find((c: any) => c.visitId === v.id);
  if (consult?.status === 'due') assert.equal((await owner('POST', '/bills', { patientId: p.id, idempotencyKey: key(), lines: [{ chargeId: consult.id, discountPaise: 100 }], reason: 'no' })).body.code, 'NO_DISCOUNT_ON_CONSULTATION');

  const e = (await owner('POST', `/visits/${v.id}/encounter`, {})).body;
  assert.equal((await owner('PATCH', `/encounters/${e.id}`, { data: { complaint: { chief_complaint: ['Pigmentation'] }, assessment: { diagnosis: [{ name: 'Melasma' }] } }, complete: true, recommendations: [{ kind: 'procedure', procedureId: peel.id, sittings: 6 }] })).status, 200);
  const rec = (await owner('GET', '/worklist?kind=procedure')).body.find((r: any) => r.patientId === p.id);
  const ahead = (b: any) => owner('POST', '/bills', { patientId: p.id, idempotencyKey: key(), lines: [{ recommendationId: rec.id, sittings: 2, ...b.line }], ...b });
  assert.equal((await ahead({ parts: [{ method: 'cash', amountPaise: 100000 }] })).body.code, 'PAY_AHEAD_IN_FULL');
  const r = await ahead({ line: { discountPaise: 50000 }, reason: 'second course', parts: [{ method: 'upi', amountPaise: peel.pricePaise * 2 - 50000, reference: '7788' }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const c = (await owner('GET', `/courses?patientId=${p.id}`)).body[0];
  assert.equal(c.totalPaise, peel.pricePaise * 6, 'list price × sittings');
  assert.equal(c.creditPaise, 50000); assert.equal(c.unusedSittings, 2, 'the discount counts toward the sittings paid ahead');
  assert.equal(c.refundablePaise, peel.pricePaise * 2 - 50000, 'the discount is never handed back as money');
  assert.ok(c.lockedAt);
});

test('advance: taken with no bill, kept from an overpayment, used on a bill without counting twice, given back', async () => {
  const owner = await as('owner@demo.clinic');
  const cfg = (await owner('GET', '/config')).body;
  const peel = cfg.procedures.find((x: any) => x.name === 'Chemical peel');
  const p = (await owner('POST', '/patients', { fullName: 'Advance Patient', phone: '9848077733' })).body;
  const bill = (b: any) => owner('POST', '/bills', { patientId: p.id, idempotencyKey: key(), ...b });
  const bal = async () => (await owner('GET', `/patients/${p.id}/advance`)).body.balancePaise;
  const day = async () => (await owner('GET', '/dayclose')).body.money.total.total;
  const before = await day();

  assert.equal((await bill({ lines: [] })).body.code, 'NOTHING_TO_BILL');
  const dep = await bill({ parts: [{ method: 'cash', amountPaise: 300000 }], keepExtraAsAdvance: true });
  assert.equal(dep.status, 200, JSON.stringify(dep.body)); assert.equal(dep.body.advancePaise, 300000); assert.ok(dep.body.receiptNo);
  assert.equal(await day(), before + 300000, 'an advance is money in on the day it comes');

  // overpay a peel: only with "keep the extra"
  assert.equal((await bill({ lines: [{ procedureId: peel.id }], parts: [{ method: 'upi', amountPaise: peel.pricePaise + 50000, reference: '9911' }] })).body.code, 'MORE_THAN_DUE');
  const over = await bill({ lines: [{ procedureId: peel.id }], parts: [{ method: 'upi', amountPaise: peel.pricePaise + 50000, reference: '9911' }], keepExtraAsAdvance: true });
  assert.equal(over.body.keptAsAdvancePaise, 50000); assert.equal(await bal(), 350000);

  // pay a peel from the advance: the invoice is paid, the day's money does not move again
  const mid = await day();
  assert.equal((await bill({ lines: [{ procedureId: peel.id }], parts: [{ method: 'advance', amountPaise: 400000 }] })).body.code, 'MORE_THAN_THE_ADVANCE');
  assert.equal((await bill({ lines: [{ procedureId: peel.id }], parts: [{ method: 'advance', amountPaise: peel.pricePaise + 1 }], keepExtraAsAdvance: true })).body.code, 'MORE_THAN_DUE', 'the advance never pays into itself');
  const use = await bill({ lines: [{ procedureId: peel.id }], parts: [{ method: 'advance', amountPaise: peel.pricePaise }] });
  assert.equal(use.status, 200, JSON.stringify(use.body)); assert.equal(use.body.balancePaise, 0); assert.equal(use.body.receiptNo, null, 'no receipt: no money changed hands');
  assert.equal(await bal(), 350000 - peel.pricePaise); assert.equal(await day(), mid, 'used advance is not counted twice');
  const tl = (await owner('GET', `/patients/${p.id}/timeline`)).body;
  assert.equal(tl.outstandingPaise, 0);

  // give back what is left
  const left = await bal();
  assert.equal((await owner('POST', `/patients/${p.id}/advance/refund`, { amountPaise: left + 1, method: 'cash', reason: 'moving away' })).body.code, 'MORE_THAN_THE_ADVANCE');
  assert.equal((await as('reception@demo.clinic').then((r) => r('POST', `/patients/${p.id}/advance/refund`, { amountPaise: left, method: 'cash', reason: 'moving away' }))).status, 403);
  assert.equal((await owner('POST', `/patients/${p.id}/advance/refund`, { amountPaise: left, method: 'cash', reason: 'moving away' })).body.balancePaise, 0);
  assert.equal(await day(), mid - left, 'the refund is money out today');
});
