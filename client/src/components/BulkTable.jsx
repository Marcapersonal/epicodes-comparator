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

function LangBadge({ spanishAudio, spanishText, notSet }) {
  if (notSet) return <span style={{ color: 'var(--dim)', fontSize: 12 }}>No marcado</span>;
  if (!spanishAudio && !spanishText) return <span style={{ color: 'var(--dim)', fontSize: 12 }}>Sin español</span>;
  return (
    <span style={{ display: 'inline-flex', gap: 6, fontSize: 12 }}>
      {spanishAudio && <span title="Audio en español" style={{ background: 'rgba(0,200,83,.15)', color: 'var(--green)', padding: '2px 7px', borderRadius: 10, fontWeight: 600 }}>🎙️ Audio</span>}
      {spanishText  && <span title="Texto/subtítulos en español" style={{ background: 'rgba(100,160,255,.15)', color: '#6ab0ff', padding: '2px 7px', borderRadius: 10, fontWeight: 600 }}>📝 Texto</span>}
    </span>
  );
}

// langMap: { [game_name_lowercase]: { id, spanishAudio, spanishText } }
export default function BulkTable({ rows, giftCardRate, langMap = {} }) {
  const [sortKey,  setSortKey]  = useState('saving_usd');
  const [sortAsc,  setSortAsc]  = useState(false);
  const [expanded, setExpanded] = useState(null);

  // Live-recalculate real cost and verdict with current giftCardRate
  const computed = useMemo(() => rows.map(r => {
    const realCost    = calcRealCost(r.ps_price_usd, giftCardRate);
    const verdict     = getVerdict(realCost, r.turkey_price, { giftCardRate });
    const saving      = verdict.saving || 0;
    // _verdictType is a plain string for sorting
    return { ...r, _realCost: realCost, _verdict: verdict, _saving: saving, _verdictType: verdict.type };
  }), [rows, giftCardRate]);

  const sorted = useMemo(() => {
    const clone = [...computed];
    clone.sort((a, b) => {
      // For verdict, sort by type string; for others use numeric or string comparison
      let va = sortKey === '_verdict' ? a._verdictType : (a[sortKey] ?? a[`_${sortKey}`] ?? 0);
      let vb = sortKey === '_verdict' ? b._verdictType : (b[sortKey] ?? b[`_${sortKey}`] ?? 0);
      if (typeof va === 'string') va = va.toLowerCase();
      if (typeof vb === 'string') vb = vb.toLowerCase();
      if (va == null) va = sortAsc ? 'zzz' : '';
      if (vb == null) vb = sortAsc ? 'zzz' : '';
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
            {th('ps_price_usd', 'PS Store US')}
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

            // Parse editions_json — filter out currency packs (FC Points, VC, etc.)
            let editions = [];
            if (r.editions_json) {
              try {
                const all = JSON.parse(r.editions_json);
                editions = all.filter(ed => {
                  const n = ed.title || '';
                  if (/\b(fc|vc)\s+points?\b/i.test(n)) return false;
                  if (/\bpoints?\s+[\d,]+/i.test(n)) return false;
                  if (/-\s*[\d,]+\s*(fc|vc|coins?|points?)\b/i.test(n)) return false;
                  if (/\b(points?|coins?)\s*$/i.test(n)) return false;
                  return true;
                });
              } catch (_) {}
            }

            return (
              <>
                <tr key={r.id || i} onClick={() => setExpanded(isOpen ? null : i)} style={{ cursor: 'pointer' }}>
                  <td style={{ fontWeight: 600, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {isOpen ? '▾ ' : '▸ '}{r.game_name}
                  </td>
                  <td>
                    {r.ps_detail_url
                      ? <a href={r.ps_detail_url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>{fmt(r.ps_price_usd)}</a>
                      : fmt(r.ps_price_usd)}
                    {r.ps_discount_pct > 0 && <span style={{ color: 'var(--green)', fontSize: 11, marginLeft: 4 }}>-{r.ps_discount_pct}%</span>}
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
                    <td colSpan="6" style={{ background: 'var(--surface)', padding: '12px 16px' }}>
                      <div style={{ fontSize: 13, color: 'var(--muted)', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 16px' }}>
                        <div>Mínimo histórico: <b style={{ color: 'var(--text)' }}>{fmt(r.min_hist_usd)}</b></div>
                        <div>Costo al mínimo: <b style={{ color: 'var(--primary-h)' }}>{calcRealCost(r.min_hist_usd, giftCardRate) ? fmt(calcRealCost(r.min_hist_usd, giftCardRate)) : '—'}</b></div>
                        <div>Fin de oferta: <b style={{ color: 'var(--yellow)' }}>{r.ps_sale_end || '—'}</b></div>
                        <div>Tasa usada: <b style={{ color: 'var(--text)' }}>{giftCardRate.toFixed(2)}</b></div>
                        <div style={{ gridColumn: '1/-1', marginTop: 4 }}>
                          {(() => {
                            const lang = langMap[r.game_name?.toLowerCase()];
                            return <>Idioma español: <LangBadge spanishAudio={lang?.spanishAudio} spanishText={lang?.spanishText} notSet={!lang} /></>;
                          })()}
                        </div>
                        <div style={{ gridColumn: '1/-1', marginTop: 4 }}><i>{r._verdict.sublabel || ''}</i></div>
                      </div>

                      {editions.length > 0 && (
                        <div style={{ marginTop: 10 }}>
                          <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 1 }}>
                            Comparación por edición — PS Store US vs Turquía
                          </div>
                          {/* Column headers */}
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px 90px 90px 90px', gap: '0 6px', padding: '2px 10px 6px', fontSize: 10, color: 'var(--dim)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                            <span>Edición</span>
                            <span style={{ textAlign: 'right' }}>PS Store</span>
                            <span style={{ textAlign: 'right' }}>Real (×{giftCardRate.toFixed(2)})</span>
                            <span style={{ textAlign: 'right' }}>Turquía</span>
                            <span style={{ textAlign: 'right' }}>Ahorro</span>
                          </div>
                          {editions.map((ed, ei) => {
                            const edCost   = calcRealCost(ed.priceUsd, giftCardRate);
                            const tPrice   = ed.turkeyPriceUsd ?? null;
                            const saving   = edCost != null && tPrice != null ? tPrice - edCost : null;
                            const psWins   = saving != null && saving > 0.5;
                            const tWins    = saving != null && saving < -0.5;
                            const isCheapest = ei === 0;
                            return (
                              <div
                                key={ed.title || ei}
                                style={{
                                  display: 'grid', gridTemplateColumns: '1fr 90px 90px 90px 90px', gap: '0 6px',
                                  alignItems: 'center', padding: '5px 10px', marginBottom: 3, borderRadius: 6,
                                  background: isCheapest && psWins ? 'rgba(0,200,83,.07)'
                                            : tWins ? 'rgba(220,50,50,.06)' : 'rgba(255,255,255,.03)',
                                  border: isCheapest && psWins ? '1px solid rgba(0,200,83,.2)'
                                        : tWins ? '1px solid rgba(220,50,50,.15)' : '1px solid rgba(255,255,255,.05)',
                                }}
                              >
                                {/* Edition name */}
                                <div style={{ fontSize: 12, color: 'var(--text)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {isCheapest && <span style={{ fontSize: 10, color: 'var(--green)', marginRight: 4 }}>★</span>}
                                  {ed.detailUrl
                                    ? <a href={ed.detailUrl} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} style={{ color: 'inherit', textDecoration: 'none' }}>{ed.title}</a>
                                    : ed.title}
                                </div>
                                {/* PS Store price */}
                                <div style={{ textAlign: 'right', fontSize: 12, fontWeight: 600 }}>
                                  {fmt(ed.priceUsd)}
                                  {ed.discount > 0 && <span style={{ color: 'var(--green)', fontSize: 10, marginLeft: 3 }}>-{ed.discount}%</span>}
                                </div>
                                {/* Real cost */}
                                <div style={{ textAlign: 'right', fontSize: 12, color: psWins ? 'var(--green)' : 'var(--primary-h)', fontWeight: psWins ? 700 : 400 }}>
                                  {fmt(edCost)}
                                </div>
                                {/* Turkey price */}
                                <div style={{ textAlign: 'right', fontSize: 12, color: tWins ? 'var(--red)' : 'var(--muted)' }}>
                                  {tPrice != null
                                    ? (ed.turkeyUrl
                                      ? <a href={ed.turkeyUrl} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} style={{ color: 'inherit' }}>{fmt(tPrice)}</a>
                                      : fmt(tPrice))
                                    : <span style={{ color: 'var(--dim)' }}>—</span>}
                                </div>
                                {/* Saving */}
                                <div style={{ textAlign: 'right', fontSize: 11, fontWeight: 600 }}>
                                  {saving != null
                                    ? saving > 0.5
                                      ? <span style={{ color: 'var(--green)' }}>+{fmt(saving)}</span>
                                      : saving < -0.5
                                        ? <span style={{ color: 'var(--red)' }}>🇹🇷 {fmt(Math.abs(saving))}</span>
                                        : <span style={{ color: 'var(--dim)' }}>≈</span>
                                    : <span style={{ color: 'var(--dim)' }}>—</span>}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
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
