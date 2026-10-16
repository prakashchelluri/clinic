import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api, qc } from './api';
import { Icon, Modal, toast } from './ui';

export type Routine = { days: Record<string, [string, string][]>; capacity: number; windowMinutes: number };
const DAYS: [string, string][] = [['1', 'Mon'], ['2', 'Tue'], ['3', 'Wed'], ['4', 'Thu'], ['5', 'Fri'], ['6', 'Sat'], ['0', 'Sun']];
export const DEFAULT_ROUTINE: Routine = { days: Object.fromEntries(['1', '2', '3', '4', '5', '6'].map((d) => [d, [['10:00', '13:00'], ['16:00', '20:00']]])), capacity: 7, windowMinutes: 60 };

/** "Mon–Sat · 10–12, 15–19" for headers. */
export function routineSummary(r?: Routine | null) {
  if (!r || !Object.keys(r.days).length) return 'No routine set';
  const keys = DAYS.filter(([d]) => r.days[d]?.length).map(([, l]) => l);
  const first = r.days[Object.keys(r.days).find((k) => r.days[k]?.length)!];
  const allSame = Object.values(r.days).filter((v) => v.length).every((v) => JSON.stringify(v) === JSON.stringify(first));
  const span = keys.length > 2 && DAYS.findIndex(([, l]) => l === keys[keys.length - 1]) - DAYS.findIndex(([, l]) => l === keys[0]) === keys.length - 1 ? `${keys[0]}–${keys[keys.length - 1]}` : keys.join(', ');
  const hhmm = (t: string) => t.replace(/^0/, '').replace(/:00$/, '');
  return `${span} · ${first.map(([s, e]) => `${hhmm(s)}–${hhmm(e)}`).join(', ')}${allSame ? '' : ' (varies)'}`;
}

/** Weekday rows with hour chips. Set once; windows for every day are generated from it. */
export function RoutineEditor({ value, onChange }: { value: Routine; onChange: (r: Routine) => void }) {
  const set = (d: string, ranges: [string, string][]) => onChange({ ...value, days: { ...value.days, [d]: ranges } });
  const toggle = (d: string) => set(d, value.days[d]?.length ? [] : [['10:00', '13:00']]);
  const monday = value.days['1'] ?? [];
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {DAYS.map(([d, label]) => {
          const ranges = value.days[d] ?? []; const on = ranges.length > 0;
          return (
            <div key={d} className="grid grid-cols-[72px_1fr] gap-3 items-center">
              <button type="button" aria-pressed={on} className={`toggle-opt !py-2.5 ${on ? 'on' : ''}`} onClick={() => toggle(d)}>{label}</button>
              {!on ? <div className="text-sm text-muted">Off</div> : (
                <div className="flex flex-wrap gap-1.5 items-center">
                  {ranges.map(([s, e], i) => (
                    <span key={i} className="inline-flex items-center gap-1 rounded-full bg-clay-soft text-clay-2 px-2 py-1 text-xs font-semibold anim-scale-in">
                      <input type="time" className="bg-transparent outline-none w-[74px]" value={s} onChange={(ev) => set(d, ranges.map((r, j) => j === i ? [ev.target.value, r[1]] : r))} />–
                      <input type="time" className="bg-transparent outline-none w-[74px]" value={e} onChange={(ev) => set(d, ranges.map((r, j) => j === i ? [r[0], ev.target.value] : r))} />
                      <button type="button" aria-label="Remove hours" className="hover:text-ink" onClick={() => set(d, ranges.filter((_, j) => j !== i))}><Icon name="x" className="h-3 w-3" /></button>
                    </span>
                  ))}
                  {ranges.length < 3 && <button type="button" className="toggle-opt border-dashed !py-1.5" onClick={() => set(d, [...ranges, [ranges[ranges.length - 1]?.[1] ?? '15:00', '19:00']])}>+ hours</button>}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {monday.length > 0 && <button type="button" className="btn btn-sm" onClick={() => onChange({ ...value, days: Object.fromEntries(Object.keys(value.days).map((d) => [d, value.days[d]?.length ? monday : []])) })}>Copy Monday to all working days</button>}
      <div className="grid grid-cols-2 gap-3 pt-3 border-t border-line">
        <div><label className="label">Patients per hour</label><input type="number" className="input" value={value.capacity} onChange={(e) => onChange({ ...value, capacity: Number(e.target.value) })} /></div>
        <div><label className="label">Window length</label><div className="flex gap-1">{[30, 60].map((m) => <button type="button" key={m} className={`toggle-opt ${value.windowMinutes === m ? 'on' : ''}`} onClick={() => onChange({ ...value, windowMinutes: m })}>{m} min</button>)}</div></div>
      </div>
    </div>
  );
}

export function RoutineModal({ practitionerId, name, initial, onClose }: { practitionerId: string; name: string; initial?: Routine | null; onClose: () => void }) {
  const [r, setR] = useState<Routine>(initial && Object.keys(initial.days ?? {}).length ? initial : DEFAULT_ROUTINE);
  const save = useMutation({ mutationFn: () => api('PUT', `/calendar/routine/${practitionerId}`, r), onSuccess: () => { toast('Routine saved · windows follow it from today'); qc.invalidateQueries({ queryKey: ['config'] }); qc.invalidateQueries({ queryKey: ['calendar'] }); qc.invalidateQueries({ queryKey: ['sessions'] }); onClose(); }, onError: (e: any) => toast(e?.body?.code ?? 'Could not save', 'err') });
  return (
    <Modal title="Weekly routine" subtitle={`${name} · set once; every day's OP windows are made from this`} onClose={onClose} width="max-w-xl">
      <RoutineEditor value={r} onChange={setR} />
      <div className="flex justify-end gap-2 pt-4 mt-4 border-t border-line"><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={save.isPending || !Object.values(r.days).some((v) => v.length)} onClick={() => save.mutate()}><Icon name="check" />Save routine</button></div>
    </Modal>
  );
}
