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
const catalogRoutes  = require('./routes/catalog');
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
app.use('/api/catalog',   catalogRoutes);

app.get('/api/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// Temporary debug: test PS Store raw response from Railway IP
app.get('/api/debug/psstore', async (req, res) => {
  const axios = require('axios');
  const cheerio = require('cheerio');
  const q = req.query.q || 'Spider-Man 2';
  const url = `https://store.playstation.com/en-ar/search/${encodeURIComponent(q)}`;
  try {
    const { data, status, headers } = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-AR,es;q=0.9,en;q=0.8',
        'Cache-Control': 'no-cache',
        'Referer': 'https://www.google.com/',
      },
      timeout: 15000,
    });
    const $ = cheerio.load(data);
    const tiles = $('[data-qa^="search#productTile"]').length;
    const firstName = $('[data-qa^="search#productTile"]').first().find('[data-qa$="#product-name"]').text().trim();
    const firstPrice = $('[data-qa^="search#productTile"]').first().find('[data-qa$="#price#display-price"]').first().text().trim();
    res.json({ status, htmlLen: data.length, tiles, firstName, firstPrice, url,
      snippet: data.substring(0, 500) });
  } catch (err) {
    res.json({ error: err.message, status: err.response?.status, url });
  }
});

// ── Serve React client ────────────────────────────────────────────────────────
const CLIENT_DIST = path.join(__dirname, '../client/dist');
app.use(express.static(CLIENT_DIST));
app.get('*', (_req, res) => res.sendFile(path.join(CLIENT_DIST, 'index.html')));

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🎮 Epicodes Price Comparator → http://localhost:${PORT}`);
  startCron();
});
