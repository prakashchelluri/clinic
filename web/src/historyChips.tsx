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
            className={xs.length ? `pick-chip ${open === c.key ? '!shadow-[inset_0_0_0_1.5px_currentColor]' : ''}` : `toggle-opt !border-dashed ${open === c.key ? '!border-ink !border-solid' : ''} ${none ? 'opacity-70' : ''}`} title={xs.length ? xs.map((x) => x.name + (x.note ? ` · ${x.note}` : '')).join(', ') : none ? 'None of these' : 'Tap to ask or add'}>
            {c.short}{xs.length > 0 && <b className="ml-1.5">{xs.slice(0, 2).map((x) => x.name).join(', ')}{xs.length > 2 ? ` +${xs.length - 2}` : ''}</b>}{!xs.length && none && <span className="ml-1.5 text-muted">none</span>}
          </button>); })}
        <span className="text-xs text-muted">· asked once, kept for every visit{history.confirmedAt ? ` · confirmed ${new Date(history.confirmedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}${history.confirmedBy ? ` by ${history.confirmedBy}` : ''}` : ''}</span>
      </div>
      {cat && (
        <div className="card mt-2 anim-fade-up !p-3.5" role="group" aria-label={cat.label}>
          <div className="flex items-center gap-2"><b className="text-[13.5px]">{cat.label}</b><span className="text-xs text-muted">· tap what applies</span><button type="button" className="btn btn-ghost btn-icon ml-auto !h-7 !w-7" aria-label="Close" onClick={() => setOpen(null)}><Icon name="x" className="h-3.5 w-3.5" /></button></div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {[...new Set([...cat.options, ...draft.map((x) => x.name)])].map((o) => <button key={o} type="button" disabled={readOnly} className={draft.some((x) => x.name === o) ? 'pick-chip' : 'opt-add'} onClick={() => toggle(o)}>{o}</button>)}
            {!readOnly && <input aria-label="Other" className="input !w-44 !py-1" placeholder="Other, Enter" value={other} onChange={(e) => setOther(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && other.trim()) { e.preventDefault(); toggle(other.trim()); setOther(''); } }} />}
          </div>
          {draft.length > 0 && <div className="mt-2 space-y-1.5">{draft.map((x, i) => <div key={x.name} className="flex items-center gap-2"><span className="pick-chip">{x.name}</span><input aria-label={`${x.name}: ${cat.notePlaceholder}`} className="input !py-1 flex-1" maxLength={160} placeholder={cat.notePlaceholder} value={x.note ?? ''} disabled={readOnly} onChange={(e) => setDraft(draft.map((y, j) => (j === i ? { ...y, note: e.target.value } : y)))} /></div>)}</div>}
          {!readOnly && <div className="mt-3 flex items-center gap-2"><button type="button" className="btn btn-sm" disabled={save.isPending} onClick={() => commit(true)}>None of these</button><button type="button" className="btn btn-sm btn-primary ml-auto" disabled={save.isPending} onClick={() => commit(false)}>Done</button></div>}
        </div>
      )}
    </div>
  );
}

type Answer = 'yes' | 'no' | undefined;
/** Medical history as one sheet (Tatva's drawer): every category at once, each choice a – / Y / N chip, "No known history" per category,
 *  a box for anything else, and Additional history. Y is an item on the patient; N is kept apart (history.denied) so no check reads it as a Yes. */
export function HistorySheet({ patientId, history, categories, readOnly, onDone }: { patientId: string; history: History; categories: Category[]; readOnly: boolean; onDone: () => void }) {
  const denied0 = (history.denied ?? {}) as Record<string, string[]>;
  const [yes, setYes] = useState<Record<string, HistoryItem[]>>(() => Object.fromEntries(categories.map((c) => [c.key, items(history, c.key).map((x) => ({ ...x }))])));
  const [no, setNo] = useState<Record<string, string[]>>(() => Object.fromEntries(categories.map((c) => [c.key, [...(denied0[c.key] ?? [])]])));
  const [none, setNone] = useState<string[]>(() => [...((history.none as string[] | undefined) ?? [])]);
  const [notes, setNotes] = useState<string>(typeof history.notes === 'string' ? history.notes : '');
  const [other, setOther] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: () => api('PUT', `/patients/${patientId}/history`, { ...history, ...yes, denied: no, none: none.filter((k) => !(yes[k] ?? []).length), notes }),
    onSuccess: () => { ['encounter', 'timeline', 'patients'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); toast('Medical history saved'); onDone(); },
    onError: (e) => toast(errText(e), 'err'),
  });
  const answer = (k: string, o: string): Answer => ((yes[k] ?? []).some((x) => x.name === o) ? 'yes' : (no[k] ?? []).includes(o) ? 'no' : undefined);
  const cycle = (k: string, o: string) => { // – → Y → N → –
    const a = answer(k, o);
    setYes((y) => ({ ...y, [k]: a === undefined ? [...(y[k] ?? []), { name: o }] : (y[k] ?? []).filter((x) => x.name !== o) }));
    setNo((n) => ({ ...n, [k]: a === 'yes' ? [...(n[k] ?? []), o] : (n[k] ?? []).filter((x) => x !== o) }));
    if (a === undefined) setNone((xs) => xs.filter((x) => x !== k));
  };
  return (
    <div className="space-y-3">
      {categories.map((c) => { const opts = [...new Set([...c.options, ...(yes[c.key] ?? []).map((x) => x.name), ...(no[c.key] ?? [])])]; const nk = none.includes(c.key); return (
        <section key={c.key} className="rounded-[10px] border border-line p-3" aria-label={c.label}>
          <div className="mb-2 flex items-center gap-2"><b className="text-[14px]">{c.label}</b>
            <label className="ml-auto inline-flex items-center gap-1.5 text-[12.5px] text-muted"><input type="checkbox" className="accent-ink" disabled={readOnly} checked={nk} onChange={(e) => { setNone((xs) => (e.target.checked ? [...xs, c.key] : xs.filter((x) => x !== c.key))); if (e.target.checked) { setYes((y) => ({ ...y, [c.key]: [] })); } }} />No known history</label></div>
          <div className={`flex flex-wrap gap-1.5 ${nk ? 'opacity-50' : ''}`}>
            {opts.map((o) => { const a = answer(c.key, o); return (
              <button key={o} type="button" disabled={readOnly || nk} title="Tap: – not asked, Y yes, N no" aria-label={`${o}: ${a === 'yes' ? 'yes' : a === 'no' ? 'no' : 'not asked'}`} onClick={() => cycle(c.key, o)}
                className={`inline-flex items-center gap-2 rounded-[8px] border px-2.5 py-1 text-[12.5px] font-medium ${a === 'yes' ? 'border-ink bg-surface-2' : a === 'no' ? 'border-line text-muted line-through' : 'border-line'}`}>
                {o}<span className={`grid h-5 min-w-5 place-items-center rounded-[5px] px-1 text-[11px] font-bold ${a === 'yes' ? 'bg-ink text-paper' : a === 'no' ? 'bg-rose-soft text-rose' : 'bg-paper-2 text-muted'}`}>{a === 'yes' ? 'Y' : a === 'no' ? 'N' : '–'}</span></button>); })}
            {!readOnly && !nk && <input aria-label={`Add to ${c.label}`} className="input !w-40 !py-1 text-[12.5px]" placeholder="Add other, Enter" value={other[c.key] ?? ''} onChange={(e) => setOther({ ...other, [c.key]: e.target.value })}
              onKeyDown={(e) => { const v = (other[c.key] ?? '').trim(); if (e.key === 'Enter' && v) { e.preventDefault(); if (!answer(c.key, v)) cycle(c.key, v); setOther({ ...other, [c.key]: '' }); } }} />}
          </div>
          {(yes[c.key] ?? []).length > 0 && <div className="mt-2 space-y-1">{(yes[c.key] ?? []).map((x, i) => <div key={x.name} className="flex items-center gap-2 text-[12.5px]"><span className="w-40 shrink-0 truncate font-medium">{x.name}</span>
            <input aria-label={`${x.name}: ${c.notePlaceholder}`} className="input !py-1 text-[12.5px]" maxLength={160} disabled={readOnly} placeholder={c.notePlaceholder} value={x.note ?? ''} onChange={(e) => setYes((y) => ({ ...y, [c.key]: (y[c.key] ?? []).map((z, j) => (j === i ? { ...z, note: e.target.value || undefined } : z)) }))} /></div>)}</div>}
        </section>); })}
      <section className="rounded-[10px] border border-line p-3"><div className="mb-2 flex items-center"><b className="text-[14px]">Additional history</b><span className="ml-auto text-[11.5px] text-muted">{notes.length}/5000</span></div>
        <textarea aria-label="Additional history" className="input min-h-20" maxLength={5000} disabled={readOnly} value={notes} onChange={(e) => setNotes(e.target.value)} /></section>
      {!readOnly && <div className="flex justify-end gap-2"><button type="button" className="btn btn-ghost" onClick={onDone}>Cancel</button><button type="button" className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>Save</button></div>}
    </div>
  );
}
