// Procedure consent signed on the tablet (kept as the patient's document), and "no WhatsApp" honoured for prescriptions, pharmacy receipts and quotes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-consentoptout';
process.env.UPLOAD_DIR = './data/test-uploads-consentoptout';
process.env.COOKIE_SECRET = 'test-secret';
delete process.env.WHATSAPP_TOKEN;
rmSync(process.env.PGLITE_DIR, { recursive: true, force: true });
rmSync(process.env.UPLOAD_DIR, { recursive: true, force: true });

const { migrate, applyRls } = await import('../src/db/index.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { buildApp } = await import('../src/app.js');

let app: Awaited<ReturnType<typeof buildApp>>;
const login = async (email: string) => (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenant: 'sahitya' } })).cookies.find((c) => c.name === 'cc_session')!.value;
const as = (c: string) => async (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) => { const r = await app.inject({ method, url: '/api' + url, cookies: { cc_session: c }, payload: payload as any }); return { status: r.statusCode, body: r.body ? (r.headers['content-type']?.includes('json') ? r.json() : r.body) : null }; };
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const ym = (months: number) => { const d = new Date(); d.setUTCMonth(d.getUTCMonth() + months); return d.toISOString().slice(0, 7); };
// a 1×1 white PNG, standing in for the signature drawn on the tablet
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
before(async () => { await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp(); });
after(async () => { await app.close(); });

/** A patient seen today with a procedure planned; returns the patient, the encounter and the plan. */
async function planned(O: any, R: any, name: string, phone: string, procedureId: string, extra: Record<string, unknown> = {}) {
  const p = (await R('POST', '/patients', { fullName: name, phone, ...extra })).body;
  const v = (await O('POST', '/visits', { patientId: p.id, feeCategoryCode: 'GEN', payment: { method: 'cash', amountPaise: 30000 } })).body;
  const e = (await O('POST', `/visits/${v.id}/encounter`, {})).body;
  return { p, e, v };
}

test('consent: the patient signs on the tablet; the signature is their document and the consent points to it', async () => {
  const O = as(await login('owner@demo.clinic')); const R = as(await login('reception@demo.clinic'));
  const peel = (await O('GET', '/config')).body.procedures.find((x: any) => x.name === 'Chemical peel');
  const { p, e } = await planned(O, R, 'Signs Tablet', '9848077001', peel.id);
  await O('PATCH', `/encounters/${e.id}`, { data: { complaint: { chief_complaint: ['Pigmentation'] }, assessment: { diagnosis: [{ name: 'Melasma' }] } }, complete: true, recommendations: [{ kind: 'procedure', procedureId: peel.id, sittings: 2 }] });
  const rec = (await O('GET', '/worklist?kind=procedure')).body.find((r: any) => r.patientId === p.id);
  const ps = (await R('POST', '/procedure-sessions', { recommendationId: rec.id, day: today(), startTime: '15:00', minutes: 30, force: true })).body;
  assert.equal((await R('GET', `/procedure-sessions/${ps.id}`)).body.consentNeeded, true);

  // another patient's signature is refused
  const other = (await R('POST', '/patients', { fullName: 'Someone Else', phone: '9848077002' })).body;
  const theirs = await R('POST', '/documents', { patientId: other.id, kind: 'consent', title: 'Consent', mime: 'image/png', dataBase64: PNG });
  assert.equal(theirs.status, 200, JSON.stringify(theirs.body));
  const wrong = await R('PATCH', `/procedure-sessions/${ps.id}`, { state: 'in_progress', consent: true, consentDocumentId: theirs.body.id });
  assert.equal(wrong.status, 400); assert.equal(wrong.body.code, 'CONSENT_NOT_FOR_PATIENT');
  assert.equal((await R('GET', `/procedure-sessions/${ps.id}`)).body.state, 'confirmed', 'not started');

  const sig = await R('POST', '/documents', { patientId: p.id, kind: 'consent', procedureSessionId: ps.id, title: 'Consent for Chemical peel', mime: 'image/png', dataBase64: PNG });
  assert.equal(sig.status, 200, JSON.stringify(sig.body));
  const ok = await R('PATCH', `/procedure-sessions/${ps.id}`, { state: 'in_progress', consent: true, consentDocumentId: sig.body.id });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const s = (await R('GET', `/procedure-sessions/${ps.id}`)).body;
  assert.equal(s.consentNeeded, false);
  assert.equal(s.consent.how, 'signed'); assert.equal(s.consent.documentId, sig.body.id); assert.ok(s.consent.grantedAt);
  const file = await app.inject({ method: 'GET', url: `/api/documents/${sig.body.id}/file`, cookies: { cc_session: await login('reception@demo.clinic') } });
  assert.equal(file.statusCode, 200); assert.equal(file.headers['content-type'], 'image/png');

  // "Paper form filed" still works for a new procedure type
  const laser = (await O('GET', '/config')).body.procedures.find((x: any) => x.id !== peel.id);
  const { p: p2, e: e2 } = await planned(O, R, 'Paper Form', '9848077003', laser.id);
  await O('PATCH', `/encounters/${e2.id}`, { data: { complaint: { chief_complaint: ['Acne'] }, assessment: { diagnosis: [{ name: 'Acne' }] } }, complete: true, recommendations: [{ kind: 'procedure', procedureId: laser.id, sittings: 1 }] });
  const rec2 = (await O('GET', '/worklist?kind=procedure')).body.find((r: any) => r.patientId === p2.id);
  const ps2 = (await R('POST', '/procedure-sessions', { recommendationId: rec2.id, day: today(), startTime: '16:00', minutes: 30, force: true })).body;
  assert.equal((await R('PATCH', `/procedure-sessions/${ps2.id}`, { state: 'in_progress', consent: true })).status, 200);
  const s2 = (await R('GET', `/procedure-sessions/${ps2.id}`)).body;
  assert.equal(s2.consent.how, 'signed paper form filed'); assert.equal(s2.consent.documentId, undefined);
});

test('no WhatsApp: a prescription, a pharmacy receipt and a quote for an opted-out patient are not queued', async () => {
  const O = as(await login('owner@demo.clinic')); const R = as(await login('reception@demo.clinic')); const P = as(await login('pharmacy@demo.clinic'));
  const cfg = (await O('GET', '/config')).body;
  const peel = cfg.procedures.find((x: any) => x.name === 'Chemical peel');
  const cet = cfg.medicines.find((m: any) => m.name === 'Cetirizine 10 mg');
  const { p, e } = await planned(O, R, 'No Whatsapp', '9848077010', peel.id, { noWhatsapp: true });
  assert.equal(p.noWhatsapp, true);

  // prescription on Finish
  const fin = await O('PATCH', `/encounters/${e.id}`, { data: { complaint: { chief_complaint: ['Itching'] }, assessment: { diagnosis: [{ name: 'Urticaria' }] } }, complete: true,
    prescription: [{ medicineId: cet.id, name: cet.name, frequency: '0-0-1', durationDays: 7, qty: 7 }], recommendations: [{ kind: 'procedure', procedureId: peel.id, sittings: 2 }] });
  assert.equal(fin.status, 200, JSON.stringify(fin.body));

  // pharmacy receipt on WhatsApp
  assert.equal((await P('POST', '/stock/receipts', { lines: [{ medicineId: cet.id, qty: 20, ratePaise: 1000, batchNo: 'NW1', expiry: ym(18) }] })).status, 200);
  const sale = await P('POST', '/pharmacy/sale', { patientId: p.id, items: [{ medicineId: cet.id, qty: 2 }], method: 'cash', whatsapp: true });
  assert.equal(sale.status, 200, JSON.stringify(sale.body));
  assert.equal(sale.body.whatsapp, 'opted_out', 'the screen is told to print it instead');

  // quote on WhatsApp
  const rec = (await O('GET', '/worklist?kind=procedure')).body.find((r: any) => r.patientId === p.id);
  const q = await O('POST', '/quotes', { recommendationId: rec.id, validDays: 15, send: 'whatsapp' });
  assert.equal(q.status, 200, JSON.stringify(q.body));
  assert.equal(q.body.messaged, false); assert.equal(q.body.whatsapp, 'opted_out');

  const msgs = (await O('GET', `/messages?patientId=${p.id}`)).body;
  for (const kind of ['rx', 'pharmacy_receipt', 'quote']) {
    const m = msgs.find((x: any) => x.kind === kind);
    assert.ok(m, `a ${kind} message is recorded`);
    assert.equal(m.status, 'skipped', `${kind} is not sent`);
    assert.equal(m.error, 'patient asked for no WhatsApp messages');
  }
  assert.equal(msgs.filter((x: any) => x.status === 'pending').length, 0, 'nothing waits to go out');
});
