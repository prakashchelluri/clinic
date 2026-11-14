import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, ilike, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { type PatientFlags, appointment, callback, patient, practitioner, procedureCatalog, procedureSession, session, visit, encounter, prescriptionItem, recommendation, charge, payment, message } from '../db/schema.js';
import { route } from '../lib/route.js';
import { auditView, writeAudit } from '../lib/audit.js';
import { nextNumber, emit, sent } from '../lib/core.js';
import { HttpError, can } from '../lib/auth.js';
import { normHistory, cleanHistory, allergyText, HISTORY_KEYS } from '../lib/history.js';
import { listData } from '../lib/pad.js';

const PatientIn = z.object({
  fullName: z.string().trim().min(2).max(100),
  phone: z.string().regex(/^\d{10}$/).optional().nullable(),
  sex: z.enum(['M', 'F', 'O']).optional().nullable(),
  ageYears: z.number().int().min(0).max(120).optional().nullable(),
  dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => d >= '1900-01-01' && d <= new Date().toISOString().slice(0, 10), 'DOB_RANGE').optional().nullable(),
  locality: z.string().trim().max(200).optional().nullable(), // the address
  history: z.record(z.string(), z.any()).optional(), // first-visit conditions and allergies; cleaned like the pad's history chips
  referralCard: z.boolean().optional(),
  allergies: z.string().max(500).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  guardianId: z.string().uuid().optional().nullable(),
  contactLabel: z.string().trim().max(40).optional().nullable(),
  noWhatsapp: z.boolean().optional(), // asked for no WhatsApp messages
  language: z.enum(['en', 'te', 'hi']).optional().nullable(),
});

const FlagsIn = z.object({ vip: z.boolean().optional(), family: z.boolean().optional(), careful: z.object({ note: z.string().trim().min(3, 'Say why').max(300) }).nullable().optional() });
/** Turn the sent flags on or off over what the patient has; Handle carefully keeps who set it and when. */
function applyFlags(cur: PatientFlags, b: z.infer<typeof FlagsIn>, by: string): PatientFlags {
  const flags: PatientFlags = { ...cur };
  if (b.vip !== undefined) { if (b.vip) flags.vip = true; else delete flags.vip; }
  if (b.family !== undefined) { if (b.family) flags.family = true; else delete flags.family; }
  if (b.careful !== undefined) { if (b.careful) flags.careful = { note: b.careful.note, by, at: new Date().toISOString() }; else delete flags.careful; }
  return flags;
}

/** Names compared loosely: case, dots and extra spaces do not count. */
const norm = (s: string) => s.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
function editDistance(a: string, b: string) {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) { let prev = d[0]; d[0] = i; for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; } }
  return d[b.length];
}
/** "Ravi", "Ravi Kumar", "K. Ravi Kumar" and "Ravi Kumaar" are the same person on one phone; "Ravi" and "Sita" are a family. */
export function similarName(a: string, b: string) {
  const x = norm(a), y = norm(b); if (!x || !y) return false;
  if (x === y) return true;
  const xs = x.split(' '), ys = y.split(' ');
  const [short, long] = xs.length <= ys.length ? [xs, ys] : [ys, xs];
  if (short.every((w) => w.length > 1 && long.includes(w))) return true;
  return Math.min(x.length, y.length) >= 4 && editDistance(x, y) <= 2;
}

/** History sent with the patient (check-in's first-visit details): only the categories sent replace the stored ones; allergies follow. */
export function withHistory(sentH: any, stored: any, by: string) {
  if (!sentH) return {};
  const clean: any = cleanHistory(sentH);
  const h: any = { ...normHistory(stored), confirmedAt: new Date().toISOString(), confirmedBy: by };
  for (const k of HISTORY_KEYS) if (k in sentH) { if (clean[k]) h[k] = clean[k]; else delete h[k]; } // a category sent empty is cleared
  return { history: h, allergies: allergyText(h) };
}

/** Records that are probably this person already. A warning only: families share phones and names repeat. */
export async function likelyDuplicates(tx: any, t: string, b: { fullName: string; phone?: string | null; ageYears?: number | null; dob?: string | null }, exceptId?: string) {
  const n = norm(b.fullName);
  const rows: any[] = await tx.select({ id: patient.id, patientNo: patient.patientNo, fullName: patient.fullName, phone: patient.phone, ageYears: patient.ageYears, dob: patient.dob, sex: patient.sex }).from(patient)
    .where(and(eq(patient.tenantId, t), isNull(patient.mergedInto), ne(patient.patientNo, 'WALKIN'), or(...(b.phone ? [eq(patient.phone, b.phone)] : []), sql`trim(regexp_replace(lower(${patient.fullName}), '[^a-z]+', ' ', 'g')) = ${n}`))).limit(50);
  return rows.filter((p) => p.id !== exceptId).map((p) => {
    const why = b.phone && p.phone === b.phone && similarName(p.fullName, b.fullName) ? 'same phone, similar name'
      : norm(p.fullName) === n && ((b.dob && p.dob === b.dob) || (b.ageYears != null && p.ageYears === b.ageYears)) ? (b.dob && p.dob === b.dob ? 'same name and date of birth' : 'same name and age') : null;
    return why ? { ...p, why } : null;
  }).filter(Boolean).slice(0, 5);
}

/** Diagnoses are for clinical roles (doctor, junior doctor). Reception, pharmacy and coordinators do not get them. */
export const clinical = (perms: string[]) => can(perms, 'encounter.complete') || can(perms, 'encounter.intake');

export function patientRoutes(app: FastifyInstance) {
  // Search by phone digits, name prefix or patient number. Family members sharing a phone come back as separate rows.
  route(app, 'get', '/patients', 'patient.read', async (req, tx) => {
    const q = String((req.query as any).q ?? '').trim();
    const where = q
      ? and(eq(patient.tenantId, req.ctx.tenantId), or(ilike(patient.fullName, `%${q}%`), ilike(patient.phone, `${q}%`), ilike(patient.patientNo, `%${q}%`)))
      : eq(patient.tenantId, req.ctx.tenantId);
    // The Patients table pages on the server (?page=): filters for last visit and flags, sort by name or newest; it gets { rows, total }.
    // Without ?page= it is the quick search other screens use: the newest 25 matches, as a plain list.
    const pg = z.object({ page: z.coerce.number().int().min(1).optional(), size: z.coerce.number().int().min(1).max(100).default(25), sort: z.enum(['new', 'name', 'name_desc', 'old']).default('new'),
      seen: z.enum(['', 'month', 'quarter', 'year_plus', 'never']).default(''), flag: z.enum(['', 'vip', 'family', 'careful']).default('') }).parse(req.query);
    const conds: any[] = [where, ne(patient.patientNo, 'WALKIN'), isNull(patient.mergedInto)]; // the pharmacy's shared walk-in record is not a patient; a merged duplicate is gone
    const lastVisit = sql`(select max(e.created_at) from encounter e where e.patient_id = ${patient.id} and e.tenant_id = ${patient.tenantId})`;
    if (pg.seen === 'never') conds.push(sql`${lastVisit} is null`);
    if (pg.seen === 'month') conds.push(sql`${lastVisit} >= now() - interval '30 days'`);
    if (pg.seen === 'quarter') conds.push(sql`${lastVisit} >= now() - interval '90 days'`);
    if (pg.seen === 'year_plus') conds.push(sql`${lastVisit} < now() - interval '365 days'`);
    if (pg.flag) conds.push(sql`coalesce(${patient.flags} ->> ${pg.flag}, 'false') not in ('false', 'null')`);
    const order = pg.sort === 'name' ? sql`lower(${patient.fullName}) asc` : pg.sort === 'name_desc' ? sql`lower(${patient.fullName}) desc` : pg.sort === 'old' ? sql`${patient.createdAt} asc` : sql`${patient.createdAt} desc`;
    const paged = pg.page != null;
    const rows = await tx.select().from(patient).where(and(...conds)).orderBy(order).limit(paged ? pg.size : 25).offset(paged ? (pg.page! - 1) * pg.size : 0);
    // Two people with one name are told apart by age, last visit and main problem.
    const encs = rows.length ? await tx.select({ patientId: encounter.patientId, at: encounter.createdAt, data: encounter.data }).from(encounter)
      .where(and(eq(encounter.tenantId, req.ctx.tenantId), inArray(encounter.patientId, rows.map((r) => r.id)))).orderBy(desc(encounter.createdAt)) : [];
    const names = (x: any) => (Array.isArray(x) ? x.map((d) => (typeof d === 'string' ? d : d?.name)).filter(Boolean).join(', ') : '');
    const dx = clinical(req.perms);
    const out = rows.map((p) => { const e = encs.find((x) => x.patientId === p.id); const d: any = e?.data ?? {};
      return { ...p, lastVisitAt: e?.at ?? null, mainProblem: dx ? names(d.assessment?.diagnosis) || names(d.complaint?.chief_complaint) || null : null }; });
    if (!paged) return out;
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(patient).where(and(...conds));
    return { rows: out, total: n };
  });

  // Flags: VIP, Family and friends, Handle carefully (never without a reason). Anyone who edits patients sets them, the desk included.
  route(app, 'patch', '/patients/:id/flags', 'patient.write', async (req, tx) => {
    const id = (req.params as any).id; const t = req.ctx.tenantId;
    const b = FlagsIn.parse(req.body);
    const cur = await tx.select().from(patient).where(and(eq(patient.id, id), eq(patient.tenantId, t))).then((r) => r[0]);
    if (!cur) throw new HttpError(404, 'NOT_FOUND');
    const flags = applyFlags(cur.flags, b, req.ctx.name);
    req.auditBefore = { flags: cur.flags };
    const [row] = await tx.update(patient).set({ flags }).where(and(eq(patient.id, id), eq(patient.tenantId, t))).returning();
    return row;
  });

  route(app, 'post', '/patients', 'patient.write', async (req, tx) => {
    const body = PatientIn.parse(req.body);
    const flagsIn = FlagsIn.optional().parse((req.body as any)?.flags);
    const t = req.ctx.tenantId;
    // Duplicate warning (not a block): same phone and a similar name, or the same name with the same age or date of birth
    if (!(req.query as any).force) {
      const matches = await likelyDuplicates(tx, t, body);
      if (matches.length) throw new HttpError(409, 'POSSIBLE_DUPLICATE', { existing: matches[0], matches });
    }
    const n = await nextNumber(tx, t, 'patient_no', 'tenant');
    const [row] = await tx.insert(patient).values({ ...body, ...withHistory(body.history, {}, req.ctx.name), ...(flagsIn ? { flags: applyFlags({}, flagsIn, req.ctx.name) } : {}), tenantId: t, patientNo: `P${String(n).padStart(5, '0')}` }).returning();
    await emit(tx, req.ctx, 'patient.registered', 'patient', row.id, { patientNo: row.patientNo });
    return row;
  });

  route(app, 'patch', '/patients/:id', 'patient.write', async (req, tx) => {
    // A hidden number (98••• ••345) comes back unchanged from roles that cannot see phones: keep the stored one.
    const raw: any = { ...(req.body as any) }; if (typeof raw.phone === 'string' && raw.phone.includes('•')) delete raw.phone;
    const body = sent(PatientIn.partial().parse(raw), raw);
    const cur = await tx.select().from(patient).where(and(eq(patient.id, (req.params as any).id), eq(patient.tenantId, req.ctx.tenantId))).then((r) => r[0]);
    if (body.guardianId) {
      if (body.guardianId === (req.params as any).id) throw new HttpError(400, 'GUARDIAN_IS_SELF');
      const g = await tx.select({ id: patient.id }).from(patient).where(and(eq(patient.id, body.guardianId), eq(patient.tenantId, req.ctx.tenantId))).then((r) => r[0]);
      if (!g) throw new HttpError(400, 'GUARDIAN_NOT_FOUND');
    }
    if (cur) req.auditBefore = Object.fromEntries(Object.keys(body).map((k) => [k, (cur as any)[k]]));
    const [row] = await tx.update(patient).set({ ...body, ...withHistory(body.history, cur?.history, req.ctx.name) }).where(and(eq(patient.id, (req.params as any).id), eq(patient.tenantId, req.ctx.tenantId))).returning();
    if (!row) throw new HttpError(404, 'NOT_FOUND');
    // asked for no WhatsApp: reminders already planned are not sent either
    if (body.noWhatsapp && !cur?.noWhatsapp) await tx.update(message).set({ status: 'skipped', error: 'patient asked for no WhatsApp messages' }).where(and(eq(message.tenantId, req.ctx.tenantId), eq(message.patientId, row.id), eq(message.status, 'pending')));
    return row;
  });

  /** Likely duplicates of this record, for the owner's merge tool. */
  route(app, 'get', '/patients/:id/duplicates', 'patient.read', async (req, tx) => {
    const id = (req.params as any).id; const t = req.ctx.tenantId;
    const p = await tx.select().from(patient).where(and(eq(patient.id, id), eq(patient.tenantId, t))).then((r) => r[0]);
    if (!p) throw new HttpError(404, 'NOT_FOUND');
    return likelyDuplicates(tx, t, p, id);
  });

  /** Owner only: merge a duplicate into this record. Everything that points at the duplicate (visits, consultations, bills, payments, bookings, sittings, photos…)
   *  moves to the kept record; the duplicate is archived (hidden from lists, kept for the audit). Empty details on the kept record are filled from the duplicate. */
  route(app, 'post', '/patients/:id/merge', 'patient.write', async (req, tx) => {
    if (!req.ctx.roles.includes('owner')) throw new HttpError(403, 'ONLY_OWNER_MERGES');
    const keepId = (req.params as any).id; const t = req.ctx.tenantId;
    const { dropId } = z.object({ dropId: z.string().uuid() }).parse(req.body);
    if (dropId === keepId) throw new HttpError(400, 'SAME_PATIENT');
    const [keep, drop] = await Promise.all([keepId, dropId].map((x) => tx.select().from(patient).where(and(eq(patient.id, x), eq(patient.tenantId, t))).then((r) => r[0])));
    if (!keep || !drop) throw new HttpError(404, 'NOT_FOUND');
    if (keep.mergedInto || drop.mergedInto) throw new HttpError(409, 'ALREADY_MERGED');
    // every table with a patient_id, so a table added later is never left pointing at the archived record; the audit log keeps its history as written
    const res: any = await tx.execute(sql`select table_name from information_schema.columns where table_schema = current_schema() and column_name = 'patient_id' and table_name <> 'audit_log'`);
    const tables: string[] = (res.rows ?? res).map((r: any) => r.table_name); // PGlite gives { rows }, postgres-js an array
    const moved: Record<string, number> = {};
    for (const tb of tables) {
      const r: any = await tx.execute(sql`update ${sql.identifier(tb)} set patient_id = ${keepId} where patient_id = ${dropId} and tenant_id = ${t}`);
      const n = r.affectedRows ?? r.count ?? r.rowCount ?? 0; if (n) moved[tb] = n;
    }
    await tx.update(patient).set({ guardianId: keepId }).where(and(eq(patient.tenantId, t), eq(patient.guardianId, dropId)));
    const fill: any = {};
    for (const k of ['phone', 'sex', 'ageYears', 'dob', 'locality', 'contactLabel', 'language', 'notes'] as const) if ((keep as any)[k] == null && (drop as any)[k] != null) fill[k] = (drop as any)[k];
    // allergies are never dropped: both records' are kept
    const allergies = [keep.allergies, drop.allergies].filter(Boolean).filter((a, i, xs) => xs.indexOf(a) === i).join('; ') || null;
    await tx.update(patient).set({ ...fill, allergies, noWhatsapp: keep.noWhatsapp || drop.noWhatsapp, referralCard: keep.referralCard || drop.referralCard, flags: { ...drop.flags, ...keep.flags }, consents: { ...drop.consents, ...keep.consents } }).where(eq(patient.id, keepId));
    await tx.update(patient).set({ mergedInto: keepId, notes: [drop.notes, `Merged into ${keep.patientNo} by ${req.ctx.name}`].filter(Boolean).join('\n') }).where(eq(patient.id, dropId));
    await writeAudit(tx, req.ctx, { kind: 'change', action: 'patient.merged', summary: `Merged ${drop.patientNo} ${drop.fullName} into ${keep.patientNo} ${keep.fullName}`, entity: 'patients', entityId: keepId, patientId: keepId, before: { kept: keep.patientNo, archived: drop.patientNo }, after: moved });
    req.audited = true;
    return { kept: keepId, archived: dropId, moved };
  });

  // Timeline: what the doctor sees when opening a patient.
  route(app, 'get', '/patients/:id/timeline', 'patient.read', async (req, tx) => {
    const id = (req.params as any).id; const t = req.ctx.tenantId;
    const p = await tx.select().from(patient).where(and(eq(patient.id, id), eq(patient.tenantId, t))).then((r) => r[0]);
    if (!p) throw new HttpError(404, 'NOT_FOUND');
    await auditView(tx, req, id, 'Opened the patient record');
    const visits = await tx.select().from(visit).where(and(eq(visit.patientId, id), eq(visit.tenantId, t))).orderBy(desc(visit.arrivedAt)).limit(20);
    const encounters = await tx.select().from(encounter).where(and(eq(encounter.patientId, id), eq(encounter.tenantId, t))).orderBy(desc(encounter.createdAt)).limit(200);
    const rx = encounters.length
      ? await tx.select().from(prescriptionItem).where(and(eq(prescriptionItem.tenantId, t), sql`${prescriptionItem.encounterId} in ${encounters.map((e) => e.id)}`))
      : [];
    const recs = await tx.select().from(recommendation).where(and(eq(recommendation.patientId, id), eq(recommendation.tenantId, t))).orderBy(desc(recommendation.createdAt));
    const charges = await tx.select().from(charge).where(and(eq(charge.patientId, id), eq(charge.tenantId, t))).orderBy(desc(charge.createdAt));
    const payments = await tx.select().from(payment).where(and(eq(payment.patientId, id), eq(payment.tenantId, t))).orderBy(desc(payment.receivedAt));
    // Sittings, and the visits and sittings the patient did not come to with every call made about them: evidence if progress is ever questioned.
    const sessions = await tx.select({ ps: procedureSession, proc: procedureCatalog.name, doctor: practitioner.name }).from(procedureSession).leftJoin(procedureCatalog, eq(procedureCatalog.id, procedureSession.procedureId)).leftJoin(practitioner, eq(practitioner.id, procedureSession.practitionerId))
      .where(and(eq(procedureSession.patientId, id), eq(procedureSession.tenantId, t))).orderBy(desc(procedureSession.day));
    const noShows = await tx.select({ a: appointment, day: session.day, start: session.startTime }).from(appointment).innerJoin(session, eq(session.id, appointment.sessionId)).where(and(eq(appointment.patientId, id), eq(appointment.tenantId, t), eq(appointment.status, 'no_show'))).orderBy(desc(session.day));
    const calls = await tx.select().from(callback).where(and(eq(callback.patientId, id), eq(callback.tenantId, t))).orderBy(desc(callback.createdAt));
    const missed = [
      ...noShows.map((x) => ({ kind: 'visit' as const, refId: x.a.id, day: x.day, time: x.start, what: 'Missed visit', calls: calls.filter((c) => c.refId === x.a.id) })),
      ...sessions.filter((s) => s.ps.state === 'missed').map((s) => ({ kind: 'sitting' as const, refId: s.ps.id, day: s.ps.day, time: s.ps.startTime, what: `Missed ${s.proc ?? 'procedure'} sitting ${s.ps.sittingNo}`, calls: calls.filter((c) => c.refId === s.ps.id) })),
    ].sort((a, b) => b.day.localeCompare(a.day));
    // what is still owed: a part-paid invoice counts only its balance
    const paidOn = (cid: string) => payments.filter((x) => x.chargeId === cid).reduce((s, x) => s + x.amountPaise, 0);
    const due = charges.filter((c) => c.status === 'due').reduce((s, c) => s + Math.max(0, c.amountPaise - paidOn(c.id)), 0);
    const guardian = p.guardianId ? await tx.select({ id: patient.id, fullName: patient.fullName, patientNo: patient.patientNo, phone: patient.phone }).from(patient).where(and(eq(patient.id, p.guardianId), eq(patient.tenantId, t))).then((r) => r[0] ?? null) : null;
    const sharing = p.phone ? await tx.select({ n: sql<number>`count(*)::int` }).from(patient).where(and(eq(patient.tenantId, t), eq(patient.phone, p.phone), sql`${patient.id} <> ${id}`)).then((r) => r[0]?.n ?? 0) : 0;
    // roles without 'See fees and payments' see no prices, payments or amounts due
    const fees = can(req.perms, 'fees.see');
    return { patient: p, guardian, sharingPhone: sharing, feesHidden: !fees, sessions: sessions.map((s) => ({ ...s.ps, procedure: s.proc, doctor: s.doctor })), missed, visits, encounters: encounters.map((e) => ({ ...e, data: listData(e.data, clinical(req.perms)), prescription: rx.filter((i) => i.encounterId === e.id) })), recommendations: recs, charges: fees ? charges : [], payments: fees ? payments : [], outstandingPaise: fees ? due : 0 };
  });
}
