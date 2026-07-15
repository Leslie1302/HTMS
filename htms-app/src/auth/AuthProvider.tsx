import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';

export type Role = 'admin' | 'officer' | 'transporter' | 'deputy_director' | 'director';
interface Profile {
  role: Role;
  transporter_id: string | null;
  full_name: string | null;
  signature_path: string | null;
}
interface AuthState {
  session: Session | null;
  profile: Profile | null;
  loading: boolean;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

const Ctx = createContext<AuthState>({
  session: null,
  profile: null,
  loading: true,
  signOut: async () => {},
  refreshProfile: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const initialized = useRef(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) {
      setProfile(null);
      setLoading(false);
      return;
    }
    if (!initialized.current) setLoading(true);
    supabase
      .from('app_users')
      .select('role, transporter_id, full_name, signature_path')
      .eq('id', session.user.id)
      .single()
      .then(({ data }) => {
        console.log('[AuthProvider] profile fetched:', { signature_path: (data as Profile | null)?.signature_path, data });
        setProfile(data as Profile | null);
        setLoading(false);
        initialized.current = true;
      });
  }, [session]);

  async function refreshProfile() {
    const s = session ?? (await supabase.auth.getSession()).data.session;
    if (!s) { console.log('[AuthProvider] refreshProfile — no session'); return; }
    const { data } = await supabase
      .from('app_users')
      .select('role, transporter_id, full_name, signature_path')
      .eq('id', s.user.id)
      .single();
    console.log('[AuthProvider] refreshProfile result:', { signature_path: (data as Profile | null)?.signature_path, data });
    if (data) setProfile(data as Profile);
  }

  return (
    <Ctx.Provider
      value={{
        session,
        profile,
        loading,
        signOut: async () => {
          await supabase.auth.signOut();
        },
        refreshProfile,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export const useAuth = () => useContext(Ctx);
