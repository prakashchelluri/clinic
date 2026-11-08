import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, get, qc, errText } from '../api';
import { Icon, Section, Skeleton, toast } from '../ui';

type Sec = { key: string; show: boolean; required: boolean; print: boolean };
type Known = { key: string; label: string; canRequire?: boolean; canPrint?: boolean };
type Print = { lang: 'te+en' | 'en' | 'te'; outOfRangeOnly: boolean; vitals: string[] };
const VITAL_CHOICES: [string, string][] = [['weight_kg', 'Weight'], ['height_cm', 'Height'], ['bp', 'BP'], ['pulse', 'Pulse'], ['temp_f', 'Temperature'], ['spo2', 'SpO₂']];

/** Settings → Rx pad: which sections show on the pad, which are required, the order, and what the printed prescription carries. */
export function PadTab({ onSaved }: { onSaved: () => void }) {
  const q = useQuery<{ sections: Sec[]; print: Print; known: Known[] }>({ queryKey: ['admin-pad'], queryFn: () => get('/admin/pad') });
  const [secs, setSecs] = useState<Sec[]>([]); const [print, setPrint] = useState<Print | null>(null);
  useEffect(() => { if (q.data) { setSecs(q.data.sections); setPrint(q.data.print); } }, [q.data]);
  const save = useMutation({ mutationFn: () => api('PUT', '/admin/pad', { sections: secs, print }), onSuccess: () => { toast('Pad saved'); qc.invalidateQueries({ queryKey: ['admin-pad'] }); qc.invalidateQueries({ queryKey: ['config'] }); onSaved(); }, onError: (e) => toast(errText(e), 'err') });
  if (!q.data || !print) return <div className="card"><Skeleton rows={6} /></div>;
  const known = (k: string) => q.data!.known.find((x) => x.key === k)!;
  const move = (i: number, dir: -1 | 1) => { const j = i + dir; if (j < 0 || j >= secs.length) return; const a = [...secs]; [a[i], a[j]] = [a[j], a[i]]; setSecs(a); };
  const upd = (i: number, p: Partial<Sec>) => setSecs(secs.map((s, k) => (k === i ? { ...s, ...p } : s)));
  const dirty = JSON.stringify(secs) !== JSON.stringify(q.data.sections) || JSON.stringify(print) !== JSON.stringify(q.data.print);
  const Tick = ({ on, onChange, disabled, label }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) => <input type="checkbox" className="h-4 w-4 accent-ink disabled:opacity-30" aria-label={label} checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />;
  return (
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
            <div><span className="label">Language for standard phrases and advice</span><div className="flex flex-wrap gap-1.5">{([['te+en', 'Telugu + English'], ['en', 'English only'], ['te', 'Telugu only']] as const).map(([v, l]) => <button key={v} type="button" className={`toggle-opt ${print.lang === v ? 'on' : ''}`} onClick={() => setPrint({ ...print, lang: v })}>{l}</button>)}</div><div className="mt-1 text-xs text-muted">Timings, frequencies and the advice chips are translated from a built-in table. Free text prints as typed.</div></div>
            <div><span className="label">Vitals on the paper</span><div className="flex flex-wrap gap-1.5">{VITAL_CHOICES.map(([k, l]) => <button key={k} type="button" className={`toggle-opt ${print.vitals.includes(k) ? 'on' : ''}`} onClick={() => setPrint({ ...print, vitals: print.vitals.includes(k) ? print.vitals.filter((x) => x !== k) : [...print.vitals, k] })}>{l}</button>)}</div></div>
            <label className="flex items-center gap-2"><input type="checkbox" className="h-4 w-4 accent-ink" checked={print.outOfRangeOnly} onChange={(e) => setPrint({ ...print, outOfRangeOnly: e.target.checked })} />Print only out-of-range lab values by default<span className="text-xs text-muted">· the doctor can change it per prescription</span></label>
          </div>
        </Section>
        <div className="flex justify-end gap-2"><button className="btn btn-ghost" disabled={!dirty} onClick={() => { setSecs(q.data!.sections); setPrint(q.data!.print); }}>Discard</button><button className="btn btn-primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}><Icon name="check" />Save</button></div>
      </div>
    </div>
  );
}
