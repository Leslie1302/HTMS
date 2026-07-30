/**
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

type PgResult<T> = { data: T | null; error: { code?: string; message: string } | null };
type Result<T> = { data: T | null; error: { message: string; code?: string } | null };

/** Await query with `.select(...).single()`, throw on policy denial or zero rows. */
export async function mustUpdate<T>(query: PromiseLike<PgResult<T>>): Promise<T> {
  const { data, error } = await query;
  if (error) {
    if (error.code === '42501')
      throw new Error(`Policy denied — you do not have permission for this action: ${error.message}`);
    throw new Error(error.message);
  }
  if (data === null)
    throw new Error('Update matched zero rows — the row may not exist or an RLS policy blocked access.');
  return data;
}

/** Await query with `.select(...)` (array result), never returns null. */
export async function mustSelect<T>(query: PromiseLike<PgResult<T[]>>): Promise<T[]> {
  const { data, error } = await query;
  if (error) {
    if (error.code === '42501')
      throw new Error(`Policy denied — you do not have permission to read this data: ${error.message}`);
    throw new Error(error.message);
  }
  return data ?? [];
}

/**
 * Await a mutation that has `.select(...)` appended and assert it changed something.
 *
 * @param q     the query builder (must include `.select(...)`)
 * @param what  human-readable subject, used in the thrown message
 */
export async function mustWrite<T>(q: PromiseLike<Result<T>>, what: string): Promise<T> {
  const { data, error } = await q;
  if (error) {
    if (error.code === '42501')
      throw new Error(`You do not have permission to change ${what}.`);
    throw new Error(error.message);
  }
  if (data == null || (Array.isArray(data) && data.length === 0))
    throw new Error(
      `${what} could not be saved — the change was blocked by a security policy or the record no longer exists. Contact an administrator.`,
    );
  return data;
}

/** Download a file, throwing loudly when missing or blocked by policy. */
export async function mustDownload(bucket: string, path: string, what: string): Promise<Blob> {
  const { data, error } = await supabase.storage.from(bucket).download(path);
  if (error) throw new Error(`${what} could not be loaded: ${error.message}`);
  if (!data) throw new Error(`${what} could not be loaded (no file at ${bucket}/${path}).`);
  return data;
}

/**
 * Best-effort variant for files that are genuinely optional: returns null instead of
 * throwing — the caller must surface the omission (e.g. "N scans could not be included").
 */
export async function tryDownload(bucket: string, path: string): Promise<Blob | null> {
  const { data, error } = await supabase.storage.from(bucket).download(path);
  if (error || !data) {
    console.warn(`[htms] download failed: ${bucket}/${path}`, error?.message ?? 'no data');
    return null;
  }
  return data;
}
