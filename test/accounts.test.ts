// Staff accounts and patient records: a generated first password that must be changed, owner/admin password reset,
// "no WhatsApp" honoured by messages to many, duplicate warnings, and the owner's merge of two records.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-accounts';
process.env.UPLOAD_DIR = './data/test-uploads-accounts';
process.env.COOKIE_SECRET = 'test-secret';
rmSync(process.env.PGLITE_DIR, { recursive: true, force: true });

const { migrate, applyRls } = await import('../src/db/index.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { buildApp } = await import('../src/app.js');
const { similarName } = await import('../src/modules/patients.js');

let app: Awaited<ReturnType<typeof buildApp>>;
const signIn = (email: string, password = 'demo1234') => app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password, tenant: 'sahitya' } });
async function as(email: string, password = 'demo1234') {
  const r = await signIn(email, password); assert.equal(r.statusCode, 200, r.body);
  const c = r.cookies.find((x) => x.name === 'cc_session')!.value;
  return (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown) => app.inject({ method, url: '/api' + url, cookies: { cc_session: c }, payload: payload as any }).then((x) => ({ status: x.statusCode, body: x.body ? x.json() : null }));
}
before(async () => { await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp(); });
after(async () => { await app.close(); });

test('a new staff member gets a first password shown once, and must pick their own before anything else works', async () => {
  const owner = await as('owner@demo.clinic');
  const made = await owner('POST', '/admin/users', { name: 'New Desk', email: 'newdesk@demo.clinic', roles: ['receptionist'] });
  assert.equal(made.status, 200); assert.equal(made.body.mustChangePassword, true);
  const first: string = made.body.firstPassword; assert.match(first, /^[A-Za-z2-9]{10}$/);
  assert.equal((await owner('GET', '/users')).body.find((u: any) => u.email === 'newdesk@demo.clinic').firstPassword, undefined, 'never shown again');

  const desk = await as('newdesk@demo.clinic', first);
  assert.equal((await desk('GET', '/me')).body.mustChangePassword, true);
  const blocked = await desk('GET', '/patients');
  assert.equal(blocked.status, 403); assert.equal(blocked.body.code, 'MUST_CHANGE_PASSWORD');
  assert.equal((await desk('PATCH', '/me/password', { currentPassword: first, newPassword: 'mine-1234' })).status, 200);
  assert.equal((await desk('GET', '/patients')).status, 200, 'works once their own password is set');
  assert.equal((await signIn('newdesk@demo.clinic', first)).statusCode, 401, 'the first password is gone');
});

test('owner or admin resets a password; an admin cannot reset an owner, nobody resets their own here', async () => {
  const owner = await as('owner@demo.clinic');
  assert.equal((await owner('POST', '/admin/users', { name: 'Admin Two', email: 'admin2@demo.clinic', password: 'secret12', roles: ['admin'] })).status, 200);
  const admin = await as('admin2@demo.clinic', 'secret12');
  const users = (await owner('GET', '/users')).body;
  const desk = users.find((u: any) => u.email === 'newdesk@demo.clinic'); const me = users.find((u: any) => u.email === 'owner@demo.clinic');

  const r = await admin('POST', `/admin/users/${desk.id}/reset-password`);
  assert.equal(r.status, 200); assert.ok(r.body.firstPassword);
  assert.equal((await signIn('newdesk@demo.clinic', 'mine-1234')).statusCode, 401, 'old password stops working');
  const again = await as('newdesk@demo.clinic', r.body.firstPassword);
  assert.equal((await again('GET', '/patients')).body.code, 'MUST_CHANGE_PASSWORD');

  assert.equal((await admin('POST', `/admin/users/${me.id}/reset-password`)).body.code, 'OWNER_ONLY_EDIT');
  assert.equal((await owner('POST', `/admin/users/${me.id}/reset-password`)).body.code, 'USE_CHANGE_MY_PASSWORD');
  const audit = (await owner('GET', '/audit?kind=settings')).body;
  assert.ok(audit.some((a: any) => a.action === 'user.password_reset' && a.summary.includes('New Desk')), 'the reset is in the audit log');
});

test('no WhatsApp: left out of messages to many, and reminders are skipped', async () => {
  const owner = await as('owner@demo.clinic');
  const a = (await owner('POST', '/patients?force=1', { fullName: 'Opted In', phone: '9811100001' })).body;
  const b = (await owner('POST', '/patients?force=1', { fullName: 'Opted Out', phone: '9811100002', noWhatsapp: true, language: 'te' })).body;
  assert.equal(b.noWhatsapp, true); assert.equal(b.language, 'te');
  const prev = (await owner('POST', '/broadcasts/preview', { audience: 'pick', ids: [a.id, b.id] })).body;
  assert.equal(prev.total, 1); assert.equal(prev.optedOut, 1); assert.deepEqual(prev.recipients.map((r: any) => r.fullName), ['Opted In']);
  const sent = await owner('POST', '/broadcasts', { audience: 'pick', ids: [a.id, b.id], body: 'Camp on Sunday' });
  assert.equal(sent.body.recipients, 1, 'even if the browser sends the id, the server leaves them out');
  const to = (await owner('GET', `/broadcasts/${sent.body.id}`)).body.to;
  assert.deepEqual(to.map((x: any) => x.name), ['Opted In']);
  assert.equal((await owner('PATCH', `/patients/${a.id}`, { language: 'fr' })).status, 400, 'only English, Telugu or Hindi');

  // booking messages (confirmation, reminders) for the opted-out patient are recorded as skipped, never sent
  const cfg = (await owner('GET', '/config')).body;
  const day = new Date(Date.now() + 3 * 86400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const w = (await owner('GET', `/sessions?day=${day}&practitionerId=${cfg.practitioners[0].id}`)).body.find((x: any) => x.free > 0);
  assert.ok(w, 'a free window three days out');
  assert.equal((await owner('POST', '/appointments', { sessionId: w.id, patientId: b.id, notify: true })).status, 200);
  const msgs = (await owner('GET', `/messages?patientId=${b.id}`)).body;
  assert.ok(msgs.length > 0, 'reminders are planned');
  assert.ok(msgs.every((m: any) => m.status === 'skipped' && m.error === 'patient asked for no WhatsApp messages'));
  // opting out later drops reminders already planned
  assert.equal((await owner('POST', '/appointments', { sessionId: w.id, patientId: a.id, notify: true })).status, 200);
  assert.ok((await owner('GET', `/messages?patientId=${a.id}&status=pending`)).body.length > 0);
  await owner('PATCH', `/patients/${a.id}`, { noWhatsapp: true });
  assert.equal((await owner('GET', `/messages?patientId=${a.id}&status=pending`)).body.length, 0);
});

test('duplicates: same phone and a similar name, or same name and age, are warned about', async () => {
  assert.ok(similarName('Ravi Kumar', 'K. Ravi Kumar')); assert.ok(similarName('Ravi Kumar', 'Ravi Kumaar')); assert.ok(!similarName('Ravi Kumar', 'Sita Kumar'));
  const owner = await as('owner@demo.clinic');
  const p = (await owner('POST', '/patients', { fullName: 'Ravi Kumar', phone: '9822200001', ageYears: 34 })).body;
  let r = await owner('POST', '/patients', { fullName: 'K. Ravi Kumar', phone: '9822200001' });
  assert.equal(r.status, 409); assert.equal(r.body.code, 'POSSIBLE_DUPLICATE'); assert.equal(r.body.existing.id, p.id); assert.equal(r.body.existing.why, 'same phone, similar name');
  r = await owner('POST', '/patients', { fullName: 'ravi  kumar', phone: '9000000000', ageYears: 34 });
  assert.equal(r.body.existing?.why, 'same name and age');
  assert.equal((await owner('POST', '/patients', { fullName: 'Sita Kumar', phone: '9822200001' })).status, 200, 'family on one phone is fine');
});

test('merge: the owner moves everything to the kept record and archives the other; nobody else can', async () => {
  const owner = await as('owner@demo.clinic'); const reception = await as('reception@demo.clinic');
  const keep = (await owner('POST', '/patients?force=1', { fullName: 'Meena Rao', phone: '9833300001', allergies: 'Penicillin' })).body;
  const drop = (await owner('POST', '/patients?force=1', { fullName: 'Meena R', phone: '9833300001', dob: '1990-05-01', allergies: 'Sulfa' })).body;
  // something on the duplicate: a visit with its fee

  const v = await reception('POST', '/visits', { patientId: drop.id, feeCategoryCode: 'GEN', payment: { method: 'cash', amountPaise: 30000 } });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.ok((await owner('GET', `/patients/${keep.id}/duplicates`)).body.some((d: any) => d.id === drop.id));

  assert.equal((await reception('POST', `/patients/${keep.id}/merge`, { dropId: drop.id })).body.code, 'ONLY_OWNER_MERGES');
  assert.equal((await owner('POST', `/patients/${keep.id}/merge`, { dropId: keep.id })).body.code, 'SAME_PATIENT');
  const m = await owner('POST', `/patients/${keep.id}/merge`, { dropId: drop.id });
  assert.equal(m.status, 200, JSON.stringify(m.body)); assert.ok(m.body.moved.visit >= 1);

  const t = (await owner('GET', `/patients/${keep.id}/timeline`)).body;
  assert.equal(t.visits.length, 1, 'the visit moved'); assert.equal(t.patient.dob, '1990-05-01', 'missing details filled in');
  assert.match(t.patient.allergies, /Penicillin/); assert.match(t.patient.allergies, /Sulfa/);
  assert.equal((await owner('GET', `/patients/${drop.id}/timeline`)).body.patient.mergedInto, keep.id, 'the duplicate is archived, not deleted');
  assert.ok(!(await owner('GET', '/patients?q=Meena')).body.some((x: any) => x.id === drop.id), 'and gone from search');
  assert.equal((await owner('POST', `/patients/${keep.id}/merge`, { dropId: drop.id })).body.code, 'ALREADY_MERGED');
  assert.ok((await owner('GET', `/audit?patientId=${keep.id}`)).body.some((a: any) => a.action === 'patient.merged'));
});
