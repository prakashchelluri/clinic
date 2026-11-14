import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { get } from './api';
import { Avatar, Icon, useScrollLock } from './ui';

export type Action = { key: string; label: string; icon: string; hint: string; to: string };

/** What this page creates, its main one first: the header's primary button (named for what it does), the rest in its ▾.
 *  Only the page's own things: Pharmacy offers a sale, never a booking. A page that creates nothing gets no button. */
export const createActions = (can: (p: string) => boolean, path = ''): Action[] => {
  // a drawer that opens over the page you are on (the address keeps the page and adds the drawer)
  const overPage = (k: string) => { const [pth, qs = ''] = path.split('?'); const u = new URLSearchParams(qs); u.set(k, '1'); return `${pth || '/dashboard'}?${u}`; };
  const at = (p: string) => path === p || path.startsWith(`${p}?`) || path.startsWith(`${p}/`);
  const list: (Action | false)[] =
    at('/dashboard') ? [
      can('visit.write') && { key: 'A', label: 'Check in', icon: 'plus', hint: 'Arrival, vitals and fee', to: '/dashboard?arrive=1' },
      can('appointment.write') && { key: 'B', label: 'New booking', icon: 'calendar', hint: 'Pick a window', to: '/dashboard?book=1' }]
    : at('/patients') && !/^\/patients\/[^?]/.test(path) ? [ // the list; a patient's own page has its own actions
      can('patient.write') && { key: 'R', label: 'Register patient', icon: 'user', hint: 'New patient', to: '/patients?new=1' },
      can('message.broadcast') && { key: 'M', label: 'Message patients', icon: 'message', hint: 'WhatsApp to many', to: '/patients?add=message' }]
    : at('/pharmacy') ? [can('pharmacy.bill') && { key: 'S', label: 'New sale', icon: 'pill', hint: 'Without a prescription', to: '/pharmacy?sale=1' }]
    : at('/inventory') ? [
      can('stock.write') && { key: 'O', label: 'New purchase order', icon: 'list', hint: 'Order from a vendor', to: '/inventory?tab=orders&order=new' },
      can('stock.write') && { key: 'D', label: 'Receive a delivery', icon: 'inbox', hint: 'Stock in, with or without an order', to: '/inventory?tab=orders&receive=new' },
      can('stock.write') && { key: 'V', label: 'Add a vendor', icon: 'users', hint: 'Inventory', to: '/inventory?tab=vendors&add=vendor' }]
    : at('/worklist') ? [can('worklist.write') && { key: 'P', label: 'Schedule a procedure', icon: 'stetho', hint: 'Pick the patient and book a session', to: overPage('sched') }]
    : at('/accounts') || at('/expenses') ? [can('expense.write') && { key: 'E', label: 'Add expense', icon: 'rupee', hint: '', to: at('/accounts') ? '/accounts?tab=spend&add=expense' : '/expenses?add=expense' }]
    : [];
  return list.filter(Boolean) as Action[];
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
      <div className="w-full max-w-[620px] rounded-[12px] border border-white/90 bg-surface/97 p-3.5 anim-scale-in" style={{ boxShadow: '0 40px 80px -30px rgba(40,25,10,.5)', backdropFilter: 'blur(18px)' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-3.5 pt-3 pb-3.5 border-b border-ink/8">
          <Icon name="search" className="h-5 w-5" />
          <input ref={input} className="flex-1 bg-transparent outline-none text-[17px] font-medium placeholder:text-muted" placeholder="Patient name, phone or ID" value={q} onChange={(e) => setQ(e.target.value)}
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
          {/* a failed search must never read as "no such patient": that is how duplicates get registered */}
          {items.length === 0 && q.trim().length >= 2 && search.isError && !search.isFetching ? <div className="px-4 py-8 text-center text-sm" role="alert"><div className="font-semibold text-ink">Couldn't load. Check the internet and try again.</div><button type="button" className="btn btn-sm mt-3" onClick={() => search.refetch()}>Retry</button></div>
            : items.length === 0 && <div className="px-4 py-8 text-center text-sm text-muted">{q.trim().length < 2 ? 'Type a name, phone number or patient ID' : search.isFetching || search.isLoading ? 'Searching…' : 'No match'}</div>}
        </div>
        <div className="px-3.5 pt-2 pb-1 text-xs text-muted">Ctrl+K opens this anywhere. Use the + button to start something new.</div>
      </div>
    </div>
  );
}
