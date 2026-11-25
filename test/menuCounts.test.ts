// The menu badges are kept for a minute, but never past a save: a follow-up made due today shows on the very next ask.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-menucounts';
process.env.COOKIE_SECRET = 'test-secret';
rmSync(process.env.PGLITE_DIR, { recursive: true, force: true });

const { migrate, applyRls } = await import('../src/db/index.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { buildApp } = await import('../src/app.js');

let app: Awaited<ReturnType<typeof buildApp>>;
const as = async (email: string) => {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenant: 'sahitya' } });
  const cookie = r.cookies.find((c) => c.name === 'cc_session')!.value;
  return (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) => app.inject({ method, url: '/api' + url, payload: payload as any, cookies: { cc_session: cookie } }).then((x) => ({ status: x.statusCode, body: x.body ? x.json() : null }));
};
before(async () => { await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp(); });
after(async () => { await app.close(); });

test('menu counts: the same answer within a minute, a new one right after a save', async () => {
  const R = await as('reception@demo.clinic'); const D = await as('owner@demo.clinic');
  const before = (await R('GET', '/followups/menu-counts')).body;
  assert.deepEqual((await R('GET', '/followups/menu-counts')).body, before, 'asked again: the same');

  const p = (await R('POST', '/patients', { fullName: 'Badge Test', phone: '9848044401' })).body;
  const v = (await R('POST', '/visits', { patientId: p.id, feeCategoryCode: 'GEN', payment: { method: 'cash', amountPaise: 30000 } })).body;
  const e = (await D('POST', `/visits/${v.id}/encounter`)).body;
  const done = await D('PATCH', `/encounters/${e.id}`, { data: { complaint: { chief_complaint: 'acne' }, assessment: { diagnosis: 'Acne' } }, recommendations: [{ kind: 'followup', intervalDays: 0 }], complete: true });
  assert.equal(done.status, 200, JSON.stringify(done.body));

  const after = (await R('GET', '/followups/menu-counts')).body;
  assert.equal(after.calls, before.calls + 1, 'the review due today is counted at once, not a minute later');
});
