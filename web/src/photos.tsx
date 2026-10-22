import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { get, patch, post, api, qc, errText } from './api';
import { Chip, Empty, Icon, Section, Skeleton, toast } from './ui';

/* Clinical photos: consent, capture with a faint copy of the last photo, timeline by area and sitting, before/after compare. */

export const VIEWS: [string, string][] = [['front', 'Front'], ['left', 'Left'], ['right', 'Right'], ['back', 'Back'], ['closeup', 'Close-up']];
const viewLabel = (v?: string | null) => VIEWS.find((x) => x[0] === v)?.[1] ?? '—';
const fileUrl = (id: string) => `/api/documents/${id}/file`;
const dayLabel = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
const shortDay = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
const sittingLabel = (s: any) => `${s.procedure ?? 'Procedure'} · sitting ${s.sittingNo}${s.of ? ` of ${s.of}` : ''}`;
const daysApart = (a: string, b: string) => Math.round(Math.abs(new Date(b).getTime() - new Date(a).getTime()) / 86400000);
const refresh = (patientId: string) => { qc.invalidateQueries({ queryKey: ['photos', patientId] }); qc.invalidateQueries({ queryKey: ['documents', patientId] }); };

/** Shrink on the phone before upload: longest side 1600 px, JPEG. A 4 MB camera photo becomes ~300 KB. */
function shrink(src: CanvasImageSource, w: number, h: number, max = 1600): string {
  const k = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
  c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.85);
}
const fileToShrunk = (f: File) => new Promise<string>((res, rej) => {
  const url = URL.createObjectURL(f); const img = new Image();
  img.onload = () => { try { res(shrink(img, img.naturalWidth, img.naturalHeight)); } catch (e) { rej(e); } finally { URL.revokeObjectURL(url); } };
  img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('That file is not an image this browser can read.')); };
  img.src = url;
});

export const usePhotos = (patientId: string) => useQuery({ queryKey: ['photos', patientId], queryFn: () => get(`/patients/${patientId}/photos`), enabled: !!patientId });

/* ---------------- Consent ---------------- */
function ConsentStep({ patientId, name, onDone, dark = false }: { patientId: string; name: string; onDone: () => void; dark?: boolean }) {
  const m = useMutation({ mutationFn: () => post(`/patients/${patientId}/consents`, { key: 'photos', granted: true }), onSuccess: () => { refresh(patientId); toast('Photo consent recorded'); onDone(); }, onError: (e) => toast(errText(e), 'err') });
  return (
    <div className={`mx-auto max-w-md space-y-4 rounded-[24px] p-6 ${dark ? 'bg-white/10 text-white' : 'card'}`}>
      <div className="text-lg font-semibold">Photo consent for {name}</div>
      <p className={`text-sm ${dark ? 'text-white/80' : 'text-ink-2'}`}>Ask the patient: “We take photos of the treated area to track how the treatment is working. They stay in your record at this clinic and are not shared. Is that all right?”</p>
      <p className={`text-xs ${dark ? 'text-white/60' : 'text-muted'}`}>Recording consent once covers all later photos. It can be withdrawn from the patient's record at any time.</p>
      <button className="btn btn-accent w-full justify-center" disabled={m.isPending} onClick={() => m.mutate()}><Icon name="check" />Patient agrees, record consent</button>
    </div>
  );
}

/* ---------------- Capture ---------------- */
type Shot = { id: string; dataUrl: string; area: string; view: string };

/** Full-screen camera for the clinic phone. The last photo of the same area and view is shown faintly over the live picture. */
export function PhotoCapture({ patient, sitting, onClose }: { patient: { id: string; fullName: string }; sitting?: { id: string; label: string } | null; onClose: () => void }) {
  const q = usePhotos(patient.id);
  const video = useRef<HTMLVideoElement>(null); const stream = useRef<MediaStream | null>(null);
  const [camErr, setCamErr] = useState<string | null>(null); const [ready, setReady] = useState(false);
  const [area, setArea] = useState(''); const [view, setView] = useState('front'); const [custom, setCustom] = useState(''); const [adding, setAdding] = useState(false);
  const [ghost, setGhost] = useState(40); const [shots, setShots] = useState<Shot[]>([]); const [saving, setSaving] = useState(false); const [flash, setFlash] = useState(false);
  const consent = q.data?.consent; const areas: string[] = q.data?.areas ?? [];
  const usedAreas = useMemo(() => { const seen = new Set<string>(); for (const p of q.data?.photos ?? []) if (p.area) seen.add(p.area); return [...seen]; }, [q.data]);
  const allAreas = useMemo(() => [...new Set([...usedAreas, ...areas, ...(custom ? [custom] : [])])], [usedAreas, areas, custom]);
  const curArea = area || usedAreas[0] || areas[0] || '';
  const last = (q.data?.photos ?? []).find((p: any) => p.area === curArea && p.view === view);

  // Start the rear camera once consent is on record; stop it on close.
  useEffect(() => {
    if (!consent) return;
    let cancelled = false;
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) { setCamErr('This browser cannot open the camera here. Pick photos from the phone instead.'); return; }
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } }, audio: false });
        if (cancelled) { s.getTracks().forEach((t) => t.stop()); return; }
        stream.current = s; if (video.current) { video.current.srcObject = s; await video.current.play().catch(() => {}); }
        setReady(true);
      } catch (e: any) { setCamErr(e?.name === 'NotAllowedError' ? 'Camera permission was refused. Allow the camera for this site, or pick photos instead.' : 'No camera found on this device. Pick photos instead.'); }
    })();
    return () => { cancelled = true; stream.current?.getTracks().forEach((t) => t.stop()); stream.current = null; };
  }, [!!consent]);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);

  const snap = () => {
    const v = video.current; if (!v || !v.videoWidth || !curArea) return;
    setShots((s) => [...s, { id: crypto.randomUUID(), dataUrl: shrink(v, v.videoWidth, v.videoHeight), area: curArea, view }]);
    setFlash(true); setTimeout(() => setFlash(false), 160);
  };
  const pick = async (files: FileList | null) => {
    if (!files?.length || !curArea) return;
    for (const f of Array.from(files).slice(0, 12)) {
      if (!f.type.startsWith('image/')) { toast(`${f.name} is not a photo`, 'err'); continue; }
      try { const dataUrl = await fileToShrunk(f); setShots((s) => [...s, { id: crypto.randomUUID(), dataUrl, area: curArea, view }]); } catch (e: any) { toast(e.message, 'err'); }
    }
  };
  const saveAll = async () => {
    setSaving(true); let ok = 0;
    for (const s of shots) {
      try {
        await post('/documents', { patientId: patient.id, kind: 'photo', area: s.area, view: s.view, procedureSessionId: sitting?.id, title: `${s.area} · ${viewLabel(s.view)} · ${shortDay(new Date().toISOString())}`, mime: 'image/jpeg', dataBase64: s.dataUrl });
        ok++; setShots((x) => x.filter((y) => y.id !== s.id));
      } catch (e) { toast(errText(e), 'err'); break; }
    }
    setSaving(false); refresh(patient.id);
    if (ok) { toast(`${ok} photo${ok === 1 ? '' : 's'} saved${sitting ? ` to ${sitting.label}` : ''}`); }
    if (ok === shots.length) onClose();
  };
  const addArea = () => { const a = custom.trim().slice(0, 40); if (a) { setArea(a); setAdding(false); } };

  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col bg-[#0f1011] text-white anim-fade-in" role="dialog" aria-label="Take photos">
      <div className="flex items-center gap-3 px-4 pb-2 pt-4" style={{ paddingTop: 'max(16px, env(safe-area-inset-top))' }}>
        <button className="grid h-10 w-10 place-items-center rounded-full bg-white/15" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
        <div className="min-w-0 flex-1"><div className="truncate font-semibold">{patient.fullName}</div><div className="truncate text-xs text-white/70">{sitting?.label ?? 'Not tied to a sitting'}</div></div>
        {consent && <span className="rounded-full bg-sage-soft px-2.5 py-1 text-[11px] font-bold text-sage">consent ✓</span>}
      </div>
      {q.isLoading ? <div className="p-6"><Skeleton rows={3} /></div> : !consent ? <div className="flex flex-1 items-center p-4"><ConsentStep dark patientId={patient.id} name={patient.fullName} onDone={() => {}} /></div> : (<>
        <div className="no-scrollbar flex gap-1.5 overflow-x-auto px-4 pb-2" role="radiogroup" aria-label="Area">
          {allAreas.map((a) => <button key={a} role="radio" aria-checked={curArea === a} onClick={() => setArea(a)} className={`whitespace-nowrap rounded-full px-3.5 py-2 text-[13.5px] font-semibold ${curArea === a ? 'bg-white text-ink' : 'bg-white/15'}`}>{a}</button>)}
          {adding ? <span className="flex items-center gap-1"><input autoFocus aria-label="New area" maxLength={40} className="w-32 rounded-full bg-white/15 px-3 py-2 text-[13.5px] outline-none placeholder:text-white/50" placeholder="Area name" value={custom} onChange={(e) => setCustom(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addArea()} /><button className="rounded-full bg-white/15 px-3 py-2 text-[13.5px]" onClick={addArea}>Add</button></span>
            : <button className="whitespace-nowrap rounded-full bg-white/15 px-3.5 py-2 text-[13.5px] font-semibold" onClick={() => setAdding(true)}>+ area</button>}
        </div>
        <div className="flex gap-1.5 px-4 pb-2" role="radiogroup" aria-label="View">{VIEWS.map(([k, l]) => <button key={k} role="radio" aria-checked={view === k} onClick={() => setView(k)} className={`rounded-full px-3 py-1.5 text-[12.5px] font-semibold ${view === k ? 'bg-white text-ink' : 'bg-white/15'}`}>{l}</button>)}</div>

        <div className="relative mx-3 min-h-0 flex-1 overflow-hidden rounded-[24px] bg-black">
          {!camErr && <video ref={video} playsInline muted className="absolute inset-0 h-full w-full object-cover" />}
          {last && <img src={fileUrl(last.id)} alt="" aria-hidden className="pointer-events-none absolute inset-0 h-full w-full object-cover" style={{ opacity: camErr ? 0.9 : ghost / 100 }} />}
          {flash && <div className="absolute inset-0 bg-white/70" />}
          {last && <div className="absolute left-3 top-3 rounded-xl bg-black/50 px-2.5 py-1.5 text-xs">{camErr ? 'Last photo' : 'Faint overlay'}: {last.sitting ? `sitting ${last.sitting.sittingNo} · ` : ''}{shortDay(last.takenAt)}</div>}
          {!last && !camErr && ready && <div className="absolute left-3 top-3 rounded-xl bg-black/50 px-2.5 py-1.5 text-xs">First {curArea.toLowerCase()} {viewLabel(view).toLowerCase()} photo: no overlay yet</div>}
          {camErr && <div className="absolute inset-x-3 bottom-3 rounded-2xl bg-black/60 p-3 text-sm">{camErr}</div>}
          {!camErr && last && <label className="absolute inset-x-3 bottom-3 flex items-center gap-3 rounded-2xl bg-black/50 px-3 py-2 text-xs">Overlay<input type="range" min={0} max={80} step={5} value={ghost} onChange={(e) => setGhost(Number(e.target.value))} className="flex-1 accent-white" aria-label="Overlay strength" />{ghost}%</label>}
        </div>

        <div className="flex items-center justify-between gap-3 px-5 pb-2 pt-4">
          <div className="no-scrollbar flex min-w-0 flex-1 gap-1.5 overflow-x-auto">{shots.map((s) => (
            <button key={s.id} className="relative h-12 w-12 shrink-0 overflow-hidden rounded-xl ring-1 ring-white/30" aria-label={`Remove ${s.area} ${viewLabel(s.view)} photo`} onClick={() => setShots((x) => x.filter((y) => y.id !== s.id))}>
              <img src={s.dataUrl} alt="" className="h-full w-full object-cover" /><span className="absolute right-0.5 top-0.5 grid h-4 w-4 place-items-center rounded-full bg-black/70"><Icon name="x" className="h-2.5 w-2.5" /></span></button>))}</div>
          {camErr ? <label className="btn btn-accent shrink-0 cursor-pointer">Pick photos<input type="file" accept="image/*" capture="environment" multiple className="hidden" onChange={(e) => { pick(e.target.files); e.target.value = ''; }} /></label>
            : <button aria-label="Take photo" disabled={!ready || !curArea} onClick={snap} className="h-[74px] w-[74px] shrink-0 rounded-full bg-white shadow-[0_0_0_5px_rgba(255,255,255,.3)] transition-transform active:scale-95 disabled:opacity-40" />}
          <div className="flex min-w-0 flex-1 justify-end">{!camErr && <label className="cursor-pointer text-xs text-white/70 underline">or pick files<input type="file" accept="image/*" multiple className="hidden" onChange={(e) => { pick(e.target.files); e.target.value = ''; }} /></label>}</div>
        </div>
        <div className="px-4 pt-2" style={{ paddingBottom: 'max(16px, env(safe-area-inset-bottom))' }}>
          <button className="btn btn-accent w-full justify-center !py-3.5" disabled={!shots.length || saving} onClick={saveAll}>{saving ? 'Saving…' : shots.length ? `Save ${shots.length} photo${shots.length === 1 ? '' : 's'}${sitting ? ' to this sitting' : ''}` : 'Take a photo first'}</button>
          <div className="mt-2 text-center text-[11.5px] text-white/60">Photos are shrunk on this device before upload. Tap a thumbnail to drop it.</div>
        </div>
      </>)}
    </div>
  , document.body);
}

/* ---------------- Timeline ---------------- */
/** The patient's photos by area, grouped by sitting (or day). Pick two to compare; open one to re-tag or remove. */
export function PhotoTimeline({ patient, canWrite }: { patient: { id: string; fullName: string }; canWrite: boolean }) {
  const q = usePhotos(patient.id);
  const [area, setArea] = useState('all'); const [sel, setSel] = useState<string[]>([]);
  const [capturing, setCapturing] = useState(false); const [comparing, setComparing] = useState(false); const [viewing, setViewing] = useState<any>(null);
  // A sitting today for this patient? Photos taken now belong to it.
  const todays = useQuery({ queryKey: ['psessions-today', patient.id], queryFn: () => get(`/procedure-sessions?day=${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date())}`), retry: false, enabled: canWrite });
  const sittingToday = (todays.data ?? []).find((s: any) => s.patient?.id === patient.id && !['cancelled', 'postponed'].includes(s.state));
  const withdraw = useMutation({ mutationFn: () => post(`/patients/${patient.id}/consents`, { key: 'photos', granted: false }), onSuccess: () => { refresh(patient.id); toast('Photo consent withdrawn', 'info'); } });
  const photos: any[] = q.data?.photos ?? [];
  const counts = useMemo(() => photos.reduce((m: Record<string, number>, p) => { const k = p.area ?? 'Untagged'; m[k] = (m[k] ?? 0) + 1; return m; }, {}), [photos]);
  const shown = area === 'all' ? photos : photos.filter((p) => (p.area ?? 'Untagged') === area);
  const groups = useMemo(() => {
    const g: { key: string; title: string; sub: string; items: any[] }[] = [];
    for (const p of shown) {
      const key = p.sitting?.id ?? 'd:' + new Date(p.takenAt).toDateString();
      let row = g.find((x) => x.key === key);
      if (!row) g.push(row = { key, title: dayLabel(p.sitting?.day ? p.sitting.day + 'T06:00:00Z' : p.takenAt), sub: p.sitting ? sittingLabel(p.sitting) : 'Not tied to a sitting', items: [] });
      row.items.push(p);
    }
    return g;
  }, [shown]);
  const toggle = (id: string) => setSel((s) => s.includes(id) ? s.filter((x) => x !== id) : [...s.slice(-1), id]);
  const pair = sel.map((id) => photos.find((p) => p.id === id)).filter(Boolean).sort((a: any, b: any) => +new Date(a.takenAt) - +new Date(b.takenAt));
  const consent = q.data?.consent;
  const nSittings = new Set(photos.map((p) => p.sitting?.id).filter(Boolean)).size;

  return (
    <Section title={<>Photos <span className="font-normal text-muted">· {photos.length}{nSittings ? ` · ${nSittings} sitting${nSittings === 1 ? '' : 's'}` : ''}</span></>}
      aside={canWrite && <button className="btn btn-sm btn-accent" onClick={() => setCapturing(true)}><Icon name="plus" className="h-3.5 w-3.5" />Take photos</button>}>
      <div className="space-y-3 p-4">
        {q.isLoading ? <Skeleton rows={2} /> : (<>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            {consent ? <><Chip tone="sage">photo consent</Chip><span>given {shortDay(consent.grantedAt)} · {consent.by}</span>{canWrite && <button className="underline hover:text-ink" onClick={() => { if (confirm('Withdraw photo consent? Existing photos stay; no new photos can be taken.')) withdraw.mutate(); }}>withdraw</button>}</>
              : <><Chip tone="amber">no photo consent yet</Chip><span>Asked when you first take photos.</span></>}
            {photos.length > 1 && <span className="ml-auto">Pick two photos to compare</span>}
          </div>
          {photos.length > 0 && <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Area">
            <button role="radio" aria-checked={area === 'all'} className={`toggle-opt ${area === 'all' ? 'on' : ''}`} onClick={() => setArea('all')}>All <span className="opacity-60">{photos.length}</span></button>
            {Object.entries(counts).map(([a, n]) => <button key={a} role="radio" aria-checked={area === a} className={`toggle-opt ${area === a ? 'on' : ''}`} onClick={() => setArea(a)}>{a} <span className="opacity-60">{n}</span></button>)}
          </div>}
          {photos.length === 0 ? <Empty icon="spark" title="No clinical photos yet" hint="Take photos before a course starts and at each sitting. Each new photo lines up with the last one." />
            : groups.map((g) => (
              <div key={g.key} className="flex flex-col gap-2.5 border-t border-line/60 pt-3 first:border-t-0">
                <div className="flex flex-wrap items-baseline gap-x-2"><span className="font-semibold">{g.title}</span><span className="text-xs text-muted">{g.sub}</span></div>
                <div className="flex flex-wrap gap-2.5">{g.items.map((p) => {
                  const n = sel.indexOf(p.id);
                  return (
                    <div key={p.id} className={`group relative h-28 w-28 overflow-hidden rounded-2xl sm:h-32 sm:w-32 bg-paper-2 transition-shadow ${n >= 0 ? 'ring-[3px] ring-clay' : ''}`}>
                      <button className="h-full w-full" aria-pressed={n >= 0} aria-label={`${n >= 0 ? 'Unpick' : 'Pick'} ${p.area ?? 'photo'} ${viewLabel(p.view)} for comparing`} onClick={() => toggle(p.id)}><img src={fileUrl(p.id)} alt={`${p.area ?? 'Photo'}, ${viewLabel(p.view)}, ${shortDay(p.takenAt)}`} loading="lazy" className="h-full w-full object-cover" /></button>
                      <span className="pointer-events-none absolute bottom-2 left-2 rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-bold text-white">{area === 'all' && p.area ? `${p.area} · ` : ''}{viewLabel(p.view)}</span>
                      {n >= 0 && <span className="pointer-events-none absolute right-2 top-2 grid h-6 w-6 place-items-center rounded-full bg-clay text-xs font-bold text-white">{n + 1}</span>}
                      <button className="absolute left-2 top-2 grid h-7 w-7 place-items-center rounded-full bg-black/55 text-white opacity-90 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100" aria-label="Open photo" onClick={() => setViewing(p)}><Icon name="search" className="h-3.5 w-3.5" /></button>
                    </div>);
                })}</div>
              </div>
            ))}
        </>)}
      </div>
      {pair.length === 2 && (
        <div className="sticky bottom-4 z-10 mx-auto mb-4 flex w-fit max-w-[calc(100%-2rem)] items-center gap-3 rounded-full bg-ink py-2 pl-5 pr-2 text-sm text-white anim-fade-up" style={{ boxShadow: '0 20px 40px -18px rgba(0,0,0,.5)' }}>
          <span className="truncate">{pair[0].area === pair[1].area ? pair[0].area : `${pair[0].area ?? '—'} / ${pair[1].area ?? '—'}`} · {shortDay(pair[0].takenAt)} → {shortDay(pair[1].takenAt)}</span>
          <button className="btn btn-accent btn-sm" onClick={() => setComparing(true)}>Compare</button>
          <button className="grid h-8 w-8 place-items-center rounded-full hover:bg-white/10" aria-label="Clear selection" onClick={() => setSel([])}><Icon name="x" className="h-3.5 w-3.5" /></button>
        </div>
      )}
      {capturing && <PhotoCapture patient={patient} sitting={sittingToday ? { id: sittingToday.id, label: `${sittingToday.procedure ?? 'Procedure'} · sitting ${sittingToday.sittingNo}` } : null} onClose={() => setCapturing(false)} />}
      {comparing && pair.length === 2 && <PhotoCompare name={patient.fullName} a={pair[0]} b={pair[1]} onClose={() => setComparing(false)} />}
      {viewing && <PhotoViewer photo={viewing} list={shown} areas={q.data?.areas ?? []} canWrite={canWrite} patientId={patient.id} onClose={() => setViewing(null)} onMove={setViewing} />}
    </Section>
  );
}

/* ---------------- Compare ---------------- */
export function PhotoCompare({ name, a, b, onClose }: { name: string; a: any; b: any; onClose: () => void }) {
  const [mode, setMode] = useState<'side' | 'slider'>('side'); const [x, setX] = useState(50);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); if (mode === 'slider' && e.key === 'ArrowLeft') setX((v) => Math.max(0, v - 5)); if (mode === 'slider' && e.key === 'ArrowRight') setX((v) => Math.min(100, v + 5)); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [mode, onClose]);
  const tag = (p: any, which: string) => <div className="absolute left-3 top-3 rounded-xl bg-black/55 px-3 py-2 text-sm leading-tight text-white"><b>{which}</b> · {shortDay(p.takenAt)}<div className="text-xs text-white/70">{p.sitting ? `sitting ${p.sitting.sittingNo}${p.sitting.of ? ` of ${p.sitting.of}` : ''}` : 'no sitting'} · {viewLabel(p.view)}</div></div>;
  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col gap-3 bg-[#141516] p-3 text-white anim-fade-in sm:p-6" role="dialog" aria-label="Compare photos">
      <div className="flex flex-wrap items-center gap-3">
        <button className="grid h-10 w-10 place-items-center rounded-full bg-white/15" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
        <div className="min-w-0 flex-1"><div className="truncate text-lg font-semibold">{name} · {a.area === b.area ? a.area ?? 'Photo' : `${a.area ?? '—'} vs ${b.area ?? '—'}`}</div><div className="text-sm text-white/70">{a.sitting?.procedure ?? b.sitting?.procedure ?? 'Clinical photos'} · {daysApart(a.takenAt, b.takenAt)} days apart</div></div>
        <div className="inline-flex rounded-full bg-white/10 p-[3px]" role="radiogroup" aria-label="Compare mode">{([['side', 'Side by side'], ['slider', 'Slider']] as const).map(([k, l]) => <button key={k} role="radio" aria-checked={mode === k} onClick={() => setMode(k)} className={`rounded-full px-4 py-2 text-[13px] font-semibold ${mode === k ? 'bg-white text-ink' : 'text-white/75'}`}>{l}</button>)}</div>
      </div>
      {mode === 'side' ? (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 sm:grid-cols-2">
          {[[a, 'Before'], [b, 'After']].map(([p, w]: any) => <div key={p.id} className="relative min-h-[40vh] overflow-hidden rounded-[22px] bg-black"><img src={fileUrl(p.id)} alt={`${w}: ${p.area ?? ''}`} className="absolute inset-0 h-full w-full object-contain" />{tag(p, w)}</div>)}
        </div>
      ) : (
        <div className="relative min-h-0 flex-1 select-none overflow-hidden rounded-[22px] bg-black">
          <img src={fileUrl(b.id)} alt="After" className="absolute inset-0 h-full w-full object-contain" />
          <img src={fileUrl(a.id)} alt="Before" className="absolute inset-0 h-full w-full object-contain" style={{ clipPath: `inset(0 ${100 - x}% 0 0)` }} />
          <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-white" style={{ left: `${x}%` }} />
          {tag(a, 'Before')}<div className="absolute right-3 top-3 rounded-xl bg-black/55 px-3 py-2 text-sm text-white"><b>After</b> · {shortDay(b.takenAt)}</div>
          <input type="range" min={0} max={100} value={x} onChange={(e) => setX(Number(e.target.value))} aria-label="Slide between before and after" className="absolute inset-x-6 bottom-5 accent-white" />
        </div>
      )}
      <div className="text-center text-xs text-white/60">{mode === 'slider' ? 'Drag the slider or use the arrow keys · ' : ''}Photos stay inside the clinic record</div>
    </div>
  , document.body);
}

/* ---------------- One photo: view, re-tag, remove ---------------- */
function PhotoViewer({ photo, list, areas, canWrite, patientId, onClose, onMove }: { photo: any; list: any[]; areas: string[]; canWrite: boolean; patientId: string; onClose: () => void; onMove: (p: any) => void }) {
  const i = list.findIndex((p) => p.id === photo.id);
  const [area, setArea] = useState(photo.area ?? ''); const [view, setView] = useState(photo.view ?? 'front'); const [note, setNote] = useState(photo.note ?? '');
  useEffect(() => { setArea(photo.area ?? ''); setView(photo.view ?? 'front'); setNote(photo.note ?? ''); }, [photo.id]);
  useEffect(() => { const k = (e: KeyboardEvent) => { if ((e.target as HTMLElement)?.tagName === 'INPUT') return; if (e.key === 'Escape') onClose(); if (e.key === 'ArrowLeft' && i > 0) onMove(list[i - 1]); if (e.key === 'ArrowRight' && i < list.length - 1) onMove(list[i + 1]); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [i, list, onClose, onMove]);
  const save = useMutation({ mutationFn: () => patch(`/documents/${photo.id}`, { area: area.trim() || null, view, note: note.trim() || null }), onSuccess: (r: any) => { refresh(patientId); toast('Photo updated'); onMove({ ...photo, ...r }); }, onError: (e) => toast(errText(e), 'err') });
  const del = useMutation({ mutationFn: () => api('DELETE', `/documents/${photo.id}`), onSuccess: () => { refresh(patientId); toast('Photo removed', 'info'); onClose(); }, onError: (e) => toast(errText(e), 'err') });
  const dirty = (area.trim() || null) !== (photo.area ?? null) || view !== (photo.view ?? 'front') || (note.trim() || null) !== (photo.note ?? null);
  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col bg-[#141516] text-white anim-fade-in lg:flex-row" role="dialog" aria-label="Photo">
      <div className="relative min-h-[50vh] flex-1">
        <img src={fileUrl(photo.id)} alt={`${photo.area ?? 'Photo'}, ${viewLabel(photo.view)}`} className="absolute inset-0 h-full w-full object-contain" />
        <button className="absolute left-4 top-4 grid h-10 w-10 place-items-center rounded-full bg-white/15" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
        {i > 0 && <button className="absolute left-4 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full bg-white/15" aria-label="Previous photo" onClick={() => onMove(list[i - 1])}><Icon name="chevL" /></button>}
        {i < list.length - 1 && <button className="absolute right-4 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full bg-white/15" aria-label="Next photo" onClick={() => onMove(list[i + 1])}><Icon name="chevR" /></button>}
      </div>
      <div className="w-full space-y-3 bg-[#1c1d1f] p-5 lg:w-[340px]">
        <div><div className="text-lg font-semibold">{dayLabel(photo.takenAt)}</div><div className="text-sm text-white/70">{photo.sitting ? sittingLabel(photo.sitting) : 'Not tied to a sitting'}</div></div>
        {canWrite ? (<>
          <div><label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-white/60" htmlFor="pv-area">Area</label><input id="pv-area" list="pv-areas" maxLength={40} className="w-full rounded-xl bg-white/10 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-white/40" value={area} onChange={(e) => setArea(e.target.value)} /><datalist id="pv-areas">{areas.map((a) => <option key={a} value={a} />)}</datalist></div>
          <div><span className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-white/60">View</span><div className="flex flex-wrap gap-1.5">{VIEWS.map(([k, l]) => <button key={k} onClick={() => setView(k)} className={`rounded-full px-3 py-1.5 text-[12.5px] font-semibold ${view === k ? 'bg-white text-ink' : 'bg-white/10'}`}>{l}</button>)}</div></div>
          <div><label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-white/60" htmlFor="pv-note">Note</label><textarea id="pv-note" maxLength={500} className="min-h-[72px] w-full rounded-xl bg-white/10 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-white/40" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. mild redness after the session" /></div>
          <div className="flex flex-wrap gap-2"><button className="btn btn-accent" disabled={!dirty || save.isPending} onClick={() => save.mutate()}><Icon name="check" />Save</button><button className="btn !border-white/20 !bg-white/10 !text-white" onClick={() => { if (confirm('Remove this photo from the record?')) del.mutate(); }}>Remove</button></div>
        </>) : <div className="text-sm text-white/80">{photo.area ?? 'Untagged'} · {viewLabel(photo.view)}{photo.note ? <div className="mt-2">{photo.note}</div> : null}</div>}
      </div>
    </div>
  , document.body);
}
