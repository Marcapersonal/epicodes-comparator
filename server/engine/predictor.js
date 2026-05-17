/**
 * Sale cycle analysis engine.
 *
 * Data sources (combined):
 *  1. price_history  (source='psstore-us', discount_pct > 0) — our own bulk-scrape records
 *  2. platprices_cache.last_discounted                       — PlatPrices "last sale" date
 *
 * The more bulk refreshes you run over time, the richer the pattern becomes.
 * PlatPrices seeds the very first data point immediately after the seed job runs.
 */
const { getDb } = require('../db/database');

const MONTH_NAMES_ES = [
  'Enero','Febrero','Marzo','Abril','Mayo','Junio',
  'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre',
];

// ── Read PlatPrices cache row directly (no TTL check — predictor uses any data) ──

function _getPp(gameName) {
  try {
    return getDb().prepare(
      'SELECT * FROM platprices_cache WHERE game_name = ? COLLATE NOCASE'
    ).get(gameName);
  } catch (_) { return null; }
}

// ── Main export ───────────────────────────────────────────────────────────────

function analyzeSaleCycle(gameName) {
  if (!gameName) return _empty();
  const db = getDb();

  // 1 — Own scrape records where we caught the game on sale
  let ownSales = [];
  try {
    ownSales = db.prepare(`
      SELECT scraped_at, price_usd, discount_pct
      FROM   price_history
      WHERE  game_name = ? AND source = 'psstore-us' AND discount_pct > 0
      ORDER  BY scraped_at ASC
    `).all(gameName);
  } catch (_) {}

  // 2 — PlatPrices row
  const pp = _getPp(gameName);

  // Build de-duped sale event list, keyed by YYYY-MM
  const saleMap = new Map();

  for (const s of ownSales) {
    const key = s.scraped_at.slice(0, 7);
    const cur = saleMap.get(key);
    if (!cur || (s.price_usd != null && s.price_usd < (cur.price ?? Infinity))) {
      saleMap.set(key, {
        date:        s.scraped_at.slice(0, 10),
        price:       s.price_usd,
        discountPct: s.discount_pct,
      });
    }
  }

  // Add PlatPrices last_discounted if that month isn't already covered
  if (pp?.last_discounted) {
    const key = pp.last_discounted.slice(0, 7);
    if (!saleMap.has(key)) {
      saleMap.set(key, {
        date:        pp.last_discounted,
        price:       pp.sale_price_usd,
        discountPct: pp.discount_pct,
      });
    }
  }

  const events = [...saleMap.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (events.length === 0) return _empty(pp);

  // ── Basic stats ───────────────────────────────────────────────────────────
  const saleCount     = events.length;
  const validPcts     = events.filter(e => e.discountPct > 0).map(e => e.discountPct);
  const avgDiscountPct = validPcts.length
    ? Math.round(validPcts.reduce((a, b) => a + b, 0) / validPcts.length)
    : null;

  const withPrice = events.filter(e => e.price != null);
  const bestEvent = withPrice.length
    ? withPrice.reduce((b, e) => e.price < b.price ? e : b)
    : null;

  const lastSaleDate      = events[events.length - 1].date;
  const daysSinceLastSale = Math.floor((Date.now() - new Date(lastSaleDate)) / 86400000);

  // ── Month pattern ─────────────────────────────────────────────────────────
  const monthCounts = {};
  for (const e of events) {
    const m = new Date(e.date).getMonth(); // 0-11
    monthCounts[m] = (monthCounts[m] || 0) + 1;
  }

  const now          = new Date();
  const currentMonth = now.getMonth();

  // Months appearing 2+ times → strong signal
  const repeatedMonths = Object.entries(monthCounts)
    .filter(([, c]) => c >= 2).map(([m]) => +m).sort((a, b) => a - b);
  const anyMonths = Object.keys(monthCounts).map(Number).sort((a, b) => a - b);
  const patternMonths = repeatedMonths.length ? repeatedMonths : anyMonths;

  // Find the next upcoming month in the pattern
  let nextPredictedDate = null;
  const predictedMonths = [];
  for (let offset = 1; offset <= 12; offset++) {
    const futureMonth = (currentMonth + offset) % 12;
    if (patternMonths.includes(futureMonth)) {
      const year = futureMonth <= currentMonth ? now.getFullYear() + 1 : now.getFullYear();
      nextPredictedDate = `${year}-${String(futureMonth + 1).padStart(2, '0')}-01`;
      for (const m of patternMonths) predictedMonths.push(MONTH_NAMES_ES[m]);
      break;
    }
  }

  // ── Confidence ────────────────────────────────────────────────────────────
  let confidence;
  if (repeatedMonths.length >= 1 && saleCount >= 2) {
    confidence = 'high';
  } else if (saleCount >= 1 && events.some(e => new Date(e.date).getFullYear() < now.getFullYear())) {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }

  // ── On sale right now? ────────────────────────────────────────────────────
  const onSaleNow = !!(pp?.discount_until && new Date(pp.discount_until) > now);

  // ── Verdict text ──────────────────────────────────────────────────────────
  let verdict;
  if (onSaleNow) {
    verdict = `🔥 EN OFERTA — termina ${pp.discount_until}`;
  } else if (daysSinceLastSale <= 30) {
    verdict = `✅ OFERTA RECIENTE — hace ${daysSinceLastSale} días`;
  } else if (nextPredictedDate) {
    const daysUntil = Math.floor((new Date(nextPredictedDate) - now) / 86400000);
    const monthName = MONTH_NAMES_ES[new Date(nextPredictedDate).getMonth()];
    verdict = daysUntil <= 60
      ? `⏳ ESPERÁ — probable oferta en ${monthName} (confianza: ${confidence})`
      : `📅 Hace ${daysSinceLastSale}d sin oferta — próxima estimada ${monthName}`;
  } else if (daysSinceLastSale > 120) {
    verdict = `🔴 Hace ${daysSinceLastSale} días sin oferta — sin patrón claro`;
  } else {
    verdict = `📊 ${saleCount} oferta${saleCount !== 1 ? 's' : ''} registrada${saleCount !== 1 ? 's' : ''} — hace ${daysSinceLastSale}d`;
  }

  return {
    saleCount,
    avgDiscountPct,
    bestPrice: bestEvent
      ? { price: bestEvent.price, date: bestEvent.date, discountPct: bestEvent.discountPct }
      : null,
    lastSaleDate,
    daysSinceLastSale,
    predictedMonths,
    nextPredictedDate,
    confidence,
    verdict,
    onSaleNow,
    basePriceUsd: pp?.base_price_usd ?? null,
  };
}

function _empty(pp = null) {
  return {
    saleCount:         0,
    avgDiscountPct:    null,
    bestPrice:         null,
    lastSaleDate:      null,
    daysSinceLastSale: null,
    predictedMonths:   [],
    nextPredictedDate: null,
    confidence:        'low',
    verdict:           '❓ Sin historial de ofertas',
    onSaleNow:         false,
    basePriceUsd:      pp?.base_price_usd ?? null,
  };
}

module.exports = { analyzeSaleCycle };
