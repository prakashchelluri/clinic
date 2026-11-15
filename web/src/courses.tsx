import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useOutletContext } from 'react-router';
import { get, post, qc, errText, NO_WHATSAPP } from './api';
import { can } from './App';
import { Drawer, Chip, Icon, MoneyInput, Section, money, toPaise, toast } from './ui';
import { TakePayment } from './takePayment';
import { openPrint } from './printPreview';
import { ScheduleModal } from './pages/Worklist';
import { stdTotal } from './procedureSettings';

const REFUND_MODES: ['cash' | 'upi' | 'card' | 'bank', string][] = [['cash', 'Cash'], ['upi', 'UPI'], ['card', 'Card'], ['bank', 'Bank']];
const refresh = () => ['courses', 'timeline', 'frontdesk', 'daily', 'payments-awaiting', 'worklist'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
export const useCourses = (patientId: string) => useQuery({ queryKey: ['courses', patientId], queryFn: () => get(`/courses?patientId=${patientId}`) });

/** Where the course stands, as labelled rows: the price and where it came from, who agreed it, the money, the sittings.
 *  `action` is the next step (Book sitting N), shown on the Sittings row. */
function Standing({ c, booked, action }: { c: any; booked?: { day?: string } | null; action?: React.ReactNode }) {
  const day = (d: string) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  const paid = c.advancePaise - c.refundedPaise + c.paidOnDayPaise;
  const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-3 border-t border-line py-2.5 first:border-t-0"><span className="text-muted">{label}</span><div>{children}</div></div>);
  return (
    <div className="rounded-[10px] border border-line px-4 py-1 text-[14px]">
      <Row label="Price"><b>{money(c.totalPaise)}</b> for {c.sittings} sessions <span className="text-muted">· {money(c.perSittingPaise)} each</span>
        <div className="text-[13px] text-muted">{c.priceSource === 'doctor' ? `Custom price${c.priceBy ? `, set by ${c.priceBy}` : ''}${c.standardPaise ? ` · standard price ${money(c.standardPaise)}` : ''}` : c.priceSource === 'package' ? `Share of the ${c.packageName ?? 'clinic'} package${c.standardPaise ? ` · standard price ${money(c.standardPaise)}` : ''}` : 'Standard price'}</div>
        {c.validUntil && <div className={`text-[13px] ${c.expired ? 'text-rose' : 'text-muted'}`}>{c.expired ? `Expired on ${day(c.validUntil)}: sessions not done can only be refunded` : `Valid till ${day(c.validUntil)}`}</div>}</Row>
      <Row label="Agreed">By the patient on {day(c.createdAt)}<div className="text-[13px] text-muted">{c.agreedBy ? `Recorded by ${c.agreedBy}` : ''}</div></Row>
      <Row label="Invoice">{c.invoiced ? <>On an invoice · {paid > 0 ? <b>{money(paid)} paid</b> : 'nothing paid yet'}<span className="text-muted"> · {money(c.stillToPayPaise)} still to pay</span></> : c.invoicedPaise > 0 ? <>{money(c.invoicedPaise)} invoiced session by session<span className="text-muted"> · {money(c.uninvoicedPaise)} not invoiced yet</span></> : <span className="text-muted">Not invoiced yet: Generate invoice bills the whole treatment once</span>}</Row>
      <Row label="Sessions"><div className="flex flex-wrap items-center gap-2"><span>{c.doneSittings} of {c.sittings} done<span className="text-muted"> · {booked?.day ? `session ${(booked as any).sittingNo ?? c.doneSittings + 1} booked on ${day(booked.day)}${(booked as any).startTime ? ` ${(booked as any).startTime}` : ''}` : 'next not booked yet'}</span></span><span className="ml-auto" />{action}</div></Row>
    </div>
  );
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
/** The quote the patient takes home: what, how many sittings, the price, how long it holds and what is not in it. */
export async function printQuote(id: string) {
  try {
    const r: any = await get(`/quotes/${id}/print`);
    // shown in the app's print preview, like the prescription and bills; Print there prints only the quote
    openPrint({ title: `Quote ${r.number}`, html: `<!doctype html><title>Quote ${esc(r.number)}</title><style>body{font:14px system-ui,sans-serif;margin:24px;color:#17191A}h1{font-size:18px;margin:0}table{width:100%;border-collapse:collapse;margin-top:12px}td{padding:6px 0;border-bottom:1px solid #ddd}.r{text-align:right}.s{color:#625F59;font-size:12px}</style>
      ${r.clinic.print?.logoUrl ? `<img src="${esc(r.clinic.print?.logoUrl)}" alt="" style="display:block;height:44px;max-width:150px;object-fit:contain;margin-bottom:6px">` : ''}<h1>${esc(r.clinic.name)}</h1><div class="s">${esc(r.clinic.print?.address ?? '')} ${esc(r.clinic.print?.phone ?? '')}</div>
      <p><b>Quote ${esc(r.number)}</b><br><span class="s">For ${esc(r.patient.fullName)} · prepared by ${esc(r.preparedBy)}</span></p>
      <table><tr><td>${esc(r.procedure)}: ${esc(r.sittings)} sessions</td><td class="r">${esc(money(r.totalPaise))}</td></tr>${r.extras.map((x: any) => `<tr><td>${esc(x.name)}</td><td class="r">${esc(money(x.pricePaise))}</td></tr>`).join('')}
      <tr><td><b>Total</b></td><td class="r"><b>${esc(money(r.grandTotalPaise))}</b></td></tr></table>
      <p class="s">${esc(r.taxNote)}. Valid until ${esc(r.validUntil)}. Consultation and medicines are charged separately.</p>` });
  } catch (e) { toast(errText(e), 'err'); }
}

/** A procedure plan's money in one place for the desk: the fixed price (list or a clinic package), the quote, booking, and invoicing the whole treatment.
 *  Nobody types a price here: a reduction is a discount on the bill, where above the clinic limit it waits for approval. */
export function CourseDialog({ rec, patientId, patientName, onClose }: { rec: { id: string; procedureId: string; procedure?: string; sittings?: number; amountPaise?: number | null; package?: { name: string; pricePaise: number; listPaise: number } | null; patient?: any }; patientId: string; patientName: string; onClose: () => void }) {
  const [booking, setBooking] = useState(false); const [moving, setMoving] = useState<any>(null); const [paying, setPaying] = useState(false); // book a new sitting, or move the one booked
  const { cfg, perms } = useOutletContext<any>();
  const cs = useCourses(patientId); const c = (cs.data ?? []).find((x: any) => x.recommendationId === rec.id);
  const proc = cfg?.procedures?.find((p: any) => p.id === rec.procedureId);
  const sittings = rec.sittings ?? 1; const custom = rec.amountPaise && rec.amountPaise > 0 ? rec.amountPaise : 0; // the doctor's own price, for all sittings
  const list = custom || stdTotal(proc, sittings);
  const [days, setDays] = useState(15); const pk = rec.package;
  const qs = useQuery({ queryKey: ['quotes', rec.id], queryFn: () => get(`/quotes?recommendationId=${rec.id}`) }); const quotes: any[] = qs.data ?? [];
  // the patient agrees the price (reception records it): this fixes the course at that price, before the first sitting is booked
  const agree = useMutation({ mutationFn: () => post('/courses', { recommendationId: rec.id }), onSuccess: () => { refresh(); toast(pk ? `Recorded: the patient agreed the ${pk.name} package (${money(pk.pricePaise)}). Book the first session.` : `Recorded: the patient agreed ${money(list)}. Book the first session.`); }, onError: (e) => toast(errText(e), 'err') });
  const makeQuote = useMutation({ mutationFn: (send: 'whatsapp' | 'print') => post('/quotes', { recommendationId: rec.id, validDays: days, send }),
    onSuccess: (r: any, send) => { qc.invalidateQueries({ queryKey: ['quotes', rec.id] }); if (r.whatsapp === 'opted_out') { toast(`Quote ${r.number} saved. ${NO_WHATSAPP}`, 'info', { label: 'Print', run: () => printQuote(r.id) }); return; }
      toast(send === 'whatsapp' ? `Quote ${r.number} is on its way` : `Quote ${r.number} ready`); if (send === 'print') printQuote(r.id); },
    onError: (e: any) => toast(e?.body?.code === 'NO_PHONE' ? 'This patient has no phone number for WhatsApp' : errText(e), 'err') });
  const ledger: any[] = c?.ledger ?? []; const booked = c?.nextSitting ?? ledger.find((l: any) => l.state && !['done', 'planned'].includes(l.state)); // the next sitting already booked
  const canPay = can(perms, 'payment.record'); const toInvoice = c ? c.uninvoicedPaise > 0 && !c.expired : true;
  if (booking || moving) return <ScheduleModal rec={{ ...rec, patient: rec.patient ?? { id: patientId, fullName: patientName } }} sitting={moving ?? undefined} onClose={() => { setBooking(false); setMoving(null); refresh(); ['psessions', 'timeline', 'calendar'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); }} />;
  if (paying) return <TakePayment patientId={patientId} patientName={patientName} ahead={{ recommendationId: rec.id }} onClose={() => { setPaying(false); refresh(); }} />;
  return (
    <Drawer title={rec.procedure ?? 'Procedure'} subtitle={`${patientName} · ${c?.sittings ?? sittings} sessions planned`} onClose={onClose} width="max-w-lg">
      {!cs.data ? <div className="text-sm text-muted">Loading…</div> : !c ? (
        <div className="space-y-4">
          <div className="text-sm">Price: <b>{money(list)}</b> for {sittings} sessions{pk ? <>, its share of the <b>{pk.name}</b> package ({money(pk.pricePaise)} for all its procedures, full price {money(pk.listPaise)}). Agreeing records the whole package.</> : custom ? <>, <b>set by the doctor</b>.</> : ` (${money(proc?.pricePaise ?? 0)} each), the standard price.`} <span className="text-muted">A lower price is a discount on the bill; above the clinic's limit it needs approval.</span></div>
          <div className="rounded-xl border border-line p-3 space-y-2">
            <div className="flex flex-wrap items-center gap-2 text-sm"><b>Quote</b>{quotes[0] ? <Chip tone={quotes[0].state === 'open' ? 'sky' : quotes[0].state === 'expired' ? 'rose' : ''}>{quotes[0].number} · {money(quotes[0].totalPaise)} · {quotes[0].state === 'expired' ? 'expired' : `valid to ${quotes[0].validUntil}`}{quotes[0].sentVia ? ` · ${quotes[0].sentVia}` : ''}</Chip> : <span className="text-muted">None sent yet</span>}</div>
            {quotes[0]?.state === 'expired' && <div className="text-xs text-rose">This quote has run out. Call the patient or make a new one.</div>}
            <div className="flex flex-wrap items-center gap-1.5 text-sm"><span className="text-muted">Valid for</span>{[7, 15, 30].map((n) => <button key={n} type="button" className={`toggle-opt !py-1 ${days === n ? 'on' : ''}`} onClick={() => setDays(n)}>{n} days</button>)}</div>
            <div className="flex flex-wrap gap-2"><button className="btn btn-sm" disabled={makeQuote.isPending} onClick={() => makeQuote.mutate('whatsapp')}>Send on WhatsApp</button><button className="btn btn-sm" disabled={makeQuote.isPending} onClick={() => makeQuote.mutate('print')}>Print</button></div>
            <div className="text-xs text-muted">The quote never shows consultation or pharmacy prices. A discount is given on the bill, not on the quote.</div>
          </div>
          <div className="modal-foot"><button className="btn btn-ghost mr-auto" onClick={onClose}>Close</button><button className="btn btn-primary" disabled={agree.isPending} onClick={() => agree.mutate()}><Icon name="check" />{pk ? `Patient agrees to the package (${money(pk.pricePaise)})` : `Patient agrees to ${money(list)}`}</button></div>
        </div>
      ) : (
        <div className="space-y-4">
          <Standing c={c} booked={booked} action={booked?.id ? <button className="btn btn-sm" onClick={() => setMoving(booked)}>Reschedule</button> : c.doneSittings < c.sittings && !booked && <button className="btn btn-sm btn-primary" onClick={() => setBooking(true)}>Book session {c.doneSittings + 1}</button>} />
          <div className="modal-foot"><button className="btn btn-ghost" onClick={onClose}>Close</button>{canPay && toInvoice && <button className="btn" onClick={() => setPaying(true)}><Icon name="plus" />Generate invoice</button>}</div>
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
        return <div key={c.id} className="row"><div className="min-w-0 flex-1"><div className="text-sm font-medium">{name ?? 'Procedure'}{c.packageName && <span className="ml-1.5 text-xs font-normal text-clay-ink">{c.packageName} package</span>}{c.expired && <span className="ml-1.5 text-xs font-normal text-rose">Expired</span>}</div><div className="text-xs text-muted">{c.doneSittings} of {c.sittings} done · {c.invoiced ? `${money(c.stillToPayPaise)} still to pay` : 'not invoiced yet'}</div></div>
          <button className="btn btn-sm" onClick={() => setOpen({ id: c.recommendationId, procedureId: c.procedureId, procedure: name, sittings: c.sittings })}>Open</button></div>; })}
      {open && <CourseDialog rec={open} patientId={patientId} patientName={patientName} onClose={() => setOpen(null)} />}
    </Section>
  );
}
