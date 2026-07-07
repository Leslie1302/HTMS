import { supabase } from './supabase';

/** A non-expired access token, refreshing first if the stored one is stale. */
async function freshToken(): Promise<string | undefined> {
  const { data } = await supabase.auth.getSession();
  let session = data.session;
  // Refresh if the token is expired or within 60s of expiring (idle-tab guard).
  if (session?.expires_at && session.expires_at * 1000 < Date.now() + 60_000) {
    const { data: r } = await supabase.auth.refreshSession();
    session = r.session ?? session;
  }
  return session?.access_token;
}

/** Authenticated fetch to a Netlify function — always attaches the live JWT. */
async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await freshToken();
  const res = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    // Plain `vite` doesn't run the /api functions — it returns index.html here.
    throw new Error(
      'API did not return JSON. Run the app with `npx netlify dev` (port 8888) so the /api functions are served, not plain `npm run dev`.',
    );
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  return body as T;
}

export const api = {
  listWaybills: () => call<{ waybills: any[] }>('/api/waybills'),
  createWaybill: (w: unknown) => call('/api/waybills', { method: 'POST', body: JSON.stringify(w) }),
  listInvoices: () => call<{ invoices: any[] }>('/api/invoices'),
  createInvoice: (i: unknown) => call('/api/invoices', { method: 'POST', body: JSON.stringify(i) }),
  approveInvoice: (id: string, action: 'approve' | 'lock' | 'void') =>
    call(`/api/invoices?id=${id}&action=${action}`, { method: 'PATCH' }),
  generateDoc: (d: unknown) => call<{ url: string; html: string }>('/api/generate-document', {
    method: 'POST',
    body: JSON.stringify(d),
  }),
  createUser: (u: unknown) => call<{ id: string; tempPassword: string }>('/api/admin-users', {
    method: 'POST',
    body: JSON.stringify(u),
  }),
  adminDelete: (body: { action: 'delete_transporter' | 'delete_invoice' | 'reset_pilot'; id?: string }) =>
    call<{ ok: true }>('/api/admin-delete', { method: 'POST', body: JSON.stringify(body) }),
  resolveFlag: (body: { scanId: string; storagePath: string; mime: string; size: number }) =>
    call<{ ok: true }>('/api/resolve-flag', { method: 'POST', body: JSON.stringify(body) }),
};
