import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useOutletContext, useSearchParams } from 'react-router';
import { get, patch, post, qc, today, errText } from '../api';
import { can } from '../App';
import { Empty, Icon, Skeleton, ask, toast } from '../ui';
import { ScheduleModal } from './Worklist';
import { LoadError } from '../procBoard';
import { ProcedureDrawer } from '../procDrawer';
import { useBoxDrag } from '../procDrag';
import { AssignDoctor, Block, Stub, addDay, dragItem, fillsHour, hourLabel, inHour, longDay, movable, nowHHMM, placeOn, procHours, t12 } from '../procBlocks';

export const refreshProcedures = () => ['psessions', 'pcounts', 'calendar', 'worklist', 'psessions-upcoming', 'procedure-session', 'pweek', 'followups'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));

/**
 * Today's sittings by the hour: each block says who, what, which doctor and which room. A block opens the procedure drawer
 * (Start, Mark done, the patient's yes, change doctor, reschedule); dragging a block to another hour moves it there.
 */
export function ProcToday() {
  const { perms, cfg } = useOutletContext<any>();
  const [sp, setSp] = useSearchParams();
  const t = today();
  const day = sp.get('day') ?? t;
  const setDay = (d: string) => setSp((p) => { p.set('tab', 'today'); p.set('day', d); return p; }, { replace: true });
  const [openId, setOpenId] = useState<string | null>(null);
  const [moving, setMoving] = useState<any>(null); const [assigning, setAssigning] = useState<any>(null);
  const [landed, setLanded] = useState<string | null>(null);
  const canWrite = can(perms, 'worklist.write');

  const q = useQuery({ queryKey: ['psessions', 'day', day], queryFn: () => get(`/procedure-sessions?day=${day}&active=1&detail=1`), refetchInterval: 15000 });
  const DONE: Record<string, string> = { in_progress: 'Session started', completed: 'Marked done', missed: 'Moved to missed', cancelled: 'Session cancelled' };
  const setState = useMutation({ mutationFn: ({ id, ...b }: any) => patch(`/procedure-sessions/${id}`, b), onSuccess: (_r, v: any) => { refreshProcedures(); toast(DONE[v.state] ?? 'Updated'); }, onError: (e) => toast(errText(e), 'err') });
  const confirm = useMutation({ mutationFn: ({ id, confirmed }: any) => post(`/procedure-sessions/${id}/confirm`, { confirmed }), onSuccess: (_r, v: any) => { refreshProcedures(); toast(v.confirmed ? 'Noted: the patient said yes' : 'Patient answer removed', 'info'); }, onError: (e) => toast(errText(e), 'err') });

  const all: any[] = q.data ?? [];
  const docs = (cfg?.practitioners ?? []).filter((p: any) => p.active !== false);
  const now = nowHHMM(); const nowH = day === t ? Number(now.slice(0, 2)) : -1;
  const past = (h: number) => day < t || (day === t && (h + 1) * 60 <= Number(now.slice(0, 2)) * 60 + Number(now.slice(3, 5)));
  const hours = procHours(all);
  const live = all.filter((s) => ['confirmed', 'in_progress'].includes(s.state));
  const notYes = live.filter((s) => s.state === 'confirmed' && s.approval === 'approved' && !s.patientConfirmedAt).length;

  const drag = useBoxDrag((item, key) => {
    const s = all.find((x) => x.id === item.id); const h = Number(key.slice(2));
    if (!s || !key.startsWith('T|')) return 'nowhere';
    if (Number(s.startTime.slice(0, 2)) === h) return 'same';
    return past(h) ? 'that hour is past' : '';
  }, async (item, key) => {
    const r = await placeOn({ sittingId: item.id, day, hour: Number(key.slice(2)) });
    if (r) { refreshProcedures(); setLanded(item.id); setTimeout(() => setLanded(null), 700); toast(`${item.title} moved to ${t12(r.startTime)}${r.approval === 'approved' ? '' : ': the doctor sees the change'}`); }
  });

  const opened = all.find((s) => s.id === openId);
  const act = (label: string, run: () => void, primary = false) => <button className={`btn btn-sm ${primary ? 'btn-primary' : ''}`} onClick={run}>{label}</button>;
  const actions = (s: any) => canWrite && s.state === 'confirmed' ? <>
    {s.approval === 'approved' && act(s.patientConfirmedAt ? 'Undo: patient said yes' : 'Patient said yes', () => confirm.mutate({ id: s.id, confirmed: !s.patientConfirmedAt }))}
    {act(s.practitionerId ? 'Change doctor' : 'Pick doctor', () => { setOpenId(null); setAssigning(s); })}
    {act('Reschedule', () => { setOpenId(null); setMoving(s); })}
    {act('Mark as missed', async () => { if (await ask({ title: 'Mark this session as missed?', body: `${s.patient.fullName} · ${s.procedure ?? 'procedure'} at ${s.startTime}. The room is freed.`, confirmLabel: 'Mark missed', cancelLabel: 'Keep it' })) { setOpenId(null); setState.mutate({ id: s.id, state: 'missed' }); } })}
    {act('Cancel session', async () => { const a = await ask({ title: 'Cancel this session?', body: `${s.patient.fullName} · ${s.procedure ?? 'procedure'} at ${s.startTime}. The room and doctor are freed and the course goes back to Pending schedules.`, confirmLabel: 'Cancel session', cancelLabel: 'Keep it', field: { label: 'Reason', maxLength: 200 } }); if (a) { setOpenId(null); setState.mutate({ id: s.id, state: 'cancelled', reason: a.value || undefined }); } })}
  </> : canWrite && s.state === 'missed' ? act('Reschedule', () => { setOpenId(null); setMoving(s); }, true) : null;

  return (
    <div className="fd-sheet fd-sch overflow-hidden anim-fade-up">
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <button type="button" className="btn btn-icon !h-8 !w-8" aria-label="Previous day" onClick={() => setDay(addDay(day, -1))}><Icon name="chevL" className="h-4 w-4" /></button>
        <label className="fd-sch-date"><span>{day === t ? `Today · ${longDay(day)}` : day === addDay(t, 1) ? `Tomorrow · ${longDay(day)}` : longDay(day)}</span><input type="date" aria-label="Pick a day" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} /></label>
        <button type="button" className="btn btn-icon !h-8 !w-8" aria-label="Next day" onClick={() => setDay(addDay(day, 1))}><Icon name="chevR" className="h-4 w-4" /></button>
        {day !== t && <button type="button" className="btn btn-sm" onClick={() => setDay(t)}>Today</button>}
        <span className="ml-auto text-[13.5px] text-muted">{live.length ? `${live.length} session${live.length === 1 ? '' : 's'}${notYes ? ` · ${notYes} not confirmed` : ''}` : ''}</span>
      </div>
      {q.isLoading ? <div className="p-4"><Skeleton rows={4} /></div> : q.isError && !q.data ? <div className="p-4"><LoadError onRetry={() => q.refetch()} /></div>
        : !all.length ? <div className="border-t border-line"><Empty icon="calendar" title={day === t ? 'No sessions today' : 'No sessions this day'} hint="Sessions are planned on Week plan." /></div> : (
        hours.map((h) => {
          const key = `T|${h}`; const here = inHour(all, h); const fill = fillsHour(all, h);
          const why = drag.hoverWhy(key);
          return (
            <div key={h} className={`pw-row ${h === nowH ? 'now' : ''} ${past(h) ? 'past' : ''}`}>
              <span className="t">{hourLabel(h)}{h === nowH && <small>now {t12(now)}</small>}</span>
              <div className={`pw-slots ${drag.cellCls(key)}`} data-cell={key}>
                {fill.map((s) => <Stub key={s.id} s={s} />)}
                {here.map((s) => <Block key={s.id} s={s} cls={`${openId === s.id ? 'sel' : ''} ${drag.liftedId === s.id ? 'lifted' : ''} ${landed === s.id ? 'landed' : ''}`}
                  onDown={canWrite && movable(s, t) ? (e) => drag.start(e, dragItem(s)) : undefined} onClick={() => { if (!drag.wasDrag()) setOpenId(s.id); }} />)}
                {!here.length && !fill.length && !drag.liftedId && <span className="pw-free">Free</span>}
                {why && why !== 'same' && <span className="pw-why self-center">{why}</span>}
                {drag.liftedId && !why && drag.cellCls(key) === 'pw-hov-ok' && <span className="pw-drop self-center">Drop here</span>}
              </div>
            </div>);
        }))}
      {drag.ghost}
      {opened && <ProcedureDrawer id={opened.id} canAct={canWrite} extra={actions(opened)} onClose={() => setOpenId(null)} />}
      {moving && <ScheduleModal rec={{ id: moving.recommendationId, procedureId: moving.procedureId, patient: { fullName: moving.patient.fullName, phone: moving.patient.phone }, sittings: moving.of }} sitting={moving} onClose={() => { setMoving(null); refreshProcedures(); }} />}
      {assigning && <AssignDoctor s={assigning} docs={docs} onClose={() => { setAssigning(null); refreshProcedures(); }} />}
    </div>
  );
}
