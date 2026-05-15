require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const { getDb } = require('./db/database');

const searchRoutes   = require('./routes/search');
const bulkRoutes     = require('./routes/bulk');
const watchlistRoutes = require('./routes/watchlist');
const settingsRoutes = require('./routes/settings');
const alertsRoutes   = require('./routes/alerts');
const historyRoutes  = require('./routes/history');
const { startCron }  = require('./services/cronService');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Warm up the DB (runs migrations on first call)
getDb();

// ── API routes ────────────────────────────────────────────────────────────────
app.use('/api/search',    searchRoutes);
app.use('/api/bulk',      bulkRoutes);
app.use('/api/watchlist', watchlistRoutes);
app.use('/api/settings',  settingsRoutes);
app.use('/api/alerts',    alertsRoutes);
app.use('/api/history',   historyRoutes);

app.get('/api/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ── Serve React client ────────────────────────────────────────────────────────
const CLIENT_DIST = path.join(__dirname, '../client/dist');
app.use(express.static(CLIENT_DIST));
app.get('*', (_req, res) => res.sendFile(path.join(CLIENT_DIST, 'index.html')));

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🎮 Epicodes Price Comparator → http://localhost:${PORT}`);
  startCron();
});
