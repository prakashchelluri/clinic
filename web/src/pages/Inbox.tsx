import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useOutletContext } from 'react-router';
import { get, post, qc, errText } from '../api';
import { can } from '../App';
import { Chip, Drawer, Icon, PageHeader, fmtDate, fmtTime, toast } from '../ui';
import { DataTable, type Col } from '../table';

type Tab = 'staff' | 'assistant' | 'closed' | 'all';
const STATUS: Record<string, { label: string; tone: any }> = { staff: { label: 'Needs reply', tone: 'rose' }, assistant: { label: 'Assistant', tone: 'sage' }, closed: { label: 'Closed', tone: undefined } };
const when = (at: string) => { const d = at.slice(0, 10); const today = new Date().toLocaleDateString('en-CA'); return d === today ? fmtTime(at) : `${fmtDate(d)}, ${fmtTime(at)}`; };
const who = (c: any) => c.patients?.length ? c.patients.map((p: any) => p.fullName).join(', ') : 'New number';
const refresh = () => { qc.invalidateQueries({ queryKey: ['chats'] }); qc.invalidateQueries({ queryKey: ['followups', 'menu'] }); };

/** WhatsApp: the assistant answers patients; what it hands over waits here for the front desk. */
export function Inbox() {
  const { perms } = useOutletContext<any>();
  const [tab, setTab] = useState<Tab>('staff');
  const [open, setOpen] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const q = useQuery({ queryKey: ['chats'], queryFn: () => get('/chats?status=all'), refetchInterval: 10000 });
  const all: any[] = q.data?.chats ?? [];
  const rows = tab === 'all' ? all : all.filter((c) => c.status === tab);
  const canWrite = can(perms, 'appointment.write');
  const n = (t: Tab) => (t === 'all' ? all : all.filter((c) => c.status === t)).length;

  const columns: Col<any>[] = [
    { key: 'name', label: 'Patient', fixed: true, sort: (c) => who(c).toLowerCase(), csv: (c) => who(c), cell: (c) => <span className={c.unread ? 'font-semibold' : ''}>{who(c)}</span> },
    { key: 'phone', label: 'Phone', csv: (c) => c.phone, cell: (c) => <span className="whitespace-nowrap tabular-nums">{c.phone}</span> },
    { key: 'last', label: 'Last message', cell: (c) => <span className="block max-w-[360px] truncate text-ink-2">{c.last ? `${c.last.by === 'patient' ? '' : `${c.last.by === 'WhatsApp assistant' ? 'Assistant' : c.last.by}: `}${c.last.body}` : ''}</span> },
    { key: 'status', label: 'Status', sort: (c) => c.status, csv: (c) => STATUS[c.status]?.label, cell: (c) => <span className="inline-flex items-center gap-2 whitespace-nowrap"><Chip tone={STATUS[c.status]?.tone}>{STATUS[c.status]?.label ?? c.status}</Chip>{c.status === 'staff' && c.reason && <span className="text-[12.5px] text-muted">{c.reason}</span>}</span> },
    { key: 'at', label: 'When', align: 'right', sort: (c) => c.lastAt, csv: (c) => c.lastAt, cell: (c) => <span className="whitespace-nowrap text-muted">{when(c.lastAt)}{c.unread > 0 && <b className="ml-2 rounded-full bg-clay px-1.5 text-[11px] text-white">{c.unread}</b>}</span> },
  ];

  return (
    <div>
      <PageHeader title="WhatsApp">{canWrite && <button type="button" className="btn btn-primary" onClick={() => setTesting(true)}><Icon name="message" className="h-4 w-4" />Test chat</button>}</PageHeader>
      {q.data && (!q.data.whatsappConnected || !q.data.assistantOn) && <div className="card mb-3 !py-3 !bg-amber-soft/60 text-sm">
        {!q.data.whatsappConnected && <div><b>WhatsApp is not connected.</b> <span className="text-muted">Replies are kept here but do not reach a phone. Use Test chat to try the assistant.</span></div>}
        {!q.data.assistantOn && <div><b>The assistant is off.</b> <span className="text-muted">Every message comes here for the front desk to answer.</span></div>}
      </div>}
      <DataTable
        id="chats" rows={rows} rowKey={(c) => c.id} columns={columns} exportName="whatsapp-chats"
        tabs={[{ value: 'staff', label: 'Needs reply', count: n('staff') }, { value: 'assistant', label: 'With assistant', count: n('assistant') }, { value: 'closed', label: 'Closed', count: n('closed') }, { value: 'all', label: 'All', count: n('all') }]}
        tab={tab} onTab={(v) => setTab(v as Tab)}
        loading={q.isLoading} error={q.error} onRetry={() => q.refetch()} onRow={(c) => setOpen(c.id)} selected={open}
        empty={{ title: tab === 'staff' ? 'Nothing waiting' : 'No chats', hint: tab === 'staff' ? 'The assistant passes a chat here when a patient needs a person.' : undefined }}
        search={{ placeholder: 'Name or phone', text: (c) => [who(c), c.phone] }} sort={{ key: 'at', dir: -1 }}
      />
      {open && <ChatDrawer id={open} canWrite={canWrite} onClose={() => setOpen(null)} />}
      {testing && <TestChat onClose={() => { setTesting(false); refresh(); }} />}
    </div>
  );
}

/** Buttons or list rows sent with a line, as the patient sees them. In Test chat they can be tapped. */
function Options({ o, onTap }: { o: any; onTap?: (id: string, title: string) => void }) {
  return (
    <div className={`mt-2 ${o.kind === 'list' ? 'space-y-1' : 'flex flex-wrap gap-1.5'}`}>
      {o.kind === 'list' && <div className="text-[11.5px] font-medium text-muted">{o.button}</div>}
      {o.options.map((x: any) => {
        const label = <><span className="font-medium">{x.title}</span>{x.description && <span className="ml-1.5 text-muted">{x.description}</span>}</>;
        return onTap
          ? <button key={x.id} type="button" className={`rounded-[8px] border border-line bg-white px-2.5 py-1 text-left text-[12.5px] hover:border-ink-2 ${o.kind === 'list' ? 'block w-full' : ''}`} onClick={() => onTap(x.id, x.title)}>{label}</button>
          : <div key={x.id} className={`rounded-[8px] border border-line bg-white/70 px-2.5 py-1 text-[12.5px] ${o.kind === 'list' ? '' : 'inline-block'}`}>{label}</div>;
      })}
    </div>
  );
}

/** The lines of one chat, newest at the bottom. */
function Lines({ lines, onTap }: { lines: any[]; onTap?: (id: string, title: string) => void }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [lines.length]);
  return (
    <div className="space-y-2">
      {lines.map((l) => l.direction === 'event'
        ? <div key={l.id} className="text-center text-[12px] text-muted">{l.body} · {when(l.createdAt)}</div>
        : <div key={l.id} className={`flex ${l.direction === 'in' ? 'justify-start' : 'justify-end'}`}>
        <div className={`max-w-[85%] rounded-[12px] px-3 py-2 text-[13.5px] ${l.direction === 'in' ? 'bg-paper-2 border border-line' : l.by === 'WhatsApp assistant' ? 'bg-sage-soft' : 'bg-clay-soft'}`}>
          <div className="whitespace-pre-wrap">{l.body}</div>
          {l.options && <Options o={l.options} onTap={onTap} />}
          <div className="mt-1 text-[11px] text-muted">{l.direction === 'in' ? 'Patient' : l.by === 'WhatsApp assistant' ? 'Assistant' : l.by} · {when(l.createdAt)}</div>
        </div></div>)}
      <div ref={end} />
    </div>
  );
}

function ChatDrawer({ id, canWrite, onClose }: { id: string; canWrite: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const [text, setText] = useState('');
  const q = useQuery({ queryKey: ['chats', id], queryFn: () => get(`/chats/${id}`), refetchInterval: 5000 });
  useEffect(() => { if (canWrite) post(`/chats/${id}/read`).then(refresh, () => {}); }, [id, canWrite]);
  const reply = useMutation({ mutationFn: () => post(`/chats/${id}/reply`, { text }), onSuccess: () => { setText(''); refresh(); }, onError: (e) => toast(errText(e), 'err') });
  const status = useMutation({ mutationFn: (s: string) => post(`/chats/${id}/status`, { status: s }), onSuccess: (_r, s) => { refresh(); toast(s === 'assistant' ? 'Handed back to the assistant' : s === 'closed' ? 'Chat closed' : 'You are answering this chat'); if (s !== 'staff') onClose(); }, onError: (e) => toast(errText(e), 'err') });
  const c = q.data;
  return (
    <Drawer title={c ? (c.patients.length ? c.patients.map((p: any) => p.fullName).join(', ') : 'New number') : 'Chat'} subtitle={c?.phone} onClose={onClose} width="max-w-md" dirty={!!text.trim()}>
      {!c ? <div className="text-sm text-muted">Loading…</div> : <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone={STATUS[c.status]?.tone}>{STATUS[c.status]?.label}</Chip>
          {c.status === 'staff' && c.reason && <span className="text-[13px] text-muted">{c.reason}</span>}
          {c.patients.map((p: any) => <button key={p.id} type="button" className="btn btn-sm ml-auto" onClick={() => nav(`/patients/${p.id}`)}>{c.patients.length > 1 ? p.fullName : 'View profile'}</button>)}
        </div>
        <Lines lines={c.lines} />
        {canWrite && <div className="space-y-2 border-t border-line pt-3">
          <textarea className="input min-h-[72px] w-full" placeholder="Type a reply" value={text} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && text.trim()) reply.mutate(); }} />
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn btn-primary" disabled={!text.trim() || reply.isPending} onClick={() => reply.mutate()}>Send</button>
            {c.status !== 'assistant' && <button type="button" className="btn" disabled={status.isPending} onClick={() => status.mutate('assistant')}>Hand back to assistant</button>}
            {c.status === 'assistant' && <button type="button" className="btn" disabled={status.isPending} onClick={() => status.mutate('staff')}>Take over</button>}
            {c.status !== 'closed' && <button type="button" className="btn ml-auto" disabled={status.isPending} onClick={() => status.mutate('closed')}>Close</button>}
          </div>
        </div>}
      </div>}
    </Drawer>
  );
}

/** Type as a patient: the same path as a real WhatsApp message, but nothing goes to a phone. Use a patient's number to act as them. */
function TestChat({ onClose }: { onClose: () => void }) {
  const [phone, setPhone] = useState('9000000001');
  const [text, setText] = useState('');
  const [chatId, setChatId] = useState<string | null>(null);
  const lines = useQuery({ queryKey: ['chats', chatId], queryFn: () => get(`/chats/${chatId}`), enabled: !!chatId, refetchInterval: 4000 });
  const send = useMutation({
    mutationFn: (tap?: { id: string; title: string }) => post('/chats/simulate', tap ? { phone, text: tap.title, action: tap.id } : { phone, text }),
    onSuccess: (r: any, tap) => { if (!tap) setText(''); if (r.chatId) { setChatId(r.chatId); qc.invalidateQueries({ queryKey: ['chats', r.chatId] }); } if (r.status === 'staff') toast('This chat is now with the front desk', 'info'); },
    onError: (e) => toast(errText(e), 'err'),
  });
  const ok = /^\d{10}$/.test(phone.replace(/\D/g, '').slice(-10));
  return (
    <Drawer title="Test chat" subtitle="Write as a patient. Nothing is sent to a phone." onClose={onClose} width="max-w-md">
      <div className="flex flex-col gap-4">
        <label className="block text-sm"><span className="text-muted">Patient's mobile number</span>
          <input className="input mt-1 w-full tabular-nums" value={phone} inputMode="numeric" onChange={(e) => { setPhone(e.target.value); setChatId(null); }} />
          <span className="mt-1 block text-[12.5px] text-muted">Use a patient's number to see their visits; any other number is a new patient.</span></label>
        {chatId && <Lines lines={lines.data?.lines ?? []} onTap={(id, title) => { if (!send.isPending) send.mutate({ id, title }); }} />}
        {send.isPending && <div className="text-[13px] text-muted">The assistant is replying…</div>}
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (text.trim() && ok) send.mutate(undefined); }}>
          <input className="input flex-1" placeholder="e.g. Hi, or Can I come tomorrow evening?" value={text} onChange={(e) => setText(e.target.value)} />
          <button type="submit" className="btn btn-primary" disabled={!text.trim() || !ok || send.isPending}>Send</button>
        </form>
      </div>
    </Drawer>
  );
}
