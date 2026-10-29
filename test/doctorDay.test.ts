// The doctor's day and the calendar: change my day (late, break, leave early, away, stop, extra hours) with who is affected,
// free places, the front desk's attention list, the waiting list, and consultation templates.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-doctorday';
process.env.COOKIE_SECRET = 'test-secret';
rmSync(process.env.PGLITE_DIR, { recursive: true, force: true });

const { migrate, applyRls, db } = await import('../src/db/index.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { buildApp } = await import('../src/app.js');
const S = await import('../src/db/schema.js');
const { eq, and } = await import('drizzle-orm');

let app: Awaited<ReturnType<typeof buildApp>>;
const login = async (email: string) => (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenant: 'sahitya' } })).cookies.find((c) => c.name === 'cc_session')!.value;
before(async () => { await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp(); });
after(async () => { await app.close(); });
const as = (c: string) => (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => app.inject({ method, url: '/api' + url, cookies: { cc_session: c }, payload: payload as any });
const addDays = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

test('change my day: preview who is affected, move them, undo; doctors change only their own day', async () => {
  const R = as(await login('reception@demo.clinic')); const D2 = as(await login('doctor2@demo.clinic'));
  const cfg = (await R('GET', '/config')).json();
  const second = cfg.practitioners.find((p: any) => p.name.includes('Second'));
  const main = cfg.practitioners.find((p: any) => p.name.includes('Main'));
  // a future working day for Dr. Second with at least two windows
  let day = ''; let ws: any[] = [];
  for (let i = 2; i < 14 && !day; i++) { const d = addDays(new Date().toISOString().slice(0, 10), i); const c = (await R('GET', `/calendar?day=${d}&practitionerId=${second.id}`)).json(); if (c.windows.length >= 2) { day = d; ws = c.windows; } }
  assert.ok(day, 'Dr. Second works on some day in the next two weeks');
  const lastW = ws[ws.length - 1];
  const p = (await R('POST', '/patients', { fullName: 'Day Change Patient', phone: '9876500011' })).json();
  const a = (await R('POST', '/appointments', { sessionId: lastW.id, patientId: p.id })).json();
  assert.ok(a.id);

  // the doctor cannot change another doctor's day
  assert.equal((await D2('POST', '/calendar/day-change', { practitionerId: main.id, day, kind: 'away', preview: true })).statusCode, 403);
  // bad input
  assert.equal((await D2('POST', '/calendar/day-change', { practitionerId: second.id, day, kind: 'early' })).statusCode, 400, 'leave early needs a time');
  assert.equal((await D2('POST', '/calendar/day-change', { practitionerId: second.id, day, kind: 'early', time: '23:00' })).statusCode, 400, 'time inside the hours');
  assert.equal((await D2('POST', '/calendar/day-change', { practitionerId: second.id, day: addDays(day, -30), kind: 'away' })).statusCode, 409, 'not in the past');

  // preview: the booked patient is affected and gets a proposed new place; nothing is saved
  const pv = (await D2('POST', '/calendar/day-change', { practitionerId: second.id, day, kind: 'early', time: lastW.startTime, preview: true })).json();
  const mine = pv.affected.find((x: any) => x.id === a.id);
  assert.ok(mine, 'the booking in the closing hour is affected');
  assert.ok(mine.to && mine.to.day > day, 'moved to a later day');
  assert.equal((await db.select().from(S.calendarBlock).where(eq(S.calendarBlock.day, day))).length, 0, 'preview saves nothing');

  // save with "move": block added, patient moved and told
  const done = (await D2('POST', '/calendar/day-change', { practitionerId: second.id, day, kind: 'early', time: lastW.startTime, reason: 'Hospital call' })).json();
  assert.equal(done.moved >= 1, true);
  const moved = (await db.select().from(S.appointment).where(eq(S.appointment.id, a.id)))[0];
  assert.equal(moved.sessionId, mine.to.sessionId);
  const msgs = await db.select().from(S.message).where(and(eq(S.message.appointmentId, a.id), eq(S.message.kind, 'moved')));
  assert.equal(msgs.length, 1, 'patient told about the move');
  const after = (await R('GET', `/calendar?day=${day}&practitionerId=${second.id}`)).json();
  assert.equal(after.windows[after.windows.length - 1].free, 0, 'the closed hour takes no new bookings');
  assert.ok(after.blocks.some((b: any) => b.note.startsWith('Leaves at')));

  // undo: the doctor removes their own change
  assert.equal((await D2('DELETE', `/calendar/blocks/${done.block.id}`)).statusCode, 200);

  // ask them to pick: booking stays, a reschedule message goes, and the front desk sees them to call
  const a2 = (await R('POST', '/appointments', { sessionId: lastW.id, patientId: p.id })).json();
  const away = (await D2('POST', '/calendar/day-change', { practitionerId: second.id, day, kind: 'away', handling: 'ask', reason: 'Conference' })).json();
  assert.equal(away.moved, 0);
  assert.equal((await db.select().from(S.message).where(and(eq(S.message.appointmentId, a2.id), eq(S.message.kind, 'reschedule')))).length, 1);
  const att = (await R('GET', '/calendar/attention')).json();
  assert.ok(att.toCall.some((x: any) => x.id === a2.id), 'front desk sees the patient to call');
  await D2('DELETE', `/calendar/blocks/${away.block.id}`);

  // running late: messages, no places lost
  const late = (await D2('POST', '/calendar/day-change', { practitionerId: second.id, day, kind: 'late', minutes: 30 })).json();
  assert.ok(late.affected.length >= 1);
  assert.equal((await db.select().from(S.message).where(and(eq(S.message.appointmentId, a2.id), eq(S.message.kind, 'late')))).length, 1);
  assert.ok((await db.select().from(S.message).where(and(eq(S.message.appointmentId, a2.id), eq(S.message.kind, 'late'))))[0].body.includes('30 minutes'));
  const c2 = (await R('GET', `/calendar?day=${day}&practitionerId=${second.id}`)).json();
  assert.equal(c2.windows[0].effectiveCapacity, c2.windows[0].capacity, 'running late does not reduce places');
  await D2('DELETE', `/calendar/blocks/${late.block.id}`);
  assert.equal((await db.select().from(S.message).where(and(eq(S.message.appointmentId, a2.id), eq(S.message.kind, 'late'))))[0].status, 'skipped', 'undo stops unsent late messages');

  // extra hours: new windows after the last one; overlapping is refused
  assert.equal((await D2('POST', '/calendar/day-change', { practitionerId: second.id, day, kind: 'extra', time: ws[0].startTime, minutes: 60 })).statusCode, 409);
  const ex = (await D2('POST', '/calendar/day-change', { practitionerId: second.id, day, kind: 'extra', time: '21:00', minutes: 60 })).json();
  assert.equal(ex.sessions.length, 1);

  // stop new bookings: free goes to zero, existing bookings stay
  const stop = (await D2('POST', '/calendar/day-change', { practitionerId: second.id, day, kind: 'stop' })).json();
  const c3 = (await R('GET', `/calendar?day=${day}&practitionerId=${second.id}`)).json();
  assert.ok(c3.windows.filter((w: any) => w.startTime < '21:00').every((w: any) => w.free <= 0));
  assert.equal((await db.select().from(S.appointment).where(eq(S.appointment.id, a2.id)))[0].status, 'booked');
  await D2('DELETE', `/calendar/blocks/${stop.block.id}`);

  // free places for the booking panel
  const free = (await R('GET', `/calendar/free?from=${day}&days=3&practitionerId=${second.id}`)).json();
  assert.ok(free.length > 0 && free.every((f: any) => f.free > 0 && f.practitionerId === second.id));
});

test('waiting list: add, listed, taken off when booked', async () => {
  const R = as(await login('reception@demo.clinic'));
  const p = (await R('POST', '/patients', { fullName: 'Waiting Patient', phone: '9876500022' })).json();
  assert.equal((await R('POST', '/waitlist', { patientId: 'nope' })).statusCode, 400);
  const w = (await R('POST', '/waitlist', { patientId: p.id, note: 'any evening' })).json();
  assert.ok((await R('GET', '/waitlist')).json().some((x: any) => x.id === w.id));
  assert.ok((await R('GET', '/calendar/attention')).json().waiting >= 1);
  const free = (await R('GET', '/calendar/free?days=7')).json();
  await R('POST', '/appointments', { sessionId: free[0].sessionId, patientId: p.id });
  assert.ok(!(await R('GET', '/waitlist')).json().some((x: any) => x.id === w.id), 'booked patients leave the list');
  const D = as(await login('doctor2@demo.clinic'));
  assert.equal((await D('POST', '/waitlist', { patientId: p.id })).statusCode, 403, 'doctors do not manage the list');
});

test('templates: save, list most used first, same name replaces, use counts', async () => {
  const D = as(await login('doctor2@demo.clinic'));
  assert.equal((await D('POST', '/rx-templates', { name: 'x' })).statusCode, 400);
  const t1 = (await D('POST', '/rx-templates', { name: 'Tinea corporis', data: { assessment: { diagnosis: [{ name: 'Tinea corporis', severity: 'Moderate' }] }, review: { response: 'Better' } },
    prescription: [{ name: 'Terbinafine 250 mg', frequency: '1-0-0', durationDays: 14 }], recommendations: [{ kind: 'followup', intervalDays: 14, dueOn: '2030-01-01' }] })).json();
  assert.equal(t1.data.review, undefined, 'review answers are not kept');
  assert.equal(t1.recommendations[0].dueOn, undefined, 'dates are not kept');
  const t2 = (await D('POST', '/rx-templates', { name: 'Acne moderate', prescription: [{ name: 'Adapalene 0.1% gel', frequency: 'at night' }] })).json();
  await D('POST', `/rx-templates/${t2.id}/use`); await D('POST', `/rx-templates/${t2.id}/use`);
  const list = (await D('GET', '/rx-templates')).json();
  assert.equal(list[0].id, t2.id, 'most used first');
  const again = (await D('POST', '/rx-templates', { name: 'tinea CORPORIS', prescription: [] })).json();
  assert.equal(again.id, t1.id, 'same name replaces');
  const stock = (await D('GET', '/encounters-stock')).json();
  assert.equal(typeof stock, 'object');
  assert.equal((await D('DELETE', `/rx-templates/${t1.id}`)).statusCode, 200);
  const R = as(await login('reception@demo.clinic'));
  assert.equal((await R('POST', '/rx-templates', { name: 'Reception try' })).statusCode, 403);
});
