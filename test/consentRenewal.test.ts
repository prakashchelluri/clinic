// Procedure consent: the procedure's own wording reaches the session, and a signed consent is asked again after the procedure's months.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-consent';
process.env.COOKIE_SECRET = 'test-secret';
rmSync(process.env.PGLITE_DIR, { recursive: true, force: true });

const { migrate, applyRls, db } = await import('../src/db/index.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { buildApp } = await import('../src/app.js');
const { patient } = await import('../src/db/schema.js');
const { eq } = await import('drizzle-orm');

let app: Awaited<ReturnType<typeof buildApp>>;
const as = async (email: string) => {
  const c = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenant: 'sahitya' } })).cookies.find((x) => x.name === 'cc_session')!.value;
  return (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) => app.inject({ method, url: '/api' + url, cookies: { cc_session: c }, payload: payload as any });
};
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
before(async () => { await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp(); });
after(async () => { await app.close(); });

test('own consent wording, and consent asked again once it runs out', async () => {
  const owner = await as('owner@demo.clinic');
  const cfg = (await owner('GET', '/config')).json();
  const peel = cfg.procedures.find((x: any) => x.name === 'Chemical peel'); const dr = cfg.practitioners.find((x: any) => x.name === 'Dr. Main Doctor').id;

  // Settings: own wording and 6 months; bad values refused; empty wording goes back to the standard text
  assert.equal((await owner('PATCH', `/admin/procedures/${peel.id}`, { consentMonths: 0 })).statusCode, 400);
  const blank = await owner('PATCH', `/admin/procedures/${peel.id}`, { consentText: '   ' });
  assert.equal(blank.statusCode, 200); assert.equal(blank.json().consentText, null);
  assert.equal((await owner('GET', '/config')).json().procedures.find((x: any) => x.id === peel.id).consentMonths, 12, 'every procedure starts at 12 months');
  assert.equal((await owner('PATCH', `/admin/procedures/${peel.id}`, { consentText: 'Peels can sting.\nAvoid sun for a week.', consentMonths: 6 })).statusCode, 200);

  const p = (await owner('POST', '/patients', { fullName: 'Consent Renewal', phone: '9848077001' })).json();
  const v = (await owner('POST', '/visits', { patientId: p.id, feeCategoryCode: 'GEN', payment: { method: 'cash', amountPaise: 30000 } })).json();
  const e = (await owner('POST', `/visits/${v.id}/encounter`, {})).json();
  await owner('PATCH', `/encounters/${e.id}`, { data: { complaint: { chief_complaint: ['Pigmentation'] }, assessment: { diagnosis: [{ name: 'Melasma' }] } }, complete: true, recommendations: [{ kind: 'procedure', procedureId: peel.id, sittings: 3 }] });
  const rec = (await owner('GET', '/worklist?kind=procedure')).json().find((r: any) => r.patientId === p.id);
  const book = async (t: string) => (await owner('POST', '/procedure-sessions', { practitionerId: dr, recommendationId: rec.id, day: today(), startTime: t, minutes: 30, force: true })).json();

  // first session: consent needed, with the procedure's own wording
  const s1 = await book('20:00');
  let d = (await owner('GET', `/procedure-sessions/${s1.id}`)).json();
  assert.equal(d.consentNeeded, true); assert.equal(d.consentText, 'Peels can sting.\nAvoid sun for a week.'); assert.ok(!d.consentExpired);
  assert.equal((await owner('PATCH', `/procedure-sessions/${s1.id}`, { state: 'in_progress', consent: true })).statusCode, 200);
  assert.equal((await owner('PATCH', `/procedure-sessions/${s1.id}`, { state: 'completed' })).statusCode, 200);

  // within 6 months: not asked again
  const s2 = await book('20:40');
  d = (await owner('GET', `/procedure-sessions/${s2.id}`)).json();
  assert.equal(d.consentNeeded, false); assert.ok(d.consent.grantedAt);

  // 7 months later: run out, asked again; starting without it is refused
  const [row] = await db.select({ consents: patient.consents }).from(patient).where(eq(patient.id, p.id));
  const key = `procedure:${peel.id}`; const old = new Date(Date.now() - 213 * 864e5).toISOString();
  await db.update(patient).set({ consents: { ...row.consents, [key]: { ...row.consents[key], grantedAt: old } } }).where(eq(patient.id, p.id));
  d = (await owner('GET', `/procedure-sessions/${s2.id}`)).json();
  assert.equal(d.consentNeeded, true); assert.equal(d.consentExpired, true);
  assert.equal((await owner('PATCH', `/procedure-sessions/${s2.id}`, { state: 'in_progress' })).json().code, 'CONSENT_NEEDED');
  assert.equal((await owner('PATCH', `/procedure-sessions/${s2.id}`, { state: 'in_progress', consent: true })).statusCode, 200);
  assert.equal((await owner('GET', `/procedure-sessions/${s2.id}`)).json().consentNeeded, false, 'signed again: on file');

  // Never: an old consent still counts
  assert.equal((await owner('PATCH', `/admin/procedures/${peel.id}`, { consentMonths: null })).statusCode, 200);
  const [r2] = await db.select({ consents: patient.consents }).from(patient).where(eq(patient.id, p.id));
  await db.update(patient).set({ consents: { ...r2.consents, [key]: { ...r2.consents[key], grantedAt: '2020-01-01T00:00:00.000Z' } } }).where(eq(patient.id, p.id));
  assert.equal((await owner('GET', `/procedure-sessions/${s2.id}`)).json().consentNeeded, false);
});
