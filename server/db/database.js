const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs   = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/epicodes.db');

let db;

function getDb() {
  if (db) return db;
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  _migrate(db);
  return db;
}

function _migrate(db) {
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS price_history (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      game_name    TEXT    NOT NULL,
      source       TEXT    NOT NULL,
      price_usd    REAL,
      price_raw    TEXT,
      currency     TEXT,
      discount_pct INTEGER,
      sale_end     TEXT,
      scraped_at   TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ps_price_history_detail (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      game_name   TEXT NOT NULL,
      price_usd   REAL,
      date_label  TEXT,
      source      TEXT DEFAULT 'psdeals',
      recorded_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS watchlist (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      game_name     TEXT    NOT NULL,
      psdeals_url   TEXT,
      turkey_url    TEXT,
      alert_price   REAL,
      alert_enabled INTEGER DEFAULT 0,
      added_at      TEXT    NOT NULL,
      last_checked  TEXT
    );

    CREATE TABLE IF NOT EXISTS alert_history (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      watchlist_id INTEGER,
      game_name    TEXT NOT NULL,
      old_price    REAL,
      new_price    REAL,
      channel      TEXT,
      sent_at      TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bulk_results (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id        TEXT    NOT NULL,
      game_name       TEXT    NOT NULL,
      ps_price_usd    REAL,
      ps_price_raw    TEXT,
      ps_discount_pct INTEGER,
      ps_sale_end     TEXT,
      turkey_price    REAL,
      turkey_url      TEXT,
      real_cost_usd   REAL,
      min_hist_usd    REAL,
      verdict         TEXT,
      verdict_label   TEXT,
      saving_usd      REAL,
      gift_card_rate  REAL,
      scraped_at      TEXT    NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_bulk_batch  ON bulk_results(batch_id);
    CREATE INDEX IF NOT EXISTS idx_ph_game     ON price_history(game_name);
    CREATE INDEX IF NOT EXISTS idx_pshd_game   ON ps_price_history_detail(game_name);
  `);

  // Default settings
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('gift_card_rate', '0.72');
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('ars_to_usd', process.env.ARS_TO_USD || '1200');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getSetting(key) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  getDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
}

function getGiftCardRate() { return parseFloat(getSetting('gift_card_rate') || '0.72'); }
function getArsToUsd()     { return parseFloat(getSetting('ars_to_usd')     || process.env.ARS_TO_USD || '1200'); }

function recordPrice(gameName, source, priceUsd, opts = {}) {
  getDb().prepare(`
    INSERT INTO price_history (game_name, source, price_usd, price_raw, currency, discount_pct, sale_end, scraped_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(gameName, source, priceUsd, opts.raw || null, opts.currency || 'USD',
         opts.discount || null, opts.saleEnd || null, new Date().toISOString());
}

function getMinHistoricalPrice(gameName) {
  const row = getDb().prepare(
    "SELECT MIN(price_usd) as min FROM price_history WHERE game_name = ? AND source = 'psdeals' AND price_usd IS NOT NULL"
  ).get(gameName);
  return row?.min ?? null;
}

function getPriceDetailHistory(gameName) {
  return getDb().prepare(
    'SELECT price_usd, date_label, recorded_at FROM ps_price_history_detail WHERE game_name = ? ORDER BY recorded_at ASC'
  ).all(gameName);
}

function savePriceDetailHistory(gameName, points) {
  const db  = getDb();
  const ins = db.prepare('INSERT INTO ps_price_history_detail (game_name, price_usd, date_label, recorded_at) VALUES (?, ?, ?, ?)');
  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    for (const p of points) ins.run(gameName, p.price, p.date, now);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function detectSaleDates(gameName) {
  return getDb().prepare(
    "SELECT scraped_at, price_usd FROM price_history WHERE game_name = ? AND source = 'psdeals' AND discount_pct > 0 ORDER BY scraped_at ASC"
  ).all(gameName).map(r => ({ date: r.scraped_at.slice(0, 10), price: r.price_usd }));
}

module.exports = { getDb, getSetting, setSetting, getGiftCardRate, getArsToUsd, recordPrice, getMinHistoricalPrice, getPriceDetailHistory, savePriceDetailHistory, detectSaleDates };
