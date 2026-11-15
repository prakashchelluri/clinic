// The billing QA findings of 15 Nov 2026 (docs/qa-billing-ui-2026-11-15.md), each as a check that fails if it comes back.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-billingqa';
process.env.COOKIE_SECRET = 'test-secret';
rmSync(process.env.PGLITE_DIR, { recursive: true, force: true });

const { migrate, applyRls, seedIfEmpty } = { ...(await import('../src/db/index.js')), ...(await import('../src/db/seed.js')) } as any;
const { buildApp } = await import('../src/app.js');

let app: Awaited<ReturnType<typeof buildApp>>;
const as = async (email: string) => {
  const c = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenant: 'sahitya' } })).cookies.find((x) => x.name === 'cc_session')!.value;
  return (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) => app.inject({ method, url: '/api' + url, cookies: { cc_session: c }, payload: payload as any });
};
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
let k = 0; const key = () => `billingqa-${++k}`;
before(async () => { await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp(); });
after(async () => { await app.close(); });

async function treatment(owner: any, name: string, phone: string, sittings: number) {
  const peel = (await owner('GET', '/config')).json().procedures.find((x: any) => x.name === 'Chemical peel');
  const p = (await owner('POST', '/patients', { fullName: name, phone })).json();
  const v = (await owner('POST', '/visits', { patientId: p.id, feeCategoryCode: 'GEN', payment: { method: 'cash', amountPaise: 30000 } })).json();
  const e = (await owner('POST', `/visits/${v.id}/encounter`, {})).json();
  await owner('PATCH', `/encounters/${e.id}`, { data: { complaint: { chief_complaint: ['Acne'] }, assessment: { diagnosis: [{ name: 'Acne' }] } }, complete: true, recommendations: [{ kind: 'procedure', procedureId: peel.id, sittings }] });
  const rec = (await owner('GET', `/patients/${p.id}/timeline`)).json().recommendations.find((r: any) => r.kind === 'procedure');
  return { peel, p, rec };
}
const balanced = (t: any) => assert.equal(t.billedPaise - t.receivedPaise + t.refundedPaise, t.duePaise - t.advancePaise, 'billed − received + refunded = due − advance');

test('H1 + M1: a refund on a treatment invoice is never billed again, and an invoice with money due is not "Refunded"', async () => {
  const owner = await as('owner@demo.clinic');
  const { peel, p, rec } = await treatment(owner, 'QA Refund', '9848077801', 4);
  const total = peel.pricePaise * 4;
  assert.equal((await owner('POST', '/bills', { patientId: p.id, idempotencyKey: key(), lines: [{ recommendationId: rec.id }], parts: [{ method: 'cash', amountPaise: 300000 }] })).statusCode, 200);
  const bill = (await owner('GET', `/patients/${p.id}/bills`)).json().bills.find((b: any) => b.items[0].startsWith('Chemical peel'));
  assert.equal((await owner('POST', `/bills/${bill.id}/refund`, { parts: [{ method: 'cash', amountPaise: 300000 }], reason: 'Session not given' })).statusCode, 200);
  const c = (await owner('GET', `/courses?patientId=${p.id}`)).json()[0];
  assert.equal(c.uninvoicedPaise, 0, 'nothing left to bill again'); assert.equal(c.stillToPayPaise, total - 300000, 'still to pay = the lowered invoice');
  assert.equal((await owner('POST', '/bills', { patientId: p.id, idempotencyKey: key(), lines: [{ recommendationId: rec.id }] })).json().code, 'ALREADY_INVOICED');
  const after = (await owner('GET', `/patients/${p.id}/bills`)).json().bills.find((b: any) => b.id === bill.id);
  assert.equal(after.duePaise, total - 300000); assert.equal(after.status, 'unpaid', 'money is still due, so not "Refunded"');
  balanced((await owner('GET', `/patients/${p.id}/account`)).json().totals);
  // the printed invoice: the line at its price, less what was refunded; one payment line; the refund apart
  const v = (await owner('GET', `/bills/${bill.id}`)).json();
  assert.equal(v.rows[0].listPaise, total); assert.equal(v.rows[0].lessPaise, 300000);
  assert.equal(v.payments.filter((x: any) => x.kind === 'paid').length, 1); assert.equal(v.payments.filter((x: any) => x.kind === 'refund').length, 1);
});

test('H2: Billing, Clinic, Accounts and Reports agree on what is due (part payments taken off)', async () => {
  const owner = await as('owner@demo.clinic');
  const { p, rec } = await treatment(owner, 'QA Due', '9848077802', 3);
  await owner('POST', '/bills', { patientId: p.id, idempotencyKey: key(), lines: [{ recommendationId: rec.id }], parts: [{ method: 'upi', amountPaise: 100000, reference: '1' }] });
  const clinic = (await owner('GET', '/owner/summary')).json().dues.totalPaise;
  const accounts = (await owner('GET', `/finance?from=${today()}&to=${today()}`)).json().owed.totalPaise;
  assert.equal(clinic, accounts, 'Clinic and Accounts');
  const billsToday = (await owner('GET', `/bills?from=${today()}&to=${today()}`)).json().totals.duePaise;
  const reportsToday = (await owner('GET', `/reports/analytics?from=${today()}&to=${today()}`)).json().now.duePaise;
  assert.equal(reportsToday, billsToday, 'Reports and Billing, for what was billed today');
  assert.ok(clinic >= billsToday);
});

test('M2: a discount awaiting approval stays owed everywhere and its invoice says so', async () => {
  const owner = await as('owner@demo.clinic'); const reception = await as('reception@demo.clinic');
  const { peel, p, rec } = await treatment(owner, 'QA Waiting', '9848077803', 2);
  const total = peel.pricePaise * 2; const off = Math.round(total * 0.2);
  const r = (await reception('POST', '/bills', { patientId: p.id, idempotencyKey: key(), lines: [{ recommendationId: rec.id, discountPaise: off }], reason: 'Family friend', parts: [{ method: 'cash', amountPaise: total - off }] })).json();
  assert.equal(r.waitingForApproval, true);
  const acc = (await owner('GET', `/patients/${p.id}/account`)).json();
  assert.equal(acc.totals.duePaise, off, 'the waiting part is still owed'); assert.equal(acc.totals.waitingOffPaise, off);
  assert.equal((await owner('GET', `/patients/${p.id}/timeline`)).json().outstandingPaise, off, 'the header says the same');
  assert.equal(acc.activity.find((a: any) => a.type === 'invoice' && a.items[0].startsWith('Chemical')).status, 'waiting');
  // the approval card shows what has been taken by now
  const ask = (await owner('GET', '/discount-asks')).json().find((a: any) => a.patientId === p.id);
  assert.equal(ask.paidPaise, total - off);
  await owner('POST', `/discount-asks/${ask.id}/decide`, { action: 'approve' });
  const t = (await owner('GET', `/patients/${p.id}/account`)).json().totals; assert.equal(t.duePaise, 0); balanced(t);
});

test('M9 + M12: a consultation is not billed from Generate invoice; a price-list procedure counts under Procedures', async () => {
  const owner = await as('owner@demo.clinic');
  const cfg = (await owner('GET', '/config')).json();
  const p = (await owner('POST', '/patients', { fullName: 'QA Price list', phone: '9848077804' })).json();
  const consult = cfg.services.find((s: any) => s.feeCategoryId && s.pricePaise > 0);
  assert.ok(consult, 'the demo has a consultation visit type'); assert.equal((await owner('POST', '/bills', { patientId: p.id, idempotencyKey: key(), lines: [{ serviceId: consult.id }] })).json().code, 'CONSULTATION_AT_CHECK_IN');
  const hydra = cfg.procedures.find((x: any) => x.pricePaise > 0);
  const before = (await owner('GET', '/dayclose')).json().money;
  assert.equal((await owner('POST', '/bills', { patientId: p.id, idempotencyKey: key(), lines: [{ procedureId: hydra.id }], parts: [{ method: 'cash', amountPaise: hydra.pricePaise }] })).statusCode, 200);
  const after = (await owner('GET', '/dayclose')).json().money;
  assert.equal(after.procedure.total - before.procedure.total, hydra.pricePaise, 'under Procedures'); assert.equal(after.other.total, before.other.total, 'not under Other');
});

test('M3: after a part-paid treatment is cancelled, the printed invoice keeps the line\'s price and shows the credit, not a refund', async () => {
  const owner = await as('owner@demo.clinic');
  const { peel, p, rec } = await treatment(owner, 'QA Print', '9848077806', 4);
  const total = peel.pricePaise * 4;
  await owner('POST', '/bills', { patientId: p.id, idempotencyKey: key(), lines: [{ recommendationId: rec.id }], parts: [{ method: 'upi', amountPaise: 400000, reference: '9' }] });
  assert.equal((await owner('POST', '/procedure-plans/cancel', { ids: [rec.id], reason: 'Moved away' })).statusCode, 200);
  const bill = (await owner('GET', `/patients/${p.id}/bills`)).json().bills.find((b: any) => b.items[0].startsWith('Chemical'));
  const v = (await owner('GET', `/bills/${bill.id}`)).json();
  assert.equal(v.rows[0].listPaise, total, 'printed at the price it was billed at'); assert.equal(v.rows[0].amountPaise, 0);
  assert.equal(v.payments.filter((x: any) => x.kind === 'credit').reduce((s: number, x: any) => s + x.amountPaise, 0), -400000, 'the credit');
  assert.equal(v.payments.filter((x: any) => x.kind === 'refund').length, 0, 'not a refund');
  balanced((await owner('GET', `/patients/${p.id}/account`)).json().totals);
});

test('low 10: cancelling a treatment\'s only invoice frees its price again', async () => {
  const owner = await as('owner@demo.clinic');
  const { p, rec } = await treatment(owner, 'QA Unlock', '9848077805', 2);
  await owner('POST', '/bills', { patientId: p.id, idempotencyKey: key(), lines: [{ recommendationId: rec.id }] });
  assert.ok((await owner('GET', `/courses?patientId=${p.id}`)).json()[0].lockedAt);
  const bill = (await owner('GET', `/patients/${p.id}/bills`)).json().bills.find((b: any) => b.items[0].startsWith('Chemical'));
  for (const c of bill.lines) assert.equal((await owner('POST', `/charges/${c.id}/cancel`, { reason: 'Wrong patient' })).statusCode, 200);
  const c = (await owner('GET', `/courses?patientId=${p.id}`)).json()[0];
  assert.equal(c.lockedAt, null); assert.equal(c.uninvoicedPaise, c.totalPaise, 'billable again');
});
