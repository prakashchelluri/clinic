// A sitting done with more to come books the next one by the plan: the gap after it, same time, room and doctor; tentative and marked.
// Another sitting in the way moves it to the nearest free time; nothing is booked after the last sitting or when one is booked already.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-autonext';
process.env.COOKIE_SECRET = 'test-secret';
rmSync(process.env.PGLITE_DIR, { recursive: true, force: true });

const { migrate, applyRls } = await import('../src/db/index.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { buildApp } = await import('../src/app.js');

let app: Awaited<ReturnType<typeof buildApp>>;
const as = async (email: string) => {
  const c = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenant: 'sahitya' } })).cookies.find((x) => x.name === 'cc_session')!.value;
  return (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) => app.inject({ method, url: '/api' + url, cookies: { cc_session: c }, payload: payload as any });
};
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const plus = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const notSunday = (d: string) => (new Date(d + 'T00:00:00Z').getUTCDay() === 0 ? plus(d, 1) : d);
before(async () => { await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp(); });
after(async () => { await app.close(); });

async function setup(name: string, phone: string, sittings: number) {
  const owner = await as('owner@demo.clinic'); const desk = await as('reception@demo.clinic');
  const cfg = (await owner('GET', '/config')).json();
  const peel = cfg.procedures.find((x: any) => x.name === 'Chemical peel'); const roomId = cfg.rooms.find((r: any) => !peel.requiredCapability || r.capabilities?.includes(peel.requiredCapability))?.id ?? null;
  const drId = cfg.practitioners.find((x: any) => x.name === 'Dr. Second Doctor').id;
  const p = (await desk('POST', '/patients', { fullName: name, phone })).json();
  const v = (await owner('POST', '/visits', { patientId: p.id, feeCategoryCode: 'GEN', payment: { method: 'cash', amountPaise: 30000 } })).json();
  const e = (await owner('POST', `/visits/${v.id}/encounter`, {})).json();
  await owner('PATCH', `/encounters/${e.id}`, { data: { complaint: { chief_complaint: ['Acne'] }, assessment: { diagnosis: [{ name: 'Acne' }] } }, complete: true, recommendations: [{ kind: 'procedure', procedureId: peel.id, sittings, gapDays: 30 }] });
  const rec = (await owner('GET', '/worklist?kind=procedure')).json().find((x: any) => x.patientId === p.id);
  return { owner, desk, rec, roomId, drId, p };
}
const sittingsOf = async (R: any, patientId: string) => (await R('GET', `/patients/${patientId}/timeline`)).json().sessions as any[];
const finish = async (R: any, id: string) => { assert.equal((await R('PATCH', `/procedure-sessions/${id}`, { state: 'in_progress', consent: true })).statusCode, 200); assert.equal((await R('PATCH', `/procedure-sessions/${id}`, { state: 'completed' })).statusCode, 200); };

test('done with more to come: the next sitting is booked by the plan, the gap after, same time, room and doctor', async () => {
  const { desk, rec, roomId, drId, p } = await setup('Auto Next', '9848077701', 3);
  const s1 = (await desk('POST', '/procedure-sessions', { recommendationId: rec.id, day: today(), startTime: '11:00', minutes: 30, roomId, practitionerId: drId, force: true })).json();
  await finish(desk, s1.id);
  const next = (await sittingsOf(desk, p.id)).find((x) => x.state === 'confirmed');
  assert.ok(next, 'booked');
  assert.equal(next.day, notSunday(plus(today(), 30))); assert.equal(next.startTime, '11:00'); assert.equal(next.roomId, roomId); assert.equal(next.practitionerId, drId);
  assert.equal(next.sittingNo, 2); assert.equal(next.autoBooked, true); assert.notEqual(next.approval, 'approved', 'tentative: the coordinator confirms it');
  assert.equal(next.patientConfirmedAt, null);
  // someone moves it: no longer "by the plan"
  const moved = await desk('POST', `/procedure-sessions/${next.id}/reschedule`, { day: plus(next.day, 1), startTime: '12:00', minutes: 30, roomId, practitionerId: drId, force: true });
  assert.equal(moved.statusCode, 200, moved.body); assert.equal(moved.json().autoBooked, false);
});

test('the room taken at that time: the nearest free time that day', async () => {
  const { desk, rec, roomId, drId, p } = await setup('Auto Clash', '9848077702', 3);
  const target = notSunday(plus(today(), 30));
  // someone else's sitting in the same room at 15:00 on the day the plan would pick
  const other = await setup('Auto Blocker', '9848077703', 1);
  await desk('POST', '/procedure-sessions', { recommendationId: other.rec.id, day: target, startTime: '15:00', minutes: 30, roomId, force: true });
  const s1 = (await desk('POST', '/procedure-sessions', { recommendationId: rec.id, day: today(), startTime: '15:00', minutes: 30, roomId, practitionerId: drId, force: true })).json();
  await finish(desk, s1.id);
  const next = (await sittingsOf(desk, p.id)).find((x) => x.state === 'confirmed');
  assert.equal(next.day, target); assert.notEqual(next.startTime, '15:00'); assert.ok(['14:00', '14:30', '15:30', '16:00'].includes(next.startTime), next.startTime);
});

test('nothing after the last sitting, nor when the next is booked already', async () => {
  const one = await setup('Auto Last', '9848077704', 1);
  const s = (await one.desk('POST', '/procedure-sessions', { recommendationId: one.rec.id, day: today(), startTime: '09:00', minutes: 30, roomId: one.roomId, practitionerId: one.drId, force: true })).json();
  await finish(one.desk, s.id);
  assert.equal((await sittingsOf(one.desk, one.p.id)).filter((x) => x.state === 'confirmed').length, 0);

  const two = await setup('Auto Ahead', '9848077705', 3);
  const a = (await two.desk('POST', '/procedure-sessions', { recommendationId: two.rec.id, day: today(), startTime: '09:30', minutes: 30, roomId: two.roomId, practitionerId: two.drId, force: true })).json();
  await two.desk('POST', '/procedure-sessions', { recommendationId: two.rec.id, day: plus(today(), 20), startTime: '10:00', minutes: 30, roomId: two.roomId, practitionerId: two.drId, force: true });
  await finish(two.desk, a.id);
  const ahead = (await sittingsOf(two.desk, two.p.id)).filter((x) => x.state === 'confirmed');
  assert.equal(ahead.length, 1); assert.equal(ahead[0].day, plus(today(), 20)); assert.equal(ahead[0].autoBooked, false);
});
