// Patient languages (WhatsApp, patient link, TV), receipt numbers per financial year, and the GST format of a receipt.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-langreceipts';
process.env.COOKIE_SECRET = 'test-secret';
delete process.env.WHATSAPP_TOKEN;
rmSync(process.env.PGLITE_DIR, { recursive: true, force: true });

const { migrate, applyRls } = await import('../src/db/index.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { buildApp } = await import('../src/app.js');
const { patientLang } = await import('../src/lib/patientText.js');
const { templateFor } = await import('../src/lib/booking.js');
const { fyOf, gstSummary } = await import('../src/modules/billing.js');

let app: Awaited<ReturnType<typeof buildApp>>;
const login = async (email: string) => (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenant: 'sahitya' } })).cookies.find((c) => c.name === 'cc_session')!.value;
const as = (c: string) => async (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) => { const r = await app.inject({ method, url: '/api' + url, cookies: { cc_session: c }, payload: payload as any }); return { status: r.statusCode, body: r.body ? r.json() : null }; };
const anon = async (url: string) => { const r = await app.inject({ method: 'GET', url: '/api' + url }); return { status: r.statusCode, body: r.json() }; };
const addDays = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
before(async () => { await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp(); });
after(async () => { await app.close(); });

test('template language: the patient\'s own, else the clinic default, else English; clinic text is for English only', () => {
  assert.equal(patientLang({ language: 'hi' }, { messages: { language: 'te' } }), 'hi');
  assert.equal(patientLang({}, { messages: { language: 'te' } }), 'te', 'no column yet: the clinic default');
  assert.equal(patientLang({ language: null }, {}), 'en');
  assert.equal(patientLang({ language: 'fr' }, { messages: { language: 'xx' } }), 'en', 'unknown values fall back to English');
  const custom = { messages: { templates: { confirmation: 'Our own text {patient}' } } };
  assert.equal(templateFor('confirmation', 'en', custom), 'Our own text {patient}');
  assert.match(templateFor('confirmation', 'te', custom), /నమస్తే/);
  assert.match(templateFor('late', 'hi', {}), /\{minutes\} मिनट/);
});

test('booking messages, patient link and TV board follow the clinic\'s patient language', async () => {
  const O = as(await login('owner@demo.clinic')); const R = as(await login('reception@demo.clinic'));
  assert.equal((await O('PATCH', '/admin/clinic', { settings: { messages: { language: 'xx' } } })).status, 400, 'only en, te or hi');
  assert.equal((await O('PATCH', '/admin/clinic', { settings: { messages: { language: 'te' } } })).status, 200);
  const cfg = (await R('GET', '/config')).body;
  const doc = cfg.practitioners.find((p: any) => p.name.startsWith('Dr. Main')).id;
  const w = (await R('GET', `/sessions?day=${addDays(today(), 3)}&practitionerId=${doc}`)).body.find((x: any) => x.free > 0);
  const made = await R('POST', '/appointments', { sessionId: w.id, newPatient: { fullName: 'Telugu Patient', phone: '9876511111' } });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const msgs = (await R('GET', `/appointments/${made.body.id}`)).body.messages;
  const conf = msgs.find((m: any) => m.kind === 'confirmation');
  assert.match(conf.body, /నమస్తే Telugu Patient గారు/, 'Telugu text, the name as it is');
  assert.equal(conf.params.lang, 'te', 'the WhatsApp template is asked for in Telugu too');
  assert.ok(!/\{\w+\}/.test(conf.body), 'no unfilled placeholders');
  const link = await anon(`/public/a/sahitya/${made.body.publicToken}`);
  assert.equal(link.body.lang, 'te');
  const token = (await O('GET', '/admin/display')).body.url.split('/').pop();
  assert.equal((await anon(`/public/display/sahitya/${token}`)).body.lang, 'te');
  await O('PATCH', '/admin/clinic', { settings: { messages: { language: 'en' } } });
});

test('receipt numbers: one series per clinic per financial year, on check-in fees and in the payment list', async () => {
  assert.equal(fyOf('2026-11-11'), '2026-27'); assert.equal(fyOf('2027-03-31'), '2026-27'); assert.equal(fyOf('2027-04-01'), '2027-28');
  const R = as(await login('reception@demo.clinic'));
  const nos: string[] = [];
  for (const name of ['Receipt One', 'Receipt Two']) {
    const p = (await R('POST', '/patients', { fullName: name, phone: `98765${String(22000 + nos.length).padStart(5, '0')}` })).body;
    const v = await R('POST', '/visits', { patientId: p.id, feeCategoryCode: 'GEN', payment: { method: 'cash', amountPaise: 30000 } });
    assert.equal(v.status, 200, JSON.stringify(v.body));
    nos.push(v.body.receiptNo);
  }
  const fy = fyOf(today());
  for (const no of nos) assert.match(no, new RegExp(`^R-${fy}-\\d{4}$`));
  assert.equal(Number(nos[1].slice(-4)), Number(nos[0].slice(-4)) + 1, 'no gaps between two check-ins');
  const O = as(await login('owner@demo.clinic'));
  const daily = (await O('GET', '/reports/daily')).body;
  assert.ok(nos.every((no) => daily.payments.some((p: any) => p.receiptNo === no)), 'the payment list shows the receipt number');
  const rc = (await O('GET', `/receipts/${nos[0]}`)).body;
  assert.equal(rc.receiptNo, nos[0]); assert.notEqual(rc.receivedBy, '—', 'received by is kept');
});

test('a clinic with no GSTIN prints a bill of supply with no CGST/SGST; with one, a tax invoice with rate-wise tax', async () => {
  assert.deepEqual(gstSummary(null, [{ amountPaise: 118000, taxRateBp: 1800 }]).rates, []);
  const O = as(await login('owner@demo.clinic'));
  const p = (await O('POST', '/patients', { fullName: 'Gst Patient', phone: '9876533333' })).body;
  const ch = (await O('POST', '/charges', { patientId: p.id, description: 'Chemical peel session 1', amountPaise: 118000, taxRateBp: 1800 })).body;
  const ex = (await O('POST', '/charges', { patientId: p.id, description: 'Consultation', amountPaise: 30000 })).body;
  await O('PATCH', '/admin/clinic', { settings: { gstin: '' } });
  const paid = await O('POST', '/payments/take', { patientId: p.id, chargeIds: [ch.id, ex.id], idempotencyKey: 'gst-take-1', parts: [{ method: 'upi', amountPaise: 148000, reference: 'UPI1' }] });
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  const plain = (await O('GET', `/receipts/${paid.body.receiptNo}`)).body;
  assert.equal(plain.tax.title, 'Bill of Supply'); assert.equal(plain.tax.gstin, null); assert.deepEqual(plain.tax.rates, [], 'no CGST/SGST lines');

  assert.equal((await O('PATCH', '/admin/clinic', { settings: { gstin: 'bad' } })).status, 400, 'a GSTIN has 15 characters');
  assert.equal((await O('PATCH', '/admin/clinic', { settings: { gstin: '37abcde1234f1z5' } })).status, 200);
  const inv = (await O('GET', `/receipts/${paid.body.receiptNo}`)).body;
  assert.equal(inv.tax.title, 'Tax Invoice'); assert.equal(inv.tax.gstin, '37ABCDE1234F1Z5');
  assert.deepEqual(inv.tax.rates, [
    { rateBp: 0, taxablePaise: 30000, cgstPaise: 0, sgstPaise: 0 },
    { rateBp: 1800, taxablePaise: 100000, cgstPaise: 9000, sgstPaise: 9000 },
  ]);
  await O('PATCH', '/admin/clinic', { settings: { gstin: '' } });
});
