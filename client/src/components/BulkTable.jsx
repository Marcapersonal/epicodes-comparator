import { useState, useMemo } from 'react';
import { calcRealCost, getVerdict } from '../utils/comparison.js';

const VERDICT_CHIPS = {
  BUY_AR:      { label: '✅ COMPRÁ VOS',   cls: 'chip-green'  },
  BUY_TURKEY:  { label: '🇹🇷 TURQUÍA',     cls: 'chip-red'    },
  WAIT:        { label: '⏳ ESPERÁ',        cls: 'chip-yellow' },
  SIMILAR:     { label: '⚖️ SIMILAR',       cls: 'chip-gray'   },
  TURKEY_ONLY: { label: '🇹🇷 Solo Turquía', cls: 'chip-gray'   },
  NO_DATA:     { label: '❓ Sin datos',     cls: 'chip-gray'   },
};

function fmt(n) { return n != null ? `$${Number(n).toFixed(2)}` : '—'; }

export default function BulkTable({ rows, giftCardRate }) {
  const [sortKey,  setSortKey]  = useState('saving_usd');
  const [sortAsc,  setSortAsc]  = useState(false);
  const [expanded, setExpanded] = useState(null);

  // Live-recalculate real cost and verdict with current giftCardRate
  const computed = useMemo(() => rows.map(r => {
    const realCost = calcRealCost(r.ps_price_usd, giftCardRate);
    const verdict  = getVerdict(realCost, r.turkey_price, { giftCardRate });
    const saving   = verdict.saving || 0;
    return { ...r, _realCost: realCost, _verdict: verdict, _saving: saving };
  }), [rows, giftCardRate]);

  const sorted = useMemo(() => {
    const clone = [...computed];
    clone.sort((a, b) => {
      let va = a[sortKey] ?? a[`_${sortKey}`] ?? 0;
      let vb = b[sortKey] ?? b[`_${sortKey}`] ?? 0;
      if (typeof va === 'string') va = va.toLowerCase();
      if (typeof vb === 'string') vb = vb.toLowerCase();
      return sortAsc ? (va > vb ? 1 : -1) : (va < vb ? 1 : -1);
    });
    return clone;
  }, [computed, sortKey, sortAsc]);

  function toggleSort(key) {
    if (sortKey === key) setSortAsc(a => !a);
    else { setSortKey(key); setSortAsc(false); }
  }

  const th = (key, label) => (
    <th onClick={() => toggleSort(key)}>
      {label} {sortKey === key ? (sortAsc ? '↑' : '↓') : ''}
    </th>
  );

  return (
    <div className="bulk-table-wrap">
      <table className="bulk-table">
        <thead>
          <tr>
            {th('game_name',    'Juego')}
            {th('ps_price_usd', 'PS Store AR')}
            {th('us_price_usd', 'PS Store US')}
            {th('_realCost',    'Tu costo real')}
            {th('turkey_price', 'Turquía')}
            {th('_saving',      'Ahorro')}
            {th('_verdict',     'Veredicto')}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => {
            const chip = VERDICT_CHIPS[r._verdict.type] || VERDICT_CHIPS.NO_DATA;
            const isOpen = expanded === i;
            return (
              <>
                <tr key={r.id || i} onClick={() => setExpanded(isOpen ? null : i)} style={{ cursor: 'pointer' }}>
                  <td style={{ fontWeight: 600, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {isOpen ? '▾ ' : '▸ '}{r.game_name}
                  </td>
                  <td>
                    {fmt(r.ps_price_usd)}
                    {r.ps_discount_pct > 0 && <span style={{ color: 'var(--green)', fontSize: 11, marginLeft: 4 }}>-{r.ps_discount_pct}%</span>}
                  </td>
                  <td style={{ color: 'var(--muted)', fontSize: 13 }}>
                    {r.us_price_usd != null ? fmt(r.us_price_usd) : <span style={{ color: 'var(--dim)' }}>—</span>}
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
                </tr>
                {isOpen && (
                  <tr key={`${i}-detail`}>
                    <td colSpan="7" style={{ background: 'var(--surface)', padding: '12px 16px' }}>
                      <div style={{ fontSize: 13, color: 'var(--muted)', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 16px' }}>
                        <div>Mínimo histórico: <b style={{ color: 'var(--text)' }}>{fmt(r.min_hist_usd)}</b></div>
                        <div>Costo al mínimo: <b style={{ color: 'var(--primary-h)' }}>{calcRealCost(r.min_hist_usd, giftCardRate) ? fmt(calcRealCost(r.min_hist_usd, giftCardRate)) : '—'}</b></div>
                        <div>Fin de oferta: <b style={{ color: 'var(--yellow)' }}>{r.ps_sale_end || '—'}</b></div>
                        <div>Tasa usada: <b style={{ color: 'var(--text)' }}>{giftCardRate.toFixed(2)}</b></div>
                        <div style={{ gridColumn: '1/-1', marginTop: 4 }}><i>{r._verdict.sublabel || ''}</i></div>
                      </div>
                    </td>
                  </tr>
                )}
              </>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
