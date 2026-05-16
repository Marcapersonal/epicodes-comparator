const cron = require('node-cron');
const { getDb, getGiftCardRate } = require('../db/database');
const { searchPsStoreAR }    = require('../scrapers/psstore');
const { searchGamesTurkey }  = require('../scrapers/gamesturkey');
const { sendAlert }          = require('./alertService');

// Lazy-load to avoid circular dependency at startup
function getHistoryStarter() {
  return require('../routes/history').startHistoryJob;
}

async function checkWatchlist() {
  const db = getDb();
  const items = db.prepare(
    'SELECT * FROM watchlist WHERE alert_enabled = 1 AND alert_price IS NOT NULL'
  ).all();

  if (!items.length) return;

  console.log(`[cron] Checking ${items.length} watchlist items...`);
  const giftCardRate = getGiftCardRate();

  for (const item of items) {
    try {
      const [psResult, turkeyResult] = await Promise.allSettled([
        searchPsStoreAR(item.game_name),
        searchGamesTurkey(item.game_name),
      ]);
      const ps = psResult.status === 'fulfilled' ? psResult.value : null;
      if (!ps?.priceUsd) continue;

      const realCost = Math.round(ps.priceUsd * giftCardRate * 100) / 100;

      if (realCost <= item.alert_price) {
        const lastPriceRow = db.prepare(
          `SELECT price_usd FROM price_history WHERE game_name = ? AND source = 'psstore-ar' ORDER BY scraped_at DESC LIMIT 2`
        ).all(item.game_name);
        const oldPrice = lastPriceRow[1] ? lastPriceRow[1].price_usd * giftCardRate : null;

        await sendAlert({
          watchlistId: item.id,
          gameName:    item.game_name,
          oldPrice,
          newPrice:    realCost,
          psdealsUrl:  ps.detailUrl || item.psdeals_url,
        });
      }

      db.prepare('UPDATE watchlist SET last_checked = ? WHERE id = ?')
        .run(new Date().toISOString(), item.id);
    } catch (err) {
      console.error(`[cron] Error checking ${item.game_name}:`, err.message);
    }
  }
}

function startCron() {
  // Daily watchlist check at 09:00
  cron.schedule('0 9 * * *', async () => {
    console.log('[cron] Daily watchlist check...');
    await checkWatchlist();
    console.log('[cron] Watchlist done.');
  });

  // Weekly history top-up: every Monday at 03:00
  // Fetches history only for games that don't have it yet (incremental, fast after first run)
  cron.schedule('0 3 * * 1', () => {
    console.log('[cron] Weekly history top-up...');
    try { getHistoryStarter()('cron-weekly'); } catch (err) {
      console.error('[cron] History start error:', err.message);
    }
  });

  console.log('[cron] Scheduler started — daily watchlist 09:00 | weekly history Mon 03:00');
}

module.exports = { startCron, checkWatchlist };
