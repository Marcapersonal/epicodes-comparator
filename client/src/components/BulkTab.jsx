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

// ─────────────────────────────────────────────────────────────────────────────
//  AddGame modal — searches Sony US and shows editions as checkboxes
// ─────────────────────────────────────────────────────────────────────────────
function AddGameModal({ onClose, onAdded, showToast }) {
  const [query,     setQuery]     = useState('');
  const [searching, setSearching] = useState(false);
  const [editions,  setEditions]  = useState(null);
  const [selected,  setSelected]  = useState(new Set());
  const [adding,    setAdding]    = useState(false);
  const [error,     setError]     = useState('');

  async function handleSearch(e) {
    e?.preventDefault();
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    setError('');
    setEditions(null);
    setSelected(new Set());
    try {
      const { editions: eds } = await api.previewCatalogAdd(q);
      setEditions(eds || []);
      // Pre-select all editions
      setSelected(new Set((eds || []).map((_, i) => i)));
      if (!eds?.length) setError('No se encontraron juegos en PS Store para esa búsqueda.');
    } catch (err) {
      setError(err.message);
    } finally {
      setSearching(false);
    }
  }

  function toggleEdition(idx) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }

  async function handleConfirm() {
    const toAdd = editions.filter((_, i) => selected.has(i));
    if (!toAdd.length) return;
    setAdding(true);
    try {
      const result = await api.confirmCatalogAdd(toAdd);
      showToast?.(`✅ ${result.added} juego(s) agregado(s) al catálogo`);
      onAdded?.();
      onClose();
    } catch (err) {
      showToast?.(`Error: ${err.message}`);
    } finally {
      setAdding(false);
    }
  }

  function confidenceBadge(c) {
    if (c == null) return null;
    const color = c >= 80 ? 'var(--green)' : c >= 60 ? 'var(--yellow)' : 'var(--red)';
    return <span style={{ fontSize: 10, color, marginLeft: 4, fontWeight: 600 }}>{c}%</span>;
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }} onClick={onClose}>
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12,
        padding: 24, width: '100%', maxWidth: 560, maxHeight: '90vh', overflowY: 'auto',
      }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ fontWeight: 700, fontSize: 16 }}>➕ Agregar juego al catálogo</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: 'var(--muted)' }}>✕</button>
        </div>

        <form onSubmit={handleSearch} style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <input
            className="search-input"
            type="text"
            placeholder="Nombre del juego (ej: EA SPORTS FC 26)"
            value={query}
            onChange={e => setQuery(e.target.value)}
            disabled={searching}
            style={{ flex: 1 }}
            autoFocus
          />
          <button className="btn btn-primary" type="submit" disabled={searching || !query.trim()}>
            {searching
              ? <><span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /></>
              : '🔍 Buscar'}
          </button>
        </form>

        {error && (
          <div style={{ color: 'var(--red)', fontSize: 13, marginBottom: 12 }}>❌ {error}</div>
        )}

        {editions !== null && editions.length > 0 && (
          <>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
              {editions.length} edición(es) encontrada(s). Seleccioná las que querés agregar:
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
              {editions.map((ed, idx) => (
                <label
                  key={idx}
                  style={{
                    display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 10px',
                    borderRadius: 8, cursor: 'pointer',
                    background: selected.has(idx) ? 'rgba(124,92,252,.12)' : 'rgba(255,255,255,.03)',
                    border: selected.has(idx) ? '1px solid rgba(124,92,252,.4)' : '1px solid var(--border)',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(idx)}
                    onChange={() => toggleEdition(idx)}
                    style={{ marginTop: 2, accentColor: 'var(--primary)' }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>
                      {ed.display_name}
                      {confidenceBadge(ed.sony_us_confidence)}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                      {ed.sony_us_price != null && <span>PS Store US: <b>${ed.sony_us_price?.toFixed(2)}</b>{ed.sony_us_discount > 0 && <span style={{ color: 'var(--green)' }}> -{ed.sony_us_discount}%</span>}</span>}
                      {ed.edition && <span>Edición: <b>{ed.edition}</b></span>}
                    </div>
                    {ed.sony_us_url && (
                      <a href={ed.sony_us_url} target="_blank" rel="noreferrer" style={{ fontSize: 10, color: 'var(--primary-h)', wordBreak: 'break-all' }}>
                        {ed.sony_us_url}
                      </a>
                    )}
                  </div>
                </label>
              ))}
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn btn-outline"
                onClick={() => setSelected(new Set(editions.map((_, i) => i)))}
                style={{ fontSize: 12 }}
              >
                Seleccionar todo
              </button>
              <button
                className="btn btn-outline"
                onClick={() => setSelected(new Set())}
                style={{ fontSize: 12 }}
              >
                Deseleccionar todo
              </button>
              <button
                className="btn btn-primary"
                onClick={handleConfirm}
                disabled={adding || selected.size === 0}
                style={{ marginLeft: 'auto' }}
              >
                {adding
                  ? <><span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> Agregando...</>
                  : `➕ Agregar ${selected.size} juego(s)`}
              </button>
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>
              Al confirmar también se buscan links de Turkey y la región alternativa.
              Entradas con confianza &lt;70% quedarán pendientes de validación manual.
            </div>
          </>
        )}

        {editions !== null && editions.length === 0 && !error && (
          <div style={{ color: 'var(--muted)', fontSize: 13 }}>
            No se encontraron ediciones. Intentá con un nombre diferente.
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Main BulkTab component
// ─────────────────────────────────────────────────────────────────────────────
export default function BulkTab({ giftCardRate: giftCardRateProp, altRegion, showToast }) {
  // ── Local gift-card rate ────────────────────────────────────────────────────
  const [localRate, setLocalRate] = useState(null);
  const giftCardRate = localRate ?? giftCardRateProp;

  async function handleRateChange(val) {
    const n = parseFloat(val);
    if (isNaN(n) || n <= 0) return;
    setLocalRate(n);
    try { await api.saveSettings({ gift_card_rate: n }); } catch (_) {}
  }

  // ── Bulk state ──────────────────────────────────────────────────────────────
  const [data,      setData]      = useState(null);
  const [loading,   setLoading]   = useState(true);
  const [running,   setRunning]   = useState(false);
  const [progress,  setProgress]  = useState(null);
  const closeStream = useRef(null);

  // ── Filter state ────────────────────────────────────────────────────────────
  const [filter,         setFilter]         = useState('ALL');
  const [minSaving,      setMinSaving]      = useState('');
  const [showOnlyValid,  setShowOnlyValid]  = useState(false);
  const [hideExcluded,   setHideExcluded]   = useState(true);
  const [showOnlyErrors, setShowOnlyErrors] = useState(false);

  // ── Catalog panel state ─────────────────────────────────────────────────────
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [catalog,     setCatalog]     = useState([]);

  // ── AddGame modal ───────────────────────────────────────────────────────────
  const [addModalOpen, setAddModalOpen] = useState(false);

  // ── Unvalidated banner ──────────────────────────────────────────────────────
  const [unvalidatedCount, setUnvalidatedCount] = useState(0);

  // ── History stats ───────────────────────────────────────────────────────────
  const [histStats,    setHistStats]    = useState(null);
  const [histFetching, setHistFetching] = useState(false);
  const histPollRef = useRef(null);

  // ── Integrated search ───────────────────────────────────────────────────────
  const [searchInput,   setSearchInput]   = useState('');
  const [searchQuery,   setSearchQuery]   = useState('');
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

  useEffect(() => {
    api.getHistoryStatus().then(({ stats }) => { if (stats) setHistStats(stats); }).catch(() => {});
    api.getCatalog().then(d => setCatalog(d.games || [])).catch(() => {});
    api.getUnvalidatedCount().then(d => setUnvalidatedCount(d.count || 0)).catch(() => {});
  }, []); // eslint-disable-line

  // ── Catalog handlers ────────────────────────────────────────────────────────
  async function handleRemoveCatalogEntry(id, name) {
    try {
      await api.removeCatalogEntry(id);
      setCatalog(prev => prev.filter(g => g.id !== id));
      showToast?.(`🗑 "${name}" eliminado del catálogo`);
      setUnvalidatedCount(c => Math.max(0, c - 1));
    } catch (err) {
      showToast?.(`Error: ${err.message}`);
    }
  }

  function handleAddedGames() {
    api.getCatalog().then(d => setCatalog(d.games || [])).catch(() => {});
    api.getUnvalidatedCount().then(d => setUnvalidatedCount(d.count || 0)).catch(() => {});
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
        api.getHistoryStatus().then(({ stats }) => { if (stats) setHistStats(stats); }).catch(() => {});
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

  // ── PSDeals history fetch ───────────────────────────────────────────────────
  async function handleHistoryFetch() {
    if (histFetching || running) return;
    setHistFetching(true);
    showToast?.('🎭 Iniciando actualización de historial PSDeals... puede tardar varios minutos');
    try {
      await api.startHistoryFetch();
      // Poll every 30s until the job finishes
      if (histPollRef.current) clearInterval(histPollRef.current);
      histPollRef.current = setInterval(async () => {
        try {
          const { stats, active } = await api.getHistoryStatus();
          if (stats) setHistStats(stats);
          if (!active || active.status !== 'running') {
            clearInterval(histPollRef.current);
            histPollRef.current = null;
            setHistFetching(false);
            if (active?.status === 'done') showToast?.(`✅ ${active.message || 'Historial PSDeals actualizado'}`);
          }
        } catch (_) {
          clearInterval(histPollRef.current);
          histPollRef.current = null;
          setHistFetching(false);
        }
      }, 30000);
    } catch (err) {
      showToast?.(`Error PSDeals: ${err.message}`);
      setHistFetching(false);
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

  // ── Client-side filtering ──────────────────────────────────────────────────
  const tableFilter = searchInput.trim() && !searchQuery ? searchInput.trim().toLowerCase() : '';

  const results = useMemo(() => {
    let rows = data?.results || [];

    // Text filter
    if (tableFilter) rows = rows.filter(r => r.game_name?.toLowerCase().includes(tableFilter));

    // Validation filter
    if (showOnlyValid) rows = rows.filter(r => r.validated_at);

    // Error filter
    if (showOnlyErrors) rows = rows.filter(r => r.last_error || (r.sony_us_confidence != null && r.sony_us_confidence < 70));

    // Excluded filter (excluded entries shouldn't appear in bulk results, but just in case)
    if (hideExcluded) rows = rows.filter(r => !r.excluded);

    return rows;
  }, [data, tableFilter, showOnlyValid, showOnlyErrors, hideExcluded]);

  return (
    <div>
      {/* ── Unvalidated banner ──────────────────────────────────────────────── */}
      {unvalidatedCount > 0 && (
        <div style={{
          background: 'rgba(234,179,8,.12)', border: '1px solid rgba(234,179,8,.4)',
          borderRadius: 8, padding: '10px 16px', marginBottom: 14, fontSize: 13,
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        }}>
          <span>⚠️ <b>{unvalidatedCount} juego(s)</b> sin links validados — expandí una fila para revisar los URLs y marcarlos.</span>
          <button
            className="btn btn-outline"
            style={{ fontSize: 11, padding: '3px 10px' }}
            onClick={() => setShowOnlyErrors(true)}
          >
            Ver solo con problema
          </button>
        </div>
      )}

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
              <button
                onClick={handleHistoryFetch}
                disabled={histFetching || running}
                style={{
                  fontSize: 11, color: histFetching ? 'var(--primary-h)' : 'var(--muted)',
                  background: 'var(--surface)', border: '1px solid var(--border)',
                  borderRadius: 6, padding: '2px 8px', cursor: histFetching ? 'default' : 'pointer',
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                }}
                title={histFetching ? 'Actualizando historial PSDeals...' : 'Click para actualizar historial PSDeals (usa Playwright — puede tardar varios minutos)'}
              >
                {histFetching
                  ? <><span className="spinner" style={{ width: 10, height: 10, borderWidth: 2 }} /> Actualizando PSDeals...</>
                  : `📊 PSDeals: ${histStats.gamesWithHistory}/${histStats.totalGames} juegos con historial`}
              </button>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-outline" onClick={() => setCatalogOpen(o => !o)}>
            📋 Catálogo ({catalog.length})
          </button>
          <button className="btn btn-outline" onClick={() => setAddModalOpen(true)}>
            ➕ Agregar juego
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
          <div style={{ maxHeight: 380, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 3 }}>
            {catalog.map(g => (
              <div key={g.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', borderRadius: 4, background: 'rgba(255,255,255,.03)' }}>
                <span style={{ flex: 1, fontSize: 12 }}>
                  {g.display_name || g.name}
                  {!g.validated_at && <span style={{ fontSize: 10, color: 'var(--yellow)', marginLeft: 6 }}>○</span>}
                  {g.last_error && <span style={{ fontSize: 10, color: 'var(--red)', marginLeft: 6 }}>🔗</span>}
                </span>
                <button
                  onClick={() => handleRemoveCatalogEntry(g.id, g.display_name || g.name)}
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

      {/* ── Bulk refresh progress ─────────────────────────────────────────── */}
      {running && progress && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="progress-bar-wrap">
            <div className="progress-bar" style={{ width: `${progress.progress || 0}%` }} />
          </div>
          <div className="progress-msg">{progress.message}</div>
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

      {/* ── Search result ─────────────────────────────────────────────────── */}
      {searchLoading && (
        <div className="loading-wrap" style={{ marginBottom: 12 }}>
          <span className="spinner" />
          <span>Buscando "{searchQuery}" en PS Store + Turquía...</span>
        </div>
      )}
      {searchError && (
        <div className="card" style={{ borderColor: 'var(--red)', color: 'var(--red)', marginBottom: 12 }}>
          ❌ {searchError}
        </div>
      )}
      {searchResult && !searchLoading && (
        <div style={{ marginBottom: 16 }}>
          <ResultCard result={searchResult} giftCardRate={giftCardRate} showToast={showToast} onTrack={() => {}} />
        </div>
      )}

      {/* ── Filter bar ───────────────────────────────────────────────────── */}
      <div className="filter-bar" style={{ flexWrap: 'wrap', gap: 8 }}>
        <span className="filter-label">Veredicto:</span>
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

        <span className="filter-label">Tasa GC:</span>
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

        {/* New filters */}
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, cursor: 'pointer', color: 'var(--muted)' }}>
          <input type="checkbox" checked={showOnlyValid} onChange={e => setShowOnlyValid(e.target.checked)} style={{ accentColor: 'var(--primary)' }} />
          Solo validados
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, cursor: 'pointer', color: 'var(--muted)' }}>
          <input type="checkbox" checked={showOnlyErrors} onChange={e => setShowOnlyErrors(e.target.checked)} style={{ accentColor: 'var(--yellow)' }} />
          Solo con problema
        </label>

        {results.length > 0 && (
          <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 'auto' }}>
            {results.length} resultados{tableFilter ? ` (filtrado de ${data?.results?.length})` : ''}
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
              : 'Hacé clic en "Actualizar listado" para obtener las ofertas actuales.'}
          </div>
        </div>
      )}

      {!loading && results.length === 0 && tableFilter && (
        <div className="empty">
          <div className="empty-icon">🔍</div>
          <div className="empty-text">
            No hay resultados para "{tableFilter}". Presioná Enter para buscar en PS Store directamente.
          </div>
        </div>
      )}

      {results.length > 0 && (
        <BulkTable
          rows={results}
          giftCardRate={giftCardRate}
          altRegion={altRegion}
          showToast={showToast}
          onReload={() => { setLoading(true); load(); }}
        />
      )}

      {/* ── AddGame modal ─────────────────────────────────────────────────── */}
      {addModalOpen && (
        <AddGameModal
          onClose={() => setAddModalOpen(false)}
          onAdded={handleAddedGames}
          showToast={showToast}
        />
      )}
    </div>
  );
}
