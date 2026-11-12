import { post, get, qc, errText } from './api';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Chip, Modal, MoneyInput, MoreMenu, Section, Stat, ask, fmtDate, money, toast } from './ui';

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

const refresh = () => ['timeline', 'frontdesk', 'daily', 'patients'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const MODE: Record<string, string> = { cash: 'Cash', upi: 'UPI', card: 'Card', bank: 'Bank', emi: 'EMI' };

/** Opens the receipt for everything taken in one go in its own window and prints it. With a GSTIN it is a Tax Invoice with CGST/SGST per rate; without one, a Bill of Supply with no tax lines. */
export async function printReceipt(no: string) {
  try {
    const r: any = await get(`/receipts/${encodeURIComponent(no)}`);
    const w = window.open('', '_blank', 'width=420,height=640'); if (!w) return toast('Allow pop-ups to print the receipt', 'err');
    const when = new Date(r.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    const tax = r.tax ?? { gstin: null, title: 'Bill of Supply', rates: [] }; const pct = (bp: number) => (bp ? `${bp / 100}%` : 'Exempt');
    const taxTable = tax.gstin ? `<table><tr><td class="s">GST rate</td><td class="s r">Taxable value</td><td class="s r">CGST</td><td class="s r">SGST</td></tr>${tax.rates.map((x: any) => `<tr><td>${pct(x.rateBp)}</td><td class="r">${esc(money(x.taxablePaise))}</td><td class="r">${esc(money(x.cgstPaise))}</td><td class="r">${esc(money(x.sgstPaise))}</td></tr>`).join('')}</table>` : '';
    w.document.write(`<!doctype html><title>${esc(tax.title)} ${esc(r.receiptNo)}</title><style>body{font:14px system-ui,sans-serif;margin:24px;color:#17191A}h1{font-size:18px;margin:0}table{width:100%;border-collapse:collapse;margin-top:12px}td{padding:5px 0;border-bottom:1px solid #ddd}.r{text-align:right}.s{color:#625F59;font-size:12px}</style>
      <h1>${esc(r.clinic.name)}</h1><div class="s">${esc(r.clinic.print?.address ?? '')} ${esc(r.clinic.print?.phone ?? '')}${tax.gstin ? ' · GSTIN ' + esc(tax.gstin) : ''}</div>
      <p><b>${esc(tax.title)} · Receipt ${esc(r.receiptNo)}</b><br><span class="s">${esc(when)} · ${esc(r.patient.fullName)} (${esc(r.patient.patientNo)})</span></p>
      <table>${r.lines.map((l: any) => `<tr><td>${esc(l.description)}<div class="s">${tax.gstin ? 'GST ' + pct(l.taxRateBp ?? 0) + ' · ' : ''}${esc(MODE[l.method] ?? l.method)}${l.lender ? ' · ' + esc(l.lender) : ''}${l.reference ? ' · ' + esc(l.reference) : ''}</div></td><td class="r">${esc(money(l.amountPaise))}</td></tr>`).join('')}
      <tr><td><b>Total paid</b></td><td class="r"><b>${esc(money(r.totalPaise))}</b></td></tr></table>${taxTable}
      <p class="s">${tax.gstin ? 'Prices include GST.' : 'Not registered for GST, so no tax is charged on this bill.'} Received by ${esc(r.receivedBy)}. ${esc(r.clinic.print?.footer ?? '')}</p><script>window.onload=function(){window.print()}<\/script>`);
    w.document.close();
  } catch (e) { toast(errText(e), 'err'); }
}

/** The patient's money at a glance, above the invoices: billed, paid, due, paid ahead on courses, and discounts waiting for approval. */
export function BillTotals({ patientId, charges, payments, duePaise, canRefund }: { patientId: string; charges: any[]; payments: any[]; duePaise: number; canRefund: boolean }) {
  const adv = useQuery({ queryKey: ['advance', patientId], queryFn: () => get(`/patients/${patientId}/advance`) }); const advT: number = adv.data?.balancePaise ?? 0;
  const [giving, setGiving] = useState(false);
  const cs = useQuery({ queryKey: ['courses', patientId], queryFn: () => get(`/courses?patientId=${patientId}`) });
  const asks = useQuery({ queryKey: ['discount-asks', patientId], queryFn: () => get(`/discount-asks?patientId=${patientId}`) });
  const live = charges.filter((c) => !['cancelled', 'waived'].includes(c.status));
  const billed = live.reduce((s, c) => s + c.amountPaise, 0); const off = live.reduce((s, c) => s + c.discountPaise, 0);
  const money_ = payments.filter((p) => p.method !== 'advance'); // paid from the advance moves no money: it was counted when the advance came in
  const paid = money_.filter((p) => p.amountPaise > 0).reduce((s, p) => s + p.amountPaise, 0); const back = -money_.filter((p) => p.amountPaise < 0).reduce((s, p) => s + p.amountPaise, 0);
  const ahead = (cs.data ?? []).reduce((s: number, c: any) => s + c.unusedPaise, 0); const aheadN = (cs.data ?? []).reduce((s: number, c: any) => s + c.unusedSittings, 0);
  const wait = (asks.data ?? []).filter((a: any) => a.status === 'pending'); const waitT = wait.reduce((s: number, a: any) => s + a.offPaise, 0);
  return (
    <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
      <Stat label="Billed" value={money(billed)} sub={`${live.length} invoice${live.length === 1 ? '' : 's'}${off ? ` · ${money(off)} discount` : ''}`} />
      <Stat label="Paid" value={money(paid)} tone="sage" sub={back ? `${money(back)} given back` : 'every mode'} />
      <Stat label="Due" value={money(duePaise)} tone={duePaise ? 'clay' : ''} sub={duePaise ? 'Add bill / payment to collect' : 'nothing owed'} />
      <Stat label="Advance" value={money(advT + ahead)} sub={<>{advT ? `${money(advT)} to use` : 'nothing to use'}{ahead ? ` · ${money(ahead)} on ${aheadN} sitting${aheadN === 1 ? '' : 's'}` : ''}{canRefund && advT > 0 && <> · <button className="underline" onClick={() => setGiving(true)}>Give back</button></>}</>} />
      <Stat label="Discount waiting" value={money(waitT)} sub={wait.length ? wait.map((a: any) => a.reason).join(', ') : 'nothing with the owner'} />
      {giving && <GiveBackAdvance patientId={patientId} balancePaise={advT} onClose={() => setGiving(false)} />}
    </div>
  );
}

/** The rest of the advance goes back to the patient: how much, how, and why. Money out today. */
function GiveBackAdvance({ patientId, balancePaise, onClose }: { patientId: string; balancePaise: number; onClose: () => void }) {
  const [amount, setAmount] = useState(String(balancePaise / 100)); const [mode, setMode] = useState<'cash' | 'upi' | 'card' | 'bank'>('cash'); const [why, setWhy] = useState(''); const [busy, setBusy] = useState(false);
  const paise = Math.round(Number(amount || 0) * 100);
  const bad = paise <= 0 ? 'Type the amount' : paise > balancePaise ? `Only ${money(balancePaise)} is in the advance` : why.trim().length < 3 ? 'Say why' : '';
  const go = async () => { setBusy(true); try { await post(`/patients/${patientId}/advance/refund`, { amountPaise: paise, method: mode, reason: why.trim() }); ['advance', 'timeline', 'daily'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); toast(`Gave back ${money(paise)}`); onClose(); } catch (e: any) { toast(e?.body?.code === 'DAY_CLOSED' ? 'Today has been closed: no money can be given back today.' : errText(e), 'err'); } finally { setBusy(false); } };
  return (
    <Modal title="Give back the advance" subtitle={`${money(balancePaise)} in the advance`} onClose={onClose} width="max-w-md">
      <div className="space-y-3">
        <div><label className="label" htmlFor="adv-amt">Amount</label><MoneyInput id="adv-amt" value={amount} onChange={setAmount} /></div>
        <div><span className="label">Given back by</span><div className="flex flex-wrap gap-1.5">{(['cash', 'upi', 'card', 'bank'] as const).map((m) => <button key={m} type="button" aria-pressed={mode === m} className={`toggle-opt !py-1 ${mode === m ? 'on' : ''}`} onClick={() => setMode(m)}>{m === 'upi' ? 'UPI' : m[0].toUpperCase() + m.slice(1)}</button>)}</div></div>
        <div><label className="label" htmlFor="adv-why">Why</label><input id="adv-why" className="input" maxLength={200} value={why} onChange={(e) => setWhy(e.target.value)} /></div>
        <div className="modal-foot"><span className="mr-auto text-xs text-muted">{bad}</span><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!!bad || busy} onClick={go}>Give back {money(paise)}</button></div>
      </div>
    </Modal>
  );
}

/** Each invoice with what was paid on it and a menu for the rare things: cancel, refund, leave out of tax reports. Every one asks why. Discounts are given on the bill. */
export function Invoices({ charges, payments, canRefund }: { charges: any[]; payments: any[]; canRefund: boolean }) {
  const [refunding, setRefunding] = useState<null | { c: any; paid: number }>(null);
  if (!charges.length) return null;
  const run = async (path: string, body: object, done: string) => { try { await post(path, body); refresh(); toast(done); } catch (e: any) { toast(e?.body?.code === 'DAY_CLOSED' ? 'Today has been closed: no money can be given back today.' : errText(e), 'err'); } };
  // every reason is at least 3 letters (the server asks the same)
  const why = async (title: string, body?: string, confirmLabel = 'Save') => { const a = await ask({ title, body, confirmLabel, field: { label: 'Why', placeholder: 'At least 3 letters', required: true, maxLength: 200 } }); if (a && a.value.trim().length < 3) { toast('Say why in at least 3 letters', 'err'); return null; } return a; };
  const cancel = async (c: any) => { const a = await why('Cancel this invoice?', 'It stays in the list, marked cancelled.', 'Cancel invoice'); if (a?.value) run(`/charges/${c.id}/cancel`, { reason: a.value }, 'Invoice cancelled'); };
  const refund = (c: any) => setRefunding({ c, paid: payments.filter((p) => p.chargeId === c.id).reduce((s, p) => s + p.amountPaise, 0) });
  const exclude = async (c: any) => { const a = await why('Leave this out of the tax reports?', 'It is kept and marked. This cannot be undone.'); if (a?.value) run(`/charges/${c.id}/exclude`, { reason: a.value }, 'Left out of the tax reports'); };
  return (
    <Section title="Invoices" delay={200}>
      <table className="table"><tbody>{charges.map((c) => {
        const paid = payments.filter((p) => p.chargeId === c.id).reduce((s, p) => s + p.amountPaise, 0);
        const part = c.status === 'due' && paid > 0; const tone = c.status === 'paid' ? 'sage' : c.status === 'due' ? (part ? 'amber' : 'rose') : '';
        const label = part ? 'Part paid' : c.status === 'due' ? 'Unpaid' : c.status === 'paid' ? 'Paid' : c.status[0].toUpperCase() + c.status.slice(1);
        const rno = payments.find((p) => p.chargeId === c.id && p.receiptNo)?.receiptNo;
        return <tr key={c.id}><td className="pl-4">{c.description}<div className="text-xs text-muted">{fmtDate(c.createdAt)}{rno ? ` · ${rno}` : ''}{c.discountPaise ? ` · ${money(c.discountPaise)} off (${c.discountReason})` : ''}{part ? ` · ${money(paid)} paid, ${money(c.amountPaise - paid)} due` : ''}{c.adjustmentReason ? ` · ${c.adjustmentReason}` : ''}</div></td>
          <td><Chip tone={tone}>{label}</Chip>{c.excludedAt && <span title={c.excludedReason}> <Chip>Not in tax reports</Chip></span>}</td>
          <td className="text-right">{money(c.amountPaise)}</td>
          <td className="pr-3 text-right"><MoreMenu items={[
            { label: 'Print receipt', hidden: !rno, onClick: () => printReceipt(rno) },
            { label: 'Cancel invoice', hidden: !(canRefund && c.status === 'due' && paid === 0), danger: true, onClick: () => cancel(c) },
            { label: 'Refund', hidden: !(canRefund && c.status === 'paid'), danger: true, onClick: () => refund(c) },
            { label: 'Leave out of tax reports', hidden: !(canRefund && !c.excludedAt), onClick: () => exclude(c) },
          ]} /></td></tr>;
      })}</tbody></table>
      {refunding && <RefundDialog title={`Refund ${money(refunding.paid)}?`} body="The money must be handed back, the same way it was paid. The invoice stays in the list, marked refunded." confirmLabel={`Refund ${money(refunding.paid)}`}
        onClose={(reason) => { const r = refunding; setRefunding(null); if (reason) run(`/charges/${r.c.id}/adjust`, { kind: 'refunded', reason }, `Refunded ${money(r.paid)}`); }} />}
    </Section>
  );
}
