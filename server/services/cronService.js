const cron = require('node-cron');
const { getDb, getGiftCardRate } = require('../db/database');
const { searchPsDeals }     = require('../scrapers/psdeals');
const { searchGamesTurkey } = require('../scrapers/gamesturkey');
const { sendAlert } = require('./alertService');

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
      const [psResult] = await Promise.allSettled([searchPsDeals(item.game_name)]);
      const ps = psResult.status === 'fulfilled' ? psResult.value : null;
      if (!ps?.priceUsd) continue;

      const realCost = Math.round(ps.priceUsd * giftCardRate * 100) / 100;

      if (realCost <= item.alert_price) {
        // Get last price from history to calculate drop
        const lastPriceRow = db.prepare(
          `SELECT price_usd FROM price_history WHERE game_name = ? AND source = 'psdeals' ORDER BY scraped_at DESC LIMIT 2`
        ).all(item.game_name);
        const oldPrice = lastPriceRow[1] ? lastPriceRow[1].price_usd * giftCardRate : null;

        await sendAlert({
          watchlistId: item.id,
          gameName:    item.game_name,
          oldPrice,
          newPrice:    realCost,
          psdealsUrl:  item.psdeals_url,
        });
      }

      db.prepare('UPDATE watchlist SET last_checked = ? WHERE id = ?')
        .run(new Date().toISOString(), item.id);
    } catch (err) {
      console.error(`[cron] Error checking ${item.game_name}:`, err.message);
    }
  }
}

async function runDailyBulk() {
  try {
    // Trigger bulk via the route's logic (import runBulkScrape separately to avoid circular deps)
    console.log('[cron] Daily bulk scrape triggered — use POST /api/bulk/refresh for full run.');
  } catch (err) {
    console.error('[cron] Daily bulk error:', err.message);
  }
}

function startCron() {
  // Every day at 09:00 server time
  cron.schedule('0 9 * * *', async () => {
    console.log('[cron] Daily watchlist check starting...');
    await checkWatchlist();
    await runDailyBulk();
    console.log('[cron] Done.');
  });
  console.log('[cron] Scheduler started — daily check at 09:00');
}

module.exports = { startCron, checkWatchlist };
