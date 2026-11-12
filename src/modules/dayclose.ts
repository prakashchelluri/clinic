import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, gte, inArray, isNull, lt, lte, sql } from 'drizzle-orm';
import { appointment, charge, dayClose, encounter, expense, feeCategory, patient, payment, pharmacySale, practitioner, prescriptionItem, procedureCatalog, procedureSession, recommendation, session, visit } from '../db/schema.js';
import { clinical } from './patients.js';
import { markMissed } from './followups.js';
import type { Tx } from '../db/index.js';
import { route } from '../lib/route.js';
import { addDays, emit, todayIn } from '../lib/core.js';
import { HttpError, can, type Ctx } from '../lib/auth.js';
import { dayBounds } from './billing.js';

export const COUNT_KEYS = ['General', 'Review', 'Procedure', 'Procedure follow-up', 'Relatives and friends'] as const;
type Bucket = { cash: number; upi: number; card: number; other: number; total: number };
const empty = (): Bucket => ({ cash: 0, upi: 0, card: 0, other: 0, total: 0 });
const put = (b: Bucket, method: string, amount: number) => { b[method === 'cash' || method === 'upi' || method === 'card' ? method : 'other'] += amount; b.total += amount; };

/** The patient-visit type the doctor's diary uses, from the fee category. */
export function visitType(code: string, name: string): (typeof COUNT_KEYS)[number] {
  if (/relative|friend|family/i.test(name) || code === 'FAM') return 'Relatives and friends';
  if (code === 'REN') return 'Review';
  if (code === 'FREE') return 'Procedure follow-up';
  return 'General';
}

/** A day's money by type and mode, the cash that should be in the drawer, and the visit counts: what the head receptionist reads against the paper diary. */
// `to` makes it a range (the Dashboard); every money figure in the app comes from here so they always agree.
// byDoctor: the same money by the doctor of the visit or sitting it paid for; pharmacy, course advances and anything else stay out (the rest of the total).
export type Money = { consultation: Bucket; procedure: Bucket; pharmacy: Bucket; other: Bucket; total: Bucket };
export const emptyMoney = (): Money => ({ consultation: empty(), procedure: empty(), pharmacy: empty(), other: empty(), total: empty() });

/** Money in over a range, each payment on the clinic's local day it came in: the one ledger End of day, Reports, Clinic and Accounts all read. */
export async function moneyByDay(tx: Tx, t: string, tz: string, from: string, to = from) {
  const start = dayBounds(from, tz).start; const end = dayBounds(to, tz).end;
  const days: Record<string, Money> = {}; const total = emptyMoney(); const byDoctor: Record<string, number> = {};
  const add = (at: string | Date, key: Exclude<keyof Money, 'total'>, method: string, amount: number) => {
    const m = (days[todayIn(tz, new Date(at))] ??= emptyMoney());
    put(m[key], method, amount); put(m.total, method, amount); put(total[key], method, amount); put(total.total, method, amount);
  };
  const pays = await tx.select({ p: payment, c: charge, vDoc: visit.practitionerId, sDoc: procedureSession.practitionerId, sale: pharmacySale.id }).from(payment).leftJoin(charge, eq(charge.id, payment.chargeId))
    .leftJoin(visit, eq(visit.id, charge.visitId)).leftJoin(procedureSession, eq(procedureSession.id, charge.sessionId))
    .leftJoin(pharmacySale, and(eq(pharmacySale.tenantId, t), eq(pharmacySale.chargeId, payment.chargeId)))
    .where(and(eq(payment.tenantId, t), gte(payment.receivedAt, start), lt(payment.receivedAt, end)));
  // ponytail: refunds are negative payment rows dated the day the money went back (billing.ts, /charges/:id/adjust), in the original mode, so they net out here with no extra rule.
  for (const { p, c, vDoc, sDoc, sale } of pays) {
    if (sale) continue; // a pharmacy bill's payment and refund rows mirror the sale; the sale and its returns below are what count, once
    if (p.method === 'advance') continue; // paid from the patient's advance: that money was counted the day the advance came in

    add(p.receivedAt, p.courseId || c?.courseId ? 'procedure' : c?.visitId ? 'consultation' : 'other', p.method, p.amountPaise);
    const doc = vDoc ?? sDoc; if (doc) byDoctor[doc] = (byDoctor[doc] ?? 0) + p.amountPaise;
  }
  const sales = await tx.select().from(pharmacySale).where(and(eq(pharmacySale.tenantId, t), gte(pharmacySale.createdAt, start), lt(pharmacySale.createdAt, end)));
  for (const s of sales) for (const x of (s.payments?.length ? s.payments : [{ method: s.method, amountPaise: s.totalPaise }])) add(s.createdAt, 'pharmacy', x.method, x.amountPaise);
  const allSales = await tx.select().from(pharmacySale).where(and(eq(pharmacySale.tenantId, t), gte(pharmacySale.createdAt, addDays(from, -90))));
  for (const s of allSales) for (const r of s.returns ?? []) if (r.at >= start && r.at < end) add(r.at, 'pharmacy', r.method, -r.refundPaise);
  return { days, total, byDoctor };
}

export async function dayFigures(tx: Tx, t: string, tz: string, day: string, to = day) {
  const start = dayBounds(day, tz).start; const end = dayBounds(to, tz).end;
  const { total: money, byDoctor } = await moneyByDay(tx, t, tz, day, to);
  const exp = await tx.select({ n: sql<number>`coalesce(sum(amount_paise),0)::int` }).from(expense).where(and(eq(expense.tenantId, t), gte(expense.day, day), lte(expense.day, to), eq(expense.method, 'cash'), isNull(expense.voidedAt)));
  const expensesCashPaise = exp[0]?.n ?? 0;
  const vis = await tx.select({ code: feeCategory.code, name: feeCategory.name }).from(visit).innerJoin(feeCategory, eq(feeCategory.id, visit.feeCategoryId)).where(and(eq(visit.tenantId, t), gte(visit.day, day), lte(visit.day, to)));
  const counts: Record<string, number> = Object.fromEntries(COUNT_KEYS.map((k) => [k, 0]));
  for (const v of vis) counts[visitType(v.code, v.name)]++;
  counts.Procedure = (await tx.select({ n: sql<number>`count(*)::int` }).from(procedureSession).where(and(eq(procedureSession.tenantId, t), gte(procedureSession.day, day), lte(procedureSession.day, to), eq(procedureSession.state, 'completed'))))[0]?.n ?? 0;
  const awaiting = await tx.select({ n: sql<number>`coalesce(sum(amount_paise),0)::int` }).from(payment).where(and(eq(payment.tenantId, t), eq(payment.method, 'emi'), isNull(payment.settledAt), gte(payment.receivedAt, start), lt(payment.receivedAt, end)));
  return { day, money, byDoctor, drawer: { expectedCashPaise: money.total.cash - expensesCashPaise, expensesCashPaise }, counts, emiAwaitingPaise: awaiting[0]?.n ?? 0 };
}

/** A day that has been closed does not take new payments; a mistake is put right by a refund, which is dated today. */
export async function assertDayOpen(tx: Tx, ctx: Ctx) {
  const closed = await tx.select({ id: dayClose.id }).from(dayClose).where(and(eq(dayClose.tenantId, ctx.tenantId), eq(dayClose.day, todayIn(ctx.timezone)))).limit(1);
  if (closed.length) throw new HttpError(409, 'DAY_CLOSED');
}

export function dayCloseRoutes(app: FastifyInstance) {
  route(app, 'get', '/dayclose', 'report.daily', async (req, tx) => {
    if (!can(req.perms, 'fees.see')) throw new HttpError(403, 'FORBIDDEN:fees.see');
    const day = String((req.query as any).day ?? todayIn(req.ctx.timezone));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new HttpError(400, 'BAD_DATE');
    const { byDoctor: _, ...live } = await dayFigures(tx, req.ctx.tenantId, req.ctx.timezone, day); // per-doctor money is the Dashboard's, by role
    const closed = await tx.select().from(dayClose).where(and(eq(dayClose.tenantId, req.ctx.tenantId), eq(dayClose.day, day))).then((r) => r[0] ?? null);
    return { ...live, closed, countKeys: COUNT_KEYS };
  });

  /** Close the day: every difference against the diary or the drawer needs a note. After this the day is locked. */
  route(app, 'post', '/dayclose', 'day.close', async (req, tx) => {
    const b = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), cashCountedPaise: z.number().int().min(0), diary: z.record(z.string(), z.number().int().min(0).max(10000)), notes: z.record(z.string(), z.string().trim().max(300)).default({}) }).parse(req.body);
    const t = req.ctx.tenantId; const today = todayIn(req.ctx.timezone);
    if (b.day > today) throw new HttpError(400, 'FUTURE_DAY');
    if (await tx.select({ id: dayClose.id }).from(dayClose).where(and(eq(dayClose.tenantId, t), eq(dayClose.day, b.day))).then((r) => r.length)) throw new HttpError(409, 'ALREADY_CLOSED');
    const f = await dayFigures(tx, t, req.ctx.timezone, b.day);
    const missing: string[] = [];
    for (const k of COUNT_KEYS) { if (b.diary[k] === undefined) throw new HttpError(400, 'DIARY_NEEDED', { key: k }); if (b.diary[k] !== f.counts[k] && (b.notes[k] ?? '').length < 3) missing.push(k); }
    if (b.cashCountedPaise !== f.drawer.expectedCashPaise && (b.notes.cash ?? '').length < 3) missing.push('cash');
    if (missing.length) throw new HttpError(400, 'NOTE_NEEDED_FOR_DIFFERENCE', { missing });
    const [row] = await tx.insert(dayClose).values({ tenantId: t, day: b.day, closedBy: req.ctx.name, cashCountedPaise: b.cashCountedPaise, counts: f.counts, diary: b.diary, notes: b.notes, totals: { money: f.money, drawer: f.drawer, emiAwaitingPaise: f.emiAwaitingPaise } }).returning();
    await emit(tx, req.ctx, 'day.closed', 'day_close', row.id, { day: b.day, collectedPaise: f.money.total.total });
    return row;
  });

  /** The visit counts stored at each close, one row a day. */
  route(app, 'get', '/dayclose/history', 'report.daily', async (req, tx) => {
    const rows = await tx.select().from(dayClose).where(eq(dayClose.tenantId, req.ctx.tenantId)).orderBy(desc(dayClose.day)).limit(60);
    return rows.map((r) => ({ day: r.day, counts: r.counts, closedBy: r.closedBy, differences: Object.keys(r.notes) }));
  });

  /** The owner's Clinic page in one call: yesterday and today by section and mode, this week's totals, and what needs the owner
   *  (days never closed, money still due, EMI the lender has not paid). Stock and doctors come from their own endpoints. */
  route(app, 'get', '/owner/summary', 'finance.read', async (req, tx) => {
    const t = req.ctx.tenantId; const tz = req.ctx.timezone; const today = todayIn(tz); const yesterday = addDays(today, -1);
    const closedRows = await tx.select().from(dayClose).where(and(eq(dayClose.tenantId, t), gte(dayClose.day, addDays(today, -14))));
    const closedOn = new Map(closedRows.map((r) => [r.day, r]));
    const y = await dayFigures(tx, t, tz, yesterday); const yc = closedOn.get(yesterday);
    const td = await dayFigures(tx, t, tz, today);
    // Monday of this week up to today
    const dow = (new Date(today + 'T00:00:00Z').getUTCDay() + 6) % 7;
    const week = [];
    for (let i = dow; i >= 0; i--) { const d = addDays(today, -i); week.push({ day: d, totalPaise: d === today ? td.money.total.total : d === yesterday ? y.money.total.total : (await dayFigures(tx, t, tz, d)).money.total.total }); }
    // a day with patients or money in the last two weeks that nobody closed
    const worked = await tx.select({ day: visit.day }).from(visit).where(and(eq(visit.tenantId, t), gte(visit.day, addDays(today, -14)), lt(visit.day, today))).groupBy(visit.day);
    const unclosed = [];
    for (const { day } of worked.sort((a, b) => a.day.localeCompare(b.day))) if (!closedOn.has(day)) { const f = day === yesterday ? y : await dayFigures(tx, t, tz, day); unclosed.push({ day, money: f.money }); }
    const dues = await tx.select({ total: sql<number>`coalesce(sum(${charge.amountPaise}),0)::int`, patients: sql<number>`count(distinct ${charge.patientId})::int` }).from(charge).where(and(eq(charge.tenantId, t), eq(charge.status, 'due')));
    const emi = await tx.select({ total: sql<number>`coalesce(sum(${payment.amountPaise}),0)::int`, n: sql<number>`count(*)::int` }).from(payment).where(and(eq(payment.tenantId, t), eq(payment.method, 'emi'), isNull(payment.settledAt)));
    return {
      today, yesterday: { day: yesterday, money: y.money, closed: yc ? { by: yc.closedBy, at: yc.createdAt, cashDiffPaise: (yc.cashCountedPaise ?? 0) - ((yc.totals as any)?.drawer?.expectedCashPaise ?? 0), notes: yc.notes } : null },
      todayMoney: td.money, week, unclosed, dues: { totalPaise: dues[0]?.total ?? 0, patients: dues[0]?.patients ?? 0 }, emi: { totalPaise: emi[0]?.total ?? 0, n: emi[0]?.n ?? 0 },
    };
  });

  /** Reports: the basic figures of a period against the period before, by doctor. A doctor sees only their own patients and takings; the owner sees all and can pick a doctor. */
  route(app, 'get', '/reports/analytics', 'report.read', async (req, tx) => {
    await markMissed(tx, req.ctx); // yesterday's unattended bookings count as no-shows before anything is counted
    const t = req.ctx.tenantId; const tz = req.ctx.timezone; const money = can(req.perms, 'fees.see'); const allMoney = can(req.perms, 'finance.read');
    const q = req.query as any; const to = /^\d{4}-\d{2}-\d{2}$/.test(q.to) ? q.to : todayIn(tz); const from = /^\d{4}-\d{2}-\d{2}$/.test(q.from) ? q.from : addDays(to, -29);
    if (from > to) throw new HttpError(400, 'BAD_RANGE');
    const span = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
    if (span > 366) throw new HttpError(400, 'RANGE_TOO_LONG');
    const pFrom = addDays(from, -span); const pTo = addDays(from, -1);
    const docs = await tx.select({ id: practitioner.id, name: practitioner.name }).from(practitioner).where(and(eq(practitioner.tenantId, t), eq(practitioner.active, true)));
    // the owner may narrow to one doctor; anyone else with a doctor record is held to their own patients
    const doc: string | null = allMoney ? (docs.some((d) => d.id === q.doctor) ? q.doctor : null) : req.ctx.practitionerId ?? null;
    const byDoc = (col: any) => (doc ? eq(col, doc) : undefined);
    const inRange = (col: any, a: string, b: string) => and(gte(col, a), lte(col, b));

    // ponytail: each period is read into memory and counted here; fine for one clinic's year, move the counts into SQL if it slows
    const vis = (a: string, b: string) => tx.select({ v: visit, code: feeCategory.code, name: feeCategory.name, src: appointment.source }).from(visit).innerJoin(feeCategory, eq(feeCategory.id, visit.feeCategoryId))
      .leftJoin(appointment, eq(appointment.id, visit.appointmentId)).where(and(eq(visit.tenantId, t), inRange(visit.day, a, b), byDoc(visit.practitionerId)));
    const firstVisit = async (ids: string[]) => new Map((ids.length ? await tx.select({ p: visit.patientId, d: sql<string>`min(${visit.day})::text` }).from(visit).where(and(eq(visit.tenantId, t), inArray(visit.patientId, ids))).groupBy(visit.patientId) : []).map((r) => [r.p, r.d]));
    const times = async (a: string, b: string) => {
      const rows = await tx.select({ arrived: visit.arrivedAt, started: encounter.createdAt, done: encounter.completedAt }).from(encounter).innerJoin(visit, eq(visit.id, encounter.visitId)).where(and(eq(encounter.tenantId, t), eq(encounter.status, 'completed'), inRange(visit.day, a, b), byDoc(visit.practitionerId)));
      const m = (xs: number[]) => (xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length / 60000) * 10) / 10 : null);
      return { waitMin: m(rows.map((r) => Date.parse(r.started) - Date.parse(r.arrived)).filter((x) => x >= 0)), withDoctorMin: m(rows.filter((r) => r.done).map((r) => Date.parse(r.done!) - Date.parse(r.started)).filter((x) => x >= 0)) };
    };
    const appts = async (a: string, b: string, status: string) => (await tx.select({ n: sql<number>`count(*)::int` }).from(appointment).innerJoin(session, eq(session.id, appointment.sessionId)).where(and(eq(appointment.tenantId, t), eq(appointment.status, status), inRange(session.day, a, b), byDoc(session.practitionerId))))[0]?.n ?? 0;
    const sittings = (a: string, b: string) => tx.select({ s: procedureSession, proc: procedureCatalog.name }).from(procedureSession).leftJoin(procedureCatalog, eq(procedureCatalog.id, procedureSession.procedureId))
      .where(and(eq(procedureSession.tenantId, t), eq(procedureSession.state, 'completed'), inRange(procedureSession.day, a, b), byDoc(procedureSession.practitionerId)));
    // collected: the End of day ledger (payments in the range, net of refunds); a doctor's share is what was paid against their visits and sittings
    const collected = async (a: string, b: string) => { if (!money) return null; const f = await dayFigures(tx, t, tz, a, b); return doc ? f.byDoctor[doc] ?? 0 : allMoney ? f.money.total.total : null; };
    const due = async (a: string, b: string) => {
      if (!money || (!allMoney && !doc)) return null;
      const v = await tx.select({ n: sql<number>`coalesce(sum(${charge.amountPaise}),0)::int` }).from(charge).innerJoin(visit, eq(visit.id, charge.visitId)).where(and(eq(charge.tenantId, t), eq(charge.status, 'due'), inRange(visit.day, a, b), byDoc(visit.practitionerId)));
      const s = await tx.select({ n: sql<number>`coalesce(sum(${charge.amountPaise}),0)::int` }).from(charge).innerJoin(procedureSession, eq(procedureSession.id, charge.sessionId)).where(and(eq(charge.tenantId, t), eq(charge.status, 'due'), inRange(procedureSession.day, a, b), byDoc(procedureSession.practitionerId)));
      return (v[0]?.n ?? 0) + (s[0]?.n ?? 0);
    };
    const period = async (a: string, b: string) => {
      const vs = await vis(a, b); const pids = [...new Set(vs.map((x) => x.v.patientId))]; const first = await firstVisit(pids);
      const fresh = pids.filter((p) => (first.get(p) ?? a) >= a).length;
      return { vs, pids, first, figures: { patients: pids.length, visits: vs.length, newPatients: fresh, returning: pids.length - fresh, collectedPaise: await collected(a, b), duePaise: await due(a, b),
        sittings: (await sittings(a, b)).length, ...(await times(a, b)), noShows: await appts(a, b, 'no_show'), cancelled: await appts(a, b, 'cancelled') } };
    };
    const now = await period(from, to); const before = await period(pFrom, pTo);
    const cur = now.vs;

    const byDay = new Map<string, number>(); for (const x of cur) byDay.set(x.v.day, (byDay.get(x.v.day) ?? 0) + 1);
    const trend = Array.from({ length: Math.min(span, 92) }, (_, i) => { const d = addDays(to, -(Math.min(span, 92) - 1 - i)); return { day: d, visits: byDay.get(d) ?? 0 }; });
    const types: Record<string, number> = Object.fromEntries(COUNT_KEYS.map((k) => [k, 0])); for (const x of cur) types[visitType(x.code, x.name)]++;
    const weekday = [0, 0, 0, 0, 0, 0, 0]; for (const x of cur) weekday[(new Date(x.v.day + 'T00:00:00Z').getUTCDay() + 6) % 7]++; // Mon first
    const hour = (d: Date) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(d));
    const byHour: Record<number, number> = {}; for (const x of cur) { const h = hour(new Date(x.v.arrivedAt)); byHour[h] = (byHour[h] ?? 0) + 1; }
    const walkIn = cur.filter((x) => !x.v.appointmentId || x.src === 'walk_in').length;

    // per doctor: the owner's view of all doctors, only when not narrowed to one
    const fAll = money && allMoney && !doc ? await dayFigures(tx, t, tz, from, to) : null;
    const perDoctor = allMoney && !doc ? docs.map((d) => { const mine = cur.filter((x) => x.v.practitionerId === d.id); const ps = [...new Set(mine.map((m) => m.v.patientId))];
      return { id: d.id, name: d.name, visits: mine.length, patients: ps.length, newPatients: ps.filter((p) => (now.first.get(p) ?? from) >= from).length, collectedPaise: fAll ? fAll.byDoctor[d.id] ?? 0 : null }; }) : null;

    const people = now.pids.length ? await tx.select({ id: patient.id, sex: patient.sex, age: patient.ageYears, locality: patient.locality, card: patient.referralCard }).from(patient).where(and(eq(patient.tenantId, t), inArray(patient.id, now.pids))) : [];
    const count = <T,>(xs: T[], key: (x: T) => string | null | undefined, n = 10) => { const m = new Map<string, number>(); for (const x of xs) { const k = key(x)?.trim(); if (k) m.set(k, (m.get(k) ?? 0) + 1); } return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([name, n]) => ({ name, n })); };
    const band = (a: number | null) => a === null ? 'Not recorded' : a < 18 ? 'Under 18' : a <= 30 ? '18–30' : a <= 45 ? '31–45' : a <= 60 ? '46–60' : 'Over 60';
    const visitsPer = new Map<string, number>(); for (const x of cur) visitsPer.set(x.v.patientId, (visitsPer.get(x.v.patientId) ?? 0) + 1);

    let clinicalData = null;
    if (clinical(req.perms)) {
      const encs = await tx.select({ id: encounter.id, data: encounter.data }).from(encounter).innerJoin(visit, eq(visit.id, encounter.visitId)).where(and(eq(encounter.tenantId, t), eq(encounter.status, 'completed'), inRange(visit.day, from, to), byDoc(visit.practitionerId)));
      const ids = encs.map((e) => e.id);
      const dx = encs.flatMap((e) => ([] as any[]).concat((e.data as any)?.assessment?.diagnosis ?? []).map((x) => (typeof x === 'string' ? x : x?.name)));
      const rx = ids.length ? await tx.select({ name: prescriptionItem.name }).from(prescriptionItem).where(and(eq(prescriptionItem.tenantId, t), inArray(prescriptionItem.encounterId, ids))) : [];
      const recs = ids.length ? await tx.select({ kind: recommendation.kind, notes: recommendation.notes }).from(recommendation).where(and(eq(recommendation.tenantId, t), inArray(recommendation.encounterId, ids))) : [];
      const sits = await sittings(from, to);
      clinicalData = { consultations: encs.length, diagnoses: count(dx, (x) => x), medicines: count(rx, (x) => x.name), tests: count(recs.filter((r) => r.kind === 'investigation'), (r) => r.notes),
        procedures: count(sits, (s) => s.proc ?? 'Procedure'), coursesStarted: recs.filter((r) => r.kind === 'procedure').length };
    }

    return { from, to, previous: { from: pFrom, to: pTo }, doctor: doc, doctors: allMoney ? docs : null, now: now.figures, before: before.figures,
      overview: { trend, averagePerDay: Math.round((cur.length / span) * 10) / 10, perDoctor },
      visits: { types, weekday, byHour, walkIn, booked: cur.length - walkIn },
      patients: { sex: count(people, (p) => (p.sex === 'M' ? 'Men' : p.sex === 'F' ? 'Women' : p.sex === 'O' ? 'Other' : 'Not recorded')), ages: count(people, (p) => band(p.age), 6),
        localities: count(people, (p) => p.locality), referralCard: people.filter((p) => p.card).length,
        frequency: count([...visitsPer.values()], (n) => (n >= 4 ? '4 or more visits' : `${n} visit${n === 1 ? '' : 's'}`), 4) },
      clinical: clinicalData };
  });
}
