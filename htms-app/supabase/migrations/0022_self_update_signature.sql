-- ============================================================================
-- HTMS — Migration 0022: let users save their OWN signature_path.
-- app_users was admin-write-only (0002), so a non-admin's signature upload
-- stored the file but the signature_path update silently matched zero rows —
-- the Settings page then showed "nothing uploaded" after any remount (e.g.
-- right after MFA verification). Admins were unaffected, which masked it.
--
-- RLS cannot restrict columns, so: a self-update policy + a trigger that
-- blocks non-admins from touching role / transporter_id (privilege escalation
-- guard). The trigger exempts service-role calls (auth.uid() is null) so the
-- Netlify admin functions keep working.
-- ============================================================================

create policy app_users_self_update on app_users
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

create or replace function app_users_guard_self_update() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null
     and auth_role() is distinct from 'admin'
     and (new.role is distinct from old.role
          or new.transporter_id is distinct from old.transporter_id) then
    raise exception 'Only an admin may change roles or company bindings';
  end if;
  return new;
end $$;

drop trigger if exists app_users_self_update_guard on app_users;
create trigger app_users_self_update_guard
  before update on app_users
  for each row execute function app_users_guard_self_update();
