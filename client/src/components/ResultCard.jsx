import { useMemo } from 'react';
import VerdictBadge from './VerdictBadge.jsx';
import PriceChart   from './PriceChart.jsx';
import { getVerdict, calcRealCost } from '../utils/comparison.js';
import { api } from '../api.js';

function fmt(n) { return n != null ? `$${Number(n).toFixed(2)}` : '—'; }

// ── Sale Analysis card ────────────────────────────────────────────────────────
function SaleAnalysis({ analysis }) {
  if (!analysis || analysis.saleCount === 0) return null;

  const {
    saleCount, avgDiscountPct, bestPrice,
    lastSaleDate, daysSinceLastSale,
    predictedMonths, nextPredictedDate,
    confidence, verdict, onSaleNow,
  } = analysis;

  const daysColor = onSaleNow
    ? 'var(--green)'
    : daysSinceLastSale < 60  ? 'var(--green)'
    : daysSinceLastSale < 120 ? 'var(--yellow)'
    : 'var(--red)';

  const confidenceBadge = {
    high:   { label: 'alta',  bg: 'rgba(0,230,118,.15)',  color: 'var(--green)'  },
    medium: { label: 'media', bg: 'rgba(255,215,64,.12)', color: 'var(--yellow)' },
    low:    { label: 'baja',  bg: 'rgba(107,114,128,.1)', color: 'var(--muted)'  },
  }[confidence] || { label: confidence, bg: 'rgba(107,114,128,.1)', color: 'var(--muted)' };

  return (
    <div style={{
      marginTop: 12, padding: '12px 14px',
      background: 'rgba(255,255,255,.03)',
      borderRadius: 8, border: '1px solid var(--border)',
    }}>
      {/* Header */}
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
        📈 Historial &amp; Predicción
      </div>

      {/* Main verdict */}
      <div style={{ fontSize: 13, color: 'var(--text)', marginBottom: 6, fontWeight: 600 }}>
        {verdict}
      </div>

      {/* Best price ever */}
      {bestPrice?.price != null && (
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>
          🏆 Mejor precio histórico:{' '}
          <span style={{ color: 'var(--green)', fontWeight: 700 }}>{fmt(bestPrice.price)}</span>
          {bestPrice.discountPct > 0 && <span> (-{bestPrice.discountPct}%)</span>}
          {bestPrice.date && <span> — {bestPrice.date.slice(0, 7)}</span>}
        </div>
      )}

      {/* Next predicted sale */}
      {nextPredictedDate && (
        <div style={{ fontSize: 12, marginBottom: 4 }}>
          <span style={{ color: 'var(--muted)' }}>📅 Próxima estimada: </span>
          <span style={{ color: 'var(--yellow)', fontWeight: 600 }}>{nextPredictedDate.slice(0, 7)}</span>
          <span style={{
            marginLeft: 6, fontSize: 10, padding: '1px 6px', borderRadius: 4,
            background: confidenceBadge.bg, color: confidenceBadge.color,
          }}>
            confianza {confidenceBadge.label}
          </span>
        </div>
      )}

      {/* Days without sale + stats */}
      <div style={{ fontSize: 12, display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 4 }}>
        {daysSinceLastSale != null && (
          <span>
            <span style={{ color: 'var(--muted)' }}>Días sin oferta: </span>
            <span style={{ color: daysColor, fontWeight: 700 }}>{daysSinceLastSale}d</span>
          </span>
        )}
        {avgDiscountPct && (
          <span style={{ color: 'var(--muted)' }}>· Desc. promedio: -{avgDiscountPct}%</span>
        )}
        <span style={{ color: 'var(--muted)' }}>· {saleCount} oferta{saleCount !== 1 ? 's' : ''} registrada{saleCount !== 1 ? 's' : ''}</span>
      </div>

      {/* Predicted months chips */}
      {predictedMonths.length > 0 && (
        <div style={{ marginTop: 8, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>Meses con oferta histórica:</span>
          {predictedMonths.map(m => (
            <span key={m} style={{
              fontSize: 11, padding: '1px 7px', borderRadius: 4,
              background: 'var(--card2)', border: '1px solid var(--border)', color: 'var(--muted)',
            }}>{m}</span>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main ResultCard ───────────────────────────────────────────────────────────
export default function ResultCard({ result, giftCardRate, showToast, onTrack }) {
  const { psStore, turkey, comparison, priceHistory, query, saleAnalysis } = result;

  // Live recalculation when giftCardRate changes
  const realCost = useMemo(
    () => calcRealCost(psStore?.priceUsd, giftCardRate),
    [psStore?.priceUsd, giftCardRate]
  );

  const minRealCost = useMemo(
    () => calcRealCost(comparison?.minHistoricalUsd, giftCardRate),
    [comparison?.minHistoricalUsd, giftCardRate]
  );

  const verdict = useMemo(() => getVerdict(realCost, turkey?.priceUsd, {
    minHistoricalUsd:   comparison?.minHistoricalUsd,
    giftCardRate,
    nextSalePrediction: comparison?.nextSalePrediction,
  }), [realCost, turkey?.priceUsd, comparison, giftCardRate]);

  async function handleTrack() {
    try {
      await api.addToWatchlist({
        game_name:   psStore?.title || query,
        psdeals_url: psStore?.detailUrl,
        turkey_url:  turkey?.url,
      });
      showToast?.('⭐ Juego agregado a Watchlist');
      onTrack?.();
    } catch (e) {
      showToast?.(`Error: ${e.message}`);
    }
  }

  return (
    <div className="card">
      <div className="result-game-title">{psStore?.title || turkey?.title || query}</div>
      <div className="result-rate-badge">Tasa activa: {giftCardRate.toFixed(2)}</div>

      <VerdictBadge verdict={verdict} />

      {/* ── Multiple editions ──────────────────────────────────────────── */}
      {psStore?.found && psStore.variants?.length > 1 && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 1 }}>
            Ediciones disponibles — PS Store US
          </div>
          {psStore.variants.map((v, i) => {
            const vCost = calcRealCost(v.priceUsd, giftCardRate);
            const isCheapest = i === 0;
            return (
              <div
                key={v.title}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '6px 10px', marginBottom: 4, borderRadius: 6,
                  background: isCheapest ? 'rgba(0,200,83,.08)' : 'rgba(255,255,255,.03)',
                  border: isCheapest ? '1px solid rgba(0,200,83,.25)' : '1px solid rgba(255,255,255,.06)',
                }}
              >
                <div style={{ flex: 1, fontSize: 13, color: isCheapest ? 'var(--green)' : 'var(--text)' }}>
                  {isCheapest && <span style={{ fontSize: 10, marginRight: 5 }}>★</span>}
                  <a href={v.detailUrl} target="_blank" rel="noreferrer"
                    style={{ color: 'inherit', textDecoration: 'none' }}>
                    {v.title}
                  </a>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <span style={{ fontWeight: 700, fontSize: 14, color: isCheapest ? 'var(--green)' : 'var(--text)' }}>
                    {fmt(v.priceUsd)}
                  </span>
                  {v.discount > 0 && (
                    <span style={{ color: 'var(--green)', fontSize: 11, marginLeft: 5 }}>-{v.discount}%</span>
                  )}
                  <span style={{ color: 'var(--muted)', fontSize: 11, marginLeft: 6 }}>
                    → {fmt(vCost)} real
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <table className="price-table">
        <tbody>
          <tr>
            <td>
              {psStore?.variants?.length > 1 ? 'Más barata en PS Store US' : 'Precio PS Store US'}
            </td>
            <td className={psStore?.priceUsd ? '' : 'price-red'}>
              {psStore?.found ? (
                <>
                  {psStore.originalPriceUsd && psStore.originalPriceUsd !== psStore.priceUsd
                    ? <><s style={{ color: 'var(--dim)', fontSize: 12 }}>{fmt(psStore.originalPriceUsd)}</s>{' '}</>
                    : null}
                  {fmt(psStore.priceUsd)}
                  {psStore.discount ? <span style={{ color: 'var(--green)', marginLeft: 6, fontSize: 12 }}>-{psStore.discount}%</span> : null}
                </>
              ) : <span style={{ color: 'var(--dim)' }}>No encontrado</span>}
            </td>
          </tr>
          {psStore?.usPriceUsd != null && (
            <tr>
              <td>Precio PS Store US</td>
              <td style={{ color: 'var(--muted)', fontSize: 13 }}>{fmt(psStore.usPriceUsd)}</td>
            </tr>
          )}
          <tr>
            <td>Tu costo real (×{giftCardRate.toFixed(2)})</td>
            <td className="price-highlight">{fmt(realCost)}</td>
          </tr>
          <tr>
            <td>Precio GamesturkeyACC</td>
            <td>
              {turkey?.found
                ? <a href={turkey.url} target="_blank" rel="noreferrer">{fmt(turkey.priceUsd)}</a>
                : <span style={{ color: 'var(--dim)' }}>No listado</span>}
            </td>
          </tr>
          <tr>
            <td>Mínimo histórico PS Store US</td>
            <td>{fmt(comparison?.minHistoricalUsd)}</td>
          </tr>
          <tr>
            <td>Tu costo al mínimo histórico</td>
            <td className={minRealCost && realCost && minRealCost < realCost ? 'price-green' : ''}>
              {fmt(minRealCost)}
            </td>
          </tr>
          <tr>
            <td>Última vez en oferta</td>
            <td style={{ fontSize: 12 }}>{comparison?.lastSaleDate || saleAnalysis?.lastSaleDate || '—'}</td>
          </tr>
          <tr>
            <td>Próxima venta estimada</td>
            <td style={{ fontSize: 12, color: (comparison?.nextSalePrediction || saleAnalysis?.nextPredictedDate) ? 'var(--yellow)' : 'var(--dim)' }}>
              {(comparison?.nextSalePrediction || saleAnalysis?.nextPredictedDate)?.slice(0, 7) || '—'}
            </td>
          </tr>
          {psStore?.saleEnd && (
            <tr>
              <td>Oferta termina</td>
              <td style={{ fontSize: 12, color: 'var(--yellow)' }}>{psStore.saleEnd}</td>
            </tr>
          )}
        </tbody>
      </table>

      {/* ── Sale History & Prediction ──────────────────────────────────── */}
      <SaleAnalysis analysis={saleAnalysis} />

      {priceHistory?.length > 1 && (
        <>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 12, marginBottom: 8, fontWeight: 600 }}>Historial de precios</div>
          <PriceChart history={priceHistory} giftCardRate={giftCardRate} />
        </>
      )}

      <button className="btn btn-primary" onClick={handleTrack} style={{ marginTop: 14 }}>
        ⭐ Trackear este juego
      </button>

      {psStore?.detailUrl && (
        <a
          href={psStore.detailUrl}
          target="_blank"
          rel="noreferrer"
          style={{ marginLeft: 10, fontSize: 12, color: 'var(--muted)' }}
        >
          Ver en PS Store ↗
        </a>
      )}
    </div>
  );
}
