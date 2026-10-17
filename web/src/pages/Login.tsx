import { useState } from 'react';
import { useNavigate } from 'react-router';
import { post, qc, ApiError } from '../api';
import { Icon } from '../ui';

const DEMO = [
  ['owner@demo.clinic', 'Owner and doctor', 'Everything, with finance'],
  ['reception@demo.clinic', 'Reception', 'Front desk and booking'],
  ['procedures@demo.clinic', 'Coordinator', 'Procedures and rooms'],
  ['assistant@demo.clinic', 'Assistant', 'Intake before the doctor'],
  ['pharmacy@demo.clinic', 'Pharmacy', 'Dispense and bill'],
  ['superadmin@cubott.in', 'CUBOTT admin', 'Onboard clinics'],
];

export function Login() {
  const nav = useNavigate();
  const [f, setF] = useState({ email: '', password: 'demo1234', tenant: '' });
  const [clinics, setClinics] = useState<{ slug: string; name: string }[] | null>(null);
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async (e?: React.FormEvent, email = f.email, tenant = f.tenant) => {
    e?.preventDefault(); setErr(''); setBusy(true);
    try { await post('/auth/login', { email, password: f.password, tenant: tenant || undefined }); qc.clear(); nav('/', { viewTransition: true }); }
    catch (x: any) {
      if (x instanceof ApiError && x.body.code === 'CHOOSE_CLINIC') setClinics(x.body.clinics);
      else setErr(x instanceof ApiError && x.body.code === 'TOO_MANY_ATTEMPTS' ? `Too many wrong attempts. Try again in ${Math.ceil((x.body.retryAfterSeconds ?? 600) / 60)} minutes.` : 'That email or password is not right.');
    } finally { setBusy(false); }
  };
  return (
    <div className="min-h-dvh grid lg:grid-cols-[1.1fr_480px] items-center gap-6 px-6 lg:px-14 py-10">
      <div className="hidden lg:flex flex-col gap-24 anim-fade-up">
        <div className="flex items-center gap-3"><span className="grid h-[42px] w-[42px] place-items-center rounded-xl bg-ink text-xl font-bold text-white">C</span><span className="text-xl font-semibold">CUBOTT Clinical</span></div>
        <div>
          <h1 className="text-[56px] leading-[1.02] font-semibold tracking-tight">The clinic,<br />quietly in order.</h1>
          <p className="mt-5 max-w-[400px] text-[17px] leading-relaxed text-ink-2">Booking, arrivals, consultations, prescriptions and follow-ups, with the typing taken out.</p>
        </div>
        <div className="text-[13px] text-muted">Your clinic is recognised from your email.</div>
      </div>
      <form onSubmit={submit} className="glass p-8 w-full max-w-[480px] justify-self-center lg:justify-self-end anim-scale-in" style={{ boxShadow: 'var(--shadow-lift)' }}>
        <div className="lg:hidden mb-5 text-lg font-semibold">CUBOTT Clinical</div>
        <h2 className="text-[26px] font-semibold">Sign in</h2>
        <div className="mt-5 space-y-3.5">
          <div><label className="label">Email</label><input autoFocus className="input !py-3" type="email" placeholder="you@clinic.in" value={f.email} onChange={(e) => { setF({ ...f, email: e.target.value }); setClinics(null); }} /></div>
          <div><label className="label">Password</label><input className="input !py-3" type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></div>
          {clinics && <div className="rounded-2xl bg-white/70 p-3 anim-fade-up"><div className="text-xs text-muted mb-2">This email belongs to more than one clinic. Which one?</div><div className="flex flex-col gap-1">{clinics.map((c) => <button type="button" key={c.slug} className="btn justify-start" onClick={() => submit(undefined, f.email, c.slug)}>{c.name}</button>)}</div></div>}
          {err && <div className="text-sm text-rose anim-fade-in">{err}</div>}
          <button className="btn btn-primary w-full !py-3.5 !text-[15px]" disabled={busy || !f.email}>{busy ? 'Signing in…' : 'Continue'}<Icon name="chevR" /></button>
        </div>
        <div className="mt-8">
          <div className="label">Demo accounts · password demo1234</div>
          <div className="grid grid-cols-2 gap-2 stagger">
            {DEMO.map(([e, role, hint], i) => (
              <button type="button" key={e} style={{ ['--i' as any]: i }} className="glass card-hover !rounded-[18px] px-3.5 py-3 text-left" onClick={() => submit(undefined, e)}>
                <div className="text-sm font-semibold">{role}</div><div className="text-[11.5px] text-muted mt-0.5">{hint}</div>
              </button>))}
          </div>
        </div>
      </form>
    </div>
  );
}
