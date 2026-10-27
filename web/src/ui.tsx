import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

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
  dots: 'M12 5v.01M12 12v.01M12 19v.01',
  filter: 'M4 5h16l-6 7v6l-4 2v-8z',
  export: 'M12 15V4M8 8l4-4 4 4M5 14v5h14v-5',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z',
  home: 'M3 11 12 3l9 8M5 10v10h14V10',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
  wallet: 'M20 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2zM16 3H8a2 2 0 0 0-2 2v2h12V5a2 2 0 0 0-2-2zM16 14h.01',
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.8 1.2V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.8-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.8H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.2-2.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 2.8-1.2V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.8 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.8H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1.1z',
  menu: 'M4 6h16M4 12h16M4 18h16',
  repeat: 'M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3',
  link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  download: 'M12 4v11m0 0-4-4m4 4 4-4M5 20h14',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  message: 'M21 12a8 8 0 0 1-11.8 7L3 21l2-6.2A8 8 0 1 1 21 12z',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z',
  globe: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20',
  stetho: 'M4.8 2.3A.3.3 0 1 0 5 2H4a2 2 0 0 0-2 2v5a6 6 0 0 0 6 6 6 6 0 0 0 6-6V4a2 2 0 0 0-2-2h-1a.2.2 0 1 0 .3.3M8 15v1a6 6 0 0 0 6 6 6 6 0 0 0 6-6v-4M20 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
};
export function Icon({ name, className = '' }: { name: keyof typeof PATHS | string; className?: string }) {
  // keep the default size whenever the caller only passes colour or spacing classes
  return (<svg className={/(^|\s)(h|w|size)-/.test(className) ? className : `h-4 w-4 ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={PATHS[name] ?? ''} /></svg>);
}

/* ---------- Primitives ---------- */
export const Chip = ({ tone = '', children, className = '' }: { tone?: '' | 'clay' | 'sage' | 'amber' | 'rose' | 'sky'; children: ReactNode; className?: string }) => (
  <span className={`chip ${tone ? `chip-${tone}` : ''} ${className}`}>{children}</span>
);

export function Avatar({ name, size = 'h-9 w-9 text-xs' }: { name: string; size?: string }) {
  const initials = name.split(/\s+/).filter((s) => /^\p{L}/u.test(s)).slice(0, 2).map((s) => s[0]?.toUpperCase()).join('');
  const hue = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  return <div className={`${size} shrink-0 rounded-full grid place-items-center font-semibold text-white`} style={{ background: `linear-gradient(135deg, hsl(${hue} 32% 48%), hsl(${(hue + 30) % 360} 36% 38%))` }}>{initials}</div>;
}

export function PageHeader({ title, subtitle, children }: { title: ReactNode; subtitle?: ReactNode; children?: ReactNode }) {
  return (
    <div className="anim-fade-up flex flex-wrap items-end gap-3 mb-5">
      <div className="mr-auto"><h1 className="text-[30px] leading-[1.05] font-semibold text-ink">{title}</h1>{subtitle && <div className="text-sm text-muted mt-0.5">{subtitle}</div>}</div>
      {children}
    </div>
  );
}

export function Section({ title, aside, children, className = '', delay = 0 }: { title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string; delay?: number }) {
  return (
    <section className={`card-flat anim-fade-up overflow-hidden ${className}`} style={{ animationDelay: `${delay}ms` }}>
      {title && <div className="flex items-center gap-2 px-5 py-4 border-b border-ink/8"><div className="text-[15px] font-semibold text-ink">{title}</div><div className="ml-auto flex items-center gap-2">{aside}</div></div>}
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

/** Segmented control with one dark pill that glides to the chosen option. */
export function Segmented<T extends string>({ options, value, onChange }: { options: { value: T; label: string; count?: number; tone?: 'rose' }[]; value: T; onChange: (v: T) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; width: number; top: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const measure = () => { const el = box.current?.querySelector<HTMLElement>('button.on'); if (el) setPos({ left: el.offsetLeft, width: el.offsetWidth, top: el.offsetTop, height: el.offsetHeight }); };
    // A ResizeObserver also catches the box reflowing when its header wraps, which a window resize misses.
    const ro = typeof ResizeObserver !== 'undefined' && box.current ? new ResizeObserver(measure) : null;
    if (ro && box.current) { ro.observe(box.current); box.current.querySelectorAll('button').forEach((b) => ro.observe(b)); }
    measure(); window.addEventListener('resize', measure); document.fonts?.ready.then(measure);
    return () => { window.removeEventListener('resize', measure); ro?.disconnect(); };
  }, [value, options.length, options.map((o) => o.count).join(',')]);
  return (
    <div className="seg" ref={box}>
      {pos && <span className="seg-pill" style={{ left: pos.left, width: pos.width, top: pos.top, height: pos.height, bottom: 'auto' }} />}
      {options.map((o) => (
        <button key={o.value} type="button" onClick={() => onChange(o.value)} className={value === o.value ? 'on' : ''} style={o.tone === 'rose' && value !== o.value ? { color: 'var(--color-rose)' } : undefined}>
          {o.label}{o.count !== undefined && <span className="ml-1.5 opacity-60 font-medium">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Number that counts up on first show and flashes when it changes. */
export function Num({ value, format = (n: number) => String(n) }: { value: number; format?: (n: number) => string }) {
  const [shown, setShown] = useState(0);
  const [flash, setFlash] = useState(0);
  const prev = useRef<number | null>(null);
  useEffect(() => {
    const from = prev.current === null ? 0 : prev.current; const first = prev.current === null;
    prev.current = value;
    if (!first) setFlash((f) => f + 1);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || from === value) { setShown(value); return; }
    let raf = 0; const t0 = performance.now(); const dur = first ? 700 : 450;
    const tick = (t: number) => { const p = Math.min(1, (t - t0) / dur); const e = 1 - Math.pow(1 - p, 3); setShown(Math.round(from + (value - from) * e)); if (p < 1) raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <span key={flash} className={flash ? 'is-flash' : ''}>{format(shown)}</span>;
}

/** A panel that floats above everything, anchored under a button. Used by the ⋯ menu and filters, so rows never cover it. */
export function Floating({ anchor, open, onClose, children, width }: { anchor: RefObject<HTMLElement | null>; open: boolean; onClose: () => void; children: ReactNode; width?: number }) {
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  useLayoutEffect(() => { if (!open) { setPos(null); return; } const r = anchor.current?.getBoundingClientRect(); if (r) setPos({ top: r.bottom + 8, right: Math.max(8, window.innerWidth - r.right) }); }, [open]);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { const t = e.target as Node; if (!panel.current?.contains(t) && !anchor.current?.contains(t)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const away = (e: Event) => { if (!panel.current?.contains(e.target as Node)) onClose(); };
    document.addEventListener('mousedown', down); document.addEventListener('keydown', key); window.addEventListener('resize', onClose); window.addEventListener('scroll', away, true);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); window.removeEventListener('resize', onClose); window.removeEventListener('scroll', away, true); };
  }, [open]);
  if (!open || !pos) return null;
  return createPortal(<div ref={panel} className="menu anim-menu" style={{ position: 'fixed', top: pos.top, right: pos.right, left: 'auto', zIndex: 70, width, marginTop: 0 }}>{children}</div>, document.body);
}

/** The ⋯ menu: secondary actions live here so a row shows one clear button. */
export type MenuItem = { label: string; onClick?: () => void; href?: string; danger?: boolean; hidden?: boolean };
export function MoreMenu({ items, label = 'More' }: { items: MenuItem[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const shown = items.filter((i) => !i.hidden);
  if (!shown.length) return null;
  return (
    <>
      <button ref={btn} type="button" className="btn btn-icon" aria-label={label} aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="dots" className="h-5 w-5" /></button>
      <Floating anchor={btn} open={open} onClose={() => setOpen(false)}>
        <div role="menu">{shown.map((i) => i.href
          ? <a key={i.label} href={i.href} role="menuitem" className={i.danger ? 'danger' : ''} onClick={() => setOpen(false)}>{i.label}</a>
          : <button key={i.label} type="button" role="menuitem" className={i.danger ? 'danger' : ''} onClick={() => { setOpen(false); i.onClick?.(); }}>{i.label}</button>)}</div>
      </Floating>
    </>
  );
}

/* ---------- Dialogs: one standard ----------
 * Header and footer stay put, only the middle scrolls (put the buttons in a `modal-foot` row and they never leave the screen).
 * Sizes by content, a bottom sheet on phones, focus kept inside, Esc closes, the page behind does not scroll.
 * Rendered into document.body: an ancestor with an entrance animation would otherwise become the "screen" for position:fixed. */
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
let scrollLocks = 0;
/** Locks page scroll while an overlay is open. Counted, so stacked overlays unlock only when the last one closes. */
export function useScrollLock(active = true) {
  useEffect(() => {
    if (!active) return;
    const el = document.documentElement;
    if (scrollLocks++ === 0) { const bar = window.innerWidth - el.clientWidth; el.style.overflow = 'hidden'; if (bar > 0) el.style.paddingRight = `${bar}px`; }
    return () => { if (--scrollLocks === 0) { el.style.overflow = ''; el.style.paddingRight = ''; } };
  }, [active]);
}
/** Keep Tab inside a panel. Returns true when it handled the key. */
function trapTab(panel: HTMLElement, e: KeyboardEvent) {
  const els = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null);
  if (!els.length) { e.preventDefault(); return true; }
  const a = els[0], z = els[els.length - 1], cur = document.activeElement;
  if (e.shiftKey && (cur === a || cur === panel || !panel.contains(cur))) { e.preventDefault(); z.focus(); return true; }
  if (!e.shiftKey && (cur === z || !panel.contains(cur))) { e.preventDefault(); a.focus(); return true; }
  return false;
}
/** Focus the first field (not on touch screens, where it would open the keyboard); remember and restore the previous focus. */
function useDialogFocus(panel: React.RefObject<HTMLDivElement | null>, active = true) {
  useEffect(() => {
    if (!active || !panel.current) return;
    const p = panel.current; const prev = document.activeElement as HTMLElement | null;
    const first = matchMedia('(pointer: coarse)').matches ? null : p.querySelector<HTMLElement>('[data-autofocus],input:not([type=checkbox]):not([type=radio]):not([type=hidden]):not([disabled]),textarea:not([disabled]),select:not([disabled])');
    if (!p.contains(document.activeElement)) (first ?? p).focus({ preventScroll: true });
    return () => { if (prev && document.contains(prev)) prev.focus({ preventScroll: true }); };
  }, [active]);
}
const SIZE: Record<string, string> = { 'max-w-sm': 'sm:max-w-[440px]', 'max-w-md': 'sm:max-w-[440px]', 'max-w-lg': 'sm:max-w-[560px]', 'max-w-xl': 'sm:max-w-[560px]', 'max-w-2xl': 'sm:max-w-[720px]', 'max-w-3xl': 'sm:max-w-[760px]' };

export function Modal({ title, subtitle, onClose, children, width = 'max-w-2xl', submitOnEnter = false }: { title: ReactNode; subtitle?: ReactNode; onClose: () => void; children: ReactNode; width?: string; submitOnEnter?: boolean }) {
  const panel = useRef<HTMLDivElement>(null); const close = useRef(onClose); close.current = onClose; const id = useId();
  useScrollLock(); useDialogFocus(panel);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const p = panel.current; if (!p) return;
      if (e.key === 'Escape') close.current();
      else if (e.key === 'Tab') trapTab(p, e);
      else if (e.key === 'Enter' && submitOnEnter && e.target instanceof HTMLInputElement && !['button', 'checkbox', 'radio', 'submit'].includes(e.target.type)) {
        const go = p.querySelector<HTMLButtonElement>('.modal-foot .btn-primary:not(:disabled),.modal-foot .btn-accent:not(:disabled)'); if (go) { e.preventDefault(); go.click(); }
      }
    };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, [submitOnEnter]);
  return createPortal(
    <div className="modal-back" role="dialog" aria-modal="true" aria-labelledby={id} onClick={onClose}>
      <div ref={panel} tabIndex={-1} className={`modal-panel ${SIZE[width] ?? 'sm:max-w-[720px]'}`} onClick={(e) => e.stopPropagation()}>
        <span className="modal-grab" aria-hidden />
        <div className="modal-head"><div className="mr-auto min-w-0"><h2 id={id} className="text-xl font-medium">{title}</h2>{subtitle && <div className="text-sm text-muted mt-0.5">{subtitle}</div>}</div><button className="btn btn-ghost btn-icon shrink-0" onClick={onClose} aria-label="Close"><Icon name="x" /></button></div>
        <div className="modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/* ---------- Confirm and short questions, in the app's own style (replaces the browser's confirm / prompt / alert) ---------- */
type AskOpts = { title: string; body?: ReactNode; confirmLabel?: string; cancelLabel?: string; tone?: 'default' | 'danger'; field?: { label: string; placeholder?: string; required?: boolean; initial?: string; maxLength?: number } };
type Pending = AskOpts & { resolve: (v: { value: string } | null) => void };
let pending: Pending | null = null; const askSubs = new Set<() => void>();
const setPending = (p: Pending | null) => { pending = p; askSubs.forEach((s) => s()); };
/** Resolves { value } when confirmed (value is the typed text when there is a field), null when cancelled. */
export const ask = (o: AskOpts) => new Promise<{ value: string } | null>((resolve) => { pending?.resolve(null); setPending({ ...o, resolve }); });

export function DialogHost() {
  const p = useSyncExternalStore((cb) => { askSubs.add(cb); return () => askSubs.delete(cb); }, () => pending);
  const panel = useRef<HTMLDivElement>(null); const [val, setVal] = useState(''); const id = useId();
  useEffect(() => setVal(p?.field?.initial ?? ''), [p]);
  useScrollLock(!!p); useDialogFocus(panel, !!p);
  const done = (v: { value: string } | null) => { if (!p) return; p.resolve(v); setPending(null); };
  const bad = !!p?.field?.required && !val.trim();
  useEffect(() => {
    if (!p) return;
    // Capture phase: this dialog sits on top, so Esc must not also close whatever is underneath.
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopImmediatePropagation(); e.preventDefault(); p.resolve(null); setPending(null); }
      else if (e.key === 'Tab' && panel.current) trapTab(panel.current, e);
    };
    window.addEventListener('keydown', k, true); return () => window.removeEventListener('keydown', k, true);
  }, [p]);
  if (!p) return null;
  const danger = p.tone === 'danger';
  return createPortal(
    <div className="modal-back" style={{ zIndex: 60 }} role="alertdialog" aria-modal="true" aria-labelledby={id} onClick={() => done(null)}>
      <div ref={panel} tabIndex={-1} className="modal-panel sm:max-w-[420px]" onClick={(e) => e.stopPropagation()}>
        <span className="modal-grab" aria-hidden />
        <div className="modal-body !pt-6">
          {!p.field && <span className={`mb-3 grid h-11 w-11 place-items-center rounded-full text-lg font-bold ${danger ? 'bg-rose-soft text-rose' : 'bg-amber-soft text-amber'}`} aria-hidden>!</span>}
          <h2 id={id} className="text-xl font-semibold leading-snug">{p.title}</h2>
          {p.body && <div className="mt-2 text-[14.5px] leading-snug text-ink-2">{p.body}</div>}
          {p.field && <div className="mt-4"><label className="label" htmlFor={id + 'f'}>{p.field.label}{p.field.required ? '' : ' (optional)'}</label>
            <input id={id + 'f'} data-autofocus className="input" maxLength={p.field.maxLength ?? 200} placeholder={p.field.placeholder} value={val} onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !bad) done({ value: val.trim() }); }} /></div>}
          <div className="modal-foot">
            <button className="btn" onClick={() => done(null)}>{p.cancelLabel ?? 'Cancel'}</button>
            <button data-autofocus={p.field ? undefined : ''} className={danger ? 'btn !border-rose !bg-rose !text-white' : 'btn btn-primary'} disabled={bad} onClick={() => done({ value: val.trim() })}>{p.confirmLabel ?? 'OK'}</button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ---------- Toasts (module store, no provider needed) ---------- */
type Toast = { id: number; msg: string; tone: 'ok' | 'err' | 'info'; action?: { label: string; run: () => void } };
let toasts: Toast[] = []; const subs = new Set<() => void>(); let nextId = 1;
const notify = () => subs.forEach((s) => s());
/** A short message; with an action (e.g. Undo) it stays longer so there is time to press it. */
export function toast(msg: string, tone: Toast['tone'] = 'ok', action?: Toast['action']) {
  const id = nextId++; toasts = [...toasts, { id, msg, tone, action }]; notify();
  setTimeout(() => dismiss(id), action ? 7000 : 3200);
}
const dismiss = (id: number) => { toasts = toasts.filter((t) => t.id !== id); notify(); };
export function ToastHost() {
  const list = useSyncExternalStore((cb) => { subs.add(cb); return () => subs.delete(cb); }, () => toasts);
  return (
    <>
    <DialogHost />
    <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-50 flex flex-col items-center gap-2 pointer-events-none">
      {list.map((t) => (
        <div key={t.id} className={`anim-scale-in pointer-events-auto rounded-full px-4 py-2 text-sm font-medium shadow-lg flex items-center gap-2 ${t.tone === 'err' ? 'bg-rose text-white' : t.tone === 'info' ? 'bg-ink text-paper' : 'bg-sage text-white'}`}>
          <Icon name={t.tone === 'err' ? 'x' : 'check'} className="h-3.5 w-3.5" />{t.msg}
          {t.action && <button className="-my-1 ml-1 rounded-full bg-white/20 px-3 py-1 text-xs font-bold underline-offset-2 hover:bg-white/30" onClick={() => { dismiss(t.id); t.action!.run(); }}>{t.action.label}</button>}
        </div>
      ))}
    </div>
    </>
  );
}

export const money = (paise: number) => '₹' + (paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 });
export const fmtDate = (d: string) => new Date(d.length === 10 ? d + 'T00:00:00' : d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

/** Rupee amount input: only digits and one decimal point, at most 2 decimals and 7 whole digits. Letters and symbols never get in, even when pasted. */
export function cleanMoney(raw: string) {
  let v = raw.replace(/[^\d.]/g, ''); const dot = v.indexOf('.');
  if (dot >= 0) v = v.slice(0, dot + 1) + v.slice(dot + 1).replace(/\./g, '').slice(0, 2);
  const [w, f] = v.split('.'); const whole = w.slice(0, 7).replace(/^0+(?=\d)/, '');
  return f === undefined ? whole : `${whole || '0'}.${f}`;
}
export const toPaise = (s: string) => Math.round(Number(s || 0) * 100);
export function MoneyInput({ value, onChange, className = '', placeholder = '0', id, autoFocus }: { value: string; onChange: (v: string) => void; className?: string; placeholder?: string; id?: string; autoFocus?: boolean }) {
  return (
    <div className={`relative ${className}`}>
      <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none">₹</span>
      <input id={id} autoFocus={autoFocus} className="input !pl-8" inputMode="decimal" autoComplete="off" placeholder={placeholder} value={value} onChange={(e) => onChange(cleanMoney(e.target.value))} aria-label="Amount in rupees" />
    </div>
  );
}

export function NoAccess({ what }: { what?: string }) {
  return <div className="card anim-fade-in max-w-lg mx-auto mt-10"><Empty icon="lock" title="You don't have access to this page" hint={`${what ? what + ' is' : 'It is'} not part of your role. If you need it, ask the clinic owner to change your role in Settings.`} /></div>;
}
export function NotFound() {
  return <div className="card anim-fade-in max-w-lg mx-auto mt-10"><Empty icon="search" title="That page doesn't exist" hint="Use the menu above to find what you need." /></div>;
}

/** Drop-in for a number box: only digits (and one point when decimal) get in, even when pasted, and the value is capped at max. */
export function NumInput({ max = 9999, decimal = false, onChange, ...rest }: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'max'> & { max?: number; decimal?: boolean }) {
  return <input {...rest} type="text" inputMode={decimal ? 'decimal' : 'numeric'} autoComplete="off" onChange={(e) => {
    let v = e.target.value.replace(decimal ? /[^\d.]/g : /\D/g, ''); if (decimal) v = v.replace(/(\..*)\./g, '$1');
    v = v.slice(0, String(max).length + (decimal ? 3 : 0)); if (v !== '' && v !== '.' && Number(v) > max) v = String(max);
    e.target.value = v; onChange?.(e);
  }} />;
}
