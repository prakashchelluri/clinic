import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api, qc, errText } from './api';
import { Icon, Modal, Skeleton, ask, fmtDate, toast } from './ui';

export type VDoc = { id: string; title: string; mime: string; kind?: string; createdAt?: string; sizeBytes?: number };
type View = { docs: VDoc[]; index?: number; who?: string; canDelete?: boolean; onOpen?: (d: VDoc) => void };

let current: View | null = null; const subs = new Set<() => void>();
const set = (v: View | null) => { current = v; subs.forEach((s) => s()); };

/** Open documents in a popup on the same page: photos at full size, PDFs in the browser's own viewer, arrows to the patient's other documents. */
export const openViewer = (v: View) => set(v);

const size = (n?: number) => n === undefined ? '' : n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

export function ViewerHost() {
  const v = useSyncExternalStore((cb) => { subs.add(cb); return () => subs.delete(cb); }, () => current);
  if (!v) return null;
  return <Viewer key={v.docs[0]?.id + String(v.index ?? 0)} v={v} />;
}

function Viewer({ v }: { v: View }) {
  const [list, setList] = useState(v.docs); const [i, setI] = useState(Math.min(v.index ?? 0, v.docs.length - 1));
  const [url, setUrl] = useState(''); const [err, setErr] = useState(false); const [zoom, setZoom] = useState(0); // 0 = fit the window
  const frame = useRef<HTMLIFrameElement>(null);
  const d = list[i];
  const close = () => set(null);

  // the file is fetched with the user's session and shown from memory, so nothing is saved to disk and the page is never left
  useEffect(() => {
    if (!d) return;
    let on = true; let made = '';
    setUrl(''); setErr(false); setZoom(0);
    fetch(`/api/documents/${d.id}/file`, { credentials: 'same-origin' }).then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.arrayBuffer(); })
      .then((buf) => { if (!on) return; made = URL.createObjectURL(new Blob([buf], { type: d.mime })); setUrl(made); }).catch(() => on && setErr(true));
    v.onOpen?.(d);
    return () => { on = false; if (made) URL.revokeObjectURL(made); };
  }, [d?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = useCallback((n: number) => setI((x) => Math.min(list.length - 1, Math.max(0, x + n))), [list.length]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return; if (e.key === 'ArrowLeft') go(-1); else if (e.key === 'ArrowRight') go(1); };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, [go]);
  if (!d) return null;

  const isImg = d.mime.startsWith('image/');
  const print = () => {
    if (!url) return;
    if (!isImg) { frame.current?.contentWindow?.focus(); frame.current?.contentWindow?.print(); return; }
    const f = document.createElement('iframe'); f.style.cssText = 'position:fixed;width:0;height:0;border:0';
    f.srcdoc = `<img src="${url}" style="max-width:100%">`; f.onload = () => { f.contentWindow?.focus(); f.contentWindow?.print(); setTimeout(() => f.remove(), 3000); }; document.body.appendChild(f);
  };
  const remove = async () => {
    const a = await ask({ title: 'Delete this document?', body: `${d.title} is removed from the patient record. This cannot be undone.`, confirmLabel: 'Delete', cancelLabel: 'Keep', tone: 'danger' });
    if (!a) return;
    try { await api('DELETE', `/documents/${d.id}`); } catch (e) { toast(errText(e), 'err'); return; }
    ['documents', 'results', 'photos', 'worklist'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
    toast('Document deleted', 'info');
    if (list.length <= 1) close(); else { setList(list.filter((_, j) => j !== i)); setI(Math.max(0, i - 1)); }
  };
  const sub = [v.who, d.kind, d.createdAt ? fmtDate(d.createdAt) : '', size(d.sizeBytes), list.length > 1 ? `${i + 1} of ${list.length}` : ''].filter(Boolean).join(' · ');

  return (
    <Modal title={d.title} subtitle={sub} onClose={close} width="max-w-5xl">
      <div className="relative">
        <div className="min-h-[200px] overflow-auto rounded-2xl bg-[#6b6862]/90" style={{ height: 'min(68vh, 720px)' }}>
          {err ? <div className="grid h-full place-items-center p-6 text-center text-sm text-white">This file could not be opened. It may have been removed.</div>
            : !url ? <div className="p-6"><Skeleton rows={4} /></div>
            : isImg ? <div className="grid min-h-full place-items-center p-3"><img src={url} alt={d.title} className={zoom ? 'max-w-none' : 'max-h-full max-w-full object-contain'} style={zoom ? { width: `${zoom * 100}%` } : { maxHeight: 'calc(min(68vh, 720px) - 24px)' }} /></div>
            : <iframe ref={frame} src={url} title={d.title} className="block h-full w-full bg-white" />}
        </div>
        {list.length > 1 && <>
          <button aria-label="Previous document" disabled={i === 0} onClick={() => go(-1)} className="absolute left-3 top-1/2 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-full bg-white/95 text-lg shadow-lg disabled:opacity-30"><Icon name="chevL" /></button>
          <button aria-label="Next document" disabled={i === list.length - 1} onClick={() => go(1)} className="absolute right-3 top-1/2 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-full bg-white/95 text-lg shadow-lg disabled:opacity-30"><Icon name="chevR" /></button></>}
      </div>
      {list.length > 1 && <div className="mt-3 flex flex-wrap items-center gap-1.5"><span className="text-xs text-muted">Other documents</span>{list.map((x, j) => <button key={x.id} className={`toggle-opt !py-1 !text-xs ${j === i ? 'on' : ''}`} onClick={() => setI(j)}>{x.title.length > 26 ? x.title.slice(0, 24) + '…' : x.title}</button>)}</div>}
      <div className="modal-foot">
        {isImg && <div className="mr-auto flex gap-1"><button className="btn btn-ghost btn-sm" onClick={() => setZoom(0)}>Fit</button><button className="btn btn-ghost btn-sm" aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(1, (z || 1) - 0.5))}>−</button><button className="btn btn-ghost btn-sm" aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(4, (z || 1) + 0.5))}>+</button></div>}
        {v.canDelete && <button className="btn btn-ghost btn-sm text-rose" onClick={remove}>Delete</button>}
        <a className={`btn btn-sm ${url ? '' : 'pointer-events-none opacity-50'}`} href={url || undefined} download={d.title}><Icon name="download" className="h-3.5 w-3.5" />Download</a>
        <button className="btn btn-primary btn-sm" disabled={!url} onClick={print}><Icon name="print" className="h-3.5 w-3.5" />Print</button>
      </div>
    </Modal>
  );
}
