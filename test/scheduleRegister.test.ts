// The Schedule H register is built from the bills: scheduled medicines only, sold against a prescription line; a line with no prescription behind it is flagged, returns show, exports are audited.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-register';
process.env.UPLOAD_DIR = './data/test-uploads-register';
process.env.COOKIE_SECRET = 'test-secret';
rmSync(process.env.PGLITE_DIR, { recursive: true, force: true });

const { migrate, applyRls, db } = await import('../src/db/index.js');
const S = await import('../src/db/schema.js');
const { eq } = await import('drizzle-orm');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { buildApp } = await import('../src/app.js');

let app: Awaited<ReturnType<typeof buildApp>>;
const login = async (email: string) => (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenant: 'sahitya' } })).cookies.find((c) => c.name === 'cc_session')!.value;
before(async () => { await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp(); });
after(async () => { await app.close(); });
const as = (c: string) => (method: 'GET' | 'POST', url: string, payload?: unknown) => app.inject({ method, url: '/api' + url, cookies: { cc_session: c }, payload: payload as any });
const ym = (m: number) => { const d = new Date(); d.setUTCMonth(d.getUTCMonth() + m); return d.toISOString().slice(0, 7); };

test('schedule register: scheduled drugs only, no-prescription flag, returns, audited export', async () => {
  const P = as(await login('pharmacy@demo.clinic')); const O = as(await login('owner@demo.clinic')); const R = as(await login('reception@demo.clinic'));
  const meds = (await O('GET', '/config')).json().medicines as any[];
  const h = meds.find((m) => m.scheduleClass === 'H'); const otc = meds.find((m) => m.scheduleClass === 'OTC');
  assert.ok(h && otc);
  for (const m of [h, otc]) assert.equal((await P('POST', '/stock/receipts', { lines: [{ medicineId: m.id, qty: 20, ratePaise: 1000, batchNo: 'REG-' + m.name.slice(0, 3), expiry: ym(12) }] })).statusCode, 200);
  // Schedule H never goes to a walk-in; it is sold against the doctor's prescription line
  const walk = (m: any) => P('POST', '/pharmacy/sale', { newPatient: { fullName: 'Register Walkin', phone: '9876500124' }, items: [{ medicineId: m.id, qty: 2 }], method: 'cash' });
  assert.equal((await walk(h)).json().code, 'NEEDS_PRESCRIPTION');
  assert.equal((await walk(otc)).statusCode, 200, 'OTC is fine for a walk-in');
  const [t] = await db.select().from(S.tenant).where(eq(S.tenant.slug, 'sahitya'));
  const [br] = await db.select().from(S.branch).where(eq(S.branch.tenantId, t.id)); const [fee] = await db.select().from(S.feeCategory).where(eq(S.feeCategory.tenantId, t.id));
  const [form] = await db.select().from(S.formDefinition).where(eq(S.formDefinition.tenantId, t.id)); const [doc] = await db.select().from(S.practitioner).where(eq(S.practitioner.tenantId, t.id));
  const [p] = await db.insert(S.patient).values({ tenantId: t.id, patientNo: 'P92001', fullName: 'Register Patient', phone: '9876500123', ageYears: 40, sex: 'M' }).returning();
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const [vi] = await db.insert(S.visit).values({ tenantId: t.id, branchId: br.id, patientId: p.id, feeCategoryId: fee.id, day, opNumber: 'GEN-90', queuePosition: '1', status: 'done' }).returning();
  const [e] = await db.insert(S.encounter).values({ tenantId: t.id, visitId: vi.id, patientId: p.id, practitionerId: doc.id, formDefinitionId: form.id, status: 'completed', completedAt: new Date().toISOString() }).returning();
  const [pi] = await db.insert(S.prescriptionItem).values({ tenantId: t.id, encounterId: e.id, medicineId: h.id, name: h.name, qty: 2, sortOrder: 0 }).returning();
  const a = await P('POST', '/pharmacy/sale', { patientId: p.id, encounterId: e.id, items: [{ medicineId: h.id, qty: 2, prescriptionItemId: pi.id }, { medicineId: otc.id, qty: 1 }], method: 'cash' });
  assert.equal(a.statusCode, 200, a.body);

  const rows = (await P('GET', '/pharmacy/schedule-register')).json();
  assert.equal(rows.length, 1, 'only the scheduled medicine');
  assert.equal(rows[0].medicine, h.name); assert.equal(rows[0].cls, 'H'); assert.equal(rows[0].qty, 2); assert.equal(rows[0].noRx, false, 'prescribed: under the doctor');
  assert.equal(rows[0].doctor, doc.name); assert.equal(rows[0].age, 40); assert.ok(rows[0].batchNo);
  // an older bill with an H line that was not prescribed (before the counter checked): flagged per line, never under the doctor's name
  const [old] = await db.select().from(S.pharmacySale).where(eq(S.pharmacySale.id, a.json().id));
  await db.insert(S.pharmacySale).values({ ...old, id: undefined as any, invoiceNo: 'PH-OLD-1', idempotencyKey: null, items: [{ ...old.items[0], prescriptionItemId: null }], returns: [] });
  const legacy = (await P('GET', '/pharmacy/schedule-register')).json().find((r: any) => r.invoiceNo === 'PH-OLD-1');
  assert.equal(legacy.noRx, true); assert.equal(legacy.doctor, null); assert.equal(legacy.regNo, null);
  assert.equal((await P('GET', '/pharmacy/schedule-register?cls=X')).json().length, 0, 'class filter');
  assert.equal((await P('GET', '/pharmacy/schedule-register?from=2030-02-01&to=2030-01-01')).statusCode, 400);

  // a return shows in the Returned column
  const sid = a.json().id; const ret = await P('POST', `/pharmacy/sale/${sid}/return`, { reason: 'wrong strength', method: 'cash', lines: [{ line: 0, qty: 1 }] });
  assert.equal(ret.statusCode, 200, ret.body);
  assert.equal((await P('GET', '/pharmacy/schedule-register')).json().find((r: any) => r.invoiceNo === a.json().invoiceNo).returned, 1);

  // exporting is allowed for the pharmacist (a legal record) and goes in the audit log; reception has no pharmacy access
  assert.equal((await R('GET', '/pharmacy/schedule-register')).statusCode, 403);
  assert.equal((await P('POST', '/pharmacy/schedule-register/export', { from: '2026-10-01', to: '2026-10-29', how: 'print' })).statusCode, 200);
  assert.ok((await O('GET', '/audit?kind=print')).json().some((x: any) => x.summary.startsWith('Printed the Schedule H register')));
});
