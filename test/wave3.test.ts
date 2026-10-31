// Wave 3: flags (Handle carefully needs a reason, the doctor or owner sets it, the desk sees it), guardian and contact label, search that tells people apart.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-wave3';
process.env.UPLOAD_DIR = './data/test-uploads-wave3';
process.env.COOKIE_SECRET = 'test-secret';
rmSync(process.env.PGLITE_DIR, { recursive: true, force: true });
rmSync(process.env.UPLOAD_DIR, { recursive: true, force: true });

const { migrate, applyRls } = await import('../src/db/index.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { buildApp } = await import('../src/app.js');

let app: Awaited<ReturnType<typeof buildApp>>;
type Call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => Promise<{ status: number; body: any }>;
async function as(email: string): Promise<Call> {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenant: 'sahitya' } });
  assert.equal(r.statusCode, 200, r.body);
  const cookie = r.cookies.find((c) => c.name === 'cc_session')!.value;
  return (method, url, payload) => app.inject({ method, url: '/api' + url, payload: payload as any, cookies: { cc_session: cookie } }).then((res) => ({ status: res.statusCode, body: res.body ? (res.headers['content-type']?.includes('json') ? res.json() : res.body) : null }));
}

before(async () => { await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp(); });
after(async () => { await app.close(); });

test('flags need a reason and the right person; the desk sees them; guardian and contact label; search says last visit and main problem', async () => {
  const owner = await as('owner@demo.clinic'); const reception = await as('reception@demo.clinic');
  const mother = (await reception('POST', '/patients', { fullName: 'Lakshmi Devi Wave3', phone: '9848011122', sex: 'F', ageYears: 40 })).body;
  const son = (await reception('POST', '/patients?force=1', { fullName: 'Manikanta Wave3', phone: '9848011122', sex: 'M', ageYears: 16 })).body;

  // the desk cannot set a flag; a reason is required; the owner can
  assert.equal((await reception('PATCH', `/patients/${son.id}/flags`, { careful: { note: 'sensitive diagnosis' } })).status, 403);
  assert.equal((await owner('PATCH', `/patients/${son.id}/flags`, { careful: { note: ' ' } })).status, 400, 'no reason, no flag');
  const set = await owner('PATCH', `/patients/${son.id}/flags`, { careful: { note: 'sensitive diagnosis; discuss only with the mother' }, family: true });
  assert.equal(set.status, 200);
  assert.equal(set.body.flags.careful.note, 'sensitive diagnosis; discuss only with the mother');
  assert.ok(set.body.flags.careful.by && set.body.flags.careful.at, 'who and when are kept');
  assert.equal(set.body.flags.family, true);

  // the desk sees it on the record and in search
  const seen = (await reception('GET', `/patients/${son.id}/timeline`)).body;
  assert.equal(seen.patient.flags.careful.note, 'sensitive diagnosis; discuss only with the mother');
  const found = (await reception('GET', '/patients?q=Manikanta Wave3')).body.find((p: any) => p.id === son.id);
  assert.ok(found.flags.careful);

  // guardian: not self, must exist; label says who answers the phone
  assert.equal((await reception('PATCH', `/patients/${son.id}`, { guardianId: son.id })).status, 400);
  assert.equal((await reception('PATCH', `/patients/${son.id}`, { guardianId: '00000000-0000-4000-8000-000000000000' })).status, 400);
  assert.equal((await reception('PATCH', `/patients/${son.id}`, { guardianId: mother.id, contactLabel: 'mother' })).status, 200);
  const rec = (await owner('GET', `/patients/${son.id}/timeline`)).body;
  assert.equal(rec.guardian.id, mother.id);
  assert.equal(rec.patient.contactLabel, 'mother');
  assert.equal(rec.sharingPhone, 1, 'one other person uses this phone');

  // the flag can be cleared
  assert.equal((await owner('PATCH', `/patients/${son.id}/flags`, { careful: null })).body.flags.careful, undefined);

  // search: last visit and main problem tell two people apart
  const v = (await owner('POST', '/visits', { patientId: son.id, feeCategoryCode: 'GEN', payment: { method: 'cash', amountPaise: 30000 } })).body;
  const e = (await owner('POST', `/visits/${v.id}/encounter`, {})).body;
  assert.equal((await owner('PATCH', `/encounters/${e.id}`, { data: { complaint: { chief_complaint: ['Itching'] }, assessment: { diagnosis: [{ name: 'Scabies' }] } }, complete: true })).status, 200);
  const again = (await owner('GET', '/patients?q=Manikanta Wave3')).body.find((p: any) => p.id === son.id);
  assert.equal(again.mainProblem, 'Scabies');
  assert.ok(again.lastVisitAt);
});
