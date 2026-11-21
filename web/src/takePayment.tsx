import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useOutletContext } from 'react-router';
import { get, post, qc, errText } from './api';
import { can } from './App';
import { Icon, Modal, MoneyInput, Section, ask, money, toPaise, toast, fmtDate } from './ui';
import { printReceipt } from './invoices';
import { stdTotal } from './procedureSettings';

/** The money codes the server sends, in the desk's words. */
export function moneyErr(e: any): string {
  const b = e?.body; const c = b?.code;
  if (c === 'MORE_THAN_DUE') return b.duePaise ? `That is more than the ${money(b.duePaise)} due.` : 'Nothing is due on this any more.';
  if (c === 'MORE_THAN_FEE') return `That is more than the ${money(b.feePaise)} fee.`;
  if (c === 'DAY_CLOSED') return 'Today has been closed: no money can be taken or given back today.';
  if (c === 'ALREADY_REFUNDED') return 'This was already refunded.';
  if (c === 'PACKAGE_EXPIRED') return 'This package has expired: its sessions not done can only be refunded.';
  if (c === 'CONSULTATION_AT_CHECK_IN') return 'Consultation fees are taken at check-in.';
  if (c === 'ALREADY_INVOICED') return 'This treatment is already on an invoice.';
  if (c === 'A_PACKAGE_IS_INVOICED_WHOLE') return `The ${b.packageName ?? ''} package is invoiced whole: tick all its procedures.`;
  if (c === 'REASON_REQUIRED') return 'Say why there is a discount.';
  if (c === 'NO_DISCOUNT_ON_CONSULTATION') return 'Consultation fees take no discount.';
  if (c === 'NO_DISCOUNT_ON_PHARMACY') return 'Pharmacy bills take their discount at the counter.';
  if (c === 'DISCOUNT_ONLY_BEFORE_PAYMENT') return 'A discount can only be given before any money is taken on that invoice.';
  if (c === 'DISCOUNT_ALREADY_WAITING') return 'A discount on this is already waiting for approval.';
  if (c === 'DISCOUNT_MORE_THAN_THE_ITEM') return `The discount is the whole of ${b.what}. Ask for it to be waived instead.`;
  if (c === 'NOTHING_DUE') return 'Nothing is due on one of these any more. Close and open again.';
  if (c === 'NO_PRICE_ON_THE_PRICE_LIST') return 'This has no price on the price list. Set it in Settings › Consultation types or Procedures & packages.';
  if (c === 'MORE_THAN_THE_ADVANCE') return `Only ${money(b.balancePaise)} is left in the advance.`;
  if (c === 'NOTHING_TO_BILL') return 'Add an item, or type an amount to take as advance.';
  if (c === 'EMI_MORE_THAN_DUE') return `EMI pays a bill: at most the ${money(b.duePaise)} due. Take any extra in another mode.`;
  if (c === 'EMI_NOT_SETTLED') return `${money(b.emiPaise)} of the advance is EMI the lender has not paid yet: at most ${money(b.refundablePaise)} can go back now.`;
  if (c === 'MORE_GIVEN_BACK_THAN_TAKEN_OFF') return `More is being refunded on ${b.what} than comes off the bill.`;
  if (c === 'HAS_MONEY_USE_A_CREDIT_NOTE') return 'Money was already paid or refunded on this item: use Refund on the bill instead.';
  if (c === 'MORE_THAN_PAID_ON_THE_ITEM') return `Only ${money(b.paidPaise)} was paid on ${b.what}. To take an unpaid item off the bill, use Remove item.`;
  if (c === 'EXTRA_DISCOUNT_TOO_BIG') return 'The discount on the bill is too big: every item must still cost something.';
  if (c === 'NOTHING_TO_SAVE') return 'Nothing to save: take money, add an item, or give a discount.';
  if (c === 'FEE_MORE_THAN_PAYMENT') return 'The fee is more than the EMI amount. Check what the lender kept.';
  if (c === 'SAY_WHICH_ITEM') return 'Say how much comes off each item.';
  if (c === 'ITEMS_DO_NOT_ADD_UP') return 'The amounts off the items must add up to the refund.';
  if (c === 'MORE_THAN_THE_LINE') return `That is more than is left of ${b.what}${b.leftPaise != null ? ` (${money(b.leftPaise)})` : ''}.`;
  if (c === 'ISSUED_INVOICE_LINE_IS_FROZEN') return 'A bill cannot be changed once it is issued. Use Refund or Remove item on it instead.';
  return errText(e);
}
const MODE_NAME: Record<string, string> = { cash: 'cash', upi: 'UPI', card: 'card', emi: 'EMI', bank: 'bank transfer', advance: 'the advance' };

type Part = { method: 'cash' | 'upi' | 'card' | 'bank' | 'emi' | 'advance'; amount: string; reference: string; lender: string };
const MODES: [Part['method'], string][] = [['upi', 'UPI'], ['cash', 'Cash'], ['card', 'Card'], ['emi', 'EMI'], ['bank', 'Bank']];
type Unit = 'pct' | 'rs';
type Line = { key: string; kind: 'charge' | 'proc' | 'service' | 'ahead'; id: string; what: string; sub: string; unitPaise: number; qty: number; maxQty: number; capPaise?: number; on: boolean; dv: string; unit: Unit; noDiscount?: string; prior: number; taxBp: number; group?: string; procId?: string };
/** GST inside a price that includes it. */
const gstIn = (paise: number, bp: number) => (bp ? paise - Math.round((paise * 10000) / (10000 + bp)) : 0);
export const BILL_KEYS = ['timeline', 'frontdesk', 'daily', 'payments-awaiting', 'patients', 'courses', 'discount-asks', 'worklist', 'procedure-plans', 'clinic', 'finance', 'dayclose', 'gst', 'owner-summary'];
const refresh = () => BILL_KEYS.forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
const num = (s: string) => Math.max(0, Number(s) || 0);
const offOf = (gross: number, v: string, unit: Unit) => Math.min(gross, unit === 'pct' ? Math.round((gross * Math.min(100, num(v))) / 10000) * 100 : toPaise(v)); // a % comes off in whole rupees

/** % or ₹: one small switch, the same on every line and on the bill. */
function UnitSwitch({ unit, onChange, label }: { unit: Unit; onChange: (u: Unit) => void; label: string }) {
  return <span className="inline-flex shrink-0 rounded-lg bg-surface-2 p-0.5" role="group" aria-label={label}>{(['pct', 'rs'] as Unit[]).map((u) =>
    <button key={u} type="button" aria-pressed={unit === u} className={`h-7 min-w-7 rounded-md px-1.5 text-[13px] font-bold ${unit === u ? 'bg-surface text-ink shadow-sm' : 'text-muted'}`} onClick={() => onChange(u)}>{u === 'pct' ? '%' : '₹'}</button>)}</span>;
}
function DiscountBox({ v, unit, onV, onUnit, label, disabled, maxPaise }: { v: string; unit: Unit; onV: (v: string) => void; onUnit: (u: Unit) => void; label: string; disabled?: boolean; maxPaise: number }) {
  return <span className="inline-flex flex-col items-end gap-1 xl:flex-row xl:items-center xl:gap-1.5"><input className="input !h-9 !w-16 text-right tabular-nums xl:!w-20" inputMode={unit === 'pct' ? 'decimal' : 'numeric'} autoComplete="off" aria-label={label} disabled={disabled} placeholder="0" value={v}
    onChange={(e) => {
      let x = unit === 'rs' ? e.target.value.split('.')[0].replace(/\D/g, '') : e.target.value.replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1').replace(/(\.\d{2})\d+/, '$1'); // ₹ in whole rupees
      if (unit === 'pct' && Number(x) >= 100) x = '99.99'; // an item for free is not a discount if (unit === 'rs' && Number(x) * 100 > maxPaise) x = String(Math.floor(maxPaise / 100)); // never more than the item
      onV(x.slice(0, 9)); }} /><UnitSwitch unit={unit} onChange={onUnit} label={`${label} in`} /></span>;
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
  const ready = t.data && cs.data && asks.data && adv.data && bl.data; const gstOn = !!cfg?.tenant?.settings?.gstin;
  return (
    <Modal title={onlyBill ? "Collect payment" : "Generate invoice"} subtitle={`${patientName} · prices from the clinic price list${gstOn ? ', GST included' : ''}`} onClose={onClose} width="max-w-6xl">
      {!ready ? <div className="text-sm text-muted">Loading…</div> : <BillForm patientId={patientId} patientName={patientName} ahead={ahead} onlyBill={onlyBill} invoiceNo={Object.fromEntries((bl.data?.bills ?? []).map((b: any) => [b.id, b.invoiceNo]))} tl={t.data} courses={cs.data} asks={asks.data} advPaise={adv.data.balancePaise} dayClosed={!!adv.data.dayClosed} cfg={cfg} perms={perms} onClose={onClose} />}
    </Modal>
  );
}

function BillForm({ patientId, patientName, ahead, onlyBill, invoiceNo, tl, courses, asks, advPaise, dayClosed, cfg, perms, onClose }: { patientId: string; patientName: string; ahead?: { recommendationId: string }; onlyBill?: string; invoiceNo: Record<string, string>; tl: any; courses: any[]; asks: any[]; advPaise: number; dayClosed: boolean; cfg: any; perms: string[]; onClose: () => void }) {
  const gstOn = !!cfg?.tenant?.settings?.gstin; // a clinic not registered for GST shows no tax
  const waiting = useMemo(() => { const m = new Map<string, number>(); for (const a of asks.filter((x) => x.status === 'pending')) for (const l of a.lines) m.set(l.chargeId ?? l.courseId, (m.get(l.chargeId ?? l.courseId) ?? 0) + l.offPaise); return m; }, [asks]);
  const paidOn = (id: string) => tl.payments.filter((p: any) => p.chargeId === id).reduce((s: number, p: any) => s + p.amountPaise, 0);
  const procs: any[] = (cfg?.procedures ?? []).filter((p: any) => p.pricePaise > 0);
  const services: any[] = (cfg?.services ?? []).filter((s: any) => s.pricePaise > 0 && !s.feeCategoryId); // visit types (consultations) are taken at check-in
  const taxOf = (procedureId: string) => cfg?.procedures?.find((p: any) => p.id === procedureId)?.taxRateBp ?? 0;
  const procName = (id: string) => cfg?.procedures?.find((p: any) => p.id === id)?.name ?? 'Procedure';
  const plans: any[] = tl.recommendations.filter((r: any) => r.kind === 'procedure' && r.procedureId && !['done', 'cancelled'].includes(r.status));

  // a doctor's procedure or package: the whole treatment on one invoice (what is not invoiced yet); its sessions are never billed again
  const pkgOf = (r: any) => r?.package?.name ? ` · ${r.package.name} package` : '';
  const treatLine = (recId: string, on = true): Line | null => {
    const r = plans.find((x) => x.id === recId); if (!r) return null;
    const c = courses.find((x) => x.recommendationId === recId); const n = c ? (c.uninvoicedSessions || c.sittings) : r.sittings ?? 1; // an invoiced treatment: only the sessions added since
    const total = c ? c.uninvoicedPaise : r.amountPaise > 0 ? r.amountPaise as number : stdTotal(procs.find((p) => p.id === r.procedureId), n);
    if (!total || total <= 0 || c?.expired) return null;
    return { key: `a:${recId}`, kind: 'ahead', id: recId, what: `${procName(r.procedureId)}${pkgOf(r)} · ${n} session${n === 1 ? '' : 's'}${c?.invoiced ? ' added' : ''}`,
      sub: c?.invoiced ? `sessions added after the treatment was invoiced, at the standard price` : `${c?.doneSittings ? `${c.doneSittings} of ${n} done · ` : ''}${r.package ? 'its share of the package price · ' : r.amountPaise > 0 ? 'custom price · ' : ''}the whole treatment; sessions are not billed again`,
      unitPaise: total, qty: 1, maxQty: 1, on, dv: '', unit: 'pct', prior: 0, taxBp: taxOf(r.procedureId), group: r.package?.group, procId: r.procedureId };
  };

  /** A plan and, when it is part of a package with no course yet, the other procedures of that package: a package is invoiced as a whole. */
  const withPackage = (recId: string): Line[] => {
    const r = plans.find((x) => x.id === recId); const g = r?.package?.group;
    const ids = g && !courses.some((c) => c.recommendationId === recId) ? plans.filter((x) => x.package?.group === g).map((x) => x.id) : [recId];
    return ids.map((id) => treatLine(id)).filter(Boolean) as Line[];
  };
  const [lines, setLines] = useState<Line[]>(() => {
    const due: Line[] = tl.charges.filter((c: any) => c.status === 'due').map((c: any) => {
      const paid = paidOn(c.id); const credited = c.creditedPaise ?? 0; const tookMoney = tl.payments.some((p: any) => p.chargeId === c.id && p.amountPaise > 0); const owing = c.amountPaise - credited - paid - (waiting.get(c.id) ?? 0);
      if (owing <= 0) return null;
      const no = c.visitId ? 'Consultation fees take no discount' : c.description.startsWith('Pharmacy') ? 'Pharmacy discounts are given at the counter' : paid > 0 || credited > 0 || tookMoney ? 'Money was taken on it: no discount now' : waiting.has(c.id) ? 'A discount is waiting for approval' : undefined;
      return { key: `c:${c.id}`, kind: 'charge', id: c.id, what: c.description, sub: `${invoiceNo[c.billId] ? invoiceNo[c.billId] + ' · ' : ''}due since ${fmtDate(c.createdAt)}${paid ? ` · ${money(paid)} paid` : ''}${credited ? ` · ${money(credited)} refunded` : ''}${waiting.has(c.id) ? ` · ${money(waiting.get(c.id)!)} discount waiting` : ''}`, unitPaise: owing, qty: 1, maxQty: 1, on: !onlyBill || c.billId === onlyBill, dv: '', unit: 'pct', noDiscount: no, prior: c.discountPaise, taxBp: c.taxRateBp ?? 0 };
    }).filter(Boolean);
    const a = ahead ? withPackage(ahead.recommendationId) : [];
    // the doctor's treatments not invoiced yet are listed, unticked: tick what goes on this invoice
    const rest = onlyBill ? [] : plans.filter((r) => !a.some((l) => l.id === r.id)).map((r) => treatLine(r.id, false)).filter(Boolean) as Line[];
    return a.length ? [...due.map((l) => ({ ...l, on: false })), ...a, ...rest] : onlyBill ? [...due.filter((l) => l.on), ...due.filter((l) => !l.on)] : [...due, ...rest];
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
  const pctExact = listSum ? ((off + withOff.reduce((s, l) => s + l.prior, 0)) / listSum) * 100 : 0;
  const pct = Math.round(pctExact * 10) / 10; const pctShown = Math.floor(pctExact * 10) / 10; // the limit check matches the server; what is shown never rounds up to 100%
  const cap = Number(cfg?.tenant?.settings?.discountCapPct ?? 10);
  const mayGive = can(perms, 'discount.give'); const mayApprove = can(perms, 'discount.approve');
  const needsOk = off > 0 && (!mayGive || (pct > cap && !mayApprove));
  const [later_, setLater] = useState(false); // bill now, nothing taken now
  const later = later_ || dayClosed; // the day is closed: no money can be taken today
  // the patient's advance comes off the bill first (ticked by default); the rest is paid by the modes below
  const [useAdv, setUseAdv] = useState(true);
  // the advance is the patient's money: it is used even when nothing new is paid now
  const typed = later ? 0 : parts.reduce((s, p) => s + (p.amount === '' ? 0 : toPaise(p.amount)), 0); // money typed in the modes: the advance covers only the rest
  const advUse = useAdv ? Math.min(advPaise, Math.max(0, payable - typed)) : 0; const toPay = payable - advUse;
  const amt = (p: Part, i: number) => (p.amount === '' && parts.length === 1 && i === 0 ? toPay : toPaise(p.amount));
  const allAdv = advUse > 0 && toPay === 0; // the advance pays it all: no mode to pick
  const paidNew = later || allAdv ? 0 : parts.reduce((s, p, i) => s + amt(p, i), 0); const total = advUse + paidNew;
  const tooBig = on.find((l) => !l.noDiscount && lineOff(l) >= gross(l) && lineOff(l) > 0);
  const extraTooBig = () => extra_ > 0 && on.some((l) => !l.noDiscount && lineOff(l) + (shares.get(l.key) ?? 0) >= gross(l)); // the bill-wide discount would make an item free
  const fromAdv = advUse;
  const extra = Math.max(0, total - payable); // more than the bill: kept as advance when ticked
  // the extra discount shared out the way the server does it: in proportion, whole rupees per line, the last line takes the rest
  const shares = new Map<string, number>(); { const rl = on.filter((l) => !l.noDiscount); let rest = extra_; rl.forEach((l, k) => { const sh = k === rl.length - 1 ? rest : room ? Math.round((extra_ * (gross(l) - lineOff(l))) / room / 100) * 100 : 0; shares.set(l.key, sh); rest -= sh; }); }
  const gst = on.reduce((s, l) => { const after = gross(l) - lineOff(l); return s + gstIn(after - (shares.get(l.key) ?? 0), l.taxBp); }, 0);
  const anyNew = on.some((l) => l.kind !== 'charge');
  const problem = !on.length && total <= 0 ? 'Tick or add an item, or type an amount to take as advance'
    : !anyNew && off === 0 && total <= 0 ? 'Nothing to save: these are already on invoices. Take money, add an item, or give a discount'
    : parts.some((p, i) => !later && !allAdv && (p.method === 'upi' || p.method === 'card') && amt(p, i) > 0 && !p.reference.trim()) ? 'Type the UPI or card reference'
    : tooBig ? `The discount is the whole of ${tooBig.what}`
    : extraTooBig() ? 'The discount on the bill is too big: every item must still cost something'
    : off > 0 && why.trim().length < 3 ? 'Say why there is a discount'
    : fromAdv > advPaise ? `Only ${money(advPaise)} is left in the advance`
    : extra > 0 && !keep ? `That is ${money(extra)} more than is payable`
    : extra > total - fromAdv ? 'The advance cannot pay into itself: take less from the advance'
    : parts.some((p, i) => !later && p.method === 'emi' && amt(p, i) > 0 && (!p.lender.trim() || !p.reference.trim())) ? 'EMI needs the lender and the approval code'
    : !later && parts.reduce((s, p, i) => s + (p.method === 'emi' ? amt(p, i) : 0), 0) > toPay ? `EMI pays the bill: at most ${money(toPay)}` : '';

  const busy = useRef(false);
  const save = () => { if (busy.current) return; busy.current = true; go.mutate(undefined, { onSettled: () => { busy.current = false; } }); };
  const go = useMutation({
    mutationFn: () => post('/bills', {
      patientId, idempotencyKey: key, reason: why.trim(), extraDiscountPaise: extra_, keepExtraAsAdvance: keep && total > payable,
      lines: on.map((l) => ({ ...(l.kind === 'charge' ? { chargeId: l.id } : l.kind === 'proc' ? { procedureId: l.id, qty: l.qty } : l.kind === 'service' ? { serviceId: l.id, qty: l.qty } : { recommendationId: l.id }), discountPaise: lineOff(l) })),
      parts: [...(advUse ? [{ method: 'advance', amountPaise: advUse }] : []), ...(later ? [] : parts).map((p, i) => ({ method: p.method, amountPaise: amt(p, i), reference: p.method !== 'cash' ? p.reference.trim() || undefined : undefined, lender: p.method === 'emi' ? p.lender.trim() || undefined : undefined })).filter((p) => p.amountPaise > 0)],
    }),
    onSuccess: (r: any) => {
      refresh(); qc.invalidateQueries({ queryKey: ['advance'] });
      const first = patientName.split(' ')[0];
      const took = [...(later || allAdv ? [] : parts.map((p, i) => [amt(p, i), MODE_NAME[p.method] ?? p.method] as const).filter(([a]) => a > 0).map(([a, m]) => `${money(a)} ${m}`)), ...(advUse ? [`${money(advUse)} from the advance`] : [])];
      const head = took.length ? `${took.join(' + ')} · ${first}` : `Bill saved for ${first}`;
      toast(`${head}${r.keptAsAdvancePaise ? ` · ${money(r.keptAsAdvancePaise)} kept as advance` : ''}${r.waitingForApproval ? ` · ${money(r.offPaise)} discount sent for approval` : ''}${r.balancePaise ? ` · ${money(r.balancePaise)} still due` : ''}`, 'ok', r.receiptNo ? { label: 'Receipt', run: () => printReceipt(r.receiptNo) } : undefined);
      onClose();
    },
    onError: (e: any) => { toast(moneyErr(e), 'err'); if (e?.body?.code === 'ALREADY_INVOICED') { refresh(); qc.invalidateQueries({ queryKey: ['bills'] }); onClose(); } },
  });

  // what can be added, found by typing: this patient's treatments not invoiced yet, price-list procedures and services
  type Hit = { v: string; l: string; kind: string; p: number; taxBp: number };
  const hits: Hit[] = [
    ...plans.filter((r) => !lines.some((l) => l.key === `a:${r.id}`)).flatMap((r) => { const l = treatLine(r.id); return l ? [{ v: `a:${r.id}`, l: l.what, kind: 'this patient’s treatment', p: l.unitPaise, taxBp: l.taxBp }] : []; }),
    ...procs.filter((p) => !lines.some((l) => l.kind === 'ahead' && l.procId === p.id) && !plans.some((r) => r.procedureId === p.id && treatLine(r.id))).map((p) => ({ v: `p:${p.id}`, l: p.name, kind: 'procedure', p: p.pricePaise, taxBp: p.taxRateBp ?? 0 })),
    ...lines.filter((l) => l.kind === 'ahead' && !l.on).map((l) => ({ v: `t:${l.key}`, l: l.what, kind: 'this patient’s treatment, listed above', p: l.unitPaise, taxBp: l.taxBp })),
    ...services.map((s) => ({ v: `s:${s.id}`, l: s.name, kind: 'service', p: s.pricePaise, taxBp: 0 })),
  ];
  const term = q.trim().toLowerCase();
  const found = term ? hits.filter((h) => `${h.l} ${h.kind}`.toLowerCase().includes(term)).slice(0, 8) : [];
  const add = (v: string) => {
    setQ('');
    if (v.startsWith('t:')) { const k = v.slice(2); const g = lines.find((l) => l.key === k)?.group; setLines((ls) => ls.map((x) => (x.key === k || (g && x.group === g) ? { ...x, on: true } : x))); return; }
    if (v.startsWith('p:') || v.startsWith('s:')) {
      const svc = v.startsWith('s:'); const x = (svc ? services : procs).find((y) => y.id === v.slice(2)); if (!x) return;
      const have = lines.find((l) => l.kind === (svc ? 'service' : 'proc') && l.id === x.id);
      if (have) { setLine(have.key, { on: true, qty: Math.min(have.maxQty, have.qty + (have.on ? 1 : 0)) }); return; } // already on the bill: one more
      // already billed and not paid yet: say so, so it is not billed twice by mistake
      const open = svc ? null : tl.charges.find((c: any) => c.status === 'due' && c.procedureId === x.id);
      const onCourse = svc ? null : plans.find((r) => r.procedureId === x.id); // a treatment of this procedure is planned: its sessions are on the treatment's invoice
      if (onCourse && !open) toast(`${x.name} is part of this patient's treatment (${onCourse.sittings ?? 1} sessions). Its sessions are billed on the treatment, not again here, unless this is extra.`, 'info');
      if (open) toast(`${x.name} is already on ${invoiceNo[open.billId] ?? 'an invoice'}, not paid yet. Collect that one instead if it is the same.`, 'info');
      setLines((ls) => [...ls, { key: `${v}:${ls.length}`, kind: svc ? 'service' : 'proc', id: x.id, what: x.name, sub: svc ? 'service, from the price list' : open ? `from the price list · already on ${invoiceNo[open.billId] ?? 'an invoice'}, unpaid` : 'from the price list', unitPaise: x.pricePaise, qty: 1, maxQty: 20, on: true, dv: '', unit: 'pct', prior: 0, taxBp: svc ? 0 : x.taxRateBp ?? 0 }]);
    } else { const ls0 = withPackage(v.split(':')[1]).filter((l) => !lines.some((x) => x.key === l.key)); if (ls0.length) setLines((ls) => [...ls, ...ls0]); else toast('This treatment is already on an invoice', 'info'); }
  };
  // quantity: in its own column, or under the item's name on a phone
  const stepper = (l: Line) => <span className="inline-flex items-center gap-1"><button type="button" className="btn btn-ghost btn-sm !px-2" aria-label={`One fewer ${l.what}`} disabled={l.qty <= 1} onClick={() => setLine(l.key, { qty: l.qty - 1 })}>−</button><b className="tabular-nums">{l.qty}</b><button type="button" className="btn btn-ghost btn-sm !px-2" aria-label={`One more ${l.what}`} disabled={l.qty >= l.maxQty} onClick={() => setLine(l.key, { qty: l.qty + 1 })}>+</button></span>;
  const setPart = (i: number, patch: Partial<Part>) => setParts(parts.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const modes = MODES;

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0 space-y-3">
        <div className="relative">
          <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input className="input !pl-9" placeholder="Search procedures and services to add…" aria-label="Search the price list" autoComplete="off" value={q} maxLength={60}
            onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && found[0]) { e.preventDefault(); add(found[0].v); } if (e.key === 'Escape' && q) { e.stopPropagation(); setQ(''); } }} />
          {term && <div className="absolute inset-x-0 top-full z-20 mt-1 overflow-hidden rounded-xl border border-line bg-surface shadow-lg" role="listbox" aria-label="Matching items">
            {found.length === 0 ? <div className="p-3 text-sm text-muted">Nothing on the price list matches “{q.trim()}”.</div> : found.map((h) => (
              <button key={h.v} type="button" role="option" aria-selected={false} className="flex w-full items-center justify-between gap-3 border-b border-line/60 px-3 py-2.5 text-left text-sm last:border-0 hover:bg-surface-2" onClick={() => add(h.v)}>
                <span><b className="font-semibold">{h.l}</b> <span className="text-muted">· {h.kind}</span></span><span className="tabular-nums">{money(h.p)}{gstOn && <span className="text-xs text-muted"> GST {h.taxBp / 100}%</span>}</span>
              </button>))}
          </div>}
        </div>
        <div className="overflow-x-auto rounded-xl border border-line"><table className="table xl:min-w-[700px]">
          <thead><tr><th className="w-8 pl-3" /><th>Item</th><th className="hidden text-right xl:table-cell">Qty</th><th className="hidden text-right xl:table-cell">Price</th><th>Discount</th>{gstOn && <th className="text-right">GST</th>}<th className="pr-3 text-right">Amount</th></tr></thead>
          <tbody>{lines.length === 0 ? <tr><td colSpan={gstOn ? 7 : 6} className="p-4 text-sm text-muted">Nothing is due. Search above to add an item, or just type an amount on the right to take an advance.</td></tr> : lines.map((l) => {
            const g = gross(l); const o = l.on ? lineOff(l) + (shares.get(l.key) ?? 0) : 0; // its own discount and its share of the extra
            return <tr key={l.key} className={l.on ? '' : 'opacity-55'}>
              <td className="pl-3"><input type="checkbox" className="accent-clay h-4 w-4" checked={l.on} aria-label={`Include ${l.what}`} onChange={(e) => { const on = e.target.checked; setLines((ls) => ls.map((x) => (x.key === l.key || (l.group && x.group === l.group) ? { ...x, on } : x))); }} /></td>
              <td className="min-w-0"><div className="text-sm font-medium">{l.what}</div><div className="text-xs text-muted">{l.sub}{l.maxQty > 1 && <span className="xl:hidden"> · {money(l.unitPaise)} each</span>}</div>{l.maxQty > 1 && <div className="xl:hidden">{stepper(l)}</div>}</td>
              <td className="hidden text-right tabular-nums xl:table-cell">{l.maxQty > 1 ? stepper(l) : l.qty}</td>
              <td className="hidden text-right tabular-nums xl:table-cell">{money(l.unitPaise)}</td>
              <td>{l.noDiscount ? <span className="text-xs text-muted">{l.noDiscount}</span> : <DiscountBox v={l.dv} unit={l.unit} label={`Discount on ${l.what}`} disabled={!l.on} maxPaise={Math.max(0, g - 100)} onV={(v) => setLine(l.key, { dv: v })} onUnit={(u) => setLine(l.key, { unit: u, dv: '' })} />}</td>
              {gstOn && <td className="text-right tabular-nums">{l.taxBp ? `${l.taxBp / 100}%` : '—'}{l.taxBp > 0 && <div className="text-xs text-muted">{money(gstIn(g - o, l.taxBp))}</div>}</td>}
              <td className="pr-3 text-right tabular-nums"><b>{money(g - o)}</b>{o > 0 && <div className="text-xs text-muted">−{money(o)} off</div>}</td>
            </tr>; })}</tbody>
        </table></div>
        <div className="text-xs text-muted">{gstOn ? 'Prices include GST. ' : ''}Consultation fees are taken at check-in; medicines at the pharmacy.</div>
        <div className={off > 0 ? '' : 'invisible'} aria-hidden={off > 0 ? undefined : true}><label className="label" htmlFor="bill-why">Reason for the discount</label><input id="bill-why" className="input" maxLength={200} tabIndex={off > 0 ? undefined : -1} placeholder="for example: staff family, second course" value={why} onChange={(e) => setWhy(e.target.value)} /></div>
        {asks.some((a) => a.status === 'pending') && <div className="text-xs text-muted">Waiting for approval: {asks.filter((a) => a.status === 'pending').map((a) => `${money(a.offPaise)} off (${a.reason}), asked by ${a.askedBy}`).join(' · ')}</div>}
      </div>

      <aside className="space-y-2.5 rounded-2xl bg-surface-2 p-4 text-sm">
        <div className="flex justify-between"><span className="text-muted">Subtotal</span><span className="tabular-nums font-semibold">{money(sub)}</span></div>
        <div className="flex justify-between"><span className="text-muted">Line discounts</span><span className="tabular-nums font-semibold">{lineOffs ? `−${money(lineOffs)}` : money(0)}</span></div>
        <div className="flex items-center justify-between gap-2"><span className="text-muted">Extra discount</span><DiscountBox v={xv} unit={xUnit} label="Extra discount on the bill" disabled={!room} maxPaise={Math.max(0, room - 100)} onV={setXv} onUnit={(u) => { setXUnit(u); setXv(''); }} /></div>
        {extra_ > 0 && <div className="flex justify-end text-xs text-muted">−{money(extra_)}</div>}
        <div className="flex justify-between border-t border-line pt-2.5 text-base font-bold"><span>Payable</span><span className="tabular-nums">{money(payable)}</span></div>
        {gstOn && <div className="flex justify-between text-xs"><span className="text-muted">of which GST</span><span className="tabular-nums">{money(gst)}</span></div>}
        {advPaise > 0 && payable > 0 && <>
          <label className="flex items-center justify-between gap-2"><span className="flex items-center gap-2"><input type="checkbox" className="accent-clay" aria-label="Use advance" checked={useAdv} onChange={(e) => setUseAdv(e.target.checked)} />Use advance <span className="text-xs text-muted">({money(advPaise)} available)</span></span><span className="tabular-nums font-semibold text-sage">{advUse ? `−${money(advUse)}` : money(0)}</span></label>
          {advUse > 0 && <div className="flex justify-between font-bold"><span>To pay</span><span className="tabular-nums">{money(toPay)}</span></div>}
        </>}
        {off > 0 && <div className="text-xs text-muted">{pctShown}% off · {mayApprove ? 'you approve discounts yourself' : mayGive ? `your limit is ${cap}%` : 'every discount needs approval'}</div>}
        {needsOk && <div className="rounded-xl bg-amber/15 p-2.5 text-[13px] font-medium text-ink" role="status">{pctShown}% off is above {mayGive ? `your limit of ${cap}%` : 'what you may give'}. The discount goes to the owner for approval. You can take {money(payable)} or less now; if the owner says no, {money(off)} becomes due.</div>}

        {dayClosed && <div className="rounded-xl bg-amber/15 p-2.5 text-[13px] font-medium" role="status">Today has been closed: no money can be taken. You can still save the bill and use the advance.</div>}
        {/* payments received now: one line per method (split tender); fewer than the bill leaves a balance due */}
        {(!allAdv || later) && <div className="border-t border-line pt-3"><span className="label !mb-0">Payments received now</span></div>}
        {later ? <div className="rounded-xl bg-surface p-2.5 text-[13px]">No payment now. The bill is saved and {money(toPay)} stays due.
          {!dayClosed && <button type="button" className="mt-1 block font-medium text-clay hover:underline" onClick={() => setLater(false)}>Record a payment instead</button>}</div>
        : !allAdv && <div className="space-y-2">{parts.map((p, i) => (
          <div key={i} className="space-y-1.5">
            <div className="grid grid-cols-[92px_minmax(0,1fr)_28px] items-center gap-1.5">
              <select className="input !px-2" aria-label={`Method of payment ${i + 1}`} value={p.method} onChange={(e) => setPart(i, { method: e.target.value as Part['method'] })}>{modes.map(([m, lb]) => <option key={m} value={m}>{lb}</option>)}</select>
              <MoneyInput value={p.amount} label={`Amount by ${MODE_NAME[p.method] ?? p.method}`} placeholder={i === 0 && parts.length === 1 ? String(toPay / 100) : '0'} onChange={(v) => setPart(i, { amount: v })} />
              {parts.length > 1 ? <button type="button" className="btn btn-ghost btn-sm !px-1.5" aria-label="Remove this payment" onClick={() => setParts(parts.filter((_, j) => j !== i))}><Icon name="x" className="h-3.5 w-3.5" /></button> : <span />}
            </div>
            {p.method !== 'cash' && p.method !== 'advance' && <input className="input" maxLength={60} aria-label={p.method === 'emi' ? 'Approval code' : 'Reference'} placeholder={p.method === 'emi' ? 'Approval code' : p.method === 'upi' ? 'UPI ref, last 4 digits' : 'Reference'} value={p.reference} onChange={(e) => setPart(i, { reference: e.target.value })} />}
            {p.method === 'emi' && <input className="input" maxLength={60} aria-label="Lender" placeholder="Lender, for example Bajaj Finserv" value={p.lender} onChange={(e) => setPart(i, { lender: e.target.value })} />}
          </div>))}
          <div className="flex flex-wrap items-center justify-between gap-2">
            {parts.length < 4 && <button type="button" className="inline-flex items-center gap-1 text-[13px] font-medium text-clay hover:underline" onClick={() => {
              const left = Math.max(0, toPay - parts.reduce((s, p, i) => s + amt(p, i), 0)); const used = new Set(parts.map((p) => p.method));
              const next = (modes.find(([m]) => !used.has(m)) ?? modes[0])[0];
              setParts([...parts.map((p, i) => (i === 0 && p.amount === '' && parts.length === 1 ? { ...p, amount: String(toPay / 100) } : p)), { method: next, amount: left ? String(left / 100) : '', reference: '', lender: '' }]);
            }}><Icon name="plus" className="h-3.5 w-3.5" />Split: add another method</button>}
            {on.length > 0 && <button type="button" className="text-xs text-muted hover:underline" onClick={() => setLater(true)}>Patient pays later</button>}
          </div>
        </div>}
        {payable > 0 && on.length > 0 && <div>
          <div className="h-1.5 overflow-hidden rounded-full bg-surface" role="progressbar" aria-label="Received against the bill" aria-valuemin={0} aria-valuemax={payable} aria-valuenow={Math.min(total, payable)}><div className="h-full rounded-full bg-clay transition-[width]" style={{ width: `${Math.min(100, (total / payable) * 100)}%` }} /></div>
          <div className="mt-1 text-xs text-muted">{money(Math.min(total, payable))} of {money(payable)} received</div>
        </div>}
        <div className="flex justify-between border-t border-line pt-2.5 font-bold"><span>Received now</span><span className="tabular-nums">{money(paidNew)}</span></div>
        <div className="flex justify-between"><span className="text-muted">Balance due</span><span className="tabular-nums font-semibold text-amber">{money(Math.max(0, payable - total))}</span></div>
        {extra > 0 && <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" className="accent-clay" aria-label="Keep the extra as advance" checked={keep} onChange={(e) => setKeep(e.target.checked)} />{on.length ? `Keep the extra ${money(extra)} as advance` : `Take ${money(extra)} as advance`}</label>}
        <button className="btn btn-primary mt-2 w-full" disabled={!!problem || go.isPending} onClick={save}><Icon name="check" />{!on.length ? `Take ${money(total)} as advance` : needsOk ? `Send discount for approval${total ? ` · take ${money(total)}` : ''}` : paidNew ? `Collect ${money(paidNew)}` : advUse ? `Pay ${money(advUse)} from advance` : 'Save the bill'}</button>
        <div className="text-center text-xs text-muted" role="status">{problem || (extra > 0 ? `${money(extra)} goes to the advance` : total < payable ? `${money(payable - total)} stays due on the bill` : fromAdv === total && total > 0 ? 'Paid from the advance: no receipt' : 'One receipt for everything')}</div>
      </aside>
    </div>
  );
}

/** EMI approved but the lender's money has not reached the bank yet; matched here when it does. */
export function EmiAwaiting() {
  const q = useQuery({ queryKey: ['payments-awaiting'], queryFn: () => get('/payments/awaiting') });
  const [open, setOpen] = useState<any>(null); const [fee, setFee] = useState(''); const [ref, setRef] = useState('');
  const settle = useMutation({ mutationFn: () => post(`/payments/${open.id}/settle`, { feePaise: toPaise(fee), reference: ref.trim() || undefined }), onSuccess: () => { refresh(); toast('Matched with the bank credit'); setOpen(null); }, onError: (e) => toast(moneyErr(e), 'err') });
  const rows: any[] = q.data ?? [];
  if (!rows.length) return null;
  return (
    <Section title={<>EMI awaiting settlement <span className="text-muted font-normal">· {rows.length}</span></>} className="mt-5">
      <div className="overflow-x-auto"><table className="table min-w-[460px]"><tbody>{rows.map((r) => <tr key={r.id}><td className="pl-4">{r.patient}<div className="text-xs text-muted">{r.lender} · code {r.reference} · approved {fmtDate(r.receivedAt)}</div></td><td className="text-right">{money(r.amountPaise)}</td><td className="text-right pr-4 no-print"><button className="btn btn-sm" onClick={() => { setOpen(r); setFee(''); setRef(''); }}>Bank credit arrived</button></td></tr>)}</tbody></table></div>
      {open && <Modal title="Match the bank credit" subtitle={`${open.patient} · ${open.lender} · ${money(open.amountPaise)}`} onClose={() => setOpen(null)} width="max-w-md">
        <div className="space-y-3"><div><label className="label">What the lender kept (fee)</label><MoneyInput autoFocus value={fee} onChange={setFee} /><div className={`mt-1 text-xs ${toPaise(fee) > open.amountPaise ? 'text-rose' : 'text-muted'}`}>{toPaise(fee) > open.amountPaise ? `The fee cannot be more than the ${money(open.amountPaise)} paid.` : 'Booked as an expense.'}</div></div>
          <div><label className="label">Bank reference (optional)</label><input className="input" maxLength={60} value={ref} onChange={(e) => setRef(e.target.value)} /></div>
          <div className="modal-foot"><button className="btn btn-ghost" onClick={() => setOpen(null)}>Cancel</button><button className="btn btn-primary" disabled={settle.isPending || toPaise(fee) > open.amountPaise} onClick={() => settle.mutate()}><Icon name="check" />Matched</button></div></div></Modal>}
    </Section>
  );
}

/** Discounts above the limit waiting for a decision, for whoever may approve them. Each says who asked, why, and what was taken meanwhile. */
export function DiscountAsks() {
  const q = useQuery({ queryKey: ['discount-asks', 'pending'], queryFn: () => get('/discount-asks'), refetchInterval: 60000 });
  const decide = useMutation({ mutationFn: (b: { id: string; action: 'approve' | 'reject' }) => post(`/discount-asks/${b.id}/decide`, { action: b.action }),
    onSuccess: (r: any) => { refresh(); toast(r.status === 'approved' ? 'Discount approved: it comes off the bill' : 'Said no: the full amount stays due'); }, onError: (e) => toast(moneyErr(e), 'err') });
  const rows: any[] = q.data ?? [];
  return <>{rows.map((a) => <div key={a.id} className="row flex-wrap">
    <span className="flex h-11 min-w-14 items-center justify-center rounded-xl bg-amber/15 px-2 text-[15px] font-extrabold tabular-nums">{a.pct}%</span>
    <div className="min-w-[220px] flex-1"><div className="text-[14px] font-semibold">Discount {money(a.offPaise)} for {a.patient.fullName}</div>
      <div className="text-xs text-muted">{a.invoices?.length ? <b className="text-ink">{a.invoices.join(', ')} · </b> : null}{a.lines.map((l: any) => l.what).join(', ')} · list {money(a.listPaise)} → {money(a.listPaise - a.offPaise)} · asked by {a.askedBy}, {fmtDate(a.createdAt)}</div>
      <div className="text-xs text-muted">“{a.reason}” · {a.paidPaise ? `${money(a.paidPaise)} taken on that bill` : 'nothing taken on that bill'}</div></div>
    <span className="flex gap-2"><button className="btn btn-sm" disabled={decide.isPending} onClick={() => ask({ title: `Say no to ${money(a.offPaise)} off for ${a.patient.fullName}?`, body: `${a.invoices?.join(', ') ?? ''} · the full amount stays due.`, confirmLabel: 'Say no', tone: 'danger' }).then((ok) => ok && decide.mutate({ id: a.id, action: 'reject' }))}>Say no</button><button className="btn btn-sm btn-primary" disabled={decide.isPending} onClick={() => ask({ title: `Approve ${money(a.offPaise)} off for ${a.patient.fullName}?`, body: `${a.invoices?.join(', ') ?? ''} · a credit note takes it off the invoice.`, confirmLabel: 'Approve' }).then((ok) => ok && decide.mutate({ id: a.id, action: 'approve' }))}>Approve</button></span>
  </div>)}</>;
}
export const useDiscountAsks = (enabled: boolean) => useQuery({ queryKey: ['discount-asks', 'pending'], queryFn: () => get('/discount-asks'), enabled, refetchInterval: 60000 });
