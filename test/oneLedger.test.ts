// One money model: the Dashboard, Reports (daily), End of day and the owner's Clinic page show the same "Collected" for a day
// with a consultation, a procedure sitting, a pharmacy sale and a refund. A pharmacy return is not restocked unless the caller says so.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-oneledger';
process.env.UPLOAD_DIR = './data/test-uploads-oneledger';
process.env.COOKIE_SECRET = 'test-secret';
rmSync(process.env.PGLITE_DIR, { recursive: true, force: true });

const { migrate, applyRls } = await import('../src/db/index.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { buildApp } = await import('../src/app.js');

let app: Awaited<ReturnType<typeof buildApp>>;
const login = async (email: string) => (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenant: 'sahitya' } })).cookies.find((c) => c.name === 'cc_session')!.value;
const as = (c: string) => async (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) => { const r = await app.inject({ method, url: '/api' + url, cookies: { cc_session: c }, payload: payload as any }); return { status: r.statusCode, body: r.body ? r.json() : null }; };
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const ym = (months: number) => { const d = new Date(); d.setUTCMonth(d.getUTCMonth() + months); return d.toISOString().slice(0, 7); };
before(async () => { await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp(); });
after(async () => { await app.close(); });

test('Dashboard, Reports, End of day and the Clinic page agree: consult, sitting, pharmacy, refund', async () => {
  const O = as(await login('owner@demo.clinic')); const R = as(await login('reception@demo.clinic')); const P = as(await login('pharmacy@demo.clinic'));
  const cfg = (await O('GET', '/config')).body;
  const doc = cfg.practitioners[0];

  // a consultation paid by UPI, later refunded
  const p1 = (await R('POST', '/patients', { fullName: 'Ledger Consult', phone: '9848066001' })).body;
  const v1 = await R('POST', '/visits', { patientId: p1.id, feeCategoryCode: 'GEN', practitionerId: doc.id, payment: { method: 'upi', amountPaise: 30000, reference: '9988' }, idempotencyKey: 'ledger-v1' });
  assert.equal(v1.status, 200, JSON.stringify(v1.body));
  // a second consultation, kept
  const p2 = (await R('POST', '/patients', { fullName: 'Ledger Kept', phone: '9848066002' })).body;
  assert.equal((await R('POST', '/visits', { patientId: p2.id, feeCategoryCode: 'GEN', practitionerId: doc.id, payment: { method: 'cash', amountPaise: 30000 }, idempotencyKey: 'ledger-v2' })).status, 200);

  // a procedure sitting with no course: billed at list price, paid at the desk
  const peel = cfg.procedures.find((x: any) => x.name === 'Chemical peel');
  const e = (await O('POST', `/visits/${(await O('GET', '/frontdesk')).body.visits.find((x: any) => x.patient.id === p2.id).id}/encounter`, {})).body;
  await O('PATCH', `/encounters/${e.id}`, { data: { complaint: { chief_complaint: ['Acne'] }, assessment: { diagnosis: [{ name: 'Acne' }] } }, complete: true, recommendations: [{ kind: 'procedure', procedureId: peel.id, sittings: 1 }] });
  const rec = (await O('GET', '/worklist?kind=procedure')).body.find((r: any) => r.patientId === p2.id);
  const ps = (await R('POST', '/procedure-sessions', { recommendationId: rec.id, day: today(), startTime: '10:00', minutes: 30, practitionerId: doc.id, force: true })).body;
  assert.equal((await R('PATCH', `/procedure-sessions/${ps.id}`, { state: 'completed' })).status, 200);
  const sit = (await O('GET', `/patients/${p2.id}/timeline`)).body.charges.find((c: any) => /Chemical peel sitting/.test(c.description));
  assert.equal((await R('POST', '/payments', { patientId: p2.id, chargeId: sit.id, amountPaise: sit.amountPaise, method: 'cash', idempotencyKey: 'ledger-sit' })).status, 200);

  // a pharmacy sale, and a return the caller does not mark as sealed
  const cet = cfg.medicines.find((m: any) => m.name === 'Cetirizine 10 mg');
  assert.equal((await P('POST', '/stock/receipts', { lines: [{ medicineId: cet.id, qty: 20, ratePaise: 1000, batchNo: 'L1', expiry: ym(18) }] })).status, 200);
  const sale = await P('POST', '/pharmacy/sale', { walkIn: {}, items: [{ medicineId: cet.id, qty: 2 }], method: 'cash' });
  assert.equal(sale.status, 200, JSON.stringify(sale.body));
  const onHand = async () => (await P('GET', `/stock/medicines/${cet.id}`)).body.onHand;
  const before = await onHand();
  const ret = await P('POST', `/pharmacy/sale/${sale.body.id}/return`, { lines: [{ line: 0, qty: 1 }], reason: 'Patient brought it back', method: 'cash' });
  assert.equal(ret.status, 200, JSON.stringify(ret.body));
  assert.equal(await onHand(), before, 'restock not sent: written off, not back on the shelf');

  // the refund
  assert.equal((await O('POST', `/charges/${v1.body.charge.id}/adjust`, { kind: 'refunded', reason: 'Left without consultation' })).status, 200);

  const eod = (await O('GET', '/dayclose')).body.money.total.total;
  const daily = (await O('GET', '/reports/daily')).body.totals.collectedPaise;
  const dash = (await O('GET', `/dashboard?from=${today()}&to=${today()}`)).body;
  const clinic = (await O('GET', '/owner/summary')).body.todayMoney.total.total;
  assert.ok(eod > 0);
  assert.equal(daily, eod, 'Reports = End of day');
  assert.equal(dash.collected.totalPaise, eod, 'Dashboard = End of day');
  assert.equal(clinic, eod, 'Clinic page = End of day');
  assert.equal(dash.tiles.reduce((s: number, t: any) => s + (t.paidPaise ?? 0), 0) + dash.collected.notTiedPaise, eod, 'doctor tiles plus the rest add up to the total');
  const mine = dash.tiles.find((t: any) => t.id === doc.id);
  assert.ok(mine.paidPaise >= 30000 + sit.amountPaise, 'the kept consult and the sitting count for the doctor; the refunded one does not');

  // a doctor sees no clinic total
  const D = as(await login('doctor2@demo.clinic'));
  assert.equal((await D('GET', `/dashboard?from=${today()}&to=${today()}`)).body.collected, null);
});
