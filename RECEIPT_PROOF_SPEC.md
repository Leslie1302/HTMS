# Feature spec — Ministry receipt-proof upload

Upload scans proving the Ministry received a payment request (stamped/signed by the
Honourable Minister (HM) or Chief Director (CD)). New page, reached from a button in
the Payment Requests table's Actions column.

Grounded in the current code (`src/pages/Invoices.tsx`, `src/App.tsx`, existing
`documents` bucket, `mustWrite`/`tryDownload` in `src/lib/db.ts`). Latest migration
is `0026`, so the new one is `0027`. Smallest working diff, no new deps.

## 1. Migration `0027_receipt_proofs.sql`

```sql
-- Proof that the Ministry received a payment request (HM/CD-stamped scan).
create table receipt_proofs (
  id           uuid primary key default gen_random_uuid(),
  invoice_id   uuid not null references invoices(id) on delete cascade,
  storage_path text not null,
  received_by  text not null check (received_by in ('HM','CD')),
  note         text,
  uploaded_by  uuid not null references app_users(id) default auth.uid(),
  uploaded_at  timestamptz not null default now()
);
create index on receipt_proofs (invoice_id);

alter table receipt_proofs enable row level security;

-- Staff read/write; the owning transporter may READ (so they can see it landed).
create policy receipt_proofs_read on receipt_proofs
  for select to authenticated using (
    is_staff_role(auth_role())
    or exists (select 1 from invoices i
               where i.id = receipt_proofs.invoice_id
                 and i.transporter_id = auth_transporter_id())
  );
create policy receipt_proofs_write on receipt_proofs
  for insert to authenticated with check (auth_role() in ('admin','officer'));
create policy receipt_proofs_delete on receipt_proofs
  for delete to authenticated using (auth_role() = 'admin');

-- Files: documents bucket, receipts/<invoice_id>/<file>. Staff write, staff+owner read.
drop policy if exists receipt_obj_write on storage.objects;
create policy receipt_obj_write on storage.objects
  for insert to authenticated with check (
    bucket_id = 'documents'
    and split_part(name, '/', 1) = 'receipts'
    and auth_role() in ('admin','officer')
  );

drop policy if exists receipt_obj_read on storage.objects;
create policy receipt_obj_read on storage.objects
  for select to authenticated using (
    bucket_id = 'documents'
    and split_part(name, '/', 1) = 'receipts'
    and (
      is_staff_role(auth_role())
      or exists (select 1 from invoices i
                 where i.id::text = split_part(name, '/', 2)
                   and i.transporter_id = auth_transporter_id())
    )
  );
```

Add an `rls.test.ts` case: officer can insert a receipt row + upload to
`receipts/<invoice>/…`; a transporter can read its own invoice's receipt but not
another's; a transporter cannot insert. (Every policy migration gets a test — see
`supabase/migrations/README.md`.)

Add the `0027` line to the migrations README table.

## 2. New page `src/pages/ReceiptProof.tsx`

Route `/receipt-proof?invoice=<id>` (read the id from `useSearchParams`). Staff only
(`admin`/`officer`); other roles → `<Navigate to="/invoices" />`.

- Header: invoice ref + transporter (fetch the one invoice: `id, reference_no,
  transporters(display_name)`).
- Upload form: file input (PNG/JPEG/PDF, ≤10 MB), a `received_by` select (HM / CD),
  optional note. On submit:
  1. `supabase.storage.from('documents').upload('receipts/${invoiceId}/${Date.now()}-${file.name}', file, { contentType: file.type })`
  2. `await mustWrite(supabase.from('receipt_proofs').insert({ invoice_id, storage_path: path, received_by, note }).select('id').single(), 'the receipt proof')`
  Reuse the `mustWrite` guard — do not hand-roll error handling.
- List of existing proofs for this invoice (`receipt_proofs` where `invoice_id`),
  each a signed-URL link (`createSignedUrl(path, 3600)`) with received_by + date +
  note; admins get a Delete. Use `tryDownload`/signed URLs, surface load failures.
- A "Back to payment requests" link.

Follow `Settings.tsx`'s upload card for styling and the `busy`/`err`/`msg` pattern.

## 3. Route + Actions button

- `src/App.tsx`: add `<Route path="/receipt-proof" element={<ReceiptProof />} />`
  (import at top). No navbar item — it's reached from the table only.
- `src/pages/Invoices.tsx`, Actions cell (~line 1146), staff only, alongside
  "Approve totals":
  ```tsx
  {(profile?.role === 'admin' || profile?.role === 'officer') && (
    <button
      onClick={(e) => { e.stopPropagation(); navigate(`/receipt-proof?invoice=${inv.id}`); }}
      className="text-[11px] text-[#0d631b] underline"
    >
      Receipt proof
    </button>
  )}
  ```
  Add `const navigate = useNavigate();` (import from `react-router-dom`) in the
  component. `e.stopPropagation()` so the row's select/expand doesn't also fire.

## 4. Verify

`npm run check:migrations && npx tsc --noEmit -p tsconfig.json && npx tsc --noEmit -p tsconfig.functions.json && npm run lint && npm test`, then a build. Manual: as officer, open the page from the table, upload a stamped scan tagged HM, confirm it lists; as that invoice's transporter, confirm the proof is visible on their side but another company's is not.

## Open question for the user

Should uploading a receipt proof also **advance the pipeline stage** (e.g. to
`with_chief_director`), or is it purely an evidence attachment with no stage effect?
This spec does the latter (evidence only) — the safe default. Say so if it should move
the stage.
