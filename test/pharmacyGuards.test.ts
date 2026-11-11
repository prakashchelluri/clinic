// Pharmacy guards: a bill sent twice is one bill; no more than prescribed without a reason; the counter's quantity
// follows the doctor; Schedule H needs a prescription line; returns do not go back on the shelf unless sealed; walk-ins make no record.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-pharmacy-guards';
process.env.UPLOAD_DIR = './data/test-uploads-pharmacy-guards';
process.env.COOKIE_SECRET = 'test-secret';
rmSync(process.env.PGLITE_DIR, { recursive: true, force: true });

const { migrate, applyRls, db } = await import('../src/db/index.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { buildApp } = await import('../src/app.js');
const { prescribedQty, doseCount } = await import('../src/modules/pharmacy.js');
const S = await import('../src/db/schema.js');
const { eq, and } = await import('drizzle-orm');

let app: Awaited<ReturnType<typeof buildApp>>;
const login = async (email: string) => (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenant: 'sahitya' } })).cookies.find((c) => c.name === 'cc_session')!.value;
before(async () => { await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp(); });
after(async () => { await app.close(); });
const ym = (months: number) => { const d = new Date(); d.setUTCMonth(d.getUTCMonth() + months); return d.toISOString().slice(0, 7); };

test('quantity: the doctor’s saved quantity wins; a strength never multiplies', () => {
  const cap = { form: 'cap', packSize: 10 };
  assert.equal(doseCount('20 mg'), 1); assert.equal(doseCount('2 tab'), 2); assert.equal(doseCount('2'), 2); assert.equal(doseCount('5 ml'), 1); assert.equal(doseCount('1000 IU'), 1);
  assert.equal(prescribedQty({ dose: '20 mg', frequency: '1-0-0', durationDays: 30 }, cap), 3, '20 mg once a day for 30 days is 3 strips, not 60');
  assert.equal(prescribedQty({ dose: '2 tab', frequency: '1-0-1', durationDays: 5 }, cap), 2, '2 × 2 × 5 = 20 tablets = 2 strips');
  assert.equal(prescribedQty({ qty: 25, dose: '20 mg', frequency: '1-0-0', durationDays: 30 }, cap), 3, 'doctor said 25 capsules: 3 strips');
  assert.equal(prescribedQty({ qty: 2, dose: null, frequency: 'twice daily', durationDays: 30 }, { form: 'cream', packSize: 1 }), 2, 'doctor said 2 tubes');
  assert.equal(prescribedQty({ dose: null, frequency: 'twice daily', durationDays: 30 }, { form: 'cream', packSize: 1 }), 1);
});

test('sale guards: idempotent bill, Schedule H per line, over-issue, walk-in with no record, returns not restocked by default', async () => {
  const owner = await login('owner@demo.clinic'); const ph = await login('pharmacy@demo.clinic');
  const as = (c: string) => (method: 'GET' | 'POST', url: string, payload?: unknown) => app.inject({ method, url: '/api' + url, cookies: { cc_session: c }, payload: payload as any });
  const O = as(owner), P = as(ph);
  const meds = (await O('GET', '/config')).json().medicines as any[];
  const by = (n: string) => meds.find((m) => m.name === n);
  const doxy = by('Doxycycline 100 mg'), cet = by('Cetirizine 10 mg'), mom = by('Mometasone 0.1% cream'), sun = by('Sunscreen SPF 50');
  // opening stock (no vendor, no bill)
  const r = await P('POST', '/stock/receipts', { lines: [doxy, cet, mom, sun].map((m, i) => ({ medicineId: m.id, qty: 20, ratePaise: 1000, batchNo: `G${i}`, expiry: ym(18) })) });
  assert.equal(r.statusCode, 200, r.body);

  // 1. the same bill twice (reply lost on a slow line): one sale, stock taken once
  const onHand = async (id: string) => (await P('GET', `/stock/medicines/${id}`)).json().onHand;
  const cet0 = await onHand(cet.id);
  const walk = { walkIn: { fullName: 'Ravi', phone: '9000000099' }, items: [{ medicineId: cet.id, qty: 2 }], method: 'cash', idempotencyKey: 'bill-abc-12345' };
  const a1 = await P('POST', '/pharmacy/sale', walk); assert.equal(a1.statusCode, 200, a1.body);
  const a2 = await P('POST', '/pharmacy/sale', walk); assert.equal(a2.statusCode, 200, a2.body);
  assert.equal(a1.json().id, a2.json().id, 'the repeat returns the first sale'); assert.equal(a1.json().invoiceNo, a2.json().invoiceNo);
  assert.equal(await onHand(cet.id), cet0 - 2, 'stock is taken once');

  // 13. walk-in with no record: one shared record, name and phone kept on the sale only
  const pts0 = (await db.select().from(S.patient)).length;
  const w2 = await P('POST', '/pharmacy/sale', { walkIn: {}, items: [{ medicineId: sun.id, qty: 1 }], method: 'upi' });
  assert.equal(w2.statusCode, 200, w2.body); assert.equal(w2.json().patientId, a1.json().patientId, 'the same Walk-in record');
  assert.equal((await db.select().from(S.patient)).length, pts0, 'no new patient record');
  assert.equal(a1.json().buyerName, 'Ravi');
  assert.equal((await P('GET', `/pharmacy/sale/${a1.json().id}`)).json().patient.fullName, 'Ravi');
  // 10. UPI without a transaction number is fine; card still needs its approval code
  assert.equal((await P('POST', '/pharmacy/sale', { walkIn: {}, items: [{ medicineId: sun.id, qty: 1 }], method: 'card' })).json().code, 'REFERENCE_REQUIRED');

  // 4. Schedule H: never to a walk-in
  const nx = await P('POST', '/pharmacy/sale', { walkIn: {}, items: [{ medicineId: doxy.id, qty: 1 }], method: 'cash' });
  assert.equal(nx.statusCode, 400); assert.equal(nx.json().code, 'NEEDS_PRESCRIPTION'); assert.match(nx.json().message, /Doxycycline 100 mg needs a doctor's prescription/);
  const [t] = await db.select().from(S.tenant).where(eq(S.tenant.slug, 'sahitya'));
  const [br] = await db.select().from(S.branch).where(eq(S.branch.tenantId, t.id));
  const [fee] = await db.select().from(S.feeCategory).where(eq(S.feeCategory.tenantId, t.id));
  const [form] = await db.select().from(S.formDefinition).where(eq(S.formDefinition.tenantId, t.id));
  const [doc] = await db.select().from(S.practitioner).where(eq(S.practitioner.tenantId, t.id));
  const [p] = await db.insert(S.patient).values({ tenantId: t.id, patientNo: 'P91001', fullName: 'Meena', phone: '7993000001' }).returning();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const [vi] = await db.insert(S.visit).values({ tenantId: t.id, branchId: br.id, patientId: p.id, feeCategoryId: fee.id, day: today, opNumber: 'GEN-77', queuePosition: '1', status: 'done' }).returning();
  const [e] = await db.insert(S.encounter).values({ tenantId: t.id, visitId: vi.id, patientId: p.id, practitionerId: doc?.id ?? null, formDefinitionId: form.id, status: 'completed', completedAt: new Date().toISOString() }).returning();
  // the doctor saved 20 capsules (2 strips); the dose is a strength, which must not multiply
  await db.insert(S.prescriptionItem).values({ tenantId: t.id, encounterId: e.id, medicineId: doxy.id, name: doxy.name, dose: '100 mg', frequency: '1-0-0', durationDays: 20, qty: 20, sortOrder: 0 });
  const rx = (await P('GET', `/pharmacy/rx/${e.id}`)).json(); const it = rx.items[0];
  assert.equal(it.prescribed, 2, "the counter uses the doctor's 20 capsules = 2 strips");
  const sale = (items: any[], extra: any = {}) => P('POST', '/pharmacy/sale', { patientId: p.id, encounterId: e.id, items, method: 'cash', ...extra });
  // an H item on the prescription bill that the doctor did not prescribe is refused too
  const ex = await sale([{ medicineId: doxy.id, qty: 1, prescriptionItemId: it.id }, { medicineId: mom.id, qty: 1 }]);
  assert.equal(ex.json().code, 'NEEDS_PRESCRIPTION'); assert.match(ex.json().message, /Mometasone/);
  assert.equal((await sale([{ medicineId: mom.id, qty: 1, prescriptionItemId: it.id }])).json().code, 'NOT_ON_THIS_RX', 'the line must be for this medicine');

  // 2. over-issue: more than prescribed needs a reason, across bills
  const over = await sale([{ medicineId: doxy.id, qty: 3, prescriptionItemId: it.id }]);
  assert.equal(over.statusCode, 400); assert.equal(over.json().code, 'MORE_THAN_PRESCRIBED'); assert.equal(over.json().left, 2);
  const s1 = await sale([{ medicineId: doxy.id, qty: 1, prescriptionItemId: it.id }, { medicineId: cet.id, qty: 1 }]);
  assert.equal(s1.statusCode, 200, s1.body);
  assert.equal((await sale([{ medicineId: doxy.id, qty: 2, prescriptionItemId: it.id }])).json().code, 'MORE_THAN_PRESCRIBED', 'one left after the first bill');
  const s2 = await sale([{ medicineId: doxy.id, qty: 2, prescriptionItemId: it.id, overReason: 'Doctor phoned: 3 weeks' }]);
  assert.equal(s2.statusCode, 200, s2.body); assert.equal(s2.json().items[0].overReason, 'Doctor phoned: 3 weeks');

  // the register: the prescribed line is under the doctor; nothing unprescribed carries the doctor's name
  const reg = (await P('GET', '/pharmacy/schedule-register?cls=all')).json() as any[];
  const mine = reg.filter((x) => x.invoiceNo === s1.json().invoiceNo);
  assert.equal(mine.length, 1, 'only the H line is in the register'); assert.equal(mine[0].noRx, false);

  // 8. an expired batch cannot be sold, even when picked by id
  const [old] = await db.insert(S.stockBatch).values({ tenantId: t.id, medicineId: cet.id, batchNo: 'OLD1', expiry: '2020-01-31', qty: 5, mrpPaise: 3000 }).returning();
  assert.equal((await P('POST', '/pharmacy/sale', { walkIn: {}, items: [{ medicineId: cet.id, qty: 1, batchId: old.id }], method: 'cash' })).json().code, 'BATCH_NOT_SELLABLE');

  // 6. returns: not back on the shelf unless the pharmacist says it is sealed; written off instead
  const bill = s1.json(); const cetLine = bill.items.findIndex((l: any) => l.medicineId === cet.id); const doxyLine = bill.items.findIndex((l: any) => l.medicineId === doxy.id);
  const c0 = await onHand(cet.id), d0 = await onHand(doxy.id);
  const ret = await P('POST', `/pharmacy/sale/${bill.id}/return`, { lines: [{ line: cetLine, qty: 1, restock: false }, { line: doxyLine, qty: 1, restock: true }], reason: 'Opened strip, wrong item', method: 'cash' });
  assert.equal(ret.statusCode, 200, ret.body);
  assert.equal(await onHand(cet.id), c0, 'opened item is not sellable again');
  assert.equal(await onHand(doxy.id), d0 + 1, 'sealed item goes back');
  const moves = await db.select().from(S.stockMove).where(and(eq(S.stockMove.tenantId, t.id), eq(S.stockMove.docNo, ret.json().creditNoteNo)));
  assert.deepEqual(moves.map((m) => `${m.kind}:${m.change}`).sort(), ['adjust:-1', 'patient_return:1', 'patient_return:1'], 'the write-off is on record');

  // 5. void takes a reason and never reuses the patient's UTR as the refund reference
  const v = (await P('POST', '/pharmacy/sale', { walkIn: {}, items: [{ medicineId: sun.id, qty: 1 }], payments: [{ method: 'upi', amountPaise: sun.mrpPaise, reference: '123456789012' }] }));
  assert.equal(v.statusCode, 200, v.body);
  const vd = (await P('POST', `/pharmacy/sale/${v.json().id}/void`, { reason: 'Wrong item' })).json();
  assert.equal(vd.reason, 'Undone at the counter: Wrong item'); assert.notEqual(vd.reference, '123456789012');

  // cancelling a whole bill (owner) writes the items off unless the owner says they are sealed
  const cb = (await P('POST', '/pharmacy/sale', { walkIn: {}, items: [{ medicineId: cet.id, qty: 2 }], method: 'cash' })).json();
  const cBefore = await onHand(cet.id);
  assert.equal((await O('POST', `/pharmacy/sale/${cb.id}/cancel`, { reason: 'Wrong patient', method: 'cash' })).statusCode, 200);
  assert.equal(await onHand(cet.id), cBefore, 'not back on the shelf by default');
});
