import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useOutletContext } from 'react-router';
import { get, post, qc, errText } from '../api';
import { Chip, Empty, Icon, Modal, Section, Skeleton, ask, fmtDate, toast } from '../ui';

type Aud = 'all' | 'recent' | 'lapsed' | 'followup' | 'course' | 'pick';
const AUDIENCES: { key: Aud; label: string; days?: number }[] = [
  { key: 'all', label: 'Everyone' }, { key: 'recent', label: 'Seen in the last 30 days', days: 30 }, { key: 'lapsed', label: 'Not seen for 6 months', days: 180 },
  { key: 'followup', label: 'Follow-up overdue' }, { key: 'course', label: 'In a procedure course' }, { key: 'pick', label: 'Pick patients' },
];
const TEMPLATES = [
  { title: 'Clinic closed', text: 'Dear {name}, {clinic} will be closed on [date]. We reopen on [date]. For anything urgent please call us. Sorry for the inconvenience.' },
  { title: 'Camp or offer', text: 'Hello {name}, {clinic} is holding a skin check camp on [date], [time]. Everyone is welcome. Call us to book your place.' },
  { title: 'Reminder to visit', text: 'Hello {name}, this is {clinic}. It has been a while since your last visit. Call us or book online to see the doctor.' },
  { title: 'Blank', text: '' },
];

/** Message many patients: who, what to say, send. Demo: messages are recorded in the outbox but not sent until WhatsApp is connected. */
export function BroadcastDialog({ onClose, onSent }: { onClose: () => void; onSent: () => void }) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [aud, setAud] = useState<Aud>('all'); const days = AUDIENCES.find((a) => a.key === aud)?.days;
  const [checked, setChecked] = useState<Set<string>>(new Set()); const [find, setFind] = useState('');
  const [tpl, setTpl] = useState(2); const [body, setBody] = useState(TEMPLATES[2].text); const [tried, setTried] = useState(false);
  const [testPhone, setTestPhone] = useState(''); const [testing, setTesting] = useState(false);
  // "Pick patients" lists everyone with nobody ticked; the other groups start with everyone ticked
  const pre = useQuery({ queryKey: ['broadcast-preview', aud, days], queryFn: () => post('/broadcasts/preview', { audience: aud === 'pick' ? 'all' : aud, days }) });
  useEffect(() => { if (pre.data) setChecked(aud === 'pick' ? new Set() : new Set(pre.data.recipients.map((r: any) => r.id))); }, [pre.data, aud]);
  const all: any[] = pre.data?.recipients ?? [];
  const shown = useMemo(() => all.filter((r) => !find.trim() || r.fullName.toLowerCase().includes(find.toLowerCase()) || (r.phone ?? '').includes(find) || r.patientNo.toLowerCase().includes(find.toLowerCase())), [all, find]);
  const toggle = (id: string) => setChecked((c) => { const n = new Set(c); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const first = all.find((r) => checked.has(r.id));
  const { cfg } = useOutletContext<any>(); const clinic = cfg?.tenant?.name ?? 'your clinic';
  const sample = body.replace(/\{name\}/g, first?.fullName ?? 'Patient name').replace(/\{clinic\}/g, clinic);
  const send = useMutation({ mutationFn: () => post('/broadcasts', { audience: aud, days, ids: [...checked], body: body.trim(), title: tpl < 3 && body === TEMPLATES[tpl].text ? TEMPLATES[tpl].title : undefined }),
    onSuccess: (b: any) => { qc.invalidateQueries({ queryKey: ['broadcasts'] }); qc.invalidateQueries({ queryKey: ['messages'] }); toast(`Recorded for ${b.recipients} patients (demo, not sent)`); onSent(); onClose(); }, onError: (e) => toast(errText(e), 'err') });
  const confirmSend = async () => { const a = await ask({ title: `Send this message to ${checked.size} patient${checked.size === 1 ? '' : 's'}?`, body: 'This is a demo: the messages are recorded but not sent until WhatsApp is connected.', confirmLabel: `Send to ${checked.size}`, cancelLabel: 'Back' }); if (a) send.mutate(); };
  const next = () => { setTried(true); if (step === 1 && checked.size > 0) { setStep(2); setTried(false); } else if (step === 2 && body.trim()) { setStep(3); setTried(false); } };
  const stepChip = (n: number, t: string) => <span className={`rounded-full px-3 py-1 text-xs font-bold ${step === n ? 'bg-ink text-white' : 'bg-ink/6 text-muted'}`}>{n} {t}</span>;

  return (
    <Modal title="Message patients" onClose={onClose} width="max-w-xl">
      <div className="space-y-4">
        <div className="flex gap-1.5">{stepChip(1, 'Who')}{stepChip(2, 'Message')}{stepChip(3, 'Send')}</div>

        {step === 1 && <>
          <div><div className="label">Send to</div><div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Who gets the message">{AUDIENCES.map((a) => <button key={a.key} role="radio" aria-checked={aud === a.key} className={`toggle-opt ${aud === a.key ? 'on' : ''}`} onClick={() => setAud(a.key)}>{a.label}</button>)}</div></div>
          <div className="rounded-2xl bg-white/70 px-4 py-3">
            {pre.isLoading ? <span className="text-sm text-muted">Counting…</span> : <><b className="text-[15px]">{checked.size} patient{checked.size === 1 ? '' : 's'}</b> <span className="text-sm text-muted">will get this</span>
              {(pre.data?.skipped ?? 0) > 0 && <div className="text-xs text-muted mt-0.5">{pre.data.skipped} left out: no valid mobile number</div>}</>}
          </div>
          <div>
            <div className="mb-1.5 flex items-center gap-2"><span className="label !mb-0">Recipients</span><span className="ml-auto" />
              <button className="text-xs underline" onClick={() => setChecked(new Set([...checked, ...shown.map((r) => r.id)]))}>Tick all shown</button><button className="text-xs underline" onClick={() => { const n = new Set(checked); shown.forEach((r) => n.delete(r.id)); setChecked(n); }}>Untick all shown</button></div>
            <input className="input !py-2 mb-2" aria-label="Search recipients" placeholder="Search name, phone or ID" value={find} onChange={(e) => setFind(e.target.value)} />
            <div className="card-flat max-h-64 overflow-y-auto">
              {pre.isLoading ? <div className="p-3"><Skeleton rows={3} /></div> : shown.length === 0 ? <div className="p-4 text-sm text-muted">{all.length === 0 ? 'Nobody matches this group.' : 'No match.'}</div> : shown.slice(0, 300).map((r) => (
                <label key={r.id} className="row cursor-pointer text-sm"><input type="checkbox" className="h-4 w-4 accent-clay" checked={checked.has(r.id)} onChange={() => toggle(r.id)} /><span className={`min-w-0 flex-1 truncate ${checked.has(r.id) ? '' : 'text-muted'}`}><b className="font-medium">{r.fullName}</b> <span className="text-xs text-muted">{r.phone} · {r.patientNo}</span></span></label>))}
              {shown.length > 300 && <div className="p-2 text-center text-xs text-muted">Showing the first 300. Use search to narrow the list.</div>}
            </div>
          </div>
          {tried && checked.size === 0 && <div className="text-xs text-rose">Tick at least one patient.</div>}
        </>}

        {step === 2 && <>
          <div><div className="label">Start from</div><div className="flex flex-wrap gap-1.5">{TEMPLATES.map((t, i) => <button key={t.title} className={`toggle-opt ${tpl === i ? 'on' : ''}`} onClick={() => { setTpl(i); setBody(t.text); }}>{t.title}</button>)}</div></div>
          <div><label className="label" htmlFor="bc-body">Message</label>
            <textarea id="bc-body" autoFocus className={`input min-h-[110px] ${tried && !body.trim() ? '!border-rose' : ''}`} maxLength={1000} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write your message. {name} and {clinic} are filled in for each patient." />
            <div className="mt-1 text-right text-xs text-muted">{body.length} / 1000 · {'{name}'} and {'{clinic}'} are filled in for each patient</div>
            {tried && !body.trim() && <div className="text-xs text-rose">Write the message first.</div>}</div>
          <div><div className="label">Preview for {first?.fullName ?? 'a patient'}</div><div className="whitespace-pre-wrap rounded-2xl rounded-br-md bg-[#DCF8C6] px-4 py-3 text-sm leading-relaxed">{sample || <span className="text-muted">Your message appears here.</span>}</div></div>
          <div className="flex flex-wrap items-center gap-2">
            {testing ? <><input className="input !w-44 !py-2" inputMode="numeric" maxLength={10} aria-label="Your mobile number" placeholder="Your 10-digit mobile" value={testPhone} onChange={(e) => setTestPhone(e.target.value.replace(/\D/g, ''))} />
              <button className="btn btn-sm btn-primary" disabled={testPhone.length !== 10 || !body.trim()} onClick={async () => { try { await post('/broadcasts/test', { body: body.trim(), phone: testPhone }); toast('Test recorded for you (demo, not sent)', 'info'); setTesting(false); } catch (e) { toast(errText(e), 'err'); } }}>Send test</button></>
              : <button className="btn btn-sm" onClick={() => setTesting(true)}>Send me a test</button>}
          </div>
        </>}

        {step === 3 && <>
          <div className="rounded-2xl bg-amber-soft px-4 py-3 text-sm text-amber"><b>Demo mode.</b> Messages are recorded but not sent. Connect WhatsApp in Settings to send for real.</div>
          <div className="rounded-2xl bg-white/70 px-4 py-3 text-sm"><b>{checked.size} patient{checked.size === 1 ? '' : 's'}</b> · {AUDIENCES.find((a) => a.key === aud)?.label}<div className="mt-1.5 whitespace-pre-wrap text-xs text-muted">{body}</div></div>
        </>}

        <div className="modal-foot">
          {step === 1 ? <button className="btn btn-ghost" onClick={onClose}>Cancel</button> : <button className="btn btn-ghost" onClick={() => setStep((step - 1) as 1 | 2)}>Back</button>}
          {step < 3 ? <button className="btn btn-primary" onClick={next}>Next</button> : <button className="btn btn-primary" disabled={send.isPending || checked.size === 0} onClick={confirmSend}><Icon name="check" />Send to {checked.size} patient{checked.size === 1 ? '' : 's'}</button>}
        </div>
      </div>
    </Modal>
  );
}

const when = (d: string) => new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });

/** Every bulk message that went out (or was recorded in demo), newest first. */
export function SentMessages() {
  const list = useQuery({ queryKey: ['broadcasts'], queryFn: () => get('/broadcasts') });
  const [open, setOpen] = useState<string | null>(null);
  const detail = useQuery({ queryKey: ['broadcast', open], queryFn: () => get(`/broadcasts/${open}`), enabled: !!open });
  const rows: any[] = list.data ?? [];
  return (
    <div className="space-y-3">
      <div className="card !py-3 !bg-amber-soft/60 text-sm"><b>Demo mode</b> <span className="text-muted">· messages are recorded but not sent until WhatsApp is connected</span></div>
      <Section>
        {list.isLoading ? <Skeleton rows={3} /> : rows.length === 0 ? <Empty icon="message" title="No messages sent yet" hint="Use “Message patients” to write to a group of patients." /> : rows.map((b) => (
          <button key={b.id} className="row w-full text-left" onClick={() => setOpen(b.id)}>
            <span className="w-28 shrink-0 text-xs text-muted">{when(b.createdAt)}</span>
            <span className="min-w-0 flex-1"><span className="block truncate font-medium">{b.title}</span><span className="block truncate text-xs text-muted">{b.body}</span><span className="block text-xs text-muted">{b.audienceLabel} · by {b.by ?? 'staff'}</span></span>
            <span className="shrink-0 text-right"><b>{b.recipients}</b><span className="block text-xs text-muted">recipients</span></span>
            <Chip tone="amber">{b.mode}</Chip>
          </button>))}
      </Section>
      {open && <Modal title={detail.data?.title ?? 'Message'} subtitle={detail.data ? `${when(detail.data.createdAt)} · ${detail.data.audienceLabel} · ${detail.data.recipients} recipients` : undefined} onClose={() => setOpen(null)} width="max-w-lg">
        {!detail.data ? <Skeleton rows={4} /> : <div className="space-y-4">
          <div className="whitespace-pre-wrap rounded-2xl bg-[#DCF8C6] px-4 py-3 text-sm leading-relaxed">{detail.data.body}</div>
          <div><div className="label">Who got it</div><div className="card-flat max-h-64 overflow-y-auto">{detail.data.to.map((t: any, i: number) => <div key={i} className="row text-sm"><span className="min-w-0 flex-1 truncate">{t.name ?? 'Unknown'} <span className="text-xs text-muted">{t.phone}</span></span><Chip tone={t.status === 'sent' ? 'sage' : 'amber'}>{t.status === 'logged' ? 'demo' : t.status}</Chip></div>)}</div></div>
        </div>}
      </Modal>}
    </div>
  );
}

/** What a patient was sent: bulk messages beside the appointment reminders. */
export function PatientMessages({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['messages', 'patient', id], queryFn: () => get(`/messages?patientId=${id}&limit=20`) });
  const rows: any[] = q.data ?? [];
  if (q.isLoading) return null;
  return (
    <Section title={<>Messages <span className="text-muted font-normal">· {rows.length}</span></>} delay={120}>
      {rows.length === 0 ? <div className="p-4 text-sm text-muted">Nothing sent to this patient yet.</div> : rows.map((m) => (
        <div key={m.id} className="row text-sm">
          <div className="min-w-0 flex-1"><div className="truncate font-medium">{m.kind === 'broadcast' ? m.body : m.kind.replace('_', ' ')}</div><div className="text-xs text-muted">{fmtDate(m.sendAfter)} · {m.kind === 'broadcast' ? 'broadcast' : 'automatic'}</div></div>
          <Chip tone={m.status === 'sent' ? 'sage' : m.status === 'failed' ? 'rose' : 'amber'}>{m.status === 'logged' && m.kind === 'broadcast' ? 'demo' : m.status}</Chip>
        </div>))}
    </Section>
  );
}
