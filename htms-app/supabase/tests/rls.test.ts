/**
 * RLS access-matrix tests — the layer where every recent production bug lived.
 *
 * Runs against a DISPOSABLE Supabase project or a local `supabase start` stack.
 * NEVER point these at production: the suite creates and deletes users and rows.
 *
 *   SUPABASE_TEST_URL=http://127.0.0.1:54321 \
 *   SUPABASE_TEST_ANON_KEY=... \
 *   SUPABASE_TEST_SERVICE_KEY=... \
 *   npx vitest run supabase/tests/rls.test.ts
 *
 * Without those env vars the whole suite is skipped, so `npm test` stays green
 * for anyone who just wants to run the unit tests.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const URL = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const configured = Boolean(URL && ANON && SERVICE);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const svc: SupabaseClient = configured ? createClient(URL!, SERVICE!, { auth: { persistSession: false } }) : (null as any);

const PW = 'TestPassw0rd!42';
const tag = `rlstest_${Date.now()}`;
const email = (who: string) => `${tag}_${who}@example.test`;

type Role = 'admin' | 'officer' | 'deputy_director' | 'director' | 'transporter';
interface Actor { id: string; email: string; client: SupabaseClient }

const actors: Record<string, Actor> = {};
const ids: Record<string, string> = {}; // seeded row ids

/** Create an auth user + app_users profile, and return a client signed in as them. */
async function makeActor(who: string, role: Role, transporterId: string | null): Promise<Actor> {
  const mail = email(who);
  const { data: created, error } = await svc.auth.admin.createUser({
    email: mail, password: PW, email_confirm: true,
  });
  if (error || !created.user) throw new Error(`create ${who}: ${error?.message}`);
  const { error: upErr } = await svc.from('app_users').upsert(
    { id: created.user.id, role, transporter_id: transporterId, full_name: `RLS ${who}` },
    { onConflict: 'id' },
  );
  if (upErr) throw new Error(`profile ${who}: ${upErr.message}`);

  const client = createClient(URL!, ANON!, { auth: { persistSession: false } });
  const { error: signErr } = await client.auth.signInWithPassword({ email: mail, password: PW });
  if (signErr) throw new Error(`sign in ${who}: ${signErr.message}`);
  return { id: created.user.id, email: mail, client };
}

describe.skipIf(!configured)('RLS access matrix', () => {
  beforeAll(async () => {
    // ── Two transporter companies, so cross-tenant leakage is detectable ──
    const { data: tA } = await svc.from('transporters').insert({ display_name: `${tag} Alpha Haulage` }).select('id').single();
    const { data: tB } = await svc.from('transporters').insert({ display_name: `${tag} Beta Haulage` }).select('id').single();
    ids.tA = tA!.id; ids.tB = tB!.id;

    actors.admin = await makeActor('admin', 'admin', null);
    actors.officer = await makeActor('officer', 'officer', null);
    actors.dd = await makeActor('dd', 'deputy_director', null);
    actors.dir = await makeActor('dir', 'director', null);
    actors.transA = await makeActor('transA', 'transporter', ids.tA);
    actors.transB = await makeActor('transB', 'transporter', ids.tB);

    // Reference data the seed migrations already provide; grab the first of each.
    const { data: origin } = await svc.from('origins').select('id').limit(1).single();
    const { data: district } = await svc.from('districts').select('id').limit(1).single();
    const { data: rv } = await svc.from('rate_versions').select('id').limit(1).single();

    // One waybill + invoice for transporter A.
    const { data: wb, error: wbErr } = await svc.from('waybills').insert({
      transporter_id: ids.tA, category: 'Poles', waybill_no: `${tag}-WB1`, vehicle_no: 'GT-1234-24',
      origin_id: origin!.id, district_id: district!.id, num_poles: 10, num_trips: 1,
      waybill_date: '2026-01-15', created_by: actors.officer.id,
    }).select('id').single();
    if (wbErr) throw new Error(`seed waybill: ${wbErr.message}`);
    ids.waybill = wb!.id;

    const { data: inv, error: invErr } = await svc.from('invoices').insert({
      transporter_id: ids.tA, rate_version_id: rv!.id, total_cost: 1000,
      reference_no: `${tag}-INV1`, created_by: actors.officer.id,
    }).select('id').single();
    if (invErr) throw new Error(`seed invoice: ${invErr.message}`);
    ids.invoice = inv!.id;

    // A scan row + its file, so storage-bucket access is exercised for real.
    ids.scanPath = `${ids.tA}/${ids.waybill}/waybill-${Date.now()}.png`;
    await svc.storage.from('scans').upload(ids.scanPath, new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), { contentType: 'image/png' });
    await svc.from('scans').insert({
      waybill_id: ids.waybill, storage_path: ids.scanPath, mime_type: 'image/png',
      byte_size: 3, uploaded_by: actors.officer.id, scan_type: 'waybill',
    });
  }, 60_000);

  afterAll(async () => {
    if (!configured) return;
    await svc.storage.from('scans').remove([ids.scanPath]).catch(() => {});
    await svc.from('scans').delete().eq('waybill_id', ids.waybill);
    await svc.from('invoice_signatures').delete().eq('invoice_id', ids.invoice);
    await svc.from('invoices').delete().eq('id', ids.invoice);
    await svc.from('waybills').delete().eq('id', ids.waybill);
    for (const a of Object.values(actors)) {
      await svc.from('app_users').delete().eq('id', a.id);
      await svc.auth.admin.deleteUser(a.id).catch(() => {});
    }
    await svc.from('transporters').delete().in('id', [ids.tA, ids.tB]);
  }, 60_000);

  // ── Tenant isolation ──────────────────────────────────────────────────────
  describe('transporter isolation', () => {
    it('reads its own invoice', async () => {
      const { data } = await actors.transA.client.from('invoices').select('id').eq('id', ids.invoice);
      expect(data).toHaveLength(1);
    });

    it("cannot read another company's invoice", async () => {
      const { data } = await actors.transB.client.from('invoices').select('id').eq('id', ids.invoice);
      expect(data ?? []).toHaveLength(0);
    });

    it("cannot read another company's waybills", async () => {
      const { data } = await actors.transB.client.from('waybills').select('id').eq('id', ids.waybill);
      expect(data ?? []).toHaveLength(0);
    });

    it("cannot download another company's scan file", async () => {
      const { data } = await actors.transB.client.storage.from('scans').download(ids.scanPath);
      expect(data).toBeNull();
    });
  });

  // ── Reviewer roles: read everything, write nothing (0020) ─────────────────
  describe.each([['deputy_director', 'dd'], ['director', 'dir']])('%s', (_role, key) => {
    it('reads any invoice', async () => {
      const { data } = await actors[key].client.from('invoices').select('id').eq('id', ids.invoice);
      expect(data).toHaveLength(1);
    });

    it('reads scan rows', async () => {
      const { data } = await actors[key].client.from('scans').select('id').eq('waybill_id', ids.waybill);
      expect(data).toHaveLength(1);
    });

    // The 0020 regression: table access without bucket access silently emptied
    // the reviewers' merged "Payment request documentation" PDF.
    it('DOWNLOADS the scan file', async () => {
      const { data, error } = await actors[key].client.storage.from('scans').download(ids.scanPath);
      expect(error).toBeNull();
      expect(data).not.toBeNull();
    });

    it('cannot modify an invoice', async () => {
      const { data } = await actors[key].client.from('invoices').update({ total_cost: 1 }).eq('id', ids.invoice).select('id');
      expect(data ?? []).toHaveLength(0);
    });
  });

  // ── Self-service columns (0022 / 0023) ────────────────────────────────────
  describe('self-update guards', () => {
    it('a transporter can save its own signature_path', async () => {
      const path = `signatures/${actors.transA.id}.png`;
      const { data } = await actors.transA.client.from('app_users')
        .update({ signature_path: path }).eq('id', actors.transA.id).select('signature_path').single();
      expect(data?.signature_path).toBe(path);
    });

    it('a non-admin CANNOT promote itself', async () => {
      const { error } = await actors.transA.client.from('app_users')
        .update({ role: 'admin' }).eq('id', actors.transA.id).select('id').single();
      expect(error).not.toBeNull(); // trigger raises
      const { data: check } = await svc.from('app_users').select('role').eq('id', actors.transA.id).single();
      expect(check?.role).toBe('transporter');
    });

    it('a non-admin CANNOT move itself to another company', async () => {
      const { error } = await actors.transA.client.from('app_users')
        .update({ transporter_id: ids.tB }).eq('id', actors.transA.id).select('id').single();
      expect(error).not.toBeNull();
    });

    it("cannot edit another user's profile", async () => {
      const { data } = await actors.transA.client.from('app_users')
        .update({ full_name: 'hacked' }).eq('id', actors.transB.id).select('id');
      expect(data ?? []).toHaveLength(0);
    });

    it('a transporter can save its own letterhead but not another company\'s', async () => {
      const ok = await actors.transA.client.from('transporters')
        .update({ letterhead_path: `letterheads/${ids.tA}.png` }).eq('id', ids.tA).select('id').single();
      expect(ok.data).not.toBeNull();

      const bad = await actors.transA.client.from('transporters')
        .update({ letterhead_path: 'x' }).eq('id', ids.tB).select('id');
      expect(bad.data ?? []).toHaveLength(0);
    });

    it('a transporter cannot edit other columns on its own company row', async () => {
      const { error } = await actors.transA.client.from('transporters')
        .update({ display_name: 'renamed by tenant' }).eq('id', ids.tA).select('id').single();
      expect(error).not.toBeNull();
    });
  });

  // ── Signatures are service-role only ──────────────────────────────────────
  describe('invoice_signatures', () => {
    it('cannot be inserted directly by an authed user', async () => {
      const { data, error } = await actors.transA.client.from('invoice_signatures')
        .insert({ invoice_id: ids.invoice, slot: 'transporter', user_id: actors.transA.id }).select('slot');
      expect(error ?? (data ?? []).length === 0).toBeTruthy();
    });

    it('is readable by staff and by the owning transporter', async () => {
      await svc.from('invoice_signatures').insert({ invoice_id: ids.invoice, slot: 'prepared', user_id: actors.officer.id });
      const mine = await actors.transA.client.from('invoice_signatures').select('slot').eq('invoice_id', ids.invoice);
      expect(mine.data).toHaveLength(1);
      const theirs = await actors.transB.client.from('invoice_signatures').select('slot').eq('invoice_id', ids.invoice);
      expect(theirs.data ?? []).toHaveLength(0);
    });
  });

  // ── Storage path ownership (0021 / 0024) ──────────────────────────────────
  describe('signature files', () => {
    const png = () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });

    it('a user can upload and replace their own signature', async () => {
      const path = `signatures/${actors.transA.id}.png`;
      const first = await actors.transA.client.storage.from('documents').upload(path, png(), { contentType: 'image/png', upsert: true });
      expect(first.error).toBeNull();
      const replace = await actors.transA.client.storage.from('documents').upload(path, png(), { contentType: 'image/png', upsert: true });
      expect(replace.error).toBeNull();
      await svc.storage.from('documents').remove([path]);
    });

    it("a user cannot write to another user's signature path", async () => {
      const { error } = await actors.transB.client.storage.from('documents')
        .upload(`signatures/${actors.transA.id}.png`, png(), { contentType: 'image/png', upsert: true });
      expect(error).not.toBeNull();
    });
  });
});
