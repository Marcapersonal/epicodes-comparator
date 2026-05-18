const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');

const {
  getDb,
  getGameCatalog,
  getGiftCardRate,
  getAltRegion,
  setGameCatalogError,
  clearGameCatalogError,
  updateGameCatalogEntry,
  recordPrice,
} = require('../db/database');

const { getVerdict }           = require('../services/comparison');
const { fetchSonyPriceByUrl, bulkLookup }              = require('../scrapers/psstore');
const { fetchTurkeyPriceByUrl, scrapeAllProducts }     = require('../scrapers/gamesturkey');
const Fuse = require('fuse.js');

// Lazy-load history route to avoid playwright-extra patching Node at startup
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

  const rows = db.prepare(query).all(...params);

  // Enrich with game_catalog data (min_hist, sale dates, alt region price, validation status)
  let gcMap = {};
  try {
    const gcRows = db.prepare('SELECT * FROM game_catalog WHERE excluded=0').all();
    for (const r of gcRows) gcMap[r.display_name?.toLowerCase()] = r;
  } catch (_) {}

  const enriched = rows.map(r => {
    const key = (r.catalog_name || r.game_name || '').toLowerCase();
    const gc  = gcMap[key] || gcMap[(r.game_name || '').toLowerCase()] || null;

    // Corrected min_hist from game_catalog PSDeals data (most authoritative)
    let minHistUsd = (r.min_hist_usd != null && r.min_hist_usd >= 1.0) ? r.min_hist_usd : null;
    if (gc?.min_price_usd_alltime != null && (minHistUsd == null || gc.min_price_usd_alltime < minHistUsd)) {
      minHistUsd = gc.min_price_usd_alltime;
    }

    return {
      ...r,
      min_hist_usd:           minHistUsd,
      min_price_date:         gc?.min_price_date         ?? null,
      current_sale_price_usd: gc?.current_sale_price_usd ?? null,
      current_sale_end_date:  gc?.current_sale_end_date  ?? null,
      // Validation state
      validated_at:           gc?.validated_at            ?? null,
      validated_by:           gc?.validated_by            ?? null,
      last_error:             gc?.last_error              ?? null,
      sony_us_confidence:     gc?.sony_us_confidence      ?? null,
      turkey_confidence:      gc?.turkey_confidence       ?? null,
      // Alt region
      sony_alt_url:           r.sony_alt_url || gc?.sony_alt_url   || null,
      sony_alt_region:        r.sony_alt_region || gc?.sony_alt_region || null,
      // PSDeals
      psdeals_url:            gc?.psdeals_url ?? null,
      // Turkey URL (from bulk_results — already stored)
      turkey_url:             r.turkey_url || gc?.turkey_url || null,
    };
  });

  res.json({
    results:   enriched,
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
  }, 10 * 60 * 1000); // 10 min timeout

  runBulkScrape(batchId)
    .catch(err => {
      console.error('Bulk scrape error:', err);
      activeBatch = { id: batchId, status: 'error', message: err.message };
      broadcastProgress(batchId, activeBatch);
    })
    .finally(() => clearTimeout(timeout));
});

// ─────────────────────────────────────────────────────────────────────────────

const delay = ms => new Promise(r => setTimeout(r, ms));

async function runBulkScrape(batchId) {
  const emit = (data) => { Object.assign(activeBatch, data); broadcastProgress(batchId, activeBatch); };
  const b    = (v)    => (v === undefined || (typeof v === 'number' && isNaN(v))) ? null : v;

  // ── Step 1: Load game_catalog ─────────────────────────────────────────────
  emit({ message: '📋 Cargando catálogo validado...', progress: 3 });
  const catalog = getGameCatalog();
  if (!catalog.length) {
    activeBatch = { id: batchId, status: 'error', message: '❌ El catálogo está vacío. Agregá juegos desde el panel de catálogo.' };
    broadcastProgress(batchId, activeBatch);
    return;
  }

  const giftCardRate = getGiftCardRate();
  const altRegion    = getAltRegion();
  const db           = getDb();
  const now          = new Date().toISOString();

  // Partition: entries with stored URLs vs those needing a search fallback
  const withSonyUrl    = catalog.filter(e => e.sony_us_url);
  const withoutSonyUrl = catalog.filter(e => !e.sony_us_url);

  emit({
    message: `📋 ${catalog.length} juegos | ${withSonyUrl.length} con URL guardada | ${withoutSonyUrl.length} sin URL`,
    progress: 5,
  });

  // ── Step 2: Fetch prices for entries WITH stored URLs ─────────────────────
  // Run in parallel batches (concurrency 5 — these are targeted fetches, not searches)
  const CONCURRENCY = 5;
  const urlResults = {};

  async function fetchByUrlWorker(entry) {
    const [sony, turkey] = await Promise.allSettled([
      entry.sony_us_url ? fetchSonyPriceByUrl(entry.sony_us_url) : Promise.resolve(null),
      entry.turkey_url  ? fetchTurkeyPriceByUrl(entry.turkey_url) : Promise.resolve(null),
    ]);
    const sonyResult   = sony.status   === 'fulfilled' ? sony.value   : null;
    const turkeyResult = turkey.status === 'fulfilled' ? turkey.value : null;

    // Clear or set error on catalog entry
    if (entry.sony_us_url && !sonyResult) {
      setGameCatalogError(entry.id, 'Sony URL sin precio — ¿link roto?');
    } else if (sonyResult) {
      clearGameCatalogError(entry.id);
    }

    return { entry, sonyResult, turkeyResult };
  }

  let urlDone = 0;
  const urlQueue = [...withSonyUrl];
  let urlCursor  = 0;

  async function urlNext() {
    if (urlCursor >= urlQueue.length) return;
    const entry  = urlQueue[urlCursor++];
    const result = await fetchByUrlWorker(entry);
    urlResults[entry.id] = result;
    urlDone++;
    const pct = 5 + Math.round((urlDone / Math.max(withSonyUrl.length, 1)) * 35);
    emit({ message: `🔗 Precios por URL — ${urlDone}/${withSonyUrl.length} | ${entry.display_name}`, progress: pct });
    await delay(150 + Math.random() * 100);
    await urlNext();
  }

  if (withSonyUrl.length > 0) {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, withSonyUrl.length) }, urlNext));
  }

  // ── Step 3: Search fallback for entries WITHOUT stored URLs ───────────────
  // Uses existing bulkLookup — same as old behavior
  let searchResults = {};
  if (withoutSonyUrl.length > 0) {
    emit({ message: `🔍 Buscando ${withoutSonyUrl.length} juegos sin URL guardada en PS Store...`, progress: 42 });
    const names    = withoutSonyUrl.map(e => e.display_name);
    const rawResults = await bulkLookup(names, (prog) => {
      const pct = 42 + Math.round((prog.completed / prog.total) * 18);
      emit({ message: `🔍 PS Store — ${prog.completed}/${prog.total} | ${prog.current}`, progress: pct });
    });
    // rawResults is array aligned with names
    for (let i = 0; i < withoutSonyUrl.length; i++) {
      searchResults[withoutSonyUrl[i].id] = rawResults[i];
    }
  }

  // ── Step 3.5: Turkey fallback for entries WITHOUT stored turkey_url ────────
  // Scrape all GamesturkeyACC categories once, then fuzzy-match each unlinked entry.
  // Once a URL is found, it's stored in game_catalog so future refreshes skip this step.
  const withoutTurkeyUrl   = catalog.filter(e => !e.turkey_url);
  const turkeyFallbackPrices = {}; // entryId -> { priceUsd, priceRaw, url, confidence }

  if (withoutTurkeyUrl.length > 0) {
    emit({
      message: `🇹🇷 Scrapeando GamesturkeyACC para ${withoutTurkeyUrl.length} juegos sin URL guardada...`,
      progress: 61,
    });
    try {
      const turkeyProducts = await scrapeAllProducts(undefined, (prog) => {
        // Progress crawls from 61 → 72 as products accumulate (rough estimate ~600 products total)
        const pct = 61 + Math.min(Math.round((prog.total / 700) * 11), 11);
        emit({ message: `🇹🇷 Turkey — ${prog.total} productos | categoría #${prog.category}`, progress: pct });
      });

      if (turkeyProducts.length > 0) {
        emit({ message: `🇹🇷 ${turkeyProducts.length} productos Turkey — cruzando con catálogo...`, progress: 73 });

        const fuse = new Fuse(turkeyProducts, {
          keys:         ['title'],
          threshold:    0.45,
          includeScore: true,
        });

        for (const entry of withoutTurkeyUrl) {
          const hits = fuse.search(entry.display_name);
          if (!hits.length) continue;

          const best       = hits[0];
          const confidence = Math.round((1 - (best.score ?? 0)) * 100);
          const product    = best.item;

          if (!product.priceUsd) continue;

          turkeyFallbackPrices[entry.id] = {
            priceUsd:   product.priceUsd,
            priceRaw:   product.priceRaw,
            url:        product.url,
            confidence,
          };

          // Persist the found URL so next refresh uses fetchTurkeyPriceByUrl (faster)
          try {
            updateGameCatalogEntry(entry.id, {
              turkey_url:        product.url,
              turkey_confidence: Math.min(100, confidence),
            });
          } catch (_) {}
        }
      }
    } catch (err) {
      console.warn('[bulk] Turkey fallback scrape failed:', err.message);
    }
  }

  // ── Step 4: Alt-region prices from stored sony_alt_url ────────────────────
  const altPrices = {};
  const altEntries = withSonyUrl.filter(e => e.sony_alt_url);
  if (altEntries.length > 0) {
    emit({ message: `🌍 Obteniendo precios de región ${altRegion}...`, progress: 75 });
    let altDone = 0;
    for (const entry of altEntries) {
      try {
        const altResult = await fetchSonyPriceByUrl(entry.sony_alt_url);
        if (altResult) altPrices[entry.id] = altResult;
      } catch (_) {}
      altDone++;
      if (altDone % 5 === 0) {
        emit({ message: `🌍 Región ${altRegion} — ${altDone}/${altEntries.length}`, progress: 75 + Math.round(altDone / altEntries.length * 5) });
      }
      await delay(100);
    }
  }

  // ── Step 5: Cross-match and save ─────────────────────────────────────────
  emit({ message: '💾 Cruzando datos y guardando...', progress: 82 });

  const insertBulk = db.prepare(`
    INSERT INTO bulk_results
      (batch_id, catalog_name, game_name, ps_price_usd, ps_price_raw, ps_discount_pct, ps_sale_end,
       turkey_price, turkey_url, real_cost_usd, min_hist_usd,
       verdict, verdict_label, saving_usd, gift_card_rate, scraped_at,
       us_price_usd, ps_detail_url, editions_json,
       spanish_audio, spanish_text,
       game_catalog_id, sony_alt_price_usd, sony_alt_region)
    VALUES (?,?,?,?,?,?,?, ?,?,?,?, ?,?,?,?,?,?,?,?, ?,?, ?,?,?)
  `);

  const rows = [];

  for (const entry of catalog) {
    const entryId = entry.id;

    // ── Get sony data ────────────────────────────────────────────────────────
    let sonyPriceUsd  = null;
    let sonyPriceRaw  = null;
    let discountPct   = 0;
    let saleEnd       = null;
    let detailUrl     = entry.sony_us_url || null;

    if (urlResults[entryId]) {
      const { sonyResult } = urlResults[entryId];
      if (sonyResult) {
        sonyPriceUsd = sonyResult.priceUsd;
        sonyPriceRaw = sonyResult.priceRaw;
        discountPct  = sonyResult.discountPct || 0;
        saleEnd      = sonyResult.saleEnd || null;
        // Record in price_history for trend tracking
        try {
          if (sonyPriceUsd) {
            recordPrice(entry.display_name, 'psstore-us', sonyPriceUsd, {
              raw: sonyPriceRaw, currency: 'USD', discount: discountPct, saleEnd,
            });
          }
        } catch (_) {}
      }
    } else if (searchResults[entryId]) {
      // Fallback from search
      const sr      = searchResults[entryId];
      const best    = sr?.variants?.[0] || sr?.best;
      if (best) {
        sonyPriceUsd = best.priceUsd;
        sonyPriceRaw = best.priceRaw;
        discountPct  = best.discountPct || 0;
        saleEnd      = best.saleEnd || null;
        detailUrl    = best.detailUrl || null;
        // Store the found URL back into game_catalog for future use
        if (best.detailUrl && !entry.sony_us_url) {
          try {
            updateGameCatalogEntry(entryId, {
              sony_us_url:        best.detailUrl,
              sony_us_confidence: 60, // search-found, not validated
            });
          } catch (_) {}
        }
        try {
          if (sonyPriceUsd) {
            recordPrice(entry.display_name, 'psstore-us', sonyPriceUsd, {
              raw: sonyPriceRaw, currency: 'USD', discount: discountPct, saleEnd,
            });
          }
        } catch (_) {}
      }
    }

    // ── Get turkey data ──────────────────────────────────────────────────────
    let turkeyPriceUsd = null;
    let turkeyUrl      = entry.turkey_url || null;
    let spanishAudio   = entry.spanish_audio || 0;
    let spanishText    = entry.spanish_text  || 0;

    if (urlResults[entryId]) {
      // Entry had a stored turkey_url → fetched via fetchTurkeyPriceByUrl (most accurate)
      const { turkeyResult } = urlResults[entryId];
      if (turkeyResult) {
        turkeyPriceUsd = turkeyResult.priceUsd;
        spanishAudio   = turkeyResult.spanishAudio ? 1 : 0;
        spanishText    = turkeyResult.spanishText  ? 1 : 0;
      }
    } else if (turkeyFallbackPrices[entryId]) {
      // Entry had no turkey_url → matched via full Turkey catalog scrape + Fuse
      // (Language data not yet available; will be populated on next refresh once URL is stored)
      const tf = turkeyFallbackPrices[entryId];
      turkeyPriceUsd = tf.priceUsd;
      turkeyUrl      = tf.url;           // persist matched URL in this row
    }

    // ── Get min historical price from game_catalog ────────────────────────────
    const minHist = entry.min_price_usd_alltime || null;

    // ── Compute real cost and verdict ─────────────────────────────────────────
    const realCost = sonyPriceUsd != null ? Math.round(sonyPriceUsd * giftCardRate * 100) / 100 : null;
    const verdict  = getVerdict(realCost, turkeyPriceUsd, { minHistoricalUsd: minHist, giftCardRate });

    // ── Alt region price ──────────────────────────────────────────────────────
    const altPrice = altPrices[entryId]?.priceUsd ?? null;

    rows.push([
      b(batchId),
      b(entry.display_name),  // catalog_name
      b(entry.display_name),  // game_name (shown in table)
      b(sonyPriceUsd),
      b(sonyPriceRaw),
      b(discountPct) ?? 0,
      b(saleEnd),
      b(turkeyPriceUsd),
      b(turkeyUrl),
      b(realCost),
      b(minHist),
      b(verdict.type),
      b(verdict.label),
      b(verdict.saving) ?? 0,
      b(giftCardRate),
      b(now),
      b(sonyPriceUsd),       // us_price_usd
      b(detailUrl),          // ps_detail_url
      null,                  // editions_json
      spanishAudio ? 1 : 0,
      spanishText  ? 1 : 0,
      b(entryId),            // game_catalog_id
      b(altPrice),           // sony_alt_price_usd
      b(altRegion !== 'US' ? altRegion : null), // sony_alt_region
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

  const withPrice        = rows.filter(r => r[3] != null).length;
  const withTurkeyPrice  = rows.filter(r => r[7] != null).length;
  const withUrl          = withSonyUrl.length;
  const turkeyFallback   = Object.keys(turkeyFallbackPrices).length;
  activeBatch = {
    id: batchId, status: 'done', progress: 100,
    message: `✅ ${catalog.length} juegos | ${withPrice} con precio Sony | ${withTurkeyPrice} con precio Turkey (${withoutTurkeyUrl.length - turkeyFallback > 0 ? `${withoutTurkeyUrl.length - Object.keys(turkeyFallbackPrices).length} sin match Turkey` : 'todos matcheados'})`,
  };
  broadcastProgress(batchId, activeBatch);
  setTimeout(() => progressClients.delete(batchId), 60000);

  // Auto-run stats update
  setImmediate(() => {
    try { getHistoryRoute().startHistoryJob('auto-after-bulk'); } catch (_) {}
  });
}

module.exports = router;
