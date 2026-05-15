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

// GET /api/history/status
router.get('/status', (_req, res) => res.json({ active: activeJob }));

// GET /api/history/progress/:jobId — SSE stream
router.get('/progress/:jobId', (req, res) => {
  const { jobId } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  if (!progressClients.has(jobId)) progressClients.set(jobId, new Set());
  progressClients.get(jobId).add(res);
  if (activeJob?.id === jobId) res.write(`data: ${JSON.stringify(activeJob)}\n\n`);
  req.on('close', () => progressClients.get(jobId)?.delete(res));
});

// POST /api/history/fetch — start the job
router.post('/fetch', (req, res) => {
  if (activeJob?.status === 'running') {
    return res.status(409).json({ error: 'Ya hay un job de historial en curso', jobId: activeJob.id });
  }

  const jobId = uuidv4();
  activeJob = { id: jobId, status: 'running', progress: 0, message: 'Iniciando...', saved: 0 };
  res.json({ jobId });

  const timeout = setTimeout(() => {
    if (activeJob?.status === 'running') {
      activeJob = { id: jobId, status: 'error', message: '⏱ Tiempo agotado' };
      broadcastProgress(jobId, activeJob);
      setTimeout(() => progressClients.delete(jobId), 10000);
    }
  }, 45 * 60 * 1000); // 45 min max

  runHistoryFetch(jobId)
    .catch(err => {
      console.error('History fetch error:', err);
      activeJob = { id: jobId, status: 'error', message: err.message };
      broadcastProgress(jobId, activeJob);
    })
    .finally(() => clearTimeout(timeout));
});

async function runHistoryFetch(jobId) {
  const emit = (data) => { Object.assign(activeJob, data); broadcastProgress(jobId, activeJob); };
  const db   = getDb();

  // Get all game names from the latest bulk batch
  const latest = db.prepare(
    'SELECT batch_id FROM bulk_results ORDER BY scraped_at DESC LIMIT 1'
  ).get();

  if (!latest) {
    activeJob = { id: jobId, status: 'error', message: '❌ No hay datos bulk. Hacé un refresh primero.' };
    broadcastProgress(jobId, activeJob);
    return;
  }

  const allGames = db.prepare(
    'SELECT DISTINCT game_name FROM bulk_results WHERE batch_id = ?'
  ).all(latest.batch_id).map(r => r.game_name);

  // Only fetch games without existing history
  const toFetch = allGames.filter(name => {
    const row = db.prepare('SELECT COUNT(*) as n FROM ps_price_history_detail WHERE game_name = ?').get(name);
    return row.n === 0;
  });

  if (toFetch.length === 0) {
    activeJob = { id: jobId, status: 'done', progress: 100, message: '✅ Todos los juegos ya tienen historial cargado.', saved: 0 };
    broadcastProgress(jobId, activeJob);
    setTimeout(() => progressClients.delete(jobId), 30000);
    return;
  }

  emit({
    message: `${toFetch.length} juegos sin historial. Buscando en PSDeals AR...`,
    progress: 2,
  });

  const batchResults = await fetchHistoryBatch(toFetch, ({ done, total, current, saved }) => {
    const pct = 2 + Math.round((done / total) * 93);
    emit({ message: `${done}/${total} — ${current}`, progress: pct, saved });
  });

  // Persist to DB
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

  activeJob = {
    id: jobId, status: 'done', progress: 100, saved: totalSaved,
    message: `✅ Historial cargado — ${totalSaved} de ${toFetch.length} juegos con datos`,
  };
  broadcastProgress(jobId, activeJob);
  setTimeout(() => progressClients.delete(jobId), 60000);
}

module.exports = router;
