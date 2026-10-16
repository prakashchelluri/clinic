import { useState } from 'react';
import { useNavigate } from 'react-router';
import { post, qc, ApiError } from '../api';
import { Icon } from '../ui';

const DEMO = [
  ['reception@demo.clinic', 'Reception', 'Booking, arrivals, queue, payments'],
  ['owner@demo.clinic', 'Doctor · owner', 'Consult, prescribe, reports, settings'],
  ['assistant@demo.clinic', 'Assistant', 'Intake before the doctor'],
  ['procedures@demo.clinic', 'Coordinator', 'Procedure & follow-up worklists'],
];

export function Login() {
  const nav = useNavigate();
  const [f, setF] = useState({ email: '', password: 'demo1234', tenant: '' });
  const [clinics, setClinics] = useState<{ slug: string; name: string }[] | null>(null);
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async (e?: React.FormEvent, email = f.email, tenant = f.tenant) => {
    e?.preventDefault(); setErr(''); setBusy(true);
    try { await post('/auth/login', { email, password: f.password, tenant: tenant || undefined }); qc.clear(); nav('/queue', { viewTransition: true }); }
    catch (x: any) {
      if (x instanceof ApiError && x.body.code === 'CHOOSE_CLINIC') setClinics(x.body.clinics);
      else setErr('That email or password is not right.');
    } finally { setBusy(false); }
  };
  return (
    <div className="min-h-dvh grid lg:grid-cols-[1.1fr_1fr]">
      <div className="hidden lg:flex flex-col justify-between p-12 text-paper relative overflow-hidden" style={{ background: 'radial-gradient(1200px 600px at 20% 10%, #D97757 0%, #B2532F 45%, #7A3A22 100%)' }}>
        <div className="anim-fade-up"><div className="text-sm font-medium tracking-wide opacity-80">CUBOTT Clinical</div></div>
        <div className="anim-fade-up" style={{ animationDelay: '120ms' }}>
          <h1 className="serif text-[56px] leading-[1.02] font-normal max-w-xl">The clinic, <em className="italic">connected.</em></h1>
          <p className="mt-6 text-lg opacity-85 max-w-md leading-relaxed">Booking, arrivals, the live queue, the doctor's notes, the prescription and every follow-up in one calm place. Fewer clicks, no re-typing.</p>
        </div>
        <div className="anim-fade-up grid grid-cols-3 gap-6 text-sm opacity-85" style={{ animationDelay: '240ms' }}>
          <div><div className="serif text-3xl">70<span className="text-xl">+</span></div><div className="mt-1 opacity-80">patients a day, one queue</div></div>
          <div><div className="serif text-3xl">0</div><div className="mt-1 opacity-80">handwritten books</div></div>
          <div><div className="serif text-3xl">1</div><div className="mt-1 opacity-80">tap to a printed Rx</div></div>
        </div>
        <div className="absolute -right-32 -bottom-32 h-[420px] w-[420px] rounded-full border border-white/15" /><div className="absolute -right-10 -bottom-10 h-[260px] w-[260px] rounded-full border border-white/15" />
      </div>
      <div className="grid place-items-center p-6">
        <form onSubmit={submit} className="w-full max-w-sm anim-scale-in">
          <div className="lg:hidden serif text-2xl mb-6">CUBOTT Clinical</div>
          <h2 className="text-[26px] font-medium">Sign in</h2>
          <p className="text-sm text-muted mt-1 mb-6">Your clinic is recognised from your email.</p>
          <div className="space-y-3">
            <div><label className="label">Email</label><input autoFocus className="input" type="email" placeholder="you@clinic.in" value={f.email} onChange={(e) => { setF({ ...f, email: e.target.value }); setClinics(null); }} /></div>
            <div><label className="label">Password</label><input className="input" type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></div>
            {clinics && (
              <div className="card !p-3 anim-fade-up"><div className="text-xs text-muted mb-2">This email belongs to more than one clinic. Which one?</div>
                <div className="flex flex-col gap-1">{clinics.map((c) => <button type="button" key={c.slug} className="btn justify-start" onClick={() => submit(undefined, f.email, c.slug)}>{c.name}</button>)}</div></div>
            )}
            {err && <div className="text-sm text-rose anim-fade-in">{err}</div>}
            <button className="btn btn-primary w-full !py-3" disabled={busy || !f.email}>{busy ? 'Signing in…' : 'Continue'}<Icon name="chevR" /></button>
          </div>
          <div className="mt-8">
            <div className="text-[11px] uppercase tracking-wider text-muted mb-2">Demo accounts · password demo1234</div>
            <div className="grid grid-cols-2 gap-2 stagger">
              {DEMO.map(([e, role, hint], i) => (
                <button type="button" key={e} style={{ ['--i' as any]: i }} className="card card-hover !p-3 text-left" onClick={() => submit(undefined, e)}>
                  <div className="text-sm font-medium">{role}</div><div className="text-[11px] text-muted mt-0.5 leading-snug">{hint}</div>
                </button>
              ))}
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
