import React, { useCallback, useEffect, useState } from 'react';
import { decompress as fzstdDecompress } from 'fzstd';
// @ts-expect-error Pure JS ESM shared core
import { decodeSessionBytes, parseJsonl, buildReport, defaultPricing } from '@lt-usage-core';
import {
  callLtApi,
  formatClockTime,
  formatCny,
  formatDurationMs,
  formatNumber,
  formatTokensCompact,
  type HydratedBundle,
} from '../lib/api';
import { Icon, type IconName } from '../components/Icon';
import { StageHead } from '../components/AppShell';
import { StackedBars, type StackedBarRow } from '../components/Charts';
import { Drawer } from '../components/Overlays';
import { HeluoxuHorizonMark } from '../components/HeluoxuMark';
import { UnknownValue } from '../components/UnknownValue';

const GROUP_COLORS: Record<string, string> = {
  leader: 'var(--lt-chart-1)',
  execution: 'var(--lt-chart-2)',
  governance: 'var(--lt-chart-3)',
  main: 'var(--lt-chart-1)',
  subagents: 'var(--lt-chart-2)',
  unknown: 'var(--lt-chart-6)',
};

const GROUP_LABELS: Record<string, string> = {
  leader: '主导',
  execution: '执行',
  governance: '治理',
  main: '主会话',
  subagents: '子会话',
  unknown: '未知',
};

function renderTokCompact(n: number | null | undefined) {
  const fmt = formatTokensCompact(n);
  if (!fmt) return <UnknownValue reason="未计量：上游缺失 usage 字段" />;
  return (
    <>
      {fmt.value}
      {fmt.unit && <span className="unit">{fmt.unit}</span>}
    </>
  );
}

function renderStatusBadge(ok: boolean | undefined, status?: string) {
  if (status === 'aborted') return <span className="badge sm warning">中止</span>;
  if (status === 'unknown') return <span className="badge sm outline">未知</span>;
  if (ok === false || status === 'error') return <span className="badge sm danger">失败</span>;
  return <span className="badge sm success">成功</span>;
}

function buildDailyTokenBuckets(calls: any[], rangeDays: number): StackedBarRow[] {
  if (!Array.isArray(calls) || calls.length === 0) return [];
  const now = Date.now();
  const cutoff = now - rangeDays * 86_400_000;
  const byDay = new Map<string, { u: number; r: number; w: number; o: number; unk: number }>();

  for (const c of calls) {
    const t = typeof c.timeMs === 'number' && Number.isFinite(c.timeMs) ? c.timeMs : null;
    if (t !== null && rangeDays > 0 && t < cutoff) continue;
    const d = t ? new Date(t) : null;
    const key = d
      ? `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      : '未知日期';
    const cur = byDay.get(key) || { u: 0, r: 0, w: 0, o: 0, unk: 0 };
    if (c.unmetered) {
      cur.unk += 1;
    } else {
      cur.u += Math.round((c.inputTokens || 0) / 1000);
      cur.r += Math.round((c.cacheReadTokens || 0) / 1000);
      cur.w += Math.round((c.cacheWriteTokens || 0) / 1000);
      cur.o += Math.round((c.outputTokens || 0) / 1000);
    }
    byDay.set(key, cur);
  }

  return Array.from(byDay.entries()).map(([label, v]) => ({
    label,
    values: { u: v.u, r: v.r, w: v.w, o: v.o },
    unknownCount: v.unk,
  }));
}

export function HengzhangView({
  bundle,
  onRefreshBundle,
  onNotify,
  onUsageSummary,
}: {
  bundle: HydratedBundle;
  onRefreshBundle: () => Promise<void>;
  onNotify?: (message: string, icon?: IconName) => void;
  onUsageSummary?: (summary: { costCny: number | null; unknownCount: number }) => void;
}) {
  const [overviewData, setOverviewData] = useState<any>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string>('');
  const [report, setReport] = useState<any>(null);
  const [offlineMode, setOfflineMode] = useState(false);
  const [range, setRange] = useState<'1d' | '7d' | '30d'>('7d');
  const [callFilterGroup, setCallFilterGroup] = useState('all');
  const [callSearch, setCallSearch] = useState('');
  const [page, setPage] = useState(1);
  const [showPricingDrawer, setShowPricingDrawer] = useState(false);
  const [usdToCnyInput, setUsdToCnyInput] = useState('6.71');
  const [newPriceRoute, setNewPriceRoute] = useState('');
  const [newPriceIn, setNewPriceIn] = useState('2');
  const [newPriceCache, setNewPriceCache] = useState('0.2');
  const [newPriceOut, setNewPriceOut] = useState('8');
  const [newPriceCurrency, setNewPriceCurrency] = useState<'CNY' | 'USD'>('CNY');
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const enabled = bundle.usageStatus.enabled;

  const notify = useCallback(
    (msg: string, icon: IconName = 'check') => {
      setNotice(msg);
      if (onNotify) onNotify(msg, icon);
    },
    [onNotify],
  );

  const loadLiveOverview = useCallback(async () => {
    if (!enabled || offlineMode) return;
    try {
      const res = await callLtApi<any>('usage/overview', { syncGateway: true });
      setOverviewData(res);
      if (res?.pricing?.usdToCny) setUsdToCnyInput(String(res.pricing.usdToCny));
      if (!selectedSessionId && res?.overview?.sessions?.length > 0) {
        setSelectedSessionId(res.overview.sessions[0].sessionId);
      }
      if (onUsageSummary && res?.overview?.totals) {
        const t = res.overview.totals;
        onUsageSummary({
          costCny: typeof t.costActualCny?.total === 'number' ? t.costActualCny.total : null,
          unknownCount: (t.unmeteredCalls || 0) + (t.unpricedCalls || 0),
        });
      }
    } catch (e: any) {
      setError(e.message);
    }
  }, [enabled, offlineMode, selectedSessionId, onUsageSummary]);

  const loadLiveReport = useCallback(
    async (sid: string) => {
      if (!sid || !enabled || offlineMode) return;
      try {
        const res = await callLtApi<any>('usage/report', { sessionId: sid, syncGateway: true });
        setReport(res?.report || null);
        setPage(1);
      } catch (e: any) {
        setError(e.message);
      }
    },
    [enabled, offlineMode],
  );

  useEffect(() => {
    void loadLiveOverview();
  }, [loadLiveOverview]);

  useEffect(() => {
    if (selectedSessionId && !offlineMode) {
      void loadLiveReport(selectedSessionId);
    }
  }, [selectedSessionId, offlineMode, loadLiveReport]);

  async function handleToggleEnabled(next: boolean) {
    setBusy(true);
    setError(null);
    try {
      await callLtApi('usage/toggle', { enabled: next });
      if (!next) {
        setReport(null);
        setOverviewData(null);
      }
      await onRefreshBundle();
      notify(
        next ? '已开启衡账非阻塞实时统计' : '已关闭衡账实时统计（工作台与网关不受影响）',
        next ? 'check' : 'info',
      );
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function decodeLocalFile(file: File) {
    setError(null);
    setNotice(null);
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const text =
        file.name.endsWith('.zstd') || file.name.endsWith('.zst')
          ? decodeSessionBytes(buf, (frame: Uint8Array) => fzstdDecompress(frame))
          : new TextDecoder('utf-8').decode(buf);
      const rows = parseJsonl(text);
      const header = rows.find((r: any) => r?.type === 'session') || { id: file.name, cwd: '(离线导入)' };
      const built = buildReport({
        sessionId: header.id || file.name,
        kind: 'session',
        sessions: [{ id: header.id || file.name, header, rows }],
        pricing: overviewData?.pricing || defaultPricing,
      });
      setOfflineMode(true);
      setReport(built);
      setPage(1);
      notify(`已在本地纯离线解析 ${file.name}（共 ${built.calls.length} 笔逻辑请求，零文件上传）`, 'check');
    } catch (err: any) {
      setError(`离线解码失败：${err.message}`);
    }
  }

  async function handleSaveCustomPrice(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const curPricing = structuredClone(overviewData?.pricing || defaultPricing);
      curPricing.usdToCny = Number(usdToCnyInput) || 6.71;
      if (newPriceRoute.trim()) {
        const rate = {
          inputPerM: Number(newPriceIn) || 0,
          cacheReadPerM: Number(newPriceCache) || 0,
          cacheWritePerM: 0,
          outputPerM: Number(newPriceOut) || 0,
        };
        curPricing.routes[newPriceRoute.trim()] = {
          currency: newPriceCurrency,
          peak: rate,
          offPeak: null,
          peakRule: null,
        };
      }
      await callLtApi('usage/pricing', { pricing: curPricing });
      setNewPriceRoute('');
      setShowPricingDrawer(false);
      await loadLiveOverview();
      if (selectedSessionId) await loadLiveReport(selectedSessionId);
      notify('路由单价已保存并重算账本', 'check');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function exportJson() {
    if (!report) return;
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const objUrl = URL.createObjectURL(blob);
    try {
      const a = document.createElement('a');
      a.href = objUrl;
      a.download = `hengzhang-${report.meta?.sessionId || 'report'}.json`;
      a.click();
    } finally {
      setTimeout(() => URL.revokeObjectURL(objUrl), 0);
    }
  }

  function exportCsv() {
    if (!report) return;
    const header = [
      'n',
      'timeMs',
      'group',
      'actor',
      'role',
      'taskSeq',
      'step',
      'requestedRoute',
      'actualProvider',
      'actualModel',
      'physicalAttempts',
      'latencyMs',
      'ok',
      'inputTokens',
      'cacheReadTokens',
      'cacheWriteTokens',
      'outputTokens',
      'totalTokens',
      'costPeakCny',
      'costActualCny',
    ];
    const lines = [header.join(',')];
    for (const c of report.calls || []) {
      lines.push(
        [
          c.n,
          c.timeMs ?? '',
          c.group,
          JSON.stringify(c.actor ?? ''),
          JSON.stringify(c.role ?? ''),
          c.taskSeq ?? '',
          c.step,
          JSON.stringify(c.route ?? ''),
          JSON.stringify(c.actualProvider ?? 'unknown'),
          JSON.stringify(c.actualModel ?? 'unknown'),
          c.physicalAttempts ?? '',
          c.latencyMs ?? '',
          c.ok,
          c.unmetered ? '' : c.inputTokens,
          c.unmetered ? '' : c.cacheReadTokens,
          c.unmetered ? '' : c.cacheWriteTokens,
          c.unmetered ? '' : c.outputTokens,
          c.unmetered ? '' : c.totalTokens,
          c.costPeakCny != null ? c.costPeakCny.toFixed(6) : '',
          c.costActualCny != null ? c.costActualCny.toFixed(6) : '',
        ].join(','),
      );
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const objUrl = URL.createObjectURL(blob);
    try {
      const a = document.createElement('a');
      a.href = objUrl;
      a.download = `hengzhang-${report.meta?.sessionId || 'calls'}.csv`;
      a.click();
    } finally {
      setTimeout(() => URL.revokeObjectURL(objUrl), 0);
    }
  }

  const rangeDays = range === '1d' ? 1 : range === '30d' ? 30 : 7;
  const totals = report?.totals || null;
  const bucketUncached = totals?.inputTokens ?? 0;
  const bucketCacheRead = totals?.cacheReadTokens ?? 0;
  const bucketCacheWrite = totals?.cacheWriteTokens ?? 0;
  const bucketOutput = totals?.outputTokens ?? 0;
  const bucketTotal = Math.max(1, bucketUncached + bucketCacheRead + bucketCacheWrite + bucketOutput);
  const tokenBuckets = [
    { key: 'u', label: '新增输入', value: bucketUncached, color: 'var(--lt-chart-1)' },
    { key: 'r', label: '缓存读', value: bucketCacheRead, color: 'var(--lt-chart-3)' },
    { key: 'w', label: '缓存写', value: bucketCacheWrite, color: 'var(--lt-chart-6)' },
    { key: 'o', label: '输出', value: bucketOutput, color: 'var(--lt-chart-2)' },
  ];

  const dailyRows = buildDailyTokenBuckets(report?.calls || [], rangeDays);
  const byModel: any[] = report?.byModel || [];
  const maxModelCost = Math.max(0.0001, ...byModel.map(m => (typeof m.costActualCny === 'number' ? m.costActualCny : 0)));
  const byGroup: any[] = report?.groups || [];
  const totalGroupTokens = Math.max(1, byGroup.reduce((s, g) => s + (g.totalTokens || 0), 0));

  const filteredCalls = (report?.calls || []).filter((c: any) => {
    if (callFilterGroup !== 'all' && c.group !== callFilterGroup) return false;
    if (!callSearch.trim()) return true;
    const q = callSearch.trim().toLowerCase();
    return (
      String(c.route || '').toLowerCase().includes(q) ||
      String(c.actualProvider || '').toLowerCase().includes(q) ||
      String(c.actualModel || '').toLowerCase().includes(q) ||
      String(c.actor || '').toLowerCase().includes(q)
    );
  });
  const pageSize = 30;
  const totalPages = Math.max(1, Math.ceil(filteredCalls.length / pageSize));
  const pagedCalls = filteredCalls.slice((page - 1) * pageSize, page * pageSize);

  const watermarkTime = bundle.usageStatus.lastSyncAt
    ? bundle.usageStatus.lastSyncAt.slice(11, 16)
    : '未同步';
  const allCalls = report?.calls || [];
  const successCalls = allCalls.filter((c: any) => c.ok !== false).length;
  const successRatePct =
    allCalls.length > 0 ? ((successCalls / allCalls.length) * 100).toFixed(1) : null;
  const unknownTotal = (totals?.unmeteredCalls || 0) + (totals?.unpricedCalls || 0);

  return (
    <div className="body" style={{ flex: 1 }}>
      <main className="stage">
        <StageHead
          overline="用量与成本"
          title="衡账"
          right={
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={enabled}
                  disabled={busy}
                  onChange={e => void handleToggleEnabled(e.target.checked)}
                />
                <span className="track" />
                统计
              </label>

              {bundle.capabilities.features.usageOfflineImport && (
                <label className="btn btn-sm" style={{ cursor: 'pointer' }}>
                  <Icon name="upload" className="icon-14" />
                  离线导入 .zstd
                  <input
                    type="file"
                    accept=".zstd,.zst,.jsonl"
                    style={{ display: 'none' }}
                    onChange={e => {
                      const f = e.target.files?.[0];
                      if (f) void decodeLocalFile(f);
                    }}
                  />
                </label>
              )}

              {offlineMode && (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    setOfflineMode(false);
                    void loadLiveOverview();
                  }}
                >
                  返回实时统计
                </button>
              )}

              {(enabled || offlineMode) && (
                <>
                  <span style={{ width: 1, height: 20, background: 'var(--lt-border-subtle)' }} />
                  <div className="seg seg-sm" role="radiogroup" aria-label="统计时间窗口">
                    {(
                      [
                        ['1d', '今天'],
                        ['7d', '7 天'],
                        ['30d', '30 天'],
                      ] as const
                    ).map(([id, lbl]) => (
                      <button
                        key={id}
                        type="button"
                        aria-pressed={range === id}
                        onClick={() => setRange(id)}
                      >
                        {lbl}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busy || offlineMode}
                    title="手动同步用量水位"
                    onClick={() => {
                      void loadLiveOverview();
                      if (selectedSessionId) void loadLiveReport(selectedSessionId);
                      notify('已触发水位同步', 'refresh');
                    }}
                  >
                    <Icon name="refresh" className="icon-14" />
                    水位 <span className="num">{watermarkTime}</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setShowPricingDrawer(true)}
                  >
                    <Icon name="sliders" className="icon-14" />
                    单价
                  </button>
                </>
              )}
            </div>
          }
        />

        <div
          className="stage-body"
          onDragOver={e => {
            if (!bundle.capabilities.features.usageOfflineImport) return;
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={e => {
            if (!bundle.capabilities.features.usageOfflineImport) return;
            e.preventDefault();
            setDragOver(false);
            const f = e.dataTransfer.files?.[0];
            if (f) void decodeLocalFile(f);
          }}
        >
          {!enabled && !offlineMode ? (
            <div className="empty" style={{ height: '72%' }}>
              <HeluoxuHorizonMark />
              <h3>衡账已关闭</h3>
              <p className="t-small" style={{ maxWidth: 440, margin: 0 }}>
                关闭时不进行任何后台拉取，工作台与网关推理不受影响。重新开启后将从上次水位补齐统计，或直接拖入本地 <code>.jsonl.zstd</code> 进行纯浏览器离线解析。
              </p>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() => void handleToggleEnabled(true)}
              >
                开启统计
              </button>
            </div>
          ) : (
            <div className="stage-pad" style={{ maxWidth: 1320 }}>
              {dragOver && (
                <div className="dropzone is-dragover" style={{ marginBottom: 14, textAlign: 'center' }}>
                  松开以在浏览器本地解码 <code>.jsonl.zstd</code> / <code>.jsonl</code> 会话账本（零上传）
                </div>
              )}
              {error && (
                <div className="callout danger" style={{ marginBottom: 14 }}>
                  <Icon name="alert" />
                  <span className="grow">{error}</span>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setError(null)}>
                    关闭
                  </button>
                </div>
              )}
              {notice && (
                <div className="callout info" style={{ marginBottom: 14 }}>
                  <Icon name="info" />
                  <span className="grow">{notice}</span>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setNotice(null)}>
                    关闭
                  </button>
                </div>
              )}

              {!report ? (
                <div className="empty" style={{ padding: '64px 24px' }}>
                  <HeluoxuHorizonMark />
                  <h3>暂无可展示的会话账本</h3>
                  <p className="t-small" style={{ maxWidth: 440, margin: 0 }}>
                    在工作台运行一次对话，或点击右上角「离线导入 .zstd」即可查看四桶 Token 分布、峰谷成本与逐笔归因账本。
                  </p>
                </div>
              ) : (
                <>
                  {/* Unified KPI Strip */}
                  <div className="kpi-strip" style={{ marginBottom: 16 }}>
                    <div className="kpi">
                      <div className="kpi-label">逻辑调用</div>
                      <div className="kpi-value num">{formatNumber(totals.callsTotal)}</div>
                      <div className="kpi-sub">
                        成功率 <span className="num">{successRatePct !== null ? `${successRatePct}%` : '—'}</span>
                      </div>
                    </div>

                    <div className="kpi" style={{ gridColumn: 'span 2' }}>
                      <div className="kpi-label">
                        总 Token{' '}
                        <span className="t-meta mono" style={{ fontSize: 10 }}>
                          = 新增输入 + 缓存读 + 缓存写 + 输出
                        </span>
                      </div>
                      <div className="kpi-value num">{renderTokCompact(totals.totalTokens)}</div>
                      <div className="meter" style={{ height: 8, marginTop: 8 }}>
                        {tokenBuckets.map(b => (
                          <span
                            key={b.key}
                            style={{
                              width: `${((b.value / bucketTotal) * 100).toFixed(2)}%`,
                              background: b.color,
                            }}
                          />
                        ))}
                      </div>
                      <div className="legend" style={{ marginTop: 6 }}>
                        {tokenBuckets.map(b => (
                          <span key={b.key}>
                            <i style={{ background: b.color }} />
                            {b.label} <b className="num">{renderTokCompact(b.value)}</b>
                          </span>
                        ))}
                        {totals.reasoningTokens != null && (
                          <span className="muted">
                            推理 {renderTokCompact(totals.reasoningTokens)}（含于输出）
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="kpi">
                      <div className="kpi-label">缓存命中率</div>
                      <div className="kpi-value num" style={{ color: 'var(--lt-success)' }}>
                        {totals.cacheHitRatePct != null ? `${totals.cacheHitRatePct}%` : <UnknownValue />}
                      </div>
                      <div className="kpi-sub">缓存读 / 全部输入</div>
                    </div>

                    <div className="kpi">
                      <div className="kpi-label">实际费用</div>
                      <div className="kpi-value num">
                        {totals.costActualCny?.total != null ? (
                          formatCny(totals.costActualCny.total)
                        ) : (
                          <UnknownValue reason="未定价：缺少匹配单价，不以 ¥0 计" />
                        )}
                      </div>
                      <div className="kpi-sub">
                        刊例峰值{' '}
                        <span className="num">
                          {totals.costPeakCny?.total != null ? formatCny(totals.costPeakCny.total) : '—'}
                        </span>
                        {typeof totals.cacheSavingsCny === 'number' && totals.cacheSavingsCny > 0 && (
                          <>
                            {' · '}
                            <span className="up num">省 {formatCny(totals.cacheSavingsCny)}</span>
                          </>
                        )}
                      </div>
                    </div>

                    <div className="kpi">
                      <div className="kpi-label" style={{ color: unknownTotal > 0 ? 'var(--lt-warning)' : undefined }}>
                        <Icon name="alert" className="icon-14" />
                        未知
                      </div>
                      <div
                        className="kpi-value num"
                        style={{ color: unknownTotal > 0 ? 'var(--lt-warning)' : undefined }}
                      >
                        {unknownTotal}
                      </div>
                      <div className="kpi-sub">
                        未计量 <span className="num">{totals.unmeteredCalls || 0}</span> · 未定价{' '}
                        <span className="num">{totals.unpricedCalls || 0}</span> · 不计为 0
                      </div>
                    </div>
                  </div>

                  {/* 1.6 : 1 Charts Row */}
                  <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1.6fr) minmax(0, 1fr)', marginBottom: 16 }}>
                    <div className="card">
                      <div className="card-head">
                        <h3>每日 Token（千）</h3>
                        <div className="legend">
                          {tokenBuckets.map(b => (
                            <span key={b.key}>
                              <i style={{ background: b.color }} />
                              {b.label}
                            </span>
                          ))}
                          <span>
                            <i
                              style={{
                                background:
                                  'repeating-linear-gradient(135deg, var(--lt-chart-unknown) 0 2px, transparent 2px 4px)',
                              }}
                            />
                            未计量
                          </span>
                        </div>
                      </div>
                      <div className="card-pad">
                        <StackedBars
                          rows={dailyRows}
                          series={tokenBuckets.map(b => ({ key: b.key, label: b.label, color: b.color }))}
                          ariaLabel="每日 Token 四桶堆叠"
                        />
                      </div>
                    </div>

                    <div className="card">
                      <div className="card-head">
                        <h3>模型费用</h3>
                        <span className="t-meta">CNY</span>
                      </div>
                      <div className="card-pad">
                        {byModel.length === 0 ? (
                          <div className="t-meta">暂无模型维度汇总</div>
                        ) : (
                          byModel.slice(0, 6).map((m: any) => {
                            const knownCost = typeof m.costActualCny === 'number' && Number.isFinite(m.costActualCny);
                            return (
                              <div key={m.route} className="hbar">
                                <span className="mono ellipsis" title={m.route}>
                                  {m.route}
                                </span>
                                <div className="hbar-track">
                                  {!knownCost ? (
                                    <span className="meter-unknown" style={{ width: '100%' }} title="未定价" />
                                  ) : (
                                    <span
                                      style={{
                                        width: `${Math.max(2, (m.costActualCny / maxModelCost) * 100)}%`,
                                        background: 'var(--lt-chart-1)',
                                      }}
                                    />
                                  )}
                                </div>
                                <span className="num" style={{ textAlign: 'right' }}>
                                  {!knownCost ? (
                                    <span className="badge sm warning">未定价</span>
                                  ) : (
                                    formatCny(m.costActualCny)
                                  )}
                                </span>
                              </div>
                            );
                          })
                        )}

                        {byGroup.length > 0 && (
                          <>
                            <div className="t-overline" style={{ margin: '18px 0 8px' }}>
                              角色组开销占比
                            </div>
                            <div className="meter" style={{ height: 12 }}>
                              {byGroup.map((g: any) => {
                                const pct = ((g.totalTokens || 0) / totalGroupTokens) * 100;
                                return (
                                  <span
                                    key={g.group || g.label}
                                    style={{
                                      width: `${pct.toFixed(2)}%`,
                                      background: GROUP_COLORS[g.group] || 'var(--lt-chart-4)',
                                    }}
                                  />
                                );
                              })}
                            </div>
                            <div className="legend" style={{ marginTop: 8 }}>
                              {byGroup.map((g: any) => {
                                const pct = Math.round(((g.totalTokens || 0) / totalGroupTokens) * 100);
                                return (
                                  <span key={g.group || g.label}>
                                    <i style={{ background: GROUP_COLORS[g.group] || 'var(--lt-chart-4)' }} />
                                    {GROUP_LABELS[g.group] || g.label || g.group}{' '}
                                    <b className="num">{pct}%</b>
                                  </span>
                                );
                              })}
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Clickable Sessions Overview Table */}
                  {!offlineMode && overviewData?.overview?.sessions?.length > 0 && (
                    <div className="card" style={{ marginBottom: 16 }}>
                      <div className="card-head">
                        <h3>会话 ({overviewData.overview.sessions.length})</h3>
                        <span className="t-meta">点击会话切换下方逐笔账本（子会话已自动去重归并）</span>
                      </div>
                      <div style={{ overflow: 'auto', maxHeight: 240 }}>
                        <table className="tbl">
                          <thead>
                            <tr>
                              <th>会话</th>
                              <th className="r">调用</th>
                              <th className="r">Token</th>
                              <th className="r">费用</th>
                              <th className="r">未知</th>
                            </tr>
                          </thead>
                          <tbody>
                            {overviewData.overview.sessions.map((s: any) => {
                              const unk = (s.unmeteredCalls || 0) + (s.unpricedCalls || 0);
                              return (
                                <tr
                                  key={s.sessionId}
                                  className="is-clickable"
                                  aria-selected={s.sessionId === selectedSessionId ? 'true' : undefined}
                                  onClick={() => setSelectedSessionId(s.sessionId)}
                                >
                                  <td>
                                    <span className="row" style={{ gap: 8 }}>
                                      <span className="ellipsis" style={{ maxWidth: 420 }}>
                                        {s.title || s.sessionId.slice(0, 18)}
                                      </span>
                                      <span className="mono t-meta">{s.sessionId.slice(0, 14)}</span>
                                    </span>
                                  </td>
                                  <td className="r num">{formatNumber(s.callsTotal ?? s.calls)}</td>
                                  <td className="r num">{renderTokCompact(s.totalTokens)}</td>
                                  <td className="r num">
                                    {s.costActualCny != null ? (
                                      formatCny(typeof s.costActualCny === 'object' ? s.costActualCny.total : s.costActualCny)
                                    ) : (
                                      <UnknownValue reason="含未定价调用" />
                                    )}
                                  </td>
                                  <td className="r num">
                                    {unk > 0 ? (
                                      <span style={{ color: 'var(--lt-warning)' }}>{unk}</span>
                                    ) : (
                                      <span className="muted">0</span>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* Full 14-Column Call Ledger */}
                  <div className="card">
                    <div className="card-head" style={{ flexWrap: 'wrap' }}>
                      <h3>
                        逐笔账本 ·{' '}
                        <span className="mono" style={{ fontWeight: 500 }}>
                          {report.meta?.sessionId || selectedSessionId || '离线报告'}
                        </span>
                        <span className="t-meta num" style={{ marginLeft: 8, fontWeight: 400 }}>
                          ({filteredCalls.length} 笔)
                        </span>
                      </h3>
                      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                        <label className="search" style={{ width: 200 }}>
                          <Icon name="search" />
                          <input
                            className="input input-sm"
                            placeholder="筛选路由 / 供应商 / 成员…"
                            value={callSearch}
                            onChange={e => {
                              setCallSearch(e.target.value);
                              setPage(1);
                            }}
                          />
                        </label>
                        <select
                          className="select select-sm"
                          style={{ width: 132 }}
                          value={callFilterGroup}
                          onChange={e => {
                            setCallFilterGroup(e.target.value);
                            setPage(1);
                          }}
                        >
                          <option value="all">全部组别</option>
                          <option value="leader">主导 (leader)</option>
                          <option value="execution">执行 (execution)</option>
                          <option value="governance">治理 (governance)</option>
                          <option value="main">主会话 (main)</option>
                          <option value="subagents">子会话 (subagents)</option>
                        </select>
                        <button type="button" className="btn btn-sm btn-ghost" onClick={exportCsv}>
                          <Icon name="download" className="icon-14" />
                          导出 CSV
                        </button>
                        <button type="button" className="btn btn-sm btn-ghost" onClick={exportJson}>
                          <Icon name="download" className="icon-14" />
                          导出 JSON
                        </button>
                      </div>
                    </div>

                    <div style={{ overflow: 'auto' }}>
                      <table className="tbl">
                        <thead>
                          <tr>
                            <th className="r">#</th>
                            <th>时间</th>
                            <th>角色 / 成员</th>
                            <th className="r">任务</th>
                            <th>请求路由</th>
                            <th>实际上游</th>
                            <th className="r">尝试</th>
                            <th className="r">耗时</th>
                            <th className="r">新增输入</th>
                            <th className="r">缓存读</th>
                            <th className="r">缓存写</th>
                            <th className="r">输出</th>
                            <th className="r">费用</th>
                            <th>状态</th>
                          </tr>
                        </thead>
                        <tbody>
                          {pagedCalls.map((c: any) => {
                            const isUnknownProv = !c.actualProvider || c.actualProvider === 'unknown';
                            return (
                              <tr key={c.n}>
                                <td className="r num muted">{c.n}</td>
                                <td className="num">{formatClockTime(c.timeMs) || '—'}</td>
                                <td>
                                  <span className="row" style={{ gap: 6 }}>
                                    <span>{c.actor || c.role || '—'}</span>
                                    <span className="badge sm outline">{GROUP_LABELS[c.group] || c.group}</span>
                                  </span>
                                </td>
                                <td className="r num">
                                  {c.taskSeq !== null && c.taskSeq !== undefined ? (
                                    `#${c.taskSeq}`
                                  ) : (
                                    <UnknownValue reason="非团队轮次或未关联任务序号" />
                                  )}
                                </td>
                                <td className="mono">{c.route || '—'}</td>
                                <td className="mono">
                                  {isUnknownProv ? (
                                    <span className="badge sm outline" title="上游未揭示，不猜测归属">
                                      unknown
                                    </span>
                                  ) : (
                                    `${c.actualProvider} / ${c.actualModel || 'unknown'}`
                                  )}
                                </td>
                                <td className="r num">
                                  {c.physicalAttempts == null ? (
                                    <UnknownValue reason="无物理尝试次数记录" />
                                  ) : c.physicalAttempts > 1 ? (
                                    <span style={{ color: 'var(--lt-warning)' }}>{c.physicalAttempts}</span>
                                  ) : (
                                    c.physicalAttempts
                                  )}
                                </td>
                                <td className="r num">
                                  {c.latencyMs != null ? (
                                    formatDurationMs(c.latencyMs)
                                  ) : (
                                    <UnknownValue reason="无耗时记录" />
                                  )}
                                </td>
                                <td className="r num">
                                  {c.unmetered ? (
                                    <UnknownValue reason="未计量：上游未返回 usage" />
                                  ) : (
                                    formatNumber(c.inputTokens)
                                  )}
                                </td>
                                <td className="r num">
                                  {c.unmetered ? (
                                    <UnknownValue reason="未计量：上游未返回 usage" />
                                  ) : (
                                    formatNumber(c.cacheReadTokens)
                                  )}
                                </td>
                                <td className="r num">
                                  {c.unmetered ? (
                                    <UnknownValue reason="未计量：上游未返回 usage" />
                                  ) : (
                                    formatNumber(c.cacheWriteTokens)
                                  )}
                                </td>
                                <td className="r num">
                                  {c.unmetered ? (
                                    <UnknownValue reason="未计量：上游未返回 usage" />
                                  ) : (
                                    formatNumber(c.outputTokens)
                                  )}
                                </td>
                                <td className="r num">
                                  {c.unmetered ? (
                                    <UnknownValue reason="未计量，无法计算费用" />
                                  ) : c.costActualCny != null ? (
                                    formatCny(c.costActualCny)
                                  ) : (
                                    <UnknownValue reason="未定价：缺少单价，不以 ¥0 计" />
                                  )}
                                </td>
                                <td>{renderStatusBadge(c.ok, c.status)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>

                    {totalPages > 1 && (
                      <div className="card-pad hairline-top row" style={{ justifyContent: 'flex-end', gap: 8 }}>
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={page <= 1}
                          onClick={() => setPage(p => p - 1)}
                        >
                          上一页
                        </button>
                        <span className="t-meta num">
                          第 {page} / {totalPages} 页
                        </span>
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={page >= totalPages}
                          onClick={() => setPage(p => p + 1)}
                        >
                          下一页
                        </button>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </main>

      {/* Pricing Override Slide-Over Drawer */}
      <Drawer
        open={showPricingDrawer}
        onClose={() => setShowPricingDrawer(false)}
        title="路由单价覆盖"
        subtitle="仅保存在 storageRoot/usage/custom-pricing.json，不篡改原始会话"
        leading={<Icon name="sliders" />}
        footer={
          <>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() =>
                void callLtApi('usage/pricing', { action: 'reset' }).then(() => {
                  setShowPricingDrawer(false);
                  void loadLiveOverview();
                  notify('已恢复默认校准价格', 'rollback');
                })
              }
            >
              恢复默认单价
            </button>
            <button type="button" className="btn" onClick={() => setShowPricingDrawer(false)}>
              取消
            </button>
            <button type="submit" form="hz-pricing-form" className="btn btn-primary" disabled={busy}>
              保存并重算
            </button>
          </>
        }
      >
        <div className="callout" style={{ marginBottom: 16 }}>
          <Icon name="info" />
          <span>
            价格来源优先级：自定义 &gt; 网关 &gt; 目录。未定价路由在报表中严格显示为「— / 未定价」，绝不伪造为 ¥0。
          </span>
        </div>
        <form id="hz-pricing-form" className="col" style={{ gap: 14 }} onSubmit={handleSaveCustomPrice}>
          <div className="grid grid-2">
            <div className="field">
              <label className="label">USD → CNY 汇率</label>
              <input
                className="input num"
                value={usdToCnyInput}
                onChange={e => setUsdToCnyInput(e.target.value)}
              />
            </div>
            <div className="field">
              <label className="label">币种</label>
              <select
                className="select"
                value={newPriceCurrency}
                onChange={e => setNewPriceCurrency(e.target.value as 'CNY' | 'USD')}
              >
                <option value="CNY">CNY (元 / 百万 Token)</option>
                <option value="USD">USD ($ / 百万 Token)</option>
              </select>
            </div>
          </div>

          <div className="field">
            <label className="label">新增或覆盖路由单价</label>
            <input
              className="input mono"
              placeholder="如 deepseek/deepseek-reasoner"
              value={newPriceRoute}
              onChange={e => setNewPriceRoute(e.target.value)}
            />
          </div>

          <div className="grid grid-3">
            <div className="field">
              <label className="label">输入 / 1M</label>
              <input className="input num" value={newPriceIn} onChange={e => setNewPriceIn(e.target.value)} />
            </div>
            <div className="field">
              <label className="label">缓存读 / 1M</label>
              <input className="input num" value={newPriceCache} onChange={e => setNewPriceCache(e.target.value)} />
            </div>
            <div className="field">
              <label className="label">输出 / 1M</label>
              <input className="input num" value={newPriceOut} onChange={e => setNewPriceOut(e.target.value)} />
            </div>
          </div>
          <span className="hint">单位：所选币种 / 百万 Token。</span>
        </form>
      </Drawer>
    </div>
  );
}
