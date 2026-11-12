import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useOutletContext, useSearchParams } from 'react-router';
import { get, post, qc, errText, fmtTime } from '../api';
import { can } from '../App';
import { Drawer, Empty, Icon, PageHeader, Skeleton, ask, fmtDate, toast, usePageSearch } from '../ui';
import { FlagChips } from '../flags';
import { LoadError } from '../procBoard';
import { openViewer } from '../viewer';
import { saveLabValues, findParam, flagFor, rangeText, isOut, type LabDraft } from '../labs';

type Val = { id: string; test: string; value: string; unit: string | null; low: number | null; high: number | null; flag: 'low' | 'normal' | 'high' | 'abnormal' | null };
type Test = { id: string; name: string; params: string[]; expectedOn: string | null; receivedAt: string | null; reviewedAt: string | null; late: boolean; called: string | null; docs: any[]; values?: Val[] };
export type Order = { key: string; encounterId: string; orderNo: number; held?: boolean; orderedAt?: string; patient: { id: string; fullName: string; patientNo: string; phone: string | null; flags?: any }; doctor: string | null; tests: Test[]; state: 'pending' | 'partial' | 'ready' | 'reviewed' | 'doctor_call' | 'closed'; got: number; abnormal?: number;
  outcome: string | null; note: string | null; reviewedBy: string | null; informedHow: string | null; late: string[]; nextDue: string | null };

const OUTCOMES: [string, string][] = [['normal', 'Normal'], ['change_medicines', 'Abnormal · change medicines'], ['needs_visit', 'Abnormal · visit needed'], ['will_call', 'I will call the patient']];
const OUTCOME_SAYS: Record<string, string> = { normal: 'Normal. Please inform the patient.', change_medicines: 'Medicines changed. Inform the patient, and book a visit if needed.', needs_visit: 'A visit is needed. Book it, then inform the patient.', will_call: 'The doctor will call the patient.', seen: 'Discussed with the patient at the visit.' };
const SHORT: Record<string, string> = { normal: 'normal', change_medicines: 'medicines changed', needs_visit: 'visit booked', will_call: 'doctor called the patient', seen: 'discussed at the visit' };
const HOW: [string, string][] = [['in_person', 'In person'], ['phone', 'Phone'], ['whatsapp', 'WhatsApp']];
const HOW_SAYS: Record<string, string> = { in_person: 'in person', phone: 'by phone', whatsapp: 'on WhatsApp' };
const STEPS = ['Ordered', 'Results in', 'Reviewed', 'Patient informed'];
const stepOf = (s: Order['state']) => ({ pending: 0, partial: 0, ready: 1, reviewed: 2, doctor_call: 2, closed: 3 })[s];

/** A phone photo can be 10 MB or more; send a smaller copy so it uploads on a weak signal. PDFs go as they are. */
async function prepare(file: File): Promise<{ title: string; mime: string; dataBase64: string }> {
  const raw = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(file); });
  if (!file.type.startsWith('image/') || file.size < 1.5 * 1024 * 1024) return { title: file.name, mime: file.type, dataBase64: raw };
  const img = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = raw; });
  const k = Math.min(1, 2200 / Math.max(img.width, img.height)); const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  return { title: file.name.replace(/\.\w+$/, '') + '.jpg', mime: 'image/jpeg', dataBase64: c.toDataURL('image/jpeg', 0.85) };
}

/** The receptionist's report: pick or photograph the pages, say which tests they are for, save. Several tests can share one report. */
/** inVisit: added at check-in, the patient is about to see the doctor with these reports, so nothing is sent ahead. */
export function ReportDialog({ order, testId, onClose, inVisit }: { order: Order; testId: string; onClose: () => void; inVisit?: boolean }) {
  const open = order.tests.filter((t) => !t.receivedAt);
  const [ids, setIds] = useState<string[]>([testId]); const [files, setFiles] = useState<File[]>([]); const [note, setNote] = useState('');
  // the values asked for under each test: its usual ones already named (CBC: Hb, WBC, platelets…), plus any the desk adds
  const [vals, setVals] = useState<Record<string, LabDraft[]>>({}); const { cfg } = useOutletContext<any>();
  const rowsFor = (t: Test): LabDraft[] => vals[t.id] ?? ((t.params ?? []).length ? t.params : [t.name]).map((n) => ({ test: n, value: '', note: '' }));
  const setRow = (t: Test, i: number, p: Partial<LabDraft>) => setVals({ ...vals, [t.id]: rowsFor(t).map((r, j) => (j === i ? { ...r, ...p } : r)) });
  const ticked = open.filter((t) => ids.includes(t.id));
  const input = useRef<HTMLInputElement>(null);
  // tests not in this report: wait for them, or send what is in to the doctor now (the rest become an order of their own)
  const rest = open.filter((t) => !ids.includes(t.id));
  const save = useMutation({
    mutationFn: async (send: boolean) => {
      let firstDoc: string | null = null;
      for (const f of files) { const x = await prepare(f); const d: any = await post('/documents', { patientId: order.patient.id, encounterId: order.encounterId, recommendationIds: ids, kind: 'report', note: note.trim() || undefined, ...x }); firstDoc ??= d?.id ?? null; }
      // the numbers the doctor will compare, typed from the page in hand; the pages are saved either way
      let saved = 0; for (const t of ticked) saved += (await saveLabValues({ patientId: order.patient.id, encounterId: order.encounterId, recommendationId: t.id, documentId: firstDoc, rows: rowsFor(t) })).length;
      // values with no file (read out on the phone, a WhatsApp text): the values mark the tests received
      if (!files.length) await post('/orders/received', { ids: ticked.map((t) => t.id), note: note.trim() || undefined });
      if (send && rest.length) await post('/orders/split', { ids: rest.map((t) => t.id) });
      return { saved, sent: !inVisit && (send || !rest.length) };
    },
    onSuccess: ({ saved: n, sent }) => { qc.invalidateQueries({ queryKey: ['orders'] }); qc.invalidateQueries({ queryKey: ['documents'] }); toast(`Saved for ${ids.map((i) => order.tests.find((t) => t.id === i)?.name).join(', ')}${n ? ` · ${n} value${n === 1 ? '' : 's'}` : ''}${sent ? ' · sent to the doctor' : ''}`); onClose(); },
    onError: (e: any) => toast(e?.body?.code === 'UNSUPPORTED_TYPE' ? 'Only JPG, PNG, WebP and PDF files can be added.' : e?.body?.code === 'TOO_LARGE' ? 'That file is too large (10 MB at most).' : errText(e), 'err'),
  });
  // a file, or typed values for every ticked test (values alone are fine: labs often send them on WhatsApp)
  const typed = (t: Test) => rowsFor(t).some((r) => r.test.trim() && r.value.trim());
  const blocker = !ids.length ? 'Pick which tests this is for' : !files.length && !ticked.every(typed) ? 'Add a page, or type the values for each test' : '';
  return (
    <Drawer title={`Report for ${order.patient.fullName}`} subtitle={`Order ${order.orderNo} · ${order.tests.map((t) => t.name).join(', ')}`} onClose={onClose} width="max-w-xl">
      <div className="space-y-4">
        <div>
          <span className="label">Pages</span>
          <div className="flex flex-wrap gap-2">
            {files.map((f, i) => <span key={i} className="inline-flex items-center gap-2 rounded-xl border border-line bg-surface px-2.5 py-1.5 text-sm">{f.type.startsWith('image/') ? <img src={URL.createObjectURL(f)} alt="" className="h-9 w-9 rounded-md object-cover" /> : <span className="grid h-9 w-9 place-items-center rounded-md bg-clay-soft text-[10px] font-bold text-clay">PDF</span>}<span className="max-w-32 truncate">{f.name}</span><button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))}><Icon name="x" className="h-3.5 w-3.5" /></button></span>)}
            <button type="button" className="btn !min-h-12" onClick={() => input.current?.click()}><Icon name="plus" className="h-4 w-4" />{files.length ? 'Another page' : 'Photo or file'}</button>
          </div>
          <input ref={input} type="file" accept="image/*,application/pdf" multiple className="hidden" onChange={(e) => { setFiles([...files, ...Array.from(e.target.files ?? [])].slice(0, 12)); e.target.value = ''; }} />
          <div className="mt-1.5 text-xs text-muted">A PDF or photo from WhatsApp, or take a photo with the camera. JPG, PNG, WebP or PDF. No file? Type the values below.</div>
        </div>
        <div><span className="label">Which tests is this for</span><div className="flex flex-wrap gap-1.5">{open.map((t) => <button key={t.id} type="button" aria-pressed={ids.includes(t.id)} className={`toggle-opt !py-2 ${ids.includes(t.id) ? 'on' : ''}`} onClick={() => setIds(ids.includes(t.id) ? ids.filter((x) => x !== t.id) : [...ids, t.id])}>{t.name}</button>)}</div></div>
        {ticked.length > 0 && <div>
          <span className="label">Values <span className="font-normal text-muted">· type what the report says; leave a box empty to skip it</span></span>
          <datalist id="lab-params">{(cfg?.labParams ?? []).map((p: any) => <option key={p.name} value={p.name} />)}</datalist>
          <div className="space-y-3">{ticked.map((t) => (
            <div key={t.id} className="rounded-2xl bg-paper-2/60 p-3">
              <div className="mb-1.5 text-[14px] font-semibold">{t.name}</div>
              {rowsFor(t).map((r, i) => { const p = findParam(r.test, cfg?.labParams ?? []); const fl = flagFor(r.value, p); const named = i < ((t.params ?? []).length || 1);
                return (
                  <div key={i} className="mt-1.5 grid grid-cols-[minmax(0,1.4fr)_130px_minmax(0,1fr)] items-center gap-2">
                    {named ? <span className="truncate text-[13.5px] text-ink-2">{r.test}</span>
                      : <input list="lab-params" aria-label={`Value name under ${t.name}`} className="input !py-1.5" placeholder="Name, e.g. Vitamin D" value={r.test} onChange={(e) => setRow(t, i, { test: e.target.value })} />}
                    <input aria-label={`${r.test || 'Value'} for ${t.name}`} className={`input !py-1.5 ${isOut(fl) ? '!text-rose !shadow-[inset_0_0_0_1.5px_var(--color-rose)]' : ''}`} placeholder={p?.expect ? p.expect : ''} value={r.value} onChange={(e) => setRow(t, i, { value: e.target.value })} />
                    <span className="truncate text-[12px] text-muted">{[p?.unit, rangeText(p)].filter(Boolean).join(' · ')}{fl && fl !== 'normal' && <b className="ml-1.5 text-rose">{fl}</b>}</span>
                  </div>); })}
              <button type="button" className="btn btn-ghost btn-sm mt-1.5" onClick={() => setVals({ ...vals, [t.id]: [...rowsFor(t), { test: '', value: '', note: '' }] })}><Icon name="plus" className="h-3.5 w-3.5" />Another value</button>
            </div>))}</div>
        </div>}
        <div><label className="label" htmlFor="rep-note">Note (optional)</label><input id="rep-note" className="input" maxLength={200} placeholder="Anything the doctor should know" value={note} onChange={(e) => setNote(e.target.value)} /></div>
        <div className="modal-foot"><span className="mr-auto text-xs text-muted" role="status">{blocker || (inVisit ? 'The doctor goes over it in the consultation' : rest.length ? `${rest.map((t) => t.name).join(', ')} still to come. Wait for ${rest.length === 1 ? 'it' : 'them'}, or send what is in now.` : 'Goes to the doctor’s Today, under Results to review')}</span><button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          {rest.length > 0 && !inVisit && <button className="btn" disabled={save.isPending || !!blocker} onClick={() => save.mutate(false)}>Save, wait for the rest</button>}
          <button className="btn btn-primary" disabled={save.isPending || !!blocker} onClick={() => save.mutate(!inVisit)}><Icon name="check" />{save.isPending ? 'Saving…' : inVisit ? 'Save report' : 'Save and send to the doctor'}</button></div>
      </div>
    </Drawer>
  );
}


type Stage = 'results' | 'review' | 'update' | 'done';
const FILTERS: [Stage | 'all', string][] = [['all', 'All'], ['results', 'Results pending'], ['review', 'Review pending'], ['update', 'Patient update pending'], ['done', 'Completed today']];
const ORDER: Stage[] = ['review', 'results', 'update', 'done'];
const stageOf = (o: Order): Stage => (o.state === 'pending' || o.state === 'partial' ? 'results' : o.state === 'ready' ? 'review' : o.state === 'closed' ? 'done' : 'update');
const refresh = () => { qc.invalidateQueries({ queryKey: ['orders'] }); qc.invalidateQueries({ queryKey: ['documents'] }); };

/** Where the order stands, in two lines: what, then why. */
function standing(o: Order): { t: string; sub: string; tone: string } {
  const n = o.tests.length;
  if (o.state === 'pending' || o.state === 'partial') {
    const t = o.state === 'partial' ? `${o.got} of ${n} received` : n > 1 ? 'Awaiting results' : 'Awaiting result';
    return o.late.length ? { t, sub: `overdue: ${o.late.join(', ')}`, tone: 'text-rose' } : { t, sub: o.nextDue ? `expected ${fmtDate(o.nextDue)}` : 'no date expected', tone: 'text-amber' };
  }
  if (o.state === 'ready') return { t: 'Awaiting doctor review', sub: o.abnormal ? `${o.abnormal} out of range` : 'all results in', tone: o.abnormal ? 'text-rose' : 'text-clay' };
  if (o.state === 'doctor_call') return { t: 'Doctor will call the patient', sub: o.reviewedBy ? `reviewed by ${o.reviewedBy}` : '', tone: 'text-amber' };
  if (o.state === 'reviewed') return { t: o.outcome === 'needs_visit' ? 'Book a visit, then inform' : 'Inform the patient', sub: `${SHORT[o.outcome ?? 'normal']}${o.reviewedBy ? ` · ${o.reviewedBy}` : ''}`, tone: 'text-amber' };
  return { t: 'Completed', sub: `${SHORT[o.outcome ?? 'normal']}${o.informedHow ? ` · informed ${HOW_SAYS[o.informedHow] ?? ''}` : ''}`, tone: 'text-muted' };
}

const Steps = ({ state }: { state: Order['state'] }) => (
  <ol className="flex flex-wrap items-center gap-x-1 text-[12px] font-semibold text-muted" aria-label={`Step: ${STEPS[stepOf(state)]}`}>
    {STEPS.map((s, i) => <li key={s} className={i === stepOf(state) ? 'text-ink' : i < stepOf(state) ? 'text-sage' : ''}>{i > 0 && <span className="mx-1 font-normal">›</span>}{s}</li>)}
  </ol>
);

/** One order on the right: each test with its values and files, then the one thing to do next for whoever opened it. */
function OrderDrawer({ o, perms, isDoctor, onAdd, onBook, onClose }: { o: Order; perms: string[]; isDoctor: boolean; onAdd: (testId: string) => void; onBook: () => void; onClose: () => void }) {
  const nav = useNavigate();
  const canDesk = can(perms, 'worklist.write') || isDoctor; const canUpload = can(perms, 'document.write');
  const s = standing(o);
  const [outcome, setOutcome] = useState(''); const [note, setNote] = useState(''); const [how, setHow] = useState(false);
  const outOf = o.tests.flatMap((t) => t.values ?? []).filter((v) => isOut(v.flag));
  const called = useMutation({ mutationFn: (id: string) => post('/orders/called', { id }), onSuccess: () => { refresh(); toast('Noted: lab called', 'info'); }, onError: (e) => toast(errText(e), 'err') });
  const split = useMutation({ mutationFn: () => post('/orders/split', { ids: o.tests.filter((t) => !t.receivedAt).map((t) => t.id) }), onSuccess: () => { refresh(); onClose(); toast('Sent to the doctor · the remaining tests stay pending'); }, onError: (e) => toast(errText(e), 'err') });
  const pick = async (k: string) => {
    if (k === 'normal' && outOf.length) {
      const v = outOf[0]; const say = v.flag === 'low' ? 'is below range' : v.flag === 'high' ? 'is above range' : 'is not the expected result';
      if (!(await ask({ title: `${v.test} ${v.value} ${say}${outOf.length > 1 ? ` (and ${outOf.length - 1} more out of range)` : ''}. Mark as normal anyway?`, confirmLabel: 'Mark as normal', cancelLabel: 'Go back' }))) return;
    }
    setOutcome(k);
  };
  const review = useMutation({
    mutationFn: () => post('/orders/review', { encounterId: o.encounterId, orderNo: o.orderNo, outcome, note: note.trim() || undefined }),
    onSuccess: () => {
      refresh(); onClose();
      // changing medicines happens in the consultation itself, still open for these reports; Finish sends the new prescription
      if (outcome === 'change_medicines' && o.held) { toast('Change the medicines, then Complete'); nav(`/encounter/${o.encounterId}`); }
      else toast('Reviewed · the front desk will inform the patient');
    },
    onError: (e: any) => toast(e?.body?.code === 'NOT_ALL_RECEIVED' ? 'A result is still missing.' : errText(e), 'err'),
  });
  const inform = useMutation({ mutationFn: (h: string) => post('/orders/inform', { encounterId: o.encounterId, orderNo: o.orderNo, how: h }), onSuccess: () => { refresh(); onClose(); toast('Patient informed · completed'); },
    onError: (e: any) => { setHow(false); toast(e?.body?.code === 'DOCTOR_WILL_CALL' ? 'The doctor will call this patient.' : e?.body?.code === 'BOOK_FIRST' ? 'The doctor wants to see the patient: book the visit first.' : errText(e), 'err'); } });
  const visit = o.outcome === 'needs_visit' && o.state === 'reviewed';
  const files = o.tests.flatMap((t) => t.docs.map((d) => ({ ...d, test: t.name })));
  return (
    <Drawer title={o.patient.fullName} subtitle={[o.patient.patientNo, o.patient.phone, `order ${o.orderNo}`, o.doctor].filter(Boolean).join(' · ')} onClose={onClose} width="max-w-xl">
      <div className="flex flex-col gap-4">
        <Steps state={o.state} />
        <div className="rounded-xl bg-surface-2 px-4 py-3"><b className={s.tone}>{s.t}</b><div className="text-xs text-muted">{s.sub}</div></div>

        <div>
          <b className="text-sm">Tests</b>
          {o.tests.map((t) => (
            <div key={t.id} className="border-t border-line/60 py-2.5 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <b className="min-w-0 flex-1">{t.name}</b>
                <span className={`text-xs ${t.receivedAt ? 'text-sage' : t.late ? 'text-rose' : 'text-muted'}`}>{t.receivedAt ? `received ${fmtTime(t.receivedAt)}` : t.late ? 'overdue' : t.expectedOn ? `expected ${fmtDate(t.expectedOn)}` : 'pending'}{t.called && !t.receivedAt ? ` · lab called ${fmtTime(t.called)}` : ''}</span>
                {!t.receivedAt && can(perms, 'worklist.write') && <button className="btn btn-sm" disabled={called.isPending} onClick={() => called.mutate(t.id)}>Called lab</button>}
                {!t.receivedAt && canUpload && <button className="btn btn-sm btn-primary" onClick={() => onAdd(t.id)}><Icon name="plus" className="h-3.5 w-3.5" />Add result</button>}
              </div>
              {(t.values ?? []).length > 0 && <div className="mt-1.5 grid grid-cols-[minmax(0,1.3fr)_auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[13px]">
                {(t.values ?? []).map((v) => { const bad = isOut(v.flag); return (
                  <div key={v.id} className="contents">
                    <span className={`truncate ${bad ? 'font-semibold text-rose' : 'text-ink-2'}`}>{v.test}</span>
                    <span className={bad ? 'font-semibold text-rose' : ''}>{v.value}{v.unit ? <span className="text-xs font-normal text-muted"> {v.unit}</span> : ''}{bad ? <span className="ml-1 text-xs">{v.flag}</span> : ''}</span>
                    <span className="truncate text-xs text-muted">{rangeText(v) ? `normal ${rangeText(v)}` : ''}</span>
                  </div>); })}
              </div>}
            </div>))}
          {files.length > 0 && <div className="mt-1 flex flex-wrap gap-2 border-t border-line/60 pt-2.5">
            {files.map((d, i) => <button key={d.id} type="button" className="btn btn-sm" onClick={() => openViewer({ docs: files, index: i, who: o.patient.fullName, canDelete: false })}><Icon name="inbox" className="h-3.5 w-3.5" />{d.test} · {String(d.title).slice(0, 18)}</button>)}
          </div>}
          {files.some((d) => d.note) && <div className="mt-1.5 text-xs text-muted">Note from the desk: {files.find((d) => d.note)?.note}</div>}
        </div>

        {o.state === 'partial' && canDesk && <div className="flex flex-wrap items-center gap-2 rounded-xl bg-surface-2 px-4 py-3 text-xs text-muted"><span className="min-w-0 flex-1">The doctor sees this order when every result is in, or now if you send the received ones.</span><button className="btn btn-sm" disabled={split.isPending} onClick={() => split.mutate()}>Send received results to the doctor</button></div>}

        {o.state === 'ready' && (isDoctor ? <div className="flex flex-col gap-3 border-t border-line/60 pt-4">
          <div><span className="label">Outcome</span><div className="flex flex-wrap gap-1.5" role="radiogroup">{OUTCOMES.map(([k, l]) => <button key={k} type="button" role="radio" aria-checked={outcome === k} className={`toggle-opt !py-2 ${outcome === k ? 'on' : ''}`} onClick={() => pick(k)}>{l}</button>)}</div></div>
          <div><label className="label" htmlFor="rev-note">Note for the front desk (optional)</label><input id="rev-note" className="input" maxLength={300} placeholder="“LFT slightly high, repeat in a month”" value={note} onChange={(e) => setNote(e.target.value)} /></div>
          <div className="flex items-center gap-2"><span className="mr-auto text-xs text-muted">{outcome ? 'The front desk sees this at once.' : 'Pick the outcome.'}</span><button className="btn btn-primary" disabled={review.isPending || !outcome} onClick={() => review.mutate()}><Icon name="check" />Mark reviewed</button></div>
        </div> : <div className="text-sm text-muted">With the doctor for review. You will see the outcome here.</div>)}

        {(o.state === 'reviewed' || o.state === 'doctor_call') && <div className={`rounded-xl px-4 py-3 text-sm ${o.state === 'doctor_call' ? 'bg-amber-soft' : 'bg-sage-soft'}`}>
          <div className="text-[11px] font-bold uppercase tracking-wider text-muted">{o.reviewedBy ?? 'Doctor'}</div>
          <div className="font-semibold">{OUTCOME_SAYS[o.outcome ?? 'normal']}</div>{o.note && <div className="mt-0.5 text-ink-2">{o.note}</div>}
          {(o.state === 'reviewed' || isDoctor) && canDesk && <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {visit && !how && can(perms, 'appointment.write') && <button className="btn btn-sm btn-primary" onClick={onBook}>Book visit</button>}
            {!how ? <button className={`btn btn-sm ${visit ? '' : 'btn-primary'}`} onClick={() => setHow(true)}>{o.state === 'doctor_call' ? 'I called the patient' : 'Patient informed'}</button>
              : <><span className="text-xs text-muted">How?</span>{HOW.map(([k, l]) => <button key={k} className="toggle-opt !py-2" disabled={inform.isPending} onClick={() => inform.mutate(k)}>{l}</button>)}<button className="btn btn-ghost btn-sm" onClick={() => setHow(false)}>Back</button></>}
          </div>}
        </div>}

        <div className="flex flex-wrap gap-2 border-t border-line/60 pt-4"><button className="btn btn-sm" onClick={() => nav(`/patients/${o.patient.id}`)}>Open record</button></div>
      </div>
    </Drawer>
  );
}

/** Test reports: every order in one list, filtered by where it stands; a row opens the order on the right.
 *  The front desk adds results and informs the patient; the doctor reviews. */
export function TestReports() {
  const { perms } = useOutletContext<any>();
  const isDoctor = can(perms, 'encounter.complete');
  const [sp, setSp] = useSearchParams();
  const [f, setF] = useState<Stage | 'all'>(isDoctor ? 'review' : 'all'); const [sel, setSel] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null); // the test a result is being added for
  const [q] = usePageSearch('Find a patient: name, phone or patient no.');
  const data = useQuery<{ counts: Record<string, number>; orders: Order[] }>({ queryKey: ['orders'], queryFn: () => get('/orders'), refetchInterval: 20000 });
  // from the doctor's Today: open that order straight away
  const want = sp.get('open');
  useEffect(() => { if (want && data.data?.orders.some((o) => o.key === want)) { setF('all'); setSel(want); const p = new URLSearchParams(sp); p.delete('open'); p.delete('tab'); setSp(p, { replace: true }); } }, [want, !!data.data]);
  if (data.isError && !data.data) return <div><PageHeader title="Test reports" /><LoadError onRetry={() => data.refetch()} /></div>;
  // "Visit needed": the booking drawer, for this patient
  const book = (o: Order) => { const p = new URLSearchParams(sp); p.set('book', '1'); p.set('patient', o.patient.id); p.set('pname', o.patient.fullName); setSp(p); };
  const all = [...(data.data?.orders ?? [])].sort((a, b) => ORDER.indexOf(stageOf(a)) - ORDER.indexOf(stageOf(b))); // the server already puts out-of-range and late first
  const needle = q.trim().toLowerCase();
  const found = needle ? all.filter((o) => `${o.patient.fullName} ${o.patient.phone ?? ''} ${o.patient.patientNo} ${o.tests.map((t) => t.name).join(' ')}`.toLowerCase().includes(needle)) : all;
  const rows = found.filter((o) => f === 'all' || stageOf(o) === f);
  const d = all.find((o) => o.key === sel);
  const addFor = d && adding ? d : null;
  return (
    <div>
      <PageHeader title="Test reports" subtitle="Every test ordered, from result to patient informed" />
      {!data.data ? <Skeleton rows={6} /> : !all.length ? <div className="card"><Empty icon="check" title="No tests ordered" hint="Tests the doctor orders appear here until the patient is informed." /></div> : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Show orders">
            {FILTERS.map(([k, t]) => { const n = k === 'all' ? found.length : found.filter((o) => stageOf(o) === k).length;
              return <button key={k} className={`toggle-opt ${f === k ? 'on' : ''}`} aria-pressed={f === k} onClick={() => { setF(k); setSel(null); }}>{t} <b className="ml-1">{n}</b></button>; })}
          </div>
          <div className="card !p-0 overflow-x-auto">
            <table className="w-full text-sm stack-on-phone">
              <thead><tr className="bg-surface-2 text-left text-[11px] font-bold uppercase tracking-wider text-muted"><th className="px-4 py-2.5">Patient</th><th className="px-4">Tests</th><th className="px-4">Ordered</th><th className="px-4">Status</th><th className="px-4">Doctor</th></tr></thead>
              <tbody>
                {rows.map((o) => { const s = standing(o);
                  return (
                    <tr key={o.key} className={`cursor-pointer border-t border-line/60 hover:bg-surface-2 ${sel === o.key ? '!bg-sage-soft' : ''}`} onClick={() => setSel(o.key)}>
                      <td className="px-4 py-3"><button className="text-left font-bold" onClick={(e) => { e.stopPropagation(); setSel(o.key); }}>{o.patient.fullName}</button> <FlagChips flags={o.patient.flags} /><div className="text-xs text-muted">{o.patient.phone ?? o.patient.patientNo}</div></td>
                      <td className="px-4">{o.tests.map((t) => t.name).join(', ')}<div className={`text-xs ${o.abnormal ? 'font-semibold text-rose' : 'text-muted'}`}>{o.abnormal ? `${o.abnormal} out of range` : o.tests.length > 1 ? `${o.tests.length} tests` : '1 test'}</div></td>
                      <td className="px-4">{o.orderedAt ? fmtDate(o.orderedAt.slice(0, 10)) : '—'}</td>
                      <td className="px-4"><b className={s.tone}>{s.t}</b><div className="text-xs text-muted">{s.sub}</div></td>
                      <td className="px-4">{o.doctor ?? '—'}</td>
                    </tr>); })}
                {!rows.length && <tr><td colSpan={5} className="px-4 py-10 text-center text-sm text-muted">Nothing here{needle ? ` for “${q.trim()}”` : ''}.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>)}
      {d && !addFor && <OrderDrawer key={d.key} o={d} perms={perms} isDoctor={isDoctor} onAdd={setAdding} onBook={() => book(d)} onClose={() => setSel(null)} />}
      {addFor && <ReportDialog order={addFor} testId={adding!} onClose={() => setAdding(null)} />}
    </div>
  );
}
