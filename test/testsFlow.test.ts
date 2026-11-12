// Test reports from order to told: the desk sends what is in, a review closes the consultation, "needs a visit" waits for a booking,
// and a patient back with the reports is reviewed and told at that visit. Holds at any hour: the test sets up its own doctor hours.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-tests-flow';
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

test('reports: sent to the doctor, reviewed, a visit booked before closing, and reviewed in person when the patient is back', async () => {
  const doc = await as('owner@demo.clinic'); const desk = await as('reception@demo.clinic');
  const cfg = (await doc('GET', '/config')).body; const cat = cfg.feeCategories.find((c: any) => c.code === 'GEN') ?? cfg.feeCategories[0];
  const docId = cfg.practitioners[0].id; const branchId = cfg.branches[0].id;
  await doc('POST', '/sessions', { branchId, practitionerId: docId, day: today(), startTime: '00:00', endTime: '23:59', capacity: 50 });
  const pay = cat.amountPaise > 0 ? { method: 'cash', amountPaise: cat.amountPaise } : undefined;
  // a consultation that orders tests and is held open for them
  const consult = async (name: string, tests: string[]) => {
    const pid = (await desk('POST', '/patients?force=1', { fullName: name })).body.id as string;
    const v = await desk('POST', '/visits', { patientId: pid, feeCategoryCode: cat.code, details: {}, idempotencyKey: `${name}-${Date.now()}`, payment: pay });
    assert.equal(v.status, 200, JSON.stringify(v.body));
    const enc = (await doc('POST', `/visits/${v.body.id}/encounter`)).body.id as string;
    const done = await doc('PATCH', `/encounters/${enc}`, { data: { complaint: { chief_complaint: 'hair fall', site: ['Scalp'] }, assessment: { diagnosis: 'Telogen effluvium', severity: 'Mild' } }, recommendations: tests.map((notes) => ({ kind: 'investigation', notes })), complete: true });
    assert.equal(done.body.status, 'awaiting_reports');
    return { pid, enc };
  };
  const orders = async (pid: string) => (await desk('GET', '/orders')).body.orders.filter((o: any) => o.patient.id === pid);
  const values = async (pid: string, enc: string, t: any, value: string) => {
    assert.equal((await desk('POST', '/lab-results', { patientId: pid, encounterId: enc, recommendationId: t.id, takenOn: today(), items: [{ test: t.name, value }] })).status, 200);
    assert.equal((await desk('POST', '/orders/received', { ids: [t.id] })).status, 200);
  };
  const encStatus = async (enc: string) => (await doc('GET', `/encounters/${enc}`)).body.status;

  // 1. one report in: the desk sends what is in; the rest becomes its own order and the consultation stays open for it
  const a = await consult('Flow Partial', ['TSH', 'Vitamin D']);
  let [o] = await orders(a.pid); assert.ok(o.held);
  await values(a.pid, a.enc, o.tests.find((t: any) => t.name === 'TSH'), '6.8');
  assert.equal((await orders(a.pid))[0].state, 'partial');
  assert.equal((await desk('POST', '/orders/split', { ids: [o.tests.find((t: any) => t.name === 'Vitamin D').id] })).status, 200);
  const [tsh, vitD] = (await orders(a.pid)).sort((x: any, y: any) => x.orderNo - y.orderNo);
  assert.equal(tsh.state, 'ready'); assert.equal(vitD.state, 'pending');
  const r1 = await doc('POST', '/orders/review', { encounterId: a.enc, orderNo: tsh.orderNo, outcome: 'normal' });
  assert.equal(r1.body.closed, false, 'Vitamin D is still to come');
  assert.equal(await encStatus(a.enc), 'awaiting_reports');
  // the last report reviewed as normal: the consultation closes
  await values(a.pid, a.enc, (await orders(a.pid)).find((x: any) => x.orderNo === vitD.orderNo).tests[0], '40');
  const r2 = await doc('POST', '/orders/review', { encounterId: a.enc, orderNo: vitD.orderNo, outcome: 'normal' });
  assert.equal(r2.body.closed, true); assert.equal(await encStatus(a.enc), 'completed');

  // 2. "needs a visit": not closed until the visit is booked; the consultation waits for that visit
  const b = await consult('Flow Visit', ['CBC']);
  [o] = await orders(b.pid);
  await values(b.pid, b.enc, o.tests[0], 'Hb 9.1');
  assert.equal((await doc('POST', '/orders/review', { encounterId: b.enc, orderNo: o.orderNo, outcome: 'needs_visit' })).body.closed, false);
  assert.equal(await encStatus(b.enc), 'awaiting_reports');
  assert.equal((await desk('POST', '/orders/inform', { encounterId: b.enc, orderNo: o.orderNo, how: 'phone' })).body.code, 'BOOK_FIRST');
  const win = (await doc('POST', '/sessions', { branchId, practitionerId: docId, day: addDays(today(), 3), startTime: '06:00', endTime: '07:00', capacity: 5 })).body;
  assert.equal((await desk('POST', '/appointments', { sessionId: win.id, patientId: b.pid })).status, 200);
  assert.equal((await desk('POST', '/orders/inform', { encounterId: b.enc, orderNo: o.orderNo, how: 'phone' })).status, 200);
  assert.equal((await orders(b.pid))[0].state, 'closed');

  // 3. back with the reports: added at check-in, the doctor reopens the same consultation, and that is the review and the telling
  const c = await consult('Flow Back', ['Serum ferritin']);
  [o] = await orders(c.pid);
  const back = await desk('POST', '/visits', { patientId: c.pid, feeCategoryCode: cat.code, details: { reportsEncounterId: c.enc, complaint: 'Back with reports' }, idempotencyKey: `back-${Date.now()}` });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  await values(c.pid, c.enc, o.tests[0], '12');
  const opened = (await doc('POST', `/visits/${back.body.id}/encounter`)).body;
  assert.equal(opened.id, c.enc, 'the same consultation');
  assert.equal((await doc('PATCH', `/encounters/${c.enc}`, { data: opened.data, prescription: opened.prescription, recommendations: opened.recommendations.map((r: any) => ({ id: r.id, kind: r.kind, notes: r.notes })), complete: true })).status, 200);
  const closed = (await orders(c.pid))[0];
  assert.equal(closed.state, 'closed'); assert.equal(closed.outcome, 'seen'); assert.equal(closed.informedHow, 'in_person');
  assert.equal(await encStatus(c.enc), 'completed');

  // 4. telling the patient lives on Test reports only: nothing about reports on Calls
  assert.ok(!(await desk('GET', '/followups')).body.rows.some((r: any) => r.kind === 'report'));
});
