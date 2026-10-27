// Clinical photos: consent gate, area/view/sitting tags, timeline, re-tagging, settings for areas.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-photos';
process.env.UPLOAD_DIR = './data/test-uploads-photos';
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
// 1×1 JPEG
const JPG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AN//Z';

before(async () => { await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp(); });
after(async () => { await app.close(); });

test('photos need consent, carry area/view/sitting, and form a timeline', async () => {
  const doctor = await as('owner@demo.clinic'); const pharmacy = await as('pharmacy@demo.clinic');
  const p = (await doctor('POST', '/patients', { fullName: 'Photo Patient', phone: '9000044444' })).body;
  const other = (await doctor('POST', '/patients', { fullName: 'Other Patient', phone: '9000055555' })).body;
  const shot = { patientId: p.id, kind: 'photo', area: 'Chin', view: 'front', title: 'Chin front', mime: 'image/jpeg', dataBase64: JPG };

  assert.equal((await doctor('POST', '/documents', shot)).body.code, 'PHOTO_CONSENT_REQUIRED');
  const tl0 = await doctor('GET', `/patients/${p.id}/photos`);
  assert.equal(tl0.body.consent, null); assert.ok(tl0.body.areas.includes('Face'));

  assert.equal((await pharmacy('POST', `/patients/${p.id}/consents`, { key: 'photos', granted: true })).status, 403);
  assert.equal((await doctor('POST', `/patients/${p.id}/consents`, { key: 'tattoos', granted: true })).status, 400);
  const c = await doctor('POST', `/patients/${p.id}/consents`, { key: 'photos', granted: true });
  assert.ok(c.body.consents.photos.grantedAt);

  // validation of every photo field
  assert.equal((await doctor('POST', '/documents', { ...shot, view: 'diagonal' })).status, 400);
  assert.equal((await doctor('POST', '/documents', { ...shot, area: '' })).status, 400);
  assert.equal((await doctor('POST', '/documents', { ...shot, area: 'x'.repeat(41) })).status, 400);
  assert.equal((await doctor('POST', '/documents', { ...shot, mime: 'application/pdf' })).body.code, 'UNSUPPORTED_TYPE');
  assert.equal((await doctor('POST', '/documents', { ...shot, procedureSessionId: '00000000-0000-0000-0000-000000000000' })).body.code, 'SITTING_NOT_FOR_PATIENT');

  // a procedure sitting for this patient
  const docs = (await doctor('GET', '/config')).body;
  const laser = docs.procedures.find((x: any) => x.name === 'Chemical peel');
  const enc = await doctor('POST', '/visits', { patientId: p.id, feeCategoryCode: 'GEN', payment: { method: 'cash', amountPaise: 30000 } });
  assert.equal(enc.status, 200, JSON.stringify(enc.body));
  const e = (await doctor('POST', `/visits/${enc.body.id}/encounter`)).body;
  const rec = await doctor('PATCH', `/encounters/${e.id}`, { data: {}, recommendations: [{ kind: 'procedure', procedureId: laser.id, sittings: 6 }] });
  const recs = (await doctor('GET', '/worklist?kind=procedure')).body.filter((r: any) => r.patient.id === p.id);
  let sittingId: string | undefined;
  assert.equal(rec.status, 200, JSON.stringify(rec.body)); assert.ok(recs[0], 'procedure recommendation on the worklist');
  {
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() + 2 * 86400000));
    const ps = await doctor('POST', '/procedure-sessions', { recommendationId: recs[0].id, day, startTime: '11:00', minutes: 30, force: true });
    assert.equal(ps.status, 200, JSON.stringify(ps.body)); sittingId = ps.body.id;
    // a room taken out for cleaning refuses a procedure, and works again once the block is removed
    const room = docs.rooms[0];
    const blk = await doctor('POST', '/calendar/blocks', { roomId: room.id, day, startTime: '16:00', endTime: '17:00', kind: 'other', note: 'Cleaning' });
    assert.equal(blk.status, 200, JSON.stringify(blk.body));
    const clash = await doctor('POST', '/procedure-sessions', { recommendationId: recs[0].id, day, startTime: '16:15', minutes: 30, roomId: room.id });
    assert.equal(clash.status, 409, JSON.stringify(clash.body)); assert.ok(JSON.stringify(clash.body).includes('room_blocked'), 'says the room is blocked');
    assert.equal((await doctor('DELETE', `/calendar/blocks/${blk.body.id}`)).status, 200);
    const ok = await doctor('POST', '/procedure-sessions', { recommendationId: recs[0].id, day, startTime: '16:15', minutes: 30, roomId: room.id });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  }

  const a = await doctor('POST', '/documents', { ...shot, procedureSessionId: sittingId });
  assert.equal(a.status, 200, JSON.stringify(a.body)); assert.equal(a.body.area, 'Chin'); assert.equal(a.body.view, 'front');
  const b = await doctor('POST', '/documents', { ...shot, view: 'left' });
  assert.equal(b.status, 200);
  // a sitting of a different patient cannot be used
  await doctor('POST', `/patients/${other.id}/consents`, { key: 'photos', granted: true });
  assert.equal((await doctor('POST', '/documents', { ...shot, patientId: other.id, procedureSessionId: sittingId })).body.code, 'SITTING_NOT_FOR_PATIENT');

  const tl = await doctor('GET', `/patients/${p.id}/photos`);
  assert.equal(tl.body.photos.length, 2);
  { const tagged = tl.body.photos.find((x: any) => x.id === a.body.id); assert.equal(tagged.sitting.sittingNo, 1); assert.equal(tagged.sitting.procedure, 'Chemical peel'); assert.equal(tagged.sitting.of, 6); }

  // re-tag, bad re-tag, file served
  assert.equal((await doctor('PATCH', `/documents/${b.body.id}`, { area: 'Neck', note: 'mild redness' })).body.area, 'Neck');
  assert.equal((await doctor('PATCH', `/documents/${b.body.id}`, { view: 'upside' })).status, 400);
  const f = await app.inject({ method: 'GET', url: `/api/documents/${a.body.id}/file`, cookies: { cc_session: (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@demo.clinic', password: 'demo1234', tenant: 'sahitya' } })).cookies.find((x) => x.name === 'cc_session')!.value } });
  assert.equal(f.statusCode, 200); assert.equal(f.headers['content-type'], 'image/jpeg');

  // withdrawing consent keeps old photos, blocks new ones
  await doctor('POST', `/patients/${p.id}/consents`, { key: 'photos', granted: false });
  assert.equal((await doctor('POST', '/documents', shot)).body.code, 'PHOTO_CONSENT_REQUIRED');
  assert.equal((await doctor('GET', `/patients/${p.id}/photos`)).body.photos.length, 2);

  // plain report uploads (scans) never need photo consent
  assert.equal((await doctor('POST', '/documents', { ...shot, kind: 'report', title: 'CBC report' })).status, 200);
});

test('clinic photo areas are validated', async () => {
  const owner = await as('owner@demo.clinic');
  assert.equal((await owner('PATCH', '/admin/clinic', { settings: { photos: { areas: [] } } })).status, 400);
  assert.equal((await owner('PATCH', '/admin/clinic', { settings: { photos: { areas: ['ok', ''] } } })).status, 400);
  assert.equal((await owner('PATCH', '/admin/clinic', { settings: { photos: { areas: Array.from({ length: 41 }, (_, i) => 'A' + i) } } })).status, 400);
  assert.equal((await owner('PATCH', '/admin/clinic', { settings: { photos: { areas: ['  Face  ', 'Left knee'] } } })).status, 200);
  const p = (await owner('POST', '/patients', { fullName: 'Area Check', phone: '9000066666' })).body;
  assert.deepEqual((await owner('GET', `/patients/${p.id}/photos`)).body.areas, ['Face', 'Left knee']);
});
