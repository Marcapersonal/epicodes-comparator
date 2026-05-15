const express = require('express');
const router  = express.Router();
const { getDb, getGiftCardRate } = require('../db/database');

// GET /api/watchlist
router.get('/', (_req, res) => {
  const rows = getDb().prepare(`
    SELECT w.*, ah.new_price as last_alert_price, ah.sent_at as last_alert_sent
    FROM watchlist w
    LEFT JOIN alert_history ah ON ah.watchlist_id = w.id
      AND ah.sent_at = (SELECT MAX(sent_at) FROM alert_history WHERE watchlist_id = w.id)
    ORDER BY w.added_at DESC
  `).all();
  res.json({ items: rows, giftCardRate: getGiftCardRate() });
});

// POST /api/watchlist — add game
router.post('/', (req, res) => {
  const { game_name, psdeals_url, turkey_url } = req.body;
  if (!game_name) return res.status(400).json({ error: 'game_name requerido' });
  const db = getDb();
  const existing = db.prepare('SELECT id FROM watchlist WHERE game_name = ?').get(game_name);
  if (existing) return res.json({ id: existing.id, already: true });
  const result = db.prepare(
    'INSERT INTO watchlist (game_name, psdeals_url, turkey_url, added_at) VALUES (?, ?, ?, ?)'
  ).run(game_name, psdeals_url || null, turkey_url || null, new Date().toISOString());
  res.json({ id: result.lastInsertRowid });
});

// DELETE /api/watchlist/:id
router.delete('/:id', (req, res) => {
  getDb().prepare('DELETE FROM watchlist WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// PUT /api/watchlist/:id/alert — set price alert
router.put('/:id/alert', (req, res) => {
  const { alert_price, alert_enabled } = req.body;
  getDb().prepare(
    'UPDATE watchlist SET alert_price = ?, alert_enabled = ? WHERE id = ?'
  ).run(alert_price ?? null, alert_enabled ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

module.exports = router;
