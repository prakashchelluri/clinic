import Anthropic from '@anthropic-ai/sdk';
import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema';
import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { withTenant, type Tx } from '../db/index.js';
import { appointment, chat, chatMessage, message, patient, practitioner, recommendation, session, visit, waitlist, OPEN_STATUSES } from '../db/schema.js';
import { HttpError } from './auth.js';
import { emit, nextNumber, todayIn } from './core.js';
import { appointmentView, bookingSettings, newToken, planReminders } from './booking.js';
import { cancelByPatient, confirmByPatient, ctxFor, moveByPatient, openSlots, patientView } from '../modules/public.js';

const SYSTEM_USER = '00000000-0000-0000-0000-000000000000';
const BY = 'WhatsApp assistant';
type Tenant = { id: string; name: string; slug: string; timezone: string; kind: string; settings: any };
type Chat = typeof chat.$inferSelect;

/** The assistant answers only when an Anthropic key is set and the clinic has not switched it off; otherwise every chat goes to the front desk. */
export const assistantReady = (t: Tenant) => !!process.env.ANTHROPIC_API_KEY && t.settings?.features?.ai !== false;

/** "+91 98480 12345", "919848012345" → "9848012345". */
export const tenDigits = (p: string) => String(p ?? '').replace(/\D/g, '').slice(-10);

const nowHHMM = (tz: string) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
const sameName = sql`lower(regexp_replace(trim(${patient.fullName}), '\\s+', ' ', 'g'))`;
const inTenant = <T>(t: Tenant, fn: (tx: Tx) => Promise<T>) => withTenant(t.id, SYSTEM_USER, fn);

/** Patients whose record carries this phone (families share one). The assistant may act for these and no one else. */
const patientsOn = (tx: Tx, t: Tenant, phone: string) =>
  tx.select({ id: patient.id, fullName: patient.fullName, patientNo: patient.patientNo }).from(patient)
    .where(and(eq(patient.tenantId, t.id), eq(patient.phone, phone), isNull(patient.mergedInto))).orderBy(asc(patient.createdAt));

/** A booking of a patient on this phone, else NOT_YOURS: a patient can never reach someone else's visit, whatever they type. */
async function mine(tx: Tx, t: Tenant, phone: string, appointmentId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(appointmentId)) throw new HttpError(404, 'NOT_FOUND');
  const v = await appointmentView(tx, t.id, appointmentId);
  if (!v || v.p.phone !== phone) throw new HttpError(404, 'NOT_YOURS');
  return v;
}

const visitOut = (v: NonNullable<Awaited<ReturnType<typeof appointmentView>>>) => {
  const pv = patientView(v);
  return { appointment_id: v.a.id, patient: v.p.fullName, date: v.s.day, window: `${v.s.startTime}-${v.s.endTime}`, arrive_by: pv.arriveBy, doctor: v.doc, visit_type: v.svc?.name ?? null,
    status: v.a.status, can_confirm: pv.canConfirm, can_cancel: pv.canCancel, can_move: pv.canReschedule };
};

/** Book a new visit from WhatsApp: the same rules as the front desk without its overrides (no overbooking, one upcoming visit per patient). */
export async function bookFromChat(tx: Tx, t: Tenant, phone: string, windowId: string, who: { patientId?: string; newName?: string }, origin: string) {
  if (!/^[0-9a-f-]{36}$/i.test(windowId)) throw new HttpError(404, 'WINDOW_NOT_FOUND');
  const s = await tx.select().from(session).where(and(eq(session.id, windowId), eq(session.tenantId, t.id))).for('update').then((r) => r[0]);
  if (!s) throw new HttpError(404, 'WINDOW_NOT_FOUND');
  const open = (await openSlots(tx, t, s.day, 1, null, s.practitionerId)).find((d) => d.day === s.day);
  if (!open?.slots.some((x) => x.id === s.id)) throw new HttpError(409, 'WINDOW_FULL_OR_TOO_SOON');
  const family = await patientsOn(tx, t, phone);
  let patientId = who.patientId;
  if (patientId && !family.some((p) => p.id === patientId)) throw new HttpError(404, 'NOT_YOURS');
  if (!patientId) {
    const name = who.newName?.trim().replace(/\s+/g, ' ');
    if (!name || name.length < 2) throw new HttpError(400, 'NAME_NEEDED');
    const same = await tx.select({ id: patient.id }).from(patient).where(and(eq(patient.tenantId, t.id), eq(patient.phone, phone), isNull(patient.mergedInto), sql`${sameName} = ${name.toLowerCase()}`)).limit(1);
    if (same.length) patientId = same[0].id;
    else {
      const num = await nextNumber(tx, t.id, 'patient_no', 'tenant');
      patientId = (await tx.insert(patient).values({ tenantId: t.id, patientNo: `P${String(num).padStart(5, '0')}`, fullName: name, phone }).returning())[0].id;
    }
  }
  const today = todayIn(t.timezone); const now = nowHHMM(t.timezone);
  const upcoming = await tx.select({ id: appointment.id }).from(appointment).innerJoin(session, eq(session.id, appointment.sessionId))
    .where(and(eq(appointment.tenantId, t.id), eq(appointment.patientId, patientId), inArray(appointment.status, [...OPEN_STATUSES]), or(gt(session.day, today), and(eq(session.day, today), gt(session.endTime, now))))).limit(1);
  if (upcoming.length) throw new HttpError(409, 'ALREADY_BOOKED', { appointment_id: upcoming[0].id });
  const seen = await tx.select({ id: visit.id }).from(visit).where(and(eq(visit.tenantId, t.id), eq(visit.patientId, patientId), eq(visit.day, today), inArray(visit.status, ['waiting', 'intake', 'in_consult']))).limit(1);
  if (seen.length) throw new HttpError(409, 'IN_CLINIC_NOW');
  const [row] = await tx.insert(appointment).values({ tenantId: t.id, patientId, sessionId: s.id, source: 'whatsapp', publicToken: newToken() }).returning();
  await emit(tx, ctxFor(t, BY), 'appointment.booked', 'appointment', row.id, { patientId, sessionId: s.id, day: s.day, window: [s.startTime, s.endTime], by: 'whatsapp' });
  await tx.update(waitlist).set({ status: 'booked' }).where(and(eq(waitlist.tenantId, t.id), eq(waitlist.patientId, patientId), inArray(waitlist.status, ['waiting', 'offered'])));
  await tx.update(recommendation).set({ status: 'scheduled' }).where(and(eq(recommendation.tenantId, t.id), eq(recommendation.patientId, patientId), eq(recommendation.kind, 'followup'), inArray(recommendation.status, ['open', 'contacted'])));
  await planReminders(tx, t.id, row.id, origin);
  return visitOut((await appointmentView(tx, t.id, row.id))!);
}

/** What the assistant may do, each in its own short transaction and always limited to the patients on this chat's phone. */
export function chatTools(t: Tenant, c: Chat, origin: string) {
  const run = <I>(fn: (tx: Tx, input: I) => Promise<unknown>) => async (input: I) => {
    try { return JSON.stringify(await inTenant(t, (tx) => fn(tx, input))); }
    catch (e: any) { if (e instanceof HttpError) return JSON.stringify({ error: e.message, ...e.extra }); throw e; }
  };
  return [
    betaTool({
      name: 'my_visits', description: 'The patients registered on this WhatsApp number and their upcoming visits, with what each visit allows (confirm, cancel, move).',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false } as const,
      run: run(async (tx) => {
        const family = await patientsOn(tx, t, c.phone);
        const today = todayIn(t.timezone);
        const ids = family.length ? await tx.select({ id: appointment.id }).from(appointment).innerJoin(session, eq(session.id, appointment.sessionId))
          .where(and(eq(appointment.tenantId, t.id), inArray(appointment.patientId, family.map((p) => p.id)), inArray(appointment.status, [...OPEN_STATUSES]), sql`${session.day} >= ${today}`)).orderBy(asc(session.day), asc(session.startTime)) : [];
        const visits = []; for (const r of ids) visits.push(visitOut((await appointmentView(tx, t.id, r.id))!));
        return { patients: family.map((p) => ({ patient_id: p.id, name: p.fullName })), upcoming_visits: visits };
      }),
    }),
    betaTool({
      name: 'open_times', description: 'Hourly windows with room left, from a date for up to 7 days. Give appointment_id when moving an existing visit (keeps its doctor and visit type).',
      inputSchema: { type: 'object', properties: { from: { type: 'string', description: 'YYYY-MM-DD' }, days: { type: 'integer', minimum: 1, maximum: 7 }, appointment_id: { type: 'string' } }, required: ['from'], additionalProperties: false } as const,
      run: run(async (tx, i: { from: string; days?: number; appointment_id?: string }) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(i.from)) throw new HttpError(400, 'BAD_DATE');
        const v = i.appointment_id ? await mine(tx, t, c.phone, i.appointment_id) : null;
        const days = await openSlots(tx, t, i.from, Math.min(i.days ?? 3, 7), v?.svc ?? null, v?.s.practitionerId);
        return days.map((d) => ({ date: d.day, windows: d.slots.filter((x) => x.id !== v?.a.sessionId).map((x) => ({ window_id: x.id, time: `${x.startTime}-${x.endTime}`, doctor: x.doctor })) }));
      }),
    }),
    betaTool({
      name: 'book_visit', description: 'Book a new visit in a window from open_times. Use patient_id for a patient on this number, or new_patient_name for someone new.',
      inputSchema: { type: 'object', properties: { window_id: { type: 'string' }, patient_id: { type: 'string' }, new_patient_name: { type: 'string' } }, required: ['window_id'], additionalProperties: false } as const,
      run: run((tx, i: { window_id: string; patient_id?: string; new_patient_name?: string }) => bookFromChat(tx, t, c.phone, i.window_id, { patientId: i.patient_id, newName: i.new_patient_name }, origin)),
    }),
    betaTool({
      name: 'confirm_visit', description: 'Mark an upcoming visit as confirmed by the patient.',
      inputSchema: { type: 'object', properties: { appointment_id: { type: 'string' } }, required: ['appointment_id'], additionalProperties: false } as const,
      run: run(async (tx, i: { appointment_id: string }) => { await confirmByPatient(tx, await mine(tx, t, c.phone, i.appointment_id), 'whatsapp'); return visitOut((await appointmentView(tx, t.id, i.appointment_id))!); }),
    }),
    betaTool({
      name: 'cancel_visit', description: 'Cancel an upcoming visit.',
      inputSchema: { type: 'object', properties: { appointment_id: { type: 'string' }, reason: { type: 'string' } }, required: ['appointment_id'], additionalProperties: false } as const,
      run: run(async (tx, i: { appointment_id: string; reason?: string }) => { await cancelByPatient(tx, await mine(tx, t, c.phone, i.appointment_id), i.reason?.slice(0, 300), 'whatsapp'); return visitOut((await appointmentView(tx, t.id, i.appointment_id))!); }),
    }),
    betaTool({
      name: 'move_visit', description: 'Move an upcoming visit to another window from open_times (called with that appointment_id).',
      inputSchema: { type: 'object', properties: { appointment_id: { type: 'string' }, window_id: { type: 'string' } }, required: ['appointment_id', 'window_id'], additionalProperties: false } as const,
      run: run(async (tx, i: { appointment_id: string; window_id: string }) => {
        if (!/^[0-9a-f-]{36}$/i.test(i.window_id)) throw new HttpError(404, 'WINDOW_NOT_FOUND');
        await moveByPatient(tx, await mine(tx, t, c.phone, i.appointment_id), i.window_id, origin, 'whatsapp'); return visitOut((await appointmentView(tx, t.id, i.appointment_id))!);
      }),
    }),
    betaTool({
      name: 'hand_over', description: 'Pass this chat to the front desk. They reply from their Inbox. Use it for anything you must not or cannot handle.',
      inputSchema: { type: 'object', properties: { reason: { type: 'string', description: 'One short line for the front desk' } }, required: ['reason'], additionalProperties: false } as const,
      run: run(async (tx, i: { reason: string }) => { await tx.update(chat).set({ status: 'staff', reason: i.reason.slice(0, 200) }).where(eq(chat.id, c.id)); return { handed_over: true }; }),
    }),
  ];
}

function systemPrompt(t: Tenant) {
  const phone = t.settings?.print?.phone ?? ''; const address = t.settings?.print?.address ?? '';
  const now = new Date();
  const day = new Intl.DateTimeFormat('en-IN', { timeZone: t.timezone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(now);
  return `You are the WhatsApp front desk of ${t.name}, a clinic in India.${phone ? ` Clinic phone: ${phone}.` : ''}${address ? ` Address: ${address}.` : ''}

Reply in the language and script the patient writes in (English, Telugu or Hindi, including Telugu or Hindi typed in English letters). Keep replies to one to three short sentences of plain text: no markdown, no lists unless offering times.

You can look up the patient's visits, offer open times, and book, move, confirm or cancel visits with your tools. Visits are booked in hourly windows: say the window and the arrive-by time, for example "between 10:00 and 11:00, please come by 09:25". Offer at most three windows at a time. Only use window ids and appointment ids your tools returned.

Before you book, move or cancel, say exactly what you will do and wait for a yes, unless the patient already asked for that exact change (a "Yes" or "Confirm" reply to a reminder confirms their visit). If several patients share this number, ask which one. For someone new, ask their full name before booking.

Never give medical advice, a diagnosis, medicine or dose advice, test results, prices or fees, and never discuss payments or refunds. For those, for complaints, for anything about another person's records, and whenever you are unsure, call hand_over and tell the patient the front desk will reply here soon. In an emergency tell them to call ${phone || 'the clinic'} or go to the nearest hospital, and call hand_over.

Today is ${day}. The time now is ${nowHHMM(t.timezone)}.`;
}

/** Ask Claude for the reply to the latest patient line. The conversation so far is replayed as user/assistant turns. */
async function askClaude(t: Tenant, c: Chat, lines: { direction: string; body: string }[], origin: string) {
  const client = new Anthropic();
  const messages: Anthropic.Beta.BetaMessageParam[] = [];
  for (const l of lines) {
    const role = l.direction === 'in' ? 'user' as const : 'assistant' as const;
    if (!messages.length && role === 'assistant') continue; // must start with the patient
    messages.push({ role, content: l.body });
  }
  const final = await client.beta.messages.toolRunner({
    model: process.env.ASSISTANT_MODEL ?? 'claude-opus-5-5', max_tokens: 4000, max_iterations: 8,
    system: systemPrompt(t), messages, tools: chatTools(t, c, origin),
    output_config: { effort: 'medium' },
    betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
  });
  if (final.stop_reason === 'refusal') return null;
  return final.content.flatMap((b: any) => (b.type === 'text' ? [b.text] : [])).join('\n').trim() || null;
}

/** Write an outgoing line: kept on the chat, and queued for WhatsApp unless this is the in-app test chat. */
export async function say(tx: Tx, t: Tenant, c: Chat, body: string, by: string, simulate: boolean) {
  await tx.insert(chatMessage).values({ tenantId: t.id, chatId: c.id, direction: 'out', by, body });
  await tx.update(chat).set({ lastAt: new Date().toISOString() }).where(eq(chat.id, c.id));
  if (simulate) return;
  const cfg = bookingSettings(t.settings).messages;
  const family = await patientsOn(tx, t, c.phone);
  await tx.insert(message).values({ tenantId: t.id, patientId: family.length === 1 ? family[0].id : null, kind: 'chat', channel: 'whatsapp', toPhone: c.phone, body,
    status: cfg.enabled && cfg.channel !== 'none' ? 'pending' : 'skipped', error: cfg.enabled && cfg.channel !== 'none' ? null : 'messages are switched off' });
}

const OFF_REPLY = 'Thank you for your message. Our front desk will reply here soon.';

/**
 * One line from a patient (WhatsApp or the test chat). Kept once (WhatsApp resends), then answered by the assistant
 * unless the chat is with the front desk. Any failure hands the chat to the front desk: a patient is never left unanswered.
 */
export async function handleIncoming(t: Tenant, inp: { phone: string; text: string; ref?: string; origin: string; simulate?: boolean }) {
  const phone = tenDigits(inp.phone);
  if (phone.length !== 10) throw new HttpError(400, 'BAD_PHONE');
  const text = inp.text.trim().slice(0, 2000);
  const got = await inTenant(t, async (tx) => {
    let c = await tx.select().from(chat).where(and(eq(chat.tenantId, t.id), eq(chat.phone, phone))).then((r) => r[0]);
    if (!c) c = (await tx.insert(chat).values({ tenantId: t.id, phone }).onConflictDoNothing().returning())[0]
      ?? await tx.select().from(chat).where(and(eq(chat.tenantId, t.id), eq(chat.phone, phone))).then((r) => r[0]);
    const kept = await tx.insert(chatMessage).values({ tenantId: t.id, chatId: c.id, direction: 'in', by: 'patient', body: text, providerRef: inp.ref ?? null }).onConflictDoNothing().returning();
    if (!kept.length) return null; // WhatsApp sent this one before
    const [upd] = await tx.update(chat).set({ lastAt: new Date().toISOString(), unread: c.unread + 1, status: c.status === 'closed' ? 'assistant' : c.status }).where(eq(chat.id, c.id)).returning();
    return upd;
  });
  if (!got) return { duplicate: true as const };
  if (got.status === 'staff') return { chatId: got.id, status: 'staff' };
  const handOff = (reason: string) => inTenant(t, async (tx) => {
    await tx.update(chat).set({ status: 'staff', reason }).where(eq(chat.id, got.id));
    await say(tx, t, got, OFF_REPLY, BY, !!inp.simulate);
  });
  if (!assistantReady(t)) { await handOff('Assistant is off'); return { chatId: got.id, status: 'staff' }; }
  const lines = await inTenant(t, (tx) => tx.select({ direction: chatMessage.direction, body: chatMessage.body }).from(chatMessage).where(eq(chatMessage.chatId, got.id)).orderBy(desc(chatMessage.createdAt)).limit(20));
  let reply: string | null;
  try { reply = await askClaude(t, got, lines.reverse(), inp.origin); }
  catch (e) { console.warn('assistant failed', (e as Error).message); reply = null; }
  if (!reply) { await handOff('The assistant could not answer'); return { chatId: got.id, status: 'staff' }; }
  const status = await inTenant(t, async (tx) => {
    const c = (await tx.select().from(chat).where(eq(chat.id, got.id)))[0];
    await say(tx, t, c, reply!, BY, !!inp.simulate);
    return c.status;
  });
  return { chatId: got.id, status };
}
