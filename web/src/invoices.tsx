import { post, get, qc, errText } from './api';
import { Chip, MoreMenu, Section, ask, fmtDate, money, toPaise, toast } from './ui';

const refresh = () => ['timeline', 'frontdesk', 'daily', 'patients'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const MODE: Record<string, string> = { cash: 'Cash', upi: 'UPI', card: 'Card', bank: 'Bank', emi: 'EMI' };

/** Opens the receipt for everything taken in one go in its own window and prints it. */
export async function printReceipt(no: string) {
  try {
    const r: any = await get(`/receipts/${encodeURIComponent(no)}`);
    const w = window.open('', '_blank', 'width=420,height=640'); if (!w) return toast('Allow pop-ups to print the receipt', 'err');
    const when = new Date(r.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    w.document.write(`<!doctype html><title>Receipt ${esc(r.receiptNo)}</title><style>body{font:14px system-ui,sans-serif;margin:24px;color:#17191A}h1{font-size:18px;margin:0}table{width:100%;border-collapse:collapse;margin-top:12px}td{padding:5px 0;border-bottom:1px solid #ddd}.r{text-align:right}.s{color:#625F59;font-size:12px}</style>
      <h1>${esc(r.clinic.name)}</h1><div class="s">${esc(r.clinic.print?.address ?? '')} ${esc(r.clinic.print?.phone ?? '')}</div>
      <p><b>Receipt ${esc(r.receiptNo)}</b><br><span class="s">${esc(when)} · ${esc(r.patient.fullName)} (${esc(r.patient.patientNo)})</span></p>
      <table>${r.lines.map((l: any) => `<tr><td>${esc(l.description)}<div class="s">${esc(MODE[l.method] ?? l.method)}${l.lender ? ' · ' + esc(l.lender) : ''}${l.reference ? ' · ' + esc(l.reference) : ''}</div></td><td class="r">${esc(money(l.amountPaise))}</td></tr>`).join('')}
      <tr><td><b>Total paid</b></td><td class="r"><b>${esc(money(r.totalPaise))}</b></td></tr></table>
      <p class="s">Received by ${esc(r.receivedBy)}. ${esc(r.clinic.print?.footer ?? '')}</p><script>window.onload=function(){window.print()}<\/script>`);
    w.document.close();
  } catch (e) { toast(errText(e), 'err'); }
}

/** Each invoice with what was paid on it and a menu for the rare things: discount, cancel, refund, leave out of tax reports. Every one asks why. */
export function Invoices({ charges, payments, canRefund, canDiscount }: { charges: any[]; payments: any[]; canRefund: boolean; canDiscount: boolean }) {
  if (!charges.length) return null;
  const run = async (path: string, body: object, done: string) => { try { await post(path, body); refresh(); toast(done); } catch (e) { toast(errText(e), 'err'); } };
  const why = (title: string, body?: string) => ask({ title, body, confirmLabel: 'Save', field: { label: 'Why', required: true, maxLength: 200 } });
  const cancel = async (c: any) => { const a = await why('Cancel this invoice?', 'It stays in the list, marked cancelled.'); if (a?.value) run(`/charges/${c.id}/cancel`, { reason: a.value }, 'Invoice cancelled'); };
  const refund = async (c: any) => { const a = await why(`Refund ${money(c.amountPaise)}?`, 'The invoice stays in the list, marked refunded.'); if (a?.value) run(`/charges/${c.id}/adjust`, { kind: 'refunded', reason: a.value }, 'Refund recorded'); };
  const exclude = async (c: any) => { const a = await why('Leave this out of the tax reports?', 'It is kept and marked. This cannot be undone.'); if (a?.value) run(`/charges/${c.id}/exclude`, { reason: a.value }, 'Left out of the tax reports'); };
  const discount = async (c: any) => {
    const amt = await ask({ title: 'Discount', body: `${c.description} · ${money(c.amountPaise)}`, confirmLabel: 'Next', field: { label: 'Rupees off', required: true, maxLength: 9 } });
    const paise = toPaise((amt?.value ?? '').replace(/[^\d.]/g, '')); if (!amt?.value || paise <= 0) return;
    const a = await why(`Take ${money(paise)} off?`); if (a?.value) run(`/charges/${c.id}/discount`, { amountPaise: paise, reason: a.value }, 'Discount given');
  };
  return (
    <Section title="Invoices" delay={200}>
      <table className="table"><tbody>{charges.map((c) => {
        const paid = payments.filter((p) => p.chargeId === c.id).reduce((s, p) => s + p.amountPaise, 0);
        const part = c.status === 'due' && paid > 0; const tone = c.status === 'paid' ? 'sage' : c.status === 'due' ? (part ? 'amber' : 'rose') : '';
        const label = part ? 'Part paid' : c.status === 'due' ? 'Unpaid' : c.status === 'paid' ? 'Paid' : c.status[0].toUpperCase() + c.status.slice(1);
        const rno = payments.find((p) => p.chargeId === c.id && p.receiptNo)?.receiptNo;
        return <tr key={c.id}><td className="pl-4">{c.description}<div className="text-xs text-muted">{fmtDate(c.createdAt)}{c.discountPaise ? ` · ${money(c.discountPaise)} off (${c.discountReason})` : ''}{part ? ` · ${money(paid)} paid, ${money(c.amountPaise - paid)} due` : ''}{c.adjustmentReason ? ` · ${c.adjustmentReason}` : ''}</div></td>
          <td><Chip tone={tone}>{label}</Chip>{c.excludedAt && <span title={c.excludedReason}> <Chip>Not in tax reports</Chip></span>}</td>
          <td className="text-right">{money(c.amountPaise)}</td>
          <td className="pr-3 text-right"><MoreMenu items={[
            { label: 'Print receipt', hidden: !rno, onClick: () => printReceipt(rno) },
            { label: 'Give a discount', hidden: !(canDiscount && c.status === 'due' && paid === 0), onClick: () => discount(c) },
            { label: 'Cancel invoice', hidden: !(canRefund && c.status === 'due' && paid === 0), danger: true, onClick: () => cancel(c) },
            { label: 'Refund', hidden: !(canRefund && c.status === 'paid'), danger: true, onClick: () => refund(c) },
            { label: 'Leave out of tax reports', hidden: !(canRefund && !c.excludedAt), onClick: () => exclude(c) },
          ]} /></td></tr>;
      })}</tbody></table>
    </Section>
  );
}
