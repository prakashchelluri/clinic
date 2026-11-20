import type { FastifyInstance } from 'fastify';
import { and, asc, eq, gte, inArray, isNull, lt, lte, ne } from 'drizzle-orm';
import { appUser, appointment, bill, charge, encounter, expense, medicine, patient, payment, pharmacySale, practitioner, prescriptionItem, procedureCatalog, procedureSession, session, visit } from '../db/schema.js';
import type { Tx } from '../db/index.js';
import { route } from '../lib/route.js';
import { addDays, daysBetween, todayIn } from '../lib/core.js';
import { HttpError, can } from '../lib/auth.js';
import { writeAudit } from '../lib/audit.js';
import { clinical } from './patients.js';
import { dayBounds } from './billing.js';
import { moneyByDay } from './dayclose.js';
import { pharmacyFile, type PharmacyKind } from './pharmacyReports.js';
import { chargeCredited } from '../lib/money.js';

/**
 * Reports to download (Tatva's Reports page): each one is a CSV built here as rows, so the figures match End of day and Accounts.
 * Money reports are the owner's; appointment and procedure lists also reception's; prescription reports the doctors'. A doctor sees only their own patients.
 * Every download needs the owner's "lists may leave the app" and is written to the audit log.
 */
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const rs = (p: number) => (p / 100).toFixed(2);
const MODES: Record<string, string> = { cash: 'Cash', upi: 'UPI', card: 'Card', bank: 'Bank', emi: 'EMI', advance: 'From advance', split: 'Split' };
const mode = (m: string) => MODES[m] ?? m;
const SECTIONS = [['consultation', 'Consultation'], ['procedure', 'Procedure'], ['pharmacy', 'Pharmacy'], ['other', 'Advance and other']] as const;
const STATUS: Record<string, string> = { booked: 'Booked', confirmed: 'Confirmed', arrived: 'Came', cancelled: 'Cancelled', no_show: 'No show' };
const SESSION: Record<string, string> = { confirmed: 'Booked', in_progress: 'In progress', completed: 'Done', missed: 'Missed', cancelled: 'Cancelled', postponed: 'Postponed' };
const gstIn = (amount: number, bp: number) => (bp ? amount - Math.round((amount * 10000) / (10000 + bp)) : 0);

type Kind = 'daily' | 'collection' | 'threec' | 'billing' | 'appointments' | 'rx' | 'rxlines' | 'procedures' | PharmacyKind;
const PHARMACY: PharmacyKind[] = ['pharmacy', 'pharmacy_margin', 'purchase', 'moving', 'stockadj'];
type Perms = string[];
const money = (p: Perms) => can(p, 'finance.read');
const ALLOWED: Record<Kind, (p: Perms) => boolean> = {
  daily: (p) => can(p, 'fees.see') && (can(p, 'report.daily') || money(p)),
  collection: money, threec: money, billing: money, pharmacy: money, pharmacy_margin: money, purchase: money, moving: money, stockadj: money,
  appointments: (p) => can(p, 'report.read') || can(p, 'report.daily'),
  procedures: (p) => can(p, 'report.read') || can(p, 'report.daily'),
  rx: (p) => can(p, 'report.read') && clinical(p),
  rxlines: (p) => can(p, 'report.read') && clinical(p),
};

/** Every movement of money in a range, one row each, on the same rules as moneyByDay: pharmacy from its bills and returns, payments from an advance shown but not counted again. */
export async function ledger(tx: Tx, t: string, tz: string, from: string, to: string) {
  const start = dayBounds(from, tz).start; const end = dayBounds(to, tz).end;
  const at = (d: string | Date) => { const x = new Date(d); return { day: todayIn(tz, x), time: new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(x) }; };
  const pays = await tx.select({ p: payment, c: charge, name: patient.fullName, no: patient.patientNo, by: appUser.name, sale: pharmacySale.id, inv: bill.invoiceNo }).from(payment)
    .innerJoin(patient, eq(patient.id, payment.patientId)).leftJoin(charge, eq(charge.id, payment.chargeId)).leftJoin(appUser, eq(appUser.id, payment.receivedBy))
    .leftJoin(pharmacySale, and(eq(pharmacySale.tenantId, t), eq(pharmacySale.chargeId, payment.chargeId))).leftJoin(bill, eq(bill.id, payment.billId))
    .where(and(eq(payment.tenantId, t), gte(payment.receivedAt, start), lt(payment.receivedAt, end))).orderBy(asc(payment.receivedAt));
  const refundBills = [...new Set(pays.filter((x) => !x.p.chargeId && x.p.billId).map((x) => x.p.billId!))];
  const billLines = refundBills.length ? await tx.select({ billId: charge.billId, visitId: charge.visitId, courseId: charge.courseId }).from(charge).where(inArray(charge.billId, refundBills)) : [];
  const chargeBills = [...new Set(pays.map((x) => x.c?.billId).filter((x): x is string => !!x))];
  const invNo = new Map((chargeBills.length ? await tx.select({ id: bill.id, no: bill.invoiceNo }).from(bill).where(inArray(bill.id, chargeBills)) : []).map((b) => [b.id, b.no]));
  const rows: { day: string; time: string; receiptNo: string; invoiceNo: string; patient: string; patientNo: string; for: string; kind: string; section: string; method: string; amountPaise: number; counted: boolean; by: string; byId: string | null }[] = [];
  for (const { p, c, name, no, by, sale, inv } of pays) {
    if (sale) continue; // the pharmacy bill below is the record
    const bl = !c && p.billId ? billLines.find((x) => x.billId === p.billId) : undefined;
    const section = p.courseId || c?.courseId || bl?.courseId ? 'procedure' : c?.visitId || bl?.visitId ? 'consultation' : 'other';
    const used = p.method === 'advance';
    // since patient-level billing every refund is a voucher paid out of the advance: it is still a Refund, as Billing and Accounts call it
    const kind = used ? 'Paid from advance' : p.amountPaise < 0 ? 'Refund' : p.advance ? 'Advance received' : 'Receipt';
    rows.push({ ...at(p.receivedAt), receiptNo: p.receiptNo ?? '', invoiceNo: inv ?? (c?.billId ? invNo.get(c.billId) ?? '' : ''), patient: name, patientNo: no,
      for: c?.description ?? (p.courseId ? 'Course advance' : p.advance ? 'Advance' : p.billId ? 'Invoice refund' : 'Payment'), kind, section, method: p.method, amountPaise: p.amountPaise, counted: !used, by: by ?? '', byId: p.receivedBy });
  }
  const sales = await tx.select({ s: pharmacySale, name: patient.fullName, no: patient.patientNo, by: appUser.name }).from(pharmacySale).innerJoin(patient, eq(patient.id, pharmacySale.patientId))
    .leftJoin(appUser, eq(appUser.id, pharmacySale.createdBy)).where(and(eq(pharmacySale.tenantId, t), gte(pharmacySale.createdAt, addDays(from, -90)), lt(pharmacySale.createdAt, end)));
  for (const { s, name, no, by } of sales) {
    const who = s.buyerName ?? name;
    if (new Date(s.createdAt).toISOString() >= start) for (const x of (s.payments?.length ? s.payments : [{ method: s.method, amountPaise: s.totalPaise }]))
      rows.push({ ...at(s.createdAt), receiptNo: s.invoiceNo, invoiceNo: s.invoiceNo, patient: who, patientNo: no, for: `Pharmacy bill · ${s.items.length} item${s.items.length === 1 ? '' : 's'}`, kind: 'Pharmacy bill', section: 'pharmacy', method: x.method, amountPaise: x.amountPaise, counted: true, by: by ?? '', byId: s.createdBy });
    for (const r of s.returns ?? []) if (r.at >= start && r.at < end)
      rows.push({ ...at(r.at), receiptNo: r.creditNoteNo, invoiceNo: s.invoiceNo, patient: who, patientNo: no, for: `Pharmacy return · ${r.reason}`, kind: 'Pharmacy return', section: 'pharmacy', method: r.method, amountPaise: -r.refundPaise, counted: true, by: r.by, byId: null });
  }
  return rows.sort((a, b) => (a.day + a.time).localeCompare(b.day + b.time));
}

export function reportFileRoutes(app: FastifyInstance) {
  /** Which reports this person may download, and the pickers the drawers need. */
  route(app, 'get', '/reports/files', null, async (req, tx) => {
    const t = req.ctx.tenantId; const p = req.perms;
    const kinds = (Object.keys(ALLOWED) as Kind[]).filter((k) => ALLOWED[k](p));
    const owner = money(p);
    return {
      kinds, canExport: !!req.privacy?.canExport, ownOnly: !owner && !!req.ctx.practitionerId,
      doctors: owner ? await tx.select({ id: practitioner.id, name: practitioner.name }).from(practitioner).where(and(eq(practitioner.tenantId, t), eq(practitioner.active, true))).orderBy(asc(practitioner.name)) : [],
      staff: owner ? await tx.select({ id: appUser.id, name: appUser.name }).from(appUser).where(and(eq(appUser.tenantId, t), eq(appUser.active, true))).orderBy(asc(appUser.name)) : [],
    };
  });

  route(app, 'get', '/reports/files/:kind', null, async (req, tx) => {
    const kind = (req.params as any).kind as Kind; const q = req.query as Record<string, string | undefined>;
    if (!(kind in ALLOWED)) throw new HttpError(404, 'NO_SUCH_REPORT');
    if (!ALLOWED[kind](req.perms)) throw new HttpError(403, 'FORBIDDEN:report');
    if (!req.privacy?.canExport) throw new HttpError(403, 'LISTS_OWNER_ONLY');
    const t = req.ctx.tenantId; const tz = req.ctx.timezone; const today = todayIn(tz);
    const okDay = (s?: string) => !!s && DAY.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
    let from: string, to: string;
    if (kind === 'daily') { from = to = okDay(q.day) ? q.day! : today; }
    else {
      if (!okDay(q.from) || !okDay(q.to)) throw new HttpError(400, 'PERIOD_NEEDED');
      from = q.from!; to = q.to!;
      if (from > to) throw new HttpError(400, 'BAD_RANGE');
      if (daysBetween(from, to) > 366) throw new HttpError(400, 'RANGE_TOO_LONG');
    }
    const type = q.type ?? '';
    // the owner may narrow to one doctor; a doctor is held to their own patients
    const docs = await tx.select({ id: practitioner.id, name: practitioner.name }).from(practitioner).where(eq(practitioner.tenantId, t));
    const docName = new Map(docs.map((d) => [d.id, d.name]));
    const doc: string | null = money(req.perms) ? (q.doctor && docName.has(q.doctor) ? q.doctor : null) : req.ctx.practitionerId ?? null;
    const byDoc = (col: any) => (doc ? eq(col, doc) : undefined);
    const span = from === to ? from : `${from} to ${to}`;

    let title = ''; let rows: unknown[][] = [];
    if (kind === 'daily') {
      title = `Daily collection ${from}`;
      const l = await ledger(tx, t, tz, from, to);
      const m = (await moneyByDay(tx, t, tz, from, to)).total;
      rows = [['Time', 'Receipt / bill no', 'Invoice no', 'Patient', 'Patient no', 'For', 'Kind', 'Mode', 'Amount (Rs)', 'Taken by'],
        ...l.map((x) => [x.time, x.receiptNo, x.invoiceNo, x.patient, x.patientNo, x.for, x.kind + (x.counted ? '' : ' (not counted again)'), mode(x.method), rs(x.amountPaise), x.by]),
        [], ['Collected by mode', 'Cash', 'UPI', 'Card', 'EMI / other', 'Total'],
        ...SECTIONS.map(([k, label]) => [label, rs(m[k].cash), rs(m[k].upi), rs(m[k].card), rs(m[k].other), rs(m[k].total)]),
        ['Collected (same as End of day)', rs(m.total.cash), rs(m.total.upi), rs(m.total.card), rs(m.total.other), rs(m.total.total)]];
    } else if (kind === 'collection') {
      if (type === 'detailed') {
        title = `Collection detailed ${span}`;
        const l = (await ledger(tx, t, tz, from, to)).filter((x) => (!q.mode || x.method === q.mode) && (!q.by || x.byId === q.by));
        rows = [['Date', 'Time', 'Receipt / bill no', 'Invoice no', 'Patient', 'Patient no', 'For', 'Kind', 'Section', 'Mode', 'Amount (Rs)', 'Counted in collection', 'Taken by'],
          ...l.map((x) => [x.day, x.time, x.receiptNo, x.invoiceNo, x.patient, x.patientNo, x.for, x.kind, SECTIONS.find(([k]) => k === x.section)![1], mode(x.method), rs(x.amountPaise), x.counted ? 'Yes' : 'No (paid from advance)', x.by]),
          [], ['Total counted', '', '', '', '', '', '', '', '', '', rs(l.filter((x) => x.counted).reduce((s, x) => s + x.amountPaise, 0))]];
      } else if (type === 'daywise') {
        title = `Collection day-wise ${span}`;
        const { days, total } = await moneyByDay(tx, t, tz, from, to);
        const ds = Object.keys(days).sort();
        rows = [['Date', 'Consultation', 'Procedure', 'Pharmacy', 'Advance and other', 'Cash', 'UPI', 'Card', 'EMI / other', 'Total'],
          ...ds.map((d) => { const m = days[d]; return [d, ...SECTIONS.map(([k]) => rs(m[k].total)), rs(m.total.cash), rs(m.total.upi), rs(m.total.card), rs(m.total.other), rs(m.total.total)]; }),
          ['Total', ...SECTIONS.map(([k]) => rs(total[k].total)), rs(total.total.cash), rs(total.total.upi), rs(total.total.card), rs(total.total.other), rs(total.total.total)]];
      } else {
        title = `Collection ${span}`;
        const m = (await moneyByDay(tx, t, tz, from, to)).total;
        rows = [['Bill type', 'Cash', 'UPI', 'Card', 'EMI / other', 'Total (Rs)'], ...SECTIONS.map(([k, label]) => [label, rs(m[k].cash), rs(m[k].upi), rs(m[k].card), rs(m[k].other), rs(m[k].total)]),
          ['Total', rs(m.total.cash), rs(m.total.upi), rs(m.total.card), rs(m.total.other), rs(m.total.total)]];
      }
    } else if (kind === 'threec') {
      title = `3C report ${span}`;
      const start = dayBounds(from, tz).start; const end = dayBounds(to, tz).end;
      const out: unknown[][] = [];
      if (!type || type === 'cash') for (const x of (await ledger(tx, t, tz, from, to)).filter((x) => x.amountPaise > 0 && x.counted))
        out.push(['Cash memo', x.receiptNo || x.invoiceNo, x.day, x.patient, x.patientNo, x.for, mode(x.method), rs(x.amountPaise)]);
      if (!type || type === 'invoice') {
        const lines = await tx.select({ c: charge, b: bill, name: patient.fullName, no: patient.patientNo }).from(bill).innerJoin(charge, eq(charge.billId, bill.id)).innerJoin(patient, eq(patient.id, bill.patientId))
          .leftJoin(pharmacySale, and(eq(pharmacySale.tenantId, t), eq(pharmacySale.chargeId, charge.id)))
          .where(and(eq(bill.tenantId, t), gte(bill.createdAt, start), lt(bill.createdAt, end), isNull(pharmacySale.id))).orderBy(asc(bill.createdAt));
        const bills = new Map<string, { no: string; day: string; name: string; pno: string; items: string[]; billed: number; gst: number; paid: number; due: number }>();
        for (const { c, b, name, no } of lines) {
          if (c.status === 'cancelled') continue;
          const x = bills.get(b.id) ?? { no: b.invoiceNo, day: todayIn(tz, new Date(b.createdAt)), name, pno: no, items: [], billed: 0, gst: 0, paid: 0, due: 0 };
          x.items.push(c.description); x.billed += c.amountPaise; x.gst += gstIn(c.amountPaise, c.taxRateBp);
          if (c.status === 'paid') x.paid += c.amountPaise; if (c.status === 'due') x.due += c.amountPaise; bills.set(b.id, x);
        }
        for (const x of bills.values()) out.push(['Invoice', x.no, x.day, x.name, x.pno, `${x.items.join('; ')} · GST ${rs(x.gst)} · paid ${rs(x.paid)} · due ${rs(x.due)}`, '', rs(x.billed)]);
        const sales = await tx.select({ s: pharmacySale, name: patient.fullName, no: patient.patientNo }).from(pharmacySale).innerJoin(patient, eq(patient.id, pharmacySale.patientId))
          .where(and(eq(pharmacySale.tenantId, t), gte(pharmacySale.createdAt, start), lt(pharmacySale.createdAt, end))).orderBy(asc(pharmacySale.createdAt));
        for (const { s, name, no } of sales) out.push(['Pharmacy invoice', s.invoiceNo, todayIn(tz, new Date(s.createdAt)), s.buyerName ?? name, no, `${s.items.map((i) => `${i.name} × ${i.qty}`).join('; ')} · GST ${rs(s.gstPaise)}`, mode(s.method), rs(s.totalPaise)]);
      }
      if (!type || type === 'credit') for (const x of (await ledger(tx, t, tz, from, to)).filter((x) => x.amountPaise < 0 && x.counted))
        out.push(['Credit note', x.receiptNo, x.day, x.patient, x.patientNo, `${x.kind} · ${x.for}${x.invoiceNo ? ` · invoice ${x.invoiceNo}` : ''}`, mode(x.method), rs(-x.amountPaise)]);
      rows = [['Document', 'Number', 'Date', 'Patient', 'Patient no', 'Details', 'Mode', 'Amount (Rs)'], ...out.sort((a, b) => String(a[2]).localeCompare(String(b[2])))];
    } else if (kind === 'billing') {
      const start = dayBounds(from, tz).start; const end = dayBounds(to, tz).end;
      if (type === 'cashflow') {
        title = `Cash flow ${span}`;
        const { days } = await moneyByDay(tx, t, tz, from, to);
        const ex = await tx.select({ day: expense.day, amount: expense.amountPaise }).from(expense).where(and(eq(expense.tenantId, t), gte(expense.day, from), lte(expense.day, to), isNull(expense.voidedAt)));
        const out: Record<string, number> = {}; for (const e of ex) out[e.day] = (out[e.day] ?? 0) + e.amount;
        let run = 0; const body: unknown[][] = []; let tin = 0, tout = 0;
        for (let d = from; d <= to; d = addDays(d, 1)) {
          const i = days[d]?.total.total ?? 0; const o = out[d] ?? 0; if (!i && !o) continue;
          run += i - o; tin += i; tout += o; body.push([d, rs(i), rs(o), rs(i - o), rs(run)]);
        }
        rows = [['Date', 'Money in (Rs)', 'Expenses out (Rs)', 'Net (Rs)', 'Running net (Rs)'], ...body, ['Total', rs(tin), rs(tout), rs(tin - tout), '']];
      } else {
        title = `Revenue ${span}`;
        const lines = await tx.select({ c: charge, credited: chargeCredited, inv: bill.invoiceNo, name: patient.fullName, no: patient.patientNo, vDoc: visit.practitionerId, sDoc: procedureSession.practitionerId }).from(charge)
          .innerJoin(patient, eq(patient.id, charge.patientId)).leftJoin(bill, eq(bill.id, charge.billId)).leftJoin(visit, eq(visit.id, charge.visitId)).leftJoin(procedureSession, eq(procedureSession.id, charge.sessionId))
          .leftJoin(pharmacySale, and(eq(pharmacySale.tenantId, t), eq(pharmacySale.chargeId, charge.id)))
          .where(and(eq(charge.tenantId, t), gte(charge.createdAt, start), lt(charge.createdAt, end), ne(charge.status, 'cancelled'), isNull(pharmacySale.id))).orderBy(asc(charge.createdAt));
        // since patient-level billing a refund leaves the line as it was and puts a credit note against it: the line reads Refunded when
        // credit notes cover all of it (part credited when some), and only what is left counts as billed
        const st: Record<string, string> = { due: 'Due', paid: 'Paid', waived: 'Waived', refunded: 'Refunded' };
        const status = (c: typeof charge.$inferSelect, cr: number) => c.amountPaise > 0 && cr >= c.amountPaise ? 'Refunded' : cr > 0 ? `${st[c.status] ?? c.status}, ${rs(cr)} credited` : st[c.status] ?? c.status;
        const body: unknown[][] = lines.map(({ c, credited, inv, name, no, vDoc, sDoc }) => [todayIn(tz, new Date(c.createdAt)), inv ?? '', name, no, c.description, c.courseId || c.sessionId ? 'Procedure' : c.visitId ? 'Consultation' : 'Other',
          docName.get(vDoc ?? sDoc ?? '') ?? '', rs(c.amountPaise + c.discountPaise), rs(c.discountPaise), rs(c.amountPaise), rs(gstIn(c.amountPaise, c.taxRateBp)), status(c, credited)]);
        const sales = await tx.select({ s: pharmacySale, name: patient.fullName, no: patient.patientNo }).from(pharmacySale).innerJoin(patient, eq(patient.id, pharmacySale.patientId))
          .where(and(eq(pharmacySale.tenantId, t), gte(pharmacySale.createdAt, start), lt(pharmacySale.createdAt, end))).orderBy(asc(pharmacySale.createdAt));
        for (const { s, name, no } of sales) body.push([todayIn(tz, new Date(s.createdAt)), s.invoiceNo, s.buyerName ?? name, no, `Pharmacy: ${s.items.length} item${s.items.length === 1 ? '' : 's'}`, 'Pharmacy', '', rs(s.grossPaise), rs(s.discountPaise), rs(s.totalPaise), rs(s.gstPaise), (s.returns ?? []).length ? 'Paid, part returned' : 'Paid']);
        const live = lines.filter((x) => x.c.status !== 'waived' && x.c.status !== 'refunded');
        const total = live.reduce((s, x) => s + Math.max(0, x.c.amountPaise - x.credited), 0) + sales.reduce((s, x) => s + x.s.totalPaise, 0);
        rows = [['Date', 'Invoice no', 'Patient', 'Patient no', 'Item', 'Bill type', 'Doctor', 'Price (Rs)', 'Discount (Rs)', 'Amount (Rs)', 'GST in it (Rs)', 'Status'], ...body.sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
          [], ['Billed (not waived or refunded)', '', '', '', '', '', '', '', '', rs(total)]];
      }
    } else if (kind === 'appointments') {
      const list = await tx.select({ a: appointment, s: session, name: patient.fullName, no: patient.patientNo, phone: patient.phone }).from(appointment).innerJoin(session, eq(session.id, appointment.sessionId))
        .innerJoin(patient, eq(patient.id, appointment.patientId)).where(and(eq(appointment.tenantId, t), gte(session.day, from), lte(session.day, to), byDoc(session.practitionerId))).orderBy(asc(session.day), asc(session.startTime));
      const walk = await tx.select({ day: visit.day, doc: visit.practitionerId }).from(visit).where(and(eq(visit.tenantId, t), gte(visit.day, from), lte(visit.day, to), isNull(visit.appointmentId), byDoc(visit.practitionerId)));
      const blank = () => ({ booked: 0, came: 0, waiting: 0, cancelled: 0, noShow: 0, walkIn: 0 });
      const add = (m: Map<string, ReturnType<typeof blank>>, k: string, f: keyof ReturnType<typeof blank>) => { const x = m.get(k) ?? blank(); x[f]++; m.set(k, x); };
      const tally = (key: (a: { day: string; doc: string | null }) => string) => {
        const m = new Map<string, ReturnType<typeof blank>>();
        for (const { a, s } of list) { const k = key({ day: s.day, doc: s.practitionerId }); add(m, k, 'booked'); add(m, k, a.status === 'arrived' ? 'came' : a.status === 'cancelled' ? 'cancelled' : a.status === 'no_show' ? 'noShow' : 'waiting'); }
        for (const w of walk) add(m, key({ day: w.day, doc: w.doc }), 'walkIn');
        return m;
      };
      const head = ['Booked', 'Came', 'Not yet come', 'Cancelled', 'No show', 'Walk-ins', 'Patients seen (came + walk-ins)'];
      const cells = (x: ReturnType<typeof blank>) => [x.booked, x.came, x.waiting, x.cancelled, x.noShow, x.walkIn, x.came + x.walkIn];
      if (type === 'detailed') {
        title = `Appointments detailed ${span}`;
        rows = [['Date', 'Hour', 'Patient', 'Patient no', 'Phone', 'Doctor', 'Booked by', 'Status', 'Cancel reason', 'Note', 'Booked on'],
          ...list.map(({ a, s, name, no, phone }) => [s.day, `${s.startTime}–${s.endTime}`, name, no, phone ?? '', docName.get(s.practitionerId ?? '') ?? '', ({ phone: 'Phone', walk_in: 'Walk-in', online: 'Online', repeat: 'Repeat' } as Record<string, string>)[a.source] ?? a.source,
            STATUS[a.status] ?? a.status, a.cancelReason ?? '', a.note ?? '', todayIn(tz, new Date(a.createdAt))])];
      } else if (type === 'doctor') {
        title = `Appointments by doctor ${span}`;
        const m = tally((a) => a.doc ?? '');
        rows = [['Doctor', ...head], ...[...m].map(([k, x]) => [docName.get(k) ?? 'No doctor', ...cells(x)]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))];
      } else {
        title = `Appointments ${span}`;
        const m = tally((a) => a.day);
        const tot = blank(); for (const x of m.values()) for (const k of Object.keys(tot) as (keyof typeof tot)[]) tot[k] += x[k];
        rows = [['Date', ...head], ...[...m].sort((a, b) => a[0].localeCompare(b[0])).map(([k, x]) => [k, ...cells(x)]), ['Total', ...cells(tot)]];
      }
    } else if (kind === 'rx' || kind === 'rxlines') {
      const items = await tx.select({ i: prescriptionItem, generic: medicine.generic, day: visit.day, doc: visit.practitionerId, pid: visit.patientId, name: patient.fullName, no: patient.patientNo }).from(prescriptionItem)
        .innerJoin(encounter, eq(encounter.id, prescriptionItem.encounterId)).innerJoin(visit, eq(visit.id, encounter.visitId)).innerJoin(patient, eq(patient.id, visit.patientId))
        .leftJoin(medicine, eq(medicine.id, prescriptionItem.medicineId))
        .where(and(eq(prescriptionItem.tenantId, t), eq(encounter.status, 'completed'), gte(visit.day, from), lte(visit.day, to), byDoc(visit.practitionerId))).orderBy(asc(visit.day), asc(prescriptionItem.sortOrder));
      if (kind === 'rxlines') {
        title = `Prescription medicines ${span}`;
        rows = [['Date', 'Patient', 'Patient no', 'Doctor', 'Medicine', 'Generic', 'Dose', 'Frequency', 'When', 'Duration', 'Qty to give', 'Qty issued', 'Instructions'],
          ...items.map((x) => [x.day, x.name, x.no, docName.get(x.doc ?? '') ?? '', x.i.name, x.generic ?? '', x.i.dose ?? '', x.i.frequency ?? '', x.i.timing ?? '', x.i.durationDays ? `${x.i.durationDays} days` : x.i.durationNote ?? '', x.i.qty ?? '', x.i.issuedQty, x.i.instructions ?? ''])];
      } else {
        title = `Prescription analytics ${span}`;
        const m = new Map<string, { generic: string; n: number; patients: Set<string>; doctors: Set<string>; qty: number; issued: number; given: number }>();
        for (const x of items) {
          const k = x.i.name.trim(); const r = m.get(k) ?? { generic: x.generic ?? '', n: 0, patients: new Set(), doctors: new Set(), qty: 0, issued: 0, given: 0 };
          r.n++; r.patients.add(x.pid); if (x.doc) r.doctors.add(x.doc); r.qty += x.i.qty ?? 0; r.issued += x.i.issuedQty; if (x.i.issuedQty > 0) r.given++; m.set(k, r);
        }
        const gen = new Map<string, number>(); for (const [, r] of m) if (r.generic) gen.set(r.generic, (gen.get(r.generic) ?? 0) + r.n);
        rows = [['Medicine (brand)', 'Generic', 'Times prescribed', 'Patients', 'Doctors', 'Qty prescribed', 'Qty issued at pharmacy', 'Prescriptions issued at pharmacy'],
          ...[...m].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0])).map(([k, r]) => [k, r.generic, r.n, r.patients.size, [...r.doctors].map((d) => docName.get(d)).join('; '), r.qty, r.issued, r.given]),
          [], ['Generic', 'Times prescribed'], ...[...gen].sort((a, b) => b[1] - a[1]).map(([g, n]) => [g, n])];
      }
    } else if (PHARMACY.includes(kind as PharmacyKind)) {
      ({ title, rows } = await pharmacyFile(tx, t, tz, kind as PharmacyKind, type, from, to, span));
    } else if (kind === 'procedures') {
      title = `Procedure sessions ${span}`;
      const list = await tx.select({ s: procedureSession, proc: procedureCatalog.name, name: patient.fullName, no: patient.patientNo }).from(procedureSession).innerJoin(patient, eq(patient.id, procedureSession.patientId))
        .leftJoin(procedureCatalog, eq(procedureCatalog.id, procedureSession.procedureId)).where(and(eq(procedureSession.tenantId, t), gte(procedureSession.day, from), lte(procedureSession.day, to), byDoc(procedureSession.practitionerId)))
        .orderBy(asc(procedureSession.day), asc(procedureSession.startTime));
      rows = [['Date', 'Time', 'Patient', 'Patient no', 'Procedure', 'Session no', 'Doctor', 'Status', 'Reason'],
        ...list.map(({ s, proc, name, no }) => [s.day, `${s.startTime}–${s.endTime}`, name, no, proc ?? 'Procedure', s.sittingNo, docName.get(s.practitionerId ?? '') ?? '', SESSION[s.state] ?? s.state, s.stateReason ?? ''])];
    }
    const blank = rows.findIndex((r) => r.length === 0); // data rows: after the header, before the first gap, not counting a Total line
    const n = rows.slice(1, blank === -1 ? undefined : blank).filter((r) => r[0] !== 'Total' && !r.slice(0, 7).includes('Total')).length;
    if (doc) title += ` · ${docName.get(doc)}`;
    await writeAudit(tx, req.ctx, { kind: 'print', action: 'report.downloaded', summary: `Downloaded ${title} · ${n} rows`, unusual: true });
    return { title, file: title.replace(/[^\w-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase(), count: n, rows };
  });
}
