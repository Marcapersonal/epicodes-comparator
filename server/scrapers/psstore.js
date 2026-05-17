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
  let directHtml = '';
  try {
    const { data } = await axios.get(url, { headers: getHeaders(), timeout: 20000 });
    directHtml = typeof data === 'string' ? data : '';
  } catch (_) {}

  // PS Store pages are 100KB+; anything smaller is a bot-detection/CAPTCHA page.
  // Fall through to proxy when the direct response is too small to contain real results.
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
//  Search a single game — returns best fuzzy match + all variants + US price
// ─────────────────────────────────────────────────────────────────────────────

// Returns true for actual game listings (not DLC, currency packs, subscriptions)
function isGameListing(name) {
  const n = name.trim();
  if (!n) return false;
  // "- 100 FC Points" / "- 1000 VC" style DLC suffixes
  if (/-\s*[\d,]+(,\d{3})*\s*(fc|vc|gold|coins?|points?)\b/i.test(n)) return false;
  // "FC Points 100", "FC Points 500" — currency in any position
  if (/\b(fc|vc)\s+points?\b/i.test(n)) return false;
  // "Points 100", "Points 1000" — points pack followed by a number
  if (/\bpoints?\s+[\d,]+/i.test(n)) return false;
  // Ends with "Points" or "Coins"
  if (/\b(points?|coins?)\s*$/i.test(n)) return false;
  // Explicit DLC markers
  if (/\b(dlc|season\s+pass|add-?on)\b/i.test(n)) return false;
  // Subscription services: short names ending in "+" like "GTA+", "EA Play Pro+"
  // A word (or 2-3 short words) immediately followed by "+", no other content
  if (/^[\w\s]{1,20}\+\s*$/i.test(n) && n.split(/\s+/).length <= 4) return false;
  // Explicit subscription / membership language
  if (/\b(subscription|membership|monthly|annual)\b/i.test(n)) return false;
  // In-game currency / cash card packs (e.g. "Tiger Shark Cash Card", "Shark Card")
  if (/\b(cash\s+card|shark\s+card|currency\s+pack|money\s+pack|starter\s+pack)\b/i.test(n)) return false;
  // Currency amount + unit combos not already caught ("1 million", "$1,000,000")
  if (/[\$][\d,]+\s*(gta|shark|card)/i.test(n)) return false;
  return true;
}

// Strip edition/platform suffixes to get a base title for grouping variants
function baseTitle(name) {
  return name
    // Remove "- 100 FC Points" style DLC suffixes
    .replace(/\s*[-–]\s*[\d,]+\s*(fc|vc|points?|coins?|gold|credits?).*$/i, '')
    // Remove platform suffix: "para PS4 y PS5" / "for PS4 & PS5"
    .replace(/\s*(para|for)\s+ps[45]\s*(y|and|&)?\s*ps[45].*/i, '')
    // Remove trailing "PS4" / "PS5" / "PS4™" / "PS4/PS5"
    .replace(/\s+ps[45](™|\s*\/\s*ps[45])?(\s*™)?\s*$/i, '')
    // Remove Spanish edition: "Edición Estándar / Ultimate / Deluxe..."
    .replace(/\s+(edici[oó]n)\s+\S+.*/i, '')
    // Remove English edition suffixes with optional dash/colon prefix
    .replace(/\s*[-–:]\s*(ultimate|deluxe|digital|standard|champions|gold|complete|legendary|vault|founders?)\s*(edition|ed\.?)?\s*$/i, '')
    .replace(/\s+(ultimate|deluxe|digital|standard|champions|gold|complete|legendary|vault|founders?)\s*(edition|ed\.?)?\s*$/i, '')
    // Remove ™ / ® symbols and clean up
    .replace(/[™®]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

async function searchPsStore(query) {
  const encoded = encodeURIComponent(query);

  // Fetch only US store
  const usHtml = await getHtml(`https://store.playstation.com/en-us/search/${encoded}`).catch(() => null);
  const usResults = usHtml ? parseSearchResults(usHtml) : [];

  // Fuzzy-match — only consider actual game listings that have a price
  const gameResults = usResults.filter(r => isGameListing(r.name) && r.priceUsd != null);
  const searchPool  = gameResults.length ? gameResults : usResults.filter(r => r.priceUsd != null);
  const fuse = new Fuse(searchPool, { keys: ['name'], threshold: 0.45, includeScore: true });
  const usHits = fuse.search(query);
  const best = usHits.length ? usHits[0].item : (searchPool[0] || null);

  // Collect all variants: any game listing whose base title matches the best hit
  let variants = [];
  if (best) {
    const base = baseTitle(best.name);
    const allGameListings = usResults.filter(r => isGameListing(r.name));
    variants = allGameListings.filter(r => baseTitle(r.name) === base);
    // Fallback: include close fuse hits if base-title grouping found nothing extra.
    // CRITICAL: only include hits whose baseTitle EXACTLY matches `base` —
    // otherwise "God of War" would pull in "God of War Ragnarök" etc.
    if (variants.length <= 1) {
      const extras = usHits
        .filter(h => h.score != null && h.score < 0.4 && h.item.priceUsd != null && baseTitle(h.item.name) === base)
        .map(h => h.item);
      variants = extras.length > 1 ? extras : variants;
      if (!variants.find(v => v.name === best.name)) variants.unshift(best);
    }
    // Sort cheapest first
    variants.sort((a, b) => (a.priceUsd ?? Infinity) - (b.priceUsd ?? Infinity));
  }

  return { best, variants };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Public: search for a single game (used by search route)
// ─────────────────────────────────────────────────────────────────────────────
async function searchPsStoreUS(query) {
  try {
    const { best, variants } = await searchPsStore(query);
    if (!best) return { found: false, query };

    // The "best" result to show as the primary is the cheapest variant
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

// Backward-compat alias for cronService
const searchPsStoreAR = searchPsStoreUS;

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
      const { best, variants } = await searchPsStore(title);
      results[idx] = { title, best, variants };
    } catch (err) {
      results[idx] = { title, best: null, variants: [], error: err.message };
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

module.exports = { searchPsStoreUS, searchPsStoreAR, bulkLookup, getHtml };
