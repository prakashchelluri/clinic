// Wave 5 (rest): follow-up lists with call outcomes, quotes with validity, the procedure board.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-wave5b';
process.env.UPLOAD_DIR = './data/test-uploads-wave5b';
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
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const addDays = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const nextSunday = () => { let d = addDays(today(), 1); while (new Date(d + 'T00:00:00Z').getUTCDay() !== 0) d = addDays(d, 1); return d; };

before(async () => { await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp(); });
after(async () => { await app.close(); });

async function planFor(owner: Call, name: string, phone: string, recs: any[]) {
  const p = (await owner('POST', '/patients', { fullName: name, phone })).body;
  const v = (await owner('POST', '/visits', { patientId: p.id, feeCategoryCode: 'GEN', payment: { method: 'cash', amountPaise: 30000 } })).body;
  const e = (await owner('POST', `/visits/${v.id}/encounter`, {})).body;
  assert.equal((await owner('PATCH', `/encounters/${e.id}`, { data: { complaint: { chief_complaint: ['Pigmentation'] }, assessment: { diagnosis: [{ name: 'Melasma' }] } }, complete: true, recommendations: recs })).status, 200);
  return p;
}

test('follow-ups: four lists, a call outcome takes a row off, call later needs a date, a Sunday asks, no answer can send a message', async () => {
  const owner = await as('owner@demo.clinic'); const reception = await as('reception@demo.clinic');
  const peel = (await owner('GET', '/config')).body.procedures.find((x: any) => x.name === 'Chemical peel');
  const p = await planFor(owner, 'Follow Wave5b', '9848066611', [{ kind: 'followup', dueOn: addDays(today(), 3) }, { kind: 'procedure', procedureId: peel.id, sittings: 6 }]);
  const lists = (await reception('GET', '/followups?tab=reviews')).body;
  const rev = lists.rows.find((r: any) => r.patient.id === p.id);
  assert.ok(rev && rev.kind === 'review');
  const adv = (await reception('GET', '/followups?tab=advised')).body.rows.find((r: any) => r.patient.id === p.id);
  assert.ok(adv && adv.what.startsWith('Chemical peel'), 'a plan with no agreed price is Advised, not Agreed');
  assert.equal((await reception('GET', '/followups?tab=nonsense')).status, 400);

  const log = (b: object) => reception('POST', '/followups/log', { kind: 'review', refId: rev.refId, patientId: p.id, ...b });
  assert.equal((await log({ outcome: 'call_later' })).status, 400, 'call later needs a date');
  assert.equal((await log({ outcome: 'call_later', callbackOn: addDays(today(), -1) })).status, 400);
  const sun = await log({ outcome: 'call_later', callbackOn: nextSunday() });
  assert.equal(sun.status, 409); assert.equal(sun.body.code, 'CLOSED_DAY');
  assert.equal((await log({ outcome: 'call_later', callbackOn: nextSunday(), confirmClosedDay: true })).status, 200);
  const later = (await reception('GET', '/followups?tab=reviews')).body.rows.find((r: any) => r.refId === rev.refId);
  assert.equal(later.waiting, true); assert.equal(later.lastCall.attempts, 1);

  const na = await log({ outcome: 'no_answer', sendMessage: true });
  assert.equal(na.status, 200); assert.equal(na.body.messaged, true);
  assert.equal((await log({ outcome: 'not_interested' })).status, 400, 'a reason is needed');
  assert.equal((await log({ outcome: 'not_interested', note: 'going abroad' })).status, 200);
  assert.equal((await reception('GET', '/followups?tab=reviews')).body.rows.some((r: any) => r.refId === rev.refId), false, 'not interested takes the row off');
  assert.equal((await reception('GET', '/worklist?kind=followup')).body.some((r: any) => r.id === rev.refId), false, 'and off the old worklist');
});

test('quote: priced from the plan, valid for N days, replaced by a newer one, becomes the default when the patient agrees; the board shows Advised, Agreed', async () => {
  const owner = await as('owner@demo.clinic'); const reception = await as('reception@demo.clinic');
  const peel = (await owner('GET', '/config')).body.procedures.find((x: any) => x.name === 'Chemical peel');
  const p = await planFor(owner, 'Quote Wave5b', '9848066622', [{ kind: 'procedure', procedureId: peel.id, sittings: 6 }]);
  const rec = (await owner('GET', '/worklist?kind=procedure')).body.find((r: any) => r.patientId === p.id);

  assert.equal((await reception('POST', '/quotes', { recommendationId: rec.id, totalPaise: 1200000 })).status, 403, 'the desk gives no discount');
  const q1 = await owner('POST', '/quotes', { recommendationId: rec.id, validDays: 15, totalPaise: 1200000, extras: [{ name: 'Aftercare kit', pricePaise: 115000 }], send: 'whatsapp' });
  assert.equal(q1.status, 200, JSON.stringify(q1.body)); assert.match(q1.body.number, /^Q-\d{4}$/); assert.equal(q1.body.messaged, true);
  assert.equal(q1.body.validUntil, addDays(today(), 15));
  const q2 = await owner('POST', '/quotes', { recommendationId: rec.id, validDays: 7, totalPaise: 1300000 });
  const list = (await owner('GET', `/quotes?recommendationId=${rec.id}`)).body;
  assert.equal(list.find((q: any) => q.id === q1.body.id).state, 'declined', 'a new quote replaces the old one');
  const pr = (await owner('GET', `/quotes/${q2.body.id}/print`)).body;
  assert.equal(pr.grandTotalPaise, 1300000); assert.equal(pr.patient.fullName, 'Quote Wave5b');

  let board = (await owner('GET', '/procedure-plans')).body;
  assert.equal(board.plans.find((x: any) => x.id === rec.id).state, 'advised');
  const agreed = await reception('POST', '/courses', { recommendationId: rec.id });
  assert.equal(agreed.status, 200, JSON.stringify(agreed.body)); assert.equal(agreed.body.totalPaise, 1300000, 'the quoted price');
  assert.equal((await owner('GET', `/quotes?recommendationId=${rec.id}`)).body.find((q: any) => q.id === q2.body.id).state, 'agreed');
  board = (await owner('GET', '/procedure-plans')).body;
  const plan = board.plans.find((x: any) => x.id === rec.id);
  assert.equal(plan.state, 'agreed'); assert.equal(plan.ledger.length, 6); assert.equal(plan.ledger[0].state, 'planned');
  assert.ok((await reception('GET', '/followups?tab=schedule')).body.rows.some((r: any) => r.patient.id === p.id), 'Advised moves to Procedures to schedule');
  assert.equal((await reception('GET', '/followups?tab=advised')).body.rows.some((r: any) => r.patient.id === p.id), false);
  assert.equal((await as('assistant@demo.clinic').then((j) => j('GET', '/procedure-plans'))).status, 403);

  // packages in settings are checked
  assert.equal((await owner('PATCH', '/admin/clinic', { settings: { packages: [{ id: 'p1', name: 'Peel x6', procedureId: peel.id, sittings: 6, intervalDays: 14, pricePaise: 1200000 }] } })).status, 200);
  assert.equal((await owner('PATCH', '/admin/clinic', { settings: { packages: [{ id: 'p2', name: 'Bad', procedureId: 'nope', sittings: 0, intervalDays: 14, pricePaise: 1 }] } })).status, 400);
});
