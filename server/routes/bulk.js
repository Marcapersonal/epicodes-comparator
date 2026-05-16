const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');
const Fuse = require('fuse.js');
const { bulkLookup }        = require('../scrapers/psstore');
const { scrapeAllProducts } = require('../scrapers/gamesturkey');
const { getVerdict }        = require('../services/comparison');
const { getDb, getGiftCardRate, getMinHistoricalPrice } = require('../db/database');
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

  // STEP 1 — Scrape GamesturkeyACC catalog
  emit({ message: '🇹🇷 Scrapeando catálogo de GamesturkeyACC...', progress: 5 });
  let turkeyProducts = [];
  try {
    turkeyProducts = await scrapeAllProducts(undefined, (prog) => {  // undefined = use default (all 1-30)
      emit({ message: `GamesturkeyACC — ${prog.total} productos`, progress: 5 + Math.min(prog.total / 3, 15) });
    });
  } catch (err) {
    console.error('GamesturkeyACC error:', err.message);
    emit({ message: `⚠️ GamesturkeyACC falló: ${err.message}`, progress: 20 });
  }

  if (!turkeyProducts.length) {
    activeBatch = { id: batchId, status: 'error', message: '❌ No se pudieron obtener productos de GamesturkeyACC' };
    broadcastProgress(batchId, activeBatch);
    return;
  }

  emit({ message: `✅ ${turkeyProducts.length} productos de Turkey. Buscando precios en PS Store AR + US...`, progress: 20 });

  // STEP 2 — Lookup each Turkey game on PS Store AR and US in parallel
  // Strip platform/region suffixes that Turkey adds but PS Store doesn't have
  function cleanForSearch(title) {
    return title
      .replace(/\s*PS[45]™?(\s*[-–]\s*PS[45]™?)?\s*/gi, ' ')
      .replace(/\s*\((?:tr|india|ps[45])\)\s*/gi, ' ')
      .replace(/\s*(digital\s+deluxe|standard\s+edition|deluxe\s+edition|complete\s+edition|gold\s+edition)\s*$/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  const titles       = turkeyProducts.map(p => p.title);
  const searchTitles = titles.map(cleanForSearch);

  const psResults = await bulkLookup(searchTitles, (prog) => {
    const pct = 20 + Math.round((prog.completed / prog.total) * 65);
    emit({ message: `PS Store — ${prog.completed}/${prog.total} | ${prog.current}`, progress: pct });
  });

  emit({ message: '💾 Cruzando datos y guardando...', progress: 87 });

  // STEP 3 — Cross-match and compute verdicts
  const giftCardRate = getGiftCardRate();
  const db  = getDb();
  const now = new Date().toISOString();

  // Build Turkey lookup map
  const turkeyMap = new Map(turkeyProducts.map(p => [p.title, p]));

  const insertBulk = db.prepare(`
    INSERT INTO bulk_results
      (batch_id, game_name, ps_price_usd, ps_price_raw, ps_discount_pct, ps_sale_end,
       turkey_price, turkey_url, real_cost_usd, min_hist_usd,
       verdict, verdict_label, saving_usd, gift_card_rate, scraped_at, us_price_usd, ps_detail_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const rows = [];

  for (let i = 0; i < titles.length; i++) {
    const turkey = turkeyMap.get(titles[i]);
    const ps     = psResults[i];
    const ar     = ps?.ar || null;
    const us     = ps?.us || null;

    const arPriceUsd = ar?.priceUsd ?? null;
    const realCost   = arPriceUsd != null ? Math.round(arPriceUsd * giftCardRate * 100) / 100 : null;
    const minHist    = getMinHistoricalPrice(titles[i]);

    const verdict = getVerdict(realCost, turkey?.priceUsd ?? null, {
      minHistoricalUsd: minHist,
      giftCardRate,
    });

    rows.push([
      b(batchId),
      b(turkey?.title || titles[i]),
      b(arPriceUsd),
      b(ar?.priceRaw) ?? null,
      b(ar?.discountPct) ?? 0,
      b(ar?.saleEnd) ?? null,
      b(turkey?.priceUsd) ?? null,
      b(turkey?.url) ?? null,
      b(realCost),
      b(minHist) ?? null,
      b(verdict.type),
      b(verdict.label),
      b(verdict.saving) ?? 0,
      b(giftCardRate),
      b(now),
      b(us?.priceUsd) ?? null,
      b(ar?.detailUrl) ?? null,
    ]);
  }

  db.exec('BEGIN');
  try {
    for (const r of rows) insertBulk.run(...r);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  const withAr = rows.filter(r => r[2] != null).length;
  activeBatch = {
    id: batchId, status: 'done', progress: 100,
    message: `✅ Completado — ${rows.length} juegos | ${withAr} con precio AR | ${rows.length - withAr} solo Turkey`,
  };
  broadcastProgress(batchId, activeBatch);
  setTimeout(() => progressClients.delete(batchId), 60000);

  // Auto-start history fetch for any new games without history (runs in background)
  setImmediate(() => {
    try { getHistoryRoute().startHistoryJob('auto-after-bulk'); } catch (_) {}
  });
}

module.exports = router;
