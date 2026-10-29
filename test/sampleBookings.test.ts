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

test('test data fills the week, pharmacy and courses, and can be topped up', async () => {
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

  // the week around today is filled (today aside: it only gets windows still ahead), and tomorrow is busy
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const doc = (await call(owner, 'GET', '/config')).json().practitioners[0].id;
  const addDays = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const days: any[] = (await call(owner, 'GET', `/calendar/range?from=${addDays(today, -6)}&days=13&practitionerId=${doc}`)).json();
  const working = days.filter((d) => d.windows.length && d.day !== today);
  assert.ok(working.length >= 9, 'a week either side of working days');
  assert.deepEqual(working.filter((d) => d.windows.every((w: any) => !w.appointments.length)).map((d) => d.day), [], 'no working day in the week is left empty');
  const tomorrow = days.find((d) => d.day === addDays(today, 1));
  if (tomorrow?.windows.length) assert.ok(tomorrow.windows.reduce((n: number, w: any) => n + w.appointments.length, 0) >= 3, 'tomorrow has bookings');

  // pharmacy: prescription bills and counter sales over the week, with totals; expenses and visits exist too
  assert.ok(s.visits > 0 && s.pharmacyBills > 0 && s.counterSales >= 12 && s.expenses >= 14, JSON.stringify(s));
  const hr = await call(owner, 'GET', `/pharmacy/bills?from=${addDays(today, -6)}&to=${today}`); assert.equal(hr.statusCode, 200, hr.body); const hist = hr.json();
  assert.ok(hist.rows.some((r: any) => !r.encounterId) && hist.rows.some((r: any) => r.encounterId), 'counter sales and prescription bills');
  assert.ok(hist.rows.some((r: any) => r.balance.length), 'some prescriptions were short-issued');
  assert.equal(hist.totals.total - hist.totals.refunds, hist.totals.cash + hist.totals.upi + hist.totals.card, 'method totals add up');
  const oneDay = (await call(owner, 'GET', `/pharmacy/bills?from=${today}&to=${today}`)).json();
  assert.ok(oneDay.rows.length > 0 && oneDay.rows.length < hist.rows.length, 'a single day is a subset');
  // stock: opening stock, a delivery waiting for the owner, and the counter's prescriptions for today
  const st = (await call(owner, 'GET', '/stock')).json();
  assert.equal(st.reviews.length, 1); assert.equal(st.reviews[0].freeShort, 2); assert.ok(st.reviews[0].extraPaise > 0);
  assert.ok(st.items.some((i: any) => i.status === 'expiring') && st.items.some((i: any) => i.status === 'low'));
  assert.ok((await call(owner, 'GET', '/pharmacy/counter')).json().today.length > 0, 'today has prescriptions at the counter');
  assert.equal((await call(owner, 'GET', `/expenses?from=${addDays(today, -6)}&to=${today}`)).statusCode, 200);

  // running it again tops up only what is quiet: next to nothing is added, and nothing is refused
  const again = await call(owner, 'POST', '/dev/sample-bookings');
  assert.equal(again.statusCode, 200, again.body);
  const a = again.json();
  assert.equal(a.topUp, true); assert.equal(a.requested, 0); assert.equal(a.photos, 0); assert.equal(a.sittings, 0);
  assert.equal(a.counterSales + a.expenses, 0, 'counter sales and expenses are not added twice');
  assert.ok(a.booked + a.confirmed + a.arrived + a.no_show + a.cancelled <= 5, JSON.stringify(a));

});
