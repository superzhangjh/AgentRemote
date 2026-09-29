import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import express from 'express';

import pairingRoutes from '@/modules/pairing/pairing.routes.js';

const app = express();
app.use(express.json());
app.use('/api/desktop-pairing', pairingRoutes);
const server = app.listen(0);
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Test server did not bind');
const base = `http://127.0.0.1:${address.port}/api/desktop-pairing`;
after(() => server.close());

test('a phone claim removes the console QR after one status check', async () => {
  const created = await fetch(`${base}/start`, { method: 'POST' });
  assert.equal(created.status, 200);
  const { token } = await created.json() as { token: string };
  const claim = await fetch(`${base}/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  assert.equal(claim.status, 200);
  const status = await fetch(`${base}/status/${token}`);
  assert.equal((await status.json() as { status: string }).status, 'claimed');
  assert.equal((await fetch(`${base}/status/${token}`)).status, 404);
});
