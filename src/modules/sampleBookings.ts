import { deflateSync } from 'node:zlib';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../db/index.js';
import { patient, appointment, session, service, practitioner, recommendation, procedureSession, procedureCatalog, room, calendarBlock, document, tenant, OPEN_STATUSES } from '../db/schema.js';
import { todayIn, addDays } from '../lib/core.js';
import { HttpError } from '../lib/auth.js';
import { newToken, queueMessage, planReminders } from '../lib/booking.js';
import { putFile } from '../lib/storage.js';
import { windowsForDay } from './scheduling.js';

/**
 * Test data for the booking and photo features, on top of the base sample (patients, visits, today's queue):
 * three weeks of bookings across every doctor with visit types and statuses, online requests waiting for approval,
 * repeat series, queued patient messages, and two procedure courses with sittings and before/after photos.
 * Run it again to top up: bookings only fill windows below their target; the one-off parts (requests, series, courses, photos) are made once.
 */
const MARKER = 'sample-bookings-marker';

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
  const counts = { booked: 0, confirmed: 0, arrived: 0, no_show: 0, cancelled: 0, requested: 0, series: 0, messages: 0, sittings: 0, photos: 0 };
  const made: string[] = [];
  /** First window with room on the day or the next working days (no doctor works on Sunday). */
  const nextWindow = async (day: string, docId: string) => { for (let i = 0; i < 7; i++) { const w = (await windowsForDay(tx, t, addDays(day, i), docId)).find((x) => x.free > 0); if (w) return w; } return null; };

  // 1. Bookings for every doctor on every working day: the whole month (past days included), this week, tomorrow and the next two weeks.
  // Today only gets the windows still ahead. Each window has a fixed target, so running this again only tops up quiet windows.
  const [Y, M] = today.split('-').map(Number);
  const monthStart = `${Y}-${String(M).padStart(2, '0')}-01`;
  const monthEnd = new Date(Date.UTC(Y, M, 0)).toISOString().slice(0, 10);
  const from = monthStart < addDays(today, -7) ? monthStart : addDays(today, -7);
  const to = monthEnd > addDays(today, 14) ? monthEnd : addDays(today, 14);
  const nowHM = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  const hash = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };
  for (let day = from; day <= to; day = addDays(day, 1)) {
    const off = Math.round((Date.parse(day + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000);
    const have = new Map((await tx.select({ id: appointment.sessionId, n: sql<number>`count(*)::int` }).from(appointment).innerJoin(session, eq(session.id, appointment.sessionId))
      .where(and(eq(appointment.tenantId, t), eq(session.day, day))).groupBy(appointment.sessionId)).map((r) => [r.id, r.n] as const));
    for (const d of docs) {
      for (const w of await windowsForDay(tx, t, day, d.id)) {
        if (off === 0 && w.startTime <= nowHM) continue;
        const ratio = off < 0 ? 0.7 : off === 0 ? 0.6 : off === 1 ? 0.8 : off <= 7 ? 0.6 : 0.4;
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

  // The rest is set up once: requests, repeat series, messages, procedure courses with photos, online booking switched on.
  if (first) {
  // 2. Online requests waiting in Bookings → Requests
  const online = svcs.filter((s) => s.onlineBookable);
  const reqNotes = ['acne for 3 months', 'hair fall after fever', 'itchy rash on hands', null];
  for (let i = 0; i < 4; i++) {
    const d = docs[i % docs.length]; const day = addDays(today, 1 + i);
    const w = await nextWindow(day, d.id); if (!w) continue;
    const p = pts[(i * 5 + 3) % pts.length]; const svc = online[i % Math.max(1, online.length)] ?? null;
    await tx.insert(appointment).values({ tenantId: t, patientId: p.id, sessionId: w.id, serviceId: svc?.id ?? null, status: 'requested', source: 'online', note: reqNotes[i], publicToken: newToken() });
    counts.requested++;
  }

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

  // 5. Procedure courses with sittings and photos: two patients, a laser course and a peel course
  const procs = await tx.select().from(procedureCatalog).where(eq(procedureCatalog.tenantId, t));
  const rooms = await tx.select().from(room).where(eq(room.tenantId, t));
  const courses = [{ name: 'Laser hair reduction', area: 'Chin', sittings: 8, gap: 21 }, { name: 'Chemical peel', area: 'Cheeks', sittings: 6, gap: 14 }];
  for (const [ci, c] of courses.entries()) {
    const proc = procs.find((p) => p.name === c.name); if (!proc) continue;
    const rec = (await tx.select().from(recommendation).where(and(eq(recommendation.tenantId, t), eq(recommendation.kind, 'procedure'), eq(recommendation.procedureId, proc.id))).limit(1))[0];
    if (!rec) continue;
    const p = pts.find((x) => x.id === rec.patientId)!;
    await tx.update(patient).set({ consents: { ...(p.consents ?? {}), photos: { grantedAt: new Date(Date.now() - 70 * 86400000).toISOString(), by: 'Dr. Main Doctor' } } }).where(eq(patient.id, p.id));
    await tx.update(recommendation).set({ status: 'scheduled', sittings: c.sittings, dueOn: addDays(today, 7 + ci) }).where(eq(recommendation.id, rec.id));
    const rm = rooms.find((r) => proc.requiredCapability && r.capabilities.includes(proc.requiredCapability)) ?? rooms[0];
    const doc = docs[ci % docs.length];
    // baseline photos at the consultation, then three completed sittings, then the next one booked
    const plan = [-(c.gap * 3 + 7), -(c.gap * 3), -(c.gap * 2), -c.gap, 7 + ci];
    for (const [k, off] of plan.entries()) {
      const day = addDays(today, off); const sittingNo = k; // 0 = before the course
      let psId: string | null = null;
      if (k > 0) {
        const start = ['11:00', '15:30'][ci]; const [h, m] = start.split(':').map(Number); const endMin = h * 60 + m + proc.typicalMinutes;
        const end = `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`;
        const [ps] = await tx.insert(procedureSession).values({ tenantId: t, recommendationId: rec.id, patientId: p.id, procedureId: proc.id, practitionerId: doc.id, roomId: rm?.id ?? null, sittingNo,
          day, startTime: start, endTime: end, state: off < 0 ? 'completed' : 'confirmed', notes: off < 0 ? ['tolerated well', 'mild redness, settled in 10 min', 'good response'][k % 3] : null }).returning();
        if (off >= 0) await tx.insert(calendarBlock).values({ tenantId: t, practitionerId: doc.id, roomId: rm?.id ?? null, day, startTime: start, endTime: end, kind: 'procedure', note: `${proc.name} · sitting ${sittingNo}`, procedureSessionId: ps.id });
        psId = ps.id; counts.sittings++;
      }
      if (off >= 0) continue;
      for (const view of ['front', 'left'] as const) {
        const png = samplePhoto(ci, k, view);
        const [d] = await tx.insert(document).values({ tenantId: t, patientId: p.id, kind: 'photo', title: `${c.area} · ${view === 'front' ? 'Front' : 'Left'} · sample`, mime: 'image/png', sizeBytes: png.length,
          storageKey: 'pending', uploadedBy: userId, area: c.area, view, procedureSessionId: psId, takenAt: new Date(`${day}T${['11:20', '15:50'][ci]}:00+05:30`).toISOString(), note: k === 0 ? 'before the course' : null }).returning();
        const key = `${t}/${p.id}/${d.id}.png`;
        await putFile(key, png, 'image/png');
        await tx.update(document).set({ storageKey: key }).where(eq(document.id, d.id));
        counts.photos++;
      }
    }
  }

  // 6. Online booking switched on (approval required) so the public page can be tried straight away
  const settings = { ...ten.settings, online: { requireApproval: true, minNoticeHours: 2, maxDaysAhead: 30, dailyCap: 0, intro: '', ...(ten.settings?.online ?? {}), enabled: true } };
  await tx.update(tenant).set({ settings }).where(eq(tenant.id, t));

  // marker so a second run is refused (a cancelled booking that holds no place)
  const anyWindow = (await windowsForDay(tx, t, addDays(today, 1)))[0];
  if (anyWindow) await tx.insert(appointment).values({ tenantId: t, patientId: pts[0].id, sessionId: anyWindow.id, status: 'cancelled', source: 'phone', cancelReason: 'test data marker', idempotencyKey: MARKER });
  } // end of the one-off parts
  const open = await tx.select({ id: appointment.id }).from(appointment).where(and(eq(appointment.tenantId, t), inArray(appointment.status, [...OPEN_STATUSES])));
  return { ...counts, topUp: !first, from, to, openBookings: open.length, bookingPage: `${origin}/book/${ten.slug}` };
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
