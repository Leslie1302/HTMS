-- ============================================================================
-- 0028 — Invoice comments: DD/Director (and replies) post directed comments
-- on invoices for immediate rectification. Each comment is addressed to one
-- or two audience groups: 'staff' (admin/officer), 'dd' (deputy_director/
-- director), 'transporter' (the invoice's transporter users). Visibility
-- follows the audience; emails/push are sent by the Netlify function.
--
-- Writes (insert + resolve) go ONLY through the service-role function
-- netlify/functions/invoice-comment.ts, which validates the audience against
-- the caller's role. There are deliberately no insert/update/delete policies.
-- ============================================================================

-- 0. Helper functions used by the policy below (created by 0001; re-creating
--    is harmless and keeps this file runnable where they exist already).
create or replace function auth_role() returns user_role
  language sql stable security definer set search_path = public as $$
  select role from app_users where id = auth.uid();
$$;

create or replace function auth_transporter_id() returns uuid
  language sql stable security definer set search_path = public as $$
  select transporter_id from app_users where id = auth.uid();
$$;

-- 1. Table ───────────────────────────────────────────────────────────────────
-- author_name/author_role are snapshots: transporters cannot read other
-- app_users rows (RLS), so a join would blank the name on their status page.
create table invoice_comments (
  id          uuid primary key default gen_random_uuid(),
  invoice_id  uuid not null references invoices(id) on delete cascade,
  author_id   uuid not null references app_users(id),
  author_name text not null,
  author_role user_role not null,
  audience    text[] not null constraint invoice_comments_audience_check
                check (cardinality(audience) between 1 and 2
                       and audience <@ array['staff','transporter','dd']::text[]),
  body        text not null constraint invoice_comments_body_check
                check (char_length(btrim(body)) between 1 and 2000),
  resolved_at timestamptz,
  resolved_by uuid references app_users(id),
  created_at  timestamptz not null default now()
);

create index idx_invoice_comments_invoice on invoice_comments(invoice_id);

-- 2. RLS ─────────────────────────────────────────────────────────────────────
alter table invoice_comments enable row level security;

-- Read: the author, plus anyone whose group is in the audience.
create policy invoice_comments_read on invoice_comments
  for select to authenticated
  using (
    author_id = auth.uid()
    or ('staff' = any(audience) and auth_role() in ('admin','officer'))
    or ('dd' = any(audience) and auth_role() in ('deputy_director','director'))
    or ('transporter' = any(audience) and exists (
          select 1 from invoices i
          where i.id = invoice_comments.invoice_id
            and i.transporter_id = auth_transporter_id()))
  );

-- No insert/update/delete policies — all writes via the service-role function.
