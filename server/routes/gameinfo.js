// This route is kept for potential future use but language info is now managed via catalog.
// The /api/catalog endpoint returns spanish_audio and spanish_text per game.
const express = require('express');
const router  = express.Router();

router.get('/', (_req, res) => {
  res.json({ spanishAudio: false, spanishText: false, source: 'manual' });
});

module.exports = router;
