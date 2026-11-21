import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useOutletContext } from 'react-router';
import { get, post, qc, errText } from './api';
import { can } from './App';
import { Chip, Empty, Icon, Modal, MoneyInput, MoreMenu, Section, Stat, Tabs, ask, fmtDate, money, toPaise, toast } from './ui';
import { printReceipt, printWindow } from './invoices';
import { TakePayment, BILL_KEYS, moneyErr } from './takePayment';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const MODE: Record<string, string> = { cash: 'Cash', upi: 'UPI', card: 'Card', bank: 'Bank', emi: 'EMI', advance: 'Advance' };
const STATUS: Record<string, [string, string]> = { paid: ['Paid fully', 'sage'], part: ['Part paid', 'amber'], unpaid: ['Unpaid', 'rose'], cancelled: ['Cancelled', ''], credited: ['Refunded', ''], waiting: ['Discount awaiting approval', 'amber'] };
const pctOf = (bp: number) => (bp ? `${bp / 100}%` : 'Exempt');
/** The reason a bill came down, as the desk would say it ("Refunded: …" / "Not given: …" are how the server keeps it). */
export const plainReason = (note: unknown) => String(note ?? '').replace(/^Refunded:\s*/, 'Refund: ').replace(/^Not given:\s*/, 'Removed: ');
const printDoc = (html: string, what: string) => printWindow(html, what);
const DOC_CSS = `body{font:13px system-ui,-apple-system,Segoe UI,sans-serif;margin:28px;color:#17191A}h1{font-size:19px;margin:0}.s{color:#5F625E;font-size:12px}
  .hd{display:flex;justify-content:space-between;gap:16px;border-bottom:2px solid #17191A;padding-bottom:10px}.t{text-align:center;font-weight:700;margin:10px 0}
  .who{display:flex;justify-content:space-between;gap:16px;border-bottom:1px solid #ccc;padding-bottom:8px;font-size:12.5px;line-height:1.6}
  table{width:100%;border-collapse:collapse;margin-top:10px}th{background:#F3F1EC;text-align:left;font-size:11px;letter-spacing:.04em;text-transform:uppercase;padding:7px 6px}td{padding:7px 6px;border-bottom:1px solid #eee}.r{text-align:right}
  .sum{margin-left:auto;width:340px;margin-top:10px}.sum div{display:flex;justify-content:space-between;padding:4px 0}.b{font-weight:700;border-top:1px solid #ccc;padding-top:7px!important}.g{color:#2E6B4F}.red{color:#A02A17}.x{text-decoration:line-through;color:#8A8D88}`;
const head = (c: any) => `<div>${c.print?.logoUrl ? `<img src="${esc(c.print?.logoUrl)}" alt="" style="display:block;height:44px;max-width:150px;object-fit:contain;margin-bottom:6px">` : ''}<h1>${esc(c.name)}</h1><div class="s">${esc(c.print?.address ?? '')}${c.print?.phone ? ' · ' + esc(c.print.phone) : ''}${c.gstin ? ' · GSTIN ' + esc(c.gstin) : ''}</div></div>`;
export const refreshBills = () => [...BILL_KEYS, 'bills', 'advance'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
const when = (at: string) => new Date(at).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });

/** The invoice as it prints, as it was issued: each line (a cancelled one struck), the totals, the GST at the GSTIN of that day split by rate,
 *  then the credit notes against it, the money applied to it, and what is due. Money given back is on its own voucher, not here. */
export function invoiceHtml(v: any) {
  const g = !!v.clinic.gstin; const st = STATUS[v.status]?.[0] ?? v.status;
  // money that came off this bill passes through the patient's advance on its way back: what was refunded is shown once, as a refund;
  // only what stayed is "kept as advance"
  const moved = v.payments.filter((p: any) => p.kind === 'moved').reduce((s: number, p: any) => s + Math.abs(p.amountPaise), 0);
  const kept = Math.max(0, moved - (v.refunds ?? []).reduce((s: number, r: any) => s + r.amountPaise, 0));
  const line = (p: any) => p.kind === 'advance' ? `Paid from advance · ${esc(fmtDate(p.at))}` : p.kind === 'moved' ? `Kept as advance · ${esc(fmtDate(p.at))}`
    : `Paid ${esc(MODE[p.method] ?? p.method)}${p.reference ? ' · ' + esc(p.reference) : ''}${p.receiptNo ? ' · ' + esc(p.receiptNo) : ''} · ${esc(fmtDate(p.at))}`;
  return `<!doctype html><meta charset="utf-8"><title>${esc(v.invoiceNo)}</title><style>${DOC_CSS}</style>
  <div class="hd">${head(v.clinic)}</div>
  <div class="t">${g ? 'Tax Invoice' : 'Bill of Supply'}</div>
  <div class="who"><div>Patient: <b>${esc(v.patient.fullName)}</b><br>Patient ID: ${esc(v.patient.patientNo)}<br>${v.patient.ageYears || v.patient.sex ? `Age / sex: ${esc([v.patient.ageYears ? v.patient.ageYears + 'y' : '', v.patient.sex ?? ''].filter(Boolean).join(', '))}<br>` : ''}${v.patient.phone ? 'Mobile: ' + esc(v.patient.phone) : ''}</div>
  <div class="r">Invoice no: <b>${esc(v.invoiceNo)}</b><br>Date: ${esc(when(v.createdAt))}<br>Status: <b>${esc(st)}</b></div></div>
  <table><tr><th>#</th><th>Item</th><th class="r">Price</th><th class="r">Discount</th>${g ? '<th class="r">GST</th>' : ''}<th class="r">Amount</th></tr>
  ${v.rows.map((r: any, i: number) => { const off = ['cancelled', 'waived'].includes(r.status); return `<tr><td>${i + 1}</td><td>${esc(r.description)}${off ? ` <span class="s">(${esc(r.status)}${r.reason ? ': ' + esc(r.reason) : ''})</span>` : ''}${r.discountPaise && r.discountReason ? `<div class="s">Discount: ${esc(r.discountReason)}</div>` : ''}</td><td class="r${off ? ' x' : ''}">${esc(money(r.listPaise))}</td><td class="r">${r.discountPaise ? '−' + esc(money(r.discountPaise)) : '—'}</td>${g ? `<td class="r">${pctOf(r.taxRateBp)}</td>` : ''}<td class="r${off ? ' x' : ''}">${esc(money(r.amountPaise))}</td></tr>`; }).join('')}</table>
  ${v.status === 'cancelled' ? `<div class="sum"><div><span>Subtotal</span><span class="x">${esc(money(v.rows.reduce((n: number, r: any) => n + r.listPaise, 0)))}</span></div><div class="b red"><span>Cancelled${v.rows[0]?.reason ? ': ' + esc(v.rows[0].reason) : ''}</span><span>₹0</span></div></div>` : ''}
  ${v.status === 'cancelled' ? '' : `<div class="sum"><div><span>Subtotal</span><span>${esc(money(v.subtotalPaise))}</span></div>${v.discountPaise ? `<div><span>Discount</span><span>−${esc(money(v.discountPaise))}</span></div>` : ''}
  <div class="b"><span>Invoice total</span><span>${esc(money(v.billedPaise))}</span></div>
  ${g ? v.gst.rates.map((x: any) => x.rateBp ? `<div class="s"><span>Taxable at ${pctOf(x.rateBp)} ${esc(money(x.taxablePaise))} · CGST ${x.rateBp / 200}%</span><span>${esc(money(x.cgstPaise))}</span></div><div class="s"><span>SGST ${x.rateBp / 200}%</span><span>${esc(money(x.sgstPaise))}</span></div>` : `<div class="s"><span>Exempt</span><span>${esc(money(x.taxablePaise))}</span></div>`).join('') : ''}
  ${v.creditNotes.map((n: any) => `<div class="s"><span>${esc(plainReason(n.reason))} · ${esc(fmtDate(n.at))}${g ? ` · GST ref ${esc(n.creditNo)}` : ''}</span><span>−${esc(money(n.totalPaise))}</span></div>`).join('')}
  ${v.creditedPaise ? `<div class="b"><span>Bill after refunds</span><span>${esc(money(v.netPaise))}</span></div>` : ''}
  ${v.payments.filter((p: any) => p.kind !== 'moved').map((p: any) => `<div class="s"><span>${line(p)}</span><span>${p.amountPaise < 0 ? '−' : ''}${esc(money(Math.abs(p.amountPaise)))}</span></div>`).join('')}
  ${(v.refunds ?? []).map((r: any) => `<div class="s red"><span>Refunded to the patient · ${esc(r.voucherNo ?? '')} · ${esc(r.methods.map((m: string) => MODE[m] ?? m).join(' + '))} · ${esc(fmtDate(r.at))}</span><span>−${esc(money(r.amountPaise))}</span></div>`).join('')}
  ${kept ? `<div class="s"><span>Kept as advance for the next visit</span><span>−${esc(money(kept))}</span></div>` : ''}
  <div class="b g"><span>Paid on this invoice</span><span>${esc(money(v.paidPaise))}</span></div>
  ${v.duePaise ? `<div class="b red"><span>Due</span><span>${esc(money(v.duePaise))}</span></div>` : ''}${v.waitingOffPaise ? `<div class="s"><span>Of which a discount awaiting approval</span><span>${esc(money(v.waitingOffPaise))}</span></div>` : ''}</div>`}
  <p class="s" style="margin-top:22px">${g ? 'Prices include GST.' : 'Not registered for GST, so no tax is charged on this bill.'} ${esc(v.clinic.print?.footer ?? '')}</p>`;
}

/** The refund slip as it prints (under GST it is the credit note, and says so in one line): the invoice it comes off, each item and amount at
 *  the GST it was invoiced with (taxable value, CGST, SGST reversed by rate on a Tax Invoice), why, and what happened to the money: refunded,
 *  kept as advance, or simply no longer due. */
export function creditNoteHtml(n: any) {
  const g = !!n.clinic.gstin;
  const money_ = [n.refundNo ? `<div class="s"><span>Refunded to the patient · ${esc(n.refundNo)}</span><span>${esc(money(n.refundedPaise))}</span></div>` : '',
    n.toAdvancePaise ? `<div class="s"><span>Kept as advance for the next visit</span><span>${esc(money(n.toAdvancePaise))}</span></div>` : '',
    !n.refundNo && !n.toAdvancePaise ? `<div class="s"><span>No longer due</span><span>${esc(money(n.totalPaise))}</span></div>` : ''].join('');
  const title = n.refundNo || n.toAdvancePaise ? 'Refund' : 'Bill adjustment';
  return `<!doctype html><meta charset="utf-8"><title>${esc(n.creditNo)}</title><style>${DOC_CSS}</style>
  <div class="hd">${head(n.clinic)}</div><div class="t">${title}${g ? '<div class="s" style="font-weight:400">Credit note under GST</div>' : ''}</div>
  <div class="who"><div>Patient: <b>${esc(n.patient.fullName)}</b><br>Patient ID: ${esc(n.patient.patientNo)}${n.patient.phone ? '<br>Mobile: ' + esc(n.patient.phone) : ''}</div>
  <div class="r">${g ? 'GST ref' : 'Ref'}: <b>${esc(n.creditNo)}</b><br>Date: ${esc(when(n.createdAt))}<br>Against ${g ? 'Tax Invoice' : 'invoice'}: <b>${esc(n.invoiceNo)}</b> of ${esc(fmtDate(n.invoiceAt))}</div></div>
  <table><tr><th>#</th><th>Item</th>${g ? '<th class="r">GST</th>' : ''}<th class="r">Amount</th></tr>${n.lines.map((l: any, i: number) => `<tr><td>${i + 1}</td><td>${esc(l.what)}</td>${g ? `<td class="r">${pctOf(l.taxRateBp)}</td>` : ''}<td class="r">${esc(money(l.amountPaise))}</td></tr>`).join('')}</table>
  <div class="sum"><div class="b"><span>Off the bill</span><span>${esc(money(n.totalPaise))}</span></div>
  ${g ? n.gst.rates.map((x: any) => x.rateBp ? `<div class="s"><span>Taxable value reversed at ${pctOf(x.rateBp)} ${esc(money(x.taxablePaise))} · CGST ${x.rateBp / 200}%</span><span>${esc(money(x.cgstPaise))}</span></div><div class="s"><span>SGST ${x.rateBp / 200}%</span><span>${esc(money(x.sgstPaise))}</span></div>` : `<div class="s"><span>Exempt</span><span>${esc(money(x.taxablePaise))}</span></div>`).join('') : ''}
  ${money_}</div>
  <p class="s" style="margin-top:18px">${esc(plainReason(n.reason))}${g ? '. Prices include GST.' : ''}</p>`;
}

/** Print an invoice, or a refund slip, in its own window. */
export async function printInvoice(id: string) { try { printDoc(invoiceHtml(await get(`/bills/${id}`)), 'invoice'); } catch (e) { toast(errText(e), 'err'); } }
export async function printCreditNote(id: string) { try { printDoc(creditNoteHtml(await get(`/credit-notes/${id}`)), 'refund slip'); } catch (e) { toast(errText(e), 'err'); } }

/** Cancel an unpaid invoice: the reason is asked (and checked) in the box; nothing paid, so nothing moves. */
async function cancelInvoice(id: string, invoiceNo: string) {
  const a = await ask({ title: `Cancel ${invoiceNo}?`, body: 'Nothing has been paid on it. It stays on record, struck through.', confirmLabel: 'Cancel invoice', cancelLabel: 'Keep', tone: 'danger', field: { label: 'Why (at least 3 letters)', placeholder: 'for example: wrong patient', required: true, minLength: 3, maxLength: 200 } });
  if (!a) return;
  try { const v: any = await get(`/bills/${id}`); for (const c of v.lines.filter((c: any) => c.status === 'due')) await post(`/charges/${c.id}/cancel`, { reason: a.value }); refreshBills(); toast(`${invoiceNo} cancelled`); } catch (e) { toast(errText(e), 'err'); }
}

/** The invoices table, the same on the patient's Bills tab and on the clinic's Billing page. */
export function InvoiceTable({ bills, showPatient, onView, onCollect, onRefund, empty }: { bills: any[]; showPatient?: boolean; onView: (b: any) => void; onCollect?: (b: any) => void; onRefund?: (b: any) => void; empty: string }) {
  const { perms } = useOutletContext<any>();
  const mayRefund = can(perms, 'payment.refund'); const mayCollect = can(perms, 'payment.record'); const mayExclude = can(perms, 'config.write'); // the owner: it changes the GST report
  const [refunding, setRefunding] = useState<any>(null);
  const exclude = async (b: any) => {
    const a = await ask({ title: `Leave ${b.invoiceNo} out of the tax reports?`, confirmLabel: 'Leave out', cancelLabel: 'Keep in', field: { label: 'Why (at least 3 letters)', required: true, minLength: 3, maxLength: 200 } }); if (!a) return;
    try { for (const c of b.lines.filter((c: any) => !c.excludedAt)) await post(`/charges/${c.id}/exclude`, { reason: a.value }); refreshBills(); toast('Left out of the tax reports'); } catch (e) { toast(errText(e), 'err'); }
  };
  if (!bills.length) return <Empty icon="rupee" title="No invoices" hint={empty} />;
  return (
    <div className="overflow-x-auto overflow-y-hidden"><table className="table min-w-[860px]">
      <thead><tr><th className="pl-4">#</th><th>Invoice no &amp; date</th>{showPatient && <th>Patient</th>}<th>Items</th><th className="text-right">Billed</th><th className="text-right">Refunded</th><th className="text-right">Paid</th><th className="text-right">Due</th><th>Status</th><th className="pr-4 text-right">Action</th></tr></thead>
      <tbody>{bills.map((b, i) => { const [label, tone] = STATUS[b.status] ?? [b.status, '']; const cancelled = b.status === 'cancelled';
        return <tr key={b.id} className="cursor-pointer hover:bg-surface-2/60" onClick={() => onView(b)}>
          <td className="pl-4 text-muted tabular-nums">{i + 1}</td>
          <td><button type="button" className="font-semibold text-clay hover:underline" onClick={(e) => { e.stopPropagation(); onView(b); }}>{b.invoiceNo}</button><div className="text-xs text-muted">{fmtDate(b.createdAt)}</div></td>
          {showPatient && <td><div className="font-medium">{b.patient.fullName}</div><div className="text-xs text-muted">{b.patient.phone ?? b.patient.patientNo}</div></td>}
          <td className="max-w-[260px]"><div className="truncate text-sm">{b.items.join(', ')}</div>{b.waitingOffPaise > 0 && <div className="text-xs text-amber">{money(b.waitingOffPaise)} discount waiting for approval</div>}</td>
          <td className="text-right tabular-nums">{cancelled ? <s className="text-muted">{money(b.lines.reduce((n: number, c: any) => n + c.amountPaise, 0))}</s> : money(b.billedPaise)}{b.discountPaise > 0 && <div className="text-xs text-muted">−{money(b.discountPaise)} off</div>}</td>
          <td className="text-right tabular-nums">{b.creditedPaise ? `−${money(b.creditedPaise)}` : '–'}</td>
          <td className="text-right tabular-nums">{money(b.paidPaise)}</td>
          <td className={`text-right tabular-nums ${b.collectablePaise ? 'font-semibold text-rose' : b.duePaise ? 'text-amber' : ''}`}>{money(b.duePaise)}</td>
          <td><Chip tone={tone as any}>{label}</Chip>{b.excluded && <span> <Chip>Not in tax reports</Chip></span>}</td>
          <td className="pr-4" onClick={(e) => e.stopPropagation()}><span className="flex items-center justify-end gap-1">
            <button type="button" className="btn btn-ghost btn-sm !px-2" title="Print" aria-label={`Print ${b.invoiceNo}`} onClick={() => printInvoice(b.id)}><Icon name="print" className="h-4 w-4" /></button>
            <button type="button" className="btn btn-ghost btn-sm !px-2" title="View" aria-label={`View ${b.invoiceNo}`} onClick={() => onView(b)}><Icon name="eye" className="h-4 w-4" /></button>
            {(() => { const items = [
              { label: `Collect ${money(b.collectablePaise)}`, hidden: !(mayCollect && onCollect && b.collectablePaise > 0), onClick: () => onCollect!(b) },
              { label: b.paidPaise > 0 ? 'Refund' : 'Remove item', hidden: !(mayRefund && !cancelled && (b.billedPaise - b.creditedPaise > 0 || b.paidPaise > 0)), danger: true, onClick: () => (onRefund ?? setRefunding)(b) },
              { label: 'Cancel invoice', hidden: !(mayRefund && b.status === 'unpaid' && !b.creditedPaise), danger: true, onClick: () => cancelInvoice(b.id, b.invoiceNo) },
              { label: 'Leave out of tax reports', hidden: !(mayExclude && !b.excluded && !cancelled), onClick: () => exclude(b) },
            ]; return items.some((x) => !x.hidden) ? <MoreMenu items={items} /> : null; })()}
          </span></td>
        </tr>; })}</tbody>
    </table>{refunding && <RefundBill bill={refunding} onClose={() => setRefunding(null)} />}</div>
  );
}

/** View bill: the invoice as it prints on the right, what can be done with it on the left. */
export function InvoiceView({ id, onClose, onCollect }: { id: string; onClose: () => void; onCollect?: (b: any) => void; onRefund?: (b: any) => void }) {
  const { perms } = useOutletContext<any>();
  const q = useQuery({ queryKey: ['bills', 'one', id], queryFn: () => get(`/bills/${id}`) }); const v: any = q.data; const [refunding, setRefunding] = useState(false);
  if (refunding && v) return <RefundBill bill={v} onClose={() => { setRefunding(false); onClose(); }} />;
  const Row = ({ k, val, tone = '' }: { k: string; val: string; tone?: string }) => <div className="flex justify-between"><span className="text-muted">{k}</span><b className={`tabular-nums ${tone}`}>{val}</b></div>;
  return (
    <Modal title={v ? `Invoice ${v.invoiceNo}` : 'Invoice'} subtitle={v ? `${v.patient.fullName} · ${when(v.createdAt)}` : undefined} onClose={onClose} width="max-w-5xl">
      {!v ? <div className="text-sm text-muted">Loading…</div> : (
        <div className="grid gap-5 md:grid-cols-[230px_minmax(0,1fr)]">
          <div className="space-y-2">
            <button className="btn w-full justify-start" onClick={() => printInvoice(v.id)}><Icon name="print" className="h-4 w-4" />Print invoice</button>
            {v.receipts.map((r: string) => <button key={r} className="btn w-full justify-start" onClick={() => printReceipt(r)}><Icon name="print" className="h-4 w-4" />Print receipt {r}</button>)}
            {v.creditNotes.map((n: any) => <button key={n.id} className="btn w-full justify-start" onClick={() => printCreditNote(n.id)}><Icon name="print" className="h-4 w-4" />Print refund slip · {fmtDate(n.at)}</button>)}
            {can(perms, 'payment.record') && onCollect && v.collectablePaise > 0 && <button className="btn btn-primary w-full justify-start" onClick={() => onCollect(v)}><Icon name="rupee" className="h-4 w-4" />Collect {money(v.collectablePaise)}</button>}
            {can(perms, 'payment.refund') && v.status !== 'cancelled' && (v.billedPaise - v.creditedPaise > 0 || v.paidPaise > 0) && <button className="btn w-full justify-start" onClick={() => setRefunding(true)}><Icon name="undo" className="h-4 w-4" />{v.paidPaise > 0 ? 'Refund' : 'Remove item'}</button>}
            <div className="space-y-0.5 rounded-xl bg-surface-2 p-3 text-sm">
              <Row k="Billed" val={money(v.billedPaise)} />
              {v.creditedPaise > 0 && <Row k="Refunded / removed" val={`−${money(v.creditedPaise)}`} />}
              <Row k="Paid" val={money(v.paidPaise)} tone="text-sage" />
              <Row k="Due" val={money(v.duePaise)} tone={v.collectablePaise ? 'text-rose' : v.duePaise ? 'text-amber' : ''} />
              {v.waitingOffPaise > 0 && <div className="text-xs text-muted">{money(v.waitingOffPaise)} of it is a discount awaiting approval</div>}
              <div className="pt-1.5"><Chip tone={(STATUS[v.status]?.[1] ?? '') as any}>{STATUS[v.status]?.[0] ?? v.status}</Chip></div>
            </div>
          </div>
          <iframe title={`Invoice ${v.invoiceNo}`} className="h-[62vh] w-full rounded-xl border border-line bg-white" srcDoc={invoiceHtml(v)} />
        </div>)}
    </Modal>
  );
}

type RPart = { method: 'cash' | 'upi' | 'card' | 'bank'; amount: string; reference: string };
/**
 * Refund: items come off the bill. What was paid on them is given back now or kept as the patient's advance for the next visit; what was not
 * paid simply stops being due. The desk only ever sees Paid, Due, Refund and Advance: with a GSTIN the app keeps the GST record (a credit
 * note) on its own, in one step. "Money taken by mistake" gives money back with nothing off the bill, so that much is due again.
 */
export function RefundBill({ bill, onClose }: { bill: any; onClose: () => void }) {
  const q = useQuery({ queryKey: ['bills', 'one', bill.id], queryFn: () => get(`/bills/${bill.id}`) });
  const acc = useQuery({ queryKey: ['bills', 'account', bill.patient.id], queryFn: () => get(`/patients/${bill.patient.id}/account`) });
  if (!q.data) return <Modal title={`Refund on ${bill.invoiceNo}`} onClose={onClose} width="max-w-lg"><div className="text-sm text-muted">Loading…</div></Modal>;
  return <RefundForm b={q.data} closed={!!acc.data?.dayClosed} onClose={onClose} />;
}

function RefundForm({ b, closed, onClose }: { b: any; closed: boolean; onClose: () => void }) {
  const [key] = useState(() => crypto.randomUUID()); // one refund, however many times it is sent
  const [why, setWhy] = useState(''); const [offs, setOffs] = useState<Record<string, string>>({});
  const [dest, setDest] = useState<'back' | 'advance'>('back'); const [mistake, setMistake] = useState(false);
  const [parts, setParts] = useState<RPart[]>([{ method: 'cash', amount: '', reference: '' }]); const [typed, setTyped] = useState(false);
  const items = (b.lines ?? []).filter((c: any) => !['cancelled', 'waived'].includes(c.status))
    .map((c: any) => ({ id: c.id, what: c.description, paid: b.paidOn?.[c.id] ?? 0, left: c.amountPaise - (b.creditedOn?.[c.id] ?? 0) }))
    .filter((c: any) => (mistake ? c.paid : c.left) > 0);
  // per item: what comes off the bill, and of it what was already paid (that money is given back or kept as advance; the rest stops being due)
  const rows = items.map((c: any) => { const typedOff = toPaise(offs[c.id] ?? ''); const max = mistake ? c.paid : c.left;
    const paidPart = mistake ? typedOff : Math.max(0, Math.min(typedOff, c.paid - (c.left - typedOff))); return { ...c, max, off: typedOff, paidPart }; });
  const offTotal = rows.reduce((s: number, r: any) => s + r.off, 0); const paidTotal = rows.reduce((s: number, r: any) => s + r.paidPart, 0);
  const unpaidTotal = mistake ? 0 : offTotal - paidTotal; const back = mistake || dest === 'back' ? paidTotal : 0; const toAdv = paidTotal - back;
  // the money going back: one method takes all of it until someone splits it
  useEffect(() => { if (!typed) setParts((ps) => [{ ...ps[0], amount: back ? String(back / 100) : '' }]); }, [back, typed]);
  const partsTotal = parts.reduce((s, p) => s + toPaise(p.amount), 0);
  const over = rows.find((r: any) => r.off > r.max);
  const bad = !offTotal ? (mistake ? 'Type how much is given back' : 'Type how much comes off') : over ? `Only ${money(over.max)} ${mistake ? 'was paid on' : 'is on the bill for'} ${over.what}`
    : back && closed ? 'Today has been closed: no money can be given back today' : back && partsTotal !== back ? `The refund lines add up to ${money(partsTotal)}, not ${money(back)}`
    : back && parts.some((p) => p.method === 'card' && toPaise(p.amount) > 0 && p.reference.trim().length < 4) ? 'Card refunds need the reference' : why.trim().length < 3 ? 'Say why' : '';
  const go = useMutation({
    mutationFn: () => {
      const named = rows.filter((r: any) => r.off > 0); const reason = why.trim();
      const money_ = parts.filter((p) => toPaise(p.amount) > 0).map((p) => ({ method: p.method, amountPaise: toPaise(p.amount), reference: p.method !== 'cash' ? p.reference.trim() || undefined : undefined }));
      if (mistake) return post(`/bills/${b.id}/refund`, { lower: false, idempotencyKey: key, reason, parts: money_, lines: named.map((r: any) => ({ chargeId: r.id, amountPaise: r.off })) });
      if (!back) return post(`/bills/${b.id}/credit`, { idempotencyKey: key, reason, lines: named.map((r: any) => ({ chargeId: r.id, amountPaise: r.off })) });
      return post(`/bills/${b.id}/refund`, { lower: true, idempotencyKey: key, reason, parts: money_, lines: named.map((r: any) => ({ chargeId: r.id, amountPaise: r.paidPart, offPaise: r.off })) });
    },
    onSuccess: (r: any) => {
      refreshBills(); onClose();
      if (back) toast(`${money(back)} refunded on ${b.invoiceNo}`, 'ok', r?.receiptNo ? { label: 'Print receipt', run: () => printReceipt(r.receiptNo) } : undefined);
      else if (toAdv) toast(`${money(toAdv)} kept as advance for ${b.patient.fullName}`);
      else toast(`${money(offTotal)} removed from ${b.invoiceNo}`);
    },
    onError: (e: any) => toast(e?.body?.code === 'MORE_THAN_PAID' ? `Only ${money(e.body.refundablePaise)} can be refunded` : moneyErr(e), 'err'),
  });
  const set = (i: number, patch: Partial<RPart>) => { setTyped(true); setParts(parts.map((p, j) => (j === i ? { ...p, ...patch } : p))); };
  const title = b.paidPaise > 0 ? `Refund on ${b.invoiceNo}` : `Remove from ${b.invoiceNo}`;
  return (
    <Modal title={title} subtitle={`${b.patient.fullName} · billed ${money(b.billedPaise - b.creditedPaise)} · paid ${money(b.paidPaise)} · due ${money(b.duePaise)}`} onClose={onClose} width="max-w-lg">
      <div className="space-y-3">
        <div className="space-y-1.5 rounded-xl border border-line p-2.5">
          <div className="text-[12.5px] font-semibold text-muted">{mistake ? 'How much is given back on each item' : 'What comes off the bill'}</div>
          {!rows.length && <div className="text-sm text-muted">{mistake ? 'Nothing was paid on this bill.' : 'Nothing is left on this bill.'}</div>}
          {rows.map((r: any) => <div key={r.id} className="flex items-center gap-2 text-sm">
            <span className="min-w-0 flex-1"><span className="font-medium">{r.what}</span><span className="block text-xs text-muted">{money(r.left)} on the bill · {r.paid ? `${money(r.paid)} paid` : 'not paid'}</span></span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOffs((o) => ({ ...o, [r.id]: String(r.max / 100) }))}>All of it</button>
            <MoneyInput className="w-32" value={offs[r.id] ?? ''} label={`${mistake ? 'Given back on' : 'Off'} ${r.what}`} onChange={(v) => setOffs((o) => ({ ...o, [r.id]: v }))} />
          </div>)}
        </div>
        {!mistake && unpaidTotal > 0 && <div className="text-[13px] text-muted">{money(unpaidTotal)} of it was not paid yet: it simply stops being due.</div>}
        {!mistake && paidTotal > 0 && <fieldset className="space-y-1.5"><legend className="label">The patient paid {money(paidTotal)} of it</legend>
          <label className="flex items-center gap-2 text-[13.5px]"><input type="radio" name="refund-dest" checked={dest === 'back'} onChange={() => setDest('back')} />Give it back now</label>
          <label className="flex items-center gap-2 text-[13.5px]"><input type="radio" name="refund-dest" checked={dest === 'advance'} onChange={() => setDest('advance')} />Keep it as advance for the next visit</label>
        </fieldset>}
        {back > 0 && <>
          {closed && <div className="rounded-lg bg-rose-soft px-3 py-2 text-[13px] text-rose">Today has been closed: no money can be given back today. Keep it as advance, or give it back tomorrow.</div>}
          <div className="space-y-2">{parts.map((p, i) => <div key={i} className="space-y-1.5">
            <div className="grid grid-cols-[110px_minmax(0,1fr)_28px] items-center gap-1.5">
              <select className="input !px-2" aria-label={`Refund by, line ${i + 1}`} value={p.method} onChange={(e) => set(i, { method: e.target.value as RPart['method'] })}>{(['cash', 'upi', 'card', 'bank'] as const).map((m) => <option key={m} value={m}>{MODE[m]}</option>)}</select>
              <MoneyInput value={p.amount} label={`Refund by ${MODE[p.method]}`} onChange={(v) => set(i, { amount: v })} />
              {parts.length > 1 ? <button type="button" className="btn btn-ghost btn-sm !px-1.5" aria-label="Remove this refund line" onClick={() => { setTyped(true); setParts(parts.filter((_, j) => j !== i)); }}><Icon name="x" className="h-3.5 w-3.5" /></button> : <span />}
            </div>
            {p.method !== 'cash' && <input className="input" maxLength={60} aria-label="Reference" placeholder={p.method === 'card' ? 'Card reference' : 'Reference (optional)'} value={p.reference} onChange={(e) => set(i, { reference: e.target.value })} />}
          </div>)}</div>
          {parts.length < 4 && <button type="button" className="inline-flex items-center gap-1 text-[13px] font-medium text-clay hover:underline" onClick={() => {
            const used = new Set(parts.map((p) => p.method)); const next = (['cash', 'upi', 'card', 'bank'] as const).find((m) => !used.has(m)) ?? 'upi';
            setTyped(true); setParts([...parts, { method: next, amount: back > partsTotal ? String((back - partsTotal) / 100) : '', reference: '' }]);
          }}><Icon name="plus" className="h-3.5 w-3.5" />Split: add another method</button>}
        </>}
        <div><label className="label" htmlFor="rb-why">Why</label><input id="rb-why" className="input" maxLength={200} placeholder="for example: procedure not done" value={why} onChange={(e) => setWhy(e.target.value)} /></div>
        {offTotal > 0 && <div className="space-y-0.5 rounded-xl bg-surface-2 p-3 text-[14px]">
          {!mistake && <div className="flex justify-between"><span className="text-muted">Comes off the bill</span><b className="tabular-nums">{money(offTotal)}</b></div>}
          {back > 0 && <div className="flex justify-between"><span className="text-muted">Refunded now</span><b className="tabular-nums text-rose">{money(back)}</b></div>}
          {toAdv > 0 && <div className="flex justify-between"><span className="text-muted">Kept as advance</span><b className="tabular-nums text-sage">{money(toAdv)}</b></div>}
          <div className="flex justify-between"><span className="text-muted">Due after this</span><b className="tabular-nums">{money(mistake ? b.duePaise + offTotal : Math.max(0, b.duePaise - unpaidTotal))}</b></div>
        </div>}
        {b.paidPaise > 0 && <label className="flex items-start gap-2 text-[12.5px] text-muted"><input type="checkbox" className="mt-0.5" checked={mistake} onChange={(e) => { setMistake(e.target.checked); setOffs({}); }} />
          <span>Money taken by mistake: give it back, but the patient still owes it (nothing comes off the bill)</span></label>}
        <div className="modal-foot"><span className="mr-auto text-xs text-muted" role="status">{bad}</span><button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!!bad || go.isPending} onClick={() => go.mutate()}>{back ? `Refund ${money(back)}` : toAdv ? `Keep ${money(toAdv)} as advance` : `Remove ${money(offTotal)}`}</button></div>
      </div>
    </Modal>
  );
}

/** Money tiles above an invoice list: billed as issued, credit notes, paid, due. */
function Totals({ t }: { t: any }) {
  return (
    <div className="mb-4 grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3">
      <Stat label={`Billed (${t.n})`} value={money(t.billedPaise)} sub={t.creditedPaise ? `${money(t.creditedPaise)} refunded or removed (${t.withCredit})` : 'as issued'} />
      <Stat label="Paid on invoices" value={money(t.paidPaise)} tone="sage" sub={`${t.fromAdvancePaise ? `${money(t.fromAdvancePaise)} from advance · ` : ''}${t.paidFully} paid fully`} />
      <Stat label={`Due (${t.withDue})`} value={money(t.duePaise)} tone={t.duePaise ? 'clay' : ''} sub={t.waitingOffPaise ? `${money(t.waitingOffPaise)} is a discount awaiting approval` : t.duePaise ? 'Collect from the ⋯ menu' : 'nothing owed'} />
    </div>
  );
}

const MODES = ['upi', 'cash', 'card', 'bank', 'emi'] as const;
type Act = { type: 'invoice' | 'payment' | 'refund' | 'credit' | 'discount'; at: string; id: string; [k: string]: any };
const TYPE: Record<Act['type'], [string, string]> = { invoice: ['Invoice', 'sky'], payment: ['Payment', 'sage'], refund: ['Refund', 'rose'], credit: ['Removed from bill', 'amber'], discount: ['Discount asked', ''] };

/** Record payment: money from the patient, not for one item. It clears the oldest dues first; the rest becomes the patient's advance. */
export function RecordPayment({ patientId, patientName, dues, dayClosed, onClose }: { patientId: string; patientName: string; dues: { invoiceNo: string; duePaise: number }[]; dayClosed?: boolean; onClose: () => void }) {
  const owed = dues.reduce((s, d) => s + d.duePaise, 0);
  const [amount, setAmount] = useState(owed ? String(owed / 100) : ''); const [mode, setMode] = useState<(typeof MODES)[number]>('upi');
  const [ref, setRef] = useState(''); const [lender, setLender] = useState(''); const [key] = useState(() => crypto.randomUUID());
  const paise = toPaise(amount);
  let left = paise; const goes = dues.map((d) => { const take = Math.min(left, d.duePaise); left -= take; return { ...d, take }; }).filter((d) => d.take > 0);
  const bad = dayClosed ? 'Today has been closed: no money can be taken today' : paise <= 0 ? 'Type the amount' : mode === 'emi' && paise > owed ? `EMI pays a bill: at most the ${money(owed)} due` : mode === 'emi' && (!lender.trim() || !ref.trim()) ? 'EMI needs the lender and the approval code' : (mode === 'upi' || mode === 'card') && !ref.trim() ? 'Type the UPI or card reference' : '';
  const save = async () => {
    if (left > 0 && !(await ask({ title: owed ? `${money(left)} more than is due` : `Take ${money(paise)} as advance?`, body: owed ? `${money(owed)} clears what is due; ${money(left)} goes to ${patientName.split(' ')[0]}'s advance, to use on the next bill or give back.` : 'Nothing is due: all of it goes to the advance.', confirmLabel: `Record ${money(paise)}` }))) return;
    go.mutate();
  };
  const go = useMutation({ mutationFn: () => post(`/patients/${patientId}/payments`, { amountPaise: paise, method: mode, reference: mode !== 'cash' ? ref.trim() || undefined : undefined, lender: mode === 'emi' ? lender.trim() || undefined : undefined, idempotencyKey: key }),
    onSuccess: (r: any) => { refreshBills(); toast(`${money(paise)} ${MODE[mode]} from ${patientName.split(' ')[0]}${r.keptAsAdvancePaise ? ` · ${money(r.keptAsAdvancePaise)} to the advance` : ''}`, 'ok', r.receiptNo ? { label: 'Receipt', run: () => printReceipt(r.receiptNo) } : undefined); onClose(); },
    onError: (e) => toast(moneyErr(e), 'err') });
  return (
    <Modal title="Record payment" subtitle={`${patientName} · money from the patient, not for one item`} onClose={onClose} width="max-w-md">
      <div className="space-y-3.5">
        <div className="flex gap-6"><div><div className="text-[12.5px] text-muted">Due now</div><b className={`text-[18px] tabular-nums ${owed ? 'text-amber' : ''}`}>{money(owed)}</b></div></div>
        <div><label className="label" htmlFor="rp-amt">Amount</label><MoneyInput id="rp-amt" autoFocus value={amount} onChange={setAmount} /></div>
        <div><span className="label">Mode</span><div className="flex flex-wrap gap-1.5">{MODES.map((m) => <button key={m} type="button" aria-pressed={mode === m} className={`toggle-opt !py-1 ${mode === m ? 'on' : ''}`} onClick={() => setMode(m)}>{MODE[m]}</button>)}</div></div>
        {mode !== 'cash' && <div><label className="label" htmlFor="rp-ref">{mode === 'emi' ? 'Approval code' : 'Reference'}</label><input id="rp-ref" className="input" maxLength={60} value={ref} onChange={(e) => setRef(e.target.value)} /></div>}
        {mode === 'emi' && <div><label className="label" htmlFor="rp-lender">Lender</label><input id="rp-lender" className="input" maxLength={60} placeholder="for example Bajaj Finserv" value={lender} onChange={(e) => setLender(e.target.value)} /></div>}
        {paise > 0 && <div className="rounded-xl border border-line p-3 text-sm">
          <div className="mb-1 text-[12.5px] font-semibold text-muted">Where it goes · oldest due first</div>
          {goes.map((d) => <div key={d.invoiceNo} className="flex justify-between"><span>{d.invoiceNo}</span><span className="tabular-nums">{money(d.take)} of {money(d.duePaise)}</span></div>)}
          <div className="flex justify-between"><span className="text-muted">To the advance</span><b className="tabular-nums">{money(Math.max(0, left))}</b></div>
        </div>}
        <div className="modal-foot"><span className="mr-auto text-xs text-muted" role="status">{bad}</span><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!!bad || go.isPending} onClick={save}><Icon name="check" />Record {money(paise)}</button></div>
      </div>
    </Modal>
  );
}

/** Refund: money back to the patient from their advance, with a reason. Money on a treatment not given reaches the advance when its unused sessions are cancelled. */
export function PatientRefund({ patientId, patientName, advancePaise, emiHeldPaise = 0, dayClosed, onClose }: { patientId: string; patientName: string; advancePaise: number; emiHeldPaise?: number; dayClosed?: boolean; onClose: () => void }) {
  const free = Math.max(0, advancePaise - emiHeldPaise);
  const [amount, setAmount] = useState(''); const [mode, setMode] = useState<'cash' | 'upi' | 'card' | 'bank'>('upi'); const [why, setWhy] = useState(''); const [ref, setRef] = useState('');
  const paise = toPaise(amount);
  const bad = dayClosed ? 'Today has been closed: no money can be given back today' : !advancePaise ? 'Nothing in the advance to give back' : paise <= 0 ? 'Type the amount' : paise > advancePaise ? `Only ${money(advancePaise)} is in the advance`
    : paise > free ? `${money(emiHeldPaise)} of the advance is EMI the lender has not paid yet: at most ${money(free)} can go back now` : why.trim().length < 3 ? 'Say why' : '';
  const [key] = useState(() => crypto.randomUUID());
  const go = useMutation({ mutationFn: () => post(`/patients/${patientId}/advance/refund`, { idempotencyKey: key, amountPaise: paise, method: mode, reference: mode !== 'cash' ? ref.trim() || undefined : undefined, reason: why.trim() }),
    onSuccess: (r: any) => { refreshBills(); toast(`Refunded ${money(paise)} to ${patientName.split(' ')[0]}`, 'ok', r?.receiptNo ? { label: 'Print receipt', run: () => printReceipt(r.receiptNo) } : undefined); onClose(); }, onError: (e) => toast(moneyErr(e), 'err') });
  return (
    <Modal title="Refund" subtitle={`${patientName} · from the patient's advance`} onClose={onClose} width="max-w-md">
      <div className="space-y-3.5">
        <div><div className="text-[12.5px] text-muted">Advance available</div><b className="text-[18px] tabular-nums text-sage">{money(advancePaise)}</b></div>
        <div><label className="label" htmlFor="rf-amt">Amount</label><MoneyInput id="rf-amt" autoFocus value={amount} onChange={setAmount} placeholder={`up to ${money(advancePaise).replace('₹', '')}`} /></div>
        <div><span className="label">Give back by</span><div className="flex flex-wrap gap-1.5">{(['upi', 'cash', 'card', 'bank'] as const).map((m) => <button key={m} type="button" aria-pressed={mode === m} className={`toggle-opt !py-1 ${mode === m ? 'on' : ''}`} onClick={() => setMode(m)}>{MODE[m]}</button>)}</div></div>
        {mode !== 'cash' && <div><label className="label" htmlFor="rf-ref">Reference</label><input id="rf-ref" className="input" maxLength={60} placeholder="UPI or bank reference (optional)" value={ref} onChange={(e) => setRef(e.target.value)} /></div>}
        <div><label className="label" htmlFor="rf-why">Reason</label><input id="rf-why" className="input" maxLength={200} placeholder="for example: stopped the treatment" value={why} onChange={(e) => setWhy(e.target.value)} /></div>
        <div className="rounded-lg bg-surface-2 px-3 py-2.5 text-[12.5px] text-muted">Money on a treatment not given yet? Cancel its unused sessions on the patient's Procedures first: they come off the bill and what was paid for them is kept as advance.</div>
        <div className="modal-foot"><span className="mr-auto text-xs text-muted" role="status">{bad}</span><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!!bad || go.isPending} onClick={() => go.mutate()}>Refund {money(paise)}</button></div>
      </div>
    </Modal>
  );
}

/** The patient's Bills & payments: one account. Billed, received, refunded, and what is due or held as advance; three actions; one list of invoices, payments, refunds and credits. */
export function BillingHistory({ patientId, patientName }: { patientId: string; patientName: string }) {
  const { perms } = useOutletContext<any>();
  const q = useQuery({ queryKey: ['bills', 'account', patientId], queryFn: () => get(`/patients/${patientId}/account`) });
  const [viewing, setViewing] = useState<string | null>(null); const [refundingBill, setRefundingBill] = useState<any>(null); const [collecting, setCollecting] = useState<any>(null);
  const [open, setOpen] = useState<null | 'invoice' | 'payment' | 'refund'>(null);
  const t = q.data?.totals; const rows: Act[] = q.data?.activity ?? [];
  const dues = rows.filter((r) => r.type === 'invoice' && r.collectablePaise > 0).sort((a, b) => String(a.at).localeCompare(String(b.at))).map((r) => ({ invoiceNo: r.invoiceNo, duePaise: r.collectablePaise }));
  const Fig = ({ label, value, tone = '' }: { label: string; value: string; tone?: string }) => <div><div className="text-[12.5px] text-muted">{label}</div><b className={`text-[18px] tabular-nums ${tone}`}>{value}</b></div>;
  const balance = t ? <>{(t.duePaise > 0 || !t.advancePaise) && <div><div className="text-[12.5px] text-muted">Due</div><b className={`text-[18px] tabular-nums ${t.duePaise ? 'text-amber' : ''}`}>{money(t.duePaise)}</b>{t.waitingOffPaise > 0 && <div className="text-xs text-muted">{money(t.waitingOffPaise)} of it is a discount awaiting approval</div>}</div>}
    {(t.advancePaise > 0 || !t.duePaise) && <Fig label="Advance" value={money(t.advancePaise)} tone={t.advancePaise ? 'text-sage' : ''} />}</> : null;
  const detail = (r: Act) => r.type === 'invoice' ? <><div className="font-semibold">{r.invoiceNo} · {r.items.join(', ')}</div><div className="text-xs text-muted">{[r.status === 'cancelled' ? 'Cancelled' : !r.amountPaise ? 'No charge' : r.paidPaise ? `${money(r.paidPaise)} paid` : 'nothing paid yet', r.fromAdvancePaise ? `${money(r.fromAdvancePaise)} of it from the advance` : '', r.creditedPaise ? `${money(r.creditedPaise)} refunded or removed` : '', r.waitingOffPaise ? `${money(r.waitingOffPaise)} discount awaiting approval` : ''].filter(Boolean).join(' · ')}</div></>
    : r.type === 'payment' ? <><div>{r.receiptNo ?? 'Payment'} · {r.modes.map((m: any) => `${MODE[m.method] ?? m.method}${m.reference ? ` ${m.reference}` : ''}`).join(' + ')}</div><div className="text-xs text-muted">{[r.invoices.length ? `Paid ${r.invoices.join(', ')}` : '', r.toAdvancePaise ? `${money(r.toAdvancePaise)} to the advance` : ''].filter(Boolean).join(' · ')}</div></>
    : r.type === 'refund' ? <><div>{r.receiptNo ?? 'Refund'} · {MODE[r.methods[0]] ?? r.methods[0]}{/^(.+?) · Refund:/.exec(String(r.note ?? ''))?.[1] ? ` ${/^(.+?) · Refund:/.exec(String(r.note))![1]}` : ''}{r.invoiceNo ? ` · on ${r.invoiceNo}` : ' · from the advance'}</div><div className="text-xs text-muted">{String(r.note ?? '').replace(/^.*Refund:?\s*(INV-\S+\s*·\s*)?/, '')}</div></>
    : r.type === 'discount' ? <><div>Discount of {money(r.amountPaise)} not given</div><div className="text-xs text-muted">{r.note}</div></>
    : <><div>{r.invoiceNo ? `Off ${r.invoiceNo}` : 'Off the bill'}</div><div className="text-xs text-muted">{plainReason(r.note)}</div></>;
  return (
    <section className="card-flat overflow-hidden anim-fade-up">
      <div className="flex flex-wrap items-center gap-x-7 gap-y-3 border-b border-line px-4 py-3.5">
        {t ? <><Fig label="Billed" value={money(t.billedPaise + t.creditedPaise)} />{t.creditedPaise > 0 && <Fig label="Refunded / removed" value={`−${money(t.creditedPaise)}`} />}<Fig label="Received" value={money(t.receivedPaise)} />{t.refundedPaise > 0 && <Fig label="Refunded" value={money(t.refundedPaise)} />}{balance}</> : <span className="text-sm text-muted">Loading…</span>}
        <span className="flex-1" />
        <span className="flex flex-wrap gap-2">
          {can(perms, 'payment.refund') && <button className="btn" aria-label="Refund" disabled={!t?.advancePaise || q.data?.dayClosed} title={q.data?.dayClosed ? 'Today has been closed' : t?.advancePaise ? undefined : 'Nothing in the advance'} onClick={() => setOpen('refund')}><Icon name="undo" className="h-4 w-4" />Refund</button>}
          {can(perms, 'payment.record') && <button className="btn" onClick={() => setOpen('payment')}><Icon name="wallet" className="h-4 w-4" />Record payment</button>}
          {can(perms, 'payment.record') && <button className="btn btn-primary" onClick={() => setOpen('invoice')}><Icon name="plus" className="h-4 w-4" />Generate invoice</button>}
        </span>
      </div>
      {!q.data ? null : !rows.length ? <Empty icon="rupee" title="Nothing billed yet" hint="Generate invoice bills a treatment once; Record payment takes money from the patient." /> : (
        <div className="overflow-x-auto"><table className="table min-w-[760px]">
          <thead><tr><th className="pl-4">Date</th><th>Type</th><th>Details</th><th className="text-right">Amount</th><th>Status</th><th className="pr-4" /></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.type + r.id} className={r.type === 'invoice' ? 'cursor-pointer hover:bg-surface-2/60' : ''} onClick={() => r.type === 'invoice' && setViewing(r.id)}>
            <td className="pl-4 whitespace-nowrap text-sm">{fmtDate(r.at)}</td>
            <td><Chip tone={TYPE[r.type][1] as any}>{TYPE[r.type][0]}</Chip></td>
            <td className="max-w-[420px] text-sm">{detail(r)}</td>
            <td className="text-right font-semibold tabular-nums">{r.type === 'invoice' && r.status === 'cancelled' ? <s className="font-normal text-muted">{money(r.issuedPaise)}</s> : r.type === 'discount' ? <s className="font-normal text-muted">{money(r.amountPaise)}</s> : <>{r.type === 'refund' || r.type === 'credit' ? '−' : ''}{money(r.amountPaise)}</>}</td>
            <td className="text-sm">{r.type === 'invoice' ? (r.status === 'waiting' ? <b className="text-amber">Discount awaiting approval</b> : r.duePaise ? <b className="text-amber">{money(r.duePaise)} due</b> : <span className="text-muted">{STATUS[r.status]?.[0] ?? r.status}</span>) : <span className="text-muted">{r.type === 'payment' && r.toAdvancePaise === r.amountPaise ? 'To the advance' : r.type === 'discount' ? 'Not given' : 'Done'}</span>}</td>
            <td className="pr-4" onClick={(e) => e.stopPropagation()}><span className="flex justify-end">{r.type === 'invoice' ? <MoreMenu items={[
              { label: 'View', onClick: () => setViewing(r.id) }, { label: 'Print', onClick: () => printInvoice(r.id) },
              { label: r.paidPaise > 0 ? 'Refund' : 'Remove item', hidden: !(can(perms, 'payment.refund') && r.status !== 'cancelled' && (r.amountPaise - r.creditedPaise > 0 || r.paidPaise > 0)), danger: true, onClick: () => get(`/bills/${r.id}`).then(setRefundingBill, (e) => toast(errText(e), 'err')) },
              { label: 'Cancel invoice', hidden: !(can(perms, 'payment.refund') && r.status === 'unpaid' && !r.creditedPaise), danger: true, onClick: () => cancelInvoice(r.id, r.invoiceNo) },
            ]} /> : r.type === 'credit' ? <button type="button" className="btn btn-ghost btn-sm !px-2" aria-label={`Print refund slip of ${fmtDate(r.at)}`} onClick={() => printCreditNote(r.id)}><Icon name="print" className="h-4 w-4" /></button> : r.receiptNo ? <button type="button" className="btn btn-ghost btn-sm !px-2" aria-label={`Print receipt ${r.receiptNo}`} onClick={() => printReceipt(r.receiptNo)}><Icon name="print" className="h-4 w-4" /></button> : null}</span></td>
          </tr>)}</tbody>
        </table></div>)}
      {viewing && <InvoiceView id={viewing} onClose={() => setViewing(null)} onCollect={(b) => { setViewing(null); setCollecting(b); }} onRefund={(b) => { setViewing(null); setRefundingBill(b); }} />}
      {refundingBill && <RefundBill bill={refundingBill} onClose={() => setRefundingBill(null)} />}
      {collecting && <TakePayment patientId={patientId} patientName={patientName} onlyBill={collecting.id} onClose={() => { setCollecting(null); refreshBills(); }} />}
      {open === 'invoice' && <TakePayment patientId={patientId} patientName={patientName} onClose={() => { setOpen(null); refreshBills(); }} />}
      {open === 'payment' && <RecordPayment patientId={patientId} patientName={patientName} dues={dues} dayClosed={q.data?.dayClosed} onClose={() => setOpen(null)} />}
      {open === 'refund' && t && <PatientRefund patientId={patientId} patientName={patientName} advancePaise={t.advancePaise} emiHeldPaise={t.emiHeldPaise} dayClosed={q.data?.dayClosed} onClose={() => setOpen(null)} />}
    </section>
  );
}

/** The clinic's billing list: every invoice in a period, searchable, with the same actions as on the patient. */
export function Billing() {
  const today = new Date().toLocaleDateString('en-CA');
  const monthStart = today.slice(0, 8) + '01';
  const [from, setFrom] = useState(today); const [to, setTo] = useState(today); const [term, setTerm] = useState(''); const [find, setFind] = useState('');
  useEffect(() => { const h = setTimeout(() => setFind(term.trim()), 300); return () => clearTimeout(h); }, [term]); // one request when typing stops
  const q = useQuery({ queryKey: ['bills', 'clinic', from, to, find], queryFn: () => get(`/bills?from=${from}&to=${to}${find ? `&q=${encodeURIComponent(find)}` : ''}`), placeholderData: (p: any) => p });
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
        <Section title={<>Invoices <span className="font-normal text-muted">· {d.count ?? d.bills.length}</span></>}>
          {d.count > d.bills.length && <div className="px-4 pb-2 text-xs text-amber">Showing the newest {d.bills.length} of {d.count}. The totals above are for all {d.count}; pick fewer dates or search to see the rest.</div>}
          <InvoiceTable bills={d.bills} showPatient onView={(b) => setViewing(b.id)} onCollect={setCollecting} onRefund={setRefunding} empty={find ? `No invoices match “${find}” in these dates.` : 'No invoices in these dates.'} />
        </Section>
      </>}
      {viewing && <InvoiceView id={viewing} onClose={() => setViewing(null)} onCollect={(b) => { setViewing(null); setCollecting(b); }} onRefund={(b) => { setViewing(null); setRefunding(b); }} />}
      {refunding && <RefundBill bill={refunding} onClose={() => setRefunding(null)} />}
      {collecting && <TakePayment patientId={collecting.patient.id} patientName={collecting.patient.fullName} onlyBill={collecting.id} onClose={() => { setCollecting(null); refreshBills(); }} />}
    </div>
  );
}
