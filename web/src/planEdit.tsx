import { Fragment, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useOutletContext } from 'react-router';
import { api, post, errText, qc } from './api';
import { can } from './App';
import { Drawer, Icon, Modal, NumInput, money, toast } from './ui';

const refresh = () => ['timeline', 'courses', 'worklist', 'calendar', 'psessions', 'procedure-plans'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
const addMonthsTo = (n: number) => { const d = new Date(); d.setMonth(d.getMonth() + n); return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); };
const todayStr = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const SAY: Record<string, string> = { NEEDS_A_CONSULTATION: 'A doctor has to see the patient first: a procedure or package hangs off a consultation.', VALID_TILL_IN_THE_PAST: 'Valid till cannot be in the past.', SESSIONS_ALREADY_DONE_OR_BOOKED: 'Sessions done or booked cannot be taken away.', A_PACKAGE_IS_CANCELLED_WHOLE: 'A package is cancelled as a whole.', NO_PRICE_ON_THE_PRICE_LIST: 'This procedure has no price yet. Set it in Settings › Procedures & packages.' };
const say = (e: any) => SAY[e?.body?.code] ?? errText(e);

function ValidTill({ date, none, onDate, onNone }: { date: string; none: boolean; onDate: (v: string) => void; onNone: (v: boolean) => void }) {
  return (
    <div><span className="label">Valid till</span>
      <div className="flex flex-wrap items-center gap-3"><input type="date" aria-label="Valid till" className="input !w-44" min={todayStr()} value={none ? '' : date} disabled={none} onChange={(e) => onDate(e.target.value)} />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-ink" checked={none} onChange={(e) => onNone(e.target.checked)} />No expiry</label></div></div>);
}

/** What taking k invoiced sessions off a course credits: each invoice line at its own price per session, the newest first (as the server does). */
function creditFor(c: any, k: number) {
  let left = k; let sum = 0;
  for (const l of c.sessionLines ?? []) { if (!left) break; const n = Math.min(left, l.sessions); sum += n === l.sessions ? l.netPaise : Math.round((l.netPaise * n) / l.sessions); left -= n; }
  return sum;
}

const LIVE = (s: any) => ['confirmed', 'in_progress', 'completed'].includes(s.state);
/** Edit a procedure or a package: valid till, and for each procedure its number of sessions (and its gap). Done and booked sessions stay. */
export function EditPlanDrawer({ plans, sessions, courses, procName, onClose }: { plans: any[]; sessions: any[]; courses: any[]; procName: (r: any) => string; onClose: () => void }) {
  const { cfg } = useOutletContext<any>();
  const pk = plans[0].package; const course0 = courses.find((c) => c.recommendationId === plans[0].id);
  const initNone = course0 ? !course0.validUntil : plans[0].noExpiry || (!plans[0].validUntil && !pk);
  const [none, setNone] = useState<boolean>(initNone); const [date, setDate] = useState<string>(course0?.validUntil ?? plans[0].validUntil ?? (pk ? addMonthsTo(pk.validMonths) : ''));
  const [ns, setNs] = useState<Record<string, number>>(Object.fromEntries(plans.map((r) => [r.id, courses.find((c) => c.recommendationId === r.id)?.sittings ?? r.sittings ?? 1])));
  const [gaps, setGaps] = useState<Record<string, string>>(Object.fromEntries(plans.map((r) => [r.id, String(r.gapDays ?? '')])));
  const [open, setOpen] = useState<string>(plans[0].id);
  const live = (r: any) => sessions.filter((s) => s.recommendationId === r.id && LIVE(s));
  const minOf = (r: any) => Math.max(1, ...live(r).map((s) => s.sittingNo));
  const std = (r: any) => cfg?.procedures?.find((p: any) => p.id === r.procedureId)?.pricePaise ?? 0;
  const deltaOf = (r: any) => { const c = courses.find((x) => x.recommendationId === r.id); const oldN = c?.sittings ?? r.sittings ?? 1; const newN = ns[r.id];
    const total = c?.totalPaise ?? (r.amountPaise > 0 ? r.amountPaise : null);
    const share = total != null ? Math.round(total / oldN) : std(r);
    if (newN > oldN) return (newN - oldN) * std(r);
    if (!c?.invoiced) return -(oldN - newN) * share;
    // invoiced: the sessions taken off come off at their own invoice line's price, the newest first (the same as the server);
    // sessions not invoiced yet just leave the price
    const inv = c.invoicedSessions ?? 0; const off = Math.max(0, inv - newN); const notInv = (oldN - newN) - off;
    return -(creditFor(c, off) + (c.uninvoicedSessions ? Math.round((c.uninvoicedPaise / c.uninvoicedSessions) * notInv) : 0)); };
  const delta = plans.reduce((s, r) => s + deltaOf(r), 0);
  const changed = plans.filter((r) => ns[r.id] !== (courses.find((c) => c.recommendationId === r.id)?.sittings ?? r.sittings ?? 1) || gaps[r.id] !== String(r.gapDays ?? ''));
  const validChanged = none !== initNone || (!none && date !== (course0?.validUntil ?? plans[0].validUntil ?? (pk ? addMonthsTo(pk.validMonths) : '')));
  const total = plans.reduce((s, r) => { const c = courses.find((x) => x.recommendationId === r.id); return s + (c ? (c.invoiced ? c.netPaise + c.uninvoicedPaise : c.totalPaise) : r.amountPaise > 0 ? r.amountPaise : std(r) * (r.sittings ?? 1)); }, 0);
  const doneN = plans.reduce((s, r) => s + live(r).filter((x) => x.state === 'completed').length, 0); const allN = plans.reduce((s, r) => s + ns[r.id], 0);
  const save = useMutation({
    mutationFn: () => api('PATCH', '/procedure-plans/edit', { plans: (validChanged ? plans : changed).map((r) => ({ id: r.id, ...(ns[r.id] !== (courses.find((c) => c.recommendationId === r.id)?.sittings ?? r.sittings ?? 1) ? { sittings: ns[r.id] } : {}), ...(gaps[r.id] !== String(r.gapDays ?? '') ? { gapDays: Number(gaps[r.id]) || 0 } : {}) })),
      ...(validChanged ? { noExpiry: none, ...(none ? {} : { validUntil: date }) } : {}) }),
    onSuccess: (rows: any) => { refresh(); ['bills', 'advance'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); const moved = (Array.isArray(rows) ? rows : []).reduce((s: number, x: any) => s + (x.toAdvancePaise ?? 0), 0);
      toast(`Saved${delta ? ` · ${delta > 0 ? '+' : '−'}${money(Math.abs(delta))}` : ''}${moved ? ` · ${money(moved)} moved to the advance` : ''}`); onClose(); },
    onError: (e) => toast(say(e), 'err'),
  });
  return (
    <Drawer title={pk ? 'Edit package' : 'Edit procedure'} subtitle={pk ? pk.name : procName(plans[0])} onClose={onClose} width="max-w-xl" dirty={changed.length > 0 || validChanged}>
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-2 rounded-lg bg-paper-2 px-3 py-2.5 text-sm"><div><div className="text-xs text-muted">{pk ? 'Package' : 'Procedure'}</div><b>{pk ? pk.name : procName(plans[0])}</b></div><div><div className="text-xs text-muted">Price</div><b>{money(total)}</b></div><div><div className="text-xs text-muted">Sessions</div><b>{doneN} of {allN} done</b></div></div>
        <ValidTill date={date} none={none} onDate={setDate} onNone={(v) => { setNone(v); if (!v && !date) setDate(addMonthsTo(pk?.validMonths ?? 12)); }} />
        {plans.map((r) => { const isOpen = !pk || open === r.id; const ls = live(r); const n = ns[r.id]; const min = minOf(r);
          return (
            <div key={r.id} className="rounded-lg border border-line">
              <button type="button" className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm" aria-expanded={isOpen} onClick={() => setOpen(isOpen && pk ? '' : r.id)} disabled={!pk}>
                {pk && <Icon name="up" className={`h-3.5 w-3.5 text-muted transition-transform ${isOpen ? '' : 'rotate-180'}`} />}<b>{procName(r)}</b><span className="text-muted">· {ls.filter((x) => x.state === 'completed').length}/{n} done</span>
                {deltaOf(r) !== 0 && <span className={`ml-auto text-xs ${deltaOf(r) > 0 ? 'text-amber' : 'text-sage'}`}>{deltaOf(r) > 0 ? '+' : '−'}{money(Math.abs(deltaOf(r)))}</span>}</button>
              {isOpen && <div className="space-y-1.5 border-t border-line px-3 py-2.5">
                <label className="flex items-center gap-2 text-sm text-muted">Every<NumInput aria-label={`Days between sessions of ${procName(r)}`} max={365} className="input !w-16 !py-1" value={gaps[r.id]} onChange={(e) => setGaps((g) => ({ ...g, [r.id]: e.target.value }))} />days</label>
                {Array.from({ length: n }, (_, i) => i + 1).map((k) => { const s = ls.filter((x) => x.sittingNo === k)[0]; const locked = !!s;
                  return <div key={k} className="flex items-center gap-2 text-sm"><span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] font-semibold ${s?.state === 'completed' ? 'bg-sage text-white' : 'border-2 border-sage/60 text-sage'}`}>{k}</span>
                    <span className="flex-1">Session {k} <span className="text-xs text-muted">{s ? (s.state === 'completed' ? `· done ${s.day}` : `· booked ${s.day}`) : '· not booked'}</span></span>
                    {!locked && k === n && n > min && <button type="button" className="btn btn-ghost btn-icon !h-7 !w-7" aria-label={`Remove session ${k}`} onClick={() => setNs((x) => ({ ...x, [r.id]: x[r.id] - 1 }))}><Icon name="x" className="h-3.5 w-3.5" /></button>}</div>; })}
                <button type="button" className="btn btn-sm btn-ghost" disabled={n >= 60} onClick={() => setNs((x) => ({ ...x, [r.id]: x[r.id] + 1 }))}><Icon name="plus" className="h-3.5 w-3.5" />Add session</button>
              </div>}
            </div>); })}
        {delta !== 0 && <div className="rounded-lg bg-amber-soft px-3 py-2 text-sm text-amber">{delta > 0 ? `Added sessions cost the standard price: +${money(delta)}, invoiced with Generate invoice or when the next session is done` : `Removed sessions come off the invoice as a credit note, at what a session was charged: −${money(-delta)}`}. New total {money(total + delta)}.</div>}
        <div className="modal-foot"><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={(!changed.length && !validChanged) || save.isPending || (!none && !date)} onClick={() => save.mutate()}><Icon name="check" />Save changes</button></div>
      </div>
    </Drawer>
  );
}

const MODES: ['upi' | 'cash' | 'card' | 'bank', string][] = [['upi', 'UPI'], ['cash', 'Cash'], ['card', 'Card'], ['bank', 'Bank']];
/** Cancel a procedure or a whole package: what is not done stops, booked sessions are cancelled, and what was paid ahead for them can be refunded now. */
export function CancelPlanDialog({ plans, sessions, courses, procName, onClose }: { plans: any[]; sessions: any[]; courses: any[]; procName: (r: any) => string; onClose: () => void }) {
  const { perms } = useOutletContext<any>();
  const pk = plans[0].package; const cs = plans.map((r) => courses.find((c) => c.recommendationId === r.id)).filter(Boolean);
  const live = (r: any) => sessions.filter((s) => s.recommendationId === r.id && LIVE(s));
  const booked = plans.flatMap((r) => live(r).filter((s) => s.state === 'confirmed').map((s) => ({ ...s, proc: procName(r) })));
  // paid on each treatment's invoice, and what of it pays for sessions not done: that moves to the patient's advance on cancelling
  const paid = cs.reduce((s, c: any) => s + c.advancePaise, 0);
  const back = cs.reduce((s, c: any) => s + (c.invoiced ? Math.max(0, c.paidPaise - (c.netPaise - creditFor(c, Math.max(0, (c.invoicedSessions ?? 0) - c.doneSittings)))) : 0), 0); // paid above what the sessions done now cost moves to the advance
  const mayRefund = can(perms, 'payment.refund') && back > 0;
  const [why, setWhy] = useState(''); const [refund, setRefund] = useState(false); const [mode, setMode] = useState<'upi' | 'cash' | 'card' | 'bank'>('upi');
  const go = useMutation({
    mutationFn: async () => {
      const r: any = await post('/procedure-plans/cancel', { ids: plans.map((r) => r.id), reason: why.trim() });
      if (refund && mayRefund && r.toAdvancePaise > 0) await post(`/patients/${plans[0].patientId}/advance/refund`, { idempotencyKey: `cancel-${plans.map((p) => p.id).join('-').slice(0, 60)}`, amountPaise: r.toAdvancePaise, method: mode, reason: `Cancelled: ${why.trim()}` });
      return r;
    },
    onSuccess: (r: any) => { refresh(); ['bills', 'advance'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); toast(`${pk ? pk.name : procName(plans[0])} cancelled${r.toAdvancePaise ? ` · ${money(r.toAdvancePaise)} ${refund && mayRefund ? 'refunded' : 'moved to the advance'}` : ''}`); onClose(); },
    onError: (e) => { refresh(); toast(say(e), 'err'); },
  });
  const done = plans.reduce((s, r) => s + live(r).filter((x) => x.state === 'completed').length, 0); const all = plans.reduce((s, r) => s + (r.sittings ?? 1), 0);
  return (
    <Modal title={`Cancel the ${pk ? `${pk.name} package` : procName(plans[0])}?`} onClose={onClose} width="max-w-lg">
      <div className="space-y-3 text-sm">
        <p>{done} of {all} sessions are done; the {all - done} not done stop.{booked.length ? <> {booked.length === 1 ? 'The booking' : 'The bookings'} on {booked.map((s) => `${new Date(s.day + 'T00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}${s.startTime ? ` at ${s.startTime}` : ''} (${s.proc}, session ${s.sittingNo})`).join(', ')} {booked.length === 1 ? 'is' : 'are'} cancelled.</> : null}</p>
        {pk && <div className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 text-[13px]">{plans.map((r) => <Fragment key={r.id}><span>{procName(r)}</span><span className="text-muted">{live(r).filter((x) => x.state === 'completed').length} of {r.sittings ?? 1} done</span></Fragment>)}</div>}
        {cs.length > 0 && <div className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 rounded-lg bg-paper-2 px-3 py-2.5"><span>Paid</span><b>{money(paid)}</b><span>For sessions not done: to the advance</span><b className="text-sage">{money(back)}</b></div>}
        <div><label className="label" htmlFor="cp-why">Reason</label><input id="cp-why" className="input" maxLength={200} placeholder="e.g. Patient moving to another city" value={why} onChange={(e) => setWhy(e.target.value)} /></div>
        {mayRefund ? <div className="space-y-2"><label className="flex items-center gap-2"><input type="checkbox" className="accent-ink" checked={refund} onChange={(e) => setRefund(e.target.checked)} />Also refund {money(back)} now</label>
          {refund && <div className="flex flex-wrap gap-1.5" role="group" aria-label="Refund by">{MODES.map(([m, l]) => <button key={m} type="button" aria-pressed={mode === m} className={`toggle-opt !py-1 ${mode === m ? 'on' : ''}`} onClick={() => setMode(m)}>{l}</button>)}</div>}</div>
          : back > 0 ? <div className="text-xs text-muted">{money(back)} stays in the patient's advance: Refund on Bills &amp; payments gives it back.</div> : null}
        <div className="modal-foot"><button type="button" className="btn btn-ghost" onClick={onClose}>Keep it</button><button type="button" className="btn !bg-rose-soft !text-rose" disabled={why.trim().length < 3 || go.isPending} onClick={() => go.mutate()}>{pk ? 'Cancel package' : 'Cancel procedure'}</button></div>
      </div>
    </Modal>
  );
}
