const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');
const Fuse = require('fuse.js');
const { scrapeAllDeals }    = require('../scrapers/psdeals');
const { scrapeAllProducts } = require('../scrapers/gamesturkey');
const { getVerdict, predictNextSale } = require('../services/comparison');
const { getDb, getGiftCardRate, getMinHistoricalPrice, detectSaleDates } = require('../db/database');

// In-memory SSE clients and progress state
const progressClients = new Map(); // batchId → Set<res>
let activeBatch = null; // { id, status, progress }

function broadcastProgress(batchId, data) {
  const clients = progressClients.get(batchId);
  if (!clients) return;
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(msg); } catch (_) {}
  }
}

// GET /api/bulk — last completed batch results
router.get('/', (req, res) => {
  const db = getDb();
  const latestBatch = db.prepare(
    'SELECT batch_id, MAX(scraped_at) as ts FROM bulk_results GROUP BY batch_id ORDER BY ts DESC LIMIT 1'
  ).get();

  if (!latestBatch) return res.json({ results: [], batchId: null, updatedAt: null });

  const { filter, sort, minSaving } = req.query;

  let query = 'SELECT * FROM bulk_results WHERE batch_id = ?';
  const params = [latestBatch.batch_id];

  if (filter && filter !== 'ALL') {
    query += ' AND verdict = ?';
    params.push(filter);
  }
  if (minSaving) {
    query += ' AND saving_usd >= ?';
    params.push(parseFloat(minSaving));
  }

  const sortMap = {
    saving:      'saving_usd DESC',
    cheapest:    'real_cost_usd ASC',
    verdict:     'verdict ASC',
  };
  query += ` ORDER BY ${sortMap[sort] || 'saving_usd DESC'}`;

  const rows = db.prepare(query).all(...params);

  res.json({
    results:   rows,
    batchId:   latestBatch.batch_id,
    updatedAt: latestBatch.ts,
    active:    activeBatch,
  });
});

// GET /api/bulk/status — current scrape status
router.get('/status', (_req, res) => {
  res.json({ active: activeBatch });
});

// GET /api/bulk/progress/:batchId — SSE stream
router.get('/progress/:batchId', (req, res) => {
  const { batchId } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  if (!progressClients.has(batchId)) progressClients.set(batchId, new Set());
  progressClients.get(batchId).add(res);

  // Send current state immediately if available
  if (activeBatch?.id === batchId) {
    res.write(`data: ${JSON.stringify(activeBatch)}\n\n`);
  }

  req.on('close', () => {
    progressClients.get(batchId)?.delete(res);
  });
});

// POST /api/bulk/refresh — start a new bulk scrape
router.post('/refresh', async (req, res) => {
  if (activeBatch && activeBatch.status === 'running') {
    return res.status(409).json({ error: 'Ya hay un scrape en curso', batchId: activeBatch.id });
  }

  const batchId = uuidv4();
  activeBatch = { id: batchId, status: 'running', message: 'Iniciando...', progress: 0, total: 0 };
  res.json({ batchId });

  // 5-minute hard timeout — always fires complete/error so SSE never hangs
  const timeout = setTimeout(() => {
    if (activeBatch?.status === 'running') {
      console.warn('Bulk scrape timed out after 5 minutes');
      activeBatch = { id: batchId, status: 'error', message: '⏱ Tiempo agotado — intentá de nuevo' };
      broadcastProgress(batchId, activeBatch);
      setTimeout(() => progressClients.delete(batchId), 10000);
    }
  }, 5 * 60 * 1000);

  runBulkScrape(batchId)
    .catch(err => {
      console.error('Bulk scrape error:', err);
      activeBatch = { id: batchId, status: 'error', message: err.message };
      broadcastProgress(batchId, activeBatch);
    })
    .finally(() => clearTimeout(timeout));
});

async function runBulkScrape(batchId) {
  const emit = (data) => {
    Object.assign(activeBatch, data);
    broadcastProgress(batchId, activeBatch);
  };

  emit({ message: '📦 Scrapeando ofertas de PSDeals AR...', progress: 5 });

  let psGames = [];
  try {
    psGames = await scrapeAllDeals((prog) => {
      emit({ message: `PSDeals — página ${prog.page} | ${prog.count} juegos encontrados`, progress: 10 + prog.page });
    });
  } catch (err) {
    console.error('PSDeals bulk error:', err.message);
    emit({ message: `⚠️ PSDeals falló (${err.message}), continuando con Turquía...`, progress: 35 });
  }

  emit({ message: `✅ PSDeals: ${psGames.length} juegos. Scrapeando GamesturkeyACC...`, progress: 40 });

  let turkeyProducts = [];
  try {
    turkeyProducts = await scrapeAllProducts([1, 12, 13, 21], (prog) => {
      emit({ message: `GamesturkeyACC — cat ${prog.category} pág ${prog.page} | ${prog.total} productos`, progress: 50 + Math.min(prog.total / 5, 15) });
    });
  } catch (err) {
    console.error('GamesturkeyACC bulk error:', err.message);
    emit({ message: `⚠️ GamesturkeyACC falló (${err.message}), usando solo PSDeals...`, progress: 65 });
  }

  emit({ message: `✅ Turquía: ${turkeyProducts.length} productos. Cruzando datos...`, progress: 70 });

  // Fuzzy-match PSDeals games against Turkey products
  const fuse = new Fuse(turkeyProducts, { keys: ['title'], threshold: 0.35 });
  const giftCardRate = getGiftCardRate();
  const db = getDb();
  const now = new Date().toISOString();

  const insertBulk = db.prepare(`
    INSERT INTO bulk_results
      (batch_id, game_name, ps_price_usd, ps_price_raw, ps_discount_pct, ps_sale_end,
       turkey_price, turkey_url, real_cost_usd, min_hist_usd, verdict, verdict_label, saving_usd, gift_card_rate, scraped_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((rows) => {
    for (const r of rows) insertBulk.run(...r);
  });

  const rows = [];
  const matched = new Set();

  for (const game of psGames) {
    const hits = fuse.search(game.title);
    const turkey = hits.length > 0 ? hits[0].item : null;
    if (turkey) matched.add(turkey.title);

    const realCost = game.priceUsd != null ? Math.round(game.priceUsd * giftCardRate * 100) / 100 : null;
    const minHist  = getMinHistoricalPrice(game.title);
    const saleDatesDb = detectSaleDates(game.title).map(d => d.date);
    const nextSale = predictNextSale(saleDatesDb);

    const verdict = getVerdict(realCost, turkey?.priceUsd || null, {
      minHistoricalUsd: minHist,
      giftCardRate,
      nextSalePrediction: nextSale,
    });

    rows.push([
      batchId, game.title, game.priceUsd, game.priceRaw, game.discount, game.saleEnd,
      turkey?.priceUsd || null, turkey?.url || null, realCost, minHist || null,
      verdict.type, verdict.label, verdict.saving || 0, giftCardRate, now,
    ]);
  }

  // Turkey-only (no PSDeals match)
  for (const product of turkeyProducts) {
    if (matched.has(product.title)) continue;
    rows.push([
      batchId, product.title, null, null, 0, null,
      product.priceUsd, product.url, null, null,
      'TURKEY_ONLY', '🇹🇷 Solo en Turquía', 0, giftCardRate, now,
    ]);
  }

  insertMany(rows);

  activeBatch = { id: batchId, status: 'done', message: `✅ Completado — ${rows.length} juegos procesados`, progress: 100 };
  broadcastProgress(batchId, activeBatch);

  // Clean up SSE clients after a delay
  setTimeout(() => progressClients.delete(batchId), 60000);
}

module.exports = router;
