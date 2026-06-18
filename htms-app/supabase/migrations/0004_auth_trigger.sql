-- ============================================================================
-- Auto-provision an app_users row when a new auth user is created.
-- New users default to 'transporter' with NO transporter binding — an Admin
-- must assign their transporter_id (or promote them) before they can file
-- waybills (the check constraint + RLS keep them inert until then).
--
-- NOTE: a brand-new transporter signup would violate the app_users check
-- (transporter requires transporter_id). So we provision as a "pending" row
-- by creating staff-style rows only via Admin, and handle transporter signups
-- through an Admin invite flow. To keep signups non-blocking, we insert the
-- profile with role resolved from the auth metadata if present.
-- ============================================================================

create or replace function handle_new_user() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  meta_role user_role;
  meta_transporter uuid;
begin
  meta_role := coalesce((new.raw_user_meta_data->>'role')::user_role, 'transporter');
  meta_transporter := nullif(new.raw_user_meta_data->>'transporter_id','')::uuid;

  -- Staff must not carry a transporter_id; transporters must.
  if meta_role = 'transporter' and meta_transporter is null then
    -- Park as officer-with-no-rights? No — instead leave unprovisioned and let
    -- Admin assign. We insert nothing; the user simply has no profile yet and
    -- every RLS policy denies them until Admin creates their app_users row.
    return new;
  end if;

  insert into app_users (id, role, transporter_id, full_name)
  values (new.id, meta_role, meta_transporter, new.raw_user_meta_data->>'full_name')
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();
