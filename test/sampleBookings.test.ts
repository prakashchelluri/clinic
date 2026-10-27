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

test('test data fills the month, tomorrow and the courses, and can be topped up', async () => {
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

  // every working day of this month is filled (today aside: it only gets windows still ahead), and tomorrow is busy
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const [Y, M] = today.split('-').map(Number);
  const monthEnd = new Date(Date.UTC(Y, M, 0)).toISOString().slice(0, 10);
  const doc = (await call(owner, 'GET', '/config')).json().practitioners[0].id;
  const addDays = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const days: any[] = [];
  for (let from = `${Y}-${String(M).padStart(2, '0')}-01`; from <= monthEnd; from = addDays(from, 14)) days.push(...(await call(owner, 'GET', `/calendar/range?from=${from}&days=14&practitionerId=${doc}`)).json());
  const month = days.filter((d) => d.day >= `${Y}-${String(M).padStart(2, '0')}-01` && d.day <= monthEnd);
  const working = month.filter((d) => d.windows.length && d.day !== today);
  assert.ok(working.length >= 15, 'a month of working days');
  const empty = working.filter((d) => d.windows.every((w: any) => !w.appointments.length)).map((d) => d.day);
  assert.deepEqual(empty, [], 'no working day this month is left empty');
  const tomorrow = month.find((d) => d.day === addDays(today, 1)) ?? days.find((d) => d.day === addDays(today, 1));
  if (tomorrow?.windows.length) assert.ok(tomorrow.windows.reduce((n: number, w: any) => n + w.appointments.length, 0) >= 3, 'tomorrow has bookings');

  // running it again tops up only what is quiet: next to nothing is added, and nothing is refused
  const again = await call(owner, 'POST', '/dev/sample-bookings');
  assert.equal(again.statusCode, 200, again.body);
  const a = again.json();
  assert.equal(a.topUp, true); assert.equal(a.requested, 0); assert.equal(a.photos, 0); assert.equal(a.sittings, 0);
  assert.ok(a.booked + a.confirmed + a.arrived + a.no_show + a.cancelled <= 5, JSON.stringify(a));

});
