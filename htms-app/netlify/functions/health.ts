import type { Config } from '@netlify/functions';

/** Unauthenticated health check (explicit, documented public route). */
export default async (): Promise<Response> =>
  new Response(JSON.stringify({ status: 'ok', time: new Date().toISOString() }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

export const config: Config = { path: '/api/health' };
