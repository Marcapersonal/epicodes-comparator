const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');
const { fetchHistoryBatch } = require('../scrapers/psdeals-history');
const { getDb, savePriceDetailHistory } = require('../db/database');

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

// Persist activeJob to settings so frontend can reconnect after page reload
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

  // Recover persisted job state if server was restarted mid-job
  if (!activeJob) {
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'history_active_job'").get();
      if (row) {
        const saved = JSON.parse(row.value);
        // If it was "running" at server restart, mark it interrupted
        if (saved.status === 'running') {
          saved.status = 'interrupted';
          saved.message = '⚠️ Job interrumpido por restart — podés relanzarlo';
          clearPersistedJob();
        }
        activeJob = saved;
      }
    } catch (_) {}
  }

  // Stats: count from both psdeals detail table and our own psstore-us records
  let stats = null;
  try {
    const total = db.prepare('SELECT COUNT(DISTINCT game_name) as n FROM bulk_results WHERE batch_id = (SELECT batch_id FROM bulk_results ORDER BY scraped_at DESC LIMIT 1)').get();
    const withPsdeals = db.prepare('SELECT COUNT(DISTINCT game_name) as n FROM ps_price_history_detail').get();
    const withOwn     = db.prepare("SELECT COUNT(DISTINCT game_name) as n FROM price_history WHERE source='psstore-us'").get();
    const lastRun = db.prepare("SELECT value FROM settings WHERE key = 'history_last_completed'").get();
    stats = {
      totalGames:       total?.n || 0,
      gamesWithHistory: Math.max(withPsdeals?.n || 0, withOwn?.n || 0),
      lastCompleted:    lastRun?.value || null,
    };
  } catch (_) {}

  res.json({ active: activeJob, stats });
});

// ── GET /api/history/progress/:jobId — SSE stream ───────────────────────────
router.get('/progress/:jobId', (req, res) => {
  const { jobId } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  if (!progressClients.has(jobId)) progressClients.set(jobId, new Set());
  progressClients.get(jobId).add(res);
  // Send current state immediately so client catches up
  if (activeJob) res.write(`data: ${JSON.stringify(activeJob)}\n\n`);
  req.on('close', () => progressClients.get(jobId)?.delete(res));
});

// ── POST /api/history/fetch — start job via HTTP ─────────────────────────────
router.post('/fetch', (req, res) => {
  if (activeJob?.status === 'running') {
    return res.status(409).json({ error: 'Ya hay un job de historial en curso', jobId: activeJob.id });
  }
  const jobId = startHistoryJob('manual');
  res.json({ jobId });
});

// ── Exported function for programmatic triggering (e.g. after bulk refresh) ──
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
  const db = getDb();
  const triggeredBy = activeJob?.triggeredBy || 'manual';

  // ── Auto-trigger (after bulk refresh): just report stats, no Playwright ──────
  if (triggeredBy === 'auto-after-bulk') {
    emit({ message: 'Calculando estadísticas de historial...', progress: 50 });

    const withDetail  = db.prepare('SELECT COUNT(DISTINCT game_name) as n FROM ps_price_history_detail').get()?.n || 0;
    const withOwn     = db.prepare("SELECT COUNT(DISTINCT game_name) as n FROM price_history WHERE source='psstore-us'").get()?.n || 0;
    const totalPoints = db.prepare("SELECT COUNT(*) as n FROM price_history WHERE source='psstore-us'").get()?.n || 0;
    const oldestEntry = db.prepare("SELECT MIN(scraped_at) as d FROM price_history WHERE source='psstore-us'").get()?.d;
    const since       = oldestEntry ? oldestEntry.slice(0, 10) : '—';

    const now = new Date().toISOString();
    try { db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('history_last_completed', now); } catch (_) {}

    activeJob = {
      id: jobId, status: 'done', progress: 100, saved: withDetail,
      message: `📊 ${withOwn} juegos con historial propio desde ${since} — ${withDetail} con historial PSDeals — ${totalPoints} registros. Hacé click en "Actualizar historial" para agregar más.`,
    };
    broadcastProgress(jobId, activeJob);
    clearPersistedJob();
    setTimeout(() => { progressClients.delete(jobId); }, 60000);
    return;
  }

  // ── Manual trigger: scrape PSDeals history with Playwright for games missing it ──
  emit({ message: '📋 Buscando juegos sin historial PSDeals...', progress: 5 });

  // Find catalog games that don't have PSDeals history yet
  const allCatalog = db.prepare('SELECT name FROM catalog WHERE active=1').all().map(r => r.name);
  const withHistory = new Set(
    db.prepare('SELECT DISTINCT game_name FROM ps_price_history_detail').all().map(r => r.game_name)
  );
  const needHistory = allCatalog.filter(name => !withHistory.has(name));

  if (needHistory.length === 0) {
    const now = new Date().toISOString();
    try { db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('history_last_completed', now); } catch (_) {}

    activeJob = {
      id: jobId, status: 'done', progress: 100, saved: withHistory.size,
      message: `✅ Todos los juegos ya tienen historial PSDeals (${withHistory.size} juegos).`,
    };
    broadcastProgress(jobId, activeJob);
    clearPersistedJob();
    setTimeout(() => { progressClients.delete(jobId); }, 60000);
    return;
  }

  emit({ message: `🎭 Iniciando Playwright para ${needHistory.length} juegos sin historial...`, progress: 8 });

  let saved = 0;
  try {
    const results = await fetchHistoryBatch(needHistory, (prog) => {
      const pct = 8 + Math.round((prog.done / prog.total) * 87);
      emit({
        message:  `PSDeals — ${prog.done}/${prog.total} | ${prog.current}`,
        progress: pct,
        saved:    prog.saved,
      });
    });

    // Persist fetched history to ps_price_history_detail
    for (const { name, history } of results) {
      if (history.length > 0) {
        try {
          savePriceDetailHistory(name, history.map(h => ({ price: h.priceUsd, date: h.date })));
          saved++;
        } catch (err) {
          console.warn(`[history] Save failed for "${name}": ${err.message}`);
        }
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
    message: `✅ Historial guardado para ${saved}/${needHistory.length} juegos nuevos`,
  };
  broadcastProgress(jobId, activeJob);
  clearPersistedJob();
  setTimeout(() => { progressClients.delete(jobId); }, 60000);
}

module.exports = router;
module.exports.startHistoryJob = startHistoryJob;
