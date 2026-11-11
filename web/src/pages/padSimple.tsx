import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useNavigate, useParams, useOutletContext } from 'react-router';
import { get, patch, post, qc, ApiError, errText } from '../api';
import { can } from '../App';
import { LayoutTemplate, History as HistoryIcon } from 'lucide-react';
import { Avatar, Chip, Floating, Icon, Modal, Segmented, Skeleton, Tabs, fmtDate, toast, NumInput, ask } from '../ui';
import { openPrint } from '../printPreview';
import { PrintRx } from './PrintRx';
import { EncounterModal, DocList, UploadButton, asList, joinList } from '../encounterDetail';
import { usePhotos, PhotoCapture, PhotoCompare, RemovePhoto } from '../photos';
import { parseRxLine, qtyFor, allergyHit, rxWarnings, pregnancyFlag, ageText } from '../rxSafety';
import { FlagChips, CarefulBanner } from '../flags';
import { useTemplates, suggests, norm, uniq, type Tmpl } from '../templates';
import { ScreenBlock, ScreeningCard, checklists, complaintTexts, type Answers, type History } from '../screening';
import { HistoryChips } from '../historyChips';
import { VitalsCard } from '../vitals';
import { LabResultsCard, ReportLink, reportFor } from '../labs';
import { BodyMap, SkinMapPanel, usePins } from '../skinmap';

type Field = { key: string; label: string; type: string; required?: boolean; options?: string[]; unit?: string; placeholder?: string };
type RxItem = { id?: string; _issued?: boolean; medicineId?: string | null; name: string; dose?: string; route?: string; frequency?: string; durationDays?: number; instructions?: string; timing?: string | null; qty?: number | null; _qtyTouched?: boolean };
type Rec = { kind: 'followup' | 'procedure' | 'investigation'; procedureId?: string | null; intervalDays?: number; dueOn?: string; sittings?: number; notes?: string; orderNo?: number; status?: string; id?: string };
type Sym = { name: string; since?: string; severity?: string; note?: string };
type Dx = { name: string; severity?: string; status?: string };

const FREQ = ['1-0-0', '0-0-1', '1-0-1', '1-1-1', 'at night', 'once daily', 'twice daily', 'alternate days', 'weekly', 'SOS'];
const TIMING = ['after food', 'before food', 'empty stomach', 'at bedtime', 'with food'];
const TESTS = ['CBC', 'FBS / PPBS', 'HbA1c', 'LFT', 'RFT', 'Lipid profile', 'TSH', 'Vitamin D', 'Vitamin B12', 'Serum ferritin', 'KOH mount', 'Skin biopsy', 'Patch test', 'VDRL', 'HIV', 'HBsAg', 'ANA', 'Urine routine', 'Culture & sensitivity', 'Woods lamp'];
const ADVICE = ['Keep the area dry', "Don't share towels", 'Wash clothes in hot water', 'No steroid creams', 'Loose cotton clothes', 'Sunscreen every 3 hours', 'Moisturise twice daily', 'Avoid scrubbing', 'Avoid oily food', 'Mild soap only'];
const RESPONSES = ['Better', 'Same', 'Worse', 'New problem'];
const SIDE_EFFECTS = ['None', 'Dry lips', 'Dry skin', 'Irritation', 'Itching', 'Redness', 'Stomach upset', 'Headache'];
const REVIEW_IN: [number | null, string][] = [[7, '7d'], [14, '14d'], [30, '1 m'], [90, '3 m'], [null, 'none']];
const SEVERITIES = ['Mild', 'Moderate', 'Severe'];
const DX_STATUS = ['Provisional', 'Confirmed'];
const DX_OPTIONS = ['Acne vulgaris', 'Melasma', 'Tinea corporis', 'Tinea cruris', 'Psoriasis vulgaris', 'Alopecia areata', 'Androgenetic alopecia', 'Verruca vulgaris', 'Atopic dermatitis', 'Seborrheic dermatitis', 'Contact dermatitis', 'Acute urticaria', 'Chronic urticaria', 'Vitiligo', 'Post-inflammatory hyperpigmentation', 'Scabies', 'Pityriasis versicolor', 'Lichen planus', 'Rosacea', 'Molluscum contagiosum', 'Impetigo', 'Herpes zoster'];
// ponytail: the allergy, pregnancy and interaction word lists live in rxSafety.ts (tested in rxSafety2.test.ts); a proper drug database is the upgrade path.
const sameLine = (a: RxItem, b: RxItem) => a.name === b.name && (a.dose ?? '') === (b.dose ?? '') && (a.frequency ?? '') === (b.frequency ?? '') && (a.durationDays ?? null) === (b.durationDays ?? null) && (a.instructions ?? '') === (b.instructions ?? '');
const strip = ({ id, encounterId, tenantId, sortOrder, dispensed, issuedQty, notIssuedReason, createdAt, _qtyTouched, _issued, ...i }: any): RxItem => i;
/** The pad's own lines keep their id so a held-open consultation updates them instead of re-issuing; issued lines are locked. */
const own = (i: any): RxItem => ({ ...strip(i), id: i.id, _issued: !!(i.dispensed || i.issuedQty > 0) });
const asSym = (v: any): Sym[] => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? { name: x } : x)) : v ? [{ name: String(v) }] : []);
const asDx = (v: any): Dx[] => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? { name: x } : x)) : v ? [{ name: String(v) }] : []);
const isReviewVisit = (v: any, cfg: any) => { const code = v?.category; if (!code) return false; if (['REN', 'FREE'].includes(code)) return true; const cat = (cfg?.feeCategories ?? []).find((c: any) => c.code === code); return !!cat && (cat.amountPaise === 0 || /review|renew|follow/i.test(cat.name ?? '')); };
/** The exam list and option a skin-map finding belongs to: the same name, else the same word stem ("Hypopigmented" → "Hypopigmentation"). */
const examOptionFor = (fields: Field[], f: string): { field: Field; opt: string } | null => {
  const stem = (x: string) => x.trim().toLowerCase().slice(0, 8);
  for (const field of fields) { if (!['multiselect', 'tags', 'select'].includes(field.type)) continue; const opt = (field.options ?? []).find((o) => o.toLowerCase() === f.trim().toLowerCase() || stem(o) === stem(f)); if (opt) return { field, opt }; }
  return null;
};
const pinFindings = (p: { finding: string | null }) => (p.finding ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const PH = 'placeholder:italic placeholder:opacity-60'; // a placeholder that cannot be mistaken for a value
const withQty = (i: RxItem): RxItem => (i._qtyTouched || i.qty ? i : { ...i, qty: qtyFor(i) ?? undefined });
const ICON: Record<string, [string, string]> = { vitals: ['♡', '#5B8DB8'], symptoms: ['S', '#C53B14'], diagnosis: ['Dx', '#8A2E10'], exam: ['Ex', '#6F8F78'], medicines: ['℞', '#4F7396'], advice: ['A', '#B98B6E'], tests: ['T', '#7A6FB0'], results: ['R', '#B8860B'], followup: ['→', '#6F8F78'], procedures: ['Pr', '#285C9C'], notes: ['N', '#8B929C'], referral: ['Rf', '#5B8DB8'], history: ['H', '#8A2E10'], photos: ['P', '#6F8F78'] };

/** One section of the pad as its own card: icon tile, title, the header actions on the right, rows inside, the search line last. */
function Card({ id, title, meta, actions, children, required, invalid }: { id: string; title: string; meta?: ReactNode; actions?: ReactNode; children: ReactNode; required?: boolean; invalid?: boolean }) {
  const [ch, color] = ICON[id] ?? ['•', '#8B929C'];
  return (
    <section id={`sec-${id}`} className={`card !p-0 anim-fade-up ${invalid ? 'outline-2 outline-rose/70' : ''}`} style={{ '--sec': color } as Record<string, string>} aria-invalid={invalid || undefined}>
      <div className="flex flex-wrap items-center gap-2 px-4 pb-1.5 pt-3">
        <span className="pick-ink grid h-[22px] min-w-[22px] place-items-center rounded-[6px] px-1 text-[11px] font-bold" style={{ background: `color-mix(in srgb, ${color} 16%, var(--color-surface))` }} aria-hidden>{ch}</span>
        <span className="text-[14px] font-semibold">{title}{required && <span className="text-rose" title="Required to finish"> *</span>}</span>
        {meta && <span className="text-xs text-muted">{meta}</span>}
        {actions && <span className="ml-auto flex flex-wrap items-center gap-0.5">{actions}</span>}
      </div>
      <div className="px-4 pb-4">{children}</div>
    </section>
  );
}
const Act = ({ children, onClick, disabled, aria }: { children: ReactNode; onClick: () => void; disabled?: boolean; aria?: string }) => <button type="button" className="btn btn-ghost !min-h-7 !px-2 text-[12px] text-muted hover:text-ink" disabled={disabled} aria-label={aria} onClick={onClick}>{children}</button>;

/** The line at the foot of a card, Eka's "Start typing…": matches as you type, Enter adds the top match or what was typed. */
function SearchLine({ placeholder, options = [], onAdd, invalid, autoFocus }: { placeholder: string; options?: string[]; onAdd: (t: string) => void; invalid?: boolean; autoFocus?: boolean }) {
  const [v, setV] = useState(''); const [shut, setShut] = useState(false); const box = useRef<HTMLDivElement>(null);
  const q = v.trim().toLowerCase();
  const hits = q ? options.filter((o) => o.toLowerCase().includes(q)).slice(0, 8) : [];
  const add = (t: string) => { if (t.trim()) onAdd(t.trim()); setV(''); };
  return (
    <div ref={box} className="relative mt-2" data-invalid={invalid || undefined}>
      <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
      <input aria-label={placeholder} autoFocus={autoFocus} className={`input w-full !py-2 !pl-9 ${invalid ? '!outline-2 !outline-rose/70' : ''}`} placeholder={placeholder} value={v} onChange={(e) => { setV(e.target.value); setShut(false); }}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(hits[0] && hits[0].toLowerCase().startsWith(q) ? hits[0] : v); } else if (e.key === 'Escape') setV(''); }} />
      <Floating anchor={box} open={hits.length > 0 && !shut} onClose={() => setShut(true)} width={box.current?.offsetWidth ?? 320} align="left">
        <div className="p-1" role="listbox" aria-label={placeholder}>{hits.map((o) => <button key={o} type="button" role="option" aria-selected={false} className="flex w-full rounded-[10px] px-2.5 py-2 text-left text-[13px] font-medium hover:bg-paper-2" onMouseDown={(e) => e.preventDefault()} onClick={() => add(o)}>{o}</button>)}</div>
      </Floating>
    </div>
  );
}

/** Examination's small skin map: the figure with this patient's pins (front, or back when only the back has pins), and the pins as one line.
 *  Tapping it opens the full map, where pins are added, moved and photographed. */
function ExamMap({ patientId, encounterId, onOpen }: { patientId: string; encounterId?: string; onOpen: () => void }) {
  const pins = usePins(patientId).data ?? [];
  const side = pins.some((p) => p.side === 'front') || !pins.length ? 'front' : 'back';
  return (
    <div className="flex flex-col items-center gap-1.5 rounded-xl border border-line p-2">
      <BodyMap side={side} pins={pins} selectedId={null} onSelect={onOpen} onPropose={onOpen} encounterId={encounterId} height={150} />
      <button type="button" className="text-[11.5px] font-semibold text-muted underline hover:text-ink" onClick={onOpen}>{pins.length ? `Skin map · ${pins.length} pin${pins.length === 1 ? '' : 's'}` : 'Open skin map'}</button>
    </div>
  );
}
const PinLine = ({ patientId, onOpen }: { patientId: string; onOpen: () => void }) => {
  const pins = usePins(patientId).data ?? []; if (!pins.length) return null;
  const no = (p: any) => pins.filter((q) => q.side === p.side).indexOf(p) + 1;
  return <div className="flex flex-wrap items-center gap-x-3 gap-y-1"><span className="min-w-[92px] text-xs text-muted">Pins</span>{pins.map((p) => <button key={p.id} type="button" className="text-[13px] hover:underline" onClick={onOpen}><b className="pick-ink">{no(p)}{p.side === 'back' ? ' (back)' : ''}</b> {p.area}{p.diagnosis ? ` · ${p.diagnosis}` : ''}</button>)}</div>;
};

/** One row inside a card: the item, its details, and the remove button at the right edge. */
const Row = ({ children, onRemove, label, plain }: { children: ReactNode; onRemove?: (() => void) | null; label: string; plain?: boolean }) => (
  <div className={plain ? 'flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-line/70 py-2 first:border-t-0 first:pt-0' : 'pick'}>
    {!plain && <Icon name="check" className="pick-ink h-3.5 w-3.5 shrink-0" />}
    {children}
    {onRemove ? <button type="button" className="btn btn-ghost btn-icon ml-auto !h-7 !w-7" aria-label={`Remove ${label}`} onClick={onRemove}><Icon name="x" className="h-3.5 w-3.5" /></button> : <span className="ml-auto" />}
  </div>
);

/** What one past visit had in one section, as short lines: what From last visit shows and loads. */
type Part = 'sx' | 'dx' | 'ex' | 'rx' | 'advice' | 'tests';
const PART_LABEL: Record<Part, string> = { sx: 'Symptoms', dx: 'Diagnosis', ex: 'Findings', rx: 'Medicines', advice: 'Advice', tests: 'Tests' };
const partItems = (x: any, part: Part): string[] => {
  const d = x.data ?? {};
  if (part === 'sx') return asSym(d.complaint?.chief_complaint).map((s) => [s.name, s.since && `since ${s.since}`, s.severity?.toLowerCase()].filter(Boolean).join(' · '));
  if (part === 'dx') return asDx(d.assessment?.diagnosis).map((s) => [s.name, s.severity?.toLowerCase()].filter(Boolean).join(' · '));
  if (part === 'ex') return Object.values(d.exam ?? {}).flatMap((v: any) => (Array.isArray(v) ? v : v ? [String(v)] : [])).map(String);
  if (part === 'rx') return (x.prescription ?? []).map((i: any) => [i.name, i.dose, i.frequency, i.durationDays ? `${i.durationDays} d` : null].filter(Boolean).join(' · '));
  if (part === 'advice') return String(d.plan?.advice ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
  return (x.recommendations ?? []).filter((r: any) => r.kind === 'investigation' && r.notes).map((r: any) => r.notes);
};

/** From last visit: pick an earlier visit (the last one first) and tick which parts come over; anything already on the pad is kept once. */
function LoadPrevious({ previous, onLoad, id }: { previous: any[]; onLoad: (e: any, parts: Record<string, boolean>) => void; id?: string }) {
  const [open, setOpen] = useState(false); const [sel, setSel] = useState<any>(null); const btn = useRef<HTMLButtonElement>(null);
  const [parts, setParts] = useState<Record<string, boolean>>({ dx: true, rx: true, advice: false, tests: false });
  const done = previous.filter((x) => x.status === 'completed'); const e = done.find((x) => x.id === sel?.id) ?? done[0];
  if (!done.length) return null; // first visit: nothing to bring over
  return (
    <>
      <button ref={btn} id={id} type="button" className="btn btn-sm" title="Diagnosis, medicines, advice or tests from an earlier visit" aria-expanded={open} onClick={() => setOpen(!open)}><HistoryIcon className="h-3.5 w-3.5" aria-hidden />From last visit</button>
      <Floating anchor={btn} open={open} onClose={() => setOpen(false)} width={460}>
        <div className="p-2">
          <div className="px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">From an earlier visit</div>
          {<div className="mb-2 flex flex-wrap gap-3 text-[12.5px]">{([['dx', 'Diagnosis'], ['rx', 'Medicines'], ['advice', 'Advice'], ['tests', 'Tests']] as const).map(([k, l]) => <label key={k} className="inline-flex items-center gap-1.5 font-medium"><input type="checkbox" className="accent-ink" checked={!!parts[k]} onChange={(ev) => setParts({ ...parts, [k]: ev.target.checked })} />{l}</label>)}</div>}
          <div className="max-h-44 space-y-1 overflow-y-auto">{done.slice(0, 10).map((x) => <button key={x.id} type="button" className={`w-full rounded-md border px-2.5 py-1.5 text-left text-[12.5px] ${e?.id === x.id ? 'border-ink bg-surface-2' : 'border-line hover:bg-surface-2'}`} onClick={() => setSel(x)}>
            <div className="flex items-center gap-2"><b>{fmtDate(x.createdAt)}</b><span className="text-muted">{x.doctor?.name ?? ''}</span></div>
            <div className="truncate text-xs text-muted">{[joinList(x.data?.assessment?.diagnosis), (x.prescription ?? []).map((i: any) => i.name).join(', ')].filter(Boolean).join(' · ') || 'Consultation'}</div></button>)}</div>
          {e && <div className="mt-2 rounded-md border border-line bg-surface-2 p-2.5 text-[12.5px] leading-relaxed">
            {(['dx', 'rx', 'advice', 'tests'] as Part[]).filter((k) => parts[k]).map((k) => <div key={k}><b>{PART_LABEL[k]}</b> {partItems(e, k).join('; ') || '—'}</div>)}
          </div>}
          <div className="mt-2 flex items-center gap-2"><span className="text-xs text-muted">Anything already on the pad is kept once.</span><button type="button" className="btn btn-sm btn-primary ml-auto" disabled={!e || !Object.values(parts).some(Boolean)} onClick={() => { onLoad(e, parts); setOpen(false); }}>Load</button></div>
        </div>
      </Floating>
    </>
  );
}

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
        onKeyDown={(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setSel((s) => Math.min(list.length - 1, s + 1)); } else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(-1, s - 1)); } else if (e.key === 'Enter' && open && sel >= 0 && list[sel]) { e.preventDefault(); pick(list[sel]); } else if (e.key === 'Escape' || e.key === 'Tab') setOpen(false); }} />
      {/* above the page, not inside the card: a card's glass would hide a list that runs past its foot */}
      <Floating anchor={box} open={open && !disabled && list.length > 0} onClose={() => setOpen(false)} width={Math.max(220, box.current?.offsetWidth ?? 0)} align="left">
        <div className="max-h-64 overflow-y-auto p-1" role="listbox" aria-label={label}>
          {list.map((o, k) => <button key={o} type="button" role="option" aria-selected={o === value} className={`flex w-full items-center gap-2 rounded-[4px] px-2.5 py-1.5 text-left text-[13px] hover:bg-paper-2 ${k === sel ? 'bg-paper-2' : ''} ${o === value ? 'font-bold' : 'font-medium'}`} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(o)}><span className="min-w-0 flex-1 truncate">{o}</span>{detail?.(o) && <span className="shrink-0 text-[11px] text-muted">{detail(o)}</span>}</button>)}
        </div>
      </Floating>
    </div>
  );
}

/** The consultation on one pad: section cards in the clinic's order, one add-anything line on top, Sets and From last visit in the header, Finish signs. */
/** The third pad model, Simple: picked on the pad's model switch beside Stacked and Focused; those two live in Encounter.tsx, unchanged. */
export function PadSimple({ onLayout }: { onLayout: (v: 'stacked' | 'focused' | 'review') => void }) {
  const { id } = useParams(); const nav = useNavigate(); const { cfg, perms, me } = useOutletContext<any>();
  const enc = useQuery({ queryKey: ['encounter', id], queryFn: () => get(`/encounters/${id}`) });
  const timeline = useQuery({ queryKey: ['timeline', enc.data?.patientId], queryFn: () => get(`/patients/${enc.data.patientId}/timeline`), enabled: !!enc.data });
  const docs = useQuery({ queryKey: ['documents', enc.data?.patientId], queryFn: () => get(`/patients/${enc.data.patientId}/documents`), enabled: !!enc.data });
  const isDoctor = can(perms, 'encounter.complete') || can(perms, 'encounter.*');
  const tpls = useQuery({ queryKey: ['rx-templates'], queryFn: () => get('/rx-templates'), enabled: isDoctor });
  const stock = useQuery({ queryKey: ['encounters-stock'], queryFn: () => get('/encounters-stock'), enabled: isDoctor, staleTime: 60_000 });
  const frequent = useQuery({ queryKey: ['encounters-frequent'], queryFn: () => get('/encounters-frequent'), enabled: isDoctor, staleTime: 300_000 });
  const sets = useTemplates();
  const photos = usePhotos(enc.data?.patientId);
  const [data, setData] = useState<Record<string, any>>({});
  const [rx, setRx] = useState<RxItem[]>([]);
  const [recs, setRecs] = useState<Rec[]>([]);
  const [errors, setErrors] = useState<{ path: string; message: string }[]>([]);
  const [showMissing, setShowMissing] = useState(false); // Finish was tried: list what is still missing until it is complete
  const [savedAt, setSavedAt] = useState<string>('');
  const [mapOpen, setMapOpen] = useState(false); // the full skin map, opened from Examination
  const [viewing, setViewing] = useState<string | null>(null);
  const pinsQ = usePins(enc.data?.patientId ?? '');
  const [testDraft, setTestDraft] = useState(''); const [line, setLine] = useState(''); const [pendingLine, setPendingLine] = useState<string | null>(null);
  const [applied, setApplied] = useState<string | null>(null); const undo = useRef<{ data: any; rx: RxItem[]; recs: Rec[] } | null>(null);
  const [seOpen, setSeOpen] = useState(false); // the side-effect options are folded until asked for
  const [tplOpen, setTplOpen] = useState(false); const [tplQ, setTplQ] = useState(''); const [tplSel, setTplSel] = useState<any>(null); const tplBtn = useRef<HTMLButtonElement>(null);
  const [setNote, setSetNote] = useState('');
  const [tab, setTab] = useState<'pad' | 'visits' | 'photos' | 'docs'>('pad'); // the pad, or one of the patient's collections beside it
  const [slot, setSlot] = useState<HTMLElement | null>(null); // the app's top bar keeps a place for the patient on the pad
  useEffect(() => { setSlot(document.getElementById('topbar-slot')); }, []);
  const goTo = (k: string) => document.getElementById(`sec-${k}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  const [signing, setSigning] = useState(false); // Finish → the sign-off sheet
  const [capture, setCapture] = useState(false); const [compare, setCompare] = useState<[any, any] | null>(null);
  const loaded = useRef(false); const dirty = useRef(false); const justLoaded = useRef(false);
  const previous = (timeline.data?.encounters ?? []).filter((x: any) => x.id !== id);
  const lastDone = previous.find((x: any) => x.status === 'completed');
  useEffect(() => {
    if (enc.data && timeline.data && !loaded.current) {
      // Complaints typed at arrival pre-fill the pad so nobody types them twice; a review carries the diagnosis forward.
      const arrival: Sym[] = (enc.data.visit?.details?.complaints ?? []).map((c: any) => ({ name: c.text, ...(c.duration ? { since: c.duration } : {}) }));
      let d = { ...(enc.data.data ?? {}) };
      if (!asSym(d.complaint?.chief_complaint).length && arrival.length) d = { ...d, complaint: { ...(d.complaint ?? {}), chief_complaint: arrival } };
      if (isDoctor && enc.data.status === 'draft' && isReviewVisit(enc.data.visit, cfg) && !asDx(d.assessment?.diagnosis).length && lastDone?.data?.assessment?.diagnosis) d = { ...d, assessment: { ...(d.assessment ?? {}), diagnosis: lastDone.data.assessment.diagnosis } };
      loaded.current = true; justLoaded.current = true; setData(d); setRx(enc.data.prescription.map(own));
      // a save that never reached the server was kept on this computer: bring it back and save it again
      let kept: any = null; try { kept = JSON.parse(localStorage.getItem(`pad-draft:${id}`) ?? 'null'); if (kept && enc.data.status === 'completed') { localStorage.removeItem(`pad-draft:${id}`); kept = null; } } catch { kept = null; }
      if (kept) { setData(kept.data); setRx(kept.rx); setRecs(kept.recs); setSaveFailed(true); dirty.current = true; return; }
      const opened = new Date(new Date(enc.data.createdAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) + 'T00:00:00Z').getTime();
      setRecs(enc.data.recommendations.map((r: any) => ({ id: r.id, status: r.status, orderNo: r.orderNo, kind: r.kind, procedureId: r.procedureId, dueOn: r.dueOn, sittings: r.sittings, notes: r.notes,
        intervalDays: r.kind === 'followup' && r.dueOn ? Math.round((new Date(r.dueOn + 'T00:00:00Z').getTime() - opened) / 86400000) : undefined })));
    }
  }, [enc.data, timeline.data]);
  const cleanRx = () => rx.filter((i) => i.name).map(({ _qtyTouched, _issued, ...i }) => i);
  const [saveFailed, setSaveFailed] = useState(false); // the last save did not reach the server: say so, the notes stay on screen
  const localKey = `pad-draft:${id}`;
  const save = useMutation({
    // d: the data to send when it was changed in the same tick (the reason given at Finish), before React has re-rendered
    mutationFn: ({ complete, d }: { complete: boolean; back?: boolean; d?: Record<string, any>; via?: 'print' | 'whatsapp' }) => patch(`/encounters/${id}`, { data: d ?? data, prescription: cleanRx(), recommendations: recs.filter((r) => r.kind !== 'investigation' || (r.notes && r.status !== 'done')), complete }),
    onSuccess: (_e, { complete, back, via }) => {
      try { localStorage.removeItem(localKey); } catch { /* private mode */ }
      if (complete) { setErrors([]); setShowMissing(false); setSigning(false); } dirty.current = false; setSaveFailed(false); setSavedAt(new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }));
      ['queue', 'frontdesk', 'timeline'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      qc.invalidateQueries({ queryKey: ['print', id] }); // print never shows what was there before this save
      if (complete && held) { toast('Consultation completed'); openPrint({ title: 'Results sheet', rx: id, mode: 'results' }); nav('/today', { viewTransition: true }); }
      else if (complete) { toast(via === 'whatsapp' ? 'Signed · the prescription goes to the patient on WhatsApp' : willHold ? 'Signed · held open for the reports' : 'Signed'); if (via !== 'whatsapp') openPrint({ title: 'Prescription', rx: id }); nav(isDoctor ? '/today' : '/queue', { viewTransition: true }); }
      else if (back && held) { toast('Kept open for the rest of the reports'); nav('/today', { viewTransition: true }); }
      else if (back) { toast('Intake saved · ready for the doctor'); nav('/queue', { viewTransition: true }); }
    },
    onError: (e: any, vars) => { if (e instanceof ApiError && e.body.code === 'FORM_INVALID') { setSigning(false); setErrors(e.body.errors); toast(`Please fill in: ${e.body.errors.map((x: any) => x.message?.replace(/ is required$/, '') || x.path.split('.')[1]).slice(0, 3).join(', ')}`, 'err'); setTimeout(() => document.querySelector('[data-invalid="true"]')?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 80); } else { setSaveFailed(true); try { localStorage.setItem(localKey, JSON.stringify({ at: Date.now(), data: vars.d ?? data, rx, recs })); } catch { /* private mode */ } toast(errText(e), 'err'); } },
  });
  // findings already ticked on this visit's skin-map pins belong in this visit's exam lists too (once, when the pad opens)
  const pinsSynced = useRef(false);
  useEffect(() => {
    if (pinsSynced.current || !loaded.current || !pinsQ.data || !enc.data || enc.data.status === 'completed') return;
    pinsSynced.current = true;
    const fields: Field[] = enc.data.form?.sections?.find((x: any) => x.key === 'exam')?.fields ?? [];
    const found = pinsQ.data.filter((p) => p.encounterId === id).flatMap(pinFindings).map((f) => examOptionFor(fields, f)).filter(Boolean) as { field: Field; opt: string }[];
    if (found.length) setData((d) => { const ex = { ...(d.exam ?? {}) }; let changed = false;
      for (const { field, opt } of found) { if (field.type === 'select') { if (!ex[field.key]) { ex[field.key] = opt; changed = true; } } else { const cur: string[] = Array.isArray(ex[field.key]) ? ex[field.key] : []; if (!cur.includes(opt)) { ex[field.key] = [...cur, opt]; changed = true; } } }
      return changed ? { ...d, exam: ex } : d; });
  }, [pinsQ.data, enc.data, data]);
  // opening the pad is not an edit: the first render after loading does not mark it dirty, so nothing is saved until something changes
  useEffect(() => { if (justLoaded.current) { justLoaded.current = false; return; } if (loaded.current) dirty.current = true; }, [data, rx, recs]);
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
  const addAdvice = (lines: string[]) => setData((d) => { const c = String(d.plan?.advice ?? '').split('\n').map((x) => x.trim()).filter(Boolean); return { ...d, plan: { ...(d.plan ?? {}), advice: uniq([...c, ...lines.map((l) => l.trim()).filter(Boolean)]).join('\n') } }; });
  const applySet = (t: Tmpl): string => {
    const p = t.payload ?? {}; let added = 0, had = 0;
    const count = (names: string[], have: string[]) => names.forEach((n) => (have.includes(norm(n)) ? had++ : added++));
    if (t.kind === 'medicine') { count((p.items ?? []).map((i: RxItem) => i.name), rx.filter((r) => r.name).map((r) => norm(r.name))); addRxMany(p.items ?? []); }
    else if (t.kind === 'advice') { count(p.lines ?? [], String(data.plan?.advice ?? '').split('\n').map((x) => norm(x))); addAdvice(p.lines ?? []); }
    else if (t.kind === 'finding') { const opts: string[] = enc.data?.form?.sections?.flatMap((s: any) => s.fields).find((f: Field) => f.key === 'morphology')?.options ?? []; const chips = (p.chips ?? []).filter((c: string) => opts.includes(c)); count(chips, (data.exam?.morphology ?? []).map(norm)); setData((d) => ({ ...d, exam: { ...(d.exam ?? {}), morphology: uniq([...(d.exam?.morphology ?? []), ...chips]) } })); }
    else if (t.kind === 'tests') { count((p.tests ?? []).map((x: any) => x.name), recs.filter((r) => r.kind === 'investigation').map((r) => norm(r.notes ?? ''))); for (const x of p.tests ?? []) addTestNamed(x.name); }
    else if (t.kind === 'symptom') { count((p.items ?? []).map((x: Sym) => x.name), asSym(data.complaint?.chief_complaint).map((s) => norm(s.name))); addSyms(p.items ?? []); }
    else if (t.kind === 'diagnosis') { count((p.items ?? []).map((x: Dx) => x.name), dNames); addDxs(p.items ?? []); }
    else if (t.kind === 'procedure') { if (recs.some((r) => r.kind === 'procedure' && r.procedureId === p.procedureId)) had++; else { added++; setRecs((cur) => (cur.some((r) => r.kind === 'procedure' && r.procedureId === p.procedureId) ? cur : [...cur, { kind: 'procedure', procedureId: p.procedureId, sittings: p.sittings, notes: p.intervalDays ? `every ${p.intervalDays} days` : undefined }])); } }
    markApplied(t.id); post(`/templates/${t.id}/use`).catch(() => {});
    return `${t.name}: ${added ? `added ${added}` : 'nothing new'}${had ? `, ${had} already there` : ''}.`;
  };
  const autoKey = (sets.data ?? []).filter((t) => t.mode === 'auto' && !appliedIds.includes(t.id) && suggests(t, cNames, dNames)).map((t) => t.id).join(',');
  useEffect(() => {
    if (!loaded.current || !isDoctor || enc.data?.status === 'completed' || !autoKey) return;
    const notes = (sets.data ?? []).filter((t) => autoKey.split(',').includes(t.id)).map(applySet);
    if (notes.length) setSetNote(notes.join(' '));
  }, [autoKey, enc.data?.status, isDoctor]);
  const saveTpl = useMutation({ mutationFn: (name: string) => post('/rx-templates', { name, data, prescription: cleanRx(), recommendations: recs }), onSuccess: (r: any) => { qc.invalidateQueries({ queryKey: ['rx-templates'] }); toast(`Saved as the set “${r.name}”`); }, onError: (e) => toast(errText(e), 'err') });

  if (!enc.data || !timeline.data) return <div className="card"><Skeleton rows={5} /></div>;
  const e = enc.data; const p = e.patient; const held = e.status === 'awaiting_reports'; const readOnly = e.status === 'completed' || (held && !isDoctor);
  const testRecs: any[] = e.recommendations.filter((r: any) => r.kind === 'investigation' && r.status !== 'cancelled'); const testsIn = testRecs.filter((r: any) => r.status === 'done').length; const testsOpen = testRecs.length > testsIn;
  const willHold = !held && recs.some((r) => r.kind === 'investigation' && r.notes && r.status !== 'done'); // what Finish will do with the tests on the pad right now
  const set = (s: string, k: string, v: any) => { setErrors((er) => er.filter((x) => x.path !== `${s}.${k}`)); setData((d) => ({ ...d, [s]: { ...(d[s] ?? {}), [k]: v } })); };
  const err = (s: string, k: string) => missingList.find((x) => x.path === `${s}.${k}`)?.message; // missingList is built below; err runs at render time
  const meds: any[] = cfg?.medicines ?? [];
  const lastRx: RxItem[] = (lastDone?.prescription ?? []).map(strip);
  const lastRaw: any[] = lastDone?.prescription ?? [];
  const isReview = isDoctor && !!lastDone && lastRx.length > 0;
  const visitNo = previous.length + 1;
  const QUICK = 8; // common picks per card; the rest are in the search line
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
    const r = await ask({ title: 'Save this pad as a set', body: 'Saves symptoms, findings, diagnosis, medicines, advice and plan. Using the same name again updates it.', confirmLabel: 'Save', field: { label: 'Name of the set', required: true, initial: asDx(data.assessment?.diagnosis).map((d) => `${d.name}${d.severity ? ` · ${d.severity.toLowerCase()}` : ''}`).join(' + ') || '', maxLength: 80 } });
    if (r?.value && r.value.trim().length >= 2) saveTpl.mutate(r.value.trim());
  };
  const loadPrevious = (x: any, parts: Record<string, boolean>) => {
    if (parts.sx) addSyms(asSym(x.data?.complaint?.chief_complaint));
    if (parts.ex) setData((d) => { const ex = { ...(d.exam ?? {}) }; for (const [k, v] of Object.entries(x.data?.exam ?? {})) { if (Array.isArray(v)) ex[k] = uniq([...(Array.isArray(ex[k]) ? ex[k] : []), ...v]); else if (v && !ex[k]) ex[k] = v; } return { ...d, exam: ex }; });
    if (parts.dx) addDxs(asDx(x.data?.assessment?.diagnosis));
    if (parts.rx) addRxMany((x.prescription ?? []).map(strip));
    if (parts.advice && x.data?.plan?.advice) addAdvice(String(x.data.plan.advice).split('\n'));
    if (parts.tests) for (const r of (x.recommendations ?? []).filter((r: any) => r.kind === 'investigation' && r.notes)) addTestNamed(r.notes);
    setSetNote(`Loaded from ${fmtDate(x.createdAt)}. Anything already on the pad was kept once.`);
  };
  /** The type-anything bar: a line is filed where it belongs by matching the clinic's lists; when nothing matches, the doctor says where. */
  const smartAdd = (raw: string, as?: 'symptom' | 'diagnosis' | 'medicine' | 'test' | 'advice') => {
    const v = raw.trim(); if (!v) return; const lc = v.toLowerCase();
    const it = parseRxLine(v, meds);
    const dxOpt = [...DX_OPTIONS, ...(dxField?.options ?? [])].find((o) => o.toLowerCase() === lc || (lc.length >= 4 && o.toLowerCase().startsWith(lc)));
    const testOpt = TESTS.find((o) => o.toLowerCase() === lc) ?? (cfg?.labParams ?? []).find((o: any) => o.name.toLowerCase() === lc)?.name;
    // "itching 2 weeks" → the symptom Itching since 2 weeks
    const m = v.match(/^(.*?)\s+(?:since\s+|for\s+|x\s*)?(\d+\s*(?:d|days?|w|wks?|weeks?|m|months?|y|years?))$/i);
    const base = (m ? m[1] : v).trim().toLowerCase();
    const symOpt = (symField?.options ?? []).find((o: string) => o.toLowerCase() === base || o.toLowerCase().startsWith(base) || base.startsWith(o.toLowerCase()));
    const kind = as ?? (it?.medicineId ? 'medicine' : testOpt ? 'test' : dxOpt ? 'diagnosis' : symOpt ? 'symptom' : null);
    if (!kind) { setPendingLine(v); return; }
    if (kind === 'medicine') addRx(it ?? { name: v }); else if (kind === 'test') addTestNamed(testOpt ?? v); else if (kind === 'diagnosis') addDxs([{ name: dxOpt ?? v }]);
    else if (kind === 'advice') addAdvice([v]); else addSyms([{ name: symOpt ?? (m ? m[1].trim() : v), ...(m ? { since: m[2] } : {}) }]);
    setLine(''); setPendingLine(null);
  };
  // the medicine name plus its generic when the catalogue has one, so a brand is caught by what it is
  const medText = (i: RxItem) => { const m = meds.find((x: any) => x.id && x.id === i.medicineId); return `${i.name} ${m?.generic ?? ''} ${m?.allergyClass ?? ''}`; };
  const allergyWarnings = rx.filter((i) => i.name).map((i) => [i.name, allergyHit(p.allergies, medText(i))] as const).filter(([, w]) => w);
  const pregnant = pregnancyFlag(p.history);
  const medOf = (i: RxItem) => meds.find((m: any) => m.id && m.id === i.medicineId);
  const warnings = isDoctor ? rxWarnings(rx.filter((i) => i.name).map((i) => ({ name: i.name, generic: medOf(i)?.generic, allergyClass: medOf(i)?.allergyClass })), { name: String(p.fullName ?? '').split(' ')[0], allergies: p.allergies, pregnant }) : [];
  // reasons the doctor gave for prescribing despite a check; the sign-off sheet lists those that still apply
  const allOverrides: { at: string; warnings: string[]; reason: string }[] = Array.isArray(data.overrides) ? data.overrides : [];
  const overrides = allOverrides.filter((o) => o.warnings.some((w) => warnings.includes(w)));
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
    if (!dxs.length) out.push({ path: 'assessment.diagnosis', message: 'Diagnosis is required' });
    if (padOf('exam').required && !Object.values(data.exam ?? {}).some((v: any) => (Array.isArray(v) ? v.length : v))) out.push({ path: 'exam._', message: 'Examination is required' });
    if (padOf('medicines').required && !rx.some((i) => i.name)) out.push({ path: 'medicines._', message: 'Medicines is required' });
    // a medicine line must say how often and for how long, or it prints as a bare name
    if (isDoctor) rx.forEach((i, k) => { if (!i.name || i._issued) return; const gap = [!i.frequency?.trim() && 'how often', !i.durationDays && 'for how many days'].filter(Boolean).join(' and '); if (gap) out.push({ path: `medicines.${k}`, message: `Add ${gap} for ${i.name}` }); });
    for (const s of formSections as any[]) for (const f of (s.fields ?? []) as Field[]) { const v = data[s.key]?.[f.key]; if (f.required && !(Array.isArray(v) ? v.length : v) && !out.some((x) => x.path === `${s.key}.${f.key}`)) out.push({ path: `${s.key}.${f.key}`, message: `${(s.fields as Field[]).filter((x) => x.required).length > 1 ? `${s.title} › ${f.label}` : f.label} is required` }); }
    return out;
  };
  const finish = async () => {
    const missing = missingNow();
    if (missing.length) { setShowMissing(true); goTo(secOf(missing[0].path)); toast(`Cannot finish yet: ${missing.map((m) => m.message.replace(/ is required$/, '')).join(', ')}`, 'err'); return; }
    if (held) return save.mutate({ complete: true }); // after the reports: the prescription was signed when it went out
    // allergy, same medicine twice, pregnancy or interaction: stop and ask for the reason (once per check); it is kept with the consultation, never printed
    let d = data;
    const open = warnings.filter((w) => !allOverrides.some((o) => o.warnings.includes(w)));
    if (open.length) {
      const r = await ask({ title: 'Check before finishing', tone: 'danger', confirmLabel: 'Prescribe anyway', body: <div className="space-y-1">{open.map((w) => <div key={w} className="font-semibold text-rose">{w}</div>)}<div>Remove it, or give a reason to prescribe.</div></div>, field: { label: 'Reason to prescribe', required: true, maxLength: 300 } });
      if (!r?.value?.trim()) { goTo('medicines'); return; }
      d = { ...data, overrides: [...allOverrides, { at: new Date().toISOString(), warnings: open, reason: r.value.trim() }] };
      setData(d);
    }
    // save first, so the sign-off sheet shows exactly what will print
    try { await save.mutateAsync({ complete: false, d }); } catch { return; }
    await qc.invalidateQueries({ queryKey: ['print', id] });
    setSigning(true);
  };
  /** Amend after signing: a reason is required; it is audited and prints on the prescription. */
  const amend = async () => {
    const r = await ask({ title: 'Amend the signed prescription', body: 'The pad opens again for changes. The reason prints on the prescription as “Amended” and is kept in the audit log.', confirmLabel: 'Amend', field: { label: 'Reason for the change', required: true, maxLength: 300 } });
    if (!r?.value || r.value.trim().length < 3) return;
    try { await post(`/encounters/${id}/amend`, { reason: r.value.trim() }); loaded.current = false; await qc.invalidateQueries({ queryKey: ['encounter', id] }); qc.invalidateQueries({ queryKey: ['print', id] }); toast('Open for changes. Finish signs it again.'); }
    catch (err) { toast(errText(err), 'err'); }
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
  const labNames = uniq([...TESTS, ...(cfg?.labParams ?? []).map((o: any) => o.name)]);
  const procName = (id?: string | null) => cfg?.procedures?.find((x: any) => x.id === id)?.name ?? 'Procedure';
  // Sets: whole-pad sets and the clinic's section sets (medicines, advice, tests…) in one list
  const KIND_WHAT: Record<string, string> = { medicine: 'Medicines', advice: 'Advice', tests: 'Tests', finding: 'Findings', symptom: 'Symptoms', diagnosis: 'Diagnosis', procedure: 'Procedure' };
  const setList: { id: string; name: string; what: string; whole: boolean; raw: any; lines: string[] }[] = [
    ...(tpls.data ?? []).map((t: any) => ({ id: t.id, name: t.name, what: 'Whole pad', whole: true, raw: t, lines: [
      joinList(t.data?.assessment?.diagnosis) && `Diagnosis: ${joinList(t.data.assessment.diagnosis)}`,
      `Medicines: ${(t.prescription ?? []).map((i: any) => `${i.name}${i.frequency ? ` · ${i.frequency}` : ''}${i.durationDays ? ` · ${i.durationDays} d` : ''}`).join('; ') || '—'}`,
      t.data?.plan?.advice && `Advice: ${String(t.data.plan.advice).split('\n').filter(Boolean).join(' · ')}`,
      (t.recommendations ?? []).length > 0 && `Plan: ${(t.recommendations ?? []).map((r: any) => r.kind === 'followup' ? `review in ${r.intervalDays} d` : r.kind === 'investigation' ? r.notes : 'procedure').join(', ')}`,
    ].filter(Boolean) as string[] })),
    ...(sets.data ?? []).filter((t) => KIND_WHAT[t.kind] && !t.draft && t.active !== false).map((t) => { const pl = t.payload ?? {}; return { id: t.id, name: t.name, what: KIND_WHAT[t.kind], whole: false, raw: t,
      lines: [...(pl.items ?? []).map((i: any) => [i.name, i.frequency, i.durationDays ? `${i.durationDays} d` : null].filter(Boolean).join(' · ')), ...(pl.lines ?? []), ...(pl.chips ?? []), ...(pl.tests ?? []).map((x: any) => x.name), ...(t.kind === 'procedure' ? [procName(pl.procedureId)] : [])] }; }),
  ].filter((t) => !tplQ || t.name.toLowerCase().includes(tplQ.toLowerCase()));
  const pickedSet = setList.find((t) => t.id === tplSel?.id) ?? setList[0];
  const reviewIn = (
    <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Review in"><span className="mr-1 min-w-[72px] text-xs text-muted">Review in</span>
      {REVIEW_IN.map(([d, l]) => <button key={l} type="button" role="radio" aria-checked={(followup?.intervalDays ?? null) === d && (d !== null || !followup)} disabled={readOnly} className={(d === null ? !followup : followup?.intervalDays === d) ? 'pick-chip' : 'toggle-opt'} onClick={() => setFollowup(d)}>{(d === null ? !followup : followup?.intervalDays === d) && <Icon name="check" className="h-3 w-3" />}{l}</button>)}
      {followup && !REVIEW_IN.some(([d]) => d === followup.intervalDays) && <span className="flex items-center gap-1 text-xs">· <NumInput aria-label="Review in days" max={365} className="input !w-16 !py-1" value={followup.intervalDays ?? ''} disabled={readOnly} onChange={(ev) => setFollowup(Number(ev.target.value) || null)} /> days</span>}
      {followup && <input aria-label="Note for the follow-up" className="input !w-56 !py-1" maxLength={120} placeholder="Note for the follow-up" value={data.plan?.followupNote ?? ''} disabled={readOnly} onChange={(ev) => set('plan', 'followupNote', ev.target.value)} />}
    </div>);
  /** A finding ticked on a skin-map pin is also this visit's finding: it ticks the same chip in Morphology (or another exam list that has it).
   *  Unticked, it leaves the chip only when no other pin from this visit still has it. Matched by name or the same word stem ("Hypopigmented" → "Hypopigmentation"). */
  const onPinFinding = (f: string, on: boolean, others: { encounterId: string | null; finding: string | null }[]) => {
    const hit = examOptionFor(examFields, f); if (!hit) return; const { field: fl, opt } = hit;
    const cur: string[] = Array.isArray(data.exam?.[fl.key]) ? data.exam[fl.key] : [];
    if (on) set('exam', fl.key, fl.type === 'select' ? opt : uniq([...cur, opt]));
    else if (!others.some((o) => o.encounterId === id && pinFindings(o).includes(f))) set('exam', fl.key, fl.type === 'select' ? (data.exam?.[fl.key] === opt ? undefined : data.exam?.[fl.key]) : cur.filter((x) => x !== opt));
  };
  const cards: Record<string, ReactNode> = {
    vitals: <Card key="vitals" id="vitals" title="Vitals" meta="from check-in · tap a value to change it"><VitalsCard encounterId={id!} patientId={p.id} details={e.visit?.details ?? {}} heightCm={p.history?.heightCm} readOnly={readOnly} settings={cfg?.tenant?.settings} /></Card>,
    history: <Card key="history" id="history" title="Medical history"><HistoryChips patientId={p.id} history={p.history ?? {}} categories={cfg?.historyCategories ?? []} readOnly={readOnly} /></Card>,
    symptoms: <Card key="symptoms" id="symptoms" title="Symptoms" required={isDoctor && padOf('symptoms').required} invalid={bad('symptoms')}>
      <div data-invalid={!!err('complaint', 'chief_complaint')}>
        {syms.map((s, i) => <Row key={s.name + i} label={s.name} onRemove={readOnly ? null : () => setSyms(syms.filter((_, j) => j !== i))}>
          <b className="min-w-[160px] text-[13.5px]">{s.name}</b>
          <input aria-label={`${s.name}: since`} className="input !w-28 !py-1 text-[12.5px]" placeholder="Since" maxLength={30} value={s.since ?? ''} disabled={readOnly} onChange={(ev) => setSyms(syms.map((x, j) => (j === i ? { ...x, since: ev.target.value } : x)))} />
          <Segmented size="sm" disabled={readOnly} value={s.severity ?? ''} onChange={(sv) => setSyms(syms.map((x, j) => (j === i ? { ...x, severity: sv || undefined } : x)))} options={SEVERITIES.map((sv) => ({ value: sv, label: sv }))} />
          <input aria-label={`${s.name}: note`} className="input min-w-36 flex-1 !py-1 text-[12.5px]" placeholder="Note" maxLength={120} value={s.note ?? ''} disabled={readOnly} onChange={(ev) => setSyms(syms.map((x, j) => (j === i ? { ...x, note: ev.target.value } : x)))} />
        </Row>)}
        {!readOnly && <>
          <div className="mt-2 flex flex-wrap items-center gap-1"><span className="quick-label">Common</span>{(symField?.options ?? []).filter((o: string) => !syms.some((s) => norm(s.name) === norm(o))).slice(0, QUICK).map((o: string) => <button key={o} type="button" className="opt-add" onClick={() => addSyms([{ name: o }])}>{o}</button>)}</div>
          {<SearchLine placeholder="Start typing a symptom · “itching 2 weeks”" options={symField?.options ?? []} invalid={!!err('complaint', 'chief_complaint')} onAdd={(t) => smartAdd(t, 'symptom')} />}
        </>}
        {err('complaint', 'chief_complaint') && <div className="mt-1 text-xs text-rose">At least one symptom is required</div>}
        {otherFields('complaint', ['chief_complaint', 'duration']).map((f: Field) => <div key={f.key} className="mt-2" data-invalid={!!err('complaint', f.key)}><CompactField f={f} value={data.complaint?.[f.key]} onChange={(v) => set('complaint', f.key, v)} disabled={readOnly} invalid={!!err('complaint', f.key)} /></div>)}
      </div></Card>,
    diagnosis: <Card key="diagnosis" id="diagnosis" title="Diagnosis" required={isDoctor} invalid={bad('diagnosis')} meta={isDoctor ? undefined : 'the doctor decides; leave it if unsure'}>
      <div data-invalid={!!err('assessment', 'diagnosis')}>
        {dxs.map((d, i) => <Row key={d.name} label={d.name} onRemove={readOnly ? null : () => setDxs(dxs.filter((_, j) => j !== i))}>
          <b className="min-w-[160px] text-[13.5px]">{d.name}</b>
          <Segmented size="sm" disabled={readOnly} value={d.severity ?? ''} onChange={(sv) => setDxs(dxs.map((x, j) => (j === i ? { ...x, severity: sv || undefined } : x)))} options={SEVERITIES.map((sv) => ({ value: sv, label: sv }))} />
          <Segmented size="sm" disabled={readOnly} value={d.status ?? ''} onChange={(st) => setDxs(dxs.map((x, j) => (j === i ? { ...x, status: st || undefined } : x)))} options={DX_STATUS.map((st) => ({ value: st, label: st }))} />
        </Row>)}
        {!readOnly && <>
          <div className="mt-2 flex flex-wrap items-center gap-1"><span className="quick-label">Common</span>{(dxField?.options ?? DX_OPTIONS).filter((o: string) => !dxs.some((d) => d.name === o)).slice(0, QUICK).map((o: string) => <button key={o} type="button" className="opt-add" onClick={() => addDxs([{ name: o }])}>{o}</button>)}</div>
          {<SearchLine placeholder="Start typing a diagnosis" options={dxField?.options ?? DX_OPTIONS} invalid={!!err('assessment', 'diagnosis')} onAdd={(t) => smartAdd(t, 'diagnosis')} />}
        </>}
        {err('assessment', 'diagnosis') && <div className="mt-1 text-xs text-rose">Diagnosis is required</div>}
        {otherFields('assessment', []).map((f: Field) => <div key={f.key} className="mt-2"><CompactField f={f} value={data.assessment?.[f.key]} onChange={(v) => set('assessment', f.key, v)} disabled={readOnly} /></div>)}
        {applied && !readOnly && <div className="mt-2 rounded-lg bg-amber-soft px-3 py-2 text-[12.5px] text-amber anim-fade-in">Filled from <b>{applied}</b>.{allergyWarnings.length ? ` Check: ${allergyWarnings.map(([n]) => n).join(', ')} may clash with the ${p.allergies} allergy.` : ''} <button type="button" className="font-semibold underline" onClick={clearLoaded}>Undo “{applied}” set</button></div>}
      </div></Card>,
    exam: <Card key="exam" id="exam" title="Examination findings" required={isDoctor && padOf('exam').required} invalid={bad('exam')}>
      {/* a small map beside the lists; the full map opens on top (it is where pins are added) */}
      <div className="grid items-start gap-4 sm:grid-cols-[150px_minmax(0,1fr)]">
        <ExamMap patientId={p.id} encounterId={id} onOpen={() => setMapOpen(true)} />
        <div className="min-w-0 space-y-2.5"><PinLine patientId={p.id} onOpen={() => setMapOpen(true)} />{(formSections.find((s) => s.key === 'exam')?.fields ?? []).map((f: Field) => <div key={f.key} data-invalid={!!err('exam', f.key)}><CompactField f={f} value={data.exam?.[f.key]} onChange={(v) => set('exam', f.key, v)} disabled={readOnly} invalid={!!err('exam', f.key)} />{err('exam', f.key) && <div className="mt-1 text-xs text-rose">{f.label} is required</div>}</div>)}</div>
      </div></Card>,
    medicines: isDoctor ? <Card key="medicines" id="medicines" title="Medicines" required={padOf('medicines').required} invalid={bad('medicines')} meta={rx.filter((i) => i.name).length ? `${rx.filter((i) => i.name).length} on the Rx` : undefined}>
      {/* one table: a row per medicine, a column per detail, so the prescription reads across like the printed one */}
      {rx.filter((i) => i.name || !readOnly).length > 0 && <div className="rx-grid overflow-x-auto">
        <table className="w-full min-w-[760px] table-fixed border-collapse text-[13px]" onKeyDown={(ev) => { if (ev.key !== "Enter" || ev.defaultPrevented) return; /* Enter goes down to the same column, like a sheet */ const td = (ev.target as HTMLElement).closest("td"); const next = td?.parentElement?.nextElementSibling?.children[td.cellIndex]?.querySelector("input"); if (next) { ev.preventDefault(); (next as HTMLInputElement).focus(); } }}>
          <colgroup><col className="w-7" /><col /><col className="w-[84px]" /><col className="w-[112px]" /><col className="w-[116px]" /><col className="w-[64px]" /><col className="w-[64px]" /><col className="w-[17%]" /><col className="w-[96px]" /><col className="w-9" /></colgroup>
          <thead><tr className="text-left text-[11px] font-semibold uppercase tracking-wider text-muted">{['#', 'Medicine', 'Dose', 'Frequency', 'Timing', 'Days', 'Qty', 'Instructions', 'Stock', ''].map((h, n) => <th key={n} scope="col" className="px-2 py-2 font-semibold">{h}</th>)}</tr></thead>
          <tbody>{rx.map((i, k) => { const n = onHand(i); const hit = allergyHit(p.allergies, medText(i)); const off = readOnly || i._issued; const cell = 'p-0 align-middle'; return (
            <tr key={k} className={hit ? 'bg-rose-soft/40' : i.name ? 'pick-tr' : ''}>
              <td className={`${cell} px-1 text-center text-xs font-semibold text-muted`}>{k + 1}</td>
              <td className={cell}><Combo id={`rx-${i.name}`} label="Medicine" className={`cell-in font-semibold ${hit ? '!text-rose' : ''}`} value={i.name} disabled={off} options={meds.map((m: any) => m.name)} placeholder="Medicine"
                detail={(o) => { const m = meds.find((x: any) => x.name === o); const c = m && stock.data ? stock.data[m.id] ?? 0 : null; return c === null ? null : c ? `${c} in stock` : 'out of stock'; }}
                onChange={(v) => { const m = meds.find((x: any) => x.name === v); upd(k, { name: v, medicineId: m?.id ?? null, ...(m ? { dose: m.defaults?.dose, route: m.defaults?.route, frequency: m.defaults?.frequency, durationDays: m.defaults?.durationDays, instructions: m.defaults?.instructions } : {}) }); }} /></td>
              {/* empty cells read as examples, faded and in italics, never as values */}
              <td className={cell}><input aria-label="Dose" className={`cell-in ${PH}`} placeholder="e.g. 1 tab" value={i.dose ?? ''} disabled={off} onChange={(ev) => upd(k, { dose: ev.target.value })} /></td>
              <td className={cell}><Combo label="Frequency" className={`cell-in ${PH}`} placeholder="e.g. 1-0-1" value={i.frequency ?? ''} options={FREQ} disabled={off} onChange={(v) => upd(k, { frequency: v })} /></td>
              <td className={cell}><Combo label="Timing" className={`cell-in ${PH}`} placeholder="e.g. after food" value={i.timing ?? ''} options={TIMING} disabled={off} onChange={(v) => upd(k, { timing: v || null })} /></td>
              <td className={cell}><NumInput aria-label="Days" max={365} placeholder="e.g. 7" className={`cell-in ${PH}`} value={i.durationDays ?? ''} disabled={off} onChange={(ev) => upd(k, { durationDays: ev.target.value ? Number(ev.target.value) : undefined })} /></td>
              <td className={cell}><NumInput aria-label="Quantity" max={9999} placeholder="—" className={`cell-in ${PH}`} value={i.qty ?? ''} disabled={off} onChange={(ev) => upd(k, { qty: ev.target.value ? Number(ev.target.value) : null })} /></td>
              <td className={cell}><input aria-label="Instructions" className={`cell-in ${PH}`} placeholder="if any" value={i.instructions ?? ''} disabled={off} onChange={(ev) => upd(k, { instructions: ev.target.value })} /></td>
              <td className={`${cell} truncate px-2 text-[11.5px] font-semibold ${hit ? 'text-rose' : n === 0 ? 'text-amber' : 'text-muted'}`}>{hit ? `allergy: ${hit}` : n === null ? (i.name && !i.medicineId ? 'not in list' : '') : n === 0 ? 'out of stock' : `${n} in stock`}</td>
              <td className={`${cell} text-center`}>{!readOnly && !i._issued ? <button type="button" className="btn btn-ghost btn-icon !h-7 !w-7" aria-label={`Remove ${i.name || 'line'}`} onClick={() => setRx(rx.filter((_, j) => j !== k))}><Icon name="x" className="h-3.5 w-3.5" /></button> : i._issued ? <span className="text-[11px] text-muted" title="Issued at the counter; it stays as written">issued</span> : null}</td>
            </tr>); })}</tbody>
        </table>
      </div>}
      {!readOnly && <>
        {(frequent.data ?? []).filter((f: any) => !rx.some((r) => r.name === f.name)).length > 0 && <div className="mt-2 flex flex-wrap items-center gap-1"><span className="quick-label">Common</span>{(frequent.data ?? []).filter((f: any) => !rx.some((r) => r.name === f.name)).slice(0, QUICK).map((f: any) => <button key={f.name} type="button" className="opt-add" onClick={() => addRxByName(f.name)}>{f.name}</button>)}</div>}
        {<SearchLine placeholder='Start typing a medicine · “itra 100 1-0-1 7d after food”' options={meds.map((m: any) => m.name)} invalid={bad('medicines')} onAdd={(t) => smartAdd(t, 'medicine')} />}
      </>}
      {leaflets.length > 0 && <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted"><span>Sent with the Rx on WhatsApp:</span>{leaflets.map((m: any) => <Chip key={m.id} tone="sage">{m.name}: how to use</Chip>)}</div>}
    </Card> : null,
    advice: isDoctor ? <Card key="advice" id="advice" title="Advice" meta="standard lines also print in the patient's language">
      {adviceLines.map((a) => <Row key={a} label={a} onRemove={readOnly ? null : () => toggleAdvice(a)}><b className="text-[13.5px]">{a}</b></Row>)}
      {!readOnly && <div className="mt-2 flex flex-wrap items-center gap-1"><span className="quick-label">Common</span>{ADVICE.filter((a) => !adviceLines.includes(a)).slice(0, QUICK).map((a) => <button key={a} type="button" className="opt-add" onClick={() => toggleAdvice(a)}>{a}</button>)}</div>}
      {!readOnly && <SearchLine placeholder="Start typing advice" options={ADVICE} onAdd={(a) => !adviceLines.includes(a) && set('plan', 'advice', [...adviceLines, a].join('\n'))} />}
    </Card> : null,
    tests: isDoctor ? <Card key="tests" id="tests" title="Lab investigations">
      {tests.map((r) => <Row key={r.notes} label={r.notes ?? 'test'} onRemove={readOnly || r.status === 'done' ? null : () => setRecs(recs.filter((x) => x !== r))}>
        <b className="min-w-[160px] text-[13.5px]">{r.notes}</b>
        {r.status === 'done' && <Chip tone="sage">received</Chip>}
        {(() => { const d = r.id ? reportFor(myDocs, null, r.id) : null; return d ? <ReportLink doc={d} /> : null; })()}
      </Row>)}
      {!readOnly && <>
        <div className="mt-2 flex flex-wrap items-center gap-1"><span className="quick-label">Common</span>{TESTS.filter((x) => !tests.some((r) => r.notes?.toLowerCase() === x.toLowerCase())).slice(0, QUICK).map((x) => <button key={x} type="button" className="opt-add" onClick={() => addTest(x)}>{x}</button>)}</div>
        {<SearchLine placeholder="Start typing a lab test" options={labNames} onAdd={addTest} />}
      </>}
    </Card> : null,
    results: isDoctor ? <Card key="results" id="results" title="Lab results" meta="typed when reports arrive"><LabResultsCard patientId={p.id} encounterId={id!} recIds={recIds} params={cfg?.labParams ?? []} readOnly={readOnly} printOut={printOut} onPrintOut={(v) => set('labs', 'printOutOfRangeOnly', v)} docs={myDocs} /></Card> : null,
    followup: isDoctor ? <Card key="followup" id="followup" title="Follow-up">{reviewIn}</Card> : null,
    procedures: isDoctor ? <Card key="procedures" id="procedures" title="Procedures">
      <div>
        <div className="flex flex-wrap items-start gap-1.5">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {recs.map((r, k) => r.kind !== 'procedure' ? null : (
            <span key={k} className="pick !mt-0 text-[13px]">
              <select aria-label="Procedure" className="input !w-auto !py-1" value={r.procedureId ?? ''} disabled={readOnly} onChange={(ev) => { const pr = cfg.procedures.find((x: any) => x.id === ev.target.value); setRecs(recs.map((x, j) => (j === k ? { ...x, procedureId: ev.target.value, sittings: pr?.typicalSittings } : x))); }}>{cfg?.procedures.map((pr: any) => <option key={pr.id} value={pr.id}>{pr.name}</option>)}</select>
              <NumInput aria-label="Sittings" max={50} className="input !w-14 !py-1" value={r.sittings ?? ''} disabled={readOnly} onChange={(ev) => setRecs(recs.map((x, j) => (j === k ? { ...x, sittings: Number(ev.target.value) } : x)))} /><span className="text-xs text-muted">sittings</span>
              <input aria-label="Note for the coordinator" className="input !w-44 !py-1" placeholder="Note for the coordinator" value={r.notes ?? ''} disabled={readOnly} onChange={(ev) => setRecs(recs.map((x, j) => (j === k ? { ...x, notes: ev.target.value } : x)))} />
              {!readOnly && <button className="btn btn-ghost btn-icon !h-7 !w-7" aria-label={`Remove ${procName(r.procedureId)}`} onClick={() => setRecs(recs.filter((_, j) => j !== k))}><Icon name="x" className="h-3 w-3" /></button>}
            </span>))}
          {!readOnly && (cfg?.procedures ?? []).length > 0 && <button type="button" className="opt-add" onClick={() => setRecs([...recs, { kind: 'procedure', procedureId: cfg.procedures[0].id, sittings: cfg.procedures[0].typicalSittings }])}>Add a procedure</button>}
          </div>
        </div>
      </div></Card> : null,
    notes: isDoctor ? <Card key="notes" id="notes" title="Private notes" meta="never printed or sent"><textarea aria-label="Private notes" className="input min-h-14" maxLength={2000} placeholder="For you and the clinic only" value={data.notes?.private ?? ''} disabled={readOnly} onChange={(ev) => set('notes', 'private', ev.target.value)} /></Card> : null,
    referral: isDoctor ? <Card key="referral" id="referral" title="Refer to a doctor" meta="printed on the prescription">
      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[1fr_1fr_1.4fr]">
        <input aria-label="Refer to doctor or clinic" className="input !py-1.5" maxLength={120} placeholder="Doctor or clinic" value={data.referral?.to ?? ''} disabled={readOnly} onChange={(ev) => set('referral', 'to', ev.target.value)} />
        <input aria-label="Speciality" className="input !py-1.5" maxLength={60} placeholder="Speciality" value={data.referral?.speciality ?? ''} disabled={readOnly} onChange={(ev) => set('referral', 'speciality', ev.target.value)} />
        <input aria-label="Reason for referral" className="input !py-1.5" maxLength={200} placeholder="Reason" value={data.referral?.reason ?? ''} disabled={readOnly} onChange={(ev) => set('referral', 'reason', ev.target.value)} />
      </div></Card> : null,
    photos: <Card key="photos" id="photos" title={thenNow ? 'Then and now' : 'Photos'} meta={lastArea} actions={can(perms, 'document.write') && !readOnly && <Act onClick={() => setCapture(true)}>Take photo</Act>}>
      {thenNow ? <button className="grid w-full max-w-sm grid-cols-2 gap-1.5" onClick={() => setCompare(thenNow)} aria-label="Compare first and latest photo">{thenNow.map((x, k) => <span key={x.id} className="relative block aspect-square overflow-hidden rounded-lg bg-paper-2"><img src={`/api/documents/${x.id}/file`} alt={`${k ? 'Latest' : 'First'} ${x.area ?? ''}`} className="h-full w-full object-cover" /><span className="absolute bottom-1 left-1 rounded-md bg-black/55 px-1.5 text-[10px] font-semibold text-white">{fmtDate(x.takenAt)}</span></span>)}</button>
        : ph.length ? <div className="flex gap-1.5">{ph.slice(0, 6).map((x) => <div key={x.id} className="relative"><img src={`/api/documents/${x.id}/file`} alt={x.area ?? 'photo'} className="h-16 w-16 rounded-lg object-cover" />{can(perms, 'document.write') && <RemovePhoto photo={x} patientId={p.id} className="absolute -right-1.5 -top-1.5 !h-6 !w-6" />}</div>)}</div> : <div className="text-xs text-muted">No photos yet.</div>}
    </Card>,
  };
  const shown = pad.length ? pad.filter((s) => s.show).map((s) => s.key) : Object.keys(cards);
  // the doctor's photos live on their own tab; the junior takes the "before" pictures at intake, so intake keeps the card
  const order = isDoctor ? shown.filter((k) => k !== 'photos') : [...shown.filter((k) => k !== 'photos'), ...(can(perms, 'document.write') ? ['photos'] : [])];
  const pinCount = (pinsQ.data ?? []).filter((x) => !x.resolvedAt).length;
  const B = 'inline-flex h-9 items-center gap-1.5 rounded-[9px] px-3 text-[13px] font-semibold text-paper transition-colors bg-paper/10 hover:bg-paper/20 disabled:opacity-50';
  const BP = 'inline-flex h-9 items-center gap-1.5 rounded-[9px] px-4 text-[13px] font-semibold text-ink transition-colors bg-paper hover:bg-paper-2 disabled:opacity-50';
  const custom = (x: any) => (
    <Card key={x.key} id={x.key} title={x.title} required={x.fields.some((f: Field) => f.required)} invalid={bad(x.key)}>
      <div className="space-y-2">{x.fields.map((f: Field) => <div key={f.key} data-invalid={!!err(x.key, f.key)}><CompactField f={f} value={data[x.key]?.[f.key]} onChange={(v) => set(x.key, f.key, v)} disabled={readOnly} invalid={!!err(x.key, f.key)} />{err(x.key, f.key) && <div className="mt-1 text-xs text-rose">{f.label} is required</div>}</div>)}</div>
    </Card>);

  const reviewCard = isReview && isDoctor ? <Card id="review" title={`Since ${fmtDate(lastDone.createdAt)}`} meta={joinList(lastDone.data?.assessment?.diagnosis) || 'last consultation'}>
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3"><span className="min-w-[72px] text-xs text-muted">How is it?</span>
              <Segmented disabled={readOnly} value={data.review?.response ?? ''} onChange={(r) => set('review', 'response', r || undefined)} options={RESPONSES.map((r) => ({ value: r, label: r }))} /></div>
            {(() => { const se: string[] = data.review?.sideEffects ?? []; const real = se.filter((x) => x !== 'None'); return (
              <div className="flex flex-wrap items-center gap-2"><span className="min-w-[72px] text-xs text-muted">Side effects</span><span className={`text-[13.5px] ${real.length ? 'font-medium text-amber' : ''}`}>{real.length ? real.join(', ') : 'none reported'}</span>{!readOnly && <button type="button" className="opt-add" onClick={() => setSeOpen(!seOpen)}>{seOpen ? 'Done' : 'Change'}</button>}
                {seOpen && !readOnly && <div className="flex basis-full flex-wrap gap-1 anim-fade-in">{SIDE_EFFECTS.filter((x) => x !== 'None').map((x) => { const on = se.includes(x); return <button key={x} type="button" className={`!min-h-7 !py-0.5 ${on ? 'toggle-opt on' : 'opt'}`} onClick={() => set('review', 'sideEffects', on ? se.filter((y) => y !== x) : [...se.filter((y) => y !== 'None'), x])}>{x}</button>; })}</div>}
              </div>); })()}
            {lastRx.length > 0 && <div>
              <div className="flex items-center gap-2"><span className="text-xs text-muted">Last prescription · continue, change or stop each line</span>{!readOnly && <button id="pad-continue-all" className="btn btn-ghost btn-sm ml-auto" onClick={() => setRx((cur) => [...cur.filter((r) => r.name && !lastRx.some((l) => l.name === r.name)), ...lastRx.map((l) => cur.find((r) => r.name === l.name) ?? withQty({ ...l }))])}>Continue all</button>}</div>
              {lastRx.map((l, k) => {
                const cur = rx.find((r) => r.name === l.name); const st = !cur ? (rx.length ? 'stop' : '') : sameLine(cur, l) ? 'continue' : 'change';
                const raw = lastRaw[k];
                return (
                  <Row plain key={l.name + k} label={l.name}>
                    <span className="min-w-0 flex-1"><b className="text-[13.5px]">{l.name}</b><span className="block text-[12.5px] text-muted">{[l.dose, l.frequency, l.durationDays ? `${l.durationDays} days` : null, l.instructions].filter(Boolean).join(' · ')}{raw && raw.medicineId && !raw.issuedQty ? ' · patient did not buy' : ''}{st === 'change' && cur ? ` · now ${[cur.dose, cur.frequency, cur.durationDays ? `${cur.durationDays}d` : null].filter(Boolean).join(' · ')}` : ''}</span></span>
                    {!readOnly && <Segmented size="sm" value={st} onChange={(v) => { if (v === 'continue') setRx((r) => cur ? r.map((x) => (x.name === l.name ? withQty({ ...l }) : x)) : [...r.filter((x) => x.name), withQty({ ...l })]); else if (v === 'change') { if (!cur) setRx((r) => [...r.filter((x) => x.name), withQty({ ...l })]); goTo('medicines'); setTimeout(() => document.getElementById(`rx-${l.name}`)?.focus(), 300); } else setRx((r) => r.filter((x) => x.name !== l.name)); }} options={[{ value: 'continue', label: 'Continue' }, { value: 'change', label: 'Change' }, { value: 'stop', label: 'Stop' }]} />}
                  </Row>); })}
            </div>}
          </div>
        </Card> : null;
  const examFields: Field[] = formSections.find((x) => x.key === 'exam')?.fields ?? [];
  const notSaved = <span className="rounded-[7px] bg-amber-soft px-2 py-0.5 text-xs font-semibold text-amber" role="alert">Not saved — kept on this computer. It saves when the internet is back.</span>;
  const age = ageText(p);
  const patientLine = [age ? `${age} ${p.sex ?? ''}` : null, p.patientNo, p.phone, visitNo === 1 ? 'first visit' : `visit ${visitNo}`, isReview ? `review of ${joinList(lastDone.data?.assessment?.diagnosis) || 'last visit'}` : null, arrivalText ? `screened: ${arrivalText}` : null].filter(Boolean).join(' · ');

  return (
    <div className="space-y-3 pb-4">
      {/* who: the patient in the app's top bar (more room for the pad), with From last visit, Sets and the pad's settings; past visits, photos and reports as tabs under it */}
      {(() => { const who = (
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <Avatar name={p.fullName} size="h-9 w-9 text-xs" />
          <div className="min-w-0"><div className="flex items-center gap-1.5 truncate text-[16px] font-semibold leading-tight">{p.fullName}<FlagChips flags={p.flags} /></div>
            <div className="truncate text-xs text-muted" title={patientLine}>{patientLine}</div></div>
          {p.allergies && <span className="chip chip-rose shrink-0 !py-1">Allergy: {p.allergies}</span>}
          {pregnant && <span className="chip chip-rose shrink-0 !py-1">{pregnant}</span>}
          <span className="ml-auto flex shrink-0 items-center gap-2 text-xs text-muted">{me.role === 'assistant' && <Chip tone="sky">Intake · doctor reviews next</Chip>}{e.status === 'completed' && <Chip tone="sage">completed</Chip>}
            {isDoctor && !readOnly && <Segmented<'stacked' | 'focused' | 'review' | 'simple'> size="sm" value="simple" onChange={(v) => { if (v === 'simple') return; void (async () => { if (dirty.current) { try { await save.mutateAsync({ complete: false }); } catch { return; } } await qc.invalidateQueries({ queryKey: ['encounter', id] }); onLayout(v); })(); }} options={[{ value: 'stacked', label: 'Stacked' }, { value: 'focused', label: 'Focused' }, ...(isReview ? [{ value: 'review' as const, label: 'Review' }] : []), { value: 'simple', label: 'Simple' }]} />}
            {isDoctor && !readOnly && <><LoadPrevious id="pad-loadprev" previous={previous} onLoad={loadPrevious} />
              <button ref={tplBtn} type="button" className="btn btn-sm" aria-expanded={tplOpen} onClick={() => setTplOpen(!tplOpen)}><LayoutTemplate className="h-3.5 w-3.5" aria-hidden />Sets</button>
              <Floating anchor={tplBtn} open={tplOpen} onClose={() => setTplOpen(false)} width={560}>
                <div className="grid grid-cols-[220px_minmax(0,1fr)] gap-2 p-1.5">
                  <div><input autoFocus aria-label="Search sets" className="input mb-1.5 !py-1.5" placeholder="Search sets" value={tplQ} onChange={(ev) => setTplQ(ev.target.value)} />
                    <div className="max-h-72 space-y-0.5 overflow-y-auto">{setList.length === 0 ? <div className="px-2 py-2 text-xs text-muted">{tplQ ? 'No set by that name.' : 'No sets yet. Fill the pad, then Save this pad as a set.'}</div> : setList.map((t) => <button key={t.id} type="button" className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] ${pickedSet?.id === t.id ? 'bg-paper-2 font-semibold' : 'hover:bg-paper-2'}`} onClick={() => setTplSel(t)}><span className="min-w-0 flex-1 truncate">{t.name}</span><span className="shrink-0 text-[11px] text-muted">{t.what}</span></button>)}</div></div>
                  {pickedSet ? <div className="rounded-md border border-line bg-surface-2 p-2.5 text-[12.5px] leading-relaxed">
                    <div className="mb-1 flex items-center gap-2"><b className="text-[13px]">{pickedSet.name}</b><button type="button" className="btn btn-sm btn-primary ml-auto" onClick={() => { if (pickedSet.whole) applyTpl(pickedSet.raw); else { undo.current = { data, rx, recs }; setApplied(pickedSet.name); setSetNote(applySet(pickedSet.raw)); setTplOpen(false); setTplSel(null); } }}>Use</button></div>
                    {pickedSet.lines.map((l, k) => <div key={k}>{l}</div>)}
                    <div className="mt-1 text-[11.5px] text-muted">{pickedSet.whole ? 'Replaces the pad; your symptoms and review answers stay.' : 'Adds to the pad; nothing is added twice.'}</div></div>
                    : <div className="rounded-md border border-dashed border-line p-2.5 text-[12.5px] text-muted">A set fills the pad in one tap: a whole consultation, or just medicines, advice or tests.</div>}
                </div>
                <div className="flex items-center gap-1 border-t border-line p-1.5">
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setTplOpen(false); void askTpl(); }}><Icon name="plus" className="h-3.5 w-3.5" />Save this pad as a set</button>
                  {applied && <button type="button" className="btn btn-ghost btn-sm ml-auto" onClick={() => { clearLoaded(); setTplOpen(false); }}>Undo “{applied}” set</button>}
                </div>
              </Floating></>}
            {isDoctor && can(perms, 'config.write') && <button type="button" className="btn btn-sm btn-icon" aria-label="Configure pad: sections, required, printing" title="Configure pad: sections, required, printing" onClick={() => nav('/settings?tab=pad')}><Icon name="gear" className="h-3.5 w-3.5" /></button>}
          </span>
        </div>);
        return slot ? createPortal(who, slot) : <div className="card !px-5 !py-3 anim-fade-up">{who}</div>; })()}
      <CarefulBanner flags={p.flags} />
      {/* tabs (an underline, not pills): the prescription, and the patient's past visits, photos and reports beside it */}
      {isDoctor && <div className="flex flex-wrap items-end gap-x-4 gap-y-1 px-1">
        <Tabs<'pad' | 'visits' | 'photos' | 'docs'> className="min-w-0 flex-1" value={tab} onChange={setTab} options={[{ value: 'pad', label: 'Prescription' }, { value: 'visits', label: 'Past visits', count: previous.length || undefined }, { value: 'photos', label: 'Photos', count: ph.length || undefined }, { value: 'docs', label: 'Reports', count: myDocs.length || undefined }]} />
        {pinCount > 0 && <span className="pb-3 text-xs text-muted">Skin map · {pinCount} active {pinCount === 1 ? 'site' : 'sites'} · in Examination</span>}
      </div>}

      {tab === 'pad' && <>
        {isDoctor && !readOnly && <div className="anim-fade-up">
          <div className="relative"><Icon name="search" className="absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-clay" />
            <input aria-label="Add medicine, test, symptom" className="typebar" placeholder="Add medicine, test, symptom…" value={line} onChange={(ev) => { setLine(ev.target.value); setPendingLine(null); }} onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.preventDefault(); smartAdd(line); } }} />
            <span className="kbd absolute right-4 top-1/2 -translate-y-1/2">Enter to add</span></div>
          {pendingLine && <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs anim-fade-in"><span className="text-muted">“{pendingLine}” is not in the lists. Add as</span>{([['symptom', 'Symptom'], ['diagnosis', 'Diagnosis'], ['medicine', 'Medicine'], ['test', 'Test'], ['advice', 'Advice']] as const).map(([k, l]) => <button key={k} type="button" className="toggle-opt !min-h-7 !py-0.5" onClick={() => smartAdd(pendingLine, k)}>{l}</button>)}<button type="button" className="btn btn-ghost !min-h-7 !px-2 text-xs" onClick={() => setPendingLine(null)}>Cancel</button></div>}
        </div>}
        {held && <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[12px] bg-amber-soft px-4 py-2.5 text-[12.5px] text-amber anim-fade-in" role="status"><b>Held for reports.</b><span>Prescription issued {fmtDate(e.completedAt)}. {testsIn} of {testRecs.length} reports in{testsOpen ? `; pending: ${testRecs.filter((r: any) => r.status !== 'done').map((r: any) => `${r.notes}${r.expectedOn ? ` (expected ${fmtDate(r.expectedOn)})` : ''}`).join(', ')}` : ''}.</span>{isDoctor && <span className="text-muted">Add or change what the results call for, then Complete. Issued medicines stay as written.</span>}</div>}
        {setNote && !readOnly && <div className="rounded-[12px] bg-amber-soft px-4 py-2.5 text-[12.5px] text-amber anim-fade-in" role="status">{setNote}</div>}
        {/* allergy, same medicine twice, pregnancy and interactions: above the pad, not only beside the medicines table */}
        {warnings.length > 0 && !readOnly && <div className="rounded-[12px] bg-rose-soft px-4 py-2.5 text-[12.5px] text-rose anim-fade-in" role="alert"><b>Check the prescription.</b> {warnings.join(' ')} {warnings.some((w) => !allOverrides.some((o) => o.warnings.includes(w))) ? 'Finish asks for a reason.' : 'Reason given.'}</div>}
        {amended && <div className="rounded-[12px] bg-amber-soft px-4 py-2.5 text-[12.5px] text-amber anim-fade-in" role="status"><b>Amending the signed prescription:</b> {e.amendments[e.amendments.length - 1].reason}. Finish signs it again; the print says Amended.</div>}

        {!isDoctor && (!readOnly || Object.keys(answers).length > 0 || Object.keys(hist).length > 0) && <div className="card !p-0"><ScreenBlock lists={lists} answers={answers} onAnswers={(a) => set('screen', 'answers', a)} history={hist} onHistory={(h) => set('screen', 'history', h)} disabled={readOnly} open /></div>}
        {!isDoctor && !padOf('history').show && cards.history}

        {reviewCard}
        {order.map((k) => cards[k] ?? null)}
        {customSections.map(custom)}
      </>}

      {tab === 'visits' && <div className="card anim-fade-up">
        {previous.length === 0 && <div className="text-[13px] text-muted">First visit.</div>}
        {previous.slice(0, 12).map((x: any) => (
          <div key={x.id} className="flex items-center gap-3 border-t border-line/70 py-2.5 text-[13.5px] first:border-t-0 first:pt-0">
            <button type="button" className="w-16 shrink-0 text-left text-xs font-semibold text-muted hover:text-ink hover:underline" title={x.doctor?.name ?? ''} onClick={() => setViewing(x.id)}>{fmtDate(x.createdAt)}</button>
            <span className="min-w-0 flex-1 truncate">{x.data?.review?.response ? `${x.data.review.response} · ` : ''}{joinList(x.data?.assessment?.diagnosis) || joinList(x.data?.complaint?.chief_complaint) || 'Consultation'}{x.prescription?.length > 0 && <span className="text-muted"> · {x.prescription.map((i: any) => i.name).join(', ')}</span>}</span>
            <button type="button" className="btn btn-ghost btn-sm shrink-0" onClick={() => setViewing(x.id)}>Open</button>
          </div>))}
        {previous.length > 12 && <div className="pt-2 text-xs text-muted">Earlier · {previous.length - 12} more in the patient's file</div>}
        <div className="mt-3 border-t border-line pt-3"><ScreeningCard complaintText={arrivalText} lists={lists} answers={answers} history={hist} /></div>
      </div>}
      {tab === 'docs' && <div className="card anim-fade-up">
        <div className="mb-2 flex items-center gap-2"><span className="text-xs text-muted">Lab reports and letters</span><span className="ml-auto" />{can(perms, 'document.write') && <UploadButton patientId={p.id} encounterId={id} label="Upload" onDone={() => qc.invalidateQueries({ queryKey: ['documents', p.id] })} />}</div>
        {myDocs.length === 0 ? <div className="text-xs text-muted">No reports yet.</div> : <DocList docs={myDocs.slice(0, 12)} />}
      </div>}
      {tab === 'photos' && <div className="card anim-fade-up">
        {thenNow && <button className="mb-2 grid w-full max-w-md grid-cols-2 gap-1.5" onClick={() => setCompare(thenNow)} aria-label="Compare first and latest photo">{thenNow.map((x, k) => <span key={x.id} className="relative block aspect-square overflow-hidden rounded-lg bg-paper-2"><img src={`/api/documents/${x.id}/file`} alt={`${k ? 'Latest' : 'First'} ${x.area ?? ''}`} className="h-full w-full object-cover" /><span className="absolute bottom-1 left-1 rounded-md bg-black/55 px-1.5 text-[10px] font-semibold text-white">{fmtDate(x.takenAt)}</span></span>)}</button>}
        {ph.length > 0 && <div className="mb-2 grid grid-cols-4 gap-1.5 sm:grid-cols-6">{ph.slice(0, 12).map((x) => <div key={x.id} className="relative"><img src={`/api/documents/${x.id}/file`} alt={x.area ?? 'photo'} className="aspect-square w-full rounded-lg object-cover" />{can(perms, 'document.write') && <RemovePhoto photo={x} patientId={p.id} className="absolute right-1.5 top-1.5" />}</div>)}</div>}
        {ph.length === 0 && <div className="mb-2 text-xs text-muted">No photos yet.</div>}
        {can(perms, 'document.write') && !readOnly && <button className="btn btn-sm" onClick={() => setCapture(true)}><Icon name="spark" className="h-3.5 w-3.5" />Take photo</button>}
      </div>}

      {/* the action bar: one dark strip at the foot of the screen */}
      <div className="sticky bottom-3 z-20 flex flex-wrap items-center gap-2 rounded-[14px] bg-ink px-3 py-2 text-paper shadow-lg anim-fade-up">
        {!readOnly && isDoctor && <button type="button" className={B} onClick={() => clearSection('the whole pad', () => { setSyms([]); setDxs([]); setData((d) => ({ ...d, exam: {}, plan: {}, notes: {}, referral: {} })); setRx(rx.filter((i) => i._issued)); setRecs(recs.filter((r) => r.kind === 'investigation' && r.status === 'done')); })}>Clear</button>}
        {missingList.length > 0 ? <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs" role="alert"><span className="font-semibold text-paper/80">Cannot finish yet · missing:</span>
            {missingList.map((x) => <button key={x.path} type="button" className="rounded-[7px] bg-rose px-2 py-0.5 font-semibold text-white hover:bg-rose/80" onClick={() => goTo(secOf(x.path))}>{x.message.replace(/ is required$/, '')}</button>)}</div>
          : saveFailed && !readOnly && !save.isPending ? notSaved : <span className="text-xs text-paper/60">{save.isPending ? 'Saving…' : savedAt ? `Saved ${savedAt}` : readOnly ? '' : 'Saves every 15 s'}</span>}
        <span className="ml-auto" />
        {!readOnly && !isDoctor && <button type="button" className={BP} disabled={save.isPending} onClick={() => save.mutate({ complete: false, back: true })}>Save intake &amp; return to queue</button>}
        {!readOnly && isDoctor && <>
          <button type="button" className={B} disabled={save.isPending} onClick={() => save.mutate({ complete: false })}>Save</button>
          <button type="button" className={B} onClick={() => { void preview(); }}>Preview</button>
          {held && testsOpen && <button type="button" className={B} disabled={save.isPending} onClick={() => save.mutate({ complete: false, back: true })}>Keep open for the rest</button>}
          <button type="button" className={BP} disabled={save.isPending} onClick={finish}>{held ? 'Complete' : willHold ? 'Finish · hold for reports' : amended ? 'Finish amendment' : 'Finish prescription'}<Icon name="chevR" className="h-4 w-4" /></button>
        </>}
        {readOnly && <>
          {isDoctor && e.status === 'completed' && <button type="button" className={B} onClick={() => { void amend(); }}>Amend</button>}
          <button type="button" className={BP} onClick={() => openPrint({ title: 'Prescription', rx: id })}><Icon name="print" className="h-4 w-4" />Print Rx</button>
        </>}
      </div>
      {/* Finish: the exact paper the patient gets, and every safety check the doctor overrode, before signing */}
      {signing && <Modal title={amended ? 'Sign the amended prescription' : 'Sign the prescription'} subtitle={p.fullName} width="max-w-2xl" onClose={() => setSigning(false)}>
        {overrides.length > 0 && <div className="mb-3 rounded-[12px] bg-rose-soft px-4 py-2.5 text-[12.5px] text-rose" role="alert"><b>Prescribed despite these checks:</b>{overrides.map((o, k) => <div key={k} className="mt-1">{o.warnings.join(' ')} <span className="text-ink">Reason: {o.reason}</span></div>)}</div>}
        <div className="overflow-auto rounded-xl border border-line bg-paper p-3" style={{ maxHeight: 'min(60vh, 700px)' }}><div className="mx-auto w-fit shadow-md"><PrintRx id={id} embed /></div></div>
        <div className="mt-2 text-xs text-muted">This is the paper as it prints. Signing removes the Draft mark{willHold ? '; the visit stays open for the test reports' : ''}.</div>
        <div className="modal-foot"><button type="button" className="btn btn-ghost" onClick={() => setSigning(false)}>Back to the pad</button>
          <button type="button" className="btn" disabled={save.isPending} onClick={() => save.mutate({ complete: true, via: 'whatsapp' })}>Sign &amp; WhatsApp</button>
          <button type="button" className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate({ complete: true, via: 'print' })}><Icon name="print" className="h-4 w-4" />Sign &amp; print</button></div>
      </Modal>}
      {mapOpen && <Modal title="Skin map" subtitle={p.fullName} width="max-w-4xl" onClose={() => setMapOpen(false)}><SkinMapPanel patientId={p.id} patientName={p.fullName} encounterId={id} readOnly={readOnly} defaultDx={dxs[0]?.name} onAreaAdded={(a) => set('complaint', 'site', uniq([...((data.complaint?.site ?? []) as string[]), a]))} onFinding={onPinFinding} /></Modal>}
      {viewing && <EncounterModal id={viewing} onClose={() => setViewing(null)} />}
      {capture && <PhotoCapture patient={{ id: p.id, fullName: p.fullName }} onClose={() => setCapture(false)} />}
      {compare && <PhotoCompare name={p.fullName} a={compare[0]} b={compare[1]} onClose={() => setCompare(null)} />}
    </div>
  );
}

function CompactField({ f, value, onChange, disabled, invalid }: { f: Field; value: any; onChange: (v: any) => void; disabled: boolean; invalid?: boolean }) {
  const [note, setNote] = useState(false); const [moreOpen, setMore] = useState(false); const moreBtn = useRef<HTMLButtonElement>(null);
  if (f.type === 'tags') {
    const v = asList(value);
    const quick = (f.options ?? []).filter((o) => !v.includes(o)).slice(0, 10);
    return <div className="flex flex-wrap items-center gap-1.5"><span className="mr-0.5 text-xs text-muted">{f.label}</span>
      {v.map((t) => <span key={t} className="pick-chip"><Icon name="check" className="h-3 w-3" />{t}{!disabled && <button type="button" aria-label={`Remove ${t}`} className="ml-1" onClick={() => onChange(v.filter((x) => x !== t))}><Icon name="x" className="inline h-3 w-3" /></button>}</span>)}
      {!disabled && quick.map((o) => <button key={o} type="button" className="opt-add" onClick={() => onChange([...v, o])}>{o}</button>)}
      {!disabled && <SearchLine placeholder={`Add ${f.label.toLowerCase()}`} options={f.options ?? []} invalid={invalid} onAdd={(t: string) => !v.includes(t) && onChange([...v, t])} />}
    </div>;
  }
  if (f.type === 'multiselect' || f.type === 'select') {
    const multi = f.type === 'multiselect'; const v: string[] = multi ? (value ?? []) : value ? [value] : [];
    const rest = f.options!.filter((o) => !v.includes(o)); const shown = [...f.options!.filter((o) => v.includes(o)), ...rest.slice(0, 5)]; const more = rest.slice(5);
    const chip = (o: string) => <button type="button" key={o} disabled={disabled} aria-pressed={v.includes(o)} className={v.includes(o) ? 'pick-chip' : 'opt-add'} onClick={() => { onChange(multi ? (v.includes(o) ? v.filter((x) => x !== o) : [...v, o]) : value === o ? undefined : o); setMore(false); }}>{v.includes(o) && <Icon name="check" className="h-3 w-3" />}{o}</button>;
    return <div className="flex flex-wrap items-center gap-1.5"><span className="mr-0.5 min-w-[92px] text-xs text-muted">{f.label}</span>{shown.map(chip)}
      {!disabled && more.length > 0 && <><button ref={moreBtn} type="button" className="btn btn-ghost !min-h-7 gap-0.5 !px-2 text-[12.5px]" aria-expanded={moreOpen} onClick={() => setMore(!moreOpen)}>More ({more.length})<Icon name="chevR" className={`h-3.5 w-3.5 ${moreOpen ? "-rotate-90" : "rotate-90"}`} /></button>
        <Floating anchor={moreBtn} open={moreOpen} onClose={() => setMore(false)} width={300} align="left"><div className="flex flex-wrap gap-1.5 p-2">{more.map(chip)}</div></Floating></>}</div>;
  }
  if (f.type === 'textarea') {
    if (!value && !note) return disabled ? null : <button type="button" className="text-xs font-semibold text-muted underline" onClick={() => setNote(true)}>+ {f.label.toLowerCase()}</button>;
    return <textarea aria-label={f.label} autoFocus={note && !value} className={`input min-h-14 ${invalid ? '!border-rose' : ''}`} placeholder={f.placeholder ?? f.label} value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
  }
  const cls = `input ${invalid ? '!border-rose' : ''}`;
  return <div className="flex items-center gap-2"><span className="w-20 shrink-0 text-xs text-muted">{f.label}{f.unit ? ` (${f.unit})` : ''}</span><div className="min-w-0 flex-1 sm:max-w-xs">
    {f.type === 'number' ? <NumInput decimal max={100000} className={cls} value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} />
      : f.type === 'date' ? <input type="date" className={cls} value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
      : <input className={cls} value={value ?? ''} placeholder={f.placeholder} disabled={disabled} onChange={(e) => onChange(e.target.value)} />}</div></div>;
}
