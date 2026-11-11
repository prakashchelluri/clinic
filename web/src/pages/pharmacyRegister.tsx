import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { get, post, today, errText } from '../api';
import { openPrint } from '../printPreview';
import { Chip, Icon, toast } from '../ui';
import { DataTable, filterValue, type Col, type FilterDef } from '../table';

const minusDays = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() - n); return x.toISOString().slice(0, 10); };
const day = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
const exp = (d: string | null) => (d ? d.slice(5, 7) + '/' + d.slice(2, 4) : '');
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const COLS = ['Date', 'Bill', 'Patient', 'Age / sex', 'Address', 'Prescriber', 'Reg. no.', 'Medicine', 'Class', 'Batch', 'Expiry', 'Qty', 'Returned'];
const cells = (r: any) => [day(r.at), r.invoiceNo, r.patientNo ? `${r.patient} (${r.patientNo})` : r.patient, [r.age, r.sex].filter(Boolean).join(' '), r.address ?? '', r.noRx ? 'No Rx (not prescribed)' : r.doctor ?? '', r.regNo ?? '', r.medicine, r.cls, r.batchNo ?? '', exp(r.expiry), r.qty, r.returned || ''];

const RANGE: FilterDef<any> = { key: 'range', label: 'Dates', icon: 'calendar', initial: '30', options: [{ value: '30', label: 'Last 30 days' }, { value: '90', label: 'Last 90 days' }, { value: '365', label: 'Last year' }, { value: 'custom', label: 'Pick dates' }] };
const SCHED: FilterDef<any> = { key: 'sched', label: 'Schedule', icon: 'pill', options: [{ value: 'all', label: 'All schedules' }, { value: 'H', label: 'Schedule H' }, { value: 'H1', label: 'Schedule H1' }, { value: 'X', label: 'Schedule X' }] };
/** Which of the register's cells a column shows, and whether it sorts. */
const SORTS: Record<number, (r: any) => string | number> = { 0: (r) => r.at, 1: (r) => r.invoiceNo, 2: (r) => String(r.patient).toLowerCase(), 5: (r) => r.doctor ?? '', 7: (r) => String(r.medicine).toLowerCase(), 8: (r) => r.cls, 12: (r) => r.returned ?? 0 };
const COLUMNS: Col<any>[] = COLS.map((label, k) => ({
  key: String(k), label, fixed: k === 0, sort: SORTS[k], csv: (r: any) => cells(r)[k],
  cell: (r: any) => { const c = cells(r)[k]; return k === 8 ? <Chip tone={c === 'H' ? '' : 'clay'}>{c}</Chip> : <span className={k === 5 && r.noRx ? 'font-bold text-rose' : k === 0 || k === 1 || k === 10 ? 'whitespace-nowrap' : ''}>{c}</span>; },
}));

/** The Schedule H / H1 / X register: built from the bills, nobody types into it. Print or download for an inspector. */
export function RegisterTab({ clinic, licence }: { clinic: string; licence?: string | null }) {
  const [sp, setSp] = useSearchParams();
  const range = filterValue(sp, RANGE), cls = filterValue(sp, SCHED);
  const from = sp.get('from') ?? minusDays(today(), 29), to = sp.get('to') ?? today();
  const setDate = (k: 'from' | 'to', v: string) => v && setSp((p) => { const n = new URLSearchParams(p); n.set(k, v); n.delete('p'); return n; }, { replace: true });
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
      {noRx > 0 && <div className="rounded-[10px] bg-amber-soft px-3.5 py-2 text-sm text-[#6E4D10]">{noRx} entr{noRx === 1 ? 'y was' : 'ies were'} sold without a prescription line (older bills, before the counter checked this). These drugs need one: check those bills.</div>}
      <DataTable id="schedule-register" rows={rows.map((r, i) => ({ ...r, _k: i }))} rowKey={(r: any) => String(r._k)} columns={COLUMNS} loading={q.isLoading} exportable={false}
        sort={{ key: '0', dir: -1 }} filters={[RANGE, SCHED]} search={{ placeholder: 'Find in the register: patient, medicine or bill', text: (r: any) => [r.patient, r.patientNo, r.medicine, r.invoiceNo, r.batchNo] }}
        empty={{ title: bad ? 'Check the dates' : 'Nothing sold in this period', hint: bad ? '“From” is after “to”.' : "Medicines marked Schedule H, H1 or X appear here by themselves when they are billed. Set a medicine's schedule under Settings → Medicines." }}
        toolbar={<>
          {range === 'custom' && <span className="inline-flex items-center gap-1.5 text-[12.5px] text-muted"><input type="date" aria-label="From" className={`dt-select ${bad ? '!border-rose' : ''}`} value={from} onChange={(e) => setDate('from', e.target.value)} />to<input type="date" aria-label="To" className={`dt-select ${bad ? '!border-rose' : ''}`} value={to} onChange={(e) => setDate('to', e.target.value)} /></span>}
          <span className="order-last ml-auto flex gap-2"><button type="button" className="dt-ghost" disabled={!rows.length || bad} onClick={print}><Icon name="print" className="h-3.5 w-3.5" />Print</button><button type="button" className="dt-ghost" disabled={!rows.length || bad} onClick={csv}><Icon name="download" className="h-3.5 w-3.5" />Download</button></span>
        </>} />
      <div className="text-xs text-muted">Built from the pharmacy bills, so it cannot be edited. A return shows in the Returned column. Print or download is recorded in the audit log.</div>
    </div>
  );
}
