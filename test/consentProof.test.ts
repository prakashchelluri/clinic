// A signed consent keeps the exact wording the patient read and a fingerprint of the signed page; a later check spots a changed page,
// and a signed consent page cannot be deleted.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-consentproof';
process.env.UPLOAD_DIR = './data/test-uploads-consentproof';
process.env.COOKIE_SECRET = 'test-secret';
rmSync(process.env.PGLITE_DIR, { recursive: true, force: true }); rmSync(process.env.UPLOAD_DIR, { recursive: true, force: true });

const { migrate, applyRls } = await import('../src/db/index.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { buildApp } = await import('../src/app.js');

let app: Awaited<ReturnType<typeof buildApp>>;
const as = async (email: string) => {
  const c = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenant: 'sahitya' } })).cookies.find((x) => x.name === 'cc_session')!.value;
  return (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => app.inject({ method, url: '/api' + url, cookies: { cc_session: c }, payload: payload as any });
};
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
before(async () => { await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp(); });
after(async () => { await app.close(); });

test('signed consent: wording and fingerprint kept, a changed page is spotted, the page cannot be deleted', async () => {
  const owner = await as('owner@demo.clinic');
  const p = (await owner('POST', '/patients', { fullName: 'Proof Patient', phone: '9848088001' })).json();

  // photo consent
  const sig = (await owner('POST', '/documents', { patientId: p.id, kind: 'consent', title: 'Photo consent', mime: 'image/png', dataBase64: PNG })).json();
  assert.match(sig.sha256, /^[0-9a-f]{64}$/, 'fingerprint taken on upload');
  const r = (await owner('POST', `/patients/${p.id}/consents`, { key: 'photos', granted: true, documentId: sig.id, wording: 'I agree to photos.' })).json();
  assert.equal(r.consents.photos.wording, 'I agree to photos.'); assert.equal(r.consents.photos.sha256, sig.sha256);
  assert.equal((await owner('GET', `/documents/${sig.id}/check`)).json().state, 'unchanged');

  // the stored file is swapped: the check says so
  writeFileSync(path.join(process.env.UPLOAD_DIR!, sig.storageKey), Buffer.from('not the signed page'));
  assert.equal((await owner('GET', `/documents/${sig.id}/check`)).json().state, 'changed');
  // a signed consent page is kept
  assert.equal((await owner('DELETE', `/documents/${sig.id}`)).json().code, 'CONSENT_DOCUMENT_KEPT');
  rmSync(path.join(process.env.UPLOAD_DIR!, sig.storageKey));
  assert.equal((await owner('GET', `/documents/${sig.id}/check`)).json().state, 'missing');

  // procedure consent on Start keeps its wording too
  const cfg = (await owner('GET', '/config')).json();
  const peel = cfg.procedures.find((x: any) => x.name === 'Chemical peel'); const dr = cfg.practitioners.find((x: any) => x.name === 'Dr. Main Doctor').id;
  const v = (await owner('POST', '/visits', { patientId: p.id, feeCategoryCode: 'GEN', payment: { method: 'cash', amountPaise: 30000 } })).json();
  const e = (await owner('POST', `/visits/${v.id}/encounter`, {})).json();
  await owner('PATCH', `/encounters/${e.id}`, { data: { complaint: { chief_complaint: ['Acne'] }, assessment: { diagnosis: [{ name: 'Acne' }] } }, complete: true, recommendations: [{ kind: 'procedure', procedureId: peel.id, sittings: 2 }] });
  const rec = (await owner('GET', '/worklist?kind=procedure')).json().find((x: any) => x.patientId === p.id);
  const ps = (await owner('POST', '/procedure-sessions', { practitionerId: dr, recommendationId: rec.id, day: today(), startTime: '20:00', minutes: 30, force: true })).json();
  // a photo is not a consent page
  const photo = (await owner('POST', '/documents', { patientId: p.id, kind: 'report', title: 'Report', mime: 'image/png', dataBase64: PNG })).json();
  assert.equal((await owner('PATCH', `/procedure-sessions/${ps.id}`, { state: 'in_progress', consent: true, consentDocumentId: photo.id })).json().code, 'CONSENT_NOT_FOR_PATIENT');
  const psig = (await owner('POST', '/documents', { patientId: p.id, kind: 'consent', procedureSessionId: ps.id, title: 'Consent for Chemical peel', mime: 'image/png', dataBase64: PNG })).json();
  assert.equal((await owner('PATCH', `/procedure-sessions/${ps.id}`, { state: 'in_progress', consent: true, consentDocumentId: psig.id, consentWording: 'Peels can sting.' })).statusCode, 200);
  const d = (await owner('GET', `/procedure-sessions/${ps.id}`)).json();
  assert.equal(d.consent.wording, 'Peels can sting.'); assert.equal(d.consent.sha256, psig.sha256);
  assert.equal((await owner('GET', `/documents/${psig.id}/check`)).json().state, 'unchanged');
});
