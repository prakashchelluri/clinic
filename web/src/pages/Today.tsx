import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useOutletContext } from 'react-router';
import { get, post, today } from '../api';
import { Avatar, Chip, Empty, Num, Skeleton, fmtDate } from '../ui';

const minsSince = (iso: string) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));

/** The doctor's home: who is next, with what they came for and their vitals. No money anywhere on it. */
export function Today() {
  const { me, cfg } = useOutletContext<any>();
  const nav = useNavigate();
  const fd = useQuery({ queryKey: ['frontdesk', 'today-doc'], queryFn: () => get('/frontdesk'), refetchInterval: 5000 });
  const cal = useQuery({ queryKey: ['calendar', today(), me.practitionerId], queryFn: () => get(`/calendar?day=${today()}&practitionerId=${me.practitionerId}`), enabled: !!me.practitionerId, refetchInterval: 30000 });
  const reviews = useQuery({ queryKey: ['worklist', 'procedure'], queryFn: () => get('/worklist?kind=procedure') });
  const open = useMutation({ mutationFn: (visitId: string) => post(`/visits/${visitId}/encounter`), onSuccess: (e: any) => nav(`/encounter/${e.id}`, { viewTransition: true }) });
  const d = fd.data;
  if (!d) return <div className="space-y-4"><Skeleton rows={2} /><Skeleton rows={4} /></div>;

  const mine = (v: any) => !me.practitionerId || !v.practitionerId || v.practitionerId === me.practitionerId;
  const waiting = d.visits.filter((v: any) => ['waiting', 'intake'].includes(v.status) && mine(v));
  const inConsult = d.visits.filter((v: any) => v.status === 'in_consult' && mine(v));
  const done = d.visits.filter((v: any) => v.status === 'done' && mine(v));
  const ready = waiting.filter((v: any) => v.status === 'waiting');
  const next = inConsult[0] ?? ready[0] ?? waiting[0];
  const queue = waiting.filter((v: any) => v.id !== next?.id);
  const myDoc = d.doctors.find((x: any) => x.id === me.practitionerId);
  const needReview = (reviews.data ?? []).filter((r: any) => cfg?.procedures.find((p: any) => p.id === r.procedureId)?.requiresReview);
  const hello = new Date().getHours() < 12 ? 'Good morning' : new Date().getHours() < 17 ? 'Good afternoon' : 'Good evening';
  const vit = (v: any) => [['Wt', v.details?.weight_kg, 'kg'], ['BP', v.details?.bp, ''], ['SpO₂', v.details?.spo2, '%'], ['Temp', v.details?.temp_f, '°F'], ['BMI', v.details?.bmi, ''], ['Pulse', v.details?.pulse, '']].filter((x) => x[1] !== undefined && x[1] !== '');
  const complaints = (v: any): { text: string; duration?: string }[] => v.details?.complaints?.length ? v.details.complaints : v.details?.complaint ? [{ text: v.details.complaint }] : [];

  return (
    <div>
      <div className="anim-fade-up flex flex-wrap items-center gap-x-9 gap-y-4 mb-5">
        <h1 className="text-[30px] leading-[1.05] font-semibold">{hello},<br />{me.name.split(' ').slice(0, 2).join(' ')}</h1>
        <Stat n={done.length} l="Seen today" />
        <Stat n={waiting.length} l={waiting.length ? `Waiting for you · longest ${Math.max(...waiting.map((v: any) => minsSince(v.arrivedAt)))} min` : 'Waiting for you'} tone />
        <Stat n={needReview.length} l="Plans to review" />
        {myDoc?.until && <div><div className="text-xl font-semibold leading-tight">until {myDoc.until}</div><div className="text-[12.5px] text-muted">Today's routine</div></div>}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1.25fr_minmax(0,1fr)] gap-5">
        {next ? (
          <section className="dark-card p-6 anim-fade-up" style={{ animationDelay: '60ms' }}>
            <div className="flex items-center gap-2.5"><span className="rounded-full bg-clay px-3 py-1 text-[11.5px] font-bold text-white">{next.status === 'in_consult' ? 'With you now' : 'Next up'}</span><span className="text-[12.5px] text-[#a9a59c]">{next.opNumber} · {next.status === 'in_consult' ? 'in consultation' : `waiting ${minsSince(next.arrivedAt)} min`}{next.status === 'waiting' && next.details?.complaints ? ' · intake done' : ''}</span></div>
            <div className="mt-4 text-[34px] font-semibold tracking-tight leading-tight">{next.patient.fullName} <span className="text-xl font-medium text-[#a9a59c]">{next.patient.ageYears ?? ''} {next.patient.sex ?? ''}</span></div>
            <div className="mt-3 space-y-0.5 text-[17px] leading-snug">{complaints(next).length ? complaints(next).map((c, i) => <div key={i}>{c.text}{c.duration && <span className="text-[#a9a59c]"> · {c.duration}</span>}</div>) : <span className="text-[#a9a59c]">No complaint recorded at arrival</span>}</div>
            <div className="mt-5 flex flex-wrap gap-2">{vit(next).map(([l, v, u]) => <span key={String(l)} className="inline-flex items-baseline gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-[13px]"><span className="text-[11px] text-[#a9a59c]">{l}</span><b>{v}</b>{u && <span className="text-[11px] text-[#a9a59c]">{u}</span>}</span>)}</div>
            <div className="mt-6 flex items-center gap-3"><button className="btn btn-accent !px-6 !py-3" disabled={open.isPending} onClick={() => open.mutate(next.id)}>{next.status === 'in_consult' ? 'Continue' : 'Call in'}</button><button className="btn !bg-white/12 !text-white !border-transparent" onClick={() => nav(`/patients/${next.patient.id}`)}>Open record</button></div>
          </section>
        ) : <section className="glass p-6 anim-fade-up"><Empty icon="check" title="Nobody waiting" hint="The next arrival appears here with their complaints and vitals." /></section>}

        <section className="glass p-5 anim-fade-up min-w-0" style={{ animationDelay: '100ms' }}>
          <div className="flex items-center"><div className="text-[15px] font-semibold">Then waiting</div><span className="ml-auto text-xs text-muted">{queue.length} more</span></div>
          {queue.length === 0 ? <div className="py-8 text-center text-sm text-muted">No one else waiting</div> : <div className="mt-2">{queue.slice(0, 5).map((v: any) => (
            <div key={v.id} className="flex items-center gap-3 py-3 border-t border-ink/7 first:border-t-0"><Avatar name={v.patient.fullName} /><div className="flex-1 min-w-0"><div className="font-semibold truncate">{v.patient.fullName} <span className="text-xs text-muted font-normal">{v.patient.ageYears ?? ''} {v.patient.sex ?? ''}</span></div><div className="text-xs text-muted truncate">{v.details?.complaint ?? 'No complaint noted'}</div></div>
              {v.priority > 0 ? <Chip tone="amber">Priority</Chip> : v.status === 'intake' ? <Chip tone="sky">Intake</Chip> : <Chip>{minsSince(v.arrivedAt)} min</Chip>}</div>))}</div>}
        </section>
      </div>

      <div className="grid md:grid-cols-2 gap-5 mt-5">
        <section className="glass p-5 anim-fade-up min-w-0" style={{ animationDelay: '140ms' }}>
          <div className="flex items-center"><div className="text-[15px] font-semibold">On you today</div><span className="ml-auto text-xs text-muted">procedures</span></div>
          {!cal.data || cal.data.procedures.filter((p: any) => p.practitionerId === me.practitionerId).length === 0 ? <div className="py-6 text-sm text-muted">No procedures on you today.</div> :
            <div className="mt-2">{cal.data.procedures.filter((p: any) => p.practitionerId === me.practitionerId).map((p: any) => (
              <div key={p.id} className="flex items-center gap-3 py-2.5 border-t border-ink/7 first:border-t-0"><Chip>{p.startTime}</Chip><div className="flex-1 min-w-0"><div className="text-sm font-semibold truncate">{p.procedure ?? 'Procedure'} · {p.patient}</div><div className="text-xs text-muted">{p.room ?? 'no room'} · sitting {p.sittingNo}</div></div><Chip tone={p.state === 'completed' ? 'sage' : 'sky'}>{p.state.replace('_', ' ')}</Chip></div>))}</div>}
        </section>
        <section className="glass p-5 anim-fade-up min-w-0" style={{ animationDelay: '180ms' }}>
          <div className="flex items-center"><div className="text-[15px] font-semibold">Plans that need your eye</div><span className="ml-auto text-xs text-muted">{needReview.length}</span></div>
          {needReview.length === 0 ? <div className="py-6 text-sm text-muted">Nothing waiting for review.</div> :
            <div className="mt-2">{needReview.slice(0, 4).map((r: any) => (
              <div key={r.id} className="flex items-center gap-3 py-2.5 border-t border-ink/7 first:border-t-0"><div className="flex-1 min-w-0"><div className="text-sm font-semibold truncate">{r.procedure} · {r.patient.fullName}</div><div className="text-xs text-muted">{r.sittings ? `${r.sittings} sittings` : ''}{r.dueOn ? ` · wanted ${fmtDate(r.dueOn)}` : ''}</div></div><button className="btn btn-sm" onClick={() => nav('/worklist')}>Open</button></div>))}</div>}
        </section>
      </div>
    </div>
  );
}

function Stat({ n, l, tone }: { n: number; l: string; tone?: boolean }) {
  return <div><div className={`text-[26px] font-semibold leading-none tracking-tight ${tone ? 'text-clay' : ''}`}><Num value={n} /></div><div className="mt-1 text-[12.5px] text-muted">{l}</div></div>;
}
