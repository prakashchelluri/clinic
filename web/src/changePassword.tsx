import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { patch, errText } from './api';
import { Modal, toast } from './ui';

/** "Change my password" from your own name (the side menu, or the account menu on a phone): it is yours, not a clinic setting. */
export const openChangePassword = () => window.dispatchEvent(new Event('app:change-password'));
const SAY: Record<string, string> = { WRONG_CURRENT_PASSWORD: 'Your current password is not right.', SAME_PASSWORD: 'Pick a new password that is different from the current one.' };

export function ChangePasswordHost() {
  const [pw, setPw] = useState<null | { cur: string; next: string; again: string }>(null);
  useEffect(() => { const on = () => setPw({ cur: '', next: '', again: '' }); window.addEventListener('app:change-password', on); return () => window.removeEventListener('app:change-password', on); }, []);
  const save = useMutation({ mutationFn: () => patch('/me/password', { currentPassword: pw!.cur, newPassword: pw!.next }), onSuccess: () => { setPw(null); toast('Your password is changed'); }, onError: (e: any) => toast(SAY[e?.body?.code] ?? errText(e), 'err') });
  if (!pw) return null;
  const ok = !!pw.cur && pw.next.length >= 8 && pw.next === pw.again;
  return (
    <Modal title="Change my password" subtitle="At least 8 characters. You stay signed in." onClose={() => setPw(null)} width="max-w-sm" submitOnEnter>
      <div className="space-y-3">
        <div><label className="label" htmlFor="pw-cur">Current password</label><input id="pw-cur" autoFocus className="input" type="password" autoComplete="current-password" value={pw.cur} onChange={(e) => setPw({ ...pw, cur: e.target.value })} /></div>
        <div><label className="label" htmlFor="pw-new">New password</label><input id="pw-new" className="input" type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></div>
        <div><label className="label" htmlFor="pw-again">New password again</label><input id="pw-again" className="input" type="password" autoComplete="new-password" value={pw.again} onChange={(e) => setPw({ ...pw, again: e.target.value })} /></div>
        {pw.next && pw.next.length < 8 ? <div className="text-xs text-rose">At least 8 characters.</div> : pw.again && pw.again !== pw.next ? <div className="text-xs text-rose">The two new passwords are not the same.</div> : null}
        <div className="modal-foot"><button type="button" className="btn btn-ghost" onClick={() => setPw(null)}>Cancel</button><button type="button" className="btn btn-primary" disabled={save.isPending || !ok} onClick={() => save.mutate()}>Change password</button></div>
      </div>
    </Modal>
  );
}
