import { Router } from 'express';

import { beginPairing, cancelPairing, claimPairing, pairingStatus } from '@/modules/pairing/pairing.service.js';

const router = Router();
const validToken = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);

router.post('/start', (_req, res) => {
  const token = beginPairing();
  if (!token) return res.status(429).json({ error: 'Too many active QR codes' });
  return res.json({ token });
});

router.post('/claim', (req, res) => {
  const token: unknown = req.body?.token;
  if (!validToken(token) || !claimPairing(token)) return res.status(404).json({ error: 'QR code expired' });
  return res.json({ success: true });
});

router.get('/status/:token', (req, res) => {
  const token: unknown = req.params.token;
  if (!validToken(token)) return res.status(404).json({ error: 'QR code expired' });
  const status = pairingStatus(token);
  if (status === 'missing') return res.status(404).json({ error: 'QR code expired' });
  return res.json({ status });
});

router.delete('/:token', (req, res) => {
  const token: unknown = req.params.token;
  if (validToken(token)) cancelPairing(token);
  return res.status(204).end();
});

export default router;
