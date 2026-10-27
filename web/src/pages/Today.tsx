import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useOutletContext } from 'react-router';
import { get, patch, post, qc, today, errText } from '../api';
import { can } from '../App';
import { Chip, Empty, Icon, Num, Segmented, Skeleton, toast } from '../ui';
import { PhotoCapture } from '../photos';

const minsSince = (iso: string) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
/** "10:00–13:00, 16:00–20:00" from back-to-back windows. */
const hoursOf = (ws: any[]) => ws.reduce((out: [string, string][], w) => { const last = out[out.length - 1]; if (last && last[1] === w.startTime) last[1] = w.endTime; else out.push([w.startTime, w.endTime]); return out; }, []).map(([a, b]) => `${a}–${b}`).join(', ');

type Row = { key: string; time: string; sort: number; rank: number; patient: any; type?: { name: string; color: string } | null; label: string; tone: '' | 'clay' | 'sage' | 'amber' | 'rose' | 'sky'; visit?: any; note?: string };
type Tab = 'all' | 'now' | 'later' | 'done';

/** The doctor's landing page: the whole day at a glance, who is next, the day's procedures, and what still needs them. No money. */
export function Today() {
  const { me, perms, cfg } = useOutletContext<any>();
  const nav = useNavigate();
  const doc: string | null = me.practitionerId ?? null;
  const fd = useQuery({ queryKey: ['frontdesk', 'today-doc'], queryFn: () => get('/frontdesk'), refetchInterval: 5000 });
  const cal = useQuery({ queryKey: ['calendar', today(), doc ?? 'all'], queryFn: () => get(`/calendar?day=${today()}${doc ? `&practitionerId=${doc}` : ''}`), refetchInterval: 30000 });
  const plans = useQuery({ queryKey: ['worklist', 'procedure'], queryFn: () => get('/worklist?kind=procedure'), enabled: can(perms, 'worklist.read') });
  const fus = useQuery({ queryKey: ['worklist', 'followup'], queryFn: () => get('/worklist?kind=followup'), enabled: can(perms, 'worklist.read') });
  const open = useMutation({ mutationFn: (visitId: string) => post(`/visits/${visitId}/encounter`), onSuccess: (e: any) => nav(`/encounter/${e.id}`, { viewTransition: true }), onError: (e) => toast(errText(e), 'err') });
  const setState = useMutation({ mutationFn: ({ id, state }: any) => patch(`/procedure-sessions/${id}`, { state }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['calendar'] }); toast('Updated'); }, onError: (e) => toast(errText(e), 'err') });
  const [tab, setTab] = useState<Tab>('all');
  const [cap, setCap] = useState<any>(null);
  const d = fd.data; const c = cal.data;
  if (!d || !c) return <div className="space-y-4"><Skeleton rows={2} /><Skeleton rows={6} /></div>;

  const mine = (pid: string | null) => !doc || !pid || pid === doc;
  const visits = d.visits.filter((v: any) => mine(v.practitionerId));
  const byAppt = new Map(visits.filter((v: any) => v.appointmentId).map((v: any) => [v.appointmentId, v]));
  const qpos = new Map(visits.map((v: any, i: number) => [v.id, i]));
  const rowOfVisit = (v: any, time: string, type: Row['type'], key: string): Row => {
    const st = v.status;
    if (st === 'in_consult') return { key, time, sort: 0, rank: 0, patient: v.patient, type, label: 'with you', tone: 'clay', visit: v };
    if (st === 'waiting' || st === 'intake') return { key, time, sort: qpos.get(v.id) as number, rank: 1, patient: v.patient, type, label: `${st === 'intake' ? 'at intake' : 'waiting'} ${minsSince(v.arrivedAt)} min`, tone: 'amber', visit: v };
    if (st === 'left') return { key, time, sort: toMin(time), rank: 4, patient: v.patient, type, label: 'left', tone: 'rose', visit: v };
    return { key, time, sort: toMin(time), rank: 3, patient: v.patient, type, label: v.encounterStatus === 'draft' ? 'done · note unfinished' : 'done', tone: v.encounterStatus === 'draft' ? 'amber' : 'sage', visit: v };
  };
  const nowMin = toMin(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()));
  const late = (w: any) => toMin(w.endTime) < nowMin; // window over and the patient never came
  const rows: Row[] = [];
  for (const w of c.windows) for (const a of w.appointments ?? []) {
    const type = a.service ? { name: a.service, color: a.color } : null;
    const v = byAppt.get(a.id);
    if (v) rows.push(rowOfVisit(v, w.startTime, type, a.id));
    else rows.push({ key: a.id, time: w.startTime, sort: toMin(w.startTime), rank: a.status === 'no_show' ? 4 : 2, patient: { id: a.patientId, fullName: a.name, phone: a.phone }, type,
      label: a.status === 'no_show' ? 'no-show' : late(w) ? 'not arrived' : a.status === 'requested' ? 'requested online' : a.status === 'confirmed' ? 'booked · confirmed' : 'booked', tone: a.status === 'no_show' || late(w) ? 'rose' : a.status === 'confirmed' ? 'sky' : '', note: a.note });
  }
  for (const v of visits) if (!v.appointmentId) rows.push(rowOfVisit(v, hhmm(v.arrivedAt), { name: v.category === 'NGT' ? 'Emergency' : 'Walk-in', color: '#8A877E' }, v.id));
  rows.sort((a, b) => a.rank - b.rank || a.sort - b.sort);
  const shown = rows.filter((r) => tab === 'all' || (tab === 'now' && r.rank <= 1) || (tab === 'later' && r.rank === 2) || (tab === 'done' && r.rank >= 3));
  const firstWaiting = rows.find((r) => r.rank === 1);

  const procs = c.procedures.filter((p: any) => mine(p.practitionerId));
  const procsDone = procs.filter((p: any) => p.state === 'completed').length;
  const waiting = rows.filter((r) => r.rank === 1);
  const done = rows.filter((r) => r.rank === 3).length;
  const apptCount = rows.filter((r) => r.label !== 'no-show').length;
  const drafts = visits.filter((v: any) => v.encounterStatus === 'draft' && v.status !== 'in_consult');
  // Plans for procedures the clinic marks "needs doctor review", not yet scheduled
  const review = (plans.data ?? []).filter((r: any) => r.status === 'open' && cfg?.procedures.find((p: any) => p.id === r.procedureId)?.requiresReview);
  const overdue = (fus.data ?? []).filter((r: any) => r.dueOn && r.dueOn < today() && ['open', 'contacted'].includes(r.status));
  const hello = new Date().getHours() < 12 ? 'Good morning' : new Date().getHours() < 17 ? 'Good afternoon' : 'Good evening';
  const myHours = hoursOf(c.windows.filter((w: any) => !doc || w.practitionerId === doc));
  const changes = c.blocks.filter((b: any) => !doc || b.practitionerId === doc);
  const attention = drafts.length + review.length + (overdue.length ? 1 : 0);
  const dateLabel = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Kolkata' });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-3 anim-fade-up">
        <div className="min-w-0"><h1 className="text-[28px] font-semibold leading-tight">{hello}, {me.name.split(' ').slice(0, 2).join(' ')}</h1>
          <div className="text-sm text-muted">{dateLabel}{myHours ? ` · ${doc ? 'your day' : 'clinic hours'} ${myHours}` : doc ? ' · not working today' : ''}{changes.length ? ` · ${changes.map((b: any) => b.note ?? b.kind).join(', ')}` : ''}</div></div>
        <span className="ml-auto" />
        <button className="btn" onClick={() => nav('/calendar')}><Icon name="calendar" />Calendar</button>
        {can(perms, 'appointment.write') && <button className="btn btn-accent" onClick={() => nav('/calendar?book=1')}><Icon name="plus" />New booking</button>}
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 stagger">
        <Kpi i={0} icon="calendar" tint="var(--color-clay-soft)" n={apptCount + procs.length} label="Appointments today" sub={`${apptCount} consultations · ${procs.length} procedures`} onClick={() => setTab('all')} />
        <Kpi i={1} icon="check" tint="var(--color-sage-soft)" n={done} label="Consultations done" sub={drafts.length ? `${drafts.length} note${drafts.length === 1 ? '' : 's'} unfinished` : 'all notes finished'} onClick={() => setTab('done')} />
        <Kpi i={2} icon="stetho" tint="var(--color-sky-soft)" n={procs.length} label="Procedure sittings" sub={procs.length ? `${procsDone} done · ${procs.length - procsDone} to go` : 'none today'} onClick={() => document.getElementById('today-procs')?.scrollIntoView({ behavior: 'smooth' })} />
        <Kpi i={3} icon="clock" tint="var(--color-amber-soft)" n={waiting.length} label="Waiting now" sub={waiting.length ? `longest ${Math.max(...waiting.map((r) => minsSince(r.visit.arrivedAt)))} min` : 'nobody waiting'} onClick={() => setTab('now')} />
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-5">
          <section className="card-flat overflow-hidden anim-fade-up">
            <div className="flex flex-wrap items-center gap-2 px-5 pt-4 pb-3">
              <b className="text-[16px]">{doc ? 'Your patients today' : 'Patients today'}</b>
              {waiting.length > 0 && <Chip tone="amber">{waiting.length} waiting</Chip>}
              <span className="ml-auto"><Segmented<Tab> value={tab} onChange={setTab} options={[{ value: 'all', label: 'All', count: rows.length }, { value: 'now', label: 'Now', count: rows.filter((r) => r.rank <= 1).length }, { value: 'later', label: 'Later', count: rows.filter((r) => r.rank === 2).length }, { value: 'done', label: 'Done', count: rows.filter((r) => r.rank >= 3).length }]} /></span>
            </div>
            {shown.length === 0 ? <Empty icon="users" title={tab === 'now' ? 'Nobody waiting' : tab === 'later' ? 'No more bookings today' : tab === 'done' ? 'Nobody seen yet' : 'No patients today'} hint={tab === 'all' ? 'Bookings and walk-ins for today appear here.' : undefined} /> : (
              <div className="overflow-x-auto">
                <table className="table min-w-[560px]">
                  <thead><tr><th>Time</th><th>Patient</th><th>Visit</th><th>Status</th><th /></tr></thead>
                  <tbody>{shown.map((r) => {
                    const v = r.visit; const complaint = v?.details?.complaints?.[0]?.text ?? v?.details?.complaint;
                    const vit = v ? [v.details?.bp && `BP ${v.details.bp}`, v.details?.weight_kg && `${v.details.weight_kg} kg`].filter(Boolean).join(' · ') : '';
                    return (
                      <tr key={r.key} className={r.rank === 0 ? 'bg-white/70' : r.rank >= 3 ? 'opacity-75' : ''}>
                        <td className="whitespace-nowrap font-semibold">{r.time}</td>
                        <td className="min-w-0"><button className="text-left font-medium hover:underline" onClick={() => nav(`/patients/${r.patient.id}`)}>{r.patient.fullName}</button>
                          <div className="text-xs text-muted">{[r.patient.patientNo, r.patient.ageYears ? `${r.patient.ageYears} ${r.patient.sex ?? ''}` : null, complaint, vit, r.note].filter(Boolean).join(' · ')}</div></td>
                        <td className="whitespace-nowrap">{r.type ? <span className="inline-flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-[3px]" style={{ background: r.type.color }} />{r.type.name}</span> : <span className="text-muted">—</span>}</td>
                        <td><Chip tone={r.tone}>{r.label}</Chip></td>
                        <td className="whitespace-nowrap text-right">
                          {v && r.rank === 0 && can(perms, 'encounter.intake') && <button className="btn btn-accent btn-sm" disabled={open.isPending} onClick={() => open.mutate(v.id)}>Continue</button>}
                          {v && r.rank === 1 && can(perms, 'encounter.intake') && <button className={`btn btn-sm ${r === firstWaiting ? 'btn-primary' : ''}`} disabled={open.isPending} onClick={() => open.mutate(v.id)}>Call in</button>}
                          {v && r.rank === 3 && v.encounterStatus === 'draft' && <button className="btn btn-sm" onClick={() => open.mutate(v.id)}>Finish note</button>}
                        </td>
                      </tr>);
                  })}</tbody>
                </table>
              </div>
            )}
          </section>

          <section id="today-procs" className="card-flat overflow-hidden anim-fade-up scroll-mt-4" style={{ animationDelay: '60ms' }}>
            <div className="flex items-center gap-2 px-5 pt-4 pb-3"><b className="text-[16px]">Today's procedures</b><span className="text-sm text-muted">{procs.length} sitting{procs.length === 1 ? '' : 's'}</span>
              <button className="btn btn-ghost btn-sm ml-auto" onClick={() => nav('/worklist')}>All procedures<Icon name="chevR" className="h-3.5 w-3.5" /></button></div>
            {procs.length === 0 ? <div className="px-5 pb-5 text-sm text-muted">No procedures {doc ? 'on you ' : ''}today.</div> : (
              <div className="overflow-x-auto">
                <table className="table min-w-[560px]">
                  <thead><tr><th>Time</th><th>Patient</th><th>Procedure</th><th>Sitting</th><th>Status</th><th /></tr></thead>
                  <tbody>{procs.map((p: any) => (
                    <tr key={p.id}>
                      <td className="whitespace-nowrap font-semibold">{p.startTime}</td>
                      <td><button className="text-left font-medium hover:underline" onClick={() => nav(`/patients/${p.patientId}`)}>{p.patient}</button></td>
                      <td>{p.procedure ?? 'Procedure'}<div className="text-xs text-muted">{p.room ?? 'no room'}{!doc && p.doctor ? ` · ${p.doctor}` : ''}</div></td>
                      <td className="whitespace-nowrap">{p.sittingNo}{p.of ? ` of ${p.of}` : ''}</td>
                      <td><Chip tone={p.state === 'completed' ? 'sage' : p.state === 'in_progress' ? 'amber' : p.state === 'missed' ? 'rose' : 'sky'}>{p.state.replace('_', ' ')}</Chip></td>
                      <td className="whitespace-nowrap text-right">
                        {can(perms, 'worklist.write') && p.state === 'confirmed' && <button className="btn btn-sm" onClick={() => setState.mutate({ id: p.id, state: 'in_progress' })}>Start</button>}{' '}
                        {can(perms, 'worklist.write') && p.state === 'in_progress' && <button className="btn btn-sm btn-primary" onClick={() => setState.mutate({ id: p.id, state: 'completed' })}>Done</button>}{' '}
                        {can(perms, 'document.write') && !['cancelled', 'postponed'].includes(p.state) && <button className="btn btn-sm" onClick={() => setCap(p)}><Icon name="spark" className="h-3.5 w-3.5" />Photos</button>}
                      </td>
                    </tr>))}</tbody>
                </table>
              </div>
            )}
          </section>
        </div>

        <section className="card-flat self-start p-5 anim-fade-up" style={{ animationDelay: '90ms' }}>
          <div className="flex items-center gap-2"><b className="text-[16px]">Needs your attention</b>{attention > 0 && <Chip tone="clay">{attention}</Chip>}</div>
          {attention === 0 ? <div className="py-6 text-sm text-muted">All clear. Nothing waiting on you.</div> : <div className="mt-2">
            {drafts.map((v: any) => <Attn key={v.id} tone="amber" tag="note" title="Finish consultation note" sub={`${v.patient.fullName} · arrived ${hhmm(v.arrivedAt)} · note not completed`} action="Open" onClick={() => open.mutate(v.id)} />)}
            {review.slice(0, 4).map((r: any) => <Attn key={r.id} tone="sky" tag="plan" title="Review procedure plan" sub={`${r.procedure} for ${r.patient.fullName}${r.sittings ? ` · ${r.sittings} sittings` : ''}`} action="Open" onClick={() => nav(`/patients/${r.patient.id}`)} />)}
            {overdue.length > 0 && <Attn tone="clay" tag="follow-up" title={`${overdue.length} follow-up${overdue.length === 1 ? '' : 's'} overdue`} sub="Reception or the coordinator can call them from Procedures → Follow-ups" action="See" onClick={() => nav('/worklist')} />}
          </div>}
        </section>
      </div>
      {cap && <PhotoCapture patient={{ id: cap.patientId, fullName: cap.patient }} sitting={{ id: cap.id, label: `${cap.procedure ?? 'Procedure'} · sitting ${cap.sittingNo}${cap.of ? ` of ${cap.of}` : ''}` }} onClose={() => setCap(null)} />}
    </div>
  );
}

function Kpi({ i, icon, tint, n, label, sub, onClick }: { i: number; icon: string; tint: string; n: number; label: string; sub: string; onClick: () => void }) {
  return (
    <button style={{ ['--i' as any]: i }} onClick={onClick} className="card card-hover flex items-center gap-3.5 !p-4 text-left">
      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl" style={{ background: tint }}><Icon name={icon} className="h-5 w-5" /></span>
      <span className="min-w-0"><span className="block text-[26px] font-semibold leading-none tracking-tight"><Num value={n} /></span><span className="mt-1 block text-[13px] font-medium">{label}</span><span className="block truncate text-xs text-muted">{sub}</span></span>
    </button>
  );
}

function Attn({ tone, tag, title, sub, action, onClick }: { tone: 'amber' | 'sky' | 'clay'; tag: string; title: string; sub: string; action: string; onClick: () => void }) {
  return (
    <div className="flex items-start gap-3 border-t border-line/60 py-3 first:border-t-0">
      <Chip tone={tone}>{tag}</Chip>
      <div className="min-w-0 flex-1"><div className="text-sm font-semibold">{title}</div><div className="text-xs text-muted">{sub}</div></div>
      <button className="btn btn-sm" onClick={onClick}>{action}</button>
    </div>
  );
}
