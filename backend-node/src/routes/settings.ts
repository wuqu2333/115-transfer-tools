import { Router } from 'express';
import { getSettings, updateSettings } from '../db';

export const router = Router();

router.get('/settings', (_req, res) => {
  res.json(getSettings());
});

router.put('/settings', (req, res) => {
  const updated = updateSettings(req.body || {});
  res.json(updated);
});
