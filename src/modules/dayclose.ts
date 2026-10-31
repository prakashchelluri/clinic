import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import { appointment, charge, dayClose, encounter, expense, feeCategory, payment, pharmacySale, practitioner, procedureSession, session, visit } from '../db/schema.js';
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
export async function dayFigures(tx: Tx, t: string, tz: string, day: string) {
  const { start, end } = dayBounds(day, tz);
  const pays = await tx.select({ p: payment, c: charge }).from(payment).leftJoin(charge, eq(charge.id, payment.chargeId)).where(and(eq(payment.tenantId, t), gte(payment.receivedAt, start), lt(payment.receivedAt, end)));
  const money = { consultation: empty(), procedure: empty(), pharmacy: empty(), other: empty(), total: empty() };
  for (const { p, c } of pays) {
    const bucket = p.courseId || c?.courseId ? money.procedure : c?.visitId ? money.consultation : money.other;
    put(bucket, p.method, p.amountPaise); put(money.total, p.method, p.amountPaise);
  }
  const sales = await tx.select().from(pharmacySale).where(and(eq(pharmacySale.tenantId, t), gte(pharmacySale.createdAt, start), lt(pharmacySale.createdAt, end)));
  for (const s of sales) for (const x of (s.payments?.length ? s.payments : [{ method: s.method, amountPaise: s.totalPaise }])) { put(money.pharmacy, x.method, x.amountPaise); put(money.total, x.method, x.amountPaise); }
  const allSales = await tx.select().from(pharmacySale).where(and(eq(pharmacySale.tenantId, t), gte(pharmacySale.createdAt, addDays(day, -90))));
  for (const s of allSales) for (const r of s.returns ?? []) if (r.at >= start && r.at < end) { put(money.pharmacy, r.method, -r.refundPaise); put(money.total, r.method, -r.refundPaise); }
  const exp = await tx.select({ n: sql<number>`coalesce(sum(amount_paise),0)::int` }).from(expense).where(and(eq(expense.tenantId, t), eq(expense.day, day), eq(expense.method, 'cash'), isNull(expense.voidedAt)));
  const expensesCashPaise = exp[0]?.n ?? 0;
  const vis = await tx.select({ code: feeCategory.code, name: feeCategory.name }).from(visit).innerJoin(feeCategory, eq(feeCategory.id, visit.feeCategoryId)).where(and(eq(visit.tenantId, t), eq(visit.day, day)));
  const counts: Record<string, number> = Object.fromEntries(COUNT_KEYS.map((k) => [k, 0]));
  for (const v of vis) counts[visitType(v.code, v.name)]++;
  counts.Procedure = (await tx.select({ n: sql<number>`count(*)::int` }).from(procedureSession).where(and(eq(procedureSession.tenantId, t), eq(procedureSession.day, day), eq(procedureSession.state, 'completed'))))[0]?.n ?? 0;
  const awaiting = await tx.select({ n: sql<number>`coalesce(sum(amount_paise),0)::int` }).from(payment).where(and(eq(payment.tenantId, t), eq(payment.method, 'emi'), isNull(payment.settledAt), gte(payment.receivedAt, start), lt(payment.receivedAt, end)));
  return { day, money, drawer: { expectedCashPaise: money.total.cash - expensesCashPaise, expensesCashPaise }, counts, emiAwaitingPaise: awaiting[0]?.n ?? 0 };
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
    const live = await dayFigures(tx, req.ctx.tenantId, req.ctx.timezone, day);
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

  /** Per-doctor tiles, a daily trend, and the times that matter, each against the month before rather than an outside benchmark. */
  route(app, 'get', '/dashboard', 'report.read', async (req, tx) => {
    const t = req.ctx.tenantId; const tz = req.ctx.timezone; const money = can(req.perms, 'fees.see');
    const q = req.query as any; const to = /^\d{4}-\d{2}-\d{2}$/.test(q.to) ? q.to : todayIn(tz); const from = /^\d{4}-\d{2}-\d{2}$/.test(q.from) ? q.from : addDays(to, -29);
    const span = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1; const pFrom = addDays(from, -span); const pTo = addDays(from, -1);
    const docs = await tx.select().from(practitioner).where(and(eq(practitioner.tenantId, t), eq(practitioner.active, true)));
    const vis = (a: string, b: string) => tx.select({ v: visit, code: feeCategory.code, name: feeCategory.name }).from(visit).innerJoin(feeCategory, eq(feeCategory.id, visit.feeCategoryId)).where(and(eq(visit.tenantId, t), gte(visit.day, a), sql`${visit.day} <= ${b}`));
    const cur = await vis(from, to);
    const charges = cur.length ? await tx.select().from(charge).where(and(eq(charge.tenantId, t), sql`${charge.visitId} in (select id from visit where tenant_id = ${t} and day >= ${from} and day <= ${to})`)) : [];
    const sitCharges = await tx.select({ c: charge, doc: procedureSession.practitionerId }).from(charge).innerJoin(procedureSession, eq(procedureSession.id, charge.sessionId)).where(and(eq(charge.tenantId, t), gte(procedureSession.day, from), sql`${procedureSession.day} <= ${to}`));
    const tiles = docs.map((d) => {
      const mine = cur.filter((x) => x.v.practitionerId === d.id); const cs = [...charges.filter((c) => mine.some((m) => m.v.id === c.visitId)), ...sitCharges.filter((s) => s.doc === d.id).map((s) => s.c)];
      const paid = cs.filter((c) => c.status === 'paid').reduce((s, c) => s + c.amountPaise, 0); const pending = cs.filter((c) => c.status === 'due').reduce((s, c) => s + c.amountPaise, 0);
      const types = mine.map((m) => visitType(m.code, m.name));
      return { id: d.id, name: d.name, patients: mine.length, newPatients: types.filter((x) => x === 'General' || x === 'Relatives and friends').length, reviews: types.filter((x) => x === 'Review' || x === 'Procedure follow-up').length,
        ...(money ? { revenuePaise: paid + pending, paidPaise: paid, pendingPaise: pending } : {}) };
    });
    const byDay = new Map<string, number>(); for (const x of cur) byDay.set(x.v.day, (byDay.get(x.v.day) ?? 0) + 1);
    const trend = Array.from({ length: Math.min(span, 31) }, (_, i) => { const d = addDays(to, -(Math.min(span, 31) - 1 - i)); return { day: d, patients: byDay.get(d) ?? 0 }; });
    const avg = trend.length ? Math.round((trend.reduce((s, x) => s + x.patients, 0) / trend.length) * 10) / 10 : 0;
    const open = trend.filter((x) => x.patients > 0); const busiest = open.reduce((a, b) => (b.patients > (a?.patients ?? -1) ? b : a), undefined as any); const quietest = open.reduce((a, b) => (b.patients < (a?.patients ?? 1e9) ? b : a), undefined as any);
    const times = async (a: string, b: string) => {
      const rows = await tx.select({ arrived: visit.arrivedAt, started: encounter.createdAt, done: encounter.completedAt }).from(encounter).innerJoin(visit, eq(visit.id, encounter.visitId)).where(and(eq(encounter.tenantId, t), eq(encounter.status, 'completed'), gte(visit.day, a), sql`${visit.day} <= ${b}`));
      const m = (xs: number[]) => (xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length / 60000) * 10) / 10 : null);
      return { waitMin: m(rows.map((r) => Date.parse(r.started) - Date.parse(r.arrived)).filter((x) => x >= 0)), withDoctorMin: m(rows.filter((r) => r.done).map((r) => Date.parse(r.done!) - Date.parse(r.started)).filter((x) => x >= 0)) };
    };
    const appts = async (a: string, b: string, status: string) => (await tx.select({ n: sql<number>`count(*)::int` }).from(appointment).innerJoin(session, eq(session.id, appointment.sessionId)).where(and(eq(appointment.tenantId, t), eq(appointment.status, status), gte(session.day, a), sql`${session.day} <= ${b}`)))[0]?.n ?? 0;
    const prev = await vis(pFrom, pTo);
    const types: Record<string, number> = Object.fromEntries(COUNT_KEYS.map((k) => [k, 0])); for (const x of cur) types[visitType(x.code, x.name)]++;
    return { from, to, previous: { from: pFrom, to: pTo }, tiles, trend, averagePerDay: avg, busiest: busiest ?? null, quietest: quietest ?? null, types, visits: cur.length, previousVisits: prev.length,
      times: { now: await times(from, to), before: await times(pFrom, pTo) }, missed: { now: await appts(from, to, 'no_show'), before: await appts(pFrom, pTo, 'no_show') }, cancelled: { now: await appts(from, to, 'cancelled'), before: await appts(pFrom, pTo, 'cancelled') }, moneyHidden: !money };
  });
}
