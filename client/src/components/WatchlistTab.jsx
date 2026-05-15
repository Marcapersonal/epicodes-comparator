import { useState, useEffect } from 'react';
import { api } from '../api.js';
import { calcRealCost } from '../utils/comparison.js';

function fmt(n) { return n != null ? `$${Number(n).toFixed(2)}` : '—'; }

export default function WatchlistTab({ giftCardRate, showToast }) {
  const [items,   setItems]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [alertInputs, setAlertInputs] = useState({});

  async function load() {
    setLoading(true);
    try {
      const { items } = await api.getWatchlist();
      setItems(items);
      const inputs = {};
      items.forEach(i => { inputs[i.id] = i.alert_price != null ? String(i.alert_price) : ''; });
      setAlertInputs(inputs);
    } catch (e) {
      showToast?.(`Error: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []); // eslint-disable-line

  async function handleRemove(id) {
    try {
      await api.removeFromWatchlist(id);
      showToast?.('🗑️ Juego eliminado de Watchlist');
      setItems(prev => prev.filter(i => i.id !== id));
    } catch (e) {
      showToast?.(`Error: ${e.message}`);
    }
  }

  async function handleSetAlert(item) {
    const price = parseFloat(alertInputs[item.id]);
    if (isNaN(price) || price <= 0) { showToast?.('Ingresá un precio válido'); return; }
    try {
      await api.setAlert(item.id, { alert_price: price, alert_enabled: 1 });
      showToast?.(`🔔 Alerta configurada: avisaremos cuando baje de ${fmt(price)}`);
      setItems(prev => prev.map(i => i.id === item.id ? { ...i, alert_price: price, alert_enabled: 1 } : i));
    } catch (e) {
      showToast?.(`Error: ${e.message}`);
    }
  }

  async function handleDisableAlert(item) {
    try {
      await api.setAlert(item.id, { alert_enabled: 0 });
      showToast?.('🔕 Alerta desactivada');
      setItems(prev => prev.map(i => i.id === item.id ? { ...i, alert_enabled: 0 } : i));
    } catch (e) {
      showToast?.(`Error: ${e.message}`);
    }
  }

  if (loading) return <div className="loading-wrap"><span className="spinner" /><span>Cargando watchlist...</span></div>;

  if (!items.length) return (
    <div className="empty">
      <div className="empty-icon">⭐</div>
      <div className="empty-text">Tu watchlist está vacía.<br />Buscá un juego y tocá "Trackear este juego".</div>
    </div>
  );

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div className="card-title" style={{ margin: 0 }}>Watchlist — {items.length} juego{items.length !== 1 ? 's' : ''}</div>
      </div>

      {items.map(item => {
        const realCost = item.last_alert_price ? calcRealCost(item.last_alert_price / giftCardRate, giftCardRate) : null;
        return (
          <div key={item.id} className="watchlist-item">
            <div className="watchlist-item-header">
              <div>
                <div className="watchlist-game-name">{item.game_name}</div>
                <div className="watchlist-meta">
                  Agregado: {new Date(item.added_at).toLocaleDateString('es-AR')}
                  {item.last_checked && ` · Último check: ${new Date(item.last_checked).toLocaleDateString('es-AR')}`}
                </div>
              </div>
              <button className="btn btn-danger" style={{ flexShrink: 0 }} onClick={() => handleRemove(item.id)}>
                🗑️
              </button>
            </div>

            {item.last_alert_price && (
              <div style={{ fontSize: 12, color: 'var(--green)', marginBottom: 8 }}>
                📉 Última bajada: {fmt(item.last_alert_price)} · {item.last_alert_sent?.slice(0, 10)}
              </div>
            )}

            <div className="alert-input-row">
              <span style={{ fontSize: 13, color: 'var(--muted)' }}>Alertarme si mi costo baja de</span>
              <input
                className="alert-input"
                type="number"
                placeholder="$0.00"
                value={alertInputs[item.id] || ''}
                onChange={e => setAlertInputs(prev => ({ ...prev, [item.id]: e.target.value }))}
              />
              <button className="btn btn-primary" style={{ padding: '6px 12px' }} onClick={() => handleSetAlert(item)}>
                🔔 Activar
              </button>
              {item.alert_enabled ? (
                <button className="btn btn-outline" style={{ padding: '6px 12px' }} onClick={() => handleDisableAlert(item)}>
                  🔕 Pausar
                </button>
              ) : null}
            </div>

            {item.alert_price && item.alert_enabled ? (
              <div style={{ fontSize: 12, color: 'var(--yellow)', marginTop: 6 }}>
                🔔 Alerta activa — umbral: {fmt(item.alert_price)}
              </div>
            ) : null}

            <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
              {item.psdeals_url && <a href={item.psdeals_url} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>PSDeals ↗</a>}
              {item.turkey_url  && <a href={item.turkey_url}  target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>GamesturkeyACC ↗</a>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
