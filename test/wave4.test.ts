// Wave 4: one payment across invoices and modes, EMI waits for settlement, refund needs its own permission, no prices without See fees.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-wave4';
process.env.UPLOAD_DIR = './data/test-uploads-wave4';
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

before(async () => { await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp(); });
after(async () => { await app.close(); });

test('take payment: two invoices, three modes, EMI awaiting settlement, then settled with the lender fee as an expense', async () => {
  const owner = await as('owner@demo.clinic'); const reception = await as('reception@demo.clinic');
  const p = (await reception('POST', '/patients', { fullName: 'Pay Wave4', phone: '9848044411' })).body;
  const c1 = (await reception('POST', '/charges', { patientId: p.id, description: 'Laser sitting 4', amountPaise: 350000 })).body;
  const c2 = (await reception('POST', '/charges', { patientId: p.id, description: 'Peel sitting 2', amountPaise: 80000 })).body;
  const key = 'wave4-take-0001';
  const take = await reception('POST', '/payments/take', { patientId: p.id, chargeIds: [c1.id, c2.id], idempotencyKey: key, parts: [
    { method: 'upi', amountPaise: 230000, reference: '8821' }, { method: 'cash', amountPaise: 100000 }, { method: 'emi', amountPaise: 100000, lender: 'Bajaj Finserv', reference: 'APR-5521' }] });
  assert.equal(take.status, 200, JSON.stringify(take.body));
  assert.equal(take.body.balancePaise, 0);
  const tl = (await owner('GET', `/patients/${p.id}/timeline`)).body;
  assert.equal(tl.outstandingPaise, 0, 'both invoices are paid');
  assert.equal(tl.charges.every((c: any) => c.status === 'paid'), true);
  // the same click twice does not charge twice
  const again = await reception('POST', '/payments/take', { patientId: p.id, chargeIds: [c1.id, c2.id], idempotencyKey: key, parts: [{ method: 'cash', amountPaise: 1 }] });
  assert.equal(again.body.repeated, true);

  // more than due is refused; EMI needs lender and approval code
  const c3 = (await reception('POST', '/charges', { patientId: p.id, description: 'Consult', amountPaise: 50000 })).body;
  assert.equal((await reception('POST', '/payments/take', { patientId: p.id, chargeIds: [c3.id], idempotencyKey: 'wave4-take-0002', parts: [{ method: 'cash', amountPaise: 60000 }] })).status, 400);
  assert.equal((await reception('POST', '/payments/take', { patientId: p.id, chargeIds: [c3.id], idempotencyKey: 'wave4-take-0003', parts: [{ method: 'emi', amountPaise: 50000 }] })).status, 400);
  // a part payment leaves the invoice due with the balance
  const part = await reception('POST', '/payments/take', { patientId: p.id, chargeIds: [c3.id], idempotencyKey: 'wave4-take-0004', parts: [{ method: 'cash', amountPaise: 20000 }] });
  assert.equal(part.body.balancePaise, 30000);
  assert.equal((await owner('GET', `/patients/${p.id}/timeline`)).body.outstandingPaise, 30000, 'the rest of the consult is still due');

  // EMI waits for the bank
  const waiting = (await reception('GET', '/payments/awaiting')).body;
  const emi = waiting.find((w: any) => w.patientId === p.id);
  assert.ok(emi && emi.lender === 'Bajaj Finserv' && emi.amountPaise === 100000, 'one line for the approval even though it paid two invoices');
  assert.equal((await reception('POST', `/payments/${emi.id}/settle`, { feePaise: 200000 })).status, 400, 'the lender cannot keep more than the payment');
  assert.equal((await reception('POST', `/payments/${emi.id}/settle`, { feePaise: 2400, reference: 'UTR 9981' })).status, 200);
  assert.equal((await reception('POST', `/payments/${emi.id}/settle`, {})).status, 409, 'settled once');
  assert.equal((await reception('GET', '/payments/awaiting')).body.some((w: any) => w.id === emi.id), false);
  const ex = (await owner('GET', '/expenses')).body.rows.find((r: any) => r.description.startsWith('EMI fee'));
  assert.ok(ex && ex.amountPaise === 2400, 'the lender fee is an expense');
  assert.equal((await reception('GET', '/payments/awaiting')).body.filter((w: any) => w.patientId === p.id).length, 0, 'every row of that approval is settled');
});

test('refund needs its own permission; junior doctors see no fees', async () => {
  const owner = await as('owner@demo.clinic'); const reception = await as('reception@demo.clinic'); const junior = await as('assistant@demo.clinic');
  const p = (await reception('POST', '/patients', { fullName: 'Refund Wave4', phone: '9848044422' })).body;
  const c = (await reception('POST', '/charges', { patientId: p.id, description: 'Peel', amountPaise: 100000 })).body;
  await reception('POST', '/payments/take', { patientId: p.id, chargeIds: [c.id], idempotencyKey: 'wave4-refund-01', parts: [{ method: 'cash', amountPaise: 100000 }] });
  assert.equal((await reception('POST', `/charges/${c.id}/adjust`, { kind: 'refunded', reason: 'patient declined' })).status, 403, 'the desk cannot refund by default');
  assert.equal((await reception('POST', `/charges/${c.id}/adjust`, { kind: 'waived', reason: 'known person' })).status, 200, 'a waiver keeps its own permission');
  const c2 = (await reception('POST', '/charges', { patientId: p.id, description: 'Peel 2', amountPaise: 100000 })).body;
  assert.equal((await owner('POST', `/charges/${c2.id}/adjust`, { kind: 'refunded', reason: 'patient declined' })).status, 200);

  // the owner can hand the refund permission to the desk
  const set = await owner('PATCH', '/admin/roles/receptionist', { perms: ['fees.see', 'patient.read', 'patient.write', 'appointment.read', 'appointment.write', 'visit.read', 'visit.write', 'visit.queue', 'payment.record', 'payment.waive', 'payment.refund', 'worklist.read', 'worklist.write', 'document.read', 'document.write'] });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  const c3 = (await reception('POST', '/charges', { patientId: p.id, description: 'Peel 3', amountPaise: 100000 })).body;
  const r2 = await as('reception@demo.clinic');
  assert.equal((await r2('POST', `/charges/${c3.id}/adjust`, { kind: 'refunded', reason: 'patient declined' })).status, 200);

  // a junior doctor opens the record and sees no money
  const tl = (await junior('GET', `/patients/${p.id}/timeline`)).body;
  assert.equal(tl.feesHidden, true);
  assert.equal(tl.outstandingPaise, 0); assert.deepEqual(tl.charges, []); assert.deepEqual(tl.payments, []);
  assert.equal((await owner('GET', `/patients/${p.id}/timeline`)).body.charges.length > 0, true);
});

test('invoice menu: cancel only unpaid, exclude from tax reports, discount cap (owner above it), receipt', async () => {
  const owner = await as('owner@demo.clinic');
  assert.equal((await owner('DELETE', '/admin/roles/receptionist')).status, 200, 'back to the standard desk permissions');
  const reception = await as('reception@demo.clinic');
  const p = (await reception('POST', '/patients', { fullName: 'Menu Wave4', phone: '9848044433' })).body;
  const mk = async (d: string, n: number) => (await reception('POST', '/charges', { patientId: p.id, description: d, amountPaise: n })).body;
  const a = await mk('Peel 1', 100000); const b = await mk('Peel 2', 100000); const c = await mk('Peel 3', 100000);

  assert.equal((await reception('POST', `/charges/${a.id}/cancel`, { reason: 'entered by mistake' })).status, 403);
  assert.equal((await owner('POST', `/charges/${a.id}/cancel`, { reason: ' ' })).status, 400, 'a reason is required');
  assert.equal((await owner('POST', `/charges/${a.id}/cancel`, { reason: 'entered by mistake' })).status, 200);
  const take = await reception('POST', '/payments/take', { patientId: p.id, chargeIds: [b.id], idempotencyKey: 'wave4-menu-0001', parts: [{ method: 'cash', amountPaise: 100000 }] });
  assert.match(take.body.receiptNo, /^R-\d{4}$/);
  assert.equal((await owner('POST', `/charges/${b.id}/cancel`, { reason: 'wrong patient' })).status, 409, 'a paid invoice is refunded, not cancelled');

  // exclude from tax reports: kept, flagged, once
  assert.equal((await owner('POST', `/charges/${b.id}/exclude`, { reason: 'duplicate cash bill' })).status, 200);
  assert.equal((await owner('POST', `/charges/${b.id}/exclude`, { reason: 'again please' })).status, 409);
  const tl = (await owner('GET', `/patients/${p.id}/timeline`)).body;
  assert.ok(tl.charges.find((x: any) => x.id === b.id).excludedAt);
  assert.equal(tl.charges.find((x: any) => x.id === a.id).status, 'cancelled');

  // receipt carries everything taken together
  const rc = (await reception('GET', `/receipts/${take.body.receiptNo}`)).body;
  assert.equal(rc.totalPaise, 100000); assert.equal(rc.lines[0].description, 'Peel 2'); assert.equal(rc.patient.fullName, 'Menu Wave4');

  // discount: not without the permission; within the cap with it; above the cap only the owner
  assert.equal((await reception('POST', `/charges/${c.id}/discount`, { amountPaise: 5000, reason: 'known person' })).status, 403);
  assert.equal((await owner('PATCH', '/admin/roles/receptionist', { perms: ['fees.see', 'patient.read', 'patient.write', 'appointment.read', 'appointment.write', 'visit.read', 'visit.write', 'visit.queue', 'payment.record', 'payment.waive', 'discount.give', 'worklist.read', 'worklist.write', 'document.read', 'document.write'] })).status, 200);
  const r2 = await as('reception@demo.clinic');
  assert.equal((await r2('POST', `/charges/${c.id}/discount`, { amountPaise: 8000, reason: 'known person' })).status, 200, '8% is within the 10% cap');
  const over = await r2('POST', `/charges/${c.id}/discount`, { amountPaise: 8000, reason: 'asked again' });
  assert.equal(over.status, 403); assert.equal(over.body.capPct, 10);
  assert.equal((await owner('POST', `/charges/${c.id}/discount`, { amountPaise: 8000, reason: 'owner agreed' })).status, 200);
  assert.equal((await owner('PATCH', '/admin/clinic', { settings: { discountCapPct: 200 } })).status, 400);
  const cur = (await owner('GET', `/patients/${p.id}/timeline`)).body.charges.find((x: any) => x.id === c.id);
  assert.equal(cur.amountPaise, 84000); assert.equal(cur.discountPaise, 16000);
  assert.equal((await r2('POST', `/charges/${c.id}/discount`, { amountPaise: 84000, reason: 'whole thing' })).status, 400, 'a whole-amount discount is a waiver');
});
