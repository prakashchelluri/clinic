import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useParams, useSearchParams } from 'react-router';
import { get, post, qc, errText } from '../api';
import { Chip, Icon, Skeleton } from '../ui';
import { LANG_NAMES, WORDS, asLang, niceDate, type Lang } from '../i18n/patient';

const addDays = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const TONE: Record<string, 'clay' | 'sage' | 'amber' | 'rose' | 'sky' | ''> = { booked: '', confirmed: 'sage', arrived: 'sky', cancelled: 'rose', no_show: 'rose' };

/** The patient's own link from WhatsApp: see the visit, confirm, cancel or pick another time. In the patient's language; they can switch. */
export function PatientLink() {
  const { slug = '', token = '' } = useParams(); const [params] = useSearchParams();
  const base = `/public/a/${slug}/${token}`;
  const q = useQuery({ queryKey: ['patient-link', token], queryFn: () => get(base), retry: false });
  const [picked, setLang] = useState<Lang | null>(null);
  const lang = picked ?? asLang(q.data?.lang); const w = WORDS[lang];
  const [mode, setMode] = useState<null | 'cancel' | 'move'>(null);
  const [reason, setReason] = useState('');
  const set = (r: any) => { qc.setQueryData(['patient-link', token], r); setMode(null); };
  const confirm = useMutation({ mutationFn: () => post(`${base}/confirm`), onSuccess: set });
  const cancel = useMutation({ mutationFn: () => post(`${base}/cancel`, { reason: reason.trim() || undefined }), onSuccess: set });
  const move = useMutation({ mutationFn: (sessionId: string) => post(`${base}/reschedule`, { sessionId }), onSuccess: set });
  const v = q.data;
  const err = confirm.error ?? cancel.error ?? move.error;
  const langs = <LangSwitch lang={lang} onPick={setLang} />;

  if (q.isLoading) return <PublicShell><div className="card"><Skeleton rows={5} /></div></PublicShell>;
  if (q.isError) return <PublicShell>{langs}<div className="card text-center"><div className="text-lg font-semibold">{w.badLink}</div><div className="mt-1 text-sm text-muted">{w.badLinkHint}</div></div></PublicShell>;
  return (
    <PublicShell name={v.clinic.name}>
      {langs}
      {params.get('new') && v.status !== 'cancelled' && <div className="rounded-2xl bg-sage-soft px-4 py-3 text-sm text-sage anim-fade-up"><b>{w.booked}</b> {w.keepPage}</div>}
      <div className="card">
        <div className="text-sm text-muted">{w.hello(v.patient)}</div>
        <div className="mt-1 text-[26px] font-semibold leading-tight">{niceDate(v.day, lang)} · {v.startTime}</div>
        <div className="mt-1 text-[15px]">{v.visitType ?? w.visit}{v.doctor ? w.withDoctor(v.doctor) : ''}</div>
        {!['cancelled', 'no_show'].includes(v.status) && <div className="mt-3 rounded-xl bg-paper px-3 py-2.5 text-sm">{w.arriveBy(v.arriveBy)}</div>}
        <div className="mt-3"><Chip tone={TONE[v.status] ?? ''}>{w.status[v.status] ?? v.status}</Chip></div>
      </div>
      {err && <div className="rounded-2xl bg-rose-soft px-4 py-3 text-sm text-rose">{errText(err)}</div>}
      {mode === null && <div className="space-y-2">
        {v.canConfirm && <button className="btn btn-primary w-full justify-center !py-3.5" disabled={confirm.isPending} onClick={() => confirm.mutate()}><Icon name="check" />{w.yesComing}</button>}
        {v.canReschedule && <button className="btn w-full justify-center !py-3.5" onClick={() => setMode('move')}><Icon name="calendar" />{w.change}</button>}
        {v.canCancel && <button className="btn btn-ghost w-full justify-center !py-3.5 !text-rose" onClick={() => setMode('cancel')}>{w.cancelVisit}</button>}
      </div>}
      {mode === 'cancel' && <div className="card space-y-3 anim-fade-up">
        <label className="label" htmlFor="pl-reason">{w.reason}</label>
        <input id="pl-reason" className="input" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={w.reasonEg} />
        <div className="flex gap-2"><button className="btn btn-primary !bg-rose !border-rose" disabled={cancel.isPending} onClick={() => cancel.mutate()}>{w.doCancel}</button><button className="btn btn-ghost" onClick={() => setMode(null)}>{w.keep}</button></div>
      </div>}
      {mode === 'move' && <MoveSlots base={base} day={v.day} lang={lang} busy={move.isPending} onPick={(id) => move.mutate(id)} onBack={() => setMode(null)} />}
      {!v.canCancel && ['booked', 'confirmed'].includes(v.status) && <div className="text-center text-sm text-muted">{w.tooLate(v.cancelWindowHours)} {v.clinic.phone ? <a className="underline" href={`tel:${v.clinic.phone}`}>{v.clinic.phone}</a> : w.theClinic}.</div>}
      {v.policy && <div className="text-center text-xs text-muted">{v.policy}</div>}
    </PublicShell>
  );
}

function LangSwitch({ lang, onPick }: { lang: Lang; onPick: (l: Lang) => void }) {
  return <div className="flex justify-end gap-1" role="group" aria-label="Language">{LANG_NAMES.map(([k, l]) => <button key={k} type="button" lang={k} aria-pressed={lang === k} className={`toggle-opt ${lang === k ? 'on' : ''}`} onClick={() => onPick(k)}>{l}</button>)}</div>;
}

function MoveSlots({ base, day, lang, busy, onPick, onBack }: { base: string; day: string; lang: Lang; busy: boolean; onPick: (id: string) => void; onBack: () => void }) {
  const w = WORDS[lang];
  const todayIst = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const [from, setFrom] = useState(day > todayIst ? todayIst : todayIst);
  const q = useQuery({ queryKey: ['patient-link-slots', base, from], queryFn: () => get(`${base}/slots?from=${from}&days=7`) });
  const days: any[] = (q.data ?? []).filter((d: any) => d.slots.length);
  const [sel, setSel] = useState<null | { id: string; day: string; startTime: string }>(null);
  if (sel) return (
    <div className="card space-y-3 anim-fade-up" role="status">
      <div className="text-[15px]">{w.moveTo} <b>{niceDate(sel.day, lang)}, {sel.startTime}</b>?</div>
      <div className="text-sm text-muted">{w.oldGivenUp}</div>
      <div className="flex gap-2"><button className="btn btn-primary !py-3 flex-1 justify-center" disabled={busy} onClick={() => onPick(sel.id)}><Icon name="check" />{w.move}</button><button className="btn btn-ghost !py-3" onClick={() => setSel(null)}>{w.cancel}</button></div>
    </div>
  );
  return (
    <div className="card space-y-3 anim-fade-up">
      <div className="flex items-center"><b>{w.pickNew}</b><span className="ml-auto flex gap-1"><button className="btn btn-ghost btn-icon" aria-label={w.earlier} disabled={from <= todayIst} onClick={() => setFrom(addDays(from, -7) < todayIst ? todayIst : addDays(from, -7))}><Icon name="chevL" /></button><button className="btn btn-ghost btn-icon" aria-label={w.later} onClick={() => setFrom(addDays(from, 7))}><Icon name="chevR" /></button></span></div>
      {q.isLoading ? <Skeleton rows={3} /> : q.isError ? <div className="text-sm text-rose">{errText(q.error)}</div> : days.length === 0 ? <div className="text-sm text-muted">{w.noTimes}</div> : days.map((d) => (
        <div key={d.day}><div className="mb-1 text-xs font-semibold text-muted">{niceDate(d.day, lang)}</div><div className="grid grid-cols-3 gap-2">{d.slots.map((s: any) => <button key={s.id} disabled={busy} onClick={() => setSel({ id: s.id, day: d.day, startTime: s.startTime })} className="rounded-xl bg-white py-2.5 text-sm font-semibold hover:ring-1 hover:ring-ink">{s.startTime}</button>)}</div></div>
      ))}
      <button className="btn btn-ghost btn-sm" onClick={onBack}>{w.back}</button>
    </div>
  );
}

/** The frame of the patient's own page: the clinic's initial and name, the content, and a quiet footer. */
export function PublicShell({ name, children }: { name?: string; children: React.ReactNode }) {
  return (
    <div className="min-h-dvh px-4 py-6 sm:py-10">
      <div className="mx-auto max-w-[480px] space-y-4">
        <div className="flex items-center gap-3"><span className="grid h-11 w-11 place-items-center rounded-xl bg-ink text-lg font-bold text-white">{(name ?? '·').slice(0, 1)}</span><div className="text-lg font-semibold leading-tight">{name ?? ' '}</div></div>
        {children}
        <div className="pt-4 text-center text-[11px] text-muted">Powered by CUBOTT Clinical</div>
      </div>
    </div>
  );
}
