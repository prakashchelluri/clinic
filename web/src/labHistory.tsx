import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, ChevronRight, FileText, Star } from 'lucide-react';
import { Chip, Icon, ask, fmtDate, toast } from './ui';
import { errText } from './api';
import { useLabResults, isOut, rangeText, saveLabValues, reportFor, type LabRow } from './labs';
import { openViewer } from './viewer';

/** A value copied into a later consultation is the same reading: count it once in history and trends. */
export const dedupe = (rows: LabRow[]) => [...new Map(rows.map((r) => [`${r.test}|${r.takenOn}|${r.value}`, r])).values()];
/** The rows typed from this file: by the file itself, else by the ordered test it was uploaded for. */
export const valuesOf = (doc: any, rows: LabRow[]) => dedupe(rows.filter((r) => r.documentId === doc.id || (!r.documentId && r.recommendationId && (doc.recommendationIds ?? [doc.recommendationId]).includes(r.recommendationId))));

// ponytail: stars live in this browser (the doctor's desk); move to clinic settings if more than one desk needs them
const STARS = 'lab-stars';
const readStars = (): string[] => { try { return JSON.parse(localStorage.getItem(STARS) ?? '[]'); } catch { return []; } };
const Arrow = ({ flag }: { flag: LabRow['flag'] }) => flag === 'high' ? <ArrowUp className="inline h-3.5 w-3.5" aria-label="high" /> : flag === 'low' ? <ArrowDown className="inline h-3.5 w-3.5" aria-label="low" /> : null;
const Reading = ({ r, doc }: { r?: LabRow; doc?: any }) => !r ? <span className="text-muted">—</span> : (
  <span className={`inline-flex items-center gap-1 ${isOut(r.flag) ? 'font-semibold text-rose' : ''}`}>
    {doc ? <button type="button" className="text-muted hover:text-ink" aria-label={`Open the report for ${r.test} on ${fmtDate(r.takenOn)}`} title={doc.title} onClick={(e) => { e.stopPropagation(); openViewer({ docs: [doc] }); }}><FileText className="h-3.5 w-3.5" /></button> : null}
    {r.value}{r.unit ? <span className="text-xs font-normal"> {r.unit}</span> : ''}<Arrow flag={r.flag} />
    <span className="ml-1 text-xs font-normal text-muted">{fmtDate(r.takenOn)}</span>
  </span>);

/** Every test the patient has had: latest and the two before, starred ones on top; a row opens its trend. Opens over the page from the right. */
export function LabHistoryDrawer({ patientId, docs, test: first, onClose }: { patientId: string; docs: any[]; test?: string; onClose: () => void }) {
  const q = useLabResults(patientId);
  const [find, setFind] = useState(''); const [test, setTest] = useState<string | null>(first ?? null); const [stars, setStars] = useState(readStars);
  const star = (t: string) => { const s = stars.includes(t) ? stars.filter((x) => x !== t) : [...stars, t]; setStars(s); try { localStorage.setItem(STARS, JSON.stringify(s)); } catch { /* private mode */ } };
  const byTest = useMemo(() => {
    const m = new Map<string, LabRow[]>();
    for (const r of dedupe(q.data ?? [])) m.set(r.test, [...(m.get(r.test) ?? []), r]);
    for (const xs of m.values()) xs.sort((a, b) => b.takenOn.localeCompare(a.takenOn));
    return [...m].sort(([a, x], [b, y]) => Number(stars.includes(b)) - Number(stars.includes(a)) || Number(isOut(y[0].flag)) - Number(isOut(x[0].flag)) || a.localeCompare(b));
  }, [q.data, stars]);
  const rows = byTest.filter(([t]) => t.toLowerCase().includes(find.trim().toLowerCase()));
  const docOf = (r: LabRow) => reportFor(docs, r.documentId, r.recommendationId) ?? undefined;
  return createPortal(
    <aside role="dialog" aria-label="Test results history" className="side-drawer" style={{ width: 'min(860px, 100vw)', zIndex: 45 }} onKeyDown={(e) => e.key === 'Escape' && (test ? setTest(null) : onClose())}>
      <div className="flex items-center gap-2">
        {test && <button className="btn btn-ghost btn-icon" aria-label="Back to all tests" onClick={() => setTest(null)}><Icon name="chevL" /></button>}
        <h2 className="text-[18px] font-semibold">{test ?? 'Test results history'}</h2>
        <button className="btn btn-ghost btn-icon ml-auto" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
      </div>
      {test ? <Trend rows={byTest.find(([t]) => t === test)?.[1] ?? []} docOf={docOf} /> : <>
        <input autoFocus className="input" placeholder="Search a test" aria-label="Search a test" value={find} onChange={(e) => setFind(e.target.value)} />
        {q.isLoading ? <div className="text-sm text-muted">Loading…</div> : byTest.length === 0 ? <div className="text-sm text-muted">No values have been typed for this patient yet. Values come from the report form when a report arrives.</div> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-[13.5px]">
              <thead><tr className="text-left text-[11.5px] font-semibold text-muted"><th className="py-2 pr-2">Test</th><th className="pr-2">Latest</th><th className="pr-2">Before</th><th className="pr-2">Before that</th><th className="w-8"><span className="sr-only">Trend</span></th></tr></thead>
              <tbody>{rows.map(([t, xs]) => (
                <tr key={t} className="cursor-pointer border-t border-line hover:bg-surface-2/60" onClick={() => setTest(t)}>
                  <td className="py-2 pr-2"><span className="inline-flex items-center gap-1.5">
                    <button type="button" aria-pressed={stars.includes(t)} aria-label={stars.includes(t) ? `Unstar ${t}` : `Star ${t}: keep it on top`} onClick={(e) => { e.stopPropagation(); star(t); }}><Star className={`h-4 w-4 ${stars.includes(t) ? 'fill-amber text-amber' : 'text-muted'}`} /></button>
                    <span className="font-medium">{t}</span>{xs.length > 1 && <span className="text-xs text-muted">· {xs.length}</span>}</span></td>
                  {[0, 1, 2].map((i) => <td key={i} className="pr-2"><Reading r={xs[i]} doc={xs[i] ? docOf(xs[i]) : undefined} /></td>)}
                  <td><button type="button" className="btn btn-ghost btn-icon !h-7 !w-7" aria-label={`Trend of ${t}`}><ChevronRight className="h-4 w-4" /></button></td>
                </tr>))}</tbody>
            </table>
            {rows.length === 0 && <div className="py-3 text-sm text-muted">No test matches “{find}”.</div>}
          </div>)}
      </>}
    </aside>, document.body);
}

/** One test over time: a line with the normal band shaded, then every reading with its report. Words (Negative, Reactive) skip the chart. */
function Trend({ rows, docOf }: { rows: LabRow[]; docOf: (r: LabRow) => any }) {
  const nums = [...rows].filter((r) => r.num !== null).sort((a, b) => a.takenOn.localeCompare(b.takenOn));
  const r0 = rows[0];
  const W = 760, H = 220, L = 44, R = 16, T = 14, B = 30;
  const t = (d: string) => new Date(d + 'T00:00:00').getTime();
  const lo = Math.min(...nums.map((r) => r.num!), r0?.low ?? Infinity), hi = Math.max(...nums.map((r) => r.num!), r0?.high ?? -Infinity);
  const pad = (hi - lo) * 0.15 || Math.abs(hi) * 0.1 || 1; const y0 = lo - pad, y1 = hi + pad;
  const t0 = nums.length ? t(nums[0].takenOn) : 0, t1 = nums.length ? t(nums[nums.length - 1].takenOn) : 0;
  const x = (d: string) => (t1 === t0 ? (L + W - R) / 2 : L + ((t(d) - t0) / (t1 - t0)) * (W - L - R));
  const y = (v: number) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
  const ticks = [y0 + (y1 - y0) * 0.1, (y0 + y1) / 2, y1 - (y1 - y0) * 0.1].map((v) => Number(v.toPrecision(3)));
  return (
    <div className="space-y-4">
      <div className="text-sm text-muted">{[r0?.unit, rangeText(r0) ? `normal ${rangeText(r0)}` : '', `${rows.length} reading${rows.length === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}</div>
      {nums.length > 1 && <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`Trend: ${nums.map((r) => `${r.value} on ${fmtDate(r.takenOn)}`).join(', ')}`}>
        {r0?.low !== null && r0?.high !== null && <rect x={L} width={W - L - R} y={y(r0.high!)} height={y(r0.low!) - y(r0.high!)} fill="var(--color-sage)" opacity=".12" />}
        {ticks.map((v) => <g key={v}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="var(--color-line)" /><text x={L - 6} y={y(v) + 4} textAnchor="end" fontSize="11" fill="var(--color-muted)">{v}</text></g>)}
        <polyline points={nums.map((r) => `${x(r.takenOn)},${y(r.num!)}`).join(' ')} fill="none" stroke="var(--color-ink-2)" strokeWidth="1.5" />
        {nums.map((r) => <g key={r.id}><circle cx={x(r.takenOn)} cy={y(r.num!)} r="4.5" fill={isOut(r.flag) ? 'var(--color-rose)' : 'var(--color-sage)'}><title>{`${r.value} · ${fmtDate(r.takenOn)}`}</title></circle>
          <text x={x(r.takenOn)} y={H - 10} textAnchor="middle" fontSize="11" fill="var(--color-muted)">{fmtDate(r.takenOn)}</text></g>)}
      </svg>}
      <div className="divide-y divide-line">{rows.map((r) => { const d = docOf(r); return (
        <div key={r.id} className="flex items-center gap-3 py-2 text-sm">
          <span className="w-24 shrink-0 text-muted">{fmtDate(r.takenOn)}</span>
          <span className={`flex-1 ${isOut(r.flag) ? 'font-semibold text-rose' : ''}`}>{r.value}{r.unit ? ` ${r.unit}` : ''} <Arrow flag={r.flag} />{r.note && <span className="ml-2 text-xs font-normal text-muted">{r.note}</span>}</span>
          {r.flag && <Chip tone={isOut(r.flag) ? 'rose' : 'sage'}>{r.flag === 'normal' ? 'ok' : r.flag}</Chip>}
          {d ? <button className="btn btn-ghost btn-sm" onClick={() => openViewer({ docs: [d] })}><FileText className="h-3.5 w-3.5" />Report</button> : <span className="w-[74px] text-xs text-muted">typed</span>}
        </div>); })}</div>
    </div>
  );
}

/** Beside a report in the viewer: the values typed from it, out-of-range first; tick and copy them into this consultation's Lab results. */
export function ReportValues({ doc, patientId, encounterId }: { doc: any; patientId: string; encounterId?: string }) {
  const q = useLabResults(patientId);
  const vals = valuesOf(doc, q.data ?? []).sort((a, b) => Number(isOut(b.flag)) - Number(isOut(a.flag)) || a.test.localeCompare(b.test));
  const [onlyOut, setOnlyOut] = useState(false); const [ticked, setTicked] = useState<string[]>([]); const [busy, setBusy] = useState(false);
  const outN = vals.filter((v) => isOut(v.flag)).length;
  const shown = onlyOut ? vals.filter((v) => isOut(v.flag)) : vals;
  const here = new Set((q.data ?? []).filter((r) => r.encounterId === encounterId).map((r) => `${r.test}|${r.takenOn}|${r.value}`));
  const copy = async (rows: LabRow[]) => {
    const fresh = rows.filter((r) => !here.has(`${r.test}|${r.takenOn}|${r.value}`));
    if (!fresh.length) { toast('Already in this consultation', 'info'); return; }
    if (fresh.length > 10 && !(await ask({ title: `Copy all ${fresh.length} values into this prescription?`, confirmLabel: 'Copy', cancelLabel: 'Go back' }))) return;
    setBusy(true);
    try {
      // one call per date: the reading keeps the day it was taken, not today
      for (const day of new Set(fresh.map((r) => r.takenOn))) await saveLabValues({ patientId, encounterId, documentId: doc.id, takenOn: day, rows: fresh.filter((r) => r.takenOn === day).map((r) => ({ test: r.test, value: r.value, note: r.note ?? '' })) });
      toast(`${fresh.length} value${fresh.length === 1 ? '' : 's'} added to Lab results`); setTicked([]);
    } catch (e) { toast(errText(e), 'err'); } finally { setBusy(false); }
  };
  if (q.isLoading) return <div className="p-3 text-sm text-muted">Loading…</div>;
  if (!vals.length) return <div className="p-3 text-sm text-muted">No values were typed from this report.</div>;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex gap-1.5 p-2" role="group" aria-label="Show">
        <button type="button" className={`toggle-opt !py-1 !text-xs ${onlyOut ? '' : 'on'}`} aria-pressed={!onlyOut} onClick={() => setOnlyOut(false)}>All ({vals.length})</button>
        <button type="button" className={`toggle-opt !py-1 !text-xs ${onlyOut ? 'on' : ''}`} aria-pressed={onlyOut} disabled={!outN} onClick={() => setOnlyOut(true)}>Out of range ({outN})</button>
      </div>
      <div className="min-h-0 flex-1 divide-y divide-line overflow-y-auto px-2">{shown.map((v) => (
        <label key={v.id} className="flex items-start gap-2 py-2 text-[13px]">
          {encounterId && <input type="checkbox" className="mt-0.5 accent-ink" checked={ticked.includes(v.id)} onChange={() => setTicked(ticked.includes(v.id) ? ticked.filter((x) => x !== v.id) : [...ticked, v.id])} />}
          <span className="min-w-0 flex-1"><span className="block truncate font-medium">{v.test}</span><span className="text-xs text-muted">{[rangeText(v), v.unit].filter(Boolean).join(' ')}</span></span>
          <span className={`text-right ${isOut(v.flag) ? 'font-semibold text-rose' : ''}`}>{v.value}<span className="block text-xs font-normal">{v.flag && v.flag !== 'normal' ? <><Arrow flag={v.flag} /> {v.flag}</> : v.flag ? <span className="text-muted">ok</span> : ''}</span></span>
        </label>))}</div>
      {encounterId && <div className="flex gap-1.5 border-t border-line p-2">
        <button className="btn btn-sm flex-1" disabled={busy} onClick={() => copy(vals)}>Copy all to Rx</button>
        <button className="btn btn-sm btn-primary flex-1" disabled={busy || !ticked.length} onClick={() => copy(vals.filter((v) => ticked.includes(v.id)))}>Copy {ticked.length || ''} ticked</button>
      </div>}
    </div>
  );
}

const KINDS: [string, string][] = [['', 'All'], ['report', 'Lab reports'], ['prescription', 'Prescriptions'], ['consent', 'Consents'], ['other', 'Other']];
/** The patient's files by month, with what each one holds: which tests, how many out of range. A tap opens it with its values beside. */
export function ReportList({ docs, patientId, encounterId, who, onDelete }: { docs: any[]; patientId: string; encounterId?: string; who?: string; onDelete?: (id: string) => void }) {
  const q = useLabResults(patientId); const all = q.data ?? [];
  const [kind, setKind] = useState('');
  const kinds = KINDS.filter(([k]) => !k || docs.some((d) => d.kind === k));
  // a report is dated by the day the test was taken (its values), else the day it was added
  const dayOf = (d: any): string => valuesOf(d, all)[0]?.takenOn ?? d.createdAt;
  const list = docs.filter((d) => !kind || d.kind === kind).sort((a, b) => dayOf(b).localeCompare(dayOf(a)));
  const months = [...list.reduce((m, d) => { const k = new Date(dayOf(d).length === 10 ? dayOf(d) + 'T00:00:00' : dayOf(d)).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }); return m.set(k, [...(m.get(k) ?? []), d]); }, new Map<string, any[]>())];
  const open = (d: any) => openViewer({ docs: list, index: list.indexOf(d), who, canDelete: !!onDelete, patientId, encounterId });
  return (
    <div className="space-y-3">
      {kinds.length > 2 && <div className="flex flex-wrap gap-1.5" role="group" aria-label="Show">{kinds.map(([k, l]) => <button key={k} type="button" aria-pressed={kind === k} className={`toggle-opt !py-1 !text-xs ${kind === k ? 'on' : ''}`} onClick={() => setKind(k)}>{l}{k && ` (${docs.filter((d) => d.kind === k).length})`}</button>)}</div>}
      {months.map(([m, ds]) => (
        <div key={m}>
          <div className="mb-1.5 text-[11.5px] font-bold uppercase tracking-wider text-muted">{m}</div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">{ds.map((d: any) => { const v = valuesOf(d, all); const outN = v.filter((x) => isOut(x.flag)).length; const tests = [...new Set(v.map((x) => x.test))]; return (
            <div key={d.id} role="button" tabIndex={0} aria-label={`Open ${d.title}`} onClick={() => open(d)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(d); } }} className="card card-hover group flex cursor-pointer items-center gap-2.5 !p-2">
              {d.mime.startsWith('image/') ? <img src={`/api/documents/${d.id}/file`} alt="" className="h-12 w-12 shrink-0 rounded-lg bg-paper-2 object-cover" loading="lazy" /> : <div className="grid h-12 w-12 shrink-0 place-items-center rounded-lg bg-clay-soft text-[10px] font-bold text-clay">PDF</div>}
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">{d.title}</div>
                <div className="truncate text-[11.5px] text-muted">{fmtDate(dayOf(d))} · {KINDS.find(([k]) => k === d.kind)?.[1].replace(/s$/, '') ?? d.kind}{tests.length ? ` · ${tests.slice(0, 3).join(', ')}${tests.length > 3 ? ` +${tests.length - 3}` : ''}` : ''}</div>
                {d.note && <div className="truncate text-[11.5px] text-ink-2">{d.note}</div>}
              </div>
              {outN > 0 ? <Chip tone="rose">{outN} out of range</Chip> : v.length > 0 ? <Chip tone="sage">all normal</Chip> : null}
              {onDelete && <button aria-label={`Remove ${d.title}`} className="btn btn-ghost btn-icon opacity-0 group-hover:opacity-100 focus:opacity-100" onClick={(e) => { e.stopPropagation(); onDelete(d.id); }}><Icon name="x" className="h-3.5 w-3.5" /></button>}
            </div>); })}</div>
        </div>))}
      {list.length === 0 && <div className="text-sm text-muted">No files of this kind.</div>}
    </div>
  );
}
