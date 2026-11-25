import { and, asc, eq, inArray, lte } from 'drizzle-orm';
import { db, withTenant } from '../db/index.js';
import { message, tenant } from '../db/schema.js';
import { bookingSettings } from './booking.js';

const SYSTEM_USER = '00000000-0000-0000-0000-000000000000';

/** Is a real WhatsApp sender configured? Without it messages are kept as "logged" in the outbox, never lost. */
export const whatsappReady = () => !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);

type Outgoing = { toPhone: string | null; body: string; kind: string; params: Record<string, string> };
type Result = { status: 'sent' | 'logged' | 'failed'; ref?: string; error?: string };

/**
 * WhatsApp Cloud API. Business-initiated messages need a Meta-approved template: when the clinic maps a kind to a
 * template name, it is sent with body parameters patient, date, time, doctor, link (in that order). Without a
 * template the plain text is sent, which Meta only delivers inside a 24-hour customer-service window.
 */
async function sendWhatsapp(m: Outgoing, providerTemplates: Record<string, string>, language: string): Promise<Result> {
  if (!whatsappReady()) return { status: 'logged' };
  const to = '91' + m.toPhone;
  const tpl = providerTemplates[m.kind];
  const lang = m.params?.lang ?? language; // the language the message was written in for this patient
  const payload = tpl
    ? { messaging_product: 'whatsapp', to, type: 'template', template: { name: tpl, language: { code: ['te', 'hi'].includes(lang) ? lang : 'en' }, components: [{ type: 'body', parameters: ['patient', 'date', 'time', 'doctor', 'link'].map((k) => ({ type: 'text', text: m.params[k] || '-' })) }] } }
    : { messaging_product: 'whatsapp', to, type: 'text', text: { body: m.body } };
  try {
    const r = await fetch(`https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: 'POST', headers: { authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) return { status: 'failed', error: String(j?.error?.message ?? `HTTP ${r.status}`).slice(0, 300) };
    return { status: 'sent', ref: j?.messages?.[0]?.id };
  } catch (e: any) { return { status: 'failed', error: String(e?.message ?? e).slice(0, 300) }; }
}

const LEASE_MS = 10 * 60_000;           // a claimed message is hidden this long: a crash mid-send frees it again, a second server never takes it
const REMINDER_LATE_MS = 6 * 3_600_000; // a reminder this overdue (the server was asleep) is dropped, never sent after the visit

/** Send everything due, clinic by clinic. Rows are claimed in a short transaction and sent outside it, so a slow WhatsApp call holds no
 *  database lock and two servers never send the same message. Failures retry up to 3 times. */
export async function dispatchDue(now = new Date()) {
  let done = 0;
  for (const t of await db.select().from(tenant).where(eq(tenant.kind, 'clinic'))) {
    const cfg = bookingSettings(t.settings).messages;
    const due = await withTenant(t.id, SYSTEM_USER, async (tx) => {
      await tx.update(message).set({ status: 'skipped', error: 'too late to send' })
        .where(and(eq(message.tenantId, t.id), eq(message.kind, 'reminder'), inArray(message.status, ['pending', 'sending']), lte(message.sendAfter, new Date(now.getTime() - REMINDER_LATE_MS).toISOString())));
      const ids = (await tx.select({ id: message.id }).from(message).where(and(eq(message.tenantId, t.id), inArray(message.status, ['pending', 'sending']), lte(message.sendAfter, now.toISOString())))
        .orderBy(asc(message.sendAfter)).limit(50).for('update', { skipLocked: true })).map((r) => r.id);
      return ids.length ? tx.update(message).set({ status: 'sending', sendAfter: new Date(now.getTime() + LEASE_MS).toISOString() }).where(inArray(message.id, ids)).returning() : [];
    });
    for (const m of due) {
      const r = await sendWhatsapp(m, cfg.providerTemplates, cfg.language);
      const attempts = m.attempts + 1;
      const status = r.status === 'failed' && attempts < 3 ? 'pending' : r.status;
      await withTenant(t.id, SYSTEM_USER, (tx) => tx.update(message).set({ status, attempts, sentAt: r.status === 'failed' ? null : now.toISOString(), providerRef: r.ref ?? null, error: r.error ?? null,
        sendAfter: status === 'pending' ? new Date(now.getTime() + attempts * 5 * 60_000).toISOString() : now.toISOString() }).where(eq(message.id, m.id)));
      done++;
    }
  }
  return done;
}

export function startDispatcher(everyMs = 60_000) {
  let busy = false;
  const tick = async () => { if (busy) return; busy = true; try { await dispatchDue(); } catch (e) { console.warn('message dispatch failed', (e as Error).message); } finally { busy = false; } };
  const h = setInterval(tick, everyMs); h.unref?.(); void tick();
  return () => clearInterval(h);
}
