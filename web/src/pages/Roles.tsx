import { useEffect, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useOutletContext } from 'react-router';
import { get, post, patch, del, qc, errText } from '../api';
import { NAV, can } from '../App';
import { Chip, Icon, Modal, Skeleton, toast } from '../ui';

/** Every permission the system knows, in plain words. Mirrors the server list (src/lib/auth.ts). */
export const useRoles = () => useQuery({ queryKey: ['roles'], queryFn: () => get('/admin/roles'), staleTime: 30_000 });
const useCatalog = () => useQuery({ queryKey: ['permissions'], queryFn: () => get('/admin/permissions'), staleTime: 10 * 60_000 });

/** Ticking "write" needs "read" to be useful; unticking "read" removes what depends on it. */
const NEEDS: Record<string, string> = {
  'patient.write': 'patient.read', 'document.write': 'document.read', 'appointment.write': 'appointment.read', 'visit.write': 'visit.read', 'visit.queue': 'visit.read',
  'worklist.write': 'worklist.read', 'expense.write': 'expense.read', 'pharmacy.dispense': 'pharmacy.read', 'pharmacy.bill': 'pharmacy.read', 'user.write': 'user.read',
};

export function RolesTab({ onSaved }: { onSaved: () => void }) {
  const { perms: mine } = useOutletContext<any>();
  const roles = useRoles(); const cat = useCatalog();
  const [sel, setSel] = useState<string>('receptionist');
  const [draft, setDraft] = useState<string[] | null>(null); const [name, setName] = useState('');
  const [adding, setAdding] = useState<{ name: string; from: string } | null>(null);
  const list: any[] = roles.data ?? []; const role = list.find((r) => r.key === sel) ?? list[0];
  useEffect(() => { setDraft(null); setName(role?.name ?? ''); }, [role?.key, roles.dataUpdatedAt]);
  const perms: string[] = draft ?? role?.perms ?? [];
  const dirty = !!role && ((draft && [...draft].sort().join() !== [...role.perms].sort().join()) || (!role.builtin && name.trim() !== role.name));
  const refresh = () => { qc.invalidateQueries({ queryKey: ['roles'] }); qc.invalidateQueries({ queryKey: ['users'] }); qc.invalidateQueries({ queryKey: ['me'] }); onSaved(); };
  const fail = (e: any) => toast(errText(e), 'err');
  const save = useMutation({ mutationFn: () => patch(`/admin/roles/${role.key}`, { perms, ...(role.builtin ? {} : { name: name.trim() }) }), onSuccess: () => { toast('Saved. People with this role get it on their next click.'); refresh(); }, onError: fail });
  const reset = useMutation({ mutationFn: () => del(`/admin/roles/${role.key}`), onSuccess: () => { toast(role.builtin ? 'Back to the standard permissions' : 'Role deleted'); if (!role.builtin) setSel('receptionist'); refresh(); }, onError: fail });
  const create = useMutation({ mutationFn: () => post('/admin/roles', { name: adding!.name.trim(), perms: (list.find((r) => r.key === adding!.from)?.perms ?? []) }), onSuccess: (r: any) => { toast('Role created. Now tick what it can do.'); setAdding(null); setSel(r.key); refresh(); }, onError: fail });

  if (!role || !cat.data) return <div className="card"><Skeleton rows={5} /></div>;
  const groups: Record<string, any[]> = {}; for (const p of cat.data) (groups[p.group] ??= []).push(p);
  const toggle = (k: string) => {
    const has = perms.includes(k); let next = has ? perms.filter((x) => x !== k) : [...perms, k];
    if (!has && NEEDS[k] && !next.includes(NEEDS[k])) next.push(NEEDS[k]);
    if (has) next = next.filter((x) => NEEDS[x] !== k);
    setDraft(next);
  };
  const pages = NAV.filter((n) => n.to !== '/platform' && n.show((p: string) => can(perms, p))).map((n) => n.label);
  const locked = role.locked;

  return (
    <div className="grid grid-cols-1 md:grid-cols-[230px_minmax(0,1fr)] gap-4 items-start">
      <div className="card-flat overflow-hidden">
        {list.map((r) => (
          <button key={r.key} onClick={() => setSel(r.key)} className={'w-full text-left px-4 py-3 border-b border-ink/8 last:border-0 transition-colors ' + (r.key === role.key ? 'bg-white' : 'hover:bg-white/50')}>
            <div className="flex items-center gap-2"><span className="text-sm font-medium">{r.name}</span>{!r.builtin && <Chip tone="sky">custom</Chip>}</div>
            <div className="text-xs text-muted">{r.users} {r.users === 1 ? 'person' : 'people'}{r.builtin && !r.locked && [...r.perms].sort().join() !== [...(r.defaultPerms ?? [])].sort().join() ? ' · changed' : ''}</div>
          </button>))}
        <button className="w-full text-left px-4 py-3 text-sm font-medium text-clay hover:bg-white/50" onClick={() => setAdding({ name: '', from: role.key })}><Icon name="plus" className="h-3.5 w-3.5 inline mr-1.5" />New role</button>
      </div>

      <div className="card-flat p-5 min-w-0">
        <div className="flex flex-wrap items-center gap-3 mb-1">
          {role.builtin ? <h3 className="text-lg font-medium mr-auto">{role.name}</h3> : <input className="input !w-64 mr-auto" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} aria-label="Role name" />}
          {role.builtin && !locked && <button className="btn btn-sm" disabled={reset.isPending} onClick={() => reset.mutate()}>Reset to standard</button>}
          {!role.builtin && <button className="btn btn-sm !text-rose" disabled={role.users > 0 || reset.isPending} title={role.users > 0 ? 'Move these people to another role first' : ''} onClick={() => reset.mutate()}>Delete role</button>}
        </div>
        <p className="text-sm text-muted mb-4">{locked ? 'The owner always has full access. This cannot be changed, so you can never lock yourself out.' : 'Tick what people with this role can do. Staff can hold several roles; their permissions add up.'}</p>
        <div className="mb-4 flex flex-wrap items-center gap-1.5 text-xs"><span className="text-muted mr-1">Pages they will see:</span>{pages.length ? pages.map((p: string) => <Chip key={p} tone="sage">{p}</Chip>) : <span className="text-muted">none yet</span>}</div>
        <div className="space-y-5">
          {Object.entries(groups).map(([g, items]) => (
            <fieldset key={g}><legend className="text-[11px] font-semibold uppercase tracking-wider text-muted mb-1.5">{g}</legend>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6">{items.map((p) => {
                const on = perms.includes(p.key); const cannot = !locked && !can(mine, p.key);
                return (
                  <label key={p.key} className={'flex items-start gap-2.5 py-1.5 text-sm ' + (locked || cannot ? 'opacity-60' : 'cursor-pointer')} title={cannot ? 'You can only hand out permissions you have yourself' : ''}>
                    <input type="checkbox" className="accent-clay mt-0.5 h-4 w-4" checked={on} disabled={locked || cannot} onChange={() => toggle(p.key)} />
                    <span><span>{p.label}</span>{p.hint && <span className="block text-xs text-muted">{p.hint}</span>}</span>
                  </label>); })}</div>
            </fieldset>))}
        </div>
        {!locked && (
          <div className="flex items-center justify-end gap-2 mt-5 pt-4 border-t border-ink/8">
            <span className="text-xs text-muted mr-auto">{dirty ? 'You have unsaved changes' : 'No changes'}</span>
            <button className="btn btn-ghost" disabled={!dirty} onClick={() => { setDraft(null); setName(role.name); }}>Undo</button>
            <button className="btn btn-primary" disabled={!dirty || save.isPending || (!role.builtin && name.trim().length < 1)} onClick={() => save.mutate()}>Save changes</button>
          </div>)}
      </div>

      {adding && (
        <Modal title="New role" subtitle="Give it a name, then tick what it can do" onClose={() => setAdding(null)} width="max-w-md" submitOnEnter>
          <div className="space-y-3">
            <div><label className="label" htmlFor="role-name">Role name</label><input id="role-name" autoFocus className="input" maxLength={100} placeholder="e.g. Lab technician" value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} /></div>
            <div><label className="label" htmlFor="role-from">Start from</label><select id="role-from" className="input" value={adding.from} onChange={(e) => setAdding({ ...adding, from: e.target.value })}>{list.map((r) => <option key={r.key} value={r.key}>{r.name}'s permissions</option>)}</select></div>
            <div className="modal-foot"><button className="btn btn-ghost" onClick={() => setAdding(null)}>Cancel</button><button className="btn btn-primary" disabled={adding.name.trim().length < 1 || create.isPending} onClick={() => create.mutate()}>Create role</button></div>
          </div>
        </Modal>)}
    </div>
  );
}
