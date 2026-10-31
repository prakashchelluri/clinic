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

test('course: agree below list needs the discount permission, advance locks the price, sittings come from the advance, refund needs approval', async () => {
  const owner = await as('owner@demo.clinic'); const reception = await as('reception@demo.clinic');
  const peel = (await owner('GET', '/config')).body.procedures.find((x: any) => x.name === 'Chemical peel');
  const p = (await reception('POST', '/patients', { fullName: 'Course Wave5', phone: '9848055511' })).body;
  const v = (await owner('POST', '/visits', { patientId: p.id, feeCategoryCode: 'GEN', payment: { method: 'cash', amountPaise: 30000 } })).body;
  const e = (await owner('POST', `/visits/${v.id}/encounter`, {})).body;
  assert.equal((await owner('PATCH', `/encounters/${e.id}`, { data: { complaint: { chief_complaint: ['Pigmentation'] }, assessment: { diagnosis: [{ name: 'Melasma' }] } }, complete: true, recommendations: [{ kind: 'procedure', procedureId: peel.id, sittings: 6 }] })).status, 200);
  const rec = (await owner('GET', '/worklist?kind=procedure')).body.find((r: any) => r.patientId === p.id);
  const list = peel.pricePaise * 6; // 6 x 2,500 = 15,000

  // a price below list needs the discount permission; the owner can go beyond the cap
  assert.equal((await reception('POST', '/courses', { recommendationId: rec.id, totalPaise: 1200000 })).status, 403);
  assert.equal((await owner('POST', '/courses', { recommendationId: rec.id, totalPaise: list + 1 })).status, 400, 'not above list');
  const agreed = await owner('POST', '/courses', { recommendationId: rec.id, totalPaise: 1200000 });
  assert.equal(agreed.status, 200, JSON.stringify(agreed.body));
  assert.equal(agreed.body.perSittingPaise, 200000); assert.equal(agreed.body.lockedAt, null);
  assert.equal((await owner('POST', '/courses', { recommendationId: rec.id })).status, 409, 'agreed once');
  const cid = agreed.body.id;

  // advance for 2 of 6 sittings: price locks; EMI needs its code; cannot pay more than the course needs
  assert.equal((await reception('POST', `/courses/${cid}/advance`, { amountPaise: 400000, method: 'emi', idempotencyKey: 'wave5-adv-0001' })).status, 400);
  assert.equal((await reception('POST', `/courses/${cid}/advance`, { amountPaise: 1300000, method: 'cash', idempotencyKey: 'wave5-adv-0002' })).status, 400);
  const adv = await reception('POST', `/courses/${cid}/advance`, { amountPaise: 400000, method: 'upi', reference: '8821', idempotencyKey: 'wave5-adv-0003' });
  assert.equal(adv.status, 200); assert.match(adv.body.receiptNo, /^R-\d{4}$/);
  assert.equal(adv.body.course.unusedSittings, 2); assert.ok(adv.body.course.lockedAt, 'price is locked from the first payment');
  assert.equal((await reception('POST', `/courses/${cid}/advance`, { amountPaise: 400000, method: 'upi', reference: '8821', idempotencyKey: 'wave5-adv-0003' })).body.repeated, true, 'the same click twice takes nothing twice');

  // two sittings come from the advance, the third is due on the day
  const done = async (n: number) => {
    const ps = (await reception('POST', '/procedure-sessions', { recommendationId: rec.id, day: today(), startTime: `1${n}:00`, minutes: 30, force: true })).body;
    assert.equal((await reception('PATCH', `/procedure-sessions/${ps.id}`, { state: 'completed' })).status, 200);
    assert.equal((await reception('PATCH', `/procedure-sessions/${ps.id}`, { state: 'completed' })).status, 200, 'completing twice invoices once');
  };
  await done(1); await done(2); await done(3);
  const tl = (await owner('GET', `/patients/${p.id}/timeline`)).body;
  const sit = tl.charges.filter((c: any) => c.courseId === cid).sort((a: any, b: any) => a.description.localeCompare(b.description));
  assert.equal(sit.length, 3);
  assert.deepEqual(sit.map((c: any) => c.status), ['paid', 'paid', 'due']);
  assert.deepEqual(sit.map((c: any) => c.prepaid), [true, true, false]);
  assert.equal(tl.outstandingPaise, 200000, 'the third sitting is due on the day');

  // the third sitting is paid on the day with the normal take-payment
  const due = sit[2];
  assert.equal((await reception('POST', '/payments/take', { patientId: p.id, chargeIds: [due.id], idempotencyKey: 'wave5-take-0001', parts: [{ method: 'cash', amountPaise: 200000 }] })).status, 200);

  // refund of unused sittings: only with the refund permission, never more than is unused
  const c1 = (await owner('GET', `/courses?patientId=${p.id}`)).body[0];
  assert.equal(c1.unusedPaise, 0); assert.equal(c1.doneSittings, 3);
  assert.equal((await reception('POST', `/courses/${cid}/advance`, { amountPaise: 600000, method: 'cash', idempotencyKey: 'wave5-adv-0004' })).status, 200, 'pay for 3 more');
  assert.equal((await reception('POST', `/courses/${cid}/refund`, { amountPaise: 200000, method: 'cash', reason: 'patient moved away' })).status, 403, 'the desk cannot approve a refund by default');
  assert.equal((await owner('POST', `/courses/${cid}/refund`, { amountPaise: 700000, method: 'cash', reason: 'patient moved away' })).status, 400, 'more than is unused');
  assert.equal((await owner('POST', `/courses/${cid}/refund`, { amountPaise: 400000, method: 'cash', reason: ' ' })).status, 400, 'a reason is needed');
  const back = await owner('POST', `/courses/${cid}/refund`, { amountPaise: 400000, method: 'cash', reason: 'patient moved away' });
  assert.equal(back.status, 200); assert.equal(back.body.unusedPaise, 200000); assert.equal(back.body.refundedPaise, 400000);

  // a junior doctor has no access to procedures, so no courses either
  const junior = await as('assistant@demo.clinic');
  assert.equal((await junior('GET', `/courses?patientId=${p.id}`)).status, 403);
});
