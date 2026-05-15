/**
 * Pure comparison logic — used by both the server routes and copied
 * as a utility on the React client side.
 */

function getVerdict(realCostUsd, turkeyPriceUsd, { minHistoricalUsd, giftCardRate, nextSalePrediction } = {}) {
  const hasAr     = realCostUsd != null && !isNaN(realCostUsd);
  const hasTurkey = turkeyPriceUsd != null && !isNaN(turkeyPriceUsd);

  if (!hasAr && !hasTurkey) {
    return { type: 'NO_DATA', label: '❓ Sin datos suficientes', color: 'gray', saving: 0 };
  }

  // Predicted sale within 60 days?
  if (nextSalePrediction && hasAr) {
    const daysUntil = (new Date(nextSalePrediction) - new Date()) / 86400000;
    if (daysUntil >= 0 && daysUntil <= 60) {
      const minCost = minHistoricalUsd ? minHistoricalUsd * giftCardRate : null;
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
    return {
      type:    'BUY_AR',
      label:   '✅ COMPRÁ VOS',
      sublabel: 'No listado en GamesturkeyACC',
      color:   'green',
      saving:  0,
    };
  }

  if (!hasAr) {
    return {
      type:    'BUY_TURKEY',
      label:   '🇹🇷 COMPRÁ EN TURQUÍA',
      sublabel: 'Sin precio en PS Store AR',
      color:   'red',
      saving:  0,
    };
  }

  const diff    = Math.abs(realCostUsd - turkeyPriceUsd);
  const maxVal  = Math.max(realCostUsd, turkeyPriceUsd);
  const pctDiff = maxVal > 0 ? diff / maxVal : 0;

  if (pctDiff <= 0.10) {
    return {
      type:    'SIMILAR',
      label:   '⚖️ PRECIO SIMILAR',
      sublabel: 'Preferí tu propio stock',
      color:   'gray',
      saving:  0,
    };
  }

  if (realCostUsd < turkeyPriceUsd) {
    const saving = turkeyPriceUsd - realCostUsd;
    return {
      type:    'BUY_AR',
      label:   '✅ COMPRÁ VOS',
      sublabel: `Más barato con gift card — ahorrás $${saving.toFixed(2)} vs Turquía`,
      color:   'green',
      saving,
    };
  }

  const saving = realCostUsd - turkeyPriceUsd;
  return {
    type:    'BUY_TURKEY',
    label:   '🇹🇷 COMPRÁ EN TURQUÍA',
    sublabel: `Ahorrás $${saving.toFixed(2)} comprando en Turquía`,
    color:   'red',
    saving,
  };
}

function predictNextSale(saleDates) {
  if (!saleDates || saleDates.length < 2) return null;
  // Find month patterns
  const months = saleDates.map(d => new Date(d).getMonth()); // 0-11
  const now = new Date();
  const currentMonth = now.getMonth();
  // Look for the next month in the pattern that is still ahead of current month
  for (let offset = 1; offset <= 12; offset++) {
    const futureMonth = (currentMonth + offset) % 12;
    if (months.includes(futureMonth)) {
      const year = futureMonth <= currentMonth ? now.getFullYear() + 1 : now.getFullYear();
      return `${year}-${String(futureMonth + 1).padStart(2, '0')}-01`;
    }
  }
  return null;
}

module.exports = { getVerdict, predictNextSale };
