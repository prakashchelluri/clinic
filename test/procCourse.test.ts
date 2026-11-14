// A procedure course over months: the doctor sets sittings and the gap; each sitting is booked one at a time,
// confirmed on a call a week before and again the day before, reminded by WhatsApp the day before; the next falls due one gap after the last.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-proccourse';
process.env.COOKIE_SECRET = 'test-secret';
delete process.env.WHATSAPP_TOKEN;
rmSync(process.env.PGLITE_DIR, { recursive: true, force: true });

const { migrate, applyRls, withTenant } = await import('../src/db/index.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { buildApp } = await import('../src/app.js');
const { message, procedureSession } = await import('../src/db/schema.js');
const { localToUtc } = await import('../src/lib/booking.js');
const { addDays } = await import('../src/lib/core.js');
const { eq } = await import('drizzle-orm');

let app: Awaited<ReturnType<typeof buildApp>>;
const SYS = '00000000-0000-4000-8000-000000000000';
const login = async (email: string) => (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenant: 'sahitya' } })).cookies.find((c) => c.name === 'cc_session')!.value;
const as = (c: string) => async (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) => { const r = await app.inject({ method, url: '/api' + url, cookies: { cc_session: c }, payload: payload as any }); return { status: r.statusCode, body: r.body ? r.json() : null }; };
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
before(async () => { await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp(); });
after(async () => { await app.close(); });

test('course: planned with a gap, booked one sitting at a time, confirmed a week and a day before, reminded once', async () => {
  const O = as(await login('owner@demo.clinic')); const R = as(await login('reception@demo.clinic'));
  const peel = (await O('GET', '/config')).body.procedures.find((x: any) => x.name === 'Chemical peel');
  const p = (await R('POST', '/patients', { fullName: 'Course Patient', phone: '9848011201' })).body;
  const v = (await O('POST', '/visits', { patientId: p.id, feeCategoryCode: 'GEN', payment: { method: 'cash', amountPaise: 30000 } })).body;
  const e = (await O('POST', `/visits/${v.id}/encounter`, {})).body;
  const done = await O('PATCH', `/encounters/${e.id}`, { data: { complaint: { chief_complaint: ['Pigmentation'] }, assessment: { diagnosis: [{ name: 'Melasma' }] } }, complete: true,
    recommendations: [{ kind: 'procedure', procedureId: peel.id, sittings: 3, gapDays: 28 }] });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const rec = (await O('GET', '/worklist?kind=procedure')).body.find((r: any) => r.patientId === p.id);
  assert.equal(rec.gapDays, 28); assert.equal(rec.dueOn, today(), 'the first sitting is due from today');
  const calls = async (tab: string) => (await R('GET', `/followups?tab=${tab}`)).body.rows.filter((r: any) => r.patient.id === p.id);
  assert.equal((await calls('procedures')).length, 1, 'to book');

  // a "will come" call before booking must not hide the course once a later sitting is due
  assert.equal((await R('POST', '/followups/log', { kind: 'advised', refId: rec.id, patientId: p.id, outcome: 'booked' })).status, 200);
  assert.equal((await R('POST', '/followups/log', { kind: 'advised', refId: rec.id, patientId: p.id, outcome: 'confirmed' })).status, 400, 'Confirmed is only for a booked sitting');

  // sitting 1, ten days out: not confirmed yet; one reminder at 10:00 the day before
  const day10 = addDays(today(), 10);
  const s1 = (await R('POST', '/procedure-sessions', { recommendationId: rec.id, day: day10, startTime: '11:00', minutes: 30, force: true })).body;
  assert.equal(s1.weekConfirmedAt, null); assert.equal(s1.patientConfirmedAt, null);
  const msgs = (id: string) => withTenant(p.tenantId, SYS, (tx) => tx.select().from(message).where(eq(message.procedureSessionId, id)));
  let m = (await msgs(s1.id)).filter((x) => x.status === 'pending');
  assert.equal(m.length, 1); assert.equal(m[0].kind, 'sitting_reminder');
  assert.equal(new Date(m[0].sendAfter).getTime(), localToUtc(addDays(day10, -1), '10:00', 'Asia/Kolkata').getTime());
  assert.match(m[0].body, /Chemical peel session \(1\/3\) is tomorrow/);
  assert.equal((await calls('procedures')).length, 0, 'booked: off the to-book list');
  assert.equal((await calls('confirm')).length, 0, 'ten days out: nothing to confirm yet');

  // moving it twice still leaves exactly one reminder
  for (const d of [addDays(today(), 12), day10]) assert.equal((await R('POST', `/procedure-sessions/${s1.id}/reschedule`, { day: d, startTime: '11:00', minutes: 30, force: true })).status, 200);
  m = (await msgs(s1.id)).filter((x) => x.status === 'pending'); assert.equal(m.length, 1);

  // six days to go (time passes): the week-before call
  const setDay = (id: string, day: string) => withTenant(p.tenantId, SYS, (tx) => tx.update(procedureSession).set({ day }).where(eq(procedureSession.id, id)));
  await setDay(s1.id, addDays(today(), 6));
  let c = await calls('confirm');
  assert.equal(c.length, 1); assert.equal(c[0].kind, 'confirm_week'); assert.equal(c[0].sitting.id, s1.id); assert.match(c[0].what, /session 1 of 3/);
  assert.equal((await R('POST', '/followups/log', { kind: 'confirm_week', refId: s1.id, patientId: p.id, outcome: 'confirmed' })).status, 200);
  assert.equal((await calls('confirm')).length, 0, 'confirmed for the week');

  // the day before: called again; no answer keeps it on the list, Confirmed takes it off
  await setDay(s1.id, addDays(today(), 1));
  c = await calls('confirm'); assert.equal(c.length, 1); assert.equal(c[0].kind, 'confirm_day');
  await R('POST', '/followups/log', { kind: 'confirm_day', refId: s1.id, patientId: p.id, outcome: 'no_answer' });
  c = await calls('confirm'); assert.equal(c.length, 1); assert.equal(c[0].lastCall.attempts, 1);
  assert.equal((await R('POST', '/followups/log', { kind: 'confirm_day', refId: s1.id, patientId: p.id, outcome: 'confirmed' })).status, 200);
  assert.equal((await calls('confirm')).length, 0);
  assert.ok((await R('GET', `/procedure-sessions/${s1.id}`)).body.patientConfirmedAt, 'the day-before confirmation is the one the schedule shows');
  // another patient's sitting cannot be confirmed through this patient
  const other = (await R('POST', '/patients', { fullName: 'Not Theirs', phone: '9848011202' })).body;
  assert.equal((await R('POST', '/followups/log', { kind: 'confirm_day', refId: s1.id, patientId: other.id, outcome: 'confirmed' })).status, 404);

  // sitting 1 done: the plan books sitting 2 itself, 28 days after it (Sunday skipped), so it is not on the list to book
  assert.equal((await R('PATCH', `/procedure-sessions/${s1.id}`, { state: 'in_progress', consent: true })).status, 200);
  assert.equal((await R('PATCH', `/procedure-sessions/${s1.id}`, { state: 'completed' })).status, 200);
  const sDay = addDays(today(), 1); const due = addDays(sDay, 28);
  assert.equal((await calls('procedures')).length, 0, 'booked by the plan, nothing left to book');
  const byPlan = (await R('GET', `/procedure-sessions?from=${due}&to=${addDays(due, 1)}&active=1`)).body.find((x: any) => x.recommendationId === rec.id);
  assert.ok(byPlan?.autoBooked); assert.equal(byPlan.sittingNo, 2);
  assert.equal((await msgs(s1.id)).filter((x) => x.status === 'pending').length, 0, 'no reminder for a sitting already done');
  // the desk books sitting 2 on another date instead: the plan's one is cancelled first
  assert.equal((await R('PATCH', `/procedure-sessions/${byPlan.id}`, { state: 'cancelled', reason: 'patient wants it sooner' })).status, 200);

  // sitting 2 booked inside the week (at the desk): that is the week confirmation; missed drops its reminder and the course stays to book
  const s2 = (await R('POST', '/procedure-sessions', { recommendationId: rec.id, day: addDays(today(), 5), startTime: '12:00', minutes: 30, force: true })).body;
  assert.equal(s2.sittingNo, 2); assert.ok(s2.weekConfirmedAt); assert.equal(s2.patientConfirmedAt, null);
  assert.equal((await calls('confirm')).length, 0);
  assert.equal((await msgs(s2.id)).filter((x) => x.status === 'pending').length, 1);
  assert.equal((await R('PATCH', `/procedure-sessions/${s2.id}`, { state: 'missed', reason: 'did not come' })).status, 200);
  assert.equal((await msgs(s2.id)).filter((x) => x.status === 'pending').length, 0);
  assert.equal((await calls('missed')).length, 1, 'a missed sitting to call about');
});

test('a patient who asked for no WhatsApp gets no reminder, only the calls', async () => {
  const O = as(await login('owner@demo.clinic')); const R = as(await login('reception@demo.clinic'));
  const peel = (await O('GET', '/config')).body.procedures.find((x: any) => x.name === 'Chemical peel');
  const p = (await R('POST', '/patients', { fullName: 'No Whatsapp', phone: '9848011203', noWhatsapp: true })).body;
  const v = (await O('POST', '/visits', { patientId: p.id, feeCategoryCode: 'GEN', payment: { method: 'cash', amountPaise: 30000 } })).body;
  const e = (await O('POST', `/visits/${v.id}/encounter`, {})).body;
  await O('PATCH', `/encounters/${e.id}`, { data: { complaint: { chief_complaint: ['Acne'] }, assessment: { diagnosis: [{ name: 'Acne' }] } }, complete: true, recommendations: [{ kind: 'procedure', procedureId: peel.id, sittings: 2, gapDays: 21 }] });
  const rec = (await O('GET', '/worklist?kind=procedure')).body.find((r: any) => r.patientId === p.id);
  const s = (await R('POST', '/procedure-sessions', { recommendationId: rec.id, day: addDays(today(), 9), startTime: '10:00', minutes: 30, force: true })).body;
  const m = await withTenant(p.tenantId, SYS, (tx) => tx.select().from(message).where(eq(message.procedureSessionId, s.id)));
  assert.equal(p.noWhatsapp, true); assert.equal(m.length, 1); assert.equal(m[0].status, 'skipped'); assert.match(m[0].error ?? '', /no WhatsApp/);
});

test('menu badges: calls due today and today\'s sittings, amber while one is not confirmed', async () => {
  const O = as(await login('owner@demo.clinic')); const R = as(await login('reception@demo.clinic'));
  const peel = (await O('GET', '/config')).body.procedures.find((x: any) => x.name === 'Chemical peel');
  const p = (await R('POST', '/patients', { fullName: 'Badge Patient', phone: '9848011204' })).body;
  const v = (await O('POST', '/visits', { patientId: p.id, feeCategoryCode: 'GEN', payment: { method: 'cash', amountPaise: 30000 } })).body;
  const e = (await O('POST', `/visits/${v.id}/encounter`, {})).body;
  await O('PATCH', `/encounters/${e.id}`, { data: { complaint: { chief_complaint: ['Acne'] }, assessment: { diagnosis: [{ name: 'Acne' }] } }, complete: true, recommendations: [{ kind: 'procedure', procedureId: peel.id, sittings: 2, gapDays: 21 }] });
  const rec = (await O('GET', '/worklist?kind=procedure')).body.find((r: any) => r.patientId === p.id);
  const before = (await R('GET', '/followups/menu-counts')).body;
  // booked at the desk for today: counted, already confirmed
  const s = (await R('POST', '/procedure-sessions', { recommendationId: rec.id, day: addDays(today(), 3), startTime: '19:30', minutes: 30, force: true })).body;
  await R('POST', `/procedure-sessions/${s.id}/reschedule`, { day: today(), startTime: '19:30', minutes: 30, force: true }); // moved by the clinic: not confirmed
  const mid = (await R('GET', '/followups/menu-counts')).body;
  assert.equal(mid.sittings, before.sittings + 1); assert.equal(mid.unconfirmed, before.unconfirmed + 1);
  assert.equal(mid.calls, before.calls, 'booked: off the to-book list, onto the day call (same count)');
  await R('POST', '/followups/log', { kind: 'confirm_day', refId: s.id, patientId: p.id, outcome: 'confirmed' });
  const after = (await R('GET', '/followups/menu-counts')).body;
  assert.equal(after.unconfirmed, before.unconfirmed); assert.equal(after.calls, before.calls - 1);
  assert.equal((await as(await login('pharmacy@demo.clinic'))('GET', '/followups/menu-counts')).status, 403, 'only those who see the lists');
});
