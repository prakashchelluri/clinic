import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { get } from './api';
import { Avatar, Icon, useScrollLock } from './ui';

export type Action = { key: string; label: string; icon: string; hint: string; to: string };

/** The things you start from anywhere. One list for the + menu and for ⌘K. */
export const createActions = (can: (p: string) => boolean, path = ''): Action[] => {
  const first = path.startsWith('/patients') ? 'R' : path.startsWith('/calendar') || path.startsWith('/bookings') ? 'B' : path.startsWith('/pharmacy') ? 'S' : path.startsWith('/worklist') ? 'P' : path.startsWith('/expenses') ? 'E' : path.startsWith('/queue') ? 'A' : '';
  const list = [
  can('visit.write') && { key: 'A', label: 'Check in a patient', icon: 'plus', hint: 'Arrival, vitals and fee', to: '/queue?arrive=1' },
  can('appointment.write') && { key: 'B', label: 'New booking', icon: 'calendar', hint: 'Pick a window', to: '/calendar?book=1' },
  can('patient.write') && { key: 'R', label: 'Register a patient', icon: 'user', hint: 'New record', to: '/patients?new=1' },
  can('worklist.write') && { key: 'P', label: 'Schedule a procedure', icon: 'stetho', hint: 'Open procedures', to: '/worklist' },
  can('expense.write') && { key: 'E', label: 'Add an expense', icon: 'rupee', hint: 'Expenses', to: '/expenses' },
  can('pharmacy.bill') && { key: 'S', label: 'New pharmacy sale', icon: 'pill', hint: 'Without a prescription', to: '/pharmacy?sale=1' },
  ].filter(Boolean) as Action[];
  return [...list.filter((a) => a.key === first), ...list.filter((a) => a.key !== first)];
};

/** ⌘K: find any patient, or do the common things from anywhere. The same list powers the Create button. */
export function CommandPalette({ open, onClose, can }: { open: boolean; onClose: () => void; can: (p: string) => boolean }) {
  useScrollLock(open);
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) { setQ(''); setI(0); setTimeout(() => input.current?.focus(), 30); } }, [open]);

  const search = useQuery({ queryKey: ['palette', q], queryFn: () => get(`/patients?q=${encodeURIComponent(q)}`), enabled: open && q.trim().length >= 2 && can('patient.read') });
  const actions: Action[] = []; // actions live in the + menu; this box finds patients
  const patients: any[] = (search.data ?? []).slice(0, 5);
  const items: { type: 'patient' | 'action'; p?: any; a?: Action }[] = [...patients.map((p) => ({ type: 'patient' as const, p })), ...actions.map((a) => ({ type: 'action' as const, a }))];
  const go = (it: (typeof items)[number] | undefined) => { if (!it) return; onClose(); nav(it.type === 'patient' ? `/patients/${it.p.id}` : it.a!.to, { viewTransition: true }); };
  useEffect(() => setI(0), [q, patients.length]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-center items-start pt-[12vh] px-4 anim-fade-in" style={{ background: 'rgba(23,25,26,0.34)', backdropFilter: 'blur(6px)' }} onClick={onClose}>
      <div className="w-full max-w-[620px] rounded-[28px] border border-white/90 bg-[#FBFAF7]/97 p-3.5 anim-scale-in" style={{ boxShadow: '0 40px 80px -30px rgba(40,25,10,.5)', backdropFilter: 'blur(18px)' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-3.5 pt-3 pb-3.5 border-b border-ink/8">
          <Icon name="search" className="h-5 w-5" />
          <input ref={input} className="flex-1 bg-transparent outline-none text-[17px] font-medium placeholder:text-muted/70" placeholder="Patient name, phone or ID" value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); setI((x) => Math.min(items.length - 1, x + 1)); } else if (e.key === 'ArrowUp') { e.preventDefault(); setI((x) => Math.max(0, x - 1)); } else if (e.key === 'Enter') go(items[i]); else if (e.key === 'Escape') onClose();
              else if (!q && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) { const hit = actions.find((a) => a.key === e.key.toUpperCase()); if (hit) { e.preventDefault(); go({ type: 'action', a: hit }); } } }} />
          <span className="kbd">esc</span>
        </div>
        <div className="max-h-[52vh] overflow-auto pb-1">
          {patients.length > 0 && <div className="px-3.5 pt-3 pb-1.5 text-[11px] font-bold uppercase tracking-[0.09em] text-muted">Patients</div>}
          {items.map((it, idx) => (
            <button key={idx} onMouseEnter={() => setI(idx)} onClick={() => go(it)}
              className={`flex w-full items-center gap-3 rounded-2xl px-3.5 py-2.5 text-left text-[14.5px] font-medium transition-colors duration-150 ${idx === i ? 'bg-ink text-white' : ''}`}>
              {it.type === 'patient'
                ? <><Avatar name={it.p.fullName} size="h-8 w-8 text-[11px]" /><span className="flex-1 truncate">{it.p.fullName} <span className={idx === i ? 'opacity-60 font-normal' : 'text-muted font-normal'}>· {it.p.ageYears ?? ''} {it.p.sex ?? ''} · {it.p.phone ?? 'no phone'}</span></span><span className={`kbd ${idx === i ? '!bg-white/20 !text-white/80' : ''}`}>↵ open</span></>
                : <><span className={`grid h-8 w-8 place-items-center rounded-full ${idx === i ? 'bg-white/15' : 'bg-ink/7'}`}><Icon name={it.a!.icon} className="h-4 w-4" /></span><span className="flex-1">{it.a!.label} <span className={idx === i ? 'opacity-60 font-normal' : 'text-muted font-normal'}>· {it.a!.hint}</span></span><span className={`kbd ${idx === i ? '!bg-white/20 !text-white/80' : ''}`}>{it.a!.key}</span></>}
            </button>
          ))}
          {items.length === 0 && <div className="px-4 py-8 text-center text-sm text-muted">{q.trim().length < 2 ? 'Type a name, phone number or patient ID' : search.isLoading ? 'Searching…' : 'No match'}</div>}
        </div>
        <div className="px-3.5 pt-2 pb-1 text-xs text-muted">⌘K opens this anywhere. Use the + button to start something new.</div>
      </div>
    </div>
  );
}
