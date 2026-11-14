import { Fragment, lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useNavigate, useParams, useOutletContext, useSearchParams } from 'react-router';
import { get, patch, post, qc, ApiError, errText } from '../api';
import { can } from '../App';
import { LayoutTemplate, Save, Eraser, History as HistoryIcon, CalendarDays, HeartPulse, ClipboardList, Activity, Stethoscope, ScanSearch, Pill, MessageSquareText, FlaskConical, TestTubes, CalendarClock, Syringe, NotebookPen, ArrowRightLeft, Camera, FolderOpen, PenLine, FileText, type LucideIcon } from 'lucide-react';
import { BackButton, Chip, Drawer, Floating, Icon, Modal, MoreMenu, Skeleton, Tabs, fmtDate, money, toast, NumInput, ask } from '../ui';
import { type Pkg, fullPrice } from '../packages';
import { openPrint } from '../printPreview';
import { EncounterModal, UploadButton, asList, joinList } from '../encounterDetail';
import { usePhotos, PhotoCapture, PhotoCompare, RemovePhoto } from '../photos';
import { parseRxLine, qtyFor, ageText, parseDuration, parseAfter, afterText } from '../rxLine';
import { allergyHit, rxProblems, needsReason, pregnancyFlag, firstName, type Override } from '../rxSafety';
import { PrintRx } from './PrintRx';
import { FlagChips, CarefulBanner } from '../flags';
import { useTemplates, suggests, norm, uniq, type Tmpl, type TmplKind } from '../templates';
import { ScreenBlock, ScreeningCard, checklists, complaintTexts, type Answers, type History } from '../screening';
import { HistoryChips, HistorySheet } from '../historyChips';
import { VitalsCard, vitalFields, vitalsText, bmiOf, vitalFlag } from '../vitals';
import { LabResultsCard, ReportLink, reportFor } from '../labs';
import { ReportList } from '../labHistory';
import type { PadCanvas } from '../padCanvas';
import { AddModuleDrawer, ModuleInfo, ModuleLoadPrev, ModuleMenu, ModuleTable, deleteModule, filledRows, setOnPad, usePadModules, type ModuleData, type PadModule } from '../padModules';
// the drawing board loads only when the Canvas drawer opens (it is a large library)
const CanvasDrawer = lazy(() => import('../padCanvas').then((m) => ({ default: m.CanvasDrawer })));

type Field = { key: string; label: string; type: string; required?: boolean; options?: string[]; unit?: string; placeholder?: string };
type RxItem = { id?: string; _issued?: boolean; medicineId?: string | null; name: string; dose?: string; route?: string; frequency?: string; durationDays?: number; durationNote?: string | null; instructions?: string; timing?: string | null; qty?: number | null; _qtyTouched?: boolean };
type Rec = { kind: 'followup' | 'procedure' | 'investigation'; procedureId?: string | null; intervalDays?: number; dueOn?: string; sittings?: number; gapDays?: number; /** procedures: the doctor's own price, total for all sittings; empty = standard */ amountPaise?: number | null; notes?: string; orderNo?: number; status?: string; id?: string;
  /** procedures added as a package: which package and the pad group; the server sets the share of the price */ package?: { id: string; group: string; name?: string; pricePaise?: number; listPaise?: number; validMonths?: number } | null };
type Sym = { name: string; since?: string; severity?: string; note?: string };
type Dx = { name: string; since?: string; severity?: string; status?: string; note?: string };
/** An examination finding as a row (Tatva): the finding and a note. */
type ExamRow = { name: string; note?: string };

const FREQ = ['1-0-0', '0-0-1', '1-0-1', '1-1-1', 'at night', 'once daily', 'twice daily', 'alternate days', 'weekly', 'SOS'];
const TIMING = ['Before food', 'After food', 'With food', 'Bed time', 'Before breakfast', 'After breakfast', 'Empty stomach'];
const DURATION_WORDS = ['Stat', 'To be continued', 'Till required'];
/** Findings to search beside the clinic's own exam lists. */
const EXAM_OPTIONS = ['Erythematous', 'Erythema', 'Scaly plaque', 'Papules', 'Pustules', 'Nodules', 'Vesicles', 'Comedones', 'Macule', 'Patch', 'Plaque', 'Scale', 'Crust', 'Erosion', 'Ulcer', 'Scar', 'Lichenification', 'Excoriation', 'Hypopigmented patch', 'Hyperpigmented patch', 'Annular lesion', 'Well-defined border', 'Satellite lesions', 'Burrows', 'Wheals', 'Nail pitting', 'Onycholysis', 'Koebner phenomenon', 'Diffuse hair thinning', 'Patchy alopecia'];
const asExam = (v: any): ExamRow[] => (Array.isArray(v?.items) ? v.items : []);
/** Used only until /config has loaded; the clinic's own list is Settings › Lab tests (cfg.labTests). */
const TESTS = ['CBC', 'FBS / PPBS', 'HbA1c', 'LFT', 'RFT', 'Lipid profile', 'TSH', 'Vitamin D', 'Vitamin B12', 'Serum ferritin', 'KOH mount', 'Skin biopsy', 'Patch test', 'VDRL', 'HIV', 'HBsAg', 'ANA', 'Urine routine', 'Culture & sensitivity', 'Woods lamp'];
const ADVICE = ['Keep the area dry', "Don't share towels", 'Wash clothes in hot water', 'No steroid creams', 'Loose cotton clothes', 'Sunscreen every 3 hours', 'Moisturise twice daily', 'Avoid scrubbing', 'Avoid oily food', 'Mild soap only'];
const SEVERITIES = ['Mild', 'Moderate', 'Severe'];
const DX_STATUS = ['Ruled Out', 'Suspected', 'Confirmed'];
const DX_OPTIONS = ['Acne vulgaris', 'Melasma', 'Tinea corporis', 'Tinea cruris', 'Psoriasis vulgaris', 'Alopecia areata', 'Androgenetic alopecia', 'Verruca vulgaris', 'Atopic dermatitis', 'Seborrheic dermatitis', 'Contact dermatitis', 'Acute urticaria', 'Chronic urticaria', 'Vitiligo', 'Post-inflammatory hyperpigmentation', 'Scabies', 'Pityriasis versicolor', 'Lichen planus', 'Rosacea', 'Molluscum contagiosum', 'Impetigo', 'Herpes zoster'];
// ponytail: the allergy, pregnancy and interaction word lists live in src/lib/rxSafety.ts (tested in rxSafety2.test.ts); a proper drug database is the upgrade path.
const strip = ({ id, encounterId, tenantId, sortOrder, dispensed, issuedQty, notIssuedReason, createdAt, _qtyTouched, _issued, ...i }: any): RxItem => i;
/** The pad's own lines keep their id so a held-open consultation updates them instead of re-issuing; issued lines are locked. */
const own = (i: any): RxItem => ({ ...strip(i), id: i.id, _issued: !!(i.dispensed || i.issuedQty > 0) });
const asSym = (v: any): Sym[] => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? { name: x } : x)) : v ? [{ name: String(v) }] : []);
const asDx = (v: any): Dx[] => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? { name: x } : x)) : v ? [{ name: String(v) }] : []);
const isReviewVisit = (v: any, cfg: any) => { const code = v?.category; if (!code) return false; if (['REN', 'FREE'].includes(code)) return true; const cat = (cfg?.feeCategories ?? []).find((c: any) => c.code === code); return !!cat && (cat.amountPaise === 0 || /review|renew|follow/i.test(cat.name ?? '')); };
const PH = 'placeholder:italic placeholder:opacity-60'; // a placeholder that cannot be mistaken for a value
const withQty = (i: RxItem): RxItem => (i._qtyTouched || i.qty ? i : { ...i, qty: qtyFor(i) ?? undefined });
/** Each section's icon and colour (an icon, not letters). */
const ICON: Record<string, [LucideIcon, string]> = { records: [FolderOpen, '#6F8F78'], reports: [FolderOpen, '#6F8F78'], canvas: [PenLine, '#C53B14'], vitals: [HeartPulse, '#5B8DB8'], symptoms: [Activity, '#C53B14'], diagnosis: [Stethoscope, '#8A2E10'], exam: [ScanSearch, '#6F8F78'], medicines: [Pill, '#4F7396'], advice: [MessageSquareText, '#B98B6E'], tests: [FlaskConical, '#7A6FB0'], results: [TestTubes, '#B8860B'], followup: [CalendarClock, '#6F8F78'], procedures: [Syringe, '#285C9C'], notes: [NotebookPen, '#8B929C'], addnotes: [FileText, '#8B929C'], referral: [ArrowRightLeft, '#5B8DB8'], history: [ClipboardList, '#8A2E10'], photos: [Camera, '#6F8F78'] };
const SecIcon = ({ id, big }: { id: string; big?: boolean }) => { const [I, color] = ICON[id] ?? [FileText, '#8B929C']; return <span className={`sec-ic grid shrink-0 place-items-center rounded-[8px] ${big ? 'h-8 w-8' : 'h-7 w-7'}`} style={{ background: `color-mix(in srgb, ${color} 14%, var(--color-surface))`, color: `color-mix(in srgb, ${color} 75%, var(--color-ink))` }} aria-hidden><I className="h-4 w-4" strokeWidth={2} /></span>; };

/** One section of the pad as its own card: icon tile, title, the header actions on the right, rows inside, the search line last. */
function Card({ id, title, meta, actions, children, required, invalid }: { id: string; title: string; meta?: ReactNode; actions?: ReactNode; children: ReactNode; required?: boolean; invalid?: boolean }) {
  const color = ICON[id]?.[1] ?? '#8B929C';
  return (
    <section id={`sec-${id}`} className={`card !p-0 anim-fade-up ${invalid ? 'outline-2 outline-rose/70' : ''}`} style={{ '--sec': color } as Record<string, string>} aria-invalid={invalid || undefined}>
      <div className="flex flex-wrap items-center gap-2.5 border-b border-line px-4 py-2.5">
        <SecIcon id={id} />
        <h3 className="text-[17px] font-bold tracking-[-0.01em] text-ink">{title}{required && <span className="text-rose" title="Required to finish"> *</span>}</h3>
        {meta && <span className="text-xs text-muted">{meta}</span>}
        {actions && <span className="ml-auto flex flex-wrap items-center gap-0.5">{actions}</span>}
      </div>
      <div className="px-4 pb-4 pt-2">{children}</div>
    </section>
  );
}
const Act = ({ children, onClick, disabled, aria }: { children: ReactNode; onClick: () => void; disabled?: boolean; aria?: string }) => <button type="button" className="btn btn-ghost !min-h-7 !px-2 text-[12px] text-muted hover:text-ink" disabled={disabled} aria-label={aria} onClick={onClick}>{children}</button>;


/** T·Sx, T·Dx …: the section's templates in one place, as in Eka. Load one, save what is on the card now, or clear the card. */
function SectionTemplates({ kind, sub, what, sets, onPick, onSave, onClear, compact, id }: { kind: TmplKind; sub: string; what: string; sets: Tmpl[]; onPick: (t: Tmpl) => void; onSave?: () => void; onClear: (() => void) | null; compact?: boolean; id?: string }) {
  const [open, setOpen] = useState(false); const [q, setQ] = useState(''); const btn = useRef<HTMLButtonElement>(null);
  const mine = sets.filter((t) => t.kind === kind); const list = mine.filter((t) => !q || t.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      {compact ? <button ref={btn} type="button" data-act="templates" className="btn btn-ghost !min-h-7 gap-1 !px-2 text-[12px] text-muted hover:text-ink" aria-label={`${what} templates`} title={`${what[0].toUpperCase()}${what.slice(1)} templates (${sub})`} aria-expanded={open} onClick={() => setOpen(!open)}><LayoutTemplate className="h-3.5 w-3.5" aria-hidden /><span className="tpl-word">Templates</span><span className="tpl-tag" aria-hidden><b>T</b><sub>{sub}</sub></span></button>
        : <button ref={btn} id={id} type="button" className="btn btn-sm" aria-label={`${what} templates`} title={`${what[0].toUpperCase()}${what.slice(1)} templates (Alt+T)`} aria-expanded={open} onClick={() => setOpen(!open)}><LayoutTemplate className="h-3.5 w-3.5" aria-hidden />Templates</button>}
      <Floating anchor={btn} open={open} onClose={() => setOpen(false)} width={320}>
        <div className="p-1.5">
          <div className="px-2 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wider text-muted">{what} templates</div>
          {mine.length > 6 && <input autoFocus aria-label="Search templates" className="input mb-1.5 !py-1.5" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />}
          {list.length === 0 ? <div className="px-2 py-2 text-xs text-muted">{q ? 'Nothing by that name.' : `No ${what} templates yet. Fill the section, then press Save on it.`}</div>
            : <div className="max-h-56 overflow-y-auto">{list.slice(0, 20).map((t) => <button key={t.id} type="button" className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[13px] hover:bg-paper-2" onClick={() => { onPick(t); setOpen(false); }}><span className="min-w-0 flex-1 truncate font-medium">{t.name}</span>{t.uses > 0 && <span className="text-[11px] text-muted" title="How many times this template has been used">used {t.uses === 1 ? 'once' : `${t.uses} times`}</span>}</button>)}</div>}
          {(onSave || onClear) && <div className="mt-1 flex items-center gap-1 border-t border-line pt-1.5">
            {onSave && <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setOpen(false); onSave(); }}><Icon name="plus" className="h-3.5 w-3.5" />Save {what} as template</button>}
            {onClear && <button type="button" className="btn btn-ghost btn-sm ml-auto text-rose" onClick={() => { setOpen(false); onClear(); }}>Clear</button>}
          </div>}
        </div>
      </Floating>
    </>
  );
}

/** The line at the foot of a card, Eka's "Start typing…": matches as you type, Enter adds the top match or what was typed. */
/** A set suggested in an empty search box: a template linked to this patient's complaint or diagnosis. */
type SetHint = { label: string; hint?: string; pick: () => void };
/** Search box of a pad section. Typing searches `options`. Clicked while empty (or ↓), it lists what the old Quick add chips offered (a pick closes it):
 *  sets suggested for this patient, then the usual picks (`common`). It never opens by itself, so a box that gets the cursor on load stays quiet. */
function SearchLine({ placeholder, options = [], onAdd, invalid, autoFocus, sets = [], common = [], commonTitle = 'Common' }: { placeholder: string; options?: string[]; onAdd: (t: string) => void; invalid?: boolean; autoFocus?: boolean; sets?: SetHint[]; common?: string[]; commonTitle?: string }) {
  const [v, setV] = useState(''); const [shut, setShut] = useState(false); const [open, setOpen] = useState(false); const [sel, setSel] = useState(-1); const box = useRef<HTMLDivElement>(null);
  const q = v.trim().toLowerCase();
  const done = () => { setV(''); setSel(-1); setOpen(false); }; // a pick closes the list; the cursor stays here, so ↓ or a click opens it again
  const add = (t: string) => { if (t.trim()) onAdd(t.trim()); done(); };
  type It = { key: string; label: string; hint?: string; group?: string; run: () => void };
  const hits: It[] = q ? options.filter((o) => o.toLowerCase().includes(q)).slice(0, 8).map((o) => ({ key: o, label: o, run: () => add(o) })) : [];
  const SUG = 8;
  const sug: It[] = q || !open ? [] : [
    ...sets.slice(0, SUG).map((x) => ({ key: `s:${x.label}`, label: x.label, hint: x.hint, group: 'Suggested for this patient', run: () => { x.pick(); done(); } })),
    ...common.slice(0, Math.max(0, SUG - sets.length)).map((o) => ({ key: `c:${o}`, label: o, group: commonTitle, run: () => { onAdd(o); done(); } })),
  ];
  const items = q ? hits : sug;
  return (
    <div ref={box} className="relative mt-2" data-invalid={invalid || undefined}>
      <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
      <input aria-label={placeholder} autoFocus={autoFocus} className={`input w-full !rounded-[8px] !py-2 !pl-9 ${invalid ? '!outline-2 !outline-rose/70' : ''}`} placeholder={placeholder} value={v} data-search role="combobox" aria-expanded={items.length > 0 && !shut}
        onClick={() => { setOpen(true); setShut(false); }} onBlur={() => setOpen(false)}
        onChange={(e) => { setV(e.target.value); setShut(false); setSel(-1); }}
        onKeyDown={(e) => { if (e.altKey || e.ctrlKey || e.metaKey) return; /* the pad's shortcuts */
          if (e.key === 'ArrowDown') { if (!q && !open) { e.preventDefault(); setOpen(true); setShut(false); return; } if (items.length) { e.preventDefault(); setShut(false); setSel((x) => Math.min(items.length - 1, x + 1)); } }
          else if (e.key === 'ArrowUp' && items.length) { e.preventDefault(); setSel((x) => Math.max(-1, x - 1)); }
          else if (e.key === 'Enter') { e.preventDefault(); if (sel >= 0 && items[sel]) items[sel].run(); else if (q) add(hits[0] && hits[0].label.toLowerCase().startsWith(q) ? hits[0].label : v); }
          else if (e.key === 'Escape') { if (v || open) e.preventDefault(); setV(''); setSel(-1); setOpen(false); } }} />
      <Floating anchor={box} open={items.length > 0 && !shut} onClose={() => { setShut(true); setOpen(false); }} width={box.current?.offsetWidth ?? 320} align="left">
        <div className="p-1" role="listbox" aria-label={placeholder}>{items.map((o, k) => <Fragment key={o.key}>
          {o.group && o.group !== items[k - 1]?.group && <div className="px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted first:pt-1">{o.group}</div>}
          <button type="button" role="option" aria-selected={k === sel} className={`flex w-full items-center gap-2 rounded-[4px] px-2.5 py-2 text-left text-[13px] font-medium hover:bg-paper-2 ${k === sel ? 'bg-paper-2' : ''}`} onMouseDown={(e) => e.preventDefault()} onClick={o.run}>
            <span className="min-w-0 flex-1 truncate">{o.label}</span>{o.hint && <span className="shrink-0 text-[11.5px] font-normal text-muted">{o.hint}</span>}</button></Fragment>)}</div>
      </Floating>
    </div>
  );
}

/** One chosen item as a row of a flat table (.rx-row): its cells, then the remove button in the last cell at the right edge. */
const Row = ({ children, onRemove, label }: { children: ReactNode; onRemove?: (() => void) | null; label: string }) => (
  <div className="rx-row">
    {children}
    <span className="grid min-w-9 place-items-center">{onRemove && <button type="button" className="btn btn-ghost btn-icon !h-7 !w-7" aria-label={`Remove ${label}`} onClick={onRemove}><Icon name="x" className="h-3.5 w-3.5" /></button>}</span>
  </div>
);

/** What one past visit had in one section, as short lines: what Load previous shows and loads for that section. */
type Part = 'sx' | 'dx' | 'ex' | 'rx' | 'advice' | 'tests';
const PART_LABEL: Record<Part, string> = { sx: 'Symptoms', dx: 'Diagnosis', ex: 'Findings', rx: 'Medicines', advice: 'Advice', tests: 'Tests' };
const partItems = (x: any, part: Part): string[] => {
  const d = x.data ?? {};
  if (part === 'sx') return asSym(d.complaint?.chief_complaint).map((s) => [s.name, s.since && `since ${s.since}`, s.severity?.toLowerCase()].filter(Boolean).join(' · '));
  if (part === 'dx') return asDx(d.assessment?.diagnosis).map((s) => [s.name, s.severity?.toLowerCase()].filter(Boolean).join(' · '));
  if (part === 'ex') return [...asExam(d.exam).map((x) => [x.name, x.note].filter(Boolean).join(' · ')), ...Object.entries(d.exam ?? {}).filter(([k]) => k !== 'items').flatMap(([, v]: any) => (Array.isArray(v) ? v : v ? [String(v)] : [])).map(String)];
  if (part === 'rx') return (x.prescription ?? []).map((i: any) => [i.name, i.dose, i.frequency, i.durationDays ? `${i.durationDays} d` : i.durationNote].filter(Boolean).join(' · '));
  if (part === 'advice') return String(d.plan?.advice ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
  return (x.recommendations ?? []).filter((r: any) => r.kind === 'investigation' && r.notes).map((r: any) => r.notes);
};

/** Load previous. For one section (part): only past visits that had something there, only those items, and only they come over.
 *  With no section (the search set to all sections): tick which parts of the picked visit come over. */
function LoadPrevious({ previous, onLoad, part, compact, id }: { previous: any[]; onLoad: (e: any, parts: Record<string, boolean>) => void; part?: Part; compact?: boolean; id?: string }) {
  const [open, setOpen] = useState(false); const [sel, setSel] = useState<any>(null); const btn = useRef<HTMLButtonElement>(null);
  const [parts, setParts] = useState<Record<string, boolean>>({ dx: true, rx: true, advice: false, tests: false });
  const done = previous.filter((x) => x.status === 'completed' && (!part || partItems(x, part).length > 0)); const e = done.find((x) => x.id === sel?.id) ?? done[0];
  const what = part ? PART_LABEL[part].toLowerCase() : 'anything';
  const label = part === 'rx' ? 'Load prev. Rx' : part === 'dx' ? 'Load prev. Diagnosis' : 'Load previous';
  if (!done.length) return <button type="button" className={compact ? 'btn btn-ghost !min-h-7 gap-1 !px-2 text-[12px] text-muted' : 'btn btn-sm'} disabled title={`No earlier visit with ${what} to load`}><HistoryIcon className="h-3.5 w-3.5" aria-hidden />{label}</button>;
  return (
    <>
      {compact ? <button ref={btn} type="button" data-act="loadprev" className="btn btn-ghost !min-h-7 gap-1 !px-2 text-[12px] text-muted hover:text-ink" title={`Load ${what} from an earlier visit (Alt+L)`} aria-expanded={open} onClick={() => setOpen(!open)}><HistoryIcon className="h-3.5 w-3.5" aria-hidden />{label}</button>
        : <button ref={btn} id={id} type="button" className="btn btn-sm" title={`Load ${what} from an earlier visit (Alt+L)`} aria-expanded={open} onClick={() => setOpen(!open)}><HistoryIcon className="h-3.5 w-3.5" aria-hidden />Load previous</button>}
      <Floating anchor={btn} open={open} onClose={() => setOpen(false)} width={460}>
        <div className="p-2">
          <div className="px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">{part ? `${PART_LABEL[part]} from an earlier visit` : 'From an earlier visit'}</div>
          {!part && <div className="mb-2 flex flex-wrap gap-3 text-[12.5px]">{([['dx', 'Diagnosis'], ['rx', 'Medicines'], ['advice', 'Advice'], ['tests', 'Tests']] as const).map(([k, l]) => <label key={k} className="inline-flex items-center gap-1.5 font-medium"><input type="checkbox" className="accent-ink" checked={!!parts[k]} onChange={(ev) => setParts({ ...parts, [k]: ev.target.checked })} />{l}</label>)}</div>}
          <div className="max-h-44 space-y-1 overflow-y-auto">{done.slice(0, 10).map((x) => <button key={x.id} type="button" className={`w-full rounded-md border px-2.5 py-1.5 text-left text-[12.5px] ${e?.id === x.id ? 'border-ink bg-surface-2' : 'border-line hover:bg-surface-2'}`} onClick={() => setSel(x)}>
            <div className="flex items-center gap-2"><b>{fmtDate(x.createdAt)}</b><span className="text-muted">{x.doctor?.name ?? ''}</span></div>
            <div className="truncate text-xs text-muted">{part ? partItems(x, part).join(', ') : [joinList(x.data?.assessment?.diagnosis), (x.prescription ?? []).map((i: any) => i.name).join(', ')].filter(Boolean).join(' · ') || 'Consultation'}</div></button>)}</div>
          {e && <div className="mt-2 rounded-md border border-line bg-surface-2 p-2.5 text-[12.5px] leading-relaxed">
            {part ? partItems(e, part).map((l, k) => <div key={k}>{l}</div>)
              : (['dx', 'rx', 'advice', 'tests'] as Part[]).filter((k) => parts[k]).map((k) => <div key={k}><b>{PART_LABEL[k]}</b> {partItems(e, k).join('; ') || '—'}</div>)}
          </div>}
          <div className="mt-2 flex items-center gap-2"><span className="text-xs text-muted">Lines already on the pad are not added twice.</span><button type="button" className="btn btn-sm btn-primary ml-auto" disabled={!e || (!part && !Object.values(parts).some(Boolean))} onClick={() => { onLoad(e, part ? { [part]: true } : parts); setOpen(false); }}>Load</button></div>
        </div>
      </Floating>
    </>
  );
}

/** A small save on a section: saves what the section holds now as one of its templates. */
const SaveTemplate = ({ what, onSave }: { what: string; onSave: () => void }) => <button type="button" data-act="save" className="btn btn-ghost !min-h-7 gap-1 !px-2 text-[12px] text-muted hover:text-ink" title={`Save these ${what} as a template`} aria-label={`Save ${what} as a template`} onClick={onSave}><Save className="h-3.5 w-3.5" aria-hidden />Save</button>;

/** A pick list that always shows every choice on focus (a datalist only shows the ones matching what is already in the box), filters as you type,
 *  and still takes free text. Used for the medicine name, frequency and timing. */
function Combo({ value, options, onChange, placeholder, label, className, disabled, id, detail }: { value: string; options: string[]; onChange: (v: string) => void; placeholder?: string; label: string; className?: string; disabled?: boolean; id?: string; detail?: (o: string) => string | null }) {
  const [open, setOpen] = useState(false); const [typed, setTyped] = useState(false); const [sel, setSel] = useState(-1); const box = useRef<HTMLDivElement>(null);
  const q = value.trim().toLowerCase();
  const list = (typed && q ? options.filter((o) => o.toLowerCase().includes(q)) : options).slice(0, 40);
  const pick = (o: string) => { onChange(o); setOpen(false); setTyped(false); setSel(-1); };
  return (
    <div ref={box} className="min-w-0">
      <input id={id} aria-label={label} role="combobox" aria-expanded={open && list.length > 0} autoComplete="off" className={className} placeholder={placeholder} value={value} disabled={disabled}
        onFocus={() => { setOpen(true); setTyped(false); setSel(-1); }} onClick={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => { onChange(e.target.value); setTyped(true); setOpen(true); setSel(-1); }}
        onKeyDown={(e) => { if (e.altKey || e.ctrlKey || e.metaKey) return; if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setSel((s) => Math.min(list.length - 1, s + 1)); } else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(-1, s - 1)); } else if (e.key === 'Enter' && open && sel >= 0 && list[sel]) { e.preventDefault(); pick(list[sel]); } else if (e.key === 'Escape' || e.key === 'Tab') setOpen(false); }} />
      {/* above the page, not inside the card: a card's glass would hide a list that runs past its foot */}
      <Floating anchor={box} open={open && !disabled && list.length > 0} onClose={() => setOpen(false)} width={Math.max(220, box.current?.offsetWidth ?? 0)} align="left">
        <div className="max-h-64 overflow-y-auto p-1" role="listbox" aria-label={label}>
          {list.map((o, k) => <button key={o} type="button" role="option" aria-selected={o === value} className={`flex w-full items-center gap-2 rounded-[4px] px-2.5 py-1.5 text-left text-[13px] hover:bg-paper-2 ${k === sel ? 'bg-paper-2' : ''} ${o === value ? 'font-bold' : 'font-medium'}`} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(o)}><span className="min-w-0 flex-1 truncate">{o}</span>{detail?.(o) && <span className="shrink-0 text-[11px] text-muted">{detail(o)}</span>}</button>)}
        </div>
      </Floating>
    </div>
  );
}

/** Duration as Tatva writes it: a number of days ("5", "2 weeks") or a word (Stat, To be continued, Till required). What is typed stays as typed until it is read. */
function DurationCell({ item, disabled, onChange }: { item: RxItem; disabled?: boolean; onChange: (d: Partial<RxItem>) => void }) {
  const shown = item.durationDays ? afterText(item.durationDays) : item.durationNote ?? '';
  const [v, setV] = useState(shown); const last = useRef(shown);
  if (shown !== last.current) { last.current = shown; if (parseDuration(v).durationDays !== item.durationDays || (parseDuration(v).durationNote ?? '') !== (item.durationNote ?? '')) setV(shown); } // changed from outside (a template, a medicine's default)
  return <Combo label="Duration" className={`cell-in ${PH}`} placeholder="e.g. 5 days" value={v} options={DURATION_WORDS} disabled={disabled} onChange={(t) => { setV(t); const d = parseDuration(t); last.current = d.durationDays ? afterText(d.durationDays) : d.durationNote ?? ''; onChange(d); }} />;
}

/** Advices as Tatva picks them: the search opens a list where a tick adds the line to the advices and an untick takes it off; a line not in the list is added as typed. */
function AdvicePicker({ options, have, onToggle, sets = [] }: { options: string[]; have: string[]; onToggle: (x: string) => void; sets?: SetHint[] }) {
  const [q, setQ] = useState(''); const [open, setOpen] = useState(false); const box = useRef<HTMLDivElement>(null);
  const list = options.filter((o) => !q.trim() || o.toLowerCase().includes(q.trim().toLowerCase()));
  const add = (x: string) => { if (!have.includes(x)) onToggle(x); setQ(''); };
  const custom = q.trim() && !options.some((o) => o.toLowerCase() === q.trim().toLowerCase()) && !have.includes(q.trim()) ? q.trim() : null;
  return (
    <div ref={box} className="relative mt-2">
      <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
      <input aria-label="Search advices" data-search className={`input w-full !rounded-[8px] !py-2 !pl-9 ${PH}`} placeholder="Search advices" value={q} role="combobox" aria-expanded={open}
        onFocus={() => setOpen(true)} onClick={() => setOpen(true)} onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onKeyDown={(e) => { if (e.altKey || e.ctrlKey || e.metaKey) return; if (e.key === 'Enter') { e.preventDefault(); const x = custom ?? list.find((o) => !have.includes(o)); if (x) add(x); } else if (e.key === 'Escape') { setOpen(false); } }} />
      <Floating anchor={box} open={open && (list.length > 0 || !!custom || (!q && sets.length > 0))} onClose={() => { setOpen(false); setQ(''); }} width={box.current?.offsetWidth ?? 360} align="left">
        <div className="p-1.5">
          {!q && sets.length > 0 && <><div className="px-2 pb-1 pt-0.5 text-[11px] font-semibold uppercase tracking-wider text-muted">Suggested for this patient</div>
            {sets.map((x) => <button key={x.label} type="button" className="flex w-full items-center gap-2 rounded-[4px] px-2.5 py-1.5 text-left text-[13px] font-medium hover:bg-paper-2" onMouseDown={(e) => e.preventDefault()} onClick={x.pick}><span className="min-w-0 flex-1 truncate">{x.label}</span>{x.hint && <span className="text-[11.5px] font-normal text-muted">{x.hint}</span>}</button>)}</>}
          <div className="px-2 pb-1 pt-0.5 text-[11px] font-semibold uppercase tracking-wider text-muted">{q ? 'Search results' : 'Advices'}</div>
          <div className="max-h-64 overflow-y-auto">
            {list.slice(0, 40).map((o) => <label key={o} className="flex cursor-pointer items-center gap-2 rounded-[4px] px-2.5 py-1.5 text-[13px] hover:bg-paper-2" onMouseDown={(e) => e.preventDefault()}>
              <input type="checkbox" className="accent-ink" checked={have.includes(o)} onChange={() => onToggle(o)} />{o}</label>)}
            {custom && <button type="button" className="flex w-full items-center gap-2 rounded-[4px] px-2.5 py-1.5 text-left text-[13px] hover:bg-paper-2" onMouseDown={(e) => e.preventDefault()} onClick={() => add(custom)}>{custom}<span className="font-semibold text-clay">+ Add custom</span></button>}
          </div>
        </div>
      </Floating>
    </div>
  );
}

/** Follow-up: type a number and pick N days / N weeks / N months (or type "3 weeks", or pick a date). */
function FollowUp({ days, disabled, onChange }: { days: number | null; disabled?: boolean; onChange: (d: number | null) => void }) {
  const [v, setV] = useState(days ? afterText(days) : ''); const last = useRef(days); const cal = useRef<HTMLInputElement>(null);
  if (days !== last.current) { last.current = days; if (parseAfter(v) !== days) setV(days ? afterText(days) : ''); }
  const iso = (d: number) => new Date(Date.now() + d * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const today = iso(0);
  const set = (d: number | null) => { last.current = d; onChange(d); };
  return (
    <div>
      <div className="flex items-center gap-1.5">
        <input aria-label="Follow-up after" className={`input !py-1.5 ${PH}`} placeholder="Type a number, e.g. 2" maxLength={20} value={v} disabled={disabled} onChange={(e) => { setV(e.target.value); if (/^\s*\d+\s*$/.test(e.target.value)) return; /* a bare number waits for days, weeks or months below */ const d = parseAfter(e.target.value); if (d || !e.target.value.trim()) set(d); }} />
        {/* the calendar opens from a button; the date box itself stays out of sight */}
        <span className="relative shrink-0"><button type="button" className="btn btn-icon !h-[34px] !w-[38px]" aria-label="Pick the follow-up date" disabled={disabled} onClick={() => { try { cal.current?.showPicker(); } catch { cal.current?.focus(); } }}><CalendarDays className="h-4 w-4" aria-hidden /></button>
          <input ref={cal} type="date" tabIndex={-1} aria-hidden className="pointer-events-none absolute inset-0 opacity-0" min={today} value={days ? iso(days) : ''} disabled={disabled} onChange={(e) => { const d = e.target.value ? Math.round((Date.parse(e.target.value) - Date.parse(today)) / 86400000) : 0; const n = d > 0 ? Math.min(365, d) : null; setV(n ? afterText(n) : ''); set(n); }} /></span>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">{((() => { const n = Math.max(1, Math.min(365, parseInt(v, 10) || 1)); const pl = (w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
        return ([[n, pl('day')], ...(n * 7 <= 365 ? [[n * 7, pl('week')]] : []), ...(n <= 12 ? [[n * 30, pl('month')]] : [])] as [number, string][]); })()).map(([d, l]) => <button key={l} type="button" disabled={disabled} aria-pressed={days === d} className={days === d ? 'pick-chip' : 'toggle-opt'} onClick={() => { setV(afterText(d)); set(days === d ? null : d); }}>{l}</button>)}</div>
    </div>
  );
}

/** Finish stopped on allergy, pregnancy or a serious interaction: one short reason for each, or back to the pad to change it. */
function ReasonSheet({ warnings, onCancel, onDone }: { warnings: string[]; onCancel: () => void; onDone: (reasons: Record<string, string>) => void }) {
  const [r, setR] = useState<Record<string, string>>({});
  const ok = warnings.every((w) => (r[w] ?? '').trim().length >= 3);
  return (
    <Modal title="Check before finishing" width="max-w-lg" onClose={onCancel}>
      <form className="space-y-3" onSubmit={(ev) => { ev.preventDefault(); if (ok) onDone(r); }}>
        <div className="text-[13px] text-muted">Take the medicine off, or say in a few words why it is right for this patient. The reason stays with the consultation; it is not printed.</div>
        {warnings.map((w, k) => <div key={w}><div className="mb-1 text-[13px] font-semibold text-rose">{w}</div>
          <input autoFocus={k === 0} className="input" aria-label={`Reason to prescribe: ${w}`} maxLength={300} placeholder="Reason to prescribe" value={r[w] ?? ''} onChange={(ev) => setR({ ...r, [w]: ev.target.value })} /></div>)}
        <div className="modal-foot"><button type="button" className="btn btn-ghost" onClick={onCancel}>Back to the pad</button><button type="submit" className="btn btn-primary" disabled={!ok}>Prescribe anyway</button></div>
      </form>
    </Modal>
  );
}

/** The consultation on one pad: section cards in the clinic's order, templates in every card header, type anything on top, finish and call the next patient. */
export function Encounter() {
  const { id } = useParams(); const nav = useNavigate(); const { cfg, perms, me } = useOutletContext<any>();
  /** Days between sittings for a procedure: a clinic package's gap for it, else four weeks. The doctor can change it on the line. */
  const pkgs: Pkg[] = ((cfg?.tenant?.settings?.packages ?? []) as Pkg[]).filter((k) => k.active !== false);
  const gapFor = (pid?: string | null): number => pkgs.flatMap((k) => k.items).find((it) => it.procedureId === pid && it.intervalDays > 0)?.intervalDays ?? 28;
  const enc = useQuery({ queryKey: ['encounter', id], queryFn: () => get(`/encounters/${id}`) });
  const timeline = useQuery({ queryKey: ['timeline', enc.data?.patientId], queryFn: () => get(`/patients/${enc.data.patientId}/timeline`), enabled: !!enc.data });
  const docs = useQuery({ queryKey: ['documents', enc.data?.patientId], queryFn: () => get(`/patients/${enc.data.patientId}/documents`), enabled: !!enc.data });
  const canFinish = can(perms, 'encounter.complete') || can(perms, 'encounter.*'); // signs the prescription; the junior saves and hands back
  const isDoctor = canFinish || can(perms, 'encounter.intake'); // the full pad, with every template: the same for the doctor and the junior
  const tpls = useQuery({ queryKey: ['rx-templates'], queryFn: () => get('/rx-templates'), enabled: isDoctor });
  const stock = useQuery({ queryKey: ['encounters-stock'], queryFn: () => get('/encounters-stock'), enabled: isDoctor, staleTime: 60_000 });
  const sets = useTemplates();
  const freqRx = useQuery<{ name: string }[]>({ queryKey: ['encounters-frequent'], queryFn: () => get('/encounters-frequent'), enabled: isDoctor, staleTime: 300_000 });
  const padMods = usePadModules(isDoctor); const [modDrawer, setModDrawer] = useState<{ edit?: PadModule } | null>(null);
  const photos = usePhotos(enc.data?.patientId);
  const [data, setData] = useState<Record<string, any>>({});
  const [rx, setRx] = useState<RxItem[]>([]);
  const [recs, setRecs] = useState<Rec[]>([]);
  const [errors, setErrors] = useState<{ path: string; message: string }[]>([]);
  const [showMissing, setShowMissing] = useState(false); // Finish was tried: list what is still missing until it is complete
  const [savedAt, setSavedAt] = useState<string>('');
  const [side, setSideS] = useState<string | null>(null); const [sideDirty, setSideDirty] = useState(0); // the open summary drawer, and how much in it is not saved
  const setSide = (k: string | null) => { setSideDirty(0); setSideS(k); }; // Stacked: the left column's open drawer (vitals, history, notes, records, results, canvas)
  const [viewing, setViewing] = useState<string | null>(null);
  const [testDraft, setTestDraft] = useState('');
  const [applied, setApplied] = useState<string | null>(null); const undo = useRef<{ data: any; rx: RxItem[]; recs: Rec[] } | null>(null);
  const [tplOpen, setTplOpen] = useState(false); const [tplQ, setTplQ] = useState(''); const [tplSel, setTplSel] = useState<any>(null); const tplBtn = useRef<HTMLButtonElement>(null);
  const [setNote, setSetNote] = useState('');
  useEffect(() => { if (!setNote) return; const t = setTimeout(() => setSetNote(''), 30_000); return () => clearTimeout(t); }, [setNote]); // the "Loaded from …" note closes by itself after 30 s
  // opened from Review on the doctor's Today (?review): the Rxpad at Lab investigations, where the values and reports are
  const [sp, setSp] = useSearchParams(); const wantReview = useRef(!!sp.get('review'));
  // the pad's one design (v68, "Calm"; Classic was removed on 13 Nov 2026)
  const [addedSecs, setAddedSecs] = useState<Set<string>>(new Set()); // optional sections opened from 'Add a section'
  const [tab, setTab] = useState<'pad' | 'visits' | 'photos' | 'docs'>('pad');
  useEffect(() => {
    if (!loaded.current || !canFinish || !enc.data || ['completed', 'awaiting_reports'].includes(enc.data.status) || recs.some((r) => r.kind === 'followup')) return;
    const k = `pad.fu-default.${id}`; try { if (localStorage.getItem(k)) return; localStorage.setItem(k, '1'); } catch { return; }
    setRecs((cur) => (cur.some((r) => r.kind === 'followup') ? cur : [...cur, { kind: 'followup' as const, intervalDays: 30 }]));
  }, [recs, enc.data?.status]); // the pad, or one of the patient's collections beside it
  useEffect(() => { if (sp.get('review')) { const n = new URLSearchParams(sp); n.delete('review'); setSp(n, { replace: true }); } }, []);
  const keys = useRef<(ev: KeyboardEvent) => void>(() => {}); // the pad's keys; the handler is set each render below
  useEffect(() => { const f = (ev: KeyboardEvent) => keys.current(ev); window.addEventListener('keydown', f); return () => window.removeEventListener('keydown', f); }, []);
  const goTo = (k: string) => document.getElementById(`sec-${k}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  // the cards draw a moment after the consultation loads: wait for Lab investigations, then bring it (and Lab results below it) up
  useEffect(() => {
    if (!wantReview.current || !enc.data) return; wantReview.current = false;
    // ponytail: the pad's load (focus on the type-anything bar) scrolls back to the top, so it scrolls once more after it settles
    const up = () => document.getElementById('sec-tests')?.scrollIntoView({ block: 'start' });
    let n = 0, later: any; const t = setInterval(() => { if (document.getElementById('sec-tests') || ++n > 40) { clearInterval(t); up(); later = setTimeout(up, 900); } }, 150);
    return () => { clearInterval(t); clearTimeout(later); };
  }, [!!enc.data]);
  const [capture, setCapture] = useState(false); const [compare, setCompare] = useState<[any, any] | null>(null);
  const loaded = useRef(false); const dirty = useRef(false); const justLoaded = useRef(false);
  const edits = useRef(0); // counts changes, so a save that was on its way while the doctor kept typing does not mark the pad saved
  const [signing, setSigning] = useState(false); // Finish → the sign-off sheet, showing the paper as it prints
  const [checking, setChecking] = useState<string[] | null>(null); // serious warnings waiting for the doctor's reasons
  // a draft save that never reached the server is kept on this computer per pad, and offered back when the pad opens again
  const localKey = `pad-draft:${id}`;
  type Kept = { at: number; data: Record<string, any>; rx: RxItem[]; recs: Rec[] };
  const [restore, setRestore] = useState<Kept | null>(null);
  const previous = (timeline.data?.encounters ?? []).filter((x: any) => x.id !== id);
  const lastDone = previous.find((x: any) => x.status === 'completed');
  useEffect(() => {
    if (enc.data && timeline.data && !loaded.current) {
      // Complaints typed at arrival pre-fill the pad so nobody types them twice; a review carries the diagnosis forward.
      const arrival: Sym[] = (enc.data.visit?.details?.complaints ?? []).map((c: any) => ({ name: c.text, ...(c.duration ? { since: c.duration } : {}) }));
      let d = { ...(enc.data.data ?? {}) };
      if (!asSym(d.complaint?.chief_complaint).length && arrival.length) d = { ...d, complaint: { ...(d.complaint ?? {}), chief_complaint: arrival } };
      if (isDoctor && enc.data.status === 'draft' && (isReviewVisit(enc.data.visit, cfg) || (lastDone?.prescription ?? []).length > 0) && !asDx(d.assessment?.diagnosis).length && lastDone?.data?.assessment?.diagnosis) d = { ...d, assessment: { ...(d.assessment ?? {}), diagnosis: lastDone.data.assessment.diagnosis } };
      loaded.current = true; justLoaded.current = true; setData(d); setRx(enc.data.prescription.map(own));
      const opened = new Date(new Date(enc.data.createdAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) + 'T00:00:00Z').getTime();
      setRecs(enc.data.recommendations.map((r: any) => ({ id: r.id, status: r.status, orderNo: r.orderNo, kind: r.kind, procedureId: r.procedureId, dueOn: r.dueOn, sittings: r.sittings, gapDays: r.gapDays ?? undefined, amountPaise: r.amountPaise ?? null, package: r.package ?? null, notes: r.notes,
        intervalDays: r.kind === 'followup' && r.dueOn ? Math.round((new Date(r.dueOn + 'T00:00:00Z').getTime() - opened) / 86400000) : undefined })));
      // a copy kept on this computer that is newer than the server's: offer it back; an older one, or one for a signed pad, goes
      let kept: Kept | null = null; try { kept = JSON.parse(localStorage.getItem(localKey) ?? 'null'); } catch { kept = null; }
      if (kept) {
        const server = Date.parse(enc.data.provenance?.lastEditedAt ?? '') || 0;
        if (enc.data.status === 'completed' || !(kept.at > server)) { try { localStorage.removeItem(localKey); } catch { /* private mode */ } }
        else setRestore(kept);
      }
    }
  }, [enc.data, timeline.data]);
  const cleanRx = () => rx.filter((i) => i.name).map(({ _qtyTouched, _issued, ...i }) => i);
  // the last save did not reach the server: 'kept' when a copy is on this computer and will be sent again, 'failed' for anything else
  const [saveFailed, setSaveFailed] = useState<false | 'kept' | 'failed'>(false);
  const save = useMutation({
    // d: the data to send when it was changed in the same tick (the reason given at Finish), before React has re-rendered
    mutationFn: ({ complete, d, back, reviewed }: { complete: boolean; back?: boolean; reviewed?: boolean; d?: Record<string, any> }) => patch(`/encounters/${id}`, { reviewed: !!reviewed, data: d ?? data, prescription: cleanRx(), recommendations: recs.filter((r) => r.kind !== 'investigation' || (r.notes && r.status !== 'done')), complete, screened: !!back && !canFinish }),
    onMutate: () => edits.current,
    onSuccess: (_e, { complete, back }, sentAt) => {
      if (!restore) try { localStorage.removeItem(localKey); } catch { /* private mode */ } // still offered back: the copy stays until the doctor picks
      if (complete) { setErrors([]); setShowMissing(false); setSigning(false); } if (sentAt === edits.current) dirty.current = false; setSaveFailed(false); setSavedAt(new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }));
      ['queue', 'frontdesk', 'timeline'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      qc.invalidateQueries({ queryKey: ['print', id] }); // print never shows what was there before this save
      if (complete && held) { toast('Consultation completed'); openPrint({ title: 'Results sheet', rx: id, mode: 'results' }); nav('/today', { viewTransition: true }); }
      else if (complete) { toast(willHold ? 'Prescription issued · held open for the reports' : 'Consultation completed'); openPrint({ title: 'Prescription', rx: id }); nav(canFinish ? '/today' : '/queue', { viewTransition: true }); }
      else if (back && held) { toast('Kept open for the rest of the reports'); nav('/today', { viewTransition: true }); }
      else if (back) { toast('Intake saved · ready for the doctor'); nav('/queue', { viewTransition: true }); }
    },
    onError: (e: any, vars) => {
      if (e instanceof ApiError && e.body.code === 'FORM_INVALID') { setSigning(false); setErrors(e.body.errors); toast(`Please fill in: ${e.body.errors.map((x: any) => x.message?.replace(/ is required$/, '') || x.path.split('.')[1]).slice(0, 3).join(', ')}`, 'err'); setTimeout(() => document.querySelector('[data-invalid="true"]')?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 80); return; }
      if (e instanceof ApiError && e.body.code === 'RX_NEEDS_REASON') { setSigning(false); setChecking(e.body.warnings ?? []); return; } // the server's own check: ask for the reasons it named
      // only a draft is ever kept and sent again, never Finish; kept when the internet or the server is down (or the sign-in ran out)
      const transient = !(e instanceof ApiError) || e.status === 0 || e.status === 401 || e.status >= 500;
      if (!vars.complete && transient) { try { localStorage.setItem(localKey, JSON.stringify({ at: Date.now(), data: vars.d ?? data, rx, recs })); } catch { /* private mode */ } }
      const kept = !vars.complete && transient ? 'kept' : 'failed';
      if (saveFailed !== kept) toast(kept === 'kept' ? 'Not saved — kept on this computer, will send when the internet is back.' : errText(e), 'err'); // once, not every 15 seconds
      setSaveFailed(kept);
    },
  });
  // opening the pad is not an edit: the first render after loading does not mark it dirty, so nothing is saved until something changes
  useEffect(() => { if (justLoaded.current) { justLoaded.current = false; return; } if (loaded.current) { dirty.current = true; edits.current++; } }, [data, rx, recs]);
  // back online: send what was kept at once instead of waiting for the next 15-second save
  useEffect(() => { const f = () => { if (loaded.current && dirty.current && enc.data?.status !== 'completed') save.mutate({ complete: false }); }; window.addEventListener('online', f); return () => window.removeEventListener('online', f); }, [enc.data?.status]);
  useEffect(() => { const t = setInterval(() => { if (loaded.current && dirty.current && enc.data?.status !== 'completed' && !save.isPending) save.mutate({ complete: false }); }, 15000); return () => clearInterval(t); }, [enc.data?.status, save.isPending]);
  useEffect(() => { const f = () => { if (loaded.current && dirty.current && enc.data?.status !== 'completed') save.mutate({ complete: false }); }; window.addEventListener('app:save-now', f); return () => window.removeEventListener('app:save-now', f); }, [enc.data?.status]);
  // closing the tab with changes not yet saved asks first
  useEffect(() => { const f = (ev: BeforeUnloadEvent) => { if (loaded.current && dirty.current && enc.data?.status !== 'completed') { ev.preventDefault(); ev.returnValue = ''; } }; window.addEventListener('beforeunload', f); return () => window.removeEventListener('beforeunload', f); }, [enc.data?.status]);

  // --- section templates: an "auto" one is added when its complaint or diagnosis comes up; nothing is added twice ---
  const cNames = complaintTexts(enc.data?.visit?.details, data.complaint?.chief_complaint);
  const dNames = asDx(data.assessment?.diagnosis).map((d) => norm(d.name));
  const appliedIds: string[] = data.screen?.applied ?? [];
  const markApplied = (tid: string) => setData((d) => ({ ...d, screen: { ...(d.screen ?? {}), applied: uniq([...(d.screen?.applied ?? []), tid]) } }));
  // lab tests are one simple order: no splitting into separate orders
  const addTestNamed = (name: string) => setRecs((cur) => {
    const v = name.trim(); if (!v || cur.some((r) => r.kind === 'investigation' && r.notes?.toLowerCase() === v.toLowerCase())) return cur;
    return [...cur, { kind: 'investigation', notes: v, orderNo: 1 }];
  });
  const addSyms = (xs: Sym[]) => setData((d) => { const cur = asSym(d.complaint?.chief_complaint); const have = new Set(cur.map((s) => norm(s.name))); return { ...d, complaint: { ...(d.complaint ?? {}), chief_complaint: [...cur, ...xs.filter((x) => !have.has(norm(x.name)))] } }; });
  const addDxs = (xs: Dx[]) => setData((d) => { const cur = asDx(d.assessment?.diagnosis); const have = new Set(cur.map((s) => norm(s.name))); return { ...d, assessment: { ...(d.assessment ?? {}), diagnosis: [...cur, ...xs.filter((x) => !have.has(norm(x.name)))] } }; });
  const addRxMany = (items: RxItem[]) => setRx((cur) => { const h = new Set(cur.filter((r) => r.name).map((r) => r.name.toLowerCase())); return [...cur.filter((r) => r.name), ...items.filter((i) => !h.has(i.name.toLowerCase())).map((i) => withQty({ ...i }))]; });
  const addExam = (xs: ExamRow[]) => setData((d) => { const cur = asExam(d.exam); const have = new Set(cur.map((x) => norm(x.name))); return { ...d, exam: { ...(d.exam ?? {}), items: [...cur, ...xs.filter((x) => x.name?.trim() && !have.has(norm(x.name)))] } }; });
  const addAdvice = (lines: string[]) => setData((d) => { const c = String(d.plan?.advice ?? '').split('\n').map((x) => x.trim()).filter(Boolean); return { ...d, plan: { ...(d.plan ?? {}), advice: uniq([...c, ...lines.map((l) => l.trim()).filter(Boolean)]).join('\n') } }; });
  const applySet = (t: Tmpl): string => {
    const p = t.payload ?? {}; let added = 0, had = 0;
    const count = (names: string[], have: string[]) => names.forEach((n) => (have.includes(norm(n)) ? had++ : added++));
    if (t.kind === 'medicine') { count((p.items ?? []).map((i: RxItem) => i.name), rx.filter((r) => r.name).map((r) => norm(r.name))); addRxMany(p.items ?? []); }
    else if (t.kind === 'advice') { count(p.lines ?? [], String(data.plan?.advice ?? '').split('\n').map((x) => norm(x))); addAdvice(p.lines ?? []); }
    else if (t.kind === 'finding') { const rows: ExamRow[] = [...(p.items ?? []), ...(p.chips ?? []).map((name: string) => ({ name }))]; count(rows.map((x) => x.name), asExam(data.exam).map((x) => norm(x.name))); addExam(rows); }
    else if (t.kind === 'notes') { count([p.text], [norm(data.plan?.notes ?? '')]); setData((d) => ({ ...d, plan: { ...(d.plan ?? {}), notes: [d.plan?.notes, p.text].filter(Boolean).join('\n') } })); }
    else if (t.kind === 'tests') { count((p.tests ?? []).map((x: any) => x.name), recs.filter((r) => r.kind === 'investigation').map((r) => norm(r.notes ?? ''))); for (const x of p.tests ?? []) addTestNamed(x.name); const notes = (p.tests ?? []).filter((x: any) => x.note); if (notes.length) setData((d) => ({ ...d, plan: { ...(d.plan ?? {}), testNotes: { ...(d.plan?.testNotes ?? {}), ...Object.fromEntries(notes.map((x: any) => [x.name, x.note])) } } })); }
    else if (t.kind === 'symptom') { count((p.items ?? []).map((x: Sym) => x.name), asSym(data.complaint?.chief_complaint).map((s) => norm(s.name))); addSyms(p.items ?? []); }
    else if (t.kind === 'diagnosis') { count((p.items ?? []).map((x: Dx) => x.name), dNames); addDxs(p.items ?? []); }
    else if (t.kind === 'procedure') { if (recs.some((r) => r.kind === 'procedure' && r.procedureId === p.procedureId)) had++; else { added++; setRecs((cur) => (cur.some((r) => r.kind === 'procedure' && r.procedureId === p.procedureId) ? cur : [...cur, { kind: 'procedure', procedureId: p.procedureId, sittings: p.sittings, gapDays: p.intervalDays || gapFor(p.procedureId) }])); } }
    markApplied(t.id); post(`/templates/${t.id}/use`).catch(() => {});
    return `${t.name}: ${added ? `added ${added}` : 'nothing new'}${had ? `, ${had} already there` : ''}.`;
  };
  const autoKey = (sets.data ?? []).filter((t) => t.mode === 'auto' && !appliedIds.includes(t.id) && suggests(t, cNames, dNames)).map((t) => t.id).join(',');
  useEffect(() => {
    if (!loaded.current || !isDoctor || enc.data?.status === 'completed' || !autoKey) return;
    // added by default: the rows themselves show it, no banner
    (sets.data ?? []).filter((t) => autoKey.split(',').includes(t.id)).forEach(applySet);
  }, [autoKey, enc.data?.status, isDoctor]);
  /** Save one section as a set: suggested the next time the same complaint or diagnosis comes up. */
  const saveSection = async (kind: TmplKind) => {
    const payload = kind === 'medicine' ? { items: cleanRx() } : kind === 'advice' ? { lines: String(data.plan?.advice ?? '').split('\n').map((x) => x.trim()).filter(Boolean) }
      : kind === 'tests' ? { tests: recs.filter((r) => r.kind === 'investigation' && r.notes).map((r) => ({ name: r.notes!, ...(data.plan?.testNotes?.[r.notes!] ? { note: data.plan.testNotes[r.notes!] } : {}) })) }
      : kind === 'symptom' ? { items: asSym(data.complaint?.chief_complaint) } : kind === 'diagnosis' ? { items: asDx(data.assessment?.diagnosis) }
      : kind === 'notes' ? { text: [String(data.plan?.notes ?? '').trim()].filter(Boolean) } : { items: asExam(data.exam) };
    const what = { medicine: 'medicines', advice: 'advice', tests: 'tests', symptom: 'symptoms', diagnosis: 'diagnosis', finding: 'findings', notes: 'notes' }[kind as string] ?? kind;
    if (!(Object.values(payload)[0] as any[]).length) return toast(`There is nothing to save yet: no ${what}.`, 'info');
    if (kind === 'notes') (payload as any).text = (payload as any).text[0];
    const r = await ask({ title: `Save the ${what} as a template`, body: 'It appears under Templates on this section, ready the next time the same complaint or diagnosis comes up.', confirmLabel: 'Save', field: { label: 'Name', required: true, initial: asDx(data.assessment?.diagnosis).map((d) => d.name).join(' + ') || '', maxLength: 80 } });
    if (!r?.value || r.value.trim().length < 2) return;
    try { const row: any = await post('/templates', { kind, name: r.value.trim(), linked: { complaints: cNames, diagnoses: dNames }, payload }); qc.invalidateQueries({ queryKey: ['templates'] }); toast(row.draft ? 'Saved. The owner approves it before it is suggested.' : 'Saved as a template'); } catch (e) { toast(errText(e), 'err'); }
  };
  const saveTpl = useMutation({ mutationFn: (name: string) => post('/rx-templates', { name, data, prescription: cleanRx(), recommendations: recs }), onSuccess: (r: any) => { qc.invalidateQueries({ queryKey: ['rx-templates'] }); toast(`Saved as template “${r.name}”`); }, onError: (e) => toast(errText(e), 'err') });

  if (!enc.data || !timeline.data) return <div className="card"><Skeleton rows={5} /></div>;
  const e = enc.data; const p = e.patient; const held = e.status === 'awaiting_reports'; const readOnly = e.status === 'completed' || (held && !canFinish);
  const testRecs: any[] = e.recommendations.filter((r: any) => r.kind === 'investigation' && r.status !== 'cancelled'); const testsIn = testRecs.filter((r: any) => r.status === 'done').length; const testsOpen = testRecs.length > testsIn;
  const willHold = !held && recs.some((r) => r.kind === 'investigation' && r.notes && r.status !== 'done'); // what Finish will do with the tests on the pad right now
  const set = (s: string, k: string, v: any) => { setErrors((er) => er.filter((x) => x.path !== `${s}.${k}`)); setData((d) => ({ ...d, [s]: { ...(d[s] ?? {}), [k]: v } })); };
  const err = (s: string, k: string) => missingList.find((x) => x.path === `${s}.${k}`)?.message; // missingList is built below; err runs at render time
  const meds: any[] = cfg?.medicines ?? [];
  const lastRx: RxItem[] = (lastDone?.prescription ?? []).map(strip);
  const isReview = isDoctor && !!lastDone && lastRx.length > 0;
  const visitNo = previous.length + 1;
  const onHand = (i: RxItem) => (i.medicineId && stock.data ? stock.data[i.medicineId] ?? 0 : null);
  const addRx = (item: RxItem) => { if (rx.some((r) => r.name && r.name.trim().toLowerCase() === item.name.trim().toLowerCase())) return toast('Already on the prescription', 'info'); setRx((cur) => [...cur.filter((r) => r.name), withQty(item)]); };
  const addRxByName = (name: string) => { const m = meds.find((x: any) => x.name === name); addRx({ name, medicineId: m?.id ?? null, dose: m?.defaults?.dose, route: m?.defaults?.route, frequency: m?.defaults?.frequency, durationDays: m?.defaults?.durationDays, instructions: m?.defaults?.instructions }); };
  const applyTpl = (t: any) => {
    undo.current = { data, rx, recs };
    const keep = data.review ? { review: data.review } : {};
    setData({ ...t.data, ...keep, complaint: { ...(t.data.complaint ?? {}), ...(asSym(data.complaint?.chief_complaint).length ? { chief_complaint: data.complaint.chief_complaint } : {}) } });
    setRx(t.prescription.map((i: any) => withQty({ ...i }))); setRecs(t.recommendations.map((r: any) => ({ ...r })));
    setApplied(t.name); setTplOpen(false); setTplSel(null); post(`/rx-templates/${t.id}/use`).then(() => qc.invalidateQueries({ queryKey: ['rx-templates'] }), () => {});
  };
  const clearLoaded = () => { if (undo.current) { setData(undo.current.data); setRx(undo.current.rx); setRecs(undo.current.recs); undo.current = null; } setApplied(null); };
  const askTpl = async () => {
    const r = await ask({ title: 'Save the whole pad as a template', body: 'Saves symptoms, findings, diagnosis, medicines, advice and plan. Using the same name again updates it.', confirmLabel: 'Save', field: { label: 'Template name', required: true, initial: asDx(data.assessment?.diagnosis).map((d) => `${d.name}${d.severity ? ` · ${d.severity.toLowerCase()}` : ''}`).join(' + ') || '', maxLength: 80 } });
    if (r?.value && r.value.trim().length >= 2) saveTpl.mutate(r.value.trim());
  };
  const loadPrevious = (x: any, parts: Record<string, boolean>) => {
    if (parts.sx) addSyms(asSym(x.data?.complaint?.chief_complaint));
    if (parts.ex) addExam([...asExam(x.data?.exam), ...Object.entries(x.data?.exam ?? {}).filter(([k]) => k !== 'items').flatMap(([, v]: any) => (Array.isArray(v) ? v : v && typeof v === 'string' ? [v] : [])).map((name: string) => ({ name }))]);
    if (parts.dx) addDxs(asDx(x.data?.assessment?.diagnosis));
    if (parts.rx) addRxMany((x.prescription ?? []).map(strip));
    if (parts.advice && x.data?.plan?.advice) addAdvice(String(x.data.plan.advice).split('\n'));
    if (parts.tests) for (const r of (x.recommendations ?? []).filter((r: any) => r.kind === 'investigation' && r.notes)) addTestNamed(r.notes);
    setSetNote(`Added from the visit of ${fmtDate(x.createdAt)}. Lines already on the pad were not added twice.`);
  };
  /** The type-anything bar: a line is filed where it belongs by matching the clinic's lists; when nothing matches, the doctor says where. */
  const smartAdd = (raw: string, as?: 'symptom' | 'diagnosis' | 'medicine' | 'test' | 'advice') => {
    const v = raw.trim(); if (!v) return; const lc = v.toLowerCase();
    const it = parseRxLine(v, meds);
    const dxOpt = [...DX_OPTIONS, ...(dxField?.options ?? [])].find((o) => o.toLowerCase() === lc || (lc.length >= 4 && o.toLowerCase().startsWith(lc)));
    const testOpt = ((cfg?.labTests ?? TESTS) as string[]).find((o) => o.toLowerCase() === lc) ?? (cfg?.labParams ?? []).find((o: any) => o.name.toLowerCase() === lc)?.name;
    // "itching 2 weeks" → the symptom Itching since 2 weeks
    const m = v.match(/^(.*?)\s+(?:since\s+|for\s+|x\s*)?(\d+\s*(?:d|days?|w|wks?|weeks?|m|months?|y|years?))$/i);
    const base = (m ? m[1] : v).trim().toLowerCase();
    const symOpt = (symField?.options ?? []).find((o: string) => o.toLowerCase() === base || o.toLowerCase().startsWith(base) || base.startsWith(o.toLowerCase()));
    const kind = as ?? (it?.medicineId ? 'medicine' : testOpt ? 'test' : dxOpt ? 'diagnosis' : symOpt ? 'symptom' : null);
    if (!kind) return;
    if (kind === 'medicine') addRx(it ?? { name: v }); else if (kind === 'test') addTestNamed(testOpt ?? v); else if (kind === 'diagnosis') addDxs([{ name: dxOpt ?? v }]);
    else if (kind === 'advice') addAdvice([v]); else addSyms([{ name: symOpt ?? (m ? m[1].trim() : v), ...(m ? { since: m[2] } : {}) }]);
  };
  // the medicine name plus its generic when the catalogue has one, so a brand is caught by what it is
  const medOf = (i: RxItem) => meds.find((m: any) => m.id && m.id === i.medicineId);
  const medText = (i: RxItem) => `${i.name} ${medOf(i)?.generic ?? ''} ${medOf(i)?.allergyClass ?? ''}`;
  const allergyWarnings = rx.filter((i) => i.name).map((i) => [i.name, allergyHit(p.allergies, medText(i))] as const).filter(([, w]) => w);
  const pregnant = pregnancyFlag(p.history);
  // allergy, same medicine twice, pregnancy, interactions; the serious ones stop Finish until the doctor gives a reason (the server checks the same)
  const problems = isDoctor ? rxProblems(rx.filter((i) => i.name).map((i) => ({ name: i.name, generic: medOf(i)?.generic, allergyClass: medOf(i)?.allergyClass })), { name: firstName(p.fullName), allergies: p.allergies, pregnant }) : [];
  const warnings = problems.map((x) => x.text);
  const allOverrides: Override[] = Array.isArray(data.overrides) ? data.overrides : [];
  const unanswered = needsReason(problems, allOverrides);
  const overrides = allOverrides.filter((o) => o.warnings.some((w) => warnings.includes(w))); // the reasons that still apply, listed on the sign-off sheet
  const amended = e.status === 'draft' && (e.amendments ?? []).length > 0;
  const followup = recs.find((r) => r.kind === 'followup');
  const setFollowup = (d: number | null) => setRecs([...recs.filter((r) => r.kind !== 'followup'), ...(d ? [{ kind: 'followup' as const, intervalDays: d }] : [])]);
  const addTest = (name: string) => { setTestDraft(''); addTestNamed(name); };
  const tests = recs.filter((r) => r.kind === 'investigation' && r.notes);
  const adviceText: string = data.plan?.advice ?? '';
  const adviceLines = adviceText.split('\n').map((x) => x.trim()).filter(Boolean);
  const toggleAdvice = (a: string) => set('plan', 'advice', (adviceLines.includes(a) ? adviceLines.filter((x) => x !== a) : [...adviceLines, a]).join('\n'));
  const formSections: any[] = e.form.sections;
  const symField: Field | undefined = formSections.find((s) => s.key === 'complaint')?.fields.find((f: Field) => f.key === 'chief_complaint');
  const dxField: Field | undefined = formSections.flatMap((s) => s.fields).find((f: Field) => f.type === 'diagnoses');
  const otherFields = (key: string, skip: string[]) => (formSections.find((s) => s.key === key)?.fields ?? []).filter((f: Field) => !skip.includes(f.key) && f.type !== 'diagnoses');
  const customSections = formSections.filter((s) => !['complaint', 'exam', 'assessment', 'plan'].includes(s.key));
  const tplList: any[] = (tpls.data ?? []).filter((t: any) => !tplQ || t.name.toLowerCase().includes(tplQ.toLowerCase()));
  const ph: any[] = photos.data?.photos ?? [];
  const lastArea = ph[0]?.area; const sameArea = ph.filter((x) => x.area === lastArea);
  const thenNow: [any, any] | null = sameArea.length >= 2 ? [sameArea[sameArea.length - 1], sameArea[0]] : null;
  const myDocs = docs.data ?? [];
  const lists = checklists(cNames, sets.data ?? []);
  const answers: Answers = data.screen?.answers ?? {}; const hist: History = data.screen?.history ?? {};
  const arrivalText = ((e.visit?.details?.complaints ?? []) as { text: string; duration?: string }[]).map((c) => (c.duration ? `${c.text} · ${c.duration}` : c.text)).join(', ');
  const syms = asSym(data.complaint?.chief_complaint); const dxs = asDx(data.assessment?.diagnosis);
  const setSyms = (xs: Sym[]) => set('complaint', 'chief_complaint', xs); const setDxs = (xs: Dx[]) => set('assessment', 'diagnosis', xs);
  const pad: { key: string; show: boolean; required: boolean; print: boolean }[] = cfg?.pad ?? [];
  const padOf = (k: string) => pad.find((s) => s.key === k) ?? { key: k, show: true, required: false, print: true };
  const printOut: boolean = data.labs?.printOutOfRangeOnly ?? cfg?.printRx?.outOfRangeOnly ?? true;
  const recIds: string[] = (e.recommendations ?? []).map((r: any) => r.id);
  const leaflets = rx.filter((i) => i.medicineId).map((i) => meds.find((m: any) => m.id === i.medicineId)).filter((m: any) => m?.leafletUrl);
  const upd = (k: number, patchI: Partial<RxItem>) => setRx(rx.map((r, j) => { if (j !== k) return r; const n = { ...r, ...patchI }; return 'qty' in patchI ? { ...n, _qtyTouched: true } : n._qtyTouched ? n : { ...n, qty: qtyFor(n) ?? undefined }; }));
  /** Finish: the clinic's required sections are checked here in words; the form's own required fields are checked by the server. */
  /** Everything Finish needs that is still empty, as the same {path, message} rows the server sends, so the rows light up and the footer lists them. */
  const missingNow = (): { path: string; message: string }[] => {
    const out: { path: string; message: string }[] = [];
    if (padOf('symptoms').required && !syms.length) out.push({ path: 'complaint.chief_complaint', message: 'Symptoms is required' });
    if (padOf('diagnosis').required && !dxs.length) out.push({ path: 'assessment.diagnosis', message: 'Diagnosis is required' });
    if (padOf('advice').required && !adviceLines.length) out.push({ path: 'advice._', message: 'Advice is required' });
    if (padOf('tests').required && !tests.length) out.push({ path: 'tests._', message: 'Tests is required' });
    if (padOf('followup').required && !followup?.intervalDays) out.push({ path: 'followup._', message: 'Follow-up is required' });
    if (padOf('procedures').required && !recs.some((r) => r.kind === 'procedure')) out.push({ path: 'procedures._', message: 'Procedures is required' });
    if (padOf('referral').required && !data.referral?.to?.trim()) out.push({ path: 'referral._', message: 'Referral is required' });
    if (padOf('exam').required && !asExam(data.exam).length) out.push({ path: 'exam._', message: 'Examination is required' });
    if (padOf('medicines').required && !rx.some((i) => i.name)) out.push({ path: 'medicines._', message: 'Medicines is required' });
    // a medicine line must say how often and for how long, or it prints as a bare name
    if (canFinish && padOf('medicines').required) rx.forEach((i, k) => { if (!i.name || i._issued) return; const gap = [!i.frequency?.trim() && 'how often', !i.durationDays && !i.durationNote && 'for how many days'].filter(Boolean).join(' and '); if (gap) out.push({ path: `medicines.${k}`, message: `Add ${gap} for ${i.name}` }); });
    for (const s of formSections as any[]) for (const f of (s.key === 'exam' ? [] : s.fields ?? []) as Field[]) { const v = data[s.key]?.[f.key]; const req = s.key === 'complaint' && f.key === 'chief_complaint' ? padOf('symptoms').required : f.type === 'diagnoses' ? padOf('diagnosis').required : f.required; if (req && !(Array.isArray(v) ? v.length : v) && !out.some((x) => x.path === `${s.key}.${f.key}`)) out.push({ path: `${s.key}.${f.key}`, message: `${(s.fields as Field[]).filter((x) => x.required).length > 1 ? `${s.title} › ${f.label}` : f.label} is required` }); }
    return out;
  };
  const finish = () => { if (!canFinish) return;
    if (signing) return sign(); // Ctrl+Enter again on the sign-off sheet signs
    const missing = missingNow();
    if (missing.length) { setShowMissing(true); goTo(secOf(missing[0].path)); toast(`Cannot finish yet: ${missing.map((m) => m.message.replace(/ is required$/, '')).join(', ')}`, 'err'); return; } // Focused and Review: the bar lists it, no toast on top
    // allergy, pregnancy or a serious interaction: a reason for each first (kept in data.overrides, never printed)
    if (unanswered.length) { setChecking(unanswered); return; }
    if (held) { // after the reports: the prescription was signed when it went out
      if (!testsOpen) return save.mutate({ complete: true });
      const left = testRecs.filter((r: any) => r.status !== 'done').map((r: any) => r.notes || 'a test').join(', ');
      // results not added yet: Complete means the doctor saw them another way (paper reports); said out loud first
      void ask({ title: `No result added for ${left}. Complete anyway?`, body: 'Complete marks them as seen (for example the patient brought the paper reports) and closes the consultation. The desk can still add those reports later. To wait for them instead, choose Keep open for the rest.', confirmLabel: 'Complete', cancelLabel: 'Go back' }).then((ok) => { if (ok) save.mutate({ complete: true }); });
      return;
    }
    void toSheet(data);
  };
  /** Save first, so the sign-off sheet shows exactly what will print; a failed save does not open it. */
  const toSheet = async (d: Record<string, any>) => {
    try { await save.mutateAsync({ complete: false, d }); } catch { return; }
    await qc.invalidateQueries({ queryKey: ['print', id] });
    setSigning(true);
  };
  const sign = () => save.mutate({ complete: true });
  const giveReasons = (reasons: Record<string, string>) => {
    const at = new Date().toISOString();
    const d = { ...data, overrides: [...allOverrides, ...(checking ?? []).map((w) => ({ at, warnings: [w], reason: reasons[w].trim() }))] };
    setData(d); setChecking(null);
    if (held) save.mutate({ complete: true, d }); else void toSheet(d);
  };
  /** Amend after signing: a reason is required; it is audited and prints on the prescription. */
  const amend = async () => {
    const r = await ask({ title: 'Amend the signed prescription', body: 'The pad opens again for changes. The reason prints on the prescription as “Amended” and is kept in the audit log.', confirmLabel: 'Amend', field: { label: 'Reason for the change', required: true, maxLength: 300 } });
    if (!r) return;
    const reason = r.value.trim(); if (reason.length < 3) return toast('Give a reason of at least 3 letters.', 'err');
    try { await post(`/encounters/${id}/amend`, { reason }); loaded.current = false; await qc.invalidateQueries({ queryKey: ['encounter', id] }); qc.invalidateQueries({ queryKey: ['print', id] }); toast('Open for changes. Finish signs it again.'); }
    catch (err) { // already open for changes (a second click, or another computer amended it): just show the open pad
      if (err instanceof ApiError && err.body?.code === 'NOT_SIGNED') { loaded.current = false; await qc.invalidateQueries({ queryKey: ['encounter', id] }); return; }
      toast(errText(err), 'err'); }
  };
  /** Preview prints what is saved: save first and wait for it; a failed save does not open a preview of older data. */
  const preview = async () => {
    if (dirty.current) { try { await save.mutateAsync({ complete: false }); } catch { return; } }
    await qc.invalidateQueries({ queryKey: ['print', id] });
    openPrint({ title: 'Prescription preview', rx: id });
  };
  // what the footer lists: the live check once Finish was tried, plus anything the server still rejected
  const live = showMissing ? missingNow() : [];
  const missingList = [...live, ...errors.filter((e) => !live.some((m) => m.path === e.path))];
  const clearSection = async (what: string, fn: () => void) => { const r = await ask({ title: `Clear ${what}?`, body: 'Everything in this section goes; the rest of the pad stays.', confirmLabel: 'Clear', tone: 'danger' }); if (r) fn(); };

  // --- the cards, in the clinic's order: Eka's shape, one card per section, rows first and the search line last ---
  const secOf = (path: string) => ({ complaint: 'symptoms', assessment: 'diagnosis', exam: 'exam', plan: 'advice' } as Record<string, string>)[path.split('.')[0]] ?? path.split('.')[0];
  const bad = (k: string) => missingList.some((x) => secOf(x.path) === k);
  // each section's templates (T·Sx, T·Dx …) and how to clear it: used by the one Templates and Clear in the toolbar, for the open section
  const SECTION_TPL: Record<string, [TmplKind, string, string, (() => void) | null]> = {
    symptoms: ['symptom', 'Sx', 'symptoms', syms.length ? () => clearSection('the symptoms', () => setSyms([])) : null],
    diagnosis: ['diagnosis', 'Dx', 'diagnosis', dxs.length ? () => clearSection('the diagnosis', () => setDxs([])) : null],
    exam: ['finding', 'Ex', 'findings', asExam(data.exam).length ? () => clearSection('the examination', () => setData((d) => ({ ...d, exam: {} }))) : null],
    medicines: ['medicine', 'Rx', 'medicines', rx.some((i) => i.name && !i._issued) ? () => clearSection('the medicines', () => setRx(rx.filter((i) => i._issued))) : null],
    advice: ['advice', 'Adv', 'advice', adviceLines.length ? () => clearSection('the advice', () => set('plan', 'advice', '')) : null],
    tests: ['tests', 'Lab', 'tests', tests.some((r) => r.status !== 'done') ? () => clearSection('the tests', () => setRecs(recs.filter((r) => r.kind !== 'investigation' || r.status === 'done'))) : null],
  };
  const labNames = uniq([...(cfg?.labTests ?? TESTS), ...(cfg?.labParams ?? []).map((o: any) => o.name)]);
  const procName = (id?: string | null) => cfg?.procedures?.find((x: any) => x.id === id)?.name ?? 'Procedure';
  // which part of a past visit belongs to which section (Load previous loads only that)
  const PART: Record<string, Part> = { symptoms: 'sx', diagnosis: 'dx', exam: 'ex', medicines: 'rx', advice: 'advice', tests: 'tests' };
  // Stacked follows Tatva: Load previous only on Diagnosis and Medications
  const LOAD_PREV = new Set(['diagnosis', 'medicines']);
  // a section's own header: in Stacked, Load previous and Templates for that section; in both layouts, a small Save template
  // examination: rows of a finding and a note; the search offers the clinic's exam lists plus common findings
  const examFields: Field[] = formSections.find((x) => x.key === 'exam')?.fields ?? [];
  const exams = asExam(data.exam); const setExams = (xs: ExamRow[]) => { setErrors((er) => er.filter((x) => !x.path.startsWith('exam.'))); setData((d) => ({ ...d, exam: { ...(d.exam ?? {}), items: xs } })); };
  const examNames = uniq([...examFields.flatMap((f) => f.options ?? []), ...EXAM_OPTIONS]);
  const legacyExam = Object.entries(data.exam ?? {}).filter(([k, v]) => k !== 'items' && (Array.isArray(v) ? v.length : v)).map(([, v]: any) => (Array.isArray(v) ? v.join(', ') : String(v))).join(' · ');
  // an empty search box offers what Quick add used to: sets suggested for this patient (Settings › Templates › Suggest in the search list), then the usual picks
  const setsFor = (kind: TmplKind): SetHint[] => (sets.data ?? []).filter((t) => t.kind === kind && t.mode === 'chip' && !appliedIds.includes(t.id) && suggests(t, cNames, dNames)).map((t) => ({ label: t.name, hint: 'Template', pick: () => setSetNote(applySet(t)) }));
  const notHave = (xs: string[], have: (string | undefined | null)[]) => { const h = new Set(have.filter(Boolean).map((x) => norm(x!))); return uniq(xs).filter((x) => !h.has(norm(x))); };
  const addFinding = (t: string) => { const name = examNames.find((o) => o.toLowerCase() === t.trim().toLowerCase()) ?? t.trim(); if (name) addExam([{ name }]); };
  const cardActs = (k: string): ReactNode => { if (readOnly || !isDoctor) return undefined; const t = SECTION_TPL[k]; if (!t) return undefined;
    return <>{LOAD_PREV.has(k) && <LoadPrevious compact part={PART[k]} previous={previous} onLoad={loadPrevious} />}{<SectionTemplates compact kind={t[0]} sub={t[1]} what={t[2]} sets={sets.data ?? []} onPick={(x) => setSetNote(applySet(x))} onClear={t[3]} />}<SaveTemplate what={t[2]} onSave={() => saveSection(t[0])} />{t[3] && <button type="button" data-act="clear" className="btn btn-ghost !min-h-7 gap-1 !px-2 text-[12px] text-muted hover:text-rose" title={`Clear the ${t[2]}`} aria-label={`Clear the ${t[2]}`} onClick={t[3]}><Eraser className="h-3.5 w-3.5" aria-hidden />Clear</button>}</>; };
  const cards: Record<string, ReactNode> = {
    vitals: <Card key="vitals" id="vitals" title="Vitals" meta="from check-in · tap a value to change it"><VitalsCard encounterId={id!} patientId={p.id} details={e.visit?.details ?? {}} heightCm={p.history?.heightCm} readOnly={readOnly} settings={cfg?.tenant?.settings} /></Card>,
    history: <Card key="history" id="history" title="Medical history"><HistoryChips patientId={p.id} history={p.history ?? {}} categories={cfg?.historyCategories ?? []} readOnly={readOnly} /></Card>,
    symptoms: <Card key="symptoms" id="symptoms" title="Symptoms" required={canFinish && padOf('symptoms').required} invalid={bad('symptoms')} actions={cardActs('symptoms')}>
      <div data-invalid={!!err('complaint', 'chief_complaint')}>
        {syms.map((s, i) => <Row key={s.name + i} label={s.name} onRemove={readOnly ? null : () => setSyms(syms.filter((_, j) => j !== i))}>
          <b className="rx-name">{s.name}</b>
          <input aria-label={`${s.name}: since`} className={`cell-in !w-28 ${PH}`} placeholder="Since" maxLength={30} value={s.since ?? ''} disabled={readOnly} onChange={(ev) => setSyms(syms.map((x, j) => (j === i ? { ...x, since: ev.target.value } : x)))} />
          <select aria-label={`${s.name}: severity`} className="cell-in !w-32" value={s.severity ?? ''} disabled={readOnly} onChange={(ev) => setSyms(syms.map((x, j) => (j === i ? { ...x, severity: ev.target.value || undefined } : x)))}><option value="">Severity</option>{SEVERITIES.map((sv) => <option key={sv}>{sv}</option>)}</select>
          <input aria-label={`${s.name}: note`} className={`cell-in !flex-[2_1_140px] ${PH}`} placeholder="Note" maxLength={120} value={s.note ?? ''} disabled={readOnly} onChange={(ev) => setSyms(syms.map((x, j) => (j === i ? { ...x, note: ev.target.value } : x)))} />
        </Row>)}
        {!readOnly && <SearchLine placeholder="Start typing a symptom · “itching 2 weeks”" options={symField?.options ?? []} invalid={!!err('complaint', 'chief_complaint')} onAdd={(t) => smartAdd(t, 'symptom')} sets={setsFor('symptom')} common={notHave(symField?.options ?? [], syms.map((x) => x.name))} />}
        {err('complaint', 'chief_complaint') && <div className="mt-1 text-xs text-rose">At least one symptom is required</div>}
      </div></Card>,
    diagnosis: <Card key="diagnosis" id="diagnosis" title="Diagnosis" required={canFinish && padOf('diagnosis').required} invalid={bad('diagnosis')} meta={isDoctor ? undefined : 'the doctor decides; leave it if unsure'} actions={cardActs('diagnosis')}>
      <div data-invalid={!!err('assessment', 'diagnosis')}>
        {dxs.map((d, i) => <Row key={d.name} label={d.name} onRemove={readOnly ? null : () => setDxs(dxs.filter((_, j) => j !== i))}>
          <b className="rx-name">{d.name}</b>
          <input aria-label={`${d.name}: since`} className={`cell-in !w-28 ${PH}`} placeholder="Since" maxLength={30} value={d.since ?? ''} disabled={readOnly} onChange={(ev) => setDxs(dxs.map((x, j) => (j === i ? { ...x, since: ev.target.value || undefined } : x)))} />
          <select aria-label={`${d.name}: status`} className="cell-in !w-36" value={d.status ?? ''} disabled={readOnly} onChange={(ev) => setDxs(dxs.map((x, j) => (j === i ? { ...x, status: ev.target.value || undefined } : x)))}><option value="">Status</option>{[...DX_STATUS, ...(d.status && !DX_STATUS.includes(d.status) ? [d.status] : [])].map((st) => <option key={st}>{st}</option>)}</select>
          <input aria-label={`${d.name}: notes`} className={`cell-in !flex-[2_1_140px] ${PH}`} placeholder="Notes" maxLength={120} value={d.note ?? ''} disabled={readOnly} onChange={(ev) => setDxs(dxs.map((x, j) => (j === i ? { ...x, note: ev.target.value || undefined } : x)))} />
        </Row>)}
        {!readOnly && <SearchLine placeholder="Search diagnosis" options={uniq([...(dxField?.options ?? []), ...DX_OPTIONS])} invalid={!!err('assessment', 'diagnosis')} onAdd={(t) => smartAdd(t, 'diagnosis')} sets={setsFor('diagnosis')} common={notHave([...(dxField?.options ?? []), ...DX_OPTIONS], dxs.map((x) => x.name))} />}
        {err('assessment', 'diagnosis') && <div className="mt-1 text-xs text-rose">Diagnosis is required</div>}
        {otherFields('assessment', []).map((f: Field) => <div key={f.key} className="mt-2"><CompactField f={f} value={data.assessment?.[f.key]} onChange={(v) => set('assessment', f.key, v)} disabled={readOnly} /></div>)}
        {applied && !readOnly && <div className="mt-2 rounded-lg bg-amber-soft px-3 py-2 text-[12.5px] text-amber anim-fade-in">Filled from <b>{applied}</b>.{allergyWarnings.length ? ` Check: ${allergyWarnings.map(([n]) => n).join(', ')} may clash with the ${p.allergies} allergy.` : ''}<button type="button" className="font-semibold underline" onClick={clearLoaded}>Clear loaded</button></div>}
      </div></Card>,
    exam: <Card key="exam" id="exam" title="Examinations" required={canFinish && padOf('exam').required} invalid={bad('exam')} actions={cardActs('exam')}>
      <div data-invalid={bad('exam') || undefined}>
        {exams.map((x, i) => <Row key={x.name + i} label={x.name} onRemove={readOnly ? null : () => setExams(exams.filter((_, j) => j !== i))}>
          <b className="rx-name">{x.name}</b>
          <input aria-label={`${x.name}: notes`} className={`cell-in !flex-[2_1_200px] ${PH}`} placeholder="Notes" maxLength={120} value={x.note ?? ''} disabled={readOnly} onChange={(ev) => setExams(exams.map((y, j) => (j === i ? { ...y, note: ev.target.value || undefined } : y)))} />
        </Row>)}
        {/* an older visit's exam lists (before the rows): shown so nothing written is hidden */}
        {legacyExam && <div className="mt-1 text-[12.5px] text-muted">Earlier format: {legacyExam}</div>}
        {!readOnly && <SearchLine placeholder="Search examinations" options={examNames} invalid={bad('exam')} onAdd={addFinding} sets={setsFor('finding')} common={notHave(examNames, exams.map((x) => x.name))} />}
      </div></Card>,
    medicines: isDoctor ? <Card key="medicines" id="medicines" title="Medications (Rx)" required={padOf('medicines').required} invalid={bad('medicines')} meta={rx.filter((i) => i.name).length ? `${rx.filter((i) => i.name).length} on the Rx` : undefined} actions={cardActs('medicines')}>
      {/* one table: a row per medicine, a column per detail, so the prescription reads across like the printed one */}
      {rx.filter((i) => i.name || !readOnly).length > 0 && <div className="rx-grid overflow-x-auto">
        <table className="w-full min-w-[860px] table-fixed border-collapse text-[14.5px]" onKeyDown={(ev) => { if (ev.key !== "Enter" || ev.defaultPrevented) return; /* Enter goes down to the same column, like a sheet */ const td = (ev.target as HTMLElement).closest("td"); const next = td?.parentElement?.nextElementSibling?.children[td.cellIndex]?.querySelector("input"); if (next) { ev.preventDefault(); (next as HTMLInputElement).focus(); } }}>
          <colgroup><col className="w-7" /><col /><col className="w-[104px]" /><col className="w-[108px]" /><col className="w-[128px]" /><col className="w-[118px]" /><col className="w-[56px]" /><col className="w-[16%]" /><col className="w-[92px]" /><col className="w-9" /></colgroup>
          <thead><tr className="text-left text-[11px] font-semibold uppercase tracking-wider text-muted">{['#', 'Medicine', 'Unit per dose', 'Frequency', 'When', 'Duration', 'Qty', 'Note', 'Stock', ''].map((h, n) => <th key={n} scope="col" className="px-2 py-2 font-semibold">{h}</th>)}</tr></thead>
          <tbody>{rx.map((i, k) => { const n = onHand(i); const hit = allergyHit(p.allergies, medText(i)); const off = readOnly || i._issued; const cell = 'p-0 align-middle'; return (
            <tr key={k} className={hit ? 'bg-rose-soft/40' : ''}>
              <td className={`${cell} px-1 text-center text-xs font-semibold text-muted`}>{k + 1}</td>
              <td className={cell}><Combo id={`rx-${i.name}`} label="Medicine" className={`cell-in font-semibold ${hit ? '!text-rose' : ''}`} value={i.name} disabled={off} options={meds.map((m: any) => m.name)} placeholder="Medicine"
                detail={(o) => { const m = meds.find((x: any) => x.name === o); const c = m && stock.data ? stock.data[m.id] ?? 0 : null; return c === null ? null : c ? `${c} in stock` : 'out of stock'; }}
                onChange={(v) => { const m = meds.find((x: any) => x.name === v); upd(k, { name: v, medicineId: m?.id ?? null, ...(m ? { dose: m.defaults?.dose, route: m.defaults?.route, frequency: m.defaults?.frequency, durationDays: m.defaults?.durationDays, durationNote: null, instructions: m.defaults?.instructions } : {}) }); }} />
                {/* a brand reads with what it is under it */}
                {medOf(i)?.generic && medOf(i).generic !== i.name && <div className="-mt-1.5 truncate px-2 pb-1.5 text-[11px] text-muted">{medOf(i).generic}</div>}</td>
              {/* empty cells read as examples, faded and in italics, never as values */}
              <td className={cell}><input aria-label="Unit per dose" className={`cell-in ${PH}`} placeholder="e.g. 1 tablet" value={i.dose ?? ''} disabled={off} onChange={(ev) => upd(k, { dose: ev.target.value })} /></td>
              <td className={cell}><Combo label="Frequency" className={`cell-in ${PH}`} placeholder="e.g. 1-0-1" value={i.frequency ?? ''} options={FREQ} disabled={off} onChange={(v) => upd(k, { frequency: v })} /></td>
              <td className={cell}><Combo label="When" className={`cell-in ${PH}`} placeholder="e.g. after food" value={i.timing ?? ''} options={TIMING} disabled={off} onChange={(v) => upd(k, { timing: v || null })} /></td>
              <td className={cell}><DurationCell item={i} disabled={off} onChange={(d) => upd(k, d)} /></td>
              <td className={cell}><NumInput aria-label="Quantity" max={9999} placeholder="—" className={`cell-in ${PH}`} value={i.qty ?? ''} disabled={off} onChange={(ev) => upd(k, { qty: ev.target.value ? Number(ev.target.value) : null })} /></td>
              <td className={cell}><input aria-label="Note" className={`cell-in ${PH}`} placeholder="Notes" value={i.instructions ?? ''} disabled={off} onChange={(ev) => upd(k, { instructions: ev.target.value })} /></td>
              <td className={`${cell} truncate px-2 text-[11.5px] font-semibold ${hit ? 'text-rose' : n === 0 ? 'text-amber' : 'text-muted'}`}>{hit ? `allergy: ${hit}` : n === null ? (i.name && !i.medicineId ? 'not in list' : '') : n === 0 ? 'out of stock' : `${n} in stock`}</td>
              <td className={`${cell} text-center`}>{!readOnly && !i._issued ? <button type="button" className="btn btn-ghost btn-icon !h-7 !w-7" aria-label={`Remove ${i.name || 'line'}`} onClick={() => setRx(rx.filter((_, j) => j !== k))}><Icon name="x" className="h-3.5 w-3.5" /></button> : i._issued ? <span className="text-[11px] text-muted" title="Issued at the counter; it stays as written">Issued</span> : null}</td>
            </tr>); })}</tbody>
        </table>
      </div>}
      {!readOnly && <SearchLine placeholder='Search medicines by name · or type the line “itra 100 1-0-1 7d after food”' options={meds.map((m: any) => m.name)} invalid={bad('medicines')} onAdd={(t) => smartAdd(t, 'medicine')} sets={setsFor('medicine')} common={notHave((freqRx.data ?? []).map((x) => x.name), rx.map((x) => x.name))} commonTitle="Often prescribed" />}
      {leaflets.length > 0 && <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted"><span>{p.noWhatsapp ? 'Not sent: the patient asked for no WhatsApp — print it instead:' : 'Sent with the Rx on WhatsApp:'}</span>{leaflets.map((m: any) => <Chip key={m.id} tone="sage">{m.name}: how to use</Chip>)}</div>}
    </Card> : null,
    advice: isDoctor ? <Card key="advice" id="advice" title="Advices" meta="standard lines print in Telugu too" actions={cardActs('advice')}>
      {adviceLines.map((a) => <div key={a} className="rx-row"><label className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-[13px] font-semibold"><input type="checkbox" className="accent-ink" checked disabled={readOnly} aria-label={`Remove ${a}`} onChange={() => toggleAdvice(a)} />{a}</label></div>)}
      {!readOnly && <AdvicePicker options={ADVICE} have={adviceLines} onToggle={toggleAdvice} sets={setsFor('advice')} />}
    </Card> : null,
    tests: isDoctor ? <Card key="tests" id="tests" title="Investigation" actions={cardActs('tests')}>
      {tests.map((r) => <Row key={r.notes} label={r.notes ?? 'test'} onRemove={readOnly || r.status === 'done' ? null : () => setRecs(recs.filter((x) => x !== r))}>
        <b className="rx-name">{r.notes}</b>
        <input aria-label={`${r.notes}: instruction`} className={`cell-in !flex-[2_1_200px] ${PH}`} placeholder="Instruction" maxLength={120} value={data.plan?.testNotes?.[r.notes!] ?? ''} disabled={readOnly} onChange={(ev) => set('plan', 'testNotes', { ...(data.plan?.testNotes ?? {}), [r.notes!]: ev.target.value || undefined })} />
        <span className="flex w-36 items-center gap-1.5 px-2">{r.status === 'done' && <Chip tone="sage">received</Chip>}{(() => { const d = r.id ? reportFor(myDocs, null, r.id) : null; return d ? <ReportLink doc={d} /> : null; })()}</span>
      </Row>)}
      {!readOnly && <SearchLine placeholder="Search investigation" options={labNames} onAdd={addTest} sets={setsFor('tests')} common={notHave(labNames, tests.map((x) => x.notes))} />}
    </Card> : null,
    results: isDoctor ? <Card key="results" id="results" title="Lab results" meta="typed when reports arrive"><LabResultsCard patientId={p.id} encounterId={id!} recIds={recIds} params={cfg?.labParams ?? []} readOnly={readOnly} printOut={printOut} onPrintOut={(v) => set('labs', 'printOutOfRangeOnly', v)} docs={myDocs} /></Card> : null,
    followup: isDoctor ? <section key="followup" id="sec-followup" className="card !p-0 anim-fade-up"><div className="grid gap-4 p-4 md:grid-cols-[300px_minmax(0,1fr)]">
      <div><div className="mb-3 flex items-center gap-2.5"><SecIcon id="followup" /><h3 className="text-[17px] font-bold tracking-[-0.01em]">Follow-up</h3></div>
        <FollowUp days={followup?.intervalDays ?? null} disabled={readOnly} onChange={setFollowup} />
        {followup?.intervalDays ? <div className="mt-1.5 text-xs text-muted">Review on {fmtDate(new Date(Date.now() + followup.intervalDays * 86400000).toISOString())}</div> : null}</div>
      <div><div className="mb-3 flex items-center gap-2.5"><SecIcon id="addnotes" /><h3 className="text-[17px] font-bold tracking-[-0.01em]">Additional notes</h3>
        {!readOnly && isDoctor && <span className="ml-auto flex items-center gap-0.5"><SectionTemplates compact kind="notes" sub="N" what="notes" sets={sets.data ?? []} onPick={(x) => setSetNote(applySet(x))} onClear={null} /><SaveTemplate what="notes" onSave={() => saveSection('notes')} /></span>}</div>
        <textarea aria-label="Additional notes" className="input min-h-[72px]" maxLength={2000} placeholder="Enter any specific note here · printed on the prescription" value={data.plan?.notes ?? ''} disabled={readOnly} onChange={(ev) => set('plan', 'notes', ev.target.value)} /></div>
    </div></section> : null,
    procedures: isDoctor ? <Card key="procedures" id="procedures" title="Surgeries / Procedures" actions={!readOnly && recs.some((r) => r.kind === 'procedure') ? <button type="button" data-act="clear" title="Clear the procedures" aria-label="Clear the procedures" className="btn btn-ghost !min-h-7 gap-1 !px-2 text-[12px] text-muted hover:text-rose" onClick={() => clearSection('the procedures', () => setRecs(recs.filter((r) => r.kind !== 'procedure')))}><Eraser className="h-3.5 w-3.5" aria-hidden />Clear</button> : undefined}>
      {(() => {
        const setRec = (k: number, p: Partial<Rec>) => setRecs(recs.map((x, j) => (j === k ? { ...x, ...p } : x)));
        const procRow = (r: Rec, k: number, inPkg: boolean) => (
          <Row key={k} label={procName(r.procedureId)} onRemove={readOnly ? null : () => removeProc(k)}>
            <b className="rx-name">{procName(r.procedureId)}</b>
            {inPkg ? <span className="flex w-28 items-center pr-2 text-xs text-muted"><b className="mr-1 text-ink">{r.sittings}</b>sessions</span>
              : <label className="flex w-28 items-center pr-2 text-xs text-muted"><NumInput aria-label="Sessions" max={50} className="cell-in !w-12" value={r.sittings ?? ''} disabled={readOnly} onChange={(ev) => setRec(k, { sittings: Number(ev.target.value) })} />sessions</label>}
            {(r.sittings ?? 0) > 1 ? <label className="flex w-36 items-center px-2 text-xs text-muted">every<NumInput aria-label="Days between sessions" max={365} className="cell-in !w-12" value={r.gapDays ?? ''} disabled={readOnly} onChange={(ev) => setRec(k, { gapDays: Number(ev.target.value) || undefined })} />days</label> : <span className="w-36" />}
            {inPkg ? <span className="flex w-48 items-center px-2 text-xs text-muted">In the package</span> : (() => { const std = (cfg?.procedures?.find((x: any) => x.id === r.procedureId)?.pricePaise ?? 0) * Math.max(1, r.sittings ?? 1); return (
              <label className="flex w-48 items-center gap-1 px-2 text-xs text-muted" title="The total for all sessions. Leave empty for the clinic's standard price.">₹<NumInput aria-label="Amount, total for all sessions" max={10000000} className={`cell-in !w-24 ${PH}`} placeholder={std ? (std / 100).toLocaleString('en-IN') : 'Amount'} value={r.amountPaise ? String(r.amountPaise / 100) : ''} disabled={readOnly}
                onChange={(ev) => setRec(k, { amountPaise: ev.target.value ? Math.round(Number(ev.target.value) * 100) : null })} />{r.amountPaise ? 'Custom' : 'Standard'}</label>); })()}
            <input aria-label="Notes" className={`cell-in !flex-[2_1_140px] ${PH}`} placeholder="Notes" value={r.notes ?? ''} disabled={readOnly} onChange={(ev) => setRec(k, { notes: ev.target.value })} />
          </Row>);
        // a procedure taken out of a package: the rest of that package go back to their own standard prices (with Undo)
        const removeProc = (k: number) => {
          const was = recs; const g = recs[k].package?.group;
          setRecs(recs.filter((_, j) => j !== k).map((x) => (g && x.package?.group === g ? { ...x, package: null, amountPaise: null } : x)));
          if (g) toast(`The package price no longer applies: the other procedures are back at their standard prices`, 'info', { label: 'Undo', run: () => setRecs(was) });
        };
        const removeGroup = (g: string) => { const was = recs; setRecs(recs.filter((x) => x.package?.group !== g)); toast('Package removed', 'info', { label: 'Undo', run: () => setRecs(was) }); };
        const groups = [...new Set(recs.filter((r) => r.kind === 'procedure' && r.package).map((r) => r.package!.group))];
        return <>
          {groups.map((g) => { const rows = recs.map((r, k) => [r, k] as const).filter(([r]) => r.kind === 'procedure' && r.package?.group === g);
            const p0 = rows[0][0].package!; const k = pkgs.find((x) => x.id === p0.id); const name = p0.name ?? k?.name ?? 'Package';
            const price = p0.pricePaise ?? k?.pricePaise; const full = p0.listPaise ?? (k ? fullPrice(k, cfg?.procedures ?? []) : 0); const months = p0.validMonths ?? k?.validMonths;
            return (
              <div key={g} className="mb-1.5 overflow-hidden rounded-[8px] border border-clay-line bg-clay-soft/30" role="group" aria-label={`${name} package`}>
                <div className="flex flex-wrap items-center gap-2 bg-clay-soft px-3 py-2 text-[13px]">
                  <Icon name="box" className="h-3.5 w-3.5 text-clay-ink" /><b className="text-clay-ink">{name}</b><span className="rounded bg-surface px-1.5 text-[11px] font-semibold text-clay-ink">Package</span>
                  <span className="ml-auto" />{price != null && full > price && <s className="text-muted">{money(full)}</s>}{price != null && <b>{money(price)}</b>}
                  {price != null && full > price && <span className="text-xs text-sage">Saves {money(full - price)}</span>}{months && <span className="text-xs text-muted">· valid {months} months</span>}
                  {!readOnly && <button type="button" className="btn btn-ghost btn-icon !h-7 !w-7" aria-label={`Remove the ${name} package`} onClick={() => removeGroup(g)}><Icon name="x" className="h-3.5 w-3.5" /></button>}
                </div>
                {rows.map(([r, k]) => procRow(r, k, true))}
              </div>); })}
          {recs.map((r, k) => r.kind !== 'procedure' || r.package ? null : procRow(r, k, false))}
        </>;
      })()}
      {!readOnly && <SearchLine placeholder="Search procedures or packages" options={[...pkgs.map((k) => `${k.name} (package)`), ...(cfg?.procedures ?? []).map((x: any) => x.name)]} sets={setsFor('procedure')}
        common={[...pkgs.filter((k) => !recs.some((r) => r.package?.id === k.id)).map((k) => `${k.name} (package)`), ...(cfg?.procedures ?? []).filter((x: any) => !recs.some((r) => r.kind === 'procedure' && r.procedureId === x.id)).map((x: any) => x.name)]} onAdd={(t) => {
        const k = pkgs.find((x) => `${x.name} (package)`.toLowerCase() === t.toLowerCase() || x.name.toLowerCase() === t.toLowerCase());
        if (k) {
          if (recs.some((r) => r.package?.id === k.id)) return toast('This package is already on the pad', 'info');
          const clash = k.items.find((it) => recs.some((r) => r.kind === 'procedure' && r.procedureId === it.procedureId));
          if (clash) return toast(`${procName(clash.procedureId)} is already on the pad. Remove it first, then add the package.`, 'info');
          const group = crypto.randomUUID().slice(0, 8);
          return setRecs([...recs, ...k.items.map((it): Rec => ({ kind: 'procedure', procedureId: it.procedureId, sittings: it.sittings, gapDays: it.intervalDays || undefined, package: { id: k.id, group, name: k.name, pricePaise: k.pricePaise, listPaise: fullPrice(k, cfg?.procedures ?? []), validMonths: k.validMonths } }))]);
        }
        const pr = (cfg?.procedures ?? []).find((x: any) => x.name.toLowerCase() === t.toLowerCase()); if (!pr) return toast(`“${t}” is not in the procedure list. Add it in Settings first.`, 'info'); if (recs.some((r) => r.kind === 'procedure' && r.procedureId === pr.id)) return toast('Already on the pad', 'info'); setRecs([...recs, { kind: 'procedure', procedureId: pr.id, sittings: pr.typicalSittings, gapDays: gapFor(pr.id) }]); }} />}
    </Card> : null,
    notes: isDoctor ? <Card key="notes" id="notes" title="Private notes" meta="never printed or sent"><textarea aria-label="Private notes" className="input min-h-14" maxLength={2000} placeholder="For you and the clinic only" value={data.notes?.private ?? ''} disabled={readOnly} onChange={(ev) => set('notes', 'private', ev.target.value)} /></Card> : null,
    referral: isDoctor ? <Card key="referral" id="referral" title="Referral" meta="printed on the prescription">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
        <input aria-label="Refer to doctor" className="input !py-1.5" maxLength={120} placeholder="Doctor, clinic or speciality" value={data.referral?.to ?? ''} disabled={readOnly} onChange={(ev) => set('referral', 'to', ev.target.value)} />
        <input aria-label="Referral notes" className="input !py-1.5" maxLength={500} placeholder="Reason for referral, instructions" value={data.referral?.reason ?? ''} disabled={readOnly} onChange={(ev) => set('referral', 'reason', ev.target.value)} />
      </div></Card> : null,
    photos: <Card key="photos" id="photos" title={thenNow ? 'Then and now' : 'Photos'} meta={lastArea} actions={can(perms, 'document.write') && !readOnly && <Act onClick={() => setCapture(true)}>Take photo</Act>}>
      {thenNow ? <button className="grid w-full max-w-sm grid-cols-2 gap-1.5" onClick={() => setCompare(thenNow)} aria-label="Compare first and latest photo">{thenNow.map((x, k) => <span key={x.id} className="relative block aspect-square overflow-hidden rounded-lg bg-paper-2"><img src={`/api/documents/${x.id}/file`} alt={`${k ? 'Latest' : 'First'} ${x.area ?? ''}`} className="h-full w-full object-cover" /><span className="absolute bottom-1 left-1 rounded-md bg-black/55 px-1.5 text-[10px] font-semibold text-white">{fmtDate(x.takenAt)}</span></span>)}</button>
        : ph.length ? <div className="flex gap-1.5">{ph.slice(0, 6).map((x) => <div key={x.id} className="relative"><img src={`/api/documents/${x.id}/file`} alt={x.area ?? 'photo'} className="h-16 w-16 rounded-lg object-cover" />{can(perms, 'document.write') && <RemovePhoto photo={x} patientId={p.id} className="absolute -right-1.5 -top-1.5 !h-6 !w-6" />}</div>)}</div> : <div className="text-xs text-muted">No photos yet.</div>}
    </Card>,
  };
  const shown = pad.length ? pad.filter((s) => s.show).map((s) => s.key) : Object.keys(cards);
  // the doctor's photos live on their own tab; the junior takes the "before" pictures at intake, so intake keeps the card
  const order = isDoctor ? shown.filter((k) => k !== 'photos') : [...shown.filter((k) => k !== 'photos'), ...(can(perms, 'document.write') ? ['photos'] : [])];
  // custom modules: the ones on my pad, and any this pad already has lines in (so a removed one never hides what was written)
  const modLib = new Map((padMods.data ?? []).map((m) => [m.id, m])); const modData: Record<string, ModuleData> = data.modules ?? {};
  const myMods = (padMods.data ?? []).filter((m) => m.onPad);
  const modIds = uniq([...(readOnly ? [] : myMods.map((m) => m.id)), ...Object.keys(modData).filter((k) => filledRows(modData[k]).length)]);
  // a module keeps the name and columns it had once lines are written; an empty one follows the list
  const modOf = (k: string): ModuleData | null => { const d = modData[k]; const lib = modLib.get(k); return d && (filledRows(d).length || !lib) ? d : lib ? { name: lib.name, columns: lib.columns, rows: d?.rows ?? [] } : null; };
  const setModRows = (k: string, rows: string[][]) => { const m = modOf(k); if (m) setData((d) => ({ ...d, modules: { ...(d.modules ?? {}), [k]: { name: m.name, columns: m.columns, rows } } })); };
  const saveModTpl = async (k: string) => {
    const m = modOf(k); const rows = filledRows(m); if (!m || !rows.length) return toast(`There is nothing to save yet: ${m?.name ?? 'the module'} is empty.`, 'info');
    const r = await ask({ title: `Save ${m.name} as a template`, body: 'It appears under Templates on this module.', confirmLabel: 'Save', field: { label: 'Name', required: true, maxLength: 80 } });
    if (!r?.value || r.value.trim().length < 2) return;
    try { await post('/templates', { kind: 'module', name: r.value.trim(), linked: {}, payload: { moduleId: k, rows: rows.map((x) => m.columns.map((_, j) => x[j] ?? '')) } }); qc.invalidateQueries({ queryKey: ['templates'] }); toast(`Saved as “${r.value.trim()}”`); }
    catch (er) { toast(er instanceof ApiError && er.body?.code === 'DUPLICATE' ? 'A template by that name already exists.' : errText(er), 'err'); }
  };
  const moduleCard = (k: string) => { const m = modOf(k); if (!m) return null; const lib = modLib.get(k); const rows = filledRows(m); // lines here lock it, even before the list hears so
    const acts = readOnly || !isDoctor ? undefined : <>
      <ModuleLoadPrev id={k} previous={previous} onLoad={(xs) => setModRows(k, [...rows, ...xs])} />
      <SectionTemplates compact kind="module" sub="" what={m.name} sets={(sets.data ?? []).filter((t) => t.kind === 'module' && t.payload?.moduleId === k)} onPick={(t) => setModRows(k, [...rows, ...(t.payload?.rows ?? [])])} onClear={null} />
      <SaveTemplate what={m.name} onSave={() => saveModTpl(k)} />
      {rows.length > 0 && <button type="button" className="btn btn-ghost !min-h-7 gap-1 !px-2 text-[12px] text-muted hover:text-rose" aria-label={`Clear ${m.name}`} onClick={() => clearSection(m.name, () => setModRows(k, []))}><Eraser className="h-3.5 w-3.5" aria-hidden />Clear</button>}
      {lib && <ModuleMenu items={[
        ...(lib.onPad ? [{ label: 'Remove from Rx pad', onClick: () => setOnPad(lib, false) }] : [{ label: 'Add to my Rx pad', onClick: () => setOnPad(lib, true) }]),
        { label: 'Edit module', disabled: lib.canEdit && !rows.length ? undefined : lib.used || rows.length ? 'Locked: it has been used on a prescription' : 'Only the doctor who made it can change it', onClick: () => setModDrawer({ edit: lib }) },
        { label: 'Delete module', danger: true, disabled: lib.canEdit && !rows.length ? undefined : lib.used || rows.length ? 'Locked: it has been used on a prescription' : 'Only the doctor who made it can delete it', onClick: () => deleteModule(lib) },
      ]} />}</>;
    return <Card key={`mod-${k}`} id={`mod-${k}`} title={m.name} meta={<ModuleInfo m={lib} />} actions={acts}><ModuleTable mod={m} readOnly={readOnly} onChange={(xs) => setModRows(k, xs)} /></Card>; };
  const custom = (x: any) => (
    <Card key={x.key} id={x.key} title={x.title} required={x.fields.some((f: Field) => f.required)} invalid={bad(x.key)}>
      <div className="space-y-2">{x.fields.map((f: Field) => <div key={f.key} data-invalid={!!err(x.key, f.key)}><CompactField f={f} value={data[x.key]?.[f.key]} onChange={(v) => set(x.key, f.key, v)} disabled={readOnly} invalid={!!err(x.key, f.key)} />{err(x.key, f.key) && <div className="mt-1 text-xs text-rose">{f.label} is required</div>}</div>)}</div>
    </Card>);

  // side by side: one row per section with what it says so far; the open row's card sits on the right
  const txt = (xs: (string | null | undefined | false)[]) => xs.filter(Boolean).join(' · ');
  const vd = e.visit?.details ?? {};
  const histItems: string[] = (cfg?.historyCategories ?? []).flatMap((c: any) => (Array.isArray(p.history?.[c.key]) ? p.history[c.key].map((x: any) => x.name) : []));
  const brief: Record<string, string | null> = {
    vitals: vitalsText(vd, vitalFields(cfg?.tenant?.settings)) || null,
    history: histItems.length ? histItems.join(', ') : null,
    symptoms: syms.length ? syms.map((x) => txt([x.name, x.since && `since ${x.since}`])).join('; ') : null,
    diagnosis: dxs.length ? dxs.map((d) => txt([d.name, d.severity?.toLowerCase()])).join('; ') : null,
    exam: txt([...exams.map((x) => txt([x.name, x.note])), legacyExam]) || null,
    medicines: rx.filter((i) => i.name).length ? rx.filter((i) => i.name).map((i) => i.name).join(', ') : null,
    advice: adviceLines.length ? adviceLines.join(' · ') : null,
    tests: tests.length ? tests.map((r) => r.notes).join(', ') : null,
    results: testRecs.length ? `${testsIn} of ${testRecs.length} reports in` : null,
    followup: followup?.intervalDays ? `Review in ${afterText(followup.intervalDays)}` : null,
    procedures: txt(recs.filter((r) => r.kind === 'procedure').map((r) => `${procName(r.procedureId)}${r.sittings ? ` × ${r.sittings}` : ''}${r.sittings && r.sittings > 1 && r.gapDays ? `, every ${r.gapDays} days` : ''}`)) || null,
    notes: data.notes?.private ? String(data.notes.private).slice(0, 120) : null,
    referral: txt([data.referral?.to, data.referral?.speciality]) || null,
  };
  keys.current = (ev) => {
    if (checking) return; // the reasons sheet has the keyboard
    if (signing) { if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') { ev.preventDefault(); sign(); } return; } // the sign-off sheet: Ctrl+Enter signs
    padKeys(ev);
  };
  /** The pad by keyboard: / goes to this section's search, Alt+↓/↑ to the next or previous section, Alt+L / Alt+T load previous or the
   *  section's templates, Alt+S saves the section as a template, Alt+P previews, Ctrl+Enter finishes. "This section" is the one the cursor is in,
   *  else the first one on screen. */
  const padKeys = (ev: KeyboardEvent) => {
    if (readOnly || !isDoctor || tab !== 'pad' || ev.defaultPrevented) return;
    const t = ev.target as HTMLElement | null; const typing = !!t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);
    const go = (fn: () => void) => { ev.preventDefault(); fn(); };
    const secs = [...document.querySelectorAll<HTMLElement>('section[id^="sec-"]')];
    const here = (t?.closest('section[id^="sec-"]') as HTMLElement | null) ?? secs.find((x) => x.getBoundingClientRect().bottom > 140) ?? secs[0];
    const into = (sec?: HTMLElement) => { if (!sec) return; const body = sec.querySelector<HTMLElement>(':scope > div:last-child') ?? sec;
      const el = body.querySelector<HTMLElement>('input[data-search]') ?? body.querySelector<HTMLElement>('input:not([disabled]), textarea:not([disabled]), button:not([disabled])');
      sec.scrollIntoView({ block: 'center' }); el?.focus({ preventScroll: true }); };
    if (ev.key === '/' && !typing) return go(() => into(secs.slice(Math.max(0, secs.indexOf(here!))).find((x) => x.querySelector('input[data-search]')) ?? here)); // the nearest section with a search
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') return go(finish);
    if (!ev.altKey || ev.ctrlKey || ev.metaKey) return;
    const i = secs.indexOf(here!);
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') return go(() => into(secs[Math.max(0, Math.min(secs.length - 1, i + (ev.key === 'ArrowDown' ? 1 : -1)))]));
    const act = (a: string) => go(() => here?.querySelector<HTMLElement>(`[data-act="${a}"]:not([disabled])`)?.click());
    if (ev.code === 'KeyL') return act('loadprev');
    if (ev.code === 'KeyT') return act('templates');
    if (ev.code === 'KeyS') return act('save');
    if (ev.code === 'KeyP') return go(() => { void preview(); });
  };
  // the left column (Tatva "Basic info"): what each row says, and what its drawer holds
  const records = myDocs.filter((d: any) => d.kind !== 'photo' && d.kind !== 'canvas');
  const testIds = new Set(testRecs.map((r: any) => r.id)); // a file uploaded for one of this visit's tests is shown with that test, not twice
  const otherFiles = records.filter((d: any) => !(d.recommendationId && testIds.has(d.recommendationId)) && !(d.recommendationIds ?? []).some((x: string) => testIds.has(x)));
  const canvases: PadCanvas[] = Array.isArray(data.canvases) ? data.canvases : [];
  const LEFT: Record<string, { title: string; brief: string | null; body: () => ReactNode; width?: string }> = {
    vitals: { title: 'Vitals & body composition', brief: brief.vitals, width: 'max-w-xl', body: () => <><VitalsCard encounterId={id!} patientId={p.id} details={e.visit?.details ?? {}} heightCm={p.history?.heightCm} readOnly={readOnly} settings={cfg?.tenant?.settings} /><div className="modal-foot"><span className="mr-auto text-[13px] text-muted">Each value saves as you change it</span><button type="button" className="btn btn-primary" onClick={() => setSide(null)}>Done</button></div></> },
    history: { title: 'Medical history', brief: brief.history, width: 'max-w-2xl', body: () => <HistorySheet onDirty={setSideDirty} patientId={p.id} history={p.history ?? {}} categories={cfg?.historyCategories ?? []} readOnly={readOnly} onDone={() => setSide(null)} /> },
    notes: { title: 'Private notes', brief: brief.notes, width: 'max-w-xl', body: () => <div><textarea autoFocus aria-label="Private notes" className="input min-h-40" maxLength={2000} placeholder="Write your notes" value={data.notes?.private ?? ''} disabled={readOnly} onChange={(ev) => set('notes', 'private', ev.target.value)} /><div className="modal-foot"><span className="mr-auto text-[13px] text-muted">Saves with the pad; never printed or sent</span><button type="button" className="btn btn-primary" onClick={() => setSide(null)}>Done</button></div></div> },
    // one place for reports and files (v70): the tests from this visit with their values, then every other file; a test's own report sits with the test
    reports: { title: 'Reports & records', brief: [testRecs.length ? `${testsIn} of ${testRecs.length} reports in` : null, otherFiles.length ? `${otherFiles.length} file${otherFiles.length === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ') || null, width: 'max-w-2xl', body: () => <>
      {testRecs.length > 0 && <div className="mb-2 text-[13px] font-semibold text-muted">Tests from this visit</div>}
      <LabResultsCard ordered={testRecs.map((r: any) => ({ id: r.id, name: r.notes ?? 'Test', done: r.status === 'done', note: data.plan?.testNotes?.[r.notes] }))} patientId={p.id} encounterId={id!} recIds={recIds} params={cfg?.labParams ?? []} readOnly={readOnly} printOut={printOut} onPrintOut={(v) => set('labs', 'printOutOfRangeOnly', v)} docs={myDocs} />
      <div className="mb-2 mt-5 flex items-center gap-2 border-t border-line pt-4"><span className="text-[13px] font-semibold text-muted">Other files</span><span className="text-[12.5px] text-muted">scans, letters, older reports</span><span className="ml-auto" />{can(perms, 'document.write') && <UploadButton patientId={p.id} encounterId={id} label="Upload" onDone={() => qc.invalidateQueries({ queryKey: ['documents', p.id] })} />}</div>
      {otherFiles.length ? <ReportList docs={otherFiles} patientId={p.id} encounterId={readOnly ? undefined : id} who={p.fullName} /> : <div className="text-[13px] text-muted">No other files.</div>}
      <div className="modal-foot"><span className="mr-auto text-[13px] text-muted">Values, reports and files save straight away</span><button type="button" className="btn btn-primary" onClick={() => setSide(null)}>Done</button></div></> },
    canvas: { title: 'Canvas', brief: canvases.length ? canvases.map((c) => c.name).join(', ') : null, width: 'max-w-2xl', body: () => <><Suspense fallback={<Skeleton rows={3} />}><CanvasDrawer canvases={canvases} onChange={(xs) => setData((d) => ({ ...d, canvases: xs }))} patientId={p.id} encounterId={id!} readOnly={readOnly} /></Suspense><div className="modal-foot"><span className="mr-auto text-[13px] text-muted">Saves with the pad</span><button type="button" className="btn btn-primary" onClick={() => setSide(null)}>Done</button></div></> },
  };
  // the clinic's pad settings still say which show; records and canvas are the doctor's, always there
  const vitalCells: [string, string, string][] = vitalFields(cfg?.tenant?.settings).filter((x) => vd[x.key] !== undefined && vd[x.key] !== null && vd[x.key] !== '').map((x) => [x.label, `${vd[x.key]}${x.unit && x.key !== 'bp' ? ` ${x.unit}` : ''}`, vitalFlag(x.key, vd[x.key])]);
  { const b = bmiOf(Number(vd.weight_kg) || null, Number(vd.height_cm ?? p.history?.heightCm) || null); if (b) vitalCells.push(['BMI', String(b), vitalFlag('bmi', b)]); }
  // medical history on the row itself: only the categories with something recorded, allergies first and in red, then the note
  const histRows = (cfg?.historyCategories ?? []).map((c: any) => ({ label: c.short ?? c.label, allergy: /allerg/i.test(c.key), names: (Array.isArray(p.history?.[c.key]) ? p.history[c.key] : []).map((x: any) => x.name).filter(Boolean) as string[] }))
    .filter((r: any) => r.names.length).sort((a: any, b: any) => Number(b.allergy) - Number(a.allergy));
  const histNote = typeof p.history?.notes === 'string' ? p.history.notes.trim() : '';
  const privNote = typeof data.notes?.private === 'string' ? data.notes.private.trim() : '';
  const leftKeys = ['vitals', 'history', 'notes', 'reports', 'canvas'].filter((k) => (['reports', 'canvas', 'notes'].includes(k) ? isDoctor : true) && (['reports', 'canvas'].includes(k) || order.includes(k)));
  const notSaved = <span className="rounded-[7px] bg-amber-soft px-2 py-0.5 text-xs font-semibold text-amber" role="alert">{saveFailed === 'kept' ? 'Not saved — kept on this computer, will send when the internet is back' : 'Not saved — your notes are still here. Try Save again.'}</span>;
  const restoreAt = restore ? new Date(restore.at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '';
  const doRestore = () => { if (!restore) return; setData(restore.data); setRx(restore.rx); setRecs(restore.recs); setRestore(null); setSaveFailed('kept'); toast(`Restored what you typed at ${restoreAt}. It saves now.`); setTimeout(() => window.dispatchEvent(new Event('app:save-now')), 50); };
  const dropRestore = () => { try { localStorage.removeItem(localKey); } catch { /* private mode */ } setRestore(null); };
  const age = ageText(p);
  const patientLine = [age ? `${age} ${p.sex ?? ''}` : null, p.patientNo, p.phone, visitNo === 1 ? 'first visit' : `visit ${visitNo}`, isReview ? `review of ${joinList(lastDone.data?.assessment?.diagnosis) || 'last visit'}` : null, arrivalText ? `screened: ${arrivalText}` : null].filter(Boolean).join(' · ');

  return (
    <div className={`pad-calm space-y-3 pb-4 ${side && LEFT[side] ? 'drawer-open' : ''}`} style={side && LEFT[side] ? ({ '--drawer-w': `${LEFT[side].width === 'max-w-xl' ? 560 : 640}px` } as React.CSSProperties) : undefined}>
      {/* who: the patient in the app's top bar (more room for the pad), with the layout, the whole-pad templates and the pad's settings; History, Photos and Reports as tabs under it */}
      {/* the record's header: the patient, then the pad's tabs with Save and Finish, stuck to the top (the app's top bar steps aside on a record) */}
      <div className="pad-head pad-head-calm sticky top-[64px] z-20 -mx-1 bg-paper/95 px-1 pt-1 backdrop-blur-xl md:top-0">
      {(() => { const who = (
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <BackButton to="/dashboard" />
          <div className="min-w-0"><div className="flex items-center gap-1.5 truncate text-[16px] font-semibold leading-tight">{p.fullName}<FlagChips flags={p.flags} /></div>
            <div className="truncate text-xs text-muted" title={patientLine}>{patientLine}</div></div>
          {p.allergies && <span className="chip chip-rose shrink-0 !py-1">Allergy: {p.allergies}</span>}
          {pregnant && <span className="chip chip-rose shrink-0 !py-1">{pregnant}</span>}
          <span className="ml-auto flex shrink-0 items-center gap-2 text-xs text-muted">{me.role === 'assistant' && <Chip tone="sky">Intake · doctor reviews next</Chip>}{e.status === 'completed' && <Chip tone="sage">completed</Chip>}
            {/* Clear, Save and Finish sit with the patient, always in reach; ⋯ keeps Preview */}
          {saveFailed && !readOnly && notSaved /* only when a save did not reach the server */}
          {!readOnly && !canFinish && <button type="button" className="btn btn-sm btn-primary" disabled={save.isPending} onClick={() => save.mutate({ complete: false, back: true })}>Save intake &amp; return to queue</button>}
          {!readOnly && canFinish && <>
            <MoreMenu items={[{ label: 'Preview', onClick: () => { void preview(); } }]} />
            {isDoctor && <button type="button" className="btn btn-ghost btn-sm text-muted hover:text-rose" title="Clear the whole pad" onClick={() => clearSection('the whole pad', () => { setSyms([]); setDxs([]); setData((d) => ({ ...d, exam: {}, plan: {}, notes: {}, referral: {} })); setRx([]); setRecs(recs.filter((r) => r.kind === 'investigation' && r.status === 'done')); })}><Eraser className="h-4 w-4" aria-hidden />Clear</button>}
            <button type="button" className="btn btn-sm" disabled={save.isPending} onClick={() => save.mutate({ complete: false })}><Save className="h-4 w-4" aria-hidden />Save</button>
            {held && testsOpen && <button type="button" className="btn btn-sm btn-primary" disabled={save.isPending} onClick={() => save.mutate({ complete: false, back: true, reviewed: true })}>Keep open for the rest</button>}
            <button type="button" className={`btn btn-sm ${held && testsOpen ? '' : 'btn-primary'}`} disabled={save.isPending} onClick={finish}>{held ? 'Complete' : willHold ? 'Finish · hold for reports' : amended ? 'Finish amendment' : 'Finish prescription'}<Icon name="chevR" className="h-4 w-4" /></button>
          </>}
          {readOnly && canFinish && e.status === 'completed' && <button type="button" className="btn btn-sm" onClick={() => { void amend(); }}>Amend</button>}
          {readOnly && <button type="button" className="btn btn-sm btn-primary" onClick={() => openPrint({ title: 'Prescription', rx: id })}><Icon name="print" className="h-4 w-4" />Print Rx</button>}
          </span>
        </div>);
        return <div className="card !px-4 !py-2.5">{who}</div>; })()}
      {/* tabs (an underline, not pills): the Rxpad, and the patient's past visits, photos and reports beside it */}
      {<div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {isDoctor ? <Tabs<'pad' | 'visits' | 'photos' | 'docs'> className="tabs-lg min-w-0 flex-1" value={tab} onChange={setTab} options={[{ value: 'pad', label: 'Rxpad' }, { value: 'visits', label: 'Past visits', count: previous.length || undefined }, { value: 'photos', label: 'Photos', count: ph.length || undefined }]} /> : <span className="flex-1" />}
        {/* the whole-pad templates and the pad's settings sit with the tabs */}
        <div className="flex flex-wrap items-center gap-2 py-1.5">
            {isDoctor && !readOnly && <><button ref={tplBtn} type="button" className="btn btn-sm" aria-expanded={tplOpen} onClick={() => setTplOpen(!tplOpen)}><LayoutTemplate className="h-3.5 w-3.5" aria-hidden />Templates</button>
              <Floating anchor={tplBtn} open={tplOpen} onClose={() => setTplOpen(false)} width={540}>
                <div className="grid grid-cols-[200px_minmax(0,1fr)] gap-2 p-1.5">
                  <div><input autoFocus aria-label="Search templates" className="input mb-1.5 !py-1.5" placeholder="Search" value={tplQ} onChange={(ev) => setTplQ(ev.target.value)} />
                    <div className="max-h-64 space-y-0.5 overflow-y-auto">{tplList.length === 0 ? <div className="px-2 py-2 text-xs text-muted">{tplQ ? 'No template by that name.' : 'No templates yet. Fill the pad, then press Save this pad as a template below.'}</div> : tplList.map((t: any) => <button key={t.id} type="button" className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] ${(tplSel ?? tplList[0])?.id === t.id ? 'bg-paper-2 font-semibold' : 'hover:bg-paper-2'}`} onClick={() => setTplSel(t)}><span className="min-w-0 flex-1 truncate">{t.name}</span>{t.uses > 0 && <span className="text-[11px] text-muted">{t.uses}×</span>}</button>)}</div></div>
                  {(tplSel ?? tplList[0]) ? (() => { const t = tplSel ?? tplList[0]; return <div className="rounded-md border border-line bg-surface-2 p-2.5 text-[12.5px] leading-relaxed">
                    <div className="mb-1 flex items-center gap-2"><b className="text-[13px]">{t.name}</b><button type="button" className="btn btn-sm btn-primary ml-auto" onClick={() => applyTpl(t)}>Load</button></div>
                    {joinList(t.data?.assessment?.diagnosis) && <div><b>Dx</b> {joinList(t.data.assessment.diagnosis)}</div>}
                    <div><b>℞</b> {(t.prescription ?? []).length ? (t.prescription ?? []).map((i: any) => `${i.name}${i.frequency ? ` · ${i.frequency}` : ''}${i.durationDays ? ` · ${i.durationDays} d` : ''}`).join('; ') : '—'}</div>
                    {t.data?.plan?.advice && <div><b>Advice</b> {String(t.data.plan.advice).split('\n').filter(Boolean).join(' · ')}</div>}
                    {(t.recommendations ?? []).length > 0 && <div><b>Plan</b> {(t.recommendations ?? []).map((r: any) => r.kind === 'followup' ? `review in ${r.intervalDays} d` : r.kind === 'investigation' ? r.notes : 'procedure').join(', ')}</div>}
                    <div className="mt-1 text-[11.5px] text-muted">Loading replaces the pad; your symptoms and review answers are kept. Clear loaded undoes it.</div></div>; })() : <div className="rounded-md border border-dashed border-line p-2.5 text-[12.5px] text-muted">A template here is the whole pad: diagnosis, medicines, advice, tests and plan, loaded in one tap.</div>}
                </div>
                <div className="flex items-center gap-1 border-t border-line p-1.5">
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setTplOpen(false); void askTpl(); }}><Save className="h-3.5 w-3.5" aria-hidden />Save this pad as a template</button>
                  {applied && <button type="button" className="btn btn-ghost btn-sm ml-auto" onClick={() => { clearLoaded(); setTplOpen(false); }}>Clear loaded ({applied})</button>}
                </div>
              </Floating></>}
            {isDoctor && can(perms, 'config.write') && <button type="button" className="btn btn-sm btn-icon" aria-label="Configure pad: sections, required, printing" title="Configure pad: sections, required, printing" onClick={() => nav('/settings?tab=pad')}><Icon name="gear" className="h-3.5 w-3.5" /></button>}
        </div>
        {missingList.length > 0 && <div className="flex w-full min-w-0 flex-wrap items-center gap-1.5 pb-2 text-xs" role="alert"><span className="font-semibold text-rose">Cannot finish yet:</span>
          {missingList.map((x) => <button key={x.path} type="button" className="rounded-[7px] bg-rose-soft px-2 py-0.5 font-semibold text-rose hover:bg-rose/15" onClick={() => goTo(secOf(x.path))}>{x.message.replace(/ is required$/, '')}</button>)}</div>}
      </div>}
      </div>
      <CarefulBanner flags={p.flags} />

      {tab === 'pad' && <>
        {held && <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[12px] bg-amber-soft px-4 py-2.5 text-[12.5px] text-amber anim-fade-in" role="status"><b>Held for reports.</b><span>Prescription issued {fmtDate(e.completedAt)}. {testsIn} of {testRecs.length} reports in{testsOpen ? `; pending: ${testRecs.filter((r: any) => r.status !== 'done').map((r: any) => `${r.notes}${r.expectedOn ? ` (expected ${fmtDate(r.expectedOn)})` : ''}`).join(', ')}` : ''}.</span>{canFinish && <span className="text-muted">Add or change what the results call for, then Complete. Issued medicines stay as written.</span>}</div>}
        {setNote && !readOnly && <div className="rounded-[12px] bg-amber-soft px-4 py-2.5 text-[12.5px] text-amber anim-fade-in" role="status">{setNote}</div>}
        {/* allergy, pregnancy and interaction: above the pad in every layout, not only beside the medicines table */}
        {warnings.length > 0 && !readOnly && <div className="rounded-[12px] bg-rose-soft px-4 py-2.5 text-[12.5px] text-rose anim-fade-in" role="alert"><b>Check the prescription.</b> {warnings.join(' ')} {unanswered.length ? 'Finish asks for a reason.' : problems.some((x) => x.serious) ? 'Reason given.' : ''}</div>}
        {restore && !readOnly && <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-[12px] bg-amber-soft px-4 py-2.5 text-[12.5px] text-amber anim-fade-in" role="alert"><span><b>This computer has a newer copy of this pad</b> that did not reach the server.</span>
          <button type="button" className="btn btn-sm" onClick={doRestore}>Restore what you typed at {restoreAt}</button><button type="button" className="btn btn-ghost btn-sm" onClick={dropRestore}>Keep the saved pad</button></div>}
        {amended && <div className="rounded-[12px] bg-amber-soft px-4 py-2.5 text-[12.5px] text-amber anim-fade-in" role="status"><b>Amending the signed prescription:</b> {e.amendments[e.amendments.length - 1].reason}. Finish signs it again; the print says Amended.</div>}

        {!canFinish && (!readOnly || Object.keys(answers).length > 0 || Object.keys(hist).length > 0) && <div className="card !p-0"><ScreenBlock lists={lists} answers={answers} onAnswers={(a) => set('screen', 'answers', a)} history={hist} onHistory={(h) => set('screen', 'history', h)} disabled={readOnly} open /></div>}
        {!canFinish && !padOf('history').show && cards.history}

        <div className="pad-grid grid items-start gap-3 lg:grid-cols-[minmax(240px,300px)_minmax(0,1fr)]">
          {/* Tatva's left column: the patient's basic info, each opening its own drawer */}
          <aside className="card !p-0 overflow-hidden lg:sticky lg:top-[124px]" aria-label="Basic info">
            {leftKeys.map((k) => { const v = LEFT[k].brief; const tiles = (k === 'vitals' && vitalCells.length > 0) || (k === 'history' && (histRows.length > 0 || !!histNote)) || (k === 'notes' && !!privNote); return (
              <button key={k} type="button" className="block w-full border-t border-line !px-3.5 !py-3 text-left transition-colors first:border-t-0 hover:bg-surface-2" onClick={() => setSide(k)} aria-haspopup="dialog">
                <span className="flex items-center gap-2.5">
                  <SecIcon id={k} />
                  <span className="min-w-0 flex-1"><span className="block text-[15.5px] font-bold">{LEFT[k].title}</span>{!tiles && v && <span className="block truncate text-xs text-muted" title={v}>{v}</span>}</span>
                  <span className="shrink-0 text-[12.5px] font-semibold text-clay">{v || tiles ? 'Edit' : readOnly ? 'View' : '+ Add'}</span>
                </span>
                {/* vitals: only the ones taken, each in its own small tile */}
                {k === 'history' && histRows.length > 0 && <span className="mt-2.5 grid grid-cols-[76px_minmax(0,1fr)] items-start gap-x-2 gap-y-1.5 text-[12.5px]">{histRows.map((r: any) => <Fragment key={r.label}><span className={`pt-[3px] ${r.allergy ? 'font-semibold text-rose' : 'text-muted'}`}>{r.label}</span><span className="flex flex-wrap gap-1">{r.names.map((n: string) => <span key={n} className={`rounded-[6px] px-2 py-0.5 font-medium ring-1 ${r.allergy ? 'bg-rose-soft text-rose ring-rose/30' : 'bg-field ring-line'}`}>{n}</span>)}</span></Fragment>)}</span>}
                {k === 'history' && histNote && <span className="mt-2 block border-t border-line pt-1.5 text-[12.5px] text-muted">{histNote}</span>}
                {k === 'notes' && privNote && <span className="mt-2 line-clamp-3 whitespace-pre-line text-[13px] leading-snug" title={privNote}>{privNote}</span>}
                {k === 'vitals' && tiles && <span className="mt-2.5 grid grid-cols-3 gap-1.5">{vitalCells.map(([l, val, fl]) => { const red = !!fl; return <span key={l} className={`min-w-0 rounded-[8px] px-2 py-1.5 ring-1 ${red ? 'bg-rose-soft ring-rose/30' : 'bg-field ring-line'}`} title={red ? `${l} ${fl}` : undefined}><span className={`block truncate text-[10.5px] font-medium uppercase tracking-wide ${red ? 'text-rose' : 'text-muted'}`}>{l}{red ? ` · ${fl}` : ''}</span><span className={`block truncate text-[13.5px] font-bold ${red ? 'text-rose' : ''}`}>{val}</span></span>; })}</span>}
              </button>); })}
          </aside>
          {(() => {
            const used: Record<string, boolean> = { tests: tests.length > 0, procedures: recs.some((r) => r.kind === 'procedure'), referral: !!(data.referral?.to || data.referral?.reason) };
            const OPT_TITLE: Record<string, string> = { tests: 'Investigations', procedures: 'Procedures', referral: 'Referral' };
            const waiting = !readOnly ? order.filter((k) => !LEFT[k] && k in OPT_TITLE && !used[k] && !addedSecs.has(k) && !padOf(k).required) : [];
            const secs = order.filter((k) => !LEFT[k] && k !== 'results' && !waiting.includes(k)); // results live in the Reports & records drawer
            return <div className="pad-sheet min-w-0 space-y-3">
              {secs.map((k) => cards[k] ?? null)}
              {customSections.map(custom)}
              {modIds.map(moduleCard)}
              {/* one line for everything that can be added: the optional sections, then a custom module (pick one the clinic has or make a new one) */}
              {(waiting.length > 0 || (!readOnly && isDoctor)) && <div className="card !px-4 !py-3 text-[14.5px]"><span className="text-muted">Add a section:</span> {waiting.map((k, n) => <span key={k}>{n > 0 && <span className="text-muted"> · </span>}<button type="button" className="font-medium text-clay hover:underline" onClick={() => { setAddedSecs(new Set(addedSecs).add(k)); setTimeout(() => document.getElementById(`sec-${k}`)?.scrollIntoView({ block: 'center' }), 50); }}>+ {OPT_TITLE[k]}</button></span>)}
                {!readOnly && isDoctor && <span>{waiting.length > 0 && <span className="text-muted"> · </span>}<button type="button" className="font-medium text-clay hover:underline" title={myMods.length ? `${myMods.length} on your pad` : 'Your own table on the pad'} onClick={() => setModDrawer({})}>+ Custom module</button></span>}</div>}
              {modDrawer && <AddModuleDrawer editing={modDrawer.edit} onClose={() => setModDrawer(null)} />}
            </div>; })()}
        </div>
      </>}

      {tab === 'visits' && <div className="card anim-fade-up">
        {previous.length === 0 && <div className="text-[13px] text-muted">First visit.</div>}
        {previous.slice(0, 12).map((x: any) => (
          <div key={x.id} className="flex items-center gap-3 border-t border-line/70 py-2.5 text-[13.5px] first:border-t-0 first:pt-0">
            <button type="button" className="w-16 shrink-0 text-left text-xs font-semibold text-muted hover:text-ink hover:underline" title={x.doctor?.name ?? ''} onClick={() => setViewing(x.id)}>{fmtDate(x.createdAt)}</button>
            <span className="min-w-0 flex-1 truncate">{x.data?.review?.response ? `${x.data.review.response} · ` : ''}{joinList(x.data?.assessment?.diagnosis) || joinList(x.data?.complaint?.chief_complaint) || 'Consultation'}{x.prescription?.length > 0 && <span className="text-muted"> · {x.prescription.map((i: any) => i.name).join(', ')}</span>}</span>
            <button type="button" className="btn btn-ghost btn-sm shrink-0" onClick={() => setViewing(x.id)}>Open</button>
            {!readOnly && x.status === 'completed' && <button type="button" className="btn btn-sm shrink-0" onClick={() => { loadPrevious(x, { dx: true, rx: true }); setTab('pad'); }}>Load Dx + Rx</button>}
          </div>))}
        {previous.length > 12 && <div className="pt-2 text-xs text-muted">Earlier · {previous.length - 12} more in the patient's file</div>}
        <div className="mt-3 border-t border-line pt-3"><ScreeningCard complaintText={arrivalText} lists={lists} answers={answers} history={hist} /></div>
      </div>}
      {tab === 'photos' && <div className="card anim-fade-up">
        {thenNow && <button className="mb-2 grid w-full max-w-md grid-cols-2 gap-1.5" onClick={() => setCompare(thenNow)} aria-label="Compare first and latest photo">{thenNow.map((x, k) => <span key={x.id} className="relative block aspect-square overflow-hidden rounded-lg bg-paper-2"><img src={`/api/documents/${x.id}/file`} alt={`${k ? 'Latest' : 'First'} ${x.area ?? ''}`} className="h-full w-full object-cover" /><span className="absolute bottom-1 left-1 rounded-md bg-black/55 px-1.5 text-[10px] font-semibold text-white">{fmtDate(x.takenAt)}</span></span>)}</button>}
        {ph.length > 0 && <div className="mb-2 grid grid-cols-4 gap-1.5 sm:grid-cols-6">{ph.slice(0, 12).map((x) => <div key={x.id} className="relative"><img src={`/api/documents/${x.id}/file`} alt={x.area ?? 'photo'} className="aspect-square w-full rounded-lg object-cover" />{can(perms, 'document.write') && <RemovePhoto photo={x} patientId={p.id} className="absolute right-1.5 top-1.5" />}</div>)}</div>}
        {ph.length === 0 && <div className="mb-2 text-xs text-muted">No photos yet.</div>}
        {can(perms, 'document.write') && !readOnly && <button className="btn btn-sm" onClick={() => setCapture(true)}><Icon name="spark" className="h-3.5 w-3.5" />Take photo</button>}
      </div>}

      {side && LEFT[side] && <Drawer from="left" dirty={sideDirty > 0} title={LEFT[side].title} subtitle={p.fullName} width={LEFT[side].width ?? 'max-w-xl'} onClose={() => setSide(null)}>{LEFT[side].body()}</Drawer>}
      {viewing && <EncounterModal id={viewing} onClose={() => setViewing(null)} />}
      {checking && <ReasonSheet warnings={checking} onCancel={() => { setChecking(null); goTo('medicines'); }} onDone={giveReasons} />}
      {signing && <Modal title={amended ? 'Sign the amended prescription' : 'Sign the prescription'} subtitle={p.fullName} width="max-w-2xl" onClose={() => setSigning(false)}>
        {overrides.length > 0 && <div className="mb-3 rounded-[12px] bg-rose-soft px-4 py-2.5 text-[12.5px] text-rose" role="alert"><b>Prescribed despite these checks:</b>{overrides.map((o, k) => <div key={k} className="mt-1">{o.warnings.join(' ')} <span className="text-ink">Reason: {o.reason}</span></div>)}</div>}
        <div className="overflow-auto rounded-xl border border-line bg-paper p-3" style={{ maxHeight: 'min(60vh, 700px)' }}><div className="mx-auto w-fit shadow-md"><PrintRx id={id} embed /></div></div>
        <div className="mt-2 text-xs text-muted">This is the paper exactly as it prints{willHold ? '; the visit stays open for the test reports' : ''}. Ctrl + Enter signs.</div>
        <div className="modal-foot"><button type="button" className="btn btn-ghost" onClick={() => setSigning(false)}>Back to the pad</button>
          <button type="button" className="btn btn-primary" disabled={save.isPending} onClick={sign}><Icon name="print" className="h-4 w-4" />Sign and finish</button></div>
      </Modal>}
      {capture && <PhotoCapture patient={{ id: p.id, fullName: p.fullName }} onClose={() => setCapture(false)} />}
      {compare && <PhotoCompare name={p.fullName} a={compare[0]} b={compare[1]} onClose={() => setCompare(null)} />}
    </div>
  );
}

function CompactField({ f, value, onChange, disabled, invalid }: { f: Field; value: any; onChange: (v: any) => void; disabled: boolean; invalid?: boolean }) {
  const [note, setNote] = useState(false); const [moreOpen, setMore] = useState(false); const moreBtn = useRef<HTMLButtonElement>(null);
  if (f.type === 'tags') {
    const v = asList(value);
    return <div><div className="flex flex-wrap items-center gap-1.5"><span className="mr-0.5 text-xs text-muted">{f.label}</span>
      {v.map((t) => <span key={t} className="pick-chip">{t}{!disabled && <button type="button" aria-label={`Remove ${t}`} className="ml-1" onClick={() => onChange(v.filter((x) => x !== t))}><Icon name="x" className="inline h-3 w-3" /></button>}</span>)}</div>
      {!disabled && <SearchLine placeholder={`Add ${f.label.toLowerCase()}`} options={f.options ?? []} invalid={invalid} onAdd={(t: string) => !v.includes(t) && onChange([...v, t])} />}
    </div>;
  }
  if (f.type === 'multiselect' || f.type === 'select') {
    const multi = f.type === 'multiselect'; const v: string[] = multi ? (value ?? []) : value ? [value] : [];
    const rest = f.options!.filter((o) => !v.includes(o)); const shown = [...f.options!.filter((o) => v.includes(o)), ...rest.slice(0, 5)]; const more = rest.slice(5);
    const chip = (o: string) => <button type="button" key={o} disabled={disabled} aria-pressed={v.includes(o)} className={v.includes(o) ? 'pick-chip' : 'opt-add'} onClick={() => { onChange(multi ? (v.includes(o) ? v.filter((x) => x !== o) : [...v, o]) : value === o ? undefined : o); setMore(false); }}>{o}</button>;
    const stray = v.filter((x) => !f.options!.includes(x)); // a value that is not one of the choices (an old pin area, say): shown so it can be taken out
    return <div className="flex flex-wrap items-center gap-1.5"><span className="mr-0.5 min-w-[92px] text-xs text-muted">{f.label}</span>{shown.map(chip)}
      {stray.map((x) => <span key={x} className="pick-chip !text-rose" title={`${x} is not one of the ${f.label} choices; take it out to finish`}>{x}{!disabled && <button type="button" aria-label={`Remove ${x}`} className="ml-1" onClick={() => onChange(multi ? v.filter((y) => y !== x) : undefined)}><Icon name="x" className="inline h-3 w-3" /></button>}</span>)}
      {!disabled && more.length > 0 && <><button ref={moreBtn} type="button" className="btn btn-ghost !min-h-7 gap-0.5 !px-2 text-[12.5px]" aria-expanded={moreOpen} onClick={() => setMore(!moreOpen)}>More ({more.length})<Icon name="chevR" className={`h-3.5 w-3.5 ${moreOpen ? "-rotate-90" : "rotate-90"}`} /></button>
        <Floating anchor={moreBtn} open={moreOpen} onClose={() => setMore(false)} width={300} align="left"><div className="flex flex-wrap gap-1.5 p-2">{more.map(chip)}</div></Floating></>}</div>;
  }
  if (f.type === 'textarea') {
    if (!value && !note) return disabled ? null : <button type="button" className="text-xs font-semibold text-muted underline" onClick={() => setNote(true)}>+ {f.label.toLowerCase()}</button>;
    // × takes the note out and folds the box back to its link; an empty box folds by itself when you leave it
    return <div className="relative"><textarea aria-label={f.label} autoFocus={note && !value} className={`input min-h-14 !pr-9 ${invalid ? '!border-rose' : ''}`} placeholder={f.placeholder ?? f.label} value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value)} onBlur={() => { if (!value) setNote(false); }} onKeyDown={(e) => { if (e.key === 'Escape' && !value) { e.preventDefault(); setNote(false); } }} />
      {!disabled && <button type="button" className="btn btn-ghost btn-icon absolute right-1.5 top-1.5 !h-7 !w-7" aria-label={value ? `Remove ${f.label.toLowerCase()}` : `Close ${f.label.toLowerCase()}`} title={value ? 'Remove this note' : 'Close'} onMouseDown={(e) => e.preventDefault()} onClick={() => { onChange(undefined); setNote(false); }}><Icon name="x" className="h-3.5 w-3.5" /></button>}</div>;
  }
  const cls = `input ${invalid ? '!border-rose' : ''}`;
  return <div className="flex items-center gap-2"><span className="w-20 shrink-0 text-xs text-muted">{f.label}{f.unit ? ` (${f.unit})` : ''}</span><div className="min-w-0 flex-1 sm:max-w-xs">
    {f.type === 'number' ? <NumInput decimal max={100000} className={cls} value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} />
      : f.type === 'date' ? <input type="date" className={cls} value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
      : <input className={cls} value={value ?? ''} placeholder={f.placeholder} disabled={disabled} onChange={(e) => onChange(e.target.value)} />}</div></div>;
}
