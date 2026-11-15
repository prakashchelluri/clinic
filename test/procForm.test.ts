// Procedure form: the admin builds a form per procedure; a session fills it (required fields block Mark done),
// Start asks the pharmacy for the usual products, and the pharmacy issues them off stock with no bill.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-procform';
process.env.COOKIE_SECRET = 'test-secret';
rmSync(process.env.PGLITE_DIR, { recursive: true, force: true });

const { migrate, applyRls } = await import('../src/db/index.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { buildApp } = await import('../src/app.js');
const { missingRequired, cleanValues, valuesLine } = await import('../src/lib/procForm.js');
/** Every procedure session has a doctor: Dr. Main Doctor (the owner) unless a test says otherwise. */
const drMain = async (X: any) => { const r = await X('GET', '/config'); const b = typeof r.json === 'function' ? r.json() : r.body; return b.practitioners.find((p: any) => p.name === 'Dr. Main Doctor').id as string; };

let app: Awaited<ReturnType<typeof buildApp>>;
const as = async (email: string) => {
  const c = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenant: 'sahitya' } })).cookies.find((x) => x.name === 'cc_session')!.value;
  return (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown) => app.inject({ method, url: '/api' + url, cookies: { cc_session: c }, payload: payload as any });
};
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
before(async () => { await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp(); });
after(async () => { await app.close(); });

const FORM = (products: any[]) => ({
  sections: [
    { key: 'before', title: 'Before', fields: [{ key: 'skin_type', label: 'Skin type', type: 'chips', options: ['III', 'IV', 'V'], required: true, carry: true }, { key: 'shaved', label: 'Area shaved', type: 'checkbox' }] },
    { key: 'during', title: 'During', fields: [{ key: 'fluence', label: 'Fluence', type: 'number', unit: 'J/cm²', required: true, carry: true, width: 1 }, { key: 'areas', label: 'Areas treated', type: 'multiselect', options: ['Upper lip', 'Chin'] }] },
    { key: 'after', title: 'After', fields: [{ key: 'erythema', label: 'Erythema', type: 'chips', options: ['None', 'Mild'] }] },
  ],
  products,
});

test('helpers: required, clean values, one-line summary', () => {
  const s = FORM([]) as any;
  assert.deepEqual(missingRequired(s, {}), ['Skin type', 'Fluence']);
  assert.deepEqual(missingRequired(s, { skin_type: 'IV', fluence: 0 }), [], 'zero is a value');
  assert.deepEqual(cleanValues(s, { skin_type: 'IV', fluence: '18', areas: ['Chin'], shaved: true, junk: 1, erythema: '' }), { skin_type: 'IV', fluence: 18, areas: ['Chin'], shaved: true });
  assert.equal(valuesLine(s, { skin_type: 'IV', fluence: 18, areas: ['Chin', 'Upper lip'] }), 'Skin type IV · Fluence 18 J/cm² · Areas treated Chin, Upper lip');
});

test('form, session, pharmacy issue with no bill', async () => {
  const owner = await as('owner@demo.clinic'); const reception = await as('reception@demo.clinic'); const doctor = await as('doctor2@demo.clinic'); const pharmacy = await as('pharmacy@demo.clinic');
  const proc = (await owner('GET', '/config')).json().procedures.find((x: any) => x.name === 'Chemical peel');
  const cet = (await owner('GET', '/config')).json().medicines.find((m: any) => m.name === 'Cetirizine 10 mg');
  const ym = (months: number) => { const d = new Date(); d.setUTCMonth(d.getUTCMonth() + months); return d.toISOString().slice(0, 7); };
  assert.equal((await pharmacy('POST', '/stock/receipts', { lines: [{ medicineId: cet.id, qty: 20, ratePaise: 1000, batchNo: 'PF1', expiry: ym(18) }] })).statusCode, 200);
  const med = (await pharmacy('GET', '/pharmacy/medicines')).json().find((m: any) => m.id === cet.id);
  assert.ok(med.onHand >= 3, 'a medicine in stock');

  // the builder: only the owner saves; a bad form is refused; versions go up
  assert.equal((await owner('GET', `/admin/procedures/${proc.id}/form`)).json().schema, null);
  assert.equal((await reception('POST', `/admin/forms/procedure:${proc.id}`, FORM([]))).statusCode, 403);
  assert.equal((await owner('POST', `/admin/forms/procedure:00000000-0000-0000-0000-000000000000`, FORM([]))).statusCode, 404);
  assert.equal((await owner('POST', `/admin/forms/nonsense`, FORM([]))).statusCode, 400);
  const dup = FORM([]); dup.sections[1].fields[0].key = 'skin_type';
  assert.equal((await owner('POST', `/admin/forms/procedure:${proc.id}`, dup)).statusCode, 400, 'two fields with one key');
  assert.equal((await owner('POST', `/admin/forms/procedure:${proc.id}`, FORM([{ medicineId: med.id, name: med.name, qty: 2 }]))).statusCode, 200);
  const f = (await owner('GET', `/admin/procedures/${proc.id}/form`)).json();
  assert.equal(f.schema.sections.length, 3); assert.equal(f.schema.products[0].qty, 2);

  // a session for a patient
  const p = (await reception('POST', '/patients', { fullName: 'Form Test', phone: '9848055533' })).json();
  const v = (await owner('POST', '/visits', { patientId: p.id, feeCategoryCode: 'GEN', payment: { method: 'cash', amountPaise: 30000 } })).json();
  const e = (await owner('POST', `/visits/${v.id}/encounter`, {})).json();
  await owner('PATCH', `/encounters/${e.id}`, { data: { complaint: { chief_complaint: ['Pigmentation'] } }, complete: true, recommendations: [{ kind: 'procedure', procedureId: proc.id, sittings: 3 }] });
  const rec = (await owner('GET', '/worklist?kind=procedure')).json().find((r: any) => r.patientId === p.id);
  const ps = (await reception('POST', '/procedure-sessions', { practitionerId: await drMain(reception), recommendationId: rec.id, day: today(), startTime: '15:00', minutes: 30, force: true })).json();

  // Before can be filled before Start
  const early = await doctor('PUT', `/procedure-sessions/${ps.id}/form`, { values: { skin_type: 'IV', junk: 'x' } });
  assert.equal(early.statusCode, 200, early.body); assert.deepEqual(early.json().missing, ['Fluence']);
  const g = (await doctor('GET', `/procedure-sessions/${ps.id}`)).json();
  assert.equal(g.form.version, f.version); assert.deepEqual(g.outcome, { skin_type: 'IV' }); assert.deepEqual(g.earlier, []);

  // Start asks the pharmacy once for the usual products
  assert.equal((await doctor('PATCH', `/procedure-sessions/${ps.id}`, { state: 'in_progress', consent: true })).statusCode, 200);
  const s1 = (await doctor('GET', `/procedure-sessions/${ps.id}`)).json();
  assert.equal(s1.supplies.length, 1); assert.equal(s1.supplies[0].status, 'asked'); assert.equal(s1.supplies[0].lines[0].qty, 2);

  // Mark done waits for the required fields
  const blocked = await doctor('PATCH', `/procedure-sessions/${ps.id}`, { state: 'completed' });
  assert.equal(blocked.statusCode, 409); assert.equal(blocked.json().code, 'FORM_INCOMPLETE'); assert.deepEqual(blocked.json().missing, ['Fluence']);

  // the pharmacy sees it on the counter and issues it: stock goes down, no sale is made
  const counter = (await pharmacy('GET', '/pharmacy/counter')).json();
  const card = counter.procedures.find((x: any) => x.sessionId === ps.id);
  assert.equal(card.status, 'asked'); assert.equal(card.items, 1);
  const sup = (await pharmacy('GET', `/pharmacy/supplies/${ps.id}`)).json();
  assert.equal(sup.stock[med.id].onHand, med.onHand);
  const askId = sup.asks[0].id;
  assert.equal((await reception('POST', `/pharmacy/supplies/${ps.id}/${askId}/issue`, { lines: [{ medicineId: med.id, qty: 2 }] })).statusCode, 403, 'only the pharmacy issues');
  const bills = (await pharmacy('GET', '/pharmacy/bills')).json();
  const iss = await pharmacy('POST', `/pharmacy/supplies/${ps.id}/${askId}/issue`, { lines: [{ medicineId: med.id, qty: 2 }] });
  assert.equal(iss.statusCode, 200, iss.body); assert.equal(iss.json().status, 'issued'); assert.equal(iss.json().issued.reduce((n: number, x: any) => n + x.qty, 0), 2);
  assert.equal((await pharmacy('POST', `/pharmacy/supplies/${ps.id}/${askId}/issue`, { lines: [{ medicineId: med.id, qty: 1 }] })).statusCode, 409, 'issued once');
  const after = (await pharmacy('GET', '/pharmacy/medicines')).json().find((m: any) => m.id === med.id);
  assert.equal(after.onHand, med.onHand - 2);
  assert.equal(JSON.stringify((await pharmacy('GET', '/pharmacy/bills')).json()), JSON.stringify(bills), 'no bill');
  assert.equal((await pharmacy('GET', '/pharmacy/counter')).json().procedures.find((x: any) => x.sessionId === ps.id).status, 'issued');

  // asking for more, then "not in stock"
  const more = (await doctor('POST', `/procedure-sessions/${ps.id}/supplies`, { lines: [{ medicineId: med.id, qty: 1 }] })).json();
  assert.equal((await pharmacy('POST', `/pharmacy/supplies/${ps.id}/${more.id}/none`, {})).json().note, 'Not in stock');

  // fill the rest and finish; the next session sees this one as "last time"
  assert.equal((await doctor('PUT', `/procedure-sessions/${ps.id}/form`, { values: { skin_type: 'IV', fluence: 18, areas: ['Chin'] } })).json().missing.length, 0);
  const done = await doctor('PATCH', `/procedure-sessions/${ps.id}`, { state: 'completed' });
  assert.equal(done.statusCode, 200, done.body);
  const next = (await reception('POST', '/procedure-sessions', { practitionerId: await drMain(reception), recommendationId: rec.id, day: today(), startTime: '17:00', minutes: 30, force: true })).json();
  const n = (await doctor('GET', `/procedure-sessions/${next.id}`)).json();
  assert.equal(n.earlier[0].id, ps.id); assert.equal(n.earlier[0].outcome.fluence, 18);
});
