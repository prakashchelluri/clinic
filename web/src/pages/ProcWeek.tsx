import { useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useOutletContext, useSearchParams } from 'react-router';
import { get, patch, post, today, errText } from '../api';
import { can } from '../App';
import { Chip, Floating, Icon, Modal, Skeleton, ask, toast } from '../ui';
import { ScheduleModal } from './Worklist';
import { LoadError } from '../procBoard';
import { ProcedureDrawer } from '../procDrawer';
import { refreshProcedures } from './ProcToday';
import { AssignDoctor, addDay, longDay, t12 } from '../procBlocks';

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

/** How a sitting stands with the doctor, in the words the desk uses. */
export const APPROVAL: Record<string, { label: string; tone: '' | 'sky' | 'sage' | 'rose' }> = {
  draft: { label: 'Tentative', tone: '' }, sent: { label: 'With the doctor', tone: 'sky' }, change: { label: 'Sent back', tone: 'rose' }, approved: { label: 'Approved', tone: 'sage' },
};

/**
 * The coordinator's week (v71): every sitting booked for the week, day by day, with where it stands with the doctor.
 * Reception books each sitting on a date (tentative); here the coordinator reviews next week, moves what needs moving and
 * sends it to the doctors in one go. A sitting the doctor sends back stays booked with their note until it is moved.
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
  const [review, setReview] = useState(false);

  const q = useQuery({ queryKey: ['psessions', 'week', mon], queryFn: () => get(`/procedure-sessions?from=${mon}&to=${days[5]}&active=1`), refetchInterval: 20000 });
  const wk = useQuery({ queryKey: ['pweek', mon], queryFn: () => get(`/procedure-weeks/${mon}`) });
  const send = useMutation({ mutationFn: () => post(`/procedure-weeks/${mon}/send`), onSuccess: (r: any) => { setReview(false); refreshProcedures(); toast(`Sent ${r.sent} sitting${r.sent === 1 ? '' : 's'} to the doctor for approval. A change in this week now reaches the doctor straight away.`); }, onError: (e) => toast(errText(e), 'err') });
  const confirm = useMutation({ mutationFn: ({ id, confirmed }: any) => post(`/procedure-sessions/${id}/confirm`, { confirmed }), onSuccess: () => { refreshProcedures(); toast('Noted: the patient said yes', 'info'); }, onError: (e) => toast(errText(e), 'err') });
  const cancel = async (s: any) => {
    if (!(await ask({ title: 'Cancel this sitting?', body: `${s.patient.fullName} · ${s.procedure ?? 'procedure'} on ${longDay(s.day)} ${t12(s.startTime)}. The course goes back to the desk to book another date.`, confirmLabel: 'Cancel sitting', cancelLabel: 'Keep it', tone: 'danger' }))) return;
    await patch(`/procedure-sessions/${s.id}`, { state: 'cancelled', reason: 'Cancelled from the week plan' }).then(() => toast(`${s.patient.fullName}'s sitting is cancelled.`), (e) => toast(errText(e), 'err'));
    setOpenId(null); refreshProcedures();
  };

  const all: any[] = (q.data ?? []).filter((s: any) => !['cancelled', 'postponed'].includes(s.state));
  const docs = (cfg?.practitioners ?? []).filter((p: any) => p.active !== false);
  const awayOn = (s: any) => (wk.data?.away ?? []).some((a: any) => a.practitionerId === s.practitionerId && a.day === s.day);
  const booked = all.filter((s) => s.state === 'confirmed');
  const n = (a: string) => booked.filter((s) => s.approval === a).length;
  const drafts = booked.filter((s) => s.approval === 'draft');
  const byDoc = [...new Set(drafts.map((s) => s.doctor ?? 'No doctor'))].map((name) => ({ name, list: drafts.filter((s) => (s.doctor ?? 'No doctor') === name) }));
  const asked = booked.filter((s) => s.approval === 'change');
  const summary = !all.length ? 'Nothing booked this week' : [n('draft') && `${n('draft')} tentative`, n('sent') && `${n('sent')} with the doctor`, n('change') && `${n('change')} sent back`, n('approved') && `${n('approved')} approved`].filter(Boolean).join(' · ');
  const opened = all.find((s) => s.id === openId);
  const actions = (s: any) => canWrite && s.state === 'confirmed' && s.day >= t ? <>
    <button className="btn btn-sm btn-primary" onClick={() => { setOpenId(null); setMoving(s); }}>Move</button>
    <button className="btn btn-sm" onClick={() => { setOpenId(null); setAssigning(s); }}>{s.practitionerId ? 'Change doctor' : 'Pick doctor'}</button>
    {s.approval === 'approved' && <button className="btn btn-sm" onClick={() => confirm.mutate({ id: s.id, confirmed: !s.patientConfirmedAt })}>{s.patientConfirmedAt ? 'Undo: patient said yes' : 'Patient said yes'}</button>}
    <button className="btn btn-sm text-rose" onClick={() => cancel(s)}>Cancel sitting</button>
  </> : null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-icon !h-8 !w-8" aria-label="Previous week" onClick={() => setMon(addDay(mon, -7))}><Icon name="chevL" className="h-4 w-4" /></button>
        <button ref={rangeBtn} type="button" className="pw-range" aria-haspopup="dialog" aria-expanded={calOpen} onClick={() => setCalOpen(!calOpen)}>{mon === addDay(mondayOf(t), 7) ? 'Next week · ' : mon === mondayOf(t) ? 'This week · ' : ''}{rangeText(mon)}<Icon name="chevR" className="h-3.5 w-3.5 rotate-90 opacity-60" /></button>
        <button type="button" className="btn btn-icon !h-8 !w-8" aria-label="Next week" onClick={() => setMon(addDay(mon, 7))}><Icon name="chevR" className="h-4 w-4" /></button>
        <Floating anchor={rangeBtn} open={calOpen} onClose={() => setCalOpen(false)} width={292} align="left"><MiniCal mon={mon} onPick={(m) => { setMon(m); setCalOpen(false); }} /></Floating>
        <span className="ml-auto text-[13.5px] text-muted">{summary}</span>
        {canWrite && drafts.length > 0 && <button type="button" className="btn btn-primary" onClick={() => setReview(true)}>Send {drafts.length} to the doctor</button>}
      </div>
      {asked.length > 0 && <div className="rounded-[10px] bg-rose-soft px-4 py-2.5 text-[13.5px] text-rose" role="status"><b>{asked.length} sent back by the doctor.</b> Move {asked.length === 1 ? 'it' : 'them'} and the doctor sees the new date straight away.</div>}

      <section className="card !p-0 overflow-hidden">
        {q.isLoading ? <div className="p-4"><Skeleton rows={6} /></div> : q.isError && !q.data ? <div className="p-4"><LoadError onRetry={() => q.refetch()} /></div>
          : !all.length ? <div className="px-5 py-10 text-center text-muted">No sittings booked for {rangeText(mon)}. Reception books them at checkout, on a date.</div>
          : days.map((d) => { const list = all.filter((s) => s.day === d).sort((a, b) => a.startTime.localeCompare(b.startTime)); if (!list.length) return null; return (
            <div key={d}>
              <div className="border-b border-line bg-paper-2 px-4 py-2 text-[13px] font-semibold text-ink-2">{fmt(d, { weekday: 'long', day: 'numeric', month: 'short' })}<span className="ml-2 font-normal text-muted">{list.length} sitting{list.length === 1 ? '' : 's'}</span></div>
              {list.map((s) => { const ap = APPROVAL[s.approval] ?? APPROVAL.approved; const away = awayOn(s); return (
                <div key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-2.5 last:border-b-0">
                  <span className="w-28 shrink-0 text-[13.5px] font-medium">{t12(s.startTime)}–{t12(s.endTime)}</span>
                  <button type="button" className="min-w-[200px] flex-1 text-left" onClick={() => setOpenId(s.id)}>
                    <span className="block text-[14.5px] font-semibold hover:underline">{s.patient.fullName}</span>
                    <span className="block text-[12.5px] text-muted">{[`${s.procedure ?? 'Procedure'} · sitting ${s.sittingNo}${s.of ? ` of ${s.of}` : ''}`, s.room, s.doctor ?? 'no doctor'].filter(Boolean).join(' · ')}</span>
                  </button>
                  <span className="flex flex-wrap items-center gap-1.5">
                    {s.state !== 'confirmed' ? <Chip>{s.state === 'completed' ? 'Done' : s.state.replace('_', ' ')}</Chip> : <Chip tone={ap.tone}>{ap.label}{s.approval === 'change' && s.approvalNote ? `: ${s.approvalNote}` : ''}</Chip>}
                    {s.patientConfirmedAt && <Chip tone="sage">patient said yes</Chip>}
                    {away && <Chip tone="amber">{s.doctor ?? 'doctor'} away</Chip>}
                  </span>
                  {canWrite && s.state === 'confirmed' && s.day >= t && <button type="button" className="btn btn-sm" onClick={() => setMoving(s)}>Move</button>}
                </div>); })}
            </div>); })}
      </section>

      {review && <Modal title="Send to the doctor for approval?" subtitle={`Week of ${rangeText(mon)}`} onClose={() => setReview(false)} width="max-w-lg">
        <div className="space-y-3">
          {byDoc.map((d) => (
            <div key={d.name} className="flex gap-4 border-t border-line pt-3 first:border-t-0 first:pt-0">
              <span className="min-w-[34px] text-right text-[26px] font-bold leading-none">{d.list.length}</span>
              <span className="min-w-0 flex-1"><b className="text-[15px]">{d.name}</b><span className="block text-[13px] text-muted">{d.list.map((s) => `${s.patient.fullName} (${fmt(s.day, { weekday: 'short' })} ${t12(s.startTime)})`).join(', ')}</span></span>
            </div>))}
          <div className="text-[13px] text-muted">Each doctor sees their own sittings on the Dashboard and can approve, move one, or send it back with a note. After this, any change in this week reaches the doctor straight away.</div>
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
