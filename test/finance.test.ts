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

  assert.equal((await O('GET', '/finance?from=2026-05-02&to=2026-05-01')).status, 400, 'from after to is refused');
  assert.equal((await O('GET', '/finance?from=2024-01-01&to=2026-05-01')).status, 400, 'more than a year is refused');
  assert.equal((await R('GET', '/finance')).status, 403, 'reception does not see the owner figures');
});
