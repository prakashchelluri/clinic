import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useOutletContext } from 'react-router';
import { get, post, patch, api, errText, qc } from './api';
import { Drawer, Chip, Empty, Icon, Modal, Skeleton, Tabs, toast, ask } from './ui';
import { RoutineEditor, DEFAULT_ROUTINE, routineSummary } from './routine';
import { ChangeMyDay } from './dayChange';
import { useRoles } from './pages/Roles';
import { PictureUpload } from './pictureUpload';

/** Staff & doctors: one person, one record. A person may sign in (a staff account with roles), consult patients (a doctor:
 *  name on the prescription, registration, weekly hours), or both. Underneath these are still a user and a practitioner, linked. */
const SAY: Record<string, string> = {
  OWNER_ONLY_GRANT: 'Only an owner can make someone an owner, or take the owner role away.',
  OWNER_ONLY_EDIT: "Only an owner can change an owner's email, password or whether they are active.",
  LAST_OWNER: 'The clinic needs at least one active owner. Make someone else an owner first.',
  CANNOT_DEACTIVATE_SELF: 'You cannot switch off your own account.',
};
const say = (e: any) => SAY[e?.body?.code] ?? errText(e);
type Show = 'all' | 'doctors' | 'inactive';
type T = 'profile' | 'hours' | 'signin';

export function StaffTab({ cfg, onSaved }: { cfg: any; onSaved: () => void }) {
  const { me } = useOutletContext<any>(); const iAmOwner = (me?.roles ?? []).includes('owner');
  const users = useQuery({ queryKey: ['users'], queryFn: () => get('/users') });
  const off = useQuery({ queryKey: ['inactive'], queryFn: () => get('/admin/inactive') });
  const roleList: { key: string; name: string }[] = (useRoles().data ?? []).map((r: any) => ({ key: r.key, name: r.name }));
  const roleName = (k: string) => roleList.find((r) => r.key === k)?.name ?? k;
  const [show, setShow] = useState<Show>('all');
  const [edit, setEdit] = useState<any>(null);
  const [shown, setShown] = useState<null | { name: string; email: string; password: string }>(null);
  const pracs: any[] = [...cfg.practitioners, ...(off.data?.practitioners ?? [])];
  const us: any[] = users.data ?? [];
  // one row per person: every account, then each doctor nobody signs in as
  const people = [...us.map((u) => ({ user: u, prac: pracs.find((p) => p.id === u.practitionerId) ?? null })),
    ...pracs.filter((p) => !us.some((u) => u.practitionerId === p.id)).map((p) => ({ user: null, prac: p }))]
    .map((x) => ({ ...x, name: x.user?.name ?? x.prac.name, active: x.user ? x.user.active : x.prac.active !== false }))
    .sort((a, b) => Number(!!b.prac) - Number(!!a.prac) || a.name.localeCompare(b.name));
  const rows = people.filter((x) => show === 'inactive' ? !x.active : x.active && (show === 'all' || !!x.prac));
  const count = (s: Show) => people.filter((x) => s === 'inactive' ? !x.active : x.active && (s === 'all' || !!x.prac)).length;
  const open = (x: any) => setEdit({ userId: x.user?.id ?? null, pracId: x.prac?.id ?? null, name: x.name, email: x.user?.email ?? '', roles: x.user?.roles ?? [],
    consults: !!x.prac, wasConsulting: !!x.prac, regNo: x.prac?.regNo ?? '', qualification: x.prac?.qualification ?? '',
    routine: x.prac?.routine ?? DEFAULT_ROUTINE, routineAt: JSON.stringify(x.prac?.routine ?? null), signIn: !!x.user, active: x.active, owner: !!x.user?.roles?.includes('owner') });
  const add = () => setEdit({ userId: null, pracId: null, name: '', email: '', roles: ['receptionist'], consults: false, wasConsulting: false, regNo: '', qualification: '', routine: DEFAULT_ROUTINE, routineAt: 'new', signIn: true, active: true, owner: false });
  const refresh = () => { ['users', 'inactive', 'config', 'calendar', 'frontdesk', 'roles'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); onSaved(); };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Show">{([['all', 'Everyone'], ['doctors', 'Doctors'], ['inactive', 'Inactive']] as const).map(([k, l]) => <button key={k} type="button" aria-pressed={show === k} className={`toggle-opt ${show === k ? 'on' : ''}`} onClick={() => setShow(k)}>{l} · {count(k)}</button>)}</div>
        <button type="button" className="btn btn-primary ml-auto" onClick={add}><Icon name="plus" />Add person</button>
      </div>
      <div className="card !p-0 overflow-x-auto">
        {users.isLoading ? <div className="p-4"><Skeleton rows={5} /></div> : rows.length === 0 ? <Empty icon="users" title={show === 'inactive' ? 'Nobody is inactive' : 'Nobody here yet'} /> : (
          <table className="table min-w-[720px]">
            <thead><tr><th className="pl-4">Name</th><th>Roles</th><th>Consults</th><th>Sign-in</th></tr></thead>
            <tbody>{rows.map((x) => (
              <tr key={x.user?.id ?? x.prac.id} className={`cursor-pointer hover:bg-surface-2 ${x.active ? '' : 'opacity-60'}`} onClick={() => open(x)}>
                <td className="pl-4"><button type="button" className="text-left" onClick={(e) => { e.stopPropagation(); open(x); }}><b className="block font-medium">{x.name}</b>{x.prac && <span className="text-xs text-muted">{[x.prac.qualification, x.prac.regNo && `Reg. ${x.prac.regNo}`].filter(Boolean).join(' · ') || 'Doctor'}</span>}</button></td>
                <td><div className="flex flex-wrap gap-1">{(x.user?.roles ?? []).map((r: string) => <Chip key={r} tone={r === 'owner' ? 'clay' : ''}>{roleName(r)}</Chip>)}{!x.user && <span className="text-xs text-muted">—</span>}</div></td>
                <td className="text-ink-2">{x.prac && x.prac.active !== false ? routineSummary(x.prac.routine) : <span className="text-muted">—</span>}</td>
                <td>{!x.user ? <span className="text-xs text-muted">Does not sign in</span> : x.user.active && x.user.mustChangePassword ? <Chip tone="amber">First password not changed</Chip> : <span className="text-xs text-muted">{x.user.email}</span>}</td>
              </tr>))}</tbody>
          </table>)}
      </div>
      {edit && <PersonDrawer value={edit} cfg={cfg} me={me} iAmOwner={iAmOwner} roleList={roleList} onClose={() => setEdit(null)} onDone={(pw) => { setEdit(null); refresh(); if (pw) setShown(pw); }} onShown={setShown} />}
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
    </div>
  );
}

function PersonDrawer({ value, cfg, me, iAmOwner, roleList, onClose, onDone, onShown }: { value: any; cfg: any; me: any; iAmOwner: boolean; roleList: { key: string; name: string }[]; onClose: () => void; onDone: (pw?: { name: string; email: string; password: string }) => void; onShown: (pw: { name: string; email: string; password: string }) => void }) {
  const [f, setF] = useState<any>(value);
  const [tab, setTab] = useState<T>('profile');
  const [dayFor, setDayFor] = useState(false);
  const set = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }));
  const lockedOwner = !!f.userId && f.owner && !iAmOwner; // an admin cannot change an owner's sign-in or switch them off
  const isMe = f.userId && f.userId === me?.userId;
  const roles = roleList.filter((r) => iAmOwner || r.key !== 'owner');
  const toggleRole = (r: string) => set('roles', f.roles.includes(r) ? f.roles.filter((x: string) => x !== r) : [...f.roles, r]);
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim());
  const problem = !f.name.trim() ? 'Give the name.' : !f.consults && !f.signIn ? 'Tick Consults patients, or let them sign in.' : f.signIn && !emailOk ? 'Give a sign-in email (Sign-in tab).' : f.signIn && !f.roles.length && !f.consults ? 'Pick at least one role.' : '';
  const save = useMutation({
    mutationFn: async (active: boolean) => {
      let pracId = f.pracId;
      if (f.consults) {
        const p = { name: f.name.trim(), regNo: f.regNo.trim() || null, qualification: f.qualification.trim() || null, active };
        const row = pracId ? await patch(`/admin/practitioners/${pracId}`, p) : await post('/admin/practitioners', p); pracId = row.id;
        if (f.routineAt === 'new' || JSON.stringify(f.routine) !== f.routineAt) await api('PUT', `/calendar/routine/${pracId}`, f.routine);
      } else if (pracId && f.wasConsulting) { await patch(`/admin/practitioners/${pracId}`, { active: false }); pracId = null; }
      if (!f.signIn) return null;
      // a person who consults and signs in prescribes as themselves: give them the doctor role if they hold no doctor-like one
      const rs = f.consults && !f.roles.some((r: string) => r === 'doctor' || r === 'owner') ? [...f.roles, 'doctor'] : f.roles;
      const u = { name: f.name.trim(), roles: rs, practitionerId: f.consults ? pracId : null, ...(lockedOwner ? {} : { email: f.email.trim(), ...(isMe ? {} : { active }) }) };
      return f.userId ? patch(`/admin/users/${f.userId}`, u) : post('/admin/users', u);
    },
    onSuccess: (r: any, active: boolean) => { toast(!f.userId && !f.pracId ? 'Added' : active !== value.active ? (active ? 'Active again' : 'Marked inactive') : 'Saved'); onDone(r?.firstPassword ? { name: r.name, email: r.email, password: r.firstPassword } : undefined); },
    onError: (e: any) => toast(say(e), 'err'),
  });
  const reset = useMutation({ mutationFn: () => post(`/admin/users/${f.userId}/reset-password`), onSuccess: (r: any) => onShown({ name: f.name, email: f.email, password: r.firstPassword }), onError: (e: any) => toast(say(e), 'err') });
  const askReset = async () => { if (await ask({ title: `Reset ${f.name}'s password?`, body: 'Their current password stops working now. You will see a new one to give them; they pick their own when they next sign in.', confirmLabel: 'Reset password' })) reset.mutate(); };
  const askInactive = async () => { if (!value.active || await ask({ title: `Mark ${f.name} inactive?`, body: f.consults ? 'They stop signing in and leave the calendar. Past visits and prescriptions keep their name.' : 'They can no longer sign in. Everything they did stays on record.', confirmLabel: 'Mark inactive' })) save.mutate(!value.active); };
  const tabs: { value: T; label: string }[] = [{ value: 'profile', label: 'Profile' }, ...(f.consults ? [{ value: 'hours' as T, label: 'Consulting hours' }] : []), { value: 'signin', label: 'Sign-in' }];
  return (
    <Drawer title={f.userId || f.pracId ? value.name : 'New person'} subtitle={f.userId || f.pracId ? [f.consults ? 'Consults patients' : null, f.signIn ? f.email : 'Does not sign in'].filter(Boolean).join(' · ') : 'Someone who works here'} onClose={onClose} width="max-w-xl">
      <div className="space-y-4">
        <Tabs<T> value={tab} onChange={setTab} options={tabs} />
        {tab === 'profile' && <div className="space-y-3">
          <div><label className="label" htmlFor="ps-name">Name{f.consults ? ' (as printed on the prescription)' : ''}</label><input id="ps-name" autoFocus={!f.userId && !f.pracId} className="input" maxLength={100} value={f.name} onChange={(e) => set('name', e.target.value)} /></div>
          {f.signIn && <div><span className="label">Roles</span><div className="flex flex-wrap gap-1">{roles.map((r) => <button key={r.key} type="button" aria-pressed={f.roles.includes(r.key)} disabled={lockedOwner && r.key === 'owner'} className={`toggle-opt ${f.roles.includes(r.key) ? 'on' : ''}`} onClick={() => toggleRole(r.key)}>{r.name}</button>)}</div><div className="mt-1 text-xs text-muted">Someone can hold several, e.g. Doctor and Owner. What each role can do is under Roles & permissions.</div></div>}
          <label className="flex items-start gap-3 rounded-xl border border-line bg-surface-2 p-3 text-sm"><input type="checkbox" className="mt-0.5 accent-clay" checked={f.consults} onChange={(e) => set('consults', e.target.checked)} /><span><b className="block font-medium">Consults patients</b><span className="text-xs text-muted">Gets a column on the calendar and signs prescriptions. Turns on Consulting hours.</span></span></label>
          {f.consults && <div className="grid grid-cols-2 gap-3">
            <div><label className="label" htmlFor="ps-reg">Registration no.</label><input id="ps-reg" className="input" maxLength={40} value={f.regNo} onChange={(e) => set('regNo', e.target.value)} /></div>
            <div><label className="label" htmlFor="ps-qual">Qualification</label><input id="ps-qual" className="input" maxLength={80} placeholder="e.g. MD (DVL)" value={f.qualification} onChange={(e) => set('qualification', e.target.value)} /></div>
          </div>}
          {f.consults && <div><span className="label">Signature on the prescription</span>{f.pracId ? <PictureUpload wide url={cfg.tenant.settings?.signatures?.[f.pracId]} uploadTo={`/admin/practitioners/${f.pracId}/signature`} label="Signature" empty="No signature yet" hint="Printed above the signature line on finished prescriptions. Sign on white paper and take a photo, or use a PNG." /> : <div className="text-xs text-muted">Add the doctor first, then upload their signature.</div>}</div>}
          {!f.consults && f.wasConsulting && <div className="rounded-xl bg-amber-soft px-3 py-2 text-sm text-amber">Saving takes them off the calendar. Bookings already made stay; move them first.</div>}
        </div>}
        {tab === 'hours' && f.consults && <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2"><span className="text-sm text-muted mr-auto">Set the week once; every day's OP hours come from it.</span>{f.pracId && f.wasConsulting && <button type="button" className="btn btn-sm" onClick={() => setDayFor(true)}><Icon name="calendar" className="h-3.5 w-3.5" />Change one day</button>}</div>
          <RoutineEditor value={f.routine} onChange={(r) => set('routine', r)} />
        </div>}
        {tab === 'signin' && <div className="space-y-3">
          {!f.userId && <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-0.5 accent-clay" checked={f.signIn} onChange={(e) => set('signIn', e.target.checked)} /><span><b className="block font-medium">Signs in to the app</b><span className="text-xs text-muted">The app makes a first password and shows it once after you save.</span></span></label>}
          {lockedOwner && <div className="rounded-xl bg-amber-soft px-3 py-2 text-sm text-amber">This person is an owner. Only an owner can change their email, password or whether they are active.</div>}
          {f.signIn && <>
            <div><label className="label" htmlFor="ps-email">Email (used to sign in)</label><input id="ps-email" type="email" className={`input ${f.email && !emailOk ? '!border-rose' : ''}`} maxLength={200} disabled={lockedOwner} value={f.email} onChange={(e) => set('email', e.target.value)} /></div>
            {f.userId && !lockedOwner && !isMe && <div className="flex flex-wrap items-center gap-2"><span className="label !mb-0">Password</span><button type="button" className="btn btn-sm" disabled={reset.isPending} onClick={askReset}><Icon name="lock" className="h-3.5 w-3.5" />Reset password</button></div>}
            {isMe && <div className="text-xs text-muted">Change your own password from your name at the top right.</div>}
          </>}
        </div>}
        {problem && <div className="text-xs text-muted">{problem}</div>}
        <div className="modal-foot !justify-between">
          {(f.userId || f.pracId) && !isMe && !lockedOwner ? <button type="button" className="btn" disabled={save.isPending} onClick={askInactive}>{value.active ? 'Mark inactive' : 'Make active'}</button> : <span />}
          <div className="flex gap-2"><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={save.isPending || !!problem} onClick={() => save.mutate(value.active)}><Icon name="check" />{f.userId || f.pracId ? 'Save' : 'Add'}</button></div>
        </div>
      </div>
      {dayFor && f.pracId && <ChangeMyDay practitionerId={f.pracId} name={f.name} initialKind="away" onClose={() => { setDayFor(false); qc.invalidateQueries({ queryKey: ['calendar'] }); }} />}
    </Drawer>
  );
}
