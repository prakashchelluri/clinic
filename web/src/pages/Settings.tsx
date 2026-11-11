import { useEffect, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useOutletContext, useSearchParams } from 'react-router';
import { get, post, patch, api, qc, errText } from '../api';
import { Chip, Icon, Modal, PageHeader, Section, Skeleton, Tabs, money, toast, NumInput, MoneyInput, toPaise, ask, useAddFromNew, usePageSearch } from '../ui';
import { RoutineEditor, DEFAULT_ROUTINE, routineSummary } from '../routine';
import { RolesTab, DiscountCap, useRoles } from './Roles';
import { vitalFields, DEFAULT_VITALS, BUILTIN_VITALS, type VitalField } from '../vitals';
import { PrivacyTab } from './Privacy';
import { TemplatesTab } from './SettingsTemplates';
import { PadTab } from './SettingsPad';
import { PackagesCard, CalendarLookCard } from '../packages';
import { AvailabilityTab, ServicesTab, BookingRulesTab, MessagesTab, PhotoAreasTab } from './SettingsScheduling';
import { ALLERGY_CLASSES } from '../rxSafety';
import '../settings.css';

type Tab = 'clinic' | 'day' | 'availability' | 'rooms' | 'people' | 'roles' | 'prices' | 'rules' | 'messages' | 'pad' | 'forms' | 'templates' | 'photos' | 'privacy' | 'testdata';
/** key, name, what it is for (one plain sentence) */
type TabDef = [Tab, string, string];
/** Six groups. name, icon, what is in it, extra words the search finds it by, its topics. */
const GROUPS: [string, string, string, string, TabDef[]][] = [
  ['Clinic', 'home', 'Details on prescriptions, the day at the desk, doctors’ hours and rooms.', 'address phone token upi qr screening junior waiting room tv screen hours routine room laser', [
    ['clinic', 'Details', 'Name, address and phone as printed on prescriptions, and how token numbers run.'],
    ['day', 'The day at the desk', 'Junior screening, free return with reports, the waiting-room screen.'],
    ['availability', 'Doctors’ hours', 'When each doctor sits for OP. The calendar fills from this every week.'],
    ['rooms', 'Rooms', 'Procedure rooms and what each one has.'],
  ]],
  ['People', 'users', 'Staff who sign in, the doctors, and what each role can do.', 'staff user password login account doctor role permission access', [
    ['people', 'Staff and doctors', 'Who can sign in, and the doctors whose names go on prescriptions.'],
    ['roles', 'What each role can do', 'Which screens and actions reception, doctors, pharmacy and others have.'],
  ]],
  ['Prices', 'rupee', 'Everything the clinic charges, on one screen.', 'fee fees consultation visit type procedure package medicine mrp gst tax hsn discount', [
    ['prices', 'Prices', 'Consultation fees, visit types, procedures and packages, medicines with MRP and GST, and the discount limit.'],
  ]],
  ['Bookings', 'calendar', 'Booking rules and WhatsApp reminders.', 'booking cancel arrive calendar reminder whatsapp message confirmation', [
    ['rules', 'Booking rules', 'How early to arrive, how late one can cancel, how the calendar looks.'],
    ['messages', 'WhatsApp reminders', 'Confirmations, reminders and follow-up messages sent to patients.'],
  ]],
  ['Prescription', 'stetho', 'The pad, form fields, templates and photo areas.', 'pad print rx vitals complaints diagnosis form template photo', [
    ['pad', 'Prescription pad', 'What the doctor fills in, which parts are required, and what prints.'],
    ['forms', 'Form fields', 'The vitals taken, and the complaints, examination findings and diagnoses the doctor picks from.'],
    ['templates', 'Templates', 'Ready sets of medicines, complaints, advice and tests, filled in one click.'],
    ['photos', 'Photo areas', 'Body areas for before and after photos.'],
  ]],
  ['Privacy & security', 'lock', 'Work only from the clinic, idle sign-out, phone numbers and the audit log.', 'ip internet address lock audit phone export privacy test data reset', [
    ['privacy', 'Privacy and security', 'Work only from the clinic, idle sign-out, and the audit log.'],
    ['testdata', 'Test data', 'Wipe everything this clinic has done and load a week of sample data.'],
  ]],
];
const OWNER_ONLY_GROUP = 'Privacy & security';
const TABS: TabDef[] = GROUPS.flatMap((g) => g[4]);
/** Old links (?tab=fees, ?tab=medicines…) still land on the right screen. */
const ALIAS: Record<string, [Tab, string]> = { fees: ['prices', 'price-fees'], services: ['prices', 'price-visits'], procedures: ['prices', 'price-procedures'], medicines: ['prices', 'price-medicines'] };
const groupOf = (k: Tab) => GROUPS.find((g) => g[4].some((t) => t[0] === k))!;
/** The topic's name for the breadcrumb: Settings › Prices. */
export const settingsTopic = (k: string | null) => { const t = ALIAS[k ?? '']?.[0] ?? k; return TABS.find((x) => x[0] === t)?.[1] ?? null; };
/** Server refusals on this page, as sentences. */
const SAY: Record<string, string> = {
  OWNER_ONLY_GRANT: 'Only an owner can make someone an owner, or take the owner role away.',
  OWNER_ONLY_EDIT: "Only an owner can change an owner's email, password or whether they are active.",
  LAST_OWNER: 'The clinic needs at least one active owner. Make someone else an owner first.',
  CANNOT_DEACTIVATE_SELF: 'You cannot switch off your own account.',
  WRONG_CURRENT_PASSWORD: 'Your current password is not right.',
  SAME_PASSWORD: 'Pick a new password that is different from the current one.',
  NOT_A_TEST_CLINIC: 'This clinic has real patients, so test data is switched off.',
};
const say = (e: any) => SAY[e?.body?.code] ?? errText(e);
/** Switched-off doctors, fees, procedures and rooms, fetched only when "Show inactive" is ticked. */
function useInactive(on: boolean) { return useQuery({ queryKey: ['inactive'], queryFn: () => get('/admin/inactive'), enabled: on }); }
function ShowInactive({ on, set, n }: { on: boolean; set: (v: boolean) => void; n?: number }) {
  return <label className="flex items-center gap-1.5 text-xs font-normal text-muted"><input type="checkbox" className="accent-clay" checked={on} onChange={(e) => set(e.target.checked)} />Show inactive{on && n !== undefined ? ` (${n})` : ''}</label>;
}
const FIELD_TYPES: [string, string][] = [['text', 'Short text'], ['textarea', 'Long text'], ['number', 'Number'], ['select', 'Pick one'], ['multiselect', 'Pick many'], ['tags', 'List (type several)'], ['diagnoses', 'Diagnoses with severity'], ['date', 'Date']];

/** Owner's control panel. Everything here is data: no deploy needed to change it.
 *  The home is six groups; opening one shows its first topic, with the group's other topics as tabs. Prices is one screen. */
export function Settings() {
  const { cfg, me } = useOutletContext<any>();
  const owner = (me?.roles ?? []).includes('owner');
  const visible = (k: Tab) => (owner || groupOf(k)[0] !== OWNER_ONLY_GROUP) && (k !== 'testdata' || !!cfg?.testData);
  const [params, setParams] = useSearchParams();
  const asked = params.get('tab') ?? ''; const alias = ALIAS[asked];
  const tab = TABS.find((t) => t[0] === (alias?.[0] ?? asked) && visible(t[0]))?.[0] ?? null;
  // an old link to fees, medicines… opens Prices at that part
  useEffect(() => { if (alias && tab) setTimeout(() => document.getElementById(alias[1])?.scrollIntoView({ block: 'start' }), 80); }, [asked, !!tab]);
  // from the groups to a topic is a step of its own (Back returns to the groups); topic to topic replaces it
  const setTab = (k: Tab | null) => { setParams(k ? { tab: k } : {}, { replace: tab !== null && k !== null }); window.scrollTo({ top: 0 }); };
  const refresh = () => { qc.invalidateQueries({ queryKey: ['config'] }); qc.invalidateQueries({ queryKey: ['users'] }); qc.invalidateQueries({ queryKey: ['inactive'] }); };
  // the header's search box finds a group by its name, its topics or common words (GST, password, WhatsApp…)
  const [find] = usePageSearch('Search settings', !tab);
  if (!cfg) return <div className="card"><Skeleton rows={5} /></div>;

  if (!tab) {
    const q = find.trim().toLowerCase();
    const groups = GROUPS.map(([g, icon, about, words, tabs]) => ({ g, icon, about, tabs: tabs.filter(([k]) => visible(k)), words })).filter((x) => x.tabs.length && (!q || `${x.g} ${x.about} ${x.words} ${x.tabs.map((t) => `${t[1]} ${t[2]}`).join(' ')}`.toLowerCase().includes(q)));
    return (
      <div>
        <PageHeader title="Settings" subtitle="How the clinic runs. A change applies for everyone once saved." />
        {groups.length === 0 && <div className="card py-10 text-center text-muted">No setting matches “{find}”.</div>}
        {groups.length > 0 && <section className="settings-group card-flat max-w-[860px]" style={{ '--tone': 'var(--color-clay)' } as React.CSSProperties}>
          {groups.map(({ g, icon, about, tabs }, i) => (
            <button key={g} type="button" onClick={() => setTab(tabs[0][0])} className="settings-row" style={{ animationDelay: `${Math.min(i * 40, 240)}ms` }}>
              <span className="settings-row-icon"><Icon name={icon} className="h-[18px] w-[18px]" /></span>
              <span className="min-w-0 flex-1"><span className="block text-[14.5px] font-semibold text-ink">{g}</span><span className="block text-[12.5px] leading-snug text-muted">{about}</span>
                {tabs.length > 1 && <span className="mt-0.5 block text-[12px] text-muted">{tabs.map((t) => t[1]).join(' · ')}</span>}</span>
              <Icon name="chevR" className="settings-row-chev h-4 w-4 shrink-0 text-muted" />
            </button>))}
        </section>}
      </div>
    );
  }

  const cur = TABS.find((t) => t[0] === tab)!;
  const group = groupOf(tab);
  const neighbours = group[4].filter(([k]) => visible(k));
  return (
    <div>
      <PageHeader title={group[0]} subtitle={cur[2]} />
      {/* the other topics of the same group, as tabs; the top bar's Settings and Back lead to all six groups */}
      {neighbours.length > 1 && <Tabs value={tab} onChange={(k) => setTab(k)} options={neighbours.map(([k, label]) => ({ value: k, label }))} className="anim-fade-up mb-5" />}
      <div key={tab} id="settings-body" className={`settings-body anim-fade-up min-w-0 ${NARROW.has(tab) ? 'max-w-[860px]' : ''}`}>
        {tab === 'clinic' && <ClinicTab cfg={cfg} onSaved={refresh} />}
        {tab === 'day' && <DayTab cfg={cfg} onSaved={refresh} />}
        {tab === 'availability' && <AvailabilityTab cfg={cfg} onSaved={refresh} />}
        {tab === 'rooms' && <RoomsTab cfg={cfg} onSaved={refresh} />}
        {tab === 'people' && <PeopleTab cfg={cfg} onSaved={refresh} />}
        {tab === 'roles' && <RolesTab onSaved={refresh} />}
        {tab === 'prices' && <PricesTab cfg={cfg} onSaved={refresh} />}
        {tab === 'rules' && <><BookingRulesTab cfg={cfg} onSaved={refresh} /><CalendarLookCard cfg={cfg} onSaved={refresh} /></>}
        {tab === 'messages' && <MessagesTab cfg={cfg} onSaved={refresh} />}
        {tab === 'pad' && <PadTab onSaved={refresh} />}
        {tab === 'forms' && <FormsTab cfg={cfg} onSaved={refresh} />}
        {tab === 'templates' && <TemplatesTab cfg={cfg} />}
        {tab === 'photos' && <PhotoAreasTab cfg={cfg} onSaved={refresh} />}
        {tab === 'privacy' && owner && <PrivacyTab />}
        {tab === 'testdata' && owner && <TestDataCard />}
      </div>
    </div>
  );
}
/** Topics whose content is a short form or a short list: kept to a readable width instead of stretching across the screen. */
const NARROW = new Set<Tab>(['clinic', 'day', 'people', 'rooms', 'availability', 'rules', 'photos', 'testdata']);

/* ---------------- Prices: everything the clinic charges, on one screen ---------------- */
function PricesTab({ cfg, onSaved }: { cfg: any; onSaved: () => void }) {
  const parts: [string, string][] = [['price-fees', 'Consultation fees'], ['price-visits', 'Visit types'], ['price-procedures', 'Procedures and packages'], ['price-medicines', 'Medicines'], ['price-discount', 'Discount limit']];
  return (
    <div className="space-y-6">
      <nav className="flex flex-wrap gap-1.5" aria-label="On this screen">{parts.map(([id, l]) => <button key={id} type="button" className="toggle-opt" onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>{l}</button>)}</nav>
      <div id="price-fees" className="scroll-mt-20"><FeesTab cfg={cfg} onSaved={onSaved} /></div>
      <div id="price-visits" className="scroll-mt-20"><ServicesTab cfg={cfg} onSaved={onSaved} /></div>
      <div id="price-procedures" className="scroll-mt-20 space-y-4"><ProceduresTab cfg={cfg} onSaved={onSaved} /><PackagesCard cfg={cfg} onSaved={onSaved} /></div>
      <div id="price-medicines" className="scroll-mt-20"><MedicinesTab cfg={cfg} onSaved={onSaved} /></div>
      <div id="price-discount" className="scroll-mt-20 max-w-[860px]"><DiscountCap cfg={cfg} onSaved={onSaved} /></div>
    </div>
  );
}

/* ---------------- Clinic: what prints, how tokens count ---------------- */
function ClinicTab({ cfg, onSaved }: { cfg: any; onSaved: () => void }) {
  const s = cfg.tenant.settings ?? {};
  const [f, setF] = useState({ name: cfg.tenant.name, address: s.print?.address ?? '', phone: s.print?.phone ?? '', footer: s.print?.footer ?? '', upiId: s.upiId ?? '', gstin: s.gstin ?? '', opNumberScope: s.numbering?.opNumberScope ?? 'day+category' });
  const save = useMutation({ mutationFn: () => patch('/admin/clinic', { name: f.name, settings: { print: { address: f.address.trim(), phone: f.phone.trim(), footer: f.footer.trim() }, numbering: { opNumberScope: f.opNumberScope }, upiId: f.upiId.trim(), gstin: f.gstin.trim().toUpperCase() } }), onSuccess: () => { toast('Clinic saved'); onSaved(); }, onError: (e: any) => toast(errText(e), 'err') });
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="space-y-4">
      <div className="card space-y-3">
        <div className="card-title">Printed on every prescription</div>
        <div><label className="label">Clinic name</label><input className="input" value={f.name} onChange={set('name')} /></div>
        <div><label className="label">Address</label><input className="input" value={f.address} onChange={set('address')} /></div>
        <div className="grid grid-cols-2 gap-3"><div><label className="label">Phone</label><input className="input" value={f.phone} onChange={set('phone')} /></div><div><label className="label">Line at the bottom</label><input className="input" value={f.footer} onChange={set('footer')} placeholder="e.g. Get well soon" /></div></div>
        <div><label className="label">UPI ID for payments (e.g. clinic@okhdfc)</label><input className="input" value={f.upiId} onChange={set('upiId')} placeholder="clinic@okhdfc" /><div className="mt-1 text-xs text-muted">The pharmacy shows a QR code with the amount filled in.</div></div>
        <div><label className="label" htmlFor="cl-gstin">GSTIN (leave empty if not registered)</label><input id="cl-gstin" className={`input uppercase ${f.gstin.trim() && f.gstin.trim().length !== 15 ? '!border-rose' : ''}`} maxLength={15} value={f.gstin} onChange={set('gstin')} /><div className="mt-1 text-xs text-muted">With a GSTIN, receipts print as a Tax Invoice with CGST and SGST per rate. Without one, they print as a Bill of Supply with no tax lines.</div></div>
      </div>
      <div className="card space-y-3">
        <div className="card-title">Token numbers</div>
        <div className="flex flex-wrap gap-1">{[['day+category', 'One series per visit type (GEN-1, REN-1…)'], ['day', 'One series for the whole day (1, 2, 3…)']].map(([v, l]) => <button key={v} type="button" className={`toggle-opt ${f.opNumberScope === v ? 'on' : ''}`} onClick={() => setF({ ...f, opNumberScope: v })}>{l}</button>)}</div>
        <div className="text-xs text-muted">Numbers start again every morning.</div>
      </div>
      <div className="settings-save"><button className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate()}><Icon name="check" />Save</button></div>
    </div>
  );
}

/* ---------------- The day at the desk: arrival, screening, reports, the waiting-room screen ---------------- */
function DayTab({ cfg, onSaved }: { cfg: any; onSaved: () => void }) {
  const s = cfg.tenant.settings ?? {};
  const [f, setF] = useState({ screening: s.screening ?? 'off', freeDays: String(s.reports?.freeDays ?? 30) });
  const save = useMutation({ mutationFn: () => patch('/admin/clinic', { settings: { screening: f.screening, reports: { freeDays: Math.max(0, Math.min(365, Number(f.freeDays) || 0)) } } }), onSuccess: () => { toast('Saved'); onSaved(); }, onError: (e: any) => toast(errText(e), 'err') });
  return (
    <div className="space-y-4">
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
      <div className="card space-y-3">
        <div className="card-title">Waiting-room screen</div>
        <DisplayLinkCard />
      </div>
      <div className="settings-save"><button className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate()}><Icon name="check" />Save</button></div>
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
  const { me } = useOutletContext<any>(); const iAmOwner = (me?.roles ?? []).includes('owner');
  const users = useQuery({ queryKey: ['users'], queryFn: () => get('/users') });
  // only an owner hands out the owner role
  const roleList: { key: string; name: string }[] = (useRoles().data ?? []).map((r: any) => ({ key: r.key, name: r.name })); const ROLES: [string, string][] = roleList.filter((r) => iAmOwner || r.key !== 'owner').map((r) => [r.key, r.name]);
  const [showOff, setShowOff] = useState(false); const off = useInactive(showOff); const doctors = [...cfg.practitioners, ...(showOff ? off.data?.practitioners ?? [] : [])];
  const [pw, setPw] = useState<null | { cur: string; next: string; again: string }>(null);
  const changePw = useMutation({ mutationFn: () => patch('/me/password', { currentPassword: pw!.cur, newPassword: pw!.next }), onSuccess: () => { setPw(null); toast('Your password is changed'); }, onError: (e: any) => toast(say(e), 'err') });
  const roleName = (k: string) => roleList.find((r) => r.key === k)?.name ?? k;
  const [edit, setEdit] = useState<any>(null); const [doc, setDoc] = useState<any>(null);
  useAddFromNew((w) => { if (w === 'user') setEdit({ name: '', email: '', password: '', roles: ['receptionist'], practitionerId: null, active: true }); if (w === 'doctor') setDoc({ name: '', regNo: '', qualification: '', active: true }); });
  // a new person gets a password made by the app, shown once here; they pick their own at first sign-in
  const [shown, setShown] = useState<null | { name: string; email: string; password: string }>(null);
  const save = useMutation({ mutationFn: (u: any) => u.id ? patch(`/admin/users/${u.id}`, u) : post('/admin/users', u), onSuccess: (r: any) => { toast('Saved'); setEdit(null); onSaved(); if (r?.firstPassword) setShown({ name: r.name, email: r.email, password: r.firstPassword }); }, onError: (e: any) => toast(say(e), 'err') });
  const reset = useMutation({ mutationFn: (u: any) => post(`/admin/users/${u.id}/reset-password`), onSuccess: (r: any, u: any) => { setEdit(null); onSaved(); setShown({ name: u.name, email: u.email, password: r.firstPassword }); }, onError: (e: any) => toast(say(e), 'err') });
  const askReset = async (u: any) => { if (await ask({ title: `Reset ${u.name}'s password?`, body: 'Their current password stops working now. You will see a new one to give them; they pick their own when they next sign in.', confirmLabel: 'Reset password' })) reset.mutate(u); };
  const saveDoc = useMutation({ mutationFn: async ({ routine, ...p }: any) => { const row = p.id ? await patch(`/admin/practitioners/${p.id}`, p) : await post('/admin/practitioners', p); if (routine) await api('PUT', `/calendar/routine/${row.id}`, routine); return row; }, onSuccess: () => { toast('Saved'); setDoc(null); onSaved(); }, onError: (e: any) => toast(say(e), 'err') });
  // an admin cannot change an owner's sign-in or switch them off
  const lockedOwner = !!edit?.id && !iAmOwner && !!(users.data ?? []).find((u: any) => u.id === edit.id)?.roles?.includes('owner');
  const toggleRole = (r: string) => setEdit({ ...edit, roles: edit.roles.includes(r) ? edit.roles.filter((x: string) => x !== r) : [...edit.roles, r] });
  return (
    <div className="space-y-4">
      <div className="flex justify-end"><button className="btn btn-sm" onClick={() => setPw({ cur: '', next: '', again: '' })}><Icon name="lock" className="h-3.5 w-3.5" />Change my password</button></div>
      <Section title="Staff accounts">
        {(users.data ?? []).map((u: any) => (
          <div key={u.id} className={`row ${u.active ? '' : 'opacity-50'}`}>
            <div className="flex-1 min-w-0"><div className="text-sm font-medium">{u.name}</div><div className="text-xs text-muted">{u.email}{u.practitionerId ? ` · ${cfg.practitioners.find((p: any) => p.id === u.practitionerId)?.name ?? ''}` : ''}</div></div>
            <div className="flex gap-1 flex-wrap justify-end">{(u.roles ?? [u.role]).map((r: string) => <Chip key={r} tone={r === 'owner' ? 'clay' : ''}>{roleName(r)}</Chip>)}{u.active && u.mustChangePassword && <Chip>first password not changed yet</Chip>}{!u.active && <Chip tone="rose">inactive</Chip>}</div>
            <button aria-label="Edit" className="btn btn-ghost btn-icon" onClick={() => setEdit({ ...u, roles: u.roles ?? [u.role], password: '' })}><Icon name="edit" /></button>
          </div>
        ))}
      </Section>
      <Section title="Doctors" aside={<ShowInactive on={showOff} set={setShowOff} n={off.data?.practitioners?.length} />}>
        {doctors.map((p: any) => <div key={p.id} className={`row ${p.active === false ? 'opacity-50' : ''}`}><div className="flex-1"><div className="text-sm font-medium">{p.name}</div><div className="text-xs text-muted">{[p.qualification, p.regNo && `Reg. ${p.regNo}`].filter(Boolean).join(' · ')}</div></div>{p.active === false && <Chip tone="rose">inactive</Chip>}<Chip tone={p.routine ? 'sage' : 'amber'}>{routineSummary(p.routine)}</Chip><button aria-label="Edit" className="btn btn-ghost btn-icon" onClick={() => setDoc({ ...p, routine: p.routine ?? DEFAULT_ROUTINE })}><Icon name="edit" /></button></div>)}
        <div className="px-4 py-2 text-xs text-muted">A doctor who also signs in needs a staff account too: open it above and pick their name under "Signs prescriptions as".</div>
      </Section>
      {edit && (
        <Modal title={edit.id ? 'Edit staff member' : 'New staff member'} subtitle="Pick what they do. Someone can be Doctor and Owner at once." onClose={() => setEdit(null)} width="max-w-md">
          <div className="space-y-3">
            <div><label className="label">Name</label><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></div>
            {lockedOwner && <div className="rounded-xl bg-amber-soft px-3 py-2 text-sm text-[#6E4D10]">This person is an owner. Only an owner can change their email, password or whether they are active.</div>}
            <div><label className="label">Email (used to sign in)</label><input className="input" type="email" disabled={lockedOwner} value={edit.email} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></div>
            {!edit.id && <div className="text-xs text-muted">The app makes a first password and shows it once after you save. They pick their own when they first sign in.</div>}
            {edit.id && !lockedOwner && edit.id !== me?.userId && <div className="flex flex-wrap items-center gap-2"><span className="label !mb-0">Password</span><button type="button" className="btn btn-sm" disabled={reset.isPending} onClick={() => askReset(edit)}><Icon name="lock" className="h-3.5 w-3.5" />Reset password</button></div>}
            <div><label className="label">Roles</label><div className="flex flex-wrap gap-1">{ROLES.map(([r, l]) => <button key={r} className={`toggle-opt ${edit.roles.includes(r) ? 'on' : ''}`} onClick={() => toggleRole(r)}>{l}</button>)}</div></div>
            {(edit.roles.includes('doctor') || edit.roles.includes('owner')) && <div><label className="label">Signs prescriptions as</label><select className="input" value={edit.practitionerId ?? ''} onChange={(e) => setEdit({ ...edit, practitionerId: e.target.value || null })}><option value="">Not a consulting doctor</option>{cfg.practitioners.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>}
            {edit.id && !lockedOwner && <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-clay" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> Active (uncheck when staff leave)</label>}
            <div className="modal-foot"><button className="btn btn-ghost" onClick={() => setEdit(null)}>Cancel</button><button className="btn btn-primary" disabled={save.isPending || !edit.name || !edit.email || !edit.roles.length} onClick={() => save.mutate({ id: edit.id, name: edit.name, email: edit.email, roles: edit.roles, practitionerId: edit.practitionerId, active: edit.active })}>Save</button></div>
          </div>
        </Modal>
      )}
      {shown && (
        <Modal title={`${shown.name}'s first password`} subtitle="Shown only now. Give it to them in person or on WhatsApp." onClose={() => setShown(null)} width="max-w-sm">
          <div className="space-y-3">
            <div className="text-sm text-ink-2">Sign-in email: {shown.email}</div>
            <div className="flex items-center gap-2"><input className="input font-mono text-[17px] tracking-wider" readOnly value={shown.password} onFocus={(e) => e.target.select()} aria-label="First password" />
              <button type="button" className="btn btn-sm" onClick={async () => { try { await navigator.clipboard.writeText(shown.password); toast('Copied'); } catch { toast('Select the password and copy it', 'info'); } }}><Icon name="copy" className="h-3.5 w-3.5" />Copy</button></div>
            <div className="text-xs text-muted">When they sign in with it, the app asks them to pick their own password before anything else.</div>
            <div className="modal-foot"><button className="btn btn-primary" onClick={() => setShown(null)}>Done</button></div>
          </div>
        </Modal>
      )}
      {pw && (
        <Modal title="Change my password" subtitle="At least 8 characters. You stay signed in." onClose={() => setPw(null)} width="max-w-sm" submitOnEnter>
          <div className="space-y-3">
            <div><label className="label" htmlFor="pw-cur">Current password</label><input id="pw-cur" className="input" type="password" autoComplete="current-password" value={pw.cur} onChange={(e) => setPw({ ...pw, cur: e.target.value })} /></div>
            <div><label className="label" htmlFor="pw-new">New password</label><input id="pw-new" className="input" type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></div>
            <div><label className="label" htmlFor="pw-again">New password again</label><input id="pw-again" className="input" type="password" autoComplete="new-password" value={pw.again} onChange={(e) => setPw({ ...pw, again: e.target.value })} /></div>
            {pw.next && pw.next.length < 8 ? <div className="text-xs text-rose">At least 8 characters.</div> : pw.again && pw.again !== pw.next ? <div className="text-xs text-rose">The two new passwords are not the same.</div> : null}
            <div className="modal-foot"><button className="btn btn-ghost" onClick={() => setPw(null)}>Cancel</button><button className="btn btn-primary" disabled={changePw.isPending || !pw.cur || pw.next.length < 8 || pw.next !== pw.again} onClick={() => changePw.mutate()}>Change password</button></div>
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

/* ---------------- Vitals: which are taken at arrival and shown on the Rxpad, and the clinic's own ---------------- */
function VitalsSettings({ cfg, onSaved }: { cfg: any; onSaved: () => void }) {
  const s = cfg.tenant.settings ?? {};
  const [taken, setTaken] = useState<string[]>(s.vitals ?? DEFAULT_VITALS);
  const [own, setOwn] = useState<VitalField[]>(s.vitalFields ?? []);
  const all = vitalFields({ vitalFields: own });
  const dirty = JSON.stringify(taken) !== JSON.stringify(s.vitals ?? DEFAULT_VITALS) || JSON.stringify(own) !== JSON.stringify(s.vitalFields ?? []);
  const save = useMutation({ mutationFn: () => patch('/admin/clinic', { settings: { vitals: all.map((v) => v.key).filter((k) => taken.includes(k)), vitalFields: own.map(({ key, label, unit, type }) => ({ key, label, unit, type })) } }), onSuccess: () => { toast('Vitals saved'); onSaved(); }, onError: (e: any) => toast(errText(e), 'err') });
  const add = async () => {
    const r = await ask({ title: 'Add a vital', body: 'It is asked for at check-in and shown on the Rxpad, with past values. Write the unit after a comma: “Waist, cm”. Leave out the unit for a word or a reading like 2+.', confirmLabel: 'Add', field: { label: 'Name, unit', placeholder: 'e.g. Waist, cm', required: true, maxLength: 40 } });
    const v = r?.value?.trim(); if (!v) return;
    const [label, unit = ''] = v.split(',').map((x: string) => x.trim());
    const key = 'v_' + label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/(^_|_$)/g, '').slice(0, 24);
    if (!label || key === 'v_') return toast('Give the vital a name.', 'err');
    if (all.some((x) => x.key === key || x.label.toLowerCase() === label.toLowerCase())) return toast(`${label} is already in the list.`, 'err');
    setOwn([...own, { key, label: label.slice(0, 30), unit: unit.slice(0, 12), type: unit ? 'number' : 'text' }]); setTaken([...taken, key]);
  };
  return (
    <div className="card space-y-3">
      <div className="card-title">Vitals</div>
      <div className="flex flex-wrap gap-1.5">{all.map((v) => <span key={v.key} className="inline-flex items-center gap-1">
        <button type="button" aria-pressed={taken.includes(v.key)} className={`toggle-opt ${taken.includes(v.key) ? 'on' : ''}`} onClick={() => setTaken(taken.includes(v.key) ? taken.filter((x) => x !== v.key) : [...taken, v.key])}>{v.label}{v.unit ? ` (${v.unit})` : ''}</button>
        {v.custom && <button type="button" className="btn btn-ghost btn-icon !h-7 !w-7" aria-label={`Remove ${v.label}`} title="Remove this vital (values already taken stay on those visits)" onClick={() => { setOwn(own.filter((x) => x.key !== v.key)); setTaken(taken.filter((x) => x !== v.key)); }}><Icon name="x" className="h-3.5 w-3.5" /></button>}
      </span>)}
        <button type="button" className="toggle-opt border-dashed" onClick={add}><Icon name="plus" className="mr-1 inline h-3 w-3" />Add a vital</button></div>
      <div className="text-xs text-muted">The dark ones are asked for at check-in and shown on the Rxpad. Switch off what your clinic does not measure; add any other you take. {BUILTIN_VITALS.length} come with the app.</div>
      <div className="flex justify-end gap-2"><button type="button" className="btn btn-ghost" disabled={!dirty} onClick={() => { setTaken(s.vitals ?? DEFAULT_VITALS); setOwn(s.vitalFields ?? []); }}>Discard</button><button type="button" className="btn btn-primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}><Icon name="check" />Save vitals</button></div>
    </div>
  );
}

/* ---------------- Forms editor: sections → fields → options ---------------- */
function FormsTab({ cfg, onSaved }: { cfg: any; onSaved: () => void }) {
  const current = cfg.forms.find((f: any) => f.key === 'encounter');
  const [schema, setSchema] = useState<any>(() => JSON.parse(JSON.stringify(current?.schema ?? { sections: [] })));
  const [sel, setSel] = useState<{ s: number; f: number } | null>(null);
  const save = useMutation({ mutationFn: () => post('/admin/forms/encounter', schema), onSuccess: () => { toast('Form saved'); onSaved(); } , onError: (e: any) => toast('Check keys: lowercase letters, numbers, underscores', 'err') });
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/(^_|_$)/g, '');
  const upd = (fn: (d: any) => void) => { const d = JSON.parse(JSON.stringify(schema)); fn(d); setSchema(d); };
  const field = sel ? schema.sections[sel.s]?.fields[sel.f] : null;
  return (
    <div className="space-y-3">
      <VitalsSettings cfg={cfg} onSaved={onSaved} />
      <div className="text-sm text-muted">Past notes keep the form they were written on.</div>
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] gap-4">
        <div className="space-y-3">
          {schema.sections.map((s: any, si: number) => (
            <div key={si} className="card !p-3">
              <div className="flex items-center gap-2 mb-2"><input className="input !w-56 font-medium" value={s.title} onChange={(e) => upd((d) => { d.sections[si].title = e.target.value; })} /><span className="text-[11px] text-muted font-mono">{s.key}</span>
                <span className="ml-auto flex gap-1"><button aria-label="Move up" className="btn btn-ghost btn-icon" disabled={si === 0} onClick={() => upd((d) => { [d.sections[si - 1], d.sections[si]] = [d.sections[si], d.sections[si - 1]]; })}><Icon name="up" className="h-3.5 w-3.5" /></button><button aria-label="Remove" className="btn btn-ghost btn-icon" onClick={async () => { const r = await ask({ title: `Remove the section “${s.title}”?`, body: `${s.fields.length === 0 ? 'It has no fields.' : s.fields.length === 1 ? 'Its 1 field goes with it.' : `Its ${s.fields.length} fields go with it.`} Nothing changes for doctors until you press Save.`, confirmLabel: 'Remove section', tone: 'danger' }); if (r) { upd((d) => { d.sections.splice(si, 1); }); setSel(null); } }}><Icon name="x" className="h-3.5 w-3.5" /></button></span></div>
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
                <span className="flex gap-1"><button aria-label="Move earlier" className="btn btn-ghost btn-icon" disabled={sel!.f === 0} onClick={() => { upd((d) => { const a = d.sections[sel!.s].fields; [a[sel!.f - 1], a[sel!.f]] = [a[sel!.f], a[sel!.f - 1]]; }); setSel({ s: sel!.s, f: sel!.f - 1 }); }}><Icon name="chevL" className="h-3.5 w-3.5" /></button><button aria-label="Move later" className="btn btn-ghost btn-icon" disabled={sel!.f >= schema.sections[sel!.s].fields.length - 1} onClick={() => { upd((d) => { const a = d.sections[sel!.s].fields; [a[sel!.f + 1], a[sel!.f]] = [a[sel!.f], a[sel!.f + 1]]; }); setSel({ s: sel!.s, f: sel!.f + 1 }); }}><Icon name="chevR" className="h-3.5 w-3.5" /></button></span></div>
            </div>
          )}
        </div>
      </div>
      <div className="settings-save"><button className="btn btn-ghost" onClick={() => setSchema(JSON.parse(JSON.stringify(current.schema)))}>Discard changes</button><button className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate()}><Icon name="check" />Save form</button></div>
    </div>
  );
}

/* ---------------- Fees ---------------- */
function FeesTab({ cfg, onSaved }: { cfg: any; onSaved: () => void }) {
  const [edit, setEdit] = useState<any>(null);
  const [showOff, setShowOff] = useState(false); const off = useInactive(showOff); const rows = [...cfg.feeCategories, ...(showOff ? off.data?.feeCategories ?? [] : [])];
  // a new amount applies to every check-in from now, so it is asked first
  const confirmSave = async (c: any) => {
    const was = rows.find((x: any) => x.id === c.id);
    if (was && was.amountPaise !== c.amountPaise && !(await ask({ title: `Change ${c.name} from ${money(was.amountPaise)} to ${money(c.amountPaise)}?`, body: 'It applies to check-ins from now. Patients already checked in keep the fee they were charged.', confirmLabel: 'Change the fee' }))) return;
    save.mutate(c);
  };
  useAddFromNew((w) => { if (w === 'category') setEdit({ code: '', name: '', amount: '', priority: 0, affectsCapacity: true, active: true }); });
  const save = useMutation({ mutationFn: (c: any) => c.id ? patch(`/admin/fee-categories/${c.id}`, c) : post('/admin/fee-categories', c), onSuccess: () => { toast('Fee saved'); setEdit(null); onSaved(); }, onError: (e: any) => toast(errText(e), 'err') });
  return (
    <Section title="Consultation fees"aside={<ShowInactive on={showOff} set={setShowOff} n={off.data?.feeCategories?.length} />}>
      <table className="table"><thead><tr><th className="pl-4">Code</th><th>Name</th><th className="text-right">Fee</th><th>Rule</th><th>Queue</th><th /></tr></thead>
        <tbody>{rows.map((c: any) => <tr key={c.id} className={c.active === false ? 'opacity-50' : ''}><td className="pl-4 font-mono text-xs">{c.code}</td><td>{c.name}{c.active === false && <> <Chip tone="rose">inactive</Chip></>}</td><td className="text-right">{money(c.amountPaise)}</td><td className="text-xs text-muted">{c.eligibilityNote ?? (c.eligibility ? 'auto-suggested by rule' : 'manual')}</td><td>{c.priority > 0 && <Chip tone="amber">jumps queue</Chip>}</td><td className="text-right pr-3"><button aria-label="Edit" className="btn btn-ghost btn-icon" onClick={() => setEdit({ ...c, amount: c.amountPaise / 100 })}><Icon name="edit" /></button></td></tr>)}</tbody></table>
      {edit && (
        <Modal title={edit.id ? `Edit ${edit.code}` : 'New category'} onClose={() => setEdit(null)} width="max-w-md" submitOnEnter>
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-2"><div><label className="label">Code</label><input className="input uppercase" maxLength={8} value={edit.code} disabled={!!edit.id} onChange={(e) => setEdit({ ...edit, code: e.target.value.toUpperCase() })} /></div><div className="col-span-2"><label className="label">Name</label><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></div></div>
            <div className="grid grid-cols-2 gap-2"><div><label className="label">Fee (₹)</label><MoneyInput value={String(edit.amount ?? "")} onChange={(v) => setEdit({ ...edit, amount: v })} /></div><div><span className="label">Jumps the queue?</span><div className="flex gap-1" role="group" aria-label="Jumps the queue?">{([[false, 'No'], [true, 'Yes']] as const).map(([v, l]) => <button key={l} type="button" aria-pressed={(edit.priority > 0) === v} className={`toggle-opt ${(edit.priority > 0) === v ? 'on' : ''}`} onClick={() => setEdit({ ...edit, priority: v ? (edit.priority > 0 ? edit.priority : 10) : 0 })}>{l}</button>)}</div></div></div>
            <div><label className="label">Note for reception (when to use it)</label><input className="input" value={edit.eligibilityNote ?? ''} onChange={(e) => setEdit({ ...edit, eligibilityNote: e.target.value })} /></div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-clay" checked={edit.affectsCapacity} onChange={(e) => setEdit({ ...edit, affectsCapacity: e.target.checked })} /> Uses a booking slot</label>
            {edit.id && <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-clay" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> Active</label>}
            <div className="modal-foot"><button className="btn btn-ghost" onClick={() => setEdit(null)}>Cancel</button><button className="btn btn-primary" disabled={save.isPending || !edit.code || !edit.name} onClick={() => confirmSave({ id: edit.id, code: edit.code, name: edit.name, amountPaise: Math.round(Number(edit.amount || 0) * 100), priority: edit.priority, affectsCapacity: edit.affectsCapacity, eligibilityNote: edit.eligibilityNote || null, active: edit.active })}>Save</button></div>
          </div>
        </Modal>
      )}
    </Section>
  );
}

/* ---------------- Medicines ---------------- */
function MedicinesTab({ cfg, onSaved }: { cfg: any; onSaved: () => void }) {
  const [edit, setEdit] = useState<any>(null); const [q, setQ] = useState('');
  useAddFromNew((w) => { if (w === 'medicine') setEdit({ name: '', form: 'tab', scheduleClass: 'H', defaults: {}, packSize: 10, reorderLevel: 5 }); });
  const save = useMutation({ mutationFn: ({ mrp, id, ...m }: any) => { const b = { ...m, mrpPaise: mrp !== undefined ? toPaise(mrp || '0') : m.mrpPaise, gstBp: m.gstBp ?? 1200, hsn: m.hsn || null }; delete b.createdAt; delete b.tenantId; return id ? patch(`/admin/medicines/${id}`, b) : post('/admin/medicines', b); }, onSuccess: () => { toast('Medicine saved'); setEdit(null); onSaved(); }, onError: (e: any) => toast(say(e), 'err') });
  const del = useMutation({ mutationFn: (id: string) => api('DELETE', `/admin/medicines/${id}`), onSuccess: () => { toast('Removed', 'info'); setEdit(null); onSaved(); }, onError: () => toast('In use by a prescription; cannot delete', 'err') });
  const list = cfg.medicines.filter((m: any) => m.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <Section title={<>Medicines <span className="text-muted font-normal">· {cfg.medicines.length} · price (MRP) and GST</span></>} aside={<><input className="input !w-48 !py-1.5" placeholder="Filter" value={q} onChange={(e) => setQ(e.target.value)} /></>}>
      <table className="table"><thead><tr><th className="pl-4">Name</th><th>Form</th><th>Schedule</th><th>Price</th><th>Default</th><th /></tr></thead>
        <tbody>{list.map((m: any) => <tr key={m.id}><td className="pl-4 font-medium">{m.name}</td><td className="text-muted">{m.form}</td><td><Chip tone={m.scheduleClass === 'OTC' ? '' : 'amber'}>{m.scheduleClass ?? '—'}</Chip></td><td className={m.mrpPaise ? '' : 'text-rose text-xs'}>{m.mrpPaise ? `${money(m.mrpPaise)} · ${m.gstBp / 100}%` : 'not set'}</td><td className="text-xs text-muted">{[m.defaults?.dose, m.defaults?.frequency, m.defaults?.durationDays ? `${m.defaults.durationDays}d` : null].filter(Boolean).join(' · ')}</td><td className="text-right pr-3"><button aria-label="Edit" className="btn btn-ghost btn-icon" onClick={() => setEdit({ ...m, defaults: m.defaults ?? {} })}><Icon name="edit" /></button></td></tr>)}</tbody></table>
      {edit && (
        <Modal title={edit.id ? 'Edit medicine' : 'New medicine'} onClose={() => setEdit(null)} width="max-w-lg">
          <div className="space-y-3">
            <div><label className="label">Name (with strength)</label><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></div>
            <div className="grid grid-cols-2 gap-2">
              <div><label className="label">Form</label><div className="flex flex-wrap gap-1">{['tab', 'cap', 'cream', 'gel', 'lotion', 'syrup', 'inj', 'soap'].map((x) => <button key={x} className={`toggle-opt ${edit.form === x ? 'on' : ''}`} onClick={() => setEdit({ ...edit, form: x })}>{x}</button>)}</div></div>
              <div><label className="label">Schedule</label><div className="flex gap-1">{['OTC', 'H', 'H1', 'X'].map((x) => <button key={x} className={`toggle-opt ${edit.scheduleClass === x ? 'on' : ''}`} onClick={() => setEdit({ ...edit, scheduleClass: x })}>{x}</button>)}</div></div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div><label className="label">Generic name</label><input className="input" maxLength={120} placeholder="e.g. amoxicillin + clavulanate" value={edit.generic ?? ''} onChange={(e) => setEdit({ ...edit, generic: e.target.value })} /></div>
              <div><label className="label">Drug group (for allergies)</label><input className="input" maxLength={60} list="allergy-classes" placeholder="e.g. penicillin" value={edit.allergyClass ?? ''} onChange={(e) => setEdit({ ...edit, allergyClass: e.target.value })} />
                <datalist id="allergy-classes">{Object.keys(ALLERGY_CLASSES).map((c) => <option key={c} value={c} />)}</datalist></div>
            </div>
            <div className="-mt-1 text-xs text-muted">The prescription checks allergies, pregnancy, the same medicine twice and interactions against the name, the generic and the group.</div>
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
            <div className="modal-foot !justify-between">{edit.id ? <button className="btn btn-ghost text-rose" onClick={() => del.mutate(edit.id)}>Delete</button> : <span />}<div className="flex gap-2"><button className="btn btn-ghost" onClick={() => setEdit(null)}>Cancel</button><button className="btn btn-primary" disabled={!edit.name || !(Number(edit.packSize ?? 1) >= 1)} onClick={() => save.mutate({ id: edit.id, name: edit.name, form: edit.form, scheduleClass: edit.scheduleClass, generic: edit.generic?.trim() || null, allergyClass: edit.allergyClass?.trim().toLowerCase() || null, defaults: edit.defaults, mrp: edit.mrp, mrpPaise: edit.mrpPaise, gstBp: edit.gstBp, hsn: edit.hsn, leafletUrl: edit.leafletUrl?.trim() || null, packSize: Number(edit.packSize ?? 1), reorderLevel: Number(edit.reorderLevel ?? 0) })}>Save</button></div></div>
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
  useAddFromNew((w) => w === 'procedure' && setEdit({ name: '', typicalMinutes: 30, bufferMinutes: 0, typicalSittings: 1, price: '', requiresMainDoctor: false, requiresReview: false, requiredCapability: '', taxRateBp: 0, active: true }));
  const caps = [...new Set<string>(cfg.rooms.flatMap((r: any) => r.capabilities))];
  const save = useMutation({ mutationFn: (p: any) => p.id ? patch(`/admin/procedures/${p.id}`, p) : post('/admin/procedures', p), onSuccess: () => { toast('Procedure saved'); setEdit(null); onSaved(); }, onError: (e: any) => toast(say(e), 'err') });
  const [showOff, setShowOff] = useState(false); const off = useInactive(showOff); const rows = [...cfg.procedures, ...(showOff ? off.data?.procedures ?? [] : [])];
  return (
    <Section title="Procedures"aside={<ShowInactive on={showOff} set={setShowOff} n={off.data?.procedures?.length} />}>
      <table className="table"><thead><tr><th className="pl-4">Name</th><th>Typical</th><th>Sittings</th><th>Needs room with</th><th className="text-right">Price</th><th>GST</th><th>Rules</th><th /></tr></thead>
        <tbody>{rows.map((p: any) => <tr key={p.id} className={p.active === false ? 'opacity-50' : ''}><td className="pl-4 font-medium">{p.name}{p.active === false && <> <Chip tone="rose">inactive</Chip></>}</td><td className="text-muted">{p.typicalMinutes} min{p.bufferMinutes ? ` +${p.bufferMinutes}` : ''}</td><td>{p.typicalSittings}</td><td>{p.requiredCapability ? <Chip>{p.requiredCapability}</Chip> : <span className="text-muted text-xs">any</span>}</td><td className="text-right">{p.pricePaise != null ? money(p.pricePaise) : '—'}</td><td className="text-xs text-muted">{p.taxRateBp ? `${p.taxRateBp / 100}%` : 'exempt'}</td><td><div className="flex gap-1 flex-wrap">{p.requiresMainDoctor && <Chip tone="clay">doctor</Chip>}{p.requiresReview && <Chip tone="amber">review</Chip>}</div></td><td className="text-right pr-3"><button aria-label="Edit" className="btn btn-ghost btn-icon" onClick={() => setEdit({ ...p, price: p.pricePaise != null ? p.pricePaise / 100 : '', requiredCapability: p.requiredCapability ?? '' })}><Icon name="edit" /></button></td></tr>)}</tbody></table>
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
            <div><label className="label">Needs a room with</label><div className="flex flex-wrap gap-1"><button className={`toggle-opt ${!edit.requiredCapability ? 'on' : ''}`} onClick={() => setEdit({ ...edit, requiredCapability: '' })}>any room</button>{caps.map((c) => <button key={c} className={`toggle-opt ${edit.requiredCapability === c ? 'on' : ''}`} onClick={() => setEdit({ ...edit, requiredCapability: c })}>{c}</button>)}</div><div className="text-[11px] text-muted mt-1">These come from what the rooms have (Settings › Clinic › Rooms).</div></div>
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
  useAddFromNew((w) => { if (w === 'room') setEdit({ name: '', capabilities: ['procedure'], active: true, newCap: '' }); });
  const allCaps = [...new Set<string>([...cfg.rooms.flatMap((r: any) => r.capabilities), 'procedure', 'laser', 'cryo', 'minor_ot'])];
  const save = useMutation({ mutationFn: (r: any) => r.id ? patch(`/admin/rooms/${r.id}`, r) : post('/admin/rooms', r), onSuccess: () => { toast('Room saved'); setEdit(null); onSaved(); }, onError: (e: any) => toast(say(e), 'err') });
  const [showOff, setShowOff] = useState(false); const off = useInactive(showOff); const rows = [...cfg.rooms, ...(showOff ? off.data?.rooms ?? [] : [])];
  return (
    <Section title={<>Rooms <span className="text-muted font-normal">· {cfg.rooms.length}</span></>} aside={<ShowInactive on={showOff} set={setShowOff} n={off.data?.rooms?.length} />}>
      {rows.map((r: any) => <div key={r.id} className={`row ${r.active === false ? 'opacity-50' : ''}`}><div className="flex-1"><div className="text-sm font-medium">{r.name}{r.active === false && <> <Chip tone="rose">inactive</Chip></>}</div></div><div className="flex gap-1 flex-wrap">{r.capabilities.map((c: string) => <Chip key={c}>{c}</Chip>)}</div><button aria-label="Edit" className="btn btn-ghost btn-icon" onClick={() => setEdit({ ...r, newCap: '' })}><Icon name="edit" /></button></div>)}
      <div className="px-4 py-2 text-xs text-muted">Tick what each room has. A procedure is only booked into a room that has it.</div>
      {edit && (
        <Modal title={edit.id ? 'Edit room' : 'New room'} onClose={() => setEdit(null)} width="max-w-md" submitOnEnter>
          <div className="space-y-3">
            <div><label className="label">Name</label><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></div>
            <div><label className="label">What this room has</label><div className="flex flex-wrap gap-1">{allCaps.map((c) => <button key={c} className={`toggle-opt ${edit.capabilities.includes(c) ? 'on' : ''}`} onClick={() => setEdit({ ...edit, capabilities: edit.capabilities.includes(c) ? edit.capabilities.filter((x: string) => x !== c) : [...edit.capabilities, c] })}>{c}</button>)}</div>
              <div className="flex gap-2 mt-2"><input className="input" placeholder="something else, e.g. phototherapy" value={edit.newCap} onChange={(e) => setEdit({ ...edit, newCap: e.target.value.toLowerCase().replace(/[^a-z0-9_]+/g, '_') })} /><button className="btn btn-sm" disabled={!edit.newCap} onClick={() => setEdit({ ...edit, capabilities: [...edit.capabilities, edit.newCap], newCap: '' })}>Add</button></div></div>
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
  const load = useMutation({ mutationFn: () => post('/dev/reset-sample', { confirm: 'RESET' }), onSuccess: (r: any) => { setResult(r); qc.clear(); qc.invalidateQueries(); toast('Cleared and loaded fresh test data'); }, onError: (e: any) => toast(say(e), 'err') });
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
      <div className="text-sm text-ink-2">Clears everything this clinic has done and starts fresh with one week of realistic data including today: bookings, visits, pharmacy bills and counter sales, expenses, repeat visits, patient messages and two procedure courses with before/after photos. Staff, doctors, rooms, prices, forms and templates are kept. Use it on a test clinic, not one with real patients.</div>
      {result && <div className="rounded-2xl bg-sage-soft px-4 py-3 text-sm text-sage">Cleared and loaded {result.from} to {result.to}: {result.booked + result.confirmed} upcoming bookings ({result.confirmed} confirmed), {result.arrived} past visits, {result.no_show} no-shows, {result.cancelled} cancelled, {result.pharmacyBills + result.counterSales} pharmacy sales, {result.expenses} expenses, {result.series} repeat visits, {result.sittings} procedure sittings, {result.photos} photos.</div>}
      <button className="btn" disabled={load.isPending} onClick={run}>{load.isPending ? 'Working… (up to a minute)' : 'Clear everything and load test data'}</button>
    </div>
  );
}
