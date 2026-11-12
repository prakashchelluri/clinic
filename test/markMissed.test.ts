// A booking whose day passed with no visit becomes "did not come" by itself and lands on the call list's Missed tab.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-mark-missed';
process.env.COOKIE_SECRET = 'test-secret';
delete process.env.WHATSAPP_TOKEN;
rmSync(process.env.PGLITE_DIR, { recursive: true, force: true });

const { migrate, applyRls, db } = await import('../src/db/index.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { buildApp } = await import('../src/app.js');
const { appointment, visit } = await import('../src/db/schema.js');
const { eq } = await import('drizzle-orm');

let app: Awaited<ReturnType<typeof buildApp>>;
type Call = (method: 'GET' | 'POST', url: string, payload?: unknown) => Promise<{ status: number; body: any }>;
async function as(email: string): Promise<Call> {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenant: 'sahitya' } });
  const cookie = r.cookies.find((c) => c.name === 'cc_session')!.value;
  return (method, url, payload) => app.inject({ method, url: '/api' + url, payload: payload as any, cookies: { cc_session: cookie } }).then((res) => ({ status: res.statusCode, body: res.body ? res.json() : null }));
}
const addDays = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

before(async () => { await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp(); });
after(async () => { await app.close(); });

test('a passed booking with no visit is marked did not come; one the patient came for, or today’s, is not', async () => {
  const owner = await as('owner@demo.clinic'); const desk = await as('reception@demo.clinic');
  const cfg = (await owner('GET', '/config')).body;
  const doc = cfg.practitioners[0].id; const branchId = cfg.branches[0].id; const tenantId = cfg.tenant.id;
  const yday = addDays(today(), -1);
  const past = (await owner('POST', '/sessions', { branchId, practitionerId: doc, day: yday, startTime: '10:00', endTime: '11:00', capacity: 5 })).body;
  const now = (await owner('POST', '/sessions', { branchId, practitionerId: doc, day: today(), startTime: '00:00', endTime: '23:59', capacity: 5 })).body;
  const reg = async (fullName: string) => (await desk('POST', '/patients?force=1', { fullName })).body.id as string;
  const [away, came, later] = [await reg('Missed Yesterday'), await reg('Came Yesterday'), await reg('Booked Today')];
  // bookings into a time that is over are refused by the API, so they are written as the past would have left them
  const [a1, a2, a3] = await db.insert(appointment).values([
    { tenantId, patientId: away, sessionId: past.id, status: 'booked' },
    { tenantId, patientId: came, sessionId: past.id, status: 'confirmed' },
    { tenantId, patientId: later, sessionId: now.id, status: 'booked' },
  ]).returning();
  // "came" checked in without the booking being linked (a walk-in at the desk); the visit is moved to yesterday
  const cat = cfg.feeCategories[0];
  const v = (await desk('POST', '/visits', { patientId: came, feeCategoryCode: cat.code, practitionerId: doc, details: {}, idempotencyKey: `mm-${Date.now()}`, payment: cat.amountPaise > 0 ? { method: 'cash', amountPaise: cat.amountPaise } : undefined })).body;
  await db.update(visit).set({ day: yday }).where(eq(visit.id, v.id));

  const missed = (await desk('GET', '/followups?tab=missed')).body.rows;
  const status = async (id: string) => (await db.select().from(appointment).where(eq(appointment.id, id)))[0].status;
  assert.equal(await status(a1.id), 'no_show');
  assert.equal(await status(a2.id), 'confirmed', 'the patient came that day');
  assert.equal(await status(a3.id), 'booked', 'today is not over: a late arrival still checks in');
  assert.ok(missed.some((r: any) => r.kind === 'missed_visit' && r.patient.id === away));
  assert.ok(!missed.some((r: any) => r.patient.id === came || r.patient.id === later));

  // a later visit booked before they missed (a repeat series) does not settle it; one booked after does
  const next = (await owner('POST', '/sessions', { branchId, practitionerId: doc, day: addDays(today(), 3), startTime: '10:00', endTime: '11:00', capacity: 5 })).body;
  const [series, rebook] = [await reg('Series Patient'), await reg('Rebooked Patient')];
  await db.insert(appointment).values([
    { tenantId, patientId: series, sessionId: past.id, status: 'booked' }, { tenantId, patientId: series, sessionId: next.id, status: 'booked', createdAt: new Date(Date.now() - 5 * 864e5).toISOString() },
    { tenantId, patientId: rebook, sessionId: past.id, status: 'booked' }, { tenantId, patientId: rebook, sessionId: next.id, status: 'booked' },
  ]);
  const again = (await desk('GET', '/followups?tab=missed')).body.rows;
  assert.ok(again.some((r: any) => r.patient.id === series), 'a series visit booked before the miss');
  assert.ok(!again.some((r: any) => r.patient.id === rebook), 'booked again after the miss');
});
