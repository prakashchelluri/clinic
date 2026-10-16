import { useState } from 'react';
import { useNavigate } from 'react-router';
import { post, qc } from '../api';

const DEMO = [['owner@demo.clinic', 'Doctor / owner'], ['reception@demo.clinic', 'OP reception'], ['procedures@demo.clinic', 'Procedure coordinator'], ['assistant@demo.clinic', 'Assistant (intake)'], ['pharmacy@demo.clinic', 'Pharmacy']];

export function Login() {
  const nav = useNavigate();
  const [f, setF] = useState({ tenant: 'sahitya', email: 'reception@demo.clinic', password: 'demo1234' });
  const [err, setErr] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr('');
    try { await post('/auth/login', f); qc.clear(); nav('/queue'); } catch { setErr('Wrong clinic, email or password'); }
  };
  return (
    <div className="min-h-screen grid place-items-center p-4">
      <form onSubmit={submit} className="card w-full max-w-sm space-y-3">
        <div className="text-lg font-semibold text-emerald-800">CUBOTT Clinical</div>
        <div><label className="label">Clinic</label><input className="input" value={f.tenant} onChange={(e) => setF({ ...f, tenant: e.target.value })} /></div>
        <div><label className="label">Email</label><input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
        <div><label className="label">Password</label><input className="input" type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></div>
        {err && <div className="text-sm text-red-600">{err}</div>}
        <button className="btn btn-primary w-full justify-center">Sign in</button>
        <div className="text-xs text-slate-500 pt-2">Demo accounts (password <code>demo1234</code>):
          <ul className="mt-1 space-y-0.5">{DEMO.map(([e, l]) => <li key={e}><button type="button" className="underline" onClick={() => setF({ ...f, email: e })}>{e}</button> — {l}</li>)}</ul>
        </div>
      </form>
    </div>
  );
}
