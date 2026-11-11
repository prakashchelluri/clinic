import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, asc, eq, inArray, ne, notInArray, sql } from 'drizzle-orm';
import { charge, course, message, patient, practitioner, procedureCatalog, procedureSession, quote, recommendation, tenant } from '../db/schema.js';
import { route } from '../lib/route.js';
import { emit, nextNumber, todayIn, addDays } from '../lib/core.js';
import { HttpError, can } from '../lib/auth.js';
import { MSG, patientLang } from '../lib/patientText.js';

const money = (p: number) => '₹' + (p / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 });

export function planRoutes(app: FastifyInstance) {
  /** A quote for a procedure plan: the price, how long it holds, and what is not in it. Sent on WhatsApp or printed. */
  route(app, 'post', '/quotes', 'worklist.write', async (req, tx) => {
    const b = z.object({ recommendationId: z.string().uuid(), validDays: z.number().int().min(1).max(365).default(15), totalPaise: z.number().int().positive().optional(),
      extras: z.array(z.object({ name: z.string().trim().min(1).max(60), pricePaise: z.number().int().min(0) })).max(10).default([]), send: z.enum(['whatsapp', 'print']).optional() }).parse(req.body);
    const t = req.ctx.tenantId;
    if (!can(req.perms, 'fees.see')) throw new HttpError(403, 'FORBIDDEN:fees.see');
    const rec = await tx.select().from(recommendation).where(and(eq(recommendation.id, b.recommendationId), eq(recommendation.tenantId, t), eq(recommendation.kind, 'procedure'))).then((r) => r[0]);
    if (!rec || !rec.procedureId) throw new HttpError(404, 'PLAN_NOT_FOUND');
    const proc = await tx.select().from(procedureCatalog).where(eq(procedureCatalog.id, rec.procedureId)).then((r) => r[0]);
    const sittings = rec.sittings ?? 1; const list = (proc?.pricePaise ?? 0) * sittings;
    if (!list && !b.totalPaise) throw new HttpError(400, 'PRICE_NEEDED');
    const total = b.totalPaise ?? list;
    if (list && total > list) throw new HttpError(400, 'ABOVE_LIST_PRICE', { listPaise: list });
    if (list && total < list) {
      if (!can(req.perms, 'discount.give')) throw new HttpError(403, 'FORBIDDEN:discount.give');
      const ten = await tx.select().from(tenant).where(eq(tenant.id, t)).then((r) => r[0]);
      const cap = Number((ten?.settings as any)?.discountCapPct ?? 10); const pct = Math.round(((list - total) / list) * 1000) / 10;
      if (pct > cap && !req.ctx.roles.includes('owner')) throw new HttpError(403, 'DISCOUNT_ABOVE_CAP_NEEDS_OWNER', { capPct: cap, pct });
    }
    const p = await tx.select().from(patient).where(eq(patient.id, rec.patientId)).then((r) => r[0]);
    const number = 'Q-' + String(await nextNumber(tx, t, 'quote_no', 'tenant')).padStart(4, '0');
    const validUntil = addDays(todayIn(req.ctx.timezone), b.validDays);
    await tx.update(quote).set({ status: 'declined' }).where(and(eq(quote.tenantId, t), eq(quote.recommendationId, rec.id), eq(quote.status, 'open'))); // a new quote replaces the old
    const [row] = await tx.insert(quote).values({ tenantId: t, patientId: rec.patientId, recommendationId: rec.id, number, totalPaise: total, sittings, validUntil, extras: b.extras, byName: req.ctx.name, ...(b.send ? { sentVia: b.send, sentAt: new Date().toISOString() } : {}) }).returning();
    let messaged = false;
    if (b.send === 'whatsapp') {
      if (!p?.phone || !/^\d{10}$/.test(p.phone)) throw new HttpError(400, 'NO_PHONE');
      const ten = await tx.select().from(tenant).where(eq(tenant.id, t)).then((r) => r[0]);
      const extraTotal = b.extras.reduce((s, x) => s + x.pricePaise, 0);
      const lang = patientLang(p, ten?.settings); const w = MSG[lang];
      const label = p.flags?.careful ? w.plan : proc?.name ?? 'Procedure'; // a Handle carefully patient's messages never name the procedure
      await tx.insert(message).values({ tenantId: t, patientId: p.id, kind: 'quote', channel: 'whatsapp', toPhone: p.phone, params: { quote: number, lang },
        body: `${ten?.name ?? 'Clinic'} · ${w.quote} ${number}\n${label}: ${sittings} ${w.sittings} ${money(total)}${b.extras.map((x) => `\n${x.name} ${money(x.pricePaise)}`).join('')}\n${w.total} ${money(total + extraTotal)}. ${w.validUntil(validUntil)}\n${w.replyYes}` });
      messaged = true;
    }
    await emit(tx, req.ctx, 'quote.created', 'quote', row.id, { number, totalPaise: total, send: b.send });
    return { ...row, messaged };
  });

  route(app, 'get', '/quotes', 'worklist.read', async (req, tx) => {
    if (!can(req.perms, 'fees.see')) return [];
    const q = req.query as any; const t = req.ctx.tenantId; const today = todayIn(req.ctx.timezone);
    const where = q.recommendationId ? and(eq(quote.tenantId, t), eq(quote.recommendationId, String(q.recommendationId))) : q.patientId ? and(eq(quote.tenantId, t), eq(quote.patientId, String(q.patientId))) : eq(quote.tenantId, t);
    const rows = await tx.select().from(quote).where(where).orderBy(sql`${quote.createdAt} desc`).limit(50);
    return rows.map((r) => ({ ...r, state: r.status === 'open' && r.validUntil < today ? 'expired' : r.status }));
  });

  route(app, 'get', '/quotes/:id/print', 'worklist.read', async (req, tx) => {
    if (!can(req.perms, 'fees.see')) throw new HttpError(403, 'FORBIDDEN:fees.see');
    const t = req.ctx.tenantId;
    const q = await tx.select().from(quote).where(and(eq(quote.id, (req.params as any).id), eq(quote.tenantId, t))).then((r) => r[0]);
    if (!q) throw new HttpError(404, 'NOT_FOUND');
    const p = await tx.select().from(patient).where(eq(patient.id, q.patientId)).then((r) => r[0]);
    const rec = await tx.select().from(recommendation).where(eq(recommendation.id, q.recommendationId)).then((r) => r[0]);
    const proc = rec?.procedureId ? await tx.select().from(procedureCatalog).where(eq(procedureCatalog.id, rec.procedureId)).then((r) => r[0]) : null;
    const ten = await tx.select().from(tenant).where(eq(tenant.id, t)).then((r) => r[0]);
    return { number: q.number, at: q.createdAt, validUntil: q.validUntil, patient: { fullName: p?.fullName, patientNo: p?.patientNo }, preparedBy: q.byName, clinic: { name: ten?.name, print: (ten?.settings as any)?.print ?? {} },
      procedure: proc?.name ?? 'Procedure', sittings: q.sittings, totalPaise: q.totalPaise, extras: q.extras, grandTotalPaise: q.totalPaise + q.extras.reduce((s, x) => s + x.pricePaise, 0), taxNote: proc?.taxRateBp ? `GST ${proc.taxRateBp / 100}%` : 'GST included where it applies' };
  });

  /** Procedure plans on one board: Advised (told the price), Agreed (price agreed, nothing paid yet), Paid (all sittings paid for). Each carries its sittings ledger. */
  route(app, 'get', '/procedure-plans', 'worklist.read', async (req, tx) => {
    const t = req.ctx.tenantId; const today = todayIn(req.ctx.timezone); const fees = can(req.perms, 'fees.see');
    const recs = await tx.select({ r: recommendation, p: { id: patient.id, fullName: patient.fullName, patientNo: patient.patientNo, flags: patient.flags }, proc: procedureCatalog.name, price: procedureCatalog.pricePaise })
      .from(recommendation).innerJoin(patient, eq(patient.id, recommendation.patientId)).leftJoin(procedureCatalog, eq(procedureCatalog.id, recommendation.procedureId))
      .where(and(eq(recommendation.tenantId, t), eq(recommendation.kind, 'procedure'), ne(recommendation.status, 'cancelled'))).orderBy(asc(recommendation.dueOn)).limit(300);
    const ids = recs.map((x) => x.r.id);
    if (!ids.length) return { counts: { advised: 0, agreed: 0, paid: 0 }, plans: [] };
    const courses = await tx.select().from(course).where(and(eq(course.tenantId, t), inArray(course.recommendationId, ids)));
    const sessions = await tx.select({ ps: procedureSession, doctor: practitioner.name }).from(procedureSession).leftJoin(practitioner, eq(practitioner.id, procedureSession.practitionerId)).where(and(eq(procedureSession.tenantId, t), inArray(procedureSession.recommendationId, ids))).orderBy(asc(procedureSession.day), asc(procedureSession.startTime));
    // every live sitting charge, with or without a course (a sitting with no course is billed at list price); cancelled ones no longer count
    const sids = sessions.map((s) => s.ps.id);
    const charges = sids.length ? await tx.select().from(charge).where(and(eq(charge.tenantId, t), inArray(charge.sessionId, sids), notInArray(charge.status, ['cancelled', 'waived']))) : [];
    const quotes = await tx.select().from(quote).where(and(eq(quote.tenantId, t), inArray(quote.recommendationId, ids))).orderBy(sql`${quote.createdAt} desc`);
    const plans = recs.map((x) => {
      const c = courses.find((k) => k.recommendationId === x.r.id); const sit = x.r.sittings ?? 1;
      const mine = sessions.filter((s) => s.ps.recommendationId === x.r.id); const done = mine.filter((s) => s.ps.state === 'completed');
      const ch = charges.filter((k) => mine.some((s) => s.ps.id === k.sessionId));
      const paidAll = c ? new Set(ch.filter((k) => k.status === 'paid' && !ch.some((z) => z.sessionId === k.sessionId && z.status !== 'paid')).map((k) => k.sessionId)).size >= sit : false;
      const q = quotes.find((k) => k.recommendationId === x.r.id);
      const state = !c ? (mine.length > 0 ? 'agreed' : 'advised') : paidAll || x.r.status === 'done' ? 'paid' : 'agreed';
      const ledger = Array.from({ length: sit }, (_, i) => { const n = i + 1; const s = done[i] ?? mine.find((m) => m.ps.sittingNo === n && !['completed'].includes(m.ps.state)); const ks = ch.filter((z) => s && z.sessionId === s.ps.id); // two when the advance covered only part of the sitting
        return { n, state: done[i] ? 'done' : s ? s.ps.state : 'planned', day: s?.ps.day ?? null, doctor: s?.doctor ?? null, did: (done[i]?.ps.outcome as any)?.note ?? done[i]?.ps.notes ?? null, paid: ks.length > 0 && ks.every((k) => k.status === 'paid'), prepaid: ks.some((k) => k.prepaid), amountPaise: fees && ks.length ? ks.reduce((a, k) => a + k.amountPaise, 0) : null }; });
      return { id: x.r.id, patient: x.p, procedure: x.proc ?? 'Procedure', sittings: sit, doneSittings: done.length, state, dueOn: x.r.dueOn, listPaise: fees ? (x.price ?? 0) * sit : null, totalPaise: fees ? c?.totalPaise ?? null : null,
        quote: q ? { number: q.number, validUntil: q.validUntil, state: q.status === 'open' && q.validUntil < today ? 'expired' : q.status } : null, ledger };
    });
    return { counts: { advised: plans.filter((p) => p.state === 'advised').length, agreed: plans.filter((p) => p.state === 'agreed').length, paid: plans.filter((p) => p.state === 'paid').length }, plans };
  });
}
