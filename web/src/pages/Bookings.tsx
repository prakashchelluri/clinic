import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useOutletContext, useSearchParams, Link } from 'react-router';
import { get, post, errText } from '../api';
import { can } from '../App';
import { Chip, Empty, Icon, PageHeader, Segmented, Skeleton, toast } from '../ui';
import { AppointmentDrawer, StatusChip, refreshBookings } from '../apptDrawer';

type Tab = 'requests' | 'upcoming' | 'unconfirmed' | 'past' | 'no_show' | 'cancelled';
const dayLabel = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
const MSG: Record<string, string> = { confirmation: 'Confirmation', requested: 'Request ack', reminder: 'Reminder', moved: 'Move notice', cancelled: 'Cancel notice', declined: 'Decline notice' };
const msgText = (m: any) => !m ? '—' : `${MSG[m.kind] ?? m.kind} ${m.status === 'pending' ? 'due' : m.status === 'logged' ? 'ready' : m.status} · ${new Date(m.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })}`;

/** Every booking in one place: online requests first, then filters by status, doctor, visit type, dates and name. */
export function Bookings() {
  const { cfg, perms } = useOutletContext<any>();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'upcoming';
  const setTab = (t: Tab) => { const p = new URLSearchParams(params); p.set('tab', t); setParams(p, { replace: true }); };
  const [doc, setDoc] = useState(''); const [svc, setSvc] = useState(''); const [from, setFrom] = useState(''); const [to, setTo] = useState(''); const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const canWrite = can(perms, 'appointment.write');
  const qs = new URLSearchParams({ tab, ...(doc && { practitionerId: doc }), ...(svc && { serviceId: svc }), ...(from && { from }), ...(to && { to }), ...(q.trim().length >= 2 && { q: q.trim() }) });
  const list = useQuery({ queryKey: ['bookings', qs.toString()], queryFn: () => get(`/bookings?${qs}`), refetchInterval: 30000 });
  const requests = useQuery({ queryKey: ['bookings', 'tab=requests'], queryFn: () => get('/bookings?tab=requests'), refetchInterval: 30000, enabled: tab !== 'requests' });
  const counts = useQuery({ queryKey: ['bookings', 'counts'], queryFn: () => get('/bookings/counts') });
  const approve = useMutation({ mutationFn: (id: string) => post(`/appointments/${id}/approve`), onSuccess: () => { refreshBookings(); toast('Approved · confirmation queued'); }, onError: (e) => toast(errText(e), 'err') });
  const reqs: any[] = tab === 'requests' ? list.data ?? [] : requests.data ?? [];
  const rows: any[] = list.data ?? [];
  const badDates = from && to && from > to;

  return (
    <div>
      <PageHeader title="Bookings" subtitle="Online requests, upcoming visits and history. Click any booking for details and actions.">
        <Link to="/calendar" className="btn"><Icon name="calendar" />Calendar</Link>
        {canWrite && <Link to="/booking" className="btn btn-accent"><Icon name="plus" />New booking</Link>}
      </PageHeader>

      {tab !== 'requests' && reqs.length > 0 && (
        <section className="glass mb-5 overflow-hidden anim-fade-up">
          <div className="flex flex-wrap items-center gap-2 px-5 pt-4 pb-2"><b className="text-[16px]">Online requests</b><Chip tone="clay">{reqs.length} waiting</Chip><span className="ml-auto text-xs text-muted">Approve to confirm the place and message the patient</span></div>
          {reqs.slice(0, 5).map((r) => <RequestRow key={r.id} r={r} canWrite={canWrite} onOpen={() => setOpen(r.id)} onApprove={() => approve.mutate(r.id)} busy={approve.isPending} />)}
          {reqs.length > 5 && <button className="w-full border-t border-line/60 py-3 text-sm font-medium text-muted hover:text-ink" onClick={() => setTab('requests')}>See all {reqs.length} requests</button>}
        </section>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Segmented<Tab> value={tab} onChange={setTab} options={[{ value: 'requests', label: 'Requests', count: counts.data?.requests }, { value: 'upcoming', label: 'Upcoming' }, { value: 'unconfirmed', label: 'Unconfirmed', count: counts.data?.unconfirmed }, { value: 'past', label: 'Past' }, { value: 'no_show', label: 'No-shows' }, { value: 'cancelled', label: 'Cancelled' }]} />
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1 sm:flex-none"><Icon name="search" className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" /><input aria-label="Search bookings" className="input !pl-10" placeholder="Name, phone or patient no." maxLength={60} value={q} onChange={(e) => setQ(e.target.value)} /></div>
        {(cfg?.practitioners ?? []).length > 1 && <select aria-label="Doctor" className="input !w-auto" value={doc} onChange={(e) => setDoc(e.target.value)}><option value="">All doctors</option>{cfg.practitioners.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}
        {(cfg?.services ?? []).length > 0 && <select aria-label="Visit type" className="input !w-auto" value={svc} onChange={(e) => setSvc(e.target.value)}><option value="">All visit types</option>{cfg.services.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}
        <label className="flex items-center gap-1.5 text-sm text-muted">From<input type="date" aria-label="From date" className="input !w-auto" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="flex items-center gap-1.5 text-sm text-muted">to<input type="date" aria-label="To date" className="input !w-auto" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        {(doc || svc || from || to || q) && <button className="btn btn-ghost btn-sm" onClick={() => { setDoc(''); setSvc(''); setFrom(''); setTo(''); setQ(''); }}>Clear</button>}
      </div>
      {badDates && <div className="mb-3 text-sm text-rose">The “from” date is after the “to” date.</div>}

      <section className="card-flat overflow-hidden anim-fade-up">
        {list.isLoading ? <div className="p-4"><Skeleton rows={6} /></div> : list.isError ? <div className="p-4 text-sm text-rose">{errText(list.error)}</div>
          : rows.length === 0 ? <Empty icon="inbox" title={tab === 'requests' ? 'No online requests' : 'No bookings here'} hint={tab === 'requests' ? 'Requests from the online booking page appear here.' : 'Try another tab or clear the filters.'} />
          : tab === 'requests' ? rows.map((r) => <RequestRow key={r.id} r={r} canWrite={canWrite} onOpen={() => setOpen(r.id)} onApprove={() => approve.mutate(r.id)} busy={approve.isPending} />)
          : (<>
            <div className="hidden overflow-x-auto md:block">
              <table className="table w-full">
                <thead><tr><th>When</th><th>Patient</th><th>Visit type</th><th>Doctor</th><th>Status</th><th>Last message</th></tr></thead>
                <tbody>{rows.map((r) => (
                  <tr key={r.id} className="cursor-pointer hover:bg-white/60" onClick={() => setOpen(r.id)}>
                    <td className="whitespace-nowrap"><b>{dayLabel(r.window.day)}</b> · {r.window.startTime}</td>
                    <td><button className="text-left font-medium hover:underline" onClick={(e) => { e.stopPropagation(); setOpen(r.id); }}>{r.patient.fullName}</button><div className="text-xs text-muted">{r.patient.phone ?? r.patient.patientNo}{r.noShows > 0 && <span className="text-rose"> · {r.noShows} no-show{r.noShows === 1 ? '' : 's'}</span>}</div></td>
                    <td>{r.service ? <span className="inline-flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-[3px]" style={{ background: r.service.color }} />{r.service.name}</span> : <span className="text-muted">—</span>}{r.seriesId && <Icon name="repeat" className="ml-1.5 inline h-3 w-3 text-muted" />}</td>
                    <td className="whitespace-nowrap">{r.window.doctor ?? 'Any'}</td>
                    <td><StatusChip s={r.status} /></td>
                    <td className="text-xs text-muted">{msgText(r.lastMessage)}</td>
                  </tr>))}</tbody>
              </table>
            </div>
            <div className="md:hidden">{rows.map((r) => (
              <button key={r.id} className="flex w-full items-start gap-3 border-t border-line/60 px-4 py-3 text-left first:border-t-0" onClick={() => setOpen(r.id)}>
                <i className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: r.service?.color ?? 'var(--color-line-2)' }} />
                <div className="min-w-0 flex-1"><div className="font-medium">{r.patient.fullName}</div><div className="text-xs text-muted">{dayLabel(r.window.day)} · {r.window.startTime} · {r.window.doctor ?? 'Any'}{r.service ? ` · ${r.service.name}` : ''}</div></div>
                <StatusChip s={r.status} />
              </button>))}</div>
            {rows.length >= 200 && <div className="border-t border-line/60 px-4 py-3 text-xs text-muted">Showing the first 200. Narrow the dates or filters to see the rest.</div>}
          </>)}
      </section>

      {open && <AppointmentDrawer id={open} cfg={cfg} canWrite={canWrite} onClose={() => setOpen(null)} />}
    </div>
  );
}

function RequestRow({ r, canWrite, onOpen, onApprove, busy }: { r: any; canWrite: boolean; onOpen: () => void; onApprove: () => void; busy: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-line/60 px-5 py-3.5 first:border-t-0">
      <Chip tone="sky">online</Chip>
      <button className="min-w-0 flex-1 text-left" onClick={onOpen}>
        <div><b>{r.patient.fullName}</b> <span className="text-sm text-muted">· {r.patient.phone}</span>{r.noShows > 0 && <Chip tone="rose" className="ml-2">{r.noShows} no-show{r.noShows === 1 ? '' : 's'}</Chip>}</div>
        <div className="truncate text-sm text-muted">{r.service?.name ?? 'Visit'} · {r.window.doctor ?? 'Any doctor'} · {dayLabel(r.window.day)}, {r.window.startTime}–{r.window.endTime}{r.note ? ` · “${r.note}”` : ''}</div>
      </button>
      {canWrite && <div className="flex gap-2"><button className="btn btn-sm" onClick={onOpen}>Decline…</button><button className="btn btn-sm btn-primary" disabled={busy} onClick={onApprove}><Icon name="check" />Approve</button></div>}
    </div>
  );
}
