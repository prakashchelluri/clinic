// Test-data loader: bookings, requests, series, messages, procedure courses with photos; once only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-samplebk';
process.env.UPLOAD_DIR = './data/test-uploads-samplebk';
process.env.COOKIE_SECRET = 'test-secret';
for (const k of ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) delete process.env[k];
rmSync(process.env.PGLITE_DIR, { recursive: true, force: true });
rmSync(process.env.UPLOAD_DIR, { recursive: true, force: true });

const { migrate, applyRls } = await import('../src/db/index.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { buildApp } = await import('../src/app.js');

let app: Awaited<ReturnType<typeof buildApp>>;
const login = async (email: string) => (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenant: 'sahitya' } })).cookies.find((c) => c.name === 'cc_session')!.value;
before(async () => { await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp(); });
after(async () => { await app.close(); });

test('test data loads everything the booking and photo screens need, once', async () => {
  const owner = await login('owner@demo.clinic'); const reception = await login('reception@demo.clinic');
  const call = (c: string, method: 'GET' | 'POST', url: string) => app.inject({ method, url: '/api' + url, cookies: { cc_session: c } });

  assert.equal((await call(reception, 'POST', '/dev/sample-bookings')).statusCode, 403);
  const r = await call(owner, 'POST', '/dev/sample-bookings');
  assert.equal(r.statusCode, 200, r.body);
  const s = r.json();
  assert.ok(s.base?.patients >= 20, 'base sample loaded first');
  assert.ok(s.booked + s.confirmed > 20, 'upcoming bookings'); assert.ok(s.arrived > 10 && s.no_show > 0, 'past visits and no-shows');
  assert.ok(s.requested >= 3 && s.series >= 6 && s.messages > 0, JSON.stringify(s));
  assert.equal(s.sittings, 8); assert.equal(s.photos, 16);

  const counts = (await call(reception, 'GET', '/bookings/counts')).json();
  assert.ok(counts.requests >= 3 && counts.unconfirmed > 0);
  assert.equal((await call(owner, 'GET', '/public/clinic/sahitya')).json().enabled, true, 'online booking switched on');

  // photo courses: timeline with sittings, files served as PNG
  const course = (await call(owner, 'GET', '/worklist?kind=procedure')).json().find((x: any) => x.procedure === 'Laser hair reduction');
  const tl = (await call(owner, 'GET', `/patients/${course.patient.id}/photos`)).json();
  assert.ok(tl.consent?.grantedAt); assert.equal(tl.photos.length, 8);
  assert.deepEqual([...new Set(tl.photos.map((p: any) => p.sitting?.sittingNo ?? 0))].sort(), [0, 1, 2, 3]);
  const file = await call(owner, 'GET', `/documents/${tl.photos[0].id}/file`);
  assert.equal(file.statusCode, 200); assert.equal(file.headers['content-type'], 'image/png');
  assert.deepEqual([...file.rawPayload.subarray(0, 4)], [137, 80, 78, 71], 'a real PNG');

  assert.equal((await call(owner, 'POST', '/dev/sample-bookings')).json().code, 'SAMPLE_ALREADY_LOADED');
});
