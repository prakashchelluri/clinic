import { useEffect, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useOutletContext, useSearchParams } from 'react-router';
import { get, post, patch, qc, today, fmtTime, errText } from '../api';
import { can } from '../App';
import { openPrint } from '../printPreview';
import { Avatar, Chip, Empty, Icon, Modal, PageHeader, Segmented, Skeleton, money, toast, MoneyInput, toPaise } from '../ui';

/** Pharmacy counter: today's prescriptions from the doctor, tick items as dispensed, bill once per visit. */
export function Pharmacy() {
  const { perms } = useOutletContext<any>();
  const [day, setDay] = useState(today());
  const q = useQuery({ queryKey: ['pharmacy', day], queryFn: () => get(`/pharmacy/queue?day=${day}`), refetchInterval: 10000 });
  const [filter, setFilter] = useState('');
  const [tab, setTab] = useState<'now' | 'history'>('now');
  const [selling, setSelling] = useState(false);
  const [sp, setSp] = useSearchParams();
  useEffect(() => { if (sp.get('sale')) { setSelling(true); setSp({}, { replace: true }); } }, [sp]);
  const rows: any[] = (q.data ?? []).filter((r: any) => !filter || r.patient.fullName.toLowerCase().includes(filter.toLowerCase()) || r.opNumber.toLowerCase().includes(filter.toLowerCase()) || (r.patient.phone ?? '').includes(filter));
  const pending = rows.filter((r) => !r.bill);
  const billed = rows.filter((r) => r.bill);
  const [sel, setSel] = useState<string | null>(null);
  const [wide, setWide] = useState(() => window.matchMedia('(min-width: 1024px)').matches);
  useEffect(() => { const m = window.matchMedia('(min-width: 1024px)'); const on = () => setWide(m.matches); m.addEventListener('change', on); return () => m.removeEventListener('change', on); }, []);
  const list = pending; // billed ones move to History
  const selected = rows.find((r) => r.encounterId === sel) ?? (wide ? list[0] : undefined); // on a wide screen the first one is open by default
  const waited = (at?: string) => { if (!at) return '—'; const m = Math.max(0, Math.round((Date.now() - new Date(at).getTime()) / 60000)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} m`; };
  return (
    <div>
      <PageHeader title="Pharmacy">
        <Segmented<'now' | 'history'> value={tab} onChange={setTab} options={[{ value: 'now', label: 'Pending', count: pending.length }, { value: 'history', label: 'History' }]} />
        <div className="relative"><Icon name="search" className="h-4 w-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" /><input className="input !pl-10 !w-64" placeholder="OP number, name or phone" value={filter} onChange={(e) => setFilter(e.target.value)} /></div>
        {tab === 'now' && <input type="date" aria-label="Day" className="input !w-auto" value={day} onChange={(e) => setDay(e.target.value)} />}
      </PageHeader>
      {tab === 'history' && <History filter={filter} />}
      {selling && <SaleDialog onClose={() => setSelling(false)} />}
      {tab === 'now' && (q.isLoading ? <Skeleton rows={4} /> : (q.data ?? []).length === 0 ? <div className="card"><Empty icon="pill" title="No prescriptions yet" hint="Completed consultations appear here the moment the doctor prints the Rx." /></div> : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] lg:items-start">
          <div>
            <div className="card !p-0 overflow-hidden">
              <div className="hidden sm:flex items-center gap-3 px-4 py-2.5 text-[11px] uppercase tracking-wider text-muted"><span className="w-16">Token</span><span className="flex-1">Patient</span><span className="w-12 text-right">Items</span><span className="w-16 text-right">Waiting</span><span className="w-28 text-right">Status</span></div>
              {list.length === 0 ? <div className="p-6 text-center text-sm text-muted">Nothing pending. Billed prescriptions are in History.</div> : list.map((r) => {
                const left = r.items.filter((x: any) => !x.dispensed).length;
                return (
                  <button key={r.encounterId} onClick={() => setSel(r.encounterId)} aria-pressed={sel === r.encounterId} className={`flex w-full items-center gap-3 border-t border-line/70 px-4 py-3 text-left first:border-t-0 transition-colors ${sel === r.encounterId ? 'bg-ink/5' : 'hover:bg-white/60'}`}>
                    <span className="w-16 font-mono text-xs font-semibold">{r.opNumber}</span>
                    <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{r.patient.fullName}</span><span className="block truncate text-xs text-muted">{[r.patient.ageYears ? `${r.patient.ageYears}y` : '', r.patient.sex, r.patient.allergies ? 'allergies' : ''].filter(Boolean).join(' · ')}</span></span>
                    <span className="w-12 text-right text-sm">{r.items.length}</span>
                    <span className="hidden sm:block w-16 text-right text-xs text-muted">{r.bill ? '—' : waited(r.completedAt)}</span>
                    <span className="w-28 text-right">{r.bill ? <Chip tone="sage">billed {money(r.bill.amountPaise)}</Chip> : left === 0 ? <Chip tone="amber">bill pending</Chip> : <Chip>{left} to give</Chip>}</span>
                  </button>);
              })}
            </div>
          </div>
          {wide && (selected ? <div className="lg:sticky lg:top-4"><RxCard key={selected.encounterId} r={selected} i={0} canBill={can(perms, 'pharmacy.bill')} canDispense={can(perms, 'pharmacy.dispense')} /></div>
            : <div className="card text-sm text-muted text-center py-10">Pick a prescription to dispense it.</div>)}
          {!wide && selected && <Modal title={selected.patient.fullName} subtitle={selected.opNumber} onClose={() => setSel(null)} width="max-w-lg"><RxCard key={selected.encounterId} r={selected} i={0} canBill={can(perms, 'pharmacy.bill')} canDispense={can(perms, 'pharmacy.dispense')} /></Modal>}
        </div>
      ))}
    </div>
  );
}

function RxCard({ r, i, canBill, canDispense }: { r: any; i: number; canBill: boolean; canDispense: boolean }) {
  const [amount, setAmount] = useState(''); const [method, setMethod] = useState('cash'); const [note, setNote] = useState(''); const [ref, setRef] = useState('');
  const tick = useMutation({ mutationFn: ({ id, dispensed }: any) => patch(`/prescription-items/${id}`, { dispensed }), onSuccess: () => qc.invalidateQueries({ queryKey: ['pharmacy'] }) });
  const bill = useMutation({ mutationFn: () => post('/pharmacy/bill', { visitId: r.visitId, patientId: r.patient.id, amountPaise: toPaise(amount), method, reference: method === 'cash' ? undefined : ref.trim(), note: note || undefined }),
    onSuccess: () => { toast(`Billed ${money(toPaise(amount))}`); qc.invalidateQueries({ queryKey: ['pharmacy'] }); }, onError: (e: any) => toast(errText(e), 'err') });
  const allDone = r.items.every((x: any) => x.dispensed);
  return (
    <div className={`card ${r.bill ? 'opacity-75' : ''}`} style={{ ['--i' as any]: i }}>
      <div className="flex items-center gap-3">
        <span className="serif text-lg w-16">{r.opNumber}</span><Avatar name={r.patient.fullName} />
        <div className="min-w-0 flex-1"><div className="font-medium truncate">{r.patient.fullName} <span className="text-xs text-muted font-normal">{r.patient.ageYears ? `${r.patient.ageYears}y` : ''} {r.patient.sex ?? ''}</span></div><div className="text-xs text-muted">{r.patient.patientNo} · Rx {fmtTime(r.completedAt)}</div></div>
        {r.bill ? <Chip tone="sage">billed {money(r.bill.amountPaise)}</Chip> : allDone ? <Chip tone="amber">dispensed · bill pending</Chip> : <Chip>{r.items.filter((x: any) => !x.dispensed).length} to give</Chip>}
        <button className="btn btn-ghost btn-icon" title="Print Rx" onClick={() => openPrint({ title: 'Prescription', rx: r.encounterId })}><Icon name="print" /></button>
      </div>
      {r.patient.allergies && <div className="mt-2 text-xs text-rose bg-rose-soft rounded-lg px-2.5 py-1.5">Allergies: {r.patient.allergies}</div>}
      <div className="mt-3 divide-y divide-line/70">
        {r.items.map((it: any) => (
          <label key={it.id} className={`flex items-start gap-3 py-2 text-sm ${canDispense && !r.bill ? 'cursor-pointer' : ''}`}>
            <input type="checkbox" className="mt-1 accent-clay h-4 w-4" checked={it.dispensed} disabled={!canDispense || !!r.bill} onChange={(e) => tick.mutate({ id: it.id, dispensed: e.target.checked })} />
            <div className="flex-1"><div className={`font-medium ${it.dispensed ? 'line-through text-muted' : ''}`}>{it.name} <span className="font-normal text-muted">{it.dose ?? ''}</span></div><div className="text-xs text-muted">{[it.frequency, it.route, it.durationDays ? `${it.durationDays} days` : null].filter(Boolean).join(' · ')}{it.instructions ? ` — ${it.instructions}` : ''}</div></div>
          </label>
        ))}
      </div>
      {!r.bill && canBill && (
        <div className="mt-3 pt-3 border-t border-line flex items-center gap-2 flex-wrap">
          <div className="flex gap-1">{['cash', 'upi', 'card'].map((m) => <button key={m} type="button" className={`toggle-opt uppercase ${method === m ? 'on' : ''}`} onClick={() => setMethod(m)}>{m}</button>)}</div>
          <MoneyInput className="!w-32" placeholder="total" value={amount} onChange={setAmount} />
          {method !== 'cash' && <input className="input !w-44" placeholder={method === 'upi' ? 'UPI reference no.' : 'Card approval code'} value={ref} onChange={(e) => setRef(e.target.value)} />}
          <input className="input flex-1 min-w-32" placeholder="note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          <button className="btn btn-primary" disabled={!amount || bill.isPending || (method !== 'cash' && ref.trim().length < 4)} onClick={() => bill.mutate()}><Icon name="check" />Bill & mark dispensed</button>
        </div>
      )}
    </div>
  );
}

const minusDays = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() - n); return x.toISOString().slice(0, 10); };

/** Everything billed by the pharmacy: prescriptions and counter sales, with totals by payment method. */
function History({ filter }: { filter: string }) {
  const [from, setFrom] = useState(minusDays(today(), 6)); const [to, setTo] = useState(today());
  const bad = from > to;
  const q = useQuery({ queryKey: ['pharmacy', 'history', from, to, filter], queryFn: () => get(`/pharmacy/history?from=${from}&to=${to}${filter ? `&q=${encodeURIComponent(filter)}` : ''}`), enabled: !bad });
  const t = q.data?.totals; const rows: any[] = q.data?.rows ?? [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <input type="date" aria-label="From" className={`input !w-auto ${bad ? '!border-rose' : ''}`} value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} />
        <span className="text-muted text-sm">to</span>
        <input type="date" aria-label="To" className={`input !w-auto ${bad ? '!border-rose' : ''}`} value={to} onChange={(e) => e.target.value && setTo(e.target.value)} />
        <button className="btn btn-sm" onClick={() => { setFrom(today()); setTo(today()); }}>Today</button>
        <button className="btn btn-sm" onClick={() => { setFrom(minusDays(today(), 6)); setTo(today()); }}>Last 7 days</button>
        {bad && <span className="text-xs text-rose">“From” is after “to”.</span>}
      </div>
      {t && <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[['Total', t.total, `${t.count} bills · GST ${money(t.gst)}`], ['Cash', t.cash ?? 0, ''], ['UPI', t.upi ?? 0, ''], ['Card', t.card ?? 0, '']].map(([l, v, sub]) => <div key={l as string} className="card !p-4"><div className="text-[11px] uppercase tracking-wider text-muted">{l}</div><div className="serif text-2xl mt-1">{money(v as number)}</div>{sub && <div className="text-xs text-muted mt-0.5">{sub}</div>}</div>)}
      </div>}
      {q.isLoading ? <Skeleton rows={4} /> : rows.length === 0 ? <div className="card"><Empty icon="pill" title="Nothing billed in this range" hint="Prescription bills and counter sales show here." /></div> : (
        <div className="card !p-0 overflow-hidden">
          {rows.map((r) => (
            <div key={r.id} className="flex items-center gap-3 border-t border-line/70 px-4 py-3 first:border-t-0 text-sm">
              <div className="w-28 shrink-0 text-xs text-muted">{new Date(r.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' })}</div>
              <div className="min-w-0 flex-1"><div className="font-medium truncate">{r.patient.fullName} <Chip tone={r.kind === 'Counter sale' ? 'amber' : 'sky'}>{r.invoiceNo ?? r.kind}</Chip></div>{r.detail && <div className="truncate text-xs text-muted">{r.detail}</div>}</div>
              <span className="text-xs uppercase text-muted text-right">{r.method}{r.reference && <div className="normal-case">{r.reference}</div>}</span>
              {r.saleId ? <button className="btn btn-ghost btn-icon" title="Print receipt" aria-label={`Print receipt ${r.invoiceNo}`} onClick={() => printSale(r.saleId)}><Icon name="print" /></button> : <span className="w-10" />}
              <b className="w-20 text-right">{money(r.amountPaise)}</b>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const rupees = (p: number) => (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (x: unknown) => String(x ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** Tax invoice in a print window. GST is shown as CGST + SGST halves of the GST contained in the prices. */
async function printSale(id: string) {
  try {
    const x = await get(`/pharmacy/sale/${id}`);
    const taxable = x.totalPaise - x.gstPaise; const half = Math.floor(x.gstPaise / 2);
    const html = `<!doctype html><title>${esc(x.invoiceNo)}</title><style>body{font:13px system-ui,sans-serif;margin:18px;color:#111}h1{font-size:17px;margin:0}table{width:100%;border-collapse:collapse;margin:10px 0}th,td{padding:4px 2px;text-align:right;border-bottom:1px dashed #bbb}th:first-child,td:first-child{text-align:left}.m{color:#555;font-size:12px}.t td{border:0;padding:2px}.b{font-weight:700;font-size:15px}</style>
<h1>${esc(x.clinic.name)} · Pharmacy</h1><div class="m">${esc(x.clinic.address ?? '')}${x.clinic.gstin ? ' · GSTIN ' + esc(x.clinic.gstin) : ''}</div><hr>
<div><b>Tax invoice ${esc(x.invoiceNo)}</b><br><span class="m">${new Date(x.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' })}</span></div>
<div class="m">${esc(x.patient.fullName)} · ${esc(x.patient.patientNo)} · ${esc(x.patient.phone)}</div>
<table><tr><th>Item</th><th>Qty</th><th>MRP</th><th>GST</th><th>Amount</th></tr>${x.items.map((l: any) => `<tr><td>${esc(l.name)}${l.hsn ? '<div class="m">HSN ' + esc(l.hsn) + '</div>' : ''}</td><td>${l.qty}</td><td>${rupees(l.mrpPaise)}</td><td>${l.gstBp / 100}%</td><td>${rupees(l.amountPaise)}</td></tr>`).join('')}</table>
<table class="t"><tr><td>Items total</td><td>${rupees(x.grossPaise)}</td></tr>${x.discountPaise ? `<tr><td>Discount</td><td>-${rupees(x.discountPaise)}</td></tr>` : ''}<tr><td>Taxable value</td><td>${rupees(taxable)}</td></tr><tr><td>CGST</td><td>${rupees(half)}</td></tr><tr><td>SGST</td><td>${rupees(x.gstPaise - half)}</td></tr><tr class="b"><td>Total</td><td>₹${rupees(x.totalPaise)}</td></tr>
<tr><td>Paid by ${esc(x.method.toUpperCase())}${x.reference ? ' · ' + esc(x.reference) : ''}</td><td></td></tr>${x.method === 'cash' && x.receivedPaise > x.totalPaise ? `<tr><td>Received ${rupees(x.receivedPaise)}</td><td>Change ${rupees(x.receivedPaise - x.totalPaise)}</td></tr>` : ''}</table>
<div class="m">Prices include GST. Thank you.</div>`;
    openPrint({ title: `Receipt ${x.invoiceNo}`, html });
  } catch (e: any) { toast(errText(e), 'err'); }
}

/**
 * Pharmacy counter. Medicines and prices come from the catalogue (Settings → Medicines); prices include GST. A customer is always recorded,
 * UPI and card need the payment reference, cash shows the change. After the sale: print the receipt or start the next one.
 */
function SaleDialog({ onClose }: { onClose: () => void }) {
  const { cfg } = useOutletContext<any>();
  const meds: any[] = cfg?.medicines ?? [];
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [who, setWho] = useState<any>(null); const [find, setFind] = useState('');
  const [np, setNp] = useState({ fullName: '', phone: '', ageYears: '', sex: '' });
  const [lines, setLines] = useState<{ id: string; qty: number }[]>([]);
  const [search, setSearch] = useState(''); const [discount, setDiscount] = useState('');
  const [method, setMethod] = useState('cash'); const [ref, setRef] = useState(''); const [received, setReceived] = useState(''); const [tried, setTried] = useState(false);
  const [done, setDone] = useState<any>(null);
  const pts = useQuery({ queryKey: ['palette', find], queryFn: () => get(`/patients?q=${encodeURIComponent(find)}`), enabled: mode === 'existing' && !who && find.trim().length >= 2 });
  const med = (id: string) => meds.find((m) => m.id === id)!;
  const add = (id: string) => setLines((a) => a.some((x) => x.id === id) ? a.map((x) => x.id === id ? { ...x, qty: Math.min(999, x.qty + 1) } : x) : [...a, { id, qty: 1 }]);
  const setQty = (id: string, qty: number) => setLines((a) => qty < 1 ? a.filter((x) => x.id !== id) : a.map((x) => x.id === id ? { ...x, qty: Math.min(999, qty) } : x));
  const shown = meds.filter((m) => !search.trim() || m.name.toLowerCase().includes(search.trim().toLowerCase()));

  const gross = lines.reduce((n, l) => n + l.qty * med(l.id).mrpPaise, 0);
  const disc = Math.min(toPaise(discount || '0'), gross);
  const total = gross - disc;
  const gstInGross = lines.reduce((n, l) => { const a = l.qty * med(l.id).mrpPaise; return n + a - Math.round((a * 10000) / (10000 + med(l.id).gstBp)); }, 0);
  const gst = gross ? Math.round((gstInGross * total) / gross) : 0;
  const cgst = Math.floor(gst / 2);
  const cash = toPaise(received || '0'); const change = method === 'cash' && received ? cash - total : 0;

  const phoneBad = mode === 'new' && !/^[0-9]{10}$/.test(np.phone); const nameBad = mode === 'new' && np.fullName.trim().length < 2;
  const problem = lines.length === 0 ? 'Add at least one medicine.' : mode === 'existing' && !who ? 'Choose the patient, or switch to New customer.' : nameBad ? 'Enter the customer’s name.' : phoneBad ? 'Phone needs 10 digits.'
    : total <= 0 ? 'The discount cannot be the whole bill.' : method !== 'cash' && ref.trim().length < 4 ? (method === 'upi' ? 'Enter the UPI reference number.' : 'Enter the card approval code.') : method === 'cash' && received && cash < total ? 'Cash received is less than the total.' : '';

  const sell = useMutation({
    mutationFn: () => post('/pharmacy/sale', { patientId: mode === 'existing' ? who.id : undefined,
      newPatient: mode === 'new' ? { fullName: np.fullName.trim(), phone: np.phone, ageYears: np.ageYears ? Number(np.ageYears) : undefined, sex: np.sex || undefined } : undefined,
      items: lines.map((l) => ({ medicineId: l.id, qty: l.qty })), discountPaise: disc, method, reference: method === 'cash' ? undefined : ref.trim(), receivedPaise: method === 'cash' && received ? cash : undefined }),
    onSuccess: (r: any) => { setDone(r); qc.invalidateQueries({ queryKey: ['pharmacy'] }); qc.invalidateQueries({ queryKey: ['reports'] }); qc.invalidateQueries({ queryKey: ['patients'] }); },
    onError: (e: any) => toast(errText(e), 'err') });
  const reset = () => { setDone(null); setLines([]); setWho(null); setFind(''); setNp({ fullName: '', phone: '', ageYears: '', sex: '' }); setDiscount(''); setRef(''); setReceived(''); setTried(false); setSearch(''); };

  if (done) return (
    <Modal title="Sale recorded" onClose={onClose} width="max-w-md">
      <div className="text-center space-y-1 py-3"><div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-sage-soft text-sage"><Icon name="check" className="h-7 w-7" /></div>
        <div className="serif text-3xl pt-2">{money(done.totalPaise)}</div><div className="text-sm text-muted">{done.invoiceNo} · {done.method.toUpperCase()}{done.reference ? ` · ${done.reference}` : ''}</div>
        {done.method === 'cash' && done.receivedPaise > done.totalPaise && <div className="text-sm font-semibold pt-1">Give change {money(done.receivedPaise - done.totalPaise)}</div>}</div>
      <div className="modal-foot"><button className="btn btn-ghost" onClick={onClose}>Done</button><button className="btn" onClick={reset}>New sale</button><button className="btn btn-primary" onClick={() => printSale(done.id)}><Icon name="print" />Print receipt</button></div>
    </Modal>
  );

  return (
    <Modal title="New sale" subtitle="Prices are from the medicine list and include GST" onClose={onClose} width="max-w-5xl">
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
        <div className="min-w-0">
          <div className="relative mb-2"><Icon name="search" className="h-4 w-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" />
            <input autoFocus aria-label="Search medicine" className="input !pl-10 !py-3" placeholder="Search medicine" value={search} onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && shown[0]?.mrpPaise > 0) { e.preventDefault(); add(shown[0].id); setSearch(''); } }} /></div>
          <div className="card-flat overflow-y-auto max-h-[420px]">
            {shown.length === 0 ? <div className="p-4 text-sm text-muted">No such medicine. Add it under Settings → Medicines, with its price.</div> : shown.map((m) => (
              <button key={m.id} disabled={!m.mrpPaise} className="row w-full text-left disabled:opacity-50" onClick={() => add(m.id)}>
                <div className="min-w-0 flex-1"><div className="text-sm font-medium truncate">{m.name}</div><div className="text-xs text-muted">{[m.form, m.scheduleClass && m.scheduleClass !== 'OTC' ? `Schedule ${m.scheduleClass}` : ''].filter(Boolean).join(' · ')}</div></div>
                {m.mrpPaise ? <div className="text-right"><div className="text-sm font-semibold">{money(m.mrpPaise)}</div><div className="text-[11px] text-muted">GST {m.gstBp / 100}%</div></div> : <span className="text-xs text-rose">no price set</span>}
                {m.mrpPaise > 0 && <Icon name="plus" className="h-4 w-4 text-muted" />}
              </button>))}
          </div>
        </div>

        <div className="min-w-0 rounded-3xl bg-paper/70 p-4 space-y-3">
          <div>
            <div className="flex items-center gap-2 mb-1.5"><span className="text-[11px] uppercase tracking-wider text-muted">Customer</span>
              <div className="ml-auto flex gap-1">{([['existing', 'Existing patient'], ['new', 'New customer']] as const).map(([k, l]) => <button key={k} className={`toggle-opt !py-1 !text-xs ${mode === k ? 'on' : ''}`} onClick={() => setMode(k)}>{l}</button>)}</div></div>
            {mode === 'existing' ? (who
              ? <div className="flex items-center gap-2"><Avatar name={who.fullName} size="h-8 w-8 text-[11px]" /><div className="min-w-0 flex-1 text-sm"><b>{who.fullName}</b><div className="text-xs text-muted">{who.patientNo} · {who.phone ?? 'no phone'}</div></div><button className="btn btn-ghost btn-sm" onClick={() => setWho(null)}>Change</button></div>
              : <><input className={`input ${tried && !who ? '!border-rose' : ''}`} placeholder="Name, phone or patient ID" value={find} onChange={(e) => setFind(e.target.value)} />
                {(pts.data ?? []).slice(0, 4).map((p: any) => <button key={p.id} className="mt-1 flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm hover:bg-ink/5" onClick={() => setWho(p)}><Avatar name={p.fullName} size="h-7 w-7 text-[10px]" /><span className="flex-1">{p.fullName}</span><span className="text-xs text-muted">{p.patientNo} · {p.phone ?? ''}</span></button>)}</>
            ) : (
              <div className="grid grid-cols-6 gap-2">
                <div className="col-span-4"><input aria-label="Customer name" className={`input ${tried && nameBad ? '!border-rose' : ''}`} placeholder="Full name" value={np.fullName} onChange={(e) => setNp({ ...np, fullName: e.target.value })} /></div>
                <div className="col-span-2"><input aria-label="Age" className="input" inputMode="numeric" placeholder="Age" maxLength={3} value={np.ageYears} onChange={(e) => setNp({ ...np, ageYears: e.target.value.replace(/\D/g, '') })} /></div>
                <div className="col-span-4"><input aria-label="Phone" className={`input ${tried && phoneBad ? '!border-rose' : ''}`} inputMode="numeric" placeholder="Phone (10 digits)" maxLength={10} value={np.phone} onChange={(e) => setNp({ ...np, phone: e.target.value.replace(/\D/g, '') })} /></div>
                <div className="col-span-2 flex gap-1">{['M', 'F'].map((x) => <button key={x} className={`toggle-opt flex-1 justify-center ${np.sex === x ? 'on' : ''}`} onClick={() => setNp({ ...np, sex: np.sex === x ? '' : x })}>{x}</button>)}</div>
              </div>)}
          </div>

          <div className="divide-y divide-line/70 min-h-[96px]">
            {lines.length === 0 ? <div className="py-6 text-center text-sm text-muted">Tap a medicine to add it</div> : lines.map((l) => { const m = med(l.id); return (
              <div key={l.id} className="py-2 flex items-center gap-2">
                <div className="min-w-0 flex-1"><div className="text-sm font-medium truncate">{m.name}</div><div className="text-xs text-muted">{money(m.mrpPaise)} each · GST {m.gstBp / 100}%</div></div>
                <div className="flex items-center gap-1"><button className="btn btn-icon btn-sm" aria-label={`Less ${m.name}`} onClick={() => setQty(l.id, l.qty - 1)}>−</button><span className="w-7 text-center text-sm font-semibold">{l.qty}</span><button className="btn btn-icon btn-sm" aria-label={`More ${m.name}`} onClick={() => setQty(l.id, l.qty + 1)}>+</button></div>
                <b className="w-20 text-right text-sm">{money(l.qty * m.mrpPaise)}</b>
              </div>); })}
          </div>

          <div className="space-y-1 border-t border-line pt-2 text-sm">
            <div className="flex justify-between text-muted"><span>Items total</span><span>{money(gross)}</span></div>
            <div className="flex items-center justify-between text-muted"><span>Discount</span><MoneyInput className="!w-28" placeholder="0" value={discount} onChange={setDiscount} /></div>
            <div className="flex justify-between text-xs text-muted"><span>Taxable value</span><span>₹{rupees(total - gst)}</span></div>
            <div className="flex justify-between text-xs text-muted"><span>CGST + SGST (inside the prices)</span><span>₹{rupees(cgst)} + ₹{rupees(gst - cgst)}</span></div>
            <div className="flex items-end justify-between pt-1"><span className="text-muted">Total</span><span className="serif text-3xl">{money(total)}</span></div>
          </div>

          <div className="flex gap-1.5">{['cash', 'upi', 'card'].map((m) => <button key={m} type="button" className={`toggle-opt flex-1 justify-center uppercase ${method === m ? 'on' : ''}`} onClick={() => setMethod(m)}>{m}</button>)}</div>
          {method === 'cash'
            ? <div className="flex items-center gap-2"><span className="text-sm text-muted">Cash received</span><MoneyInput className="!w-28" placeholder={String(total / 100)} value={received} onChange={setReceived} /><span className={`ml-auto text-sm font-semibold ${change < 0 ? 'text-rose' : ''}`}>{received ? (change >= 0 ? `Change ${money(change)}` : 'Short') : ''}</span></div>
            : <input aria-label="Payment reference" className={`input ${tried && ref.trim().length < 4 ? '!border-rose' : ''}`} placeholder={method === 'upi' ? 'UPI reference number (UTR)' : 'Card approval code'} value={ref} onChange={(e) => setRef(e.target.value)} />}
          {tried && problem && <div className="text-xs text-rose">{problem}</div>}
          <button className="btn btn-primary w-full justify-center !py-3" disabled={sell.isPending} onClick={() => { setTried(true); if (!problem) sell.mutate(); }}><Icon name="check" />Charge {money(total)}</button>
        </div>
      </div>
    </Modal>
  );
}
