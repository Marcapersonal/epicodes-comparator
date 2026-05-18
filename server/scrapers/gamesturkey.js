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

// Extract products from a search-results or category page
function extractProducts(html) {
  const $        = cheerio.load(html);
  const products = [];
  const seenHrefs = new Set();

  $('a[href*="product_details"]').each((_, linkEl) => {
    const href = $(linkEl).attr('href') || '';
    if (!href || seenHrefs.has(href)) return;
    seenHrefs.add(href);

    let $card = $(linkEl).parent();
    let depth = 0;
    while ($card.length && !$card.find('h3').length && depth < 6) {
      $card = $card.parent();
      depth++;
    }
    if (!$card.find('h3').length) return;

    const title    = $card.find('h3').first().text().trim();
    if (!title) return;

    const priceRaw = $card.find('span').filter((_, s) => $(s).text().includes('$'))
                          .first().text().trim();

    const url = href.startsWith('http') ? href : `${BASE}/${href.replace(/^\//, '')}`;
    products.push({ title, priceUsd: parseUsdPrice(priceRaw), priceRaw, url });
  });

  return products;
}

// ─────────────────────────────────────────────────────────────────────────────
//  NEW: fetchTurkeyPriceByUrl — fetch live price from a stored product detail URL
//  Returns: { priceUsd, priceRaw, spanishAudio, spanishText } or null
// ─────────────────────────────────────────────────────────────────────────────
async function fetchTurkeyPriceByUrl(url) {
  if (!url) return null;
  try {
    const html = await getHtml(url);
    const $    = cheerio.load(html);

    // ── Price extraction ─────────────────────────────────────────────────────
    let priceUsd = null;
    let priceRaw = null;

    // Strategy 1: span with class containing "text-primary" and "font-bold" (existing scraper uses this)
    const primaryBold = $('span.text-primary.font-bold, span[class*="text-primary"][class*="font-bold"]')
      .filter((_, el) => /\$\s*[\d]/.test($(el).text())).first();
    if (primaryBold.length) {
      priceRaw = primaryBold.text().trim();
      priceUsd = parseUsdPrice(priceRaw);
    }

    // Strategy 2: any span containing $price
    if (!priceUsd) {
      $('span, p, div').filter((_, el) => /\$\s*[\d]/.test($(el).text())).each((_, el) => {
        if (priceUsd) return;
        const text = $(el).text().trim().split('\n')[0].trim();
        const parsed = parseUsdPrice(text);
        if (parsed && parsed > 0.5 && parsed < 1000) {
          priceUsd = parsed;
          priceRaw = text;
        }
      });
    }

    // Strategy 3: regex on raw HTML
    if (!priceUsd) {
      const m = html.match(/\$\s*([\d]+\.?[\d]{0,2})/);
      if (m) {
        priceUsd = parseFloat(m[1]);
        priceRaw = `$${m[1]}`;
      }
    }

    // ── Language detection ───────────────────────────────────────────────────
    const spanishAudio = /<strong[^>]*>\s*(?:Audio|Voice)[^<]*<\/strong>[^<\n]*Spanish/i.test(html);
    const spanishText  = /<strong[^>]*>\s*(?:Interface|Text|Subtitle)[^<]*<\/strong>[^<\n]*Spanish/i.test(html);

    if (!priceUsd) {
      console.warn(`[gamesturkey] fetchTurkeyPriceByUrl: no price at ${url}`);
      return null;
    }

    return { priceUsd, priceRaw, spanishAudio, spanishText };
  } catch (err) {
    console.warn(`[gamesturkey] fetchTurkeyPriceByUrl error for ${url}:`, err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  SEARCH — fuzzy match a single game, returns with confidence score
// ─────────────────────────────────────────────────────────────────────────────
async function searchGamesTurkey(query) {
  try {
    const html     = await getHtml(`${BASE}/product_search.php?query=${encodeURIComponent(query)}`);
    const products = extractProducts(html);

    if (!products.length) return { found: false, query };

    const fuse = new Fuse(products, { keys: ['title'], threshold: 0.4, includeScore: true });
    const hits  = fuse.search(query);
    if (!hits.length) return { found: false, query };

    const best       = hits[0];
    const confidence = Math.round((1 - (best.score ?? 0)) * 100);
    return { found: true, ...best.item, turkey_confidence: Math.min(100, confidence) };
  } catch (err) {
    console.error('GamesturkeyACC search error:', err.message);
    return { found: false, query, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  BULK — scrape all category pages
// ─────────────────────────────────────────────────────────────────────────────
async function scrapeAllProducts(
  categoryIds = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30],
  onProgress
) {
  const allProducts = [];
  const seenUrls    = new Set();

  for (const catId of categoryIds) {
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
//  Scrape a single product detail page for Spanish language support + price
// ─────────────────────────────────────────────────────────────────────────────
async function scrapeProductLang(url) {
  try {
    const result = await fetchTurkeyPriceByUrl(url);
    if (result) return { spanishAudio: result.spanishAudio, spanishText: result.spanishText };
    // If price fetch returned null, still try language detection
    const html = await getHtml(url);
    const spanishAudio = /<strong[^>]*>\s*(?:Audio|Voice)[^<]*<\/strong>[^<\n]*Spanish/i.test(html);
    const spanishText  = /<strong[^>]*>\s*(?:Interface|Text|Subtitle)[^<]*<\/strong>[^<\n]*Spanish/i.test(html);
    return { spanishAudio, spanishText };
  } catch (_) {
    return { spanishAudio: false, spanishText: false };
  }
}

module.exports = {
  searchGamesTurkey,
  scrapeAllProducts,
  scrapeProductLang,
  fetchTurkeyPriceByUrl,
  extractProducts,
};
