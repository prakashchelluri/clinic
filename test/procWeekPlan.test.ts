// The coordinator's week plan: sittings placed on an hour, sent to their doctor once a week, approved or sent back by the doctor;
// patients are called and reminded only after approval; a change after sending goes to the doctor straight away; a doctor's own move needs no approval.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-procweek';
process.env.COOKIE_SECRET = 'test-secret';
delete process.env.WHATSAPP_TOKEN;
rmSync(process.env.PGLITE_DIR, { recursive: true, force: true });

const { migrate, applyRls, withTenant } = await import('../src/db/index.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { buildApp } = await import('../src/app.js');
const { message } = await import('../src/db/schema.js');
const { addDays } = await import('../src/lib/core.js');
const { weekOf } = await import('../src/modules/procedures.js');
const { eq } = await import('drizzle-orm');

let app: Awaited<ReturnType<typeof buildApp>>;
const SYS = '00000000-0000-4000-8000-000000000000';
const login = async (email: string) => (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenant: 'sahitya' } })).cookies.find((c) => c.name === 'cc_session')!.value;
const as = (c: string) => async (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) => { const r = await app.inject({ method, url: '/api' + url, cookies: { cc_session: c }, payload: payload as any }); return { status: r.statusCode, body: r.body ? r.json() : null }; };
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
before(async () => { await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp(); });
after(async () => { await app.close(); });

test('week plan: draft, send, approve, change after sending, send back, own move, fit in the hour', async () => {
  const O = as(await login('owner@demo.clinic'));            // Dr. Main Doctor prescribes and approves
  const C = as(await login('procedures@demo.clinic'));       // the coordinator
  const D2 = as(await login('doctor2@demo.clinic'));
  const P = as(await login('pharmacy@demo.clinic'));
  const peel = (await O('GET', '/config')).body.procedures.find((x: any) => x.name === 'Chemical peel');
  const course = async (name: string, phone: string) => {
    const p = (await O('POST', '/patients', { fullName: name, phone })).body;
    const v = (await O('POST', '/visits', { patientId: p.id, feeCategoryCode: 'GEN', payment: { method: 'cash', amountPaise: 30000 } })).body;
    const e = (await O('POST', `/visits/${v.id}/encounter`, {})).body;
    const r = await O('PATCH', `/encounters/${e.id}`, { data: { complaint: { chief_complaint: ['Pigmentation'] }, assessment: { diagnosis: [{ name: 'Melasma' }] } }, complete: true, recommendations: [{ kind: 'procedure', procedureId: peel.id, sittings: 3, gapDays: 28 }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return { p, rec: (await C('GET', '/worklist?kind=procedure')).body.find((x: any) => x.patientId === p.id) };
  };
  const a = await course('Week Plan One', '9848012201');
  const b = await course('Week Plan Two', '9848012202');
  assert.equal(a.rec.done, 0, 'pending schedules know how many sittings are done');
  const mon = addDays(weekOf(today()), 7); // next Monday
  const pending = (id: string) => withTenant(a.p.tenantId, SYS, (tx) => tx.select().from(message).where(eq(message.procedureSessionId, id))).then((m) => m.filter((x) => x.status === 'pending'));

  // placed by the coordinator for next week: a draft for Dr. Main, nobody told yet
  assert.equal((await P('POST', '/procedure-sessions/place', { recommendationId: a.rec.id, day: mon, hour: 11 })).status, 403, 'pharmacy cannot schedule');
  const s1 = (await C('POST', '/procedure-sessions/place', { recommendationId: a.rec.id, day: mon, hour: 11 })).body;
  assert.equal(s1.approval, 'draft'); assert.equal(s1.startTime, '11:00'); assert.ok(s1.practitionerId, 'the prescribing doctor');
  assert.equal((await pending(s1.id)).length, 0, 'no reminder before approval');
  assert.equal((await O('GET', '/procedure-approvals')).body.pending, 0, 'a draft is not with the doctor');
  assert.equal((await C('GET', `/procedure-weeks/${mon}`)).body.sent, false);

  // the same doctor in the same hour: the next start where both fit, never an overlap
  const s2 = (await C('POST', '/procedure-sessions/place', { recommendationId: b.rec.id, day: mon, hour: 11 })).body;
  assert.ok(s2.startTime > s1.startTime && s2.startTime >= s1.endTime, `${s2.startTime} after ${s1.endTime}`);
  // a past day says why
  const past = await C('POST', '/procedure-sessions/place', { sittingId: s2.id, day: addDays(today(), -1), hour: 11 });
  assert.equal(past.status, 409); assert.equal(past.body.why, 'that day is past');

  // sent: both go to Dr. Main; Dr. Second sees none and cannot approve them
  assert.equal((await C('POST', `/procedure-weeks/${mon}/send`)).body.sent, 2);
  assert.equal((await C('GET', `/procedure-weeks/${addDays(mon, 3)}`)).body.sent, true, 'any day of the week finds its week');
  const ap = (await O('GET', '/procedure-approvals')).body;
  assert.equal(ap.pending, 2); assert.deepEqual(ap.weeks, [mon]);
  assert.equal((await D2('GET', '/procedure-approvals')).body.pending, 0);
  assert.equal((await D2('POST', '/procedure-approvals', { ids: [s1.id], action: 'approve' })).body.updated, 0, 'only their own');
  assert.equal((await C('POST', '/procedure-approvals', { ids: [s1.id], action: 'approve' })).status, 403, 'the coordinator does not approve');

  // approved: the day-before reminder is planned, and the patient gets the call (placed on the plan is not booked with the patient)
  const confirmCalls = async () => (await C('GET', '/followups?tab=confirm')).body.rows.map((r: any) => r.sitting?.id);
  assert.ok(!(await confirmCalls()).includes(s1.id), 'nobody calls the patient before the doctor approves');
  assert.equal(s1.weekConfirmedAt, null, 'placed on the plan: the patient has not said yes');
  assert.equal((await O('POST', '/procedure-approvals', { ids: [s1.id], action: 'approve' })).body.updated, 1);
  let s = (await C('GET', `/procedure-sessions/${s1.id}`)).body;
  assert.equal(s.approval, 'approved'); assert.equal(s.approvedBy, 'Dr. Main Doctor');
  assert.equal((await pending(s1.id)).length, 1);
  const ahead = (Date.parse(mon) - Date.parse(today())) / 864e5;
  if (ahead >= 2 && ahead <= 7) assert.ok((await confirmCalls()).includes(s1.id), 'approved inside the week: the week call is due');

  // moved by the coordinator after the week was sent: straight back to the doctor as a change, reminder withdrawn
  const mv = (await C('POST', '/procedure-sessions/place', { sittingId: s1.id, day: addDays(mon, 1), hour: 17 })).body;
  assert.equal(mv.approval, 'sent'); assert.equal(mv.changed, true); assert.equal(mv.day, addDays(mon, 1));
  assert.equal((await pending(s1.id)).length, 0);
  assert.equal((await O('GET', '/procedure-approvals')).body.pending, 2);

  // the doctor sends one back with a note; the coordinator sees it
  assert.equal((await O('POST', '/procedure-approvals', { ids: [s2.id], action: 'change', note: 'After OP please' })).body.updated, 1);
  s = (await C('GET', `/procedure-sessions/${s2.id}`)).body;
  assert.equal(s.approval, 'change'); assert.equal(s.approvalNote, 'After OP please');

  // the doctor moves their own sitting: approved as it lands, the patient hears of it
  const own = (await O('POST', '/procedure-sessions/place', { sittingId: s2.id, day: addDays(mon, 2), hour: 18 })).body;
  assert.equal(own.approval, 'approved'); assert.equal(own.approvedBy, 'Dr. Main Doctor');
  assert.equal((await pending(s2.id)).length, 1);
  assert.equal((await D2('POST', '/procedure-sessions/place', { sittingId: s2.id, day: addDays(mon, 2), hour: 17 })).status, 403, 'another doctor cannot move it');

  // this week needs no send: a sitting booked for it goes to the doctor at once
  const c = await course('Week Plan Three', '9848012203');
  const soon = addDays(today(), 1);
  const s3 = await C('POST', '/procedure-sessions/place', { recommendationId: c.rec.id, day: soon, hour: 19 });
  if (s3.status === 200) assert.equal(s3.body.approval, weekOf(soon) <= weekOf(today()) ? 'sent' : 'draft');

  // unscheduling puts the course back in Pending schedules
  assert.equal((await C('PATCH', `/procedure-sessions/${s1.id}`, { state: 'cancelled', reason: 'Unscheduled' })).status, 200);
  const back = (await C('GET', '/worklist?kind=procedure')).body.find((x: any) => x.id === a.rec.id);
  assert.equal(back.next, null); assert.equal(back.status, 'open');
});
