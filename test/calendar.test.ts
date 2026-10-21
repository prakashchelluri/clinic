// Calendar v2: week range with names in windows, and moving a booking by drag (capacity enforced).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-calendar';
process.env.COOKIE_SECRET = 'test-secret';
rmSync(process.env.PGLITE_DIR, { recursive: true, force: true });

const { migrate, applyRls } = await import('../src/db/index.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { buildApp } = await import('../src/app.js');

let app: Awaited<ReturnType<typeof buildApp>>;
async function as(email: string) {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenant: 'sahitya' } });
  assert.equal(r.statusCode, 200, r.body);
  const cookie = r.cookies.find((c) => c.name === 'cc_session')!.value;
  return (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
    app.inject({ method, url: '/api' + url, payload: payload as any, cookies: { cc_session: cookie } }).then((res) => ({ status: res.statusCode, body: res.json() }));
}

before(async () => { await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp(); });
after(async () => { await app.close(); });

const nextMonday = () => { const d = new Date(); d.setUTCDate(d.getUTCDate() + 7 - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };

test('week range, names in windows, move with capacity check', async () => {
  const reception = await as('reception@demo.clinic');
  const me = await reception('GET', '/config');
  const doc = me.body.practitioners[0].id;

  assert.equal((await reception('GET', '/calendar/range?from=2026-13-01')).status, 400);
  assert.equal((await reception('GET', '/calendar/range?from=2026-02-30')).status, 400);
  assert.equal((await reception('GET', `/calendar/range?from=${nextMonday()}&days=15`)).status, 400);

  const week = await reception('GET', `/calendar/range?from=${nextMonday()}&days=7&practitionerId=${doc}`);
  assert.equal(week.status, 200, JSON.stringify(week.body));
  assert.equal(week.body.length, 7);
  const day = week.body.find((d: any) => d.windows.length >= 2);
  assert.ok(day, 'routine gives at least one working day with two windows');
  const [a, b] = day.windows;
  assert.deepEqual(a.appointments, []);

  const book = await reception('POST', '/appointments', { sessionId: a.id, newPatient: { fullName: 'Drag Me', phone: '9123456780' } });
  assert.equal(book.status, 200);
  const after1 = await reception('GET', `/calendar?day=${day.day}&practitionerId=${doc}`);
  const named = after1.body.windows.find((w: any) => w.id === a.id).appointments;
  assert.equal(named.length, 1); assert.equal(named[0].name, 'Drag Me'); assert.equal(named[0].status, 'booked');

  // move to the other window
  const mv = await reception('PATCH', `/appointments/${book.body.id}`, { sessionId: b.id });
  assert.equal(mv.status, 200, JSON.stringify(mv.body));
  const after2 = await reception('GET', `/calendar?day=${day.day}&practitionerId=${doc}`);
  assert.equal(after2.body.windows.find((w: any) => w.id === a.id).allocated, 0);
  assert.equal(after2.body.windows.find((w: any) => w.id === b.id).appointments[0].name, 'Drag Me');

  // fill window a, then moving into it is refused
  for (let i = 0; i < a.effectiveCapacity; i++) assert.equal((await reception('POST', '/appointments', { sessionId: a.id, newPatient: { fullName: `Filler ${i}` } })).status, 200);
  const full = await reception('PATCH', `/appointments/${book.body.id}`, { sessionId: a.id });
  assert.equal(full.status, 409); assert.equal(full.body.code, 'WINDOW_FULL');

  // a past window is read-only
  const lastWeek = new Date(nextMonday() + 'T00:00:00Z'); lastWeek.setUTCDate(lastWeek.getUTCDate() - 14 + (new Date(day.day + 'T00:00:00Z').getUTCDay() + 6) % 7);
  const past = await reception('GET', `/calendar?day=${lastWeek.toISOString().slice(0, 10)}&practitionerId=${doc}`);
  assert.ok(past.body.windows.length, 'same weekday last week has windows');
  assert.equal((await reception('PATCH', `/appointments/${book.body.id}`, { sessionId: past.body.windows[0].id })).body.code, 'PAST_WINDOW');

  // unknown window, and a cancelled booking cannot be moved
  assert.equal((await reception('PATCH', `/appointments/${book.body.id}`, { sessionId: '00000000-0000-0000-0000-000000000000' })).body.code, 'SESSION_NOT_FOUND');
  await reception('PATCH', `/appointments/${book.body.id}`, { status: 'cancelled' });
  const moved = await reception('PATCH', `/appointments/${book.body.id}`, { sessionId: b.id });
  assert.equal(moved.status, 409); assert.equal(moved.body.code, 'NOT_MOVABLE');
});
