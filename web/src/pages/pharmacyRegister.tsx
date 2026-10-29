import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { get, post, today, errText } from '../api';
import { openPrint } from '../printPreview';
import { Chip, Empty, Icon, Segmented, Skeleton, toast } from '../ui';

const minusDays = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() - n); return x.toISOString().slice(0, 10); };
const day = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
const exp = (d: string | null) => (d ? d.slice(5, 7) + '/' + d.slice(2, 4) : '');
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const COLS = ['Date', 'Bill', 'Patient', 'Age / sex', 'Address', 'Prescriber', 'Reg. no.', 'Medicine', 'Class', 'Batch', 'Expiry', 'Qty', 'Returned'];
const cells = (r: any) => [day(r.at), r.invoiceNo, `${r.patient} (${r.patientNo})`, [r.age, r.sex].filter(Boolean).join(' '), r.address ?? '', r.noRx ? 'NO PRESCRIPTION' : r.doctor ?? '', r.regNo ?? '', r.medicine, r.cls, r.batchNo ?? '', exp(r.expiry), r.qty, r.returned || ''];

/** The Schedule H / H1 / X register: built from the bills, nobody types into it. Print or download for an inspector. */
export function RegisterTab({ clinic, licence }: { clinic: string; licence?: string | null }) {
  const [range, setRange] = useState<'30' | '90' | '365' | 'custom'>('30');
  const [from, setFrom] = useState(minusDays(today(), 29)); const [to, setTo] = useState(today());
  const [cls, setCls] = useState<'all' | 'H' | 'H1' | 'X'>('all');
  const span = range === 'custom' ? [from, to] : [minusDays(today(), Number(range) - 1), today()];
  const bad = span[0] > span[1];
  const q = useQuery({ queryKey: ['pharmacy', 'register', span[0], span[1], cls], queryFn: () => get(`/pharmacy/schedule-register?from=${span[0]}&to=${span[1]}&cls=${cls}`), enabled: !bad });
  const rows: any[] = q.data ?? [];
  const noRx = rows.filter((r) => r.noRx).length;
  const record = (how: 'print' | 'csv') => post('/pharmacy/schedule-register/export', { from: span[0], to: span[1], how }).then(() => true, (e) => { toast(errText(e), 'err'); return false; });
  const print = async () => {
    if (!(await record('print'))) return;
    const html = `<!doctype html><meta charset="utf-8"><title>Schedule H register</title><style>@page{size:A4 landscape;margin:10mm}body{font:11px system-ui,sans-serif;color:#111}h1{font-size:15px;margin:0}p{margin:2px 0 8px;color:#444}table{border-collapse:collapse;width:100%}th,td{border:1px solid #999;padding:3px 5px;text-align:left;vertical-align:top}th{background:#eee}.x{color:#b00;font-weight:700}</style>
      <h1>${esc(clinic)} · Schedule H / H1 / X register</h1><p>${esc(licence ? `Drug licence ${licence} · ` : '')}${esc(day(span[0]))} to ${esc(day(span[1]))} · ${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}</p>
      <table><thead><tr>${COLS.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${cells(r).map((c, i) => `<td${i === 5 && r.noRx ? ' class="x"' : ''}>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    openPrint({ title: 'Schedule H register', html });
  };
  const csv = async () => {
    if (!(await record('csv'))) return;
    const body = [COLS, ...rows.map(cells)].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob(['﻿' + body], { type: 'text/csv;charset=utf-8' })); const a = document.createElement('a'); a.href = url; a.download = `schedule-h-register-${span[0]}-to-${span[1]}.csv`; a.click(); URL.revokeObjectURL(url);
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented value={range} onChange={setRange} options={[{ value: '30', label: '30 days' }, { value: '90', label: '90 days' }, { value: '365', label: 'Year' }, { value: 'custom', label: 'Dates' }]} />
        {range === 'custom' && <><input type="date" aria-label="From" className={`input !w-auto ${bad ? '!border-rose' : ''}`} value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} /><input type="date" aria-label="To" className={`input !w-auto ${bad ? '!border-rose' : ''}`} value={to} onChange={(e) => e.target.value && setTo(e.target.value)} /></>}
        <div className="flex gap-1.5" role="radiogroup" aria-label="Class">{(['all', 'H', 'H1', 'X'] as const).map((c) => <button key={c} role="radio" aria-checked={cls === c} className={`toggle-opt !py-1 ${cls === c ? 'on' : ''}`} onClick={() => setCls(c)}>{c === 'all' ? 'All classes' : `Schedule ${c}`}</button>)}</div>
        <span className="ml-auto flex gap-2"><button className="btn btn-sm" disabled={!rows.length || bad} onClick={print}><Icon name="print" className="h-3.5 w-3.5" />Print</button><button className="btn btn-sm" disabled={!rows.length || bad} onClick={csv}><Icon name="download" className="h-3.5 w-3.5" />Download</button></span>
      </div>
      {bad && <div className="text-sm text-rose">“From” is after “to”.</div>}
      {noRx > 0 && <div className="rounded-2xl bg-amber-soft px-3.5 py-2 text-sm text-[#6E4D10]">{noRx} entr{noRx === 1 ? 'y was' : 'ies were'} sold with no prescription on file. These drugs need one: check those bills.</div>}
      <section className="card-flat overflow-hidden">
        {q.isLoading ? <div className="p-4"><Skeleton rows={5} /></div> : rows.length === 0 ? <Empty icon="pill" title="Nothing sold in this period" hint="Medicines marked Schedule H, H1 or X appear here by themselves when they are billed. Set a medicine's schedule under Settings → Medicines." /> : (
          <div className="overflow-x-auto"><table className="table min-w-[980px]">
            <thead><tr>{COLS.map((c) => <th key={c}>{c}</th>)}</tr></thead>
            <tbody>{rows.map((r, i) => <tr key={i}>{cells(r).map((c, k) => <td key={k} className={k === 5 && r.noRx ? 'font-bold text-rose' : k === 8 ? '' : ''}>{k === 8 ? <Chip tone={c === 'H' ? '' : 'clay'}>{c}</Chip> : c}</td>)}</tr>)}</tbody>
          </table></div>)}
      </section>
      <div className="text-xs text-muted">Built from the pharmacy bills, so it cannot be edited. A return shows in the Returned column. Print or download is recorded in the audit log.</div>
    </div>
  );
}
