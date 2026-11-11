import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, get, post, qc, errText } from './api';
import { Chip, Icon, toast, fmtDate } from './ui';
import { PhotoCapture, PhotoCompare, usePhotos } from './photos';

/** The skin map: a body silhouette with pins. A pin is a place on the patient that the clinic is watching: what was seen there, what it is, and the photos of it across visits.
 *  A tap never commits by itself: it proposes a pin, the doctor confirms (and can change the site), and an added pin can be undone, dragged, resolved or removed. */
export type Pin = { id: string; side: 'front' | 'back'; x: number; y: number; area: string; finding: string | null; diagnosis: string | null; encounterId: string | null; encounterAt: string | null; resolvedAt: string | null; createdAt: string; photos: number; lastPhotoAt: string | null };

// Where a tap lands, in the 200 × 620 silhouette box. Left and right are the patient's own.
const ZONES: { area: string; x: number; y: number; w: number; h: number; back?: string }[] = [
  { area: 'Scalp', x: 68, y: 6, w: 64, h: 26, back: 'Scalp' }, { area: 'Face', x: 68, y: 32, w: 64, h: 58, back: 'Back of head' }, { area: 'Neck', x: 82, y: 90, w: 36, h: 18, back: 'Nape' },
  { area: 'Chest', x: 56, y: 108, w: 88, h: 66, back: 'Upper back' }, { area: 'Abdomen', x: 60, y: 174, w: 80, h: 66, back: 'Lower back' }, { area: 'Groin', x: 62, y: 240, w: 76, h: 56, back: 'Buttocks' },
  { area: 'Right upper arm', x: 18, y: 108, w: 36, h: 70, back: 'Left upper arm' }, { area: 'Left upper arm', x: 146, y: 108, w: 36, h: 70, back: 'Right upper arm' },
  { area: 'Right forearm', x: 10, y: 178, w: 38, h: 74, back: 'Left forearm' }, { area: 'Left forearm', x: 152, y: 178, w: 38, h: 74, back: 'Right forearm' },
  { area: 'Right hand', x: 4, y: 252, w: 36, h: 44, back: 'Left hand' }, { area: 'Left hand', x: 160, y: 252, w: 36, h: 44, back: 'Right hand' },
  { area: 'Right thigh', x: 58, y: 296, w: 40, h: 112, back: 'Left thigh' }, { area: 'Left thigh', x: 102, y: 296, w: 40, h: 112, back: 'Right thigh' },
  { area: 'Right leg', x: 60, y: 408, w: 38, h: 90, back: 'Left leg' }, { area: 'Left leg', x: 102, y: 408, w: 38, h: 90, back: 'Right leg' },
  { area: 'Right foot', x: 52, y: 498, w: 46, h: 36, back: 'Left foot' }, { area: 'Left foot', x: 102, y: 498, w: 46, h: 36, back: 'Right foot' },
];
/** The Site choice a pinned area belongs to (Chest → Trunk, Right forearm → Arms), or null when the clinic's Site list has none. */
const SITE_OF: [RegExp, string][] = [[/scalp|back of head/i, 'Scalp'], [/face/i, 'Face'], [/neck|nape/i, 'Neck'], [/chest|abdomen/i, 'Trunk'], [/upper back|lower back|buttock/i, 'Back'], [/groin/i, 'Genitals'], [/hand/i, 'Hands'], [/arm/i, 'Arms'], [/foot/i, 'Feet'], [/thigh|leg/i, 'Legs']];
export const siteFor = (area: string, options: string[]): string | null => {
  if (options.includes(area)) return area;
  const hit = SITE_OF.find(([re]) => re.test(area)); return hit && options.includes(hit[1]) ? hit[1] : null;
};
export const AREAS = (side: 'front' | 'back') => [...new Set(ZONES.map((z) => (side === 'back' ? z.back ?? z.area : z.area)))];
export function areaAt(side: 'front' | 'back', nx: number, ny: number) {
  const x = nx * 200, y = ny * 620;
  // the zone the tap is in, else the nearest one: a tap just outside the outline still names the right site
  const dist = (z: typeof ZONES[number]) => Math.hypot(Math.max(z.x - x, 0, x - (z.x + z.w)), Math.max(z.y - y, 0, y - (z.y + z.h)));
  const z = ZONES.reduce((best, cur) => (dist(cur) < dist(best) ? cur : best), ZONES[0]);
  return side === 'back' ? z.back ?? z.area : z.area;
}
export const FINDINGS = ['Macule', 'Patch', 'Papule', 'Plaque', 'Pustule', 'Nodule', 'Vesicle', 'Scale', 'Crust', 'Erosion', 'Ulcer', 'Burrow', 'Comedone', 'Hypopigmented', 'Hyperpigmented', 'Scar'];

// One outline, drawn as the right half and mirrored (see scratch make-figure): head, neck, shoulders, arms a little away from the body, a waist, hips, legs and feet. The ZONES above are where a tap lands.
const FIGURE = 'M100 8C118 8 131 25 131 47C131 66 123 82 113 90C113 95 114 100 114 104C118 108 148 110 157 124C164 136 168 158 170 180C173 198 178 222 182 250C186 262 192 274 191 286C190 296 180 300 172 296C165 292 161 282 159 272C156 256 152 230 149 206C147 194 145 182 145 176C144 160 143 146 142 134C139 166 136 196 139 226C144 246 148 266 147 290C146 326 142 372 139 416C137 450 137 478 139 500C140 512 146 520 146 528C144 536 116 536 112 530C108 524 106 512 106 500C104 470 103 444 104 420C103 380 102 340 101 302C101 300 100 300 100 300C100 300 99 300 99 302C98 340 97 380 96 420C97 444 96 470 94 500C94 512 92 524 88 530C84 536 56 536 54 528C54 520 60 512 61 500C63 478 63 450 61 416C58 372 54 326 53 290C52 266 56 246 61 226C64 196 61 166 58 134C57 146 56 160 55 176C55 182 53 194 51 206C48 230 44 256 41 272C39 282 35 292 28 296C20 300 10 296 9 286C8 274 14 262 18 250C22 222 27 198 30 180C32 158 36 136 43 124C52 110 82 108 86 104C86 100 87 95 87 90C77 82 69 66 69 47C69 25 82 8 100 8Z';

/** The silhouette. Tap to propose a pin; tap a pin to pick it; drag a picked pin to move it. Earlier visits blue, this visit clay, resolved grey. */
export function BodyMap({ side, pins, selectedId, onSelect, onPropose, onMove, pending, readOnly, height = 260, encounterId }: {
  side: 'front' | 'back'; pins: Pin[]; selectedId: string | null; onSelect: (id: string) => void; onPropose?: (x: number, y: number) => void; onMove?: (id: string, x: number, y: number) => void;
  pending?: { x: number; y: number } | null; readOnly?: boolean; height?: number; encounterId?: string | null }) {
  const w = Math.round(height * 200 / 620);
  const mine = pins.filter((p) => p.side === side);
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; moved: boolean } | null>(null);
  const [live, setLive] = useState<{ id: string; x: number; y: number } | null>(null);
  const norm = (e: { clientX: number; clientY: number }) => { const r = box.current!.getBoundingClientRect(); return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) }; };
  useEffect(() => {
    if (!drag.current) return;
    const move = (e: PointerEvent) => { if (!drag.current) return; drag.current.moved = true; setLive({ id: drag.current.id, ...norm(e) }); };
    const up = (e: PointerEvent) => { const d = drag.current; drag.current = null; if (d?.moved && onMove) onMove(d.id, norm(e).x, norm(e).y); setLive(null); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, [live?.id]);
  const color = (p: Pin) => p.resolvedAt ? 'var(--color-muted)' : p.encounterId && encounterId && p.encounterId === encounterId ? 'var(--color-clay)' : 'var(--color-sky)';
  return (
    <div ref={box} className="relative select-none touch-none" style={{ width: w, height }}>
      <svg viewBox="0 0 200 620" width={w} height={height} className={readOnly || !onPropose ? '' : 'cursor-crosshair'} role="img" aria-label={`${side} of the body, ${mine.length} pins`}
        onClick={(e) => { if (readOnly || !onPropose) return; const n = norm(e); onPropose(n.x, n.y); }}>
        <path d={FIGURE} fill="var(--color-paper-2)" stroke="var(--color-line-2)" strokeWidth="2.5" strokeLinejoin="round" />
        {side === 'back' && <text x="100" y="50" textAnchor="middle" fontSize="16" fontWeight="600" fill="var(--color-muted)">back</text>}
      </svg>
      {pending && <span className="pointer-events-none absolute h-6 w-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-dashed border-clay bg-clay/15 anim-scale-in" style={{ left: `${pending.x * 100}%`, top: `${pending.y * 100}%` }} />}
      {mine.map((p, i) => { const on = p.id === selectedId; const pos = live?.id === p.id ? live : p; return (
        <button key={p.id} type="button" aria-label={`${p.area}${p.diagnosis ? `, ${p.diagnosis}` : ''}`} title={`${p.area}${p.diagnosis ? ` · ${p.diagnosis}` : ''}${p.finding ? ` · ${p.finding}` : ''}${on && !readOnly ? ' · drag to move' : ''}`}
          className={`absolute grid -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full text-[10px] font-bold text-white shadow-md ${on ? 'h-6 w-6 ring-4 ring-clay/25 cursor-grab active:cursor-grabbing' : 'h-5 w-5 ring-4 ring-black/5 hover:scale-110'} ${live?.id === p.id ? '' : 'transition-transform'}`}
          style={{ left: `${pos.x * 100}%`, top: `${pos.y * 100}%`, background: color(p) }}
          onClick={(e) => { e.stopPropagation(); if (!drag.current?.moved) onSelect(p.id); }}
          onPointerDown={(e) => { if (readOnly || !on || !onMove) return; e.stopPropagation(); drag.current = { id: p.id, moved: false }; setLive({ id: p.id, x: p.x, y: p.y }); }}>{i + 1}</button>); })}
    </div>
  );
}

const refresh = (patientId: string) => { qc.invalidateQueries({ queryKey: ['pins', patientId] }); qc.invalidateQueries({ queryKey: ['photos', patientId] }); };
export const usePins = (patientId: string) => useQuery<Pin[]>({ queryKey: ['pins', patientId], queryFn: () => get(`/patients/${patientId}/pins`), enabled: !!patientId });

/** The panel: the body on the left, the proposed or chosen pin on the right. Lives in the pad's Examination and on the patient record. */
export function SkinMapPanel({ patientId, patientName, encounterId, readOnly, defaultDx, onAreaAdded, onFinding, compact }: { patientId: string; patientName: string; encounterId?: string | null; readOnly?: boolean; defaultDx?: string; onAreaAdded?: (area: string) => void; onFinding?: (finding: string, on: boolean, others: Pin[]) => void; compact?: boolean }) {
  const pins = usePins(patientId); const photosQ = usePhotos(patientId);
  const [side, setSide] = useState<'front' | 'back'>('front');
  const [sel, setSel] = useState<string | null>(null);
  const [pending, setPending] = useState<{ x: number; y: number; area: string } | null>(null);
  const [capture, setCapture] = useState<Pin | null>(null); const [compare, setCompare] = useState<[any, any] | null>(null);
  const list = pins.data ?? []; const pin = list.find((p) => p.id === sel) ?? null;
  const photos: any[] = useMemo(() => (photosQ.data?.photos ?? []).filter((x: any) => pin && (x.pinId === pin.id || (!x.pinId && x.area === pin.area))), [photosQ.data, pin]);
  const del = useMutation({ mutationFn: (id: string) => api('DELETE', `/pins/${id}`), onSuccess: () => { refresh(patientId); setSel(null); }, onError: (e: any) => toast(e?.body?.code === 'PIN_HAS_PHOTOS' ? 'This pin has photos; mark it resolved instead.' : errText(e), 'err') });
  const add = useMutation({ mutationFn: (b: { x: number; y: number; area: string }) => post(`/patients/${patientId}/pins`, { ...b, side, encounterId: encounterId ?? null, diagnosis: defaultDx || null }),
    onSuccess: (row: Pin, b) => { refresh(patientId); setPending(null); setSel(row.id); onAreaAdded?.(b.area); toast(`Pinned ${b.area}`, 'ok', { label: 'Undo', run: () => del.mutate(row.id) }); }, onError: (e) => toast(errText(e), 'err') });
  const upd = useMutation({ mutationFn: ({ id, ...b }: any) => api('PATCH', `/pins/${id}`, b), onSuccess: () => refresh(patientId), onError: (e) => toast(errText(e), 'err') });
  const findings = (pin?.finding ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  // a finding seen at a site is also this visit's finding: the pad hears of it (others = the other pins, to keep a finding another site still has)
  const toggleFinding = (f: string) => { if (!pin) return; const on = !findings.includes(f); upd.mutate({ id: pin.id, finding: (on ? [...findings, f] : findings.filter((x) => x !== f)).join(', ') || null }); onFinding?.(f, on, list.filter((p) => p.id !== pin.id)); };
  const height = compact ? 230 : 310;
  const counts = { front: list.filter((p) => p.side === 'front').length, back: list.filter((p) => p.side === 'back').length };
  const numberOf = (p: Pin) => list.filter((q) => q.side === p.side).indexOf(p) + 1;
  useEffect(() => { const k = (e: KeyboardEvent) => { if (!pending) return; if (e.key === 'Escape') setPending(null); if (e.key === 'Enter') { e.preventDefault(); add.mutate(pending); } }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [pending]);
  return (
    <div className="flex flex-wrap gap-5">
      <div className="flex flex-col items-center gap-2">
        <div className="seg !p-[2px]" role="tablist">{(['front', 'back'] as const).map((s) => <button key={s} role="tab" aria-selected={side === s} className={`!px-3 !py-1 !text-[12px] ${side === s ? 'on relative z-[1] !bg-surface' : ''}`} onClick={() => { setSide(s); setPending(null); }}>{s === 'front' ? 'Front' : 'Back'}{counts[s] ? <span className="ml-1 text-muted">{counts[s]}</span> : null}</button>)}</div>
        <BodyMap side={side} pins={list} selectedId={sel} onSelect={(id) => { setSel(id); setPending(null); }} pending={pending} encounterId={encounterId} readOnly={readOnly} height={height}
          onPropose={readOnly ? undefined : (x, y) => { setSel(null); setPending({ x, y, area: areaAt(side, x, y) }); }}
          onMove={readOnly ? undefined : (id, x, y) => upd.mutate({ id, x, y, area: areaAt(side, x, y) })} />
        <div className="max-w-[200px] text-center text-[11px] leading-snug text-muted">{readOnly ? 'Tap a pin to see it' : pin ? 'Drag the pin to move it' : 'Tap the body where the problem is'}</div>
      </div>
      <div className="min-w-0 flex-1" style={{ minWidth: 240 }}>
        {pending ? (
          <div className="rounded-xl border border-clay-line bg-clay-soft/50 p-3.5 anim-scale-in" role="dialog" aria-label="Pin a site">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-clay-ink">Pin here</div>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <select aria-label="Site" className="input !w-auto !py-1.5 text-[13.5px] font-semibold" value={pending.area} onChange={(e) => setPending({ ...pending, area: e.target.value })}>{[...new Set([pending.area, ...AREAS(side)])].map((a) => <option key={a} value={a}>{a}</option>)}</select>
              {defaultDx && <span className="text-[12.5px] text-muted">· {defaultDx}</span>}
            </div>
            <div className="mt-3 flex items-center gap-2"><button type="button" className="btn btn-primary btn-sm" disabled={add.isPending} onClick={() => add.mutate(pending)}><Icon name="check" className="h-3.5 w-3.5" />Add pin</button><button type="button" className="btn btn-ghost btn-sm" onClick={() => setPending(null)}>Cancel</button><span className="ml-auto text-[11px] text-muted">Enter · Esc</span></div>
          </div>
        ) : !pin ? (
          <div>
            {list.length === 0 ? <div className="rounded-xl border border-dashed border-line-2 p-4 text-[13px] leading-relaxed text-muted">No pins yet.{readOnly ? '' : ' Tap where the problem is, confirm the site, and the pin keeps the photos, the finding and the diagnosis for that spot across visits.'}</div>
              : <div className="space-y-0.5">{list.map((p) => <button key={p.id} type="button" className="flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left text-[13.5px] leading-snug hover:bg-surface-2" onClick={() => { setSide(p.side); setSel(p.id); }}>
                  <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10px] font-bold text-white" style={{ background: p.resolvedAt ? 'var(--color-muted)' : p.encounterId && encounterId && p.encounterId === encounterId ? 'var(--color-clay)' : 'var(--color-sky)' }}>{numberOf(p)}</span>
                  <span className="min-w-0 flex-1"><b>{p.area}</b>{p.diagnosis ? ` · ${p.diagnosis}` : ''}{p.finding ? <span className="text-muted"> · {p.finding}</span> : ''}</span>
                  <span className="shrink-0 pt-px text-[11.5px] text-muted">{p.photos ? `${p.photos} photo${p.photos === 1 ? '' : 's'} · ` : ''}{p.resolvedAt ? 'resolved' : p.encounterAt ? fmtDate(p.encounterAt) : fmtDate(p.createdAt)}</span>
                  <Icon name="chevR" className="h-3.5 w-3.5 shrink-0 text-muted" /></button>)}</div>}
          </div>
        ) : (
          <div className="anim-fade-in">
            <div className="flex flex-wrap items-center gap-2">
              <span className="grid h-6 w-6 place-items-center rounded-full text-[11px] font-bold text-white" style={{ background: pin.resolvedAt ? 'var(--color-muted)' : pin.encounterId === encounterId ? 'var(--color-clay)' : 'var(--color-sky)' }}>{numberOf(pin)}</span>
              <b className="text-[15px]">{pin.area}</b>
              {pin.resolvedAt ? <Chip>resolved {fmtDate(pin.resolvedAt)}</Chip> : pin.encounterAt ? <Chip tone={pin.encounterId === encounterId ? 'clay' : 'sky'}>{pin.encounterId === encounterId ? 'this visit' : `since ${fmtDate(pin.encounterAt)}`}</Chip> : null}
              <span className="ml-auto flex items-center gap-1">
                {!readOnly && <button type="button" className="btn btn-ghost btn-sm text-rose" onClick={() => del.mutate(pin.id)}>Remove</button>}
                <button type="button" className="btn btn-ghost btn-icon !h-8 !w-8" aria-label="Close pin" onClick={() => setSel(null)}><Icon name="x" className="h-3.5 w-3.5" /></button>
              </span>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <span className="w-16 text-xs text-muted">Seen here</span>
              {[...new Set([...findings, ...FINDINGS.slice(0, compact ? 8 : 12)])].map((f) => <button key={f} type="button" disabled={readOnly} className={`toggle-opt !min-h-7 !py-0.5 ${findings.includes(f) ? 'on' : ''}`} onClick={() => toggleFinding(f)}>{f}</button>)}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="w-16 text-xs text-muted">Which is</span>
              <input aria-label="Diagnosis at this site" className="input !w-60 !py-1.5 text-[13px]" placeholder={defaultDx || 'diagnosis'} defaultValue={pin.diagnosis ?? ''} disabled={readOnly} key={pin.id} onBlur={(e) => { const v = e.target.value.trim(); if ((pin.diagnosis ?? '') !== v) upd.mutate({ id: pin.id, diagnosis: v || null }); }} />
              {defaultDx && !pin.diagnosis && !readOnly && <button type="button" className="btn btn-sm" onClick={() => upd.mutate({ id: pin.id, diagnosis: defaultDx })}>Use {defaultDx}</button>}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="w-16 text-xs text-muted">Photos</span>
              {photos.length === 0 ? <span className="text-xs text-muted">none of this site yet</span>
                : <span className="flex flex-wrap gap-1.5">{photos.slice(0, compact ? 4 : 8).map((x) => <button key={x.id} type="button" className="relative h-14 w-14 overflow-hidden rounded-lg bg-paper-2" onClick={() => setCompare([photos[photos.length - 1], x])} title={fmtDate(x.takenAt)}><img src={`/api/documents/${x.id}/file`} alt={x.area ?? 'photo'} className="h-full w-full object-cover" /><span className="absolute bottom-0.5 left-0.5 rounded bg-black/55 px-1 text-[9px] font-semibold text-white">{new Date(x.takenAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</span></button>)}</span>}
              {!readOnly && <button type="button" className="btn btn-sm" onClick={() => setCapture(pin)}><Icon name="spark" className="h-3.5 w-3.5" />Take photo</button>}
              {photos.length >= 2 && <button type="button" className="btn btn-sm" onClick={() => setCompare([photos[photos.length - 1], photos[0]])}>Then / now</button>}
            </div>
            {!readOnly && <div className="mt-3 border-t border-line pt-2">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => upd.mutate({ id: pin.id, resolved: !pin.resolvedAt })}>{pin.resolvedAt ? 'Reopen' : 'Mark resolved · cleared'}</button>
            </div>}
          </div>
        )}
      </div>
      {capture && <PhotoCapture patient={{ id: patientId, fullName: patientName }} pin={{ id: capture.id, area: capture.area }} onClose={() => { setCapture(null); refresh(patientId); }} />}
      {compare && <PhotoCompare name={patientName} a={compare[0]} b={compare[1]} onClose={() => setCompare(null)} />}
    </div>
  );
}
