import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useOutletContext } from 'react-router';
import { get, post, qc, rupees, today, fmtTime } from '../api';
import { can } from '../App';

/** Daily collections + expenses: replaces the two-page printout and the handwritten ledger. */
export function Reports() {
  const { perms } = useOutletContext<any>();
  const [day, setDay] = useState(today());
  const r = useQuery({ queryKey: ['daily', day], queryFn: () => get(`/reports/daily?day=${day}`) });
  const [exp, setExp] = useState({ description: '', amount: '', method: 'cash' });
  const addExp = useMutation({ mutationFn: () => post('/expenses', { day, description: exp.description, amountPaise: Math.round(Number(exp.amount) * 100), method: exp.method }), onSuccess: () => { setExp({ description: '', amount: '', method: 'cash' }); qc.invalidateQueries({ queryKey: ['daily'] }); } });
  const d = r.data;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 no-print">
        <h1 className="text-lg font-semibold">Daily report</h1>
        {d && <button className="btn btn-sm" onClick={() => setDay(d.prevDay)}>‹</button>}
        <input type="date" className="input !w-auto" value={day} onChange={(e) => setDay(e.target.value)} />
        {d && <button className="btn btn-sm" onClick={() => setDay(d.nextDay)}>›</button>}
        <button className="btn btn-sm ml-auto" onClick={() => window.print()}>Print</button>
      </div>
      {d && (<>
        <div className="grid md:grid-cols-4 gap-3">
          <Stat label="Visits" value={String(d.totals.visits)} />
          <Stat label="Collected" value={rupees(d.totals.collectedPaise)} sub={d.byMethod.map((m: any) => `${m.method} ${rupees(m.total)}`).join(' · ')} />
          <Stat label="Expenses" value={rupees(d.totals.expensesPaise)} />
          <Stat label="Net cash position" value={rupees(d.totals.netPaise)} sub={`Outstanding overall: ${rupees(d.outstanding.total)} (${d.outstanding.n})`} />
        </div>
        <div className="grid lg:grid-cols-2 gap-3">
          <div className="card">
            <div className="text-sm font-semibold mb-2">By visit category</div>
            <table className="w-full text-sm"><thead className="text-xs text-slate-500 text-left"><tr><th>Category</th><th className="text-right">Visits</th><th className="text-right">Billed</th><th className="text-right">Waived</th><th className="text-right">Refunded</th></tr></thead>
              <tbody>{d.byCategory.map((c: any) => <tr key={c.code} className="border-t border-slate-100"><td>{c.name}</td><td className="text-right">{c.visits}</td><td className="text-right">{rupees(c.billed)}</td><td className="text-right">{rupees(c.waived)}</td><td className="text-right">{rupees(c.refunded)}</td></tr>)}</tbody></table>
          </div>
          <div className="card">
            <div className="text-sm font-semibold mb-2">Expenses</div>
            <table className="w-full text-sm"><tbody>{d.expenses.map((e: any) => <tr key={e.id} className="border-t border-slate-100"><td>{e.description}</td><td className="text-slate-500">{e.method}</td><td className="text-right">{rupees(e.amountPaise)}</td></tr>)}</tbody></table>
            {can(perms, 'expense.write') && <div className="flex gap-1 mt-2 no-print"><input className="input" placeholder="Description" value={exp.description} onChange={(e) => setExp({ ...exp, description: e.target.value })} /><input className="input !w-24" placeholder="₹" value={exp.amount} onChange={(e) => setExp({ ...exp, amount: e.target.value })} /><select className="input !w-auto" value={exp.method} onChange={(e) => setExp({ ...exp, method: e.target.value })}><option value="cash">cash</option><option value="upi">upi</option><option value="bank">bank</option></select><button className="btn btn-sm btn-primary" disabled={!exp.description || !exp.amount} onClick={() => addExp.mutate()}>Add</button></div>}
          </div>
        </div>
        <div className="card">
          <div className="text-sm font-semibold mb-2">Payments ({d.payments.length})</div>
          <table className="w-full text-sm"><thead className="text-xs text-slate-500 text-left"><tr><th>Time</th><th>Patient</th><th>For</th><th>Method</th><th className="text-right">Amount</th></tr></thead>
            <tbody>{d.payments.map((p: any) => <tr key={p.id} className="border-t border-slate-100"><td>{fmtTime(p.receivedAt)}</td><td>{p.patient}</td><td className="text-slate-500">{p.description ?? ''}</td><td>{p.method}</td><td className="text-right">{rupees(p.amountPaise)}</td></tr>)}</tbody></table>
        </div>
      </>)}
    </div>
  );
}

const Stat = ({ label, value, sub }: { label: string; value: string; sub?: string }) => (
  <div className="card"><div className="text-xs text-slate-500">{label}</div><div className="text-2xl font-semibold">{value}</div>{sub && <div className="text-xs text-slate-500 mt-1">{sub}</div>}</div>
);
