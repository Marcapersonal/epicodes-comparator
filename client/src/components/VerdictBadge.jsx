export default function VerdictBadge({ verdict }) {
  if (!verdict) return null;
  return (
    <div className={`verdict ${verdict.color}`}>
      <div className="verdict-label">{verdict.label}</div>
      {verdict.sublabel && <div className="verdict-sub">{verdict.sublabel}</div>}
    </div>
  );
}
