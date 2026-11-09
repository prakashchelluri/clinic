import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Link, Navigate, useOutletContext, useSearchParams } from 'react-router';
import { get, post, qc, today, fmtTime, errText } from '../api';
import { can } from '../App';
import { openPrint } from '../printPreview';
import { Chip, Empty, Icon, Modal, Segmented, Filter, Skeleton, money, toast, MoneyInput, toPaise, NumInput, ask, fmtDate, usePageSearch } from '../ui';
import { Inventory, type InvTab } from './pharmacyStock';
import { RegisterTab } from './pharmacyRegister';

type Tab = 'counter' | 'bills' | 'register';
const INV: string[] = ['stock', 'batches', 'orders', 'vendors'];
const REASONS = ['Has at home', 'Will buy later', 'Bought outside', 'Out of stock', 'Too costly', 'Doctor said not needed'];
const exp = (d: string) => d.slice(5, 7) + '/' + d.slice(2, 4);
const rupees2 = (p: number) => (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (x: unknown) => String(x ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const packLabel = (m: { form?: string | null; packSize?: number } | null | undefined, n = 1) => !m ? '' : ['tab', 'cap'].includes(m.form ?? '') ? `strip${n === 1 ? '' : 's'}` : (m.form ?? 'pack') + (n === 1 ? '' : 's');
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
      {tab === 'bills' && <Bills sel={sp.get('bill')} pick={(bill) => go(bill ? { tab: 'bills', bill } : { tab: 'bills' })} onIssue={(rx) => go({ tab: 'counter', rx })} />}
      {tab === 'register' && <RegisterTab clinic={cfg?.tenant?.name ?? ''} licence={cfg?.tenant?.settings?.print?.drugLicence ?? cfg?.tenant?.settings?.drugLicence} />}
    </div>
  );
}

/* ---------------- Counter: the register ---------------- */

type Line = { key: string; medicineId: string | null; name: string; rxItemId?: string; prescribed?: number; issued?: number; left?: number; how?: string; qty: string; batchId: string; reason: string; batches: any[]; onHand: number; mrpPaise: number; gstBp: number; med: any };

const lineAmount = (l: Line) => { const b = l.batches.find((x) => x.id === l.batchId); return (Number(l.qty) || 0) * (b?.mrpPaise ?? l.mrpPaise); };
/** Each form has its own pastel, as Vialo colours its categories. */
const FORMS: Record<string, [string, string, string]> = { tab: ['bg-tile-1', 'Tablet', 'Tablets'], cap: ['bg-tile-3', 'Capsule', 'Capsules'], cream: ['bg-tile-4', 'Cream', 'Creams'], gel: ['bg-tile-2', 'Gel', 'Gels'], lotion: ['bg-tile-5', 'Lotion', 'Lotions'] };
const tileOf = (form?: string | null) => FORMS[form ?? '']?.[0] ?? 'bg-tile-5';
const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
const daysTo = (d: string) => Math.round((new Date(d + 'T00:00:00').getTime() - Date.now()) / 86400000);
const shortDay = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
/** The doctor's prescription as bill lines: quantities pre-filled with what is left, capped by stock. */
const rxToLines = (rx: any): Line[] => (rx?.items ?? []).map((it: any) => {
  const qty = it.medicine ? Math.min(it.left, it.onHand) : 0;
  return { key: it.id, medicineId: it.medicine?.id ?? null, name: it.name, rxItemId: it.id, prescribed: it.prescribed, issued: it.issuedQty, left: it.left, how: [it.dose, it.frequency, it.durationDays ? `${it.durationDays} days` : null].filter(Boolean).join(' · '),
    qty: String(qty), batchId: it.batches[0]?.id ?? '', reason: it.medicine && it.left > it.onHand ? 'Out of stock' : '', batches: it.batches, onHand: it.onHand, mrpPaise: it.medicine?.mrpPaise ?? 0, gstBp: it.medicine?.gstBp ?? 0, med: it.medicine };
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
  const billRef = useRef<HTMLElement>(null);

  // the bill follows ?rx=: a prescription opened from the list, by drag, or from Bills
  useEffect(() => {
    if (!sel || sel === 'walkin') { if (sel === 'walkin') { setBill({ rx: null, who: null, lines: [] }); setDiscount(''); } return; }
    if (bill.rx?.encounterId === sel) return;
    let live = true; setLoading(true);
    get(`/pharmacy/rx/${sel}`).then((rx: any) => { if (live) setBill((b) => ({ rx, who: rx.patient, lines: [...rxToLines(rx), ...(b.rx ? [] : b.lines.filter((l) => !l.rxItemId))] })); }, (e) => toast(errText(e), 'err')).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [sel]);

  const allRx: any[] = [...(d?.today ?? []), ...(d?.balances ?? []), ...(d?.found ?? [])];
  const choose = async (r: any, from?: Element | null) => {
    if (!canBill || r.encounterId === bill.rx?.encounterId) return;
    if (bill.rx && bill.lines.some((l) => Number(l.qty) > 0)) {
      const ok = await ask({ title: `Start ${r.patient.fullName}'s bill?`, body: `${bill.rx.patient.fullName}'s bill is not paid. It is set aside and their prescription stays on the list.`, confirmLabel: 'Start new bill' });
      if (!ok) return;
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
  const reset = () => { setBill({ rx: null, who: null, lines: [] }); setDiscount(''); pick(null); };
  const clearBill = async () => {
    if (bill.lines.some((l) => Number(l.qty) > 0)) { const ok = await ask({ title: 'Clear this bill?', body: 'Nothing is saved. A prescription stays on the list.', confirmLabel: 'Clear', tone: 'danger' }); if (!ok) return; }
    reset();
  };

  const rx = bill.rx; const who = bill.who; const lines = bill.lines;
  const issuing = lines.filter((l) => l.medicineId && Number(l.qty) > 0);
  const gross = issuing.reduce((n, l) => n + lineAmount(l), 0);
  const disc = Math.min(toPaise(discount || '0'), gross); const total = gross - disc;
  const gstIn = issuing.reduce((n, l) => { const a = lineAmount(l); return n + a - Math.round((a * 10000) / (10000 + l.gstBp)); }, 0);
  const gst = gross ? Math.round((gstIn * total) / gross) : 0;
  const overStock = lines.find((l) => Number(l.qty) > l.onHand);
  const rxLines = lines.filter((l) => l.rxItemId);
  const units = issuing.reduce((n, l) => n + Number(l.qty), 0);
  const nothing = useMutation({ mutationFn: (reason: string) => post(`/pharmacy/rx/${rx.encounterId}/nothing`, { reason: reason || undefined }),
    onSuccess: () => { toast('Noted: not buying here'); qc.invalidateQueries({ queryKey: ['pharmacy'] }); reset(); }, onError: (e) => toast(errText(e), 'err') });
  const outside = useMutation({ mutationFn: (reason: string) => post(`/pharmacy/rx/${rx.encounterId}/outside`, { reason: reason || undefined }),
    onSuccess: () => { toast('Noted: the rest was bought outside'); qc.invalidateQueries({ queryKey: ['pharmacy'] }); reset(); }, onError: (e) => toast(errText(e), 'err') });
  const problem = !who ? 'Pick or register the customer.' : issuing.length === 0 ? 'Nothing to sell yet.' : overStock ? `${overStock.name}: only ${overStock.onHand} in stock.` : total <= 0 ? 'The discount cannot be the whole bill.' : '';

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
        <span className="shrink-0 text-right"><b className="block text-[13px]">{r.items} {r.items === 1 ? 'medicine' : 'medicines'}</b><small className="block text-[11.5px] font-semibold opacity-80">{on ? 'On the bill' : r.status === 'issued' ? 'Issued' : r.status === 'nothing' ? 'Not from us' : r.status === 'part' ? 'Partly here' : 'Add'}</small></span>
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
            {meds.isLoading ? <div className="mt-3"><Skeleton rows={3} /></div> : shown.length === 0 ? <div className="mt-3 py-4 text-sm text-muted">{find ? 'Nothing by that name. Add it under Settings → Medicines.' : 'No medicines yet.'}</div> : (
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
                      <span className="min-w-0"><b className="block text-[14px] leading-snug">{m.name}</b><small className="block text-[12px] text-muted">{[FORMS[m.form]?.[1] ?? m.form, m.packSize > 1 ? `${m.packSize} per strip` : null, m.scheduleClass ? `Sch ${m.scheduleClass}` : null].filter(Boolean).join(' · ')}</small></span>
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
            : <WalkInPatient who={who} setWho={(p) => setBill((b) => ({ ...b, who: p }))} />}
          {rx?.patient.allergies && <div className="pop-in mt-2 flex gap-2.5 rounded-[14px] bg-rose-soft px-3 py-2.5 text-rose" role="alert"><span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-rose text-[12px] font-bold text-white">!</span><span><b className="block text-[13.5px]">Allergic to {rx.patient.allergies}</b><small className="text-[12px]">Check anything you add before you sell it.</small></span></div>}
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
                    <span className="min-w-0 flex-1"><b className="block text-[13.5px] leading-snug">{l.name}{l.rxItemId && <span className="ml-1.5 rounded-full bg-clay-soft px-1.5 py-px align-middle text-[10.5px] font-bold text-clay-ink">Rx</span>}</b>
                      <small className={`block truncate text-[11.5px] ${l.medicineId && l.onHand === 0 ? 'text-rose' : 'text-muted'}`}>{!l.medicineId ? 'not in the medicine list' : l.onHand === 0 ? (can(perms, 'stock.read') ? <Link className="underline" to={`/inventory?tab=stock&item=${l.medicineId}`}>out of stock · see in Inventory</Link> : 'out of stock') : l.rxItemId ? [`${l.prescribed} ${packLabel(l.med, l.prescribed ?? 1)} prescribed`, (l.issued ?? 0) > 0 ? `${l.issued} issued before` : null, l.how].filter(Boolean).join(' · ') : [money(b?.mrpPaise ?? l.mrpPaise) + ' each', b ? `${b.batchNo} · exp ${exp(b.expiry)}` : null].filter(Boolean).join(' · ')}</small></span>
                    {done ? <Chip tone="sage">issued</Chip> : <span className="flex shrink-0 items-center rounded-full bg-surface-2 p-0.5 shadow-[var(--ring)]">
                      <button type="button" className="grid h-7 w-7 place-items-center rounded-full text-[16px] font-bold text-ink-2 hover:bg-paper-2 disabled:opacity-40" aria-label={`One less ${l.name}`} disabled={!l.medicineId || !canBill || n === 0} onClick={() => step(l, -1)}>−</button>
                      <NumInput aria-label={`Issue ${l.name}`} className={`w-8 bg-transparent text-center text-[13.5px] font-semibold outline-none ${n > l.onHand ? 'text-rose' : ''}`} max={999} disabled={!l.medicineId || !canBill} value={l.qty} onChange={(e) => set(l.key, { qty: e.target.value })} />
                      <button type="button" className="grid h-7 w-7 place-items-center rounded-full bg-clay text-[16px] font-bold text-white hover:bg-clay-2 disabled:opacity-40" aria-label={`One more ${l.name}`} disabled={!l.medicineId || !canBill || n >= l.onHand} onClick={() => step(l, 1)}>+</button>
                    </span>}
                    <b className="w-[70px] shrink-0 text-right text-[13.5px]">{n > 0 ? money(lineAmount(l)) : '—'}</b>
                    {!l.rxItemId ? <button type="button" className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-muted hover:bg-ink/6 hover:text-ink" aria-label={`Remove ${l.name}`} onClick={() => setBill((bb) => ({ ...bb, lines: bb.lines.filter((x) => x.key !== l.key) }))}><Icon name="x" className="h-3.5 w-3.5" /></button> : <span className="w-7 shrink-0" />}
                  </div>
                  {(l.batches.length > 1 && n > 0) || (l.rxItemId && !done && short > 0) ? <div className="mt-1.5 flex flex-wrap items-center gap-2 pl-[42px]">
                    {l.batches.length > 1 && n > 0 && <select aria-label={`Batch for ${l.name}`} className="input !min-h-0 !w-auto !py-1 !text-xs" value={l.batchId} onChange={(e) => set(l.key, { batchId: e.target.value })}>{l.batches.map((x) => <option key={x.id} value={x.id}>{x.batchNo} · exp {exp(x.expiry)} · {x.qty} left</option>)}</select>}
                    {l.rxItemId && !done && short > 0 && <><span className="text-[11.5px] text-muted">{n === 0 ? 'not from us' : `${short} not taken`}</span>
                      <select aria-label={`Reason for ${l.name}`} className="input !min-h-0 !w-auto !py-1 !text-xs" value={l.reason} onChange={(e) => set(l.key, { reason: e.target.value })}><option value="">Reason (optional)</option>{REASONS.map((r) => <option key={r}>{r}</option>)}</select></>}
                  </div> : null}
                </div>);
            })}
          </div>

          {lines.length > 0 && canBill && <>
            <div className="mt-3 space-y-1.5 border-t border-line pt-3 text-[13.5px]">
              <div className="flex justify-between"><span className="text-muted">{rx ? `${rxLines.filter((l) => Number(l.qty) > 0).length} of ${rxLines.length} prescribed · ` : ''}{units} {units === 1 ? 'item' : 'items'}</span><span>₹{rupees2(gross)}</span></div>
              <div className="flex justify-between text-muted"><span>GST included</span><span>₹{rupees2(gst)}</span></div>
              <div className="flex items-center justify-between gap-3"><span className="text-muted">Discount <span className="text-[11.5px]">(above 10% needs the owner)</span></span><MoneyInput label="Discount" className="!min-h-[34px] !w-28 !py-1" value={discount} onChange={setDiscount} /></div>
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

      {paying && <PayDialog total={total} patient={who} onClose={() => setPaying(false)} build={() => ({
        ...(who.id ? { patientId: who.id } : { newPatient: { fullName: who.fullName.trim(), phone: who.phone, ageYears: who.ageYears ? Number(who.ageYears) : undefined } }),
        encounterId: rx?.encounterId, discountPaise: disc,
        items: issuing.map((l) => ({ medicineId: l.medicineId!, qty: Number(l.qty), batchId: l.batchId || undefined, prescriptionItemId: l.rxItemId })),
        notIssued: rxLines.filter((l) => (l.left ?? 0) > (Number(l.qty) || 0)).map((l) => ({ prescriptionItemId: l.rxItemId!, reason: l.reason || null })),
      })} onDone={(s) => { setPaying(false); setSale({ ...s, rows: issuing.map((l) => ({ name: l.name, qty: Number(l.qty), amount: lineAmount(l), rx: !!l.rxItemId })), gross, disc, total, who: who?.fullName }); }} />}
      {sale && <Receipt sale={sale} clinic={cfg?.tenant?.name ?? ''} onNew={() => { setSale(null); reset(); }} onVoid={() => {
        // the bill was never cleared, so it is simply there again; a new walk-in is now a patient on file
        setSale(null); if (!who?.id) setBill((b) => ({ ...b, who: { ...b.who, id: sale.patientId } }));
        ['pharmacy', 'stock', 'reports', 'patients'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
        toast('Sale voided · the bill is back');
      }} />}
    </div>
  );
}

/** Payment taken: a stamp lands, the receipt reads like paper; Print or start the next sale. */
function Receipt({ sale, clinic, onNew, onVoid }: { sale: any; clinic: string; onNew: () => void; onVoid: () => void }) {
  const voiding = useMutation({ mutationFn: () => post(`/pharmacy/sale/${sale.id}/void`, {}), onSuccess: onVoid, onError: (e) => toast(errText(e), 'err') });
  return (
    <Modal title="Payment taken" subtitle={`${sale.invoiceNo} · ${new Date().toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}`} onClose={onNew} width="max-w-md">
      <div className="stamp mx-auto mb-4 grid h-14 w-14 place-items-center rounded-full bg-clay text-white shadow-[0_12px_26px_-12px_var(--color-clay)]"><Icon name="check" className="h-7 w-7" /></div>
      <div className="pop-in rounded-[18px] bg-surface-2 p-4 text-[13px] shadow-[var(--ring)]">
        <div className="text-center"><b className="block text-[15px]">{clinic}</b><small className="text-muted">Pharmacy</small></div>
        <div className="my-3 border-t border-dashed border-line-2" />
        {sale.rows.map((r: any, i: number) => <div key={i} className="flex justify-between gap-3 py-1"><span className="min-w-0"><span className="block truncate">{r.rx ? 'Rx · ' : ''}{r.name}</span><small className="text-muted">{r.qty} × {money(Math.round(r.amount / r.qty))}</small></span><span className="shrink-0">{money(r.amount)}</span></div>)}
        <div className="my-3 border-t border-dashed border-line-2" />
        <div className="flex justify-between text-muted"><span>Subtotal</span><span>{money(sale.gross)}</span></div>
        {sale.disc > 0 && <div className="flex justify-between text-muted"><span>Discount</span><span>−{money(sale.disc)}</span></div>}
        <div className="mt-1 flex justify-between text-[17px] font-semibold"><span>Total</span><span>{money(sale.total)}</span></div>
        {sale.who && <div className="mt-3 text-center text-[12px] text-muted">Customer: {sale.who}</div>}
      </div>
      <div className="modal-foot"><button type="button" className="btn btn-ghost mr-auto" disabled={voiding.isPending} title="Wrong patient or item? Undo this bill: stock goes back and the money is refunded" onClick={() => voiding.mutate()}><Icon name="undo" />Void</button><button type="button" className="btn" onClick={() => printSale(sale.id)}><Icon name="print" />Print</button><button type="button" className="btn btn-primary" onClick={onNew}>New sale</button></div>
    </Modal>
  );
}

/** The bill's customer when there is no prescription: one of our patients, or a new walk-in (a name is enough). */
function WalkInPatient({ who, setWho }: { who: any; setWho: (p: any) => void }) {
  const [mode, setMode] = useState<'existing' | 'new'>('existing'); const [find, setFind] = useState('');
  const [np, setNp] = useState({ fullName: '', phone: '', ageYears: '' });
  const pts = useQuery({ queryKey: ['palette', find], queryFn: () => get(`/patients?q=${encodeURIComponent(find)}`), enabled: mode === 'existing' && !who && find.trim().length >= 2 });
  useEffect(() => { if (mode === 'new') setWho(np.fullName.trim().length >= 2 && (!np.phone || /^[0-9]{10}$/.test(np.phone)) ? { ...np, phone: np.phone || null } : null); }, [np, mode]);
  if (who?.id) return <div className="mt-3 flex items-center gap-2.5 rounded-[16px] bg-surface-2 p-2.5 shadow-[var(--ring)]"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-tile-3 text-[12px] font-bold">{initials(who.fullName)}</span><span className="min-w-0 flex-1"><b className="block truncate text-[13.5px]">{who.fullName}</b><small className="text-[12px] text-muted">{who.patientNo} · {who.phone ?? 'no phone'}</small></span><button type="button" className="btn btn-sm" onClick={() => setWho(null)}>Change</button></div>;
  return (
    <div className="mt-3 space-y-2">
      <div className="flex gap-1.5">{([['existing', 'Our patient'], ['new', 'New customer']] as const).map(([k, l]) => <button key={k} type="button" className={`toggle-opt flex-1 justify-center ${mode === k ? 'on' : ''}`} onClick={() => { setMode(k); setWho(null); }}>{l}</button>)}</div>
      {mode === 'existing' ? <div>
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
function PayDialog({ total, patient, build, onClose, onDone }: { total: number; patient: any; build: () => any; onClose: () => void; onDone: (sale: any) => void }) {
  const [mode, setMode] = useState<'cash' | 'upi' | 'card' | 'split'>('cash');
  const [upi, setUpi] = useState(''); const [upiRef, setUpiRef] = useState(''); const [card, setCard] = useState(''); const [cardRef, setCardRef] = useState(''); const [received, setReceived] = useState('');
  const [print, setPrint] = useState(() => pref('ph.print', true)); const [wa, setWa] = useState(() => pref('ph.wa', true) && !!patient?.phone);
  const [tried, setTried] = useState(false);
  const upiAmt = mode === 'upi' ? total : mode === 'split' ? toPaise(upi) : 0; const cardAmt = mode === 'card' ? total : mode === 'split' ? toPaise(card) : 0;
  const cash = mode === 'cash' ? total : mode === 'split' ? total - upiAmt - cardAmt : 0;
  const got = toPaise(received); const change = received ? got - cash : 0;
  const problem = cash < 0 ? 'UPI and card add up to more than the bill.' : upiAmt > 0 && upiRef.trim().length < 4 ? 'Enter the UPI reference (UTR).' : cardAmt > 0 && cardRef.trim().length < 4 ? 'Enter the card approval code.'
    : mode === 'split' && upiAmt + cardAmt === 0 ? 'Enter the UPI or card part of the split.' : received && got < cash ? 'Cash received is less than the cash part.' : '';
  const save = useMutation({
    mutationFn: () => post('/pharmacy/sale', { ...build(), whatsapp: wa,
      payments: [...(upiAmt > 0 ? [{ method: 'upi', amountPaise: upiAmt, reference: upiRef.trim() }] : []), ...(cardAmt > 0 ? [{ method: 'card', amountPaise: cardAmt, reference: cardRef.trim() }] : []), ...(cash > 0 ? [{ method: 'cash', amountPaise: cash }] : [])],
      receivedPaise: cash > 0 && received ? got : undefined }),
    onSuccess: (s: any) => {
      setPref('ph.print', print); setPref('ph.wa', wa);
      toast(`Saved ${s.invoiceNo} · ${money(s.totalPaise)}${change > 0 ? ` · give change ${money(change)}` : ''}`);
      ['pharmacy', 'stock', 'reports', 'patients'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      if (print) printSale(s.id);
      onDone(s);
    },
    onError: (e) => toast(errText(e), 'err'),
  });
  return (
    <Modal title={`Take payment · ${money(total)}`} subtitle={patient?.fullName} onClose={onClose} width="max-w-2xl">
      <div className="space-y-4">
        <div className="flex gap-1.5">{(['cash', 'upi', 'card', 'split'] as const).map((m) => <button key={m} className={`toggle-opt flex-1 justify-center ${mode === m ? 'on' : ''}`} onClick={() => setMode(m)}>{m === 'upi' ? 'UPI' : m[0].toUpperCase() + m.slice(1)}</button>)}</div>
        {(mode === 'upi' || mode === 'split') && <div className="grid gap-2 sm:grid-cols-2">
          {mode === 'split' && <label><span className="label">UPI amount</span><MoneyInput label="UPI amount" value={upi} onChange={setUpi} /></label>}
          <label className={mode === 'upi' ? 'sm:col-span-2' : ''}><span className="label">UPI reference (UTR)</span><input className={`input ${tried && upiAmt > 0 && upiRef.trim().length < 4 ? '!border-rose' : ''}`} value={upiRef} onChange={(e) => setUpiRef(e.target.value)} placeholder="12-digit UTR" /></label></div>}
        {(mode === 'card' || mode === 'split') && <div className="grid gap-2 sm:grid-cols-2">
          {mode === 'split' && <label><span className="label">Card amount</span><MoneyInput label="Card amount" value={card} onChange={setCard} /></label>}
          <label className={mode === 'card' ? 'sm:col-span-2' : ''}><span className="label">Card approval code</span><input className={`input ${tried && cardAmt > 0 && cardRef.trim().length < 4 ? '!border-rose' : ''}`} value={cardRef} onChange={(e) => setCardRef(e.target.value)} /></label></div>}
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
      <div className="modal-foot"><button className="btn btn-ghost" onClick={onClose}>Back to items</button><button className="btn btn-primary" disabled={save.isPending} onClick={() => { setTried(true); if (!problem) save.mutate(); }}><Icon name="check" />Save bill</button></div>
    </Modal>
  );
}

/* ---------------- Bills ---------------- */

const minusDays = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() - n); return x.toISOString().slice(0, 10); };

function Bills({ sel, pick, onIssue }: { sel: string | null; pick: (id: string | null) => void; onIssue: (rx: string) => void }) {
  const [range, setRange] = useState<'today' | 'yesterday' | 'week' | 'custom'>('today');
  const [from, setFrom] = useState(today()); const [to, setTo] = useState(today()); const [q] = usePageSearch('Find a bill: number, patient or phone');
  const span = range === 'today' ? [today(), today()] : range === 'yesterday' ? [minusDays(today(), 1), minusDays(today(), 1)] : range === 'week' ? [minusDays(today(), 6), today()] : [from, to];
  const bad = span[0] > span[1];
  const list = useQuery({ queryKey: ['pharmacy', 'bills', span[0], span[1], q], queryFn: () => get(`/pharmacy/bills?from=${span[0]}&to=${span[1]}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`), enabled: !bad });
  const t = list.data?.totals; const rows: any[] = list.data?.rows ?? [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Filter icon="calendar" value={range} onChange={setRange} options={[{ value: 'today', label: 'Today' }, { value: 'yesterday', label: 'Yesterday' }, { value: 'week', label: 'Last 7 days' }, { value: 'custom', label: 'Pick dates' }]} />
        {range === 'custom' && <><input type="date" aria-label="From" className={`input !w-auto ${bad ? '!border-rose' : ''}`} value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} /><span className="text-sm text-muted">to</span><input type="date" aria-label="To" className={`input !w-auto ${bad ? '!border-rose' : ''}`} value={to} onChange={(e) => e.target.value && setTo(e.target.value)} />{bad && <span className="text-xs text-rose">“From” is after “to”.</span>}</>}
      </div>
      {t && <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {[['Bills', money(t.total - t.refunds), `${t.count} bills${t.returns ? ` · ${t.returns} return${t.returns === 1 ? '' : 's'}` : ''}`], ['Cash in drawer should be', money(t.cash ?? 0), t.refunds ? `after ${money(t.refunds)} refunds` : 'cash payments'], ['UPI', money(t.upi ?? 0), ''], ['Card', money(t.card ?? 0), ''],
          ['Bought elsewhere or not at all', `${list.data.rx.notBought} of ${list.data.rx.total}`, 'prescriptions today · not a task, for the doctor to know']].map(([l, v, s]) => <div key={l} className="card !p-4"><div className="text-[12px] font-medium text-muted">{l}</div><div className="text-[24px] font-semibold tracking-tight mt-1.5">{v}</div>{s && <div className="text-xs text-muted mt-0.5">{s}</div>}</div>)}
      </div>}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] lg:items-start">
        <div className={`card !p-0 overflow-x-auto ${sel ? 'hidden lg:block' : ''}`}>
          {list.isLoading ? <div className="p-5"><Skeleton rows={4} /></div> : rows.length === 0 ? <Empty icon="pill" title="No bills in this range" /> : (
            <table className="table min-w-[640px]"><thead><tr><th>Bill</th><th>Time</th><th>Patient</th><th>Items</th><th className="!text-right">Amount</th><th>Paid by</th></tr></thead>
              <tbody>{rows.map((r) => (
                <tr key={r.id} onClick={() => pick(r.id)} className={`cursor-pointer ${sel === r.id ? 'bg-paper-2' : 'hover:bg-surface-2'}`}>
                  <td><button className="font-semibold hover:underline" onClick={(e) => { e.stopPropagation(); pick(r.id); }}>{r.invoiceNo}</button></td><td className="text-muted whitespace-nowrap">{range === 'today' ? fmtTime(r.at) : `${fmtDate(r.at)} ${fmtTime(r.at)}`}</td>
                  <td><div className="font-medium">{r.patient.fullName}</div><div className="text-xs text-muted">{r.encounterId ? `Rx ${r.doctor ?? ''}` : 'Walk-in · no prescription'}</div></td>
                  <td className="text-sm">{r.items} item{r.items === 1 ? '' : 's'}{r.balance.length > 0 && <span className="ml-1.5 text-xs text-muted">· {r.balance.map((b: any) => b.left).reduce((a: number, b: number) => a + b, 0)} left on Rx</span>}{r.notIssued > 0 && <span className="ml-1.5 text-xs text-muted">· {r.notIssued} not from us</span>}</td>
                  <td className="text-right font-semibold">{money(r.totalPaise)}{r.refundPaise > 0 && <div className="text-xs text-rose">− {money(r.refundPaise)}</div>}</td>
                  <td className="text-sm uppercase text-muted">{r.method === 'split' ? r.payments.map((p: any) => p.method).join(' + ') : r.method}</td>
                </tr>))}</tbody></table>)}
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
  const back = useMemo(() => (s?.items ?? []).map((l: any, i: number) => l.qty - (s.returns ?? []).reduce((n: number, r: any) => n + r.lines.filter((x: any) => x.line === i).reduce((k: number, x: any) => k + x.qty, 0), 0)), [s]);
  const lines = Object.entries(qty).map(([k, v]) => ({ line: Number(k), qty: Number(v) || 0 })).filter((l) => l.qty > 0);
  const refund = s ? lines.reduce((n, l) => n + Math.round((s.items[l.line].amountPaise * l.qty * s.totalPaise) / (s.items[l.line].qty * s.grossPaise)), 0) : 0;
  const m = method || 'cash';
  const done = () => { setQty({}); setReason(''); setRef(''); ['pharmacy', 'stock', 'reports'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); };
  const ret = useMutation({ mutationFn: () => post(`/pharmacy/sale/${id}/return`, { lines, reason: reason.trim(), method: m, reference: m === 'cash' ? undefined : ref.trim() }),
    onSuccess: (r: any) => { toast(`Credit note ${r.creditNoteNo} · refund ${money(r.refundPaise)}`); done(); }, onError: (e) => toast(errText(e), 'err') });
  const cancel = useMutation({ mutationFn: (why: string) => post(`/pharmacy/sale/${id}/cancel`, { reason: why, method: m, reference: m === 'cash' ? undefined : ref.trim() || undefined }),
    onSuccess: (r: any) => { toast(`Bill cancelled · ${r.creditNoteNo} · refund ${money(r.refundPaise)}`); done(); }, onError: (e) => toast(errText(e), 'err') });
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
        <table className="table"><thead><tr><th className="!pl-0">Item · batch</th><th className="!text-right">Sold</th><th className="!text-right">Return</th><th className="!text-right !pr-0">Refund</th></tr></thead>
          <tbody>{s.items.map((l: any, i: number) => back[i] > 0 && (
            <tr key={i}><td className="!pl-0"><div className="font-medium">{l.name}</div><div className="text-xs text-muted">{l.batchNo ?? '—'}{l.expiry ? ` · ${exp(l.expiry)}` : ''}</div></td><td className="text-right">{back[i]}{back[i] < l.qty ? <span className="text-xs text-muted"> of {l.qty}</span> : ''}</td>
              <td className="text-right"><NumInput aria-label={`Return ${l.name}`} className={`input !w-16 !px-2 text-right ${Number(qty[i]) > back[i] ? '!border-rose' : ''}`} max={999} value={qty[i] ?? ''} placeholder="0" onChange={(e) => setQty({ ...qty, [i]: e.target.value })} /></td>
              <td className="text-right !pr-0">{Number(qty[i]) > 0 ? money(Math.round((l.amountPaise * Number(qty[i]) * s.totalPaise) / (l.qty * s.grossPaise))) : '—'}</td></tr>))}</tbody></table>
        <div className="grid gap-2 sm:grid-cols-2">
          <label><span className="label">Reason</span><input className="input" list="ret-reasons" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. unopened, patient had one" maxLength={200} /><datalist id="ret-reasons"><option>Unopened, patient already had one</option><option>Wrong item given</option><option>Doctor changed the prescription</option></datalist></label>
          <label><span className="label">Refund by</span><select className="input" value={m} onChange={(e) => setMethod(e.target.value)}><option value="cash">Cash</option><option value="upi">UPI back to the patient</option><option value="card">Card reversal</option></select></label>
          {m !== 'cash' && <label className="sm:col-span-2"><span className="label">Refund reference</span><input className="input" value={ref} onChange={(e) => setRef(e.target.value)} /></label>}
        </div>
        <div className="text-xs text-muted">Items go back to the same batch. Opened or cold-chain items cannot go back on the shelf: take them back with an adjustment in Inventory.</div>
        {lines.length > 0 && problem && <div className="text-xs text-rose">{problem}</div>}
        <div className="flex flex-wrap gap-2 justify-end">
          {can(perms, 'stock.approve') && <button className="btn btn-ghost text-rose" disabled={cancel.isPending} onClick={async () => { const a = await ask({ title: `Cancel ${s.invoiceNo}?`, body: `Everything not yet returned comes back to stock and is refunded by ${m.toUpperCase()}.`, tone: 'danger', confirmLabel: 'Cancel bill', cancelLabel: 'Keep', field: { label: 'Reason', required: true, maxLength: 200 } }); if (a) cancel.mutate(a.value); }}>Cancel whole bill</button>}
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
    const taxable = x.totalPaise - x.gstPaise; const half = Math.floor(x.gstPaise / 2);
    const html = `<!doctype html><title>${esc(x.invoiceNo)}</title><style>body{font:13px system-ui,sans-serif;margin:18px;color:#111;max-width:420px}h1{font-size:16px;margin:0}table{width:100%;border-collapse:collapse;margin:8px 0}th,td{padding:3px 2px;text-align:right;vertical-align:top}th:first-child,td:first-child{text-align:left}th{border-bottom:1px dashed #999;font-weight:600}.m{color:#555;font-size:11.5px}.t td{padding:1px 2px}.b{font-weight:700;font-size:15px}hr{border:0;border-top:1px dashed #999}</style>
<h1>${esc(x.clinic.name)} · Pharmacy</h1><div class="m">${esc(x.clinic.address ?? '')}${x.clinic.gstin ? ' · GSTIN ' + esc(x.clinic.gstin) : ''}${x.clinic.drugLicence ? ' · DL ' + esc(x.clinic.drugLicence) : ''}</div><hr>
<div><b>Bill ${esc(x.invoiceNo)}</b> · <span class="m">${new Date(x.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' })}</span></div>
<div class="m">Patient: ${esc(x.patient.fullName)} (${esc(x.patient.patientNo)})${x.patient.ageYears ? ', ' + esc(x.patient.ageYears) + ' ' + esc(x.patient.sex ?? '') : ''}${x.doctor ? '<br>Doctor: ' + esc(x.doctor) : ''}</div><hr>
<table><tr><th>Item · batch · exp</th><th>Qty</th><th>MRP</th><th>Amt</th></tr>${x.items.map((l: any) => `<tr><td>${esc(l.name)}<div class="m">${l.batchNo ? esc(l.batchNo) + ' · ' + exp(l.expiry) + ' · ' : ''}GST ${l.gstBp / 100}%${l.hsn ? ' · HSN ' + esc(l.hsn) : ''}</div></td><td>${l.qty}</td><td>${rupees2(l.mrpPaise)}</td><td>${rupees2(l.amountPaise)}</td></tr>`).join('')}</table><hr>
<table class="t"><tr><td>Items total</td><td>${rupees2(x.grossPaise)}</td></tr>${x.discountPaise ? `<tr><td>Discount</td><td>-${rupees2(x.discountPaise)}</td></tr>` : ''}<tr><td>Taxable value</td><td>${rupees2(taxable)}</td></tr><tr><td>CGST</td><td>${rupees2(half)}</td></tr><tr><td>SGST</td><td>${rupees2(x.gstPaise - half)}</td></tr><tr class="b"><td>TOTAL</td><td>₹${rupees2(x.totalPaise)}</td></tr>
${x.payments.map((p: any) => `<tr><td>${esc(p.method.toUpperCase())}${p.reference ? ' ' + esc(p.reference) : ''}${p.method === 'cash' && x.receivedPaise > p.amountPaise ? ` · received ${rupees2(x.receivedPaise)}, change ${rupees2(x.receivedPaise - p.amountPaise)}` : ''}</td><td>${rupees2(p.amountPaise)}</td></tr>`).join('')}
${x.returns.map((r: any) => `<tr><td>${esc(r.creditNoteNo)} refund (${esc(r.method.toUpperCase())})</td><td>-${rupees2(r.refundPaise)}</td></tr>`).join('')}</table>
${x.notIssued?.length ? `<hr><div class="m">Not taken today: ${x.notIssued.map((n: any) => `${esc(n.name)} (${n.left})`).join(', ')}. Available here for 30 days if needed.</div>` : ''}
<div class="m" style="margin-top:8px">Prices include GST. Thank you.</div>`;
    openPrint({ title: `Receipt ${x.invoiceNo}`, html });
  } catch (e: any) { toast(errText(e), 'err'); }
}
