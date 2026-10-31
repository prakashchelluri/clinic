import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { patch, errText } from './api';
import { Icon, MoneyInput, NumInput, Segmented, money, toPaise, toast } from './ui';

export type Pkg = { id: string; name: string; procedureId: string; sittings: number; intervalDays: number; pricePaise: number };

/** Packages set up once: a procedure, how many sittings, how far apart, one price. The desk picks one instead of typing a price. */
export function PackagesCard({ cfg, onSaved }: { cfg: any; onSaved: () => void }) {
  const saved: Pkg[] = cfg.tenant.settings?.packages ?? []; const procs: any[] = (cfg.procedures ?? []).filter((p: any) => p.active !== false);
  const [list, setList] = useState<Pkg[]>(saved);
  const [f, setF] = useState({ procedureId: procs[0]?.id ?? '', name: '', sittings: '6', intervalDays: '14', price: '' });
  const save = useMutation({ mutationFn: (next: Pkg[]) => patch('/admin/clinic', { settings: { packages: next } }), onSuccess: (_r, next) => { setList(next); toast('Packages saved'); onSaved(); }, onError: (e) => toast(errText(e), 'err') });
  const add = () => {
    const price = toPaise(f.price); const p = procs.find((x) => x.id === f.procedureId);
    if (!p || !price || !Number(f.sittings)) return;
    save.mutate([...list, { id: crypto.randomUUID().slice(0, 8), name: f.name.trim() || `${p.name} × ${f.sittings}`, procedureId: f.procedureId, sittings: Number(f.sittings), intervalDays: Number(f.intervalDays) || 0, pricePaise: price }]);
    setF({ ...f, name: '', price: '' });
  };
  return (
    <div className="card-flat p-5 mt-4">
      <h3 className="text-lg font-medium">Packages</h3>
      <p className="text-sm text-muted mb-3">Set up once. When the patient agrees to a course, the desk taps the package and the price is filled in.</p>
      {list.length === 0 ? <div className="text-sm text-muted mb-3">No packages yet.</div> : <div className="mb-3 divide-y divide-line/60">{list.map((p) => (
        <div key={p.id} className="flex items-center gap-2 py-2 text-sm"><div className="min-w-0 flex-1"><b>{p.name}</b><div className="text-xs text-muted">{procs.find((x) => x.id === p.procedureId)?.name ?? 'Procedure'} · {p.sittings} sittings{p.intervalDays ? ` every ${p.intervalDays} days` : ''}</div></div><b>{money(p.pricePaise)}</b>
          <button className="btn btn-ghost btn-sm" aria-label={`Remove ${p.name}`} disabled={save.isPending} onClick={() => save.mutate(list.filter((x) => x.id !== p.id))}><Icon name="x" className="h-3.5 w-3.5" /></button></div>))}</div>}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
        <div className="col-span-2"><label className="label" htmlFor="pk-proc">Procedure</label><select id="pk-proc" className="input" value={f.procedureId} onChange={(e) => setF({ ...f, procedureId: e.target.value })}>{procs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
        <div><label className="label" htmlFor="pk-n">Sittings</label><NumInput id="pk-n" max={60} className="input" value={f.sittings} onChange={(e) => setF({ ...f, sittings: e.target.value })} /></div>
        <div><label className="label" htmlFor="pk-d">Every (days)</label><NumInput id="pk-d" max={365} className="input" value={f.intervalDays} onChange={(e) => setF({ ...f, intervalDays: e.target.value })} /></div>
        <div><label className="label" htmlFor="pk-p">Price</label><MoneyInput id="pk-p" value={f.price} onChange={(v) => setF({ ...f, price: v })} /></div>
        <div className="col-span-2 md:col-span-4"><label className="label" htmlFor="pk-name">Name (optional)</label><input id="pk-name" className="input" maxLength={60} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
        <div className="flex items-end"><button className="btn btn-primary w-full" disabled={save.isPending || !f.price || !Number(f.sittings)} onClick={add}><Icon name="plus" className="h-3.5 w-3.5" />Add</button></div>
      </div>
    </div>
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
