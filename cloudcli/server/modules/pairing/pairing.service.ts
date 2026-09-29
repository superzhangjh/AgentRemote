import { randomBytes } from 'node:crypto';

const pairs = new Map<string, { expiresAt: number; claimed: boolean }>();
const lifetimeMs = 5 * 60 * 1000;

function pruneExpired(now: number): void {
  for (const [token, pair] of pairs) {
    if (pair.expiresAt <= now) pairs.delete(token);
  }
}

/** Used by the pairing routes to issue a short-lived, single-use console QR code. */
export function beginPairing(now = Date.now()): string | null {
  pruneExpired(now);
  if (pairs.size >= 128) return null;
  const token = randomBytes(16).toString('hex');
  pairs.set(token, { expiresAt: now + lifetimeMs, claimed: false });
  return token;
}

/** Used by the mobile app after its WebView has opened the scanned server. */
export function claimPairing(token: string, now = Date.now()): boolean {
  pruneExpired(now);
  const pair = pairs.get(token);
  if (!pair || pair.claimed) return false;
  pair.claimed = true;
  return true;
}

/** Used by the console to stop showing a QR code once a phone has claimed it. */
export function pairingStatus(token: string, now = Date.now()): 'pending' | 'claimed' | 'missing' {
  pruneExpired(now);
  const pair = pairs.get(token);
  if (!pair) return 'missing';
  if (!pair.claimed) return 'pending';
  pairs.delete(token);
  return 'claimed';
}

/** Used by the console when the user closes a QR code before it is scanned. */
export function cancelPairing(token: string): void {
  pairs.delete(token);
}
