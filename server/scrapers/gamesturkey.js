const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth');
const Fuse = require('fuse.js');

chromium.use(stealth());

const HEADLESS = process.env.PLAYWRIGHT_HEADLESS !== 'false';
const BASE_DELAY = parseInt(process.env.SCRAPER_DELAY_MS || '1500', 10);
const EXECUTABLE = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;

const LAUNCH_OPTS = {
  headless: HEADLESS,
  executablePath: EXECUTABLE,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
};

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randomDelay()   { return sleep(BASE_DELAY + Math.random() * BASE_DELAY); }

function parseUsdPrice(text) {
  if (!text) return null;
  const m = text.match(/[\d]+[.,]?[\d]*/);
  if (!m) return null;
  const num = parseFloat(m[0].replace(',', '.'));
  return isNaN(num) ? null : num;
}

// ─────────────────────────────────────────────────────────────────────────────
//  SEARCH — fuzzy-match a single game
// ─────────────────────────────────────────────────────────────────────────────
async function searchGamesTurkey(query) {
  const browser = await chromium.launch(LAUNCH_OPTS);
  try {
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
    });

    const url = `https://gamesturkeyacc.com/product_search.php?query=${encodeURIComponent(query)}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await randomDelay();

    const results = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll(
        '.product-item, [class*="product-card"], [class*="game-item"], .item, li[class*="product"]'
      ));
      return items.map(el => {
        const titleEl = el.querySelector('[class*="title"], [class*="name"], h3, h4, .product-title, a');
        const priceEl = el.querySelector('[class*="price"], .price, [class*="cost"]');
        const linkEl  = el.querySelector('a');
        return {
          title:    titleEl?.textContent?.trim() || '',
          priceRaw: priceEl?.textContent?.trim() || '',
          href:     linkEl?.getAttribute('href') || '',
        };
      }).filter(i => i.title);
    });

    if (!results.length) {
      return { found: false, query };
    }

    // Fuzzy match
    const fuse = new Fuse(results, { keys: ['title'], threshold: 0.4 });
    const hits  = fuse.search(query);

    if (!hits.length) return { found: false, query };

    const best = hits[0].item;
    const price = parseUsdPrice(best.priceRaw);

    return {
      found:    true,
      title:    best.title,
      priceUsd: price,
      priceRaw: best.priceRaw,
      url:      best.href.startsWith('http') ? best.href : `https://gamesturkeyacc.com${best.href}`,
    };
  } finally {
    await browser.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  BULK — scrape all products from given category ids
// ─────────────────────────────────────────────────────────────────────────────
async function scrapeAllProducts(categoryIds = [1, 12, 21], onProgress) {
  const browser = await chromium.launch(LAUNCH_OPTS);
  const allProducts = [];

  try {
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
    });

    for (const catId of categoryIds) {
      let pageNum = 1;
      let hasMore = true;

      while (hasMore) {
        const url = `https://gamesturkeyacc.com/product_search.php?query=&category_id=${catId}&page=${pageNum}`;
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await randomDelay();

          const items = await page.evaluate(() => {
            const els = Array.from(document.querySelectorAll(
              '.product-item, [class*="product-card"], [class*="game-card"], .item, li[class*="product"]'
            ));
            return els.map(el => {
              const titleEl = el.querySelector('[class*="title"], [class*="name"], h3, h4, a');
              const priceEl = el.querySelector('[class*="price"], .price');
              const linkEl  = el.querySelector('a');
              return {
                title:    titleEl?.textContent?.trim() || '',
                priceRaw: priceEl?.textContent?.trim() || '',
                href:     linkEl?.getAttribute('href') || '',
              };
            }).filter(i => i.title);
          });

          if (!items.length) { hasMore = false; break; }

          for (const item of items) {
            allProducts.push({
              title:    item.title,
              priceUsd: parseUsdPrice(item.priceRaw),
              priceRaw: item.priceRaw,
              url:      item.href.startsWith('http') ? item.href : `https://gamesturkeyacc.com${item.href}`,
              categoryId: catId,
            });
          }

          if (onProgress) onProgress({ category: catId, page: pageNum, total: allProducts.length, status: 'gamesturkey' });

          hasMore = items.length >= 10;
          pageNum++;
          if (pageNum > 20) hasMore = false;
        } catch (err) {
          console.warn(`GamesturkeyACC cat=${catId} page=${pageNum} error:`, err.message);
          hasMore = false;
        }
      }
    }
  } finally {
    await browser.close();
  }

  return allProducts;
}

module.exports = { searchGamesTurkey, scrapeAllProducts };
