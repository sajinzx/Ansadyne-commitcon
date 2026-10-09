// Small SVG charts: sparkline with a band, histogram, semicircle gauge.
import { scaleLinear } from 'd3-scale';
import { area, line } from 'd3-shape';

export function Sparkline({ mean, lo, hi, truth, width = 220, height = 46, color = 'var(--opt)' }: { mean: number[]; lo?: number[]; hi?: number[]; truth?: number[]; width?: number; height?: number; color?: string }) {
  const n = mean.length;
  if (n < 2) return <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="no data yet" />;
  const all = [...mean, ...(lo ?? []), ...(hi ?? []), ...(truth ?? [])].filter(Number.isFinite);
  let y0 = Math.min(...all);
  let y1 = Math.max(...all);
  if (y1 - y0 < 1e-9) {
    y0 -= 0.5;
    y1 += 0.5;
  }
  const x = scaleLinear().domain([0, n - 1]).range([2, width - 2]);
  const y = scaleLinear().domain([y0, y1]).range([height - 3, 3]);
  const ln = line<number>().x((_, i) => x(i)).y((v) => y(v));
  const band = lo && hi ? area<number>().x((_, i) => x(i)).y0((_, i) => y(lo[i])).y1((_, i) => y(hi[i]))(mean) : null;
  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="belief trend">
      {band && <path d={band} fill={color} opacity={0.2} />}
      {truth && <path d={ln(truth) ?? ''} fill="none" stroke="#fff" strokeDasharray="3 3" strokeWidth={1} opacity={0.8} />}
      <path d={ln(mean) ?? ''} fill="none" stroke={color} strokeWidth={1.5} />
    </svg>
  );
}

export function Histogram({ a, b, labels, height = 90 }: { a: number[]; b?: number[]; labels: string[]; height?: number }) {
  const n = labels.length;
  const W = 380;
  const max = Math.max(1, ...a, ...(b ?? []));
  const bw = W / n;
  const y = scaleLinear().domain([0, max]).range([0, height - 16]);
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${height}`} role="img" aria-label="finishing position histogram">
      {labels.map((l, i) => (
        <g key={l}>
          <rect x={i * bw + 3} y={height - 14 - y(a[i] ?? 0)} width={bw - 6} height={y(a[i] ?? 0)} fill="var(--opt)" />
          {b && <rect x={i * bw + 3} y={height - 14 - y(b[i] ?? 0)} width={bw - 6} height={y(b[i] ?? 0)} fill="none" stroke="var(--b1)" strokeWidth={1.5} />}
          <text x={i * bw + bw / 2} y={height - 2} textAnchor="middle" fontSize={9} fill="var(--muted)" fontFamily="JetBrains Mono">
            {l}
          </text>
        </g>
      ))}
    </svg>
  );
}

export function Gauge({ value, max, label }: { value: number; max: number; label: string }) {
  const f = Math.max(0, Math.min(1, value / max));
  const r = 60;
  const arc = (to: number) => {
    const a = Math.PI * (1 - to);
    return `M ${70 - r} 70 A ${r} ${r} 0 0 1 ${70 + r * Math.cos(a)} ${70 - r * Math.sin(a)}`;
  };
  return (
    <svg viewBox="0 0 140 80" width="100%" style={{ maxWidth: 200 }} role="img" aria-label={label}>
      <path d={arc(1)} stroke="var(--line-2)" strokeWidth={10} fill="none" />
      {f > 0.001 && <path d={arc(f)} stroke={f < 0.15 ? 'var(--bad)' : 'var(--opt)'} strokeWidth={10} fill="none" />}
    </svg>
  );
}
