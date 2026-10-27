import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { get, post, qc } from '../api';
import { Chip, Empty, Icon, Modal, PageHeader, Section, Skeleton, fmtDate, toast } from '../ui';

/** CUBOTT staff: every clinic on the platform, and onboarding of a new one in under a minute. */
export function Platform() {
  const list = useQuery({ queryKey: ['tenants'], queryFn: () => get('/platform/tenants') });
  const [onboard, setOnboard] = useState(false);
  const rows: any[] = list.data ?? [];
  return (
    <div>
      <PageHeader title="Clinics" subtitle={`${rows.length} clinic${rows.length === 1 ? '' : 's'} on the platform`}>
        <button className="btn btn-primary" onClick={() => setOnboard(true)}><Icon name="plus" />Onboard a clinic</button>
      </PageHeader>
      <Section>
        {list.isLoading ? <Skeleton rows={3} /> : rows.length === 0 ? <Empty icon="door" title="No clinics yet" /> : (
          <table className="table"><thead><tr><th className="pl-4">Clinic</th><th>Sign-in</th><th className="text-right">Users</th><th className="text-right">Patients</th><th className="text-right">Visits · 30d</th><th>Last activity</th><th>Since</th></tr></thead>
            <tbody>{rows.map((t) => <tr key={t.id}><td className="pl-4 font-medium">{t.name}</td><td><Chip>{t.slug}</Chip></td><td className="text-right">{t.users}</td><td className="text-right">{t.patients}</td><td className="text-right">{t.visits_30d}</td><td className="text-muted">{t.last_activity ? fmtDate(t.last_activity) : '—'}</td><td className="text-muted">{fmtDate(t.created_at)}</td></tr>)}</tbody></table>
        )}
      </Section>
      <div className="card mt-4 text-xs text-muted anim-fade-up" style={{ animationDelay: '80ms' }}>Each clinic is fully isolated: its own users, patients, forms, fees and rooms. Onboarding installs the dermatology pack (forms, medicines, procedures, fee categories, three rooms) which the owner then edits in their Settings.</div>
      {onboard && <OnboardModal onClose={() => { setOnboard(false); qc.invalidateQueries({ queryKey: ['tenants'] }); }} />}
    </div>
  );
}

function OnboardModal({ onClose }: { onClose: () => void }) {
  const [f, setF] = useState({ name: '', slug: '', address: '', phone: '', ownerName: '', ownerEmail: '', password: '', regNo: '', qualification: '', isDoctor: true });
  const [done, setDone] = useState<any>(null);
  const save = useMutation({ mutationFn: () => post('/platform/tenants', { name: f.name, slug: f.slug, address: f.address || undefined, phone: f.phone || undefined, owner: { name: f.ownerName, email: f.ownerEmail, password: f.password, regNo: f.regNo || undefined, qualification: f.qualification || undefined, isDoctor: f.isDoctor } }),
    onSuccess: (r) => { setDone(r); toast('Clinic created'); }, onError: (e: any) => toast(e?.body?.code === 'SLUG_TAKEN' ? 'That sign-in name is taken' : (e?.body?.code ?? 'Failed'), 'err') });
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  if (done) return (
    <Modal title="Clinic is live" onClose={onClose} width="max-w-md">
      <div className="space-y-3 text-sm">
        <div className="card !p-3"><div className="font-medium">{f.name}</div><div className="text-muted text-xs">sign-in name <b>{done.slug}</b></div></div>
        <p>The owner signs in with <b>{f.ownerEmail}</b> and the password you set. {f.isDoctor ? 'They are set up as owner and doctor.' : 'They are set up as owner (not a doctor).'} First things to do in their Settings: add staff, check fee amounts, add rooms and medicines.</p>
        <div className="modal-foot"><button className="btn btn-primary" onClick={onClose}>Done</button></div>
      </div>
    </Modal>
  );
  return (
    <Modal title="Onboard a clinic" subtitle="Creates the clinic, its owner account and the dermatology starter pack" onClose={onClose} width="max-w-lg">
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2"><label className="label">Clinic name</label><input autoFocus className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value, slug: f.slug || e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 30) })} /></div>
          <div><label className="label">Sign-in name</label><input className="input font-mono" value={f.slug} onChange={set('slug')} /></div>
          <div className="col-span-2"><label className="label">Address</label><input className="input" value={f.address} onChange={set('address')} /></div>
          <div><label className="label">Phone</label><input className="input" value={f.phone} onChange={set('phone')} /></div>
        </div>
        <div className="text-[11px] uppercase tracking-wider text-muted">Owner account</div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label">Name</label><input className="input" value={f.ownerName} onChange={set('ownerName')} /></div>
          <div><label className="label">Email</label><input className="input" type="email" value={f.ownerEmail} onChange={set('ownerEmail')} /></div>
          <div><label className="label">Temporary password</label><input className="input" value={f.password} onChange={set('password')} /></div>
          <label className="flex items-center gap-2 text-sm self-end pb-2"><input type="checkbox" className="accent-clay" checked={f.isDoctor} onChange={(e) => setF({ ...f, isDoctor: e.target.checked })} /> Owner is also a consulting doctor</label>
          {f.isDoctor && <><div><label className="label">Registration no.</label><input className="input" value={f.regNo} onChange={set('regNo')} /></div><div><label className="label">Qualification</label><input className="input" value={f.qualification} onChange={set('qualification')} /></div></>}
        </div>
        <div className="modal-foot"><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={save.isPending || !f.name || !f.slug || !f.ownerName || !f.ownerEmail || f.password.length < 6} onClick={() => save.mutate()}><Icon name="check" />Create clinic</button></div>
      </div>
    </Modal>
  );
}
