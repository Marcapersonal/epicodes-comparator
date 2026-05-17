import { useState, useMemo } from 'react';
import { calcRealCost, getVerdict } from '../utils/comparison.js';

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
  if (!d) return '—';
  try {
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return '—';
    return dt.toLocaleDateString('es-AR', { day: 'numeric', month: 'short' });
  } catch (_) { return '—'; }
}

function LangCell({ spanishAudio, spanishText }) {
  if (!spanishAudio && !spanishText) return null;
  return (
    <span style={{ display: 'inline-flex', gap: 4 }}>
      {spanishAudio && <span title="Audio en español" style={{ fontSize: 13 }}>🎙️</span>}
      {spanishText  && <span title="Texto/subtítulos en español" style={{ fontSize: 13 }}>📝</span>}
    </span>
  );
}

export default function BulkTable({ rows, giftCardRate }) {
  const [sortKey, setSortKey] = useState('saving_usd');
  const [sortAsc, setSortAsc] = useState(false);

  // Live-recalculate real cost and verdict with current giftCardRate
  const computed = useMemo(() => rows.map(r => {
    const realCost    = calcRealCost(r.ps_price_usd, giftCardRate);
    const verdict     = getVerdict(realCost, r.turkey_price, { giftCardRate });
    const saving      = verdict.saving || 0;
    const minRealCost = calcRealCost(r.min_hist_usd, giftCardRate);
    return { ...r, _realCost: realCost, _verdict: verdict, _saving: saving, _verdictType: verdict.type, _minRealCost: minRealCost };
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

  return (
    <div className="bulk-table-wrap">
      <table className="bulk-table">
        <colgroup>
          <col className="col-name" />
          <col className="col-ps" />
          <col className="col-real" />
          <col className="col-turkey" />
          <col className="col-saving" />
          <col className="col-verdict" />
          <col className="col-min" />
          <col className="col-sale" />
          <col className="col-lang" />
        </colgroup>
        <thead>
          <tr>
            {th('game_name',    'Juego')}
            {th('ps_price_usd', 'PS Store')}
            {th('_realCost',    'Real')}
            {th('turkey_price', 'Turquía')}
            {th('_saving',      'Ahorro')}
            {th('_verdict',     'Veredicto')}
            {th('min_hist_usd', 'Mín. real', { textAlign: 'right' })}
            {th('ps_sale_end',  'Fin oferta', { textAlign: 'center' })}
            <th style={{ textAlign: 'center' }}>ES</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => {
            const chip = VERDICT_CHIPS[r._verdict.type] || VERDICT_CHIPS.NO_DATA;
            return (
              <tr key={r.id || i}>
                <td style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.game_name}>
                  {r.ps_detail_url
                    ? <a href={r.ps_detail_url} target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>{r.game_name}</a>
                    : r.game_name}
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {fmt(r.ps_price_usd)}
                  {r.ps_discount_pct > 0 && <span style={{ color: 'var(--green)', fontSize: 10, marginLeft: 2 }}>-{r.ps_discount_pct}%</span>}
                </td>
                <td style={{ color: 'var(--primary-h)', fontWeight: 700 }}>{fmt(r._realCost)}</td>
                <td>
                  {r.turkey_price
                    ? <a href={r.turkey_url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>{fmt(r.turkey_price)}</a>
                    : <span style={{ color: 'var(--dim)' }}>—</span>}
                </td>
                <td style={{ color: r._saving > 0 ? 'var(--green)' : 'var(--dim)' }}>
                  {r._saving > 0 ? fmt(r._saving) : '—'}
                </td>
                <td>
                  <span className={`verdict-chip ${chip.cls}`}>{chip.label}</span>
                </td>
                <td style={{ textAlign: 'right', fontSize: 12, color: r._minRealCost != null ? 'var(--muted)' : 'var(--dim)' }}>
                  {r._minRealCost != null ? fmt(r._minRealCost) : '—'}
                </td>
                <td style={{ textAlign: 'center', fontSize: 11, color: r.ps_sale_end ? 'var(--yellow)' : 'var(--dim)', whiteSpace: 'nowrap' }}>
                  {fmtDate(r.ps_sale_end)}
                </td>
                <td style={{ textAlign: 'center' }}>
                  <LangCell spanishAudio={!!r.spanish_audio} spanishText={!!r.spanish_text} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
