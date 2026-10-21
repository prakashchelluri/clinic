// Phases 2–4: visit types, repeat series, statuses, messages, online booking and the patient link.
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

test('online booking: off by default, rules, request → approve, patient link, outbox', async () => {
  const owner = await as('owner@demo.clinic'); const reception = await as('reception@demo.clinic');
  assert.equal((await anon('GET', '/public/clinic/nope')).status, 404);
  const pub0 = await anon('GET', '/public/clinic/sahitya');
  assert.equal(pub0.status, 200); assert.equal(pub0.body.enabled, false);
  assert.equal((await anon('GET', `/public/clinic/sahitya/slots?from=${today()}`)).body.code, 'ONLINE_BOOKING_OFF');
  // staff API stays locked to anonymous callers
  assert.equal((await anon('GET', '/bookings')).status, 401);

  await owner('PATCH', '/admin/clinic', { settings: { online: { enabled: true, requireApproval: true, minNoticeHours: 2, maxDaysAhead: 14, dailyCap: 0 }, booking: { cancelWindowHours: 4 } } });
  const pub = (await anon('GET', '/public/clinic/sahitya')).body;
  assert.equal(pub.enabled, true);
  assert.ok(pub.services.length >= 2 && pub.services.every((s: any) => s.name !== 'Procedure follow-up'), 'only online visit types');
  const svc = pub.services[0];

  const slots = (await anon('GET', `/public/clinic/sahitya/slots?from=${addDays(today(), 3)}&days=3&serviceId=${svc.id}`)).body;
  const pick = slots.flatMap((d: any) => d.slots.map((s: any) => ({ ...s, day: d.day })))[0];
  assert.ok(pick, 'some open slot 3+ days out');
  const beyond = (await anon('GET', `/public/clinic/sahitya/slots?from=${addDays(today(), 20)}&days=3&serviceId=${svc.id}`)).body;
  assert.equal(beyond.length, 0, 'nothing past the booking horizon');
  assert.equal((await anon('GET', `/public/clinic/sahitya/slots?from=2026-02-30`)).status, 400);

  const bad = [
    { name: 'A', phone: '9876500000' }, { name: 'Valid Name', phone: '98765' }, { name: 'Valid Name', phone: 'abcdefghij' },
    { name: 'Valid Name', phone: '9876500000', website: 'spam' }, { name: 'x'.repeat(101), phone: '9876500000' },
  ];
  for (const b of bad) assert.equal((await anon('POST', '/public/clinic/sahitya/book', { sessionId: pick.id, serviceId: svc.id, ...b })).status, 400, JSON.stringify(b));

  const book = await anon('POST', '/public/clinic/sahitya/book', { sessionId: pick.id, serviceId: svc.id, name: 'Online Patient', phone: '9876500000', note: 'itchy rash' });
  assert.equal(book.status, 200, JSON.stringify(book.body)); assert.equal(book.body.status, 'requested');

  const view = await anon('GET', `/public${book.body.link}`);
  assert.equal(view.status, 200); assert.equal(view.body.status, 'requested'); assert.equal(view.body.canConfirm, false); assert.equal(view.body.canCancel, true);
  assert.equal((await anon('GET', '/public/a/sahitya/not-a-real-token-xxxxxxxxxx')).status, 404);

  const reqs = (await reception('GET', '/bookings?tab=requests')).body;
  const mine = reqs.find((x: any) => x.patient.fullName === 'Online Patient');
  assert.ok(mine, 'request in the inbox');
  assert.equal((await reception('POST', `/appointments/${mine.id}/approve`)).status, 200);
  assert.equal((await reception('POST', `/appointments/${mine.id}/approve`)).body.code, 'NOT_A_REQUEST');

  const confirmed = await anon('POST', `/public${book.body.link}/confirm`);
  assert.equal(confirmed.body.status, 'confirmed');
  const linkSlots = (await anon('GET', `/public${book.body.link}/slots?from=${addDays(today(), 3)}&days=3`)).body.flatMap((d: any) => d.slots);
  assert.ok(linkSlots.every((s: any) => s.practitionerId === pick.practitionerId), 'a patient reschedules with the same doctor');
  const otherDoc = slots.flatMap((d: any) => d.slots).find((s: any) => s.practitionerId !== pick.practitionerId);
  if (otherDoc) assert.equal((await anon('POST', `/public${book.body.link}/reschedule`, { sessionId: otherDoc.id })).body.code, 'SLOT_TAKEN');
  const moveTo = linkSlots[0];
  if (moveTo) assert.equal((await anon('POST', `/public${book.body.link}/reschedule`, { sessionId: moveTo.id })).status, 200);
  const cancelled = await anon('POST', `/public${book.body.link}/cancel`, { reason: 'feeling better' });
  assert.equal(cancelled.body.status, 'cancelled');
  assert.equal((await anon('POST', `/public${book.body.link}/cancel`)).body.code, 'NOT_OPEN');

  // a second request, declined by reception
  const b2 = await anon('POST', '/public/clinic/sahitya/book', { sessionId: pick.id, serviceId: svc.id, name: 'Declined Patient', phone: '9876511111' });
  const r2 = (await reception('GET', '/bookings?tab=requests')).body.find((x: any) => x.patient.fullName === 'Declined Patient');
  assert.equal((await reception('POST', `/appointments/${r2.id}/decline`, { reason: 'Doctor on leave.' })).body.status, 'cancelled');
  assert.equal((await anon('GET', `/public${b2.body.link}`)).body.status, 'cancelled');

  // outbox: no WhatsApp configured → messages are logged, not lost
  const sentN = await dispatchDue(new Date());
  assert.ok(sentN > 0);
  const out = (await reception('GET', '/messages?status=logged')).body;
  assert.ok(out.some((m: any) => m.kind === 'declined' && /Doctor on leave/.test(m.body)));
  assert.ok(out.every((m: any) => !/\{\w+\}/.test(m.body)), 'no unfilled placeholders');

  // turning online booking off closes the door again
  await owner('PATCH', '/admin/clinic', { settings: { online: { enabled: false } } });
  assert.equal((await anon('POST', '/public/clinic/sahitya/book', { sessionId: pick.id, serviceId: svc.id, name: 'Too Late', phone: '9876522222' })).body.code, 'ONLINE_BOOKING_OFF');
});
