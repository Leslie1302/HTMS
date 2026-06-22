import { useState } from 'react';
import { supabase } from '../lib/supabase';
import { Crest } from '../components/Crest';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setErr(error.message);
    setBusy(false);
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-ministry-light px-4">
      <form onSubmit={submit} className="bg-white rounded-xl shadow p-8 w-full max-w-sm">
        <div className="text-center mb-6">
          <div className="mx-auto w-fit">
            <Crest size={64} />
          </div>
          <h1 className="mt-3 text-lg font-bold text-ministry-dark">HTMS</h1>
          <p className="text-xs text-gray-500">Ministry of Energy and Green Transition</p>
        </div>
        {err && <div className="mb-3 text-sm text-red-600 bg-red-50 p-2 rounded">{err}</div>}
        <label className="block text-sm mb-1">Email</label>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full border rounded px-3 py-2 mb-3"
        />
        <label className="block text-sm mb-1">Password</label>
        <input
          type="password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full border rounded px-3 py-2 mb-4"
        />
        <button
          disabled={busy}
          className="w-full bg-ministry hover:bg-ministry-dark text-white rounded py-2 font-medium disabled:opacity-50"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
