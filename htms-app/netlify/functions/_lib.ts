/**
 * Shared server-side middleware for all Netlify functions.
 *
 * Order is deliberate (ASE): rate-limit → auth (verify JWT server-side) →
 * role resolution → Zod validation → handler. No route runs business logic
 * before identity is verified, and no client-asserted identity is trusted.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import ws from 'ws';
import type { ZodSchema } from 'zod';

// supabase-js needs a WebSocket at construction; Netlify's Node runtime may not
// provide one natively. Supply `ws` so the client never throws (we don't use
// realtime in functions, but the client still requires the transport).
const realtime = { transport: ws as unknown as typeof WebSocket };

export interface AuthContext {
  userId: string;
  role: 'admin' | 'officer' | 'transporter';
  transporterId: string | null;
  /** A Supabase client scoped to the CALLER's JWT — RLS applies to every query. */
  db: SupabaseClient;
}

const SUPABASE_URL = process.env.SUPABASE_URL!;
const ANON_KEY = process.env.SUPABASE_ANON_KEY!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/** Service-role client — bypasses RLS. Use ONLY for audit writes / trusted ops. */
export function serviceDb(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false }, realtime });
}

// ── Rate limiting ────────────────────────────────────────────────────────────
// In-memory sliding window (per warm instance). For production multi-instance,
// back this with Upstash Redis (URL/token in env) — interface is identical.
const buckets = new Map<string, number[]>();
function slidingWindow(key: string, limit: number, windowSec: number): boolean {
  const now = Date.now();
  const windowMs = windowSec * 1000;
  const hits = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) {
    buckets.set(key, hits);
    return false;
  }
  hits.push(now);
  buckets.set(key, hits);
  return true;
}

function clientIp(req: Request): string {
  return (
    req.headers.get('x-nf-client-connection-ip') ||
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown'
  );
}

export interface GuardOptions {
  /** Roles permitted to call this route. */
  roles: Array<AuthContext['role']>;
  /** Override the default request budget for this route (e.g. doc generation). */
  rateLimit?: number;
}

export type Handler = (req: Request, ctx: AuthContext) => Promise<Response>;

/**
 * Wrap a handler with rate limiting + auth + role check.
 */
export function guard(opts: GuardOptions, handler: Handler) {
  return async (req: Request): Promise<Response> => {
    try {
      const windowSec = Number(process.env.RATE_LIMIT_WINDOW_SECONDS ?? 60);
      const ipLimit = opts.rateLimit ?? Number(process.env.RATE_LIMIT_MAX_REQUESTS ?? 60);
      const ip = clientIp(req);

      // 1. Per-IP rate limit (before any expensive work).
      if (!slidingWindow(`ip:${ip}:${req.url}`, ipLimit, windowSec)) {
        return json(429, { error: 'Rate limit exceeded' });
      }

      // 2. Verify the Supabase JWT server-side.
      const authz = req.headers.get('authorization') ?? '';
      const token = authz.startsWith('Bearer ') ? authz.slice(7) : '';
      if (!token) return json(401, { error: 'Missing bearer token' });

      const db = createClient(SUPABASE_URL, ANON_KEY, {
        global: { headers: { Authorization: `Bearer ${token}` } },
        auth: { persistSession: false },
        realtime,
      });
      const { data: userData, error: userErr } = await db.auth.getUser(token);
      if (userErr || !userData.user) return json(401, { error: 'Invalid or expired token' });
      const userId = userData.user.id;

      // 3. Per-user rate limit.
      if (!slidingWindow(`u:${userId}:${req.url}`, ipLimit, windowSec)) {
        return json(429, { error: 'Rate limit exceeded' });
      }

      // 4. Resolve role + transporter from app_users (NEVER from the request body).
      const { data: profile, error: profErr } = await db
        .from('app_users')
        .select('role, transporter_id')
        .eq('id', userId)
        .single();
      if (profErr || !profile) return json(403, { error: 'No app profile for user' });

      const role = profile.role as AuthContext['role'];
      if (!opts.roles.includes(role)) return json(403, { error: 'Forbidden for your role' });

      return await handler(req, {
        userId,
        role,
        transporterId: profile.transporter_id ?? null,
        db,
      });
    } catch (err) {
      // Structured error log with request context (wire to Sentry in prod).
      console.error(JSON.stringify({ level: 'error', url: req.url, msg: String(err) }));
      // TEMP DIAGNOSTIC: surface the real message to pinpoint the prod failure.
      // Revert to a generic message once resolved.
      return json(500, { error: 'Internal: ' + (err instanceof Error ? err.message : String(err)) });
    }
  };
}

/** Parse + validate a JSON body against a Zod schema; throws a 400 Response. */
export async function parseBody<T>(req: Request, schema: ZodSchema<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw json(400, { error: 'Invalid JSON body' });
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    console.warn(JSON.stringify({ level: 'warn', msg: 'validation_failed', issues: result.error.issues }));
    throw json(400, { error: 'Validation failed', issues: result.error.issues });
  }
  return result.data;
}

/** Append an audit-log entry via the service role (append-only). */
export async function audit(
  actorId: string,
  action: string,
  entity: string,
  entityId: string,
  before: unknown,
  after: unknown,
): Promise<void> {
  await serviceDb().from('audit_log').insert({
    actor_id: actorId,
    action,
    entity,
    entity_id: entityId,
    before: before ?? null,
    after: after ?? null,
  });
}
