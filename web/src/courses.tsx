import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useOutletContext } from 'react-router';
import { get, post, qc, errText, NO_WHATSAPP } from './api';
import { can } from './App';
import { Drawer, Chip, Icon, MoneyInput, Section, money, toPaise, toast } from './ui';
import { TakePayment } from './takePayment';
import { ScheduleModal } from './pages/Worklist';
import type { Pkg } from './packages';

const REFUND_MODES: ['cash' | 'upi' | 'card' | 'bank', string][] = [['cash', 'Cash'], ['upi', 'UPI'], ['card', 'Card'], ['bank', 'Bank']];
const refresh = () => ['courses', 'timeline', 'frontdesk', 'daily', 'payments-awaiting', 'worklist'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
export const useCourses = (patientId: string) => useQuery({ queryKey: ['courses', patientId], queryFn: () => get(`/courses?patientId=${patientId}`) });

/** Where the course stands, in sittings first: how many are done, how many are already paid for, what is left to pay. */
function Standing({ c }: { c: any }) {
  return (
    <div className="space-y-1 text-sm">
      <div><b>{c.sittings} sittings at {money(c.perSittingPaise)}</b> = {money(c.totalPaise)}{c.listPaise > c.totalPaise ? <span className="text-muted"> (list {money(c.listPaise)})</span> : ''} {c.lockedAt ? <Chip tone="sage">Price fixed</Chip> : <Chip>not paid yet</Chip>}</div>
      <div className="text-muted">Agreed by the patient on {new Date(c.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}{c.agreedBy ? ` · recorded by ${c.agreedBy}` : ''}{c.priceSource === 'doctor' ? ` · doctor's price${c.priceBy ? ` (${c.priceBy})` : ''}${c.standardPaise ? `, standard ${money(c.standardPaise)}` : ''}` : c.priceSource === 'package' ? ' · package price' : ''}</div>
      <div>{c.doneSittings} of {c.sittings} done · Prepaid <b>{c.unusedSittings}</b> sitting{c.unusedSittings === 1 ? '' : 's'} ({money(c.unusedPaise)}) · {money(c.stillToPayPaise)} to pay over next visits</div>
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

/** A procedure plan's money in one place for the desk: the fixed price (list or a clinic package), the quote, booking, and paying sittings ahead.
 *  Nobody types a price here: a reduction is a discount on the bill, where above the clinic limit it waits for approval. */
export function CourseDialog({ rec, patientId, patientName, onClose }: { rec: { id: string; procedureId: string; procedure?: string; sittings?: number; amountPaise?: number | null; patient?: any }; patientId: string; patientName: string; onClose: () => void }) {
  const [booking, setBooking] = useState(false); const [paying, setPaying] = useState(false);
  const { cfg, perms } = useOutletContext<any>();
  const cs = useCourses(patientId); const c = (cs.data ?? []).find((x: any) => x.recommendationId === rec.id);
  const proc = cfg?.procedures?.find((p: any) => p.id === rec.procedureId);
  const sittings = rec.sittings ?? 1; const custom = rec.amountPaise && rec.amountPaise > 0 ? rec.amountPaise : 0; // the doctor's own price, for all sittings
  const list = custom || (proc?.pricePaise ?? 0) * sittings;
  const [pkg, setPkg] = useState(''); const [days, setDays] = useState(15);
  const pkgs: Pkg[] = custom ? [] : ((cfg?.tenant?.settings?.packages ?? []) as Pkg[]).filter((k) => k.procedureId === rec.procedureId && k.pricePaise > 0);
  const qs = useQuery({ queryKey: ['quotes', rec.id], queryFn: () => get(`/quotes?recommendationId=${rec.id}`) }); const quotes: any[] = qs.data ?? [];
  // the patient agrees the price (reception records it): this fixes the course at that price, before the first sitting is booked
  const agree = useMutation({ mutationFn: () => post('/courses', { recommendationId: rec.id, ...(pkg ? { packageId: pkg } : {}) }), onSuccess: () => { refresh(); toast(`Recorded: the patient agreed ${money(pkg ? pkgs.find((k) => k.id === pkg)?.pricePaise ?? list : list)}. Book the first sitting.`); }, onError: (e) => toast(errText(e), 'err') });
  const makeQuote = useMutation({ mutationFn: (send: 'whatsapp' | 'print') => post('/quotes', { recommendationId: rec.id, validDays: days, send, ...(pkg ? { packageId: pkg } : {}) }),
    onSuccess: (r: any, send) => { qc.invalidateQueries({ queryKey: ['quotes', rec.id] }); if (r.whatsapp === 'opted_out') { toast(`Quote ${r.number} saved. ${NO_WHATSAPP}`, 'info', { label: 'Print', run: () => printQuote(r.id) }); return; }
      toast(send === 'whatsapp' ? `Quote ${r.number} is on its way` : `Quote ${r.number} ready`); if (send === 'print') printQuote(r.id); },
    onError: (e: any) => toast(e?.body?.code === 'NO_PHONE' ? 'This patient has no phone number for WhatsApp' : errText(e), 'err') });
  // refund: how much, how it goes back (the way the patient paid, so the cash drawer still adds up) and why
  const [rf, setRf] = useState<{ amount: string; mode: 'cash' | 'upi' | 'card' | 'bank'; why: string } | null>(null);
  const rfPaise = rf ? toPaise(rf.amount) : 0;
  const refund = useMutation({ mutationFn: () => post(`/courses/${c.id}/refund`, { amountPaise: rfPaise, method: rf!.mode, reason: rf!.why.trim() }),
    onSuccess: () => { refresh(); toast(`Refund of ${money(rfPaise)} recorded · ${REFUND_MODES.find(([m]) => m === rf!.mode)?.[1]}`); setRf(null); }, onError: (e) => toast(errText(e), 'err') });
  const ledger: any[] = c?.ledger ?? []; const booked = ledger.find((l: any) => l.state && !['done', 'planned'].includes(l.state));
  const canPay = can(perms, 'payment.record'); const leftToPay = c ? c.stillToPayPaise > 0 && c.sittings - c.doneSittings - c.unusedSittings > 0 : true;
  if (booking) return <ScheduleModal rec={{ ...rec, patient: rec.patient ?? { id: patientId, fullName: patientName } }} onClose={() => { setBooking(false); refresh(); }} />;
  if (paying) return <TakePayment patientId={patientId} patientName={patientName} ahead={{ recommendationId: rec.id }} onClose={() => { setPaying(false); refresh(); }} />;
  return (
    <Drawer title={rec.procedure ?? 'Procedure'} subtitle={`${patientName} · ${c?.sittings ?? sittings} sittings planned`} onClose={onClose} width="max-w-lg">
      {!cs.data ? <div className="text-sm text-muted">Loading…</div> : !c ? (
        <div className="space-y-4">
          <div className="text-sm">Price: <b>{money(list)}</b> for {sittings} sittings{custom ? <>, <b>set by the doctor</b>.</> : ` (${money(proc?.pricePaise ?? 0)} each), the standard price.`} <span className="text-muted">A lower price is a discount on the bill; above the clinic's limit it needs approval.</span></div>
          {pkgs.length > 0 && <div className="flex flex-wrap items-center gap-1.5 text-sm"><span className="text-muted">Or a package:</span>
            <button type="button" className={`toggle-opt !py-1 ${pkg === '' ? 'on' : ''}`} aria-pressed={pkg === ''} onClick={() => setPkg('')}>List price</button>
            {pkgs.map((k) => <button key={k.id} type="button" className={`toggle-opt !py-1 ${pkg === k.id ? 'on' : ''}`} aria-pressed={pkg === k.id} onClick={() => setPkg(k.id)}>{k.name} · {k.sittings} sittings · {money(k.pricePaise)}</button>)}</div>}
          <div className="rounded-xl border border-line p-3 space-y-2">
            <div className="flex flex-wrap items-center gap-2 text-sm"><b>Quote</b>{quotes[0] ? <Chip tone={quotes[0].state === 'open' ? 'sky' : quotes[0].state === 'expired' ? 'rose' : ''}>{quotes[0].number} · {money(quotes[0].totalPaise)} · {quotes[0].state === 'expired' ? 'expired' : `valid to ${quotes[0].validUntil}`}{quotes[0].sentVia ? ` · ${quotes[0].sentVia}` : ''}</Chip> : <span className="text-muted">none sent yet</span>}</div>
            {quotes[0]?.state === 'expired' && <div className="text-xs text-rose">This quote has run out. Call the patient or make a new one.</div>}
            <div className="flex flex-wrap items-center gap-1.5 text-sm"><span className="text-muted">Valid for</span>{[7, 15, 30].map((n) => <button key={n} type="button" className={`toggle-opt !py-1 ${days === n ? 'on' : ''}`} onClick={() => setDays(n)}>{n} days</button>)}</div>
            <div className="flex flex-wrap gap-2"><button className="btn btn-sm" disabled={makeQuote.isPending} onClick={() => makeQuote.mutate('whatsapp')}>Send on WhatsApp</button><button className="btn btn-sm" disabled={makeQuote.isPending} onClick={() => makeQuote.mutate('print')}>Print</button></div>
            <div className="text-xs text-muted">The quote never shows consultation or pharmacy prices. A discount is given on the bill, not on the quote.</div>
          </div>
          <div className="modal-foot"><button className="btn btn-ghost mr-auto" onClick={onClose}>Close</button><button className="btn btn-primary" disabled={agree.isPending} onClick={() => agree.mutate()}><Icon name="check" />Patient agrees to {money(pkg ? pkgs.find((k) => k.id === pkg)?.pricePaise ?? list : list)}</button></div>
        </div>
      ) : (
        <div className="space-y-4">
          <Standing c={c} />
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line p-3 text-sm"><b>Sittings</b><span className="text-muted">{c.doneSittings} of {c.sittings} done{booked?.day ? ` · next booked ${booked.day}` : ' · next not booked yet'}</span><span className="ml-auto" />{c.doneSittings < c.sittings && !booked && <button className="btn btn-sm btn-primary" onClick={() => setBooking(true)}>Book sitting {c.doneSittings + 1}</button>}</div>
          {rf && <div className="rounded-xl border border-line p-3 space-y-3 anim-fade-up">
            <div className="label !mb-0">Refund unused sittings · up to {money(c.refundablePaise)}</div>
            <div><label className="label" htmlFor="rf-amt">Amount</label><MoneyInput id="rf-amt" value={rf.amount} onChange={(v) => setRf({ ...rf, amount: v })} /></div>
            <div><span className="label">Given back by</span><div className="flex flex-wrap gap-1.5">{REFUND_MODES.map(([m, l]) => <button key={m} type="button" className={`toggle-opt !py-1 ${rf.mode === m ? 'on' : ''}`} aria-pressed={rf.mode === m} onClick={() => setRf({ ...rf, mode: m })}>{l}</button>)}</div></div>
            <div><label className="label" htmlFor="rf-why">Why</label><input id="rf-why" className="input" maxLength={200} value={rf.why} onChange={(e) => setRf({ ...rf, why: e.target.value })} /></div>
            <div className="flex gap-2"><button className="btn btn-ghost btn-sm" onClick={() => setRf(null)}>Cancel</button><button className="btn btn-primary btn-sm" disabled={refund.isPending || rfPaise <= 0 || rfPaise > c.refundablePaise || rf.why.trim().length < 3} onClick={() => refund.mutate()}>Give back {money(rfPaise)}</button></div>
          </div>}
          <div className="modal-foot">{can(perms, 'refund.course') && c.refundablePaise > 0 && !rf && <button className="btn btn-sm mr-auto" onClick={() => setRf({ amount: String(c.refundablePaise / 100), mode: 'upi', why: '' })}>Refund unused sittings</button>}<button className="btn btn-ghost" onClick={onClose}>Close</button>{canPay && leftToPay && <button className="btn" onClick={() => setPaying(true)}><Icon name="plus" />Take advance</button>}</div>
        </div>
      )}
    </Drawer>
  );
}

/** On the patient record: each course and where it stands. */
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
