import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useOutletContext } from 'react-router';
import { get, post, patch, qc, today, fmtTime } from '../api';
import { can } from '../App';
import { Avatar, Chip, Empty, Icon, PageHeader, Section, Skeleton, money, toast } from '../ui';

/** Pharmacy counter: today's prescriptions from the doctor, tick items as dispensed, bill once per visit. */
export function Pharmacy() {
  const { perms } = useOutletContext<any>();
  const [day, setDay] = useState(today());
  const q = useQuery({ queryKey: ['pharmacy', day], queryFn: () => get(`/pharmacy/queue?day=${day}`), refetchInterval: 10000 });
  const [filter, setFilter] = useState('');
  const rows: any[] = (q.data ?? []).filter((r: any) => !filter || r.patient.fullName.toLowerCase().includes(filter.toLowerCase()) || r.opNumber.toLowerCase().includes(filter.toLowerCase()) || (r.patient.phone ?? '').includes(filter));
  const pending = rows.filter((r) => !r.bill);
  const billed = rows.filter((r) => r.bill);
  return (
    <div>
      <PageHeader title="Pharmacy" subtitle={`${pending.length} to dispense · ${billed.length} billed`}>
        <div className="relative"><Icon name="search" className="h-4 w-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" /><input className="input !pl-10 !w-64" placeholder="OP number, name or phone" value={filter} onChange={(e) => setFilter(e.target.value)} /></div>
        <input type="date" className="input !w-auto" value={day} onChange={(e) => setDay(e.target.value)} />
      </PageHeader>
      {q.isLoading ? <Skeleton rows={4} /> : rows.length === 0 ? <div className="card"><Empty icon="pill" title="No prescriptions yet" hint="Completed consultations appear here the moment the doctor prints the Rx." /></div> : (
        <div className="grid lg:grid-cols-2 gap-4 stagger">
          {[...pending, ...billed].map((r, i) => <RxCard key={r.encounterId} r={r} i={i} canBill={can(perms, 'pharmacy.bill')} canDispense={can(perms, 'pharmacy.dispense')} />)}
        </div>
      )}
    </div>
  );
}

function RxCard({ r, i, canBill, canDispense }: { r: any; i: number; canBill: boolean; canDispense: boolean }) {
  const [amount, setAmount] = useState(''); const [method, setMethod] = useState('cash'); const [note, setNote] = useState('');
  const tick = useMutation({ mutationFn: ({ id, dispensed }: any) => patch(`/prescription-items/${id}`, { dispensed }), onSuccess: () => qc.invalidateQueries({ queryKey: ['pharmacy'] }) });
  const bill = useMutation({ mutationFn: () => post('/pharmacy/bill', { visitId: r.visitId, patientId: r.patient.id, amountPaise: Math.round(Number(amount) * 100), method, note: note || undefined }),
    onSuccess: () => { toast(`Billed ${money(Math.round(Number(amount) * 100))}`); qc.invalidateQueries({ queryKey: ['pharmacy'] }); }, onError: (e: any) => toast(e?.body?.code ?? 'Failed', 'err') });
  const allDone = r.items.every((x: any) => x.dispensed);
  return (
    <div className={`card ${r.bill ? 'opacity-75' : ''}`} style={{ ['--i' as any]: i }}>
      <div className="flex items-center gap-3">
        <span className="serif text-lg w-16">{r.opNumber}</span><Avatar name={r.patient.fullName} />
        <div className="min-w-0 flex-1"><div className="font-medium truncate">{r.patient.fullName} <span className="text-xs text-muted font-normal">{r.patient.ageYears ? `${r.patient.ageYears}y` : ''} {r.patient.sex ?? ''}</span></div><div className="text-xs text-muted">{r.patient.patientNo} · Rx {fmtTime(r.completedAt)}</div></div>
        {r.bill ? <Chip tone="sage">billed {money(r.bill.amountPaise)}</Chip> : allDone ? <Chip tone="amber">dispensed · bill pending</Chip> : <Chip>{r.items.filter((x: any) => !x.dispensed).length} to give</Chip>}
        <button className="btn btn-ghost btn-icon" title="Print Rx" onClick={() => window.open(`/print/${r.encounterId}?auto=0`, '_blank')}><Icon name="print" /></button>
      </div>
      {r.patient.allergies && <div className="mt-2 text-xs text-rose bg-rose-soft rounded-lg px-2.5 py-1.5">Allergies: {r.patient.allergies}</div>}
      <div className="mt-3 divide-y divide-line/70">
        {r.items.map((it: any) => (
          <label key={it.id} className={`flex items-start gap-3 py-2 text-sm ${canDispense && !r.bill ? 'cursor-pointer' : ''}`}>
            <input type="checkbox" className="mt-1 accent-clay h-4 w-4" checked={it.dispensed} disabled={!canDispense || !!r.bill} onChange={(e) => tick.mutate({ id: it.id, dispensed: e.target.checked })} />
            <div className="flex-1"><div className={`font-medium ${it.dispensed ? 'line-through text-muted' : ''}`}>{it.name} <span className="font-normal text-muted">{it.dose ?? ''}</span></div><div className="text-xs text-muted">{[it.frequency, it.route, it.durationDays ? `${it.durationDays} days` : null].filter(Boolean).join(' · ')}{it.instructions ? ` — ${it.instructions}` : ''}</div></div>
          </label>
        ))}
      </div>
      {!r.bill && canBill && (
        <div className="mt-3 pt-3 border-t border-line flex items-center gap-2 flex-wrap">
          <div className="flex gap-1">{['cash', 'upi', 'card'].map((m) => <button key={m} type="button" className={`toggle-opt uppercase ${method === m ? 'on' : ''}`} onClick={() => setMethod(m)}>{m}</button>)}</div>
          <input className="input !w-28" inputMode="decimal" placeholder="₹ total" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <input className="input flex-1 min-w-32" placeholder="note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          <button className="btn btn-primary" disabled={!amount || bill.isPending} onClick={() => bill.mutate()}><Icon name="check" />Bill & mark dispensed</button>
        </div>
      )}
    </div>
  );
}
