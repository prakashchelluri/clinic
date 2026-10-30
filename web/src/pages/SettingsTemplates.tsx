import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, get, patch, post, qc, errText } from '../api';
import { Chip, Empty, Icon, Modal, MoreMenu, NumInput, MoneyInput, Segmented, Skeleton, ask, money, toPaise, toast } from '../ui';
import { KINDS, norm, type Linked, type Tmpl, type TmplKind } from '../templates';

const FREQ = ['1-0-0', '0-0-1', '1-0-1', '1-1-1', 'at night', 'once daily', 'twice daily', 'alternate days', 'weekly', 'SOS'];
type Row = { name: string; medicineId?: string | null; dose?: string | null; frequency?: string | null; durationDays?: number | null; instructions?: string | null };

/** Type, press Enter: a short list of words, with suggestions. */
function Words({ value, onChange, options = [], label, placeholder }: { value: string[]; onChange: (v: string[]) => void; options?: string[]; label: string; placeholder: string }) {
  const [draft, setDraft] = useState(''); const id = `w-${label.replace(/\W/g, '')}`;
  const add = (x: string) => { const v = x.trim(); if (v && !value.some((y) => norm(y) === norm(v))) onChange([...value, v]); setDraft(''); };
  return (
    <div>
      <div className="mb-1 flex flex-wrap gap-1.5">{value.map((w) => <span key={w} className="toggle-opt on !py-1">{w}<button type="button" aria-label={`Remove ${w}`} className="ml-1" onClick={() => onChange(value.filter((x) => x !== w))}><Icon name="x" className="inline h-3 w-3" /></button></span>)}</div>
      <input aria-label={label} list={id} className="input !py-2" maxLength={120} placeholder={placeholder} value={draft} onChange={(e) => { if (options.includes(e.target.value)) add(e.target.value); else setDraft(e.target.value); }} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(draft); } }} onBlur={() => draft && add(draft)} />
      <datalist id={id}>{options.filter((o) => !value.includes(o)).map((o) => <option key={o} value={o} />)}</datalist>
    </div>
  );
}

function Editor({ kind, cfg, initial, onClose }: { kind: TmplKind; cfg: any; initial: Tmpl | null; onClose: () => void }) {
  const meta = KINDS.find((k) => k.kind === kind)!;
  const [name, setName] = useState(initial?.name ?? '');
  const [linked, setLinked] = useState<Linked>(initial?.linked ?? {});
  const [mode, setMode] = useState<'chip' | 'auto'>(initial?.mode ?? 'chip');
  const p = initial?.payload ?? {};
  const [items, setItems] = useState<Row[]>(p.items ?? [{ name: '' }]);
  const [questions, setQuestions] = useState<{ q: string; detail?: string }[]>(p.questions ?? [{ q: '' }]);
  const [chips, setChips] = useState<string[]>(p.chips ?? []);
  const [lines, setLines] = useState<string>((p.lines ?? []).join('\n'));
  const [tests, setTests] = useState<{ name: string; days?: number }[]>(p.tests ?? []);
  const [proc, setProc] = useState<{ procedureId: string; sittings: string; intervalDays: string; price: string }>({ procedureId: p.procedureId ?? cfg.procedures?.[0]?.id ?? '', sittings: String(p.sittings ?? ''), intervalDays: String(p.intervalDays ?? ''), price: p.pricePaise ? String(p.pricePaise / 100) : '' });
  const fields: any[] = cfg.forms?.find((f: any) => f.key === 'encounter')?.schema?.sections?.flatMap((s: any) => s.fields) ?? [];
  const dxOptions: string[] = fields.find((f) => f.type === 'diagnoses')?.options ?? [];
  const morph: string[] = fields.find((f) => f.key === 'morphology')?.options ?? [];
  const meds: any[] = cfg.medicines ?? [];
  const payload = (): any => {
    if (kind === 'medicine') return { items: items.filter((i) => i.name.trim()).map((i) => ({ name: i.name.trim(), medicineId: i.medicineId ?? null, dose: i.dose || null, frequency: i.frequency || null, durationDays: i.durationDays || null, instructions: i.instructions || null })) };
    if (kind === 'complaint') return { questions: questions.filter((q) => q.q.trim()).map((q) => ({ q: q.q.trim(), ...(q.detail?.trim() ? { detail: q.detail.trim() } : {}) })) };
    if (kind === 'finding') return { chips };
    if (kind === 'advice') return { lines: lines.split('\n').map((x) => x.trim()).filter(Boolean) };
    if (kind === 'tests') return { tests };
    return { procedureId: proc.procedureId, ...(proc.sittings ? { sittings: Number(proc.sittings) } : {}), ...(proc.intervalDays ? { intervalDays: Number(proc.intervalDays) } : {}), ...(proc.price ? { pricePaise: toPaise(proc.price) } : {}) };
  };
  const empty = (() => { const x = payload(); return kind === 'procedure' ? !x.procedureId : !Object.values(x)[0] || (Object.values(x)[0] as any[]).length === 0; })();
  const blocker = name.trim().length < 2 ? 'Give it a name of at least 2 letters' : kind === 'complaint' ? '' : empty ? { medicine: 'Add at least one medicine', finding: 'Pick at least one finding', advice: 'Write at least one advice line', tests: 'Add at least one test', procedure: 'Pick a procedure' }[kind as string] ?? '' : '';
  const save = useMutation({
    mutationFn: () => { const body = { name: name.trim(), linked, mode, payload: payload() }; return initial ? patch(`/templates/${initial.id}`, body) : post('/templates', { kind, ...body }); },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['templates'] }); toast(initial ? 'Saved' : `Added “${name.trim()}”`); onClose(); },
    onError: (e: any) => toast(e?.body?.code === 'DUPLICATE' ? `There is already a ${meta.one} with that name.` : errText(e), 'err'),
  });
  const upd = (k: number, x: Partial<Row>) => setItems(items.map((r, j) => (j === k ? { ...r, ...x } : r)));
  return (
    <Modal title={initial ? `Edit ${meta.one}` : `New ${meta.one}`} subtitle={meta.hint} onClose={onClose} width="max-w-3xl">
      <div className="space-y-5">
        <div><label className="label" htmlFor="t-name">{kind === 'complaint' ? 'Complaint (the check-in chip)' : 'Name'}</label><input id="t-name" autoFocus className="input" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === 'medicine' ? 'e.g. Rashes · itch relief' : kind === 'complaint' ? 'e.g. Hair fall' : ''} /></div>

        {kind === 'medicine' && <div>
          <span className="label">Medicines</span>
          <datalist id="t-meds">{meds.map((m: any) => <option key={m.id} value={m.name} />)}</datalist><datalist id="t-freq">{FREQ.map((x) => <option key={x} value={x} />)}</datalist>
          <div className="overflow-x-auto"><div className="min-w-[640px] space-y-1.5">
            <div className="grid grid-cols-[1.6fr_70px_100px_60px_1.2fr_32px] gap-1.5 text-[11px] uppercase tracking-wider text-muted"><span>Medicine</span><span>Dose</span><span>When</span><span>Days</span><span>How</span><span /></div>
            {items.map((i, k) => (
              <div key={k} className="grid grid-cols-[1.6fr_70px_100px_60px_1.2fr_32px] items-center gap-1.5">
                <input aria-label="Medicine" list="t-meds" className="input !py-1.5 text-sm font-semibold" maxLength={120} value={i.name} onChange={(e) => { const m = meds.find((x: any) => x.name === e.target.value); upd(k, { name: e.target.value, medicineId: m?.id ?? null, ...(m ? { dose: m.defaults?.dose ?? null, frequency: m.defaults?.frequency ?? null, durationDays: m.defaults?.durationDays ?? null, instructions: m.defaults?.instructions ?? null } : {}) }); }} />
                <input aria-label="Dose" className="input !py-1.5 text-sm" maxLength={30} value={i.dose ?? ''} onChange={(e) => upd(k, { dose: e.target.value })} />
                <input aria-label="When" list="t-freq" className="input !py-1.5 text-sm" maxLength={40} value={i.frequency ?? ''} onChange={(e) => upd(k, { frequency: e.target.value })} />
                <NumInput aria-label="Days" max={365} className="input !py-1.5 text-sm" value={i.durationDays ?? ''} onChange={(e) => upd(k, { durationDays: e.target.value ? Number(e.target.value) : null })} />
                <input aria-label="How" className="input !py-1.5 text-sm" maxLength={200} value={i.instructions ?? ''} onChange={(e) => upd(k, { instructions: e.target.value })} />
                <button type="button" className="btn btn-ghost btn-icon !h-8 !w-8" aria-label="Remove medicine" disabled={items.length === 1} onClick={() => setItems(items.filter((_, j) => j !== k))}><Icon name="x" className="h-3.5 w-3.5" /></button>
              </div>))}
          </div></div>
          <button type="button" className="btn btn-sm mt-2" onClick={() => setItems([...items, { name: '' }])}><Icon name="plus" className="h-3.5 w-3.5" />Another medicine</button>
        </div>}

        {kind === 'complaint' && <div>
          <span className="label">Questions for the junior doctor</span>
          <div className="mb-2 text-xs text-muted">She taps Yes or No. If a Yes needs one detail, write what to ask (for example “Which cream, how long”).</div>
          <div className="space-y-1.5">{questions.map((q, k) => (
            <div key={k} className="grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_32px] items-center gap-1.5">
              <input aria-label={`Question ${k + 1}`} className="input !py-1.5 text-sm" maxLength={120} placeholder="Itching worse at night?" value={q.q} onChange={(e) => setQuestions(questions.map((x, j) => (j === k ? { ...x, q: e.target.value } : x)))} />
              <input aria-label={`Detail to ask for question ${k + 1}`} className="input !py-1.5 text-sm" maxLength={80} placeholder="If Yes, ask for… (optional)" value={q.detail ?? ''} onChange={(e) => setQuestions(questions.map((x, j) => (j === k ? { ...x, detail: e.target.value } : x)))} />
              <button type="button" className="btn btn-ghost btn-icon !h-8 !w-8" aria-label="Remove question" onClick={() => setQuestions(questions.filter((_, j) => j !== k))}><Icon name="x" className="h-3.5 w-3.5" /></button>
            </div>))}</div>
          <button type="button" className="btn btn-sm mt-2" disabled={questions.length >= 30} onClick={() => setQuestions([...questions, { q: '' }])}><Icon name="plus" className="h-3.5 w-3.5" />Another question</button>
        </div>}

        {kind === 'finding' && <div><span className="label">Findings</span><Words label="Findings" value={chips} onChange={setChips} options={morph} placeholder="Type a finding, press Enter" /><div className="mt-1 text-xs text-muted">Only findings that are on the consultation form are added to the note.</div></div>}
        {kind === 'advice' && <div><label className="label" htmlFor="t-lines">Advice, one line each</label><textarea id="t-lines" className="input min-h-28" maxLength={2000} value={lines} onChange={(e) => setLines(e.target.value)} placeholder={'Keep the area dry\nDon’t share towels'} /></div>}
        {kind === 'tests' && <div>
          <span className="label">Tests</span>
          <Words label="Tests" value={tests.map((t) => t.name)} onChange={(v) => setTests(v.map((n) => tests.find((t) => t.name === n) ?? { name: n }))} options={['CBC', 'LFT', 'RFT', 'TSH', 'HbA1c', 'FBS / PPBS', 'Lipid profile', 'Vitamin D', 'Vitamin B12', 'Serum ferritin', 'KOH mount', 'Skin biopsy', 'Patch test', 'ANA']} placeholder="Type a test, press Enter" />
          <div className="mt-1 text-xs text-muted">A test that takes 3 days or more (biopsy, patch test) is put in an order of its own, so it never holds the quick ones back.</div>
        </div>}
        {kind === 'procedure' && <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="col-span-2"><label className="label" htmlFor="t-proc">Procedure</label><select id="t-proc" className="input" value={proc.procedureId} onChange={(e) => { const x = cfg.procedures.find((y: any) => y.id === e.target.value); setProc({ ...proc, procedureId: e.target.value, sittings: proc.sittings || String(x?.typicalSittings ?? ''), price: proc.price || (x?.pricePaise ? String(x.pricePaise / 100) : '') }); }}>{cfg.procedures.map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></div>
          <div><label className="label" htmlFor="t-sit">Sittings</label><NumInput id="t-sit" max={60} className="input" value={proc.sittings} onChange={(e) => setProc({ ...proc, sittings: e.target.value })} /></div>
          <div><label className="label" htmlFor="t-int">Every (days)</label><NumInput id="t-int" max={365} className="input" value={proc.intervalDays} onChange={(e) => setProc({ ...proc, intervalDays: e.target.value })} /></div>
          <div><label className="label">Package price</label><MoneyInput value={proc.price} onChange={(v) => setProc({ ...proc, price: v })} /></div>
        </div>}

        <div className="rounded-2xl bg-paper px-4 py-3.5 space-y-3">
          <div><span className="label">{kind === 'complaint' ? 'Also counts as (other words for this complaint)' : 'Suggest when the complaint is'}</span><Words label="Complaints" value={linked.complaints ?? []} onChange={(v) => setLinked({ ...linked, complaints: v })} options={(qc.getQueryData<Tmpl[]>(['templates', 'complaint']) ?? []).map((t) => t.name)} placeholder="Rashes, Itching… press Enter" /></div>
          {kind !== 'complaint' && <div><span className="label">or the diagnosis is</span><Words label="Diagnoses" value={linked.diagnoses ?? []} onChange={(v) => setLinked({ ...linked, diagnoses: v })} options={dxOptions} placeholder="Scabies, Acne vulgaris… press Enter" /></div>}
          {kind !== 'complaint' && <div className="flex flex-wrap items-center gap-2"><span className="label !mb-0 mr-1">When suggested</span>
            <button type="button" aria-pressed={mode === 'chip'} className={`toggle-opt ${mode === 'chip' ? 'on' : ''}`} onClick={() => setMode('chip')}>Show as a chip</button>
            <button type="button" aria-pressed={mode === 'auto'} className={`toggle-opt ${mode === 'auto' ? 'on' : ''}`} onClick={() => setMode('auto')}>Add for the doctor</button>
            <span className="text-xs text-muted">She can remove any line.</span></div>}
        </div>
        <div className="modal-foot"><span className="mr-auto text-xs text-muted" role="status">{blocker}</span><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={save.isPending || !!blocker} onClick={() => save.mutate()}><Icon name="check" />Save {meta.one}</button></div>
      </div>
    </Modal>
  );
}

const n = (x: number, one: string) => `${x} ${one}${x === 1 ? '' : 's'}`;
const summary = (t: Tmpl) => t.kind === 'medicine' ? n(t.payload.items?.length ?? 0, 'medicine') : t.kind === 'complaint' ? n(t.payload.questions?.length ?? 0, 'question') : t.kind === 'finding' ? n(t.payload.chips?.length ?? 0, 'finding') : t.kind === 'advice' ? n(t.payload.lines?.length ?? 0, 'line') : t.kind === 'tests' ? (t.payload.tests ?? []).map((x: any) => x.name).join(', ') : `${t.payload.sittings ?? '?'} sittings${t.payload.pricePaise ? ` · ${money(t.payload.pricePaise)}` : ''}`;

/** Settings → Templates: every kind of set the doctors use, linked to complaints and diagnoses. */
export function TemplatesTab({ cfg }: { cfg: any }) {
  const [kind, setKind] = useState<TmplKind | 'protocol'>('medicine');
  const [edit, setEdit] = useState<{ t: Tmpl | null } | null>(null);
  const all = useQuery<Tmpl[]>({ queryKey: ['templates', 'settings'], queryFn: () => get('/templates?all=1') });
  const protos = useQuery<any[]>({ queryKey: ['rx-templates', 'settings'], queryFn: () => get('/rx-templates') });
  const [q, setQ] = useState('');
  const refresh = () => { qc.invalidateQueries({ queryKey: ['templates'] }); qc.invalidateQueries({ queryKey: ['rx-templates'] }); };
  const upd = useMutation({ mutationFn: ({ id, ...b }: any) => patch(`/templates/${id}`, b), onSuccess: refresh, onError: (e) => toast(errText(e), 'err') });
  const del = async (t: Tmpl) => { const a = await ask({ title: `Delete “${t.name}”?`, body: 'Notes already written keep what they have. Retire it instead if you may want it back.', confirmLabel: 'Delete', cancelLabel: 'Keep it' }); if (a) { try { await api('DELETE', `/templates/${t.id}`); refresh(); toast('Deleted', 'info'); } catch (e) { toast(errText(e), 'err'); } } };
  const rows = (all.data ?? []).filter((t) => t.kind === kind && (!q || t.name.toLowerCase().includes(q.toLowerCase())));
  const count = (k: string) => (k === 'protocol' ? protos.data?.length : (all.data ?? []).filter((t) => t.kind === k && t.active && !t.draft).length);
  const waiting = (all.data ?? []).filter((t) => t.draft);
  const linkChips = (l: Linked) => <>{(l.complaints ?? []).map((c) => <Chip key={'c' + c}>{c}</Chip>)}{(l.diagnoses ?? []).map((d) => <Chip key={'d' + d} tone="clay">{d}</Chip>)}{!(l.complaints?.length || l.diagnoses?.length) && <span className="text-xs text-muted">not linked yet</span>}</>;
  const editProto = async (t: any) => {
    const r = await ask({ title: `Suggest “${t.name}” for…`, body: 'Type the diagnoses this protocol belongs to, separated by commas. Complaints can be added the same way after a semicolon: “Acne vulgaris, Rosacea; Acne”.', confirmLabel: 'Save', field: { label: 'Diagnoses; complaints', initial: `${(t.linked?.diagnoses ?? []).join(', ')}${t.linked?.complaints?.length ? `; ${t.linked.complaints.join(', ')}` : ''}`, maxLength: 400 } });
    if (!r) return; const [d, c] = r.value.split(';'); const split = (x?: string) => (x ?? '').split(',').map((y) => y.trim()).filter(Boolean).slice(0, 20);
    try { await patch(`/rx-templates/${t.id}`, { linked: { diagnoses: split(d), complaints: split(c) } }); refresh(); toast('Saved'); } catch (e) { toast(errText(e), 'err'); }
  };
  return (
    <div className="space-y-4">
      <div className="text-sm text-muted">Small sets the doctors use, suggested by the complaint or diagnosis they are linked to. One tap adds a set and nothing is added twice. Sets a doctor saves from a visit wait here for your approval.</div>
      {waiting.length > 0 && <div className="card !p-4 !bg-[#FFF6DD]" role="status"><b className="text-sm">{waiting.length} saved by doctors, waiting for you</b>
        {waiting.map((t) => <div key={t.id} className="mt-2 flex flex-wrap items-center gap-2 text-sm"><Chip tone="amber">{KINDS.find((k) => k.kind === t.kind)?.one}</Chip><b>{t.name}</b><span className="text-xs text-muted">{summary(t)}</span><span className="ml-auto flex gap-1.5"><button className="btn btn-sm" onClick={() => { setKind(t.kind); setEdit({ t }); }}>Review</button><button className="btn btn-sm btn-primary" onClick={() => upd.mutate({ id: t.id, draft: false })}>Approve</button></span></div>)}</div>}
      <div className="overflow-x-auto"><Segmented<string> value={kind} onChange={(k) => { setKind(k as any); setQ(''); }} options={[{ value: 'protocol', label: 'Full protocols', count: count('protocol') }, ...KINDS.map((k) => ({ value: k.kind as string, label: k.label, count: count(k.kind) }))]} /></div>
      {kind === 'protocol' ? (
        <div className="card !p-0">
          <div className="border-b border-line/70 px-4 py-3 text-xs text-muted">A protocol is a whole saved note: complaint, findings, diagnosis, medicines, advice and review. Doctors make them with “Save as template” in a consultation. Link each to its diagnoses so it is suggested.</div>
          {protos.isLoading ? <Skeleton rows={3} /> : (protos.data ?? []).length === 0 ? <Empty icon="list" title="No protocols yet" hint="A doctor makes the first one with Save as template at the end of a consultation." /> :
            (protos.data ?? []).map((t) => <div key={t.id} className="flex flex-wrap items-center gap-2 border-t border-line/70 px-4 py-3 first:border-t-0"><div className="min-w-0 flex-1"><b>{t.name}</b><div className="mt-1 flex flex-wrap gap-1">{linkChips(t.linked ?? {})}</div></div><span className="text-xs text-muted">{t.uses}×</span><button className="btn btn-sm" onClick={() => editProto(t)}><Icon name="edit" className="h-3.5 w-3.5" />Link</button></div>)}
        </div>
      ) : (
        <div className="card !p-0">
          <div className="flex items-center gap-2 border-b border-line/70 px-4 py-3"><input aria-label="Search" className="input !py-2 max-w-xs" placeholder={`Search ${KINDS.find((k) => k.kind === kind)!.label.toLowerCase()}`} value={q} onChange={(e) => setQ(e.target.value)} /><button className="btn btn-primary ml-auto" onClick={() => setEdit({ t: null })}><Icon name="plus" />New {KINDS.find((k) => k.kind === kind)!.one}</button></div>
          {all.isLoading ? <Skeleton rows={4} /> : rows.length === 0 ? <Empty icon="list" title={q ? 'Nothing by that name' : `No ${KINDS.find((k) => k.kind === kind)!.label.toLowerCase()} yet`} hint={q ? undefined : KINDS.find((k) => k.kind === kind)!.hint} /> :
            rows.map((t) => (
              <div key={t.id} className={`flex flex-wrap items-center gap-2 border-t border-line/70 px-4 py-3 first:border-t-0 ${t.active ? '' : 'opacity-55'}`}>
                <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><b>{t.name}</b>{t.mode === 'auto' && <Chip tone="sky">adds itself</Chip>}{t.draft && <Chip tone="amber">waiting for approval</Chip>}{!t.active && <Chip>retired</Chip>}<span className="text-xs text-muted">{summary(t)}</span></div>
                  <div className="mt-1 flex flex-wrap gap-1">{linkChips(t.linked)}</div></div>
                <span className="text-xs text-muted">{t.uses}×</span>
                <button className="btn btn-sm" onClick={() => setEdit({ t })}><Icon name="edit" className="h-3.5 w-3.5" />Edit</button>
                <MoreMenu items={[{ label: 'Approve', hidden: !t.draft, onClick: () => upd.mutate({ id: t.id, draft: false }) }, { label: t.active ? 'Retire (stop suggesting)' : 'Bring back', onClick: () => upd.mutate({ id: t.id, active: !t.active }) }, { label: 'Delete', danger: true, onClick: () => del(t) }]} />
              </div>))}
        </div>
      )}
      {edit && kind !== 'protocol' && <Editor key={edit.t?.id ?? 'new'} kind={kind} cfg={cfg} initial={edit.t} onClose={() => setEdit(null)} />}
    </div>
  );
}
