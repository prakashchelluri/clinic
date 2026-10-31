// Wave 6: the review limit, the end of day (money by type and mode, drawer, diary, locked after closing), the dashboard.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-wave6';
process.env.UPLOAD_DIR = './data/test-uploads-wave6';
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
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

before(async () => { await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp(); });
after(async () => { await app.close(); });

test('review limit: one review after a paid consultation; a second needs the owner and a reason', async () => {
  const owner = await as('owner@demo.clinic'); const reception = await as('reception@demo.clinic');
  const p = (await reception('POST', '/patients', { fullName: 'Review Wave6', phone: '9848077711' })).body;
  const first = (await reception('POST', '/visits', { patientId: p.id, feeCategoryCode: 'GEN', payment: { method: 'cash', amountPaise: 30000 } })).body;
  assert.equal((await owner('PATCH', `/visits/${first.id}`, { status: 'done' })).status, 200);
  const r1 = await reception('POST', '/visits', { patientId: p.id, feeCategoryCode: 'REN' });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.equal((await owner('PATCH', `/visits/${r1.body.id}`, { status: 'done' })).status, 200);
  const r2 = await reception('POST', '/visits', { patientId: p.id, feeCategoryCode: 'REN' });
  assert.equal(r2.status, 409); assert.equal(r2.body.code, 'REVIEW_LIMIT'); assert.equal(r2.body.limit, 1);
  assert.equal((await reception('POST', '/visits', { patientId: p.id, feeCategoryCode: 'REN', allowReview: { reason: 'doctor asked to see again' } })).status, 403, 'the desk cannot allow it by default');
  assert.equal((await owner('POST', '/visits', { patientId: p.id, feeCategoryCode: 'REN', allowReview: { reason: 'doctor asked to see again' } })).status, 200);
});

test('end of day: figures by type and mode, differences need notes, closing locks the day; dashboard has per-doctor tiles', async () => {
  const owner = await as('owner@demo.clinic'); const reception = await as('reception@demo.clinic');
  const p = (await reception('POST', '/patients', { fullName: 'Close Wave6', phone: '9848077722' })).body;
  const c = (await reception('POST', '/charges', { patientId: p.id, description: 'Laser sitting', amountPaise: 100000 })).body;
  await reception('POST', '/payments/take', { patientId: p.id, chargeIds: [c.id], idempotencyKey: 'wave6-take-0001', parts: [{ method: 'cash', amountPaise: 40000 }, { method: 'upi', amountPaise: 60000, reference: '1234' }] });
  assert.equal((await reception('GET', '/dayclose')).status, 200);
  const f = (await owner('GET', `/dayclose?day=${today()}`)).body;
  assert.ok(f.money.total.cash >= 70000, 'consult cash from check-ins plus the 400 taken now');
  assert.ok(f.money.total.upi >= 60000);
  assert.equal(f.drawer.expectedCashPaise, f.money.total.cash - f.drawer.expensesCashPaise);
  assert.ok(f.counts.General >= 1 && f.counts.Review >= 2, JSON.stringify(f.counts));
  assert.equal(f.closed, null);

  const diary = { ...f.counts };
  assert.equal((await reception('POST', '/dayclose', { day: today(), cashCountedPaise: f.drawer.expectedCashPaise, diary })).status, 403, 'closing the day is not a desk permission by default');
  // a diary that disagrees and a drawer that is short each need a note
  const bad = await owner('POST', '/dayclose', { day: today(), cashCountedPaise: f.drawer.expectedCashPaise - 500, diary: { ...diary, Review: diary.Review - 1 } });
  assert.equal(bad.status, 400); assert.deepEqual([...bad.body.missing].sort(), ['Review', 'cash']);
  assert.equal((await owner('POST', '/dayclose', { day: today(), cashCountedPaise: f.drawer.expectedCashPaise, diary: { General: 1 } })).status, 400, 'every diary count is asked for');
  const ok = await owner('POST', '/dayclose', { day: today(), cashCountedPaise: f.drawer.expectedCashPaise - 500, diary: { ...diary, Review: diary.Review - 1 }, notes: { Review: 'counted as general in the diary', cash: 'tea money not entered' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await owner('POST', '/dayclose', { day: today(), cashCountedPaise: 0, diary })).status, 409);
  assert.equal((await owner('GET', `/dayclose?day=${today()}`)).body.closed.closedBy.length > 0, true);
  assert.equal((await reception('POST', '/payments/take', { patientId: p.id, chargeIds: [c.id], idempotencyKey: 'wave6-take-0002', parts: [{ method: 'cash', amountPaise: 100 }] })).status, 409, 'a closed day takes no new payments');
  const hist = (await owner('GET', '/dayclose/history')).body;
  assert.equal(hist[0].day, today()); assert.deepEqual(hist[0].differences.sort(), ['Review', 'cash']);

  // dashboard: tiles per doctor, a trend with its average, times against the month before
  const d = (await owner('GET', '/dashboard')).body;
  assert.ok(Array.isArray(d.tiles) && d.tiles.length >= 1);
  assert.equal(d.trend.length, 30); assert.ok(d.visits >= 3);
  assert.ok('waitMin' in d.times.now && 'waitMin' in d.times.before);
  assert.equal(d.moneyHidden, false); assert.ok('revenuePaise' in d.tiles[0]);
  assert.equal((await reception('GET', '/dashboard')).status, 403);
});
