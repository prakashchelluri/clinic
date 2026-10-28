import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useOutletContext, useSearchParams } from 'react-router';
import { get, patch, post, qc, today, errText, ApiError } from '../api';
import { can } from '../App';
import { Avatar, Chip, Empty, Icon, Modal, MoreMenu, Segmented, Skeleton, ask, toast } from '../ui';
import { ScheduleModal } from './Worklist';

const add = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const short = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', timeZone: 'UTC' });
const long = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const refresh = () => ['psessions', 'pcounts', 'calendar', 'worklist', 'psessions-upcoming'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));

/**
 * Procedures for one date: what is planned, in which room, with which doctor, and what still needs sorting out.
 * The coordinator plans tomorrow from here; the doctor can glance at any day. Plans still to be scheduled are the other tab.
 */
export function ProcSchedule({ onPlans }: { onPlans: () => void }) {
  const { me, perms, cfg } = useOutletContext<any>();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const t = today();
  const isDoctor = !!me.practitionerId;
  const day = sp.get('day') ?? (isDoctor ? t : add(t, 1)); // the coordinator plans ahead, the doctor looks at today
  const setDay = (d: string) => setSp((p) => { p.set('tab', 'schedule'); p.set('day', d); return p; }, { replace: true });
  const [docF, setDocF] = useState(''); const [roomF, setRoomF] = useState(''); const [mine, setMine] = useState(false); const [only, setOnly] = useState<'' | 'nodoc' | 'unconf'>('');
  const [moving, setMoving] = useState<any>(null); const [assigning, setAssigning] = useState<any>(null);
  const canWrite = can(perms, 'worklist.write');

  const from = add(t, -1);
  const counts = useQuery({ queryKey: ['pcounts', from], queryFn: () => get(`/procedure-sessions/counts?from=${from}&days=9`), refetchInterval: 30000 });
  const q = useQuery({ queryKey: ['psessions', 'day', day], queryFn: () => get(`/procedure-sessions?day=${day}&active=1`), refetchInterval: 15000 });
  const plans = useQuery({ queryKey: ['worklist', 'procedure'], queryFn: () => get('/worklist?kind=procedure'), enabled: can(perms, 'worklist.read') });
  const setState = useMutation({ mutationFn: ({ id, state, reason }: any) => patch(`/procedure-sessions/${id}`, { state, reason }), onSuccess: () => { refresh(); toast('Updated'); }, onError: (e) => toast(errText(e), 'err') });
  const confirm = useMutation({ mutationFn: ({ id, confirmed }: any) => post(`/procedure-sessions/${id}/confirm`, { confirmed }), onSuccess: (_r, v: any) => { refresh(); toast(v.confirmed ? 'Marked as confirmed by the patient' : 'Confirmation removed', 'info'); }, onError: (e) => toast(errText(e), 'err') });

  const all: any[] = q.data ?? [];
  const docs = (cfg?.practitioners ?? []).filter((p: any) => p.active !== false);
  const rooms = (cfg?.rooms ?? []).filter((r: any) => r.active !== false);
  const open = (s: any) => ['confirmed', 'in_progress'].includes(s.state);
  const noDoc = (s: any) => open(s) && !s.practitionerId;
  const unconf = (s: any) => s.state === 'confirmed' && !s.patientConfirmedAt && day >= t;
  const rows = all.filter((s) => (!docF || (docF === 'none' ? !s.practitionerId : s.practitionerId === docF)) && (!roomF || s.roomId === roomF) && (!mine || s.practitionerId === me.practitionerId)
    && (only === '' || (only === 'nodoc' ? noDoc(s) : unconf(s))));
  const nNoDoc = all.filter(noDoc).length; const nUnconf = all.filter(unconf).length;
  const unscheduled = (plans.data ?? []).filter((r: any) => !r.next && r.status !== 'scheduled').length;

  // the strip: yesterday to a week ahead, plus the chosen day when it is outside
  const strip = Array.from({ length: 9 }, (_, i) => add(from, i));
  const stripDays = strip.includes(day) ? strip : [...strip, day];
  const lab = (d: string) => d === t ? 'Today' : d === add(t, 1) ? 'Tomorrow' : d === add(t, -1) ? 'Yesterday' : short(d);

  const status = (s: any) => s.state === 'completed' ? <Chip tone="sage">done</Chip> : s.state === 'in_progress' ? <Chip tone="amber">in progress</Chip> : s.state === 'missed' ? <Chip tone="rose">missed</Chip>
    : s.patientConfirmedAt ? <Chip tone="sage">patient confirmed</Chip> : day >= t ? <Chip tone="amber">not confirmed</Chip> : <Chip tone="sky">scheduled</Chip>;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented<string> value={day} onChange={setDay} options={stripDays.map((d) => ({ value: d, label: lab(d), count: counts.data?.[d] ?? (d === day ? all.length : undefined) }))} />
        <input type="date" aria-label="Pick a date" className="input !w-auto !py-2" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold mr-2">{long(day)}</h2>
        <select aria-label="Doctor" className="input !w-auto !py-2" value={docF} onChange={(e) => setDocF(e.target.value)}><option value="">All doctors</option><option value="none">Not assigned</option>{docs.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        <select aria-label="Room" className="input !w-auto !py-2" value={roomF} onChange={(e) => setRoomF(e.target.value)}><option value="">All rooms</option>{rooms.map((r: any) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
        {isDoctor && <Segmented<'all' | 'mine'> value={mine ? 'mine' : 'all'} onChange={(v) => setMine(v === 'mine')} options={[{ value: 'all', label: 'All' }, { value: 'mine', label: 'Mine' }]} />}
      </div>

      {(nNoDoc > 0 || nUnconf > 0) && (
        <div className="card !py-3 !bg-amber-soft/60 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm anim-fade-up">
          <b>Needs attention · {nNoDoc + nUnconf}</b>
          {nNoDoc > 0 && <button className={`underline ${only === 'nodoc' ? 'font-semibold' : ''}`} onClick={() => setOnly(only === 'nodoc' ? '' : 'nodoc')}>{nNoDoc} without a doctor</button>}
          {nUnconf > 0 && <button className={`underline ${only === 'unconf' ? 'font-semibold' : ''}`} onClick={() => setOnly(only === 'unconf' ? '' : 'unconf')}>{nUnconf} patient{nUnconf === 1 ? '' : 's'} not confirmed</button>}
          {only && <button className="btn btn-ghost btn-sm ml-auto" onClick={() => setOnly('')}>Show all</button>}
        </div>
      )}

      {q.isLoading ? <Skeleton rows={4} /> : rows.length === 0 ? (
        <div className="card"><Empty icon="stetho" title={all.length ? 'Nothing matches these filters' : `No procedures planned for ${lab(day).toLowerCase()}`} hint={all.length ? undefined : 'Every room is free.'} />
          {!all.length && unscheduled > 0 && <div className="flex justify-center pb-5"><button className="btn btn-primary" onClick={onPlans}>{unscheduled} plan{unscheduled === 1 ? '' : 's'} waiting to be scheduled</button></div>}</div>
      ) : (
        <div className="card-flat overflow-hidden anim-fade-up">
          <div className="hidden md:flex items-center gap-3 px-5 py-2.5 text-[11px] uppercase tracking-wider text-muted"><span className="w-14">Time</span><span className="flex-1">Patient and procedure</span><span className="w-44">Room</span><span className="w-40">Doctor</span><span className="w-44">Status</span><span className="w-9" /></div>
          {rows.map((s) => (
            <div key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line/70 px-5 py-3 first:border-t-0">
              <b className="w-14 shrink-0 text-[15px]">{s.startTime}</b>
              <div className="min-w-0 flex-1 basis-48">
                <div className="flex items-center gap-2"><Avatar name={s.patient.fullName} size="h-7 w-7 text-[10px]" /><button className="truncate font-medium hover:underline text-left" onClick={() => nav(`/patients/${s.patient.id}`)}>{s.patient.fullName}</button><span className="text-xs text-muted">{[s.patient.ageYears ? `${s.patient.ageYears}${s.patient.sex ?? ''}` : '', s.patient.patientNo].filter(Boolean).join(' · ')}</span></div>
                <div className="text-xs text-muted pl-9">{s.procedure ?? 'Procedure'} · sitting {s.sittingNo}{s.of ? ` of ${s.of}` : ''} · {s.startTime}–{s.endTime}<span className="md:hidden"> · {s.room ?? 'no room'} · {s.doctor ?? 'no doctor'}</span></div>
              </div>
              <span className="hidden md:block w-44 text-sm">{s.room ?? <span className="text-muted">no room</span>}</span>
              <span className="hidden md:block w-40 text-sm">{s.doctor ?? <span className="text-rose">not assigned</span>}</span>
              <span className="flex w-44 flex-wrap gap-1">{status(s)}{noDoc(s) && <Chip tone="rose">no doctor</Chip>}</span>
              <span className="w-9 text-right">{canWrite && <MoreMenu items={[
                { label: 'Reschedule', hidden: !['confirmed', 'postponed', 'missed'].includes(s.state), onClick: () => setMoving(s) },
                { label: s.practitionerId ? 'Change doctor' : 'Assign doctor', hidden: s.state !== 'confirmed', onClick: () => setAssigning(s) },
                { label: s.patientConfirmedAt ? 'Undo patient confirmation' : 'Mark patient confirmed', hidden: s.state !== 'confirmed', onClick: () => confirm.mutate({ id: s.id, confirmed: !s.patientConfirmedAt }) },
                { label: 'Call patient', href: `tel:${s.patient.phone ?? ''}` },
                { label: 'Start', hidden: !(s.state === 'confirmed' && s.day === t), onClick: () => setState.mutate({ id: s.id, state: 'in_progress' }) },
                { label: 'Mark done', hidden: s.state !== 'in_progress', onClick: () => setState.mutate({ id: s.id, state: 'completed' }) },
                { label: 'Mark as missed', hidden: s.state !== 'confirmed', onClick: () => setState.mutate({ id: s.id, state: 'missed' }) },
                { label: 'Cancel this sitting', danger: true, hidden: !['confirmed', 'missed'].includes(s.state), onClick: async () => { const a = await ask({ title: 'Cancel this sitting?', body: `${s.patient.fullName} · ${s.procedure ?? 'procedure'} at ${s.startTime}. The room and doctor are freed and the plan goes back to open.`, confirmLabel: 'Cancel sitting', cancelLabel: 'Keep it', field: { label: 'Reason', maxLength: 200 } }); if (a) setState.mutate({ id: s.id, state: 'cancelled', reason: a.value || undefined }); } },
              ]} />}</span>
            </div>
          ))}
        </div>
      )}
      <div className="text-xs text-muted">Plans the doctor made that are not scheduled yet are under “Plans to schedule”.</div>
      {moving && <ScheduleModal rec={{ id: moving.recommendationId, procedureId: moving.procedureId, patient: { fullName: moving.patient.fullName, phone: moving.patient.phone }, sittings: moving.of }} sitting={moving} onClose={() => { setMoving(null); refresh(); }} />}
      {assigning && <AssignDoctor s={assigning} docs={docs} onClose={() => { setAssigning(null); refresh(); }} />}
    </div>
  );
}

/** Put a doctor on a sitting. A clash with the doctor's other work is explained and can be overridden. */
function AssignDoctor({ s, docs, onClose }: { s: any; docs: any[]; onClose: () => void }) {
  const [doc, setDoc] = useState<string>(s.practitionerId ?? docs[0]?.id ?? '');
  const [conf, setConf] = useState<any[] | null>(null);
  const save = useMutation({ mutationFn: (force: boolean) => post(`/procedure-sessions/${s.id}/assign`, { practitionerId: doc || null, force }),
    onSuccess: () => { toast('Doctor assigned'); onClose(); },
    onError: (e: any) => { if (e instanceof ApiError && e.body?.code === 'CONFLICT') setConf(e.body.conflicts); else toast(errText(e), 'err'); } });
  return (
    <Modal title={s.practitionerId ? 'Change doctor' : 'Assign doctor'} subtitle={`${s.patient.fullName} · ${s.procedure ?? 'procedure'} · ${s.startTime}–${s.endTime}`} onClose={onClose} width="max-w-md">
      <div className="space-y-4">
        <div><label className="label" htmlFor="as-doc">Doctor</label>
          <select id="as-doc" className="input" value={doc} onChange={(e) => { setDoc(e.target.value); setConf(null); }}>{!s.requiresMainDoctor && <option value="">No doctor needed</option>}{docs.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          {doc && <div className="mt-1 text-[11px] text-amber">Blocks this doctor's OP capacity for the slot.</div>}</div>
        {conf && <div className="rounded-xl bg-amber-soft p-3 text-sm text-amber anim-fade-up"><div className="mb-1 font-medium">This doctor is busy then:</div>{conf.map((c, i) => <div key={i}>• {c.kind}: {c.who} ({c.startTime}–{c.endTime})</div>)}</div>}
        <div className="modal-foot"><button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          {conf ? <button className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate(true)}>Assign anyway</button> : <button className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate(false)}><Icon name="check" />Assign</button>}</div>
      </div>
    </Modal>
  );
}
