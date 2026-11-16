import { deflateSync } from 'node:zlib';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../db/index.js';
import { patient, appointment, session, service, practitioner, recommendation, procedureSession, procedureCatalog, room, calendarBlock, document, tenant, OPEN_STATUSES, branch, feeCategory, visit, encounter, prescriptionItem, charge, payment, expense, medicine, formDefinition, pharmacySale, stockBatch, stockDoc, vendor, rxTemplate, type FormSchema } from '../db/schema.js';
import { todayIn, addDays, nextNumber } from '../lib/core.js';
import { HttpError } from '../lib/auth.js';
import { newToken, queueMessage, planReminders } from '../lib/booking.js';
import { putFile } from '../lib/storage.js';
import { windowsForDay } from './scheduling.js';
import { recordSale, prescribedQty } from './pharmacy.js';
import { receiveStock, schemeFree, type Actor } from './stock.js';

/**
 * Test data for the booking and photo features, on top of the base sample (patients, visits, today's queue):
 * one week of everything (today-6 to today+6): bookings across every doctor with visit types and statuses,
 * repeat series, queued patient messages, and two procedure courses with sittings and before/after photos.
 * Run it again to top up: bookings only fill windows below their target; the one-off parts (series, courses, photos) are made once.
 */
const MARKER = 'sample-bookings-marker';

/** One course per procedure. values: what this patient's form says where the generic filler would guess (areas, the agent, the indication). */
type Course = { name: string; area: string; sittings: number; gap: number; start: string; photos?: boolean; values: Record<string, unknown> };
const COURSES: Course[] = [
  { name: 'Laser hair reduction', area: 'Chin', sittings: 8, gap: 28, start: '11:00', photos: true, values: { areas: ['Chin', 'Upper lip'], machine: 'Diode 808 nm', hair_colour: 'Black', hair_thickness: 'Coarse', skin_type: 'IV', cooling: 'Contact cooling', reaction: ['Expected (perifollicular oedema)'] } },
  { name: 'Chemical peel', area: 'Cheeks', sittings: 6, gap: 14, start: '15:30', photos: true, values: { indication: ['Acne marks', 'Melasma'], skin_type: 'IV', skin_nature: 'Oily', priming_with: 'Glycolic acid 6% cream at night', agent: 'Glycolic acid', areas: ['Cheeks', 'Forehead'], reaction: ['None'] } },
  { name: 'Fractional CO2 laser (acne scars)', area: 'Cheeks', sittings: 4, gap: 30, start: '12:00', photos: true, values: { indication: 'Atrophic acne scars', area: 'Both cheeks' } },
  { name: 'PRP (hair)', area: 'Crown', sittings: 6, gap: 30, start: '16:30', photos: true, values: { indication: 'Androgenetic alopecia', area: 'Crown and vertex', technique: 'Microneedling + PRP' } },
  { name: 'Cryotherapy (warts)', area: 'Fingers', sittings: 4, gap: 14, start: '10:30', values: { indication: 'Common warts', area: 'Right index and middle finger' } },
  { name: 'Intralesional steroid injection', area: 'Scalp', sittings: 4, gap: 28, start: '12:30', values: { indication: 'Alopecia areata', area: 'Two patches, occiput', drug: 'Triamcinolone acetonide' } },
  { name: 'Hydrafacial', area: 'Face', sittings: 4, gap: 30, start: '17:00', values: { indication: 'Dull skin', area: 'Full face', serum: 'Brightening', steps: ['Cleanse', 'Peel', 'Extract', 'Hydrate'] } },
  { name: 'Excision biopsy', area: 'Back', sittings: 1, gap: 10, start: '12:00', values: { indication: 'Changing mole', area: 'Upper back', site: 'Upper back, left of spine', sample_sent: true } },
];

/** Plausible numbers for a session's settings; some rise a little each session, as they do in practice. */
const NUMBERS: Record<string, (k: number) => number> = {
  fluence: (k) => 12 + 2 * k, pulse_width: () => 30, spot_size: () => 12, frequency: () => 2, passes: () => 2, shots: (k) => 380 + 20 * k,
  strength: (k) => 20 + 10 * Math.min(k, 3), layers: () => 1, contact_time: (k) => 2 + k,
  energy: (k) => 35 + 5 * k, density: () => 10, concentration: () => 10, volume: () => 0.6, lesions: () => 2,
  warts: (k) => Math.max(1, 5 - k), freeze_time: () => 10, cycles: () => 2, blood_drawn: () => 20, prp_volume: () => 4, size: () => 6, sutures: () => 3,
};
const NOT_TRUE = new Set(['recent_tan', 'photosensitive_meds', 'isotretinoin_6m', 'active_lesions', 'pregnant']); // safety checks: "no" is the normal answer
const PROGRESS: Record<string, string[]> = { hair_reduction: ['Under 25%', 'Under 25%', '25–50%', '50–75%'], response: ['No change', 'Slight', 'Good', 'Very good'] };

/** A completed session's form as a careful doctor would fill it: every field answered, settings carried from session to session. */
function fillProcForm(schema: FormSchema, given: Record<string, unknown>, k: number, next: string | null, note: string) {
  const out: Record<string, unknown> = {};
  for (const fld of schema.sections.flatMap((s) => s.fields)) {
    const opts = fld.options ?? [];
    if (fld.key in given) out[fld.key] = given[fld.key];
    else if (fld.key === 'next_session') { if (next) out[fld.key] = next; }
    else if (fld.key === 'notes') out[fld.key] = note;
    else if (PROGRESS[fld.key]) out[fld.key] = PROGRESS[fld.key][Math.min(k, 3)];
    else if (fld.type === 'checkbox') out[fld.key] = !NOT_TRUE.has(fld.key);
    else if (fld.type === 'number') out[fld.key] = (NUMBERS[fld.key] ?? (() => 1))(k);
    else if (/pain|burning/.test(fld.key) && opts.length) out[fld.key] = String(2 + (k % 3));
    else if (fld.type === 'multiselect') out[fld.key] = opts.slice(0, 1);
    else if (opts.length) out[fld.key] = opts.find((o) => /^(none|mild|erythema|done, no reaction)$/i.test(o)) ?? opts[Math.min(1, opts.length - 1)];
    else if (fld.type === 'text') out[fld.key] = 'As before';
  }
  return out;
}

/** The sample's deliberately low (Terbinafine) and expiring (Sunscreen) items: no sample sale touches them, so the Stock page always shows both cases. */
const KEEP_STOCK = /^(Terbinafine|Sunscreen SPF|Permethrin|Calamine)/; // + the demo pack's low (Permethrin) and expiring (Calamine) items
export async function loadBookingSample(tx: Tx, t: string, userId: string, tz: string, origin: string) {
  const first = !(await tx.select({ id: appointment.id }).from(appointment).where(and(eq(appointment.tenantId, t), eq(appointment.idempotencyKey, MARKER))).limit(1)).length;
  const ten = (await tx.select().from(tenant).where(eq(tenant.id, t)))[0];
  const pts = await tx.select().from(patient).where(and(eq(patient.tenantId, t), eq(patient.legacyId, 'SAMPLE')));
  if (pts.length < 10) throw new HttpError(400, 'LOAD_BASE_SAMPLE_FIRST');
  const docs = await tx.select().from(practitioner).where(and(eq(practitioner.tenantId, t), eq(practitioner.active, true)));
  const svcs = await tx.select().from(service).where(and(eq(service.tenantId, t), eq(service.active, true)));
  const today = todayIn(tz);
  let seed = 7; const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; }; // repeatable
  const svcFor = (docId: string | null) => { const ok = svcs.filter((s) => !s.practitionerIds.length || (docId && s.practitionerIds.includes(docId))); return ok.length ? ok[rnd(ok.length)] : null; };
  const NOTES = [null, null, null, 'asked for the main doctor', 'coming from Kadiyam, may be late', 'review of lab reports', 'brings old prescription', null];
  const counts = { booked: 0, confirmed: 0, arrived: 0, no_show: 0, cancelled: 0, series: 0, messages: 0, sittings: 0, photos: 0, visits: 0, pharmacyBills: 0, counterSales: 0, stockReceipts: 0, expenses: 0 };
  const made: string[] = [];
  /** First window with room on the day or the next working days (no doctor works on Sunday). */
  const nextWindow = async (day: string, docId: string) => { for (let i = 0; i < 7; i++) { const w = (await windowsForDay(tx, t, addDays(day, i), docId)).find((x) => x.free > 0); if (w) return w; } return null; };

  // 1. Bookings for every doctor on every working day, from six days ago to six days ahead (today only gets the windows still ahead).
  // Each window has a fixed target, so running this again only tops up quiet windows.
  const from = addDays(today, -6);
  const to = addDays(today, 6);
  const nowHM = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  const hash = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };
  for (let day = from; day <= to; day = addDays(day, 1)) {
    const off = Math.round((Date.parse(day + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000);
    const have = new Map((await tx.select({ id: appointment.sessionId, n: sql<number>`count(*)::int` }).from(appointment).innerJoin(session, eq(session.id, appointment.sessionId))
      .where(and(eq(appointment.tenantId, t), eq(session.day, day))).groupBy(appointment.sessionId)).map((r) => [r.id, r.n] as const));
    for (const d of docs) {
      for (const w of await windowsForDay(tx, t, day, d.id)) {
        if (off === 0 && w.startTime <= nowHM) continue;
        const ratio = off < 0 ? 0.7 : off === 0 ? 0.6 : off === 1 ? 0.8 : 0.6;
        const target = Math.round(w.effectiveCapacity * ratio * (0.6 + (hash(w.id) % 60) / 100));
        const fill = Math.min(Math.max(0, target - (have.get(w.id) ?? 0)), Math.max(0, w.effectiveCapacity - w.allocated));
        const used = new Set<string>(); const rows: (typeof appointment.$inferInsert)[] = [];
        for (let i = 0; i < fill; i++) {
          let p = pts[rnd(pts.length)]; for (let k = 0; k < 5 && used.has(p.id); k++) p = pts[rnd(pts.length)];
          if (used.has(p.id)) continue; used.add(p.id);
          const roll = rnd(100);
          const status = off < 0 ? (roll < 78 ? 'arrived' : roll < 90 ? 'no_show' : 'cancelled') : (roll < 55 ? 'booked' : roll < 92 ? 'confirmed' : 'cancelled');
          const svc = svcFor(d.id);
          rows.push({ tenantId: t, patientId: p.id, sessionId: w.id, serviceId: svc?.id ?? null, status, source: rnd(10) === 0 ? 'walk_in' : 'phone',
            note: NOTES[rnd(NOTES.length)], publicToken: newToken(), confirmedAt: status === 'confirmed' ? new Date().toISOString() : null,
            cancelReason: status === 'cancelled' ? ['patient travelling', 'feeling better', 'exam at college'][rnd(3)] : null });
        }
        if (!rows.length) continue;
        for (const a of await tx.insert(appointment).values(rows).returning({ id: appointment.id, status: appointment.status })) {
          counts[a.status as keyof typeof counts]++;
          if (off > 0 && a.status !== 'cancelled') made.push(a.id);
        }
      }
    }
  }

  // The rest is set up once: repeat series, messages, procedure courses with photos, online booking switched on.
  if (first) {
  // 3. Repeat series: two patients every two weeks, four visits each
  const review = svcs.find((s) => /review/i.test(s.name)) ?? svcs[0];
  for (const [i, p] of [pts[1], pts[6]].entries()) {
    const d = docs[i % docs.length]; let seriesId: string | null = null;
    for (let k = 0; k < 4; k++) {
      const day = addDays(today, 2 + i + k * 14);
      const w = await nextWindow(day, d.id); if (!w) continue;
      const [a]: { id: string }[] = await tx.insert(appointment).values({ tenantId: t, patientId: p.id, sessionId: w.id, serviceId: review?.id ?? null, status: 'booked', source: k ? 'repeat' : 'phone', seriesId, publicToken: newToken() }).returning({ id: appointment.id });
      if (!seriesId) { seriesId = a.id; await tx.update(appointment).set({ seriesId }).where(eq(appointment.id, a.id)); }
      counts.series++;
    }
  }

  // 4. Patient messages for the next bookings: confirmations and planned reminders, as if booked through the app
  for (const id of made.slice(0, 15)) { await queueMessage(tx, t, id, 'confirmation', origin); await planReminders(tx, t, id, origin); counts.messages++; }

  // 5. A procedure course for every procedure that has a plan: past sessions with the procedure form filled in, the next one booked; photos on four of them
  const procs = await tx.select().from(procedureCatalog).where(eq(procedureCatalog.tenantId, t));
  const rooms = await tx.select().from(room).where(eq(room.tenantId, t));
  for (const [ci, c] of COURSES.entries()) {
    const proc = procs.find((p) => p.name === c.name); if (!proc) continue;
    const rec = (await tx.select().from(recommendation).where(and(eq(recommendation.tenantId, t), eq(recommendation.kind, 'procedure'), eq(recommendation.procedureId, proc.id))).limit(1))[0];
    if (!rec) continue;
    const p = pts.find((x) => x.id === rec.patientId)!;
    const form = (await tx.select().from(formDefinition).where(and(eq(formDefinition.tenantId, t), eq(formDefinition.key, `procedure:${proc.id}`))).orderBy(sql`version desc`).limit(1))[0];
    if (c.photos) await tx.update(patient).set({ consents: { ...(p.consents ?? {}), photos: { grantedAt: new Date(Date.now() - 100 * 86400000).toISOString(), by: 'Dr. Main Doctor' } } }).where(eq(patient.id, p.id));
    await tx.update(recommendation).set({ status: 'scheduled', sittings: c.sittings, dueOn: addDays(today, 7 + ci) }).where(eq(recommendation.id, rec.id));
    const rm = rooms.find((r) => proc.requiredCapability && r.capabilities.includes(proc.requiredCapability)) ?? rooms[0];
    const doc = proc.requiresMainDoctor ? docs[0] : docs[ci % docs.length];
    // baseline photos at the consultation, up to three done sessions, then the next one booked (when the course has more)
    const done = Math.min(3, c.sittings);
    const plan = [-(c.gap * done + 7), ...Array.from({ length: done }, (_, k) => -c.gap * (done - k)), ...(c.sittings > done ? [7 + ci] : [])];
    for (const [k, off] of plan.entries()) {
      const day = addDays(today, off); const sittingNo = k; // 0 = before the course
      let psId: string | null = null;
      if (k > 0) {
        const [h, m] = c.start.split(':').map(Number); const endMin = h * 60 + m + proc.typicalMinutes;
        const end = `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`;
        const note = off < 0 ? ['Tolerated well', 'Mild redness, settled in 10 minutes', 'Good response, patient happy'][(k - 1) % 3] : null;
        const next = plan[k + 1] !== undefined ? addDays(today, plan[k + 1]) : null;
        const filled = off < 0 && form ? fillProcForm(form.schema as FormSchema, c.values, k, next, note!) : null;
        const [ps] = await tx.insert(procedureSession).values({ tenantId: t, recommendationId: rec.id, patientId: p.id, procedureId: proc.id, practitionerId: doc.id, roomId: rm?.id ?? null, sittingNo,
          day, startTime: c.start, endTime: end, state: off < 0 ? 'completed' : 'confirmed', notes: note, outcome: filled, formDefinitionId: filled ? form!.id : null }).returning();
        if (off >= 0) await tx.insert(calendarBlock).values({ tenantId: t, practitionerId: doc.id, roomId: rm?.id ?? null, day, startTime: c.start, endTime: end, kind: 'procedure', note: `${proc.name} · session ${sittingNo}`, procedureSessionId: ps.id });
        psId = ps.id; counts.sittings++;
      }
      if (off >= 0 || !c.photos) continue;
      for (const view of ['front', 'left'] as const) {
        const png = samplePhoto(ci, k, view);
        const [d] = await tx.insert(document).values({ tenantId: t, patientId: p.id, kind: 'photo', title: `${c.area} · ${view === 'front' ? 'Front' : 'Left'} · sample`, mime: 'image/png', sizeBytes: png.length,
          storageKey: 'pending', uploadedBy: userId, area: c.area, view, procedureSessionId: psId, takenAt: new Date(`${day}T${c.start}:00+05:30`).toISOString(), note: k === 0 ? 'before the course' : null }).returning();
        const key = `${t}/${p.id}/${d.id}.png`;
        await putFile(key, png, 'image/png');
        await tx.update(document).set({ storageKey: key }).where(eq(document.id, d.id));
        counts.photos++;
      }
    }
  }

  // marker so a second run is refused (a cancelled booking that holds no place)
  const anyWindow = (await windowsForDay(tx, t, addDays(today, 1)))[0];
  if (anyWindow) await tx.insert(appointment).values({ tenantId: t, patientId: pts[0].id, sessionId: anyWindow.id, status: 'cancelled', source: 'phone', cancelReason: 'test data marker', idempotencyKey: MARKER });
  } // end of the one-off parts
  await loadWeek(tx, t, userId, tz, today, counts);
  const open = await tx.select({ id: appointment.id }).from(appointment).where(and(eq(appointment.tenantId, t), inArray(appointment.status, [...OPEN_STATUSES])));
  return { ...counts, topUp: !first, from, to, openBookings: open.length };
}

/* ---------- Generated "skin" photos: a warm tone with dark spots that fade over the sittings, so before/after shows a change ---------- */
function samplePhoto(course: number, sitting: number, view: 'front' | 'left') {
  const W = 480, H = 480;
  const base = course === 0 ? [201, 154, 124] : [214, 171, 144];
  const shade = view === 'left' ? -14 : 0;
  const spots = Math.max(4, 40 - sitting * 11); // fewer, lighter spots each sitting
  let s = 1000 + course * 97 + (view === 'left' ? 31 : 0); const r = (n: number) => { s = (s * 16807) % 2147483647; return s % n; };
  const marks = Array.from({ length: spots }, () => ({ x: 80 + r(320), y: 120 + r(260), rad: 5 + r(9), k: 0.35 - sitting * 0.07 }));
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;
    for (let x = 0; x < W; x++) {
      const dx = (x - W / 2) / (W * 0.42), dy = (y - H * 0.48) / (H * 0.5);
      const face = Math.max(0, 1 - (dx * dx + dy * dy)); // soft oval, darker towards the edges
      let dark = 0.55 + 0.45 * Math.sqrt(face);
      for (const m of marks) { const d2 = (x - m.x) ** 2 + (y - m.y) ** 2; if (d2 < m.rad * m.rad) dark -= Math.max(0, m.k) * (1 - d2 / (m.rad * m.rad)); }
      const o = y * (W * 3 + 1) + 1 + x * 3;
      for (let c = 0; c < 3; c++) raw[o + c] = Math.max(0, Math.min(255, Math.round((base[c] + shade) * dark)));
    }
  }
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
let CRC_TABLE: number[] | null = null;
function crc32(buf: Buffer) {
  if (!CRC_TABLE) CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0;
}

/**
 * The week's other records, so every screen has something in it: visits for past arrivals (with a note and prescription),
 * pharmacy bills for their prescriptions, counter sales, expenses. Each day is checked first, so running again adds nothing twice.
 */
async function loadWeek(tx: Tx, t: string, userId: string, tz: string, today: string, counts: Record<string, number>) {
  const br = (await tx.select().from(branch).where(eq(branch.tenantId, t)))[0];
  const gen = (await tx.select().from(feeCategory).where(and(eq(feeCategory.tenantId, t), eq(feeCategory.code, 'GEN'))))[0];
  const form = (await tx.select().from(formDefinition).where(and(eq(formDefinition.tenantId, t), eq(formDefinition.key, 'encounter'))).orderBy(sql`version desc`))[0];
  const meds = await tx.select().from(medicine).where(eq(medicine.tenantId, t));
  const pts = await tx.select().from(patient).where(and(eq(patient.tenantId, t), eq(patient.legacyId, 'SAMPLE')));
  if (!br || !gen || !form || !meds.length || !pts.length) return;
  let seed = 11; const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00+05:30`).toISOString();
  const sampleActor = { tenantId: t, userId, name: 'Test data' };
  await loadStock(tx, sampleActor, today, meds, counts);
  const hm = (i: number, base = 10) => `${String(base + Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 14 + 3).padStart(2, '0')}`;
  // Each note is written from one of the clinic's prescription templates, in turn, so every template and its medicines show up in the records and the pharmacy.
  const templates = (await tx.select().from(rxTemplate).where(eq(rxTemplate.tenantId, t)).orderBy(rxTemplate.name)).filter((x) => x.prescription.length);
  let tn = 0;

  for (let day = addDays(today, -6); day <= today; day = addDays(day, 1)) {
    const past = day < today;
    // A. past arrivals (and a handful of today's patients, so the doctor's list and the pharmacy have something) get a visit, paid fee and a completed note with a prescription
    {
      const arrived = await tx.select({ id: appointment.id, patientId: appointment.patientId, doctor: session.practitionerId, st: session.startTime }).from(appointment).innerJoin(session, eq(session.id, appointment.sessionId))
        .where(and(eq(appointment.tenantId, t), eq(session.day, day), inArray(appointment.status, past ? ['arrived'] : ['booked', 'confirmed', 'arrived']), sql`not exists (select 1 from visit v where v.appointment_id = ${appointment.id})`)).limit(past ? 14 : 6);
      for (const [i, a] of arrived.entries()) {
        const n = await nextNumber(tx, t, 'op_number', `${br.id}:${day}:GEN`);
        const time = past && a.st > '09:00' ? a.st : hm(i);
        if (!past) await tx.update(appointment).set({ status: 'arrived' }).where(eq(appointment.id, a.id));
        const [v] = await tx.insert(visit).values({ tenantId: t, branchId: br.id, patientId: a.patientId, appointmentId: a.id, practitionerId: a.doctor, feeCategoryId: gen.id, day, opNumber: `GEN-${n}`, arrivedAt: at(day, time), createdAt: at(day, time),
          details: { complaint: 'Follow-up' }, status: 'done', queuePosition: String(n) }).returning({ id: visit.id });
        const [ch] = await tx.insert(charge).values({ tenantId: t, patientId: a.patientId, visitId: v.id, description: `Consultation (${gen.name})`, amountPaise: gen.amountPaise, status: 'paid', createdAt: at(day, time) }).returning({ id: charge.id });
        if (gen.amountPaise > 0) await tx.insert(payment).values({ tenantId: t, patientId: a.patientId, chargeId: ch.id, amountPaise: gen.amountPaise, method: i % 2 ? 'upi' : 'cash', receivedBy: userId, receivedAt: at(day, time), createdAt: at(day, time) });
        const tp = templates.length ? templates[tn++ % templates.length] : null;
        const [e] = await tx.insert(encounter).values({ tenantId: t, visitId: v.id, patientId: a.patientId, practitionerId: a.doctor, formDefinitionId: form.id, createdAt: at(day, time),
          data: tp ? { ...tp.data, complaint: { ...(tp.data.complaint ?? {}), duration: ['2 weeks', '1 month', '3 months', '6 months'][rnd(4)] } } : { complaint: { chief_complaint: ['Follow-up'] }, plan: { advice: 'Review as advised.' } }, status: 'completed', completedAt: at(day, hm(i + 2)), provenance: { source: 'typed' } }).returning({ id: encounter.id });
        const lines = tp ? tp.prescription.filter((x: any) => meds.some((m) => m.id === x.medicineId)) : [];
        if (lines.length) await tx.insert(prescriptionItem).values(lines.map((x: any, k: number) => ({ tenantId: t, encounterId: e.id, medicineId: x.medicineId, name: x.name, dose: x.dose ?? null, route: x.route ?? null, frequency: x.frequency ?? null, durationDays: x.durationDays ?? null, instructions: x.instructions ?? null, sortOrder: k })));
        if (tp) await tx.update(rxTemplate).set({ uses: sql`${rxTemplate.uses} + 1` }).where(eq(rxTemplate.id, tp.id));
        counts.visits++;
      }
    }

    // B. the counter for the day's prescriptions, issued from stock: most in full, some short (a balance to collect), some lines skipped,
    //    a few bought nothing. Past days only; today's stay for the pharmacist to try.
    const rx = !past ? [] : await tx.select({ enc: encounter.id, patientId: encounter.patientId }).from(encounter).innerJoin(visit, eq(visit.id, encounter.visitId))
      .where(and(eq(encounter.tenantId, t), eq(visit.day, day), eq(encounter.status, 'completed'), sql`exists (select 1 from prescription_item pi where pi.encounter_id = ${encounter.id})`,
        sql`not exists (select 1 from pharmacy_sale s where s.encounter_id = ${encounter.id})`, sql`not exists (select 1 from prescription_item pi where pi.encounter_id = ${encounter.id} and pi.not_issued_reason is not null)`));
    for (const [i, r] of rx.entries()) {
      const h = parseInt(r.enc.slice(-2), 16); // from the id, so a second run picks the same ones
      const its = await tx.select({ i: prescriptionItem, m: medicine }).from(prescriptionItem).innerJoin(medicine, eq(medicine.id, prescriptionItem.medicineId)).where(eq(prescriptionItem.encounterId, r.enc));
      if (h % 7 === 6) { await tx.update(prescriptionItem).set({ notIssuedReason: 'Bought nothing' }).where(eq(prescriptionItem.encounterId, r.enc)); continue; }
      const items: any[] = []; const notIssued: any[] = [];
      for (const [k, x] of its.entries()) {
        const want = prescribedQty(x.i, x.m);
        if (KEEP_STOCK.test(x.m.name)) { notIssued.push({ prescriptionItemId: x.i.id, reason: 'Will buy later' }); continue; } // the demo's low and expiring items stay as set up
        if (k === 1 && h % 4 === 1) { notIssued.push({ prescriptionItemId: x.i.id, reason: (['Has at home', 'Will buy later', 'Bought outside'] as const)[h % 3] }); continue; }
        const qty = h % 5 === 2 && want > 1 ? 1 : want;
        if (qty < want) notIssued.push({ prescriptionItemId: x.i.id, reason: 'Will buy later' });
        items.push({ medicineId: x.m.id, qty, prescriptionItemId: x.i.id });
      }
      if (!items.length) continue;
      const method = (['cash', 'upi', 'card'] as const)[rnd(3)];
      try {
        await recordSale(tx, sampleActor, { patientId: r.patientId, encounterId: r.enc, items, notIssued, discountPaise: 0, method, reference: method === 'cash' ? undefined : `${method === 'upi' ? 'UPI' : 'CARD'}${String(100000 + rnd(900000))}`, whatsapp: false, at: at(day, hm(i + 4)) });
        counts.pharmacyBills++;
      } catch { /* out of stock in the sample: leave it for the counter */ }
    }

    // C. counter sales without a prescription: real invoices from catalogue prices, a few every day (the first one of the day is the marker)
    const sold = await tx.select({ id: pharmacySale.id }).from(pharmacySale).where(and(eq(pharmacySale.tenantId, t), sql`${pharmacySale.encounterId} is null`, sql`${pharmacySale.createdAt} >= ${at(day, '00:00')} and ${pharmacySale.createdAt} < ${at(addDays(day, 1), '00:00')}`)).limit(1);
    const onHand = new Map((await tx.select({ m: stockBatch.medicineId, q: sql<number>`sum(${stockBatch.qty})::int` }).from(stockBatch).where(and(eq(stockBatch.tenantId, t), sql`${stockBatch.expiry} >= ${day}`)).groupBy(stockBatch.medicineId)).map((r) => [r.m, r.q]));
    const priced = meds.filter((m) => m.mrpPaise > 0 && !KEEP_STOCK.test(m.name) && !['H', 'H1', 'X'].includes(m.scheduleClass ?? '') && (onHand.get(m.id) ?? 0) >= 10); // counter sales: over-the-counter items in stock only
    if (!sold.length && priced.length) {
      for (let i = 0; i < 3 + rnd(2); i++) {
        const items = Array.from({ length: 1 + rnd(3) }, () => ({ medicineId: priced[rnd(priced.length)].id, qty: 1 + rnd(3) }))
          .filter((x, k, arr) => arr.findIndex((y) => y.medicineId === x.medicineId) === k);
        const method = (['cash', 'upi', 'card'] as const)[rnd(3)];
        try {
          await recordSale(tx, sampleActor, { patientId: pts[rnd(pts.length)].id, items, notIssued: [], discountPaise: rnd(4) === 0 ? 1000 : 0, method, reference: method === 'cash' ? undefined : `${method === 'upi' ? 'UPI' : 'CARD'}${100000 + rnd(900000)}`, whatsapp: false, at: at(day, hm(i * 3 + 1, 11)) });
          counts.counterSales++;
        } catch { /* out of stock in the sample */ }
      }
    }

    // D. expenses
    const spent = await tx.select({ id: expense.id }).from(expense).where(and(eq(expense.tenantId, t), eq(expense.day, day), eq(expense.note, 'sample-week'))).limit(1);
    if (!spent.length) {
      const EXP = [['Water cans', 'Supplies', 16000], ['Cleaning staff', 'Salaries', 50000], ['Gloves and masks', 'Supplies', 42000], ['Courier', 'Other', 18000], ['Tea and snacks', 'Other', 24000]] as const;
      const pick = [EXP[rnd(EXP.length)], EXP[(rnd(EXP.length) + 2) % EXP.length]];
      await tx.insert(expense).values(pick.map(([description, category, amountPaise], i) => ({ tenantId: t, day, description, category, amountPaise, method: i ? 'upi' : 'cash', note: 'sample-week', enteredBy: userId })));
      counts.expenses += pick.length;
    }
  }
}

/**
 * Stock for the pharmacy, once: opening stock for every priced medicine (one batch close to expiry, one medicine low),
 * two vendors, a delivery that differs from its order (waiting for the owner) and an order still open.
 */
async function loadStock(tx: Tx, a: Actor, today: string, meds: (typeof medicine.$inferSelect)[], counts: Record<string, number>) {
  const t = a.tenantId;
  // once: vendors mark it done. Opening stock may already be there from the demo pack; then only the vendors and their orders are added.
  if ((await tx.select({ id: vendor.id }).from(vendor).where(eq(vendor.tenantId, t)).limit(1)).length) return;
  const priced = meds.filter((m) => m.mrpPaise > 0); if (!priced.length) return;
  const ym = (days: number) => addDays(today, days).slice(0, 7);
  const by = (n: string) => priced.find((m) => m.name === n);
  if (!(await tx.select({ id: stockBatch.id }).from(stockBatch).where(eq(stockBatch.tenantId, t)).limit(1)).length) await receiveStock(tx, a, { keepOpen: false, lines: priced.map((m, i) => ({ medicineId: m.id, qty: m.name.startsWith('Terbinafine') ? 3 : ['tab', 'cap'].includes(m.form ?? '') ? 400 : 300, freeQty: 0,
    ratePaise: Math.round(m.mrpPaise * 0.62), discBp: 0, batchNo: `OPN${String(i + 1).padStart(3, '0')}`, expiry: m.name.startsWith('Sunscreen') ? ym(50) : ym(540) })) }, today);
  const [g] = await tx.insert(vendor).values({ tenantId: t, name: 'Godavari Medical Agencies', phone: '9000000001', address: 'Rajahmundry' }).returning();
  await tx.insert(vendor).values({ tenantId: t, name: 'Sai Pharma Distributors', phone: '9000000002', address: 'Kakinada' });
  const photo = { mime: 'image/png' as const, dataBase64: samplePhoto(0, 0, 'front').toString('base64') };
  const iso = by('Isotretinoin 20 mg'), mox = by('Moisturiser (ceramide)'), dox = by('Doxycycline 100 mg');
  const po = async (lines: { m: typeof priced[number]; qty: number; scheme: string; rate: number }[]) => {
    const n = await nextNumber(tx, t, 'stock_po', 'tenant');
    return (await tx.insert(stockDoc).values({ tenantId: t, kind: 'order', docNo: `PO-${String(n).padStart(4, '0')}`, vendorId: g.id, status: 'open', dueDate: addDays(today, 3), createdBy: a.userId, createdByName: a.name,
      lines: lines.map(({ m, qty, scheme, rate }) => ({ medicineId: m.id, name: m.name, qty, scheme, freeQty: schemeFree(scheme, qty), ratePaise: rate, discBp: 0, gstBp: m.gstBp, amountPaise: qty * rate + Math.round((qty * rate * m.gstBp) / 10000) })) }).returning())[0];
  };
  if (iso && mox) {
    const order = await po([{ m: iso, qty: 50, scheme: '5 free per 50', rate: 19000 }, { m: mox, qty: 12, scheme: '1 free per 12', rate: 23000 }]);
    const lines = [{ medicineId: iso.id, qty: 50, freeQty: 3, ratePaise: 19600, discBp: 0, batchNo: 'ISO2410A', expiry: ym(700) }, { medicineId: mox.id, qty: 12, freeQty: 1, ratePaise: 23000, discBp: 0, batchNo: 'MX2410B', expiry: ym(600) }];
    const total = lines.reduce((n, l) => { const m = l.medicineId === iso.id ? iso : mox; const x = l.qty * l.ratePaise; return n + x + Math.round((x * m.gstBp) / 10000); }, 0);
    await receiveStock(tx, a, { orderId: order.id, billNo: 'GMA/2210', billDate: today, billTotalPaise: total, billPhoto: photo, keepOpen: false, lines }, today);
    counts.stockReceipts++;
  }
  if (dox) await po([{ m: dox, qty: 30, scheme: '10+1', rate: 5800 }]);
}
