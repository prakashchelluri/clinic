// The pharmacy side of a procedure session: its asks show on the Counter as cards marked "Procedure · No bill";
// opening one issues the items off stock (the batch that expires first, or the one picked). No bill, no payment.
import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { get, post, qc, errText } from './api';
import { Chip, Icon, Modal, Skeleton, ask, toast } from './ui';

const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('');

/** One procedure ask on the Counter, the same size as a prescription card. */
export function ProcAskCard({ r, onOpen }: { r: any; onOpen: () => void }) {
  const quiet = r.status !== 'asked';
  return (
    <button type="button" onClick={onOpen} className={`flex min-w-0 items-center gap-2.5 rounded-[18px] p-2.5 pl-3 text-left transition-all duration-200 ${quiet ? 'bg-surface-2 text-ink-2 shadow-[var(--ring)]' : 'bg-surface text-ink shadow-[inset_0_0_0_2px_var(--color-clay)] hover:-translate-y-0.5'}`}>
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-clay-soft text-[12px] font-bold text-clay-ink">{initials(r.patient.fullName)}</span>
      <span className="min-w-0 flex-1"><b className="block truncate text-[13.5px]">{r.patient.fullName}</b><small className="block truncate text-[12px] opacity-75">{r.procedure ?? 'Procedure'} · session {r.sittingNo}{r.room ? ` · ${r.room}` : ''}</small></span>
      <span className="shrink-0 text-right"><b className="block text-[13px]">{r.items} {r.items === 1 ? 'item' : 'items'}</b><small className="block text-[11.5px] font-semibold text-clay-ink">{r.status === 'asked' ? 'Procedure · No bill' : r.status === 'none' ? 'Not given' : 'Issued'}</small></span>
    </button>);
}

/** Issue what a procedure session asked for: per item a batch and a quantity. Popup, since it moves stock. */
export function IssueSupplies({ sessionId, canIssue, onClose }: { sessionId: string; canIssue: boolean; onClose: () => void }) {
  const q = useQuery({ queryKey: ['pharmacy', 'supplies', sessionId], queryFn: () => get(`/pharmacy/supplies/${sessionId}`) });
  const d = q.data; const open = (d?.asks ?? []).filter((a: any) => a.status === 'asked');
  const [pick, setPick] = useState<Record<string, { batchId: string; qty: string }>>({});
  useEffect(() => { if (!d) return; const p: Record<string, { batchId: string; qty: string }> = {};
    for (const a of open) for (const l of a.lines) { const st = d.stock[l.medicineId]; p[`${a.id}:${l.medicineId}`] = { batchId: st?.batches[0]?.id ?? '', qty: String(Math.min(l.qty, st?.onHand ?? 0)) }; }
    setPick(p); }, [d]);
  const done = () => { ['pharmacy', 'procedure-session', 'plan-form'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); };
  const issue = useMutation({ mutationFn: (a: any) => post(`/pharmacy/supplies/${sessionId}/${a.id}/issue`, { lines: a.lines.map((l: any) => { const x = pick[`${a.id}:${l.medicineId}`]; return { medicineId: l.medicineId, batchId: x?.batchId || undefined, qty: Number(x?.qty) || 0 }; }) }),
    onSuccess: (r: any) => { done(); toast(`Issued ${r.issued.reduce((n: number, x: any) => n + x.qty, 0)} items · no bill`); }, onError: (e) => toast(errText(e), 'err') });
  const none = useMutation({ mutationFn: ({ a, note }: { a: any; note: string }) => post(`/pharmacy/supplies/${sessionId}/${a.id}/none`, { note: note || undefined }),
    onSuccess: () => { done(); toast('Noted: not given'); }, onError: (e) => toast(errText(e), 'err') });
  const notGiven = async (a: any) => { const r = await ask({ title: 'Not giving these items?', body: 'The doctor sees this on the session.', confirmLabel: 'Not given', field: { label: 'Why', placeholder: 'Not in stock', maxLength: 200 } }); if (r) none.mutate({ a, note: r.value }); };

  return (
    <Modal title={d ? d.patient.fullName : 'Procedure request'} subtitle={d ? `${d.procedure ?? 'Procedure'} · session ${d.sittingNo}${d.room ? ` · ${d.room}` : ''}` : undefined} onClose={onClose} width="max-w-2xl">
      {q.isError ? <div className="text-sm text-rose">{errText(q.error)}</div> : !d ? <Skeleton rows={4} /> : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2"><Chip tone="sky">Procedure · No bill</Chip>{d.patient.allergies && <Chip tone="rose">Allergy: {d.patient.allergies}</Chip>}<span className="text-[12.5px] text-muted">Covered by the procedure price. Stock goes down as “Used in procedure”.</span></div>
          {d.asks.map((a: any) => (
            <section key={a.id} className="rounded-[12px] border border-line">
              <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5 text-[12.5px] text-muted">Asked by {a.by} · {new Date(a.at).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' })}
                <span className="ml-auto">{a.status === 'issued' ? <Chip tone="sage">Issued by {a.doneBy}</Chip> : a.status === 'none' ? <Chip tone="rose">Not given: {a.note}</Chip> : <Chip tone="amber">To issue</Chip>}</span></div>
              <div className="divide-y divide-line/70">
                {a.status === 'issued' ? a.issued.map((x: any, i: number) => <div key={i} className="flex gap-3 px-4 py-2.5 text-[13.5px]"><b className="flex-1 font-semibold">{x.name}</b><span className="text-muted">Batch {x.batchNo}</span><span>× {x.qty}</span></div>)
                  : a.lines.map((l: any) => { const st = d.stock[l.medicineId]; const k = `${a.id}:${l.medicineId}`; const x = pick[k];
                    return (
                      <div key={l.medicineId} className="grid grid-cols-1 items-center gap-2 px-4 py-2.5 text-[13.5px] sm:grid-cols-[minmax(0,1fr)_210px_60px_80px]">
                        <span><b className="font-semibold">{l.name}</b><span className="block text-[12px] text-muted">{st?.onHand ?? 0} in stock</span></span>
                        {a.status === 'asked' ? <select className="input" aria-label={`${l.name} batch`} value={x?.batchId ?? ''} disabled={!canIssue} onChange={(e) => setPick((p) => ({ ...p, [k]: { ...p[k], batchId: e.target.value } }))}>
                          {(st?.batches ?? []).length === 0 && <option value="">No stock</option>}
                          {(st?.batches ?? []).map((b: any) => <option key={b.id} value={b.id}>{b.batchNo} · exp {new Date(b.expiry + 'T00:00:00').toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })} · {b.qty}</option>)}</select> : <span />}
                        <span className="text-muted">Asked {l.qty}</span>
                        {a.status === 'asked' ? <input className="input" aria-label={`${l.name} quantity to issue`} inputMode="numeric" disabled={!canIssue} value={x?.qty ?? ''} onChange={(e) => setPick((p) => ({ ...p, [k]: { ...p[k], qty: e.target.value.replace(/\D/g, '') } }))} /> : <span />}
                      </div>); })}
              </div>
              {a.status === 'asked' && canIssue && <div className="flex gap-2 border-t border-line px-4 py-2.5">
                <button type="button" className="btn btn-ghost" disabled={none.isPending} onClick={() => notGiven(a)}>Not in stock</button><span className="flex-1" />
                <button type="button" className="btn btn-primary" disabled={issue.isPending || !a.lines.some((l: any) => Number(pick[`${a.id}:${l.medicineId}`]?.qty) > 0)} onClick={() => issue.mutate(a)}><Icon name="check" className="h-4 w-4" />Issue {a.lines.length} {a.lines.length === 1 ? 'item' : 'items'}</button></div>}
            </section>))}
          {!open.length && <div className="modal-foot"><button type="button" className="btn btn-primary" onClick={onClose}>Done</button></div>}
        </div>)}
    </Modal>);
}
