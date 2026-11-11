// Prescribing safety v1 (generic and drug group, same medicine twice, pregnancy, derm interactions), sign-off and amend,
// the printed patient-language line, and the diagnosis kept from non-clinical roles on the print.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { rxWarnings, allergyHit } from '../web/src/rxSafety.js';
import { localPhrase } from '../src/lib/pad.js';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-rxsafety2';
process.env.COOKIE_SECRET = 'test-secret';
rmSync(process.env.PGLITE_DIR, { recursive: true, force: true });

const { migrate, applyRls } = await import('../src/db/index.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { buildApp } = await import('../src/app.js');

let app: Awaited<ReturnType<typeof buildApp>>;
type Call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => Promise<{ status: number; body: any }>;
async function as(email: string): Promise<Call> {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenant: 'sahitya' } });
  const cookie = r.cookies.find((c) => c.name === 'cc_session')!.value;
  return (method, url, payload) => app.inject({ method, url: '/api' + url, payload: payload as any, cookies: { cc_session: cookie } }).then((res) => ({ status: res.statusCode, body: res.body ? res.json() : null }));
}
before(async () => { await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp(); });
after(async () => { await app.close(); });

test('allergy matches the brand, the generic and the drug group from the medicine list', () => {
  assert.equal(allergyHit('Penicillin', 'Mox 500'), null, 'a brand name alone is unknown');
  assert.equal(rxWarnings([{ name: 'Mox 500', generic: 'amoxicillin' }], { name: 'Meena', allergies: 'Penicillin' }).length, 1, 'its generic is not');
  assert.deepEqual(rxWarnings([{ name: 'Brandox', allergyClass: 'tetracycline' }], { name: 'Meena', allergies: 'tetracyclines' }), ['Meena is allergic to tetracycline: Brandox.'], 'nor its group');
  assert.equal(rxWarnings([{ name: 'Sulfonix', allergyClass: 'sulfonamide' }], { name: 'R', allergies: 'sulfonamide' }).length, 1, 'a group the app does not know still matches by its word');
});

test('the same medicine twice, by generic or by name', () => {
  assert.deepEqual(rxWarnings([{ name: 'Doxycycline 100 mg' }, { name: 'Doxy-1 LB', generic: 'Doxycycline' }], { name: 'R' }), ['Doxycycline 100 mg and Doxy-1 LB are the same medicine (doxycycline).']);
  assert.deepEqual(rxWarnings([{ name: 'Cetirizine 10 mg' }, { name: 'Levocetirizine 5 mg' }], { name: 'R' }), [], 'different molecules pass');
});

test('pregnancy: retinoids, methotrexate, finasteride, tetracyclines', () => {
  for (const m of ['Isotretinoin 20 mg', 'Acitretin 25 mg', 'Tretinoin 0.025% cream', 'Adapalene 0.1% gel', 'Methotrexate 7.5 mg', 'Finasteride 1 mg', 'Minocycline 50 mg', 'Spironolactone 50 mg'])
    assert.equal(rxWarnings([{ name: m }], { name: 'R', pregnant: 'Pregnant' }).length, 1, m);
  assert.equal(rxWarnings([{ name: 'Cetirizine 10 mg' }, { name: 'Calamine lotion' }], { name: 'R', pregnant: 'Pregnant' }).length, 0);
  assert.equal(rxWarnings([{ name: 'Retinova', allergyClass: 'retinoid' }], { name: 'R', pregnant: 'Breastfeeding' }).length, 1, 'by its group when the brand says nothing');
});

test('derm interactions', () => {
  const w = (...names: string[]) => rxWarnings(names.map((name) => ({ name })), { name: 'R' });
  assert.match(w('Isotretinoin 20 mg', 'Minocycline 50 mg')[0], /pressure inside the head/);
  assert.match(w('Methotrexate 7.5 mg', 'Ibuprofen 400 mg')[0], /methotrexate to toxic levels/);
  assert.match(w('Methotrexate 7.5 mg', 'Co-trimoxazole DS')[0], /bone marrow/);
  assert.match(w('Methotrexate 7.5 mg', 'Acitretin 25 mg')[0], /liver/);
  assert.match(w('Ciclosporin 100 mg', 'Itraconazole 100 mg')[0], /raises ciclosporin/);
  assert.match(w('Itraconazole 200 mg', 'Atorvastatin 10 mg')[0], /muscle/);
  assert.deepEqual(w('Methotrexate 7.5 mg', 'Folic acid 5 mg'), []);
  assert.deepEqual(w('Cetirizine 10 mg', 'Doxycycline 100 mg'), []);
});

test('the patient-language line: Telugu or Hindi, none for English or free text', () => {
  assert.equal(localPhrase('hi+en', 'After food'), 'खाने के बाद');
  assert.equal(localPhrase('hi+en', '14 days'), '14 दिन');
  assert.equal(localPhrase('te+en', 'after food'), 'భోజనం తర్వాత');
  assert.equal(localPhrase('te', 'after food'), 'భోజనం తర్వాత', 'the old Telugu-only setting still gets the Telugu');
  assert.equal(localPhrase('en', 'after food'), null);
  assert.equal(localPhrase('hi+en', 'apply on the scalp only'), null, 'free text: the English line stands alone');
});

test('the medicine list keeps a generic and a drug group', async () => {
  const owner = await as('owner@demo.clinic');
  const m = await owner('POST', '/admin/medicines', { name: 'Augmentin 625', generic: 'amoxicillin + clavulanate', allergyClass: 'penicillin' });
  assert.equal(m.status, 200, JSON.stringify(m.body));
  assert.equal(m.body.generic, 'amoxicillin + clavulanate'); assert.equal(m.body.allergyClass, 'penicillin');
  const cfg = (await owner('GET', '/config')).body;
  assert.equal(cfg.medicines.find((x: any) => x.id === m.body.id).allergyClass, 'penicillin', 'the pad gets it with the medicine list');
});

test('sign, amend with a reason (audited), sign again; the print says Amended; the desk print has no diagnosis', async () => {
  const owner = await as('owner@demo.clinic'); const reception = await as('reception@demo.clinic');
  const p = (await reception('POST', '/patients', { fullName: 'Amend Me', phone: '9000044444' })).body;
  const v = (await reception('POST', '/visits', { patientId: p.id, feeCategoryCode: 'GEN', payment: { method: 'cash', amountPaise: 30000 } })).body;
  const e = (await owner('POST', `/visits/${v.id}/encounter`)).body;
  const pad = { data: { complaint: { chief_complaint: ['Acne'] }, assessment: { diagnosis: [{ name: 'Acne vulgaris' }] }, overrides: [{ at: new Date().toISOString(), warnings: ['x'], reason: 'checked' }], notes: { private: 'not for paper' } },
    prescription: [{ name: 'Doxycycline 100 mg', frequency: '1-0-1', durationDays: 14, timing: 'after food' }] };
  const signed = await owner('PATCH', `/encounters/${e.id}`, { ...pad, complete: true });
  assert.equal(signed.status, 200, JSON.stringify(signed.body));
  assert.equal(signed.body.status, 'completed'); assert.ok(signed.body.signedAt, 'signed');
  const firstDone = signed.body.completedAt;

  assert.equal((await owner('PATCH', `/encounters/${e.id}`, { ...pad, complete: false })).status, 409, 'a signed prescription is not edited in place');
  assert.equal((await reception('POST', `/encounters/${e.id}/amend`, { reason: 'wrong dose' })).status, 403, 'only a doctor amends');
  assert.equal((await owner('POST', `/encounters/${e.id}/amend`, { reason: '' })).status, 400, 'a reason is required');
  const am = await owner('POST', `/encounters/${e.id}/amend`, { reason: 'Doxycycline once daily, not twice' });
  assert.equal(am.status, 200, JSON.stringify(am.body));
  assert.equal(am.body.status, 'draft'); assert.equal(am.body.amendments.length, 1);
  const audit = (await owner('GET', '/audit?days=1')).body;
  assert.ok(audit.some((x: any) => x.summary === 'Amended a signed prescription: Doxycycline once daily, not twice'), 'the reason is in the audit log');

  const itemId = am.body.prescription[0].id;
  const again = await owner('PATCH', `/encounters/${e.id}`, { ...pad, prescription: [{ id: itemId, name: 'Doxycycline 100 mg', frequency: '1-0-0', durationDays: 14 }], complete: true });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.status, 'completed');
  assert.equal(again.body.completedAt, firstDone, 'the prescription keeps its first date');
  assert.equal(again.body.prescription.length, 1); assert.equal(again.body.prescription[0].frequency, '1-0-0');

  const print = (await owner('GET', `/encounters/${e.id}/print`)).body;
  assert.equal(print.amendments[0].reason, 'Doxycycline once daily, not twice', 'the reprint carries the amendment');
  assert.equal(print.data.notes, undefined, 'the private note never reaches the paper');
  assert.equal(print.data.overrides, undefined, 'nor the safety overrides');
  assert.equal(print.data.assessment.diagnosis[0].name, 'Acne vulgaris');
  assert.equal(print.local['after food'], 'భోజనం తర్వాత');
  const desk = (await reception('GET', `/encounters/${e.id}/print`)).body;
  assert.equal(desk.data.assessment, undefined, 'the desk reprints without the diagnosis');
  assert.equal((await reception('GET', `/encounters/${e.id}`)).status, 403, 'and cannot open the consultation itself');
});

test('Finish on the server: a serious warning needs a reason; the same medicine twice does not', async () => {
  const owner = await as('owner@demo.clinic'); const reception = await as('reception@demo.clinic');
  const p = (await reception('POST', '/patients', { fullName: 'Pen Allergic', phone: '9000055555', allergies: 'Penicillin' })).body;
  const v = (await reception('POST', '/visits', { patientId: p.id, feeCategoryCode: 'GEN', payment: { method: 'cash', amountPaise: 30000 } })).body;
  const e = (await owner('POST', `/visits/${v.id}/encounter`)).body;
  const pad = { data: { complaint: { chief_complaint: ['Boil'] }, assessment: { diagnosis: [{ name: 'Furunculosis' }] } }, prescription: [{ name: 'Amoxyclav 625', frequency: '1-0-1', durationDays: 5 }] };
  assert.equal((await owner('PATCH', `/encounters/${e.id}`, { ...pad, complete: false })).status, 200, 'a draft saves with the warning');
  const stop = await owner('PATCH', `/encounters/${e.id}`, { ...pad, complete: true });
  assert.equal(stop.status, 409); assert.equal(stop.body.code, 'RX_NEEDS_REASON');
  assert.deepEqual(stop.body.warnings, ['Pen is allergic to penicillin: Amoxyclav 625.']);
  const blank = { ...pad.data, overrides: [{ at: new Date().toISOString(), warnings: stop.body.warnings, reason: '  ' }] };
  assert.equal((await owner('PATCH', `/encounters/${e.id}`, { ...pad, data: blank, complete: true })).status, 409, 'a blank reason is no reason');
  const ok = { ...pad.data, overrides: [{ at: new Date().toISOString(), warnings: stop.body.warnings, reason: 'tolerated it last year' }] };
  const done = await owner('PATCH', `/encounters/${e.id}`, { ...pad, data: ok, complete: true });
  assert.equal(done.status, 200, JSON.stringify(done.body)); assert.equal(done.body.data.overrides[0].reason, 'tolerated it last year');

  const p2 = (await reception('POST', '/patients', { fullName: 'Twice Over', phone: '9000066666' })).body;
  const v2 = (await reception('POST', '/visits', { patientId: p2.id,feeCategoryCode: 'GEN', payment: { method: 'cash', amountPaise: 30000 } })).body;
  const e2 = (await owner('POST', `/visits/${v2.id}/encounter`)).body;
  const twice = await owner('PATCH', `/encounters/${e2.id}`, { data: pad.data, prescription: [{ name: 'Cetirizine 10 mg', frequency: '0-0-1', durationDays: 5 }, { name: 'Cetirizine 10 mg tab', frequency: '0-0-1', durationDays: 5 }], complete: true });
  assert.equal(twice.status, 200, 'the same medicine twice is a warning only');
});
