import type { FastifyInstance } from 'fastify';
import { and, eq, desc } from 'drizzle-orm';
import type { Tx } from '../db/index.js';
import { patient, session, appointment, visit, encounter, prescriptionItem, recommendation, charge, payment, expense, feeCategory, medicine, procedureCatalog, formDefinition, practitioner, branch, room, calendarBlock, procedureSession } from '../db/schema.js';
import { route } from '../lib/route.js';
import { nextNumber, todayIn, addDays } from '../lib/core.js';
import { HttpError } from '../lib/auth.js';

/** Demo data for a dermatology OP day in Rajahmundry. Owner-only; refuses to run twice. */
export function sampleRoutes(app: FastifyInstance) {
  route(app, 'post', '/dev/sample-data', 'config.*', async (req, tx) => loadSample(tx, req.ctx.tenantId, req.ctx.userId, req.ctx.timezone));
  route(app, 'post', '/dev/sample-collections', 'config.*', async (req, tx) => backfillCollections(tx, req.ctx.tenantId, req.ctx.userId, req.ctx.timezone));
}

const PEOPLE: [string, string | null, 'M' | 'F', number, string][] = [
  ['Lakshmi Devi', '9876543210', 'F', 34, 'Danavaipeta'], ['Suresh Kumar', '9848012345', 'M', 42, 'Innespeta'], ['Venkata Ramana', '9440123456', 'M', 58, 'Dowleswaram'],
  ['Padma Priya', '9701234567', 'F', 27, 'Tyagaraja Nagar'], ['Anjali Reddy', '9951234567', 'F', 19, 'Lalacheruvu'], ['Ravi Teja', '8886012345', 'M', 23, 'Morampudi'],
  ['Srinivas Rao', '9490123456', 'M', 47, 'Bommuru'], ['Bhavani', '9490123456', 'F', 44, 'Bommuru'], ['Naga Lakshmi', '9502345678', 'F', 61, 'Jampeta'],
  ['Kiran Kumar', '9000123456', 'M', 31, 'AVA Road'], ['Durga Prasad', '9398123456', 'M', 52, 'Kadiyam'], ['Swapna', '9959123456', 'F', 29, 'Rajanagaram'],
  ['Manikanta', '7993123456', 'M', 16, 'Danavaipeta'], ['Pavani', '9177123456', 'F', 24, 'Innespeta'], ['Harish Babu', '9666123456', 'M', 36, 'Kotipalli Bus Stand'],
  ['Jyothi', '9014123456', 'F', 39, 'Tyagaraja Nagar'], ['Rajesh Varma', '9885123456', 'M', 45, 'Morampudi'], ['Sowmya', '9542123456', 'F', 22, 'Lalacheruvu'],
  ['Mahesh Babu', '9966123456', 'M', 33, 'Dowleswaram'], ['Divya Sree', '8328123456', 'F', 26, 'Jampeta'], ['Satyanarayana', '9704123456', 'M', 67, 'Kadiyam'],
  ['Keerthi', '9959123456', 'F', 7, 'Rajanagaram'], ['Gopal Krishna', '9440987654', 'M', 50, 'AVA Road'], ['Nandini', '9391123456', 'F', 30, 'Bommuru'],
  ['Chandra Sekhar', '9848765432', 'M', 38, 'Innespeta'], ['Aruna Kumari', null, 'F', 55, 'Danavaipeta'],
];

const CASES = [
  { c: 'Pimples on face', dx: 'Acne vulgaris grade 2', sev: 'Moderate', site: ['Face'], morph: ['Papule', 'Pustule', 'Comedone'], rx: ['Adapalene 0.1% gel', 'Clindamycin 1% gel', 'Doxycycline 100 mg', 'Sunscreen SPF 50'], fu: 28, proc: 'Chemical peel' },
  { c: 'Dark patches on cheeks', dx: 'Melasma', sev: 'Moderate', site: ['Face'], morph: ['Hyperpigmentation'], rx: ['Sunscreen SPF 50', 'Moisturiser (ceramide)'], fu: 30, proc: 'Chemical peel' },
  { c: 'Itchy ring-shaped rash in groin', dx: 'Tinea cruris', sev: 'Mild', site: ['Genitals', 'Legs'], morph: ['Plaque', 'Scale'], rx: ['Ketoconazole 2% cream', 'Terbinafine 250 mg', 'Cetirizine 10 mg'], fu: 14 },
  { c: 'Scaly plaques on elbows and knees', dx: 'Psoriasis vulgaris', sev: 'Moderate', site: ['Arms', 'Legs', 'Scalp'], morph: ['Plaque', 'Scale'], rx: ['Mometasone 0.1% cream', 'Moisturiser (ceramide)'], fu: 21 },
  { c: 'Hair fall, round bald patch', dx: 'Alopecia areata', sev: 'Mild', site: ['Scalp'], morph: ['Macule'], rx: ['Mometasone 0.1% cream'], fu: 30, proc: 'Intralesional steroid injection' },
  { c: 'Warts on fingers', dx: 'Verruca vulgaris', sev: 'Mild', site: ['Hands'], morph: ['Papule'], rx: [], fu: 14, proc: 'Cryotherapy (warts)' },
  { c: 'Itchy red rash on arms', dx: 'Atopic dermatitis', sev: 'Moderate', site: ['Arms', 'Neck'], morph: ['Papule', 'Scale', 'Erosion'], rx: ['Mometasone 0.1% cream', 'Cetirizine 10 mg', 'Moisturiser (ceramide)'], fu: 14 },
  { c: 'Sudden hives all over', dx: 'Acute urticaria', sev: 'Moderate', site: ['Generalised'], morph: ['Plaque'], rx: ['Cetirizine 10 mg'], fu: 7 },
  { c: 'White patches on hands', dx: 'Vitiligo', sev: 'Mild', site: ['Hands'], morph: ['Hypopigmentation'], rx: ['Sunscreen SPF 50'], fu: 30 },
  { c: 'Acne scars', dx: 'Post-acne atrophic scars', sev: 'Moderate', site: ['Face'], morph: ['Scar'], rx: ['Sunscreen SPF 50'], fu: 30, proc: 'Fractional CO2 laser (acne scars)' },
  { c: 'Unwanted facial hair', dx: 'Hirsutism', sev: 'Mild', site: ['Face'], morph: [], rx: [], fu: 60, proc: 'Laser hair reduction' },
  { c: 'Thinning hair on crown', dx: 'Androgenetic alopecia', sev: 'Moderate', site: ['Scalp'], morph: [], rx: [], fu: 30, proc: 'PRP (hair)' },
];

/** Demo only: 30 days of plausible daily collections so the Overview chart has a shape. Idempotent. */
export async function backfillCollections(tx: Tx, t: string, userId: string, tz: string) {
  const exists = await tx.select({ id: payment.id }).from(payment).where(and(eq(payment.tenantId, t), eq(payment.reference, 'SAMPLE-HIST'))).limit(1);
  if (exists.length) throw new HttpError(409, 'ALREADY_BACKFILLED');
  const pts = await tx.select({ id: patient.id }).from(patient).where(eq(patient.tenantId, t)).limit(30);
  if (!pts.length) throw new HttpError(400, 'NO_PATIENTS');
  const today = todayIn(tz); const rows: any[] = [];
  for (let back = 1; back <= 29; back++) {
    const day = addDays(today, -back); const dow = new Date(day + 'T00:00:00Z').getUTCDay();
    if (dow === 0) continue; // Sundays closed
    const n = Math.round((dow === 1 || dow === 6 ? 62 : 46) * (0.8 + Math.random() * 0.4) * (back > 20 ? 0.9 : 1));
    for (let i = 0; i < n; i++) {
      const at = new Date(`${day}T${String(10 + (i % 9)).padStart(2, '0')}:${String((i * 7) % 60).padStart(2, '0')}:00+05:30`).toISOString();
      const fee = i % 9 === 0 ? 50000 : i % 6 === 0 ? 20000 : i % 3 === 0 ? 0 : 30000; if (!fee) continue;
      rows.push({ tenantId: t, patientId: pts[i % pts.length].id, amountPaise: fee, method: i % 2 ? 'upi' : 'cash', reference: 'SAMPLE-HIST', receivedBy: userId, receivedAt: at, createdAt: at });
    }
  }
  for (let i = 0; i < rows.length; i += 200) await tx.insert(payment).values(rows.slice(i, i + 200));
  return { payments: rows.length };
}

export async function loadSample(tx: Tx, t: string, userId: string, tz: string) {
  const already = await tx.select({ id: patient.id }).from(patient).where(and(eq(patient.tenantId, t), eq(patient.legacyId, 'SAMPLE'))).limit(1);
  if (already.length) throw new HttpError(409, 'SAMPLE_ALREADY_LOADED');
  const today = todayIn(tz);
  const br = (await tx.select().from(branch).where(eq(branch.tenantId, t)))[0];
  const docs = await tx.select().from(practitioner).where(eq(practitioner.tenantId, t));
  const cats = Object.fromEntries((await tx.select().from(feeCategory).where(eq(feeCategory.tenantId, t))).map((c) => [c.code, c]));
  const meds = Object.fromEntries((await tx.select().from(medicine).where(eq(medicine.tenantId, t))).map((m) => [m.name, m]));
  const procs = Object.fromEntries((await tx.select().from(procedureCatalog).where(eq(procedureCatalog.tenantId, t))).map((p) => [p.name, p]));
  const form = (await tx.select().from(formDefinition).where(and(eq(formDefinition.tenantId, t), eq(formDefinition.key, 'encounter'))).orderBy(desc(formDefinition.version)))[0];
  let sessions = await tx.select().from(session).where(and(eq(session.tenantId, t), eq(session.day, today)));
  if (!sessions.length) {
    const windows = [['10:00', '11:00', 7], ['11:00', '12:00', 7], ['12:00', '13:00', 6], ['14:00', '15:00', 7], ['15:00', '16:00', 7], ['16:00', '17:00', 5], ['19:00', '20:00', 6]] as const;
    sessions = await tx.insert(session).values(windows.map(([s, e, c]) => ({ tenantId: t, branchId: br.id, practitionerId: docs[0].id, day: today, startTime: s, endTime: e, capacity: c }))).returning();
  }
  const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00+05:30`).toISOString();
  const rnd = (n: number) => Math.floor(Math.random() * n);
  const pick = <T,>(a: T[]) => a[rnd(a.length)];

  // 1. Patients
  const pts: any[] = [];
  for (const [name, phone, sex, age, loc] of PEOPLE) {
    const n = await nextNumber(tx, t, 'patient_no', 'tenant');
    const [p] = await tx.insert(patient).values({ tenantId: t, patientNo: `P${String(n).padStart(5, '0')}`, fullName: name, phone, sex, ageYears: age, locality: loc, legacyId: 'SAMPLE',
      referralCard: name === 'Durga Prasad', allergies: name === 'Naga Lakshmi' ? 'Sulpha drugs, penicillin' : name === 'Padma Priya' ? 'Ibuprofen' : null,
      notes: name === 'Satyanarayana' ? 'Diabetic, on metformin. Prefers Telugu.' : null, createdAt: at(addDays(today, -rnd(400) - 1), '10:30') }).returning();
    pts.push(p);
  }

  let visitCount = 0, encCount = 0;
  /** Create a full visit: check-in, charge, payment, optional completed encounter. */
  async function makeVisit(p: any, day: string, time: string, code: string, status: string, kase: typeof CASES[number] | null, opts: { pay?: 'cash' | 'upi'; waive?: string; appt?: string; doctor?: any; draft?: boolean; recs?: boolean; pos?: number } = {}) {
    const cat = cats[code];
    const n = await nextNumber(tx, t, 'op_number', `${br.id}:${day}:${code}`);
    const [{ maxPos }] = await tx.select({ maxPos: visit.queuePosition }).from(visit).where(and(eq(visit.tenantId, t), eq(visit.day, day))).orderBy(desc(visit.queuePosition)).limit(1).then((r) => r.length ? r : [{ maxPos: '0' }]);
    const doctor = opts.doctor ?? docs[0];
    const [v] = await tx.insert(visit).values({ tenantId: t, branchId: br.id, patientId: p.id, appointmentId: opts.appt, practitionerId: doctor.id, feeCategoryId: cat.id, day, opNumber: `${code}-${n}`,
      arrivedAt: at(day, time), createdAt: at(day, time), details: { weight_kg: 45 + rnd(40), locality: p.locality, complaint: kase?.c ?? 'Follow-up' }, status, queuePosition: String(opts.pos ?? Number(maxPos) + 1), priority: cat.priority }).returning();
    visitCount++;
    const [ch] = await tx.insert(charge).values({ tenantId: t, patientId: p.id, visitId: v.id, description: `Consultation (${cat.name})`, amountPaise: cat.amountPaise, createdAt: at(day, time),
      status: opts.waive ? 'waived' : cat.amountPaise === 0 ? 'paid' : opts.pay ? 'paid' : 'due', adjustmentReason: opts.waive ?? null, adjustedBy: opts.waive ? userId : null }).returning();
    if (opts.pay && cat.amountPaise > 0 && !opts.waive) await tx.insert(payment).values({ tenantId: t, patientId: p.id, chargeId: ch.id, amountPaise: cat.amountPaise, method: opts.pay, receivedBy: userId, receivedAt: at(day, time), createdAt: at(day, time) });
    if (kase && (status === 'done' || status === 'in_consult')) {
      const completed = status === 'done' && !opts.draft;
      const [e] = await tx.insert(encounter).values({ tenantId: t, visitId: v.id, patientId: p.id, practitionerId: doctor.id, formDefinitionId: form.id, createdAt: at(day, time),
        data: { complaint: { chief_complaint: [kase.c], duration: pick(['2 weeks', '1 month', '3 months', '6 months', '1 year']), site: kase.site }, exam: { morphology: kase.morph, distribution: pick(['Localised', 'Symmetrical']) }, assessment: completed || opts.draft ? { diagnosis: [{ name: kase.dx, severity: kase.sev }] } : {}, plan: completed ? { advice: 'Sun protection. Avoid scrubbing. Review as advised.' } : {} },
        status: completed ? 'completed' : 'draft', completedAt: completed ? at(day, addMin(time, 12)) : null, provenance: { source: 'typed' } }).returning();
      encCount++;
      if (kase.rx.length) await tx.insert(prescriptionItem).values(kase.rx.map((name, i) => { const m = meds[name]; return { tenantId: t, encounterId: e.id, medicineId: m?.id, name, dose: m?.defaults?.dose, route: m?.defaults?.route, frequency: m?.defaults?.frequency, durationDays: m?.defaults?.durationDays, instructions: m?.defaults?.instructions, sortOrder: i }; }));
      if (completed && opts.recs !== false) {
        const recs: any[] = [{ tenantId: t, encounterId: e.id, patientId: p.id, kind: 'followup', dueOn: addDays(day, kase.fu), status: 'open', createdAt: at(day, time) }];
        if (kase.proc && procs[kase.proc]) recs.push({ tenantId: t, encounterId: e.id, patientId: p.id, kind: 'procedure', procedureId: procs[kase.proc].id, sittings: procs[kase.proc].typicalSittings, dueOn: addDays(day, 7 + rnd(14)), notes: pick(['after 2 weeks of medicines', 'patient keen, discuss cost', 'full face', 'spot treatment only', '']) || null, status: 'open', createdAt: at(day, time) });
        await tx.insert(recommendation).values(recs);
      }
      return { v, e };
    }
    return { v };
  }

  // 2. History: past visits for ~12 patients (some with two visits), spread over the last 4 months
  const history = pts.slice(0, 14);
  for (const [i, p] of history.entries()) {
    const kase = CASES[i % CASES.length];
    const d1 = addDays(today, -(20 + rnd(100)));
    await makeVisit(p, d1, pick(['10:20', '11:05', '12:40', '15:10', '16:30']), 'GEN', 'done', kase, { pay: pick(['cash', 'upi']) });
    if (i % 3 === 0) await makeVisit(p, addDays(d1, 10 + rnd(4)), '11:30', 'REN', 'done', kase, { recs: false });
  }
  // A paid consult 9 days ago → renewal rule applies today
  await makeVisit(pts[14], addDays(today, -9), '10:45', 'GEN', 'done', CASES[2], { pay: 'upi', recs: false });
  // Night/emergency visit last week, special card visit
  await makeVisit(pts[15], addDays(today, -6), '21:15', 'NGT', 'done', CASES[7], { pay: 'cash', recs: false });
  await makeVisit(pts[10], addDays(today, -30), '12:10', 'SPL', 'done', CASES[3], { pay: 'cash' });

  // Resolve some old worklist items so lists look lived-in
  const oldRecs = await tx.select().from(recommendation).where(and(eq(recommendation.tenantId, t), eq(recommendation.kind, 'procedure')));
  for (const [i, r] of oldRecs.entries()) {
    if (i % 4 === 0) await tx.update(recommendation).set({ status: 'scheduled', contactLog: [{ at: at(addDays(today, -3), '11:00'), by: 'Sunita (Procedures)', outcome: 'Will come', note: 'confirmed Monday 11 am' }] }).where(eq(recommendation.id, r.id));
    else if (i % 4 === 1) await tx.update(recommendation).set({ status: 'contacted', contactLog: [{ at: at(addDays(today, -5), '16:20'), by: 'Sunita (Procedures)', outcome: 'No answer' }, { at: at(addDays(today, -2), '10:05'), by: 'Sunita (Procedures)', outcome: 'Wants another date', note: 'after Diwali' }] }).where(eq(recommendation.id, r.id));
    else if (i % 4 === 2) await tx.update(recommendation).set({ status: 'done' }).where(eq(recommendation.id, r.id));
  }
  const oldFu = await tx.select().from(recommendation).where(and(eq(recommendation.tenantId, t), eq(recommendation.kind, 'followup')));
  for (const [i, r] of oldFu.entries()) if (i % 2 === 0) await tx.update(recommendation).set({ status: 'done' }).where(eq(recommendation.id, r.id));

  // 3. Today: bookings across windows, then arrivals in mixed states
  const bookList = pts.slice(2, 22);
  const appts: any[] = [];
  for (const [i, p] of bookList.entries()) {
    const s = sessions[Math.min(Math.floor(i / 3), sessions.length - 1)];
    const [a] = await tx.insert(appointment).values({ tenantId: t, patientId: p.id, sessionId: s.id, source: i % 7 === 0 ? 'walk_in' : 'phone', note: i === 4 ? 'asked for main doctor' : i === 9 ? 'coming from Kadiyam, may be late' : null, createdAt: at(today, `0${7 + (i % 3)}:${String(10 + i * 2).padStart(2, '0')}`) }).returning();
    appts.push(a);
  }
  const arrived = async (idx: number, time: string, code: string, status: string, kase: any, opts: any = {}) => {
    const p = bookList[idx]; const a = appts[idx];
    await tx.update(appointment).set({ status: 'arrived' }).where(eq(appointment.id, a.id));
    return makeVisit(p, today, time, code, status, kase, { appt: a.id, ...opts });
  };
  await arrived(0, '09:35', 'GEN', 'done', CASES[0], { pay: 'upi' });
  await arrived(1, '09:41', 'GEN', 'done', CASES[9], { pay: 'cash' });
  await arrived(2, '09:52', 'REN', 'done', CASES[2]);
  await arrived(3, '10:04', 'GEN', 'done', CASES[4], { pay: 'cash', doctor: docs[1] ?? docs[0] });
  await arrived(4, '10:11', 'GEN', 'in_consult', CASES[5], { pay: 'upi' });
  await arrived(5, '10:16', 'GEN', 'waiting', CASES[6], { pay: 'cash' });
  await arrived(6, '10:22', 'SPL', 'waiting', CASES[3], { pay: 'cash' });
  await arrived(7, '10:25', 'GEN', 'intake', CASES[1], { pay: 'upi' });
  await arrived(8, '10:31', 'GEN', 'waiting', CASES[7], { waive: 'known person · doctor instructed' });
  // walk-in with the emergency card, no booking
  await makeVisit(pts[24], today, '10:33', 'NGT', 'waiting', CASES[7], { pay: 'upi' });
  // one no-show from the first window
  await tx.update(appointment).set({ status: 'no_show' }).where(eq(appointment.id, appts[9].id));

  // 4. Tomorrow: a few bookings so the calendar has a future
  const tomorrow = addDays(today, 1);
  let tmSessions = await tx.select().from(session).where(and(eq(session.tenantId, t), eq(session.day, tomorrow)));
  if (!tmSessions.length) tmSessions = await tx.insert(session).values(sessions.map(({ id, createdAt, ...s }) => ({ ...s, day: tomorrow }))).returning();
  await tx.insert(appointment).values(pts.slice(20, 25).map((p, i) => ({ tenantId: t, patientId: p.id, sessionId: tmSessions[i % 2].id, source: 'phone' })));

  // 4b. Doctor's day: lunch break, and two procedures scheduled in rooms (one on the main doctor, which lowers OP capacity 12–13)
  await tx.insert(calendarBlock).values({ tenantId: t, practitionerId: docs[0].id, day: today, startTime: '13:00', endTime: '14:00', kind: 'break', note: 'Lunch' });
  const rooms = await tx.select().from(room).where(eq(room.tenantId, t));
  const laserRoom = rooms.find((r) => r.capabilities.includes('laser')) ?? rooms[0]; const procRoom = rooms.find((r) => r.id !== laserRoom?.id) ?? rooms[0];
  const schedRecs = await tx.select().from(recommendation).where(and(eq(recommendation.tenantId, t), eq(recommendation.kind, 'procedure'), eq(recommendation.status, 'scheduled'))).limit(2);
  const plan = [{ start: '12:15', end: '13:00', room: laserRoom, doc: docs[0] }, { start: '15:00', end: '15:45', room: procRoom, doc: docs[1] ?? docs[0] }];
  for (const [i, r] of schedRecs.entries()) {
    const pz = plan[i]; if (!pz?.room) continue;
    const pr = r.procedureId ? procs[Object.keys(procs).find((k) => procs[k].id === r.procedureId)!] : null;
    const [ps] = await tx.insert(procedureSession).values({ tenantId: t, recommendationId: r.id, patientId: r.patientId, procedureId: r.procedureId, practitionerId: pz.doc.id, roomId: pz.room.id, sittingNo: 1, day: today, startTime: pz.start, endTime: pz.end, state: i === 0 ? 'confirmed' : 'confirmed', notes: r.notes }).returning();
    await tx.insert(calendarBlock).values({ tenantId: t, practitionerId: pz.doc.id, roomId: pz.room.id, day: today, startTime: pz.start, endTime: pz.end, kind: 'procedure', note: `${pr?.name ?? 'Procedure'} · sitting 1`, procedureSessionId: ps.id });
    await tx.update(recommendation).set({ dueOn: today }).where(eq(recommendation.id, r.id));
  }

  // 5. Expenses for today and yesterday
  await tx.insert(expense).values([
    { tenantId: t, day: today, description: 'Water cans (4)', amountPaise: 16000, method: 'cash', enteredBy: userId },
    { tenantId: t, day: today, description: 'Cleaning staff', amountPaise: 50000, method: 'cash', enteredBy: userId },
    { tenantId: t, day: addDays(today, -1), description: 'Electricity bill', amountPaise: 684000, method: 'upi', enteredBy: userId },
    { tenantId: t, day: addDays(today, -1), description: 'Printer paper & toner', amountPaise: 230000, method: 'cash', enteredBy: userId },
  ]);

  await backfillCollections(tx, t, userId, tz);
  return { patients: pts.length, visits: visitCount, encounters: encCount, appointmentsToday: appts.length };
}

function addMin(hhmm: string, min: number) { const [h, m] = hhmm.split(':').map(Number); const x = h * 60 + m + min; return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; }
