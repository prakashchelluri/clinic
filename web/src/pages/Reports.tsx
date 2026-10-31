import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useOutletContext, useSearchParams } from 'react-router';
import { get, today, fmtTime, listOut } from '../api';
import { can } from '../App';
import { EmiAwaiting } from '../takePayment';
import { Chip, Empty, Icon, PageHeader, Section, Skeleton, Stat, money, toast } from '../ui';

/** Daily collections + expenses: replaces the two-page printout and the handwritten ledger. */
export function Reports() {
  const { perms, me } = useOutletContext<any>();
  const [day, setDay] = useState(today());
  const r = useQuery({ queryKey: ['daily', day], queryFn: () => get(`/reports/daily?day=${day}`) });
  const d = r.data;
  const [sp, setSp] = useSearchParams();
  useEffect(() => { if (d && sp.get('print')) { setSp({}, { replace: true }); if (me?.privacy?.canExport) listOut(`Printed the daily report ${day}`, undefined, () => setTimeout(() => window.print(), 400)); } }, [d, sp]);
  const dayLabel = new Date(day + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return (
    <div>
      <PageHeader title="Daily report" subtitle={dayLabel}>
        <div className="flex items-center gap-1 card !p-1 !rounded-full no-print">
          <button className="btn btn-ghost btn-icon" aria-label="Previous day" onClick={() => d && setDay(d.prevDay)}><Icon name="chevL" /></button>
          <input type="date" className="input !w-auto !border-0 !shadow-none !py-1.5 text-center" value={day} onChange={(e) => setDay(e.target.value)} />
          <button className="btn btn-ghost btn-icon" aria-label="Next day" onClick={() => d && setDay(d.nextDay)}><Icon name="chevR" /></button>
        </div>
        {me?.privacy?.canExport && <button className="btn no-print" onClick={() => listOut(`Printed the daily report ${day}`, undefined, () => window.print())}><Icon name="print" />Print</button>}
      </PageHeader>
      {!d ? <Skeleton rows={3} /> : (<>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <Stat label="Visits" value={d.totals.visits} delay={0} />
          <Stat label="Collected" value={money(d.totals.collectedPaise)} tone="sage" sub={d.byMethod.length ? d.byMethod.map((m: any) => `${m.method.toUpperCase()} ${money(m.total)}`).join(' · ') : 'no payments yet'} delay={40} />
          <Stat label="Expenses" value={money(d.totals.expensesPaise)} sub={`${d.expenses.length} entries`} delay={80} />
          <Stat label="Net for the day" value={money(d.totals.netPaise)} tone="clay" sub={`Outstanding overall ${money(d.outstanding.total)} across ${d.outstanding.n}`} delay={120} />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mt-5">
          <Section title="By visit category" delay={160}>
            {d.byCategory.length === 0 ? <Empty icon="users" title="No visits recorded" /> : (
              <div className="overflow-x-auto"><table className="table min-w-[460px]"><thead><tr><th className="pl-4">Category</th><th className="text-right">Visits</th><th className="text-right">Billed</th><th className="text-right">Waived</th><th className="text-right pr-4">Refunded</th></tr></thead>
                <tbody>{d.byCategory.map((c: any) => <tr key={c.code}><td className="pl-4">{c.name}</td><td className="text-right">{c.visits}</td><td className="text-right">{money(c.billed)}</td><td className="text-right text-muted">{money(c.waived)}</td><td className="text-right pr-4 text-muted">{money(c.refunded)}</td></tr>)}</tbody></table></div>)}
          </Section>
          <Section title="Expenses" delay={200}>
            {d.expenses.length === 0 ? <div className="px-4 pt-4 text-sm text-muted">No expenses entered.</div> :
              <div className="overflow-x-auto"><table className="table min-w-[460px]"><tbody>{d.expenses.map((e: any) => <tr key={e.id}><td className="pl-4">{e.description}<div className="text-xs text-muted">{e.category}</div></td><td><Chip>{e.method}</Chip></td><td className="text-right pr-4">{money(e.amountPaise)}</td></tr>)}</tbody></table></div>}
            {can(perms, 'expense.read') && <div className="p-4 no-print border-t border-line"><Link to="/expenses" className="btn btn-sm"><Icon name="rupee" className="h-3.5 w-3.5" />Add or manage expenses</Link></div>}
          </Section>
        </div>
        {can(perms, 'payment.record') && <EmiAwaiting />}
        <Section title={<>Payments <span className="text-muted font-normal">· {d.payments.length}</span></>} delay={240} className="mt-5">
          {d.payments.length === 0 ? <Empty icon="wallet" title="No payments yet today" /> :
            <div className="overflow-x-auto"><table className="table min-w-[460px]"><thead><tr><th className="pl-4">Time</th><th>Patient</th><th>For</th><th>Method</th><th className="text-right pr-4">Amount</th></tr></thead>
              <tbody>{d.payments.map((p: any) => <tr key={p.id}><td className="pl-4 text-muted">{fmtTime(p.receivedAt)}</td><td className="font-medium">{p.patient}</td><td className="text-muted">{p.description ?? ''}</td><td><Chip>{p.method}</Chip></td><td className="text-right pr-4">{money(p.amountPaise)}</td></tr>)}</tbody></table></div>}
        </Section>
      </>)}
    </div>
  );
}
