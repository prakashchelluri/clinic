import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { get, post, today, errText } from './api';
import { Icon, Modal, Skeleton, toast } from './ui';
import { useBoxDrag, type DragItem } from './procDrag';
import { Block, Stub, addDay, dragItem, fillsHour, hourLabel, inHour, longDay, nowHHMM, placeOn, procHours, t12, toMin } from './procBlocks';
import { refreshProcedures } from './pages/ProcToday';

const fmt = (d: string, o: Intl.DateTimeFormatOptions) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { ...o, timeZone: 'UTC' });

/** For the doctor's Today: how many sittings wait for their approval. */
export const useApprovals = (enabled: boolean) => useQuery({ queryKey: ['psessions', 'approvals'], queryFn: () => get('/procedure-approvals'), enabled, refetchInterval: 60000 });

/**
 * The doctor reviews the sittings the coordinator sent: their week by the hour, next to their leave, each flagged when it falls
 * on a day off or too soon after the last sitting. Approve all in one tap; a sitting can be approved alone, moved (dragged, or Move…),
 * or sent back with a note. A move by the doctor is approved as it lands.
 */
export function ProcReview({ onClose }: { onClose: () => void }) {
  const q = useApprovals(true);
  const t = today();
  const [wi, setWi] = useState(0);
  const [sel, setSel] = useState<string | null>(null); const [note, setNote] = useState('');
  const [tap, setTap] = useState<DragItem | null>(null);
  const [landed, setLanded] = useState<string | null>(null);
  const decide = useMutation({ mutationFn: (b: { ids: string[]; action: 'approve' | 'change'; note?: string }) => post('/procedure-approvals', b),
    onSuccess: (r: any, b) => { refreshProcedures(); setNote(''); toast(b.action === 'approve' ? `Approved ${r.updated}. The coordinator calls the patient${r.updated === 1 ? '' : 's'}.` : 'Sent back to the coordinator with your note.'); },
    onError: (e) => toast(errText(e), 'err') });

  const data = q.data;
  const weeks: string[] = data?.weeks ?? [];
  const mon = weeks[Math.min(wi, weeks.length - 1)];
  const days = mon ? Array.from({ length: 6 }, (_, i) => addDay(mon, i)) : [];
  const all: any[] = (data?.sittings ?? []).filter((s: any) => days.includes(s.day)).map((s: any) => ({ ...s, patient: { fullName: s.patient }, doctor: 'You' }));
  const waiting = all.filter((s) => s.approval === 'sent' && s.state === 'confirmed');
  const awayOn = (d: string) => (data?.away ?? []).some((a: any) => a.day === d);
  const flag = (s: any) => awayOn(s.day) ? 'You are away that day' : s.lastDone && s.gapDays && s.day < addDay(s.lastDone, s.gapDays) ? `Too soon: last sitting ${fmt(s.lastDone, { day: 'numeric', month: 'short' })}, every ${s.gapDays} days` : '';
  const nowMin = toMin(nowHHMM());
  const pastCell = (d: string, h: number) => d < t || (d === t && (h + 1) * 60 <= nowMin);
  const hours = procHours(all);
  const find = (id: string) => all.find((s) => s.id === id);
  const check = (item: DragItem, key: string) => {
    if (!key.startsWith('R|')) return 'nowhere';
    const s = find(item.id); const [, d, hs] = key.split('|'); const h = Number(hs);
    if (s && s.day === d && Number(s.startTime.slice(0, 2)) === h) return 'same';
    if (pastCell(d, h)) return 'that hour is past';
    return awayOn(d) ? 'you are away that day' : '';
  };
  const drop = async (item: DragItem, key: string) => {
    setTap(null);
    const [, d, hs] = key.split('|');
    const r = await placeOn({ sittingId: item.id, day: d, hour: Number(hs) });
    if (r) { refreshProcedures(); setLanded(r.id); setTimeout(() => setLanded(null), 700); toast(`${item.title} moved to ${longDay(r.day)} ${t12(r.startTime)}. Approved; the coordinator tells the patient.`); }
  };
  const drag = useBoxDrag(check, drop);
  const s = sel ? find(sel) : null;
  const open = s && s.state === 'confirmed';

  return (
    <Modal title={mon ? `Procedures to approve · ${fmt(mon, { day: 'numeric', month: 'short' })} – ${fmt(addDay(mon, 5), { day: 'numeric', month: 'short' })}` : 'Procedures to approve'}
      subtitle={data ? `${data.pending} sitting${data.pending === 1 ? '' : 's'} from the coordinator waiting for you` : undefined} onClose={onClose} width="max-w-6xl">
      {q.isLoading ? <Skeleton rows={6} /> : !weeks.length ? <div className="py-8 text-center text-muted">Nothing waiting for you. Everything is approved.</div> : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {weeks.length > 1 && weeks.map((w, i) => <button key={w} type="button" className={`btn btn-sm ${i === wi ? 'btn-primary' : ''}`} onClick={() => setWi(i)}>Week of {fmt(w, { day: 'numeric', month: 'short' })}</button>)}
            <span className="flex-1" />
            {waiting.length > 0 && <button type="button" className="btn btn-primary" disabled={decide.isPending} onClick={() => decide.mutate({ ids: waiting.map((x) => x.id), action: 'approve' })}><Icon name="check" />Approve all {waiting.length}</button>}
          </div>
          {tap && <div className="flex items-center gap-3 rounded-2xl bg-clay-soft px-4 py-2.5 text-[14px] font-semibold text-clay-ink"><span className="flex-1">Moving {tap.title}: tap Free on an hour.</span><button className="btn btn-sm" onClick={() => setTap(null)}>Stop</button></div>}
          <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,1fr)_280px]">
            <div className="overflow-x-auto rounded-2xl ring-1 ring-line">
              <div className="pw-week" style={{ minWidth: 760 }}>
                <span className="hd" style={{ borderLeft: 0 }} />
                {days.map((d) => <span key={d} className={`hd ${d === t ? 'today' : ''}`}>{fmt(d, { weekday: 'short', day: 'numeric', month: 'short' })}<small className={awayOn(d) ? 'red' : ''}>{awayOn(d) ? 'You are away' : d === t ? 'today' : ' '}</small></span>)}
                {hours.map((h) => [
                  <span key={`t${h}`} className="t">{hourLabel(h)}</span>,
                  ...days.map((d) => {
                    const key = `R|${d}|${h}`; const list = all.filter((x) => x.day === d); const here = inHour(list, h); const why = drag.hoverWhy(key);
                    const tapOk = !!tap && !check(tap, key);
                    return (
                      <div key={key} className={`c ${drag.cellCls(key) || (tap ? (tapOk ? 'pw-can' : 'pw-cant') : pastCell(d, h) ? 'past' : awayOn(d) ? 'away' : '')}`} data-cell={key}>
                        {fillsHour(list, h).map((x) => <Stub key={x.id} s={x} />)}
                        {here.map((x) => {
                          const f = x.approval === 'sent' ? flag(x) : '';
                          return <div key={x.id} className="flex flex-col gap-0.5">
                            <Block s={x} week doctor cls={`${x.approval === 'approved' ? 'done' : ''} ${sel === x.id ? 'sel' : ''} ${drag.liftedId === x.id || tap?.id === x.id ? 'lifted' : ''} ${landed === x.id ? 'landed' : ''}`}
                              onDown={x.state === 'confirmed' && x.day >= t ? (e) => drag.start(e, dragItem(x)) : undefined} onClick={() => { if (!drag.wasDrag()) { setSel(x.id); setNote(''); } }} />
                            {f && <span className="pw-why">{f}</span>}
                          </div>;
                        })}
                        {why && why !== 'same' && <span className="pw-why">{why}</span>}
                        {drag.liftedId && drag.cellCls(key) === 'pw-hov-ok' && <span className="pw-drop">Drop here</span>}
                        {tapOk && <button type="button" className="pw-put" onClick={() => drop(tap!, key)}>Free</button>}
                      </div>);
                  }),
                ])}
              </div>
            </div>
            <aside className="flex flex-col gap-3 rounded-2xl bg-surface-2 p-4">
              {open ? <>
                <div><b className="text-[16px]">{s.patient.fullName}</b><div className="text-[13px] text-muted">{s.procedure ?? 'Procedure'} · sitting {s.sittingNo}{s.of ? ` of ${s.of}` : ''} · {s.room ?? 'no room'}</div></div>
                <div className="text-[13.5px] font-semibold">{longDay(s.day)} · {t12(s.startTime)}–{t12(s.endTime)}</div>
                <div className="text-[13px] text-muted">{s.lastDone ? `Last sitting ${fmt(s.lastDone, { day: 'numeric', month: 'short' })}` : 'First sitting'}{s.gapDays ? ` · every ${s.gapDays} days` : ''}</div>
                {s.approval === 'sent' && flag(s) && <div className="text-[13px] font-semibold text-rose">{flag(s)}</div>}
                {s.approval === 'change' && <div className="text-[13px] font-semibold text-rose">Sent back: {s.approvalNote}</div>}
                {s.approval === 'approved' && <div className="text-[13px] text-muted">Approved{s.approvedBy ? ` by ${s.approvedBy}` : ''}.</div>}
                <div className="flex flex-wrap gap-1.5">
                  {s.approval === 'sent' && <button className="btn btn-sm btn-primary" disabled={decide.isPending} onClick={() => decide.mutate({ ids: [s.id], action: 'approve' })}>Approve</button>}
                  <button className="btn btn-sm" onClick={() => setTap(dragItem(s))}>Move…</button>
                  {s.approval === 'sent' && <button className="btn btn-sm" disabled={decide.isPending} onClick={() => decide.mutate({ ids: [s.id], action: 'change', note: 'Not this week' })}>Not this week</button>}
                </div>
                {s.approval === 'sent' && <>
                  <label className="label !mb-0" htmlFor="pr-note">Note for the coordinator</label>
                  <input id="pr-note" className="input" maxLength={200} placeholder="e.g. after OP, around 5" value={note} onChange={(e) => setNote(e.target.value)} />
                  <button className="btn btn-sm" disabled={!note.trim() || decide.isPending} onClick={() => decide.mutate({ ids: [s.id], action: 'change', note: note.trim() })}>Ask for this change</button>
                </>}
              </> : <>
                <b className="text-[15px]">Looks fine?</b>
                <div className="text-[13px] text-muted">Approve all with the button at the top. Tap a sitting to see its course and change it; drag it to move it yourself.</div>
                {waiting.filter((x) => flag(x)).length > 0 && <div className="text-[13px] font-semibold text-rose">Needs a look: {waiting.filter((x) => flag(x)).map((x) => x.patient.fullName).join(', ')}.</div>}
              </>}
            </aside>
          </div>
        </div>)}
      {drag.ghost}
    </Modal>
  );
}
