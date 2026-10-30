import { useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useOutletContext, useSearchParams } from 'react-router';
import { get, post, qc, errText, fmtTime } from '../api';
import { can } from '../App';
import { Avatar, Chip, Empty, Icon, Modal, PageHeader, Segmented, Skeleton, fmtDate, toast } from '../ui';
import { openViewer } from '../viewer';

type Test = { id: string; name: string; expectedOn: string | null; receivedAt: string | null; reviewedAt: string | null; late: boolean; called: string | null; docs: any[] };
type Order = { key: string; encounterId: string; orderNo: number; patient: { id: string; fullName: string; patientNo: string; phone: string | null }; doctor: string | null; tests: Test[]; state: 'pending' | 'partial' | 'ready' | 'reviewed' | 'doctor_call' | 'closed'; got: number;
  outcome: string | null; note: string | null; reviewedBy: string | null; informedHow: string | null; late: string[]; nextDue: string | null };
type Tab = 'review' | 'collect' | 'explain' | 'done';

const OUTCOMES: [string, string][] = [['normal', 'Normal · explain to the patient'], ['change_medicines', 'Change medicines'], ['needs_visit', 'Needs a visit'], ['will_call', 'I’ll call the patient']];
const OUTCOME_SAYS: Record<string, string> = { normal: 'Normal. Explain to the patient.', change_medicines: 'Medicines are changing. Explain and book a visit if needed.', needs_visit: 'Needs a visit. Book one and explain.', will_call: 'The doctor will call the patient.' };
const SHORT: Record<string, string> = { normal: 'reviewed: normal', change_medicines: 'medicines changed', needs_visit: 'needs a visit', will_call: 'the doctor phoned' };
const HOW: [string, string][] = [['in_person', 'In person'], ['phone', 'Phone'], ['whatsapp', 'WhatsApp']];
const STEPS = ['Pending', 'Partly received', 'Ready for doctor', 'Reviewed', 'Informed'];
const stepOf = (s: Order['state']) => ({ pending: 0, partial: 1, ready: 2, reviewed: 3, doctor_call: 3, closed: 4 })[s];

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
function ReportDialog({ order, testId, onClose }: { order: Order; testId: string; onClose: () => void }) {
  const open = order.tests.filter((t) => !t.receivedAt);
  const [ids, setIds] = useState<string[]>([testId]); const [files, setFiles] = useState<File[]>([]); const [note, setNote] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const save = useMutation({
    mutationFn: async () => { for (const f of files) { const x = await prepare(f); await post('/documents', { patientId: order.patient.id, encounterId: order.encounterId, recommendationIds: ids, kind: 'report', note: note.trim() || undefined, ...x }); } },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['orders'] }); qc.invalidateQueries({ queryKey: ['documents'] }); toast(`Saved for ${ids.map((i) => order.tests.find((t) => t.id === i)?.name).join(', ')}`); onClose(); },
    onError: (e: any) => toast(e?.body?.code === 'UNSUPPORTED_TYPE' ? 'Only JPG, PNG, WebP and PDF files can be added.' : e?.body?.code === 'TOO_LARGE' ? 'That file is too large (10 MB at most).' : errText(e), 'err'),
  });
  const blocker = !ids.length ? 'Pick which tests this is for' : !files.length ? 'Add at least one page' : '';
  return (
    <Modal title={`Report for ${order.patient.fullName}`} subtitle={`Order ${order.orderNo} · ${order.tests.map((t) => t.name).join(', ')}`} onClose={onClose} width="max-w-xl">
      <div className="space-y-4">
        <div>
          <span className="label">Pages</span>
          <div className="flex flex-wrap gap-2">
            {files.map((f, i) => <span key={i} className="inline-flex items-center gap-2 rounded-xl border border-line bg-white px-2.5 py-1.5 text-sm">{f.type.startsWith('image/') ? <img src={URL.createObjectURL(f)} alt="" className="h-9 w-9 rounded-md object-cover" /> : <span className="grid h-9 w-9 place-items-center rounded-md bg-clay-soft text-[10px] font-bold text-clay">PDF</span>}<span className="max-w-32 truncate">{f.name}</span><button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))}><Icon name="x" className="h-3.5 w-3.5" /></button></span>)}
            <button type="button" className="btn !min-h-12" onClick={() => input.current?.click()}><Icon name="plus" className="h-4 w-4" />{files.length ? 'Another page' : 'Photo or file'}</button>
          </div>
          <input ref={input} type="file" accept="image/*,application/pdf" capture="environment" multiple className="hidden" onChange={(e) => { setFiles([...files, ...Array.from(e.target.files ?? [])].slice(0, 12)); e.target.value = ''; }} />
          <div className="mt-1.5 text-xs text-muted">On a phone this opens the camera. Keep the whole page in view, flat. JPG, PNG, WebP or PDF.</div>
        </div>
        <div><span className="label">Which tests is this for</span><div className="flex flex-wrap gap-1.5">{open.map((t) => <button key={t.id} type="button" aria-pressed={ids.includes(t.id)} className={`toggle-opt !py-2 ${ids.includes(t.id) ? 'on' : ''}`} onClick={() => setIds(ids.includes(t.id) ? ids.filter((x) => x !== t.id) : [...ids, t.id])}>{t.name}</button>)}</div></div>
        <div><label className="label" htmlFor="rep-note">Note (optional)</label><input id="rep-note" className="input" maxLength={200} placeholder="Anything the doctor should know" value={note} onChange={(e) => setNote(e.target.value)} /></div>
        <div className="modal-foot"><span className="mr-auto text-xs text-muted" role="status">{blocker}</span><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={save.isPending || !!blocker} onClick={() => save.mutate()}><Icon name="check" />{save.isPending ? 'Saving…' : 'Save · tell the doctor'}</button></div>
      </div>
    </Modal>
  );
}

/** The doctor looks at the whole order once and says what happens next: about fifteen seconds. */
function ReviewDialog({ order, onClose }: { order: Order; onClose: () => void }) {
  const [outcome, setOutcome] = useState('normal'); const [note, setNote] = useState('');
  const docs = order.tests.flatMap((t) => t.docs.map((d) => ({ ...d, test: t.name })));
  const save = useMutation({
    mutationFn: () => post('/orders/review', { encounterId: order.encounterId, orderNo: order.orderNo, outcome, note: note.trim() || undefined }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['orders'] }); qc.invalidateQueries({ queryKey: ['documents', order.patient.id] }); toast('Reviewed · the front desk can explain it'); onClose(); },
    onError: (e: any) => toast(e?.body?.code === 'NOT_ALL_RECEIVED' ? 'A report is still missing.' : errText(e), 'err'),
  });
  return (
    <Modal title={`${order.patient.fullName} · ${order.tests.map((t) => t.name).join(', ')}`} subtitle={`${order.patient.patientNo} · all ${order.tests.length} received${order.doctor ? ` · ordered by ${order.doctor}` : ''}`} onClose={onClose} width="max-w-2xl">
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {docs.map((d, i) => (
            <button key={d.id} type="button" className="card card-hover !p-2 flex items-center gap-2 text-left" aria-label={`Open ${d.title}`} onClick={() => openViewer({ docs, index: i, who: order.patient.fullName, canDelete: false })}>
              {d.mime.startsWith('image/') ? <img src={`/api/documents/${d.id}/file`} alt="" className="h-14 w-14 rounded-lg object-cover bg-paper-2" loading="lazy" /> : <span className="grid h-14 w-14 place-items-center rounded-lg bg-clay-soft text-[11px] font-bold text-clay">PDF</span>}
              <span className="min-w-0"><span className="block truncate text-sm font-medium">{d.test}</span><span className="block text-[11px] text-muted">{d.title.slice(0, 22)}</span>{d.note && <span className="block truncate text-[11px] text-ink-2">{d.note}</span>}</span>
            </button>))}
          {docs.length === 0 && <div className="col-span-full text-sm text-muted">No files were attached.</div>}
        </div>
        <div><span className="label">What now</span><div className="flex flex-wrap gap-1.5" role="radiogroup">{OUTCOMES.map(([k, l]) => <button key={k} type="button" role="radio" aria-checked={outcome === k} className={`toggle-opt !py-2 ${outcome === k ? 'on' : ''}`} onClick={() => setOutcome(k)}>{l}</button>)}</div></div>
        <div><label className="label" htmlFor="rev-note">Note for the front desk (optional)</label><input id="rev-note" className="input" maxLength={300} placeholder="“LFT slightly high, repeat in a month”" value={note} onChange={(e) => setNote(e.target.value)} /></div>
        <div className="modal-foot"><span className="mr-auto text-xs text-muted">The front desk sees your choice at once.</span><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate()}><Icon name="check" />Reviewed</button></div>
      </div>
    </Modal>
  );
}

const Steps = ({ state }: { state: Order['state'] }) => (
  <div className="flex flex-wrap items-center gap-x-1 text-[11.5px] font-semibold text-muted" aria-label={`Status: ${STEPS[stepOf(state)]}`}>
    {STEPS.map((s, i) => <span key={s} className={i === stepOf(state) ? 'text-ink' : i < stepOf(state) ? 'text-sage' : ''}>{i > 0 && <span className="mx-1 font-normal">›</span>}{s}</span>)}
  </div>
);

function OrderCard({ o, perms, isDoctor, onAdd, onReview }: { o: Order; perms: string[]; isDoctor: boolean; onAdd: (o: Order, testId: string) => void; onReview: (o: Order) => void }) {
  const canDesk = can(perms, 'worklist.write') || isDoctor; const canUpload = can(perms, 'document.write');
  const [how, setHow] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ['orders'] });
  const called = useMutation({ mutationFn: (id: string) => post('/orders/called', { id }), onSuccess: () => { refresh(); toast('Noted: lab called', 'info'); }, onError: (e) => toast(errText(e), 'err') });
  const inform = useMutation({ mutationFn: (h: string) => post('/orders/inform', { encounterId: o.encounterId, orderNo: o.orderNo, how: h }), onSuccess: () => { refresh(); toast('Done · report closed'); }, onError: (e: any) => toast(e?.body?.code === 'DOCTOR_WILL_CALL' ? 'The doctor said she will call this patient.' : errText(e), 'err') });
  const split = useMutation({ mutationFn: () => post('/orders/split', { ids: o.tests.filter((t) => !t.receivedAt).map((t) => t.id) }), onSuccess: () => { refresh(); toast('Reviewing what is in · the rest is its own order'); }, onError: (e) => toast(errText(e), 'err') });
  const day = (d: string | null) => (d ? fmtDate(d) : '');
  return (
    <div className="mt-2.5 rounded-2xl bg-white/70 px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <b className="text-[15px]">Order {o.orderNo}</b><span className="min-w-0 flex-1 text-sm text-ink-2">{o.tests.map((t) => t.name).join(', ')}</span>
        {o.state === 'partial' && <Chip tone="amber">{o.got} of {o.tests.length} received</Chip>}
        {o.state === 'pending' && (o.late.length ? <Chip tone="rose">overdue · {o.late.join(', ')}</Chip> : o.nextDue ? <Chip tone="sky">expected {day(o.nextDue)}</Chip> : null)}
        {o.state === 'partial' && o.late.length > 0 && <Chip tone="rose">late · {o.late.join(', ')}</Chip>}
        {o.state === 'doctor_call' && <Chip tone="amber">doctor will call</Chip>}
      </div>
      <div className="mt-1"><Steps state={o.state} /></div>
      {(o.state === 'pending' || o.state === 'partial') && <div className="mt-2 divide-y divide-line/60">
        {o.tests.map((t) => (
          <div key={t.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
            {t.receivedAt ? <Chip tone="sage">received {fmtTime(t.receivedAt)}</Chip> : t.late ? <Chip tone="rose">late</Chip> : <Chip tone="sky">{t.expectedOn ? day(t.expectedOn) : 'pending'}</Chip>}
            <span className="min-w-0 flex-1"><b>{t.name}</b>{!t.receivedAt && t.expectedOn && <span className="text-muted"> · expected {day(t.expectedOn)}</span>}{t.called && !t.receivedAt && <span className="text-muted"> · lab called {fmtTime(t.called)}</span>}</span>
            {t.docs.length > 0 && <button className="btn btn-sm" onClick={() => openViewer({ docs: t.docs, index: 0, who: o.patient.fullName, canDelete: false })}>View</button>}
            {!t.receivedAt && can(perms, 'worklist.write') && <button className="btn btn-sm" disabled={called.isPending} onClick={() => called.mutate(t.id)}>Called lab</button>}
            {!t.receivedAt && canUpload && <button className="btn btn-sm btn-primary !min-h-11" onClick={() => onAdd(o, t.id)}><Icon name="plus" className="h-3.5 w-3.5" />Add report</button>}
          </div>))}
        {o.state === 'partial' && isDoctor && <div className="flex flex-wrap items-center gap-2 pt-2 text-xs text-muted"><span>The doctor reviews this order when every test is in.</span><button className="btn btn-sm ml-auto" disabled={split.isPending} onClick={() => split.mutate()}>Review what is in</button></div>}
      </div>}
      {o.state === 'ready' && <div className="mt-2 flex flex-wrap items-center gap-2 text-sm"><span className="text-muted">All {o.tests.length} received{o.tests.some((t) => t.docs.length) ? ` · ${o.tests.reduce((n, t) => n + t.docs.length, 0)} files` : ''}.</span>
        {o.tests.some((t) => t.docs.length) && <button className="btn btn-sm" onClick={() => { const docs = o.tests.flatMap((t) => t.docs); openViewer({ docs, index: 0, who: o.patient.fullName, canDelete: false }); }}>View</button>}
        <span className="ml-auto" />{isDoctor ? <button className="btn btn-sm btn-primary !min-h-11" onClick={() => onReview(o)}>Review</button> : <Chip>waiting for the doctor</Chip>}</div>}
      {(o.state === 'reviewed' || o.state === 'doctor_call') && <div className={`mt-2 rounded-xl px-3 py-2.5 text-sm ${o.state === 'doctor_call' ? 'bg-[#FFF6DD]' : 'bg-sage-soft'}`}>
        <div className="text-[11px] font-bold uppercase tracking-wider text-muted">{o.reviewedBy ?? 'Doctor'} says</div>
        <div className="font-semibold">{OUTCOME_SAYS[o.outcome ?? 'normal']}</div>{o.note && <div className="mt-0.5 text-ink-2">{o.note}</div>}
        {(o.state === 'reviewed' || isDoctor) && canDesk && <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {!how ? <button className="btn btn-sm btn-primary !min-h-11" onClick={() => setHow(true)}>{o.state === 'doctor_call' ? 'I phoned the patient' : 'Informed'} <Icon name="chevR" className="h-3.5 w-3.5 rotate-90" /></button>
            : <><span className="text-xs text-muted">How?</span>{HOW.map(([k, l]) => <button key={k} className="toggle-opt !py-2" disabled={inform.isPending} onClick={() => inform.mutate(k)}>{l}</button>)}<button className="btn btn-ghost btn-sm" onClick={() => setHow(false)}>Back</button></>}
        </div>}
      </div>}
      {o.state === 'closed' && <div className="mt-1.5 text-xs text-muted">Closed · {SHORT[o.outcome ?? 'normal']}{o.informedHow ? ` · told ${o.informedHow === 'in_person' ? 'in person' : `by ${o.informedHow === 'phone' ? 'phone' : 'WhatsApp'}`}` : ''}</div>}
    </div>
  );
}

/** Test reports: every order from "pending" to "told the patient". The front desk collects and explains; the doctor reviews once an order is complete. */
export function TestReports() {
  const { perms } = useOutletContext<any>(); const nav = useNavigate();
  const isDoctor = can(perms, 'encounter.complete');
  const [sp, setSp] = useSearchParams();
  const tab: Tab = (['review', 'collect', 'explain', 'done'] as Tab[]).includes(sp.get('tab') as Tab) ? (sp.get('tab') as Tab) : isDoctor ? 'review' : 'collect';
  const data = useQuery<{ counts: Record<Tab, number>; orders: Order[] }>({ queryKey: ['orders'], queryFn: () => get('/orders'), refetchInterval: 20000 });
  const [adding, setAdding] = useState<{ o: Order; testId: string } | null>(null); const [reviewing, setReviewing] = useState<Order | null>(null);
  const tabOf = (o: Order): Tab => (o.state === 'pending' || o.state === 'partial' ? 'collect' : o.state === 'ready' ? 'review' : o.state === 'closed' ? 'done' : 'explain');
  const rows = (data.data?.orders ?? []).filter((o) => tabOf(o) === tab);
  const waiting = tab === 'review' ? (data.data?.orders ?? []).filter((o) => o.state === 'partial') : [];
  const groups = [...[...rows, ...waiting].reduce((m, o) => m.set(o.patient.id, [...(m.get(o.patient.id) ?? []), o]), new Map<string, Order[]>())];
  const c = data.data?.counts;
  return (
    <div>
      <PageHeader title="Test reports" subtitle={tab === 'review' ? 'Reports the doctor has not looked at yet' : tab === 'collect' ? 'Tests ordered that have not come back' : tab === 'explain' ? 'The doctor has reviewed these. Tell the patient.' : 'Closed today'}>
        <Segmented<Tab> value={tab} onChange={(t) => setSp({ tab: t }, { replace: true })} options={[...(isDoctor ? [{ value: 'review' as Tab, label: 'To review', count: c?.review || undefined }] : []), { value: 'collect', label: 'To collect', count: c?.collect || undefined }, { value: 'explain', label: 'To explain', count: c?.explain || undefined }, { value: 'done', label: 'Done today', count: c?.done || undefined }]} />
      </PageHeader>
      {data.isLoading ? <div className="card"><Skeleton rows={4} /></div> : groups.length === 0 ? <div className="card"><Empty icon="check" title={tab === 'review' ? 'Nothing to review' : tab === 'collect' ? 'No reports to collect' : tab === 'explain' ? 'Nobody to explain to' : 'Nothing closed yet today'} hint={tab === 'collect' ? 'When the doctor orders tests, each order shows here until every report is in.' : tab === 'review' ? 'An order appears here when every report in it has been added.' : undefined} /></div> : (
        <div className="space-y-3 anim-fade-up">
          {tab === 'review' && rows.length === 0 && <div className="text-sm text-muted">Nothing is complete yet. These are waiting for reports:</div>}
          {groups.map(([pid, os]) => (
            <div key={pid} className="card !p-4">
              <div className="flex flex-wrap items-center gap-2"><Avatar name={os[0].patient.fullName} /><button className="text-[16px] font-semibold hover:text-clay" onClick={() => nav(`/patients/${pid}`)}>{os[0].patient.fullName}</button><span className="text-xs text-muted">{os[0].patient.patientNo}{os[0].patient.phone ? ` · ${os[0].patient.phone}` : ''}{os[0].doctor ? ` · ${os[0].doctor}` : ''}</span></div>
              {os.map((o) => <OrderCard key={o.key} o={o} perms={perms} isDoctor={isDoctor} onAdd={(x, t) => setAdding({ o: x, testId: t })} onReview={setReviewing} />)}
            </div>))}
        </div>)}
      {adding && <ReportDialog order={adding.o} testId={adding.testId} onClose={() => setAdding(null)} />}
      {reviewing && <ReviewDialog order={reviewing} onClose={() => setReviewing(null)} />}
    </div>
  );
}
