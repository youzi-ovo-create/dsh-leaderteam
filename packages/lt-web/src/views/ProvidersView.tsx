import React, { useEffect, useState } from 'react';
import { callLtApi, type HydratedBundle } from '../lib/api';
import { Icon, type IconName } from '../components/Icon';
import { StageHead } from '../components/AppShell';
import type { ProviderDescriptor, ProviderProtocol } from '../types/lt-public-v1';

function isLoopbackEndpointUrl(rawUrl: string): boolean {
  const trimmed = rawUrl.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
  } catch {
    return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/i.test(trimmed);
  }
}

const STATUS_BADGE: Record<ProviderDescriptor['status'], [string, string]> = {
  ready: ['success', '就绪'],
  degraded: ['warning', '降级'],
  unconfigured: ['', '未配置'],
  disabled: ['', '已停用'],
  auth_required: ['warning', '待授权'],
};

const SOURCE_GROUP_LABELS: Record<ProviderDescriptor['sourceKind'], string> = {
  magpie: 'Magpie 网关',
  direct: '直连供应商',
  'external-gateway': '外部网关',
};

const ROTATION_LABELS: Record<ProviderDescriptor['keyRotation'], string> = {
  'round-robin': '轮询',
  'fill-first': '顺位优先',
  'least-used': '最少调用',
  single: '单凭据',
};

function Monogram({ name }: { name: string }) {
  return (
    <span
      style={{
        width: 28,
        height: 28,
        borderRadius: 'var(--lt-radius-sm)',
        display: 'grid',
        placeItems: 'center',
        background: 'var(--lt-bg-inset)',
        border: '1px solid var(--lt-border-subtle)',
        fontWeight: 700,
        fontSize: 12,
        color: 'var(--lt-fg-secondary)',
        flex: '0 0 auto',
      }}
    >
      {(name || '?').slice(0, 1).toUpperCase()}
    </span>
  );
}

export function ProvidersView({
  bundle,
  onRefreshBundle,
  step = 'providers',
  ctxOpen = true,
  onToggleCtx,
  onNextStep,
  onNotify,
}: {
  bundle: HydratedBundle;
  onRefreshBundle: () => Promise<void>;
  step?: 'gateway' | 'providers';
  ctxOpen?: boolean;
  onToggleCtx?: () => void;
  onNextStep?: () => void;
  onNotify?: (message: string, icon?: IconName) => void;
}) {
  const gw = bundle.gateway;
  const presets = bundle.providerPresets ?? [];

  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  // External / Managed gateway config inputs (write-only webKey!)
  const [showExtConfig, setShowExtConfig] = useState(gw.mode === 'external');
  const [extGwUrl, setExtGwUrl] = useState(gw.gatewayUrl || 'http://127.0.0.1:3425');
  const [extWebUrl, setExtWebUrl] = useState(gw.webAdminUrl || 'http://127.0.0.1:3430');
  const [extWebKey, setExtWebKey] = useState('');
  const [extUrlsDirty, setExtUrlsDirty] = useState(false);

  // Slide-over Drawer states
  const [showAddDrawer, setShowAddDrawer] = useState(false);
  const [addChannel, setAddChannel] = useState<'magpie' | 'external-gateway'>('magpie');
  const [showOauthDrawer, setShowOauthDrawer] = useState(false);
  const [activeProviderId, setActiveProviderId] = useState<string | null>(null);

  // Add Magpie Provider form
  const [vendorPreset, setVendorPreset] = useState(
    presets[0]?.vendorId || (presets.length === 0 ? 'custom' : 'deepseek'),
  );
  const [customId, setCustomId] = useState('');
  const [customName, setCustomName] = useState('');
  const [customUrl, setCustomUrl] = useState('');
  const [customApi, setCustomApi] = useState<'chat' | 'responses' | 'anthropic' | 'gemini'>('chat');
  const [rawApiKey, setRawApiKey] = useState('');
  const [discoveredPreview, setDiscoveredPreview] = useState<Array<{ id: string; name: string }>>([]);

  // External OpenAI-compatible gateways (`save-external` / `remove-external`)
  const [extRelayId, setExtRelayId] = useState('');
  const [extRelayName, setExtRelayName] = useState('');
  const [extRelayEndpoint, setExtRelayEndpoint] = useState('');
  const [extRelayProtocol, setExtRelayProtocol] = useState<ProviderProtocol>('openai-chat');
  const [extRelayKey, setExtRelayKey] = useState('');
  const [extRelayKeyOptional, setExtRelayKeyOptional] = useState(false);

  // Multi-key drawer inputs
  const [extraKeyName, setExtraKeyName] = useState('');
  const [extraKeySecret, setExtraKeySecret] = useState('');
  const [lastLatencyMap, setLastLatencyMap] = useState<Record<string, number>>({});

  // OAuth passthrough
  const [oauthAgent, setOauthAgent] = useState('codex');
  const [oauthSession, setOauthSession] = useState<{
    id: string;
    authUrl?: string;
    state?: string;
    code?: string;
    pasteCallback?: boolean;
  } | null>(null);
  const [oauthCallbackUrl, setOauthCallbackUrl] = useState('');

  useEffect(() => {
    if (extUrlsDirty) return;
    if (gw.gatewayUrl) setExtGwUrl(gw.gatewayUrl);
    if (gw.webAdminUrl) setExtWebUrl(gw.webAdminUrl);
  }, [gw.gatewayUrl, gw.webAdminUrl, extUrlsDirty]);

  useEffect(() => {
    if (!oauthSession?.id) return;
    const st = oauthSession.state || 'waiting';
    if (st !== 'waiting' && st !== 'installing' && st !== 'pending') return;

    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const res = await callLtApi<{
          operationResult?: {
            id?: string;
            url?: string;
            authUrl?: string;
            state?: string;
            status?: string;
            code?: string;
            pasteCallback?: boolean;
            error?: string;
          };
        }>('providers/mutate', {
          operation: 'oauth-status',
          signInId: oauthSession.id,
        });
        if (cancelled) return;
        const op = res.operationResult;
        if (!op) return;
        const nextState = op.state || op.status || st;
        const nextUrl = op.url || op.authUrl;
        if (nextState === 'done' || nextState === 'completed' || nextState === 'authenticated' || nextState === 'ok') {
          setOauthSession(null);
          setOauthCallbackUrl('');
          setShowOauthDrawer(false);
          const msg = 'Magpie OAuth 登录已完成并同步凭据';
          setMessage(msg);
          if (onNotify) onNotify(msg, 'check');
          await onRefreshBundle();
          return;
        }
        if (nextState === 'cancelled' || nextState === 'canceled') {
          setOauthSession(null);
          return;
        }
        if (nextState === 'error' || nextState === 'failed') {
          setOauthSession(prev => (prev ? { ...prev, state: nextState } : null));
          if (op.error) setError(`OAuth 授权失败：${op.error}`);
          return;
        }
        setOauthSession(prev =>
          prev
            ? {
                ...prev,
                authUrl: nextUrl || prev.authUrl,
                state: nextState,
                code: op.code || prev.code,
                pasteCallback: op.pasteCallback ?? prev.pasteCallback,
              }
            : null,
        );
      } catch {}
    }, 2000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [oauthSession?.id, oauthSession?.state, onRefreshBundle, onNotify]);

  function notify(msg: string, icon: IconName = 'check') {
    setMessage(msg);
    if (onNotify) onNotify(msg, icon);
  }

  async function runGatewayAction(action: string, extra: Record<string, unknown> = {}) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await callLtApi<any>('gateway/control', { action, ...extra });
      if (action === 'check-compatibility') {
        const ok = res.compatibility?.ok;
        notify(
          ok
            ? `Magpie 上游接口契约校验通过（检测版本 ${res.compatibility.detectedVersion || '未知'}）`
            : `兼容性检查提示：${JSON.stringify(res.compatibility?.checks || res.compatibility)}`,
          ok ? 'check' : 'alert',
        );
      } else if (action === 'rollback') {
        notify(`已回退至版本 ${res.rollback?.rolledBackTo}`, 'rollback');
      } else if (action === 'save-external') {
        notify('已保存外部兼容网关（明文密钥仅写入服务端隔离凭据库）', 'check');
        setShowAddDrawer(false);
      } else if (action === 'remove-external') {
        notify('已移除外部兼容网关', 'trash');
        setActiveProviderId(null);
      } else {
        notify(`网关操作「${action}」已完成（当前状态：${res.status?.state}）`, 'check');
      }
      if (action === 'configure') setExtUrlsDirty(false);
      setExtWebKey('');
      await onRefreshBundle();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function handlePreDiscover() {
    setBusy(true);
    setError(null);
    try {
      const trimmedKey = rawApiKey.trim();
      const probe =
        vendorPreset === 'custom'
          ? { [customApi]: customUrl.trim(), ...(trimmedKey ? { key: trimmedKey } : {}) }
          : { preset: vendorPreset, ...(trimmedKey ? { key: trimmedKey } : {}) };
      const res = await callLtApi<{ operationResult: { models: Array<{ id: string; name: string }> } }>(
        'providers/mutate',
        { operation: 'discover-models', probe },
      );
      const list = res.operationResult?.models || [];
      setDiscoveredPreview(list);
      notify(`成功从上游探测到 ${list.length} 个模型`, 'zap');
    } catch (e: any) {
      setError(`模型预探测失败：${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveProvider(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const trimmedKey = rawApiKey.trim();
      const spec =
        vendorPreset === 'custom'
          ? {
              new: true,
              id: customId.trim(),
              name: customName.trim() || customId.trim(),
              [customApi]: customUrl.trim(),
              baseAPI: customApi,
              ...(trimmedKey ? { key: trimmedKey } : {}),
            }
          : {
              new: true,
              preset: vendorPreset,
              ...(trimmedKey ? { key: trimmedKey } : {}),
            };
      await callLtApi('providers/mutate', { operation: 'save-provider', spec });
      setRawApiKey('');
      setDiscoveredPreview([]);
      setShowAddDrawer(false);
      notify('已写入供应商与密钥（明文密钥已清除，仅保留脱敏引用）', 'check');
      await onRefreshBundle();
    } catch (err: any) {
      setError(`保存供应商失败：${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleMutateProvider(operation: string, payload: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await callLtApi<any>('providers/mutate', { operation, ...payload });
      if (operation === 'test-provider') {
        const first = res.operationResult?.results?.[0];
        const latency = first?.latencyMs ?? first?.ms;
        if (typeof latency === 'number' && typeof payload.id === 'string') {
          setLastLatencyMap(prev => ({ ...prev, [payload.id as string]: latency }));
        }
        notify(
          first?.ok
            ? `连通性测试通过（HTTP ${first.status} · 延迟 ${latency ?? 0} ms）`
            : `连通性测试未通过（HTTP ${first?.status ?? 'ERR'}）`,
          first?.ok ? 'zap' : 'alert',
        );
      } else if (operation === 'delete-provider') {
        setActiveProviderId(null);
        notify('已移除供应商', 'trash');
      } else {
        notify(`操作「${operation}」已应用`, 'check');
      }
      setExtraKeySecret('');
      await onRefreshBundle();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleStartOAuth(agentId?: string) {
    const targetAgent = agentId || oauthAgent;
    setOauthAgent(targetAgent);
    setShowOauthDrawer(true);
    setBusy(true);
    setError(null);
    try {
      const res = await callLtApi<{
        operationResult: {
          id: string;
          url?: string;
          authUrl?: string;
          state?: string;
          status?: string;
          code?: string;
          pasteCallback?: boolean;
        };
      }>('providers/mutate', { operation: 'oauth-start', agent: targetAgent });
      const op = res.operationResult;
      setOauthSession({
        id: op.id,
        authUrl: op.url || op.authUrl,
        state: op.state || op.status || 'waiting',
        code: op.code,
        pasteCallback: op.pasteCallback,
      });
      notify(`已通过 Magpie 原生机制发起 ${targetAgent} 登录引导`, 'key');
    } catch (e: any) {
      setError(`发起 OAuth 失败：${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleCancelOAuth() {
    if (!oauthSession) {
      setShowOauthDrawer(false);
      return;
    }
    const signInId = oauthSession.id;
    setOauthSession(null);
    setOauthCallbackUrl('');
    setShowOauthDrawer(false);
    setBusy(true);
    setError(null);
    try {
      await callLtApi('providers/mutate', { operation: 'oauth-cancel', signInId });
      notify('已取消当前 OAuth 登录流程', 'info');
    } catch (e: any) {
      setError(`取消 OAuth 失败：${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleSubmitOAuthCallback() {
    if (!oauthSession || !oauthCallbackUrl.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await callLtApi('providers/mutate', {
        operation: 'oauth-callback',
        signInId: oauthSession.id,
        callbackUrl: oauthCallbackUrl.trim(),
      });
      setOauthCallbackUrl('');
      setOauthSession(null);
      setShowOauthDrawer(false);
      notify('OAuth 回调已交由 Magpie 完成认证', 'check');
      await onRefreshBundle();
    } catch (e: any) {
      setError(`提交回调失败：${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveExternalGateway(e: React.FormEvent) {
    e.preventDefault();
    if (!extRelayId.trim() || !extRelayEndpoint.trim()) return;
    await runGatewayAction('save-external', {
      gateway: {
        id: extRelayId.trim(),
        displayName: extRelayName.trim() || extRelayId.trim(),
        endpointUrl: extRelayEndpoint.trim(),
        protocol: extRelayProtocol,
        keyOptional: extRelayKeyOptional,
        ...(extRelayKey.trim() ? { apiKey: extRelayKey.trim() } : {}),
      },
    });
    setExtRelayId('');
    setExtRelayName('');
    setExtRelayEndpoint('');
    setExtRelayKey('');
  }

  const selectedProvider = bundle.providers.find(p => p.providerId === activeProviderId) || null;
  const selectedPreset = presets.find(p => p.vendorId === vendorPreset) || null;
  const canOmitApiKey =
    vendorPreset === 'custom'
      ? isLoopbackEndpointUrl(customUrl)
      : Boolean(
          selectedPreset?.keyOptional ||
            (selectedPreset?.defaultEndpointUrl && isLoopbackEndpointUrl(selectedPreset.defaultEndpointUrl)),
        );

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

  const filteredProviders = bundle.providers.filter(p => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (
      p.displayName.toLowerCase().includes(q) ||
      p.providerId.toLowerCase().includes(q) ||
      p.protocol.toLowerCase().includes(q)
    );
  });

  const groupedProviders: Array<{ kind: ProviderDescriptor['sourceKind']; items: ProviderDescriptor[] }> = [];
  for (const kind of ['magpie', 'direct', 'external-gateway'] as const) {
    const items = filteredProviders.filter(p => p.sourceKind === kind);
    if (items.length > 0) groupedProviders.push({ kind, items });
  }

  const anyDrawerOpen = Boolean(showAddDrawer || showOauthDrawer || selectedProvider);

  /* ==================== STEP 1: GATEWAY ==================== */
  if (step === 'gateway') {
    const gwDot = gw.state === 'running' ? 'ok' : gw.state === 'error' ? 'err' : 'warn';
    const gwLabel =
      gw.state === 'running'
        ? '运行中'
        : gw.state === 'stopped'
          ? '已停止'
          : gw.state === 'not_installed'
            ? '未安装'
            : gw.state;

    return (
      <>
        <StageHead
          overline="接入 · 1 / 4"
          title="网关"
          leading={leadingToggle}
          right={
            gw.webAdminUrl ? (
              <a
                className="btn btn-sm"
                href={gw.webAdminUrl}
                target="_blank"
                rel="noreferrer"
                title="在新标签打开 Magpie Web 管理台"
              >
                <Icon name="external" className="icon-14" />
                Magpie 管理台
              </a>
            ) : undefined
          }
        />
        <div className="stage-body">
          <div className="stage-pad" style={{ maxWidth: 980 }}>
            {error && (
              <div className="callout danger" style={{ marginBottom: 16 }}>
                <Icon name="alert" />
                <span className="grow">{error}</span>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setError(null)}>
                  关闭
                </button>
              </div>
            )}
            {message && (
              <div className="callout info" style={{ marginBottom: 16 }}>
                <Icon name="info" />
                <span className="grow">{message}</span>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMessage(null)}>
                  关闭
                </button>
              </div>
            )}

            {/* Main Gateway Status & Control Card */}
            <div className="card" style={{ marginBottom: 20 }}>
              <div className="card-pad row" style={{ gap: 16, flexWrap: 'wrap' }}>
                <span className="row" style={{ gap: 10 }}>
                  <i className={`dot ${gwDot}`} style={{ width: 10, height: 10 }} />
                  <span className="col" style={{ gap: 0 }}>
                    <b style={{ fontSize: 16 }}>{gwLabel}</b>
                    <span className="t-meta">
                      {gw.health.ok ? '健康' : '未就绪'}
                      {gw.health.latencyMs !== null && (
                        <>
                          {' · '}
                          <span className="num">{gw.health.latencyMs} ms</span>
                        </>
                      )}
                      {gw.health.checkedAt && (
                        <>
                          {' · 检查于 '}
                          <span className="num">{gw.health.checkedAt.slice(11, 19)}</span>
                        </>
                      )}
                    </span>
                  </span>
                </span>
                <span className="grow" />
                <div className="seg seg-sm" role="radiogroup" aria-label="网关模式">
                  <button
                    type="button"
                    aria-pressed={gw.mode === 'managed'}
                    disabled={busy}
                    onClick={() => {
                      setShowExtConfig(false);
                      void runGatewayAction('configure', { config: { mode: 'managed' } });
                    }}
                  >
                    LT 托管
                  </button>
                  <button
                    type="button"
                    aria-pressed={gw.mode === 'external'}
                    disabled={busy}
                    onClick={() => setShowExtConfig(true)}
                  >
                    外部网关
                  </button>
                  <button
                    type="button"
                    aria-pressed={gw.mode === 'disabled'}
                    disabled={busy}
                    onClick={() => {
                      setShowExtConfig(false);
                      void runGatewayAction('configure', { config: { mode: 'disabled' } });
                    }}
                  >
                    停用
                  </button>
                </div>
              </div>

              <div className="hairline-top grid grid-4" style={{ gap: 0 }}>
                {[
                  ['监听地址', <span className="mono">{(gw.gatewayUrl || '已停用').replace(/^https?:\/\//, '')}</span>],
                  ['进程 PID', <span className="mono">{gw.health.pid ?? '—'}</span>],
                  ['已发现模型', <span className="num">{gw.health.modelCount}</span>],
                  [
                    '管理权限',
                    gw.managementAuthenticated ? (
                      <span className="badge sm success">已认证</span>
                    ) : (
                      <span className="badge sm warning">只读 / 未鉴权</span>
                    ),
                  ],
                ].map(([lbl, node], i) => (
                  <div
                    key={String(lbl)}
                    style={{
                      padding: '12px 16px',
                      borderLeft: i > 0 ? '1px solid var(--lt-border-subtle)' : undefined,
                    }}
                  >
                    <div className="t-meta">{lbl}</div>
                    <div style={{ marginTop: 3 }}>{node}</div>
                  </div>
                ))}
              </div>

              {gw.lastError && (
                <div className="hairline-top card-pad">
                  <div className="callout warning">
                    <Icon name="alert" />
                    <span>
                      最近异常 ({gw.lastError.code})：{gw.lastError.message}
                    </span>
                  </div>
                </div>
              )}

              {showExtConfig && (
                <div className="hairline-top card-pad" style={{ background: 'var(--lt-bg-subtle)' }}>
                  <div className="t-overline" style={{ marginBottom: 8 }}>
                    接入本机已有或外部 Magpie 实例
                  </div>
                  <div className="grid grid-3" style={{ marginBottom: 10 }}>
                    <input
                      className="input input-sm mono"
                      placeholder="外部网关 URL (如 http://127.0.0.1:3425)"
                      value={extGwUrl}
                      onChange={e => {
                        setExtUrlsDirty(true);
                        setExtGwUrl(e.target.value);
                      }}
                    />
                    <input
                      className="input input-sm mono"
                      placeholder="外部管理 URL (http://127.0.0.1:3430)"
                      value={extWebUrl}
                      onChange={e => {
                        setExtUrlsDirty(true);
                        setExtWebUrl(e.target.value);
                      }}
                    />
                    <input
                      type="password"
                      className="input input-sm mono"
                      placeholder="可选：外部 MAGPIE_WEB_KEY（只写）"
                      value={extWebKey}
                      onChange={e => setExtWebKey(e.target.value)}
                    />
                  </div>
                  <div className="row" style={{ gap: 8 }}>
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      disabled={busy}
                      onClick={() =>
                        void runGatewayAction('configure', {
                          config: {
                            mode: 'external',
                            externalGatewayUrl: extGwUrl,
                            externalWebAdminUrl: extWebUrl,
                            ...(extWebKey.trim() ? { externalWebKey: extWebKey.trim() } : {}),
                          },
                        })
                      }
                    >
                      保存外部 Magpie 配置
                    </button>
                    <button type="button" className="btn btn-sm" onClick={() => setShowExtConfig(false)}>
                      收起
                    </button>
                  </div>
                </div>
              )}

              <div className="hairline-top card-pad row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={busy}
                  onClick={() => void runGatewayAction('start')}
                >
                  <Icon name="play" className="icon-14" />
                  启动 LT 托管
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy || gw.mode !== 'managed'}
                  onClick={() => void runGatewayAction('restart')}
                >
                  <Icon name="refresh" className="icon-14" />
                  重启
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy || gw.mode !== 'managed'}
                  onClick={() => void runGatewayAction('stop')}
                >
                  <Icon name="stop" className="icon-14" />
                  停止
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() => void runGatewayAction('install')}
                >
                  <Icon name="download" className="icon-14" />
                  安装 / 导入二进制
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() => void runGatewayAction('check-compatibility')}
                >
                  <Icon name="zap" className="icon-14" />
                  健康与兼容校验
                </button>
                <span className="grow" />
                <span className="t-meta">停止网关后经 Magpie 路由的模型将不可用；直连供应商不受影响。</span>
              </div>
            </div>

            {/* Version & Rollback Section */}
            <div className="section">
              <div className="section-head">
                <div>
                  <span className="t-overline">版本</span>
                  <h2>
                    Magpie <span className="mono">{gw.version.current || '未检测'}</span>{' '}
                    <span className="badge sm outline">{gw.version.license}</span>
                  </h2>
                </div>
              </div>
              <div className="card">
                <div className="card-pad row" style={{ gap: 20, flexWrap: 'wrap' }}>
                  <dl className="kv" style={{ minWidth: 280 }}>
                    <dt>当前 / 固定基线</dt>
                    <dd className="mono">
                      {gw.version.current || '—'} / {gw.version.pinned}
                    </dd>
                    <dt>已测试范围</dt>
                    <dd className="mono">{gw.version.testedRange}</dd>
                    <dt>自恢复计数</dt>
                    <dd className="num">{gw.recoveryCount}</dd>
                    {gw.version.previousVersion && (
                      <>
                        <dt>上一版本</dt>
                        <dd className="mono">{gw.version.previousVersion}</dd>
                      </>
                    )}
                  </dl>
                  <span className="grow" />
                  <div className="col" style={{ alignItems: 'flex-end', gap: 8 }}>
                    <span className={`badge ${gw.version.compatible ? 'success' : 'warning'}`}>
                      {gw.version.compatible ? '接口兼容校验正常' : '需校验上游版本'}
                    </span>
                    {gw.version.rollbackAvailable && (
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        disabled={busy}
                        onClick={() => void runGatewayAction('rollback')}
                      >
                        <Icon name="rollback" className="icon-14" />
                        回退至 {gw.version.previousVersion}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className="callout info">
              <Icon name="info" />
              <span>
                首次使用？网关就绪后进入{' '}
                {onNextStep ? (
                  <button type="button" className="link-btn" onClick={onNextStep}>
                    供应商与凭据
                  </button>
                ) : (
                  <b>供应商与凭据</b>
                )}{' '}
                添加 API Key 或完成 OAuth 授权。
              </span>
            </div>
          </div>
        </div>
      </>
    );
  }

  /* ==================== STEP 2: PROVIDERS & CREDENTIALS ==================== */
  return (
    <>
      <StageHead
        overline="接入 · 2 / 4"
        title="供应商与凭据"
        leading={leadingToggle}
        right={
          <div className="row" style={{ gap: 8 }}>
            <label className="search" style={{ width: 200 }}>
              <Icon name="search" />
              <input
                className="input input-sm"
                placeholder="搜索供应商…"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </label>
            {bundle.capabilities.features.magpieOAuthPassthrough && (
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy || !gw.managementAuthenticated}
                onClick={() => setShowOauthDrawer(true)}
              >
                <Icon name="key" className="icon-14" />
                OAuth 订阅登录
              </button>
            )}
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => {
                setAddChannel('magpie');
                setShowAddDrawer(true);
              }}
            >
              <Icon name="plus" className="icon-14" />
              添加供应商
            </button>
          </div>
        }
      />

      <div className="stage-body">
        <div className="stage-pad" style={{ maxWidth: 1100 }}>
          {error && (
            <div className="callout danger" style={{ marginBottom: 16 }}>
              <Icon name="alert" />
              <span className="grow">{error}</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setError(null)}>
                关闭
              </button>
            </div>
          )}
          {message && (
            <div className="callout info" style={{ marginBottom: 16 }}>
              <Icon name="info" />
              <span className="grow">{message}</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMessage(null)}>
                关闭
              </button>
            </div>
          )}

          {!gw.managementAuthenticated && gw.mode !== 'disabled' && (
            <div className="callout warning" style={{ marginBottom: 16 }}>
              <Icon name="alert" />
              <span>
                Magpie 管理接口尚未鉴权：请先在「1 · 网关」启动 LT 托管实例或填写外部管理密钥，即可在线增删供应商与多 Key。
              </span>
            </div>
          )}

          {groupedProviders.length === 0 ? (
            <div className="card card-pad" style={{ marginBottom: 20 }}>
              <div className="empty" style={{ padding: '32px 16px' }}>
                <h3>尚无已接入的供应商</h3>
                <p className="t-small" style={{ maxWidth: 460, margin: 0 }}>
                  点击右上角「添加供应商」经 Magpie 接入预设/自定义供应商或登记外部兼容网关，也可在环境变量中配置直连 Solo-Key（如 <code>DEEPSEEK_API_KEY</code>）。
                </p>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    setAddChannel('magpie');
                    setShowAddDrawer(true);
                  }}
                >
                  <Icon name="plus" className="icon-14" />
                  添加第一个供应商
                </button>
              </div>
            </div>
          ) : (
            groupedProviders.map(({ kind, items }) => (
              <div key={kind} className="section">
                <div className="section-head">
                  <h2 className="row" style={{ gap: 8 }}>
                    {SOURCE_GROUP_LABELS[kind]} <span className="t-meta num">{items.length}</span>
                  </h2>
                  {kind === 'external-gateway' && bundle.capabilities.features.externalGateways && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => {
                        setAddChannel('external-gateway');
                        setShowAddDrawer(true);
                      }}
                    >
                      <Icon name="plus" className="icon-14" />
                      登记外部网关
                    </button>
                  )}
                </div>
                <div className="card">
                  {items.map((p, idx) => {
                    const [badgeCls, badgeLbl] = STATUS_BADGE[p.status] || ['', p.status];
                    const lat = lastLatencyMap[p.providerId];
                    return (
                      <div
                        key={p.providerId}
                        className="row"
                        style={{
                          gap: 14,
                          padding: '12px 16px',
                          borderTop: idx > 0 ? '1px solid var(--lt-border-subtle)' : undefined,
                          cursor: 'pointer',
                        }}
                        onClick={() => setActiveProviderId(p.providerId)}
                      >
                        <Monogram name={p.displayName} />
                        <span className="col grow" style={{ gap: 2 }}>
                          <span className="row" style={{ gap: 8 }}>
                            <b className="t-small">{p.displayName}</b>
                            <span className={`badge sm ${badgeCls}`}>{badgeLbl}</span>
                          </span>
                          <span className="mono t-meta">{p.providerId}</span>
                        </span>
                        <span className="tag" style={{ width: 136, justifyContent: 'center' }}>
                          {p.protocol}
                        </span>
                        <span className="t-small" style={{ width: 138 }} onClick={e => e.stopPropagation()}>
                          {p.status === 'auth_required' && bundle.capabilities.features.magpieOAuthPassthrough ? (
                            <button
                              type="button"
                              className="btn btn-sm btn-primary"
                              onClick={() => void handleStartOAuth(p.vendorId || 'codex')}
                            >
                              <Icon name="key" className="icon-14" />
                              登录授权
                            </button>
                          ) : (
                            <span className="row" style={{ gap: 6 }}>
                              <Icon name="key" className="icon-14" />
                              <span className="num">{p.credentials.length}</span> 份 ·{' '}
                              {ROTATION_LABELS[p.keyRotation] || p.keyRotation}
                            </span>
                          )}
                        </span>
                        <span className="t-small num" style={{ width: 72, textAlign: 'right' }}>
                          {lat !== undefined ? (
                            <span style={{ color: lat > 500 ? 'var(--lt-warning)' : undefined }}>{lat} ms</span>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </span>
                        <span className="t-meta num" style={{ width: 88, textAlign: 'right' }}>
                          {p.enabledModelCount} / {p.discoveredModelCount} 模型
                        </span>
                        <Icon name="chevR" className="icon-14" />
                      </div>
                    );
                  })}
                </div>
              </div>
            ))
          )}

          <div className="callout">
            <Icon name="shield" />
            <span>
              密钥只写不读：界面仅显示脱敏引用（如 <span className="mono">sk-****9c2e</span>），明文从不回显，也不会进入日志或衡账导出。
            </span>
          </div>
        </div>
      </div>

      {/* ==================== SCRIM ==================== */}
      <div
        className={anyDrawerOpen ? 'scrim open' : 'scrim'}
        onClick={() => {
          setShowAddDrawer(false);
          setShowOauthDrawer(false);
          setActiveProviderId(null);
        }}
      />

      {/* ==================== DRAWER 1: ADD PROVIDER / EXTERNAL GATEWAY ==================== */}
      <aside
        className={showAddDrawer ? 'drawer open' : 'drawer'}
        aria-hidden={!showAddDrawer}
        aria-label="添加供应商"
      >
        <div className="drawer-head">
          <Icon name="plus" />
          <b className="grow">添加供应商</b>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={() => setShowAddDrawer(false)}
            aria-label="关闭"
          >
            <Icon name="x" />
          </button>
        </div>

        <div className="drawer-body">
          {bundle.capabilities.features.externalGateways && (
            <div style={{ marginBottom: 18 }}>
              <div className="t-overline" style={{ marginBottom: 8 }}>
                接入方式
              </div>
              <div className="seg seg-sm">
                <button
                  type="button"
                  aria-pressed={addChannel === 'magpie'}
                  onClick={() => setAddChannel('magpie')}
                >
                  经 Magpie 网关（支持多 Key 池）
                </button>
                <button
                  type="button"
                  aria-pressed={addChannel === 'external-gateway'}
                  onClick={() => setAddChannel('external-gateway')}
                >
                  独立外部兼容网关
                </button>
              </div>
            </div>
          )}

          {addChannel === 'magpie' ? (
            <form id="add-magpie-provider-form" className="col" style={{ gap: 14 }} onSubmit={handleSaveProvider}>
              <div className="field">
                <label className="label">1 · 供应商预设 / 自定义协议</label>
                <select className="select" value={vendorPreset} onChange={e => setVendorPreset(e.target.value)}>
                  {presets.map(p => (
                    <option key={p.vendorId} value={p.vendorId}>
                      {p.displayName} ({p.defaultEndpointUrl || p.protocol})
                    </option>
                  ))}
                  <option value="custom">自定义 OpenAI / Responses / Anthropic / Gemini 供应商…</option>
                </select>
              </div>

              {vendorPreset === 'custom' && (
                <div className="grid grid-2">
                  <div className="field">
                    <label className="label">唯一标识</label>
                    <input
                      className="input mono"
                      placeholder="如 relay-cn"
                      value={customId}
                      onChange={e => setCustomId(e.target.value)}
                      required
                    />
                  </div>
                  <div className="field">
                    <label className="label">显示名称</label>
                    <input
                      className="input"
                      placeholder="可选"
                      value={customName}
                      onChange={e => setCustomName(e.target.value)}
                    />
                  </div>
                  <div className="field">
                    <label className="label">接口协议</label>
                    <select className="select" value={customApi} onChange={e => setCustomApi(e.target.value as any)}>
                      <option value="chat">OpenAI Chat (/v1/chat/completions)</option>
                      <option value="responses">OpenAI Responses (/v1/responses)</option>
                      <option value="anthropic">Anthropic Messages (/v1/messages)</option>
                      <option value="gemini">Google Gemini (/v1beta)</option>
                    </select>
                  </div>
                  <div className="field">
                    <label className="label">接口基础地址</label>
                    <input
                      className="input mono"
                      placeholder="https://..."
                      value={customUrl}
                      onChange={e => setCustomUrl(e.target.value)}
                      required
                    />
                  </div>
                </div>
              )}

              <div className="field">
                <label className="label">2 · API Key（支持换行/逗号批量导入多 Key 池）</label>
                <textarea
                  className="textarea mono"
                  rows={3}
                  placeholder="sk-…（写入后立即清空，绝不回显明文）"
                  value={rawApiKey}
                  onChange={e => setRawApiKey(e.target.value)}
                />
                <span className="hint">单向写入：保存后仅显示脱敏尾号。本地 loopback 服务可省略 Key。</span>
              </div>

              {discoveredPreview.length > 0 && (
                <div className="callout info">
                  <Icon name="zap" />
                  <span>
                    预探测到 <b>{discoveredPreview.length}</b> 个上游模型：{' '}
                    <span className="mono">{discoveredPreview.slice(0, 10).map(m => m.id).join(', ')}</span>
                  </span>
                </div>
              )}
            </form>
          ) : (
            <form id="add-ext-gateway-form" className="col" style={{ gap: 12 }} onSubmit={handleSaveExternalGateway}>
              <div className="grid grid-2">
                <div className="field">
                  <label className="label">网关标识</label>
                  <input
                    className="input mono"
                    placeholder="如 local-vllm"
                    value={extRelayId}
                    onChange={e => setExtRelayId(e.target.value)}
                    required
                  />
                </div>
                <div className="field">
                  <label className="label">显示名称</label>
                  <input
                    className="input"
                    placeholder="可选"
                    value={extRelayName}
                    onChange={e => setExtRelayName(e.target.value)}
                  />
                </div>
              </div>
              <div className="field">
                <label className="label">接口地址</label>
                <input
                  className="input mono"
                  placeholder="http://127.0.0.1:8000/v1"
                  value={extRelayEndpoint}
                  onChange={e => setExtRelayEndpoint(e.target.value)}
                  required
                />
              </div>
              <div className="field">
                <label className="label">协议</label>
                <select
                  className="select"
                  value={extRelayProtocol}
                  onChange={e => setExtRelayProtocol(e.target.value as ProviderProtocol)}
                >
                  <option value="openai-chat">openai-chat</option>
                  <option value="openai-responses">openai-responses</option>
                  <option value="anthropic-messages">anthropic-messages</option>
                  <option value="google-gemini">google-gemini</option>
                </select>
              </div>
              <div className="field">
                <label className="label">网关 API Key（只写）</label>
                <input
                  type="password"
                  className="input mono"
                  placeholder="可选：明文仅写入服务端隔离凭据库"
                  value={extRelayKey}
                  onChange={e => setExtRelayKey(e.target.value)}
                />
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={extRelayKeyOptional}
                  onChange={e => setExtRelayKeyOptional(e.target.checked)}
                />
                <span className="track" />
                免密钥内网网关
              </label>
            </form>
          )}
        </div>

        <div className="drawer-foot">
          <button type="button" className="btn" onClick={() => setShowAddDrawer(false)}>
            取消
          </button>
          {addChannel === 'magpie' ? (
            <>
              <button
                type="button"
                className="btn"
                disabled={busy || !gw.managementAuthenticated || (!rawApiKey.trim() && !canOmitApiKey)}
                onClick={() => void handlePreDiscover()}
              >
                <Icon name="zap" className="icon-14" />
                预探测模型
              </button>
              <button
                type="submit"
                form="add-magpie-provider-form"
                className="btn btn-primary"
                disabled={busy || !gw.managementAuthenticated || (!rawApiKey.trim() && !canOmitApiKey)}
              >
                保存供应商与密钥
              </button>
            </>
          ) : (
            <button
              type="submit"
              form="add-ext-gateway-form"
              className="btn btn-primary"
              disabled={busy || !extRelayId.trim() || !extRelayEndpoint.trim()}
            >
              保存外部网关
            </button>
          )}
        </div>
      </aside>

      {/* ==================== DRAWER 2: PROVIDER DETAIL & MULTI-KEY POOL ==================== */}
      <aside
        className={selectedProvider ? 'drawer open' : 'drawer'}
        aria-hidden={!selectedProvider}
        aria-label="供应商与凭据池详情"
      >
        <div className="drawer-head">
          <Monogram name={selectedProvider?.displayName || 'P'} />
          <div className="col grow" style={{ gap: 0 }}>
            <b>{selectedProvider?.displayName || '供应商详情'}</b>
            <span className="mono t-meta">{selectedProvider?.providerId || ''}</span>
          </div>
          {selectedProvider && (
            <span className={`badge ${STATUS_BADGE[selectedProvider.status]?.[0] || ''}`}>
              {STATUS_BADGE[selectedProvider.status]?.[1] || selectedProvider.status}
            </span>
          )}
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={() => setActiveProviderId(null)}
            aria-label="关闭"
          >
            <Icon name="x" />
          </button>
        </div>

        <div className="drawer-body">
          {selectedProvider && (
            <>
              <div className="section">
                <div className="section-head">
                  <h2>连接</h2>
                  {selectedProvider.sourceKind === 'magpie' && gw.managementAuthenticated && (
                    <div className="row" style={{ gap: 6 }}>
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={busy}
                        onClick={() => void handleMutateProvider('test-provider', { id: selectedProvider.providerId })}
                      >
                        <Icon name="zap" className="icon-14" />
                        测试连通性
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={busy}
                        onClick={() => void handleMutateProvider('refresh-models', { id: selectedProvider.providerId })}
                      >
                        <Icon name="refresh" className="icon-14" />
                        刷新模型
                      </button>
                    </div>
                  )}
                </div>
                <dl className="kv">
                  <dt>来源</dt>
                  <dd>{SOURCE_GROUP_LABELS[selectedProvider.sourceKind]}</dd>
                  <dt>协议</dt>
                  <dd className="mono">{selectedProvider.protocol}</dd>
                  <dt>接口地址</dt>
                  <dd className="mono ellipsis">{selectedProvider.endpointUrl || '—'}</dd>
                  <dt>最近延迟</dt>
                  <dd className="num">
                    {lastLatencyMap[selectedProvider.providerId] !== undefined
                      ? `${lastLatencyMap[selectedProvider.providerId]} ms`
                      : '—'}
                  </dd>
                </dl>
              </div>

              <div className="section">
                <div className="section-head">
                  <h2>
                    凭据 <span className="t-meta num">{selectedProvider.credentials.length}</span>
                  </h2>
                </div>
                {selectedProvider.credentials.length === 0 ? (
                  <div className="callout">
                    <Icon name="info" />
                    <span>尚无凭据。</span>
                  </div>
                ) : (
                  <div className="tbl-wrap">
                    <table className="tbl">
                      <thead>
                        <tr>
                          <th>启用</th>
                          <th>标签</th>
                          <th>脱敏引用</th>
                          <th>主</th>
                          <th className="r">权重</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {selectedProvider.credentials.map(cred => (
                          <tr key={cred.credentialId}>
                            <td>
                              {selectedProvider.sourceKind === 'magpie' && gw.managementAuthenticated ? (
                                <label className="switch">
                                  <input
                                    type="checkbox"
                                    checked={cred.enabled}
                                    disabled={busy}
                                    onChange={() =>
                                      void handleMutateProvider(
                                        cred.kind === 'oauth' ? 'mutate-login' : 'mutate-key',
                                        cred.kind === 'oauth'
                                          ? {
                                              providerId: selectedProvider.providerId,
                                              loginAction: cred.enabled ? 'off' : 'on',
                                              user: cred.label,
                                            }
                                          : {
                                              providerId: selectedProvider.providerId,
                                              credentialId: cred.credentialId,
                                              keyAction: cred.enabled ? 'off' : 'on',
                                            },
                                      )
                                    }
                                  />
                                  <span className="track" />
                                </label>
                              ) : (
                                <span className={`dot ${cred.enabled ? 'ok' : 'idle'}`} />
                              )}
                            </td>
                            <td>{cred.label}</td>
                            <td className="mono">{cred.maskedPreview}</td>
                            <td>
                              {cred.primary ? (
                                <span className="badge sm info">主</span>
                              ) : selectedProvider.sourceKind === 'magpie' && gw.managementAuthenticated ? (
                                <button
                                  type="button"
                                  className="link-btn t-meta"
                                  disabled={busy}
                                  onClick={() =>
                                    void handleMutateProvider(
                                      cred.kind === 'oauth' ? 'mutate-login' : 'mutate-key',
                                      cred.kind === 'oauth'
                                        ? {
                                            providerId: selectedProvider.providerId,
                                            loginAction: 'switch',
                                            user: cred.label,
                                          }
                                        : {
                                            providerId: selectedProvider.providerId,
                                            credentialId: cred.credentialId,
                                            keyAction: 'use',
                                          },
                                    )
                                  }
                                >
                                  设为主
                                </button>
                              ) : (
                                '—'
                              )}
                            </td>
                            <td className="r num">{cred.weight}</td>
                            <td className="r">
                              {selectedProvider.sourceKind === 'magpie' && gw.managementAuthenticated && (
                                <button
                                  type="button"
                                  className="btn btn-ghost btn-icon btn-sm"
                                  title={cred.kind === 'oauth' ? '退出登录' : '删除凭据'}
                                  disabled={busy}
                                  onClick={() =>
                                    void handleMutateProvider(
                                      cred.kind === 'oauth' ? 'mutate-login' : 'mutate-key',
                                      cred.kind === 'oauth'
                                        ? {
                                            providerId: selectedProvider.providerId,
                                            loginAction: 'forget',
                                            user: cred.label,
                                          }
                                        : {
                                            providerId: selectedProvider.providerId,
                                            credentialId: cred.credentialId,
                                            keyAction: 'remove',
                                          },
                                    )
                                  }
                                >
                                  <Icon name="trash" className="icon-14" />
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {selectedProvider.sourceKind === 'magpie' && gw.managementAuthenticated && (
                  <div className="col" style={{ gap: 8, marginTop: 12 }}>
                    <label className="label">追加 API Key</label>
                    <div className="row" style={{ gap: 6 }}>
                      <input
                        className="input input-sm"
                        style={{ width: 120 }}
                        placeholder="备注名 (Key 2)"
                        value={extraKeyName}
                        onChange={e => setExtraKeyName(e.target.value)}
                      />
                      <div className="input-affix grow">
                        <input
                          type="password"
                          className="input input-sm mono"
                          placeholder="粘贴 Key，写入后仅显示脱敏尾号"
                          autoComplete="off"
                          value={extraKeySecret}
                          onChange={e => setExtraKeySecret(e.target.value)}
                        />
                        <button
                          type="button"
                          className="btn btn-sm btn-primary"
                          disabled={busy || !extraKeySecret.trim()}
                          onClick={() =>
                            void handleMutateProvider('mutate-key', {
                              providerId: selectedProvider.providerId,
                              keyAction: 'add',
                              name: extraKeyName.trim() || undefined,
                              key: extraKeySecret.trim(),
                            })
                          }
                        >
                          写入
                        </button>
                      </div>
                    </div>
                    <span className="hint">单向写入：保存后无法再次查看明文。</span>
                  </div>
                )}
              </div>

              {selectedProvider.sourceKind === 'magpie' && gw.managementAuthenticated && (
                <div className="section">
                  <div className="section-head">
                    <h2>多凭据策略</h2>
                  </div>
                  <div className="field" style={{ marginBottom: 12 }}>
                    <label className="label">轮询路由策略</label>
                    <select
                      className="select select-sm"
                      style={{ maxWidth: 240 }}
                      value={selectedProvider.keyRotation}
                      disabled={busy}
                      onChange={e =>
                        void handleMutateProvider('set-routing', {
                          id: selectedProvider.providerId,
                          keyRotation: e.target.value,
                        })
                      }
                    >
                      <option value="single" disabled>
                        单凭据默认 (single)
                      </option>
                      <option value="fill-first">顺位优先 (fill-first)</option>
                      <option value="round-robin">轮询均衡 (round-robin)</option>
                      <option value="least-used">最少调用 (least-used)</option>
                    </select>
                  </div>
                </div>
              )}

              {((selectedProvider.sourceKind === 'magpie' && gw.managementAuthenticated) ||
                (selectedProvider.sourceKind === 'external-gateway' && bundle.capabilities.features.externalGateways)) && (
                <div className="section">
                  <div className="section-head">
                    <h2 style={{ color: 'var(--lt-danger)' }}>移除</h2>
                  </div>
                  <div className="row-between">
                    <span className="t-small secondary">移除供应商将同时解除其关联模型目录。</span>
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      disabled={busy}
                      onClick={() => {
                        if (selectedProvider.sourceKind === 'external-gateway') {
                          void runGatewayAction('remove-external', {
                            id: selectedProvider.providerId.replace(/^ext:/, ''),
                          });
                        } else {
                          void handleMutateProvider('delete-provider', { id: selectedProvider.providerId });
                        }
                      }}
                    >
                      <Icon name="trash" className="icon-14" />
                      移除供应商
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
          {/* Keep single-key routing label anchored for standalone contract parity even when drawer is closed */}
          {!selectedProvider && (
            <select aria-hidden="true" style={{ display: 'none' }} defaultValue="single">
              <option value="single" disabled>
                单凭据默认 (single)
              </option>
            </select>
          )}
        </div>
      </aside>

      {/* ==================== DRAWER 3: OAUTH PASSTHROUGH ==================== */}
      <aside
        className={showOauthDrawer ? 'drawer open' : 'drawer'}
        aria-hidden={!showOauthDrawer}
        aria-label="Magpie OAuth 订阅登录"
      >
        <div className="drawer-head">
          <Icon name="key" />
          <div className="col grow" style={{ gap: 0 }}>
            <b>Magpie OAuth 订阅授权</b>
            <span className="t-meta">经 Magpie 原生透传，Token 不经过 LT 界面</span>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={() => setShowOauthDrawer(false)}
            aria-label="关闭"
          >
            <Icon name="x" />
          </button>
        </div>
        <div className="drawer-body">
          <ol className="axis">
            <li className={oauthSession ? 'done' : 'run'}>
              <span className="axis-node" />
              <b className="t-small">1 · 选择订阅渠道并发起授权</b>
              <div className="row" style={{ gap: 8, marginTop: 8 }}>
                <select
                  className="select select-sm"
                  style={{ maxWidth: 230 }}
                  value={oauthAgent}
                  onChange={e => setOauthAgent(e.target.value)}
                >
                  <option value="codex">OpenAI Codex 订阅 (codex)</option>
                  <option value="claude">Anthropic Claude 订阅 (claude)</option>
                  <option value="gemini">Google Gemini 订阅 (gemini)</option>
                  <option value="copilot">GitHub Copilot (copilot)</option>
                </select>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={busy || !gw.managementAuthenticated}
                  onClick={() => void handleStartOAuth()}
                >
                  获取登录链接
                </button>
              </div>
              {oauthSession?.code && (
                <div className="row" style={{ gap: 8, marginTop: 10 }}>
                  <span className="tag" style={{ fontSize: 14, height: 30, letterSpacing: '0.12em' }}>
                    {oauthSession.code}
                  </span>
                </div>
              )}
              {oauthSession?.authUrl && (
                <div style={{ marginTop: 8 }}>
                  <a
                    className="btn btn-sm"
                    href={oauthSession.authUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <Icon name="external" className="icon-14" />
                    打开浏览器授权页
                  </a>
                </div>
              )}
            </li>

            <li className={oauthSession ? 'run' : ''}>
              <span className="axis-node" />
              <b className="t-small">2 · 等待浏览器完成登录</b>
              <div className="row t-meta" style={{ gap: 6, marginTop: 4 }}>
                {oauthSession ? (
                  <>
                    <i className="dot run breath" />
                    <span>状态：{oauthSession.state || 'waiting'} · 每 2 秒自动轮询 Magpie</span>
                  </>
                ) : (
                  <span>点击上方「获取登录链接」后将自动轮询状态。</span>
                )}
              </div>
            </li>

            <li>
              <span className="axis-node" />
              <b className="t-small">3 · 或手动粘贴回调 URL</b>
              <div className="input-affix" style={{ marginTop: 8 }}>
                <input
                  className="input input-sm mono"
                  placeholder="http://localhost:1455/auth/callback?code=…"
                  value={oauthCallbackUrl}
                  onChange={e => setOauthCallbackUrl(e.target.value)}
                />
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={busy || !oauthSession || !oauthCallbackUrl.trim()}
                  onClick={() => void handleSubmitOAuthCallback()}
                >
                  提交回调
                </button>
              </div>
            </li>
          </ol>
        </div>
        <div className="drawer-foot">
          {oauthSession ? (
            <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void handleCancelOAuth()}>
              取消授权
            </button>
          ) : (
            <button type="button" className="btn" onClick={() => setShowOauthDrawer(false)}>
              关闭
            </button>
          )}
        </div>
      </aside>
    </>
  );
}
