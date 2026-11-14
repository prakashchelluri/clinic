import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Excalidraw, exportToBlob, convertToExcalidrawElements } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import { ArrowLeft, LayoutTemplate, Save, Printer, Plus, Trash2 } from 'lucide-react';
import { api, post, qc, errText } from './api';
import { Floating, Icon, ask, toast } from './ui';
import { useTemplates } from './templates';

/** One drawing on the pad: the drawing tool's elements and image files (to open it again), and its picture as a document (what prints). */
export type PadCanvas = { id: string; name: string; showInRx: boolean; docId?: string | null; elements: any[]; files?: Record<string, any> };

// a figure to draw on: the body outline (front and back are the same silhouette) and a face
const BODY = 'M100 8C118 8 131 25 131 47C131 66 123 82 113 90C113 95 114 100 114 104C118 108 148 110 157 124C164 136 168 158 170 180C173 198 178 222 182 250C186 262 192 274 191 286C190 296 180 300 172 296C165 292 161 282 159 272C156 256 152 230 149 206C147 194 145 182 145 176C144 160 143 146 142 134C139 166 136 196 139 226C144 246 148 266 147 290C146 326 142 372 139 416C137 450 137 478 139 500C140 512 146 520 146 528C144 536 116 536 112 530C108 524 106 512 106 500C104 470 103 444 104 420C103 380 102 340 101 302C101 300 100 300 100 300C100 300 99 300 99 302C98 340 97 380 96 420C97 444 96 470 94 500C94 512 92 524 88 530C84 536 56 536 54 528C54 520 60 512 61 500C63 478 63 450 61 416C58 372 54 326 53 290C52 266 56 246 61 226C64 196 61 166 58 134C57 146 56 160 55 176C55 182 53 194 51 206C48 230 44 256 41 272C39 282 35 292 28 296C20 300 10 296 9 286C8 274 14 262 18 250C22 222 27 198 30 180C32 158 36 136 43 124C52 110 82 108 86 104C86 100 87 95 87 90C77 82 69 66 69 47C69 25 82 8 100 8Z';
// The drawing tool's fonts are served by the app itself (the page's security rules allow no outside fonts); the Chinese font is left out.
(window as any).EXCALIDRAW_ASSET_PATH = '/excalidraw/';

/** An outline as the drawing tool's own lines (not a picture: the page's rules refuse data pictures there), sampled along an SVG path, scaled and moved. */
const linesOf = (d: string, dx = 0, dy = 0, k = 1.6): any[] => {
  const host = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); host.style.position = 'absolute'; host.style.visibility = 'hidden'; document.body.appendChild(host);
  try {
    return d.split(/(?=M)/).map((part) => {
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', part); host.appendChild(p);
      const len = p.getTotalLength(); const pts: [number, number][] = [];
      for (let l = 0; l <= len; l += 2) { const q = p.getPointAtLength(l); pts.push([q.x * k, q.y * k]); }
      if (/z\s*$/i.test(part)) pts.push(pts[0]);
      const [x0, y0] = pts[0];
      return { type: 'line', x: dx + x0, y: dy + y0, points: pts.map(([x, y]) => [x - x0, y - y0]), strokeColor: '#6b7280', strokeWidth: 1, roughness: 0, locked: true };
    });
  } finally { host.remove(); }
};
const label = (text: string, x: number, y: number) => ({ type: 'text', x, y, text, fontSize: 16, strokeColor: '#9ca3af', locked: true });
const FIGURES: { name: string; elements: () => any[] }[] = [
  { name: 'Body · front and back', elements: () => [...linesOf(BODY), ...linesOf(BODY, 360), label('Front', 140, 870), label('Back', 505, 870)] },
  { name: 'Face', elements: () => [{ type: 'ellipse', x: 0, y: 0, width: 300, height: 380, strokeColor: '#6b7280', roughness: 0, locked: true }, ...linesOf('M95 150q20-14 40 0M165 150q20-14 40 0M150 170v55q-10 8-18 3M112 280q38 22 76 0', 0, 0, 1)] },
];
const figureScene = (f: (typeof FIGURES)[number]) => ({ elements: convertToExcalidrawElements(f.elements() as any), files: {} });
const blobUrl = (b: Blob) => new Promise<string>((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = no; r.readAsDataURL(b); });

/** The Canvas drawer: this visit's drawings, each with Show in Rx; Create new canvas opens the drawing board. */
export function CanvasDrawer({ canvases, onChange, patientId, encounterId, readOnly }: { canvases: PadCanvas[]; onChange: (xs: PadCanvas[]) => void; patientId: string; encounterId: string; readOnly: boolean }) {
  const [editing, setEditing] = useState<PadCanvas | null>(null);
  const next = () => { const d = new Date(); return `canvas${String(canvases.length + 1).padStart(2, '0')}_${d.getDate()}${d.toLocaleString('en-IN', { month: 'short' })}'${String(d.getFullYear()).slice(2)}`; };
  const remove = async (c: PadCanvas) => {
    if (!(await ask({ title: `Delete ${c.name}?`, body: 'The drawing goes from this visit and from the prescription.', confirmLabel: 'Delete', tone: 'danger' }))) return;
    if (c.docId) api('DELETE', `/documents/${c.docId}`).catch(() => {});
    onChange(canvases.filter((x) => x.id !== c.id));
  };
  return (
    <div>
      {canvases.length === 0 ? <div className="grid place-items-center gap-2 py-12 text-center"><b className="text-[15px]">No canvases yet</b><span className="text-[13px] text-muted">Draw on a body outline or a blank page; it can print on the prescription.</span>
        {!readOnly && <button type="button" className="btn btn-primary mt-2" onClick={() => setEditing({ id: crypto.randomUUID(), name: next(), showInRx: true, elements: [] })}><Plus className="h-4 w-4" aria-hidden />Create new canvas</button>}</div>
        : <div className="space-y-2">
          {!readOnly && <div className="flex justify-end"><button type="button" className="btn btn-sm" onClick={() => setEditing({ id: crypto.randomUUID(), name: next(), showInRx: true, elements: [] })}><Plus className="h-3.5 w-3.5" aria-hidden />Create new canvas</button></div>}
          {canvases.map((c) => <div key={c.id} className="flex items-center gap-3 rounded-[10px] border border-line p-2">
            <button type="button" className="h-16 w-24 shrink-0 overflow-hidden rounded-md border border-line bg-white" onClick={() => setEditing(c)} aria-label={`Open ${c.name}`}>{c.docId && <img src={`/api/documents/${c.docId}/file`} alt="" className="h-full w-full object-contain" />}</button>
            <div className="min-w-0 flex-1"><div className="truncate text-[13.5px] font-semibold">{c.name}</div><div className="text-xs text-muted">{c.showInRx ? 'Prints on the prescription' : 'Not printed'}</div></div>
            <label className="inline-flex items-center gap-1.5 text-[12.5px]"><input type="checkbox" className="accent-ink" disabled={readOnly} checked={c.showInRx} onChange={(e) => onChange(canvases.map((x) => (x.id === c.id ? { ...x, showInRx: e.target.checked } : x)))} />Show in Rx</label>
            <button type="button" className="btn btn-sm" onClick={() => setEditing(c)}>{readOnly && <Icon name="eye" />}{readOnly ? 'View' : 'Open'}</button>
            {!readOnly && <button type="button" className="btn btn-ghost btn-icon" aria-label={`Delete ${c.name}`} onClick={() => { void remove(c); }}><Trash2 className="h-4 w-4" aria-hidden /></button>}
          </div>)}
        </div>}
      {editing && <CanvasBoard canvas={editing} patientId={patientId} encounterId={encounterId} readOnly={readOnly} onClose={() => setEditing(null)}
        onSaved={(c) => { onChange(canvases.some((x) => x.id === c.id) ? canvases.map((x) => (x.id === c.id ? c : x)) : [...canvases, c]); setEditing(c); }} />}
    </div>
  );
}

/** The drawing board, full screen as in Tatva: name, templates, save as template, Show in Rx, Print and Save; the drawing tool's own toolbar in the middle. */
function CanvasBoard({ canvas, patientId, encounterId, readOnly, onClose, onSaved }: { canvas: PadCanvas; patientId: string; encounterId: string; readOnly: boolean; onClose: () => void; onSaved: (c: PadCanvas) => void }) {
  const apiRef = useRef<any>(null); const [name, setName] = useState(canvas.name); const [showInRx, setShowInRx] = useState(canvas.showInRx);
  const [tplOpen, setTplOpen] = useState(false); const tplBtn = useRef<HTMLButtonElement>(null); const [busy, setBusy] = useState(false); const changed = useRef(false);
  const sets = useTemplates(); const mine = (sets.data ?? []).filter((t) => t.kind === 'canvas');
  const scene = () => ({ elements: (apiRef.current?.getSceneElements() ?? []).filter((e: any) => !e.isDeleted), files: apiRef.current?.getFiles() ?? {} });
  const load = (s: { elements: any[]; files?: Record<string, any> }) => { const a = apiRef.current; if (!a) return; if (s.files) a.addFiles(Object.values(s.files)); a.updateScene({ elements: [...a.getSceneElements(), ...s.elements] }); a.scrollToContent(undefined, { fitToContent: true }); changed.current = true; setTplOpen(false); };
  const png = async () => { const { elements, files } = scene(); const b = await exportToBlob({ elements, files, appState: { exportBackground: true, viewBackgroundColor: '#ffffff' }, mimeType: 'image/png', exportPadding: 16 }); return blobUrl(b); };
  const save = async (): Promise<PadCanvas | null> => {
    const { elements, files } = scene(); if (!elements.length) { toast('Draw something first.', 'info'); return null; }
    setBusy(true);
    try {
      const doc: any = await post('/documents', { patientId, encounterId, kind: 'canvas', title: `Canvas · ${name}`, mime: 'image/png', dataBase64: await png() });
      if (canvas.docId) api('DELETE', `/documents/${canvas.docId}`).catch(() => {}); // the old picture of this drawing
      qc.invalidateQueries({ queryKey: ['documents', patientId] });
      const used = new Set(elements.map((e: any) => e.fileId).filter(Boolean));
      const c: PadCanvas = { ...canvas, name: name.trim() || canvas.name, showInRx, docId: doc.id, elements, files: Object.fromEntries(Object.entries(files).filter(([k]) => used.has(k))) };
      changed.current = false; onSaved(c); toast('Canvas saved'); return c;
    } catch (e) { toast(errText(e), 'err'); return null; } finally { setBusy(false); }
  };
  const print = async () => { const url = await png(); const w = window.open('', '_blank'); if (!w) return; w.document.write(`<title>${name}</title><img src="${url}" style="max-width:100%" onload="print()">`); w.document.close(); };
  const saveAsTemplate = async () => {
    const { elements, files } = scene(); if (!elements.length) return toast('Draw something first.', 'info');
    const r = await ask({ title: 'Save as a canvas template', body: 'It appears under Templates on every canvas.', confirmLabel: 'Save', field: { label: 'Name', required: true, initial: name, maxLength: 80 } });
    if (!r?.value || r.value.trim().length < 2) return;
    try { const row: any = await post('/templates', { kind: 'canvas', name: r.value.trim(), linked: {}, payload: { elements, files } }); qc.invalidateQueries({ queryKey: ['templates'] }); toast(row.draft ? 'Saved. The owner approves it before others see it.' : 'Saved as a template'); } catch (e) { toast(errText(e), 'err'); }
  };
  const back = async () => { if (changed.current && !readOnly && !(await ask({ title: 'Leave without saving?', body: 'The drawing since the last Save will be lost.', confirmLabel: 'Leave', tone: 'danger' }))) return; onClose(); };
  const B = 'btn btn-sm';
  return createPortal(
    <div data-over-modal className="fixed inset-0 z-[60] flex flex-col bg-white" role="dialog" aria-label={`Canvas ${name}`}>
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <button type="button" className="btn btn-ghost btn-icon" aria-label="Back to the pad" onClick={() => { void back(); }}><ArrowLeft className="h-4 w-4" aria-hidden /></button>
        <input aria-label="Canvas name" className="input !w-60 !border-transparent !py-1 font-semibold hover:!border-line" maxLength={60} value={name} disabled={readOnly} onChange={(e) => setName(e.target.value)} />
        <span className="ml-auto" />
        {!readOnly && <><button ref={tplBtn} type="button" className={B} aria-expanded={tplOpen} onClick={() => setTplOpen(!tplOpen)}><LayoutTemplate className="h-3.5 w-3.5" aria-hidden />Templates</button>
          <Floating anchor={tplBtn} open={tplOpen} onClose={() => setTplOpen(false)} width={280}>
            <div className="p-1.5"><div className="px-2 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wider text-muted">Canvas templates</div>
              {FIGURES.map((f) => <button key={f.name} type="button" className="flex w-full rounded-md px-2.5 py-2 text-left text-[13px] font-medium hover:bg-paper-2" onClick={() => load(figureScene(f))}>{f.name}</button>)}
              {mine.map((t) => <button key={t.id} type="button" className="flex w-full rounded-md px-2.5 py-2 text-left text-[13px] font-medium hover:bg-paper-2" onClick={() => { load(t.payload as any); post(`/templates/${t.id}/use`).catch(() => {}); }}>{t.name}</button>)}
            </div>
          </Floating>
          <button type="button" className={B} onClick={() => { void saveAsTemplate(); }}><Save className="h-3.5 w-3.5" aria-hidden />Save as template</button>
          <label className="inline-flex items-center gap-1.5 rounded-[8px] bg-paper-2 px-2.5 py-1.5 text-[12.5px] font-semibold"><input type="checkbox" className="accent-ink" checked={showInRx} onChange={(e) => { setShowInRx(e.target.checked); changed.current = true; }} />Show in Rx</label></>}
        <button type="button" className={B} onClick={() => { void print(); }}><Printer className="h-3.5 w-3.5" aria-hidden />Print</button>
        {!readOnly && <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => { void save(); }}>{busy ? 'Saving…' : 'Save'}</button>}
      </div>
      <div className="min-h-0 flex-1">
        <Excalidraw excalidrawAPI={(a) => { apiRef.current = a; }} viewModeEnabled={readOnly} initialData={{ elements: canvas.elements, files: canvas.files as any, appState: { viewBackgroundColor: '#ffffff' }, scrollToContent: true }}
          onChange={(els) => { if (els.length !== canvas.elements.length) changed.current = true; }}
          UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false, toggleTheme: false, changeViewBackgroundColor: false }, tools: { image: true } }} />
      </div>
    </div>, document.body);
}
