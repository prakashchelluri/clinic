// When a booking or a check-in is refused: a time that is over, a doctor who is away or done for the day,
// a patient who already has a booking or is being seen. Holds at any hour: every time is set up by the test itself.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-booking-rules';
process.env.COOKIE_SECRET = 'test-secret';
delete process.env.WHATSAPP_TOKEN;
rmSync(process.env.PGLITE_DIR, { recursive: true, force: true });

const { migrate, applyRls } = await import('../src/db/index.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { buildApp } = await import('../src/app.js');

let app: Awaited<ReturnType<typeof buildApp>>;
type Call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) => Promise<{ status: number; body: any }>;
async function as(email: string): Promise<Call> {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenant: 'sahitya' } });
  assert.equal(r.statusCode, 200, r.body);
  const cookie = r.cookies.find((c) => c.name === 'cc_session')!.value;
  return (method, url, payload) => app.inject({ method, url: '/api' + url, payload: payload as any, cookies: { cc_session: cookie } }).then((res) => ({ status: res.statusCode, body: res.body ? res.json() : null }));
}
const addDays = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

before(async () => { await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp(); });
after(async () => { await app.close(); });

test('booking: not into a time that is over, not into an hour the doctor is away, not twice, not while being seen', async () => {
  const owner = await as('owner@demo.clinic'); const desk = await as('reception@demo.clinic');
  const cfg = (await owner('GET', '/config')).body;
  const doc = cfg.practitioners[0].id; const branchId = cfg.branches[0].id;
  const reg = async (fullName: string) => (await desk('POST', '/patients?force=1', { fullName })).body.id as string;

  // a time that is over: yesterday's hour, even for the owner with overbooking
  const yday = addDays(today(), -1);
  const past = (await owner('POST', '/sessions', { branchId, practitionerId: doc, day: yday, startTime: '10:00', endTime: '11:00', capacity: 5 })).body;
  const p1 = await reg('Past Rules');
  assert.equal((await owner('POST', '/appointments', { sessionId: past.id, patientId: p1, overbook: true })).body.code, 'PAST_WINDOW');

  // the doctor is away for the whole hour: refused even with overbooking
  const later = addDays(today(), 10);
  const away = (await owner('POST', '/sessions', { branchId, practitionerId: doc, day: later, startTime: '06:00', endTime: '07:00', capacity: 5 })).body;
  await owner('POST', '/calendar/blocks', { practitionerId: doc, day: later, startTime: '06:00', endTime: '07:00', kind: 'leave', note: 'leave' });
  assert.equal((await owner('POST', '/appointments', { sessionId: away.id, patientId: p1, overbook: true })).body.code, 'DOCTOR_AWAY');

  // one upcoming booking at a time: the second is refused and says where the first one is
  const open = (await owner('POST', '/sessions', { branchId, practitionerId: doc, day: later, startTime: '07:00', endTime: '08:00', capacity: 5 })).body;
  const open2 = (await owner('POST', '/sessions', { branchId, practitionerId: doc, day: addDays(later, 1), startTime: '07:00', endTime: '08:00', capacity: 5 })).body;
  assert.equal((await desk('POST', '/appointments', { sessionId: open.id, patientId: p1 })).status, 200);
  const twice = await desk('POST', '/appointments', { sessionId: open2.id, patientId: p1 });
  assert.equal(twice.status, 409); assert.equal(twice.body.code, 'ALREADY_BOOKED');
  assert.equal(twice.body.day, later); assert.equal(twice.body.startTime, '07:00');
  // a known caller booked as "new" (same mobile and name) is the same patient: refused too
  const p2 = (await desk('POST', '/patients?force=1', { fullName: 'Caller Rules', phone: '9000011122' })).body.id;
  assert.equal((await desk('POST', '/appointments', { sessionId: open.id, patientId: p2 })).status, 200);
  assert.equal((await desk('POST', '/appointments', { sessionId: open2.id, newPatient: { fullName: 'caller rules', phone: '9000011122' } })).body.code, 'ALREADY_BOOKED');

  // being seen today: book the next visit after this one
  const p3 = await reg('Seen Rules');
  const v = await desk('POST', '/visits', { patientId: p3, feeCategoryCode: cfg.feeCategories[0].code, details: {}, idempotencyKey: `rules-${Date.now()}`, payment: cfg.feeCategories[0].amountPaise > 0 ? { method: 'cash', amountPaise: cfg.feeCategories[0].amountPaise } : undefined });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  const seen = await desk('POST', '/appointments', { sessionId: open.id, patientId: p3 });
  assert.equal(seen.body.code, 'IN_VISIT'); assert.equal(seen.body.opNumber, v.body.opNumber);
});

test('check-in: only to a doctor who still has hours today', async () => {
  const owner = await as('owner@demo.clinic'); const desk = await as('reception@demo.clinic');
  const cfg = (await owner('GET', '/config')).body;
  const [a, b] = cfg.practitioners; const branchId = cfg.branches[0].id; const cat = cfg.feeCategories[0];
  const pay = cat.amountPaise > 0 ? { method: 'cash', amountPaise: cat.amountPaise } : undefined;
  const checkIn = async (name: string, practitionerId: string) => desk('POST', '/visits', { patientId: (await desk('POST', '/patients?force=1', { fullName: name })).body.id, feeCategoryCode: cat.code, practitionerId, details: {}, idempotencyKey: `${name}-${Date.now()}`, payment: pay });
  // doctor A works all day today; doctor B is on leave all day
  await owner('POST', '/sessions', { branchId, practitionerId: a.id, day: today(), startTime: '00:00', endTime: '23:59', capacity: 50 });
  await owner('POST', '/sessions', { branchId, practitionerId: b.id, day: today(), startTime: '00:00', endTime: '23:59', capacity: 50 });
  await owner('POST', '/calendar/blocks', { practitionerId: b.id, day: today(), startTime: '00:00', endTime: '23:59', kind: 'leave', note: 'leave' });
  assert.equal((await checkIn('Working Rules', a.id)).status, 200);
  const off = await checkIn('Away Rules', b.id);
  assert.equal(off.status, 409); assert.equal(off.body.code, 'DOCTOR_NOT_WORKING');
});

test('a review leaves the lists once a visit is booked, a call says booked, or the patient is back', async () => {
  const owner = await as('owner@demo.clinic'); const desk = await as('reception@demo.clinic');
  const cfg = (await owner('GET', '/config')).body; const cat = cfg.feeCategories[0]; const doc = cfg.practitioners[0].id; const branchId = cfg.branches[0].id;
  const pay = cat.amountPaise > 0 ? { method: 'cash', amountPaise: cat.amountPaise } : undefined;
  // a consultation that ends with "review in 14 days"
  const seen = async (name: string) => {
    const id = (await desk('POST', '/patients?force=1', { fullName: name })).body.id as string;
    const v = await desk('POST', '/visits', { patientId: id, feeCategoryCode: cat.code, details: {}, idempotencyKey: `${name}-${Date.now()}`, payment: pay });
    const enc = (await owner('POST', `/visits/${v.body.id}/encounter`)).body;
    const done = await owner('PATCH', `/encounters/${enc.id}`, { data: { complaint: { chief_complaint: 'acne', site: ['Face'] }, assessment: { diagnosis: 'Acne', severity: 'Mild' } }, recommendations: [{ kind: 'followup', intervalDays: 14 }], complete: true });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    return id;
  };
  const review = async (id: string) => (await desk('GET', '/worklist?kind=followup')).body.find((r: any) => r.patient.id === id);
  // as the doctor, who also sees what the review is for (a diagnosis typed as one line, not a list)
  const onCalls = async (id: string) => (await owner('GET', '/followups?tab=reviews')).body.rows.some((r: any) => r.patient.id === id);

  // a call that ends in "booked"
  const a = await seen('Review Called');
  assert.equal((await review(a)).status, 'open'); assert.ok(await onCalls(a));
  assert.equal((await desk('POST', '/followups/log', { kind: 'review', refId: (await review(a)).id, patientId: a, outcome: 'booked' })).status, 200);
  assert.equal((await review(a)).status, 'scheduled'); assert.ok(!(await onCalls(a)));

  // a visit booked from the calendar, then the patient comes back
  const b = await seen('Review Returns');
  const later = (await owner('POST', '/sessions', { branchId, practitionerId: doc, day: addDays(today(), 14), startTime: '06:00', endTime: '07:00', capacity: 5 })).body;
  assert.equal((await desk('POST', '/appointments', { sessionId: later.id, patientId: b })).status, 200);
  assert.equal((await review(b)).status, 'scheduled'); assert.ok(!(await onCalls(b)));
  const back = await desk('POST', '/visits', { patientId: b, feeCategoryCode: cat.code, details: {}, idempotencyKey: `back-${Date.now()}`, payment: pay });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.equal(await review(b), undefined, 'met: off the follow-up list');
});
