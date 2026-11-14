import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useOutletContext } from 'react-router';
import { get, post, qc, errText } from './api';
import { can } from './App';
import { Chip, Empty, Icon, Modal, MoneyInput, MoreMenu, Section, Stat, Tabs, ask, fmtDate, money, toPaise, toast } from './ui';
import { printReceipt } from './invoices';
import { TakePayment, BILL_KEYS, moneyErr } from './takePayment';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const MODE: Record<string, string> = { cash: 'Cash', upi: 'UPI', card: 'Card', bank: 'Bank', emi: 'EMI', advance: 'Advance' };
const STATUS: Record<string, [string, string]> = { paid: ['Paid fully', 'sage'], part: ['Part paid', 'amber'], unpaid: ['Unpaid', 'rose'], refunded: ['Refunded', ''], part_refunded: ['Part refunded', 'sky'], cancelled: ['Cancelled', ''] };
export const refreshBills = () => [...BILL_KEYS, 'bills', 'advance'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
const when = (at: string) => new Date(at).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });

/** The invoice as it prints: "Bill cum receipt" with the clinic, the patient, each line, the totals, and every payment and refund. */
export function invoiceHtml(v: any) {
  const pct = (bp: number) => (bp ? `${bp / 100}%` : '—');
  const pays = v.payments.filter((p: any) => !p.refund); const refunds = v.payments.filter((p: any) => p.refund);
  const st = STATUS[v.status]?.[0] ?? v.status; const g = !!v.clinic.gstin; // a Bill of Supply (no GSTIN) shows no tax
  return `<!doctype html><meta charset="utf-8"><title>${esc(v.invoiceNo)}</title><style>
  body{font:13px system-ui,-apple-system,Segoe UI,sans-serif;margin:28px;color:#17191A}h1{font-size:19px;margin:0}.s{color:#5F625E;font-size:12px}
  .hd{display:flex;justify-content:space-between;gap:16px;border-bottom:2px solid #17191A;padding-bottom:10px}.t{text-align:center;font-weight:700;margin:10px 0}
  .who{display:flex;justify-content:space-between;gap:16px;border-bottom:1px solid #ccc;padding-bottom:8px;font-size:12.5px;line-height:1.6}
  table{width:100%;border-collapse:collapse;margin-top:10px}th{background:#F3F1EC;text-align:left;font-size:11px;letter-spacing:.04em;text-transform:uppercase;padding:7px 6px}td{padding:7px 6px;border-bottom:1px solid #eee}.r{text-align:right}
  .sum{margin-left:auto;width:320px;margin-top:10px}.sum div{display:flex;justify-content:space-between;padding:4px 0}.b{font-weight:700;border-top:1px solid #ccc;padding-top:7px!important}.g{color:#2E6B4F}.red{color:#A02A17}
  </style>
  <div class="hd"><div><h1>${esc(v.clinic.name)}</h1><div class="s">${esc(v.clinic.print?.address ?? '')}${v.clinic.print?.phone ? ' · ' + esc(v.clinic.print.phone) : ''}${v.clinic.gstin ? ' · GSTIN ' + esc(v.clinic.gstin) : ''}</div></div><div class="s r">${esc(v.gst?.title ?? 'Bill of Supply')}</div></div>
  <div class="t">Bill cum Receipt</div>
  <div class="who"><div>Patient: <b>${esc(v.patient.fullName)}</b><br>Patient ID: ${esc(v.patient.patientNo)}<br>${v.patient.ageYears || v.patient.sex ? `Age / sex: ${esc([v.patient.ageYears ? v.patient.ageYears + 'y' : '', v.patient.sex ?? ''].filter(Boolean).join(', '))}<br>` : ''}${v.patient.phone ? 'Mobile: ' + esc(v.patient.phone) : ''}</div>
  <div class="r">Invoice no: <b>${esc(v.invoiceNo)}</b><br>Date: ${esc(when(v.createdAt))}<br>${v.receipts.length ? 'Receipt: ' + esc(v.receipts.join(', ')) + '<br>' : ''}Status: <b>${esc(st)}</b></div></div>
  <table><tr><th>#</th><th>Item</th><th class="r">Price</th><th class="r">Discount</th>${g ? '<th class="r">GST</th>' : ''}<th class="r">Amount</th></tr>
  ${v.rows.map((r: any, i: number) => `<tr><td>${i + 1}</td><td>${esc(r.description)}${['cancelled', 'waived'].includes(r.status) ? ` <span class="s">(${esc(r.status)})</span>` : ''}</td><td class="r">${esc(money(r.listPaise))}</td><td class="r">${r.discountPaise ? '−' + esc(money(r.discountPaise)) : '—'}</td>${g ? `<td class="r">${pct(r.taxRateBp)}</td>` : ''}<td class="r">${esc(money(r.amountPaise))}</td></tr>`).join('')}</table>
  <div class="sum"><div><span>Subtotal</span><span>${esc(money(v.subtotalPaise))}</span></div><div><span>Discount</span><span>${v.discountPaise ? '−' + esc(money(v.discountPaise)) : '₹0'}</span></div>
  ${g ? `<div><span>GST included</span><span>${esc(money(v.gstPaise))}</span></div>` : ''}<div class="b"><span>Total payable</span><span>${esc(money(v.billedPaise))}</span></div>
  ${pays.map((p: any) => `<div class="s"><span>Paid ${esc(MODE[p.method] ?? p.method)}${p.reference ? ' · ' + esc(p.reference) : ''} · ${esc(fmtDate(p.at))}</span><span>${esc(money(p.amountPaise))}</span></div>`).join('')}
  <div class="b g"><span>Total paid</span><span>${esc(money(v.paidPaise))}</span></div>
  ${refunds.map((p: any) => `<div class="s red"><span>Refund ${esc(MODE[p.method] ?? p.method)} · ${esc(fmtDate(p.at))}</span><span>−${esc(money(-p.amountPaise))}</span></div>`).join('')}
  ${v.duePaise ? `<div class="b red"><span>Due</span><span>${esc(money(v.duePaise))}</span></div>` : ''}</div>
  <p class="s" style="margin-top:22px">${v.clinic.gstin ? 'Prices include GST.' : 'Not registered for GST, so no tax is charged on this bill.'} ${esc(v.clinic.print?.footer ?? '')}</p>`;
}

/** Print an invoice in its own window. */
export async function printInvoice(id: string) {
  try {
    const v: any = await get(`/bills/${id}`);
    const w = window.open('', '_blank', 'width=760,height=900'); if (!w) return toast('Allow pop-ups to print the invoice', 'err');
    w.document.write(invoiceHtml(v) + '<script>window.onload=function(){window.print()}<\/script>'); w.document.close();
  } catch (e) { toast(errText(e), 'err'); }
}

/** The invoices table, the same on the patient's Bills tab and on the clinic's Billing page. */
export function InvoiceTable({ bills, showPatient, onView, onCollect, onRefund, empty }: { bills: any[]; showPatient?: boolean; onView: (b: any) => void; onCollect?: (b: any) => void; onRefund?: (b: any) => void; empty: string }) {
  const { perms } = useOutletContext<any>();
  const mayRefund = can(perms, 'payment.refund'); const mayCollect = can(perms, 'payment.record');
  const reasonFor = async (title: string) => { const a = await ask({ title, confirmLabel: 'Save', field: { label: 'Why', placeholder: 'At least 3 letters', required: true, maxLength: 200 } }); if (a && a.value.trim().length < 3) { toast('Say why in at least 3 letters', 'err'); return null; } return a?.value.trim() || null; };
  const forLines = async (b: any, path: string, title: string, done: string, pick: (c: any) => boolean) => {
    const why = await reasonFor(title); if (!why) return;
    try { for (const c of b.lines.filter(pick)) await post(`/charges/${c.id}/${path}`, { reason: why }); refreshBills(); toast(done); } catch (e) { toast(errText(e), 'err'); }
  };
  if (!bills.length) return <Empty icon="rupee" title="No invoices" hint={empty} />;
  return (
    <div className="overflow-x-auto overflow-y-hidden"><table className="table min-w-[860px]">
      <thead><tr><th className="pl-4">#</th><th>Invoice no &amp; date</th>{showPatient && <th>Patient</th>}<th>Items</th><th className="text-right">Billed</th><th className="text-right">Paid</th><th className="text-right">Due</th><th className="text-right">Refund</th><th>Status</th><th className="pr-4 text-right">Action</th></tr></thead>
      <tbody>{bills.map((b, i) => { const [label, tone] = STATUS[b.status] ?? [b.status, ''];
        return <tr key={b.id} className="cursor-pointer hover:bg-surface-2/60" onClick={() => onView(b)}>
          <td className="pl-4 text-muted tabular-nums">{i + 1}</td>
          <td><button type="button" className="font-semibold text-clay hover:underline" onClick={(e) => { e.stopPropagation(); onView(b); }}>{b.invoiceNo}</button><div className="text-xs text-muted">{fmtDate(b.createdAt)}</div></td>
          {showPatient && <td><div className="font-medium">{b.patient.fullName}</div><div className="text-xs text-muted">{b.patient.phone ?? b.patient.patientNo}</div></td>}
          <td className="max-w-[260px]"><div className="truncate text-sm">{b.items.join(', ')}</div>{b.waitingOffPaise > 0 && <div className="text-xs text-amber">{money(b.waitingOffPaise)} discount waiting for approval</div>}</td>
          <td className="text-right tabular-nums">{money(b.billedPaise)}{b.discountPaise > 0 && <div className="text-xs text-muted">−{money(b.discountPaise)} off</div>}</td>
          <td className="text-right tabular-nums">{money(b.paidPaise)}</td>
          <td className={`text-right tabular-nums ${b.duePaise ? 'font-semibold text-rose' : ''}`}>{money(b.duePaise)}</td>
          <td className="text-right tabular-nums">{b.refundedPaise ? money(b.refundedPaise) : '–'}</td>
          <td><Chip tone={tone as any}>{label}</Chip>{b.excluded && <span> <Chip>Not in tax reports</Chip></span>}</td>
          <td className="pr-4" onClick={(e) => e.stopPropagation()}><span className="flex items-center justify-end gap-1">
            <button type="button" className="btn btn-ghost btn-sm !px-2" title="Print" aria-label={`Print ${b.invoiceNo}`} onClick={() => printInvoice(b.id)}><Icon name="print" className="h-4 w-4" /></button>
            <button type="button" className="btn btn-ghost btn-sm !px-2" title="View" aria-label={`View ${b.invoiceNo}`} onClick={() => onView(b)}><Icon name="eye" className="h-4 w-4" /></button>
            <MoreMenu items={[
              { label: `Collect ${money(b.duePaise)}`, hidden: !(mayCollect && onCollect && b.duePaise > 0), onClick: () => onCollect!(b) },
              { label: 'Refund', hidden: !(mayRefund && onRefund && b.paidPaise - b.refundedPaise > 0), danger: true, onClick: () => onRefund!(b) },
              { label: 'Cancel invoice', hidden: !(mayRefund && b.status === 'unpaid'), danger: true, onClick: () => forLines(b, 'cancel', `Cancel ${b.invoiceNo}?`, 'Invoice cancelled', (c) => c.status === 'due') },
              { label: 'Leave out of tax reports', hidden: !(mayRefund && !b.excluded && b.status !== 'cancelled'), onClick: () => forLines(b, 'exclude', `Leave ${b.invoiceNo} out of the tax reports?`, 'Left out of the tax reports', (c) => !c.excludedAt) },
            ]} />
          </span></td>
        </tr>; })}</tbody>
    </table></div>
  );
}

/** View bill: the invoice as it prints on the right, what can be done with it on the left. */
export function InvoiceView({ id, onClose, onCollect, onRefund }: { id: string; onClose: () => void; onCollect?: (b: any) => void; onRefund?: (b: any) => void }) {
  const { perms } = useOutletContext<any>();
  const q = useQuery({ queryKey: ['bills', 'one', id], queryFn: () => get(`/bills/${id}`) }); const v: any = q.data;
  return (
    <Modal title={v ? `Invoice ${v.invoiceNo}` : 'Invoice'} subtitle={v ? `${v.patient.fullName} · ${when(v.createdAt)}` : undefined} onClose={onClose} width="max-w-5xl">
      {!v ? <div className="text-sm text-muted">Loading…</div> : (
        <div className="grid gap-5 md:grid-cols-[230px_minmax(0,1fr)]">
          <div className="space-y-2">
            <button className="btn w-full justify-start" onClick={() => printInvoice(v.id)}><Icon name="print" className="h-4 w-4" />Print invoice</button>
            {v.receipts.map((r: string) => <button key={r} className="btn w-full justify-start" onClick={() => printReceipt(r)}><Icon name="print" className="h-4 w-4" />Print receipt {r}</button>)}
            {can(perms, 'payment.record') && onCollect && v.duePaise > 0 && <button className="btn btn-primary w-full justify-start" onClick={() => onCollect(v)}><Icon name="rupee" className="h-4 w-4" />Collect {money(v.duePaise)}</button>}
            {can(perms, 'payment.refund') && onRefund && v.paidPaise - v.refundedPaise > 0 && <button className="btn w-full justify-start" onClick={() => onRefund(v)}><Icon name="undo" className="h-4 w-4" />Refund</button>}
            <div className="rounded-xl bg-surface-2 p-3 text-sm">
              <div className="flex justify-between"><span className="text-muted">Billed</span><b className="tabular-nums">{money(v.billedPaise)}</b></div>
              <div className="flex justify-between"><span className="text-muted">Paid</span><b className="tabular-nums text-sage">{money(v.paidPaise)}</b></div>
              <div className="flex justify-between"><span className="text-muted">Due</span><b className={`tabular-nums ${v.duePaise ? 'text-rose' : ''}`}>{money(v.duePaise)}</b></div>
              {v.refundedPaise > 0 && <div className="flex justify-between"><span className="text-muted">Refunded</span><b className="tabular-nums">{money(v.refundedPaise)}</b></div>}
              <div className="mt-2"><Chip tone={(STATUS[v.status]?.[1] ?? '') as any}>{STATUS[v.status]?.[0] ?? v.status}</Chip></div>
            </div>
          </div>
          <iframe title={`Invoice ${v.invoiceNo}`} className="h-[62vh] w-full rounded-xl border border-line bg-white" srcDoc={invoiceHtml(v)} />
        </div>)}
    </Modal>
  );
}

type RPart = { method: 'cash' | 'upi' | 'card' | 'bank'; amount: string; reference: string };
/** Refund on an invoice: how much (any part of what was paid), how it goes back, and why. */
export function RefundBill({ bill: b, onClose }: { bill: any; onClose: () => void }) {
  const left = b.paidPaise - b.refundedPaise;
  const [parts, setParts] = useState<RPart[]>([{ method: 'cash', amount: String(left / 100), reference: '' }]); const [why, setWhy] = useState('');
  const total = parts.reduce((s, p) => s + toPaise(p.amount), 0);
  const bad = total <= 0 ? 'Type the amount' : total > left ? `Only ${money(left)} was paid` : why.trim().length < 3 ? 'Say why' : '';
  const go = useMutation({ mutationFn: () => post(`/bills/${b.id}/refund`, { parts: parts.filter((p) => toPaise(p.amount) > 0).map((p) => ({ method: p.method, amountPaise: toPaise(p.amount), reference: p.reference.trim() || undefined })), reason: why.trim() }),
    onSuccess: () => { refreshBills(); toast(`${money(total)} refunded on ${b.invoiceNo}`); onClose(); },
    onError: (e: any) => toast(e?.body?.code === 'MORE_THAN_PAID' ? `Only ${money(e.body.refundablePaise)} can be refunded` : moneyErr(e), 'err') });
  const set = (i: number, patch: Partial<RPart>) => setParts(parts.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  return (
    <Modal title={`Refund ${b.invoiceNo}`} subtitle={`${b.patient.fullName} · billed ${money(b.billedPaise)} · paid ${money(b.paidPaise)}${b.refundedPaise ? ` · ${money(b.refundedPaise)} already refunded` : ''}`} onClose={onClose} width="max-w-lg">
      <div className="space-y-3">
        {parts.map((p, i) => <div key={i} className="space-y-1.5 rounded-xl border border-line p-2.5">
          <div className="flex flex-wrap items-center gap-1">{(['cash', 'upi', 'card', 'bank'] as const).map((m) => <button key={m} type="button" aria-pressed={p.method === m} className={`toggle-opt !py-1 ${p.method === m ? 'on' : ''}`} onClick={() => set(i, { method: m })}>{MODE[m]}</button>)}
            <span className="ml-auto" />{parts.length > 1 && <button type="button" className="btn btn-ghost btn-sm !px-1.5" aria-label="Remove this mode" onClick={() => setParts(parts.filter((_, j) => j !== i))}><Icon name="x" className="h-3.5 w-3.5" /></button>}</div>
          <MoneyInput value={p.amount} label={`Refund by ${MODE[p.method]}`} onChange={(v) => set(i, { amount: v })} />
          {p.method !== 'cash' && <input className="input" maxLength={60} aria-label="Reference" placeholder="Reference (optional)" value={p.reference} onChange={(e) => set(i, { reference: e.target.value })} />}
        </div>)}
        {parts.length < 4 && <button type="button" className="btn btn-sm" onClick={() => setParts([...parts, { method: 'upi', amount: '', reference: '' }])}><Icon name="plus" className="h-3.5 w-3.5" />Payment mode</button>}
        <div><label className="label" htmlFor="rb-why">Why</label><input id="rb-why" className="input" maxLength={200} placeholder="for example: procedure not done" value={why} onChange={(e) => setWhy(e.target.value)} /></div>
        <div className="rounded-xl bg-surface-2 p-3 text-center text-[15px]"><b className="text-rose">{money(total)}</b> will be refunded to the patient</div>
        <div className="modal-foot"><span className="mr-auto text-xs text-muted" role="status">{bad}</span><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!!bad || go.isPending} onClick={() => go.mutate()}>Refund the bill</button></div>
      </div>
    </Modal>
  );
}

/** Advance deposit: add money or give it back on the left, the balance and every deposit, use and refund on the right. */
export function AdvanceDialog({ patientId, patientName, onClose, start = 'add' }: { patientId: string; patientName: string; onClose: () => void; start?: 'add' | 'back' }) {
  const { perms } = useOutletContext<any>();
  const q = useQuery({ queryKey: ['advance', patientId, 'history'], queryFn: () => get(`/patients/${patientId}/advance`) }); const bal: number = q.data?.balancePaise ?? 0;
  const [tab, setTab] = useState<'add' | 'back'>(start); const [mode, setMode] = useState<'cash' | 'upi' | 'card' | 'bank'>('cash');
  const [amount, setAmount] = useState(''); const [ref, setRef] = useState(''); const [why, setWhy] = useState(''); const [key] = useState(() => crypto.randomUUID());
  const paise = toPaise(amount);
  const bad = paise <= 0 ? 'Type the amount' : tab === 'back' && paise > bal ? `Only ${money(bal)} is in the advance` : tab === 'back' && why.trim().length < 3 ? 'Say why' : '';
  const go = useMutation({
    mutationFn: () => tab === 'add'
      ? post('/bills', { patientId, idempotencyKey: key, keepExtraAsAdvance: true, parts: [{ method: mode, amountPaise: paise, reference: ref.trim() || undefined }] })
      : post(`/patients/${patientId}/advance/refund`, { amountPaise: paise, method: mode, reason: why.trim() }),
    onSuccess: (r: any) => { refreshBills(); toast(tab === 'add' ? `${money(paise)} added to the advance` : `Gave back ${money(paise)}`, 'ok', r?.receiptNo ? { label: 'Receipt', run: () => printReceipt(r.receiptNo) } : undefined); onClose(); },
    onError: (e) => toast(moneyErr(e), 'err') });
  const KIND: Record<string, string> = { deposit: 'Deposit', used: 'Used on a bill', refund: 'Given back' };
  return (
    <Modal title="Advance deposit" subtitle={patientName} onClose={onClose} width="max-w-4xl">
      <div className="grid gap-5 md:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
        <div className="space-y-3">
          <Tabs value={tab} onChange={(v) => { setTab(v); setAmount(''); }} options={[{ value: 'add', label: 'Add advance' }, ...(can(perms, 'payment.refund') ? [{ value: 'back' as const, label: 'Give back' }] : [])]} />
          <div><span className="label">{tab === 'add' ? 'Paid by' : 'Given back by'}</span><div className="flex flex-wrap gap-1.5">{(['cash', 'upi', 'card', 'bank'] as const).map((m) => <button key={m} type="button" aria-pressed={mode === m} className={`toggle-opt !py-1 ${mode === m ? 'on' : ''}`} onClick={() => setMode(m)}>{MODE[m]}</button>)}</div></div>
          <div><label className="label" htmlFor="adv-amt">Amount</label><MoneyInput id="adv-amt" value={amount} onChange={setAmount} placeholder={tab === 'back' ? String(bal / 100) : '0'} /></div>
          {tab === 'add' && mode !== 'cash' && <div><label className="label" htmlFor="adv-ref">Reference</label><input id="adv-ref" className="input" maxLength={60} value={ref} onChange={(e) => setRef(e.target.value)} /></div>}
          {tab === 'back' && <div><label className="label" htmlFor="adv-why">Why</label><input id="adv-why" className="input" maxLength={200} value={why} onChange={(e) => setWhy(e.target.value)} /></div>}
          <button className="btn btn-primary w-full" disabled={!!bad || go.isPending} onClick={() => go.mutate()}><Icon name="check" />{tab === 'add' ? `Add ${money(paise)} to the advance` : `Give back ${money(paise)}`}</button>
          <div className="text-center text-xs text-muted" role="status">{bad || (tab === 'add' ? 'A receipt is made. Use it later with “From advance”.' : 'Money out today, with the reason kept.')}</div>
        </div>
        <div className="space-y-3">
          <div className="rounded-2xl bg-surface-2 p-4 text-center"><div className="text-[13px] text-muted">Advance balance</div><div className="text-[26px] font-bold tabular-nums">{money(bal)}</div></div>
          <AdvanceHistory rows={q.data?.history ?? []} kind={KIND} />
        </div>
      </div>
    </Modal>
  );
}

function AdvanceHistory({ rows, kind }: { rows: any[]; kind: Record<string, string> }) {
  if (!rows.length) return <Empty icon="wallet" title="No advance yet" hint="Deposits, uses and refunds show here." />;
  return <div className="overflow-x-auto rounded-xl border border-line"><table className="table min-w-[460px]">
    <thead><tr><th className="pl-3">Date</th><th>What</th><th>Receipt</th><th className="text-right">Amount</th><th className="pr-3" /></tr></thead>
    <tbody>{rows.map((h) => <tr key={h.id}><td className="pl-3 text-sm">{fmtDate(h.at)}</td><td className="text-sm">{kind[h.kind] ?? h.kind}{h.kind !== 'used' ? ` · ${MODE[h.method] ?? h.method}` : ''}{h.note && h.kind !== 'deposit' ? <div className="text-xs text-muted">{h.note}</div> : null}</td>
      <td className="text-sm">{h.receiptNo ?? '–'}</td><td className={`text-right tabular-nums ${h.amountPaise < 0 ? 'text-rose' : 'text-sage'}`}>{h.amountPaise < 0 ? '−' : '+'}{money(Math.abs(h.amountPaise))}</td>
      <td className="pr-3 text-right">{h.receiptNo && <button className="btn btn-ghost btn-sm !px-2" aria-label="Print receipt" onClick={() => printReceipt(h.receiptNo)}><Icon name="print" className="h-4 w-4" /></button>}</td></tr>)}</tbody>
  </table></div>;
}

/** Money tiles above an invoice list. */
function Totals({ t, advance, onAdvance, onCourses, line }: { t: any; advance?: number; onAdvance?: () => void; onCourses?: number; line?: boolean }) {
  // line: the totals as one strip of figures (inside a patient's record, where the bills themselves need the room)
  if (line) {
    const Fig = ({ label, value, tone = '' }: { label: string; value: string; tone?: string }) => <div className="flex items-baseline gap-1.5"><span className="text-[12.5px] text-muted">{label}</span><b className={`text-[16px] tabular-nums ${tone}`}>{value}</b></div>;
    return (
      <div className="mb-3 flex flex-wrap items-center gap-x-6 gap-y-1 rounded-xl bg-surface-2/60 px-4 py-2.5">
        <Fig label={`Billed (${t.n})`} value={money(t.billedPaise)} />
        <Fig label="Collected" value={money(t.paidPaise - t.refundedPaise)} tone="text-sage" />
        <Fig label={`Due (${t.withDue})`} value={money(t.duePaise)} tone={t.duePaise ? 'text-rose' : ''} />
        <Fig label={`Refunded (${t.withRefund})`} value={money(t.refundedPaise)} />
        {advance !== undefined && <Fig label="Advance" value={money(advance)} />}
        {onCourses ? <span className="text-[12.5px] text-muted">{money(onCourses)} more paid ahead on courses</span> : null}
      </div>
    );
  }
  return (
    <div className="mb-4 grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3">
      <Stat label={`Billed (${t.n})`} value={money(t.billedPaise)} sub={`${money(t.paidPaise)} paid`} />
      <Stat label="Collected" value={money(t.paidPaise - t.refundedPaise)} tone="sage" sub={`After refunds · ${t.paidFully} paid fully`} />
      <Stat label={`Due (${t.withDue})`} value={money(t.duePaise)} tone={t.duePaise ? 'clay' : ''} sub={t.duePaise ? 'Collect from the ⋯ menu' : 'nothing owed'} />
      <Stat label={`Refunded (${t.withRefund})`} value={money(t.refundedPaise)} sub={t.refundedPaise ? 'given back' : 'none'} />
      {advance !== undefined && <Stat label="Advance balance" value={money(advance)} sub={<>{onCourses ? `${money(onCourses)} more paid ahead on courses · ` : ''}{onAdvance ? <button className="underline" onClick={onAdvance}>Add or give back</button> : 'to use on bills'}</>} />}
    </div>
  );
}

/** The patient's Bills tab, laid out like a billing history: invoices and the advance, each with its own list. */
export function BillingHistory({ patientId, patientName }: { patientId: string; patientName: string }) {
  const { perms } = useOutletContext<any>();
  const q = useQuery({ queryKey: ['bills', 'patient', patientId], queryFn: () => get(`/patients/${patientId}/bills`) });
  const adv = useQuery({ queryKey: ['advance', patientId, 'history'], queryFn: () => get(`/patients/${patientId}/advance`) });
  const cs = useQuery({ queryKey: ['courses', patientId], queryFn: () => get(`/courses?patientId=${patientId}`) }); const onCourses = (cs.data ?? []).reduce((s: number, c: any) => s + c.unusedPaise, 0); // sittings paid ahead live on the course
  const [tab, setTab] = useState<'invoices' | 'advance'>('invoices');
  const [viewing, setViewing] = useState<string | null>(null); const [refunding, setRefunding] = useState<any>(null); const [collecting, setCollecting] = useState<any>(null); const [advOpen, setAdvOpen] = useState<null | 'add' | 'back'>(null);
  const bills: any[] = q.data?.bills ?? []; const hist: any[] = adv.data?.history ?? [];
  const KIND: Record<string, string> = { deposit: 'Deposit', used: 'Used on a bill', refund: 'Given back' };
  return (
    // the record's tab already says Bills & payments: no title of its own, the advance button sits beside Invoices / Advance
    <section className="card-flat overflow-hidden anim-fade-up">
      <div className="flex flex-wrap items-end gap-x-4 px-4 pt-1.5"><Tabs className="min-w-0 flex-1" value={tab} onChange={setTab} options={[{ value: 'invoices', label: 'Invoices', count: bills.length }, { value: 'advance', label: 'Advance', count: hist.length }]} />
        {can(perms, 'payment.record') && <button className="btn btn-sm mb-1.5" onClick={() => setAdvOpen('add')}><Icon name="wallet" className="h-3.5 w-3.5" />Advance {money(adv.data?.balancePaise ?? 0)} · add</button>}</div>
      <div className="p-4">
        {!q.data ? <div className="text-sm text-muted">Loading…</div> : tab === 'invoices' ? <>
          <Totals line t={q.data.totals} advance={adv.data?.balancePaise ?? 0} onCourses={onCourses} />
          <div className="-mx-4"><InvoiceTable bills={bills} onView={(b) => setViewing(b.id)} onCollect={setCollecting} onRefund={setRefunding} empty="Add bill / payment makes the first one." /></div>
        </> : <>
          <div className="mb-3 flex flex-wrap items-center gap-2"><span className="text-[15px]">Balance <b className="tabular-nums">{money(adv.data?.balancePaise ?? 0)}</b></span><span className="flex-1" />
            {can(perms, 'payment.record') && <button className="btn btn-sm btn-primary" onClick={() => setAdvOpen('add')}><Icon name="plus" className="h-3.5 w-3.5" />Add advance</button>}
            {can(perms, 'payment.refund') && (adv.data?.balancePaise ?? 0) > 0 && <button className="btn btn-sm" onClick={() => setAdvOpen('back')}>Give back</button>}</div>
          <AdvanceHistory rows={hist} kind={KIND} />
        </>}
      </div>
      {viewing && <InvoiceView id={viewing} onClose={() => setViewing(null)} onCollect={(b) => { setViewing(null); setCollecting(b); }} onRefund={(b) => { setViewing(null); setRefunding(b); }} />}
      {refunding && <RefundBill bill={refunding} onClose={() => setRefunding(null)} />}
      {collecting && <TakePayment patientId={patientId} patientName={patientName} onlyBill={collecting.id} onClose={() => { setCollecting(null); refreshBills(); }} />}
      {advOpen && <AdvanceDialog patientId={patientId} patientName={patientName} start={advOpen} onClose={() => setAdvOpen(null)} />}
    </section>
  );
}

/** The clinic's billing list: every invoice in a period, searchable, with the same actions as on the patient. */
export function Billing() {
  const today = new Date().toLocaleDateString('en-CA');
  const monthStart = today.slice(0, 8) + '01';
  const [from, setFrom] = useState(today); const [to, setTo] = useState(today); const [term, setTerm] = useState('');
  const q = useQuery({ queryKey: ['bills', 'clinic', from, to, term], queryFn: () => get(`/bills?from=${from}&to=${to}${term.trim() ? `&q=${encodeURIComponent(term.trim())}` : ''}`), placeholderData: (p: any) => p });
  const [viewing, setViewing] = useState<string | null>(null); const [refunding, setRefunding] = useState<any>(null); const [collecting, setCollecting] = useState<any>(null);
  const preset = (f: string, t: string) => { setFrom(f); setTo(t); };
  const d = q.data;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <span className="mr-auto" />
        <div className="relative"><Icon name="search" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" /><input className="input !w-64 !pl-9" aria-label="Search invoices" placeholder="Patient, phone or invoice no" maxLength={60} value={term} onChange={(e) => setTerm(e.target.value)} /></div>
        <div className="flex gap-1.5">{[['Today', today, today], ['This month', monthStart, today]].map(([l, f, t]) => <button key={l} type="button" aria-pressed={from === f && to === t} className={`toggle-opt ${from === f && to === t ? 'on' : ''}`} onClick={() => preset(f, t)}>{l}</button>)}</div>
        <label className="text-xs text-muted">From<input type="date" className="input !w-auto" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} /></label>
        <label className="text-xs text-muted">To<input type="date" className="input !w-auto" value={to} min={from} max={today} onChange={(e) => e.target.value && setTo(e.target.value)} /></label>
      </div>
      {!d ? <div className="text-sm text-muted">Loading…</div> : <>
        <Totals t={d.totals} />
        <Section title={<>Invoices <span className="font-normal text-muted">· {d.bills.length}</span></>}>
          <InvoiceTable bills={d.bills} showPatient onView={(b) => setViewing(b.id)} onCollect={setCollecting} onRefund={setRefunding} empty="No invoices in these dates." />
        </Section>
      </>}
      {viewing && <InvoiceView id={viewing} onClose={() => setViewing(null)} onCollect={(b) => { setViewing(null); setCollecting(b); }} onRefund={(b) => { setViewing(null); setRefunding(b); }} />}
      {refunding && <RefundBill bill={refunding} onClose={() => setRefunding(null)} />}
      {collecting && <TakePayment patientId={collecting.patient.id} patientName={collecting.patient.fullName} onlyBill={collecting.id} onClose={() => { setCollecting(null); refreshBills(); }} />}
    </div>
  );
}
