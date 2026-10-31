import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { get } from './api';
import { Chip, Empty, Skeleton, fmtDate, money } from './ui';
import { FlagChips } from './flags';

const COLS: [string, string, string][] = [['advised', 'Advised', 'Told the plan; has not said yes'], ['agreed', 'Agreed', 'Price agreed; sittings not all paid'], ['paid', 'Paid', 'Every sitting paid for']];
const SIT: Record<string, string> = { planned: 'Not booked', confirmed: 'Booked', in_progress: 'Happening', done: 'Done', missed: 'Missed', cancelled: 'Cancelled', postponed: 'Postponed' };

/** Every procedure plan on one board, and each plan's sittings: planned, done, paid, and what was done. */
export function ProcedureBoard() {
  const nav = useNavigate(); const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['procedure-plans'], queryFn: () => get('/procedure-plans'), refetchInterval: 30000 });
  if (!q.data) return <Skeleton rows={4} />;
  const plans: any[] = q.data.plans;
  if (!plans.length) return <div className="card"><Empty icon="check" title="No procedure plans yet" hint="They appear here when the doctor advises a procedure." /></div>;
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      {COLS.map(([k, label, hint]) => (
        <div key={k}>
          <div className="mb-2 flex items-baseline gap-2"><b className="text-sm">{label}</b><span className="text-xs text-muted">{q.data.counts[k]} · {hint}</span></div>
          <div className="space-y-2">{plans.filter((p) => p.state === k).map((p) => (
            <div key={p.id} className="card !p-3">
              <button className="w-full text-left" onClick={() => setOpen(open === p.id ? null : p.id)} aria-expanded={open === p.id}>
                <div className="flex flex-wrap items-center gap-1.5"><b className="text-sm">{p.patient.fullName}</b><FlagChips flags={p.patient.flags} /></div>
                <div className="text-sm text-ink-2">{p.procedure} · {p.doneSittings} of {p.sittings} done{p.totalPaise != null ? ` · ${money(p.totalPaise)}` : p.listPaise ? ` · list ${money(p.listPaise)}` : ''}</div>
                {p.quote && <div className="mt-1"><Chip tone={p.quote.state === 'expired' ? 'rose' : p.quote.state === 'open' ? 'sky' : ''}>{p.quote.number} {p.quote.state === 'expired' ? 'expired' : p.quote.state === 'open' ? `valid to ${fmtDate(p.quote.validUntil)}` : p.quote.state}</Chip></div>}
              </button>
              {open === p.id && <div className="mt-2 border-t border-line/60 pt-2">
                <table className="w-full text-xs"><thead><tr className="text-left text-muted"><th className="py-1">#</th><th>Status</th><th>When</th><th>Paid</th></tr></thead>
                  <tbody>{p.ledger.map((s: any) => <tr key={s.n} className="border-t border-line/40"><td className="py-1">{s.n}</td><td>{SIT[s.state] ?? s.state}{s.did ? <div className="text-muted">{s.did}</div> : null}</td><td>{s.day ? fmtDate(s.day) : '–'}{s.doctor ? <div className="text-muted">{s.doctor}</div> : null}</td><td>{s.paid ? (s.prepaid ? 'from advance' : 'paid') : s.state === 'done' ? 'due' : '–'}</td></tr>)}</tbody></table>
                <button className="btn btn-sm mt-2" onClick={() => nav(`/patients/${p.patient.id}`)}>Open record</button></div>}
            </div>))}
            {!plans.some((p) => p.state === k) && <div className="rounded-xl border border-dashed border-line px-3 py-6 text-center text-xs text-muted">None</div>}</div>
        </div>))}
    </div>
  );
}
