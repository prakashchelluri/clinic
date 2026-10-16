// End-to-end slice on embedded Postgres: login → book → check in → encounter → Rx → worklist → payment → daily report.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite';
process.env.COOKIE_SECRET = 'test-secret';
rmSync(process.env.PGLITE_DIR, { recursive: true, force: true });

const { migrate, applyRls } = await import('../src/db/index.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { buildApp } = await import('../src/app.js');

let app: Awaited<ReturnType<typeof buildApp>>;
const jar: Record<string, string> = {};
async function as(email: string) {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenant: 'sahitya' } });
  assert.equal(r.statusCode, 200, r.body);
  jar[email] = r.cookies.find((c) => c.name === 'cc_session')!.value;
  return (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
    app.inject({ method, url: '/api' + url, payload: payload as any, cookies: { cc_session: jar[email] } }).then((res) => ({ status: res.statusCode, body: res.json() }));
}

before(async () => { await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp(); });
after(async () => { await app.close(); });

test('full OP slice', async () => {
  const reception = await as('reception@demo.clinic');
  const doctor = await as('owner@demo.clinic');

  // 1. windows for today exist with capacity
  const sessions = await reception('GET', '/sessions');
  assert.ok(sessions.body.length >= 5);
  const win = sessions.body[0];

  // 2. phone booking creates a minimal patient; same idempotency key does not double-book
  const book = await reception('POST', '/appointments', { sessionId: win.id, newPatient: { fullName: 'Lakshmi Devi', phone: '9876543210' }, idempotencyKey: 'k1' });
  assert.equal(book.status, 200, JSON.stringify(book.body));
  const again = await reception('POST', '/appointments', { sessionId: win.id, newPatient: { fullName: 'Lakshmi Devi', phone: '9876543210' }, idempotencyKey: 'k1' });
  assert.equal(again.body.id, book.body.id);

  // 3. capacity enforced: fill the window, next booking gets 409 with alternatives
  for (let i = 0; i < win.capacity - 1; i++) {
    const r = await reception('POST', '/appointments', { sessionId: win.id, newPatient: { fullName: `P${i}`, phone: '9000000000' } });
    assert.equal(r.status, 200);
  }
  const full = await reception('POST', '/appointments', { sessionId: win.id, newPatient: { fullName: 'Late Caller' } });
  assert.equal(full.status, 409); assert.equal(full.body.code, 'WINDOW_FULL'); assert.ok(full.body.alternatives.length > 0);

  // 4. family members share a phone and stay separate
  const search = await reception('GET', '/patients?q=9000000000');
  assert.ok(search.body.length >= 2);

  // 5. check-in: category suggested GEN for a new patient, ₹300 cash recorded, OP number allocated per category
  const sug = await reception('GET', `/patients/${book.body.patientId}/suggest-category`);
  assert.equal(sug.body.suggested.code, 'GEN');
  const checkin = await reception('POST', '/visits', { patientId: book.body.patientId, appointmentId: book.body.id, feeCategoryCode: 'GEN',
    details: { weight_kg: 62, locality: 'Danavaipeta', complaint: 'acne' }, payment: { method: 'cash', amountPaise: 30000 }, idempotencyKey: 'v1' });
  assert.equal(checkin.status, 200, JSON.stringify(checkin.body));
  assert.equal(checkin.body.opNumber, 'GEN-1'); assert.equal(checkin.body.charge.status, 'paid');

  // receptionist cannot complete an encounter
  const open = await doctor('POST', `/visits/${checkin.body.id}/encounter`);
  assert.equal(open.status, 200);
  const forbidden = await reception('PATCH', `/encounters/${open.body.id}`, { complete: true });
  assert.equal(forbidden.status, 403);

  // 6. doctor: required field enforced, then completes with Rx + follow-up + procedure recommendation
  const invalid = await doctor('PATCH', `/encounters/${open.body.id}`, { data: { complaint: { chief_complaint: 'acne' } }, complete: true });
  assert.equal(invalid.status, 422);
  const done = await doctor('PATCH', `/encounters/${open.body.id}`, {
    data: { complaint: { chief_complaint: 'acne', site: ['Face'] }, assessment: { diagnosis: 'Acne vulgaris grade 2', severity: 'Moderate' } },
    prescription: [{ name: 'Adapalene 0.1% gel', route: 'topical', frequency: 'at night', durationDays: 56 }, { name: 'Doxycycline 100 mg', dose: '1 cap', frequency: 'once daily', durationDays: 28 }],
    recommendations: [{ kind: 'followup', intervalDays: 14 }, { kind: 'procedure', sittings: 6, notes: 'peel after 4 weeks' }],
    complete: true,
  });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.status, 'completed'); assert.equal(done.body.prescription.length, 2);

  // 7. queue shows the visit as done; worklists received both recommendations without re-entry
  const queue = await reception('GET', '/queue');
  assert.equal(queue.body.find((q: any) => q.id === checkin.body.id).status, 'done');
  const fu = await reception('GET', '/worklist?kind=followup'); assert.equal(fu.body.length, 1);
  const pr = await reception('GET', '/worklist?kind=procedure'); assert.equal(pr.body.length, 1);
  const contact = await reception('PATCH', `/worklist/${pr.body[0].id}`, { status: 'contacted', contact: { outcome: 'will come', note: 'next Monday' } });
  assert.equal(contact.body.contactLog.length, 1);

  // 8. renewal rule: second visit within 15 days suggests REN (₹0); FREE wins because an open procedure course exists
  const sug2 = await reception('GET', `/patients/${book.body.patientId}/suggest-category`);
  assert.equal(sug2.body.facts.days_since_last_paid_consult, 0);
  assert.ok(['REN', 'FREE'].includes(sug2.body.suggested.code));

  // 9. print payload and timeline
  const print = await doctor('GET', `/encounters/${open.body.id}/print`);
  assert.equal(print.body.clinic.name, 'Sahitya Dermatology Hospital');
  const tl = await doctor('GET', `/patients/${book.body.patientId}/timeline`);
  assert.equal(tl.body.encounters.length, 1); assert.equal(tl.body.outstandingPaise, 0);

  // 10. daily report reconciles: ₹300 cash, 1 GEN visit, one expense
  await reception('POST', '/expenses', { description: 'Water cans', amountPaise: 12000 });
  const rep = await reception('GET', '/reports/daily');
  assert.equal(rep.body.totals.collectedPaise, 30000); assert.equal(rep.body.totals.expensesPaise, 12000); assert.equal(rep.body.totals.visits, 1);
  assert.equal(rep.body.byMethod[0].method, 'cash');
});

test('tenant isolation: a second tenant sees nothing of the first', async () => {
  const { seedDemo } = await import('../src/db/seed.js');
  await seedDemo('other');
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { tenant: 'other', email: 'reception@demo.clinic', password: 'demo1234' } });
  const cookie = r.cookies.find((c) => c.name === 'cc_session')!.value;
  const q = await app.inject({ method: 'GET', url: '/api/patients', cookies: { cc_session: cookie } });
  assert.equal(q.json().length, 0);
  const w = await app.inject({ method: 'GET', url: '/api/worklist?kind=procedure', cookies: { cc_session: cookie } });
  assert.equal(w.json().length, 0);
});

test('sample data loads once and populates today', async () => {
  const owner = await as('owner@demo.clinic');
  const r = await owner('POST', '/dev/sample-data');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.patients >= 25 && r.body.encounters >= 15);
  const again = await owner('POST', '/dev/sample-data');
  assert.equal(again.status, 409);
  const queue = await owner('GET', '/queue');
  assert.ok(queue.body.filter((q: any) => q.status === 'waiting').length >= 4);
  const wl = await owner('GET', '/worklist?kind=procedure');
  assert.ok(wl.body.length >= 3);
  const rep = await owner('GET', '/reports/daily');
  assert.ok(rep.body.totals.collectedPaise > 0 && rep.body.expenses.length >= 2);
});
