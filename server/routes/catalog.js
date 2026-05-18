const express = require('express');
const router  = express.Router();
const Fuse    = require('fuse.js');

const {
  getDb,
  getGameCatalog, getGameCatalogById,
  addGameCatalogEntry, updateGameCatalogEntry,
  validateGameCatalogEntry, excludeGameCatalogEntry,
  countUnvalidated,
  // legacy (still needed by bulk.js fallback)
  getCatalog, addToCatalog, removeFromCatalog, updateCatalogLang,
  getLangCache, setLangCache,
  getAltRegion,
} = require('../db/database');

const { searchSonyForEditions, searchSonyAltRegion } = require('../scrapers/psstore');
const { searchGamesTurkey }                           = require('../scrapers/gamesturkey');

// ── GET /api/catalog ──────────────────────────────────────────────────────────
// Returns all non-excluded game_catalog entries (new system)
// Backward-compat shape: each row has { id, name, display_name, ... }
router.get('/', (req, res) => {
  const includeExcluded = req.query.all === '1';
  const games = getGameCatalog({ includeExcluded });
  res.json({ games, total: games.length });
});

// ── GET /api/catalog/unvalidated-count ───────────────────────────────────────
router.get('/unvalidated-count', (_req, res) => {
  res.json({ count: countUnvalidated() });
});

// ── POST /api/catalog/preview ─────────────────────────────────────────────────
// Search Sony US for a game name and return all editions found (no insertion).
// Used by the "Agregar juego" modal to show edition checkboxes.
router.post('/preview', async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });

  try {
    const editions = await searchSonyForEditions(name);
    res.json({ query: name, editions });
  } catch (err) {
    console.error('[catalog/preview]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/catalog/add ─────────────────────────────────────────────────────
// Confirm selected editions and insert into game_catalog.
// For each edition: also searches Turkey + alt region.
// Body: { editions: [ { display_name, edition, base_title, sony_us_url, sony_us_confidence, sony_us_price } ] }
router.post('/add', async (req, res) => {
  const { editions } = req.body;
  if (!Array.isArray(editions) || !editions.length) {
    return res.status(400).json({ error: 'editions array required' });
  }

  const altRegion = getAltRegion();
  const results   = [];

  for (const ed of editions) {
    const display_name       = (ed.display_name || '').trim();
    const base_title         = (ed.base_title || display_name).toLowerCase().trim();
    const edition            = ed.edition || null;
    const sony_us_url        = ed.sony_us_url || null;
    const sony_us_confidence = ed.sony_us_confidence ?? 0;

    if (!display_name) continue;

    // ── Search Turkey ────────────────────────────────────────────────────────
    let turkey_url        = null;
    let turkey_confidence = 0;

    try {
      const tkResult = await searchGamesTurkey(display_name);
      if (tkResult.found) {
        turkey_url        = tkResult.url;
        turkey_confidence = tkResult.turkey_confidence ?? 70;
      }
    } catch (_) {}

    // ── Search alt region ────────────────────────────────────────────────────
    let sony_alt_url        = null;
    let sony_alt_confidence = 0;

    if (sony_us_url && altRegion !== 'US') {
      try {
        const altResult = await searchSonyAltRegion(display_name, altRegion);
        if (altResult) {
          sony_alt_url        = altResult.sony_alt_url;
          sony_alt_confidence = altResult.sony_alt_confidence;
        }
      } catch (_) {}
    }

    // ── Auto-validate if all confidences are good ────────────────────────────
    const allHigh = sony_us_confidence >= 70 &&
                    (turkey_url ? turkey_confidence >= 70 : true) &&
                    (sony_alt_url ? sony_alt_confidence >= 70 : true);
    const validated_at = allHigh ? new Date().toISOString() : null;
    const validated_by = allHigh ? 'auto' : null;

    // Derive PSDeals URL from display_name
    const slug       = display_name.toLowerCase().replace(/[™®:]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const psdeals_url = `https://psdeals.net/us-store/game/${slug}`;

    const entry = addGameCatalogEntry({
      base_title, edition, display_name,
      sony_us_url, sony_alt_url, sony_alt_region: altRegion !== 'US' ? altRegion : null,
      turkey_url,
      sony_us_confidence, sony_alt_confidence, turkey_confidence,
      validated_at, validated_by,
      is_full_game: 1, excluded: 0,
      psdeals_url,
    });

    // Also keep the legacy catalog in sync (for bulk.js fallback)
    try { addToCatalog(display_name); } catch (_) {}

    results.push({
      id:          entry.id,
      created:     entry.created,
      display_name,
      edition,
      sony_us_url,
      turkey_url,
      sony_alt_url,
      validated_at,
      turkey_confidence,
      sony_alt_confidence,
    });
  }

  res.json({ added: results.filter(r => r.created).length, results });
});

// ── POST /api/catalog/validate/:id ───────────────────────────────────────────
router.post('/validate/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'invalid id' });
  validateGameCatalogEntry(id, 'user');
  res.json({ ok: true, id });
});

// ── PUT /api/catalog/:id ──────────────────────────────────────────────────────
// Manually edit any URL/field on a catalog entry
router.put('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'invalid id' });

  const allowed = [
    'display_name', 'edition', 'base_title',
    'sony_us_url', 'sony_alt_url', 'sony_alt_region', 'turkey_url',
    'sony_us_confidence', 'sony_alt_confidence', 'turkey_confidence',
    'psdeals_url', 'excluded', 'is_full_game',
    'spanish_audio', 'spanish_text',
  ];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  if (!Object.keys(updates).length) return res.status(400).json({ error: 'no fields to update' });

  updateGameCatalogEntry(id, updates);
  res.json({ ok: true, id });
});

// ── DELETE /api/catalog/:id ───────────────────────────────────────────────────
router.delete('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'invalid id' });
  excludeGameCatalogEntry(id);
  // Also deactivate in legacy catalog
  try { removeFromCatalog(id); } catch (_) {}
  res.json({ ok: true });
});

// ── Legacy routes for backward compatibility ───────────────────────────────
// POST /api/catalog (old quick-add, no edition expansion)
router.post('/', async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });

  // Add to both systems
  const gcResult  = addGameCatalogEntry({
    base_title:   name.toLowerCase().trim(),
    display_name: name,
    is_full_game: 1,
    excluded:     0,
    psdeals_url:  `https://psdeals.net/us-store/game/${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
  });
  try { addToCatalog(name); } catch (_) {}

  res.json({ id: gcResult.id, created: gcResult.created });
});

// Legacy lang update
router.put('/:id/lang', (req, res) => {
  const { spanishAudio, spanishText } = req.body;
  updateCatalogLang(req.params.id, spanishAudio, spanishText);
  // Also update game_catalog
  try {
    updateGameCatalogEntry(parseInt(req.params.id, 10), {
      spanish_audio: spanishAudio ? 1 : 0,
      spanish_text:  spanishText  ? 1 : 0,
    });
  } catch (_) {}
  res.json({ ok: true });
});

// ── POST /api/catalog/re-search-alt-region ────────────────────────────────────
// Walk all catalog entries and re-fetch sony_alt_url with the current alt_region setting.
// Long-running — returns jobId, progress via SSE (reuses history-style pattern but simpler).
router.post('/re-search-alt-region', async (req, res) => {
  const altRegion = getAltRegion();
  res.json({ started: true, altRegion });

  // Run in background
  setImmediate(async () => {
    const db      = getDb();
    const entries = db.prepare('SELECT id, display_name FROM game_catalog WHERE excluded=0').all();
    console.log(`[catalog] re-search-alt-region: updating ${entries.length} entries for region=${altRegion}`);

    for (const entry of entries) {
      try {
        const altResult = await searchSonyAltRegion(entry.display_name, altRegion);
        if (altResult) {
          updateGameCatalogEntry(entry.id, {
            sony_alt_url:        altResult.sony_alt_url,
            sony_alt_confidence: altResult.sony_alt_confidence,
            sony_alt_region:     altRegion,
          });
        }
      } catch (_) {}
      await new Promise(r => setTimeout(r, 200)); // polite delay
    }
    console.log(`[catalog] re-search-alt-region: done`);
  });
});

module.exports = router;
