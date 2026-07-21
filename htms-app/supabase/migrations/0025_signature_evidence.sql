-- 0025: Extend invoice_signatures with evidentiary columns + harden the table.
-- Captures what was signed (doc_hash), who signed (signed_ip, user_agent),
-- and the assurance level (aal) at signing time.

ALTER TABLE invoice_signatures
  ADD COLUMN doc_hash text,
  ADD COLUMN signed_ip inet,
  ADD COLUMN user_agent text,
  ADD COLUMN aal text;

-- Explicitly deny INSERT/UPDATE/DELETE from authenticated users.
-- Inserts happen only via the service-role Netlify function (invoice-sign.ts).
REVOKE INSERT, UPDATE, DELETE ON invoice_signatures FROM authenticated;

-- Append-only guard: signatures cannot be modified or deleted by anyone,
-- not even the service role (which bypasses RLS but not triggers).
-- ponytail: retention policy when Records Management asks for one.
CREATE OR REPLACE FUNCTION invoice_signatures_guard()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' OR TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'invoice_signatures is append-only — rows cannot be updated or deleted';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER invoice_signatures_immutable
  BEFORE UPDATE OR DELETE ON invoice_signatures
  FOR EACH ROW
  EXECUTE FUNCTION invoice_signatures_guard();
