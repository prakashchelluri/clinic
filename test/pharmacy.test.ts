// Pharmacy counter sale without a prescription, and the history that lists it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-pharmacy';
process.env.UPLOAD_DIR = './data/test-uploads-pharmacy';
process.env.COOKIE_SECRET = 'test-secret';
rmSync(process.env.PGLITE_DIR, { recursive: true, force: true });

const { migrate, applyRls } = await import('../src/db/index.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { buildApp } = await import('../src/app.js');

let app: Awaited<ReturnType<typeof buildApp>>;
const login = async (email: string) => (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenant: 'sahitya' } })).cookies.find((c) => c.name === 'cc_session')!.value;
before(async () => { await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp(); });
after(async () => { await app.close(); });

test('counter sale: catalogue prices with GST, patient required, reference for UPI/card, invoice numbers, history', async () => {
  const owner = await login('owner@demo.clinic');
  const call = (method: 'GET' | 'POST', url: string, payload?: unknown) => app.inject({ method, url: '/api' + url, cookies: { cc_session: owner }, payload: payload as any });
  const meds = (await call('GET', '/config')).json().medicines as any[];
  const sun = meds.find((m) => m.name === 'Sunscreen SPF 50'); const cet = meds.find((m) => m.name === 'Cetirizine 10 mg');
  assert.ok(sun.mrpPaise > 0 && sun.gstBp === 1800, 'prices live in the catalogue');
  const cust = { fullName: 'Test Customer', phone: '9876500001' };
  const ok = { newPatient: cust, items: [{ medicineId: sun.id, qty: 2 }, { medicineId: cet.id, qty: 10 }], method: 'cash' };

  assert.equal((await call('POST', '/pharmacy/sale', { ...ok, newPatient: undefined })).statusCode, 400, 'a patient is required');
  assert.equal((await call('POST', '/pharmacy/sale', { ...ok, newPatient: { fullName: 'X', phone: '12' } })).statusCode, 400, 'name and 10-digit phone');
  assert.equal((await call('POST', '/pharmacy/sale', { ...ok, items: [] })).statusCode, 400, 'no items');
  assert.equal((await call('POST', '/pharmacy/sale', { ...ok, items: [{ medicineId: sun.id, qty: 0 }] })).statusCode, 400, 'zero quantity');
  assert.equal((await call('POST', '/pharmacy/sale', { ...ok, method: 'upi' })).statusCode, 400, 'UPI needs a reference');
  assert.equal((await call('POST', '/pharmacy/sale', { ...ok, method: 'card', reference: 'ab' })).statusCode, 400, 'reference too short');
  assert.equal((await call('POST', '/pharmacy/sale', { ...ok, discountPaise: 99999999 })).statusCode, 400, 'discount above the bill');
  assert.equal((await call('POST', '/pharmacy/sale', { ...ok, receivedPaise: 100 })).statusCode, 400, 'cash received below the total');

  const gross = 2 * sun.mrpPaise + 10 * cet.mrpPaise;
  const sale = await call('POST', '/pharmacy/sale', { ...ok, receivedPaise: 200000 });
  assert.equal(sale.statusCode, 200, sale.body);
  const s1 = sale.json();
  assert.equal(s1.invoiceNo, 'PH-00001'); assert.equal(s1.totalPaise, gross); assert.equal(s1.grossPaise, gross);
  const expectGst = (a: number, bp: number) => a - Math.round((a * 10000) / (10000 + bp));
  assert.equal(s1.gstPaise, expectGst(2 * sun.mrpPaise, 1800) + expectGst(10 * cet.mrpPaise, 1200), 'GST contained in the prices');

  const s2 = (await call('POST', '/pharmacy/sale', { ...ok, items: [{ medicineId: cet.id, qty: 1 }], method: 'upi', reference: 'UPI123456', discountPaise: 100 })).json();
  assert.equal(s2.invoiceNo, 'PH-00002'); assert.equal(s2.totalPaise, cet.mrpPaise - 100); assert.equal(s2.reference, 'UPI123456');
  const pts = (await call('GET', '/patients?q=9876500001')).json(); assert.equal(pts.length, 1, 'same customer is not registered twice');

  const h = (await call('GET', '/pharmacy/history')).json();
  assert.equal(h.rows.length, 2); assert.deepEqual(h.rows.map((r: any) => r.invoiceNo).sort(), ['PH-00001', 'PH-00002']);
  assert.equal(h.totals.total, s1.totalPaise + s2.totalPaise); assert.equal(h.totals.gst, s1.gstPaise + s2.gstPaise);
  assert.equal(h.rows.find((r: any) => r.invoiceNo === 'PH-00002').reference, 'UPI123456');
  assert.equal((await call('GET', '/pharmacy/history?q=PH-00002')).json().rows.length, 1, 'search by invoice number');
  const r = (await call('GET', `/pharmacy/sale/${s1.id}`)).json(); assert.equal(r.patient.fullName, 'Test Customer'); assert.equal(r.items.length, 2); assert.ok(r.clinic.name);
  assert.equal((await call('GET', '/pharmacy/history?from=garbage')).statusCode, 400);
});
