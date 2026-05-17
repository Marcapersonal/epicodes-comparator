const express = require('express');
const router  = express.Router();
const { searchPsStoreUS }   = require('../scrapers/psstore');
const { searchGamesTurkey } = require('../scrapers/gamesturkey');
const { getVerdict, predictNextSale } = require('../services/comparison');
const { getGiftCardRate, getMinHistoricalPrice, getPriceDetailHistory, detectSaleDates } = require('../db/database');
const { fetchPlatPrices }   = require('../services/platprices');
const { analyzeSaleCycle }  = require('../engine/predictor');

router.get('/', async (req, res) => {
  const query = (req.query.q || '').trim();
  if (!query) return res.status(400).json({ error: 'query requerida' });

  try {
    // Run PS Store, Turkey, and PlatPrices in parallel.
    // PlatPrices has a 5-second timeout so it never blocks the response
    // when the cache is cold; subsequent calls are instant (cached 7 days).
    const ppWithTimeout = Promise.race([
      fetchPlatPrices(query),
      new Promise(resolve => setTimeout(() => resolve(null), 5000)),
    ]);

    const [psResult, turkeyResult, ppResult] = await Promise.allSettled([
      searchPsStoreUS(query),
      searchGamesTurkey(query),
      ppWithTimeout,
    ]);

    const ps     = psResult.status     === 'fulfilled' ? psResult.value     : { found: false, error: psResult.reason?.message };
    const turkey = turkeyResult.status === 'fulfilled' ? turkeyResult.value : { found: false, error: turkeyResult.reason?.message };
    // pp may be null (key not set, timeout, no result)

    const giftCardRate = getGiftCardRate();
    const realCostUsd  = ps.priceUsd != null ? Math.round(ps.priceUsd * giftCardRate * 100) / 100 : null;

    // Historical data — use canonical title if found, else raw query
    const gameName    = ps.title || query;
    const minHist     = getMinHistoricalPrice(gameName);
    const saleDatesDb = detectSaleDates(gameName);
    const allSaleDates = [...(ps.saleDates || []), ...saleDatesDb.map(d => d.date)];
    const nextSalePrediction = predictNextSale(allSaleDates);

    const verdict = getVerdict(realCostUsd, turkey.priceUsd || null, {
      minHistoricalUsd: minHist || ps.lowestUsd,
      giftCardRate,
      nextSalePrediction,
    });

    // Rich sale-cycle analysis (combines PlatPrices cache + our own history)
    const saleAnalysis = analyzeSaleCycle(gameName);

    // Price history for chart
    const priceHistory = ps.history?.length
      ? ps.history
      : getPriceDetailHistory(gameName);

    res.json({
      query,
      giftCardRate,
      psStore: {
        found:            ps.found,
        title:            ps.title,
        priceUsd:         ps.priceUsd,
        priceRaw:         ps.priceRaw,
        discount:         ps.discount,
        originalPriceUsd: ps.originalPriceUsd || null,
        saleEnd:          ps.saleEnd,
        detailUrl:        ps.detailUrl,
        usPriceUsd:       ps.usPriceUsd || null,
        variants:         ps.variants || [],
        error:            ps.error,
      },
      turkey: {
        found:    turkey.found,
        title:    turkey.title,
        priceUsd: turkey.priceUsd,
        priceRaw: turkey.priceRaw,
        url:      turkey.url,
        error:    turkey.error,
      },
      comparison: {
        realCostUsd,
        minHistoricalUsd:  minHist || ps.lowestUsd || null,
        minRealCostUsd:    (minHist || ps.lowestUsd)
          ? Math.round((minHist || ps.lowestUsd) * giftCardRate * 100) / 100
          : null,
        lastSaleDate:      allSaleDates[allSaleDates.length - 1] || null,
        nextSalePrediction,
        verdict,
      },
      saleAnalysis,
      priceHistory,
    });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
