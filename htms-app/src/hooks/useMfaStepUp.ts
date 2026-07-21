import { useCallback, useRef, useState } from 'react';

/**
 * Encapsulates the MFA step-up modal pattern used across Invoices, InvoiceStatus,
 * and Settings. Returns the state/refs to wire into `<MfaStepUpModal>` plus a
 * `requestMfaCode()` helper that opens the modal and resolves with the entered
 * code (or null on cancel).
 */
export function useMfaStepUp() {
  const [mfaModalOpen, setMfaModalOpen] = useState(false);
  const [mfaModalBusy, setMfaModalBusy] = useState(false);
  const [mfaModalError, setMfaModalError] = useState<string | null>(null);
  const resolveRef = useRef<((code: string | null) => void) | null>(null);

  const requestMfaCode = useCallback((): Promise<string | null> => {
    return new Promise((resolve) => {
      resolveRef.current = resolve;
      setMfaModalError(null);
      setMfaModalOpen(true);
    });
  }, []);

  const onVerify = useCallback((code: string) => {
    resolveRef.current?.(code);
    resolveRef.current = null;
  }, []);

  const onCancel = useCallback(() => {
    resolveRef.current?.(null);
    resolveRef.current = null;
    setMfaModalOpen(false);
  }, []);

  /** Programmatic close — use after verify succeeds (modal already resolved). */
  const closeModal = useCallback(() => setMfaModalOpen(false), []);

  return {
    mfaModalOpen,
    mfaModalBusy,
    setMfaModalBusy,
    mfaModalError,
    setMfaModalError,
    requestMfaCode,
    onVerify,
    onCancel,
    closeModal,
  } as const;
}
