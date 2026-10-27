import { useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Icon, Modal } from './ui';
import { PrintRx } from './pages/PrintRx';

type Doc = { title: string; rx?: string; html?: string };
let current: Doc | null = null; const subs = new Set<() => void>();
const set = (d: Doc | null) => { current = d; subs.forEach((s) => s()); };

/** Show a document in a popup with a Print button: a prescription by encounter id (rx) or ready HTML (html). Prints only the document, not the app around it. */
export const openPrint = (d: Doc) => set(d);

export function PrintHost() {
  const d = useSyncExternalStore((cb) => { subs.add(cb); return () => subs.delete(cb); }, () => current);
  const frame = useRef<HTMLIFrameElement>(null);
  if (!d) return null;
  const print = () => {
    if (d.html) { frame.current?.contentWindow?.focus(); frame.current?.contentWindow?.print(); return; }
    // A5 paper just for this print, and the app itself hidden (see .printing-doc in index.css)
    const st = document.createElement('style'); st.textContent = '@page { size: A5; margin: 8mm }'; document.head.appendChild(st);
    document.body.classList.add('printing-doc');
    window.addEventListener('afterprint', () => { st.remove(); document.body.classList.remove('printing-doc'); }, { once: true });
    window.print();
  };
  return (
    <Modal title={d.title} onClose={() => set(null)} width="max-w-2xl">
      {d.html
        ? <iframe ref={frame} title={d.title} srcDoc={d.html} className="block w-full rounded-xl border border-line bg-white" style={{ height: 'min(68vh, 760px)' }} />
        : <div className="overflow-auto rounded-xl border border-line bg-[#EFEDE8] p-3" style={{ maxHeight: 'min(68vh, 760px)' }}><div className="mx-auto w-fit shadow-md"><PrintRx id={d.rx} embed /></div></div>}
      {d.rx && createPortal(<div id="print-area" className="hidden"><PrintRx id={d.rx} embed /></div>, document.body)}
      <div className="modal-foot"><button className="btn btn-ghost" onClick={() => set(null)}>Close</button><button className="btn btn-primary" onClick={print}><Icon name="print" />Print</button></div>
    </Modal>
  );
}
