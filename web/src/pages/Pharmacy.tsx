import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Link, Navigate, useOutletContext, useSearchParams } from 'react-router';
import { get, post, qc, today, fmtTime, errText, NO_WHATSAPP } from '../api';
import { can } from '../App';
import { openPrint } from '../printPreview';
import { Chip, Drawer, Icon, Modal, Tabs, Skeleton, money, toast, MoneyInput, toPaise, NumInput, ask, fmtDate, usePageSearch } from '../ui';
import { Inventory, type InvTab } from './pharmacyStock';
import { RegisterTab } from './pharmacyRegister';
import { DataTable, filterValue, type Col, type FilterDef } from '../table';
import { IssueSupplies, ProcAskCard } from '../procIssue';

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
      <Tabs<Tab> className="anim-fade-up mb-5" value={tab} onChange={(v) => go({ tab: v })} options={tabs} />
      {tab === 'counter' && <Counter sel={sp.get('rx')} pick={(rx) => go(rx ? { tab: 'counter', rx } : { tab: 'counter' })} />}
      {tab === 'bills' && <Bills sel={sp.get('bill')} pick={(bill) => setSp((p) => { const n = new URLSearchParams(p); bill ? n.set('bill', bill) : n.delete('bill'); return n; })} onIssue={(rx) => go({ tab: 'counter', rx })} />}
      {tab === 'register' && <RegisterTab clinic={cfg?.tenant?.name ?? ''} licence={cfg?.tenant?.settings?.print?.drugLicence ?? cfg?.tenant?.settings?.drugLicence} />}
    </div>
  );
}

/* ---------------- Counter: a queue, one wide bill, every step by keyboard ---------------- */

type Line = { key: string; medicineId: string | null; name: string; rxItemId?: string; prescribed?: number; issued?: number; left?: number; how?: string; qty: string; batchId: string; reason: string; batches: any[]; onHand: number; mrpPaise: number; gstBp: number; med: any; overReason?: string; doctorQty?: number | null };
type Bill = { rx: any | null; who: any; lines: Line[] };
const EMPTY: Bill = { rx: null, who: null, lines: [] };
const NO_ORX = { doctor: '', regNo: '', date: '' };

const lineAmount = (l: Line) => { const b = l.batches.find((x) => x.id === l.batchId); return (Number(l.qty) || 0) * (b?.mrpPaise ?? l.mrpPaise); };
const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
const daysTo = (d: string) => Math.round((new Date(d + 'T00:00:00').getTime() - Date.now()) / 86400000);
const formName = (f?: string | null) => (({ tab: 'Tablet', cap: 'Capsule' }) as Record<string, string>)[f ?? ''] ?? (f ? f[0].toUpperCase() + f.slice(1) : '');
/** Schedule H, H1 and X: sold only on a prescription. */
const isSched = (m: any) => ['H', 'H1', 'X'].includes(m?.scheduleClass ?? '');
/** The keys of the counter, shown under the bill. */
const KEYS: [string, string][] = [['F2', 'Add a medicine'], ['F4', 'Walk-in sale'], ['F8', 'Queue'], ['↑ ↓', 'Bill lines'], ['+ −', 'Quantity'], ['Del', 'Remove'], ['F7', 'Discount'], ['F9', 'Take payment'], ['Ctrl P', 'Print last bill']];
const GRID = 'grid grid-cols-[minmax(0,1fr)_124px_76px_88px_28px] items-center gap-3';
/**
 * The doctor's prescription as bill lines. The quantity is what is left of the doctor's own (the server turns the
 * doctor's saved units into packs; only when that is missing does it work them out), capped by stock. Never the whole shelf.
 */
const rxToLines = (rx: any): Line[] => (rx?.items ?? []).map((it: any) => {
  const qty = it.medicine ? Math.max(0, Math.min(it.left, it.onHand)) : 0;
  return { key: it.id, medicineId: it.medicine?.id ?? null, name: it.name, rxItemId: it.id, prescribed: it.prescribed, issued: it.issuedQty, left: it.left, doctorQty: it.qty ?? null, how: [it.dose, it.frequency, it.durationDays ? `${it.durationDays} days` : null].filter(Boolean).join(' · '),
    qty: String(qty), batchId: it.batches[0]?.id ?? '', reason: it.medicine && it.left > it.onHand ? 'Out of stock' : '', batches: it.batches, onHand: it.onHand, mrpPaise: it.medicine?.mrpPaise ?? 0, gstBp: it.medicine?.gstBp ?? 0, med: it.medicine, overReason: '' };
});

function Counter({ sel, pick }: { sel: string | null; pick: (rx: string | null) => void }) {
  const { perms, cfg } = useOutletContext<any>(); const canBill = can(perms, 'pharmacy.bill');
  const [q] = usePageSearch('Find a prescription: name, phone or OP no.'); const [earlier, setEarlier] = useState(false);
  const term = q.trim().length >= 2 ? q.trim() : '';
  const list = useQuery({ queryKey: ['pharmacy', 'counter', term], queryFn: () => get(`/pharmacy/counter${term ? `?q=${encodeURIComponent(term)}` : ''}`), refetchInterval: 15000 });
  const meds = useQuery({ queryKey: ['pharmacy', 'medicines'], queryFn: () => get('/pharmacy/medicines'), staleTime: 30_000 });
  const d = list.data; const procs: any[] = d?.procedures ?? [];
  const [find, setFind] = useState(''); const [at, setAt] = useState(0); // the Add a medicine box and its highlighted result
  const [procAsk, setProcAsk] = useState<string | null>(null); // a procedure session's request, open in the Issue popup
  const [bill, setBill] = useState<Bill>(EMPTY); const [loading, setLoading] = useState(false);
  const [discount, setDiscount] = useState(''); const [orx, setOrx] = useState(NO_ORX); // orx: a prescription from a doctor outside the clinic
  const [paying, setPaying] = useState(false); const [last, setLast] = useState<any>(null); const [undo, setUndo] = useState(false); // last: the bill just saved
  const [billKey, setBillKey] = useState(newKey); // made when the bill starts, not per request
  const [parked, setParked] = useState<Bill | null>(null); // a walk-in bill set aside for a prescription
  const root = useRef<HTMLDivElement>(null); const addRef = useRef<HTMLInputElement>(null);
  const fresh = (b: Bill) => { setBill(b); setDiscount(''); setOrx(NO_ORX); setFind(''); setBillKey(newKey()); };
  const toAdd = () => setTimeout(() => addRef.current?.focus());

  // the bill follows ?rx=: a prescription opened from the queue or from Bills. Its own lines only: nothing from an earlier walk-in moves onto it.
  useEffect(() => {
    if (!sel || sel === 'walkin') { if (sel === 'walkin') fresh(EMPTY); return; }
    if (bill.rx?.encounterId === sel) return;
    let live = true; setLoading(true);
    get(`/pharmacy/rx/${sel}`).then((rx: any) => { if (live) fresh({ rx, who: rx.patient, lines: rxToLines(rx) }); }, (e) => toast(errText(e), 'err')).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [sel]);

  const choose = async (r: any) => {
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
    pick(r.encounterId); toAdd();
  };
  const inBill = (id: string) => bill.lines.filter((l) => l.medicineId === id).reduce((n, l) => n + (Number(l.qty) || 0), 0);
  const addMed = (m: any) => {
    if (!canBill) return;
    if (inBill(m.id) >= m.onHand) { toast(m.onHand > 0 ? `Only ${m.onHand} ${packLabel(m, m.onHand)} of ${m.name} in stock` : `${m.name} is out of stock`, 'info'); return; }
    // from the latest bill, so two quick adds never make two lines of one medicine
    setBill((b) => { const have = b.lines.find((l) => l.medicineId === m.id);
      return have ? { ...b, lines: b.lines.map((l) => (l.key === have.key ? { ...l, qty: String((Number(l.qty) || 0) + 1) } : l)) }
        : { ...b, lines: [...b.lines, { key: `x${m.id}`, medicineId: m.id, name: m.name, qty: '1', batchId: m.batches[0]?.id ?? '', reason: '', batches: m.batches, onHand: m.onHand, mrpPaise: m.mrpPaise, gstBp: m.gstBp, med: m }] }; });
    setFind(''); setAt(0); setLast(null);
  };
  const set = (key: string, patch: Partial<Line>) => setBill((b) => ({ ...b, lines: b.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) }));
  const step = (l: Line, by: number) => set(l.key, { qty: String(Math.max(0, Math.min(l.onHand, (Number(l.qty) || 0) + by))) });
  const remove = (l: Line) => setBill((b) => ({ ...b, lines: b.lines.filter((x) => x.key !== l.key) }));
  const reset = () => { fresh(EMPTY); pick(null); };
  const unpark = () => { if (!parked) return; pick(null); fresh(parked); setParked(null); };
  const clearBill = async () => {
    if (bill.lines.some((l) => Number(l.qty) > 0)) { const ok = await ask({ title: 'Clear this bill?', body: 'Nothing is saved. A prescription stays on the list.', confirmLabel: 'Clear', tone: 'danger' }); if (!ok) return false; }
    reset(); return true;
  };
  const walkIn = async () => { if (canBill && (await clearBill())) setTimeout(() => root.current?.querySelector<HTMLInputElement>('[data-walk-name]')?.focus(), 60); };

  // no prescription and nobody picked: a walk-in with no record (their name and phone go on the bill)
  const rx = bill.rx; const who = rx ? bill.who : bill.who ?? { walkIn: true, fullName: '', phone: '' }; const lines = bill.lines;
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
  // a prescription-only medicine that is not a line of our doctor's prescription: sold on another doctor's prescription, with its details
  const needsRx = issuing.find((l) => !l.rxItemId && isSched(l.med));
  const whoProblem = rx || who?.id ? '' : who?.find ? 'Find and pick the patient.' : (who?.fullName ?? '').trim().length < 2 ? "Enter the customer's name to take payment." : !/^[0-9]{10}$/.test(who?.phone ?? '') ? 'Enter the 10-digit phone number to take payment.' : '';
  const orxProblem = !needsRx ? '' : orx.doctor.trim().length < 2 ? `${needsRx.name} needs a prescription. Enter the doctor's name.` : orx.regNo.trim().length < 2 ? "Enter the doctor's registration number." : !orx.date ? 'Enter the date on the prescription.' : orx.date > today() ? 'The prescription date cannot be after today.' : '';
  const problem = issuing.length === 0 ? 'Nothing to sell yet.' : whoProblem || (overStock ? `${overStock.name}: only ${overStock.onHand} in stock.` : orxProblem
    || (overNoReason ? `${overNoReason.name}: ${overBy(overNoReason)} more than prescribed. Say why.` : total <= 0 ? 'The discount cannot be the whole bill.' : disc * 10000 > gross * capBp ? `Discounts above ${capBp / 100}% need the owner.` : ''));

  // Add a medicine: what matches the typing (name or molecule), names that start with it first; an out-of-stock one is followed by the same molecule in stock
  const medList: any[] = meds.data ?? [];
  const opts = useMemo(() => {
    const t = find.trim().toLowerCase(); if (!t) return [] as { m: any; alt?: boolean }[];
    const hit = medList.filter((m) => m.name.toLowerCase().includes(t) || (m.generic ?? '').toLowerCase().includes(t))
      .sort((a, b) => Number(b.name.toLowerCase().startsWith(t)) - Number(a.name.toLowerCase().startsWith(t))).slice(0, 8);
    const out: { m: any; alt?: boolean }[] = [];
    for (const m of hit) { out.push({ m }); if (m.onHand <= 0 && m.generic) for (const a of medList) if (a.onHand > 0 && a.form === m.form && (a.generic ?? '').toLowerCase() === m.generic.toLowerCase() && !hit.includes(a)) out.push({ m: a, alt: true }); }
    return out;
  }, [find, meds.data]);
  useEffect(() => { document.getElementById(`med-opt-${at}`)?.scrollIntoView({ block: 'nearest' }); }, [at]);

  const qtyEls = () => [...(root.current?.querySelectorAll<HTMLInputElement>('[data-qty]:not(:disabled)') ?? [])];
  const addKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const down = e.key === 'ArrowDown';
      if (opts.length) setAt((i) => Math.max(0, Math.min(opts.length - 1, i + (down ? 1 : -1)))); else { const els = qtyEls(); (down ? els[0] : els[els.length - 1])?.focus(); } }
    else if (e.key === 'Enter' && opts[at]) { e.preventDefault(); addMed(opts[at].m); }
    else if (e.key === 'Escape' && find) { e.preventDefault(); setFind(''); }
  };
  const qtyKey = (l: Line) => (e: React.KeyboardEvent<HTMLInputElement>) => {
    const els = qtyEls(); const i = els.indexOf(e.currentTarget);
    const to = (el?: HTMLElement) => { e.preventDefault(); (el ?? addRef.current)?.focus(); };
    if (e.key === 'ArrowUp') to(els[i - 1]); else if (e.key === 'ArrowDown') to(els[i + 1]); else if (e.key === 'Enter' || e.key === 'Escape') to();
    else if (e.key === '+' || e.key === '=') { e.preventDefault(); step(l, 1); } else if (e.key === '-') { e.preventDefault(); step(l, -1); }
    else if (e.key === 'Delete') { if (l.rxItemId) set(l.key, { qty: '0' }); else remove(l); to(els[i + 1] ?? els[i - 1]); }
  };
  // the counter's own keys; a popup or drawer on top keeps the keyboard to itself
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e) => {
    if (document.querySelector('.modal-back') || e.altKey) return;
    const k = e.key; const run = (fn: () => void) => { e.preventDefault(); fn(); };
    if (k === 'F2') run(() => addRef.current?.focus());
    else if (k === 'F4') run(walkIn);
    else if (k === 'F7') run(() => root.current?.querySelector<HTMLInputElement>('[data-discount] input')?.focus());
    else if (k === 'F8') run(() => root.current?.querySelector<HTMLElement>('[data-q]')?.focus());
    else if (k === 'F9') run(() => { if (!canBill || !lines.length) return; if (problem) toast(problem, 'info'); else setPaying(true); });
    else if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'p' && last) run(() => printSale(last.id));
  };
  useEffect(() => { const k = (e: KeyboardEvent) => keys.current(e); window.addEventListener('keydown', k); addRef.current?.focus(); return () => window.removeEventListener('keydown', k); }, []);
  const queueKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const els = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-q]')]; const i = els.indexOf(e.target as HTMLElement); if (i < 0) return;
    e.preventDefault(); els[i + (e.key === 'ArrowDown' ? 1 : -1)]?.focus();
  };

  const todayRx: any[] = d?.today ?? []; const toFill = todayRx.filter((r) => r.status === 'none' || r.status === 'part'); const doneRx = todayRx.filter((r) => r.status !== 'none' && r.status !== 'part');
  // a plain function, not a component: a component declared here would be a new type on every render and lose the keyboard focus
  const row = (r: any, sub?: string) => {
    const on = rx?.encounterId === r.encounterId;
    return (
      <button key={r.encounterId} type="button" data-q aria-pressed={on} disabled={!canBill} onClick={() => choose(r)} className={`flex w-full items-center gap-2 rounded-[8px] px-2.5 py-2 text-left hover:bg-paper-2 ${on ? 'bg-clay-soft' : ''}`}>
        <span className="min-w-0 flex-1"><b className="block truncate text-[13.5px] font-semibold">{r.patient.fullName}</b><small className="block truncate text-[12px] text-muted">{sub ?? [r.opNumber, r.doctor].filter(Boolean).join(' · ')}</small></span>
        <Chip tone={on ? 'clay' : r.status === 'issued' ? 'sage' : r.status === 'part' ? 'amber' : ''}>{on ? 'On the bill' : r.status === 'issued' ? 'Issued' : r.status === 'nothing' ? 'Bought elsewhere' : r.status === 'part' ? 'Part given' : `${r.items} to fill`}</Chip>
      </button>);
  };
  const head = (label: string, n?: number) => <div className="px-2.5 pb-1 pt-3 text-[11.5px] font-semibold uppercase tracking-wide text-muted">{label}{n !== undefined && <span className="ml-1.5 font-medium normal-case tracking-normal">{n}</span>}</div>;

  return (
    <div ref={root} className="anim-fade-up flex flex-col gap-2.5 xl:h-[calc(100dvh-172px)] xl:min-h-[540px]">
      {procAsk && <IssueSupplies sessionId={procAsk} canIssue={canBill} onClose={() => setProcAsk(null)} />}
      <div className="flex min-h-0 flex-1 flex-col gap-4 xl:flex-row">
        {/* the queue: who is waiting, what is done, and the way into a walk-in sale */}
        <aside aria-label="Queue" className="card flex shrink-0 flex-col !p-2 xl:w-[280px] xl:overflow-y-auto" onKeyDown={queueKey}>
          <button type="button" data-q aria-pressed={!rx} disabled={!canBill} onClick={walkIn} className={`flex w-full items-center gap-2.5 rounded-[8px] px-2.5 py-2.5 text-left hover:bg-paper-2 ${!rx ? 'bg-clay-soft' : ''}`}>
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-[6px] bg-paper-2 text-ink-2"><Icon name="plus" className="h-3.5 w-3.5" /></span>
            <span className="flex-1"><b className="block text-[13.5px] font-semibold">Walk-in sale</b><small className="block text-[12px] text-muted">No prescription from us</small></span><kbd className="kbd">F4</kbd>
          </button>
          {list.isLoading ? <div className="p-2.5"><Skeleton rows={3} /></div> : term ? <>
            {head('Found', (d?.found ?? []).length)}
            {(d?.found ?? []).length === 0 ? <div className="px-2.5 py-2 text-[12.5px] text-muted">No prescription in the last 30 days matches.</div> : d.found.map((r: any) => row(r, `${fmtDate(r.day)} · ${r.opNumber} · ${r.doctor ?? ''}`))}
          </> : <>
            {head('To fill', toFill.length + procs.filter((r) => r.status === 'asked').length)}
            {toFill.length === 0 && !procs.length && <div className="px-2.5 py-2 text-[12.5px] text-muted">No prescriptions waiting.</div>}
            {toFill.map((r) => row(r))}
            {procs.length > 0 && <div className="space-y-1.5 px-1 py-1">{procs.map((r) => <ProcAskCard key={r.sessionId} r={r} onOpen={() => setProcAsk(r.sessionId)} />)}</div>}
            {doneRx.length > 0 && <>{head('Done today', doneRx.length)}{doneRx.map((r) => row(r))}</>}
            {(d?.balances ?? []).length > 0 && <>
              <button type="button" className="flex w-full items-center gap-2 px-2.5 pb-1 pt-3 text-left text-[11.5px] font-semibold uppercase tracking-wide text-muted" aria-expanded={earlier} onClick={() => setEarlier(!earlier)}>Earlier prescriptions<span className="font-medium normal-case tracking-normal">{d.balances.length}</span><Icon name={earlier ? 'up' : 'chevR'} className="ml-auto h-3.5 w-3.5" /></button>
              {earlier && <><div className="px-2.5 pb-1 text-[11.5px] text-muted">Partly bought here. Nothing is owed: the rest may have been bought outside.</div>{d.balances.map((r: any) => row(r, `Rx ${fmtDate(r.day)} · ${r.balance.map((b: any) => `${b.name} ${b.left} left`).join(', ')}`))}</>}
            </>}
          </>}
        </aside>

        {/* the bill: customer on top, lines in the middle, the money always in view at the foot */}
        <section aria-label="This bill" className="card flex min-h-[420px] min-w-0 flex-1 flex-col overflow-hidden !p-0">
          <div className="space-y-2.5 px-4 pb-3 pt-3.5">
            {rx ? <div className="flex items-center gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-paper-2 text-[12px] font-bold text-ink-2">{initials(rx.patient.fullName)}</span>
              <div className="min-w-0 flex-1"><div className="truncate text-[16px] font-semibold">{rx.patient.fullName}</div><div className="truncate text-[12.5px] text-muted">{[rx.patient.patientNo, [rx.patient.ageYears, rx.patient.sex].filter(Boolean).join(' '), rx.patient.phone, rx.opNumber, rx.doctor, rx.diagnosis].filter(Boolean).join(' · ')}</div></div>
              {canBill && <button type="button" className="btn btn-sm btn-ghost" onClick={clearBill}><Icon name="x" className="h-3.5 w-3.5" />Clear</button>}
            </div> : <>
              <div className="flex items-center gap-3"><div className="flex-1 text-[16px] font-semibold">Walk-in sale</div>{lines.length > 0 && canBill && <button type="button" className="btn btn-sm btn-ghost" onClick={clearBill}><Icon name="x" className="h-3.5 w-3.5" />Clear</button>}</div>
              <WalkInPatient key={billKey} who={bill.who} setWho={(p) => setBill((b) => ({ ...b, who: p }))} />
            </>}
            {parked && <button type="button" className="w-full rounded-[8px] bg-amber-soft px-3 py-2 text-left text-[12.5px] text-[#6E4D10]" onClick={unpark}>A walk-in bill is set aside ({parked.lines.filter((l) => Number(l.qty) > 0).length} items). <b className="underline">Back to it</b></button>}
            {allergies && <div className="flex items-center gap-2.5 rounded-[8px] bg-rose-soft px-3 py-2 text-[13.5px] text-rose" role="alert"><span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-rose text-[12px] font-bold text-white">!</span><span><b>Allergic to {allergies}.</b> Check anything you add before you sell it.</span></div>}
            {rx?.bills?.length > 0 && <div className="text-xs text-muted">Already billed on this prescription: {rx.bills.map((b: any) => `${b.invoiceNo} (${money(b.totalPaise)})`).join(', ')}</div>}
            {needsRx && <div className="rounded-[8px] bg-amber-soft px-3 py-2.5">
              <div className="mb-2 text-[13px] font-semibold text-[#6E4D10]">Prescription from another doctor · needed for {issuing.filter((l) => !l.rxItemId && isSched(l.med)).map((l) => l.name).join(', ')}</div>
              <div className="grid gap-2 sm:grid-cols-[1.4fr_1fr_170px]">
                <label><span className="label">Doctor's name *</span><input autoFocus className="input" maxLength={100} aria-required value={orx.doctor} onChange={(e) => setOrx({ ...orx, doctor: e.target.value })} /></label>
                <label><span className="label">Registration number *</span><input className="input" maxLength={40} aria-required value={orx.regNo} onChange={(e) => setOrx({ ...orx, regNo: e.target.value })} /></label>
                <label><span className="label">Prescription date *</span><input type="date" className={`input ${orx.date > today() ? '!border-rose' : ''}`} max={today()} aria-required value={orx.date} onChange={(e) => setOrx({ ...orx, date: e.target.value })} /></label>
              </div>
              <div className="mt-1.5 text-[12px] text-[#6E4D10]">These go on the bill and in the Register.</div>
            </div>}
            {canBill && <div className="relative">
              <Icon name="search" className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
              <input ref={addRef} data-add className="input !min-h-[44px] !pl-10 !pr-14 text-[14.5px]" role="combobox" aria-label="Add a medicine" aria-expanded={!!find.trim()} aria-controls="med-opts" aria-autocomplete="list" aria-activedescendant={opts[at] ? `med-opt-${at}` : undefined}
                autoComplete="off" placeholder="Add a medicine: type its name" value={find} onChange={(e) => { setFind(e.target.value); setAt(0); }} onKeyDown={addKey} onBlur={() => setFind('')} />
              <kbd className="kbd pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">{find ? 'Esc' : 'F2'}</kbd>
              {find.trim() && <div id="med-opts" role="listbox" aria-label="Medicines" className="absolute inset-x-0 top-full z-20 mt-1 rounded-[10px] bg-surface p-1.5 shadow-[0_0_0_1px_rgba(9,9,11,.08),0_16px_36px_-12px_rgba(9,9,11,.22)]">
                <div className="max-h-[340px] overflow-y-auto">
                  {meds.isLoading ? <div className="p-3"><Skeleton rows={2} /></div> : opts.length === 0 ? <div className="px-3 py-3 text-[13px] text-muted">Not in the medicine list. Ask the owner to add it.</div> : opts.map(({ m, alt }, i) => {
                    const left = m.onHand - inBill(m.id); const b = m.batches[0]; const own = lines.some((l) => l.rxItemId && l.medicineId === m.id);
                    return (
                      <div key={m.id + (alt ? ':alt' : '')} id={`med-opt-${i}`} role="option" aria-selected={i === at} aria-disabled={left <= 0} onMouseEnter={() => setAt(i)} onMouseDown={(e) => { e.preventDefault(); addMed(m); }}
                        className={`flex cursor-pointer items-center gap-3 rounded-[8px] px-3 py-2 ${i === at ? 'bg-clay-soft' : ''} ${alt ? 'ml-5' : ''} ${left <= 0 ? 'text-muted' : ''}`}>
                        <span className="min-w-0 flex-1"><span className="block truncate">{alt && <span className="text-[12.5px] text-muted">Same medicine, in stock: </span>}<span className="font-medium">{m.name}</span><span className="ml-2 text-[12px] text-muted">{[formName(m.form), isSched(m) ? `Schedule ${m.scheduleClass}` : null].filter(Boolean).join(' · ')}</span></span>
                          <small className={`block truncate text-[12px] ${isSched(m) && !own ? 'text-[#92400E]' : 'text-muted'}`}>{isSched(m) && !own ? "Add it, then enter the doctor's name and registration number from the customer's prescription." : b ? `Batch ${b.batchNo} · exp ${exp(b.expiry)}` : ''}</small></span>
                        {isSched(m) && !own && <Chip tone="amber">Prescription only</Chip>}
                        {b && nearExpiry(b.expiry) && <Chip tone="amber">Expires {exp(b.expiry)}</Chip>}
                        <span className={`w-[68px] shrink-0 text-right text-[12.5px] ${left <= 0 ? 'text-rose' : left <= 10 ? 'text-amber' : 'text-ink-2'}`}>{left <= 0 ? 'None left' : `${left} left`}</span>
                        <b className="w-[58px] shrink-0 text-right">{money(m.mrpPaise)}</b>
                      </div>);
                  })}
                </div>
                <div className="mt-1.5 flex gap-4 border-t border-line px-3 pb-0.5 pt-2 text-[12px] text-muted"><span><kbd className="kbd">↑</kbd> <kbd className="kbd">↓</kbd> Move</span><span><kbd className="kbd">Enter</kbd> Add to the bill</span><span><kbd className="kbd">Esc</kbd> Close</span></div>
              </div>}
            </div>}
          </div>

          <div className={`${GRID} border-y border-line bg-surface-2 px-4 py-2 text-[11.5px] font-semibold uppercase tracking-wide text-muted`}><span>Medicine</span><span>Quantity</span><span className="text-right">MRP</span><span className="text-right">Amount</span><span /></div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {loading ? <div className="p-4"><Skeleton rows={3} /></div> : lines.length === 0 ? (
              <div className="grid h-full min-h-[180px] place-items-center px-4 py-8 text-center">
                {last ? <div role="status">
                  <span className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-full bg-clay text-white"><Icon name="check" className="h-5 w-5" /></span>
                  <div className="text-[16px] font-semibold">Saved {last.invoiceNo} · {money(last.totalPaise)}</div>
                  <div className="mt-1 text-[13px] text-muted">{last.change > 0 ? <>Give change <b className="text-ink">{money(last.change)}</b>. </> : null}Ready for the next customer.</div>
                  <div className="mt-4 flex justify-center gap-2"><button type="button" className="btn btn-sm" onClick={() => printSale(last.id)}><Icon name="print" className="h-3.5 w-3.5" />Print again<kbd className="kbd ml-1">Ctrl P</kbd></button>
                    {last.method !== 'split' && <button type="button" className="btn btn-sm btn-ghost" title="Wrong patient or item? Within 10 minutes: stock goes back and the money is refunded" onClick={() => setUndo(true)}><Icon name="undo" className="h-3.5 w-3.5" />Undo this bill</button>}</div>
                </div> : <div><div className="text-[15px] font-semibold">{rx ? 'Nothing on this prescription' : 'Ready for the next customer'}</div><div className="mx-auto mt-1 max-w-[340px] text-[13px] text-muted">Pick a prescription from the queue, or type a medicine name to start a walk-in sale.</div></div>}
              </div>
            ) : lines.map((l) => {
              const n = Number(l.qty) || 0; const done = l.rxItemId !== undefined && (l.left ?? 0) === 0; const short = l.rxItemId ? (l.left ?? 0) - n : 0; const b = l.batches.find((x) => x.id === l.batchId);
              return (
                <div key={l.key} className={`border-b border-line/70 px-4 py-2.5 ${n === 0 && !done ? 'opacity-60' : ''}`}>
                  <div className={GRID}>
                    <span className="min-w-0"><span className="flex flex-wrap items-center gap-1.5"><b className="text-[13.5px] font-semibold leading-snug">{l.name}</b>{l.rxItemId && <Chip tone="clay">Prescribed</Chip>}{!l.rxItemId && isSched(l.med) && <Chip tone="amber">Prescription only</Chip>}
                        {n > 0 && b && nearExpiry(b.expiry) && <span title="This batch expires within 60 days"><Chip tone="amber">Expires {exp(b.expiry)}</Chip></span>}</span>
                      <small className={`block truncate text-[12px] ${l.medicineId && l.onHand === 0 ? 'text-rose' : 'text-muted'}`}>{!l.medicineId ? 'Not in the medicine list' : l.onHand === 0 ? (can(perms, 'stock.read') ? <Link className="underline" to={`/inventory?tab=stock&item=${l.medicineId}`}>Out of stock · see in Inventory</Link> : 'Out of stock') : l.rxItemId ? [l.doctorQty && ['tab', 'cap'].includes(l.med?.form ?? '') ? `Doctor: ${l.doctorQty} = ${l.prescribed} ${packLabel(l.med, l.prescribed ?? 1)}` : `${l.prescribed} ${packLabel(l.med, l.prescribed ?? 1)} prescribed`, (l.issued ?? 0) > 0 ? `${l.issued} issued before` : null, b ? `Batch ${b.batchNo} · exp ${exp(b.expiry)}` : null, l.how].filter(Boolean).join(' · ') : b ? `Batch ${b.batchNo} · exp ${exp(b.expiry)}` : ''}</small></span>
                    {done ? <span><Chip tone="sage">Issued</Chip></span> : <span className="flex w-fit items-center rounded-[6px] shadow-[var(--ring)]">
                      <button type="button" tabIndex={-1} className="grid h-8 w-8 place-items-center text-[16px] font-bold text-ink-2 hover:bg-paper-2 disabled:opacity-40" aria-label={`One less ${l.name}`} disabled={!l.medicineId || !canBill || n === 0} onClick={() => step(l, -1)}>−</button>
                      <NumInput data-qty aria-label={`Quantity of ${l.name}`} className={`h-8 w-11 bg-transparent text-center text-[13.5px] font-semibold ${n > l.onHand ? 'text-rose' : ''}`} max={999} disabled={!l.medicineId || !canBill} value={l.qty} onFocus={(e) => e.target.select()} onKeyDown={qtyKey(l)} onChange={(e) => set(l.key, { qty: e.target.value })} />
                      <button type="button" tabIndex={-1} className="grid h-8 w-8 place-items-center text-[16px] font-bold text-ink-2 hover:bg-paper-2 disabled:opacity-40" aria-label={`One more ${l.name}`} disabled={!l.medicineId || !canBill || n >= l.onHand} onClick={() => step(l, 1)}>+</button>
                    </span>}
                    <span className="text-right text-[13px] text-muted">{l.medicineId ? money(b?.mrpPaise ?? l.mrpPaise) : ''}</span>
                    <b className="text-right text-[13.5px]">{n > 0 ? money(lineAmount(l)) : '—'}</b>
                    {!l.rxItemId && canBill ? <button type="button" tabIndex={-1} className="grid h-7 w-7 place-items-center rounded-[6px] text-muted hover:bg-paper-2 hover:text-ink" aria-label={`Remove ${l.name}`} onClick={() => remove(l)}><Icon name="x" className="h-3.5 w-3.5" /></button> : <span />}
                  </div>
                  {overBy(l) > 0 && <div className="mt-2 flex flex-wrap items-center gap-2 rounded-[6px] bg-amber-soft px-2.5 py-1.5">
                    <span className="text-[12px] font-semibold text-[#6E4D10]">{overBy(l)} more than prescribed. Reason?</span>
                    <input aria-label={`Why more ${l.name} than prescribed`} className={`input !min-h-0 !w-auto flex-1 !py-1 !text-xs ${(l.overReason ?? '').trim().length < 3 ? '!border-amber' : ''}`} maxLength={120} placeholder="e.g. doctor phoned, course extended" value={l.overReason ?? ''} onChange={(e) => set(l.key, { overReason: e.target.value })} />
                  </div>}
                  {(l.batches.length > 1 && n > 0) || (l.rxItemId && !done && short > 0) ? <div className="mt-2 flex flex-wrap items-center gap-2">
                    {l.batches.length > 1 && n > 0 && <select aria-label={`Batch for ${l.name}`} className="input !min-h-0 !w-auto !py-1 !text-xs" value={l.batchId} onChange={(e) => set(l.key, { batchId: e.target.value })}>{l.batches.map((x) => <option key={x.id} value={x.id}>{x.batchNo} · exp {exp(x.expiry)}{nearExpiry(x.expiry) ? ' (soon)' : ''} · {x.qty} left</option>)}</select>}
                    {l.rxItemId && !done && short > 0 && <><span className="text-[12px] text-muted">{n === 0 ? 'Not given' : `${short} not given`}</span>
                      <select aria-label={`Reason for ${l.name}`} className="input !min-h-0 !w-auto !py-1 !text-xs" value={l.reason} onChange={(e) => set(l.key, { reason: e.target.value })}><option value="">Reason (optional)</option>{REASONS.map((r) => <option key={r}>{r}</option>)}</select></>}
                  </div> : null}
                </div>);
            })}
          </div>

          {canBill && <div className="border-t border-line bg-surface px-4 py-3">
            <div className="flex flex-wrap items-end gap-x-5 gap-y-3">
              <div className="mr-auto text-[13px] text-muted">
                <div>{rx ? `${rxLines.filter((l) => Number(l.qty) > 0).length} of ${rxLines.length} prescribed · ` : ''}{units} {units === 1 ? 'item' : 'items'} · <span className="text-ink-2">₹{rupees2(gross)}</span></div>
                <div>GST included ₹{rupees2(gst)}</div>
                {rxLines.some((l) => (l.left ?? 0) - (Number(l.qty) || 0) > 0 && Number(l.qty) > 0) && <div className="text-[12px]">The patient can come back for the rest within 30 days, or buy it outside.</div>}
              </div>
              <label data-discount className="block"><span className="label">Discount <kbd className="kbd">F7</kbd></span><MoneyInput label="Discount" className={`!w-32 ${disc * 10000 > gross * capBp ? '[&_input]:!border-rose' : ''}`} value={discount} onChange={setDiscount} /></label>
              <div className="text-right"><div className="text-[12px] font-medium text-muted">To pay</div><div className="text-[28px] font-semibold leading-none tracking-tight">{money(total)}</div></div>
              <div className="flex gap-2">
                {rx && rx.status !== 'issued' && rx.status !== 'part' && <button type="button" className="btn btn-ghost !min-h-[44px]" disabled={nothing.isPending} onClick={async () => { const a = await ask({ title: 'Buying elsewhere?', body: 'The prescription stays in the patient’s history; it just leaves the counter list.', confirmLabel: 'Not from us', field: { label: 'Reason (optional)', maxLength: 80 } }); if (a) nothing.mutate(a.value); }}>Not buying here</button>}
                {rx && rx.status === 'part' && <button type="button" className="btn btn-ghost !min-h-[44px]" disabled={outside.isPending} onClick={async () => { const a = await ask({ title: 'Rest bought outside?', body: 'What was issued here stays on the bills. The prescription leaves the earlier list.', confirmLabel: 'Rest bought outside', field: { label: 'Reason (optional)', maxLength: 80 } }); if (a) outside.mutate(a.value); }}>Rest bought outside</button>}
                <button type="button" className="btn btn-primary !min-h-[44px] min-w-[190px] text-[14.5px]" disabled={!!problem} onClick={() => setPaying(true)}><Icon name="rupee" />Take payment<kbd className="kbd ml-1 !bg-white/20 !text-white">F9</kbd></button>
              </div>
            </div>
            {problem && lines.length > 0 && <div className="mt-2 text-right text-[12.5px] text-rose" role="alert">{problem}</div>}
          </div>}
        </section>
      </div>
      <div aria-label="Keyboard keys" className="hidden flex-wrap justify-center gap-x-4 gap-y-1 text-[12px] text-muted xl:flex">{KEYS.map(([k, what]) => <span key={k}><kbd className="kbd">{k}</kbd> {what}</span>)}</div>

      {paying && <PayDialog total={total} patient={who} saleKey={billKey} upiId={cfg?.tenant?.settings?.upiId ?? cfg?.tenant?.settings?.pharmacy?.upiId ?? null} payee={cfg?.tenant?.name ?? ''} onClose={() => setPaying(false)} build={() => ({
        ...(who.id ? { patientId: who.id } : who.walkIn ? { walkIn: { fullName: who.fullName.trim(), phone: who.phone } } : { newPatient: { fullName: who.fullName.trim(), phone: who.phone, ageYears: who.ageYears ? Number(who.ageYears) : undefined } }),
        encounterId: rx?.encounterId, discountPaise: disc, outsideRx: needsRx ? { doctor: orx.doctor.trim(), regNo: orx.regNo.trim(), date: orx.date } : undefined,
        items: issuing.map((l) => ({ medicineId: l.medicineId!, qty: Number(l.qty), batchId: l.batchId || undefined, prescriptionItemId: l.rxItemId, overReason: overBy(l) > 0 ? l.overReason?.trim() : undefined })),
        notIssued: rxLines.filter((l) => (l.left ?? 0) > (Number(l.qty) || 0)).map((l) => ({ prescriptionItemId: l.rxItemId!, reason: l.reason || null })),
      })} onDone={(s, change) => { setPaying(false); setLast({ ...s, change, bill, discount, orx }); reset(); toAdd(); }} />}
      {undo && last && <VoidDialog sale={last} onClose={() => setUndo(false)} onDone={() => {
        // the bill comes back as it was, with a fresh key (the old one belongs to the undone sale); a prescription is read again, so its quantities are today's
        const b: Bill = last.bill; setUndo(false); setLast(null);
        if (b.rx) pick(b.rx.encounterId);
        else { setBill(b.who && !b.who.id && !b.who.walkIn ? { ...b, who: { ...b.who, id: last.patientId } } : b); setDiscount(last.discount); setOrx(last.orx); setBillKey(newKey()); }
        ['pharmacy', 'stock', 'reports', 'patients'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
        toast('Bill undone · the items are back on the bill'); toAdd();
      }} />}
    </div>
  );
}

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

/**
 * The bill's customer when there is no prescription from us. A walk-in with no record (name and phone, kept on the bill
 * only), one of our patients, or a new patient record. A name and a 10-digit phone are needed either way.
 */
function WalkInPatient({ who, setWho }: { who: any; setWho: (p: any) => void }) {
  // starts from the bill's customer (a bill set aside comes back as it was)
  const [mode, setMode] = useState<'walkin' | 'existing' | 'new'>(who?.id || who?.find ? 'existing' : who && !who.walkIn ? 'new' : 'walkin'); const [find, setFind] = useState('');
  const [f, setF] = useState({ fullName: who?.id ? '' : who?.fullName ?? '', phone: who?.id ? '' : who?.phone ?? '', ageYears: who?.ageYears && !who.id ? String(who.ageYears) : '' });
  const pts = useQuery({ queryKey: ['palette', find], queryFn: () => get(`/patients?q=${encodeURIComponent(find)}`), enabled: mode === 'existing' && !who?.id && find.trim().length >= 2 });
  // the bill always knows what is typed so far; the counter says what is still missing
  useEffect(() => { if (!who?.id) setWho(mode === 'existing' ? { find: true } : mode === 'walkin' ? { walkIn: true, fullName: f.fullName, phone: f.phone } : { fullName: f.fullName, phone: f.phone, ageYears: f.ageYears }); }, [f, mode]);
  if (who?.id) return <div className="flex items-center gap-2.5 rounded-[8px] bg-surface-2 px-3 py-2 shadow-[var(--ring)]"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-paper-2 text-[12px] font-bold text-ink-2">{initials(who.fullName)}</span><span className="min-w-0 flex-1"><b className="block truncate text-[13.5px]">{who.fullName}</b><small className="text-[12px] text-muted">{[who.patientNo, [who.ageYears, who.sex].filter(Boolean).join(' '), who.phone ?? 'No phone'].filter(Boolean).join(' · ')}</small></span><button type="button" className="btn btn-sm" onClick={() => { setWho({ find: true }); setMode('existing'); }}>Change</button></div>;
  const found: any[] = (pts.data ?? []).slice(0, 5);
  const badPhone = !!f.phone && !/^[0-9]{10}$/.test(f.phone);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex gap-1.5" role="group" aria-label="Customer">{([['walkin', 'Walk-in (no profile)'], ['existing', 'Our patient'], ['new', 'New patient']] as const).map(([k, l]) => <button key={k} type="button" aria-pressed={mode === k} className={`toggle-opt justify-center ${mode === k ? 'on' : ''}`} onClick={() => setMode(k)}>{l}</button>)}</div>
      {mode === 'existing' ? <div className="relative min-w-[220px] flex-1">
        <input className="input" data-walk-name aria-label="Find patient" placeholder="Name, phone or patient ID" autoComplete="off" value={find} onChange={(e) => setFind(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && found[0]) { e.preventDefault(); setWho(found[0]); } }} />
        {find.trim().length >= 2 && !pts.isLoading && <div className="absolute inset-x-0 top-full z-20 mt-1 rounded-[10px] bg-surface p-1.5 shadow-[0_0_0_1px_rgba(9,9,11,.08),0_16px_36px_-12px_rgba(9,9,11,.22)]">
          {found.length === 0 ? <div className="px-3 py-2 text-[13px] text-muted">No patient matches.</div> : found.map((p: any, i: number) => <button key={p.id} type="button" className={`flex w-full items-center gap-2 rounded-[8px] px-3 py-2 text-left text-sm hover:bg-paper-2 ${i === 0 ? 'bg-clay-soft' : ''}`} onClick={() => setWho(p)}><span className="flex-1 truncate">{p.fullName}</span><span className="text-xs text-muted">{p.patientNo} · {p.phone ?? ''}</span></button>)}
        </div>}
      </div> : <>
        <input className="input min-w-[160px] flex-[1.2]" data-walk-name aria-label="Customer name" aria-required placeholder="Customer name *" maxLength={100} autoComplete="off" value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} />
        <input className={`input min-w-[140px] flex-1 ${badPhone ? '!border-rose' : ''}`} aria-label="Phone number" aria-required aria-invalid={badPhone} inputMode="numeric" maxLength={10} autoComplete="off" placeholder="Phone number *" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value.replace(/\D/g, '') })}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); document.querySelector<HTMLInputElement>('[data-add]')?.focus(); } }} />
        {mode === 'new' && <input className="input !w-[76px]" aria-label="Age" inputMode="numeric" maxLength={3} placeholder="Age" autoComplete="off" value={f.ageYears} onChange={(e) => setF({ ...f, ageYears: e.target.value.replace(/\D/g, '') })} />}
      </>}
    </div>
  );
}

/** Payment: cash, UPI, card or split. Cash fills the remainder and shows the change; the receipt prints and/or goes on WhatsApp. */
function PayDialog({ total, patient, saleKey, upiId, payee, build, onClose, onDone }: { total: number; patient: any; saleKey: string; upiId: string | null; payee: string; build: () => any; onClose: () => void; onDone: (sale: any, changePaise: number) => void }) {
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
      onDone(s, Math.max(0, change));
    },
    onError: (e) => toast(phErr(e), 'err'),
  });
  const pay = () => { setTried(true); if (!problem && !save.isPending) save.mutate(); };
  const MODES = ['cash', 'upi', 'card', 'split'] as const;
  return (
    <Modal title={`Take payment · ${money(total)}`} subtitle={patient?.fullName || (patient?.walkIn ? 'Walk-in' : undefined)} onClose={onClose} width="max-w-2xl" submitOnEnter>
      <div className="space-y-4">
        {/* opens on the payment type: left and right change it, Tab goes on to the amounts, Enter saves */}
        <div className="flex gap-1.5" role="radiogroup" aria-label="Payment type" onKeyDown={(e) => {
          const i = MODES.indexOf(mode); const n = e.key === 'ArrowRight' ? MODES[(i + 1) % 4] : e.key === 'ArrowLeft' ? MODES[(i + 3) % 4] : null;
          if (n) { e.preventDefault(); setMode(n); e.currentTarget.querySelector<HTMLElement>(`[data-mode="${n}"]`)?.focus(); } else if (e.key === 'Enter') { e.preventDefault(); pay(); }
        }}>{MODES.map((m) => <button key={m} type="button" role="radio" aria-checked={mode === m} data-mode={m} data-autofocus={m === 'cash' ? '' : undefined} tabIndex={mode === m ? 0 : -1} className={`toggle-opt flex-1 justify-center ${mode === m ? 'on' : ''}`} onClick={() => setMode(m)}>{m === 'upi' ? 'UPI' : m[0].toUpperCase() + m.slice(1)}</button>)}</div>
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
      <div className="modal-foot"><span className="mr-auto hidden self-center text-[12px] text-muted sm:block"><kbd className="kbd">←</kbd> <kbd className="kbd">→</kbd> Payment type · <kbd className="kbd">Tab</kbd> Next box · <kbd className="kbd">Esc</kbd> Back</span>
        <button type="button" className="btn btn-ghost" onClick={onClose}>Back to items</button><button type="button" className="btn btn-primary" disabled={save.isPending} onClick={pay}><Icon name="check" />Paid · Save bill<kbd className="kbd ml-1 !bg-white/20 !text-white">Enter</kbd></button></div>
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
    { key: 'patient', label: 'Patient', sort: (r) => r.patient.fullName.toLowerCase(), csv: (r) => r.patient.fullName, cell: (r) => <div><div className="font-semibold">{r.patient.fullName}</div><div className="text-[12px] text-muted">{r.encounterId ? `Rx ${r.doctor ?? ''}` : r.outsideRx ? 'Outside prescription' : 'No prescription'}</div></div> },
    { key: 'items', label: 'Items', sort: (r) => r.items, csv: (r) => r.items, cell: (r) => <span className="text-[13px]">{r.items} item{r.items === 1 ? '' : 's'}{r.balance.length > 0 && <span className="ml-1.5 text-[12px] text-muted">· {r.balance.map((b: any) => b.left).reduce((a: number, b: number) => a + b, 0)} left on Rx</span>}{r.notIssued > 0 && <span className="ml-1.5 text-[12px] text-muted">· {r.notIssued} not given</span>}</span> },
    { key: 'amount', label: 'Amount', align: 'right', sort: (r) => r.totalPaise, csv: (r) => (r.totalPaise / 100).toFixed(2), cell: (r) => <div className="whitespace-nowrap font-semibold">{money(r.totalPaise)}{r.refundPaise > 0 && <div className="text-[12px] text-rose">− {money(r.refundPaise)}</div>}</div> },
    { key: 'paid', label: 'Paid by', sort: (r) => r.method, csv: (r) => r.method, cell: (r) => <span className="text-[12px] font-semibold uppercase text-muted">{r.method === 'split' ? r.payments.map((p: any) => p.method).join(' + ') : r.method}</span> },
  ];
  return (
    <div className="space-y-4">
      {t && <div className="card flex flex-wrap !p-0">
        {[['Net sales', money(t.total - t.refunds), `${t.count} bill${t.count === 1 ? '' : 's'}${t.returns ? ` · ${t.returns} return${t.returns === 1 ? '' : 's'}` : ''}`], ['Cash in drawer should be', money(t.cash ?? 0), t.refunds ? `after ${money(t.refunds)} refunds` : 'cash payments'], ['UPI', money(t.upi ?? 0), ''], ['Card', money(t.card ?? 0), ''],
          ['Bought elsewhere', `${list.data.rx.notBought} of ${list.data.rx.total}`, 'prescriptions · for the doctor to know']].map(([l, v, s]) => <div key={l} className="min-w-[150px] flex-1 border-l border-line px-4 py-2.5 first:border-l-0"><div className="text-[12px] font-medium text-muted">{l}</div><div className="text-[17px] font-semibold tracking-tight">{v}</div>{s && <div className="text-[11.5px] text-muted">{s}</div>}</div>)}
      </div>}
      <DataTable id="pharmacy-bills" exportName={`pharmacy-bills-${span[0]}-to-${span[1]}`} rows={rows} rowKey={(r) => r.id} columns={columns}
            loading={list.isLoading} onRow={(r) => pick(r.id)} selected={sel} sort={{ key: 'time', dir: -1 }}
            search={{ placeholder: 'Find a bill: number, patient or phone' }} filters={[RANGE, PAID]}
            empty={{ title: bad ? 'Check the dates' : 'No bills in this range', hint: bad ? '“From” is after “to”.' : undefined }}
            toolbar={range === 'custom' && <span className="inline-flex items-center gap-1.5 text-[12.5px] text-muted">
              <input type="date" aria-label="From" className={`dt-select ${bad ? '!border-rose' : ''}`} value={from} onChange={(e) => setDate('from', e.target.value)} />to
              <input type="date" aria-label="To" className={`dt-select ${bad ? '!border-rose' : ''}`} value={to} onChange={(e) => setDate('to', e.target.value)} /></span>} />
      {sel && <BillDetail key={sel} id={sel} onClose={() => pick(null)} onIssue={onIssue} />}
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
  if (q.isLoading || !s) return <Drawer title="Bill" onClose={onClose} width="max-w-xl"><Skeleton rows={4} /></Drawer>;
  const orx = s.items.find((l: any) => l.outsideRx)?.outsideRx;
  const tooMuch = lines.some((l) => l.qty > back[l.line]);
  const problem = !lines.length ? 'Enter how many come back.' : tooMuch ? 'More than was sold on this bill.' : reason.trim().length < 3 ? 'Give a reason.' : m !== 'cash' && ref.trim().length < 4 ? 'Enter the refund reference.' : '';
  return (
    <Drawer title={`${s.invoiceNo} · ${s.patient.fullName}`} onClose={onClose} width="max-w-xl"><div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn btn-sm" data-autofocus onClick={() => printSale(s.id)}><Icon name="print" />Reprint</button>
        {s.encounterId && s.notIssued?.length > 0 && can(perms, 'pharmacy.bill') && <button className="btn btn-sm" onClick={() => onIssue(s.encounterId)}>Issue the rest</button>}
      </div>
      <div className="text-xs text-muted">{new Date(s.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' })} · {s.doctor ? `Rx ${s.doctor}` : orx ? `Prescription from ${orx.doctor} (Reg. no. ${orx.regNo}), ${fmtDate(orx.date)}` : 'No prescription'}{s.patient.phone ? ` · ${s.patient.phone}` : ''} · {s.payments.map((p: any) => `${p.method.toUpperCase()} ${money(p.amountPaise)}${p.reference ? ` (${p.reference})` : ''}`).join(' + ')}</div>
      <div className="text-[13px]">
        {s.items.map((l: any, i: number) => <div key={i} className="flex justify-between gap-3 border-b border-line/60 py-1.5"><span className="min-w-0"><span className="block truncate font-medium">{l.name}</span><small className="text-muted">{l.qty} × {money(l.mrpPaise)}{l.batchNo ? ` · Batch ${l.batchNo} · exp ${exp(l.expiry)}` : ''}</small></span><span className="shrink-0">{money(l.amountPaise)}</span></div>)}
        {s.discountPaise > 0 && <div className="flex justify-between pt-1.5 text-muted"><span>Discount</span><span>− {money(s.discountPaise)}</span></div>}
        <div className="flex justify-between pt-1.5 text-[15px] font-semibold"><span>Total</span><span>{money(s.totalPaise)}</span></div>
      </div>
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
    </div></Drawer>
  );
}

/** Pharmacy receipt in the print popup: batch and expiry on every line, doctor, GST split, payments, and what was not issued. */
export async function printSale(id: string) {
  try {
    const x = await get(`/pharmacy/sale/${id}`);
    // GST: a clinic with a GSTIN issues a Tax Invoice with CGST/SGST per rate; without one it may not charge GST and issues a Bill of Supply
    const gstin = !!x.clinic.gstin; const title = gstin ? 'Tax Invoice' : 'Bill of Supply'; const orx = x.items.find((l: any) => l.outsideRx)?.outsideRx;
    const byRate = new Map<number, { value: number; tax: number }>();
    for (const l of x.items) { // the bill discount is shared out over the lines, as on the server
      const net = x.grossPaise ? Math.round((l.amountPaise * x.totalPaise) / x.grossPaise) : l.amountPaise; const value = Math.round((net * 10000) / (10000 + l.gstBp));
      const r = byRate.get(l.gstBp) ?? { value: 0, tax: 0 }; r.value += value; r.tax += net - value; byRate.set(l.gstBp, r);
    }
    const rates = [...byRate].sort((a, b) => a[0] - b[0]);
    const taxRows = gstin ? `<table><tr><th>GST rate</th><th>Taxable value</th><th>CGST</th><th>SGST</th></tr>${rates.map(([bp, r]) => { const h = Math.floor(r.tax / 2); return `<tr><td>${bp / 100}%</td><td>${rupees2(r.value)}</td><td>${rupees2(h)}</td><td>${rupees2(r.tax - h)}</td></tr>`; }).join('')}</table>` : '';
    const html = `<!doctype html><title>${esc(x.invoiceNo)}</title><style>body{font:13px system-ui,sans-serif;margin:18px;color:#111;max-width:420px}h1{font-size:16px;margin:0}table{width:100%;border-collapse:collapse;margin:8px 0}th,td{padding:3px 2px;text-align:right;vertical-align:top}th:first-child,td:first-child{text-align:left}th{border-bottom:1px dashed #999;font-weight:600}.m{color:#555;font-size:11.5px}.t td{padding:1px 2px}.b{font-weight:700;font-size:15px}hr{border:0;border-top:1px dashed #999}</style>
${x.clinic.logoUrl ? `<img src="${esc(x.clinic.logoUrl)}" alt="" style="display:block;height:44px;max-width:150px;object-fit:contain;margin-bottom:6px">` : ''}<h1>${esc(x.clinic.name)} · Pharmacy</h1><div class="m">${esc(x.clinic.address ?? '')}${x.clinic.gstin ? ' · GSTIN ' + esc(x.clinic.gstin) : ''}${x.clinic.drugLicence ? ' · DL ' + esc(x.clinic.drugLicence) : ''}</div><hr>
<div style="text-align:center;font-weight:700;margin-bottom:4px">${title}</div><div><b>Bill ${esc(x.invoiceNo)}</b> · <span class="m">${new Date(x.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' })}</span></div>
<div class="m">${x.walkIn ? 'Customer' : 'Patient'}: ${esc(x.patient.fullName)}${x.patient.patientNo ? ` (${esc(x.patient.patientNo)})` : ''}${x.patient.ageYears ? ', ' + esc(x.patient.ageYears) + ' ' + esc(x.patient.sex ?? '') : ''}${x.walkIn && x.patient.phone ? ', ' + esc(x.patient.phone) : ''}${x.doctor ? '<br>Doctor: ' + esc(x.doctor) : ''}${orx ? '<br>Prescription from: ' + esc(orx.doctor) + ', Reg. no. ' + esc(orx.regNo) + ', dated ' + esc(fmtDate(orx.date)) : ''}</div><hr>
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
