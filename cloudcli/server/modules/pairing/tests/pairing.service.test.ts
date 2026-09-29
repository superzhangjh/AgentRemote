import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { beginPairing, cancelPairing, claimPairing, pairingStatus } from '@/modules/pairing/pairing.service.js';

describe('one-time QR pairing', () => {
  it('claims once and consumes the result when the console checks it', () => {
    const token = beginPairing(1000)!;
    assert.equal(pairingStatus(token, 1000), 'pending');
    assert.equal(claimPairing(token, 1000), true);
    assert.equal(claimPairing(token, 1000), false);
    assert.equal(pairingStatus(token, 1000), 'claimed');
    assert.equal(pairingStatus(token, 1000), 'missing');
  });

  it('expires and can be cancelled', () => {
    const expired = beginPairing(1000)!;
    assert.equal(claimPairing(expired, 301001), false);
    const cancelled = beginPairing(400000)!;
    cancelPairing(cancelled);
    assert.equal(pairingStatus(cancelled, 400000), 'missing');
  });
});
