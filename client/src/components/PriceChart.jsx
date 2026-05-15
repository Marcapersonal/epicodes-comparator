// Lightweight SVG line chart — no external library

export default function PriceChart({ history = [], giftCardRate = 1 }) {
  if (!history.length) return null;

  const points = history.filter(p => p.price_usd != null);
  if (points.length < 2) return null;

  const W = 320, H = 80, PAD = { t: 8, r: 8, b: 24, l: 36 };
  const plotW = W - PAD.l - PAD.r;
  const plotH = H - PAD.t - PAD.b;

  const prices    = points.map(p => p.price_usd);
  const realPrices = prices.map(p => p * giftCardRate);
  const allVals   = [...prices, ...realPrices];
  const minVal    = Math.min(...allVals) * 0.95;
  const maxVal    = Math.max(...allVals) * 1.05;
  const range     = maxVal - minVal || 1;

  const toX = i => PAD.l + (i / (points.length - 1)) * plotW;
  const toY = v => PAD.t + (1 - (v - minVal) / range) * plotH;

  const makePath = (vals) =>
    vals.map((v, i) => `${i === 0 ? 'M' : 'L'}${toX(i).toFixed(1)},${toY(v).toFixed(1)}`).join(' ');

  const psPath   = makePath(prices);
  const realPath = makePath(realPrices);

  // Y-axis labels
  const yTicks = [minVal, (minVal + maxVal) / 2, maxVal];

  // X-axis labels (first, mid, last)
  const xLabels = [0, Math.floor(points.length / 2), points.length - 1].map(i => ({
    x: toX(i),
    label: (points[i].date_label || points[i].recorded_at || '').slice(0, 7),
  }));

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6, display: 'flex', gap: 12 }}>
        <span><span style={{ color: 'var(--primary-h)' }}>●</span> PS Store AR</span>
        <span><span style={{ color: 'var(--green)' }}>●</span> Tu costo real (×tasa)</span>
      </div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: 'block', overflow: 'visible' }}>
        {/* Grid lines */}
        {yTicks.map((v, i) => (
          <g key={i}>
            <line x1={PAD.l} y1={toY(v)} x2={W - PAD.r} y2={toY(v)} stroke="var(--border)" strokeDasharray="3,3" />
            <text x={PAD.l - 4} y={toY(v) + 4} textAnchor="end" fontSize="9" fill="var(--dim)">
              ${v.toFixed(1)}
            </text>
          </g>
        ))}
        {/* Price lines */}
        <path d={psPath}   fill="none" stroke="var(--primary-h)" strokeWidth="2" strokeLinejoin="round" />
        <path d={realPath} fill="none" stroke="var(--green)"     strokeWidth="1.5" strokeDasharray="4,2" strokeLinejoin="round" />
        {/* Dots on last point */}
        <circle cx={toX(points.length - 1)} cy={toY(prices[prices.length - 1])}   r="3" fill="var(--primary-h)" />
        <circle cx={toX(points.length - 1)} cy={toY(realPrices[realPrices.length - 1])} r="3" fill="var(--green)" />
        {/* X labels */}
        {xLabels.map((l, i) => (
          <text key={i} x={l.x} y={H - 4} textAnchor="middle" fontSize="9" fill="var(--dim)">{l.label}</text>
        ))}
      </svg>
    </div>
  );
}
