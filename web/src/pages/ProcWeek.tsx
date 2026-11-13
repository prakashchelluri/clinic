import { useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useOutletContext, useSearchParams } from 'react-router';
import { get, patch, post, today, errText } from '../api';
import { can } from '../App';
import { Floating, Icon, Modal, Skeleton, ask, toast } from '../ui';
import { ScheduleModal } from './Worklist';
import { LoadError } from '../procBoard';
import { ProcedureDrawer } from '../procDrawer';
import { useBoxDrag, type DragItem } from '../procDrag';
import { refreshProcedures } from './ProcToday';
import { AssignDoctor, Block, Stub, addDay, fillsHour, hourLabel, inHour, lenText, longDay, movable, nowHHMM, placeOn, procHours, t12, toMin, dragItem } from '../procBlocks';

/** The Monday of a day's week. */
export const mondayOf = (d: string) => addDay(d, -((new Date(d + 'T00:00:00Z').getUTCDay() + 6) % 7));
const fmt = (d: string, o: Intl.DateTimeFormatOptions) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { ...o, timeZone: 'UTC' });
const rangeText = (mon: string) => { const sat = addDay(mon, 5);
  return mon.slice(5, 7) === sat.slice(5, 7) ? `${Number(mon.slice(8))} – ${fmt(sat, { day: 'numeric', month: 'short', year: 'numeric' })}` : `${fmt(mon, { day: 'numeric', month: 'short' })} – ${fmt(sat, { day: 'numeric', month: 'short', year: 'numeric' })}`; };

/** The month in the week picker: one row per week, Monday first; a row picks that week. */
function MiniCal({ mon, onPick }: { mon: string; onPick: (m: string) => void }) {
  const [ym, setYm] = useState(mon.slice(0, 7));
  const first = `${ym}-01`; const t = today();
  const weeks: string[] = []; for (let m = mondayOf(first); m.slice(0, 7) <= ym; m = addDay(m, 7)) weeks.push(m);
  const shift = (n: number) => { const d = new Date(first + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); setYm(d.toISOString().slice(0, 7)); };
  return (
    <div className="pw-cal">
      <div className="mb-2 flex items-center gap-1.5"><b className="flex-1 pl-1 text-[14.5px]">{fmt(first, { month: 'long', year: 'numeric' })}</b>
        <button type="button" className="btn btn-icon !h-8 !w-8" aria-label="Previous month" onClick={() => shift(-1)}><Icon name="chevL" className="h-4 w-4" /></button>
        <button type="button" className="btn btn-icon !h-8 !w-8" aria-label="Next month" onClick={() => shift(1)}><Icon name="chevR" className="h-4 w-4" /></button></div>
      <div className="row head" aria-hidden="true">{['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map((d) => <span key={d}>{d}</span>)}</div>
      {weeks.map((w) => (
        <button key={w} type="button" className={`row ${w === mon ? 'on' : ''}`} aria-label={`Week of ${fmt(w, { day: 'numeric', month: 'long' })}`} onClick={() => onPick(w)}>
          {Array.from({ length: 7 }, (_, i) => addDay(w, i)).map((d) => <span key={d} className={d === t ? 'today' : d.slice(0, 7) !== ym ? 'out' : ''}>{Number(d.slice(8))}</span>)}
        </button>))}
    </div>
  );
}

/**
 * The coordinator's week (v72), as a calendar by the hour: every sitting reception booked (tentative until approved), opening on next week.
 * Drag a sitting to another hour, or open it to move it to another day or week, change the doctor or cancel it. Send the week to
 * the doctors in one go; a sitting the doctor sends back stays booked with their note until it is moved. No unscheduled list:
 * sittings are always booked on a date, and courses not yet booked are on Calls.
 */
export function ProcWeek() {
  const { perms, cfg } = useOutletContext<any>();
  const [sp, setSp] = useSearchParams();
  const t = today();
  const mon = mondayOf(sp.get('week') ?? addDay(t, 7)); // next week unless one is picked
  const setMon = (m: string) => setSp((p) => { p.set('tab', 'week'); p.set('week', m); return p; }, { replace: true });
  const days = Array.from({ length: 6 }, (_, i) => addDay(mon, i));
  const canWrite = can(perms, 'worklist.write');
  const [calOpen, setCalOpen] = useState(false); const rangeBtn = useRef<HTMLButtonElement>(null);
  const [openId, setOpenId] = useState<string | null>(null); const [moving, setMoving] = useState<any>(null); const [assigning, setAssigning] = useState<any>(null);
  const [tap, setTap] = useState<DragItem | null>(null); const [review, setReview] = useState(false);
  const [landed, setLanded] = useState<string | null>(null);
  const land = (id: string) => { setLanded(id); setTimeout(() => setLanded(null), 700); };

  const q = useQuery({ queryKey: ['psessions', 'week', mon], queryFn: () => get(`/procedure-sessions?from=${mon}&to=${days[5]}&active=1`), refetchInterval: 20000 });
  const wk = useQuery({ queryKey: ['pweek', mon], queryFn: () => get(`/procedure-weeks/${mon}`) });
  const send = useMutation({ mutationFn: () => post(`/procedure-weeks/${mon}/send`), onSuccess: (r: any) => { setReview(false); refreshProcedures(); toast(`Sent ${r.sent} sitting${r.sent === 1 ? '' : 's'} for approval. From now on, a change in this week reaches the doctor straight away.`); }, onError: (e) => toast(errText(e), 'err') });
  const confirm = useMutation({ mutationFn: ({ id, confirmed }: any) => post(`/procedure-sessions/${id}/confirm`, { confirmed }), onSuccess: () => { refreshProcedures(); toast('Noted: the patient said yes', 'info'); }, onError: (e) => toast(errText(e), 'err') });

  const all: any[] = q.data ?? [];
  const docs = (cfg?.practitioners ?? []).filter((p: any) => p.active !== false);
  const procMin = (id: string) => cfg?.procedures?.find((p: any) => p.id === id)?.typicalMinutes ?? 30;
  const away = (s: any, d: string) => (wk.data?.away ?? []).some((a: any) => a.practitionerId === s.practitionerId && a.day === d);
  const awayDays = new Set((wk.data?.away ?? []).map((a: any) => `${a.day}`));
  const now = nowHHMM(); const nowMin = toMin(now);
  const pastCell = (d: string, h: number) => d < t || (d === t && (h + 1) * 60 <= nowMin);
  const hours = procHours(all);

  const findSit = (id: string) => all.find((s) => s.id === id);
  const check = (item: DragItem, key: string) => {
    const s = findSit(item.id);
    if (!key.startsWith('W|')) return 'nowhere';
    const [, d, hs] = key.split('|'); const h = Number(hs);
    if (s && s.day === d && Number(s.startTime.slice(0, 2)) === h) return 'same';
    if (pastCell(d, h)) return 'that hour is past';
    if (s && away(s, d)) return `${s.doctor ?? 'the doctor'} is away`;
    return '';
  };
  const dropOn = async (item: DragItem, key: string) => {
    setTap(null);
    const s = findSit(item.id);
    const [, d, hs] = key.split('|');
    if (!s) return;
    const r = await placeOn({ sittingId: s.id, day: d, hour: Number(hs) });
    if (!r) return;
    refreshProcedures(); land(r.id);
    toast(`${item.title}: ${longDay(r.day)}, ${t12(r.startTime)}–${t12(r.endTime)}${r.approval === 'draft' ? '. Send the week when it is ready.' : r.approval === 'sent' ? `. ${r.changed ? 'The doctor sees the change now.' : 'With the doctor to approve.'}` : '.'}`);
  };
  const drag = useBoxDrag(check, dropOn);
  const lifted = drag.liftedId;

  // what the week holds, and the Send review
  const booked = all.filter((s) => s.state === 'confirmed');
  const n = (a: string) => booked.filter((s) => s.approval === a).length;
  const drafts = booked.filter((s) => s.approval === 'draft');
  const byDoc = [...new Set(drafts.map((s) => s.doctor ?? 'No doctor'))].map((name) => ({ name, list: drafts.filter((s) => (s.doctor ?? 'No doctor') === name) }));
  const asked = booked.filter((s) => s.approval === 'change');
  const summary = !all.length ? 'Nothing booked this week yet' : [n('draft') && `${n('draft')} tentative`, n('sent') && `${n('sent')} with the doctor`, n('change') && `${n('change')} sent back`, n('approved') && `${n('approved')} approved`, all.filter((s: any) => s.autoBooked).length && `${all.filter((s: any) => s.autoBooked).length} booked by the plan, confirm with the patient`].filter(Boolean).join(' · ');
  const tapOk = (key: string) => !!tap && !check(tap, key);

  const opened = all.find((s) => s.id === openId);
  const act = (label: string, run: () => void, primary = false) => <button className={`btn btn-sm ${primary ? 'btn-primary' : ''}`} onClick={run}>{label}</button>;
  const actions = (s: any) => canWrite && s.state === 'confirmed' && s.day >= t ? <>
    {act('Move to another hour', () => { setOpenId(null); setTap(dragItem(s)); }, true)}
    {act('Reschedule…', () => { setOpenId(null); setMoving(s); })}
    {act(s.practitionerId ? 'Change doctor' : 'Pick doctor', () => { setOpenId(null); setAssigning(s); })}
    {s.approval === 'approved' && act(s.patientConfirmedAt ? 'Undo: patient said yes' : 'Patient said yes', () => confirm.mutate({ id: s.id, confirmed: !s.patientConfirmedAt }))}
    {act('Cancel sitting', async () => { if (await ask({ title: 'Cancel this sitting?', body: `${s.patient.fullName} · ${s.procedure ?? 'procedure'} on ${longDay(s.day)} ${t12(s.startTime)}. The course goes back to the desk to book another date.`, confirmLabel: 'Cancel sitting', cancelLabel: 'Keep it', tone: 'danger' })) { setOpenId(null); await patch(`/procedure-sessions/${s.id}`, { state: 'cancelled', reason: 'Cancelled from the week plan' }).then(() => toast(`${s.patient.fullName}'s sitting is cancelled.`), (e) => toast(errText(e), 'err')); refreshProcedures(); } })}
  </> : null;

  return (
    <div className="space-y-3">
      {tap && <div className="flex items-center gap-3 rounded-2xl bg-clay-soft px-4 py-2.5 text-[14px] font-semibold text-clay-ink anim-fade-up"><span className="flex-1">Scheduling {tap.title}: tap Free on an hour.</span><button className="btn btn-sm" onClick={() => setTap(null)}>Stop</button></div>}
      {asked.length > 0 && <div className="rounded-[10px] bg-rose-soft px-4 py-2.5 text-[13.5px] text-rose" role="status"><b>{asked.length} sent back by the doctor:</b> {asked.map((x) => `${x.patient.fullName} (${x.approvalNote ?? 'change asked'})`).join('; ')}. Open one to move or cancel it; a move reaches the doctor straight away.</div>}

      <div>
        <section className="fd-sheet fd-sch overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 px-4 py-3">
            <button type="button" className="btn btn-icon !h-8 !w-8" aria-label="Previous week" onClick={() => setMon(addDay(mon, -7))}><Icon name="chevL" className="h-4 w-4" /></button>
            <button ref={rangeBtn} type="button" className="pw-range" aria-haspopup="dialog" aria-expanded={calOpen} onClick={() => setCalOpen(!calOpen)}>{mon === addDay(mondayOf(t), 7) ? 'Next week · ' : mon === mondayOf(t) ? 'This week · ' : ''}{rangeText(mon)}<Icon name="chevR" className="h-3.5 w-3.5 rotate-90 opacity-60" /></button>
            <button type="button" className="btn btn-icon !h-8 !w-8" aria-label="Next week" onClick={() => setMon(addDay(mon, 7))}><Icon name="chevR" className="h-4 w-4" /></button>
            {mon !== mondayOf(t) && <button type="button" className="btn btn-sm" onClick={() => setMon(mondayOf(t))}>This week</button>}
            <Floating anchor={rangeBtn} open={calOpen} onClose={() => setCalOpen(false)} width={292} align="left"><MiniCal mon={mon} onPick={(m) => { setMon(m); setCalOpen(false); }} /></Floating>
            <span className="ml-auto text-[13.5px] text-muted">{summary}{wk.data?.sent && !n('draft') && all.length > 0 && mon > mondayOf(t) ? ' · changes reach the doctor straight away' : ''}</span>
            {canWrite && drafts.length > 0 && <button type="button" className="btn btn-primary" onClick={() => setReview(true)}>Send {drafts.length} to the doctor</button>}
          </div>
          {q.isLoading ? <div className="p-4"><Skeleton rows={6} /></div> : q.isError && !q.data ? <div className="p-4"><LoadError onRetry={() => q.refetch()} /></div> : (
            <div className="overflow-x-auto">
              <div className="pw-week">
                <span className="hd" style={{ borderLeft: 0 }} />
                {days.map((d) => <span key={d} className={`hd ${d === t ? 'today' : ''}`}>{fmt(d, { weekday: 'short', day: 'numeric', month: 'short' })}
                  <small className={awayDays.has(d) ? 'red' : ''}>{d === t ? 'today' : awayDays.has(d) ? `${docs.filter((p: any) => (wk.data?.away ?? []).some((a: any) => a.day === d && a.practitionerId === p.id)).map((p: any) => p.name).join(', ')} away` : ' '}</small></span>)}
                {hours.map((h) => [
                  <span key={`t${h}`} className="t">{hourLabel(h)}</span>,
                  ...days.map((d) => {
                    const key = `W|${d}|${h}`; const list = all.filter((s) => s.day === d);
                    const here = inHour(list, h); const fill = fillsHour(list, h); const why = drag.hoverWhy(key);
                    return (
                      <div key={key} className={`c ${drag.cellCls(key) || (tap ? (tapOk(key) ? 'pw-can' : 'pw-cant') : pastCell(d, h) ? 'past' : awayDays.has(d) ? 'away' : '')}`} data-cell={key}>
                        {fill.map((s) => <Stub key={s.id} s={s} />)}
                        {here.map((s) => <Block key={s.id} s={s} week cls={`${openId === s.id ? 'sel' : ''} ${lifted === s.id || tap?.id === s.id ? 'lifted' : ''} ${landed === s.id ? 'landed' : ''}`}
                          onDown={canWrite && movable(s, t) ? (e) => drag.start(e, dragItem(s)) : undefined} onClick={() => { if (!drag.wasDrag()) setOpenId(s.id); }} />)}
                        {why && why !== 'same' && <span className="pw-why">{why}</span>}
                        {lifted && drag.cellCls(key) === 'pw-hov-ok' && <span className="pw-drop">Drop here</span>}
                        {tap && tapOk(key) && <button type="button" className="pw-put" onClick={() => dropOn(tap, key)}>Free</button>}
                        {!tap && !lifted && !here.length && !fill.length && !pastCell(d, h) && !awayDays.has(d) && <span className="pw-free">Free</span>}
                      </div>);
                  }),
                ])}
              </div>
            </div>)}
        </section>
      </div>
      {drag.ghost}

      {review && <Modal title="Send for doctor approval?" subtitle={`Week of ${rangeText(mon)}`} onClose={() => setReview(false)} width="max-w-lg">
        <div className="space-y-3">
          {byDoc.map((d) => (
            <div key={d.name} className="flex gap-4 border-t border-line pt-3 first:border-t-0 first:pt-0">
              <span className="min-w-[34px] text-right text-[26px] font-extrabold leading-none">{d.list.length}</span>
              <span className="min-w-0 flex-1"><b className="text-[15px]">{d.name}</b><span className="block text-[13px] text-muted">{d.list.map((s) => `${s.patient.fullName} (${fmt(s.day, { weekday: 'short' })} ${t12(s.startTime)})`).join(', ')}</span></span>
            </div>))}
          <div className="text-[13px] text-muted">Each doctor sees only their own sittings, on Today under “Needs your attention”. After this, any change you make in this week reaches the doctor straight away.</div>
          <div className="modal-foot"><button className="btn btn-ghost" onClick={() => setReview(false)}>Back</button>
            <button className="btn btn-primary" disabled={send.isPending} onClick={() => send.mutate()}><Icon name="check" />{byDoc.length > 1 ? `Send to ${byDoc.length} doctors` : `Send to ${byDoc[0]?.name ?? 'the doctor'}`}</button></div>
        </div>
      </Modal>}
      {opened && <ProcedureDrawer id={opened.id} canAct={canWrite} extra={actions(opened)} onClose={() => setOpenId(null)} />}
      {moving && <ScheduleModal rec={{ id: moving.recommendationId, procedureId: moving.procedureId, patient: { fullName: moving.patient.fullName, phone: moving.patient.phone }, sittings: moving.of }} sitting={moving} onClose={() => { setMoving(null); refreshProcedures(); }} />}
      {assigning && <AssignDoctor s={assigning} docs={docs} onClose={() => { setAssigning(null); refreshProcedures(); }} />}
    </div>
  );
}
