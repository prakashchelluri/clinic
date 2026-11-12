import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useOutletContext, useSearchParams } from 'react-router';
import { get, post, qc, errText, fmtTime } from '../api';
import { can } from '../App';
import { Drawer, Empty, Icon, PageHeader, PageSearchBox, Skeleton, ask, fmtDate, toast, usePageSearch } from '../ui';
import { FlagChips } from '../flags';
import { LoadError } from '../procBoard';
import { openViewer } from '../viewer';
import { saveLabValues, findParam, flagFor, rangeText, isOut, type LabDraft } from '../labs';

type Val = { id: string; test: string; value: string; unit: string | null; low: number | null; high: number | null; flag: 'low' | 'normal' | 'high' | 'abnormal' | null };
type Test = { id: string; name: string; params: string[]; expectedOn: string | null; receivedAt: string | null; reviewedAt: string | null; late: boolean; called: string | null; docs: any[]; values?: Val[] };
export type Order = { key: string; encounterId: string; orderNo: number; held?: boolean; orderedAt?: string; patient: { id: string; fullName: string; patientNo: string; phone: string | null; flags?: any }; doctor: string | null; tests: Test[]; state: 'pending' | 'partial' | 'ready' | 'reviewed' | 'doctor_call' | 'closed'; got: number; abnormal?: number;
  outcome: string | null; note: string | null; reviewedBy: string | null; informedHow: string | null; late: string[]; nextDue: string | null };

// how the doctor reviewed it: in the consultation (Keep open for the rest / Complete), or from this page
const REVIEWED: Record<string, string> = { seen: 'reviewed in the consultation', normal: 'reviewed', change_medicines: 'reviewed · medicines changed', needs_visit: 'reviewed · visit needed', will_call: 'reviewed · doctor to call' };
const STEPS = ['Ordered', 'Results in', 'Reviewed'];
const stepOf = (s: Order['state']) => ({ pending: 0, partial: 0, ready: 1, reviewed: 2, doctor_call: 2, closed: 2 })[s];

/** A phone photo can be 10 MB or more; send a smaller copy so it uploads on a weak signal. PDFs go as they are. */
async function prepare(file: File): Promise<{ title: string; mime: string; dataBase64: string }> {
  const raw = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(file); });
  if (!file.type.startsWith('image/') || file.size < 1.5 * 1024 * 1024) return { title: file.name, mime: file.type, dataBase64: raw };
  const img = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = raw; });
  const k = Math.min(1, 2200 / Math.max(img.width, img.height)); const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  return { title: file.name.replace(/\.\w+$/, '') + '.jpg', mime: 'image/jpeg', dataBase64: c.toDataURL('image/jpeg', 0.85) };
}

/** The result for one test: photograph or pick its pages, and/or type its values, save. One test per form, so it is always
 *  clear which pages and values belong to which test (a lab PDF covering two tests is added under each).
 *  inVisit: added at check-in, the patient is about to see the doctor with it, so nothing is sent ahead. */
export function ReportDialog({ order, testId, onClose, inVisit }: { order: Order; testId: string; onClose: () => void; inVisit?: boolean }) {
  const t = order.tests.find((x) => x.id === testId)!;
  const rest = order.tests.filter((x) => !x.receivedAt && !x.reviewedAt && x.id !== testId); // still to come after this one
  const late = !!t.receivedAt || !!t.reviewedAt; // a file for a result already in, or the paper report after the doctor reviewed: nothing is sent
  const [files, setFiles] = useState<File[]>([]); const [note, setNote] = useState('');
  // the values asked for under the test: its usual ones already named (CBC: Hb, WBC, platelets…), plus any the desk adds
  const { cfg } = useOutletContext<any>();
  const [rows, setRows] = useState<LabDraft[]>(() => ((t.params ?? []).length ? t.params : [t.name]).map((n) => ({ test: n, value: '', note: '' })));
  const setRow = (i: number, p: Partial<LabDraft>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const input = useRef<HTMLInputElement>(null);
  const save = useMutation({
    mutationFn: async () => {
      let firstDoc: string | null = null;
      for (const f of files) { const x = await prepare(f); const d: any = await post('/documents', { patientId: order.patient.id, encounterId: order.encounterId, recommendationIds: [t.id], kind: 'report', note: note.trim() || undefined, ...x }); firstDoc ??= d?.id ?? null; }
      // the numbers the doctor will compare, typed from the page in hand; the pages are saved either way
      const saved = (await saveLabValues({ patientId: order.patient.id, encounterId: order.encounterId, recommendationId: t.id, documentId: firstDoc, rows })).length;
      // values with no file (read out on the phone, a WhatsApp text): the values mark the test received
      if (!files.length) await post('/orders/received', { ids: [t.id], note: note.trim() || undefined });
      return saved;
    },
    onSuccess: (n: number) => { qc.invalidateQueries({ queryKey: ['orders'] }); qc.invalidateQueries({ queryKey: ['documents'] }); toast(`${t.name} saved${n ? ` · ${n} value${n === 1 ? '' : 's'}` : ''}${!rest.length && !inVisit && !late ? ' · sent to the doctor' : ''}`); onClose(); },
    onError: (e: any) => toast(e?.body?.code === 'UNSUPPORTED_TYPE' ? 'Only JPG, PNG, WebP and PDF files can be added.' : e?.body?.code === 'TOO_LARGE' ? 'That file is too large (10 MB at most).' : errText(e), 'err'),
  });
  // a file, or at least one typed value (values alone are fine: labs often send them on WhatsApp)
  const blocker = !files.length && !rows.some((r) => r.test.trim() && r.value.trim()) ? 'Add a page, or type the values' : '';
  return (
    <Drawer title={`${t.name} · ${order.patient.fullName}`} subtitle={`Order ${order.orderNo}${rest.length ? ` · still to come: ${rest.map((x) => x.name).join(', ')}` : ''}`} onClose={onClose} width="max-w-xl">
      <div className="space-y-4">
        <div>
          <span className="label">Pages</span>
          <div className="flex flex-wrap gap-2">
            {files.map((f, i) => <span key={i} className="inline-flex items-center gap-2 rounded-xl border border-line bg-surface px-2.5 py-1.5 text-sm">{f.type.startsWith('image/') ? <img src={URL.createObjectURL(f)} alt="" className="h-9 w-9 rounded-md object-cover" /> : <span className="grid h-9 w-9 place-items-center rounded-md bg-clay-soft text-[10px] font-bold text-clay">PDF</span>}<span className="max-w-32 truncate">{f.name}</span><button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))}><Icon name="x" className="h-3.5 w-3.5" /></button></span>)}
            <button type="button" className="btn !min-h-12" onClick={() => input.current?.click()}><Icon name="plus" className="h-4 w-4" />{files.length ? 'Another page' : 'Photo or file'}</button>
          </div>
          <input ref={input} type="file" accept="image/*,application/pdf" multiple className="hidden" onChange={(e) => { setFiles([...files, ...Array.from(e.target.files ?? [])].slice(0, 12)); e.target.value = ''; }} />
          <div className="mt-1.5 text-xs text-muted">The {t.name} report: a PDF or photo from WhatsApp, or a photo with the camera. JPG, PNG, WebP or PDF. No file? Type the values below.</div>
        </div>
        <div>
          <span className="label">Values <span className="font-normal text-muted">· type what the report says; leave a box empty to skip it</span></span>
          <datalist id="lab-params">{(cfg?.labParams ?? []).map((p: any) => <option key={p.name} value={p.name} />)}</datalist>
          <div className="rounded-2xl bg-paper-2/60 p-3">
            {rows.map((r, i) => { const p = findParam(r.test, cfg?.labParams ?? []); const fl = flagFor(r.value, p); const named = i < ((t.params ?? []).length || 1);
              return (
                <div key={i} className="mt-1.5 grid grid-cols-[minmax(0,1.4fr)_130px_minmax(0,1fr)] items-center gap-2 first:mt-0">
                  {named ? <span className="truncate text-[13.5px] text-ink-2">{r.test}</span>
                    : <input list="lab-params" aria-label={`Value name under ${t.name}`} className="input !py-1.5" placeholder="Name, e.g. Vitamin D" value={r.test} onChange={(e) => setRow(i, { test: e.target.value })} />}
                  <input aria-label={`${r.test || 'Value'} for ${t.name}`} className={`input !py-1.5 ${isOut(fl) ? '!text-rose !shadow-[inset_0_0_0_1.5px_var(--color-rose)]' : ''}`} placeholder={p?.expect ? p.expect : ''} value={r.value} onChange={(e) => setRow(i, { value: e.target.value })} />
                  <span className="truncate text-[12px] text-muted">{[p?.unit, rangeText(p)].filter(Boolean).join(' · ')}{fl && fl !== 'normal' && <b className="ml-1.5 text-rose">{fl}</b>}</span>
                </div>); })}
            <button type="button" className="btn btn-ghost btn-sm mt-1.5" onClick={() => setRows([...rows, { test: '', value: '', note: '' }])}><Icon name="plus" className="h-3.5 w-3.5" />Another value</button>
          </div>
        </div>
        <div><label className="label" htmlFor="rep-note">Note (optional)</label><input id="rep-note" className="input" maxLength={200} placeholder="Anything the doctor should know" value={note} onChange={(e) => setNote(e.target.value)} /></div>
        <div className="modal-foot"><span className="mr-auto text-xs text-muted" role="status">{blocker || (late ? 'Kept with this test on the patient’s record' : inVisit ? 'The doctor goes over it in the consultation' : rest.length ? 'The doctor sees the order when every result is in' : 'The last result: the order goes to the doctor for review')}</span><button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={save.isPending || !!blocker} onClick={() => save.mutate()}><Icon name="check" />{save.isPending ? 'Saving…' : late ? 'Save' : rest.length || inVisit ? 'Save result' : 'Save and send to the doctor'}</button></div>
      </div>
    </Drawer>
  );
}


type Stage = 'results' | 'review' | 'done';
const FILTERS: [Stage | 'all', string][] = [['all', 'All'], ['results', 'Results pending'], ['review', 'Review pending'], ['done', 'Completed']];
const ORDER: Stage[] = ['review', 'results', 'done'];
const stageOf = (o: Order): Stage => (o.state === 'pending' || o.state === 'partial' ? 'results' : o.state === 'ready' ? 'review' : 'done');
const refresh = () => { qc.invalidateQueries({ queryKey: ['orders'] }); qc.invalidateQueries({ queryKey: ['documents'] }); };

/** Where the order stands, in two lines: what, then why. */
function standing(o: Order): { t: string; sub: string; tone: string } {
  const n = o.tests.length;
  if (o.state === 'pending' || o.state === 'partial') {
    const t = o.state === 'partial' ? `${o.got} of ${n} received` : n > 1 ? 'Awaiting results' : 'Awaiting result';
    return o.late.length ? { t, sub: `overdue: ${o.late.join(', ')}`, tone: 'text-rose' } : { t, sub: o.nextDue ? `expected ${fmtDate(o.nextDue)}` : 'no date expected', tone: 'text-amber' };
  }
  if (o.state === 'ready') return { t: 'Awaiting doctor review', sub: o.abnormal ? `${o.abnormal} out of range` : 'all results in', tone: o.abnormal ? 'text-rose' : 'text-clay' };
  const missing = o.tests.filter((t) => !t.receivedAt).length;
  return { t: 'Completed', sub: [REVIEWED[o.outcome ?? 'seen'] ?? 'reviewed', o.reviewedBy, missing ? `${missing} result${missing === 1 ? '' : 's'} not added` : null].filter(Boolean).join(' · '), tone: 'text-sage' };
}

const Steps = ({ state }: { state: Order['state'] }) => (
  <ol className="flex flex-wrap items-center gap-x-1 text-[12px] font-semibold text-muted" aria-label={`Step: ${STEPS[stepOf(state)]}`}>
    {STEPS.map((s, i) => <li key={s} className={i === stepOf(state) ? 'text-ink' : i < stepOf(state) ? 'text-sage' : ''}>{i > 0 && <span className="mx-1 font-normal">›</span>}{s}</li>)}
  </ol>
);

/** One order on the right: each test with its values and files, and the one thing to do next. The doctor reviews in the
 *  consultation (Open consultation); the desk adds results, and can still add one after the order is completed. */
function OrderDrawer({ o, perms, isDoctor, onAdd, onClose }: { o: Order; perms: string[]; isDoctor: boolean; onAdd: (testId: string) => void; onClose: () => void }) {
  const nav = useNavigate();
  const canDesk = can(perms, 'worklist.write') || isDoctor; const canUpload = can(perms, 'document.write');
  const s = standing(o); const done = stageOf(o) === 'done';
  const called = useMutation({ mutationFn: (id: string) => post('/orders/called', { id }), onSuccess: () => { refresh(); toast('Noted: lab called', 'info'); }, onError: (e) => toast(errText(e), 'err') });
  const split = useMutation({ mutationFn: () => post('/orders/split', { ids: o.tests.filter((t) => !t.receivedAt).map((t) => t.id) }), onSuccess: () => { refresh(); onClose(); toast('Sent to the doctor · the remaining tests stay pending'); }, onError: (e) => toast(errText(e), 'err') });
  // the consultation already closed (the results came after it): reviewed here, in one tap
  const review = useMutation({ mutationFn: () => post('/orders/review', { encounterId: o.encounterId, orderNo: o.orderNo, outcome: 'normal' }), onSuccess: () => { refresh(); onClose(); toast('Reviewed · completed'); }, onError: (e: any) => toast(e?.body?.code === 'NOT_ALL_RECEIVED' ? 'A result is still missing.' : errText(e), 'err') });
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
                <span className={`text-xs ${t.receivedAt ? 'text-sage' : done ? 'text-muted' : t.late ? 'text-rose' : 'text-muted'}`}>{t.receivedAt ? `received ${fmtTime(t.receivedAt)}` : done ? 'no result added' : t.late ? 'overdue' : t.expectedOn ? `expected ${fmtDate(t.expectedOn)}` : 'pending'}{t.called && !t.receivedAt && !done ? ` · lab called ${fmtTime(t.called)}` : ''}</span>
                {!t.receivedAt && !done && can(perms, 'worklist.write') && <button className="btn btn-sm" disabled={called.isPending} onClick={() => called.mutate(t.id)}>Called lab</button>}
                {canUpload && <button className={`btn btn-sm ${!t.receivedAt && !done ? 'btn-primary' : ''}`} onClick={() => onAdd(t.id)}><Icon name="plus" className="h-3.5 w-3.5" />{t.receivedAt ? 'Add file' : 'Add result'}</button>}
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

        {o.state === 'ready' && (isDoctor
          ? (o.held ? <div className="flex flex-wrap items-center gap-2 border-t border-line/60 pt-4 text-xs text-muted"><span className="min-w-0 flex-1">Review in the consultation: change what the results call for, then Keep open for the rest or Complete.</span><button className="btn btn-primary" onClick={() => nav(`/encounter/${o.encounterId}?review=1`)}>Open consultation</button></div>
            : <div className="flex flex-wrap items-center gap-2 border-t border-line/60 pt-4 text-xs text-muted"><span className="min-w-0 flex-1">The consultation is already closed. Mark these results as reviewed.</span><button className="btn btn-primary" disabled={review.isPending} onClick={() => review.mutate()}><Icon name="check" />Mark reviewed</button></div>)
          : <div className="text-sm text-muted">With the doctor for review.</div>)}

        <div className="flex flex-wrap gap-2 border-t border-line/60 pt-4"><button className="btn btn-sm" onClick={() => nav(`/patients/${o.patient.id}`)}>Open record</button></div>
      </div>
    </Drawer>
  );
}

/** Test reports: every order in one list, filtered by where it stands; a row opens the order on the right.
 *  The front desk adds results; the doctor reviews in the consultation. Completed orders stay 30 days, so a report can still be added. */
export function TestReports() {
  const { perms } = useOutletContext<any>();
  const isDoctor = can(perms, 'encounter.complete');
  const [sp, setSp] = useSearchParams();
  const [f, setF] = useState<Stage | 'all'>(isDoctor ? 'review' : 'all'); const [sel, setSel] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null); // the test a result is being added for
  const [q] = usePageSearch('Find a patient: name, phone or patient no.');
  const data = useQuery<{ counts: Record<string, number>; orders: Order[] }>({ queryKey: ['orders'], queryFn: () => get('/orders'), refetchInterval: 20000 });
  // from the doctor's Today (a consultation already closed): open that order straight away
  const want = sp.get('open');
  useEffect(() => { if (want && data.data?.orders.some((o) => o.key === want)) { setF('all'); setSel(want); const p = new URLSearchParams(sp); p.delete('open'); p.delete('tab'); setSp(p, { replace: true }); } }, [want, !!data.data]);
  if (data.isError && !data.data) return <div><PageHeader title="Test reports" /><LoadError onRetry={() => data.refetch()} /></div>;
  const all = [...(data.data?.orders ?? [])].sort((a, b) => ORDER.indexOf(stageOf(a)) - ORDER.indexOf(stageOf(b))); // the server already puts out-of-range and late first
  const needle = q.trim().toLowerCase();
  const found = needle ? all.filter((o) => `${o.patient.fullName} ${o.patient.phone ?? ''} ${o.patient.patientNo} ${o.tests.map((t) => t.name).join(' ')}`.toLowerCase().includes(needle)) : all;
  const rows = found.filter((o) => f === 'all' || stageOf(o) === f);
  const d = all.find((o) => o.key === sel);
  const addFor = d && adding ? d : null;
  return (
    <div>
      <PageHeader title="Test reports" subtitle="Every test ordered, from result to the doctor's review" />
      {!data.data ? <Skeleton rows={6} /> : !all.length ? <div className="card"><Empty icon="check" title="No tests ordered" hint="Tests the doctor orders appear here until the doctor has reviewed them." /></div> : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Show orders">
            <PageSearchBox placeholder="Find a patient: name, phone or patient no." className="order-last ml-auto !h-9 w-full sm:w-[300px]" />
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
      {d && !addFor && <OrderDrawer key={d.key} o={d} perms={perms} isDoctor={isDoctor} onAdd={setAdding} onClose={() => setSel(null)} />}
      {addFor && <ReportDialog order={addFor} testId={adding!} onClose={() => setAdding(null)} />}
    </div>
  );
}
