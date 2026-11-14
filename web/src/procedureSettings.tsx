import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { patch, post, errText } from './api';
import { Icon, Modal, MoneyInput, NumInput, money, toPaise, toast } from './ui';

export type SessionDef = { name: string; minutes: number; gapDays: number; note?: string };
type Row = { name: string; minutes: string; gapDays: string; note: string };

/** A procedure's sessions as set up in Settings; one made before sessions were set up reads as N equal sessions. */
export const sessionsOf = (p: any): SessionDef[] => p?.sessions?.length ? p.sessions
  : Array.from({ length: p?.typicalSittings || 1 }, (_, i) => ({ name: `Session ${i + 1}`, minutes: p?.typicalMinutes ?? 30, gapDays: i ? 28 : 0 }));
/** The standard price for N sessions: an upfront total when it is the full set of sessions, else the price per session × N. */
export const stdTotal = (p: any, n: number) => p?.pricing === 'upfront' && p.totalPaise && n === sessionsOf(p).length ? p.totalPaise : (p?.pricePaise ?? 0) * n;
export const pricingText = (p: any) => p?.pricing === 'upfront' && p.totalPaise ? `${money(p.totalPaise)} upfront` : p?.pricePaise != null ? `${money(p.pricePaise)} a session` : '—';
export const validText = (p: any) => p?.validFor ? `${p.validFor} ${p.validUnit === 'days' ? 'day' : 'month'}${p.validFor === 1 ? '' : 's'}` : 'No expiry';

/** Add or edit a procedure with every one of its sessions: like the treatment form the clinic knows (Eka's "Add package"),
 *  its name, who conducts it, how many sessions, how it is paid, the price and how long it stays valid; then each session's
 *  name, duration, gap after the one before and a description. Room, GST and buffer are the procedure's other rules. */
export function ProcedureForm({ value, cfg, onClose, onSaved }: { value: any; cfg: any; onClose: () => void; onSaved: () => void }) {
  const toRow = (s: SessionDef): Row => ({ name: s.name, minutes: String(s.minutes), gapDays: String(s.gapDays ?? 0), note: s.note ?? '' });
  const [f, setF] = useState({
    name: value.name ?? '', practitionerId: value.practitionerId ?? '', pricing: (value.pricing ?? 'per_session') as 'upfront' | 'per_session',
    total: value.totalPaise ? String(value.totalPaise / 100) : '', per: value.pricePaise != null ? String(value.pricePaise / 100) : '',
    validFor: value.validFor ? String(value.validFor) : '', validUnit: (value.validUnit ?? 'months') as 'days' | 'months', noExpiry: !value.validFor,
    bufferMinutes: String(value.bufferMinutes ?? 0), requiredCapability: value.requiredCapability ?? '', taxRateBp: value.taxRateBp ?? 0, requiresMainDoctor: !!value.requiresMainDoctor, active: value.active !== false,
  });
  const [rows, setRows] = useState<Row[]>(value.id ? sessionsOf(value).map(toRow) : [toRow({ name: 'Session 1', minutes: 30, gapDays: 0 })]);
  const set = (k: string, v: any) => setF((p) => ({ ...p, [k]: v }));
  const setRow = (i: number, k: keyof Row, v: string) => setRows((r) => r.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const addRow = () => setRows((r) => [...r, { name: `Session ${r.length + 1}`, minutes: r[r.length - 1]?.minutes ?? '30', gapDays: r.length ? r[r.length - 1].gapDays === '0' ? '28' : r[r.length - 1].gapDays : '0', note: '' }]);
  // a session taken out renumbers the default names after it; the first session has no gap
  const delRow = (i: number) => setRows((r) => r.filter((_, j) => j !== i).map((x, j) => ({ ...x, name: /^Session \d+$/.test(x.name) ? `Session ${j + 1}` : x.name, gapDays: j === 0 ? '0' : x.gapDays })));
  const setCount = (n: number) => { if (n < 1 || n > 60) return; if (n > rows.length) for (let k = rows.length; k < n; k++) addRow(); else setRows((r) => r.slice(0, n)); };
  const caps = [...new Set<string>(cfg.rooms.flatMap((r: any) => r.capabilities))];
  const n = rows.length; const total = toPaise(f.total); const per = toPaise(f.per);
  const rowBad = (x: Row, i: number) => !x.name.trim() || !(Number(x.minutes) >= 5 && Number(x.minutes) <= 600) || (i > 0 && !(Number(x.gapDays) >= 0 && Number(x.gapDays) <= 365));
  const bad = { name: !f.name.trim(), price: f.pricing === 'upfront' ? !(total > 0) : f.per === '' || per < 0, valid: !f.noExpiry && !(Number(f.validFor) >= 1 && Number(f.validFor) <= 60), rows: rows.some(rowBad) };
  const save = useMutation({
    mutationFn: () => {
      const b = { name: f.name.trim(), practitionerId: f.practitionerId || null, pricing: f.pricing,
        ...(f.pricing === 'upfront' ? { totalPaise: total } : { pricePaise: per, totalPaise: null }),
        validFor: f.noExpiry ? null : Number(f.validFor), validUnit: f.noExpiry ? null : f.validUnit,
        sessions: rows.map((x, i) => ({ name: x.name.trim(), minutes: Number(x.minutes), gapDays: i ? Number(x.gapDays) || 0 : 0, ...(x.note.trim() ? { note: x.note.trim() } : {}) })),
        bufferMinutes: Number(f.bufferMinutes) || 0, requiredCapability: f.requiredCapability || null, taxRateBp: f.taxRateBp, requiresMainDoctor: f.requiresMainDoctor, ...(value.id ? { active: f.active } : {}) };
      return value.id ? patch(`/admin/procedures/${value.id}`, b) : post('/admin/procedures', b);
    },
    onSuccess: () => { toast(value.id ? 'Procedure saved' : 'Procedure added'); onSaved(); onClose(); },
    onError: (e: any) => toast(e?.body?.code === 'UPFRONT_NEEDS_A_TOTAL' ? 'Upfront needs a total price.' : errText(e), 'err'),
  });
  const th = 'px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-muted';
  return (
    <Modal title={value.id ? 'Edit procedure' : 'Add procedure'} subtitle={value.id ? value.name : 'Its sessions, price and who conducts it, set once'} onClose={onClose} width="max-w-5xl">
      <div className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-[1.5fr_1fr]">
          <div><label className="label" htmlFor="pf-name">Procedure name</label><input id="pf-name" autoFocus={!value.id} className={`input ${f.name && bad.name ? '!border-rose' : ''}`} maxLength={80} placeholder="e.g. Laser hair reduction · full face" value={f.name} onChange={(e) => set('name', e.target.value)} /></div>
          <div><label className="label" htmlFor="pf-doc">Conducted by</label><select id="pf-doc" className="input" value={f.practitionerId} onChange={(e) => set('practitionerId', e.target.value)}><option value="">Any doctor</option>{(cfg.practitioners ?? []).map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></div>
        </div>
        <div className="grid items-end gap-4 sm:grid-cols-[auto_auto_1fr_1.3fr]">
          <div><span className="label">No. of sessions</span><div className="flex items-center gap-1"><button type="button" className="btn btn-icon" aria-label="One session less" disabled={n <= 1} onClick={() => setCount(n - 1)}>−</button><span className="w-9 text-center text-[15px] font-semibold" aria-live="polite">{String(n).padStart(2, '0')}</span><button type="button" className="btn btn-icon" aria-label="One session more" disabled={n >= 60} onClick={() => setCount(n + 1)}>+</button></div></div>
          <div><span className="label">Pricing model</span><div className="flex gap-1" role="radiogroup" aria-label="Pricing model">{([['upfront', 'Upfront'], ['per_session', 'Per session']] as const).map(([v, l]) => <button key={v} type="button" role="radio" aria-checked={f.pricing === v} className={`toggle-opt ${f.pricing === v ? 'on' : ''}`} onClick={() => set('pricing', v)}>{l}</button>)}</div></div>
          {f.pricing === 'upfront'
            ? <div><label className="label" htmlFor="pf-total">Total price (₹)</label><MoneyInput id="pf-total" value={f.total} onChange={(v) => set('total', v)} /><div className="mt-1 text-xs text-muted">{total > 0 ? `${money(Math.round(total / n))} a session · paid in full before the first session` : 'Paid in full before the first session'}</div></div>
            : <div><label className="label" htmlFor="pf-per">Price per session (₹)</label><MoneyInput id="pf-per" value={f.per} onChange={(v) => set('per', v)} /><div className="mt-1 text-xs text-muted">{per > 0 ? `${money(per * n)} for ${n} session${n === 1 ? '' : 's'} · each paid on its day` : 'Each session paid on its day'}</div></div>}
          <div><span className="label">Expiry</span><div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted">Valid for</span><NumInput aria-label="Valid for" max={60} disabled={f.noExpiry} className={`input !w-16 ${bad.valid ? '!border-rose' : ''}`} value={f.noExpiry ? '' : f.validFor} onChange={(e) => set('validFor', e.target.value)} />
            <select aria-label="Days or months" className="input !w-auto" disabled={f.noExpiry} value={f.validUnit} onChange={(e) => set('validUnit', e.target.value)}><option value="months">months</option><option value="days">days</option></select>
            <label className="flex items-center gap-1.5"><input type="checkbox" className="accent-ink" checked={f.noExpiry} onChange={(e) => setF((p) => ({ ...p, noExpiry: e.target.checked, validFor: e.target.checked ? '' : p.validFor || '12' }))} />No expiry</label></div>
            <div className="mt-1 text-xs text-muted">Counted from the day the patient agrees the price.</div></div>
        </div>

        <div><span className="label">Session details</span>
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full min-w-[720px] border-collapse text-[13.5px]">
              <thead className="bg-paper-2"><tr><th className={`${th} w-[28%]`}>Session name</th><th className={`${th} w-[13%]`}>Duration</th><th className={`${th} w-[17%]`}>After the one before</th><th className={th}>Description (if any)</th><th className="w-10" /></tr></thead>
              <tbody>{rows.map((x, i) => (
                <tr key={i} className="border-t border-line">
                  <td className="p-1.5"><input aria-label={`Session ${i + 1} name`} className={`input !py-1.5 ${!x.name.trim() ? '!border-rose' : ''}`} maxLength={40} value={x.name} onChange={(e) => setRow(i, 'name', e.target.value)} /></td>
                  <td className="p-1.5"><div className="flex items-center gap-1.5"><NumInput aria-label={`Session ${i + 1} minutes`} max={600} className={`input !w-16 !py-1.5 ${!(Number(x.minutes) >= 5) ? '!border-rose' : ''}`} value={x.minutes} onChange={(e) => setRow(i, 'minutes', e.target.value)} /><span className="text-muted">min</span></div></td>
                  <td className="p-1.5">{i === 0 ? <span className="px-2 text-xs text-muted">First session</span> : <div className="flex items-center gap-1.5"><NumInput aria-label={`Days before session ${i + 1}`} max={365} className="input !w-16 !py-1.5" value={x.gapDays} onChange={(e) => setRow(i, 'gapDays', e.target.value)} /><span className="text-muted">days</span></div>}</td>
                  <td className="p-1.5"><input aria-label={`Session ${i + 1} description`} className="input !py-1.5" maxLength={200} placeholder="Description…" value={x.note} onChange={(e) => setRow(i, 'note', e.target.value)} /></td>
                  <td className="p-1.5 text-center"><button type="button" className="btn btn-ghost btn-icon !h-8 !w-8" aria-label={`Remove session ${i + 1}`} disabled={rows.length <= 1} onClick={() => delRow(i)}><Icon name="x" className="h-4 w-4" /></button></td>
                </tr>))}</tbody>
            </table>
          </div>
          <button type="button" className="btn btn-sm mt-2" disabled={n >= 60} onClick={addRow}><Icon name="plus" className="h-3.5 w-3.5" />Add session</button>
          <div className="mt-1 text-xs text-muted">The first session is booked with the patient; each next one is booked by the plan this many days after the one before, for this long.</div>
        </div>

        <details className="rounded-lg border border-line px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium">Room, GST and other rules</summary>
          <div className="mt-3 space-y-3">
            <div><span className="label">Needs a room with</span><div className="flex flex-wrap gap-1"><button type="button" className={`toggle-opt ${!f.requiredCapability ? 'on' : ''}`} onClick={() => set('requiredCapability', '')}>Any room</button>{caps.map((c) => <button key={c} type="button" className={`toggle-opt ${f.requiredCapability === c ? 'on' : ''}`} onClick={() => set('requiredCapability', c)}>{c}</button>)}</div></div>
            <div className="flex flex-wrap items-end gap-4">
              <div><span className="label">GST</span><div className="flex gap-1">{([[0, 'Exempt (medical)'], [1800, '18% (cosmetic)']] as const).map(([v, l]) => <button key={v} type="button" className={`toggle-opt ${f.taxRateBp === v ? 'on' : ''}`} onClick={() => set('taxRateBp', v)}>{l}</button>)}</div></div>
              <div><label className="label" htmlFor="pf-buf">Buffer after each session</label><div className="flex items-center gap-1.5 text-sm"><NumInput id="pf-buf" max={240} className="input !w-16" value={f.bufferMinutes} onChange={(e) => set('bufferMinutes', e.target.value)} />min</div></div>
            </div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-ink" checked={f.requiresMainDoctor} onChange={(e) => set('requiresMainDoctor', e.target.checked)} />Needs a doctor present (blocks their OP time)</label>
            {value.id && <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-ink" checked={f.active} onChange={(e) => set('active', e.target.checked)} />Active</label>}
          </div>
        </details>

        <div className="modal-foot"><span className="mr-auto text-xs text-rose">{bad.rows ? 'Each session needs a name, at least 5 minutes, and a gap of 0–365 days.' : bad.valid ? 'Valid for 1 to 60, or tick No expiry.' : ''}</span>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={Object.values(bad).some(Boolean) || save.isPending} onClick={() => save.mutate()}><Icon name="check" />{value.id ? 'Save procedure' : 'Add procedure'}</button></div>
      </div>
    </Modal>
  );
}
