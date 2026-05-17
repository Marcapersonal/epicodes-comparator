const { chromium } = require('playwright-extra');
const stealth      = require('puppeteer-extra-plugin-stealth');
const cheerio      = require('cheerio');

chromium.use(stealth());

const BASE = 'https://psdeals.net';

const LAUNCH_OPTS = {
  headless: process.env.PLAYWRIGHT_HEADLESS !== 'false',
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
  args: [
    '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
    '--disable-gpu', '--disable-extensions', '--mute-audio', '--no-first-run',
    '--window-size=1280,800',
  ],
};

// Search PSDeals US store for a game, return the detail page URL
async function findGameUrl(page, gameName) {
  const url = `${BASE}/us-store/search?search_query=${encodeURIComponent(gameName)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // PSDeals renders results via JS — wait for either the game cards or a "no results" indicator
  await Promise.race([
    page.waitForSelector('a[href*="/us-store/game/"]', { timeout: 15000 }),
    page.waitForSelector('.game-collection-item',      { timeout: 15000 }),
    page.waitForTimeout(8000),
  ]).catch(() => {});

  // Try direct link selector first
  const directHref = await page.evaluate(() => {
    const a = document.querySelector('a[href*="/us-store/game/"]');
    return a?.href || null;
  });
  if (directHref) return directHref;

  // Fallback: cheerio parse
  const html = await page.content();
  const $    = cheerio.load(html);
  const href = $('.game-collection-item').first()
    .find('.game-collection-item-link, a[href*="/game/"]').first().attr('href');
  if (!href) return null;
  return href.startsWith('http') ? href : `${BASE}${href}`;
}

// Extract Highcharts price history from a PSDeals game detail page
async function extractHistory(page, gameUrl) {
  await page.goto(gameUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Wait for the chart container
  await page.waitForSelector('[id*="highcharts"], [id*="chart"], .highcharts-container', {
    timeout: 15000,
  }).catch(() => {});

  // Give Highcharts time to init
  await page.waitForTimeout(2000);

  // Extract via Highcharts JS object
  const points = await page.evaluate(() => {
    if (!window.Highcharts || !Highcharts.charts) return null;
    const chart = Highcharts.charts.find(c => c && c.series && c.series.length > 0);
    if (!chart) return null;
    const series = chart.series.find(s => s.options && s.options.data && s.options.data.length > 0);
    if (!series) return null;
    return series.options.data.map(pt => Array.isArray(pt) ? pt : [pt.x, pt.y]);
  });

  if (points && points.length > 0) {
    return points
      .filter(([ts, price]) => ts != null && price != null && price > 0)
      .map(([ts, price]) => ({
        date:     new Date(ts).toISOString().slice(0, 10),
        priceUsd: Math.round(price * 100) / 100,
      }));
  }

  // Fallback: parse inline script for serialized chart data
  const html = await page.content();
  return extractFromScript(html);
}

function extractFromScript(html) {
  // Look for Highcharts series data patterns in inline scripts
  const match = html.match(/series\s*:\s*\[\s*\{[^}]*data\s*:\s*(\[\s*\[[^\]]+\][^\]]*\])/s);
  if (!match) return [];
  try {
    const raw = JSON.parse(match[1]);
    return raw
      .filter(pt => Array.isArray(pt) && pt[0] != null && pt[1] > 0)
      .map(([ts, price]) => ({
        date:     new Date(ts).toISOString().slice(0, 10),
        priceUsd: Math.round(price * 100) / 100,
      }));
  } catch (_) {
    return [];
  }
}

// Main export: fetch history for a list of games.
// onProgress({ done, total, current, saved })
async function fetchHistoryBatch(gameNames, onProgress) {
  const browser = await chromium.launch(LAUNCH_OPTS);
  const page    = await browser.newPage();
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'es-AR,es;q=0.9,en;q=0.8' });

  const results = [];
  let saved = 0;

  try {
    for (let i = 0; i < gameNames.length; i++) {
      const name = gameNames[i];
      let history = [];
      try {
        const gameUrl = await findGameUrl(page, name);
        if (gameUrl) {
          history = await extractHistory(page, gameUrl);
          if (history.length > 0) saved++;
        }
      } catch (err) {
        console.warn(`[history] ${name}: ${err.message}`);
      }
      results.push({ name, history });
      onProgress?.({ done: i + 1, total: gameNames.length, current: name, saved });
    }
  } finally {
    await browser.close().catch(() => {});
  }

  return results;
}

module.exports = { fetchHistoryBatch };
