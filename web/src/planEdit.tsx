import { Fragment, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useOutletContext } from 'react-router';
import { api, post, errText, qc } from './api';
import { can } from './App';
import { Drawer, Icon, Modal, NumInput, money, toast } from './ui';
import { fullPrice, type Pkg } from './packages';

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

/** Add a procedure (its sessions and gap) or a package (its procedures, each with its sessions) to a patient, from their record. Prices are fixed. */
export function AddPlanDialog({ patientId, patientName, onClose }: { patientId: string; patientName: string; onClose: () => void }) {
  const { cfg } = useOutletContext<any>();
  const procs: any[] = (cfg?.procedures ?? []).filter((p: any) => p.active !== false && p.pricePaise > 0);
  const pkgs: Pkg[] = ((cfg?.tenant?.settings?.packages ?? []) as Pkg[]).filter((k) => k.active !== false && k.pricePaise > 0);
  const [mode, setMode] = useState<'procedure' | 'package'>(pkgs.length ? 'package' : 'procedure');
  const [pid, setPid] = useState(procs[0]?.id ?? ''); const p = procs.find((x) => x.id === pid);
  const [n, setN] = useState(String(p?.typicalSittings || 1)); const [gap, setGap] = useState('28');
  const [kid, setKid] = useState(pkgs[0]?.id ?? ''); const k = pkgs.find((x) => x.id === kid);
  const [doc, setDoc] = useState('');
  const [date, setDate] = useState(k ? addMonthsTo(k.validMonths) : ''); const [none, setNone] = useState(!pkgs.length);
  const pickMode = (m: 'procedure' | 'package') => { setMode(m); setNone(m === 'procedure'); setDate(m === 'package' && k ? addMonthsTo(k.validMonths) : ''); };
  const pickPkg = (id: string) => { setKid(id); const x = pkgs.find((y) => y.id === id); if (x && !none) setDate(addMonthsTo(x.validMonths)); };
  const sessions = Number(n) || 0;
  const items = mode === 'package' ? (k?.items ?? []).map((it) => ({ proc: procs.find((x) => x.id === it.procedureId) ?? cfg?.procedures?.find((x: any) => x.id === it.procedureId), n: it.sittings, gap: it.intervalDays }))
    : p ? [{ proc: p, n: sessions, gap: Number(gap) || 0 }] : [];
  const price = mode === 'package' ? k?.pricePaise ?? 0 : (p?.pricePaise ?? 0) * sessions; const full = mode === 'package' && k ? fullPrice(k, cfg?.procedures ?? []) : 0;
  const bad = mode === 'package' ? !k : !p || !(sessions >= 1 && sessions <= 60) || Number(gap) > 365;
  const add = useMutation({
    mutationFn: () => post('/procedure-plans/add', { patientId, ...(mode === 'package' ? { packageId: kid } : { procedureId: pid, sittings: sessions, gapDays: Number(gap) || 0 }), ...(doc ? { practitionerId: doc } : {}), noExpiry: none, ...(!none && date ? { validUntil: date } : {}) }),
    onSuccess: () => { refresh(); toast(`${mode === 'package' ? k?.name : p?.name} added for ${patientName.split(' ')[0]}. Book the first session from the card.`); onClose(); },
    onError: (e) => toast(say(e), 'err'),
  });
  return (
    <Modal title="Add procedure or package" subtitle={patientName} onClose={onClose} width="max-w-4xl">
      <div className="space-y-4">
        <div className="flex gap-1.5" role="group" aria-label="What">{([['procedure', 'Procedure'], ['package', 'Package']] as const).map(([v, l]) => <button key={v} type="button" aria-pressed={mode === v} disabled={v === 'package' && !pkgs.length} className={`toggle-opt ${mode === v ? 'on' : ''}`} onClick={() => pickMode(v)}>{l}</button>)}</div>
        {mode === 'package' ? (
          <div className="grid gap-3 sm:grid-cols-[1.4fr_1fr_auto]">
            <div><label className="label" htmlFor="ap-pkg">Package</label><select id="ap-pkg" className="input" value={kid} onChange={(e) => pickPkg(e.target.value)}>{pkgs.map((x) => <option key={x.id} value={x.id}>{x.name} · {money(x.pricePaise)}</option>)}</select></div>
            <div><label className="label" htmlFor="ap-doc">Conducted by</label><select id="ap-doc" className="input" value={doc} onChange={(e) => setDoc(e.target.value)}><option value="">The consulting doctor</option>{(cfg?.practitioners ?? []).map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></div>
            <div><span className="label">Price</span><div className="flex h-10 items-center gap-2"><b className="text-[15px]">{money(price)}</b>{full > price && <s className="text-sm text-muted">{money(full)}</s>}</div></div>
          </div>) : (
          <div className="grid gap-3 sm:grid-cols-[1.4fr_auto_auto_1fr_auto]">
            <div><label className="label" htmlFor="ap-proc">Procedure</label><select id="ap-proc" className="input" value={pid} onChange={(e) => { setPid(e.target.value); const x = procs.find((y) => y.id === e.target.value); if (x) setN(String(x.typicalSittings || 1)); }}>{procs.map((x) => <option key={x.id} value={x.id}>{x.name} · {money(x.pricePaise)} a session</option>)}</select></div>
            <div><span className="label">Sessions</span><div className="flex items-center gap-1"><button type="button" className="btn btn-icon" aria-label="One session less" disabled={sessions <= 1} onClick={() => setN(String(Math.max(1, sessions - 1)))}>−</button><NumInput aria-label="Sessions" max={60} className={`input !w-14 text-center ${sessions < 1 ? '!border-rose' : ''}`} value={n} onChange={(e) => setN(e.target.value)} /><button type="button" className="btn btn-icon" aria-label="One session more" disabled={sessions >= 60} onClick={() => setN(String(sessions + 1))}>+</button></div></div>
            <div><label className="label" htmlFor="ap-gap">Every</label><div className="flex items-center gap-1.5 text-sm"><NumInput id="ap-gap" max={365} className="input !w-16" value={gap} onChange={(e) => setGap(e.target.value)} />days</div></div>
            <div><label className="label" htmlFor="ap-doc">Conducted by</label><select id="ap-doc" className="input" value={doc} onChange={(e) => setDoc(e.target.value)}><option value="">The consulting doctor</option>{(cfg?.practitioners ?? []).map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></div>
            <div><span className="label">Price</span><div className="flex h-10 items-center gap-2"><b className="text-[15px]">{money(price)}</b><span className="text-xs text-muted">{sessions} × {money(p?.pricePaise ?? 0)}</span></div></div>
          </div>)}
        <ValidTill date={date} none={none} onDate={setDate} onNone={(v) => { setNone(v); if (!v && !date) setDate(k && mode === 'package' ? addMonthsTo(k.validMonths) : addMonthsTo(12)); }} />
        <div className="text-xs text-muted">The price comes from Settings › Procedures &amp; packages. A discount is given on the bill, not here.</div>
        <div><span className="label">Sessions</span>
          <div className="overflow-hidden rounded-lg border border-line"><table className="table"><thead><tr><th className="pl-4">Procedure</th><th>Sessions</th><th>Duration</th><th>Booking</th></tr></thead>
            <tbody>{items.map((it, i) => <tr key={i}><td className="pl-4 font-medium">{it.proc?.name ?? 'Procedure'}</td><td>{it.n}{it.n > 1 && it.gap ? <span className="text-muted"> · every {it.gap} days</span> : null}</td><td className="text-muted">{it.proc?.typicalMinutes ?? 30} min</td>
              <td className="text-xs text-muted">Session 1: book from the card after adding{it.n > 1 ? '; the rest are booked by the plan as each one is done' : ''}</td></tr>)}</tbody></table></div></div>
        <div className="modal-foot"><span className="mr-auto text-xs text-muted">Payment is taken on the bill, now or on the session day.</span><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={bad || add.isPending || (!none && !date)} onClick={() => add.mutate()}><Icon name="check" />{mode === 'package' ? 'Add package' : 'Add procedure'}</button></div>
      </div>
    </Modal>
  );
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
    const total = c?.totalPaise ?? (r.amountPaise > 0 ? r.amountPaise : null); const share = total != null ? Math.round(total / oldN) : std(r);
    return newN > oldN ? (newN - oldN) * std(r) : -(oldN - newN) * share; };
  const delta = plans.reduce((s, r) => s + deltaOf(r), 0);
  const changed = plans.filter((r) => ns[r.id] !== (courses.find((c) => c.recommendationId === r.id)?.sittings ?? r.sittings ?? 1) || gaps[r.id] !== String(r.gapDays ?? ''));
  const validChanged = none !== initNone || (!none && date !== (course0?.validUntil ?? plans[0].validUntil ?? (pk ? addMonthsTo(pk.validMonths) : '')));
  const total = plans.reduce((s, r) => s + (courses.find((c) => c.recommendationId === r.id)?.totalPaise ?? (r.amountPaise > 0 ? r.amountPaise : std(r) * (r.sittings ?? 1))), 0);
  const doneN = plans.reduce((s, r) => s + live(r).filter((x) => x.state === 'completed').length, 0); const allN = plans.reduce((s, r) => s + ns[r.id], 0);
  const save = useMutation({
    mutationFn: () => api('PATCH', '/procedure-plans/edit', { plans: (validChanged ? plans : changed).map((r) => ({ id: r.id, ...(ns[r.id] !== (courses.find((c) => c.recommendationId === r.id)?.sittings ?? r.sittings ?? 1) ? { sittings: ns[r.id] } : {}), ...(gaps[r.id] !== String(r.gapDays ?? '') ? { gapDays: Number(gaps[r.id]) || 0 } : {}) })),
      ...(validChanged ? { noExpiry: none, ...(none ? {} : { validUntil: date }) } : {}) }),
    onSuccess: () => { refresh(); toast(delta ? `Saved · ${delta > 0 ? '+' : '−'}${money(Math.abs(delta))}` : 'Saved'); onClose(); },
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
        {delta !== 0 && <div className="rounded-lg bg-amber-soft px-3 py-2 text-sm text-amber">{delta > 0 ? `Added sessions cost the standard price: +${money(delta)}` : `Removed sessions take their share off: −${money(-delta)}`}. New total {money(total + delta)}.</div>}
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
  const paid = cs.reduce((s, c: any) => s + c.advancePaise - c.refundedPaise + c.paidOnDayPaise, 0); const back = cs.reduce((s, c: any) => s + c.refundablePaise, 0);
  const mayRefund = can(perms, 'refund.course') && back > 0;
  const [why, setWhy] = useState(''); const [refund, setRefund] = useState(mayRefund); const [mode, setMode] = useState<'upi' | 'cash' | 'card' | 'bank'>('upi');
  const go = useMutation({
    mutationFn: async () => {
      await post('/procedure-plans/cancel', { ids: plans.map((r) => r.id), reason: why.trim() });
      if (refund && mayRefund) for (const c of cs as any[]) if (c.refundablePaise > 0) await post(`/courses/${c.id}/refund`, { amountPaise: c.refundablePaise, method: mode, reason: `Cancelled: ${why.trim()}` });
    },
    onSuccess: () => { refresh(); toast(`${pk ? pk.name : procName(plans[0])} cancelled${refund && mayRefund ? ` · ${money(back)} refunded` : ''}`); onClose(); },
    onError: (e) => { refresh(); toast(say(e), 'err'); },
  });
  const done = plans.reduce((s, r) => s + live(r).filter((x) => x.state === 'completed').length, 0); const all = plans.reduce((s, r) => s + (r.sittings ?? 1), 0);
  return (
    <Modal title={`Cancel the ${pk ? `${pk.name} package` : procName(plans[0])}?`} onClose={onClose} width="max-w-lg">
      <div className="space-y-3 text-sm">
        <p>{done} of {all} sessions are done; the {all - done} not done stop.{booked.length ? <> {booked.length === 1 ? 'The booking' : 'The bookings'} on {booked.map((s) => `${s.day} ${s.startTime ?? ''} (${s.proc}, session ${s.sittingNo})`).join(', ')} {booked.length === 1 ? 'is' : 'are'} cancelled.</> : null}</p>
        {pk && <div className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 text-[13px]">{plans.map((r) => <Fragment key={r.id}><span>{procName(r)}</span><span className="text-muted">{live(r).filter((x) => x.state === 'completed').length} of {r.sittings ?? 1} done</span></Fragment>)}</div>}
        {cs.length > 0 && <div className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 rounded-lg bg-paper-2 px-3 py-2.5"><span>Paid</span><b>{money(paid)}</b><span>Can be refunded</span><b className="text-sage">{money(back)}</b></div>}
        <div><label className="label" htmlFor="cp-why">Reason</label><input id="cp-why" className="input" maxLength={200} placeholder="e.g. Patient moving to another city" value={why} onChange={(e) => setWhy(e.target.value)} /></div>
        {mayRefund ? <div className="space-y-2"><label className="flex items-center gap-2"><input type="checkbox" className="accent-ink" checked={refund} onChange={(e) => setRefund(e.target.checked)} />Refund {money(back)} now</label>
          {refund && <div className="flex flex-wrap gap-1.5" role="group" aria-label="Refund by">{MODES.map(([m, l]) => <button key={m} type="button" aria-pressed={mode === m} className={`toggle-opt !py-1 ${mode === m ? 'on' : ''}`} onClick={() => setMode(m)}>{l}</button>)}</div>}</div>
          : back > 0 ? <div className="text-xs text-muted">{money(back)} can be refunded by someone allowed to give refunds, from Price &amp; payments.</div> : null}
        <div className="modal-foot"><button type="button" className="btn btn-ghost" onClick={onClose}>Keep it</button><button type="button" className="btn !bg-rose-soft !text-rose" disabled={why.trim().length < 3 || go.isPending} onClick={() => go.mutate()}>{pk ? 'Cancel package' : 'Cancel procedure'}</button></div>
      </div>
    </Modal>
  );
}
