// Booking guards: one phone rule on both sides, no duplicate patient when a known caller is booked as "new", honest WhatsApp flags.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-sched-guards';
process.env.COOKIE_SECRET = 'test-secret';
delete process.env.WHATSAPP_TOKEN;
rmSync(process.env.PGLITE_DIR, { recursive: true, force: true });

const { migrate, applyRls } = await import('../src/db/index.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { buildApp } = await import('../src/app.js');
const { normPhone: serverNorm } = await import('../src/modules/scheduling.js');
const { normPhone, searchText } = await import('../web/src/phone.js');

let app: Awaited<ReturnType<typeof buildApp>>;
type Call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) => Promise<{ status: number; body: any }>;
async function as(email: string): Promise<Call> {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenant: 'sahitya' } });
  assert.equal(r.statusCode, 200, r.body);
  const cookie = r.cookies.find((c) => c.name === 'cc_session')!.value;
  return (method, url, payload) => app.inject({ method, url: '/api' + url, payload: payload as any, cookies: { cc_session: cookie } }).then((res) => ({ status: res.statusCode, body: res.body ? res.json() : null }));
}
const addDays = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

before(async () => { await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp(); });
after(async () => { await app.close(); });

test('phone: pasted Indian numbers become 10 digits, the same in the browser and on the server', () => {
  const cases: [string, string][] = [
    ['+91 98765 43210', '9876543210'], ['098765 43210', '9876543210'], ['+919876543210', '9876543210'], ['919876543210', '9876543210'],
    ['0091-98765-43210', '9876543210'], ['98765-43210', '9876543210'], ['(98765) 43210', '9876543210'], ['9876543210', '9876543210'],
    ['9123456789', '9123456789'], ['91234', '91234'], ['', ''], ['+91 98765 432109999', '9876543210'],
  ];
  for (const [raw, want] of cases) {
    assert.equal(normPhone(raw), want, `browser: ${raw}`);
    assert.equal(serverNorm(raw), want, `server: ${raw}`);
  }
  assert.equal(searchText('+91 98765 43210'), '9876543210');
  assert.equal(searchText(' Meena R '), 'Meena R');
});

test('booking a "new" caller with the same mobile and name reuses the patient; a family member on that number is new', async () => {
  const reception = await as('reception@demo.clinic');
  const cfg = (await reception('GET', '/config')).body;
  const doc = cfg.practitioners.find((p: any) => p.name.startsWith('Dr. Main')).id;
  const day = addDays(today(), 3);
  const ws = (await reception('GET', `/sessions?day=${day}&practitionerId=${doc}`)).body.filter((w: any) => w.free > 0);
  assert.ok(ws.length >= 3, 'three windows with room');

  const a = await reception('POST', '/appointments', { sessionId: ws[0].id, newPatient: { fullName: 'Meena Rao', phone: '+91 98765 11111' } });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(a.body.reusedPatient, false);
  assert.equal(a.body.whatsapp, 'not_connected', 'confirmation is queued but WhatsApp is not connected in tests');

  // same phone + same name → the same record, which already has a booking: refused, pointing at that booking
  const b = await reception('POST', '/appointments', { sessionId: ws[1].id, newPatient: { fullName: '  meena   RAO ', phone: '098765 11111' } });
  assert.equal(b.status, 409, JSON.stringify(b.body));
  assert.equal(b.body.code, 'ALREADY_BOOKED');
  assert.equal(b.body.id, a.body.id, 'the existing booking of the same patient');

  const twice = await reception('POST', '/appointments', { sessionId: ws[0].id, newPatient: { fullName: 'Meena Rao', phone: '9876511111' } });
  assert.equal(twice.status, 409, 'already booked in that window');
  assert.equal(twice.body.code, 'ALREADY_BOOKED');

  const c = await reception('POST', '/appointments', { sessionId: ws[2].id, newPatient: { fullName: 'Arjun Rao', phone: '9876511111' } });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.notEqual(c.body.patientId, a.body.patientId, 'another name on the number is another person');

  const fam = (await reception('GET', '/patients?q=9876511111')).body;
  assert.equal(fam.filter((p: any) => p.phone === '9876511111').length, 2, 'two people on the number, not three');

  const noPhone = await reception('POST', '/appointments', { sessionId: ws[2].id, newPatient: { fullName: 'No Phone Person' } });
  assert.equal(noPhone.status, 200);
  assert.equal(noPhone.body.whatsapp, 'no_phone');

  const mv = await reception('PATCH', `/appointments/${a.body.id}`, { sessionId: ws[2].id });
  assert.equal(mv.status, 200, JSON.stringify(mv.body));
  assert.equal(mv.body.whatsapp, 'not_connected');
  const quiet = await reception('PATCH', `/appointments/${a.body.id}`, { sessionId: ws[0].id, notify: false });
  assert.equal(quiet.body.whatsapp, 'none');
});
