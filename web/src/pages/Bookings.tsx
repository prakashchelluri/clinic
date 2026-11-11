import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useOutletContext, useSearchParams } from 'react-router';
import { get, today, errText } from '../api';
import { can } from '../App';
import { Icon, PageHeader, usePageSearch } from '../ui';
import { AppointmentDrawer, StatusChip } from '../apptDrawer';
import { DataTable, filterValue, type Col, type FilterDef } from '../table';

type Tab = 'upcoming' | 'past' | 'no_show' | 'cancelled';
const TABS: [Tab, string][] = [['upcoming', 'Upcoming'], ['past', 'Past'], ['no_show', 'No-shows'], ['cancelled', 'Cancelled']];
const dayLabel = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
const MSG: Record<string, string> = { confirmation: 'Confirmation', reminder: 'Reminder', moved: 'Move notice', cancelled: 'Cancel notice' };
const msgText = (m: any) => !m ? '—' : `${MSG[m.kind] ?? m.kind} ${m.status === 'pending' ? 'due' : m.status === 'logged' ? 'ready' : m.status} · ${new Date(m.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })}`;
const shift = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const DATES: FilterDef<any> = { key: 'when', label: 'Dates', icon: 'calendar', options: [{ value: 'any', label: 'Any day' }, { value: 'today', label: 'Today' }, { value: 'tomorrow', label: 'Tomorrow' }, { value: 'next7', label: 'Next 7 days' }, { value: 'last7', label: 'Last 7 days' }, { value: 'last30', label: 'Last 30 days' }, { value: 'custom', label: 'Pick dates' }] };
const span = (v: string, from: string, to: string): [string, string] | null => {
  const t = today();
  return v === 'today' ? [t, t] : v === 'tomorrow' ? [shift(t, 1), shift(t, 1)] : v === 'next7' ? [t, shift(t, 6)] : v === 'last7' ? [shift(t, -6), t] : v === 'last30' ? [shift(t, -29), t] : v === 'custom' ? [from, to] : null;
};

/** Every booking in one table: tabs by status; doctor, visit type and dates as filters; the header box finds a patient. */
export function Bookings() {
  const { cfg, perms } = useOutletContext<any>();
  const [sp, setSp] = useSearchParams();
  const tab = (TABS.some((t) => t[0] === sp.get('tab')) ? sp.get('tab') : 'upcoming') as Tab;
  const [q] = usePageSearch('Find a booking: name, phone or patient no.');
  const [open, setOpen] = useState<string | null>(null);
  const canWrite = can(perms, 'appointment.write');
  const docs: any[] = cfg?.practitioners ?? [], svcs: any[] = cfg?.services ?? [];
  const DOC: FilterDef<any> = { key: 'doctor', label: 'Doctor', icon: 'stetho', options: [{ value: '', label: 'All doctors' }, ...docs.map((d) => ({ value: d.id, label: d.name }))] };
  const SVC: FilterDef<any> = { key: 'type', label: 'Visit type', icon: 'list', options: [{ value: '', label: 'All visit types' }, ...svcs.map((s) => ({ value: s.id, label: s.name }))] };
  const when = filterValue(sp, DATES), from = sp.get('from') ?? today(), to = sp.get('to') ?? today();
  const range = span(when, from, to); const badDates = !!range && range[0] > range[1];
  const qs = new URLSearchParams({ tab, limit: '500', ...(filterValue(sp, DOC) && { practitionerId: filterValue(sp, DOC) }), ...(filterValue(sp, SVC) && { serviceId: filterValue(sp, SVC) }), ...(range && { from: range[0], to: range[1] }), ...(q.trim().length >= 2 && { q: q.trim() }) });
  const list = useQuery({ queryKey: ['bookings', qs.toString()], queryFn: () => get(`/bookings?${qs}`), refetchInterval: 30000, enabled: !badDates });  const rows: any[] = list.data ?? [];
  const setDate = (k: 'from' | 'to', v: string) => v && setSp((p) => { const n = new URLSearchParams(p); n.set(k, v); n.delete('p'); return n; }, { replace: true });

  const columns: Col<any>[] = [
    { key: 'when', label: 'When', fixed: true, sort: (r) => `${r.window.day} ${r.window.startTime}`, csv: (r) => `${r.window.day} ${r.window.startTime}`, cell: (r) => <div className="whitespace-nowrap"><div className="font-semibold">{dayLabel(r.window.day)}</div><div className="text-[12px] text-muted">{r.window.startTime}</div></div> },
    { key: 'patient', label: 'Patient', sort: (r) => r.patient.fullName.toLowerCase(), csv: (r) => r.patient.fullName, cell: (r) => (
      <div><div className="font-bold">{r.patient.fullName}</div><div className="text-[12px] text-muted">{r.patient.phone ?? r.patient.patientNo}{r.noShows > 0 && <span className="text-rose"> · {r.noShows} no-show{r.noShows === 1 ? '' : 's'}</span>}</div></div>) },
    { key: 'type', label: 'Visit type', sort: (r) => r.service?.name ?? '', csv: (r) => r.service?.name ?? '', cell: (r) => r.service
      ? <span className="inline-flex items-center gap-1.5 whitespace-nowrap"><i className="h-2.5 w-2.5 rounded-[3px]" style={{ background: r.service.color }} />{r.service.name}{r.seriesId && <Icon name="repeat" className="h-3 w-3 text-muted" />}</span> : <span className="text-muted">—</span> },
    { key: 'doctor', label: 'Doctor', sort: (r) => r.window.doctor ?? '', csv: (r) => r.window.doctor ?? 'Any', cell: (r) => <span className="whitespace-nowrap">{r.window.doctor ?? 'Any'}</span> },
    { key: 'status', label: 'Status', sort: (r) => r.status, csv: (r) => r.status, cell: (r) => <StatusChip s={r.status} /> },
    { key: 'msg', label: 'Last message', hideOnPhone: true, csv: (r) => msgText(r.lastMessage), cell: (r) => <span className="text-[12px] text-muted">{msgText(r.lastMessage)}</span> },
  ];

  return (
    <div>
      <PageHeader title="Bookings" subtitle="Upcoming visits and history. Click any booking for details and actions." />
      <DataTable
        id="bookings" exportName={`bookings-${tab}-${today()}`} rows={rows} rowKey={(r) => r.id} columns={columns}
        loading={list.isLoading} onRow={(r) => setOpen(r.id)} selected={open}
        empty={{ title: badDates ? 'Check the dates' : list.isError ? errText(list.error) : 'No bookings here', hint: badDates ? 'The “from” date is after the “to” date.' : 'Try another tab or other filters.' }}
        tabs={TABS.map(([v, l]) => ({ value: v, label: l }))} tab={tab}
        onTab={(v) => setSp((p) => { const n = new URLSearchParams(p); v === 'upcoming' ? n.delete('tab') : n.set('tab', v); return n; }, { replace: true })}
        search={{ placeholder: 'Find a booking: name, phone or patient no.' }}
        sort={{ key: 'when', dir: ['past', 'no_show', 'cancelled'].includes(tab) ? -1 : 1 }}
        filters={[...(docs.length > 1 ? [DOC] : []), ...(svcs.length > 0 ? [SVC] : []), DATES]}
        toolbar={when === 'custom' && <span className="inline-flex items-center gap-1.5 text-[12.5px] text-muted">
          <input type="date" aria-label="From date" className={`dt-select ${badDates ? '!border-rose' : ''}`} value={from} onChange={(e) => setDate('from', e.target.value)} />to
          <input type="date" aria-label="To date" className={`dt-select ${badDates ? '!border-rose' : ''}`} value={to} onChange={(e) => setDate('to', e.target.value)} /></span>}
      />
      {rows.length >= 500 && <div className="mt-2 text-xs text-muted">Showing the first 500. Narrow the dates or filters to see the rest.</div>}
      {open && <AppointmentDrawer id={open} cfg={cfg} canWrite={canWrite} onClose={() => setOpen(null)} />}
    </div>
  );
}
