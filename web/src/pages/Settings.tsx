import { useEffect, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useNavigate, useOutletContext, useSearchParams } from 'react-router';
import { get, post, patch, qc, errText } from '../api';
import { can } from '../App';
import { Drawer, Chip, Tabs, Icon, PageHeader, Section, Skeleton, money, toast, NumInput, MoneyInput, ask } from '../ui';
import { RolesTab, DiscountCap } from './Roles';
import { vitalFields, DEFAULT_VITALS, BUILTIN_VITALS, type VitalField } from '../vitals';
import { PrivacyTab } from './Privacy';
import { TemplatesTab } from './SettingsTemplates';
import { PadTab } from './SettingsPad';
import { PackagesTab, CalendarLookCard } from '../packages';
import { AvailabilityTab, BookingRulesTab, MessagesTab, PhotoAreasTab } from './SettingsScheduling';
import { ConsultTypesTab } from '../consultTypes';
import { StaffTab } from '../staff';
import { PictureUpload } from '../pictureUpload';
import '../settings.css';

type Tab = 'clinic' | 'billing' | 'desk' | 'people' | 'roles' | 'types' | 'procedures' | 'rooms' | 'photos' | 'rules' | 'messages' | 'pad' | 'templates' | 'vitals' | 'labtests' | 'privacy' | 'testdata' | 'hours';
/** key, name, what it is for (one plain sentence), extra words the search finds it by */
type TabDef = [Tab, string, string, string];
/** The left menu: six groups, one screen per topic. */
const GROUPS: [string, TabDef[]][] = [
  ['Clinic', [
    ['clinic', 'Clinic profile', 'Printed at the top of every prescription and bill, and shown on the patient link.', 'name address phone footer language telugu hindi print'],
    ['billing', 'Billing & payments', 'Tax on bills, the payment QR at the counter, and what expenses are for.', 'gst gstin upi qr tax invoice bill of supply expense category'],
    ['desk', 'Front desk & queue', 'Token numbers, junior screening, free return with reports, missed visits, the waiting-room screen.', 'token number screening junior free reports no-show missed waiting room tv display'],
  ]],
  ['Team', [
    ['people', 'Staff & doctors', 'Everyone who works here: who signs in, who consults, and each doctor’s hours.', 'staff user password login account doctor registration hours routine availability'],
    ['roles', 'Roles & permissions', 'What reception, doctors, pharmacy and others can see and do, and the discount limit.', 'role permission access discount limit approval'],
  ]],
  ['Services', [
    ['types', 'Consultation types', 'What a patient comes in for: its fee, how it is booked, its colour on the calendar.', 'fee fees consultation visit type review renewal free price code token'],
    ['procedures', 'Procedures & packages', 'Procedures with their price, time and room, and the packages sold as a course.', 'procedure package laser peel price sessions gst'],
    ['rooms', 'Rooms', 'Procedure rooms and what each one has.', 'room laser equipment'],
    ['photos', 'Photo areas', 'Body areas for before and after photos.', 'photo picture area body'],
  ]],
  ['Appointments', [
    ['rules', 'Booking rules', 'How early to arrive, places per hour, and how the calendar looks.', 'booking arrive places hour calendar text size'],
    ['messages', 'Patient messages', 'Confirmations, reminders and other WhatsApp messages sent to patients.', 'whatsapp message reminder confirmation sms template'],
  ]],
  ['Clinical', [
    ['pad', 'Rx pad', 'What the doctor fills in, which parts are required, and what prints.', 'pad print rx prescription sections required'],
    ['templates', 'Templates', 'Ready sets of medicines, complaints, advice and tests, added in one tap.', 'template set medicines advice protocol'],
    ['vitals', 'Vitals', 'The vitals taken at check-in and shown on the pad.', 'vitals bp weight height pulse temperature'],
    ['labtests', 'Lab tests', 'The tests a doctor picks from on the pad.', 'lab test investigation cbc blood'],
  ]],
  ['Security', [
    ['privacy', 'Privacy & audit log', 'Work only from the clinic, idle sign-out, phone numbers and who changed what.', 'ip internet address lock audit log phone export privacy'],
    ['testdata', 'Test data', 'Wipe everything this clinic has done and load a week of sample data.', 'test data reset sample'],
  ]],
];
const HOURS: TabDef = ['hours', 'Doctors’ hours', 'When each doctor sits for OP. The calendar fills from this every week.', 'hours availability routine'];
const OWNER_ONLY = new Set<Tab>(['privacy', 'testdata']);
const TABS: TabDef[] = [...GROUPS.flatMap((g) => g[1]), HOURS];
/** Old links (?tab=fees, ?tab=day…) still land on the right screen. */
const ALIAS: Record<string, Tab> = { prices: 'types', fees: 'types', services: 'types', day: 'desk', forms: 'vitals', availability: 'people' };
/** The topic's name for the breadcrumb: Settings › Consultation types. */
export const settingsTopic = (k: string | null) => { const t = ALIAS[k ?? ''] ?? k; return TABS.find((x) => x[0] === t)?.[1] ?? null; };
const SAY: Record<string, string> = { NOT_A_TEST_CLINIC: 'This clinic has real patients, so test data is switched off.', DUPLICATE_NAME: 'The same name is in the list twice.' };
const say = (e: any) => SAY[e?.body?.code] ?? errText(e);
/** Switched-off doctors, fees, procedures and rooms, fetched only when "Show inactive" is ticked. */
function useInactive(on: boolean) { return useQuery({ queryKey: ['inactive'], queryFn: () => get('/admin/inactive'), enabled: on }); }
function ShowInactive({ on, set, n }: { on: boolean; set: (v: boolean) => void; n?: number }) {
  return <label className="flex items-center gap-1.5 text-xs font-normal text-muted"><input type="checkbox" className="accent-clay" checked={on} onChange={(e) => set(e.target.checked)} />Show inactive{on && n !== undefined ? ` (${n})` : ''}</label>;
}
const AddBtn = ({ label, onClick }: { label: string; onClick: () => void }) => <button type="button" className="btn btn-primary btn-sm" onClick={onClick}><Icon name="plus" className="h-3.5 w-3.5" />{label}</button>;

/** Owner's control panel. Everything here is data: no deploy needed to change it.
 *  A left menu of six groups lists every topic; one topic shows at a time. Medicines live in Inventory. */
export function Settings() {
  const { cfg, me, perms } = useOutletContext<any>();
  const nav = useNavigate();
  const owner = (me?.roles ?? []).includes('owner');
  // the desk (it books and moves appointments) may set the doctors' hours and nothing else; the rest needs the settings permission
  const admin = can(perms, 'config.write');
  const visible = (k: Tab) => (admin ? k !== 'hours' : k === 'hours') && (owner || !OWNER_ONLY.has(k)) && (k !== 'testdata' || !!cfg?.testData);
  const [params, setParams] = useSearchParams();
  const asked = params.get('tab') ?? '';
  useEffect(() => { if (asked === 'medicines') nav('/inventory?tab=stock', { replace: true }); }, [asked]);
  const want = (ALIAS[asked] === 'people' && !admin ? 'hours' : ALIAS[asked]) ?? asked;
  const tab: Tab = TABS.find((t) => t[0] === want && visible(t[0]))?.[0] ?? (admin ? 'clinic' : 'hours');
  // the address always names the topic, so the top bar reads Settings › Clinic profile
  useEffect(() => { if (cfg && asked !== tab && asked !== 'medicines') setParams({ tab }, { replace: true }); }, [asked, tab, !!cfg]);
  const setTab = (k: Tab) => { setParams({ tab: k }, { replace: true }); window.scrollTo({ top: 0 }); };
  const refresh = () => { ['config', 'users', 'inactive', 'sessions', 'calendar', 'frontdesk'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); }; // hours changed here show at check-in at once
  const [find, setFind] = useState('');
  if (!cfg) return <div className="card"><Skeleton rows={5} /></div>;
  const cur = TABS.find((t) => t[0] === tab)!;
  const q = find.trim().toLowerCase();
  const groups = GROUPS.map(([g, ts]) => [g, ts.filter((t) => visible(t[0]) && (!q || `${g} ${t[1]} ${t[2]} ${t[3]}`.toLowerCase().includes(q)))] as const).filter(([, ts]) => ts.length);
  const first = groups[0]?.[1][0];
  const menu = admin && (
    <nav aria-label="Settings" className="settings-nav">
      <label className="settings-find"><Icon name="search" className="h-4 w-4 shrink-0 text-muted" /><input type="search" aria-label="Search settings" placeholder="Search settings" value={find} onChange={(e) => setFind(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && first) { setTab(first[0]); setFind(''); } if (e.key === 'Escape') setFind(''); }} /></label>
      {groups.length === 0 && <div className="px-2.5 py-3 text-[13px] text-muted">No setting matches “{find}”.</div>}
      {groups.map(([g, ts]) => <div key={g}><div className="settings-nav-group">{g}</div>
        {ts.map(([k, label]) => <button key={k} type="button" aria-current={tab === k ? 'page' : undefined} className={`settings-nav-item ${tab === k ? 'on' : ''}`} onClick={() => { setTab(k); setFind(''); }}>{label}{k === 'labtests' && !cfg.tenant.settings?.labTests && <span className="settings-new">New</span>}</button>)}</div>)}
      <button type="button" className="settings-moved" onClick={() => nav('/inventory?tab=stock')}><Icon name="pill" className="h-4 w-4 shrink-0" /><span>Medicines are in <b>Inventory › Stock</b></span></button>
    </nav>
  );
  return (
    <div className={admin ? 'settings-shell' : ''}>
      {menu}
      <div className="min-w-0">
        {admin && <label className="settings-pick"><span className="sr-only">Settings topic</span><select className="input" value={tab} onChange={(e) => setTab(e.target.value as Tab)}>{GROUPS.map(([g, ts]) => <optgroup key={g} label={g}>{ts.filter((t) => visible(t[0])).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</optgroup>)}</select></label>}
        <PageHeader title={cur[1]} subtitle={cur[2]} />
        <div key={tab} id="settings-body" className={`settings-body anim-fade-up min-w-0 ${NARROW.has(tab) ? 'max-w-[860px]' : ''}`}>
          {tab === 'clinic' && <ClinicTab cfg={cfg} onSaved={refresh} />}
          {tab === 'billing' && <BillingTab cfg={cfg} onSaved={refresh} />}
          {tab === 'desk' && <DeskTab cfg={cfg} onSaved={refresh} />}
          {tab === 'people' && <StaffTab cfg={cfg} onSaved={refresh} />}
          {tab === 'hours' && <AvailabilityTab cfg={cfg} onSaved={refresh} />}
          {tab === 'roles' && <><RolesTab onSaved={refresh} /><DiscountCap cfg={cfg} onSaved={refresh} /></>}
          {tab === 'types' && <ConsultTypesTab cfg={cfg} onSaved={refresh} />}
          {tab === 'procedures' && <ProcPackages cfg={cfg} onSaved={refresh} />}
          {tab === 'rooms' && <RoomsTab cfg={cfg} onSaved={refresh} />}
          {tab === 'photos' && <PhotoAreasTab cfg={cfg} onSaved={refresh} />}
          {tab === 'rules' && <><BookingRulesTab cfg={cfg} onSaved={refresh} /><CalendarLookCard cfg={cfg} onSaved={refresh} /></>}
          {tab === 'messages' && <MessagesTab cfg={cfg} onSaved={refresh} />}
          {tab === 'pad' && <PadTab onSaved={refresh} />}
          {tab === 'templates' && <TemplatesTab cfg={cfg} />}
          {tab === 'vitals' && <VitalsSettings cfg={cfg} onSaved={refresh} />}
          {tab === 'labtests' && <NameListEditor title="Tests" noun="test" items={cfg.labTests ?? []} max={200} maxLen={60} placeholder="e.g. Serum IgE" sortable hint="The doctor picks these on the pad; one not in the list can still be typed. Removing a test here leaves past prescriptions as they are." onSave={(labTests) => patch('/admin/clinic', { settings: { labTests } })} onSaved={refresh} />}
          {tab === 'privacy' && owner && <PrivacyTab />}
          {tab === 'testdata' && owner && <TestDataCard />}
        </div>
      </div>
    </div>
  );
}
/** Topics whose content is a short form or a short list: kept to a readable width instead of stretching across the screen. */
const NARROW = new Set<Tab>(['clinic', 'billing', 'desk', 'rooms', 'hours', 'rules', 'photos', 'vitals', 'labtests', 'testdata']);

/** A short list of names the clinic keeps (lab tests, expense categories): add, remove, move, then Save. */
function NameListEditor({ title, noun, items, max, maxLen, placeholder, hint, sortable, onSave, onSaved }: { title: string; noun: string; items: string[]; max: number; maxLen: number; placeholder: string; hint: string; sortable?: boolean; onSave: (xs: string[]) => Promise<any>; onSaved: () => void }) {
  const [list, setList] = useState<string[]>(items);
  const [add, setAdd] = useState('');
  const clean = add.trim(); const dup = !!clean && list.some((a) => a.toLowerCase() === clean.toLowerCase());
  const dirty = JSON.stringify(list) !== JSON.stringify(items);
  const doAdd = () => { if (!clean || dup || list.length >= max) return; setList((l) => [...l, clean.slice(0, maxLen)]); setAdd(''); };
  const move = (i: number, d: number) => setList((l) => { const j = i + d; if (j < 0 || j >= l.length) return l; const n = [...l]; [n[i], n[j]] = [n[j], n[i]]; return n; });
  const m = useMutation({ mutationFn: () => onSave(list), onSuccess: () => { toast('Saved'); onSaved(); }, onError: (e) => toast(say(e), 'err') });
  return (
    <div className="space-y-4">
      <div className="text-sm text-muted">{hint}</div>
      <Section title={<>{title} <span className="font-normal text-muted">· {list.length}</span></>} aside={sortable && list.length > 1 ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => setList([...list].sort((a, b) => a.localeCompare(b)))}>Sort A–Z</button> : undefined}>
        <div className="flex items-center gap-2 border-b border-line/60 p-3">
          <input aria-label={`New ${noun}`} className={`input ${dup ? '!border-rose' : ''}`} maxLength={maxLen} placeholder={placeholder} value={add} onChange={(e) => setAdd(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && doAdd()} />
          <button type="button" className="btn" disabled={!clean || dup || list.length >= max} onClick={doAdd}><Icon name="plus" className="h-3.5 w-3.5" />Add</button>
        </div>
        {dup && <div className="px-4 pt-2 text-xs text-rose">“{clean}” is already in the list.</div>}
        {list.length === 0 ? <div className="p-4 text-sm text-muted">The list is empty. Add at least one.</div> : list.map((a, i) => (
          <div key={a} className="row">
            <span className="flex-1 text-sm">{a}</span>
            <button type="button" className="btn btn-ghost btn-icon" aria-label={`Move ${a} up`} disabled={i === 0} onClick={() => move(i, -1)}><Icon name="up" className="h-3.5 w-3.5" /></button>
            <button type="button" className="btn btn-ghost btn-icon" aria-label={`Move ${a} down`} disabled={i === list.length - 1} onClick={() => move(i, 1)}><Icon name="up" className="h-3.5 w-3.5 rotate-180" /></button>
            <button type="button" className="btn btn-ghost btn-icon" aria-label={`Remove ${a}`} onClick={() => setList((l) => l.filter((x) => x !== a))}><Icon name="x" className="h-3.5 w-3.5" /></button>
          </div>))}
      </Section>
      <div className="settings-save"><button type="button" className="btn btn-ghost" disabled={!dirty} onClick={() => setList(items)}>Discard</button><button type="button" className="btn btn-primary" disabled={!dirty || m.isPending || list.length === 0} onClick={() => m.mutate()}><Icon name="check" />Save</button></div>
    </div>
  );
}

/* ---------------- Clinic profile: what prints at the top, and the patients' language ---------------- */
function ClinicTab({ cfg, onSaved }: { cfg: any; onSaved: () => void }) {
  const s = cfg.tenant.settings ?? {};
  const init = { name: cfg.tenant.name, address: s.print?.address ?? '', phone: s.print?.phone ?? '', footer: s.print?.footer ?? '', language: s.messages?.language ?? 'en' };
  const [f, setF] = useState(init);
  const dirty = JSON.stringify(f) !== JSON.stringify(init);
  const save = useMutation({ mutationFn: () => patch('/admin/clinic', { name: f.name.trim(), settings: { print: { address: f.address.trim(), phone: f.phone.trim(), footer: f.footer.trim() }, messages: { language: f.language } } }), onSuccess: () => { toast('Clinic profile saved'); onSaved(); }, onError: (e: any) => toast(errText(e), 'err') });
  const set = (k: string) => (e: any) => setF((p) => ({ ...p, [k]: e.target.value }));
  return (
    <div className="space-y-4">
      <div className="card space-y-3">
        <div className="card-title">Name and contact</div>
        <PictureUpload url={s.print?.logoUrl} uploadTo="/admin/clinic/logo" label="Logo" empty="No logo" hint="Printed at the top of prescriptions and bills. PNG or JPG, square works best, under 1 MB." />
        <div><label className="label" htmlFor="cl-name">Clinic name</label><input id="cl-name" className={`input ${f.name.trim() ? '' : '!border-rose'}`} maxLength={100} value={f.name} onChange={set('name')} /></div>
        <div><label className="label" htmlFor="cl-addr">Address</label><input id="cl-addr" className="input" maxLength={200} value={f.address} onChange={set('address')} /></div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><div><label className="label" htmlFor="cl-phone">Phone</label><input id="cl-phone" className="input" inputMode="tel" maxLength={40} value={f.phone} onChange={set('phone')} /></div><div><label className="label" htmlFor="cl-foot">Line at the bottom of the prescription</label><input id="cl-foot" className="input" maxLength={120} value={f.footer} onChange={set('footer')} placeholder="e.g. Get well soon" /></div></div>
      </div>
      <div className="card space-y-3">
        <div className="card-title">Patients' language</div>
        <div className="flex gap-1" role="group" aria-label="Patients' language">{[['en', 'English'], ['te', 'Telugu'], ['hi', 'Hindi']].map(([k, l]) => <button key={k} type="button" aria-pressed={f.language === k} className={`toggle-opt ${f.language === k ? 'on' : ''}`} onClick={() => setF((p) => ({ ...p, language: k }))}>{l}</button>)}</div>
        <div className="text-xs text-muted">For patients with no language of their own: WhatsApp messages, the patient link and the waiting-room screen.</div>
      </div>
      <div className="settings-save"><button type="button" className="btn btn-ghost" disabled={!dirty} onClick={() => setF(init)}>Discard</button><button type="button" className="btn btn-primary" disabled={!dirty || save.isPending || !f.name.trim()} onClick={() => save.mutate()}><Icon name="check" />Save</button></div>
    </div>
  );
}

/* ---------------- Billing & payments: GST, the UPI QR, expense categories ---------------- */
function BillingTab({ cfg, onSaved }: { cfg: any; onSaved: () => void }) {
  const s = cfg.tenant.settings ?? {};
  const init = { upiId: s.upiId ?? '', gstin: s.gstin ?? '' };
  const [f, setF] = useState(init);
  const dirty = JSON.stringify(f) !== JSON.stringify(init);
  const upiBad = !!f.upiId.trim() && !/^[a-zA-Z0-9._-]{2,64}@[a-zA-Z0-9]{2,64}$/.test(f.upiId.trim());
  const gstBad = !!f.gstin.trim() && !/^[0-9A-Z]{15}$/.test(f.gstin.trim().toUpperCase());
  const save = useMutation({ mutationFn: () => patch('/admin/clinic', { settings: { upiId: f.upiId.trim(), gstin: f.gstin.trim().toUpperCase() } }), onSuccess: () => { toast('Billing saved'); onSaved(); }, onError: (e: any) => toast(errText(e), 'err') });
  return (
    <div className="space-y-4">
      <div className="card space-y-3">
        <div className="card-title">Tax and payments</div>
        <div><label className="label" htmlFor="cl-gstin">GSTIN (leave empty if not registered)</label><input id="cl-gstin" className={`input uppercase ${gstBad ? '!border-rose' : ''}`} maxLength={15} value={f.gstin} onChange={(e) => setF((p) => ({ ...p, gstin: e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, '') }))} /><div className={`mt-1 text-xs ${gstBad ? 'text-rose' : 'text-muted'}`}>{gstBad ? 'A GSTIN has 15 letters and numbers.' : 'With a GSTIN, receipts print as a Tax Invoice with CGST and SGST per rate. Without one, they print as a Bill of Supply with no tax lines.'}</div></div>
        <div><label className="label" htmlFor="cl-upi">UPI ID for payments</label><input id="cl-upi" className={`input ${upiBad ? '!border-rose' : ''}`} maxLength={130} value={f.upiId} onChange={(e) => setF((p) => ({ ...p, upiId: e.target.value.replace(/\s/g, '') }))} placeholder="clinic@okhdfc" /><div className={`mt-1 text-xs ${upiBad ? 'text-rose' : 'text-muted'}`}>{upiBad ? 'Write it as name@bank, e.g. clinic@okhdfc.' : 'The pharmacy shows a QR code with the amount filled in.'}</div></div>
        <div className="flex justify-end gap-2"><button type="button" className="btn btn-ghost" disabled={!dirty} onClick={() => setF(init)}>Discard</button><button type="button" className="btn btn-primary" disabled={!dirty || save.isPending || upiBad || gstBad} onClick={() => save.mutate()}><Icon name="check" />Save</button></div>
      </div>
      <div className="card-title !mt-6">Expense categories</div>
      <NameListEditor title="Categories" noun="category" items={cfg.expenseCategories ?? []} max={40} maxLen={40} placeholder="e.g. Laundry" hint="What an expense can be for, in Accounts. Expenses already entered keep their category." onSave={(expenseCategories) => patch('/admin/clinic', { settings: { expenseCategories } })} onSaved={() => { qc.invalidateQueries({ queryKey: ['expenses'] }); onSaved(); }} />
    </div>
  );
}

/* ---------------- Front desk & queue: token numbers, screening, reports, the waiting-room screen ---------------- */
function DeskTab({ cfg, onSaved }: { cfg: any; onSaved: () => void }) {
  const s = cfg.tenant.settings ?? {};
  const init = { opNumberScope: s.numbering?.opNumberScope ?? 'day+category', screening: s.screening ?? 'off', freeDays: String(s.reports?.freeDays ?? 30), noShowWarnAt: String(s.booking?.noShowWarnAt ?? 2) };
  const [f, setF] = useState(init);
  const dirty = JSON.stringify(f) !== JSON.stringify(init);
  const daysBad = f.freeDays === '' || !(Number(f.freeDays) >= 0 && Number(f.freeDays) <= 365);
  const warnBad = !(Number(f.noShowWarnAt) >= 1 && Number(f.noShowWarnAt) <= 20);
  const save = useMutation({ mutationFn: () => patch('/admin/clinic', { settings: { numbering: { opNumberScope: f.opNumberScope }, screening: f.screening, reports: { freeDays: Number(f.freeDays) }, booking: { noShowWarnAt: Number(f.noShowWarnAt) } } }), onSuccess: () => { toast('Saved'); onSaved(); }, onError: (e: any) => toast(errText(e), 'err') });
  return (
    <div className="space-y-4">
      <div className="card space-y-3">
        <div className="card-title">Token numbers</div>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Token numbers">{[['day+category', 'One series per consultation type (GEN-1, REN-1…)'], ['day', 'One series for the whole day (1, 2, 3…)']].map(([v, l]) => <button key={v} type="button" aria-pressed={f.opNumberScope === v} className={`toggle-opt ${f.opNumberScope === v ? 'on' : ''}`} onClick={() => setF((p) => ({ ...p, opNumberScope: v }))}>{l}</button>)}</div>
        <div className="text-xs text-muted">Numbers start again every morning.</div>
      </div>
      <div className="card space-y-3">
        <div className="card-title">Junior doctor screening</div>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Junior doctor screening">{([['off', 'Off'], ['first', 'When a junior is on'], ['required', 'Every patient']] as const).map(([v, l]) => <button key={v} type="button" aria-pressed={f.screening === v} className={`toggle-opt ${f.screening === v ? 'on' : ''}`} onClick={() => setF((p) => ({ ...p, screening: v }))}>{l}</button>)}</div>
        <div className="text-xs text-muted">{f.screening === 'off' ? 'Reception sends patients straight to the doctor. A junior doctor can still screen anyone waiting; the doctor does not wait for it.' : f.screening === 'first' ? 'The junior takes patients from the waiting list for screening. The doctor sees screened patients first and is never shown someone mid-screening.' : 'Reception cannot send a patient to the doctor until the junior has screened them.'}</div>
      </div>
      <div className="card space-y-3">
        <div className="card-title">Coming back with test reports</div>
        <div className="flex flex-wrap items-center gap-2 text-sm"><span>Free within</span><NumInput aria-label="Days" max={365} className={`input !w-24 ${daysBad ? '!border-rose' : ''}`} value={f.freeDays} onChange={(e: any) => setF((p) => ({ ...p, freeDays: e.target.value }))} /><span>days of the tests</span></div>
        <div className={`text-xs ${daysBad ? 'text-rose' : 'text-muted'}`}>{daysBad ? 'From 0 to 365 days.' : 'Within this time, coming back with reports has no fee, and the desk sees it pre-filled at check-in.'}</div>
      </div>
      <div className="card space-y-3">
        <div className="card-title">Patients who miss visits</div>
        <div className="flex flex-wrap items-center gap-2 text-sm"><span>Warn reception after</span><NumInput aria-label="No-shows before a warning" max={20} className={`input !w-20 ${warnBad ? '!border-rose' : ''}`} value={f.noShowWarnAt} onChange={(e: any) => setF((p) => ({ ...p, noShowWarnAt: e.target.value }))} /><span>missed visits</span></div>
        <div className={`text-xs ${warnBad ? 'text-rose' : 'text-muted'}`}>{warnBad ? 'From 1 to 20.' : 'Booking such a patient shows a warning with how many visits they missed.'}</div>
      </div>
      <div className="card space-y-3">
        <div className="card-title">Waiting-room screen</div>
        <DisplayLinkCard />
      </div>
      <div className="settings-save"><button type="button" className="btn btn-ghost" disabled={!dirty} onClick={() => setF(init)}>Discard</button><button type="button" className="btn btn-primary" disabled={!dirty || save.isPending || daysBad || warnBad} onClick={() => save.mutate()}><Icon name="check" />Save</button></div>
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
      <div className="card-title">Taken at check-in</div>
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

/* ---------------- Procedures ---------------- */
/** Procedures and packages: one procedure at its price, or a bundle of them at one price. Two tabs, each with its own New button. */
function ProcPackages({ cfg, onSaved }: { cfg: any; onSaved: () => void }) {
  const [params, setParams] = useSearchParams(); const view = params.get('view') === 'packages' ? 'packages' : 'procedures';
  const nPk = (cfg.tenant.settings?.packages ?? []).filter((k: any) => k.active !== false).length;
  return (
    <div className="space-y-4">
      <Tabs<'procedures' | 'packages'> value={view} onChange={(v) => setParams((p) => { const n = new URLSearchParams(p); if (v === 'packages') n.set('view', 'packages'); else n.delete('view'); return n; }, { replace: true })}
        options={[{ value: 'procedures', label: 'Procedures', count: cfg.procedures.length }, { value: 'packages', label: 'Packages', count: nPk }]} />
      {view === 'procedures' ? <ProceduresTab cfg={cfg} onSaved={onSaved} /> : <PackagesTab cfg={cfg} onSaved={onSaved} />}
    </div>
  );
}

function ProceduresTab({ cfg, onSaved }: { cfg: any; onSaved: () => void }) {
  const [edit, setEdit] = useState<any>(null);
  const add = () => setEdit({ name: '', typicalMinutes: 30, bufferMinutes: 0, typicalSittings: 1, price: '', requiresMainDoctor: false, requiresReview: false, requiredCapability: '', taxRateBp: 0, active: true });
  const caps = [...new Set<string>(cfg.rooms.flatMap((r: any) => r.capabilities))];
  const save = useMutation({ mutationFn: (p: any) => p.id ? patch(`/admin/procedures/${p.id}`, p) : post('/admin/procedures', p), onSuccess: () => { toast('Procedure saved'); setEdit(null); onSaved(); }, onError: (e: any) => toast(say(e), 'err') });
  const [showOff, setShowOff] = useState(false); const off = useInactive(showOff); const rows = [...cfg.procedures, ...(showOff ? off.data?.procedures ?? [] : [])];
  return (
    <Section title="Procedures" aside={<div className="flex items-center gap-3"><ShowInactive on={showOff} set={setShowOff} n={off.data?.procedures?.length} /><AddBtn label="Add procedure" onClick={add} /></div>}>
      <table className="table"><thead><tr><th className="pl-4">Name</th><th>Typical</th><th>Sessions</th><th>Needs room with</th><th className="text-right">Price</th><th>GST</th><th>Rules</th><th /></tr></thead>
        <tbody>{rows.map((p: any) => <tr key={p.id} className={p.active === false ? 'opacity-50' : ''}><td className="pl-4 font-medium">{p.name}{p.active === false && <> <Chip tone="rose">inactive</Chip></>}</td><td className="text-muted">{p.typicalMinutes} min{p.bufferMinutes ? ` +${p.bufferMinutes}` : ''}</td><td>{p.typicalSittings}</td><td>{p.requiredCapability ? <Chip>{p.requiredCapability}</Chip> : <span className="text-muted text-xs">Any</span>}</td><td className="text-right">{p.pricePaise != null ? money(p.pricePaise) : '—'}</td><td className="text-xs text-muted">{p.taxRateBp ? `${p.taxRateBp / 100}%` : 'exempt'}</td><td><div className="flex gap-1 flex-wrap">{p.requiresMainDoctor && <Chip tone="clay">doctor</Chip>}</div></td><td className="text-right pr-3"><button aria-label="Edit" className="btn btn-ghost btn-icon" onClick={() => setEdit({ ...p, price: p.pricePaise != null ? p.pricePaise / 100 : '', requiredCapability: p.requiredCapability ?? '' })}><Icon name="edit" /></button></td></tr>)}</tbody></table>
      {edit && (
        <Drawer title={edit.id ? 'Edit procedure' : 'New procedure'} onClose={() => setEdit(null)} width="max-w-lg">
          <div className="space-y-3">
            <div><label className="label">Name</label><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></div>
            <div className="grid grid-cols-4 gap-2">
              <div><label className="label">Minutes</label><NumInput max={600} className="input" value={edit.typicalMinutes} onChange={(e) => setEdit({ ...edit, typicalMinutes: Number(e.target.value) })} /></div>
              <div><label className="label">Buffer after</label><NumInput max={240} className="input" value={edit.bufferMinutes ?? 0} onChange={(e) => setEdit({ ...edit, bufferMinutes: Number(e.target.value) })} /></div>
              <div><label className="label">Sessions</label><NumInput max={50} className="input" value={edit.typicalSittings} onChange={(e) => setEdit({ ...edit, typicalSittings: Number(e.target.value) })} /></div>
              <div><label className="label">Price (₹)</label><MoneyInput value={String(edit.price ?? "")} onChange={(v) => setEdit({ ...edit, price: v })} /></div>
            </div>
            <div><label className="label">Needs a room with</label><div className="flex flex-wrap gap-1"><button className={`toggle-opt ${!edit.requiredCapability ? 'on' : ''}`} onClick={() => setEdit({ ...edit, requiredCapability: '' })}>Any room</button>{caps.map((c) => <button key={c} className={`toggle-opt ${edit.requiredCapability === c ? 'on' : ''}`} onClick={() => setEdit({ ...edit, requiredCapability: c })}>{c}</button>)}</div><div className="text-[11px] text-muted mt-1">These come from what the rooms have (Settings › Rooms).</div></div>
            <div><label className="label">GST</label><div className="flex gap-1">{[[0, 'Exempt (medical)'], [1800, '18% (cosmetic)']].map(([v, l]) => <button key={v} className={`toggle-opt ${edit.taxRateBp === v ? 'on' : ''}`} onClick={() => setEdit({ ...edit, taxRateBp: v })}>{l}</button>)}</div></div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-clay" checked={edit.requiresMainDoctor} onChange={(e) => setEdit({ ...edit, requiresMainDoctor: e.target.checked })} /> Needs a doctor present (blocks their OP time)</label>
            {edit.id && <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-clay" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> Active</label>}
            <div className="modal-foot"><button className="btn btn-ghost" onClick={() => setEdit(null)}>Cancel</button><button className="btn btn-primary" disabled={!edit.name} onClick={() => save.mutate({ id: edit.id, name: edit.name, typicalMinutes: edit.typicalMinutes, bufferMinutes: edit.bufferMinutes ?? 0, typicalSittings: edit.typicalSittings, pricePaise: edit.price === '' ? null : Math.round(Number(edit.price) * 100), taxRateBp: edit.taxRateBp, requiresMainDoctor: edit.requiresMainDoctor, requiresReview: edit.requiresReview, requiredCapability: edit.requiredCapability || null, active: edit.active })}>Save</button></div>
          </div>
        </Drawer>
      )}
    </Section>
  );
}

/* ---------------- Rooms ---------------- */
function RoomsTab({ cfg, onSaved }: { cfg: any; onSaved: () => void }) {
  const [edit, setEdit] = useState<any>(null);
  const add = () => setEdit({ name: '', capabilities: ['procedure'], active: true, newCap: '' });
  const allCaps = [...new Set<string>([...cfg.rooms.flatMap((r: any) => r.capabilities), 'procedure', 'laser', 'cryo', 'minor_ot'])];
  const save = useMutation({ mutationFn: (r: any) => r.id ? patch(`/admin/rooms/${r.id}`, r) : post('/admin/rooms', r), onSuccess: () => { toast('Room saved'); setEdit(null); onSaved(); }, onError: (e: any) => toast(say(e), 'err') });
  const [showOff, setShowOff] = useState(false); const off = useInactive(showOff); const rows = [...cfg.rooms, ...(showOff ? off.data?.rooms ?? [] : [])];
  return (
    <Section title={<>Rooms <span className="text-muted font-normal">· {cfg.rooms.length}</span></>} aside={<div className="flex items-center gap-3"><ShowInactive on={showOff} set={setShowOff} n={off.data?.rooms?.length} /><AddBtn label="Add room" onClick={add} /></div>}>
      {rows.map((r: any) => <div key={r.id} className={`row ${r.active === false ? 'opacity-50' : ''}`}><div className="flex-1"><div className="text-sm font-medium">{r.name}{r.active === false && <> <Chip tone="rose">inactive</Chip></>}</div></div><div className="flex gap-1 flex-wrap">{r.capabilities.map((c: string) => <Chip key={c}>{c}</Chip>)}</div><button aria-label="Edit" className="btn btn-ghost btn-icon" onClick={() => setEdit({ ...r, newCap: '' })}><Icon name="edit" /></button></div>)}
      <div className="px-4 py-2 text-xs text-muted">Tick what each room has. A procedure is only booked into a room that has it.</div>
      {edit && (
        <Drawer title={edit.id ? 'Edit room' : 'New room'} onClose={() => setEdit(null)} width="max-w-md" submitOnEnter>
          <div className="space-y-3">
            <div><label className="label">Name</label><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></div>
            <div><label className="label">What this room has</label><div className="flex flex-wrap gap-1">{allCaps.map((c) => <button key={c} className={`toggle-opt ${edit.capabilities.includes(c) ? 'on' : ''}`} onClick={() => setEdit({ ...edit, capabilities: edit.capabilities.includes(c) ? edit.capabilities.filter((x: string) => x !== c) : [...edit.capabilities, c] })}>{c}</button>)}</div>
              <div className="flex gap-2 mt-2"><input className="input" placeholder="something else, e.g. phototherapy" value={edit.newCap} onChange={(e) => setEdit({ ...edit, newCap: e.target.value.toLowerCase().replace(/[^a-z0-9_]+/g, '_') })} /><button className="btn btn-sm" disabled={!edit.newCap} onClick={() => setEdit({ ...edit, capabilities: [...edit.capabilities, edit.newCap], newCap: '' })}>Add</button></div></div>
            {edit.id && <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-clay" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> Active</label>}
            <div className="modal-foot"><button className="btn btn-ghost" onClick={() => setEdit(null)}>Cancel</button><button className="btn btn-primary" disabled={!edit.name} onClick={() => save.mutate({ id: edit.id, name: edit.name, capabilities: edit.capabilities, active: edit.active })}>Save</button></div>
          </div>
        </Drawer>
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
      {result && <div className="rounded-2xl bg-sage-soft px-4 py-3 text-sm text-sage">Cleared and loaded {result.from} to {result.to}: {result.booked + result.confirmed} upcoming bookings ({result.confirmed} confirmed), {result.arrived} past visits, {result.no_show} no-shows, {result.cancelled} cancelled, {result.pharmacyBills + result.counterSales} pharmacy sales, {result.expenses} expenses, {result.series} repeat visits, {result.sittings} procedure sessions, {result.photos} photos.</div>}
      <button className="btn" disabled={load.isPending} onClick={run}>{load.isPending ? 'Working… (up to a minute)' : 'Clear everything and load test data'}</button>
    </div>
  );
}
