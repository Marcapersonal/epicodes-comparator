import { useState, useEffect, useRef } from 'react';
import { api, createProgressStream } from '../api.js';
import BulkTable from './BulkTable.jsx';

const FILTER_OPTIONS = [
  { value: 'ALL',          label: 'Todos' },
  { value: 'BUY_AR',       label: '✅ Comprá vos' },
  { value: 'BUY_TURKEY',   label: '🇹🇷 Comprá en Turquía' },
  { value: 'WAIT',         label: '⏳ Esperá la oferta' },
  { value: 'SIMILAR',      label: '⚖️ Precio similar' },
  { value: 'TURKEY_ONLY',  label: '🇹🇷 Solo en Turquía' },
];

export default function BulkTab({ giftCardRate, showToast }) {
  const [data,       setData]       = useState(null);
  const [loading,    setLoading]    = useState(true);
  const [running,    setRunning]    = useState(false);
  const [progress,   setProgress]   = useState(null);
  const [filter,     setFilter]     = useState('ALL');
  const [minSaving,  setMinSaving]  = useState('');
  const closeStream  = useRef(null);

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

  const results = data?.results || [];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
        <div>
          <div className="card-title" style={{ margin: 0 }}>Explorar Ofertas</div>
          {data?.updatedAt && (
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
              Actualizado: {new Date(data.updatedAt).toLocaleString('es-AR')}
            </div>
          )}
        </div>
        <button className="btn btn-primary" onClick={handleRefresh} disabled={running}>
          {running ? <><span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> Scrapeando...</> : '🔄 Actualizar listado'}
        </button>
      </div>

      {running && progress && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="progress-bar-wrap">
            <div className="progress-bar" style={{ width: `${progress.progress || 0}%` }} />
          </div>
          <div className="progress-msg">{progress.message}</div>
        </div>
      )}

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
        {results.length > 0 && (
          <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 'auto' }}>
            {results.length} juegos
          </span>
        )}
      </div>

      {loading && !running && (
        <div className="loading-wrap"><span className="spinner" /><span>Cargando resultados...</span></div>
      )}

      {!loading && results.length === 0 && !running && (
        <div className="empty">
          <div className="empty-icon">📋</div>
          <div className="empty-text">
            {data?.batchId
              ? 'Sin resultados con los filtros actuales.'
              : 'Hacé clic en "Actualizar listado" para scrapear todas las ofertas actuales.'}
          </div>
        </div>
      )}

      {results.length > 0 && (
        <BulkTable rows={results} giftCardRate={giftCardRate} />
      )}
    </div>
  );
}
