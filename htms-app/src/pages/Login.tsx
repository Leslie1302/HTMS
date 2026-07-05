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
    <div className="min-h-screen flex items-center justify-center bg-surface px-4">
      <div className="w-full max-w-[440px] bg-white border border-outline-variant rounded-lg overflow-hidden">
        <div className="flex h-1">
          <div className="flex-1 bg-ghana-red" />
          <div className="flex-1 bg-ghana-gold" />
          <div className="flex-1 bg-ghana-green" />
        </div>
        <div className="px-8 py-8 flex flex-col items-center">
          <div className="mb-6">
            <Crest size={80} />
          </div>
          <div className="text-center mb-8">
            <h1 className="text-[32px] font-semibold tracking-tight text-on-surface">HTMS</h1>
            <p className="text-xs font-bold tracking-[0.05em] uppercase text-outline mt-1">
              Ministry of Energy and Green Transition
            </p>
          </div>
          {err && (
            <div className="w-full mb-4 text-sm text-error bg-error-container p-2 rounded-lg flex items-center gap-2">
              <span className="material-symbols-outlined text-[18px]">error</span>
              {err}
            </div>
          )}
          <form onSubmit={submit} className="w-full space-y-4">
            <div className="flex flex-col gap-1">
              <label className="text-xs font-bold tracking-[0.05em] uppercase text-on-surface-variant" htmlFor="email">
                Email address
              </label>
              <div className="relative">
                <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline-variant text-xl">
                  mail
                </span>
                <input
                  id="email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@energy.gov.gh"
                  className="w-full h-10 pl-10 pr-4 border border-outline-variant rounded-lg focus:ring-2 focus:ring-[#0d631b] focus:border-transparent outline-none text-sm"
                />
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <div className="flex justify-between items-center">
                <label className="text-xs font-bold tracking-[0.05em] uppercase text-on-surface-variant" htmlFor="password">
                  Password
                </label>
              </div>
              <div className="relative">
                <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline-variant text-xl">
                  lock
                </span>
                <input
                  id="password"
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full h-10 pl-10 pr-4 border border-outline-variant rounded-lg focus:ring-2 focus:ring-[#0d631b] focus:border-transparent outline-none text-sm"
                />
              </div>
            </div>
            <div className="flex items-center gap-2 pt-1">
              <input
                id="remember"
                type="checkbox"
                className="w-4 h-4 text-[#0d631b] border-outline-variant rounded focus:ring-[#0d631b]"
              />
              <label htmlFor="remember" className="text-sm text-on-surface-variant cursor-pointer">
                Keep me signed in for 30 days
              </label>
            </div>
            <button
              disabled={busy}
              type="submit"
              className="w-full h-12 bg-[#2e7d32] text-white font-semibold text-sm rounded-lg flex items-center justify-center gap-2 hover:opacity-90 active:scale-[0.98] transition-all mt-4 disabled:opacity-50"
            >
              <span className="material-symbols-outlined" style={{ fontVariationSettings: "'FILL' 1" }}>
                {busy ? 'refresh' : 'login'}
              </span>
              {busy ? 'Signing in…' : 'Sign In'}
            </button>
          </form>
          <div className="mt-8 pt-6 border-t border-[#dce2f7] w-full flex items-center justify-center gap-1 text-outline">
            <span className="material-symbols-outlined text-[18px]">verified_user</span>
            <span className="text-xs font-bold tracking-[0.05em] uppercase">Secure Ministry Access</span>
          </div>
        </div>
      </div>
      <div className="fixed bottom-6 w-full text-center">
        <p className="text-sm text-outline-variant">
          Technical issues?{' '}
          <a href="#" className="text-on-surface-variant font-medium hover:text-[#0d631b] underline">
            Contact System Administrator
          </a>
        </p>
      </div>
    </div>
  );
}
