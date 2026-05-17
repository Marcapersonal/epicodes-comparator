/**
 * PlatPrices API integration — free tier 500 calls/hour
 * API: GET https://platprices.com/api.php?key={KEY}&name={GAME}&region=us
 *
 * Prices are returned in CENTS → divide by 100 to get USD.
 * Cached in SQLite for 7 days to stay well within rate limits.
 */
const axios   = require('axios');
const { getDb } = require('../db/database');

const BASE_URL      = 'https://platprices.com/api.php';
const CACHE_TTL_MS  = 7 * 24 * 60 * 60 * 1000; // 7 days
const SEED_DELAY_MS = 7500; // 500 calls/hr = 1 per 7.2 s → use 7.5 s

const delay = ms => new Promise(r => setTimeout(r, ms));

// ── DB helpers ────────────────────────────────────────────────────────────────

function _getCached(gameName) {
  try {
    const row = getDb().prepare(
      'SELECT * FROM platprices_cache WHERE game_name = ? COLLATE NOCASE'
    ).get(gameName);
    if (!row) return null;
    if (Date.now() - new Date(row.fetched_at).getTime() > CACHE_TTL_MS) return null;
    return row;
  } catch (_) { return null; }
}

function _upsert(gameName, data) {
  getDb().prepare(`
    INSERT OR REPLACE INTO platprices_cache
      (game_name, ppid, base_price_usd, sale_price_usd,
       last_discounted, discount_until, discount_pct, raw_json, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    gameName,
    data.ppid          ?? null,
    data.basePriceUsd  ?? null,
    data.salePriceUsd  ?? null,
    data.lastDiscounted ?? null,
    data.discountUntil  ?? null,
    data.discountPct   ?? null,
    data.rawJson       ?? null,
    new Date().toISOString(),
  );
}

// ── Raw API call ──────────────────────────────────────────────────────────────

async function _callApi(name) {
  const key = process.env.PLATPRICES_KEY || '';
  if (!key) throw new Error('PLATPRICES_KEY not configured');

  const url = `${BASE_URL}?key=${encodeURIComponent(key)}&name=${encodeURIComponent(name)}&region=us`;
  const { data } = await axios.get(url, {
    timeout: 10000,
    headers: { 'User-Agent': 'EpicodesComparator/1.0' },
  });

  // API may return an object or an array; pick first element
  const raw = Array.isArray(data) ? data[0] : data;

  if (!raw || raw.Error || raw.error) {
    const msg = raw?.Error || raw?.error || 'No results from PlatPrices';
    throw new Error(msg);
  }

  // Prices in cents
  const basePrice = raw.BasePrice ? raw.BasePrice / 100 : null;
  const salePrice = (raw.SalePrice && raw.SalePrice !== raw.BasePrice)
    ? raw.SalePrice / 100
    : null;
  const discountPct = (basePrice && salePrice)
    ? Math.round(100 - (salePrice / basePrice * 100))
    : 0;

  return {
    ppid:           raw.PPID           || null,
    basePriceUsd:   basePrice,
    salePriceUsd:   salePrice,
    lastDiscounted: raw.LastDiscounted  || null,
    discountUntil:  raw.DiscountedUntil || null,
    discountPct,
    rawJson:        JSON.stringify(raw),
  };
}

// ── Public: fetch with cache + fuzzy retry (removes subtitle after ":") ───────

async function fetchPlatPrices(gameName) {
  if (!gameName) return null;
  if (!process.env.PLATPRICES_KEY) return null;

  try {
    const cached = _getCached(gameName);
    if (cached) {
      return {
        ppid:           cached.ppid,
        basePriceUsd:   cached.base_price_usd,
        salePriceUsd:   cached.sale_price_usd,
        lastDiscounted: cached.last_discounted,
        discountUntil:  cached.discount_until,
        discountPct:    cached.discount_pct,
        fromCache:      true,
      };
    }

    // Try full name first, then short name before ":"
    let data = null;
    try {
      data = await _callApi(gameName);
    } catch (err1) {
      const shortName = gameName.includes(':') ? gameName.split(':')[0].trim() : null;
      if (shortName && shortName !== gameName) {
        data = await _callApi(shortName); // may throw — caught below
      } else {
        throw err1;
      }
    }

    _upsert(gameName, data);
    return { ...data, fromCache: false };
  } catch (err) {
    console.warn(`PlatPrices fetch failed for "${gameName}": ${err.message}`);
    return null;
  }
}

// ── Seed job state ────────────────────────────────────────────────────────────

let _seedJob  = null;
const _seedCbs = new Set();

function getSeedStatus() { return _seedJob; }

function _emit(patch) {
  Object.assign(_seedJob, patch);
  for (const cb of _seedCbs) try { cb({ ..._seedJob }); } catch (_) {}
}

// ── Seed: fetch PlatPrices for all catalog games in background ────────────────

async function runSeedJob(games, onProgress) {
  if (_seedJob?.status === 'running') return;

  if (!process.env.PLATPRICES_KEY) {
    _seedJob = { status: 'error', message: '❌ PLATPRICES_KEY no configurada en .env' };
    onProgress?.(_seedJob);
    return;
  }

  if (onProgress) _seedCbs.add(onProgress);

  _seedJob = {
    status: 'running', done: 0, total: games.length,
    skipped: 0, progress: 0, message: 'Iniciando...',
  };
  _emit({});

  let done = 0, skipped = 0;

  for (let i = 0; i < games.length; i++) {
    if (_seedJob?.status === 'cancelled') break;

    const name = games[i];

    if (_getCached(name)) {
      // Already fresh in cache — skip API call
      skipped++;
      done++;
    } else {
      try {
        const data = await _callApi(name);
        _upsert(name, data);
      } catch (err) {
        if (err.response?.status === 429) {
          console.warn('PlatPrices rate limited — backing off 30 s');
          await delay(30000);
        }
        // Other errors: skip silently
      }
      done++;
      // Respect rate limit between non-cached calls
      if (i < games.length - 1) await delay(SEED_DELAY_MS);
    }

    _emit({
      done, skipped,
      progress: Math.round((done / games.length) * 100),
      message:  `${done}/${games.length} — ${name}`,
    });
  }

  const finalStatus = _seedJob?.status === 'cancelled' ? 'cancelled' : 'done';
  _emit({
    status:   finalStatus,
    done, skipped,
    progress: 100,
    message:  `✅ ${done - skipped} nuevos + ${skipped} en caché`,
  });
  _seedCbs.delete(onProgress);
}

module.exports = { fetchPlatPrices, getSeedStatus, runSeedJob };
