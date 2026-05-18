const express  = require('express');
const router   = express.Router();
const { v4: uuidv4 } = require('uuid');

const { fetchHistoryBatch }      = require('../scrapers/psdeals-history');
const { getDb, savePriceDetailHistory, setGameCatalogPSDealsData } = require('../db/database');

const progressClients = new Map();
let activeJob = null;

function broadcastProgress(jobId, data) {
  const clients = progressClients.get(jobId);
  if (!clients) return;
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(msg); } catch (_) {}
  }
}

function persistJobState(state) {
  try {
    getDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run('history_active_job', JSON.stringify(state));
  } catch (_) {}
}

function clearPersistedJob() {
  try { getDb().prepare('DELETE FROM settings WHERE key = ?').run('history_active_job'); } catch (_) {}
}

// ── GET /api/history/status ──────────────────────────────────────────────────
router.get('/status', (_req, res) => {
  const db = getDb();

  if (!activeJob) {
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'history_active_job'").get();
      if (row) {
        const saved = JSON.parse(row.value);
        if (saved.status === 'running') {
          saved.status  = 'interrupted';
          saved.message = '⚠️ Job interrumpido por restart — podés relanzarlo';
          clearPersistedJob();
        }
        activeJob = saved;
      }
    } catch (_) {}
  }

  // Stats from game_catalog (new system) + legacy tables
  let stats = null;
  try {
    const total = db.prepare(
      'SELECT COUNT(*) as n FROM game_catalog WHERE excluded=0'
    ).get();
    const withPSDeals = db.prepare(
      'SELECT COUNT(*) as n FROM game_catalog WHERE excluded=0 AND min_price_usd_alltime IS NOT NULL'
    ).get();
    const withOwn = db.prepare(
      "SELECT COUNT(DISTINCT game_name) as n FROM price_history WHERE source='psstore-us'"
    ).get();
    const lastRun = db.prepare(
      "SELECT value FROM settings WHERE key = 'history_last_completed'"
    ).get();
    stats = {
      totalGames:       total?.n      || 0,
      gamesWithHistory: withPSDeals?.n || 0,
      ownHistory:       withOwn?.n     || 0,
      lastCompleted:    lastRun?.value  || null,
    };
  } catch (_) {}

  res.json({ active: activeJob, stats });
});

// ── GET /api/history/progress/:jobId — SSE ──────────────────────────────────
router.get('/progress/:jobId', (req, res) => {
  const { jobId } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  if (!progressClients.has(jobId)) progressClients.set(jobId, new Set());
  progressClients.get(jobId).add(res);
  if (activeJob) res.write(`data: ${JSON.stringify(activeJob)}\n\n`);
  req.on('close', () => progressClients.get(jobId)?.delete(res));
});

// ── POST /api/history/fetch — start job manually ─────────────────────────────
router.post('/fetch', (req, res) => {
  if (activeJob?.status === 'running') {
    return res.status(409).json({ error: 'Ya hay un job de historial en curso', jobId: activeJob.id });
  }
  const jobId = startHistoryJob('manual');
  res.json({ jobId });
});

// ── Exported for programmatic triggering ──────────────────────────────────────
function startHistoryJob(triggeredBy = 'manual') {
  if (activeJob?.status === 'running') return activeJob.id;

  const jobId = uuidv4();
  activeJob = { id: jobId, status: 'running', progress: 0, message: 'Iniciando...', saved: 0, triggeredBy };
  persistJobState(activeJob);

  const timeout = setTimeout(() => {
    if (activeJob?.status === 'running') {
      activeJob = { id: jobId, status: 'error', message: '⏱ Tiempo agotado' };
      broadcastProgress(jobId, activeJob);
      clearPersistedJob();
      setTimeout(() => progressClients.delete(jobId), 10000);
    }
  }, 45 * 60 * 1000);

  runHistoryFetch(jobId)
    .catch(err => {
      console.error('History fetch error:', err);
      activeJob = { id: jobId, status: 'error', message: err.message };
      broadcastProgress(jobId, activeJob);
      clearPersistedJob();
    })
    .finally(() => clearTimeout(timeout));

  return jobId;
}

async function runHistoryFetch(jobId) {
  const emit = (data) => {
    Object.assign(activeJob, data);
    persistJobState(activeJob);
    broadcastProgress(jobId, activeJob);
  };
  const db          = getDb();
  const triggeredBy = activeJob?.triggeredBy || 'manual';

  // ── Auto-trigger (after bulk refresh): just report stats ──────────────────
  if (triggeredBy === 'auto-after-bulk') {
    emit({ message: 'Calculando estadísticas de historial...', progress: 50 });

    const withDetail = db.prepare(
      'SELECT COUNT(*) as n FROM game_catalog WHERE excluded=0 AND min_price_usd_alltime IS NOT NULL'
    ).get()?.n || 0;
    const withOwn = db.prepare(
      "SELECT COUNT(DISTINCT game_name) as n FROM price_history WHERE source='psstore-us'"
    ).get()?.n || 0;
    const totalPoints = db.prepare(
      "SELECT COUNT(*) as n FROM price_history WHERE source='psstore-us'"
    ).get()?.n || 0;
    const oldestEntry = db.prepare(
      "SELECT MIN(scraped_at) as d FROM price_history WHERE source='psstore-us'"
    ).get()?.d;
    const since = oldestEntry ? oldestEntry.slice(0, 10) : '—';

    const now = new Date().toISOString();
    try { db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('history_last_completed', now); } catch (_) {}

    activeJob = {
      id: jobId, status: 'done', progress: 100, saved: withDetail,
      message: `📊 ${withOwn} juegos con historial propio desde ${since} — ${withDetail} con datos PSDeals — ${totalPoints} registros. Hacé click en "Actualizar historial" para agregar más.`,
    };
    broadcastProgress(jobId, activeJob);
    clearPersistedJob();
    setTimeout(() => progressClients.delete(jobId), 60000);
    return;
  }

  // ── Manual trigger: scrape PSDeals for catalog entries missing min_hist ────
  emit({ message: '📋 Buscando juegos sin historial PSDeals...', progress: 5 });

  // Find catalog entries that don't have PSDeals history yet
  // Prioritize: no min_price OR psdeals_last_checked older than 30 days
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const needHistory = db.prepare(`
    SELECT id, display_name, psdeals_url
    FROM game_catalog
    WHERE excluded=0
      AND (min_price_usd_alltime IS NULL OR psdeals_last_checked < ?)
    ORDER BY display_name ASC
  `).all(thirtyDaysAgo);

  if (needHistory.length === 0) {
    const withHistory = db.prepare(
      'SELECT COUNT(*) as n FROM game_catalog WHERE excluded=0 AND min_price_usd_alltime IS NOT NULL'
    ).get()?.n || 0;
    const now = new Date().toISOString();
    try { db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('history_last_completed', now); } catch (_) {}

    activeJob = {
      id: jobId, status: 'done', progress: 100, saved: withHistory,
      message: `✅ Todos los juegos ya tienen historial PSDeals actualizado (${withHistory} juegos).`,
    };
    broadcastProgress(jobId, activeJob);
    clearPersistedJob();
    setTimeout(() => progressClients.delete(jobId), 60000);
    return;
  }

  emit({ message: `🎭 Iniciando Playwright para ${needHistory.length} juegos sin historial...`, progress: 8 });

  let saved = 0;
  try {
    const gameNames = needHistory.map(e => e.display_name);
    const results   = await fetchHistoryBatch(gameNames, (prog) => {
      const pct = 8 + Math.round((prog.done / prog.total) * 87);
      emit({
        message:  `PSDeals — ${prog.done}/${prog.total} | ${prog.current}`,
        progress: pct,
        saved:    prog.saved,
      });
    });

    // Store results in both game_catalog (new) and ps_price_history_detail (legacy)
    for (let i = 0; i < results.length; i++) {
      const { name, history, gameUrl } = results[i];
      const catalogEntry = needHistory[i];

      if (!history || history.length === 0) continue;

      try {
        // Compute aggregates for game_catalog
        const prices    = history.map(h => h.priceUsd).filter(p => p > 0);
        const minPrice  = prices.length ? Math.min(...prices) : null;
        const minEntry  = minPrice ? history.find(h => h.priceUsd === minPrice) : null;

        // Detect current sale (most recent price that seems discounted)
        const sortedHistory = [...history].sort((a, b) => b.date.localeCompare(a.date));
        const latestPrice   = sortedHistory[0]?.priceUsd ?? null;
        const secondPrice   = sortedHistory.find(h => h.priceUsd !== latestPrice)?.priceUsd ?? null;
        const isOnSale      = latestPrice && secondPrice && latestPrice < secondPrice;
        const currentSalePrice = isOnSale ? latestPrice : null;

        // Store in game_catalog
        setGameCatalogPSDealsData(catalogEntry.id, {
          psdeals_url:            gameUrl || catalogEntry.psdeals_url,
          min_price_usd_alltime:  minPrice,
          min_price_date:         minEntry?.date || null,
          current_sale_price_usd: currentSalePrice,
          current_sale_end_date:  null, // PSDeals history doesn't give end dates directly
        });

        // Also store raw points in legacy table (for chart in SearchTab)
        savePriceDetailHistory(name, history.map(h => ({ price: h.priceUsd, date: h.date })));
        saved++;
      } catch (err) {
        console.warn(`[history] Save failed for "${name}": ${err.message}`);
      }
    }
  } catch (err) {
    console.error('[history] Playwright batch failed:', err.message);
    emit({ message: `⚠️ Error en Playwright: ${err.message} — guardando lo que hay`, progress: 95 });
  }

  const now = new Date().toISOString();
  try { db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('history_last_completed', now); } catch (_) {}

  activeJob = {
    id: jobId, status: 'done', progress: 100, saved,
    message: `✅ Historial PSDeals guardado para ${saved}/${needHistory.length} juegos`,
  };
  broadcastProgress(jobId, activeJob);
  clearPersistedJob();
  setTimeout(() => progressClients.delete(jobId), 60000);
}

module.exports = router;
module.exports.startHistoryJob = startHistoryJob;
