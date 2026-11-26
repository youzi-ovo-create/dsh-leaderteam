import React, { useEffect, useState } from 'react';
import { callLtApi, type HydratedBundle } from '../lib/api';
import { Icon, type IconName } from '../components/Icon';
import { StageHead } from '../components/AppShell';
import { Dialog } from '../components/Overlays';
import { UnknownValue } from '../components/UnknownValue';
import type { RoleAssignment } from '../types/lt-public-v1';

function formatContextCompact(n: number | null | undefined): React.ReactNode {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
    return <UnknownValue reason="上游未声明上下文或输出上限" />;
  }
  if (n >= 1_000_000) {
    return `${(n / 1_048_576).toFixed(n % 1_048_576 ? 1 : 0)}M`;
  }
  return `${Math.round(n / 1000)}K`;
}

export function ModelsRolesView({
  bundle,
  onRefreshBundle,
  step = 'models',
  saveTarget: propSaveTarget,
  onChangeSaveTarget,
  ctxOpen = true,
  onToggleCtx,
  onNextStep,
  onNotify,
}: {
  bundle: HydratedBundle;
  onRefreshBundle: () => Promise<void>;
  step?: 'models' | 'roles';
  saveTarget?: 'local' | 'base';
  onChangeSaveTarget?: (next: 'local' | 'base') => void;
  ctxOpen?: boolean;
  onToggleCtx?: () => void;
  onNextStep?: () => void;
  onNotify?: (message: string, icon?: IconName) => void;
}) {
  const [search, setSearch] = useState('');
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const [selectedEntries, setSelectedEntries] = useState<Set<string>>(new Set());
  const [localSaveTarget, setLocalSaveTarget] = useState<'local' | 'base'>(propSaveTarget || 'local');
  const [draftPool, setDraftPool] = useState<string[]>([]);
  const [draftRoles, setDraftRoles] = useState<Record<string, RoleAssignment>>({});
  const [leaderPolicy, setLeaderPolicy] = useState<string>('warn');
  const [isDirty, setIsDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [shadowedByLocal, setShadowedByLocal] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  const saveTarget = propSaveTarget ?? localSaveTarget;
  const setSaveTarget = (next: 'local' | 'base') => {
    setLocalSaveTarget(next);
    if (onChangeSaveTarget) onChangeSaveTarget(next);
  };

  useEffect(() => {
    if (isDirty) return;
    setDraftPool([...(bundle.runtime.modelPool.executionPool || [])]);
    setDraftRoles(structuredClone(bundle.runtime.roleAssignments || {}));
    setLeaderPolicy(bundle.runtime.leaderModelPolicy || 'warn');
  }, [bundle, isDirty]);

  const localOverrides =
    bundle.runtime.localOverrides || (bundle.runtime.syncState as any)?.localOverrides || null;
  const activeLocalOverrideItems: string[] = [];
  if (localOverrides?.exists) {
    if (localOverrides.executionPool) activeLocalOverrideItems.push('team.executionPool');
    if (localOverrides.leaderModelPolicy) activeLocalOverrideItems.push('team.leaderModelPolicy');
    if (localOverrides.roles?.length) activeLocalOverrideItems.push(`roles(${localOverrides.roles.join(', ')})`);
    if (localOverrides.models?.length) activeLocalOverrideItems.push(`models(${localOverrides.models.join(', ')})`);
  }
  const hasActiveLocalOverrides = activeLocalOverrideItems.length > 0;
  const overriddenRolesSet = new Set<string>(localOverrides?.roles || []);

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

  function notify(msg: string, icon: IconName = 'check') {
    setNotice(msg);
    if (onNotify) onNotify(msg, icon);
  }

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
      notify(
        `已同步 ${res.syncedCount} 个模型至模型池与执行池（自动完成 off → "none" 推理档位映射）` +
          (isDirty ? '；已保留当前未保存草稿' : ''),
        'refresh',
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
      notify(
        `已写入 ${saveTarget === 'local' ? 'leaderteam.local.json' : 'leaderteam.config.json + YAML 补丁'}（执行池实时生效，治理角色对新建团队生效）`,
        'check',
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
      setShowClearConfirm(false);
      notify('已清除全部本机覆盖，基准配置已立即生效', 'check');
      await onRefreshBundle();
    } catch (e: any) {
      setError(`清除本机覆盖失败：${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  function effortsForRoute(routeId: string): string[] {
    const found = bundle.models.find(m => m.routeId === routeId);
    return found?.efforts.supported?.length
      ? found.efforts.supported
      : ['none', 'off', 'low', 'medium', 'high', 'xhigh', 'max'];
  }

  const leadingToggle =
    !ctxOpen && onToggleCtx ? (
      <button
        type="button"
        className="btn btn-ghost btn-icon btn-sm"
        onClick={onToggleCtx}
        title="展开步骤栏（Ctrl+B）"
      >
        <Icon name="panelL" />
      </button>
    ) : undefined;

  const layerLensNode = (
    <div className="callout" style={{ marginBottom: 20, alignItems: 'center' }}>
      <Icon name="layers" />
      <span className="grow">
        写入目标：<b>{saveTarget === 'local' ? '本机覆盖层' : '基础配置'}</b>{' '}
        <span className="mono t-meta">
          {saveTarget === 'local' ? 'leaderteam.local.json' : 'leaderteam.config.json'}
        </span>
        {hasActiveLocalOverrides && (
          <>
            {' · '}
            <span style={{ color: 'var(--lt-warning)' }}>
              本机覆盖活跃（{activeLocalOverrideItems.join('、')}）
            </span>
          </>
        )}
      </span>
      {!propSaveTarget && (
        <div className="seg seg-sm">
          <button
            type="button"
            aria-pressed={saveTarget === 'local'}
            onClick={() => setSaveTarget('local')}
          >
            本机覆盖
          </button>
          <button
            type="button"
            aria-pressed={saveTarget === 'base'}
            onClick={() => setSaveTarget('base')}
          >
            基础配置
          </button>
        </div>
      )}
      {hasActiveLocalOverrides && (
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy}
          onClick={() => setShowClearConfirm(true)}
        >
          清除全部本机覆盖
        </button>
      )}
    </div>
  );

  const feedbackBanners = (
    <>
      {error && (
        <div className="callout danger" style={{ marginBottom: 14 }}>
          <Icon name="alert" />
          <span className="grow">{error}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setError(null)}>
            关闭
          </button>
        </div>
      )}
      {(shadowedByLocal.length > 0 || warnings.length > 0) && (
        <div className="callout warning" style={{ marginBottom: 14 }}>
          <Icon name="alert" />
          <div className="grow">
            {shadowedByLocal.length > 0 && (
              <div>
                基准配置已更新，但以下字段正被本机覆盖遮蔽：
                <span className="mono">[{shadowedByLocal.join(', ')}]</span>。
              </div>
            )}
            {warnings.length > 0 && <div>{warnings.join('；')}</div>}
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              setShadowedByLocal([]);
              setWarnings([]);
            }}
          >
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
    </>
  );

  return (
    <>
      {step === 'models' ? (
        <>
          <StageHead
            overline="接入 · 3 / 4"
            title="模型目录与执行池"
            leading={leadingToggle}
            right={
              <div className="row" style={{ gap: 8 }}>
                {selectedEntries.size > 0 && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busy}
                    onClick={() => void handleSyncMagpieToLt(false)}
                  >
                    导入勾选 ({selectedEntries.size})
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() => void handleSyncMagpieToLt(true)}
                >
                  <Icon name="refresh" className="icon-14" />
                  从 Magpie 发现并同步
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={busy}
                  onClick={() => void handleSaveRuntimeConfig()}
                >
                  {busy ? '保存中…' : isDirty ? '保存执行池变更' : '保存执行池'}
                </button>
              </div>
            }
          />
          <div className="stage-body">
            <div className="stage-pad">
              {layerLensNode}
              {feedbackBanners}

              <div className="row" style={{ gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
                <div className="seg seg-sm" role="radiogroup" aria-label="模型来源筛选">
                  {[
                    ['all', '全部'],
                    ['magpie', 'Magpie'],
                    ['direct', '直连'],
                    ['external-gateway', '外部网关'],
                    ['host-settings', 'DSH 宿主'],
                  ].map(([id, lbl]) => (
                    <button
                      key={id}
                      type="button"
                      aria-pressed={sourceFilter === id}
                      onClick={() => setSourceFilter(id)}
                    >
                      {lbl}
                    </button>
                  ))}
                </div>
                <label className="search" style={{ width: 240 }}>
                  <Icon name="search" />
                  <input
                    className="input input-sm"
                    placeholder="搜索模型或路由…"
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                  />
                </label>
                <span className="grow" />
                <span className="t-meta">
                  池内 <b className="num">{poolModels.length}</b> · 执行池{' '}
                  <b className="num">{draftPool.length}</b>
                </span>
              </div>

              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th style={{ width: 32 }}>选</th>
                      <th>模型 / 路由</th>
                      <th>来源</th>
                      <th>能力</th>
                      <th className="r">上下文</th>
                      <th className="r">最大输出</th>
                      <th>推理档位</th>
                      <th>档次</th>
                      <th title="进入 LT 模型目录，可被角色绑定">模型池</th>
                      <th title="可被团队派发给执行成员">执行池</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredModels.map(m => {
                      const inExec = draftPool.includes(m.routeId);
                      return (
                        <tr
                          key={m.entryId}
                          aria-selected={selectedEntries.has(m.entryId) ? 'true' : undefined}
                        >
                          <td>
                            <input
                              type="checkbox"
                              className="check"
                              checked={selectedEntries.has(m.entryId)}
                              onChange={() => toggleEntrySelection(m.entryId)}
                            />
                          </td>
                          <td>
                            <div className="col" style={{ gap: 1 }}>
                              <b className="t-small">{m.displayName}</b>
                              <span className="mono t-meta">{m.routeId}</span>
                            </div>
                          </td>
                          <td>
                            <div className="col" style={{ gap: 1 }}>
                              <span className="mono t-meta">{m.providerId}</span>
                              <span className="t-meta" style={{ fontSize: 10.5 }}>
                                {m.sourceKind}
                              </span>
                            </div>
                          </td>
                          <td>
                            <span className="row" style={{ gap: 6 }}>
                              {(
                                [
                                  ['eye', m.capabilities.vision, '视觉'],
                                  ['doc', m.capabilities.pdf, 'PDF'],
                                  ['wrench', m.capabilities.toolCall, '工具调用'],
                                  ['spark', m.capabilities.reasoning, '推理'],
                                ] as Array<[IconName, boolean, string]>
                              ).map(([icName, on, tip]) => (
                                <span
                                  key={icName}
                                  title={`${tip}${on ? '' : '（不支持）'}`}
                                  style={{
                                    color: on ? 'var(--lt-fg-secondary)' : 'var(--lt-fg-disabled)',
                                    opacity: on ? 1 : 0.4,
                                  }}
                                >
                                  <Icon name={icName} className="icon-14" />
                                </span>
                              ))}
                            </span>
                          </td>
                          <td className="r num">{formatContextCompact(m.limits.contextWindow)}</td>
                          <td className="r num">{formatContextCompact(m.limits.maxOutputTokens)}</td>
                          <td>
                            <span className="mono t-meta">{m.efforts.supported.join(' · ')}</span>
                            {m.efforts.wireEffortMap?.off === 'none' && (
                              <span className="badge sm outline" style={{ marginLeft: 4 }}>
                                off→none
                              </span>
                            )}
                          </td>
                          <td>
                            <span className="badge sm outline">{m.tier}</span>
                          </td>
                          <td>
                            {m.inModelPool ? (
                              <span className="badge sm success">池内</span>
                            ) : (
                              <span className="t-meta">待导入</span>
                            )}
                          </td>
                          <td>
                            <label className="switch">
                              <input
                                type="checkbox"
                                checked={inExec}
                                disabled={!m.inModelPool}
                                title={m.inModelPool ? '切换是否允许子智能体成员调度此模型' : '请先同步入模型池'}
                                onChange={() => toggleExecutionPoolRoute(m.routeId)}
                              />
                              <span className="track" />
                            </label>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="row" style={{ gap: 12, marginTop: 16, flexWrap: 'wrap' }}>
                <div className="field" style={{ width: 320 }}>
                  <label className="label">
                    领队模型策略 <span className="mono t-meta">leaderModelPolicy</span>
                  </label>
                  <select
                    className="select"
                    value={leaderPolicy}
                    onChange={e => {
                      setIsDirty(true);
                      setLeaderPolicy(e.target.value);
                    }}
                  >
                    <option value="warn">提醒模式 (warn)</option>
                    <option value="enforce">强制与领队角色一致 (enforce)</option>
                    <option value="off">不限制 (off)</option>
                  </select>
                </div>
                <span className="grow" />
                {onNextStep && (
                  <button type="button" className="btn btn-primary" onClick={onNextStep}>
                    下一步：绑定角色 <Icon name="chevR" className="icon-14" />
                  </button>
                )}
              </div>
            </div>
          </div>
        </>
      ) : (
        <>
          <StageHead
            overline="接入 · 4 / 4"
            title="角色路由"
            leading={leadingToggle}
            right={
              <div className="row" style={{ gap: 8 }}>
                {isDirty && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busy}
                    onClick={() => {
                      setIsDirty(false);
                      setDraftPool([...(bundle.runtime.modelPool.executionPool || [])]);
                      setDraftRoles(structuredClone(bundle.runtime.roleAssignments || {}));
                      setLeaderPolicy(bundle.runtime.leaderModelPolicy || 'warn');
                    }}
                  >
                    重置草稿
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={busy}
                  onClick={() => void handleSaveRuntimeConfig()}
                >
                  {busy ? '保存中…' : '保存角色路由'}
                </button>
              </div>
            }
          />
          <div className="stage-body">
            <div className="stage-pad" style={{ maxWidth: 1180 }}>
              {layerLensNode}
              {feedbackBanners}

              <div className="card">
                {bundle.capabilities.supportedRoles.map((roleMeta, i) => {
                  const cur = draftRoles[roleMeta.roleId] || { route: '', effort: 'none', fallback: [] };
                  const isOverridden = overriddenRolesSet.has(roleMeta.roleId);
                  return (
                    <div
                      key={roleMeta.roleId}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '210px minmax(0, 1fr) 120px',
                        gap: 16,
                        padding: '14px 16px',
                        alignItems: 'start',
                        borderTop: i > 0 ? '1px solid var(--lt-border-subtle)' : undefined,
                      }}
                    >
                      <div className="col" style={{ gap: 3 }}>
                        <span className="row" style={{ gap: 8 }}>
                          <b>{roleMeta.label}</b>
                          <span className="mono t-meta">{roleMeta.roleId}</span>
                        </span>
                        <span className="t-meta" style={{ lineHeight: 1.5 }}>
                          {roleMeta.description}
                        </span>
                      </div>

                      <div className="col" style={{ gap: 6 }}>
                        <div className="chain">
                          <span className="chain-hop primary">
                            <span className="hop-idx">主</span>
                            <select
                              className="hop-route-sel"
                              aria-label={`${roleMeta.roleId} 主路由`}
                              value={cur.route}
                              onChange={e => updateRolePrimary(roleMeta.roleId, 'route', e.target.value)}
                            >
                              <option value="">— 选择路由 —</option>
                              {bundle.models.map(m => (
                                <option key={m.entryId} value={m.routeId}>
                                  {m.routeId}
                                </option>
                              ))}
                            </select>
                            <select
                              aria-label={`${roleMeta.roleId} 推理强度`}
                              value={cur.effort}
                              onChange={e => updateRolePrimary(roleMeta.roleId, 'effort', e.target.value)}
                            >
                              {effortsForRoute(cur.route).map(ef => (
                                <option key={ef} value={ef}>
                                  {ef}
                                </option>
                              ))}
                            </select>
                          </span>

                          {roleMeta.supportsFallbacks &&
                            (cur.fallback || []).map((fb, idx) => (
                              <React.Fragment key={idx}>
                                <span className="chain-arrow">→</span>
                                <span className="chain-hop">
                                  <span className="hop-idx">{idx + 1}</span>
                                  <select
                                    className="hop-route-sel"
                                    aria-label={`${roleMeta.roleId} 备选 ${idx + 1}`}
                                    value={fb.route}
                                    onChange={e => updateRoleFallback(roleMeta.roleId, idx, 'route', e.target.value)}
                                  >
                                    {bundle.models.map(m => (
                                      <option key={m.entryId} value={m.routeId}>
                                        {m.routeId}
                                      </option>
                                    ))}
                                  </select>
                                  <select
                                    aria-label={`${roleMeta.roleId} 备选 ${idx + 1} 强度`}
                                    value={fb.effort}
                                    onChange={e => updateRoleFallback(roleMeta.roleId, idx, 'effort', e.target.value)}
                                  >
                                    {effortsForRoute(fb.route).map(ef => (
                                      <option key={ef} value={ef}>
                                        {ef}
                                      </option>
                                    ))}
                                  </select>
                                  <button
                                    type="button"
                                    className="hop-x"
                                    aria-label="移除备选"
                                    onClick={() => removeRoleFallback(roleMeta.roleId, idx)}
                                  >
                                    <Icon name="x" className="icon-14" />
                                  </button>
                                </span>
                              </React.Fragment>
                            ))}

                          {roleMeta.supportsFallbacks &&
                            (cur.fallback || []).length < roleMeta.maxFallbacks && (
                              <button
                                type="button"
                                className="chain-add"
                                onClick={() => addRoleFallback(roleMeta.roleId)}
                              >
                                <Icon name="plus" className="icon-14" />
                                备选
                              </button>
                            )}
                        </div>
                      </div>

                      <div className="col" style={{ alignItems: 'flex-end', gap: 6 }}>
                        {isOverridden ? (
                          <span className="layer local">local</span>
                        ) : (
                          <span className="layer base">base</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="row" style={{ marginTop: 16, gap: 10 }}>
                <span className="t-meta">保存后事务化写入所选配置层，并同步至 DSH 设置（新建团队生效）。</span>
                <span className="grow" />
                <span className="row t-meta" style={{ gap: 6 }}>
                  <Icon name="check" className="icon-14" />
                  {bundle.runtime.syncState.dshSettingsSynced ? '已同步' : '待同步'}
                  {bundle.runtime.syncState.governanceHash && (
                    <>
                      {' · '}
                      <span className="mono">gov {bundle.runtime.syncState.governanceHash.slice(0, 8)}</span>
                    </>
                  )}
                </span>
              </div>
            </div>
          </div>
        </>
      )}

      <Dialog
        open={showClearConfirm}
        onClose={() => setShowClearConfirm(false)}
        title="清除全部本机覆盖？"
        footer={
          <>
            <button type="button" className="btn" onClick={() => setShowClearConfirm(false)}>
              取消
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => void handleClearLocalOverrides()}
            >
              清除并恢复基础值
            </button>
          </>
        }
      >
        <p className="t-small secondary" style={{ margin: 0 }}>
          将清除 <span className="mono">leaderteam.local.json</span> 中的本机覆盖项（
          <span className="mono">{activeLocalOverrideItems.join(', ')}</span>），正式基准配置将立即恢复生效。
        </p>
      </Dialog>
    </>
  );
}
