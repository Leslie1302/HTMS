/**
 * Directed comments on an invoice — DD/Director flag items for immediate
 * rectification; staff/transporters reply. Reads come straight from Supabase
 * (RLS scopes rows to the audience + author); writes go through
 * /api/invoice-comment, which also emails the audience.
 */
import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { AUDIENCE_OPTIONS, audienceLabel } from '../../shared/comments';
import type { UserRole } from '../../shared/signing';

interface InvoiceComment {
  id: string;
  author_id: string;
  author_name: string;
  author_role: string;
  audience: string[];
  body: string;
  resolved_at: string | null;
  created_at: string;
}

const ROLE_BADGES: Record<string, string> = {
  deputy_director: 'Deputy Director',
  director: 'Director',
  officer: 'Officer',
  admin: 'Admin',
  transporter: 'Transporter',
};

const fmt = (iso: string) =>
  new Date(iso).toLocaleString('en-GH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export default function InvoiceComments({
  invoiceId,
  role,
  userId,
}: {
  invoiceId: string;
  role: UserRole;
  userId: string;
}) {
  const [comments, setComments] = useState<InvoiceComment[]>([]);
  const [body, setBody] = useState('');
  const [audIdx, setAudIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const options = AUDIENCE_OPTIONS[role] ?? [];
  const isStaff = role !== 'transporter';

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('invoice_comments')
      .select('id, author_id, author_name, author_role, audience, body, resolved_at, created_at')
      .eq('invoice_id', invoiceId)
      .order('created_at');
    if (!error) setComments((data as InvoiceComment[]) ?? []);
  }, [invoiceId]);
  useEffect(() => {
    load();
  }, [load]);

  async function call(method: 'POST' | 'PATCH', payload: Record<string, unknown>) {
    setBusy(true);
    setErr(null);
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token;
      const res = await fetch('/api/invoice-comment', {
        method,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      await load();
      return true;
    } catch (e) {
      setErr((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function post() {
    const opt = options[audIdx];
    if (!opt || !body.trim()) return;
    if (await call('POST', { invoiceId, audience: opt.groups, body: body.trim() })) setBody('');
  }

  return (
    <div className="bg-white rounded-lg border border-outline-variant p-5 mb-5">
      <h3 className="text-base font-semibold mb-3 flex items-center gap-2">
        <span className="material-symbols-outlined text-lg">forum</span>
        Comments
        {comments.some((c) => !c.resolved_at) && (
          <span className="text-[10px] font-bold uppercase bg-error-container text-error px-2 py-0.5 rounded">
            {comments.filter((c) => !c.resolved_at).length} unresolved
          </span>
        )}
      </h3>

      {err && <div className="mb-3 text-sm text-error bg-error-container p-3 rounded-lg">{err}</div>}

      {comments.length === 0 ? (
        <p className="text-sm text-outline-variant mb-4">No comments yet.</p>
      ) : (
        <ul className="space-y-3 mb-4">
          {comments.map((c) => (
            <li
              key={c.id}
              className={`rounded-lg border p-3 ${
                c.resolved_at ? 'border-outline-variant opacity-70' : 'border-[#e0b400] bg-[#fffbe6]'
              }`}
            >
              <div className="flex items-center justify-between gap-2 mb-1">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-sm font-medium truncate">{c.author_name}</span>
                  <span className="shrink-0 text-[10px] font-bold uppercase border border-outline px-1.5 py-0.5 rounded text-on-surface-variant">
                    {ROLE_BADGES[c.author_role] ?? c.author_role}
                  </span>
                  <span className="shrink-0 text-[10px] text-outline">→ {audienceLabel(c.audience)}</span>
                </div>
                <span className="shrink-0 text-[11px] text-outline">{fmt(c.created_at)}</span>
              </div>
              <p className="text-sm text-on-surface whitespace-pre-wrap">{c.body}</p>
              <div className="mt-2 flex items-center justify-between">
                {c.resolved_at ? (
                  <span className="flex items-center gap-1 text-[11px] text-[#0d631b]">
                    <span className="material-symbols-outlined text-sm">check_circle</span>
                    Resolved {fmt(c.resolved_at)}
                  </span>
                ) : (
                  <span className="text-[11px] text-[#8a6d00]">Awaiting rectification</span>
                )}
                {(isStaff || c.author_id === userId) && (
                  <button
                    onClick={() => call('PATCH', { commentId: c.id, resolved: !c.resolved_at })}
                    disabled={busy}
                    className="text-[11px] underline text-on-surface-variant hover:text-on-surface disabled:opacity-50"
                  >
                    {c.resolved_at ? 'Reopen' : 'Mark resolved'}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* New comment form */}
      <div className="flex flex-col gap-2">
        {options.length > 1 ? (
          <select
            value={audIdx}
            onChange={(e) => setAudIdx(Number(e.target.value))}
            className="border border-outline-variant rounded-lg px-3 py-2 text-sm outline-none w-full sm:w-64"
            title="Who this comment is directed to"
          >
            {options.map((o, i) => (
              <option key={o.label} value={i}>
                To: {o.label}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-xs text-outline">To: {options[0]?.label}</span>
        )}
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={3}
          maxLength={2000}
          placeholder="What needs to be rectified? (recipients are emailed)"
          className="w-full border border-outline-variant rounded-lg px-3 py-2 text-sm outline-none"
        />
        <button
          onClick={post}
          disabled={busy || !body.trim() || options.length === 0}
          className="self-end flex items-center gap-1 bg-[#2e7d32] hover:opacity-90 text-white rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50"
        >
          <span className="material-symbols-outlined text-sm">send</span>
          {busy ? 'Sending…' : 'Send comment'}
        </button>
      </div>
    </div>
  );
}
