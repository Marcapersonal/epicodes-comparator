import { useState, useEffect, useCallback } from 'react';
import { api } from './api.js';
import BulkTab      from './components/BulkTab.jsx';
import WatchlistTab from './components/WatchlistTab.jsx';
import SettingsTab  from './components/SettingsTab.jsx';

const TABS = [
  { id: 'bulk',      label: '🎮 Explorar Ofertas' },
  { id: 'watchlist', label: '⭐ Watchlist'        },
  { id: 'settings',  label: '⚙️ Configuración'    },
];

const ALT_REGION_LABEL = { AR: 'AR', BR: 'BR', IN: 'IN', MX: 'MX', TR: 'TR' };

export default function App() {
  const [tab,          setTab]          = useState('bulk');
  const [giftCardRate, setGiftCardRate] = useState(0.72);
  const [altRegion,    setAltRegion]    = useState('AR');
  const [toasts,       setToasts]       = useState([]);

  useEffect(() => {
    api.getSettings().then(s => {
      setGiftCardRate(parseFloat(s.gift_card_rate) || 0.72);
      setAltRegion(s.alt_region || 'AR');
    }).catch(() => {});
  }, []);

  const showToast = useCallback((msg) => {
    const id = Date.now();
    setToasts(t => [...t, { id, msg }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3000);
  }, []);

  const onRateChange      = useCallback((rate)   => setGiftCardRate(rate), []);
  const onAltRegionChange = useCallback((region) => setAltRegion(region),  []);

  return (
    <>
      <header className="app-header">
        <div className="app-header-top">
          <span className="app-logo">🎮</span>
          <div>
            <div className="app-title">Epicodes Price Comparator</div>
            <div className="app-subtitle">
              Sony US · Sony {ALT_REGION_LABEL[altRegion] || altRegion} · GamesturkeyACC · Tasa: {giftCardRate.toFixed(2)}
            </div>
          </div>
        </div>
        <nav className="tabs">
          {TABS.map(t => (
            <button
              key={t.id}
              className={`tab-btn${tab === t.id ? ' active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="main">
        {tab === 'bulk'      && <BulkTab      giftCardRate={giftCardRate} altRegion={altRegion} showToast={showToast} />}
        {tab === 'watchlist' && <WatchlistTab giftCardRate={giftCardRate} showToast={showToast} />}
        {tab === 'settings'  && <SettingsTab  giftCardRate={giftCardRate} onRateChange={onRateChange} altRegion={altRegion} onAltRegionChange={onAltRegionChange} showToast={showToast} />}
      </main>

      <div className="toast-wrap">
        {toasts.map(t => <div key={t.id} className="toast">{t.msg}</div>)}
      </div>
    </>
  );
}
