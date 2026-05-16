const express = require('express');
const router  = express.Router();
const { getCatalog, addToCatalog, removeFromCatalog } = require('../db/database');

router.get('/', (_req, res) => {
  const games = getCatalog();
  res.json({ games, total: games.length });
});

router.post('/', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  const result = addToCatalog(name);
  res.json(result);
});

router.delete('/:id', (req, res) => {
  removeFromCatalog(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
