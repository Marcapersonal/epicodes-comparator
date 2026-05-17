const axios   = require('axios');
const cheerio = require('cheerio');
const Fuse    = require('fuse.js');

const BASE = 'https://gamesturkeyacc.com';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept':     'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

async function getHtml(url) {
  const { data } = await axios.get(url, { headers: HEADERS, timeout: 20000 });
  return data;
}

function parseUsdPrice(text) {
  if (!text) return null;
  const m = text.match(/\$?\s*([\d]+\.?[\d]*)/);
  if (!m) return null;
  const num = parseFloat(m[1]);
  return isNaN(num) || num === 0 ? null : num;
}

// GamesturkeyACC is a PHP server-rendered site. Product cards are identified
// by their "product_details" links. Each card div contains an h3 (title) and
// a span with class "text-primary font-bold" (price).
function extractProducts(html) {
  const $        = cheerio.load(html);
  const products = [];
  const seenHrefs = new Set();

  $('a[href*="product_details"]').each((_, linkEl) => {
    const href = $(linkEl).attr('href') || '';
    if (!href || seenHrefs.has(href)) return;
    seenHrefs.add(href);

    // Walk up until we find a container that has an h3 (the product card)
    let $card = $(linkEl).parent();
    let depth = 0;
    while ($card.length && !$card.find('h3').length && depth < 6) {
      $card = $card.parent();
      depth++;
    }
    if (!$card.find('h3').length) return;

    const title    = $card.find('h3').first().text().trim();
    if (!title) return;

    // Price is in a span that contains "$"
    const priceRaw = $card.find('span').filter((_, s) => $(s).text().includes('$'))
                          .first().text().trim();

    const url = href.startsWith('http') ? href : `${BASE}/${href.replace(/^\//, '')}`;

    products.push({
      title,
      priceUsd: parseUsdPrice(priceRaw),
      priceRaw,
      url,
    });
  });

  return products;
}

// ─────────────────────────────────────────────────────────────────────────────
//  SEARCH — fuzzy match a single game
// ─────────────────────────────────────────────────────────────────────────────
async function searchGamesTurkey(query) {
  try {
    const html     = await getHtml(`${BASE}/product_search.php?query=${encodeURIComponent(query)}`);
    const products = extractProducts(html);

    if (!products.length) return { found: false, query };

    const fuse = new Fuse(products, { keys: ['title'], threshold: 0.4 });
    const hits = fuse.search(query);
    if (!hits.length) return { found: false, query };

    const best = hits[0].item;
    return { found: true, ...best };
  } catch (err) {
    console.error('GamesturkeyACC search error:', err.message);
    return { found: false, query, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  BULK — scrape all category pages (single page each, no pagination needed)
// ─────────────────────────────────────────────────────────────────────────────
// Try all category IDs from 1-30 — empty ones return nothing and are skipped
async function scrapeAllProducts(categoryIds = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30], onProgress) {
  const allProducts = [];
  const seenUrls    = new Set();

  for (const catId of categoryIds) {
    // Each category loads all its products server-side on one page.
    // We still try a second page in case the site adds pagination later.
    for (let page = 1; page <= 5; page++) {
      const url = page === 1
        ? `${BASE}/product_category.php?category_id=${catId}`
        : `${BASE}/product_category.php?category_id=${catId}&page=${page}`;

      try {
        const html  = await getHtml(url);
        const items = extractProducts(html);

        if (!items.length) break;

        let added = 0;
        for (const item of items) {
          if (seenUrls.has(item.url)) continue;
          seenUrls.add(item.url);
          allProducts.push({ ...item, categoryId: catId });
          added++;
        }

        if (onProgress) onProgress({ category: catId, page, total: allProducts.length, status: 'gamesturkey' });

        // If we got nothing new or fewer than 10 items, stop paginating
        if (added === 0 || items.length < 10) break;
      } catch (err) {
        console.warn(`GamesturkeyACC cat=${catId} page=${page}:`, err.message);
        break;
      }
    }
  }

  return allProducts;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Scrape a single product detail page for Spanish language support
//  Structure: <strong>Audio:</strong> English, French, Spanish, ...
//             <strong>Interface:</strong> ...  <strong>Subtitles:</strong> ...
// ─────────────────────────────────────────────────────────────────────────────
async function scrapeProductLang(url) {
  try {
    const html = await getHtml(url);
    // Match <strong>Audio:</strong> followed by languages on same line
    const spanishAudio = /<strong>\s*(?:Audio|Voice)[^<]*<\/strong>[^<\n]*Spanish/i.test(html);
    // Match Interface / Text / Subtitles sections
    const spanishText  = /<strong>\s*(?:Interface|Text|Subtitle)[^<]*<\/strong>[^<\n]*Spanish/i.test(html);
    return { spanishAudio, spanishText };
  } catch (_) {
    return { spanishAudio: false, spanishText: false };
  }
}

module.exports = { searchGamesTurkey, scrapeAllProducts, scrapeProductLang };
