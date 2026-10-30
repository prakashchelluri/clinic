// Wave 1: section templates (stacking sets, drafts for the owner), complaint checklists, medical history kept on the patient,
// and test orders: one review per order once every report is in, a slow test split into its own order, informed only after the doctor.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-wave1';
process.env.UPLOAD_DIR = './data/test-uploads-wave1';
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
const JPG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AN//Z';
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const addDays = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const FORM = { complaint: { chief_complaint: ['Itching'] }, assessment: { diagnosis: [{ name: 'Scabies' }] } };

before(async () => { await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp(); });
after(async () => { await app.close(); });

test('templates: starter sets, who may read and write, drafts, duplicates, payload checks', async () => {
  const owner = await as('owner@demo.clinic'); const doc2 = await as('doctor2@demo.clinic'); const reception = await as('reception@demo.clinic'); const pharmacy = await as('pharmacy@demo.clinic');
  const complaints = (await reception('GET', '/templates?kind=complaint')).body;
  const rashes = complaints.find((t: any) => t.name === 'Rashes');
  assert.ok(rashes && rashes.payload.questions.length >= 5, 'the clinic starts with a checklist for Rashes');
  assert.ok(rashes.payload.questions.some((q: any) => q.detail), 'a Yes can ask for one detail');
  assert.equal((await pharmacy('GET', '/templates')).status, 403);
  assert.ok((await doc2('GET', '/templates?kind=medicine')).body.some((t: any) => t.linked.complaints?.includes('Rashes')), 'medicine sets are linked to complaints');

  const body = { kind: 'medicine', name: 'Test itch set', linked: { complaints: ['Itching'] }, payload: { items: [{ name: 'Cetirizine 10 mg', frequency: '0-0-1', durationDays: 7 }] } };
  assert.equal((await reception('POST', '/templates', body)).status, 403, 'reception cannot make sets');
  assert.equal((await owner('POST', '/templates', { ...body, payload: { items: [] } })).status, 400, 'a medicine set needs a medicine');
  assert.equal((await owner('POST', '/templates', { ...body, kind: 'colour' })).status, 400);
  assert.equal((await owner('POST', '/templates', { ...body, name: 'x' })).status, 400, 'name of at least 2 characters');
  assert.equal((await owner('POST', '/templates', { ...body, payload: { items: [{ name: 'A', durationDays: 999 }] } })).status, 400, 'days at most 365');
  const made = await owner('POST', '/templates', body);
  assert.equal(made.status, 200, JSON.stringify(made.body)); assert.equal(made.body.draft, false, 'the owner publishes directly');
  assert.equal((await owner('POST', '/templates', { ...body, name: 'test ITCH set' })).status, 409, 'same name twice (any case)');

  // a doctor's saved set waits for the owner
  const draft = (await doc2('POST', '/templates', { ...body, name: 'Doctor two set', mode: 'auto' })).body;
  assert.equal(draft.draft, true);
  assert.ok(!(await doc2('GET', '/templates?kind=medicine')).body.some((t: any) => t.id === draft.id), 'a draft is not suggested yet');
  assert.ok((await owner('GET', '/templates?kind=medicine&all=1')).body.some((t: any) => t.id === draft.id), 'the owner sees it');
  assert.equal((await doc2('PATCH', `/templates/${draft.id}`, { draft: false })).status, 403, 'a doctor cannot approve');
  assert.equal((await owner('PATCH', `/templates/${draft.id}`, { draft: false, name: 'Test itch set' })).status, 409, 'rename onto an existing name');
  assert.equal((await owner('PATCH', `/templates/${draft.id}`, { draft: false })).body.draft, false);
  assert.ok((await doc2('GET', '/templates?kind=medicine')).body.some((t: any) => t.id === draft.id), 'approved: now suggested');
  assert.equal((await owner('PATCH', `/templates/${draft.id}`, { payload: { items: [] } })).status, 400, 'payload is checked on edit too');
  assert.equal((await owner('PATCH', `/templates/${draft.id}`, { active: false })).body.active, false);
  assert.ok(!(await doc2('GET', '/templates?kind=medicine')).body.some((t: any) => t.id === draft.id), 'retired sets disappear from suggestions');
  assert.equal((await doc2('POST', `/templates/${made.body.id}/use`)).status, 200);
  assert.equal((await owner('GET', '/templates?kind=medicine&all=1')).body.find((t: any) => t.id === made.body.id).uses, 1);
  assert.equal((await owner('DELETE', `/templates/${made.body.id}`)).status, 200);
  assert.equal((await owner('DELETE', `/templates/${made.body.id}`)).status, 404);

  // protocols are linked to diagnoses
  const proto = (await owner('GET', '/rx-templates')).body.find((t: any) => t.name === 'Acne · moderate');
  assert.ok(proto.linked.diagnoses.includes('Acne vulgaris'));
  assert.equal((await doc2('PATCH', `/rx-templates/${proto.id}`, { linked: { diagnoses: ['Acne vulgaris', 'Rosacea'] } })).body.linked.diagnoses.length, 2);
});

test('medical history asked once is kept on the patient and shows at the next visit', async () => {
  const owner = await as('owner@demo.clinic'); const assistant = await as('assistant@demo.clinic');
  const p = (await owner('POST', '/patients', { fullName: 'History Patient', phone: '9000011111' })).body;
  const v = (await owner('POST', '/visits', { patientId: p.id, feeCategoryCode: 'GEN', payment: { method: 'cash', amountPaise: 30000 } })).body;
  const e = (await assistant('POST', `/visits/${v.id}/encounter`)).body;
  const screen = { answers: { 'Itching worse at night?': { a: 'yes' } }, history: { bp: { yes: true, note: 'Telmisartan 40 mg' }, diabetes: { yes: false }, allergy: { yes: true, note: 'Sulfa drugs' } } };
  assert.equal((await assistant('PATCH', `/encounters/${e.id}`, { data: { screen } })).status, 200);
  const again = (await owner('GET', `/encounters/${e.id}`)).body;
  assert.deepEqual(again.patient.history.bp, { yes: true, note: 'Telmisartan 40 mg' });
  assert.equal(again.patient.history.diabetes.yes, false);
  assert.equal(again.patient.allergies, 'Sulfa drugs', 'a stated allergy goes to the allergy field the prescription warns from');
  assert.deepEqual(again.data.screen.answers['Itching worse at night?'], { a: 'yes' });
});

test('test orders: reviewed once when every report is in; a slow test in its own order; informed only after the doctor', async () => {
  const owner = await as('owner@demo.clinic'); const reception = await as('reception@demo.clinic'); const doc2 = await as('doctor2@demo.clinic'); const pharmacy = await as('pharmacy@demo.clinic');
  const p = (await owner('POST', '/patients', { fullName: 'Orders Patient', phone: '9000022222' })).body;
  const v = (await owner('POST', '/visits', { patientId: p.id, feeCategoryCode: 'GEN', payment: { method: 'cash', amountPaise: 30000 } })).body;
  const e = (await owner('POST', `/visits/${v.id}/encounter`)).body;
  const done = await owner('PATCH', `/encounters/${e.id}`, { data: FORM, complete: true, recommendations: [
    { kind: 'investigation', notes: 'CBC', orderNo: 1 }, { kind: 'investigation', notes: 'LFT', orderNo: 1 }, { kind: 'investigation', notes: 'TSH', orderNo: 1 }, { kind: 'investigation', notes: 'Skin biopsy', orderNo: 2 }] });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const mine = async (tab = '') => (await reception('GET', `/orders?tab=${tab}`)).body.orders.filter((o: any) => o.patient.id === p.id);
  assert.equal((await pharmacy('GET', '/orders')).status, 200, 'anyone who may read documents can see the list');

  let [o1, o2] = (await mine('collect')).sort((a: any, b: any) => a.orderNo - b.orderNo);
  assert.equal(o1.tests.length, 3); assert.equal(o2.tests.length, 1); assert.equal(o1.state, 'pending');
  assert.equal(o1.tests.find((t: any) => t.name === 'CBC').expectedOn, addDays(today(), 1), 'CBC takes a day');
  assert.equal(o2.tests[0].expectedOn, addDays(today(), 7), 'the biopsy takes a week');
  assert.equal((await reception('GET', '/orders')).body.counts.collect >= 2, true);
  const idOf = (o: any, n: string) => o.tests.find((t: any) => t.name === n).id;

  // two of three in: still partial, nothing to review
  const up = (ids: string[], title = 'report.jpg') => reception('POST', '/documents', { patientId: p.id, encounterId: e.id, recommendationIds: ids, kind: 'report', title, mime: 'image/jpeg', dataBase64: JPG });
  assert.equal((await up([idOf(o1, 'CBC'), idOf(o1, 'LFT')], 'cbc-lft.jpg')).status, 200);
  [o1] = (await mine('collect')).filter((o: any) => o.orderNo === 1);
  assert.equal(o1.state, 'partial'); assert.equal(o1.got, 2);
  assert.equal((await mine('review')).length, 0, 'not in the doctor\'s list yet');
  const body1 = { encounterId: e.id, orderNo: 1, outcome: 'normal' };
  assert.equal((await owner('POST', '/orders/review', body1)).body.code, 'NOT_ALL_RECEIVED');
  assert.equal((await reception('POST', '/orders/review', body1)).status, 403, 'only a doctor reviews');
  assert.equal((await reception('POST', '/orders/inform', { encounterId: e.id, orderNo: 1, how: 'phone' })).body.code, 'NOT_REVIEWED', 'the desk cannot explain before the doctor');

  // all in: ready for the doctor as one order
  assert.equal((await up([idOf(o1, 'TSH')], 'tsh.jpg')).status, 200);
  const ready = await mine('review'); assert.equal(ready.length, 1); assert.equal(ready[0].orderNo, 1); assert.equal(ready[0].tests.every((t: any) => t.docs.length >= 1), true);
  assert.equal((await owner('POST', '/orders/review', { ...body1, outcome: 'maybe' })).status, 400);
  assert.equal((await owner('POST', '/orders/review', { ...body1, note: 'x'.repeat(301) })).status, 400);
  assert.equal((await owner('POST', '/orders/review', { ...body1, outcome: 'will_call', note: 'LFT slightly high' })).status, 200);
  assert.equal((await owner('POST', '/orders/review', body1)).body.code, 'ALREADY_REVIEWED');
  const call = (await mine('explain'))[0]; assert.equal(call.state, 'doctor_call'); assert.equal(call.note, 'LFT slightly high'); assert.equal(call.reviewedBy.length > 0, true);
  assert.equal((await reception('POST', '/orders/inform', { encounterId: e.id, orderNo: 1, how: 'phone' })).body.code, 'DOCTOR_WILL_CALL', 'the doctor said she will call');
  assert.equal((await owner('POST', '/orders/inform', { encounterId: e.id, orderNo: 1, how: 'carrier pigeon' })).status, 400);
  assert.equal((await owner('POST', '/orders/inform', { encounterId: e.id, orderNo: 1, how: 'phone' })).status, 200, 'the doctor closes it after she phoned');
  assert.equal((await mine('done')).filter((o: any) => o.orderNo === 1).length, 1);

  // the biopsy was its own order: untouched until it arrives
  assert.equal((await mine('collect')).filter((o: any) => o.orderNo === 2).length, 1);
  assert.equal((await owner('POST', '/orders/review', { encounterId: e.id, orderNo: 2, outcome: 'normal' })).body.code, 'NOT_ALL_RECEIVED');
  assert.equal((await reception('POST', '/orders/called', { id: idOf(o2, 'Skin biopsy') })).status, 200);
  assert.ok((await mine('collect')).find((o: any) => o.orderNo === 2).tests[0].called, 'the call is shown');
  assert.equal((await doc2('POST', '/orders/called', { id: idOf(o2, 'Skin biopsy') })).status, 403);
  assert.equal((await up([idOf(o2, 'Skin biopsy')], 'biopsy.pdf')).status, 200);
  assert.equal((await owner('POST', '/orders/review', { encounterId: e.id, orderNo: 2, outcome: 'needs_visit' })).status, 200);
  assert.equal((await reception('POST', '/orders/inform', { encounterId: e.id, orderNo: 2, how: 'in_person' })).status, 200, 'the desk explains after "needs a visit"');
  assert.equal((await reception('POST', '/orders/inform', { encounterId: e.id, orderNo: 2, how: 'in_person' })).body.code, 'ALREADY_INFORMED');
  assert.equal((await mine('')).filter((o: any) => o.state === 'closed').length, 2);
});

test('review what is in: the missing tests split into their own order; received tests cannot move', async () => {
  const owner = await as('owner@demo.clinic'); const reception = await as('reception@demo.clinic');
  const p = (await owner('POST', '/patients', { fullName: 'Split Patient', phone: '9000033333' })).body;
  const v = (await owner('POST', '/visits', { patientId: p.id, feeCategoryCode: 'GEN', payment: { method: 'cash', amountPaise: 30000 } })).body;
  const e = (await owner('POST', `/visits/${v.id}/encounter`)).body;
  assert.equal((await owner('PATCH', `/encounters/${e.id}`, { data: FORM, complete: true, recommendations: ['CBC', 'LFT', 'TSH', 'Vitamin D'].map((notes) => ({ kind: 'investigation', notes })) })).status, 200);
  const list = async () => (await reception('GET', '/orders')).body.orders.filter((o: any) => o.patient.id === p.id);
  const [o] = await list(); assert.equal(o.tests.length, 4, 'ordered together = one order by default');
  const id = (n: string) => o.tests.find((t: any) => t.name === n).id;
  assert.equal((await reception('POST', '/documents', { patientId: p.id, recommendationIds: [id('CBC'), id('LFT')], kind: 'report', title: 'a.jpg', mime: 'image/jpeg', dataBase64: JPG })).status, 200);
  assert.equal((await reception('POST', '/orders/split', { ids: [id('CBC')] })).body.code, 'ALREADY_RECEIVED', 'a received test stays where it is');
  assert.equal((await reception('POST', '/orders/split', { ids: [] })).status, 400);
  assert.equal((await reception('POST', '/orders/split', { ids: [id('TSH'), id('Vitamin D')] })).body.orderNo, 2);
  const after = (await list()).sort((a: any, b: any) => a.orderNo - b.orderNo);
  assert.deepEqual(after.map((x: any) => [x.orderNo, x.tests.length, x.state]), [[1, 2, 'ready'], [2, 2, 'pending']], 'the received ones are ready for the doctor now');
  assert.equal((await owner('POST', '/orders/review', { encounterId: e.id, orderNo: 1, outcome: 'normal' })).status, 200);
});
