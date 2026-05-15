const express = require('express');
const router  = express.Router();
const { getDb } = require('../db/database');

router.get('/', (_req, res) => {
  const rows = getDb().prepare(
    'SELECT * FROM alert_history ORDER BY sent_at DESC LIMIT 100'
  ).all();
  res.json({ alerts: rows });
});

module.exports = router;
