const { chromium } = require('playwright-extra');
const stealth      = require('puppeteer-extra-plugin-stealth');
const cheerio      = require('cheerio');
const { recordPrice } = require('../db/database');

chromium.use(stealth());

const BASE = 'https://psdeals.net';
const HEADLESS  = process.env.PLAYWRIGHT_HEADLESS !== 'false';
const EXECUTABLE = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;

// Memory-optimised flags — crucial on Railway's 512 MB container.
// Note: --single-process and --no-zygote are Linux-only; don't add them here.
const LAUNCH_OPTS = {
  headless:     HEADLESS,
  executablePath: EXECUTABLE,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-default-apps',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--mute-audio',
    '--no-first-run',
    '--window-size=1280,800',
  ],
};

// PSDeals AR store already shows prices converted to USD ("US$4.49")
function parseUsdPrice(text) {
  if (!text) return null;
  const clean = text.replace(/[^\d.]/g, '');
  const num   = parseFloat(clean);
  return isNaN(num) || num === 0 ? null : num;
}

// Parse game cards from PSDeals HTML using cheerio (fast, no DOM queries)
function extractCards(html) {
  const $     = cheerio.load(html);
  const items = [];

  // .game-collection-item is the outer card; sub-elements have longer class
  // names like game-collection-item-link, so exact-class selector is correct.
  $('.game-collection-item').each((_, el) => {
    const $el      = $(el);
    const title    = $el.find('.game-collection-item-details-title').first().text().trim();
    const priceRaw = $el.find('.game-collection-item-price-discount').first().text().trim();
    const discText = $el.find('.game-collection-item-discount').first().text().trim();
    const href     = $el.find('.game-collection-item-link').attr('href')
                  || $el.find('a').first().attr('href')
                  || '';

    if (!title || !href) return;

    items.push({
      title,
      priceRaw,
      priceUsd:  parseUsdPrice(priceRaw),
      discount:  parseInt(discText.replace(/\D/g, '') || '0', 10),
      detailUrl: href.startsWith('http') ? href : `${BASE}${href}`,
    });
  });

  return items;
}

async function withBrowser(fn) {
  const browser = await chromium.launch(LAUNCH_OPTS);
  try {
    return await fn(browser);
  } finally {
    await browser.close().catch(() => {});
  }
}

async function fetchHtml(browser, url) {
  const page = await browser.newPage();
  try {
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'es-AR,es;q=0.9,en;q=0.8',
    });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Wait for at least one game card to appear
    await page.waitForSelector('.game-collection-item', { timeout: 15000 }).catch(() => {});
    return await page.content();
  } finally {
    await page.close().catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  SEARCH — single game lookup
// ─────────────────────────────────────────────────────────────────────────────
async function searchPsDeals(query) {
  try {
    return await withBrowser(async (browser) => {
      const html  = await fetchHtml(browser, `${BASE}/ar-store/search?search_query=${encodeURIComponent(query)}`);
      const cards = extractCards(html);

      if (!cards.length) return { found: false, query };

      const best = cards[0];

      if (best.priceUsd) {
        recordPrice(best.title, 'psdeals', best.priceUsd, {
          raw: best.priceRaw, currency: 'USD', discount: best.discount,
        });
      }

      return {
        found:    true,
        title:    best.title,
        priceUsd: best.priceUsd,
        priceRaw: best.priceRaw,
        discount: best.discount,
        saleEnd:  null,
        detailUrl: best.detailUrl,
        history:  [],
        saleDates: [],
        lowestUsd: null,
      };
    });
  } catch (err) {
    console.error('PSDeals search error:', err.message);
    return { found: false, query, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  BULK — scrape all discounted deals across paginated PSDeals AR pages
// ─────────────────────────────────────────────────────────────────────────────
async function scrapeAllDeals(onProgress) {
  return withBrowser(async (browser) => {
    const games   = [];
    const seenUrls = new Set();

    for (let page = 1; page <= 20; page++) {
      const url = page === 1
        ? `${BASE}/ar-store`
        : `${BASE}/ar-store?page=${page}`;

      try {
        const html  = await fetchHtml(browser, url);
        const items = extractCards(html);

        if (!items.length) break;

        let added = 0;
        for (const item of items) {
          if (seenUrls.has(item.detailUrl)) continue;
          seenUrls.add(item.detailUrl);
          games.push(item);
          added++;
        }

        if (onProgress) onProgress({ page, count: games.length, status: 'psdeals' });

        // If nothing was new, we've looped back to the start
        if (added === 0) break;
        // Fewer than 10 unique results → last page
        if (items.length < 10) break;
      } catch (err) {
        console.warn(`PSDeals page ${page} error:`, err.message);
        break;
      }
    }

    return games;
  });
}

module.exports = { searchPsDeals, scrapeAllDeals };
