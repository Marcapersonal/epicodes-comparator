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

  // Also return stats: how many games have history vs total
  let stats = null;
  try {
    const total = db.prepare('SELECT COUNT(DISTINCT game_name) as n FROM bulk_results WHERE batch_id = (SELECT batch_id FROM bulk_results ORDER BY scraped_at DESC LIMIT 1)').get();
    const withHistory = db.prepare('SELECT COUNT(DISTINCT game_name) as n FROM ps_price_history_detail').get();
    const lastRun = db.prepare("SELECT value FROM settings WHERE key = 'history_last_completed'").get();
    stats = {
      totalGames:   total?.n || 0,
      gamesWithHistory: withHistory?.n || 0,
      lastCompleted: lastRun?.value || null,
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

  const latest = db.prepare('SELECT batch_id FROM bulk_results ORDER BY scraped_at DESC LIMIT 1').get();
  if (!latest) {
    activeJob = { id: jobId, status: 'error', message: '❌ No hay datos bulk. Hacé un refresh primero.' };
    broadcastProgress(jobId, activeJob);
    clearPersistedJob();
    return;
  }

  const allGames = db.prepare(
    'SELECT DISTINCT game_name FROM bulk_results WHERE batch_id = ?'
  ).all(latest.batch_id).map(r => r.game_name);

  const toFetch = allGames.filter(name => {
    const row = db.prepare('SELECT COUNT(*) as n FROM ps_price_history_detail WHERE game_name = ?').get(name);
    return row.n === 0;
  });

  if (toFetch.length === 0) {
    activeJob = { id: jobId, status: 'done', progress: 100, message: '✅ Todos los juegos ya tienen historial.', saved: 0 };
    broadcastProgress(jobId, activeJob);
    clearPersistedJob();
    setTimeout(() => progressClients.delete(jobId), 30000);
    return;
  }

  emit({ message: `${toFetch.length} juegos sin historial. Buscando en PSDeals AR...`, progress: 2 });

  const batchResults = await fetchHistoryBatch(toFetch, ({ done, total, current, saved }) => {
    const pct = 2 + Math.round((done / total) * 93);
    emit({ message: `${done}/${total} — ${current}`, progress: pct, saved });
  });

  let totalSaved = 0;
  for (const { name, history } of batchResults) {
    if (history.length > 0) {
      try {
        savePriceDetailHistory(name, history.map(h => ({ price: h.priceUsd, date: h.date })));
        totalSaved++;
      } catch (err) {
        console.warn(`[history] save failed for ${name}:`, err.message);
      }
    }
  }

  const now = new Date().toISOString();
  try { db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('history_last_completed', now); } catch (_) {}

  activeJob = {
    id: jobId, status: 'done', progress: 100, saved: totalSaved,
    message: `✅ Historial guardado — ${totalSaved}/${toFetch.length} juegos con datos`,
  };
  broadcastProgress(jobId, activeJob);
  clearPersistedJob();
  setTimeout(() => { progressClients.delete(jobId); }, 60000);
}

module.exports = router;
module.exports.startHistoryJob = startHistoryJob;
