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
 * The coordinator's week: Pending schedules on the left (courses waiting for their next sitting), the week by the hour on the right.
 * Drag a course onto an hour to book it there, drag a sitting to move it, drag it back to Pending schedules to unschedule it.
 * Drafts go to the doctors with one Send; after that, changes in the week reach the doctor straight away.
 */
export function ProcWeek() {
  const { perms, cfg } = useOutletContext<any>();
  const [sp, setSp] = useSearchParams();
  const t = today();
  const mon = mondayOf(sp.get('week') ?? t);
  const setMon = (m: string) => setSp((p) => { p.set('tab', 'week'); p.set('week', m); return p; }, { replace: true });
  const days = Array.from({ length: 6 }, (_, i) => addDay(mon, i));
  const canWrite = can(perms, 'worklist.write');
  const [calOpen, setCalOpen] = useState(false); const rangeBtn = useRef<HTMLButtonElement>(null);
  const [openId, setOpenId] = useState<string | null>(null); const [moving, setMoving] = useState<any>(null); const [assigning, setAssigning] = useState<any>(null);
  const [tap, setTap] = useState<DragItem | null>(null); const [review, setReview] = useState(false);
  const [landed, setLanded] = useState<string | null>(null);
  const land = (id: string) => { setLanded(id); setTimeout(() => setLanded(null), 700); };

  const q = useQuery({ queryKey: ['psessions', 'week', mon], queryFn: () => get(`/procedure-sessions?from=${mon}&to=${days[5]}&active=1`), refetchInterval: 20000 });
  const plans = useQuery({ queryKey: ['worklist', 'procedure'], queryFn: () => get('/worklist?kind=procedure'), refetchInterval: 20000 });
  const wk = useQuery({ queryKey: ['pweek', mon], queryFn: () => get(`/procedure-weeks/${mon}`) });
  const send = useMutation({ mutationFn: () => post(`/procedure-weeks/${mon}/send`), onSuccess: (r: any) => { setReview(false); refreshProcedures(); toast(`Sent ${r.sent} sitting${r.sent === 1 ? '' : 's'} for approval. From now on, a change in this week reaches the doctor straight away.`); }, onError: (e) => toast(errText(e), 'err') });
  const confirm = useMutation({ mutationFn: ({ id, confirmed }: any) => post(`/procedure-sessions/${id}/confirm`, { confirmed }), onSuccess: () => { refreshProcedures(); toast('Noted: the patient said yes', 'info'); }, onError: (e) => toast(errText(e), 'err') });

  const all: any[] = q.data ?? [];
  const docs = (cfg?.practitioners ?? []).filter((p: any) => p.active !== false);
  const procMin = (id: string) => cfg?.procedures?.find((p: any) => p.id === id)?.typicalMinutes ?? 30;
  const pending: any[] = (plans.data ?? []).filter((r: any) => !r.next && !['done', 'cancelled'].includes(r.status) && (!r.sittings || r.done < r.sittings));
  const away = (s: any, d: string) => (wk.data?.away ?? []).some((a: any) => a.practitionerId === s.practitionerId && a.day === d);
  const awayDays = new Set((wk.data?.away ?? []).map((a: any) => `${a.day}`));
  const now = nowHHMM(); const nowMin = toMin(now);
  const pastCell = (d: string, h: number) => d < t || (d === t && (h + 1) * 60 <= nowMin);
  const hours = procHours(all);

  const findSit = (id: string) => all.find((s) => s.id === id);
  const check = (item: DragItem, key: string) => {
    const s = findSit(item.id);
    if (key === 'PENDING') return s ? '' : 'nowhere';
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
    if (key === 'PENDING') {
      if (!s) return;
      await patch(`/procedure-sessions/${s.id}`, { state: 'cancelled', reason: 'Unscheduled' }).then(() => toast(`${s.patient.fullName} is back in Pending schedules${s.approval === 'draft' ? '' : `; ${s.doctor ?? 'the doctor'} sees it gone`}.`), (e) => toast(errText(e), 'err'));
      refreshProcedures(); return;
    }
    const [, d, hs] = key.split('|');
    const r = await placeOn(s ? { sittingId: s.id, day: d, hour: Number(hs) } : { recommendationId: item.id, day: d, hour: Number(hs) });
    if (!r) return;
    refreshProcedures(); land(r.id);
    toast(`${item.title}: ${longDay(r.day)}, ${t12(r.startTime)}–${t12(r.endTime)}${r.approval === 'draft' ? '. Send the week when it is ready.' : r.approval === 'sent' ? `. ${r.changed ? 'The doctor sees the change now.' : 'With the doctor to approve.'}` : '.'}`);
  };
  const drag = useBoxDrag(check, dropOn);
  const lifted = drag.liftedId;
  const planItem = (r: any): DragItem => ({ id: r.id, title: r.patient.fullName, sub: `${r.procedure ?? 'Procedure'} · ${lenText(procMin(r.procedureId))}`, where: `sitting ${(r.done ?? 0) + 1}${r.sittings ? ` of ${r.sittings}` : ''}` });

  // what the week holds, and the Send review
  const booked = all.filter((s) => s.state === 'confirmed');
  const n = (a: string) => booked.filter((s) => s.approval === a).length;
  const drafts = booked.filter((s) => s.approval === 'draft');
  const byDoc = [...new Set(drafts.map((s) => s.doctor ?? 'No doctor'))].map((name) => ({ name, list: drafts.filter((s) => (s.doctor ?? 'No doctor') === name) }));
  const asked = booked.filter((s) => s.approval === 'change');
  const summary = !all.length ? 'Nothing scheduled this week yet' : [n('draft') && `${n('draft')} not sent`, n('sent') && `${n('sent')} with the doctor`, n('change') && `${n('change')} change asked`, n('approved') && `${n('approved')} approved`].filter(Boolean).join(' · ');
  const tapOk = (key: string) => !!tap && !check(tap, key);

  const opened = all.find((s) => s.id === openId);
  const act = (label: string, run: () => void, primary = false) => <button className={`btn btn-sm ${primary ? 'btn-primary' : ''}`} onClick={run}>{label}</button>;
  const actions = (s: any) => canWrite && s.state === 'confirmed' && s.day >= t ? <>
    {act('Move to another hour', () => { setOpenId(null); setTap(dragItem(s)); }, true)}
    {act('Reschedule…', () => { setOpenId(null); setMoving(s); })}
    {act(s.practitionerId ? 'Change doctor' : 'Pick doctor', () => { setOpenId(null); setAssigning(s); })}
    {s.approval === 'approved' && act(s.patientConfirmedAt ? 'Undo: patient said yes' : 'Patient said yes', () => confirm.mutate({ id: s.id, confirmed: !s.patientConfirmedAt }))}
    {act('Unschedule', async () => { if (await ask({ title: 'Unschedule this sitting?', body: `${s.patient.fullName} · ${s.procedure ?? 'procedure'} on ${longDay(s.day)} ${t12(s.startTime)}. The course goes back to Pending schedules.`, confirmLabel: 'Unschedule', cancelLabel: 'Keep it' })) { setOpenId(null); dropOn(dragItem(s), 'PENDING'); } })}
  </> : null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-sm" onClick={() => setMon(mondayOf(t))} disabled={mon === mondayOf(t)}>This week</button>
        <button type="button" className="btn btn-icon !h-8 !w-8" aria-label="Previous week" onClick={() => setMon(addDay(mon, -7))}><Icon name="chevL" className="h-4 w-4" /></button>
        <button type="button" className="btn btn-icon !h-8 !w-8" aria-label="Next week" onClick={() => setMon(addDay(mon, 7))}><Icon name="chevR" className="h-4 w-4" /></button>
        <button ref={rangeBtn} type="button" className="pw-range" aria-haspopup="dialog" aria-expanded={calOpen} onClick={() => setCalOpen(!calOpen)}>{rangeText(mon)}<Icon name="chevR" className="h-3.5 w-3.5 rotate-90 opacity-60" /></button>
        <Floating anchor={rangeBtn} open={calOpen} onClose={() => setCalOpen(false)} width={292} align="left"><MiniCal mon={mon} onPick={(m) => { setMon(m); setCalOpen(false); }} /></Floating>
        <span className="ml-auto text-[13.5px] text-muted">{summary}{wk.data?.sent && !n('draft') && all.length > 0 && mon > mondayOf(t) ? ' · changes reach the doctor straight away' : ''}</span>
        {canWrite && drafts.length > 0 && <button type="button" className="btn btn-primary" onClick={() => setReview(true)}>Send for doctor approval</button>}
      </div>
      {tap && <div className="flex items-center gap-3 rounded-2xl bg-clay-soft px-4 py-2.5 text-[14px] font-semibold text-clay-ink anim-fade-up"><span className="flex-1">Scheduling {tap.title}: tap Free on an hour.</span><button className="btn btn-sm" onClick={() => setTap(null)}>Stop</button></div>}

      <div className="grid items-start gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
        {/* Pending schedules: also where a sitting is dropped to unschedule it */}
        <section className={`fd-sheet overflow-hidden ${lifted && findSit(lifted) ? (drag.cellCls('PENDING') === 'pw-hov-ok' ? 'pw-pend-hov' : 'pw-pend-can') : ''}`} data-cell="PENDING">
          <div className="px-4 pb-2.5 pt-3.5"><b className="text-[15px]">Pending schedules{pending.length ? ` · ${pending.length}` : ''}</b>
            <span className="block text-[12.5px] text-muted">{lifted && findSit(lifted) ? 'Drop here to unschedule' : 'Drag one onto the week, or tap Schedule.'}</span></div>
          {plans.isLoading ? <div className="px-4 pb-4"><Skeleton rows={3} /></div> : plans.isError && !plans.data ? <div className="px-4 pb-4"><LoadError onRetry={() => plans.refetch()} /></div>
            : !pending.length ? (
              <div className="flex flex-col items-center gap-2 px-5 pb-7 pt-4 text-center">
                <svg width="56" height="56" viewBox="0 0 56 56" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="text-line-2">
                  <rect x="9" y="12" width="38" height="34" rx="6" /><path d="M9 21h38M19 8v8M37 8v8" /><path d="M21 33l5 5 9-10" className="text-clay-line" stroke="currentColor" strokeWidth="2" /></svg>
                <b className="text-[14.5px]">All scheduled</b><span className="text-[12.5px] text-muted">New plans from the doctor, and missed or unscheduled sittings, show up here.</span>
              </div>)
            : pending.map((r) => {
              const late = r.dueOn && r.dueOn < t; const item = planItem(r);
              const fresh = r.status === 'open' && !r.done && new Date(r.createdAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) === t;
              return (
                <div key={r.id} className={`pw-q ${lifted === r.id || tap?.id === r.id ? 'lifted' : ''} ${landed === r.id ? 'landed' : ''}`} onPointerDown={(e) => { if (canWrite && !(e.target as HTMLElement).closest('button')) drag.start(e, item); }}>
                  <span className="min-w-0 flex-1"><b className="block truncate text-[14.5px]">{r.patient.fullName}</b>
                    <span className="block truncate text-[12.5px] text-muted">{item.sub} · {item.where}</span>
                    <span className={`block truncate text-[12.5px] ${late ? 'font-semibold text-rose' : 'text-muted'}`}>{fresh ? 'New, prescribed today' : r.dueOn ? `${late ? 'Overdue since' : 'Due'} ${fmt(r.dueOn, { weekday: 'short', day: 'numeric', month: 'short' })}` : 'No date set'}</span></span>
                  {canWrite && <button type="button" className="btn btn-sm shrink-0" onClick={() => setTap(item)}>Schedule</button>}
                </div>);
            })}
        </section>

        <section className="fd-sheet overflow-hidden">
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
          {asked.length > 0 && <div className="text-[13px] font-semibold text-rose">Still with you: {asked.map((s) => `${s.patient.fullName}, ${s.approvalNote ?? 'change asked'}`).join('; ')}. Move it and it goes back to the doctor.</div>}
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
