/**
 * Thin wrappers that make writes prove they happened.
 *
 * Every client-side mutation on a table with RLS must go through these helpers
 * so a zero-row UPDATE or a blocked Storage download throws instead of
 * returning `{ error: null }` and letting the UI render a false success.
 *
 * Usage:
 *   const row = await mustUpdate(
 *     supabase.from('transporters').update({ foo: 1 }).eq('id', id).select('foo').single()
 *   );
 *
 *   const blob = await mustDownload('documents', 'signatures/uid.png');
 */
import { supabase } from './supabase';

type PgResult<T> = { data: T | null; error: { code?: string; message: string } | null };

/**
 * Await a Supabase query that already has `.select(...).single()` appended.
 * Throws a readable error when `data` is null or the error is a policy denial
 * (Postgres 42501).
 */
export async function mustUpdate<T>(query: PromiseLike<PgResult<T>>): Promise<T> {
  const { data, error } = await query;
  if (error) {
    if (error.code === '42501') {
      throw new Error(`Policy denied — you do not have permission for this action: ${error.message}`);
    }
    throw new Error(error.message);
  }
  if (data === null) {
    throw new Error('Update matched zero rows — the row may not exist or an RLS policy blocked access.');
  }
  return data;
}

/**
 * Await a Supabase query that already has `.select(...)` (without `.single()`)
 * and assert that at least one row was returned.
 */
export async function mustSelect<T>(query: PromiseLike<PgResult<T[]>>): Promise<T[]> {
  const { data, error } = await query;
  if (error) {
    if (error.code === '42501') {
      throw new Error(`Policy denied — you do not have permission to read this data: ${error.message}`);
    }
    throw new Error(error.message);
  }
  return data ?? [];
}

/**
 * Download a file from Supabase Storage, throwing when the blob is missing.
 */
export async function mustDownload(bucket: string, path: string): Promise<Blob> {
  const { data, error } = await supabase.storage.from(bucket).download(path);
  if (error) {
    throw new Error(`Storage download failed (${bucket}/${path}): ${error.message}`);
  }
  if (!data) {
    throw new Error(`Storage returned no data for ${bucket}/${path} — the file may be missing or a policy blocked access.`);
  }
  return data;
}
