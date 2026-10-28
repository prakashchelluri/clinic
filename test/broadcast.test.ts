// Bulk messages to patients: permission, audiences, recipients left out, demo recording, history, and the patient's own message list.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-broadcast';
process.env.UPLOAD_DIR = './data/test-uploads-broadcast';
process.env.COOKIE_SECRET = 'test-secret';
rmSync(process.env.PGLITE_DIR, { recursive: true, force: true });

const { migrate, applyRls } = await import('../src/db/index.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { buildApp } = await import('../src/app.js');

let app: Awaited<ReturnType<typeof buildApp>>;
const login = async (email: string) => (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenant: 'sahitya' } })).cookies.find((c) => c.name === 'cc_session')!.value;
before(async () => { await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp(); });
after(async () => { await app.close(); });

test('bulk message: only for those allowed, recorded as demo, listed with who got it', async () => {
  const owner = await login('owner@demo.clinic'); const reception = await login('reception@demo.clinic');
  const call = (c: string, method: 'GET' | 'POST', url: string, payload?: unknown) => app.inject({ method, url: '/api' + url, cookies: { cc_session: c }, payload: payload as any });

  assert.equal((await call(reception, 'POST', '/broadcasts/preview', { audience: 'all' })).statusCode, 403, 'reception does not have the permission by default');

  const mk = async (fullName: string, phone: string | null) => (await call(owner, 'POST', '/patients?force=1', { fullName, phone })).json();
  const a = await mk('Arun Kumar', '9876500011'); const b = await mk('Bhavani', '9876500012'); await mk('No Phone', null); await mk('Bad Phone', '12345'); // the registration form already refuses a malformed number, so only the one without a number is left out

  const all = (await call(owner, 'POST', '/broadcasts/preview', { audience: 'all' })).json();
  assert.equal(all.total, 2, 'two valid numbers'); assert.equal(all.skipped, 1, 'the patient without a number is left out');
  assert.deepEqual(all.recipients.map((r: any) => r.fullName).sort(), ['Arun Kumar', 'Bhavani']);
  assert.equal((await call(owner, 'POST', '/broadcasts/preview', { audience: 'pick', ids: [a.id] })).json().total, 1);
  assert.equal((await call(owner, 'POST', '/broadcasts/preview', { audience: 'recent', days: 30 })).json().total, 0, 'nobody has visited');

  assert.equal((await call(owner, 'POST', '/broadcasts', { audience: 'all', ids: [a.id], body: '   ' })).statusCode, 400, 'empty message');
  assert.equal((await call(owner, 'POST', '/broadcasts', { audience: 'all', ids: [], body: 'Hi' })).statusCode, 400, 'no recipients');

  const sent = await call(owner, 'POST', '/broadcasts', { audience: 'all', ids: [a.id, b.id], body: 'Hello {name}, this is {clinic}. Camp on Sunday.' });
  assert.equal(sent.statusCode, 200, sent.body); assert.equal(sent.json().recipients, 2); assert.equal(sent.json().mode, 'demo');

  const detail = (await call(owner, 'GET', `/broadcasts/${sent.json().id}`)).json();
  assert.equal(detail.to.length, 2); assert.ok(detail.to.every((t: any) => t.status === 'logged'), 'recorded, not sent');
  assert.equal((await call(owner, 'GET', '/broadcasts')).json().length, 1);

  const msgs = (await call(owner, 'GET', `/messages?patientId=${a.id}`)).json();
  assert.equal(msgs.length, 1); assert.match(msgs[0].body, /^Hello Arun Kumar, this is Sahitya Dermatology Hospital\. Camp on Sunday\.$/);

  assert.equal((await call(owner, 'POST', '/broadcasts/test', { body: 'Test for {name}', phone: '9876599999' })).statusCode, 200);
  assert.equal((await call(owner, 'POST', '/broadcasts/test', { body: 'x', phone: '123' })).statusCode, 400, 'a test needs a real number');
});
