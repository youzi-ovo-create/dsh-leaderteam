import React, { useEffect, useState } from 'react';
import {
  fetchWorkbenchSessionConfig,
  updateWorkbenchSessionConfig,
  resetWorkbenchSessionConfig,
  promoteWorkbenchSessionConfigToGlobal,
  type HydratedBundle,
  type SessionScopedConfigSnapshot,
} from '../lib/api';
import { Dialog } from './Overlays';
import { Icon, type IconName } from './Icon';

export function SessionConfigModal({
  open,
  sessionId,
  sessionTitle,
  bundle,
  onClose,
  onRefreshBundle,
  onSaved,
  onNotify,
}: {
  open: boolean;
  sessionId: string | null;
  sessionTitle?: string | null;
  bundle: HydratedBundle;
  onClose: () => void;
  onRefreshBundle: () => Promise<void>;
  onSaved?: (snap: SessionScopedConfigSnapshot) => void;
  onNotify?: (msg: string, icon?: IconName) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snap, setSnap] = useState<SessionScopedConfigSnapshot | null>(null);

  const [leaderRoute, setLeaderRoute] = useState('');
  const [leaderEffort, setLeaderEffort] = useState('high');
  const [syncAllRoles, setSyncAllRoles] = useState(true);
  const [gateRoute, setGateRoute] = useState('');
  const [arbiterRoute, setArbiterRoute] = useState('');
  const [pool, setPool] = useState<string[]>([]);
  const [maxMembers, setMaxMembers] = useState<number>(6);
  const [leaderPolicy, setLeaderPolicy] = useState<string>('follow');

  useEffect(() => {
    if (!open || !sessionId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchWorkbenchSessionConfig(sessionId)
      .then(s => {
        if (cancelled) return;
        setSnap(s);
        setLeaderRoute(s.effective.roles?.leader?.route || '');
        setLeaderEffort(s.effective.roles?.leader?.effort || 'high');
        setGateRoute(s.effective.roles?.gate?.route || '');
        setArbiterRoute(s.effective.roles?.arbiter?.route || '');
        setPool([...(s.effective.executionPool || [])]);
        setMaxMembers(s.effective.maxActiveMembers || 6);
        setLeaderPolicy(s.effective.leaderModelPolicy || 'follow');
      })
      .catch((e: any) => {
        if (!cancelled) setError(e?.message || '读取当前会话配置失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, sessionId]);

  if (!open || !sessionId) return null;

  const availableModels = bundle.models || [];
  const selectedLeaderMeta = availableModels.find(m => m.routeId === leaderRoute);
  const supportedEfforts = selectedLeaderMeta?.efforts?.supported?.length
    ? selectedLeaderMeta.efforts.supported
    : ['none', 'low', 'medium', 'high', 'xhigh', 'max'];

  function handleLeaderRouteChange(nextRoute: string) {
    setLeaderRoute(nextRoute);
    const meta = availableModels.find(m => m.routeId === nextRoute);
    if (meta && !meta.efforts.supported.includes(leaderEffort)) {
      setLeaderEffort(meta.efforts.defaultEffort || meta.efforts.supported[0] || 'none');
    }
    if (!pool.includes(nextRoute) && nextRoute) {
      setPool(prev => [...prev, nextRoute]);
    }
  }

  function togglePoolRoute(routeId: string) {
    setPool(prev => (prev.includes(routeId) ? prev.filter(r => r !== routeId) : [...prev, routeId]));
  }

  async function handleSaveForSession() {
    if (!sessionId || !leaderRoute) return;
    setBusy(true);
    setError(null);
    try {
      const rolesPatch: Record<string, any> = {
        leader: { route: leaderRoute, effort: leaderEffort },
      };
      if (!syncAllRoles) {
        if (gateRoute) rolesPatch.gate = { route: gateRoute };
        if (arbiterRoute) {
          rolesPatch.arbiter = { route: arbiterRoute };
          rolesPatch.discussA = { route: arbiterRoute };
          rolesPatch.discussB = { route: gateRoute || leaderRoute };
        }
      }
      const effectivePool = pool.length > 0 ? pool : [leaderRoute];
      const res = await updateWorkbenchSessionConfig({
        sessionId,
        syncAllRolesToLeader: syncAllRoles,
        patch: {
          roles: rolesPatch,
          team: {
            executionPool: effectivePool,
            maxActiveMembers: Math.max(1, Math.min(200, Number(maxMembers) || 6)),
            leaderModelPolicy: leaderPolicy,
          },
        },
      });
      setSnap(res.sessionConfig);
      if (onSaved) onSaved(res.sessionConfig);
      if (onNotify) {
        onNotify(
          res.appliedImmediately
            ? '当前会话专属配置已立即生效（不影响全局与其他会话）'
            : '当前会话正在执行中，配置已暂存并将在安全边界自动切换',
          'check',
        );
      }
      onClose();
    } catch (e: any) {
      setError(e?.message || '保存会话配置失败');
    } finally {
      setBusy(false);
    }
  }

  async function handleResetToGlobal() {
    if (!sessionId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await resetWorkbenchSessionConfig(sessionId);
      setSnap(res.sessionConfig);
      if (onSaved) onSaved(res.sessionConfig);
      if (onNotify) {
        onNotify(
          res.appliedImmediately ? '已恢复跟随全局默认配置' : '已暂存恢复全局，待当前回合结束后生效',
          'refresh',
        );
      }
      onClose();
    } catch (e: any) {
      setError(e?.message || '恢复全局配置失败');
    } finally {
      setBusy(false);
    }
  }

  async function handlePromoteToGlobal() {
    if (!sessionId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await promoteWorkbenchSessionConfigToGlobal(sessionId);
      setSnap(res.sessionConfig);
      if (onSaved) onSaved(res.sessionConfig);
      await onRefreshBundle();
      if (onNotify) onNotify('已将本会话配置同步设为本机全局默认，所有空闲会话已热更新', 'check');
      onClose();
    } catch (e: any) {
      setError(e?.message || '同步至全局失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`当前会话专属配置 · ${sessionTitle || sessionId.slice(0, 14)}`}
      footer={
        <>
          {snap?.hasOverride && (
            <button type="button" className="btn" disabled={busy} onClick={() => void handleResetToGlobal()}>
              恢复跟随全局
            </button>
          )}
          <button type="button" className="btn" disabled={busy} onClick={() => void handlePromoteToGlobal()}>
            同步设为全局默认
          </button>
          <span className="grow" />
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || loading || !leaderRoute}
            onClick={() => void handleSaveForSession()}
          >
            {busy ? '应用中…' : snap?.isBusy ? '暂存并在安全边界切换' : '仅应用到当前会话'}
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 14, minWidth: 520, maxWidth: '100%' }}>
        <div className="callout" style={{ alignItems: 'center' }}>
          <Icon name={snap?.isBusy ? 'clock' : 'check'} />
          <span className="grow t-small">
            {snap?.isBusy ? (
              <>
                <b>当前会话正在执行中</b>：现在保存不会中断进行中的模型或成员调用，系统将在当前回合/子任务结束的安全边界自动切换。
              </>
            ) : (
              <>
                <b>当前会话处于空闲态</b>：保存后<b>立即对本会话生效</b>，默认绝不污染全局配置，也不影响其他会话。
              </>
            )}
          </span>
          {snap?.hasOverride ? (
            <span className="badge info">本会话已定制</span>
          ) : (
            <span className="badge outline">跟随全局默认</span>
          )}
        </div>

        {error && (
          <div className="callout" style={{ borderColor: 'var(--lt-danger)', color: 'var(--lt-danger)' }}>
            <Icon name="alert" />
            <span>{error}</span>
          </div>
        )}

        {loading ? (
          <div className="t-small muted">正在读取当前会话配置…</div>
        ) : (
          <>
            <div className="grid-2" style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10 }}>
              <label className="col" style={{ gap: 4 }}>
                <span className="t-small">
                  <b>本会话领队模型 (Leader)</b>
                </span>
                <select
                  className="input"
                  value={leaderRoute}
                  onChange={e => handleLeaderRouteChange(e.target.value)}
                >
                  <option value="" disabled>
                    选择模型路由…
                  </option>
                  {availableModels.map(m => (
                    <option key={m.routeId} value={m.routeId}>
                      {m.displayName} ({m.routeId})
                    </option>
                  ))}
                  {leaderRoute && !availableModels.some(m => m.routeId === leaderRoute) && (
                    <option value={leaderRoute}>{leaderRoute}</option>
                  )}
                </select>
              </label>

              <label className="col" style={{ gap: 4 }}>
                <span className="t-small">
                  <b>推理强度 (Effort)</b>
                </span>
                <select className="input" value={leaderEffort} onChange={e => setLeaderEffort(e.target.value)}>
                  {supportedEfforts.map(eff => (
                    <option key={eff} value={eff}>
                      {eff}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <label className="row" style={{ gap: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={syncAllRoles}
                onChange={e => setSyncAllRoles(e.target.checked)}
              />
              <span className="t-small">
                <b>一键将本会话的安全门与评审角色同步至该模型</b>（推荐，避免因旧角色未配置而报错）
              </span>
            </label>

            {!syncAllRoles && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <label className="col" style={{ gap: 4 }}>
                  <span className="t-small">本会话安全门模型 (Gate)</span>
                  <select className="input" value={gateRoute} onChange={e => setGateRoute(e.target.value)}>
                    {availableModels.map(m => (
                      <option key={m.routeId} value={m.routeId}>
                        {m.displayName} ({m.routeId})
                      </option>
                    ))}
                  </select>
                </label>
                <label className="col" style={{ gap: 4 }}>
                  <span className="t-small">本会话独立裁断/评审 (Arbiter)</span>
                  <select className="input" value={arbiterRoute} onChange={e => setArbiterRoute(e.target.value)}>
                    {availableModels.map(m => (
                      <option key={m.routeId} value={m.routeId}>
                        {m.displayName} ({m.routeId})
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <label className="col" style={{ gap: 4 }}>
                <span className="t-small">本会话最大并发成员数</span>
                <input
                  type="number"
                  min={1}
                  max={64}
                  className="input"
                  value={maxMembers}
                  onChange={e => setMaxMembers(Number(e.target.value) || 4)}
                />
              </label>
              <label className="col" style={{ gap: 4 }}>
                <span className="t-small">DSH 原生切换模型时策略</span>
                <select className="input" value={leaderPolicy} onChange={e => setLeaderPolicy(e.target.value)}>
                  <option value="follow">自适应同步本会话配置（推荐 · 不报错）</option>
                  <option value="warn">仅提示不一致（不阻断）</option>
                  <option value="enforce">严格锁定预设（不一致时阻断执行）</option>
                  <option value="off">关闭校验</option>
                </select>
              </label>
            </div>

            <div className="col" style={{ gap: 6 }}>
              <span className="t-small">
                <b>本会话可用成员模型池</b>（勾选允许领队在本会话派发子代理的模型）
              </span>
              <div
                style={{
                  maxHeight: 140,
                  overflowY: 'auto',
                  border: '1px solid var(--lt-border-subtle)',
                  borderRadius: 6,
                  padding: '6px 10px',
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 8,
                }}
              >
                {availableModels.map(m => (
                  <label key={m.routeId} className="row t-small" style={{ gap: 5, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={pool.includes(m.routeId)}
                      onChange={() => togglePoolRoute(m.routeId)}
                    />
                    <span>{m.displayName}</span>
                  </label>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
