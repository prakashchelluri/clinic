import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { get, patch, post, qc, today, errText } from './api';
import { FileText } from 'lucide-react';
import { Drawer, Chip, Icon, fmtDate, toast } from './ui';
import { openViewer } from './viewer';
import { LabHistoryDrawer, dedupe } from './labHistory';
import { UploadButton } from './encounterDetail';

/** The report file behind a result or an ordered test: the one the value was typed from, else one uploaded against that test. */
export const reportFor = (docs: any[], documentId: string | null | undefined, recommendationId: string | null | undefined) =>
  (documentId ? docs.find((d) => d.id === documentId) : null) ?? (recommendationId ? docs.find((d) => d.kind !== 'photo' && (d.recommendationId === recommendationId || (d.recommendationIds ?? []).includes(recommendationId))) : null) ?? null;
/** Opens the report (PDF or image) over the page, in the app's own viewer: the Rxpad stays where it was. */
export const ReportLink = ({ doc, label = 'View PDF', patientId, encounterId }: { doc: any; label?: string; patientId?: string; encounterId?: string }) => <button type="button" className="btn btn-ghost !min-h-7 gap-1 !px-2 text-[12px]" title={doc.title ?? 'Report'} onClick={() => openViewer({ docs: [doc], patientId, encounterId })}><FileText className="h-3.5 w-3.5" aria-hidden />{/pdf/i.test(doc.mime ?? '') ? label : 'View report'}</button>;

/** Lab values typed from a report: the editor the receptionist uses, the card the doctor sees, and the per-test history. */
export type LabParam = { name: string; unit?: string; low?: number; high?: number; expect?: string; aliases?: string[] };
export type LabRow = { id: string; test: string; value: string; num: number | null; unit: string | null; low: number | null; high: number | null; flag: 'low' | 'normal' | 'high' | 'abnormal' | null; takenOn: string; note: string | null; encounterId: string | null; recommendationId: string | null; documentId: string | null };
export type LabDraft = { test: string; value: string; note: string };

export const useLabResults = (patientId?: string) => useQuery<LabRow[]>({ queryKey: ['labs', patientId], queryFn: () => get(`/patients/${patientId}/lab-results`), enabled: !!patientId });
const norm = (s: string) => s.trim().toLowerCase();
export const findParam = (name: string, params: LabParam[]) => params.find((p) => norm(p.name) === norm(name) || (p.aliases ?? []).some((a) => norm(a) === norm(name)));
const rangeText = (p?: { low?: number | null; high?: number | null; expect?: string }) => !p ? '' : p.expect ? p.expect : p.low !== undefined && p.low !== null && p.high !== undefined && p.high !== null ? `${p.low}–${p.high}` : p.high !== undefined && p.high !== null ? `≤ ${p.high}` : p.low !== undefined && p.low !== null ? `≥ ${p.low}` : '';
const out = (f: LabRow['flag']) => f === 'low' || f === 'high' || f === 'abnormal';
export { rangeText, out as isOut };
/** The flag a typed value gets against the clinic's range, as the server will store it: a number against low/high, words against the expected word. */
export function flagFor(value: string, p?: LabParam): LabRow['flag'] {
  const v = value.trim(); if (!v || !p) return null;
  const n = Number(v.replace(/,/g, ''));
  if (!Number.isNaN(n) && (p.low !== undefined || p.high !== undefined)) return p.low !== undefined && n < p.low ? 'low' : p.high !== undefined && n > p.high ? 'high' : 'normal';
  if (p.expect) { const e = norm(p.expect); const x = norm(v); return x === e || (e.startsWith('neg') && x.startsWith('neg')) || (e.startsWith('non') && x.startsWith('non')) ? 'normal' : 'abnormal'; }
  return null;
}

export function FlagChip({ flag }: { flag: LabRow['flag'] }) {
  if (!flag) return null;
  return <Chip tone={out(flag) ? 'rose' : 'sage'}>{flag === 'normal' ? 'ok' : flag}</Chip>;
}

/** Rows of test · value · note. Units and ranges come from the clinic list; the value is checked as it is typed. Empty rows are ignored on save. */
export function LabValuesEditor({ rows, onChange, params, compact = false }: { rows: LabDraft[]; onChange: (r: LabDraft[]) => void; params: LabParam[]; compact?: boolean }) {
  const upd = (i: number, p: Partial<LabDraft>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const list = rows.length && rows[rows.length - 1].test ? [...rows, { test: '', value: '', note: '' }] : rows.length ? rows : [{ test: '', value: '', note: '' }];
  return (
    <div>
      <datalist id="lab-params">{params.map((p) => <option key={p.name} value={p.name} />)}</datalist>
      <div className={`grid gap-1.5 text-[11.5px] font-semibold text-muted ${compact ? 'grid-cols-[1.5fr_90px_1fr_24px]' : 'grid-cols-[1.6fr_100px_70px_110px_1fr_24px]'}`}><span>Investigation</span><span>Value</span>{!compact && <><span>Unit</span><span>Normal range</span></>}<span>Note</span><span /></div>
      {list.map((r, i) => { const p = findParam(r.test, params); const n = Number(r.value.replace(/,/g, '')); const flag: LabRow['flag'] = !r.value ? null : p && !Number.isNaN(n) && (p.low !== undefined || p.high !== undefined) ? (p.low !== undefined && n < p.low ? 'low' : p.high !== undefined && n > p.high ? 'high' : 'normal') : p?.expect ? (norm(r.value) === norm(p.expect) || (/^neg/i.test(p.expect) && /^neg/i.test(r.value)) || (/^non/i.test(p.expect) && /^non/i.test(r.value)) ? 'normal' : 'abnormal') : null; return (
        <div key={i} className={`mt-1.5 grid items-center gap-1.5 ${compact ? 'grid-cols-[1.5fr_90px_1fr_24px]' : 'grid-cols-[1.6fr_100px_70px_110px_1fr_24px]'}`}>
          <input list="lab-params" aria-label="Investigation" className="input !py-1.5" placeholder={i === list.length - 1 ? 'Add a parameter from the list, or type' : ''} value={r.test} onChange={(e) => (i < rows.length ? upd(i, { test: e.target.value }) : onChange([...rows, { test: e.target.value, value: '', note: '' }]))} />
          <div className="relative"><input aria-label="Value" className={`input !py-1.5 ${out(flag) ? '!border-rose' : ''}`} value={r.value} disabled={i >= rows.length} onChange={(e) => upd(i, { value: e.target.value })} />{flag && <span className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2"><FlagChip flag={flag} /></span>}</div>
          {!compact && <><span className="truncate text-xs text-muted">{p?.unit ?? ''}</span><span className="truncate text-xs text-muted">{rangeText(p)}</span></>}
          <input aria-label="Note" className="input !py-1.5" maxLength={160} value={r.note} disabled={i >= rows.length} onChange={(e) => upd(i, { note: e.target.value })} />
          {i < rows.length ? <button type="button" className="btn btn-ghost btn-icon !h-7 !w-7" aria-label="Remove row" onClick={() => onChange(rows.filter((_, j) => j !== i))}><Icon name="x" className="h-3.5 w-3.5" /></button> : <span />}
        </div>); })}
    </div>
  );
}

export async function saveLabValues(b: { patientId: string; encounterId?: string | null; recommendationId?: string | null; documentId?: string | null; takenOn?: string; rows: LabDraft[] }) {
  const items = b.rows.filter((r) => r.test.trim() && r.value.trim()).map((r) => ({ test: r.test.trim(), value: r.value.trim(), note: r.note.trim() || undefined }));
  if (!items.length) return [];
  const rows = await post('/lab-results', { patientId: b.patientId, encounterId: b.encounterId ?? null, recommendationId: b.recommendationId ?? null, documentId: b.documentId ?? null, takenOn: b.takenOn ?? today(), items });
  qc.invalidateQueries({ queryKey: ['labs', b.patientId] });
  return rows as LabRow[];
}


/** The pad's Lab results card body: this consultation's values first, else the latest of each test; earlier values beside; history on tap; the doctor can correct a value or add more. */
export type OrderedTest = { id?: string; name: string; done: boolean; note?: string };
export function LabResultsCard({ patientId, encounterId, recIds, params, readOnly, printOut, onPrintOut, docs = [], ordered }: { /** the tests ordered on this consultation: listed first with their status, values added inside each row */ ordered?: OrderedTest[]; patientId: string; encounterId: string; recIds: string[]; params: LabParam[]; readOnly: boolean; printOut: boolean; onPrintOut: (v: boolean) => void; docs?: any[] }) {
  const q = useLabResults(patientId);
  const [adding, setAdding] = useState(false); const [draft, setDraft] = useState<LabDraft[]>([]); const [history, setHistory] = useState<string | null>(null); // '' the whole table, a name that test's trend
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  const [inlineFor, setInlineFor] = useState<string | null>(null); // the ordered test whose values are being typed in its own row
  const all = q.data ?? [];
  const mine = all.filter((r) => r.encounterId === encounterId || (r.recommendationId && recIds.includes(r.recommendationId)));
  const shown = (mine.length ? mine : Object.values(all.reduce((m, r) => (m[r.test] && m[r.test].takenOn >= r.takenOn ? m : { ...m, [r.test]: r }), {} as Record<string, LabRow>))).sort((a, b) => Number(out(b.flag)) - Number(out(a.flag)) || a.test.localeCompare(b.test));
  const earlier = (r: LabRow) => dedupe(all).filter((x) => x.test === r.test && x.takenOn < r.takenOn).sort((a, b) => a.takenOn.localeCompare(b.takenOn)).slice(-3);
  const fix = useMutation({ mutationFn: (x: { id: string; value: string }) => patch(`/lab-results/${x.id}`, { value: x.value }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['labs', patientId] }); setEditing(null); }, onError: (e) => toast(errText(e), 'err') });
  const add = useMutation({ mutationFn: () => saveLabValues({ patientId, encounterId, rows: draft }), onSuccess: (rows) => { toast(rows.length ? `${rows.length} value${rows.length === 1 ? '' : 's'} saved` : 'Nothing to save', rows.length ? 'ok' : 'info'); setAdding(false); setInlineFor(null); setDraft([]); }, onError: (e) => toast(errText(e), 'err') });
  const editor = (onCancel: () => void) => <>
    <LabValuesEditor rows={draft} onChange={setDraft} params={params} />
    <div className="mt-2 flex justify-end gap-2"><button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button><button type="button" className="btn btn-primary btn-sm" disabled={add.isPending || !draft.some((r) => r.test.trim() && r.value.trim())} onClick={() => add.mutate()}>Save values</button></div></>;
  const orderedList = ordered && ordered.length > 0 && <div className="mb-4 space-y-2">
    {ordered.map((t) => { const doc = t.id ? reportFor(docs, null, t.id) : null; return (
      <div key={t.id ?? t.name} className="rounded-[8px] border border-line p-3">
        <div className="flex items-center gap-2"><b className="min-w-0 flex-1 truncate text-[14.5px] font-semibold">{t.name}</b>
          <Chip tone={t.done ? 'sage' : 'amber'}>{t.done ? 'Received' : 'Pending'}</Chip></div>
        {t.note && <div className="mt-1 text-[13px] text-muted">{t.note}</div>}
        {inlineFor === t.name ? <div className="mt-3">{editor(() => { setInlineFor(null); setDraft([]); })}</div>
          : <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {!readOnly && <button type="button" className="btn btn-sm" onClick={() => { setAdding(false); setDraft([{ test: t.name, value: '', note: '' }]); setInlineFor(t.name); }}>Add values</button>}
            {!readOnly && t.id && <UploadButton patientId={patientId} encounterId={encounterId} recommendationId={t.id} label="Upload report" onDone={() => qc.invalidateQueries({ queryKey: ['documents', patientId] })} />}
            {doc && <ReportLink doc={doc} patientId={patientId} encounterId={readOnly ? undefined : encounterId} />}
          </div>}
      </div>); })}
  </div>;
  return (
    <div>
      {orderedList}
      <div className="mb-1.5 flex flex-wrap items-center gap-3 text-xs text-muted">
        {shown.length > 0 && <span>{mine.length ? 'Values for this consultation' : 'Latest values on record'}</span>}
        {shown.length === 0 && <span>{q.isLoading ? 'Loading…' : 'No values yet.'}</span>}
        {shown.length > 0 && <label className="ml-auto inline-flex items-center gap-1.5 font-medium text-ink-2"><input type="checkbox" className="accent-ink" checked={printOut} disabled={readOnly} onChange={(e) => onPrintOut(e.target.checked)} />Print only out-of-range</label>}
        {all.length > 0 && <button type="button" className={`btn btn-sm ${shown.length ? '' : 'ml-auto'}`} onClick={() => setHistory('')}><Icon name="chart" className="h-3.5 w-3.5" />See history</button>}
        {!readOnly && <button type="button" className={`btn btn-sm ${shown.length || all.length ? "" : "ml-auto"}`} onClick={() => { setInlineFor(null); setDraft([]); setAdding(true); }}><Icon name="plus" className="h-3.5 w-3.5" />{ordered?.length ? 'Add other values' : 'Add values'}</button>}
      </div>
      {q.isLoading || shown.length === 0 ? null : (
        <div className="grid grid-cols-[minmax(0,1.5fr)_110px_60px_110px_minmax(0,1.4fr)_96px_28px] items-center gap-x-2 text-[13px]">
          <span className="text-[11.5px] font-semibold text-muted">Investigation</span><span className="text-[11.5px] font-semibold text-muted">Value</span><span className="text-[11.5px] font-semibold text-muted">Unit</span><span className="text-[11.5px] font-semibold text-muted">Range</span><span className="text-[11.5px] font-semibold text-muted">Earlier</span><span className="text-[11.5px] font-semibold text-muted">Report</span><span />
          {shown.map((r) => { const e = earlier(r); return (
            <div key={r.id} className={`contents ${out(r.flag) ? '' : 'text-ink-2'}`}>
              <span className={`truncate border-t border-line py-2 ${out(r.flag) ? 'font-semibold' : ''}`} title={r.note ?? ''}>{r.test}</span>
              <span className="border-t border-line py-2">{editing?.id === r.id ? <input autoFocus aria-label="Value" className="input !w-20 !py-0.5 text-[13px]" value={editing.value} onChange={(ev) => setEditing({ id: r.id, value: ev.target.value })} onKeyDown={(ev) => { if (ev.key === 'Enter' && editing.value.trim()) fix.mutate(editing); if (ev.key === 'Escape') setEditing(null); }} onBlur={() => (editing.value.trim() && editing.value !== r.value ? fix.mutate(editing) : setEditing(null))} />
                : <button type="button" disabled={readOnly} className={`inline-flex items-center gap-1.5 ${out(r.flag) ? 'font-semibold' : ''}`} title={readOnly ? undefined : 'Correct this value'} onClick={() => setEditing({ id: r.id, value: r.value })}>{r.value}<FlagChip flag={r.flag} /></button>}</span>
              <span className="truncate border-t border-line py-2 text-xs text-muted">{r.unit ?? ''}</span>
              <span className="truncate border-t border-line py-2 text-xs text-muted">{rangeText(r)}</span>
              <span className="truncate border-t border-line py-2 text-xs text-muted">{e.length ? e.map((x) => `${x.value} (${fmtDate(x.takenOn)})`).join(' → ') + ' → ' : 'first time'}{e.length ? <b className={out(r.flag) ? 'text-rose' : 'text-ink'}>{r.value}</b> : ''}</span>
              <span className="border-t border-line py-1">{(() => { const d = reportFor(docs, r.documentId, r.recommendationId); return d ? <ReportLink doc={d} patientId={patientId} encounterId={readOnly ? undefined : encounterId} /> : <span className="text-xs text-muted">—</span>; })()}</span>
              <span className="border-t border-line py-2"><button type="button" className="btn btn-ghost btn-icon !h-7 !w-7" aria-label={`Trend of ${r.test}`} title="All results of this test" onClick={() => setHistory(r.test)}><Icon name="chart" className="h-3.5 w-3.5" /></button></span>
            </div>); })}
        </div>)}
      {history !== null && <LabHistoryDrawer patientId={patientId} docs={docs} test={history || undefined} onClose={() => setHistory(null)} />}
      {adding && ordered && <div className="mt-3 rounded-[8px] border border-line p-3">{editor(() => setAdding(false))}</div>}
      {adding && !ordered && <Drawer title="Add lab values" subtitle="Typed from the report in hand. Units and ranges come from the clinic's list." onClose={() => setAdding(false)} width="max-w-2xl">
        <LabValuesEditor rows={draft} onChange={setDraft} params={params} />
        <div className="modal-foot"><button className="btn btn-ghost" onClick={() => setAdding(false)}>Cancel</button><button className="btn btn-primary" disabled={add.isPending || !draft.some((r) => r.test.trim() && r.value.trim())} onClick={() => add.mutate()}>Save values</button></div>
      </Drawer>}
    </div>
  );
}
