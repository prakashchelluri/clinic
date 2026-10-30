import { useState } from 'react';
import { Icon } from './ui';
import { norm, uniq, type Tmpl } from './templates';

export type Answers = Record<string, { a: 'yes' | 'no'; detail?: string }>;
export type History = Record<string, { yes: boolean; note?: string }>;
export const HISTORY: [string, string, string][] = [['diabetes', 'Diabetes', 'Which medicine'], ['thyroid', 'Thyroid', 'Which medicine'], ['bp', 'BP', 'Which medicine'], ['allergy', 'Allergy', 'Allergic to what'], ['other', 'Other', 'Asthma, kidney, liver, pregnancy…']];

/** The checklists that belong to the complaints picked at check-in; a question asked by two complaints is asked once. */
export function checklists(complaints: string[], all: Tmpl[]) {
  const mine = all.filter((t) => t.kind === 'complaint' && (complaints.includes(norm(t.name)) || (t.linked.complaints ?? []).some((c) => complaints.includes(norm(c)))));
  const seen = new Set<string>();
  return mine.map((t) => ({ name: t.name, questions: (t.payload.questions ?? []).filter((q: any) => !seen.has(q.q) && seen.add(q.q)) as { q: string; detail?: string }[] })).filter((c) => c.questions.length);
}

const YesNo = ({ value, onChange, disabled }: { value?: 'yes' | 'no'; onChange: (v: 'yes' | 'no' | undefined) => void; disabled?: boolean }) => (
  <span className="inline-flex gap-1.5" role="radiogroup">
    {(['yes', 'no'] as const).map((v) => <button key={v} type="button" role="radio" aria-checked={value === v} disabled={disabled} className={`toggle-opt !py-1 !px-3.5 ${value === v ? (v === 'yes' ? 'on !bg-clay-soft !text-clay !border-clay/40' : 'on') : ''}`} onClick={() => onChange(value === v ? undefined : v)}>{v === 'yes' ? 'Yes' : 'No'}</button>)}
  </span>
);

/** The junior doctor's part: tap Yes or No for each question of each complaint, then the medical history. Nothing is typed unless a Yes needs one detail. */
export function ScreenBlock({ lists, answers, onAnswers, history, onHistory, disabled, open: forceOpen }: { lists: ReturnType<typeof checklists>; answers: Answers; onAnswers: (a: Answers) => void; history: History; onHistory: (h: History) => void; disabled: boolean; open?: boolean }) {
  const total = lists.reduce((n, l) => n + l.questions.length, 0);
  const asked = lists.reduce((n, l) => n + l.questions.filter((q) => answers[q.q]).length, 0);
  const [open, setOpen] = useState(forceOpen ?? asked < total);
  const set = (q: string, v: { a: 'yes' | 'no'; detail?: string } | undefined) => { const n = { ...answers }; if (v) n[q] = v; else delete n[q]; onAnswers(n); };
  const rest = () => { const n = { ...answers }; for (const l of lists) for (const q of l.questions) if (!n[q.q]) n[q.q] = { a: 'no' }; onAnswers(n); };
  const setH = (k: string, v: { yes: boolean; note?: string } | undefined) => { const n = { ...history }; if (v) n[k] = v; else delete n[k]; onHistory(n); };
  return (
    <div className="border-b border-line/70 px-4 py-3" id="sec-screen">
      <button type="button" className="flex w-full items-center gap-2 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="text-xs font-bold text-muted w-24 shrink-0">Checklist</span>
        <span className="text-sm font-semibold">{total ? `${asked} of ${total} asked` : 'No checklist for these complaints'}</span>
        <span className="text-xs text-muted">{Object.values(history).some((h) => h.yes) ? '· history noted' : ''}</span>
        <Icon name="chevR" className={`ml-auto h-4 w-4 text-muted transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && <div className="mt-2 space-y-4 anim-fade-up">
        {lists.map((l) => (
          <div key={l.name}>
            <div className="mb-1 flex items-center gap-2"><b className="text-[15px]">{l.name}</b>{!disabled && <button type="button" className="btn btn-sm ml-auto" onClick={rest}>All the rest: No</button>}</div>
            {l.questions.map((q) => { const a = answers[q.q]; return (
              <div key={q.q} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-line/60 py-2 text-[14.5px] first:border-t-0">
                <span className="min-w-0 flex-1">{q.q}</span>
                <YesNo value={a?.a} disabled={disabled} onChange={(v) => set(q.q, v ? { a: v, ...(v === 'yes' && a?.detail ? { detail: a.detail } : {}) } : undefined)} />
                {a?.a === 'yes' && q.detail && <input aria-label={`${q.q} ${q.detail}`} className="input !py-1.5 text-sm basis-full" maxLength={120} placeholder={q.detail} value={a.detail ?? ''} disabled={disabled} onChange={(e) => set(q.q, { a: 'yes', detail: e.target.value })} />}
              </div>); })}
          </div>))}
        <div>
          <div className="mb-1 flex items-center gap-2"><b className="text-[15px]">Medical history</b><span className="text-xs text-muted">asked once, kept for every visit</span></div>
          {HISTORY.map(([k, label, ph]) => { const h = history[k]; return (
            <div key={k} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-line/60 py-2 text-[14.5px] first:border-t-0">
              <span className="w-24">{label}</span>
              <YesNo value={h ? (h.yes ? 'yes' : 'no') : undefined} disabled={disabled} onChange={(v) => setH(k, v ? { yes: v === 'yes', ...(v === 'yes' && h?.note ? { note: h.note } : {}) } : undefined)} />
              {h?.yes && <input aria-label={`${label}: ${ph}`} className="input !py-1.5 text-sm min-w-0 flex-1 basis-56" maxLength={120} placeholder={ph} value={h.note ?? ''} disabled={disabled} onChange={(e) => setH(k, { yes: true, note: e.target.value })} />}
            </div>); })}
        </div>
      </div>}
    </div>
  );
}

/** What the senior doctor reads first: only what was found. Everything answered No is one grey line. */
export function ScreeningCard({ complaintText, lists, answers, history, by }: { complaintText: string; lists: ReturnType<typeof checklists>; answers: Answers; history: History; by?: string }) {
  const qs = lists.flatMap((l) => l.questions);
  const yes = qs.filter((q) => answers[q.q]?.a === 'yes'); const no = qs.filter((q) => answers[q.q]?.a === 'no'); const unasked = qs.filter((q) => !answers[q.q]);
  const hy = HISTORY.filter(([k]) => history[k]?.yes); const hn = HISTORY.filter(([k]) => k !== 'other' && history[k] && !history[k].yes);
  const short = (q: string) => q.replace(/\?$/, '');
  if (!complaintText && !qs.length && !hy.length) return null;
  return (
    <div className="card-flat p-3.5" aria-label="Screening">
      <div className="flex items-center"><span className="text-[11px] font-bold uppercase tracking-wider text-muted">Screening</span>{by && <span className="ml-auto text-xs text-muted">{by}</span>}</div>
      {complaintText && <div className="mt-1 text-[15px] font-semibold leading-snug">{complaintText}</div>}
      {yes.length > 0 && <ul className="mt-2 space-y-1 text-[14px]">{yes.map((q) => <li key={q.q}>• <b>{short(q.q)}</b>{answers[q.q].detail ? <span className="text-ink-2"> · {answers[q.q].detail}</span> : ''}</li>)}</ul>}
      {no.length > 0 && <div className="mt-2 text-xs text-muted">Answered No: {no.map((q) => short(q.q)).join(' · ')}</div>}
      {unasked.length > 0 && (yes.length > 0 || no.length > 0) && <div className="mt-1 text-xs text-amber">{unasked.length > 3 ? `${unasked.length} questions not asked` : `Not asked: ${unasked.map((q) => short(q.q)).join(' · ')}`}</div>}
      {(hy.length > 0 || hn.length > 0) && <div className="mt-2.5 border-t border-line/70 pt-2 text-[13.5px]">
        {hy.length > 0 && <div>{hy.map(([k, l]) => <span key={k} className="mr-3"><b>{l}</b>{history[k].note ? ` · ${history[k].note}` : ''}</span>)}</div>}
        {hn.length > 0 && <div className="text-xs text-muted">No {hn.map(([, l]) => l.toLowerCase()).join(' · no ')}</div>}
      </div>}
    </div>
  );
}

export const complaintTexts = (details: any, chief: any): string[] => uniq([
  ...((details?.complaints ?? []) as { text: string }[]).map((c) => c.text),
  ...(Array.isArray(chief) ? chief : chief ? [chief] : []).map((x: any) => (typeof x === 'string' ? x : x?.name ?? '')),
].map((x) => norm(String(x))).filter(Boolean));
