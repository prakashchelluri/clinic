// WhatsApp: the webhook (signature, resends), hand-over to the Inbox when the assistant is off, the assistant's tools
// (a patient reaches only the visits on their own number; booking keeps the desk's rules), staff replies, and the sender (no double sends, no late reminders).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createHmac } from 'node:crypto';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-whatsapp';
process.env.COOKIE_SECRET = 'test-secret';
process.env.WHATSAPP_PHONE_NUMBER_ID = 'pn-123';
process.env.WHATSAPP_CLINIC = 'sahitya';
process.env.WHATSAPP_VERIFY_TOKEN = 'verify-me';
process.env.WHATSAPP_APP_SECRET = 'app-secret';
delete process.env.WHATSAPP_TOKEN; delete process.env.ANTHROPIC_API_KEY;
rmSync(process.env.PGLITE_DIR, { recursive: true, force: true });

const { migrate, applyRls, db, withTenant } = await import('../src/db/index.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { buildApp } = await import('../src/app.js');
const schema = await import('../src/db/schema.js');
const { chatTools } = await import('../src/lib/assistant.js');
const { dispatchDue } = await import('../src/lib/messaging.js');
const { eq, and } = await import('drizzle-orm');

let app: Awaited<ReturnType<typeof buildApp>>; let T: any;
const login = async (email: string) => (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenant: 'sahitya' } })).cookies.find((c) => c.name === 'cc_session')!.value;
const as = (c: string) => async (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) => { const r = await app.inject({ method, url: '/api' + url, cookies: { cc_session: c }, payload: payload as any }); return { status: r.statusCode, body: r.body ? r.json() : null }; };
const inT = <X>(fn: (tx: any) => Promise<X>) => withTenant(T.id, '00000000-0000-0000-0000-000000000000', fn);
const tomorrow = () => { const d = new Date(); d.setUTCDate(d.getUTCDate() + 1); return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); };
const hook = (body: unknown, secret = 'app-secret') => { const raw = JSON.stringify(body); return app.inject({ method: 'POST', url: '/api/public/whatsapp', payload: raw, headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex') } }); };
const waMsg = (from: string, id: string, text: string) => ({ entry: [{ changes: [{ value: { metadata: { phone_number_id: 'pn-123' }, messages: [{ from, id, type: 'text', text: { body: text } }] } }] }] });
const chatOf = (phone: string) => inT((tx) => tx.select().from(schema.chat).where(and(eq(schema.chat.tenantId, T.id), eq(schema.chat.phone, phone))).then((r: any[]) => r[0]));
const linesOf = (chatId: string) => inT((tx) => tx.select().from(schema.chatMessage).where(eq(schema.chatMessage.chatId, chatId)).orderBy(schema.chatMessage.createdAt));
const until = async (fn: () => Promise<boolean>) => { for (let i = 0; i < 50; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 50)); } assert.fail('timed out'); };
const tool = (c: any, name: string) => chatTools(T, c, 'http://x').find((x: any) => x.name === name)! as any;
const call = async (c: any, name: string, input: any) => JSON.parse(await tool(c, name).run(input));

before(async () => {
  await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp();
  T = (await db.select().from(schema.tenant).where(eq(schema.tenant.slug, 'sahitya')))[0];
});
after(async () => { await app.close(); });

test('webhook: Meta verification, unsigned calls refused, a resent message kept once, and with no assistant the chat goes to the front desk', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/api/public/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42' })).statusCode, 403);
  const ok = await app.inject({ method: 'GET', url: '/api/public/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42' });
  assert.equal(ok.statusCode, 200); assert.equal(ok.body, '42');

  assert.equal((await hook(waMsg('919848011111', 'wamid.1', 'Hi'), 'not-the-secret')).statusCode, 401, 'a forged call is refused');
  assert.equal(await chatOf('9848011111'), undefined);

  assert.equal((await hook(waMsg('919848011111', 'wamid.1', 'Hi, I want an appointment'))).statusCode, 200);
  await until(async () => !!(await chatOf('9848011111'))?.reason);
  await hook(waMsg('919848011111', 'wamid.1', 'Hi, I want an appointment')); // Meta resends
  await new Promise((r) => setTimeout(r, 200));
  const c = await chatOf('9848011111');
  assert.equal(c.status, 'staff'); assert.equal(c.reason, 'Assistant is off');
  const lines = await linesOf(c.id);
  assert.deepEqual(lines.map((l: any) => [l.direction, l.by]), [['in', 'patient'], ['out', 'WhatsApp assistant']], 'one patient line, one holding reply');
  const out = await inT((tx) => tx.select().from(schema.message).where(and(eq(schema.message.tenantId, T.id), eq(schema.message.kind, 'chat'), eq(schema.message.toPhone, '9848011111'))));
  assert.equal(out.length, 1, 'the holding reply is queued for WhatsApp'); assert.equal(out[0].status, 'logged', 'and handed to the sender at once, not at the next minute (logged: no WhatsApp token in tests)');
});

test('test chat: same path, nothing queued for a real phone; the Inbox lists it and staff replies go out', async () => {
  const R = as(await login('reception@demo.clinic'));
  const r = await R('POST', '/chats/simulate', { phone: '98480 22222', text: 'Can I come tomorrow?' });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.status, 'staff');
  const queued = await inT((tx) => tx.select().from(schema.message).where(and(eq(schema.message.tenantId, T.id), eq(schema.message.toPhone, '9848022222'))));
  assert.equal(queued.length, 0, 'the test chat never sends');

  const list = await R('GET', '/chats?status=staff');
  const row = list.body.chats.find((x: any) => x.phone === '9848022222');
  assert.ok(row); assert.equal(row.unread, 1); assert.equal(row.last.by, 'WhatsApp assistant');
  assert.equal(list.body.assistantOn, false);

  assert.equal((await R('POST', `/chats/${row.id}/reply`, { text: 'Yes, 10 to 11 is free. Shall I book?' })).status, 200);
  const sent = await inT((tx) => tx.select().from(schema.message).where(and(eq(schema.message.tenantId, T.id), eq(schema.message.toPhone, '9848022222'))));
  assert.equal(sent.length, 1); assert.equal(sent[0].kind, 'chat');
  const detail = (await R('GET', `/chats/${row.id}`)).body;
  assert.equal(detail.lines.at(-1).by, 'Lakshmi (OP Reception)', 'staff line kept with their name');
  assert.equal(detail.unread, 0);
  assert.equal((await R('POST', `/chats/${row.id}/status`, { status: 'assistant' })).status, 200);
  assert.equal((await chatOf('9848022222')).status, 'assistant');

  const P = as(await login('pharmacy@demo.clinic'));
  assert.equal((await P('POST', '/chats/simulate', { phone: '9848022222', text: 'hi' })).status, 403, 'pharmacist cannot use it');
});

test('assistant tools: only the visits on this number; book, move, confirm, cancel follow the desk rules', async () => {
  const R = as(await login('reception@demo.clinic'));
  const mine = (await R('POST', '/patients', { fullName: 'Chat Patient', phone: '9848033333' })).body;
  const other = (await R('POST', '/patients', { fullName: 'Not On This Phone', phone: '9848044444' })).body;
  await R('POST', '/chats/simulate', { phone: '9848033333', text: 'hello' });
  const c = await chatOf('9848033333');

  const times = await call(c, 'open_times', { from: tomorrow(), days: 3 });
  const windows = times.flatMap((d: any) => d.windows);
  assert.ok(windows.length >= 2, 'there are open windows: ' + JSON.stringify(times));

  // someone else's visit is out of reach
  const theirs = (await R('POST', '/appointments', { sessionId: windows[0].window_id, patientId: other.id })).body;
  assert.equal((await call(c, 'cancel_visit', { appointment_id: theirs.id })).error, 'NOT_YOURS');
  assert.equal((await call(c, 'confirm_visit', { appointment_id: theirs.id })).error, 'NOT_YOURS');
  assert.equal((await call(c, 'book_visit', { window_id: windows[0].window_id, patient_id: other.id })).error, 'NOT_YOURS');
  assert.deepEqual((await call(c, 'my_visits', {})).upcoming_visits, []);

  assert.match(windows[0].arrive_by, /^\d\d:\d\d$/, 'open times carry the arrive-by time, so the assistant never works it out');
  const booked = await call(c, 'book_visit', { window_id: windows[0].window_id, patient_id: mine.id, reason: 'itching on hands' });
  assert.ok(booked.appointment_id, JSON.stringify(booked)); assert.equal(booked.status, 'booked');
  const row = await inT((tx) => tx.select().from(schema.appointment).where(eq(schema.appointment.id, booked.appointment_id)).then((r: any[]) => r[0]));
  assert.equal(row.source, 'whatsapp'); assert.equal(row.note, 'itching on hands', 'the reason is kept for the front desk and doctor');
  const events = await inT((tx) => tx.select().from(schema.chatMessage).where(and(eq(schema.chatMessage.chatId, c.id), eq(schema.chatMessage.direction, 'event'))));
  assert.equal(events.length, 1); assert.match(events[0].body, /^Booked .+'s visit: /, 'what the assistant did is kept in the chat');
  assert.equal((await call(c, 'book_visit', { window_id: windows[1].window_id, patient_id: mine.id })).error, 'ALREADY_BOOKED', 'one upcoming visit at a time');

  const moveTo = (await call(c, 'open_times', { from: tomorrow(), days: 3, appointment_id: booked.appointment_id })).flatMap((d: any) => d.windows)[0];
  const moved = await call(c, 'move_visit', { appointment_id: booked.appointment_id, window_id: moveTo.window_id });
  assert.equal(moved.window, moveTo.time, JSON.stringify(moved));
  assert.equal((await call(c, 'confirm_visit', { appointment_id: booked.appointment_id })).status, 'confirmed');
  assert.equal((await call(c, 'cancel_visit', { appointment_id: booked.appointment_id, reason: 'travelling' })).status, 'cancelled');

  // a new person on the number: name needed, then a record is made on this phone
  assert.equal((await call(c, 'book_visit', { window_id: windows[1].window_id })).error, 'NAME_NEEDED');
  const fresh = await call(c, 'book_visit', { window_id: windows[1].window_id, new_patient_name: 'Chat Patient Daughter' });
  assert.equal(fresh.patient, 'Chat Patient Daughter');
  assert.equal((await call(c, 'my_visits', {})).patients.length, 2);
  assert.equal((await call(c, 'book_visit', { window_id: 'not-a-window' })).error, 'WINDOW_NOT_FOUND');

  await call(c, 'hand_over', { reason: 'Asks about fees' });
  assert.equal((await chatOf('9848033333')).status, 'staff');
});

test('sender: two runs at once send each message once; a reminder long overdue is dropped, not sent', async () => {
  const p = (await as(await login('reception@demo.clinic'))('POST', '/patients', { fullName: 'Send Once', phone: '9848055555' })).body;
  const old = new Date(Date.now() - 7 * 3_600_000).toISOString();
  const [a, late] = await inT((tx) => tx.insert(schema.message).values([
    { tenantId: T.id, patientId: p.id, kind: 'chat', channel: 'whatsapp', toPhone: '9848055555', body: 'one', status: 'pending' },
    { tenantId: T.id, patientId: p.id, kind: 'reminder', channel: 'whatsapp', toPhone: '9848055555', body: 'late', status: 'pending', sendAfter: old },
  ]).returning());
  await Promise.all([dispatchDue(), dispatchDue()]);
  const rows = await inT((tx) => tx.select().from(schema.message).where(eq(schema.message.toPhone, '9848055555')));
  const one = rows.find((r: any) => r.id === a.id); const gone = rows.find((r: any) => r.id === late.id);
  assert.equal(one.status, 'logged', 'not connected: kept as logged'); assert.equal(one.attempts, 1, 'handled once');
  assert.equal(gone.status, 'skipped'); assert.equal(gone.error, 'too late to send');
});
