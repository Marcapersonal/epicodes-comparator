// Client-side copy of the verdict logic — used for live recalculation when gift card rate changes

export function getVerdict(realCostUsd, turkeyPriceUsd, { minHistoricalUsd, giftCardRate, nextSalePrediction } = {}) {
  const hasAr     = realCostUsd != null && !isNaN(realCostUsd);
  const hasTurkey = turkeyPriceUsd != null && !isNaN(turkeyPriceUsd);

  if (!hasAr && !hasTurkey) {
    return { type: 'NO_DATA', label: '❓ Sin datos suficientes', color: 'gray', saving: 0 };
  }

  if (nextSalePrediction && hasAr) {
    const daysUntil = (new Date(nextSalePrediction) - new Date()) / 86400000;
    if (daysUntil >= 0 && daysUntil <= 60) {
      const minCost = minHistoricalUsd && giftCardRate ? minHistoricalUsd * giftCardRate : null;
      const saving  = minCost && hasAr ? realCostUsd - minCost : null;
      return {
        type:    'WAIT',
        label:   '⏳ ESPERÁ LA OFERTA',
        sublabel: saving && saving > 0
          ? `Ahorro proyectado: $${saving.toFixed(2)}`
          : `Próxima oferta estimada: ${nextSalePrediction.slice(0, 7)}`,
        color:   'yellow',
        saving:  saving || 0,
      };
    }
  }

  if (!hasTurkey) {
    return { type: 'BUY_AR', label: '✅ COMPRÁ VOS', sublabel: 'No listado en GamesturkeyACC', color: 'green', saving: 0 };
  }

  if (!hasAr) {
    return { type: 'BUY_TURKEY', label: '🇹🇷 COMPRÁ EN TURQUÍA', sublabel: 'Sin precio en PS Store AR', color: 'red', saving: 0 };
  }

  const diff    = Math.abs(realCostUsd - turkeyPriceUsd);
  const maxVal  = Math.max(realCostUsd, turkeyPriceUsd);
  const pctDiff = maxVal > 0 ? diff / maxVal : 0;

  if (pctDiff <= 0.10) {
    return { type: 'SIMILAR', label: '⚖️ PRECIO SIMILAR', sublabel: 'Preferí tu propio stock', color: 'gray', saving: 0 };
  }

  if (realCostUsd < turkeyPriceUsd) {
    const saving = turkeyPriceUsd - realCostUsd;
    return { type: 'BUY_AR', label: '✅ COMPRÁ VOS', sublabel: `Más barato con gift card — ahorrás $${saving.toFixed(2)} vs Turquía`, color: 'green', saving };
  }

  const saving = realCostUsd - turkeyPriceUsd;
  return { type: 'BUY_TURKEY', label: '🇹🇷 COMPRÁ EN TURQUÍA', sublabel: `Ahorrás $${saving.toFixed(2)} comprando en Turquía`, color: 'red', saving };
}

export function calcRealCost(priceUsd, giftCardRate) {
  if (priceUsd == null || isNaN(priceUsd)) return null;
  return Math.round(priceUsd * giftCardRate * 100) / 100;
}
