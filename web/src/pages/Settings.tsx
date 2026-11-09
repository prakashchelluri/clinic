import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useOutletContext, useSearchParams } from 'react-router';
import { get, post, patch, api, qc, errText } from '../api';
import { Chip, Icon, Modal, PageHeader, Section, Skeleton, money, toast, NumInput, MoneyInput, toPaise, ask, useAddFromNew } from '../ui';
import { RoutineEditor, DEFAULT_ROUTINE, routineSummary } from '../routine';
import { RolesTab, DiscountCap, useRoles } from './Roles';
import { VITAL_FIELDS, DEFAULT_VITALS } from './FrontDesk';
import { PrivacyTab } from './Privacy';
import { TemplatesTab } from './SettingsTemplates';
import { PadTab } from './SettingsPad';
import { PackagesCard, CalendarLookCard } from '../packages';
import { AvailabilityTab, ServicesTab, BookingRulesTab, OnlineBookingTab, MessagesTab, PhotoAreasTab } from './SettingsScheduling';

type Tab = 'clinic' | 'day' | 'people' | 'roles' | 'rooms' | 'availability' | 'services' | 'rules' | 'online' | 'messages' | 'pad' | 'forms' | 'templates' | 'medicines' | 'procedures' | 'photos' | 'fees' | 'privacy' | 'testdata';
/** key, name, icon, what it is for (one plain sentence) */
type TabDef = [Tab, string, string, string];
const GROUPS: [string, string, TabDef[]][] = [
  ['Your clinic', 'Who works here, where, and how the day runs.', [
    ['clinic', 'Clinic details', 'home', 'Name, address and phone as printed on prescriptions, and how token numbers run.'],
    ['day', 'The day at the desk', 'queue', 'Vitals taken at arrival, junior screening, free return with reports, the waiting-room screen.'],
    ['people', 'Staff and doctors', 'users', 'Who can sign in, and the doctors whose names go on prescriptions.'],
    ['roles', 'What each role can do', 'lock', 'Which screens and actions reception, doctors, pharmacy and others have.'],
    ['rooms', 'Rooms', 'door', 'Procedure rooms and what each is equipped for.'],
    ['privacy', 'Privacy and security', 'lock', 'Work only from the clinic, idle sign-out, and the audit log.'],
  ]],
  ['Bookings and reminders', 'What patients can book, when, and how they are reminded.', [
    ['availability', 'Doctors’ weekly hours', 'clock', 'When each doctor sits for OP. The calendar fills from this every week.'],
    ['services', 'Visit types', 'calendar', 'What a patient books: name, length, colour on the calendar, fee.'],
    ['rules', 'Booking rules', 'list', 'How early to arrive, how late one can cancel, how the calendar looks.'],
    ['online', 'Online booking page', 'globe', 'Your public booking link and QR code, and what patients can book there.'],
    ['messages', 'WhatsApp reminders', 'message', 'Confirmations, reminders and follow-up messages sent to patients.'],
  ]],
  ['Consultations', 'What the doctor sees and prescribes.', [
    ['pad', 'Prescription pad', 'stetho', 'What the doctor fills in, which parts are required, and what prints.'],
    ['forms', 'Consultation form fields', 'edit', 'The complaints, examination findings and diagnoses the doctor picks from.'],
    ['templates', 'Templates', 'list', 'Ready sets of medicines, complaints, advice and tests, filled in one click.'],
    ['medicines', 'Medicines', 'pill', 'The medicines the doctor prescribes, with usual dosing and price.'],
    ['procedures', 'Procedures and packages', 'spark', 'Each procedure’s duration, price and room needs; multi-sitting packages.'],
    ['photos', 'Photo areas', 'user', 'Body areas for before and after photos.'],
  ]],
  ['Money', 'What a visit costs.', [
    ['fees', 'Consultation fees', 'rupee', 'The fee for each visit category, and which categories jump the queue.'],
  ]],
  ['Testing', 'Only on a test clinic.', [
    ['testdata', 'Test data', 'repeat', 'Wipe everything this clinic has done and load a week of sample data.'],
  ]],
];
const OWNER_ONLY = new Set<Tab>(['privacy', 'testdata']);
const TABS: TabDef[] = GROUPS.flatMap(([, , t]) => t);
/** The topic's name for the breadcrumb: Settings › Privacy and security. */
export const settingsTopic = (k: string | null) => TABS.find((t) => t[0] === k)?.[1] ?? null;
const FIELD_TYPES: [string, string][] = [['text', 'Short text'], ['textarea', 'Long text'], ['number', 'Number'], ['select', 'Pick one'], ['multiselect', 'Pick many'], ['tags', 'List (type several)'], ['diagnoses', 'Diagnoses with severity'], ['date', 'Date']];

/** Owner's control panel. Everything here is data: no deploy needed to change it.
 *  A home of plain cards, one per topic; opening one shows that topic alone with a way back and its neighbours. */
export function Settings() {
  const { cfg, me } = useOutletContext<any>();
  const owner = (me?.roles ?? []).includes('owner');
  const visible = (k: Tab) => owner || !OWNER_ONLY.has(k);
  const [params, setParams] = useSearchParams();
  const tab = TABS.find((t) => t[0] === params.get('tab') && visible(t[0]))?.[0] ?? null;
  // from the cards to a topic is a step of its own (Back returns to the cards); topic to topic replaces it
  const setTab = (k: Tab | null) => { setParams(k ? { tab: k } : {}, { replace: tab !== null && k !== null }); window.scrollTo({ top: 0 }); };
  const refresh = () => { qc.invalidateQueries({ queryKey: ['config'] }); qc.invalidateQueries({ queryKey: ['users'] }); };
  if (!cfg) return <div className="card"><Skeleton rows={5} /></div>;

  if (!tab) return (
    <div>
      <PageHeader title="Settings" subtitle="How the clinic runs. A change applies straight away, for everyone." />
      <div className="space-y-8">
        {GROUPS.filter(([, , tabs]) => tabs.some(([k]) => visible(k))).map(([g, about, tabs]) => (
          <section key={g} className="anim-fade-up">
            <div className="mb-3 flex items-baseline gap-3"><h2 className="text-[17px] font-semibold text-ink">{g}</h2><span className="text-[13.5px] text-muted">{about}</span></div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {tabs.filter(([k]) => visible(k)).map(([k, label, icon, hint]) => (
                <button key={k} type="button" onClick={() => setTab(k)} className="card flex items-start gap-3.5 text-left transition-colors hover:bg-surface-2">
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[12px] bg-paper-2 text-ink"><Icon name={icon} className="h-[18px] w-[18px]" /></span>
                  <span className="min-w-0 flex-1"><span className="block text-[15px] font-semibold text-ink">{label}</span><span className="mt-0.5 block text-[13px] leading-snug text-muted">{hint}</span></span>
                  <Icon name="chevR" className="mt-2.5 h-4 w-4 shrink-0 text-muted" />
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );

  const cur = TABS.find((t) => t[0] === tab)!;
  const group = GROUPS.find(([, , tabs]) => tabs.some(([k]) => k === tab))!;
  const siblings = group[2].filter(([k]) => k !== tab && visible(k));
  return (
    <div>
      <PageHeader title={cur[1]} subtitle={cur[3]} />
      {siblings.length > 0 && <div className="anim-fade-up mb-5 flex flex-wrap items-center gap-1.5 text-[12.5px] text-muted"><span className="mr-1">Also in {group[0]}:</span>{siblings.map(([k, label]) => <button key={k} type="button" className="toggle-opt" onClick={() => setTab(k)}>{label}</button>)}</div>}
      <div key={tab} id="settings-body" className="anim-fade-up min-w-0 max-w-[1100px]">
        {tab === 'availability' && <AvailabilityTab cfg={cfg} onSaved={refresh} />}
        {tab === 'services' && <ServicesTab cfg={cfg} onSaved={refresh} />}
        {tab === 'rules' && <><BookingRulesTab cfg={cfg} onSaved={refresh} /><CalendarLookCard cfg={cfg} onSaved={refresh} /></>}
        {tab === 'online' && <OnlineBookingTab cfg={cfg} onSaved={refresh} />}
        {tab === 'messages' && <MessagesTab cfg={cfg} onSaved={refresh} />}
        {tab === 'photos' && <PhotoAreasTab cfg={cfg} onSaved={refresh} />}
        {tab === 'clinic' && <ClinicTab cfg={cfg} onSaved={refresh} />}
        {tab === 'day' && <DayTab cfg={cfg} onSaved={refresh} />}
        {tab === 'people' && <PeopleTab cfg={cfg} onSaved={refresh} />}
        {tab === 'roles' && <><RolesTab onSaved={refresh} /><DiscountCap cfg={cfg} onSaved={refresh} /></>}
        {tab === 'pad' && <PadTab onSaved={refresh} />}
        {tab === 'forms' && <FormsTab cfg={cfg} onSaved={refresh} />}
        {tab === 'fees' && <FeesTab cfg={cfg} onSaved={refresh} />}
        {tab === 'templates' && <TemplatesTab cfg={cfg} />}
        {tab === 'medicines' && <MedicinesTab cfg={cfg} onSaved={refresh} />}
        {tab === 'procedures' && <><ProceduresTab cfg={cfg} onSaved={refresh} /><PackagesCard cfg={cfg} onSaved={refresh} /></>}
        {tab === 'rooms' && <RoomsTab cfg={cfg} onSaved={refresh} />}
        {tab === 'privacy' && owner && <PrivacyTab />}
        {tab === 'testdata' && owner && <TestDataCard />}
      </div>
    </div>
  );
}

/* ---------------- Clinic: what prints, how tokens count ---------------- */
function ClinicTab({ cfg, onSaved }: { cfg: any; onSaved: () => void }) {
  const s = cfg.tenant.settings ?? {};
  const [f, setF] = useState({ name: cfg.tenant.name, address: s.print?.address ?? '', phone: s.print?.phone ?? '', footer: s.print?.footer ?? '', opNumberScope: s.numbering?.opNumberScope ?? 'day+category' });
  const save = useMutation({ mutationFn: () => patch('/admin/clinic', { name: f.name, settings: { print: { address: f.address.trim(), phone: f.phone.trim(), footer: f.footer.trim() }, numbering: { opNumberScope: f.opNumberScope } } }), onSuccess: () => { toast('Clinic saved'); onSaved(); }, onError: (e: any) => toast(errText(e), 'err') });
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="space-y-4">
      <div className="card space-y-3">
        <div className="card-title">Printed on every prescription</div>
        <div><label className="label">Clinic name</label><input className="input" value={f.name} onChange={set('name')} /></div>
        <div><label className="label">Address</label><input className="input" value={f.address} onChange={set('address')} /></div>
        <div className="grid grid-cols-2 gap-3"><div><label className="label">Phone</label><input className="input" value={f.phone} onChange={set('phone')} /></div><div><label className="label">Line at the bottom</label><input className="input" value={f.footer} onChange={set('footer')} placeholder="e.g. Get well soon" /></div></div>
      </div>
      <div className="card space-y-3">
        <div className="card-title">Token numbers</div>
        <div className="flex flex-wrap gap-1">{[['day+category', 'One series per visit type (GEN-1, REN-1…)'], ['day', 'One series for the whole day (1, 2, 3…)']].map(([v, l]) => <button key={v} type="button" className={`toggle-opt ${f.opNumberScope === v ? 'on' : ''}`} onClick={() => setF({ ...f, opNumberScope: v })}>{l}</button>)}</div>
        <div className="text-xs text-muted">Numbers start again every morning.</div>
      </div>
      <div className="flex justify-end"><button className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate()}><Icon name="check" />Save</button></div>
    </div>
  );
}

/* ---------------- The day at the desk: arrival, screening, reports, the waiting-room screen ---------------- */
function DayTab({ cfg, onSaved }: { cfg: any; onSaved: () => void }) {
  const s = cfg.tenant.settings ?? {};
  const [vitals, setVitals] = useState<string[]>(s.vitals ?? DEFAULT_VITALS);
  const [f, setF] = useState({ screening: s.screening ?? 'off', freeDays: String(s.reports?.freeDays ?? 30) });
  const save = useMutation({ mutationFn: () => patch('/admin/clinic', { settings: { vitals, screening: f.screening, reports: { freeDays: Math.max(0, Math.min(365, Number(f.freeDays) || 0)) } } }), onSuccess: () => { toast('Saved'); onSaved(); }, onError: (e: any) => toast(errText(e), 'err') });
  return (
    <div className="space-y-4">
      <div className="card space-y-3">
        <div className="card-title">Vitals taken at arrival</div>
        <div className="flex flex-wrap gap-1.5">{VITAL_FIELDS.map((v) => <button key={v.key} type="button" className={`toggle-opt ${vitals.includes(v.key) ? 'on' : ''}`} onClick={() => setVitals(vitals.includes(v.key) ? vitals.filter((x) => x !== v.key) : VITAL_FIELDS.map((x) => x.key).filter((k) => k === v.key || vitals.includes(k)))}>{v.label} ({v.unit})</button>)}</div>
        <div className="text-xs text-muted">The dark ones are asked for on the arrival sheet and shown to the doctor. Switch off what your clinic does not measure.</div>
      </div>
      <div className="card space-y-3">
        <div className="card-title">Junior doctor screening</div>
        <div className="flex flex-wrap gap-1">{([['off', 'Off', 'Reception sends patients straight to the doctor'], ['first', 'When a junior is on', 'The junior screens whoever is waiting; the doctor takes screened patients first, others when nobody is screened'], ['required', 'Every patient', 'The doctor sees only patients the junior has screened']] as const).map(([v, l, h]) => <button key={v} type="button" title={h} className={`toggle-opt ${f.screening === v ? 'on' : ''}`} onClick={() => setF({ ...f, screening: v })}>{l}</button>)}</div>
        <div className="text-xs text-muted">{f.screening === 'off' ? 'Reception sends patients straight to the doctor. A junior doctor can still screen anyone waiting; the doctor does not wait for it.' : f.screening === 'first' ? 'The junior takes patients from the waiting list for screening. The doctor sees screened patients first and is never shown someone mid-screening.' : 'Reception cannot send a patient to the doctor until the junior has screened them.'}</div>
      </div>
      <div className="card space-y-3">
        <div className="card-title">Coming back with test reports</div>
        <div className="flex flex-wrap items-center gap-2 text-sm"><span>Free within</span><NumInput max={365} className="input !w-24" value={f.freeDays} onChange={(e: any) => setF({ ...f, freeDays: e.target.value })} /><span>days of the tests</span></div>
        <div className="text-xs text-muted">Within this time, coming back with reports has no fee, and the desk sees it pre-filled at check-in.</div>
      </div>
      <div className="flex justify-end"><button className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate()}><Icon name="check" />Save</button></div>
      <div className="card space-y-3">
        <div className="card-title">Waiting-room screen</div>
        <DisplayLinkCard />
      </div>
    </div>
  );
}

/** The waiting-room screen link: open it on a TV or tablet in the waiting area. Tokens only, no names. */
function DisplayLinkCard() {
  const q = useQuery({ queryKey: ['display-link'], queryFn: () => get('/admin/display') });
  const regen = useMutation({ mutationFn: () => get('/admin/display?regen=1'), onSuccess: () => { qc.invalidateQueries({ queryKey: ['display-link'] }); toast('New link made. The old screen stops showing.', 'info'); } });
  const url: string = q.data?.url ?? '';
  const copy = async () => { try { await navigator.clipboard.writeText(url); toast('Link copied'); } catch { toast('Copy the link from the box', 'info'); } };
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2"><input className="input min-w-0 flex-1 text-xs" readOnly value={url} onFocus={(e) => e.target.select()} /><button className="btn btn-sm" disabled={!url} onClick={copy}>Copy</button><a className="btn btn-sm" href={url || '#'} target="_blank" rel="noreferrer">Open</a><button className="btn btn-sm btn-ghost" disabled={regen.isPending} onClick={() => regen.mutate()}>New link</button></div>
      <div className="mt-1 text-xs text-muted">Shows Now and Next by token for each doctor, with a chime when a token is called. Anyone with the link can see tokens, so make a new link if a screen is lost.</div></div>
  );
}

/* ---------------- People: users (many roles each) + doctors ---------------- */
function PeopleTab({ cfg, onSaved }: { cfg: any; onSaved: () => void }) {
  const users = useQuery({ queryKey: ['users'], queryFn: () => get('/users') });
  const roleList: { key: string; name: string }[] = (useRoles().data ?? []).map((r: any) => ({ key: r.key, name: r.name })); const ROLES: [string, string][] = roleList.map((r) => [r.key, r.name]);
  const roleName = (k: string) => roleList.find((r) => r.key === k)?.name ?? k;
  const [edit, setEdit] = useState<any>(null); const [doc, setDoc] = useState<any>(null);
  useAddFromNew((w) => { if (w === 'user') setEdit({ name: '', email: '', password: '', roles: ['receptionist'], practitionerId: null, active: true }); if (w === 'doctor') setDoc({ name: '', regNo: '', qualification: '', active: true }); });
  const save = useMutation({ mutationFn: (u: any) => u.id ? patch(`/admin/users/${u.id}`, u) : post('/admin/users', u), onSuccess: () => { toast('Saved'); setEdit(null); onSaved(); }, onError: (e: any) => toast(errText(e), 'err') });
  const saveDoc = useMutation({ mutationFn: async ({ routine, ...p }: any) => { const row = p.id ? await patch(`/admin/practitioners/${p.id}`, p) : await post('/admin/practitioners', p); if (routine) await api('PUT', `/calendar/routine/${row.id}`, routine); return row; }, onSuccess: () => { toast('Saved'); setDoc(null); onSaved(); } });
  const toggleRole = (r: string) => setEdit({ ...edit, roles: edit.roles.includes(r) ? edit.roles.filter((x: string) => x !== r) : [...edit.roles, r] });
  return (
    <div className="space-y-4">
      <Section title="Staff accounts">
        {(users.data ?? []).map((u: any) => (
          <div key={u.id} className={`row ${u.active ? '' : 'opacity-50'}`}>
            <div className="flex-1 min-w-0"><div className="text-sm font-medium">{u.name}</div><div className="text-xs text-muted">{u.email}{u.practitionerId ? ` · ${cfg.practitioners.find((p: any) => p.id === u.practitionerId)?.name ?? ''}` : ''}</div></div>
            <div className="flex gap-1 flex-wrap justify-end">{(u.roles ?? [u.role]).map((r: string) => <Chip key={r} tone={r === 'owner' ? 'clay' : r === 'doctor' ? 'sky' : ''}>{roleName(r)}</Chip>)}{!u.active && <Chip tone="rose">inactive</Chip>}</div>
            <button className="btn btn-ghost btn-icon" onClick={() => setEdit({ ...u, roles: u.roles ?? [u.role], password: '' })}><Icon name="edit" /></button>
          </div>
        ))}
      </Section>
      <Section title="Doctors (practitioners)">
        {cfg.practitioners.map((p: any) => <div key={p.id} className="row"><div className="flex-1"><div className="text-sm font-medium">{p.name}</div><div className="text-xs text-muted">{[p.qualification, p.regNo && `Reg. ${p.regNo}`].filter(Boolean).join(' · ')}</div></div><Chip tone={p.routine ? 'sage' : 'amber'}>{routineSummary(p.routine)}</Chip><button className="btn btn-ghost btn-icon" onClick={() => setDoc({ ...p, routine: p.routine ?? DEFAULT_ROUTINE })}><Icon name="edit" /></button></div>)}
        <div className="px-4 py-2 text-xs text-muted">A doctor who also signs in needs a user account linked to their practitioner record (People → user → "Signs prescriptions as").</div>
      </Section>
      {edit && (
        <Modal title={edit.id ? 'Edit user' : 'New user'} subtitle="One person can hold several roles; permissions add up" onClose={() => setEdit(null)} width="max-w-md">
          <div className="space-y-3">
            <div><label className="label">Name</label><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></div>
            <div><label className="label">Email (used to sign in)</label><input className="input" type="email" value={edit.email} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></div>
            <div><label className="label">{edit.id ? 'New password (leave blank to keep)' : 'Password'}</label><input className="input" type="password" value={edit.password} onChange={(e) => setEdit({ ...edit, password: e.target.value })} /></div>
            <div><label className="label">Roles</label><div className="flex flex-wrap gap-1">{ROLES.map(([r, l]) => <button key={r} className={`toggle-opt ${edit.roles.includes(r) ? 'on' : ''}`} onClick={() => toggleRole(r)}>{l}</button>)}</div></div>
            {(edit.roles.includes('doctor') || edit.roles.includes('owner')) && <div><label className="label">Signs prescriptions as</label><select className="input" value={edit.practitionerId ?? ''} onChange={(e) => setEdit({ ...edit, practitionerId: e.target.value || null })}><option value="">Not a consulting doctor</option>{cfg.practitioners.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>}
            {edit.id && <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-clay" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> Active (uncheck when staff leave)</label>}
            <div className="modal-foot"><button className="btn btn-ghost" onClick={() => setEdit(null)}>Cancel</button><button className="btn btn-primary" disabled={!edit.name || !edit.email || !edit.roles.length || (!edit.id && !edit.password)} onClick={() => save.mutate({ id: edit.id, name: edit.name, email: edit.email, roles: edit.roles, practitionerId: edit.practitionerId, active: edit.active, ...(edit.password ? { password: edit.password } : {}) })}>Save</button></div>
          </div>
        </Modal>
      )}
      {doc && (
        <Modal title={doc.id ? 'Edit doctor' : 'New doctor'} subtitle="Profile for the prescription, and the weekly routine that fills the calendar" onClose={() => setDoc(null)} width="max-w-xl">
          <div className="space-y-3">
            <div><label className="label">Name (as printed)</label><input className="input" value={doc.name} onChange={(e) => setDoc({ ...doc, name: e.target.value })} /></div>
            <div className="grid grid-cols-2 gap-3"><div><label className="label">Registration no.</label><input className="input" value={doc.regNo ?? ''} onChange={(e) => setDoc({ ...doc, regNo: e.target.value })} /></div><div><label className="label">Qualification</label><input className="input" value={doc.qualification ?? ''} onChange={(e) => setDoc({ ...doc, qualification: e.target.value })} /></div></div>
            <div className="pt-3 border-t border-line"><div className="card-title mb-2">Weekly routine</div><RoutineEditor value={doc.routine ?? DEFAULT_ROUTINE} onChange={(r) => setDoc({ ...doc, routine: r })} /></div>
            {doc.id && <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-clay" checked={doc.active} onChange={(e) => setDoc({ ...doc, active: e.target.checked })} /> Active</label>}
            <div className="modal-foot"><button className="btn btn-ghost" onClick={() => setDoc(null)}>Cancel</button><button className="btn btn-primary" disabled={!doc.name} onClick={() => saveDoc.mutate({ id: doc.id, name: doc.name, regNo: doc.regNo || null, qualification: doc.qualification || null, active: doc.active, routine: doc.routine })}>Save</button></div>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ---------------- Forms editor: sections → fields → options ---------------- */
function FormsTab({ cfg, onSaved }: { cfg: any; onSaved: () => void }) {
  const current = cfg.forms.find((f: any) => f.key === 'encounter');
  const [schema, setSchema] = useState<any>(() => JSON.parse(JSON.stringify(current?.schema ?? { sections: [] })));
  const [sel, setSel] = useState<{ s: number; f: number } | null>(null);
  const save = useMutation({ mutationFn: () => post('/admin/forms/encounter', schema), onSuccess: (r: any) => { toast(`Published version ${r.version}`); onSaved(); } , onError: (e: any) => toast('Check keys: lowercase letters, numbers, underscores', 'err') });
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/(^_|_$)/g, '');
  const upd = (fn: (d: any) => void) => { const d = JSON.parse(JSON.stringify(schema)); fn(d); setSchema(d); };
  const field = sel ? schema.sections[sel.s]?.fields[sel.f] : null;
  return (
    <div className="space-y-3">
      <div className="text-sm text-muted">Version {current?.version}. Saving publishes a new version; past consultations keep the version they were written with.</div>
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] gap-4">
        <div className="space-y-3">
          {schema.sections.map((s: any, si: number) => (
            <div key={si} className="card !p-3">
              <div className="flex items-center gap-2 mb-2"><input className="input !w-56 font-medium" value={s.title} onChange={(e) => upd((d) => { d.sections[si].title = e.target.value; })} /><span className="text-[11px] text-muted font-mono">{s.key}</span>
                <span className="ml-auto flex gap-1"><button className="btn btn-ghost btn-icon" disabled={si === 0} onClick={() => upd((d) => { [d.sections[si - 1], d.sections[si]] = [d.sections[si], d.sections[si - 1]]; })}><Icon name="up" className="h-3.5 w-3.5" /></button><button className="btn btn-ghost btn-icon" onClick={async () => { const r = await ask({ title: `Remove the section “${s.title}”?`, body: `${s.fields.length === 0 ? 'It has no fields.' : s.fields.length === 1 ? 'Its 1 field goes with it.' : `Its ${s.fields.length} fields go with it.`} Nothing changes for doctors until you press Save.`, confirmLabel: 'Remove section', tone: 'danger' }); if (r) { upd((d) => { d.sections.splice(si, 1); }); setSel(null); } }}><Icon name="x" className="h-3.5 w-3.5" /></button></span></div>
              <div className="flex flex-wrap gap-1.5">
                {s.fields.map((f: any, fi: number) => <button key={fi} className={`toggle-opt ${sel?.s === si && sel?.f === fi ? 'on' : ''}`} onClick={() => setSel({ s: si, f: fi })}>{f.label}{f.required && <span className="text-clay"> *</span>}<span className="opacity-60 ml-1">· {FIELD_TYPES.find((t) => t[0] === f.type)?.[1]}</span></button>)}
                <button className="toggle-opt border-dashed" onClick={async () => { const r = await ask({ title: 'New field', body: `In “${s.title}”.`, confirmLabel: 'Add field', field: { label: 'Field label', placeholder: 'e.g. Itch severity', required: true, maxLength: 80 } }); if (!r) return; const label = r.value; upd((d) => { d.sections[si].fields.push({ key: slug(label), label, type: 'text' }); }); setSel({ s: si, f: s.fields.length }); }}><Icon name="plus" className="h-3 w-3 inline -mt-0.5" /> Field</button>
              </div>
            </div>
          ))}
          <button className="btn" onClick={async () => { const r = await ask({ title: 'New section', confirmLabel: 'Add section', field: { label: 'Section title', placeholder: 'e.g. Examination', required: true, maxLength: 80 } }); if (r) upd((d) => { d.sections.push({ key: slug(r.value), title: r.value, fields: [] }); }); }}><Icon name="plus" />Section</button>
        </div>
        <div className="card self-start lg:sticky lg:top-6">
          {!field ? <div className="text-sm text-muted">Select a field to edit its label, type, options and whether it is required.</div> : (
            <div className="space-y-3">
              <div><label className="label">Label</label><input className="input" value={field.label} onChange={(e) => upd((d) => { d.sections[sel!.s].fields[sel!.f].label = e.target.value; })} /></div>
              <div><label className="label">Type</label><div className="flex flex-wrap gap-1">{FIELD_TYPES.map(([t, l]) => <button key={t} className={`toggle-opt ${field.type === t ? 'on' : ''}`} onClick={() => upd((d) => { d.sections[sel!.s].fields[sel!.f].type = t; })}>{l}</button>)}</div></div>
              {['select', 'multiselect', 'tags', 'diagnoses'].includes(field.type) && <div><label className="label">{['tags', 'diagnoses'].includes(field.type) ? 'Suggestions (one per line; free text still allowed)' : 'Options (one per line)'}</label><textarea className="input min-h-40 font-mono text-xs" value={(field.options ?? []).join('\n')} onChange={(e) => upd((d) => { d.sections[sel!.s].fields[sel!.f].options = e.target.value.split('\n').map((x) => x.trim()).filter(Boolean); })} /></div>}
              <div className="grid grid-cols-2 gap-2"><div><label className="label">Placeholder</label><input className="input" value={field.placeholder ?? ''} onChange={(e) => upd((d) => { d.sections[sel!.s].fields[sel!.f].placeholder = e.target.value || undefined; })} /></div><div><label className="label">Unit</label><input className="input" value={field.unit ?? ''} onChange={(e) => upd((d) => { d.sections[sel!.s].fields[sel!.f].unit = e.target.value || undefined; })} /></div></div>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-clay" checked={!!field.required} onChange={(e) => upd((d) => { d.sections[sel!.s].fields[sel!.f].required = e.target.checked; })} /> Required to complete a consultation</label>
              <div className="text-[11px] text-muted font-mono">key: {field.key}</div>
              <div className="flex justify-between"><button className="btn btn-ghost text-rose btn-sm" onClick={() => { upd((d) => { d.sections[sel!.s].fields.splice(sel!.f, 1); }); setSel(null); }}>Remove field</button>
                <span className="flex gap-1"><button className="btn btn-ghost btn-icon" disabled={sel!.f === 0} onClick={() => { upd((d) => { const a = d.sections[sel!.s].fields; [a[sel!.f - 1], a[sel!.f]] = [a[sel!.f], a[sel!.f - 1]]; }); setSel({ s: sel!.s, f: sel!.f - 1 }); }}><Icon name="chevL" className="h-3.5 w-3.5" /></button><button className="btn btn-ghost btn-icon" disabled={sel!.f >= schema.sections[sel!.s].fields.length - 1} onClick={() => { upd((d) => { const a = d.sections[sel!.s].fields; [a[sel!.f + 1], a[sel!.f]] = [a[sel!.f], a[sel!.f + 1]]; }); setSel({ s: sel!.s, f: sel!.f + 1 }); }}><Icon name="chevR" className="h-3.5 w-3.5" /></button></span></div>
            </div>
          )}
        </div>
      </div>
      <div className="flex justify-end gap-2"><button className="btn btn-ghost" onClick={() => setSchema(JSON.parse(JSON.stringify(current.schema)))}>Discard changes</button><button className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate()}><Icon name="check" />Publish new version</button></div>
    </div>
  );
}

/* ---------------- Fees ---------------- */
function FeesTab({ cfg, onSaved }: { cfg: any; onSaved: () => void }) {
  const [edit, setEdit] = useState<any>(null);
  useAddFromNew(() => setEdit({ code: '', name: '', amount: '', priority: 0, affectsCapacity: true, active: true }));
  const save = useMutation({ mutationFn: (c: any) => c.id ? patch(`/admin/fee-categories/${c.id}`, c) : post('/admin/fee-categories', c), onSuccess: () => { toast('Fee saved'); setEdit(null); onSaved(); }, onError: (e: any) => toast(errText(e), 'err') });
  return (
    <Section title="Visit categories & fees">
      <table className="table"><thead><tr><th className="pl-4">Code</th><th>Name</th><th className="text-right">Fee</th><th>Rule</th><th>Queue</th><th /></tr></thead>
        <tbody>{cfg.feeCategories.map((c: any) => <tr key={c.id}><td className="pl-4 font-mono text-xs">{c.code}</td><td>{c.name}</td><td className="text-right">{money(c.amountPaise)}</td><td className="text-xs text-muted">{c.eligibilityNote ?? (c.eligibility ? 'auto-suggested by rule' : 'manual')}</td><td>{c.priority > 0 && <Chip tone="amber">jumps queue</Chip>}</td><td className="text-right pr-3"><button className="btn btn-ghost btn-icon" onClick={() => setEdit({ ...c, amount: c.amountPaise / 100 })}><Icon name="edit" /></button></td></tr>)}</tbody></table>
      {edit && (
        <Modal title={edit.id ? `Edit ${edit.code}` : 'New category'} onClose={() => setEdit(null)} width="max-w-md" submitOnEnter>
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-2"><div><label className="label">Code</label><input className="input uppercase" maxLength={8} value={edit.code} disabled={!!edit.id} onChange={(e) => setEdit({ ...edit, code: e.target.value.toUpperCase() })} /></div><div className="col-span-2"><label className="label">Name</label><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></div></div>
            <div className="grid grid-cols-2 gap-2"><div><label className="label">Fee (₹)</label><MoneyInput value={String(edit.amount ?? "")} onChange={(v) => setEdit({ ...edit, amount: v })} /></div><div><label className="label">Queue priority (0 = normal)</label><input type="number" className="input" value={edit.priority} onChange={(e) => setEdit({ ...edit, priority: Number(e.target.value) })} /></div></div>
            <div><label className="label">Rule note (shown to reception)</label><input className="input" value={edit.eligibilityNote ?? ''} onChange={(e) => setEdit({ ...edit, eligibilityNote: e.target.value })} /></div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-clay" checked={edit.affectsCapacity} onChange={(e) => setEdit({ ...edit, affectsCapacity: e.target.checked })} /> Counts against window capacity</label>
            {edit.id && <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-clay" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> Active</label>}
            <div className="modal-foot"><button className="btn btn-ghost" onClick={() => setEdit(null)}>Cancel</button><button className="btn btn-primary" disabled={!edit.code || !edit.name} onClick={() => save.mutate({ id: edit.id, code: edit.code, name: edit.name, amountPaise: Math.round(Number(edit.amount || 0) * 100), priority: edit.priority, affectsCapacity: edit.affectsCapacity, eligibilityNote: edit.eligibilityNote || null, active: edit.active })}>Save</button></div>
          </div>
        </Modal>
      )}
    </Section>
  );
}

/* ---------------- Medicines ---------------- */
function MedicinesTab({ cfg, onSaved }: { cfg: any; onSaved: () => void }) {
  const [edit, setEdit] = useState<any>(null); const [q, setQ] = useState('');
  useAddFromNew(() => setEdit({ name: '', form: 'tab', scheduleClass: 'H', defaults: {}, packSize: 10, reorderLevel: 5 }));
  const save = useMutation({ mutationFn: ({ mrp, id, ...m }: any) => { const b = { ...m, mrpPaise: mrp !== undefined ? toPaise(mrp || '0') : m.mrpPaise, gstBp: m.gstBp ?? 1200, hsn: m.hsn || null }; delete b.createdAt; delete b.tenantId; return id ? patch(`/admin/medicines/${id}`, b) : post('/admin/medicines', b); }, onSuccess: () => { toast('Medicine saved'); setEdit(null); onSaved(); } });
  const del = useMutation({ mutationFn: (id: string) => api('DELETE', `/admin/medicines/${id}`), onSuccess: () => { toast('Removed', 'info'); setEdit(null); onSaved(); }, onError: () => toast('In use by a prescription; cannot delete', 'err') });
  const list = cfg.medicines.filter((m: any) => m.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <Section title={<>Favourites <span className="text-muted font-normal">· {cfg.medicines.length}</span></>} aside={<><input className="input !w-48 !py-1.5" placeholder="Filter" value={q} onChange={(e) => setQ(e.target.value)} /></>}>
      <table className="table"><thead><tr><th className="pl-4">Name</th><th>Form</th><th>Schedule</th><th>Price</th><th>Default</th><th /></tr></thead>
        <tbody>{list.map((m: any) => <tr key={m.id}><td className="pl-4 font-medium">{m.name}</td><td className="text-muted">{m.form}</td><td><Chip tone={m.scheduleClass === 'OTC' ? '' : 'amber'}>{m.scheduleClass ?? '—'}</Chip></td><td className={m.mrpPaise ? '' : 'text-rose text-xs'}>{m.mrpPaise ? `${money(m.mrpPaise)} · ${m.gstBp / 100}%` : 'not set'}</td><td className="text-xs text-muted">{[m.defaults?.dose, m.defaults?.frequency, m.defaults?.durationDays ? `${m.defaults.durationDays}d` : null].filter(Boolean).join(' · ')}</td><td className="text-right pr-3"><button className="btn btn-ghost btn-icon" onClick={() => setEdit({ ...m, defaults: m.defaults ?? {} })}><Icon name="edit" /></button></td></tr>)}</tbody></table>
      {edit && (
        <Modal title={edit.id ? 'Edit medicine' : 'New medicine'} onClose={() => setEdit(null)} width="max-w-lg">
          <div className="space-y-3">
            <div><label className="label">Name (with strength)</label><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></div>
            <div className="grid grid-cols-2 gap-2">
              <div><label className="label">Form</label><div className="flex flex-wrap gap-1">{['tab', 'cap', 'cream', 'gel', 'lotion', 'syrup', 'inj', 'soap'].map((x) => <button key={x} className={`toggle-opt ${edit.form === x ? 'on' : ''}`} onClick={() => setEdit({ ...edit, form: x })}>{x}</button>)}</div></div>
              <div><label className="label">Schedule</label><div className="flex gap-1">{['OTC', 'H', 'H1', 'X'].map((x) => <button key={x} className={`toggle-opt ${edit.scheduleClass === x ? 'on' : ''}`} onClick={() => setEdit({ ...edit, scheduleClass: x })}>{x}</button>)}</div></div>
            </div>
            <div className="card-title">Pharmacy counter</div>
            <div className="grid grid-cols-3 gap-2">
              <div><label className="label">Price per unit (MRP, GST included)</label><MoneyInput value={edit.mrp ?? String((edit.mrpPaise ?? 0) / 100 || '')} onChange={(v: string) => setEdit({ ...edit, mrp: v })} /></div>
              <div><label className="label">GST</label><div className="flex flex-wrap gap-1">{[0, 500, 1200, 1800].map((x) => <button key={x} className={`toggle-opt ${(edit.gstBp ?? 1200) === x ? 'on' : ''}`} onClick={() => setEdit({ ...edit, gstBp: x })}>{x / 100}%</button>)}</div></div>
              <div><label className="label">HSN code</label><input className="input" inputMode="numeric" maxLength={8} value={edit.hsn ?? ''} onChange={(e) => setEdit({ ...edit, hsn: e.target.value.replace(/\D/g, '') })} /></div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div><label className="label">{['tab', 'cap'].includes(edit.form) ? 'Tablets per strip (price is per strip)' : 'Units per pack'}</label><NumInput max={1000} className={`input ${Number(edit.packSize ?? 1) >= 1 ? '' : '!border-rose'}`} value={edit.packSize ?? 1} onChange={(e) => setEdit({ ...edit, packSize: e.target.value })} /></div>
              <div><label className="label">Low stock below (packs)</label><NumInput max={100000} className="input" value={edit.reorderLevel ?? 0} onChange={(e) => setEdit({ ...edit, reorderLevel: e.target.value })} /></div>
            </div>
            <div className="card-title">Defaults filled into the prescription</div>
            <div className="grid grid-cols-4 gap-2">
              <div><label className="label">Dose</label><input className="input" value={edit.defaults.dose ?? ''} onChange={(e) => setEdit({ ...edit, defaults: { ...edit.defaults, dose: e.target.value } })} /></div>
              <div><label className="label">Route</label><input className="input" value={edit.defaults.route ?? ''} onChange={(e) => setEdit({ ...edit, defaults: { ...edit.defaults, route: e.target.value } })} /></div>
              <div><label className="label">Frequency</label><input className="input" value={edit.defaults.frequency ?? ''} onChange={(e) => setEdit({ ...edit, defaults: { ...edit.defaults, frequency: e.target.value } })} /></div>
              <div><label className="label">Days</label><NumInput max={365} className="input" value={edit.defaults.durationDays ?? ''} onChange={(e) => setEdit({ ...edit, defaults: { ...edit.defaults, durationDays: e.target.value ? Number(e.target.value) : undefined } })} /></div>
            </div>
            <div><label className="label">Instructions</label><input className="input" value={edit.defaults.instructions ?? ''} onChange={(e) => setEdit({ ...edit, defaults: { ...edit.defaults, instructions: e.target.value } })} /></div>
            <div className="card-title">How to use leaflet</div>
            <LeafletField med={edit} onChange={(leafletUrl) => setEdit({ ...edit, leafletUrl })} onSaved={onSaved} />
            <div className="modal-foot !justify-between">{edit.id ? <button className="btn btn-ghost text-rose" onClick={() => del.mutate(edit.id)}>Delete</button> : <span />}<div className="flex gap-2"><button className="btn btn-ghost" onClick={() => setEdit(null)}>Cancel</button><button className="btn btn-primary" disabled={!edit.name || !(Number(edit.packSize ?? 1) >= 1)} onClick={() => save.mutate({ id: edit.id, name: edit.name, form: edit.form, scheduleClass: edit.scheduleClass, defaults: edit.defaults, mrp: edit.mrp, mrpPaise: edit.mrpPaise, gstBp: edit.gstBp, hsn: edit.hsn, leafletUrl: edit.leafletUrl?.trim() || null, packSize: Number(edit.packSize ?? 1), reorderLevel: Number(edit.reorderLevel ?? 0) })}>Save</button></div></div>
          </div>
        </Modal>
      )}
    </Section>
  );
}

/** The sheet sent to the patient on WhatsApp with the prescription: upload a PDF or picture, or paste a link the clinic already hosts. */
function LeafletField({ med, onChange, onSaved }: { med: any; onChange: (url: string | null) => void; onSaved: () => void }) {
  const upload = useMutation({
    mutationFn: async (f: File) => {
      if (f.size > 5 * 1024 * 1024) throw new Error('TOO_LARGE');
      const dataBase64 = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(f); });
      return post(`/admin/medicines/${med.id}/leaflet`, { mime: f.type, dataBase64 });
    },
    onSuccess: (row: any) => { onChange(row.leafletUrl); toast('Leaflet uploaded'); onSaved(); },
    onError: (e: any) => toast(e?.message === 'TOO_LARGE' ? 'Keep the leaflet under 5 MB' : errText(e), 'err'),
  });
  const isFile = /\/api\/public\/leaflet\//.test(med.leafletUrl ?? '');
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <input className="input min-w-0 flex-1" placeholder="https://… a PDF or page the patient can open" value={isFile ? '' : med.leafletUrl ?? ''} disabled={isFile} onChange={(e) => onChange(e.target.value)} />
        {med.id ? <label className={`btn btn-sm cursor-pointer ${upload.isPending ? 'opacity-50' : ''}`}><Icon name="plus" className="h-3.5 w-3.5" />{upload.isPending ? 'Uploading…' : 'Upload PDF'}<input type="file" className="sr-only" accept="application/pdf,image/jpeg,image/png" disabled={upload.isPending} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) upload.mutate(f); }} /></label>
          : <span className="text-xs text-muted">Save the medicine first to upload a file</span>}
      </div>
      {med.leafletUrl && <div className="flex items-center gap-2 text-xs"><a className="text-sky underline" href={med.leafletUrl} target="_blank" rel="noreferrer">{isFile ? 'Open the uploaded leaflet' : 'Open link'}</a><button type="button" className="btn btn-ghost btn-sm !min-h-6 !px-1.5 text-rose" onClick={() => onChange(null)}>Remove</button><span className="text-muted">· sent with every prescription that has this medicine</span></div>}
    </div>
  );
}

/* ---------------- Procedures ---------------- */
function ProceduresTab({ cfg, onSaved }: { cfg: any; onSaved: () => void }) {
  const [edit, setEdit] = useState<any>(null);
  useAddFromNew(() => setEdit({ name: '', typicalMinutes: 30, bufferMinutes: 0, typicalSittings: 1, price: '', requiresMainDoctor: false, requiresReview: false, requiredCapability: '', taxRateBp: 0, active: true }));
  const caps = [...new Set<string>(cfg.rooms.flatMap((r: any) => r.capabilities))];
  const save = useMutation({ mutationFn: (p: any) => p.id ? patch(`/admin/procedures/${p.id}`, p) : post('/admin/procedures', p), onSuccess: () => { toast('Procedure saved'); setEdit(null); onSaved(); } });
  return (
    <Section title="Procedure catalogue">
      <table className="table"><thead><tr><th className="pl-4">Name</th><th>Typical</th><th>Sittings</th><th>Needs room with</th><th className="text-right">Price</th><th>GST</th><th>Rules</th><th /></tr></thead>
        <tbody>{cfg.procedures.map((p: any) => <tr key={p.id}><td className="pl-4 font-medium">{p.name}</td><td className="text-muted">{p.typicalMinutes} min{p.bufferMinutes ? ` +${p.bufferMinutes}` : ''}</td><td>{p.typicalSittings}</td><td>{p.requiredCapability ? <Chip>{p.requiredCapability}</Chip> : <span className="text-muted text-xs">any</span>}</td><td className="text-right">{p.pricePaise != null ? money(p.pricePaise) : '—'}</td><td className="text-xs text-muted">{p.taxRateBp ? `${p.taxRateBp / 100}%` : 'exempt'}</td><td><div className="flex gap-1 flex-wrap">{p.requiresMainDoctor && <Chip tone="clay">doctor</Chip>}{p.requiresReview && <Chip tone="amber">review</Chip>}</div></td><td className="text-right pr-3"><button className="btn btn-ghost btn-icon" onClick={() => setEdit({ ...p, price: p.pricePaise != null ? p.pricePaise / 100 : '', requiredCapability: p.requiredCapability ?? '' })}><Icon name="edit" /></button></td></tr>)}</tbody></table>
      {edit && (
        <Modal title={edit.id ? 'Edit procedure' : 'New procedure'} onClose={() => setEdit(null)} width="max-w-lg">
          <div className="space-y-3">
            <div><label className="label">Name</label><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></div>
            <div className="grid grid-cols-4 gap-2">
              <div><label className="label">Minutes</label><NumInput max={600} className="input" value={edit.typicalMinutes} onChange={(e) => setEdit({ ...edit, typicalMinutes: Number(e.target.value) })} /></div>
              <div><label className="label">Buffer after</label><NumInput max={240} className="input" value={edit.bufferMinutes ?? 0} onChange={(e) => setEdit({ ...edit, bufferMinutes: Number(e.target.value) })} /></div>
              <div><label className="label">Sittings</label><NumInput max={50} className="input" value={edit.typicalSittings} onChange={(e) => setEdit({ ...edit, typicalSittings: Number(e.target.value) })} /></div>
              <div><label className="label">Price (₹)</label><MoneyInput value={String(edit.price ?? "")} onChange={(v) => setEdit({ ...edit, price: v })} /></div>
            </div>
            <div><label className="label">Needs a room with</label><div className="flex flex-wrap gap-1"><button className={`toggle-opt ${!edit.requiredCapability ? 'on' : ''}`} onClick={() => setEdit({ ...edit, requiredCapability: '' })}>any room</button>{caps.map((c) => <button key={c} className={`toggle-opt ${edit.requiredCapability === c ? 'on' : ''}`} onClick={() => setEdit({ ...edit, requiredCapability: c })}>{c}</button>)}</div><div className="text-[11px] text-muted mt-1">Capabilities come from Rooms. Add a new one there first.</div></div>
            <div><label className="label">GST</label><div className="flex gap-1">{[[0, 'Exempt (medical)'], [1800, '18% (cosmetic)']].map(([v, l]) => <button key={v} className={`toggle-opt ${edit.taxRateBp === v ? 'on' : ''}`} onClick={() => setEdit({ ...edit, taxRateBp: v })}>{l}</button>)}</div></div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-clay" checked={edit.requiresMainDoctor} onChange={(e) => setEdit({ ...edit, requiresMainDoctor: e.target.checked })} /> Needs a doctor present (blocks their OP time)</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-clay" checked={edit.requiresReview} onChange={(e) => setEdit({ ...edit, requiresReview: e.target.checked })} /> Doctor reviews the plan before the patient is confirmed</label>
            {edit.id && <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-clay" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> Active</label>}
            <div className="modal-foot"><button className="btn btn-ghost" onClick={() => setEdit(null)}>Cancel</button><button className="btn btn-primary" disabled={!edit.name} onClick={() => save.mutate({ id: edit.id, name: edit.name, typicalMinutes: edit.typicalMinutes, bufferMinutes: edit.bufferMinutes ?? 0, typicalSittings: edit.typicalSittings, pricePaise: edit.price === '' ? null : Math.round(Number(edit.price) * 100), taxRateBp: edit.taxRateBp, requiresMainDoctor: edit.requiresMainDoctor, requiresReview: edit.requiresReview, requiredCapability: edit.requiredCapability || null, active: edit.active })}>Save</button></div>
          </div>
        </Modal>
      )}
    </Section>
  );
}

/* ---------------- Rooms ---------------- */
function RoomsTab({ cfg, onSaved }: { cfg: any; onSaved: () => void }) {
  const [edit, setEdit] = useState<any>(null);
  useAddFromNew(() => setEdit({ name: '', capabilities: ['procedure'], active: true, newCap: '' }));
  const allCaps = [...new Set<string>([...cfg.rooms.flatMap((r: any) => r.capabilities), 'procedure', 'laser', 'cryo', 'minor_ot'])];
  const save = useMutation({ mutationFn: (r: any) => r.id ? patch(`/admin/rooms/${r.id}`, r) : post('/admin/rooms', r), onSuccess: () => { toast('Room saved'); setEdit(null); onSaved(); } });
  return (
    <Section title={<>Rooms <span className="text-muted font-normal">· {cfg.rooms.length}</span></>}>
      {cfg.rooms.map((r: any) => <div key={r.id} className="row"><div className="flex-1"><div className="text-sm font-medium">{r.name}</div></div><div className="flex gap-1 flex-wrap">{r.capabilities.map((c: string) => <Chip key={c}>{c}</Chip>)}</div><button className="btn btn-ghost btn-icon" onClick={() => setEdit({ ...r, newCap: '' })}><Icon name="edit" /></button></div>)}
      <div className="px-4 py-2 text-xs text-muted">A capability is a tag such as "laser" or "minor_ot". Procedures declare which tag they need; scheduling only offers rooms that have it. Rooms cannot be treated as interchangeable.</div>
      {edit && (
        <Modal title={edit.id ? 'Edit room' : 'New room'} onClose={() => setEdit(null)} width="max-w-md" submitOnEnter>
          <div className="space-y-3">
            <div><label className="label">Name</label><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></div>
            <div><label className="label">Capabilities</label><div className="flex flex-wrap gap-1">{allCaps.map((c) => <button key={c} className={`toggle-opt ${edit.capabilities.includes(c) ? 'on' : ''}`} onClick={() => setEdit({ ...edit, capabilities: edit.capabilities.includes(c) ? edit.capabilities.filter((x: string) => x !== c) : [...edit.capabilities, c] })}>{c}</button>)}</div>
              <div className="flex gap-2 mt-2"><input className="input" placeholder="new capability, e.g. phototherapy" value={edit.newCap} onChange={(e) => setEdit({ ...edit, newCap: e.target.value.toLowerCase().replace(/[^a-z0-9_]+/g, '_') })} /><button className="btn btn-sm" disabled={!edit.newCap} onClick={() => setEdit({ ...edit, capabilities: [...edit.capabilities, edit.newCap], newCap: '' })}>Add</button></div></div>
            {edit.id && <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-clay" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> Active</label>}
            <div className="modal-foot"><button className="btn btn-ghost" onClick={() => setEdit(null)}>Cancel</button><button className="btn btn-primary" disabled={!edit.name} onClick={() => save.mutate({ id: edit.id, name: edit.name, capabilities: edit.capabilities, active: edit.active })}>Save</button></div>
          </div>
        </Modal>
      )}
    </Section>
  );
}

/** Owner-only: wipe everything this clinic has done and load realistic test data from scratch (patients, a week of bookings, requests, messages, courses with photos). */
function TestDataCard() {
  const [result, setResult] = useState<any>(null);
  const load = useMutation({ mutationFn: () => post('/dev/reset-sample', { confirm: 'RESET' }), onSuccess: (r: any) => { setResult(r); qc.clear(); qc.invalidateQueries(); toast('Cleared and loaded fresh test data'); }, onError: (e: any) => toast(errText(e), 'err') });
  const run = async () => {
    const r = await ask({
      title: 'Clear everything and load fresh test data?',
      body: 'This deletes every patient, booking, visit, prescription, bill, payment, stock movement, message and photo record in this clinic, and then loads a new set of test data. Your staff, doctors, rooms, prices, forms and templates stay. It cannot be undone. Use it only on a test clinic.',
      confirmLabel: 'Clear and load',
      field: { label: 'Type RESET to confirm', required: true, maxLength: 10 },
    });
    if (!r) return;
    if (r.value.trim().toUpperCase() !== 'RESET') return toast('Nothing was changed. Type RESET to confirm.', 'info');
    load.mutate();
  };
  return (
    <div className="card space-y-3">
      <div className="card-title">Test data</div>
      <div className="text-sm text-ink-2">Clears everything this clinic has done and starts fresh with one week of realistic data including today: bookings, visits, pharmacy bills and counter sales, expenses, online requests, repeat visits, patient messages and two procedure courses with before/after photos. Staff, doctors, rooms, prices, forms and templates are kept. Use it on a test clinic, not one with real patients.</div>
      {result && <div className="rounded-2xl bg-sage-soft px-4 py-3 text-sm text-sage">Cleared and loaded {result.from} to {result.to}: {result.booked + result.confirmed} upcoming bookings ({result.confirmed} confirmed), {result.arrived} past visits, {result.no_show} no-shows, {result.cancelled} cancelled, {result.pharmacyBills + result.counterSales} pharmacy sales, {result.expenses} expenses, {result.requested} online requests, {result.series} repeat visits, {result.sittings} procedure sittings, {result.photos} photos.</div>}
      <button className="btn" disabled={load.isPending} onClick={run}>{load.isPending ? 'Working… (up to a minute)' : 'Clear everything and load test data'}</button>
    </div>
  );
}
