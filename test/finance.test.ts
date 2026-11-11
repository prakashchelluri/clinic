// The owner's Accounts page: income over a range is the same ledger as End of day, expenses and dues line up, and only finance.read sees it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-finance';
process.env.COOKIE_SECRET = 'test-secret';
rmSync(process.env.PGLITE_DIR, { recursive: true, force: true });

const { migrate, applyRls } = await import('../src/db/index.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { buildApp } = await import('../src/app.js');

let app: Awaited<ReturnType<typeof buildApp>>;
const login = async (email: string) => (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenant: 'sahitya' } })).cookies.find((c) => c.name === 'cc_session')!.value;
before(async () => { await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp(); });
after(async () => { await app.close(); });
const as = (c: string) => async (method: 'GET' | 'POST', url: string, payload?: unknown) => { const r = await app.inject({ method, url: '/api' + url, cookies: { cc_session: c }, payload: payload as any }); return { status: r.statusCode, body: r.body ? r.json() : null }; };

test('accounts: income matches End of day, expenses and dues line up, reception cannot read it', async () => {
  const O = as(await login('owner@demo.clinic')); const R = as(await login('reception@demo.clinic'));
  const p = (await R('POST', '/patients', { fullName: 'Accounts Range One', phone: '9848077011' })).body;
  const v = await R('POST', '/visits', { patientId: p.id, feeCategoryCode: 'GEN', payment: { method: 'upi', amountPaise: 10000 }, idempotencyKey: 'fin-1' });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  const e = await R('POST', '/expenses', { description: 'Water cans', amountPaise: 16000, method: 'cash', category: 'Electricity and water' });
  assert.equal(e.status, 200, JSON.stringify(e.body));

  const f = await O('GET', '/finance');
  assert.equal(f.status, 200, JSON.stringify(f.body));
  const eod = (await O('GET', '/dayclose')).body;
  const todayRow = f.body.days.find((d: any) => d.day === f.body.today);
  assert.ok(todayRow, 'today is listed');
  assert.equal(todayRow.money.total.total, eod.money.total.total, 'a day on Accounts shows the same money as its End of day');
  assert.equal(todayRow.money.consultation.total, eod.money.consultation.total);
  assert.ok(todayRow.expensesPaise >= 16000, 'the expense is on its day');
  assert.equal(f.body.outPaise, f.body.expenses.rows.reduce((s: number, r: any) => s + r.amountPaise, 0), 'went out is the sum of the expense rows');
  assert.equal(f.body.income.total.total, f.body.days.reduce((s: number, d: any) => s + (d.money?.total.total ?? 0), 0), 'the total is the sum of the days');
  const owe = f.body.owed.patients.find((o: any) => o.patientId === p.id);
  assert.ok(owe && owe.totalPaise > 0, 'the part-paid fee is still owed');
  assert.ok(f.body.prevFrom < f.body.from && f.body.prevTo < f.body.from, 'the comparison period is before the period');

  // a pharmacy sale and a return count once, as pharmacy, not again as "other" through the bill's payment rows
  const P = as(await login('pharmacy@demo.clinic'));
  const cet = (await O('GET', '/config')).body.medicines.find((m: any) => m.name === 'Cetirizine 10 mg');
  const exp = new Date(); exp.setUTCMonth(exp.getUTCMonth() + 18);
  assert.equal((await P('POST', '/stock/receipts', { lines: [{ medicineId: cet.id, qty: 20, ratePaise: 1000, batchNo: 'F1', expiry: exp.toISOString().slice(0, 7) }] })).status, 200);
  const before = (await O('GET', '/dayclose')).body.money;
  const sale = await P('POST', '/pharmacy/sale', { walkIn: {}, items: [{ medicineId: cet.id, qty: 2 }], method: 'cash' });
  assert.equal(sale.status, 200, JSON.stringify(sale.body));
  const ret = await P('POST', `/pharmacy/sale/${sale.body.id}/return`, { lines: [{ line: 0, qty: 1 }], reason: 'Patient brought it back', method: 'cash' });
  assert.equal(ret.status, 200, JSON.stringify(ret.body));
  const after = (await O('GET', '/dayclose')).body.money;
  const net = sale.body.totalPaise - ret.body.refundPaise;
  assert.equal(after.pharmacy.total - before.pharmacy.total, net, 'pharmacy is up by the sale less the return');
  assert.equal(after.other.total, before.other.total, 'the bill does not count a second time as other');
  assert.equal(after.total.total - before.total.total, net, 'the day total moves by the sale once');
  const f2 = (await O('GET', '/finance')).body;
  assert.ok(f2.pharmacy.soldPaise >= net && f2.pharmacy.costPaise >= 1000, 'the margin card has the sale and its batch cost');

  assert.equal((await O('GET', '/finance?from=2026-05-02&to=2026-05-01')).status, 400, 'from after to is refused');
  assert.equal((await O('GET', '/finance?from=2024-01-01&to=2026-05-01')).status, 400, 'more than a year is refused');
  assert.equal((await R('GET', '/finance')).status, 403, 'reception does not see the owner figures');
});
