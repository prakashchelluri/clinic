import { randomBytes } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { Tx } from '../db/index.js';
import { appointment, message, patient, practitioner, service, session, tenant } from '../db/schema.js';

/** Clinic booking settings with defaults, so a clinic that never opened Settings still works sensibly. */
export function bookingSettings(settings: any) {
  const s = settings ?? {};
  return {
    arriveEarlyMinutes: s.scheduling?.arriveEarlyMinutes ?? 35,
    booking: { cancelWindowHours: 4, patientCanReschedule: true, cancellationPolicy: '', noShowWarnAt: 2, ...(s.booking ?? {}) },
    online: { enabled: false, requireApproval: true, minNoticeHours: 2, maxDaysAhead: 30, dailyCap: 0, intro: '', ...(s.online ?? {}) },
    messages: {
      enabled: true, channel: 'whatsapp', sendConfirmation: true, reminderHours: [24, 2], language: 'en',
      ...(s.messages ?? {}),
      templates: { ...DEFAULT_TEMPLATES, ...(s.messages?.templates ?? {}) },
      providerTemplates: { ...(s.messages?.providerTemplates ?? {}) },
    },
  };
}

export const MESSAGE_KINDS = ['confirmation', 'requested', 'reminder', 'moved', 'cancelled', 'declined', 'late', 'reschedule'] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];
export const DEFAULT_TEMPLATES: Record<MessageKind, string> = {
  confirmation: 'Hello {patient}, your {visitType} at {clinic} is booked for {date}, {time} with {doctor}. Please arrive by {arriveBy}. Confirm, cancel or change: {link}',
  requested: 'Hello {patient}, we received your request for {date}, {time} at {clinic}. We will confirm shortly. Details: {link}',
  reminder: 'Reminder: {visitType} at {clinic} on {date}, {time}. Please arrive by {arriveBy}. Reply or tap to confirm or cancel: {link}',
  moved: 'Hello {patient}, your visit at {clinic} is now on {date}, {time} with {doctor}. Arrive by {arriveBy}. Details: {link}',
  cancelled: 'Hello {patient}, your visit at {clinic} on {date}, {time} has been cancelled. Call us to book again.',
  declined: 'Hello {patient}, sorry, {clinic} could not take the {date}, {time} request. {reason} Please pick another time: {bookLink}',
  late: 'Hello {patient}, {doctor} at {clinic} is running about {reason} late today. Your {time} visit will start a little later. Sorry for the wait.',
  reschedule: 'Hello {patient}, {doctor} is not available for your visit on {date}, {time} at {clinic}. {reason} Please pick another time: {link}',
};
export const TEMPLATE_VARS = ['patient', 'clinic', 'visitType', 'date', 'time', 'arriveBy', 'doctor', 'link', 'bookLink', 'reason'];

export const newToken = () => randomBytes(18).toString('base64url');
const hm = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** UTC instant of a local wall-clock time in a timezone (two passes settle DST edges; India has none). */
export function localToUtc(day: string, time: string, tz: string): Date {
  const guess = new Date(`${day}T${time}:00Z`);
  const offset = (d: Date) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(d).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - d.getTime();
  };
  let t = guess.getTime() - offset(guess); t = guess.getTime() - offset(new Date(t));
  return new Date(t);
}
export const hoursUntil = (day: string, time: string, tz: string, now = new Date()) => (localToUtc(day, time, tz).getTime() - now.getTime()) / 3_600_000;

/** Everything a message or the patient page shows about one appointment. */
export async function appointmentView(tx: Tx, tenantId: string, appointmentId: string) {
  const r = await tx.select({ a: appointment, s: session, p: patient, svc: service, doc: practitioner.name, t: tenant })
    .from(appointment).innerJoin(session, eq(session.id, appointment.sessionId)).innerJoin(patient, eq(patient.id, appointment.patientId))
    .innerJoin(tenant, eq(tenant.id, appointment.tenantId))
    .leftJoin(service, eq(service.id, appointment.serviceId)).leftJoin(practitioner, eq(practitioner.id, session.practitionerId))
    .where(and(eq(appointment.id, appointmentId), eq(appointment.tenantId, tenantId))).then((x) => x[0]);
  return r ?? null;
}

export function renderVars(v: NonNullable<Awaited<ReturnType<typeof appointmentView>>>, origin: string, extra: Record<string, string> = {}) {
  const cfg = bookingSettings(v.t.settings);
  const date = new Date(v.s.day + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  return {
    patient: v.p.fullName, clinic: v.t.name, visitType: v.svc?.name ?? 'visit', date, time: `${v.s.startTime}–${v.s.endTime}`,
    arriveBy: hhmm(Math.max(0, hm(v.s.startTime) - cfg.arriveEarlyMinutes)), doctor: v.doc ?? 'the doctor',
    link: v.a.publicToken ? `${origin}/a/${v.t.slug}/${v.a.publicToken}` : '', bookLink: `${origin}/book/${v.t.slug}`, reason: '', ...extra,
  } as Record<string, string>;
}
export const fill = (tpl: string, vars: Record<string, string>) => tpl.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)).replace(/\s+\./g, '.').trim();

/** Queue one message for an appointment. Rendered now, so later setting changes never alter what was promised. */
export async function queueMessage(tx: Tx, tenantId: string, appointmentId: string, kind: MessageKind, origin: string, opts: { sendAfter?: Date; extra?: Record<string, string> } = {}) {
  const v = await appointmentView(tx, tenantId, appointmentId); if (!v) return null;
  const cfg = bookingSettings(v.t.settings).messages;
  const vars = renderVars(v, origin, opts.extra);
  const noPhone = !v.p.phone || !/^\d{10}$/.test(v.p.phone);
  const status = !cfg.enabled || cfg.channel === 'none' || noPhone ? 'skipped' : 'pending';
  const [row] = await tx.insert(message).values({ tenantId, patientId: v.p.id, appointmentId, kind, channel: cfg.channel, toPhone: v.p.phone, body: fill(cfg.templates[kind] ?? DEFAULT_TEMPLATES[kind], vars),
    params: vars, status, sendAfter: (opts.sendAfter ?? new Date()).toISOString(), error: status === 'skipped' ? (noPhone ? 'no mobile number' : 'messages are switched off') : null }).returning();
  return row;
}

/** Drop reminders not yet sent (on cancel or move), then plan fresh ones for the appointment's current window. */
export async function planReminders(tx: Tx, tenantId: string, appointmentId: string, origin: string) {
  await tx.update(message).set({ status: 'skipped', error: 'replaced' }).where(and(eq(message.tenantId, tenantId), eq(message.appointmentId, appointmentId), eq(message.kind, 'reminder'), eq(message.status, 'pending')));
  const v = await appointmentView(tx, tenantId, appointmentId); if (!v) return;
  if (!['booked', 'confirmed'].includes(v.a.status)) return;
  const cfg = bookingSettings(v.t.settings).messages;
  const start = localToUtc(v.s.day, v.s.startTime, v.t.timezone).getTime();
  for (const h of cfg.reminderHours as number[]) {
    const at = new Date(start - h * 3_600_000);
    if (at.getTime() > Date.now()) await queueMessage(tx, tenantId, appointmentId, 'reminder', origin, { sendAfter: at });
  }
}
export async function dropReminders(tx: Tx, tenantId: string, appointmentIds: string[]) {
  if (!appointmentIds.length) return;
  await tx.update(message).set({ status: 'skipped', error: 'appointment closed' }).where(and(eq(message.tenantId, tenantId), inArray(message.appointmentId, appointmentIds), eq(message.status, 'pending')));
}

/** Base URL for patient links: the configured public URL, else the address the request came in on. */
export const originOf = (req: { protocol: string; headers: Record<string, any> }) =>
  process.env.APP_URL?.replace(/\/$/, '') ?? `${req.headers['x-forwarded-proto'] ?? req.protocol}://${req.headers['x-forwarded-host'] ?? req.headers.host}`;
