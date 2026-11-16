// Random sequences of the desk's real money actions, checking after every step that every page tells the same story:
// billed − received + refunded = due − advance; the account, the header, the invoice list, each invoice and its print agree;
// Clinic, Accounts and the Daily report show one "due"; nothing is ever negative; a refund voucher prints what left.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.PGLITE_DIR = './data/test-pglite-moneyfuzz';
process.env.COOKIE_SECRET = 'test-secret';
rmSync(process.env.PGLITE_DIR, { recursive: true, force: true });

const { migrate, applyRls, seedIfEmpty } = { ...(await import('../src/db/index.js')), ...(await import('../src/db/seed.js')) } as any;
const { buildApp } = await import('../src/app.js');

let app: Awaited<ReturnType<typeof buildApp>>;
const as = async (email: string) => {
  const c = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenant: 'sahitya' } })).cookies.find((x) => x.name === 'cc_session')!.value;
  return async (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) => {
    const r = await app.inject({ method, url: '/api' + url, cookies: { cc_session: c }, payload: payload as any });
    assert.ok(r.statusCode < 500, `${method} ${url} → ${r.statusCode} ${r.body}`); // a refusal is fine, a crash never
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
  };
};
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
before(async () => { await migrate(); await applyRls(); await seedIfEmpty(); app = await buildApp(); });
after(async () => { await app.close(); });

// a small seeded random, so a failure can be replayed
const rng = (seed: number) => () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

test('random money actions: every page agrees after every step', async () => {
  const O = await as('owner@demo.clinic'); const R = await as('reception@demo.clinic');
  const cfg = (await O('GET', '/config')).body;
  const peel = cfg.procedures.find((x: any) => x.name === 'Chemical peel'); const hydra = cfg.procedures.find((x: any) => x.pricePaise > 0 && x.id !== peel.id);
  const SEEDS = [11, 23, 37, 41, 59];
  let k = 0; const key = () => `fuzz-key-${String(++k).padStart(4, "0")}`; let slot = 8 * 60;
  const nextTime = () => { slot += 5; return `${String(Math.floor(slot / 60) % 24).padStart(2, '0')}:${String(slot % 60).padStart(2, '0')}`; };

  for (const seed of SEEDS) {
    const r = rng(seed); const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
    const p = (await R('POST', '/patients', { fullName: `Fuzz ${seed}`, phone: `98480${String(seed).padStart(5, '0')}` })).body;
    const v = (await O('POST', '/visits', { patientId: p.id, feeCategoryCode: 'GEN', payment: { method: 'cash', amountPaise: 30000 } })).body;
    const e = (await O('POST', `/visits/${v.id}/encounter`, {})).body;
    await O('PATCH', `/encounters/${e.id}`, { data: { complaint: { chief_complaint: ['Acne'] }, assessment: { diagnosis: [{ name: 'Acne' }] } }, complete: true,
      recommendations: [{ kind: 'procedure', procedureId: peel.id, sittings: 4 }, { kind: 'procedure', procedureId: hydra.id, sittings: 3, amountPaise: 1000000 }] });
    const recs = (await O('GET', `/patients/${p.id}/timeline`)).body.recommendations.filter((x: any) => x.kind === 'procedure');
    const log: string[] = [];

    const check = async () => {
      const acc = (await O('GET', `/patients/${p.id}/account`)).body; const t = acc.totals; const where = `seed ${seed} after: ${log.join(' → ')}`;
      assert.equal(t.billedPaise - t.receivedPaise + t.refundedPaise, t.duePaise - t.advancePaise, `billed − received + refunded = due − advance · ${where}`);
      for (const n of ['billedPaise', 'receivedPaise', 'refundedPaise', 'duePaise', 'advancePaise']) assert.ok(t[n] >= 0, `${n} ≥ 0 · ${where}`);
      const tl = (await O('GET', `/patients/${p.id}/timeline`)).body;
      assert.equal(tl.outstandingPaise, t.duePaise, `header = account · ${where}`);
      const bills = (await O('GET', `/patients/${p.id}/bills`)).body.bills;
      assert.equal(bills.reduce((s: number, b: any) => s + b.duePaise, 0), t.duePaise, `invoice list = account · ${where}`);
      for (const b of bills) {
        const one = (await O('GET', `/bills/${b.id}`)).body;
        assert.equal(one.duePaise, b.duePaise, `invoice view due · ${b.invoiceNo} · ${where}`); assert.equal(one.paidPaise, b.paidPaise, `invoice view paid · ${b.invoiceNo}`);
        const live = one.rows.filter((x: any) => !['cancelled', 'waived'].includes(x.status));
        assert.equal(live.reduce((s: number, x: any) => s + x.amountPaise, 0), one.billedPaise, `print lines = invoice total · ${b.invoiceNo} · ${where}`);
        assert.equal(live.reduce((s: number, x: any) => s + x.creditedPaise, 0), one.creditedPaise, `print credits · ${b.invoiceNo}`);
        assert.equal(one.creditNotes.reduce((s: number, n: any) => s + n.totalPaise, 0), one.creditedPaise, `credit notes listed = credited · ${b.invoiceNo} · ${where}`);
        assert.equal(one.payments.reduce((s: number, x: any) => s + x.amountPaise, 0), one.paidPaise, `print payments = paid · ${b.invoiceNo} · ${where}`);
        assert.ok(one.creditedPaise <= one.billedPaise, `never credited above the invoice · ${b.invoiceNo}`);
        assert.ok(one.paidPaise <= one.billedPaise - one.creditedPaise, `never paid above what it owes (the rest is advance) · ${b.invoiceNo} · ${where}`);
        assert.equal(one.duePaise, one.billedPaise - one.creditedPaise - one.paidPaise, `due = billed − credited − paid · ${b.invoiceNo} · ${where}`);
      }
      for (const a of acc.activity.filter((x: any) => x.type === 'refund' && x.receiptNo)) {
        const v = (await O('GET', `/receipts/${encodeURIComponent(a.receiptNo)}`)).body;
        assert.equal(v.voucher, a.receiptNo.startsWith('RF-')); assert.equal(-v.totalPaise, acc.activity.filter((x: any) => x.type === 'refund' && x.receiptNo === a.receiptNo).reduce((s: number, x: any) => s + x.amountPaise, 0), `voucher prints what left · ${a.receiptNo}`);
      }
      // the clinic's "due" is one figure on every page
      const clinic = (await O('GET', '/owner/summary')).body.dues.totalPaise;
      const accounts = (await O('GET', `/finance?from=${today()}&to=${today()}`)).body.owed.totalPaise;
      const daily = (await O('GET', '/reports/daily')).body.outstanding.total;
      assert.equal(clinic, accounts, `Clinic = Accounts · ${where}`); assert.equal(daily, clinic, `Daily report = Clinic · ${where}`);
      return { acc, bills };
    };

    const amt = (max: number) => Math.max(100, Math.round((r() * max) / 100) * 100);
    const MODES = ['cash', 'upi', 'card', 'bank'];
    const actions: Record<string, () => Promise<unknown>> = {
      invoiceTreatment: async () => { const rec = pick(recs); const off = r() < 0.4 ? 0.1 : 0; const c = (await O('GET', `/courses?patientId=${p.id}`)).body.find((x: any) => x.recommendationId === rec.id);
        const gross = c ? c.uninvoicedPaise : rec.amountPaise || peel.pricePaise * 4; const disc = Math.round(gross * off / 100) * 100;
        const pay = pick([0, amt(gross), gross - disc, gross - disc + 50000]);
        return O('POST', '/bills', { patientId: p.id, idempotencyKey: key(), lines: [{ recommendationId: rec.id, discountPaise: disc }], reason: disc ? 'Fuzz discount' : '', keepExtraAsAdvance: true, parts: pay ? [{ method: pick(MODES), amountPaise: pay, reference: '1' }] : [] }); },
      receptionDiscount: async () => { const rec = pick(recs); const c = (await O('GET', `/courses?patientId=${p.id}`)).body.find((x: any) => x.recommendationId === rec.id);
        const gross = c ? c.uninvoicedPaise : rec.amountPaise || peel.pricePaise * 4; if (!gross) return; const disc = Math.round(gross * 0.2 / 100) * 100;
        return R('POST', '/bills', { patientId: p.id, idempotencyKey: key(), lines: [{ recommendationId: rec.id, discountPaise: disc }], reason: 'Family friend', parts: r() < 0.5 ? [{ method: 'cash', amountPaise: gross - disc }] : [] }); },
      decide: async () => { const a = (await O('GET', '/discount-asks')).body.find((x: any) => x.patientId === p.id); if (a) return O('POST', `/discount-asks/${a.id}/decide`, { action: pick(['approve', 'reject']) }); },
      priceList: async () => { const qty = 1 + Math.floor(r() * 2); return O('POST', '/bills', { patientId: p.id, idempotencyKey: key(), lines: [{ procedureId: hydra.id, qty }], parts: r() < 0.5 ? [{ method: 'cash', amountPaise: amt(hydra.pricePaise * qty) }] : [] }); },
      recordPayment: async () => O('POST', `/patients/${p.id}/payments`, { amountPaise: amt(800000), method: pick(MODES), reference: '7', idempotencyKey: key() }),
      refundInvoice: async () => { const b = pick((await O('GET', `/patients/${p.id}/bills`)).body.bills.filter((x: any) => x.paidPaise > 0)); if (!b) return;
        return O('POST', `/bills/${b.id}/refund`, { parts: [{ method: pick(MODES), amountPaise: Math.min(b.paidPaise, amt(b.paidPaise)) }], reason: 'Fuzz refund', lower: r() < 0.7 }); },
      refundAdvance: async () => { const adv = (await O('GET', `/patients/${p.id}/account`)).body.totals.advancePaise; if (!adv) return;
        return O('POST', `/patients/${p.id}/advance/refund`, { amountPaise: Math.min(adv, amt(adv)), method: pick(MODES), reason: 'Fuzz give back' }); },
      sessionDone: async () => { const rec = pick(recs); const s = (await R('POST', '/procedure-sessions', { recommendationId: rec.id, day: today(), startTime: nextTime(), minutes: 5, force: true })).body;
        if (s?.id) return R('PATCH', `/procedure-sessions/${s.id}`, { state: 'completed' }); },
      fewerSessions: async () => { const rec = pick(recs); const c = (await O('GET', `/courses?patientId=${p.id}`)).body.find((x: any) => x.recommendationId === rec.id); const n = c?.sittings ?? rec.sittings;
        return O('PATCH', '/procedure-plans/edit', { plans: [{ id: rec.id, sittings: Math.max(1, n - 1) }] }); },
      moreSessions: async () => { const rec = pick(recs); const c = (await O('GET', `/courses?patientId=${p.id}`)).body.find((x: any) => x.recommendationId === rec.id); const n = c?.sittings ?? rec.sittings;
        return O('PATCH', '/procedure-plans/edit', { plans: [{ id: rec.id, sittings: Math.min(8, n + 1) }] }); },
      cancelPlan: async () => O('POST', '/procedure-plans/cancel', { ids: [pick(recs).id], reason: 'Fuzz stopped' }),
      addAdvance: async () => O('POST', '/bills', { patientId: p.id, idempotencyKey: key(), keepExtraAsAdvance: true, parts: [{ method: 'upi', amountPaise: amt(500000), reference: '3' }] }),
      refundFee: async () => O('POST', `/charges/${v.charge.id}/adjust`, { kind: 'refunded', reason: 'Fuzz left' }),
    };
    const names = Object.keys(actions);
    await check();
    for (let i = 0; i < 28; i++) {
      const n = pick(names); const res: any = await actions[n](); log.push(`${n}${res?.status && res.status >= 400 ? `(${res.body?.code ?? res.status})` : ''}`);
      await check();
    }
    if (process.env.FUZZ_LOG) console.log(`seed ${seed}: ${log.join(" → ")}`);
    // something real happened in each run
    const { acc } = await check();
    assert.ok(acc.activity.some((a: any) => a.type === 'invoice'), `seed ${seed}: invoices were made: ${log.join(' → ')}`);
  }
});
