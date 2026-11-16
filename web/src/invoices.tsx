import { get, errText } from './api';
import { useState } from 'react';
import { Modal, money, toast } from './ui';

/** Why money is given back: picked, not typed, so the owner can count the reasons. "Other" asks for a few words. */
export const REFUND_REASONS = ['Left without consultation', 'Patient changed mind', 'Charged twice', 'Wrong amount', 'Service not given'] as const;
export function RefundDialog({ title, body, confirmLabel, onClose }: { title: string; body?: string; confirmLabel: string; onClose: (reason: string | null) => void }) {
  const [pick, setPick] = useState(''); const [other, setOther] = useState('');
  const reason = pick === 'Other' ? (other.trim().length >= 3 ? `Other: ${other.trim()}` : '') : pick;
  return (
    <Modal title={title} subtitle={body} onClose={() => onClose(null)} width="max-w-md">
      <div className="space-y-3">
        <div><span className="label">Why</span><div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Why">{[...REFUND_REASONS, 'Other'].map((r) => <button key={r} type="button" role="radio" aria-checked={pick === r} className={`toggle-opt ${pick === r ? 'on' : ''}`} onClick={() => setPick(r)}>{r}</button>)}</div></div>
        {pick === 'Other' && <div><label className="label" htmlFor="rf-other">Say why</label><input id="rf-other" className="input" autoFocus maxLength={180} placeholder="At least 3 letters" value={other} onChange={(e) => setOther(e.target.value)} /></div>}
        <div className="modal-foot"><button className="btn btn-ghost" onClick={() => onClose(null)}>Cancel</button><button className="btn !bg-rose-soft !text-rose" disabled={!reason} onClick={() => onClose(reason)}>{confirmLabel}</button></div>
      </div>
    </Modal>
  );
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const MODE: Record<string, string> = { cash: 'Cash', upi: 'UPI', card: 'Card', bank: 'Bank', emi: 'EMI' };

/** Opens the receipt for everything taken in one go (or the voucher for money given back) in its own window and prints it. Tax is on the invoice, not here. */
export async function printReceipt(no: string) {
  try {
    const r: any = await get(`/receipts/${encodeURIComponent(no)}`);
    const w = window.open('', '_blank', 'width=420,height=640'); if (!w) return toast('Allow pop-ups to print the receipt', 'err');
    const when = new Date(r.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    const title = r.voucher ? 'Refund voucher' : 'Receipt'; const sign = r.voucher ? -1 : 1;
    w.document.write(`<!doctype html><title>${title} ${esc(r.receiptNo)}</title><style>body{font:14px system-ui,sans-serif;margin:24px;color:#17191A}h1{font-size:18px;margin:0}table{width:100%;border-collapse:collapse;margin-top:12px}td{padding:5px 0;border-bottom:1px solid #ddd}.r{text-align:right}.s{color:#625F59;font-size:12px}</style>
      ${r.clinic.print?.logoUrl ? `<img src="${esc(r.clinic.print?.logoUrl)}" alt="" style="display:block;height:44px;max-width:150px;object-fit:contain;margin-bottom:6px">` : ''}<h1>${esc(r.clinic.name)}</h1><div class="s">${esc(r.clinic.print?.address ?? '')} ${esc(r.clinic.print?.phone ?? '')}</div>
      <p><b>${title} ${esc(r.receiptNo)}</b><br><span class="s">${esc(when)} · ${esc(r.patient.fullName)} (${esc(r.patient.patientNo)})</span></p>
      <table>${r.lines.map((l: any) => `<tr><td>${esc(l.description)}<div class="s">${esc(MODE[l.method] ?? l.method)}${l.lender ? ' · ' + esc(l.lender) : ''}${l.reference ? ' · ' + esc(l.reference) : ''}</div></td><td class="r">${esc(money(sign * l.amountPaise))}</td></tr>`).join('')}
      <tr><td><b>${r.voucher ? 'Total given back' : 'Total paid'}</b></td><td class="r"><b>${esc(money(sign * r.totalPaise))}</b></td></tr></table>
      <p class="s">${r.voucher ? 'Given back' : 'Received'} by ${esc(r.receivedBy)}. ${esc(r.clinic.print?.footer ?? '')}</p><script>window.onload=function(){window.print()}<\/script>`);
    w.document.close();
  } catch (e) { toast(errText(e), 'err'); }
}
