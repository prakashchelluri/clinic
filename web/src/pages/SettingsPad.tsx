import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, get, qc, errText } from '../api';
import { Icon, Section, Skeleton, toast } from '../ui';

type Sec = { key: string; show: boolean; required: boolean; print: boolean };
type Known = { key: string; label: string; canRequire?: boolean; canPrint?: boolean };
type Print = { lang: 'te+en' | 'en' | 'te'; outOfRangeOnly: boolean; vitals: string[] };
type Cat = { key: string; label: string; short: string; options: string[] };
type PadData = { sections: Sec[]; print: Print; known: Known[]; telugu: Record<string, string>; teluguDefaults: Record<string, string>; history: Cat[]; historyDefaults: Cat[] };
const VITAL_CHOICES: [string, string][] = [['weight_kg', 'Weight'], ['height_cm', 'Height'], ['bp', 'BP'], ['pulse', 'Pulse'], ['temp_f', 'Temperature'], ['spo2', 'SpO₂']];

/** Settings → Rx pad: which sections show on the pad, which are required, the order, what the printed prescription carries, the Telugu phrase table and the history chip options. */
export function PadTab({ onSaved }: { onSaved: () => void }) {
  const q = useQuery<PadData>({ queryKey: ['admin-pad'], queryFn: () => get('/admin/pad') });
  const [secs, setSecs] = useState<Sec[]>([]); const [print, setPrint] = useState<Print | null>(null);
  const [telugu, setTelugu] = useState<Record<string, string>>({}); const [hist, setHist] = useState<Record<string, string[]>>({});
  const reset = (d: PadData) => { setSecs(d.sections); setPrint(d.print); setTelugu(d.telugu); setHist(Object.fromEntries(d.history.map((c) => [c.key, c.options]))); };
  useEffect(() => { if (q.data) reset(q.data); }, [q.data]);
  const save = useMutation({ mutationFn: () => api('PUT', '/admin/pad', { sections: secs, print, telugu, historyOptions: hist }), onSuccess: () => { toast('Pad saved'); qc.invalidateQueries({ queryKey: ['admin-pad'] }); qc.invalidateQueries({ queryKey: ['config'] }); onSaved(); }, onError: (e) => toast(errText(e), 'err') });
  if (!q.data || !print) return <div className="card"><Skeleton rows={6} /></div>;
  const d = q.data;
  const known = (k: string) => d.known.find((x) => x.key === k)!;
  const move = (i: number, dir: -1 | 1) => { const j = i + dir; if (j < 0 || j >= secs.length) return; const a = [...secs]; [a[i], a[j]] = [a[j], a[i]]; setSecs(a); };
  const upd = (i: number, p: Partial<Sec>) => setSecs(secs.map((s, k) => (k === i ? { ...s, ...p } : s)));
  const savedHist = Object.fromEntries(d.history.map((c) => [c.key, c.options]));
  const dirty = JSON.stringify(secs) !== JSON.stringify(d.sections) || JSON.stringify(print) !== JSON.stringify(d.print) || JSON.stringify(telugu) !== JSON.stringify(d.telugu) || JSON.stringify(hist) !== JSON.stringify(savedHist);
  const Tick = ({ on, onChange, disabled, label }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) => <input type="checkbox" className="h-4 w-4 accent-ink disabled:opacity-30" aria-label={label} checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] xl:items-start">
        <Section title="Sections on the pad" aside={<span className="text-xs text-muted">Diagnosis always shows and is required</span>}>
          <div className="grid grid-cols-[24px_minmax(0,1fr)_64px_80px_64px_64px] items-center gap-2 px-4 py-2 text-[11.5px] font-semibold text-muted"><span /><span>Section</span><span>Show</span><span>Required</span><span>Print</span><span>Order</span></div>
          {secs.map((s, i) => { const k = known(s.key); return (
            <div key={s.key} className={`grid grid-cols-[24px_minmax(0,1fr)_64px_80px_64px_64px] items-center gap-2 border-t border-line px-4 py-2 text-[13px] ${s.show ? '' : 'text-muted'}`}>
              <span className="text-muted">⋮⋮</span>
              <span className="font-medium">{k?.label ?? s.key}{s.key === 'notes' && <span className="ml-2 text-xs text-muted">never printed</span>}</span>
              <Tick label={`Show ${k?.label}`} on={s.show} disabled={s.key === 'diagnosis'} onChange={(v) => upd(i, { show: v })} />
              <Tick label={`Require ${k?.label}`} on={s.required} disabled={!k?.canRequire || s.key === 'diagnosis'} onChange={(v) => upd(i, { required: v })} />
              <Tick label={`Print ${k?.label}`} on={s.print} disabled={!k?.canPrint} onChange={(v) => upd(i, { print: v })} />
              <span className="flex gap-0.5"><button type="button" className="btn btn-ghost btn-icon !h-7 !w-7" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><Icon name="up" className="h-3.5 w-3.5" /></button><button type="button" className="btn btn-ghost btn-icon !h-7 !w-7" aria-label="Move down" disabled={i === secs.length - 1} onClick={() => move(i, 1)}><Icon name="up" className="h-3.5 w-3.5 rotate-180" /></button></span>
            </div>); })}
          <div className="px-4 py-3 text-xs text-muted">Examination fields and custom sections are edited under Consultation form. Print here decides whether a section is on the paper at all; what prints inside it is the Print settings on the right.</div>
        </Section>
        <div className="space-y-4">
          <Section title="Printed prescription">
            <div className="space-y-4 p-4 text-[13px]">
              <div><span className="label">Language for standard phrases and advice</span><div className="flex flex-wrap gap-1.5">{([['te+en', 'Telugu + English'], ['en', 'English only'], ['te', 'Telugu only']] as const).map(([v, l]) => <button key={v} type="button" className={`toggle-opt ${print.lang === v ? 'on' : ''}`} onClick={() => setPrint({ ...print, lang: v })}>{l}</button>)}</div><div className="mt-1 text-xs text-muted">Timings, frequencies and the advice chips are translated from the phrase table below. Free text prints as typed.</div></div>
              <div><span className="label">Vitals on the paper</span><div className="flex flex-wrap gap-1.5">{VITAL_CHOICES.map(([k, l]) => <button key={k} type="button" className={`toggle-opt ${print.vitals.includes(k) ? 'on' : ''}`} onClick={() => setPrint({ ...print, vitals: print.vitals.includes(k) ? print.vitals.filter((x) => x !== k) : [...print.vitals, k] })}>{l}</button>)}</div></div>
              <label className="flex items-center gap-2"><input type="checkbox" className="h-4 w-4 accent-ink" checked={print.outOfRangeOnly} onChange={(e) => setPrint({ ...print, outOfRangeOnly: e.target.checked })} />Print only out-of-range lab values by default<span className="text-xs text-muted">· the doctor can change it per prescription</span></label>
            </div>
          </Section>
          <HistoryOptions cats={d.history} defaults={d.historyDefaults} value={hist} onChange={setHist} />
        </div>
      </div>
      <TeluguTable value={telugu} defaults={d.teluguDefaults} onChange={setTelugu} />
      <div className="settings-save"><button className="btn btn-ghost" disabled={!dirty} onClick={() => reset(d)}>Discard</button><button className="btn btn-primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}><Icon name="check" />Save</button></div>
    </div>
  );
}

/** The chips offered under each history category. Patients' saved answers are untouched; this only changes what is offered next time. */
function HistoryOptions({ cats, defaults, value, onChange }: { cats: Cat[]; defaults: Cat[]; value: Record<string, string[]>; onChange: (v: Record<string, string[]>) => void }) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const add = (k: string) => { const v = (draft[k] ?? '').trim(); if (!v) return; const cur = value[k] ?? []; if (!cur.some((x) => x.toLowerCase() === v.toLowerCase())) onChange({ ...value, [k]: [...cur, v] }); setDraft({ ...draft, [k]: '' }); };
  return (
    <Section title="History chips" aside={<span className="text-xs text-muted">what each chip offers</span>}>
      {cats.map((c) => { const xs = value[c.key] ?? []; const def = defaults.find((x) => x.key === c.key)?.options ?? []; const changed = JSON.stringify(xs) !== JSON.stringify(def); return (
        <div key={c.key} className="border-t border-line px-4 py-2.5 first:border-t-0">
          <div className="flex items-center gap-2 text-[13px]"><b>{c.label}</b>{changed && <button type="button" className="ml-auto text-xs text-muted hover:text-ink" onClick={() => onChange({ ...value, [c.key]: def })}>Reset to built-in</button>}</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {xs.map((o) => <span key={o} className="toggle-opt on !min-h-7 !py-0.5">{o}<button type="button" aria-label={`Remove ${o}`} className="ml-1.5 text-muted hover:text-ink" onClick={() => onChange({ ...value, [c.key]: xs.filter((x) => x !== o) })}><Icon name="x" className="h-3 w-3" /></button></span>)}
            <input aria-label={`Add to ${c.label}`} className="input !w-36 !min-h-7 !py-0.5 text-[12.5px]" placeholder="Add…" maxLength={60} value={draft[c.key] ?? ''} onChange={(e) => setDraft({ ...draft, [c.key]: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(c.key); } }} onBlur={() => add(c.key)} />
          </div>
        </div>); })}
    </Section>
  );
}

/** Every standard phrase and its Telugu line. Leave a line empty to print that phrase in English only; add a row for a phrase the doctor types often. */
function TeluguTable({ value, defaults, onChange }: { value: Record<string, string>; defaults: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  const [q, setQ] = useState(''); const [newKey, setNewKey] = useState(''); const [newVal, setNewVal] = useState('');
  const keys = Object.keys(value).filter((k) => !q || k.includes(q.toLowerCase()) || (value[k] ?? '').includes(q));
  const changed = Object.keys(value).filter((k) => (defaults[k] ?? '') !== value[k]).length;
  const addRow = () => { const k = newKey.trim().toLowerCase(); if (!k) return; onChange({ ...value, [k]: newVal.trim() }); setNewKey(''); setNewVal(''); };
  return (
    <Section title={<>Telugu phrases <span className="font-normal text-muted">· {Object.keys(value).length}{changed ? ` · ${changed} changed` : ''}</span></>}
      aside={<><input className="input !w-48 !py-1.5" placeholder="Find a phrase" value={q} onChange={(e) => setQ(e.target.value)} />{changed > 0 && <button type="button" className="btn btn-sm" onClick={() => onChange({ ...defaults })}>Reset all</button>}</>}>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_32px] items-center gap-2 px-4 py-2 text-[11.5px] font-semibold text-muted"><span>Phrase as typed on the pad</span><span>Printed under it in Telugu</span><span /></div>
      <div className="max-h-[420px] overflow-y-auto">
        {keys.map((k) => { const def = defaults[k]; const isNew = def === undefined; const edited = !isNew && def !== value[k]; return (
          <div key={k} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_32px] items-center gap-2 border-t border-line px-4 py-1.5 text-[13px]">
            <span className="truncate" title={k}>{k}{isNew && <span className="ml-1.5 text-[11px] text-muted">added</span>}</span>
            <input aria-label={`Telugu for ${k}`} className={`input !min-h-8 !py-1 ${edited ? '!border-amber' : ''}`} lang="te" placeholder="English only" maxLength={160} value={value[k] ?? ''} onChange={(e) => onChange({ ...value, [k]: e.target.value })} />
            {isNew ? <button type="button" className="btn btn-ghost btn-icon !h-7 !w-7" aria-label={`Remove ${k}`} onClick={() => { const n = { ...value }; delete n[k]; onChange(n); }}><Icon name="x" className="h-3.5 w-3.5" /></button>
              : edited ? <button type="button" className="btn btn-ghost btn-icon !h-7 !w-7" aria-label={`Reset ${k}`} title="Back to built-in" onClick={() => onChange({ ...value, [k]: def })}><Icon name="undo" className="h-3.5 w-3.5" /></button> : <span />}
          </div>); })}
        {keys.length === 0 && <div className="px-4 py-6 text-center text-xs text-muted">No phrase matches. Add it below.</div>}
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_32px] items-center gap-2 border-t border-line bg-surface-2 px-4 py-2">
        <input aria-label="New phrase" className="input !min-h-8 !py-1" placeholder="New phrase, e.g. after bath" maxLength={80} value={newKey} onChange={(e) => setNewKey(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addRow(); } }} />
        <input aria-label="New phrase in Telugu" className="input !min-h-8 !py-1" lang="te" placeholder="Telugu" maxLength={160} value={newVal} onChange={(e) => setNewVal(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addRow(); } }} />
        <button type="button" className="btn btn-ghost btn-icon !h-7 !w-7" aria-label="Add phrase" disabled={!newKey.trim()} onClick={addRow}><Icon name="plus" className="h-3.5 w-3.5" /></button>
      </div>
    </Section>
  );
}
