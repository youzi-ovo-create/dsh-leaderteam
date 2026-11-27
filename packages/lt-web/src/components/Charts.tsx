import React from 'react';
import type { FrontierStageObservation } from '../types/lt-public-v1';

export interface StackedBarRow {
  label: string;
  values: Record<string, number>;
  unknownCount?: number;
}

export interface StackedBarSeries {
  key: string;
  label: string;
  color: string;
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

function fmtAxis(v: number, unit = ''): string {
  if (v >= 1e6) return `${(v / 1e6).toFixed(v % 1e6 ? 1 : 0)}M${unit}`;
  if (v >= 1000) return `${(v / 1000).toFixed(v % 1000 ? 1 : 0)}k${unit}`;
  return `${Math.round(v)}${unit}`;
}

export function StackedBars({
  rows,
  series,
  width = 680,
  height = 210,
  unit = '',
  unknownScale,
  ariaLabel = '堆叠柱状图',
}: {
  rows: StackedBarRow[];
  series: StackedBarSeries[];
  width?: number;
  height?: number;
  unit?: string;
  unknownScale?: number;
  ariaLabel?: string;
}) {
  if (rows.length === 0) {
    return (
      <div className="empty" style={{ padding: '32px 16px' }}>
        <span className="t-meta">暂无可绘制的统计桶数据</span>
      </div>
    );
  }
  const pl = 44;
  const pb = 22;
  const pt = 8;
  const pr = 8;
  let maxKnown = 0;
  for (const r of rows) {
    let sum = 0;
    for (const s of series) sum += r.values[s.key] || 0;
    if (sum > maxKnown) maxKnown = sum;
  }
  const effectiveUnknownScale =
    unknownScale !== undefined
      ? unknownScale
      : maxKnown > 0
        ? Math.max(1, maxKnown * 0.08)
        : 1;
  let rawMax = 0;
  for (const r of rows) {
    let sum = 0;
    for (const s of series) sum += r.values[s.key] || 0;
    if (r.unknownCount) sum += r.unknownCount * effectiveUnknownScale;
    if (sum > rawMax) rawMax = sum;
  }
  const max = niceMax(rawMax);
  const bw = (width - pl - pr) / rows.length;
  const plotH = height - pt - pb;

  return (
    <svg
      className="chart"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={ariaLabel}
    >
      <defs>
        <pattern
          id="hl-hatch"
          width="5"
          height="5"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <rect width="5" height="5" style={{ fill: 'transparent' }} />
          <line x1="0" y1="0" x2="0" y2="5" style={{ stroke: 'var(--lt-chart-unknown)', strokeWidth: 2.2 }} />
        </pattern>
      </defs>
      {[0, 1, 2, 3, 4, 5].map(i => {
        const y = pt + (plotH * i) / 5;
        return (
          <g key={i}>
            <line className="grid-line" x1={pl} x2={width - pr} y1={y} y2={y} />
            <text x={pl - 6} y={y + 3} textAnchor="end">
              {fmtAxis(max * (1 - i / 5), unit)}
            </text>
          </g>
        );
      })}
      {rows.map((r, i) => {
        const x = pl + i * bw + bw * 0.22;
        const w = Math.max(4, bw * 0.56);
        let y = height - pb;
        const rects: React.ReactNode[] = [];
        for (const s of series) {
          const val = r.values[s.key] || 0;
          const h = (plotH * val) / max;
          y -= h;
          if (h > 0) {
            rects.push(
              <rect
                key={s.key}
                x={Number(x.toFixed(1))}
                y={Number(y.toFixed(1))}
                width={Number(w.toFixed(1))}
                height={Number(Math.max(0, h).toFixed(1))}
                style={{ fill: s.color }}
              >
                <title>{`${r.label} · ${s.label} ${val.toLocaleString('en-US')}${unit}`}</title>
              </rect>,
            );
          }
        }
        if (r.unknownCount && r.unknownCount > 0) {
          const hu = (plotH * r.unknownCount * effectiveUnknownScale) / max;
          y -= hu;
          rects.push(
            <rect
              key="__unknown__"
              x={Number(x.toFixed(1))}
              y={Number(y.toFixed(1))}
              width={Number(w.toFixed(1))}
              height={Number(Math.max(2, hu).toFixed(1))}
              fill="url(#hl-hatch)"
            >
              <title>{`${r.label} · 未计量调用 ${r.unknownCount} 次（高度为示意，不计入合计）`}</title>
            </rect>,
          );
        }
        return (
          <g key={`${r.label}-${i}`}>
            {rects}
            <text x={Number((x + w / 2).toFixed(1))} y={height - 6} textAnchor="middle">
              {r.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function TopologyGraph({ stages }: { stages: FrontierStageObservation[] }) {
  if (!stages || stages.length === 0) {
    return (
      <div className="empty" style={{ padding: '32px 16px' }}>
        <span className="t-meta">该团队尚未建立滚动规划阶段拓扑</span>
      </div>
    );
  }

  const stageById = new Map(stages.map(s => [s.stageId, s]));
  const depth: Record<string, number> = {};
  const visiting = new Set<string>();
  const calcDepth = (id: string): number => {
    if (depth[id] !== undefined) return depth[id];
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const st = stageById.get(id);
    const validDeps = (st?.dependsOn || []).filter(d => stageById.has(d));
    const d = validDeps.length > 0 ? Math.max(...validDeps.map(calcDepth)) + 1 : 0;
    visiting.delete(id);
    depth[id] = d;
    return d;
  };
  for (const s of stages) calcDepth(s.stageId);

  const cols: Record<number, FrontierStageObservation[]> = {};
  for (const s of stages) {
    const c = depth[s.stageId] || 0;
    if (!cols[c]) cols[c] = [];
    cols[c].push(s);
  }

  const NW = 204;
  const NH = 68;
  const GX = 60;
  const GY = 18;
  const colIndices = Object.keys(cols)
    .map(Number)
    .sort((a, b) => a - b);
  const maxRows = Math.max(1, ...colIndices.map(c => cols[c].length));
  const H = maxRows * NH + (maxRows - 1) * GY + 24;
  const W = 12 + colIndices.length * (NW + GX) - GX + 12;

  const pos: Record<string, { x: number; y: number }> = {};
  colIndices.forEach((c, ci) => {
    const list = cols[c];
    const total = list.length * NH + (list.length - 1) * GY;
    const y0 = (H - total) / 2;
    list.forEach((s, ri) => {
      pos[s.stageId] = { x: 12 + ci * (NW + GX), y: y0 + ri * (NH + GY) };
    });
  });

  const stateStyle = (st: FrontierStageObservation['executionState']) => {
    switch (st) {
      case 'verified':
        return { stroke: 'var(--lt-accent)', label: '已完成', dash: undefined, width: 1 };
      case 'running':
        return { stroke: 'var(--lt-info)', label: '执行中', dash: undefined, width: 1.75 };
      case 'blocked':
        return { stroke: 'var(--lt-warning)', label: '阻塞', dash: '4 3', width: 1.5 };
      case 'ready':
        return { stroke: 'var(--lt-border-control-hover)', label: '就绪', dash: undefined, width: 1 };
      default:
        return { stroke: 'var(--lt-border-control)', label: '计划中', dash: '4 3', width: 1 };
    }
  };

  return (
    <div>
      <svg
        className="chart"
        viewBox={`0 0 ${W} ${H}`}
        style={{ maxWidth: W }}
        role="img"
        aria-label="滚动规划阶段依赖拓扑"
      >
        {stages.flatMap(s =>
          (s.dependsOn || [])
            .filter(d => Boolean(pos[d] && pos[s.stageId]))
            .map(d => {
              const a = pos[d];
              const b = pos[s.stageId];
              const src = stageById.get(d);
              const solid = src?.executionState === 'verified';
              const x1 = a.x + NW;
              const y1 = a.y + NH / 2;
              const x2 = b.x;
              const y2 = b.y + NH / 2;
              const mx = (x1 + x2) / 2;
              return (
                <g key={`${d}->${s.stageId}`}>
                  <path
                    d={`M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2 - 4} ${y2}`}
                    style={{
                      fill: 'none',
                      stroke: solid ? 'var(--lt-accent)' : 'var(--lt-border-control)',
                      strokeWidth: solid ? 1.5 : 1.25,
                      strokeDasharray: solid ? undefined : '4 4',
                    }}
                  />
                  <path
                    d={`M${x2 - 8} ${y2 - 4} L${x2 - 2} ${y2} L${x2 - 8} ${y2 + 4}`}
                    style={{
                      fill: 'none',
                      stroke: solid ? 'var(--lt-accent)' : 'var(--lt-border-control)',
                      strokeWidth: 1.25,
                    }}
                  />
                </g>
              );
            }),
        )}
        {stages.map(s => {
          const p = pos[s.stageId];
          if (!p) return null;
          const st = stateStyle(s.executionState);
          const shortTitle = s.title.length > 13 ? `${s.title.slice(0, 13)}…` : s.title;
          return (
            <g key={s.stageId}>
              <rect
                x={p.x}
                y={p.y}
                width={NW}
                height={NH}
                rx={6}
                style={{
                  fill: 'var(--lt-bg-surface)',
                  stroke: st.stroke,
                  strokeWidth: st.width,
                  strokeDasharray: st.dash,
                }}
              />
              {s.executionState === 'verified' && (
                <rect
                  x={p.x}
                  y={p.y}
                  width={3}
                  height={NH}
                  rx={1.5}
                  style={{ fill: 'var(--lt-accent)' }}
                />
              )}
              <text
                x={p.x + 14}
                y={p.y + 21}
                style={{ fontFamily: 'var(--hl-font-mono)', fontSize: 11, fill: 'var(--lt-fg-muted)' }}
              >
                {s.stageId}
                {s.stageHash ? ` · ${s.stageHash.slice(0, 6)}` : ''}
              </text>
              <text
                x={p.x + 14}
                y={p.y + 40}
                style={{ fontSize: 12.5, fontWeight: 600, fill: 'var(--lt-fg-primary)' }}
              >
                {shortTitle}
                <title>{s.title}</title>
              </text>
              <text
                x={p.x + 14}
                y={p.y + 57}
                style={{
                  fontSize: 11,
                  fill:
                    s.executionState === 'running'
                      ? 'var(--lt-info)'
                      : s.executionState === 'blocked'
                        ? 'var(--lt-warning)'
                        : 'var(--lt-fg-muted)',
                }}
              >
                {st.label}
                {s.writeScope?.length ? ` · ${s.writeScope.length} 写域` : ''}
              </text>
              {s.executionState === 'running' && (
                <circle cx={p.x + NW - 16} cy={p.y + 17} r={4} style={{ fill: 'var(--lt-info)' }}>
                  <animate attributeName="opacity" values="1;.3;1" dur="2.4s" repeatCount="indefinite" />
                </circle>
              )}
            </g>
          );
        })}
      </svg>
      <div className="legend" style={{ marginTop: 12 }}>
        <span>
          <i style={{ background: 'var(--lt-accent)' }} />
          实线：上游已完成
        </span>
        <span>
          <i style={{ background: 'transparent', border: '1px dashed var(--lt-border-control)' }} />
          虚线：计划 / 待依赖
        </span>
        <span>
          <i style={{ background: 'var(--lt-info)' }} />
          执行中
        </span>
      </div>
    </div>
  );
}
