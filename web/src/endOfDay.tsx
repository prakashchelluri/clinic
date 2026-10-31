import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useOutletContext } from 'react-router';
import { get, post, qc, errText } from './api';
import { can } from './App';
import { Chip, Icon, MoneyInput, Section, Skeleton, fmtDate, money, toPaise, toast } from './ui';

const ROWS: [string, string][] = [['consultation', 'Consultations'], ['procedure', 'Procedures'], ['pharmacy', 'Pharmacy'], ['other', 'Other']];

/** The head receptionist reads one page against the paper diary: money by type and mode, the drawer, and the visit counts. A difference needs a note; closing locks the day. */
export function EndOfDay({ day }: { day: string }) {
  const { perms } = useOutletContext<any>();
  const q = useQuery({ queryKey: ['dayclose', day], queryFn: () => get(`/dayclose?day=${day}`) });
  const [counted, setCounted] = useState(''); const [diary, setDiary] = useState<Record<string, string>>({}); const [notes, setNotes] = useState<Record<string, string>>({});
  const d = q.data;
  const close = useMutation({
    mutationFn: () => post('/dayclose', { day, cashCountedPaise: toPaise(counted), diary: Object.fromEntries(d.countKeys.map((k: string) => [k, Number(diary[k] ?? d.counts[k])])), notes }),
    onSuccess: () => { ['dayclose', 'daily'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); toast('Day closed'); }, onError: (e) => toast(errText(e), 'err'),
  });
  if (!d) return <Skeleton rows={4} />;
  const m = d.money; const cell = (v: number) => <td className="text-right">{money(v)}</td>;
  const cashDiff = counted === '' ? null : toPaise(counted) - d.drawer.expectedCashPaise;
  const diff = (k: string) => (diary[k] === undefined || diary[k] === '' ? 0 : Number(diary[k]) - d.counts[k]);
  const needNote = (k: string) => (k === 'cash' ? cashDiff !== null && cashDiff !== 0 : diff(k) !== 0);
  const lacking = [...d.countKeys, 'cash'].filter((k) => needNote(k) && (notes[k] ?? '').trim().length < 3);
  const locked = !!d.closed;
  return (
    <div className="space-y-4">
      {locked && <div className="card flex items-center gap-2 text-sm"><Icon name="lock" className="h-4 w-4" />Closed by {d.closed.closedBy} on {fmtDate(d.closed.createdAt)}. This day takes no new payments; a mistake is put right by a refund today.</div>}
      <Section title="Money collected">
        <div className="overflow-x-auto"><table className="table min-w-[560px]"><thead><tr><th className="pl-4">Type</th><th className="text-right">Cash</th><th className="text-right">UPI</th><th className="text-right">Card</th><th className="text-right">EMI / other</th><th className="text-right pr-4">Total</th></tr></thead>
          <tbody>{ROWS.map(([k, l]) => <tr key={k}><td className="pl-4">{l}</td>{cell(m[k].cash)}{cell(m[k].upi)}{cell(m[k].card)}{cell(m[k].other)}<td className="text-right pr-4 font-medium">{money(m[k].total)}</td></tr>)}
            <tr className="font-semibold"><td className="pl-4">Total</td>{cell(m.total.cash)}{cell(m.total.upi)}{cell(m.total.card)}{cell(m.total.other)}<td className="text-right pr-4">{money(m.total.total)}</td></tr></tbody></table></div>
        {d.emiAwaitingPaise > 0 && <div className="px-4 pb-3 text-xs text-muted">{money(d.emiAwaitingPaise)} of the EMI figure is still waiting for the lender's money to reach the bank.</div>}
      </Section>
      <Section title="Cash in the drawer">
        <div className="flex flex-wrap items-end gap-4 p-4 text-sm">
          <div><div className="text-xs text-muted">The app says</div><div className="serif text-xl">{money(d.drawer.expectedCashPaise)}</div><div className="text-xs text-muted">cash taken, less {money(d.drawer.expensesCashPaise)} cash expenses</div></div>
          <div><label className="label" htmlFor="counted">Counted</label>{locked ? <div className="serif text-xl">{money(d.closed.cashCountedPaise)}</div> : <MoneyInput id="counted" value={counted} onChange={setCounted} />}</div>
          {cashDiff !== null && !locked && (cashDiff === 0 ? <Chip tone="sage">matches</Chip> : <Chip tone="amber">{cashDiff > 0 ? 'over' : 'short'} by {money(Math.abs(cashDiff))}</Chip>)}
          {!locked && needNote('cash') && <div className="min-w-[220px] flex-1"><label className="label" htmlFor="n-cash">Why</label><input id="n-cash" className="input" maxLength={300} value={notes.cash ?? ''} onChange={(e) => setNotes({ ...notes, cash: e.target.value })} /></div>}
          {locked && d.closed.notes.cash && <div className="text-muted">Note: {d.closed.notes.cash}</div>}
        </div>
      </Section>
      <Section title="Against the doctor's diary">
        <table className="table"><thead><tr><th className="pl-4">Type</th><th className="text-right">Diary</th><th className="text-right">App</th><th className="pr-4"></th></tr></thead>
          <tbody>{d.countKeys.map((k: string) => { const shown = locked ? d.closed.diary[k] : diary[k] ?? String(d.counts[k]); const off = locked ? d.closed.diary[k] !== d.closed.counts[k] : diff(k) !== 0;
            return <tr key={k}><td className="pl-4">{k}</td>
              <td className="text-right">{locked ? shown : <input aria-label={`Diary count for ${k}`} inputMode="numeric" className="input !w-20 !py-1 text-right" value={shown} onChange={(e) => setDiary({ ...diary, [k]: e.target.value.replace(/\D/g, '').slice(0, 4) })} />}</td>
              <td className="text-right">{locked ? d.closed.counts[k] : d.counts[k]}</td>
              <td className="pr-4">{off ? (locked ? <span className="text-xs text-muted">{d.closed.notes[k]}</span> : <input aria-label={`Why ${k} differs`} className="input !py-1" placeholder="Why do they differ?" maxLength={300} value={notes[k] ?? ''} onChange={(e) => setNotes({ ...notes, [k]: e.target.value })} />) : <Chip tone="sage">same</Chip>}</td></tr>; })}</tbody></table>
      </Section>
      {!locked && can(perms, 'day.close') && <div className="flex items-center gap-3"><button className="btn btn-primary" disabled={close.isPending || counted === '' || lacking.length > 0} onClick={() => close.mutate()}><Icon name="lock" />Close the day</button>
        <span className="text-sm text-muted">{counted === '' ? 'Count the drawer first.' : lacking.length ? 'Each difference needs a note before the day can close.' : 'Nothing is left to explain.'}</span></div>}
      {!locked && !can(perms, 'day.close') && <div className="text-sm text-muted">Closing the day needs the Close the day permission.</div>}
    </div>
  );
}
