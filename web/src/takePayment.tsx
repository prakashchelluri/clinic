import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { get, post, qc, errText } from './api';
import { Chip, Icon, Modal, MoneyInput, Section, money, toPaise, toast, fmtDate } from './ui';

type Part = { method: 'cash' | 'upi' | 'card' | 'bank' | 'emi'; amount: string; reference: string; lender: string };
const MODES: [Part['method'], string][] = [['upi', 'UPI'], ['cash', 'Cash'], ['card', 'Card'], ['emi', 'EMI'], ['bank', 'Bank']];
const refresh = () => ['timeline', 'frontdesk', 'daily', 'payments-awaiting', 'patients'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));

/** One payment can settle several invoices and use several modes. The amount defaults to everything due; EMI also needs the lender and approval code. */
export function TakePayment({ patientId, patientName, charges, payments, onClose }: { patientId: string; patientName: string; charges: any[]; payments: any[]; onClose: () => void }) {
  const owing = (c: any) => c.amountPaise - payments.filter((p) => p.chargeId === c.id).reduce((s, p) => s + p.amountPaise, 0);
  const due = charges.filter((c) => c.status === 'due' && owing(c) > 0);
  const [picked, setPicked] = useState<string[]>(due.map((c) => c.id));
  const owed = due.filter((c) => picked.includes(c.id)).reduce((s, c) => s + owing(c), 0);
  const [parts, setParts] = useState<Part[]>([{ method: 'upi', amount: '', reference: '', lender: '' }]);
  const [key] = useState(() => crypto.randomUUID());
  const amt = (p: Part, i: number) => (p.amount === '' && parts.length === 1 && i === 0 ? owed : toPaise(p.amount));
  const total = parts.reduce((s, p, i) => s + amt(p, i), 0);
  const set = (i: number, patch: Partial<Part>) => setParts(parts.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const problem = !picked.length ? 'Tick at least one invoice' : total <= 0 ? 'Enter the amount' : total > owed ? `That is ${money(total - owed)} more than is due` : parts.some((p, i) => p.method === 'emi' && amt(p, i) > 0 && (!p.lender.trim() || !p.reference.trim())) ? 'EMI needs the lender and the approval code' : '';
  const go = useMutation({
    mutationFn: () => post('/payments/take', { patientId, chargeIds: picked, idempotencyKey: key, parts: parts.map((p, i) => ({ method: p.method, amountPaise: amt(p, i), reference: p.reference.trim() || undefined, lender: p.lender.trim() || undefined })).filter((p) => p.amountPaise > 0) }),
    onSuccess: (r: any) => { refresh(); toast(r.balancePaise ? `Taken ${money(total)}. ${money(r.balancePaise)} still due` : `Taken ${money(total)}. Nothing due`); onClose(); },
    onError: (e) => toast(errText(e), 'err'),
  });
  return (
    <Modal title="Take payment" subtitle={`${patientName} · ${money(owed)} due`} onClose={onClose} width="max-w-xl">
      <div className="space-y-4">
        <div><div className="label">Settle which invoices</div>
          {due.map((c) => <label key={c.id} className="flex items-center gap-2 py-1.5 text-sm"><input type="checkbox" className="accent-clay" checked={picked.includes(c.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, c.id] : picked.filter((x) => x !== c.id))} /><span className="flex-1">{c.description}</span><span className="font-medium">{money(owing(c))}</span></label>)}</div>
        <div><div className="label">How</div>
          <div className="space-y-2">{parts.map((p, i) => (
            <div key={i} className="rounded-xl border border-line p-2.5 space-y-2">
              <div className="flex flex-wrap items-center gap-1.5">{MODES.map(([m, l]) => <button key={m} type="button" className={`toggle-opt !py-1 ${p.method === m ? 'on' : ''}`} onClick={() => set(i, { method: m })}>{l}</button>)}
                <span className="ml-auto" />{parts.length > 1 && <button type="button" className="btn btn-ghost btn-sm" aria-label="Remove this mode" onClick={() => setParts(parts.filter((_, j) => j !== i))}><Icon name="x" className="h-3.5 w-3.5" /></button>}</div>
              <div className="grid grid-cols-2 gap-2"><div><label className="label">Amount</label><MoneyInput value={p.amount} placeholder={i === 0 && parts.length === 1 ? String(owed / 100) : '0'} onChange={(v) => set(i, { amount: v })} /></div>
                {p.method !== 'cash' && <div><label className="label">{p.method === 'emi' ? 'Approval code' : p.method === 'upi' ? 'Ref, last 4 digits' : 'Reference'}</label><input className="input" maxLength={60} value={p.reference} onChange={(e) => set(i, { reference: e.target.value })} /></div>}
                {p.method === 'emi' && <div className="col-span-2"><label className="label">Lender</label><input className="input" maxLength={60} placeholder="for example Bajaj Finserv" value={p.lender} onChange={(e) => set(i, { lender: e.target.value })} /></div>}</div>
              {p.method === 'emi' && <div className="text-xs text-muted">Counted as paid when the lender approves. It shows as awaiting settlement until the money reaches the bank.</div>}
            </div>))}
            {parts.length < 4 && <button type="button" className="btn btn-sm" onClick={() => setParts([...parts, { method: 'cash', amount: '', reference: '', lender: '' }])}><Icon name="plus" className="h-3.5 w-3.5" />Split across another mode</button>}</div></div>
        <div className="flex items-center gap-2 text-sm"><span className="text-muted">{problem || (total === owed ? 'The modes add up to the amount due' : `${money(owed - total)} will stay due`)}</span></div>
        <div className="modal-foot"><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!!problem || go.isPending} onClick={() => go.mutate()}><Icon name="check" />Take {money(total)}</button></div>
      </div>
    </Modal>
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
