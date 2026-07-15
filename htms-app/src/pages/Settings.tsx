import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../auth/AuthProvider';

export default function Settings() {
  const { session } = useAuth();
  const [sigUrl, setSigUrl] = useState<string | null>(null);
  const [sigPath, setSigPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  // ── MFA state ──
  const [mfaFactors, setMfaFactors] = useState<{ id: string; friendly_name: string | null; factor_type: string }[]>([]);
  const [qrSvg, setQrSvg] = useState<string | null>(null);
  const [mfaVerifyCode, setMfaVerifyCode] = useState('');
  const [enrollFactorId, setEnrollFactorId] = useState<string | null>(null);
  const [mfaBusy, setMfaBusy] = useState(false);

  // Load signature — keyed on the session user id so an MFA step-up (which
  // refreshes the session and remounts the page) reliably reloads it.
  const uid = session?.user?.id ?? null;
  async function loadSignature(userId: string) {
    const { data } = await supabase.from('app_users').select('signature_path').eq('id', userId).single();
    if (data?.signature_path) {
      setSigPath(data.signature_path);
      const { data: signed } = await supabase.storage.from('documents').createSignedUrl(data.signature_path, 3600);
      if (signed?.signedUrl) setSigUrl(signed.signedUrl);
    }
  }
  useEffect(() => {
    if (uid) loadSignature(uid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid]);

  // Load MFA factors
  useEffect(() => {
    loadFactors();
  }, []);

  async function loadFactors() {
    const { data } = await supabase.auth.mfa.listFactors();
    const totps = (data?.totp ?? []).map((f) => ({ id: f.id, friendly_name: f.friendly_name ?? null, factor_type: f.factor_type }));
    setMfaFactors(totps);
  }

  // ── Signature upload ──
  async function uploadSignature(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { setErr('Signature image must be under 2 MB.'); return; }
    setBusy(true); setErr(null); setMsg(null);
    try {
      const uid = (await supabase.auth.getUser()).data.user?.id;
      if (!uid) throw new Error('Not authenticated');
      const path = `signatures/${uid}.png`;
      const { error: upErr } = await supabase.storage.from('documents').upload(path, file, { contentType: 'image/png', upsert: true });
      if (upErr) throw new Error(upErr.message);
      // .select().single() forces an error if RLS silently matched zero rows.
      const { data: saved, error: dbErr } = await supabase.from('app_users').update({ signature_path: path }).eq('id', uid).select('signature_path').single();
      if (dbErr || !saved) throw new Error(dbErr?.message ?? 'Your signature file was stored but could not be saved to your profile. Contact an admin.');
      setSigPath(path);
      const { data: signed } = await supabase.storage.from('documents').createSignedUrl(path, 3600);
      if (signed?.signedUrl) setSigUrl(signed.signedUrl);
      setMsg('Signature uploaded successfully.');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
      e.target.value = '';
    }
  }

  // ── MFA: enroll ──
  async function startEnroll() {
    setMfaBusy(true); setErr(null); setMsg(null);
    try {
      // An abandoned enroll leaves an unverified factor that blocks re-enrolling
      // under the same friendly name — clean those up first.
      const { data: existing } = await supabase.auth.mfa.listFactors();
      for (const f of existing?.all ?? []) {
        if (f.factor_type === 'totp' && f.status !== 'verified') {
          await supabase.auth.mfa.unenroll({ factorId: f.id });
        }
      }
      const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Authenticator App', issuer: 'HTMS — Ministry of Energy' });
      if (error) throw new Error(error.message);
      setEnrollFactorId(data.id); // listFactors() only returns VERIFIED factors — keep the id from enroll
      setQrSvg(data.totp.qr_code);
      setMfaVerifyCode('');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setMfaBusy(false);
    }
  }

  // ── MFA: challenge + verify (one step) ──
  async function verifyMfa(factorId: string) {
    if (mfaVerifyCode.length !== 6) return;
    setMfaBusy(true); setErr(null);
    try {
      const { data: challengeData, error: chErr } = await supabase.auth.mfa.challenge({ factorId });
      if (chErr) throw new Error(chErr.message);
      const { error: vErr } = await supabase.auth.mfa.verify({ factorId, challengeId: challengeData.id, code: mfaVerifyCode });
      if (vErr) throw new Error(vErr.message);
      setMsg('MFA factor verified and enrolled.');
      setQrSvg(null);
      setMfaVerifyCode('');
      setEnrollFactorId(null);
      loadFactors();
      if (uid) loadSignature(uid); // session was refreshed by the verify — re-confirm the signature display
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setMfaBusy(false);
    }
  }

  // ── MFA: unenroll ──
  async function unenroll(factorId: string) {
    if (!window.confirm('Remove this authenticator factor? You will need to re-enroll to sign documents.')) return;
    setMfaBusy(true); setErr(null);
    try {
      const { error } = await supabase.auth.mfa.unenroll({ factorId });
      if (error) throw new Error(error.message);
      setMsg('Factor removed.');
      loadFactors();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setMfaBusy(false);
    }
  }

  const hasSig = !!sigPath;
  const hasMfa = mfaFactors.length > 0;

  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-2xl font-semibold text-on-surface mb-5">Settings</h1>

      {err && <div className="mb-4 text-sm text-error bg-error-container p-3 rounded-lg flex items-center gap-2">{err}</div>}
      {msg && <div className="mb-4 text-sm text-[#0d631b] bg-[#e8f5e9] p-3 rounded-lg flex items-center gap-2">{msg}</div>}

      {/* Signing readiness */}
      {sigPath && mfaFactors.length > 0 && (
        <div className="mb-4 text-sm text-[#0c5216] bg-[#e8f5e9] border border-[#0d631b]/30 p-3 rounded-lg flex items-center gap-2">
          <span className="material-symbols-outlined text-[18px]">verified</span>
          Signature and MFA are set up — you can sign documents.
        </div>
      )}

      {/* Signature card */}
      <div className="bg-white rounded-xl border border-outline-variant p-5 mb-5">
        <h2 className="text-lg font-semibold text-on-surface mb-1 flex items-center gap-2">
          <span className="material-symbols-outlined text-[#0d631b]">draw</span>
          My Signature
        </h2>
        <p className="text-sm text-on-surface-variant mb-4">
          Upload a PNG/JPEG of your handwritten signature. This will be applied to documents you sign electronically.
        </p>

        {sigUrl ? (
          <div className="flex items-center gap-4 mb-4">
            <div className="border border-outline-variant rounded-lg p-3 bg-surface">
              <img src={sigUrl} alt="Your signature" className="h-16 object-contain" />
            </div>
            <div>
              <p className="text-sm font-medium text-on-surface">Signature on file</p>
              <label className="mt-2 inline-flex items-center gap-1 text-sm text-[#0d631b] cursor-pointer hover:underline">
                <span className="material-symbols-outlined text-sm">upload</span>
                Replace
                <input type="file" accept="image/png,image/jpeg" className="hidden" onChange={uploadSignature} disabled={busy} />
              </label>
            </div>
          </div>
        ) : (
          <label className="flex items-center gap-3 p-4 border-2 border-dashed border-outline-variant rounded-xl cursor-pointer hover:bg-surface-container-low transition-colors">
            <span className="material-symbols-outlined text-3xl text-outline">add_photo_alternate</span>
            <div>
              <p className="text-sm font-medium text-on-surface">Upload signature image</p>
              <p className="text-xs text-on-surface-variant">PNG or JPEG, max 2 MB</p>
            </div>
            <input type="file" accept="image/png,image/jpeg" className="hidden" onChange={uploadSignature} disabled={busy} />
          </label>
        )}
      </div>

      {/* MFA card */}
      <div className="bg-white rounded-xl border border-outline-variant p-5">
        <h2 className="text-lg font-semibold text-on-surface mb-1 flex items-center gap-2">
          <span className="material-symbols-outlined text-[#0d631b]">security</span>
          Multi-Factor Authentication (MFA)
        </h2>
        <p className="text-sm text-on-surface-variant mb-4">
          MFA is required to sign documents. Enroll an authenticator app (Google Authenticator, Authy, etc.) using TOTP.
        </p>

        {mfaFactors.length > 0 && (
          <div className="mb-4 space-y-2">
            <p className="text-sm font-medium text-on-surface">Enrolled factors:</p>
            {mfaFactors.map((f) => (
              <div key={f.id} className="flex items-center justify-between p-3 bg-surface rounded-lg border border-outline-variant">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-[#0d631b]">verified_user</span>
                  <span className="text-sm">{f.friendly_name ?? 'Authenticator App'}</span>
                </div>
                <button
                  onClick={() => unenroll(f.id)}
                  disabled={mfaBusy}
                  className="text-xs text-error hover:underline disabled:opacity-50"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}

        {qrSvg ? (
          <div className="mt-4 p-4 border border-outline-variant rounded-xl">
            <p className="text-sm font-medium mb-2">Scan this QR code with your authenticator app:</p>
            <div className="flex justify-center mb-4">
              <img src={qrSvg} alt="MFA QR Code" className="w-48 h-48" />
            </div>
            <p className="text-sm mb-2">Enter the 6-digit code from your app:</p>
            <div className="flex gap-2">
              <input
                value={mfaVerifyCode}
                onChange={(e) => setMfaVerifyCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="000000"
                className="border border-outline-variant rounded-lg px-3 py-2 text-sm font-mono w-32 outline-none focus:border-[#0d631b]"
                maxLength={6}
              />
              <button
                onClick={() => { if (enrollFactorId) verifyMfa(enrollFactorId); }}
                disabled={mfaBusy || mfaVerifyCode.length !== 6 || !enrollFactorId}
                className="bg-[#2e7d32] hover:opacity-90 text-white rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50"
              >
                {mfaBusy ? 'Verifying…' : 'Verify & Activate'}
              </button>
            </div>
            <button onClick={() => { setQrSvg(null); setEnrollFactorId(null); setMfaVerifyCode(''); }} className="mt-3 text-xs text-outline hover:underline">
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={startEnroll}
            disabled={mfaBusy}
            className="flex items-center gap-2 bg-[#2e7d32] hover:opacity-90 text-white rounded-lg px-4 py-2.5 text-sm font-medium disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-[18px]">qr_code_2</span>
            {mfaBusy ? 'Working…' : hasMfa ? 'Enroll Another Factor' : 'Enroll Authenticator App'}
          </button>
        )}

        {!hasSig && (
          <p className="mt-3 text-xs text-error">
            You must upload a signature before you can sign documents.
          </p>
        )}
        {!hasMfa && (
          <p className="mt-1 text-xs text-error">
            You must enroll MFA before you can sign documents.
          </p>
        )}
      </div>
    </div>
  );
}
