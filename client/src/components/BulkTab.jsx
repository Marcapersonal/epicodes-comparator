import { useState, useEffect, useRef, useMemo } from 'react'; // eslint-disable-line no-unused-vars
import { api, createProgressStream } from '../api.js';
import BulkTable  from './BulkTable.jsx';
import ResultCard from './ResultCard.jsx';

const FILTER_OPTIONS = [
  { value: 'ALL',        label: 'Todos' },
  { value: 'BUY_AR',     label: '✅ Comprá vos' },
  { value: 'BUY_TURKEY', label: '🇹🇷 Comprá en Turquía' },
  { value: 'WAIT',       label: '⏳ Esperá la oferta' },
  { value: 'SIMILAR',    label: '⚖️ Precio similar' },
  { value: 'NO_DATA',    label: '❓ Sin precio PS Store' },
];

export default function BulkTab({ giftCardRate: giftCardRateProp, showToast }) {
  // ── Local gift-card rate (overrides prop, persisted to server on blur) ──────
  const [localRate,    setLocalRate]    = useState(null); // null = use prop

  const giftCardRate = localRate ?? giftCardRateProp;

  async function handleRateChange(val) {
    const n = parseFloat(val);
    if (isNaN(n) || n <= 0) return;
    setLocalRate(n);
    try { await api.saveSettings({ gift_card_rate: n }); } catch (_) {}
  }

  // ── Bulk state ──────────────────────────────────────────────────────────────
  const [data,         setData]         = useState(null);
  const [loading,      setLoading]      = useState(true);
  const [running,      setRunning]      = useState(false);
  const [progress,     setProgress]     = useState(null);
  const [filter,       setFilter]       = useState('ALL');
  const [minSaving,    setMinSaving]    = useState('');
  const closeStream    = useRef(null);

  // ── Catalog state ───────────────────────────────────────────────────────────
  const [catalogOpen,  setCatalogOpen]  = useState(false);
  const [catalog,      setCatalog]      = useState([]);
  const [addInput,     setAddInput]     = useState('');
  const [addLoading,   setAddLoading]   = useState(false);

  // ── History stats (loaded once on mount, no job needed) ─────────────────────
  const [histStats, setHistStats] = useState(null);

  // ── Integrated search state ─────────────────────────────────────────────────
  const [searchInput,   setSearchInput]   = useState('');
  const [searchQuery,   setSearchQuery]   = useState('');   // committed query
  const [searchResult,  setSearchResult]  = useState(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError,   setSearchError]   = useState('');

  // ── Load bulk data ──────────────────────────────────────────────────────────
  async function load(params = {}) {
    try {
      const d = await api.getBulk({ filter, minSaving, ...params });
      setData(d);
      if (d.active?.status === 'running') {
        setRunning(true);
        listenProgress(d.active.id);
      }
    } catch (e) {
      showToast?.(`Error: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [filter, minSaving]); // eslint-disable-line

  // On mount: load history stats (data is always persistent in DB)
  useEffect(() => {
    api.getHistoryStatus().then(({ stats }) => {
      if (stats) setHistStats(stats);
    }).catch(() => {});
  }, []); // eslint-disable-line

  // On mount: load catalog
  useEffect(() => {
    api.getCatalog().then(d => setCatalog(d.games || [])).catch(() => {});
  }, []); // eslint-disable-line

  // ── Catalog handlers ────────────────────────────────────────────────────────
  async function handleAddToCatalog(e) {
    e?.preventDefault();
    const name = addInput.trim();
    if (!name) return;
    setAddLoading(true);
    try {
      await api.addToCatalog(name);
      const d = await api.getCatalog();
      setCatalog(d.games || []);
      setAddInput('');
      showToast?.(`✅ "${name}" agregado al catálogo`);
    } catch (err) {
      showToast?.(`Error: ${err.message}`);
    } finally {
      setAddLoading(false);
    }
  }

  async function handleRemoveFromCatalog(id, name) {
    try {
      await api.removeFromCatalog(id);
      setCatalog(prev => prev.filter(g => g.id !== id));
      showToast?.(`🗑 "${name}" eliminado del catálogo`);
    } catch (err) {
      showToast?.(`Error: ${err.message}`);
    }
  }

  // ── Bulk refresh ────────────────────────────────────────────────────────────
  function listenProgress(batchId) {
    closeStream.current?.();
    closeStream.current = createProgressStream(batchId, (msg) => {
      setProgress(msg);
      if (msg.status === 'done' || msg.status === 'error') {
        setRunning(false);
        closeStream.current?.();
        setLoading(true);
        load();
      }
    });
  }

  async function handleRefresh() {
    if (running) return;
    setRunning(true);
    setProgress({ message: 'Iniciando scrape...', progress: 0 });
    try {
      const { batchId } = await api.startBulkRefresh();
      listenProgress(batchId);
    } catch (e) {
      setRunning(false);
      showToast?.(`Error: ${e.message}`);
    }
  }

  // ── Integrated search ───────────────────────────────────────────────────────
  async function handleSearch(e) {
    e?.preventDefault();
    const q = searchInput.trim();
    if (!q) return;
    setSearchQuery(q);
    setSearchLoading(true);
    setSearchError('');
    setSearchResult(null);
    try {
      const data = await api.search(q);
      setSearchResult(data);
    } catch (err) {
      setSearchError(err.message);
    } finally {
      setSearchLoading(false);
    }
  }

  function clearSearch() {
    setSearchInput('');
    setSearchQuery('');
    setSearchResult(null);
    setSearchError('');
  }

  // Client-side filter: if there's text in the search bar but no committed
  // query yet, filter the bulk table rows by game_name
  const tableFilter = searchInput.trim() && !searchQuery
    ? searchInput.trim().toLowerCase()
    : '';

  const results = useMemo(() => {
    const rows = data?.results || [];
    if (!tableFilter) return rows;
    return rows.filter(r => r.game_name?.toLowerCase().includes(tableFilter));
  }, [data, tableFilter]);

  return (
    <div>
      {/* ── Header row ───────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
        <div>
          <div className="card-title" style={{ margin: 0 }}>Explorar Ofertas</div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 2, flexWrap: 'wrap' }}>
            {data?.updatedAt && (
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                Actualizado: {new Date(data.updatedAt).toLocaleString('es-AR')}
              </span>
            )}
            {histStats && (
              <span
                style={{ fontSize: 11, color: 'var(--muted)', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '2px 8px' }}
                title="Historial de precios guardado en la base de datos. Crece automáticamente con cada actualización del listado."
              >
                📊 Historial: {histStats.gamesWithHistory}/{histStats.totalGames} juegos
              </span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-outline" onClick={() => setCatalogOpen(o => !o)}>
            📋 Catálogo ({catalog.length})
          </button>
          <button className="btn btn-primary" onClick={handleRefresh} disabled={running}>
            {running
              ? <><span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> Scrapeando...</>
              : '🔄 Actualizar listado'}
          </button>
        </div>
      </div>

      {/* ── Catalog panel ────────────────────────────────────────────────── */}
      {catalogOpen && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div style={{ fontWeight: 600, marginBottom: 10, fontSize: 14 }}>
            📋 Catálogo de juegos ({catalog.length})
          </div>
          <form onSubmit={handleAddToCatalog} style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <input
              className="search-input"
              type="text"
              placeholder="Nombre del juego a agregar..."
              value={addInput}
              onChange={e => setAddInput(e.target.value)}
              disabled={addLoading}
              style={{ flex: 1 }}
            />
            <button className="btn btn-primary" type="submit" disabled={addLoading || !addInput.trim()}>
              {addLoading ? <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> : 'Agregar'}
            </button>
          </form>
          <div style={{ maxHeight: 380, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 3 }}>
            {catalog.map(g => (
              <div key={g.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', borderRadius: 4, background: 'rgba(255,255,255,.03)' }}>
                <span style={{ flex: 1, fontSize: 12 }}>{g.name}</span>
                <button
                  onClick={() => handleRemoveFromCatalog(g.id, g.name)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--red)', fontSize: 14, padding: '0 2px', lineHeight: 1 }}
                  title="Eliminar del catálogo"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Integrated search bar ─────────────────────────────────────────── */}
      <form className="search-wrap" onSubmit={handleSearch} style={{ marginBottom: 12 }}>
        <input
          className="search-input"
          type="text"
          placeholder="Filtrar lista o buscar un juego exacto en PS Store..."
          value={searchInput}
          onChange={e => { setSearchInput(e.target.value); if (searchQuery) clearSearch(); }}
          disabled={searchLoading}
        />
        {searchInput && (
          <button type="button" className="btn btn-outline" onClick={clearSearch} style={{ padding: '9px 12px', fontSize: 16 }}>
            ✕
          </button>
        )}
        <button className="search-btn" type="submit" disabled={searchLoading || !searchInput.trim()}>
          {searchLoading
            ? <span className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} />
            : '🔍'}
        </button>
      </form>

      {/* ── Search result card ────────────────────────────────────────────── */}
      {searchLoading && (
        <div className="loading-wrap" style={{ marginBottom: 12 }}>
          <span className="spinner" />
          <span>Buscando "{searchQuery}" en PS Store AR + Turquía...</span>
        </div>
      )}
      {searchError && (
        <div className="card" style={{ borderColor: 'var(--red)', color: 'var(--red)', marginBottom: 12 }}>
          ❌ {searchError}
        </div>
      )}
      {searchResult && !searchLoading && (
        <div style={{ marginBottom: 16 }}>
          <ResultCard
            result={searchResult}
            giftCardRate={giftCardRate}
            showToast={showToast}
            onTrack={() => {}}
          />
        </div>
      )}

      {/* ── Bulk refresh progress ─────────────────────────────────────────── */}
      {running && progress && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="progress-bar-wrap">
            <div className="progress-bar" style={{ width: `${progress.progress || 0}%` }} />
          </div>
          <div className="progress-msg">{progress.message}</div>
        </div>
      )}

      {/* ── Filter bar ───────────────────────────────────────────────────── */}
      <div className="filter-bar">
        <span className="filter-label">Filtrar:</span>
        <select className="filter-select" value={filter} onChange={e => setFilter(e.target.value)}>
          {FILTER_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <span className="filter-label">Ahorro mín:</span>
        <input
          className="filter-input"
          type="number"
          placeholder="$0"
          value={minSaving}
          onChange={e => setMinSaving(e.target.value)}
          style={{ width: 70 }}
        />
        <span className="filter-label" style={{ marginLeft: 8 }}>Tasa GC:</span>
        <input
          className="filter-input"
          type="number"
          step="0.01"
          min="0.01"
          max="2"
          value={localRate ?? giftCardRateProp}
          onChange={e => setLocalRate(parseFloat(e.target.value) || null)}
          onBlur={e => handleRateChange(e.target.value)}
          style={{ width: 64 }}
          title="Tasa de gift card: precio PS Store US × esta tasa = tu costo real"
        />
        {results.length > 0 && (
          <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 'auto' }}>
            {results.length} ediciones{tableFilter ? ` (filtrado de ${data?.results?.length})` : ''}
          </span>
        )}
      </div>

      {loading && !running && (
        <div className="loading-wrap"><span className="spinner" /><span>Cargando resultados...</span></div>
      )}

      {!loading && results.length === 0 && !running && !tableFilter && (
        <div className="empty">
          <div className="empty-icon">📋</div>
          <div className="empty-text">
            {data?.batchId
              ? 'Sin resultados con los filtros actuales.'
              : 'Hacé clic en "Actualizar listado" para scrapear todas las ofertas actuales.'}
          </div>
        </div>
      )}

      {!loading && results.length === 0 && tableFilter && (
        <div className="empty">
          <div className="empty-icon">🔍</div>
          <div className="empty-text">
            No hay resultados para "{tableFilter}" en el listado. Presioná Enter para buscar en PS Store directamente.
          </div>
        </div>
      )}

      {results.length > 0 && (
        <BulkTable rows={results} giftCardRate={giftCardRate} />
      )}
    </div>
  );
}
