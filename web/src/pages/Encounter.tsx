import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useNavigate, useParams, useOutletContext, useSearchParams } from 'react-router';
import { get, patch, post, qc, ApiError, errText } from '../api';
import { can } from '../App';
import { Avatar, Chip, Floating, Icon, MoreMenu, Skeleton, fmtDate, toast, NumInput, ask } from '../ui';
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
import { SkinMapPanel } from '../skinmap';

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
function Card({ id, title, meta, actions, children, required }: { id: string; title: string; meta?: ReactNode; actions?: ReactNode; children: ReactNode; required?: boolean }) {
  const [ch, color] = ICON[id] ?? ['•', '#8B929C'];
  return (
    <section id={`sec-${id}`} className="border-t border-line px-4 py-3 first:border-t-0 [#palette>&]:border-t-0">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="grid h-[22px] w-[22px] place-items-center rounded-[6px] text-[11px] font-bold text-white" style={{ background: color }} aria-hidden>{ch}</span>
        <span className="text-[13.5px] font-semibold">{title}{required && <span className="text-clay"> *</span>}</span>
        {meta && <span className="text-xs text-muted">{meta}</span>}
        {actions && <span className="ml-auto flex flex-wrap items-center gap-0.5">{actions}</span>}
      </div>
      {children}
    </section>
  );
}
const Act = ({ children, onClick, disabled, aria }: { children: ReactNode; onClick: () => void; disabled?: boolean; aria?: string }) => <button type="button" className="btn btn-ghost !min-h-7 !px-2 text-[12px] text-muted hover:text-ink" disabled={disabled} aria-label={aria} onClick={onClick}>{children}</button>;

/** Load template ▾ for one section: the sets of that kind, searchable when many. One tap adds; nothing is added twice. */
function LoadSet({ kind, sets, onPick }: { kind: TmplKind; sets: Tmpl[]; onPick: (t: Tmpl) => void }) {
  const [open, setOpen] = useState(false); const [q, setQ] = useState(''); const btn = useRef<HTMLButtonElement>(null);
  const list = sets.filter((t) => t.kind === kind && (!q || t.name.toLowerCase().includes(q.toLowerCase())));
  return (
    <>
      <button ref={btn} type="button" className="btn btn-ghost !min-h-7 !px-2 text-[12px] text-muted hover:text-ink" aria-expanded={open} onClick={() => setOpen(!open)}>Load template ▾</button>
      <Floating anchor={btn} open={open} onClose={() => setOpen(false)} width={300}>
        <div className="p-1.5">
          {sets.filter((t) => t.kind === kind).length > 6 && <input autoFocus aria-label="Search templates" className="input mb-1.5 !py-1.5" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />}
          {list.length === 0 ? <div className="px-2 py-2 text-xs text-muted">{q ? 'Nothing by that name.' : 'No templates for this section yet. Fill it and tap Save.'}</div>
            : list.slice(0, 12).map((t) => <button key={t.id} type="button" className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[13px] hover:bg-paper-2" onClick={() => { onPick(t); setOpen(false); }}><span className="min-w-0 flex-1 truncate font-medium">{t.name}</span>{t.uses > 0 && <span className="text-[11px] text-muted">{t.uses}×</span>}</button>)}
        </div>
      </Floating>
    </>
  );
}

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
  const [savedAt, setSavedAt] = useState<string>('');
  const [viewing, setViewing] = useState<string | null>(null);
  const [side, setSide] = useState<'visits' | 'docs' | 'photos'>('visits');
  const [testDraft, setTestDraft] = useState(''); const [line, setLine] = useState(''); const [pendingLine, setPendingLine] = useState<string | null>(null);
  const [applied, setApplied] = useState<string | null>(null); const undo = useRef<{ data: any; rx: RxItem[]; recs: Rec[] } | null>(null);
  const [tplOpen, setTplOpen] = useState(false); const [tplQ, setTplQ] = useState(''); const [tplSel, setTplSel] = useState<any>(null); const tplBtn = useRef<HTMLButtonElement>(null);
  const [setNote, setSetNote] = useState('');
  const [active, setActive] = useState<string | null>(null); // the section whose editor is open on the right (direction A)
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
      setErrors([]); dirty.current = false; setSavedAt(new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }));
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
  const err = (s: string, k: string) => errors.find((x) => x.path === `${s}.${k}`)?.message;
  const meds: any[] = cfg?.medicines ?? [];
  const lastRx: RxItem[] = (lastDone?.prescription ?? []).map(strip);
  const lastRaw: any[] = lastDone?.prescription ?? [];
  const isReview = isDoctor && !!lastDone && lastRx.length > 0;
  const notBought = lastRaw.filter((i) => i.medicineId && !i.issuedQty);
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
    setActive({ medicine: 'medicines', test: 'tests', diagnosis: 'diagnosis', advice: 'advice', symptom: 'symptoms' }[kind]);
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
  const finish = () => {
    const missing = [padOf('symptoms').required && !syms.length ? 'Symptoms' : null, padOf('exam').required && !Object.values(data.exam ?? {}).some((v: any) => (Array.isArray(v) ? v.length : v)) ? 'Examination' : null, padOf('medicines').required && !rx.some((i) => i.name) ? 'Medicines' : null].filter(Boolean);
    if (missing.length) return toast(`Please fill in: ${missing.join(', ')}`, 'err');
    save.mutate({ complete: true });
  };
  const clearSection = async (what: string, fn: () => void) => { const r = await ask({ title: `Clear ${what}?`, body: 'Everything in this section goes; the rest of the pad stays.', confirmLabel: 'Clear', tone: 'danger' }); if (r) fn(); };

  // --- the cards, in the clinic's order ---
  const cards: Record<string, ReactNode> = {
    vitals: <Card key="vitals" id="vitals" title="Vitals" meta="from check-in · tap to change"><VitalsCard encounterId={id!} patientId={p.id} details={e.visit?.details ?? {}} heightCm={p.history?.heightCm} readOnly={readOnly} /></Card>,
    history: null, // the chips sit under the type-anything bar
    symptoms: <Card key="symptoms" id="symptoms" title="Symptoms" required={isDoctor && padOf('symptoms').required} actions={!readOnly && isDoctor && <><LoadSet kind="symptom" sets={sets.data ?? []} onPick={(t) => setSetNote(applySet(t))} /><Act onClick={() => saveSection('symptom')}>Save</Act><Act onClick={() => clearSection('symptoms', () => setSyms([]))} disabled={!syms.length}>Clear</Act></>}>
      <div data-invalid={!!err('complaint', 'chief_complaint')}>
        {syms.map((s, i) => <div key={s.name + i} className="flex flex-wrap items-center gap-1.5 border-t border-line py-1.5 first:border-t-0 first:pt-0">
          <span className="toggle-opt on">{s.name}{!readOnly && <button type="button" aria-label={`Remove ${s.name}`} className="ml-1.5" onClick={() => setSyms(syms.filter((_, j) => j !== i))}><Icon name="x" className="inline h-3 w-3" /></button>}</span>
          <input aria-label={`${s.name}: since`} className="input !w-28 !py-1 text-[12.5px]" placeholder="since" maxLength={30} value={s.since ?? ''} disabled={readOnly} onChange={(ev) => setSyms(syms.map((x, j) => (j === i ? { ...x, since: ev.target.value } : x)))} />
          <span className="flex gap-1" role="radiogroup" aria-label={`${s.name}: severity`}>{SEVERITIES.map((sv) => <button key={sv} type="button" role="radio" aria-checked={s.severity === sv} disabled={readOnly} className={`toggle-opt !min-h-7 !py-0.5 ${s.severity === sv ? 'on' : ''}`} onClick={() => setSyms(syms.map((x, j) => (j === i ? { ...x, severity: x.severity === sv ? undefined : sv } : x)))}>{sv}</button>)}</span>
          <input aria-label={`${s.name}: note`} className="input min-w-32 flex-1 !py-1 text-[12.5px]" placeholder="note" maxLength={120} value={s.note ?? ''} disabled={readOnly} onChange={(ev) => setSyms(syms.map((x, j) => (j === i ? { ...x, note: ev.target.value } : x)))} />
        </div>)}
        {!readOnly && <div className="mt-1.5 flex flex-wrap items-center gap-1.5">{(symField?.options ?? []).filter((o: string) => !syms.some((s) => norm(s.name) === norm(o))).slice(0, 6).map((o: string) => <button key={o} type="button" className="toggle-opt" onClick={() => addSyms([{ name: o }])}>{o}</button>)}<TagDraft placeholder="symptom" invalid={!!err('complaint', 'chief_complaint')} onAdd={(t) => addSyms([{ name: t }])} /></div>}
        {err('complaint', 'chief_complaint') && <div className="mt-1 text-xs text-rose">At least one symptom is required</div>}
        {otherFields('complaint', ['chief_complaint', 'duration']).map((f: Field) => <div key={f.key} className="mt-2" data-invalid={!!err('complaint', f.key)}><CompactField f={f} value={data.complaint?.[f.key]} onChange={(v) => set('complaint', f.key, v)} disabled={readOnly} invalid={!!err('complaint', f.key)} /></div>)}
      </div></Card>,
    diagnosis: <Card key="diagnosis" id="diagnosis" title="Diagnosis" required={isDoctor} meta={isDoctor ? undefined : 'the doctor decides; leave it if unsure'} actions={!readOnly && isDoctor && <><LoadPrevious previous={previous} onLoad={loadPrevious} /><LoadSet kind="diagnosis" sets={sets.data ?? []} onPick={(t) => setSetNote(applySet(t))} /><Act onClick={() => saveSection('diagnosis')}>Save</Act><Act onClick={() => clearSection('the diagnosis', () => setDxs([]))} disabled={!dxs.length}>Clear</Act></>}>
      <div data-invalid={!!err('assessment', 'diagnosis')}>
        {dxs.map((d, i) => <div key={d.name} className="flex flex-wrap items-center gap-1.5 border-t border-line py-1.5 first:border-t-0 first:pt-0">
          <span className="chip chip-clay !py-1 !text-[12.5px]">{d.name}{!readOnly && <button type="button" aria-label={`Remove ${d.name}`} className="ml-1" onClick={() => setDxs(dxs.filter((_, j) => j !== i))}><Icon name="x" className="inline h-3 w-3" /></button>}</span>
          <span className="flex gap-1" role="radiogroup" aria-label={`${d.name}: severity`}>{SEVERITIES.map((sv) => <button key={sv} type="button" role="radio" aria-checked={d.severity === sv} disabled={readOnly} className={`toggle-opt !min-h-7 !py-0.5 ${d.severity === sv ? 'on' : ''}`} onClick={() => setDxs(dxs.map((x, j) => (j === i ? { ...x, severity: x.severity === sv ? undefined : sv } : x)))}>{sv}</button>)}</span>
          <span className="ml-1 flex gap-1" role="radiogroup" aria-label={`${d.name}: status`}>{DX_STATUS.map((st) => <button key={st} type="button" role="radio" aria-checked={d.status === st} disabled={readOnly} className={`toggle-opt !min-h-7 !py-0.5 ${d.status === st ? 'on' : ''}`} onClick={() => setDxs(dxs.map((x, j) => (j === i ? { ...x, status: x.status === st ? undefined : st } : x)))}>{st}</button>)}</span>
        </div>)}
        {!readOnly && <div className="mt-1.5 flex flex-wrap items-center gap-1.5">{(dxField?.options ?? DX_OPTIONS).filter((o: string) => !dxs.some((d) => d.name === o)).slice(0, 6).map((o: string) => <button key={o} type="button" className="toggle-opt" onClick={() => addDxs([{ name: o }])}>{o}</button>)}
          <DxDraft options={dxField?.options ?? DX_OPTIONS} invalid={!!err('assessment', 'diagnosis')} onAdd={(t) => addDxs([{ name: t }])} /></div>}
        {err('assessment', 'diagnosis') && <div className="mt-1 text-xs text-rose">Diagnosis is required</div>}
        {otherFields('assessment', []).map((f: Field) => <div key={f.key} className="mt-2"><CompactField f={f} value={data.assessment?.[f.key]} onChange={(v) => set('assessment', f.key, v)} disabled={readOnly} /></div>)}
        {applied && !readOnly && <div className="mt-2 rounded-lg bg-amber-soft px-3 py-2 text-[12.5px] text-amber anim-fade-in">Filled from <b>{applied}</b>.{p.allergies ? (allergyWarnings.length ? ` Check: ${allergyWarnings.map(([n]) => n).join(', ')} may clash with the ${p.allergies} allergy.` : ` ${p.allergies} allergy checked: no clash found.`) : ''} <button type="button" className="font-semibold underline" onClick={clearLoaded}>Clear loaded</button></div>}
      </div></Card>,
    exam: <Card key="exam" id="exam" title="Examination" required={isDoctor && padOf('exam').required} actions={!readOnly && isDoctor && <><LoadSet kind="finding" sets={sets.data ?? []} onPick={(t) => setSetNote(applySet(t))} /><Act onClick={() => saveSection('finding')}>Save</Act><Act onClick={() => clearSection('the examination', () => setData((d) => ({ ...d, exam: {} })))} disabled={!Object.keys(data.exam ?? {}).length}>Clear</Act></>}>
      <div className="mb-3 border-b border-line pb-3"><SkinMapPanel patientId={p.id} patientName={p.fullName} encounterId={id} readOnly={readOnly} defaultDx={dxs[0]?.name} onAreaAdded={(a) => set('complaint', 'site', uniq([...((data.complaint?.site ?? []) as string[]), a]))} compact /></div>
      <div className="space-y-2">{(formSections.find((s) => s.key === 'exam')?.fields ?? []).map((f: Field) => <div key={f.key} data-invalid={!!err('exam', f.key)}><CompactField f={f} value={data.exam?.[f.key]} onChange={(v) => set('exam', f.key, v)} disabled={readOnly} invalid={!!err('exam', f.key)} />{err('exam', f.key) && <div className="mt-1 text-xs text-rose">{f.label} is required</div>}</div>)}</div></Card>,
    medicines: isDoctor ? <Card key="medicines" id="medicines" title="Medicines" required={padOf('medicines').required} meta={rx.filter((i) => i.name).length ? String(rx.filter((i) => i.name).length) : undefined} actions={!readOnly && <><LoadPrevious previous={previous} onLoad={loadPrevious} /><LoadSet kind="medicine" sets={sets.data ?? []} onPick={(t) => setSetNote(applySet(t))} /><Act onClick={() => saveSection('medicine')}>Save</Act><Act onClick={() => clearSection('the medicines', () => setRx([]))} disabled={!rx.length}>Clear</Act></>}>
      <datalist id="meds">{meds.map((m: any) => <option key={m.id} value={m.name} />)}</datalist>
      <datalist id="freq">{FREQ.map((x) => <option key={x} value={x} />)}</datalist>
      <datalist id="timing">{TIMING.map((x) => <option key={x} value={x} />)}</datalist>
      {rx.filter((i) => i.name || !readOnly).length > 0 && <div className="overflow-x-auto"><div className="min-w-[760px]">
        <div className="grid grid-cols-[1.5fr_64px_92px_104px_52px_56px_1fr_80px_28px] gap-1.5 px-0.5 text-[11.5px] font-semibold text-muted"><span>Medicine</span><span>Dose</span><span>When</span><span>Timing</span><span>Days</span><span>Qty</span><span>How</span><span /><span /></div>
        {rx.map((i, k) => { const n = onHand(i); const hit = allergyHit(p.allergies, i.name); return (
          <div key={k} className="mt-1.5 grid grid-cols-[1.5fr_64px_92px_104px_52px_56px_1fr_80px_28px] items-center gap-1.5">
            <input id={`rx-${i.name}`} list="meds" aria-label="Medicine" className={`input !py-1.5 font-semibold ${hit ? '!border-rose' : ''}`} value={i.name} disabled={readOnly || i._issued} onChange={(ev) => { const m = meds.find((x: any) => x.name === ev.target.value); upd(k, { name: ev.target.value, medicineId: m?.id ?? null, ...(m ? { dose: m.defaults?.dose, route: m.defaults?.route, frequency: m.defaults?.frequency, durationDays: m.defaults?.durationDays, instructions: m.defaults?.instructions } : {}) }); }} />
            <input aria-label="Dose" className="input !py-1.5" value={i.dose ?? ''} disabled={readOnly || i._issued} onChange={(ev) => upd(k, { dose: ev.target.value })} />
            <input aria-label="When" list="freq" className="input !py-1.5" value={i.frequency ?? ''} disabled={readOnly || i._issued} onChange={(ev) => upd(k, { frequency: ev.target.value })} />
            <input aria-label="Timing" list="timing" className="input !py-1.5" placeholder="after food" value={i.timing ?? ''} disabled={readOnly || i._issued} onChange={(ev) => upd(k, { timing: ev.target.value || null })} />
            <NumInput aria-label="Days" max={365} className="input !py-1.5" value={i.durationDays ?? ''} disabled={readOnly || i._issued} onChange={(ev) => upd(k, { durationDays: ev.target.value ? Number(ev.target.value) : undefined })} />
            <NumInput aria-label="Quantity" max={9999} className="input !py-1.5" value={i.qty ?? ''} disabled={readOnly || i._issued} onChange={(ev) => upd(k, { qty: ev.target.value ? Number(ev.target.value) : null })} />
            <input aria-label="How" className="input !py-1.5" value={i.instructions ?? ''} disabled={readOnly || i._issued} onChange={(ev) => upd(k, { instructions: ev.target.value })} />
            <span className={`truncate text-[11.5px] font-semibold ${hit ? 'text-rose' : n === 0 ? 'text-amber' : 'text-muted'}`}>{hit ? `allergy: ${hit}` : n === null ? (i.name && !i.medicineId ? 'not in list' : '') : n === 0 ? 'out of stock' : `${n} in stock`}</span>
            {!readOnly && !i._issued ? <button className="btn btn-ghost btn-icon !h-8 !w-8" aria-label={`Remove ${i.name || 'line'}`} onClick={() => setRx(rx.filter((_, j) => j !== k))}><Icon name="x" className="h-3.5 w-3.5" /></button> : i._issued ? <span className="text-[11px] text-muted" title="Issued at the counter; it stays as written">issued</span> : <span />}
          </div>); })}
      </div></div>}
      {!readOnly && <div className="mt-2 flex flex-wrap items-center gap-2">
        <input aria-label="Add a medicine" className="input min-w-0 flex-1 !py-1.5" placeholder='Type a line: "itra 100 1-0-1 7d after food", Enter' value={line} onChange={(ev) => setLine(ev.target.value)} onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.preventDefault(); const it = parseRxLine(line, meds); if (it) { addRx(it); setLine(''); } } }} />
        {lastRx.length > 0 && !isReview && <button className="btn btn-sm" onClick={() => addRxMany(lastRx)}>Repeat last Rx</button>}
      </div>}
      {!readOnly && (frequent.data ?? []).filter((f: any) => !rx.some((r) => r.name === f.name)).length > 0 && <div className="mt-2 flex flex-wrap items-center gap-1.5"><span className="text-xs text-muted">Often prescribed</span>{(frequent.data ?? []).filter((f: any) => !rx.some((r) => r.name === f.name)).slice(0, 6).map((f: any) => <button key={f.name} type="button" className="toggle-opt" onClick={() => addRxByName(f.name)}>{f.name}</button>)}</div>}
      {leaflets.length > 0 && <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted"><span>Sent with the Rx on WhatsApp:</span>{leaflets.map((m: any) => <Chip key={m.id} tone="sage">{m.name}: how to use</Chip>)}</div>}
      {allergyWarnings.length > 0 && <div className="mt-2 rounded-lg bg-rose-soft px-3 py-2 text-xs text-rose">Allergy: {p.allergies}. Check {allergyWarnings.map(([n]) => n).join(', ')}.</div>}
    </Card> : null,
    advice: isDoctor ? <Card key="advice" id="advice" title="Advice" actions={!readOnly && <><LoadSet kind="advice" sets={sets.data ?? []} onPick={(t) => setSetNote(applySet(t))} /><Act onClick={() => saveSection('advice')}>Save</Act><Act onClick={() => clearSection('the advice', () => set('plan', 'advice', ''))} disabled={!adviceLines.length}>Clear</Act></>}>
      <div className="flex flex-wrap gap-1.5">{[...new Set([...adviceLines, ...ADVICE.slice(0, 6)])].map((a) => <button key={a} type="button" disabled={readOnly} className={`toggle-opt ${adviceLines.includes(a) ? 'on' : ''}`} onClick={() => toggleAdvice(a)}>{a}</button>)}</div>
      {!readOnly && <AdviceInput onAdd={(a) => !adviceLines.includes(a) && set('plan', 'advice', [...adviceLines, a].join('\n'))} />}
    </Card> : null,
    tests: isDoctor ? <Card key="tests" id="tests" title="Tests" actions={!readOnly && <><LoadSet kind="tests" sets={sets.data ?? []} onPick={(t) => setSetNote(applySet(t))} /><Act onClick={() => saveSection('tests')}>Save</Act><Act onClick={() => clearSection('the tests', () => setRecs(recs.filter((r) => r.kind !== 'investigation' || r.status === 'done')))} disabled={!tests.some((r) => r.status !== 'done')}>Clear</Act></>}>
      <div className="flex flex-wrap items-center gap-1.5">
        {tests.map((r) => <span key={r.notes} className="toggle-opt on">{r.notes}{r.status === 'done' && <span className="ml-1 font-medium">· received</span>}{orderNos.length > 1 && <span className="ml-1 font-medium text-muted">· order {r.orderNo ?? 1}</span>}{!readOnly && r.status !== 'done' && <button type="button" aria-label={(r.orderNo ?? 1) === 1 ? `Review ${r.notes} on its own` : `Review ${r.notes} with the first order`} title={(r.orderNo ?? 1) === 1 ? 'Review this test on its own, so it does not hold the others back' : 'Join the first order'} className="ml-1.5 text-[11px] font-semibold" onClick={() => toggleOrder(r)}>{(r.orderNo ?? 1) === 1 ? <Icon name="repeat" className="inline h-3 w-3" /> : <u>own order</u>}</button>}{!readOnly && r.status !== 'done' && <button type="button" aria-label={`Remove ${r.notes}`} className="ml-1" onClick={() => setRecs(recs.filter((x) => x !== r))}><Icon name="x" className="inline h-3 w-3" /></button>}</span>)}
        {!readOnly && TESTS.filter((x) => !tests.some((r) => r.notes?.toLowerCase() === x.toLowerCase())).slice(0, 6).map((x) => <button key={x} type="button" className="toggle-opt" onClick={() => addTest(x)}>{x}</button>)}
        {!readOnly && <input aria-label="Add a test" list="tests" className="input !w-40 !py-1" placeholder="Other test, Enter" value={testDraft} onChange={(ev) => (TESTS.includes(ev.target.value) ? addTest(ev.target.value) : setTestDraft(ev.target.value))} onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.preventDefault(); addTest(testDraft); } }} />}
        <datalist id="tests">{TESTS.map((x) => <option key={x} value={x} />)}</datalist>
        {orderNos.length > 1 && <div className="basis-full text-xs text-muted">{orderNos.map((o) => `Order ${o}: ${tests.filter((r) => (r.orderNo ?? 1) === o).map((r) => r.notes).join(', ')}`).join(' · ')} · each is reviewed when all its tests are in</div>}
      </div></Card> : null,
    results: isDoctor ? <Card key="results" id="results" title="Lab results" meta="typed when reports arrive"><LabResultsCard patientId={p.id} encounterId={id!} recIds={recIds} params={cfg?.labParams ?? []} readOnly={readOnly} printOut={printOut} onPrintOut={(v) => set('labs', 'printOutOfRangeOnly', v)} /></Card> : null,
    next: isDoctor ? <Card key="next" id="next" title="Next">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Review in"><span className="mr-1 text-xs text-muted">Review in</span>
          {REVIEW_IN.map(([d, l]) => <button key={l} type="button" role="radio" aria-checked={(followup?.intervalDays ?? null) === d && (d !== null || !followup)} disabled={readOnly} className={`toggle-opt ${(d === null ? !followup : followup?.intervalDays === d) ? 'on' : ''}`} onClick={() => setFollowup(d)}>{l}</button>)}
          {followup && !REVIEW_IN.some(([d]) => d === followup.intervalDays) && <span className="flex items-center gap-1 text-xs">· <NumInput aria-label="Review in days" max={365} className="input !w-16 !py-1" value={followup.intervalDays ?? ''} disabled={readOnly} onChange={(ev) => setFollowup(Number(ev.target.value) || null)} /> days</span>}
          {followup && <input aria-label="Note for the follow-up" className="input !w-56 !py-1" maxLength={120} placeholder="note for the follow-up" value={data.plan?.followupNote ?? ''} disabled={readOnly} onChange={(ev) => set('plan', 'followupNote', ev.target.value)} />}
          {followup && !readOnly && can(perms, 'appointment.write') && <button type="button" className="btn btn-sm" onClick={() => setSp({ book: '1', patient: p.id, pname: p.fullName })}>Book slot</button>}
        </div>
        <div className="flex flex-wrap items-center gap-1.5"><span className="mr-1 text-xs text-muted">Procedure</span>
          {recs.map((r, k) => r.kind !== 'procedure' ? null : (
            <span key={k} className="flex flex-wrap items-center gap-1.5 rounded-lg bg-sky-soft px-2 py-1 text-[13px]">
              <select aria-label="Procedure" className="input !w-auto !py-1" value={r.procedureId ?? ''} disabled={readOnly} onChange={(ev) => { const pr = cfg.procedures.find((x: any) => x.id === ev.target.value); setRecs(recs.map((x, j) => (j === k ? { ...x, procedureId: ev.target.value, sittings: pr?.typicalSittings } : x))); }}>{cfg?.procedures.map((pr: any) => <option key={pr.id} value={pr.id}>{pr.name}</option>)}</select>
              <NumInput aria-label="Sittings" max={50} className="input !w-14 !py-1" value={r.sittings ?? ''} disabled={readOnly} onChange={(ev) => setRecs(recs.map((x, j) => (j === k ? { ...x, sittings: Number(ev.target.value) } : x)))} /><span className="text-xs text-muted">sittings</span>
              <input aria-label="Note for the coordinator" className="input !w-44 !py-1" placeholder="note for the coordinator" value={r.notes ?? ''} disabled={readOnly} onChange={(ev) => setRecs(recs.map((x, j) => (j === k ? { ...x, notes: ev.target.value } : x)))} />
              {!readOnly && <button className="btn btn-ghost btn-icon !h-7 !w-7" aria-label="Remove procedure" onClick={() => setRecs(recs.filter((_, j) => j !== k))}><Icon name="x" className="h-3 w-3" /></button>}
            </span>))}
          {!readOnly && (cfg?.procedures ?? []).length > 0 && <button type="button" className="toggle-opt" onClick={() => setRecs([...recs, { kind: 'procedure', procedureId: cfg.procedures[0].id, sittings: cfg.procedures[0].typicalSittings }])}><Icon name="plus" className="inline h-3 w-3" /> Procedure</button>}
        </div>
      </div></Card> : null,
    notes: isDoctor ? <Card key="notes" id="notes" title="Private note" meta="never printed or sent"><textarea aria-label="Private note" className="input min-h-14" maxLength={2000} placeholder="For you and the clinic only" value={data.notes?.private ?? ''} disabled={readOnly} onChange={(ev) => set('notes', 'private', ev.target.value)} /></Card> : null,
    referral: isDoctor ? <Card key="referral" id="referral" title="Refer to" meta="printed on the prescription">
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
  // intake: the junior's cards plus Photos, since "before" pictures are taken at intake
  const order = isDoctor ? shown : [...shown.filter((k) => k !== 'photos'), ...(can(perms, 'document.write') ? ['photos'] : [])];
  // --- direction A: the note as rows on the left, one editor on the right ---
  const vd = e.visit?.details ?? {};
  const txt = (xs: (string | null | undefined | false)[]) => xs.filter(Boolean).join(' · ');
  const examFields: Field[] = formSections.find((x) => x.key === 'exam')?.fields ?? [];
  const procRecs = recs.filter((r) => r.kind === 'procedure');
  const summary: Record<string, ReactNode> = {
    vitals: txt([vd.weight_kg && `${vd.weight_kg} kg`, vd.height_cm && `${vd.height_cm} cm`, vd.bp && `BP ${vd.bp}`, vd.pulse && `pulse ${vd.pulse}`, vd.temp_f && `${vd.temp_f} °F`, vd.spo2 && `SpO₂ ${vd.spo2}`]) || null,
    symptoms: syms.length ? txt([syms.map((x) => txt([x.name, x.since && `since ${x.since}`, x.severity?.toLowerCase()])).join('; '), (data.complaint?.site ?? []).join(', ')]) : null,
    diagnosis: dxs.length ? dxs.map((d) => txt([d.name, d.severity?.toLowerCase(), d.status?.toLowerCase()])).join('; ') : null,
    exam: txt([...examFields.map((f) => { const v = data.exam?.[f.key]; return Array.isArray(v) ? v.join(', ') : v ? String(v) : null; }), (data.complaint?.site ?? []).length ? `sites: ${(data.complaint.site as string[]).join(', ')}` : null]) || null,
    medicines: rx.filter((i) => i.name).length ? <>{rx.filter((i) => i.name).map((i, n) => <div key={n}>{n + 1}. <b>{i.name}</b> <span className="text-muted">{txt([i.dose, i.frequency, i.timing, i.durationDays ? `${i.durationDays} d` : null, i._issued && 'issued'])}</span></div>)}</> : null,
    advice: adviceLines.length ? adviceLines.join(' · ') : null,
    tests: tests.length ? tests.map((r) => `${r.notes}${r.status === 'done' ? ' (in)' : ''}`).join(', ') : null,
    results: testRecs.length ? `${testsIn} of ${testRecs.length} reports in` : null,
    next: txt([followup && `Review in ${followup.intervalDays} days${data.plan?.followupNote ? ` · “${data.plan.followupNote}”` : ''}`, ...procRecs.map((r) => `${cfg?.procedures?.find((x: any) => x.id === r.procedureId)?.name ?? 'Procedure'}${r.sittings ? ` × ${r.sittings}` : ''}`)]) || null,
    notes: data.notes?.private ? String(data.notes.private).slice(0, 140) : null,
    referral: txt([data.referral?.to, data.referral?.speciality, data.referral?.reason]) || null,
    photos: ph.length ? `${ph.length} photo${ph.length === 1 ? '' : 's'}${thenNow ? ' · then and now' : ''}` : null,
    review: isReview ? txt([data.review?.response ?? 'How is it?', (data.review?.sideEffects ?? []).length ? `side effects: ${(data.review.sideEffects as string[]).join(', ')}` : null, lastRx.length ? `${lastRx.filter((l) => rx.some((r) => r.name === l.name)).length} of ${lastRx.length} continued` : null]) : null,
  };
  const LABEL: Record<string, string> = { vitals: 'Vitals', symptoms: 'Complaints', diagnosis: 'Diagnosis', exam: 'Examination', medicines: 'Medicines', advice: 'Advice', tests: 'Tests', results: 'Lab results', next: 'Next', notes: 'Private note', referral: 'Refer to', photos: 'Photos', review: 'Review' };
  const HINT: Record<string, string> = { vitals: 'From check-in · tap to add', symptoms: 'What brings them in', diagnosis: 'Required', exam: 'Findings, morphology, distribution', medicines: 'Type a line in the bar, or pick here', advice: 'Standard phrases print in Telugu', tests: 'Lab slip at the desk', results: 'Typed when reports arrive', next: 'Review, procedure', notes: 'For you and the clinic only', referral: 'Printed on the prescription', photos: 'Take or compare', review: 'How is it since last time' };
  const rowKeys = [...(isReview ? ['review'] : []), ...order.filter((k) => k !== 'history'), ...customSections.map((x: any) => x.key)];
  for (const x of customSections) { LABEL[x.key] = x.title; summary[x.key] = txt(x.fields.map((f: Field) => { const v = data[x.key]?.[f.key]; return Array.isArray(v) ? v.join(', ') : v ? String(v) : null; })) || null; }
  const firstEmpty = ['review', 'symptoms', 'diagnosis', 'medicines'].find((k) => rowKeys.includes(k) && !summary[k]);
  const act = active && rowKeys.includes(active) ? active : (firstEmpty ?? (rowKeys.includes('medicines') ? 'medicines' : rowKeys[0]));
  const isRequired = (k: string) => k === 'diagnosis' || (['symptoms', 'exam', 'medicines'].includes(k) && padOf(k).required);
  const secOf = (path: string) => ({ complaint: 'symptoms', assessment: 'diagnosis', exam: 'exam', plan: 'advice' } as Record<string, string>)[path.split('.')[0]] ?? path.split('.')[0];

  return (
    <div className="space-y-3 pb-24">
      {/* patient strip */}
      <div className="card sticky top-12 z-20 !py-2.5 anim-fade-up">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <Avatar name={p.fullName} size="h-9 w-9 text-xs" />
          <div className="min-w-0"><div className="flex flex-wrap items-center gap-1.5 text-[15px] font-semibold leading-tight">{p.fullName}<FlagChips flags={p.flags} /></div><CarefulBanner flags={p.flags} />
            <div className="text-xs text-muted">{[p.ageYears ? `${p.ageYears} ${p.sex ?? ''}` : null, p.patientNo, p.phone, visitNo === 1 ? 'first visit' : `visit ${visitNo}`, isReview ? `review of ${joinList(lastDone.data?.assessment?.diagnosis) || 'last visit'}` : null, arrivalText ? `screened: ${arrivalText}` : null].filter(Boolean).join(' · ')}</div></div>
          {p.allergies && <span className="chip chip-rose !py-1">Allergy: {p.allergies}</span>}
          {isReview && notBought.length > 0 && <span className="text-xs text-muted">Last time did not buy: {notBought.map((i) => i.name).join(', ')}</span>}
          <span className="ml-auto flex items-center gap-2 text-xs text-muted">{me.role === 'assistant' && <Chip tone="sky">Intake · doctor reviews next</Chip>}{!readOnly && isDoctor && <span title="Minutes since the consultation opened"><Icon name="clock" className="mr-1 inline h-3.5 w-3.5" />{mins} min</span>}{e.status === 'completed' && <Chip tone="sage">completed</Chip>}{held && <Chip tone="amber">Rx issued {fmtDate(e.completedAt)} · {testsIn} of {testRecs.length} reports in</Chip>}
            {isDoctor && !readOnly && <><button ref={tplBtn} type="button" className="btn btn-sm" aria-expanded={tplOpen} onClick={() => setTplOpen(!tplOpen)}><Icon name="list" className="h-3.5 w-3.5" />Templates</button>
              <Floating anchor={tplBtn} open={tplOpen} onClose={() => setTplOpen(false)} width={520}>
                <div className="grid grid-cols-[200px_minmax(0,1fr)] gap-2 p-1.5">
                  <div><input autoFocus aria-label="Search templates" className="input mb-1.5 !py-1.5" placeholder="Search" value={tplQ} onChange={(ev) => setTplQ(ev.target.value)} />
                    <div className="max-h-64 space-y-0.5 overflow-y-auto">{tplList.length === 0 ? <div className="px-2 py-2 text-xs text-muted">{tplQ ? 'No template by that name.' : 'No templates yet. Finish a note and tap Save as template.'}</div> : tplList.map((t: any) => <button key={t.id} type="button" className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] ${(tplSel ?? tplList[0])?.id === t.id ? 'bg-paper-2 font-semibold' : 'hover:bg-paper-2'}`} onClick={() => setTplSel(t)}><span className="min-w-0 flex-1 truncate">{t.name}</span>{t.uses > 0 && <span className="text-[11px] text-muted">{t.uses}×</span>}</button>)}</div></div>
                  {(tplSel ?? tplList[0]) && (() => { const t = tplSel ?? tplList[0]; return <div className="rounded-md border border-line bg-surface-2 p-2.5 text-[12.5px] leading-relaxed">
                    <div className="mb-1 flex items-center gap-2"><b className="text-[13px]">{t.name}</b><button type="button" className="btn btn-sm btn-primary ml-auto" onClick={() => applyTpl(t)}>Load</button></div>
                    {joinList(t.data?.assessment?.diagnosis) && <div><b>Dx</b> {joinList(t.data.assessment.diagnosis)}</div>}
                    <div><b>℞</b> {(t.prescription ?? []).length ? (t.prescription ?? []).map((i: any) => `${i.name}${i.frequency ? ` · ${i.frequency}` : ''}${i.durationDays ? ` · ${i.durationDays} d` : ''}`).join('; ') : '—'}</div>
                    {t.data?.plan?.advice && <div><b>Advice</b> {String(t.data.plan.advice).split('\n').filter(Boolean).join(' · ')}</div>}
                    {(t.recommendations ?? []).length > 0 && <div><b>Plan</b> {(t.recommendations ?? []).map((r: any) => r.kind === 'followup' ? `review in ${r.intervalDays} d` : r.kind === 'investigation' ? r.notes : 'procedure').join(', ')}</div>}
                    <div className="mt-1 text-[11.5px] text-muted">Loading replaces the pad; your symptoms and review answers are kept. Clear loaded undoes it.</div></div>; })()}
                </div>
              </Floating></>}</span>
        </div>
      </div>

      <div className={`grid grid-cols-1 gap-4 ${isDoctor ? (act === 'medicines' || act === 'review' ? 'xl:grid-cols-[minmax(0,1fr)_minmax(560px,46%)]' : 'xl:grid-cols-[minmax(0,1fr)_minmax(440px,38%)]') : ''}`}>
        {/* the pad */}
        <section className="card-flat min-w-0 overflow-hidden !p-0">
          {isDoctor && !readOnly && <div className="px-4 pb-2 pt-3">
            <div className="relative"><Icon name="search" className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
              <input aria-label="Type anything" className="input !pl-9 !pr-16 !py-2.5" placeholder='Type anything: "itra 100 1-0-1 7d", "itching 2 weeks", "scabies", "KOH mount" · Enter files it' value={line} onChange={(ev) => { setLine(ev.target.value); setPendingLine(null); }} onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.preventDefault(); smartAdd(line); } }} />
              <span className="kbd absolute right-3 top-1/2 -translate-y-1/2">Enter</span></div>
            {pendingLine && <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs anim-fade-in"><span className="text-muted">“{pendingLine}” is not in the lists. Add as</span>{([['symptom', 'Symptom'], ['diagnosis', 'Diagnosis'], ['medicine', 'Medicine'], ['test', 'Test'], ['advice', 'Advice']] as const).map(([k, l]) => <button key={k} type="button" className="toggle-opt !min-h-7 !py-0.5" onClick={() => smartAdd(pendingLine, k)}>{l}</button>)}<button type="button" className="btn btn-ghost !min-h-7 !px-2 text-xs" onClick={() => setPendingLine(null)}>Cancel</button></div>}
            {padOf('history').show && <div className="mt-2.5"><HistoryChips patientId={p.id} history={p.history ?? {}} categories={cfg?.historyCategories ?? []} readOnly={readOnly} /></div>}
          </div>}

          {held && <div className="mx-4 mb-2 mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-amber-soft px-3 py-2 text-[12.5px] text-amber anim-fade-in" role="status"><b>Held for reports.</b><span>Prescription issued {fmtDate(e.completedAt)}. {testsIn} of {testRecs.length} reports in{testsOpen ? `; pending: ${testRecs.filter((r: any) => r.status !== 'done').map((r: any) => `${r.notes}${r.expectedOn ? ` (expected ${fmtDate(r.expectedOn)})` : ''}`).join(', ')}` : ''}.</span>{isDoctor && <span className="text-muted">Add or change what the results call for, then Complete. Issued medicines stay as written.</span>}</div>}
          {setNote && !readOnly && <div className="mx-4 mb-2 rounded-lg bg-amber-soft px-3 py-2 text-[12.5px] text-amber anim-fade-in" role="status">{setNote}</div>}


          {!isDoctor && <>
            {(!readOnly || Object.keys(answers).length > 0 || Object.keys(hist).length > 0) && <ScreenBlock lists={lists} answers={answers} onAnswers={(a) => set('screen', 'answers', a)} history={hist} onHistory={(h) => set('screen', 'history', h)} disabled={readOnly} open />}
            <div className="border-t border-line px-4 py-3"><HistoryChips patientId={p.id} history={p.history ?? {}} categories={cfg?.historyCategories ?? []} readOnly={readOnly} /></div>
            {order.map((k) => cards[k] ?? null)}
            {customSections.map((x: any) => (
              <section key={x.key} id={`sec-${x.key}`} className="border-t border-line px-4 py-3">
                <div className="mb-2 text-[13.5px] font-semibold">{x.title}{x.fields.some((f: Field) => f.required) && <span className="text-clay"> *</span>}</div>
                <div className="space-y-2">{x.fields.map((f: Field) => <div key={f.key} data-invalid={!!err(x.key, f.key)}><CompactField f={f} value={data[x.key]?.[f.key]} onChange={(v) => set(x.key, f.key, v)} disabled={readOnly} invalid={!!err(x.key, f.key)} />{err(x.key, f.key) && <div className="mt-1 text-xs text-rose">{f.label} is required</div>}</div>)}</div>
              </section>))}
          </>}

          {/* the note as it reads: one row per section, the open one marked; tap a row to edit it on the right */}
          {isDoctor && <div className="border-t border-line">
            {rowKeys.map((k) => { const v = summary[k]; const on = act === k; const bad = errors.some((x) => secOf(x.path) === k); return (
              <button key={k} type="button" aria-current={on || undefined} className={`group grid w-full grid-cols-[128px_minmax(0,1fr)_auto] items-start gap-4 border-t border-line/70 px-5 py-3.5 text-left first:border-t-0 transition-colors ${on ? 'bg-clay-soft/40 shadow-[inset_3px_0_0_var(--color-clay)]' : 'hover:bg-surface-2'}`} onClick={() => { setActive(k); if (window.innerWidth < 1280) setTimeout(() => document.getElementById('palette')?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 30); }}>
                <span className="pt-[3px] text-[12.5px] font-semibold text-muted">{LABEL[k] ?? k}{isRequired(k) && <span className="text-clay"> *</span>}</span>
                <span className={`min-w-0 text-[15px] leading-snug ${v ? 'text-ink' : bad ? 'text-rose' : 'text-muted/70'}`}>{v ?? (bad ? `${LABEL[k]} is required` : HINT[k] ?? 'Tap to add')}</span>
                <span className={`flex items-center gap-1 pt-[3px] text-xs ${on ? 'font-semibold text-clay' : 'text-muted opacity-0 group-hover:opacity-100'}`}>{on ? 'editing' : 'edit'}<Icon name="chevR" className="h-3.5 w-3.5" /></span>
              </button>); })}
          </div>}

          {/* action bar */}
          <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-2 border-t border-line bg-surface/95 px-4 py-2.5 backdrop-blur">
            <button className="btn btn-ghost !px-2.5" aria-label="Back" onClick={() => nav(isDoctor ? '/today' : '/queue', { viewTransition: true })}><Icon name="chevL" /></button>
            {errors.length > 0 ? <button type="button" className="text-xs text-rose underline" onClick={() => { if (isDoctor) setActive(secOf(errors[0].path)); else document.querySelector('[data-invalid="true"]')?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }}>{errors.length} required field{errors.length > 1 ? 's' : ''} missing · show</button>
              : <span className="text-xs text-muted">{savedAt ? `Saved ${savedAt}` : readOnly ? '' : 'Autosaves'}{isDoctor && !readOnly ? ` · ${[padOf('symptoms').required ? 'Symptoms' : null, 'Diagnosis', padOf('exam').required ? 'Examination' : null, padOf('medicines').required ? 'Medicines' : null].filter(Boolean).join(', ')} required` : ''}</span>}
            <span className="ml-auto" />
            {!readOnly && !isDoctor && <button className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate({ complete: false, back: true })}>Save intake &amp; return to queue</button>}
            {!readOnly && isDoctor && <>
              <MoreMenu label="Save as template" items={[{ label: 'Save the whole pad as a template', onClick: askTpl }, { label: 'Save only the medicines', onClick: () => saveSection('medicine') }, { label: 'Save only the advice', onClick: () => saveSection('advice') }, { label: 'Save only the tests', onClick: () => saveSection('tests') }, { label: 'Configure pad…', onClick: () => nav('/settings?tab=pad'), hidden: !can(perms, 'config.write') }]} />
              <button className="btn" onClick={() => { if (dirty.current) save.mutate({ complete: false }); openPrint({ title: 'Prescription preview', rx: id }); }}><Icon name="print" />Preview</button>
              {held && testsOpen && <button className="btn" disabled={save.isPending} onClick={() => save.mutate({ complete: false, back: true })}>Keep open for the rest</button>}
              <button className="btn btn-primary" disabled={save.isPending} onClick={finish}>{held ? 'Complete' : willHold ? 'Finish · hold for reports' : 'Finish'}</button>
            </>}
            {readOnly && <button className="btn btn-primary" onClick={() => openPrint({ title: 'Prescription', rx: id })}><Icon name="print" />Print Rx</button>}
          </div>
        </section>

        {/* right side: the open section's editor, then the story so far */}
        {isDoctor && <aside className="flex flex-col gap-3 self-start xl:sticky xl:top-28">
          <div id="palette" className="card-flat overflow-hidden anim-fade-in" key={act}>
          {!readOnly && (sugg.length > 0 || protoSugg.length > 0) && <div className="flex flex-col gap-2 border-b border-line px-4 py-2.5" id="sec-suggest">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">Goes with it</div>
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
              {sugg.map((t) => <button key={t.id} type="button" title={`${t.name}: one tap adds it; anything already on the pad is kept once`} className={`toggle-opt ${appliedIds.includes(t.id) ? 'on' : '!border-dashed'}`} onClick={() => setSetNote(applySet(t))}>{t.name}<span className="ml-1.5 font-medium text-muted">{size(t)}</span></button>)}
              {protoSugg.map((t: any) => <button key={t.id} type="button" title="A whole protocol: medicines, advice, tests and review. Only what is missing is added." className={`toggle-opt ${appliedIds.includes(t.id) ? 'on' : '!border-dashed'}`} onClick={() => setSetNote(stackProtocol(t))}>{t.name}<span className="ml-1.5 font-medium text-muted">protocol</span></button>)}
              <span className="text-xs text-muted">· one tap each, nothing is added twice</span>
            </div>
          </div>}
            {act === 'review' ? <>
          <div className="px-4 py-3">
            <div className="flex flex-wrap items-center gap-2"><b className="text-[13.5px]">How is it since {fmtDate(lastDone.createdAt)}?</b>
              <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="How is it">{RESPONSES.map((r) => <button key={r} type="button" role="radio" aria-checked={data.review?.response === r} disabled={readOnly} className={`toggle-opt ${data.review?.response === r ? 'on' : ''}`} onClick={() => set('review', 'response', data.review?.response === r ? undefined : r)}>{r}</button>)}</div></div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5"><span className="mr-1 text-xs text-muted">Side effects</span>{SIDE_EFFECTS.map((s) => { const on = (data.review?.sideEffects ?? []).includes(s); return <button key={s} type="button" disabled={readOnly} className={`toggle-opt ${on ? 'on' : ''}`} onClick={() => { const cur: string[] = data.review?.sideEffects ?? []; set('review', 'sideEffects', s === 'None' ? (on ? [] : ['None']) : on ? cur.filter((x) => x !== s) : [...cur.filter((x) => x !== 'None'), s]); }}>{s}</button>; })}</div>
            <div className="mt-3 flex items-center gap-2"><b className="text-[13px]">Last prescription</b><span className="text-xs text-muted">{fmtDate(lastDone.createdAt)} · {joinList(lastDone.data?.assessment?.diagnosis) || 'consultation'}</span>
              {!readOnly && <button className="btn btn-sm ml-auto" onClick={() => setRx((cur) => [...cur.filter((r) => r.name && !lastRx.some((l) => l.name === r.name)), ...lastRx.map((l) => cur.find((r) => r.name === l.name) ?? withQty({ ...l }))])}>Continue all</button>}</div>
            <div className="mt-1">{lastRx.map((l, k) => {
              const cur = rx.find((r) => r.name === l.name); const st = !cur ? (rx.length ? 'stop' : '') : sameLine(cur, l) ? 'continue' : 'change';
              const raw = lastRaw[k];
              return (
                <div key={l.name + k} className="flex flex-wrap items-center gap-2 border-t border-line py-2 text-[13px] first:border-t-0">
                  <span className="min-w-0 flex-1"><b>{l.name}</b><span className="block text-xs text-muted">{[l.dose, l.frequency, l.durationDays ? `${l.durationDays} days` : null, l.instructions].filter(Boolean).join(' · ')}{raw && raw.medicineId && !raw.issuedQty ? ' · patient did not buy' : ''}</span></span>
                  {st === 'change' && cur && <span className="text-xs text-amber">now {[cur.dose, cur.frequency, cur.durationDays ? `${cur.durationDays}d` : null].filter(Boolean).join(' · ')}</span>}
                  {!readOnly && <div className="flex gap-1">
                    <button type="button" className={`toggle-opt ${st === 'continue' ? 'on' : ''}`} onClick={() => setRx((r) => cur ? r.map((x) => (x.name === l.name ? withQty({ ...l }) : x)) : [...r.filter((x) => x.name), withQty({ ...l })])}>Continue</button>
                    <button type="button" className={`toggle-opt ${st === 'change' ? 'on' : ''}`} onClick={() => { if (!cur) setRx((r) => [...r.filter((x) => x.name), withQty({ ...l })]); setTimeout(() => document.getElementById(`rx-${l.name}`)?.focus(), 50); }}>Change</button>
                    <button type="button" className={`toggle-opt ${st === 'stop' ? 'on' : ''}`} onClick={() => setRx((r) => r.filter((x) => x.name !== l.name))}>Stop</button>
                  </div>}
                </div>); })}</div>
          </div>
            </> : customSections.some((x: any) => x.key === act) ? (() => { const x = customSections.find((y: any) => y.key === act); return (
              <section className="px-4 py-3">
                <div className="mb-2 text-[13.5px] font-semibold">{x.title}{x.fields.some((f: Field) => f.required) && <span className="text-clay"> *</span>}</div>
                <div className="space-y-2">{x.fields.map((f: Field) => <div key={f.key} data-invalid={!!err(x.key, f.key)}><CompactField f={f} value={data[x.key]?.[f.key]} onChange={(v) => set(x.key, f.key, v)} disabled={readOnly} invalid={!!err(x.key, f.key)} />{err(x.key, f.key) && <div className="mt-1 text-xs text-rose">{f.label} is required</div>}</div>)}</div>
              </section>); })()
            : (cards[act] ?? cards.medicines)}
          </div>
          <div className="card-flat p-3.5">
          <div className="seg mb-2" role="tablist">{([['visits', `Story so far${previous.length ? ` · ${previous.length}` : ''}`], ['docs', `Reports${myDocs.length ? ` · ${myDocs.length}` : ''}`], ['photos', `Photos${ph.length ? ` · ${ph.length}` : ''}`]] as const).map(([k, l]) => <button key={k} role="tab" aria-selected={side === k} className={side === k ? 'on relative z-[1] !bg-surface' : ''} onClick={() => setSide(k)}>{l}</button>)}</div>
          {side === 'visits' ? (<div>
            {previous.length === 0 && <div className="text-[13px] text-muted">First visit</div>}
            {previous.slice(0, 8).map((x: any) => (
              <div key={x.id} className="-mx-1 border-t border-line px-1 py-2 text-[13px] first:border-t-0">
                <div className="flex items-center gap-2"><button type="button" className="text-xs font-semibold hover:underline" onClick={() => setViewing(x.id)}>{fmtDate(x.createdAt)}</button><span className="text-xs text-muted">{x.doctor?.name ?? ''}</span>{!readOnly && x.status === 'completed' && <button type="button" className="ml-auto text-[11.5px] font-semibold text-muted hover:text-ink" onClick={() => loadPrevious(x, { dx: true, rx: true })}>Load</button>}</div>
                <div className="truncate">{x.data?.review?.response ? `${x.data.review.response} · ` : ''}{joinList(x.data?.assessment?.diagnosis) || joinList(x.data?.complaint?.chief_complaint) || 'Consultation'}</div>
                {x.prescription?.length > 0 && <div className="truncate text-xs text-muted">{x.prescription.map((i: any) => i.name).join(', ')}</div>}
              </div>))}
          </div>) : side === 'docs' ? (<div>
            <div className="mb-2 flex items-center gap-2"><span className="text-xs text-muted">Lab reports and letters</span><span className="ml-auto" />{can(perms, 'document.write') && <UploadButton patientId={p.id} encounterId={id} label="Upload" onDone={() => qc.invalidateQueries({ queryKey: ['documents', p.id] })} />}</div>
            {myDocs.length === 0 ? <div className="text-xs text-muted">No reports yet.</div> : <DocList docs={myDocs.slice(0, 8)} />}
          </div>) : (<div>
            {thenNow && <button className="mb-2 grid w-full grid-cols-2 gap-1.5" onClick={() => setCompare(thenNow)} aria-label="Compare first and latest photo">{thenNow.map((x, k) => <span key={x.id} className="relative block aspect-square overflow-hidden rounded-lg bg-paper-2"><img src={`/api/documents/${x.id}/file`} alt={`${k ? 'Latest' : 'First'} ${x.area ?? ''}`} className="h-full w-full object-cover" /><span className="absolute bottom-1 left-1 rounded-md bg-black/55 px-1.5 text-[10px] font-semibold text-white">{fmtDate(x.takenAt)}</span></span>)}</button>}
            {!thenNow && ph.length > 0 && <div className="mb-2 grid grid-cols-3 gap-1.5">{ph.slice(0, 6).map((x) => <img key={x.id} src={`/api/documents/${x.id}/file`} alt={x.area ?? 'photo'} className="aspect-square w-full rounded-lg object-cover" />)}</div>}
            {ph.length === 0 && <div className="text-xs text-muted">No photos yet.</div>}
            {can(perms, 'document.write') && !readOnly && <button className="btn btn-sm" onClick={() => setCapture(true)}><Icon name="spark" className="h-3.5 w-3.5" />Take photo</button>}
          </div>)}
          <div className="mt-3 border-t border-line pt-3"><ScreeningCard complaintText={arrivalText} lists={lists} answers={answers} history={hist} /></div>
          </div>
        </aside>}
      </div>
      {viewing && <EncounterModal id={viewing} onClose={() => setViewing(null)} />}
      {capture && <PhotoCapture patient={{ id: p.id, fullName: p.fullName }} onClose={() => setCapture(false)} />}
      {compare && <PhotoCompare name={p.fullName} a={compare[0]} b={compare[1]} onClose={() => setCompare(null)} />}
    </div>
  );
}

function AdviceInput({ onAdd }: { onAdd: (a: string) => void }) {
  const [v, setV] = useState('');
  return <input aria-label="Other advice" className="input mt-2 !py-1.5" maxLength={200} placeholder="Other advice, press Enter" value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && v.trim()) { e.preventDefault(); onAdd(v.trim()); setV(''); } }} />;
}

function DxDraft({ options, invalid, onAdd }: { options: string[]; invalid?: boolean; onAdd: (t: string) => void }) {
  const [v, setV] = useState('');
  const add = (s: string) => { if (s.trim()) { onAdd(s.trim()); setV(''); } };
  return <><input list="dx-options" aria-label="Add a diagnosis" className={`input !w-52 !py-1 ${invalid ? '!border-rose' : ''}`} placeholder="Type a diagnosis, Enter" value={v} onChange={(e) => (options.includes(e.target.value) ? add(e.target.value) : setV(e.target.value))} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(v); } }} onBlur={() => v && add(v)} /><datalist id="dx-options">{options.map((o) => <option key={o} value={o} />)}</datalist></>;
}

/** One form field in a compact row: options as chips to tap, text only when needed. */
function CompactField({ f, value, onChange, disabled, invalid }: { f: Field; value: any; onChange: (v: any) => void; disabled: boolean; invalid?: boolean }) {
  const [note, setNote] = useState(false);
  if (f.type === 'tags') {
    const v = asList(value);
    const quick = (f.options ?? []).filter((o) => !v.includes(o)).slice(0, 10);
    return <div className="flex flex-wrap items-center gap-1.5"><span className="mr-0.5 text-xs text-muted">{f.label}</span>
      {v.map((t) => <span key={t} className="toggle-opt on">{t}{!disabled && <button type="button" aria-label={`Remove ${t}`} className="ml-1" onClick={() => onChange(v.filter((x) => x !== t))}><Icon name="x" className="inline h-3 w-3" /></button>}</span>)}
      {!disabled && quick.map((o) => <button key={o} type="button" className="toggle-opt" onClick={() => onChange([...v, o])}>{o}</button>)}
      {!disabled && <TagDraft placeholder={f.label} invalid={invalid} onAdd={(t) => !v.includes(t) && onChange([...v, t])} />}
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

function TagDraft({ placeholder, invalid, onAdd }: { placeholder: string; invalid?: boolean; onAdd: (t: string) => void }) {
  const [v, setV] = useState('');
  const add = () => { if (v.trim()) { onAdd(v.trim()); setV(''); } };
  return <input aria-label={`Add ${placeholder.toLowerCase()}`} className={`input !w-44 !py-1 ${invalid ? '!border-rose' : ''}`} placeholder={`Other ${placeholder.toLowerCase()}, Enter`} value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); } }} onBlur={add} />;
}
