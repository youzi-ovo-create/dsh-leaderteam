import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as echarts from 'echarts';
import { decompress as fzstdDecompress } from 'fzstd';
// @ts-expect-error Pure JS ESM shared core
import { decodeSessionBytes, parseJsonl, buildReport, defaultPricing } from '@lt-usage-core';
import { callLtApi, formatCny, formatNumber, formatDurationMs, type HydratedBundle } from '../lib/api';

function EChartBox({ option, height = 240 }: { option: echarts.EChartsCoreOption; height?: number }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const chart = echarts.init(el);
    chart.setOption(option);
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart.dispose();
    };
  }, [option]);
  return <div ref={ref} style={{ width: '100%', height }} />;
}

export function HengzhangView({
  bundle,
  onRefreshBundle,
}: {
  bundle: HydratedBundle;
  onRefreshBundle: () => Promise<void>;
}) {
  const [overviewData, setOverviewData] = useState<any>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string>('');
  const [report, setReport] = useState<any>(null);
  const [offlineMode, setOfflineMode] = useState(false);
  const [callFilterGroup, setCallFilterGroup] = useState('all');
  const [callSearch, setCallSearch] = useState('');
  const [page, setPage] = useState(1);
  const [showPricingModal, setShowPricingModal] = useState(false);
  const [usdToCnyInput, setUsdToCnyInput] = useState('6.71');
  const [newPriceRoute, setNewPriceRoute] = useState('');
  const [newPriceIn, setNewPriceIn] = useState('2');
  const [newPriceCache, setNewPriceCache] = useState('0.2');
  const [newPriceOut, setNewPriceOut] = useState('8');
  const [newPriceCurrency, setNewPriceCurrency] = useState<'CNY' | 'USD'>('CNY');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const enabled = bundle.usageStatus.enabled;

  const loadLiveOverview = useCallback(async () => {
    if (!enabled || offlineMode) return;
    try {
      const res = await callLtApi<any>('usage/overview', { syncGateway: true });
      setOverviewData(res);
      if (res?.pricing?.usdToCny) setUsdToCnyInput(String(res.pricing.usdToCny));
      if (!selectedSessionId && res?.overview?.sessions?.length > 0) {
        setSelectedSessionId(res.overview.sessions[0].sessionId);
      }
    } catch (e: any) {
      setError(e.message);
    }
  }, [enabled, offlineMode, selectedSessionId]);

  const loadLiveReport = useCallback(async (sid: string) => {
    if (!sid || !enabled || offlineMode) return;
    try {
      const res = await callLtApi<any>('usage/report', { sessionId: sid, syncGateway: true });
      setReport(res?.report || null);
      setPage(1);
    } catch (e: any) {
      setError(e.message);
    }
  }, [enabled, offlineMode]);

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
      setNotice(next ? '已开启衡账非阻塞实时采集' : '已关闭衡账实时采集（LT 模型调用与网关运行完全不受影响）');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleOfflineFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setNotice(null);
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      let text: string;
      if (file.name.endsWith('.zstd') || file.name.endsWith('.zst')) {
        text = decodeSessionBytes(buf, (frame: Uint8Array) => fzstdDecompress(frame));
      } else {
        text = new TextDecoder('utf-8').decode(buf);
      }
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
      setNotice(`已在浏览器本地纯离线解析 ${file.name}（共 ${built.calls.length} 笔逻辑请求，零文件上传）`);
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
      setShowPricingModal(false);
      await loadLiveOverview();
      if (selectedSessionId) await loadLiveReport(selectedSessionId);
      setNotice('自定义单价表已保存并重算账本');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function exportJson() {
    if (!report) return;
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `hengzhang-${report.meta?.sessionId || 'report'}.json`;
    a.click();
  }

  function exportCsv() {
    if (!report) return;
    const header = [
      'n', 'timeMs', 'group', 'actor', 'role', 'taskSeq', 'step', 'requestedRoute',
      'actualProvider', 'actualModel', 'physicalAttempts', 'latencyMs', 'ok',
      'inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'totalTokens',
      'costPeakCny', 'costActualCny',
    ];
    const lines = [header.join(',')];
    for (const c of report.calls || []) {
      lines.push([
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
      ].join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `hengzhang-${report.meta?.sessionId || 'calls'}.csv`;
    a.click();
  }

  const fgColor = typeof document !== 'undefined'
    ? getComputedStyle(document.documentElement).getPropertyValue('--lt-fg-primary').trim() || '#141619'
    : '#141619';
  const mutedColor = typeof document !== 'undefined'
    ? getComputedStyle(document.documentElement).getPropertyValue('--lt-fg-muted').trim() || '#6E7681'
    : '#6E7681';
  const accentColor = typeof document !== 'undefined'
    ? getComputedStyle(document.documentElement).getPropertyValue('--lt-accent').trim() || '#9C5B2E'
    : '#9C5B2E';

  const groupBarOption: echarts.EChartsCoreOption = {
    tooltip: { trigger: 'axis' },
    grid: { left: 90, right: 24, top: 20, bottom: 28 },
    xAxis: { type: 'value', axisLabel: { color: mutedColor } },
    yAxis: {
      type: 'category',
      data: (report?.groups || []).map((g: any) => g.label),
      axisLabel: { color: fgColor },
    },
    series: [
      {
        name: '未缓存输入',
        type: 'bar',
        stack: 'tok',
        itemStyle: { color: '#2A657C' },
        data: (report?.groups || []).map((g: any) => g.inputTokens),
      },
      {
        name: '缓存读取',
        type: 'bar',
        stack: 'tok',
        itemStyle: { color: accentColor },
        data: (report?.groups || []).map((g: any) => g.cacheReadTokens),
      },
      {
        name: '输出 (含推理)',
        type: 'bar',
        stack: 'tok',
        itemStyle: { color: '#2F6F55' },
        data: (report?.groups || []).map((g: any) => g.outputTokens),
      },
    ],
  };

  const modelDonutOption: echarts.EChartsCoreOption = {
    tooltip: { trigger: 'item' },
    series: [
      {
        type: 'pie',
        radius: ['45%', '72%'],
        label: { color: fgColor, fontSize: 11 },
        data: (report?.byModel || []).map((m: any) => ({
          name: m.route,
          value: m.totalTokens,
        })),
      },
    ],
  };

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

  return (
    <div>
      <div className="lt-section-header">
        <div>
          <div className="lt-section-kicker">Hengzhang Modular Token & Cost Ledger</div>
          <h1 className="lt-section-title">衡账 — 真实用量对账、峰谷成本与网关归因分析</h1>
          <p className="lt-section-desc">
            模块化只读整合 <code>lt-usage-plugin</code>：合并 DSH 多帧 <code>.jsonl.zstd</code>、LT 治理旁路与 Magpie 游标流水；严守「未知 ≠ 0」与非阻塞原则。
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <label className="lt-btn" style={{ cursor: 'pointer' }}>
            离线导入 .zstd / .jsonl
            <input type="file" accept=".zstd,.zst,.jsonl" style={{ display: 'none' }} onChange={handleOfflineFileUpload} />
          </label>
          {offlineMode && (
            <button className="lt-btn" onClick={() => { setOfflineMode(false); void loadLiveOverview(); }}>
              返回实时连接
            </button>
          )}
          <button className="lt-btn" onClick={() => setShowPricingModal(v => !v)}>单价表配置</button>
          <button
            className={`lt-btn ${enabled ? '' : 'lt-btn-primary'}`}
            disabled={busy}
            onClick={() => void handleToggleEnabled(!enabled)}
          >
            {enabled ? '暂停衡账采集' : '启用衡账采集'}
          </button>
        </div>
      </div>

      {error && <div className="lt-banner lt-banner-danger"><span>{error}</span><button className="lt-btn lt-btn-sm" onClick={() => setError(null)}>关闭</button></div>}
      {notice && <div className="lt-banner"><span>{notice}</span><button className="lt-btn lt-btn-sm" onClick={() => setNotice(null)}>关闭</button></div>}

      {showPricingModal && (
        <form className="lt-card" style={{ marginBottom: 16 }} onSubmit={handleSaveCustomPrice}>
          <div className="lt-card-title">
            <span>自定义等效 API 单价表（仅保存在 &lt;storageRoot&gt;/usage/custom-pricing.json，不篡改原始会话）</span>
            <button type="button" className="lt-btn lt-btn-sm" onClick={() => setShowPricingModal(false)}>收起</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 }}>
            <input className="lt-input lt-num" placeholder="USD 汇率 (默认 6.71)" value={usdToCnyInput} onChange={e => setUsdToCnyInput(e.target.value)} />
            <input className="lt-input lt-mono" placeholder="路由 (如 deepseek/deepseek-chat)" value={newPriceRoute} onChange={e => setNewPriceRoute(e.target.value)} />
            <select className="lt-select" value={newPriceCurrency} onChange={e => setNewPriceCurrency(e.target.value as 'CNY' | 'USD')}>
              <option value="CNY">CNY (元 / 百万 Token)</option>
              <option value="USD">USD ($ / 百万 Token)</option>
            </select>
            <input className="lt-input lt-num" placeholder="输入单价 / 1M" value={newPriceIn} onChange={e => setNewPriceIn(e.target.value)} />
            <input className="lt-input lt-num" placeholder="缓存读单价 / 1M" value={newPriceCache} onChange={e => setNewPriceCache(e.target.value)} />
            <input className="lt-input lt-num" placeholder="输出单价 / 1M" value={newPriceOut} onChange={e => setNewPriceOut(e.target.value)} />
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button type="submit" className="lt-btn lt-btn-primary" disabled={busy}>保存单价并重算</button>
            <button
              type="button"
              className="lt-btn"
              onClick={() => void callLtApi('usage/pricing', { action: 'reset' }).then(() => loadLiveOverview())}
            >
              恢复默认校准价格
            </button>
          </div>
        </form>
      )}

      {!enabled && !offlineMode ? (
        <div className="lt-card">
          <strong>衡账实时采集当前已关闭</strong>
          <p style={{ color: 'var(--lt-fg-secondary)', margin: '6px 0 0' }}>
            Leader Team 与 Magpie 的模型推理请求完全独立于衡账运行。您可随时重新启用实时采集，或直接点击右上角「离线导入 .zstd」在纯浏览器端解码分析。
          </p>
        </div>
      ) : (
        <>
          {/* Session Selector Bar */}
          {!offlineMode && overviewData?.overview && (
            <div className="lt-card" style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
              <div className="lt-num" style={{ fontSize: 12.5 }}>
                <strong>全局汇总 ({overviewData.overview.sessions.length} 个根会话，子会话已自动去重归并)：</strong>{' '}
                总计 <strong>{formatNumber(overviewData.overview.totals.totalTokens)}</strong> Token ·{' '}
                实际分时估算 <strong>{formatCny(overviewData.overview.totals.costActualCny?.total)}</strong> ·{' '}
                缓存节省 <strong>{formatCny(overviewData.overview.totals.cacheSavingsCny)}</strong>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <select
                  className="lt-select"
                  style={{ width: 300 }}
                  value={selectedSessionId}
                  onChange={e => setSelectedSessionId(e.target.value)}
                >
                  {overviewData.overview.sessions.length === 0 ? (
                    <option value="">暂无会话账本</option>
                  ) : (
                    overviewData.overview.sessions.map((s: any) => (
                      <option key={s.sessionId} value={s.sessionId}>
                        {s.title || s.sessionId.slice(0, 16)} ({formatNumber(s.totalTokens)} tok)
                      </option>
                    ))
                  )}
                </select>
                <button className="lt-btn lt-btn-sm" onClick={() => void loadLiveOverview()}>刷新对账</button>
              </div>
            </div>
          )}

          {report ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
              {/* Explicit Unknown Warnings */}
              {report.totals.unpricedCalls > 0 && (
                <div className="lt-banner lt-banner-warn">
                  <span>
                    显式未知告警：共 <strong>{report.totals.unpricedCalls}</strong> 次成功调用缺少匹配单价，已严格标记为「未定价 (null)」，绝不伪造为 ¥0。可在「单价表配置」中补充路由单价。
                  </span>
                </div>
              )}
              {report.totals.unmeteredCalls > 0 && (
                <div className="lt-banner lt-banner-warn">
                  <span>
                    显式未知告警：共 <strong>{report.totals.unmeteredCalls}</strong> 次调用缺失上游 usage 字段，已标记为「未计量」，不计为 0。
                  </span>
                </div>
              )}

              {/* Symmetrical Dual-Box Cost & 4-Bucket KPI Strip */}
              <div className="lt-grid-kpi">
                <div className="lt-card lt-card-authority">
                  <div className="lt-kpi-label">实际分时等效成本 (Actual Time-of-Use)</div>
                  <div className="lt-kpi-value">{formatCny(report.totals.costActualCny?.total)}</div>
                  <div className="lt-kpi-sub">
                    折合 ${report.totals.costActualUsd?.toFixed(4)} · 已定价请求汇总
                  </div>
                </div>
                <div className="lt-card">
                  <div className="lt-kpi-label">全高峰假设 / 全低谷假设对照</div>
                  <div className="lt-kpi-value" style={{ fontSize: 18 }}>
                    {formatCny(report.totals.costPeakCny?.total)} / {formatCny(report.totals.costOffPeakCny?.total)}
                  </div>
                  <div className="lt-kpi-sub">北京时间峰谷时段对称核验</div>
                </div>
                <div className="lt-card">
                  <div className="lt-kpi-label">四桶物理总 Token (推理不二次累加)</div>
                  <div className="lt-kpi-value">{formatNumber(report.totals.totalTokens)}</div>
                  <div className="lt-kpi-sub">
                    新增入 {formatNumber(report.totals.inputTokens)} · 缓存读 {formatNumber(report.totals.cacheReadTokens)} · 输出 {formatNumber(report.totals.outputTokens)}
                  </div>
                </div>
                <div className="lt-card">
                  <div className="lt-kpi-label">KV 缓存命中率与节省金额</div>
                  <div className="lt-kpi-value">{report.totals.cacheHitRatePct}%</div>
                  <div className="lt-kpi-sub">
                    节省 {formatCny(report.totals.cacheSavingsCny)} · 逻辑请求 {report.totals.callsTotal} 次
                  </div>
                </div>
              </div>

              {/* Charts Row */}
              <div className="lt-grid-2">
                <div className="lt-card">
                  <h2 className="lt-card-title">层级 Token 构成（主导 / 执行 / 治理）</h2>
                  <EChartBox option={groupBarOption} height={220} />
                </div>
                <div className="lt-card">
                  <h2 className="lt-card-title">模型路由 Token 占比</h2>
                  <EChartBox option={modelDonutOption} height={220} />
                </div>
              </div>

              {/* Provider & Task Attribution Breakdown */}
              <div className="lt-grid-2">
                <div className="lt-card">
                  <h2 className="lt-card-title">真实供应商归因汇总 (byProvider)</h2>
                  <div className="lt-table-wrap">
                    <table className="lt-table">
                      <thead>
                        <tr>
                          <th>实际供应商 (actualProvider)</th>
                          <th className="lt-right">逻辑请求</th>
                          <th className="lt-right">总 Token</th>
                          <th className="lt-right">占比</th>
                          <th className="lt-right">实际成本</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(report.byProvider || []).map((p: any) => (
                          <tr key={p.provider}>
                            <td className="lt-mono">
                              <strong>{p.provider}</strong>
                              {p.provider === 'unknown' && <span className="lt-tag" style={{ marginLeft: 6 }}>未知归因</span>}
                            </td>
                            <td className="lt-right">{p.callsTotal}</td>
                            <td className="lt-right">{formatNumber(p.totalTokens)}</td>
                            <td className="lt-right">{p.shareOfTotalTokensPct}%</td>
                            <td className="lt-right">{p.costActualCny !== null ? formatCny(p.costActualCny) : '未定价'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="lt-card">
                  <h2 className="lt-card-title">任务轮次归属 (byTask · taskSeq)</h2>
                  <div className="lt-table-wrap">
                    <table className="lt-table">
                      <thead>
                        <tr>
                          <th>任务序号</th>
                          <th className="lt-right">请求数</th>
                          <th className="lt-right">总 Token</th>
                          <th className="lt-right">实际成本</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(report.byTask || []).map((t: any, idx: number) => (
                          <tr key={idx}>
                            <td>{t.taskSeq !== null ? `任务 #${t.taskSeq}` : '未知 / 跨轮治理'}</td>
                            <td className="lt-right">{t.callsTotal}</td>
                            <td className="lt-right">{formatNumber(t.totalTokens)}</td>
                            <td className="lt-right">{t.costActualCny !== null ? formatCny(t.costActualCny) : '含未知项'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>

              {/* Detailed Paginated Call Ledger */}
              <div className="lt-card">
                <div className="lt-card-title" style={{ flexWrap: 'wrap' }}>
                  <span>逐笔逻辑请求与网关物理尝试流水 ({filteredCalls.length} 笔)</span>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <input
                      className="lt-input"
                      style={{ width: 200, height: 28 }}
                      placeholder="筛选路由 / 供应商 / 成员…"
                      value={callSearch}
                      onChange={e => { setCallSearch(e.target.value); setPage(1); }}
                    />
                    <select
                      className="lt-select"
                      style={{ width: 130, height: 28 }}
                      value={callFilterGroup}
                      onChange={e => { setCallFilterGroup(e.target.value); setPage(1); }}
                    >
                      <option value="all">全部组别</option>
                      <option value="leader">主导 (leader)</option>
                      <option value="execution">执行 (execution)</option>
                      <option value="governance">治理 (governance)</option>
                      <option value="main">主会话 (main)</option>
                      <option value="subagents">子会话 (subagents)</option>
                    </select>
                    <button className="lt-btn lt-btn-sm" onClick={exportCsv}>导出 CSV</button>
                    <button className="lt-btn lt-btn-sm" onClick={exportJson}>导出 JSON</button>
                  </div>
                </div>

                <div className="lt-table-wrap">
                  <table className="lt-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>组别 / 角色</th>
                        <th>任务</th>
                        <th>请求路由</th>
                        <th>真实供应商 / 模型</th>
                        <th className="lt-right">尝试</th>
                        <th className="lt-right">耗时</th>
                        <th className="lt-right">未缓存入</th>
                        <th className="lt-right">缓存读</th>
                        <th className="lt-right">输出</th>
                        <th className="lt-right">实际成本</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pagedCalls.map((c: any) => (
                        <tr key={c.n}>
                          <td className="lt-mono">{c.n}</td>
                          <td>
                            <strong>{c.actor}</strong>
                            <div style={{ fontSize: 10.5, color: 'var(--lt-fg-muted)' }}>{c.group} · {c.role}</div>
                          </td>
                          <td className="lt-mono">{c.taskSeq !== null ? `#${c.taskSeq}` : '未知'}</td>
                          <td className="lt-mono" style={{ fontSize: 11.5 }}>{c.route}</td>
                          <td className="lt-mono" style={{ fontSize: 11.5 }}>
                            {c.actualProvider} / {c.actualModel}
                          </td>
                          <td className="lt-right lt-mono">{c.physicalAttempts ?? '未知'}</td>
                          <td className="lt-right lt-mono">{c.latencyMs != null ? formatDurationMs(c.latencyMs) : '未知'}</td>
                          <td className="lt-right lt-mono">{c.unmetered ? '未计量' : formatNumber(c.inputTokens)}</td>
                          <td className="lt-right lt-mono">{c.unmetered ? '未计量' : formatNumber(c.cacheReadTokens)}</td>
                          <td className="lt-right lt-mono">{c.unmetered ? '未计量' : formatNumber(c.outputTokens)}</td>
                          <td className="lt-right lt-mono">
                            {!c.ok ? '¥0 (失败)' : c.unmetered ? '未计量' : c.costActualCny != null ? formatCny(c.costActualCny) : '未定价'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {totalPages > 1 && (
                  <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 12 }}>
                    <button className="lt-btn lt-btn-sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>上一页</button>
                    <span className="lt-num">第 {page} / {totalPages} 页</span>
                    <button className="lt-btn lt-btn-sm" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>下一页</button>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="lt-card" style={{ color: 'var(--lt-fg-muted)' }}>
              当前暂无可展示的会话账本。运行一次对话或通过右上角「离线导入 .zstd」即可查看完整峰谷对账与图表。
            </div>
          )}
        </>
      )}
    </div>
  );
}
