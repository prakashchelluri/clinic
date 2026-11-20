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
  // the printed invoice: as issued, with its credit note; the payment, and the same money moved off it to the advance (the refund left from there)
  const v = (await owner('GET', `/bills/${bill.id}`)).json();
  assert.equal(v.rows[0].amountPaise, total, 'as issued'); assert.equal(v.rows[0].creditedPaise, 300000); assert.equal(v.creditNotes.length, 1);
  assert.equal(v.payments.filter((x: any) => x.kind === 'paid').length, 1); assert.equal(v.payments.filter((x: any) => x.kind === 'moved').reduce((s: number, x: any) => s + x.amountPaise, 0), -300000);
  const acc = (await owner('GET', `/patients/${p.id}/account`)).json();
  assert.ok(acc.activity.find((a: any) => a.type === 'refund' && a.receiptNo?.startsWith('RF-') && a.amountPaise === 300000), 'a refund voucher');
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
  assert.equal(v.rows[0].amountPaise, total, 'printed as issued'); assert.equal(v.rows[0].creditedPaise, total, 'a credit note for all of it'); assert.equal(v.status, 'credited');
  assert.equal(v.payments.filter((x: any) => x.kind === 'moved').reduce((s: number, x: any) => s + x.amountPaise, 0), -400000, 'what was paid moved to the advance');
  assert.equal((await owner('GET', `/patients/${p.id}/account`)).json().totals.refundedPaise, 0, 'not a refund');
  balanced((await owner('GET', `/patients/${p.id}/account`)).json().totals);
});

test('Q1: the pharmacy login handles medicines only: no clinic billing, no patient accounts, no payments', async () => {
  const owner = await as('owner@demo.clinic'); const pharmacy = await as('pharmacy@demo.clinic');
  const p = (await owner('POST', '/patients', { fullName: 'QA Pharmacy', phone: '9848077807' })).json();
  assert.equal((await pharmacy('GET', `/bills?from=${today()}&to=${today()}`)).statusCode, 403, 'no clinic Billing page');
  assert.equal((await pharmacy('GET', `/patients/${p.id}/account`)).statusCode, 403, 'no patient account');
  assert.equal((await pharmacy('POST', `/patients/${p.id}/payments`, { amountPaise: 100, method: 'cash', idempotencyKey: key() })).statusCode, 403, 'no Record payment');
  assert.equal((await pharmacy('GET', '/pharmacy/counter')).statusCode, 200, 'the counter still works');
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

// The fresh-database report of 16 Nov 2026 (docs/qa-billing-fresh-2026-11-16.md), highs H1 and H4 (H2, H3 and M1 are in invoices.test.ts and moneyFuzz.test.ts).
test('fresh H1: a discount at Collect on an issued invoice is a credit note; the invoice prints as issued', async () => {
  const owner = await as('owner@demo.clinic');
  const cfg = (await owner('GET', '/config')).json(); const biopsy = cfg.procedures.find((x: any) => x.name === 'Excision biopsy');
  const p = (await owner('POST', '/patients', { fullName: 'QA Collect discount', phone: '9848077811' })).json();
  assert.equal((await owner('POST', '/bills', { patientId: p.id, idempotencyKey: key(), lines: [{ procedureId: biopsy.id }] })).statusCode, 200);
  const b = (await owner('GET', `/patients/${p.id}/bills`)).json().bills[0];
  const r = await owner('POST', '/bills', { patientId: p.id, idempotencyKey: key(), lines: [{ chargeId: b.lines[0].id, discountPaise: 30000 }], reason: 'Known patient', parts: [{ method: 'cash', amountPaise: 270000 }] });
  assert.equal(r.statusCode, 200, r.body);
  const v = (await owner('GET', `/bills/${b.id}`)).json();
  assert.equal(v.rows[0].amountPaise, 300000, 'the invoice as issued'); assert.equal(v.creditNotes.length, 1); assert.equal(v.creditedPaise, 30000); assert.equal(v.duePaise, 0);
  // and the database itself refuses any change to an issued line, whatever code tries it
  const { withTenant } = await import('../src/db/index.js'); const { sql } = await import('drizzle-orm');
  await assert.rejects(withTenant(p.tenantId, '00000000-0000-4000-8000-000000000000', (tx: any) => tx.execute(sql`update charge set amount_paise = 1 where id = ${b.lines[0].id}`)), (e: any) => /ISSUED_INVOICE_LINE_IS_FROZEN/.test(String(e?.cause?.message ?? e?.message)));
  await assert.rejects(withTenant(p.tenantId, '00000000-0000-4000-8000-000000000000', (tx: any) => tx.execute(sql`update charge set discount_paise = 1 where id = ${b.lines[0].id}`)), (e: any) => /ISSUED_INVOICE_LINE_IS_FROZEN/.test(String(e?.cause?.message ?? e?.message)));
});

test('fresh H4: sessions cut and then added back are billed, never free', async () => {
  const owner = await as('owner@demo.clinic');
  const { peel, p, rec } = await treatment(owner, 'QA Add back', '9848077812', 4);
  assert.equal((await owner('POST', '/bills', { patientId: p.id, idempotencyKey: key(), lines: [{ recommendationId: rec.id }], parts: [{ method: 'cash', amountPaise: peel.pricePaise * 3 }] })).statusCode, 200);
  const cut = (await owner('PATCH', '/procedure-plans/edit', { plans: [{ id: rec.id, sittings: 2 }] })).json();
  assert.equal(cut[0].toAdvancePaise, peel.pricePaise, '3 paid, 2 kept: one session to the advance');
  assert.equal((await owner('PATCH', '/procedure-plans/edit', { plans: [{ id: rec.id, sittings: 3 }] })).statusCode, 200);
  const c = (await owner('GET', `/courses?patientId=${p.id}`)).json()[0];
  assert.equal(c.invoicedSessions, 2); assert.equal(c.uninvoicedSessions, 1); assert.equal(c.uninvoicedPaise, peel.pricePaise, 'the added session has its price');
  const inv = (await owner('POST', '/bills', { patientId: p.id, idempotencyKey: key(), lines: [{ recommendationId: rec.id }], parts: [{ method: 'advance', amountPaise: peel.pricePaise }] })).json();
  assert.equal(inv.payablePaise, peel.pricePaise); assert.equal(inv.balancePaise, 0, 'paid from the advance it left');
  const t = (await owner('GET', `/patients/${p.id}/account`)).json().totals; assert.equal(t.advancePaise, 0); balanced(t);
});

// Round 5 (docs/qa-billing-r5-2026-11-16.md)
async function twoItems(owner: any, name: string, phone: string) {
  const cfg = (await owner('GET', '/config')).json();
  const exc = cfg.procedures.find((x: any) => x.name === 'Excision biopsy'); const inj = cfg.procedures.find((x: any) => /injection/i.test(x.name));
  const p = (await owner('POST', '/patients', { fullName: name, phone })).json();
  assert.equal((await owner('POST', '/bills', { patientId: p.id, idempotencyKey: key(), lines: [{ procedureId: exc.id }, { procedureId: inj.id }], parts: [{ method: 'upi', amountPaise: 100000, reference: '11' }] })).statusCode, 200);
  const b = (await owner('GET', `/patients/${p.id}/bills`)).json().bills[0];
  return { p, b, exc: b.lines.find((c: any) => c.description === exc.name), inj: b.lines.find((c: any) => c.description === inj.name) };
}

test('r5 H1 + H2: a refund gives back only money paid on the items named; an item not given is taken off with a credit note and no cash', async () => {
  const owner = await as('owner@demo.clinic');
  const { p, b, exc, inj } = await twoItems(owner, 'QA Take off', '9848077821');
  assert.equal(b.paidOn[exc.id], 100000, 'the payment went to the first line'); assert.equal(b.paidOn[inj.id] ?? 0, 0);
  const r = await owner('POST', `/bills/${b.id}/refund`, { parts: [{ method: 'cash', amountPaise: 100000 }], lines: [{ chargeId: inj.id, amountPaise: 100000 }], reason: 'Injection not given' });
  assert.equal(r.json().code, 'MORE_THAN_PAID_ON_THE_ITEM', 'no cash back for an item nobody paid for');
  const off = (await owner('POST', `/bills/${b.id}/credit`, { lines: [{ chargeId: inj.id, amountPaise: inj.amountPaise }], reason: 'Injection not given', idempotencyKey: key() })).json();
  assert.ok(off.creditNo); assert.equal(off.toAdvancePaise, 0, 'nothing was paid on it, so nothing moves');
  const v = (await owner('GET', `/bills/${b.id}`)).json();
  assert.equal(v.paidOn[exc.id], 100000, 'the excision keeps its payment'); assert.equal(v.duePaise, exc.amountPaise - 100000, 'only the excision is still owed');
  const t = (await owner('GET', `/patients/${p.id}/account`)).json().totals; assert.equal(t.refundedPaise, 0, 'no money went back'); balanced(t);
});

test('r5 H3: EMI never more than is due, and EMI the lender has not paid is never refunded', async () => {
  const owner = await as('owner@demo.clinic');
  const { p, b, exc } = await twoItems(owner, 'QA Emi', '9848077822');
  const owed = (await owner('GET', `/patients/${p.id}/account`)).json().totals.collectablePaise;
  const over = await owner('POST', `/patients/${p.id}/payments`, { amountPaise: owed + 200000, method: 'emi', reference: 'AP1', lender: 'Bajaj', idempotencyKey: key() });
  assert.equal(over.json().code, 'EMI_MORE_THAN_DUE');
  assert.equal((await owner('POST', `/patients/${p.id}/payments`, { amountPaise: owed, method: 'emi', reference: 'AP2', lender: 'Bajaj', idempotencyKey: key() })).statusCode, 200);
  // the excision taken off: its EMI money moves to the advance, and cannot go back until the lender pays
  const v = (await owner('GET', `/bills/${b.id}`)).json();
  const left = exc.amountPaise - (v.creditedOn[exc.id] ?? 0);
  assert.equal((await owner('POST', `/bills/${b.id}/credit`, { lines: [{ chargeId: exc.id, amountPaise: left }], reason: 'Not done' })).statusCode, 200);
  const acc = (await owner('GET', `/patients/${p.id}/account`)).json().totals; assert.ok(acc.advancePaise > 0); assert.ok(acc.emiHeldPaise > 0);
  const out = await owner('POST', `/patients/${p.id}/advance/refund`, { amountPaise: acc.advancePaise, method: 'cash', reason: 'Wants it back' });
  assert.equal(out.json().code, 'EMI_NOT_SETTLED');
  const emi = (await owner('GET', '/payments/awaiting')).json().find((x: any) => x.reference === 'AP2');
  assert.equal((await owner('POST', `/payments/${emi.id}/settle`, { feePaise: 0 })).statusCode, 200);
  assert.equal((await owner('POST', `/patients/${p.id}/advance/refund`, { amountPaise: acc.advancePaise, method: 'cash', reason: 'Wants it back' })).statusCode, 200, 'once the lender has paid');
  balanced((await owner('GET', `/patients/${p.id}/account`)).json().totals);
});

test('r5 H5: Accounts "Given back" lists only money that went back', async () => {
  const owner = await as('owner@demo.clinic');
  const fin = (await owner('GET', `/finance?from=${today()}&to=${today()}`)).json();
  for (const g of fin.givenBack.filter((x: any) => x.kind === 'refund')) assert.notEqual(g.method, 'advance', 'a move into or out of the advance is not money back');
});

test('r5 roles: doctors see no invoices or accounts; the coordinator sees them and takes payments', async () => {
  const owner = await as('owner@demo.clinic'); const doc = await as('doctor2@demo.clinic'); const coord = await as('procedures@demo.clinic');
  const { p, b } = await twoItems(owner, 'QA Roles', '9848077823');
  assert.equal((await doc('GET', `/bills?from=${today()}&to=${today()}`)).statusCode, 403);
  assert.equal((await doc('GET', `/bills/${b.id}`)).statusCode, 403);
  assert.equal((await doc('GET', `/patients/${p.id}/account`)).statusCode, 403);
  const tl = (await doc('GET', `/patients/${p.id}/timeline`)).json(); assert.deepEqual(tl.charges, []); assert.equal(tl.outstandingPaise, 0);
  assert.equal((await coord('GET', `/patients/${p.id}/account`)).statusCode, 200);
  assert.equal((await coord('POST', `/patients/${p.id}/payments`, { amountPaise: 1000, method: 'cash', idempotencyKey: key() })).statusCode, 200);
});

test('r5 M2: sessions taken off come off at their own line price, newest first; a done session keeps its invoiced price', async () => {
  const owner = await as('owner@demo.clinic');
  const { peel, p, rec } = await treatment(owner, 'QA Line price', '9848077824', 3);
  const disc = Math.round(peel.pricePaise * 3 * 0.05);
  assert.equal((await owner('POST', '/bills', { patientId: p.id, idempotencyKey: key(), lines: [{ recommendationId: rec.id, discountPaise: disc }], reason: 'Five percent', parts: [{ method: 'cash', amountPaise: peel.pricePaise * 3 - disc }] })).statusCode, 200);
  assert.equal((await owner('PATCH', '/procedure-plans/edit', { plans: [{ id: rec.id, sittings: 4 }] })).statusCode, 200);
  assert.equal((await owner('POST', '/bills', { patientId: p.id, idempotencyKey: key(), lines: [{ recommendationId: rec.id }], parts: [{ method: 'cash', amountPaise: peel.pricePaise }] })).statusCode, 200);
  const cancel = (await owner('POST', '/procedure-plans/cancel', { ids: [rec.id], reason: 'Stopped' })).json();
  // nothing done: all four sessions come off, each at its own price (3 at the discounted price, 1 at the standard price)
  assert.equal(cancel.toAdvancePaise, peel.pricePaise * 4 - disc, 'everything paid moves to the advance');
  for (const b of (await owner('GET', `/patients/${p.id}/bills`)).json().bills) assert.equal(b.creditedPaise % 100, 0, `whole rupees on ${b.invoiceNo}`);
  balanced((await owner('GET', `/patients/${p.id}/account`)).json().totals);
});
