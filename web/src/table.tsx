import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { Floating, Icon, Skeleton, usePageSearch } from './ui';
import { listOut, qc, useMe } from './api';
import './table.css';

/** One column: what its cell shows, and optionally how it sorts and what it exports. */
export type Col<T> = {
  key: string; label: string; cell: (r: T) => ReactNode;
  sort?: (r: T) => string | number; csv?: (r: T) => string | number | null | undefined;
  align?: 'right'; className?: string; hideOnPhone?: boolean; fixed?: boolean; // fixed: never offered in Columns
};
/** A filter: options[0] means "no filter"; `initial` is where it starts (and where Reset returns).
 *  Without `test` the server applies it: the page reads the value with filterValue() and fetches; the menu then shows no counts. */
export type FilterDef<T> = { key: string; label: string; icon?: string; options: { value: string; label: string }[]; test?: (r: T, v: string) => boolean; initial?: string };
/** A "show the hidden ones" switch: while off, rows it `hides` are left out. */
export type ToggleDef<T> = { key: string; label: string; hides: (r: T) => boolean };

type Props<T> = {
  id: string; rows: T[]; rowKey: (r: T) => string; columns: Col<T>[];
  filters?: FilterDef<T>[]; toggles?: ToggleDef<T>[];
  search?: { placeholder: string; text?: (r: T) => (string | null | undefined)[] }; // no text: the page searches on the server
  onRow?: (r: T) => void; selected?: string | null; // a click on the row (not on its buttons); the row shown open beside the table
  toolbar?: ReactNode; exportable?: boolean; // extra controls after the filters (date pickers); false: the page has its own export
  server?: { total: number }; // rows are this page only; the page fetches with pageOf() and filterValue()
  sort?: { key: string; dir?: 1 | -1 };
  tabs?: { value: string; label: string; count?: number }[]; tab?: string; onTab?: (v: string) => void;
  bulk?: (picked: T[], clear: () => void) => ReactNode;
  loading?: boolean; empty?: { title: string; hint?: string };
  error?: unknown; onRetry?: () => void; // the fetch failed: say so, never "nothing found"
  pageSize?: number; exportName?: string;
};

const squash = (s: unknown) => String(s ?? '').toLowerCase().replace(/[\s-]/g, '');
const SIZES = [10, 25, 50];
/** What a filter is set to, for a page that applies it on the server. */
export const filterValue = (sp: URLSearchParams, f: FilterDef<any>) => sp.get(f.key) ?? f.initial ?? f.options[0].value;
/** The page and page size in the address, for a page that pages on the server. */
export const pageOf = (sp: URLSearchParams, size = 25) => ({ page: Math.max(1, Number(sp.get('p')) || 1), size: SIZES.includes(Number(sp.get('n'))) ? Number(sp.get('n')) : size });
const readHidden = (id: string): string[] => { try { return JSON.parse(localStorage.getItem(`dt-cols:${id}`) ?? '[]'); } catch { return []; } };

/** Rows to a .csv file the browser saves (with a BOM so Excel reads Telugu and ₹). */
export function downloadCsv(name: string, rows: unknown[][]) {
  const cell = (v: unknown) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + rows.map((l) => l.map(cell).join(',')).join('\r\n')], { type: 'text/csv' }));
  a.download = `${name}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** The app's one list table: tabs, filters, sort, pages, selection, Columns and Export.
 *  Page, sort, filters and switches live in the address, so Back and a shared link keep them; search is the header's box (?q=). */
export function DataTable<T>(p: Props<T>) {
  const [sp, setSp] = useSearchParams();
  const me = useMe();
  // lists of patients leave the app only for roles the owner allows (privacy.canExport), and every export is audited by the server first
  const canExport = p.exportable !== false && !!(me.data as any)?.privacy?.canExport;
  const failed = !!p.error && !p.loading;
  const retry = p.onRetry ?? (() => { qc.refetchQueries({ type: 'active' }); });
  const [q] = usePageSearch(p.search?.placeholder ?? '', !!p.search);
  const filters = p.filters ?? [], toggles = p.toggles ?? [];
  const fv = (f: FilterDef<T>) => sp.get(f.key) ?? f.initial ?? f.options[0].value;
  const tv = (t: ToggleDef<T>) => sp.get(t.key) === '1';
  const sortKey = sp.get('sort') ?? p.sort?.key ?? '';
  const dir = sp.has('dir') ? (sp.get('dir') === 'desc' ? -1 : 1) : (p.sort?.dir ?? 1);
  const size = SIZES.includes(Number(sp.get('n'))) ? Number(sp.get('n')) : (p.pageSize ?? 25);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [hidden, setHidden] = useState<string[]>(() => readHidden(p.id));
  const [open, setOpen] = useState<string | null>(null);
  const anchors = useRef<Record<string, HTMLButtonElement | null>>({});

  /** Write keys into the address; anything but a page turn goes back to page 1 and drops the ticked rows. */
  const write = (o: Record<string, string | null>, keepPage = false) => {
    setSp((prev) => { const n = new URLSearchParams(prev); for (const [k, v] of Object.entries(o)) v == null ? n.delete(k) : n.set(k, v); if (!keepPage) n.delete('p'); return n; }, { replace: true });
    if (!keepPage) setSel(new Set());
  };
  // another tab or search: drop the ticks; a new tab also starts on page 1 (after the page's own address change, never in the same tick)
  useEffect(() => { setSel(new Set()); }, [p.tab, q]);
  const firstTab = useRef(true);
  useEffect(() => { if (firstTab.current) { firstTab.current = false; return; } if (sp.has('p')) write({}); }, [p.tab]);

  const searched = useMemo(() => { const s = squash(q); return !s || !p.search?.text || p.server ? p.rows : p.rows.filter((r) => p.search!.text!(r).some((t) => squash(t).includes(s))); }, [p.rows, q]);
  const shown = searched.filter((r) => toggles.every((t) => tv(t) || !t.hides(r)));
  const passes = (r: T, skip?: string) => filters.every((f) => f.key === skip || !f.test || f.test(r, fv(f)));
  const col = p.columns.find((c) => c.key === sortKey && c.sort);
  const list = shown.filter((r) => passes(r));
  if (col && !p.server) list.sort((a, b) => { const x = col.sort!(a), y = col.sort!(b); return (x < y ? -1 : x > y ? 1 : 0) * dir; });
  const total = p.server ? p.server.total : list.length, pages = Math.max(1, Math.ceil(total / size));
  const page = Math.min(Math.max(1, Number(sp.get('p')) || 1), pages);
  const slice = p.server ? list : list.slice((page - 1) * size, page * size);
  const hiddenByFilters = p.server ? 0 : shown.length - total;
  const cols = p.columns.filter((c) => c.fixed || !hidden.includes(c.key));
  const picked = p.rows.filter((r) => sel.has(p.rowKey(r)));
  const allOn = slice.length > 0 && slice.every((r) => sel.has(p.rowKey(r)));
  const dirty = filters.some((f) => fv(f) !== (f.initial ?? f.options[0].value)) || toggles.some(tv);
  const reset = () => write(Object.fromEntries([...filters.map((f) => [f.key, null]), ...toggles.map((t) => [t.key, null])]));
  const go = (n: number) => write({ p: n > 1 ? String(n) : null }, true);

  const saveHidden = (h: string[]) => { setHidden(h); try { localStorage.setItem(`dt-cols:${p.id}`, JSON.stringify(h)); } catch { /* private window: the choice lasts this visit */ } };
  const exportCsv = () => { const ec = cols.filter((c) => c.csv || c.sort); downloadCsv(p.exportName ?? p.id, [ec.map((c) => c.label), ...list.map((r) => ec.map((c) => (c.csv ?? c.sort)!(r)))]); };
  // the server checks the role and writes the audit record; a refusal shows as a message, nothing is downloaded
  const exportGuarded = () => listOut(`Downloaded the ${p.exportName ?? p.id} list (${list.length} row${list.length === 1 ? '' : 's'})`, list.length, exportCsv);
  // page numbers: the first, the last, and the two either side of this one
  const nums = Array.from({ length: pages }, (_, i) => i + 1).filter((n) => n === 1 || n === pages || Math.abs(n - page) <= 1);
  const offerable = p.columns.filter((c) => !c.fixed && c.label);
  const ref = (k: string) => (el: HTMLButtonElement | null) => { anchors.current[k] = el; };
  const anchorOf = (k: string) => ({ current: anchors.current[k] ?? null });

  return (
    <section className="dt">
      {p.tabs && <div className="dt-tabs" role="tablist">{p.tabs.map((t) => (
        <button key={t.value} type="button" role="tab" aria-selected={p.tab === t.value} className={p.tab === t.value ? 'on' : ''} onClick={() => p.onTab?.(t.value)}>{t.label}{t.count != null && <span className="c">{t.count}</span>}</button>))}</div>}

      {picked.length > 0 && p.bulk ? (
        <div className="dt-bulk"><b>{picked.length} selected</b>{p.bulk(picked, () => setSel(new Set()))}<div className="flex-1" /><button type="button" className="dt-link" onClick={() => setSel(new Set())}>Clear selection</button></div>
      ) : (filters.length > 0 || toggles.length > 0 || offerable.length > 0 || p.toolbar) && (
        <div className="dt-tool">
          {filters.map((f) => {
            const v = fv(f), set = v !== f.options[0].value, cur = f.options.find((o) => o.value === v) ?? f.options[0];
            const base = shown.filter((r) => passes(r, f.key));
            return (
              <span key={f.key} className={`dt-tok ${set ? 'set' : 'off'}`}>
                <button ref={ref(f.key)} type="button" aria-haspopup="menu" aria-expanded={open === f.key} onClick={() => setOpen(open === f.key ? null : f.key)}>
                  <Icon name={f.icon ?? 'filter'} className="h-3.5 w-3.5 opacity-70" />{f.label}{set && <><span className="sep" /><span className="v">{cur.label}</span></>}
                </button>
                {set && <button type="button" className="x" aria-label={`Remove the ${f.label} filter`} onClick={() => write({ [f.key]: f.options[0].value === (f.initial ?? f.options[0].value) ? null : f.options[0].value })}>×</button>}
                <Floating anchor={anchorOf(f.key)} open={open === f.key} onClose={() => setOpen(null)} align="left">
                  <div role="menu" className="menu-list">{f.options.map((o) => (
                    <button key={o.value} type="button" role="menuitemradio" aria-checked={o.value === v} onClick={() => { setOpen(null); write({ [f.key]: o.value === (f.initial ?? f.options[0].value) ? null : o.value }); }}>
                      <Icon name="check" className={`h-4 w-4 text-clay ${o.value === v ? '' : 'invisible'}`} /><span className="flex-1">{o.label}</span>{f.test && !p.server && <span className="text-[12px] font-medium text-muted">{base.filter((r) => f.test!(r, o.value)).length}</span>}
                    </button>))}</div>
                </Floating>
              </span>);
          })}
          {toggles.map((t) => <label key={t.key} className="dt-ghost"><input type="checkbox" className="dt-cb" checked={tv(t)} onChange={(e) => write({ [t.key]: e.target.checked ? '1' : null })} />{t.label}<span className="text-muted">({searched.filter(t.hides).length})</span></label>)}
          {p.toolbar}
          {dirty && <button type="button" className="dt-link ml-1" onClick={reset}>Reset</button>}
          <div className="flex-1" />
          {offerable.length > 0 && <>
            <button ref={ref('_cols')} type="button" className="dt-ghost" aria-haspopup="menu" aria-expanded={open === '_cols'} onClick={() => setOpen(open === '_cols' ? null : '_cols')}><Icon name="list" className="h-3.5 w-3.5 text-muted" />Columns</button>
            <Floating anchor={anchorOf('_cols')} open={open === '_cols'} onClose={() => setOpen(null)}>
              <div className="menu-list">{offerable.map((c) => (
                <label key={c.key} className="flex cursor-pointer items-center gap-2.5 rounded-[12px] px-3 py-2 text-[13.5px] font-semibold hover:bg-ink/6"><input type="checkbox" className="dt-cb" checked={!hidden.includes(c.key)} onChange={() => saveHidden(hidden.includes(c.key) ? hidden.filter((k) => k !== c.key) : [...hidden, c.key])} />{c.label}</label>))}</div>
            </Floating>
          </>}
          {canExport && <button type="button" className="dt-ghost" onClick={exportGuarded} disabled={!list.length} title={p.server ? 'Download this page as a spreadsheet (CSV)' : 'Download what is shown, every page, as a spreadsheet (CSV)'}><Icon name="download" className="h-3.5 w-3.5 text-muted" />Export</button>}
        </div>
      )}

      {failed && total > 0 && <div role="alert" className="flex flex-wrap items-center gap-2 border-b border-line bg-amber-soft px-5 py-2 text-[13px] font-semibold text-amber">Couldn't refresh this list. What you see may be out of date.<button type="button" className="dt-link" onClick={retry}>Retry</button></div>}
      {p.loading ? <Skeleton rows={5} /> : failed && total === 0 ? (
        <div className="px-5 py-14 text-center" role="alert">
          <div className="text-[15px] font-bold">Couldn't load. Check the internet and try again.</div>
          <button type="button" className="dt-ghost mt-3" onClick={retry}>Retry</button>
        </div>
      ) : total === 0 ? (
        <div className="px-5 py-14 text-center">
          <div className="text-[15px] font-bold">{hiddenByFilters > 0 ? 'Nothing matches these filters' : p.empty?.title ?? 'Nothing here'}</div>
          {(hiddenByFilters > 0 || p.empty?.hint) && <div className="mt-1 text-[13px] text-muted">{hiddenByFilters > 0 ? `${hiddenByFilters} hidden by the filters` : p.empty?.hint}</div>}
          {hiddenByFilters > 0 && <button type="button" className="dt-ghost mt-3" onClick={() => write(Object.fromEntries(filters.map((f) => [f.key, f.options[0].value === (f.initial ?? f.options[0].value) ? null : f.options[0].value])))}>Show all</button>}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="dt-table">
            <thead><tr>
              {p.bulk && <th className="chk"><input type="checkbox" className="dt-cb" aria-label="Select every row on this page" checked={allOn} onChange={() => setSel((s) => { const n = new Set(s); slice.forEach((r) => allOn ? n.delete(p.rowKey(r)) : n.add(p.rowKey(r))); return n; })} /></th>}
              {cols.map((c) => <th key={c.key} className={c.align === 'right' ? 'r' : ''} aria-sort={sortKey === c.key ? (dir > 0 ? 'ascending' : 'descending') : undefined}>
                {c.sort ? <button type="button" className={sortKey === c.key ? 'on' : ''} onClick={() => write({ sort: c.key, dir: sortKey === c.key && dir > 0 ? 'desc' : 'asc' })}>{c.label}
                  <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d={sortKey !== c.key ? 'M8 9l4-4 4 4M8 15l4 4 4-4' : dir > 0 ? 'M8 14l4-4 4 4' : 'M8 10l4 4 4-4'} /></svg></button> : c.label}
              </th>)}
            </tr></thead>
            <tbody>{slice.map((r) => { const k = p.rowKey(r), on = sel.has(k); return (
              <tr key={k} className={`${on || p.selected === k ? 'sel' : ''} ${p.onRow ? 'cursor-pointer' : ''}`} onClick={p.onRow ? (e) => { if (!(e.target as HTMLElement).closest('button,a,input,select,label,textarea')) p.onRow!(r); } : undefined}>
                {p.bulk && <td className="chk"><input type="checkbox" className="dt-cb" aria-label="Select this row" checked={on} onChange={() => setSel((s) => { const n = new Set(s); on ? n.delete(k) : n.add(k); return n; })} /></td>}
                {cols.map((c, i) => <td key={c.key} className={`${i === 0 ? 'dt-first' : ''} ${c.align === 'right' ? 'r' : ''} ${c.hideOnPhone ? 'dt-hide-phone' : ''} ${c.className ?? ''}`}>{c.cell(r)}</td>)}
              </tr>); })}</tbody>
          </table>
        </div>
      )}

      {!p.loading && total > 0 && (
        <div className="dt-foot">
          <span>Showing <b>{(page - 1) * size + 1}–{Math.min(total, page * size)}</b> of <b>{total}</b></span>
          {hiddenByFilters > 0 && <button type="button" className="dt-link" onClick={() => write(Object.fromEntries(filters.map((f) => [f.key, f.options[0].value === (f.initial ?? f.options[0].value) ? null : f.options[0].value])))}>+ {hiddenByFilters} hidden by filters</button>}
          <div className="flex-1" />
          <label className="inline-flex items-center gap-2">Rows per page<select className="dt-select" value={size} onChange={(e) => write({ n: Number(e.target.value) === (p.pageSize ?? 25) ? null : e.target.value })}>{SIZES.map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
          {pages > 1 && <>
            <span>Page <b>{page}</b> of {pages}</span>
            <nav aria-label="Pages" className="flex gap-1">
              <button type="button" className="dt-pg" aria-label="First page" disabled={page === 1} onClick={() => go(1)}>«</button>
              <button type="button" className="dt-pg" aria-label="Previous page" disabled={page === 1} onClick={() => go(page - 1)}>‹</button>
              {nums.map((n, i) => <span key={n} className="contents">{i > 0 && n - nums[i - 1] > 1 && <span className="self-center px-1 text-muted">…</span>}<button type="button" className={`dt-pg ${n === page ? 'on' : ''}`} aria-current={n === page ? 'page' : undefined} onClick={() => go(n)}>{n}</button></span>)}
              <button type="button" className="dt-pg" aria-label="Next page" disabled={page === pages} onClick={() => go(page + 1)}>›</button>
              <button type="button" className="dt-pg" aria-label="Last page" disabled={page === pages} onClick={() => go(pages)}>»</button>
            </nav>
          </>}
        </div>
      )}
    </section>
  );
}
