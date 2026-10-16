import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useOutletContext, useSearchParams } from 'react-router';
import { get, post, qc, today, fmtTime } from '../api';
import { can } from '../App';
import { Chip, Empty, Icon, PageHeader, Section, Skeleton, Stat, money, toast } from '../ui';

/** Daily collections + expenses: replaces the two-page printout and the handwritten ledger. */
export function Reports() {
  const { perms } = useOutletContext<any>();
  const [day, setDay] = useState(today());
  const r = useQuery({ queryKey: ['daily', day], queryFn: () => get(`/reports/daily?day=${day}`) });
  const [exp, setExp] = useState({ description: '', amount: '', method: 'cash' });
  const addExp = useMutation({ mutationFn: () => post('/expenses', { day, description: exp.description, amountPaise: Math.round(Number(exp.amount) * 100), method: exp.method }), onSuccess: () => { setExp({ description: '', amount: '', method: 'cash' }); qc.invalidateQueries({ queryKey: ['daily'] }); toast('Expense added'); } });
  const d = r.data;
  const [sp, setSp] = useSearchParams(); const expRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (d && sp.get('print')) { setSp({}, { replace: true }); setTimeout(() => window.print(), 400); } if (d && sp.get('expense')) { setSp({}, { replace: true }); setTimeout(() => expRef.current?.focus(), 300); } }, [d, sp]);
  const dayLabel = new Date(day + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return (
    <div>
      <PageHeader title="Daily report" subtitle={dayLabel}>
        <div className="flex items-center gap-1 card !p-1 !rounded-full no-print">
          <button className="btn btn-ghost btn-icon" onClick={() => d && setDay(d.prevDay)}><Icon name="chevL" /></button>
          <input type="date" className="input !w-auto !border-0 !shadow-none !py-1.5 text-center" value={day} onChange={(e) => setDay(e.target.value)} />
          <button className="btn btn-ghost btn-icon" onClick={() => d && setDay(d.nextDay)}><Icon name="chevR" /></button>
        </div>
        <button className="btn no-print" onClick={() => window.print()}><Icon name="print" />Print</button>
      </PageHeader>
      {!d ? <Skeleton rows={3} /> : (<>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <Stat label="Visits" value={d.totals.visits} delay={0} />
          <Stat label="Collected" value={money(d.totals.collectedPaise)} tone="sage" sub={d.byMethod.length ? d.byMethod.map((m: any) => `${m.method.toUpperCase()} ${money(m.total)}`).join(' · ') : 'no payments yet'} delay={40} />
          <Stat label="Expenses" value={money(d.totals.expensesPaise)} sub={`${d.expenses.length} entries`} delay={80} />
          <Stat label="Net for the day" value={money(d.totals.netPaise)} tone="clay" sub={`Outstanding overall ${money(d.outstanding.total)} across ${d.outstanding.n}`} delay={120} />
        </div>
        <div className="grid lg:grid-cols-2 gap-5 mt-5">
          <Section title="By visit category" delay={160}>
            {d.byCategory.length === 0 ? <Empty icon="users" title="No visits recorded" /> : (
              <table className="table"><thead><tr><th className="pl-4">Category</th><th className="text-right">Visits</th><th className="text-right">Billed</th><th className="text-right">Waived</th><th className="text-right pr-4">Refunded</th></tr></thead>
                <tbody>{d.byCategory.map((c: any) => <tr key={c.code}><td className="pl-4">{c.name}</td><td className="text-right">{c.visits}</td><td className="text-right">{money(c.billed)}</td><td className="text-right text-muted">{money(c.waived)}</td><td className="text-right pr-4 text-muted">{money(c.refunded)}</td></tr>)}</tbody></table>)}
          </Section>
          <Section title="Expenses" delay={200}>
            {d.expenses.length === 0 ? <div className="px-4 pt-4 text-sm text-muted">No expenses entered.</div> :
              <table className="table"><tbody>{d.expenses.map((e: any) => <tr key={e.id}><td className="pl-4">{e.description}</td><td><Chip>{e.method}</Chip></td><td className="text-right pr-4">{money(e.amountPaise)}</td></tr>)}</tbody></table>}
            {can(perms, 'expense.write') && <div className="flex gap-2 p-4 no-print border-t border-line"><input ref={expRef} className="input" placeholder="What was paid for" value={exp.description} onChange={(e) => setExp({ ...exp, description: e.target.value })} /><input className="input !w-24" placeholder="₹" inputMode="numeric" value={exp.amount} onChange={(e) => setExp({ ...exp, amount: e.target.value })} /><select className="input !w-auto" value={exp.method} onChange={(e) => setExp({ ...exp, method: e.target.value })}><option value="cash">cash</option><option value="upi">upi</option><option value="bank">bank</option></select><button className="btn btn-primary" disabled={!exp.description || !exp.amount} onClick={() => addExp.mutate()}><Icon name="plus" /></button></div>}
          </Section>
        </div>
        <Section title={<>Payments <span className="text-muted font-normal">· {d.payments.length}</span></>} delay={240} className="mt-5">
          {d.payments.length === 0 ? <Empty icon="wallet" title="No payments yet today" /> :
            <table className="table"><thead><tr><th className="pl-4">Time</th><th>Patient</th><th>For</th><th>Method</th><th className="text-right pr-4">Amount</th></tr></thead>
              <tbody>{d.payments.map((p: any) => <tr key={p.id}><td className="pl-4 text-muted">{fmtTime(p.receivedAt)}</td><td className="font-medium">{p.patient}</td><td className="text-muted">{p.description ?? ''}</td><td><Chip>{p.method}</Chip></td><td className="text-right pr-4">{money(p.amountPaise)}</td></tr>)}</tbody></table>}
        </Section>
      </>)}
    </div>
  );
}
