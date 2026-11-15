// A No-answer call stays on the call list (same due day) and counts its attempts, so the next person can try again.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-call-no-answer';
process.env.COOKIE_SECRET = 'test-secret';
delete process.env.WHATSAPP_TOKEN;
rmSync(process.env.PGLITE_DIR, { recursive: true, force: true });

const { migrate, applyRls, db } = await import('../src/db/index.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { buildApp } = await import('../src/app.js');
const { recommendation } = await import('../src/db/schema.js');

let app: Awaited<ReturnType<typeof buildApp>>;
type Call = (method: 'GET' | 'POST', url: string, payload?: unknown) => Promise<{ status: number; body: any }>;
async function as(email: string): Promise<Call> {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenant: 'sahitya' } });
  const cookie = r.cookies.find((c) => c.name === 'cc_session')!.value;
  return (method, url, payload) => app.inject({ method, url: '/api' + url, payload: payload as any, cookies: { cc_session: cookie } }).then((res) => ({ status: res.statusCode, body: res.body ? res.json() : null }));
}
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

before(async () => { await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp(); });
after(async () => { await app.close(); });

test('no answer twice: the review stays on the list, same due day, 2 attempts, and in the menu count', async () => {
  const owner = await as('owner@demo.clinic'); const desk = await as('reception@demo.clinic');
  const cfg = (await owner('GET', '/config')).body; const tenantId = cfg.tenant.id; const cat = cfg.feeCategories[0];
  const pid = (await desk('POST', '/patients?force=1', { fullName: 'No Answer Twice' })).body.id as string;
  const v = (await desk('POST', '/visits', { patientId: pid, feeCategoryCode: cat.code, details: {}, idempotencyKey: `na-${Date.now()}`, payment: cat.amountPaise > 0 ? { method: 'cash', amountPaise: cat.amountPaise } : undefined })).body;
  const enc = (await owner('POST', `/visits/${v.id}/encounter`)).body;
  const [rec] = await db.insert(recommendation).values({ tenantId, patientId: pid, encounterId: enc.id, kind: 'followup', dueOn: today() }).returning();
  const row = async () => (await desk('GET', '/followups?tab=all')).body.rows.find((r: any) => r.refId === rec.id);
  const count = async () => (await desk('GET', '/followups/menu-counts')).body.calls as number;
  assert.ok(await row()); const before = await count();
  for (let i = 0; i < 2; i++) assert.equal((await desk('POST', '/followups/log', { kind: 'review', refId: rec.id, patientId: pid, outcome: 'no_answer' })).status, 200);
  const r = await row();
  assert.ok(r, 'still listed after no answer');
  assert.equal(r.dueOn, today());
  assert.equal(r.lastCall.outcome, 'no_answer');
  assert.equal(r.lastCall.callbackOn, null);
  assert.equal(r.lastCall.attempts, 2);
  assert.equal(await count(), before, 'the menu badge still counts it');
});
