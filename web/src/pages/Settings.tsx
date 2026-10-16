import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useOutletContext } from 'react-router';
import { get, post, patch, api, qc } from '../api';
import { Chip, Icon, Modal, PageHeader, Section, Segmented, money, toast } from '../ui';

type Tab = 'clinic' | 'users' | 'fees' | 'medicines' | 'procedures';
const ROLES = ['owner', 'admin', 'doctor', 'assistant', 'receptionist', 'coordinator', 'pharmacist'];

/** Owner's control panel. Everything here is data: no deploy needed to change it. */
export function Settings() {
  const { cfg } = useOutletContext<any>();
  const [tab, setTab] = useState<Tab>('clinic');
  const refresh = () => { qc.invalidateQueries({ queryKey: ['config'] }); qc.invalidateQueries({ queryKey: ['users'] }); };
  return (
    <div>
      <PageHeader title="Settings" subtitle="Clinic profile, people, fees and catalogues. Changes apply immediately.">
        <Segmented value={tab} onChange={setTab} options={[{ value: 'clinic', label: 'Clinic' }, { value: 'users', label: 'Users' }, { value: 'fees', label: 'Fees' }, { value: 'medicines', label: 'Medicines' }, { value: 'procedures', label: 'Procedures' }]} />
      </PageHeader>
      {tab === 'clinic' && <ClinicTab cfg={cfg} onSaved={refresh} />}
      {tab === 'users' && <UsersTab cfg={cfg} onSaved={refresh} />}
      {tab === 'fees' && <FeesTab cfg={cfg} onSaved={refresh} />}
      {tab === 'medicines' && <MedicinesTab cfg={cfg} onSaved={refresh} />}
      {tab === 'procedures' && <ProceduresTab cfg={cfg} onSaved={refresh} />}
    </div>
  );
}

function ClinicTab({ cfg, onSaved }: { cfg: any; onSaved: () => void }) {
  const s = cfg.tenant.settings ?? {};
  const [f, setF] = useState({ name: cfg.tenant.name, address: s.print?.address ?? '', phone: s.print?.phone ?? '', footer: s.print?.footer ?? '', arriveEarlyMinutes: s.scheduling?.arriveEarlyMinutes ?? 35, defaultCapacity: s.scheduling?.defaultCapacity ?? 7, opNumberScope: s.numbering?.opNumberScope ?? 'day+category' });
  const save = useMutation({ mutationFn: () => patch('/admin/clinic', { name: f.name, settings: { print: { address: f.address, phone: f.phone, footer: f.footer }, scheduling: { arriveEarlyMinutes: Number(f.arriveEarlyMinutes), defaultCapacity: Number(f.defaultCapacity) }, numbering: { opNumberScope: f.opNumberScope } } }), onSuccess: () => { toast('Clinic saved'); onSaved(); } });
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="grid lg:grid-cols-2 gap-4">
      <div className="card anim-fade-up space-y-3">
        <div className="serif text-lg">Profile & prescription header</div>
        <div><label className="label">Clinic name</label><input className="input" value={f.name} onChange={set('name')} /></div>
        <div><label className="label">Address (printed on Rx)</label><input className="input" value={f.address} onChange={set('address')} /></div>
        <div className="grid grid-cols-2 gap-3"><div><label className="label">Phone</label><input className="input" value={f.phone} onChange={set('phone')} /></div><div><label className="label">Footer line</label><input className="input" value={f.footer} onChange={set('footer')} /></div></div>
      </div>
      <div className="card anim-fade-up space-y-3" style={{ animationDelay: '60ms' }}>
        <div className="serif text-lg">Booking & numbering</div>
        <div className="grid grid-cols-2 gap-3"><div><label className="label">Tell patients to arrive (minutes early)</label><input type="number" className="input" value={f.arriveEarlyMinutes} onChange={set('arriveEarlyMinutes')} /></div><div><label className="label">Default capacity per window</label><input type="number" className="input" value={f.defaultCapacity} onChange={set('defaultCapacity')} /></div></div>
        <div><label className="label">Daily OP number resets</label><div className="flex gap-1">{[['day+category', 'Per category (GEN-1, REN-1…)'], ['day', 'One sequence per day']].map(([v, l]) => <button key={v} className={`toggle-opt ${f.opNumberScope === v ? 'on' : ''}`} onClick={() => setF({ ...f, opNumberScope: v })}>{l}</button>)}</div></div>
        <div className="text-xs text-muted">Working days, holidays and WhatsApp settings arrive with the next release.</div>
      </div>
      <div className="lg:col-span-2 flex justify-end"><button className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate()}><Icon name="check" />Save clinic settings</button></div>
    </div>
  );
}

function UsersTab({ cfg, onSaved }: { cfg: any; onSaved: () => void }) {
  const users = useQuery({ queryKey: ['users'], queryFn: () => get('/users') });
  const [edit, setEdit] = useState<any>(null);
  const save = useMutation({ mutationFn: (u: any) => u.id ? patch(`/admin/users/${u.id}`, u) : post('/admin/users', u), onSuccess: () => { toast('User saved'); setEdit(null); onSaved(); }, onError: (e: any) => toast(e?.body?.code ?? 'Failed', 'err') });
  return (
    <Section title="Staff accounts" aside={<button className="btn btn-sm btn-primary" onClick={() => setEdit({ name: '', email: '', password: '', role: 'receptionist', practitionerId: null })}><Icon name="plus" className="h-3.5 w-3.5" />Add user</button>}>
      {(users.data ?? []).map((u: any) => (
        <div key={u.id} className={`row ${u.active ? '' : 'opacity-50'}`}>
          <div className="flex-1 min-w-0"><div className="text-sm font-medium">{u.name}</div><div className="text-xs text-muted">{u.email}</div></div>
          <Chip tone={u.role === 'owner' ? 'clay' : ''}>{u.role}</Chip>{!u.active && <Chip tone="rose">inactive</Chip>}
          <button className="btn btn-ghost btn-icon" onClick={() => setEdit({ ...u, password: '' })}><Icon name="edit" /></button>
        </div>
      ))}
      {edit && (
        <Modal title={edit.id ? 'Edit user' : 'New user'} onClose={() => setEdit(null)} width="max-w-md">
          <div className="space-y-3">
            <div><label className="label">Name</label><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></div>
            <div><label className="label">Email (used to sign in)</label><input className="input" type="email" value={edit.email} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></div>
            <div><label className="label">{edit.id ? 'New password (leave blank to keep)' : 'Password'}</label><input className="input" type="password" value={edit.password} onChange={(e) => setEdit({ ...edit, password: e.target.value })} /></div>
            <div><label className="label">Role</label><div className="flex flex-wrap gap-1">{ROLES.map((r) => <button key={r} className={`toggle-opt ${edit.role === r ? 'on' : ''}`} onClick={() => setEdit({ ...edit, role: r })}>{r}</button>)}</div></div>
            {['doctor', 'owner'].includes(edit.role) && <div><label className="label">Linked practitioner (for prescriptions)</label><select className="input" value={edit.practitionerId ?? ''} onChange={(e) => setEdit({ ...edit, practitionerId: e.target.value || null })}><option value="">None</option>{cfg.practitioners.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>}
            {edit.id && <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-clay" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> Active (uncheck when staff leave)</label>}
            <div className="flex justify-end gap-2 pt-2"><button className="btn btn-ghost" onClick={() => setEdit(null)}>Cancel</button><button className="btn btn-primary" disabled={!edit.name || !edit.email || (!edit.id && !edit.password)} onClick={() => save.mutate({ id: edit.id, name: edit.name, email: edit.email, role: edit.role, practitionerId: edit.practitionerId, active: edit.active, ...(edit.password ? { password: edit.password } : {}) })}>Save</button></div>
          </div>
        </Modal>
      )}
    </Section>
  );
}

function FeesTab({ cfg, onSaved }: { cfg: any; onSaved: () => void }) {
  const [edit, setEdit] = useState<any>(null);
  const save = useMutation({ mutationFn: (c: any) => c.id ? patch(`/admin/fee-categories/${c.id}`, c) : post('/admin/fee-categories', c), onSuccess: () => { toast('Fee saved'); setEdit(null); onSaved(); }, onError: (e: any) => toast(e?.body?.code ?? 'Failed', 'err') });
  return (
    <Section title="Visit categories & fees" aside={<button className="btn btn-sm btn-primary" onClick={() => setEdit({ code: '', name: '', amount: '', priority: 0, affectsCapacity: true, active: true })}><Icon name="plus" className="h-3.5 w-3.5" />Add category</button>}>
      <table className="table"><thead><tr><th className="pl-4">Code</th><th>Name</th><th className="text-right">Fee</th><th>Rule</th><th>Priority</th><th /></tr></thead>
        <tbody>{cfg.feeCategories.map((c: any) => <tr key={c.id}><td className="pl-4 font-mono text-xs">{c.code}</td><td>{c.name}</td><td className="text-right">{money(c.amountPaise)}</td><td className="text-xs text-muted">{c.eligibilityNote ?? (c.eligibility ? 'rule set' : 'manual')}</td><td>{c.priority > 0 && <Chip tone="amber">jumps queue</Chip>}</td><td className="text-right pr-3"><button className="btn btn-ghost btn-icon" onClick={() => setEdit({ ...c, amount: c.amountPaise / 100 })}><Icon name="edit" /></button></td></tr>)}</tbody></table>
      {edit && (
        <Modal title={edit.id ? `Edit ${edit.code}` : 'New category'} onClose={() => setEdit(null)} width="max-w-md">
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-2"><div><label className="label">Code</label><input className="input uppercase" maxLength={8} value={edit.code} disabled={!!edit.id} onChange={(e) => setEdit({ ...edit, code: e.target.value.toUpperCase() })} /></div><div className="col-span-2"><label className="label">Name</label><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></div></div>
            <div className="grid grid-cols-2 gap-2"><div><label className="label">Fee (₹)</label><input className="input" inputMode="numeric" value={edit.amount} onChange={(e) => setEdit({ ...edit, amount: e.target.value })} /></div><div><label className="label">Queue priority (0 = normal)</label><input type="number" className="input" value={edit.priority} onChange={(e) => setEdit({ ...edit, priority: Number(e.target.value) })} /></div></div>
            <div><label className="label">Rule note (shown to reception)</label><input className="input" value={edit.eligibilityNote ?? ''} onChange={(e) => setEdit({ ...edit, eligibilityNote: e.target.value })} /></div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-clay" checked={edit.affectsCapacity} onChange={(e) => setEdit({ ...edit, affectsCapacity: e.target.checked })} /> Counts against window capacity</label>
            {edit.id && <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-clay" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> Active</label>}
            <div className="flex justify-end gap-2 pt-2"><button className="btn btn-ghost" onClick={() => setEdit(null)}>Cancel</button><button className="btn btn-primary" disabled={!edit.code || !edit.name} onClick={() => save.mutate({ id: edit.id, code: edit.code, name: edit.name, amountPaise: Math.round(Number(edit.amount || 0) * 100), priority: edit.priority, affectsCapacity: edit.affectsCapacity, eligibilityNote: edit.eligibilityNote || null, active: edit.active })}>Save</button></div>
          </div>
        </Modal>
      )}
    </Section>
  );
}

function MedicinesTab({ cfg, onSaved }: { cfg: any; onSaved: () => void }) {
  const [edit, setEdit] = useState<any>(null); const [q, setQ] = useState('');
  const save = useMutation({ mutationFn: (m: any) => m.id ? patch(`/admin/medicines/${m.id}`, m) : post('/admin/medicines', m), onSuccess: () => { toast('Medicine saved'); setEdit(null); onSaved(); } });
  const del = useMutation({ mutationFn: (id: string) => api('DELETE', `/admin/medicines/${id}`), onSuccess: () => { toast('Removed', 'info'); setEdit(null); onSaved(); }, onError: () => toast('In use by a prescription; cannot delete', 'err') });
  const list = cfg.medicines.filter((m: any) => m.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <Section title={<>Medicine favourites <span className="text-muted font-normal">· {cfg.medicines.length}</span></>} aside={<><input className="input !w-48 !py-1.5" placeholder="Filter" value={q} onChange={(e) => setQ(e.target.value)} /><button className="btn btn-sm btn-primary" onClick={() => setEdit({ name: '', form: 'tab', scheduleClass: 'H', defaults: {} })}><Icon name="plus" className="h-3.5 w-3.5" />Add</button></>}>
      <table className="table"><thead><tr><th className="pl-4">Name</th><th>Form</th><th>Schedule</th><th>Default</th><th /></tr></thead>
        <tbody>{list.map((m: any) => <tr key={m.id}><td className="pl-4 font-medium">{m.name}</td><td className="text-muted">{m.form}</td><td><Chip tone={m.scheduleClass === 'OTC' ? '' : 'amber'}>{m.scheduleClass ?? '—'}</Chip></td><td className="text-xs text-muted">{[m.defaults?.dose, m.defaults?.frequency, m.defaults?.durationDays ? `${m.defaults.durationDays}d` : null].filter(Boolean).join(' · ')}</td><td className="text-right pr-3"><button className="btn btn-ghost btn-icon" onClick={() => setEdit({ ...m, defaults: m.defaults ?? {} })}><Icon name="edit" /></button></td></tr>)}</tbody></table>
      {edit && (
        <Modal title={edit.id ? 'Edit medicine' : 'New medicine'} onClose={() => setEdit(null)} width="max-w-lg">
          <div className="space-y-3">
            <div><label className="label">Name (with strength)</label><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></div>
            <div className="grid grid-cols-2 gap-2">
              <div><label className="label">Form</label><div className="flex flex-wrap gap-1">{['tab', 'cap', 'cream', 'gel', 'lotion', 'syrup', 'inj', 'soap'].map((x) => <button key={x} className={`toggle-opt ${edit.form === x ? 'on' : ''}`} onClick={() => setEdit({ ...edit, form: x })}>{x}</button>)}</div></div>
              <div><label className="label">Schedule</label><div className="flex gap-1">{['OTC', 'H', 'H1', 'X'].map((x) => <button key={x} className={`toggle-opt ${edit.scheduleClass === x ? 'on' : ''}`} onClick={() => setEdit({ ...edit, scheduleClass: x })}>{x}</button>)}</div></div>
            </div>
            <div className="text-[11px] uppercase tracking-wider text-muted">Defaults filled into the prescription</div>
            <div className="grid grid-cols-4 gap-2">
              <div><label className="label">Dose</label><input className="input" value={edit.defaults.dose ?? ''} onChange={(e) => setEdit({ ...edit, defaults: { ...edit.defaults, dose: e.target.value } })} /></div>
              <div><label className="label">Route</label><input className="input" value={edit.defaults.route ?? ''} onChange={(e) => setEdit({ ...edit, defaults: { ...edit.defaults, route: e.target.value } })} /></div>
              <div><label className="label">Frequency</label><input className="input" value={edit.defaults.frequency ?? ''} onChange={(e) => setEdit({ ...edit, defaults: { ...edit.defaults, frequency: e.target.value } })} /></div>
              <div><label className="label">Days</label><input type="number" className="input" value={edit.defaults.durationDays ?? ''} onChange={(e) => setEdit({ ...edit, defaults: { ...edit.defaults, durationDays: e.target.value ? Number(e.target.value) : undefined } })} /></div>
            </div>
            <div><label className="label">Instructions</label><input className="input" value={edit.defaults.instructions ?? ''} onChange={(e) => setEdit({ ...edit, defaults: { ...edit.defaults, instructions: e.target.value } })} /></div>
            <div className="flex justify-between gap-2 pt-2">{edit.id ? <button className="btn btn-ghost text-rose" onClick={() => del.mutate(edit.id)}>Delete</button> : <span />}<div className="flex gap-2"><button className="btn btn-ghost" onClick={() => setEdit(null)}>Cancel</button><button className="btn btn-primary" disabled={!edit.name} onClick={() => save.mutate({ id: edit.id, name: edit.name, form: edit.form, scheduleClass: edit.scheduleClass, defaults: edit.defaults })}>Save</button></div></div>
          </div>
        </Modal>
      )}
    </Section>
  );
}

function ProceduresTab({ cfg, onSaved }: { cfg: any; onSaved: () => void }) {
  const [edit, setEdit] = useState<any>(null);
  const save = useMutation({ mutationFn: (p: any) => p.id ? patch(`/admin/procedures/${p.id}`, p) : post('/admin/procedures', p), onSuccess: () => { toast('Procedure saved'); setEdit(null); onSaved(); } });
  return (
    <Section title="Procedure catalogue" aside={<button className="btn btn-sm btn-primary" onClick={() => setEdit({ name: '', typicalMinutes: 30, typicalSittings: 1, price: '', requiresMainDoctor: false, requiresReview: false, taxRateBp: 0, active: true })}><Icon name="plus" className="h-3.5 w-3.5" />Add procedure</button>}>
      <table className="table"><thead><tr><th className="pl-4">Name</th><th>Typical</th><th>Sittings</th><th className="text-right">Price</th><th>GST</th><th>Rules</th><th /></tr></thead>
        <tbody>{cfg.procedures.map((p: any) => <tr key={p.id}><td className="pl-4 font-medium">{p.name}</td><td className="text-muted">{p.typicalMinutes} min</td><td>{p.typicalSittings}</td><td className="text-right">{p.pricePaise != null ? money(p.pricePaise) : '—'}</td><td className="text-xs text-muted">{p.taxRateBp ? `${p.taxRateBp / 100}%` : 'exempt'}</td><td className="flex gap-1 flex-wrap">{p.requiresMainDoctor && <Chip tone="clay">main doctor</Chip>}{p.requiresReview && <Chip tone="amber">review</Chip>}</td><td className="text-right pr-3"><button className="btn btn-ghost btn-icon" onClick={() => setEdit({ ...p, price: p.pricePaise != null ? p.pricePaise / 100 : '' })}><Icon name="edit" /></button></td></tr>)}</tbody></table>
      {edit && (
        <Modal title={edit.id ? 'Edit procedure' : 'New procedure'} onClose={() => setEdit(null)} width="max-w-lg">
          <div className="space-y-3">
            <div><label className="label">Name</label><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></div>
            <div className="grid grid-cols-4 gap-2">
              <div><label className="label">Minutes</label><input type="number" className="input" value={edit.typicalMinutes} onChange={(e) => setEdit({ ...edit, typicalMinutes: Number(e.target.value) })} /></div>
              <div><label className="label">Sittings</label><input type="number" className="input" value={edit.typicalSittings} onChange={(e) => setEdit({ ...edit, typicalSittings: Number(e.target.value) })} /></div>
              <div><label className="label">Price (₹)</label><input className="input" inputMode="numeric" value={edit.price} onChange={(e) => setEdit({ ...edit, price: e.target.value })} /></div>
              <div><label className="label">GST %</label><div className="flex gap-1">{[0, 1800].map((x) => <button key={x} className={`toggle-opt ${edit.taxRateBp === x ? 'on' : ''}`} onClick={() => setEdit({ ...edit, taxRateBp: x })}>{x / 100}</button>)}</div></div>
            </div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-clay" checked={edit.requiresMainDoctor} onChange={(e) => setEdit({ ...edit, requiresMainDoctor: e.target.checked })} /> Needs the main doctor</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-clay" checked={edit.requiresReview} onChange={(e) => setEdit({ ...edit, requiresReview: e.target.checked })} /> Doctor reviews the plan before the patient is confirmed</label>
            {edit.id && <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-clay" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> Active</label>}
            <div className="flex justify-end gap-2 pt-2"><button className="btn btn-ghost" onClick={() => setEdit(null)}>Cancel</button><button className="btn btn-primary" disabled={!edit.name} onClick={() => save.mutate({ id: edit.id, name: edit.name, typicalMinutes: edit.typicalMinutes, typicalSittings: edit.typicalSittings, pricePaise: edit.price === '' ? null : Math.round(Number(edit.price) * 100), taxRateBp: edit.taxRateBp, requiresMainDoctor: edit.requiresMainDoctor, requiresReview: edit.requiresReview, active: edit.active })}>Save</button></div>
          </div>
        </Modal>
      )}
    </Section>
  );
}
