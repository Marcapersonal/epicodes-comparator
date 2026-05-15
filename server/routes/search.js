const express = require('express');
const router  = express.Router();
const { searchPsStoreAR }   = require('../scrapers/psstore');
const { searchGamesTurkey } = require('../scrapers/gamesturkey');
const { getVerdict, predictNextSale } = require('../services/comparison');
const { getGiftCardRate, getMinHistoricalPrice, getPriceDetailHistory, detectSaleDates } = require('../db/database');

router.get('/', async (req, res) => {
  const query = (req.query.q || '').trim();
  if (!query) return res.status(400).json({ error: 'query requerida' });

  try {
    // Run both scrapers in parallel
    const [psResult, turkeyResult] = await Promise.allSettled([
      searchPsStoreAR(query),
      searchGamesTurkey(query),
    ]);

    const ps     = psResult.status === 'fulfilled'     ? psResult.value     : { found: false, error: psResult.reason?.message };
    const turkey = turkeyResult.status === 'fulfilled' ? turkeyResult.value : { found: false, error: turkeyResult.reason?.message };

    const giftCardRate = getGiftCardRate();
    const realCostUsd  = ps.priceUsd != null ? Math.round(ps.priceUsd * giftCardRate * 100) / 100 : null;

    // Historical data
    const gameName = ps.title || query;
    const minHist  = getMinHistoricalPrice(gameName);
    const saleDatesDb = detectSaleDates(gameName);
    const allSaleDates = [...(ps.saleDates || []), ...saleDatesDb.map(d => d.date)];
    const nextSalePrediction = predictNextSale(allSaleDates);

    const verdict = getVerdict(realCostUsd, turkey.priceUsd || null, {
      minHistoricalUsd: minHist || ps.lowestUsd,
      giftCardRate,
      nextSalePrediction,
    });

    // Price history for chart — prefer scraped, fall back to DB
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
        minHistoricalUsd: minHist || ps.lowestUsd || null,
        minRealCostUsd:   (minHist || ps.lowestUsd) ? Math.round((minHist || ps.lowestUsd) * giftCardRate * 100) / 100 : null,
        lastSaleDate:     allSaleDates[allSaleDates.length - 1] || null,
        nextSalePrediction,
        verdict,
      },
      priceHistory,
    });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
