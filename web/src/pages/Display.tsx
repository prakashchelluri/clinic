import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { get } from '../api';
import { chime } from '../chime';

type Lane = { doctor: string; now: string | null; next: string[]; withJunior: string[] };

/** The waiting-room screen: tokens only, big enough to read across the room, a chime whenever a new token is called. Open on a TV or tablet from the link in Settings. */
export function Display() {
  const { slug, token } = useParams();
  const q = useQuery<{ clinic: string; at: string; lanes: Lane[]; unassigned: string[] }>({ queryKey: ['display', slug, token], queryFn: () => get(`/public/display/${slug}/${token}`), refetchInterval: 5000, retry: 1 });
  const last = useRef<string>('');
  useEffect(() => {
    if (!q.data) return;
    const key = q.data.lanes.map((l) => l.now ?? '-').join('|');
    if (last.current && key !== last.current && q.data.lanes.some((l) => l.now && !last.current.split('|').includes(l.now))) chime('ready');
    last.current = key;
  }, [q.data]);
  const time = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  if (q.isError) return <div className="grid min-h-dvh place-items-center bg-[#15181B] p-8 text-center text-white/70"><div><div className="text-2xl font-semibold">This screen link is not valid</div><div className="mt-2 text-base">Ask the clinic to open Settings → Clinic → Waiting-room display and use the current link.</div></div></div>;
  if (!q.data) return <div className="grid min-h-dvh place-items-center bg-[#15181B] text-white/60">Connecting…</div>;
  const d = q.data; const many = d.lanes.length > 1;
  return (
    <div className="min-h-dvh bg-[#15181B] px-8 py-6 text-white" style={{ fontFeatureSettings: '"tnum" 1' }}>
      <div className="flex items-center justify-between text-[22px] text-white/70"><span className="font-semibold text-white">{d.clinic}</span><span>{time}</span></div>
      <div className={`mt-8 grid gap-6 ${many ? 'md:grid-cols-2' : ''}`}>
        {d.lanes.length === 0 && d.unassigned.length === 0 && <div className="py-24 text-center text-[28px] text-white/50">Nobody is waiting right now.</div>}
        {d.lanes.map((l) => (
          <section key={l.doctor} className="rounded-2xl border border-white/10 bg-white/5 p-8">
            <div className="text-[22px] font-medium text-white/70">{l.doctor}</div>
            <div className="mt-6 text-[20px] uppercase tracking-[0.12em] text-white/50">Now</div>
            <div className={`mt-1 font-semibold leading-none tracking-tight ${many ? 'text-[96px]' : 'text-[140px]'} ${l.now ? 'text-[#F2B8A2]' : 'text-white/30'}`}>{l.now ?? '—'}</div>
            <div className="mt-8 text-[20px] uppercase tracking-[0.12em] text-white/50">Next</div>
            <div className="mt-2 flex flex-wrap gap-4">{l.next.length ? l.next.map((n, i) => <span key={n} className={`rounded-xl px-5 py-2 font-semibold ${i === 0 ? 'bg-white text-[#15181B] text-[40px]' : 'bg-white/10 text-white/80 text-[32px]'}`}>{n}</span>) : <span className="text-[28px] text-white/40">—</span>}</div>
            {l.withJunior.length > 0 && <div className="mt-6 text-[20px] text-white/50">With the junior doctor: {l.withJunior.join(', ')}</div>}
          </section>))}
      </div>
      {d.unassigned.length > 0 && <section className="mt-6 rounded-2xl border border-white/10 bg-white/5 p-8"><div className="text-[20px] uppercase tracking-[0.12em] text-white/50">Waiting</div><div className="mt-2 flex flex-wrap gap-4">{d.unassigned.map((n, i) => <span key={n} className={`rounded-xl px-5 py-2 font-semibold ${i === 0 ? 'bg-white text-[#15181B] text-[40px]' : 'bg-white/10 text-white/80 text-[32px]'}`}>{n}</span>)}</div></section>}
      <div className="mt-10 text-center text-[16px] text-white/30">Please wait for your token. Reception will send you in.</div>
    </div>
  );
}
