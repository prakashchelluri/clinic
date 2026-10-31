import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useOutletContext } from 'react-router';
import { get, post, qc, errText } from './api';
import { can } from './App';
import { Chip, Icon, Modal, MoneyInput, Section, ask, money, toPaise, toast } from './ui';
import { printReceipt } from './invoices';
import type { Pkg } from './packages';

type Mode = 'upi' | 'cash' | 'card' | 'emi' | 'bank';
const MODES: [Mode, string][] = [['upi', 'UPI'], ['cash', 'Cash'], ['card', 'Card'], ['emi', 'EMI'], ['bank', 'Bank']];
const refresh = () => ['courses', 'timeline', 'frontdesk', 'daily', 'payments-awaiting', 'worklist'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
export const useCourses = (patientId: string) => useQuery({ queryKey: ['courses', patientId], queryFn: () => get(`/courses?patientId=${patientId}`) });

/** Where the course stands, in sittings first: how many are done, how many are already paid for, what is left to pay. */
function Standing({ c }: { c: any }) {
  return (
    <div className="space-y-1 text-sm">
      <div><b>{c.sittings} sittings at {money(c.perSittingPaise)}</b> = {money(c.totalPaise)}{c.listPaise > c.totalPaise ? <span className="text-muted"> (list {money(c.listPaise)})</span> : ''} {c.lockedAt ? <Chip tone="sage">price locked</Chip> : <Chip>not paid yet</Chip>}</div>
      <div>{c.doneSittings} of {c.sittings} done · <b>{c.unusedSittings}</b> paid ahead ({money(c.unusedPaise)}) · {money(c.stillToPayPaise)} still to pay, on each procedure day</div>
    </div>
  );
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
/** The quote the patient takes home: what, how many sittings, the price, how long it holds and what is not in it. */
export async function printQuote(id: string) {
  try {
    const r: any = await get(`/quotes/${id}/print`);
    const w = window.open('', '_blank', 'width=460,height=700'); if (!w) return toast('Allow pop-ups to print the quote', 'err');
    w.document.write(`<!doctype html><title>Quote ${esc(r.number)}</title><style>body{font:14px system-ui,sans-serif;margin:24px;color:#17191A}h1{font-size:18px;margin:0}table{width:100%;border-collapse:collapse;margin-top:12px}td{padding:6px 0;border-bottom:1px solid #ddd}.r{text-align:right}.s{color:#625F59;font-size:12px}</style>
      <h1>${esc(r.clinic.name)}</h1><div class="s">${esc(r.clinic.print?.address ?? '')} ${esc(r.clinic.print?.phone ?? '')}</div>
      <p><b>Quote ${esc(r.number)}</b><br><span class="s">For ${esc(r.patient.fullName)} · prepared by ${esc(r.preparedBy)}</span></p>
      <table><tr><td>${esc(r.procedure)}: ${esc(r.sittings)} sittings</td><td class="r">${esc(money(r.totalPaise))}</td></tr>${r.extras.map((x: any) => `<tr><td>${esc(x.name)}</td><td class="r">${esc(money(x.pricePaise))}</td></tr>`).join('')}
      <tr><td><b>Total</b></td><td class="r"><b>${esc(money(r.grandTotalPaise))}</b></td></tr></table>
      <p class="s">${esc(r.taxNote)}. Valid until ${esc(r.validUntil)}. Consultation and medicines are charged separately.</p><script>window.onload=function(){window.print()}<\/script>`);
    w.document.close();
  } catch (e) { toast(errText(e), 'err'); }
}

/** Agree the price, then pay for some sittings now if the patient wishes. Everything is one place for the desk. */
export function CourseDialog({ rec, patientId, patientName, onClose }: { rec: { id: string; procedureId: string; procedure?: string; sittings?: number }; patientId: string; patientName: string; onClose: () => void }) {
  const { cfg, perms } = useOutletContext<any>();
  const cs = useCourses(patientId); const c = (cs.data ?? []).find((x: any) => x.recommendationId === rec.id);
  const proc = cfg?.procedures?.find((p: any) => p.id === rec.procedureId);
  const sittings = rec.sittings ?? 1; const list = (proc?.pricePaise ?? 0) * sittings;
  const [price, setPrice] = useState(''); const [n, setN] = useState(1); const [mode, setMode] = useState<Mode>('upi'); const [ref, setRef] = useState(''); const [lender, setLender] = useState('');
  const [key] = useState(() => crypto.randomUUID());
  const [days, setDays] = useState(15);
  const pkgs: Pkg[] = ((cfg?.tenant?.settings?.packages ?? []) as Pkg[]).filter((k) => k.procedureId === rec.procedureId && k.sittings === sittings);
  const qs = useQuery({ queryKey: ['quotes', rec.id], queryFn: () => get(`/quotes?recommendationId=${rec.id}`) }); const quotes: any[] = qs.data ?? [];
  const makeQuote = useMutation({ mutationFn: (send: 'whatsapp' | 'print') => post('/quotes', { recommendationId: rec.id, validDays: days, send, ...(price !== '' && toPaise(price) !== list ? { totalPaise: toPaise(price) } : {}) }),
    onSuccess: (r: any, send) => { qc.invalidateQueries({ queryKey: ['quotes', rec.id] }); toast(send === 'whatsapp' ? `Quote ${r.number} is on its way` : `Quote ${r.number} ready`); if (send === 'print') printQuote(r.id); },
    onError: (e: any) => toast(e?.body?.code === 'NO_PHONE' ? 'This patient has no phone number for WhatsApp' : e?.body?.code === 'DISCOUNT_ABOVE_CAP_NEEDS_OWNER' ? `That is ${e.body.pct}% off. Above ${e.body.capPct}% only the owner can agree` : errText(e), 'err') });
  const agree = useMutation({ mutationFn: () => post('/courses', { recommendationId: rec.id, ...(price !== '' && toPaise(price) !== list ? { totalPaise: toPaise(price) } : {}) }), onSuccess: () => { refresh(); toast('Price agreed'); }, onError: (e: any) => toast(e?.body?.code === 'DISCOUNT_ABOVE_CAP_NEEDS_OWNER' ? `That is ${e.body.pct}% off. Above ${e.body.capPct}% only the owner can agree` : errText(e), 'err') });
  const per = c ? c.perSittingPaise : 0; const max = c ? Math.max(0, c.sittings - c.doneSittings - c.unusedSittings) : 0;
  const amount = Math.min(n * per, c?.stillToPayPaise ?? 0);
  const take = useMutation({ mutationFn: () => post(`/courses/${c.id}/advance`, { amountPaise: amount, method: mode, reference: ref.trim() || undefined, lender: lender.trim() || undefined, idempotencyKey: key }),
    onSuccess: (r: any) => { refresh(); toast(`Taken ${money(amount)}. Receipt ${r.receiptNo}`); printReceipt(r.receiptNo); onClose(); }, onError: (e) => toast(errText(e), 'err') });
  const refund = async () => {
    const a = await ask({ title: 'Refund unused sittings', body: `Up to ${money(c.unusedPaise)}. Only the owner approves this.`, confirmLabel: 'Next', field: { label: 'Rupees to give back', required: true, initial: String(c.unusedPaise / 100), maxLength: 9 } });
    const paise = toPaise((a?.value ?? '').replace(/[^\d.]/g, '')); if (!a?.value || paise <= 0) return;
    const why = await ask({ title: `Give back ${money(paise)}?`, confirmLabel: 'Refund', field: { label: 'Why', required: true, maxLength: 200 } }); if (!why?.value) return;
    try { await post(`/courses/${c.id}/refund`, { amountPaise: paise, method: 'cash', reason: why.value }); refresh(); toast('Refund recorded'); } catch (e) { toast(errText(e), 'err'); }
  };
  const emiBad = mode === 'emi' && (!ref.trim() || !lender.trim());
  return (
    <Modal title={rec.procedure ?? 'Procedure'} subtitle={`${patientName} · ${sittings} sittings planned`} onClose={onClose} width="max-w-lg">
      {!cs.data ? <div className="text-sm text-muted">Loading…</div> : !c ? (
        <div className="space-y-4">
          <div className="text-sm">List price: <b>{money(list)}</b> for {sittings} sittings ({money(proc?.pricePaise ?? 0)} each).</div>
          <div><label className="label" htmlFor="price">Price agreed for the whole course</label><MoneyInput id="price" value={price} placeholder={String(list / 100)} onChange={setPrice} />
            <div className="mt-1 text-xs text-muted">{can(perms, 'discount.give') ? 'Below the list price is a discount; above the clinic cap only the owner can agree.' : 'You do not give discounts; the price stays at the list price.'}</div></div>
          {pkgs.length > 0 && <div className="flex flex-wrap items-center gap-1.5 text-sm"><span className="text-muted">Package:</span>{pkgs.map((k) => <button key={k.id} type="button" className="toggle-opt !py-1" onClick={() => setPrice(String(k.pricePaise / 100))}>{k.name} · {money(k.pricePaise)}</button>)}</div>}
          <div className="rounded-xl border border-line p-3 space-y-2">
            <div className="flex flex-wrap items-center gap-2 text-sm"><b>Quote</b>{quotes[0] ? <Chip tone={quotes[0].state === 'open' ? 'sky' : quotes[0].state === 'expired' ? 'rose' : ''}>{quotes[0].number} · {quotes[0].state === 'expired' ? 'expired' : `valid to ${quotes[0].validUntil}`}{quotes[0].sentVia ? ` · ${quotes[0].sentVia}` : ''}</Chip> : <span className="text-muted">none sent yet</span>}</div>
            {quotes[0]?.state === 'expired' && <div className="text-xs text-rose">This quote has run out. Call the patient or make a new one.</div>}
            <div className="flex flex-wrap items-center gap-1.5 text-sm"><span className="text-muted">Valid for</span>{[7, 15, 30].map((n) => <button key={n} type="button" className={`toggle-opt !py-1 ${days === n ? 'on' : ''}`} onClick={() => setDays(n)}>{n} days</button>)}</div>
            <div className="flex flex-wrap gap-2"><button className="btn btn-sm" disabled={makeQuote.isPending} onClick={() => makeQuote.mutate('whatsapp')}>Send on WhatsApp</button><button className="btn btn-sm" disabled={makeQuote.isPending} onClick={() => makeQuote.mutate('print')}>Print</button></div>
            <div className="text-xs text-muted">The quote never shows consultation or pharmacy prices. When the patient agrees, the quoted price is used.</div>
          </div>
          <div className="modal-foot"><button className="btn btn-ghost" onClick={onClose}>Close</button><button className="btn btn-primary" disabled={agree.isPending || (price !== '' && toPaise(price) > list)} onClick={() => agree.mutate()}><Icon name="check" />Patient agrees</button></div>
        </div>
      ) : (
        <div className="space-y-4">
          <Standing c={c} />
          {max > 0 && can(perms, 'payment.record') && <div className="rounded-xl border border-line p-3 space-y-3">
            <div className="label !mb-0">Pay for sittings now</div>
            <div className="flex items-center gap-2 text-sm"><button type="button" className="btn btn-sm" aria-label="One sitting fewer" disabled={n <= 1} onClick={() => setN(n - 1)}>−</button><b>{n}</b><button type="button" className="btn btn-sm" aria-label="One sitting more" disabled={n >= max} onClick={() => setN(n + 1)}>+</button><span>sitting{n === 1 ? '' : 's'} = <b>{money(amount)}</b></span>{n < max && <button type="button" className="ml-auto underline text-muted" onClick={() => setN(max)}>all {max}</button>}</div>
            <div className="flex flex-wrap gap-1.5">{MODES.map(([m, l]) => <button key={m} type="button" className={`toggle-opt !py-1 ${mode === m ? 'on' : ''}`} onClick={() => setMode(m)}>{l}</button>)}</div>
            {mode !== 'cash' && <div className="grid grid-cols-2 gap-2"><div><label className="label">{mode === 'emi' ? 'Approval code' : 'Reference'}</label><input className="input" maxLength={60} value={ref} onChange={(e) => setRef(e.target.value)} /></div>{mode === 'emi' && <div><label className="label">Lender</label><input className="input" maxLength={60} value={lender} onChange={(e) => setLender(e.target.value)} /></div>}</div>}
            <div className="text-xs text-muted">The price is locked from this payment. Unused sittings stay on the course; a refund needs the owner.</div>
            <button className="btn btn-primary" disabled={take.isPending || emiBad || amount <= 0} onClick={() => take.mutate()}><Icon name="check" />Take {money(amount)}</button>
          </div>}
          <div className="modal-foot">{can(perms, 'refund.course') && c.unusedPaise > 0 && <button className="btn btn-sm mr-auto" onClick={refund}>Refund unused sittings</button>}<button className="btn btn-ghost" onClick={onClose}>Close</button></div>
        </div>
      )}
    </Modal>
  );
}

/** On the patient record: each agreed course and where it stands. */
export function CoursesCard({ patientId, patientName }: { patientId: string; patientName: string }) {
  const { cfg } = useOutletContext<any>(); const cs = useCourses(patientId); const [open, setOpen] = useState<any>(null);
  const courses: any[] = cs.data ?? [];
  if (!courses.length) return null;
  return (
    <Section title="Courses" delay={150}>
      {courses.map((c) => { const name = cfg?.procedures?.find((p: any) => p.id === c.procedureId)?.name;
        return <div key={c.id} className="row"><div className="min-w-0 flex-1"><div className="text-sm font-medium">{name ?? 'Procedure'}</div><div className="text-xs text-muted">{c.doneSittings} of {c.sittings} done · {c.unusedSittings} paid ahead · {money(c.stillToPayPaise)} still to pay</div></div>
          <button className="btn btn-sm" onClick={() => setOpen({ id: c.recommendationId, procedureId: c.procedureId, procedure: name, sittings: c.sittings })}>Open</button></div>; })}
      {open && <CourseDialog rec={open} patientId={patientId} patientName={patientName} onClose={() => setOpen(null)} />}
    </Section>
  );
}
