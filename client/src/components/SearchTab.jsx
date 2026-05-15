import { useState } from 'react';
import { api } from '../api.js';
import ResultCard from './ResultCard.jsx';

export default function SearchTab({ giftCardRate, showToast }) {
  const [query,   setQuery]   = useState('');
  const [loading, setLoading] = useState(false);
  const [result,  setResult]  = useState(null);
  const [error,   setError]   = useState('');

  async function handleSearch(e) {
    e?.preventDefault();
    if (!query.trim()) return;
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const data = await api.search(query.trim());
      setResult(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <form className="search-wrap" onSubmit={handleSearch}>
        <input
          className="search-input"
          type="text"
          placeholder="Buscar juego de PlayStation..."
          value={query}
          onChange={e => setQuery(e.target.value)}
          disabled={loading}
        />
        <button className="search-btn" type="submit" disabled={loading || !query.trim()}>
          {loading ? <span className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} /> : '🔍'}
        </button>
      </form>

      {loading && (
        <div className="loading-wrap">
          <span className="spinner" />
          <span>Buscando en PSDeals y GamesturkeyACC... puede tardar ~15 segundos</span>
        </div>
      )}

      {error && (
        <div className="card" style={{ borderColor: 'var(--red)', color: 'var(--red)' }}>
          ❌ {error}
        </div>
      )}

      {result && !loading && (
        <ResultCard
          result={result}
          giftCardRate={giftCardRate}
          showToast={showToast}
        />
      )}

      {!result && !loading && !error && (
        <div className="empty">
          <div className="empty-icon">🎮</div>
          <div className="empty-text">Buscá cualquier juego de PlayStation para comparar precios</div>
        </div>
      )}
    </div>
  );
}
