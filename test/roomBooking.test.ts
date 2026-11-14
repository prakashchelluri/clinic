// A room booked for something other than a procedure: shows on the calendar with its purpose and patient,
// refuses a clash with a sitting or another room booking, can be moved, and keeps procedure sittings out of that time.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-roombook';
process.env.COOKIE_SECRET = 'test-secret';
rmSync(process.env.PGLITE_DIR, { recursive: true, force: true });

const { migrate, applyRls } = await import('../src/db/index.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { buildApp } = await import('../src/app.js');

let app: Awaited<ReturnType<typeof buildApp>>;
const as = async (email: string) => {
  const c = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenant: 'sahitya' } })).cookies.find((x) => x.name === 'cc_session')!.value;
  return (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => app.inject({ method, url: '/api' + url, cookies: { cc_session: c }, payload: payload as any });
};
const day = (() => { const x = new Date(); x.setUTCDate(x.getUTCDate() + 3); if (x.getUTCDay() === 0) x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); })();
before(async () => { await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp(); });
after(async () => { await app.close(); });

test('a room booking: on the calendar, clashes refused, moved, and sittings kept out', async () => {
  const desk = await as('reception@demo.clinic'); const owner = await as('owner@demo.clinic');
  const cfg = (await owner('GET', '/config')).json(); const roomId = cfg.rooms[0].id;
  const p = (await desk('POST', '/patients', { fullName: 'Room Talk', phone: '9848077801' })).json();
  const b = await desk('POST', '/calendar/blocks', { roomId, day, startTime: '14:00', endTime: '15:00', kind: 'other', purpose: 'Counselling', note: 'Diet talk', patientId: p.id });
  assert.equal(b.statusCode, 200, b.body);
  const cal = (await desk('GET', `/calendar?day=${day}`)).json();
  const mine = cal.blocks.find((x: any) => x.id === b.json().id);
  assert.equal(mine.purpose, 'Counselling'); assert.equal(mine.patient, 'Room Talk'); assert.equal(mine.roomId, roomId);

  const clash = await desk('POST', '/calendar/blocks', { roomId, day, startTime: '14:30', endTime: '15:30', kind: 'other', purpose: 'Meeting' });
  assert.equal(clash.statusCode, 409); assert.equal(clash.json().code, 'ROOM_BUSY');
  const other = await desk('POST', '/calendar/blocks', { roomId, day, startTime: '15:00', endTime: '16:00', kind: 'other', purpose: 'Cleaning' });
  assert.equal(other.statusCode, 200, 'back to back is fine');

  // move it onto the cleaning: refused; to the morning: fine
  assert.equal((await desk('PATCH', `/calendar/blocks/${b.json().id}`, { startTime: '15:30', endTime: '16:30' })).statusCode, 409);
  const moved = await desk('PATCH', `/calendar/blocks/${b.json().id}`, { startTime: '10:00', endTime: '11:00', purpose: 'Meeting' });
  assert.equal(moved.statusCode, 200, moved.body); assert.equal(moved.json().purpose, 'Meeting'); assert.equal(moved.json().note, 'Diet talk');

  // a sitting can't go in a booked room-time; the free times skip it
  const peel = cfg.procedures.find((x: any) => x.name === 'Chemical peel');
  const slots = (await desk('GET', `/procedure-sessions/slots?day=${day}&procedureId=${peel.id}&minutes=30`)).json().slots.filter((s: any) => s.roomId === roomId).map((s: any) => s.startTime);
  if (slots.length) assert.ok(!slots.includes('10:00') && !slots.includes('10:30'), slots.join(','));

  assert.equal((await desk('DELETE', `/calendar/blocks/${b.json().id}`)).statusCode, 200);
  assert.ok(!(await desk('GET', `/calendar?day=${day}`)).json().blocks.some((x: any) => x.id === b.json().id));
});
