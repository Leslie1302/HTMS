import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
export const isSupabaseConfigured = Boolean(url && anon);

if (!isSupabaseConfigured) {
  console.warn('Supabase env not set — set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY');
}

export const supabase = createClient(url || 'https://not-configured.supabase.co', anon || 'not-configured');
