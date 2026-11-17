// Reports to download (Tatva's Reports page): who may download what, every download audited, and the money files agreeing with End of day.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-reportfiles';
process.env.COOKIE_SECRET = 'test-secret';
rmSync(process.env.PGLITE_DIR, { recursive: true, force: true });

const { migrate, applyRls } = await import('../src/db/index.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { buildApp } = await import('../src/app.js');

let app: Awaited<ReturnType<typeof buildApp>>;
const login = async (email: string) => (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenant: 'sahitya' } })).cookies.find((c) => c.name === 'cc_session')!.value;
const as = (c: string) => async (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => { const r = await app.inject({ method, url: '/api' + url, cookies: { cc_session: c }, payload: payload as any }); return { status: r.statusCode, body: r.body ? r.json() : null }; };
before(async () => { await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp(); });
after(async () => { await app.close(); });

const ALL = ['daily', 'collection', 'threec', 'billing', 'appointments', 'rx', 'rxlines', 'pharmacy', 'procedures'];
const rupees = (s: unknown) => Math.round(Number(s) * 100);

test('owner: every report downloads with its header, each audited; the money ones agree with End of day', async () => {
  const R = as(await login('reception@demo.clinic')); const O = as(await login('owner@demo.clinic'));
  const p = (await R('POST', '/patients', { fullName: 'Report File One', phone: '9848077001' })).body;
  const v = (await R('POST', '/visits', { patientId: p.id, feeCategoryCode: 'GEN', payment: { method: 'upi', amountPaise: 30000 } })).body;
  const q = (await R('POST', '/patients', { fullName: 'Report File Two', phone: '9848077002' })).body;
  await R('POST', '/visits', { patientId: q.id, feeCategoryCode: 'GEN', payment: { method: 'cash', amountPaise: 30000 } });
  assert.equal((await O('POST', `/charges/${v.charge.id}/adjust`, { kind: 'refunded', reason: 'Left without consultation' })).status, 200);

  const cat = (await O('GET', '/reports/files')).body;
  assert.deepEqual([...cat.kinds].sort(), [...ALL].sort()); assert.equal(cat.canExport, true); assert.ok(cat.doctors.length >= 2); assert.ok(cat.staff.length >= 2);

  const day = (await O('GET', '/dayclose')).body.day; const eod = (await O('GET', '/dayclose')).body.money.total;
  const range = `from=${day}&to=${day}`;
  // daily: every receipt and refund listed; the total line is End of day's Collected
  const daily = (await O('GET', `/reports/files/daily?day=${day}`)).body;
  assert.equal(daily.rows[0][0], 'Time');
  const lines = daily.rows.slice(1, daily.rows.findIndex((r: unknown[]) => r.length === 0));
  assert.ok(lines.some((r: any[]) => r[3] === 'Report File One' && r[6] === 'Refund' && rupees(r[8]) === -30000), 'the refund is its own row, negative');
  assert.equal(rupees(daily.rows.at(-1)[5]), eod.total, 'Collected = End of day');
  assert.equal(lines.reduce((s: number, r: any[]) => s + rupees(r[8]), 0), eod.total, 'the rows add up to Collected');

  // collection: general, day-wise and detailed all give the same total
  const gen = (await O('GET', `/reports/files/collection?${range}`)).body;
  assert.equal(rupees(gen.rows.at(-1)[5]), eod.total);
  assert.equal(rupees(gen.rows.at(-1)[2]), eod.upi, 'UPI column nets the UPI refund');
  const dw = (await O('GET', `/reports/files/collection?${range}&type=daywise`)).body;
  assert.equal(rupees(dw.rows.at(-1)[9]), eod.total);
  const det = (await O('GET', `/reports/files/collection?${range}&type=detailed`)).body;
  assert.equal(rupees(det.rows.at(-1)[10]), eod.total);
  const cashOnly = (await O('GET', `/reports/files/collection?${range}&type=detailed&mode=cash`)).body;
  assert.ok(cashOnly.rows.slice(1, -2).every((r: any[]) => r[9] === 'Cash'), 'mode filter');
  const deskId = cat.staff.find((s: any) => s.name.includes('Reception')).id;
  const byDesk = (await O('GET', `/reports/files/collection?${range}&type=detailed&by=${deskId}`)).body;
  assert.ok(byDesk.count >= 2 && byDesk.rows.slice(1, -2).every((r: any[]) => r[12].includes('Reception')), 'taken-by filter');

  // 3C: cash memos, invoices and the credit note for the refund
  const c3 = (await O('GET', `/reports/files/threec?${range}`)).body;
  const docs = new Set(c3.rows.slice(1).map((r: any[]) => r[0]));
  for (const d of ['Cash memo', 'Invoice', 'Credit note']) assert.ok(docs.has(d), d);
  const credit = (await O('GET', `/reports/files/threec?${range}&type=credit`)).body;
  assert.ok(credit.rows.slice(1).every((r: any[]) => r[0] === 'Credit note') && credit.count >= 1);

  // billing: revenue lists the refunded line as Refunded; cash flow's money in = Collected
  const rev = (await O('GET', `/reports/files/billing?${range}`)).body;
  assert.ok(rev.rows.some((r: any[]) => r[2] === 'Report File One' && r[11] === 'Refunded'));
  const cf = (await O('GET', `/reports/files/billing?${range}&type=cashflow`)).body;
  assert.equal(rupees(cf.rows.at(-1)[1]), eod.total);

  for (const k of ['appointments', 'rx', 'rxlines', 'pharmacy', 'procedures']) {
    const r = await O('GET', `/reports/files/${k}?${range}`); assert.equal(r.status, 200, k); assert.ok(r.body.rows[0].length > 3, k);
  }
  for (const t of ['detailed', 'doctor']) assert.equal((await O('GET', `/reports/files/appointments?${range}&type=${t}`)).status, 200);
  const audit = (await O('GET', '/audit?kind=print')).body;
  assert.ok(audit.some((a: any) => a.action === 'report.downloaded' && a.summary.includes('Daily collection')), 'downloads are in the audit log');
});

test('period rules: needed, in order, at most a year; unknown report 404', async () => {
  const O = as(await login('owner@demo.clinic'));
  assert.equal((await O('GET', '/reports/files/collection')).body.code, 'PERIOD_NEEDED');
  assert.equal((await O('GET', '/reports/files/collection?from=2026-05-02&to=2026-05-01')).body.code, 'BAD_RANGE');
  assert.equal((await O('GET', '/reports/files/collection?from=2024-01-01&to=2026-01-01')).body.code, 'RANGE_TOO_LONG');
  assert.equal((await O('GET', '/reports/files/nope?from=2026-01-01&to=2026-01-02')).status, 404);
});

test('reception: only lists it is allowed, and only once the owner lets lists leave the app; doctor: own patients, no money', async () => {
  const O = as(await login('owner@demo.clinic')); const R = as(await login('reception@demo.clinic')); const D = as(await login('doctor2@demo.clinic'));
  const range = 'from=2026-01-01&to=2026-12-31';
  assert.deepEqual((await R('GET', '/reports/files')).body.kinds.sort(), ['appointments', 'daily', 'procedures']);
  assert.equal((await R('GET', '/reports/files')).body.canExport, false);
  assert.equal((await R('GET', `/reports/files/appointments?${range}`)).body.code, 'LISTS_OWNER_ONLY', 'lists stay in until the owner allows');
  assert.equal((await R('GET', `/reports/files/collection?${range}`)).status, 403);

  const sec = (await O('GET', '/security')).body.security;
  assert.equal((await O('PUT', '/security', { ...sec, listRoles: ['owner', 'receptionist', 'doctor'] })).status, 200);
  assert.equal((await R('GET', `/reports/files/appointments?${range}`)).status, 200);
  assert.equal((await R('GET', '/reports/files/daily')).status, 200);
  assert.equal((await R('GET', `/reports/files/rx?${range}`)).status, 403, 'no prescriptions for the desk');

  const dc = (await D('GET', '/reports/files')).body;
  assert.equal(dc.ownOnly, true); assert.ok(!dc.kinds.includes('collection')); assert.ok(dc.kinds.includes('rx'));
  const mine = (await D('GET', `/reports/files/appointments?${range}&type=detailed`)).body;
  assert.ok(mine.title.includes('Dr. Second Doctor'), 'held to their own patients');
  assert.ok(mine.rows.slice(1).every((r: any[]) => r[5] === 'Dr. Second Doctor'));
});
