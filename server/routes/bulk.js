const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');
const Fuse = require('fuse.js');
const { bulkLookup }        = require('../scrapers/psstore');
const { scrapeAllProducts } = require('../scrapers/gamesturkey');
const { getVerdict }        = require('../services/comparison');
const { getDb, getGiftCardRate, getMinHistoricalPrice, getCatalog, recordPrice } = require('../db/database');
// Lazy-loaded to prevent playwright-extra/stealth from patching Node internals at startup
let _historyRoute = null;
function getHistoryRoute() { return _historyRoute || (_historyRoute = require('./history')); }

// In-memory SSE clients and progress state
const progressClients = new Map();
let activeBatch = null;

function broadcastProgress(batchId, data) {
  const clients = progressClients.get(batchId);
  if (!clients) return;
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(msg); } catch (_) {}
  }
}

// ── GET /api/bulk ─────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const db = getDb();
  const latestBatch = db.prepare(
    'SELECT batch_id, MAX(scraped_at) as ts FROM bulk_results GROUP BY batch_id ORDER BY ts DESC LIMIT 1'
  ).get();

  if (!latestBatch) return res.json({ results: [], batchId: null, updatedAt: null });

  const { filter, sort, minSaving } = req.query;
  let query  = 'SELECT * FROM bulk_results WHERE batch_id = ?';
  const params = [latestBatch.batch_id];

  if (filter && filter !== 'ALL') { query += ' AND verdict = ?'; params.push(filter); }
  if (minSaving) { query += ' AND saving_usd >= ?'; params.push(parseFloat(minSaving)); }

  const sortMap = { saving: 'saving_usd DESC', cheapest: 'real_cost_usd ASC', verdict: 'verdict ASC' };
  query += ` ORDER BY ${sortMap[sort] || 'saving_usd DESC'}`;

  res.json({
    results:   db.prepare(query).all(...params),
    batchId:   latestBatch.batch_id,
    updatedAt: latestBatch.ts,
    active:    activeBatch,
  });
});

// ── GET /api/bulk/status ──────────────────────────────────────────────────────
router.get('/status', (_req, res) => res.json({ active: activeBatch }));

// ── GET /api/bulk/progress/:batchId — SSE stream ──────────────────────────────
router.get('/progress/:batchId', (req, res) => {
  const { batchId } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  if (!progressClients.has(batchId)) progressClients.set(batchId, new Set());
  progressClients.get(batchId).add(res);
  if (activeBatch?.id === batchId) res.write(`data: ${JSON.stringify(activeBatch)}\n\n`);
  req.on('close', () => progressClients.get(batchId)?.delete(res));
});

// ── POST /api/bulk/refresh ────────────────────────────────────────────────────
router.post('/refresh', (req, res) => {
  if (activeBatch?.status === 'running') {
    return res.status(409).json({ error: 'Ya hay un scrape en curso', batchId: activeBatch.id });
  }

  const batchId = uuidv4();
  activeBatch = { id: batchId, status: 'running', message: 'Iniciando...', progress: 0 };
  res.json({ batchId });

  const timeout = setTimeout(() => {
    if (activeBatch?.status === 'running') {
      activeBatch = { id: batchId, status: 'error', message: '⏱ Tiempo agotado — intentá de nuevo' };
      broadcastProgress(batchId, activeBatch);
      setTimeout(() => progressClients.delete(batchId), 10000);
    }
  }, 8 * 60 * 1000);

  runBulkScrape(batchId)
    .catch(err => {
      console.error('Bulk scrape error:', err);
      activeBatch = { id: batchId, status: 'error', message: err.message };
      broadcastProgress(batchId, activeBatch);
    })
    .finally(() => clearTimeout(timeout));
});

// ─────────────────────────────────────────────────────────────────────────────
async function runBulkScrape(batchId) {
  const emit = (data) => { Object.assign(activeBatch, data); broadcastProgress(batchId, activeBatch); };
  const b = (v) => (v === undefined || (typeof v === 'number' && isNaN(v))) ? null : v;

  // STEP 1 — Load user's catalog from DB
  emit({ message: '📋 Cargando catálogo de juegos...', progress: 5 });
  const catalog = getCatalog();
  if (!catalog.length) {
    activeBatch = { id: batchId, status: 'error', message: '❌ El catálogo está vacío. Agregá juegos desde el panel de catálogo.' };
    broadcastProgress(batchId, activeBatch);
    return;
  }

  // STEP 2 — Scrape GamesturkeyACC for Turkey prices
  emit({ message: '🇹🇷 Scrapeando precios de GamesturkeyACC...', progress: 8 });
  let turkeyProducts = [];
  try {
    turkeyProducts = await scrapeAllProducts(undefined, (prog) => {
      emit({ message: `GamesturkeyACC — ${prog.total} productos`, progress: 8 + Math.min(prog.total / 3, 12) });
    });
  } catch (err) {
    console.error('GamesturkeyACC error:', err.message);
    emit({ message: `⚠️ GamesturkeyACC falló: ${err.message}`, progress: 20 });
  }

  // STEP 3 — Build Turkey Fuse index
  const fuseT = new Fuse(turkeyProducts, { keys: ['title'], threshold: 0.45 });

  emit({ message: `✅ ${turkeyProducts.length} productos de Turkey. Buscando en PS Store US (${catalog.length} juegos)...`, progress: 20 });

  // STEP 4 — Lookup each catalog game on PS Store US
  const psResults = await bulkLookup(catalog.map(g => g.name), (prog) => {
    const pct = 20 + Math.round((prog.completed / prog.total) * 65);
    emit({ message: `PS Store US — ${prog.completed}/${prog.total} | ${prog.current}`, progress: pct });
  });

  emit({ message: '💾 Cruzando datos y guardando...', progress: 87 });

  // STEP 5 — Cross-match and compute verdicts — ONE ROW PER EDITION
  const giftCardRate = getGiftCardRate();
  const db  = getDb();
  const now = new Date().toISOString();

  // Per-edition Turkey fuzzy matcher (slightly stricter threshold)
  const fuseEdition = new Fuse(turkeyProducts, { keys: ['title'], threshold: 0.40 });

  const insertBulk = db.prepare(`
    INSERT INTO bulk_results
      (batch_id, catalog_name, game_name, ps_price_usd, ps_price_raw, ps_discount_pct, ps_sale_end,
       turkey_price, turkey_url, real_cost_usd, min_hist_usd,
       verdict, verdict_label, saving_usd, gift_card_rate, scraped_at, us_price_usd, ps_detail_url, editions_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const rows = [];

  for (let i = 0; i < catalog.length; i++) {
    const game     = catalog[i];
    const ps       = psResults[i];
    const variants = ps?.variants || [];
    const minHist  = getMinHistoricalPrice(game.name);

    // Record the cheapest variant price for history tracking
    if (variants.length > 0 && variants[0].priceUsd != null) {
      try {
        recordPrice(game.name, 'psstore-us', variants[0].priceUsd, {
          raw:      variants[0].priceRaw,
          currency: 'USD',
          discount: variants[0].discountPct || 0,
          saleEnd:  variants[0].saleEnd || null,
        });
      } catch (_) {}
    }

    if (variants.length === 0) {
      // No PS Store data — insert one placeholder row so the game still appears
      const tHits  = fuseT.search(game.name);
      const turkey = tHits.length ? tHits[0].item : null;
      const verdict = getVerdict(null, turkey?.priceUsd ?? null, { minHistoricalUsd: minHist, giftCardRate });
      rows.push([
        b(batchId), b(game.name), b(game.name),
        null, null, 0, null,
        b(turkey?.priceUsd) ?? null, b(turkey?.url) ?? null,
        null, b(minHist) ?? null,
        b(verdict.type), b(verdict.label), b(verdict.saving) ?? 0,
        b(giftCardRate), b(now), null, null, null,
      ]);
      continue;
    }

    // Insert one row per edition/variant
    for (const v of variants) {
      const edTitle    = v.name || v.title || game.name;
      const usPriceUsd = v.priceUsd ?? null;
      const realCost   = usPriceUsd != null ? Math.round(usPriceUsd * giftCardRate * 100) / 100 : null;

      // Match this specific edition title against Turkey catalog
      const vHits  = fuseEdition.search(edTitle);
      const turkey = vHits.length ? vHits[0].item : null;

      const verdict = getVerdict(realCost, turkey?.priceUsd ?? null, {
        minHistoricalUsd: minHist,
        giftCardRate,
      });

      rows.push([
        b(batchId),
        b(game.name),          // catalog_name — original catalog entry
        b(edTitle),            // game_name — edition title shown in table
        b(usPriceUsd),
        b(v.priceRaw) ?? null,
        b(v.discountPct) ?? 0,
        b(v.saleEnd) ?? null,
        b(turkey?.priceUsd) ?? null,
        b(turkey?.url) ?? null,
        b(realCost),
        b(minHist) ?? null,
        b(verdict.type),
        b(verdict.label),
        b(verdict.saving) ?? 0,
        b(giftCardRate),
        b(now),
        b(usPriceUsd),
        b(v.detailUrl) ?? null,
        null,                  // editions_json — no longer needed (each edition is its own row)
      ]);
    }
  }

  db.exec('BEGIN');
  try {
    for (const r of rows) insertBulk.run(...r);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  const withPrice = rows.filter(r => r[3] != null).length;
  activeBatch = {
    id: batchId, status: 'done', progress: 100,
    message: `✅ Completado — ${catalog.length} títulos del catálogo → ${rows.length} ediciones | ${withPrice} con precio | ${rows.length - withPrice} sin precio`,
  };
  broadcastProgress(batchId, activeBatch);
  setTimeout(() => progressClients.delete(batchId), 60000);

  // Auto-start history fetch for any new games without history (runs in background)
  setImmediate(() => {
    try { getHistoryRoute().startHistoryJob('auto-after-bulk'); } catch (_) {}
  });
}

module.exports = router;
