import { useMutation } from '@tanstack/react-query';
import { post, del, errText, qc } from './api';
import { Icon, toast, ask } from './ui';

/** A small picture printed on paper: the clinic's logo or a doctor's signature. PNG or JPG, up to 1 MB; replace or remove any time. */
export function PictureUpload({ url, uploadTo, label, hint, empty, wide, onChanged }: { url: string | null | undefined; uploadTo: string; label: string; hint: string; empty: string; wide?: boolean; onChanged?: () => void }) {
  const done = () => { qc.invalidateQueries({ queryKey: ['config'] }); onChanged?.(); };
  const up = useMutation({
    mutationFn: async (f: File) => {
      if (!['image/png', 'image/jpeg'].includes(f.type)) throw new Error('TYPE');
      if (f.size > 1024 * 1024) throw new Error('TOO_LARGE');
      const dataBase64 = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(f); });
      return post(uploadTo, { mime: f.type, dataBase64 });
    },
    onSuccess: () => { toast(`${label} saved`); done(); },
    onError: (e: any) => toast(e?.message === 'TOO_LARGE' || e?.body?.code === 'TOO_LARGE' ? 'Keep the picture under 1 MB' : e?.message === 'TYPE' ? 'Use a PNG or JPG picture' : errText(e), 'err'),
  });
  const rm = useMutation({ mutationFn: () => del(uploadTo), onSuccess: () => { toast(`${label} removed`, 'info'); done(); }, onError: (e: any) => toast(errText(e), 'err') });
  const askRemove = async () => { if (await ask({ title: `Remove the ${label.toLowerCase()}?`, body: 'Prints from now on go without it. You can upload one again any time.', confirmLabel: 'Remove' })) rm.mutate(); };
  const busy = up.isPending || rm.isPending;
  return (
    <div className="flex flex-wrap items-center gap-4">
      <span className={`grid shrink-0 place-items-center overflow-hidden rounded-lg border border-dashed border-line-2 bg-white ${wide ? 'h-16 w-48' : 'h-16 w-16'}`}>
        {url ? <img src={url} alt={label} className="max-h-full max-w-full object-contain" /> : <span className="px-2 text-center text-[11.5px] text-muted">{empty}</span>}
      </span>
      <div className="space-y-1.5">
        <div className="flex flex-wrap gap-2">
          <label className={`btn btn-sm cursor-pointer ${busy ? 'pointer-events-none opacity-50' : ''}`}><Icon name="plus" className="h-3.5 w-3.5" />{up.isPending ? 'Uploading…' : url ? 'Replace' : 'Upload'}
            <input type="file" className="sr-only" aria-label={`Upload ${label.toLowerCase()}`} accept="image/png,image/jpeg" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) up.mutate(f); }} /></label>
          {url && <button type="button" className="btn btn-sm btn-ghost text-rose" disabled={busy} onClick={askRemove}>Remove</button>}
        </div>
        <div className="text-xs text-muted">{hint}</div>
      </div>
    </div>
  );
}
