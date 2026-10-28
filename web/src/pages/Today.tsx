import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useOutletContext } from 'react-router';
import { get, patch, post, qc, today, errText } from '../api';
import { can } from '../App';
import { Chip, Empty, Icon, Num, Segmented, Skeleton, toast } from '../ui';
import { PhotoCapture } from '../photos';
import { openViewer } from '../viewer';

const minsSince = (iso: string) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
/** "10:00–13:00, 16:00–20:00" from back-to-back windows. */
const hoursOf = (ws: any[]) => ws.reduce((out: [string, string][], w) => { const last = out[out.length - 1]; if (last && last[1] === w.startTime) last[1] = w.endTime; else out.push([w.startTime, w.endTime]); return out; }, []).map(([a, b]) => `${a}–${b}`).join(', ');

type Row = { key: string; time: string; sort: number; rank: number; patient: any; type?: { name: string; color: string } | null; label: string; tone: '' | 'clay' | 'sage' | 'amber' | 'rose' | 'sky'; visit?: any; note?: string };
type Tab = 'now' | 'done';

/** The doctor's landing page: the whole day at a glance, who is next, the day's procedures, and what still needs them. No money. */
export function Today() {
  const { me, perms, cfg } = useOutletContext<any>();
  const nav = useNavigate();
  const doc: string | null = me.practitionerId ?? null;
  const fd = useQuery({ queryKey: ['frontdesk', 'today-doc'], queryFn: () => get('/frontdesk'), refetchInterval: 5000 });
  const cal = useQuery({ queryKey: ['calendar', today(), doc ?? 'all'], queryFn: () => get(`/calendar?day=${today()}${doc ? `&practitionerId=${doc}` : ''}`), refetchInterval: 30000 });
  const plans = useQuery({ queryKey: ['worklist', 'procedure'], queryFn: () => get('/worklist?kind=procedure'), enabled: can(perms, 'worklist.read') });
  const fus = useQuery({ queryKey: ['worklist', 'followup'], queryFn: () => get('/worklist?kind=followup'), enabled: can(perms, 'worklist.read') });
  const [pmode, setPmode] = useState<'today' | 'tomorrow' | 'date'>('today'); const [pdate, setPdate] = useState(today());
  const tomorrow = (() => { const x = new Date(today() + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); })();
  const day = pmode === 'today' ? today() : pmode === 'tomorrow' ? tomorrow : pdate;
  const pq = useQuery({ queryKey: ['psessions', 'day', day], queryFn: () => get(`/procedure-sessions?day=${day}&active=1`), refetchInterval: 30000, enabled: can(perms, 'worklist.read') });
  const todays = useQuery({ queryKey: ['psessions', 'day', today()], queryFn: () => get(`/procedure-sessions?day=${today()}&active=1`), refetchInterval: 30000, enabled: can(perms, 'worklist.read') });
  const pcount = useQuery({ queryKey: ['pcounts', today(), 'two'], queryFn: () => get(`/procedure-sessions/counts?from=${today()}&days=2`), refetchInterval: 60000, enabled: can(perms, 'worklist.read') });
  const resq = useQuery({ queryKey: ['results'], queryFn: () => get('/results?days=7'), refetchInterval: 30000, enabled: !!doc && can(perms, 'document.read') });
  const open = useMutation({ mutationFn: (visitId: string) => post(`/visits/${visitId}/encounter`), onSuccess: (e: any) => nav(`/encounter/${e.id}`, { viewTransition: true }), onError: (e) => toast(errText(e), 'err') });
  const setState = useMutation({ mutationFn: ({ id, state }: any) => patch(`/procedure-sessions/${id}`, { state }), onSuccess: () => { ['calendar', 'psessions', 'pcounts'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); toast('Updated'); }, onError: (e) => toast(errText(e), 'err') });
  const [tab, setTab] = useState<Tab>('now');
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
  const shown = rows.filter((r) => (tab === 'now' && r.rank <= 1) || (tab === 'done' && r.rank >= 3));
  const later = rows.filter((r) => r.rank === 2).length; // booked, not arrived yet
  const firstWaiting = rows.find((r) => r.rank === 1);

  const procs: any[] = todays.data ?? [];
  const procsDone = procs.filter((p: any) => p.state === 'completed').length;
  const plist: any[] = pq.data ?? [];
  const noDoc = (p: any) => ['confirmed', 'in_progress'].includes(p.state) && !p.practitionerId;
  const needsYou = (p: any) => !!doc && p.requiresMainDoctor && p.practitionerId === doc && ['confirmed', 'in_progress'].includes(p.state);
  const procFlags = plist.filter((p) => noDoc(p) || needsYou(p)).length;
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
  // test results nobody on the clinical side has opened yet, one line per patient
  const resultGroups = (() => { const m = new Map<string, any>(); for (const r of (resq.data ?? []).filter((x: any) => x.documents.some((d: any) => !d.reviewedAt))) { const g = m.get(r.patient.id) ?? { patient: r.patient, tests: [] as string[], docs: new Map<string, any>(), at: r.at }; g.tests.push(r.test); for (const d of r.documents) g.docs.set(d.id, d); m.set(r.patient.id, g); } return [...m.values()]; })();
  const openResults = (g: any) => { const docs = [...g.docs.values()]; openViewer({ docs, who: g.patient.fullName, canDelete: can(perms, 'document.write') }); post('/documents/review', { ids: docs.map((d: any) => d.id) }).then(() => qc.invalidateQueries({ queryKey: ['results'] }), () => {}); };
  const attention = drafts.length + review.length + (overdue.length ? 1 : 0) + procFlags + resultGroups.length;
  const dateLabel = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Kolkata' });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-3 anim-fade-up">
        <div className="min-w-0"><h1 className="text-[28px] font-semibold leading-tight">{hello}, {me.name.split(' ').slice(0, 2).join(' ')}</h1>
          <div className="text-sm text-muted">{dateLabel}{myHours ? ` · ${doc ? 'your day' : 'clinic hours'} ${myHours}` : doc ? ' · not working today' : ''}{changes.length ? ` · ${changes.map((b: any) => b.note ?? b.kind).join(', ')}` : ''}</div></div>
        <span className="ml-auto" />
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 stagger">
        <Kpi i={0} icon="calendar" tint="var(--color-clay-soft)" n={apptCount + procs.length} label="Appointments today" sub={`${apptCount} consultations · ${procs.length} procedures`} onClick={() => setTab('now')} />
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
              <span className="ml-auto"><Segmented<Tab> value={tab} onChange={setTab} options={[{ value: 'now', label: 'Waiting', count: rows.filter((r) => r.rank <= 1).length }, { value: 'done', label: 'Completed', count: rows.filter((r) => r.rank >= 3).length }]} /></span>
            </div>
            <div className="px-5 pb-2 text-sm text-muted">{later > 0 ? `${later} more booked today` : 'No more bookings today'} · {apptCount} appointment{apptCount === 1 ? '' : 's'}</div>
            {shown.length === 0 ? <Empty icon="users" title={tab === 'now' ? 'Nobody waiting' : 'Nobody seen yet'} hint={tab === 'now' && later > 0 ? 'Patients appear here when they arrive.' : undefined} /> : (
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

        </div>

        <section id="today-procs" className="card-flat self-start p-5 anim-fade-up scroll-mt-4" style={{ animationDelay: '90ms' }}>
          <div className="flex items-center gap-2"><b className="text-[16px]">Needs your attention</b>{attention > 0 && <Chip tone="clay">{attention}</Chip>}</div>

          <div className="mt-3 flex flex-wrap items-center gap-2"><span className="text-[11px] font-bold uppercase tracking-wider text-muted">Procedures</span>
            <span className="ml-auto"><Segmented<'today' | 'tomorrow' | 'date'> value={pmode} onChange={setPmode} options={[{ value: 'today', label: 'Today', count: pcount.data?.[today()] ?? 0 }, { value: 'tomorrow', label: 'Tomorrow', count: pcount.data?.[tomorrow] ?? 0 }, { value: 'date', label: 'Date' }]} /></span></div>
          {pmode === 'date' && <input type="date" aria-label="Procedures on" className="input mt-2 !py-2" value={pdate} onChange={(e) => e.target.value && setPdate(e.target.value)} />}
          {pq.isLoading ? <div className="py-3"><Skeleton rows={2} /></div> : plist.length === 0 ? <div className="py-3 text-sm text-muted">No procedures {pmode === 'today' ? 'today' : pmode === 'tomorrow' ? 'tomorrow' : 'on this date'}.</div> : (
            <div className="mt-1">{plist.map((p: any) => (
              <div key={p.id} className="flex items-center gap-2.5 border-t border-line/60 py-2.5 first:border-t-0">
                <b className="w-11 shrink-0 text-[13px]">{p.startTime}</b>
                <div className="min-w-0 flex-1"><button className="block max-w-full truncate text-left text-sm font-medium hover:underline" onClick={() => nav(`/patients/${p.patient.id}`)}>{p.patient.fullName}</button>
                  <div className="truncate text-xs text-muted">{p.procedure ?? 'Procedure'} · {p.sittingNo}{p.of ? ` of ${p.of}` : ''}{p.room ? ` · ${p.room}` : ''}{p.doctor && p.practitionerId !== doc ? ` · ${p.doctor}` : ''}</div></div>
                {p.state === 'completed' ? <Chip tone="sage">done</Chip> : p.state === 'missed' ? <Chip tone="rose">missed</Chip>
                  : noDoc(p) ? <Chip tone="rose">no doctor</Chip> : needsYou(p) && p.state === 'confirmed' && day !== today() ? <Chip tone="amber">needs you</Chip> : null}
                {can(perms, 'worklist.write') && p.state === 'confirmed' && day === today() && <button className="btn btn-sm" onClick={() => setState.mutate({ id: p.id, state: 'in_progress' })}>Start</button>}
                {can(perms, 'worklist.write') && p.state === 'in_progress' && <button className="btn btn-sm btn-primary" onClick={() => setState.mutate({ id: p.id, state: 'completed' })}>Done</button>}
                {can(perms, 'document.write') && !['cancelled', 'postponed'].includes(p.state) && <button className="btn btn-ghost btn-icon !h-8 !w-8" title="Photos" aria-label={`Photos for ${p.patient.fullName}`} onClick={() => setCap({ ...p, patientId: p.patient.id, patient: p.patient.fullName })}><Icon name="spark" className="h-3.5 w-3.5" /></button>}
              </div>))}</div>
          )}
          <div className="mt-2 text-right"><button className="text-sm font-semibold underline" onClick={() => nav(`/worklist?tab=schedule&day=${day}`)}>Open procedure schedule →</button></div>

          <div className="mt-4 text-[11px] font-bold uppercase tracking-wider text-muted">Other</div>
          {drafts.length + review.length + (overdue.length ? 1 : 0) + resultGroups.length === 0 ? <div className="py-3 text-sm text-muted">Nothing else waiting on you.</div> : <div>
            {resultGroups.map((g: any) => <Attn key={g.patient.id} tone="sky" tag="result" title="Results received" sub={`${g.patient.fullName} · ${[...new Set(g.tests)].join(', ')} · ${g.docs.size} file${g.docs.size === 1 ? '' : 's'}`} action="Open" onClick={() => openResults(g)} />)}
            {drafts.map((v: any) => <Attn key={v.id} tone="amber" tag="note" title="Finish consultation note" sub={`${v.patient.fullName} · arrived ${hhmm(v.arrivedAt)} · note not completed`} action="Open" onClick={() => open.mutate(v.id)} />)}
            {review.slice(0, 4).map((r: any) => <Attn key={r.id} tone="sky" tag="plan" title="Review procedure plan" sub={`${r.procedure} for ${r.patient.fullName}${r.sittings ? ` · ${r.sittings} sittings` : ''}`} action="Open" onClick={() => nav(`/patients/${r.patient.id}`)} />)}
            {overdue.length > 0 && <Attn tone="clay" tag="follow-up" title={`${overdue.length} follow-up${overdue.length === 1 ? '' : 's'} overdue`} sub="Reception or the coordinator can call them from Procedures → Plans to schedule" action="See" onClick={() => nav('/worklist?tab=plans')} />}
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
