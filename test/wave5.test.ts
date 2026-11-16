// Wave 5: a procedure course: agreed price, advance for some sittings (price locked), sittings drawn from the advance, then due on the day; unused sittings refunded only with approval.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-wave5';
process.env.UPLOAD_DIR = './data/test-uploads-wave5';
process.env.COOKIE_SECRET = 'test-secret';
rmSync(process.env.PGLITE_DIR, { recursive: true, force: true });
rmSync(process.env.UPLOAD_DIR, { recursive: true, force: true });

const { migrate, applyRls } = await import('../src/db/index.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { buildApp } = await import('../src/app.js');
/** Every procedure session has a doctor: Dr. Main Doctor (the owner) unless a test says otherwise. */
const drMain = async (X: any) => { const r = await X('GET', '/config'); const b = typeof r.json === 'function' ? r.json() : r.body; return b.practitioners.find((p: any) => p.name === 'Dr. Main Doctor').id as string; };

let app: Awaited<ReturnType<typeof buildApp>>;
type Call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => Promise<{ status: number; body: any }>;
async function as(email: string): Promise<Call> {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenant: 'sahitya' } });
  assert.equal(r.statusCode, 200, r.body);
  const cookie = r.cookies.find((c) => c.name === 'cc_session')!.value;
  return (method, url, payload) => app.inject({ method, url: '/api' + url, payload: payload as any, cookies: { cc_session: cookie } }).then((res) => ({ status: res.statusCode, body: res.body ? (res.headers['content-type']?.includes('json') ? res.json() : res.body) : null }));
}
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

before(async () => { await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp(); });
after(async () => { await app.close(); });

test('course: fixed price, the package invoiced once and part paid, sessions bill nothing, Record payment keeps the extra as advance, Refund needs the permission', async () => {
  const owner = await as('owner@demo.clinic'); const reception = await as('reception@demo.clinic');
  const peel = (await owner('GET', '/config')).body.procedures.find((x: any) => x.name === 'Chemical peel');
  const p = (await reception('POST', '/patients', { fullName: 'Course Wave5', phone: '9848055511' })).body;
  const v = (await owner('POST', '/visits', { patientId: p.id, feeCategoryCode: 'GEN', payment: { method: 'cash', amountPaise: 30000 } })).body;
  const e = (await owner('POST', `/visits/${v.id}/encounter`, {})).body;
  // a clinic package (a bundle of one here), added by the doctor on the pad
  assert.equal((await owner('PATCH', '/admin/clinic', { settings: { packages: [{ id: 'peel6', name: 'Peel x6', items: [{ procedureId: peel.id, sittings: 6, intervalDays: 14 }], pricePaise: 1200000, validMonths: 12 }] } })).status, 200);
  assert.equal((await owner('PATCH', `/encounters/${e.id}`, { data: { complaint: { chief_complaint: ['Pigmentation'] }, assessment: { diagnosis: [{ name: 'Melasma' }] } }, complete: true, recommendations: [{ kind: 'procedure', procedureId: peel.id, sittings: 6, package: { id: 'peel6', group: 'g1' } }] })).status, 200);
  const rec = (await owner('GET', '/worklist?kind=procedure')).body.find((r: any) => r.patientId === p.id);
  const list = peel.pricePaise * 6; // 6 x 2,500 = 15,000

  // fixed prices: nobody types a course price; a clinic package is the only other price
  assert.equal((await owner('POST', '/courses', { recommendationId: rec.id, totalPaise: list - 1 })).status, 400, 'no typed price');
  assert.equal((await reception('POST', '/courses', { recommendationId: rec.id, packageId: 'peel6' })).status, 400, 'the desk never picks a package');
  const agreed = await reception('POST', '/courses', { recommendationId: rec.id });
  assert.equal(agreed.status, 200, JSON.stringify(agreed.body));
  assert.equal(agreed.body.perSittingPaise, 200000); assert.equal(agreed.body.lockedAt, null);
  assert.equal((await owner('POST', '/courses', { recommendationId: rec.id })).status, 409, 'agreed once');
  const cid = agreed.body.id;

  // the whole package on one invoice, part paid: EMI needs its code; more than is due is refused unless kept as advance
  const inv = (body: any) => reception('POST', '/bills', { patientId: p.id, lines: [{ recommendationId: rec.id }], ...body });
  assert.equal((await inv({ idempotencyKey: 'wave5-inv-0001', parts: [{ method: 'emi', amountPaise: 400000 }] })).status, 400);
  assert.equal((await inv({ idempotencyKey: 'wave5-inv-0002', parts: [{ method: 'cash', amountPaise: 1300000 }] })).status, 400);
  const first = await inv({ idempotencyKey: 'wave5-inv-0003', parts: [{ method: 'upi', amountPaise: 400000, reference: '8821' }] });
  assert.equal(first.status, 200, JSON.stringify(first.body)); assert.match(first.body.receiptNo, /^R-\d{4}-\d{2}-\d{4}$/);
  assert.equal(first.body.payablePaise, 1200000); assert.equal(first.body.balancePaise, 800000);
  assert.equal((await inv({ idempotencyKey: 'wave5-inv-0003', parts: [{ method: 'upi', amountPaise: 400000, reference: '8821' }] })).body.repeated, true, 'the same click twice takes nothing twice');
  assert.ok((await owner('GET', `/courses?patientId=${p.id}`)).body[0].lockedAt, 'invoiced: the price holds');

  // sessions done add nothing: the package's invoice carries the money
  const done = async (n: number) => {
    const ps = (await reception('POST', '/procedure-sessions', { practitionerId: await drMain(reception), recommendationId: rec.id, day: today(), startTime: `1${n}:00`, minutes: 30, force: true })).body;
    assert.equal((await reception('PATCH', `/procedure-sessions/${ps.id}`, { state: 'completed' })).status, 200);
    assert.equal((await reception('PATCH', `/procedure-sessions/${ps.id}`, { state: 'completed' })).status, 200, 'completing twice bills nothing twice');
  };
  await done(1); await done(2); await done(3);
  const tl = (await owner('GET', `/patients/${p.id}/timeline`)).body;
  assert.equal(tl.charges.filter((c: any) => c.courseId === cid).length, 1, 'one line for the whole package');
  assert.equal(tl.outstandingPaise, 800000);

  // Record payment: more than is due, the rest becomes the patient's advance
  const pay = await reception('POST', `/patients/${p.id}/payments`, { amountPaise: 900000, method: 'cash', idempotencyKey: 'wave5-pay-0001' });
  assert.equal(pay.status, 200); assert.equal(pay.body.keptAsAdvancePaise, 100000);
  const c1 = (await owner('GET', `/courses?patientId=${p.id}`)).body[0];
  assert.equal(c1.stillToPayPaise, 0); assert.equal(c1.doneSittings, 3);

  // Refund from the advance: only with the refund permission, never more than the advance, always with a reason
  assert.equal((await reception('POST', `/patients/${p.id}/advance/refund`, { amountPaise: 100000, method: 'cash', reason: 'paid too much' })).status, 403, 'the desk cannot refund by default');
  assert.equal((await owner('POST', `/patients/${p.id}/advance/refund`, { amountPaise: 100001, method: 'cash', reason: 'paid too much' })).status, 400, 'more than the advance');
  assert.equal((await owner('POST', `/patients/${p.id}/advance/refund`, { amountPaise: 100000, method: 'cash', reason: ' ' })).status, 400, 'a reason is needed');
  const back = await owner('POST', `/patients/${p.id}/advance/refund`, { amountPaise: 100000, method: 'cash', reason: 'paid too much' });
  assert.equal(back.status, 200); assert.equal(back.body.balancePaise, 0);

  // a junior doctor has no access to procedures, so no courses either
  const junior = await as('assistant@demo.clinic');
  assert.equal((await junior('GET', `/courses?patientId=${p.id}`)).status, 403);
});
