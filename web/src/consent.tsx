import { useEffect, useRef, useState } from 'react';
import { post, qc, errText } from './api';
import { Icon, Modal, toast } from './ui';

/* Signed consent: the patient reads the wording and signs on the tablet, or staff confirm the paper form is filed.
   The saved image holds the wording, the signature, the name and the time together, so the record shows what was agreed. */

export const procedureConsentText = (name: string, what: string) =>
  `I, ${name}, agree to have ${what} at this clinic. The doctor has explained what it involves, the results I can expect, the number of sessions, and the possible side effects, such as redness, swelling, irritation, a change in skin colour and, rarely, infection or scarring. Results differ from person to person and are not guaranteed. I have been able to ask questions. I agree to follow the aftercare advice, and I may stop the treatment at any time.`;
export const photoConsentText = (name: string) =>
  `I, ${name}, agree that this clinic may take photos of the treated area to record my treatment and see how it is working. The photos stay in my record at this clinic, are seen only by clinic staff, and are not shared or published without my separate written permission. I may withdraw this consent at any time; photos already taken stay in my record.`;

const shortDay = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });

/** How a consent was given, next to its chip: a signature on the tablet is a link that opens the signed page. */
export function ConsentNote({ c }: { c: { grantedAt: string; by: string; how?: string; documentId?: string } }) {
  if (c.documentId) return <a className="text-xs font-semibold text-clay underline" href={`/api/documents/${c.documentId}/file`} target="_blank" rel="noreferrer">Signed {shortDay(c.grantedAt)}{c.by ? ` · ${c.by}` : ''}</a>;
  return <span className="text-xs text-muted">{c.grantedAt ? `${c.how ?? 'recorded'} · ${c.by} · ${new Date(c.grantedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}` : c.how}</span>;
}

/** A plain signature pad: draw with a finger, stylus or mouse. Calls onInk(true) after the first stroke. */
function SignaturePad({ pad, onInk }: { pad: React.RefObject<HTMLCanvasElement | null>; onInk: (v: boolean) => void }) {
  const drawing = useRef(false);
  useEffect(() => {
    const c = pad.current; if (!c) return;
    // offsetWidth ignores the dialog's opening animation; strokes are drawn in the canvas's own pixels
    const k = window.devicePixelRatio || 1;
    c.width = Math.round(c.offsetWidth * k); c.height = Math.round(c.offsetHeight * k);
    const g = c.getContext('2d')!; g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.lineWidth = 2.2 * k; g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = '#111';
  }, [pad]);
  const at = (e: React.PointerEvent<HTMLCanvasElement>) => { const c = e.currentTarget; const r = c.getBoundingClientRect(); return [(e.clientX - r.left) * (c.width / r.width), (e.clientY - r.top) * (c.height / r.height)] as const; };
  return (
    <canvas ref={pad} aria-label="Signature pad: the patient signs here" className="block h-40 w-full cursor-crosshair rounded-[10px] border border-line bg-white" style={{ touchAction: 'none' }}
      onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); drawing.current = true; const g = e.currentTarget.getContext('2d')!; const [x, y] = at(e); g.beginPath(); g.moveTo(x, y); g.lineTo(x + 0.1, y + 0.1); g.stroke(); onInk(true); }}
      onPointerMove={(e) => { if (!drawing.current) return; const g = e.currentTarget.getContext('2d')!; const [x, y] = at(e); g.lineTo(x, y); g.stroke(); }}
      onPointerUp={() => { drawing.current = false; }} onPointerCancel={() => { drawing.current = false; }} />
  );
}

/** One page: title, the wording, the signature, then who signed and when. */
function signedPage(title: string, text: string, sig: HTMLCanvasElement, name: string): string {
  const W = 1200, P = 60, LH = 34;
  const m = document.createElement('canvas').getContext('2d')!; m.font = '24px sans-serif';
  const lines: string[] = []; let line = '';
  for (const w of text.split(' ')) { const t = line ? `${line} ${w}` : w; if (m.measureText(t).width > W - 2 * P && line) { lines.push(line); line = w; } else line = t; }
  if (line) lines.push(line);
  const sigH = Math.round(sig.height * ((W - 2 * P) / sig.width));
  const c = document.createElement('canvas'); c.width = W; c.height = P + 50 + lines.length * LH + 30 + sigH + 90;
  const g = c.getContext('2d')!; g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.fillStyle = '#111';
  g.font = 'bold 30px sans-serif'; g.fillText(title, P, P + 10);
  g.font = '24px sans-serif'; lines.forEach((l, i) => g.fillText(l, P, P + 60 + i * LH));
  const y = P + 50 + lines.length * LH + 30;
  g.drawImage(sig, P, y, W - 2 * P, sigH); g.strokeStyle = '#999'; g.strokeRect(P, y, W - 2 * P, sigH);
  g.font = '22px sans-serif'; g.fillText(`Signed by ${name} on ${new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' })}`, P, y + sigH + 45);
  return c.toDataURL('image/png');
}

/**
 * The consent pop-up: the wording on top, then the patient signs here or staff confirm the paper form.
 * onDone gets the signed page's document id, or nothing for a paper form.
 */
export function ConsentForm({ title, text, patient, procedureSessionId, okLabel, onClose, onDone }: {
  title: string; text: string; patient: { id: string; fullName: string }; procedureSessionId?: string; okLabel: string;
  onClose: () => void; onDone: (documentId?: string) => void;
}) {
  const [how, setHow] = useState<'sign' | 'paper'>('sign'); const [ink, setInk] = useState(false); const [saving, setSaving] = useState(false);
  const pad = useRef<HTMLCanvasElement>(null);
  const clear = () => { const c = pad.current; if (!c) return; const g = c.getContext('2d')!; g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); setInk(false); };
  const save = async () => {
    if (!pad.current || !ink) return;
    setSaving(true);
    try {
      const d: any = await post('/documents', { patientId: patient.id, kind: 'consent', procedureSessionId, title: `${title} · signed ${shortDay(new Date().toISOString())}`, mime: 'image/png', dataBase64: signedPage(title, text, pad.current, patient.fullName) });
      qc.invalidateQueries({ queryKey: ['documents', patient.id] });
      onDone(d.id);
    } catch (e) { toast(errText(e), 'err'); } finally { setSaving(false); }
  };
  return (
    <Modal title={title} subtitle={`${patient.fullName} · asked once`} onClose={onClose} width="max-w-lg" dirty={ink}>
      <div className="mb-3 flex gap-2">
        <button className={`btn btn-sm ${how === 'sign' ? 'btn-primary' : ''}`} aria-pressed={how === 'sign'} onClick={() => setHow('sign')}><Icon name="edit" />Patient signs here</button>
        <button className={`btn btn-sm ${how === 'paper' ? 'btn-primary' : ''}`} aria-pressed={how === 'paper'} onClick={() => setHow('paper')}>Paper form filed</button>
      </div>
      {how === 'sign' ? (<>
        <p className="mb-2 text-sm text-ink-2">Hand the tablet to the patient. They read this and sign in the box with a finger.</p>
        <div className="mb-3 max-h-44 overflow-y-auto rounded-[10px] border border-line bg-surface-2 p-3 text-[13.5px] leading-relaxed text-ink">{text}</div>
        <SignaturePad pad={pad} onInk={setInk} />
        <div className="modal-foot">
          <button className="btn btn-ghost" disabled={!ink || saving} onClick={clear}>Clear</button>
          <button className="btn btn-primary" disabled={!ink || saving} onClick={save}><Icon name="check" />{saving ? 'Saving…' : okLabel}</button>
        </div>
      </>) : (<>
        <p className="text-sm text-ink-2">Go on only after the patient has signed the paper consent form and it is filed. It is recorded on the patient and not asked again.</p>
        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onClose}>Not yet</button>
          <button className="btn btn-primary" onClick={() => onDone()}><Icon name="check" />Yes, signed and filed</button>
        </div>
      </>)}
    </Modal>
  );
}
