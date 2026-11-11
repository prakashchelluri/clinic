// The owner's Clinic page: today's money matches End of day, money still due is counted, and only the owner sees it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-ownersummary';
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

test('owner summary: today equals End of day, a part-paid visit shows as due, reception cannot read it', async () => {
  const O = as(await login('owner@demo.clinic')); const R = as(await login('reception@demo.clinic'));
  const p = (await R('POST', '/patients', { fullName: 'Owner Summary One', phone: '9848077001' })).body;
  const v = await R('POST', '/visits', { patientId: p.id, feeCategoryCode: 'GEN', payment: { method: 'upi', amountPaise: 10000 }, idempotencyKey: 'os-1' });
  assert.equal(v.status, 200, JSON.stringify(v.body));

  const s = await O('GET', '/owner/summary');
  assert.equal(s.status, 200, JSON.stringify(s.body));
  const eod = (await O('GET', '/dayclose')).body;
  assert.equal(s.body.todayMoney.total.total, eod.money.total.total, 'the Clinic page and End of day show the same collected figure');
  assert.equal(s.body.week.at(-1).day, s.body.today, 'the week ends with today');
  assert.equal(s.body.week.at(-1).totalPaise, eod.money.total.total);
  assert.ok(s.body.dues.totalPaise >= 30000 && s.body.dues.patients >= 1, 'the part-paid fee counts as money still due');
  assert.ok(Array.isArray(s.body.unclosed));

  assert.equal((await R('GET', '/owner/summary')).status, 403, 'reception does not see the owner figures');
});
