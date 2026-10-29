import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useOutletContext } from 'react-router';
import { get, post, patch, qc, today, fmtTime, errText } from '../api';
import { can } from '../App';
import { Chip, Empty, Icon, Modal, Segmented, Skeleton, money, toast, MoneyInput, toPaise, NumInput, ask, fmtDate } from '../ui';

type Go = (next: Record<string, string>) => void;
const exp = (d: string) => d.slice(5, 7) + '/' + d.slice(2, 4);
const rupees2 = (p: number) => '₹' + (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const toRupees = (p: number | null | undefined) => (p == null ? '' : String(p / 100));
const refresh = () => ['stock', 'vendors', 'stockdocs', 'pharmacy'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
/** "5 free per 50", "10+1", "buy 12 get 2" → free units for a quantity (same rule as the server). */
export function schemeFree(scheme: string, qty: number) {
  const s = scheme.toLowerCase();
  const m = s.match(/(\d+)\s*free\s*(?:per|on|for|with)\s*(\d+)/) ?? s.match(/buy\s*(\d+)\s*get\s*(\d+)/) ?? s.match(/^\s*(\d+)\s*\+\s*(\d+)\s*$/);
  if (!m) return 0;
  const [buy, getN] = /free/.test(s) ? [Number(m[2]), Number(m[1])] : [Number(m[1]), Number(m[2])];
  return buy > 0 ? Math.floor(qty / buy) * getN : 0;
}
const taxable = (qty: number, rate: number, discBp: number) => Math.round((qty * rate * (10000 - discBp)) / 10000);
const withGst = (a: number, bp: number) => a + Math.round((a * bp) / 10000);
const Tile = ({ label, value, sub, on, onClick }: { label: string; value: React.ReactNode; sub?: React.ReactNode; on?: boolean; onClick?: () => void }) => (
  <button type="button" onClick={onClick} disabled={!onClick} className={`card !p-4 text-left ${on ? '!bg-ink text-white' : ''} ${onClick ? 'card-hover' : ''}`}>
    <div className={`text-[11px] uppercase tracking-wider ${on ? 'text-white/70' : 'text-muted'}`}>{label}</div><div className="text-2xl font-semibold mt-1">{value}</div>{sub && <div className={`text-xs mt-0.5 ${on ? 'text-white/70' : 'text-muted'}`}>{sub}</div>}
  </button>
);

/* ---------------- Stock ---------------- */

export function StockTab({ sp, go }: { sp: URLSearchParams; go: Go }) {
  const { perms } = useOutletContext<any>();
  const item = sp.get('item'); const count = sp.get('count');
  const q = useQuery({ queryKey: ['stock'], queryFn: () => get('/stock'), refetchInterval: 30000 });
  const [filter, setFilter] = useState<'all' | 'low' | 'expiring' | 'out'>('all'); const [find, setFind] = useState('');
  const [review, setReview] = useState<string | null>(null);
  const startCount = useMutation({ mutationFn: () => post('/stock/counts'), onSuccess: (d: any) => go({ tab: 'stock', count: d.id }),
    onError: (e: any) => { if (e?.body?.code === 'COUNT_OPEN') go({ tab: 'stock', count: e.body.id }); else toast(errText(e), 'err'); } });
  if (item) return <ItemView id={item} go={go} />;
  if (count) return <CountView id={count} go={go} />;
  if (q.isLoading || !q.data) return <Skeleton rows={6} />;
  const d = q.data; const t = d.tiles;
  const rows = d.items.filter((i: any) => (filter === 'all' || i.status === filter || (filter === 'low' && i.status === 'out')) && (!find.trim() || i.name.toLowerCase().includes(find.trim().toLowerCase())));
  const n = (s: string) => d.items.filter((i: any) => i.status === s).length;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 justify-end">
        <button className="btn" disabled={startCount.isPending} onClick={() => startCount.mutate()}>{t.count && t.count.status !== 'closed' ? 'Continue stock count' : 'Stock count'}</button>
        {can(perms, 'stock.write') && <><button className="btn" onClick={() => go({ tab: 'orders', receive: 'new' })}>Receive without order</button><button className="btn btn-primary" onClick={() => go({ tab: 'orders', order: 'new' })}><Icon name="plus" />New purchase order</button></>}
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile on={d.reviews.length > 0} label="Deliveries with differences" value={d.reviews.length} sub={d.reviews.length ? `Waiting for the owner · ${money(d.reviews.reduce((n: number, r: any) => n + r.extraPaise, 0))} extra, ${d.reviews.reduce((n: number, r: any) => n + r.freeShort, 0)} free short` : 'Every delivery matched its order'} />
        <Tile label="Low stock" value={t.low} sub="Below reorder level" onClick={() => setFilter('low')} />
        <Tile label="Expiring in 90 days" value={`${t.expiringBatches} batch${t.expiringBatches === 1 ? '' : 'es'}`} sub={`${money(t.expiringValuePaise)} at cost · sell or return first${t.expired ? ` · ${t.expired} expired on shelf` : ''}`} onClick={() => setFilter('expiring')} />
        <Tile label="Stock count" value={t.count ? (t.count.status === 'closed' ? 'Done' : t.count.status === 'open' ? 'Open' : `${t.count.gapLines} gap${t.count.gapLines === 1 ? '' : 's'}`) : 'None yet'}
          sub={t.count ? `${t.count.docNo} · ${fmtDate(t.count.at)}${t.count.gapUnits ? ` · ${t.count.gapUnits} units unexplained` : ''}` : 'Count the shelf against the system'} onClick={t.count ? () => go({ tab: 'stock', count: t.count.id }) : undefined} />
      </div>

      {d.reviews.length > 0 && <div className="card !p-0 overflow-x-auto">
        <div className="flex flex-wrap items-baseline gap-2 px-5 pt-4 pb-2"><b>Deliveries waiting for a decision</b><span className="text-xs text-muted">Stock is already on the shelf; only the money and free goods need a decision.</span></div>
        <table className="table min-w-[760px]"><thead><tr><th>Received</th><th>Vendor</th><th>Bill no.</th><th>What differs from the order</th><th className="!text-right">Effect</th><th></th></tr></thead>
          <tbody>{d.reviews.map((r: any) => <tr key={r.id}><td><div className="font-medium">{fmtDate(r.at)} {fmtTime(r.at)}</div><div className="text-xs text-muted">by {r.by}</div></td><td>{r.vendor}</td><td>{r.billNo}</td>
            <td className="space-x-1">{r.lines.map((l: any) => <span key={l.medicineId}>{l.extraPaise > 0 && <Chip tone="rose">{l.name}: rate {rupees2(l.ratePaise)} vs {rupees2(l.promisedRatePaise)}{l.discBp < l.promisedDiscBp ? `, disc ${l.discBp / 100}% vs ${l.promisedDiscBp / 100}%` : ''}</Chip>} {l.freeShort > 0 && <Chip tone="amber">{l.name}: {l.freeQty} free of {l.freeExpected}</Chip>}</span>)}</td>
            <td className="text-right font-semibold whitespace-nowrap">{r.extraPaise ? `${money(r.extraPaise)} more` : ''}{r.extraPaise && r.freeShort ? ' · ' : ''}{r.freeShort ? `${r.freeShort} free short` : ''}</td>
            <td className="text-right"><button className="btn btn-sm btn-primary" onClick={() => setReview(r.id)}>Review</button></td></tr>)}</tbody></table>
      </div>}

      <div className="card !p-0 overflow-x-auto">
        <div className="flex flex-wrap items-center gap-2 px-5 pt-4 pb-2">
          <b className="mr-2">Stock</b>
          <Segmented value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All', count: d.items.length }, { value: 'low', label: 'Low', count: n('low') + n('out') }, { value: 'expiring', label: 'Expiring', count: n('expiring') }, { value: 'out', label: 'Out', count: n('out') }]} />
          <div className="relative ml-auto"><Icon name="search" className="h-4 w-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" /><input className="input !pl-10 !w-60" aria-label="Find medicine" placeholder="Medicine" value={find} onChange={(e) => setFind(e.target.value)} /></div>
        </div>
        {rows.length === 0 ? <Empty icon="pill" title="Nothing here" /> : <table className="table min-w-[820px]"><thead><tr><th>Medicine</th><th className="!text-right">On hand</th><th className="!text-right">Free received, 90 days</th><th className="!text-right">Batches</th><th>Nearest expiry</th><th className="!text-right">Reorder at</th><th className="!text-right">Cost value</th><th></th></tr></thead>
          <tbody>{rows.map((i: any) => <tr key={i.id} className="cursor-pointer hover:bg-white/60" onClick={() => go({ tab: 'stock', item: i.id })}>
            <td><button className="font-semibold text-left hover:underline" onClick={(e) => { e.stopPropagation(); go({ tab: 'stock', item: i.id }); }}>{i.name}</button><div className="text-xs text-muted">{['tab', 'cap'].includes(i.form) ? `strip of ${i.packSize}` : i.form ?? ''} · MRP {money(i.mrpPaise)}</div></td>
            <td className="text-right font-semibold">{i.onHand}{i.expired > 0 && <div className="text-xs text-rose font-normal">+{i.expired} expired</div>}</td><td className="text-right">{i.free90}</td><td className="text-right">{i.batches}</td>
            <td>{i.nearestExpiry ? (i.status === 'expiring' ? <Chip tone="rose">{exp(i.nearestExpiry)}</Chip> : exp(i.nearestExpiry)) : '—'}</td><td className="text-right">{i.reorderLevel}</td><td className="text-right">{money(i.costValuePaise)}</td>
            <td className="text-right">{i.status === 'ok' ? <Chip tone="sage">ok</Chip> : i.status === 'low' ? <Chip tone="amber">low</Chip> : i.status === 'out' ? <Chip tone="rose">out</Chip> : <Chip tone="rose">expiring</Chip>}</td></tr>)}</tbody></table>}
      </div>
      {review && <DecisionDialog id={review} onClose={() => setReview(null)} />}
    </div>
  );
}

/** A delivery that differs from its order: what differs, the bill photo, and the owner's decision. */
export function DecisionDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { perms } = useOutletContext<any>();
  const q = useQuery({ queryKey: ['stockdocs', id], queryFn: () => get(`/stock/docs/${id}`) });
  const [choice, setChoice] = useState<'owe' | 'debit' | 'accept'>('owe'); const [reason, setReason] = useState('');
  const decide = useMutation({ mutationFn: () => post(`/stock/receipts/${id}/decide`, { choice, reason: reason.trim() || undefined }), onSuccess: () => { toast('Decision saved'); refresh(); onClose(); }, onError: (e) => toast(errText(e), 'err') });
  const d = q.data;
  const extra = d ? d.lines.reduce((n: number, l: any) => n + l.extraPaise, 0) : 0; const short = d ? d.lines.reduce((n: number, l: any) => n + l.freeShort, 0) : 0;
  return (
    <Modal title={d ? `${d.vendor?.name ?? 'Opening stock'} · bill ${d.billNo ?? d.docNo}` : 'Delivery'} subtitle={d ? `${d.docNo} · received ${fmtDate(d.createdAt)} by ${d.createdByName}` : ''} onClose={onClose} width="max-w-3xl">
      {!d ? <Skeleton rows={4} /> : <div className="space-y-4">
        <table className="table"><thead><tr><th className="!pl-0">Medicine</th><th className="!text-right">Promised</th><th className="!text-right">Received</th><th className="!text-right !pr-0">Difference</th></tr></thead>
          <tbody>{d.lines.map((l: any) => <tr key={l.medicineId}><td className="!pl-0"><div className="font-medium">{l.name}</div><div className="text-xs text-muted">batch {l.batchNo} · {exp(l.expiry)}</div></td>
            <td className="text-right text-sm">{l.promisedQty != null ? <>{l.promisedQty} + {l.promisedFree} free<div className="text-xs text-muted">{rupees2(l.promisedRatePaise)}{l.promisedDiscBp ? ` less ${l.promisedDiscBp / 100}%` : ''}</div></> : '—'}</td>
            <td className="text-right text-sm">{l.qty} + {l.freeQty} free<div className="text-xs text-muted">{rupees2(l.ratePaise)}{l.discBp ? ` less ${l.discBp / 100}%` : ''}</div></td>
            <td className="text-right !pr-0 text-sm">{l.extraPaise > 0 && <div className="text-rose font-semibold">{money(l.extraPaise)} more</div>}{l.freeShort > 0 && <div className="text-[#7a5410] font-semibold">{l.freeShort} free short</div>}{!l.extraPaise && !l.freeShort && <Chip tone="sage">matches</Chip>}</td></tr>)}</tbody></table>
        <div className="flex flex-wrap items-center gap-3 text-sm"><span>Bill total <b>{d.billTotalPaise != null ? rupees2(d.billTotalPaise) : '—'}</b></span>{d.billPhotoKey && <a className="btn btn-sm" href={`/api/stock/docs/${d.id}/photo`} target="_blank" rel="noreferrer"><Icon name="export" />Bill photo</a>}</div>
        {d.status === 'review' ? (can(perms, 'stock.approve') ? <div className="space-y-2">
          <div className="label">Decision</div>
          {([['owe', 'Pay the bill, vendor owes the free units', `${short} unit${short === 1 ? '' : 's'} go on this vendor's owed list and are checked on the next delivery.`],
            ['debit', 'Pay the promised rate, vendor owes the free units', `A debit note of ${money(extra)} for the vendor; the free units go on the owed list.`],
            ['accept', 'Accept everything as billed', 'No owed list, no debit note. Needs a reason.']] as const).map(([k, l, h]) => (
            <label key={k} className={`flex cursor-pointer gap-3 rounded-2xl px-4 py-3 ${choice === k ? 'bg-ink text-white' : 'bg-white/70'}`}><input type="radio" name="decision" className="mt-1 accent-clay" checked={choice === k} onChange={() => setChoice(k)} /><span><b>{l}</b><div className={`text-xs ${choice === k ? 'text-white/70' : 'text-muted'}`}>{h}</div></span></label>))}
          <label className="block"><span className="label">Reason {choice === 'accept' ? '' : '(optional)'}</span><input className="input" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} /></label>
        </div> : <div className="text-sm text-muted">Waiting for the owner to decide.</div>)
          : d.decision && <div className="text-sm">Decided by {d.decision.by}: <b>{d.decision.choice === 'owe' ? 'vendor owes the free units' : d.decision.choice === 'debit' ? `debit note ${money(d.decision.debitPaise ?? 0)}` : 'accepted as billed'}</b>{d.decision.reason ? ` · ${d.decision.reason}` : ''}</div>}
      </div>}
      <div className="modal-foot"><button className="btn btn-ghost" onClick={onClose}>Close</button>{d?.status === 'review' && can(perms, 'stock.approve') && <button className="btn btn-primary" disabled={decide.isPending || (choice === 'accept' && reason.trim().length < 3)} onClick={() => decide.mutate()}>Save decision</button>}</div>
    </Modal>
  );
}

function ItemView({ id, go }: { id: string; go: Go }) {
  const { perms } = useOutletContext<any>();
  const q = useQuery({ queryKey: ['stock', 'item', id], queryFn: () => get(`/stock/medicines/${id}`) });
  const [kind, setKind] = useState<'all' | 'in' | 'out' | 'adj'>('all');
  const [returning, setReturning] = useState(false);
  const adjust = useMutation({ mutationFn: (b: any) => post(`/stock/batches/${b.batchId}/adjust`, { change: b.change, reason: b.reason }), onSuccess: () => { toast('Stock corrected'); refresh(); }, onError: (e) => toast(errText(e), 'err') });
  if (q.isLoading || !q.data) return <Skeleton rows={6} />;
  const d = q.data; const m = d.medicine;
  const margin = m.mrpPaise && d.avgCostPaise ? `${Math.round(((m.mrpPaise - d.avgCostPaise) / m.mrpPaise) * 100)}%` : '—';
  const moves = d.moves.filter((x: any) => kind === 'all' || (kind === 'in' ? x.change > 0 && x.kind !== 'count' && x.kind !== 'adjust' : kind === 'out' ? x.change < 0 && x.kind !== 'count' && x.kind !== 'adjust' : ['count', 'adjust'].includes(x.kind)));
  const what: Record<string, string> = { receive: 'Received', sale: 'Sold', patient_return: 'Returned by patient', vendor_return: 'Returned to vendor', count: 'Stock count', adjust: 'Adjusted' };
  const live = d.batches.filter((b: any) => b.qty > 0);
  const doAdjust = async (b: any) => {
    const a = await ask({ title: `Adjust ${m.name} · batch ${b.batchNo}`, body: `On hand ${b.qty}. Enter the change, e.g. -1 for a damaged strip.`, confirmLabel: 'Next', field: { label: 'Change (+ or -)', required: true, maxLength: 6 } });
    if (!a) return; const change = Number(a.value.trim()); if (!Number.isInteger(change) || change === 0) return toast('Enter a whole number like -1 or 2.', 'err');
    if (b.qty + change < 0) return toast(`Only ${b.qty} in this batch.`, 'err');
    const r = await ask({ title: 'Reason for the adjustment', confirmLabel: 'Adjust', field: { label: 'Reason', required: true, maxLength: 200, placeholder: 'Damaged, expired, found in store…' } });
    if (r && r.value.trim().length >= 3) adjust.mutate({ batchId: b.id, change, reason: r.value.trim() }); else if (r) toast('Please give a reason.', 'err');
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="mr-auto"><button className="text-sm text-muted hover:text-ink" onClick={() => go({ tab: 'stock' })}>← Stock</button><h2 className="text-2xl font-semibold">{m.name}</h2>
          <div className="text-sm text-muted">{[['tab', 'cap'].includes(m.form) ? `strip of ${m.packSize}` : m.form, m.scheduleClass && m.scheduleClass !== 'OTC' ? `Schedule ${m.scheduleClass}` : 'OTC', m.hsn ? `HSN ${m.hsn}` : null, `GST ${m.gstBp / 100}%`, `MRP ${money(m.mrpPaise)}`].filter(Boolean).join(' · ')}</div></div>
        {can(perms, 'stock.write') && <><button className="btn" onClick={() => setReturning(true)}>Return to vendor</button><button className="btn btn-primary" onClick={() => go({ tab: 'orders', order: 'new' })}>Order more</button></>}
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="On hand" value={d.onHand} sub={`${live.length} batch${live.length === 1 ? '' : 'es'}`} />
        <Tile label="Real cost per pack" value={rupees2(d.avgCostPaise)} sub="Average, free units included" />
        <Tile label="Margin at MRP" value={margin} sub={`${money(m.mrpPaise)} − ${rupees2(d.avgCostPaise)}`} />
        <Tile label="Sold, last 30 days" value={d.sold30} sub={`Reorder at ${m.reorderLevel}${d.onHand === 0 ? ' · out of stock' : d.sold30 ? ` · about ${Math.max(1, Math.round((d.onHand / d.sold30) * 30 / 7))} weeks left` : ''}`} />
      </div>
      <div className="card !p-0 overflow-x-auto">
        <div className="px-5 pt-4 pb-2 flex items-baseline gap-2"><b>Batches</b><span className="text-xs text-muted">The counter sells the batch that expires first, automatically.</span></div>
        <table className="table min-w-[760px]"><thead><tr><th>Batch</th><th>Expiry</th><th>Came from</th><th className="!text-right">Paid</th><th className="!text-right">Free</th><th className="!text-right">Real cost</th><th className="!text-right">On hand</th><th></th></tr></thead>
          <tbody>{d.batches.length === 0 ? <tr><td colSpan={8} className="text-center text-muted">No stock received yet.</td></tr> : d.batches.map((b: any) => <tr key={b.id} className={b.qty === 0 ? 'text-muted' : ''}>
            <td className="font-semibold">{b.batchNo}</td><td>{b.expired ? <Chip tone="rose">expired {exp(b.expiry)}</Chip> : exp(b.expiry)}</td><td>{b.vendor ?? 'Opening stock'} · {b.receiptNo ?? ''} · {fmtDate(b.createdAt)}</td>
            <td className="text-right">{b.paidQty}</td><td className="text-right">{b.freeQty}</td><td className="text-right">{rupees2(b.costPaise)}</td><td className="text-right font-semibold">{b.qty}</td>
            <td className="text-right whitespace-nowrap">{b.sellingNow && <Chip tone="sky">selling now</Chip>}{can(perms, 'stock.approve') && (b.qty > 0 || !b.expired) && <button className="btn btn-sm btn-ghost ml-1" onClick={() => doAdjust(b)}>Adjust</button>}</td></tr>)}</tbody></table>
      </div>
      <div className="card !p-0 overflow-x-auto">
        <div className="flex flex-wrap items-center gap-2 px-5 pt-4 pb-2"><b className="mr-2">Every movement</b><Segmented value={kind} onChange={setKind} options={[{ value: 'all', label: 'All' }, { value: 'in', label: 'In' }, { value: 'out', label: 'Out' }, { value: 'adj', label: 'Adjustments' }]} /><span className="ml-auto text-xs text-muted">Nothing can be deleted; a mistake is corrected by a new entry.</span></div>
        <table className="table min-w-[760px]"><thead><tr><th>When</th><th>What</th><th>Batch</th><th className="!text-right">Change</th><th className="!text-right">Balance</th><th>By</th><th>Document</th></tr></thead>
          <tbody>{moves.length === 0 ? <tr><td colSpan={7} className="text-center text-muted">Nothing yet.</td></tr> : moves.map((x: any) => <tr key={x.id}><td className="whitespace-nowrap">{fmtDate(x.createdAt)} {fmtTime(x.createdAt)}</td><td>{what[x.kind] ?? x.kind}{x.note ? <div className="text-xs text-muted">{x.note}</div> : null}</td><td>{x.batchNo}</td>
            <td className={`text-right font-semibold ${x.change > 0 ? 'text-sage' : 'text-rose'}`}>{x.change > 0 ? '+' : ''}{x.change}</td><td className="text-right">{x.balance}</td><td>{x.byName}</td><td className="font-medium">{x.docNo ?? '—'}</td></tr>)}</tbody></table>
      </div>
      {returning && <ReturnDialog medicine={m} batches={live} onClose={() => setReturning(false)} />}
    </div>
  );
}

function ReturnDialog({ medicine, batches, vendorId, onClose }: { medicine?: any; batches?: any[]; vendorId?: string; onClose: () => void }) {
  const vendors = useQuery({ queryKey: ['vendors'], queryFn: () => get('/vendors') });
  const meds = useQuery({ queryKey: ['pharmacy', 'medicines'], queryFn: () => get('/pharmacy/medicines'), enabled: !batches });
  const [v, setV] = useState(vendorId ?? ''); const [medId, setMedId] = useState(medicine?.id ?? ''); const [batchId, setBatchId] = useState(batches?.[0]?.id ?? ''); const [qty, setQty] = useState(''); const [reason, setReason] = useState('');
  const list: any[] = batches ?? (meds.data ?? []).find((m: any) => m.id === medId)?.batches ?? [];
  const b = list.find((x) => x.id === batchId);
  useEffect(() => { if (!batches) setBatchId(''); }, [medId]);
  const save = useMutation({ mutationFn: () => post('/stock/returns', { vendorId: v, reason: reason.trim(), lines: [{ batchId, qty: Number(qty) }] }), onSuccess: (r: any) => { toast(`Return ${r.docNo} saved`); refresh(); onClose(); }, onError: (e) => toast(errText(e), 'err') });
  const problem = !v ? 'Pick the vendor.' : !batchId ? 'Pick the batch.' : !(Number(qty) > 0) ? 'Enter the quantity.' : b && Number(qty) > b.qty ? `Only ${b.qty} in this batch.` : reason.trim().length < 3 ? 'Give a reason.' : '';
  return (
    <Modal title="Return stock to the vendor" subtitle={medicine?.name} onClose={onClose} width="max-w-lg">
      <div className="space-y-3">
        <label className="block"><span className="label">Vendor</span><select className="input" value={v} onChange={(e) => setV(e.target.value)}><option value="">Choose</option>{(vendors.data ?? []).map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
        {!medicine && <label className="block"><span className="label">Medicine</span><select className="input" value={medId} onChange={(e) => setMedId(e.target.value)}><option value="">Choose</option>{(meds.data ?? []).filter((m: any) => m.onHand > 0).map((m: any) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>}
        <label className="block"><span className="label">Batch</span><select className="input" value={batchId} onChange={(e) => setBatchId(e.target.value)}><option value="">Choose</option>{list.map((x: any) => <option key={x.id} value={x.id}>{x.batchNo} · exp {exp(x.expiry)} · {x.qty} on hand</option>)}</select></label>
        <label className="block"><span className="label">Quantity</span><NumInput className={`input ${b && Number(qty) > b.qty ? '!border-rose' : ''}`} max={99999} value={qty} onChange={(e) => setQty(e.target.value)} /></label>
        <label className="block"><span className="label">Reason</span><input className="input" list="rt-reasons" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} /><datalist id="rt-reasons"><option>Expiring soon</option><option>Damaged in transit</option><option>Wrong item sent</option><option>Not selling</option></datalist></label>
        {problem && (qty || reason) && <div className="text-xs text-rose">{problem}</div>}
      </div>
      <div className="modal-foot"><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!!problem || save.isPending} onClick={() => save.mutate()}>Save return</button></div>
    </Modal>
  );
}

function CountView({ id, go }: { id: string; go: Go }) {
  const { perms } = useOutletContext<any>();
  const q = useQuery({ queryKey: ['stockdocs', id], queryFn: () => get(`/stock/docs/${id}`) });
  const [vals, setVals] = useState<Record<string, string>>({}); const [find, setFind] = useState('');
  useEffect(() => { if (q.data?.status === 'open') setVals(Object.fromEntries(q.data.lines.filter((l: any) => l.counted != null).map((l: any) => [l.batchId, String(l.counted)]))); }, [q.data?.id, q.data?.status]);
  const lines = () => Object.entries(vals).filter(([, v]) => v !== '').map(([batchId, v]) => ({ batchId, counted: Number(v) }));
  const save = useMutation({ mutationFn: (final: boolean) => post(`/stock/counts/${id}/submit`, { lines: lines(), final }), onSuccess: (r: any, final) => { toast(final ? (r.status === 'closed' ? 'Count closed: everything matched' : 'Count saved: gaps go to the owner') : 'Progress saved'); refresh(); }, onError: (e) => toast(errText(e), 'err') });
  if (q.isLoading || !q.data) return <Skeleton rows={6} />;
  const d = q.data;
  const todo = d.lines.filter((l: any) => ['todo', 'recount'].includes(l.state));
  const shown = todo.filter((l: any) => !find.trim() || l.name.toLowerCase().includes(find.trim().toLowerCase()) || l.batchNo.toLowerCase().includes(find.trim().toLowerCase()));
  const gaps = d.lines.filter((l: any) => ['gap', 'approved'].includes(l.state));
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="mr-auto"><button className="text-sm text-muted hover:text-ink" onClick={() => go({ tab: 'stock' })}>← Stock</button><h2 className="text-2xl font-semibold">Stock count {d.docNo} · {fmtDate(d.createdAt)}</h2>
          <div className="text-sm text-muted">Started by {d.createdByName} · {d.lines.length} batches · {d.lines.filter((l: any) => l.state === 'match').length} matched{gaps.length ? ` · ${gaps.length} with a gap` : ''}</div></div>
        <Chip tone={d.status === 'closed' ? 'sage' : d.status === 'review' ? 'amber' : 'sky'}>{d.status === 'open' ? 'counting' : d.status === 'review' ? 'waiting for owner' : 'closed'}</Chip>
      </div>
      {d.status === 'open' && <div className="card !p-0 overflow-x-auto">
        <div className="flex flex-wrap items-center gap-2 px-5 pt-4 pb-2"><b className="mr-2">Count the shelf</b><span className="text-xs text-muted">Type what is on the shelf for each batch. The system figure is shown only after you submit.</span>
          <input className="input !w-56 ml-auto" aria-label="Find in count" placeholder="Medicine or batch" value={find} onChange={(e) => setFind(e.target.value)} /></div>
        <table className="table min-w-[560px]"><thead><tr><th>Medicine</th><th>Batch</th><th>Expiry</th><th className="!text-right">Counted</th></tr></thead>
          <tbody>{shown.map((l: any) => <tr key={l.batchId}><td className="font-medium">{l.name}{l.state === 'recount' && <Chip tone="amber" className="ml-2">recount</Chip>}</td><td>{l.batchNo}</td><td>{exp(l.expiry)}</td>
            <td className="text-right"><NumInput aria-label={`Counted ${l.name} ${l.batchNo}`} className="input !w-20 !px-2 text-right" max={99999} value={vals[l.batchId] ?? ''} onChange={(e) => setVals({ ...vals, [l.batchId]: e.target.value })} /></td></tr>)}</tbody></table>
        <div className="flex flex-wrap items-center gap-2 px-5 py-4"><span className="text-sm text-muted mr-auto">{lines().filter((l) => todo.some((t: any) => t.batchId === l.batchId)).length} of {todo.length} counted</span>
          <button className="btn" disabled={save.isPending} onClick={() => save.mutate(false)}>Save progress</button><button className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate(true)}>Submit count</button></div>
      </div>}
      {gaps.length > 0 && <div className="space-y-3">{gaps.map((l: any) => <GapCard key={l.batchId} countId={id} line={l} canApprove={can(perms, 'stock.approve')} />)}</div>}
      {d.status === 'closed' && gaps.length === 0 && <div className="card"><Empty icon="check" title="Every batch matched" /></div>}
    </div>
  );
}

function GapCard({ countId, line: l, canApprove }: { countId: string; line: any; canApprove: boolean }) {
  const tr = useQuery({ queryKey: ['stock', 'trace', l.batchId], queryFn: () => get(`/stock/batches/${l.batchId}/trace`) });
  const [reason, setReason] = useState('');
  const act = useMutation({ mutationFn: (action: 'approve' | 'recount') => post(`/stock/counts/${countId}/resolve`, { batchId: l.batchId, action, reason: reason || undefined }), onSuccess: (_r, a) => { toast(a === 'approve' ? 'Stock corrected' : 'Sent back for a recount'); refresh(); }, onError: (e) => toast(errText(e), 'err') });
  const t = tr.data; const gap = l.counted - l.system;
  return (
    <div className="card grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div>
        <div className="flex items-center gap-2"><b>{l.name}</b><span className="text-sm text-muted">{l.batchNo} · {exp(l.expiry)}</span>{l.state === 'approved' && <Chip tone="sage">approved · {l.approvedBy}</Chip>}</div>
        <div className="mt-2 text-sm">System <b>{l.system}</b> · counted <b>{l.counted}</b> · <b className={gap < 0 ? 'text-rose' : 'text-sage'}>{gap > 0 ? '+' : ''}{gap}</b>{l.countedBy ? <span className="text-muted"> · counted by {l.countedBy}</span> : null}</div>
        {l.state === 'approved' ? <div className="mt-2 text-sm text-muted">Reason: {l.reason}</div> : canApprove ? <div className="mt-3 space-y-2">
          <select className="input" aria-label="Reason for the gap" value={reason} onChange={(e) => setReason(e.target.value)}><option value="">Choose a reason</option>{['Sample given by doctor', 'Damaged or expired', 'Counting error', 'Found in store', 'Unexplained loss'].map((r) => <option key={r}>{r}</option>)}</select>
          <div className="flex gap-2 justify-end"><button className="btn" disabled={act.isPending} onClick={() => act.mutate('recount')}>Ask for recount</button><button className="btn btn-primary" disabled={!reason || act.isPending} onClick={() => act.mutate('approve')}>Approve correction</button></div>
        </div> : <div className="mt-2 text-sm text-muted">Waiting for the owner.</div>}
      </div>
      <div className="text-sm">
        <div className="label">Where this batch went</div>
        {!t ? <Skeleton rows={3} /> : <div className="space-y-1">
          {[['Received', `+${t.received}`, `${t.batch.paidQty} paid + ${t.batch.freeQty} free`], ['Sold', `−${t.sold}`, `${t.bills} bills`], ['Returned to vendor', t.returned ? `−${t.returned}` : '0', ''], ['Adjusted', String(t.adjusted), '']].map(([a, b, c]) =>
            <div key={a} className="flex justify-between gap-2"><span>{a}{c && <span className="text-xs text-muted"> · {c}</span>}</span><b>{b}</b></div>)}
          <div className="flex justify-between border-t border-ink/10 pt-1"><span>Should be on the shelf</span><b>{l.system}</b></div>
          <div className="flex justify-between"><span>Found</span><b>{l.counted}</b></div>
          {t.sellers.length > 0 && <div className="pt-2"><div className="label !mb-1">Who sold from this batch</div>{t.sellers.map((s: any) => <div key={s.name} className="flex justify-between"><span>{s.name}</span><b>{s.bills} bills</b></div>)}</div>}
          <div className="pt-2 text-xs text-muted">Free units sit in the batch like paid ones. A gap like this is how a unit sold off the books shows up.</div>
        </div>}
      </div>
    </div>
  );
}

/* ---------------- Orders and receiving ---------------- */

export function OrdersTab({ sp, go }: { sp: URLSearchParams; go: Go }) {
  const { perms } = useOutletContext<any>();
  const order = sp.get('order'); const receive = sp.get('receive');
  const [kind, setKind] = useState<'order' | 'receipt' | 'return'>('order');
  const docs = useQuery({ queryKey: ['stockdocs', 'list', kind], queryFn: () => get(`/stock/docs?kind=${kind}`), enabled: !order && !receive });
  const [open, setOpen] = useState<string | null>(null);
  const cancel = useMutation({ mutationFn: (id: string) => post(`/stock/orders/${id}/cancel`), onSuccess: () => { toast('Order cancelled'); refresh(); }, onError: (e) => toast(errText(e), 'err') });
  if (order) return <OrderEditor go={go} vendorId={sp.get('vendor') ?? ''} />;
  if (receive) return <ReceiveView go={go} orderId={receive === 'new' ? null : receive} />;
  const rows: any[] = docs.data ?? [];
  const tone = (s: string) => (['open', 'review'].includes(s) ? 'amber' : s === 'part' ? 'sky' : s === 'cancelled' ? '' : 'sage') as any;
  const label: Record<string, string> = { open: 'open', part: 'part received', closed: 'closed', cancelled: 'cancelled', review: 'waiting for owner', ok: 'matched', settled: 'decided', done: 'done' };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented value={kind} onChange={setKind} options={[{ value: 'order', label: 'Purchase orders' }, { value: 'receipt', label: 'Deliveries' }, { value: 'return', label: 'Returns' }]} />
        {can(perms, 'stock.write') && <span className="ml-auto flex gap-2"><button className="btn" onClick={() => go({ tab: 'orders', receive: 'new' })}>Receive without order</button><button className="btn btn-primary" onClick={() => go({ tab: 'orders', order: 'new' })}><Icon name="plus" />New purchase order</button></span>}
      </div>
      <div className="card !p-0 overflow-x-auto">
        {docs.isLoading ? <div className="p-5"><Skeleton rows={4} /></div> : rows.length === 0 ? <Empty icon="inbox" title={kind === 'order' ? 'No purchase orders yet' : kind === 'receipt' ? 'No deliveries yet' : 'No returns yet'} /> : (
          <table className="table min-w-[760px]"><thead><tr><th>{kind === 'order' ? 'Order' : kind === 'receipt' ? 'Delivery' : 'Return'}</th><th>Date</th><th>Vendor</th><th>{kind === 'receipt' ? 'Bill' : kind === 'order' ? 'Deliver by' : 'Reason'}</th><th>Items</th><th className="!text-right">{kind === 'return' ? 'Credit' : 'Amount'}</th><th>Status</th><th></th></tr></thead>
            <tbody>{rows.map((r) => <tr key={r.id} className="cursor-pointer hover:bg-white/60" onClick={() => setOpen(r.id)}>
              <td className="font-semibold">{r.docNo}</td><td className="whitespace-nowrap">{fmtDate(r.createdAt)}</td><td>{r.vendor ?? 'Opening stock'}</td><td>{kind === 'receipt' ? r.billNo ?? '—' : kind === 'order' ? (r.dueDate ? fmtDate(r.dueDate) : '—') : r.note}</td>
              <td className="text-sm">{r.lines.map((l: any) => l.name).slice(0, 2).join(', ')}{r.lines.length > 2 ? ` +${r.lines.length - 2}` : ''}</td>
              <td className="text-right">{money(r.lines.reduce((n: number, l: any) => n + (l.amountPaise ?? l.creditPaise ?? 0), 0))}</td>
              <td><Chip tone={tone(r.status)}>{label[r.status] ?? r.status}</Chip></td>
              <td className="text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>{kind === 'order' && ['open', 'part'].includes(r.status) && can(perms, 'stock.write') && <>
                {r.status === 'open' && <button className="btn btn-sm btn-ghost" onClick={async () => { if (await ask({ title: `Cancel ${r.docNo}?`, confirmLabel: 'Cancel order', cancelLabel: 'Keep', tone: 'danger' })) cancel.mutate(r.id); }}>Cancel</button>}
                <button className="btn btn-sm btn-primary" onClick={() => go({ tab: 'orders', receive: r.id })}>Receive</button></>}</td></tr>)}</tbody></table>)}
      </div>
      {open && (kind === 'receipt' ? <DecisionDialog id={open} onClose={() => setOpen(null)} /> : <DocDialog id={open} onClose={() => setOpen(null)} />)}
    </div>
  );
}

function DocDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ['stockdocs', id], queryFn: () => get(`/stock/docs/${id}`) }); const d = q.data;
  return (
    <Modal title={d ? `${d.docNo} · ${d.vendor?.name ?? ''}` : '…'} subtitle={d ? `${fmtDate(d.createdAt)} · ${d.createdByName}${d.dueDate ? ` · deliver by ${fmtDate(d.dueDate)}` : ''}${d.note ? ` · ${d.note}` : ''}` : ''} onClose={onClose} width="max-w-2xl">
      {!d ? <Skeleton rows={3} /> : <table className="table"><thead><tr><th className="!pl-0">Medicine</th><th className="!text-right">Qty</th><th className="!text-right">{d.kind === 'return' ? 'Batch' : 'Free'}</th><th className="!text-right !pr-0">{d.kind === 'return' ? 'Credit' : 'Rate'}</th></tr></thead>
        <tbody>{d.lines.map((l: any, i: number) => <tr key={i}><td className="!pl-0">{l.name}{l.scheme ? <div className="text-xs text-muted">{l.scheme}</div> : null}</td><td className="text-right">{l.qty}</td><td className="text-right">{d.kind === 'return' ? l.batchNo : l.freeQty}</td><td className="text-right !pr-0">{d.kind === 'return' ? money(l.creditPaise) : `${rupees2(l.ratePaise)}${l.discBp ? ` less ${l.discBp / 100}%` : ''}`}</td></tr>)}</tbody></table>}
      <div className="modal-foot"><button className="btn" onClick={onClose}>Close</button></div>
    </Modal>
  );
}

type OLine = { medicineId: string; name: string; qty: string; scheme: string; rate: string; disc: string; gstBp: number; onHand?: number; lastPaidPaise?: number | null; packSize?: number; form?: string };

function OrderEditor({ go, vendorId: initial }: { go: Go; vendorId: string }) {
  const vendors = useQuery({ queryKey: ['vendors'], queryFn: () => get('/vendors') });
  const [vendorId, setVendorId] = useState(initial); const [due, setDue] = useState(''); const [ref, setRef] = useState('');
  const draft = useQuery({ queryKey: ['stock', 'draft', vendorId], queryFn: () => get(`/stock/order-draft?vendorId=${vendorId}`), enabled: !!vendorId });
  const [lines, setLines] = useState<OLine[]>([]); const [tried, setTried] = useState(false);
  const toLine = (x: any): OLine => ({ medicineId: x.medicineId, name: x.name, qty: String(x.qty), scheme: x.scheme ?? '', rate: toRupees(x.ratePaise), disc: x.discBp ? String(x.discBp / 100) : '', gstBp: x.gstBp, onHand: x.onHand, lastPaidPaise: x.lastPaidPaise, packSize: x.packSize, form: x.form });
  useEffect(() => { if (draft.data) setLines(draft.data.lines.map(toLine)); }, [draft.data]);
  const set = (i: number, p: Partial<OLine>) => setLines((ls) => ls.map((l, k) => k === i ? { ...l, ...p } : l));
  const calc = lines.map((l) => { const qty = Number(l.qty) || 0; const rate = toPaise(l.rate); const disc = Math.round(Number(l.disc || 0) * 100); const free = schemeFree(l.scheme, qty); const amt = taxable(qty, rate, disc);
    return { qty, rate, disc, free, amt, gross: withGst(amt, l.gstBp), cost: qty + free ? Math.round(amt / (qty + free)) : 0 }; });
  const tot = calc.reduce((a, c) => ({ rate: a.rate + c.qty * c.rate, disc: a.disc + (c.qty * c.rate - c.amt), gst: a.gst + (c.gross - c.amt), pay: a.pay + c.gross, free: a.free + c.free, freeVal: a.freeVal + c.free * c.rate }), { rate: 0, disc: 0, gst: 0, pay: 0, free: 0, freeVal: 0 });
  const v = (vendors.data ?? []).find((x: any) => x.id === vendorId);
  const problem = !vendorId ? 'Pick the vendor.' : !lines.length ? 'Add at least one medicine.' : calc.some((c) => c.qty < 1) ? 'Every line needs a quantity.' : calc.some((c) => c.rate < 1) ? 'Every line needs a rate.' : calc.some((c) => c.disc > 10000) ? 'Discount cannot be above 100%.' : '';
  const save = useMutation({ mutationFn: (send: boolean) => post('/stock/orders', { vendorId, dueDate: due || null, vendorRef: ref.trim() || null, send, lines: lines.map((l, i) => ({ medicineId: l.medicineId, qty: calc[i].qty, scheme: l.scheme.trim() || null, ratePaise: calc[i].rate, discBp: calc[i].disc })) }),
    onSuccess: (d: any, send) => { toast(`${d.docNo} saved${send && v?.phone ? ', sent to the vendor' : ''}`); refresh(); go({ tab: 'orders' }); }, onError: (e) => toast(errText(e), 'err') });
  const addable = (draft.data?.all ?? []).filter((x: any) => !lines.some((l) => l.medicineId === x.medicineId));
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3"><div className="mr-auto"><button className="text-sm text-muted hover:text-ink" onClick={() => go({ tab: 'orders' })}>← Orders</button><h2 className="text-2xl font-semibold">New purchase order</h2></div>
        <button className="btn" disabled={save.isPending} onClick={() => { setTried(true); if (!problem) save.mutate(false); }}>Save without sending</button>
        <button className="btn btn-primary" disabled={save.isPending} onClick={() => { setTried(true); if (!problem) save.mutate(true); }}><Icon name="message" />Save and send on WhatsApp</button></div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px] xl:items-start">
        <div className="card">
          <div className="grid gap-3 sm:grid-cols-3">
            <label><span className="label">Vendor</span><select className={`input ${tried && !vendorId ? '!border-rose' : ''}`} value={vendorId} onChange={(e) => setVendorId(e.target.value)}><option value="">Choose</option>{(vendors.data ?? []).filter((x: any) => x.active).map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
              {(vendors.data ?? []).length === 0 && <button className="mt-1 text-xs text-clay" onClick={() => go({ tab: 'vendors', add: '1' })}>Add a vendor first</button>}</label>
            <label><span className="label">Deliver by</span><input type="date" className="input" min={today()} value={due} onChange={(e) => setDue(e.target.value)} /></label>
            <label><span className="label">Vendor's quote ref (optional)</span><input className="input" maxLength={60} value={ref} onChange={(e) => setRef(e.target.value)} placeholder="WhatsApp, call or quote no." /></label>
          </div>
          {vendorId && <div className="mt-2 text-xs text-muted">Pre-filled with the medicines below their reorder level. Rates and schemes come from the last order; change only what the vendor quoted differently.{draft.data?.owed?.length ? ` This vendor still owes: ${draft.data.owed.map((o: any) => `${o.qty} ${o.name}`).join(', ')}.` : ''}</div>}
          <div className="mt-3 -mx-5 overflow-x-auto">
            <table className="table min-w-[940px]"><thead><tr><th>Medicine</th><th className="!text-right">Order qty</th><th>Scheme promised</th><th className="!text-right">Free</th><th className="!text-right">Rate ₹</th><th className="!text-right">Disc %</th><th className="!text-right">GST</th><th className="!text-right">Real cost</th><th className="!text-right">Amount</th><th></th></tr></thead>
              <tbody>{lines.length === 0 ? <tr><td colSpan={10} className="text-center text-muted">{vendorId ? 'Nothing is low. Add medicines below.' : 'Pick the vendor first.'}</td></tr> : lines.map((l, i) => { const c = calc[i]; const up = l.lastPaidPaise && c.rate > l.lastPaidPaise; return (
                <tr key={l.medicineId} className={up ? 'bg-amber-soft/40' : ''}>
                  <td><div className="font-semibold">{l.name}</div><div className="text-xs text-muted">{l.lastPaidPaise ? `last paid ${rupees2(l.lastPaidPaise)} · ` : ''}on hand {l.onHand ?? 0}</div></td>
                  <td className="text-right"><NumInput aria-label={`Order quantity ${l.name}`} className={`input !w-20 !px-2 text-right ${tried && c.qty < 1 ? '!border-rose' : ''}`} max={99999} value={l.qty} onChange={(e) => set(i, { qty: e.target.value })} /></td>
                  <td><input aria-label={`Scheme ${l.name}`} className="input !w-36 !px-2" placeholder="none" value={l.scheme} maxLength={40} onChange={(e) => set(i, { scheme: e.target.value })} /></td>
                  <td className="text-right font-semibold">{c.free}</td>
                  <td className="text-right"><MoneyInput label={`Rate ${l.name}`} className={`!w-28 ${tried && c.rate < 1 ? '[&_input]:!border-rose' : ''}`} value={l.rate} onChange={(x) => set(i, { rate: x })} /></td>
                  <td className="text-right"><NumInput aria-label={`Discount ${l.name}`} decimal className="input !w-16 !px-2 text-right" max={99} value={l.disc} onChange={(e) => set(i, { disc: e.target.value })} /></td>
                  <td className="text-right">{l.gstBp / 100}%</td>
                  <td className="text-right font-semibold">{c.qty ? rupees2(c.cost) : '—'}{c.free > 0 && <div className="text-xs text-muted font-normal">with free</div>}</td>
                  <td className="text-right">{money(c.gross)}{up && <div><Chip tone="amber">{rupees2(c.rate - (l.lastPaidPaise ?? 0))} above last time</Chip></div>}</td>
                  <td><button className="btn btn-ghost btn-icon" aria-label={`Remove ${l.name}`} onClick={() => setLines((ls) => ls.filter((_, k) => k !== i))}><Icon name="x" /></button></td></tr>); })}</tbody></table>
          </div>
          {vendorId && <div className="mt-3 flex flex-wrap items-center gap-3">
            <select className="input !w-72" aria-label="Add medicine" value="" onChange={(e) => { const x = addable.find((a: any) => a.medicineId === e.target.value); if (x) setLines((ls) => [...ls, toLine({ ...x, qty: x.qty })]); }}><option value="">+ Add medicine</option>{addable.map((x: any) => <option key={x.medicineId} value={x.medicineId}>{x.name} · on hand {x.onHand}</option>)}</select>
            <span className="text-xs text-muted">Scheme is free text the app understands: "5 free per 50", "10+1", "buy 12 get 2".</span></div>}
          {tried && problem && <div className="mt-2 text-sm text-rose">{problem}</div>}
        </div>
        <div className="space-y-4">
          <div className="card text-sm space-y-1.5"><div className="label">Order total</div>
            <div className="flex justify-between"><span>Items at rate</span><b>{rupees2(tot.rate)}</b></div><div className="flex justify-between"><span>Discount</span><b>− {rupees2(tot.disc)}</b></div><div className="flex justify-between"><span>GST</span><b>{rupees2(tot.gst)}</b></div>
            <div className="flex justify-between border-t border-ink/10 pt-2 text-base"><span>Payable</span><b>{rupees2(tot.pay)}</b></div>
            <div className="flex justify-between pt-2"><span>Free units promised</span><b>{tot.free}</b></div><div className="text-xs text-muted">Worth {rupees2(tot.freeVal)} at rate. The delivery is checked against this.</div></div>
          {lines.length > 0 && <div className="card text-sm"><div className="label">What the vendor receives</div>
            <div className="mt-2 rounded-2xl bg-sage-soft/70 p-3 whitespace-pre-line text-[13px] leading-relaxed">{[`New order${due ? ` · deliver by ${fmtDate(due)}` : ''}`, ...lines.map((l, i) => `${l.name} · ${calc[i].qty}${calc[i].free ? ` + ${calc[i].free} free` : ''} · ${rupees2(calc[i].rate)}${calc[i].disc ? ` less ${calc[i].disc / 100}%` : ''}`), 'Please reply OK to confirm.'].join('\n')}</div>
            <div className="mt-2 text-xs text-muted">{v?.phone ? `Sent to ${v.phone} on WhatsApp. ` : 'This vendor has no phone number, so nothing is sent. '}The order number is added when it is saved.</div></div>}
        </div>
      </div>
    </div>
  );
}

type RLine = { medicineId: string; name: string; gstBp: number; mrp: string; qty: string; free: string; rate: string; disc: string; batch: string; expiry: string; promised?: any };

function ReceiveView({ go, orderId }: { go: Go; orderId: string | null }) {
  const order = useQuery({ queryKey: ['stockdocs', orderId], queryFn: () => get(`/stock/docs/${orderId}`), enabled: !!orderId });
  const vendors = useQuery({ queryKey: ['vendors'], queryFn: () => get('/vendors') });
  const meds = useQuery({ queryKey: ['pharmacy', 'medicines'], queryFn: () => get('/pharmacy/medicines') });
  const prior = useQuery({ queryKey: ['stockdocs', 'list', 'receipt'], queryFn: () => get('/stock/docs?kind=receipt'), enabled: !!orderId });
  const [vendorId, setVendorId] = useState(''); const [billNo, setBillNo] = useState(''); const [billDate, setBillDate] = useState(today()); const [billTotal, setBillTotal] = useState('');
  const [photo, setPhoto] = useState<{ mime: string; dataBase64: string; name: string } | null>(null); const [keepOpen, setKeepOpen] = useState(false);
  const [lines, setLines] = useState<RLine[]>([]); const [tried, setTried] = useState(false);
  const opening = !orderId && vendorId === 'opening';
  useEffect(() => {
    if (!order.data || !meds.data || !prior.data) return;
    const got = (id: string) => prior.data.filter((r: any) => r.orderId === order.data.id).reduce((n: number, r: any) => n + (r.lines.find((x: any) => x.medicineId === id)?.qty ?? 0), 0);
    setLines(order.data.lines.map((l: any) => { const m = meds.data.find((x: any) => x.id === l.medicineId); const left = Math.max(0, l.qty - got(l.medicineId));
      return { medicineId: l.medicineId, name: l.name, gstBp: l.gstBp, mrp: toRupees(m?.mrpPaise), qty: String(left), free: String(Math.floor((l.freeQty * left) / l.qty)), rate: toRupees(l.ratePaise), disc: l.discBp ? String(l.discBp / 100) : '', batch: '', expiry: '', promised: { ...l, left } }; }));
  }, [order.data, meds.data, prior.data]);
  const set = (i: number, p: Partial<RLine>) => setLines((ls) => ls.map((l, k) => k === i ? { ...l, ...p } : l));
  const calc = lines.map((l) => { const qty = Number(l.qty) || 0; const free = Number(l.free) || 0; const rate = toPaise(l.rate); const disc = Math.round(Number(l.disc || 0) * 100); const amt = withGst(taxable(qty, rate, disc), l.gstBp);
    const p = l.promised; if (!p) return { qty, free, rate, disc, amt, extra: 0, short: 0 };
    const expFree = Math.min(p.freeQty, Math.floor((p.freeQty * qty) / p.qty)); const promisedAmt = withGst(taxable(qty, p.ratePaise, p.discBp), l.gstBp);
    return { qty, free, rate, disc, amt, extra: Math.max(0, amt - promisedAmt), short: Math.max(0, expFree - free) }; });
  const computed = calc.reduce((n, c) => n + c.amt, 0); const billP = toPaise(billTotal);
  const thisMonth = today().slice(0, 7); const soonMonth = (() => { const d = new Date(); d.setMonth(d.getMonth() + 6); return d.toISOString().slice(0, 7); })();
  const vendor = !orderId && !opening ? vendorId : order.data?.vendorId;
  const problem = !orderId && !vendorId ? 'Pick the vendor, or Opening stock.' : !lines.length ? 'Add the items that arrived.' : calc.some((c) => c.qty + c.free <= 0) ? 'Every line needs a quantity, or remove it.'
    : lines.some((l) => !l.batch.trim()) ? 'Enter the batch number for every line.' : lines.some((l) => !l.expiry) ? 'Enter the expiry for every line.' : lines.some((l) => l.expiry < thisMonth) ? 'A batch has already expired.'
    : calc.some((c) => c.rate < 0) ? 'Rate is missing.' : vendor && !billNo.trim() ? "Enter the vendor's bill number." : vendor && !billTotal ? 'Enter the bill total from the paper bill.' : vendor && Math.abs(billP - computed) > 500 ? `The lines add up to ${rupees2(computed)}; the bill says ${rupees2(billP)}. Check rates, quantities and discounts.`
    : vendor && !photo ? "Add a photo of the vendor's bill." : '';
  const save = useMutation({ mutationFn: () => post('/stock/receipts', { orderId: orderId ?? undefined, vendorId: !orderId && !opening ? vendorId : undefined, billNo: billNo.trim() || undefined, billDate: billDate || undefined, billTotalPaise: vendor ? billP : undefined,
    billPhoto: photo ? { mime: photo.mime, dataBase64: photo.dataBase64 } : undefined, keepOpen,
    lines: lines.map((l, i) => ({ medicineId: l.medicineId, qty: calc[i].qty, freeQty: calc[i].free, ratePaise: calc[i].rate, discBp: calc[i].disc, batchNo: l.batch.trim(), expiry: l.expiry, mrpPaise: l.mrp ? toPaise(l.mrp) : undefined })) }),
    onSuccess: (d: any) => { toast(d.status === 'review' ? `${d.docNo} saved · differences go to the owner` : `${d.docNo} saved · stock is on the shelf`); refresh(); go({ tab: 'stock' }); }, onError: (e) => toast(errText(e), 'err') });
  const pickFile = (f?: File) => { if (!f) return; if (f.size > 10 * 1024 * 1024) return toast('That file is too large (10 MB at most).', 'err'); if (!['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(f.type)) return toast('Only JPG, PNG, WebP and PDF files can be added.', 'err');
    const r = new FileReader(); r.onload = () => setPhoto({ mime: f.type, dataBase64: String(r.result), name: f.name }); r.readAsDataURL(f); };
  const addable = (meds.data ?? []).filter((m: any) => !lines.some((l) => l.medicineId === m.id));
  const totalExtra = calc.reduce((n, c) => n + c.extra, 0); const totalShort = calc.reduce((n, c) => n + c.short, 0);
  if (orderId && (order.isLoading || !order.data)) return <Skeleton rows={6} />;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3"><div className="mr-auto"><button className="text-sm text-muted hover:text-ink" onClick={() => go({ tab: 'orders' })}>← Orders</button>
        <h2 className="text-2xl font-semibold">Receive stock{order.data ? ` · ${order.data.vendor?.name}` : ''}</h2>{order.data && <div className="text-sm text-muted">Against {order.data.docNo} · ordered {fmtDate(order.data.createdAt)}</div>}</div></div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px] xl:items-start">
        <div className="card">
          <div className="label">From the vendor's bill and the box</div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {!orderId && <label><span className="label">Vendor</span><select className={`input ${tried && !vendorId ? '!border-rose' : ''}`} value={vendorId} onChange={(e) => setVendorId(e.target.value)}><option value="">Choose</option><option value="opening">Opening stock (no vendor)</option>{(vendors.data ?? []).map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>}
            {!opening && <><label><span className="label">Vendor bill no.</span><input className={`input ${tried && vendor && !billNo.trim() ? '!border-rose' : ''}`} maxLength={40} value={billNo} onChange={(e) => setBillNo(e.target.value)} /></label>
              <label><span className="label">Bill date</span><input type="date" className="input" max={today()} value={billDate} onChange={(e) => setBillDate(e.target.value)} /></label>
              <label><span className="label">Bill total on paper</span><MoneyInput label="Bill total on paper" value={billTotal} onChange={setBillTotal} /></label>
              <label><span className="label">Bill photo (required)</span><span className={`input flex cursor-pointer items-center gap-2 ${tried && vendor && !photo ? '!border-rose' : ''}`}><Icon name="export" className="h-4 w-4 text-muted" /><span className="truncate">{photo ? photo.name : 'Take or pick a photo'}</span>
                <input type="file" className="sr-only" accept="image/*,application/pdf" capture="environment" onChange={(e) => pickFile(e.target.files?.[0])} /></span></label></>}
          </div>
          <div className="mt-3 -mx-5 overflow-x-auto">
            <table className="table min-w-[1060px]"><thead><tr><th>Medicine</th>{orderId && <th className="!text-right">Promised</th>}<th className="!text-right">Billed qty</th><th className="!text-right">Free got</th><th className="!text-right">Rate on bill</th><th className="!text-right">Disc %</th><th>Batch</th><th>Expiry</th><th className="!text-right">MRP</th><th>Check</th><th></th></tr></thead>
              <tbody>{lines.length === 0 ? <tr><td colSpan={11} className="text-center text-muted">Add the items that arrived.</td></tr> : lines.map((l, i) => { const c = calc[i]; const p = l.promised; const soon = l.expiry && l.expiry < soonMonth; return (
                <tr key={l.medicineId} className={c.extra || c.short ? 'bg-rose-soft/30' : ''}>
                  <td className="font-semibold">{l.name}</td>
                  {orderId && <td className="text-right text-sm whitespace-nowrap">{p.qty} + {p.freeQty} free<div className="text-xs text-muted">{rupees2(p.ratePaise)}{p.discBp ? ` less ${p.discBp / 100}%` : ''}{p.left < p.qty ? ` · ${p.left} still due` : ''}</div></td>}
                  <td className="text-right"><NumInput aria-label={`Billed quantity ${l.name}`} className="input !w-20 !px-2 text-right" max={99999} value={l.qty} onChange={(e) => set(i, { qty: e.target.value })} /></td>
                  <td className="text-right"><NumInput aria-label={`Free received ${l.name}`} className={`input !w-16 !px-2 text-right ${c.short ? '!border-amber' : ''}`} max={99999} value={l.free} onChange={(e) => set(i, { free: e.target.value })} /></td>
                  <td className="text-right"><MoneyInput label={`Rate on bill ${l.name}`} className="!w-28" value={l.rate} onChange={(x) => set(i, { rate: x })} /></td>
                  <td className="text-right"><NumInput aria-label={`Discount ${l.name}`} decimal className="input !w-16 !px-2 text-right" max={99} value={l.disc} onChange={(e) => set(i, { disc: e.target.value })} /></td>
                  <td><input aria-label={`Batch ${l.name}`} className={`input !w-28 !px-2 uppercase ${tried && !l.batch.trim() ? '!border-rose' : ''}`} maxLength={30} value={l.batch} onChange={(e) => set(i, { batch: e.target.value.toUpperCase() })} /></td>
                  <td><input type="month" aria-label={`Expiry ${l.name}`} className={`input !w-36 !px-2 ${tried && (!l.expiry || l.expiry < thisMonth) ? '!border-rose' : soon ? '!border-amber' : ''}`} min={thisMonth} value={l.expiry} onChange={(e) => set(i, { expiry: e.target.value })} />{soon && l.expiry >= thisMonth && <div className="text-[11px] text-[#7a5410]">under 6 months</div>}</td>
                  <td className="text-right"><MoneyInput label={`MRP ${l.name}`} className="!w-24" value={l.mrp} onChange={(x) => set(i, { mrp: x })} /></td>
                  <td className="whitespace-nowrap">{!p ? <span className="text-xs text-muted">no order</span> : !c.extra && !c.short ? <Chip tone="sage">matches</Chip> : <span className="space-x-1">{c.extra > 0 && <Chip tone="rose">+{money(c.extra)}</Chip>}{c.short > 0 && <Chip tone="amber">{c.short} free short</Chip>}</span>}</td>
                  <td><button className="btn btn-ghost btn-icon" aria-label={`Remove ${l.name}`} onClick={() => setLines((ls) => ls.filter((_, k) => k !== i))}><Icon name="x" /></button></td></tr>); })}</tbody></table>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <select className="input !w-72" aria-label="Add item" value="" onChange={(e) => { const m = addable.find((x: any) => x.id === e.target.value); if (m) setLines((ls) => [...ls, { medicineId: m.id, name: m.name, gstBp: m.gstBp, mrp: toRupees(m.mrpPaise), qty: '', free: '0', rate: '', disc: '', batch: '', expiry: '' }]); }}><option value="">+ Add item that arrived</option>{addable.map((m: any) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
            {orderId && <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-clay h-4 w-4" checked={keepOpen} onChange={(e) => setKeepOpen(e.target.checked)} />Part delivery: keep the order open for the rest</label>}
          </div>
          <div className="mt-2 text-xs text-muted">The promised column cannot be changed here. Expiry under 6 months turns amber. A bill total that differs from the lines by more than ₹5 stops the save.</div>
          {tried && problem && <div className="mt-2 text-sm text-rose">{problem}</div>}
          <div className="mt-4 flex justify-end"><button className="btn btn-primary" disabled={save.isPending} onClick={() => { setTried(true); if (!problem) save.mutate(); }}><Icon name="check" />Save receipt · stock goes on the shelf</button></div>
        </div>
        <div className="space-y-4">
          <div className="card text-sm space-y-1.5"><div className="flex items-center gap-2"><b>Differences from the order</b>{(totalExtra > 0 || totalShort > 0) && <Chip tone="rose">owner decides</Chip>}</div>
            {!orderId ? <div className="text-muted">No order to check against. The lines are recorded as billed.</div> : totalExtra === 0 && totalShort === 0 ? <div className="text-muted">Everything matches the order so far.</div> : lines.map((l, i) => <div key={l.medicineId}>
              {calc[i].extra > 0 && <div className="flex justify-between gap-2"><span>{l.name}: {rupees2(calc[i].rate)} vs {rupees2(l.promised.ratePaise)}</span><b>{money(calc[i].extra)} more</b></div>}
              {calc[i].short > 0 && <div className="flex justify-between gap-2"><span>{l.name}: free</span><b>{calc[i].short} short</b></div>}</div>)}
            {vendor && <div className="flex justify-between border-t border-ink/10 pt-2"><span>Lines add up to</span><b>{rupees2(computed)}</b></div>}
            {vendor && billTotal && <div className={`flex justify-between ${Math.abs(billP - computed) > 500 ? 'text-rose' : ''}`}><span>Bill says</span><b>{rupees2(billP)}</b></div>}
            {(totalExtra > 0 || totalShort > 0) && <div className="pt-1 text-xs text-muted">Stock goes on the shelf when you save. The owner decides on the money and the free units.</div>}
          </div>
          {vendor && lines.length > 0 && <div className="card text-sm"><div className="label">Sent to the vendor when saved</div>
            <div className="mt-2 rounded-2xl bg-sage-soft/70 p-3 whitespace-pre-line text-[13px] leading-relaxed">{[`Received against ${order.data?.docNo ?? 'no order'} (bill ${billNo || '…'}):`, ...lines.map((l, i) => `${l.name} · ${calc[i].qty}${calc[i].free ? ` + ${calc[i].free} free` : ''} · ${rupees2(calc[i].rate)}`), 'Reply if this does not match what you sent.'].join('\n')}</div>
            <div className="mt-2 text-xs text-muted">If the vendor actually sent more free units, they will reply. That catches free units kept back at the counter.</div></div>}
        </div>
      </div>
    </div>
  );
}

/* ---------------- Vendors ---------------- */

export function VendorsTab({ sp, go }: { sp: URLSearchParams; go: Go }) {
  const { perms } = useOutletContext<any>();
  const list = useQuery({ queryKey: ['vendors'], queryFn: () => get('/vendors') });
  const sel = sp.get('vendor') ?? list.data?.[0]?.id ?? null;
  const [edit, setEdit] = useState<any>(sp.get('add') ? {} : null);
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[300px_minmax(0,1fr)] lg:items-start">
      <div className="card !p-3 space-y-1">
        {can(perms, 'stock.write') && <button className="btn w-full justify-center mb-2" onClick={() => setEdit({})}><Icon name="plus" />Add vendor</button>}
        {list.isLoading ? <Skeleton rows={3} /> : (list.data ?? []).length === 0 ? <div className="p-3 text-sm text-muted">No vendors yet.</div> : list.data.map((v: any) => (
          <button key={v.id} onClick={() => go({ tab: 'vendors', vendor: v.id })} className={`flex w-full items-center gap-2 rounded-2xl px-3 py-2.5 text-left ${sel === v.id ? 'bg-ink text-white' : 'hover:bg-white/70'}`}>
            <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold">{v.name}</span><span className={`block text-xs ${sel === v.id ? 'text-white/70' : 'text-muted'}`}>{v.address ?? ''}{v.orders30 ? ` · ${v.orders30} order${v.orders30 === 1 ? '' : 's'} this month` : ''}{!v.active ? ' · inactive' : ''}</span></span>
            {v.owed > 0 ? <Chip tone="amber">owes {v.owed}</Chip> : <Chip tone="sage">clear</Chip>}
          </button>))}
      </div>
      <div>{sel ? <VendorAccount key={sel} id={sel} go={go} onEdit={setEdit} /> : <div className="card"><Empty icon="users" title="Add your first vendor" hint="Then make a purchase order, receive the delivery and the app checks it against the vendor's promise." /></div>}</div>
      {edit && <VendorDialog v={edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function VendorDialog({ v, onClose }: { v: any; onClose: () => void }) {
  const [f, setF] = useState({ name: v.name ?? '', phone: v.phone ?? '', gstin: v.gstin ?? '', address: v.address ?? '', note: v.note ?? '', active: v.active ?? true }); const [tried, setTried] = useState(false);
  const save = useMutation({ mutationFn: () => { const b = { name: f.name.trim(), phone: f.phone || null, gstin: f.gstin.trim().toUpperCase() || null, address: f.address.trim() || null, note: f.note.trim() || null, active: f.active }; return v.id ? patch(`/vendors/${v.id}`, b) : post('/vendors', b); },
    onSuccess: () => { toast('Vendor saved'); refresh(); onClose(); }, onError: (e) => toast(errText(e), 'err') });
  const problem = f.name.trim().length < 2 ? 'Enter the vendor name.' : f.phone && !/^[0-9]{10}$/.test(f.phone) ? 'Phone must be 10 digits.' : f.gstin && f.gstin.trim().length !== 15 ? 'GSTIN has 15 characters.' : '';
  return (
    <Modal title={v.id ? 'Edit vendor' : 'Add vendor'} onClose={onClose} width="max-w-lg" submitOnEnter>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="sm:col-span-2"><span className="label">Name</span><input className={`input ${tried && f.name.trim().length < 2 ? '!border-rose' : ''}`} maxLength={100} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus /></label>
        <label><span className="label">WhatsApp number</span><input className={`input ${f.phone && !/^[0-9]{10}$/.test(f.phone) ? '!border-rose' : ''}`} inputMode="numeric" maxLength={10} value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value.replace(/\D/g, '') })} placeholder="10 digits" /></label>
        <label><span className="label">GSTIN</span><input className={`input uppercase ${f.gstin && f.gstin.trim().length !== 15 ? '!border-rose' : ''}`} maxLength={15} value={f.gstin} onChange={(e) => setF({ ...f, gstin: e.target.value })} /></label>
        <label className="sm:col-span-2"><span className="label">Address</span><input className="input" maxLength={200} value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></label>
        <label className="sm:col-span-2"><span className="label">Note</span><input className="input" maxLength={200} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="Drug licence no., credit days…" /></label>
        {v.id && <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-clay h-4 w-4" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />Active</label>}
      </div>
      {tried && problem && <div className="mt-2 text-sm text-rose">{problem}</div>}
      <div className="modal-foot"><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={save.isPending} onClick={() => { setTried(true); if (!problem) save.mutate(); }}>Save</button></div>
    </Modal>
  );
}

function VendorAccount({ id, go, onEdit }: { id: string; go: Go; onEdit: (v: any) => void }) {
  const { perms } = useOutletContext<any>();
  const q = useQuery({ queryKey: ['vendors', id], queryFn: () => get(`/vendors/${id}`) });
  const [kind, setKind] = useState<'all' | 'diff' | 'return'>('all'); const [returning, setReturning] = useState(false); const [open, setOpen] = useState<any>(null);
  const writeOff = useMutation({ mutationFn: (b: any) => post(`/vendors/${id}/owed/${b.id}/write-off`, { reason: b.reason }), onSuccess: () => { toast('Written off'); refresh(); }, onError: (e) => toast(errText(e), 'err') });
  if (q.isLoading || !q.data) return <Skeleton rows={6} />;
  const { vendor: v, owed, docs, tiles: t } = q.data;
  const shown = docs.filter((d: any) => d.kind !== 'count' && (kind === 'all' ? d.kind !== 'order' : kind === 'return' ? d.kind === 'return' : d.kind === 'receipt' && d.lines.some((l: any) => l.extraPaise > 0 || l.freeShort > 0)));
  const tone = (s: string) => (s === 'review' ? 'amber' : 'sage') as any;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3"><div className="mr-auto"><h2 className="text-2xl font-semibold">{v.name}</h2><div className="text-sm text-muted">{[v.gstin ? `GSTIN ${v.gstin}` : null, v.phone, v.address, v.note].filter(Boolean).join(' · ') || 'No details yet'}</div></div>
        {can(perms, 'stock.write') && <><button className="btn btn-sm" onClick={() => onEdit(v)}><Icon name="edit" />Edit</button><button className="btn" onClick={() => setReturning(true)}>Return stock</button><button className="btn btn-primary" onClick={() => go({ tab: 'orders', order: 'new', vendor: v.id })}>New order</button></>}</div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Free units still owed" value={t.owedUnits} sub={t.owedUnits ? 'Settled when they arrive in a later delivery' : 'Nothing owed'} />
        <Tile label="Paid above promise, 6 months" value={money(t.extraPaise)} sub={`${t.extraDeliveries} of ${t.deliveries} deliveries`} />
        <Tile label="Free received on the day, 6 months" value={`${t.gotFree} of ${t.promisedFree}`} sub={t.promisedFree ? `${Math.round((t.gotFree / t.promisedFree) * 100)}%` : 'No schemes yet'} />
        <Tile label="Billed, 6 months" value={money(t.billedPaise)} sub={`${t.deliveries} deliver${t.deliveries === 1 ? 'y' : 'ies'}`} />
      </div>
      <div className="card !p-0 overflow-x-auto">
        <div className="flex flex-wrap items-baseline gap-2 px-5 pt-4 pb-2"><b>Free goods owed</b><span className="text-xs text-muted">Closed when they arrive (free got above the scheme) or written off by the owner</span></div>
        {owed.length === 0 ? <div className="px-5 pb-4 text-sm text-muted">Nothing recorded.</div> : <table className="table min-w-[640px]"><thead><tr><th>Medicine</th><th className="!text-right">Owed</th><th>From</th><th>Decided by</th><th>Status</th><th></th></tr></thead>
          <tbody>{owed.map((o: any) => <tr key={o.id} className={o.status !== 'owed' ? 'text-muted' : ''}><td className="font-medium">{o.name}</td><td className="text-right font-semibold">{o.qty}</td><td>{o.fromDocNo} · {fmtDate(o.createdAt)}</td><td>{o.decidedBy}</td>
            <td>{o.status === 'owed' ? <Chip tone="amber">owed</Chip> : <Chip tone="sage">{o.settledNote ?? o.status}</Chip>}</td>
            <td className="text-right">{o.status === 'owed' && can(perms, 'stock.approve') && <button className="btn btn-sm" onClick={async () => { const a = await ask({ title: `Write off ${o.qty} ${o.name}?`, confirmLabel: 'Write off', tone: 'danger', field: { label: 'Reason', required: true, maxLength: 200 } }); if (a) writeOff.mutate({ id: o.id, reason: a.value }); }}>Write off</button>}</td></tr>)}</tbody></table>}
      </div>
      <div className="card !p-0 overflow-x-auto">
        <div className="flex flex-wrap items-center gap-2 px-5 pt-4 pb-2"><b className="mr-2">Deliveries and returns</b><Segmented value={kind} onChange={setKind} options={[{ value: 'all', label: 'All' }, { value: 'diff', label: 'With differences' }, { value: 'return', label: 'Returns' }]} /></div>
        {shown.length === 0 ? <div className="px-5 pb-4 text-sm text-muted">Nothing yet.</div> : <table className="table min-w-[700px]"><thead><tr><th>Date</th><th>Document</th><th>By</th><th className="!text-right">Bill</th><th>Against the promise</th><th>Decision</th></tr></thead>
          <tbody>{shown.map((d: any) => { const extra = d.lines.reduce((n: number, l: any) => n + (l.extraPaise ?? 0), 0); const short = d.lines.reduce((n: number, l: any) => n + (l.freeShort ?? 0), 0); return (
            <tr key={d.id} className="cursor-pointer hover:bg-white/60" onClick={() => setOpen(d)}><td className="whitespace-nowrap">{fmtDate(d.createdAt)}</td><td className="font-semibold">{d.kind === 'return' ? `Return ${d.docNo}` : `${d.billNo ?? d.docNo}`}</td><td>{d.createdByName}</td>
              <td className="text-right">{d.kind === 'return' ? `− ${money(d.lines.reduce((n: number, l: any) => n + l.creditPaise, 0))}` : d.billTotalPaise != null ? money(d.billTotalPaise) : '—'}</td>
              <td>{d.kind === 'return' ? d.lines.map((l: any) => `${l.qty} × ${l.name}, ${l.batchNo}`).join('; ') : <>{extra > 0 && <Chip tone="rose">+{money(extra)} rate</Chip>} {short > 0 && <Chip tone="amber">{short} free short</Chip>} {!extra && !short && <Chip tone="sage">matches</Chip>}</>}</td>
              <td>{d.kind === 'receipt' ? (d.status === 'review' ? <Chip tone={tone(d.status)}>waiting for owner</Chip> : d.decision ? `${d.decision.by}: ${d.decision.choice === 'owe' ? 'vendor owes' : d.decision.choice === 'debit' ? 'debit note' : 'accepted'}` : '—') : d.note}</td></tr>); })}</tbody></table>}
      </div>
      {returning && <ReturnDialog vendorId={v.id} onClose={() => setReturning(false)} />}
      {open && (open.kind === 'receipt' ? <DecisionDialog id={open.id} onClose={() => setOpen(null)} /> : <DocDialog id={open.id} onClose={() => setOpen(null)} />)}
    </div>
  );
}
