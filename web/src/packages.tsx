import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { patch, errText } from './api';
import { Drawer, Empty, Icon, MoneyInput, NumInput, Segmented, money, toPaise, toast, ask } from './ui';

export type PkgItem = { procedureId: string; sittings: number; intervalDays: number };
export type Pkg = { id: string; name: string; items: PkgItem[]; pricePaise: number; validMonths: number; active: boolean };

/** The full price of a package: each procedure's list price × its sittings. */
export const fullPrice = (k: { items: PkgItem[] }, procs: any[]) => k.items.reduce((s, it) => s + (procs.find((p) => p.id === it.procedureId)?.pricePaise ?? 0) * it.sittings, 0);
const pct = (full: number, price: number) => (full > price ? Math.round((1 - price / full) * 100) : 0);

/** Packages: a bundle of procedures at one price, valid for some months. The doctor adds one on the Rx pad, in Procedures. */
export function PackagesTab({ cfg, onSaved }: { cfg: any; onSaved: () => void }) {
  const all: Pkg[] = cfg.tenant.settings?.packages ?? []; const procs: any[] = cfg.procedures ?? [];
  const [show, setShow] = useState<'active' | 'inactive'>('active'); const [edit, setEdit] = useState<Pkg | null>(null);
  const rows = all.filter((k) => (show === 'active') === (k.active !== false));
  const procName = (id: string) => procs.find((p) => p.id === id)?.name ?? 'Procedure';
  const add = () => setEdit({ id: '', name: '', items: [], pricePaise: 0, validMonths: 12, active: true });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1.5" role="group" aria-label="Show">{(['active', 'inactive'] as const).map((k) => <button key={k} type="button" aria-pressed={show === k} className={`toggle-opt ${show === k ? 'on' : ''}`} onClick={() => setShow(k)}>{k === 'active' ? 'Active' : 'Inactive'} · {all.filter((x) => (k === 'active') === (x.active !== false)).length}</button>)}</div>
        <button type="button" className="btn btn-primary ml-auto" onClick={add}><Icon name="plus" />New package</button>
      </div>
      <div className="card !p-0 overflow-x-auto">
        {rows.length === 0 ? <Empty icon="box" title={show === 'active' ? 'No packages yet' : 'Nothing inactive'} hint={show === 'active' ? 'A package is a bundle of procedures at one price, e.g. 4 CO2 laser + 3 peels for ₹34,000. The doctor adds it on the Rx pad.' : undefined} /> : (
          <table className="table min-w-[720px]">
            <thead><tr><th className="pl-4">Package</th><th className="!text-right">Full price</th><th className="!text-right">Package price</th><th /><th>Valid</th></tr></thead>
            <tbody>{rows.map((k) => { const full = fullPrice(k, procs); return (
              <tr key={k.id} className="cursor-pointer hover:bg-surface-2" onClick={() => setEdit(k)}>
                <td className="pl-4"><button type="button" className="text-left font-medium" onClick={(e) => { e.stopPropagation(); setEdit(k); }}>{k.name}</button><div className="text-xs text-muted">{k.items.map((it) => `${procName(it.procedureId)} × ${it.sittings}`).join(' · ')}</div></td>
                <td className="text-right text-muted line-through">{full > k.pricePaise ? money(full) : ''}</td>
                <td className="text-right font-semibold">{money(k.pricePaise)}</td>
                <td>{pct(full, k.pricePaise) > 0 && <span className="text-xs text-sage">Saves {pct(full, k.pricePaise)}%</span>}</td>
                <td className="text-ink-2">{k.validMonths} months</td>
              </tr>); })}</tbody>
          </table>)}
      </div>
      <p className="text-xs text-muted">A package of one procedure works too (e.g. Laser hair reduction × 6). A change applies to new prescriptions only; patients who already agreed keep their price.</p>
      {edit && <PackageDrawer value={edit} all={all} procs={procs} onClose={() => setEdit(null)} onDone={() => { setEdit(null); onSaved(); }} />}
    </div>
  );
}

function PackageDrawer({ value, all, procs, onClose, onDone }: { value: Pkg; all: Pkg[]; procs: any[]; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ name: value.name, items: value.items.map((it) => ({ ...it, sittings: String(it.sittings), intervalDays: String(it.intervalDays) })), price: value.pricePaise ? String(value.pricePaise / 100) : '', months: String(value.validMonths) });
  const avail = procs.filter((p) => p.active !== false && !f.items.some((it) => it.procedureId === p.id));
  const items: PkgItem[] = f.items.map((it) => ({ procedureId: it.procedureId, sittings: Number(it.sittings), intervalDays: Number(it.intervalDays) || 0 }));
  const full = fullPrice({ items }, procs); const price = toPaise(f.price);
  const dup = all.some((k) => k.id !== value.id && k.name.trim().toLowerCase() === f.name.trim().toLowerCase());
  const bad = { name: !f.name.trim() || dup, items: !items.length || items.some((it) => !(it.sittings >= 1 && it.sittings <= 60) || it.intervalDays > 365), price: !(price > 0), months: !(Number(f.months) >= 1 && Number(f.months) <= 60) };
  const setItem = (i: number, k: 'sittings' | 'intervalDays', v: string) => setF((p) => ({ ...p, items: p.items.map((x, j) => (j === i ? { ...x, [k]: v } : x)) }));
  const save = useMutation({
    mutationFn: (active: boolean) => {
      const me: Pkg = { id: value.id || crypto.randomUUID().slice(0, 8), name: f.name.trim(), items, pricePaise: price, validMonths: Number(f.months), active };
      return patch('/admin/clinic', { settings: { packages: value.id ? all.map((k) => (k.id === value.id ? me : k)) : [...all, me] } });
    },
    onSuccess: (_r, active) => { toast(!value.id ? 'Package added' : active !== (value.active !== false) ? (active ? 'Active again' : 'Marked inactive') : 'Package saved'); onDone(); },
    onError: (e) => toast(errText(e), 'err'),
  });
  const submit = async (active: boolean) => {
    if (active && full > 0 && price > full && !(await ask({ title: `The package costs more than its procedures on their own (${money(full)})`, body: 'Patients would pay more for the package. Save anyway?', confirmLabel: 'Save anyway' }))) return;
    save.mutate(active);
  };
  const off = Object.values(bad).some(Boolean);
  const COLS = 'grid grid-cols-[minmax(0,1fr)_72px_108px_84px_32px] items-center gap-2';
  return (
    <Drawer title={value.id ? value.name : 'New package'} subtitle={value.id ? 'Patients who already agreed keep the price they agreed.' : 'Procedures sold together at one price'} onClose={onClose} width="max-w-xl">
      <div className="space-y-4">
        <div><label className="label" htmlFor="pk-name">Name</label><input id="pk-name" autoFocus={!value.id} className={`input ${f.name && bad.name ? '!border-rose' : ''}`} maxLength={60} placeholder="e.g. Acne scar combo" value={f.name} onChange={(e) => setF((p) => ({ ...p, name: e.target.value }))} />{dup && <div className="mt-1 text-xs text-rose">There is already a package with this name.</div>}</div>
        <div>
          <span className="label">Procedures in the package</span>
          {f.items.length > 0 && <div className={`${COLS} border-b border-line pb-1 text-[11.5px] text-muted`}><span>Procedure</span><span>Sittings</span><span>Every</span><span className="text-right">Full price</span><span /></div>}
          {f.items.map((it, i) => { const p = procs.find((x) => x.id === it.procedureId); return (
            <div key={it.procedureId} className={`${COLS} border-b border-line/60 py-2 text-sm`}>
              <span className="min-w-0"><span className="block truncate">{p?.name ?? 'Procedure'}</span><span className="text-xs text-muted">{p?.pricePaise ? `${money(p.pricePaise)} a sitting` : 'No price set'}</span></span>
              <NumInput aria-label={`Sittings of ${p?.name}`} max={60} className={`input !py-1.5 ${!(Number(it.sittings) >= 1) ? '!border-rose' : ''}`} value={it.sittings} onChange={(e) => setItem(i, 'sittings', e.target.value)} />
              <span className="flex items-center gap-1 text-xs text-muted"><NumInput aria-label={`Days between sittings of ${p?.name}`} max={365} className="input !w-14 !py-1.5" value={it.intervalDays} onChange={(e) => setItem(i, 'intervalDays', e.target.value)} />days</span>
              <span className="text-right text-ink-2">{money((p?.pricePaise ?? 0) * (Number(it.sittings) || 0))}</span>
              <button type="button" className="btn btn-ghost btn-icon !h-7 !w-7" aria-label={`Remove ${p?.name}`} onClick={() => setF((x) => ({ ...x, items: x.items.filter((_, j) => j !== i) }))}><Icon name="x" className="h-3.5 w-3.5" /></button>
            </div>); })}
          {avail.length > 0 && f.items.length < 10 && <select aria-label="Add a procedure" className="input mt-2 !border-dashed" value="" onChange={(e) => { const p = procs.find((x) => x.id === e.target.value); if (p) setF((x) => ({ ...x, items: [...x.items, { procedureId: p.id, sittings: String(p.typicalSittings || 1), intervalDays: '30' }] })); }}>
            <option value="">+ Add a procedure…</option>{avail.map((p) => <option key={p.id} value={p.id}>{p.name}{p.pricePaise ? ` · ${money(p.pricePaise)}` : ''}</option>)}</select>}
        </div>
        <div className="grid grid-cols-2 items-end gap-3">
          <div><span className="label">Full price</span><div className="flex h-10 items-center text-[15px] text-muted">{full ? <s>{money(full)}</s> : '—'}</div></div>
          <div><label className="label" htmlFor="pk-price">Package price (₹)</label><MoneyInput id="pk-price" value={f.price} onChange={(v) => setF((p) => ({ ...p, price: v }))} /></div>
        </div>
        {price > 0 && full > price && <div className="inline-block rounded-md bg-sage-soft px-2.5 py-1 text-sm text-sage">The patient saves {money(full - price)} ({pct(full, price)}%)</div>}
        <div><span className="label">Valid for</span><div className="flex items-center gap-2 text-sm"><NumInput aria-label="Months" max={60} className={`input !w-20 ${bad.months ? '!border-rose' : ''}`} value={f.months} onChange={(e) => setF((p) => ({ ...p, months: e.target.value }))} />months from the day the patient agrees</div>
          <div className="mt-1 text-xs text-muted">Sittings not done by then show as Expired. The desk can still refund them.</div></div>
        <div className="modal-foot !justify-between">
          {value.id ? <button type="button" className="btn" disabled={save.isPending} onClick={() => submit(value.active === false)}>{value.active === false ? 'Make active' : 'Mark inactive'}</button> : <span />}
          <div className="flex gap-2"><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={off || save.isPending} onClick={() => submit(value.active !== false)}>{value.id ? 'Save' : 'Add package'}</button></div>
        </div>
      </div>
    </Drawer>
  );
}

/** How big the calendar's text is for the whole clinic, so the doctor can read it from across the desk. */
export function CalendarLookCard({ cfg, onSaved }: { cfg: any; onSaved: () => void }) {
  const cur = (cfg.tenant.settings?.calendarTextSize ?? 'normal') as 'small' | 'normal' | 'large';
  const save = useMutation({ mutationFn: (v: string) => patch('/admin/clinic', { settings: { calendarTextSize: v } }), onSuccess: () => { toast('Calendar text size saved'); onSaved(); }, onError: (e) => toast(errText(e), 'err') });
  return (
    <div className="card-flat p-5 mt-4">
      <h3 className="text-lg font-medium">Calendar text size</h3>
      <p className="text-sm text-muted mb-3">The same for everyone in the clinic.</p>
      <Segmented<'small' | 'normal' | 'large'> value={cur} onChange={(v) => save.mutate(v)} options={[{ value: 'small', label: 'Small' }, { value: 'normal', label: 'Normal' }, { value: 'large', label: 'Large' }]} />
    </div>
  );
}
