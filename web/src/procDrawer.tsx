import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { get, patch, qc, today, errText } from './api';
import { Chip, Icon, Skeleton, toast, useScrollLock } from './ui';
import { FlagChips } from './flags';

const STATE: Record<string, { label: string; tone: '' | 'sage' | 'amber' | 'rose' | 'sky' }> = {
  confirmed: { label: 'scheduled', tone: 'sky' }, in_progress: { label: 'in progress', tone: 'amber' }, completed: { label: 'done', tone: 'sage' },
  missed: { label: 'missed', tone: 'rose' }, cancelled: { label: 'cancelled', tone: 'rose' }, postponed: { label: 'postponed', tone: 'amber' },
};
const dayLabel = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
const Head = ({ children }: { children: string }) => <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-muted">{children}</div>;
/** "fluence 18 · spot 10" from a sitting's recorded outcome. */
const outcomeText = (o: any) => (o && typeof o === 'object' ? Object.entries(o).filter(([, v]) => v !== null && v !== '' && typeof v !== 'object').map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join(' · ') : '');

/** One procedure sitting, opened from the Calendar: only what the doctor needs for this procedure. The full record is one click away. */
export function ProcedureDrawer({ id, canAct, onClose }: { id: string; canAct: boolean; onClose: () => void }) {
  useScrollLock();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['procedure-session', id], queryFn: () => get(`/procedure-sessions/${id}`) });
  const setState = useMutation({ mutationFn: (state: 'in_progress' | 'completed') => patch(`/procedure-sessions/${id}`, { state }),
    onSuccess: (_r, state) => { ['procedure-session', 'calendar', 'psessions', 'pcounts', 'worklist'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); toast(state === 'completed' ? 'Sitting marked done' : 'Sitting started'); },
    onError: (e) => toast(errText(e), 'err') });
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  const s = q.data;
  const p = s?.patient;
  const conditions: any[] = p?.history?.conditions ?? [];
  const asked = conditions.length > 0 || (p?.history?.none ?? []).includes('conditions');

  return createPortal(
    <div className="fixed inset-0 z-40 anim-fade-in" style={{ background: 'rgba(28,27,25,.28)', backdropFilter: 'blur(3px)' }} onClick={onClose}>
      <aside role="dialog" aria-label="Procedure sitting" className="absolute inset-y-0 right-0 flex w-full max-w-[420px] flex-col gap-4 overflow-y-auto bg-surface p-5 anim-slide-in sm:p-6" style={{ boxShadow: '-30px 0 60px -30px rgba(40,30,20,.45)' }} onClick={(e) => e.stopPropagation()}>
        {q.isError ? <div className="text-sm text-rose">{errText(q.error)}</div> : !s ? <Skeleton rows={6} /> : (<>
          <div className="flex items-center gap-2">
            <Chip tone={STATE[s.state]?.tone ?? ''}>{STATE[s.state]?.label ?? s.state}</Chip>
            <span className="truncate text-xs text-muted">Procedure sitting{s.patientConfirmedAt ? ' · patient confirmed' : ''}</span>
            <button className="btn btn-ghost btn-icon ml-auto" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2"><span className="text-2xl font-semibold">{p.fullName}</span><FlagChips flags={p.flags} /></div>
            <div className="text-sm text-muted">{[p.patientNo, [p.ageYears, p.sex].filter(Boolean).join(' '), p.phone].filter(Boolean).join(' · ')}</div>
          </div>

          <div className="glass !rounded-[10px] p-4">
            <b>{s.procedure ?? 'Procedure'} · sitting {s.sittingNo}{s.plan?.sittings ? ` of ${s.plan.sittings}` : ''}</b>
            <div className="mt-1 text-sm text-muted">{dayLabel(s.day)} · {s.startTime}–{s.endTime}</div>
            <div className="text-sm text-muted">{[s.room, s.doctor ?? 'no doctor yet', s.supervisor ? `supervised by ${s.supervisor}` : null].filter(Boolean).join(' · ')}</div>
            {s.notes && <div className="mt-2 rounded-xl bg-paper px-3 py-2 text-sm">“{s.notes}”</div>}
            {s.stateReason && <div className="mt-2 text-sm text-amber">Reason: {s.stateReason}</div>}
          </div>
          {canAct && s.state === 'confirmed' && s.day === today() && <button className="btn btn-primary justify-center" disabled={setState.isPending} onClick={() => setState.mutate('in_progress')}><Icon name="check" />Start sitting</button>}
          {canAct && s.state === 'in_progress' && <button className="btn btn-primary justify-center" disabled={setState.isPending} onClick={() => setState.mutate('completed')}><Icon name="check" />Mark done</button>}

          <div>
            <Head>Before you start</Head>
            <div className="space-y-1.5 text-sm">
              <div className="flex items-start gap-2"><span className="w-28 shrink-0 text-muted">Allergies</span>{p.allergies ? <b className="text-rose">{p.allergies}</b> : <span className="text-muted">None recorded</span>}</div>
              <div className="flex items-start gap-2"><span className="w-28 shrink-0 text-muted">Conditions</span>
                {conditions.length ? <span className="flex flex-wrap gap-1">{conditions.map((c) => <Chip key={c.name} tone="amber">{c.name}{c.note ? ` · ${c.note}` : ''}</Chip>)}</span> : <span className="text-muted">{asked ? 'None' : 'Not asked yet'}</span>}</div>
            </div>
          </div>

          {s.plan && (s.plan.diagnosis.length > 0 || s.plan.notes) && (
            <div>
              <Head>Doctor's plan</Head>
              {s.plan.diagnosis.length > 0 && <div className="text-sm"><span className="text-muted">For </span><b>{s.plan.diagnosis.join(', ')}</b></div>}
              {s.plan.notes && <div className="mt-1 rounded-xl bg-paper px-3 py-2 text-sm">{s.plan.notes}</div>}
              {s.plan.plannedOn && <div className="mt-1 text-xs text-muted">Planned {new Date(s.plan.plannedOn).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</div>}
            </div>
          )}

          {s.sittings.length > 1 && (
            <div>
              <Head>Sittings</Head>
              {s.sittings.map((x: any) => (
                <div key={x.id} className={`flex items-start gap-2 border-t border-line/60 py-1.5 text-sm first:border-t-0 ${x.id === s.id ? 'font-semibold' : ''}`}>
                  <span className="w-6 shrink-0 text-muted">{x.sittingNo}</span>
                  <span className="min-w-0 flex-1">{dayLabel(x.day)} {x.startTime}{(x.notes || outcomeText(x.outcome)) && <span className="block text-xs font-normal text-muted">{[outcomeText(x.outcome), x.notes].filter(Boolean).join(' · ')}</span>}</span>
                  <Chip tone={STATE[x.state]?.tone ?? ''} className="!text-[10.5px]">{x.id === s.id ? 'this one' : STATE[x.state]?.label ?? x.state}</Chip>
                </div>))}
            </div>
          )}

          <div className="mt-auto flex flex-wrap gap-2 border-t border-line pt-4">
            <button className="btn btn-sm" onClick={() => { onClose(); nav(`/patients/${p.id}`); }}><Icon name="user" />Open full record</button>
          </div>
        </>)}
      </aside>
    </div>
  , document.body);
}
