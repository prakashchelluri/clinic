import { and, asc, eq, lte } from 'drizzle-orm';
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
  const payload = tpl
    ? { messaging_product: 'whatsapp', to, type: 'template', template: { name: tpl, language: { code: language === 'te' ? 'te' : 'en' }, components: [{ type: 'body', parameters: ['patient', 'date', 'time', 'doctor', 'link'].map((k) => ({ type: 'text', text: m.params[k] || '-' })) }] } }
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

/** Send everything due, clinic by clinic (each inside its own RLS scope). Failures retry up to 3 times. */
export async function dispatchDue(now = new Date()) {
  let done = 0;
  for (const t of await db.select().from(tenant).where(eq(tenant.kind, 'clinic'))) {
    const cfg = bookingSettings(t.settings).messages;
    await withTenant(t.id, SYSTEM_USER, async (tx) => {
      const due = await tx.select().from(message).where(and(eq(message.tenantId, t.id), eq(message.status, 'pending'), lte(message.sendAfter, now.toISOString()))).orderBy(asc(message.sendAfter)).limit(50);
      for (const m of due) {
        const r = await sendWhatsapp(m, cfg.providerTemplates, cfg.language);
        const attempts = m.attempts + 1;
        const status = r.status === 'failed' && attempts < 3 ? 'pending' : r.status;
        await tx.update(message).set({ status, attempts, sentAt: r.status === 'failed' ? null : now.toISOString(), providerRef: r.ref ?? null, error: r.error ?? null,
          sendAfter: status === 'pending' ? new Date(now.getTime() + attempts * 5 * 60_000).toISOString() : m.sendAfter }).where(eq(message.id, m.id));
        done++;
      }
    });
  }
  return done;
}

export function startDispatcher(everyMs = 60_000) {
  let busy = false;
  const tick = async () => { if (busy) return; busy = true; try { await dispatchDue(); } catch (e) { console.warn('message dispatch failed', (e as Error).message); } finally { busy = false; } };
  const h = setInterval(tick, everyMs); h.unref?.(); void tick();
  return () => clearInterval(h);
}
