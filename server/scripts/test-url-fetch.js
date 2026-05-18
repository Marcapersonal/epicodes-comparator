/**
 * Diagnostic script — run with: node server/scripts/test-url-fetch.js
 *
 * Tests that we can fetch a price by direct URL for:
 *   1. Sony PS Store US product detail page
 *   2. GamesturkeyACC product detail page
 *
 * Finds a real URL first by running a search, then re-fetches it by URL.
 * If either test fails we know what to fix before refactoring bulk.js.
 */

require('dotenv').config();
const axios   = require('axios');
const cheerio = require('cheerio');

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
];

function getHeaders() {
  return {
    'User-Agent':      USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
    'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control':   'no-cache',
    'Referer':         'https://www.google.com/',
  };
}

function parseUsd(text) {
  if (!text) return null;
  const m = String(text).replace(/[^\d.]/g, '').match(/^([\d.]+)/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return isNaN(n) || n === 0 ? null : n;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Sony PS Store URL price extraction
// ─────────────────────────────────────────────────────────────────────────────

function extractSonyPriceFromNextData(html) {
  // Try __NEXT_DATA__ (Next.js SSR initial props)
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) return { found: false, reason: 'No __NEXT_DATA__ found' };

  let data;
  try { data = JSON.parse(match[1]); } catch (e) { return { found: false, reason: `JSON parse error: ${e.message}` }; }

  // Log structure keys to understand the shape
  const keys = Object.keys(data?.props?.pageProps || {});
  console.log('  __NEXT_DATA__ pageProps keys:', keys);

  // Try various paths where price might live
  const candidates = [
    data?.props?.pageProps?.data?.product,
    data?.props?.pageProps?.pdp,
    data?.props?.pageProps?.product,
    data?.props?.pageProps?.initialData?.product,
    data?.props?.pageProps?.productConcept,
  ];

  for (const product of candidates.filter(Boolean)) {
    const name = product?.name || product?.localizedName;
    console.log('  Found product node, name:', name, '— keys:', Object.keys(product).slice(0, 8));

    // prices array
    if (Array.isArray(product?.prices) && product.prices.length > 0) {
      const p = product.prices[0];
      return { found: true, source: 'prices[]', name, price: p };
    }
    // price object
    if (product?.price) {
      return { found: true, source: 'price{}', name, price: product.price };
    }
    // skus array
    if (Array.isArray(product?.skus) && product.skus.length > 0) {
      const sku = product.skus[0];
      if (sku?.price) return { found: true, source: 'skus[0].price', name, price: sku.price };
    }
  }

  return { found: false, reason: 'Price path not found in __NEXT_DATA__' };
}

function extractSonyPriceFromLdJson(html) {
  const matches = [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)];
  for (const m of matches) {
    try {
      const ld = JSON.parse(m[1]);
      if (ld['@type'] === 'Product' && ld.offers) {
        const offers = Array.isArray(ld.offers) ? ld.offers[0] : ld.offers;
        if (offers?.price) {
          return { found: true, source: 'ld+json', priceUsd: parseFloat(offers.price), priceCurrency: offers.priceCurrency };
        }
      }
    } catch (_) {}
  }
  return { found: false };
}

function extractSonyPriceFromDataQa(html) {
  const $ = cheerio.load(html);
  const el = $('[data-qa*="price#display-price"]').first();
  if (el.length) {
    const text = el.text().trim();
    return { found: true, source: 'data-qa', priceRaw: text, priceUsd: parseUsd(text) };
  }
  return { found: false };
}

async function testSonyUrl(productUrl) {
  console.log('\n═══ SONY PS STORE TEST ═══');
  console.log('URL:', productUrl);

  let html;
  try {
    const { data, status } = await axios.get(productUrl, { headers: getHeaders(), timeout: 20000 });
    html = typeof data === 'string' ? data : '';
    console.log(`  HTTP ${status}, HTML length: ${html.length} chars`);
  } catch (err) {
    console.error('  ❌ Fetch failed:', err.message);
    return;
  }

  if (html.length < 5000) {
    console.warn('  ⚠️  HTML too short — likely blocked or redirect. First 300 chars:');
    console.warn('  ', html.substring(0, 300));
    return;
  }

  // Method 1: __NEXT_DATA__
  const nextResult = extractSonyPriceFromNextData(html);
  console.log('  __NEXT_DATA__ result:', JSON.stringify(nextResult, null, 2).slice(0, 500));

  // Method 2: ld+json
  const ldResult = extractSonyPriceFromLdJson(html);
  console.log('  ld+json result:', JSON.stringify(ldResult));

  // Method 3: data-qa selectors
  const qaResult = extractSonyPriceFromDataQa(html);
  console.log('  data-qa result:', JSON.stringify(qaResult));

  if (!nextResult.found && !ldResult.found && !qaResult.found) {
    console.error('  ❌ COULD NOT EXTRACT PRICE — need to inspect page structure');
    // Save a snippet for inspection
    const snippet = html.substring(0, 2000);
    console.log('  HTML snippet:', snippet);
  } else {
    console.log('  ✅ At least one method found a price');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Turkey GamesturkeyACC URL price extraction
// ─────────────────────────────────────────────────────────────────────────────

async function testTurkeyUrl(productUrl) {
  console.log('\n═══ GAMESTURKEYACC TEST ═══');
  console.log('URL:', productUrl);

  let html;
  try {
    const { data, status } = await axios.get(productUrl, {
      headers: {
        'User-Agent': USER_AGENTS[0],
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      timeout: 20000,
    });
    html = typeof data === 'string' ? data : '';
    console.log(`  HTTP ${status}, HTML length: ${html.length} chars`);
  } catch (err) {
    console.error('  ❌ Fetch failed:', err.message);
    return;
  }

  if (html.length < 1000) {
    console.warn('  ⚠️  HTML too short. First 300 chars:', html.substring(0, 300));
    return;
  }

  const $ = cheerio.load(html);

  // Try multiple selectors for price
  const selectors = [
    '.text-primary.font-bold',
    'span.text-primary',
    '[class*="price"]',
    'h3 + p',
  ];

  let found = false;
  for (const sel of selectors) {
    const els = $(sel).filter((_, el) => /\$\s*[\d]/.test($(el).text()));
    if (els.length) {
      const text = els.first().text().trim();
      console.log(`  ✅ Selector "${sel}": "${text}" → $${parseUsd(text)}`);
      found = true;
      break;
    }
  }

  if (!found) {
    // Regex fallback
    const m = html.match(/\$\s*([\d]+\.?[\d]{0,2})/);
    if (m) {
      console.log(`  ✅ Regex fallback: $${m[1]}`);
      found = true;
    }
  }

  if (!found) {
    console.error('  ❌ COULD NOT EXTRACT PRICE');
    // Show all spans with $ for debugging
    $('span, p, div').filter((_, el) => /\$/.test($(el).text())).slice(0, 5).each((_, el) => {
      console.log('    Dollar span:', $(el).text().trim().substring(0, 60));
    });
  }

  // Also test Spanish language detection
  const spanishAudio = /<strong[^>]*>\s*(?:Audio|Voice)[^<]*<\/strong>[^<\n]*Spanish/i.test(html);
  const spanishText  = /<strong[^>]*>\s*(?:Interface|Text|Subtitle)[^<]*<\/strong>[^<\n]*Spanish/i.test(html);
  console.log(`  Language: audio=${spanishAudio}, text=${spanishText}`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Find URLs via search, then test by URL
// ─────────────────────────────────────────────────────────────────────────────

async function findSonyProductUrl(query) {
  console.log(`\nSearching Sony US for "${query}"...`);
  const searchUrl = `https://store.playstation.com/en-us/search/${encodeURIComponent(query)}`;
  try {
    const { data } = await axios.get(searchUrl, { headers: getHeaders(), timeout: 20000 });
    const $ = cheerio.load(data);
    const href = $('[data-qa^="search#productTile"]').first().find('a[href*="/product/"]').first().attr('href');
    if (!href) { console.log('  No product tile found in search results'); return null; }
    return href.startsWith('http') ? href : `https://store.playstation.com${href}`;
  } catch (err) {
    console.error('  Search failed:', err.message);
    return null;
  }
}

async function findTurkeyProductUrl(query) {
  console.log(`\nSearching GamesturkeyACC for "${query}"...`);
  const searchUrl = `https://gamesturkeyacc.com/product_search.php?query=${encodeURIComponent(query)}`;
  try {
    const { data } = await axios.get(searchUrl, {
      headers: { 'User-Agent': USER_AGENTS[0], 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      timeout: 20000,
    });
    const $ = cheerio.load(data);
    const href = $('a[href*="product_details"]').first().attr('href');
    if (!href) { console.log('  No product link found'); return null; }
    return href.startsWith('http') ? href : `https://gamesturkeyacc.com/${href.replace(/^\//, '')}`;
  } catch (err) {
    console.error('  Search failed:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Main
// ─────────────────────────────────────────────────────────────────────────────

const TEST_GAME = process.argv[2] || 'Hogwarts Legacy';

(async () => {
  console.log(`🔬 Testing URL-based price fetching for: "${TEST_GAME}"`);
  console.log('='.repeat(60));

  // Find Sony product URL via search, then test it
  const sonyUrl = await findSonyProductUrl(TEST_GAME);
  if (sonyUrl) {
    console.log(`  Found Sony URL: ${sonyUrl}`);
    await testSonyUrl(sonyUrl);
  }

  // Find Turkey product URL via search, then test it
  const turkeyUrl = await findTurkeyProductUrl(TEST_GAME);
  if (turkeyUrl) {
    console.log(`  Found Turkey URL: ${turkeyUrl}`);
    await testTurkeyUrl(turkeyUrl);
  }

  console.log('\n' + '='.repeat(60));
  console.log('✅ Diagnostic complete. Review the output above.');
  console.log('   If any method returned a price → that method works for bulk.js.');
  console.log('   If everything failed → inspect the HTML snippet and fix the parser.');
})();
