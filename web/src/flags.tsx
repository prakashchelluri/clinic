import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { get, patch, qc, errText } from './api';
import { Chip, Icon, Modal, toast, fmtDate } from './ui';

export type Flags = { vip?: boolean; family?: boolean; careful?: { note: string; by: string; at: string } };

/** VIP, Family and friends, Handle carefully: a chip beside the name wherever the patient appears.
 *  The reason is written on the chip (first 40 letters; the whole of it on hover and on the record), so touch screens see it too. */
export function FlagChips({ flags }: { flags?: Flags | null }) {
  if (!flags) return null;
  const why = flags.careful?.note ?? '';
  return <>
    {flags.vip && <Chip tone="sage">VIP</Chip>}
    {flags.family && <Chip tone="sky">Family and friends</Chip>}
    {flags.careful && <span title={`Why: ${why}`}><Chip tone="amber" className="!max-w-[22rem] overflow-hidden"><span className="truncate">Handle carefully{why && <span className="font-semibold">: {why.length > 40 ? why.slice(0, 39) + '…' : why}</span>}</span></Chip></span>}
  </>;
}

/** The reason for Handle carefully, who set it and when; shown to everyone who opens the record, the desk included. */
export function CarefulBanner({ flags }: { flags?: Flags | null }) {
  const c = flags?.careful; if (!c) return null;
  return <div className="mt-2 rounded-xl bg-amber-soft px-3 py-2 text-sm text-amber" role="note"><b>Handle carefully.</b> {c.note} <span className="opacity-80">· set by {c.by}, {fmtDate(c.at)}</span></div>;
}

export function FlagEditor({ patientId, flags, onClose }: { patientId: string; flags: Flags; onClose: () => void }) {
  const [vip, setVip] = useState(!!flags.vip); const [family, setFamily] = useState(!!flags.family);
  const [careful, setCareful] = useState(!!flags.careful); const [note, setNote] = useState(flags.careful?.note ?? '');
  const save = useMutation({
    mutationFn: () => patch(`/patients/${patientId}/flags`, { vip, family, careful: careful ? { note: note.trim() } : null }),
    onSuccess: () => { ['timeline', 'patients', 'frontdesk'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); toast('Saved'); onClose(); },
    onError: (e) => toast(errText(e), 'err'),
  });
  const blocked = careful && note.trim().length < 3;
  return (
    <Modal title="Flags" subtitle="Shown beside the name on every screen" onClose={onClose} width="max-w-md">
      <div className="space-y-3">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-clay" checked={vip} onChange={(e) => setVip(e.target.checked)} /> VIP</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-clay" checked={family} onChange={(e) => setFamily(e.target.checked)} /> Family and friends</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-clay" checked={careful} onChange={(e) => setCareful(e.target.checked)} /> Handle carefully</label>
        {careful && <div className="anim-fade-up"><label className="label" htmlFor="why">Why (the whole front desk will see this)</label>
          <input id="why" autoFocus maxLength={300} className="input" placeholder="for example: sensitive diagnosis; discuss only with the mother" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="mt-1 text-xs text-muted">Messages and reminders for this patient will not carry the diagnosis or procedure name.</div></div>}
        <div className="modal-foot"><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={save.isPending || blocked} onClick={() => save.mutate()}><Icon name="check" />Save</button></div>
      </div>
    </Modal>
  );
}

/** Flags asked at registration: VIP, Family and friends, Handle carefully (with a reason). */
export type FlagDraft = { vip: boolean; family: boolean; careful: boolean; note: string };
export const NO_FLAGS: FlagDraft = { vip: false, family: false, careful: false, note: '' };
export const flagBody = (f: FlagDraft) => (f.vip || f.family || f.careful ? { flags: { vip: f.vip, family: f.family, ...(f.careful ? { careful: { note: f.note.trim() } } : {}) } } : {});
export const flagDraftBad = (f: FlagDraft) => f.careful && f.note.trim().length < 3;
export function FlagPick({ value, onChange }: { value: FlagDraft; onChange: (f: FlagDraft) => void }) {
  const opt = (k: 'vip' | 'family' | 'careful', l: string) => <button type="button" aria-pressed={value[k]} className={`toggle-opt ${value[k] ? 'on' : ''}`} onClick={() => onChange({ ...value, [k]: !value[k] })}>{l}</button>;
  return <div>
    <span className="label">Flag <span className="font-normal text-muted">(optional, shown beside the name)</span></span>
    <div className="flex flex-wrap gap-1" role="group" aria-label="Flag">{opt('vip', 'VIP')}{opt('family', 'Family and friends')}{opt('careful', 'Handle carefully')}</div>
    {value.careful && <div className="mt-2 anim-fade-up"><label className="label" htmlFor="flag-why">Why (the whole front desk will see this)</label>
      <input id="flag-why" maxLength={300} className="input" placeholder="for example: sensitive diagnosis; discuss only with the mother" value={value.note} onChange={(e) => onChange({ ...value, note: e.target.value })} />
      {flagDraftBad(value) && <div className="mt-1 text-xs text-rose">Say why, in a few words.</div>}</div>}
  </div>;
}

/** Pick the parent: search by name, phone or ID. */
export function GuardianPick({ value, onChange, selfId }: { value: { id: string; fullName: string } | null; onChange: (g: { id: string; fullName: string } | null) => void; selfId: string }) {
  const [q, setQ] = useState('');
  const res = useQuery({ queryKey: ['guardian-pick', q], queryFn: () => get(`/patients?q=${encodeURIComponent(q)}`), enabled: q.trim().length >= 2 });
  if (value) return <div className="flex items-center gap-2 text-sm"><b>{value.fullName}</b><button type="button" className="underline text-muted" onClick={() => onChange(null)}>change</button></div>;
  return <div><input className="input" placeholder="Search the parent by name, phone or ID" value={q} onChange={(e) => setQ(e.target.value)} />
    {q.trim().length >= 2 && <div className="mt-1 max-h-40 overflow-auto rounded-xl border border-line bg-surface">{(res.data ?? []).filter((p: any) => p.id !== selfId).slice(0, 6).map((p: any) => <button key={p.id} type="button" className="block w-full px-3 py-2 text-left text-sm hover:bg-clay-soft/50" onClick={() => onChange({ id: p.id, fullName: p.fullName })}>{p.fullName} <span className="text-xs text-muted">{p.patientNo} · {p.ageYears ? `${p.ageYears}y` : ''} {p.sex ?? ''}</span></button>)}</div>}</div>;
}
