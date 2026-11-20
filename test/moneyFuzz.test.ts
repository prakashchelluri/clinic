// Random sequences of the desk's real money actions, checking after every step that every page tells the same story AND that it is the
// right story, worked out here on its own (an oracle), not taken from the code under test:
// - the books: billed − received + refunded = due − advance; header, invoice list, invoice view and print agree; one "due" on every page;
// - an issued invoice never changes (each one is kept as first seen and compared every step), and its lines keep their order;
// - sessions: what the invoices bill, less the sessions credit notes took back, plus what is not invoiced = the sessions planned,
//   and sessions not invoiced always have a price (nothing is ever free);
// - credit notes: each comes off named lines, never more than is left of a line, and on a Tax Invoice its GST adds up to it;
// - refunds: the same request sent twice at once is one refund; a voucher prints what left.
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
  // a GST-registered clinic with one 18% item, so credit notes reverse real tax
  assert.equal((await O('PATCH', '/admin/clinic', { settings: { gstin: '27AAPFU0939F1ZV' } })).status, 200);
  assert.equal((await O('PATCH', `/admin/procedures/${hydra.id}`, { taxRateBp: 1800 })).status, 200);
  const issued = new Map<string, string>(); // each invoice as first seen
  const SEEDS = [11, 23, 37, 41, 59, 67, 71];
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
      const credits = new Map<string, any>(); const issuedRows = new Map<string, any[]>();
      for (const b of bills) issuedRows.set(b.id, (await O('GET', `/bills/${b.id}`)).body.rows);
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
        // never changed after it was issued (only a cancel may mark a line), and printed in the order entered
        const shape = JSON.stringify(one.rows.map((x: any) => [x.lineNo, x.description, x.listPaise, x.discountPaise, x.amountPaise, x.taxRateBp, x.sessions]));
        if (!issued.has(b.id)) issued.set(b.id, shape); else assert.equal(shape, issued.get(b.id), `issued invoice ${b.invoiceNo} changed · ${where}`);
        assert.deepEqual(one.rows.map((x: any) => x.lineNo), one.rows.map((_: any, i: number) => i + 1), `lines in order · ${b.invoiceNo}`);
        for (const x of one.rows) assert.ok(x.creditedPaise <= x.amountPaise, `a line credited above itself · ${b.invoiceNo} · ${where}`);
        for (const n of one.creditNotes) {
          const cn = (await O('GET', `/credit-notes/${n.id}`)).body;
          assert.equal(cn.lines.reduce((s: number, l: any) => s + l.amountPaise, 0), cn.totalPaise, `credit note lines add up · ${cn.creditNo}`);
          for (const l of cn.lines) assert.ok(one.rows.some((x: any) => x.id === l.chargeId), `credit note off a line of its own invoice · ${cn.creditNo}`);
          if (one.taxGstin) { assert.equal(cn.gst.rates.reduce((s: number, x: any) => s + x.taxablePaise + x.cgstPaise + x.sgstPaise, 0), cn.totalPaise, `credit note GST adds up · ${cn.creditNo} · ${where}`);
            for (const x of cn.gst.rates) if (x.rateBp) assert.ok(cn.lines.some((l: any) => l.taxRateBp === x.rateBp), `GST reversed only at the rates of the items named · ${cn.creditNo}`); }
          credits.set(n.id, cn);
        }
      }
      // sessions, counted here from the invoices and credit notes themselves
      for (const c of (await O('GET', `/courses?patientId=${p.id}`)).body) {
        const rows = bills.flatMap((b: any) => (issuedRows.get(b.id) ?? [])).filter((x: any) => x.courseId === c.id && !['cancelled', 'waived'].includes(x.status));
        const billed = rows.reduce((s: number, x: any) => s + (x.sessions ?? 0), 0);
        const takenBack = [...credits.values()].flatMap((cn: any) => cn.lines).filter((l: any) => rows.some((x: any) => x.id === l.chargeId)).reduce((s: number, l: any) => s + (l.sessions ?? 0), 0);
        assert.equal(c.invoicedSessions, Math.max(0, billed - takenBack), `sessions invoiced = billed − taken back · ${where}`);
        assert.equal(c.invoicedSessions + c.uninvoicedSessions, Math.max(c.sittings, c.invoicedSessions), `every planned session is invoiced or still to invoice · ${where}`);
        if (c.uninvoicedSessions > 0) assert.ok(c.uninvoicedPaise > 0, `sessions not invoiced are never free · ${where}`);
        else assert.equal(c.uninvoicedPaise, 0, `nothing to invoice when every session is invoiced · ${where}`);
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
      decide: async () => { const a = (await O('GET', '/discount-asks')).body.find((x: any) => x.patientId === p.id); if (!a) return; const res = await O('POST', `/discount-asks/${a.id}/decide`, { action: pick(['approve', 'reject']) }); assert.equal(res.status, 200, 'a discount request can always be decided'); return res; },
      priceList: async () => { const qty = 1 + Math.floor(r() * 2); return O('POST', '/bills', { patientId: p.id, idempotencyKey: key(), lines: [{ procedureId: hydra.id, qty }], parts: r() < 0.5 ? [{ method: 'cash', amountPaise: amt(hydra.pricePaise * qty) }] : [] }); },
      recordPayment: async () => { const emi = r() < 0.25; const owed = (await O('GET', `/patients/${p.id}/account`)).body.totals.collectablePaise;
        if (emi && !owed) return; const amount = emi ? Math.min(owed, amt(owed)) : amt(800000);
        return O('POST', `/patients/${p.id}/payments`, { amountPaise: amount, method: emi ? 'emi' : pick(MODES), reference: '7', ...(emi ? { lender: 'Bajaj' } : {}), idempotencyKey: key() }); },
      emiTooMuch: async () => { const owed = (await O('GET', `/patients/${p.id}/account`)).body.totals.collectablePaise;
        const res = await O('POST', `/patients/${p.id}/payments`, { amountPaise: owed + 10000, method: 'emi', reference: '8', lender: 'Bajaj', idempotencyKey: key() });
        assert.equal(res.status, 400, 'EMI above what is due is refused'); return res; },
      settleEmi: async () => { const e = pick((await O('GET', '/payments/awaiting')).body.filter((x: any) => x.patient === p.fullName)) as any; if (e) return O('POST', `/payments/${e.id}/settle`, { feePaise: 0 }); },
      refundInvoice: async () => { const b = pick((await O('GET', `/patients/${p.id}/bills`)).body.bills.filter((x: any) => x.paidPaise > 0)); if (!b) return;
        const lower = r() < 0.7;
        const live = b.lines.filter((c: any) => !['cancelled', 'waived'].includes(c.status)).map((c: any) => { const paid = b.paidOn[c.id] ?? 0; return { id: c.id, room: lower ? Math.min(paid, c.amountPaise - (b.creditedOn[c.id] ?? 0)) : paid }; }).filter((c: any) => c.room > 0);
        const target = pick(live) as any; if (!target) return;
        const amount = Math.min(target.room, amt(target.room));
        const res = await O('POST', `/bills/${b.id}/refund`, { parts: [{ method: pick(MODES), amountPaise: amount }], reason: 'Fuzz refund', lower, idempotencyKey: key(), lines: [{ chargeId: target.id, amountPaise: amount }] });
        if (res.status === 200) { const after = (await O('GET', `/bills/${b.id}`)).body; // a refund only takes money off the item it names
          for (const c of b.lines) if (c.id !== target.id) assert.equal(after.paidOn[c.id] ?? 0, b.paidOn[c.id] ?? 0, `a refund took money off another item · ${b.invoiceNo}`); }
        return res; },
      takeItemOff: async () => { const b = pick((await O('GET', `/patients/${p.id}/bills`)).body.bills.filter((x: any) => x.status !== 'cancelled' && !x.pharmacy)); if (!b) return;
        const c = pick(b.lines.filter((x: any) => !['cancelled', 'waived'].includes(x.status) && x.amountPaise - (b.creditedOn[x.id] ?? 0) > 0)) as any; if (!c) return;
        const left = c.amountPaise - (b.creditedOn[c.id] ?? 0); const before = (await O('GET', `/patients/${p.id}/account`)).body.totals;
        const res = await O('POST', `/bills/${b.id}/credit`, { lines: [{ chargeId: c.id, amountPaise: Math.min(left, amt(left)) }], reason: 'Fuzz not given', idempotencyKey: key() });
        if (res.status === 200) assert.equal((await O('GET', `/patients/${p.id}/account`)).body.totals.refundedPaise, before.refundedPaise, 'taking an item off hands no money over');
        return res; },
      waivePaid: async () => { const b = pick((await O('GET', `/patients/${p.id}/bills`)).body.bills.filter((x: any) => x.paidPaise > 0 || x.creditedPaise > 0)); if (!b) return;
        const c = b.lines.find((x: any) => (b.paidOn[x.id] ?? 0) > 0 || (b.creditedOn[x.id] ?? 0) > 0); if (!c) return;
        const res = await O('POST', `/charges/${c.id}/adjust`, { kind: 'waived', reason: 'Fuzz waive' });
        assert.equal(res.status, 409, 'a line with money or a credit note is never waived'); return res; },
      doubleRefund: async () => { const b = pick((await O('GET', `/patients/${p.id}/bills`)).body.bills.filter((x: any) => x.paidPaise >= 200)); if (!b) return;
        const c = b.lines.find((x: any) => (b.paidOn[x.id] ?? 0) >= 100); if (!c) return;
        const body = { parts: [{ method: 'cash', amountPaise: 100 }], lines: [{ chargeId: c.id, amountPaise: 100 }], reason: 'Fuzz retry', lower: false, idempotencyKey: key() };
        const [a, d] = await Promise.all([O('POST', `/bills/${b.id}/refund`, body), O('POST', `/bills/${b.id}/refund`, body)]);
        if (a.status === 200 && d.status === 200) assert.equal(a.body.receiptNo, d.body.receiptNo, 'the same refund sent twice at once is one refund');
        return a; },
      collectDiscount: async () => { const b = pick((await O('GET', `/patients/${p.id}/bills`)).body.bills.filter((x: any) => x.status === 'unpaid' && !x.pharmacy)); if (!b) return;
        const c = b.lines.find((x: any) => x.status === 'due' && !x.visitId); if (!c) return;
        return O('POST', '/bills', { patientId: p.id, idempotencyKey: key(), lines: [{ chargeId: c.id, discountPaise: Math.round(c.amountPaise * 0.1 / 100) * 100 }], reason: 'Fuzz collect discount' }); },
      cutThenAddBack: async () => { const rec = pick(recs); const c = (await O('GET', `/courses?patientId=${p.id}`)).body.find((x: any) => x.recommendationId === rec.id); if (!c || c.sittings < 3) return;
        await O('PATCH', '/procedure-plans/edit', { plans: [{ id: rec.id, sittings: c.sittings - 2 }] });
        return O('PATCH', '/procedure-plans/edit', { plans: [{ id: rec.id, sittings: c.sittings - 1 }] }); },
      refundAdvance: async () => { const tt = (await O('GET', `/patients/${p.id}/account`)).body.totals; const adv = tt.advancePaise; if (!adv) return;
        const amount = Math.min(adv, amt(adv));
        const res = await O('POST', `/patients/${p.id}/advance/refund`, { amountPaise: amount, method: pick(MODES), reason: 'Fuzz give back', idempotencyKey: key() });
        if (amount > adv - tt.emiHeldPaise) assert.equal(res.status, 400, 'EMI the lender has not paid is never given back'); // the oracle: never refund unsettled EMI
        return res; },
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
    for (let i = 0; i < 32; i++) {
      const n = pick(names); const res: any = await actions[n](); log.push(`${n}${res?.status && res.status >= 400 ? `(${res.body?.code ?? res.status})` : ''}`);
      await check();
    }
    if (process.env.FUZZ_LOG) console.log(`seed ${seed}: ${log.join(" → ")}`);
    // something real happened in each run
    const { acc } = await check();
    assert.ok(acc.activity.some((a: any) => a.type === 'invoice'), `seed ${seed}: invoices were made: ${log.join(' → ')}`);
  }
  await O('PATCH', '/admin/clinic', { settings: { gstin: '' } }); await O('PATCH', `/admin/procedures/${hydra.id}`, { taxRateBp: 0 });
});
