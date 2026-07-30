/**
<<<<<<< Updated upstream
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
=======
 * Guards against RLS silent failure.
 *
 * Postgres does not treat "your policy matched zero rows" as an error: an UPDATE
 * blocked by RLS returns `{ data: [], error: null }`, and Storage returns
 * `{ data: null, error: null }` for a blocked download. Every such bug in this
 * codebase (0019–0023) looked like success in the UI and was only found by a user.
 *
 * Rule: mutations go through `mustWrite`, document downloads through `mustDownload`.
 */
import { supabase } from './supabase';

/** Shape returned by a supabase-js query with `.select()` appended. */
type Result<T> = { data: T | null; error: { message: string; code?: string } | null };

/**
 * Await a mutation that has `.select(...)` appended and assert it changed something.
 *
 * @param q     the query builder (must include `.select(...)`)
 * @param what  human-readable subject, used in the thrown message
 */
export async function mustWrite<T>(q: PromiseLike<Result<T>>, what: string): Promise<T> {
  const { data, error } = await q;
  if (error) {
    // 42501 = insufficient_privilege; supabase-js also surfaces policy denials here.
    if (error.code === '42501') {
      throw new Error(`You do not have permission to change ${what}.`);
    }
    throw new Error(error.message);
  }
  // Zero rows: the write was silently filtered out by a row-level policy.
  if (data == null || (Array.isArray(data) && data.length === 0)) {
    throw new Error(
      `${what} could not be saved — the change was blocked by a security policy or the record no longer exists. Contact an administrator.`,
    );
>>>>>>> Stashed changes
  }
  return data;
}

/**
<<<<<<< Updated upstream
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
=======
 * Download a file that a document depends on, failing loudly when it is missing or
 * access is denied — never silently omitting it from a generated PDF.
 */
export async function mustDownload(bucket: string, path: string, what: string): Promise<Blob> {
  const { data, error } = await supabase.storage.from(bucket).download(path);
  if (error) throw new Error(`${what} could not be loaded: ${error.message}`);
  if (!data) throw new Error(`${what} could not be loaded (no file at ${bucket}/${path}).`);
  return data;
}

/**
 * Best-effort variant for files that are genuinely optional: returns null instead of
 * throwing, but the CALLER must surface the omission to the user (e.g. the reviewer
 * document's "N scans could not be included" banner). Never swallow this silently.
 */
export async function tryDownload(bucket: string, path: string): Promise<Blob | null> {
  const { data, error } = await supabase.storage.from(bucket).download(path);
  if (error || !data) {
    console.warn(`[htms] download failed: ${bucket}/${path}`, error?.message ?? 'no data');
    return null;
>>>>>>> Stashed changes
  }
  return data;
}
