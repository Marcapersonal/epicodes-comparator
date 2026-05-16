/**
 * test-psprices.js — Tests all 3 fallback strategies for PS Store AR pricing
 * Run: node test-psprices.js
 */
const axios = require('axios');
const cheerio = require('cheerio');

const TEST_GAMES = ['Spider-Man 2', 'Sekiro', 'Alan Wake 2'];

// ─── OPTION 1: PlayStation Store GraphQL API ───────────────────────────────
async function testGraphQL(gameName) {
  console.log('\n[OPTION 1] PlayStation GraphQL API →', gameName);
  try {
    const body = {
      operationName: 'metGetSearch',
      variables: {
        queryString: gameName,
        pageArgs: { size: 6, offset: 0 },
        filters: [{ name: 'platform', values: ['ps4', 'ps5'] }],
        facets: ['platform'],
        countryCode: 'AR',
        languageCode: 'en',
        pageType: 'getSearchPage',
      },
      query: `query metGetSearch($queryString:String!,$pageArgs:PageArgs,$filters:[FilterEntry],$facets:[String],$countryCode:String!,$languageCode:String!) {
        metGetSearch(queryString:$queryString,pageArgs:$pageArgs,filters:$filters,facets:$facets,countryCode:$countryCode,languageCode:$languageCode,pageType:getSearchPage) {
          products { id name price { basePrice discountedPrice discountText saleEndDate } }
        }
      }`,
    };

    const { data } = await axios.post(
      'https://web.np.playstation.com/api/graphql/v1/op',
      body,
      {
        headers: {
          'Content-Type': 'application/json',
          'apollographql-client-name': 'PlayStationApp-Android',
          'apollographql-client-version': '24.5.0',
          'x-psn-store-locale-override': 'en/AR',
        },
        timeout: 10000,
      }
    );
    const products = data?.data?.metGetSearch?.products || [];
    console.log('  ✅ GraphQL returned', products.length, 'results');
    if (products.length) console.log('  First result:', JSON.stringify(products[0], null, 2));
    return products.length > 0;
  } catch (err) {
    console.log('  ❌ GraphQL failed:', err.response?.status, err.message);
    return false;
  }
}

// ─── OPTION 2: PSPrices.com scraping ──────────────────────────────────────
async function testPSPrices(gameName) {
  console.log('\n[OPTION 2] PSPrices.com →', gameName);
  const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'es-AR,es;q=0.9,en;q=0.8',
  };

  try {
    // AR search
    const arUrl = `https://psprices.com/region-ar/search/?q=${encodeURIComponent(gameName)}&platform=PS4`;
    const { data: arHtml } = await axios.get(arUrl, { headers: HEADERS, timeout: 15000 });
    const $ar = cheerio.load(arHtml);

    const arResults = [];
    // PSPrices uses .game-collection-item or similar
    $ar('.game-collection-item, [class*="game-item"], [class*="search-result"]').each((_, el) => {
      const $el = $ar(el);
      const title = $el.find('[class*="title"], h3, h2').first().text().trim();
      const price = $el.find('[class*="price"]').first().text().trim();
      const href  = $el.find('a').first().attr('href') || '';
      if (title) arResults.push({ title, price, href });
    });

    // Also try generic approach — find all links with /game/ in href
    if (!arResults.length) {
      $ar('a[href*="/game/"]').each((_, el) => {
        const $el = $ar(el);
        const title = $el.find('h3, h2, [class*="title"]').first().text().trim()
                   || $el.text().trim().split('\n')[0].trim();
        const price = $el.find('[class*="price"]').first().text().trim();
        const href  = $el.attr('href') || '';
        if (title && href.includes('/game/')) arResults.push({ title, price, href: `https://psprices.com${href}` });
      });
    }

    console.log('  AR search returned', arResults.length, 'results');
    if (arResults.length) {
      console.log('  First AR result:', arResults[0]);
      return true;
    } else {
      // Dump a snippet of the HTML to understand structure
      const snippet = arHtml.substring(0, 2000);
      console.log('  HTML snippet (first 2000 chars):\n', snippet);
      return false;
    }
  } catch (err) {
    console.log('  ❌ PSPrices failed:', err.response?.status, err.message);
    return false;
  }
}

// ─── OPTION 3: PS Store via proxy ─────────────────────────────────────────
async function testProxy(gameName) {
  console.log('\n[OPTION 3] PS Store via allorigins.win proxy →', gameName);
  try {
    const psUrl    = `https://store.playstation.com/en-ar/search/${encodeURIComponent(gameName)}`;
    const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(psUrl)}`;

    const { data } = await axios.get(proxyUrl, { timeout: 15000 });
    const html = data?.contents || '';

    const $ = cheerio.load(html);
    const tiles = $('[data-qa^="search#productTile"]').length;
    console.log('  Proxy returned HTML length:', html.length, '| productTile count:', tiles);

    if (tiles > 0) {
      const first = $('[data-qa="search#productTile0"]');
      const name  = first.find('[data-qa$="#product-name"]').text().trim();
      const price = first.find('[data-qa$="#price#display-price"]').first().text().trim();
      console.log('  First result:', { name, price });
      return true;
    }
    return false;
  } catch (err) {
    console.log('  ❌ Proxy failed:', err.response?.status, err.message);
    return false;
  }
}

// ─── OPTION 3b: PS Store direct with rotated User-Agents ──────────────────
async function testDirectRotated(gameName) {
  console.log('\n[OPTION 3b] PS Store direct (rotated UA) →', gameName);
  const UAS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  ];
  const ua = UAS[Math.floor(Math.random() * UAS.length)];

  try {
    const url = `https://store.playstation.com/en-ar/search/${encodeURIComponent(gameName)}`;
    const { data: html, status } = await axios.get(url, {
      headers: {
        'User-Agent': ua,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-AR,es;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Referer': 'https://www.google.com/',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'cross-site',
      },
      timeout: 20000,
    });

    const $ = cheerio.load(html);
    const tiles = $('[data-qa^="search#productTile"]').length;
    console.log(`  HTTP ${status} | HTML length: ${html.length} | tiles: ${tiles}`);

    if (tiles > 0) {
      const first = $('[data-qa^="search#productTile"]').first();
      const name  = first.find('[data-qa$="#product-name"]').text().trim();
      const price = first.find('[data-qa$="#price#display-price"]').first().text().trim();
      console.log('  First result:', { name, price });
      return true;
    }
    // Check if we got a challenge page
    if (html.includes('challenge') || html.includes('cf-browser-verification')) {
      console.log('  ⚠️  Cloudflare challenge detected');
    } else if (html.length < 5000) {
      console.log('  ⚠️  Suspiciously short response — may be blocked');
      console.log('  HTML snippet:', html.substring(0, 500));
    }
    return false;
  } catch (err) {
    console.log('  ❌ Direct failed:', err.response?.status, err.message);
    return false;
  }
}

// ─── MAIN ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== PS Store AR Fallback Strategy Test ===\n');
  const game = TEST_GAMES[0];

  const r1 = await testGraphQL(game);
  const r2 = await testPSPrices(game);
  const r3 = await testProxy(game);
  const r4 = await testDirectRotated(game);

  console.log('\n=== RESULTS ===');
  console.log('GraphQL API:    ', r1 ? '✅ WORKS' : '❌ FAILED');
  console.log('PSPrices.com:   ', r2 ? '✅ WORKS' : '❌ FAILED');
  console.log('Proxy:          ', r3 ? '✅ WORKS' : '❌ FAILED');
  console.log('Direct rotated: ', r4 ? '✅ WORKS' : '❌ FAILED');
}

main().catch(console.error);
