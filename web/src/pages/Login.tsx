import { useState } from 'react';
import { useNavigate } from 'react-router';
import { post, qc, ApiError } from '../api';
import { Icon } from '../ui';
import { useTheme } from '../App';

/** Demo accounts show only on a development build, or a demo build made with VITE_DEMO_LOGIN=1. Never on a real clinic's sign-in. */
const SHOW_DEMO = import.meta.env.DEV || import.meta.env.VITE_DEMO_LOGIN === '1';
const DEMO = SHOW_DEMO ? [
  ['owner@demo.clinic', 'Owner and doctor', 'Everything, with finance'],
  ['reception@demo.clinic', 'Reception', 'Front desk and booking'],
  ['procedures@demo.clinic', 'Coordinator', 'Procedures and rooms'],
  ['assistant@demo.clinic', 'Junior doctor', 'Screening before the doctor'],
  ['pharmacy@demo.clinic', 'Pharmacy', 'Dispense and bill'],
  ...(import.meta.env.DEV ? [['superadmin@cubott.in', 'CUBOTT admin', 'Onboard clinics']] : []), // the platform account: development only
] : [];

// Role colours come from the app palette: amber, the green action, sky, and ink for admin. Top face = the pastel tile.
const ROLE = {
  reception: { top: '#FAE6BD', right: '#EBC27A', left: '#C9913A', line: '#C9913A' },
  doctor: { top: '#D6EEDF', right: '#5DB58A', left: '#0E7A52', line: '#0E7A52' },
  pharmacy: { top: '#DCE7F6', right: '#93B3E0', left: '#285C9C', line: '#285C9C' },
  admin: { top: '#E4E9E5', right: '#A9B5AE', left: '#2E3A33', line: '#56605A' },
};
const INK = '#121A16';

// One isometric cube in the logo's language: top vertex at the origin, 180 wide, 174 tall.
const TOP = '0,0 90,45 0,90 -90,45', LEFT = '-90,45 0,90 0,174 -90,129', RIGHT = '0,90 90,45 90,129 0,174';
function Cube({ at, cls, c, label, labelX, children }: { at: [number, number]; cls: string; c: { top: string; right: string; left: string }; label: string; labelX: number; children: React.ReactNode }) {
  return (
    <g transform={`translate(${at[0]},${at[1]})`}><g className={cls}>
      <polygon points={TOP} fill={c.top} /><polygon points={LEFT} fill={c.left} /><polygon points={RIGHT} fill={c.right} />
      <g fill="none" stroke={INK} strokeWidth={2.5} strokeLinejoin="round"><polygon points={TOP} /><polygon points={LEFT} /><polygon points={RIGHT} /></g>
      <g transform="matrix(1,0.5,-1,0.5,0,0)">{children}</g>
      <g transform="translate(0,90) matrix(1,-0.5,0,1,0,0)"><text x={labelX} y={50} fontSize={11} fontWeight={700} letterSpacing={1.3} fill={INK}>{label}</text></g>
    </g></g>
  );
}

function Stage() {
  return (
    <svg viewBox="20 90 720 560" role="img" aria-label="A patient walks from Reception to the Doctor to Pharmacy while Admin watches over all three" className="w-full max-w-[700px] h-auto self-center overflow-visible">
      <path d="M40 612 L700 282" style={{ stroke: 'var(--color-paper-2)' }} strokeWidth={34} strokeLinecap="round" />
      <path d="M40 612 L700 282" style={{ stroke: 'var(--color-line-2)' }} strokeWidth={2} strokeDasharray="2 10" strokeLinecap="round" />
      <g style={{ stroke: 'var(--color-muted)' }} strokeWidth={2} fill="none" opacity={0.6}>
        <path className="lg-sight" d="M160 300 L180 400" /><path className="lg-sight" d="M200 270 L330 300" /><path className="lg-sight" d="M240 250 L500 220" />
      </g>
      <Cube at={[160, 110]} cls="lg-bob" c={ROLE.admin} label="ADMIN" labelX={10}>
        <g fill="#FFFFFF" stroke={INK} strokeWidth={3}><rect x={24} y={48} width={10} height={20} rx={2} /><rect x={40} y={36} width={10} height={32} rx={2} /><rect x={56} y={24} width={10} height={44} rx={2} /></g>
      </Cube>
      <Cube at={[540, 150]} cls="lg-aP" c={ROLE.pharmacy} label="PHARMACY" labelX={9}>
        <g transform="rotate(-45 45 45)"><rect x={18} y={34} width={54} height={22} rx={11} fill="#FFFFFF" stroke={INK} strokeWidth={4} /><path d="M18 45 a11 11 0 0 1 11 -11 h16 v22 h-16 a11 11 0 0 1 -11 -11z" fill={ROLE.pharmacy.left} /></g>
      </Cube>
      <Cube at={[360, 240]} cls="lg-aD" c={ROLE.doctor} label="DOCTOR" labelX={12}>
        <path d="M37 20 h16 v17 h17 v16 h-17 v17 h-16 v-17 h-17 v-16 h17z" fill="#FFFFFF" stroke={INK} strokeWidth={4} strokeLinejoin="round" />
      </Cube>
      <Cube at={[180, 330]} cls="lg-aR" c={ROLE.reception} label="RECEPTION" labelX={7}>
        <path d="M22 28 h46 v10 a7 7 0 0 0 0 14 v10 h-46 v-10 a7 7 0 0 0 0 -14z" fill="#FFFFFF" stroke={INK} strokeWidth={4} strokeLinejoin="round" />
        <path d="M33 40 h20 M33 50 h14" stroke={INK} strokeWidth={4} strokeLinecap="round" />
      </Cube>
      <g className="lg-walk">
        <ellipse cx={0} cy={0} rx={16} ry={8} style={{ fill: 'var(--color-ink)' }} opacity={0.15} />
        <rect x={-10} y={-34} width={20} height={32} rx={10} style={{ fill: 'var(--color-ink)' }} />
        <circle cx={0} cy={-44} r={9} style={{ fill: 'var(--color-ink)' }} /><circle cx={0} cy={-44} r={3.5} style={{ fill: 'var(--color-clay)' }} />
      </g>
    </svg>
  );
}

const STEPS: [string, string, string, string][] = [
  ['lg-rR', ROLE.reception.line, '01 · Reception', 'Checks in, collects the fee, gives a token'],
  ['lg-rD', ROLE.doctor.line, '02 · Doctor', 'Writes the prescription in minutes'],
  ['lg-rP', ROLE.pharmacy.line, '03 · Pharmacy', 'Finds it waiting, bills it, hands it over'],
  ['', ROLE.admin.line, 'All day · Admin', 'Sees every step, every rupee, every patient'],
];

export function Login() {
  useTheme(); // the login follows the light or dark choice kept on this device
  const nav = useNavigate();
  const [f, setF] = useState({ email: '', password: SHOW_DEMO ? 'demo1234' : '', tenant: '' }); // never a pre-filled password outside a demo build
  const [clinics, setClinics] = useState<{ slug: string; name: string }[] | null>(null);
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const sp = new URLSearchParams(location.search);
  const [blocked, setBlocked] = useState<string | null>(sp.get('blocked'));
  const idle = sp.get('idle');
  const submit = async (e?: React.FormEvent, email = f.email, tenant = f.tenant) => {
    e?.preventDefault(); setErr(''); setBusy(true);
    try { await post('/auth/login', { email, password: f.password, tenant: tenant || undefined }); qc.clear(); nav('/', { viewTransition: true }); }
    catch (x: any) {
      if (x instanceof ApiError && x.body.code === 'CHOOSE_CLINIC') setClinics(x.body.clinics);
      else if (x instanceof ApiError && x.body.code === 'IP_NOT_ALLOWED') setBlocked(x.body.ip ?? '');
      else if (!(x instanceof ApiError)) setErr("Can't reach the server. Check the internet and try again."); // offline is not a wrong password
      else setErr(x instanceof ApiError && x.body.code === 'TOO_MANY_ATTEMPTS' ? `Too many wrong attempts. Try again in ${Math.ceil((x.body.retryAfterSeconds ?? 600) / 60)} minutes.` : 'That email or password is not right.');
    } finally { setBusy(false); }
  };
  return (
    <div className="min-h-dvh flex flex-wrap items-stretch bg-paper text-ink">
      {/* The story: one patient, every role */}
      <section aria-label="One patient through the clinic" className="hidden lg:flex flex-[1.45_1_660px] min-w-0 flex-col gap-2 py-10 pl-14 pr-10 min-h-dvh anim-fade-up">
        <div className="flex-1 flex flex-col justify-center gap-3">
          <Stage />
          <ol className="grid grid-cols-4 gap-3.5 max-w-[700px] w-full self-center">
            {STEPS.map(([cls, color, head, body]) => (
              <li key={head} className={`${cls} flex flex-col gap-1 pt-2.5`} style={{ borderTop: `3px ${cls ? 'solid' : 'dashed'} ${color}` }}>
                <span className="text-[12.5px] font-bold text-muted">{head}</span>
                <span className="text-[14px] font-semibold leading-snug text-ink">{body}</span>
              </li>))}
          </ol>
        </div>
      </section>

      {/* Sign in */}
      <main className="flex-[1_1_440px] min-w-0 flex items-center justify-center px-6 py-10 lg:px-14 bg-surface min-h-dvh" style={{ boxShadow: 'inset 1px 0 0 var(--color-line)' }}>
        <form onSubmit={submit} className="w-full max-w-[380px] flex flex-col gap-4 anim-fade-up">
          <div className="flex items-center gap-4 mb-3">
            <img src="/cubott.png" alt="" className="h-[66px] w-[52px] object-contain" />
            <h1 className="text-[34px] leading-none tracking-[-0.03em] text-ink" style={{ fontWeight: 700 }}>Cubott <span className="text-muted" style={{ fontWeight: 600 }}>OPD</span></h1>
          </div>

          {blocked !== null && <div className="rounded-2xl bg-amber-soft p-4 text-center anim-fade-up" role="alert">
            <Icon name="lock" className="mx-auto h-6 w-6" />
            <b className="mt-2 block text-[16px]">Not available from here</b>
            <p className="mt-1 text-sm text-ink-2">This clinic's app can be used only from the clinic's internet. If you are at the clinic, the owner has been told and can allow this connection.</p>
            {blocked && <div className="mt-2 font-mono text-xs text-muted">Your address: {blocked}</div>}
          </div>}
          {idle && blocked === null && <div className="rounded-2xl bg-surface-2 px-4 py-3 text-sm text-ink-2 anim-fade-up">Signed out after {idle} minutes without use, to keep patient details safe on a shared computer.</div>}

          <div><label htmlFor="login-email" className="label">Email</label><input id="login-email" autoFocus className="input !py-3" type="email" placeholder="you@clinic.in" autoComplete="username" value={f.email} onChange={(e) => { setF({ ...f, email: e.target.value }); setClinics(null); }} /></div>
          <div><label htmlFor="login-password" className="label">Password</label><input id="login-password" className="input !py-3" type="password" autoComplete="current-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></div>
          {clinics && <div className="rounded-2xl bg-surface-2 p-3 anim-fade-up"><div className="text-xs text-muted mb-2">This email belongs to more than one clinic. Which one?</div><div className="flex flex-col gap-1">{clinics.map((c) => <button type="button" key={c.slug} className="btn justify-start" onClick={() => submit(undefined, f.email, c.slug)}>{c.name}</button>)}</div></div>}
          {err && <div className="text-sm text-rose anim-fade-in" role="alert">{err}</div>}
          <button className="btn btn-primary w-full !py-3.5 !text-[15px]" disabled={busy || !f.email}>{busy ? 'Signing in…' : 'Login'}<Icon name="chevR" /></button>

          {DEMO.length > 0 && <div className="mt-3">
            <div className="label">Demo accounts · password demo1234</div>
            <div className="grid grid-cols-2 gap-2 stagger">
              {DEMO.map(([e, role, hint], i) => (
                <button type="button" key={e} style={{ ['--i' as any]: i }} className="glass card-hover !rounded-[12px] px-3.5 py-2.5 text-left" onClick={() => submit(undefined, e)}>
                  <div className="text-sm font-semibold">{role}</div><div className="text-[11.5px] text-muted mt-0.5">{hint}</div>
                </button>))}
            </div>
          </div>}
        </form>
      </main>
    </div>
  );
}
