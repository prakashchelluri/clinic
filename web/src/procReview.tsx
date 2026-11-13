import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { get, post, errText } from './api';
import { Icon, Modal, Skeleton, toast } from './ui';
import { addDay, t12 } from './procBlocks';
import { ScheduleModal } from './pages/Worklist';
import { refreshProcedures } from './pages/ProcToday';

const fmt = (d: string, o: Intl.DateTimeFormatOptions) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { ...o, timeZone: 'UTC' });

/** For the doctor's Today: how many sittings wait for their approval. */
export const useApprovals = (enabled: boolean) => useQuery({ queryKey: ['psessions', 'approvals'], queryFn: () => get('/procedure-approvals'), enabled, refetchInterval: 60000 });

/**
 * The doctor reviews the sittings the coordinator sent (v71): a plain list, day by day. Approve all in one tap, or per sitting:
 * Approve, Move (pick another day or time; the doctor's own move is approved as it lands), or Send back with a note, which
 * leaves it booked and flagged for the coordinator to move.
 */
export function ProcReview({ onClose }: { onClose: () => void }) {
  const q = useApprovals(true);
  const [back, setBack] = useState<string | null>(null); const [note, setNote] = useState('');
  const [moving, setMoving] = useState<any>(null);
  const [allBack, setAllBack] = useState(false); // Send back all: one note for every sitting waiting
  const decide = useMutation({ mutationFn: (b: { ids: string[]; action: 'approve' | 'change'; note?: string }) => post('/procedure-approvals', b),
    onSuccess: (r: any, b) => { refreshProcedures(); setBack(null); setNote(''); toast(b.action === 'approve' ? `Approved ${r.updated}. The patient${r.updated === 1 ? ' gets' : 's get'} a reminder the day before.` : 'Sent back to the coordinator with your note.'); },
    onError: (e) => toast(errText(e), 'err') });

  const data = q.data;
  const all: any[] = (data?.sittings ?? []).filter((s: any) => s.state === 'confirmed');
  const waiting = all.filter((s) => s.approval === 'sent');
  const awayOn = (d: string) => (data?.away ?? []).some((a: any) => a.day === d);
  const flag = (s: any) => awayOn(s.day) ? 'You are away that day' : s.lastDone && s.gapDays && s.day < addDay(s.lastDone, s.gapDays) ? `Too soon: last sitting ${fmt(s.lastDone, { day: 'numeric', month: 'short' })}, every ${s.gapDays} days` : '';
  const days = [...new Set(all.map((s) => s.day))].sort();

  return (
    <Modal title="Procedures to approve" subtitle={data ? `${data.pending} sitting${data.pending === 1 ? '' : 's'} from the coordinator` : undefined} onClose={onClose} width="max-w-3xl">
      {q.isLoading ? <Skeleton rows={6} /> : !waiting.length ? <div className="py-8 text-center text-muted">Nothing waiting for you. Everything is approved.</div> : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2"><span className="text-[13.5px] text-muted">Check the dates, then approve. Move or send back only what needs it.</span><span className="flex-1" />
            <button type="button" className="btn text-rose" aria-expanded={allBack} onClick={() => { setAllBack(!allBack); setBack(null); setNote(''); }}>Send back all</button>
            <button type="button" className="btn btn-primary" disabled={decide.isPending} onClick={() => decide.mutate({ ids: waiting.map((x) => x.id), action: 'approve' })}><Icon name="check" />Approve all {waiting.length}</button></div>
          {allBack && <div className="flex flex-wrap items-center gap-2 rounded-[10px] bg-rose-soft px-3 py-2.5">
            <span className="text-[13.5px] font-medium text-rose">Send all {waiting.length} back to the coordinator. They stay booked; the coordinator decides what to do with them.</span>
            <input autoFocus aria-label="Note for the coordinator" className="input !w-auto min-w-[260px] flex-1" maxLength={200} placeholder="Why, e.g. I am at a conference that week" value={note} onChange={(e) => setNote(e.target.value)} />
            <button className="btn btn-sm" onClick={() => setAllBack(false)}>Cancel</button>
            <button className="btn btn-sm btn-primary" disabled={!note.trim() || decide.isPending} onClick={() => decide.mutate({ ids: waiting.map((x) => x.id), action: 'change', note: note.trim() }, { onSuccess: () => setAllBack(false) })}>Send back all {waiting.length}</button>
          </div>}
          <div className="overflow-hidden rounded-[10px] border border-line">
            {days.map((d) => (
              <div key={d}>
                <div className="border-b border-line bg-paper-2 px-4 py-2 text-[13px] font-semibold text-ink-2">{fmt(d, { weekday: 'long', day: 'numeric', month: 'short' })}{awayOn(d) && <span className="ml-2 font-normal text-rose">You are away</span>}</div>
                {all.filter((s) => s.day === d).map((s) => { const f = s.approval === 'sent' ? flag(s) : ''; return (
                  <div key={s.id} className="border-b border-line px-4 py-2.5 last:border-b-0">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                      <span className="w-28 shrink-0 text-[13.5px] font-medium">{t12(s.startTime)}–{t12(s.endTime)}</span>
                      <span className="min-w-[180px] flex-1"><b className="block text-[14.5px] font-semibold">{s.patient}</b>
                        <span className="block text-[12.5px] text-muted">{[`${s.procedure ?? 'Procedure'} · sitting ${s.sittingNo}${s.of ? ` of ${s.of}` : ''}`, s.room, s.lastDone ? `last ${fmt(s.lastDone, { day: 'numeric', month: 'short' })}` : 'first sitting'].filter(Boolean).join(' · ')}</span>
                        {f && <span className="block text-[12.5px] font-semibold text-rose">{f}</span>}</span>
                      {s.approval === 'sent' ? <span className="flex flex-wrap gap-1.5">
                        <button className="btn btn-sm btn-primary" disabled={decide.isPending} onClick={() => decide.mutate({ ids: [s.id], action: 'approve' })}>Approve</button>
                        <button className="btn btn-sm" onClick={() => setMoving(s)}>Move</button>
                        <button className="btn btn-sm text-rose" aria-expanded={back === s.id} onClick={() => { setBack(back === s.id ? null : s.id); setNote(''); }}>Send back</button>
                      </span> : <span className="text-[12.5px] text-muted">{s.approval === 'approved' ? 'Approved' : s.approval === 'change' ? `Sent back: ${s.approvalNote ?? ''}` : ''}</span>}
                    </div>
                    {back === s.id && <div className="mt-2 flex flex-wrap items-center gap-2 pl-0 sm:pl-[124px]">
                      <input autoFocus aria-label="Note for the coordinator" className="input !w-auto min-w-[260px] flex-1" maxLength={200} placeholder="Why, e.g. not this week, after OP around 5" value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && note.trim()) decide.mutate({ ids: [s.id], action: 'change', note: note.trim() }); }} />
                      <button className="btn btn-sm" onClick={() => setBack(null)}>Cancel</button>
                      <button className="btn btn-sm btn-primary" disabled={!note.trim() || decide.isPending} onClick={() => decide.mutate({ ids: [s.id], action: 'change', note: note.trim() })}>Send back</button>
                    </div>}
                  </div>); })}
              </div>))}
          </div>
        </div>)}
      {moving && <ScheduleModal rec={{ id: moving.recommendationId, procedureId: moving.procedureId, patient: { fullName: moving.patient, phone: '' }, sittings: moving.of }} sitting={moving} onClose={() => { setMoving(null); refreshProcedures(); }} />}
    </Modal>
  );
}
