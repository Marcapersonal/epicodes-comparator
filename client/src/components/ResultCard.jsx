import { useMemo } from 'react';
import VerdictBadge from './VerdictBadge.jsx';
import PriceChart   from './PriceChart.jsx';
import { getVerdict, calcRealCost } from '../utils/comparison.js';
import { api } from '../api.js';

function fmt(n) { return n != null ? `$${Number(n).toFixed(2)}` : '—'; }

export default function ResultCard({ result, giftCardRate, showToast, onTrack }) {
  const { psStore, turkey, comparison, priceHistory, query } = result;

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
            Ediciones disponibles — PS Store AR
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
              {psStore?.variants?.length > 1 ? 'Más barata en PS Store AR' : 'Precio PS Store AR'}
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
            <td>Mínimo histórico PS Store AR</td>
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
            <td style={{ fontSize: 12 }}>{comparison?.lastSaleDate || '—'}</td>
          </tr>
          <tr>
            <td>Próxima venta estimada</td>
            <td style={{ fontSize: 12, color: comparison?.nextSalePrediction ? 'var(--yellow)' : 'var(--dim)' }}>
              {comparison?.nextSalePrediction
                ? comparison.nextSalePrediction.slice(0, 7)
                : '—'}
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

      {priceHistory?.length > 1 && (
        <>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8, fontWeight: 600 }}>Historial de precios</div>
          <PriceChart history={priceHistory} giftCardRate={giftCardRate} />
        </>
      )}

      <button className="btn btn-primary" onClick={handleTrack} style={{ marginTop: 4 }}>
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
