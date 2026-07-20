import { useEffect, useRef, useState } from 'react';

interface MfaStepUpModalProps {
  open: boolean;
  onVerify: (code: string) => void;
  onCancel: () => void;
  busy: boolean;
  error: string | null;
}

export default function MfaStepUpModal({ open, onVerify, onCancel, busy, error }: MfaStepUpModalProps) {
  const [code, setCode] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setCode('');
      // Auto-focus after a tick so the modal is in the DOM.
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={onCancel} />
      {/* Card */}
      <div className="relative bg-white rounded-2xl border border-outline-variant shadow-lg p-6 w-full max-w-sm mx-4">
        <div className="flex items-center gap-2 mb-1">
          <span className="material-symbols-outlined text-[#0d631b] text-xl">security</span>
          <h3 className="text-base font-semibold text-on-surface">MFA Verification</h3>
        </div>
        <p className="text-sm text-on-surface-variant mb-4">
          Enter the 6-digit code from your authenticator app to confirm this action.
        </p>

        {error && (
          <div className="mb-3 text-sm text-error bg-error-container p-2.5 rounded-lg">{error}</div>
        )}

        <input
          ref={inputRef}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          onKeyDown={(e) => { if (e.key === 'Enter' && code.length === 6 && !busy) onVerify(code); }}
          placeholder="000000"
          className="w-full border border-outline-variant rounded-lg px-3 py-2.5 text-sm font-mono text-center tracking-[0.3em] outline-none focus:border-[#0d631b] mb-4"
          maxLength={6}
          disabled={busy}
        />

        <div className="flex gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="flex-1 border border-outline-variant rounded-lg py-2.5 text-sm font-medium text-on-surface-variant hover:bg-surface-container-low disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={() => onVerify(code)}
            disabled={busy || code.length !== 6}
            className="flex-1 bg-[#2e7d32] hover:opacity-90 text-white rounded-lg py-2.5 text-sm font-medium disabled:opacity-50"
          >
            {busy ? 'Verifying…' : 'Verify'}
          </button>
        </div>
      </div>
    </div>
  );
}
