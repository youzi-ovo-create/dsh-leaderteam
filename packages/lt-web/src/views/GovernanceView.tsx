import React, { useState } from 'react';
import { callLtApi, formatDurationMs, formatNumber, type HydratedBundle } from '../lib/api';

export function GovernanceView({
  bundle,
  onRefreshBundle,
}: {
  bundle: HydratedBundle;
  onRefreshBundle: () => Promise<void>;
}) {
  const teams = bundle.runtime.teams || [];
  const [selectedTeamId, setSelectedTeamId] = useState<string>(teams[0]?.teamId || '');
  const [retroNotes, setRetroNotes] = useState('');
  const [cleanDays, setCleanDays] = useState('');
  const [archiveMsg, setArchiveMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const team = teams.find(t => t.teamId === selectedTeamId) || teams[0] || null;
  const archive = bundle.runtime.planArchive;

  async function handleRetrospect(planId: string) {
    setBusy(true);
    setArchiveMsg(null);
    try {
      const res = await callLtApi<{ retrospective: { retroId: string; verdict: string } }>('archive/action', {
        action: 'retrospect',
        planId,
        notes: retroNotes,
      });
      setArchiveMsg(`已生成执行后复盘 ${res.retrospective.retroId}（结论：${res.retrospective.verdict}）`);
      setRetroNotes('');
      await onRefreshBundle();
    } catch (e: any) {
      setArchiveMsg(`复盘失败：${e.message}`);
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
        setArchiveMsg('清理失败：清理天数必须为大于等于 0 的有效数字');
        return;
      }
      parsedDays = n;
    }
    setBusy(true);
    setArchiveMsg(null);
    try {
      const res = await callLtApi<{ dryRun: boolean; matchedCount: number; removedCount: number }>('archive/action', {
        action: 'clean',
        olderThanDays: parsedDays,
        all: rawDays === '',
        dryRun: !confirm,
        confirm,
      });
      setArchiveMsg(
        res.dryRun
          ? `[预览] 匹配到 ${res.matchedCount} 条外部归档计划可清理（未删除文件）`
          : `已安全清理 ${res.removedCount} 条外部归档计划`,
      );
      await onRefreshBundle();
    } catch (e: any) {
      setArchiveMsg(`清理失败：${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="lt-section-header">
        <div>
          <div className="lt-section-kicker">Autonomous Governance & Observability</div>
          <h1 className="lt-section-title">团队成员、滚动规划、有责双审与治理会议</h1>
          <p className="lt-section-desc">
            观察活跃团队的冻结治理契约、成员写域边界、四阶段自主治理（双监督 / 合议庭 / 暂停屏障 / 正式会议）、弹性调度与外部规划归档。
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select
            className="lt-select"
            style={{ width: 280 }}
            value={team?.teamId || ''}
            onChange={e => setSelectedTeamId(e.target.value)}
          >
            {teams.length === 0 ? (
              <option value="">暂无团队记录</option>
            ) : (
              teams.map(t => (
                <option key={t.teamId} value={t.teamId}>
                  {t.title ? `${t.title} (${t.teamId.slice(0, 10)})` : t.teamId}
                </option>
              ))
            )}
          </select>
          <button className="lt-btn" onClick={() => void onRefreshBundle()}>刷新态势</button>
        </div>
      </div>

      {/* System Guardrails KPI Strip */}
      <div className="lt-grid-kpi">
        <div className="lt-card">
          <div className="lt-kpi-label">弹性并发调度 (Scheduler)</div>
          <div className="lt-kpi-value">
            {bundle.runtime.scheduler.activeExecutionMembers} / {bundle.runtime.scheduler.effectiveCap ?? bundle.runtime.scheduler.maxActiveMembers}
          </div>
          <div className="lt-kpi-sub">
            配置上限 {bundle.runtime.scheduler.maxActiveMembers} · 负载带 {bundle.runtime.scheduler.pressureBand.toUpperCase()}
          </div>
        </div>
        <div className="lt-card">
          <div className="lt-kpi-label">电源感知收尾护栏 (Power)</div>
          <div className="lt-kpi-value">
            {!bundle.runtime.power.enabled
              ? '已关闭'
              : bundle.runtime.power.batteryPct !== null
                ? `${bundle.runtime.power.batteryPct}%`
                : '桌面/供电常驻'}
          </div>
          <div className="lt-kpi-sub">
            {bundle.runtime.power.latched ? '低电量锁存中（待用户发令恢复）' : '监控就绪（<=20% 安全落盘检查点）'}
          </div>
        </div>
        <div className="lt-card">
          <div className="lt-kpi-label">5 小时请求窗口 (Request Window)</div>
          <div className="lt-kpi-value">
            {bundle.runtime.requestWindows.length === 0
              ? '充裕'
              : `${bundle.runtime.requestWindows.reduce((s, w) => s + w.used5h, 0)} 次`}
          </div>
          <div className="lt-kpi-sub">
            {bundle.runtime.requestWindows.length === 0
              ? '各供应商 5h 滚动窗口正常'
              : bundle.runtime.requestWindows.map(w => `${w.provider}:${w.used5h}${w.limit5h ? `/${w.limit5h}` : ''}`).join(' · ')}
          </div>
        </div>
        <div className="lt-card">
          <div className="lt-kpi-label">安全门禁累计审查 (Safety Gate)</div>
          <div className="lt-kpi-value">{team ? formatNumber(team.gateSummary.reviews) : '0'}</div>
          <div className="lt-kpi-sub">
            {team ? `放行 ${team.gateSummary.allow} · 拦截 ${team.gateSummary.deny} · 降级回执 ${team.gateSummary.degraded}` : '0ms 沙箱快路 + 独立门禁复核'}
          </div>
        </div>
      </div>

      {team ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {/* Frozen Governance Banner */}
          <div className="lt-card lt-card-authority">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
              <div>
                <span className="lt-seal" style={{ marginRight: 8 }}>FROZEN GOVERNANCE</span>
                <strong>团队 {team.teamId}</strong>
                {team.pendingGovernanceUpdate && (
                  <span className="lt-tag" style={{ marginLeft: 8 }}>全局角色已更新（对新建团队生效，本团队保持冻结一致性）</span>
                )}
              </div>
              <span className="lt-mono" style={{ fontSize: 11.5, color: 'var(--lt-fg-muted)' }}>
                SHA-256: {team.frozenGovernanceHash || '—'}
              </span>
            </div>
            {team.timers && (
              <div className="lt-num" style={{ marginTop: 10, fontSize: 12, color: 'var(--lt-fg-secondary)', display: 'flex', gap: 18, flexWrap: 'wrap' }}>
                <span>总墙钟: <strong>{formatDurationMs(team.timers.projectWallMs)}</strong></span>
                <span>活跃工作: <strong>{formatDurationMs(team.timers.projectActiveMs)}</strong></span>
                <span>当前任务 #{team.taskSeq}: <strong>{formatDurationMs(team.timers.taskWallMs)}</strong></span>
                <span>规划停滞: <strong>{formatDurationMs(team.timers.planningStagnationMs)}</strong></span>
                <span>未通过规划轮次: <strong>{team.timers.unapprovedPlanAttempts}</strong></span>
              </div>
            )}
          </div>

          <div className="lt-grid-2">
            {/* Members & Stages */}
            <div className="lt-card">
              <h2 className="lt-card-title">
                <span>成员执行与写域隔离 ({team.members.length})</span>
                <span className="lt-tag">阶段数 {team.frontierStages.length}</span>
              </h2>
              {team.members.length === 0 ? (
                <div style={{ color: 'var(--lt-fg-muted)', fontSize: 12.5 }}>该团队尚未派发子智能体成员。</div>
              ) : (
                <div className="lt-table-wrap">
                  <table className="lt-table">
                    <thead>
                      <tr>
                        <th>成员</th>
                        <th>阶段</th>
                        <th>模型 / 档位</th>
                        <th>写域 (write_scope)</th>
                        <th>状态</th>
                      </tr>
                    </thead>
                    <tbody>
                      {team.members.map(m => (
                        <tr key={m.memberId}>
                          <td>
                            <strong>{m.name}</strong>
                            <div style={{ fontSize: 11, color: 'var(--lt-fg-muted)' }}>{m.actorRole}</div>
                          </td>
                          <td className="lt-mono">{m.stageId || '—'}</td>
                          <td className="lt-mono" style={{ fontSize: 11.5 }}>{m.configuredModel} · {m.effort}</td>
                          <td className="lt-mono" style={{ fontSize: 11 }}>
                            {m.writeScope.length ? m.writeScope.join(', ') : '(只读)'}
                          </td>
                          <td>
                            <span className="lt-tag">{m.status}</span>
                            {m.hasCheckpoint && <span className="lt-seal" style={{ marginLeft: 4 }}>CKPT</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Role Receipts & Governance Events */}
            <div className="lt-card">
              <h2 className="lt-card-title">
                <span>治理角色调用回执 & 会议记录</span>
                <span className="lt-seal">{team.status.toUpperCase()}</span>
              </h2>
              <div className="lt-table-wrap" style={{ marginBottom: 14 }}>
                <table className="lt-table">
                  <thead>
                    <tr>
                      <th>角色</th>
                      <th>配置路由</th>
                      <th>实际回执路由</th>
                      <th className="lt-right">调用</th>
                      <th className="lt-right">Token</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(team.roleReceipts).map(([role, rec]) => (
                      <tr key={role}>
                        <td><strong>{role}</strong></td>
                        <td className="lt-mono" style={{ fontSize: 11.5 }}>{rec.configuredRoute}</td>
                        <td className="lt-mono" style={{ fontSize: 11.5 }}>
                          {rec.actualRoutes.length ? rec.actualRoutes.join(', ') : '未调用'}
                          {rec.degradedCalls > 0 && <span className="lt-seal" style={{ marginLeft: 4 }}>降级</span>}
                        </td>
                        <td className="lt-right">{rec.calls}</td>
                        <td className="lt-right">{rec.totalTokens !== null ? formatNumber(rec.totalTokens) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div style={{ fontSize: 11, letterSpacing: '0.08em', color: 'var(--lt-fg-muted)', marginBottom: 6 }}>
                最近治理与双审事件 ({team.governanceEvents.length})
              </div>
              {team.governanceEvents.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--lt-fg-muted)' }}>当前无争议或待重试监督项</div>
              ) : (
                <div className="lt-rail-list">
                  {team.governanceEvents.map(ev => (
                    <div key={ev.eventId} className="lt-rail-item">
                      <span
                        className="lt-rail-node"
                        data-state={ev.kind === 'human_escalation' ? 'blocked' : ev.kind === 'conference' ? 'running' : 'verified'}
                      />
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}>
                        <strong className="lt-mono">{ev.kind.toUpperCase()}</strong>
                        <span className="lt-tag">{ev.status}</span>
                      </div>
                      <div style={{ fontSize: 12, marginTop: 3 }}>{ev.summary}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {/* External Plan Archive Section */}
      {archive && archive.enabled && (
        <div className="lt-card" style={{ marginTop: 20 }}>
          <div className="lt-card-title">
            <span>固定外部规划归档与执行后复盘 (Plan Archive)</span>
            <span className="lt-mono" style={{ fontSize: 11, color: 'var(--lt-fg-muted)', fontWeight: 400 }}>
              {archive.root}
            </span>
          </div>
          {archiveMsg && <div className="lt-banner">{archiveMsg}</div>}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
            <input
              className="lt-input"
              style={{ width: 220 }}
              placeholder="复盘附加备注（可选）"
              value={retroNotes}
              onChange={e => setRetroNotes(e.target.value)}
            />
            <input
              className="lt-input lt-num"
              style={{ width: 150 }}
              placeholder="清理早于 N 天"
              value={cleanDays}
              onChange={e => setCleanDays(e.target.value)}
            />
            <button className="lt-btn" disabled={busy} onClick={() => void handleCleanArchive(false)}>
              预览清理 (Dry-Run)
            </button>
            <button className="lt-btn lt-btn-danger" disabled={busy} onClick={() => void handleCleanArchive(true)}>
              确认清理外部归档
            </button>
          </div>
          {(archive.recentPlans || []).length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--lt-fg-muted)' }}>外部归档目录暂无历史计划条目。</div>
          ) : (
            <div className="lt-table-wrap">
              <table className="lt-table">
                <thead>
                  <tr>
                    <th>计划 ID</th>
                    <th>分类</th>
                    <th>状态</th>
                    <th>摘要</th>
                    <th className="lt-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {(archive.recentPlans || []).slice(0, 10).map((p: any) => (
                    <tr key={p.planId}>
                      <td className="lt-mono">{String(p.planId).slice(0, 16)}</td>
                      <td><span className="lt-tag">{p.category || 'general'}</span></td>
                      <td><span className="lt-tag">{p.lifecycleState || 'archived'}</span></td>
                      <td style={{ fontSize: 12 }}>{p.topic || p.title || p.summary || p.projectKey || '—'}</td>
                      <td className="lt-right">
                        <button className="lt-btn lt-btn-sm" disabled={busy} onClick={() => void handleRetrospect(p.planId)}>
                          生成复盘
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
