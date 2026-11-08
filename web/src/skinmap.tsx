import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, get, post, qc, errText } from './api';
import { Chip, Icon, toast, fmtDate } from './ui';
import { PhotoCapture, PhotoCompare, usePhotos } from './photos';

/** The skin map: a body silhouette with pins. A pin is a place on the patient that the clinic is watching: what was seen there, what it is, and the photos of it across visits. */
export type Pin = { id: string; side: 'front' | 'back'; x: number; y: number; area: string; finding: string | null; diagnosis: string | null; encounterId: string | null; encounterAt: string | null; resolvedAt: string | null; createdAt: string; photos: number; lastPhotoAt: string | null };

// Where a tap lands, in the 200 × 620 silhouette box. Left and right are the patient's own.
const ZONES: { area: string; x: number; y: number; w: number; h: number; back?: string }[] = [
  { area: 'Scalp', x: 70, y: 8, w: 60, h: 24, back: 'Scalp' }, { area: 'Face', x: 70, y: 32, w: 60, h: 56, back: 'Back of head' }, { area: 'Neck', x: 80, y: 88, w: 40, h: 16, back: 'Nape' },
  { area: 'Chest', x: 60, y: 104, w: 80, h: 70, back: 'Upper back' }, { area: 'Abdomen', x: 60, y: 174, w: 80, h: 68, back: 'Lower back' }, { area: 'Groin', x: 62, y: 242, w: 76, h: 56, back: 'Buttocks' },
  { area: 'Right upper arm', x: 22, y: 100, w: 34, h: 72, back: 'Left upper arm' }, { area: 'Left upper arm', x: 144, y: 100, w: 34, h: 72, back: 'Right upper arm' },
  { area: 'Right forearm', x: 20, y: 172, w: 36, h: 76, back: 'Left forearm' }, { area: 'Left forearm', x: 144, y: 172, w: 36, h: 76, back: 'Right forearm' },
  { area: 'Right hand', x: 16, y: 246, w: 30, h: 42, back: 'Left hand' }, { area: 'Left hand', x: 154, y: 246, w: 30, h: 42, back: 'Right hand' },
  { area: 'Right thigh', x: 60, y: 298, w: 38, h: 110, back: 'Left thigh' }, { area: 'Left thigh', x: 102, y: 298, w: 38, h: 110, back: 'Right thigh' },
  { area: 'Right leg', x: 60, y: 408, w: 38, h: 88, back: 'Left leg' }, { area: 'Left leg', x: 102, y: 408, w: 38, h: 88, back: 'Right leg' },
  { area: 'Right foot', x: 56, y: 494, w: 42, h: 36, back: 'Left foot' }, { area: 'Left foot', x: 102, y: 494, w: 42, h: 36, back: 'Right foot' },
];
export function areaAt(side: 'front' | 'back', nx: number, ny: number) {
  const x = nx * 200, y = ny * 620;
  const z = ZONES.find((z) => x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h);
  return z ? (side === 'back' ? z.back ?? z.area : z.area) : side === 'back' ? 'Back' : 'Trunk';
}
export const FINDINGS = ['Macule', 'Patch', 'Papule', 'Plaque', 'Pustule', 'Nodule', 'Vesicle', 'Scale', 'Crust', 'Erosion', 'Ulcer', 'Burrow', 'Comedone', 'Hypopigmented', 'Hyperpigmented', 'Scar'];

/** The silhouette. Tap to add a pin; tap a pin to pick it. Pins from earlier visits are blue, this visit's are clay, resolved ones grey. */
export function BodyMap({ side, pins, selectedId, onSelect, onAdd, readOnly, height = 260, encounterId }: { side: 'front' | 'back'; pins: Pin[]; selectedId: string | null; onSelect: (id: string) => void; onAdd?: (x: number, y: number, area: string) => void; readOnly?: boolean; height?: number; encounterId?: string | null }) {
  const w = Math.round(height * 200 / 620);
  const mine = pins.filter((p) => p.side === side);
  return (
    <div className="relative select-none" style={{ width: w, height }}>
      <svg viewBox="0 0 200 620" width={w} height={height} className={readOnly || !onAdd ? '' : 'cursor-crosshair'} role="img" aria-label={`${side} of the body, ${mine.length} pins`}
        onClick={(e) => { if (readOnly || !onAdd) return; const r = e.currentTarget.getBoundingClientRect(); const nx = (e.clientX - r.left) / r.width, ny = (e.clientY - r.top) / r.height; onAdd(nx, ny, areaAt(side, nx, ny)); }}>
        <g fill="var(--color-paper-2)" stroke="var(--color-line-2)" strokeWidth="2.5">
          <ellipse cx="100" cy="48" rx="30" ry="36" /><rect x="60" y="92" width="80" height="150" rx="26" /><rect x="24" y="100" width="30" height="150" rx="14" /><rect x="146" y="100" width="30" height="150" rx="14" />
          <rect x="18" y="246" width="26" height="40" rx="12" /><rect x="156" y="246" width="26" height="40" rx="12" /><rect x="62" y="240" width="76" height="60" rx="18" />
          <rect x="62" y="296" width="34" height="200" rx="16" /><rect x="104" y="296" width="34" height="200" rx="16" /><rect x="58" y="494" width="40" height="34" rx="12" /><rect x="102" y="494" width="40" height="34" rx="12" />
        </g>
        {side === 'back' && <text x="100" y="52" textAnchor="middle" fontSize="18" fill="var(--color-muted)">back</text>}
      </svg>
      {mine.map((p, i) => { const on = p.id === selectedId; const tone = p.resolvedAt ? 'var(--color-muted)' : p.encounterId && encounterId && p.encounterId === encounterId ? 'var(--color-clay)' : 'var(--color-sky)'; return (
        <button key={p.id} type="button" aria-label={`${p.area}${p.diagnosis ? `, ${p.diagnosis}` : ''}`} title={`${p.area}${p.diagnosis ? ` · ${p.diagnosis}` : ''}${p.finding ? ` · ${p.finding}` : ''}`}
          className={`absolute grid -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full text-[10px] font-bold text-white transition-transform ${on ? 'h-6 w-6 ring-4 ring-clay/25 scale-110' : 'h-5 w-5 ring-4 ring-black/5 hover:scale-110'}`}
          style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%`, background: tone }} onClick={(e) => { e.stopPropagation(); onSelect(p.id); }}>{i + 1}</button>); })}
    </div>
  );
}

const refresh = (patientId: string) => { qc.invalidateQueries({ queryKey: ['pins', patientId] }); qc.invalidateQueries({ queryKey: ['photos', patientId] }); };
export const usePins = (patientId: string) => useQuery<Pin[]>({ queryKey: ['pins', patientId], queryFn: () => get(`/patients/${patientId}/pins`), enabled: !!patientId });

/** The panel: the body on the left, the chosen pin on the right (finding chips, diagnosis, photos, then-and-now). Lives in the pad's Examination and on the patient record. */
export function SkinMapPanel({ patientId, patientName, encounterId, readOnly, defaultDx, onAreaAdded, compact }: { patientId: string; patientName: string; encounterId?: string | null; readOnly?: boolean; defaultDx?: string; onAreaAdded?: (area: string) => void; compact?: boolean }) {
  const pins = usePins(patientId); const photosQ = usePhotos(patientId);
  const [side, setSide] = useState<'front' | 'back'>('front');
  const [sel, setSel] = useState<string | null>(null);
  const [capture, setCapture] = useState<Pin | null>(null); const [compare, setCompare] = useState<[any, any] | null>(null);
  const list = pins.data ?? []; const pin = list.find((p) => p.id === sel) ?? null;
  const photos: any[] = useMemo(() => (photosQ.data?.photos ?? []).filter((x: any) => pin && (x.pinId === pin.id || (!x.pinId && x.area === pin.area))), [photosQ.data, pin]);
  const add = useMutation({ mutationFn: (b: { x: number; y: number; area: string }) => post(`/patients/${patientId}/pins`, { ...b, side, encounterId: encounterId ?? null, diagnosis: defaultDx || null }),
    onSuccess: (row: Pin, b) => { refresh(patientId); setSel(row.id); onAreaAdded?.(b.area); }, onError: (e) => toast(errText(e), 'err') });
  const upd = useMutation({ mutationFn: ({ id, ...b }: any) => api('PATCH', `/pins/${id}`, b), onSuccess: () => refresh(patientId), onError: (e) => toast(errText(e), 'err') });
  const del = useMutation({ mutationFn: (id: string) => api('DELETE', `/pins/${id}`), onSuccess: () => { refresh(patientId); setSel(null); }, onError: (e: any) => toast(e?.body?.code === 'PIN_HAS_PHOTOS' ? 'This pin has photos; mark it resolved instead.' : errText(e), 'err') });
  const findings = (pin?.finding ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const toggleFinding = (f: string) => pin && upd.mutate({ id: pin.id, finding: (findings.includes(f) ? findings.filter((x) => x !== f) : [...findings, f]).join(', ') || null });
  const height = compact ? 220 : 300;
  const counts = { front: list.filter((p) => p.side === 'front').length, back: list.filter((p) => p.side === 'back').length };
  return (
    <div className="flex flex-wrap gap-4">
      <div className="flex flex-col items-center gap-2">
        <div className="seg !p-[2px]" role="tablist">{(['front', 'back'] as const).map((s) => <button key={s} role="tab" aria-selected={side === s} className={`!px-2.5 !py-1 !text-[12px] ${side === s ? 'on relative z-[1] !bg-surface' : ''}`} onClick={() => setSide(s)}>{s === 'front' ? 'Front' : 'Back'}{counts[s] ? <span className="ml-1 text-muted">{counts[s]}</span> : null}</button>)}</div>
        <BodyMap side={side} pins={list} selectedId={sel} onSelect={setSel} onAdd={readOnly ? undefined : (x, y, area) => add.mutate({ x, y, area })} readOnly={readOnly} height={height} encounterId={encounterId} />
        <div className="text-[11px] text-muted">{readOnly ? 'Tap a pin' : 'Tap the body to pin a site · tap a pin to open it'}</div>
      </div>
      <div className="min-w-0 flex-1" style={{ minWidth: 220 }}>
        {!pin ? (
          <div>
            {list.length === 0 ? <div className="rounded-xl border border-dashed border-line-2 p-4 text-[13px] text-muted">No pins yet. {readOnly ? '' : 'Tap where the problem is: the pin keeps the photos, the finding and the diagnosis for that spot across visits.'}</div>
              : <div className="space-y-1">{list.map((p, i) => <button key={p.id} type="button" className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-surface-2" onClick={() => { setSide(p.side); setSel(p.id); }}>
                  <span className="grid h-5 w-5 place-items-center rounded-full text-[10px] font-bold text-white" style={{ background: p.resolvedAt ? 'var(--color-muted)' : p.encounterId && encounterId && p.encounterId === encounterId ? 'var(--color-clay)' : 'var(--color-sky)' }}>{list.filter((q) => q.side === p.side).indexOf(p) + 1}</span>
                  <span className="min-w-0 flex-1 truncate"><b>{p.area}</b>{p.diagnosis ? ` · ${p.diagnosis}` : ''}{p.finding ? <span className="text-muted"> · {p.finding}</span> : ''}</span>
                  <span className="text-[11.5px] text-muted">{p.photos ? `${p.photos} photo${p.photos === 1 ? '' : 's'}` : ''}{p.resolvedAt ? ' · resolved' : p.encounterAt ? ` · ${fmtDate(p.encounterAt)}` : ''}</span></button>)}</div>}
          </div>
        ) : (
          <div className="anim-fade-in">
            <div className="flex flex-wrap items-center gap-2">
              <b className="text-[14px]">{pin.area}</b>
              {pin.resolvedAt ? <Chip>resolved {fmtDate(pin.resolvedAt)}</Chip> : pin.encounterAt ? <Chip tone={pin.encounterId === encounterId ? 'clay' : 'sky'}>{pin.encounterId === encounterId ? 'this visit' : `since ${fmtDate(pin.encounterAt)}`}</Chip> : null}
              <span className="ml-auto flex items-center gap-1">
                {!readOnly && <button type="button" className="btn btn-sm" onClick={() => setCapture(pin)}><Icon name="spark" className="h-3.5 w-3.5" />Take photo</button>}
                {photos.length >= 2 && <button type="button" className="btn btn-sm" onClick={() => setCompare([photos[photos.length - 1], photos[0]])}>Then / now</button>}
                <button type="button" className="btn btn-ghost btn-icon !h-8 !w-8" aria-label="Close pin" onClick={() => setSel(null)}><Icon name="x" className="h-3.5 w-3.5" /></button>
              </span>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted">Seen here</span>
              {[...new Set([...findings, ...FINDINGS.slice(0, compact ? 8 : 12)])].map((f) => <button key={f} type="button" disabled={readOnly} className={`toggle-opt !min-h-7 !py-0.5 ${findings.includes(f) ? 'on' : ''}`} onClick={() => toggleFinding(f)}>{f}</button>)}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted">Which is</span>
              <input aria-label="Diagnosis at this site" className="input !w-56 !py-1 text-[12.5px]" placeholder={defaultDx || 'diagnosis'} defaultValue={pin.diagnosis ?? ''} disabled={readOnly} key={pin.id} onBlur={(e) => { const v = e.target.value.trim(); if ((pin.diagnosis ?? '') !== v) upd.mutate({ id: pin.id, diagnosis: v || null }); }} />
              {defaultDx && !pin.diagnosis && !readOnly && <button type="button" className="btn btn-sm" onClick={() => upd.mutate({ id: pin.id, diagnosis: defaultDx })}>Use {defaultDx}</button>}
            </div>
            <div className="mt-3">
              {photos.length === 0 ? <div className="text-xs text-muted">No photos of this site yet.</div>
                : <div className="flex flex-wrap gap-1.5">{photos.slice(0, compact ? 4 : 8).map((x) => <button key={x.id} type="button" className="relative h-16 w-16 overflow-hidden rounded-lg bg-paper-2" onClick={() => setCompare([photos[photos.length - 1], x])} title={fmtDate(x.takenAt)}><img src={`/api/documents/${x.id}/file`} alt={x.area ?? 'photo'} className="h-full w-full object-cover" /><span className="absolute bottom-0.5 left-0.5 rounded bg-black/55 px-1 text-[9px] font-semibold text-white">{new Date(x.takenAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</span></button>)}</div>}
            </div>
            {!readOnly && <div className="mt-3 flex flex-wrap gap-1.5 border-t border-line pt-2">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => upd.mutate({ id: pin.id, resolved: !pin.resolvedAt })}>{pin.resolvedAt ? 'Reopen' : 'Resolved · cleared'}</button>
              <button type="button" className="btn btn-ghost btn-sm text-rose" onClick={() => del.mutate(pin.id)}>Remove pin</button>
            </div>}
          </div>
        )}
      </div>
      {capture && <PhotoCapture patient={{ id: patientId, fullName: patientName }} pin={{ id: capture.id, area: capture.area }} onClose={() => { setCapture(null); refresh(patientId); }} />}
      {compare && <PhotoCompare name={patientName} a={compare[0]} b={compare[1]} onClose={() => setCompare(null)} />}
    </div>
  );
}
