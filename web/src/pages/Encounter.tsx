import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useNavigate, useParams, useOutletContext, useSearchParams } from 'react-router';
import { get, patch, post, qc, ApiError, errText } from '../api';
import { can } from '../App';
import { Avatar, Chip, Floating, Icon, Segmented, Skeleton, fmtDate, toast, NumInput, ask } from '../ui';
import { openPrint } from '../printPreview';
import { EncounterModal, DocList, UploadButton, asList, joinList } from '../encounterDetail';
import { usePhotos, PhotoCapture, PhotoCompare } from '../photos';
import { parseRxLine, qtyFor } from '../rxLine';
import { FlagChips, CarefulBanner } from '../flags';
import { useTemplates, suggests, norm, isSlow, uniq, type Tmpl, type TmplKind } from '../templates';
import { ScreenBlock, ScreeningCard, checklists, complaintTexts, type Answers, type History } from '../screening';
import { HistoryChips } from '../historyChips';
import { VitalsCard } from '../vitals';
import { LabResultsCard } from '../labs';
import { SkinMapPanel, usePins } from '../skinmap';

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
// ponytail: a small word list for drug-class allergies; a proper allergy/interaction database is the upgrade path.
const ALLERGY_CLASSES: Record<string, string[]> = { sulfa: ['sulfa', 'sulpha', 'cotrimoxazole', 'dapsone', 'sulfasalazine'], penicillin: ['penicillin', 'amoxi', 'ampi', 'cloxa'], nsaid: ['ibuprofen', 'diclofenac', 'aceclofenac', 'aspirin', 'naproxen'] };
const allergyHit = (allergies: string | null | undefined, med: string) => {
  if (!allergies) return null; const m = med.toLowerCase();
  for (const word of allergies.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 4)) {
    const cls = Object.entries(ALLERGY_CLASSES).find(([k, v]) => word.startsWith(k) || v.some((x) => word.startsWith(x)));
    if ((cls ? cls[1] : [word]).some((x) => m.includes(x))) return word;
  }
  return null;
};
const sameLine = (a: RxItem, b: RxItem) => a.name === b.name && (a.dose ?? '') === (b.dose ?? '') && (a.frequency ?? '') === (b.frequency ?? '') && (a.durationDays ?? null) === (b.durationDays ?? null) && (a.instructions ?? '') === (b.instructions ?? '');
const strip = ({ id, encounterId, tenantId, sortOrder, dispensed, issuedQty, notIssuedReason, createdAt, _qtyTouched, _issued, ...i }: any): RxItem => i;
/** The pad's own lines keep their id so a held-open consultation updates them instead of re-issuing; issued lines are locked. */
const own = (i: any): RxItem => ({ ...strip(i), id: i.id, _issued: !!(i.dispensed || i.issuedQty > 0) });
const asSym = (v: any): Sym[] => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? { name: x } : x)) : v ? [{ name: String(v) }] : []);
const asDx = (v: any): Dx[] => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? { name: x } : x)) : v ? [{ name: String(v) }] : []);
const isReviewVisit = (v: any, cfg: any) => { const code = v?.category; if (!code) return false; if (['REN', 'FREE'].includes(code)) return true; const cat = (cfg?.feeCategories ?? []).find((c: any) => c.code === code); return !!cat && (cat.amountPaise === 0 || /review|renew|follow/i.test(cat.name ?? '')); };
const withQty = (i: RxItem): RxItem => (i._qtyTouched || i.qty ? i : { ...i, qty: qtyFor(i) ?? undefined });
const ICON: Record<string, [string, string]> = { vitals: ['♡', '#5B8DB8'], symptoms: ['S', '#C53B14'], diagnosis: ['Dx', '#8A2E10'], exam: ['Ex', '#6F8F78'], medicines: ['℞', '#15181B'], advice: ['A', '#B98B6E'], tests: ['T', '#5B8DB8'], results: ['R', '#B8860B'], next: ['→', '#6F8F78'], notes: ['N', '#8B929C'], referral: ['Rf', '#5B8DB8'], history: ['H', '#8A2E10'], photos: ['P', '#6F8F78'] };

/** One section card of the pad: a header with the same plain-word actions everywhere, the section inside. */
/** One section of the pad as its own card: icon tile, title, the header actions on the right, rows inside, the search line last. */
function Card({ id, title, meta, actions, children, required, invalid }: { id: string; title: string; meta?: ReactNode; actions?: ReactNode; children: ReactNode; required?: boolean; invalid?: boolean }) {
  const [ch, color] = ICON[id] ?? ['•', '#8B929C'];
  return (
    <section id={`sec-${id}`} className={`card !p-0 anim-fade-up ${invalid ? 'outline-2 outline-rose/70' : ''}`} aria-invalid={invalid || undefined}>
      <div className="flex flex-wrap items-center gap-2 px-4 pb-1.5 pt-3">
        <span className="grid h-[22px] w-[22px] place-items-center rounded-[6px] text-[11px] font-bold text-white" style={{ background: color }} aria-hidden>{ch}</span>
        <span className="text-[14px] font-semibold">{title}{required && <span className="text-rose" title="Required to finish"> *</span>}</span>
        {meta && <span className="text-xs text-muted">{meta}</span>}
        {actions && <span className="ml-auto flex flex-wrap items-center gap-0.5">{actions}</span>}
      </div>
      <div className="px-4 pb-4">{children}</div>
    </section>
  );
}
const Act = ({ children, onClick, disabled, aria }: { children: ReactNode; onClick: () => void; disabled?: boolean; aria?: string }) => <button type="button" className="btn btn-ghost !min-h-7 !px-2 text-[12px] text-muted hover:text-ink" disabled={disabled} aria-label={aria} onClick={onClick}>{children}</button>;

/** T·Sx, T·Dx …: the section's templates in one place, as in Eka. Load one, save what is on the card now, or clear the card. */
function SectionTemplates({ kind, sub, what, sets, onPick, onSave, onClear }: { kind: TmplKind; sub: string; what: string; sets: Tmpl[]; onPick: (t: Tmpl) => void; onSave: () => void; onClear: (() => void) | null }) {
  const [open, setOpen] = useState(false); const [q, setQ] = useState(''); const btn = useRef<HTMLButtonElement>(null);
  const mine = sets.filter((t) => t.kind === kind); const list = mine.filter((t) => !q || t.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <button ref={btn} type="button" className="btn btn-ghost !min-h-7 !px-2 text-[12.5px] text-muted hover:text-ink" aria-label={`Templates for ${what}`} title={`Templates for ${what}`} aria-expanded={open} onClick={() => setOpen(!open)}><span className="font-bold">T</span><sub className="-ml-0.5 text-[10px] font-semibold">{sub}</sub></button>
      <Floating anchor={btn} open={open} onClose={() => setOpen(false)} width={320}>
        <div className="p-1.5">
          <div className="px-2 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wider text-muted">{what} templates</div>
          {mine.length > 6 && <input autoFocus aria-label="Search templates" className="input mb-1.5 !py-1.5" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />}
          {list.length === 0 ? <div className="px-2 py-2 text-xs text-muted">{q ? 'Nothing by that name.' : `No ${what} templates yet. Fill the card, then save it here.`}</div>
            : <div className="max-h-56 overflow-y-auto">{list.slice(0, 20).map((t) => <button key={t.id} type="button" className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[13px] hover:bg-paper-2" onClick={() => { onPick(t); setOpen(false); }}><span className="min-w-0 flex-1 truncate font-medium">{t.name}</span>{t.uses > 0 && <span className="text-[11px] text-muted">{t.uses}×</span>}</button>)}</div>}
          <div className="mt-1 flex items-center gap-1 border-t border-line pt-1.5">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setOpen(false); onSave(); }}><Icon name="plus" className="h-3.5 w-3.5" />Save {what} as template</button>
            {onClear && <button type="button" className="btn btn-ghost btn-sm ml-auto text-rose" onClick={() => { setOpen(false); onClear(); }}>Clear</button>}
          </div>
        </div>
      </Floating>
    </>
  );
}

/** The line at the foot of a card, Eka's "Start typing…": matches as you type, Enter adds the top match or what was typed. */
function SearchLine({ placeholder, options = [], onAdd, invalid, autoFocus }: { placeholder: string; options?: string[]; onAdd: (t: string) => void; invalid?: boolean; autoFocus?: boolean }) {
  const [v, setV] = useState('');
  const q = v.trim().toLowerCase();
  const hits = q ? options.filter((o) => o.toLowerCase().includes(q)).slice(0, 8) : [];
  const add = (t: string) => { if (t.trim()) onAdd(t.trim()); setV(''); };
  return (
    <div className="relative mt-2" data-invalid={invalid || undefined}>
      <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
      <input aria-label={placeholder} autoFocus={autoFocus} className={`input w-full !py-2 !pl-9 ${invalid ? '!outline-2 !outline-rose/70' : ''}`} placeholder={placeholder} value={v} onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(hits[0] && hits[0].toLowerCase().startsWith(q) ? hits[0] : v); } else if (e.key === 'Escape') setV(''); }} />
      {hits.length > 0 && <div className="menu left-0 right-0 !mt-1 !min-w-0" role="listbox">{hits.map((o) => <button key={o} type="button" role="option" aria-selected={false} className="!py-2 !text-[13px]" onMouseDown={(e) => e.preventDefault()} onClick={() => add(o)}>{o}</button>)}</div>}
    </div>
  );
}

/** One row inside a card: the item, its details, and the remove button at the right edge. */
const Row = ({ children, onRemove, label }: { children: ReactNode; onRemove?: (() => void) | null; label: string }) => (
  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-line/70 py-2 first:border-t-0 first:pt-0">
    {children}
    {onRemove ? <button type="button" className="btn btn-ghost btn-icon ml-auto !h-7 !w-7" aria-label={`Remove ${label}`} onClick={onRemove}><Icon name="x" className="h-3.5 w-3.5" /></button> : <span className="ml-auto" />}
  </div>
);

/** Load previous: every past visit, a preview of the one picked, and only the ticked parts come over. */
function LoadPrevious({ previous, onLoad }: { previous: any[]; onLoad: (e: any, parts: Record<string, boolean>) => void }) {
  const [open, setOpen] = useState(false); const [sel, setSel] = useState<any>(null); const btn = useRef<HTMLButtonElement>(null);
  const [parts, setParts] = useState<Record<string, boolean>>({ dx: true, rx: true, advice: false, tests: false });
  const done = previous.filter((x) => x.status === 'completed'); const e = sel ?? done[0];
  if (!done.length) return null;
  return (
    <>
      <button ref={btn} type="button" className="btn btn-ghost !min-h-7 !px-2 text-[12px] text-muted hover:text-ink" aria-expanded={open} onClick={() => setOpen(!open)}>Load previous ▾</button>
      <Floating anchor={btn} open={open} onClose={() => setOpen(false)} width={460}>
        <div className="p-2">
          <div className="mb-2 flex flex-wrap gap-3 text-[12.5px]">{([['dx', 'Diagnosis'], ['rx', 'Medicines'], ['advice', 'Advice'], ['tests', 'Tests']] as const).map(([k, l]) => <label key={k} className="inline-flex items-center gap-1.5 font-medium"><input type="checkbox" className="accent-ink" checked={!!parts[k]} onChange={(ev) => setParts({ ...parts, [k]: ev.target.checked })} />{l}</label>)}</div>
          <div className="max-h-40 space-y-1 overflow-y-auto">{done.slice(0, 10).map((x) => <button key={x.id} type="button" className={`w-full rounded-md border px-2.5 py-1.5 text-left text-[12.5px] ${e?.id === x.id ? 'border-ink bg-surface-2' : 'border-line hover:bg-surface-2'}`} onClick={() => setSel(x)}>
            <div className="flex items-center gap-2"><b>{fmtDate(x.createdAt)}</b><span className="text-muted">{x.doctor?.name ?? ''}</span><span className="ml-auto truncate text-muted">{joinList(x.data?.assessment?.diagnosis) || joinList(x.data?.complaint?.chief_complaint) || 'Consultation'}</span></div>
            <div className="truncate text-xs text-muted">{(x.prescription ?? []).map((i: any) => i.name).join(', ') || 'no medicines'}</div></button>)}</div>
          {e && <div className="mt-2 rounded-md border border-line bg-surface-2 p-2.5 text-[12.5px] leading-relaxed">
            <div><b>Dx</b> {joinList(e.data?.assessment?.diagnosis) || '—'}</div>
            <div><b>℞</b> {(e.prescription ?? []).length ? (e.prescription ?? []).map((i: any) => `${i.name}${i.frequency ? ` · ${i.frequency}` : ''}${i.durationDays ? ` · ${i.durationDays} d` : ''}`).join('; ') : '—'}</div>
            {e.data?.plan?.advice && <div><b>Advice</b> {String(e.data.plan.advice).split('\n').filter(Boolean).join(' · ')}</div>}
            {(e.recommendations ?? []).some((r: any) => r.kind === 'investigation') && <div><b>Tests</b> {(e.recommendations ?? []).filter((r: any) => r.kind === 'investigation').map((r: any) => r.notes).join(', ')}</div>}
          </div>}
          <div className="mt-2 flex items-center gap-2"><span className="text-xs text-muted">Anything already on the pad is kept once.</span><button type="button" className="btn btn-sm btn-primary ml-auto" disabled={!e || !Object.values(parts).some(Boolean)} onClick={() => { onLoad(e, parts); setOpen(false); }}>Load</button></div>
        </div>
      </Floating>
    </>
  );
}

/** The consultation on one pad: section cards in the clinic's order, templates in every card header, type anything on top, finish and call the next patient. */
export function Encounter() {
  const { id } = useParams(); const nav = useNavigate(); const { cfg, perms, me } = useOutletContext<any>(); const [, setSp] = useSearchParams();
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
  const [viewing, setViewing] = useState<string | null>(null);
  const pinsQ = usePins(enc.data?.patientId ?? '');
  const [testDraft, setTestDraft] = useState(''); const [line, setLine] = useState(''); const [pendingLine, setPendingLine] = useState<string | null>(null);
  const [applied, setApplied] = useState<string | null>(null); const undo = useRef<{ data: any; rx: RxItem[]; recs: Rec[] } | null>(null);
  const [seOpen, setSeOpen] = useState(false); // the side-effect options are folded until asked for
  const [tplOpen, setTplOpen] = useState(false); const [tplQ, setTplQ] = useState(''); const [tplSel, setTplSel] = useState<any>(null); const tplBtn = useRef<HTMLButtonElement>(null);
  const [setNote, setSetNote] = useState('');
  const [tab, setTab] = useState<'pad' | 'visits' | 'photos' | 'docs'>('pad'); // the pad, or one of the patient's collections beside it
  const [split, setSplit] = useState(() => { try { return localStorage.getItem('pad-layout') === 'split'; } catch { return false; } }); // the doctor's choice: cards stacked (Eka) or rows left, one card right
  useEffect(() => { try { localStorage.setItem('pad-layout', split ? 'split' : 'stacked'); } catch { /* private mode */ } }, [split]);
  const [active, setActive] = useState<string | null>(null);
  const goTo = (k: string) => { if (split && isDoctor) { setActive(k); setTimeout(() => document.getElementById('pad-editor')?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 30); } else document.getElementById(`sec-${k}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }); };
  const [capture, setCapture] = useState(false); const [compare, setCompare] = useState<[any, any] | null>(null);
  const [, tick] = useState(0); useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 30000); return () => clearInterval(t); }, []);
  const loaded = useRef(false); const dirty = useRef(false);
  const previous = (timeline.data?.encounters ?? []).filter((x: any) => x.id !== id);
  const lastDone = previous.find((x: any) => x.status === 'completed');
  useEffect(() => {
    if (enc.data && timeline.data && !loaded.current) {
      // Complaints typed at arrival pre-fill the pad so nobody types them twice; a review carries the diagnosis forward.
      const arrival: Sym[] = (enc.data.visit?.details?.complaints ?? []).map((c: any) => ({ name: c.text, ...(c.duration ? { since: c.duration } : {}) }));
      let d = { ...(enc.data.data ?? {}) };
      if (!asSym(d.complaint?.chief_complaint).length && arrival.length) d = { ...d, complaint: { ...(d.complaint ?? {}), chief_complaint: arrival } };
      if (isDoctor && enc.data.status === 'draft' && isReviewVisit(enc.data.visit, cfg) && !asDx(d.assessment?.diagnosis).length && lastDone?.data?.assessment?.diagnosis) d = { ...d, assessment: { ...(d.assessment ?? {}), diagnosis: lastDone.data.assessment.diagnosis } };
      loaded.current = true; setData(d); setRx(enc.data.prescription.map(own));
      const opened = new Date(new Date(enc.data.createdAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) + 'T00:00:00Z').getTime();
      setRecs(enc.data.recommendations.map((r: any) => ({ id: r.id, status: r.status, orderNo: r.orderNo, kind: r.kind, procedureId: r.procedureId, dueOn: r.dueOn, sittings: r.sittings, notes: r.notes,
        intervalDays: r.kind === 'followup' && r.dueOn ? Math.round((new Date(r.dueOn + 'T00:00:00Z').getTime() - opened) / 86400000) : undefined })));
    }
  }, [enc.data, timeline.data]);
  const cleanRx = () => rx.filter((i) => i.name).map(({ _qtyTouched, _issued, ...i }) => i);
  const save = useMutation({
    mutationFn: ({ complete }: { complete: boolean; back?: boolean }) => patch(`/encounters/${id}`, { data, prescription: cleanRx(), recommendations: recs.filter((r) => r.kind !== 'investigation' || (r.notes && r.status !== 'done')), complete }),
    onSuccess: (_e, { complete, back }) => {
      if (complete) { setErrors([]); setShowMissing(false); } dirty.current = false; setSavedAt(new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }));
      ['queue', 'frontdesk', 'timeline'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      if (complete && held) { toast('Consultation completed'); openPrint({ title: 'Results sheet', rx: id, mode: 'results' }); nav('/today', { viewTransition: true }); }
      else if (complete) { toast(willHold ? 'Prescription issued · held open for the reports' : 'Consultation completed'); openPrint({ title: 'Prescription', rx: id }); nav(isDoctor ? '/today' : '/queue', { viewTransition: true }); }
      else if (back && held) { toast('Kept open for the rest of the reports'); nav('/today', { viewTransition: true }); }
      else if (back) { toast('Intake saved · ready for the doctor'); nav('/queue', { viewTransition: true }); }
    },
    onError: (e: any) => { if (e instanceof ApiError && e.body.code === 'FORM_INVALID') { setErrors(e.body.errors); toast(`Please fill in: ${e.body.errors.map((x: any) => x.message?.replace(/ is required$/, '') || x.path.split('.')[1]).slice(0, 3).join(', ')}`, 'err'); setTimeout(() => document.querySelector('[data-invalid="true"]')?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 80); } else toast(errText(e), 'err'); },
  });
  useEffect(() => { if (loaded.current) dirty.current = true; }, [data, rx, recs]);
  useEffect(() => { const t = setInterval(() => { if (loaded.current && dirty.current && enc.data?.status !== 'completed' && !save.isPending) save.mutate({ complete: false }); }, 15000); return () => clearInterval(t); }, [enc.data?.status, save.isPending]);
  useEffect(() => { const f = () => { if (loaded.current && dirty.current && enc.data?.status !== 'completed') save.mutate({ complete: false }); }; window.addEventListener('app:save-now', f); return () => window.removeEventListener('app:save-now', f); }, [enc.data?.status]);

  // --- sets and protocols: suggested by the complaint or diagnosis, stacked, nothing added twice ---
  const cNames = complaintTexts(enc.data?.visit?.details, data.complaint?.chief_complaint);
  const dNames = asDx(data.assessment?.diagnosis).map((d) => norm(d.name));
  const appliedIds: string[] = data.screen?.applied ?? [];
  const markApplied = (tid: string) => setData((d) => ({ ...d, screen: { ...(d.screen ?? {}), applied: uniq([...(d.screen?.applied ?? []), tid]) } }));
  const addTestNamed = (name: string, days?: number) => setRecs((cur) => {
    const v = name.trim(); if (!v || cur.some((r) => r.kind === 'investigation' && r.notes?.toLowerCase() === v.toLowerCase())) return cur;
    const top = Math.max(1, ...cur.filter((r) => r.kind === 'investigation').map((r) => r.orderNo ?? 1));
    return [...cur, { kind: 'investigation', notes: v, orderNo: isSlow(v) || (days ?? 0) >= 3 ? top + 1 : 1 }];
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
    else if (t.kind === 'tests') { count((p.tests ?? []).map((x: any) => x.name), recs.filter((r) => r.kind === 'investigation').map((r) => norm(r.notes ?? ''))); for (const x of p.tests ?? []) addTestNamed(x.name, x.days); }
    else if (t.kind === 'symptom') { count((p.items ?? []).map((x: Sym) => x.name), asSym(data.complaint?.chief_complaint).map((s) => norm(s.name))); addSyms(p.items ?? []); }
    else if (t.kind === 'diagnosis') { count((p.items ?? []).map((x: Dx) => x.name), dNames); addDxs(p.items ?? []); }
    else if (t.kind === 'procedure') { if (recs.some((r) => r.kind === 'procedure' && r.procedureId === p.procedureId)) had++; else { added++; setRecs((cur) => (cur.some((r) => r.kind === 'procedure' && r.procedureId === p.procedureId) ? cur : [...cur, { kind: 'procedure', procedureId: p.procedureId, sittings: p.sittings, notes: p.intervalDays ? `every ${p.intervalDays} days` : undefined }])); } }
    markApplied(t.id); post(`/templates/${t.id}/use`).catch(() => {});
    return `${t.name}: ${added ? `added ${added}` : 'nothing new'}${had ? `, ${had} already there` : ''}.`;
  };
  // a whole-note protocol, stacked: only what is missing is added; her own diagnosis, medicines and plan stay as they are
  const stackProtocol = (t: any): string => {
    const have = new Set(rx.filter((r) => r.name).map((r) => r.name.toLowerCase()));
    const meds: RxItem[] = (t.prescription ?? []).filter((i: RxItem) => !have.has(i.name.toLowerCase()));
    addRxMany(meds);
    setData((d) => { const td = t.data ?? {}; const adv = (x: any) => String(x ?? '').split('\n').map((y) => y.trim()).filter(Boolean);
      return { ...d, exam: { ...(d.exam ?? {}), ...(td.exam?.morphology ? { morphology: uniq([...(d.exam?.morphology ?? []), ...td.exam.morphology]) } : {}) },
        assessment: { ...(d.assessment ?? {}), ...(asDx(d.assessment?.diagnosis).length ? {} : td.assessment ?? {}) },
        plan: { ...(d.plan ?? {}), advice: uniq([...adv(d.plan?.advice), ...adv(td.plan?.advice)]).join('\n') } }; });
    setRecs((cur) => [...cur, ...(t.recommendations ?? []).filter((r: Rec) => !cur.some((c) => c.kind === r.kind && (r.kind === 'followup' || (c.procedureId === r.procedureId && c.notes === r.notes)))).map((r: Rec) => ({ ...r }))]);
    markApplied(t.id); post(`/rx-templates/${t.id}/use`).catch(() => {});
    return `${t.name}: added ${meds.length} medicine${meds.length === 1 ? '' : 's'}${(t.prescription?.length ?? 0) - meds.length ? `, ${t.prescription.length - meds.length} already there` : ''}.`;
  };
  const autoKey = (sets.data ?? []).filter((t) => t.mode === 'auto' && !appliedIds.includes(t.id) && suggests(t, cNames, dNames)).map((t) => t.id).join(',');
  useEffect(() => {
    if (!loaded.current || !isDoctor || enc.data?.status === 'completed' || !autoKey) return;
    const notes = (sets.data ?? []).filter((t) => autoKey.split(',').includes(t.id)).map(applySet);
    if (notes.length) setSetNote(notes.join(' '));
  }, [autoKey, enc.data?.status, isDoctor]);
  /** Save one section as a set: suggested the next time the same complaint or diagnosis comes up. */
  const saveSection = async (kind: TmplKind) => {
    const payload = kind === 'medicine' ? { items: cleanRx() } : kind === 'advice' ? { lines: String(data.plan?.advice ?? '').split('\n').map((x) => x.trim()).filter(Boolean) }
      : kind === 'tests' ? { tests: recs.filter((r) => r.kind === 'investigation' && r.notes).map((r) => ({ name: r.notes! })) }
      : kind === 'symptom' ? { items: asSym(data.complaint?.chief_complaint) } : kind === 'diagnosis' ? { items: asDx(data.assessment?.diagnosis) } : { chips: data.exam?.morphology ?? [] };
    const what = { medicine: 'medicines', advice: 'advice', tests: 'tests', symptom: 'symptoms', diagnosis: 'diagnosis', finding: 'findings' }[kind as string] ?? kind;
    if (!(Object.values(payload)[0] as any[]).length) return toast(`There is nothing to save yet: no ${what}.`, 'info');
    const r = await ask({ title: `Save the ${what} as a template`, body: 'It is suggested the next time the same complaint or diagnosis comes up, and appears under Load template.', confirmLabel: 'Save', field: { label: 'Name', required: true, initial: asDx(data.assessment?.diagnosis).map((d) => d.name).join(' + ') || '', maxLength: 80 } });
    if (!r?.value || r.value.trim().length < 2) return;
    try { const row: any = await post('/templates', { kind, name: r.value.trim(), linked: { complaints: cNames, diagnoses: dNames }, payload }); qc.invalidateQueries({ queryKey: ['templates'] }); toast(row.draft ? 'Saved. The owner approves it before it is suggested.' : 'Saved as a template'); } catch (e) { toast(errText(e), 'err'); }
  };
  const saveTpl = useMutation({ mutationFn: (name: string) => post('/rx-templates', { name, data, prescription: cleanRx(), recommendations: recs }), onSuccess: (r: any) => { qc.invalidateQueries({ queryKey: ['rx-templates'] }); toast(`Saved as template “${r.name}”`); }, onError: (e) => toast(errText(e), 'err') });

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
  const mins = Math.max(0, Math.round((Date.now() - new Date(e.createdAt).getTime()) / 60000));
  const onHand = (i: RxItem) => (i.medicineId && stock.data ? stock.data[i.medicineId] ?? 0 : null);
  const addRx = (item: RxItem) => setRx((cur) => [...cur.filter((r) => r.name), withQty(item)]);
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
    const r = await ask({ title: 'Save as template', body: 'Saves symptoms, findings, diagnosis, medicines, advice and plan. Using the same name again updates it.', confirmLabel: 'Save', field: { label: 'Template name', required: true, initial: asDx(data.assessment?.diagnosis).map((d) => `${d.name}${d.severity ? ` · ${d.severity.toLowerCase()}` : ''}`).join(' + ') || '', maxLength: 80 } });
    if (r?.value && r.value.trim().length >= 2) saveTpl.mutate(r.value.trim());
  };
  const loadPrevious = (x: any, parts: Record<string, boolean>) => {
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
  const allergyWarnings = rx.filter((i) => i.name).map((i) => [i.name, allergyHit(p.allergies, i.name)] as const).filter(([, w]) => w);
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
  const sugg = (sets.data ?? []).filter((t) => t.kind !== 'complaint' && suggests(t, cNames, dNames));
  const protoSugg = (tpls.data ?? []).filter((t: any) => suggests(t, cNames, dNames));
  const size = (t: Tmpl) => (t.kind === 'medicine' || t.kind === 'symptom' || t.kind === 'diagnosis' ? t.payload.items?.length : t.kind === 'advice' ? t.payload.lines?.length : t.kind === 'finding' ? t.payload.chips?.length : t.kind === 'tests' ? t.payload.tests?.length : 1);
  const orderNos = uniq(tests.map((r) => r.orderNo ?? 1)).sort((a, b) => a - b);
  const toggleOrder = (r: Rec) => setRecs(recs.map((x) => (x === r ? { ...x, orderNo: (r.orderNo ?? 1) === 1 ? Math.max(1, ...tests.map((t) => t.orderNo ?? 1)) + 1 : 1 } : x)));
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
    for (const s of formSections as any[]) for (const f of (s.fields ?? []) as Field[]) { const v = data[s.key]?.[f.key]; if (f.required && !(Array.isArray(v) ? v.length : v) && !out.some((x) => x.path === `${s.key}.${f.key}`)) out.push({ path: `${s.key}.${f.key}`, message: `${(s.fields as Field[]).filter((x) => x.required).length > 1 ? `${s.title} › ${f.label}` : f.label} is required` }); }
    return out;
  };
  const finish = () => {
    const missing = missingNow();
    if (missing.length) { setShowMissing(true); goTo(secOf(missing[0].path)); toast(`Cannot finish yet: ${missing.map((m) => m.message.replace(/ is required$/, '')).join(', ')}`, 'err'); return; }
    save.mutate({ complete: true });
  };
  // what the footer lists: the live check once Finish was tried, plus anything the server still rejected
  const live = showMissing ? missingNow() : [];
  const missingList = [...live, ...errors.filter((e) => !live.some((m) => m.path === e.path))];
  const clearSection = async (what: string, fn: () => void) => { const r = await ask({ title: `Clear ${what}?`, body: 'Everything in this section goes; the rest of the pad stays.', confirmLabel: 'Clear', tone: 'danger' }); if (r) fn(); };

  // --- the cards, in the clinic's order: Eka's shape, one card per section, rows first and the search line last ---
  const secOf = (path: string) => ({ complaint: 'symptoms', assessment: 'diagnosis', exam: 'exam', plan: 'advice' } as Record<string, string>)[path.split('.')[0]] ?? path.split('.')[0];
  const bad = (k: string) => missingList.some((x) => secOf(x.path) === k);
  const tplOf = (kind: TmplKind, sub: string, what: string, clear: (() => void) | null) => (!readOnly && isDoctor ? <SectionTemplates kind={kind} sub={sub} what={what} sets={sets.data ?? []} onPick={(t) => setSetNote(applySet(t))} onSave={() => saveSection(kind)} onClear={clear} /> : null);
  const labNames = uniq([...TESTS, ...(cfg?.labParams ?? []).map((o: any) => o.name)]);
  const procName = (id?: string | null) => cfg?.procedures?.find((x: any) => x.id === id)?.name ?? 'Procedure';
  const cards: Record<string, ReactNode> = {
    vitals: <Card key="vitals" id="vitals" title="Vitals" meta="from check-in · tap a value to change it"><VitalsCard encounterId={id!} patientId={p.id} details={e.visit?.details ?? {}} heightCm={p.history?.heightCm} readOnly={readOnly} /></Card>,
    history: <Card key="history" id="history" title="Medical history"><HistoryChips patientId={p.id} history={p.history ?? {}} categories={cfg?.historyCategories ?? []} readOnly={readOnly} /></Card>,
    symptoms: <Card key="symptoms" id="symptoms" title="Symptoms" required={isDoctor && padOf('symptoms').required} invalid={bad('symptoms')} actions={tplOf('symptom', 'Sx', 'symptoms', syms.length ? () => clearSection('the symptoms', () => setSyms([])) : null)}>
      <div data-invalid={!!err('complaint', 'chief_complaint')}>
        {syms.map((s, i) => <Row key={s.name + i} label={s.name} onRemove={readOnly ? null : () => setSyms(syms.filter((_, j) => j !== i))}>
          <b className="min-w-[160px] text-[13.5px]">{s.name}</b>
          <input aria-label={`${s.name}: since`} className="input !w-28 !py-1 text-[12.5px]" placeholder="Since" maxLength={30} value={s.since ?? ''} disabled={readOnly} onChange={(ev) => setSyms(syms.map((x, j) => (j === i ? { ...x, since: ev.target.value } : x)))} />
          <Segmented size="sm" disabled={readOnly} value={s.severity ?? ''} onChange={(sv) => setSyms(syms.map((x, j) => (j === i ? { ...x, severity: sv || undefined } : x)))} options={SEVERITIES.map((sv) => ({ value: sv, label: sv }))} />
          <input aria-label={`${s.name}: note`} className="input min-w-36 flex-1 !py-1 text-[12.5px]" placeholder="Note" maxLength={120} value={s.note ?? ''} disabled={readOnly} onChange={(ev) => setSyms(syms.map((x, j) => (j === i ? { ...x, note: ev.target.value } : x)))} />
        </Row>)}
        {!readOnly && <>
          <div className="mt-2 flex flex-wrap items-center gap-1">{(symField?.options ?? []).filter((o: string) => !syms.some((s) => norm(s.name) === norm(o))).slice(0, 8).map((o: string) => <button key={o} type="button" className="opt !min-h-7 !py-0.5" onClick={() => addSyms([{ name: o }])}>{o}</button>)}</div>
          <SearchLine placeholder="Start typing a symptom · “itching 2 weeks”" options={symField?.options ?? []} invalid={!!err('complaint', 'chief_complaint')} onAdd={(t) => smartAdd(t, 'symptom')} />
        </>}
        {err('complaint', 'chief_complaint') && <div className="mt-1 text-xs text-rose">At least one symptom is required</div>}
        {otherFields('complaint', ['chief_complaint', 'duration']).map((f: Field) => <div key={f.key} className="mt-2" data-invalid={!!err('complaint', f.key)}><CompactField f={f} value={data.complaint?.[f.key]} onChange={(v) => set('complaint', f.key, v)} disabled={readOnly} invalid={!!err('complaint', f.key)} /></div>)}
      </div></Card>,
    diagnosis: <Card key="diagnosis" id="diagnosis" title="Diagnosis" required={isDoctor} invalid={bad('diagnosis')} meta={isDoctor ? undefined : 'the doctor decides; leave it if unsure'} actions={!readOnly && isDoctor && <><LoadPrevious previous={previous} onLoad={loadPrevious} />{tplOf('diagnosis', 'Dx', 'diagnosis', dxs.length ? () => clearSection('the diagnosis', () => setDxs([])) : null)}</>}>
      <div data-invalid={!!err('assessment', 'diagnosis')}>
        {dxs.map((d, i) => <Row key={d.name} label={d.name} onRemove={readOnly ? null : () => setDxs(dxs.filter((_, j) => j !== i))}>
          <b className="min-w-[160px] text-[13.5px]">{d.name}</b>
          <Segmented size="sm" disabled={readOnly} value={d.severity ?? ''} onChange={(sv) => setDxs(dxs.map((x, j) => (j === i ? { ...x, severity: sv || undefined } : x)))} options={SEVERITIES.map((sv) => ({ value: sv, label: sv }))} />
          <Segmented size="sm" disabled={readOnly} value={d.status ?? ''} onChange={(st) => setDxs(dxs.map((x, j) => (j === i ? { ...x, status: st || undefined } : x)))} options={DX_STATUS.map((st) => ({ value: st, label: st }))} />
        </Row>)}
        {!readOnly && <>
          <div className="mt-2 flex flex-wrap items-center gap-1">{(dxField?.options ?? DX_OPTIONS).filter((o: string) => !dxs.some((d) => d.name === o)).slice(0, 8).map((o: string) => <button key={o} type="button" className="opt !min-h-7 !py-0.5" onClick={() => addDxs([{ name: o }])}>{o}</button>)}</div>
          <SearchLine placeholder="Start typing a diagnosis" options={dxField?.options ?? DX_OPTIONS} invalid={!!err('assessment', 'diagnosis')} onAdd={(t) => smartAdd(t, 'diagnosis')} />
        </>}
        {err('assessment', 'diagnosis') && <div className="mt-1 text-xs text-rose">Diagnosis is required</div>}
        {otherFields('assessment', []).map((f: Field) => <div key={f.key} className="mt-2"><CompactField f={f} value={data.assessment?.[f.key]} onChange={(v) => set('assessment', f.key, v)} disabled={readOnly} /></div>)}
        {applied && !readOnly && <div className="mt-2 rounded-lg bg-amber-soft px-3 py-2 text-[12.5px] text-amber anim-fade-in">Filled from <b>{applied}</b>.{p.allergies ? (allergyWarnings.length ? ` Check: ${allergyWarnings.map(([n]) => n).join(', ')} may clash with the ${p.allergies} allergy.` : ` ${p.allergies} allergy checked: no clash found.`) : ''} <button type="button" className="font-semibold underline" onClick={clearLoaded}>Clear loaded</button></div>}
      </div></Card>,
    exam: <Card key="exam" id="exam" title="Examination findings" required={isDoctor && padOf('exam').required} invalid={bad('exam')} actions={tplOf('finding', 'O/E', 'findings', Object.keys(data.exam ?? {}).length ? () => clearSection('the examination', () => setData((d) => ({ ...d, exam: {} }))) : null)}>
      <div className="mb-3 border-b border-line pb-3"><SkinMapPanel patientId={p.id} patientName={p.fullName} encounterId={id} readOnly={readOnly} defaultDx={dxs[0]?.name} onAreaAdded={(a) => set('complaint', 'site', uniq([...((data.complaint?.site ?? []) as string[]), a]))} compact /></div>
      <div className="space-y-2">{(formSections.find((s) => s.key === 'exam')?.fields ?? []).map((f: Field) => <div key={f.key} data-invalid={!!err('exam', f.key)}><CompactField f={f} value={data.exam?.[f.key]} onChange={(v) => set('exam', f.key, v)} disabled={readOnly} invalid={!!err('exam', f.key)} />{err('exam', f.key) && <div className="mt-1 text-xs text-rose">{f.label} is required</div>}</div>)}</div></Card>,
    medicines: isDoctor ? <Card key="medicines" id="medicines" title="Medications" required={padOf('medicines').required} invalid={bad('medicines')} meta={rx.filter((i) => i.name).length ? `${rx.filter((i) => i.name).length} on the Rx` : undefined} actions={!readOnly && <><LoadPrevious previous={previous} onLoad={loadPrevious} />{tplOf('medicine', 'Mx', 'medicines', rx.length ? () => clearSection('the medicines', () => setRx([])) : null)}</>}>
      <datalist id="meds">{meds.map((m: any) => <option key={m.id} value={m.name} />)}</datalist>
      <datalist id="freq">{FREQ.map((x) => <option key={x} value={x} />)}</datalist>
      <datalist id="timing">{TIMING.map((x) => <option key={x} value={x} />)}</datalist>
      {rx.filter((i) => i.name || !readOnly).length > 0 && <div className="overflow-x-auto"><div className="min-w-[760px]">
        <div className="grid grid-cols-[1.5fr_64px_92px_104px_52px_56px_1fr_80px_28px] gap-1.5 px-0.5 text-[11px] font-semibold uppercase tracking-wider text-muted"><span>Medicine</span><span>Dose</span><span>Frequency</span><span>Timing</span><span>Days</span><span>Qty</span><span>Instructions</span><span /><span /></div>
        {rx.map((i, k) => { const n = onHand(i); const hit = allergyHit(p.allergies, i.name); return (
          <div key={k} className="mt-1.5 grid grid-cols-[1.5fr_64px_92px_104px_52px_56px_1fr_80px_28px] items-center gap-1.5">
            <input id={`rx-${i.name}`} list="meds" aria-label="Medicine" className={`input !py-1.5 font-semibold ${hit ? '!border-rose' : ''}`} value={i.name} disabled={readOnly || i._issued} onChange={(ev) => { const m = meds.find((x: any) => x.name === ev.target.value); upd(k, { name: ev.target.value, medicineId: m?.id ?? null, ...(m ? { dose: m.defaults?.dose, route: m.defaults?.route, frequency: m.defaults?.frequency, durationDays: m.defaults?.durationDays, instructions: m.defaults?.instructions } : {}) }); }} />
            <input aria-label="Dose" className="input !py-1.5" placeholder="1 tab" value={i.dose ?? ''} disabled={readOnly || i._issued} onChange={(ev) => upd(k, { dose: ev.target.value })} />
            <input aria-label="Frequency" list="freq" className="input !py-1.5" placeholder="1-0-1" value={i.frequency ?? ''} disabled={readOnly || i._issued} onChange={(ev) => upd(k, { frequency: ev.target.value })} />
            <input aria-label="Timing" list="timing" className="input !py-1.5" placeholder="after food" value={i.timing ?? ''} disabled={readOnly || i._issued} onChange={(ev) => upd(k, { timing: ev.target.value || null })} />
            <NumInput aria-label="Days" max={365} className="input !py-1.5" value={i.durationDays ?? ''} disabled={readOnly || i._issued} onChange={(ev) => upd(k, { durationDays: ev.target.value ? Number(ev.target.value) : undefined })} />
            <NumInput aria-label="Quantity" max={9999} className="input !py-1.5" value={i.qty ?? ''} disabled={readOnly || i._issued} onChange={(ev) => upd(k, { qty: ev.target.value ? Number(ev.target.value) : null })} />
            <input aria-label="Instructions" className="input !py-1.5" placeholder="if any" value={i.instructions ?? ''} disabled={readOnly || i._issued} onChange={(ev) => upd(k, { instructions: ev.target.value })} />
            <span className={`truncate text-[11.5px] font-semibold ${hit ? 'text-rose' : n === 0 ? 'text-amber' : 'text-muted'}`}>{hit ? `allergy: ${hit}` : n === null ? (i.name && !i.medicineId ? 'not in list' : '') : n === 0 ? 'out of stock' : `${n} in stock`}</span>
            {!readOnly && !i._issued ? <button className="btn btn-ghost btn-icon !h-8 !w-8" aria-label={`Remove ${i.name || 'line'}`} onClick={() => setRx(rx.filter((_, j) => j !== k))}><Icon name="x" className="h-3.5 w-3.5" /></button> : i._issued ? <span className="text-[11px] text-muted" title="Issued at the counter; it stays as written">issued</span> : <span />}
          </div>); })}
      </div></div>}
      {!readOnly && <>
        {(frequent.data ?? []).filter((f: any) => !rx.some((r) => r.name === f.name)).length > 0 && <div className="mt-2 flex flex-wrap items-center gap-1"><span className="mr-1 text-[11px] font-semibold uppercase tracking-wider text-muted">Frequently prescribed</span>{(frequent.data ?? []).filter((f: any) => !rx.some((r) => r.name === f.name)).slice(0, 8).map((f: any) => <button key={f.name} type="button" className="opt !min-h-7 !py-0.5" onClick={() => addRxByName(f.name)}>{f.name}</button>)}{lastRx.length > 0 && !isReview && <button type="button" className="opt !min-h-7 !py-0.5" onClick={() => addRxMany(lastRx)}>Repeat last Rx</button>}</div>}
        <SearchLine placeholder='Start typing a medicine · “itra 100 1-0-1 7d after food”' options={meds.map((m: any) => m.name)} invalid={bad('medicines')} onAdd={(t) => smartAdd(t, 'medicine')} />
      </>}
      {leaflets.length > 0 && <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted"><span>Sent with the Rx on WhatsApp:</span>{leaflets.map((m: any) => <Chip key={m.id} tone="sage">{m.name}: how to use</Chip>)}</div>}
      {allergyWarnings.length > 0 && <div className="mt-2 rounded-lg bg-rose-soft px-3 py-2 text-xs text-rose">Allergy: {p.allergies}. Check {allergyWarnings.map(([n]) => n).join(', ')}.</div>}
    </Card> : null,
    advice: isDoctor ? <Card key="advice" id="advice" title="Advice" meta="standard lines print in Telugu too" actions={tplOf('advice', 'Adv', 'advice', adviceLines.length ? () => clearSection('the advice', () => set('plan', 'advice', '')) : null)}>
      <div className="flex flex-wrap gap-1.5">{[...new Set([...adviceLines, ...ADVICE.slice(0, 8)])].map((a) => <button key={a} type="button" disabled={readOnly} className={adviceLines.includes(a) ? 'toggle-opt on' : 'opt'} onClick={() => toggleAdvice(a)}>{adviceLines.includes(a) && <Icon name="check" className="mr-1 inline h-3 w-3" />}{a}</button>)}</div>
      {!readOnly && <SearchLine placeholder="Start typing advice" options={ADVICE} onAdd={(a) => !adviceLines.includes(a) && set('plan', 'advice', [...adviceLines, a].join('\n'))} />}
    </Card> : null,
    tests: isDoctor ? <Card key="tests" id="tests" title="Lab investigations" actions={tplOf('tests', 'Lab', 'tests', tests.some((r) => r.status !== 'done') ? () => clearSection('the tests', () => setRecs(recs.filter((r) => r.kind !== 'investigation' || r.status === 'done'))) : null)}>
      {tests.map((r) => <Row key={r.notes} label={r.notes ?? 'test'} onRemove={readOnly || r.status === 'done' ? null : () => setRecs(recs.filter((x) => x !== r))}>
        <b className="min-w-[160px] text-[13.5px]">{r.notes}</b>
        {r.status === 'done' ? <Chip tone="sage">received</Chip> : orderNos.length > 1 ? <span className="text-xs text-muted">order {r.orderNo ?? 1}</span> : null}
        {!readOnly && r.status !== 'done' && <button type="button" className="opt !min-h-7 !py-0.5 text-xs" title={(r.orderNo ?? 1) === 1 ? 'Review this test on its own, so it does not hold the others back' : 'Join the first order'} onClick={() => toggleOrder(r)}>{(r.orderNo ?? 1) === 1 ? 'Review on its own' : 'Join the first order'}</button>}
      </Row>)}
      {orderNos.length > 1 && <div className="mt-1 text-xs text-muted">{orderNos.map((o) => `Order ${o}: ${tests.filter((r) => (r.orderNo ?? 1) === o).map((r) => r.notes).join(', ')}`).join(' · ')} · each is reviewed when all its tests are in</div>}
      {!readOnly && <>
        <div className="mt-2 flex flex-wrap items-center gap-1">{TESTS.filter((x) => !tests.some((r) => r.notes?.toLowerCase() === x.toLowerCase())).slice(0, 8).map((x) => <button key={x} type="button" className="opt !min-h-7 !py-0.5" onClick={() => addTest(x)}>{x}</button>)}</div>
        <SearchLine placeholder="Start typing a lab test" options={labNames} onAdd={addTest} />
      </>}
    </Card> : null,
    results: isDoctor ? <Card key="results" id="results" title="Lab results" meta="typed when reports arrive"><LabResultsCard patientId={p.id} encounterId={id!} recIds={recIds} params={cfg?.labParams ?? []} readOnly={readOnly} printOut={printOut} onPrintOut={(v) => set('labs', 'printOutOfRangeOnly', v)} /></Card> : null,
    next: isDoctor ? <Card key="next" id="next" title="Follow-up and procedures">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Review in"><span className="mr-1 min-w-[72px] text-xs text-muted">Review in</span>
          {REVIEW_IN.map(([d, l]) => <button key={l} type="button" role="radio" aria-checked={(followup?.intervalDays ?? null) === d && (d !== null || !followup)} disabled={readOnly} className={`toggle-opt ${(d === null ? !followup : followup?.intervalDays === d) ? 'on' : ''}`} onClick={() => setFollowup(d)}>{l}</button>)}
          {followup && !REVIEW_IN.some(([d]) => d === followup.intervalDays) && <span className="flex items-center gap-1 text-xs">· <NumInput aria-label="Review in days" max={365} className="input !w-16 !py-1" value={followup.intervalDays ?? ''} disabled={readOnly} onChange={(ev) => setFollowup(Number(ev.target.value) || null)} /> days</span>}
          {followup && <input aria-label="Note for the follow-up" className="input !w-56 !py-1" maxLength={120} placeholder="Note for the follow-up" value={data.plan?.followupNote ?? ''} disabled={readOnly} onChange={(ev) => set('plan', 'followupNote', ev.target.value)} />}
          {followup && !readOnly && can(perms, 'appointment.write') && <button type="button" className="btn btn-sm" onClick={() => setSp({ book: '1', patient: p.id, pname: p.fullName })}>Book slot</button>}
        </div>
        <div className="flex flex-wrap items-start gap-1.5"><span className="mr-1 mt-1.5 min-w-[72px] text-xs text-muted">Procedure</span>
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {recs.map((r, k) => r.kind !== 'procedure' ? null : (
            <span key={k} className="flex flex-wrap items-center gap-1.5 rounded-lg bg-sky-soft px-2 py-1 text-[13px]">
              <select aria-label="Procedure" className="input !w-auto !py-1" value={r.procedureId ?? ''} disabled={readOnly} onChange={(ev) => { const pr = cfg.procedures.find((x: any) => x.id === ev.target.value); setRecs(recs.map((x, j) => (j === k ? { ...x, procedureId: ev.target.value, sittings: pr?.typicalSittings } : x))); }}>{cfg?.procedures.map((pr: any) => <option key={pr.id} value={pr.id}>{pr.name}</option>)}</select>
              <NumInput aria-label="Sittings" max={50} className="input !w-14 !py-1" value={r.sittings ?? ''} disabled={readOnly} onChange={(ev) => setRecs(recs.map((x, j) => (j === k ? { ...x, sittings: Number(ev.target.value) } : x)))} /><span className="text-xs text-muted">sittings</span>
              <input aria-label="Note for the coordinator" className="input !w-44 !py-1" placeholder="Note for the coordinator" value={r.notes ?? ''} disabled={readOnly} onChange={(ev) => setRecs(recs.map((x, j) => (j === k ? { ...x, notes: ev.target.value } : x)))} />
              {!readOnly && <button className="btn btn-ghost btn-icon !h-7 !w-7" aria-label={`Remove ${procName(r.procedureId)}`} onClick={() => setRecs(recs.filter((_, j) => j !== k))}><Icon name="x" className="h-3 w-3" /></button>}
            </span>))}
          {!readOnly && (cfg?.procedures ?? []).length > 0 && <button type="button" className="toggle-opt" onClick={() => setRecs([...recs, { kind: 'procedure', procedureId: cfg.procedures[0].id, sittings: cfg.procedures[0].typicalSittings }])}><Icon name="plus" className="inline h-3 w-3" /> Add a procedure</button>}
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
        : ph.length ? <div className="flex gap-1.5">{ph.slice(0, 6).map((x) => <img key={x.id} src={`/api/documents/${x.id}/file`} alt={x.area ?? 'photo'} className="h-16 w-16 rounded-lg object-cover" />)}</div> : <div className="text-xs text-muted">No photos yet.</div>}
    </Card>,
  };
  const shown = pad.length ? pad.filter((s) => s.show).map((s) => s.key) : Object.keys(cards);
  // the doctor's photos live on their own tab; the junior takes the "before" pictures at intake, so intake keeps the card
  const order = isDoctor ? shown.filter((k) => k !== 'photos') : [...shown.filter((k) => k !== 'photos'), ...(can(perms, 'document.write') ? ['photos'] : [])];
  const pinCount = (pinsQ.data ?? []).filter((x) => !x.resolvedAt).length;
  const suggested = [...protoSugg.map((t: any) => ({ id: t.id, name: t.name, meta: 'protocol', go: () => setSetNote(stackProtocol(t)) })), ...sugg.map((t) => ({ id: t.id, name: t.name, meta: `${size(t)}`, go: () => setSetNote(applySet(t)) }))];
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
              <div className="flex flex-wrap items-center gap-2"><span className="min-w-[72px] text-xs text-muted">Side effects</span><span className={`text-[13.5px] ${real.length ? 'font-medium text-amber' : ''}`}>{real.length ? real.join(', ') : 'none reported'}</span>{!readOnly && <button type="button" className="opt !min-h-7 !py-0.5" onClick={() => setSeOpen(!seOpen)}>{seOpen ? 'Done' : 'Change'}</button>}
                {seOpen && !readOnly && <div className="flex basis-full flex-wrap gap-1 anim-fade-in">{SIDE_EFFECTS.filter((x) => x !== 'None').map((x) => { const on = se.includes(x); return <button key={x} type="button" className={`!min-h-7 !py-0.5 ${on ? 'toggle-opt on' : 'opt'}`} onClick={() => set('review', 'sideEffects', on ? se.filter((y) => y !== x) : [...se.filter((y) => y !== 'None'), x])}>{x}</button>; })}</div>}
              </div>); })()}
            {lastRx.length > 0 && <div>
              <div className="flex items-center gap-2"><span className="text-xs text-muted">Last prescription · continue, change or stop each line</span>{!readOnly && <button className="btn btn-ghost btn-sm ml-auto" onClick={() => setRx((cur) => [...cur.filter((r) => r.name && !lastRx.some((l) => l.name === r.name)), ...lastRx.map((l) => cur.find((r) => r.name === l.name) ?? withQty({ ...l }))])}>Continue all</button>}</div>
              {lastRx.map((l, k) => {
                const cur = rx.find((r) => r.name === l.name); const st = !cur ? (rx.length ? 'stop' : '') : sameLine(cur, l) ? 'continue' : 'change';
                const raw = lastRaw[k];
                return (
                  <Row key={l.name + k} label={l.name}>
                    <span className="min-w-0 flex-1"><b className="text-[13.5px]">{l.name}</b><span className="block text-[12.5px] text-muted">{[l.dose, l.frequency, l.durationDays ? `${l.durationDays} days` : null, l.instructions].filter(Boolean).join(' · ')}{raw && raw.medicineId && !raw.issuedQty ? ' · patient did not buy' : ''}{st === 'change' && cur ? ` · now ${[cur.dose, cur.frequency, cur.durationDays ? `${cur.durationDays}d` : null].filter(Boolean).join(' · ')}` : ''}</span></span>
                    {!readOnly && <Segmented size="sm" value={st} onChange={(v) => { if (v === 'continue') setRx((r) => cur ? r.map((x) => (x.name === l.name ? withQty({ ...l }) : x)) : [...r.filter((x) => x.name), withQty({ ...l })]); else if (v === 'change') { if (!cur) setRx((r) => [...r.filter((x) => x.name), withQty({ ...l })]); goTo('medicines'); setTimeout(() => document.getElementById(`rx-${l.name}`)?.focus(), 300); } else setRx((r) => r.filter((x) => x.name !== l.name)); }} options={[{ value: 'continue', label: 'Continue' }, { value: 'change', label: 'Change' }, { value: 'stop', label: 'Stop' }]} />}
                  </Row>); })}
            </div>}
          </div>
        </Card> : null;
  // side by side: one row per section with what it says so far; the open row's card sits on the right
  const txt = (xs: (string | null | undefined | false)[]) => xs.filter(Boolean).join(' · ');
  const vd = e.visit?.details ?? {};
  const examFields: Field[] = formSections.find((x) => x.key === 'exam')?.fields ?? [];
  const histItems: string[] = (cfg?.historyCategories ?? []).flatMap((c: any) => (Array.isArray(p.history?.[c.key]) ? p.history[c.key].map((x: any) => x.name) : []));
  const brief: Record<string, string | null> = {
    review: data.review?.response ?? null,
    vitals: txt([vd.weight_kg && `${vd.weight_kg} kg`, vd.height_cm && `${vd.height_cm} cm`, vd.bp && `BP ${vd.bp}`, vd.pulse && `pulse ${vd.pulse}`, vd.temp_f && `${vd.temp_f} °F`]) || null,
    history: histItems.length ? histItems.join(', ') : null,
    symptoms: syms.length ? syms.map((x) => txt([x.name, x.since && `since ${x.since}`])).join('; ') : null,
    diagnosis: dxs.length ? dxs.map((d) => txt([d.name, d.severity?.toLowerCase()])).join('; ') : null,
    exam: txt([...examFields.map((f) => { const v = data.exam?.[f.key]; return Array.isArray(v) ? v.join(', ') : v ? String(v) : null; }), (data.complaint?.site ?? []).length ? `sites: ${(data.complaint.site as string[]).join(', ')}` : null]) || null,
    medicines: rx.filter((i) => i.name).length ? rx.filter((i) => i.name).map((i) => i.name).join(', ') : null,
    advice: adviceLines.length ? adviceLines.join(' · ') : null,
    tests: tests.length ? tests.map((r) => r.notes).join(', ') : null,
    results: testRecs.length ? `${testsIn} of ${testRecs.length} reports in` : null,
    next: txt([followup && `Review in ${followup.intervalDays} days`, ...recs.filter((r) => r.kind === 'procedure').map((r) => `${procName(r.procedureId)}${r.sittings ? ` × ${r.sittings}` : ''}`)]) || null,
    notes: data.notes?.private ? String(data.notes.private).slice(0, 120) : null,
    referral: txt([data.referral?.to, data.referral?.speciality]) || null,
  };
  const TITLE: Record<string, string> = { review: isReview ? `Since ${fmtDate(lastDone.createdAt)}` : 'Review', vitals: 'Vitals', history: 'Medical history', symptoms: 'Symptoms', diagnosis: 'Diagnosis', exam: 'Examination findings', medicines: 'Medications', advice: 'Advice', tests: 'Lab investigations', results: 'Lab results', next: 'Follow-up and procedures', notes: 'Private notes', referral: 'Refer to a doctor' };
  for (const x of customSections) { TITLE[x.key] = x.title; brief[x.key] = txt(x.fields.map((f: Field) => { const v = data[x.key]?.[f.key]; return Array.isArray(v) ? v.join(', ') : v ? String(v) : null; })) || null; }
  const rowKeys: string[] = [...(isReview && isDoctor ? ['review'] : []), ...order.filter((k) => cards[k]), ...customSections.map((x: any) => x.key)];
  const act: string = active && rowKeys.includes(active) ? active : (rowKeys.find((k) => ['review', 'symptoms', 'diagnosis', 'medicines'].includes(k) && !brief[k]) ?? (rowKeys.includes('medicines') ? 'medicines' : rowKeys[0]));
  const isRequired = (k: string) => k === 'diagnosis' || (['symptoms', 'exam', 'medicines'].includes(k) && padOf(k).required);

  return (
    <div className="space-y-3 pb-4">
      {/* who: the patient, the templates, the way to the pad's settings; History, Photos and Reports as tabs beside the pad */}
      <div className="card !p-0 anim-fade-up">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-5 pb-3 pt-4">
          <Avatar name={p.fullName} size="h-10 w-10 text-sm" />
          <div className="min-w-0"><div className="flex flex-wrap items-center gap-1.5 text-[16px] font-semibold leading-tight">{p.fullName}<FlagChips flags={p.flags} /></div><CarefulBanner flags={p.flags} />
            <div className="text-xs text-muted">{[p.ageYears ? `${p.ageYears} ${p.sex ?? ''}` : null, p.patientNo, p.phone, visitNo === 1 ? 'first visit' : `visit ${visitNo}`, isReview ? `review of ${joinList(lastDone.data?.assessment?.diagnosis) || 'last visit'}` : null, arrivalText ? `screened: ${arrivalText}` : null].filter(Boolean).join(' · ')}</div></div>
          {p.allergies && <span className="chip chip-rose !py-1">Allergy: {p.allergies}</span>}
          <span className="ml-auto flex flex-wrap items-center gap-2 text-xs text-muted">{me.role === 'assistant' && <Chip tone="sky">Intake · doctor reviews next</Chip>}{!readOnly && isDoctor && <span title="Minutes since the consultation opened"><Icon name="clock" className="mr-1 inline h-3.5 w-3.5" />{mins} min</span>}{e.status === 'completed' && <Chip tone="sage">completed</Chip>}{held && <Chip tone="amber">Rx issued {fmtDate(e.completedAt)} · {testsIn} of {testRecs.length} reports in</Chip>}
            {isDoctor && !readOnly && <><button ref={tplBtn} type="button" className="btn btn-sm" aria-expanded={tplOpen} onClick={() => setTplOpen(!tplOpen)}><Icon name="list" className="h-3.5 w-3.5" />Templates</button>
              <Floating anchor={tplBtn} open={tplOpen} onClose={() => setTplOpen(false)} width={540}>
                <div className="grid grid-cols-[200px_minmax(0,1fr)] gap-2 p-1.5">
                  <div><input autoFocus aria-label="Search templates" className="input mb-1.5 !py-1.5" placeholder="Search" value={tplQ} onChange={(ev) => setTplQ(ev.target.value)} />
                    <div className="max-h-64 space-y-0.5 overflow-y-auto">{tplList.length === 0 ? <div className="px-2 py-2 text-xs text-muted">{tplQ ? 'No template by that name.' : 'No templates yet. Fill the pad, then save it as a template here.'}</div> : tplList.map((t: any) => <button key={t.id} type="button" className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] ${(tplSel ?? tplList[0])?.id === t.id ? 'bg-paper-2 font-semibold' : 'hover:bg-paper-2'}`} onClick={() => setTplSel(t)}><span className="min-w-0 flex-1 truncate">{t.name}</span>{t.uses > 0 && <span className="text-[11px] text-muted">{t.uses}×</span>}</button>)}</div></div>
                  {(tplSel ?? tplList[0]) ? (() => { const t = tplSel ?? tplList[0]; return <div className="rounded-md border border-line bg-surface-2 p-2.5 text-[12.5px] leading-relaxed">
                    <div className="mb-1 flex items-center gap-2"><b className="text-[13px]">{t.name}</b><button type="button" className="btn btn-sm btn-primary ml-auto" onClick={() => applyTpl(t)}>Load</button></div>
                    {joinList(t.data?.assessment?.diagnosis) && <div><b>Dx</b> {joinList(t.data.assessment.diagnosis)}</div>}
                    <div><b>℞</b> {(t.prescription ?? []).length ? (t.prescription ?? []).map((i: any) => `${i.name}${i.frequency ? ` · ${i.frequency}` : ''}${i.durationDays ? ` · ${i.durationDays} d` : ''}`).join('; ') : '—'}</div>
                    {t.data?.plan?.advice && <div><b>Advice</b> {String(t.data.plan.advice).split('\n').filter(Boolean).join(' · ')}</div>}
                    {(t.recommendations ?? []).length > 0 && <div><b>Plan</b> {(t.recommendations ?? []).map((r: any) => r.kind === 'followup' ? `review in ${r.intervalDays} d` : r.kind === 'investigation' ? r.notes : 'procedure').join(', ')}</div>}
                    <div className="mt-1 text-[11.5px] text-muted">Loading replaces the pad; your symptoms and review answers are kept. Clear loaded undoes it.</div></div>; })() : <div className="rounded-md border border-dashed border-line p-2.5 text-[12.5px] text-muted">A template is the whole pad: diagnosis, medicines, advice, tests and plan, loaded in one tap.</div>}
                </div>
                <div className="flex items-center gap-1 border-t border-line p-1.5">
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setTplOpen(false); askTpl(); }}><Icon name="plus" className="h-3.5 w-3.5" />Save this pad as a template</button>
                  {applied && <button type="button" className="btn btn-ghost btn-sm ml-auto" onClick={() => { clearLoaded(); setTplOpen(false); }}>Clear loaded ({applied})</button>}
                </div>
              </Floating></>}
            {isDoctor && <Segmented<'stacked' | 'split'> size="sm" value={split ? 'split' : 'stacked'} onChange={(v) => setSplit(v === 'split')} options={[{ value: 'stacked', label: 'Stacked' }, { value: 'split', label: 'Side by side' }]} />}
            {isDoctor && can(perms, 'config.write') && <button type="button" className="btn btn-sm" title="Which sections show, which are required, what prints" onClick={() => nav('/settings?tab=pad')}><Icon name="gear" className="h-3.5 w-3.5" />Configure pad</button>}
          </span>
        </div>
        {isDoctor && <div className="flex flex-wrap items-center gap-0.5 border-t border-line/70 px-3 py-1.5" role="tablist">
          {([['pad', 'Pad', 0], ['visits', 'Past visits', previous.length], ['photos', 'Photos', ph.length], ['docs', 'Reports', myDocs.length]] as const).map(([k, l, n]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={`dtab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>{l}{n > 0 && <span className="ml-1.5 text-[11px] text-muted">{n}</span>}</button>)}
          {pinCount > 0 && <span className="ml-auto text-xs text-muted">Skin map · {pinCount} active {pinCount === 1 ? 'site' : 'sites'} · in Examination</span>}
        </div>}
      </div>

      {tab === 'pad' && <>
        {isDoctor && !readOnly && <div className="anim-fade-up">
          <div className="relative"><Icon name="search" className="absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-clay" />
            <input aria-label="Type anything" className="typebar" placeholder='Type anything · medicines, symptoms, diagnosis, tests · “itra 100 1-0-1 7d”, “itching 2 weeks”, “KOH mount”' value={line} onChange={(ev) => { setLine(ev.target.value); setPendingLine(null); }} onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.preventDefault(); smartAdd(line); } }} />
            <span className="kbd absolute right-4 top-1/2 -translate-y-1/2">Enter to fill</span></div>
          {pendingLine && <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs anim-fade-in"><span className="text-muted">“{pendingLine}” is not in the lists. Add as</span>{([['symptom', 'Symptom'], ['diagnosis', 'Diagnosis'], ['medicine', 'Medicine'], ['test', 'Test'], ['advice', 'Advice']] as const).map(([k, l]) => <button key={k} type="button" className="toggle-opt !min-h-7 !py-0.5" onClick={() => smartAdd(pendingLine, k)}>{l}</button>)}<button type="button" className="btn btn-ghost !min-h-7 !px-2 text-xs" onClick={() => setPendingLine(null)}>Cancel</button></div>}
          {suggested.length > 0 && <div className="mt-1.5 flex flex-wrap items-center gap-1 px-1 text-xs"><span className="mr-1 text-muted">Goes with this</span>{suggested.slice(0, 4).map((t) => <button key={t.id} type="button" title="One tap adds it; anything already on the pad is kept once" className={`!min-h-7 !py-0.5 ${appliedIds.includes(t.id) ? 'toggle-opt on' : 'opt'}`} onClick={t.go}>{t.name}<span className="ml-1.5 text-[11px] font-medium opacity-60">{t.meta}</span></button>)}</div>}
        </div>}
        {held && <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[12px] bg-amber-soft px-4 py-2.5 text-[12.5px] text-amber anim-fade-in" role="status"><b>Held for reports.</b><span>Prescription issued {fmtDate(e.completedAt)}. {testsIn} of {testRecs.length} reports in{testsOpen ? `; pending: ${testRecs.filter((r: any) => r.status !== 'done').map((r: any) => `${r.notes}${r.expectedOn ? ` (expected ${fmtDate(r.expectedOn)})` : ''}`).join(', ')}` : ''}.</span>{isDoctor && <span className="text-muted">Add or change what the results call for, then Complete. Issued medicines stay as written.</span>}</div>}
        {setNote && !readOnly && <div className="rounded-[12px] bg-amber-soft px-4 py-2.5 text-[12.5px] text-amber anim-fade-in" role="status">{setNote}</div>}

        {!isDoctor && (!readOnly || Object.keys(answers).length > 0 || Object.keys(hist).length > 0) && <div className="card !p-0"><ScreenBlock lists={lists} answers={answers} onAnswers={(a) => set('screen', 'answers', a)} history={hist} onHistory={(h) => set('screen', 'history', h)} disabled={readOnly} open /></div>}
        {!isDoctor && !padOf('history').show && cards.history}

        {split && isDoctor ? <div className="grid items-start gap-3 lg:grid-cols-[300px_minmax(0,1fr)]">
          <div className="card !p-0 lg:sticky lg:top-20 lg:max-h-[calc(100dvh-170px)] lg:overflow-y-auto anim-fade-up" role="tablist" aria-label="Sections">
            {rowKeys.map((k) => { const on = act === k; const v = brief[k]; return (
              <button key={k} type="button" role="tab" aria-selected={on} className={`grid w-full grid-cols-[minmax(0,1fr)_auto] items-start gap-2 border-t border-line/70 px-4 py-2.5 text-left transition-colors first:border-t-0 ${on ? 'bg-paper-2 shadow-[inset_3px_0_0_var(--color-ink)]' : 'hover:bg-surface-2'}`} onClick={() => setActive(k)}>
                <span className="min-w-0"><span className="block text-[12px] font-semibold text-muted">{TITLE[k] ?? k}{isRequired(k) && <span className="text-rose" title="Required to finish"> *</span>}</span><span className={`block truncate text-[13.5px] ${v ? 'text-ink' : bad(k) ? 'text-rose' : 'text-muted/60'}`}>{v ?? (bad(k) ? 'Required' : '—')}</span></span>
                <Icon name="chevR" className={`mt-1 h-3.5 w-3.5 ${on ? 'text-ink' : 'text-muted/40'}`} />
              </button>); })}
          </div>
          <div id="pad-editor" className="min-w-0 scroll-mt-20" key={act}>
            {act === 'review' ? reviewCard : customSections.some((x: any) => x.key === act) ? custom(customSections.find((x: any) => x.key === act)) : cards[act] ?? null}
            {(() => { const i = rowKeys.indexOf(act); const nx = rowKeys[i + 1]; return nx ? <button type="button" className="btn btn-sm mt-2" onClick={() => setActive(nx)}>Next · {TITLE[nx] ?? nx}<Icon name="chevR" className="h-3.5 w-3.5" /></button> : null; })()}
          </div>
        </div> : <>
          {reviewCard}
          {order.map((k) => cards[k] ?? null)}
          {customSections.map(custom)}
        </>}
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
      {tab === 'docs' && <div className="card anim-fade-up">
        <div className="mb-2 flex items-center gap-2"><span className="text-xs text-muted">Lab reports and letters</span><span className="ml-auto" />{can(perms, 'document.write') && <UploadButton patientId={p.id} encounterId={id} label="Upload" onDone={() => qc.invalidateQueries({ queryKey: ['documents', p.id] })} />}</div>
        {myDocs.length === 0 ? <div className="text-xs text-muted">No reports yet.</div> : <DocList docs={myDocs.slice(0, 12)} />}
      </div>}
      {tab === 'photos' && <div className="card anim-fade-up">
        {thenNow && <button className="mb-2 grid w-full max-w-md grid-cols-2 gap-1.5" onClick={() => setCompare(thenNow)} aria-label="Compare first and latest photo">{thenNow.map((x, k) => <span key={x.id} className="relative block aspect-square overflow-hidden rounded-lg bg-paper-2"><img src={`/api/documents/${x.id}/file`} alt={`${k ? 'Latest' : 'First'} ${x.area ?? ''}`} className="h-full w-full object-cover" /><span className="absolute bottom-1 left-1 rounded-md bg-black/55 px-1.5 text-[10px] font-semibold text-white">{fmtDate(x.takenAt)}</span></span>)}</button>}
        {ph.length > 0 && <div className="mb-2 grid grid-cols-4 gap-1.5 sm:grid-cols-6">{ph.slice(0, 12).map((x) => <img key={x.id} src={`/api/documents/${x.id}/file`} alt={x.area ?? 'photo'} className="aspect-square w-full rounded-lg object-cover" />)}</div>}
        {ph.length === 0 && <div className="mb-2 text-xs text-muted">No photos yet.</div>}
        {can(perms, 'document.write') && !readOnly && <button className="btn btn-sm" onClick={() => setCapture(true)}><Icon name="spark" className="h-3.5 w-3.5" />Take photo</button>}
      </div>}

      {/* the action bar, as in Eka: one dark strip that stays at the foot of the screen */}
      <div className="sticky bottom-3 z-20 flex flex-wrap items-center gap-2 rounded-[14px] bg-ink px-3 py-2 text-paper shadow-lg anim-fade-up">
        <button type="button" className={`${B} !px-2`} aria-label="Back" onClick={() => nav(isDoctor ? '/today' : '/queue', { viewTransition: true })}><Icon name="chevL" className="h-4 w-4" /></button>
        {!readOnly && isDoctor && <button type="button" className={B} onClick={() => clearSection('the whole pad', () => { setSyms([]); setDxs([]); setData((d) => ({ ...d, exam: {}, plan: {}, notes: {}, referral: {} })); setRx([]); setRecs(recs.filter((r) => r.kind === 'investigation' && r.status === 'done')); })}>Clear</button>}
        {missingList.length > 0 ? <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs" role="alert"><span className="font-semibold text-paper/80">Cannot finish yet · missing:</span>
            {missingList.map((x) => <button key={x.path} type="button" className="rounded-[7px] bg-rose px-2 py-0.5 font-semibold text-white hover:bg-rose/80" onClick={() => goTo(secOf(x.path))}>{x.message.replace(/ is required$/, '')}</button>)}</div>
          : <span className="text-xs text-paper/60">{savedAt ? `Saved ${savedAt}` : readOnly ? '' : 'Autosaves every 15 s'}</span>}
        <span className="ml-auto" />
        {!readOnly && !isDoctor && <button type="button" className={BP} disabled={save.isPending} onClick={() => save.mutate({ complete: false, back: true })}>Save intake &amp; return to queue</button>}
        {!readOnly && isDoctor && <>
          {can(perms, 'config.write') && <button type="button" className={B} onClick={() => nav('/settings?tab=pad')}><Icon name="print" className="h-4 w-4" />Print settings</button>}
          <button type="button" className={B} disabled={save.isPending} onClick={() => save.mutate({ complete: false })}>Save</button>
          <button type="button" className={B} onClick={() => { if (dirty.current) save.mutate({ complete: false }); openPrint({ title: 'Prescription preview', rx: id }); }}>Preview</button>
          {held && testsOpen && <button type="button" className={B} disabled={save.isPending} onClick={() => save.mutate({ complete: false, back: true })}>Keep open for the rest</button>}
          <button type="button" className={BP} disabled={save.isPending} onClick={finish}>{held ? 'Complete' : willHold ? 'Finish · hold for reports' : 'Finish prescription'}<Icon name="chevR" className="h-4 w-4" /></button>
        </>}
        {readOnly && <button type="button" className={BP} onClick={() => openPrint({ title: 'Prescription', rx: id })}><Icon name="print" className="h-4 w-4" />Print Rx</button>}
      </div>
      {viewing && <EncounterModal id={viewing} onClose={() => setViewing(null)} />}
      {capture && <PhotoCapture patient={{ id: p.id, fullName: p.fullName }} onClose={() => setCapture(false)} />}
      {compare && <PhotoCompare name={p.fullName} a={compare[0]} b={compare[1]} onClose={() => setCompare(null)} />}
    </div>
  );
}

function CompactField({ f, value, onChange, disabled, invalid }: { f: Field; value: any; onChange: (v: any) => void; disabled: boolean; invalid?: boolean }) {
  const [note, setNote] = useState(false);
  if (f.type === 'tags') {
    const v = asList(value);
    const quick = (f.options ?? []).filter((o) => !v.includes(o)).slice(0, 10);
    return <div className="flex flex-wrap items-center gap-1.5"><span className="mr-0.5 text-xs text-muted">{f.label}</span>
      {v.map((t) => <span key={t} className="toggle-opt on">{t}{!disabled && <button type="button" aria-label={`Remove ${t}`} className="ml-1" onClick={() => onChange(v.filter((x) => x !== t))}><Icon name="x" className="inline h-3 w-3" /></button>}</span>)}
      {!disabled && quick.map((o) => <button key={o} type="button" className="toggle-opt" onClick={() => onChange([...v, o])}>{o}</button>)}
      {!disabled && <SearchLine placeholder={`Add ${f.label.toLowerCase()}`} options={f.options ?? []} invalid={invalid} onAdd={(t: string) => !v.includes(t) && onChange([...v, t])} />}
    </div>;
  }
  if (f.type === 'multiselect' || f.type === 'select') {
    const multi = f.type === 'multiselect'; const v: string[] = multi ? (value ?? []) : value ? [value] : [];
    return <div className="flex flex-wrap items-center gap-1.5"><span className="mr-0.5 text-xs text-muted">{f.label}</span>{f.options!.map((o) => <button type="button" key={o} disabled={disabled} className={`toggle-opt ${v.includes(o) ? 'on' : ''}`} onClick={() => onChange(multi ? (v.includes(o) ? v.filter((x) => x !== o) : [...v, o]) : value === o ? undefined : o)}>{o}</button>)}</div>;
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
