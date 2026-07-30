# RLS tests

`rls.test.ts` asserts the access matrix as each of the six roles. It exists because
every recent production bug was a policy that silently allowed or denied the wrong
thing, and none of them were catchable by the unit tests.

## Never run this against production

It creates and deletes users, transporters, waybills, invoices and files. Use a
disposable project or the local stack.

## Option A — local stack (recommended)

```bash
supabase start                       # from the repo root
supabase db reset                    # applies every migration in order
```

`supabase start` prints the API URL and the anon/service keys. Then:

```bash
cd htms-app
SUPABASE_TEST_URL=http://127.0.0.1:54321 \
SUPABASE_TEST_ANON_KEY=<anon key> \
SUPABASE_TEST_SERVICE_KEY=<service_role key> \
npx vitest run supabase/tests/rls.test.ts
```

## Option B — a throwaway cloud project

Create a second Supabase project, apply every migration in filename order, then use
its URL and keys in the same three variables. Add them to the GitHub repo secrets
(`SUPABASE_TEST_URL`, `SUPABASE_TEST_ANON_KEY`, `SUPABASE_TEST_SERVICE_KEY`) so the
CI step runs on pushes to `main`.

Without the variables the suite skips itself and `npm test` stays green.

## Prerequisites in the test database

The seed must provide at least one row in `origins`, `districts` and `rate_versions`
(the standard seed does). Email confirmation should be off, or `createUser` with
`email_confirm: true` handles it as the tests already do.

## Adding cases

Any migration that adds or changes a policy gets a case here. The shape to copy:
act as the role, attempt the operation, and assert on **rows affected**, not just on
`error` — a denied write returns `{ data: [], error: null }`, which is exactly the
silent failure this suite exists to catch.
