// Pharmacy stock and counter: orders with the vendor's promise, receiving checked against it, the owner's decision,
// free goods owed, issuing a prescription in full, short or not at all, split payments, returns, counts and returns to vendor.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-pharmacy';
process.env.UPLOAD_DIR = './data/test-uploads-pharmacy';
process.env.COOKIE_SECRET = 'test-secret';
rmSync(process.env.PGLITE_DIR, { recursive: true, force: true });

const { migrate, applyRls, db } = await import('../src/db/index.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { buildApp } = await import('../src/app.js');
const S = await import('../src/db/schema.js');
const { eq } = await import('drizzle-orm');

let app: Awaited<ReturnType<typeof buildApp>>;
const login = async (email: string) => (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenant: 'sahitya' } })).cookies.find((c) => c.name === 'cc_session')!.value;
before(async () => { await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp(); });
after(async () => { await app.close(); });

const PHOTO = { mime: 'image/png', dataBase64: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]).toString('base64') };
const ym = (months: number) => { const d = new Date(); d.setUTCMonth(d.getUTCMonth() + months); return d.toISOString().slice(0, 7); };
const gst = (paise: number, bp: number) => paise + Math.round((paise * bp) / 10000);

test('stock: order, receive against the promise, owner decides, free goods owed and settled', async () => {
  const owner = await login('owner@demo.clinic'); const ph = await login('pharmacy@demo.clinic');
  const as = (c: string) => (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) => app.inject({ method, url: '/api' + url, cookies: { cc_session: c }, payload: payload as any });
  const O = as(owner), P = as(ph);
  const meds = (await O('GET', '/config')).json().medicines as any[];
  const iso = meds.find((m) => m.name === 'Isotretinoin 20 mg'); const sun = meds.find((m) => m.name === 'Sunscreen SPF 50');
  assert.equal(iso.packSize, 10, 'capsules are sold by the strip of 10');

  // vendors
  assert.equal((await P('POST', '/vendors', { name: 'X' })).statusCode, 400, 'name too short');
  assert.equal((await P('POST', '/vendors', { name: 'Godavari Medical Agencies', phone: '12345' })).statusCode, 400, 'phone has 10 digits');
  const v = (await P('POST', '/vendors', { name: 'Godavari Medical Agencies', phone: '9000000001', gstin: '37ABCDE1234F1Z5' })).json();
  assert.equal((await P('POST', '/vendors', { name: 'godavari medical agencies' })).statusCode, 409, 'no duplicate vendor');

  // order: the scheme text works out the free units
  const bad = await P('POST', '/stock/orders', { vendorId: v.id, lines: [{ medicineId: iso.id, qty: 0, ratePaise: 4500 }] });
  assert.equal(bad.statusCode, 400, 'quantity at least 1');
  const po = (await P('POST', '/stock/orders', { vendorId: v.id, dueDate: '2030-01-01', lines: [{ medicineId: iso.id, qty: 50, scheme: '5 free per 50', ratePaise: 4500 }, { medicineId: sun.id, qty: 12, scheme: '10+1', ratePaise: 30000, discBp: 1000 }] })).json();
  assert.equal(po.docNo, 'PO-0001'); assert.deepEqual(po.lines.map((l: any) => l.freeQty), [5, 1]);
  const draft = (await P('GET', `/stock/order-draft?vendorId=${v.id}`)).json();
  assert.ok(draft.lines.every((l: any) => l.low), 'the draft holds low-stock medicines'); assert.equal(draft.all.find((x: any) => x.medicineId === iso.id).ratePaise, 4500, 'last agreed rate is remembered');

  // receiving: bill photo, bill no and a bill total that matches the lines are required
  const lines = [{ medicineId: iso.id, qty: 50, freeQty: 3, ratePaise: 4800, batchNo: 'ISO2410A', expiry: ym(24) }, { medicineId: sun.id, qty: 12, freeQty: 1, ratePaise: 30000, discBp: 1000, batchNo: 'SG50-52', expiry: ym(2) }];
  const billTotal = gst(50 * 4800, iso.gstBp) + gst(12 * 27000, sun.gstBp);
  const rec = { orderId: po.id, billNo: 'GMA/2210', billDate: '2026-10-31', billTotalPaise: billTotal, billPhoto: PHOTO, lines };
  assert.equal((await P('POST', '/stock/receipts', { ...rec, billPhoto: undefined })).json().code, 'BILL_PHOTO_REQUIRED');
  assert.equal((await P('POST', '/stock/receipts', { ...rec, billTotalPaise: billTotal + 1000 })).json().code, 'BILL_TOTAL_MISMATCH');
  assert.equal((await P('POST', '/stock/receipts', { ...rec, lines: [{ ...lines[0], expiry: '2020-01' }] })).json().code, 'EXPIRED_BATCH');
  assert.equal((await P('POST', '/stock/receipts', { ...rec, lines: [{ ...lines[0], expiry: '2030-13' }] })).statusCode, 400, 'month 13');
  const r = await P('POST', '/stock/receipts', rec); assert.equal(r.statusCode, 200, r.body);
  const grn = r.json();
  assert.equal(grn.status, 'review'); const l0 = grn.lines[0];
  assert.equal(l0.freeShort, 2); assert.equal(l0.extraPaise, gst(50 * 4800, iso.gstBp) - gst(50 * 4500, iso.gstBp), 'rate ₹48 vs ₹45 promised, with GST');
  assert.equal(l0.costPaise, Math.round((50 * 4800) / 53), 'real cost per strip counts the free ones');
  assert.equal(grn.lines[1].freeShort + grn.lines[1].extraPaise, 0, 'the second line matches');
  assert.equal((await P('POST', '/stock/receipts', rec)).json().code, 'ORDER_CLOSED');
  assert.equal((await P('GET', `/stock/docs/${grn.id}/photo`)).statusCode, 200, 'bill photo kept');
  const msgs = await db.select().from(S.message).where(eq(S.message.toPhone, '9000000001'));
  assert.deepEqual(msgs.map((m) => m.kind).sort(), ['vendor_order', 'vendor_receipt'], 'the vendor hears about the order and what was received');

  // the stock tab shows it waiting; only the owner decides
  const st = (await P('GET', '/stock')).json();
  assert.equal(st.reviews.length, 1); assert.equal(st.items.find((i: any) => i.id === iso.id).onHand, 53);
  assert.equal((await P('POST', `/stock/receipts/${grn.id}/decide`, { choice: 'owe' })).statusCode, 403, 'pharmacy cannot decide');
  assert.equal((await O('POST', `/stock/receipts/${grn.id}/decide`, { choice: 'accept' })).json().code, 'REASON_REQUIRED');
  assert.equal((await O('POST', `/stock/receipts/${grn.id}/decide`, { choice: 'debit' })).json().decision.debitPaise, l0.extraPaise);
  assert.equal((await O('POST', `/stock/receipts/${grn.id}/decide`, { choice: 'owe' })).json().code, 'ALREADY_DECIDED');
  let acct = (await P('GET', `/vendors/${v.id}`)).json();
  assert.equal(acct.tiles.owedUnits, 2); assert.equal(acct.owed[0].fromDocNo, 'GMA/2210');

  // the next delivery brings the 2 owed strips on top of its own scheme: the owed line closes by itself
  const po2 = (await P('POST', '/stock/orders', { vendorId: v.id, lines: [{ medicineId: iso.id, qty: 50, scheme: '5 free per 50', ratePaise: 4500 }] })).json();
  const r2 = (await P('POST', '/stock/receipts', { orderId: po2.id, billNo: 'GMA/2290', billTotalPaise: gst(50 * 4500, iso.gstBp), billPhoto: PHOTO, lines: [{ medicineId: iso.id, qty: 50, freeQty: 7, ratePaise: 4500, batchNo: 'ISO2411B', expiry: ym(26) }] })).json();
  assert.equal(r2.status, 'ok');
  acct = (await P('GET', `/vendors/${v.id}`)).json(); assert.equal(acct.tiles.owedUnits, 0); assert.equal(acct.owed[0].status, 'received');

  // opening stock: no vendor, no bill
  const open = await P('POST', '/stock/receipts', { lines: [{ medicineId: meds.find((m) => m.name === 'Cetirizine 10 mg').id, qty: 20, ratePaise: 1800, batchNo: 'OPN-1', expiry: ym(18) }] });
  assert.equal(open.statusCode, 200, open.body); assert.equal(open.json().note, 'Opening stock');

  // item page: batches with paid and free, every movement with who did it
  const item = (await P('GET', `/stock/medicines/${iso.id}`)).json();
  assert.equal(item.onHand, 110); assert.equal(item.batches.length, 2); assert.ok(item.batches[0].sellingNow);
  assert.deepEqual(item.moves.map((m: any) => m.change), [57, 53]); assert.equal(item.moves[0].balance, 110);
});

test('counter: issue a prescription in full, short or not at all; split payment; returns; count; return to vendor', async () => {
  const owner = await login('owner@demo.clinic'); const ph = await login('pharmacy@demo.clinic');
  const as = (c: string) => (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) => app.inject({ method, url: '/api' + url, cookies: { cc_session: c }, payload: payload as any });
  const O = as(owner), P = as(ph);
  const meds = (await O('GET', '/config')).json().medicines as any[];
  const iso = meds.find((m) => m.name === 'Isotretinoin 20 mg'); const sun = meds.find((m) => m.name === 'Sunscreen SPF 50'); const ada = meds.find((m) => m.name === 'Adapalene 0.1% gel');

  // a completed consultation today with three medicines
  const [t] = await db.select().from(S.tenant).where(eq(S.tenant.slug, 'sahitya'));
  const [br] = await db.select().from(S.branch).where(eq(S.branch.tenantId, t.id));
  const [fee] = await db.select().from(S.feeCategory).where(eq(S.feeCategory.tenantId, t.id));
  const [form] = await db.select().from(S.formDefinition).where(eq(S.formDefinition.tenantId, t.id));
  const [p] = await db.insert(S.patient).values({ tenantId: t.id, patientNo: 'P90001', fullName: 'Manikanta', phone: '7993123456', allergies: 'sulfa drugs' }).returning();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const [vi] = await db.insert(S.visit).values({ tenantId: t.id, branchId: br.id, patientId: p.id, feeCategoryId: fee.id, day: today, opNumber: 'GEN-14', queuePosition: '1', status: 'done' }).returning();
  const [e] = await db.insert(S.encounter).values({ tenantId: t.id, visitId: vi.id, patientId: p.id, formDefinitionId: form.id, status: 'completed', completedAt: new Date().toISOString() }).returning();
  await db.insert(S.prescriptionItem).values([
    { tenantId: t.id, encounterId: e.id, medicineId: iso.id, name: iso.name, dose: '1 cap', frequency: '1-0-0 after food', durationDays: 30, sortOrder: 0 },
    { tenantId: t.id, encounterId: e.id, medicineId: sun.id, name: sun.name, frequency: 'twice daily', durationDays: 30, sortOrder: 1 },
    { tenantId: t.id, encounterId: e.id, medicineId: ada.id, name: ada.name, frequency: 'at night', durationDays: 56, sortOrder: 2 }]);

  // the counter lists it; nothing is "pending"
  const c = (await P('GET', '/pharmacy/counter')).json();
  assert.equal(c.today.find((r: any) => r.encounterId === e.id).status, 'none');
  assert.equal((await P('GET', '/pharmacy/counter?q=7993123456')).json().found.length, 1, 'search by phone');
  const rx = (await P('GET', `/pharmacy/rx/${e.id}`)).json();
  assert.deepEqual(rx.items.map((i: any) => i.prescribed), [3, 1, 1], '1 cap a day × 30 days = 3 strips; a tube is one');
  assert.equal(rx.patient.allergies, 'sulfa drugs');
  const [itIso, itSun, itAda] = rx.items;
  assert.equal(itAda.onHand, 0, 'no adapalene in stock');

  // issue: isotretinoin short (1 of 3), sunscreen in full, adapalene skipped; UPI + cash split
  const mrp = (it: any) => it.batches[0].mrpPaise;
  const total = mrp(itIso) + mrp(itSun);
  const sale = { patientId: p.id, encounterId: e.id, items: [{ medicineId: iso.id, qty: 1, prescriptionItemId: itIso.id }, { medicineId: sun.id, qty: 1, prescriptionItemId: itSun.id }],
    notIssued: [{ prescriptionItemId: itIso.id, reason: 'Will buy later' }, { prescriptionItemId: itAda.id, reason: 'Out of stock' }] };
  assert.equal((await P('POST', '/pharmacy/sale', { ...sale, payments: [{ method: 'upi', amountPaise: 50000 }, { method: 'cash', amountPaise: total - 50000 }] })).json().code, 'REFERENCE_REQUIRED');
  assert.equal((await P('POST', '/pharmacy/sale', { ...sale, payments: [{ method: 'upi', amountPaise: 50000, reference: 'UTR123456' }, { method: 'cash', amountPaise: 100 }] })).json().code, 'PAYMENTS_DO_NOT_ADD_UP');
  assert.equal((await P('POST', '/pharmacy/sale', { ...sale, discountPaise: Math.round(total * 0.2), method: 'cash' })).json().code, 'DISCOUNT_NEEDS_OWNER', 'above 10% needs the owner');
  assert.equal((await P('POST', '/pharmacy/sale', { ...sale, items: [{ medicineId: ada.id, qty: 1, prescriptionItemId: itAda.id }], method: 'cash' })).json().code, 'NOT_ENOUGH_STOCK');
  assert.equal((await P('POST', '/pharmacy/sale', { ...sale, items: [{ medicineId: iso.id, qty: 1, batchId: '00000000-0000-4000-8000-000000000000' }], method: 'cash' })).json().code, 'BATCH_NOT_SELLABLE');
  const pays = [{ method: 'upi', amountPaise: 50000, reference: 'UTR123456' }, { method: 'cash', amountPaise: total - 50000 }];
  assert.equal((await P('POST', '/pharmacy/sale', { ...sale, payments: pays, receivedPaise: 1 })).json().code, 'RECEIVED_TOO_LOW');
  const s = await P('POST', '/pharmacy/sale', { ...sale, payments: pays, receivedPaise: total - 50000 + 2700, whatsapp: true });
  assert.equal(s.statusCode, 200, s.body); const bill = s.json();
  assert.equal(bill.method, 'split'); assert.equal(bill.totalPaise, total);
  assert.equal(bill.items[0].batchNo, 'ISO2410A', 'earliest expiry first');
  const after = (await P('GET', `/pharmacy/rx/${e.id}`)).json();
  assert.equal(after.status, 'part'); assert.deepEqual(after.items.map((i: any) => [i.issuedQty, i.left]), [[1, 2], [1, 0], [0, 1]]);
  assert.equal(after.items[2].notIssuedReason, 'Out of stock');
  const rcpt = (await P('GET', `/pharmacy/sale/${bill.id}`)).json();
  assert.equal(rcpt.payments.length, 2); assert.deepEqual(rcpt.notIssued.map((x: any) => [x.name, x.left]), [[iso.name, 2], [ada.name, 1]]);

  // the balance comes back later: the rest of the isotretinoin, same prescription
  const s2 = (await P('POST', '/pharmacy/sale', { patientId: p.id, encounterId: e.id, items: [{ medicineId: iso.id, qty: 2, prescriptionItemId: itIso.id }], method: 'card', reference: 'APPR99' })).json();
  assert.equal((await P('GET', `/pharmacy/rx/${e.id}`)).json().items[0].left, 0);
  assert.equal((await P('POST', '/pharmacy/sale', { patientId: p.id, encounterId: e.id, items: [{ medicineId: iso.id, qty: 1, prescriptionItemId: '00000000-0000-4000-8000-000000000000' }], method: 'cash' })).json().code, 'NOT_ON_THIS_RX');

  // bought nothing on another prescription: the reason is recorded, nothing is "pending"
  const [e2] = await db.insert(S.encounter).values({ tenantId: t.id, visitId: vi.id, patientId: p.id, formDefinitionId: form.id, status: 'completed', completedAt: new Date().toISOString() }).returning();
  await db.insert(S.prescriptionItem).values({ tenantId: t.id, encounterId: e2.id, medicineId: sun.id, name: sun.name, sortOrder: 0 });
  assert.equal((await P('POST', `/pharmacy/rx/${e2.id}/nothing`, {})).json().lines, 1);
  assert.equal((await P('GET', `/pharmacy/rx/${e2.id}`)).json().status, 'nothing');

  // return the sunscreen: back into its batch, cash refund, credit note; can't return more than was sold
  const sunLine = bill.items.findIndex((l: any) => l.medicineId === sun.id);
  const before = (await P('GET', `/stock/medicines/${sun.id}`)).json().onHand;
  assert.equal((await P('POST', `/pharmacy/sale/${bill.id}/return`, { lines: [{ line: sunLine, qty: 2 }], reason: 'unopened', method: 'cash' })).json().code, 'MORE_THAN_SOLD');
  assert.equal((await P('POST', `/pharmacy/sale/${bill.id}/return`, { lines: [{ line: sunLine, qty: 1 }], reason: 'x', method: 'cash' })).statusCode, 400, 'a reason is needed');
  const ret = (await P('POST', `/pharmacy/sale/${bill.id}/return`, { lines: [{ line: sunLine, qty: 1 }], reason: 'Already had one, unopened', method: 'cash' })).json();
  assert.equal(ret.creditNoteNo, 'CN-0001'); assert.equal(ret.refundPaise, bill.items[sunLine].amountPaise);
  assert.equal((await P('GET', `/stock/medicines/${sun.id}`)).json().onHand, before + 1);
  assert.equal((await P('GET', `/pharmacy/rx/${e.id}`)).json().items[1].issuedQty, 0, 'returned means not issued');
  assert.equal((await P('POST', `/pharmacy/sale/${s2.id}/cancel`, { reason: 'wrong patient', method: 'card', reference: 'APPR99' })).statusCode, 403, 'cancelling a bill needs the owner');

  const bills = (await P('GET', '/pharmacy/bills')).json();
  const mine = bills.rows.find((r: any) => r.id === bill.id); assert.equal(mine.refundPaise, ret.refundPaise);
  assert.equal(bills.totals.total - bills.totals.refunds, bills.totals.cash + bills.totals.upi + bills.totals.card, 'drawer totals net of refunds');
  assert.equal((await P('GET', '/pharmacy/bills?from=2026-02-01&to=2026-01-01')).statusCode, 400);

  // stock count: blind, gaps need the owner
  const cnt = (await P('POST', '/stock/counts')).json();
  assert.equal((await P('POST', '/stock/counts')).json().code, 'COUNT_OPEN');
  const blind = (await P('GET', `/stock/docs/${cnt.id}`)).json();
  assert.ok(blind.lines.every((l: any) => l.system === undefined), 'the system figure is hidden while counting');
  const sunBatch = (await P('GET', `/stock/medicines/${sun.id}`)).json().batches[0];
  const counted = blind.lines.map((l: any) => ({ batchId: l.batchId, counted: l.batchId === sunBatch.id ? sunBatch.qty - 4 : (l.batchNo === 'ISO2410A' ? 50 : null) })).filter((l: any) => l.counted !== null);
  assert.equal((await P('POST', `/stock/counts/${cnt.id}/submit`, { lines: counted })).json().code, 'COUNT_INCOMPLETE');
  const items = await Promise.all(blind.lines.map(async (l: any) => (await P('GET', `/stock/batches/${l.batchId}/trace`)).json()));
  const sub = (await P('POST', `/stock/counts/${cnt.id}/submit`, { lines: blind.lines.map((l: any, i: number) => ({ batchId: l.batchId, counted: l.batchId === sunBatch.id ? items[i].onHand - 4 : items[i].onHand })) })).json();
  assert.equal(sub.status, 'review'); assert.equal(sub.lines.filter((l: any) => l.state === 'gap').length, 1);
  const tr = (await P('GET', `/stock/batches/${sunBatch.id}/trace`)).json(); assert.ok(tr.received > 0 && tr.sellers.length, 'where the units went, and who sold');
  assert.equal((await P('POST', `/stock/counts/${cnt.id}/resolve`, { batchId: sunBatch.id, action: 'approve', reason: 'Unexplained loss' })).statusCode, 403);
  assert.equal((await O('POST', `/stock/counts/${cnt.id}/resolve`, { batchId: sunBatch.id, action: 'approve', reason: 'Unexplained loss' })).json().status, 'closed');
  assert.equal((await P('GET', `/stock/medicines/${sun.id}`)).json().batches[0].qty, sunBatch.qty - 4);

  // return to the vendor, by batch
  const v = (await P('GET', '/vendors')).json()[0];
  const rt = await P('POST', '/stock/returns', { vendorId: v.id, reason: 'Expiring in December', lines: [{ batchId: sunBatch.id, qty: 2 }] });
  assert.equal(rt.statusCode, 200, rt.body); assert.equal(rt.json().docNo, 'RT-0001');
  assert.equal((await P('POST', '/stock/returns', { vendorId: v.id, reason: 'too many', lines: [{ batchId: sunBatch.id, qty: 9999 }] })).json().code, 'NOT_ENOUGH_STOCK');

  // walk-in sale with the older single-payment shape still works
  const w = await P('POST', '/pharmacy/sale', { newPatient: { fullName: 'Walk In', phone: '9876500001' }, items: [{ medicineId: iso.id, qty: 1 }], method: 'cash' });
  assert.equal(w.statusCode, 200, w.body); assert.equal(w.json().encounterId, null);
});
