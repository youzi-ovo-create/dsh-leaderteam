import React, { useState, useEffect } from 'react';
import { callLtApi, formatNumber, type HydratedBundle } from '../lib/api';
import type { RoleAssignment } from '../types/lt-public-v1';

export function ModelsRolesView({
  bundle,
  onRefreshBundle,
}: {
  bundle: HydratedBundle;
  onRefreshBundle: () => Promise<void>;
}) {
  const [search, setSearch] = useState('');
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const [selectedEntries, setSelectedEntries] = useState<Set<string>>(new Set());
  const [saveTarget, setSaveTarget] = useState<'local' | 'base'>('local');
  const [draftPool, setDraftPool] = useState<string[]>([]);
  const [draftRoles, setDraftRoles] = useState<Record<string, RoleAssignment>>({});
  const [leaderPolicy, setLeaderPolicy] = useState<string>('warn');
  const [isDirty, setIsDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [shadowedByLocal, setShadowedByLocal] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isDirty) return;
    setDraftPool([...(bundle.runtime.modelPool.executionPool || [])]);
    setDraftRoles(structuredClone(bundle.runtime.roleAssignments || {}));
    setLeaderPolicy(bundle.runtime.leaderModelPolicy || 'warn');
  }, [bundle, isDirty]);

  const localOverrides = bundle.runtime.localOverrides || (bundle.runtime.syncState as any)?.localOverrides || null;
  const activeLocalOverrideItems: string[] = [];
  if (localOverrides?.exists) {
    if (localOverrides.executionPool) activeLocalOverrideItems.push('team.executionPool');
    if (localOverrides.leaderModelPolicy) activeLocalOverrideItems.push('team.leaderModelPolicy');
    if (localOverrides.roles?.length) activeLocalOverrideItems.push(`roles(${localOverrides.roles.join(', ')})`);
    if (localOverrides.models?.length) activeLocalOverrideItems.push(`models(${localOverrides.models.join(', ')})`);
  }
  const hasActiveLocalOverrides = activeLocalOverrideItems.length > 0;

  const filteredModels = bundle.models.filter(m => {
    if (sourceFilter !== 'all' && m.sourceKind !== sourceFilter) return false;
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return (
      m.routeId.toLowerCase().includes(q) ||
      m.displayName.toLowerCase().includes(q) ||
      m.providerId.toLowerCase().includes(q) ||
      m.upstreamModelId.toLowerCase().includes(q)
    );
  });

  const poolModels = bundle.models.filter(m => m.inModelPool);

  function toggleEntrySelection(entryId: string) {
    setSelectedEntries(prev => {
      const next = new Set(prev);
      if (next.has(entryId)) next.delete(entryId);
      else next.add(entryId);
      return next;
    });
  }

  function toggleExecutionPoolRoute(routeId: string) {
    setIsDirty(true);
    setDraftPool(prev => (prev.includes(routeId) ? prev.filter(r => r !== routeId) : [...prev, routeId]));
  }

  async function handleSyncMagpieToLt(syncAllMagpie: boolean) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const entryIds = syncAllMagpie ? undefined : [...selectedEntries];
      const res = await callLtApi<{
        syncedCount: number;
        warnings?: string[];
        runtime?: { modelPool?: { executionPool?: string[] } };
      }>('models/sync-pool', {
        entryIds,
        target: saveTarget,
        enableInExecutionPool: true,
      });
      if (isDirty && res.runtime?.modelPool?.executionPool) {
        const syncedPool = res.runtime.modelPool.executionPool;
        setDraftPool(prev => [...new Set([...prev, ...syncedPool])]);
      }
      if (res.warnings?.length) setWarnings(res.warnings);
      setNotice(
        `已将 ${res.syncedCount} 个模型导入 LT 模型目录与执行池（自动完成 off -> "none" 推理档位映射）` +
          (isDirty ? '；已保留当前未保存的角色草稿' : ''),
      );
      setSelectedEntries(new Set());
      await onRefreshBundle();
    } catch (e: any) {
      setError(`同步模型失败：${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  function updateRolePrimary(roleId: string, field: 'route' | 'effort', value: string) {
    setIsDirty(true);
    setDraftRoles(prev => {
      const cur = prev[roleId] || { route: '', effort: 'none', fallback: [] };
      const next: RoleAssignment = { ...cur, [field]: value, fallback: [...(cur.fallback || [])] };
      if (field === 'route') {
        const meta = bundle.models.find(m => m.routeId === value);
        if (meta && !meta.efforts.supported.includes(next.effort)) {
          next.effort = meta.efforts.defaultEffort || meta.efforts.supported[0] || 'none';
        }
      }
      return { ...prev, [roleId]: next };
    });
  }

  function addRoleFallback(roleId: string) {
    setIsDirty(true);
    setDraftRoles(prev => {
      const cur = prev[roleId];
      if (!cur) return prev;
      const fb = [...(cur.fallback || [])];
      if (fb.length >= 4) return prev;
      const usedRoutes = new Set([cur.route, ...fb.map(f => f.route)].filter(Boolean));
      const candidatePool = [...poolModels, ...bundle.models];
      const chosenModel =
        candidatePool.find(m => !usedRoutes.has(m.routeId)) ||
        poolModels[0] ||
        bundle.models[0] ||
        null;
      const firstCandidate = chosenModel?.routeId || '';
      const eff = chosenModel?.efforts.defaultEffort || chosenModel?.efforts.supported?.[0] || 'none';
      fb.push({ route: firstCandidate, effort: eff });
      return { ...prev, [roleId]: { ...cur, fallback: fb } };
    });
  }

  function updateRoleFallback(roleId: string, idx: number, field: 'route' | 'effort', val: string) {
    setIsDirty(true);
    setDraftRoles(prev => {
      const cur = prev[roleId];
      if (!cur) return prev;
      const fb = [...(cur.fallback || [])];
      const item = { ...fb[idx], [field]: val };
      if (field === 'route') {
        const meta = bundle.models.find(m => m.routeId === val);
        if (meta && !meta.efforts.supported.includes(item.effort)) {
          item.effort = meta.efforts.defaultEffort || meta.efforts.supported[0] || 'none';
        }
      }
      fb[idx] = item;
      return { ...prev, [roleId]: { ...cur, fallback: fb } };
    });
  }

  function removeRoleFallback(roleId: string, idx: number) {
    setIsDirty(true);
    setDraftRoles(prev => {
      const cur = prev[roleId];
      if (!cur) return prev;
      return { ...prev, [roleId]: { ...cur, fallback: cur.fallback.filter((_, i) => i !== idx) } };
    });
  }

  async function handleSaveRuntimeConfig() {
    setBusy(true);
    setError(null);
    setNotice(null);
    setWarnings([]);
    setShadowedByLocal([]);
    try {
      const setRoles = bundle.capabilities.supportedRoles
        .map(r => {
          const d = draftRoles[r.roleId];
          if (!d?.route) return null;
          return {
            role: r.roleId,
            route: d.route,
            effort: d.effort || 'none',
            ...(d.maxTokens !== undefined ? { maxTokens: d.maxTokens } : {}),
            ...(r.supportsFallbacks
              ? {
                  ...(d.timeoutMs !== undefined ? { timeoutMs: d.timeoutMs } : {}),
                  ...(d.retries !== undefined ? { retries: d.retries } : {}),
                  fallback: d.fallback || [],
                }
              : {}),
          };
        })
        .filter(Boolean);

      const res = await callLtApi<{
        applyResult?: { shadowedByLocal?: string[]; warnings?: string[] };
        shadowedByLocal?: string[];
        warnings?: string[];
      }>('runtime/configure', {
        target: saveTarget,
        changes: {
          poolSet: draftPool,
          setRoles,
          leaderModelPolicy: leaderPolicy,
        },
      });
      const shadowed = res.shadowedByLocal ?? res.applyResult?.shadowedByLocal ?? [];
      const warns = res.warnings ?? res.applyResult?.warnings ?? [];
      setShadowedByLocal(shadowed);
      setWarnings(warns);
      setIsDirty(false);
      setNotice(
        `已事务化写入 ${saveTarget === 'local' ? 'leaderteam.local.json' : 'leaderteam.config.json + YAML 补丁'}（执行池实时生效，治理角色对新建团队生效）`,
      );
      await onRefreshBundle();
    } catch (e: any) {
      setError(`保存配置失败：${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleClearLocalOverrides() {
    setBusy(true);
    setError(null);
    setNotice(null);
    setWarnings([]);
    setShadowedByLocal([]);
    try {
      await callLtApi('runtime/configure', {
        target: 'local',
        changes: { clearLocalOverrides: true },
      });
      setIsDirty(false);
      setNotice('已清除本机覆盖 (leaderteam.local.json 中的模型、执行池与角色覆盖)，正式基准配置已立即生效');
      await onRefreshBundle();
    } catch (e: any) {
      setError(`清除本机覆盖失败：${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  function effortsForRoute(routeId: string): string[] {
    const found = bundle.models.find(m => m.routeId === routeId);
    return found?.efforts.supported?.length ? found.efforts.supported : ['none', 'off', 'low', 'medium', 'high', 'xhigh', 'max'];
  }

  return (
    <div>
      <div className="lt-section-header">
        <div>
          <div className="lt-section-kicker">Model Catalog & 7-Role Matrix</div>
          <h1 className="lt-section-title">统一模型目录、成员执行池与角色回退链配置</h1>
          <p className="lt-section-desc">
            严格区分供应商、凭据引用、模型来源与上游模型 ID，同名模型绝不自动合并；支持将 Magpie 发现的模型一键加入 LT 模型池并用于旧 Core 七角色配置。
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select className="lt-select" style={{ width: 210 }} value={saveTarget} onChange={e => setSaveTarget(e.target.value as 'local' | 'base')}>
            <option value="local">写入本机覆盖 (leaderteam.local.json)</option>
            <option value="base">写入基准配置 + 同步 YAML 模板</option>
          </select>
          {hasActiveLocalOverrides && (
            <button
              type="button"
              className="lt-btn lt-btn-danger"
              disabled={busy}
              onClick={() => void handleClearLocalOverrides()}
            >
              清除本机覆盖 (Clear Local Overrides)
            </button>
          )}
          {isDirty && (
            <button
              type="button"
              className="lt-btn"
              disabled={busy}
              onClick={() => {
                setIsDirty(false);
                setDraftPool([...(bundle.runtime.modelPool.executionPool || [])]);
                setDraftRoles(structuredClone(bundle.runtime.roleAssignments || {}));
                setLeaderPolicy(bundle.runtime.leaderModelPolicy || 'warn');
              }}
            >
              重置未保存修改
            </button>
          )}
          <button className="lt-btn lt-btn-primary" disabled={busy} onClick={() => void handleSaveRuntimeConfig()}>
            {busy ? '保存中…' : '保存执行池与角色配置'}
          </button>
        </div>
      </div>

      {error && <div className="lt-banner lt-banner-danger"><span>{error}</span><button className="lt-btn lt-btn-sm" onClick={() => setError(null)}>关闭</button></div>}
      {(shadowedByLocal.length > 0 || warnings.length > 0 || (saveTarget === 'base' && hasActiveLocalOverrides)) && (
        <div className="lt-banner lt-banner-warn">
          <div>
            {shadowedByLocal.length > 0 ? (
              <div>
                <strong>注意（本机覆盖遮蔽）：</strong>基准配置已更新，但当前运行时仍被 <code>leaderteam.local.json</code> 覆盖项遮蔽：
                <code className="lt-mono" style={{ marginLeft: 4 }}>[{shadowedByLocal.join(', ')}]</code>。
              </div>
            ) : saveTarget === 'base' && hasActiveLocalOverrides ? (
              <div>
                <strong>提示：</strong>检测到 <code>leaderteam.local.json</code> 存在覆盖项（<code>{activeLocalOverrideItems.join('、')}</code>），运行时优先级高于基准配置。
              </div>
            ) : null}
            {warnings.length > 0 && (
              <div style={{ marginTop: shadowedByLocal.length > 0 ? 4 : 0 }}>{warnings.join('；')}</div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
            {hasActiveLocalOverrides && (
              <button className="lt-btn lt-btn-sm lt-btn-danger" disabled={busy} onClick={() => void handleClearLocalOverrides()}>
                清除本机覆盖 (Clear Local Overrides)
              </button>
            )}
            {(shadowedByLocal.length > 0 || warnings.length > 0) && (
              <button
                className="lt-btn lt-btn-sm"
                onClick={() => {
                  setShadowedByLocal([]);
                  setWarnings([]);
                }}
              >
                关闭
              </button>
            )}
          </div>
        </div>
      )}
      {notice && <div className="lt-banner"><span>{notice}</span><button className="lt-btn lt-btn-sm" onClick={() => setNotice(null)}>关闭</button></div>}

      {/* 1. 7-Role Governance & Execution Matrix */}
      <div className="lt-card lt-card-authority" style={{ marginBottom: 20 }}>
        <div className="lt-card-title">
          <span>角色模型与多级故障回退链 ({bundle.capabilities.supportedRoles.length} 席角色)</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 400 }}>
            <span>Leader 模型策略:</span>
            <select
              className="lt-select"
              style={{ width: 150, height: 28 }}
              value={leaderPolicy}
              onChange={e => {
                setIsDirty(true);
                setLeaderPolicy(e.target.value);
              }}
            >
              <option value="warn">提醒 (warn)</option>
              <option value="enforce">强制一致 (enforce)</option>
              <option value="off">不限制 (off)</option>
            </select>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(330px, 1fr))', gap: 12 }}>
          {bundle.capabilities.supportedRoles.map(roleMeta => {
            const cur = draftRoles[roleMeta.roleId] || { route: '', effort: 'none', fallback: [] };
            const availEfforts = effortsForRoute(cur.route);
            return (
              <div
                key={roleMeta.roleId}
                style={{
                  padding: '12px 14px',
                  border: '1px solid var(--lt-border-subtle)',
                  borderRadius: 'var(--lt-radius-sm)',
                  background: 'var(--lt-bg-subtle)',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                  <strong>{roleMeta.label}</strong>
                  <span className="lt-mono" style={{ fontSize: 11, color: 'var(--lt-fg-muted)' }}>{roleMeta.roleId}</span>
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--lt-fg-secondary)', marginBottom: 8 }}>{roleMeta.description}</div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 96px', gap: 6 }}>
                  <select
                    className="lt-select lt-mono"
                    style={{ fontSize: 12 }}
                    value={cur.route}
                    onChange={e => updateRolePrimary(roleMeta.roleId, 'route', e.target.value)}
                  >
                    <option value="">-- 选择主路由 --</option>
                    {bundle.models.map(m => (
                      <option key={m.entryId} value={m.routeId}>
                        {m.routeId} [{m.sourceKind}]
                      </option>
                    ))}
                  </select>
                  <select
                    className="lt-select lt-mono"
                    style={{ fontSize: 12 }}
                    value={cur.effort}
                    onChange={e => updateRolePrimary(roleMeta.roleId, 'effort', e.target.value)}
                  >
                    {availEfforts.map(ef => (
                      <option key={ef} value={ef}>{ef}</option>
                    ))}
                  </select>
                </div>

                {roleMeta.supportsFallbacks && (
                  <div style={{ marginTop: 8 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, color: 'var(--lt-fg-muted)' }}>
                      <span>故障/限流回退链 ({(cur.fallback || []).length}/{roleMeta.maxFallbacks})</span>
                      {(cur.fallback || []).length < roleMeta.maxFallbacks && (
                        <button type="button" className="lt-btn lt-btn-sm" onClick={() => addRoleFallback(roleMeta.roleId)}>
                          + 回退槽
                        </button>
                      )}
                    </div>
                    {(cur.fallback || []).map((fb, idx) => (
                      <div key={idx} style={{ display: 'grid', gridTemplateColumns: '1fr 84px 28px', gap: 4, marginTop: 6 }}>
                        <select
                          className="lt-select lt-mono"
                          style={{ height: 28, fontSize: 11.5 }}
                          value={fb.route}
                          onChange={e => updateRoleFallback(roleMeta.roleId, idx, 'route', e.target.value)}
                        >
                          {bundle.models.map(m => (
                            <option key={m.entryId} value={m.routeId}>{m.routeId}</option>
                          ))}
                        </select>
                        <select
                          className="lt-select lt-mono"
                          style={{ height: 28, fontSize: 11.5 }}
                          value={fb.effort}
                          onChange={e => updateRoleFallback(roleMeta.roleId, idx, 'effort', e.target.value)}
                        >
                          {effortsForRoute(fb.route).map(ef => (
                            <option key={ef} value={ef}>{ef}</option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className="lt-btn lt-btn-sm lt-btn-danger"
                          onClick={() => removeRoleFallback(roleMeta.roleId, idx)}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* 2. Unified 4-Dimension Model Catalog & Pool Sync */}
      <div className="lt-card">
        <div className="lt-card-title" style={{ flexWrap: 'wrap' }}>
          <span>统一模型目录 ({filteredModels.length} / {bundle.models.length}) · 执行池已选 {draftPool.length} 项</span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input
              className="lt-input"
              style={{ width: 210, height: 30 }}
              placeholder="搜索模型路由 / 供应商 / ID…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            <select className="lt-select" style={{ width: 150, height: 30 }} value={sourceFilter} onChange={e => setSourceFilter(e.target.value)}>
              <option value="all">全部来源</option>
              <option value="magpie">Magpie 网关</option>
              <option value="direct">直连 API</option>
              <option value="host-settings">DSH 宿主已注册</option>
            </select>
            <button
              className="lt-btn"
              disabled={busy || selectedEntries.size === 0}
              onClick={() => void handleSyncMagpieToLt(false)}
            >
              导入勾选 ({selectedEntries.size}) 至模型池
            </button>
            <button className="lt-btn lt-btn-primary" disabled={busy} onClick={() => void handleSyncMagpieToLt(true)}>
              一键同步全部 Magpie 模型入池
            </button>
          </div>
        </div>

        <div className="lt-table-wrap">
          <table className="lt-table">
            <thead>
              <tr>
                <th style={{ width: 34 }}>选</th>
                <th>执行池</th>
                <th>LT 路由标识 (routeId)</th>
                <th>来源 (source)</th>
                <th>供应商 / 凭据域</th>
                <th>上游模型 ID</th>
                <th>推理档位 (wire 安全)</th>
                <th className="lt-right">上下文 / 输出</th>
              </tr>
            </thead>
            <tbody>
              {filteredModels.map(m => {
                const inExec = draftPool.includes(m.routeId);
                return (
                  <tr key={m.entryId} data-selected={selectedEntries.has(m.entryId)}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selectedEntries.has(m.entryId)}
                        onChange={() => toggleEntrySelection(m.entryId)}
                      />
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        checked={inExec}
                        disabled={!m.inModelPool}
                        title={m.inModelPool ? '切换是否允许子智能体成员调度此模型' : '请先导入至 LT 模型目录'}
                        onChange={() => toggleExecutionPoolRoute(m.routeId)}
                      />
                    </td>
                    <td>
                      <strong className="lt-mono">{m.routeId}</strong>
                      <div style={{ fontSize: 11, color: 'var(--lt-fg-secondary)' }}>
                        {m.displayName} {m.capabilities.vision && <span className="lt-tag">视觉</span>}
                      </div>
                    </td>
                    <td><span className="lt-tag">{m.sourceKind}</span></td>
                    <td>
                      <div>{m.providerDisplayName}</div>
                      <div className="lt-mono" style={{ fontSize: 10.5, color: 'var(--lt-fg-muted)' }}>{m.credentialScope}</div>
                    </td>
                    <td className="lt-mono" style={{ fontSize: 12 }}>{m.upstreamModelId}</td>
                    <td className="lt-mono" style={{ fontSize: 11.5 }}>
                      {m.efforts.supported.join(', ')}
                      {m.efforts.wireEffortMap?.off === 'none' && (
                        <span className="lt-tag" style={{ marginLeft: 4 }}>off→"none"</span>
                      )}
                    </td>
                    <td className="lt-right lt-mono" style={{ fontSize: 11.5 }}>
                      {m.limits.contextWindow ? `${formatNumber(m.limits.contextWindow)}` : '未知'} /{' '}
                      {m.limits.maxOutputTokens ? `${formatNumber(m.limits.maxOutputTokens)}` : '未知'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
