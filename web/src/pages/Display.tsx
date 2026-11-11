import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { get, ApiError } from '../api';
import { chime } from '../chime';
import { WORDS, asLang } from '../i18n/patient';

type Lane = { doctor: string; now: string | null; next: string[]; withJunior: string[] };

const clock = () => new Date().toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }).replace(/\s?([AaPp])\.?[Mm]\.?/, (_, a: string) => ` ${a.toLowerCase()}m`);
/** Only these mean the link itself is wrong; anything else is a blip and the board stays up. */
const badLink = (e: unknown) => e instanceof ApiError && [401, 403, 404].includes(e.status);

/** The waiting-room screen: tokens only, big enough to read across the room, a chime whenever a new token is called. Open on a TV or tablet from the link in Settings. */
export function Display() {
  const { slug, token } = useParams();
  const q = useQuery<{ clinic: string; at: string; lanes: Lane[]; unassigned: string[]; lang?: string }>({ queryKey: ['display', slug, token], queryFn: () => get(`/public/display/${slug}/${token}`), refetchInterval: 5000, retry: (n, e) => !badLink(e) && n < 2 });
  const last = useRef<string>('');
  // browsers play sound only after one tap on the page: ask for it once
  const [sound, setSound] = useState(false);
  // the clock ticks on its own, whether or not the queue changes
  const [time, setTime] = useState(clock);
  useEffect(() => { const t = setInterval(() => setTime(clock()), 30_000); return () => clearInterval(t); }, []);
  useEffect(() => {
    if (!q.data) return;
    const key = q.data.lanes.map((l) => l.now ?? '-').join('|');
    if (last.current && key !== last.current && q.data.lanes.some((l) => l.now && !last.current.split('|').includes(l.now))) chime('ready');
    last.current = key;
  }, [q.data]);
  if (badLink(q.error)) return <div className="grid min-h-dvh place-items-center bg-[#15181B] p-8 text-center text-white/70"><div><div className="text-2xl font-semibold">This screen link is not valid</div><div className="mt-2 text-base">Ask the clinic to open Settings → Clinic → Waiting-room display and use the current link.</div></div></div>;
  if (!q.data) return <div className="grid min-h-dvh place-items-center bg-[#15181B] text-white/60">{q.isError ? 'Reconnecting…' : 'Connecting…'}</div>;
  const d = q.data; const many = d.lanes.length > 1;
  // a room of patients: the clinic's language first, English beside it
  const lang = asLang(d.lang); const say = (k: 'now' | 'next' | 'waiting' | 'nobody' | 'withJunior' | 'waitForToken' | 'tapSound' | 'chimeHint') => lang === 'en' ? WORDS.en[k] : `${WORDS[lang][k]} · ${WORDS.en[k]}`;
  return (
    <div className="min-h-dvh bg-[#15181B] px-8 py-6 text-white" style={{ fontFeatureSettings: '"tnum" 1' }}>
      {!sound && <button type="button" className="fixed inset-0 z-50 grid place-items-center bg-[#15181B]/90 text-center text-white" onClick={() => { chime('ready'); setSound(true); }}>
        <span><span className="block text-[40px] font-semibold">{say('tapSound')}</span><span className="mt-3 block text-[20px] text-white/70">{say('chimeHint')}</span></span>
      </button>}
      <div className="flex items-center justify-between text-[22px] text-white/70"><span className="font-semibold text-white">{d.clinic}</span><span className="flex items-center gap-4">{q.isError && <span className="text-[16px] text-[#F2B8A2]" role="status">Reconnecting…</span>}{time}</span></div>
      <div className={`mt-8 grid gap-6 ${many ? 'md:grid-cols-2' : ''}`}>
        {d.lanes.length === 0 && d.unassigned.length === 0 && <div className="py-24 text-center text-[28px] text-white/50">{say('nobody')}</div>}
        {d.lanes.map((l) => (
          <section key={l.doctor} className="rounded-2xl border border-white/10 bg-white/5 p-8">
            <div className="text-[22px] font-medium text-white/70">{l.doctor}</div>
            <div className="mt-6 text-[20px] uppercase tracking-[0.12em] text-white/50">{say('now')}</div>
            <div className={`mt-1 font-semibold leading-none tracking-tight ${many ? 'text-[96px]' : 'text-[140px]'} ${l.now ? 'text-[#F2B8A2]' : 'text-white/30'}`}>{l.now ?? '—'}</div>
            <div className="mt-8 text-[20px] uppercase tracking-[0.12em] text-white/50">{say('next')}</div>
            <div className="mt-2 flex flex-wrap gap-4">{l.next.length ? l.next.map((n, i) => <span key={n} className={`rounded-xl px-5 py-2 font-semibold ${i === 0 ? 'bg-white text-[#15181B] text-[40px]' : 'bg-white/10 text-white/80 text-[32px]'}`}>{n}</span>) : <span className="text-[28px] text-white/40">—</span>}</div>
            {l.withJunior.length > 0 && <div className="mt-6 text-[20px] text-white/50">{say('withJunior')}: {l.withJunior.join(', ')}</div>}
          </section>))}
      </div>
      {d.unassigned.length > 0 && <section className="mt-6 rounded-2xl border border-white/10 bg-white/5 p-8"><div className="text-[20px] uppercase tracking-[0.12em] text-white/50">{say('waiting')}</div><div className="mt-2 flex flex-wrap gap-4">{d.unassigned.map((n, i) => <span key={n} className={`rounded-xl px-5 py-2 font-semibold ${i === 0 ? 'bg-white text-[#15181B] text-[40px]' : 'bg-white/10 text-white/80 text-[32px]'}`}>{n}</span>)}</div></section>}
      <div className="mt-10 text-center text-[24px] text-white/70">{say('waitForToken')}</div>
    </div>
  );
}
