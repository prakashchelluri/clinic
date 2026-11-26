import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { get, patch, post, qc, today, errText, useMe } from './api';
import { Chip, Drawer, Icon, Skeleton, ask, money, toast } from './ui';
import { FlagChips } from './flags';
import { PhotoCapture, usePhotos } from './photos';
import { ScheduleModal } from './pages/Worklist';
import { ConsentForm, ConsentNote, procedureConsentText } from './consent';

// invoiced: the whole treatment is on an invoice; amountPaise is what is still owed on it. on_done: not invoiced yet; marking a session done invoices the whole treatment (amountPaise)
type Money = { kind: 'invoiced' | 'on_done' | 'due' | 'paid' | 'none'; amountPaise: number } | null | undefined;
/** "On invoice", "₹2,500 due", "Paid" or "No price on the list", for a sitting row or the drawer. Nothing when the user cannot see fees. */
export function MoneyChip({ m }: { m: Money }) {
  if (!m) return null;
  return m.kind === 'invoiced' ? <Chip tone="sky">On invoice · {money(m.amountPaise)} to pay</Chip> : m.kind === 'paid' ? <Chip tone="sage">Paid</Chip> : m.kind === 'on_done' ? <Chip>{money(m.amountPaise)} to invoice when done</Chip> : m.kind === 'due' ? <Chip tone="amber">{money(m.amountPaise)} due</Chip> : <Chip tone="rose">No price on the list</Chip>;
}
/** Consent kept on the patient per procedure: "Consent on file" or "Consent needed". */
type Consent = { consentNeeded?: boolean; consentExpired?: boolean; consent?: { grantedAt: string; by: string; how?: string; documentId?: string } | null };
export function ConsentChip({ s }: { s: Consent }) {
  if (s.consentNeeded) return <Chip tone="amber">{s.consentExpired ? 'Consent expired, sign again' : 'Consent needed'}</Chip>;
  return s.consent ? <Chip tone="sage">Consent on file</Chip> : null;
}
export { ConsentNote };

/** Before the first sitting of a procedure: the patient reads the wording and signs on the tablet (saved as the patient's document), or staff confirm the paper form is filed. */
export function ConsentDialog({ s, onClose, onStart }: { s: { id: string; procedure?: string | null; consentText?: string | null; consentExpired?: boolean; patient: { id: string; fullName: string } }; onClose: () => void; onStart: (b: { state: 'in_progress'; consent: true; consentDocumentId?: string; consentWording?: string }) => void }) {
  const what = s.procedure ?? 'this procedure'; const text = procedureConsentText(s.patient.fullName, what, s.consentText);
  return <ConsentForm title={`Consent for ${what}`} subtitle={s.consentExpired ? `${s.patient.fullName} · the last consent has run out, so it is signed again` : undefined} text={text} patient={s.patient} procedureSessionId={s.id} okLabel="Save and start" onClose={onClose}
    onDone={(id) => onStart({ state: 'in_progress', consent: true, ...(id ? { consentDocumentId: id, consentWording: text } : {}) })} />;
}
/** Marking done makes the charge, so the desk is told what it will be first. */
export async function confirmDone(s: { procedure?: string | null; sittingNo: number; of?: number | null; patient: { fullName: string }; money?: Money }) {
  // billing is the desk's business: a doctor just gets the question
  const m = (qc.getQueryData(['me']) as any)?.practitionerId ? null : s.money; const what = s.procedure ?? 'the procedure';
  const body = !m ? undefined : m.kind === 'on_done' ? <>An invoice of <b>{money(m.amountPaise)}</b> for {what} is made now. Any advance the patient has paid is used first; the rest is due at the desk.</>
    : m.kind === 'due' ? <><b>{money(m.amountPaise)}</b> becomes due for this session.</>
    : m.kind === 'invoiced' ? <>Already on the patient's invoice. Nothing new is charged.</>
    : m.kind === 'paid' ? <>Already paid. Nothing new is charged.</> : <>No price is set, so nothing is charged.</>;
  return !!(await ask({ title: `Mark ${what} session ${s.sittingNo}${s.of ? ` of ${s.of}` : ''} done for ${s.patient.fullName.split(' ')[0]}?`, body, confirmLabel: 'Mark done', cancelLabel: 'Not yet' }));
}

const STATE: Record<string, { label: string; tone: '' | 'sage' | 'amber' | 'rose' | 'sky' }> = {
  confirmed: { label: 'Booked', tone: 'sky' }, in_progress: { label: 'In progress', tone: 'amber' }, completed: { label: 'Completed', tone: 'sage' },
  missed: { label: 'No show', tone: 'rose' }, cancelled: { label: 'Cancelled', tone: 'rose' }, postponed: { label: 'Postponed', tone: 'amber' },
};
const dayLabel = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
const Head = ({ children }: { children: string }) => <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-muted">{children}</div>;
/** "fluence 18 · spot 10" from a sitting's recorded outcome. */
const outcomeText = (o: any) => (o && typeof o === 'object' ? Object.entries(o).filter(([, v]) => v !== null && v !== '' && typeof v !== 'object').map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join(' · ') : '');

/** One procedure sitting, opened from the Calendar: only what the doctor needs for this procedure. The full record is one click away. */
export function ProcedureDrawer({ id, canAct, onClose, extra }: { id: string; canAct: boolean; onClose: () => void; extra?: React.ReactNode }) {
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['procedure-session', id], queryFn: () => get(`/procedure-sessions/${id}`) });
  const [signing, setSigning] = useState(false);
  const [shoot, setShoot] = useState<'before' | 'after' | null>(null); const [booking, setBooking] = useState(false); const [moving, setMoving] = useState(false);
  const setState = useMutation({ mutationFn: (b: { state: 'in_progress' | 'completed'; consent?: boolean; consentDocumentId?: string; consentWording?: string }) => patch(`/procedure-sessions/${id}`, b),
    onSuccess: (_r, b) => { setSigning(false); if (b.state === 'in_progress' && s?.form) nav(`/procedure-sessions/${id}`); ['procedure-session', 'calendar', 'psessions', 'pcounts', 'worklist', 'timeline', 'bills', 'courses', 'advance', 'procedure-plans'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); toast(b.state === 'completed' ? `Session marked done${s?.money?.kind === 'on_done' ? ` · treatment invoiced, ${money(s.money.amountPaise)}` : s?.money?.kind === 'due' ? ` · ${money(s.money.amountPaise)} due` : ''}` : 'Session started'); },
    onError: (e) => toast(errText(e), 'err') });
  const s = q.data;
  // waiting for the signed-in doctor: approve or send back right here, as on the Calendar
  const me = useMe(); const toApprove = !!s && s.state === 'confirmed' && s.approval === 'sent' && !!me.data?.practitionerId && s.practitionerId === me.data.practitionerId;
  const decide = useMutation({ mutationFn: (b: { action: 'approve' | 'change'; note?: string }) => post('/procedure-approvals', { ids: [id], ...b }),
    onSuccess: (_r, b) => { ['procedure-session', 'calendar', 'psessions', 'pcounts', 'pweek', 'worklist', 'followups'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); toast(b.action === 'approve' ? 'Approved. The patient gets a reminder the day before.' : 'Sent back to the coordinator with your note.'); },
    onError: (e) => toast(errText(e), 'err') });
  const sendBack = async () => { const a = await ask({ title: 'Send this session back to the coordinator?', body: 'It stays booked, flagged for the coordinator to move.', confirmLabel: 'Send back', cancelLabel: 'Keep it', field: { label: 'What should change', maxLength: 200 } }); if (a) decide.mutate({ action: 'change', note: a.value || undefined }); };
  const p = s?.patient;
  const conditions: any[] = p?.history?.conditions ?? [];
  const asked = conditions.length > 0 || (p?.history?.none ?? []).includes('conditions');
  // this sitting's photos, before and after (the title says which)
  const photos = usePhotos(p?.id ?? '');
  const mine: any[] = (photos.data?.photos ?? []).filter((x: any) => (x.sitting?.id ?? x.procedureSessionId) === id);
  const nBefore = mine.filter((x) => /^Before ·/.test(x.title ?? '')).length, nAfter = mine.filter((x) => /^After ·/.test(x.title ?? '')).length;
  const label = s ? `${s.procedure ?? 'Procedure'} · session ${s.sittingNo}${s.plan?.sittings ? ` of ${s.plan.sittings}` : ''}` : '';
  // more sittings to come and none booked yet: reception books the next tentative date right here
  const nextSit: any = (s?.sittings ?? []).find((x: any) => x.state === 'confirmed' && x.id !== id); const nextBooked = !!nextSit; // sittings come oldest first
  const [movingNext, setMovingNext] = useState(false);
  // booked, and its time went by without it starting: the patient didn't come (the calendar shows it red); reception reschedules or marks it missed
  const nowT = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
  const overdue = !!s && s.state === 'confirmed' && (s.day < today() || (s.day === today() && s.endTime <= nowT));
  const refresh = () => ['procedure-session', 'psessions', 'worklist', 'calendar', 'pcounts'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  const markMissed = useMutation({ mutationFn: () => patch(`/procedure-sessions/${id}`, { state: 'missed' }), onSuccess: () => { refresh(); toast('Marked as missed'); }, onError: (e) => toast(errText(e), 'err') });
  const more = !!s && s.state === 'completed' && !nextBooked && (!s.plan?.sittings || s.sittingNo < s.plan.sittings);

  return (
    <Drawer title={p ? <span className="flex flex-wrap items-center gap-2">{p.fullName}<FlagChips flags={p.flags} /></span> : 'Procedure session'} subtitle={p ? [p.patientNo, [p.ageYears, p.sex].filter(Boolean).join(' '), p.phone].filter(Boolean).join(' · ') : undefined} width="max-w-md" onClose={onClose}>
      <div className="flex flex-1 flex-col gap-4">
        {q.isError ? <div className="text-sm text-rose">Couldn't load. {errText(q.error)} <button className="btn btn-sm ml-1" onClick={() => q.refetch()}>Retry</button></div> :!s ? <Skeleton rows={6} /> : (<>
          {/* the sitting's state and money as one row of tags (who it is sits in the drawer's title) */}
          <div>
            <div className="flex flex-wrap items-center gap-1.5 [&_.chip]:whitespace-nowrap">
              {overdue ? <Chip tone="rose">No show</Chip> : <Chip tone={STATE[s.state]?.tone ?? ''}>{STATE[s.state]?.label ?? s.state}</Chip>}
              {/* the doctor's approval and the patient's yes are two separate things: show both while it is booked */}
              {s.state === 'confirmed' && !overdue && (s.approval === 'approved' ? <Chip tone="sage">{s.approvedBy ? `Approved by ${s.approvedBy}` : 'Approved'}</Chip>
                : s.approval === 'sent' ? <Chip tone="amber">{toApprove ? 'To approve' : s.changed ? 'Changed · approval pending' : 'Approval pending'}</Chip>
                : s.approval === 'change' ? <Chip tone="rose">Change asked</Chip> : <Chip>Not sent for approval</Chip>)}
              {s.patientConfirmedAt ? <Chip tone="sage">Patient confirmed</Chip> : s.state === 'confirmed' && !overdue && <Chip tone="amber">Patient not confirmed</Chip>}
              <MoneyChip m={s.money} />
            </div>
          </div>

          <div className="glass !rounded-[10px] p-4">
            <b>{s.procedure ?? 'Procedure'} · session {s.sittingNo}{s.plan?.sittings ? ` of ${s.plan.sittings}` : ''}</b>
            <div className="mt-1 text-sm text-muted">{dayLabel(s.day)} · {s.startTime}–{s.endTime}</div>
            <div className="text-sm text-muted">{[s.room, s.doctor ?? 'no doctor yet', s.supervisor ? `supervised by ${s.supervisor}` : null].filter(Boolean).join(' · ')}</div>
            {s.notes && <div className="mt-2 rounded-xl bg-paper px-3 py-2 text-sm">“{s.notes}”</div>}
            {s.stateReason && <div className="mt-2 text-sm text-amber">Reason: {s.stateReason}</div>}
          </div>
          {canAct && s.state === 'confirmed' && s.day === today() && <button className="btn btn-primary justify-center" disabled={setState.isPending} onClick={() => s.consentNeeded ? setSigning(true) : setState.mutate({ state: 'in_progress' })}><Icon name="check" />Start session</button>}
          {canAct && (overdue || ['missed', 'postponed'].includes(s.state)) && <div className="rounded-[10px] border border-rose/25 bg-rose-soft/50 p-4">
            <div className="font-semibold">{overdue ? 'The patient did not come for this session' : s.state === 'missed' ? 'No show for this session' : 'This session was postponed'}</div>
            <div className="mt-0.5 text-sm text-muted">Pick a new date and time with the patient. The course and its session number stay the same.</div>
            <div className="mt-3 flex flex-wrap gap-2"><button className="btn btn-primary" onClick={() => setMoving(true)}><Icon name="calendar" />Reschedule</button>
              {overdue && <button className="btn" disabled={markMissed.isPending} onClick={() => markMissed.mutate()}>Mark as missed</button>}</div>
          </div>}
          {/* any booked sitting can move, the same as a consultation; a missed one gets the red box above */}
          {canAct && s.state === 'confirmed' && !overdue && <button className="btn justify-center" onClick={() => setMoving(true)}><Icon name="calendar" />Reschedule</button>}
          {signing && <ConsentDialog s={s} onClose={() => setSigning(false)} onStart={(b) => setState.mutate(b)} />}
          {canAct && s.state === 'in_progress' && <button className="btn btn-primary justify-center" disabled={setState.isPending} onClick={async () => { if (s.form && s.missing?.length) { toast(`Fill these first: ${s.missing.join(', ')}.`, 'err'); nav(`/procedure-sessions/${id}`); return; } if (await confirmDone({ ...s, of: s.plan?.sittings })) setState.mutate({ state: 'completed' }); }}><Icon name="check" />Mark done</button>}
          {['confirmed', 'in_progress', 'completed'].includes(s.state) && <button type="button" className="btn justify-center" onClick={() => { onClose(); nav(`/procedure-sessions/${id}`); }}><Icon name="list" />{s.form ? (s.state === 'completed' ? 'Open procedure form' : `Open procedure form${s.missing?.length ? ` · ${s.missing.length} required left` : ''}`) : 'Open procedure page'}</button>}

          {canAct && ['confirmed', 'in_progress', 'completed'].includes(s.state) && <div>
            <Head>Photos of this session</Head>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className="btn btn-sm" onClick={() => setShoot('before')}><Icon name="spark" className="h-3.5 w-3.5" />Before photo{nBefore ? ` · ${nBefore}` : ''}</button>
              {s.state !== 'confirmed' && <button type="button" className="btn btn-sm" onClick={() => setShoot('after')}><Icon name="spark" className="h-3.5 w-3.5" />After photo{nAfter ? ` · ${nAfter}` : ''}</button>}
              {!nBefore && s.state === 'in_progress' && <span className="text-[12.5px] text-amber">No before photo yet</span>}
            </div>
          </div>}
          {/* done with more to come: the next sitting the plan booked (or reception did), with Change date; else Book next sitting */}
          {s.state === 'completed' && nextSit && <div className="rounded-[10px] border border-line bg-surface-2 px-4 py-3">
            <div className="flex flex-wrap items-center gap-2"><span className="text-[13.5px] font-semibold">Next: session {nextSit.sittingNo}{s.plan?.sittings ? ` of ${s.plan.sittings}` : ''}</span>{nextSit.autoBooked && <Chip tone="sky">Booked by the plan</Chip>}</div>
            <div className="mt-0.5 text-[14px]">{new Date(nextSit.day + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })} · {nextSit.startTime}</div>
            <div className="mt-0.5 text-[12.5px] text-muted">{nextSit.autoBooked ? 'Tell the patient now; the coordinator confirms it with them the week before.' : 'Tentative until the doctor approves the week.'}</div>
            {canAct && <button type="button" className="btn btn-sm mt-2" onClick={() => setMovingNext(true)}><Icon name="calendar" className="h-3.5 w-3.5" />Change date</button>}
          </div>}
          {canAct && more && <div className="rounded-[10px] border border-clay-line bg-clay-soft px-4 py-3">
            <div className="text-[13.5px] font-semibold text-clay-ink">Book the next session</div>
            <div className="mt-0.5 text-[12.5px] text-muted">{s.plan?.sittings ? `Session ${s.sittingNo + 1} of ${s.plan.sittings}. ` : ''}Pick a date with the patient now; it is tentative until the doctor approves the week.</div>
            <button type="button" className="btn btn-primary btn-sm mt-2" onClick={() => setBooking(true)}>Book next session</button>
          </div>}

          <div>
            <Head>Before you start</Head>
            <div className="space-y-1.5 text-sm">
              <div className="flex items-start gap-2"><span className="w-28 shrink-0 text-muted">Consent</span>{s.consentNeeded ? <ConsentChip s={s} /> : s.consent ? <span><ConsentChip s={s} /> <ConsentNote c={s.consent} /></span> : <span className="text-muted">Not needed</span>}</div>
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
              <Head>Sessions</Head>
              {s.sittings.map((x: any) => (
                <div key={x.id} className={`flex items-start gap-2 border-t border-line/60 py-1.5 text-sm first:border-t-0 ${x.id === s.id ? 'font-semibold' : ''}`}>
                  <span className="w-6 shrink-0 text-muted">{x.sittingNo}</span>
                  <span className="min-w-0 flex-1">{dayLabel(x.day)} {x.startTime}{(x.notes || outcomeText(x.outcome)) && <span className="block text-xs font-normal text-muted">{[outcomeText(x.outcome), x.notes].filter(Boolean).join(' · ')}</span>}</span>
                  <Chip tone={STATE[x.state]?.tone ?? ''} className="!text-[10.5px]">{x.id === s.id ? 'this one' : STATE[x.state]?.label ?? x.state}</Chip>
                </div>))}
            </div>
          )}

          <div className="mt-auto flex flex-wrap gap-2 border-t border-line pt-4">
            {toApprove && <><button className="btn btn-sm btn-primary" disabled={decide.isPending} onClick={() => decide.mutate({ action: 'approve' })}><Icon name="check" />Approve</button><button className="btn btn-sm" disabled={decide.isPending} onClick={sendBack}>Send back</button></>}
            {extra}<button className="btn btn-sm" onClick={() => { onClose(); nav(`/patients/${p.id}`); }}><Icon name="eye" />View full profile</button>
          </div>
        </>)}
        {shoot && s && <PhotoCapture patient={{ id: p.id, fullName: p.fullName }} sitting={{ id, label: `${label} · ${shoot}` }} phase={shoot} onClose={() => { setShoot(null); qc.invalidateQueries({ queryKey: ['photos', p.id] }); }} />}
        {movingNext && s && nextSit && <ScheduleModal rec={{ id: s.recommendationId, procedureId: s.procedureId, patient: { fullName: p.fullName, phone: p.phone }, sittings: s.plan?.sittings }} sitting={nextSit} onClose={() => { setMovingNext(false); refresh(); }} />}
        {moving && s && <ScheduleModal rec={{ id: s.recommendationId, procedureId: s.procedureId, patient: { fullName: p.fullName, phone: p.phone }, sittings: s.plan?.sittings }} sitting={s} onClose={() => { setMoving(false); refresh(); }} />}
        {booking && s && <ScheduleModal rec={{ id: s.recommendationId, procedureId: s.procedureId, patient: { fullName: p.fullName, phone: p.phone }, sittings: s.plan?.sittings }} onClose={() => { setBooking(false); ['procedure-session', 'psessions', 'worklist', 'calendar'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); }} />}
      </div>
    </Drawer>
  );
}
