// Settings v66: a consultation type is one record (fee + visit type kept in step); medicines are kept from Inventory; lab tests and expense categories are the clinic's own lists.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-settings66';
process.env.UPLOAD_DIR = './data/test-uploads-settings66';
process.env.COOKIE_SECRET = 'test-secret';
rmSync(process.env.PGLITE_DIR, { recursive: true, force: true });
rmSync(process.env.UPLOAD_DIR, { recursive: true, force: true });

const { migrate, applyRls } = await import('../src/db/index.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { buildApp } = await import('../src/app.js');

let app: Awaited<ReturnType<typeof buildApp>>;
type Call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => Promise<{ status: number; body: any }>;
async function as(email: string, password = 'demo1234'): Promise<Call> {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password, tenant: 'sahitya' } });
  assert.equal(r.statusCode, 200, r.body);
  const cookie = r.cookies.find((c) => c.name === 'cc_session')!.value;
  return (method, url, payload) => app.inject({ method, url: '/api' + url, payload: payload as any, cookies: { cc_session: cookie } }).then((res) => ({ status: res.statusCode, body: res.body ? (res.headers['content-type']?.includes('json') ? res.json() : res.body) : null }));
}

before(async () => { await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp(); });
after(async () => { await app.close(); });

test('consultation types: fee and visit type are one record, kept in step', async () => {
  const owner = await as('owner@demo.clinic');
  const list = (await owner('GET', '/admin/consult-types')).body;
  const gen = list.types.find((t: any) => t.code === 'GEN');
  assert.ok(gen.booking, 'the starter New consultation is tied to its fee');

  // a new type, booked on the calendar: its visit type is made with the same name and fee
  const doc = (await owner('GET', '/config')).body.practitioners[0].id;
  const add = await owner('POST', '/admin/consult-types', { fee: { code: 'HAIR', name: 'Hair consultation', amountPaise: 70000, eligibility: { '<=': [{ var: 'days_since_last_paid_consult' }, 6] } }, booking: { bookable: true, places: 2, color: '#6D5E86', practitionerIds: [doc], description: 'Hair loss and scalp' } });
  assert.equal(add.status, 200, JSON.stringify(add.body));
  assert.equal(add.body.booking.name, 'Hair consultation'); assert.equal(add.body.booking.pricePaise, 70000); assert.equal(add.body.booking.places, 2); assert.equal(add.body.booking.active, true);
  assert.equal((await owner('POST', '/admin/consult-types', { fee: { code: 'HAIR', name: 'Again', amountPaise: 1 } })).body.code, 'DUPLICATE_CODE');

  // renaming and repricing the fee carries to the booking side; the code stays
  const ed = await owner('PATCH', `/admin/consult-types/${add.body.id}`, { fee: { name: 'Hair & scalp', amountPaise: 80000, code: 'XXX' }, booking: { bookable: true, places: 1 } });
  assert.equal(ed.status, 200, JSON.stringify(ed.body));
  assert.equal(ed.body.code, 'HAIR'); assert.equal(ed.body.booking.name, 'Hair & scalp'); assert.equal(ed.body.booking.pricePaise, 80000); assert.equal(ed.body.booking.places, 1);
  const cfg = (await owner('GET', '/config')).body;
  assert.ok(cfg.services.some((s: any) => s.name === 'Hair & scalp'), 'the desk can book it');

  // not booked any more: the visit type is archived, the fee stays for check-in
  const off = await owner('PATCH', `/admin/consult-types/${add.body.id}`, { booking: { bookable: false } });
  assert.equal(off.body.active, true); assert.equal(off.body.booking.active, false);
  assert.ok(!(await owner('GET', '/config')).body.services.some((s: any) => s.name === 'Hair & scalp'));
  // archiving the type archives both
  const arch = await owner('PATCH', `/admin/consult-types/${add.body.id}`, { fee: { active: false }, booking: { bookable: true } });
  assert.equal(arch.body.active, false); assert.equal(arch.body.booking.active, false);

  // reception cannot change them
  const reception = await as('reception@demo.clinic');
  assert.equal((await reception('PATCH', `/admin/consult-types/${gen.id}`, { fee: { amountPaise: 1 } })).status, 403);
  // the audit names the fee change in rupees
  await owner('PATCH', `/admin/consult-types/${gen.id}`, { fee: { amountPaise: 40000 } });
});

test('medicines: Inventory keeps the list; reception cannot', async () => {
  const pharmacy = await as('pharmacy@demo.clinic'); const reception = await as('reception@demo.clinic');
  const add = await pharmacy('POST', '/admin/medicines', { name: 'Test Doxy 100 mg', form: 'cap', scheduleClass: 'H', mrpPaise: 6200, gstBp: 1200, packSize: 10, reorderLevel: 4 });
  assert.equal(add.status, 200, JSON.stringify(add.body));
  assert.equal((await pharmacy('PATCH', `/admin/medicines/${add.body.id}`, { mrpPaise: 6500, defaults: { dose: '1 cap', frequency: '1-0-1' } })).body.mrpPaise, 6500);
  assert.equal((await reception('POST', '/admin/medicines', { name: 'Nope 1 mg' })).status, 403);
  assert.equal((await reception('PATCH', `/admin/medicines/${add.body.id}`, { mrpPaise: 1 })).status, 403);
});

test('lab tests and expense categories: the clinic’s own lists', async () => {
  const owner = await as('owner@demo.clinic');
  const before = (await owner('GET', '/config')).body;
  assert.ok(before.labTests.includes('CBC') && before.expenseCategories.includes('Rent'), 'standard lists until the clinic sets its own');
  assert.equal((await owner('PATCH', '/admin/clinic', { settings: { labTests: ['CBC', 'Serum IgE'] } })).status, 200);
  assert.equal((await owner('PATCH', '/admin/clinic', { settings: { labTests: ['CBC', 'cbc'] } })).status, 400, 'no repeats');
  assert.equal((await owner('PATCH', '/admin/clinic', { settings: { expenseCategories: [] } })).status, 400, 'never empty');
  assert.equal((await owner('PATCH', '/admin/clinic', { settings: { expenseCategories: ['Rent', 'Laundry'] } })).status, 200);
  const cfg = (await owner('GET', '/config')).body;
  assert.deepEqual(cfg.labTests, ['CBC', 'Serum IgE']); assert.deepEqual(cfg.expenseCategories, ['Rent', 'Laundry']);
  const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  assert.equal((await owner('POST', '/expenses', { description: 'Sheets', amountPaise: 50000, method: 'cash', category: 'Laundry', day })).status, 200);
  assert.equal((await owner('POST', '/expenses', { description: 'Tea', amountPaise: 5000, method: 'cash', category: 'Tea and snacks', day })).body.code, 'BAD_CATEGORY');
});
