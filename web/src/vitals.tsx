import { useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { get, patch, qc, errText } from './api';
import { Floating, NumInput, fmtDate, toast } from './ui';

/** The clinic's vitals, one list for check-in, the pad, past values and the printed prescription:
 *  the six every clinic knows, plus any the owner adds in Settings → Consultation form fields. settings.vitals says which are taken. */
export type VitalField = { key: string; label: string; unit: string; type: 'number' | 'text'; ph?: string; decimal?: boolean; min?: number; max?: number; custom?: boolean };
export const BUILTIN_VITALS: VitalField[] = [
  { key: 'weight_kg', label: 'Weight', unit: 'kg', type: 'number', decimal: true, min: 1, max: 400 },
  { key: 'height_cm', label: 'Height', unit: 'cm', type: 'number', min: 30, max: 250 },
  { key: 'temp_f', label: 'Temp', unit: '°F', type: 'number', ph: '98.4', decimal: true, min: 90, max: 110 },
  { key: 'bp', label: 'BP', unit: 'mmHg', type: 'text', ph: '120/80' },
  { key: 'spo2', label: 'SpO₂', unit: '%', type: 'number', ph: '98', min: 50, max: 100 },
  { key: 'pulse', label: 'Pulse', unit: 'bpm', type: 'number', min: 20, max: 250 },
];
/** Why a typed vital cannot be saved, or ''. The server checks the same ranges (src/modules/rxpad.ts Vitals). */
export function vitalProblem(v: VitalField, raw: string): string {
  const t = raw.trim(); if (!t) return '';
  if (v.key === 'bp') { const m = /^(\d{2,3})\/(\d{2,3})$/.exec(t); return m && +m[1] >= 50 && +m[1] <= 300 && +m[2] >= 20 && +m[2] <= 200 && +m[1] > +m[2] ? '' : 'BP should read like 120/80'; }
  if (v.type !== 'number') return '';
  const n = Number(t); return Number.isFinite(n) && (v.min === undefined || n >= v.min) && (v.max === undefined || n <= v.max) ? '' : `${v.label} should be ${v.min ?? 0}–${v.max} ${v.unit}`;
}
export const DEFAULT_VITALS = ['weight_kg', 'height_cm', 'temp_f', 'bp', 'spo2'];
export const vitalFields = (settings: any): VitalField[] => [...BUILTIN_VITALS, ...((settings?.vitalFields ?? []) as VitalField[]).map((v) => ({ ...v, decimal: v.type === 'number', max: v.type === 'number' ? 100000 : undefined, custom: true }))];
/** The vitals this clinic takes, in its order. */
export const enabledVitals = (settings: any): VitalField[] => { const on: string[] = settings?.vitals ?? DEFAULT_VITALS; return vitalFields(settings).filter((v) => on.includes(v.key)); };
/** "70 kg · BP 120/80 · Pulse 98 bpm" for a summary line. */
export const vitalsText = (details: Record<string, any>, fields: VitalField[]) => fields.filter((v) => details?.[v.key] !== undefined && details[v.key] !== null && details[v.key] !== '')
  .map((v) => (['weight_kg', 'height_cm', 'temp_f'].includes(v.key) ? `${details[v.key]} ${v.unit}` : `${v.label} ${details[v.key]}${v.unit && v.key !== 'bp' ? ` ${v.unit}` : ''}`)).join(' · ');
export const bmiOf = (w?: number | null, h?: number | null) => (w && h ? Math.round((w / ((h / 100) ** 2)) * 10) / 10 : null);
// ponytail: adult reference ranges, fixed here; per-clinic or per-age ranges are the upgrade path
/** A reading outside the usual adult range: 'high', 'low' or ''. The pad's summary and the Vitals drawer both use it. */
export const vitalFlag = (k: string, raw: any): '' | 'high' | 'low' => { const n = Number(raw);
  if (raw === undefined || raw === null || raw === '') return '';
  if (k === 'temp_f') return n >= 99.5 ? 'high' : n < 96.5 ? 'low' : ''; if (k === 'spo2') return n < 95 ? 'low' : ''; if (k === 'pulse') return n > 100 ? 'high' : n < 50 ? 'low' : '';
  if (k === 'bmi') return n >= 30 ? 'high' : n < 18.5 ? 'low' : ''; if (k === 'bp') { const m = /^(\d+)\/(\d+)$/.exec(String(raw)); return m ? (+m[1] >= 140 || +m[2] >= 90 ? 'high' : +m[1] < 90 ? 'low' : '') : ''; } return ''; };
const bmiWord = (b: number) => (b < 18.5 ? 'low' : b < 25 ? 'normal' : b < 30 ? 'high' : 'obese');

/** Vitals on the pad: tiles the doctor taps to change, BMI worked out, past values per visit on tap. The front desk fills them at check-in.
 *  Shows the vitals this clinic takes, and any other one that has a value for this visit. */
export function VitalsCard({ encounterId, patientId, details, heightCm, readOnly, settings }: { encounterId: string; patientId: string; details: Record<string, any>; heightCm?: number | null; readOnly: boolean; settings: any }) {
  const [edit, setEdit] = useState<string | null>(null); const [val, setVal] = useState('');
  const [past, setPast] = useState(false); const anchor = useRef<HTMLButtonElement>(null);
  const hist = useQuery({ queryKey: ['vitals', patientId], queryFn: () => get(`/patients/${patientId}/vitals`), enabled: past });
  const save = useMutation({ mutationFn: (b: Record<string, any>) => patch(`/encounters/${encounterId}/vitals`, b), onSuccess: () => { qc.invalidateQueries({ queryKey: ['encounter', encounterId] }); qc.invalidateQueries({ queryKey: ['vitals', patientId] }); setEdit(null); }, onError: (e) => toast(errText(e), 'err') });
  const d: Record<string, any> = { ...details, height_cm: details.height_cm ?? heightCm ?? undefined };
  const taken = enabledVitals(settings).map((v) => v.key);
  const VITALS = vitalFields(settings).filter((v) => taken.includes(v.key) || (d[v.key] !== undefined && d[v.key] !== null && d[v.key] !== ''));
  const commit = (k: string) => { const v = VITALS.find((x) => x.key === k)!; const raw = val.trim(); const bad = vitalProblem(v, raw); if (bad) { toast(bad, 'err'); return; } const out = raw === '' ? null : v.type === 'number' ? Number(raw) : raw; if (out === (d[k] ?? null)) return setEdit(null); save.mutate({ [k]: out }); };
  const bmi = bmiOf(d.weight_kg, d.height_cm);
  const rows: any[] = hist.data ?? [];
  return (
    <div>
      <div className="flex flex-wrap items-stretch gap-1.5">
        {VITALS.map((v) => { const cur = d[v.key]; const on = edit === v.key; const fl = on ? '' : vitalFlag(v.key, cur); return (
          <button key={v.key} type="button" disabled={readOnly} onClick={() => { if (!on) { setEdit(v.key); setVal(cur === undefined || cur === null ? '' : String(cur)); } }}
            title={fl ? `${v.label} ${fl}` : undefined} className={`flex min-w-[112px] items-baseline gap-1.5 rounded-lg border px-3 py-2 text-left ${fl ? 'border-rose/40 bg-rose-soft text-rose' : 'bg-surface'} ${on ? 'border-ink shadow-[0_0_0_3px_rgba(21,24,27,.08)]' : fl ? '' : 'border-line hover:border-muted'} ${readOnly ? 'cursor-default' : ''}`} aria-label={`${v.label}${cur !== undefined && cur !== null ? ` ${cur} ${v.unit}` : ', not recorded'}`}>
            <span className={`text-[11px] font-semibold uppercase tracking-[.06em] ${fl ? 'text-rose' : 'text-muted'}`}>{v.label}{fl ? ` · ${fl}` : ''}</span>
            {on ? (v.type === 'number' ? <NumInput autoFocus decimal={v.decimal} max={v.max} aria-label={v.label} className="w-14 bg-transparent text-[15px] font-semibold outline-none" value={val} onChange={(e) => setVal(e.target.value)} onBlur={() => commit(v.key)} onKeyDown={(e) => { if (e.key === 'Enter') commit(v.key); if (e.key === 'Escape') setEdit(null); }} />
              : <input autoFocus aria-label={v.label} className="w-16 bg-transparent text-[15px] font-semibold outline-none" maxLength={v.key === 'bp' ? 9 : 20} placeholder={v.ph ?? ''} value={val} onChange={(e) => setVal(v.key === 'bp' ? e.target.value.replace(/[^\d/]/g, '') : e.target.value)} onBlur={() => commit(v.key)} onKeyDown={(e) => { if (e.key === 'Enter') commit(v.key); if (e.key === 'Escape') setEdit(null); }} />)
              : <b className={`text-[15px] ${cur === undefined || cur === null || cur === '' ? 'font-normal text-muted' : ''}`}>{cur === undefined || cur === null || cur === '' ? '—' : cur}</b>}
            {cur !== undefined && cur !== null && cur !== '' && !on && v.unit && <span className="text-xs text-muted">{v.unit}</span>}
          </button>); })}
        {bmi !== null && <div className={`flex min-w-[112px] items-baseline gap-1.5 rounded-lg border px-3 py-2 ${vitalFlag('bmi', bmi) ? 'border-rose/40 bg-rose-soft text-rose' : 'border-line bg-surface-2'}`}><span className={`text-[11px] font-semibold uppercase tracking-[.06em] ${vitalFlag('bmi', bmi) ? 'text-rose' : 'text-muted'}`}>BMI{vitalFlag('bmi', bmi) ? ` · ${vitalFlag('bmi', bmi)}` : ''}</span><b className="text-[15px]">{bmi}</b><span className={`chip ${bmi >= 25 || bmi < 18.5 ? 'chip-amber' : 'chip-sage'}`}>{bmiWord(bmi)}</span></div>}
        <button ref={anchor} type="button" className="btn btn-ghost btn-sm self-center" aria-expanded={past} onClick={() => setPast(!past)}>Past values</button>
      </div>
      <Floating anchor={anchor} open={past} onClose={() => setPast(false)} width={Math.min(140 + (VITALS.length + 1) * 92, 900)}>
        <div className="overflow-x-auto p-2">
          <div className="mb-2 text-[13px] font-semibold">Past values <span className="font-normal text-muted">· newest first, in the order they are taken</span></div>
          {hist.isLoading ? <div className="text-xs text-muted">Loading…</div> : rows.length === 0 ? <div className="text-xs text-muted">No earlier visits with vitals.</div> : (
            <table className="w-full text-[12.5px]"><thead><tr><th className="py-1 text-left text-[11px] font-semibold uppercase tracking-[.06em] text-muted">Date</th>{[...VITALS.map((v) => v.label), 'BMI'].map((l) => <th key={l} className="px-2 py-1 text-left text-[11px] font-semibold uppercase tracking-[.06em] text-muted">{l}</th>)}</tr></thead>
              <tbody>{rows.slice(0, 6).map((r: any) => { const b = bmiOf(r.weight_kg, r.height_cm); return (
                <tr key={r.day} className="border-t border-line"><td className="whitespace-nowrap py-1.5 text-muted">{fmtDate(r.day)}</td>
                  {VITALS.map((v) => <td key={v.key} className="whitespace-nowrap px-2 py-1.5 tabular-nums">{r[v.key] == null || r[v.key] === '' ? <span className="text-muted">—</span> : <><b>{r[v.key]}</b>{v.unit && <span className="text-xs text-muted"> {v.unit}</span>}</>}</td>)}
                  <td className="whitespace-nowrap px-2 py-1.5 tabular-nums">{b === null ? <span className="text-muted">—</span> : <><b>{b}</b> <span className="text-xs text-muted">{bmiWord(b)}</span></>}</td></tr>); })}</tbody></table>)}
        </div>
      </Floating>
    </div>
  );
}
