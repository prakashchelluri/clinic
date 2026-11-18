import { and, asc, desc, eq, gte, inArray, lt } from 'drizzle-orm';
import { encounter, medicine, patient, pharmacySale, practitioner, stockBatch, stockDoc, stockMove, vendor } from '../db/schema.js';
import type { Tx } from '../db/index.js';
import { addDays, todayIn } from '../lib/core.js';
import { dayBounds } from './billing.js';

/**
 * The pharmacy's downloads (HealthPlix's pharmacy Reports menu): bills, GST lines, returns, margins, purchases, moving stock, adjustments.
 * Built from the bills, the stock receipts and the stock moves; nothing here is typed in. The Schedule H/H1/X register stays on the Pharmacy page.
 * Margin = sale less GST, less the batch's cost (cost is kept without GST); a bill's discount is shared over its lines, as returns do.
 */
const rs = (p: number) => (p / 100).toFixed(2);
const pct = (num: number, den: number) => (den ? ((num / den) * 100).toFixed(1) : '');
const gstIn = (amount: number, bp: number) => (bp ? amount - Math.round((amount * 10000) / (10000 + bp)) : 0);
const MODES: Record<string, string> = { cash: 'Cash', upi: 'UPI', card: 'Card', split: 'Split' };
const mode = (m: string) => MODES[m] ?? m;

export type PharmacyKind = 'pharmacy' | 'pharmacy_margin' | 'purchase' | 'moving' | 'stockadj';

/** Every line of every bill made in the range, its share of the bill discount, what came back, GST and cost. */
async function saleLines(tx: Tx, t: string, tz: string, from: string, to: string) {
  const start = dayBounds(from, tz).start; const end = dayBounds(to, tz).end;
  const sales = await tx.select({ s: pharmacySale, name: patient.fullName, no: patient.patientNo, doctor: practitioner.name }).from(pharmacySale).innerJoin(patient, eq(patient.id, pharmacySale.patientId))
    .leftJoin(encounter, eq(encounter.id, pharmacySale.encounterId)).leftJoin(practitioner, eq(practitioner.id, encounter.practitionerId))
    .where(and(eq(pharmacySale.tenantId, t), gte(pharmacySale.createdAt, start), lt(pharmacySale.createdAt, end))).orderBy(asc(pharmacySale.createdAt));
  const batchIds = [...new Set(sales.flatMap((x) => x.s.items.map((l) => l.batchId).filter((b): b is string => !!b)))];
  const cost = new Map((batchIds.length ? await tx.select({ id: stockBatch.id, c: stockBatch.costPaise }).from(stockBatch).where(and(eq(stockBatch.tenantId, t), inArray(stockBatch.id, batchIds))) : []).map((b) => [b.id, b.c]));
  const lines = sales.flatMap(({ s, name, no, doctor }) => s.items.map((l, i) => {
    const net = s.grossPaise ? Math.round((l.amountPaise * s.totalPaise) / s.grossPaise) : l.amountPaise;
    const backQty = s.returns.reduce((n, r) => n + (r.lines.find((x) => x.line === i)?.qty ?? 0), 0);
    const backPaise = s.returns.reduce((n, r) => n + (r.lines.find((x) => x.line === i)?.amountPaise ?? 0), 0);
    const c = l.batchId ? cost.get(l.batchId) : undefined;
    const keptQty = l.qty - backQty; const kept = net - backPaise; const taxable = kept - gstIn(kept, l.gstBp);
    return { s, i, l, day: todayIn(tz, new Date(s.createdAt)), who: s.buyerName ?? name, no, doctor: s.encounterId && l.prescriptionItemId ? doctor ?? '' : '', net, disc: l.amountPaise - net, backQty, kept, keptQty, taxable,
      costPaise: c === undefined ? null : c * keptQty, profit: c === undefined ? null : taxable - c * keptQty };
  }));
  return { sales, lines };
}

/** Margin rows grouped by a key: sale with GST, discount, sale without GST, cost, profit, margin %. Lines with no cost are counted apart. */
function marginBy<T extends { kept: number; disc: number; taxable: number; costPaise: number | null; profit: number | null; keptQty: number; s: { id: string } }>(lines: T[], key: (l: T) => string) {
  const m = new Map<string, { bills: Set<string>; qty: number; sale: number; disc: number; taxable: number; cost: number; profit: number; uncosted: number }>();
  for (const l of lines) {
    const x = m.get(key(l)) ?? { bills: new Set(), qty: 0, sale: 0, disc: 0, taxable: 0, cost: 0, profit: 0, uncosted: 0 };
    x.bills.add(l.s.id); x.qty += l.keptQty; x.sale += l.kept; x.disc += l.disc; x.taxable += l.taxable;
    if (l.costPaise === null) x.uncosted++; else { x.cost += l.costPaise; x.profit += l.profit!; }
    m.set(key(l), x);
  }
  return m;
}

export async function pharmacyFile(tx: Tx, t: string, tz: string, kind: PharmacyKind, type: string, from: string, to: string, span: string): Promise<{ title: string; rows: unknown[][] }> {
  const start = dayBounds(from, tz).start; const end = dayBounds(to, tz).end;

  if (kind === 'pharmacy' && type === 'returns') {
    const sales = await tx.select({ s: pharmacySale, name: patient.fullName, no: patient.patientNo }).from(pharmacySale).innerJoin(patient, eq(patient.id, pharmacySale.patientId))
      .where(and(eq(pharmacySale.tenantId, t), gte(pharmacySale.createdAt, addDays(from, -366)), lt(pharmacySale.createdAt, end)));
    const out: unknown[][] = []; let total = 0;
    for (const { s, name, no } of sales) for (const r of s.returns ?? []) if (r.at >= start && r.at < end) for (const rl of r.lines) {
      const l = s.items[rl.line]; total += rl.amountPaise;
      out.push([todayIn(tz, new Date(r.at)), r.creditNoteNo, s.invoiceNo, todayIn(tz, new Date(s.createdAt)), s.buyerName ?? name, no, l?.name ?? '', l?.batchNo ?? '', l?.expiry ?? '', rl.qty, rs(l?.mrpPaise ?? 0), rs(rl.amountPaise), rl.restock === false ? 'No' : 'Yes', mode(r.method), r.reason, r.by]);
    }
    return { title: `Medicine returns ${span}`, rows: [['Return date', 'Credit note', 'Bill no', 'Bill date', 'Patient', 'Patient no', 'Medicine', 'Batch', 'Expiry', 'Qty returned', 'MRP (Rs)', 'Refund (Rs)', 'Back on shelf', 'Refund mode', 'Reason', 'By'],
      ...out.sort((a, b) => String(a[0]).localeCompare(String(b[0]))), [], ['Total refunded', '', '', '', '', '', '', '', '', '', '', rs(total)]] };
  }

  if (kind === 'pharmacy' && type === 'lines') {
    const { lines } = await saleLines(tx, t, tz, from, to);
    let tax = 0, gst = 0, net = 0;
    const body = lines.map((x) => { const g = gstIn(x.net, x.l.gstBp); tax += x.net - g; gst += g; net += x.net;
      return [x.day, x.s.invoiceNo, x.who, x.no, x.l.name, x.l.hsn ?? '', x.l.batchNo ?? '', x.l.expiry ?? '', x.l.qty, rs(x.l.mrpPaise), rs(x.disc), rs(x.net), rs(x.net - g), (x.l.gstBp / 100).toString(), rs(Math.floor(g / 2)), rs(g - Math.floor(g / 2)), x.backQty || '', mode(x.s.method), x.doctor]; });
    return { title: `Pharmacy sales GST ${span}`, rows: [['Date', 'Bill no', 'Patient', 'Patient no', 'Medicine', 'HSN', 'Batch', 'Expiry', 'Qty', 'MRP (Rs)', 'Discount (Rs)', 'Amount (Rs)', 'Taxable (Rs)', 'GST %', 'CGST (Rs)', 'SGST (Rs)', 'Qty returned', 'Mode', 'Prescribed by'],
      ...body, [], ['Total', '', '', '', '', '', '', '', '', '', '', rs(net), rs(tax), '', rs(Math.floor(gst / 2)), rs(gst - Math.floor(gst / 2))]] };
  }

  if (kind === 'pharmacy') { // bill-wise (HealthPlix's Billing Report), or month by month
    const { sales } = await saleLines(tx, t, tz, from, to);
    const back = (s: (typeof sales)[number]['s']) => (s.returns ?? []).reduce((n, r) => n + r.refundPaise, 0);
    if (type === 'month') {
      const { lines } = await saleLines(tx, t, tz, from, to);
      const m = marginBy(lines, (l) => l.day.slice(0, 7));
      const rows = [...new Set(sales.map((x) => todayIn(tz, new Date(x.s.createdAt)).slice(0, 7)))].sort().map((mo) => {
        const ss = sales.filter((x) => todayIn(tz, new Date(x.s.createdAt)).startsWith(mo)); const g = m.get(mo)!;
        const billed = ss.reduce((n, x) => n + x.s.grossPaise, 0), disc = ss.reduce((n, x) => n + x.s.discountPaise, 0), ret = ss.reduce((n, x) => n + back(x.s), 0);
        return [mo, ss.length, rs(billed), rs(disc), rs(ret), rs(billed - disc - ret), rs(g.cost), rs(g.profit), pct(g.profit, g.taxable)];
      });
      return { title: `Pharmacy monthly billing ${span}`, rows: [['Month', 'Bills', 'Billed at MRP (Rs)', 'Discount (Rs)', 'Returned (Rs)', 'Net after returns (Rs)', 'Cost (Rs)', 'Profit (Rs)', 'Margin %'], ...rows] };
    }
    const byMode: Record<string, number> = {};
    const body = sales.map(({ s, name, no, doctor }) => {
      for (const p of s.payments?.length ? s.payments : [{ method: s.method, amountPaise: s.totalPaise }]) byMode[p.method] = (byMode[p.method] ?? 0) + p.amountPaise;
      return [todayIn(tz, new Date(s.createdAt)), new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(s.createdAt)), s.invoiceNo, s.encounterId ? 'Prescription' : 'Counter sale', s.buyerName ?? name, no, s.encounterId ? doctor ?? '' : '',
        s.items.length, rs(s.grossPaise), pct(s.discountPaise, s.grossPaise), rs(s.discountPaise), rs(s.totalPaise), rs(s.gstPaise), rs(back(s)), rs(s.totalPaise - back(s)), mode(s.method)];
    });
    const sum = (k: 'grossPaise' | 'discountPaise' | 'totalPaise' | 'gstPaise') => rs(sales.reduce((n, x) => n + x.s[k], 0));
    const ret = sales.reduce((n, x) => n + back(x.s), 0);
    return { title: `Pharmacy bills ${span}`, rows: [['Date', 'Time', 'Bill no', 'Type', 'Patient', 'Patient no', 'Doctor', 'Items', 'Billed at MRP (Rs)', 'Disc %', 'Discount (Rs)', 'Net (Rs)', 'GST in it (Rs)', 'Returned (Rs)', 'Net after returns (Rs)', 'Mode'],
      ...body, ['Total', '', `${sales.length} bills`, '', '', '', '', '', sum('grossPaise'), '', sum('discountPaise'), sum('totalPaise'), sum('gstPaise'), rs(ret), rs(sales.reduce((n, x) => n + x.s.totalPaise, 0) - ret)],
      [], ['Collected by mode', 'Amount (Rs)'], ...Object.entries(byMode).map(([k, v]) => [mode(k), rs(v)])] };
  }

  if (kind === 'pharmacy_margin') {
    const { lines } = await saleLines(tx, t, tz, from, to);
    const head = ['Sale incl. GST (Rs)', 'Discount given (Rs)', 'Sale excl. GST (Rs)', 'Cost (Rs)', 'Profit (Rs)', 'Margin %'];
    const tail = (g: ReturnType<typeof marginBy>[keyof object] | any) => [rs(g.sale), rs(g.disc), rs(g.taxable), rs(g.cost), rs(g.profit), pct(g.profit, g.taxable)];
    const all = marginBy(lines, () => 'all').get('all');
    const total = all ? ['Total', ...tail(all)] : ['Total'];
    const note = lines.some((l) => l.costPaise === null) ? [[], [`${lines.filter((l) => l.costPaise === null).length} line(s) have no purchase cost (stock entered without a price): left out of cost and profit`]] : [];
    if (type === 'line') {
      return { title: `Pharmacy margin by bill line ${span}`, rows: [['Date', 'Bill no', 'Patient', 'Medicine', 'Batch', 'Expiry', 'Qty kept', ...head],
        ...lines.map((x) => [x.day, x.s.invoiceNo, x.who, x.l.name, x.l.batchNo ?? '', x.l.expiry ?? '', x.keptQty, rs(x.kept), rs(x.disc), rs(x.taxable), x.costPaise === null ? '' : rs(x.costPaise), x.profit === null ? '' : rs(x.profit), x.profit === null ? '' : pct(x.profit, x.taxable)]),
        ['', '', '', '', '', '', ...total], ...note] };
    }
    if (type === 'day' || type === 'month') {
      const m = marginBy(lines, (l) => (type === 'month' ? l.day.slice(0, 7) : l.day));
      return { title: `Pharmacy margin by ${type} ${span}`, rows: [[type === 'month' ? 'Month' : 'Date', 'Bills', ...head], ...[...m].sort((a, b) => a[0].localeCompare(b[0])).map(([k, g]) => [k, g.bills.size, ...tail(g)]), [...total.slice(0, 1), '', ...total.slice(1)], ...note] };
    }
    const m = marginBy(lines, (l) => l.l.name);
    return { title: `Pharmacy margin by medicine ${span}`, rows: [['Medicine', 'Qty sold (after returns)', ...head], ...[...m].sort((a, b) => b[1].profit - a[1].profit).map(([k, g]) => [k, g.qty, ...tail(g)]), [...total.slice(0, 1), '', ...total.slice(1)], ...note] };
  }

  if (kind === 'purchase') {
    const docs = await tx.select({ d: stockDoc, v: vendor.name, gstin: vendor.gstin }).from(stockDoc).leftJoin(vendor, eq(vendor.id, stockDoc.vendorId))
      .where(and(eq(stockDoc.tenantId, t), eq(stockDoc.kind, 'receipt'), gte(stockDoc.createdAt, start), lt(stockDoc.createdAt, end))).orderBy(asc(stockDoc.createdAt));
    const medIds = [...new Set(docs.flatMap((x) => x.d.lines.map((l: any) => l.medicineId)))];
    const hsn = new Map((medIds.length ? await tx.select({ id: medicine.id, hsn: medicine.hsn }).from(medicine).where(inArray(medicine.id, medIds)) : []).map((m) => [m.id, m.hsn]));
    let tax = 0, gst = 0, amt = 0;
    const body = docs.flatMap(({ d, v, gstin }) => d.lines.map((l: any) => {
      const g = gstIn(l.amountPaise, l.gstBp ?? 0); tax += l.amountPaise - g; gst += g; amt += l.amountPaise;
      return [todayIn(tz, new Date(d.createdAt)), d.docNo, d.billNo ?? '', d.billDate ?? '', v ?? 'Opening stock', gstin ?? '', l.name, hsn.get(l.medicineId) ?? '', l.batchNo, l.expiry, l.qty, l.freeQty || '', rs(l.ratePaise), ((l.discBp ?? 0) / 100).toString(),
        rs(l.amountPaise - g), ((l.gstBp ?? 0) / 100).toString(), rs(Math.floor(g / 2)), rs(g - Math.floor(g / 2)), rs(l.amountPaise)];
    }));
    return { title: `Purchase GST ${span}`, rows: [['Received', 'GRN', 'Vendor bill no', 'Bill date', 'Vendor', 'Vendor GSTIN', 'Medicine', 'HSN', 'Batch', 'Expiry', 'Qty', 'Free', 'Rate (Rs)', 'Disc %', 'Taxable (Rs)', 'GST %', 'CGST (Rs)', 'SGST (Rs)', 'Total (Rs)'],
      ...body, ['Total', '', '', '', '', '', '', '', '', '', '', '', '', '', rs(tax), '', rs(Math.floor(gst / 2)), rs(gst - Math.floor(gst / 2)), rs(amt)]] };
  }

  if (kind === 'moving') {
    const meds = await tx.select().from(medicine).where(eq(medicine.tenantId, t)).orderBy(asc(medicine.name));
    const batches = await tx.select().from(stockBatch).where(eq(stockBatch.tenantId, t));
    const moves = await tx.select({ m: stockMove.medicineId, c: stockMove.change, k: stockMove.kind, at: stockMove.createdAt }).from(stockMove)
      .where(and(eq(stockMove.tenantId, t), inArray(stockMove.kind, ['sale', 'patient_return']))).orderBy(desc(stockMove.createdAt));
    const rows = meds.map((m) => {
      const bs = batches.filter((b) => b.medicineId === m.id && b.qty > 0);
      const sold = -moves.filter((x) => x.m === m.id && x.at >= start && x.at < end).reduce((n, x) => n + x.c, 0);
      const last = moves.find((x) => x.m === m.id && x.k === 'sale');
      return { m, sold, onHand: bs.reduce((n, b) => n + b.qty, 0), value: bs.reduce((n, b) => n + b.qty * b.costPaise, 0), expiry: bs.map((b) => b.expiry).sort()[0] ?? '', last: last ? todayIn(tz, new Date(last.at)) : 'Never' };
    });
    if (type === 'nonmoving') {
      const still = rows.filter((r) => r.sold <= 0 && r.onHand > 0).sort((a, b) => b.value - a.value);
      return { title: `Non-moving medicines ${span}`, rows: [['Medicine', 'On hand (packs)', 'Stock value at cost (Rs)', 'Nearest expiry', 'Last sold', 'MRP (Rs)'], ...still.map((r) => [r.m.name, r.onHand, rs(r.value), r.expiry, r.last, rs(r.m.mrpPaise)]),
        ['Total', still.reduce((n, r) => n + r.onHand, 0), rs(still.reduce((n, r) => n + r.value, 0))]] };
    }
    const moving = rows.filter((r) => r.sold > 0).sort((a, b) => b.sold - a.sold);
    return { title: `Moving medicines ${span}`, rows: [['Medicine', 'Sold (packs, after returns)', 'On hand (packs)', 'Reorder level', 'Below reorder', 'Nearest expiry', 'Last sold', 'MRP (Rs)'],
      ...moving.map((r) => [r.m.name, r.sold, r.onHand, r.m.reorderLevel, r.onHand < r.m.reorderLevel ? 'Yes' : '', r.expiry, r.last, rs(r.m.mrpPaise)])] };
  }

  // stockadj: hand corrections and stock counts
  const moves = await tx.select({ x: stockMove, med: medicine.name, batch: stockBatch.batchNo, cost: stockBatch.costPaise }).from(stockMove).innerJoin(medicine, eq(medicine.id, stockMove.medicineId)).innerJoin(stockBatch, eq(stockBatch.id, stockMove.batchId))
    .where(and(eq(stockMove.tenantId, t), inArray(stockMove.kind, ['adjust', 'count']), gte(stockMove.createdAt, start), lt(stockMove.createdAt, end))).orderBy(asc(stockMove.createdAt));
  const value = moves.reduce((n, m) => n + m.x.change * m.cost, 0);
  return { title: `Stock adjustments ${span}`, rows: [['Date', 'Time', 'Medicine', 'Batch', 'Change (packs)', 'Stock after', 'Value at cost (Rs)', 'Kind', 'Count no', 'Reason', 'By'],
    ...moves.map(({ x, med, batch, cost }) => [todayIn(tz, new Date(x.createdAt)), new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(x.createdAt)), med, batch, x.change, x.balance, rs(x.change * cost), x.kind === 'count' ? 'Stock count' : 'Adjustment', x.docNo ?? '', x.note ?? '', x.byName]),
    ['Total', '', '', '', moves.reduce((n, m) => n + m.x.change, 0), '', rs(value)]] };
}
