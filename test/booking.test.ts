// Phases 2–4: visit types, repeat series, statuses, messages and the patient link.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-booking';
process.env.COOKIE_SECRET = 'test-secret';
delete process.env.WHATSAPP_TOKEN;
rmSync(process.env.PGLITE_DIR, { recursive: true, force: true });

const { migrate, applyRls } = await import('../src/db/index.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { buildApp } = await import('../src/app.js');
const { dispatchDue } = await import('../src/lib/messaging.js');

let app: Awaited<ReturnType<typeof buildApp>>;
type Call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) => Promise<{ status: number; body: any }>;
async function as(email: string): Promise<Call> {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenant: 'sahitya' } });
  assert.equal(r.statusCode, 200, r.body);
  const cookie = r.cookies.find((c) => c.name === 'cc_session')!.value;
  return (method, url, payload) => app.inject({ method, url: '/api' + url, payload: payload as any, cookies: { cc_session: cookie } }).then((res) => ({ status: res.statusCode, body: res.body ? res.json() : null }));
}
const anon: Call = (method, url, payload) => app.inject({ method, url: '/api' + url, payload: payload as any, headers: { 'x-forwarded-for': '10.0.0.' + Math.floor(Math.random() * 250) } }).then((res) => ({ status: res.statusCode, body: res.body ? res.json() : null }));
const addDays = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

before(async () => { await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp(); });
after(async () => { await app.close(); });

test('visit types: defaults exist, validated, editable', async () => {
  const owner = await as('owner@demo.clinic'); const reception = await as('reception@demo.clinic');
  const cfg = await owner('GET', '/config');
  assert.ok(cfg.body.services.length >= 3, 'default visit types seeded');
  assert.equal((await reception('POST', '/admin/services', { name: 'X' })).status, 403);
  assert.equal((await owner('POST', '/admin/services', { name: '' })).status, 400);
  assert.equal((await owner('POST', '/admin/services', { name: 'Bad colour', color: 'red' })).status, 400);
  assert.equal((await owner('POST', '/admin/services', { name: 'Neg price', pricePaise: -1 })).status, 400);
  assert.equal((await owner('POST', '/admin/services', { name: 'Huge', minutes: 100000 })).status, 400);
  const made = await owner('POST', '/admin/services', { name: 'Hair consultation', minutes: 60, pricePaise: 50000, color: '#8A6218', onlineBookable: true, places: 2 });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const ed = await owner('PATCH', `/admin/services/${made.body.id}`, { active: false });
  assert.equal(ed.body.active, false); assert.equal(ed.body.name, 'Hair consultation');
});

test('booking with a visit type, repeat series, confirm, cancel the rest of the series', async () => {
  const reception = await as('reception@demo.clinic');
  const cfg = (await reception('GET', '/config')).body;
  const doc = cfg.practitioners.find((p: any) => p.name.startsWith('Dr. Main')).id;
  const review = cfg.services.find((s: any) => s.name === 'Review');
  const day = addDays(today(), 2);
  const ws = (await reception('GET', `/sessions?day=${day}&practitionerId=${doc}`)).body;
  const w = ws.find((x: any) => x.free > 0) ?? ws[0];
  assert.ok(w, 'a window two days out');

  const r = await reception('POST', '/appointments', { sessionId: w.id, serviceId: review.id, newPatient: { fullName: 'Series Patient', phone: '9000011111' }, repeat: { everyWeeks: 1, count: 4 } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.series.created.length + r.body.series.skipped.length, 3);
  assert.ok(r.body.publicToken.length >= 20);
  assert.equal((await reception('POST', '/appointments', { sessionId: w.id, serviceId: '00000000-0000-0000-0000-000000000000', newPatient: { fullName: 'Nobody' } })).body.code, 'SERVICE_NOT_FOUND');
  assert.equal((await reception('POST', '/appointments', { sessionId: w.id, newPatient: { fullName: 'Repeat bad' }, repeat: { everyWeeks: 0, count: 3 } })).status, 400);
  assert.equal((await reception('POST', '/appointments', { sessionId: w.id, newPatient: { fullName: 'Repeat bad' }, repeat: { everyWeeks: 1, count: 99 } })).status, 400);

  const detail = await reception('GET', `/appointments/${r.body.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.service.name, 'Review');
  assert.equal(detail.body.series.index, 1);
  assert.ok(detail.body.messages.some((m: any) => m.kind === 'confirmation'), 'confirmation queued');
  assert.ok(detail.body.messages.some((m: any) => m.kind === 'reminder' && m.status === 'pending'), 'reminder planned');
  assert.match(detail.body.link, /\/a\/sahitya\//);

  const conf = await reception('PATCH', `/appointments/${r.body.id}`, { status: 'confirmed' });
  assert.equal(conf.body.status, 'confirmed'); assert.ok(conf.body.confirmedAt);

  // calendar shows the visit type colour on the name
  const cal = await reception('GET', `/calendar?day=${day}&practitionerId=${doc}`);
  const a = cal.body.windows.flatMap((x: any) => x.appointments).find((x: any) => x.id === r.body.id);
  assert.equal(a.color, review.color); assert.equal(a.status, 'confirmed');

  const cancel = await reception('PATCH', `/appointments/${r.body.id}`, { status: 'cancelled', cancelReason: 'moving away', series: 'future' });
  assert.equal(cancel.status, 200);
  assert.equal(cancel.body.alsoCancelled, r.body.series.created.length);
  const after = await reception('GET', `/appointments/${r.body.id}`);
  assert.ok(after.body.series.items.every((x: any) => x.status === 'cancelled'));
  assert.ok(!after.body.messages.some((m: any) => m.kind === 'reminder' && m.status === 'pending'), 'reminders dropped');
  assert.ok(after.body.messages.some((m: any) => m.kind === 'cancelled'), 'patient told');
  assert.equal((await reception('PATCH', `/appointments/${r.body.id}`, { status: 'unknown' })).status, 400);

  // bookings list + counts
  const list = await reception('GET', '/bookings?tab=cancelled&q=Series');
  assert.ok(list.body.some((x: any) => x.id === r.body.id));
  assert.equal((await reception('GET', '/bookings?tab=nonsense')).status, 400);
  assert.equal((await reception('GET', '/bookings/counts')).status, 200);
});

test('no public booking page; the patient link from WhatsApp: view, confirm, move with the same doctor, cancel; outbox', async () => {
  const reception = await as('reception@demo.clinic');
  assert.equal((await anon('GET', '/public/clinic/sahitya')).status, 404, 'there is no public booking page');
  assert.equal((await anon('POST', '/public/clinic/sahitya/book', { name: 'Someone', phone: '9876500000' })).status, 404);

  const cfg = (await reception('GET', '/config')).body;
  const doc = cfg.practitioners.find((p: any) => p.name.startsWith('Dr. Main')).id;
  const svc = cfg.services.find((s: any) => s.name === 'New consultation');
  const day = addDays(today(), 3);
  const w = (await reception('GET', `/sessions?day=${day}&practitionerId=${doc}`)).body.find((x: any) => x.free > 0);
  assert.ok(w, 'a free window three days out');
  const made = await reception('POST', '/appointments', { sessionId: w.id, serviceId: svc.id, newPatient: { fullName: 'Link Patient', phone: '9876500000' } });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const link = `/a/sahitya/${made.body.publicToken}`;

  const view = await anon('GET', `/public${link}`);
  assert.equal(view.status, 200); assert.equal(view.body.status, 'booked'); assert.equal(view.body.canCancel, true);
  assert.equal((await anon('GET', '/public/a/sahitya/not-a-real-token-xxxxxxxxxx')).status, 404);

  const confirmed = await anon('POST', `/public${link}/confirm`);
  assert.equal(confirmed.body.status, 'confirmed');
  const linkSlots = (await anon('GET', `/public${link}/slots?from=${addDays(today(), 3)}&days=3`)).body.flatMap((d: any) => d.slots);
  assert.ok(linkSlots.every((s: any) => s.practitionerId === doc), 'a patient reschedules with the same doctor');
  assert.ok(linkSlots.every((s: any) => s.day === undefined || s.day <= addDays(today(), 30)));
  const moveTo = linkSlots.find((s: any) => s.id !== w.id);
  if (moveTo) assert.equal((await anon('POST', `/public${link}/reschedule`, { sessionId: moveTo.id })).status, 200);
  const cancelled = await anon('POST', `/public${link}/cancel`, { reason: 'feeling better' });
  assert.equal(cancelled.body.status, 'cancelled');
  assert.equal((await anon('POST', `/public${link}/cancel`)).body.code, 'NOT_OPEN');

  // outbox: no WhatsApp configured → messages are logged, not lost, and no placeholder is left unfilled
  await dispatchDue(new Date());
  const out = (await reception('GET', '/messages?status=logged')).body;
  assert.ok(out.length > 0);
  assert.ok(out.every((m: any) => !/{w+}/.test(m.body)), 'no unfilled placeholders');
});
