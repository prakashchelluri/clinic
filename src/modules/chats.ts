import type { FastifyInstance } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { chat, chatMessage, patient, tenant } from '../db/schema.js';
import { HttpError, can } from '../lib/auth.js';
import { route } from '../lib/route.js';
import { originOf } from '../lib/booking.js';
import { assistantReady, handleIncoming, say } from '../lib/assistant.js';
import { sendNow, whatsappReady } from '../lib/messaging.js';

/** Which clinic a WhatsApp number belongs to: the clinic's own Settings value, else WHATSAPP_CLINIC (one test number, one clinic). */
async function clinicFor(phoneNumberId: string) {
  const all = await db.select().from(tenant).where(eq(tenant.kind, 'clinic'));
  return all.find((t) => t.settings?.messages?.phoneNumberId && t.settings.messages.phoneNumberId === phoneNumberId)
    ?? (process.env.WHATSAPP_PHONE_NUMBER_ID === phoneNumberId ? all.find((t) => t.slug === process.env.WHATSAPP_CLINIC) : undefined);
}

/** Meta signs each webhook with the app secret; without a secret only a test or dev server accepts unsigned calls. */
function signedByMeta(raw: string, header: unknown) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) return process.env.NODE_ENV !== 'production';
  const want = Buffer.from('sha256=' + createHmac('sha256', secret).update(raw).digest('hex'));
  const got = Buffer.from(String(header ?? ''));
  return got.length === want.length && timingSafeEqual(got, want);
}

/** The text of one incoming WhatsApp message: typed text, a reminder button, or a list pick. Anything else (voice, photo) is described. */
function textOf(m: any): string {
  if (m.type === 'text') return m.text?.body ?? '';
  if (m.type === 'button') return m.button?.text ?? m.button?.payload ?? '';
  if (m.type === 'interactive') return m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? '';
  return `[${m.type ?? 'unknown'} message: not readable yet]`; // ponytail: voice notes need speech-to-text; until then the assistant hands these over
}
/** The id of a tapped button or list row (the tap-to-book menu acts on it; lib/chatMenu.ts). */
const actionOf = (m: any): string | undefined => m.interactive?.button_reply?.id ?? m.interactive?.list_reply?.id ?? undefined;

export function chatRoutes(app: FastifyInstance) {
  // A staff reply goes out once its transaction has committed, not at the next minute's run.
  app.addHook('onResponse', async (req, rep) => { if (rep.statusCode < 300 && req.routeOptions.url?.endsWith('/chats/:id/reply')) void sendNow(); });
  // --- WhatsApp Cloud API webhook (public: Meta calls it). The raw body is kept for the signature check. ---
  app.register(async (hook) => {
    hook.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
      (req as any).rawBody = body;
      try { done(null, JSON.parse(body as string)); } catch (e) { done(e as Error, undefined); }
    });
    // Meta's one-time check when the webhook URL is saved in the developer dashboard
    hook.get('/public/whatsapp', async (req, reply) => {
      const q = req.query as Record<string, string>;
      if (q['hub.mode'] === 'subscribe' && process.env.WHATSAPP_VERIFY_TOKEN && q['hub.verify_token'] === process.env.WHATSAPP_VERIFY_TOKEN) return reply.type('text/plain').send(q['hub.challenge']);
      throw new HttpError(403, 'FORBIDDEN');
    });
    hook.post('/public/whatsapp', async (req, reply) => {
      if (!signedByMeta((req as any).rawBody ?? '', req.headers['x-hub-signature-256'])) throw new HttpError(401, 'BAD_SIGNATURE');
      const origin = originOf(req);
      const work: Promise<unknown>[] = [];
      for (const entry of (req.body as any)?.entry ?? []) for (const ch of entry.changes ?? []) {
        const v = ch.value ?? {};
        if (!v.messages?.length) continue; // delivery receipts: nothing to do yet
        const t = await clinicFor(String(v.metadata?.phone_number_id ?? ''));
        if (!t) { req.log.warn({ id: v.metadata?.phone_number_id }, 'whatsapp message for an unknown number'); continue; }
        for (const m of v.messages) work.push(handleIncoming(t as any, { phone: m.from, text: textOf(m), action: actionOf(m), ref: m.id, origin }).then(sendNow).catch((e) => req.log.error(e, 'whatsapp message failed')));
      }
      // Meta wants a quick 200 and resends otherwise; the replies are worked out after answering (lines are kept once by their WhatsApp id)
      void Promise.all(work);
      return reply.code(200).send({ ok: true });
    });
  });

  // --- the Inbox: chats the front desk reads and answers ---
  const PERM = 'appointment.write';
  route(app, 'get', '/chats', 'appointment.read', async (req, tx) => {
    const t = req.ctx.tenantId;
    const { status } = z.object({ status: z.enum(['staff', 'assistant', 'closed', 'all']).default('all') }).parse(req.query);
    const rows = await tx.select().from(chat).where(and(eq(chat.tenantId, t), status === 'all' ? undefined : eq(chat.status, status))).orderBy(desc(chat.lastAt)).limit(200);
    const phones = rows.map((r) => r.phone);
    const people = phones.length ? await tx.select({ id: patient.id, fullName: patient.fullName, phone: patient.phone }).from(patient).where(and(eq(patient.tenantId, t), inArray(patient.phone, phones), isNull(patient.mergedInto))).orderBy(asc(patient.createdAt)) : [];
    const last = rows.length ? await tx.selectDistinctOn([chatMessage.chatId], { chatId: chatMessage.chatId, body: chatMessage.body, by: chatMessage.by, createdAt: chatMessage.createdAt })
      .from(chatMessage).where(inArray(chatMessage.chatId, rows.map((r) => r.id))).orderBy(chatMessage.chatId, desc(chatMessage.createdAt)) : [];
    const lastBy = new Map(last.map((l) => [l.chatId, l]));
    return {
      whatsappConnected: whatsappReady(), assistantOn: assistantReady((await tx.select().from(tenant).where(eq(tenant.id, t)))[0] as any),
      chats: rows.map((r) => ({ ...r, patients: people.filter((p) => p.phone === r.phone).map((p) => ({ id: p.id, fullName: p.fullName })), last: lastBy.get(r.id) ?? null })),
    };
  });
  route(app, 'get', '/chats/:id', 'appointment.read', async (req, tx) => {
    const id = z.string().uuid().parse((req.params as any).id);
    const c = await tx.select().from(chat).where(and(eq(chat.id, id), eq(chat.tenantId, req.ctx.tenantId))).then((r) => r[0]);
    if (!c) throw new HttpError(404, 'NOT_FOUND');
    const lines = await tx.select().from(chatMessage).where(eq(chatMessage.chatId, id)).orderBy(asc(chatMessage.createdAt));
    const patients = await tx.select({ id: patient.id, fullName: patient.fullName, patientNo: patient.patientNo }).from(patient).where(and(eq(patient.tenantId, req.ctx.tenantId), eq(patient.phone, c.phone), isNull(patient.mergedInto)));
    return { ...c, lines, patients };
  });
  const load = async (tx: any, req: any) => {
    const id = z.string().uuid().parse(req.params.id);
    const c = await tx.select().from(chat).where(and(eq(chat.id, id), eq(chat.tenantId, req.ctx.tenantId))).then((r: any[]) => r[0]);
    if (!c) throw new HttpError(404, 'NOT_FOUND');
    return c;
  };
  route(app, 'post', '/chats/:id/read', PERM, async (req, tx) => { const c = await load(tx, req); await tx.update(chat).set({ unread: 0 }).where(eq(chat.id, c.id)); req.audited = true; return { ok: true }; });
  /** The front desk answers. The chat stays with them until they hand it back or close it. */
  route(app, 'post', '/chats/:id/reply', PERM, async (req, tx) => {
    const { text } = z.object({ text: z.string().trim().min(1).max(2000) }).parse(req.body);
    const c = await load(tx, req); const t = (await tx.select().from(tenant).where(eq(tenant.id, req.ctx.tenantId)))[0];
    await say(tx, t as any, c, text, req.ctx.name, false);
    await tx.update(chat).set({ status: 'staff', unread: 0 }).where(eq(chat.id, c.id));
    return { ok: true };
  });
  /** Hand back to the assistant, or close (the next patient line opens it again with the assistant). */
  route(app, 'post', '/chats/:id/status', PERM, async (req, tx) => {
    const { status } = z.object({ status: z.enum(['assistant', 'closed', 'staff']) }).parse(req.body);
    const c = await load(tx, req);
    await tx.update(chat).set({ status, reason: status === 'staff' ? 'Taken by the front desk' : null, unread: 0 }).where(eq(chat.id, c.id));
    return { ok: true };
  });

  /** Test chat: type as a patient from inside the app. The same code as real WhatsApp, but nothing is sent to a phone. */
  app.post('/chats/simulate', async (req) => {
    if (!can(req.perms, PERM)) throw new HttpError(403, `FORBIDDEN:${PERM}`);
    const b = z.object({ phone: z.string().trim(), text: z.string().trim().min(1).max(2000), action: z.string().max(200).optional() }).parse(req.body);
    const t = (await db.select().from(tenant).where(eq(tenant.id, req.ctx.tenantId)))[0];
    const r = await handleIncoming(t as any, { phone: b.phone, text: b.text, action: b.action, origin: originOf(req), simulate: true });
    return r;
  });
}
