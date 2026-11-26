import React, { useState } from 'react';
import { callLtApi, formatDurationMs, formatNumber, type HydratedBundle } from '../lib/api';
import { Icon, type IconName } from '../components/Icon';
import { Splitter, StageHead } from '../components/AppShell';
import { TopologyGraph } from '../components/Charts';
import { Dialog, Drawer } from '../components/Overlays';
import { HeluoxuHorizonMark } from '../components/HeluoxuMark';
import { UnknownValue } from '../components/UnknownValue';
import type { TeamObservation } from '../types/lt-public-v1';

function renderTeamStatusMini(status: TeamObservation['status']) {
  const map: Record<TeamObservation['status'], [string, string, string]> = {
    active: ['run breath', '自主执行', 'var(--lt-info)'],
    paused: ['warn', '治理会议', 'var(--lt-warning)'],
    waiting_user: ['err', '人工升级', 'var(--lt-seal)'],
    completed: ['ok', '已完成', 'var(--lt-success)'],
    idle: ['idle', '空闲', 'var(--lt-fg-muted)'],
  };
  const [dot, label, color] = map[status] || map.idle;
  return (
    <span className="row" style={{ gap: 5, fontSize: 11, color }}>
      <i className={`dot ${dot}`} />
      {label}
    </span>
  );
}

function renderTeamSeal(status: TeamObservation['status']) {
  if (status === 'paused') return <span className="seal warning">治理会议</span>;
  if (status === 'waiting_user') return <span className="seal solid">人工升级</span>;
  if (status === 'completed') return <span className="seal success">已完成</span>;
  if (status === 'idle') return <span className="seal info">待命</span>;
  return <span className="seal info">自主执行</span>;
}

export function TeamsView({
  bundle,
  initialSub,
  ctxOpen = true,
  onToggleCtx,
  onRefreshBundle,
  onOpenSession,
  onNavigateSub,
  onNotify,
}: {
  bundle: HydratedBundle;
  initialSub?: string | null;
  ctxOpen?: boolean;
  onToggleCtx?: () => void;
  onRefreshBundle: () => Promise<void>;
  onOpenSession?: (sessionId: string) => void;
  onNavigateSub?: (sub: string | null) => void;
  onNotify?: (message: string, icon?: IconName) => void;
}) {
  const teams = bundle.runtime.teams || [];
  const archive = bundle.runtime.planArchive;
  const archiveEnabled = Boolean(bundle.capabilities.features.planArchive && archive?.enabled);

  const [section, setSection] = useState<'teams' | 'archive'>(
    initialSub === 'archive' && archiveEnabled ? 'archive' : 'teams',
  );
  const [selectedTeamId, setSelectedTeamId] = useState<string>(teams[0]?.teamId || '');
  const [detailTab, setDetailTab] = useState<'topology' | 'scope' | 'reviews' | 'calls'>('topology');

  // Plan archive search, retrospective drawer, and dryRun cleanup dialog
  const [archiveQuery, setArchiveQuery] = useState('');
  const [activePlan, setActivePlan] = useState<Record<string, any> | null>(null);
  const [retroNotes, setRetroNotes] = useState('');
  const [showCleanupDialog, setShowCleanupDialog] = useState(false);
  const [cleanDays, setCleanDays] = useState('21');
  const [cleanPreview, setCleanPreview] = useState<{ matchedCount: number; dryRun: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);

  const activeSection = initialSub === 'archive' && archiveEnabled ? 'archive' : section;
  const team = teams.find(t => t.teamId === selectedTeamId) || teams[0] || null;
  const sc = bundle.runtime.scheduler;
  const effCap = sc.effectiveCap ?? sc.maxActiveMembers;
  const schedPct = effCap > 0 ? Math.min(100, Math.round((sc.activeExecutionMembers / effCap) * 100)) : 0;

  async function handleRetrospect(planId: string) {
    setBusy(true);
    setArchiveError(null);
    try {
      const res = await callLtApi<{ retrospective: { retroId: string; verdict: string } }>('archive/action', {
        action: 'retrospect',
        planId,
        notes: retroNotes,
      });
      setRetroNotes('');
      setActivePlan(null);
      if (onNotify) {
        onNotify(`已生成复盘 ${res.retrospective.retroId}（${res.retrospective.verdict}）`, 'check');
      }
      await onRefreshBundle();
    } catch (e: any) {
      setArchiveError(`复盘失败：${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleCleanArchive(confirm: boolean) {
    const rawDays = cleanDays.trim();
    let parsedDays: number | null = null;
    if (rawDays !== '') {
      const n = Number(rawDays);
      if (!Number.isFinite(n) || n < 0) {
        setArchiveError('保留天数必须为大于等于 0 的有效数字');
        return;
      }
      parsedDays = n;
    }
    setBusy(true);
    setArchiveError(null);
    try {
      const res = await callLtApi<{ dryRun: boolean; matchedCount: number; removedCount: number }>(
        'archive/action',
        {
          action: 'clean',
          olderThanDays: parsedDays,
          all: rawDays === '',
          dryRun: !confirm,
          confirm,
        },
      );
      if (res.dryRun) {
        setCleanPreview({ matchedCount: res.matchedCount, dryRun: true });
      } else {
        setShowCleanupDialog(false);
        setCleanPreview(null);
        if (onNotify) onNotify(`已安全清理 ${res.removedCount} 条外部归档计划`, 'trash');
        await onRefreshBundle();
      }
    } catch (e: any) {
      setArchiveError(`清理失败：${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  function switchSection(next: 'teams' | 'archive', teamId?: string) {
    setSection(next);
    if (teamId) setSelectedTeamId(teamId);
    if (onNavigateSub) onNavigateSub(next === 'archive' ? 'archive' : null);
  }

  // Build unique write-scope paths for Scope Matrix
  const allScopePaths = team
    ? Array.from(
        new Set([
          ...team.frontierStages.flatMap(s => s.writeScope || []),
          ...team.members.flatMap(m => m.writeScope || []),
        ]),
      )
    : [];

  const recentPlans = (archive?.recentPlans || []).filter((p: any) => {
    const q = archiveQuery.trim().toLowerCase();
    if (!q) return true;
    const text = `${p.planId || ''} ${p.topic || ''} ${p.title || ''} ${p.category || ''} ${p.summary || ''}`.toLowerCase();
    return text.includes(q);
  });

  return (
    <div className="body" style={{ flex: 1 }}>
      {/* ==================== LEFT CONTEXT PANE ==================== */}
      <aside
        className={`pane pane-context${ctxOpen ? '' : ' is-floating-hidden'}`}
        hidden={!ctxOpen}
        aria-label="团队与归档导航"
      >
        <div className="pane-head">
          <span className="t-subhead" style={{ fontSize: 14 }}>
            团队与治理
          </span>
          <span className="grow" />
          <button
            type="button"
            className="btn btn-ghost btn-icon btn-sm"
            onClick={() => void onRefreshBundle()}
            title="刷新实时态势"
          >
            <Icon name="refresh" className="icon-14" />
          </button>
        </div>

        <div className="pane-body">
          <div className="list-group-label t-overline">团队 ({teams.length})</div>
          <div className="list">
            {teams.length === 0 ? (
              <div className="t-meta" style={{ padding: '10px 10px' }}>
                暂无活跃或历史团队目录
              </div>
            ) : (
              teams.map(t => (
                <button
                  key={t.teamId}
                  type="button"
                  className="list-item"
                  aria-current={activeSection === 'teams' && team?.teamId === t.teamId ? 'true' : undefined}
                  onClick={() => switchSection('teams', t.teamId)}
                >
                  <span className="col grow" style={{ gap: 4 }}>
                    <span className="row">
                      <span className="ellipsis" style={{ fontWeight: 500, fontSize: 'var(--lt-fs-dense)' }}>
                        {t.title || t.teamId}
                      </span>
                    </span>
                    <span className="row" style={{ gap: 6 }}>
                      <span className="mono muted" style={{ fontSize: 10.5 }}>
                        {t.teamId.slice(0, 10)} #{t.taskSeq}
                      </span>
                      <span className="grow" />
                      {renderTeamStatusMini(t.status)}
                    </span>
                  </span>
                </button>
              ))
            )}
          </div>

          {archiveEnabled && (
            <>
              <div className="list-group-label t-overline">归档</div>
              <div className="list">
                <button
                  type="button"
                  className="list-item"
                  aria-current={activeSection === 'archive' ? 'true' : undefined}
                  onClick={() => switchSection('archive')}
                >
                  <Icon name="archive" />
                  <span className="grow" style={{ fontSize: 'var(--lt-fs-dense)' }}>
                    外部计划归档
                  </span>
                  <span className="t-meta num">{(archive?.recentPlans || []).length}</span>
                </button>
              </div>
            </>
          )}
        </div>
      </aside>

      <Splitter which="ctx" hidden={!ctxOpen} />

      {/* ==================== MAIN STAGE ==================== */}
      <main className="stage">
        {activeSection === 'archive' && archiveEnabled ? (
          <>
            <StageHead
              overline="团队与治理"
              title="外部计划归档"
              leading={
                !ctxOpen && onToggleCtx ? (
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon btn-sm"
                    onClick={onToggleCtx}
                    title="展开左侧栏（Ctrl+B）"
                  >
                    <Icon name="panelL" />
                  </button>
                ) : undefined
              }
              right={
                <div className="row" style={{ gap: 8 }}>
                  <label className="search" style={{ width: 220 }}>
                    <Icon name="search" />
                    <input
                      className="input input-sm"
                      placeholder="搜索主题或分类…"
                      value={archiveQuery}
                      onChange={e => setArchiveQuery(e.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    onClick={() => {
                      setCleanPreview(null);
                      setArchiveError(null);
                      setShowCleanupDialog(true);
                    }}
                  >
                    <Icon name="trash" className="icon-14" />
                    按保留期清理…
                  </button>
                </div>
              }
            />
            <div className="stage-body">
              <div className="stage-pad">
                {archive?.root && (
                  <div className="callout" style={{ marginBottom: 16 }}>
                    <Icon name="archive" />
                    <span className="grow">
                      固定外部归档根目录：<span className="mono">{archive.root}</span>（与代码仓物理隔离，支持执行后复盘与安全保留期清理）
                    </span>
                  </div>
                )}

                {recentPlans.length === 0 ? (
                  <div className="empty">
                    <HeluoxuHorizonMark />
                    <h3>暂无归档计划</h3>
                    <p className="t-small" style={{ margin: 0 }}>
                      团队任务完成或收尾后，计划摘要将自动落盘至外部归档目录。
                    </p>
                  </div>
                ) : (
                  <div className="tbl-wrap">
                    <table className="tbl">
                      <thead>
                        <tr>
                          <th>计划 ID</th>
                          <th>主题</th>
                          <th>分类</th>
                          <th>状态</th>
                          <th>复盘</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {recentPlans.map((p: any) => (
                          <tr
                            key={p.planId}
                            className="is-clickable"
                            onClick={() => {
                              setActivePlan(p);
                              setRetroNotes('');
                              setArchiveError(null);
                            }}
                          >
                            <td className="mono muted">{String(p.planId).slice(0, 16)}</td>
                            <td>
                              <b>{p.topic || p.title || p.summary || p.projectKey || '未命名计划'}</b>
                            </td>
                            <td>
                              <span className="badge sm outline">{p.category || 'general'}</span>
                            </td>
                            <td>
                              <span className="badge sm">{p.lifecycleState || 'archived'}</span>
                            </td>
                            <td>
                              {p.retrospectives?.length > 0 || p.hasRetrospective ? (
                                <span className="badge sm success">
                                  <Icon name="check" />
                                  已复盘
                                </span>
                              ) : (
                                <span className="t-meta">—</span>
                              )}
                            </td>
                            <td className="r">
                              <Icon name="chevR" className="icon-14" />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          </>
        ) : (
          <>
            <StageHead
              overline={team ? team.teamId.slice(0, 14) : '团队与治理'}
              title={team ? team.title || `团队 ${team.teamId.slice(0, 12)}` : '团队态势与护栏'}
              leading={
                !ctxOpen && onToggleCtx ? (
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon btn-sm"
                    onClick={onToggleCtx}
                    title="展开左侧栏（Ctrl+B）"
                  >
                    <Icon name="panelL" />
                  </button>
                ) : undefined
              }
              right={
                <div className="row" style={{ gap: 8 }}>
                  {team?.frozenGovernanceHash && (
                    <span className="hash-seal" title={`SHA-256: ${team.frozenGovernanceHash}`}>
                      {team.frozenGovernanceHash.slice(0, 10)}
                    </span>
                  )}
                  {team && renderTeamSeal(team.status)}
                  {team && onOpenSession && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => onOpenSession(team.sessionId || team.teamId)}
                    >
                      <Icon name="chat" className="icon-14" />
                      打开会话
                    </button>
                  )}
                  <button type="button" className="btn btn-sm" onClick={() => void onRefreshBundle()}>
                    <Icon name="refresh" className="icon-14" />
                    刷新态势
                  </button>
                </div>
              }
            />

            <div className="stage-body">
              <div className="stage-pad">
                {/* 3-Card System Guardrails Strip */}
                <div className="grid grid-3" style={{ marginBottom: 24 }}>
                  <div className="card card-pad">
                    <div className="row-between">
                      <span className="row t-meta" style={{ gap: 6 }}>
                        <Icon name="gauge" className="icon-14" />
                        弹性并发调度
                      </span>
                      <span
                        className={`badge sm ${
                          sc.pressureBand === 'high' || sc.pressureBand === 'critical'
                            ? 'warning'
                            : 'success'
                        }`}
                      >
                        {sc.pressureBand}
                      </span>
                    </div>
                    <div className="kpi-value num" style={{ fontSize: 20 }}>
                      {sc.activeExecutionMembers}{' '}
                      <span className="unit">
                        / {effCap} 有效上限 · 配置 {sc.maxActiveMembers}
                      </span>
                    </div>
                    <div className="meter" style={{ marginTop: 8 }}>
                      <span style={{ width: `${schedPct}%` }} />
                    </div>
                  </div>

                  <div className="card card-pad">
                    <div className="row-between">
                      <span className="row t-meta" style={{ gap: 6 }}>
                        <Icon name="battery" className="icon-14" />
                        电源感知收尾
                      </span>
                      <span className={`badge sm ${bundle.runtime.power.latched ? 'warning' : 'outline'}`}>
                        {!bundle.runtime.power.enabled
                          ? '已关闭'
                          : bundle.runtime.power.latched
                            ? '锁存中'
                            : '未触发'}
                      </span>
                    </div>
                    <div className="kpi-value num" style={{ fontSize: 20 }}>
                      {!bundle.runtime.power.enabled ? (
                        '停用'
                      ) : bundle.runtime.power.batteryPct !== null ? (
                        <>
                          {bundle.runtime.power.batteryPct}
                          <span className="unit">% · {bundle.runtime.power.onBattery ? '电池' : '接电'}</span>
                        </>
                      ) : (
                        <>
                          常驻<span className="unit">接电</span>
                        </>
                      )}
                    </div>
                    <div className="t-meta" style={{ marginTop: 8 }}>
                      低于 20% 且使用电池时自动落盘检查点并收尾
                    </div>
                  </div>

                  <div className="card card-pad">
                    <div className="row-between">
                      <span className="row t-meta" style={{ gap: 6 }}>
                        <Icon name="clock" className="icon-14" />5 小时滚动请求窗口
                      </span>
                    </div>
                    <div className="col" style={{ gap: 7, marginTop: 8 }}>
                      {bundle.runtime.requestWindows.length === 0 ? (
                        <div className="t-meta">各供应商 5h 滚动窗口充裕</div>
                      ) : (
                        bundle.runtime.requestWindows.slice(0, 3).map(w => {
                          const pct = w.limit5h ? Math.min(100, (w.used5h / w.limit5h) * 100) : null;
                          return (
                            <div key={w.provider} className="row" style={{ gap: 8, fontSize: 11.5 }}>
                              <span className="ellipsis" style={{ width: 68 }}>
                                {w.provider}
                              </span>
                              <div className={`meter grow${pct !== null && pct >= 70 ? ' warn' : ''}`}>
                                {pct === null ? (
                                  <span className="meter-unknown" style={{ width: '100%' }} title="上限未声明" />
                                ) : (
                                  <span style={{ width: `${pct}%` }} />
                                )}
                              </div>
                              <span
                                className="num muted"
                                style={{ width: 84, textAlign: 'right', whiteSpace: 'nowrap' }}
                              >
                                {w.used5h} / {w.limit5h ?? <UnknownValue reason="上限未声明" />}
                              </span>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                </div>

                {!team ? (
                  <div className="empty">
                    <HeluoxuHorizonMark />
                    <h3>当前暂无活跃团队</h3>
                    <p className="t-small" style={{ maxWidth: 440, margin: 0 }}>
                      在工作台的 Team 模式下启动多代理任务后，可在此检视滚动规划拓扑、成员写域边界、对称双审记录与治理会议时间轴。
                    </p>
                  </div>
                ) : (
                  <>
                    {team.pendingGovernanceUpdate && (
                      <div className="callout info" style={{ marginBottom: 16 }}>
                        <Icon name="info" />
                        <span>
                          全局角色路由已更新；本团队继续保持冻结治理契约一致性，新配置将在新建团队时生效。
                        </span>
                      </div>
                    )}

                    {team.status === 'waiting_user' && (
                      <div className="callout danger" style={{ marginBottom: 16 }}>
                        <Icon name="gavel" />
                        <div className="col grow" style={{ gap: 4 }}>
                          <div className="row" style={{ gap: 8 }}>
                            <b>等待人工升级裁决</b>
                            <span className="seal solid" style={{ height: 20, fontSize: 11 }}>
                              待裁
                            </span>
                          </div>
                          <span className="t-small">
                            请打开关联会话输入裁决意见，或补充指令恢复团队执行。
                          </span>
                        </div>
                        {onOpenSession && (
                          <button
                            type="button"
                            className="btn btn-sm btn-primary"
                            onClick={() => onOpenSession(team.sessionId || team.teamId)}
                          >
                            在会话中指示
                          </button>
                        )}
                      </div>
                    )}

                    {team.status === 'paused' && (
                      <div className="callout warning" style={{ marginBottom: 16 }}>
                        <Icon name="users" />
                        <span>
                          <b>治理会议进行中</b> · 成员已在安全检查点暂停，裁断完成后自动恢复执行。
                        </span>
                      </div>
                    )}

                    {/* Unified KPI Strip */}
                    <div className="kpi-strip" style={{ marginBottom: 20 }}>
                      <div className="kpi">
                        <div className="kpi-label">任务序号</div>
                        <div className="kpi-value num">#{team.taskSeq}</div>
                      </div>
                      <div className="kpi">
                        <div className="kpi-label">项目跨度</div>
                        <div className="kpi-value num">
                          {team.timers ? formatDurationMs(team.timers.projectWallMs) : <UnknownValue reason="无计时记录" />}
                        </div>
                      </div>
                      <div className="kpi">
                        <div className="kpi-label">累计活跃</div>
                        <div className="kpi-value num">
                          {team.timers ? formatDurationMs(team.timers.projectActiveMs) : <UnknownValue reason="无计时记录" />}
                        </div>
                      </div>
                      <div className="kpi">
                        <div className="kpi-label">阶段进度</div>
                        <div className="kpi-value num">
                          {team.frontierStages.filter(s => s.executionState === 'verified').length} /{' '}
                          {team.frontierStages.length}
                        </div>
                      </div>
                      <div className="kpi">
                        <div className="kpi-label">安全门</div>
                        <div className="kpi-value num">{formatNumber(team.gateSummary.reviews)}</div>
                        <div className="kpi-sub">
                          放行 {team.gateSummary.allow} · 拦截 {team.gateSummary.deny}
                        </div>
                      </div>
                    </div>

                    {/* Detail Tabs */}
                    <div className="tabs" role="tablist" style={{ padding: 0, marginBottom: 16 }}>
                      {(
                        [
                          ['topology', '规划拓扑', team.frontierStages.length],
                          ['scope', '成员与写域', team.members.length],
                          ['reviews', '评审与治理', team.governanceEvents.length],
                          ['calls', '角色回执', Object.keys(team.roleReceipts || {}).length],
                        ] as const
                      ).map(([id, label, count]) => (
                        <button
                          key={id}
                          type="button"
                          className="tab"
                          role="tab"
                          aria-selected={detailTab === id}
                          onClick={() => setDetailTab(id)}
                        >
                          {label}
                          <span className="count">{count}</span>
                        </button>
                      ))}
                    </div>

                    {/* Tab 1: Rolling Frontier DAG */}
                    {detailTab === 'topology' && (
                      <div className="card card-pad" style={{ overflow: 'auto' }}>
                        <TopologyGraph stages={team.frontierStages} />
                      </div>
                    )}

                    {/* Tab 2: Members & Write-Scope Matrix */}
                    {detailTab === 'scope' && (
                      <div className="col" style={{ gap: 16 }}>
                        {team.members.length === 0 ? (
                          <div className="card card-pad t-meta">该团队尚未派发子智能体成员。</div>
                        ) : (
                          <>
                            {allScopePaths.length > 0 && (
                              <div className="tbl-wrap">
                                <table className="tbl">
                                  <thead>
                                    <tr>
                                      <th>成员</th>
                                      {allScopePaths.map(p => (
                                        <th key={p} style={{ textAlign: 'center' }}>
                                          <span className="mono" style={{ fontSize: 10.5 }}>
                                            {p}
                                          </span>
                                        </th>
                                      ))}
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {team.members.map(mb => (
                                      <tr key={mb.memberId}>
                                        <td>
                                          <span className="row" style={{ gap: 8 }}>
                                            <b>{mb.name}</b>
                                            <span className="t-meta">{mb.actorRole}</span>
                                          </span>
                                        </td>
                                        {allScopePaths.map(p => {
                                          const canWrite = (mb.writeScope || []).includes(p);
                                          return (
                                            <td key={p} style={{ textAlign: 'center' }}>
                                              {canWrite ? (
                                                <span
                                                  title="可写（写域）"
                                                  style={{
                                                    display: 'inline-block',
                                                    width: 12,
                                                    height: 12,
                                                    borderRadius: 2,
                                                    background: 'var(--lt-accent)',
                                                  }}
                                                />
                                              ) : (
                                                <span
                                                  title="只读"
                                                  style={{
                                                    display: 'inline-block',
                                                    width: 12,
                                                    height: 12,
                                                    borderRadius: 2,
                                                    boxShadow: 'inset 0 0 0 1.5px var(--lt-border-control)',
                                                  }}
                                                />
                                              )}
                                            </td>
                                          );
                                        })}
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            )}
                            <div className="tbl-wrap">
                              <table className="tbl">
                                <thead>
                                  <tr>
                                    <th>成员</th>
                                    <th>阶段</th>
                                    <th>配置模型 / 档位</th>
                                    <th>写域</th>
                                    <th>状态</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {team.members.map(mb => (
                                    <tr key={mb.memberId}>
                                      <td>
                                        <b>{mb.name}</b> <span className="t-meta">{mb.actorRole}</span>
                                      </td>
                                      <td className="mono">{mb.stageId || '—'}</td>
                                      <td className="mono">
                                        {mb.configuredModel} · {mb.effort}
                                      </td>
                                      <td className="mono">
                                        {mb.writeScope.length ? mb.writeScope.join(', ') : '(只读)'}
                                      </td>
                                      <td>
                                        <span className="badge sm outline">{mb.status}</span>
                                        {mb.hasCheckpoint && (
                                          <span className="seal" style={{ marginLeft: 6, height: 18, fontSize: 10 }}>
                                            CKPT
                                          </span>
                                        )}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </>
                        )}
                      </div>
                    )}

                    {/* Tab 3: Reviews & Governance Events Axis */}
                    {detailTab === 'reviews' && (
                      <div className="section">
                        <div className="section-head">
                          <h2>治理与双审事件轴</h2>
                        </div>
                        {team.governanceEvents.length === 0 ? (
                          <div className="card card-pad t-meta">当前无争议或待重试监督项。</div>
                        ) : (
                          <div className="card card-pad">
                            <ol className="axis">
                              {team.governanceEvents.map(ev => {
                                const cls =
                                  ev.kind === 'human_escalation'
                                    ? 'blocked'
                                    : ev.kind === 'conference'
                                      ? 'run'
                                      : 'done';
                                return (
                                  <li key={ev.eventId} className={cls}>
                                    <span className="axis-node" />
                                    <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                                      {ev.at && <span className="num t-meta">{ev.at}</span>}
                                      <span
                                        className={`badge sm ${
                                          ev.kind === 'human_escalation'
                                            ? 'danger'
                                            : ev.kind === 'conference'
                                              ? 'warning'
                                              : 'outline'
                                        }`}
                                      >
                                        {ev.kind}
                                      </span>
                                      <span className="badge sm outline">{ev.status}</span>
                                    </div>
                                    <div className="t-small" style={{ marginTop: 4 }}>
                                      {ev.summary}
                                    </div>
                                  </li>
                                );
                              })}
                            </ol>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Tab 4: Role Call Receipts */}
                    {detailTab === 'calls' && (
                      <div className="tbl-wrap">
                        <table className="tbl">
                          <thead>
                            <tr>
                              <th>角色</th>
                              <th>配置路由</th>
                              <th>实际回执路由</th>
                              <th className="r">调用次数</th>
                              <th className="r">降级次数</th>
                              <th className="r">总 Token</th>
                            </tr>
                          </thead>
                          <tbody>
                            {Object.entries(team.roleReceipts || {}).map(([role, rec]) => (
                              <tr key={role}>
                                <td>
                                  <b>{role}</b>
                                </td>
                                <td className="mono">{rec.configuredRoute}</td>
                                <td className="mono">
                                  {rec.actualRoutes.length ? rec.actualRoutes.join(', ') : '未调用'}
                                </td>
                                <td className="r num">{rec.calls}</td>
                                <td className="r num">
                                  {rec.degradedCalls > 0 ? (
                                    <span style={{ color: 'var(--lt-warning)' }}>{rec.degradedCalls}</span>
                                  ) : (
                                    0
                                  )}
                                </td>
                                <td className="r num">
                                  {rec.totalTokens !== null ? (
                                    formatNumber(rec.totalTokens)
                                  ) : (
                                    <UnknownValue reason="未计量" />
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          </>
        )}
      </main>

      {/* Plan Archive Retrospective Drawer */}
      <Drawer
        open={Boolean(activePlan)}
        onClose={() => setActivePlan(null)}
        title={activePlan?.topic || activePlan?.title || activePlan?.summary || '计划详情与复盘'}
        subtitle={activePlan?.planId}
        leading={<Icon name="archive" />}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setActivePlan(null)}>
              取消
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !activePlan?.planId}
              onClick={() => activePlan && void handleRetrospect(activePlan.planId)}
            >
              {busy ? '生成中…' : '保存并生成复盘'}
            </button>
          </>
        }
      >
        {archiveError && (
          <div className="callout danger" style={{ marginBottom: 14 }}>
            <Icon name="alert" />
            <span>{archiveError}</span>
          </div>
        )}
        {activePlan && (
          <>
            <dl className="kv" style={{ marginBottom: 20 }}>
              <dt>分类</dt>
              <dd>{activePlan.category || 'general'}</dd>
              <dt>状态</dt>
              <dd>{activePlan.lifecycleState || 'archived'}</dd>
              <dt>归档时间</dt>
              <dd className="num">{activePlan.updatedAt || activePlan.createdAt || '—'}</dd>
            </dl>
            <div className="field">
              <label className="label" htmlFor="retro-notes">
                执行后复盘备注
              </label>
              <textarea
                id="retro-notes"
                className="textarea"
                rows={5}
                placeholder="哪些判断被验证？哪些估计偏差？下次如何拆分写域？"
                value={retroNotes}
                onChange={e => setRetroNotes(e.target.value)}
              />
              <span className="hint">复盘将写入外部归档条目，可在后续规划中被检索参考。</span>
            </div>
          </>
        )}
      </Drawer>

      {/* Retention Cleanup 2-step Dry-Run Dialog */}
      <Dialog
        open={showCleanupDialog}
        onClose={() => setShowCleanupDialog(false)}
        title="按保留期清理外部归档"
        footer={
          <>
            <button type="button" className="btn" onClick={() => setShowCleanupDialog(false)}>
              取消
            </button>
            <button
              type="button"
              className="btn btn-danger-solid"
              disabled={busy || !cleanPreview || cleanPreview.matchedCount === 0}
              onClick={() => void handleCleanArchive(true)}
            >
              确认清理 ({cleanPreview?.matchedCount ?? 0} 条)
            </button>
          </>
        }
      >
        {archiveError && (
          <div className="callout danger" style={{ marginBottom: 12 }}>
            <Icon name="alert" />
            <span>{archiveError}</span>
          </div>
        )}
        <div className="row" style={{ gap: 10, marginBottom: 12 }}>
          <label className="label" htmlFor="clean-days-input">
            清理早于
          </label>
          <input
            id="clean-days-input"
            className="input input-sm num"
            style={{ width: 84 }}
            value={cleanDays}
            onChange={e => {
              setCleanDays(e.target.value);
              setCleanPreview(null);
            }}
            placeholder="留空=全部"
          />
          <span className="t-small">天</span>
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            onClick={() => void handleCleanArchive(false)}
          >
            <Icon name="eye" className="icon-14" />
            预览（dryRun）
          </button>
        </div>
        {cleanPreview ? (
          <div className={`callout ${cleanPreview.matchedCount > 0 ? 'warning' : 'info'}`}>
            <Icon name={cleanPreview.matchedCount > 0 ? 'alert' : 'info'} />
            <span>
              预览结果：匹配到 <b>{cleanPreview.matchedCount}</b> 条外部归档计划（尚未删除任何文件）。
            </span>
          </div>
        ) : (
          <div className="callout">
            <Icon name="info" />
            <span>先执行 dryRun 预览将被清理的条目数，确认后才会解锁删除按钮。</span>
          </div>
        )}
      </Dialog>
    </div>
  );
}
