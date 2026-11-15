// Procedures and packages from the patient record: the desk adds one, edits its sessions and validity, cancels it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-planadmin';
process.env.COOKIE_SECRET = 'test-secret';
rmSync(process.env.PGLITE_DIR, { recursive: true, force: true });

const { migrate, applyRls } = await import('../src/db/index.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { buildApp } = await import('../src/app.js');
/** Every procedure session has a doctor: Dr. Main Doctor (the owner) unless a test says otherwise. */
const drMain = async (X: any) => { const r = await X('GET', '/config'); const b = typeof r.json === 'function' ? r.json() : r.body; return b.practitioners.find((p: any) => p.name === 'Dr. Main Doctor').id as string; };

let app: Awaited<ReturnType<typeof buildApp>>;
async function as(email: string) {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenant: 'sahitya' } });
  const cookie = r.cookies.find((c) => c.name === 'cc_session')!.value;
  return (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url: '/api' + url, payload: payload as any, cookies: { cc_session: cookie } }).then((res) => ({ status: res.statusCode, body: res.body ? res.json() : null }));
}
before(async () => { await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp(); });
after(async () => { await app.close(); });
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

test('the desk adds a procedure or a package, edits its sessions and validity, and cancels it', async () => {
  const owner = await as('owner@demo.clinic'); const desk = await as('reception@demo.clinic');
  const cfg = (await owner('GET', '/config')).body;
  const peel = cfg.procedures.find((x: any) => x.name === 'Chemical peel'); const hyd = cfg.procedures.find((x: any) => x.name === 'Hydrafacial');
  const p = (await desk('POST', '/patients', { fullName: 'Desk Plan', phone: '9848011122' })).body;
  // never seen by a doctor: nothing to hang it on
  assert.equal((await desk('POST', '/procedure-plans/add', { patientId: p.id, procedureId: peel.id, sittings: 4 })).body.code, 'NEEDS_A_CONSULTATION');
  const v = (await owner('POST', '/visits', { patientId: p.id, feeCategoryCode: 'GEN', payment: { method: 'cash', amountPaise: 30000 } })).body;
  const e = (await owner('POST', `/visits/${v.id}/encounter`, {})).body;
  await owner('PATCH', `/encounters/${e.id}`, { data: { complaint: { chief_complaint: ['Dull skin'] }, assessment: { diagnosis: [{ name: 'Melasma' }] } }, complete: true, recommendations: [] });

  // a procedure on its own: standard price × sessions, no expiry unless set
  const one = await desk('POST', '/procedure-plans/add', { patientId: p.id, procedureId: peel.id, sittings: 4, gapDays: 14, noExpiry: true });
  assert.equal(one.status, 200, JSON.stringify(one.body)); const r1 = one.body[0];
  assert.equal(r1.sittings, 4); assert.equal(r1.gapDays, 14); assert.equal(r1.amountPaise, null); assert.equal(r1.noExpiry, true);

  // a package: its procedures with their shares, valid till a date the desk set
  assert.equal((await owner('PATCH', '/admin/clinic', { settings: { packages: [{ id: 'glow', name: 'Glow', items: [{ procedureId: hyd.id, sittings: 2, intervalDays: 30 }, { procedureId: peel.id, sittings: 2, intervalDays: 14 }], pricePaise: 1000000, validMonths: 6 }] } })).status, 200);
  const later = new Date(Date.now() + 200 * 864e5).toISOString().slice(0, 10);
  const pk = await desk('POST', '/procedure-plans/add', { patientId: p.id, packageId: 'glow', validUntil: later });
  assert.equal(pk.status, 200, JSON.stringify(pk.body)); assert.equal(pk.body.length, 2);
  assert.equal(pk.body.reduce((s: number, r: any) => s + r.amountPaise, 0), 1000000); assert.equal(pk.body[0].package.name, 'Glow');

  // agreeing one procedure of the package agrees the package; the courses carry the desk's date
  const agreed = await desk('POST', '/courses', { recommendationId: pk.body[0].id });
  assert.equal(agreed.status, 200); assert.equal(agreed.body.validUntil, later);
  const c2 = (await owner('GET', `/courses?patientId=${p.id}`)).body;
  assert.equal(c2.length, 2); assert.ok(c2.every((c: any) => c.validUntil === later));

  // edit: one more peel session in the package costs the standard price; no expiry from now on
  const peelInPkg = pk.body.find((r: any) => r.procedureId === peel.id);
  const before = c2.find((c: any) => c.recommendationId === peelInPkg.id).totalPaise;
  const ed = await desk('PATCH', '/procedure-plans/edit', { plans: [{ id: peelInPkg.id, sittings: 3 }], noExpiry: true });
  assert.equal(ed.status, 200, JSON.stringify(ed.body)); assert.equal(ed.body[0].priceChangePaise, peel.pricePaise);
  const after = (await owner('GET', `/courses?patientId=${p.id}`)).body.find((c: any) => c.recommendationId === peelInPkg.id);
  assert.equal(after.totalPaise, before + peel.pricePaise); assert.equal(after.sittings, 3); assert.equal(after.validUntil, null);
  // a session booked cannot be taken away
  const ps = (await desk('POST', '/procedure-sessions', { practitionerId: await drMain(desk), recommendationId: r1.id, day: today(), startTime: '18:00', minutes: 30, force: true })).body;
  assert.ok(ps.id);
  assert.equal((await desk('PATCH', '/procedure-plans/edit', { plans: [{ id: r1.id, sittings: 0 }] })).status, 400);
  assert.equal((await desk('PATCH', '/procedure-plans/edit', { plans: [{ id: r1.id, sittings: 2 }] })).status, 200);

  // cancel: a package goes whole; its booking is cancelled; a reason is needed
  assert.equal((await desk('POST', '/procedure-plans/cancel', { ids: [peelInPkg.id], reason: 'moving away' })).body.code, 'A_PACKAGE_IS_CANCELLED_WHOLE');
  assert.equal((await desk('POST', '/procedure-plans/cancel', { ids: [r1.id], reason: '' })).status, 400);
  const cx = await desk('POST', '/procedure-plans/cancel', { ids: [r1.id], reason: 'Changed her mind' });
  assert.equal(cx.status, 200, JSON.stringify(cx.body)); assert.equal(cx.body.bookingsCancelled, 1);
  const tl = (await owner('GET', `/patients/${p.id}/timeline`)).body;
  assert.equal(tl.recommendations.find((r: any) => r.id === r1.id).status, 'cancelled');
  assert.equal(tl.sessions.find((s: any) => s.id === ps.id).state, 'cancelled');
  const both = await desk('POST', '/procedure-plans/cancel', { ids: pk.body.map((r: any) => r.id), reason: 'Moving to another city' });
  assert.equal(both.status, 200); assert.equal(both.body.cancelled, 2);
});
