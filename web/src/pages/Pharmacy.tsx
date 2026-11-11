import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Link, Navigate, useOutletContext, useSearchParams } from 'react-router';
import { get, post, qc, today, fmtTime, errText, NO_WHATSAPP } from '../api';
import { can } from '../App';
import { openPrint } from '../printPreview';
import { Chip, Empty, Icon, Modal, Segmented, Filter, Skeleton, money, toast, MoneyInput, toPaise, NumInput, ask, fmtDate, usePageSearch } from '../ui';
import { Inventory, type InvTab } from './pharmacyStock';
import { RegisterTab } from './pharmacyRegister';
import { DataTable, filterValue, type Col, type FilterDef } from '../table';

type Tab = 'counter' | 'bills' | 'register';
const INV: string[] = ['stock', 'batches', 'orders', 'vendors'];
const REASONS = ['Has at home', 'Will buy later', 'Bought outside', 'Out of stock', 'Too costly', 'Doctor said not needed'];
const exp = (d: string) => d.slice(5, 7) + '/' + d.slice(2, 4);
const rupees2 = (p: number) => (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (x: unknown) => String(x ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const packLabel = (m: { form?: string | null; packSize?: number } | null | undefined, n = 1) => !m ? '' : ['tab', 'cap'].includes(m.form ?? '') ? `strip${n === 1 ? '' : 's'}` : (m.form ?? 'pack') + (n === 1 ? '' : 's');
/** One key per bill, made when the bill starts: a retry after a lost reply returns the same sale instead of a second one. */
const newKey = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);
/** The server's own words for the pharmacy guards (Schedule H, over-issue); everything else as usual. */
const phErr = (e: any) => (['NEEDS_PRESCRIPTION', 'MORE_THAN_PRESCRIBED'].includes(e?.body?.code) && e.body.message ? e.body.message : errText(e));
/** Near expiry: within 60 days of today. */
const nearExpiry = (d?: string | null) => !!d && daysTo(d) <= 60;
const pref = (k: string, d: boolean) => { try { const v = localStorage.getItem(k); return v === null ? d : v === '1'; } catch { return d; } };
const setPref = (k: string, v: boolean) => { try { localStorage.setItem(k, v ? '1' : '0'); } catch { /* private mode */ } };

/** Inventory, its own page: stock, batches and expiry, orders and vendors. */
export function InventoryPage() {
  const [sp, setSp] = useSearchParams();
  return <Inventory tab={(sp.get('tab') as InvTab) || 'stock'} sp={sp} go={(next) => setSp(next)} />;
}

/** Pharmacy: the counter (prescriptions to pick from, issue what the patient buys), bills and returns, and stock. */
export function Pharmacy() {
  const { perms, cfg } = useOutletContext<any>();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as Tab) || 'counter';
  const go = (next: Record<string, string>) => setSp(next);
  useEffect(() => { if (sp.get('sale')) go({ tab: 'counter', rx: 'walkin' }); }, [sp]);
  const stock = can(perms, 'stock.read');
  const tabs: { value: Tab; label: string }[] = [{ value: 'counter', label: 'Counter' }, { value: 'bills', label: 'Bills' }, { value: 'register', label: 'Register' }];
  if (INV.includes(tab)) return <Navigate to={`/inventory?${sp}`} replace />; // links from before Inventory had its own page
  return (
    <div>
      {/* the page name is in the top bar; here only the sections and the counter's main action */}
      <div className="anim-fade-up mb-5 flex flex-wrap items-center gap-3">
        <Segmented<Tab> value={tab} onChange={(v) => go({ tab: v })} options={tabs} />
      </div>
      {tab === 'counter' && <Counter sel={sp.get('rx')} pick={(rx) => go(rx ? { tab: 'counter', rx } : { tab: 'counter' })} />}
      {tab === 'bills' && <Bills sel={sp.get('bill')} pick={(bill) => setSp((p) => { const n = new URLSearchParams(p); bill ? n.set('bill', bill) : n.delete('bill'); return n; })} onIssue={(rx) => go({ tab: 'counter', rx })} />}
      {tab === 'register' && <RegisterTab clinic={cfg?.tenant?.name ?? ''} licence={cfg?.tenant?.settings?.print?.drugLicence ?? cfg?.tenant?.settings?.drugLicence} />}
    </div>
  );
}

/* ---------------- Counter: the register ---------------- */

type Line = { key: string; medicineId: string | null; name: string; rxItemId?: string; prescribed?: number; issued?: number; left?: number; how?: string; qty: string; batchId: string; reason: string; batches: any[]; onHand: number; mrpPaise: number; gstBp: number; med: any; overReason?: string; doctorQty?: number | null };

const lineAmount = (l: Line) => { const b = l.batches.find((x) => x.id === l.batchId); return (Number(l.qty) || 0) * (b?.mrpPaise ?? l.mrpPaise); };
/** Each form has its own pastel, as Vialo colours its categories. */
const FORMS: Record<string, [string, string, string]> = { tab: ['bg-tile-1', 'Tablet', 'Tablets'], cap: ['bg-tile-3', 'Capsule', 'Capsules'], cream: ['bg-tile-4', 'Cream', 'Creams'], gel: ['bg-tile-2', 'Gel', 'Gels'], lotion: ['bg-tile-5', 'Lotion', 'Lotions'] };
const tileOf = (form?: string | null) => FORMS[form ?? '']?.[0] ?? 'bg-tile-5';
const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
const daysTo = (d: string) => Math.round((new Date(d + 'T00:00:00').getTime() - Date.now()) / 86400000);
const shortDay = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
/**
 * The doctor's prescription as bill lines. The quantity is what is left of the doctor's own (the server turns the
 * doctor's saved units into packs; only when that is missing does it work them out), capped by stock. Never the whole shelf.
 */
const rxToLines = (rx: any): Line[] => (rx?.items ?? []).map((it: any) => {
  const qty = it.medicine ? Math.max(0, Math.min(it.left, it.onHand)) : 0;
  return { key: it.id, medicineId: it.medicine?.id ?? null, name: it.name, rxItemId: it.id, prescribed: it.prescribed, issued: it.issuedQty, left: it.left, doctorQty: it.qty ?? null, how: [it.dose, it.frequency, it.durationDays ? `${it.durationDays} days` : null].filter(Boolean).join(' · '),
    qty: String(qty), batchId: it.batches[0]?.id ?? '', reason: it.medicine && it.left > it.onHand ? 'Out of stock' : '', batches: it.batches, onHand: it.onHand, mrpPaise: it.medicine?.mrpPaise ?? 0, gstBp: it.medicine?.gstBp ?? 0, med: it.medicine, overReason: '' };
});

/** A small capsule flies from what was tapped to the bill: it rises, glides across, and shrinks into the line (Vialo's flydot, as a tablet). */
function fly(from: Element | null, to: Element | null) {
  if (!from || !to || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const a = from.getBoundingClientRect(), b = to.getBoundingClientRect();
  const sx = a.left + a.width / 2, sy = a.top + a.height / 2, ex = b.left + Math.min(b.width / 2, 48), ey = b.top + Math.min(b.height / 2, 30);
  const el = document.createElement('span'); el.className = 'flypill'; document.body.appendChild(el);
  // a quadratic curve with its control point at (start x, end y): up first, then across
  const frames: Keyframe[] = [];
  for (let i = 0; i <= 12; i++) { const t = i / 12, u = 1 - t; const x = (u * u + 2 * u * t) * sx + t * t * ex; const y = u * u * sy + (2 * u * t + t * t) * ey;
    frames.push({ transform: `translate(${x}px, ${y}px) translate(-50%, -50%) rotate(${-35 + 320 * t}deg)`, offset: t * 0.8 }); }
  frames.push({ transform: `translate(${ex}px, ${ey}px) translate(-50%, -50%) rotate(285deg) scale(0.3)`, opacity: 0, offset: 1 });
  // it holds its last (faded) frame until removed; the timer covers a background tab, where finish events wait
  el.animate(frames, { duration: 680, easing: 'cubic-bezier(.3,.7,.4,1)', fill: 'forwards' }).onfinish = () => el.remove();
  setTimeout(() => el.remove(), 900);
}

function Counter({ sel, pick }: { sel: string | null; pick: (rx: string | null) => void }) {
  const { perms, cfg } = useOutletContext<any>(); const canBill = can(perms, 'pharmacy.bill');
  const [q] = usePageSearch('Find a prescription: name, phone or OP no.'); const [earlier, setEarlier] = useState(false);
  const term = q.trim().length >= 2 ? q.trim() : '';
  const list = useQuery({ queryKey: ['pharmacy', 'counter', term], queryFn: () => get(`/pharmacy/counter${term ? `?q=${encodeURIComponent(term)}` : ''}`), refetchInterval: 15000 });
  const meds = useQuery({ queryKey: ['pharmacy', 'medicines'], queryFn: () => get('/pharmacy/medicines'), staleTime: 30_000 });
  const d = list.data;
  const [find, setFind] = useState(''); const [form, setForm] = useState('all');
  const [bill, setBill] = useState<{ rx: any | null; who: any; lines: Line[] }>({ rx: null, who: null, lines: [] });
  const [loading, setLoading] = useState(false);
  const [over, setOver] = useState(false); const [dragId, setDragId] = useState<string | null>(null);
  const [hit, setHit] = useState<[string, number]>(['', 0]); // the line just added to: it pops again
  const [discount, setDiscount] = useState(''); const [paying, setPaying] = useState(false); const [sale, setSale] = useState<any>(null);
  const [billKey, setBillKey] = useState(newKey); // made when the bill starts, not per request
  const [parked, setParked] = useState<{ rx: any | null; who: any; lines: Line[] } | null>(null); // a walk-in bill set aside for a prescription
  const billRef = useRef<HTMLElement>(null);

  // the bill follows ?rx=: a prescription opened from the list, by drag, or from Bills. Its own lines only: nothing from an earlier walk-in moves onto it.
  useEffect(() => {
    if (!sel || sel === 'walkin') { if (sel === 'walkin') { setBill({ rx: null, who: null, lines: [] }); setDiscount(''); setBillKey(newKey()); } return; }
    if (bill.rx?.encounterId === sel) return;
    let live = true; setLoading(true);
    get(`/pharmacy/rx/${sel}`).then((rx: any) => { if (live) { setBill({ rx, who: rx.patient, lines: rxToLines(rx) }); setDiscount(''); setBillKey(newKey()); } }, (e) => toast(errText(e), 'err')).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [sel]);

  const allRx: any[] = [...(d?.today ?? []), ...(d?.balances ?? []), ...(d?.found ?? [])];
  const choose = async (r: any, from?: Element | null) => {
    if (!canBill || r.encounterId === bill.rx?.encounterId) return;
    const open = bill.lines.filter((l) => Number(l.qty) > 0);
    if (bill.rx && open.length) {
      const ok = await ask({ title: `Start ${r.patient.fullName}'s bill?`, body: `${bill.rx.patient.fullName}'s bill is not paid. It is set aside and their prescription stays on the list.`, confirmLabel: 'Start new bill' });
      if (!ok) return;
    } else if (!bill.rx && open.length) {
      // walk-in items never move onto a patient's prescription bill: they wait, as their own bill
      const ok = await ask({ title: `Start a new bill for ${r.patient.fullName}?`, body: `The ${open.length} item${open.length === 1 ? '' : 's'} on this bill stay with the walk-in. Go back to them after this sale.`, confirmLabel: 'Start new bill' });
      if (!ok) return;
      setParked(bill);
    }
    if (from) fly(from, billRef.current);
    pick(r.encounterId);
  };
  const inBill = (id: string) => bill.lines.filter((l) => l.medicineId === id).reduce((n, l) => n + (Number(l.qty) || 0), 0);
  const addMed = (m: any, from?: Element | null) => {
    if (!canBill) return;
    if (inBill(m.id) >= m.onHand) { toast(`Only ${m.onHand} ${packLabel(m, m.onHand)} of ${m.name} in stock`, 'info'); return; }
    fly(from ?? null, document.querySelector(`[data-line="${m.id}"]`) ?? billRef.current);
    const at = bill.lines.find((l) => l.medicineId === m.id);
    setHit(([, n]) => [at?.key ?? `x${m.id}`, n + 1]);
    setBill((b) => at ? { ...b, lines: b.lines.map((l) => (l.key === at.key ? { ...l, qty: String((Number(l.qty) || 0) + 1) } : l)) }
      : { ...b, lines: [...b.lines, { key: `x${m.id}`, medicineId: m.id, name: m.name, qty: '1', batchId: m.batches[0]?.id ?? '', reason: '', batches: m.batches, onHand: m.onHand, mrpPaise: m.mrpPaise, gstBp: m.gstBp, med: m }] });
  };
  const set = (key: string, patch: Partial<Line>) => setBill((b) => ({ ...b, lines: b.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) }));
  const step = (l: Line, by: number) => set(l.key, { qty: String(Math.max(0, Math.min(l.onHand, (Number(l.qty) || 0) + by))) });
  const reset = () => { setBill({ rx: null, who: null, lines: [] }); setDiscount(''); setBillKey(newKey()); pick(null); };
  const unpark = () => { if (!parked) return; pick(null); setBill(parked); setParked(null); setDiscount(''); setBillKey(newKey()); };
  const clearBill = async () => {
    if (bill.lines.some((l) => Number(l.qty) > 0)) { const ok = await ask({ title: 'Clear this bill?', body: 'Nothing is saved. A prescription stays on the list.', confirmLabel: 'Clear', tone: 'danger' }); if (!ok) return; }
    reset();
  };

  // no prescription and nobody picked: a walk-in with no record (a name and phone are optional)
  const rx = bill.rx; const who = rx ? bill.who : bill.who ?? { walkIn: true, fullName: '' }; const lines = bill.lines;
  const allergies: string | null = rx?.patient.allergies ?? (who?.id ? who.allergies : null) ?? null;
  const overBy = (l: Line) => (l.rxItemId ? (Number(l.qty) || 0) - (l.left ?? 0) : 0);
  const issuing = lines.filter((l) => l.medicineId && Number(l.qty) > 0);
  const gross = issuing.reduce((n, l) => n + lineAmount(l), 0);
  const disc = Math.min(toPaise(discount || '0'), gross); const total = gross - disc;
  const capBp: number = can(perms, 'stock.approve') ? 10000 : cfg?.tenant?.settings?.pharmacy?.maxDiscountBp ?? 1000; // the server's own cap, shown before Take payment
  const gstIn = issuing.reduce((n, l) => { const a = lineAmount(l); return n + a - Math.round((a * 10000) / (10000 + l.gstBp)); }, 0);
  const gst = gross ? Math.round((gstIn * total) / gross) : 0;
  const overStock = lines.find((l) => Number(l.qty) > l.onHand);
  const rxLines = lines.filter((l) => l.rxItemId);
  const units = issuing.reduce((n, l) => n + Number(l.qty), 0);
  const nothing = useMutation({ mutationFn: (reason: string) => post(`/pharmacy/rx/${rx.encounterId}/nothing`, { reason: reason || undefined }),
    onSuccess: () => { toast('Noted: not buying here'); qc.invalidateQueries({ queryKey: ['pharmacy'] }); reset(); }, onError: (e) => toast(errText(e), 'err') });
  const outside = useMutation({ mutationFn: (reason: string) => post(`/pharmacy/rx/${rx.encounterId}/outside`, { reason: reason || undefined }),
    onSuccess: () => { toast('Noted: the rest was bought outside'); qc.invalidateQueries({ queryKey: ['pharmacy'] }); reset(); }, onError: (e) => toast(errText(e), 'err') });
  const overNoReason = lines.find((l) => overBy(l) > 0 && (l.overReason ?? '').trim().length < 3);
  const scheduledNoRx = !rx ? issuing.find((l) => ['H', 'H1', 'X'].includes(l.med?.scheduleClass ?? '')) : issuing.find((l) => !l.rxItemId && ['H', 'H1', 'X'].includes(l.med?.scheduleClass ?? ''));
  const problem = !who ? 'Pick or register the customer.' : issuing.length === 0 ? 'Nothing to sell yet.' : overStock ? `${overStock.name}: only ${overStock.onHand} in stock.`
    : scheduledNoRx ? `${scheduledNoRx.name} needs a doctor's prescription. Remove it, or open the patient's prescription.`
    : overNoReason ? `${overNoReason.name}: ${overBy(overNoReason)} more than prescribed. Say why.` : total <= 0 ? 'The discount cannot be the whole bill.' : disc * 10000 > gross * capBp ? `Discounts above ${capBp / 100}% need the owner.` : '';

  const medList: any[] = meds.data ?? [];
  const forms = [...new Set(medList.map((m) => m.form).filter(Boolean))] as string[];
  const shown = medList.filter((m) => (form === 'all' || m.form === form) && (!find.trim() || m.name.toLowerCase().includes(find.trim().toLowerCase())));
  const waiting = (d?.today ?? []).filter((r: any) => r.status === 'none' || r.status === 'part').length;

  // a plain function, not a component: a component declared here is a new type on every render, and the card being dragged would be replaced mid-drag
  const rxCard = (r: any, sub?: string) => {
    const on = rx?.encounterId === r.encounterId; const quiet = on || r.status === 'issued' || r.status === 'nothing';
    return (
      <button key={r.encounterId} type="button" draggable={canBill && !on} aria-pressed={on}
        onDragStart={(e) => { e.dataTransfer.setData('text/rx', r.encounterId); e.dataTransfer.effectAllowed = 'copy'; setDragId(r.encounterId); }}
        onDragEnd={() => { setDragId(null); setOver(false); }} onClick={(e) => choose(r, e.currentTarget)}
        className={`flex min-w-0 items-center gap-2.5 rounded-[18px] p-2.5 pl-3 text-left transition-all duration-200 ${quiet ? 'bg-surface-2 text-ink-2 shadow-[var(--ring)]' : 'bg-clay text-white hover:-translate-y-0.5 hover:shadow-[0_14px_26px_-16px_var(--color-clay)]'} ${canBill && !on ? 'cursor-grab active:cursor-grabbing active:scale-[.98]' : ''} ${dragId === r.encounterId ? 'rotate-[-2deg] scale-[1.03] opacity-60' : ''}`}>
        <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-full text-[12px] font-bold ${quiet ? 'bg-paper-2 text-ink-2' : 'bg-white/90 text-[#0B6B47]'}`}>{initials(r.patient.fullName)}</span>
        <span className="min-w-0 flex-1"><b className="block truncate text-[13.5px]">{r.patient.fullName}</b><small className="block truncate text-[12px] opacity-75">{sub ?? [r.opNumber, r.doctor].filter(Boolean).join(' · ')}</small></span>
        <span className="shrink-0 text-right"><b className="block text-[13px]">{r.items} {r.items === 1 ? 'medicine' : 'medicines'}</b><small className="block text-[11.5px] font-semibold opacity-80">{on ? 'On the bill' : r.status === 'issued' ? 'Issued' : r.status === 'nothing' ? 'Bought elsewhere' : r.status === 'part' ? 'Part given' : 'To fill'}</small></span>
      </button>);
  };

  return (
    <div>
      {/* the two numbers that matter at the counter, Vialo-style */}
      <div className="anim-fade-up mb-4 flex flex-wrap items-center gap-x-8 gap-y-3">
        <div className="flex items-center gap-3"><span className="grid h-11 w-11 place-items-center rounded-full bg-surface shadow-[var(--shadow-soft)]"><Icon name="list" className="h-5 w-5 text-ink-2" /></span><span><b className="block text-[20px] leading-tight">{waiting}</b><small className="text-[12.5px] text-muted">prescriptions to fill today</small></span></div>
        <div className="flex items-center gap-3"><span className={`grid h-11 w-11 place-items-center rounded-full transition-colors ${issuing.length ? 'bg-clay text-white' : 'bg-surface text-ink-2 shadow-[var(--shadow-soft)]'}`}><Icon name="rupee" className="h-5 w-5" /></span><span><b className="block text-[20px] leading-tight"><span key={total} className="bump">{money(total)}</span></b><small className="text-[12.5px] text-muted">on this bill · {units} {units === 1 ? 'item' : 'items'}</small></span></div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_400px] xl:items-start">
        <div className="min-w-0 space-y-4">
          <section className="card anim-fade-up">
            <div className="mb-3 flex flex-wrap items-start gap-3">
              <div className="mr-auto"><div className="card-title">Today's prescriptions</div><div className="text-[12.5px] text-muted">From the doctors. Tap one, or drag it onto the bill.</div></div>
            </div>
            {list.isLoading ? <Skeleton rows={3} /> : term ? (
              (d?.found ?? []).length === 0 ? <div className="py-4 text-sm text-muted">No prescription in the last 30 days matches.</div>
                : <div className="grid gap-2 sm:grid-cols-2 2xl:grid-cols-3">{d.found.map((r: any) => rxCard(r, `${fmtDate(r.day)} · ${r.opNumber} · ${r.doctor ?? ''}`))}</div>
            ) : (<>
              {(d?.today ?? []).length === 0 ? <div className="py-4 text-sm text-muted">No prescriptions yet today.</div>
                : <div className="grid gap-2 sm:grid-cols-2 2xl:grid-cols-3">{d.today.map((r: any) => rxCard(r))}</div>}
              {(d?.balances ?? []).length > 0 && <div className="mt-4 border-t border-line pt-3">
                <button type="button" className="flex w-full items-center gap-2 text-left" aria-expanded={earlier} onClick={() => setEarlier(!earlier)}>
                  <b className="text-[13.5px]">Earlier prescriptions</b><span className="text-xs text-muted">{d.balances.length} partly bought here</span><Icon name={earlier ? 'up' : 'chevR'} className="ml-auto h-4 w-4 text-muted" /></button>
                {earlier && <><div className="py-2 text-xs text-muted">For reference when the patient comes back. Nothing is owed: the rest may have been bought outside.</div>
                  <div className="grid gap-2 sm:grid-cols-2 2xl:grid-cols-3">{d.balances.map((r: any) => rxCard(r, `Rx ${fmtDate(r.day)} · ${r.balance.map((b: any) => `${b.name} ${b.left} left`).join(', ')}`))}</div></>}
              </div>}
            </>)}
          </section>

          <section className="card anim-fade-up">
            <div className="card-title">Medicines</div><div className="text-[12.5px] text-muted">Tap a tile to add one. Each sells from the batch that expires first.</div>
            <div className="mt-3 flex gap-2">
              <div className="relative flex-1"><Icon name="search" className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                <input className="input !min-h-[46px] !pl-10" aria-label="Find a medicine" placeholder="Type a medicine name" value={find} onChange={(e) => setFind(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && shown[0]) { e.preventDefault(); addMed(shown[0], document.querySelector(`[data-tile="${shown[0].id}"]`)); setFind(''); } }} /></div>
              <button type="button" className="btn btn-ink !min-h-[46px] px-5" disabled={!shown[0] || !canBill} onClick={() => { addMed(shown[0], document.querySelector(`[data-tile="${shown[0].id}"]`)); setFind(''); }}>Add</button>
            </div>
            {forms.length > 1 && <div className="mt-3"><Filter label="Form" value={form} onChange={setForm} options={['all', ...forms].map((f) => ({ value: f, label: f === 'all' ? 'All' : FORMS[f]?.[2] ?? f }))} /></div>}
            {meds.isLoading ? <div className="mt-3"><Skeleton rows={3} /></div> : shown.length === 0 ? <div className="mt-3 py-4 text-sm text-muted">{find ? 'Not in the list. Ask the owner to add it.' : 'No medicines yet.'}</div> : (
              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 2xl:grid-cols-4">
                {shown.map((m: any) => {
                  const n = inBill(m.id); const left = m.onHand - n; const fefo = m.batches[0]; const days = fefo ? daysTo(fefo.expiry) : null;
                  return (
                    <button key={m.id} type="button" data-tile={m.id} disabled={!canBill || left <= 0} onClick={(e) => addMed(m, e.currentTarget)} aria-label={`${m.name}, ${money(m.mrpPaise)}, ${left} left`}
                      className="relative flex min-h-[148px] flex-col gap-2.5 rounded-[20px] bg-surface-2 p-3.5 text-left shadow-[inset_0_0_0_1px_rgba(16,32,24,.08)] transition-all duration-200 hover:-translate-y-0.5 hover:bg-surface hover:shadow-[inset_0_0_0_1px_rgba(16,32,24,.08),0_16px_30px_-22px_rgba(16,22,40,.55)] active:scale-[.97] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0">
                      <span className="flex items-start justify-between gap-2">
                        <span className={`grid h-9 w-9 place-items-center rounded-full ${tileOf(m.form)}`}><Icon name="pill" className="h-4 w-4 text-ink" /></span>
                        {days !== null && days <= 90 && <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${days < 0 ? 'bg-rose-soft text-rose' : 'bg-amber-soft text-amber'}`}>{days < 0 ? 'expired' : `exp ${shortDay(fefo.expiry)}`}</span>}
                      </span>
                      <span className="min-w-0"><b className="block text-[14px] leading-snug">{m.name}</b><small className="block text-[12px] text-muted">{[FORMS[m.form]?.[1] ?? m.form, m.packSize > 1 ? `${m.packSize} per strip` : null, m.scheduleClass && m.scheduleClass !== 'OTC' ? `Rx needed (${m.scheduleClass})` : null].filter(Boolean).join(' · ')}</small></span>
                      <span className="mt-auto flex items-baseline justify-between gap-2"><b className="text-[15px]">{money(m.mrpPaise)}</b><small className={`text-[12px] font-semibold ${left <= 0 ? 'text-rose' : left <= 10 ? 'text-amber' : 'text-muted'}`}>{left <= 0 ? 'none left' : `${left} left`}</small></span>
                      {n > 0 && <span key={n} className="pop-in absolute -left-2 -top-2 grid h-6 min-w-6 place-items-center rounded-full bg-clay px-1.5 text-[12px] font-bold text-white shadow-[0_4px_10px_-4px_var(--color-clay)]">{n}</span>}
                    </button>);
                })}
              </div>)}
          </section>
        </div>

        {/* the bill: a drop target for prescriptions, the landing place for every tablet */}
        <aside ref={billRef} aria-label="This bill"
          onDragOver={(e) => { if (!e.dataTransfer.types.includes('text/rx')) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; if (!over) setOver(true); }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false); }}
          onDrop={(e) => { e.preventDefault(); const id = e.dataTransfer.getData('text/rx'); setOver(false); setDragId(null); const r = allRx.find((x) => x.encounterId === id); if (r) choose(r); }}
          className={`card relative anim-fade-up transition-[transform,box-shadow] duration-300 xl:sticky xl:top-[84px] xl:max-h-[calc(100dvh-100px)] xl:overflow-y-auto ${over ? 'scale-[1.01] !shadow-[inset_0_0_0_2px_var(--color-clay),0_24px_48px_-28px_var(--color-clay)]' : ''}`}>
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1"><div className="card-title">This bill</div><div className="truncate text-[12.5px] text-muted">{rx ? [`For ${rx.patient.fullName}`, rx.opNumber, rx.doctor].filter(Boolean).join(' · ') : 'Walk-in customer'}</div></div>
            {lines.length > 0 && canBill && <button type="button" className="btn btn-icon" aria-label="Clear the bill" title="Clear the bill" onClick={clearBill}><Icon name="x" className="h-4 w-4" /></button>}
          </div>
          {rx ? <div className="mt-3 flex items-center gap-2.5 rounded-[16px] bg-surface-2 p-2.5 shadow-[var(--ring)]">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-tile-1 text-[12px] font-bold">{initials(rx.patient.fullName)}</span>
              <span className="min-w-0 flex-1"><b className="block truncate text-[13.5px]">{rx.patient.fullName}</b><small className="block truncate text-[12px] text-muted">{[rx.patient.patientNo, [rx.patient.ageYears, rx.patient.sex].filter(Boolean).join(' '), rx.patient.phone].filter(Boolean).join(' · ')}</small></span>
              {rx.diagnosis && <span className="max-w-[40%] truncate text-right text-[12px] text-muted">{rx.diagnosis}</span>}
            </div>
            : <WalkInPatient key={billKey} who={bill.who} setWho={(p) => setBill((b) => ({ ...b, who: p }))} />}
          {parked && <button type="button" className="mt-2 w-full rounded-[12px] bg-amber-soft px-3 py-2 text-left text-[12.5px] text-[#6E4D10]" onClick={unpark}>A walk-in bill is set aside ({parked.lines.filter((l) => Number(l.qty) > 0).length} items). <b className="underline">Back to it</b></button>}
          {allergies && <div className="pop-in mt-2 flex gap-2.5 rounded-[14px] bg-rose-soft px-3 py-2.5 text-rose" role="alert"><span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-rose text-[12px] font-bold text-white">!</span><span><b className="block text-[13.5px]">Allergic to {allergies}</b><small className="text-[12px]">Check anything you add before you sell it.</small></span></div>}
          {rx?.bills?.length > 0 && <div className="mt-2 text-xs text-muted">Already billed on this prescription: {rx.bills.map((b: any) => `${b.invoiceNo} (${money(b.totalPaise)})`).join(', ')}</div>}

          <div className="mt-3">
            {loading ? <Skeleton rows={3} /> : lines.length === 0 ? (
              <div className={`grid place-items-center rounded-[18px] border-2 border-dashed px-4 py-9 text-center transition-colors ${over ? 'border-clay bg-clay-soft' : 'border-line-2'}`}>
                <span className="grid h-12 w-12 place-items-center rounded-[14px] bg-surface shadow-[var(--shadow-soft)]"><Icon name="pill" className="h-5 w-5 text-ink-2" /></span>
                <b className="mt-3 block text-[15px]">{over ? 'Drop to start the bill' : 'Tap or drag to start'}</b>
                <span className="mt-1 block max-w-[260px] text-[12.5px] text-muted">Drag one of today's prescriptions here, or tap a medicine.</span>
              </div>
            ) : lines.map((l) => {
              const n = Number(l.qty) || 0; const done = l.rxItemId !== undefined && (l.left ?? 0) === 0; const short = l.rxItemId ? (l.left ?? 0) - n : 0; const b = l.batches.find((x) => x.id === l.batchId);
              return (
                <div key={l.key + (hit[0] === l.key ? `:${hit[1]}` : '')} data-line={l.medicineId ?? l.key} className={`pop-in border-t border-line/70 py-2.5 first:border-t-0 first:pt-0 ${n === 0 && !done ? 'opacity-60' : ''}`}>
                  <div className="flex items-center gap-2.5">
                    <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full ${tileOf(l.med?.form)}`}><Icon name="pill" className="h-3.5 w-3.5 text-ink" /></span>
                    <span className="min-w-0 flex-1"><b className="block text-[13.5px] leading-snug">{l.name}{l.rxItemId && <span className="ml-1.5 rounded-full bg-clay-soft px-1.5 py-px align-middle text-[10.5px] font-bold text-clay-ink">Prescribed</span>}
                        {n > 0 && b && nearExpiry(b.expiry) && <span className="ml-1.5 rounded-full bg-amber-soft px-1.5 py-px align-middle text-[10.5px] font-bold text-amber" title="This batch expires within 60 days">Expires {exp(b.expiry)}</span>}</b>
                      <small className={`block truncate text-[11.5px] ${l.medicineId && l.onHand === 0 ? 'text-rose' : 'text-muted'}`}>{!l.medicineId ? 'not in the medicine list' : l.onHand === 0 ? (can(perms, 'stock.read') ? <Link className="underline" to={`/inventory?tab=stock&item=${l.medicineId}`}>out of stock · see in Inventory</Link> : 'out of stock') : l.rxItemId ? [l.doctorQty && ['tab', 'cap'].includes(l.med?.form ?? '') ? `Doctor: ${l.doctorQty} = ${l.prescribed} ${packLabel(l.med, l.prescribed ?? 1)}` : `${l.prescribed} ${packLabel(l.med, l.prescribed ?? 1)} prescribed`, (l.issued ?? 0) > 0 ? `${l.issued} issued before` : null, b ? `${b.batchNo} · exp ${exp(b.expiry)}` : null, l.how].filter(Boolean).join(' · ') : [money(b?.mrpPaise ?? l.mrpPaise) + ' each', b ? `${b.batchNo} · exp ${exp(b.expiry)}` : null].filter(Boolean).join(' · ')}</small></span>
                    {done ? <Chip tone="sage">issued</Chip> : <span className="flex shrink-0 items-center rounded-full bg-surface-2 p-0.5 shadow-[var(--ring)]">
                      <button type="button" className="grid h-7 w-7 place-items-center rounded-full text-[16px] font-bold text-ink-2 hover:bg-paper-2 disabled:opacity-40" aria-label={`One less ${l.name}`} disabled={!l.medicineId || !canBill || n === 0} onClick={() => step(l, -1)}>−</button>
                      <NumInput aria-label={`Issue ${l.name}`} className={`w-8 bg-transparent text-center text-[13.5px] font-semibold outline-none ${n > l.onHand ? 'text-rose' : ''}`} max={999} disabled={!l.medicineId || !canBill} value={l.qty} onChange={(e) => set(l.key, { qty: e.target.value })} />
                      <button type="button" className="grid h-7 w-7 place-items-center rounded-full bg-clay text-[16px] font-bold text-white hover:bg-clay-2 disabled:opacity-40" aria-label={`One more ${l.name}`} disabled={!l.medicineId || !canBill || n >= l.onHand} onClick={() => step(l, 1)}>+</button>
                    </span>}
                    <b className="w-[70px] shrink-0 text-right text-[13.5px]">{n > 0 ? money(lineAmount(l)) : '—'}</b>
                    {!l.rxItemId ? <button type="button" className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-muted hover:bg-ink/6 hover:text-ink" aria-label={`Remove ${l.name}`} onClick={() => setBill((bb) => ({ ...bb, lines: bb.lines.filter((x) => x.key !== l.key) }))}><Icon name="x" className="h-3.5 w-3.5" /></button> : <span className="w-7 shrink-0" />}
                  </div>
                  {overBy(l) > 0 && <div className="mt-1.5 flex flex-wrap items-center gap-2 rounded-[10px] bg-amber-soft py-1.5 pl-[42px] pr-2">
                    <span className="text-[11.5px] font-semibold text-[#6E4D10]">{overBy(l)} more than prescribed. Reason?</span>
                    <input aria-label={`Why more ${l.name} than prescribed`} className={`input !min-h-0 !w-auto flex-1 !py-1 !text-xs ${(l.overReason ?? '').trim().length < 3 ? '!border-amber' : ''}`} maxLength={120} placeholder="e.g. doctor phoned, course extended" value={l.overReason ?? ''} onChange={(e) => set(l.key, { overReason: e.target.value })} />
                  </div>}
                  {(l.batches.length > 1 && n > 0) || (l.rxItemId && !done && short > 0) ? <div className="mt-1.5 flex flex-wrap items-center gap-2 pl-[42px]">
                    {l.batches.length > 1 && n > 0 && <select aria-label={`Batch for ${l.name}`} className="input !min-h-0 !w-auto !py-1 !text-xs" value={l.batchId} onChange={(e) => set(l.key, { batchId: e.target.value })}>{l.batches.map((x) => <option key={x.id} value={x.id}>{x.batchNo} · exp {exp(x.expiry)}{nearExpiry(x.expiry) ? ' (soon)' : ''} · {x.qty} left</option>)}</select>}
                    {l.rxItemId && !done && short > 0 && <><span className="text-[11.5px] text-muted">{n === 0 ? 'Not given' : `${short} not given`}</span>
                      <select aria-label={`Reason for ${l.name}`} className="input !min-h-0 !w-auto !py-1 !text-xs" value={l.reason} onChange={(e) => set(l.key, { reason: e.target.value })}><option value="">Reason (optional)</option>{REASONS.map((r) => <option key={r}>{r}</option>)}</select></>}
                  </div> : null}
                </div>);
            })}
          </div>

          {lines.length > 0 && canBill && <>
            <div className="mt-3 space-y-1.5 border-t border-line pt-3 text-[13.5px]">
              <div className="flex justify-between"><span className="text-muted">{rx ? `${rxLines.filter((l) => Number(l.qty) > 0).length} of ${rxLines.length} prescribed · ` : ''}{units} {units === 1 ? 'item' : 'items'}</span><span>₹{rupees2(gross)}</span></div>
              <div className="flex justify-between text-muted"><span>GST included</span><span>₹{rupees2(gst)}</span></div>
              <div className="flex items-center justify-between gap-3"><span className="text-muted">Discount {capBp < 10000 && <span className="text-[11.5px]">(above {capBp / 100}% needs the owner)</span>}</span><MoneyInput label="Discount" className={`!min-h-[34px] !w-28 !py-1 ${disc * 10000 > gross * capBp ? '!border-rose' : ''}`} value={discount} onChange={setDiscount} /></div>
              <div className="flex items-baseline justify-between pt-1.5"><span className="text-[15px] font-semibold">To pay</span><span key={total} className="bump text-[26px] font-semibold tracking-tight">{money(total)}</span></div>
              {rxLines.some((l) => (l.left ?? 0) - (Number(l.qty) || 0) > 0 && Number(l.qty) > 0) && <div className="text-[11.5px] text-muted">The patient can come back for the rest within 30 days, or buy it outside.</div>}
            </div>
            {problem && issuing.length > 0 && <div className="mt-2 text-xs text-rose">{problem}</div>}
            <button type="button" className="btn btn-primary mt-3 w-full !min-h-[52px] text-[15px]" disabled={!!problem} onClick={() => setPaying(true)}><Icon name="rupee" />Take payment{total > 0 ? ` · ${money(total)}` : ''}</button>
          </>}
          {rx && canBill && rx.status !== 'issued' && rx.status !== 'part' && <button type="button" className="btn btn-ghost mt-2 w-full" disabled={nothing.isPending} onClick={async () => { const a = await ask({ title: 'Buying elsewhere?', body: 'The prescription stays on the patient record; it just leaves the counter list.', confirmLabel: 'Not from us', field: { label: 'Reason (optional)', maxLength: 80 } }); if (a) nothing.mutate(a.value); }}>Not buying here</button>}
          {rx && canBill && rx.status === 'part' && <button type="button" className="btn btn-ghost mt-2 w-full" disabled={outside.isPending} onClick={async () => { const a = await ask({ title: 'Rest bought outside?', body: 'What was issued here stays on the bills. The prescription leaves the earlier list.', confirmLabel: 'Rest bought outside', field: { label: 'Reason (optional)', maxLength: 80 } }); if (a) outside.mutate(a.value); }}>Rest bought outside</button>}
          {over && lines.length > 0 && <div className="pointer-events-none absolute inset-0 grid place-items-center rounded-[24px] bg-clay-soft/85 text-[15px] font-semibold text-clay-ink anim-fade-in">Drop to start this patient's bill</div>}
        </aside>
      </div>

      {paying && <PayDialog total={total} patient={who} saleKey={billKey} upiId={cfg?.tenant?.settings?.upiId ?? cfg?.tenant?.settings?.pharmacy?.upiId ?? null} payee={cfg?.tenant?.name ?? ''} onClose={() => setPaying(false)} build={() => ({
        ...(who.id ? { patientId: who.id } : who.walkIn ? { walkIn: { fullName: who.fullName?.trim() || null, phone: who.phone || null } } : { newPatient: { fullName: who.fullName.trim(), phone: who.phone, ageYears: who.ageYears ? Number(who.ageYears) : undefined } }),
        encounterId: rx?.encounterId, discountPaise: disc,
        items: issuing.map((l) => ({ medicineId: l.medicineId!, qty: Number(l.qty), batchId: l.batchId || undefined, prescriptionItemId: l.rxItemId, overReason: overBy(l) > 0 ? l.overReason?.trim() : undefined })),
        notIssued: rxLines.filter((l) => (l.left ?? 0) > (Number(l.qty) || 0)).map((l) => ({ prescriptionItemId: l.rxItemId!, reason: l.reason || null })),
      })} onDone={(s) => { setPaying(false); setSale({ ...s, rows: issuing.map((l) => ({ name: l.name, qty: Number(l.qty), amount: lineAmount(l), rx: !!l.rxItemId })), gross, disc, total, who: who?.fullName || (who?.walkIn ? 'Walk-in' : '') }); }} />}
      {sale && <Receipt sale={sale} clinic={cfg?.tenant?.name ?? ''} onNew={() => { setSale(null); reset(); }} onVoid={() => {
        // the bill was never cleared, so it is simply there again, with a fresh key (the old one belongs to the undone sale)
        setSale(null); setBillKey(newKey()); if (!who?.id && !who?.walkIn) setBill((b) => ({ ...b, who: { ...b.who, id: sale.patientId } }));
        ['pharmacy', 'stock', 'reports', 'patients'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
        toast('Bill undone · the items are back on the bill');
      }} />}
    </div>
  );
}

/** Payment taken: a stamp lands, the receipt reads like paper; Print or start the next sale. */
const VOID_REASONS = ['Wrong patient', 'Wrong item', 'Wrong quantity', 'Patient changed their mind'];
const PAID_BY: Record<string, string> = { cash: 'cash', upi: 'UPI', card: 'card', split: 'the same split' };
/** Undo a bill just taken: a red check with the amount, how the money goes back, and a reason. */
function VoidDialog({ sale, onClose, onDone }: { sale: any; onClose: () => void; onDone: () => void }) {
  const [why, setWhy] = useState(''); const [other, setOther] = useState('');
  const reason = why === 'Other' ? other.trim() : why;
  const voiding = useMutation({ mutationFn: () => post(`/pharmacy/sale/${sale.id}/void`, { reason }), onSuccess: onDone, onError: (e) => toast(errText(e), 'err') });
  return (
    <Modal title={`Cancel bill ${sale.invoiceNo} for ${money(sale.totalPaise ?? sale.total)}?`} subtitle="Stock goes back, money must be returned." onClose={onClose} width="max-w-md">
      <div className="space-y-3 text-[13.5px]">
        <div className="rounded-[12px] bg-rose-soft px-3 py-2 text-rose">Give {money(sale.totalPaise ?? sale.total)} back by {PAID_BY[sale.method] ?? sale.method} before the patient leaves.</div>
        <div><span className="label">Why?</span><div className="flex flex-wrap gap-1.5">{[...VOID_REASONS, 'Other'].map((r) => <button key={r} type="button" aria-pressed={why === r} className={`toggle-opt ${why === r ? 'on' : ''}`} onClick={() => setWhy(r)}>{r}</button>)}</div></div>
        {why === 'Other' && <input className="input" aria-label="Reason" maxLength={160} placeholder="Say why" value={other} onChange={(e) => setOther(e.target.value)} />}
      </div>
      <div className="modal-foot"><button type="button" className="btn btn-ghost" onClick={onClose}>Keep the bill</button><button type="button" className="btn btn-primary !bg-rose" disabled={reason.length < 3 || voiding.isPending} onClick={() => voiding.mutate()}><Icon name="undo" />Undo this bill</button></div>
    </Modal>
  );
}

function Receipt({ sale, clinic, onNew, onVoid }: { sale: any; clinic: string; onNew: () => void; onVoid: () => void }) {
  const [undo, setUndo] = useState(false);
  if (undo) return <VoidDialog sale={sale} onClose={() => setUndo(false)} onDone={onVoid} />;
  return (
    <Modal title="Payment taken" subtitle={`${sale.invoiceNo} · ${new Date().toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}`} onClose={onNew} width="max-w-md">
      <div className="stamp mx-auto mb-4 grid h-14 w-14 place-items-center rounded-full bg-clay text-white shadow-[0_12px_26px_-12px_var(--color-clay)]"><Icon name="check" className="h-7 w-7" /></div>
      <div className="pop-in rounded-[18px] bg-surface-2 p-4 text-[13px] shadow-[var(--ring)]">
        <div className="text-center"><b className="block text-[15px]">{clinic}</b><small className="text-muted">Pharmacy</small></div>
        <div className="my-3 border-t border-dashed border-line-2" />
        {sale.rows.map((r: any, i: number) => <div key={i} className="flex justify-between gap-3 py-1"><span className="min-w-0"><span className="block truncate">{r.name}{r.rx ? <span className="ml-1.5 text-[11px] text-muted">Prescribed</span> : null}</span><small className="text-muted">{r.qty} × {money(Math.round(r.amount / r.qty))}</small></span><span className="shrink-0">{money(r.amount)}</span></div>)}
        <div className="my-3 border-t border-dashed border-line-2" />
        <div className="flex justify-between text-muted"><span>Subtotal</span><span>{money(sale.gross)}</span></div>
        {sale.disc > 0 && <div className="flex justify-between text-muted"><span>Discount</span><span>−{money(sale.disc)}</span></div>}
        <div className="mt-1 flex justify-between text-[17px] font-semibold"><span>Total</span><span>{money(sale.total)}</span></div>
        {sale.who && <div className="mt-3 text-center text-[12px] text-muted">Customer: {sale.who}</div>}
      </div>
      <div className="modal-foot"><button type="button" className="btn btn-ghost mr-auto" title="Wrong patient or item? Undo this bill: stock goes back and the money is refunded" onClick={() => setUndo(true)}><Icon name="undo" />Undo this bill</button><button type="button" className="btn" onClick={() => printSale(sale.id)}><Icon name="print" />Print</button><button type="button" className="btn btn-primary" onClick={onNew}>New sale</button></div>
    </Modal>
  );
}

/**
 * The bill's customer when there is no prescription. By default a walk-in with no record (name and phone optional,
 * kept on the bill only); or one of our patients; or a new patient record when one is wanted.
 */
function WalkInPatient({ who, setWho }: { who: any; setWho: (p: any) => void }) {
  // starts from the bill's customer (a bill set aside comes back as it was)
  const [mode, setMode] = useState<'walkin' | 'existing' | 'new'>(who?.id ? 'existing' : who && !who.walkIn ? 'new' : 'walkin'); const [find, setFind] = useState('');
  const [np, setNp] = useState({ fullName: who && !who.walkIn && !who.id ? who.fullName ?? '' : '', phone: who && !who.walkIn && !who.id ? who.phone ?? '' : '', ageYears: who?.ageYears && !who.id ? String(who.ageYears) : '' });
  const [wk, setWk] = useState({ fullName: who?.walkIn ? who.fullName ?? '' : '', phone: who?.walkIn ? who.phone ?? '' : '' });
  const pts = useQuery({ queryKey: ['palette', find], queryFn: () => get(`/patients?q=${encodeURIComponent(find)}`), enabled: mode === 'existing' && !who?.id && find.trim().length >= 2 });
  useEffect(() => { if (mode === 'new') setWho(np.fullName.trim().length >= 2 && (!np.phone || /^[0-9]{10}$/.test(np.phone)) ? { ...np, phone: np.phone || null } : null); }, [np, mode]);
  useEffect(() => { if (mode === 'walkin') setWho(!wk.phone || /^[0-9]{10}$/.test(wk.phone) ? { walkIn: true, fullName: wk.fullName, phone: wk.phone || null } : null); }, [wk, mode]);
  if (who?.id) return <div className="mt-3 flex items-center gap-2.5 rounded-[16px] bg-surface-2 p-2.5 shadow-[var(--ring)]"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-tile-3 text-[12px] font-bold">{initials(who.fullName)}</span><span className="min-w-0 flex-1"><b className="block truncate text-[13.5px]">{who.fullName}</b><small className="text-[12px] text-muted">{[who.patientNo, [who.ageYears, who.sex].filter(Boolean).join(' '), who.phone ?? 'no phone'].filter(Boolean).join(' · ')}</small></span><button type="button" className="btn btn-sm" onClick={() => { setWho(null); setMode('existing'); }}>Change</button></div>;
  return (
    <div className="mt-3 space-y-2">
      <div className="flex gap-1.5">{([['walkin', 'Walk-in (no record)'], ['existing', 'Our patient'], ['new', 'New patient']] as const).map(([k, l]) => <button key={k} type="button" aria-pressed={mode === k} className={`toggle-opt flex-1 justify-center ${mode === k ? 'on' : ''}`} onClick={() => { setMode(k); setWho(null); }}>{l}</button>)}</div>
      {mode === 'walkin' ? <div className="grid grid-cols-2 gap-2">
        <input className="input" aria-label="Name (optional)" placeholder="Name (optional)" maxLength={100} value={wk.fullName} onChange={(e) => setWk({ ...wk, fullName: e.target.value })} />
        <input className={`input ${wk.phone && !/^[0-9]{10}$/.test(wk.phone) ? '!border-rose' : ''}`} aria-label="Phone (optional)" inputMode="numeric" maxLength={10} placeholder="Phone (optional)" value={wk.phone} onChange={(e) => setWk({ ...wk, phone: e.target.value.replace(/\D/g, '') })} />
      </div> : mode === 'existing' ? <div>
        <input className="input" aria-label="Find patient" placeholder="Name, phone or patient ID" value={find} onChange={(e) => setFind(e.target.value)} />
        {(pts.data ?? []).slice(0, 5).map((p: any) => <button key={p.id} type="button" className="mt-1 flex w-full items-center gap-2 rounded-[12px] px-3 py-2 text-left text-sm hover:bg-ink/5" onClick={() => setWho(p)}><span className="flex-1 truncate">{p.fullName}</span><span className="text-xs text-muted">{p.patientNo} · {p.phone ?? ''}</span></button>)}
      </div> : <div className="grid grid-cols-[1fr_76px] gap-2">
        <input className="input col-span-2" aria-label="Customer name" placeholder="Full name" value={np.fullName} onChange={(e) => setNp({ ...np, fullName: e.target.value })} />
        <input className={`input ${np.phone && !/^[0-9]{10}$/.test(np.phone) ? '!border-rose' : ''}`} aria-label="Phone" inputMode="numeric" maxLength={10} placeholder="Phone (optional)" value={np.phone} onChange={(e) => setNp({ ...np, phone: e.target.value.replace(/\D/g, '') })} />
        <input className="input" aria-label="Age" inputMode="numeric" maxLength={3} placeholder="Age" value={np.ageYears} onChange={(e) => setNp({ ...np, ageYears: e.target.value.replace(/\D/g, '') })} />
      </div>}
    </div>
  );
}

/** Payment: cash, UPI, card or split. Cash fills the remainder and shows the change; the receipt prints and/or goes on WhatsApp. */
function PayDialog({ total, patient, saleKey, upiId, payee, build, onClose, onDone }: { total: number; patient: any; saleKey: string; upiId: string | null; payee: string; build: () => any; onClose: () => void; onDone: (sale: any) => void }) {
  const [mode, setMode] = useState<'cash' | 'upi' | 'card' | 'split'>('cash');
  const [upi, setUpi] = useState(''); const [upiRef, setUpiRef] = useState(''); const [card, setCard] = useState(''); const [cardRef, setCardRef] = useState(''); const [received, setReceived] = useState('');
  const [print, setPrint] = useState(() => pref('ph.print', true)); const [wa, setWa] = useState(() => pref('ph.wa', true) && !!patient?.phone);
  const [tried, setTried] = useState(false);
  const upiAmt = mode === 'upi' ? total : mode === 'split' ? toPaise(upi) : 0; const cardAmt = mode === 'card' ? total : mode === 'split' ? toPaise(card) : 0;
  const cash = mode === 'cash' ? total : mode === 'split' ? total - upiAmt - cardAmt : 0;
  const got = toPaise(received); const change = received ? got - cash : 0;
  // the UPI transaction number is optional: if typed, it must be the full 12 digits
  const problem = cash < 0 ? 'UPI and card add up to more than the bill.' : upiAmt > 0 && upiRef.length > 0 && upiRef.length !== 12 ? 'The UPI transaction number has 12 digits (or leave it empty).' : cardAmt > 0 && cardRef.trim().length < 4 ? 'Enter the approval code on the card slip.'
    : mode === 'split' && upiAmt + cardAmt === 0 ? 'Enter the UPI or card part of the split.' : received && got < cash ? 'Cash received is less than the cash part.' : '';
  const [qr, setQr] = useState('');
  useEffect(() => {
    if (!upiId || upiAmt <= 0) { setQr(''); return; }
    let live = true; // the amount is filled in for the patient; qrcode is already a dependency of the app
    import('qrcode').then((Q) => ((Q as any).default ?? Q).toDataURL(`upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(payee)}&am=${(upiAmt / 100).toFixed(2)}&cu=INR`, { margin: 1, width: 180 })).then((u) => { if (live) setQr(u); }, () => { if (live) setQr(''); });
    return () => { live = false; };
  }, [upiId, upiAmt, payee]);
  const save = useMutation({
    mutationFn: () => post('/pharmacy/sale', { ...build(), whatsapp: wa, idempotencyKey: saleKey,
      payments: [...(upiAmt > 0 ? [{ method: 'upi', amountPaise: upiAmt, reference: upiRef.trim() || undefined }] : []), ...(cardAmt > 0 ? [{ method: 'card', amountPaise: cardAmt, reference: cardRef.trim() }] : []), ...(cash > 0 ? [{ method: 'cash', amountPaise: cash }] : [])],
      receivedPaise: cash > 0 && received ? got : undefined }),
    onSuccess: (s: any) => {
      setPref('ph.print', print); setPref('ph.wa', wa);
      toast(`Saved ${s.invoiceNo} · ${money(s.totalPaise)}${change > 0 ? ` · give change ${money(change)}` : ''}${s.whatsapp === 'opted_out' ? `. Receipt ${NO_WHATSAPP[0].toLowerCase()}${NO_WHATSAPP.slice(1)}` : ''}`, s.whatsapp === 'opted_out' && !print ? 'info' : 'ok', s.whatsapp === 'opted_out' && !print ? { label: 'Print', run: () => printSale(s.id) } : undefined);
      ['pharmacy', 'stock', 'reports', 'patients'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      if (print) printSale(s.id);
      onDone(s);
    },
    onError: (e) => toast(phErr(e), 'err'),
  });
  return (
    <Modal title={`Take payment · ${money(total)}`} subtitle={patient?.fullName || (patient?.walkIn ? 'Walk-in' : undefined)} onClose={onClose} width="max-w-2xl">
      <div className="space-y-4">
        <div className="flex gap-1.5">{(['cash', 'upi', 'card', 'split'] as const).map((m) => <button key={m} type="button" aria-pressed={mode === m} className={`toggle-opt flex-1 justify-center ${mode === m ? 'on' : ''}`} onClick={() => setMode(m)}>{m === 'upi' ? 'UPI' : m[0].toUpperCase() + m.slice(1)}</button>)}</div>
        {upiAmt > 0 && upiId && <div className="flex flex-wrap items-center gap-4 rounded-[16px] bg-surface-2 p-3 shadow-[var(--ring)]">
          {qr ? <img src={qr} alt={`UPI QR for ${money(upiAmt)}`} className="h-[150px] w-[150px] rounded-[10px] bg-white" /> : null}
          <div><div className="text-[12.5px] text-muted">Scan to pay, amount filled in</div><div className="text-[28px] font-semibold tracking-tight">{money(upiAmt)}</div><div className="text-[15px] font-semibold">{upiId}</div></div>
        </div>}
        {(mode === 'upi' || mode === 'split') && <div className="grid gap-2 sm:grid-cols-2">
          {mode === 'split' && <label><span className="label">UPI amount</span><MoneyInput label="UPI amount" value={upi} onChange={setUpi} /></label>}
          <label className={mode === 'upi' ? 'sm:col-span-2' : ''}><span className="label">UPI transaction no. (optional, on the patient's phone)</span><input className={`input ${tried && upiAmt > 0 && upiRef.length > 0 && upiRef.length !== 12 ? '!border-rose' : ''}`} inputMode="numeric" value={upiRef} onChange={(e) => setUpiRef(e.target.value.replace(/\D/g, '').slice(0, 12))} placeholder="12 digits" /></label></div>}
        {(mode === 'card' || mode === 'split') && <div className="grid gap-2 sm:grid-cols-2">
          {mode === 'split' && <label><span className="label">Card amount</span><MoneyInput label="Card amount" value={card} onChange={setCard} /></label>}
          <label className={mode === 'card' ? 'sm:col-span-2' : ''}><span className="label">Approval code on the card slip</span><input className={`input ${tried && cardAmt > 0 && cardRef.trim().length < 4 ? '!border-rose' : ''}`} value={cardRef} onChange={(e) => setCardRef(e.target.value)} /></label></div>}
        {cash > 0 && <div className="grid gap-2 sm:grid-cols-3 sm:items-end">
          <div><span className="label">Cash part</span><div className="input !bg-white/40">{money(cash)}</div></div>
          <label><span className="label">Cash received</span><MoneyInput label="Cash received" value={received} onChange={setReceived} placeholder={String(cash / 100)} /></label>
          <div><span className="label">Change to give</span><div className={`input !bg-white/40 font-semibold ${change < 0 ? 'text-rose' : ''}`}>{received ? (change >= 0 ? money(change) : 'Short') : '—'}</div></div>
        </div>}
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2"><input type="checkbox" className="accent-clay h-4 w-4" checked={print} onChange={(e) => setPrint(e.target.checked)} />Print receipt</label>
          <label className={`flex items-center gap-2 ${patient?.phone ? '' : 'opacity-50'}`}><input type="checkbox" className="accent-clay h-4 w-4" disabled={!patient?.phone} checked={wa} onChange={(e) => setWa(e.target.checked)} />WhatsApp to {patient?.phone ?? 'no phone'}</label>
        </div>
        {tried && problem && <div className="text-sm text-rose">{problem}</div>}
      </div>
      <div className="modal-foot"><button type="button" className="btn btn-ghost" onClick={onClose}>Back to items</button><button type="button" className="btn btn-primary" disabled={save.isPending} onClick={() => { setTried(true); if (!problem) save.mutate(); }}><Icon name="check" />Paid · Save bill</button></div>
    </Modal>
  );
}

/* ---------------- Bills ---------------- */

const minusDays = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() - n); return x.toISOString().slice(0, 10); };

const RANGE: FilterDef<any> = { key: 'range', label: 'Dates', icon: 'calendar', initial: 'today', options: [{ value: 'today', label: 'Today' }, { value: 'yesterday', label: 'Yesterday' }, { value: 'week', label: 'Last 7 days' }, { value: 'custom', label: 'Pick dates' }] };
const PAID: FilterDef<any> = { key: 'paid', label: 'Paid by', icon: 'wallet', options: [{ value: '', label: 'Any' }, { value: 'cash', label: 'Cash' }, { value: 'upi', label: 'UPI' }, { value: 'card', label: 'Card' }, { value: 'split', label: 'Split' }], test: (r, v) => !v || r.method === v };

function Bills({ sel, pick, onIssue }: { sel: string | null; pick: (id: string | null) => void; onIssue: (rx: string) => void }) {
  const [sp, setSp] = useSearchParams();
  const range = filterValue(sp, RANGE); const from = sp.get('from') ?? today(), to = sp.get('to') ?? today();
  const [q] = usePageSearch('Find a bill: number, patient or phone');
  const span = range === 'today' ? [today(), today()] : range === 'yesterday' ? [minusDays(today(), 1), minusDays(today(), 1)] : range === 'week' ? [minusDays(today(), 6), today()] : [from, to];
  const bad = span[0] > span[1];
  const setDate = (k: 'from' | 'to', v: string) => v && setSp((p) => { const n = new URLSearchParams(p); n.set(k, v); n.delete('p'); return n; }, { replace: true });
  const list = useQuery({ queryKey: ['pharmacy', 'bills', span[0], span[1], q], queryFn: () => get(`/pharmacy/bills?from=${span[0]}&to=${span[1]}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`), enabled: !bad });
  const t = list.data?.totals; const rows: any[] = list.data?.rows ?? [];
  const columns: Col<any>[] = [
    { key: 'bill', label: 'Bill', fixed: true, sort: (r) => r.invoiceNo, csv: (r) => r.invoiceNo, cell: (r) => <span className="whitespace-nowrap font-bold">{r.invoiceNo}</span> },
    { key: 'time', label: 'Time', sort: (r) => r.at, csv: (r) => r.at, cell: (r) => <span className="whitespace-nowrap text-muted">{range === 'today' ? fmtTime(r.at) : `${fmtDate(r.at)} ${fmtTime(r.at)}`}</span> },
    { key: 'patient', label: 'Patient', sort: (r) => r.patient.fullName.toLowerCase(), csv: (r) => r.patient.fullName, cell: (r) => <div><div className="font-semibold">{r.patient.fullName}</div><div className="text-[12px] text-muted">{r.encounterId ? `Rx ${r.doctor ?? ''}` : 'Walk-in · no prescription'}</div></div> },
    { key: 'items', label: 'Items', sort: (r) => r.items, csv: (r) => r.items, cell: (r) => <span className="text-[13px]">{r.items} item{r.items === 1 ? '' : 's'}{r.balance.length > 0 && <span className="ml-1.5 text-[12px] text-muted">· {r.balance.map((b: any) => b.left).reduce((a: number, b: number) => a + b, 0)} left on Rx</span>}{r.notIssued > 0 && <span className="ml-1.5 text-[12px] text-muted">· {r.notIssued} not given</span>}</span> },
    { key: 'amount', label: 'Amount', align: 'right', sort: (r) => r.totalPaise, csv: (r) => (r.totalPaise / 100).toFixed(2), cell: (r) => <div className="whitespace-nowrap font-semibold">{money(r.totalPaise)}{r.refundPaise > 0 && <div className="text-[12px] text-rose">− {money(r.refundPaise)}</div>}</div> },
    { key: 'paid', label: 'Paid by', sort: (r) => r.method, csv: (r) => r.method, cell: (r) => <span className="text-[12px] font-semibold uppercase text-muted">{r.method === 'split' ? r.payments.map((p: any) => p.method).join(' + ') : r.method}</span> },
  ];
  return (
    <div className="space-y-4">
      {t && <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {[['Net sales', money(t.total - t.refunds), `${t.count} bills${t.returns ? ` · ${t.returns} return${t.returns === 1 ? '' : 's'}` : ''}`], ['Cash in drawer should be', money(t.cash ?? 0), t.refunds ? `after ${money(t.refunds)} refunds` : 'cash payments'], ['UPI', money(t.upi ?? 0), ''], ['Card', money(t.card ?? 0), ''],
          ['Bought elsewhere or not at all', `${list.data.rx.notBought} of ${list.data.rx.total}`, 'prescriptions today · not a task, for the doctor to know']].map(([l, v, s]) => <div key={l} className="card !p-4"><div className="text-[12px] font-medium text-muted">{l}</div><div className="text-[24px] font-semibold tracking-tight mt-1.5">{v}</div>{s && <div className="text-xs text-muted mt-0.5">{s}</div>}</div>)}
      </div>}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] lg:items-start">
        <div className={sel ? 'hidden lg:block' : ''}>
          <DataTable id="pharmacy-bills" exportName={`pharmacy-bills-${span[0]}-to-${span[1]}`} rows={rows} rowKey={(r) => r.id} columns={columns}
            loading={list.isLoading} onRow={(r) => pick(r.id)} selected={sel} sort={{ key: 'time', dir: -1 }}
            search={{ placeholder: 'Find a bill: number, patient or phone' }} filters={[RANGE, PAID]}
            empty={{ title: bad ? 'Check the dates' : 'No bills in this range', hint: bad ? '“From” is after “to”.' : undefined }}
            toolbar={range === 'custom' && <span className="inline-flex items-center gap-1.5 text-[12.5px] text-muted">
              <input type="date" aria-label="From" className={`dt-select ${bad ? '!border-rose' : ''}`} value={from} onChange={(e) => setDate('from', e.target.value)} />to
              <input type="date" aria-label="To" className={`dt-select ${bad ? '!border-rose' : ''}`} value={to} onChange={(e) => setDate('to', e.target.value)} /></span>} />
        </div>
        <div className={sel ? '' : 'hidden lg:block'}>{sel ? <BillDetail key={sel} id={sel} onClose={() => pick(null)} onIssue={onIssue} /> : <div className="card text-sm text-muted text-center py-10">Pick a bill to reprint it, issue the rest of a prescription, or take items back.</div>}</div>
      </div>
    </div>
  );
}

function BillDetail({ id, onClose, onIssue }: { id: string; onClose: () => void; onIssue: (rx: string) => void }) {
  const { perms } = useOutletContext<any>();
  const q = useQuery({ queryKey: ['pharmacy', 'sale', id], queryFn: () => get(`/pharmacy/sale/${id}`) });
  const s = q.data;
  const [qty, setQty] = useState<Record<number, string>>({}); const [reason, setReason] = useState(''); const [method, setMethod] = useState(''); const [ref, setRef] = useState('');
  const [sealed, setSealed] = useState<Record<number, boolean>>({}); // per line: sealed, can be sold again? (default No)
  const back = useMemo(() => (s?.items ?? []).map((l: any, i: number) => l.qty - (s.returns ?? []).reduce((n: number, r: any) => n + r.lines.filter((x: any) => x.line === i).reduce((k: number, x: any) => k + x.qty, 0), 0)), [s]);
  const lines = Object.entries(qty).map(([k, v]) => ({ line: Number(k), qty: Number(v) || 0, restock: !!sealed[Number(k)] })).filter((l) => l.qty > 0);
  const refund = s ? lines.reduce((n, l) => n + Math.round((s.items[l.line].amountPaise * l.qty * s.totalPaise) / (s.items[l.line].qty * s.grossPaise)), 0) : 0;
  // the money goes back the way it came; a split bill starts from its first payment
  const paidBy: string = s ? (s.method === 'split' ? s.payments?.[0]?.method ?? 'cash' : s.method) : 'cash';
  const m = method || paidBy;
  const done = () => { setQty({}); setSealed({}); setReason(''); setRef(''); ['pharmacy', 'stock', 'reports'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); };
  const ret = useMutation({ mutationFn: () => post(`/pharmacy/sale/${id}/return`, { lines, reason: reason.trim(), method: m, reference: m === 'cash' ? undefined : ref.trim() }),
    onSuccess: (r: any) => { toast(`Refund slip ${r.creditNoteNo} · refund ${money(r.refundPaise)}`); done(); }, onError: (e) => toast(errText(e), 'err') });
  const cancel = useMutation({ mutationFn: (why: string) => post(`/pharmacy/sale/${id}/cancel`, { reason: why, method: m, reference: m === 'cash' ? undefined : ref.trim() || undefined }),
    onSuccess: (r: any) => { toast(`Bill cancelled · refund slip ${r.creditNoteNo} · refund ${money(r.refundPaise)}`); done(); }, onError: (e) => toast(errText(e), 'err') });
  if (q.isLoading || !s) return <div className="card"><Skeleton rows={4} /></div>;
  const tooMuch = lines.some((l) => l.qty > back[l.line]);
  const problem = !lines.length ? 'Enter how many come back.' : tooMuch ? 'More than was sold on this bill.' : reason.trim().length < 3 ? 'Give a reason.' : m !== 'cash' && ref.trim().length < 4 ? 'Enter the refund reference.' : '';
  return (
    <div className="card space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn btn-ghost btn-icon lg:hidden" aria-label="Back to bills" onClick={onClose}><Icon name="x" /></button>
        <b className="text-lg mr-auto">{s.invoiceNo} · {s.patient.fullName}</b>
        <button className="btn btn-sm" onClick={() => printSale(s.id)}><Icon name="print" />Reprint</button>
        {s.encounterId && s.notIssued?.length > 0 && can(perms, 'pharmacy.bill') && <button className="btn btn-sm" onClick={() => onIssue(s.encounterId)}>Issue the rest</button>}
      </div>
      <div className="text-xs text-muted">{new Date(s.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' })} · {s.doctor ? `Rx ${s.doctor}` : 'Walk-in'} · {s.payments.map((p: any) => `${p.method.toUpperCase()} ${money(p.amountPaise)}${p.reference ? ` (${p.reference})` : ''}`).join(' + ')}</div>
      {s.returns.length > 0 && <div className="space-y-1">{s.returns.map((r: any) => <div key={r.creditNoteNo} className="text-xs rounded-xl bg-rose-soft/60 px-3 py-2"><b>{r.creditNoteNo}</b> · refund {money(r.refundPaise)} by {r.method.toUpperCase()} · {r.reason} · {r.by}</div>)}</div>}
      {can(perms, 'pharmacy.return') && back.some((n: number) => n > 0) && <>
        <div className="label !mb-0">Return items</div>
        <table className="table"><thead><tr><th className="!pl-0">Item · batch</th><th className="!text-right">Sold</th><th className="!text-right">Return</th><th>Sealed, can be sold again?</th><th className="!text-right !pr-0">Refund</th></tr></thead>
          <tbody>{s.items.map((l: any, i: number) => back[i] > 0 && (
            <tr key={i}><td className="!pl-0"><div className="font-medium">{l.name}</div><div className="text-xs text-muted">{l.batchNo ?? '—'}{l.expiry ? ` · ${exp(l.expiry)}` : ''}</div></td><td className="text-right">{back[i]}{back[i] < l.qty ? <span className="text-xs text-muted"> of {l.qty}</span> : ''}</td>
              <td className="text-right"><NumInput aria-label={`Return ${l.name}`} className={`input !w-16 !px-2 text-right ${Number(qty[i]) > back[i] ? '!border-rose' : ''}`} max={999} value={qty[i] ?? ''} placeholder="0" onChange={(e) => setQty({ ...qty, [i]: e.target.value })} /></td>
              <td><select aria-label={`Sealed, can ${l.name} be sold again?`} className="input !min-h-0 !w-auto !py-1 !text-xs" value={sealed[i] ? 'yes' : 'no'} onChange={(e) => setSealed({ ...sealed, [i]: e.target.value === 'yes' })}><option value="no">No, write it off</option><option value="yes">Yes, sealed: back on the shelf</option></select></td>
              <td className="text-right !pr-0">{Number(qty[i]) > 0 ? money(Math.round((l.amountPaise * Number(qty[i]) * s.totalPaise) / (l.qty * s.grossPaise))) : '—'}</td></tr>))}</tbody></table>
        <div className="grid gap-2 sm:grid-cols-2">
          <label><span className="label">Reason</span><input className="input" list="ret-reasons" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. unopened, patient had one" maxLength={200} /><datalist id="ret-reasons"><option>Unopened, patient already had one</option><option>Wrong item given</option><option>Doctor changed the prescription</option></datalist></label>
          <label><span className="label">Refund by</span><select className="input" value={m} onChange={(e) => setMethod(e.target.value)}><option value="cash">Cash</option><option value="upi">UPI back to the patient</option><option value="card">Back to the card</option></select>
            {m !== paidBy && <span className="mt-1 block text-[11.5px] text-amber">The bill was paid by {paidBy.toUpperCase()}. Refund the same way unless the patient asks.</span>}</label>
          {m !== 'cash' && <label className="sm:col-span-2"><span className="label">Refund reference (new, from this refund)</span><input className="input" value={ref} onChange={(e) => setRef(e.target.value)} /></label>}
        </div>
        <div className="text-xs text-muted">Only sealed items go back on the shelf. Anything opened, damaged or cold-chain is written off and shows in the medicine's movements.</div>
        {lines.length > 0 && problem && <div className="text-xs text-rose">{problem}</div>}
        <div className="flex flex-wrap gap-2 justify-end">
          {can(perms, 'stock.approve') && <button className="btn btn-ghost text-rose" disabled={cancel.isPending} onClick={async () => { const a = await ask({ title: `Cancel ${s.invoiceNo}?`, body: `Everything not yet returned is refunded by ${m.toUpperCase()} and written off, not put back on the shelf. For sealed items use Return items instead.`, tone: 'danger', confirmLabel: 'Cancel bill', cancelLabel: 'Keep', field: { label: 'Reason', required: true, maxLength: 200 } }); if (a) cancel.mutate(a.value); }}>Cancel whole bill</button>}
          <button className="btn btn-primary" disabled={!!problem || ret.isPending} onClick={() => ret.mutate()}>Return and refund {refund ? money(refund) : ''}</button>
        </div>
      </>}
    </div>
  );
}

/** Pharmacy receipt in the print popup: batch and expiry on every line, doctor, GST split, payments, and what was not issued. */
export async function printSale(id: string) {
  try {
    const x = await get(`/pharmacy/sale/${id}`);
    // GST: a clinic with a GSTIN issues a Tax Invoice with CGST/SGST per rate; without one it may not charge GST and issues a Bill of Supply
    const gstin = !!x.clinic.gstin; const title = gstin ? 'Tax Invoice' : 'Bill of Supply';
    const byRate = new Map<number, { value: number; tax: number }>();
    for (const l of x.items) { // the bill discount is shared out over the lines, as on the server
      const net = x.grossPaise ? Math.round((l.amountPaise * x.totalPaise) / x.grossPaise) : l.amountPaise; const value = Math.round((net * 10000) / (10000 + l.gstBp));
      const r = byRate.get(l.gstBp) ?? { value: 0, tax: 0 }; r.value += value; r.tax += net - value; byRate.set(l.gstBp, r);
    }
    const rates = [...byRate].sort((a, b) => a[0] - b[0]);
    const taxRows = gstin ? `<table><tr><th>GST rate</th><th>Taxable value</th><th>CGST</th><th>SGST</th></tr>${rates.map(([bp, r]) => { const h = Math.floor(r.tax / 2); return `<tr><td>${bp / 100}%</td><td>${rupees2(r.value)}</td><td>${rupees2(h)}</td><td>${rupees2(r.tax - h)}</td></tr>`; }).join('')}</table>` : '';
    const html = `<!doctype html><title>${esc(x.invoiceNo)}</title><style>body{font:13px system-ui,sans-serif;margin:18px;color:#111;max-width:420px}h1{font-size:16px;margin:0}table{width:100%;border-collapse:collapse;margin:8px 0}th,td{padding:3px 2px;text-align:right;vertical-align:top}th:first-child,td:first-child{text-align:left}th{border-bottom:1px dashed #999;font-weight:600}.m{color:#555;font-size:11.5px}.t td{padding:1px 2px}.b{font-weight:700;font-size:15px}hr{border:0;border-top:1px dashed #999}</style>
<h1>${esc(x.clinic.name)} · Pharmacy</h1><div class="m">${esc(x.clinic.address ?? '')}${x.clinic.gstin ? ' · GSTIN ' + esc(x.clinic.gstin) : ''}${x.clinic.drugLicence ? ' · DL ' + esc(x.clinic.drugLicence) : ''}</div><hr>
<div style="text-align:center;font-weight:700;margin-bottom:4px">${title}</div><div><b>Bill ${esc(x.invoiceNo)}</b> · <span class="m">${new Date(x.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' })}</span></div>
<div class="m">${x.walkIn ? 'Customer' : 'Patient'}: ${esc(x.patient.fullName)}${x.patient.patientNo ? ` (${esc(x.patient.patientNo)})` : ''}${x.patient.ageYears ? ', ' + esc(x.patient.ageYears) + ' ' + esc(x.patient.sex ?? '') : ''}${x.doctor ? '<br>Doctor: ' + esc(x.doctor) : ''}</div><hr>
<table><tr><th>Item · batch · exp</th><th>Qty</th><th>MRP</th><th>Amt</th></tr>${x.items.map((l: any) => `<tr><td>${esc(l.name)}<div class="m">${l.batchNo ? esc(l.batchNo) + ' · ' + exp(l.expiry) + ' · ' : ''}${gstin ? `GST ${l.gstBp / 100}%` : ''}${l.hsn ? ' · HSN ' + esc(l.hsn) : ''}</div></td><td>${l.qty}</td><td>${rupees2(l.mrpPaise)}</td><td>${rupees2(l.amountPaise)}</td></tr>`).join('')}</table><hr>
${taxRows}
<table class="t"><tr><td>Items total</td><td>${rupees2(x.grossPaise)}</td></tr>${x.discountPaise ? `<tr><td>Discount</td><td>-${rupees2(x.discountPaise)}</td></tr>` : ''}${gstin ? `<tr><td>GST included</td><td>${rupees2(rates.reduce((n, [, r]) => n + r.tax, 0))}</td></tr>` : ''}<tr class="b"><td>TOTAL</td><td>₹${rupees2(x.totalPaise)}</td></tr>
${x.payments.map((p: any) => `<tr><td>${esc(p.method.toUpperCase())}${p.reference ? ' ' + esc(p.reference) : ''}${p.method === 'cash' && x.receivedPaise > p.amountPaise ? ` · received ${rupees2(x.receivedPaise)}, change ${rupees2(x.receivedPaise - p.amountPaise)}` : ''}</td><td>${rupees2(p.amountPaise)}</td></tr>`).join('')}
${x.returns.map((r: any) => `<tr><td>${esc(r.creditNoteNo)} refund (${esc(r.method.toUpperCase())})</td><td>-${rupees2(r.refundPaise)}</td></tr>`).join('')}</table>
${x.notIssued?.length ? `<hr><div class="m">Not taken today: ${x.notIssued.map((n: any) => `${esc(n.name)} (${n.left})`).join(', ')}. Available here for 30 days if needed.</div>` : ''}
<div class="m" style="margin-top:8px">${gstin ? 'Prices include GST.' : 'Not registered for GST, so no tax is shown on this bill.'} Thank you.</div>`;
    openPrint({ title: `Receipt ${x.invoiceNo}`, html });
  } catch (e: any) { toast(errText(e), 'err'); }
}
