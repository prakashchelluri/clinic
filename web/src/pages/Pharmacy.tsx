import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useOutletContext, useSearchParams } from 'react-router';
import { get, post, qc, today, fmtTime, errText } from '../api';
import { can } from '../App';
import { openPrint } from '../printPreview';
import { Chip, Empty, Icon, Modal, PageHeader, Segmented, Skeleton, money, toast, MoneyInput, toPaise, NumInput, ask, fmtDate } from '../ui';
import { StockTab, OrdersTab, VendorsTab } from './pharmacyStock';

type Tab = 'counter' | 'bills' | 'stock' | 'orders' | 'vendors';
const REASONS = ['Has at home', 'Will buy later', 'Bought outside', 'Out of stock', 'Too costly', 'Doctor said not needed'];
const exp = (d: string) => d.slice(5, 7) + '/' + d.slice(2, 4);
const rupees2 = (p: number) => (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (x: unknown) => String(x ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const packLabel = (m: { form?: string | null; packSize?: number } | null | undefined, n = 1) => !m ? '' : ['tab', 'cap'].includes(m.form ?? '') ? `strip${n === 1 ? '' : 's'}` : (m.form ?? 'pack') + (n === 1 ? '' : 's');
const pref = (k: string, d: boolean) => { try { const v = localStorage.getItem(k); return v === null ? d : v === '1'; } catch { return d; } };
const setPref = (k: string, v: boolean) => { try { localStorage.setItem(k, v ? '1' : '0'); } catch { /* private mode */ } };

/** Pharmacy: the counter (prescriptions to pick from, issue what the patient buys), bills and returns, and stock. */
export function Pharmacy() {
  const { perms } = useOutletContext<any>();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as Tab) || 'counter';
  const go = (next: Record<string, string>) => setSp(next);
  useEffect(() => { if (sp.get('sale')) go({ tab: 'counter', rx: 'walkin' }); }, [sp]);
  const stock = can(perms, 'stock.read');
  const tabs: { value: Tab; label: string }[] = [{ value: 'counter', label: 'Counter' }, { value: 'bills', label: 'Bills' }, ...(stock ? [{ value: 'stock' as Tab, label: 'Stock' }, { value: 'orders' as Tab, label: 'Orders' }, { value: 'vendors' as Tab, label: 'Vendors' }] : [])];
  return (
    <div>
      <PageHeader title="Pharmacy">
        <Segmented<Tab> value={tab} onChange={(v) => go({ tab: v })} options={tabs} />
        {can(perms, 'pharmacy.bill') && <button className="btn btn-primary" onClick={() => go({ tab: 'counter', rx: 'walkin' })}><Icon name="plus" />Walk-in sale</button>}
      </PageHeader>
      {tab === 'counter' && <Counter sel={sp.get('rx')} pick={(rx) => go(rx ? { tab: 'counter', rx } : { tab: 'counter' })} />}
      {tab === 'bills' && <Bills sel={sp.get('bill')} pick={(bill) => go(bill ? { tab: 'bills', bill } : { tab: 'bills' })} onIssue={(rx) => go({ tab: 'counter', rx })} />}
      {tab === 'stock' && stock && <StockTab sp={sp} go={go} />}
      {tab === 'orders' && stock && <OrdersTab sp={sp} go={go} />}
      {tab === 'vendors' && stock && <VendorsTab sp={sp} go={go} />}
    </div>
  );
}

/* ---------------- Counter ---------------- */

function Counter({ sel, pick }: { sel: string | null; pick: (rx: string | null) => void }) {
  const { perms } = useOutletContext<any>();
  const [q, setQ] = useState('');
  const term = q.trim().length >= 2 ? q.trim() : '';
  const list = useQuery({ queryKey: ['pharmacy', 'counter', term], queryFn: () => get(`/pharmacy/counter${term ? `?q=${encodeURIComponent(term)}` : ''}`), refetchInterval: 15000 });
  const d = list.data;
  const Row = ({ r, sub }: { r: any; sub?: string }) => (
    <button onClick={() => pick(r.encounterId)} aria-pressed={sel === r.encounterId} className={`flex w-full items-center gap-2 rounded-2xl px-3 py-2.5 text-left transition-colors ${sel === r.encounterId ? 'bg-ink text-white' : 'hover:bg-white/70'}`}>
      <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold">{r.patient.fullName}</span>
        <span className={`block truncate text-xs ${sel === r.encounterId ? 'text-white/70' : 'text-muted'}`}>{sub ?? [r.opNumber, r.doctor, fmtTime(r.completedAt), `${r.items} medicine${r.items === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}</span></span>
      {r.status === 'issued' && <Chip tone="sage">issued</Chip>}{r.status === 'part' && <Chip tone="amber">part issued</Chip>}{r.status === 'nothing' && <Chip>not bought</Chip>}
    </button>
  );
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_minmax(0,1fr)] lg:items-start">
      <div className={`card !p-3 ${sel ? 'hidden lg:block' : ''}`}>
        <div className="relative mb-2"><Icon name="search" className="h-4 w-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" />
          <input className="input !pl-10" aria-label="Find a prescription" placeholder="Name, phone or OP number" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        {list.isLoading ? <Skeleton rows={4} /> : term ? (
          <>{(d?.found ?? []).length === 0 ? <div className="p-4 text-sm text-muted">No prescription in the last 30 days matches.</div> : d.found.map((r: any) => <Row key={r.encounterId} r={r} sub={`${fmtDate(r.day)} · ${r.opNumber} · ${r.doctor ?? ''}`} />)}</>
        ) : (
          <>
            <div className="flex items-baseline gap-2 px-1 pb-1"><b className="text-sm">Today's prescriptions</b><span className="text-xs text-muted">{d?.today.length ?? 0}</span></div>
            <div className="px-1 pb-2 text-xs text-muted">Click a patient to open the doctor's prescription. Nothing here is a task.</div>
            {(d?.today ?? []).length === 0 ? <div className="p-4 text-sm text-muted">No prescriptions yet today.</div> : d.today.map((r: any) => <Row key={r.encounterId} r={r} />)}
            {(d?.balances ?? []).length > 0 && <>
              <div className="px-1 pb-1 pt-4 text-[11px] font-bold uppercase tracking-wider text-muted">Balance to collect · last 30 days</div>
              {d.balances.map((r: any) => <Row key={r.encounterId} r={r} sub={`Rx ${fmtDate(r.day)} · ${r.balance.map((b: any) => `${b.name} ${b.left} left`).join(', ')}`} />)}
            </>}
          </>
        )}
      </div>
      <div className={sel ? '' : 'hidden lg:block'}>
        {sel === 'walkin' ? <BillEditor key="walkin" onDone={() => pick(null)} onClose={() => pick(null)} canBill={can(perms, 'pharmacy.bill')} />
          : sel ? <RxBill key={sel} encounterId={sel} onDone={() => pick(null)} onClose={() => pick(null)} canBill={can(perms, 'pharmacy.bill')} />
          : <div className="card"><Empty icon="pill" title="Pick a patient" hint="The doctor's prescription opens here with the quantities worked out. Issue all of it, some of it, or none." /></div>}
      </div>
    </div>
  );
}

function RxBill(props: { encounterId: string; onDone: () => void; onClose: () => void; canBill: boolean }) {
  const rx = useQuery({ queryKey: ['pharmacy', 'rx', props.encounterId], queryFn: () => get(`/pharmacy/rx/${props.encounterId}`) });
  if (rx.isLoading) return <div className="card"><Skeleton rows={5} /></div>;
  if (rx.error || !rx.data) return <div className="card text-sm text-rose">{errText(rx.error)}</div>;
  return <BillEditor rx={rx.data} {...props} />;
}

type Line = { key: string; medicineId: string | null; name: string; rxItemId?: string; prescribed?: number; issued?: number; left?: number; how?: string; qty: string; batchId: string; reason: string; batches: any[]; onHand: number; mrpPaise: number; gstBp: number; med: any };

const lineAmount = (l: Line) => { const b = l.batches.find((x) => x.id === l.batchId); return (Number(l.qty) || 0) * (b?.mrpPaise ?? l.mrpPaise); };

/** One bill at the counter: the doctor's prescription (quantities pre-filled, change to short-issue, 0 to skip) plus anything else the patient buys. */
function BillEditor({ rx, onDone, onClose, canBill }: { rx?: any; onDone: () => void; onClose: () => void; canBill: boolean }) {
  const meds = useQuery({ queryKey: ['pharmacy', 'medicines'], queryFn: () => get('/pharmacy/medicines'), staleTime: 30_000 });
  const [lines, setLines] = useState<Line[]>(() => (rx?.items ?? []).map((it: any) => {
    const qty = it.medicine ? Math.min(it.left, it.onHand) : 0;
    return { key: it.id, medicineId: it.medicine?.id ?? null, name: it.name, rxItemId: it.id, prescribed: it.prescribed, issued: it.issuedQty, left: it.left, how: [it.dose, it.frequency, it.durationDays ? `${it.durationDays} days` : null].filter(Boolean).join(' · '),
      qty: String(qty), batchId: it.batches[0]?.id ?? '', reason: it.medicine && it.left > it.onHand ? 'Out of stock' : '', batches: it.batches, onHand: it.onHand, mrpPaise: it.medicine?.mrpPaise ?? 0, gstBp: it.medicine?.gstBp ?? 0, med: it.medicine };
  }));
  const [who, setWho] = useState<any>(rx?.patient ?? null);
  const [discount, setDiscount] = useState('');
  const [paying, setPaying] = useState(false);
  const set = (key: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => l.key === key ? { ...l, ...patch } : l));
  const add = (m: any) => {
    if (lines.some((l) => l.medicineId === m.id && !l.rxItemId)) { toast(`${m.name} is already on the bill`, 'info'); return; }
    setLines((ls) => [...ls, { key: `x${m.id}`, medicineId: m.id, name: m.name, qty: m.onHand ? '1' : '0', batchId: m.batches[0]?.id ?? '', reason: '', batches: m.batches, onHand: m.onHand, mrpPaise: m.mrpPaise, gstBp: m.gstBp, med: m }]);
  };
  const issuing = lines.filter((l) => l.medicineId && Number(l.qty) > 0);
  const gross = issuing.reduce((n, l) => n + lineAmount(l), 0);
  const disc = Math.min(toPaise(discount || '0'), gross); const total = gross - disc;
  const gstIn = issuing.reduce((n, l) => { const a = lineAmount(l); return n + a - Math.round((a * 10000) / (10000 + l.gstBp)); }, 0);
  const gst = gross ? Math.round((gstIn * total) / gross) : 0;
  const over = lines.find((l) => Number(l.qty) > l.onHand);
  const rxLines = lines.filter((l) => l.rxItemId);
  const nothing = useMutation({ mutationFn: (reason: string) => post(`/pharmacy/rx/${rx.encounterId}/nothing`, { reason: reason || undefined }),
    onSuccess: () => { toast('Marked as not bought'); qc.invalidateQueries({ queryKey: ['pharmacy'] }); onDone(); }, onError: (e) => toast(errText(e), 'err') });
  const problem = !who ? 'Pick or register the patient.' : issuing.length === 0 ? 'Nothing to issue: set a quantity, or use "Patient bought nothing".' : over ? `${over.name}: only ${over.onHand} in stock.` : total <= 0 ? 'The discount cannot be the whole bill.' : '';

  return (
    <div className="space-y-4">
      <div className="card">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <button className="btn btn-ghost btn-icon lg:hidden" aria-label="Back to the list" onClick={onClose}><Icon name="x" /></button>
          {rx ? <>
            <b className="text-xl">{rx.patient.fullName}</b>
            <span className="text-sm text-muted">{[rx.opNumber, rx.patient.patientNo, [rx.patient.ageYears, rx.patient.sex].filter(Boolean).join(' '), rx.patient.phone].filter(Boolean).join(' · ')}</span>
            {rx.patient.allergies && <Chip tone="rose">Allergy: {rx.patient.allergies}</Chip>}
            <span className="ml-auto text-sm text-muted">{['Prescribed by ' + (rx.doctor ?? 'the doctor'), fmtDate(rx.completedAt) + ' ' + fmtTime(rx.completedAt), rx.diagnosis].filter(Boolean).join(' · ')}</span>
          </> : <WalkInPatient who={who} setWho={setWho} />}
        </div>
        {rx?.bills?.length > 0 && <div className="mt-2 text-xs text-muted">Already billed on this prescription: {rx.bills.map((b: any) => `${b.invoiceNo} (${money(b.totalPaise)})`).join(', ')}</div>}

        <div className="mt-3 -mx-5 overflow-x-auto">
          <table className="table min-w-[860px]">
            <thead><tr><th>{rx ? 'Doctor prescribed' : 'Item'}</th>{rx && <th>How to take</th>}{rx && <th className="!text-right">Prescribed</th>}<th className="!text-right">Issue</th><th>Batch</th><th className="!text-right">MRP</th><th className="!text-right">Amount</th><th>{rx ? 'If not full' : ''}</th></tr></thead>
            <tbody>
              {lines.length === 0 && <tr><td colSpan={8} className="text-center text-muted">Add the first item below.</td></tr>}
              {lines.map((l) => {
                const n = Number(l.qty) || 0; const left = l.left ?? 0; const done = l.rxItemId !== undefined && left === 0;
                const short = l.rxItemId ? left - n : 0; const b = l.batches.find((x) => x.id === l.batchId);
                return (
                  <tr key={l.key} className={n === 0 ? 'text-muted' : ''}>
                    <td><div className="font-semibold text-ink">{l.name}</div><div className={`text-xs ${l.medicineId && l.onHand === 0 ? 'text-rose' : 'text-muted'}`}>{!l.medicineId ? 'not in the medicine list' : l.onHand === 0 ? 'out of stock' : `${l.onHand} ${packLabel(l.med, l.onHand)} in stock`}</div></td>
                    {rx && <td className="text-xs">{l.how || '—'}</td>}
                    {rx && <td className="text-right whitespace-nowrap">{l.prescribed ? `${l.prescribed} ${packLabel(l.med, l.prescribed ?? 1)}` : '—'}{(l.issued ?? 0) > 0 && <div className="text-xs text-muted">{l.issued} issued before</div>}</td>}
                    <td className="text-right">{done ? <Chip tone="sage">issued</Chip> : <NumInput aria-label={`Issue ${l.name}`} className={`input !w-16 !px-2 text-right ${n > l.onHand ? '!border-rose' : ''}`} max={999} disabled={!l.medicineId || !canBill} value={l.qty} onChange={(e) => set(l.key, { qty: e.target.value })} />}</td>
                    <td>{l.batches.length > 1 && n > 0 ? <select aria-label={`Batch for ${l.name}`} className="input !w-auto !py-1.5 !text-xs" value={l.batchId} onChange={(e) => set(l.key, { batchId: e.target.value })}>{l.batches.map((x) => <option key={x.id} value={x.id}>{x.batchNo} · {exp(x.expiry)} · {x.qty}</option>)}</select>
                      : b && n > 0 ? <span className="text-xs">{b.batchNo} · {exp(b.expiry)}</span> : <span className="text-xs">—</span>}</td>
                    <td className="text-right">{l.medicineId ? money(b?.mrpPaise ?? l.mrpPaise) : '—'}</td>
                    <td className="text-right font-semibold text-ink">{n > 0 ? money(lineAmount(l)) : '—'}</td>
                    <td>{l.rxItemId && !done && short > 0 ? <div className="flex items-center gap-2">
                      <Chip tone={n === 0 ? '' : 'amber'}>{n === 0 ? 'not issued' : `${short} short`}</Chip>
                      <select aria-label={`Reason for ${l.name}`} className="input !w-auto !py-1.5 !text-xs" value={l.reason} onChange={(e) => set(l.key, { reason: e.target.value })}><option value="">Reason (optional)</option>{REASONS.map((r) => <option key={r}>{r}</option>)}</select>
                    </div> : !l.rxItemId ? <button className="btn btn-ghost btn-icon" aria-label={`Remove ${l.name}`} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}><Icon name="x" /></button> : null}</td>
                  </tr>);
              })}
            </tbody>
          </table>
        </div>
        {canBill && <div className="mt-3 flex flex-wrap items-center gap-3"><AddItem meds={meds.data ?? []} onAdd={add} />
          {rx && <span className="text-xs text-muted">Issue is pre-filled with what the doctor prescribed. Lower it to issue less, 0 to skip. The reason is optional.</span>}</div>}
      </div>

      {canBill && <div className="card grid gap-5 md:grid-cols-[minmax(0,1fr)_300px] md:items-end">
        <div className="space-y-1.5 text-sm">
          <div className="label">This bill</div>
          <div className="flex justify-between"><span>{rx ? `${rxLines.filter((l) => Number(l.qty) > 0).length} of ${rxLines.length} prescribed · ` : ''}{issuing.length} item{issuing.length === 1 ? '' : 's'}</span><b>₹{rupees2(gross)}</b></div>
          <div className="flex justify-between text-muted"><span>GST included</span><span>₹{rupees2(gst)}</span></div>
          <div className="flex items-center justify-between gap-3"><span className="text-muted">Discount <span className="text-xs">(above 10% needs the owner)</span></span><MoneyInput label="Discount" className="!w-32" value={discount} onChange={setDiscount} /></div>
          {rxLines.some((l) => (l.left ?? 0) - (Number(l.qty) || 0) > 0 && Number(l.qty) > 0) && <div className="text-xs text-muted pt-1">Short-issued lines keep a balance on this prescription for 30 days.</div>}
        </div>
        <div className="space-y-2">
          <div className="flex items-baseline justify-between"><span className="text-sm text-muted">To pay</span><span className="text-3xl font-semibold">{money(total)}</span></div>
          {problem && issuing.length > 0 && <div className="text-xs text-rose">{problem}</div>}
          <button className="btn btn-primary w-full justify-center !py-3" disabled={!!problem} onClick={() => setPaying(true)}><Icon name="rupee" />Take payment</button>
          {rx && rx.status !== 'issued' && rx.status !== 'part' && <button className="btn w-full justify-center" disabled={nothing.isPending} onClick={async () => { const a = await ask({ title: 'Patient bought nothing?', body: 'The prescription stays on the patient record as not bought.', confirmLabel: 'Bought nothing', field: { label: 'Reason', maxLength: 80 } }); if (a) nothing.mutate(a.value); }}>Patient bought nothing</button>}
        </div>
      </div>}
      {paying && <PayDialog total={total} patient={who} onClose={() => setPaying(false)} build={() => ({
        ...(who.id ? { patientId: who.id } : { newPatient: { fullName: who.fullName.trim(), phone: who.phone, ageYears: who.ageYears ? Number(who.ageYears) : undefined } }),
        encounterId: rx?.encounterId, discountPaise: disc,
        items: issuing.map((l) => ({ medicineId: l.medicineId!, qty: Number(l.qty), batchId: l.batchId || undefined, prescriptionItemId: l.rxItemId })),
        notIssued: rxLines.filter((l) => (l.left ?? 0) > (Number(l.qty) || 0)).map((l) => ({ prescriptionItemId: l.rxItemId!, reason: l.reason || null })),
      })} onDone={onDone} />}
    </div>
  );
}

function AddItem({ meds, onAdd }: { meds: any[]; onAdd: (m: any) => void }) {
  const [q, setQ] = useState(''); const [open, setOpen] = useState(false); const box = useRef<HTMLDivElement>(null);
  const shown = meds.filter((m) => !q.trim() || m.name.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 8);
  useEffect(() => { const h = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); }; document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h); }, []);
  const pick = (m: any) => { onAdd(m); setQ(''); setOpen(false); };
  return (
    <div ref={box} className="relative w-full sm:w-80">
      <Icon name="plus" className="h-4 w-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" />
      <input className="input !pl-10" aria-label="Add item to this bill" placeholder="Add item to this bill" value={q} onFocus={() => setOpen(true)} onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onKeyDown={(e) => { if (e.key === 'Enter' && shown[0]) { e.preventDefault(); pick(shown[0]); } if (e.key === 'Escape') setOpen(false); }} />
      {open && <div className="absolute z-20 mt-1 w-full card-flat !rounded-2xl bg-white p-1 shadow-lg max-h-72 overflow-y-auto">
        {shown.length === 0 ? <div className="p-3 text-sm text-muted">Not in the medicine list. Add it under Settings → Medicines.</div> : shown.map((m) => (
          <button key={m.id} className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm hover:bg-ink/5" onClick={() => pick(m)}>
            <span className="flex-1 truncate">{m.name}</span><span className={`text-xs ${m.onHand ? 'text-muted' : 'text-rose'}`}>{m.onHand ? `${m.onHand} in stock` : 'out of stock'}</span><span className="w-14 text-right text-xs font-semibold">{money(m.mrpPaise)}</span>
          </button>))}
      </div>}
    </div>
  );
}

function WalkInPatient({ who, setWho }: { who: any; setWho: (p: any) => void }) {
  const [mode, setMode] = useState<'existing' | 'new'>('existing'); const [find, setFind] = useState('');
  const [np, setNp] = useState({ fullName: '', phone: '', ageYears: '' });
  const pts = useQuery({ queryKey: ['palette', find], queryFn: () => get(`/patients?q=${encodeURIComponent(find)}`), enabled: mode === 'existing' && !who && find.trim().length >= 2 });
  useEffect(() => { if (mode === 'new') setWho(np.fullName.trim().length >= 2 && /^[0-9]{10}$/.test(np.phone) ? { ...np } : null); }, [np, mode]);
  if (who?.id) return <div className="flex flex-1 items-center gap-3"><b className="text-xl">{who.fullName}</b><span className="text-sm text-muted">{who.patientNo} · {who.phone ?? 'no phone'}</span><span className="text-sm text-muted">Walk-in sale</span><button className="btn btn-sm ml-auto" onClick={() => setWho(null)}>Change</button></div>;
  return (
    <div className="w-full space-y-2">
      <div className="flex items-center gap-2"><b className="text-xl mr-auto">Walk-in sale</b>{([['existing', 'Existing patient'], ['new', 'New customer']] as const).map(([k, l]) => <button key={k} className={`toggle-opt ${mode === k ? 'on' : ''}`} onClick={() => { setMode(k); setWho(null); }}>{l}</button>)}</div>
      {mode === 'existing' ? <div className="relative max-w-md">
        <input className="input" aria-label="Find patient" placeholder="Name, phone or patient ID" value={find} onChange={(e) => setFind(e.target.value)} />
        {(pts.data ?? []).slice(0, 5).map((p: any) => <button key={p.id} className="mt-1 flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm hover:bg-ink/5" onClick={() => setWho(p)}><span className="flex-1">{p.fullName}</span><span className="text-xs text-muted">{p.patientNo} · {p.phone ?? ''}</span></button>)}
      </div> : <div className="grid max-w-xl grid-cols-6 gap-2">
        <input className="input col-span-3" aria-label="Customer name" placeholder="Full name" value={np.fullName} onChange={(e) => setNp({ ...np, fullName: e.target.value })} />
        <input className={`input col-span-2 ${np.phone && !/^[0-9]{10}$/.test(np.phone) ? '!border-rose' : ''}`} aria-label="Phone" inputMode="numeric" maxLength={10} placeholder="Phone (10 digits)" value={np.phone} onChange={(e) => setNp({ ...np, phone: e.target.value.replace(/\D/g, '') })} />
        <input className="input col-span-1" aria-label="Age" inputMode="numeric" maxLength={3} placeholder="Age" value={np.ageYears} onChange={(e) => setNp({ ...np, ageYears: e.target.value.replace(/\D/g, '') })} />
      </div>}
    </div>
  );
}

/** Payment: cash, UPI, card or split. Cash fills the remainder and shows the change; the receipt prints and/or goes on WhatsApp. */
function PayDialog({ total, patient, build, onClose, onDone }: { total: number; patient: any; build: () => any; onClose: () => void; onDone: () => void }) {
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
      onDone();
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
  const [from, setFrom] = useState(today()); const [to, setTo] = useState(today()); const [q, setQ] = useState('');
  const span = range === 'today' ? [today(), today()] : range === 'yesterday' ? [minusDays(today(), 1), minusDays(today(), 1)] : range === 'week' ? [minusDays(today(), 6), today()] : [from, to];
  const bad = span[0] > span[1];
  const list = useQuery({ queryKey: ['pharmacy', 'bills', span[0], span[1], q], queryFn: () => get(`/pharmacy/bills?from=${span[0]}&to=${span[1]}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`), enabled: !bad });
  const t = list.data?.totals; const rows: any[] = list.data?.rows ?? [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented value={range} onChange={setRange} options={[{ value: 'today', label: 'Today' }, { value: 'yesterday', label: 'Yesterday' }, { value: 'week', label: '7 days' }, { value: 'custom', label: 'Range' }]} />
        {range === 'custom' && <><input type="date" aria-label="From" className={`input !w-auto ${bad ? '!border-rose' : ''}`} value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} /><span className="text-sm text-muted">to</span><input type="date" aria-label="To" className={`input !w-auto ${bad ? '!border-rose' : ''}`} value={to} onChange={(e) => e.target.value && setTo(e.target.value)} />{bad && <span className="text-xs text-rose">“From” is after “to”.</span>}</>}
        <div className="relative ml-auto"><Icon name="search" className="h-4 w-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" /><input className="input !pl-10 !w-64" aria-label="Search bills" placeholder="Bill no., patient or phone" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      </div>
      {t && <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {[['Bills', money(t.total - t.refunds), `${t.count} bills${t.returns ? ` · ${t.returns} return${t.returns === 1 ? '' : 's'}` : ''}`], ['Cash in drawer should be', money(t.cash ?? 0), t.refunds ? `after ${money(t.refunds)} refunds` : 'cash payments'], ['UPI', money(t.upi ?? 0), ''], ['Card', money(t.card ?? 0), ''],
          ['Prescriptions with nothing issued', `${list.data.rx.notBought} of ${list.data.rx.total}`, "for the doctor's information"]].map(([l, v, s]) => <div key={l} className="card !p-4"><div className="text-[11px] uppercase tracking-wider text-muted">{l}</div><div className="text-2xl font-semibold mt-1">{v}</div>{s && <div className="text-xs text-muted mt-0.5">{s}</div>}</div>)}
      </div>}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] lg:items-start">
        <div className={`card !p-0 overflow-x-auto ${sel ? 'hidden lg:block' : ''}`}>
          {list.isLoading ? <div className="p-5"><Skeleton rows={4} /></div> : rows.length === 0 ? <Empty icon="pill" title="No bills in this range" /> : (
            <table className="table min-w-[640px]"><thead><tr><th>Bill</th><th>Time</th><th>Patient</th><th>Items</th><th className="!text-right">Amount</th><th>Paid by</th></tr></thead>
              <tbody>{rows.map((r) => (
                <tr key={r.id} onClick={() => pick(r.id)} className={`cursor-pointer ${sel === r.id ? 'bg-ink/5' : 'hover:bg-white/60'}`}>
                  <td><button className="font-semibold hover:underline" onClick={(e) => { e.stopPropagation(); pick(r.id); }}>{r.invoiceNo}</button></td><td className="text-muted whitespace-nowrap">{range === 'today' ? fmtTime(r.at) : `${fmtDate(r.at)} ${fmtTime(r.at)}`}</td>
                  <td><div className="font-medium">{r.patient.fullName}</div><div className="text-xs text-muted">{r.encounterId ? `Rx ${r.doctor ?? ''}` : 'Walk-in · no prescription'}</div></td>
                  <td className="text-sm">{r.items}{r.balance.length > 0 && <Chip tone="amber" className="ml-1.5">balance {r.balance.map((b: any) => b.left).reduce((a: number, b: number) => a + b, 0)}</Chip>}{r.notIssued > 0 && <Chip className="ml-1.5">{r.notIssued} not issued</Chip>}</td>
                  <td className="text-right font-semibold">{money(r.totalPaise)}{r.refundPaise > 0 && <div className="text-xs text-rose">− {money(r.refundPaise)}</div>}</td>
                  <td className="text-sm uppercase text-muted">{r.method === 'split' ? r.payments.map((p: any) => p.method).join(' + ') : r.method}</td>
                </tr>))}</tbody></table>)}
        </div>
        <div className={sel ? '' : 'hidden lg:block'}>{sel ? <BillDetail key={sel} id={sel} onClose={() => pick(null)} onIssue={onIssue} /> : <div className="card text-sm text-muted text-center py-10">Pick a bill to reprint it, issue the balance, or take items back.</div>}</div>
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
        {s.encounterId && s.notIssued?.length > 0 && can(perms, 'pharmacy.bill') && <button className="btn btn-sm" onClick={() => onIssue(s.encounterId)}>Issue balance</button>}
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
        <div className="text-xs text-muted">Items go back to the same batch. Opened or cold-chain items cannot go back on the shelf: take them back with an adjustment on the Stock tab.</div>
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
${x.notIssued?.length ? `<hr><div class="m">Not issued today: ${x.notIssued.map((n: any) => `${esc(n.name)} (${n.left})`).join(', ')}. Balances can be collected within 30 days.</div>` : ''}
<div class="m" style="margin-top:8px">Prices include GST. Thank you.</div>`;
    openPrint({ title: `Receipt ${x.invoiceNo}`, html });
  } catch (e: any) { toast(errText(e), 'err'); }
}
