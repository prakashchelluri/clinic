import Anthropic from '@anthropic-ai/sdk';
import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema';
import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { withTenant, type Tx } from '../db/index.js';
import { appointment, chat, chatMessage, message, patient, practitioner, recommendation, session, visit, waitlist, OPEN_STATUSES } from '../db/schema.js';
import { HttpError } from './auth.js';
import { emit, nextNumber, todayIn } from './core.js';
import { appointmentView, bookingSettings, newToken, planReminders } from './booking.js';
import { cancelByPatient, confirmByPatient, ctxFor, moveByPatient, openSlots, patientView } from '../modules/public.js';
import { menuTurn } from './chatMenu.js';

const SYSTEM_USER = '00000000-0000-0000-0000-000000000000';
export const BY = 'WhatsApp assistant';
type Tenant = { id: string; name: string; slug: string; timezone: string; kind: string; settings: any };
type Chat = typeof chat.$inferSelect;

/** The assistant answers only when an Anthropic key is set and the clinic has not switched it off; otherwise every chat goes to the front desk. */
export const assistantReady = (t: Tenant) => !!process.env.ANTHROPIC_API_KEY && t.settings?.features?.ai !== false;

/** "+91 98480 12345", "919848012345" → "9848012345". */
export const tenDigits = (p: string) => String(p ?? '').replace(/\D/g, '').slice(-10);

const nowHHMM = (tz: string) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
const sameName = sql`lower(regexp_replace(trim(${patient.fullName}), '\\s+', ' ', 'g'))`;
export const inTenant = <T>(t: Tenant, fn: (tx: Tx) => Promise<T>) => withTenant(t.id, SYSTEM_USER, fn);

/** Patients whose record carries this phone (families share one). The assistant may act for these and no one else. */
export const patientsOn = (tx: Tx, t: Tenant, phone: string) =>
  tx.select({ id: patient.id, fullName: patient.fullName, patientNo: patient.patientNo }).from(patient)
    .where(and(eq(patient.tenantId, t.id), eq(patient.phone, phone), isNull(patient.mergedInto))).orderBy(asc(patient.createdAt));

/** A booking of a patient on this phone, else NOT_YOURS: a patient can never reach someone else's visit, whatever they type. */
export async function mine(tx: Tx, t: Tenant, phone: string, appointmentId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(appointmentId)) throw new HttpError(404, 'NOT_FOUND');
  const v = await appointmentView(tx, t.id, appointmentId);
  if (!v || v.p.phone !== phone) throw new HttpError(404, 'NOT_YOURS');
  return v;
}

export const visitOut = (v: NonNullable<Awaited<ReturnType<typeof appointmentView>>>) => {
  const pv = patientView(v);
  return { appointment_id: v.a.id, patient: v.p.fullName, date: v.s.day, window: `${v.s.startTime}-${v.s.endTime}`, arrive_by: pv.arriveBy, doctor: v.doc, visit_type: v.svc?.name ?? null,
    status: v.a.status, can_confirm: pv.canConfirm, can_cancel: pv.canCancel, can_move: pv.canReschedule };
};

/** Book a new visit from WhatsApp: the same rules as the front desk without its overrides (no overbooking, one upcoming visit per patient). */
export async function bookFromChat(tx: Tx, t: Tenant, phone: string, windowId: string, who: { patientId?: string; newName?: string; reason?: string }, origin: string) {
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
  const [row] = await tx.insert(appointment).values({ tenantId: t.id, patientId, sessionId: s.id, source: 'whatsapp', publicToken: newToken(), note: who.reason?.trim().slice(0, 200) || null }).returning();
  await emit(tx, ctxFor(t, BY), 'appointment.booked', 'appointment', row.id, { patientId, sessionId: s.id, day: s.day, window: [s.startTime, s.endTime], by: 'whatsapp' });
  await tx.update(waitlist).set({ status: 'booked' }).where(and(eq(waitlist.tenantId, t.id), eq(waitlist.patientId, patientId), inArray(waitlist.status, ['waiting', 'offered'])));
  await tx.update(recommendation).set({ status: 'scheduled' }).where(and(eq(recommendation.tenantId, t.id), eq(recommendation.patientId, patientId), eq(recommendation.kind, 'followup'), inArray(recommendation.status, ['open', 'contacted'])));
  await planReminders(tx, t.id, row.id, origin);
  return visitOut((await appointmentView(tx, t.id, row.id))!);
}

/** What was changed from the chat (by the assistant or the tap menu) is kept as a line in it: staff see it, and the assistant's next reply is told it was done. */
export async function noteVisit(tx: Tx, t: Tenant, chatId: string, done: string, v: ReturnType<typeof visitOut>) {
  await tx.insert(chatMessage).values({ tenantId: t.id, chatId, direction: 'event', by: BY, body: `${done} ${v.patient}'s visit: ${v.date}, ${v.window}` });
  return v;
}

/** Upcoming visits of the patients on this phone. */
export async function myVisits(tx: Tx, t: Tenant, phone: string) {
  const family = await patientsOn(tx, t, phone);
  const today = todayIn(t.timezone);
  const ids = family.length ? await tx.select({ id: appointment.id }).from(appointment).innerJoin(session, eq(session.id, appointment.sessionId))
    .where(and(eq(appointment.tenantId, t.id), inArray(appointment.patientId, family.map((p) => p.id)), inArray(appointment.status, [...OPEN_STATUSES]), sql`${session.day} >= ${today}`)).orderBy(asc(session.day), asc(session.startTime)) : [];
  const visits = []; for (const r of ids) visits.push(visitOut((await appointmentView(tx, t.id, r.id))!));
  return visits;
}

/** Windows with room left from a day, for a new visit or for moving one of this phone's visits (same doctor and visit type). */
export async function openWindows(tx: Tx, t: Tenant, phone: string, from: string, days: number, appointmentId?: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) throw new HttpError(400, 'BAD_DATE');
  const v = appointmentId ? await mine(tx, t, phone, appointmentId) : null;
  const open = await openSlots(tx, t, from, days, v?.svc ?? null, v?.s.practitionerId);
  return open.map((d) => ({ date: d.day, windows: d.slots.filter((x) => x.id !== v?.a.sessionId).map((x) => ({ window_id: x.id, time: `${x.startTime}-${x.endTime}`, doctor: x.doctor })) }))
    .filter((d) => d.windows.length);
}

/** What the assistant may do, each in its own short transaction and always limited to the patients on this chat's phone. */
export function chatTools(t: Tenant, c: Chat, origin: string) {
  const run = <I>(fn: (tx: Tx, input: I) => Promise<unknown>) => async (input: I) => {
    try { return JSON.stringify(await inTenant(t, (tx) => fn(tx, input))); }
    catch (e: any) { if (e instanceof HttpError) return JSON.stringify({ error: e.message, ...e.extra }); throw e; }
  };
  const noted = (tx: Tx, done: string, v: ReturnType<typeof visitOut>) => noteVisit(tx, t, c.id, done, v);
  return [
    betaTool({
      name: 'my_visits', description: 'The patients registered on this WhatsApp number and their upcoming visits, with what each visit allows (confirm, cancel, move).',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false } as const,
      run: run(async (tx) => ({ patients: (await patientsOn(tx, t, c.phone)).map((p) => ({ patient_id: p.id, name: p.fullName })), upcoming_visits: await myVisits(tx, t, c.phone) })),
    }),
    betaTool({
      name: 'open_times', description: 'Hourly windows with room left, from a date for up to 7 days. Give appointment_id when moving an existing visit (keeps its doctor and visit type).',
      inputSchema: { type: 'object', properties: { from: { type: 'string', description: 'YYYY-MM-DD' }, days: { type: 'integer', minimum: 1, maximum: 7 }, appointment_id: { type: 'string' } }, required: ['from'], additionalProperties: false } as const,
      run: run((tx, i: { from: string; days?: number; appointment_id?: string }) => openWindows(tx, t, c.phone, i.from, Math.min(i.days ?? 3, 7), i.appointment_id)),
    }),
    betaTool({
      name: 'book_visit', description: 'Book a new visit in a window from open_times. Use patient_id for a patient on this number, or new_patient_name for someone new.',
      inputSchema: { type: 'object', properties: { window_id: { type: 'string' }, patient_id: { type: 'string' }, new_patient_name: { type: 'string', description: 'In English letters, as the clinic register keeps names (write a Telugu or Hindi name in English letters, e.g. Lakshmi)' }, reason: { type: 'string', description: 'Why the patient is coming, in a few English words for the front desk and doctor (e.g. "pimples on face, 2 months", "review after acne treatment")' } }, required: ['window_id'], additionalProperties: false } as const,
      run: run(async (tx, i: { window_id: string; patient_id?: string; new_patient_name?: string; reason?: string }) => noted(tx, 'Booked', await bookFromChat(tx, t, c.phone, i.window_id, { patientId: i.patient_id, newName: i.new_patient_name, reason: i.reason }, origin))),
    }),
    betaTool({
      name: 'confirm_visit', description: 'Mark an upcoming visit as confirmed by the patient.',
      inputSchema: { type: 'object', properties: { appointment_id: { type: 'string' } }, required: ['appointment_id'], additionalProperties: false } as const,
      run: run(async (tx, i: { appointment_id: string }) => { await confirmByPatient(tx, await mine(tx, t, c.phone, i.appointment_id), 'whatsapp'); return noted(tx, 'Confirmed', visitOut((await appointmentView(tx, t.id, i.appointment_id))!)); }),
    }),
    betaTool({
      name: 'cancel_visit', description: 'Cancel an upcoming visit.',
      inputSchema: { type: 'object', properties: { appointment_id: { type: 'string' }, reason: { type: 'string' } }, required: ['appointment_id'], additionalProperties: false } as const,
      run: run(async (tx, i: { appointment_id: string; reason?: string }) => { await cancelByPatient(tx, await mine(tx, t, c.phone, i.appointment_id), i.reason?.slice(0, 300), 'whatsapp'); return noted(tx, 'Cancelled', visitOut((await appointmentView(tx, t.id, i.appointment_id))!)); }),
    }),
    betaTool({
      name: 'move_visit', description: 'Move an upcoming visit to another window from open_times (called with that appointment_id).',
      inputSchema: { type: 'object', properties: { appointment_id: { type: 'string' }, window_id: { type: 'string' } }, required: ['appointment_id', 'window_id'], additionalProperties: false } as const,
      run: run(async (tx, i: { appointment_id: string; window_id: string }) => {
        if (!/^[0-9a-f-]{36}$/i.test(i.window_id)) throw new HttpError(404, 'WINDOW_NOT_FOUND');
        await moveByPatient(tx, await mine(tx, t, c.phone, i.appointment_id), i.window_id, origin, 'whatsapp'); return noted(tx, 'Moved', visitOut((await appointmentView(tx, t.id, i.appointment_id))!));
      }),
    }),
    betaTool({
      name: 'hand_over', description: 'Pass this chat to the front desk. They reply from their Inbox. Use it for anything you must not or cannot handle.',
      inputSchema: { type: 'object', properties: { reason: { type: 'string', description: 'One short line for the front desk' } }, required: ['reason'], additionalProperties: false } as const,
      run: run(async (tx, i: { reason: string }) => {
        await tx.update(chat).set({ status: 'staff', reason: i.reason.slice(0, 200) }).where(eq(chat.id, c.id));
        await tx.insert(chatMessage).values({ tenantId: t.id, chatId: c.id, direction: 'event', by: BY, body: `Handed to the front desk: ${i.reason.slice(0, 200)}` });
        return { handed_over: true };
      }),
    }),
  ];
}

/** The fixed part of the instructions (cached by the API across calls); who is writing and the time follow in a second block. */
function systemPrompt(t: Tenant) {
  const phone = t.settings?.print?.phone ?? ''; const address = t.settings?.print?.address ?? '';
  return `You are the WhatsApp front desk of ${t.name}, a clinic in India.${phone ? ` Clinic phone: ${phone}.` : ''}${address ? ` Address: ${address}.` : ''}

Reply in the language and script the patient writes in (English, Telugu or Hindi, including Telugu or Hindi typed in English letters). Keep replies to one to three short sentences of plain text: no markdown, no lists unless offering times. Everything you write is sent to the patient as it is, so write only the message itself: no notes to yourself, no drafts, no "wait" or "correction".

How a conversation goes:
1. First find out why they are writing. If the message is only a greeting ("hi", "hello", "namaste") or does not say what they need, greet them and ask how you can help. A registered patient (see "Who is writing") is greeted by name; someone new gets a welcome to the clinic. Do not offer times yet.
2. If they want a visit, collect what is missing, one reply per item, in this order, skipping what they already said:
   a) the problem: "What would you like to see the doctor about?"
   b) only for someone new, after they answered (a): their name
   c) the day that suits them
   Then offer times.
3. If they ask about an existing visit, call my_visits (it gives the appointment ids you need) and help with it. Do not call my_visits just to greet: "Who is writing" already says who they are and whether a visit is booked.
4. When the patient says thanks or ok after things are done, reply with a short goodbye only; do not repeat the visit details.
Ask exactly one thing per reply: never join two requests ("what is it about, and your name?"). Never ask for anything the patient already told you.
Your earlier replies in this chat were based on tool results that are not shown again: trust what you told the patient. Never "correct" or take back an earlier reply, never say a booking you made did not happen; "Done by you earlier in this chat" lists your actions. If the patient says yes again after a visit is booked, just confirm it is booked. Times can fill up, so before booking or moving call open_times again for the window ids.

You can look up the patient's visits, offer open times, and book, move, confirm or cancel visits with your tools. Visits are booked in hourly windows. When offering times, list only the windows ("10:00 to 11:00"), with no arrival time per window. Once a visit is booked or moved, say once: please come ${bookingSettings(t.settings).arriveEarlyMinutes} minutes before your time. Offer at most three windows at a time. Only use window ids and appointment ids your tools returned.

Before you book, move or cancel, say exactly what you will do and wait for a yes, unless the patient already asked for that exact change (a "Yes" or "Confirm" reply to a reminder confirms their visit). If several patients share this number, ask which one. For someone new you need the patient's name before booking: whatever name they give (a first name alone is fine) is enough, so never ask again for a surname or full name. If they gave a name and chose a time, book it.

Never give medical advice, a diagnosis, medicine or dose advice, test results, prices or fees, and never discuss payments or refunds. For those, for complaints, for anything about another person's records, and whenever you are unsure, call hand_over and tell the patient the front desk will reply here soon. In an emergency tell them to call ${phone || 'the clinic'} or go to the nearest hospital, and call hand_over.

When you book, pass the patient's reason for the visit in book_visit's reason.`;
}

/** Who is writing (the patients registered on this number, with their last and next visit) and the date: changes per chat, so kept out of the cached block. */
async function aboutChat(t: Tenant, c: Chat, done: string[] = []) {
  const today = todayIn(t.timezone);
  const people = await inTenant(t, async (tx) => {
    const family = await patientsOn(tx, t, c.phone);
    const out = [];
    for (const p of family) {
      const last = (await tx.select({ day: sql<string>`max(${visit.day})` }).from(visit).where(and(eq(visit.tenantId, t.id), eq(visit.patientId, p.id))))[0]?.day;
      const next = (await tx.select({ day: session.day, from: session.startTime }).from(appointment).innerJoin(session, eq(session.id, appointment.sessionId))
        .where(and(eq(appointment.tenantId, t.id), eq(appointment.patientId, p.id), inArray(appointment.status, [...OPEN_STATUSES]), sql`${session.day} >= ${today}`)).orderBy(asc(session.day)).limit(1))[0];
      out.push(`- ${p.fullName} (patient_id ${p.id})${last ? `, last visited ${last}` : ', no visit yet'}${next ? `, next visit booked on ${next.day} at ${next.from}` : ''}`);
    }
    return out;
  });
  const day = new Intl.DateTimeFormat('en-IN', { timeZone: t.timezone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
  return `Who is writing: ${people.length ? `this WhatsApp number is registered for:\n${people.join('\n')}\nIf more than one, find out which person the message is about.` : 'a number not registered with the clinic (a new patient, or an existing one writing from another number).'}

Done by you earlier in this chat: ${done.length ? `\n${done.map((d) => `- ${d}`).join('\n')}\nThese were your own actions and they succeeded; the visits listed above already include them.` : 'nothing yet.'}

Today is ${day}. It is now ${nowHHMM(t.timezone).slice(0, 2)}:xx (open_times only offers windows that can still be booked).`;
}

/** Ask Claude for the reply to the latest patient line. The conversation so far is replayed as user/assistant turns. */
async function askClaude(t: Tenant, c: Chat, lines: { direction: string; body: string }[], origin: string) {
  const client = new Anthropic();
  const messages: Anthropic.Beta.BetaMessageParam[] = [];
  for (const l of lines) {
    if (l.direction === 'event') continue; // actions go in "Done by you" below
    const role = l.direction === 'in' ? 'user' as const : 'assistant' as const;
    if (!messages.length && role === 'assistant') continue; // must start with the patient
    messages.push({ role, content: l.body });
  }
  // cache the conversation so far: the tool rounds of this reply, and the next reply, read it at a twentieth of the price
  const lastMsg = messages[messages.length - 1];
  if (lastMsg) lastMsg.content = [{ type: 'text', text: lastMsg.content as string, cache_control: { type: 'ephemeral' } }];
  const runner = client.beta.messages.toolRunner({
    // Haiku 5.5 passes the 17 test chats in scripts/whatsapp-eval.mjs (so do Sonnet 5.5 and Opus 5.5, at ~10x and ~20x the price).
    // After changing these instructions or the tools, run that script on the model in use before going live.
    model: process.env.ASSISTANT_MODEL || 'claude-haiku-5-5', max_tokens: 4000, max_iterations: 8,
    system: [{ type: 'text', text: systemPrompt(t), cache_control: { type: 'ephemeral' } }, { type: 'text', text: await aboutChat(t, c, lines.filter((l) => l.direction === 'event').map((l) => l.body)) }],
    messages, tools: chatTools(t, c, origin),
    output_config: { effort: (process.env.ASSISTANT_EFFORT as 'low' | 'medium' | 'high' | undefined) ?? 'medium' },
    betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
  });
  // every model call of this reply (one per tool round) is counted, so the clinic can see what a conversation costs
  const used: Usage = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let final: Anthropic.Beta.BetaMessage | undefined;
  for await (const m of runner) {
    final = m as Anthropic.Beta.BetaMessage;
    used.calls++; used.input += m.usage?.input_tokens ?? 0; used.output += m.usage?.output_tokens ?? 0;
    used.cacheRead += m.usage?.cache_read_input_tokens ?? 0; used.cacheWrite += m.usage?.cache_creation_input_tokens ?? 0;
  }
  if (!final || final.stop_reason === 'refusal') return { text: null, used };
  // only the last text block: a model that drafts and then corrects itself in the same turn sends just the corrected reply
  const texts = final.content.flatMap((b: any) => (b.type === 'text' && b.text.trim() ? [b.text.trim()] : []));
  return { text: texts.at(-1) ?? null, used };
}

export type Usage = { calls: number; input: number; output: number; cacheRead: number; cacheWrite: number };
const addUsage = (a: Partial<Usage> | null | undefined, b: Usage): Usage & { replies: number } =>
  ({ replies: ((a as any)?.replies ?? 0) + 1, calls: (a?.calls ?? 0) + b.calls, input: (a?.input ?? 0) + b.input, output: (a?.output ?? 0) + b.output, cacheRead: (a?.cacheRead ?? 0) + b.cacheRead, cacheWrite: (a?.cacheWrite ?? 0) + b.cacheWrite });

export type Menu = { kind: 'buttons' | 'list'; button?: string; options: { id: string; title: string; description?: string }[] };

/** Write an outgoing line (with buttons or a list when `menu` is given): kept on the chat, and queued for WhatsApp unless this is the in-app test chat. */
export async function say(tx: Tx, t: Tenant, c: Chat, body: string, by: string, simulate: boolean, menu?: Menu) {
  await tx.insert(chatMessage).values({ tenantId: t.id, chatId: c.id, direction: 'out', by, body, options: menu ?? null });
  await tx.update(chat).set({ lastAt: new Date().toISOString() }).where(eq(chat.id, c.id));
  if (simulate) return;
  const cfg = bookingSettings(t.settings).messages;
  const family = await patientsOn(tx, t, c.phone);
  await tx.insert(message).values({ tenantId: t.id, patientId: family.length === 1 ? family[0].id : null, kind: 'chat', channel: 'whatsapp', toPhone: c.phone, body, params: menu ? { interactive: JSON.stringify(menu) } : {},
    status: cfg.enabled && cfg.channel !== 'none' ? 'pending' : 'skipped', error: cfg.enabled && cfg.channel !== 'none' ? null : 'messages are switched off' });
}

const OFF_REPLY = 'Thank you for your message. Our front desk will reply here soon.';

/**
 * One line from a patient (WhatsApp or the test chat). Kept once (WhatsApp resends), then answered by the assistant
 * unless the chat is with the front desk. Any failure hands the chat to the front desk: a patient is never left unanswered.
 */
/** A message WhatsApp delivers this late (Meta retries a refused delivery for hours) is kept for staff but not answered: the reply would come out of order. */
const LATE_MS = 10 * 60_000;

export async function handleIncoming(t: Tenant, inp: { phone: string; text: string; action?: string; ref?: string; origin: string; simulate?: boolean; sentAt?: number }) {
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
  if (inp.sentAt && Date.now() - inp.sentAt > LATE_MS) return { chatId: got.id, status: got.status, late: true as const };
  // Taps, greetings and the booking steps are answered by the fixed menu, without the AI; anything else typed goes on below
  const menuStatus = await menuTurn(t, got, { text, action: inp.action }, !!inp.simulate, inp.origin);
  if (menuStatus) return { chatId: got.id, status: menuStatus };
  const handOff =(reason: string) => inTenant(t, async (tx) => {
    await tx.update(chat).set({ status: 'staff', reason }).where(eq(chat.id, got.id));
    await say(tx, t, got, OFF_REPLY, BY, !!inp.simulate);
  });
  if (!assistantReady(t)) { await handOff('Assistant is off'); return { chatId: got.id, status: 'staff' }; }
  // Only this conversation: lines from the last 12 hours. Older ones speak of another "today" and "tomorrow"; the patient record carries what lasts.
  const since = new Date(Date.now() - 12 * 3600_000).toISOString();
  const lines = await inTenant(t, (tx) => tx.select({ direction: chatMessage.direction, body: chatMessage.body }).from(chatMessage).where(and(eq(chatMessage.chatId, got.id), gt(chatMessage.createdAt, since))).orderBy(desc(chatMessage.createdAt)).limit(20));
  let reply: string | null = null; let used: Usage | null = null;
  try { ({ text: reply, used } = await askClaude(t, got, lines.reverse(), inp.origin)); }
  catch (e) { console.warn('assistant failed', (e as Error).message); }
  if (used) { const u = used; await inTenant(t, async (tx) => { const c = (await tx.select({ usage: chat.usage }).from(chat).where(eq(chat.id, got.id)))[0]; await tx.update(chat).set({ usage: addUsage(c?.usage as any, u) }).where(eq(chat.id, got.id)); }); }
  if (!reply) { await handOff('The assistant could not answer'); return { chatId: got.id, status: 'staff' }; }
  const status = await inTenant(t, async (tx) => {
    const c = (await tx.select().from(chat).where(eq(chat.id, got.id)))[0];
    await say(tx, t, c, reply!, BY, !!inp.simulate);
    return c.status;
  });
  return { chatId: got.id, status };
}
