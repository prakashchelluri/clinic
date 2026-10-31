import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useNavigate, useParams, useOutletContext } from 'react-router';
import { get, patch, post, qc, ApiError, errText } from '../api';
import { can } from '../App';
import { Avatar, Chip, Icon, MoreMenu, Skeleton, fmtDate, toast, NumInput, ask } from '../ui';
import { openPrint } from '../printPreview';
import { EncounterModal, DocList, UploadButton, asList, joinList } from '../encounterDetail';
import { usePhotos, PhotoCapture, PhotoCompare } from '../photos';
import { parseRxLine } from '../rxLine';
import { FlagChips, CarefulBanner } from '../flags';
import { useTemplates, suggests, norm, isSlow, uniq, type Tmpl } from '../templates';
import { ScreenBlock, ScreeningCard, checklists, complaintTexts, type Answers, type History } from '../screening';

type Field = { key: string; label: string; type: string; required?: boolean; options?: string[]; unit?: string; placeholder?: string };
type RxItem = { medicineId?: string | null; name: string; dose?: string; route?: string; frequency?: string; durationDays?: number; instructions?: string };
type Rec = { kind: 'followup' | 'procedure' | 'investigation'; procedureId?: string | null; intervalDays?: number; dueOn?: string; sittings?: number; notes?: string; orderNo?: number; status?: string; id?: string };

const FREQ = ['1-0-0', '0-0-1', '1-0-1', '1-1-1', 'at night', 'once daily', 'twice daily', 'alternate days', 'weekly', 'SOS'];
const TESTS = ['CBC', 'FBS / PPBS', 'HbA1c', 'LFT', 'RFT', 'Lipid profile', 'TSH', 'Vitamin D', 'Vitamin B12', 'Serum ferritin', 'KOH mount', 'Skin biopsy', 'Patch test', 'VDRL', 'HIV', 'HBsAg', 'ANA', 'Urine routine', 'Culture & sensitivity', 'Woods lamp'];
const ADVICE = ['Keep the area dry', "Don't share towels", 'Wash clothes in hot water', 'No steroid creams', 'Loose cotton clothes', 'Sunscreen every 3 hours', 'Moisturise twice daily', 'Avoid scrubbing', 'Avoid oily food', 'Mild soap only'];
const RESPONSES = ['Better', 'Same', 'Worse', 'New problem'];
const SIDE_EFFECTS = ['None', 'Dry lips', 'Dry skin', 'Irritation', 'Itching', 'Redness', 'Stomach upset', 'Headache'];
const REVIEW_IN: [number | null, string][] = [[7, '7d'], [14, '14d'], [30, '1 m'], [90, '3 m'], [null, 'none']];
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
const strip = ({ id, encounterId, tenantId, sortOrder, dispensed, issuedQty, notIssuedReason, createdAt, ...i }: any): RxItem => i;

/** The consultation on one page: start from a template or from the last visit, change only what differs, complete and call the next patient. */
export function Encounter() {
  const { id } = useParams(); const nav = useNavigate(); const { cfg, perms, me } = useOutletContext<any>();
  const enc = useQuery({ queryKey: ['encounter', id], queryFn: () => get(`/encounters/${id}`) });
  const timeline = useQuery({ queryKey: ['timeline', enc.data?.patientId], queryFn: () => get(`/patients/${enc.data.patientId}/timeline`), enabled: !!enc.data });
  const docs = useQuery({ queryKey: ['documents', enc.data?.patientId], queryFn: () => get(`/patients/${enc.data.patientId}/documents`), enabled: !!enc.data });
  const isDoctor = can(perms, 'encounter.complete') || can(perms, 'encounter.*');
  const tpls = useQuery({ queryKey: ['rx-templates'], queryFn: () => get('/rx-templates'), enabled: isDoctor });
  const stock = useQuery({ queryKey: ['encounters-stock'], queryFn: () => get('/encounters-stock'), enabled: isDoctor, staleTime: 60_000 });
  const fd = useQuery({ queryKey: ['frontdesk', 'today-doc'], queryFn: () => get('/frontdesk'), refetchInterval: 15000, enabled: isDoctor });
  const sets = useTemplates();
  const photos = usePhotos(enc.data?.patientId);
  const [data, setData] = useState<Record<string, any>>({});
  const [rx, setRx] = useState<RxItem[]>([]);
  const [recs, setRecs] = useState<Rec[]>([]);
  const [errors, setErrors] = useState<{ path: string; message: string }[]>([]);
  const [savedAt, setSavedAt] = useState<string>('');
  const [viewing, setViewing] = useState<string | null>(null);
  const [side, setSide] = useState<'visits' | 'docs'>('visits');
  const [testDraft, setTestDraft] = useState(''); const [rxLine, setRxLine] = useState('');
  const [applied, setApplied] = useState<string | null>(null);
  const [tplQ, setTplQ] = useState(''); const [allTpl, setAllTpl] = useState(false);
  const [setNote, setSetNote] = useState('');
  const [capture, setCapture] = useState(false); const [compare, setCompare] = useState<[any, any] | null>(null);
  const [, tick] = useState(0); useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 30000); return () => clearInterval(t); }, []);
  const loaded = useRef(false); const dirty = useRef(false);
  const previous = (timeline.data?.encounters ?? []).filter((x: any) => x.id !== id);
  const lastDone = previous.find((x: any) => x.status === 'completed');
  useEffect(() => {
    if (enc.data && timeline.data && !loaded.current) {
      // Complaints typed at arrival pre-fill the consultation so nobody types them twice; a review carries the diagnosis forward.
      const arrival: string[] = (enc.data.visit?.details?.complaints ?? []).map((c: any) => (c.duration ? `${c.text} (${c.duration})` : c.text));
      let d = { ...(enc.data.data ?? {}) };
      const hasComplaint = Array.isArray(d.complaint?.chief_complaint) ? d.complaint.chief_complaint.length : !!d.complaint?.chief_complaint;
      if (!hasComplaint && arrival.length) d = { ...d, complaint: { ...(d.complaint ?? {}), chief_complaint: arrival } };
      const hasDx = asList(d.assessment?.diagnosis).length > 0;
      if (enc.data.status !== 'completed' && !hasDx && lastDone?.data?.assessment?.diagnosis) d = { ...d, assessment: { ...(d.assessment ?? {}), diagnosis: lastDone.data.assessment.diagnosis } };
      loaded.current = true; setData(d); setRx(enc.data.prescription.map(strip));
      // Only the due date is stored; the interval is worked back from the day the consultation opened so "Review in 1 m" shows again.
      const opened = new Date(new Date(enc.data.createdAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) + 'T00:00:00Z').getTime();
      setRecs(enc.data.recommendations.map((r: any) => ({ id: r.id, status: r.status, orderNo: r.orderNo, kind: r.kind, procedureId: r.procedureId, dueOn: r.dueOn, sittings: r.sittings, notes: r.notes,
        intervalDays: r.kind === 'followup' && r.dueOn ? Math.round((new Date(r.dueOn + 'T00:00:00Z').getTime() - opened) / 86400000) : undefined })));
    }
  }, [enc.data, timeline.data]);
  const nextVisit = (fd.data?.visits ?? []).find((v: any) => (v.status === 'waiting' || v.status === 'intake') && v.id !== enc.data?.visitId && (!me.practitionerId || !v.practitionerId || v.practitionerId === me.practitionerId));
  const callNext = useMutation({ mutationFn: (visitId: string) => post(`/visits/${visitId}/encounter`), onSuccess: (e: any) => { loaded.current = false; nav(`/encounter/${e.id}`, { viewTransition: true }); }, onError: (e) => toast(errText(e), 'err') });
  const save = useMutation({
    mutationFn: ({ complete }: { complete: boolean; next?: boolean }) => patch(`/encounters/${id}`, { data, prescription: rx.filter((i) => i.name), recommendations: recs.filter((r) => r.kind !== 'investigation' || (r.notes && r.status !== 'done')), complete }),
    onSuccess: (_e, { complete, next }) => {
      setErrors([]); dirty.current = false; setSavedAt(new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }));
      ['queue', 'frontdesk', 'timeline'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      if (complete) { toast('Consultation completed'); openPrint({ title: 'Prescription', rx: id }); if (next && nextVisit) callNext.mutate(nextVisit.id); else nav(isDoctor ? '/today' : '/queue', { viewTransition: true }); }
    },
    onError: (e: any) => { if (e instanceof ApiError && e.body.code === 'FORM_INVALID') { setErrors(e.body.errors); toast(`Please fill in: ${e.body.errors.map((x: any) => x.message?.replace(/ is required$/, '') || x.path.split('.')[1]).slice(0, 3).join(', ')}`, 'err'); setTimeout(() => document.querySelector('[data-invalid="true"]')?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 80); } else toast(errText(e), 'err'); },
  });
  useEffect(() => { if (loaded.current) dirty.current = true; }, [data, rx, recs]);
  useEffect(() => { const t = setInterval(() => { if (loaded.current && dirty.current && enc.data?.status !== 'completed' && !save.isPending) save.mutate({ complete: false }); }, 15000); return () => clearInterval(t); }, [enc.data?.status, save.isPending]);
  // Signed out for being idle: save what is typed first.
  useEffect(() => { const f = () => { if (loaded.current && dirty.current && enc.data?.status !== 'completed') save.mutate({ complete: false }); }; window.addEventListener('app:save-now', f); return () => window.removeEventListener('app:save-now', f); }, [enc.data?.status]);
  // Sets linked to the complaint or diagnosis in front of the doctor: suggested as chips, or added for her when the owner chose "auto". They stack: nothing already on the note is added twice.
  const cNames = complaintTexts(enc.data?.visit?.details, data.complaint?.chief_complaint);
  const dNames = asDx(data.assessment?.diagnosis).map((d) => norm(d.name));
  const appliedIds: string[] = data.screen?.applied ?? [];
  const markApplied = (id: string) => setData((d) => ({ ...d, screen: { ...(d.screen ?? {}), applied: uniq([...(d.screen?.applied ?? []), id]) } }));
  const addTestNamed = (name: string, days?: number) => setRecs((cur) => {
    const v = name.trim(); if (!v || cur.some((r) => r.kind === 'investigation' && r.notes?.toLowerCase() === v.toLowerCase())) return cur;
    const top = Math.max(1, ...cur.filter((r) => r.kind === 'investigation').map((r) => r.orderNo ?? 1));
    return [...cur, { kind: 'investigation', notes: v, orderNo: isSlow(v) || (days ?? 0) >= 3 ? top + 1 : 1 }];
  });
  /** Adds one set to the note; returns a plain sentence about what was added and what was already there. */
  const applySet = (t: Tmpl): string => {
    const p = t.payload ?? {}; let added = 0, had = 0;
    if (t.kind === 'medicine') {
      const have = new Set(rx.filter((r) => r.name).map((r) => r.name.toLowerCase()));
      const items = (p.items ?? []).filter((i: RxItem) => (have.has(i.name.toLowerCase()) ? (had++, false) : (added++, true)));
      setRx((cur) => { const h = new Set(cur.filter((r) => r.name).map((r) => r.name.toLowerCase())); return [...cur.filter((r) => r.name), ...items.filter((i: RxItem) => !h.has(i.name.toLowerCase())).map((i: RxItem) => ({ ...i }))]; });
    } else if (t.kind === 'advice') {
      const cur = String(data.plan?.advice ?? '').split('\n').map((x) => x.trim()).filter(Boolean);
      const lines = (p.lines ?? []).filter((l: string) => (cur.includes(l) ? (had++, false) : (added++, true)));
      setData((d) => { const c = String(d.plan?.advice ?? '').split('\n').map((x) => x.trim()).filter(Boolean); return { ...d, plan: { ...(d.plan ?? {}), advice: [...c, ...lines.filter((l: string) => !c.includes(l))].join('\n') } }; });
    } else if (t.kind === 'finding') {
      const opts: string[] = enc.data?.form?.sections?.flatMap((s: any) => s.fields).find((f: Field) => f.key === 'morphology')?.options ?? [];
      const chips = (p.chips ?? []).filter((c: string) => opts.includes(c));
      const cur: string[] = data.exam?.morphology ?? [];
      chips.forEach((c: string) => (cur.includes(c) ? had++ : added++));
      setData((d) => ({ ...d, exam: { ...(d.exam ?? {}), morphology: uniq([...(d.exam?.morphology ?? []), ...chips]) } }));
    } else if (t.kind === 'tests') {
      for (const x of p.tests ?? []) { if (recs.some((r) => r.kind === 'investigation' && r.notes?.toLowerCase() === x.name.toLowerCase())) had++; else added++; addTestNamed(x.name, x.days); }
    } else if (t.kind === 'procedure') {
      if (recs.some((r) => r.kind === 'procedure' && r.procedureId === p.procedureId)) had++; else { added++; setRecs((cur) => (cur.some((r) => r.kind === 'procedure' && r.procedureId === p.procedureId) ? cur : [...cur, { kind: 'procedure', procedureId: p.procedureId, sittings: p.sittings, notes: p.intervalDays ? `every ${p.intervalDays} days` : undefined }])); }
    }
    markApplied(t.id);
    return `${t.name}: ${added ? `added ${added}` : 'nothing new'}${had ? `, ${had} already there` : ''}.`;
  };
  // a whole-note protocol, stacked: only what is missing is added; her own diagnosis, medicines and plan stay as they are
  const stackProtocol = (t: any): string => {
    const have = new Set(rx.filter((r) => r.name).map((r) => r.name.toLowerCase()));
    const meds: RxItem[] = (t.prescription ?? []).filter((i: RxItem) => !have.has(i.name.toLowerCase()));
    setRx((cur) => { const h = new Set(cur.filter((r) => r.name).map((r) => r.name.toLowerCase())); return [...cur.filter((r) => r.name), ...meds.filter((i) => !h.has(i.name.toLowerCase())).map((i) => ({ ...i }))]; });
    setData((d) => {
      const td = t.data ?? {}; const adv = (x: any) => String(x ?? '').split('\n').map((y) => y.trim()).filter(Boolean);
      return { ...d, exam: { ...(d.exam ?? {}), ...(td.exam?.morphology ? { morphology: uniq([...(d.exam?.morphology ?? []), ...td.exam.morphology]) } : {}) },
        assessment: { ...(d.assessment ?? {}), ...(asDx(d.assessment?.diagnosis).length ? {} : td.assessment ?? {}) },
        plan: { ...(d.plan ?? {}), advice: uniq([...adv(d.plan?.advice), ...adv(td.plan?.advice)]).join('\n') } };
    });
    setRecs((cur) => [...cur, ...(t.recommendations ?? []).filter((r: Rec) => !cur.some((c) => c.kind === r.kind && (r.kind === 'followup' || c.procedureId === r.procedureId && c.notes === r.notes))).map((r: Rec) => ({ ...r }))]);
    markApplied(t.id);
    return `${t.name}: added ${meds.length} medicine${meds.length === 1 ? '' : 's'}${(t.prescription?.length ?? 0) - meds.length ? `, ${(t.prescription.length) - meds.length} already there` : ''}.`;
  };
  const autoKey = (sets.data ?? []).filter((t) => t.mode === 'auto' && !appliedIds.includes(t.id) && suggests(t, cNames, dNames)).map((t) => t.id).join(',');
  useEffect(() => {
    if (!loaded.current || !isDoctor || enc.data?.status === 'completed' || !autoKey) return;
    const notes = (sets.data ?? []).filter((t) => autoKey.split(',').includes(t.id)).map(applySet);
    if (notes.length) setSetNote(notes.join(' '));
  }, [autoKey, enc.data?.status, isDoctor]);
  const saveSection = async (kind: 'medicine' | 'advice' | 'tests') => {
    const payload = kind === 'medicine' ? { items: rx.filter((i) => i.name).map(strip) } : kind === 'advice' ? { lines: String(data.plan?.advice ?? '').split('\n').map((x) => x.trim()).filter(Boolean) }
      : { tests: recs.filter((r) => r.kind === 'investigation' && r.notes).map((r) => ({ name: r.notes! })) };
    if (!Object.values(payload)[0].length) return toast(`There is nothing to save yet: no ${kind === 'medicine' ? 'medicines' : kind === 'advice' ? 'advice' : 'tests'}.`, 'info');
    const r = await ask({ title: `Save the ${kind === 'medicine' ? 'medicines' : kind === 'advice' ? 'advice' : 'tests'} as a set`, body: 'It is suggested the next time the same complaint or diagnosis comes up.', confirmLabel: 'Save', field: { label: 'Name of the set', required: true, initial: asDx(data.assessment?.diagnosis).map((d) => d.name).join(' + ') || '', maxLength: 80 } });
    if (!r?.value || r.value.trim().length < 2) return;
    try { const row: any = await post('/templates', { kind, name: r.value.trim(), linked: { complaints: cNames, diagnoses: dNames }, payload }); qc.invalidateQueries({ queryKey: ['templates'] }); toast(row.draft ? `Saved. The owner approves it before it is suggested.` : `Saved as a set`); } catch (e) { toast(errText(e), 'err'); }
  };
  const saveTpl = useMutation({ mutationFn: (name: string) => post('/rx-templates', { name, data, prescription: rx.filter((i) => i.name), recommendations: recs }), onSuccess: (r: any) => { qc.invalidateQueries({ queryKey: ['rx-templates'] }); toast(`Saved as template “${r.name}”`); }, onError: (e) => toast(errText(e), 'err') });

  if (!enc.data || !timeline.data) return <div className="card"><Skeleton rows={5} /></div>;
  const e = enc.data; const p = e.patient; const readOnly = e.status === 'completed';
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
  const addRx = (item: RxItem) => setRx((cur) => [...cur.filter((r) => r.name), item]);
  const addRxByName = (name: string) => { const m = meds.find((x: any) => x.name === name); addRx({ name, medicineId: m?.id ?? null, dose: m?.defaults?.dose, route: m?.defaults?.route, frequency: m?.defaults?.frequency, durationDays: m?.defaults?.durationDays, instructions: m?.defaults?.instructions }); };
  const applyTpl = (t: any) => {
    const keep = data.review ? { review: data.review } : {};
    setData({ ...t.data, ...keep, complaint: { ...(t.data.complaint ?? {}), ...(asList(data.complaint?.chief_complaint).length ? { chief_complaint: data.complaint.chief_complaint } : {}) } });
    setRx(t.prescription.map((i: any) => ({ ...i }))); setRecs(t.recommendations.map((r: any) => ({ ...r })));
    setApplied(t.name); post(`/rx-templates/${t.id}/use`).then(() => qc.invalidateQueries({ queryKey: ['rx-templates'] }), () => {});
  };
  const askTpl = async () => {
    const r = await ask({ title: 'Save as template', body: 'Saves the complaint, findings, diagnosis, medicines, advice and plan. Using the same name again updates it.', confirmLabel: 'Save', field: { label: 'Template name', required: true, initial: asDx(data.assessment?.diagnosis).map((d) => `${d.name}${d.severity ? ` · ${d.severity.toLowerCase()}` : ''}`).join(' + ') || '', maxLength: 80 } });
    if (r?.value && r.value.trim().length >= 2) saveTpl.mutate(r.value.trim());
  };
  const allergyWarnings = rx.filter((i) => i.name).map((i) => [i.name, allergyHit(p.allergies, i.name)] as const).filter(([, w]) => w);
  const followup = recs.find((r) => r.kind === 'followup');
  const setFollowup = (d: number | null) => setRecs([...recs.filter((r) => r.kind !== 'followup'), ...(d ? [{ kind: 'followup' as const, intervalDays: d }] : [])]);
  const addTest = (name: string) => { setTestDraft(''); addTestNamed(name); };
  const tests = recs.filter((r) => r.kind === 'investigation' && r.notes);
  const adviceText: string = data.plan?.advice ?? '';
  const adviceLines = adviceText.split('\n').map((x) => x.trim()).filter(Boolean);
  const toggleAdvice = (a: string) => set('plan', 'advice', (adviceLines.includes(a) ? adviceLines.filter((x) => x !== a) : [...adviceLines, a]).join('\n'));
  const sections = e.form.sections.filter((x: any) => !(isDoctor && x.key === 'plan'));
  const formHasDx = e.form.sections.some((s: any) => s.fields.some((f: Field) => f.type === 'diagnoses'));
  const tplList: any[] = (tpls.data ?? []).filter((t: any) => !tplQ || t.name.toLowerCase().includes(tplQ.toLowerCase()));
  const ph: any[] = photos.data?.photos ?? [];
  const lastArea = ph[0]?.area; const sameArea = ph.filter((x) => x.area === lastArea);
  const thenNow: [any, any] | null = sameArea.length >= 2 ? [sameArea[sameArea.length - 1], sameArea[0]] : null;
  const myDocs = docs.data ?? [];
  const label = (s: any) => (s.title === 'Assessment' ? 'Diagnosis' : s.key === 'exam' ? 'Found' : s.title);
  const lists = checklists(cNames, sets.data ?? []);
  const answers: Answers = data.screen?.answers ?? {}; const hist: History = data.screen?.history ?? p.history ?? {};
  const arrivalText = ((e.visit?.details?.complaints ?? []) as { text: string; duration?: string }[]).map((c) => (c.duration ? `${c.text} · ${c.duration}` : c.text)).join(', ');
  const sugg = (sets.data ?? []).filter((t) => t.kind !== 'complaint' && suggests(t, cNames, dNames));
  const protoSugg = (tpls.data ?? []).filter((t: any) => suggests(t, cNames, dNames));
  const size = (t: Tmpl) => (t.kind === 'medicine' ? t.payload.items?.length : t.kind === 'advice' ? t.payload.lines?.length : t.kind === 'finding' ? t.payload.chips?.length : t.kind === 'tests' ? t.payload.tests?.length : 1);
  const orderNos = uniq(tests.map((r) => r.orderNo ?? 1)).sort((a, b) => a - b);
  const toggleOrder = (r: Rec) => setRecs(recs.map((x) => (x === r ? { ...x, orderNo: (r.orderNo ?? 1) === 1 ? Math.max(1, ...tests.map((t) => t.orderNo ?? 1)) + 1 : 1 } : x)));

  return (
    <div className="space-y-4 pb-24">
      {/* patient strip */}
      <div className="sticky top-0 z-20 card !p-3 anim-fade-up !bg-[#FBFAF7]" style={{ boxShadow: 'var(--shadow-lift)' }}>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Avatar name={p.fullName} size="h-10 w-10 text-sm" />
          <div className="min-w-0"><div className="flex flex-wrap items-center gap-1.5 text-[17px] font-semibold leading-tight">{p.fullName}<FlagChips flags={p.flags} /></div><CarefulBanner flags={p.flags} />
            <div className="text-xs text-muted">{[p.ageYears ? `${p.ageYears} ${p.sex ?? ''}` : null, p.patientNo, visitNo === 1 ? 'first visit' : `visit ${visitNo}`, isReview ? `review of ${joinList(lastDone.data?.assessment?.diagnosis) || 'last visit'}` : null].filter(Boolean).join(' · ')}</div></div>
          {p.allergies && <span className="chip chip-rose !text-xs">Allergy: {p.allergies}</span>}
          <div className="flex flex-wrap gap-1.5">{(() => { const d = e.visit?.details ?? {}; return [['BP', d.bp, ''], ['Wt', d.weight_kg, ' kg'], ['Temp', d.temp_f, '°F'], ['SpO₂', d.spo2, '%']].filter((x) => x[1] !== undefined && x[1] !== null && x[1] !== '').map((x) => <span key={x[0] as string} className="chip !text-xs">{x[0]} {x[1]}{x[2]}</span>); })()}</div>
          {isReview && notBought.length > 0 && <span className="text-xs text-muted">Last time did not buy: {notBought.map((i) => i.name).join(', ')}</span>}
          <span className="ml-auto flex items-center gap-3 text-xs text-muted">{me.role === 'assistant' && <Chip tone="sky">Intake · doctor reviews next</Chip>}{!readOnly && isDoctor && <span title="Minutes since the consultation opened"><Icon name="clock" className="mr-1 inline h-3.5 w-3.5" />{mins} min</span>}{readOnly && <Chip tone="sage">completed</Chip>}</span>
        </div>
      </div>

      <div className={`grid grid-cols-1 gap-4 ${isDoctor ? 'lg:grid-cols-[250px_minmax(0,1fr)] xl:grid-cols-[250px_minmax(0,1fr)_300px]' : 'lg:grid-cols-[minmax(0,1fr)_300px]'}`}>
        {/* left: templates and photos */}
        {isDoctor && <aside className="space-y-4 lg:sticky lg:top-24 self-start">
          <ScreeningCard complaintText={arrivalText} lists={lists} answers={answers} history={hist} />
          {!readOnly && <div className="card-flat p-3.5">
            <div className="text-[11px] font-bold uppercase tracking-wider text-muted">Start from</div>
            <div className="mb-2 mt-0.5 text-xs text-muted">One tap fills every row. Change only what differs.</div>
            {(tpls.data ?? []).length > 6 && <input aria-label="Search templates" className="input mb-2 !py-1.5 text-sm" placeholder="Search templates" value={tplQ} onChange={(ev) => setTplQ(ev.target.value)} />}
            {tpls.isLoading ? <Skeleton rows={3} /> : tplList.length === 0 ? <div className="text-xs text-muted">{tplQ ? 'No template by that name.' : 'No templates yet. Finish a note and tap “Save as template”.'}</div> : (
              <div className="flex flex-col gap-1.5">{(allTpl || tplQ ? tplList : tplList.slice(0, 6)).map((t: any) => (
                <button key={t.id} type="button" onClick={() => applyTpl(t)} className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-left text-[13px] font-semibold ${applied === t.name ? 'border-sage bg-sage-soft text-sage' : 'border-line bg-white/70 hover:bg-white'}`}>
                  <span className="min-w-0 flex-1 truncate">{t.name}</span>{t.uses > 0 && <span className="text-[11px] font-medium text-muted">{t.uses}×</span>}</button>))}
                {!allTpl && !tplQ && tplList.length > 6 && <button className="text-left text-xs font-semibold underline" onClick={() => setAllTpl(true)}>All {tplList.length}</button>}</div>)}
          </div>}
          <div className="card-flat p-3.5">
            <div className="flex items-center"><span className="text-[11px] font-bold uppercase tracking-wider text-muted">{thenNow ? 'Then and now' : 'Photos'}</span>{lastArea && <span className="ml-auto text-xs text-muted">{lastArea}</span>}</div>
            {thenNow ? <button className="mt-2 grid w-full grid-cols-2 gap-1.5" onClick={() => setCompare(thenNow)} aria-label="Compare first and latest photo">{thenNow.map((x, k) => <span key={x.id} className="relative block aspect-square overflow-hidden rounded-xl bg-paper"><img src={`/api/documents/${x.id}/file`} alt={`${k ? 'Latest' : 'First'} ${x.area ?? ''}`} className="h-full w-full object-cover" /><span className="absolute bottom-1 left-1 rounded-full bg-black/55 px-1.5 text-[10px] font-semibold text-white">{fmtDate(x.takenAt)}</span></span>)}</button>
              : ph.length ? <div className="mt-2 flex gap-1.5">{ph.slice(0, 3).map((x) => <img key={x.id} src={`/api/documents/${x.id}/file`} alt={x.area ?? 'photo'} className="h-16 w-16 rounded-xl object-cover" />)}</div>
              : <div className="mt-1 text-xs text-muted">No photos yet.</div>}
            {can(perms, 'document.write') && !readOnly && <button className="btn btn-sm mt-2" onClick={() => setCapture(true)}><Icon name="spark" className="h-3.5 w-3.5" />Take photo</button>}
          </div>
        </aside>}

        {/* the note */}
        <section className="card-flat min-w-0 overflow-hidden !p-0">
          {applied && !readOnly && <div className="mx-4 mt-3 rounded-xl bg-[#FFF6DD] px-3 py-2 text-[12.5px] text-[#6E4D10] anim-fade-in">Filled from <b>{applied}</b>.{p.allergies ? (allergyWarnings.length ? ` Check: ${allergyWarnings.map(([n]) => n).join(', ')} may clash with the ${p.allergies} allergy.` : ` ${p.allergies} allergy checked: no clash found.`) : ''} Change anything below.</div>}

          {setNote && !readOnly && <div className="mx-4 mt-3 rounded-xl bg-[#FFF6DD] px-3 py-2 text-[12.5px] text-[#6E4D10] anim-fade-in" role="status">{setNote}</div>}
          {isDoctor && !readOnly && (sugg.length > 0 || protoSugg.length > 0) && <div className="flex flex-col gap-2 border-b border-line/70 px-4 py-3 sm:flex-row sm:gap-3" id="sec-suggest">
            <div className="w-24 shrink-0 pt-1 text-xs font-bold text-muted">Suggested</div>
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
              {sugg.map((t) => <button key={t.id} type="button" title={`${t.name}: one tap adds it; anything already on the note is kept once`} className={`toggle-opt !py-1.5 ${appliedIds.includes(t.id) ? 'on' : '!border-dashed !border-ink/25'}`} onClick={() => { setSetNote(applySet(t)); post(`/templates/${t.id}/use`).catch(() => {}); }}>{t.name}<span className="ml-1.5 font-medium text-muted">{size(t)}</span></button>)}
              {protoSugg.map((t: any) => <button key={t.id} type="button" title="A whole protocol: medicines, advice, tests and review. Only what is missing is added." className={`toggle-opt !py-1.5 ${appliedIds.includes(t.id) ? 'on' : '!border-dashed !border-ink/25'}`} onClick={() => { setSetNote(stackProtocol(t)); post(`/rx-templates/${t.id}/use`).catch(() => {}); }}>{t.name}<span className="ml-1.5 font-medium text-muted">protocol</span></button>)}
              <span className="text-xs text-muted">· one tap each, nothing is added twice</span>
            </div>
          </div>}

          {isReview && <div className="border-b border-line/70 px-4 py-3.5">
            <div className="flex flex-wrap items-center gap-2"><b className="text-[15px]">How is it since {fmtDate(lastDone.createdAt)}?</b>
              <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="How is it">{RESPONSES.map((r) => <button key={r} type="button" role="radio" aria-checked={data.review?.response === r} disabled={readOnly} className={`toggle-opt ${data.review?.response === r ? 'on' : ''}`} onClick={() => set('review', 'response', data.review?.response === r ? undefined : r)}>{r}</button>)}</div></div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5"><span className="mr-1 text-xs text-muted">Side effects</span>{SIDE_EFFECTS.map((s) => { const on = (data.review?.sideEffects ?? []).includes(s); return <button key={s} type="button" disabled={readOnly} className={`toggle-opt !py-1 ${on ? 'on' : ''}`} onClick={() => { const cur: string[] = data.review?.sideEffects ?? []; set('review', 'sideEffects', s === 'None' ? (on ? [] : ['None']) : on ? cur.filter((x) => x !== s) : [...cur.filter((x) => x !== 'None'), s]); }}>{s}</button>; })}</div>
            <div className="mt-3 flex items-center gap-2"><b className="text-sm">Last prescription</b><span className="text-xs text-muted">{fmtDate(lastDone.createdAt)} · {joinList(lastDone.data?.assessment?.diagnosis) || 'consultation'}</span>
              {!readOnly && <button className="btn btn-sm ml-auto" onClick={() => setRx((cur) => [...cur.filter((r) => r.name && !lastRx.some((l) => l.name === r.name)), ...lastRx.map((l) => cur.find((r) => r.name === l.name) ?? { ...l })])}>Continue all</button>}</div>
            <div className="mt-1">{lastRx.map((l, k) => {
              const cur = rx.find((r) => r.name === l.name); const st = !cur ? (rx.length ? 'stop' : '') : sameLine(cur, l) ? 'continue' : 'change';
              const raw = lastRaw[k];
              return (
                <div key={l.name + k} className="flex flex-wrap items-center gap-2 border-t border-line/60 py-2 text-sm first:border-t-0">
                  <span className="min-w-0 flex-1"><b>{l.name}</b><span className="block text-xs text-muted">{[l.dose, l.frequency, l.durationDays ? `${l.durationDays} days` : null, l.instructions].filter(Boolean).join(' · ')}{raw && raw.medicineId && !raw.issuedQty ? ' · patient did not buy' : ''}</span></span>
                  {st === 'change' && cur && <span className="text-xs text-amber">now {[cur.dose, cur.frequency, cur.durationDays ? `${cur.durationDays}d` : null].filter(Boolean).join(' · ')}</span>}
                  {!readOnly && <div className="flex gap-1">
                    <button type="button" className={`toggle-opt !py-1 ${st === 'continue' ? 'on' : ''}`} onClick={() => setRx((r) => cur ? r.map((x) => (x.name === l.name ? { ...l } : x)) : [...r.filter((x) => x.name), { ...l }])}>Continue</button>
                    <button type="button" className={`toggle-opt !py-1 ${st === 'change' ? 'on' : ''}`} onClick={() => { if (!cur) setRx((r) => [...r.filter((x) => x.name), { ...l }]); setTimeout(() => document.getElementById(`rx-${l.name}`)?.focus(), 50); }}>Change</button>
                    <button type="button" className={`toggle-opt !py-1 ${st === 'stop' ? 'on' : ''}`} onClick={() => setRx((r) => r.filter((x) => x.name !== l.name))}>Stop</button>
                  </div>}
                </div>); })}</div>
          </div>}

          {(!readOnly || Object.keys(answers).length > 0 || Object.keys(hist).length > 0) && <ScreenBlock lists={lists} answers={answers} onAnswers={(a) => set('screen', 'answers', a)} history={hist} onHistory={(h) => set('screen', 'history', h)} disabled={readOnly} open={!isDoctor ? true : undefined} />}

          {sections.map((s: any) => (
            <div key={s.key} id={`sec-${s.key}`} className="flex flex-col gap-2 border-b border-line/70 px-4 py-3 sm:flex-row sm:gap-3">
              <div className="w-24 shrink-0 pt-1 text-xs font-bold text-muted">{label(s)}{s.fields.some((f: Field) => f.required) && <span className="text-clay"> *</span>}</div>
              <div className="min-w-0 flex-1 space-y-2">{s.fields.map((f: Field) => (
                <div key={f.key} data-invalid={!!err(s.key, f.key)}>
                  <CompactField f={f} value={data[s.key]?.[f.key]} onChange={(v) => set(s.key, f.key, v)} disabled={readOnly} invalid={!!err(s.key, f.key)} />
                  {err(s.key, f.key) && <div className="mt-1 text-xs text-rose">{f.label} is required</div>}
                </div>))}</div>
            </div>))}

          {/* Diagnosis is what templates, reviews and reports hang on, so it shows even when a clinic's edited form left it out. */}
          {isDoctor && !formHasDx && <div className="flex flex-col gap-2 border-b border-line/70 px-4 py-3 sm:flex-row sm:gap-3">
            <div className="w-24 shrink-0 pt-1 text-xs font-bold text-muted">Diagnosis</div>
            <div className="min-w-0 flex-1"><CompactField f={{ key: 'diagnosis', label: 'Diagnosis', type: 'diagnoses', placeholder: 'Type a diagnosis, press Enter', options: DX_OPTIONS }} value={data.assessment?.diagnosis} onChange={(v) => set('assessment', 'diagnosis', v)} disabled={readOnly} /></div>
          </div>}

          {isDoctor && <>
            <div id="sec-rx" className="flex flex-col gap-2 border-b border-line/70 px-4 py-3 sm:flex-row sm:gap-3">
              <div className="w-24 shrink-0 pt-1 text-xs font-bold text-muted">Medicines</div>
              <div className="min-w-0 flex-1">
                <datalist id="meds">{meds.map((m: any) => <option key={m.id} value={m.name} />)}</datalist>
                <datalist id="freq">{FREQ.map((x) => <option key={x} value={x} />)}</datalist>
                {rx.filter((i) => i.name || !readOnly).length > 0 && <div className="overflow-x-auto"><div className="min-w-[620px]">
                  <div className="grid grid-cols-[1.5fr_72px_100px_56px_1fr_70px_28px] gap-1.5 px-0.5 text-[11px] uppercase tracking-wider text-muted"><span>Medicine</span><span>Dose</span><span>When</span><span>Days</span><span>How</span><span /><span /></div>
                  {rx.map((i, k) => { const n = onHand(i); const hit = allergyHit(p.allergies, i.name); const upd = (patchI: Partial<RxItem>) => setRx(rx.map((r, j) => (j === k ? { ...r, ...patchI } : r))); return (
                    <div key={k} className="mt-1.5 grid grid-cols-[1.5fr_72px_100px_56px_1fr_70px_28px] items-center gap-1.5">
                      <input id={`rx-${i.name}`} list="meds" aria-label="Medicine" className={`input !py-1.5 text-sm font-semibold ${hit ? '!border-rose' : ''}`} value={i.name} disabled={readOnly} onChange={(ev) => { const m = meds.find((x: any) => x.name === ev.target.value); upd({ name: ev.target.value, medicineId: m?.id ?? null, ...(m ? { dose: m.defaults?.dose, route: m.defaults?.route, frequency: m.defaults?.frequency, durationDays: m.defaults?.durationDays, instructions: m.defaults?.instructions } : {}) }); }} />
                      <input aria-label="Dose" className="input !py-1.5 text-sm" value={i.dose ?? ''} disabled={readOnly} onChange={(ev) => upd({ dose: ev.target.value })} />
                      <input aria-label="When" list="freq" className="input !py-1.5 text-sm" value={i.frequency ?? ''} disabled={readOnly} onChange={(ev) => upd({ frequency: ev.target.value })} />
                      <NumInput aria-label="Days" max={365} className="input !py-1.5 text-sm" value={i.durationDays ?? ''} disabled={readOnly} onChange={(ev) => upd({ durationDays: ev.target.value ? Number(ev.target.value) : undefined })} />
                      <input aria-label="How" className="input !py-1.5 text-sm" value={i.instructions ?? ''} disabled={readOnly} onChange={(ev) => upd({ instructions: ev.target.value })} />
                      <span className={`text-[11px] font-semibold ${hit ? 'text-rose' : n === 0 ? 'text-amber' : 'text-muted'}`}>{hit ? `allergy: ${hit}` : n === null ? (i.name && !i.medicineId ? 'not in list' : '') : n === 0 ? 'out of stock' : 'in stock'}</span>
                      {!readOnly ? <button className="btn btn-ghost btn-icon !h-8 !w-8" aria-label={`Remove ${i.name || 'line'}`} onClick={() => setRx(rx.filter((_, j) => j !== k))}><Icon name="x" className="h-3.5 w-3.5" /></button> : <span />}
                    </div>); })}
                </div></div>}
                {!readOnly && <div className="mt-2 flex flex-wrap items-center gap-2">
                  <input aria-label="Add a medicine" className="input min-w-0 flex-1 !py-1.5 text-sm" placeholder='Type a line: "itra 100 1-0-1 7d after food", press Enter' value={rxLine}
                    onChange={(ev) => setRxLine(ev.target.value)} onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.preventDefault(); const it = parseRxLine(rxLine, meds); if (it) { addRx(it); setRxLine(''); } } }} />
                  {rxLine && (() => { const it = parseRxLine(rxLine, meds); return it ? <span className="text-xs text-muted">→ <b className="text-ink">{it.name}</b>{it.frequency ? ` · ${it.frequency}` : ''}{it.durationDays ? ` · ${it.durationDays} days` : ''}{it.medicineId ? '' : ' (not in the medicine list)'}</span> : null; })()}
                  {lastRx.length > 0 && !isReview && <button className="btn btn-sm" onClick={() => setRx(lastRx.map((x) => ({ ...x })))}>Repeat last Rx</button>}
                </div>}
                {allergyWarnings.length > 0 && <div className="mt-2 rounded-xl bg-rose-soft px-3 py-2 text-xs text-rose">Allergy: {p.allergies}. Check {allergyWarnings.map(([n]) => n).join(', ')}.</div>}
              </div>
            </div>

            <div className="flex flex-col gap-2 border-b border-line/70 px-4 py-3 sm:flex-row sm:gap-3">
              <div className="w-24 shrink-0 pt-1 text-xs font-bold text-muted">Advice</div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap gap-1.5">{[...new Set([...ADVICE, ...adviceLines])].map((a) => <button key={a} type="button" disabled={readOnly} className={`toggle-opt !py-1 ${adviceLines.includes(a) ? 'on' : ''}`} onClick={() => toggleAdvice(a)}>{a}</button>)}</div>
                {!readOnly && <AdviceInput onAdd={(a) => !adviceLines.includes(a) && set('plan', 'advice', [...adviceLines, a].join('\n'))} />}
              </div>
            </div>

            <div id="sec-recs" className="flex flex-col gap-2 border-b border-line/70 px-4 py-3 sm:flex-row sm:gap-3">
              <div className="w-24 shrink-0 pt-1 text-xs font-bold text-muted">Next</div>
              <div className="min-w-0 flex-1 space-y-2.5">
                <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Review in"><span className="mr-1 text-xs text-muted">Review in</span>
                  {REVIEW_IN.map(([d, l]) => <button key={l} type="button" role="radio" aria-checked={(followup?.intervalDays ?? null) === d && (d !== null || !followup)} disabled={readOnly} className={`toggle-opt !py-1 ${(d === null ? !followup : followup?.intervalDays === d) ? 'on' : ''}`} onClick={() => setFollowup(d)}>{l}</button>)}
                  {followup && !REVIEW_IN.some(([d]) => d === followup.intervalDays) && <span className="flex items-center gap-1 text-xs">· <NumInput aria-label="Review in days" max={365} className="input !w-16 !py-1" value={followup.intervalDays ?? ''} disabled={readOnly} onChange={(ev) => setFollowup(Number(ev.target.value) || null)} /> days</span>}
                </div>
                <div className="flex flex-wrap items-center gap-1.5"><span className="mr-1 text-xs text-muted">Tests</span>
                  {tests.map((r) => <span key={r.notes} className="toggle-opt on !py-1">{r.notes}{r.status === 'done' && <span className="ml-1 font-medium">· received</span>}{orderNos.length > 1 && <span className="ml-1 font-medium text-muted">· order {r.orderNo ?? 1}</span>}{!readOnly && r.status !== 'done' && <button type="button" aria-label={(r.orderNo ?? 1) === 1 ? `Review ${r.notes} on its own` : `Review ${r.notes} with the first order`} title={(r.orderNo ?? 1) === 1 ? 'Review this test on its own, so it does not hold the others back' : 'Join the first order'} className="ml-1.5 text-[11px] font-semibold" onClick={() => toggleOrder(r)}>{(r.orderNo ?? 1) === 1 ? <Icon name="repeat" className="inline h-3 w-3" /> : <u>own order</u>}</button>}{!readOnly && r.status !== 'done' && <button type="button" aria-label={`Remove ${r.notes}`} className="ml-1" onClick={() => setRecs(recs.filter((x) => x !== r))}><Icon name="x" className="inline h-3 w-3" /></button>}</span>)}
                  {!readOnly && TESTS.filter((x) => !tests.some((r) => r.notes?.toLowerCase() === x.toLowerCase())).slice(0, 8).map((x) => <button key={x} type="button" className="toggle-opt !py-1" onClick={() => addTest(x)}>{x}</button>)}
                  {!readOnly && <input aria-label="Add a test" list="tests" className="input !w-40 !py-1 text-sm" placeholder="Other test, Enter" value={testDraft} onChange={(ev) => (TESTS.includes(ev.target.value) ? addTest(ev.target.value) : setTestDraft(ev.target.value))} onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.preventDefault(); addTest(testDraft); } }} />}
                  <datalist id="tests">{TESTS.map((x) => <option key={x} value={x} />)}</datalist>
                  {orderNos.length > 1 && <div className="basis-full text-xs text-muted">{orderNos.map((o) => `Order ${o}: ${tests.filter((r) => (r.orderNo ?? 1) === o).map((r) => r.notes).join(', ')}`).join(' · ')} · each is reviewed when all its tests are in</div>}
                </div>
                <div className="flex flex-wrap items-center gap-1.5"><span className="mr-1 text-xs text-muted">Procedure</span>
                  {recs.map((r, k) => r.kind !== 'procedure' ? null : (
                    <span key={k} className="flex flex-wrap items-center gap-1.5 rounded-xl bg-sky-soft px-2 py-1 text-sm">
                      <select aria-label="Procedure" className="input !w-auto !py-1 text-sm" value={r.procedureId ?? ''} disabled={readOnly} onChange={(ev) => { const pr = cfg.procedures.find((x: any) => x.id === ev.target.value); setRecs(recs.map((x, j) => (j === k ? { ...x, procedureId: ev.target.value, sittings: pr?.typicalSittings } : x))); }}>{cfg?.procedures.map((pr: any) => <option key={pr.id} value={pr.id}>{pr.name}</option>)}</select>
                      <NumInput aria-label="Sittings" max={50} className="input !w-14 !py-1" value={r.sittings ?? ''} disabled={readOnly} onChange={(ev) => setRecs(recs.map((x, j) => (j === k ? { ...x, sittings: Number(ev.target.value) } : x)))} /><span className="text-xs text-muted">sittings</span>
                      <input aria-label="Note for the coordinator" className="input !w-44 !py-1 text-sm" placeholder="note for the coordinator" value={r.notes ?? ''} disabled={readOnly} onChange={(ev) => setRecs(recs.map((x, j) => (j === k ? { ...x, notes: ev.target.value } : x)))} />
                      {!readOnly && <button className="btn btn-ghost btn-icon !h-7 !w-7" aria-label="Remove procedure" onClick={() => setRecs(recs.filter((_, j) => j !== k))}><Icon name="x" className="h-3 w-3" /></button>}
                    </span>))}
                  {!readOnly && (cfg?.procedures ?? []).length > 0 && <button type="button" className="toggle-opt !py-1" onClick={() => setRecs([...recs, { kind: 'procedure', procedureId: cfg.procedures[0].id, sittings: cfg.procedures[0].typicalSittings }])}><Icon name="plus" className="inline h-3 w-3" /> Procedure</button>}
                </div>
              </div>
            </div>
          </>}

          {/* footer */}
          <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-2 bg-[#FBFAF7]/95 px-4 py-3 backdrop-blur">
            <button className="btn btn-ghost !px-2.5" aria-label="Back" onClick={() => nav(isDoctor ? '/today' : '/queue', { viewTransition: true })}><Icon name="chevL" /></button>
            {errors.length > 0 ? <button type="button" className="text-xs text-rose underline" onClick={() => document.querySelector('[data-invalid="true"]')?.scrollIntoView({ block: 'center', behavior: 'smooth' })}>{errors.length} required field{errors.length > 1 ? 's' : ''} missing · show</button>
              : <span className="text-xs text-muted">{savedAt ? `Saved ${savedAt}` : readOnly ? '' : 'Autosaves'}{isDoctor && !readOnly ? ' · only Diagnosis is required' : ''}</span>}
            <span className="ml-auto" />
            {!readOnly && !isDoctor && <button className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate({ complete: false })}>Save intake &amp; return to queue</button>}
            {!readOnly && isDoctor && <>
              <button className="btn btn-sm" disabled={saveTpl.isPending} onClick={askTpl}>Save as template</button>
              <MoreMenu label="Save only part of this note as a set" items={[{ label: 'Save only the medicines', onClick: () => saveSection('medicine') }, { label: 'Save only the advice', onClick: () => saveSection('advice') }, { label: 'Save only the tests', onClick: () => saveSection('tests') }]} />
              <button className="btn" disabled={save.isPending} onClick={() => save.mutate({ complete: true })}><Icon name="print" />Complete</button>
              {nextVisit && <button className="btn btn-primary" disabled={save.isPending || callNext.isPending} onClick={() => save.mutate({ complete: true, next: true })}>Complete &amp; call {nextVisit.patient.fullName.split(' ')[0]} →</button>}
            </>}
            {readOnly && <button className="btn btn-primary" onClick={() => openPrint({ title: 'Prescription', rx: id })}><Icon name="print" />Print Rx</button>}
          </div>
        </section>

        {/* right: story so far and reports */}
        <aside className="card-flat self-start p-3.5 lg:col-span-2 xl:col-span-1 xl:sticky xl:top-24">
          <div className="mb-2 inline-flex gap-1 rounded-full bg-white/60 p-1" role="tablist">{([['visits', `Story so far${previous.length ? ` · ${previous.length}` : ''}`], ['docs', `Reports${myDocs.length ? ` · ${myDocs.length}` : ''}`]] as const).map(([k, l]) => <button key={k} role="tab" aria-selected={side === k} className={`rounded-full px-3 py-1.5 text-[13px] font-semibold ${side === k ? 'bg-ink text-white' : 'text-muted'}`} onClick={() => setSide(k)}>{l}</button>)}</div>
          {side === 'visits' ? (<div>
            {previous.length === 0 && <div className="text-sm text-muted">First visit</div>}
            {previous.slice(0, 8).map((x: any) => (
              <button key={x.id} onClick={() => setViewing(x.id)} className="-mx-1 w-full rounded-lg border-t border-line px-1 py-2 text-left text-sm transition-colors first:border-t-0 hover:bg-paper">
                <span className="text-xs font-semibold">{fmtDate(x.createdAt)}</span>{' '}
                <span>{x.data?.review?.response ? `${x.data.review.response} · ` : ''}{joinList(x.data?.assessment?.diagnosis) || joinList(x.data?.complaint?.chief_complaint) || 'Consultation'}</span>
                {x.prescription?.length > 0 && <div className="truncate text-xs text-muted">{x.prescription.map((i: any) => i.name).join(', ')}</div>}
              </button>))}
          </div>) : (<div>
            <div className="mb-2 flex items-center gap-2"><span className="text-xs text-muted">Lab PDFs and photos</span><span className="ml-auto" />{can(perms, 'document.write') && <UploadButton patientId={p.id} encounterId={id} label="Upload" onDone={() => qc.invalidateQueries({ queryKey: ['documents', p.id] })} />}</div>
            {myDocs.length === 0 ? <div className="text-xs text-muted">No reports yet.</div> : <DocList docs={myDocs.slice(0, 8)} />}
          </div>)}
        </aside>
      </div>
      {viewing && <EncounterModal id={viewing} onClose={() => setViewing(null)} />}
      {capture && <PhotoCapture patient={{ id: p.id, fullName: p.fullName }} onClose={() => setCapture(false)} />}
      {compare && <PhotoCompare name={p.fullName} a={compare[0]} b={compare[1]} onClose={() => setCompare(null)} />}
    </div>
  );
}

function AdviceInput({ onAdd }: { onAdd: (a: string) => void }) {
  const [v, setV] = useState('');
  return <input aria-label="Other advice" className="input mt-2 !py-1.5 text-sm" maxLength={200} placeholder="Other advice, press Enter" value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && v.trim()) { e.preventDefault(); onAdd(v.trim()); setV(''); } }} />;
}

/** One form field in the compact consultation row: options as chips to tap, text only when needed. */
function CompactField({ f, value, onChange, disabled, invalid }: { f: Field; value: any; onChange: (v: any) => void; disabled: boolean; invalid?: boolean }) {
  const [note, setNote] = useState(false);
  if (f.type === 'diagnoses') {
    const v = asDx(value);
    const quick = (f.options ?? []).filter((o) => !v.some((d) => d.name === o)).slice(0, 8);
    return <div className="space-y-1.5"><DiagnosesInput value={v} onChange={onChange} options={f.options} placeholder={f.placeholder} disabled={disabled} invalid={invalid} />
      {!disabled && quick.length > 0 && <div className="flex flex-wrap gap-1.5">{quick.map((o) => <button key={o} type="button" className="toggle-opt !py-1" onClick={() => onChange([...v, { name: o }])}>{o}</button>)}</div>}</div>;
  }
  if (f.type === 'tags') {
    const v = asList(value);
    const quick = (f.options ?? []).filter((o) => !v.includes(o)).slice(0, 10);
    return <div className="flex flex-wrap items-center gap-1.5">
      {v.map((t) => <span key={t} className="toggle-opt on !py-1">{t}{!disabled && <button type="button" aria-label={`Remove ${t}`} className="ml-1" onClick={() => onChange(v.filter((x) => x !== t))}><Icon name="x" className="inline h-3 w-3" /></button>}</span>)}
      {!disabled && quick.map((o) => <button key={o} type="button" className="toggle-opt !py-1" onClick={() => onChange([...v, o])}>{o}</button>)}
      {!disabled && <TagDraft placeholder={f.label} invalid={invalid} onAdd={(t) => !v.includes(t) && onChange([...v, t])} />}
    </div>;
  }
  if (f.type === 'multiselect' || f.type === 'select') {
    const multi = f.type === 'multiselect'; const v: string[] = multi ? (value ?? []) : value ? [value] : [];
    return <div className="flex flex-wrap items-center gap-1.5"><span className="mr-0.5 text-xs text-muted">{f.label}</span>{f.options!.map((o) => <button type="button" key={o} disabled={disabled} className={`toggle-opt !py-1 ${v.includes(o) ? 'on' : ''}`} onClick={() => onChange(multi ? (v.includes(o) ? v.filter((x) => x !== o) : [...v, o]) : value === o ? undefined : o)}>{o}</button>)}</div>;
  }
  if (f.type === 'textarea') {
    if (!value && !note) return disabled ? null : <button type="button" className="text-xs font-semibold text-muted underline" onClick={() => setNote(true)}>+ {f.label.toLowerCase()}</button>;
    return <textarea aria-label={f.label} autoFocus={note && !value} className={`input min-h-16 text-sm ${invalid ? '!border-rose' : ''}`} placeholder={f.placeholder ?? f.label} value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
  }
  return <div className="flex items-center gap-2"><span className="w-20 shrink-0 text-xs text-muted">{f.label}{f.unit ? ` (${f.unit})` : ''}</span><div className="min-w-0 flex-1 sm:max-w-xs"><FieldInput f={f} value={value} onChange={onChange} disabled={disabled} invalid={invalid} /></div></div>;
}

function TagDraft({ placeholder, invalid, onAdd }: { placeholder: string; invalid?: boolean; onAdd: (t: string) => void }) {
  const [v, setV] = useState('');
  const add = () => { if (v.trim()) { onAdd(v.trim()); setV(''); } };
  return <input aria-label={`Add ${placeholder.toLowerCase()}`} className={`input !w-40 !py-1 text-sm ${invalid ? '!border-rose' : ''}`} placeholder="Other, press Enter" value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); } }} onBlur={add} />;
}

/** Tags: several free-text values, Enter or comma adds; suggestions from options. */
function TagsInput({ value, onChange, options, placeholder, disabled, invalid }: { value: string[]; onChange: (v: string[]) => void; options?: string[]; placeholder?: string; disabled: boolean; invalid?: boolean }) {
  const [draft, setDraft] = useState('');
  const listId = 'tags-' + (placeholder ?? '').replace(/\W/g, '').slice(0, 12);
  const add = (s: string) => { const v = s.trim(); if (v && !value.includes(v)) onChange([...value, v]); setDraft(''); };
  return (
    <div className={`input flex flex-wrap items-center gap-1.5 !py-1.5 ${invalid ? '!border-rose' : ''} ${disabled ? 'bg-paper' : ''}`} onClick={(e) => (e.currentTarget.querySelector('input') as HTMLInputElement)?.focus()}>
      {value.map((t) => <span key={t} className="chip chip-clay !text-xs !py-1 anim-scale-in">{t}{!disabled && <button type="button" className="ml-0.5 hover:text-ink" onClick={() => onChange(value.filter((x) => x !== t))}><Icon name="x" className="h-3 w-3" /></button>}</span>)}
      {!disabled && <input list={listId} className="flex-1 min-w-32 bg-transparent outline-none text-sm py-0.5" placeholder={value.length ? 'Add another…' : placeholder} value={draft}
        onChange={(e) => { if (options?.includes(e.target.value)) add(e.target.value); else setDraft(e.target.value); }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(draft); } else if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1)); }}
        onBlur={() => draft && add(draft)} />}
      {options && <datalist id={listId}>{options.filter((o) => !value.includes(o)).map((o) => <option key={o} value={o} />)}</datalist>}
    </div>
  );
}

const SEVERITIES = ['Mild', 'Moderate', 'Severe'];
type Dx = { name: string; severity?: string };
/** Diagnoses: each entry carries its own severity. Old string values are upgraded on first edit. */
function DiagnosesInput({ value, onChange, options, placeholder, disabled, invalid }: { value: Dx[]; onChange: (v: Dx[]) => void; options?: string[]; placeholder?: string; disabled: boolean; invalid?: boolean }) {
  const [draft, setDraft] = useState('');
  const add = (s: string) => { const v = s.trim(); if (v && !value.some((d) => d.name === v)) onChange([...value, { name: v }]); setDraft(''); };
  return (
    <div className="space-y-2">
      {value.map((d, i) => (
        <div key={d.name} className="flex items-center gap-2 flex-wrap anim-fade-up">
          <span className="chip chip-clay !text-xs !py-1">{d.name}{!disabled && <button type="button" className="ml-0.5 hover:text-ink" onClick={() => onChange(value.filter((_, j) => j !== i))}><Icon name="x" className="h-3 w-3" /></button>}</span>
          <div className="flex gap-1">{SEVERITIES.map((s) => <button key={s} type="button" disabled={disabled} className={`toggle-opt !py-1 ${d.severity === s ? 'on' : ''}`} onClick={() => onChange(value.map((x, j) => j === i ? { ...x, severity: x.severity === s ? undefined : s } : x))}>{s}</button>)}</div>
        </div>
      ))}
      {!disabled && <div className={`input flex items-center gap-2 !py-1.5 ${invalid ? '!border-rose' : ''}`}>
        <input list="dx-options" className="flex-1 min-w-32 bg-transparent outline-none text-sm py-0.5" placeholder={value.length ? 'Add another diagnosis…' : placeholder} value={draft}
          onChange={(ev) => { if (options?.includes(ev.target.value)) add(ev.target.value); else setDraft(ev.target.value); }}
          onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ',') { ev.preventDefault(); add(draft); } }} onBlur={() => draft && add(draft)} />
        <datalist id="dx-options">{(options ?? []).filter((o) => !value.some((d) => d.name === o)).map((o) => <option key={o} value={o} />)}</datalist>
      </div>}
    </div>
  );
}
const asDx = (v: any): Dx[] => Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? { name: x } : x)) : v ? [{ name: String(v) }] : [];

function FieldInput({ f, value, onChange, disabled, invalid }: { f: Field; value: any; onChange: (v: any) => void; disabled: boolean; invalid?: boolean }) {
  const cls = `input ${invalid ? '!border-rose' : ''}`;
  if (f.type === 'diagnoses') return <DiagnosesInput value={asDx(value)} onChange={onChange} options={f.options} placeholder={f.placeholder} disabled={disabled} invalid={invalid} />;
  if (f.type === 'tags') return <TagsInput value={asList(value)} onChange={onChange} options={f.options} placeholder={f.placeholder} disabled={disabled} invalid={invalid} />;
  if (f.type === 'textarea') return <textarea className={`${cls} min-h-20`} value={value ?? ''} placeholder={f.placeholder} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
  if (f.type === 'select') return <div className="flex flex-wrap gap-1.5">{f.options!.map((o) => <button type="button" key={o} disabled={disabled} className={`toggle-opt ${value === o ? 'on' : ''}`} onClick={() => onChange(value === o ? undefined : o)}>{o}</button>)}</div>;
  if (f.type === 'multiselect') { const v: string[] = value ?? []; return <div className="flex flex-wrap gap-1.5">{f.options!.map((o) => <button type="button" key={o} disabled={disabled} className={`toggle-opt ${v.includes(o) ? 'on' : ''}`} onClick={() => onChange(v.includes(o) ? v.filter((x) => x !== o) : [...v, o])}>{o}</button>)}</div>; }
  if (f.type === 'number') return <NumInput decimal max={100000} className={cls} value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} />;
  if (f.type === 'date') return <input type="date" className={cls} value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
  return <input className={cls} value={value ?? ''} placeholder={f.placeholder} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
}
