import { formatCents } from "@/domain/money";

/** Small server-rendered SVG charts (no client JS). Colors come from CSS tokens so they follow light/dark mode. */

export function LineChart({
  points,
  height = 160,
  series,
  labels,
}: {
  points?: number[];
  series?: Array<{ name: string; values: number[]; color: string; dashed?: boolean }>;
  labels?: string[];
  height?: number;
}) {
  const all = series ?? [{ name: "", values: points ?? [], color: "var(--chart-1)" }];
  const vals = all.flatMap((s) => s.values);
  if (vals.length === 0) return null;
  const w = 600;
  const pad = { t: 10, r: 8, b: labels ? 22 : 8, l: 8 };
  let min = Math.min(...vals, 0);
  let max = Math.max(...vals);
  if (min === max) {
    max += 1;
    min -= 1;
  }
  const n = Math.max(...all.map((s) => s.values.length));
  const x = (i: number) => pad.l + (n <= 1 ? 0 : (i * (w - pad.l - pad.r)) / (n - 1));
  const y = (v: number) => pad.t + ((max - v) * (height - pad.t - pad.b)) / (max - min);
  const zeroY = y(0);
  return (
    <svg viewBox={`0 0 ${w} ${height}`} className="h-auto w-full" role="img" preserveAspectRatio="none">
      {min < 0 && <line x1={pad.l} x2={w - pad.r} y1={zeroY} y2={zeroY} stroke="var(--border)" strokeDasharray="4 4" />}
      {all.map((s) => (
        <polyline
          key={s.name}
          fill="none"
          stroke={s.color}
          strokeWidth={2.2}
          strokeDasharray={s.dashed ? "6 5" : undefined}
          vectorEffect="non-scaling-stroke"
          points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(" ")}
        />
      ))}
      {labels?.map((l, i) =>
        i % Math.ceil(labels.length / 6) === 0 || i === labels.length - 1 ? (
          <text key={i} x={x(i)} y={height - 6} fontSize={11} fill="var(--muted)" textAnchor={i === 0 ? "start" : i === labels.length - 1 ? "end" : "middle"}>
            {l}
          </text>
        ) : null,
      )}
    </svg>
  );
}

export function Bars({
  data,
  height = 180,
  stacked,
}: {
  data: Array<{ label: string; values: Array<{ name: string; value: number; color: string }> }>;
  height?: number;
  stacked?: boolean;
}) {
  if (data.length === 0) return null;
  const w = 600;
  const pad = { t: 10, b: 22, l: 4, r: 4 };
  const totals = data.map((d) => (stacked ? d.values.reduce((s, v) => s + Math.max(0, v.value), 0) : Math.max(...d.values.map((v) => v.value), 0)));
  const max = Math.max(...totals, 1);
  const group = (w - pad.l - pad.r) / data.length;
  const inner = group * 0.7;
  const h = height - pad.t - pad.b;
  return (
    <svg viewBox={`0 0 ${w} ${height}`} className="h-auto w-full" role="img">
      {data.map((d, i) => {
        const gx = pad.l + i * group + (group - inner) / 2;
        if (stacked) {
          let acc = 0;
          return (
            <g key={d.label}>
              {d.values.map((v) => {
                const bh = (Math.max(0, v.value) / max) * h;
                acc += bh;
                return (
                  <rect key={v.name} x={gx} y={pad.t + h - acc} width={inner} height={bh} fill={v.color} rx={2}>
                    <title>{`${d.label} ${v.name}: ${formatCents(v.value, { noCents: true })}`}</title>
                  </rect>
                );
              })}
              <text x={gx + inner / 2} y={height - 6} fontSize={11} fill="var(--muted)" textAnchor="middle">
                {d.label}
              </text>
            </g>
          );
        }
        const bw = inner / d.values.length;
        return (
          <g key={d.label}>
            {d.values.map((v, j) => {
              const bh = (Math.max(0, v.value) / max) * h;
              return (
                <rect key={v.name} x={gx + j * bw} y={pad.t + h - bh} width={bw - 2} height={bh} fill={v.color} rx={2}>
                  <title>{`${d.label} ${v.name}: ${formatCents(v.value, { noCents: true })}`}</title>
                </rect>
              );
            })}
            <text x={gx + inner / 2} y={height - 6} fontSize={11} fill="var(--muted)" textAnchor="middle">
              {d.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function Legend({ items }: { items: Array<{ name: string; color: string }> }) {
  return (
    <div className="flex flex-wrap gap-3 text-xs text-muted">
      {items.map((i) => (
        <span key={i.name} className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: i.color }} />
          {i.name}
        </span>
      ))}
    </div>
  );
}

/** Horizontal share bar (e.g. allocation, tax buckets). */
export function ShareBar({ parts }: { parts: Array<{ name: string; value: number; color: string }> }) {
  const total = parts.reduce((s, p) => s + Math.max(0, p.value), 0);
  if (total <= 0) return <div className="h-3 rounded-full bg-surface-2" />;
  return (
    <div className="flex h-3 w-full overflow-hidden rounded-full bg-surface-2">
      {parts
        .filter((p) => p.value > 0)
        .map((p) => (
          <div key={p.name} style={{ width: `${(p.value / total) * 100}%`, background: p.color }} title={`${p.name}: ${formatCents(p.value, { noCents: true })}`} />
        ))}
    </div>
  );
}

export const CHART_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)", "var(--chart-6)"];
