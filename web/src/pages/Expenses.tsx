import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useOutletContext } from 'react-router';
import { get, post, patch, del, qc, today, errText } from '../api';
import { can } from '../App';
import { Chip, Empty, Icon, Modal, MoneyInput, PageHeader, Section, Segmented, Skeleton, Stat, money, toPaise, toast } from '../ui';

const addDays = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
type Range = 'today' | '7' | '30' | 'month';
const rangeOf = (r: Range) => { const t = today(); return r === 'today' ? { from: t, to: t } : r === '7' ? { from: addDays(t, -6), to: t } : r === '30' ? { from: addDays(t, -29), to: t } : { from: t.slice(0, 8) + '01', to: t }; };
const METHODS: [string, string][] = [['cash', 'Cash'], ['upi', 'UPI'], ['bank', 'Bank']];
const blank = (cat = 'Other') => ({ description: '', amount: '', method: 'cash', category: cat, day: today(), note: '' });
const short = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

/** Money going out. Quick to enter, hard to get wrong, nothing is ever silently deleted. */
export function Expenses() {
  const { perms } = useOutletContext<any>();
  const canWrite = can(perms, 'expense.write');
  const [range, setRange] = useState<Range>('30');
  const { from, to } = rangeOf(range);
  const q = useQuery({ queryKey: ['expenses', from, to], queryFn: () => get(`/expenses?from=${from}&to=${to}`) });
  const d = q.data; const refresh = () => { qc.invalidateQueries({ queryKey: ['expenses'] }); qc.invalidateQueries({ queryKey: ['daily'] }); };
  const [form, setForm] = useState(blank());
  const [edit, setEdit] = useState<any>(null);
  const [voiding, setVoiding] = useState<any>(null);
  type F = ReturnType<typeof blank>;
  const valid = (f: F) => f.description.trim().length >= 2 && toPaise(f.amount) > 0 && f.day <= today();
  const why = (f: F) => f.description.trim().length < 2 ? 'Say what it was for' : toPaise(f.amount) <= 0 ? 'Enter the amount' : f.day > today() ? 'Date cannot be in the future' : '';
  const body = (f: F) => ({ description: f.description.trim(), amountPaise: toPaise(f.amount), method: f.method, category: f.category, day: f.day, note: f.note.trim() || null });
  const add = useMutation({ mutationFn: () => post('/expenses', body(form)), onSuccess: () => { toast(`Added ${money(toPaise(form.amount))} · ${form.category}`); setForm(blank(form.category)); refresh(); }, onError: (e) => toast(errText(e), 'err') });
  const save = useMutation({ mutationFn: () => patch(`/expenses/${edit.id}`, body(edit)), onSuccess: () => { toast('Expense updated'); setEdit(null); refresh(); }, onError: (e) => toast(errText(e), 'err') });
  const remove = useMutation({ mutationFn: () => del(`/expenses/${voiding.e.id}?reason=${encodeURIComponent(voiding.reason)}`), onSuccess: () => { toast('Expense removed (kept in the audit trail)'); setVoiding(null); refresh(); }, onError: (e) => toast(errText(e), 'err') });
  const rows: any[] = d?.rows ?? []; const live = rows.filter((r) => !r.voidedAt);
  const top = d?.byCategory?.[0];

  return (
    <div>
      <PageHeader title="Expenses" subtitle={d ? `${short(d.from)} to ${short(d.to)}` : ' '}>
        <Segmented value={range} onChange={setRange} options={[{ value: 'today', label: 'Today' }, { value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: 'month', label: 'This month' }]} />
      </PageHeader>

      {canWrite && (
        <form className="card !p-4 mb-5 anim-fade-up" onSubmit={(e) => { e.preventDefault(); if (valid(form) && !add.isPending) add.mutate(); }}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-[1fr_190px_150px_150px_auto] items-end">
            <div className="sm:col-span-2 xl:col-span-1"><label className="label" htmlFor="ex-desc">What was paid for</label><input id="ex-desc" className="input" maxLength={200} placeholder="e.g. Gloves and syringes" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
            <div><label className="label" htmlFor="ex-cat">Category</label><select id="ex-cat" className="input" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>{(d?.categories ?? ['Other']).map((c: string) => <option key={c}>{c}</option>)}</select></div>
            <div><label className="label" htmlFor="ex-amt">Amount</label><MoneyInput id="ex-amt" value={form.amount} onChange={(v) => setForm({ ...form, amount: v })} /></div>
            <div><label className="label" htmlFor="ex-day">Date</label><input id="ex-day" type="date" className="input" max={today()} value={form.day} onChange={(e) => setForm({ ...form, day: e.target.value || today() })} /></div>
            <button className="btn btn-primary !h-11 sm:col-span-2 xl:col-span-1" disabled={!valid(form) || add.isPending}><Icon name="plus" className="h-4 w-4" />Add expense</button>
          </div>
          <div className="flex flex-wrap items-center gap-2 mt-3">
            <span className="text-xs text-muted mr-1">Paid by</span>
            {METHODS.map(([m, l]) => <button type="button" key={m} className={`toggle-opt ${form.method === m ? 'on' : ''}`} onClick={() => setForm({ ...form, method: m })}>{l}</button>)}
            <span className="ml-auto text-xs text-muted">{why(form) && (form.description || form.amount) ? why(form) : ' '}</span>
          </div>
        </form>
      )}

      {!d ? <Skeleton rows={4} /> : (<>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <Stat label="Total spent" value={money(d.totalPaise)} tone="clay" sub={`${live.length} ${live.length === 1 ? 'entry' : 'entries'}`} />
          <Stat label="Biggest category" value={top ? money(top.total) : '₹0'} sub={top ? top.category : 'nothing yet'} delay={40} />
          {d.byMethod.slice(0, 2).map((m: any, i: number) => <Stat key={m.method} label={'Paid by ' + m.method} value={money(m.total)} delay={80 + i * 40} />)}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] gap-5 mt-5 items-start">
          <Section title={<>Entries <span className="text-muted font-normal">· {rows.length}</span></>} delay={120}>
            {rows.length === 0 ? <Empty icon="wallet" title="No expenses in this period" hint={canWrite ? 'Add the first one above.' : undefined} /> : (
              <div className="overflow-x-auto"><table className="table"><thead><tr><th className="pl-4">Date</th><th>For</th><th>Category</th><th>Paid by</th><th className="text-right">Amount</th><th className="pr-4" /></tr></thead>
                <tbody>{rows.map((r) => (
                  <tr key={r.id} className={r.voidedAt ? 'opacity-50' : ''}>
                    <td className="pl-4 whitespace-nowrap text-muted">{short(r.day)}</td>
                    <td className="max-w-[260px]"><div className={'truncate ' + (r.voidedAt ? 'line-through' : '')} title={r.description}>{r.description}</div>{(r.enteredByName || r.voidedAt) && <div className="text-xs text-muted truncate">{r.voidedAt ? 'Removed' + (r.voidedReason ? ': ' + r.voidedReason : '') : 'by ' + r.enteredByName}</div>}</td>
                    <td><Chip>{r.category}</Chip></td><td className="uppercase text-xs text-muted">{r.method}</td>
                    <td className={'text-right whitespace-nowrap ' + (r.voidedAt ? 'line-through' : '')}>{money(r.amountPaise)}</td>
                    <td className="pr-4 text-right whitespace-nowrap">{canWrite && !r.voidedAt && <>
                      <button className="btn btn-ghost btn-icon" aria-label="Edit expense" title="Edit" onClick={() => setEdit({ id: r.id, description: r.description, amount: String(r.amountPaise / 100), method: r.method, category: r.category, day: r.day, note: r.note ?? '' })}><Icon name="edit" /></button>
                      <button className="btn btn-ghost btn-icon" aria-label="Remove expense" title="Remove" onClick={() => setVoiding({ e: r, reason: '' })}><Icon name="x" /></button></>}</td>
                  </tr>))}</tbody></table></div>)}
          </Section>
          <Section title="By category" delay={160}>
            {d.byCategory.length === 0 ? <div className="px-5 py-4 text-sm text-muted">Nothing to show yet.</div> : <div className="p-4 space-y-3">{d.byCategory.map((c: any) => (
              <div key={c.category}><div className="flex justify-between text-sm"><span>{c.category}</span><span className="font-medium">{money(c.total)}</span></div>
                <div className="h-1.5 rounded-full bg-ink/10 mt-1.5 overflow-hidden"><div className="h-full rounded-full bg-clay" style={{ width: Math.max(3, Math.round((c.total / d.totalPaise) * 100)) + '%' }} /></div></div>))}</div>}
          </Section>
        </div>
      </>)}

      {edit && (
        <Modal title="Edit expense" onClose={() => setEdit(null)} width="max-w-md">
          <div className="space-y-3">
            <div><label className="label">What was paid for</label><input className="input" maxLength={200} value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="label">Amount</label><MoneyInput value={edit.amount} onChange={(v) => setEdit({ ...edit, amount: v })} /></div>
              <div><label className="label">Date</label><input type="date" className="input" max={today()} value={edit.day} onChange={(e) => setEdit({ ...edit, day: e.target.value || today() })} /></div>
            </div>
            <div><label className="label">Category</label><select className="input" value={edit.category} onChange={(e) => setEdit({ ...edit, category: e.target.value })}>{(d?.categories ?? []).map((c: string) => <option key={c}>{c}</option>)}</select></div>
            <div className="flex gap-1">{METHODS.map(([m, l]) => <button type="button" key={m} className={'toggle-opt ' + (edit.method === m ? 'on' : '')} onClick={() => setEdit({ ...edit, method: m })}>{l}</button>)}</div>
            <div><label className="label">Note (optional)</label><input className="input" maxLength={500} value={edit.note} onChange={(e) => setEdit({ ...edit, note: e.target.value })} /></div>
            <div className="flex items-center justify-end gap-2 pt-2"><span className="text-xs text-muted mr-auto">{why(edit)}</span><button className="btn btn-ghost" onClick={() => setEdit(null)}>Cancel</button><button className="btn btn-primary" disabled={!valid(edit) || save.isPending} onClick={() => save.mutate()}>Save</button></div>
          </div>
        </Modal>)}
      {voiding && (
        <Modal title="Remove this expense?" subtitle={voiding.e.description + ' · ' + money(voiding.e.amountPaise)} onClose={() => setVoiding(null)} width="max-w-md">
          <div className="space-y-3">
            <div className="text-sm text-muted">It leaves the totals but stays in the audit trail with your name.</div>
            <div><label className="label">Reason (optional)</label><input className="input" maxLength={200} autoFocus placeholder="e.g. entered twice" value={voiding.reason} onChange={(e) => setVoiding({ ...voiding, reason: e.target.value })} /></div>
            <div className="flex justify-end gap-2"><button className="btn btn-ghost" onClick={() => setVoiding(null)}>Keep it</button><button className="btn btn-primary !bg-rose !border-rose" disabled={remove.isPending} onClick={() => remove.mutate()}>Remove expense</button></div>
          </div>
        </Modal>)}
    </div>
  );
}
