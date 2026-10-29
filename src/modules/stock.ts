import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, desc, asc, gt, gte, sql, inArray, ne } from 'drizzle-orm';
import { medicine, stockBatch, stockMove, stockDoc, vendor, vendorOwed, message } from '../db/schema.js';
import type { Tx } from '../db/index.js';
import { route } from '../lib/route.js';
import { emit, nextNumber, todayIn, addDays } from '../lib/core.js';
import { HttpError, can } from '../lib/auth.js';
import { putFile, getFile } from '../lib/storage.js';

/** Who is acting, for the stock ledger. */
export type Actor = { tenantId: string; userId: string; name: string };
const actor = (req: any): Actor => ({ tenantId: req.ctx.tenantId, userId: req.ctx.userId, name: req.ctx.name });

/** "YYYY-MM" → the last day of that month, which is how expiry is stored. */
export const expiryDate = (ym: string) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const Expiry = z.string().regex(/^20[0-9]{2}-(0[1-9]|1[0-2])$/, 'expiry as YYYY-MM');

/** "5 free per 50", "10+1", "buy 12 get 2" → free units for a quantity. Anything else: no scheme. */
export function schemeFree(scheme: string | null | undefined, qty: number) {
  const s = (scheme ?? '').toLowerCase();
  const m = s.match(/(\d+)\s*free\s*(?:per|on|for|with)\s*(\d+)/) ?? s.match(/buy\s*(\d+)\s*get\s*(\d+)/) ?? s.match(/^\s*(\d+)\s*\+\s*(\d+)\s*$/);
  if (!m) return 0;
  const [buy, get] = /free/.test(s) ? [Number(m[2]), Number(m[1])] : [Number(m[1]), Number(m[2])];
  return buy > 0 ? Math.floor(qty / buy) * get : 0;
}

/** Taxable value of a purchase line: qty × rate less the line discount. */
const taxable = (qty: number, ratePaise: number, discBp: number) => Math.round((qty * ratePaise * (10000 - discBp)) / 10000);
const withGst = (amount: number, gstBp: number) => amount + Math.round((amount * gstBp) / 10000);

/** Change one batch and write the ledger line. The batch row is locked so two counters cannot oversell it. */
export async function moveStock(tx: Tx, a: Actor, batchId: string, change: number, kind: string, doc: { id?: string | null; no?: string | null; note?: string | null; at?: string }) {
  const [b] = await tx.select().from(stockBatch).where(and(eq(stockBatch.id, batchId), eq(stockBatch.tenantId, a.tenantId))).for('update');
  if (!b) throw new HttpError(404, 'BATCH_NOT_FOUND');
  if (b.qty + change < 0) throw new HttpError(409, 'NOT_ENOUGH_STOCK', { batchNo: b.batchNo, onHand: b.qty });
  await tx.update(stockBatch).set({ qty: b.qty + change }).where(eq(stockBatch.id, b.id));
  const [{ total }] = await tx.select({ total: sql<number>`coalesce(sum(${stockBatch.qty}), 0)::int` }).from(stockBatch).where(and(eq(stockBatch.tenantId, a.tenantId), eq(stockBatch.medicineId, b.medicineId)));
  await tx.insert(stockMove).values({ tenantId: a.tenantId, batchId: b.id, medicineId: b.medicineId, change, balance: Number(total), kind, docId: doc.id ?? null, docNo: doc.no ?? null, note: doc.note ?? null, by: a.userId, byName: a.name, ...(doc.at ? { createdAt: doc.at } : {}) });
  return b;
}

/**
 * Which batches a sale takes from: the one asked for, else earliest expiry first. Expired batches are never sold.
 * A quantity larger than one batch spills into the next.
 */
export async function allocate(tx: Tx, t: string, medicineId: string, qty: number, today: string, batchId?: string | null) {
  const rows = await tx.select().from(stockBatch).where(and(eq(stockBatch.tenantId, t), eq(stockBatch.medicineId, medicineId), gt(stockBatch.qty, 0), gte(stockBatch.expiry, today))).orderBy(asc(stockBatch.expiry), asc(stockBatch.createdAt));
  const order = batchId ? [...rows.filter((r) => r.id === batchId), ...rows.filter((r) => r.id !== batchId)] : rows;
  if (batchId && !rows.some((r) => r.id === batchId)) throw new HttpError(409, 'BATCH_NOT_SELLABLE');
  const out: { batch: typeof rows[number]; qty: number }[] = []; let left = qty;
  for (const b of order) { if (left <= 0) break; const n = Math.min(left, b.qty); out.push({ batch: b, qty: n }); left -= n; }
  if (left > 0) throw new HttpError(409, 'NOT_ENOUGH_STOCK', { medicineId, onHand: qty - left });
  return out;
}

/** WhatsApp to a vendor. Sent by the outbox when WhatsApp is connected, otherwise kept there as logged. */
async function tellVendor(tx: Tx, t: string, v: { phone: string | null } | undefined, kind: string, body: string) {
  if (!v?.phone) return;
  await tx.insert(message).values({ tenantId: t, kind, channel: 'whatsapp', toPhone: v.phone, body, params: {}, status: 'pending' });
}

const OrderLine = z.object({ medicineId: z.string().uuid(), qty: z.number().int().min(1).max(100000), scheme: z.string().trim().max(40).optional().nullable(), freeQty: z.number().int().min(0).max(100000).optional(), ratePaise: z.number().int().min(1).max(100000000), discBp: z.number().int().min(0).max(9900).default(0) });
const OrderIn = z.object({ vendorId: z.string().uuid(), dueDate: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/).optional().nullable(), vendorRef: z.string().trim().max(60).optional().nullable(), lines: z.array(OrderLine).min(1).max(100), send: z.boolean().default(true) });
const ReceiptLine = z.object({ medicineId: z.string().uuid(), qty: z.number().int().min(0).max(100000), freeQty: z.number().int().min(0).max(100000).default(0), ratePaise: z.number().int().min(0).max(100000000), discBp: z.number().int().min(0).max(9900).default(0),
  batchNo: z.string().trim().min(1).max(30), expiry: Expiry, mrpPaise: z.number().int().min(0).max(100000000).optional() });
const Photo = z.object({ mime: z.enum(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']), dataBase64: z.string().min(8) });
const ReceiptIn = z.object({ orderId: z.string().uuid().optional(), vendorId: z.string().uuid().optional(), billNo: z.string().trim().max(40).optional(), billDate: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/).optional(),
  billTotalPaise: z.number().int().min(0).max(1000000000).optional(), billPhoto: Photo.optional(), lines: z.array(ReceiptLine).min(1).max(100), keepOpen: z.boolean().default(false), at: z.string().optional() });
const VendorIn = z.object({ name: z.string().trim().min(2).max(100), phone: z.string().regex(/^[0-9]{10}$/).optional().nullable(), gstin: z.string().trim().max(15).optional().nullable(), address: z.string().trim().max(200).optional().nullable(), note: z.string().trim().max(200).optional().nullable(), active: z.boolean().optional() });

/**
 * Records a delivery: what the bill and the box say, checked against the order's promise (rate, scheme, discount).
 * Stock goes on the shelf at once; differences wait for the owner. Opening stock is a receipt with no vendor.
 */
export async function receiveStock(tx: Tx, a: Actor, body: z.infer<typeof ReceiptIn>, today: string) {
  const t = a.tenantId;
  const order = body.orderId ? (await tx.select().from(stockDoc).where(and(eq(stockDoc.id, body.orderId), eq(stockDoc.tenantId, t), eq(stockDoc.kind, 'order'))))[0] : undefined;
  if (body.orderId && !order) throw new HttpError(404, 'ORDER_NOT_FOUND');
  if (order && !['open', 'part'].includes(order.status)) throw new HttpError(409, 'ORDER_CLOSED');
  const vendorId = order?.vendorId ?? body.vendorId ?? null;
  const v = vendorId ? (await tx.select().from(vendor).where(and(eq(vendor.id, vendorId), eq(vendor.tenantId, t))))[0] : undefined;
  if (vendorId && !v) throw new HttpError(404, 'VENDOR_NOT_FOUND');
  if (v) {
    if (!body.billNo) throw new HttpError(400, 'BILL_NO_REQUIRED');
    if (!body.billPhoto) throw new HttpError(400, 'BILL_PHOTO_REQUIRED');
    if (body.billTotalPaise === undefined) throw new HttpError(400, 'BILL_TOTAL_REQUIRED');
    const dupBill = await tx.select({ id: stockDoc.id }).from(stockDoc).where(and(eq(stockDoc.tenantId, t), eq(stockDoc.kind, 'receipt'), eq(stockDoc.vendorId, v.id), eq(stockDoc.billNo, body.billNo))).limit(1);
    if (dupBill.length) throw new HttpError(409, 'BILL_ALREADY_RECEIVED');
  }
  const meds = await tx.select().from(medicine).where(and(eq(medicine.tenantId, t), inArray(medicine.id, body.lines.map((l) => l.medicineId))));
  const prior = order ? await tx.select().from(stockDoc).where(and(eq(stockDoc.tenantId, t), eq(stockDoc.kind, 'receipt'), eq(stockDoc.orderId, order.id))) : [];
  const owed = v ? await tx.select().from(vendorOwed).where(and(eq(vendorOwed.tenantId, t), eq(vendorOwed.vendorId, v.id), eq(vendorOwed.status, 'owed'))) : [];

  let computed = 0;
  const lines = body.lines.map((l) => {
    const m = meds.find((x) => x.id === l.medicineId); if (!m) throw new HttpError(400, 'UNKNOWN_MEDICINE');
    if (l.qty + l.freeQty <= 0) throw new HttpError(400, 'NOTHING_RECEIVED', { name: m.name });
    const exp = expiryDate(l.expiry); if (exp < today) throw new HttpError(400, 'EXPIRED_BATCH', { name: m.name, batchNo: l.batchNo });
    const ol = order?.lines.find((x: any) => x.medicineId === l.medicineId);
    const amount = taxable(l.qty, l.ratePaise, l.discBp); const gross = withGst(amount, m.gstBp); computed += gross;
    const out: any = { medicineId: m.id, name: m.name, qty: l.qty, freeQty: l.freeQty, ratePaise: l.ratePaise, discBp: l.discBp, gstBp: m.gstBp, batchNo: l.batchNo, expiry: exp, mrpPaise: l.mrpPaise ?? m.mrpPaise,
      amountPaise: gross, costPaise: Math.round(amount / (l.qty + l.freeQty)), extraPaise: 0, freeShort: 0, freeExpected: 0 };
    if (ol) {
      const gotBefore = prior.reduce((n, r) => n + (r.lines.find((x: any) => x.medicineId === m.id)?.qty ?? 0), 0);
      const freeBefore = prior.reduce((n, r) => n + (r.lines.find((x: any) => x.medicineId === m.id)?.freeQty ?? 0), 0);
      const expectedFree = Math.max(0, Math.min(ol.freeQty, Math.floor((ol.freeQty * Math.min(ol.qty, gotBefore + l.qty)) / ol.qty)) - freeBefore);
      const promised = withGst(taxable(l.qty, ol.ratePaise, ol.discBp), m.gstBp);
      Object.assign(out, { promisedQty: ol.qty, promisedFree: ol.freeQty, promisedRatePaise: ol.ratePaise, promisedDiscBp: ol.discBp, freeExpected: expectedFree,
        extraPaise: Math.max(0, gross - promised), freeShort: Math.max(0, expectedFree - l.freeQty) });
    }
    return out;
  });
  if (v && Math.abs(computed - (body.billTotalPaise ?? 0)) > 500) throw new HttpError(400, 'BILL_TOTAL_MISMATCH', { computedPaise: computed });

  const review = lines.some((l) => l.extraPaise > 0 || l.freeShort > 0);
  const n = await nextNumber(tx, t, 'stock_grn', 'tenant');
  const when = body.at ?? new Date().toISOString();
  const [doc] = await tx.insert(stockDoc).values({ tenantId: t, kind: 'receipt', docNo: `GRN-${String(n).padStart(4, '0')}`, vendorId, orderId: order?.id ?? null, status: review ? 'review' : 'ok',
    billNo: body.billNo ?? null, billDate: body.billDate ?? null, billTotalPaise: body.billTotalPaise ?? null, note: v ? null : 'Opening stock', lines, createdBy: a.userId, createdByName: a.name, createdAt: when }).returning();
  if (body.billPhoto) {
    const bytes = Buffer.from(body.billPhoto.dataBase64.replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (bytes.length > 10 * 1024 * 1024) throw new HttpError(413, 'TOO_LARGE');
    const key = `${t}/stock/${doc.id}.${body.billPhoto.mime === 'application/pdf' ? 'pdf' : body.billPhoto.mime.split('/')[1]}`;
    await putFile(key, bytes, body.billPhoto.mime);
    await tx.update(stockDoc).set({ billPhotoKey: key }).where(eq(stockDoc.id, doc.id));
  }
  const label = v ? body.billNo! : doc.docNo;
  for (const l of lines) {
    const ex = (await tx.select().from(stockBatch).where(and(eq(stockBatch.tenantId, t), eq(stockBatch.medicineId, l.medicineId), eq(stockBatch.batchNo, l.batchNo))))[0];
    const batch = ex ?? (await tx.insert(stockBatch).values({ tenantId: t, medicineId: l.medicineId, batchNo: l.batchNo, expiry: l.expiry, qty: 0, costPaise: l.costPaise, mrpPaise: l.mrpPaise, vendorId, receiptId: doc.id, receiptNo: label, createdAt: when }).returning())[0];
    if (ex && ex.expiry !== l.expiry) throw new HttpError(409, 'BATCH_EXPIRY_DIFFERS', { batchNo: l.batchNo, expiry: ex.expiry });
    const units = l.qty + l.freeQty; const cost = ex ? Math.round((ex.costPaise * ex.qty + l.costPaise * units) / Math.max(1, ex.qty + units)) : l.costPaise;
    await tx.update(stockBatch).set({ paidQty: batch.paidQty + l.qty, freeQty: batch.freeQty + l.freeQty, costPaise: cost, mrpPaise: l.mrpPaise || batch.mrpPaise }).where(eq(stockBatch.id, batch.id));
    l.batchId = batch.id;
    await moveStock(tx, a, batch.id, units, 'receive', { id: doc.id, no: label, at: body.at, note: l.freeQty ? `${l.qty} paid + ${l.freeQty} free` : `${l.qty} paid` });
    // free units above this delivery's scheme settle what the vendor still owed for this medicine
    let extraFree = l.freeQty - l.freeExpected;
    for (const o of owed.filter((x) => x.medicineId === l.medicineId)) {
      if (extraFree < o.qty) break;
      extraFree -= o.qty; await tx.update(vendorOwed).set({ status: 'received', settledNote: `Received in ${label}` }).where(eq(vendorOwed.id, o.id)); l.owedSettled = (l.owedSettled ?? 0) + o.qty;
    }
  }
  await tx.update(stockDoc).set({ lines }).where(eq(stockDoc.id, doc.id));
  if (order) {
    const all = [...prior, { lines }];
    const done = order.lines.every((ol: any) => all.reduce((n, r: any) => n + (r.lines.find((x: any) => x.medicineId === ol.medicineId)?.qty ?? 0), 0) >= ol.qty);
    await tx.update(stockDoc).set({ status: done || !body.keepOpen ? 'closed' : 'part' }).where(eq(stockDoc.id, order.id));
  }
  if (v) await tellVendor(tx, t, v, 'vendor_receipt', [`Received against ${order?.docNo ?? 'no order'} (bill ${body.billNo}):`, ...lines.map((l) => `${l.name} · ${l.qty}${l.freeQty ? ` + ${l.freeQty} free` : ''} · ₹${(l.ratePaise / 100).toFixed(2)}`), 'Reply if this does not match what you sent.'].join('\n'));
  return { ...doc, lines, status: review ? 'review' : 'ok' };
}

export function stockRoutes(app: FastifyInstance) {
  const today = (req: any) => todayIn(req.ctx.timezone);

  /** The Stock tab: what needs attention, deliveries waiting for a decision, and every medicine with its stock. */
  route(app, 'get', '/stock', 'stock.read', async (req, tx) => {
    const t = req.ctx.tenantId; const d = today(req); const soon = addDays(d, 90);
    const meds = await tx.select().from(medicine).where(eq(medicine.tenantId, t)).orderBy(asc(medicine.name));
    const batches = await tx.select().from(stockBatch).where(and(eq(stockBatch.tenantId, t), gt(stockBatch.qty, 0)));
    const recent = await tx.select({ lines: stockDoc.lines }).from(stockDoc).where(and(eq(stockDoc.tenantId, t), eq(stockDoc.kind, 'receipt'), gte(stockDoc.createdAt, addDays(d, -90))));
    const free90 = (id: string) => recent.reduce((n, r) => n + r.lines.filter((l: any) => l.medicineId === id).reduce((k: number, l: any) => k + l.freeQty, 0), 0);
    const items = meds.map((m) => {
      const bs = batches.filter((b) => b.medicineId === m.id); const sellable = bs.filter((b) => b.expiry >= d);
      const onHand = sellable.reduce((n, b) => n + b.qty, 0); const nearest = sellable.map((b) => b.expiry).sort()[0] ?? null;
      const status = onHand === 0 ? 'out' : nearest && nearest <= soon ? 'expiring' : onHand < m.reorderLevel ? 'low' : 'ok';
      return { id: m.id, name: m.name, form: m.form, packSize: m.packSize, mrpPaise: m.mrpPaise, reorderLevel: m.reorderLevel, onHand, expired: bs.filter((b) => b.expiry < d).reduce((n, b) => n + b.qty, 0),
        batches: sellable.length, nearestExpiry: nearest, costValuePaise: sellable.reduce((n, b) => n + b.qty * b.costPaise, 0), free90: free90(m.id), status };
    });
    const reviews = await tx.select({ d: stockDoc, vendor: vendor.name }).from(stockDoc).leftJoin(vendor, eq(vendor.id, stockDoc.vendorId)).where(and(eq(stockDoc.tenantId, t), eq(stockDoc.kind, 'receipt'), eq(stockDoc.status, 'review'))).orderBy(desc(stockDoc.createdAt));
    const expiring = batches.filter((b) => b.expiry >= d && b.expiry <= soon);
    const count = (await tx.select().from(stockDoc).where(and(eq(stockDoc.tenantId, t), eq(stockDoc.kind, 'count'))).orderBy(desc(stockDoc.createdAt)).limit(1))[0];
    const gaps = count ? count.lines.filter((l: any) => l.state === 'gap') : [];
    return {
      items,
      reviews: reviews.map((r) => ({ id: r.d.id, docNo: r.d.docNo, billNo: r.d.billNo, vendor: r.vendor, at: r.d.createdAt, by: r.d.createdByName, lines: r.d.lines.filter((l: any) => l.extraPaise > 0 || l.freeShort > 0),
        extraPaise: r.d.lines.reduce((n: number, l: any) => n + l.extraPaise, 0), freeShort: r.d.lines.reduce((n: number, l: any) => n + l.freeShort, 0) })),
      tiles: { low: items.filter((i) => i.status === 'low' || i.status === 'out').length, expiringBatches: expiring.length, expiringValuePaise: expiring.reduce((n, b) => n + b.qty * b.costPaise, 0),
        expired: items.reduce((n, i) => n + i.expired, 0), count: count ? { id: count.id, docNo: count.docNo, at: count.createdAt, status: count.status, gapLines: gaps.length, gapUnits: gaps.reduce((n: number, l: any) => n + Math.abs(l.counted - l.system), 0) } : null },
    };
  });

  /** One medicine: batches, cost, margin, and every movement. */
  route(app, 'get', '/stock/medicines/:id', 'stock.read', async (req, tx) => {
    const t = req.ctx.tenantId; const id = (req.params as any).id; const d = today(req);
    const [m] = await tx.select().from(medicine).where(and(eq(medicine.id, id), eq(medicine.tenantId, t)));
    if (!m) throw new HttpError(404, 'NOT_FOUND');
    const batches = await tx.select({ b: stockBatch, vendor: vendor.name }).from(stockBatch).leftJoin(vendor, eq(vendor.id, stockBatch.vendorId)).where(and(eq(stockBatch.tenantId, t), eq(stockBatch.medicineId, id))).orderBy(asc(stockBatch.expiry));
    const moves = await tx.select({ mv: stockMove, batchNo: stockBatch.batchNo }).from(stockMove).innerJoin(stockBatch, eq(stockBatch.id, stockMove.batchId)).where(and(eq(stockMove.tenantId, t), eq(stockMove.medicineId, id))).orderBy(desc(stockMove.createdAt)).limit(200);
    const [{ sold }] = await tx.select({ sold: sql<number>`coalesce(-sum(${stockMove.change}), 0)::int` }).from(stockMove).where(and(eq(stockMove.tenantId, t), eq(stockMove.medicineId, id), inArray(stockMove.kind, ['sale', 'patient_return']), gte(stockMove.createdAt, addDays(d, -30))));
    const live = batches.filter((x) => x.b.qty > 0);
    const onHand = live.filter((x) => x.b.expiry >= d).reduce((n, x) => n + x.b.qty, 0); const units = live.reduce((n, x) => n + x.b.qty, 0);
    const avgCost = units ? Math.round(live.reduce((n, x) => n + x.b.qty * x.b.costPaise, 0) / units) : batches.at(-1)?.b.costPaise ?? 0;
    const firstSellable = live.find((x) => x.b.expiry >= d)?.b.id;
    return { medicine: m, onHand, avgCostPaise: avgCost, sold30: Number(sold),
      batches: batches.map((x) => ({ ...x.b, vendor: x.vendor, expired: x.b.expiry < d, sellingNow: x.b.id === firstSellable })),
      moves: moves.map((x) => ({ ...x.mv, batchNo: x.batchNo })) };
  });

  /** Owner correction of one batch with a reason (damaged, expired, found). */
  route(app, 'post', '/stock/batches/:id/adjust', 'stock.approve', async (req, tx) => {
    const b = z.object({ change: z.number().int().min(-100000).max(100000).refine((x) => x !== 0, 'not zero'), reason: z.string().trim().min(3).max(200) }).parse(req.body);
    const batch = await moveStock(tx, actor(req), (req.params as any).id, b.change, 'adjust', { note: b.reason });
    await emit(tx, req.ctx, 'stock.adjusted', 'stock_batch', batch.id, { change: b.change, reason: b.reason });
    return { ok: true };
  });

  // --- vendors ---
  route(app, 'get', '/vendors', 'stock.read', async (req, tx) => {
    const t = req.ctx.tenantId;
    const vs = await tx.select().from(vendor).where(eq(vendor.tenantId, t)).orderBy(asc(vendor.name));
    const owed = await tx.select({ vendorId: vendorOwed.vendorId, n: sql<number>`sum(${vendorOwed.qty})::int` }).from(vendorOwed).where(and(eq(vendorOwed.tenantId, t), eq(vendorOwed.status, 'owed'))).groupBy(vendorOwed.vendorId);
    const docs = await tx.select({ vendorId: stockDoc.vendorId, n: sql<number>`count(*)::int` }).from(stockDoc).where(and(eq(stockDoc.tenantId, t), eq(stockDoc.kind, 'order'), gte(stockDoc.createdAt, addDays(today(req), -30)))).groupBy(stockDoc.vendorId);
    return vs.map((v) => ({ ...v, owed: owed.find((o) => o.vendorId === v.id)?.n ?? 0, orders30: docs.find((o) => o.vendorId === v.id)?.n ?? 0 }));
  });
  route(app, 'post', '/vendors', 'stock.write', async (req, tx) => {
    const b = VendorIn.parse(req.body);
    const dup = await tx.select({ id: vendor.id }).from(vendor).where(and(eq(vendor.tenantId, req.ctx.tenantId), sql`lower(${vendor.name}) = ${b.name.toLowerCase()}`)).limit(1);
    if (dup.length) throw new HttpError(409, 'DUPLICATE', { what: 'vendor' });
    return (await tx.insert(vendor).values({ ...b, tenantId: req.ctx.tenantId }).returning())[0];
  });
  route(app, 'patch', '/vendors/:id', 'stock.write', async (req, tx) => {
    const b = VendorIn.partial().parse(req.body); const raw = req.body as Record<string, unknown>;
    const set = Object.fromEntries(Object.entries(b).filter(([k]) => k in raw));
    const [r] = await tx.update(vendor).set(set).where(and(eq(vendor.id, (req.params as any).id), eq(vendor.tenantId, req.ctx.tenantId))).returning();
    if (!r) throw new HttpError(404, 'NOT_FOUND'); return r;
  });

  /** A vendor's account: free goods owed, money paid above the promise, every delivery and return. */
  route(app, 'get', '/vendors/:id', 'stock.read', async (req, tx) => {
    const t = req.ctx.tenantId; const id = (req.params as any).id;
    const [v] = await tx.select().from(vendor).where(and(eq(vendor.id, id), eq(vendor.tenantId, t)));
    if (!v) throw new HttpError(404, 'NOT_FOUND');
    const owed = await tx.select().from(vendorOwed).where(and(eq(vendorOwed.tenantId, t), eq(vendorOwed.vendorId, id))).orderBy(desc(vendorOwed.createdAt)).limit(50);
    const docs = await tx.select().from(stockDoc).where(and(eq(stockDoc.tenantId, t), eq(stockDoc.vendorId, id))).orderBy(desc(stockDoc.createdAt)).limit(100);
    const since = addDays(today(req), -182);
    const recent = docs.filter((x) => x.kind === 'receipt' && x.createdAt >= since);
    const promisedFree = recent.reduce((n, r) => n + r.lines.reduce((k: number, l: any) => k + (l.freeExpected ?? 0), 0), 0);
    const gotFree = recent.reduce((n, r) => n + r.lines.reduce((k: number, l: any) => k + Math.min(l.freeQty, l.freeExpected ?? 0), 0), 0);
    const open = owed.filter((o) => o.status === 'owed');
    return { vendor: v, owed, docs: docs.map(({ lines, ...d }) => ({ ...d, lines })),
      tiles: { owedUnits: open.reduce((n, o) => n + o.qty, 0), owedLines: open.length,
        extraPaise: recent.reduce((n, r) => n + r.lines.reduce((k: number, l: any) => k + l.extraPaise, 0), 0), extraDeliveries: recent.filter((r) => r.lines.some((l: any) => l.extraPaise > 0)).length, deliveries: recent.length,
        promisedFree, gotFree, billedPaise: recent.reduce((n, r) => n + (r.billTotalPaise ?? 0), 0) } };
  });
  route(app, 'post', '/vendors/:id/owed/:owedId/write-off', 'stock.approve', async (req, tx) => {
    const p = req.params as any; const reason = z.object({ reason: z.string().trim().min(3).max(200) }).parse(req.body).reason;
    const [r] = await tx.update(vendorOwed).set({ status: 'written_off', settledNote: `${reason} · ${req.ctx.name}` }).where(and(eq(vendorOwed.id, p.owedId), eq(vendorOwed.vendorId, p.id), eq(vendorOwed.tenantId, req.ctx.tenantId), eq(vendorOwed.status, 'owed'))).returning();
    if (!r) throw new HttpError(404, 'NOT_FOUND'); return r;
  });

  // --- purchase orders ---
  /** A new order for a vendor, pre-filled with low-stock medicines and the last rate and scheme agreed. */
  route(app, 'get', '/stock/order-draft', 'stock.write', async (req, tx) => {
    const t = req.ctx.tenantId; const vendorId = String((req.query as any).vendorId ?? ''); const d = today(req);
    const meds = await tx.select().from(medicine).where(eq(medicine.tenantId, t));
    const stock = await tx.select({ medicineId: stockBatch.medicineId, n: sql<number>`sum(${stockBatch.qty})::int` }).from(stockBatch).where(and(eq(stockBatch.tenantId, t), gte(stockBatch.expiry, d))).groupBy(stockBatch.medicineId);
    const orders = await tx.select().from(stockDoc).where(and(eq(stockDoc.tenantId, t), eq(stockDoc.kind, 'order'), ne(stockDoc.status, 'cancelled'))).orderBy(desc(stockDoc.createdAt)).limit(200);
    const receipts = await tx.select().from(stockDoc).where(and(eq(stockDoc.tenantId, t), eq(stockDoc.kind, 'receipt'))).orderBy(desc(stockDoc.createdAt)).limit(200);
    const owed = vendorId ? await tx.select().from(vendorOwed).where(and(eq(vendorOwed.tenantId, t), eq(vendorOwed.vendorId, vendorId), eq(vendorOwed.status, 'owed'))) : [];
    const last = (id: string) => (orders.find((o) => o.vendorId === vendorId && o.lines.some((l: any) => l.medicineId === id)) ?? orders.find((o) => o.lines.some((l: any) => l.medicineId === id)))?.lines.find((l: any) => l.medicineId === id);
    const lastPaid = (id: string) => receipts.find((r) => r.lines.some((l: any) => l.medicineId === id && l.qty > 0))?.lines.find((l: any) => l.medicineId === id)?.ratePaise ?? null;
    const info = meds.map((m) => { const on = stock.find((s) => s.medicineId === m.id)?.n ?? 0; const l = last(m.id);
      return { medicineId: m.id, name: m.name, form: m.form, packSize: m.packSize, gstBp: m.gstBp, onHand: on, reorderLevel: m.reorderLevel, low: on < m.reorderLevel,
        qty: Math.max(m.reorderLevel * 3 - on, m.reorderLevel, 1), scheme: l?.scheme ?? '', ratePaise: l?.ratePaise ?? lastPaid(m.id), discBp: l?.discBp ?? 0, lastPaidPaise: lastPaid(m.id) }; });
    return { lines: info.filter((i) => i.low), all: info, owed };
  });
  route(app, 'post', '/stock/orders', 'stock.write', async (req, tx) => {
    const b = OrderIn.parse(req.body); const t = req.ctx.tenantId;
    const [v] = await tx.select().from(vendor).where(and(eq(vendor.id, b.vendorId), eq(vendor.tenantId, t)));
    if (!v) throw new HttpError(404, 'VENDOR_NOT_FOUND');
    if (new Set(b.lines.map((l) => l.medicineId)).size !== b.lines.length) throw new HttpError(400, 'DUPLICATE_LINE');
    const meds = await tx.select().from(medicine).where(and(eq(medicine.tenantId, t), inArray(medicine.id, b.lines.map((l) => l.medicineId))));
    const lines = b.lines.map((l) => { const m = meds.find((x) => x.id === l.medicineId); if (!m) throw new HttpError(400, 'UNKNOWN_MEDICINE');
      const freeQty = l.scheme ? schemeFree(l.scheme, l.qty) : l.freeQty ?? 0; const amount = taxable(l.qty, l.ratePaise, l.discBp);
      return { medicineId: m.id, name: m.name, qty: l.qty, scheme: l.scheme || null, freeQty, ratePaise: l.ratePaise, discBp: l.discBp, gstBp: m.gstBp, amountPaise: withGst(amount, m.gstBp), costPaise: Math.round(amount / (l.qty + freeQty)) }; });
    const n = await nextNumber(tx, t, 'stock_po', 'tenant');
    const [doc] = await tx.insert(stockDoc).values({ tenantId: t, kind: 'order', docNo: `PO-${String(n).padStart(4, '0')}`, vendorId: v.id, status: 'open', dueDate: b.dueDate ?? null, vendorRef: b.vendorRef ?? null, lines, createdBy: req.ctx.userId, createdByName: req.ctx.name }).returning();
    if (b.send) await tellVendor(tx, t, v, 'vendor_order', [`${doc.docNo}${b.dueDate ? ` · deliver by ${b.dueDate}` : ''}`, ...lines.map((l) => `${l.name} · ${l.qty}${l.freeQty ? ` + ${l.freeQty} free` : ''} · ₹${(l.ratePaise / 100).toFixed(2)}${l.discBp ? ` less ${l.discBp / 100}%` : ''}`), 'Please reply OK to confirm.'].join('\n'));
    await emit(tx, req.ctx, 'stock.ordered', 'stock_doc', doc.id, { docNo: doc.docNo, vendorId: v.id });
    return doc;
  });
  route(app, 'post', '/stock/orders/:id/cancel', 'stock.write', async (req, tx) => {
    const [r] = await tx.update(stockDoc).set({ status: 'cancelled' }).where(and(eq(stockDoc.id, (req.params as any).id), eq(stockDoc.tenantId, req.ctx.tenantId), eq(stockDoc.kind, 'order'), eq(stockDoc.status, 'open'))).returning();
    if (!r) throw new HttpError(409, 'CANNOT_CANCEL'); return r;
  });
  /** Orders, receipts and returns, newest first. */
  route(app, 'get', '/stock/docs', 'stock.read', async (req, tx) => {
    const q = z.object({ kind: z.enum(['order', 'receipt', 'return', 'count']).optional(), status: z.string().max(20).optional() }).parse(req.query);
    const rows = await tx.select({ d: stockDoc, vendor: vendor.name }).from(stockDoc).leftJoin(vendor, eq(vendor.id, stockDoc.vendorId))
      .where(and(eq(stockDoc.tenantId, req.ctx.tenantId), q.kind ? eq(stockDoc.kind, q.kind) : undefined, q.status ? eq(stockDoc.status, q.status) : undefined)).orderBy(desc(stockDoc.createdAt)).limit(200);
    return rows.map((r) => ({ ...r.d, vendor: r.vendor }));
  });
  route(app, 'get', '/stock/docs/:id', 'stock.read', async (req, tx) => {
    const [r] = await tx.select({ d: stockDoc, vendor: vendor }).from(stockDoc).leftJoin(vendor, eq(vendor.id, stockDoc.vendorId)).where(and(eq(stockDoc.id, (req.params as any).id), eq(stockDoc.tenantId, req.ctx.tenantId)));
    if (!r) throw new HttpError(404, 'NOT_FOUND');
    if (r.d.kind === 'count' && r.d.status === 'open') r.d.lines = r.d.lines.map(({ system, ...l }: any) => l); // counted blind
    return { ...r.d, vendor: r.vendor };
  });
  app.get('/stock/docs/:id/photo', async (req, reply) => {
    const { withTenant } = await import('../db/index.js');
    if (!can(req.perms, 'stock.read')) throw new HttpError(404, 'NOT_FOUND');
    const d = await withTenant(req.ctx.tenantId, req.ctx.userId, (tx) => tx.select().from(stockDoc).where(and(eq(stockDoc.id, (req.params as any).id), eq(stockDoc.tenantId, req.ctx.tenantId))).then((r) => r[0]));
    const file = d?.billPhotoKey ? await getFile(d.billPhotoKey) : null;
    if (!file) throw new HttpError(404, 'NOT_FOUND');
    const ext = d!.billPhotoKey!.split('.').pop()!;
    return reply.type(ext === 'pdf' ? 'application/pdf' : `image/${ext}`).header('cache-control', 'private, max-age=3600').send(file);
  });

  // --- receiving ---
  route(app, 'post', '/stock/receipts', 'stock.write', async (req, tx) => {
    const doc = await receiveStock(tx, actor(req), ReceiptIn.parse(req.body), today(req));
    await emit(tx, req.ctx, 'stock.received', 'stock_doc', doc.id, { docNo: doc.docNo, status: doc.status });
    return doc;
  });
  /** The owner's decision on a delivery that differs from its order. */
  route(app, 'post', '/stock/receipts/:id/decide', 'stock.approve', async (req, tx) => {
    const b = z.object({ choice: z.enum(['owe', 'debit', 'accept']), reason: z.string().trim().max(200).optional() }).parse(req.body);
    if (b.choice === 'accept' && (b.reason ?? '').length < 3) throw new HttpError(400, 'REASON_REQUIRED');
    const t = req.ctx.tenantId;
    const [d] = await tx.select().from(stockDoc).where(and(eq(stockDoc.id, (req.params as any).id), eq(stockDoc.tenantId, t), eq(stockDoc.kind, 'receipt'))).for('update');
    if (!d) throw new HttpError(404, 'NOT_FOUND');
    if (d.status !== 'review') throw new HttpError(409, 'ALREADY_DECIDED');
    if (b.choice !== 'accept') for (const l of d.lines.filter((x: any) => x.freeShort > 0))
      await tx.insert(vendorOwed).values({ tenantId: t, vendorId: d.vendorId!, medicineId: l.medicineId, name: l.name, qty: l.freeShort, fromDocId: d.id, fromDocNo: d.billNo ?? d.docNo, decidedBy: req.ctx.name });
    const debit = b.choice === 'debit' ? d.lines.reduce((n: number, l: any) => n + l.extraPaise, 0) : undefined;
    const decision = { choice: b.choice, reason: b.reason ?? null, by: req.ctx.name, at: new Date().toISOString(), ...(debit !== undefined ? { debitPaise: debit } : {}) };
    await tx.update(stockDoc).set({ status: 'settled', decision }).where(eq(stockDoc.id, d.id));
    await emit(tx, req.ctx, 'stock.decided', 'stock_doc', d.id, decision);
    return { ...d, status: 'settled', decision };
  });

  /** Stock going back to the vendor, by batch. */
  route(app, 'post', '/stock/returns', 'stock.write', async (req, tx) => {
    const b = z.object({ vendorId: z.string().uuid(), reason: z.string().trim().min(3).max(200), lines: z.array(z.object({ batchId: z.string().uuid(), qty: z.number().int().min(1).max(100000) })).min(1).max(50) }).parse(req.body);
    const t = req.ctx.tenantId;
    const [v] = await tx.select().from(vendor).where(and(eq(vendor.id, b.vendorId), eq(vendor.tenantId, t)));
    if (!v) throw new HttpError(404, 'VENDOR_NOT_FOUND');
    const n = await nextNumber(tx, t, 'stock_rt', 'tenant'); const docNo = `RT-${String(n).padStart(4, '0')}`;
    const [doc] = await tx.insert(stockDoc).values({ tenantId: t, kind: 'return', docNo, vendorId: v.id, status: 'done', note: b.reason, lines: [], createdBy: req.ctx.userId, createdByName: req.ctx.name }).returning();
    const lines = [];
    for (const l of b.lines) {
      const batch = await moveStock(tx, actor(req), l.batchId, -l.qty, 'vendor_return', { id: doc.id, no: docNo, note: b.reason });
      const [m] = await tx.select({ name: medicine.name }).from(medicine).where(eq(medicine.id, batch.medicineId));
      lines.push({ batchId: batch.id, medicineId: batch.medicineId, name: m.name, batchNo: batch.batchNo, expiry: batch.expiry, qty: l.qty, creditPaise: l.qty * batch.costPaise });
    }
    await tx.update(stockDoc).set({ lines }).where(eq(stockDoc.id, doc.id));
    await tellVendor(tx, t, v, 'vendor_return', [`Return ${docNo}:`, ...lines.map((l) => `${l.name} · batch ${l.batchNo} · ${l.qty}`), `Reason: ${b.reason}`].join('\n'));
    return { ...doc, lines };
  });

  // --- stock count: counted blind, gaps need the owner ---
  route(app, 'post', '/stock/counts', 'stock.write', async (req, tx) => {
    const t = req.ctx.tenantId;
    const open = await tx.select({ id: stockDoc.id }).from(stockDoc).where(and(eq(stockDoc.tenantId, t), eq(stockDoc.kind, 'count'), inArray(stockDoc.status, ['open', 'review']))).limit(1);
    if (open.length) throw new HttpError(409, 'COUNT_OPEN', { id: open[0].id });
    const bs = await tx.select({ b: stockBatch, name: medicine.name }).from(stockBatch).innerJoin(medicine, eq(medicine.id, stockBatch.medicineId)).where(and(eq(stockBatch.tenantId, t), gt(stockBatch.qty, 0))).orderBy(asc(medicine.name), asc(stockBatch.expiry));
    const n = await nextNumber(tx, t, 'stock_cnt', 'tenant');
    return (await tx.insert(stockDoc).values({ tenantId: t, kind: 'count', docNo: `CNT-${String(n).padStart(4, '0')}`, status: 'open',
      lines: bs.map((x) => ({ batchId: x.b.id, medicineId: x.b.medicineId, name: x.name, batchNo: x.b.batchNo, expiry: x.b.expiry, counted: null, state: 'todo' })), createdBy: req.ctx.userId, createdByName: req.ctx.name }).returning())[0];
  });
  /** Save counted figures (blind). Submitting compares them with the system and lists the gaps. */
  route(app, 'post', '/stock/counts/:id/submit', 'stock.write', async (req, tx) => {
    const b = z.object({ lines: z.array(z.object({ batchId: z.string().uuid(), counted: z.number().int().min(0).max(100000) })).max(5000), final: z.boolean().default(true) }).parse(req.body);
    const t = req.ctx.tenantId;
    const [d] = await tx.select().from(stockDoc).where(and(eq(stockDoc.id, (req.params as any).id), eq(stockDoc.tenantId, t), eq(stockDoc.kind, 'count'))).for('update');
    if (!d) throw new HttpError(404, 'NOT_FOUND');
    if (d.status !== 'open') throw new HttpError(409, 'COUNT_NOT_OPEN');
    const lines = d.lines.map((l: any) => { const c = b.lines.find((x) => x.batchId === l.batchId); return c && ['todo', 'recount'].includes(l.state) ? { ...l, counted: c.counted } : l; });
    if (!b.final) { await tx.update(stockDoc).set({ lines }).where(eq(stockDoc.id, d.id)); return { ok: true }; }
    if (lines.some((l: any) => l.counted === null || l.counted === undefined)) throw new HttpError(400, 'COUNT_INCOMPLETE', { left: lines.filter((l: any) => l.counted == null).length });
    const batches = await tx.select().from(stockBatch).where(and(eq(stockBatch.tenantId, t), inArray(stockBatch.id, lines.map((l: any) => l.batchId))));
    for (const l of lines) if (['todo', 'recount'].includes(l.state)) { l.system = batches.find((x) => x.id === l.batchId)!.qty; l.state = l.system === l.counted ? 'match' : 'gap'; l.countedBy = req.ctx.name; }
    const status = lines.some((l: any) => l.state === 'gap') ? 'review' : 'closed';
    await tx.update(stockDoc).set({ lines, status }).where(eq(stockDoc.id, d.id));
    return { ...d, lines, status };
  });
  /** Where a batch's units went: received, sold (and by whom), returned, written off. */
  route(app, 'get', '/stock/batches/:id/trace', 'stock.read', async (req, tx) => {
    const t = req.ctx.tenantId; const id = (req.params as any).id;
    const moves = await tx.select().from(stockMove).where(and(eq(stockMove.tenantId, t), eq(stockMove.batchId, id)));
    const sum = (k: string[]) => moves.filter((m) => k.includes(m.kind)).reduce((n, m) => n + m.change, 0);
    const sellers = new Map<string, number>(); for (const m of moves.filter((x) => x.kind === 'sale')) sellers.set(m.byName, (sellers.get(m.byName) ?? 0) + 1);
    const [b] = await tx.select().from(stockBatch).where(and(eq(stockBatch.id, id), eq(stockBatch.tenantId, t)));
    if (!b) throw new HttpError(404, 'NOT_FOUND');
    return { batch: b, received: sum(['receive']), sold: -sum(['sale', 'patient_return']), bills: moves.filter((m) => m.kind === 'sale').length, returned: -sum(['vendor_return']), adjusted: sum(['adjust', 'count']), onHand: b.qty,
      sellers: [...sellers].map(([name, bills]) => ({ name, bills })).sort((a, z) => z.bills - a.bills) };
  });
  /** Owner: approve a gap (stock is corrected with the reason) or send the batch back for a recount. */
  route(app, 'post', '/stock/counts/:id/resolve', 'stock.approve', async (req, tx) => {
    const b = z.object({ batchId: z.string().uuid(), action: z.enum(['approve', 'recount']), reason: z.string().trim().max(200).optional() }).parse(req.body);
    if (b.action === 'approve' && (b.reason ?? '').length < 3) throw new HttpError(400, 'REASON_REQUIRED');
    const t = req.ctx.tenantId;
    const [d] = await tx.select().from(stockDoc).where(and(eq(stockDoc.id, (req.params as any).id), eq(stockDoc.tenantId, t), eq(stockDoc.kind, 'count'))).for('update');
    if (!d) throw new HttpError(404, 'NOT_FOUND');
    const l = d.lines.find((x: any) => x.batchId === b.batchId);
    if (!l || l.state !== 'gap') throw new HttpError(409, 'NOT_A_GAP');
    if (b.action === 'approve') {
      await moveStock(tx, actor(req), l.batchId, l.counted - l.system, 'count', { id: d.id, no: d.docNo, note: b.reason });
      Object.assign(l, { state: 'approved', reason: b.reason, approvedBy: req.ctx.name });
    } else Object.assign(l, { state: 'recount', counted: null, system: undefined });
    const status = d.lines.some((x: any) => x.state === 'recount') ? 'open' : d.lines.some((x: any) => x.state === 'gap') ? 'review' : 'closed';
    await tx.update(stockDoc).set({ lines: d.lines, status }).where(eq(stockDoc.id, d.id));
    return { ok: true, status };
  });
}
