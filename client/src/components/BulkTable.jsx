import { useState, useMemo } from 'react';
import { calcRealCost, getVerdict } from '../utils/comparison.js';
import { api } from '../api.js';

const VERDICT_CHIPS = {
  BUY_AR:      { label: '✅ Comprá vos', cls: 'chip-green'  },
  BUY_TURKEY:  { label: '🇹🇷 Turquía',   cls: 'chip-red'    },
  WAIT:        { label: '⏳ Esperá',      cls: 'chip-yellow' },
  SIMILAR:     { label: '⚖️ Similar',     cls: 'chip-gray'   },
  TURKEY_ONLY: { label: '🇹🇷 Solo TK',   cls: 'chip-gray'   },
  NO_DATA:     { label: '❓ Sin datos',   cls: 'chip-gray'   },
};

function fmt(n) { return n != null ? `$${Number(n).toFixed(2)}` : '—'; }

function fmtDate(d) {
  if (!d) return null;
  try {
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return null;
    return dt.toLocaleDateString('es-AR', { day: 'numeric', month: 'short', year: '2-digit' });
  } catch (_) { return null; }
}

// ── Status badge component ────────────────────────────────────────────────────
function StatusBadge({ row }) {
  const badges = [];

  if (row.last_error) {
    badges.push(<span key="err" title={row.last_error} style={{ color: 'var(--red)', fontSize: 13 }}>🔗</span>);
  }

  if (!row.validated_at) {
    const anyLowConf = (row.sony_us_confidence != null && row.sony_us_confidence < 70) ||
                       (row.turkey_confidence   != null && row.turkey_confidence   < 70);
    if (anyLowConf) {
      badges.push(<span key="conf" title="Confianza baja — revisar link" style={{ color: 'var(--yellow)', fontSize: 12 }}>⚠️</span>);
    } else {
      badges.push(<span key="unval" title="Sin validar" style={{ color: 'var(--muted)', fontSize: 11 }}>○</span>);
    }
  } else {
    badges.push(<span key="ok" title={`Validado por ${row.validated_by}`} style={{ color: 'var(--green)', fontSize: 12 }}>✓</span>);
  }

  return <span style={{ display: 'inline-flex', gap: 2, alignItems: 'center' }}>{badges}</span>;
}

// ── ES Turquía column ─────────────────────────────────────────────────────────
function TurkeyLangCell({ spanishAudio, spanishText, hasTurkeyUrl }) {
  if (!hasTurkeyUrl) return <span style={{ color: 'var(--dim)', fontSize: 11 }}>N/D</span>;
  if (!spanishAudio && !spanishText) return <span style={{ color: 'var(--dim)', fontSize: 11 }}>N/D</span>;
  return (
    <span style={{ display: 'inline-flex', gap: 3 }}>
      {spanishAudio && <span title="Audio en español" style={{ fontSize: 13 }}>🎙️</span>}
      {spanishText  && <span title="Texto/subtítulos en español" style={{ fontSize: 13 }}>📝</span>}
    </span>
  );
}

// ── Expanded row — shows URLs + edit/validate buttons ─────────────────────────
function ExpandedRow({ row, colSpan, showToast, onRefreshRow }) {
  const [editing, setEditing] = useState({});
  const [saving,  setSaving]  = useState(false);

  function urlField(label, key, val) {
    return (
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6, fontSize: 12 }}>
        <span style={{ color: 'var(--muted)', width: 90, flexShrink: 0 }}>{label}:</span>
        {editing[key] !== undefined ? (
          <input
            value={editing[key]}
            onChange={e => setEditing(prev => ({ ...prev, [key]: e.target.value }))}
            style={{ flex: 1, fontSize: 12, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, padding: '2px 6px', color: 'var(--text)' }}
          />
        ) : (
          val
            ? <a href={val} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: 'var(--primary-h)', wordBreak: 'break-all' }}>{val}</a>
            : <span style={{ color: 'var(--dim)', fontSize: 11 }}>— (no configurado)</span>
        )}
        <button
          style={{ fontSize: 11, background: 'none', border: '1px solid var(--border)', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', color: 'var(--muted)', flexShrink: 0 }}
          onClick={() => setEditing(prev =>
            editing[key] !== undefined
              ? (({ [key]: _, ...rest }) => rest)(prev)   // cancel
              : { ...prev, [key]: val || '' }             // start edit
          )}
        >
          {editing[key] !== undefined ? 'Cancelar' : 'Editar'}
        </button>
      </div>
    );
  }

  async function handleSave() {
    if (!Object.keys(editing).length) return;
    setSaving(true);
    try {
      await api.updateCatalogEntry(row.game_catalog_id || row.id, editing);
      showToast?.('✅ URLs actualizadas');
      setEditing({});
      onRefreshRow?.();
    } catch (err) {
      showToast?.(`Error: ${err.message}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleValidate() {
    try {
      await api.validateCatalogEntry(row.game_catalog_id || row.id);
      showToast?.('✅ Marcado como validado');
      onRefreshRow?.();
    } catch (err) {
      showToast?.(`Error: ${err.message}`);
    }
  }

  return (
    <tr>
      <td colSpan={colSpan} style={{ background: 'rgba(0,0,0,0.15)', padding: '10px 16px', fontSize: 12 }}>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 280 }}>
            <div style={{ fontWeight: 600, marginBottom: 8, color: 'var(--muted)' }}>🔗 Links</div>
            {urlField('Sony US', 'sony_us_url', row.ps_detail_url)}
            {urlField('Sony Alt', 'sony_alt_url', row.sony_alt_url)}
            {urlField('Turquía', 'turkey_url', row.turkey_url)}
            {urlField('PSDeals', 'psdeals_url', row.psdeals_url)}
          </div>
          <div style={{ flex: 0, minWidth: 160 }}>
            <div style={{ fontWeight: 600, marginBottom: 8, color: 'var(--muted)' }}>📊 Confianza</div>
            <div style={{ fontSize: 11, lineHeight: 1.8 }}>
              <div>Sony US: <b style={{ color: confidenceColor(row.sony_us_confidence) }}>{row.sony_us_confidence ?? '—'}%</b></div>
              <div>Turquía: <b style={{ color: confidenceColor(row.turkey_confidence) }}>{row.turkey_confidence ?? '—'}%</b></div>
              {row.validated_at && <div style={{ color: 'var(--green)' }}>✓ Validado{row.validated_by ? ` (${row.validated_by})` : ''}</div>}
              {row.last_error && <div style={{ color: 'var(--red)' }}>⚠️ {row.last_error}</div>}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          {Object.keys(editing).length > 0 && (
            <button className="btn btn-primary" onClick={handleSave} disabled={saving} style={{ fontSize: 12, padding: '4px 14px' }}>
              {saving ? '...' : '💾 Guardar cambios'}
            </button>
          )}
          {!row.validated_at && (
            <button className="btn btn-outline" onClick={handleValidate} style={{ fontSize: 12, padding: '4px 14px' }}>
              ✓ Marcar como validado
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

function confidenceColor(c) {
  if (c == null) return 'var(--dim)';
  if (c >= 80) return 'var(--green)';
  if (c >= 60) return 'var(--yellow)';
  return 'var(--red)';
}

// ─────────────────────────────────────────────────────────────────────────────
//  Main BulkTable component
// ─────────────────────────────────────────────────────────────────────────────
export default function BulkTable({ rows, giftCardRate, altRegion, showToast, onReload }) {
  const [sortKey, setSortKey] = useState('saving_usd');
  const [sortAsc, setSortAsc] = useState(false);
  const [expanded, setExpanded] = useState(null); // game_catalog_id or row id of expanded row

  const computed = useMemo(() => rows.map(r => {
    const realCost    = calcRealCost(r.ps_price_usd, giftCardRate);
    const verdict     = getVerdict(realCost, r.turkey_price, { giftCardRate });
    const saving      = verdict.saving || 0;
    // Min hist real cost (from PSDeals data in game_catalog)
    const minRealCost = r.min_hist_usd != null ? calcRealCost(r.min_hist_usd, giftCardRate) : null;
    // Low confidence on any field
    const hasLowConf = (r.sony_us_confidence != null && r.sony_us_confidence < 70) ||
                       (r.turkey_confidence   != null && r.turkey_confidence   < 70);

    return {
      ...r,
      _realCost:    realCost,
      _verdict:     verdict,
      _saving:      saving,
      _verdictType: verdict.type,
      _minRealCost: minRealCost,
      _hasLowConf:  hasLowConf,
    };
  }), [rows, giftCardRate]);

  const sorted = useMemo(() => {
    const clone = [...computed];
    clone.sort((a, b) => {
      let va = sortKey === '_verdict' ? a._verdictType : (a[sortKey] ?? a[`_${sortKey}`] ?? null);
      let vb = sortKey === '_verdict' ? b._verdictType : (b[sortKey] ?? b[`_${sortKey}`] ?? null);
      if (typeof va === 'string') va = va.toLowerCase();
      if (typeof vb === 'string') vb = vb.toLowerCase();
      if (va == null) return 1;
      if (vb == null) return -1;
      return sortAsc ? (va > vb ? 1 : -1) : (va < vb ? 1 : -1);
    });
    return clone;
  }, [computed, sortKey, sortAsc]);

  function toggleSort(key) {
    if (sortKey === key) setSortAsc(a => !a);
    else { setSortKey(key); setSortAsc(false); }
  }

  const th = (key, label, style = {}) => (
    <th onClick={() => toggleSort(key)} style={style}>
      {label} {sortKey === key ? (sortAsc ? '↑' : '↓') : ''}
    </th>
  );

  // Alt region label
  const altLabel = altRegion ? `Sony ${altRegion}` : 'Sony Alt';

  const COL_COUNT = 12;

  return (
    <div className="bulk-table-wrap">
      <table className="bulk-table">
        <colgroup>
          <col className="col-name" />    {/* 1 Juego */}
          <col className="col-ps" />       {/* 2 Sony US */}
          <col className="col-ps" />       {/* 3 Sony Alt */}
          <col className="col-real" />     {/* 4 Real */}
          <col className="col-turkey" />   {/* 5 Turquía */}
          <col className="col-saving" />   {/* 6 Ahorro */}
          <col className="col-verdict" />  {/* 7 Veredicto */}
          <col className="col-min" />      {/* 8 Mín. hist. */}
          <col className="col-sale" />     {/* 9 Fecha mín. */}
          <col className="col-sale" />     {/* 10 Fin oferta */}
          <col className="col-lang" />     {/* 11 ES */}
          <col className="col-hist" />     {/* 12 Estado */}
        </colgroup>
        <thead>
          <tr>
            {th('game_name',    'Juego')}
            {th('ps_price_usd', 'Sony US')}
            {th('sony_alt_price_usd', altLabel)}
            {th('_realCost',    'Real')}
            {th('turkey_price', 'Turquía')}
            {th('_saving',      'Ahorro')}
            {th('_verdict',     'Veredicto')}
            {th('min_hist_usd', 'Mín. hist.', { textAlign: 'right' })}
            <th style={{ textAlign: 'center' }}>Fecha mín.</th>
            {th('ps_sale_end',  'Fin oferta', { textAlign: 'center' })}
            <th style={{ textAlign: 'center' }}>ES TK</th>
            <th style={{ textAlign: 'center' }}>Estado</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => {
            const chip      = VERDICT_CHIPS[r._verdict.type] || VERDICT_CHIPS.NO_DATA;
            const rowKey    = r.game_catalog_id || r.id || i;
            const isExpanded = expanded === rowKey;
            // Low-confidence styling
            const sonyCellStyle  = r.sony_us_confidence != null && r.sony_us_confidence < 70
              ? { borderLeft: '2px solid var(--yellow)' } : {};
            const turkeyCellStyle = r.turkey_confidence != null && r.turkey_confidence < 70
              ? { borderLeft: '2px solid var(--yellow)' } : {};
            // Error styling
            const rowStyle = r.last_error ? { opacity: 0.75 } : {};

            return (
              <>
                <tr
                  key={rowKey}
                  style={{ cursor: 'pointer', ...rowStyle }}
                  onClick={() => setExpanded(isExpanded ? null : rowKey)}
                >
                  {/* 1 Juego */}
                  <td style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.game_name}>
                    {r.game_name}
                  </td>

                  {/* 2 Sony US */}
                  <td style={{ whiteSpace: 'nowrap', ...sonyCellStyle }}>
                    {r.ps_detail_url
                      ? <a href={r.ps_detail_url} target="_blank" rel="noreferrer" style={{ color: 'inherit' }} onClick={e => e.stopPropagation()}>{fmt(r.ps_price_usd)}</a>
                      : fmt(r.ps_price_usd)}
                    {r.ps_discount_pct > 0 && <span style={{ color: 'var(--green)', fontSize: 10, marginLeft: 2 }}>-{r.ps_discount_pct}%</span>}
                  </td>

                  {/* 3 Sony Alt */}
                  <td style={{ whiteSpace: 'nowrap', color: 'var(--muted)' }}>
                    {r.sony_alt_url
                      ? <a href={r.sony_alt_url} target="_blank" rel="noreferrer" style={{ color: 'inherit' }} onClick={e => e.stopPropagation()}>{fmt(r.sony_alt_price_usd)}</a>
                      : <span style={{ color: 'var(--dim)' }}>{fmt(r.sony_alt_price_usd)}</span>}
                  </td>

                  {/* 4 Real */}
                  <td style={{ color: 'var(--primary-h)', fontWeight: 700 }}>{fmt(r._realCost)}</td>

                  {/* 5 Turquía */}
                  <td style={turkeyCellStyle}>
                    {r.turkey_price
                      ? <a href={r.turkey_url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>{fmt(r.turkey_price)}</a>
                      : <span style={{ color: 'var(--dim)' }}>—</span>}
                  </td>

                  {/* 6 Ahorro */}
                  <td style={{ color: r._saving > 0 ? 'var(--green)' : 'var(--dim)' }}>
                    {r._saving > 0 ? fmt(r._saving) : '—'}
                  </td>

                  {/* 7 Veredicto */}
                  <td>
                    <span className={`verdict-chip ${chip.cls}`}>{chip.label}</span>
                  </td>

                  {/* 8 Mín. hist. (from PSDeals via game_catalog) */}
                  <td style={{ textAlign: 'right', fontSize: 12, lineHeight: 1.3 }}>
                    {r._minRealCost != null ? (
                      <>
                        <div style={{ color: 'var(--muted)', fontWeight: 600 }}>{fmt(r._minRealCost)}</div>
                        <div style={{ color: 'var(--dim)', fontSize: 10 }}>{fmt(r.min_hist_usd)} US</div>
                      </>
                    ) : <span style={{ color: 'var(--dim)' }}>—</span>}
                  </td>

                  {/* 9 Fecha del mínimo */}
                  <td style={{ textAlign: 'center', fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                    {fmtDate(r.min_price_date) || '—'}
                  </td>

                  {/* 10 Fin oferta */}
                  <td style={{
                    textAlign: 'center', fontSize: 11, whiteSpace: 'nowrap',
                    color: (r.current_sale_end_date || r.ps_sale_end) ? 'var(--yellow)' : 'var(--dim)',
                  }}>
                    {fmtDate(r.current_sale_end_date || r.ps_sale_end) || '—'}
                  </td>

                  {/* 11 ES Turquía */}
                  <td style={{ textAlign: 'center' }}>
                    <TurkeyLangCell
                      spanishAudio={!!r.spanish_audio}
                      spanishText={!!r.spanish_text}
                      hasTurkeyUrl={!!r.turkey_url}
                    />
                  </td>

                  {/* 12 Estado */}
                  <td style={{ textAlign: 'center' }}>
                    <StatusBadge row={r} />
                  </td>
                </tr>

                {isExpanded && (
                  <ExpandedRow
                    key={`${rowKey}-expanded`}
                    row={r}
                    colSpan={COL_COUNT}
                    showToast={showToast}
                    onRefreshRow={onReload}
                  />
                )}
              </>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
