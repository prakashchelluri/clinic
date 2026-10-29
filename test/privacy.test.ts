// Privacy and access: work only from the clinic (IP lock), hidden phone numbers, owner-only lists, and an audit log nobody can edit.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-privacy';
process.env.COOKIE_SECRET = 'test-secret';
rmSync(process.env.PGLITE_DIR, { recursive: true, force: true });

const { migrate, applyRls, db, withTenant } = await import('../src/db/index.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { buildApp } = await import('../src/app.js');
const { ipAllowed } = await import('../src/lib/audit.js');
const { sql } = await import('drizzle-orm');

let app: Awaited<ReturnType<typeof buildApp>>;
const CLINIC = '10.9.9.9', HOME = '182.73.4.9';
const login = async (email: string, ip = CLINIC) => app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenant: 'sahitya' }, remoteAddress: ip });
const cookie = async (email: string, ip = CLINIC) => (await login(email, ip)).cookies.find((c) => c.name === 'cc_session')!.value;
const as = (c: string, ip = CLINIC) => (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) => app.inject({ method, url: '/api' + url, cookies: { cc_session: c }, payload: payload as any, remoteAddress: ip });
before(async () => { await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp(); });
after(async () => { await app.close(); });

test('address matching: single addresses and IPv4 ranges', () => {
  const list = [{ label: 'a', from: '49.205.12.34' }, { label: 'b', from: '106.51.0.0', to: '106.51.255.255' }];
  assert.ok(ipAllowed('49.205.12.34', list)); assert.ok(ipAllowed('::ffff:49.205.12.34', list)); assert.ok(ipAllowed('106.51.7.200', list));
  assert.ok(!ipAllowed('49.205.12.35', list)); assert.ok(!ipAllowed('106.52.0.1', list)); assert.ok(!ipAllowed('not-an-ip', list));
});

test('work only from the clinic: staff stopped elsewhere, owner and named people free, owner sees and allows new addresses', async () => {
  const O = as(await cookie('owner@demo.clinic', HOME), HOME);
  const rcCookie = await cookie('reception@demo.clinic', CLINIC);
  const sec = (await O('GET', '/security')).json();
  assert.equal(sec.security.ipLock.enabled, false);
  assert.equal(sec.myIp, HOME);
  const base = { ...sec.security, ipLock: { ...sec.security.ipLock, enabled: true, allowed: [] } };
  assert.equal((await O('PUT', '/security', base)).statusCode, 409, 'cannot turn on with no address');
  assert.equal((await O('PUT', '/security', { ...base, ipLock: { ...base.ipLock, allowed: [{ label: 'x', from: '999.1.1.1' }] } })).statusCode, 400, 'bad address');
  assert.equal((await as(rcCookie)('PUT', '/security', base)).statusCode, 403, 'reception cannot change it');
  const D2 = as(await cookie('doctor2@demo.clinic', CLINIC), HOME); // signed in at the clinic, then went home
  const doc2 = sec.users.find((u: any) => u.roles.includes('doctor') && !u.roles.includes('owner'));
  const on = (await O('PUT', '/security', { ...base, ipLock: { ...base.ipLock, allowed: [{ label: 'Clinic broadband', from: CLINIC }, { label: 'Backup', from: '10.0.0.0', to: '10.0.0.255' }], anywhere: [] } })).json();
  assert.equal(on.ipLock.enabled, true);

  assert.equal((await as(rcCookie, CLINIC)('GET', '/me')).statusCode, 200, 'at the clinic');
  assert.equal((await as(rcCookie, '10.0.0.77')('GET', '/me')).statusCode, 200, 'inside the allowed range');
  const out = await as(rcCookie, HOME)('GET', '/patients');
  assert.equal(out.statusCode, 403); assert.equal(out.json().code, 'IP_NOT_ALLOWED'); assert.equal(out.json().ip, HOME);
  assert.equal((await login('reception@demo.clinic', '49.205.13.2')).statusCode, 403, 'sign-in from outside is stopped');
  assert.equal((await D2('GET', '/me')).statusCode, 403, 'a session taken home is stopped mid-way');
  assert.equal((await O('GET', '/me')).statusCode, 200, 'owner works from anywhere');

  // the owner sees who was stopped, lets the doctor work from anywhere, and allows the receptionist's new address
  const s2 = (await O('GET', '/security')).json();
  assert.ok(s2.stopped.some((x: any) => x.ip === '49.205.13.2' && x.name.includes('Lakshmi')));
  await O('PUT', '/security', { ...s2.security, ipLock: { ...s2.security.ipLock, anywhere: [doc2.id], allowed: [...s2.security.ipLock.allowed, { label: 'Reception new', from: '49.205.13.2' }] } });
  assert.equal((await D2('GET', '/me')).statusCode, 200, 'doctor may work from anywhere now');
  assert.equal((await login('reception@demo.clinic', '49.205.13.2')).statusCode, 200, 'new address allowed');
  assert.ok(!(await O('GET', '/security')).json().stopped.some((x: any) => x.ip === '49.205.13.2'), 'no longer listed once allowed');

  // admin cannot slip privacy settings in through the clinic settings
  const s3 = (await O('GET', '/security')).json();
  assert.equal((await O('PATCH', '/admin/clinic', { settings: { security: { ipLock: { enabled: false } } } })).statusCode, 403);
  // staff never receive the allowed addresses
  assert.equal((await as(rcCookie)('GET', '/config')).json().tenant.settings.security, undefined);
  // switch off for the next tests
  await O('PUT', '/security', { ...s3.security, ipLock: { ...s3.security.ipLock, enabled: false } });
});

test('phone numbers hidden for roles not ticked; saving with a hidden number keeps the real one', async () => {
  const R = as(await cookie('reception@demo.clinic')); const P = as(await cookie('pharmacy@demo.clinic'));
  const p = (await R('POST', '/patients', { fullName: 'Privacy Patient', phone: '9876543210' })).json();
  assert.equal((await R('GET', `/patients?q=Privacy`)).json()[0].phone, '9876543210', 'reception sees it');
  const masked = (await P('GET', `/patients?q=Privacy`)).body;
  assert.ok(!masked.includes('9876543210') && masked.includes('98••• ••210'), 'pharmacy sees it hidden');
  assert.equal((await P('GET', '/me')).json().privacy.seePhones, false);
  // a role with patient.write but no phones saves the form unchanged
  const O = as(await cookie('owner@demo.clinic'));
  const sec = (await O('GET', '/security')).json().security;
  await O('PUT', '/security', { ...sec, phoneRoles: sec.phoneRoles.filter((r: string) => r !== 'receptionist') });
  const shown = (await R('GET', `/patients?q=Privacy`)).json()[0];
  assert.equal(shown.phone, '98••• ••210');
  assert.equal((await R('PATCH', `/patients/${p.id}`, { fullName: 'Privacy Patient Two', phone: shown.phone })).statusCode, 200);
  await O('PUT', '/security', sec);
  assert.equal((await R('GET', `/patients?q=Privacy`)).json()[0].phone, '9876543210', 'real number kept');
});

test('audit log: every change, views with unusual, sign-ins, lists owner-only, nobody can edit it', async () => {
  const O = as(await cookie('owner@demo.clinic')); const R = as(await cookie('reception@demo.clinic')); const D2 = as(await cookie('doctor2@demo.clinic'));
  const p = (await R('POST', '/patients', { fullName: 'Audit Patient', phone: '9876500099' })).json();
  const free = (await R('GET', '/calendar/free?days=7')).json();
  const a = (await R('POST', '/appointments', { sessionId: free[0].sessionId, patientId: p.id })).json();
  await R('PATCH', `/appointments/${a.id}`, { status: 'cancelled', cancelReason: 'patient called' });
  await D2('GET', `/patients/${p.id}/timeline`);
  const meds = (await O('GET', '/config')).json().medicines; const m = meds[0];
  await O('PATCH', `/admin/medicines/${m.id}`, { mrpPaise: m.mrpPaise + 1000 });

  assert.equal((await R('GET', '/audit')).statusCode, 403, 'reception cannot read the log');
  const log = (await O('GET', '/audit?days=1')).json();
  const s = (x: any) => x.summary;
  assert.ok(log.some((x: any) => x.summary.startsWith('Registered a patient') && x.userName.includes('Lakshmi')));
  assert.ok(log.some((x: any) => s(x) === 'Booked an appointment' && x.patientId === p.id));
  assert.ok(log.some((x: any) => s(x) === 'Cancelled a booking · patient called' && x.kind === 'change'));
  const price = log.find((x: any) => s(x) === 'Changed a medicine');
  assert.equal(price.before.mrpPaise, m.mrpPaise); assert.equal(price.after.mrpPaise, m.mrpPaise + 1000);
  const view = log.find((x: any) => x.kind === 'view' && x.patientId === p.id);
  assert.ok(view && view.unusual, 'opened with no visit today: unusual');
  assert.equal(view.patient, 'Audit Patient');
  assert.ok(log.some((x: any) => x.kind === 'signin' && x.summary === 'Signed in'));
  assert.ok(!JSON.stringify(log).includes('demo1234'), 'no passwords in the log');
  assert.ok((await O('GET', `/audit?patientId=${p.id}`)).json().every((x: any) => x.patientId === p.id));
  assert.ok((await O('GET', '/audit?unusual=true')).json().every((x: any) => x.unusual));
  assert.ok((await O('GET', `/patients/${p.id}/seen-by`)).json().some((x: any) => x.name.includes('Second')));

  // lists of patients: owner only by default, and recorded
  assert.equal((await R('POST', '/audit/event', { kind: 'print', what: 'Front desk list', count: 12 })).statusCode, 403);
  assert.equal((await O('POST', '/audit/event', { kind: 'print', what: 'Front desk list', count: 12 })).statusCode, 200);
  assert.ok((await O('GET', '/audit?kind=print')).json().some((x: any) => x.summary === 'Front desk list · 12 patients'));

  // the log cannot be changed, even by a database query inside the app
  const tid = log[0].tenantId;
  await assert.rejects(withTenant(tid, log[0].userId, (tx: any) => tx.execute(sql`update audit_log set summary = 'x' where tenant_id = ${tid}`)));
  await assert.rejects(withTenant(tid, log[0].userId, (tx: any) => tx.execute(sql`delete from audit_log where tenant_id = ${tid}`)));
  void db;
});
