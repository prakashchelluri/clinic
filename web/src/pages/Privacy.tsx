import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useOutletContext } from 'react-router';
import { get, api, qc, errText, post } from '../api';
import { Chip, Empty, Icon, Modal, Segmented, Skeleton, toast } from '../ui';

const ROLE_NAMES: Record<string, string> = { owner: 'Owner', admin: 'Admin', doctor: 'Doctor', receptionist: 'Reception', assistant: 'Assistant', coordinator: 'Coordinator', pharmacist: 'Pharmacy' };
const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
const IP_RE = /^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]{2,39}$/i;

/** Settings → Privacy & access (owner only): work only from the clinic, sign out when idle, phone numbers, lists of patients. */
export function PrivacyTab() {
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['security'], queryFn: () => get('/security') });
  const save = useMutation({ mutationFn: (s: any) => api('PUT', '/security', s), onSuccess: () => { qc.invalidateQueries({ queryKey: ['security'] }); qc.invalidateQueries({ queryKey: ['me'] }); toast('Saved'); }, onError: (e) => toast(errText(e), 'err') });
  const [adding, setAdding] = useState<null | { label: string; from: string; to: string; range: boolean }>(null);
  if (q.isLoading || !q.data) return <Skeleton rows={6} />;
  const d = q.data; const s = d.security;
  const put = (patch: any) => save.mutate({ ...s, ...patch, ipLock: { ...s.ipLock, ...(patch.ipLock ?? {}) } });
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const allow = (label: string, from: string, to?: string) => put({ ipLock: { allowed: [...s.ipLock.allowed, { label, from, to: to || null }] } });
  const addBad = adding && (!adding.label.trim() || !IP_RE.test(adding.from.trim()) || (adding.range && !/^(\d{1,3}\.){3}\d{1,3}$/.test(adding.to.trim())));
  const staff = d.users.filter((u: any) => !u.roles.some((r: string) => r === 'owner' || r === 'admin'));

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
      <div className="space-y-4">
        <section className="card-flat p-5">
          <div className="flex items-center gap-3"><b className="text-[16px]">Work only from the clinic</b>
            <button role="switch" aria-checked={s.ipLock.enabled} aria-label="Work only from the clinic" disabled={save.isPending} onClick={() => put({ ipLock: { enabled: !s.ipLock.enabled } })}
              className={`relative ml-auto h-6 w-11 rounded-full transition-colors ${s.ipLock.enabled ? 'bg-sage' : 'bg-ink/20'}`}><span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${s.ipLock.enabled ? 'left-[22px]' : 'left-0.5'}`} /></button></div>
          <div className="mt-1 text-sm text-muted">Staff can sign in and use the app only from the clinic's internet. The owner and admins can work from anywhere.</div>
          <div className={`mt-3 flex flex-wrap items-center gap-2 rounded-2xl px-3 py-2.5 text-sm ${d.myIpAllowed ? 'bg-sage-soft text-sage' : 'bg-paper'}`}>
            This computer: <b className="font-mono">{d.myIp}</b>{d.myIpAllowed ? <Chip tone="sage">allowed</Chip> : <span className="text-xs text-muted">not in the list</span>}
          </div>

          <div className="mt-4 text-[11px] font-bold uppercase tracking-wider text-muted">Allowed internet addresses</div>
          {s.ipLock.allowed.length === 0 ? <div className="py-2 text-sm text-muted">None yet. Add the clinic's address before turning this on.</div> : s.ipLock.allowed.map((a: any, i: number) => (
            <div key={i} className="flex flex-wrap items-center gap-3 border-t border-line/60 py-2.5 text-sm first:border-t-0">
              <b className="min-w-0 flex-1">{a.label}</b><span className="font-mono text-[13px]">{a.from}{a.to ? ` – ${a.to}` : ''}</span>
              <button className="btn btn-sm" disabled={save.isPending} aria-label={`Remove ${a.label}`} onClick={() => put({ ipLock: { allowed: s.ipLock.allowed.filter((_: any, j: number) => j !== i) } })}>Remove</button>
            </div>))}
          <div className="mt-3 flex flex-wrap gap-2">
            {!d.myIpAllowed && <button className="btn btn-primary btn-sm" disabled={save.isPending} onClick={() => allow('Clinic internet', d.myIp)}><Icon name="plus" className="h-3.5 w-3.5" />Add this computer's address</button>}
            <button className="btn btn-sm" onClick={() => setAdding({ label: '', from: '', to: '', range: false })}>Add another address</button>
          </div>

          <div className="mt-5 text-[11px] font-bold uppercase tracking-wider text-muted">Can also work from anywhere</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {staff.length === 0 ? <span className="text-sm text-muted">No other staff.</span> : staff.map((u: any) => <button key={u.id} role="checkbox" aria-checked={s.ipLock.anywhere.includes(u.id)} disabled={save.isPending} className={`toggle-opt ${s.ipLock.anywhere.includes(u.id) ? 'on' : ''}`}
              onClick={() => put({ ipLock: { anywhere: toggle(s.ipLock.anywhere, u.id) } })}>{u.name} <span className="ml-1 text-[11px] opacity-60">{u.roles.map((r: string) => ROLE_NAMES[r] ?? r).join(', ')}</span></button>)}
          </div>
          <div className="mt-1.5 text-xs text-muted">For example a doctor checking reports at night.</div>
        </section>

        <section className="card-flat p-5">
          <div className="flex items-center gap-2"><b className="text-[16px]">Stopped sign-ins</b>{d.stopped.length > 0 && <Chip tone="rose">{d.stopped.length}</Chip>}</div>
          {d.stopped.length === 0 ? <div className="py-2 text-sm text-muted">Nobody was stopped in the last two weeks.</div> : d.stopped.map((x: any) => (
            <div key={x.id} className="flex flex-wrap items-center gap-3 border-t border-line/60 py-2.5 text-sm first:border-t-0">
              <span className="min-w-0 flex-1"><b>{x.name}</b> <span className="text-muted">· {ROLE_NAMES[x.role] ?? x.role}</span><span className="block text-xs text-muted">{when(x.at)} · <span className="font-mono">{x.ip}</span></span></span>
              <button className="btn btn-primary btn-sm" disabled={save.isPending} onClick={() => allow(`${x.name}'s connection`, x.ip)}>Allow this address</button>
              <button className="btn btn-ghost btn-sm" disabled={save.isPending} onClick={() => put({ ipLock: { ignored: [...s.ipLock.ignored, x.ip] } })}>Ignore</button>
            </div>))}
          <div className="mt-2 text-xs text-muted">Home and office internet addresses change now and then. When staff are stopped at the clinic, allow the new address here.</div>
        </section>
      </div>

      <div className="space-y-4">
        <section className="card-flat p-5">
          <b className="text-[16px]">Sign out when idle</b><div className="mt-1 text-sm text-muted">For shared front-desk and pharmacy computers.</div>
          <div className="mt-3" role="radiogroup" aria-label="Sign out when idle"><Segmented<string> value={String(s.idleMinutes)} onChange={(v) => put({ idleMinutes: Number(v) })} options={[{ value: '10', label: '10 min' }, { value: '30', label: '30 min' }, { value: '60', label: '1 hour' }, { value: '0', label: 'Never' }]} /></div>
          <div className="mt-2 text-xs text-muted">Anything being typed is saved first. A doctor in a consultation is not signed out.</div>
        </section>
        <section className="card-flat p-5">
          <b className="text-[16px]">Phone numbers</b><div className="mt-1 text-sm text-muted">Who sees full patient phone numbers. Others see 98••• ••345.</div>
          <div className="mt-3 flex flex-wrap gap-1.5">{d.roles.map((r: string) => { const fixed = r === 'owner' || r === 'admin'; const on = fixed || s.phoneRoles.includes(r); return (
            <button key={r} role="checkbox" aria-checked={on} disabled={fixed || save.isPending} title={fixed ? 'Always' : undefined} className={`toggle-opt ${on ? 'on' : ''}`} onClick={() => put({ phoneRoles: toggle(s.phoneRoles, r) })}>{ROLE_NAMES[r] ?? r}</button>); })}</div>
          <div className="mt-2 text-xs text-muted">WhatsApp messages still reach patients. Roles that phone patients (reception, coordinator) need this ticked.</div>
        </section>
        <section className="card-flat p-5">
          <b className="text-[16px]">Lists of patients</b><div className="mt-1 text-sm text-muted">Who may download or print lists (front desk list, history, daily report).</div>
          <div className="mt-3 flex flex-wrap gap-1.5">{d.roles.map((r: string) => { const fixed = r === 'owner'; const on = fixed || s.listRoles.includes(r); return (
            <button key={r} role="checkbox" aria-checked={on} disabled={fixed || save.isPending} className={`toggle-opt ${on ? 'on' : ''}`} onClick={() => put({ listRoles: toggle(s.listRoles, r) })}>{ROLE_NAMES[r] ?? r}</button>); })}</div>
          <div className="mt-2 text-xs text-muted">One prescription or one bill is not a list: everyone still prints those. Every list download is in the audit log.</div>
        </section>
        <section className="card-flat p-5">
          <div className="flex items-center"><b className="text-[16px]">Audit log</b><button className="btn btn-sm ml-auto" onClick={() => nav('/audit')}>Open the audit log</button></div>
          <div className="mt-1 text-sm text-muted">Every action by every user: money, changes with before and after, cancellations, records opened, prints and downloads, sign-ins, settings. Nobody can edit or delete it.</div>
        </section>
      </div>

      {adding && <Modal title="Add an internet address" subtitle="The clinic's address, or a range if your internet company changes it" onClose={() => setAdding(null)} width="max-w-md" submitOnEnter>
        <div className="space-y-3">
          <div><label className="label" htmlFor="ip-label">Name</label><input id="ip-label" className="input" maxLength={60} placeholder="e.g. Backup Jio Fiber" value={adding.label} onChange={(e) => setAdding({ ...adding, label: e.target.value })} /></div>
          <div className="flex gap-1.5" role="radiogroup" aria-label="One address or a range">{[[false, 'One address'], [true, 'A range']].map(([v, l]) => <button key={String(v)} role="radio" aria-checked={adding.range === v} className={`toggle-opt ${adding.range === v ? 'on' : ''}`} onClick={() => setAdding({ ...adding, range: v as boolean })}>{l as string}</button>)}</div>
          <div className="grid grid-cols-2 gap-2">
            <div className={adding.range ? '' : 'col-span-2'}><label className="label" htmlFor="ip-from">{adding.range ? 'From' : 'Address'}</label><input id="ip-from" className="input font-mono" maxLength={45} placeholder="49.205.12.34" value={adding.from} onChange={(e) => setAdding({ ...adding, from: e.target.value.replace(/[^0-9a-fA-F.:]/g, '') })} /></div>
            {adding.range && <div><label className="label" htmlFor="ip-to">To</label><input id="ip-to" className="input font-mono" maxLength={15} placeholder="49.205.12.255" value={adding.to} onChange={(e) => setAdding({ ...adding, to: e.target.value.replace(/[^0-9.]/g, '') })} /></div>}
          </div>
          {adding.from && addBad && <div className="text-xs text-rose">{!adding.label.trim() ? 'Give it a name.' : adding.range ? 'Both ends must look like 106.51.0.0.' : 'That does not look like an internet address.'}</div>}
          <div className="modal-foot"><button className="btn btn-ghost" onClick={() => setAdding(null)}>Cancel</button><button className="btn btn-primary" disabled={!!addBad || save.isPending} onClick={() => { allow(adding.label.trim(), adding.from.trim(), adding.range ? adding.to.trim() : undefined); setAdding(null); }}><Icon name="check" />Add</button></div>
        </div>
      </Modal>}
    </div>
  );
}

const KINDS: [string, string][] = [['', 'All actions'], ['money', 'Money'], ['change', 'Changed'], ['cancel', 'Cancelled / deleted'], ['view', 'Viewed'], ['print', 'Printed / downloaded'], ['signin', 'Sign-ins'], ['settings', 'Settings']];
const KIND_TONE: Record<string, 'amber' | 'rose' | 'sky' | 'sage' | 'clay' | ''> = { money: 'amber', cancel: 'rose', view: 'sky', print: 'clay', signin: '', settings: 'sage', change: '' };

/** The audit log: every action by every user, newest first. Owner and admins. */
export function AuditLog() {
  const { me } = useOutletContext<any>();
  const nav = useNavigate();
  const [days, setDays] = useState('1'); const [kind, setKind] = useState(''); const [userId, setUserId] = useState(''); const [unusual, setUnusual] = useState(false);
  const [pq, setPq] = useState(''); const [patient, setPatient] = useState<any>(null); const [open, setOpen] = useState<any>(null);
  const users = useQuery({ queryKey: ['users'], queryFn: () => get('/users') });
  const found = useQuery({ queryKey: ['patients', pq], queryFn: () => get(`/patients?q=${encodeURIComponent(pq)}`), enabled: pq.trim().length >= 2 && !patient });
  const qs = new URLSearchParams({ days, ...(kind ? { kind } : {}), ...(userId ? { userId } : {}), ...(unusual ? { unusual: 'true' } : {}), ...(patient ? { patientId: patient.id } : {}) }).toString();
  const q = useQuery({ queryKey: ['audit', qs], queryFn: () => get(`/audit?${qs}`) });
  const rows: any[] = q.data ?? [];
  const canDownload = me.privacy?.canExport;
  const download = async () => {
    try { await post('/audit/event', { kind: 'print', what: 'Downloaded the audit log', count: rows.length }); } catch (e) { toast(errText(e), 'err'); return; }
    const csv = [['When', 'Who', 'Role', 'What', 'Patient', 'From', 'Unusual'], ...rows.map((r) => [when(r.at), r.userName ?? '', r.role ?? '', r.summary, r.patient ?? '', r.ip ?? '', r.unusual ? 'yes' : ''])]
      .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })); const a = document.createElement('a'); a.href = url; a.download = `audit-log-${days}d.csv`; a.click(); URL.revokeObjectURL(url);
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3"><h1 className="text-[26px] font-semibold">Audit log</h1><span className="text-sm text-muted">every action by every user · kept a year · nobody can edit or delete it</span>
        {canDownload && <button className="btn btn-sm ml-auto" disabled={!rows.length} onClick={download}><Icon name="download" className="h-3.5 w-3.5" />Download</button>}</div>
      <div className="flex flex-wrap items-center gap-2">
        <Segmented<string> value={days} onChange={setDays} options={[{ value: '1', label: 'Today' }, { value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '365', label: 'Year' }]} />
        <select aria-label="Staff" className="input !w-auto !py-2" value={userId} onChange={(e) => setUserId(e.target.value)}><option value="">All staff</option>{(users.data ?? []).map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
        <div className="relative">
          {patient ? <span className="toggle-opt on">{patient.fullName}<button aria-label="Clear patient" className="ml-1" onClick={() => { setPatient(null); setPq(''); }}><Icon name="x" className="inline h-3 w-3" /></button></span>
            : <input aria-label="Patient" className="input !w-56 !py-2" placeholder="Patient name, phone or OP no." value={pq} onChange={(e) => setPq(e.target.value)} />}
          {!patient && (found.data ?? []).length > 0 && <div className="menu anim-menu !left-0 !right-auto !top-full !mt-1 !w-72 p-1">{found.data.slice(0, 6).map((p: any) => <button key={p.id} className="w-full rounded-lg px-2.5 py-2 text-left text-sm hover:bg-paper" onClick={() => setPatient(p)}><b>{p.fullName}</b> <span className="text-xs text-muted">{p.patientNo}</span></button>)}</div>}
        </div>
        <label className="ml-1 flex items-center gap-1.5 text-sm"><input type="checkbox" checked={unusual} onChange={(e) => setUnusual(e.target.checked)} />Only unusual</label>
      </div>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Kind of action">{KINDS.map(([k, l]) => <button key={k} role="radio" aria-checked={kind === k} className={`toggle-opt !py-1 ${kind === k ? 'on' : ''}`} onClick={() => setKind(k)}>{l}</button>)}</div>
      <section className="card-flat overflow-hidden">
        {q.isLoading ? <div className="p-4"><Skeleton rows={6} /></div> : rows.length === 0 ? <Empty icon="lock" title="Nothing in this period" hint="Try a longer period or clear the filters." /> : (
          <div className="overflow-x-auto"><table className="table min-w-[760px]">
            <thead><tr><th>When</th><th>Who</th><th>What</th><th>Patient</th><th>From</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id} className="cursor-pointer hover:bg-white/60" onClick={() => setOpen(r)}>
                <td className="whitespace-nowrap font-semibold">{when(r.at)}</td>
                <td className="whitespace-nowrap">{r.userName ?? '—'}<span className="block text-xs text-muted">{ROLE_NAMES[r.role] ?? r.role ?? ''}</span></td>
                <td><span className="flex flex-wrap items-center gap-1.5">{r.kind !== 'change' && r.kind !== 'signin' && <Chip tone={KIND_TONE[r.kind] ?? ''}>{KINDS.find((k) => k[0] === r.kind)?.[1].split(' /')[0].toLowerCase()}</Chip>}{r.summary}{r.unusual && <Chip tone="amber">unusual</Chip>}</span></td>
                <td>{r.patient ? <button className="text-left hover:underline" onClick={(e) => { e.stopPropagation(); nav(`/patients/${r.patientId}`); }}>{r.patient}<span className="block text-xs text-muted">{r.patientNo}</span></button> : <span className="text-muted">—</span>}</td>
                <td className="whitespace-nowrap font-mono text-xs text-muted">{r.ip ?? ''}</td>
              </tr>))}</tbody>
          </table></div>)}
        {rows.length === 200 && <div className="p-3 text-center text-xs text-muted">Showing the latest 200. Narrow the filters to see older ones.</div>}
      </section>
      {open && <Modal title={open.summary} subtitle={`${when(open.at)} · ${open.userName ?? ''}${open.ip ? ` · ${open.ip}` : ''}`} onClose={() => setOpen(null)} width="max-w-2xl">
        <div className="space-y-3 text-sm">
          {open.patient && <div>Patient: <b>{open.patient}</b> {open.patientNo}</div>}
          {open.unusual && <div className="rounded-xl bg-amber-soft px-3 py-2 text-[#6E4D10]">Unusual: {open.kind === 'view' ? 'opened with no visit, booking, sale or procedure for this patient that day, or outside clinic hours' : open.kind === 'print' ? 'a list of patients left the app' : 'outside the usual pattern'}.</div>}
          <Changes before={open.before} after={open.after} />
          <div className="text-xs text-muted">{open.action}</div>
        </div>
      </Modal>}
    </div>
  );
}

/** Before and after, field by field. */
function Changes({ before, after }: { before: any; after: any }) {
  if (!before && !after) return null;
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])];
  const show = (v: any) => (v === undefined || v === null || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  return (
    <div className="overflow-x-auto rounded-xl border border-line"><table className="table">
      <thead><tr><th>Field</th>{before && <th>Before</th>}<th>{before ? 'After' : 'Sent'}</th></tr></thead>
      <tbody>{keys.map((k) => { const b = before?.[k], a = after?.[k]; const changed = before && show(b) !== show(a); return (
        <tr key={k}><td className="font-semibold">{k}</td>{before && <td className="max-w-[260px] break-words text-muted">{show(b)}</td>}<td className={`max-w-[300px] break-words ${changed ? 'font-semibold text-ink' : ''}`}>{show(a)}</td></tr>); })}</tbody>
    </table></div>
  );
}

/** "Seen by" on a patient's record: owner and admins. */
export function SeenBy({ patientId }: { patientId: string }) {
  const q = useQuery({ queryKey: ['seen-by', patientId], queryFn: () => get(`/patients/${patientId}/seen-by`) });
  if (!q.data?.length) return null;
  return <div className="text-xs text-muted">Seen by: {q.data.slice(0, 6).map((x: any, i: number) => <span key={i}>{i ? ' · ' : ''}<b className="text-ink-2">{x.name}</b> ({x.what.toLowerCase()}, {new Date(x.at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}{x.unusual ? <span className="text-amber"> · unusual</span> : ''})</span>)}</div>;
}
