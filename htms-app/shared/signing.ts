/**
 * Pure signing logic — slot derivation + ordering rules.
 * Imported by both the Netlify function and the client.
 * Do NOT add I/O here.
 */

export type UserRole = 'admin' | 'officer' | 'transporter' | 'deputy_director' | 'director';

export type SignSlot = 'transporter' | 'prepared' | 'checked' | 'approved';

/** Ordered slots — index position determines precedence. */
const SLOT_ORDER: SignSlot[] = ['prepared', 'checked', 'approved'];

/**
 * Derive which slot a role signs. Returns null for roles that don't sign via
 * the staff "Approve" button (transporters sign via their own flow).
 */
export function roleToSlot(role: UserRole): SignSlot | null {
  switch (role) {
    case 'officer':
    case 'admin':
      return 'prepared';
    case 'deputy_director':
      return 'checked';
    case 'director':
      return 'approved';
    case 'transporter':
      return 'transporter';
    default:
      return null;
  }
}

/**
 * Is the given slot allowed to be signed, given the already-signed slots?
 * Enforces:
 *   - 'prepared' has no prerequisite
 *   - 'checked' requires 'prepared' to exist
 *   - 'approved' requires 'checked' to exist
 *   - 'transporter' requires the invoice to be submission-ready (caller must
 *     separately verify checklist/review gate)
 */
export function canSignSlot(slot: SignSlot, signedSlots: SignSlot[]): boolean {
  if (slot === 'transporter') return true; // caller checks submission gate separately
  const idx = SLOT_ORDER.indexOf(slot);
  if (idx <= 0) return true; // 'prepared' or unknown → no prerequisite
  const prevSlot = SLOT_ORDER[idx - 1];
  return signedSlots.includes(prevSlot);
}

/**
 * Check if a specific slot is already signed.
 */
export function isSlotSigned(slot: SignSlot, signedSlots: SignSlot[]): boolean {
  return signedSlots.includes(slot);
}

/** Is the role a reviewer (read-only except signing)? */
export function isReviewerRole(role: UserRole): boolean {
  return role === 'deputy_director' || role === 'director';
}

/** Is the role staff (can do officer/admin things)? */
export function isStaffRole(role: UserRole): boolean {
  return role === 'admin' || role === 'officer' || role === 'deputy_director' || role === 'director';
}
