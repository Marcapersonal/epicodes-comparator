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

function getHeaders() {
  const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  return {
    'User-Agent':      ua,
    'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'es-AR,es;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control':   'no-cache',
    'Referer':         'https://www.google.com/',
  };
}

const PROXY_BASE = 'https://api.allorigins.win/get?url=';

async function getHtml(url) {
  try {
    const { data } = await axios.get(url, { headers: getHeaders(), timeout: 20000 });
    return typeof data === 'string' ? data : '';
  } catch (err) {
    // Only use proxy on network/HTTP errors, not on successful-but-empty responses
    if (!err.response || err.response.status >= 500) {
      try {
        const { data } = await axios.get(
          `${PROXY_BASE}${encodeURIComponent(url)}`,
          { headers: { 'User-Agent': USER_AGENTS[0] }, timeout: 25000 }
        );
        return data?.contents || '';
      } catch (_) {}
    }
    return '';
  }
}

function parseUsd(text) {
  if (!text) return null;
  const m = text.replace(/[^\d.]/g, '').match(/^([\d.]+)/);
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

  // Each top-level product tile has data-qa="search#productTileN" (exactly)
  $('[data-qa^="search#productTile"]').each((_, el) => {
    const qa = $(el).attr('data-qa') || '';
    if (!/^search#productTile\d+$/.test(qa)) return; // skip sub-elements

    const $el = $(el);

    // Name from dedicated element or telemetry meta
    const name = $el.find('[data-qa$="#product-name"]').text().trim();
    if (!name || seen.has(name.toLowerCase())) return;
    seen.add(name.toLowerCase());

    // Current price
    const priceRaw = $el.find('[data-qa$="#price#display-price"]').first().text().trim();

    // Discount badge (e.g. "-40 %")
    const discountRaw = $el.find('[class*="psw-badge"]').first().text().trim();
    const discountPct = discountRaw
      ? parseInt(discountRaw.replace(/[^0-9]/g, ''), 10) || 0
      : 0;

    // Original price appears in a second price span when on sale
    const allPriceEls = $el.find('[data-qa$="#price#display-price"], [data-qa$="#price#original-price"]');
    let originalPriceRaw = null;
    if (allPriceEls.length >= 2) {
      originalPriceRaw = allPriceEls.eq(1).text().trim() || null;
    }

    // Sale-end date — stored in a data-end attribute on countdown timers
    const saleEnd = $el.find('[data-end]').first().attr('data-end') || null;

    // Detail URL
    const href = $el.find('a[href*="/product/"]').first().attr('href')
              || $el.find('a').first().attr('href')
              || '';
    const detailUrl = href.startsWith('http') ? href : `https://store.playstation.com${href}`;

    items.push({
      name,
      priceUsd:         parseUsd(priceRaw),
      priceRaw,
      discountPct,
      originalPriceUsd: parseUsd(originalPriceRaw),
      originalPriceRaw,
      saleEnd,
      detailUrl,
    });
  });

  return items;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Search a single game — returns best fuzzy match + US price
// ─────────────────────────────────────────────────────────────────────────────
async function searchPsStore(query) {
  const encoded = encodeURIComponent(query);

  // Run AR and US searches in parallel (getHtml handles proxy fallback internally)
  const [arHtml, usHtml] = await Promise.all([
    getHtml(`https://store.playstation.com/en-ar/search/${encoded}`).catch(() => null),
    getHtml(`https://store.playstation.com/en-us/search/${encoded}`).catch(() => null),
  ]);

  const arResults = arHtml ? parseSearchResults(arHtml) : [];
  const usResults = usHtml ? parseSearchResults(usHtml) : [];

  // Fuzzy-match against query to find best AR result
  const fuse = new Fuse(arResults, { keys: ['name'], threshold: 0.45 });
  const arHits = fuse.search(query);
  const ar = arHits.length ? arHits[0].item : (arResults[0] || null);

  // Fuzzy-match US results to the same title
  let us = null;
  if (ar && usResults.length) {
    const fuseUs = new Fuse(usResults, { keys: ['name'], threshold: 0.45 });
    const usHits = fuseUs.search(ar.name);
    us = usHits.length ? usHits[0].item : null;
  }

  return { ar, us };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Public: search for a single game (used by search route)
// ─────────────────────────────────────────────────────────────────────────────
async function searchPsStoreAR(query) {
  try {
    const { ar, us } = await searchPsStore(query);
    if (!ar) return { found: false, query };

    if (ar.priceUsd) {
      recordPrice(ar.name, 'psstore-ar', ar.priceUsd, {
        raw: ar.priceRaw, currency: 'USD', discount: ar.discountPct,
      });
    }

    return {
      found:            true,
      title:            ar.name,
      priceUsd:         ar.priceUsd,
      priceRaw:         ar.priceRaw,
      discount:         ar.discountPct,
      originalPriceUsd: ar.originalPriceUsd,
      saleEnd:          ar.saleEnd,
      detailUrl:        ar.detailUrl,
      usPriceUsd:       us?.priceUsd || null,
      history:          [],
      saleDates:        [],
      lowestUsd:        null,
    };
  } catch (err) {
    console.error('PS Store search error:', err.message);
    return { found: false, query, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Public: bulk lookup — given a list of Turkey game titles, find each on
//  PS Store AR + US, with concurrency control (max 6 parallel requests)
// ─────────────────────────────────────────────────────────────────────────────
const delay = (ms) => new Promise(r => setTimeout(r, ms));

async function bulkLookup(titles, onProgress) {
  const CONCURRENCY = 3; // Low concurrency to avoid cloud-IP rate limiting
  const results     = new Array(titles.length).fill(null);
  let   completed   = 0;

  async function worker(idx) {
    const title = titles[idx];
    try {
      const { ar, us } = await searchPsStore(title);
      results[idx] = { title, ar, us };
    } catch (err) {
      results[idx] = { title, ar: null, us: null, error: err.message };
    }
    completed++;
    if (onProgress) onProgress({ completed, total: titles.length, current: title });
    // Small random delay to avoid triggering rate limits on Railway IPs
    await delay(300 + Math.random() * 400);
  }

  const queue = titles.map((_, i) => i);
  let  cursor = 0;

  async function next() {
    if (cursor >= queue.length) return;
    const idx = queue[cursor++];
    await worker(idx);
    await next();
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, titles.length) }, next));
  return results;
}

module.exports = { searchPsStoreAR, bulkLookup };
