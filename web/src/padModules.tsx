// Custom modules on the Rx pad, as Tatva has them. "+ Add custom module" opens a drawer with two tabs:
// Select existing module (the clinic's list, Add to Rx) and Create new module (a name, 1–4 columns, their labels,
// and what to know first). On the pad a module is a small table: a line per entry, + Add new line.
import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { History as HistoryIcon, Info, Lock } from 'lucide-react';
import { get, patch, post, del, qc, errText } from './api';
import { Drawer, Floating, Icon, Tabs, ask, toast, fmtDate } from './ui';

export type PadModule = { id: string; name: string; columns: string[]; used: boolean; createdBy: string | null; createdByName: string | null; onPad: boolean; canEdit: boolean };
/** What a pad keeps for a module: its name and columns as they were (so a past pad reads the same), and the lines. */
export type ModuleData = { name: string; columns: string[]; rows: string[][] };

export const usePadModules = (enabled = true) => useQuery<PadModule[]>({ queryKey: ['pad-modules'], queryFn: () => get('/pad-modules'), enabled, staleTime: 60_000 });
export const filledRows = (m?: ModuleData | null) => (m?.rows ?? []).filter((r) => r.some((c) => String(c ?? '').trim()));
const two = (n: number) => String(n).padStart(2, '0');
const refresh = () => qc.invalidateQueries({ queryKey: ['pad-modules'] });

/** Put a module on my pad, or take it off. */
export async function setOnPad(m: { id: string; name: string }, on: boolean) {
  try { await post(`/pad-modules/${m.id}/pad`, { on }); refresh(); toast(on ? `“${m.name}” is on your pad` : `“${m.name}” is off your pad`); }
  catch (e) { toast(errText(e), 'err'); }
}
export async function deleteModule(m: { id: string; name: string }) {
  if (!(await ask({ title: `Delete “${m.name}”?`, body: 'It goes from the list for every doctor. It has not been used on any pad yet, so nothing written is lost.', confirmLabel: 'Delete', tone: 'danger' }))) return;
  try { await del(`/pad-modules/${m.id}`); refresh(); toast(`“${m.name}” deleted`); } catch (e) { toast(errText(e), 'err'); }
}

/** The module on the pad: a line per entry, a box per column. */
export function ModuleTable({ mod, readOnly, onChange }: { mod: ModuleData; readOnly?: boolean; onChange: (rows: string[][]) => void }) {
  const cols = mod.columns; const blank = () => cols.map(() => '');
  const rows = readOnly ? filledRows(mod) : mod.rows?.length ? mod.rows : [blank()];
  const setCell = (i: number, j: number, v: string) => onChange(rows.map((r, k) => (k === i ? cols.map((_, c) => (c === j ? v : r[c] ?? '')) : r)));
  if (readOnly && !filledRows(mod).length) return <div className="text-xs text-muted">Nothing written.</div>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full table-fixed border-collapse text-[14.5px]">
        <thead><tr className="text-left text-[12.5px] text-muted">{cols.map((c) => <th key={c} className="px-1 pb-1.5 font-semibold">{c}</th>)}{!readOnly && <th className="w-9" />}</tr></thead>
        <tbody>{rows.map((r, i) => (
          <tr key={i} className="border-t border-line">
            {cols.map((c, j) => <td key={c} className="px-1 py-1.5">{readOnly ? <span className="whitespace-pre-wrap">{r[j] ?? ''}</span>
              : <input aria-label={`${mod.name} line ${i + 1}: ${c}`} className="cell-in w-full" maxLength={200} placeholder={c} value={r[j] ?? ''} onChange={(ev) => setCell(i, j, ev.target.value)} />}</td>)}
            {!readOnly && <td className="text-center"><button type="button" className="btn btn-ghost btn-icon !h-7 !w-7" aria-label={`Remove line ${i + 1}`} onClick={() => onChange(rows.filter((_, k) => k !== i))}><Icon name="x" className="h-3.5 w-3.5" /></button></td>}
          </tr>))}
        </tbody>
      </table>
      {!readOnly && rows.length < 30 && <button type="button" className="mt-1.5 inline-flex items-center gap-1.5 text-[13.5px] font-semibold text-clay hover:underline" onClick={() => onChange([...rows, blank()])}><Icon name="plus" className="h-3.5 w-3.5" />Add new line</button>}
    </div>
  );
}

/** Load prev. data: this module's lines from an earlier visit. */
export function ModuleLoadPrev({ id, previous, onLoad }: { id: string; previous: any[]; onLoad: (rows: string[][]) => void }) {
  const [open, setOpen] = useState(false); const [sel, setSel] = useState<string | null>(null); const btn = useRef<HTMLButtonElement>(null);
  const done = previous.filter((x) => x.status === 'completed' && filledRows(x.data?.modules?.[id]).length > 0);
  const e = done.find((x) => x.id === sel) ?? done[0];
  const cls = 'btn btn-ghost !min-h-7 gap-1 !px-2 text-[12px] text-muted hover:text-ink';
  if (!done.length) return <button type="button" className={cls} disabled title="No earlier visit has this module filled"><HistoryIcon className="h-3.5 w-3.5" aria-hidden />Load prev. data</button>;
  return (
    <>
      <button ref={btn} type="button" className={cls} aria-expanded={open} onClick={() => setOpen(!open)}><HistoryIcon className="h-3.5 w-3.5" aria-hidden />Load prev. data</button>
      <Floating anchor={btn} open={open} onClose={() => setOpen(false)} width={420}>
        <div className="p-2">
          <div className="max-h-40 space-y-1 overflow-y-auto">{done.slice(0, 10).map((x) => <button key={x.id} type="button" className={`w-full rounded-md border px-2.5 py-1.5 text-left text-[12.5px] ${e?.id === x.id ? 'border-ink bg-surface-2' : 'border-line hover:bg-surface-2'}`} onClick={() => setSel(x.id)}><b>{fmtDate(x.createdAt)}</b> <span className="text-muted">{x.doctor?.name ?? ''}</span></button>)}</div>
          {e && <div className="mt-2 rounded-md border border-line bg-surface-2 p-2.5 text-[12.5px] leading-relaxed">{filledRows(e.data.modules[id]).map((r, k) => <div key={k}>{r.filter(Boolean).join(' · ')}</div>)}</div>}
          <div className="mt-2 flex"><button type="button" className="btn btn-sm btn-primary ml-auto" disabled={!e} onClick={() => { onLoad(filledRows(e.data.modules[id])); setOpen(false); }}>Load</button></div>
        </div>
      </Floating>
    </>
  );
}

/** The ⓘ by a module's name: who made it, and that it is locked once used. */
export const ModuleInfo = ({ m }: { m?: PadModule }) => m ? <span className="inline-flex text-muted" title={`Module created by ${m.createdByName ?? 'a former user'}${m.used ? ' · locked: it has been used on a prescription' : ''}`}><Info className="h-4 w-4" aria-label="About this module" /></span> : null;

/** + Add custom module: pick one the clinic already has, or create a new one. */
export function AddModuleDrawer({ onClose, editing: edit0 }: { onClose: () => void; editing?: PadModule | null }) {
  const list = usePadModules();
  const [tab, setTab] = useState<'existing' | 'new'>(edit0 ? 'new' : 'existing');
  const [q, setQ] = useState(''); const [more, setMore] = useState<string | null>(null);
  const [editing, setEditing] = useState<PadModule | null>(edit0 ?? null);
  const [name, setName] = useState(edit0?.name ?? ''); const [n, setN] = useState(edit0?.columns.length ?? 2);
  const [labels, setLabels] = useState<string[]>(edit0 ? [...edit0.columns, '', '', ''].slice(0, 4) : ['', '', '', '']);
  const [busy, setBusy] = useState(false);
  const startEdit = (m: PadModule) => { setEditing(m); setName(m.name); setN(m.columns.length); setLabels([...m.columns, '', '', ''].slice(0, 4)); setTab('new'); };
  const startNew = () => { setEditing(null); setName(''); setN(2); setLabels(['', '', '', '']); };
  const cols = labels.slice(0, n).map((x) => x.trim());
  const filled = cols.filter(Boolean).map((c) => c.toLowerCase()); const dupCol = new Set(filled).size !== filled.length;
  const ready = name.trim().length >= 2 && cols.every(Boolean) && !dupCol;
  const ql = q.trim().toLowerCase();
  const shown = (list.data ?? []).filter((m) => !ql || [m.name, m.createdByName ?? '', ...m.columns].some((s) => s.toLowerCase().includes(ql)));
  const submit = async () => {
    setBusy(true);
    try {
      if (editing) { await patch(`/pad-modules/${editing.id}`, { name: name.trim(), columns: cols }); toast(`“${name.trim()}” saved`); }
      else { await post('/pad-modules', { name: name.trim(), columns: cols }); toast(`“${name.trim()}” has been added to your prescription pad`); }
      refresh(); onClose();
    } catch (e: any) { toast(e?.code === 'DUPLICATE' || /DUPLICATE/.test(String(e?.message)) ? 'A module by that name already exists. Pick it under Select existing module.' : errText(e), 'err'); }
    finally { setBusy(false); }
  };
  const add = async (m: PadModule) => { await setOnPad(m, true); onClose(); };
  const PH = ['E.g., Diet', 'E.g., Notes', 'E.g., Result', 'E.g., Remarks'];

  return (
    <Drawer title="Add custom module" onClose={onClose} width="max-w-2xl" dirty={tab === 'new' && !!name.trim()}>
      <Tabs className="-mt-1 mb-4" value={tab} onChange={(v) => { setTab(v); if (v === 'existing' && editing) startNew(); }} options={[{ value: 'existing', label: 'Select existing module' }, { value: 'new', label: editing ? 'Edit module' : 'Create new module' }]} />
      {tab === 'existing' ? <div>
        <div className="relative mb-3"><Icon name="search" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" /><input className="input w-full !pl-9" aria-label="Search modules" placeholder="Search by module name, creator or column labels" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        {list.isLoading ? <div className="text-sm text-muted">Loading…</div>
          : !shown.length ? <div className="rounded-[10px] border border-dashed border-line-2 px-4 py-6 text-center text-sm text-muted">{q ? 'No module matches that.' : 'No custom modules yet.'} <button type="button" className="font-semibold text-clay hover:underline" onClick={() => setTab('new')}>Create a new module</button></div>
          : <div className="space-y-2">{shown.map((m) => (
            <div key={m.id} className={`rounded-[10px] border bg-field px-4 py-3 ${more === m.id ? 'border-ink/40' : 'border-line'}`}>
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-[15px] font-bold">{m.name}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px]">
                    <span className="rounded-full bg-surface-2 px-2 py-0.5 font-medium text-muted">{m.createdByName ?? 'Former user'}</span>
                    <span className="rounded-full bg-surface-2 px-2 py-0.5 font-medium text-muted">{two(m.columns.length)} {m.columns.length === 1 ? 'column' : 'columns'}</span>
                    {m.used && <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 font-medium text-muted" title="Used on a prescription, so it can no longer be changed"><Lock className="h-3 w-3" aria-hidden />Locked</span>}
                    <button type="button" className="font-medium text-clay underline-offset-2 hover:underline" aria-expanded={more === m.id} onClick={() => setMore(more === m.id ? null : m.id)}>{more === m.id ? 'View less' : 'View more'}</button>
                  </div>
                </div>
                {m.onPad ? <span className="btn btn-sm pointer-events-none opacity-60"><Icon name="check" className="h-3.5 w-3.5" />On your pad</span>
                  : <button type="button" className="btn btn-sm" onClick={() => add(m)}><Icon name="plus" className="h-3.5 w-3.5" />Add to Rx</button>}
                {m.canEdit && <ModuleMenu items={[{ label: 'Edit module', onClick: () => startEdit(m) }, { label: 'Delete module', danger: true, onClick: () => deleteModule(m) }]} />}
              </div>
              {more === m.id && <div className="mt-3 overflow-hidden rounded-[8px] border border-line"><div className="grid bg-surface-2 text-[12px] font-semibold uppercase tracking-wide text-muted" style={{ gridTemplateColumns: `repeat(${m.columns.length}, minmax(0,1fr))` }}>{m.columns.map((c) => <span key={c} className="truncate px-3 py-2">{c}</span>)}</div>
                <div className="grid text-[13px] text-muted" style={{ gridTemplateColumns: `repeat(${m.columns.length}, minmax(0,1fr))` }}>{m.columns.map((c) => <span key={c} className="truncate border-t border-line px-3 py-2">Enter {c.toLowerCase()}</span>)}</div></div>}
            </div>))}</div>}
      </div> : <div>
        <label className="label" htmlFor="mod-name">Module name <span className="text-rose">*</span></label>
        <div className="relative"><input id="mod-name" autoFocus className="input w-full !pr-14" maxLength={30} placeholder="E.g., Patch test or Diet plan" value={name} onChange={(e) => setName(e.target.value)} /><span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[12px] text-muted">{name.length}/30</span></div>
        {name.trim() && <>
          <div className="label mt-4">Configure columns <span className="text-rose">*</span> <span className="font-normal text-muted">· how many boxes each line has</span></div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup" aria-label="Number of columns">{[1, 2, 3, 4].map((k) => (
            <label key={k} className={`flex cursor-pointer items-center gap-2 rounded-[8px] border px-3 py-2.5 text-[14px] font-medium ${n === k ? 'border-ink bg-surface-2' : 'border-line bg-field'}`}><input type="radio" name="mod-cols" className="accent-ink" checked={n === k} onChange={() => setN(k)} />{two(k)} {k === 1 ? 'column' : 'columns'}</label>))}</div>
          <div className="my-4 flex items-center gap-3 text-[12.5px] text-muted"><span className="h-px flex-1 bg-line" />Set column labels<span className="h-px flex-1 bg-line" /></div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{Array.from({ length: n }, (_, j) => (
            <div key={j}><label className="label" htmlFor={`mod-col-${j}`}>Column {j + 1} <span className="text-rose">*</span></label>
              <div className="relative"><input id={`mod-col-${j}`} className="input w-full !pr-12" maxLength={15} placeholder={PH[j]} value={labels[j]} onChange={(e) => setLabels(labels.map((x, k) => (k === j ? e.target.value : x)))} /><span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[12px] text-muted">{labels[j].length}/15</span></div></div>))}</div>
          {dupCol && <div className="mt-1.5 text-xs text-rose">Two columns have the same label.</div>}
        </>}
        <div className="mt-5 rounded-[10px] border border-line bg-surface-2 px-4 py-3.5">
          <div className="mb-2 flex items-center gap-2 text-[14.5px] font-bold"><Info className="h-4 w-4 text-clay" aria-hidden />Things to know before creating a custom module</div>
          <ul className="list-disc space-y-1 pl-5 text-[13.5px] leading-relaxed">
            <li>You can <b>edit or delete</b> this module until it is used on a prescription.</li>
            <li>Once used, it is <b>locked</b>: its name, columns and labels can no longer be changed or deleted.</li>
            <li>To change it later, <b>create a new module</b>.</li>
            <li>This keeps every past prescription exactly as it was written.</li>
            <li>Every doctor in the clinic can find it under Select existing module.</li>
          </ul>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={!ready || busy} onClick={submit}>{editing ? 'Save changes' : 'Create & add to Rx'}</button>
        </div>
      </div>}
    </Drawer>
  );
}

/** A small ⋮ on a module card or a list row. */
export function ModuleMenu({ items }: { items: { label: string; onClick: () => void; danger?: boolean; disabled?: string }[] }) {
  const [open, setOpen] = useState(false); const btn = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={btn} type="button" className="btn btn-ghost btn-icon !h-7 !w-7" aria-label="Module options" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="dots" className="h-4 w-4" /></button>
      <Floating anchor={btn} open={open} onClose={() => setOpen(false)} width={220}>
        <div role="menu" className="menu-list">{items.map((i) => <button key={i.label} type="button" role="menuitem" disabled={!!i.disabled} title={i.disabled} className={`${i.danger ? 'danger' : ''} disabled:opacity-45`} onClick={() => { setOpen(false); i.onClick(); }}>{i.label}</button>)}</div>
      </Floating>
    </>
  );
}
