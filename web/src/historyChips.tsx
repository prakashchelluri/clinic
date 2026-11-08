import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api, qc, errText } from './api';
import { Icon, toast } from './ui';

/** Medical history as six quick-access chips on the pad. A chip shows what is marked; tapping it opens the category to add or change. Stored on the patient. */
export type HistoryItem = { name: string; note?: string };
export type History = Record<string, HistoryItem[] | string[] | number | string | undefined> & { none?: string[]; confirmedAt?: string; confirmedBy?: string; heightCm?: number };
export type Category = { key: string; label: string; short: string; options: string[]; notePlaceholder: string };

const items = (h: History, k: string): HistoryItem[] => (Array.isArray(h[k]) ? (h[k] as HistoryItem[]) : []);

export function HistoryChips({ patientId, history, categories, readOnly }: { patientId: string; history: History; categories: Category[]; readOnly: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState<HistoryItem[]>([]); const [other, setOther] = useState('');
  const save = useMutation({
    mutationFn: (h: History) => api('PUT', `/patients/${patientId}/history`, h),
    onSuccess: () => { ['encounter', 'timeline', 'patients'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); setOpen(null); },
    onError: (e) => toast(errText(e), 'err'),
  });
  const begin = (k: string) => { setDraft(items(history, k).map((x) => ({ ...x }))); setOther(''); setOpen(open === k ? null : k); };
  const cat = categories.find((c) => c.key === open);
  const commit = (none: boolean) => {
    const h: History = { ...history, [open!]: none ? [] : draft.filter((x) => x.name.trim()) };
    const prevNone = (history.none ?? []).filter((k) => k !== open);
    h.none = none ? [...prevNone, open!] : prevNone;
    save.mutate(h);
  };
  const toggle = (name: string) => setDraft((d) => (d.some((x) => x.name === name) ? d.filter((x) => x.name !== name) : [...d, { name }]));
  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5">
        {categories.map((c) => { const xs = items(history, c.key); const none = (history.none ?? []).includes(c.key); return (
          <button key={c.key} type="button" aria-expanded={open === c.key} disabled={readOnly && !xs.length} onClick={() => begin(c.key)}
            className={`toggle-opt !border-dashed ${open === c.key ? '!border-ink !border-solid' : ''} ${xs.length ? '!border-solid' : none ? 'opacity-70' : ''}`} title={xs.length ? xs.map((x) => x.name + (x.note ? ` · ${x.note}` : '')).join(', ') : none ? 'None of these' : 'Tap to ask or add'}>
            {c.short}{xs.length > 0 && <b className="ml-1.5 text-[#8A2E10]">{xs.slice(0, 2).map((x) => x.name).join(', ')}{xs.length > 2 ? ` +${xs.length - 2}` : ''}</b>}{!xs.length && none && <span className="ml-1.5 text-muted">none</span>}
          </button>); })}
        <span className="text-xs text-muted">· asked once, kept for every visit{history.confirmedAt ? ` · confirmed ${new Date(history.confirmedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}${history.confirmedBy ? ` by ${history.confirmedBy}` : ''}` : ''}</span>
      </div>
      {cat && (
        <div className="card mt-2 anim-fade-up !p-3.5" role="group" aria-label={cat.label}>
          <div className="flex items-center gap-2"><b className="text-[13.5px]">{cat.label}</b><span className="text-xs text-muted">· tap what applies</span><button type="button" className="btn btn-ghost btn-icon ml-auto !h-7 !w-7" aria-label="Close" onClick={() => setOpen(null)}><Icon name="x" className="h-3.5 w-3.5" /></button></div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {[...new Set([...cat.options, ...draft.map((x) => x.name)])].map((o) => <button key={o} type="button" disabled={readOnly} className={`toggle-opt ${draft.some((x) => x.name === o) ? 'on' : ''}`} onClick={() => toggle(o)}>{o}</button>)}
            {!readOnly && <input aria-label="Other" className="input !w-44 !py-1" placeholder="Other, Enter" value={other} onChange={(e) => setOther(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && other.trim()) { e.preventDefault(); toggle(other.trim()); setOther(''); } }} />}
          </div>
          {draft.length > 0 && <div className="mt-2 space-y-1.5">{draft.map((x, i) => <div key={x.name} className="flex items-center gap-2"><span className="toggle-opt on">{x.name}</span><input aria-label={`${x.name}: ${cat.notePlaceholder}`} className="input !py-1 flex-1" maxLength={160} placeholder={cat.notePlaceholder} value={x.note ?? ''} disabled={readOnly} onChange={(e) => setDraft(draft.map((y, j) => (j === i ? { ...y, note: e.target.value } : y)))} /></div>)}</div>}
          {!readOnly && <div className="mt-3 flex items-center gap-2"><button type="button" className="btn btn-sm" disabled={save.isPending} onClick={() => commit(true)}>None of these</button><button type="button" className="btn btn-sm btn-primary ml-auto" disabled={save.isPending} onClick={() => commit(false)}>Done</button></div>}
        </div>
      )}
    </div>
  );
}
