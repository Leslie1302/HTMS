/**
 * /api/invoice-comment — directed comments on invoices for rectification.
 *
 * POST  /api/invoice-comment  { invoiceId, audience, body }   → post a comment
 * PATCH /api/invoice-comment  { commentId, resolved }         → mark (un)resolved
 *
 * Reads happen client-side straight from Supabase (RLS scopes visibility to
 * the audience + author); ALL writes go through here so the audience can be
 * validated against the caller's role before the service-role insert.
 */
import type { Config } from '@netlify/functions';
import { audit, guard, json, parseBody, serviceDb } from './_lib';
import { commentCreateSchema, commentResolveSchema } from '../../shared/validation';
import { audienceAllowedForRole, type AudienceGroup } from '../../shared/comments';
import { notifyComment } from './_email';

const STAFF = ['admin', 'officer', 'deputy_director', 'director'];

export default guard(
  { roles: ['admin', 'officer', 'transporter', 'deputy_director', 'director'] },
  async (req, ctx) => {
    const svc = serviceDb();

    if (req.method === 'POST') {
      const body = await parseBody(req, commentCreateSchema);

      if (!audienceAllowedForRole(ctx.role, body.audience)) {
        return json(403, { error: 'You may not address that audience' });
      }

      // Caller-scoped read: RLS already limits transporters to their own
      // invoices, so a miss here means "not found OR not yours".
      const { data: invoice, error } = await ctx.db
        .from('invoices')
        .select('id')
        .eq('id', body.invoiceId)
        .single();
      if (error || !invoice) return json(404, { error: 'Invoice not found' });

      const { data: me } = await svc
        .from('app_users')
        .select('full_name')
        .eq('id', ctx.userId)
        .single();
      const authorName = me?.full_name ?? 'HTMS user';

      const { data: comment, error: insErr } = await svc
        .from('invoice_comments')
        .insert({
          invoice_id: body.invoiceId,
          author_id: ctx.userId,
          author_name: authorName,
          author_role: ctx.role,
          audience: body.audience,
          body: body.body,
        })
        .select('id, created_at')
        .single();
      if (insErr) return json(400, { error: insErr.message });

      await audit(ctx.userId, 'comment', 'invoice', body.invoiceId, null, {
        comment_id: comment.id,
        audience: body.audience,
      }).catch(() => {});
      await notifyComment(body.invoiceId, body.audience as AudienceGroup[], ctx.userId, authorName, body.body).catch(
        () => {},
      );
      return json(200, { id: comment.id, created_at: comment.created_at });
    }

    if (req.method === 'PATCH') {
      const body = await parseBody(req, commentResolveSchema);

      const { data: comment, error } = await svc
        .from('invoice_comments')
        .select('id, invoice_id, author_id')
        .eq('id', body.commentId)
        .single();
      if (error || !comment) return json(404, { error: 'Comment not found' });

      // Author or any staff role may toggle resolution.
      if (comment.author_id !== ctx.userId && !STAFF.includes(ctx.role)) {
        return json(403, { error: 'Only the author or staff may resolve a comment' });
      }

      const patch = body.resolved
        ? { resolved_at: new Date().toISOString(), resolved_by: ctx.userId }
        : { resolved_at: null, resolved_by: null };
      const { error: upErr } = await svc.from('invoice_comments').update(patch).eq('id', body.commentId);
      if (upErr) return json(400, { error: upErr.message });

      await audit(ctx.userId, body.resolved ? 'comment_resolved' : 'comment_reopened', 'invoice', comment.invoice_id, null, {
        comment_id: body.commentId,
      }).catch(() => {});
      return json(200, { id: body.commentId, ...patch });
    }

    return json(405, { error: 'Method not allowed' });
  },
);

export const config: Config = { path: '/api/invoice-comment' };
