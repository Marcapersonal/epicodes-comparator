const axios   = require('axios');
const cheerio = require('cheerio');
const Fuse    = require('fuse.js');
const { recordPrice } = require('../db/database');

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];

function getHeaders(lang = 'en-US,en;q=0.9') {
  const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  return {
    'User-Agent':      ua,
    'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': lang,
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control':   'no-cache',
    'Referer':         'https://www.google.com/',
  };
}

const PROXY_BASE = 'https://api.allorigins.win/get?url=';

async function getHtml(url) {
  let directHtml = '';
  try {
    const { data } = await axios.get(url, { headers: getHeaders(), timeout: 20000 });
    directHtml = typeof data === 'string' ? data : '';
  } catch (_) {}

  // PS Store pages are 100KB+; anything smaller is bot-detection/CAPTCHA.
  if (directHtml.length >= 20000) return directHtml;

  try {
    const { data } = await axios.get(
      `${PROXY_BASE}${encodeURIComponent(url)}`,
      { headers: { 'User-Agent': USER_AGENTS[0] }, timeout: 25000 }
    );
    const proxyHtml = data?.contents || '';
    return proxyHtml.length > directHtml.length ? proxyHtml : directHtml;
  } catch (_) {}

  return directHtml;
}

function parseUsd(text) {
  if (!text) return null;
  const m = String(text).replace(/[^\d.]/g, '').match(/^([\d.]+)/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return isNaN(n) || n === 0 ? null : n;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Parse search results from a PS Store search-results page
// ─────────────────────────────────────────────────────────────────────────────
function parseSearchResults(html) {
  const $ = cheerio.load(html);
  const seen  = new Set();
  const items = [];

  $('[data-qa^="search#productTile"]').each((_, el) => {
    const qa = $(el).attr('data-qa') || '';
    if (!/^search#productTile\d+$/.test(qa)) return;

    const $el  = $(el);
    const name = $el.find('[data-qa$="#product-name"]').text().trim();
    if (!name || seen.has(name.toLowerCase())) return;
    seen.add(name.toLowerCase());

    const priceRaw     = $el.find('[data-qa$="#price#display-price"]').first().text().trim();
    const discountRaw  = $el.find('[class*="psw-badge"]').first().text().trim();
    const discountPct  = discountRaw ? parseInt(discountRaw.replace(/[^0-9]/g, ''), 10) || 0 : 0;

    const allPriceEls  = $el.find('[data-qa$="#price#display-price"], [data-qa$="#price#original-price"]');
    let originalPriceRaw = null;
    if (allPriceEls.length >= 2) originalPriceRaw = allPriceEls.eq(1).text().trim() || null;

    const saleEnd  = $el.find('[data-end]').first().attr('data-end') || null;
    const href     = $el.find('a[href*="/product/"]').first().attr('href') || $el.find('a').first().attr('href') || '';
    const detailUrl = href.startsWith('http') ? href : `https://store.playstation.com${href}`;

    // Try to get thumbnail
    const thumbnail = $el.find('img[src*="store.playstation.com"]').first().attr('src')
                   || $el.find('img').first().attr('src') || null;

    items.push({
      name, priceUsd: parseUsd(priceRaw), priceRaw, discountPct,
      originalPriceUsd: parseUsd(originalPriceRaw), originalPriceRaw,
      saleEnd, detailUrl, thumbnail,
    });
  });

  return items;
}

// ─────────────────────────────────────────────────────────────────────────────
//  DLC / subscription filter
// ─────────────────────────────────────────────────────────────────────────────
function isGameListing(name) {
  const n = name.trim();
  if (!n) return false;
  if (/-\s*[\d,]+(,\d{3})*\s*(fc|vc|gold|coins?|points?)\b/i.test(n)) return false;
  if (/\b(fc|vc)\s+points?\b/i.test(n)) return false;
  if (/\bpoints?\s+[\d,]+/i.test(n)) return false;
  if (/\b(points?|coins?)\s*$/i.test(n)) return false;
  if (/\b(dlc|season\s+pass|add-?on)\b/i.test(n)) return false;
  if (/^[\w\s]{1,20}\+\s*$/i.test(n) && n.split(/\s+/).length <= 4) return false;
  if (/\b(subscription|membership|monthly|annual)\b/i.test(n)) return false;
  if (/\b(cash\s+card|shark\s+card|currency\s+pack|money\s+pack|starter\s+pack)\b/i.test(n)) return false;
  if (/[\$][\d,]+\s*(gta|shark|card)/i.test(n)) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Strip edition/platform suffixes → base title for grouping
// ─────────────────────────────────────────────────────────────────────────────
function baseTitle(name) {
  return name
    .replace(/\s*[-–]\s*[\d,]+\s*(fc|vc|points?|coins?|gold|credits?).*$/i, '')
    .replace(/\s*(para|for)\s+ps[45]™?\s*(y|and|&)?\s*ps[45].*/i, '')
    .replace(/\s*\(ps[45]™?(\s*(\/|&|,)\s*ps[45]™?|\s+(and|y)\s+ps[45]™?)?\)\s*$/i, '')
    .replace(/\s+ps[45]™?(\s*(\/|&|,)\s*ps[45]™?|\s+(and|y)\s+ps[45]™?)?\s*$/i, '')
    .replace(/\s+(edici[oó]n)\s+\S+.*/i, '')
    .replace(/\s*[-–:]\s*(ultimate|deluxe|digital|standard|champions|gold|complete|legendary|vault|founders?|icons?|enhanced|premium|showcase|cross[- ]gen)\s*(edition|ed\.?)?\s*$/i, '')
    .replace(/\s+(ultimate|deluxe|digital|standard|champions|gold|complete|legendary|vault|founders?|icons?|enhanced|premium|showcase|cross[- ]gen)\s*(edition|ed\.?)?\s*$/i, '')
    .replace(/[™®]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// ─────────────────────────────────────────────────────────────────────────────
//  Detect edition label from a product title
// ─────────────────────────────────────────────────────────────────────────────
function detectEdition(name) {
  const editions = [
    'Ultimate', 'Deluxe', 'Premium', 'Gold', 'Complete', 'Legendary', 'Vault',
    'Founders', 'Digital', 'Standard', 'Champions', 'Icons', 'Enhanced',
    'Showcase', 'Cross-Gen', 'Cross Gen', 'Game of the Year', 'GOTY',
    'Director\'s Cut', 'Remastered',
  ];
  for (const ed of editions) {
    if (new RegExp(`\\b${ed}\\b`, 'i').test(name)) return ed;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Search a single game — returns best fuzzy match + all variants
// ─────────────────────────────────────────────────────────────────────────────
async function searchPsStore(query) {
  const encoded   = encodeURIComponent(query);
  const usHtml    = await getHtml(`https://store.playstation.com/en-us/search/${encoded}`).catch(() => null);
  const usResults = usHtml ? parseSearchResults(usHtml) : [];

  const gameResults = usResults.filter(r => isGameListing(r.name) && r.priceUsd != null);
  const searchPool  = gameResults.length ? gameResults : usResults.filter(r => isGameListing(r.name));
  const fuse        = new Fuse(searchPool, { keys: ['name'], threshold: 0.45, includeScore: true });
  const usHits      = fuse.search(query);
  const best        = usHits.length ? usHits[0].item : (searchPool[0] || null);

  let variants = [];
  if (best) {
    const base = baseTitle(best.name);
    const allGameListings = usResults.filter(r => isGameListing(r.name));
    variants = allGameListings.filter(r => baseTitle(r.name) === base);
    if (variants.length <= 1) {
      const extras = usHits
        .filter(h => h.score != null && h.score < 0.4 && h.item.priceUsd != null && baseTitle(h.item.name) === base)
        .map(h => h.item);
      variants = extras.length > 1 ? extras : variants;
      if (!variants.find(v => v.name === best.name)) variants.unshift(best);
    }
    variants.sort((a, b) => (a.priceUsd ?? Infinity) - (b.priceUsd ?? Infinity));
  }

  return { best, variants };
}

// ─────────────────────────────────────────────────────────────────────────────
//  NEW: searchSonyForEditions — search and return all editions with confidence
//  Used by POST /api/catalog/preview to show edition checkboxes
// ─────────────────────────────────────────────────────────────────────────────
async function searchSonyForEditions(query) {
  const encoded   = encodeURIComponent(query);
  const usHtml    = await getHtml(`https://store.playstation.com/en-us/search/${encoded}`).catch(() => null);
  const usResults = usHtml ? parseSearchResults(usHtml) : [];

  // Filter: game listings only, with a price
  const gameResults = usResults.filter(r => isGameListing(r.name) && r.priceUsd != null);
  if (!gameResults.length) return [];

  // Fuse search to rank by relevance
  const fuse = new Fuse(gameResults, { keys: ['name'], threshold: 0.5, includeScore: true });
  const hits  = fuse.search(query);
  if (!hits.length) return [];

  const bestBase = baseTitle(hits[0].item.name);

  // Collect all editions that share the best base title
  const editionHits = hits.filter(h => baseTitle(h.item.name) === bestBase);

  // If only 1 hit on the best base, also include close hits with different editions
  // (handles games where editions appear in a different order in search results)
  const allEditions = editionHits.length >= 1 ? editionHits : hits.slice(0, 6);

  // Build edition list
  const editions = allEditions.map(h => {
    const raw        = h.item;
    const score      = h.score ?? 0;           // 0 = perfect match, 1 = worst
    const confidence = Math.round((1 - score) * 100);
    const edition    = detectEdition(raw.name);

    return {
      display_name:       raw.name,
      edition:            edition,
      base_title:         baseTitle(raw.name),
      sony_us_url:        raw.detailUrl,
      sony_us_price:      raw.priceUsd,
      sony_us_price_raw:  raw.priceRaw,
      sony_us_discount:   raw.discountPct,
      sony_us_confidence: Math.min(100, Math.max(0, confidence)),
      thumbnail:          raw.thumbnail || null,
    };
  });

  // Deduplicate by sony_us_url
  const seen = new Set();
  return editions.filter(e => {
    if (seen.has(e.sony_us_url)) return false;
    seen.add(e.sony_us_url);
    return true;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  NEW: fetchSonyPriceByUrl — fetch live price from a stored product detail URL
//  Returns: { priceUsd, priceRaw, discountPct, saleEnd, name } or null
// ─────────────────────────────────────────────────────────────────────────────
async function fetchSonyPriceByUrl(productUrl) {
  if (!productUrl) return null;

  let html;
  try {
    html = await getHtml(productUrl);
  } catch (err) {
    console.warn(`[psstore] fetchSonyPriceByUrl fetch failed for ${productUrl}:`, err.message);
    return null;
  }

  if (!html || html.length < 5000) {
    console.warn(`[psstore] fetchSonyPriceByUrl: HTML too short (${html?.length}) for ${productUrl}`);
    return null;
  }

  // ── Method 1: __NEXT_DATA__ (Next.js SSR initial state) ───────────────────
  const nextMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (nextMatch) {
    try {
      const nextData = JSON.parse(nextMatch[1]);
      const result   = _extractFromNextData(nextData, productUrl);
      if (result) return result;
    } catch (_) {}
  }

  // ── Method 2: application/ld+json ─────────────────────────────────────────
  const ldMatches = [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)];
  for (const m of ldMatches) {
    try {
      const ld = JSON.parse(m[1]);
      if (ld['@type'] === 'Product' && ld.offers) {
        const offers  = Array.isArray(ld.offers) ? ld.offers[0] : ld.offers;
        const priceUsd = parseUsd(offers?.price || offers?.price);
        if (priceUsd) {
          return { priceUsd, priceRaw: `$${priceUsd}`, discountPct: 0, saleEnd: null, name: ld.name || null };
        }
      }
    } catch (_) {}
  }

  // ── Method 3: data-qa selectors (same as search results) ──────────────────
  const $ = cheerio.load(html);
  const priceEl = $('[data-qa*="price#display-price"]').first();
  if (priceEl.length) {
    const priceRaw = priceEl.text().trim();
    const priceUsd = parseUsd(priceRaw);
    if (priceUsd) {
      const discountRaw = $('[class*="psw-badge"]').first().text().trim();
      const discountPct = discountRaw ? parseInt(discountRaw.replace(/[^0-9]/g, ''), 10) || 0 : 0;
      const saleEnd     = $('[data-end]').first().attr('data-end') || null;
      return { priceUsd, priceRaw, discountPct, saleEnd, name: null };
    }
  }

  console.warn(`[psstore] fetchSonyPriceByUrl: no price found for ${productUrl}`);
  return null;
}

/** Try multiple paths within __NEXT_DATA__ to extract price */
function _extractFromNextData(data, url) {
  // Possible locations of product data in Next.js page props
  const candidates = [
    data?.props?.pageProps?.data?.product,
    data?.props?.pageProps?.pdp,
    data?.props?.pageProps?.product,
    data?.props?.pageProps?.initialData?.product,
    data?.props?.pageProps?.productConcept,
    data?.props?.pageProps?.data,
  ];

  for (const product of candidates.filter(Boolean)) {
    if (!product || typeof product !== 'object') continue;

    const name = product.name || product.localizedName || product.title || null;

    // prices array
    if (Array.isArray(product.prices) && product.prices.length > 0) {
      const p = product.prices[0];
      const basePrice       = parseUsd(p.basePrice || p.discountedPrice);
      const discountedPrice = parseUsd(p.discountedPrice);
      const priceUsd = discountedPrice || basePrice;
      if (priceUsd) {
        const discountPct = (discountedPrice && basePrice && discountedPrice < basePrice)
          ? Math.round((1 - discountedPrice / basePrice) * 100) : 0;
        return { priceUsd, priceRaw: `$${priceUsd}`, discountPct, saleEnd: p.campaignEndDate || null, name };
      }
    }

    // price object
    if (product.price && typeof product.price === 'object') {
      const p = product.price;
      const basePrice = parseUsd(p.basePrice || p.price);
      const discountedPrice = parseUsd(p.discountedPrice);
      const priceUsd = discountedPrice || basePrice;
      if (priceUsd) {
        const discountPct = (discountedPrice && basePrice && discountedPrice < basePrice)
          ? Math.round((1 - discountedPrice / basePrice) * 100) : 0;
        return { priceUsd, priceRaw: `$${priceUsd}`, discountPct, saleEnd: p.campaignEndDate || p.endTime || null, name };
      }
    }

    // skus array
    if (Array.isArray(product.skus) && product.skus.length > 0) {
      const sku = product.skus[0];
      if (sku?.price) {
        const basePrice = parseUsd(sku.price.basePrice);
        const discountedPrice = parseUsd(sku.price.discountedPrice);
        const priceUsd = discountedPrice || basePrice;
        if (priceUsd) {
          const discountPct = (discountedPrice && basePrice && discountedPrice < basePrice)
            ? Math.round((1 - discountedPrice / basePrice) * 100) : 0;
          return { priceUsd, priceRaw: `$${priceUsd}`, discountPct, saleEnd: sku.price.campaignEndDate || null, name };
        }
      }
    }
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Public: search for a single game (used by search route)
// ─────────────────────────────────────────────────────────────────────────────
async function searchPsStoreUS(query) {
  try {
    const { best, variants } = await searchPsStore(query);
    if (!best) return { found: false, query };

    const cheapest = variants.length ? variants[0] : best;

    if (cheapest.priceUsd) {
      recordPrice(cheapest.name, 'psstore-us', cheapest.priceUsd, {
        raw: cheapest.priceRaw, currency: 'USD', discount: cheapest.discountPct,
      });
    }

    return {
      found:            true,
      title:            cheapest.name,
      priceUsd:         cheapest.priceUsd,
      priceRaw:         cheapest.priceRaw,
      discount:         cheapest.discountPct,
      originalPriceUsd: cheapest.originalPriceUsd,
      saleEnd:          cheapest.saleEnd,
      detailUrl:        cheapest.detailUrl,
      usPriceUsd:       cheapest.priceUsd || null,
      history:          [],
      saleDates:        [],
      lowestUsd:        null,
      variants:         variants.map(v => ({
        title:            v.name,
        priceUsd:         v.priceUsd,
        priceRaw:         v.priceRaw,
        discount:         v.discountPct,
        originalPriceUsd: v.originalPriceUsd,
        saleEnd:          v.saleEnd,
        detailUrl:        v.detailUrl,
      })),
    };
  } catch (err) {
    console.error('PS Store search error:', err.message);
    return { found: false, query, error: err.message };
  }
}

const searchPsStoreAR = searchPsStoreUS;

// ─────────────────────────────────────────────────────────────────────────────
//  Public: bulk lookup — given a list of titles, search PS Store US
//  (legacy path, used as fallback when game_catalog entries have no stored URL)
// ─────────────────────────────────────────────────────────────────────────────
const delay = (ms) => new Promise(r => setTimeout(r, ms));

async function bulkLookup(titles, onProgress) {
  const CONCURRENCY = 3;
  const results     = new Array(titles.length).fill(null);
  let   completed   = 0;

  async function worker(idx) {
    const title = titles[idx];
    try {
      const { best, variants } = await searchPsStore(title);
      results[idx] = { title, best, variants };
    } catch (err) {
      results[idx] = { title, best: null, variants: [], error: err.message };
    }
    completed++;
    if (onProgress) onProgress({ completed, total: titles.length, current: title });
    await delay(300 + Math.random() * 400);
  }

  const queue  = titles.map((_, i) => i);
  let   cursor = 0;

  async function next() {
    if (cursor >= queue.length) return;
    const idx = queue[cursor++];
    await worker(idx);
    await next();
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, titles.length) }, next));
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Build Sony URL for a given region
// ─────────────────────────────────────────────────────────────────────────────
function sonyRegionCode(region) {
  // region is like "AR", "BR", "IN", "MX", "TR"
  const map = { AR: 'es-ar', BR: 'pt-br', IN: 'en-in', MX: 'es-mx', TR: 'en-tr', US: 'en-us' };
  return map[region?.toUpperCase()] || 'en-ar';
}

async function searchSonyAltRegion(query, region) {
  const locale  = sonyRegionCode(region);
  const encoded = encodeURIComponent(query);
  const url     = `https://store.playstation.com/${locale}/search/${encoded}`;

  try {
    const html     = await getHtml(url);
    const results  = parseSearchResults(html);
    const filtered = results.filter(r => isGameListing(r.name));
    if (!filtered.length) return null;

    const fuse = new Fuse(filtered, { keys: ['name'], threshold: 0.45, includeScore: true });
    const hits  = fuse.search(query);
    if (!hits.length) return null;

    const best       = hits[0];
    const confidence = Math.round((1 - (best.score ?? 0)) * 100);
    const item       = best.item;

    return {
      sony_alt_url:        item.detailUrl,
      sony_alt_confidence: Math.min(100, Math.max(0, confidence)),
      sony_alt_price:      item.priceUsd,
      sony_alt_price_raw:  item.priceRaw,
    };
  } catch (err) {
    console.warn(`[psstore] searchSonyAltRegion(${region}) failed:`, err.message);
    return null;
  }
}

module.exports = {
  searchPsStoreUS, searchPsStoreAR,
  bulkLookup,
  fetchSonyPriceByUrl,
  searchSonyForEditions,
  searchSonyAltRegion,
  getHtml,
  parseSearchResults,
  isGameListing,
  baseTitle,
  detectEdition,
};
