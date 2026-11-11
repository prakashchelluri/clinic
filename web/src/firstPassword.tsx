import { useState } from 'react';
import { patch, post, qc, errText } from './api';

/** Signed in with a first or reset password: pick your own before anything else. The server refuses everything else until then. */
export function FirstPassword({ name }: { name: string }) {
  const [f, setF] = useState({ cur: '', next: '', again: '' }); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const bad = f.next.length < 8 ? 'At least 8 characters.' : f.next !== f.again ? 'The two new passwords are not the same.' : f.next === f.cur ? 'Pick a password different from the one you were given.' : '';
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); if (bad || !f.cur) return; setBusy(true); setErr('');
    try { await patch('/me/password', { currentPassword: f.cur, newPassword: f.next }); await qc.invalidateQueries(); }
    catch (x) { setErr(errText(x)); } finally { setBusy(false); }
  };
  const out = async () => { await post('/auth/logout').catch(() => {}); qc.clear(); location.href = '/login'; };
  return (
    <div className="min-h-dvh grid place-items-center bg-paper p-6">
      <form onSubmit={save} className="card w-full max-w-sm space-y-3 anim-fade-up">
        <h1 className="text-[18px] font-semibold">Pick your own password</h1>
        <p className="text-sm text-ink-2">Welcome, {name}. You signed in with a password someone else gave you. Choose your own to carry on.</p>
        <div><label className="label" htmlFor="fp-cur">Password you were given</label><input id="fp-cur" className="input" type="password" autoComplete="current-password" autoFocus value={f.cur} onChange={(e) => setF({ ...f, cur: e.target.value })} /></div>
        <div><label className="label" htmlFor="fp-new">New password (at least 8 characters)</label><input id="fp-new" className="input" type="password" autoComplete="new-password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} /></div>
        <div><label className="label" htmlFor="fp-again">New password again</label><input id="fp-again" className="input" type="password" autoComplete="new-password" value={f.again} onChange={(e) => setF({ ...f, again: e.target.value })} /></div>
        {(f.next || f.again) && bad && <div className="text-xs text-rose">{bad}</div>}
        {err && <div className="text-sm text-rose" role="alert">{err}</div>}
        <div className="flex items-center justify-between gap-2 pt-1"><button type="button" className="btn btn-ghost" onClick={out}>Sign out</button><button className="btn btn-primary" disabled={busy || !f.cur || !!bad}>{busy ? 'Saving…' : 'Save and continue'}</button></div>
      </form>
    </div>
  );
}
