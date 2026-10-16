import { useEffect, useSyncExternalStore, type ReactNode } from 'react';

/* ---------- Icons (inline, stroke) ---------- */
const PATHS: Record<string, string> = {
  queue: 'M4 6h16M4 12h10M4 18h7',
  calendar: 'M8 3v3M16 3v3M4 9h16M6 5h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  list: 'M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01',
  chart: 'M3 3v18h18M7 14l4-4 4 4 5-6',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  plus: 'M12 5v14M5 12h14',
  print: 'M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v7H6z',
  phone: 'M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.6a2 2 0 0 1-.5 2.1L8.1 9.7a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.8.3 1.7.5 2.6.7a2 2 0 0 1 1.7 2z',
  check: 'M20 6 9 17l-5-5',
  x: 'M18 6 6 18M6 6l12 12',
  up: 'M12 19V5M5 12l7-7 7 7',
  search: 'M21 21l-4.3-4.3M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z',
  pill: 'M10.5 20.5 3.5 13.5a5 5 0 0 1 7-7l7 7a5 5 0 0 1-7 7zM8.5 8.5l7 7',
  spark: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 17l.8 2.2L22 20l-2.2.8L19 23l-.8-2.2L16 20l2.2-.8z',
  user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
  door: 'M13 4h3a2 2 0 0 1 2 2v14M2 20h20M13 20V4L5 6v14M9 12h.01',
  rupee: 'M6 3h12M6 8h12M6 13h3a5 5 0 0 0 5-5V3M6 13l9 8',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  chevL: 'm15 18-6-6 6-6', chevR: 'm9 18 6-6-6-6',
  wallet: 'M20 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2zM16 3H8a2 2 0 0 0-2 2v2h12V5a2 2 0 0 0-2-2zM16 14h.01',
  stetho: 'M4.8 2.3A.3.3 0 1 0 5 2H4a2 2 0 0 0-2 2v5a6 6 0 0 0 6 6 6 6 0 0 0 6-6V4a2 2 0 0 0-2-2h-1a.2.2 0 1 0 .3.3M8 15v1a6 6 0 0 0 6 6 6 6 0 0 0 6-6v-4M20 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
};
export function Icon({ name, className = 'h-4 w-4' }: { name: keyof typeof PATHS | string; className?: string }) {
  return (<svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={PATHS[name] ?? ''} /></svg>);
}

/* ---------- Primitives ---------- */
export const Chip = ({ tone = '', children, className = '' }: { tone?: '' | 'clay' | 'sage' | 'amber' | 'rose' | 'sky'; children: ReactNode; className?: string }) => (
  <span className={`chip ${tone ? `chip-${tone}` : ''} ${className}`}>{children}</span>
);

export function Avatar({ name, size = 'h-9 w-9 text-xs' }: { name: string; size?: string }) {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0]?.toUpperCase()).join('');
  const hue = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  return <div className={`${size} shrink-0 rounded-full grid place-items-center font-semibold text-white`} style={{ background: `linear-gradient(135deg, hsl(${hue} 32% 48%), hsl(${(hue + 30) % 360} 36% 38%))` }}>{initials}</div>;
}

export function PageHeader({ title, subtitle, children }: { title: ReactNode; subtitle?: ReactNode; children?: ReactNode }) {
  return (
    <div className="anim-fade-up flex flex-wrap items-end gap-3 mb-5">
      <div className="mr-auto"><h1 className="text-[28px] leading-tight font-medium text-ink">{title}</h1>{subtitle && <div className="text-sm text-muted mt-0.5">{subtitle}</div>}</div>
      {children}
    </div>
  );
}

export function Section({ title, aside, children, className = '', delay = 0 }: { title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string; delay?: number }) {
  return (
    <section className={`card-flat anim-fade-up overflow-hidden ${className}`} style={{ animationDelay: `${delay}ms` }}>
      {title && <div className="flex items-center gap-2 px-4 py-3 border-b border-line"><div className="text-sm font-semibold text-ink">{title}</div><div className="ml-auto flex items-center gap-2">{aside}</div></div>}
      {children}
    </section>
  );
}

export function Empty({ icon = 'spark', title, hint }: { icon?: string; title: string; hint?: string }) {
  return (
    <div className="anim-fade-in flex flex-col items-center justify-center text-center py-10 px-4">
      <div className="h-10 w-10 rounded-full bg-paper-2 grid place-items-center text-muted mb-3"><Icon name={icon} className="h-5 w-5" /></div>
      <div className="text-sm font-medium text-ink-2">{title}</div>{hint && <div className="text-xs text-muted mt-1 max-w-xs">{hint}</div>}
    </div>
  );
}

export const Skeleton = ({ rows = 3 }: { rows?: number }) => (
  <div className="p-4 space-y-3">{Array.from({ length: rows }).map((_, i) => <div key={i} className="skeleton h-10" style={{ width: `${92 - i * 9}%` }} />)}</div>
);

export function Stat({ label, value, sub, tone = '', delay = 0 }: { label: string; value: ReactNode; sub?: ReactNode; tone?: '' | 'clay' | 'sage'; delay?: number }) {
  return (
    <div className="card anim-fade-up" style={{ animationDelay: `${delay}ms` }}>
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</div>
      <div className={`serif text-[30px] leading-none mt-2 ${tone === 'clay' ? 'text-clay' : tone === 'sage' ? 'text-sage' : 'text-ink'}`}>{value}</div>
      {sub && <div className="text-xs text-muted mt-2">{sub}</div>}
    </div>
  );
}

export function Segmented<T extends string>({ options, value, onChange }: { options: { value: T; label: string; count?: number }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex rounded-full bg-paper-2 p-1 gap-0.5">
      {options.map((o) => (
        <button key={o.value} onClick={() => onChange(o.value)} className={`relative rounded-full px-3.5 py-1.5 text-xs font-medium transition-all duration-200 ${value === o.value ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:text-ink'}`}>
          {o.label}{o.count !== undefined && <span className={`ml-1.5 ${value === o.value ? 'text-clay' : ''}`}>{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Modal({ title, subtitle, onClose, children, width = 'max-w-2xl' }: { title: ReactNode; subtitle?: ReactNode; onClose: () => void; children: ReactNode; width?: string }) {
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 grid place-items-center p-4 anim-fade-in" style={{ background: 'rgba(28,27,25,0.35)', backdropFilter: 'blur(6px)' }} onClick={onClose}>
      <div className={`card anim-scale-in w-full ${width} max-h-[94vh] overflow-auto !p-0`} style={{ boxShadow: 'var(--shadow-lift)' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-3 px-6 pt-5 pb-3"><div className="mr-auto"><h2 className="text-xl font-medium">{title}</h2>{subtitle && <div className="text-sm text-muted mt-0.5">{subtitle}</div>}</div><button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close"><Icon name="x" /></button></div>
        <div className="px-6 pb-6">{children}</div>
      </div>
    </div>
  );
}

/* ---------- Toasts (module store, no provider needed) ---------- */
type Toast = { id: number; msg: string; tone: 'ok' | 'err' | 'info' };
let toasts: Toast[] = []; const subs = new Set<() => void>(); let nextId = 1;
const notify = () => subs.forEach((s) => s());
export function toast(msg: string, tone: Toast['tone'] = 'ok') {
  const id = nextId++; toasts = [...toasts, { id, msg, tone }]; notify();
  setTimeout(() => { toasts = toasts.filter((t) => t.id !== id); notify(); }, 3200);
}
export function ToastHost() {
  const list = useSyncExternalStore((cb) => { subs.add(cb); return () => subs.delete(cb); }, () => toasts);
  return (
    <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-50 flex flex-col items-center gap-2 pointer-events-none">
      {list.map((t) => (
        <div key={t.id} className={`anim-scale-in pointer-events-auto rounded-full px-4 py-2 text-sm font-medium shadow-lg flex items-center gap-2 ${t.tone === 'err' ? 'bg-rose text-white' : t.tone === 'info' ? 'bg-ink text-paper' : 'bg-sage text-white'}`}>
          <Icon name={t.tone === 'err' ? 'x' : 'check'} className="h-3.5 w-3.5" />{t.msg}
        </div>
      ))}
    </div>
  );
}

export const money = (paise: number) => '₹' + (paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 });
export const fmtDate = (d: string) => new Date(d.length === 10 ? d + 'T00:00:00' : d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
