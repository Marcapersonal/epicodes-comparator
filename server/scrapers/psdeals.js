const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth');
const { getArsToUsd, recordPrice, savePriceDetailHistory } = require('../db/database');

chromium.use(stealth());

const HEADLESS = process.env.PLAYWRIGHT_HEADLESS !== 'false';
const BASE_DELAY = parseInt(process.env.SCRAPER_DELAY_MS || '1500', 10);
const EXECUTABLE = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;

const LAUNCH_OPTS = {
  headless: HEADLESS,
  executablePath: EXECUTABLE,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--window-size=1280,900',
  ],
};

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function randomDelay() {
  return sleep(BASE_DELAY + Math.random() * BASE_DELAY);
}

function parseArsPrice(text) {
  if (!text) return null;
  // Formats: "ARS 12.990", "$12.990", "12990", "12,990"
  const clean = text.replace(/[^\d.,]/g, '').replace(/\./g, '').replace(',', '.');
  const num = parseFloat(clean);
  return isNaN(num) ? null : num;
}

function arsToUsd(ars) {
  const rate = getArsToUsd();
  return rate > 0 ? Math.round((ars / rate) * 100) / 100 : null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  SEARCH — returns the best-match game + its detail page data
// ─────────────────────────────────────────────────────────────────────────────
async function searchPsDeals(query) {
  const browser = await chromium.launch(LAUNCH_OPTS);
  try {
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'es-AR,es;q=0.9,en;q=0.8',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    });

    const searchUrl = `https://psdeals.net/ar-store/search?search_query=${encodeURIComponent(query)}`;
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await randomDelay();

    // Grab first result
    const firstResult = await page.evaluate(() => {
      const card = document.querySelector('.game-collection-item, .search-result-item, [class*="game-item"]');
      if (!card) return null;
      const titleEl   = card.querySelector('[class*="title"], h3, h4, .game-title');
      const priceEl   = card.querySelector('[class*="price"], .price, [class*="current"]');
      const discEl    = card.querySelector('[class*="discount"], .discount, [class*="percent"]');
      const linkEl    = card.querySelector('a');
      return {
        title:    titleEl?.textContent?.trim() || null,
        priceRaw: priceEl?.textContent?.trim() || null,
        discount: discEl?.textContent?.trim() || null,
        href:     linkEl?.getAttribute('href') || null,
      };
    });

    if (!firstResult || !firstResult.href) {
      return { found: false, query };
    }

    // Navigate to detail page
    const detailUrl = firstResult.href.startsWith('http')
      ? firstResult.href
      : `https://psdeals.net${firstResult.href}`;

    await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await randomDelay();

    const detail = await page.evaluate(() => {
      // Title
      const title = document.querySelector('h1, [class*="game-title"]')?.textContent?.trim();

      // Current price
      const priceEl = document.querySelector('[class*="price-display"], [class*="current-price"], .game-info-price');
      const priceRaw = priceEl?.textContent?.trim() || null;

      // Discount badge
      const discEl = document.querySelector('[class*="discount"], .discount-badge');
      const discount = discEl ? parseInt(discEl.textContent?.replace(/[^0-9]/g, ''), 10) || 0 : 0;

      // Sale end date
      const timerEl = document.querySelector('[class*="timer"], [class*="end-date"], [class*="sale-end"]');
      const saleEnd = timerEl?.getAttribute('data-end') || timerEl?.textContent?.trim() || null;

      // Price history — PSDeals sometimes has a table or embeds JSON in a script
      let historyPoints = [];
      try {
        const scripts = Array.from(document.querySelectorAll('script:not([src])'));
        for (const s of scripts) {
          const m = s.textContent.match(/price_history\s*[:=]\s*(\[[\s\S]*?\])/);
          if (m) {
            historyPoints = JSON.parse(m[1]);
            break;
          }
          const m2 = s.textContent.match(/"prices"\s*:\s*(\[[\s\S]*?\])/);
          if (m2) {
            historyPoints = JSON.parse(m2[1]);
            break;
          }
        }
      } catch (_) {}

      // Fallback: history table rows
      if (!historyPoints.length) {
        document.querySelectorAll('[class*="history"] tr, [class*="price-history"] tr').forEach(row => {
          const cells = row.querySelectorAll('td');
          if (cells.length >= 2) {
            historyPoints.push({ date: cells[0]?.textContent?.trim(), price: cells[1]?.textContent?.trim() });
          }
        });
      }

      // Lowest historical price element
      const lowestEl = document.querySelector('[class*="lowest"], [class*="min-price"]');
      const lowest = lowestEl?.textContent?.trim() || null;

      return { title, priceRaw, discount, saleEnd, historyPoints, lowest };
    });

    const priceArs = parseArsPrice(detail.priceRaw || firstResult.priceRaw);
    const priceUsd = priceArs ? arsToUsd(priceArs) : null;

    // Parse history points
    const historyParsed = detail.historyPoints.map(p => {
      const priceVal = typeof p === 'object'
        ? (parseArsPrice(String(p.price || p.y || p.value || '')) || null)
        : null;
      return {
        date:  typeof p === 'object' ? (p.date || p.x || p.label || '') : '',
        price: priceVal ? arsToUsd(priceVal) : null,
      };
    }).filter(p => p.price !== null);

    // Save history to DB
    if (historyParsed.length > 0) {
      savePriceDetailHistory(detail.title || query, historyParsed);
    }

    // Save current price to history
    if (priceUsd) {
      recordPrice(detail.title || query, 'psdeals', priceUsd, {
        raw:      detail.priceRaw,
        currency: 'ARS→USD',
        discount: detail.discount,
        saleEnd:  detail.saleEnd,
      });
    }

    // Detect sale dates pattern for prediction
    const saleDatesForPrediction = historyParsed
      .filter(p => p.date)
      .map(p => p.date)
      .filter(Boolean);

    return {
      found:        true,
      title:        detail.title || firstResult.title || query,
      priceArs,
      priceUsd,
      priceRaw:     detail.priceRaw || firstResult.priceRaw,
      discount:     detail.discount,
      saleEnd:      detail.saleEnd,
      detailUrl,
      history:      historyParsed,
      saleDates:    saleDatesForPrediction,
      lowestRaw:    detail.lowest,
      lowestUsd:    detail.lowest ? arsToUsd(parseArsPrice(detail.lowest) || 0) || null : null,
    };
  } finally {
    await browser.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  BULK — scrape all discounted games from PSDeals AR (paginated)
// ─────────────────────────────────────────────────────────────────────────────
async function scrapeAllDeals(onProgress) {
  const browser = await chromium.launch(LAUNCH_OPTS);
  const games = [];

  try {
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'es-AR,es;q=0.9',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
    });

    let pageNum = 1;
    let hasMore = true;

    while (hasMore) {
      const url = `https://psdeals.net/ar-store?page=${pageNum}`;
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await randomDelay();

        const items = await page.evaluate(() => {
          const cards = Array.from(document.querySelectorAll(
            '.game-collection-item, [class*="game-card"], [class*="deal-card"]'
          ));
          return cards.map(card => {
            const titleEl = card.querySelector('[class*="title"], h3, h4');
            const priceEl = card.querySelector('[class*="price"]:not([class*="old"])');
            const discEl  = card.querySelector('[class*="discount"], [class*="percent"]');
            const linkEl  = card.querySelector('a');
            const endEl   = card.querySelector('[class*="timer"], [class*="end"]');
            return {
              title:    titleEl?.textContent?.trim() || '',
              priceRaw: priceEl?.textContent?.trim() || '',
              discount: parseInt(discEl?.textContent?.replace(/\D/g, '') || '0', 10),
              href:     linkEl?.getAttribute('href') || '',
              saleEnd:  endEl?.getAttribute('data-end') || endEl?.textContent?.trim() || null,
            };
          }).filter(i => i.title && i.href);
        });

        if (items.length === 0) {
          hasMore = false;
          break;
        }

        for (const item of items) {
          const priceArs = parseArsPrice(item.priceRaw);
          const priceUsd = priceArs ? arsToUsd(priceArs) : null;
          games.push({
            title:    item.title,
            priceUsd,
            priceRaw: item.priceRaw,
            discount: item.discount,
            saleEnd:  item.saleEnd,
            detailUrl: item.href.startsWith('http') ? item.href : `https://psdeals.net${item.href}`,
          });
        }

        if (onProgress) onProgress({ page: pageNum, count: games.length, status: 'psdeals' });

        // PSDeals: if we got fewer than 10 items there's probably no next page
        hasMore = items.length >= 10;
        pageNum++;

        // Safety cap
        if (pageNum > 30) hasMore = false;
      } catch (err) {
        console.warn(`PSDeals page ${pageNum} error:`, err.message);
        hasMore = false;
      }
    }
  } finally {
    await browser.close();
  }

  return games;
}

module.exports = { searchPsDeals, scrapeAllDeals };
