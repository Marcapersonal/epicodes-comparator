/**
 * PlatPrices routes
 *
 * GET  /api/platprices/status          — seed job status + DB stats
 * POST /api/platprices/seed            — start background seed job
 * GET  /api/platprices/progress/:jobId — SSE stream for seed progress
 */
const express  = require('express');
const router   = express.Router();
const { v4: uuidv4 } = require('uuid');
const { getCatalog, getDb } = require('../db/database');
const { getSeedStatus, runSeedJob } = require('../services/platprices');

// SSE clients per jobId
const progressClients = new Map();

function broadcast(jobId, data) {
  const clients = progressClients.get(jobId);
  if (!clients) return;
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) try { res.write(msg); } catch (_) {}
}

// ── GET /api/platprices/status ────────────────────────────────────────────────
router.get('/status', (_req, res) => {
  const active       = getSeedStatus();
  const keyConfigured = !!(process.env.PLATPRICES_KEY);

  let stats = null;
  try {
    const db = getDb();
    const total    = db.prepare('SELECT COUNT(*) as n FROM platprices_cache').get();
    const withSale = db.prepare("SELECT COUNT(*) as n FROM platprices_cache WHERE last_discounted IS NOT NULL").get();
    const onSale   = db.prepare(`
      SELECT COUNT(*) as n FROM platprices_cache
      WHERE discount_until IS NOT NULL AND discount_until > datetime('now')
    `).get();
    stats = { total: total.n, withSale: withSale.n, onSale: onSale.n };
  } catch (_) {}

  res.json({ active, stats, keyConfigured });
});

// ── GET /api/platprices/progress/:jobId — SSE stream ──────────────────────────
router.get('/progress/:jobId', (req, res) => {
  const { jobId } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  if (!progressClients.has(jobId)) progressClients.set(jobId, new Set());
  progressClients.get(jobId).add(res);

  const current = getSeedStatus();
  if (current) res.write(`data: ${JSON.stringify(current)}\n\n`);

  req.on('close', () => progressClients.get(jobId)?.delete(res));
});

// ── POST /api/platprices/seed — start seed ────────────────────────────────────
router.post('/seed', (req, res) => {
  const status = getSeedStatus();
  if (status?.status === 'running') {
    return res.status(409).json({ error: 'Ya hay un job en curso', active: status });
  }

  const games = getCatalog().map(g => g.name);
  const jobId = uuidv4();
  res.json({ jobId, total: games.length });

  runSeedJob(games, (data) => broadcast(jobId, data))
    .catch(err => {
      console.error('PlatPrices seed error:', err);
      broadcast(jobId, { status: 'error', message: err.message });
    })
    .finally(() => setTimeout(() => progressClients.delete(jobId), 60_000));
});

module.exports = router;
