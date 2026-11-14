import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { post, patch, api, errText, qc } from './api';
import { Drawer, Icon, Tabs, toast, ask, NumInput, MoneyInput, toPaise } from './ui';
import { ALLERGY_CLASSES } from './rxSafety';

/** A medicine as Inventory keeps it: what it is and costs, what the doctor's pad fills in, and the leaflet the patient gets.
 *  One drawer, three tabs; the stock itself (batches, movements) is the medicine's own page in Inventory. */
export const blankMedicine = () => ({ name: '', form: 'tab', scheduleClass: 'H', defaults: {}, packSize: 10, reorderLevel: 5, gstBp: 1200 });
const FORMS: [string, string][] = [['tab', 'Tablet'], ['cap', 'Capsule'], ['cream', 'Cream'], ['gel', 'Gel'], ['lotion', 'Lotion'], ['ointment', 'Ointment'], ['syrup', 'Syrup'], ['inj', 'Injection'], ['soap', 'Soap']];
const SAY: Record<string, string> = { DUPLICATE: 'A medicine with this name is already in the list.' };
type T = 'details' | 'rx' | 'leaflet';

export function MedicineDrawer({ value, onClose, onSaved }: { value: any; onClose: () => void; onSaved?: (m: any) => void }) {
  const [edit, setEdit] = useState<any>(() => ({ ...value, defaults: value.defaults ?? {} }));
  const [tab, setTab] = useState<T>('details');
  const refresh = () => ['config', 'stock', 'pharmacy'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  const save = useMutation({
    mutationFn: () => {
      const b: any = { name: edit.name.trim(), form: edit.form, scheduleClass: edit.scheduleClass, generic: edit.generic?.trim() || null, allergyClass: edit.allergyClass?.trim().toLowerCase() || null, defaults: edit.defaults,
        mrpPaise: edit.mrp !== undefined ? toPaise(edit.mrp || '0') : edit.mrpPaise ?? 0, gstBp: edit.gstBp ?? 1200, hsn: edit.hsn || null, leafletUrl: edit.leafletUrl?.trim() || null, packSize: Number(edit.packSize ?? 1), reorderLevel: Number(edit.reorderLevel ?? 0) };
      return edit.id ? patch(`/admin/medicines/${edit.id}`, b) : post('/admin/medicines', b);
    },
    onSuccess: (m: any) => { toast(edit.id ? 'Medicine saved' : 'Medicine added'); refresh(); onSaved?.(m); onClose(); },
    onError: (e: any) => toast(SAY[e?.body?.code] ?? errText(e), 'err'),
  });
  const del = useMutation({ mutationFn: () => api('DELETE', `/admin/medicines/${edit.id}`), onSuccess: () => { toast('Removed', 'info'); refresh(); onClose(); }, onError: () => toast('It is on a prescription or a bill, so it stays. Set low stock to 0 if you no longer keep it.', 'err') });
  const askDelete = async () => { if (await ask({ title: `Remove ${edit.name}?`, body: 'Only a medicine that was never prescribed, sold or stocked can be removed.', confirmLabel: 'Remove', tone: 'danger' })) del.mutate(); };
  const packOk = Number(edit.packSize ?? 1) >= 1;
  const set = (k: string, v: any) => setEdit((p: any) => ({ ...p, [k]: v }));
  const setD = (k: string, v: any) => setEdit((p: any) => ({ ...p, defaults: { ...p.defaults, [k]: v } }));
  const perPack = ['tab', 'cap'].includes(edit.form) ? 'strip' : 'pack';
  return (
    <Drawer title={edit.id ? edit.name || 'Medicine' : 'New medicine'} subtitle={edit.id ? 'What it is, its price, and what the pad fills in' : 'Add it here, then receive a delivery to put it on the shelf'} onClose={onClose} width="max-w-lg">
      <div className="space-y-4">
        <Tabs<T> value={tab} onChange={setTab} options={[{ value: 'details', label: 'Details & price' }, { value: 'rx', label: 'Prescribing' }, { value: 'leaflet', label: 'Leaflet' }]} />
        {tab === 'details' && <div className="space-y-3">
          <div><label className="label" htmlFor="md-name">Name with strength</label><input id="md-name" autoFocus className="input" maxLength={100} placeholder="e.g. Doxycycline 100 mg" value={edit.name} onChange={(e) => set('name', e.target.value)} /></div>
          <div><span className="label">Form</span><div className="flex flex-wrap gap-1">{FORMS.map(([v, l]) => <button key={v} type="button" aria-pressed={edit.form === v} className={`toggle-opt ${edit.form === v ? 'on' : ''}`} onClick={() => set('form', v)}>{l}</button>)}</div></div>
          <div><span className="label">Schedule</span><div className="flex gap-1">{['OTC', 'H', 'H1', 'X'].map((x) => <button key={x} type="button" aria-pressed={edit.scheduleClass === x} className={`toggle-opt ${edit.scheduleClass === x ? 'on' : ''}`} onClick={() => set('scheduleClass', x)}>{x}</button>)}</div></div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div><label className="label" htmlFor="md-mrp">MRP per {perPack} (₹, GST included)</label><MoneyInput id="md-mrp" value={edit.mrp ?? String((edit.mrpPaise ?? 0) / 100 || '')} onChange={(v: string) => set('mrp', v)} /></div>
            <div><label className="label" htmlFor="md-hsn">HSN code</label><input id="md-hsn" className="input" inputMode="numeric" maxLength={8} value={edit.hsn ?? ''} onChange={(e) => set('hsn', e.target.value.replace(/\D/g, ''))} /></div>
            <div><span className="label">GST</span><div className="flex flex-wrap gap-1">{[0, 500, 1200, 1800].map((x) => <button key={x} type="button" aria-pressed={(edit.gstBp ?? 1200) === x} className={`toggle-opt ${(edit.gstBp ?? 1200) === x ? 'on' : ''}`} onClick={() => set('gstBp', x)}>{x / 100}%</button>)}</div></div>
          </div>
          <div className="-mt-1 text-xs text-muted">A delivery with a new MRP updates it here.</div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label" htmlFor="md-pack">{['tab', 'cap'].includes(edit.form) ? `${edit.form === 'cap' ? 'Capsules' : 'Tablets'} per strip` : 'Units per pack'}</label><NumInput id="md-pack" max={1000} className={`input ${packOk ? '' : '!border-rose'}`} value={edit.packSize ?? 1} onChange={(e) => set('packSize', e.target.value)} /></div>
            <div><label className="label" htmlFor="md-low">Low stock below ({perPack}s)</label><NumInput id="md-low" max={100000} className="input" value={edit.reorderLevel ?? 0} onChange={(e) => set('reorderLevel', e.target.value)} /></div>
          </div>
          {!packOk && <div className="text-xs text-rose">At least 1 per {perPack}.</div>}
        </div>}
        {tab === 'rx' && <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label" htmlFor="md-gen">Generic name</label><input id="md-gen" className="input" maxLength={120} placeholder="e.g. amoxicillin + clavulanate" value={edit.generic ?? ''} onChange={(e) => set('generic', e.target.value)} /></div>
            <div><label className="label" htmlFor="md-grp">Drug group (for allergies)</label><input id="md-grp" className="input" maxLength={60} list="allergy-classes" placeholder="e.g. penicillin" value={edit.allergyClass ?? ''} onChange={(e) => set('allergyClass', e.target.value)} />
              <datalist id="allergy-classes">{Object.keys(ALLERGY_CLASSES).map((c) => <option key={c} value={c} />)}</datalist></div>
          </div>
          <div className="-mt-1 text-xs text-muted">The pad checks allergies, pregnancy, the same medicine twice and interactions against the name, the generic and the group.</div>
          <div className="card-title !mt-4">Filled in when the doctor adds it</div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div><label className="label" htmlFor="md-dose">Dose</label><input id="md-dose" className="input" placeholder="1 tab" value={edit.defaults.dose ?? ''} onChange={(e) => setD('dose', e.target.value)} /></div>
            <div><label className="label" htmlFor="md-route">Route</label><input id="md-route" className="input" placeholder="oral" value={edit.defaults.route ?? ''} onChange={(e) => setD('route', e.target.value)} /></div>
            <div><label className="label" htmlFor="md-freq">Frequency</label><input id="md-freq" className="input" placeholder="1-0-1" value={edit.defaults.frequency ?? ''} onChange={(e) => setD('frequency', e.target.value)} /></div>
            <div><label className="label" htmlFor="md-days">Days</label><NumInput id="md-days" max={365} className="input" value={edit.defaults.durationDays ?? ''} onChange={(e) => setD('durationDays', e.target.value ? Number(e.target.value) : undefined)} /></div>
          </div>
          <div><label className="label" htmlFor="md-ins">Instructions</label><input id="md-ins" className="input" placeholder="after food" value={edit.defaults.instructions ?? ''} onChange={(e) => setD('instructions', e.target.value)} /></div>
        </div>}
        {tab === 'leaflet' && <div className="space-y-2">
          <div className="text-sm text-ink-2">A “how to use” sheet sent on WhatsApp with every prescription that has this medicine.</div>
          <LeafletField med={edit} onChange={(leafletUrl) => set('leafletUrl', leafletUrl)} onSaved={refresh} />
        </div>}
        <div className="modal-foot !justify-between">{edit.id ? <button type="button" className="btn btn-ghost text-rose" onClick={askDelete}>Remove</button> : <span />}
          <div className="flex gap-2"><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={save.isPending || !edit.name.trim() || !packOk} onClick={() => save.mutate()}><Icon name="check" />{edit.id ? 'Save' : 'Add medicine'}</button></div></div>
      </div>
    </Drawer>
  );
}

/** The sheet sent to the patient on WhatsApp with the prescription: upload a PDF or picture, or paste a link the clinic already hosts. */
function LeafletField({ med, onChange, onSaved }: { med: any; onChange: (url: string | null) => void; onSaved: () => void }) {
  const upload = useMutation({
    mutationFn: async (f: File) => {
      if (f.size > 5 * 1024 * 1024) throw new Error('TOO_LARGE');
      const dataBase64 = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(f); });
      return post(`/admin/medicines/${med.id}/leaflet`, { mime: f.type, dataBase64 });
    },
    onSuccess: (row: any) => { onChange(row.leafletUrl); toast('Leaflet uploaded'); onSaved(); },
    onError: (e: any) => toast(e?.message === 'TOO_LARGE' ? 'Keep the leaflet under 5 MB' : errText(e), 'err'),
  });
  const isFile = /\/api\/public\/leaflet\//.test(med.leafletUrl ?? '');
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <input className="input min-w-0 flex-1" aria-label="Leaflet link" placeholder="https://… a PDF or page the patient can open" value={isFile ? '' : med.leafletUrl ?? ''} disabled={isFile} onChange={(e) => onChange(e.target.value)} />
        {med.id ? <label className={`btn btn-sm cursor-pointer ${upload.isPending ? 'opacity-50' : ''}`}><Icon name="plus" className="h-3.5 w-3.5" />{upload.isPending ? 'Uploading…' : 'Upload PDF'}<input type="file" className="sr-only" accept="application/pdf,image/jpeg,image/png" disabled={upload.isPending} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) upload.mutate(f); }} /></label>
          : <span className="text-xs text-muted">Add the medicine first to upload a file</span>}
      </div>
      {med.leafletUrl && <div className="flex items-center gap-2 text-xs"><a className="text-sky underline" href={med.leafletUrl} target="_blank" rel="noreferrer">{isFile ? 'Open the uploaded leaflet' : 'Open link'}</a><button type="button" className="btn btn-ghost btn-sm !min-h-6 !px-1.5 text-rose" onClick={() => onChange(null)}>Remove</button></div>}
    </div>
  );
}
