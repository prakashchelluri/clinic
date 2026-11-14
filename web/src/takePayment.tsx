import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useOutletContext } from 'react-router';
import { get, post, qc, errText } from './api';
import { can } from './App';
import { Chip, Icon, Modal, MoneyInput, Section, money, toPaise, toast, fmtDate } from './ui';
import { printReceipt } from './invoices';

/** The money codes the server sends, in the desk's words. */
export function moneyErr(e: any): string {
  const b = e?.body; const c = b?.code;
  if (c === 'MORE_THAN_DUE') return b.duePaise ? `That is more than the ${money(b.duePaise)} due.` : 'Nothing is due on this any more.';
  if (c === 'MORE_THAN_FEE') return `That is more than the ${money(b.feePaise)} fee.`;
  if (c === 'DAY_CLOSED') return 'Today has been closed: no money can be taken or given back today.';
  if (c === 'ALREADY_REFUNDED') return 'This was already refunded.';
  if (c === 'PAY_AHEAD_IN_FULL') return `Sittings paid ahead are paid in full: take at least ${money(b.needPaise)}.`;
  if (c === 'REASON_REQUIRED') return 'Say why there is a discount.';
  if (c === 'NO_DISCOUNT_ON_CONSULTATION') return 'Consultation fees take no discount.';
  if (c === 'NO_DISCOUNT_ON_PHARMACY') return 'Pharmacy bills take their discount at the counter.';
  if (c === 'DISCOUNT_ONLY_BEFORE_PAYMENT') return 'A discount can only be given before any money is taken on that invoice.';
  if (c === 'DISCOUNT_ALREADY_WAITING') return 'A discount on this is already waiting for approval.';
  if (c === 'DISCOUNT_MORE_THAN_THE_ITEM') return `The discount is the whole of ${b.what}. Ask for it to be waived instead.`;
  if (c === 'NOTHING_DUE') return 'Nothing is due on one of these any more. Close and open again.';
  if (c === 'NOTHING_LEFT_TO_PAY_AHEAD') return 'Every sitting of this course is already paid.';
  if (c === 'NO_PRICE_ON_THE_PRICE_LIST') return 'This has no price on the price list. Set it in Settings › Consultation types or Procedures & packages.';
  if (c === 'MORE_THAN_THE_ADVANCE') return `Only ${money(b.balancePaise)} is left in the advance.`;
  if (c === 'NOTHING_TO_BILL') return 'Add an item, or type an amount to take as advance.';
  return errText(e);
}
const MODE_NAME: Record<string, string> = { cash: 'cash', upi: 'UPI', card: 'card', emi: 'EMI', bank: 'bank transfer', advance: 'the advance' };

type Part = { method: 'cash' | 'upi' | 'card' | 'bank' | 'emi' | 'advance'; amount: string; reference: string; lender: string };
const MODES: [Part['method'], string][] = [['upi', 'UPI'], ['cash', 'Cash'], ['card', 'Card'], ['emi', 'EMI'], ['bank', 'Bank']];
type Unit = 'pct' | 'rs';
type Line = { key: string; kind: 'charge' | 'proc' | 'service' | 'ahead'; id: string; packageId?: string; what: string; sub: string; unitPaise: number; qty: number; maxQty: number; capPaise?: number; on: boolean; dv: string; unit: Unit; noDiscount?: string; prior: number; taxBp: number };
/** GST inside a price that includes it. */
const gstIn = (paise: number, bp: number) => (bp ? paise - Math.round((paise * 10000) / (10000 + bp)) : 0);
export const BILL_KEYS = ['timeline', 'frontdesk', 'daily', 'payments-awaiting', 'patients', 'courses', 'discount-asks', 'worklist', 'procedure-plans', 'clinic'];
const refresh = () => BILL_KEYS.forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
const num = (s: string) => Math.max(0, Number(s) || 0);
const offOf = (gross: number, v: string, unit: Unit) => Math.min(gross, unit === 'pct' ? Math.round((gross * Math.min(100, num(v))) / 100) : toPaise(v));

/** % or ₹: one small switch, the same on every line and on the bill. */
function UnitSwitch({ unit, onChange, label }: { unit: Unit; onChange: (u: Unit) => void; label: string }) {
  return <span className="inline-flex shrink-0 rounded-lg bg-surface-2 p-0.5" role="group" aria-label={label}>{(['pct', 'rs'] as Unit[]).map((u) =>
    <button key={u} type="button" aria-pressed={unit === u} className={`h-7 min-w-7 rounded-md px-1.5 text-[13px] font-bold ${unit === u ? 'bg-surface text-ink shadow-sm' : 'text-muted'}`} onClick={() => onChange(u)}>{u === 'pct' ? '%' : '₹'}</button>)}</span>;
}
function DiscountBox({ v, unit, onV, onUnit, label, disabled }: { v: string; unit: Unit; onV: (v: string) => void; onUnit: (u: Unit) => void; label: string; disabled?: boolean }) {
  return <span className="inline-flex items-center gap-1.5"><input className="input !h-9 !w-20 text-right tabular-nums" inputMode="decimal" autoComplete="off" aria-label={label} disabled={disabled} placeholder="0" value={v}
    onChange={(e) => { let x = e.target.value.replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1'); if (unit === 'pct' && Number(x) > 100) x = '100'; onV(x.slice(0, 9)); }} /><UnitSwitch unit={unit} onChange={onUnit} label={`${label} in`} /></span>;
}

/**
 * Add bill / payment: one screen for every rupee the desk takes outside check-in and the pharmacy.
 * Invoices already due, items from the price list and sittings paid ahead; a discount per line and one off the whole bill (% or ₹);
 * up to four payment modes; part payment leaves the rest due. Prices come from the price list: a reduction is a discount,
 * and above the clinic limit (or from someone without the discount permission) it waits for an approver.
 */
export function TakePayment({ patientId, patientName, ahead, onlyBill, onClose }: { patientId: string; patientName: string; ahead?: { recommendationId: string }; onlyBill?: string; onClose: () => void }) {
  const { cfg, perms } = useOutletContext<any>();
  const t = useQuery({ queryKey: ['timeline', patientId], queryFn: () => get(`/patients/${patientId}/timeline`) });
  const cs = useQuery({ queryKey: ['courses', patientId], queryFn: () => get(`/courses?patientId=${patientId}`) });
  const asks = useQuery({ queryKey: ['discount-asks', patientId], queryFn: () => get(`/discount-asks?patientId=${patientId}`) });
  const adv = useQuery({ queryKey: ['advance', patientId], queryFn: () => get(`/patients/${patientId}/advance`) });
  const bl = useQuery({ queryKey: ['bills', 'patient', patientId], queryFn: () => get(`/patients/${patientId}/bills`) });
  const ready = t.data && cs.data && asks.data && adv.data && bl.data;
  return (
    <Modal title="Add bill / payment" subtitle={`${patientName} · prices from the clinic price list, GST included`} onClose={onClose} width="max-w-6xl">
      {!ready ? <div className="text-sm text-muted">Loading…</div> : <BillForm patientId={patientId} patientName={patientName} ahead={ahead} onlyBill={onlyBill} invoiceNo={Object.fromEntries((bl.data?.bills ?? []).map((b: any) => [b.id, b.invoiceNo]))} tl={t.data} courses={cs.data} asks={asks.data} advPaise={adv.data.balancePaise} cfg={cfg} perms={perms} onClose={onClose} />}
    </Modal>
  );
}

function BillForm({ patientId, patientName, ahead, onlyBill, invoiceNo, tl, courses, asks, advPaise, cfg, perms, onClose }: { patientId: string; patientName: string; ahead?: { recommendationId: string }; onlyBill?: string; invoiceNo: Record<string, string>; tl: any; courses: any[]; asks: any[]; advPaise: number; cfg: any; perms: string[]; onClose: () => void }) {
  const waiting = useMemo(() => { const m = new Map<string, number>(); for (const a of asks.filter((x) => x.status === 'pending')) for (const l of a.lines) m.set(l.chargeId ?? l.courseId, (m.get(l.chargeId ?? l.courseId) ?? 0) + l.offPaise); return m; }, [asks]);
  const paidOn = (id: string) => tl.payments.filter((p: any) => p.chargeId === id).reduce((s: number, p: any) => s + p.amountPaise, 0);
  const procs: any[] = (cfg?.procedures ?? []).filter((p: any) => p.pricePaise > 0);
  const services: any[] = (cfg?.services ?? []).filter((s: any) => s.pricePaise > 0);
  const taxOf = (procedureId: string) => cfg?.procedures?.find((p: any) => p.id === procedureId)?.taxRateBp ?? 0;
  const pkgs: any[] = cfg?.tenant?.settings?.packages ?? [];
  const procName = (id: string) => cfg?.procedures?.find((p: any) => p.id === id)?.name ?? 'Procedure';
  const plans: any[] = tl.recommendations.filter((r: any) => r.kind === 'procedure' && r.procedureId && !['done', 'cancelled'].includes(r.status));

  // sittings to pay ahead on a plan: the course's price per sitting, or (no course yet) the list price or a package
  const aheadLine = (recId: string, packageId?: string): Line | null => {
    const r = plans.find((x) => x.id === recId); if (!r) return null;
    const c = courses.find((x) => x.recommendationId === recId);
    if (c) {
      const left = c.stillToPayPaise - (waiting.get(c.id) ?? 0); const max = Math.max(0, c.sittings - c.doneSittings - c.unusedSittings);
      if (left <= 0 || !max) return null;
      return { key: `a:${recId}`, kind: 'ahead', id: recId, what: `${procName(c.procedureId)} · paid ahead`, sub: `${c.doneSittings} of ${c.sittings} done, ${c.unusedSittings} paid ahead · ${money(c.perSittingPaise)} a sitting`, unitPaise: c.perSittingPaise, qty: 1, maxQty: max, capPaise: left, on: true, dv: '', unit: 'pct', prior: 0, taxBp: taxOf(c.procedureId), noDiscount: waiting.has(c.id) ? 'A discount on this course is waiting for approval' : undefined };
    }
    const custom = r.amountPaise > 0 ? r.amountPaise as number : 0; // the doctor's own amount, for all sittings: no package then
    const k = packageId && !custom ? pkgs.find((x) => x.id === packageId) : null; const n = k ? k.sittings : r.sittings ?? 1;
    const per = custom ? Math.round(custom / n) : procs.find((p) => p.id === r.procedureId)?.pricePaise ?? 0;
    const total = custom || (k ? k.pricePaise : per * n);
    if (!total) return null;
    return { key: `a:${recId}`, kind: 'ahead', id: recId, packageId: k ? packageId : undefined, what: `${procName(r.procedureId)} · paid ahead`, sub: k ? `${k.name} package · ${n} sittings for ${money(total)}` : custom ? `${n} sittings for ${money(total)}, the doctor's price` : `${n} sittings at ${money(per)}`, unitPaise: Math.round(total / n), qty: k ? n : 1, maxQty: n, capPaise: total, on: true, dv: '', unit: 'pct', prior: 0, taxBp: taxOf(r.procedureId) };
  };

  const [lines, setLines] = useState<Line[]>(() => {
    const due: Line[] = tl.charges.filter((c: any) => c.status === 'due').map((c: any) => {
      const paid = paidOn(c.id); const owing = c.amountPaise - paid - (waiting.get(c.id) ?? 0);
      if (owing <= 0) return null;
      const no = c.visitId ? 'Consultation fees take no discount' : c.description.startsWith('Pharmacy') ? 'Pharmacy discounts are given at the counter' : paid > 0 ? 'Part paid: no discount now' : waiting.has(c.id) ? 'A discount is waiting for approval' : undefined;
      return { key: `c:${c.id}`, kind: 'charge', id: c.id, what: c.description, sub: `${invoiceNo[c.billId] ? invoiceNo[c.billId] + ' · ' : ''}due since ${fmtDate(c.createdAt)}${paid ? ` · ${money(paid)} paid` : ''}${waiting.has(c.id) ? ` · ${money(waiting.get(c.id)!)} discount waiting` : ''}`, unitPaise: owing, qty: 1, maxQty: 1, on: !onlyBill || c.billId === onlyBill, dv: '', unit: 'pct', noDiscount: no, prior: c.discountPaise, taxBp: c.taxRateBp ?? 0 };
    }).filter(Boolean);
    const a = ahead ? aheadLine(ahead.recommendationId) : null;
    return a ? [...due.map((l) => ({ ...l, on: false })), a] : onlyBill ? [...due.filter((l) => l.on), ...due.filter((l) => !l.on)] : due;
  });
  const [xv, setXv] = useState(''); const [xUnit, setXUnit] = useState<Unit>('pct'); const [why, setWhy] = useState('');
  const [parts, setParts] = useState<Part[]>([{ method: 'upi', amount: '', reference: '', lender: '' }]);
  const [q, setQ] = useState(''); const [keep, setKeep] = useState(true);
  const [key] = useState(() => crypto.randomUUID());
  const setLine = (k: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === k ? { ...l, ...patch } : l)));

  // the sums, the same way the server does them
  const gross = (l: Line) => (l.capPaise === undefined ? l.unitPaise * l.qty : l.qty >= l.maxQty ? l.capPaise : Math.min(l.unitPaise * l.qty, l.capPaise)); // every sitting left = exactly what is left
  const on = lines.filter((l) => l.on);
  const lineOff = (l: Line) => (l.noDiscount ? 0 : offOf(gross(l), l.dv, l.unit));
  const sub = on.reduce((s, l) => s + gross(l), 0);
  const lineOffs = on.reduce((s, l) => s + lineOff(l), 0);
  const room = on.filter((l) => !l.noDiscount).reduce((s, l) => s + gross(l) - lineOff(l), 0);
  const extra_ = Math.min(room, offOf(room, xv, xUnit)); // the extra discount on the whole bill
  const off = lineOffs + extra_; const payable = sub - off;
  const withOff = on.filter((l) => !l.noDiscount && (lineOff(l) > 0 || extra_ > 0));
  const listSum = withOff.reduce((s, l) => s + gross(l) + l.prior, 0);
  const pct = listSum ? Math.round(((off + withOff.reduce((s, l) => s + l.prior, 0)) / listSum) * 1000) / 10 : 0;
  const cap = Number(cfg?.tenant?.settings?.discountCapPct ?? 10);
  const mayGive = can(perms, 'discount.give'); const mayApprove = can(perms, 'discount.approve');
  const needsOk = off > 0 && (!mayGive || (pct > cap && !mayApprove));
  const amt = (p: Part, i: number) => (p.amount === '' && parts.length === 1 && i === 0 ? payable : toPaise(p.amount));
  const [later, setLater] = useState(false); // bill now, nothing taken now
  const total = later ? 0 : parts.reduce((s, p, i) => s + amt(p, i), 0);
  const aheadNeed = on.filter((l) => l.kind === 'ahead').reduce((s, l) => s + gross(l) - lineOff(l), 0);
  const tooBig = on.find((l) => !l.noDiscount && lineOff(l) >= gross(l) && lineOff(l) > 0);
  const fromAdv = later ? 0 : parts.reduce((s, p, i) => s + (p.method === 'advance' ? amt(p, i) : 0), 0);
  const extra = Math.max(0, total - payable); // more than the bill: kept as advance when ticked
  const gst = on.reduce((s, l) => { const after = gross(l) - lineOff(l); const share = !l.noDiscount && room ? Math.round((extra_ * after) / room) : 0; return s + gstIn(after - share, l.taxBp); }, 0);
  const problem = !on.length && total <= 0 ? 'Tick or add an item, or type an amount to take as advance'
    : tooBig ? `The discount is the whole of ${tooBig.what}`
    : off > 0 && why.trim().length < 3 ? 'Say why there is a discount'
    : fromAdv > advPaise ? `Only ${money(advPaise)} is left in the advance`
    : extra > 0 && !keep ? `That is ${money(extra)} more than is payable`
    : extra > total - fromAdv ? 'The advance cannot pay into itself: take less from the advance'
    : aheadNeed > total && !later ? `Sittings paid ahead are paid in full: ${money(aheadNeed)}`
    : later && aheadNeed > 0 ? 'Sittings paid ahead need the money now'
    : parts.some((p, i) => !later && p.method === 'emi' && amt(p, i) > 0 && (!p.lender.trim() || !p.reference.trim())) ? 'EMI needs the lender and the approval code' : '';

  const go = useMutation({
    mutationFn: () => post('/bills', {
      patientId, idempotencyKey: key, reason: why.trim(), extraDiscountPaise: extra_, keepExtraAsAdvance: keep && total > payable,
      lines: on.map((l) => ({ ...(l.kind === 'charge' ? { chargeId: l.id } : l.kind === 'proc' ? { procedureId: l.id, qty: l.qty } : l.kind === 'service' ? { serviceId: l.id, qty: l.qty } : { recommendationId: l.id, sittings: l.qty, ...(l.packageId ? { packageId: l.packageId } : {}) }), discountPaise: lineOff(l) })),
      parts: later ? [] : parts.map((p, i) => ({ method: p.method, amountPaise: amt(p, i), reference: p.reference.trim() || undefined, lender: p.lender.trim() || undefined })).filter((p) => p.amountPaise > 0),
    }),
    onSuccess: (r: any) => {
      refresh(); qc.invalidateQueries({ queryKey: ['advance'] });
      const modes = [...new Set(parts.filter((p, i) => amt(p, i) > 0).map((p) => MODE_NAME[p.method] ?? p.method))].join(' + ');
      const first = patientName.split(' ')[0];
      const head = r.paidPaise ? `${money(r.paidPaise)} ${modes} from ${first}` : `Bill saved for ${first}`;
      toast(`${head}${r.keptAsAdvancePaise ? ` · ${money(r.keptAsAdvancePaise)} kept as advance` : ''}${r.waitingForApproval ? ` · ${money(r.offPaise)} discount sent for approval` : ''}${r.balancePaise ? ` · ${money(r.balancePaise)} still due` : ''}`, 'ok', r.receiptNo ? { label: 'Receipt', run: () => printReceipt(r.receiptNo) } : undefined);
      onClose();
    },
    onError: (e) => toast(moneyErr(e), 'err'),
  });

  // what can be added, found by typing: sittings to pay ahead on this patient's plans, price-list procedures and services
  type Hit = { v: string; l: string; kind: string; p: number; taxBp: number };
  const hits: Hit[] = [
    ...plans.filter((r) => !lines.some((l) => l.key === `a:${r.id}`)).flatMap((r) => {
      const c = courses.find((x) => x.recommendationId === r.id); const per = procs.find((p) => p.id === r.procedureId)?.pricePaise ?? 0;
      const opts: Hit[] = [{ v: `a:${r.id}`, l: `${procName(r.procedureId)} · pay ahead`, kind: c ? 'this patient’s course' : `${r.sittings ?? 1} sittings at list price`, p: c ? c.perSittingPaise : per, taxBp: taxOf(r.procedureId) }];
      return c ? opts : [...opts, ...pkgs.filter((k) => k.procedureId === r.procedureId && k.pricePaise > 0).map((k) => ({ v: `a:${r.id}:${k.id}`, l: `${k.name} · pay ahead`, kind: `package, ${k.sittings} sittings`, p: k.pricePaise, taxBp: taxOf(r.procedureId) }))];
    }),
    ...procs.map((p) => ({ v: `p:${p.id}`, l: p.name, kind: 'procedure', p: p.pricePaise, taxBp: p.taxRateBp ?? 0 })),
    ...services.map((s) => ({ v: `s:${s.id}`, l: s.name, kind: 'service', p: s.pricePaise, taxBp: 0 })),
  ];
  const term = q.trim().toLowerCase();
  const found = term ? hits.filter((h) => `${h.l} ${h.kind}`.toLowerCase().includes(term)).slice(0, 8) : [];
  const add = (v: string) => {
    setQ('');
    if (v.startsWith('p:') || v.startsWith('s:')) {
      const svc = v.startsWith('s:'); const x = (svc ? services : procs).find((y) => y.id === v.slice(2)); if (!x) return;
      setLines((ls) => [...ls, { key: `${v}:${ls.length}`, kind: svc ? 'service' : 'proc', id: x.id, what: x.name, sub: svc ? 'service, from the price list' : 'from the price list', unitPaise: x.pricePaise, qty: 1, maxQty: 20, on: true, dv: '', unit: 'pct', prior: 0, taxBp: svc ? 0 : x.taxRateBp ?? 0 }]);
    } else { const [, rid, pk] = v.split(':'); const l = aheadLine(rid, pk); if (l) setLines((ls) => [...ls, l]); else toast('Every sitting of this course is already paid', 'info'); }
  };
  const setPart = (i: number, patch: Partial<Part>) => setParts(parts.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const modes: [Part['method'], string][] = advPaise > 0 ? [...MODES, ['advance', 'From advance']] : MODES;

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0 space-y-3">
        {advPaise > 0 && <div className="flex flex-wrap items-center gap-2 text-sm"><Chip tone="sage">Advance balance {money(advPaise)}</Chip><span className="text-xs text-muted">Pick “From advance” to use it on this bill.</span></div>}
        <div className="relative">
          <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input className="input !pl-9" placeholder="Search procedures and services to add…" aria-label="Search the price list" autoComplete="off" value={q} maxLength={60}
            onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && found[0]) { e.preventDefault(); add(found[0].v); } if (e.key === 'Escape' && q) { e.stopPropagation(); setQ(''); } }} />
          {term && <div className="absolute inset-x-0 top-full z-20 mt-1 overflow-hidden rounded-xl border border-line bg-surface shadow-lg" role="listbox" aria-label="Matching items">
            {found.length === 0 ? <div className="p-3 text-sm text-muted">Nothing on the price list matches “{q.trim()}”.</div> : found.map((h) => (
              <button key={h.v} type="button" role="option" aria-selected={false} className="flex w-full items-center justify-between gap-3 border-b border-line/60 px-3 py-2.5 text-left text-sm last:border-0 hover:bg-surface-2" onClick={() => add(h.v)}>
                <span><b className="font-semibold">{h.l}</b> <span className="text-muted">· {h.kind}</span></span><span className="tabular-nums">{money(h.p)} <span className="text-xs text-muted">GST {h.taxBp / 100}%</span></span>
              </button>))}
          </div>}
        </div>
        <div className="overflow-x-auto rounded-xl border border-line"><table className="table min-w-[700px]">
          <thead><tr><th className="w-8 pl-3" /><th>Item</th><th className="text-right">Qty</th><th className="text-right">Price</th><th>Discount</th><th className="text-right">GST</th><th className="pr-3 text-right">Amount</th></tr></thead>
          <tbody>{lines.length === 0 ? <tr><td colSpan={7} className="p-4 text-sm text-muted">Nothing is due. Search above to add an item, or just type an amount on the right to take an advance.</td></tr> : lines.map((l) => {
            const g = gross(l); const o = l.on ? lineOff(l) : 0;
            return <tr key={l.key} className={l.on ? '' : 'opacity-55'}>
              <td className="pl-3"><input type="checkbox" className="accent-clay h-4 w-4" checked={l.on} aria-label={`Include ${l.what}`} onChange={(e) => setLine(l.key, { on: e.target.checked })} /></td>
              <td className="min-w-0"><div className="text-sm font-medium">{l.what}</div><div className="text-xs text-muted">{l.sub}</div></td>
              <td className="text-right tabular-nums">{l.maxQty > 1 ? <span className="inline-flex items-center gap-1"><button type="button" className="btn btn-ghost btn-sm !px-2" aria-label="One fewer" disabled={l.qty <= 1} onClick={() => setLine(l.key, { qty: l.qty - 1 })}>−</button><b>{l.qty}</b><button type="button" className="btn btn-ghost btn-sm !px-2" aria-label="One more" disabled={l.qty >= l.maxQty} onClick={() => setLine(l.key, { qty: l.qty + 1 })}>+</button></span> : l.qty}</td>
              <td className="text-right tabular-nums">{money(l.unitPaise)}</td>
              <td>{l.noDiscount ? <span className="text-xs text-muted">{l.noDiscount}</span> : <DiscountBox v={l.dv} unit={l.unit} label={`Discount on ${l.what}`} disabled={!l.on} onV={(v) => setLine(l.key, { dv: v })} onUnit={(u) => setLine(l.key, { unit: u, dv: '' })} />}</td>
              <td className="text-right tabular-nums">{l.taxBp ? `${l.taxBp / 100}%` : '—'}{l.taxBp > 0 && <div className="text-xs text-muted">{money(gstIn(g - o, l.taxBp))}</div>}</td>
              <td className="pr-3 text-right tabular-nums"><b>{money(g - o)}</b>{o > 0 && <div className="text-xs text-muted">−{money(o)} off</div>}</td>
            </tr>; })}</tbody>
        </table></div>
        <div className="text-xs text-muted">Prices include GST. Consultation fees are taken at check-in; medicines at the pharmacy.</div>
        {off > 0 && <div><label className="label" htmlFor="bill-why">Reason for the discount</label><input id="bill-why" className="input" maxLength={200} placeholder="for example: staff family, second course" value={why} onChange={(e) => setWhy(e.target.value)} /></div>}
        {asks.some((a) => a.status === 'pending') && <div className="text-xs text-muted">Waiting for approval: {asks.filter((a) => a.status === 'pending').map((a) => `${money(a.offPaise)} off (${a.reason}), asked by ${a.askedBy}`).join(' · ')}</div>}
      </div>

      <aside className="space-y-2.5 rounded-2xl bg-surface-2 p-4 text-sm">
        <div className="flex justify-between"><span className="text-muted">Subtotal</span><span className="tabular-nums font-semibold">{money(sub)}</span></div>
        <div className="flex justify-between"><span className="text-muted">Line discounts</span><span className="tabular-nums font-semibold">{lineOffs ? `−${money(lineOffs)}` : money(0)}</span></div>
        <div className="flex items-center justify-between gap-2"><span className="text-muted">Extra discount</span><DiscountBox v={xv} unit={xUnit} label="Extra discount on the bill" disabled={!room} onV={setXv} onUnit={(u) => { setXUnit(u); setXv(''); }} /></div>
        {extra_ > 0 && <div className="flex justify-end text-xs text-muted">−{money(extra_)}</div>}
        <div className="flex justify-between border-t border-line pt-2.5 text-base font-bold"><span>Payable</span><span className="tabular-nums">{money(payable)}</span></div>
        <div className="flex justify-between text-xs"><span className="text-muted">of which GST</span><span className="tabular-nums">{money(gst)}</span></div>
        {off > 0 && <div className="text-xs text-muted">{pct}% off · {mayApprove ? 'you approve discounts yourself' : mayGive ? `your limit is ${cap}%` : 'every discount needs approval'}</div>}
        {needsOk && <div className="rounded-xl bg-amber/15 p-2.5 text-[13px] font-medium text-ink" role="status">{pct}% off is above {mayGive ? `your limit of ${cap}%` : 'what you may give'}. The discount goes to the owner for approval. You can take {money(payable)} or less now; if the owner says no, {money(off)} becomes due.</div>}

        <div className="flex items-center justify-between pt-2"><span className="label !mb-0">Paid now</span>{on.length > 0 && <label className="flex items-center gap-1.5 text-xs text-muted"><input type="checkbox" className="accent-clay" checked={later} onChange={(e) => setLater(e.target.checked)} />Nothing now, pay later</label>}</div>
        {!later && <div className="space-y-2">{parts.map((p, i) => (
          <div key={i} className="space-y-1.5 rounded-xl bg-surface p-2">
            <div className="flex flex-wrap items-center gap-1">{modes.map(([m, lb]) => <button key={m} type="button" aria-pressed={p.method === m} className={`toggle-opt !min-h-0 !px-2.5 !py-1 ${p.method === m ? 'on' : ''}`} onClick={() => setPart(i, { method: m, ...(m === 'advance' && p.amount === '' ? { amount: String(Math.min(advPaise, payable) / 100) } : {}) })}>{lb}</button>)}
              <span className="ml-auto" />{parts.length > 1 && <button type="button" className="btn btn-ghost btn-sm !px-1.5" aria-label="Remove this mode" onClick={() => setParts(parts.filter((_, j) => j !== i))}><Icon name="x" className="h-3.5 w-3.5" /></button>}</div>
            <MoneyInput value={p.amount} label={`Amount by ${MODE_NAME[p.method] ?? p.method}`} placeholder={i === 0 && parts.length === 1 ? String(payable / 100) : '0'} onChange={(v) => setPart(i, { amount: v })} />
            {p.method !== 'cash' && p.method !== 'advance' && <input className="input" maxLength={60} aria-label={p.method === 'emi' ? 'Approval code' : 'Reference'} placeholder={p.method === 'emi' ? 'Approval code' : p.method === 'upi' ? 'Ref, last 4 digits' : 'Reference'} value={p.reference} onChange={(e) => setPart(i, { reference: e.target.value })} />}
            {p.method === 'emi' && <input className="input" maxLength={60} aria-label="Lender" placeholder="Lender, for example Bajaj Finserv" value={p.lender} onChange={(e) => setPart(i, { lender: e.target.value })} />}
            {p.method === 'advance' && <div className="text-xs text-muted">{money(advPaise)} in the advance.</div>}
          </div>))}
          {parts.length < 4 && <button type="button" className="btn btn-sm" onClick={() => setParts([...parts, { method: 'cash', amount: '', reference: '', lender: '' }])}><Icon name="plus" className="h-3.5 w-3.5" />Payment mode</button>}
        </div>}
        <div className="flex justify-between border-t border-line pt-2.5 font-bold"><span>Paying now</span><span className="tabular-nums">{money(total)}</span></div>
        <div className="flex justify-between"><span className="text-muted">Stays due</span><span className="tabular-nums font-semibold text-amber">{money(Math.max(0, payable - total))}</span></div>
        {extra > 0 && <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" className="accent-clay" checked={keep} onChange={(e) => setKeep(e.target.checked)} />{on.length ? `Keep the extra ${money(extra)} as advance` : `Take ${money(extra)} as advance`}</label>}
        <button className="btn btn-primary mt-2 w-full" disabled={!!problem || go.isPending} onClick={() => go.mutate()}><Icon name="check" />{!on.length ? `Take ${money(total)} as advance` : needsOk ? `Send discount for approval${total ? ` · take ${money(total)}` : ''}` : total ? `Collect ${money(total)}` : 'Save the bill'}</button>
        <div className="text-center text-xs text-muted" role="status">{problem || (extra > 0 ? `${money(extra)} goes to the advance` : total < payable ? `${money(payable - total)} stays due on the bill` : fromAdv === total && total > 0 ? 'Paid from the advance: no receipt' : 'One receipt for everything')}</div>
      </aside>
    </div>
  );
}

/** EMI approved but the lender's money has not reached the bank yet; matched here when it does. */
export function EmiAwaiting() {
  const q = useQuery({ queryKey: ['payments-awaiting'], queryFn: () => get('/payments/awaiting') });
  const [open, setOpen] = useState<any>(null); const [fee, setFee] = useState(''); const [ref, setRef] = useState('');
  const settle = useMutation({ mutationFn: () => post(`/payments/${open.id}/settle`, { feePaise: toPaise(fee), reference: ref.trim() || undefined }), onSuccess: () => { refresh(); toast('Matched with the bank credit'); setOpen(null); }, onError: (e) => toast(errText(e), 'err') });
  const rows: any[] = q.data ?? [];
  if (!rows.length) return null;
  return (
    <Section title={<>EMI awaiting settlement <span className="text-muted font-normal">· {rows.length}</span></>} className="mt-5">
      <div className="overflow-x-auto"><table className="table min-w-[460px]"><tbody>{rows.map((r) => <tr key={r.id}><td className="pl-4">{r.patient}<div className="text-xs text-muted">{r.lender} · code {r.reference} · approved {fmtDate(r.receivedAt)}</div></td><td className="text-right">{money(r.amountPaise)}</td><td className="text-right pr-4 no-print"><button className="btn btn-sm" onClick={() => { setOpen(r); setFee(''); setRef(''); }}>Bank credit arrived</button></td></tr>)}</tbody></table></div>
      {open && <Modal title="Match the bank credit" subtitle={`${open.patient} · ${open.lender} · ${money(open.amountPaise)}`} onClose={() => setOpen(null)} width="max-w-md">
        <div className="space-y-3"><div><label className="label">What the lender kept (fee)</label><MoneyInput autoFocus value={fee} onChange={setFee} /><div className="mt-1 text-xs text-muted">Booked as an expense.</div></div>
          <div><label className="label">Bank reference (optional)</label><input className="input" maxLength={60} value={ref} onChange={(e) => setRef(e.target.value)} /></div>
          <div className="modal-foot"><button className="btn btn-ghost" onClick={() => setOpen(null)}>Cancel</button><button className="btn btn-primary" disabled={settle.isPending} onClick={() => settle.mutate()}><Icon name="check" />Matched</button></div></div></Modal>}
    </Section>
  );
}

/** Discounts above the limit waiting for a decision, for whoever may approve them. Each says who asked, why, and what was taken meanwhile. */
export function DiscountAsks() {
  const q = useQuery({ queryKey: ['discount-asks', 'pending'], queryFn: () => get('/discount-asks'), refetchInterval: 60000 });
  const decide = useMutation({ mutationFn: (b: { id: string; action: 'approve' | 'reject' }) => post(`/discount-asks/${b.id}/decide`, { action: b.action }),
    onSuccess: (r: any) => { refresh(); toast(r.status === 'approved' ? 'Discount approved: the bill is lower now' : 'Said no: the full amount stays due'); }, onError: (e) => toast(moneyErr(e), 'err') });
  const rows: any[] = q.data ?? [];
  return <>{rows.map((a) => <div key={a.id} className="row flex-wrap">
    <span className="flex h-11 min-w-14 items-center justify-center rounded-xl bg-amber/15 px-2 text-[15px] font-extrabold tabular-nums">{a.pct}%</span>
    <div className="min-w-[220px] flex-1"><div className="text-[14px] font-semibold">Discount {money(a.offPaise)} for {a.patient.fullName}</div>
      <div className="text-xs text-muted">{a.lines.map((l: any) => l.what).join(', ')} · list {money(a.listPaise)} → {money(a.listPaise - a.offPaise)} · asked by {a.askedBy}, {fmtDate(a.createdAt)}</div>
      <div className="text-xs text-muted">“{a.reason}” · {a.paidPaise ? `${money(a.paidPaise)} taken on that bill` : 'nothing taken on that bill'}</div></div>
    <span className="flex gap-2"><button className="btn btn-sm" disabled={decide.isPending} onClick={() => decide.mutate({ id: a.id, action: 'reject' })}>Say no</button><button className="btn btn-sm btn-primary" disabled={decide.isPending} onClick={() => decide.mutate({ id: a.id, action: 'approve' })}>Approve</button></span>
  </div>)}</>;
}
export const useDiscountAsks = (enabled: boolean) => useQuery({ queryKey: ['discount-asks', 'pending'], queryFn: () => get('/discount-asks'), enabled, refetchInterval: 60000 });
