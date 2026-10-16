import type { FastifyInstance } from 'fastify';
import { and, eq, desc, sql, gte, inArray } from 'drizzle-orm';
import { visit, patient, payment, procedureSession, procedureCatalog, room, practitioner, domainEvent, appUser } from '../db/schema.js';
import { route } from '../lib/route.js';
import { todayIn, addDays } from '../lib/core.js';

/** Owner and admin home. Needs finance.read: it carries revenue. */
export function overviewRoutes(app: FastifyInstance) {
  route(app, 'get', '/overview', 'finance.read', async (req, tx) => {
    const t = req.ctx.tenantId; const tz = req.ctx.timezone; const today = todayIn(tz); const from = addDays(today, -29);

    const [{ visits }] = await tx.select({ visits: sql<number>`count(*)::int` }).from(visit).where(and(eq(visit.tenantId, t), eq(visit.day, today)));
    const yesterdaySame = await tx.select({ n: sql<number>`count(*)::int` }).from(visit).where(and(eq(visit.tenantId, t), eq(visit.day, addDays(today, -7))));
    const waitingRows = await tx.select({ v: visit, p: { fullName: patient.fullName }, doctor: practitioner.name }).from(visit)
      .innerJoin(patient, eq(patient.id, visit.patientId)).leftJoin(practitioner, eq(practitioner.id, visit.practitionerId))
      .where(and(eq(visit.tenantId, t), eq(visit.day, today), inArray(visit.status, ['waiting', 'intake']))).orderBy(desc(visit.priority), visit.queuePosition);

    const daily: any = await tx.execute(sql`
      select (p.received_at at time zone ${tz})::date::text as day, sum(p.amount_paise)::int as total, p.method as method
      from payment p where p.tenant_id = ${t} and (p.received_at at time zone ${tz})::date >= ${from}::date group by 1, 3 order by 1`);
    const rows: { day: string; total: number; method: string }[] = daily.rows ?? daily;
    const series: { day: string; totalPaise: number }[] = [];
    for (let i = 0; i < 30; i++) { const d = addDays(from, i); series.push({ day: d, totalPaise: rows.filter((r) => r.day === d).reduce((s, r) => s + r.total, 0) }); }
    const todayRows = rows.filter((r) => r.day === today);

    const sessions = await tx.select({ ps: procedureSession, patient: patient.fullName, procedure: procedureCatalog.name, room: room.name, doctor: practitioner.name })
      .from(procedureSession).innerJoin(patient, eq(patient.id, procedureSession.patientId)).leftJoin(procedureCatalog, eq(procedureCatalog.id, procedureSession.procedureId))
      .leftJoin(room, eq(room.id, procedureSession.roomId)).leftJoin(practitioner, eq(practitioner.id, procedureSession.practitionerId))
      .where(and(eq(procedureSession.tenantId, t), eq(procedureSession.day, today), sql`${procedureSession.state} not in ('cancelled','postponed')`)).orderBy(procedureSession.startTime);

    const events = await tx.select().from(domainEvent).where(and(eq(domainEvent.tenantId, t), inArray(domainEvent.type, ['visit.checked_in', 'encounter.completed', 'pharmacy.billed', 'appointment.booked', 'payment.recorded']), gte(domainEvent.occurredAt, from))).orderBy(desc(domainEvent.occurredAt)).limit(8);
    const pids = [...new Set(events.map((e: any) => e.payload?.patientId).filter(Boolean))] as string[];
    const names = pids.length ? await tx.select({ id: patient.id, n: patient.fullName }).from(patient).where(inArray(patient.id, pids)) : [];
    const uids = [...new Set(events.map((e: any) => e.actor?.userId).filter(Boolean))] as string[];
    const users = uids.length ? await tx.select({ id: appUser.id, n: appUser.name }).from(appUser).where(inArray(appUser.id, uids)) : [];
    const activity = events.map((e: any) => {
      const who = users.find((u) => u.id === e.actor?.userId)?.n?.replace(/ \(.*\)/, '') ?? 'Someone'; const pt = names.find((n) => n.id === e.payload?.patientId)?.n;
      const text = e.type === 'visit.checked_in' ? `checked in ${pt ?? 'a patient'}` : e.type === 'encounter.completed' ? `completed ${pt ?? 'a consultation'}` : e.type === 'appointment.booked' ? `booked ${pt ?? 'an appointment'}` : e.type === 'pharmacy.billed' ? `billed pharmacy ₹${Math.round((e.payload?.amountPaise ?? 0) / 100)}` : `recorded a payment of ₹${Math.round((e.payload?.amountPaise ?? 0) / 100)}`;
      return { who, text, at: e.occurredAt };
    });

    return {
      today: { visits, sameDayLastWeek: yesterdaySame[0].n, collectedPaise: todayRows.reduce((s, r) => s + r.total, 0), byMethod: todayRows.map((r) => ({ method: r.method, totalPaise: r.total })), waiting: waitingRows.length, longestWaitMin: waitingRows.length ? Math.round((Date.now() - Math.min(...waitingRows.map((w) => new Date(w.v.arrivedAt).getTime()))) / 60000) : 0 },
      waiting: waitingRows.slice(0, 3).map((w) => ({ id: w.v.id, opNumber: w.v.opNumber, name: w.p.fullName, doctor: w.doctor, status: w.v.status, priority: w.v.priority, arrivedAt: w.v.arrivedAt })),
      series, totalPaise: series.reduce((s, x) => s + x.totalPaise, 0),
      rooms: sessions.map((s) => ({ id: s.ps.id, startTime: s.ps.startTime, patient: s.patient, procedure: s.procedure, room: s.room, doctor: s.doctor, state: s.ps.state })),
      activity,
    };
  });
}
