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
