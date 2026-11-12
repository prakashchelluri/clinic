import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { toast } from './ui';

/** What the lifted box shows: the patient, the procedure, the doctor and room. */
export type DragItem = { id: string; title: string; sub: string; where: string };
type Lift = { item: DragItem; x: number; y: number; w: number; hover: string | null; back: boolean };

/**
 * Drag a sitting as a box. Past a few pixels it lifts out (one calendar cell wide, centred on the pointer), the cell under it
 * says yes or no, and on release it lands there or glides back to where it came from. A short press is still a click.
 * Drop targets are any elements with data-cell="<key>"; check(item, key) returns '' when the drop is allowed, else the reason.
 */
export function useBoxDrag(check: (item: DragItem, key: string) => string, drop: (item: DragItem, key: string) => void) {
  const [lift, setLift] = useState<Lift | null>(null);
  const fns = useRef({ check, drop }); fns.current = { check, drop };
  const dragged = useRef(false);
  const off = useRef<(() => void) | null>(null);
  useEffect(() => () => off.current?.(), []);

  const start = (e: React.PointerEvent, item: DragItem) => {
    if (e.button !== 0) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); const sx = e.clientX, sy = e.clientY;
    const cell = document.querySelector('[data-cell]:not([data-cell="PENDING"])');
    const w = Math.max(120, Math.min(220, (cell?.getBoundingClientRect().width ?? 172) - 12));
    const home = { x: r.left + r.width / 2 - w / 2, y: r.top + r.height / 2 - 34 };
    let lifted = false; let hover: string | null = null;
    const move = (ev: PointerEvent) => {
      if (!lifted && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
      lifted = true;
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      hover = (under?.closest('[data-cell]') as HTMLElement | null)?.dataset.cell ?? null;
      setLift({ item, x: ev.clientX - w / 2, y: ev.clientY - 34, w, hover, back: false });
    };
    const up = () => {
      off.current?.();
      if (!lifted) return;
      dragged.current = true; setTimeout(() => { dragged.current = false; }, 0);
      const why = hover ? fns.current.check(item, hover) : 'nowhere';
      if (hover && !why) { setLift(null); fns.current.drop(item, hover); return; }
      setLift((l) => l && { ...l, x: home.x, y: home.y, hover: null, back: true });
      if (hover && why && why !== 'nowhere' && why !== 'same') toast(`Can't go there: ${why}`, 'err');
      setTimeout(() => setLift(null), 260);
    };
    off.current = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); off.current = null; };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  };

  /** A drop target's look while something is lifted: can / cannot, and the one under the pointer. */
  const cellCls = (key: string) => {
    if (!lift || lift.back) return '';
    const ok = !check(lift.item, key);
    return lift.hover === key ? (ok ? 'pw-hov-ok' : 'pw-hov-bad') : ok ? 'pw-can' : 'pw-cant';
  };
  /** The reason under the pointer, for the cell to show. */
  const hoverWhy = (key: string) => (lift && !lift.back && lift.hover === key ? check(lift.item, key) : '');

  // drawn at the page root: an animated parent (transform) would otherwise shift a fixed box away from the pointer
  const ghost = lift ? createPortal(
    <div className={`pw-ghost ${lift.back ? 'back' : ''}`} style={{ left: lift.x, top: lift.y, width: lift.w }} aria-hidden="true">
      <b>{lift.item.title}</b><span>{lift.item.sub}</span><span>{lift.item.where}</span>
    </div>, document.body,
  ) : null;

  return { liftedId: lift && !lift.back ? lift.item.id : null, start, cellCls, hoverWhy, ghost, wasDrag: () => dragged.current };
}
