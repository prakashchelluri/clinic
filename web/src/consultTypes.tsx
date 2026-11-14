import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { get, post, patch, errText, qc } from './api';
import { Drawer, Chip, Empty, Icon, Skeleton, money, toast, ask, NumInput, MoneyInput, toPaise } from './ui';

/** Consultation types: what a patient comes in for. One record holds the fee charged at check-in and how it is booked on the calendar
 *  (it used to be two lists, Consultation fees and Visit types). The server keeps the fee and its visit type in step. */
const COLORS = ['#4F46E5', '#0369A1', '#15803D', '#B45309', '#B91C1C', '#6D5E86', '#D4421A', '#17191A'];
type Rule = 'never' | 'days' | 'course' | 'card' | 'custom';
/** The suggestion rules the desk understands, in plain words. "Within 15 days" is stored as days_since_last_paid_consult <= 14 (the payment day is day 1). */
const ruleOf = (r: any): { kind: Rule; days?: number } => {
  if (!r) return { kind: 'never' };
  const le = r['<=']; if (Array.isArray(le) && le[0]?.var === 'days_since_last_paid_consult' && Number.isInteger(le[1])) return { kind: 'days', days: le[1] + 1 };
  const eq = r['==']; if (Array.isArray(eq) && eq[1] === true && eq[0]?.var === 'has_open_procedure_course') return { kind: 'course' };
  if (Array.isArray(eq) && eq[1] === true && eq[0]?.var === 'patient.referralCard') return { kind: 'card' };
  return { kind: 'custom' };
};
const ruleFrom = (kind: Rule, days: number, was: any) => kind === 'never' ? null : kind === 'days' ? { '<=': [{ var: 'days_since_last_paid_consult' }, Math.max(0, days - 1)] }
  : kind === 'course' ? { '==': [{ var: 'has_open_procedure_course' }, true] } : kind === 'card' ? { '==': [{ var: 'patient.referralCard' }, true] } : was;
const ruleText = (r: any) => { const x = ruleOf(r); return x.kind === 'days' ? `Suggested within ${x.days} days` : x.kind === 'course' ? 'Suggested during a procedure course' : x.kind === 'card' ? 'Suggested with a referral card' : x.kind === 'custom' ? 'Suggested by a rule' : null; };
const SAY: Record<string, string> = { DUPLICATE_CODE: 'Another consultation type already uses this code.', BAD_RULE: 'That rule cannot be used.' };

export function ConsultTypesTab({ cfg, onSaved }: { cfg: any; onSaved: () => void }) {
  const q = useQuery({ queryKey: ['consult-types'], queryFn: () => get('/admin/consult-types') });
  const [show, setShow] = useState<'active' | 'inactive'>('active');
  const [edit, setEdit] = useState<any>(null);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['consult-types'] }); qc.invalidateQueries({ queryKey: ['admin-services'] }); onSaved(); };
  const link = useMutation({ mutationFn: ({ id, ...b }: any) => patch(`/admin/services/${id}`, b), onSuccess: () => { toast('Saved'); refresh(); }, onError: (e: any) => toast(errText(e), 'err') });
  const all: any[] = q.data?.types ?? []; const unlinked: any[] = q.data?.unlinked ?? [];
  const rows = all.filter((t) => (show === 'active') === t.active);
  const doctors = (ids: string[]) => ids?.length ? ids.map((id) => cfg.practitioners.find((p: any) => p.id === id)?.name ?? '?').join(', ') : 'All doctors';
  const add = () => setEdit({ code: '', name: '', amount: '', priority: 0, affectsCapacity: true, eligibilityNote: '', eligibility: null, active: true, booking: { bookable: true, places: 1, color: COLORS[all.length % COLORS.length], practitionerIds: [], description: '' } });
  const open = (t: any) => setEdit({ ...t, amount: String(t.amountPaise / 100), eligibilityNote: t.eligibilityNote ?? '',
    booking: t.booking ? { bookable: t.booking.active, places: t.booking.places, color: t.booking.color, practitionerIds: t.booking.practitionerIds ?? [], description: t.booking.description ?? '' } : { bookable: false, places: 1, color: COLORS[0], practitionerIds: [], description: '' } });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1.5" role="group" aria-label="Show">{(['active', 'inactive'] as const).map((k) => <button key={k} type="button" aria-pressed={show === k} className={`toggle-opt ${show === k ? 'on' : ''}`} onClick={() => setShow(k)}>{k === 'active' ? 'Active' : 'Inactive'} · {all.filter((t) => (k === 'active') === t.active).length}</button>)}</div>
        <button type="button" className="btn btn-primary ml-auto" onClick={add}><Icon name="plus" />Add consultation type</button>
      </div>
      <div className="card !p-0 overflow-x-auto">
        {q.isLoading ? <div className="p-4"><Skeleton rows={4} /></div> : rows.length === 0 ? <Empty icon="calendar" title={show === 'active' ? 'No consultation types yet' : 'Nothing inactive'} hint={show === 'active' ? 'Add what patients come in for: a new consultation, a review, a report review.' : undefined} /> : (
          <table className="table min-w-[760px]">
            <thead><tr><th className="pl-4">Name</th><th>Code</th><th className="!text-right">Fee</th><th>Booking</th><th>Doctors</th><th>Rules</th></tr></thead>
            <tbody>{rows.map((t) => (
              <tr key={t.id} className="cursor-pointer hover:bg-surface-2" onClick={() => open(t)}>
                <td className="pl-4"><button type="button" className="flex items-center gap-2.5 text-left font-medium" onClick={(e) => { e.stopPropagation(); open(t); }}><i className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: t.booking?.active ? t.booking.color : 'var(--color-line-2)' }} />{t.name}</button></td>
                <td className="font-mono text-xs text-ink-2">{t.code}</td>
                <td className="text-right">{t.amountPaise === 0 ? 'Free' : money(t.amountPaise)}</td>
                <td className="text-ink-2">{t.booking?.active ? `${t.booking.places} ${t.booking.places === 1 ? 'place' : 'places'}` : <span className="text-muted">Check-in only</span>}</td>
                <td className="text-ink-2">{t.booking?.active ? doctors(t.booking.practitionerIds) : '—'}</td>
                <td><div className="flex flex-wrap gap-1">{t.priority > 0 && <Chip tone="amber">Jumps the queue</Chip>}{ruleText(t.eligibility) && <Chip tone="sage">{ruleText(t.eligibility)}</Chip>}{!t.affectsCapacity && <Chip>Uses no place</Chip>}</div></td>
              </tr>))}</tbody>
          </table>)}
      </div>
      {unlinked.length > 0 && <div className="card space-y-2">
        <div className="card-title">Visit types with no fee</div>
        <div className="text-xs text-muted">These were set up before fees and visit types became one. Tie each to a consultation type; until then the desk picks the fee at check-in.</div>
        {unlinked.map((s) => <div key={s.id} className="flex flex-wrap items-center gap-2 border-t border-line/70 pt-2 text-sm"><i className="h-2.5 w-2.5 rounded-[3px]" style={{ background: s.color }} /><b className="mr-auto font-medium">{s.name}</b>
          <select className="input !w-60" aria-label={`Tie ${s.name} to`} value="" onChange={(e) => e.target.value && link.mutate({ id: s.id, feeCategoryId: e.target.value })}><option value="">Tie to…</option>{all.filter((t) => t.active && !t.booking?.active).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
          <button type="button" className="btn btn-sm" onClick={() => link.mutate({ id: s.id, active: false })}>Mark inactive</button></div>)}
      </div>}
      {edit && <TypeDrawer value={edit} cfg={cfg} onClose={() => setEdit(null)} onDone={() => { setEdit(null); refresh(); }} />}
    </div>
  );
}

function TypeDrawer({ value, cfg, onClose, onDone }: { value: any; cfg: any; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState<any>(value);
  const r0 = ruleOf(value.eligibility); const [rule, setRule] = useState<Rule>(r0.kind); const [days, setDays] = useState(String(r0.days ?? 15));
  const set = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }));
  const setB = (k: string, v: any) => setF((p: any) => ({ ...p, booking: { ...p.booking, [k]: v } }));
  const b = f.booking;
  const bad = { name: !f.name.trim(), code: !f.id && !/^[A-Z0-9]{1,8}$/.test(f.code), fee: f.amount === '' || !(Number(f.amount) >= 0), places: b.bookable && !(Number(b.places) >= 1 && Number(b.places) <= 10), days: rule === 'days' && !(Number(days) >= 1 && Number(days) <= 365) };
  const save = useMutation({
    mutationFn: (active: boolean) => {
      const fee: any = { name: f.name.trim(), amountPaise: toPaise(f.amount), priority: f.priority, affectsCapacity: f.affectsCapacity, eligibility: ruleFrom(rule, Number(days), value.eligibility), eligibilityNote: f.eligibilityNote.trim() || null, active };
      const booking = { bookable: b.bookable, places: Number(b.places), color: b.color, practitionerIds: b.practitionerIds, description: b.description.trim() || null };
      return f.id ? patch(`/admin/consult-types/${f.id}`, { fee, booking }) : post('/admin/consult-types', { fee: { ...fee, code: f.code }, booking });
    },
    onSuccess: (_: any, active: boolean) => { toast(!f.id ? 'Consultation type added' : active !== value.active ? (active ? 'Active again' : 'Marked inactive') : 'Saved'); onDone(); },
    onError: (e: any) => toast(SAY[e?.body?.code] ?? errText(e), 'err'),
  });
  const submit = async (active: boolean) => {
    const was = value.amountPaise; const now = toPaise(f.amount);
    if (f.id && active && was !== now && !(await ask({ title: `Change ${f.name} from ${money(was)} to ${money(now)}?`, body: 'It applies to check-ins from now. Patients already checked in keep the fee they were charged.', confirmLabel: 'Change the fee' }))) return;
    save.mutate(active);
  };
  const toggleDoc = (id: string) => setB('practitionerIds', b.practitionerIds.includes(id) ? b.practitionerIds.filter((x: string) => x !== id) : [...b.practitionerIds, id]);
  return (
    <Drawer title={f.id ? value.name : 'New consultation type'} subtitle={f.id ? 'A new fee applies to check-ins from now.' : 'Its fee at check-in, and how it is booked'} onClose={onClose} width="max-w-lg">
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2"><label className="label" htmlFor="ct-name">Name</label><input id="ct-name" autoFocus={!f.id} className={`input ${bad.name && f.name !== value.name ? '!border-rose' : ''}`} maxLength={100} placeholder="e.g. Hair consultation" value={f.name} onChange={(e) => set('name', e.target.value)} /></div>
          <div><label className="label" htmlFor="ct-code">Code on the token</label><input id="ct-code" className={`input uppercase ${f.code && bad.code ? '!border-rose' : ''}`} maxLength={8} disabled={!!f.id} placeholder="HAIR" value={f.code} onChange={(e) => set('code', e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} /></div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label" htmlFor="ct-fee">Fee (₹)</label><MoneyInput id="ct-fee" value={f.amount} onChange={(v: string) => set('amount', v)} placeholder="0 for free" /></div>
          <div><span className="label">Jumps the queue?</span><div className="flex gap-1" role="group" aria-label="Jumps the queue?">{([[false, 'No'], [true, 'Yes']] as const).map(([v, l]) => <button key={l} type="button" aria-pressed={(f.priority > 0) === v} className={`toggle-opt ${(f.priority > 0) === v ? 'on' : ''}`} onClick={() => set('priority', v ? (f.priority > 0 ? f.priority : 10) : 0)}>{l}</button>)}</div></div>
        </div>
        <div className="rounded-xl border border-line p-3.5 space-y-3">
          <label className="flex items-start gap-2.5 text-sm"><input type="checkbox" className="mt-0.5 accent-clay" checked={b.bookable} onChange={(e) => setB('bookable', e.target.checked)} /><span><b className="font-medium">Booked on the calendar</b><span className="block text-xs text-muted">Off: the desk picks it only at check-in (e.g. emergency, online).</span></span></label>
          {b.bookable && <>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="label" htmlFor="ct-places">Places one booking takes</label><NumInput id="ct-places" max={10} className={`input ${bad.places ? '!border-rose' : ''}`} value={b.places} onChange={(e) => setB('places', e.target.value)} /></div>
              <div><span className="label">Colour on the calendar</span><div className="flex flex-wrap gap-1.5 pt-1" role="radiogroup" aria-label="Colour">{COLORS.map((c) => <button key={c} type="button" role="radio" aria-checked={b.color === c} aria-label={c} onClick={() => setB('color', c)} className="h-6 w-6 rounded-full" style={{ background: c, boxShadow: b.color === c ? '0 0 0 2px var(--color-surface), 0 0 0 4px var(--color-ink)' : undefined }} />)}</div></div>
            </div>
            {bad.places && <div className="text-xs text-rose">Places: 1 to 10.</div>}
            <div><span className="label">Doctors</span><div className="flex flex-wrap gap-1.5"><button type="button" aria-pressed={b.practitionerIds.length === 0} className={`toggle-opt ${b.practitionerIds.length === 0 ? 'on' : ''}`} onClick={() => setB('practitionerIds', [])}>All doctors</button>{cfg.practitioners.map((p: any) => <button key={p.id} type="button" aria-pressed={b.practitionerIds.includes(p.id)} className={`toggle-opt ${b.practitionerIds.includes(p.id) ? 'on' : ''}`} onClick={() => toggleDoc(p.id)}>{p.name}</button>)}</div></div>
            <div><label className="label" htmlFor="ct-desc">Shown to patients (optional)</label><input id="ct-desc" className="input" maxLength={300} placeholder="e.g. Follow-up within 15 days of your first visit" value={b.description} onChange={(e) => setB('description', e.target.value)} /></div>
          </>}
        </div>
        <div>
          <label className="label" htmlFor="ct-rule">Suggest it at check-in when</label>
          <div className="flex flex-wrap items-center gap-2">
            <select id="ct-rule" className="input !w-auto" value={rule} onChange={(e) => setRule(e.target.value as Rule)}>
              <option value="never">Never (the desk picks it)</option><option value="days">The last paid visit was within…</option><option value="course">The patient is on a procedure course</option><option value="card">The patient has a referral card</option>{r0.kind === 'custom' && <option value="custom">The clinic's own rule (kept as it is)</option>}
            </select>
            {rule === 'days' && <><NumInput aria-label="Days" max={365} className={`input !w-20 ${bad.days ? '!border-rose' : ''}`} value={days} onChange={(e) => setDays(e.target.value)} /><span className="text-sm">days</span></>}
          </div>
          {rule === 'days' && <div className="mt-1 text-xs text-muted">The payment day counts as day 1.</div>}
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-clay" checked={f.affectsCapacity} onChange={(e) => set('affectsCapacity', e.target.checked)} />A walk-in uses one of the doctor's places</label>
        <div><label className="label" htmlFor="ct-note">Note for reception</label><input id="ct-note" className="input" maxLength={200} placeholder="e.g. First visit, or more than 3 months since the last" value={f.eligibilityNote} onChange={(e) => set('eligibilityNote', e.target.value)} /></div>
        <div className="modal-foot !justify-between">
          {f.id ? <button type="button" className="btn" disabled={save.isPending} onClick={() => submit(!value.active)}>{value.active ? 'Mark inactive' : 'Make active'}</button> : <span />}
          <div className="flex gap-2"><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={save.isPending || Object.values(bad).some(Boolean)} onClick={() => submit(f.id ? value.active : true)}><Icon name="check" />{f.id ? 'Save' : 'Add'}</button></div>
        </div>
      </div>
    </Drawer>
  );
}
